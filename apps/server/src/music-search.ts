/**
 * Finding a background-music bed on the web, instead of importing a file.
 *
 * The bed pipeline already existed end to end — `project.music` (store.ts), the
 * volume/length panel, and the ffmpeg mix under the finished program. The only
 * source was a file the user already had. This is the missing one.
 *
 * Everything here runs SERVER-side, and the reason is not CORS (Openverse sends
 * `*`, and Jamendo's CDN reflects the Origin — a browser could call both). It is
 * that the render needs the bytes on disk at `BgMusic.sourcePath`, so the file
 * has to land here regardless; doing the search here too keeps the provider key
 * off the client and makes the rate limit the app's rather than each visitor's.
 *
 * Verified against the live APIs on 2026-07-24 — see PROVIDERS for what each one
 * actually returns and the traps found in doing so.
 */

import { CONFIG } from './config.ts';

/** A search hit, normalised across providers so the client speaks one shape. */
export interface MusicResult {
  /** Provider-scoped, e.g. "jamendo:317391". Only used as a React key. */
  id: string;
  title: string;
  artist: string;
  durationSec: number;
  /** Streamed straight into the preview <audio>. No download, no disk. */
  previewUrl: string;
  /** Fetched to disk when the user picks this track. Usually === previewUrl. */
  downloadUrl: string;
  /** Short code: 'by', 'by-sa', … Drives the badge in the picker. */
  license: string;
  /** The credit line to display and to store on the bed. '' when none is due. */
  attribution: string;
  /** The track's page on the provider, for the credit link. */
  link: string;
  provider: MusicProviderId;
}

export type MusicProviderId = 'openverse' | 'jamendo';

export interface MusicSearchQuery {
  q: string;
  /**
   * Instrumental only. A bed under a voiceover fights any track with a vocal in
   * it, so this is the filter that actually matters — and it is the reason to
   * configure Jamendo, because Openverse cannot express it (see below).
   */
  instrumental?: boolean;
  limit?: number;
}

/**
 * Licences a bed may carry.
 *
 * `nd` (no-derivatives) and `nc` (non-commercial) are BOTH excluded, and neither
 * is pedantry: ducking a track under a voiceover and trimming it to length is a
 * derivative work, and "non-commercial" is a promise this app cannot make on its
 * user's behalf. That leaves CC0/PDM (no credit due) and BY/BY-SA (credit due) —
 * which is why every result carries an `attribution` string and why the bed
 * stores it. Sampling Openverse's music category found ZERO cc0: in practice a
 * web-sourced bed means a credit line, and the UI has to say so.
 */
function licenceAllowed(code: string): boolean {
  const c = code.toLowerCase();
  return !c.includes('nd') && !c.includes('nc');
}

/** Which providers this deployment can actually reach, best first. */
export function availableProviders(): MusicProviderId[] {
  const out: MusicProviderId[] = [];
  // Jamendo leads when configured: real filters, and no 200-a-day ceiling.
  if (CONFIG.jamendoClientId) out.push('jamendo');
  out.push('openverse');
  return out;
}

export async function searchMusic(
  query: MusicSearchQuery,
  provider: MusicProviderId = availableProviders()[0],
): Promise<MusicResult[]> {
  const q = query.q.trim();
  if (!q) return [];
  const limit = Math.min(Math.max(1, query.limit ?? 24), 50);
  const hits = await PROVIDERS[provider]({ ...query, q, limit });
  return hits.filter((r) => licenceAllowed(r.license) && r.durationSec > 0);
}

/**
 * Hosts we will fetch a chosen track from.
 *
 * The import route takes a URL and fetches it server-side, which is an SSRF hole
 * the size of the internal network unless something bounds it. The URL always
 * originates from one of our own search results, so an allowlist costs nothing
 * and closes it — a hand-crafted `http://169.254.169.254/…` never matches.
 */
const MUSIC_HOSTS = [
  'prod-1.storage.jamendo.com',
  'storage-new.newjamendo.com',
  'mp3l.jamendo.com',
  'mp3d.jamendo.com',
  'api.jamendo.com',
  'apis.openverse.engineering',
  'api.openverse.org',
];

export function isAllowedMusicUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  return MUSIC_HOSTS.includes(url.hostname);
}

