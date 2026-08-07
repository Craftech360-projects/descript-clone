import type { Hono } from 'hono';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rename, unlink, stat } from 'node:fs/promises';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { join, extname, basename } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';

import { CONFIG } from './config.ts';
import * as store from './store.ts';
import { clipsOf } from './store.ts';

/**
 * The assistant's escape hatch: media work the app has no feature for.
 *
 * Every other route on this server backs something the UI can also do. These two
 * do not, and that is their reason to exist. The assistant is meant to attempt a
 * request rather than answer "the app can't do that" — "reverse that clip", "cut
 * me a gif of the punchline", "just the audio as an mp3", "freeze the last
 * frame", "put a title card on the front" — and attempting requires two powers
 * the editor itself has never needed: reaching the open web for a file, and
 * running an ffmpeg operation nobody wrote a panel for.
 *
 *   POST /api/projects/:id/summon/fetch   pull one URL onto disk, probed
 *   POST /api/projects/:id/summon/op      run one ffmpeg operation over media
 *
 * Neither mutates the project. Both land a file in uploads/ and hand back its
 * URL; ATTACHING it — as a clip, as the bed, as a B-roll image — goes back
 * through the ordinary routes the UI already uses, driven from the browser. That
 * split is the point: a summoned file is indistinguishable downstream from an
 * imported one, no attach logic exists twice, and a failed improvisation leaves
 * a stray file rather than a half-attached project.
 *
 * ── on handing a language model an ffmpeg process ────────────────────────────
 *
 * `op` is the sharp one, so its edges are ground down rather than trusted:
 *
 *  - The INPUT is chosen by id out of this project's own media, or from a URL
 *    that passed the fetch guards below. The model never names a path.
 *  - The OUTPUT path and every codec flag come from FORMATS here. The model
 *    picks a container from an enum, not an argv.
 *  - The only free text is the filter chain, checked against FILTER_BANNED —
 *    the constructs that let a filtergraph open an input of its own (movie=,
 *    amovie=) or reach a protocol. A filtergraph cannot write files or spawn a
 *    shell, so what remains is "compute the wrong picture", which costs a wasted
 *    job and nothing else.
 *  - Every run is capped: OP_TIMEOUT_MS of wall clock, MAX_OP_SECONDS of output.
 *
 * SUMMON=off removes both routes; the assistant then reports that improvising is
 * switched off rather than failing in a way it cannot explain.
 */

/** Where summoned bytes land. The same directory imports use, so /media serves them. */
const uploadsDir = () => join(CONFIG.mediaDir, 'uploads');

/** How long one ffmpeg operation may run before it is killed. */
const OP_TIMEOUT_MS = 120_000;
/** The longest output an operation may produce — a guard against a `-loop 1` typo. */
const MAX_OP_SECONDS = 1800;
/** Redirect hops followed while fetching, each one re-validated. */
const MAX_REDIRECTS = 3;

// ── fetching from the open web ───────────────────────────────────────────────

/**
 * Refuse anything pointing back into this machine or its network.
 *
 * The music and image routes can use host allowlists because their URLs only
 * ever come from our own search results. This one cannot — arbitrary web media
 * is the entire point — so the check moves from "is this host known" to "does it
 * resolve somewhere the server has no business reaching", which is what an SSRF
 * actually needs. Every redirect hop is re-checked: a public host that 302s to
 * 169.254.169.254 is the standard way past a check done only on the first URL.
 */
async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('That is not a valid URL.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Only http and https URLs can be fetched.');
  }

  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host)
    ? [{ address: host }]
    : await lookup(host, { all: true }).catch(() => {
        throw new Error(`Could not resolve ${url.hostname}.`);
      });

  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw new Error('That URL points at a private address, so it will not be fetched.');
    }
  }
  return url;
}

