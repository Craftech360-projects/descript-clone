import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { writeFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { randomUUID } from 'node:crypto';

import { ASR_MODELS, CONFIG, EDIT_DEFAULTS } from './config.ts';
import { probe, extractAudioForAsr, renderEdl, computePeaks, checkTools } from './ffmpeg.ts';
import { transcribe, ASR_DEFAULTS, type AsrOptions } from './asr.ts';
import { generate as generateThumbs } from './thumbs.ts';
import * as store from './store.ts';
import * as jobs from './jobs.ts';
import * as fonts from './fonts.ts';

import {
  normalizeCaptions,
  type CaptionSettings,
} from '../../../packages/core/src/caption-style.ts';
import { compileEdl, compileSequenceEdl, outputDuration } from '../../../packages/core/src/edl.ts';
import { detectFillers, removeFillers } from '../../../packages/core/src/fillers.ts';
import { removeRetakes } from '../../../packages/core/src/retakes.ts';
import { scaleCues, toCues, toSrt, toVtt, toAss } from '../../../packages/core/src/captions.ts';
import { clampSpeed, type CutSettings } from '../../../packages/core/src/doc.ts';
import type { CompileOptions, Edl, Transcript, Word } from '../../../packages/core/src/types.ts';

await store.init();
await jobs.init();
await fonts.init();

const app = new Hono();

/**
 * CORS_ORIGIN pins the browser origin allowed to call this API. Unset keeps the
 * wildcard, which is right for local dev and wrong the moment this is public:
 * every route here is unauthenticated, so `*` lets any page on the internet
 * drive a stranger's projects and spend their ASR credit.
 */
app.use('/*', cors(process.env.CORS_ORIGIN ? { origin: process.env.CORS_ORIGIN } : undefined));

/**
 * Serve uploads and renders out of the media directory itself, rather than
 * assuming it sits at ./media under the cwd. Once MEDIA_DIR points at a mounted
 * volume the two are different places, and the old form served a directory
 * nothing was ever written to.
 */
app.use(
  '/media/*',
  serveStatic({
    root: CONFIG.mediaDir,
    rewriteRequestPath: (path) => path.replace(/^\/media/, ''),
  }),
);

/**
 * Liveness + dependency check. Reports 503 when ffmpeg is missing, so an
 * orchestrator refuses to route to a container that cannot do the job.
 */
app.get('/api/health', async (c) => {
  const tools = await checkTools();
  const ok = Boolean(tools.ffmpeg && tools.ffprobe);
  return c.json(
    { ok, ffmpeg: tools.ffmpeg, ffprobe: tools.ffprobe, asr: CONFIG.hasAsr() },
    ok ? 200 : 503,
  );
});

/** What the workspace can offer: model choices, tool availability, key status. */
app.get('/api/capabilities', (c) =>
  c.json({
    hasAsr: CONFIG.hasAsr(),
    asrModels: ASR_MODELS,
    asrDefaults: ASR_DEFAULTS,
    editDefaults: { ...EDIT_DEFAULTS, maxGapMs: 0 },
  }),
);

app.get('/api/projects', async (c) => c.json(await store.list()));

/**
 * Imported caption fonts. Global, not per-project: added once, offered
 * everywhere. See fonts.ts. The files themselves are served by the /media/*
 * static handler, both to the browser's @font-face and to libass at render.
 */
const MAX_FONT_BYTES = 10 * 1024 * 1024; // a heavy CJK OTF is ~a few MB; 10 is slack

app.get('/api/fonts', async (c) => c.json(await fonts.list()));

app.post('/api/fonts', async (c) => {
  const body = await c.req.parseBody();
  const file = body['file'];
  if (!(file instanceof File)) {
    return c.json({ error: 'Attach a font file as the "file" field.' }, 400);
  }

  const ext = extname(file.name).toLowerCase();
  if (!fonts.ACCEPTED_FONT_EXTENSIONS.includes(ext)) {
    return c.json(
      { error: `Unsupported font type "${ext || 'unknown'}". Use TTF, OTF, WOFF, or WOFF2.` },
      400,
    );
  }
  if (file.size > MAX_FONT_BYTES) {
    return c.json({ error: `Font is too large. The limit is ${MAX_FONT_BYTES / 1024 / 1024} MB.` }, 413);
  }

  try {
    // Parsing the name table can throw on a corrupt file; that is a 400, not a 500.
    const font = await fonts.add(Buffer.from(await file.arrayBuffer()));
    return c.json(font);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'Could not read this font file.' }, 400);
  }
});

app.delete('/api/fonts/:id', async (c) => {
  const removed = await fonts.remove(c.req.param('id'));
  return removed ? c.json({ ok: true }) : c.json({ error: 'No such font.' }, 404);
});

