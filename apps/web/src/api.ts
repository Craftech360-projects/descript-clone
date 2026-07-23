import type { CaptionSettings } from '../../../packages/core/src/caption-style.ts';
import type { Transcript } from '../../../packages/core/src/types.ts';

/** Filmstrip sheets. Mirrors the server's `Thumbs` — see apps/server/src/thumbs.ts. */
export interface Thumbs {
  /** Seconds between frames. The tile for time t is at index floor(t / interval). */
  interval: number;
  cols: number;
  rows: number;
  tileW: number;
  tileH: number;
  /** Real tiles; the final sheet is black-padded beyond this. */
  count: number;
  sheets: string[];
}

export interface Project {
  id: string;
  name: string;
  sourceUrl: string;
  duration: number;
  hasVideo: boolean;
  width?: number;
  height?: number;
  /** e.g. 59.94. Absent on audio, and on projects imported before fps was read. */
  fps?: number;
  status: 'imported' | 'transcribed';
  transcript: Transcript | null;
  asrProvider: string | null;
  verbatim: boolean;
  peaks: number[];
  /**
   * The source clips, in play order. Absent on single-source projects (every
   * project today): read them through `clipsOf`, which derives one clip from the
   * flat `sourceUrl`/`duration`/`peaks`/`thumbs` fields above when this is unset.
   */
  clips?: StoredClip[];
  /** Absent on audio, and on video whose filmstrip has not been built yet. */
  thumbs?: Thumbs;
  /** Caption look and placement. Absent on projects saved before captions existed. */
  captions?: CaptionSettings;
  /** Output speed multiplier. Absent on projects saved before speed existed. */
  speed?: number;
  /** Cut settings, wire shape (maxGapMs 0 = keep every pause). Absent on projects
   *  saved before cut settings were persisted; the client falls back to defaults. */
  cut?: CutSettings;
  /** The background-music bed, if one has been imported. Absent otherwise. */
  music?: ProjectMusic;
  createdAt: string;
}

/**
 * A project's background-music bed. Mirrors the server's `BgMusic` (store.ts),
 * minus the server-only disk path.
 *
 * `sourceUrl` feeds the preview <audio>; `sourceDuration` bounds the length
 * control; `volume`/`durationSec` are the two things the panel tunes. The render
 * mixes this UNDER the finished program, so it is never cut with the words.
 */
export interface ProjectMusic {
  id: string;
  name: string;
  sourceUrl: string;
  sourceDuration: number;
  volume: number;
  /** Length cap in OUTPUT seconds; absent = plays under the whole program. */
  durationSec?: number;
  /** Loop the track to fill its length — how a short song covers a long video. */
  loop?: boolean;
}

/**
 * One source file in a project's sequence.
 *
 * A project is on its way from "one media file" to "an ordered sequence of clips
 * laid end to end". A Clip is what a single-source project always was — its own
 * media, waveform, and filmstrip — plus where it starts on the project's global
 * timeline. `sourceUrl`/`duration`/`peaks`/`thumbs` are per-clip because a clip
 * addresses its OWN file's timeline, exactly as Word.start/end always have.
 */
export interface Clip {
  id: string;
  sourceUrl: string;
  duration: number;
  hasVideo: boolean;
  width?: number;
  height?: number;
  fps?: number;
  peaks: number[];
  thumbs?: Thumbs;
  /** Seconds this clip begins at on the project timeline: Σ of prior durations. */
  offset: number;
  /**
   * Where this clip begins in its OWN source file, in seconds (≡ 0 when absent).
   * Whole-file clips have none; splitting a clip makes two that share one file,
   * the second starting partway in. The <video> element addresses the file, so
   * the file time showing global `t` is `sourceStart + (t − offset)`. See
   * clipLocalTime / clipGlobalTime.
   */
  sourceStart?: number;
}

/** The element (file) time that shows global timeline time `t` for this clip. */
export function clipLocalTime(clip: Clip, t: number): number {
  return (clip.sourceStart ?? 0) + (t - clip.offset);
}

/** The global timeline time shown when this clip's element is at `videoTime`. */
export function clipGlobalTime(clip: Clip, videoTime: number): number {
  return clip.offset + (videoTime - (clip.sourceStart ?? 0));
}

/**
 * A clip on the wire/disk. `offset` is derived from the ordering, never stored —
 * so a reorder is a list move, not an N-clip rewrite. `clipsOf` fills it in.
 */
export type StoredClip = Omit<Clip, 'offset'>;

export type MediaItem = Omit<Project, 'peaks' | 'transcript' | 'thumbs'>;

