import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { writeFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { randomUUID } from 'node:crypto';

import { AI_TOOLS, ASR_MODELS, CONFIG, EDIT_DEFAULTS } from './config.ts';
import { probe, extractAudioForAsr, renderEdl, computePeaks } from './ffmpeg.ts';
import { transcribe, ASR_DEFAULTS, type AsrOptions } from './asr.ts';
import * as store from './store.ts';

import { compileEdl, outputDuration } from '../../../packages/core/src/edl.ts';
import { detectFillers, removeFillers } from '../../../packages/core/src/fillers.ts';
import { removeRetakes } from '../../../packages/core/src/retakes.ts';
import { toCues, toSrt, toVtt, toAss } from '../../../packages/core/src/captions.ts';
import type { CompileOptions, Transcript } from '../../../packages/core/src/types.ts';

await store.init();

const app = new Hono();
app.use('/*', cors());
app.use('/media/*', serveStatic({ root: './' }));

/** What the workspace can offer: model choices, tool availability, key status. */
app.get('/api/capabilities', (c) =>
  c.json({
    hasFal: CONFIG.hasFal(),
    asrModels: ASR_MODELS,
    aiTools: AI_TOOLS,
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
  const body = await c.req.parseBody();
  const file = body['file'];

  if (!(file instanceof File)) {
    return c.json({ error: 'Attach a media file as the "file" field.' }, 400);
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

/** Transcribe, with the options the user chose. Re-runnable with different ones. */
app.post('/api/projects/:id/transcribe', async (c) => {
  const project = await store.get(c.req.param('id'));
  if (!project) return c.json({ error: 'No such project' }, 404);

  const options: AsrOptions = { ...ASR_DEFAULTS, ...(await c.req.json().catch(() => ({}))) };

  const wavPath = join(CONFIG.mediaDir, 'uploads', `${project.id}.asr.wav`);
  await extractAudioForAsr(project.sourcePath, wavPath);

  const result = await transcribe(wavPath, project.duration, options);

  project.transcript = { mediaId: project.id, duration: project.duration, words: result.words };
  project.asrProvider = result.provider;
  project.verbatim = result.verbatim;
  project.asrOptions = options;
  project.status = 'transcribed';

  // Flag fillers, do not cut them. The user decides.
  detectFillers(project.transcript);

  await store.save(project);
  return c.json(project);
});

/** The editor sends which word ids are deleted. That is the whole edit state. */
app.patch('/api/projects/:id/transcript', async (c) => {
  const project = await store.get(c.req.param('id'));
  if (!project?.transcript) return c.json({ error: 'Not transcribed yet' }, 400);

  const { deletedIds } = await c.req.json<{ deletedIds: string[] }>();
  const deleted = new Set(deletedIds);
  for (const word of project.transcript.words) word.deleted = deleted.has(word.id);

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

  const { format = 'srt', maxChars, maxDurationMs, ...cut } = await c.req.json<any>().catch(() => ({}));

  const edl = compileEdl(project.transcript, toCompileOptions(cut));
  const cues = toCues(project.transcript, edl, { maxChars, maxDurationMs });

  const body =
    format === 'vtt' ? toVtt(cues) : format === 'ass' ? toAss(cues) : toSrt(cues);

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

  const ext = project.hasVideo ? '.mp4' : '.m4a';
  const name = `${project.id}-${Date.now()}${ext}`;
  const outPath = join(CONFIG.mediaDir, 'renders', name);

  const started = Date.now();
  const { segments } = await renderEdl(edl, project.sourcePath, outPath, project.hasVideo);

  return c.json({
    url: `/media/renders/${name}`,
    segments,
    sourceDuration: project.duration,
    outputDuration: outputDuration(edl),
    renderMs: Date.now() - started,
  });
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

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: err.message }, 500);
});

serve({ fetch: app.fetch, port: CONFIG.port }, (info) => {
  console.log(`server  http://localhost:${info.port}`);
  console.log(`fal     ${CONFIG.hasFal() ? 'enabled' : 'disabled (mock ASR)'}`);
});