const PROVIDERS: Record<MusicProviderId, (q: MusicSearchQuery & { limit: number }) => Promise<MusicResult[]>> = {
  /**
   * Openverse — the zero-setup default. No key, no signup, CORS `*`.
   *
   * The catch, measured rather than assumed: anonymous callers get 20 requests a
   * minute and 200 a DAY (the `x-ratelimit-*` response headers say so), and its
   * music category is essentially a mirror of Jamendo with a thinner index —
   * `?q=lofi&license=by&category=music` returned exactly one result. Good enough
   * that the feature works on a fresh clone; thin enough that JAMENDO_CLIENT_ID
   * is worth setting.
   *
   * It also has no instrumental filter, so `instrumental` degrades to a keyword.
   */
  async openverse(query) {
    const url = new URL('https://api.openverse.org/v1/audio/');
    url.searchParams.set('q', query.instrumental ? `${query.q} instrumental` : query.q);
    url.searchParams.set('category', 'music');
    // Pre-filter server-side too, so the page budget is not spent on hits that
    // licenceAllowed would drop anyway.
    url.searchParams.set('license', 'by,by-sa,cc0,pdm');
    // 20 is a hard anonymous ceiling, and asking for 21 does not clamp — it
    // fails, with a **401**, whose body says "page_size may not exceed 20 for
    // anonymous requests". A 401 reads as "bad credentials" and sends you
    // hunting for a key that this provider does not even use, so the number is
    // pinned here rather than trusted to the caller's limit.
    url.searchParams.set('page_size', String(Math.min(query.limit, OPENVERSE_ANON_PAGE_MAX)));

    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) {
      if (res.status === 429) {
        throw new Error(
          'Openverse is rate-limiting this app (200 searches a day without a key). Try again later, or set JAMENDO_CLIENT_ID.',
        );
      }
      // Surface their `detail` — it is specific where the status code is not.
      const detail = await res
        .json()
        .then((b: { detail?: string }) => b?.detail)
        .catch(() => undefined);
      throw new Error(`Openverse search failed (${res.status})${detail ? `: ${detail}` : '.'}`);
    }
    const data = (await res.json()) as { results?: OpenverseAudio[] };

    return (data.results ?? []).flatMap((r) => {
      if (!r.url) return [];
      return [{
        id: `openverse:${r.id}`,
        title: r.title || 'Untitled',
        artist: r.creator || 'Unknown',
        // Openverse reports MILLISECONDS. Jamendo reports seconds. Normalising
        // here is the whole reason this function exists.
        durationSec: Math.round((r.duration ?? 0) / 1000),
        previewUrl: r.url,
        downloadUrl: r.url,
        license: r.license ?? '',
        attribution: r.attribution ?? '',
        link: r.foreign_landing_url ?? '',
        provider: 'openverse' as const,
      }];
    });
  },

  /**
   * Jamendo — the one worth configuring. Free client_id from devportal.jamendo.com.
   *
   * Two traps, both hit while verifying:
   *
   * 1. It answers HTTP **200** on an invalid client_id, with the failure only in
   *    `headers.status`. Checking `res.ok` alone silently yields zero results and
   *    reads as "nothing matched" rather than "your key is wrong".
   * 2. `audiodownload_allowed` is per-artist — some tracks may be streamed but
   *    not downloaded, and the bed needs a real file. We ask for the stream URL
   *    (`audio`), which is always present, rather than depending on it.
   *
   * Licence is filtered from `license_ccurl` (via `include=licenses`) instead of
   * a query param, so the rule lives in one place — licenceAllowed — and cannot
   * drift from what the badge claims.
   */
  async jamendo(query) {
    if (!CONFIG.jamendoClientId) {
      throw new Error('Jamendo search needs JAMENDO_CLIENT_ID on the server.');
    }
    const url = new URL('https://api.jamendo.com/v3.0/tracks/');
    url.searchParams.set('client_id', CONFIG.jamendoClientId);
    url.searchParams.set('format', 'json');
    url.searchParams.set('limit', String(query.limit));
    url.searchParams.set('search', query.q);
    url.searchParams.set('include', 'licenses musicinfo');
    url.searchParams.set('audioformat', 'mp32');
    url.searchParams.set('order', 'popularity_total');
    // The filter Openverse cannot express, and the reason to configure this.
    if (query.instrumental) url.searchParams.set('vocalinstrumental', 'instrumental');

    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) throw new Error(`Jamendo search failed (${res.status}).`);
    const data = (await res.json()) as JamendoResponse;

    // Trap 1. A 200 with status:"failed" is the shape of a bad key.
    if (data.headers?.status !== 'success') {
      throw new Error(data.headers?.error_message || 'Jamendo rejected the search.');
    }

    return (data.results ?? []).flatMap((t) => {
      const stream = t.audio || t.audiodownload;
      if (!stream) return [];
      const license = licenceCodeFromUrl(t.license_ccurl);
      return [{
        id: `jamendo:${t.id}`,
        title: t.name || 'Untitled',
        artist: t.artist_name || 'Unknown',
        durationSec: Number(t.duration) || 0,
        previewUrl: stream,
        downloadUrl: stream,
        license,
        attribution: license && license !== 'cc0'
          ? `"${t.name}" by ${t.artist_name} is licensed under CC ${license.toUpperCase()}. ${t.license_ccurl ?? ''}`.trim()
          : '',
        link: t.shareurl || `https://www.jamendo.com/track/${t.id}`,
        provider: 'jamendo' as const,
      }];
    });
  },
};