/**
 * The project's clips, in order, each with its computed timeline offset.
 *
 * The one seam every "the media is project.sourceUrl/.peaks/.thumbs" read should
 * move behind, so the single-source path and the multi-clip path become one.
 * Projects saved before clips existed carry no `clips` array; they read as
 * exactly one clip derived from the flat fields — so this is total, and an old
 * project is indistinguishable from a genuine one-clip project. Offsets are
 * always recomputed here from durations, so a stored clip never has to keep its
 * own offset in sync.
 */
export function clipsOf(project: Project): Clip[] {
  const raw: StoredClip[] = project.clips ?? [singleClipFrom(project)];
  let offset = 0;
  return raw.map((c) => {
    const withOffset: Clip = { ...c, offset };
    offset += c.duration;
    return withOffset;
  });
}

/** Total project timeline length: the sum of every clip's duration. */
export function projectDuration(project: Project): number {
  return (project.clips ?? [singleClipFrom(project)]).reduce((sum, c) => sum + c.duration, 0);
}

/** The flat single-source fields, read as the one clip an old project holds. */
function singleClipFrom(p: Project): StoredClip {
  return {
    id: p.id,
    sourceUrl: p.sourceUrl,
    duration: p.duration,
    hasVideo: p.hasVideo,
    width: p.width,
    height: p.height,
    fps: p.fps,
    peaks: p.peaks,
    thumbs: p.thumbs,
  };
}

export interface AsrOptions {
  model: string;
  language: string;
  speakers: number;
  diarize: boolean;
  verbatim: boolean;
}

/** Every knob in the Cuts panel. */
export interface CutSettings {
  padMs: number;
  fadeMs: number;
  mergeWithinMs: number;
  /** 0 = keep every pause. */
  maxGapMs: number;
}

/**
 * An imported caption font. Mirrors the server's `CustomFont` (fonts.ts).
 *
 * `family` is the load-bearing string: it is what gets stored in
 * CaptionSettings.font, injected as the @font-face family, and burned as the ASS
 * Fontname — so the preview and the export resolve to the very same file.
 */
export interface CustomFont {
  id: string;
  family: string;
  label: string;
  url: string;
  format: 'truetype' | 'opentype' | 'woff' | 'woff2';
  createdAt: string;
}

export interface Capabilities {
  hasAsr: boolean;
  asrModels: Array<{ id: string; label: string; hint: string; verbatim: boolean; verified: boolean }>;
  asrDefaults: AsrOptions;
  editDefaults: CutSettings;
}

/** Everything the Export panel lets the user decide. */
export interface RenderSettings extends CutSettings {
  /** Burn captions into the picture. Video only — pixels, not a sidecar track. */
  burnCaptions: boolean;
  /** Look and placement. Sent so a render uses what is on screen right now,
   *  rather than whatever was last persisted. */
  captions?: CaptionSettings;
  /** Output speed. Sent for the same reason as `captions` above. */
  speed?: number;
  /**
   * Live background-music settings, sent so a render reflects the panel even if
   * the debounced save has not yet landed. Omit to use the stored bed as-is;
   * `durationSec: null` means "play for the whole program".
   */
  music?: { volume?: number; durationSec?: number | null; loop?: boolean };
}

export type JobKind = 'transcribe' | 'render' | 'thumbs';
export type JobState = 'queued' | 'running' | 'done' | 'error' | 'canceled';

export interface Job {
  id: string;
  projectId: string;
  kind: JobKind;
  state: JobState;
  /** 0..1, or -1 when the work genuinely cannot report a fraction. */
  progress: number;
  stage: string;
  result?: unknown;
  error?: string;
  createdAt: string;
  endedAt?: string;
}

export interface RenderResult {
  url: string;
  segments: number;
  /** True when captions were actually burned into the picture. */
  burnedIn: boolean;
  /** Captions were asked for, but the project has no video to burn them onto. */
  captionsSkipped: boolean;
  sourceDuration: number;
  /** Length of the finished file — speed already divided in. */
  outputDuration: number;
  /** The speed actually rendered at, after the server clamped it. */
  speed: number;
  renderMs: number;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error ?? `Request failed (${res.status})`);
  }
  return res.json();
}

const post = (url: string, body?: unknown) =>
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });

export const api = {
  capabilities: () => fetch('/api/capabilities').then(json<Capabilities>),
  list: () => fetch('/api/projects').then(json<MediaItem[]>),
  get: (id: string) => fetch(`/api/projects/${id}`).then(json<Project>),

  /** Import only — this does NOT transcribe. */
  import: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return fetch('/api/projects', { method: 'POST', body: form }).then(json<Project>);
  },

  /**
   * Append a clip to an existing project. Returns the updated project, and — when
   * the project was already transcribed — a `jobId` for transcribing the new clip
   * (poll it with `waitForJob`, then re-fetch the project for the added words).
   */
  addClip: (id: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return fetch(`/api/projects/${id}/clips`, { method: 'POST', body: form }).then(
      json<{ project: Project; jobId?: string }>,
    );
  },

  /** Remove a clip. Refused if it is the project's only clip. */
  removeClip: (id: string, clipId: string) =>
    fetch(`/api/projects/${id}/clips/${clipId}`, { method: 'DELETE' }).then(
      json<{ project: Project }>,
    ),

  /** Reorder clips. `order` is every clip id in the new play order. */
  reorderClips: (id: string, order: string[]) =>
    fetch(`/api/projects/${id}/clips/order`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order }),
    }).then(json<{ project: Project }>),

  /**
   * Split a clip in two at `at` seconds from the clip's own start. Non-destructive
   * — the halves share the source file — and instant (no job). Returns the updated
   * project with one more clip.
   */
  splitClip: (id: string, clipId: string, at: number) =>
    post(`/api/projects/${id}/clips/${clipId}/split`, { at }).then(json<{ project: Project }>),

  /** Starts a job and returns immediately. Poll it with `waitForJob`. */
  transcribe: (id: string, options: AsrOptions) =>
    post(`/api/projects/${id}/transcribe`, options).then(json<{ jobId: string }>),

  job: (id: string) => fetch(`/api/jobs/${id}`).then(json<Job>),
  cancelJob: (id: string) => post(`/api/jobs/${id}/cancel`).then(json<{ ok: boolean }>),

  /**
   * Persist the edit state. Was `setDeleted`, which stopped being true once the
   * caption style rode along with it and is now four things.
   */
  saveDoc: (
    id: string,
    doc: { deletedIds: string[]; captions?: CaptionSettings; speed?: number; cut?: CutSettings },
  ) =>
    fetch(`/api/projects/${id}/transcript`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(doc),
    }).then(json<{ ok: boolean }>),

  action: (id: string, action: string, options: Record<string, unknown> = {}) =>
    post(`/api/projects/${id}/actions/${action}`, options).then(
      json<{ changed: number; transcript: Transcript }>,
    ),

  captions: (id: string, options: Record<string, unknown>) =>
    post(`/api/projects/${id}/captions`, options).then(
      json<{ format: string; cues: number; content: string }>,
    ),

  render: (id: string, settings: RenderSettings) =>
    post(`/api/projects/${id}/render`, settings).then(json<{ jobId: string }>),

  /**
   * Build the filmstrip. Idempotent: returns `{thumbs}` outright when they
   * already exist, and `{jobId}` (202) when it had to start ffmpeg — so the
   * caller must branch rather than assume a job.
   */
  thumbs: (id: string) =>
    post(`/api/projects/${id}/thumbs`).then(json<{ jobId?: string; thumbs?: Thumbs }>),

  /**
   * Imported caption fonts. Global to the install, so this is not scoped to a
   * project — the same list backs every one of them.
   */
  fonts: {
    list: () => fetch('/api/fonts').then(json<CustomFont[]>),
    upload: (file: File) => {
      const form = new FormData();
      form.append('file', file);
      return fetch('/api/fonts', { method: 'POST', body: form }).then(json<CustomFont>);
    },
    remove: (id: string) =>
      fetch(`/api/fonts/${id}`, { method: 'DELETE' }).then(json<{ ok: boolean }>),
  },

  /**
   * Per-project background music. Every call returns the updated project, so the
   * caller just swaps it into state — no separate re-fetch.
   */
  music: {
    upload: (id: string, file: File) => {
      const form = new FormData();
      form.append('file', file);
      return fetch(`/api/projects/${id}/music`, { method: 'POST', body: form }).then(json<Project>);
    },
    /** Patch volume and/or length. `durationSec: null` clears the length cap. */
    update: (id: string, patch: { volume?: number; durationSec?: number | null; loop?: boolean }) =>
      fetch(`/api/projects/${id}/music`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      }).then(json<Project>),
    remove: (id: string) =>
      fetch(`/api/projects/${id}/music`, { method: 'DELETE' }).then(json<Project>),
  },
};

/**
 * Poll a job to completion.
 *
 * 500ms: a progress bar does not need to be more current than that, and polling
 * survives the server restarts that `--watch` causes in development — where an
 * SSE stream would just die. Resolves with the job's result, throws on error or
 * cancel.
 */
export async function waitForJob<T>(
  jobId: string,
  onTick: (job: Job) => void,
  signal?: AbortSignal,
): Promise<T> {
  for (;;) {
    if (signal?.aborted) throw new Error('Canceled');

    const job = await api.job(jobId);
    onTick(job);

    if (job.state === 'done') return job.result as T;
    if (job.state === 'error') throw new Error(job.error ?? 'The job failed.');
    if (job.state === 'canceled') throw new Error('Canceled');

    await new Promise((r) => setTimeout(r, 500));
  }
}