/**
 * IMPORT ONLY. This does not transcribe.
 *
 * An editor should not decide for you. Import lands the media in the project and
 * computes what is free (probe, waveform); transcription costs money and has
 * options, so it waits until you configure it and ask.
 */
app.post('/api/projects', async (c) => {
  // Checked BEFORE parseBody, which buffers the whole upload into memory. Once
  // that has run the allocation already happened and refusing is too late.
  const declared = Number(c.req.header('content-length') ?? 0);
  if (declared > CONFIG.maxUploadBytes) {
    return c.json(
      { error: `File is too large. The limit is ${mb(CONFIG.maxUploadBytes)} MB.` },
      413,
    );
  }

  const body = await c.req.parseBody();
  const file = body['file'];

  if (!(file instanceof File)) {
    return c.json({ error: 'Attach a media file as the "file" field.' }, 400);
  }

  if (file.size > CONFIG.maxUploadBytes) {
    return c.json(
      { error: `File is too large. The limit is ${mb(CONFIG.maxUploadBytes)} MB.` },
      413,
    );
  }

  const id = randomUUID();
  const ext = extname(file.name) || '.mp4';
  const sourcePath = join(CONFIG.mediaDir, 'uploads', `${id}${ext}`);
  await writeFile(sourcePath, Buffer.from(await file.arrayBuffer()));

  const info = await probe(sourcePath);

  const project: store.Project = {
    id,
    name: file.name,
    sourcePath,
    sourceUrl: `/media/uploads/${id}${ext}`,
    duration: info.duration,
    hasVideo: info.hasVideo,
    width: info.width,
    height: info.height,
    fps: info.fps,
    status: 'imported',
    transcript: null,
    asrProvider: null,
    verbatim: false,
    peaks: await computePeaks(sourcePath),
    createdAt: new Date().toISOString(),
  };

  await store.save(project);
  return c.json(project);
});

app.get('/api/projects/:id', async (c) => {
  const project = await store.get(c.req.param('id'));
  return project ? c.json(project) : c.json({ error: 'No such project' }, 404);
});

/**
 * Transcribe, with the options the user chose. Re-runnable with different ones.
 *
 * Returns 202 with a job id rather than the finished project: on the 885s sample
 * this is minutes of work, and holding the connection open meant the UI could
 * only show a frozen string and a reload orphaned the run.
 */
app.post('/api/projects/:id/transcribe', async (c) => {
  const project = await store.get(c.req.param('id'));
  if (!project) return c.json({ error: 'No such project' }, 404);

  const options: AsrOptions = { ...ASR_DEFAULTS, ...(await c.req.json().catch(() => ({}))) };
  const force = Boolean((options as Record<string, unknown>).force);

  const job = jobs.start(project.id, 'transcribe', 'Extracting audio', (runner) =>
    transcribeProject(project, options, runner, { force }),
  );

  return c.json({ jobId: job.id }, 202);
});

/**
 * Transcribe every clip that still needs it, and stitch the words into one
 * script in play order.
 *
 * Incremental by default: a clip whose words are already in the transcript is
 * left alone, so appending a fifth clip transcribes only the fifth — not the
 * four already paid for. `force` re-transcribes everything (the Re-transcribe
 * button, e.g. to switch to a verbatim model). A single-source project has no
 * `clips` array, so its one word set carries no clipId; those words are matched
 * to the implicit clip and, on a fresh transcribe, left clipId-free so the
 * single-clip record stays byte-identical to before clips existed.
 */
async function transcribeProject(
  project: store.Project,
  options: AsrOptions,
  runner: jobs.Runner,
  { force }: { force: boolean },
): Promise<{ projectId: string }> {
  const multi = Boolean(project.clips);
  const clips = store.clipsOf(project);

  // Words already transcribed, keyed by the clip they belong to. An old word
  // with no clipId belongs to the first (only) clip.
  const reuse = new Map<string, Word[]>();
  if (project.transcript && !force) {
    for (const w of project.transcript.words) {
      const key = w.clipId ?? clips[0].id;
      const arr = reuse.get(key);
      if (arr) arr.push(w);
      else reuse.set(key, [w]);
    }
  }

  const words: Word[] = [];
  let provider = project.asrProvider;
  let verbatim = project.verbatim;

  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    const have = reuse.get(clip.id);
    if (have && have.length) {
      words.push(...have);
      continue;
    }

    const wavPath = join(CONFIG.mediaDir, 'uploads', `${clip.id}.asr.wav`);
    runner.onProgress({
      progress: -1,
      stage: clips.length > 1 ? `Transcribing clip ${i + 1} of ${clips.length}` : 'Extracting audio',
    });
    await extractAudioForAsr(clip.sourcePath, wavPath);
    if (runner.isCanceled()) throw new Error('Canceled');

    const result = await transcribe(wavPath, clip.duration, options, (p) => runner.onProgress(p));
    if (runner.isCanceled()) throw new Error('Canceled');

    // Only a multi-clip project stamps clipId — a lone clip keeps the old shape.
    if (multi) for (const w of result.words) w.clipId = clip.id;
    words.push(...result.words);
    provider = result.provider;
    verbatim = result.verbatim;
  }

  runner.onProgress({ progress: -1, stage: 'Saving' });
  project.transcript = { mediaId: project.id, duration: project.duration, words };
  project.asrProvider = provider;
  project.verbatim = verbatim;
  project.asrOptions = options;
  project.status = 'transcribed';

  // Flag fillers, do not cut them. The user decides.
  detectFillers(project.transcript);

  await store.save(project);
  // The client re-fetches the project; a 485KB payload does not belong in a
  // record that gets polled twice a second.
  return { projectId: project.id };
}

