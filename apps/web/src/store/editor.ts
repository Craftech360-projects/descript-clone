import { useSyncExternalStore } from 'react';

import {
  buildWordPatch,
  clampSpeed,
  docFromTranscript,
  isEmptyPatch,
  type CutSettings,
  type Doc,
  type DocPatch,
} from '../../../../packages/core/src/doc.ts';
import type { CaptionSettings } from '../../../../packages/core/src/caption-style.ts';
import {
  breakCoalescing,
  canRedo,
  canUndo,
  commit,
  describeWords,
  emptyHistory,
  redo,
  redoLabel,
  undo,
  undoLabel,
  type History,
} from '../../../../packages/core/src/history.ts';
import { detectFillers } from '../../../../packages/core/src/fillers.ts';
import { detectRetakes } from '../../../../packages/core/src/retakes.ts';
import type { Transcript, Word } from '../../../../packages/core/src/types.ts';

/**
 * The document store.
 *
 * Deliberately NOT holding currentTime: it changes at 60Hz, and anything in
 * here causes a React render. The playhead lives outside React entirely.
 *
 * useSyncExternalStore rather than Context (no selectors — every consumer would
 * re-render on any change) and rather than a store library (the reducer has to
 * stay zero-dep so it runs under `node --test`, which is this repo's only test
 * harness). Snapshots are whole-state objects replaced only on real change, so
 * getSnapshot is cached by construction and we never need the selector shim.
 */

export interface Selection {
  /** Where the gesture started. */
  anchorId: string;
  /** Where it is now. Equal to anchorId for a single word. */
  focusId: string;
}

export interface EditorState {
  doc: Doc | null;
  history: History;
  selection: Selection | null;
  /** Ids to flash after an undo that changed too many words to select. */
  flash: string[];
  /** Bumped whenever a step wants the view to scroll somewhere. */
  reveal: { id: string; seek: boolean; nonce: number } | null;
  saveStatus: SaveStatus;
}

type Listener = () => void;

const INITIAL: EditorState = {
  doc: null,
  history: emptyHistory(),
  selection: null,
  flash: [],
  reveal: null,
  saveStatus: 'idle',
};

let state: EditorState = INITIAL;
const listeners = new Set<Listener>();