function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 169 && b === 254) ||           // link-local, incl. cloud metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
      a >= 224                              // multicast and reserved
    );
  }
  const v6 = ip.toLowerCase();
  if (v6 === '::' || v6 === '::1') return true;
  if (v6.startsWith('fe80') || v6.startsWith('fc') || v6.startsWith('fd')) return true;
  // An IPv4-mapped address (::ffff:127.0.0.1) carries the v4 rules with it.
  const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? isPrivateAddress(mapped[1]) : false;
}

const EXT_BY_TYPE: Record<string, string> = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp',
  'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/ogg': '.ogg', 'audio/wav': '.wav',
  'audio/x-wav': '.wav', 'audio/flac': '.flac',
  'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov',
};

export type MediaKind = 'image' | 'audio' | 'video';

/**
 * Download one URL into uploads/, capped and content-type checked.
 *
 * The extension comes from the content-type first and the URL path second: a CDN
 * link with no extension at all is the common case, and an extension that lies
 * about its container confuses the <img>/<audio> the browser previews it with.
 */
export async function fetchToUploads(
  rawUrl: string,
  accept: MediaKind | 'any' = 'any',
): Promise<{ id: string; path: string; url: string; name: string; kind: MediaKind; bytes: number }> {
  let target = await assertPublicUrl(rawUrl);
  let res: Response | null = null;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    res = await fetch(target, { redirect: 'manual', headers: { 'User-Agent': 'JumpCut/1.0' } });
    if (res.status < 300 || res.status >= 400) break;
    const location = res.headers.get('location');
    if (!location) break;
    target = await assertPublicUrl(new URL(location, target).toString());
    res = null;
  }
  if (!res || !res.ok || !res.body) {
    throw new Error(`Could not fetch that URL (${res ? res.status : 'too many redirects'}).`);
  }

  const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  const kind: MediaKind = type.startsWith('image/')
    ? 'image'
    : type.startsWith('video/')
      ? 'video'
      : type.startsWith('audio/')
        ? 'audio'
        : guessKindFromPath(target.pathname);
  if (accept !== 'any' && kind !== accept) {
    throw new Error(`That URL served ${type || 'an unknown type'}, not ${accept}.`);
  }

  const ext = EXT_BY_TYPE[type] ?? (extname(target.pathname).slice(0, 5) || defaultExt(kind));
  const id = randomUUID();
  const tmp = join(uploadsDir(), `${id}.part`);
  const path = join(uploadsDir(), `${id}${ext}`);

  // A cap of its own rather than maxUploadBytes: that one is Infinity by default,
  // which is defensible for a file the user picked and indefensible for a URL a
  // language model chose.
  const maxBytes = Math.min(CONFIG.maxUploadBytes, CONFIG.summonMaxBytes);
  let bytes = 0;
  const cap = new Transform({
    transform(chunk, _enc, cb) {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        return cb(new Error(`That file is larger than the ${Math.round(maxBytes / 1048576)} MB limit for fetched media.`));
      }
      cb(null, chunk);
    },
  });

  try {
    await pipeline(Readable.fromWeb(res.body as never), cap, createWriteStream(tmp));
    await rename(tmp, path);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }

  return {
    id,
    path,
    url: `/media/uploads/${id}${ext}`,
    name: decodeURIComponent(basename(target.pathname)) || `summoned${ext}`,
    kind,
    bytes,
  };
}

function guessKindFromPath(path: string): MediaKind {
  const ext = extname(path).toLowerCase();
  if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.avif'].includes(ext)) return 'image';
  if (['.mp3', '.wav', '.m4a', '.ogg', '.flac', '.aac'].includes(ext)) return 'audio';
  return 'video';
}

const defaultExt = (kind: MediaKind) => (kind === 'image' ? '.jpg' : kind === 'audio' ? '.mp3' : '.mp4');

// ── probing without demanding audio ──────────────────────────────────────────