/**
 * Append a source clip to a project, and (if the project is already transcribed)
 * transcribe just the new clip.
 *
 * The mirror of import, but onto an existing project rather than a new one. The
 * first append materialises the original single source as clip 0 (see
 * store.ensureClips) so the sequence is explicit from then on. `duration`,
 * `peaks`, and `hasVideo` are re-derived across all clips.
 */
app.post('/api/projects/:id/clips', async (c) => {
  const project = await store.get(c.req.param('id'));
  if (!project) return c.json({ error: 'No such project' }, 404);

  const declared = Number(c.req.header('content-length') ?? 0);
  if (declared > CONFIG.maxUploadBytes) {
    return c.json({ error: `File is too large. The limit is ${mb(CONFIG.maxUploadBytes)} MB.` }, 413);
  }

  const body = await c.req.parseBody();
  const file = body['file'];
  if (!(file instanceof File)) return c.json({ error: 'Attach a media file as the "file" field.' }, 400);
  if (file.size > CONFIG.maxUploadBytes) {
    return c.json({ error: `File is too large. The limit is ${mb(CONFIG.maxUploadBytes)} MB.` }, 413);
  }

  const clipId = randomUUID();
  const ext = extname(file.name) || '.mp4';
  const sourcePath = join(CONFIG.mediaDir, 'uploads', `${clipId}${ext}`);
  await writeFile(sourcePath, Buffer.from(await file.arrayBuffer()));

  const info = await probe(sourcePath);
  const clip: store.StoredClip = {
    id: clipId,
    sourcePath,
    sourceUrl: `/media/uploads/${clipId}${ext}`,
    duration: info.duration,
    hasVideo: info.hasVideo,
    width: info.width,
    height: info.height,
    fps: info.fps,
    peaks: await computePeaks(sourcePath),
  };

  const clips = store.ensureClips(project);
  clips.push(clip);
  store.recomputeAggregates(project);
  await store.save(project);

  // A transcribed project keeps its transcript complete: transcribe the newcomer
  // now (incrementally — only this clip lacks words) so the script covers it.
  if (project.status === 'transcribed') {
    const options: AsrOptions = project.asrOptions ?? ASR_DEFAULTS;
    const job = jobs.start(project.id, 'transcribe', 'Transcribing new clip', (runner) =>
      transcribeProject(project, options, runner, { force: false }),
    );
    return c.json({ project, jobId: job.id }, 202);
  }

  return c.json({ project });
});

/**
 * Remove a clip from a project. Its words leave the script with it; the media
 * file is left on disk (renders and undo may still reference it). Refuses to
 * remove the last clip — a project with no source is not a project.
 */
app.delete('/api/projects/:id/clips/:clipId', async (c) => {
  const project = await store.get(c.req.param('id'));
  if (!project) return c.json({ error: 'No such project' }, 404);

  const clips = store.ensureClips(project);
  if (clips.length <= 1) return c.json({ error: 'A project needs at least one clip.' }, 400);

  const clipId = c.req.param('clipId');
  const next = clips.filter((cl) => cl.id !== clipId);
  if (next.length === clips.length) return c.json({ error: 'No such clip' }, 404);

  project.clips = next;
  if (project.transcript) {
    project.transcript.words = project.transcript.words.filter((w) => w.clipId !== clipId);
  }
  store.recomputeAggregates(project);
  await store.save(project);
  return c.json({ project });
});

/**
 * Reorder a project's clips. The body is the full list of clip ids in the new
 * order; the transcript's words are regrouped to match, so play order and script
 * order stay identical. Rejected unless the ids are exactly the current set.
 */
