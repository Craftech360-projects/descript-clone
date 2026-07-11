import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { writeFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { randomUUID } from 'node:crypto';

import { CONFIG, EDIT_DEFAULTS } from './config.ts';
import { probe, extractAudioForAsr, renderEdl } from './ffmpeg.ts';
import { getAsrProvider } from './asr.ts';
import * as store from './store.ts';

import { compileEdl, outputDuration } from '../../../packages/core/src/edl.ts';
import { detectFillers, removeFillers } from '../../../packages/core/src/fillers.ts';
import { removeRetakes } from '../../../packages/core/src/retakes.ts';
import type { Transcript } from '../../../packages/core/src/types.ts';

await store.init();

const app = new Hono();
app.use('/*', cors());
app.use('/media/*', serveStatic({ root: './' }));

app.get('/api/health', (c) =>
  c.json({ ok: true, asrProvider: CONFIG.provider, hasFalKey: Boolean(CONFIG.falKey) }),
);

app.get('/api/projects', async (c) => c.json(await store.list()));

/**
 * Ingest: upload → probe → extract 16k mono wav → ASR with word timestamps.
 * The wav is a throwaway; the original is the source of truth for rendering.
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

  const wavPath = join(CONFIG.mediaDir, 'uploads', `${id}.asr.wav`);
  await extractAudioForAsr(sourcePath, wavPath);

  const asr = getAsrProvider();
  const result = await asr.transcribe(wavPath, info.duration);

  const project: store.Project = {
    id,
    name: file.name,
    sourcePath,
    sourceUrl: `/media/uploads/${id}${ext}`,
    duration: info.duration,
    hasVideo: info.hasVideo,
    transcript: { mediaId: id, duration: info.duration, words: result.words },
    asrProvider: result.provider,
    verbatim: result.verbatim,
    createdAt: new Date().toISOString(),
  };

  detectFillers(project.transcript);
  await store.save(project);

  return c.json(project);
});

app.get('/api/projects/:id', async (c) => {
  const project = await store.get(c.req.param('id'));
  return project ? c.json(project) : c.json({ error: 'No such project' }, 404);
});

/** The editor sends back which word ids are deleted. That is the entire edit state. */
app.patch('/api/projects/:id/transcript', async (c) => {
  const project = await store.get(c.req.param('id'));
  if (!project) return c.json({ error: 'No such project' }, 404);

  const { deletedIds } = await c.req.json<{ deletedIds: string[] }>();
  const deleted = new Set(deletedIds);
  for (const word of project.transcript.words) {
    word.deleted = deleted.has(word.id);
  }

  await store.save(project);
  return c.json({ ok: true, edl: summarize(project.transcript) });
});

/** One-click edits. Each mutates the transcript; the EDL follows for free. */
app.post('/api/projects/:id/actions/:action', async (c) => {
  const project = await store.get(c.req.param('id'));
  if (!project) return c.json({ error: 'No such project' }, 404);

  const action = c.req.param('action');
  const t = project.transcript;
  let changed = 0;

  switch (action) {
    case 'remove-fillers':
      detectFillers(t);
      changed = removeFillers(t);
      break;
    case 'remove-retakes':
      changed = removeRetakes(t);
      break;
    case 'restore-all':
      for (const w of t.words) {
        if (w.deleted) changed++;
        w.deleted = false;
      }
      break;
    default:
      return c.json({ error: `Unknown action: ${action}` }, 400);
  }

  await store.save(project);
  return c.json({ ok: true, changed, transcript: t, edl: summarize(t) });
});

/** Compile and render. gapMs is optional: cap silence between kept words. */
app.post('/api/projects/:id/render', async (c) => {
  const project = await store.get(c.req.param('id'));
  if (!project) return c.json({ error: 'No such project' }, 404);

  const { maxGapMs } = await c.req.json<{ maxGapMs?: number }>().catch(() => ({ maxGapMs: undefined }));

  const edl = compileEdl(project.transcript, {
    ...EDIT_DEFAULTS,
    maxGapMs: maxGapMs ?? Infinity,
  });

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

function summarize(t: Transcript) {
  const edl = compileEdl(t, EDIT_DEFAULTS);
  return {
    segments: edl.keep.length,
    outputDuration: outputDuration(edl),
    sourceDuration: t.duration,
  };
}

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: err.message }, 500);
});

serve({ fetch: app.fetch, port: CONFIG.port }, (info) => {
  console.log(`server  http://localhost:${info.port}`);
  console.log(`asr     ${CONFIG.provider}${CONFIG.provider === 'mock' ? '  (no FAL_KEY — using mock transcripts)' : ''}`);
});
