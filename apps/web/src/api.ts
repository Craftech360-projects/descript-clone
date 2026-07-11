export interface Word {
  id: string;
  text: string;
  start: number;
  end: number;
  speaker?: string;
  deleted?: boolean;
  isFiller?: boolean;
}

export interface Project {
  id: string;
  name: string;
  sourceUrl: string;
  duration: number;
  hasVideo: boolean;
  transcript: { mediaId: string; duration: number; words: Word[] };
  asrProvider: string;
  verbatim: boolean;
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

export const api = {
  health: () => fetch('/api/health').then(json<{ asrProvider: string; hasFalKey: boolean }>),

  upload: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return fetch('/api/projects', { method: 'POST', body: form }).then(json<Project>);
  },

  setDeleted: (id: string, deletedIds: string[]) =>
    fetch(`/api/projects/${id}/transcript`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deletedIds }),
    }).then(json<{ ok: boolean }>),

  action: (id: string, action: 'remove-fillers' | 'remove-retakes' | 'restore-all') =>
    fetch(`/api/projects/${id}/actions/${action}`, { method: 'POST' }).then(
      json<{ changed: number; transcript: Project['transcript'] }>,
    ),

  peaks: (id: string) =>
    fetch(`/api/projects/${id}/peaks`).then(json<{ peaks: number[]; duration: number }>),

  render: (id: string, maxGapMs?: number) =>
    fetch(`/api/projects/${id}/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxGapMs }),
    }).then(json<RenderResult>),
};
