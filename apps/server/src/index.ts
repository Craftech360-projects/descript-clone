import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createNodeWebSocket } from '@hono/node-ws';
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { writeFile, rename, unlink, mkdir, readFile, stat, copyFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { join, extname, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

import { ASR_MODELS, CONFIG, EDIT_DEFAULTS, setAppleSpeechReady } from './config.ts';
import { probe, probeImage, extractAudioForAsr, renderEdl, computePeaks, checkTools, canBurnCaptions, burnCaptionsReady, burnCaptionStrip } from './ffmpeg.ts';
import { transcribe, defaultAsrOptions, type AsrOptions } from './asr.ts';
import { generate as generateThumbs } from './thumbs.ts';
import * as store from './store.ts';
import * as denoise from './denoise.ts';
import * as resumable from './resumable.ts';
import * as proxy from './proxy.ts';
import * as jobs from './jobs.ts';
import * as fonts from './fonts.ts';
import { registerAgent } from './agent.ts';
import { registerLocalAgent, probe as probeLocalAgent } from './agent-local.ts';
import { registerClaudeAgent } from './agent-claude.ts';
import { registerSummon } from './summon.ts';
import { registerSocial } from './social.ts';
import * as folders from './folders.ts';
import * as preferences from './preferences.ts';
import * as auth from './auth.ts';
import { registerEditorBridge } from './editor-bridge.ts';
import * as bridge from './bridge.ts';
import { registerBridgeRoutes } from './bridge-routes.ts';
import { readPage } from './read-page.ts';
import * as appleSpeech from './apple-speech.ts';
import * as captionImage from './caption-image.ts';
import { captionImagesReady } from './caption-image.ts';
import * as settings from './settings.ts';
import {
  availableProviders,
  downloadMusic,
  isAllowedMusicUrl,
  searchMusic,
  type MusicProviderId,
} from './music-search.ts';
import { canGenerateImages, extensionFor, generateImage } from './image-gen.ts';
import { nearestAspectRatio } from '../../../packages/core/src/image-prompt.ts';
import { loudnessStage, presetFor } from '../../../packages/core/src/export-preset.ts';

import {
  normalizeCaptions,
  type CaptionSettings,
} from '../../../packages/core/src/caption-style.ts';
import {
  compileEdl,
  compileSequenceEdl,
  outputDuration,
  sourceToOutput,
} from '../../../packages/core/src/edl.ts';
import { movesToOutput } from '../../../packages/core/src/frame-track.ts';
import { normalizeOverlays, overlaysToOutput } from '../../../packages/core/src/overlay.ts';
import { detectFillers, removeFillers } from '../../../packages/core/src/fillers.ts';
import { removeRetakes } from '../../../packages/core/src/retakes.ts';
import { scaleCues, toCues, toSrt, toVtt, toAss } from '../../../packages/core/src/captions.ts';
import { clampSpeed, type CutSettings } from '../../../packages/core/src/doc.ts';
import { uniqueWordIds } from '../../../packages/core/src/transcript.ts';
import { bedLength, bedLoops } from '../../../packages/core/src/music.ts';
import {
  DEFAULT_FRAME,
  frameSize,
  normalizeFrame,
  resolveFrame,
  type FrameSettings,
} from '../../../packages/core/src/frame.ts';
import {
  colorFilterStages,
  normalizeColor,
  resolveColor,
  type ColorSettings,
} from '../../../packages/core/src/color.ts';
import type { CompileOptions, Edl, Transcript, Word } from '../../../packages/core/src/types.ts';

// Load any dashboard-set API keys into process.env BEFORE anything reads them —
// so CONFIG's credential getters and the Claude SDK both see them from the start.
await settings.init();

/**
 * Probe on-device speech ONCE at boot and cache the answer.
 *
 * `hasAsr()` is read inside request handlers that cannot await, but deciding
 * whether the local helper is usable means hitting the filesystem and possibly
 * the Swift toolchain. So the async question is asked here and the synchronous
 * getters read the result. A machine does not sprout a compiler mid-session.
 */
setAppleSpeechReady(await appleSpeech.available());

// Ask ffmpeg once whether it can burn captions, so the answer is a synchronous
// fact for every request handler and for /api/capabilities. See canBurnCaptions.
await canBurnCaptions();
// Same shape as canBurnCaptions above: a fact about the machine, resolved once,
// because /api/capabilities and the render route cannot await a probe per call.
const denoiseReady = await denoise.available();
// Abandoned part-files, swept at boot: the one moment we know nothing is in
// flight, so an upload in progress cannot be mistaken for a dead one.
const sweptUploads = await resumable.sweep();
if (sweptUploads > 0) console.log(`upload  swept ${sweptUploads} abandoned upload${sweptUploads === 1 ? '' : 's'}`);

// And whether we can draw them ourselves when ffmpeg cannot. One of the two has
// to be true for "Burn captions" to mean anything.
await captionImage.probeAvailability();

// Look for a local LLM runtime (Ollama, LM Studio, llama.cpp). Four loopback
// probes with a short timeout — a machine with none installed pays milliseconds.
await probeLocalAgent();

await store.init();
await jobs.init();
await fonts.init();
await folders.init();
await preferences.init();
await auth.init();
await bridge.init();

const app = new Hono();

// WebSocket support for the Claude agent branch. `upgradeWebSocket` declares WS
// routes; `injectWebSocket` is attached to the Node server after serve() below.
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

/**
 * CORS_ORIGIN pins the browser origin allowed to call this API.
 *
 * This comment used to end "every route here is unauthenticated, so `*` lets any
 * page on the internet drive a stranger's projects" — true when it was written,
 * and no longer: see auth.ts. CORS was never the control that mattered, because
 * it restrains browsers and not curl, but with a credential in front it is now
 * the second layer rather than the only one.
 *
 * `credentials: true` is required for the session cookie to be legal on a
 * cross-origin call at all. SameSite=Strict still stops it being SENT
 * cross-site, which is the actual CSRF defence — this only stops the browser
 * discarding a legitimate same-site response.
 */
app.use(
  '/*',
  cors(
    process.env.CORS_ORIGIN
      ? { origin: process.env.CORS_ORIGIN, credentials: true }
      : undefined,
  ),
);

/**
 * The credential check, registered BEFORE the media static handler below and
 * before every /api route — order is the whole point, since a static handler
 * that runs first would serve the file and never consult this.
 */
app.use('/*', async (c, next) => {
  const url = new URL(c.req.url);
  const verdict = auth.authorize(
    {
      path: url.pathname,
      authorization: c.req.header('authorization') ?? null,
      cookie: c.req.header('cookie') ?? null,
      query: url.searchParams.get('token'),
    },
    auth.currentToken(),
    { enabled: auth.authEnabled(), autoIssue: auth.isLoopbackHost(CONFIG.host) },
  );

  if (!verdict.ok) {
    if (verdict.clearCookie) c.header('set-cookie', auth.cookieHeader('', 0));
    return c.json({ error: verdict.message }, verdict.status);
  }

  if ('issue' in verdict && verdict.issue) {
    c.header('set-cookie', auth.cookieHeader(verdict.issue));
    // A token that arrived in the query string is redirected away so it does not
    // linger in the address bar, in history, or in a screenshot.
    if ('redirect' in verdict && verdict.redirect) return c.redirect(verdict.redirect, 302);
  }

  await next();
});

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
/**
 * Choices that belong to this installation rather than to a browser tab.
 *
 * The model especially: it was in-memory only, so a reload put you back on the
 * default without saying so.
 */
/**
 * Read a web page's text, for the assistant.
 *
 * The address comes from a chat message, so it is untrusted input aimed at this
 * server's network position — `readPage` runs it through the same public-address
 * guard the media fetch uses before a byte is requested.
 */
app.post('/api/read-page', async (c) => {
  const { url } = await c.req.json<{ url?: string }>().catch(() => ({ url: '' }));
  if (!url?.trim()) return c.json({ error: 'Give a URL to read.' }, 400);
  try {
    return c.json(await readPage(url.trim()));
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

app.get('/api/preferences', (c) => c.json(preferences.get()));

app.patch('/api/preferences', async (c) => {
  const body = await c.req.json<Partial<import('./preferences.ts').Preferences>>().catch(() => ({}));
  return c.json(await preferences.patch(body));
});

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
    asrModels: ASR_MODELS.map((model) => ({
      ...model,
      available:
        model.provider === 'mock' ||
        (model.provider === 'elevenlabs' && CONFIG.hasElevenLabsAsr()) ||
        (model.provider === 'sarvam' && CONFIG.hasSarvamAsr()) ||
        (model.provider === 'deepgram' && CONFIG.hasDeepgramAsr()) ||
        (model.provider === 'apple' && CONFIG.hasAppleSpeech()),
    })),
    /**
     * Whether the trained voice cleaner is installed. The toggle is hidden
     * rather than disabled when it is not — an offer the server cannot keep is
     * worse than no offer. Probed once at boot; see denoise.ts.
     */
    canCleanVoice: denoiseReady,
    asrDefaults: defaultAsrOptions(),
    editDefaults: { ...EDIT_DEFAULTS, maxGapMs: 0 },
    /**
     * Where the music picker can search. Never empty — Openverse needs no key,
     * so unlike ASR this capability degrades in QUALITY rather than switching
     * off, and the panel says which catalogue it is on rather than hiding.
     */
    /**
     * The EFFECTIVE answer, not "does ffmpeg have libass".
     *
     * There are two routes — libass, or drawing the glyphs with CoreText and
     * compositing them (caption-image.ts). The UI only cares whether ticking
     * "Burn captions into the video" will produce captions, so it is told that,
     * not which of the two will do it.
     */
    canBurnCaptions: burnCaptionsReady() || captionImagesReady(),
    captionBurnVia: burnCaptionsReady() ? 'libass' : captionImagesReady() ? 'coretext' : null,
    musicProviders: availableProviders(),
    /**
     * Image inserts. `generate` gates the prompt box in the Images panel — it is
     * off until GEMINI_API_KEY is set, exactly as `hasAsr` gates transcription.
     * Importing a file is always available, so the panel degrades to that rather
     * than disappearing; this is the flag that lets it say which it is.
     */
    images: { generate: canGenerateImages() },
    /**
     * The AI assistant. `enabled` gates the chat panel exactly as `hasAsr` gates
     * transcription; `defaultModel` is the pre-selected entry in the model picker.
     */
    agent: {
      // Enabled if EITHER backend is configured. `grok`/`claude` say which are
      // available so the picker can label and route; defaultModel prefers Claude
      // (Haiku by default) when present, else Grok.
      enabled: CONFIG.hasAnyAgent(),
      grok: CONFIG.hasAgent(),
      claude: CONFIG.hasClaude(),
      defaultModel: CONFIG.hasClaude() ? CONFIG.claudeModel : CONFIG.xaiModel,
    },
  }),
);

// The assistant's routes: the Grok proxy (POST /api/agent) + model list, and the
// Claude branch (WebSocket at /api/agent/claude/ws). Registered here, before the
// static catch-all below, like every other /api route.
registerAgent(app);
registerLocalAgent(app);
registerSocial(app);
registerClaudeAgent(app, upgradeWebSocket);

/**
 * The editor bridge: a second socket a window attaches with, so callers that are
 * NOT its own chat panel — the MCP server Hermes talks to — can run the same 70
 * tools. Registered here beside the Claude one because both need upgradeWebSocket.
 */
registerEditorBridge(app, upgradeWebSocket);
registerBridgeRoutes(app);
// The assistant's escape hatch: fetch a file off the open web, run a media
// operation no panel exists for. Its own module because neither backs a feature
// of the app — see summon.ts on why an assistant needs both.
registerSummon(app);
// Runtime API-key management from the dashboard (see settings.ts).
settings.registerSettings(app);

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
 * Stream a raw upload body straight to disk, no buffering.
 *
 * Uploads arrive as the RAW file body (not multipart) with the original name in
 * the X-Filename header. That lets us pipe the request stream through to a file
 * at a fixed memory footprint, however big the source — the old path did
 * `Buffer.from(await file.arrayBuffer())`, which both held the whole file in RAM
 * and hit V8's ~2GB ArrayBuffer ceiling, so anything past ~2GB failed outright.
 *
 * Returns the on-disk path, the resolved extension, and the display name.
 */
async function streamUploadToDisk(
  c: Context,
  id: string,
): Promise<{ sourcePath: string; ext: string; name: string }> {
  const rawName = c.req.header('x-filename');
  const name = rawName ? decodeURIComponent(rawName) : 'upload.mp4';
  const ext = extname(name) || '.mp4';
  const sourcePath = join(CONFIG.mediaDir, 'uploads', `${id}${ext}`);
  const body = c.req.raw.body;
  if (!body) throw new Error('The upload had no body.');
  // Web ReadableStream → Node stream → file. pipeline destroys the write stream
  // (and removes a partial file's grip) if the client aborts mid-upload.
  await pipeline(Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(sourcePath));
  return { sourcePath, ext, name };
}

/**
 * IMPORT ONLY. This does not transcribe.
 *
 * An editor should not decide for you. Import lands the media in the project and
 * computes what is free (probe, waveform); transcription costs money and has
 * options, so it waits until you configure it and ask.
 */
app.post('/api/projects', async (c) => {
  // content-length is the only size signal available before we start streaming,
  // and it arrives before a byte of body — so an over-limit upload is refused
  // without ever touching disk.
  const declared = Number(c.req.header('content-length') ?? 0);
  if (declared > CONFIG.maxUploadBytes) {
    return c.json(
      { error: `File is too large. The limit is ${mb(CONFIG.maxUploadBytes)} MB.` },
      413,
    );
  }

  const id = randomUUID();
  let sourcePath: string;
  let name: string;
  let ext: string;
  try {
    ({ sourcePath, name, ext } = await streamUploadToDisk(c, id));
  } catch {
    return c.json({ error: 'Could not read the upload.' }, 400);
  }

  // Same cleanup contract as the resumable finish below: bytes that turn out not
  // to be media must not be left behind in mediaDir.
  let project: store.Project;
  try {
    project = await projectFromFile(id, sourcePath, name, ext);
  } catch (e) {
    await unlink(sourcePath).catch(() => {});
    return c.json(
      { error: `That file could not be read as media. ${e instanceof Error ? e.message.split('\n')[0] : ''}`.trim() },
      400,
    );
  }
  await store.save(project);
  startProxy(project.id);
  return c.json(project);
});

/**
 * Build a project record around a file that is ALREADY on disk.
 *
 * Shared by the one-shot import above and the resumable finish below, because
 * everything after "the bytes arrived" is identical and the two must not drift:
 * a project created by a resumed upload has to be indistinguishable from one
 * created in a single request.
 */
async function projectFromFile(
  id: string,
  sourcePath: string,
  name: string,
  ext: string,
): Promise<store.Project> {
  const info = await probe(sourcePath);

  return {
    id,
    name,
    sourcePath,
    sourceUrl: `/media/uploads/${id}${ext}`,
    duration: info.duration,
    hasVideo: info.hasVideo,
    width: info.width,
    height: info.height,
    fps: info.fps,
    status: 'imported',
    /**
     * New projects are REELS. Written here, at creation, rather than by changing
     * what an ABSENT frame normalizes to.
     *
     * The distinction matters. `normalizeFrame` reads a missing frame as
     * 'source' — "nothing was ever chosen, so leave the media alone" — and every
     * project saved before this change has no frame stored. Moving that fallback
     * to 'reel' would silently re-crop every existing project to 9:16 the next
     * time it was opened, which is not a default, it is an edit nobody asked for.
     *
     * Stamping the new record instead means the default applies to work started
     * from now on and existing work keeps the shape it was made at.
     */
    frame: DEFAULT_FRAME,
    transcript: null,
    asrProvider: null,
    verbatim: false,
    peaks: await computePeaks(sourcePath),
    createdAt: new Date().toISOString(),
  };
}


/**
 * Resumable upload: open a session.
 *
 * The client gets an id and sends the file in chunks against it. Everything the
 * server needs to finish the import later (name, extension) is captured now, so
 * a resume after a reload does not depend on the client remembering it.
 */
app.post('/api/uploads', async (c) => {
  const body = await c.req.json<{ name?: string; size?: number }>().catch(() => ({}));
  const name = (body.name ?? 'upload.mp4').slice(0, 200);
  const size = Number(body.size ?? 0);
  if (!Number.isFinite(size) || size <= 0) return c.json({ error: 'A size is required.' }, 400);
  if (size > CONFIG.maxUploadBytes) {
    return c.json({ error: `File is too large. The limit is ${mb(CONFIG.maxUploadBytes)} MB.` }, 413);
  }
  const session = await resumable.create({
    id: randomUUID(),
    name,
    ext: extname(name) || '.mp4',
    size,
  });
  return c.json({ uploadId: session.id, offset: 0 });
});

/**
 * Where did this upload get to?
 *
 * The question a client asks after a refresh. Answering with the byte count on
 * disk is what turns "start again" into "carry on".
 */
/** Unfinished uploads, so the dashboard can offer to carry one on. */
app.get('/api/uploads', async (c) => c.json(await resumable.list()));

app.get('/api/uploads/:id', async (c) => {
  const session = await resumable.get(c.req.param('id'));
  if (!session) return c.json({ error: 'No such upload' }, 404);
  return c.json({ uploadId: session.id, offset: session.offset, size: session.size, name: session.name });
});

/** Append one chunk at an explicit offset. See resumable.append for why it is strict. */
app.patch('/api/uploads/:id', async (c) => {
  const session = await resumable.get(c.req.param('id'));
  if (!session) return c.json({ error: 'No such upload' }, 404);

  const offset = Number(c.req.query('offset') ?? NaN);
  if (!Number.isFinite(offset) || offset < 0) return c.json({ error: 'A byte offset is required.' }, 400);

  const result = await resumable.append(session, offset, c.req.raw.body);
  if (!result.ok) {
    // 409, with the truth: the client re-seeks rather than guessing. This is the
    // normal way a retried chunk is handled, not an error worth surfacing.
    return c.json({ error: 'Offset does not match', expected: result.expected }, 409);
  }
  return c.json({ uploadId: session.id, offset: result.session.offset });
});

/**
 * Finish: turn the assembled bytes into a project.
 *
 * Refuses a short file rather than importing a truncated video — a clip that
 * plays for ten of its ninety seconds is a worse outcome than a failed import,
 * because it looks like it worked.
 */
app.post('/api/uploads/:id/finish', async (c) => {
  const session = await resumable.get(c.req.param('id'));
  if (!session) return c.json({ error: 'No such upload' }, 404);

  const onDisk = await stat(resumable.partPath(session.id)).then((s) => s.size).catch(() => 0);
  if (onDisk !== session.size) {
    return c.json({ error: 'Upload is incomplete', offset: onDisk, size: session.size }, 409);
  }

  const id = randomUUID();
  const sourcePath = join(CONFIG.mediaDir, 'uploads', `${id}${session.ext}`);
  await mkdir(dirname(sourcePath), { recursive: true });
  // rename() when it can, copy+unlink across devices — dataDir and mediaDir are
  // not guaranteed to be the same filesystem (they are not, in the Docker image).
  try {
    await rename(resumable.partPath(session.id), sourcePath);
  } catch {
    await copyFile(resumable.partPath(session.id), sourcePath);
  }
  await resumable.discard(session.id);

  /**
   * Probe can reject what arrived — a file that is not media, or one whose moov
   * atom never made it. The bytes are already in mediaDir by then, so failing
   * here without cleaning up leaves an orphan no project references and nothing
   * ever collects. Delete it and say what was wrong.
   */
  let project: store.Project;
  try {
    project = await projectFromFile(id, sourcePath, session.name, session.ext);
  } catch (e) {
    await unlink(sourcePath).catch(() => {});
    return c.json(
      { error: `That file could not be read as media. ${e instanceof Error ? e.message.split('\n')[0] : ''}`.trim() },
      400,
    );
  }
  await store.save(project);
  startProxy(project.id);
  return c.json(project);
});

/** Give up on an upload and reclaim its bytes. */
app.delete('/api/uploads/:id', async (c) => {
  await resumable.discard(c.req.param('id'));
  return c.json({ ok: true });
});


/**
 * Kick off the playback proxy for a project, in the background.
 *
 * Deliberately fire-and-forget: import must return the moment the media is on
 * disk, because the user wants to start reading the transcript, not watch a
 * progress bar for a file they already have. Until it lands the player falls
 * back to the original, which is exactly what it did before proxies existed —
 * so a failure here costs speed, never function.
 */
/**
 * Clean the voice NOW, rather than at export.
 *
 * The denoise always ran — but only inside the render, where the user had
 * already pressed Export and was waiting anyway. Turning the switch on did
 * nothing visible, so it read as a control that was not wired up. Running it
 * here gives the work a job, and therefore a progress bar, and leaves the result
 * cached so the export that follows is no slower than an uncleaned one.
 */
app.post('/api/projects/:id/clean-voice', async (c) => {
  const project = await store.get(c.req.param('id'));
  if (!project) return c.json({ error: 'No such project' }, 404);
  if (!(await denoise.available())) {
    return c.json({ error: 'Voice cleanup is not installed on this server.' }, 400);
  }

  const job = jobs.start(project.id, 'denoise', 'Cleaning voice', async (runner) => {
    const fresh = await store.get(project.id);
    if (!fresh) return {};
    const stored = store.ensureClips(fresh);
    const clips = store.clipsOf(fresh);
    let n = 0;
    for (const clip of clips) {
      n++;
      const of = clips.length > 1 ? ` (${n}/${clips.length})` : '';
      const cleaned = await denoise.ensureCleaned(clip.sourcePath, (stage) =>
        runner.onProgress({ progress: -1, stage: `${stage}${of}` }),
      );

      /**
       * Rebuild the PREVIEW from the cleaned audio.
       *
       * Without this the cleaner was inaudible: the editor plays the proxy, the
       * proxy was made from the original, so the noise stayed exactly where the
       * user could hear it and only the export was ever clean. Cleaning audio
       * you cannot listen to is not a feature.
       *
       * The proxy keeps its name — it is keyed to the original — so the URL on
       * the record does not move and nothing downstream has to be told.
       */
      runner.onProgress({ progress: -1, stage: `Updating preview${of}` });
      await proxy.build(clip.sourcePath, undefined, cleaned);
      const rec = stored.find((c) => c.id === clip.id);
      if (rec) rec.proxyUrl = proxy.proxyUrlFor(clip.sourceUrl);
      if (clips.length === 1) fresh.proxyUrl = proxy.proxyUrlFor(clip.sourceUrl);
      await store.save(fresh);
    }
    return {};
  });
  return c.json({ jobId: job?.id ?? null });
});

/**
 * Build (or rebuild) the playback proxy for an existing project.
 *
 * Import does this on its own, but every project that predates proxies has none
 * — and those are exactly the big 4K files that need one most. Returns the job
 * so the client can watch it.
 */
app.post('/api/projects/:id/proxy', async (c) => {
  const project = await store.get(c.req.param('id'));
  if (!project) return c.json({ error: 'No such project' }, 404);
  if (!project.hasVideo) return c.json({ error: 'Audio projects need no preview copy.' }, 400);
  const job = startProxy(project.id);
  return c.json({ jobId: job?.id ?? null });
});

function startProxy(projectId: string): { id: string } | null {
  return jobs.start(projectId, 'proxy', 'Preparing preview', async (runner) => {
    const fresh = await store.get(projectId);
    if (!fresh) return {};
    const clips = store.ensureClips(fresh);
    for (const clip of clips) {
      if (!clip.hasVideo) continue;
      await proxy.build(clip.sourcePath, (stage) => runner.onProgress({ progress: -1, stage }));
      clip.proxyUrl = proxy.proxyUrlFor(clip.sourceUrl);
      // Single-source projects are read through the flat fields too, so the top
      // level has to carry it or clipsOf would hand back a clip with no proxy.
      if (clips.length === 1) fresh.proxyUrl = clip.proxyUrl;
      // Saved per clip rather than once at the end: a five-clip project should
      // start playing smoothly from the first, not after the last.
      await store.save(fresh);
    }
    return {};
  });
}

app.get('/api/projects/:id', async (c) => {
  const project = await store.get(c.req.param('id'));
  return project ? c.json(project) : c.json({ error: 'No such project' }, 404);
});

/** How long a project name may be. Long enough for a real filename, short
 *  enough that a card, a title bar and a render filename can all hold it. */
const MAX_NAME = 120;

/**
 * Rename a project.
 *
 * The name is a label and nothing else: every file on disk is keyed by the
 * project's id, so this touches one string and no bytes move. It is still a
 * PATCH on the project rather than a field on the transcript PATCH, because it
 * is not part of the edit — renaming does not dirty the document or push an
 * undo step.
 */
app.patch('/api/projects/:id', async (c) => {
  const project = await store.get(c.req.param('id'));
  if (!project) return c.json({ error: 'No such project' }, 404);

  const body = await c.req.json<{ name?: unknown }>().catch(() => ({ name: undefined }));
  // Collapse whitespace as well as trim: a name pasted out of a shell or a
  // spreadsheet arrives with newlines in it, and a card cannot show those.
  const name = String(body.name ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
  if (!name) return c.json({ error: 'A project needs a name.' }, 400);

  project.name = name;
  await store.save(project);
  return c.json({ project });
});

/**
 * Delete a project: the record, its media, its cover, its filmstrip. Renders are
 * kept — see store.remove.
 *
 * There is no undo for this on either side, so the client asks before it calls.
 */
app.delete('/api/projects/:id', async (c) => {
  const id = c.req.param('id');
  // Anything still running against this project would write its result back to a
  // record that no longer exists — and, for thumbs, back into a directory we are
  // in the middle of clearing. Stop them first.
  for (const job of jobs.list(id)) jobs.cancel(job.id);
  const removed = await store.remove(id);
  return removed ? c.json({ ok: true }) : c.json({ error: 'No such project' }, 404);
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

  const options: AsrOptions = { ...defaultAsrOptions(), ...(await c.req.json().catch(() => ({}))) };
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
  // The stitch above is the ONE place per-clip word sets become a single script,
  // so it is the one place their ids can collide: ASR numbers from zero per file,
  // so clip 2 arrives with a w0 and a w4 of its own. Every id-keyed path
  // downstream (selection, buildWordPatch, the deletedIds save) would then
  // address both twins at once. See uniqueWordIds — a no-op for one clip.
  project.transcript = {
    mediaId: project.id,
    duration: project.duration,
    words: uniqueWordIds(words),
  };
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

  const clipId = randomUUID();
  let sourcePath: string;
  let ext: string;
  try {
    ({ sourcePath, ext } = await streamUploadToDisk(c, clipId));
  } catch {
    return c.json({ error: 'Could not read the upload.' }, 400);
  }

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
    const options: AsrOptions = project.asrOptions ?? defaultAsrOptions();
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
    // Stamped rather than left implicit, so every reader — including a client
    // that has not been reloaded — sees the same answer. See bedLoops.
    loop: true,
  };
  await store.save(project);
  return c.json(project);
});

/**
 * Search the web for a bed, and import one that was found.
 *
 * Split in two on purpose: searching is cheap and happens on every keystroke's
 * worth of intent, while importing spends a real download. Preview in between
 * costs this server nothing — the client points an <audio> straight at the
 * provider's CDN, and only the track actually chosen is ever fetched to disk.
 */
app.get('/api/music/search', async (c) => {
  const q = c.req.query('q') ?? '';
  const provider = c.req.query('provider') as MusicProviderId | undefined;
  const available = availableProviders();
  if (provider && !available.includes(provider)) {
    return c.json({ error: `The "${provider}" music provider is not configured.` }, 400);
  }
  try {
    const results = await searchMusic(
      { q, instrumental: c.req.query('instrumental') === '1', limit: Number(c.req.query('limit')) || 24 },
      provider,
    );
    return c.json({ results, provider: provider ?? available[0] });
  } catch (e) {
    // A provider being down or rate-limiting is not this server erroring; say
    // which it was so the panel can show something better than "failed".
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
});

/**
 * Attach a searched track as the project's bed.
 *
 * Deliberately a sibling of the upload route rather than a branch inside it:
 * once the bytes are on disk the two are identical, so everything after the
 * fetch — probe-as-validation, the BgMusic record, the quiet default volume — is
 * the same code path, and a bed sourced from the web is indistinguishable
 * downstream from one that was imported. What it adds is the credit trail.
 */
app.post('/api/projects/:id/music/url', async (c) => {
  const project = await store.get(c.req.param('id'));
  if (!project) return c.json({ error: 'No such project' }, 404);

  const body = await c.req
    .json<{ url?: string; name?: string; attribution?: string; license?: string; link?: string }>()
    .catch(() => ({}) as Record<string, undefined>);

  const url = typeof body.url === 'string' ? body.url : '';
  // The URL always comes from our own search results, so an allowlist of the
  // providers' hosts is free — and without it this route is an SSRF into
  // whatever the server can reach. See MUSIC_HOSTS in music-search.ts.
  if (!isAllowedMusicUrl(url)) {
    return c.json({ error: 'That music URL is not from a supported provider.' }, 400);
  }

  const musicId = randomUUID();
  // The extension is not known until the response's content-type arrives — the
  // Jamendo CDN URL has no path extension at all — so download to a temporary
  // name and rename once it is. ffprobe sniffs the container, but keeping the
  // extension honest matters for the <audio> the browser previews it with.
  const tmpPath = join(CONFIG.mediaDir, 'uploads', `${musicId}.part`);
  let sourcePath: string;
  let sourceUrl: string;
  try {
    const { ext } = await downloadMusic(url, tmpPath);
    sourcePath = join(CONFIG.mediaDir, 'uploads', `${musicId}${ext}`);
    await rename(tmpPath, sourcePath);
    sourceUrl = `/media/uploads/${musicId}${ext}`;
  } catch (e) {
    await unlink(tmpPath).catch(() => {});
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }

  let duration: number;
  try {
    duration = (await probe(sourcePath)).duration;
  } catch {
    await unlink(sourcePath).catch(() => {});
    return c.json({ error: 'That track could not be read as audio.' }, 400);
  }

  project.music = {
    id: musicId,
    name: typeof body.name === 'string' && body.name ? body.name : 'Background music',
    sourcePath,
    sourceUrl,
    sourceDuration: duration,
    volume: MUSIC_DEFAULT_VOLUME,
    // Stamped for the same reason as on the upload route above — see bedLoops.
    loop: true,
    // Kept with the project, not just shown once in the picker: a CC BY bed owes
    // its credit at publish time, which is long after the picker closed.
    attribution: typeof body.attribution === 'string' ? body.attribution : undefined,
    license: typeof body.license === 'string' ? body.license : undefined,
    sourceLink: typeof body.link === 'string' ? body.link : undefined,
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
    const cap = bedLoops(project.music) ? Infinity : project.music.sourceDuration;
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

/**
 * B-roll images, per project.
 *
 * Modelled on the music routes above, because the two are the same job: land a
 * media file in uploads/, probe it as validation, attach a record to the project.
 * Where they diverge is cardinality — a project has ONE bed and MANY images, and
 * each image can be placed at several words — so the asset list and the
 * placements are separate fields. See Project.images / Project.overlays.
 *
 * The placements themselves are written by the transcript PATCH, alongside the
 * frame and the grade, because they ARE the edit and belong on its undo stack.
 * These routes only manage the files.
 */
app.post('/api/projects/:id/images', async (c) => {
  const project = await store.get(c.req.param('id'));
  if (!project) return c.json({ error: 'No such project' }, 404);

  const declared = Number(c.req.header('content-length') ?? 0);
  if (declared > CONFIG.maxUploadBytes) {
    return c.json({ error: `File is too large. The limit is ${mb(CONFIG.maxUploadBytes)} MB.` }, 413);
  }

  const body = await c.req.parseBody();
  const file = body['file'];
  if (!(file instanceof File)) return c.json({ error: 'Attach an image file as the "file" field.' }, 400);
  if (file.size > CONFIG.maxUploadBytes) {
    return c.json({ error: `File is too large. The limit is ${mb(CONFIG.maxUploadBytes)} MB.` }, 413);
  }

  const imageId = randomUUID();
  const ext = extname(file.name) || '.jpg';
  const sourcePath = join(CONFIG.mediaDir, 'uploads', `${imageId}${ext}`);
  await writeFile(sourcePath, Buffer.from(await file.arrayBuffer()));

  // probeImage doubles as validation, exactly as probe does for the bed — but it
  // is stricter than "can ffmpeg open this". An overlay is held on screen with
  // `-loop 1`, which only the still-image demuxers accept, so a video or an
  // animated GIF has to be refused HERE. Let one in and it does not render badly,
  // it makes every subsequent export of this project fail. See probeImage.
  let size: { width: number; height: number };
  try {
    size = await probeImage(sourcePath);
  } catch (e) {
    // Unlike the music route, the rejected file is removed: it is unreachable
    // from the project record, and one of the things that gets rejected here is
    // an SVG, which has no business sitting in a directory we serve.
    await unlink(sourcePath).catch(() => {});
    return c.json({ error: e instanceof Error ? e.message : 'That file is not an image.' }, 400);
  }

  const image: store.ImageAsset = {
    id: imageId,
    name: file.name,
    sourcePath,
    sourceUrl: `/media/uploads/${imageId}${ext}`,
    width: size.width,
    height: size.height,
    createdAt: new Date().toISOString(),
  };
  project.images = [...(project.images ?? []), image];
  await store.save(project);
  return c.json(project);
});

/**
 * Generate a picture for this project, at the shape the video will ship in.
 *
 * This replaced a web image search, and the two differences are the point. A
 * generated image is MADE for the sentence being spoken rather than being the
 * nearest thing somebody already photographed, and it owes nobody a credit — a
 * searched one is almost always CC BY, which is an obligation the user carries
 * all the way to publication.
 *
 * The aspect ratio is decided HERE and never accepted from the client. It is a
 * fact about the project (the delivered frame, after any reframe), not a
 * preference, and the client asking for one would be a second place that can be
 * wrong — the same reason the render resolves its own frame rather than trusting
 * whatever the panel last drew. See nearestAspectRatio.
 */
app.post('/api/projects/:id/images/generate', async (c) => {
  const project = await store.get(c.req.param('id'));
  if (!project) return c.json({ error: 'No such project' }, 404);
  if (!canGenerateImages()) {
    // 503, not 500: nothing is broken, a key is missing. Mirrors how the agent
    // routes report an absent XAI_API_KEY.
    return c.json({ error: 'Image generation needs GEMINI_API_KEY on the server.' }, 503);
  }

  const body = await c.req.json<{ prompt?: string }>().catch(() => ({}) as { prompt?: string });
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) return c.json({ error: 'Describe the image you want.' }, 400);

  // The frame this project actually delivers, resolved the same way the render
  // resolves it — so the picture is generated at the shape it will be composited
  // into and  has nothing to crop.
  const frameSettings = normalizeFrame(project.frame);
  const source = { width: project.width ?? 0, height: project.height ?? 0 };
  const out = frameSize(frameSettings, source);
  const aspectRatio = nearestAspectRatio(out.width, out.height);

  const imageId = randomUUID();
  let sourcePath: string;
  let sourceUrl: string;
  try {
    const { bytes, mime } = await generateImage({ prompt, aspectRatio });
    const ext = extensionFor(mime);
    sourcePath = join(CONFIG.mediaDir, 'uploads', `${imageId}${ext}`);
    await writeFile(sourcePath, bytes);
    sourceUrl = `/media/uploads/${imageId}${ext}`;
  } catch (e) {
    // 502: the failure is upstream. The message carries the model’s own words
    // when it refused, which is the only thing that explains a refusal.
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }

  // Probed rather than assumed, exactly as on the upload path: what the model
  // returned is what the panel has to show and what `-loop 1` has to accept, and
  // the requested ratio is a request rather than a guarantee.
  let size: { width: number; height: number };
  try {
    size = await probeImage(sourcePath);
  } catch (e) {
    await unlink(sourcePath).catch(() => {});
    return c.json({ error: e instanceof Error ? e.message : 'The model returned something that is not an image.' }, 502);
  }

  const image: store.ImageAsset = {
    id: imageId,
    // The prompt names it. A generated file has no filename worth showing, and
    // the prompt is exactly what the user will recognise it by in the list.
    name: prompt.length > 60 ? `${prompt.slice(0, 59)}…` : prompt,
    sourcePath,
    sourceUrl,
    width: size.width,
    height: size.height,
    createdAt: new Date().toISOString(),
  };
  project.images = [...(project.images ?? []), image];
  await store.save(project);
  return c.json(project);
});

/**
 * Remove an image from a project's library, and every placement of it.
 *
 * The placements go too, and that is not tidiness: an overlay whose asset is
 * gone is a placement that can never draw. The render already skips one (see
 * ImagesRender.paths, which is deliberately forgiving so a missing file cannot
 * make a project un-exportable), but leaving them on the record would show the
 * user a track full of rows that do nothing and cannot be explained.
 *
 * The file is left on disk, the same as a removed clip or a detached bed — a
 * past render may still point at it.
 */
app.delete('/api/projects/:id/images/:imageId', async (c) => {
  const project = await store.get(c.req.param('id'));
  if (!project) return c.json({ error: 'No such project' }, 404);

  const imageId = c.req.param('imageId');
  const images = project.images ?? [];
  const next = images.filter((img) => img.id !== imageId);
  if (next.length === images.length) return c.json({ error: 'No such image' }, 404);

  project.images = next;
  if (project.overlays) project.overlays = project.overlays.filter((o) => o.assetId !== imageId);
  await store.save(project);
  return c.json(project);
});

/** The editor sends the whole edit state: what is cut, and how it plays out. */
app.patch('/api/projects/:id/transcript', async (c) => {
  const project = await store.get(c.req.param('id'));
  if (!project?.transcript) return c.json({ error: 'Not transcribed yet' }, 400);

  const { deletedIds, texts, speakers, captions, speed, cut, studioSound, denoise: denoise2, frame, color, overlays } =
    await c.req.json<{
    deletedIds: string[];
    texts?: Record<string, unknown>;
    speakers?: Record<string, unknown>;
    captions?: CaptionSettings;
    speed?: number;
    cut?: Partial<CutSettings>;
    studioSound?: boolean;
    denoise?: boolean;
    frame?: Partial<FrameSettings>;
    color?: Partial<ColorSettings>;
    overlays?: unknown;
  }>();
  const deleted = new Set(deletedIds);
  for (const word of project.transcript.words) word.deleted = deleted.has(word.id);

  /**
   * Corrected spellings, and the speaker labels beside them.
   *
   * Sanitised, not trusted, exactly like cut/frame/color below: only ids this
   * transcript actually has are looked at, only strings are taken, and each is
   * capped so a hostile or buggy client cannot grow the record without bound.
   *
   * `texts` is applied per word rather than replacing the array, so a word the
   * map omits keeps the text it had — an OLDER client, which sends no `texts`
   * at all, must not blank the script it cannot see. `speakers` is a whole
   * replacement because clearing a label has to be expressible, and absent is
   * the only way to say it.
   */
  const MAX_WORD = 200;
  const MAX_SPEAKER = 80;
  if (texts && typeof texts === 'object') {
    for (const word of project.transcript.words) {
      const t = texts[word.id];
      if (typeof t === 'string') word.text = t.slice(0, MAX_WORD);
    }
  }
  if (speakers && typeof speakers === 'object') {
    for (const word of project.transcript.words) {
      const s = speakers[word.id];
      word.speaker = typeof s === 'string' && s ? s.slice(0, MAX_SPEAKER) : undefined;
    }
  }

  if (captions) project.captions = captions;
  // Distinguish "not sent" from "sent as 1": an older client omits the field and
  // must not have its speed reset, but a user picking 1x must have it saved.
  if (speed !== undefined) project.speed = clampSpeed(speed);
  // Sanitised, not trusted: the record is stored in the wire shape (maxGapMs 0 =
  // keep every pause), and every field is coerced to a real number so a bad body
  // cannot poison the compiler on the next render.
  if (cut) project.cut = sanitizeCut(cut);
  if (studioSound !== undefined) project.studioSound = Boolean(studioSound);
  if (denoise2 !== undefined) project.denoise = Boolean(denoise2);
  // normalizeFrame is the coercion, same contract as sanitizeCut above: a bad
  // width, a NaN zoom, or an unknown preset off the wire cannot reach the graph.
  if (frame !== undefined) project.frame = normalizeFrame(frame);
  // Same rule again: a NaN exposure or an invented preset off the wire is coerced
  // here rather than reaching the filtergraph on the next render.
  if (color !== undefined) project.color = normalizeColor(color);
  // And again for the image track. normalizeOverlays is doing more work than its
  // siblings — it also sorts, drops a placement with no asset, and caps the list
  // at MAX_OVERLAYS — but the contract here is the same one: whatever the wire
  // says is coerced at this boundary, so nothing downstream has to re-check it.
  // The empty array is a real value and must be stored: it is what clearing the
  // last image looks like.
  if (overlays !== undefined) project.overlays = normalizeOverlays(overlays);

  await store.save(project);
  return c.json({ ok: true });
});

/**
 * Persist the assistant conversation for a project. Its own endpoint, not part of
 * the transcript PATCH: the chat is not the edit document (no undo step) and must
 * save even before a project is transcribed — so this is modelled on the rename
 * PATCH (any project), not on the transcript one (which 400s without a transcript).
 *
 * The body is stored opaquely, but bounded and lightly coerced so a stray or hostile
 * client cannot grow a project file without limit: entries and wire are capped to
 * their most recent slice, and an empty conversation clears the field entirely so
 * "Clear" leaves no residue on disk.
 */
app.put('/api/projects/:id/chat', async (c) => {
  const project = await store.get(c.req.param('id'));
  if (!project) return c.json({ error: 'No such project' }, 404);

  const MAX_CHAT_ENTRIES = 1000;
  const MAX_CHAT_WIRE = 2000;
  const body = await c.req
    .json<{ entries?: unknown; wire?: unknown; claudeSessionId?: unknown }>()
    .catch(() => ({} as { entries?: unknown; wire?: unknown; claudeSessionId?: unknown }));

  const entries = Array.isArray(body.entries) ? body.entries.slice(-MAX_CHAT_ENTRIES) : [];
  const wire = Array.isArray(body.wire) ? body.wire.slice(-MAX_CHAT_WIRE) : [];
  const claudeSessionId = typeof body.claudeSessionId === 'string' ? body.claudeSessionId : null;

  if (entries.length === 0 && wire.length === 0 && !claudeSessionId) {
    delete project.chat;
  } else {
    project.chat = { entries, wire, claudeSessionId };
  }
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
        ? // The frame the sidecar will be laid over is the RENDERED one, not the
          // source — an .ass authored at 1920x1080 puts every caption in the wrong
          // place over a 1080x1920 reel.
          toAss(
            cues,
            captions,
            frameSize(normalizeFrame(project.frame), {
              width: project.width ?? 1920,
              height: project.height ?? 1080,
            }),
          )
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

  /**
   * Refuse a burn this ffmpeg cannot do, BEFORE the job starts.
   *
   * `subtitles` is the libass filter, and it is a build option. Without it the
   * render queued, ran, and died with "No such filter: 'subtitles'" — an ffmpeg
   * internal buried in a job record, from a button that just said Export. The
   * user is left believing the app is broken rather than that one optional
   * dependency is missing.
   *
   * Refusing here says what is wrong, what it costs, and the two ways out. The
   * sidecar caption export is unaffected: it is text, not pixels, and never
   * touches libass.
   */
  /**
   * Two ways to burn a caption, and the fallback is not a downgrade.
   *
   * libass is the usual route and it is a BUILD OPTION ffmpeg here does not
   * carry, so `subtitles` does not exist and the render used to die inside
   * ffmpeg. When it is missing we draw the glyphs ourselves with CoreText and
   * composite the result as an image track — see caption-image.ts. Only when
   * NEITHER is available is there nothing to do but say so.
   */
  const captionsViaImages = wantsCaptions && !burnCaptionsReady() && captionImagesReady();

  if (wantsCaptions && !burnCaptionsReady() && !captionImagesReady()) {
    return c.json(
      {
        error:
          'Captions cannot be burned in on this machine: this ffmpeg was built without libass, ' +
          'and the built-in caption renderer needs macOS. Turn off "Burn captions into the video" ' +
          'to export without them — the caption file download is unaffected.',
      },
      422,
    );
  }

  // The output frame, resolved before captions because captions are placed
  // against it. Layered the same way as the caption style: the request wins over
  // the record, per field, so an Export fired mid-debounce reframes to what is on
  // screen. The SOURCE it is resolved against is the stitched canvas on a
  // multi-clip project (render.width/height) and the file's own size otherwise.
  /**
   * A preset names the shape it wants, and that beats the stored frame — picking
   * "Instagram Reels" and getting a 16:9 file because the project was left on
   * `source` would make the preset a decoration.
   */
  const presetSize = presetFor(String(options.preset ?? 'source')).size;
  const frameSettings = normalizeFrame({
    ...project.frame,
    ...(presetSize ? { preset: 'custom' as const, width: presetSize.width, height: presetSize.height } : {}),
    ...(options.frame ?? {}),
  });
  const sourceSize = {
    width: render?.width ?? project.width ?? 1920,
    height: render?.height ?? project.height ?? 1080,
  };
  const outSize = frameSize(frameSettings, sourceSize);
  // null when the setting would change nothing — then no scale/crop is emitted at
  // all and the picture is passed through untouched. Audio-only has no picture to
  // reframe, so it never gets one either.
  const frame = project.hasVideo ? (resolveFrame(frameSettings, sourceSize) ?? undefined) : undefined;

  // The colour grade, layered request-over-record exactly as the frame is. null
  // when the grade is neutral, so no colour filters are emitted at all and an
  // ungraded export is the same file it was before grading existed. Audio-only
  // has no picture to grade, so it never gets one.
  const color = project.hasVideo
    ? (resolveColor(normalizeColor({ ...project.color, ...(options.color ?? {}) })) ?? undefined)
    : undefined;

  /**
   * Walk inwards from a cut end until something survived, on the output clock.
   *
   * sourceToOutput returns null for a moment the edit removed, which is what
   * happens whenever a timed region's own ends were trimmed. Both timed tracks —
   * push-ins and images — want the same answer there (shorten the region, do not
   * delete it), so they share one implementation rather than each carrying a
   * copy that can drift from the other.
   *
   * 20 steps is plenty: the caller only needs SOME surviving instant near the
   * end it lost, and the ease is rescaled to whatever is left anyway. A finer
   * walk would be spending precision on a boundary the cut has already made
   * approximate.
   */
  const inward = (from: number, to: number): number | null => {
    const step = (to - from) / 20;
    for (let i = 1; i <= 20; i++) {
      const at = sourceToOutput(edl, from + step * i);
      if (at !== null) return at;
    }
    return null;
  };

  // The push-ins, moved from the SOURCE clock they are marked on to the OUTPUT
  // clock the filter runs on.
  //
  // This mapping is the whole reason moves are stored in source time: a move is
  // attached to the words it was aimed at, so cutting a sentence ahead of it has
  // to carry it earlier rather than leave it pointing at whatever now happens to
  // occupy that second. sourceToOutput answers that exactly, and returns null for
  // a moment the edit removed — hence `inward`, which finds the first instant of
  // the move that survived, so trimming a push-in's ends shortens it instead of
  // deleting it.
  const punch =
    project.hasVideo && frameSettings.moves.length > 0
      ? {
          moves: movesToOutput(frameSettings.moves, (t) => sourceToOutput(edl, t), inward),
          width: outSize.width,
          height: outSize.height,
        }
      : undefined;

  // The image track, mapped over identically — same clock, same probe, same
  // reason. An overlay is aimed at a word, so it has to travel with that word
  // when the cut moves it, and an insert whose ends were trimmed should get
  // shorter rather than vanish.
  //
  // Live overlays win over the record for the reason the frame, the grade and
  // the caption style all do above: an Export fired mid-debounce has to use what
  // is on screen, not what the last save happened to catch. Coerced through
  // normalizeOverlays either way, because the request half of that is off the
  // wire.
  const overlays = normalizeOverlays(options.overlays ?? project.overlays);
  // Skipped entirely with no picture to composite onto, or nothing to composite:
  // then no extra input and no filter is emitted at all, and the export is the
  // same file it was before the feature existed.
  const images =
    project.hasVideo && overlays.length > 0
      ? {
          overlays: overlaysToOutput(overlays, (t) => sourceToOutput(edl, t), inward),
          // Keyed by asset id, not one path per overlay: the same picture placed
          // at four words is one file. See ImagesRender.paths.
          paths: Object.fromEntries((project.images ?? []).map((img) => [img.id, img.sourcePath])),
          // The DELIVERED frame, the same values the push-in gets — an overlay's
          // box is a fraction of the frame that ships, so the two must resolve
          // their fractions against exactly the same rectangle.
          width: outSize.width,
          height: outSize.height,
        }
      : undefined;

  const subtitles =
    wantsCaptions && project.hasVideo && !captionsViaImages
      ? toAss(
          toCues(captionTranscript, edl, {
            maxChars: captions.maxChars,
            maxDurationMs: options.maxDurationMs,
          }),
          captions,
          // libass scales the script canvas to the frame, so these must be the
          // real output dimensions or every position lands somewhere else — which
          // is why this is the RESOLVED frame and not the source's size. Burn-in
          // happens after the crop, so the canvas libass paints on is outSize.
          outSize,
        )
      : undefined;

  // The background-music bed, resolved to a concrete length on the OUTPUT clock.
  // The request may override volume/length (or switch it off) so a render reflects
  // what is on screen, exactly as captions and speed do above; otherwise the
  // stored settings win.
  //
  // The three-way cap itself is bedLength in core, NOT re-derived here: the
  // monitor resolves the same bed for the preview, and every time the two sides
  // held their own copy of this arithmetic they drifted — which the user hears as
  // an export that does not match what they signed off on.
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
    // A live override wins; otherwise the stored bed answers — and an absent
    // `loop` there means "fill", not "off". See bedLoops.
    const loop = typeof mOpt.loop === 'boolean' ? mOpt.loop : bedLoops(music);
    const wanted =
      mOpt.durationSec === null
        ? undefined
        : typeof mOpt.durationSec === 'number'
          ? mOpt.durationSec
          : music.durationSec;
    const end = bedLength({ sourceDuration: music.sourceDuration, durationSec: wanted, loop }, outLen);
    if (end > 0) bgMusic = { input: music.sourcePath, volume, durationSec: end, loop };
  }

  const ext = project.hasVideo ? '.mp4' : '.m4a';
  const name = `${project.id}-${Date.now()}${ext}`;
  const outPath = join(CONFIG.mediaDir, 'renders', name);

  const job = jobs.start(project.id, 'render', 'Encoding', async (runner) => {
    const started = Date.now();

    /**
     * Voice cleanup, when it is asked for.
     *
     * Runs BEFORE the render and swaps the input, rather than joining the filter
     * chain — DeepFilterNet is a model, not a filter. What comes back is the same
     * media with the same picture (stream-copied, not re-encoded) and cleaned
     * audio, so everything below this line is unchanged and unaware.
     *
     * Cached per source, so only the first render of a clip pays for it.
     *
     * A multi-clip project cleans each clip; they are separate files and the
     * stitch reads them individually.
     */
    const wantsClean = Boolean(options.denoise ?? project.denoise);
    let input = project.sourcePath;
    let clipInputs = render?.clips;
    if (wantsClean) {
      runner.onProgress({ progress: -1, stage: 'Cleaning voice' });
      input = await denoise.ensureCleaned(project.sourcePath, (stage) =>
        runner.onProgress({ progress: -1, stage }),
      );
      if (clipInputs) {
        clipInputs = [];
        for (const cl of render!.clips) {
          clipInputs.push({ ...cl, input: await denoise.ensureCleaned(cl.input) });
        }
      }
    }

    const { segments, burnedIn } = await renderEdl(
      edl,
      {
        input,
        output: outPath,
        hasVideo: project.hasVideo,
        subtitles,
        speed,
        // Where libass finds imported families. Inert unless a caption is burned.
        fontsDir: fonts.fontsDir(),
        // Present only for a multi-clip project: renderEdl then stitches these
        // source files instead of cutting the single input. width/height give the
        // canonical frame the clips are letterboxed into.
        clips: clipInputs,
        width: render?.width,
        height: render?.height,
        // The music bed, mixed under the finished program. Absent = clean render.
        bgMusic,
        // Tells the voice chain the model already cleaned this input, so it does
        // not denoise twice or amplify what the model left behind.
        denoised: wantsClean,
        // The Studio Sound voice chain, run on the program before the bed. Live
        // settings win over the stored flag for the same reason the music ones do:
        // an Export fired mid-debounce should use the toggle on screen.
        studioSound: Boolean(options.studioSound ?? project.studioSound),
        // Where this file is going. The preset's loudness target runs whether or
        // not Studio Sound is on — arriving at the right level is not a creative
        // choice the way the voice chain is. See export-preset.ts.
        loudness: loudnessStage(String(options.preset ?? 'source')),
        // The crop into the target resolution. Absent = the picture keeps the
        // source's shape, and the video graph is emitted as it was before.
        frame,
        // The animated push-ins, on the output clock. renderEdl fills in the
        // frame rate from the same probe the cut's renumber uses.
        punch,
        // The B-roll images, on the output clock, composited between the grade
        // and the caption burn. renderEdl fills in the frame rate the same way it
        // does for the punch. Absent = no extra inputs, no overlay filters.
        images,
        // The colour grade, applied after the crop and before the caption burn
        // so it never tints a caption. Absent = the picture's values are untouched.
        color,
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

    /**
     * The CoreText caption pass.
     *
     * Runs only when libass is absent — otherwise the glyphs are already in the
     * picture and this is skipped entirely. The tiles are drawn from the same
     * cues and the same CaptionSettings the preview reads, so what ships is what
     * was on screen.
     */
    let finalName = name;
    if (captionsViaImages && project.hasVideo) {
      runner.onProgress({ progress: -1, stage: 'Drawing captions' });

      const cues = toCues(captionTranscript, edl, {
        maxChars: captions.maxChars,
        maxDurationMs: options.maxDurationMs,
      });
      const scaled = speed === 1 ? cues : scaleCues(cues, speed);

      const strip = await captionImage.build(
        scaled,
        captions,
        outSize,
        CONFIG.mediaDir,
        job.id,
      );

      if (strip) {
        try {
          const burnedName = name.replace(/\.mp4$/, '-cc.mp4');
          runner.onProgress({ progress: -1, stage: 'Burning captions' });
          await burnCaptionStrip(
            join(CONFIG.mediaDir, 'renders', name),
            join(CONFIG.mediaDir, 'renders', burnedName),
            strip,
            { onSpawn: (child) => runner.track(child) },
          );
          // The clean render was an intermediate; only the captioned file ships.
          await unlink(join(CONFIG.mediaDir, 'renders', name)).catch(() => {});
          finalName = burnedName;
        } finally {
          await captionImage.cleanup(strip);
        }
      }
    }

    return {
      url: `/media/renders/${finalName}`,
      segments,
      burnedIn: burnedIn || captionsViaImages,
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
 * Run one ffmpeg command to completion. For the single-frame look, which needs
 * neither progress nor cancellation — the whole point is that it is over before
 * anyone would think to stop it.
 */
function runFfmpegOnce(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(CONFIG.ffmpegPath, args, { windowsHide: true });
    let err = '';
    child.stderr.on('data', (c) => { err = (err + String(c)).slice(-1000); });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${err.trim().slice(0, 300)}`)),
    );
  });
}

/**
 * Which caption tile is on screen at `at` on the output clock.
 *
 * The strip is one tile per caption STATE — a gap, a cue, or a word within a cue
 * when karaoke is on — so the index is a walk, not arithmetic. Returns 0 (the
 * leading gap) when nothing is being said, which is the honest picture.
 */
function tileIndexAt(cues: Array<{ start: number; end: number; words: unknown[] }>, at: number, karaoke: boolean): number {
  let index = 0;
  let clock = 0;
  for (const cue of cues) {
    if (cue.start > clock + 0.001) {
      if (at < cue.start) return index;
      index += 1;
      clock = cue.start;
    }
    if (at < cue.end) {
      if (!karaoke || cue.words.length === 0) return index;
      const words = cue.words as Array<{ start: number }>;
      for (let i = 0; i < words.length; i++) {
        const next = i === words.length - 1 ? cue.end : words[i + 1].start;
        if (at < next) return index + i;
      }
      return index + Math.max(0, words.length - 1);
    }
    index += !karaoke || cue.words.length === 0 ? 1 : Math.max(1, cue.words.length);
    clock = cue.end;
  }
  return index;
}

/**
 * ONE finished frame, as an image — what the assistant looks at.
 *
 * Not a screenshot of the app. A screenshot shows the editor's chrome, which is
 * not the thing anyone is asking about; this renders the DELIVERED picture at a
 * moment — the crop, the grade and the burned caption — so "does the subtitle
 * sit under the platform's caption bar" is answerable by looking rather than by
 * reasoning about numbers.
 *
 * Cheap on purpose: one frame, scaled down, no audio, no encode of a programme.
 * The caption tile is composited exactly as the export does it, so what the
 * model sees is what would ship.
 */
app.post('/api/projects/:id/frame', async (c) => {
  const project = await store.get(c.req.param('id'));
  if (!project) return c.json({ error: 'No such project' }, 404);
  if (!project.hasVideo) return c.json({ error: 'This project has no picture to look at.' }, 400);

  const body = await c.req.json<{ atSeconds?: number; captions?: CaptionSettings }>().catch(() => ({}));

  const captions = normalizeCaptions({ ...normalizeCaptions(project.captions), ...(body.captions ?? {}) });
  const frameSettings = normalizeFrame(project.frame);
  const source = { width: project.width ?? 1920, height: project.height ?? 1080 };
  const outSize = frameSize(frameSettings, source);

  const clips = store.clipsOf(project);
  const at = Math.max(0, Math.min(project.duration - 0.05, Number(body.atSeconds ?? 0) || 0));
  // Which file that moment lives in — a multi-clip project's timeline is not any
  // single file's timeline.
  const clip = clips.find((cl) => at >= cl.offset && at < cl.offset + cl.duration) ?? clips[0];
  const withinClip = (clip.sourceStart ?? 0) + (at - clip.offset);

  const dir = join(CONFIG.mediaDir, 'tmp');
  await mkdir(dir, { recursive: true }).catch(() => {});
  const out = join(dir, `frame-${project.id}-${Date.now()}.jpg`);

  const filters: string[] = [];
  const resolved = resolveFrame(frameSettings, source);
  if (resolved) filters.push(...frameFilterStages(resolved));
  const grade = resolveColor(normalizeColor(project.color));
  if (grade) filters.push(...colorFilterStages(grade));
  // Small: the model is judging placement and colour, not pixel detail, and a
  // 4K still costs tokens for nothing.
  filters.push(`scale=${Math.min(540, outSize.width)}:-2`);

  try {
    await runFfmpegOnce([
      '-hide_banner', '-v', 'error', '-y',
      '-ss', String(withinClip),
      '-i', clip.sourcePath,
      '-frames:v', '1',
      ...(filters.length ? ['-vf', filters.join(',')] : []),
      '-q:v', '4',
      out,
    ]);

    let framePath = out;
    // The caption, composited the same way the export does it, so the answer is
    // about the delivered picture rather than an approximation of it.
    if (captions.enabled && captionImagesReady() && project.transcript) {
      const transcript = project.transcript;
      if (!transcript) throw new Error('no transcript');
      const edl = compileEdl(transcript, EDIT_DEFAULTS);
      const cues = toCues(transcript, edl, { maxChars: captions.maxChars });
      const strip = await captionImage.build(cues, captions, outSize, CONFIG.mediaDir, `look-${project.id}`);
      if (strip) {
        try {
          const withCaps = out.replace(/\.jpg$/, '-cc.jpg');
          await runFfmpegOnce([
            '-hide_banner', '-v', 'error', '-y',
            '-i', out,
            // The tile that is on screen at this moment. Always taking cap-00001
            // would show whatever the first caption happened to be, which is a
            // different lie from showing none.
            '-i', join(strip.dir, `cap-${String(tileIndexAt(cues, at, captions.karaoke)).padStart(5, '0')}.png`),
            '-filter_complex',
            `[1:v]scale=iw*${(Math.min(540, outSize.width) / outSize.width).toFixed(4)}:-1[c];[0:v][c]overlay=x=${Math.round(strip.x * (Math.min(540, outSize.width) / outSize.width))}:y=${Math.round(strip.y * (Math.min(540, outSize.width) / outSize.width))}`,
            '-frames:v', '1', '-q:v', '4', withCaps,
          ]);
          framePath = withCaps;
        } catch {
          // A caption that would not composite is not a reason to refuse the
          // look — the picture underneath is still the answer to most questions.
        } finally {
          await captionImage.cleanup(strip);
        }
      }
    }

    const bytes = await readFile(framePath);
    await unlink(out).catch(() => {});
    if (framePath !== out) await unlink(framePath).catch(() => {});

    return c.json({
      image: `data:image/jpeg;base64,${bytes.toString('base64')}`,
      atSeconds: at,
      width: Math.min(540, outSize.width),
      note: `Frame at ${at.toFixed(1)}s of the finished ${outSize.width}x${outSize.height} picture.`,
    });
  } catch (e) {
    await unlink(out).catch(() => {});
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
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
    // Probe rather than trust the record. The tile's SHAPE comes from these two
    // numbers, and the record is the one thing here that can be stale — it is
    // written once at import, while `probe` reads the file in front of it. A
    // disagreement used to bake a squashed picture into every sheet.
    const probed = await probe(project.sourcePath).catch(() => null);

    /**
     * Every clip, not just the first.
     *
     * `project.duration` is the SUM across clips while `sourcePath` is clip 0
     * alone, so passing the pair asked for a strip covering the whole programme
     * built from one file — and the strip went black at clip 1's end.
     */
    const clips = store.clipsOf(project);
    const sources = clips.map((c) => ({
      sourcePath: c.sourcePath,
      sourceStart: c.sourceStart,
      duration: c.duration,
    }));

    const thumbs = await generateThumbs(
      sources.length > 1 ? sources : project.sourcePath,
      project.id,
      {
        duration: project.duration,
        hasVideo: project.hasVideo,
        hasAudio: true,
        width: probed?.width ?? project.width,
        height: probed?.height ?? project.height,
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
 * Two-step lookup: first try the request path as a real file (this covers
 * /assets/* AND root-level files copied from Vite's public/ dir, like the
 * jumpcut.png logo — serveStatic no-ops via next() when the file doesn't
 * exist, so this never blocks the second step). The catch-all then rewrites
 * anything else to index.html because the client routes in the browser —
 * without it, a refresh on any deep link 404s.
 */
if (CONFIG.webDist) {
  app.use('*', async (c, next) => {
    if (c.req.path.startsWith('/api') || c.req.path.startsWith('/media')) return next();
    return serveStatic({ root: CONFIG.webDist })(c, next);
  });
  app.get('*', async (c, next) => {
    if (c.req.path.startsWith('/api') || c.req.path.startsWith('/media')) return next();
    return serveStatic({ path: 'index.html', root: CONFIG.webDist })(c, next);
  });
}

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: err.message }, 500);
});

/**
 * Is this bind address one only this machine can reach?
 *
 * Used for one thing: deciding whether the startup banner owes the operator a
 * warning. `::` and `0.0.0.0` are the two ways to say "every interface", and a
 * named host is assumed routable because a person who typed one meant it.
 */
function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

const server = serve({ fetch: app.fetch, port: CONFIG.port, hostname: CONFIG.host }, (info) => {
  // Print the address we ACTUALLY bound. The old line said "localhost" while
  // binding every interface, so the one place a person looks to find out where
  // their editor is listening told them the reassuring answer rather than the
  // real one.
  console.log(`server  http://${CONFIG.host}:${info.port}`);
  // Publish where we ACTUALLY landed, so an external agent can find us even
  // though the desktop shell picks a fresh port every launch. See bridge.ts.
  void bridge.publish(info.port);
  if (!isLoopback(CONFIG.host)) {
    console.log(`        reachable from the network — every route on this port is`);
  }
  const asr = [
    CONFIG.hasElevenLabsAsr() ? 'ElevenLabs Scribe' : '',
    CONFIG.hasSarvamAsr() ? 'Sarvam Saaras v3' : '',
    CONFIG.hasAppleSpeech() ? 'Apple on-device (no key, no diarization)' : '',
    CONFIG.hasDeepgramAsr() ? 'Deepgram Nova-3' : '',
  ].filter(Boolean).join(' + ') || 'disabled (mock ASR)';
  console.log(`asr     ${asr}`);
  console.log(
    `music   ${CONFIG.jamendoClientId ? 'Jamendo + Openverse' : 'Openverse only (set JAMENDO_CLIENT_ID for more)'}`,
  );
  const grok = CONFIG.hasAgent() ? 'Grok' : '';
  const claude = CONFIG.hasClaude() ? 'Claude (subscription/key)' : '';
  const agent = [grok, claude].filter(Boolean).join(' + ') || 'disabled (no key)';
  console.log(`agent   ${agent}`);
});

// Attach the WebSocket upgrade handler to the running Node server (Claude branch).
injectWebSocket(server);
