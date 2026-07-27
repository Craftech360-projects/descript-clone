import type { CaptionSettings } from '../../../packages/core/src/caption-style.ts';
import type { ColorSettings } from '../../../packages/core/src/color.ts';
import type { FrameSettings } from '../../../packages/core/src/frame.ts';
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
  /**
   * The cover frame for the project's dashboard card. Absent on audio, and on
   * video whose cover the server has not built yet — the card falls back to a
   * mark. Built lazily by the listing endpoint; see the server's poster.ts.
   */
  posterUrl?: string;
  /** Caption look and placement. Absent on projects saved before captions existed. */
  captions?: CaptionSettings;
  /** Output speed multiplier. Absent on projects saved before speed existed. */
  speed?: number;
  /** Cut settings, wire shape (maxGapMs 0 = keep every pause). Absent on projects
   *  saved before cut settings were persisted; the client falls back to defaults. */
  cut?: CutSettings;
  /** Studio sound voice enhancer */
  studioSound?: boolean;
  /** Output frame: target resolution plus the zoom/pan that fills it. Absent on
   *  projects that have never left the source's own resolution. */
  frame?: FrameSettings;
  /** Colour grade: which look, and where its knobs sit. Absent on ungraded projects. */
  color?: ColorSettings;
  /** The background-music bed, if one has been imported. Absent otherwise. */
  music?: ProjectMusic;
  /**
   * The saved assistant conversation. Absent on projects with no chat yet, and
   * stripped from the library listing (it can grow) — a full `api.get` carries it,
   * which is what opening a project uses. See ProjectChat.
   */
  chat?: ProjectChat;
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

  /**
   * Provenance, present only on a bed found through the picker. Absent for an
   * imported file, which owes nobody a credit. The catalogue behind the picker
   * is almost entirely CC BY / BY-SA, so when `attribution` IS set the panel has
   * to show it — publishing the video without it breaks the licence.
   */
  attribution?: string;
  license?: string;
  sourceLink?: string;
}

/** Which catalogue the music picker is searching. See server music-search.ts. */
export type MusicProvider = 'openverse' | 'jamendo';

/**
 * One track from the picker, normalised across providers by the server.
 *
 * `previewUrl` is streamed straight from the provider's CDN into an <audio> —
 * auditioning a track costs our server nothing, and only the one actually
 * chosen is ever downloaded.
 */
export interface MusicResult {
  id: string;
  title: string;
  artist: string;
  durationSec: number;
  previewUrl: string;
  downloadUrl: string;
  /** 'by', 'by-sa', 'cc0'… drives the badge. */
  license: string;
  /** The credit line this track requires. Empty when none is due. */
  attribution: string;
  link: string;
  provider: MusicProvider;
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
  /** Catalogues the music picker can search. Never empty — Openverse needs no key. */
  musicProviders: MusicProvider[];
  /** The AI assistant. `enabled` is false until XAI_API_KEY is set on the server. */
  agent: { enabled: boolean; defaultModel: string };
}

/**
 * One message on the wire to/from the assistant, in the OpenAI Chat Completions
 * shape Grok speaks. `content` is null on an assistant turn that is pure tool
 * calls; a `tool` turn carries the result for one `tool_call_id`.
 */
export interface AgentToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}
export interface AgentWireMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: AgentToolCall[];
  tool_call_id?: string;
}
export interface AgentAssistantMessage {
  role: 'assistant';
  content: string | null;
  tool_calls?: AgentToolCall[];
}

// ── The assistant conversation, persisted per project ───────────────────────────
//
// These are the canonical definitions (store/agent.ts imports them) so the persisted
// `Project.chat` and the live chat store never drift. `entries` is the panel timeline;
// `wire` is the Grok history resent each turn; `claudeSessionId` is the Agent SDK
// session to resume so Claude keeps context across a reload without resending it.

/** One tool the assistant ran, shown as a chip under its turn. */
export interface ToolChip {
  name: string;
  result: string;
}

/** One line in the panel timeline: the user's text, the assistant's reply, or an error. */
export interface ChatEntry {
  id: string;
  role: 'user' | 'assistant' | 'error';
  text: string;
  /** Tool calls made while producing this assistant turn. */
  tools?: ToolChip[];
}

/** A project's saved assistant conversation — round-tripped through the server verbatim. */
export interface ProjectChat {
  entries: ChatEntry[];
  wire: AgentWireMessage[];
  claudeSessionId?: string | null;
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
  /** Studio sound voice enhancer */
  studioSound?: boolean;
  /** Live frame settings, sent for the same reason as `captions` above — an Export
   *  fired mid-debounce should reframe to what is on screen, not to the last save. */
  frame?: FrameSettings;
  /** Live colour grade, sent for the same reason as `frame` above. */
  color?: ColorSettings;
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
  // no-store: this is live status (which keys/backends are on). A browser-cached
  // response would tell refreshCaps the ASR key is still missing right after the
  // user added it, so the on-import chain would keep refusing to transcribe.
  capabilities: () => fetch('/api/capabilities', { cache: 'no-store' }).then(json<Capabilities>),
  list: () => fetch('/api/projects').then(json<MediaItem[]>),
  get: (id: string) => fetch(`/api/projects/${id}`).then(json<Project>),