app.patch('/api/projects/:id/clips/order', async (c) => {
  const project = await store.get(c.req.param('id'));
  if (!project) return c.json({ error: 'No such project' }, 404);

  const { order } = await c.req.json<{ order: string[] }>().catch(() => ({ order: [] as string[] }));
  const clips = store.ensureClips(project);
  const byId = new Map(clips.map((cl) => [cl.id, cl]));

  // The new order must be a permutation of exactly the clips we have — no drops,
  // no strangers — or a stale client could silently lose a clip.
  const sameSet = order.length === clips.length && order.every((id) => byId.has(id));
  if (!sameSet) return c.json({ error: 'Order must list every clip exactly once.' }, 400);

  project.clips = order.map((id) => byId.get(id)!);
  if (project.transcript) {
    const firstId = clips[0].id;
    const words = project.transcript.words;
    project.transcript.words = order.flatMap((id) =>
      words.filter((w) => (w.clipId ?? firstId) === id),
    );
  }
  store.recomputeAggregates(project);
  await store.save(project);
  return c.json({ project });
});

/**
 * Split one clip into two at `at` seconds from the clip's own start.
 *
 * Non-destructive and instant: no file is written. The two halves share the one
 * source file — the first keeps its in-point and takes a shortened duration, the
 * second gets an in-point at the cut (see StoredClip.sourceStart). The clip's
 * words are partitioned by the cut and the second half's are rebased to its new
 * zero; a word straddling the cut is clamped to the seam so nothing plays twice.
 * Peaks are split proportionally so the waveform is unchanged. The first half
 * keeps the original clip id (its words keep their clipId); the second gets a new
 * one. This is "cut the clip and treat the pieces as separate clips".
 */
app.post('/api/projects/:id/clips/:clipId/split', async (c) => {
  const project = await store.get(c.req.param('id'));
  if (!project) return c.json({ error: 'No such project' }, 404);

  const { at } = await c.req.json<{ at: number }>().catch(() => ({ at: NaN }));
  const clips = store.ensureClips(project);
  const idx = clips.findIndex((cl) => cl.id === c.req.param('clipId'));
  if (idx < 0) return c.json({ error: 'No such clip' }, 404);

  const orig = clips[idx];
  // Refuse a cut that would leave a sliver on either side — there is nothing to
  // edit in 0.2s, and a zero-length clip breaks the render's select expression.
  const MIN = 0.2;
  const cut = Math.round(at * 1000) / 1000;
  if (!Number.isFinite(cut) || cut <= MIN || cut >= orig.duration - MIN) {
    return c.json({ error: 'Split point must be inside the clip.' }, 400);
  }

  const s0 = orig.sourceStart ?? 0;
  const pIdx = Math.round((orig.peaks.length * cut) / orig.duration);
  const firstId = clips[0].id;
  const newId = randomUUID();

  const a: store.StoredClip = { ...orig, duration: cut, sourceStart: s0, peaks: orig.peaks.slice(0, pIdx) };
  const b: store.StoredClip = {
    ...orig,
    id: newId,
    duration: orig.duration - cut,
    sourceStart: s0 + cut,
    peaks: orig.peaks.slice(pIdx),
  };
  clips.splice(idx, 1, a, b);

  if (project.transcript) {
    project.transcript.words = project.transcript.words.flatMap((w) => {
      if ((w.clipId ?? firstId) !== orig.id) return [w];
      // Local word times are relative to the clip's own start; `cut` is in that
      // same clock. Before the cut stays on the first half (clamped so a word
      // spanning the seam does not overrun it); at/after moves to the second and
      // rebases to its new zero.
      if (w.start < cut) return [{ ...w, clipId: orig.id, end: Math.min(w.end, cut) }];
      return [{ ...w, clipId: newId, start: w.start - cut, end: w.end - cut }];
    });
  }

  store.recomputeAggregates(project);
  await store.save(project);
  return c.json({ project });
});

/**
 * Background music, per project.
 *
 * Import lands an audio file, probes it (which also validates it has sound), and
 * attaches it with a quiet default volume so it sits under the voice. PATCH tunes
 * volume and length; DELETE detaches it. The file is left on disk on delete, the
 * same as a removed clip — a past render may still point at it.
 */
const MUSIC_DEFAULT_VOLUME = 0.35;

