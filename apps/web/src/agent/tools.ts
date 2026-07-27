/**
 * The browser half of the agent: one executor per tool the model can call.
 *
 * The server sends Grok the tool SCHEMAS (from packages/core/agent-tools.ts); the
 * loop in store/agent.ts hands each requested call here, keyed by name. Almost
 * every executor is a thin call into store/editor.ts — the same functions the UI
 * uses — so an assistant edit flows through the identical apply → history → save
 * path and is live, undoable, and auto-saved for free. The few asynchronous, App-
 * level actions (transcribe, render, music, switching projects) reach the app
 * through a BRIDGE the App component registers, the same pattern as setSaver.
 *
 * Executors return a short human-readable string: that string is the tool result
 * the model reads to decide what to say or do next, so it states the outcome
 * plainly (counts, new values) or an error the model can act on.
 */

import {
  correctText,
  removeFillers,
  removeRetakes,
  restoreAll,
  setSelection,
  setSelectionDeleted,
  updateCaptions,
  updateColor,
  updateCut,
  updateFrame,
  updateSpeed,
  updateStudioSound,
} from '../store/editor.ts';
import type { Doc } from '../../../../packages/core/src/doc.ts';
import type { Word } from '../../../../packages/core/src/types.ts';
import { normalizeFrame, type FramePreset } from '../../../../packages/core/src/frame.ts';
import { presetSettings, type ColorPreset } from '../../../../packages/core/src/color.ts';
import {
  normalizeCaptions,
  type CaptionSettings,
} from '../../../../packages/core/src/caption-style.ts';

// ── the bridge the App fills in ────────────────────────────────────────────────

/** A snapshot of live app state. `doc` is the real editor document, not a copy. */
export interface AgentSnapshot {
  project: { id: string; name: string; durationSec: number; hasVideo: boolean } | null;
  transcribed: boolean;
  asrAvailable: boolean;
  doc: Doc | null;
  selectedWordIds: string[];
  selectionText: string;
  stats: { words: number; kept: number; cuts: number; outputSec: number };
  music: { name: string; volume: number } | null;
}

/** The async, App-level actions an executor cannot perform from the store alone. */
export interface AgentBridge {
  snapshot(): AgentSnapshot;
  listProjects(): Promise<Array<{ id: string; name: string; transcribed: boolean }>>;
  openProject(id: string): Promise<void>;
  renameProject(id: string, name: string): Promise<void>;
  deleteProject(id: string): Promise<void>;
  transcribe(): Promise<void>;
  exportVideo(): Promise<string>;
  addMusic(query: string, instrumental: boolean): Promise<string>;
  setMusicVolume(volume: number): Promise<void>;
  removeMusic(): Promise<void>;
  seek(seconds: number): void;
  playSelection(): void;
}

let bridge: AgentBridge | null = null;

/** App registers (and on unmount clears) the live bridge. Mirrors setSaver. */
export function setAgentBridge(next: AgentBridge | null): void {
  bridge = next;
}

function requireBridge(): AgentBridge {
  if (!bridge) throw new Error('The editor is not ready yet.');
  return bridge;
}

/** The doc, or a thrown message the model will relay to the user. */
function requireDoc(snap: AgentSnapshot): Doc {
  if (!snap.project) throw new Error('No project is open. Use list_projects then open_project first.');
  if (!snap.doc) throw new Error('This project has no transcript yet. Transcribe it first.');
  return snap.doc;
}

// ── the compact state snapshot the model sees each turn ─────────────────────────