/**
 * "https://creativecommons.org/licenses/by-sa/3.0/" -> "by-sa".
 *
 * Returns '' for an unrecognised or missing URL, and '' fails licenceAllowed's
 * sibling check by being unbadgeable — but NOT by being filtered out, since an
 * empty code contains neither 'nd' nor 'nc'. That is deliberate: Jamendo tracks
 * without a parseable CC url are its own "all rights reserved" catalogue, which
 * the `search` endpoint does not return. If that ever changes this is where to
 * tighten it.
 */
function licenceCodeFromUrl(url: string | undefined): string {
  if (!url) return '';
  const m = /creativecommons\.org\/(?:licenses|publicdomain)\/([a-z0-9-]+)\//i.exec(url);
  if (!m) return '';
  return m[1].toLowerCase() === 'zero' ? 'cc0' : m[1].toLowerCase();
}

/** Both APIs are public goods run on donations. Identify the caller. */
const USER_AGENT = 'descript-clone/0.1 (background music picker)';

/** See the openverse provider — exceeding it is a 401, not a clamp. */
const OPENVERSE_ANON_PAGE_MAX = 20;

interface OpenverseAudio {
  id: string;
  title?: string;
  creator?: string;
  url?: string;
  license?: string;
  attribution?: string;
  /** MILLISECONDS, unlike Jamendo's seconds. */
  duration?: number;
  foreign_landing_url?: string;
}

interface JamendoResponse {
  headers?: { status?: string; error_message?: string };
  results?: JamendoTrack[];
}

interface JamendoTrack {
  id: string;
  name?: string;
  artist_name?: string;
  /** SECONDS, unlike Openverse's milliseconds. */
  duration?: number | string;
  audio?: string;
  audiodownload?: string;
  license_ccurl?: string;
  shareurl?: string;
}

/**
 * Download a chosen track to `dest`, refusing anything too big.
 *
 * Streamed rather than buffered, and capped as the bytes arrive: the file upload
 * route can trust `content-length` because it holds a real File, but a remote
 * server's header is a claim, not a fact. Counting what actually lands is the
 * difference between a rejected request and a filled disk.
 *
 * Returns the extension the content-type implies — the Jamendo CDN URL carries
 * none at all ("?trackid=…&format=mp32"), so deriving it from the path yields "".
 */
export async function downloadMusic(
  url: string,
  dest: string,
  maxBytes = CONFIG.maxUploadBytes,
): Promise<{ bytes: number; ext: string }> {
  const { createWriteStream } = await import('node:fs');
  const { unlink } = await import('node:fs/promises');
  const { pipeline } = await import('node:stream/promises');
  const { Readable, Transform } = await import('node:stream');

  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok || !res.body) throw new Error(`Could not fetch that track (${res.status}).`);

  const type = (res.headers.get('content-type') ?? '').split(';')[0].trim();
  if (type && !type.startsWith('audio/') && type !== 'application/octet-stream') {
    throw new Error(`That URL served ${type}, not audio.`);
  }

  let bytes = 0;
  const cap = new Transform({
    transform(chunk, _enc, cb) {
      bytes += chunk.length;
      if (bytes > maxBytes) return cb(new Error(`That track is larger than the ${Math.round(maxBytes / 1024 / 1024)} MB limit.`));
      cb(null, chunk);
    },
  });

  try {
    await pipeline(Readable.fromWeb(res.body as never), cap, createWriteStream(dest));
  } catch (e) {
    await unlink(dest).catch(() => {});
    throw e;
  }

  return { bytes, ext: EXT_BY_TYPE[type] ?? '.mp3' };
}

const EXT_BY_TYPE: Record<string, string> = {
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/ogg': '.ogg',
  'audio/vorbis': '.ogg',
  'audio/flac': '.flac',
  'audio/x-flac': '.flac',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/mp4': '.m4a',
  'audio/aac': '.m4a',
};
