import { DEFAULT_CAPTIONS, type CaptionSettings } from './caption-style.ts';
import { DEFAULT_COLOR, type ColorSettings } from './color.ts';
import { DEFAULT_FRAME, type FrameSettings } from './frame.ts';
import type { ImageOverlay } from './overlay.ts';
import type { CompileOptions, Transcript, Word } from './types.ts';

/**
 * The editable document, and the patches that change it.
 *
 * Every edit is expressed as a patch that carries BOTH its before and its after,
 * so `invert()` is total and undo is O(1). That is not a micro-optimisation:
 * the entire edit state of this app is a boolean on a handful of words, and
 * snapshotting the document to flip 30 booleans costs ~600KB and ~4.4ms of
 * structuredClone — 57MB across a 100-step history. A patch costs ~150 bytes
 * per word touched.
 *
 * The other half of the win is subtler and matters more: structuredClone
 * destroys every object identity, so nothing downstream can be memoised.
 * applyPatch shares structure — untouched Word objects come out referentially
 * equal — which is what lets React.memo actually work on the script.
 */

/** Cut settings are Required<CompileOptions>: they are inputs to compileEdl. */
export type CutSettings = Required<CompileOptions>;

export interface Doc {
  words: Word[];
  cut: CutSettings;
  /** How burned captions look and where they sit. Part of the document, so it
   *  undoes with everything else and survives a reload. */
  captions: CaptionSettings;
  /**
   * Output speed multiplier: 1.2 renders 20% faster and 20% shorter.
   *
   * NOT a CutSettings field, though it is tempting. Cut settings are inputs to
   * compileEdl, and speed is deliberately not: the EDL addresses the SOURCE, and
   * every timestamp in it — every word, every kept range — stays a source
   * timestamp no matter how fast we play it out. Speed is a transform on the
   * OUTPUT, applied once at the end. Feeding it into the compiler would rescale
   * ranges that index real bytes on disk and desynchronise the edit from the
   * media it describes.
   */
  speed: number;
  /**
   * Studio Sound: the voice enhancer (denoise, EQ, compression, loudness).
   *
   * Like `speed`, a transform on the OUTPUT rather than an input to compileEdl —
   * it never moves a timestamp, so it lives beside speed rather than in the cut
   * settings. Part of the document so it undoes and survives a reload.
   */
  studioSound: boolean;
  /**
   * The output frame: what shape the finished video is, and which part of the
   * source survives the crop.
   *
   * Beside speed and studioSound for the same reason — a transform on the OUTPUT,
   * never an input to compileEdl. It moves pixels, not timestamps, so the EDL
   * underneath is identical whether this is a reel or a 16:9. See frame.ts.
   */
  frame: FrameSettings;
  /**
   * The colour grade: how the picture looks, as opposed to what shape it is.
   *
   * The third member of the same family as speed, studioSound and frame — a
   * transform on the OUTPUT, never an input to compileEdl. It moves pixel VALUES
   * and not even pixel positions, so the EDL underneath is identical whether this
   * is Noir or neutral. See color.ts.
   */
  color: ColorSettings;
  /**
   * Images composited over the picture for a stretch of the transcript — the
   * B-roll track. See overlay.ts.
   *
   * A top-level field rather than a member of `frame`, unlike push-ins. A
   * push-in lives under frame.moves because it IS a framing decision — it
   * re-crops the delivered rectangle and nothing else. An overlay composites new
   * pixels from a different file, so filing it under "what shape is the output"
   * would put two unrelated things behind one patch kind and make every image
   * edit look like a reframe in the undo history.
   */
  overlays: ImageOverlay[];
  /** Bumped on every committed change. The saver uses it to detect staleness. */
  rev: number;
}

/**
 * The speed ladder offered in the transport.
 *
 * 1.2 rather than YouTube's 1.25 because it is the step people ask for by name,
 * and a ladder is a list of the speeds worth having, not a geometric series.
 */
export const SPEEDS = [0.5, 0.75, 1, 1.2, 1.5, 1.75, 2] as const;

export const DEFAULT_SPEED = 1;

/**
 * Bounds are ffmpeg's, not taste.
 *
 * A single `atempo` takes a tempo in [0.5, 100] — but that upper figure is
 * recent, and atempo was capped at 2.0 for years. Holding the ladder inside
 * [0.5, 2] means one filter instance covers every speed this app can produce, on
 * every ffmpeg that can run it. Past 2 the graph would need a CHAIN of atempos
 * (2.5 = 2.0 x 1.25), which is a real feature with real quality costs and no
 * user asking for it — so the range is closed here rather than half-supported
 * downstream.
 */
export const MIN_SPEED = 0.5;
export const MAX_SPEED = 2;

