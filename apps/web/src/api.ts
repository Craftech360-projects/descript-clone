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
  /** Absent on audio, and on video whose filmstrip has not been built yet. */
  thumbs?: Thumbs;
  /** Caption look and placement. Absent on projects saved before captions existed. */
  captions?: CaptionSettings;
  /** Output speed multiplier. Absent on projects saved before speed existed. */
  speed?: number;
  /** Cut settings, wire shape (maxGapMs 0 = keep every pause). Absent on projects
   *  saved before cut settings were persisted; the client falls back to defaults. */
  cut?: CutSettings;
  createdAt: string;
}

export type MediaItem = Omit<Project, 'peaks' | 'transcript' | 'thumbs'>;

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
