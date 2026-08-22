import type { Hono } from 'hono';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rename, unlink, stat, readdir, copyFile, realpath } from 'node:fs/promises';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { join, extname, basename, resolve, relative, isAbsolute } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';

import { CONFIG } from './config.ts';
import { displaySize } from './ffmpeg.ts';
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
 *   POST /api/local/grant                 allow a folder the user named in chat
 *   GET  /api/local/media                 list media in a granted folder
 *   POST /api/projects/:id/summon/local   copy one file out of a granted folder
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
 * SUMMON=off removes the fetch and op routes; the assistant then reports that
 * improvising is switched off rather than failing in a way it cannot explain.
 *
 * The three LOCAL routes are not on that switch, because they are governed by
 * something stricter: they do nothing at all until the user has named a folder
 * in the chat, and an env var cannot grant what only a user can. See the
 * "reading media off this machine's disk" section below.
 */

/** Where summoned bytes land. The same directory imports use, so /media serves them. */
const uploadsDir = () => join(CONFIG.mediaDir, 'uploads');

/**
 * How long one ffmpeg operation may run before it is killed.
 *
 * Configurable because the same code runs on very different machines: a laptop
 * encodes a 30-second clip in a few seconds, an arm64 phone doing software x264
 * takes minutes for the same work (see desktop/android/README.md). A fixed
 * desktop-shaped cap would turn every phone operation into a timeout, so the
 * Android shell raises it — SUMMON_OP_TIMEOUT_S, set in NodeRuntime.kt.
 */
const OP_TIMEOUT_MS = CONFIG.summonOpTimeoutMs;
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
export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('That is not a valid URL.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Only http and https URLs can be fetched.');
  }

  // lookup(), NOT resolve4/resolve6: lookup goes through the platform's
  // getaddrinfo, and resolve* goes through c-ares, which reads /etc/resolv.conf —
  // a file Android does not have. On a phone every resolve() call fails with
  // ESERVFAIL, so every fetch would be refused as unresolvable. Keep it lookup.
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

// ── reading media off this machine's disk ────────────────────────────────────
//
// The third way a file can get in, after "the user picked it" and "it came off
// the web". The user names a folder IN THE CHAT — "the footage is in D:\shoot" —
// and from then on the assistant may browse and import within it, and nowhere
// else. There is no settings pane and nothing on disk: a grant lasts as long as
// the server process, because the conversation that created it does too.
//
// ── why the grant is safe to take from a chat message ───────────────────────
//
// It would not be, taken naively. The model is the one that calls grantFolder(),
// and the model reads TRANSCRIPTS — text that came from whatever media the user
// happened to import, which is to say text an attacker may have written. A model
// that can be talked into granting itself C:\Users\someone is a model with no
// boundary at all.
//
// So a grant needs TWO things that only ever come from different places: the
// path (from the model, untrusted) and the user's own messages (from the
// browser, which is the only component that knows what was actually typed). The
// model's path is honoured only if the user's own words resolve to it. A path it
// invented, inferred, or read out of a transcript resolves to nothing.
//
// ── deciding where a typed path ends ────────────────────────────────────────
//
// "grab from C:\Video Work\raw please" is a real sentence and that is a real
// folder, so refusing it would be a bug the user is right to complain about. But
// nothing about the SYNTAX says where the path stops — `C:\Video`, `C:\Video
// Work` and `C:\Video Work\raw` are all readings, and the first two are broader
// folders the user did not mean. Guessing between them by punctuation is exactly
// how a prefix gets granted.
//
// The filesystem is not guessing. Each run of words starting at something
// path-shaped is tried against the disk, longest first, and the LONGEST ONE THAT
// IS ACTUALLY A DIRECTORY is what the user meant. `C:\Video Work\raw please` is
// not a directory; `C:\Video Work\raw` is. That also disposes of the prefix
// problem in the same stroke: a prefix is never the longest match, so it is
// never what a message resolves to, and asking for one is refused.
//
// Two guards then do the rest, and they are separate on purpose:
//
//  - CONTAINMENT. Every candidate is realpath'd and compared against realpath'd
//    grants, so `..`, an absolute path, a UNC path and a symlink planted inside
//    a granted folder all land outside and are refused. Real path against real
//    path is the part that matters: comparing the strings as given would let a
//    symlink in ~/Movies point at ~/.ssh and pass.
//  - TYPE. Extension must be media AND ffprobe must agree, so a document renamed
//    to .mp4 is rejected before anything can attach it. The extension check
//    alone would be a filename convention, not a control.
//
// What this deliberately is NOT is general file reading. There is no route here
// that returns a file's BYTES to the model — an import copies media into
// uploads/ and hands back a URL, and the model only ever sees names, sizes and
// durations. A transcript is attacker-influenceable text, so the assistant
// reading one must not become a way to read anything else.