app.post('/api/projects/:id/music', async (c) => {
  const project = await store.get(c.req.param('id'));
  if (!project) return c.json({ error: 'No such project' }, 404);

  const declared = Number(c.req.header('content-length') ?? 0);
  if (declared > CONFIG.maxUploadBytes) {
    return c.json({ error: `File is too large. The limit is ${mb(CONFIG.maxUploadBytes)} MB.` }, 413);
  }

  const body = await c.req.parseBody();
  const file = body['file'];
  if (!(file instanceof File)) return c.json({ error: 'Attach an audio file as the "file" field.' }, 400);
  if (file.size > CONFIG.maxUploadBytes) {
    return c.json({ error: `File is too large. The limit is ${mb(CONFIG.maxUploadBytes)} MB.` }, 413);
  }

  const musicId = randomUUID();
  const ext = extname(file.name) || '.mp3';
  const sourcePath = join(CONFIG.mediaDir, 'uploads', `${musicId}${ext}`);
  await writeFile(sourcePath, Buffer.from(await file.arrayBuffer()));

  // probe doubles as validation: it throws if the file carries no audio track,
  // which is exactly what disqualifies it as a music bed.
  let duration: number;
  try {
    duration = (await probe(sourcePath)).duration;
  } catch {
    return c.json({ error: 'That file has no audio track to use as music.' }, 400);
  }

  project.music = {
    id: musicId,
    name: file.name,
    sourcePath,
    sourceUrl: `/media/uploads/${musicId}${ext}`,
    sourceDuration: duration,
    volume: MUSIC_DEFAULT_VOLUME,
  };
  await store.save(project);
  return c.json(project);
});

app.patch('/api/projects/:id/music', async (c) => {
  const project = await store.get(c.req.param('id'));
  if (!project) return c.json({ error: 'No such project' }, 404);
  if (!project.music) return c.json({ error: 'This project has no music to adjust.' }, 400);

  const patch = await c.req
    .json<{ volume?: number; durationSec?: number | null; loop?: boolean }>()
    .catch(() => ({}));
  // loop first: it decides how a length is capped below.
  if (typeof patch.loop === 'boolean') project.music.loop = patch.loop;
  if (typeof patch.volume === 'number' && Number.isFinite(patch.volume)) {
    project.music.volume = Math.max(0, patch.volume);
  }
  // null clears the trim (play for the whole program). A number is capped at the
  // file's own length UNLESS looping — a looped bed may run as long as the video,
  // so only the render's program-length clamp bounds it there.
  if (patch.durationSec === null) {
    delete project.music.durationSec;
  } else if (typeof patch.durationSec === 'number' && Number.isFinite(patch.durationSec)) {
    const cap = project.music.loop ? Infinity : project.music.sourceDuration;
    project.music.durationSec = Math.min(Math.max(0, patch.durationSec), cap);
  }

  await store.save(project);
  return c.json(project);
});

app.delete('/api/projects/:id/music', async (c) => {
  const project = await store.get(c.req.param('id'));
  if (!project) return c.json({ error: 'No such project' }, 404);
  delete project.music;
  await store.save(project);
  return c.json(project);
});

/** The editor sends the whole edit state: what is cut, and how it plays out. */
app.patch('/api/projects/:id/transcript', async (c) => {
  const project = await store.get(c.req.param('id'));
  if (!project?.transcript) return c.json({ error: 'Not transcribed yet' }, 400);

  const { deletedIds, captions, speed, cut } = await c.req.json<{
    deletedIds: string[];
    captions?: CaptionSettings;
    speed?: number;
    cut?: Partial<CutSettings>;
  }>();
  const deleted = new Set(deletedIds);
  for (const word of project.transcript.words) word.deleted = deleted.has(word.id);
  if (captions) project.captions = captions;
  // Distinguish "not sent" from "sent as 1": an older client omits the field and
  // must not have its speed reset, but a user picking 1x must have it saved.
  if (speed !== undefined) project.speed = clampSpeed(speed);
  // Sanitised, not trusted: the record is stored in the wire shape (maxGapMs 0 =
  // keep every pause), and every field is coerced to a real number so a bad body
  // cannot poison the compiler on the next render.
  if (cut) project.cut = sanitizeCut(cut);

  await store.save(project);
  return c.json({ ok: true });
});

/** Edit actions, each taking the settings from its panel. */
app.post('/api/projects/:id/actions/:action', async (c) => {
  const project = await store.get(c.req.param('id'));
  if (!project?.transcript) return c.json({ error: 'Not transcribed yet' }, 400);

  const opts = await c.req.json<any>().catch(() => ({}));
  const t = project.transcript;
  let changed = 0;

  switch (c.req.param('action')) {
    case 'detect-fillers':
      changed = detectFillers(t, { includeDiscourseMarkers: opts.includeDiscourseMarkers });
      break;
    case 'remove-fillers':
      detectFillers(t, { includeDiscourseMarkers: opts.includeDiscourseMarkers });
      changed = removeFillers(t);
      break;
    case 'remove-retakes':
      changed = removeRetakes(t, {
        minWords: opts.minWords,
        maxInterruption: opts.maxInterruption,
      });
      break;
    case 'restore-all':
      for (const w of t.words) {
        if (w.deleted) changed++;
        w.deleted = false;
      }
      break;
    default:
      return c.json({ error: `Unknown action: ${c.req.param('action')}` }, 400);
  }

  await store.save(project);
  return c.json({ ok: true, changed, transcript: t });
});