/**
 * Coerce anything — a JSON body, an old project file, a stale client — into a
 * speed the render can survive.
 *
 * The server takes this off the wire, so NaN and "fast" and 0 all arrive here.
 * Zero is the one that matters: `setpts=PTS/0` is a division by zero and
 * `atempo=0` is rejected outright, so an unvalidated 0 is a failed render rather
 * than a silly one.
 */
export function clampSpeed(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_SPEED;
  return Math.min(MAX_SPEED, Math.max(MIN_SPEED, n));
}

/**
 * The document holds maxGapMs as Infinity for "keep every pause"; the wire and
 * disk hold 0.
 *
 * Infinity does not survive JSON — JSON.stringify turns it into null — so the
 * moment cut settings started being persisted, they needed a boundary. 0 is the
 * chosen sentinel, documented at every crossing (the slider emits it, the
 * capabilities route emits it, the compiler reads it). These two functions are
 * the only sanctioned place that translation happens.
 */
export function cutToWire(cut: CutSettings): CutSettings {
  return { ...cut, maxGapMs: cut.maxGapMs === Infinity ? 0 : cut.maxGapMs };
}

/**
 * Bring a wire/disk cut back into the document, falling back field-by-field to
 * `fallback` (already in document form) for anything missing or unparseable — a
 * project saved by an older build, or a hand-edited record.
 */
export function cutFromWire(wire: Partial<CutSettings> | undefined, fallback: CutSettings): CutSettings {
  if (!wire) return fallback;
  const n = (v: unknown, f: number) => (typeof v === 'number' && Number.isFinite(v) ? v : f);
  return {
    padMs: n(wire.padMs, fallback.padMs),
    fadeMs: n(wire.fadeMs, fallback.fadeMs),
    mergeWithinMs: n(wire.mergeWithinMs, fallback.mergeWithinMs),
    // 0 (or a non-finite that fell through) means "keep every pause".
    maxGapMs: typeof wire.maxGapMs === 'number' && wire.maxGapMs > 0 ? wire.maxGapMs : Infinity,
  };
}

/** A change to one word. `prev` and `next` hold only the fields that differ. */
export interface WordPatch {
  id: string;
  prev: Partial<Word>;
  next: Partial<Word>;
}

export type DocPatch =
  | { kind: 'words'; edits: WordPatch[] }
  | { kind: 'cut'; prev: CutSettings; next: CutSettings }
  | { kind: 'captions'; prev: CaptionSettings; next: CaptionSettings }
  | { kind: 'speed'; prev: number; next: number }
  | { kind: 'studioSound'; prev: boolean; next: boolean }
  | { kind: 'frame'; prev: FrameSettings; next: FrameSettings }
  | { kind: 'color'; prev: ColorSettings; next: ColorSettings }
  | { kind: 'overlays'; prev: ImageOverlay[]; next: ImageOverlay[] }
  /** Escape hatch for a wholesale transcript swap (re-transcribe). */
  | { kind: 'replace'; prev: Word[]; next: Word[] }
  /**
   * Several patches that commit, undo and redo as ONE step.
   *
   * For a change the user made as a single decision but which lands in more than
   * one part of the document — the on-import chain cuts fillers, caps pauses,
   * turns on the enhancer and turns on captions, and it is one thing that
   * happened, so it must be one Cmd+Z. Committing four entries instead would
   * make backing it out four presses of an unlabelled sequence.
   *
   * The sub-patches are applied in order and inverted in REVERSE order, which is
   * what keeps this correct when two of them touch the same field.
   */
  | { kind: 'batch'; patches: DocPatch[] };

export function docFromTranscript(
  transcript: Transcript,
  cut: CutSettings,
  captions: CaptionSettings = DEFAULT_CAPTIONS,
  speed: number = DEFAULT_SPEED,
  studioSound: boolean = false,
  frame: FrameSettings = DEFAULT_FRAME,
  color: ColorSettings = DEFAULT_COLOR,
  overlays: ImageOverlay[] = [],
): Doc {
  return { words: transcript.words, cut, captions, speed, studioSound, frame, color, overlays, rev: 0 };
}

/** The word ids a patch touches. Free — the patch already lists them. */
export function affectedIds(patch: DocPatch): string[] {
  switch (patch.kind) {
    case 'words':
      return patch.edits.map((e) => e.id);
    case 'replace': {
      // Only the words that actually differ, so undo can point at the change.
      const before = new Map(patch.prev.map((w) => [w.id, w]));
      return patch.next
        .filter((w) => {
          const b = before.get(w.id);
          return !b || b.deleted !== w.deleted || b.text !== w.text;
        })
        .map((w) => w.id);
    }
    case 'batch': {
      // De-duplicated, first-seen order: two sub-patches may touch the same word,
      // and the caller uses this list to select or flash a run — a repeated id
      // would widen that run to cover words the batch never changed.
      const seen = new Set<string>();
      for (const sub of patch.patches) for (const id of affectedIds(sub)) seen.add(id);
      return [...seen];
    }
    case 'cut':
    case 'captions':
    case 'speed':
    // Not a word change, so nothing to select or flash — but it MUST be listed.
    // Falling off the end of this switch returns undefined, and undo() hands the
    // result straight to the caller as `affected`, where .length throws.
    case 'studioSound':
    case 'frame':
    case 'color':
    case 'overlays':
      return [];
  }
}