function clock(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** The `# Current app state` block the server appends to the system prompt. */
export function buildContext(): string {
  if (!bridge) return 'The editor is still loading.';
  const s = bridge.snapshot();
  if (!s.project) {
    return 'No project is open. Use list_projects to see the library, then open_project to open one.';
  }

  const lines: string[] = [];
  const p = s.project;
  lines.push(`Project: "${p.name}" (${clock(p.durationSec)}, ${p.hasVideo ? 'video' : 'audio only'})`);
  lines.push(`Transcribed: ${s.transcribed ? 'yes' : 'no'}${s.asrAvailable ? '' : ' (no ASR provider configured)'}`);

  if (s.doc) {
    const d = s.doc;
    lines.push(
      `Stats: ${s.stats.words} words, ${s.stats.kept} kept, ${s.stats.cuts} cut ranges, output ~${clock(s.stats.outputSec)}`,
    );
    const pause = d.cut.maxGapMs === Infinity ? 'keep all' : `${Math.round(d.cut.maxGapMs)}ms`;
    lines.push(
      `Settings: speed ${d.speed}x, pause cap ${pause}, studio sound ${d.studioSound ? 'on' : 'off'}, ` +
        `captions ${d.captions.enabled ? 'on' : 'off'}, frame ${d.frame.preset}, colour ${d.color.preset}`,
    );
  }
  lines.push(s.music ? `Music: "${s.music.name}" at ${Math.round(s.music.volume * 100)}% volume` : 'Music: none');
  lines.push(
    s.selectionText
      ? `Selection: "${trim(s.selectionText, 80)}" (${s.selectedWordIds.length} words)`
      : 'Selection: none',
  );
  return lines.join('\n');
}

function trim(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// ── transcript search: turn a phrase into concrete word-id ranges ───────────────

/** Just the letters and digits, lowercased — so "Um," and "um" match. */
function norm(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

interface Run {
  fromId: string;
  toId: string;
  fromIndex: number;
  toIndex: number;
  text: string;
}

/**
 * Every consecutive run of words whose text matches `query`, in order. A single
 * word or a multi-word phrase; overlapping matches are not returned (the scan
 * skips past a hit). `includeDeleted` decides whether already-cut words count —
 * false for deleting (skip what is already gone), true for restoring and search.
 */
function matchRuns(words: Word[], query: string, includeDeleted: boolean): Run[] {
  const needle = query.split(/\s+/).map(norm).filter(Boolean);
  if (needle.length === 0) return [];

  const pool = words
    .map((w, index) => ({ w, index }))
    .filter(({ w }) => includeDeleted || !w.deleted);

  const runs: Run[] = [];
  for (let i = 0; i + needle.length <= pool.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (norm(pool[i + j].w.text) !== needle[j]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const span = pool.slice(i, i + needle.length);
    runs.push({
      fromId: span[0].w.id,
      toId: span[span.length - 1].w.id,
      fromIndex: span[0].index,
      toIndex: span[span.length - 1].index,
      text: span.map((x) => x.w.text).join(' '),
    });
    i += needle.length - 1; // no overlapping matches
  }
  return runs;
}

/** Apply delete/restore to an explicit id range or every/first query match. */
function editRange(
  doc: Doc,
  args: { query?: string; occurrence?: string; from_word_id?: string; to_word_id?: string },
  deleted: boolean,
): string {
  const verb = deleted ? 'Deleted' : 'Restored';

  // Explicit range wins over a query.
  if (args.from_word_id && args.to_word_id) {
    const a = doc.words.findIndex((w) => w.id === args.from_word_id);
    const b = doc.words.findIndex((w) => w.id === args.to_word_id);
    if (a === -1 || b === -1) return 'One of the word ids was not found. Use find_in_transcript to get valid ids.';
    setSelection({ anchorId: args.from_word_id, focusId: args.to_word_id });
    setSelectionDeleted(deleted);
    const count = Math.abs(b - a) + 1;
    return `${verb} ${count} word${count === 1 ? '' : 's'}.`;
  }

  if (!args.query) return 'Provide a phrase (query) or an explicit from_word_id/to_word_id range.';

  const runs = matchRuns(doc.words, args.query, /* includeDeleted */ !deleted);
  if (runs.length === 0) {
    return `No ${deleted ? 'editable' : 'deleted'} words matched "${args.query}".`;
  }

  const targets = args.occurrence === 'all' ? runs : [runs[0]];
  let total = 0;
  for (const run of targets) {
    setSelection({ anchorId: run.fromId, focusId: run.toId });
    setSelectionDeleted(deleted);
    total += run.toIndex - run.fromIndex + 1;
  }
  setSelection(null);
  return `${verb} ${total} word${total === 1 ? '' : 's'} across ${targets.length} match${targets.length === 1 ? '' : 'es'}.`;
}

// ── the executor table ──────────────────────────────────────────────────────────

type Args = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const numOr = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);

const executors: Record<string, (args: Args) => string | Promise<string>> = {
  get_project_context: () => buildContext(),

  list_projects: async () => {
    const list = await requireBridge().listProjects();
    if (list.length === 0) return 'The library is empty. The user needs to import media first.';
    return list
      .map((p) => `- ${p.name} (id: ${p.id})${p.transcribed ? '' : ' — not transcribed'}`)
      .join('\n');
  },

  find_in_transcript: (args) => {
    const doc = requireDoc(requireBridge().snapshot());
    const query = str(args.query);
    if (!query) return 'Provide a query.';
    const limit = Math.max(1, Math.min(50, numOr(args.limit, 10)));
    const runs = matchRuns(doc.words, query, true).slice(0, limit);
    if (runs.length === 0) return `No matches for "${query}".`;
    return runs
      .map(
        (r, i) =>
          `${i + 1}. "${r.text}" [from_word_id: ${r.fromId}, to_word_id: ${r.toId}]` +
          (doc.words[r.fromIndex].deleted ? ' (currently deleted)' : ''),
      )
      .join('\n');
  },

  remove_fillers: (args) => {
    requireDoc(requireBridge().snapshot());
    const all = str(args.mode) === 'all';
    const n = removeFillers(all, []);
    return n === 0 ? 'No filler words to cut.' : `Cut ${n} filler word${n === 1 ? '' : 's'}.`;
  },

  remove_retakes: (args) => {
    requireDoc(requireBridge().snapshot());
    const n = removeRetakes(Math.max(1, Math.round(numOr(args.min_words, 2))));
    return n === 0 ? 'No retakes found.' : `Cut ${n} word${n === 1 ? '' : 's'} of retakes.`;
  },

  restore_all: () => {
    requireDoc(requireBridge().snapshot());
    const n = restoreAll();
    return n === 0 ? 'Nothing was cut.' : `Restored ${n} word${n === 1 ? '' : 's'}.`;
  },

  delete_text: (args) => editRange(requireDoc(requireBridge().snapshot()), args, true),
  restore_text: (args) => editRange(requireDoc(requireBridge().snapshot()), args, false),

  correct_word: (args) => {
    const doc = requireDoc(requireBridge().snapshot());
    const id = str(args.word_id);
    const text = str(args.text);
    if (!id || text === undefined) return 'Provide word_id and text.';
    const word = doc.words.find((w) => w.id === id);
    if (!word) return 'That word id was not found. Use find_in_transcript.';
    correctText(id, text);
    return `Changed "${word.text}" to "${text}".`;
  },

  set_speed: (args) => {
    requireDoc(requireBridge().snapshot());
    const speed = numOr(args.speed, NaN);
    if (!Number.isFinite(speed)) return 'Provide a numeric speed.';
    updateSpeed(speed);
    return `Speed set to ${Number(Math.min(2, Math.max(0.5, speed)).toFixed(2))}x.`;
  },

  set_pause_cap: (args) => {
    const doc = requireDoc(requireBridge().snapshot());
    const raw = args.ms;
    const keep = raw === null || raw === undefined || (typeof raw === 'number' && raw <= 0);
    const maxGapMs = keep ? Infinity : numOr(raw, Infinity);
    updateCut({ ...doc.cut, maxGapMs });
    return keep ? 'Keeping every pause.' : `Pauses capped at ${Math.round(maxGapMs)}ms.`;
  },

  set_studio_sound: (args) => {
    requireDoc(requireBridge().snapshot());
    const enabled = bool(args.enabled);
    if (enabled === undefined) return 'Provide enabled (true/false).';
    updateStudioSound(enabled);
    return `Studio Sound ${enabled ? 'on' : 'off'}.`;
  },

  set_captions: (args) => {
    const snap = requireBridge().snapshot();
    const doc = requireDoc(snap);
    if (snap.project && !snap.project.hasVideo && bool(args.enabled)) {
      return 'This is an audio-only project — there is no picture to burn captions onto.';
    }
    const patch: Partial<CaptionSettings> = {};
    if (bool(args.enabled) !== undefined) patch.enabled = bool(args.enabled)!;
    if (bool(args.karaoke) !== undefined) patch.karaoke = bool(args.karaoke)!;
    if (bool(args.all_caps) !== undefined) patch.allCaps = bool(args.all_caps)!;
    if (str(args.font)) patch.font = str(args.font)!;
    if (str(args.color)) patch.color = str(args.color)!;
    if (typeof args.font_size === 'number') patch.fontSize = args.font_size;
    if (Object.keys(patch).length === 0) return 'Nothing to change — pass enabled and/or a style field.';
    updateCaptions(normalizeCaptions({ ...doc.captions, ...patch }));
    return `Captions updated${patch.enabled !== undefined ? ` (${patch.enabled ? 'on' : 'off'})` : ''}.`;
  },

  set_frame: (args) => {
    const doc = requireDoc(requireBridge().snapshot());
    const preset = str(args.preset) as FramePreset | undefined;
    if (!preset || !['source', 'reel', 'youtube', 'square'].includes(preset)) {
      return 'Provide preset: source, reel, youtube or square.';
    }
    const zoom = typeof args.zoom === 'number' ? args.zoom : doc.frame.zoom;
    updateFrame(normalizeFrame({ ...doc.frame, preset, zoom }));
    return `Frame set to ${preset}${typeof args.zoom === 'number' ? ` at ${zoom}x zoom` : ''}.`;
  },

  set_color: (args) => {
    requireDoc(requireBridge().snapshot());
    const preset = str(args.preset) as ColorPreset | undefined;
    const known = ['none', 'warm', 'cool', 'vintage', 'mono', 'punch', 'faded', 'noir'];
    if (!preset || !known.includes(preset)) return `Provide preset: ${known.join(', ')}.`;
    updateColor(presetSettings(preset));
    return preset === 'none' ? 'Removed the colour grade.' : `Applied the ${preset} look.`;
  },

  add_music: async (args) => {
    const query = str(args.query);
    if (!query) return 'Provide a query.';
    return requireBridge().addMusic(query, bool(args.instrumental) ?? true);
  },

  set_music_volume: async (args) => {
    const volume = numOr(args.volume, NaN);
    if (!Number.isFinite(volume)) return 'Provide a numeric volume.';
    await requireBridge().setMusicVolume(Math.max(0, volume));
    return `Music volume set to ${Math.round(Math.max(0, volume) * 100)}%.`;
  },

  remove_music: async () => {
    await requireBridge().removeMusic();
    return 'Removed the background music.';
  },

  transcribe: async () => {
    const snap = requireBridge().snapshot();
    if (!snap.project) return 'No project is open.';
    if (snap.transcribed) return 'This project is already transcribed.';
    if (!snap.asrAvailable) return 'No ASR provider is configured on the server, so transcription is unavailable.';
    await requireBridge().transcribe();
    return 'Transcription finished — the script is ready to edit.';
  },

  open_project: async (args) => {
    const id = str(args.project_id);
    if (!id) return 'Provide project_id.';
    await requireBridge().openProject(id);
    return buildContext();
  },

  rename_project: async (args) => {
    const id = str(args.project_id);
    const name = str(args.name);
    if (!id || !name) return 'Provide project_id and name.';
    await requireBridge().renameProject(id, name);
    return `Renamed to "${name}".`;
  },

  delete_project: async (args) => {
    const id = str(args.project_id);
    if (!id) return 'Provide project_id.';
    if (bool(args.confirm) !== true) {
      return 'Deletion is permanent and cannot be undone. Ask the user to confirm, then call again with confirm=true.';
    }
    await requireBridge().deleteProject(id);
    return 'Project deleted.';
  },

  export_video: async (args) => {
    if (bool(args.confirm) !== true) {
      return 'Exporting is a slow render. Confirm the user wants to export, then call again with confirm=true.';
    }
    requireDoc(requireBridge().snapshot());
    return requireBridge().exportVideo();
  },

  seek: (args) => {
    const seconds = numOr(args.seconds, NaN);
    if (!Number.isFinite(seconds)) return 'Provide seconds.';
    requireBridge().seek(Math.max(0, seconds));
    return `Playhead moved to ${clock(seconds)}.`;
  },

  play_selection: () => {
    const snap = requireBridge().snapshot();
    if (snap.selectedWordIds.length === 0) return 'Nothing is selected to play.';
    requireBridge().playSelection();
    return 'Playing the selection.';
  },
};

/** Run one tool call and return its result string (never throws — errors are text). */
export async function runTool(name: string, args: Args): Promise<string> {
  const fn = executors[name];
  if (!fn) return `Unknown tool: ${name}.`;
  try {
    return await fn(args);
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}