/** Captions for the EDITED timeline, in the format you asked for. */
app.post('/api/projects/:id/captions', async (c) => {
  const project = await store.get(c.req.param('id'));
  if (!project?.transcript) return c.json({ error: 'Not transcribed yet' }, 400);

  const { format = 'srt', maxChars, maxDurationMs, captions: sent, speed: sentSpeed, ...cut } =
    await c.req.json<any>().catch(() => ({}));

  const captions: CaptionSettings = normalizeCaptions({
    ...normalizeCaptions(project.captions),
    ...(sent ?? {}),
  });
  const speed = clampSpeed(sentSpeed ?? project.speed);

  const { edl, captionTranscript } = compileProject(project, cut);
  // maxChars is the one caption setting that changes the CUES rather than their
  // styling, so the sidecar file has to honour it too or the .srt wraps
  // differently from the burn.
  //
  // Then scaled, which the BURNED captions deliberately are not: this file gets
  // read against the rendered video's clock, and speed has already divided that
  // clock.
  //
  // Split first at 1x, scale second, in that order — the same reason maxChars is
  // honoured above. The burn splits its cues at 1x, so splitting these anywhere
  // else would hand out a .srt that breaks its lines in different places than
  // the picture does.
  const cues = scaleCues(
    toCues(captionTranscript, edl, {
      maxChars: maxChars ?? captions.maxChars,
      maxDurationMs,
    }),
    speed,
  );

  const body =
    format === 'vtt'
      ? toVtt(cues)
      : format === 'ass'
        ? toAss(cues, captions, { width: project.width ?? 1920, height: project.height ?? 1080 })
        : toSrt(cues);

  return c.json({ format, cues: cues.length, content: body });
});

/** Render, with the cut settings from the Cuts panel. */
app.post('/api/projects/:id/render', async (c) => {
  const project = await store.get(c.req.param('id'));
  if (!project?.transcript) return c.json({ error: 'Not transcribed yet' }, 400);

  const options = await c.req.json<any>().catch(() => ({}));
  const { edl, captionTranscript, render } = compileProject(project, options);
  // The request wins over the record so a render uses what is on screen right
  // now, exactly as the caption style below does. Clamped because this is a
  // number off the wire and `setpts=PTS/0` is a division by zero.
  const speed = clampSpeed(options.speed ?? project.speed);

  if (edl.keep.length === 0) {
    return c.json({ error: 'Every word is deleted — there is nothing to render.' }, 400);
  }

  // Captions are burned from cues timed against the EDL we are about to render,
  // so they track the cut by construction rather than by being regenerated.
  //
  // The style comes from the request when the client sends it and falls back to
  // what the project has stored, so a render triggered from a stale tab still
  // burns the placement the user actually set.
  // normalizeCaptions per layer, because a spread lets an explicitly-undefined
  // field from the request punch a hole through the stored value beneath it.
  const captions: CaptionSettings = normalizeCaptions({
    ...normalizeCaptions(project.captions),
    ...(options.captions ?? {}),
  });
  const wantsCaptions = Boolean(options.burnCaptions ?? captions.enabled);
  const subtitles =
    wantsCaptions && project.hasVideo
      ? toAss(
          toCues(captionTranscript, edl, {
            maxChars: captions.maxChars,
            maxDurationMs: options.maxDurationMs,
          }),
          captions,
          // libass scales the script canvas to the frame, so these must be the
          // real output dimensions or every position lands somewhere else.
          { width: project.width ?? 1920, height: project.height ?? 1080 },
        )
      : undefined;

  // The background-music bed, resolved to a concrete length on the OUTPUT clock.
  // The request may override volume/length (or switch it off) so a render reflects
  // what is on screen, exactly as captions and speed do above; otherwise the
  // stored settings win. The end is capped three ways — any user length, the
  // music file's own duration, and the program length — so the bed can never run
  // past the picture or past itself.
  const music = project.music;
  const mOpt = (options.music ?? {}) as {
    enabled?: boolean;
    volume?: number;
    durationSec?: number | null;
    loop?: boolean;
  };
  let bgMusic: { input: string; volume: number; durationSec: number; loop?: boolean } | undefined;
  if (music && (mOpt.enabled ?? true)) {
    const outLen = outputDuration(edl, speed);
    const volume = typeof mOpt.volume === 'number' && Number.isFinite(mOpt.volume) ? Math.max(0, mOpt.volume) : music.volume;
    const loop = typeof mOpt.loop === 'boolean' ? mOpt.loop : Boolean(music.loop);
    const wanted =
      mOpt.durationSec === null
        ? undefined
        : typeof mOpt.durationSec === 'number'
          ? mOpt.durationSec
          : music.durationSec;
    // Looping lets the bed run to the program length; otherwise it can be no
    // longer than the file itself. Either way the program length is the ceiling.
    const fileCap = loop ? Infinity : music.sourceDuration;
    const end = Math.min(wanted ?? outLen, fileCap, outLen);
    if (end > 0) bgMusic = { input: music.sourcePath, volume, durationSec: end, loop };
  }

  const ext = project.hasVideo ? '.mp4' : '.m4a';
  const name = `${project.id}-${Date.now()}${ext}`;
  const outPath = join(CONFIG.mediaDir, 'renders', name);

  const job = jobs.start(project.id, 'render', 'Encoding', async (runner) => {
    const started = Date.now();
    const { segments, burnedIn } = await renderEdl(
      edl,
      {
        input: project.sourcePath,
        output: outPath,
        hasVideo: project.hasVideo,
        subtitles,
        speed,
        // Where libass finds imported families. Inert unless a caption is burned.
        fontsDir: fonts.fontsDir(),
        // Present only for a multi-clip project: renderEdl then stitches these
        // source files instead of cutting the single input. width/height give the
        // canonical frame the clips are letterboxed into.
        clips: render?.clips,
        width: render?.width,
        height: render?.height,
        // The music bed, mixed under the finished program. Absent = clean render.
        bgMusic,
        // fps deliberately omitted: renderEdl probes fresh so a project imported
        // before the avg_frame_rate fix does not export at its stale, wrong rate.
      },
      {
        // This progress is exact rather than estimated: we know the output
        // length before we start, because the EDL says so.
        onProgress: (fraction) =>
          runner.onProgress({ progress: fraction, stage: `Encoding ${Math.round(fraction * 100)}%` }),
        onSpawn: (child) => runner.track(child),
      },
    );

    return {
      url: `/media/renders/${name}`,
      segments,
      burnedIn,
      // An audio-only project cannot show a caption. Say so rather than silently
      // dropping the option the user ticked.
      captionsSkipped: wantsCaptions && !project.hasVideo,
      sourceDuration: project.duration,
      outputDuration: outputDuration(edl, speed),
      speed,
      renderMs: Date.now() - started,
    };
  });

  return c.json({ jobId: job.id }, 202);
});