  /**
   * Import only — this does NOT transcribe.
   *
   * The file is sent as the RAW request body (not multipart) so the server can
   * stream it straight to disk. A multipart FormData upload made the browser and
   * the server each buffer the whole file, which failed on large sources — past
   * ~2GB the server could not even allocate the ArrayBuffer. The name rides in a
   * header instead of a form field.
   */
  import: (file: File) =>
    fetch('/api/projects', {
      method: 'POST',
      headers: {
        'content-type': file.type || 'application/octet-stream',
        'x-filename': encodeURIComponent(file.name),
      },
      body: file,
    }).then(json<Project>),

  /**
   * Rename a project. A label only — nothing on disk is keyed by the name, so
   * this moves no bytes and does not touch the edit.
   */
  rename: (id: string, name: string) =>
    fetch(`/api/projects/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }).then(json<{ project: Project }>),

  /**
   * Delete a project and its media. Not undoable — confirm before calling.
   */
  remove: (id: string) =>
    fetch(`/api/projects/${id}`, { method: 'DELETE' }).then(json<{ ok: boolean }>),

  /**
   * Append a clip to an existing project. Returns the updated project, and — when
   * the project was already transcribed — a `jobId` for transcribing the new clip
   * (poll it with `waitForJob`, then re-fetch the project for the added words).
   */
  addClip: (id: string, file: File) =>
    // Raw body + name header, streamed to disk — same as `import` above.
    fetch(`/api/projects/${id}/clips`, {
      method: 'POST',
      headers: {
        'content-type': file.type || 'application/octet-stream',
        'x-filename': encodeURIComponent(file.name),
      },
      body: file,
    }).then(json<{ project: Project; jobId?: string }>),

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
   * caption style rode along with it and is now everything on the document that
   * is not a word.
   */
  saveDoc: (
    id: string,
    doc: {
      deletedIds: string[];
      captions?: CaptionSettings;
      speed?: number;
      cut?: CutSettings;
      studioSound?: boolean;
      frame?: FrameSettings;
      color?: ColorSettings;
    },
  ) =>
    fetch(`/api/projects/${id}/transcript`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(doc),
    }).then(json<{ ok: boolean }>),

  /**
   * Persist the assistant conversation for a project. Its own endpoint, not part of
   * saveDoc: the chat is not the edit document (it pushes no undo step and must save
   * even before a project is transcribed), and it saves on its own cadence — once per
   * completed turn, not on the doc's 800ms debounce.
   */
  saveChat: (id: string, chat: ProjectChat) =>
    fetch(`/api/projects/${id}/chat`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(chat),
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

    /**
     * Search the web for a bed. Proxied through our server, so no provider key
     * ever reaches the browser and the rate limit is the app's, not the user's.
     */
    search: (q: string, opts: { instrumental?: boolean; provider?: MusicProvider } = {}) => {
      const params = new URLSearchParams({ q });
      if (opts.instrumental) params.set('instrumental', '1');
      if (opts.provider) params.set('provider', opts.provider);
      return fetch(`/api/music/search?${params}`).then(
        json<{ results: MusicResult[]; provider: MusicProvider }>,
      );
    },

    /**
     * Attach a searched track. The server fetches it — the browser never holds
     * the bytes — and the credit fields ride along so they outlive the picker.
     */
    fromUrl: (id: string, track: MusicResult) =>
      fetch(`/api/projects/${id}/music/url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: track.downloadUrl,
          name: `${track.title} — ${track.artist}`,
          attribution: track.attribution,
          license: track.license,
          link: track.link,
        }),
      }).then(json<Project>),
  },

  /**
   * The AI assistant. `models` populates the picker; `chat` is one turn of the
   * loop — the client sends its running history plus a fresh state snapshot, and
   * gets back the assistant's next message (which may ask to call tools).
   */
  agent: {
    models: () =>
      fetch('/api/agent/models').then(json<{ models: string[]; default: string; enabled: boolean }>),
    chat: (body: { model: string; context: string; messages: AgentWireMessage[] }) =>
      post('/api/agent', body).then(json<{ message: AgentAssistantMessage }>),
  },

  /**
   * Runtime API-key management from the dashboard. The server never returns a
   * secret — only whether each key is set and a short tail hint — so `keys` is
   * safe to hold in the client. `save` sends { id: value } (empty string clears).
   */
  settings: {
    keys: () => fetch('/api/settings/keys').then(json<KeysResponse>),
    save: (patch: Record<string, string>) =>
      post('/api/settings/keys', patch).then(json<KeysResponse>),
  },
};

/** One managed key's masked status, as the server reports it. */
export interface KeyStatus {
  configured: boolean;
  /** A tail hint like "…a1b2", never the secret itself. */
  hint: string;
  label: string;
  note: string;
}
export interface KeysResponse {
  keys: Record<string, KeyStatus>;
  backends: { grok: boolean; claude: boolean; asr: boolean };
}

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