/**
 * ffmpeg.ts's `probe` throws when a file has no audio track, because everything
 * it probes is on its way to ASR. A summoned file may legitimately be a still
 * image or a silent clip, so this one reports what is there and judges nothing.
 */
export async function probeAny(
  path: string,
): Promise<{ duration: number; hasVideo: boolean; hasAudio: boolean; width?: number; height?: number }> {
  const out = await runCapture(CONFIG.ffprobePath, [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path,
  ]);
  const data = JSON.parse(out) as {
    format?: { duration?: string };
    streams?: Array<{ codec_type?: string; width?: number; height?: number }>;
  };
  const video = data.streams?.find((s) => s.codec_type === 'video');
  const audio = data.streams?.find((s) => s.codec_type === 'audio');
  return {
    duration: Number(data.format?.duration ?? 0) || 0,
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    width: video?.width,
    height: video?.height,
  };
}

function runCapture(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { windowsHide: true });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (err += d));
    proc.on('error', (e) => reject(new Error(`Could not run ${bin}: ${e.message}`)));
    proc.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err.trim() || `${bin} exited ${code}`))));
  });
}

// ── the media operation ──────────────────────────────────────────────────────

/** Output containers the model may ask for, and the flags that produce each. */
const FORMATS: Record<string, { ext: string; args: string[]; kind: MediaKind; video: boolean }> = {
  mp4: {
    ext: '.mp4', kind: 'video', video: true,
    args: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
           '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart'],
  },
  webm: {
    ext: '.webm', kind: 'video', video: true,
    args: ['-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', '0', '-c:a', 'libopus'],
  },
  gif: { ext: '.gif', kind: 'image', video: true, args: [] }, // built by gifGraph below
  mp3: { ext: '.mp3', kind: 'audio', video: false, args: ['-c:a', 'libmp3lame', '-q:a', '2'] },
  wav: { ext: '.wav', kind: 'audio', video: false, args: ['-c:a', 'pcm_s16le'] },
  png: { ext: '.png', kind: 'image', video: true, args: ['-frames:v', '1'] },
  jpg: { ext: '.jpg', kind: 'image', video: true, args: ['-frames:v', '1', '-q:v', '3'] },
};

export const SUMMON_FORMATS = Object.keys(FORMATS);

/**
 * Filter-chain constructs that are refused.
 *
 * Not a sanitiser — a filtergraph has no shell and cannot write files, so there
 * is nothing to escape. What it CAN do is open an input of its own, and that is
 * the one power that turns "compute a picture" into "read any file on this disk
 * through the movie filter". These are those constructs, plus the protocol
 * prefixes that would smuggle one in.
 */
const FILTER_BANNED =
  /(^|[^a-z0-9_])(a?movie|src_file|filename)\s*=|(file|https?|concat|pipe|subfile|data|tcp|udp|rtp|rtmp|ftp|crypto):/i;

function assertFilters(chain: string | undefined, label: string): string {
  if (!chain) return '';
  if (chain.length > 1000) throw new Error(`The ${label} chain is too long.`);
  if (FILTER_BANNED.test(chain)) {
    throw new Error(`That ${label} chain tries to open an input of its own, which is not allowed.`);
  }
  return chain;
}

export interface OpRequest {
  source?: 'clip' | 'music' | 'url' | 'file';
  clipId?: string;
  url?: string;
  /** A file summoned earlier, as the /media/uploads/… URL fetch or op handed back. */
  file?: string;
  startSec?: number;
  endSec?: number;
  videoFilters?: string;
  audioFilters?: string;
  format?: string;
  /** For a still-image input: how many seconds of video to make from it. */
  stillDurationSec?: number;
}