/**
 * Swap before and after. Total, and the only thing undo needs.
 */
export function invertPatch(patch: DocPatch): DocPatch {
  switch (patch.kind) {
    case 'words':
      return {
        kind: 'words',
        edits: patch.edits.map((e) => ({ id: e.id, prev: e.next, next: e.prev })),
      };
    case 'cut':
      return { kind: 'cut', prev: patch.next, next: patch.prev };
    case 'captions':
      return { kind: 'captions', prev: patch.next, next: patch.prev };
    case 'speed':
      return { kind: 'speed', prev: patch.next, next: patch.prev };
    case 'studioSound':
      return { kind: 'studioSound', prev: patch.next, next: patch.prev };
    case 'frame':
      return { kind: 'frame', prev: patch.next, next: patch.prev };
    case 'color':
      return { kind: 'color', prev: patch.next, next: patch.prev };
    case 'overlays':
      return { kind: 'overlays', prev: patch.next, next: patch.prev };
    case 'replace':
      return { kind: 'replace', prev: patch.next, next: patch.prev };
    case 'batch':
      // Reversed, not merely mapped. If two sub-patches touch the same field, the
      // second one's `prev` is the first one's `next`; unwinding them in forward
      // order would restore that intermediate value and leave the original lost.
      return { kind: 'batch', patches: [...patch.patches].reverse().map(invertPatch) };
  }
}

/**
 * Apply a patch, sharing structure. Words the patch does not touch come out as
 * the SAME object reference, which is what keeps React.memo honest.
 */
export function applyPatch(doc: Doc, patch: DocPatch): Doc {
  switch (patch.kind) {
    case 'words': {
      if (patch.edits.length === 0) return doc;
      const byId = new Map(patch.edits.map((e) => [e.id, e]));
      let changed = false;
      const words = doc.words.map((w) => {
        const edit = byId.get(w.id);
        if (!edit) return w;
        changed = true;
        return applyFields(w, edit.next);
      });
      if (!changed) return doc;
      return { ...doc, words, rev: doc.rev + 1 };
    }
    case 'cut':
      return { ...doc, cut: { ...patch.next }, rev: doc.rev + 1 };
    case 'captions':
      return { ...doc, captions: { ...patch.next }, rev: doc.rev + 1 };
    case 'speed':
      return { ...doc, speed: patch.next, rev: doc.rev + 1 };
    case 'studioSound':
      return { ...doc, studioSound: patch.next, rev: doc.rev + 1 };
    case 'frame':
      return { ...doc, frame: { ...patch.next }, rev: doc.rev + 1 };
    case 'color':
      return { ...doc, color: { ...patch.next }, rev: doc.rev + 1 };
    case 'overlays':
      // Copied one level, like every other settings patch: the array is fresh so
      // a later edit cannot mutate the value this patch holds for undo, while
      // the overlay objects inside stay referentially equal for React.memo.
      return { ...doc, overlays: [...patch.next], rev: doc.rev + 1 };
    case 'replace':
      return { ...doc, words: patch.next, rev: doc.rev + 1 };
    case 'batch': {
      // Structure sharing survives this: each step returns the SAME doc object
      // when its patch is a no-op, so an all-no-op batch comes out identical.
      let out = doc;
      for (const sub of patch.patches) out = applyPatch(out, sub);
      return out;
    }
  }
}

/**
 * Merge `fields` onto a word, treating an undefined value as "remove the key".
 *
 * Word.deleted and Word.isFiller are optional, so a never-deleted word has no
 * `deleted` key at all. A plain spread would write `deleted: undefined` and the
 * document would no longer round-trip through undo — same meaning, different
 * shape, and every deep comparison downstream would report a phantom change.
 */
function applyFields(word: Word, fields: Partial<Word>): Word {
  const out: Word = { ...word, ...fields };
  for (const key of Object.keys(fields) as Array<keyof Word>) {
    if (fields[key] === undefined) delete out[key];
  }
  return out;
}

/** Fields a word patch is allowed to carry. Timings are NOT among them. */
const PATCHABLE = ['deleted', 'text', 'speaker', 'isFiller'] as const;
type PatchableKey = (typeof PATCHABLE)[number];

