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

import {
  DEFAULT_CAPTIONS,
  type CaptionSettings,
} from '../../../packages/core/src/caption-style.ts';
import { compileEdl, outputDuration } from '../../../packages/core/src/edl.ts';
import { detectFillers, removeFillers } from '../../../packages/core/src/fillers.ts';
import { removeRetakes } from '../../../packages/core/src/retakes.ts';
import { toCues, toSrt, toVtt, toAss } from '../../../packages/core/src/captions.ts';
import type { CompileOptions, Transcript } from '../../../packages/core/src/types.ts';

await store.init();
await jobs.init();

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

  const job = jobs.start(project.id, 'transcribe', 'Extracting audio', async (runner) => {
    const wavPath = join(CONFIG.mediaDir, 'uploads', `${project.id}.asr.wav`);

    runner.onProgress({ progress: -1, stage: 'Extracting audio' });
    await extractAudioForAsr(project.sourcePath, wavPath);
    if (runner.isCanceled()) throw new Error('Canceled');

    const result = await transcribe(wavPath, project.duration, options, (p) =>
      runner.onProgress(p),
    );
    if (runner.isCanceled()) throw new Error('Canceled');

    runner.onProgress({ progress: -1, stage: 'Saving' });
    project.transcript = { mediaId: project.id, duration: project.duration, words: result.words };
    project.asrProvider = result.provider;
    project.verbatim = result.verbatim;
    project.asrOptions = options;
    project.status = 'transcribed';

    // Flag fillers, do not cut them. The user decides.
    detectFillers(project.transcript);

    await store.save(project);
    // The client re-fetches the project; a 485KB payload does not belong in a
    // record that gets polled twice a second.
    return { projectId: project.id };
  });

  return c.json({ jobId: job.id }, 202);
});

/** The editor sends which word ids are deleted. That is the whole edit state. */
app.patch('/api/projects/:id/transcript', async (c) => {
  const project = await store.get(c.req.param('id'));
  if (!project?.transcript) return c.json({ error: 'Not transcribed yet' }, 400);

  const { deletedIds, captions } = await c.req.json<{
    deletedIds: string[];
    captions?: CaptionSettings;
  }>();
  const deleted = new Set(deletedIds);
  for (const word of project.transcript.words) word.deleted = deleted.has(word.id);
  if (captions) project.captions = captions;

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

  const { format = 'srt', maxChars, maxDurationMs, captions: sent, ...cut } =
    await c.req.json<any>().catch(() => ({}));

  const captions: CaptionSettings = { ...DEFAULT_CAPTIONS, ...project.captions, ...(sent ?? {}) };

  const edl = compileEdl(project.transcript, toCompileOptions(cut));
  // maxChars is the one caption setting that changes the CUES rather than their
  // styling, so the sidecar file has to honour it too or the .srt wraps
  // differently from the burn.
  const cues = toCues(project.transcript, edl, {
    maxChars: maxChars ?? captions.maxChars,
    maxDurationMs,
  });

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
  const edl = compileEdl(project.transcript, toCompileOptions(options));

  if (edl.keep.length === 0) {
    return c.json({ error: 'Every word is deleted — there is nothing to render.' }, 400);
  }

  // Captions are burned from cues timed against the EDL we are about to render,
  // so they track the cut by construction rather than by being regenerated.
  //
  // The style comes from the request when the client sends it and falls back to
  // what the project has stored, so a render triggered from a stale tab still
  // burns the placement the user actually set.
  const captions: CaptionSettings = {
    ...DEFAULT_CAPTIONS,
    ...project.captions,
    ...(options.captions ?? {}),
  };
  const wantsCaptions = Boolean(options.burnCaptions ?? captions.enabled);
  const subtitles =
    wantsCaptions && project.hasVideo
      ? toAss(
          toCues(project.transcript, edl, {
            maxChars: captions.maxChars,
            maxDurationMs: options.maxDurationMs,
          }),
          captions,
          // libass scales the script canvas to the frame, so these must be the
          // real output dimensions or every position lands somewhere else.
          { width: project.width ?? 1920, height: project.height ?? 1080 },
        )
      : undefined;

  const ext = project.hasVideo ? '.mp4' : '.m4a';
  const name = `${project.id}-${Date.now()}${ext}`;
  const outPath = join(CONFIG.mediaDir, 'renders', name);

  const job = jobs.start(project.id, 'render', 'Encoding', async (runner) => {
    const started = Date.now();
    const { segments, burnedIn } = await renderEdl(
      edl,
      project.sourcePath,
      outPath,
      project.hasVideo,
      subtitles,
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
      outputDuration: outputDuration(edl),
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

function toCompileOptions(o: any): CompileOptions {
  return {
    padMs: num(o.padMs, EDIT_DEFAULTS.padMs),
    fadeMs: num(o.fadeMs, EDIT_DEFAULTS.fadeMs),
    mergeWithinMs: num(o.mergeWithinMs, EDIT_DEFAULTS.mergeWithinMs),
    // 0 from the UI slider means "keep every pause".
    maxGapMs: num(o.maxGapMs, 0) > 0 ? o.maxGapMs : Infinity,
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