/** Resolve the request's input to a path on disk, downloading first if it is a URL. */
async function resolveInput(project: store.Project, req: OpRequest): Promise<{ path: string; label: string }> {
  const source = req.source ?? 'clip';

  if (source === 'url') {
    if (!req.url) throw new Error('Provide url when source is "url".');
    const got = await fetchToUploads(req.url, 'any');
    return { path: got.path, label: got.name };
  }

  if (source === 'file') {
    if (!req.file) throw new Error('Provide file when source is "file".');
    return { path: await localUploadPath(req.file), label: basename(req.file) };
  }

  if (source === 'music') {
    if (!project.music) throw new Error('This project has no music bed.');
    return { path: project.music.sourcePath, label: project.music.name };
  }

  const clips = clipsOf(project);
  const clip = req.clipId ? clips.find((c) => c.id === req.clipId) : clips[0];
  if (!clip) throw new Error('No such clip in this project.');
  return { path: clip.sourcePath, label: project.name };
}

/**
 * A /media/uploads/… URL back to a path — a LOOKUP, not a path the model wrote.
 *
 * The basename must be a plain filename and the URL must carry the prefix this
 * server hands out, so nothing outside uploads/ is addressable however the string
 * is spelt (`..%2f`, a UNC path, an absolute path).
 */
async function localUploadPath(mediaUrl: string): Promise<string> {
  const name = basename(mediaUrl);
  if (!mediaUrl.startsWith('/media/uploads/') || !/^[\w.-]+$/.test(name)) {
    throw new Error('That file reference is not one this server produced.');
  }
  const path = join(uploadsDir(), name);
  await stat(path).catch(() => {
    throw new Error('That summoned file is no longer on disk.');
  });
  return path;
}

/**
 * A gif needs its own palette or it comes back as 256 dithered greys, so the
 * model's chain is spliced into a palettegen/paletteuse graph rather than passed
 * as a plain -vf. The fps and width caps ride along: an uncapped gif of a 1080p
 * clip is a 200 MB file nobody wanted.
 */
function gifGraph(userChain: string): string {
  const head = ['fps=12', 'scale=480:-2:flags=lanczos', userChain].filter(Boolean).join(',');
  return `[0:v]${head},split[gsrc][gmap];[gmap]palettegen=stats_mode=diff[pal];[gsrc][pal]paletteuse=dither=bayer[outv]`;
}

export async function runOp(
  project: store.Project,
  req: OpRequest,
): Promise<{ url: string; name: string; kind: MediaKind; bytes: number; durationSec: number }> {
  const key = req.format ?? 'mp4';
  const format = FORMATS[key];
  if (!format) throw new Error(`Unknown format "${key}". Use one of: ${SUMMON_FORMATS.join(', ')}.`);

  const video = assertFilters(req.videoFilters, 'video filter');
  const audio = assertFilters(req.audioFilters, 'audio filter');

  const { path: input, label } = await resolveInput(project, req);
  const info = await probeAny(input);
  // A still has a video stream, no audio, and no duration ffprobe will commit to.
  const isStill = info.hasVideo && !info.hasAudio && info.duration === 0;

  const start = Number.isFinite(req.startSec) ? Math.max(0, req.startSec!) : undefined;
  const end = Number.isFinite(req.endSec) ? Math.max(0, req.endSec!) : undefined;
  const still = Math.min(Math.max(0.5, req.stillDurationSec ?? 4), 60);
  const wanted = isStill ? still : end !== undefined ? end - (start ?? 0) : info.duration - (start ?? 0);
  if (wanted > MAX_OP_SECONDS) {
    throw new Error(
      `That would produce ${Math.round(wanted / 60)} minutes of media, past the ${MAX_OP_SECONDS / 60}-minute cap. Narrow it with start_sec/end_sec.`,
    );
  }

  const id = randomUUID();
  const outName = `summon-${id}${format.ext}`;
  const outPath = join(uploadsDir(), outName);
  const args: string[] = ['-hide_banner', '-loglevel', 'error', '-y'];

  // Seek BEFORE -i: an input seek is a keyframe jump rather than a decode of
  // everything skipped, which is the difference between a gif of second 900
  // taking a second and taking a minute.
  if (start !== undefined && !isStill) args.push('-ss', String(start));
  if (isStill && format.video) args.push('-loop', '1');
  args.push('-i', input);

  // A still on its way to a video container needs a silent track: every route
  // that accepts a clip probes for audio, and one with none is refused there as
  // "nothing to transcribe".
  const needsSilence = isStill && (key === 'mp4' || key === 'webm');
  if (needsSilence) args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo');

  if (isStill) args.push('-t', String(still));
  else if (end !== undefined) args.push('-t', String(Math.max(0.05, end - (start ?? 0))));

  if (key === 'gif') {
    args.push('-filter_complex', gifGraph(video), '-map', '[outv]');
  } else {
    if (video && format.video) args.push('-vf', video);
    if (audio && !isStill) args.push('-af', audio);
    if (needsSilence) args.push('-shortest');
  }

  // A still has no frame rate of its own; without this the encoder picks one and
  // the output's duration is whatever it felt like.
  if (isStill && format.video && key !== 'gif' && key !== 'png' && key !== 'jpg') args.push('-r', '30');
  if (!format.video) args.push('-vn');
  args.push(...format.args, outPath);

  await runToCompletion(CONFIG.ffmpegPath, args);

  const [{ size }, out] = await Promise.all([stat(outPath), probeAny(outPath).catch(() => null)]);
  return {
    url: `/media/uploads/${outName}`,
    name: `${label.replace(/\.[^.]+$/, '')}${format.ext}`,
    kind: format.kind,
    bytes: size,
    durationSec: out?.duration ?? 0,
  };
}

