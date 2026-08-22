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
import { frameLabel, normalizeFrame, type FrameSettings } from '../../../../packages/core/src/frame.ts';
import { colorLabel, normalizeColor, type ColorSettings } from '../../../../packages/core/src/color.ts';
import {
  addMove,
  createMove,
  moveLabel,
  removeMove,
  updateMove,
  type FrameMove,
  type FramePoint,
} from '../../../../packages/core/src/frame-track.ts';
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
import {
  addOverlay,
  createOverlay,
  normalizeOverlays,
  overlayLabel,
  removeOverlay,
  updateOverlay,
  type ImageOverlay,
} from '../../../../packages/core/src/overlay.ts';
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
  studioSound?: boolean,
  frame?: Partial<FrameSettings> | null,
  color?: Partial<ColorSettings> | null,
  overlays?: unknown,
): void {
  savedRev = 0;
  set({
    doc: docFromTranscript(
      transcript,
      cut,
      captions,
      clampSpeed(speed),
      Boolean(studioSound),
      normalizeFrame(frame),
      normalizeColor(color),
      // Coerced on the way in for the same reason frame and colour are: this is
      // whatever the server had on disk, including a project saved before image
      // overlays existed (undefined → []).
      normalizeOverlays(overlays),
    ),
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

export function updateStudioSound(studioSound: boolean): void {
  const { doc } = state;
  if (!doc || doc.studioSound === studioSound) return;
  apply({ kind: 'studioSound', prev: doc.studioSound, next: studioSound }, { label: studioSound ? 'Enable studio sound' : 'Disable studio sound' });
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

// ── output frame (transient-aware) ────────────────────────────────────────────
//
// Panning the picture around the monitor and dragging the zoom slider are both
// continuous gestures, so they take the same treatment as the caption drag above:
// live updates during the gesture, one history entry when it ends.

let transientFrame: FrameSettings | null = null;

export function beginFrameDrag(): void {
  if (state.doc) transientFrame = state.doc.frame;
}

export function updateFrame(frame: FrameSettings): void {
  const { doc } = state;
  if (!doc) return;
  if (transientFrame) {
    set({ doc: { ...doc, frame, rev: doc.rev + 1 } });
    return;
  }
  apply({ kind: 'frame', prev: doc.frame, next: frame }, { label: frameLabel(frame) });
}

export function endFrameDrag(label: string): void {
  const { doc } = state;
  const prev = transientFrame;
  transientFrame = null;
  if (!doc || !prev) return;
  const next = doc.frame;
  if (isEmptyPatch({ kind: 'frame', prev, next })) return;

  set({ doc: { ...doc, frame: prev } });
  apply({ kind: 'frame', prev, next }, { label });
}

// ── colour grade (transient-aware) ────────────────────────────────────────────
//
// Six sliders, so six continuous gestures, and they get the same treatment as
// the frame and caption drags above for the same reason: without the bracket a
// single sweep of the contrast slider pushes ~40 undo steps.

let transientColor: ColorSettings | null = null;

export function beginColorDrag(): void {
  if (state.doc) transientColor = state.doc.color;
}

export function updateColor(color: ColorSettings): void {
  const { doc } = state;
  if (!doc) return;
  if (transientColor) {
    set({ doc: { ...doc, color, rev: doc.rev + 1 } });
    return;
  }
  apply({ kind: 'color', prev: doc.color, next: color }, { label: colorLabel(color) });
}

export function endColorDrag(label: string): void {
  const { doc } = state;
  const prev = transientColor;
  transientColor = null;
  if (!doc || !prev) return;
  const next = doc.color;
  if (isEmptyPatch({ kind: 'color', prev, next })) return;

  // Rewind, then commit once, so the single entry's inverse is the pre-drag value.
  set({ doc: { ...doc, color: prev } });
  apply({ kind: 'color', prev, next }, { label });
}

// ── push-ins: mark a portion of the picture and zoom into it ─────────────────
//
// These are edits to doc.frame.moves, so they ride the frame patch above and
// inherit its transient/commit split for free — dragging a marquee over the
// monitor is a continuous gesture exactly as panning is, and one history entry
// per pointermove would bury every real edit.
//
// What is NOT here: reading the playhead. The store deliberately holds no
// currentTime (it changes at 60Hz), so every function below takes the source
// time it needs as an argument from the caller that already has it.

/**
 * Mark a stretch of the video for a push-in.
 *
 * Returns the new move's id so the caller can select it and start framing, or
 * null when the range clashes with a move that is already there — addMove
 * returns the original array in that case, which makes this a no-op patch that
 * the history correctly refuses to record.
 */
export function addPunchIn(start: number, end: number): string | null {
  const { doc } = state;
  if (!doc) return null;

  const id = newMoveId();
  const move = createMove(start, end, id);
  const moves = addMove(doc.frame.moves, move);
  if (moves === doc.frame.moves) return null;

  apply(
    { kind: 'frame', prev: doc.frame, next: { ...doc.frame, moves } },
    { label: moveLabel(move, 'Add') },
  );
  return id;
}

/**
 * Change one move.
 *
 * `label` matters here in a way it does not for the sliders. A slider is wrapped
 * in beginFrameDrag/endFrameDrag and its label arrives with the drag's end; a
 * one-shot change like accepting a marquee has no gesture around it and falls
 * through to updateFrame's own commit — whose label is frameLabel, which
 * announces the PRESET ("Set frame to Reel"). Undo would then offer to undo
 * something the user did not do.
 */
export function setMove(id: string, patch: Partial<FrameMove>, label?: string): void {
  const { doc } = state;
  if (!doc) return;
  const move = doc.frame.moves.find((m) => m.id === id);
  if (!move) return;

  const next = { ...doc.frame, moves: updateMove(doc.frame.moves, id, patch) };
  // Mid-gesture, updateFrame writes through to the live doc and records nothing;
  // the single entry lands on endFrameDrag with the label the control chose.
  if (transientFrame) return updateFrame(next);
  apply({ kind: 'frame', prev: doc.frame, next }, { label: label ?? moveLabel(move, 'Adjust') });
}

export function deletePunchIn(id: string): void {
  const { doc } = state;
  if (!doc) return;
  const move = doc.frame.moves.find((m) => m.id === id);
  if (!move) return;
  apply(
    { kind: 'frame', prev: doc.frame, next: { ...doc.frame, moves: removeMove(doc.frame.moves, id) } },
    { label: moveLabel(move, 'Remove') },
  );
}

/**
 * Attach a tracked path to a move — the "follow this object" result.
 *
 * One entry, whatever the tracker sampled, and NOT through the drag machinery:
 * tracking is a single decision that produced a hundred numbers, so backing it
 * out has to be one Cmd+Z. An empty path clears the follow and gives back the
 * framing that was set by hand — see FrameMove.path.
 */
export function setMovePath(id: string, path: FramePoint[]): void {
  const { doc } = state;
  if (!doc) return;
  const move = doc.frame.moves.find((m) => m.id === id);
  if (!move) return;
  apply(
    {
      kind: 'frame',
      prev: doc.frame,
      next: { ...doc.frame, moves: updateMove(doc.frame.moves, id, { path }) },
    },
    { label: moveLabel(move, path.length > 0 ? 'Track' : 'Untrack') },
  );
}

/**
 * crypto.randomUUID, with a counter behind it.
 *
 * The fallback is not paranoia about old browsers: randomUUID is restricted to
 * SECURE contexts, and this app is routinely opened over plain http on a LAN
 * address to check a render on a phone. There it is simply undefined, and a move
 * with an undefined id is one the panel cannot address.
 */
let moveSeq = 0;
function newMoveId(): string {
  moveSeq++;
  return globalThis.crypto?.randomUUID?.() ?? `mv-${Date.now()}-${moveSeq}`;
}

// ── image overlays: show a picture while a word is said ──────────────────────
//
// The same transient/commit split as the frame and colour gestures above, for
// the same reason: dragging an overlay's box around the monitor is continuous,
// and one history entry per pointermove would bury every real edit. Dropping an
// image or changing its transition is one-shot and commits immediately.
//
// These are patches of their own kind rather than rides on the frame patch that
// push-ins take. A push-in IS a framing decision; an overlay composites pixels
// from another file, so filing it under `frame` would make every image edit read
// as "Set frame to Reel" in the undo history.

let transientOverlays: ImageOverlay[] | null = null;

export function beginOverlayDrag(): void {
  if (state.doc) transientOverlays = state.doc.overlays;
}

export function updateOverlays(overlays: ImageOverlay[], label = 'Change images'): void {
  const { doc } = state;
  if (!doc) return;
  if (transientOverlays) {
    set({ doc: { ...doc, overlays, rev: doc.rev + 1 } });
    return;
  }
  apply({ kind: 'overlays', prev: doc.overlays, next: overlays }, { label });
}

export function endOverlayDrag(label: string): void {
  const { doc } = state;
  const prev = transientOverlays;
  transientOverlays = null;
  if (!doc || !prev) return;
  const next = doc.overlays;
  if (isEmptyPatch({ kind: 'overlays', prev, next })) return;

  // Rewind, then commit once, so the single entry's inverse is the pre-drag value.
  set({ doc: { ...doc, overlays: prev } });
  apply({ kind: 'overlays', prev, next }, { label });
}

/**
 * Place an image over [start, end). Returns its id, or null when the project is
 * already at MAX_OVERLAYS — addOverlay returns the original array in that case,
 * so the refusal costs no special case here.
 */
export function addImageOverlay(
  assetId: string,
  start: number,
  end: number,
  patch: Partial<ImageOverlay> = {},
): string | null {
  const { doc } = state;
  if (!doc) return null;

  const id = newOverlayId();
  const overlay = createOverlay(id, assetId, start, end, patch);
  const overlays = addOverlay(doc.overlays, overlay);
  if (overlays === doc.overlays) return null;

  apply(
    { kind: 'overlays', prev: doc.overlays, next: overlays },
    { label: overlayLabel(overlay, 'Add') },
  );
  return id;
}

/**
 * Change one overlay.
 *
 * `label` matters here the way it does for setMove: a slider is bracketed by
 * beginOverlayDrag/endOverlayDrag and its label arrives with the drag's end, but
 * a one-shot change like picking a transition has no gesture around it and would
 * otherwise fall through to updateOverlays' generic label.
 */
export function setOverlay(id: string, patch: Partial<ImageOverlay>, label?: string): void {
  const { doc } = state;
  if (!doc) return;
  const overlay = doc.overlays.find((o) => o.id === id);
  if (!overlay) return;

  const next = updateOverlay(doc.overlays, id, patch);
  // Mid-gesture, updateOverlays writes through to the live doc and records
  // nothing; the single entry lands on endOverlayDrag with the drag's own label.
  if (transientOverlays) return updateOverlays(next);
  apply(
    { kind: 'overlays', prev: doc.overlays, next },
    { label: label ?? overlayLabel(overlay, 'Adjust') },
  );
}

export function deleteImageOverlay(id: string): void {
  const { doc } = state;
  if (!doc) return;
  const overlay = doc.overlays.find((o) => o.id === id);
  if (!overlay) return;
  apply(
    { kind: 'overlays', prev: doc.overlays, next: removeOverlay(doc.overlays, id) },
    { label: overlayLabel(overlay, 'Remove') },
  );
}

/**
 * Drop every overlay that pointed at an image the library no longer has.
 *
 * Called after deleting an asset. One history entry, because deleting the
 * picture is one decision — and the placements have to go with it: an overlay
 * with no asset is a placement that can never draw, and the render already skips
 * it silently. Leaving them would make the panel list images that are gone.
 */
export function dropOverlaysForAsset(assetId: string): number {
  const { doc } = state;
  if (!doc) return 0;
  const next = doc.overlays.filter((o) => o.assetId !== assetId);
  const removed = doc.overlays.length - next.length;
  if (removed === 0) return 0;
  apply({ kind: 'overlays', prev: doc.overlays, next }, { label: 'Remove image' });
  return removed;
}

let overlaySeq = 0;
/** See newMoveId — randomUUID is restricted to secure contexts, and this app is
 *  routinely opened over plain http on a LAN address to check a render on a phone. */
function newOverlayId(): string {
  overlaySeq++;
  return globalThis.crypto?.randomUUID?.() ?? `ov-${Date.now()}-${overlaySeq}`;
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
function findFillerIds(
  words: Word[],
  includeDiscourseMarkers: boolean,
  customWords: string[] = [],
): Set<string> {
  const scratch: Transcript = { mediaId: '', duration: 0, words: words.map((w) => ({ ...w })) };
  detectFillers(scratch, { includeDiscourseMarkers, customWords });
  return new Set(scratch.words.filter((w) => w.isFiller).map((w) => w.id));
}

export function countFillers(includeDiscourseMarkers: boolean, customWords: string[] = []): number {
  const { doc } = state;
  if (!doc) return 0;
  const ids = findFillerIds(doc.words, includeDiscourseMarkers, customWords);
  return doc.words.filter((w) => ids.has(w.id) && !w.deleted).length;
}

export function removeFillers(includeDiscourseMarkers: boolean, customWords: string[] = []): number {
  const { doc } = state;
  if (!doc) return 0;

  const flagged = findFillerIds(doc.words, includeDiscourseMarkers, customWords);
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
export function tagFillers(includeDiscourseMarkers: boolean, customWords: string[] = []): number {
  const { doc } = state;
  if (!doc) return 0;

  const flagged = findFillerIds(doc.words, includeDiscourseMarkers, customWords);
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

// ── the on-import chain ───────────────────────────────────────────────────────

/**
 * The document half of "process this the moment it lands".
 *
 * Transcription is not here: it is a server job, it has to finish before there
 * is a document to touch at all, and it is the caller's to run. Everything after
 * it — cut the hesitations, cap the pauses, set the speed, turn on the enhancer,
 * turn on the captions — is a pure edit to the doc, so it belongs in the store
 * where it is undoable and cannot race a save.
 *
 * They land as ONE batch patch, and that is the point. The user made one
 * decision ("process my imports"), so backing it out has to be one Cmd+Z. Five
 * separate commits would make undo a guessing game about how many presses
 * returns you to the raw transcript.
 *
 * Every field is nullable and null means LEAVE IT ALONE — not "set it false".
 * A step the user switched off must not quietly turn its setting off for them.
 */
export interface ImportChain {
  /** Sweep filler words. null leaves them, and any existing flags, untouched. */
  fillers: { includeDiscourseMarkers: boolean; customWords: string[] } | null;
  /**
   * Confine the filler sweep to one clip's words. Null sweeps the document.
   *
   * For appending a clip to a project you have already been editing: without it
   * the sweep would run over the older material too and re-cut every filler you
   * had restored by hand, which is a silent, destructive surprise for a gesture
   * that was only meant to add footage.
   */
  fillersInClipId?: string | null;
  /** Cap every silence at this many ms. Infinity is "keep every pause". */
  maxGapMs: number | null;
  /** Output speed multiplier. Clamped here, since it comes from stored settings. */
  speed: number | null;
  studioSound: boolean | null;
  captions: boolean | null;
}

export interface ImportChainResult {
  /** Filler words cut. 0 when the step was off or found nothing. */
  fillers: number;
  /** What actually changed, in order, for the notice. Empty = nothing to do. */
  applied: string[];
}

export function runImportChain(chain: ImportChain): ImportChainResult {
  const { doc } = state;
  const result: ImportChainResult = { fillers: 0, applied: [] };
  if (!doc) return result;

  // Every sub-patch is built against the SAME base doc, which is safe only
  // because they touch disjoint parts of it — words, cut, speed, studioSound,
  // captions. Two patches over one field would need the intermediate doc.
  const patches: DocPatch[] = [];

  if (chain.fillers) {
    const flagged = findFillerIds(
      doc.words,
      chain.fillers.includeDiscourseMarkers,
      chain.fillers.customWords,
    );
    const only = chain.fillersInClipId ?? null;
    const ids = new Set(
      doc.words
        .filter((w) => flagged.has(w.id) && !w.deleted && (only === null || w.clipId === only))
        .map((w) => w.id),
    );
    if (ids.size > 0) {
      // Tag AND delete, exactly as removeFillers does, so the script paints them
      // as the class of word they are rather than as an anonymous cut.
      patches.push(buildWordPatch(doc.words, ids, { deleted: true, isFiller: true }));
      result.fillers = ids.size;
      result.applied.push(`cut ${ids.size} filler word${ids.size === 1 ? '' : 's'}`);
    }
  }

  if (chain.maxGapMs !== null && doc.cut.maxGapMs !== chain.maxGapMs) {
    patches.push({ kind: 'cut', prev: doc.cut, next: { ...doc.cut, maxGapMs: chain.maxGapMs } });
    result.applied.push(
      chain.maxGapMs === Infinity ? 'kept every pause' : `capped pauses at ${chain.maxGapMs}ms`,
    );
  }

  if (chain.speed !== null) {
    // Through clampSpeed, not straight in: this arrives from localStorage, where
    // a hand-edited 0 would reach the render as setpts=PTS/0 and atempo=0.
    const speed = clampSpeed(chain.speed);
    if (doc.speed !== speed) {
      patches.push({ kind: 'speed', prev: doc.speed, next: speed });
      result.applied.push(`set the speed to ${formatSpeed(speed)}`);
    }
  }

  if (chain.studioSound !== null && doc.studioSound !== chain.studioSound) {
    patches.push({ kind: 'studioSound', prev: doc.studioSound, next: chain.studioSound });
    result.applied.push(chain.studioSound ? 'turned on Studio Sound' : 'turned off Studio Sound');
  }

  if (chain.captions !== null && doc.captions.enabled !== chain.captions) {
    patches.push({
      kind: 'captions',
      prev: doc.captions,
      next: { ...doc.captions, enabled: chain.captions },
    });
    result.applied.push(chain.captions ? 'turned on captions' : 'turned off captions');
  }

  if (patches.length === 0) return result;

  apply({ kind: 'batch', patches }, {
    // The label is what Cmd+Z announces, so it says what the whole batch was.
    label: 'Auto clean-up',
    nextSelection: null,
  });
  return result;
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

/**
 * The write currently on the wire, so a flush can WAIT for it.
 *
 * `pump` used to return immediately when a debounced save was already in flight,
 * which quietly broke every caller that flushes to make an edit durable before
 * asking the server to act on it. `doRender` says "make sure the edit has landed
 * before asking for pixels" and then got back a resolved promise while the
 * server still held the previous document — so a word deleted a moment earlier
 * could survive into the exported file. The render reads the SERVER's copy of
 * the deleted set, so this was the whole guarantee.
 *
 * Holding the promise lets a flush chain onto the in-flight write and then run
 * again for whatever changed while it was away.
 */
let inFlightWrite: Promise<void> | null = null;

async function pump(): Promise<void> {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (!saveFn) return;

  // A write is already going. Wait for it, then re-enter: the document may have
  // moved on since that write was built, and the caller is asking for CURRENT.
  if (inFlight) {
    await inFlightWrite;
    if (state.doc && state.doc.rev !== savedRev && state.saveStatus !== 'error') await pump();
    return;
  }

  const doc = state.doc;
  if (!doc || doc.rev === savedRev) { setStatus('saved'); return; }

  const rev = doc.rev;
  inFlight = true;
  setStatus('saving');

  const write = (async () => {
    try {
      await saveFn!(doc);
      savedRev = rev;
      // The doc may have moved while we were away — say saved only if it did not.
      setStatus(state.doc && state.doc.rev !== rev ? 'unsaved' : 'saved');
    } catch {
      setStatus('error');
    } finally {
      inFlight = false;
      inFlightWrite = null;
    }
  })();

  inFlightWrite = write;
  await write;

  // Anything that changed mid-write still has to go. Awaited, not fired off, so
  // a caller that flushed is told the truth about when the document is durable.
  if (state.doc && state.doc.rev !== savedRev && state.saveStatus !== 'error') await pump();
}

/**
 * Save now, and RESOLVE ONLY WHEN THE SERVER HAS THE CURRENT DOCUMENT — before a
 * render, a caption export, a clip operation, Ctrl+S, unload, or leaving the
 * editor.
 *
 * Await it whenever the next thing you do asks the server to act on the
 * document. pump reports failure through saveStatus and never rejects, so this
 * never rejects either.
 */
export function flushSave(): Promise<void> {
  return pump();
}

export function retrySave(): void {
  setStatus('unsaved');
  void pump();
}