/**
 * Build the timeline's filmstrip.
 *
 * A job, not part of import: it costs ~8s on a 15-minute file, and import should
 * not sit on that. Idempotent — if the sheets already exist the client is handed
 * them back rather than paying again, so it is safe to call on every open.
 *
 * No progress fraction. ffmpeg's -progress reports against the OUTPUT stream,
 * and the output here is 5 images, not a timeline; the honest report is an
 * indeterminate bar with a stage string, which is what progress: -1 means.
 */
app.post('/api/projects/:id/thumbs', async (c) => {
  const project = await store.get(c.req.param('id'));
  if (!project) return c.json({ error: 'No such project' }, 404);
  if (!project.hasVideo) return c.json({ error: 'Audio has no filmstrip' }, 400);
  if (project.thumbs) return c.json({ thumbs: project.thumbs });

  const job = jobs.start(project.id, 'thumbs', 'Building filmstrip', async (runner) => {
    const thumbs = await generateThumbs(
      project.sourcePath,
      project.id,
      {
        duration: project.duration,
        hasVideo: project.hasVideo,
        hasAudio: true,
        width: project.width,
        height: project.height,
      },
      { onSpawn: (child) => runner.track(child) },
    );
    if (!thumbs) throw new Error('ffmpeg produced no sheets');

    // Re-read: the job outlives the request, and the user may have been editing
    // the transcript the whole time. Writing the `project` we captured above
    // would roll their edits back.
    const fresh = await store.get(project.id);
    if (!fresh) throw new Error('Project vanished while building its filmstrip');
    fresh.thumbs = thumbs;
    await store.save(fresh);

    return thumbs;
  });

  return c.json({ jobId: job.id }, 202);
});

// ── jobs ─────────────────────────────────────────────────────────────────────
//
// Polled, not streamed. SSE's only real advantage is sub-500ms latency, which a
// progress bar does not need — and polling survives the --watch restarts that
// are normal in development, needs no reconnect logic, has no proxy-buffering
// gotchas, and can be debugged with curl. The Job record is shaped so an
// /events endpoint can be added later without changing the client's model.

app.get('/api/jobs/:id', (c) => {
  const job = jobs.get(c.req.param('id'));
  return job ? c.json(job) : c.json({ error: 'No such job' }, 404);
});

app.get('/api/jobs', (c) => c.json(jobs.list(c.req.query('projectId'))));