/**
 * Folders granted this session, resolved. In memory only, and deliberately so:
 * a grant that outlived the conversation would be a permission the user granted
 * in passing and can no longer see to revoke.
 */
const grants = new Set<string>();

/** How many words a path may span. Long enough for "C:\My Great Big Video Folder". */
const MAX_SPAN_WORDS = 12;
/** A ceiling on stat() calls per grant, so a long chat cannot turn into a disk scan. */
const MAX_PROBES = 400;

/** Compare paths the way a person writes them: separators and case are noise. */
const normalizePath = (s: string): string =>
  s.trim().replace(/^["'`]+|["'`]+$/g, '').replace(/[,.;:!?]+$/, '')
    .replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();

/** Could this word begin a path? `/x`, `C:\x`, `\\server\x`, `~/x`. */
const looksLikeRoot = (w: string): boolean => /^([A-Za-z]:[\\/]|[\\/]|~[\\/])/.test(w);

/** Resolved directory, or null. The single question the filesystem answers here. */
async function asDirectory(candidate: string): Promise<string | null> {
  const path = candidate.trim().replace(/^["'`]+|["'`]+$/g, '').replace(/[,.;:!?]+$/, '');
  if (!path || !isAbsolute(path)) return null;
  try {
    const real = await realpath(resolve(path));
    return (await stat(real)).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

/**
 * Every folder the user's own messages actually name, resolved against the disk.
 *
 * A quoted span or a line that is nothing but a path is unambiguous and tried as
 * written. Otherwise each word that looks like a root starts a run, and the run
 * is extended word by word — the longest one that IS a directory wins, so a path
 * with spaces resolves and none of its prefixes ever does.
 */
async function foldersNamedIn(said: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  let probes = 0;

  for (const message of said) {
    for (const line of message.split('\n')) {
      // Unambiguous shapes first: the whole line, and anything in quotes.
      const explicit = [line, ...[...line.matchAll(/["'`]([^"'`\n]+)["'`]/g)].map((m) => m[1])];
      for (const c of explicit) {
        if (probes++ > MAX_PROBES) return found;
        const dir = await asDirectory(c);
        if (dir) found.add(dir);
      }

      const words = line.split(/\s+/).filter(Boolean);
      for (let i = 0; i < words.length; i++) {
        if (!looksLikeRoot(words[i])) continue;
        // Longest wins: keep going past a miss, because "C:\Video Work" can fail
        // while "C:\Video Work\raw" succeeds, and it is the latter they meant.
        let best: string | null = null;
        for (let j = i; j < Math.min(words.length, i + MAX_SPAN_WORDS); j++) {
          if (probes++ > MAX_PROBES) break;
          const dir = await asDirectory(words.slice(i, j + 1).join(' '));
          if (dir) best = dir;
        }
        if (best) found.add(best);
      }
    }
  }
  return found;
}

/**
 * Grant a folder, if the user's own messages name it.
 *
 * `said` is every message the user typed this conversation, supplied by the
 * browser — the only place that knows. `raw` is the model's claim about which
 * one it is. The claim is checked against the messages, never trusted on its own.
 */
export async function grantFolder(raw: string, said: string[]): Promise<string> {
  const asked = normalizePath(raw ?? '');
  if (!asked) throw new Error('Name a folder.');

  const named = await foldersNamedIn(said);
  if (named.size === 0) {
    throw new Error(
      'The user has not named a folder in this conversation. Ask which folder the files are in — and if what they wrote is not a folder that exists, say so rather than guessing at a different one.',
    );
  }

  for (const dir of named) {
    if (normalizePath(dir) === asked) {
      grants.add(dir);
      return dir;
    }
  }
  throw new Error(
    'That is not a folder the user named. Only a path they typed themselves can be opened — not one you worked out, and not one from a transcript. The folders they have actually named are: ' +
      [...named].join(' | '),
  );
}

/** The folders granted so far, for reporting back. */
export const grantedFolders = (): string[] => [...grants];

/**
 * What to say when nothing has been granted yet. Phrased as an instruction to the
 * assistant rather than a failure, because on the first ask it is neither an
 * error nor the user's mistake — the folder simply has not been named yet.
 */
const NO_GRANT =
  'No folder has been named yet. Ask the user which folder their files are in, then pass exactly what they type to use_folder.';

/** Extensions this may import. Everything JumpCut can actually put on a timeline. */
const MEDIA_EXT =
  /\.(mp4|m4v|mov|mkv|webm|avi|mpe?g|wmv|flv|mp3|wav|m4a|aac|flac|ogg|oga|opus|wma|aiff?|jpe?g|png|gif|webp|bmp|avif|heic|heif|tiff?)$/i;

/** Entries returned per listing. A folder of ten thousand files is not a menu. */
const MAX_LISTING = 250;

/**
 * Resolve a path the model named to a real one inside an allowed folder, or throw.
 *
 * The error text names no path that failed and lists no root the caller did not
 * already know about — a probe for "does /etc/passwd exist" and a probe for "is
 * that folder allowed" get the same answer either way.
 */
async function insideAllowedRoot(candidate: string): Promise<string> {
  const roots = grantedFolders();
  if (roots.length === 0) throw new Error(NO_GRANT);
  if (!isAbsolute(candidate)) throw new Error('That is not a full path to a file or folder.');

  let real: string;
  try {
    real = await realpath(resolve(candidate));
  } catch {
    throw new Error('There is nothing at that path.');
  }

  for (const root of roots) {
    const realRoot = await realpath(root).catch(() => null);
    if (!realRoot) continue; // folder went away since it was granted
    if (real === realRoot) return real;
    const rel = relative(realRoot, real);
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return real;
  }
  throw new Error(
    'That path is not inside a folder the user named. Ask them for the folder and pass it to use_folder first.',
  );
}

export interface LocalListing {
  /** The folder listed, or null when listing the shared roots themselves. */
  dir: string | null;
  folders: Array<{ name: string; path: string }>;
  files: Array<{ name: string; path: string; bytes: number }>;
  /** True when the folder held more than MAX_LISTING of either kind. */
  truncated: boolean;
}

/** Browse the shared folders. No `dir` lists the roots; a `dir` lists inside one. */
export async function listLocalMedia(dir?: string): Promise<LocalListing> {
  if (!dir) {
    const roots = grantedFolders();
    if (roots.length === 0) throw new Error(NO_GRANT);
    return { dir: null, folders: roots.map((p) => ({ name: p, path: p })), files: [], truncated: false };
  }

  const real = await insideAllowedRoot(dir);
  let entries;
  try {
    entries = await readdir(real, { withFileTypes: true });
  } catch {
    throw new Error('That folder could not be read.');
  }

  const folders: LocalListing['folders'] = [];
  const files: LocalListing['files'] = [];
  let truncated = false;

  for (const entry of entries) {
    // Dotfiles are configuration and caches, never someone's footage, and
    // listing them is noise at best and a hint at worst.
    if (entry.name.startsWith('.')) continue;
    const path = join(real, entry.name);
    if (entry.isDirectory()) {
      if (folders.length >= MAX_LISTING) { truncated = true; continue; }
      folders.push({ name: entry.name, path });
    } else if (entry.isFile() && MEDIA_EXT.test(entry.name)) {
      if (files.length >= MAX_LISTING) { truncated = true; continue; }
      // A file that vanished between readdir and stat is simply not listed.
      const bytes = await stat(path).then((s) => s.size).catch(() => null);
      if (bytes !== null) files.push({ name: entry.name, path, bytes });
    }
  }

  folders.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));
  return { dir: real, folders, files, truncated };
}

/**
 * Copy one file from a shared folder into uploads/, so the rest of the app can
 * treat it exactly like an upload.
 *
 * COPY rather than reference-in-place, which is the same decision the fetch path
 * makes: a project that points at ~/Downloads breaks the day the user tidies up,
 * and a project's media living outside the media directory breaks export, /media
 * serving, and every assumption store.ts makes about where bytes are.
 */
export async function importFromDisk(
  candidate: string,
): Promise<{ id: string; path: string; url: string; name: string; kind: MediaKind; bytes: number }> {
  const real = await insideAllowedRoot(candidate);

  const info = await stat(real);
  if (!info.isFile()) throw new Error('That is a folder, not a file.');
  if (!MEDIA_EXT.test(real)) {
    throw new Error('That is not a video, audio or image file, so it cannot be imported.');
  }
  if (info.size === 0) throw new Error('That file is empty.');
  if (info.size > CONFIG.maxUploadBytes) {
    throw new Error(`That file is larger than the ${Math.round(CONFIG.maxUploadBytes / 1048576)} MB import limit.`);
  }

  const name = basename(real);
  const ext = extname(real).toLowerCase();
  const id = randomUUID();
  const path = join(uploadsDir(), `${id}${ext}`);
  await copyFile(real, path);

  // The extension said it was media; ffprobe is what actually knows. A file that
  // fails here is removed rather than left in uploads/ as a half-import.
  const probed = await probeAny(path).catch(() => null);
  if (!probed || (!probed.hasVideo && !probed.hasAudio)) {
    await unlink(path).catch(() => {});
    throw new Error(`"${name}" is not media this app can read, whatever its extension says.`);
  }

  // Kind comes from what ffprobe found, not from the extension — the same test
  // runOp uses for a still (a video stream, no audio, no duration ffprobe will
  // commit to). Extension-guessing would call a .heic an "audio" file.
  const kind: MediaKind = !probed.hasVideo
    ? 'audio'
    : !probed.hasAudio && probed.duration === 0
      ? 'image'
      : 'video';

  return { id, path, url: `/media/uploads/${id}${ext}`, name, kind, bytes: info.size };
}

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
    streams?: Array<{
      codec_type?: string;
      width?: number;
      height?: number;
      side_data_list?: Array<{ rotation?: number }>;
      tags?: { rotate?: string };
    }>;
  };
  const video = data.streams?.find((s) => s.codec_type === 'video');
  const audio = data.streams?.find((s) => s.codec_type === 'audio');

  // This probe exists separately from ffmpeg.ts's only because that one THROWS
  // on media with no audio track, which a summoned file may legitimately be.
  // The rotation rule is the same either way: a vertical clip pulled off a URL
  // or out of a granted folder is stored landscape with a Display Matrix, and
  // reporting the stored numbers describes it as landscape to the assistant.
  const { width, height } = displaySize(video);

  return {
    duration: Number(data.format?.duration ?? 0) || 0,
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    width,
    height,
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

/** Output containers the model may ask for. What each costs is settled below. */
export const SUMMON_FORMATS = ['mp4', 'webm', 'gif', 'mp3', 'wav', 'png', 'jpg'];

interface Recipe {
  ext: string;
  args: string[];
  kind: MediaKind;
  video: boolean;
  /** Set when the container asked for was not the one this build can produce. */
  substituted?: string;
}

/**
 * What THIS machine's ffmpeg can actually encode.
 *
 * Everywhere else the product needs exactly three things — x264, AAC and libass
 * — and every build it runs on has them, including the phone binary (see
 * desktop/android/third_party/ffmpeg/build-ffmpeg-android.sh). This file is the
 * only one that reaches past that set, so it is the only one that has to ASK
 * instead of assume. The Android ffmpeg is configured without libmp3lame,
 * libvpx and libopus — three external libraries, cross-compiled, to widen an
 * escape hatch — and a minimal container image may be missing them too.
 *
 * Asked once per process and cached: `-encoders` costs about thirty
 * milliseconds and the answer cannot change while the binary stays put.
 */
let encoderCache: Promise<Set<string>> | null = null;
function encoders(): Promise<Set<string>> {
  encoderCache ??= runCapture(CONFIG.ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-encoders'])
    .then(parseEncoders)
    // A binary that cannot even list its encoders will fail the real call too,
    // with a message about the actual operation rather than about probing.
    .catch(() => new Set<string>());
  return encoderCache;
}

/**
 * Encoder names out of `ffmpeg -encoders`.
 *
 * Each row is six flag characters and then the name. The legend rows above the
 * list have the same shape but an `=` where the name goes, which is why the
 * name has to start with an identifier character.
 */
export function parseEncoders(listing: string): Set<string> {
  return new Set([...listing.matchAll(/^\s*[A-Z.]{6}\s+([A-Za-z0-9_][^\s]*)/gm)].map((m) => m[1]));
}

const H264 = ['-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p'];
const MP4_TAIL = ['-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart'];

/**
 * The container the model asked for, resolved against the codecs that exist.
 *
 * Substitution rather than refusal: someone who asked for "just the audio as an
 * mp3" is asking for an audio file, and handing them an m4a is the request
 * honoured. Handing them an error about libmp3lame is not. What did happen is
 * reported back through `substituted`, so the assistant says "m4a, this build
 * has no mp3 encoder" instead of quietly renaming the format.
 */
export function recipeFor(key: string, have: Set<string>): Recipe {
  const has = (...names: string[]) => names.find((n) => have.has(n));

  // -preset and -crf are libx264's own options; the mpeg4 fallback has neither,
  // and passing them leaves ffmpeg warning about options it never used.
  const mp4 = (): Recipe => {
    const v = has('libx264');
    return {
      ext: '.mp4', kind: 'video', video: true,
      args: v ? ['-c:v', v, ...H264, ...MP4_TAIL] : ['-c:v', 'mpeg4', '-q:v', '4', '-pix_fmt', 'yuv420p', ...MP4_TAIL],
    };
  };

  switch (key) {
    case 'mp4':
      return mp4();

    case 'webm': {
      // vp9 and vp8 are the only codecs a .webm may legally carry; with neither
      // there is no degraded webm to make, only a different container.
      // libopus only, never ffmpeg's native `opus`: that one is marked
      // experimental and refuses to run without -strict -2.
      const v = has('libvpx-vp9', 'libvpx');
      const a = has('libopus');
      if (!v || !a) return { ...mp4(), substituted: 'mp4 (this build has no VP9/Opus encoder)' };
      return { ext: '.webm', kind: 'video', video: true, args: ['-c:v', v, '-crf', '32', '-b:v', '0', '-c:a', a] };
    }

    case 'gif':
      return { ext: '.gif', kind: 'image', video: true, args: [] }; // built by gifGraph below

    case 'mp3': {
      // ffmpeg has no native mp3 encoder — it is libmp3lame or libshine or
      // nothing — so the fallback is a different container, not a different flag.
      const a = has('libmp3lame', 'libshine');
      if (!a) {
        return {
          ext: '.m4a', kind: 'audio', video: false,
          args: ['-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart'],
          substituted: 'm4a (this build has no mp3 encoder)',
        };
      }
      return { ext: '.mp3', kind: 'audio', video: false, args: ['-c:a', a, '-q:a', '2'] };
    }

    case 'wav':
      return { ext: '.wav', kind: 'audio', video: false, args: ['-c:a', 'pcm_s16le'] };
    case 'png':
      return { ext: '.png', kind: 'image', video: true, args: ['-frames:v', '1'] };
    case 'jpg':
      return { ext: '.jpg', kind: 'image', video: true, args: ['-frames:v', '1', '-q:v', '3'] };

    default:
      throw new Error(`Unknown format "${key}". Use one of: ${SUMMON_FORMATS.join(', ')}.`);
  }
}

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
): Promise<{
  url: string;
  name: string;
  kind: MediaKind;
  bytes: number;
  durationSec: number;
  substituted?: string;
}> {
  const key = req.format ?? 'mp4';
  const format = recipeFor(key, await encoders());

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
  //
  // The silence comes from anullsrc as a FILTER SOURCE inside -filter_complex,
  // not from `-f lavfi -i anullsrc`. Those look interchangeable and are not:
  // `-f lavfi` is an input DEVICE, it lives in libavdevice, and the Android
  // binary is configured --disable-avdevice. The filter source is libavfilter,
  // which every build has. Same silence, one library less to depend on.
  const needsSilence = isStill && (key === 'mp4' || key === 'webm') && format.video;

  if (isStill) args.push('-t', String(still));
  else if (end !== undefined) args.push('-t', String(Math.max(0.05, end - (start ?? 0))));

  if (key === 'gif') {
    args.push('-filter_complex', gifGraph(video), '-map', '[outv]');
  } else if (needsSilence) {
    args.push(
      '-filter_complex',
      `[0:v]${video || 'null'}[outv];anullsrc=r=48000:cl=stereo[outa]`,
      '-map', '[outv]', '-map', '[outa]',
    );
  } else {
    if (video && format.video) args.push('-vf', video);
    if (audio && !isStill) args.push('-af', audio);
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
    substituted: format.substituted,
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

  /**
   * Grant one folder for this session.
   *
   * `said` is every message the USER typed this conversation; `path` is the
   * model's claim about which folder they meant. Both are required, because one
   * without the other is either a path nobody authorised or an authorisation
   * with no path. See grantFolder.
   */
  app.post('/api/local/grant', async (c) => {
    const body = await c.req.json<{ path?: string; said?: unknown }>().catch(() => ({}));
    if (!body.path) return c.json({ error: 'Provide path.' }, 400);
    const said = Array.isArray(body.said) ? body.said.filter((s): s is string => typeof s === 'string') : [];
    try {
      const granted = await grantFolder(body.path, said);
      return c.json({ granted, folders: grantedFolders() });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  /**
   * Browse the folders the user named. Not project-scoped — it reads nothing of
   * the project — and it returns names and sizes only, never a file's contents.
   */
  app.get('/api/local/media', async (c) => {
    try {
      return c.json(await listLocalMedia(c.req.query('dir') || undefined));
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  /**
   * Copy one file out of a shared folder into uploads/, returning the same shape
   * `fetch` does — so the browser attaches it through the identical path and no
   * attach logic gains a third case.
   */
  app.post('/api/projects/:id/summon/local', async (c) => {
    const project = await store.get(c.req.param('id'));
    if (!project) return c.json({ error: 'No such project' }, 404);

    const body = await c.req.json<{ path?: string }>().catch(() => ({}));
    if (!body.path) return c.json({ error: 'Provide path.' }, 400);
    try {
      const got = await importFromDisk(body.path);
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
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
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