/**
 * Build a patch that sets `changes` on every id in `ids`, recording each word's
 * current value as `prev` so the result inverts cleanly. Words already holding
 * the target value are skipped, so a no-op edit produces no history entry.
 */
export function buildWordPatch(
  words: Word[],
  ids: Iterable<string>,
  changes: Partial<Pick<Word, PatchableKey>>,
): DocPatch {
  const wanted = ids instanceof Set ? ids : new Set(ids);
  const keys = Object.keys(changes) as PatchableKey[];
  const edits: WordPatch[] = [];

  for (const word of words) {
    if (!wanted.has(word.id)) continue;

    const prev: Partial<Word> = {};
    const next: Partial<Word> = {};
    let differs = false;

    for (const key of keys) {
      const target = changes[key];
      if (word[key] === target) continue;
      // `deleted` and `isFiller` are optional, so undefined and false are the
      // same state. Normalise, or undo would resurrect `undefined` as a change.
      if ((key === 'deleted' || key === 'isFiller') && !word[key] === !target) continue;
      (prev as Record<string, unknown>)[key] = word[key];
      (next as Record<string, unknown>)[key] = target;
      differs = true;
    }

    if (differs) edits.push({ id: word.id, prev, next });
  }

  return { kind: 'words', edits };
}

/** True when a patch would change nothing — don't push these onto history. */
export function isEmptyPatch(patch: DocPatch): boolean {
  switch (patch.kind) {
    case 'words':
      return patch.edits.length === 0;
    case 'cut':
      return (Object.keys(patch.next) as Array<keyof CutSettings>).every(
        (k) => patch.prev[k] === patch.next[k],
      );
    case 'captions':
      return (Object.keys(patch.next) as Array<keyof CaptionSettings>).every(
        (k) => patch.prev[k] === patch.next[k],
      );
    case 'speed':
    case 'studioSound':
      return patch.prev === patch.next;
    case 'frame':
      // `moves` is the one field on this document that is not a scalar, so it is
      // the one field === cannot answer for. Every edit to a move rebuilds the
      // array, which would make a === test say "changed" for a drag that ended
      // exactly where it started — an undo step that undoes nothing. Compared by
      // value, and cheaply: a project has a handful of moves, and a tracked path
      // is a few dozen numbers.
      return (Object.keys(patch.next) as Array<keyof FrameSettings>).every((k) =>
        k === 'moves'
          ? JSON.stringify(patch.prev.moves) === JSON.stringify(patch.next.moves)
          : patch.prev[k] === patch.next[k],
      );
    case 'color':
      return (Object.keys(patch.next) as Array<keyof ColorSettings>).every(
        (k) => patch.prev[k] === patch.next[k],
      );
    case 'overlays':
      // By value, for the same reason frame's `moves` is: every edit rebuilds
      // the array, so === would call a drag that ended where it started a real
      // change and push an undo step that undoes nothing. A project holds a
      // handful of overlays, each a dozen scalars.
      return JSON.stringify(patch.prev) === JSON.stringify(patch.next);
    case 'replace':
      return false;
    case 'batch':
      return patch.patches.every(isEmptyPatch);
  }
}

/** Rough byte cost, for budgeting the history stack. */
export function patchBytes(patch: DocPatch): number {
  switch (patch.kind) {
    case 'words':
      return patch.edits.length * 150;
    case 'cut':
    case 'captions':
    case 'speed':
    // Must be listed for the same reason as in affectedIds: an undefined here
    // makes prune()'s running total NaN, and the byte budget stops evicting.
    case 'studioSound':
    case 'color':
      return 100;
    case 'overlays':
      // Flat per overlay, unlike `frame`: an overlay is a fixed dozen scalars
      // with no unbounded member (the image's BYTES live on the project, not in
      // the patch), so there is nothing here that can quietly outgrow the
      // history budget the way a tracked path can.
      return 100 + (patch.prev.length + patch.next.length) * 200;
    case 'frame': {
      // Not a flat 100 like its neighbours: a frame patch carries its moves, and
      // a TRACKED move carries a sample per step of the follow. A minute of
      // tracking is a few thousand numbers, so charging 100 bytes for it would
      // let the history stack quietly outgrow its budget by an order of
      // magnitude — the one thing this function exists to prevent.
      const points = (f: FrameSettings) =>
        f.moves.reduce((sum, m) => sum + m.path.length, 0);
      return 100 + (points(patch.prev) + points(patch.next)) * 24;
    }
    case 'replace':
      return (patch.prev.length + patch.next.length) * 130;
    case 'batch':
      return patch.patches.reduce((sum, sub) => sum + patchBytes(sub), 0);
  }
}
