import type { Transcript } from '../../../packages/core/src/types.ts';

export interface Project {
  id: string;
  name: string;
  sourceUrl: string;
  duration: number;
  hasVideo: boolean;
  width?: number;
  height?: number;
  status: 'imported' | 'transcribed';
  transcript: Transcript | null;
  asrProvider: string | null;
  verbatim: boolean;
  peaks: number[];
  createdAt: string;
}

export type MediaItem = Omit<Project, 'peaks' | 'transcript'>;

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
  hasFal: boolean;
  asrModels: Array<{ id: string; label: string; hint: string; verbatim: boolean; verified: boolean }>;
  aiTools: Array<{ id: string; label: string; wired: boolean; hint: string }>;
  asrDefaults: AsrOptions;
  editDefaults: CutSettings;
}

export interface RenderResult {
  url: string;
  segments: number;
  sourceDuration: number;
  outputDuration: number;
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

  transcribe: (id: string, options: AsrOptions) =>
    post(`/api/projects/${id}/transcribe`, options).then(json<Project>),

  setDeleted: (id: string, deletedIds: string[]) =>
    fetch(`/api/projects/${id}/transcript`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deletedIds }),
    }).then(json<{ ok: boolean }>),

  action: (id: string, action: string, options: Record<string, unknown> = {}) =>
    post(`/api/projects/${id}/actions/${action}`, options).then(
      json<{ changed: number; transcript: Transcript }>,
    ),

  captions: (id: string, options: Record<string, unknown>) =>
    post(`/api/projects/${id}/captions`, options).then(
      json<{ format: string; cues: number; content: string }>,
    ),

  render: (id: string, cut: CutSettings) =>
    post(`/api/projects/${id}/render`, cut).then(json<RenderResult>),
};