app.post('/api/jobs/:id/cancel', (c) => {
  const ok = jobs.cancel(c.req.param('id'));
  return ok ? c.json({ ok: true }) : c.json({ error: 'Job is not running' }, 409);
});

/**
 * Compile a project's edit state to an EDL, plus the pieces the caption and
 * render passes need — transparently handling one clip or many.
 *
 * A single-source project compiles exactly as before. A multi-clip project
 * compiles each clip on its own timeline and concatenates (compileSequenceEdl),
 * yielding a global EDL. Captions are timed against that global timeline, but the
 * stored words hold LOCAL per-clip timestamps — so `captionTranscript` shifts
 * each word by its clip's offset, the one place local becomes global. `render`
 * carries the per-clip source files and canonical frame size the stitch needs.
 */
function compileProject(
  project: store.Project,
  options: any,
): {
  edl: Edl;
  captionTranscript: Transcript;
  render?: { clips: Array<{ input: string; fps?: number; sourceStart?: number }>; width?: number; height?: number };
} {
  const opts = toCompileOptions(options);
  const clips = store.clipsOf(project);
  const transcript = project.transcript!;

  if (clips.length <= 1) {
    return { edl: compileEdl(transcript, opts), captionTranscript: transcript };
  }

  const firstId = clips[0].id;
  const seq = clips.map((cl) => ({
    clipId: cl.id,
    duration: cl.duration,
    words: transcript.words.filter((w) => (w.clipId ?? firstId) === cl.id),
  }));
  const edl = compileSequenceEdl(seq, opts);

  const offsetOf = new Map((edl.clips ?? []).map((m) => [m.clipId, m.offset]));
  const captionTranscript: Transcript = {
    mediaId: project.id,
    duration: edl.sourceDuration,
    words: transcript.words.map((w) => {
      const off = offsetOf.get(w.clipId ?? firstId) ?? 0;
      return { ...w, start: w.start + off, end: w.end + off };
    }),
  };

  const firstVideo = clips.find((cl) => cl.hasVideo);
  return {
    edl,
    captionTranscript,
    render: {
      clips: clips.map((cl) => ({ input: cl.sourcePath, fps: cl.fps, sourceStart: cl.sourceStart })),
      width: firstVideo?.width,
      height: firstVideo?.height,
    },
  };
}

function toCompileOptions(o: any): CompileOptions {
  return {
    padMs: num(o.padMs, EDIT_DEFAULTS.padMs),
    fadeMs: num(o.fadeMs, EDIT_DEFAULTS.fadeMs),
    mergeWithinMs: num(o.mergeWithinMs, EDIT_DEFAULTS.mergeWithinMs),
    // 0 from the UI slider means "keep every pause".
    maxGapMs: num(o.maxGapMs, 0) > 0 ? o.maxGapMs : Infinity,
  };
}

/**
 * What gets stored on the project record: the wire shape, every field a real
 * number, maxGapMs left in its 0-means-keep form. Distinct from toCompileOptions,
 * which turns that 0 into the Infinity the compiler wants — persistence keeps 0,
 * because Infinity would serialise to null on disk.
 */
function sanitizeCut(o: any): CutSettings {
  return {
    padMs: num(o.padMs, EDIT_DEFAULTS.padMs),
    fadeMs: num(o.fadeMs, EDIT_DEFAULTS.fadeMs),
    mergeWithinMs: num(o.mergeWithinMs, EDIT_DEFAULTS.mergeWithinMs),
    maxGapMs: Math.max(0, num(o.maxGapMs, 0)),
  };
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function mb(bytes: number): number {
  return Math.round(bytes / 1024 / 1024);
}

/**
 * Serve the built UI, so the deployable unit is one container rather than a
 * static host plus an API. Registered last: it ends in a catch-all, which would
 * otherwise shadow every /api route declared below it.
 *
 * The catch-all rewrites unknown paths to index.html because the client routes
 * in the browser — without it, a refresh on any deep link 404s.
 */
if (CONFIG.webDist) {
  app.use('/assets/*', serveStatic({ root: CONFIG.webDist }));
  app.get('/', serveStatic({ path: 'index.html', root: CONFIG.webDist }));
  app.get('*', async (c, next) => {
    if (c.req.path.startsWith('/api') || c.req.path.startsWith('/media')) return next();
    return serveStatic({ path: 'index.html', root: CONFIG.webDist })(c, next);
  });
}

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: err.message }, 500);
});

serve({ fetch: app.fetch, port: CONFIG.port }, (info) => {
  console.log(`server  http://localhost:${info.port}`);
  console.log(`asr     ${CONFIG.hasAsr() ? 'ElevenLabs Scribe' : 'disabled (mock ASR)'}`);
});