function runToCompletion(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { windowsHide: true });
    let err = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`That operation ran longer than ${OP_TIMEOUT_MS / 1000}s and was stopped.`));
    }, OP_TIMEOUT_MS);

    proc.stderr.on('data', (d) => (err += d));
    proc.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`Could not run ${bin}: ${e.message}`));
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      // ffmpeg's LAST stderr line is the one that says what was wrong with the
      // filtergraph; everything above it is banner noise the model cannot act on.
      const last = err.trim().split('\n').filter(Boolean).pop() ?? `exited ${code}`;
      reject(new Error(last));
    });
  });
}

// ── routes ───────────────────────────────────────────────────────────────────

export function registerSummon(app: Hono): void {
  /** Pull one URL onto disk so the app's own routes can take it from there. */
  app.post('/api/projects/:id/summon/fetch', async (c) => {
    if (!CONFIG.summonEnabled) {
      return c.json({ error: 'Improvising is switched off on this server (SUMMON=off).' }, 403);
    }
    const project = await store.get(c.req.param('id'));
    if (!project) return c.json({ error: 'No such project' }, 404);

    const body = await c.req.json<{ url?: string; accept?: MediaKind }>().catch(() => ({}));
    if (!body.url) return c.json({ error: 'Provide url.' }, 400);
    try {
      const got = await fetchToUploads(body.url, body.accept ?? 'any');
      const info = await probeAny(got.path).catch(() => null);
      return c.json({
        url: got.url,
        name: got.name,
        kind: got.kind,
        bytes: got.bytes,
        durationSec: info?.duration ?? 0,
        hasVideo: info?.hasVideo ?? false,
        hasAudio: info?.hasAudio ?? false,
        width: info?.width,
        height: info?.height,
      });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
    }
  });

  /** One media operation. See the file header for what is and is not allowed. */
  app.post('/api/projects/:id/summon/op', async (c) => {
    if (!CONFIG.summonEnabled) {
      return c.json({ error: 'Improvising is switched off on this server (SUMMON=off).' }, 403);
    }
    const project = await store.get(c.req.param('id'));
    if (!project) return c.json({ error: 'No such project' }, 404);

    const body = await c.req.json<OpRequest>().catch(() => ({}) as OpRequest);
    try {
      return c.json(await runOp(project, body));
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });
}