function set(next: Partial<EditorState>): void {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getSnapshot = () => state;

export function useEditor(): EditorState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

// ── selection helpers ─────────────────────────────────────────────────────────

/**
 * The ids a selection covers. Ranges are computed over ARRAY INDICES, never by
 * parsing the id: real ASR ids are non-contiguous (w0, w2, w4…) because they are
 * assigned from the raw index before spacing tokens are filtered out.
 */
export function selectedIds(words: Word[], selection: Selection | null): Set<string> {
  if (!selection) return new Set();
  const a = words.findIndex((w) => w.id === selection.anchorId);
  const b = words.findIndex((w) => w.id === selection.focusId);
  if (a === -1 || b === -1) return new Set();
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  const out = new Set<string>();
  for (let i = lo; i <= hi; i++) out.add(words[i].id);
  return out;
}

export function selectionTexts(words: Word[], ids: Set<string>): string[] {
  return words.filter((w) => ids.has(w.id)).map((w) => w.text);
}

// ── lifecycle ─────────────────────────────────────────────────────────────────

export function loadDoc(
  transcript: Transcript,
  cut: CutSettings,
  captions?: CaptionSettings,
  speed?: number,
): void {
  savedRev = 0;
  set({
    doc: docFromTranscript(transcript, cut, captions, clampSpeed(speed)),
    history: emptyHistory(),
    selection: null,
    flash: [],
    reveal: null,
    saveStatus: 'idle',
  });
}

export function clearDoc(): void {
  state = INITIAL;
  for (const l of listeners) l();
}

export function setSelection(selection: Selection | null): void {
  // Moving the caret must seal any open typing group, or the next keystroke
  // would merge into an edit made somewhere else entirely.
  set({ selection, history: breakCoalescing(state.history), flash: [] });
}

// ── committing ────────────────────────────────────────────────────────────────

interface Options {
  label: string;
  coalesceKey?: string | null;
  selectionAfter?: string[];
  /** Selection to leave live after the edit. Defaults to keeping the current one. */
  nextSelection?: Selection | null;
}

function apply(patch: DocPatch, options: Options): void {
  const { doc, history, selection } = state;
  if (!doc || isEmptyPatch(patch)) return;

  const before = [...selectedIds(doc.words, selection)];
  const nextSelection = 'nextSelection' in options ? options.nextSelection! : selection;
  const after = options.selectionAfter ?? [...selectedIds(doc.words, nextSelection ?? null)];

  const result = commit(doc, history, patch, {
    label: options.label,
    coalesceKey: options.coalesceKey ?? null,
    selectionBefore: before,
    selectionAfter: after,
  });

  set({ doc: result.doc, history: result.history, selection: nextSelection ?? null, flash: [] });
  scheduleSave();
}

/** Delete or restore the current selection. One undo step regardless of size. */
export function setSelectionDeleted(deleted: boolean): void {
  const { doc, selection } = state;
  if (!doc || !selection) return;

  const ids = selectedIds(doc.words, selection);
  if (ids.size === 0) return;

  const patch = buildWordPatch(doc.words, ids, { deleted });
  const texts = selectionTexts(doc.words, ids);

  apply(patch, {
    label: describeWords(texts, deleted ? 'Delete' : 'Restore'),
    // Deleting clears the selection, exactly as a text editor does. Undo will
    // put it back — that is what selectionBefore is for.
    nextSelection: deleted ? null : selection,
  });
}

export function correctText(id: string, text: string): void {
  const { doc } = state;
  if (!doc) return;
  const word = doc.words.find((w) => w.id === id);
  if (!word || word.text === text) return;

  apply(buildWordPatch(doc.words, [id], { text }), {
    label: `Correct "${word.text}" → "${text}"`,
    // Same word + inside the idle window = one undo step for a burst of typing.
    coalesceKey: `type:${id}`,
  });
}

export function setSpeaker(ids: Set<string>, speaker: string): void {
  const { doc } = state;
  if (!doc) return;
  apply(buildWordPatch(doc.words, ids, { speaker }), { label: `Assign ${speaker}` });
}

// ── cut settings (transient-aware) ────────────────────────────────────────────

let transientCut: CutSettings | null = null;

/**
 * Start a slider drag. Updates during the gesture mutate the doc live but write
 * no history; the single entry is recorded on pointerup. Without this a drag
 * would push ~40 undo steps and clone the project on every frame.
 */
export function beginCutDrag(): void {
  if (state.doc) transientCut = state.doc.cut;
}

export function updateCut(cut: CutSettings): void {
  const { doc } = state;
  if (!doc) return;
  if (transientCut) {
    set({ doc: { ...doc, cut, rev: doc.rev + 1 } });
    return;
  }
  commitCut(cut);
}

export function endCutDrag(label: string): void {
  const { doc } = state;
  const prev = transientCut;
  transientCut = null;
  if (!doc || !prev) return;
  const next = doc.cut;
  if (isEmptyPatch({ kind: 'cut', prev, next })) return;

  // Rewind to the pre-drag value, then commit once so history holds one entry
  // whose inverse is the original.
  set({ doc: { ...doc, cut: prev } });
  apply({ kind: 'cut', prev, next }, { label });
}

function commitCut(cut: CutSettings): void {
  const { doc } = state;
  if (!doc) return;
  apply({ kind: 'cut', prev: doc.cut, next: cut }, { label: 'Change edit settings' });
}

// ── speed ─────────────────────────────────────────────────────────────────────

/**
 * No transient/commit split here, unlike the cut sliders and the caption drag.
 *
 * Those two need one because they are driven by a CONTINUOUS gesture — a drag
 * fires ~40 times and would push 40 undo steps. Speed is picked from a ladder:
 * one discrete choice, one history entry, nothing to coalesce. The pair of
 * begin/end functions would be dead weight that only ever wrapped a single call.
 */
export function updateSpeed(speed: number): void {
  const { doc } = state;
  if (!doc) return;
  apply(
    { kind: 'speed', prev: doc.speed, next: clampSpeed(speed) },
    { label: `Speed ${formatSpeed(speed)}` },
  );
}

/** 1.2x, not 1.2000x — and 1x, not 1.0x. */
export function formatSpeed(speed: number): string {
  return `${Number(speed.toFixed(2))}x`;
}

// ── caption style ─────────────────────────────────────────────────────────────
//
// Same shape as the cut sliders, and for the same reason: dragging the caption
// around the monitor fires continuously, and one history entry per pointermove
// would bury every real edit under a hundred "Move captions" steps.

let transientCaptions: CaptionSettings | null = null;

export function beginCaptionDrag(): void {
  if (state.doc) transientCaptions = state.doc.captions;
}

export function updateCaptions(captions: CaptionSettings): void {
  const { doc } = state;
  if (!doc) return;
  if (transientCaptions) {
    set({ doc: { ...doc, captions, rev: doc.rev + 1 } });
    return;
  }
  apply(
    { kind: 'captions', prev: doc.captions, next: captions },
    { label: 'Change captions' },
  );
}

export function endCaptionDrag(label: string): void {
  const { doc } = state;
  const prev = transientCaptions;
  transientCaptions = null;
  if (!doc || !prev) return;
  const next = doc.captions;
  if (isEmptyPatch({ kind: 'captions', prev, next })) return;

  // Rewind, then commit once, so the single entry's inverse is the pre-drag value.
  set({ doc: { ...doc, captions: prev } });
  apply({ kind: 'captions', prev, next }, { label });
}

// ── bulk actions, client-side ─────────────────────────────────────────────────
//
// These used to be server round-trips whose response replaced the transcript
// wholesale — which meant they were absent from history AND could clobber any
// edit made while the request was in flight. They are pure functions in
// packages/core that the browser already imports for compileEdl, and the
// expensive one (detectRetakes) is ~110k ops, i.e. sub-millisecond. Running
// them here makes them instant, offline, and undoable, and deletes the whole
// clobbering bug class rather than defending against it.

/**
 * Which words the filler detector flags.
 *
 * detectFillers TAGS IN PLACE and returns a count — it does not return a copy.
 * So it runs against throwaway clones; letting it touch doc.words would mutate
 * the live document behind the store's back, with no patch and no history.
 */
function findFillerIds(words: Word[], includeDiscourseMarkers: boolean): Set<string> {
  const scratch: Transcript = { mediaId: '', duration: 0, words: words.map((w) => ({ ...w })) };
  detectFillers(scratch, { includeDiscourseMarkers });
  return new Set(scratch.words.filter((w) => w.isFiller).map((w) => w.id));
}

export function countFillers(includeDiscourseMarkers: boolean): number {
  const { doc } = state;
  if (!doc) return 0;
  const ids = findFillerIds(doc.words, includeDiscourseMarkers);
  return doc.words.filter((w) => ids.has(w.id) && !w.deleted).length;
}

export function removeFillers(includeDiscourseMarkers: boolean): number {
  const { doc } = state;
  if (!doc) return 0;

  const flagged = findFillerIds(doc.words, includeDiscourseMarkers);
  const ids = new Set(doc.words.filter((w) => flagged.has(w.id) && !w.deleted).map((w) => w.id));
  if (ids.size === 0) return 0;

  // Tag isFiller and delete in ONE patch, so one Cmd+Z undoes the whole sweep.
  const patch = buildWordPatch(doc.words, ids, { deleted: true, isFiller: true });
  apply(patch, {
    label: `Remove ${ids.size} filler word${ids.size === 1 ? '' : 's'}`,
    nextSelection: null,
  });
  return ids.size;
}

/** Tag fillers without cutting them, so the script can flag them in amber. */
export function tagFillers(includeDiscourseMarkers: boolean): number {
  const { doc } = state;
  if (!doc) return 0;

  const flagged = findFillerIds(doc.words, includeDiscourseMarkers);
  // Set on matches and clear on the rest, so re-running with a narrower mode
  // drops the tags it no longer stands behind.
  const on = buildWordPatch(doc.words, flagged, { isFiller: true });
  const offIds = doc.words.filter((w) => !flagged.has(w.id)).map((w) => w.id);
  const off = buildWordPatch(doc.words, offIds, { isFiller: false });
  const edits = [
    ...(on.kind === 'words' ? on.edits : []),
    ...(off.kind === 'words' ? off.edits : []),
  ];
  const patch: DocPatch = { kind: 'words', edits };
  if (isEmptyPatch(patch)) return flagged.size;

  apply(patch, { label: `Flag ${flagged.size} filler words` });
  return flagged.size;
}

export function countRetakes(minWords: number): number {
  const { doc } = state;
  if (!doc) return 0;
  return detectRetakes({ mediaId: '', duration: 0, words: doc.words }, { minWords }).length;
}

export function removeRetakes(minWords: number): number {
  const { doc } = state;
  if (!doc) return 0;

  const ranges = detectRetakes({ mediaId: '', duration: 0, words: doc.words }, { minWords });
  const ids = new Set<string>();
  for (const range of ranges) {
    for (let i = range.start; i < range.end; i++) {
      const word = doc.words[i];
      if (word && !word.deleted) ids.add(word.id);
    }
  }
  if (ids.size === 0) return 0;

  apply(buildWordPatch(doc.words, ids, { deleted: true }), {
    label: `Remove ${ranges.length} retake${ranges.length === 1 ? '' : 's'}`,
    nextSelection: null,
  });
  return ids.size;
}

export function restoreAll(): number {
  const { doc } = state;
  if (!doc) return 0;
  const ids = new Set(doc.words.filter((w) => w.deleted).map((w) => w.id));
  if (ids.size === 0) return 0;
  apply(buildWordPatch(doc.words, ids, { deleted: false }), {
    label: 'Restore everything',
    nextSelection: null,
  });
  return ids.size;
}

// ── undo / redo ───────────────────────────────────────────────────────────────

/** Select the affected run if it is small; otherwise flash it. */
const MAX_RESELECT = 50;

function land(step: {
  doc: Doc;
  history: History;
  affected: string[];
  selection: string[];
}): void {
  const { affected } = step;
  const words = step.doc.words;

  let selection: Selection | null = null;
  let flash: string[] = [];

  if (affected.length > 0 && affected.length <= MAX_RESELECT) {
    const first = affected[0];
    const last = affected[affected.length - 1];
    selection = { anchorId: first, focusId: last };
  } else if (step.selection.length > 0) {
    selection = { anchorId: step.selection[0], focusId: step.selection[step.selection.length - 1] };
  } else {
    flash = affected;
  }

  const firstId = affected[0] ?? step.selection[0];
  const reveal = firstId && words.some((w) => w.id === firstId)
    ? { id: firstId, seek: true, nonce: (state.reveal?.nonce ?? 0) + 1 }
    : null;

  set({ doc: step.doc, history: step.history, selection, flash, reveal });
  scheduleSave();
}

export function undoEdit(): string | null {
  const { doc, history } = state;
  if (!doc) return null;
  const step = undo(doc, history);
  if (!step) return null;
  land(step);
  return step.label;
}

export function redoEdit(): string | null {
  const { doc, history } = state;
  if (!doc) return null;
  const step = redo(doc, history);
  if (!step) return null;
  land(step);
  return step.label;
}

export const historyState = () => ({
  canUndo: canUndo(state.history),
  canRedo: canRedo(state.history),
  undoLabel: undoLabel(state.history),
  redoLabel: redoLabel(state.history),
});

// ── saving ────────────────────────────────────────────────────────────────────
//
// The old save fired on every word toggle, fire-and-forget, with no debounce and
// no ordering guarantee. Since the PATCH replaces the WHOLE deleted set, two
// requests in flight could land out of order and a stale one would resurrect
// words you had already cut. Single-flight makes that unrepresentable rather
// than merely unlikely: there is never more than one request in the air, and if
// the doc moved while it was, we simply send again.

export type SaveStatus = 'idle' | 'unsaved' | 'saving' | 'saved' | 'error';

type SaveFn = (doc: Doc) => Promise<void>;
let saveFn: SaveFn | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let inFlight = false;
/** The rev we last successfully persisted. */
let savedRev = 0;

export function setSaver(fn: SaveFn | null): void {
  saveFn = fn;
  inFlight = false;
  savedRev = state.doc?.rev ?? 0;
  setStatus(fn ? 'idle' : 'idle');
}

function setStatus(status: SaveStatus): void {
  if (state.saveStatus !== status) set({ saveStatus: status });
}

function scheduleSave(): void {
  if (!saveFn) return;
  setStatus('unsaved');
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void pump(), 800);
}

async function pump(): Promise<void> {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (!saveFn || inFlight) return; // a later change re-enters below

  const doc = state.doc;
  if (!doc || doc.rev === savedRev) { setStatus('saved'); return; }

  const rev = doc.rev;
  inFlight = true;
  setStatus('saving');
  try {
    await saveFn(doc);
    savedRev = rev;
    // The doc may have moved while we were away — say saved only if it did not.
    setStatus(state.doc && state.doc.rev !== rev ? 'unsaved' : 'saved');
  } catch {
    setStatus('error');
  } finally {
    inFlight = false;
    if (state.doc && state.doc.rev !== savedRev && state.saveStatus !== 'error') void pump();
  }
}

/** Save now — before a render, on Ctrl+S, on unload. */
export function flushSave(): void {
  void pump();
}

export function retrySave(): void {
  setStatus('unsaved');
  void pump();
}
