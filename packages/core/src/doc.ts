import { DEFAULT_CAPTIONS, type CaptionSettings } from './caption-style.ts';
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
  /** Escape hatch for a wholesale transcript swap (re-transcribe). */
  | { kind: 'replace'; prev: Word[]; next: Word[] };

export function docFromTranscript(
  transcript: Transcript,
  cut: CutSettings,
  captions: CaptionSettings = DEFAULT_CAPTIONS,
  speed: number = DEFAULT_SPEED,
): Doc {
  return { words: transcript.words, cut, captions, speed, rev: 0 };
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
    case 'cut':
    case 'captions':
    case 'speed':
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
    case 'replace':
      return { kind: 'replace', prev: patch.next, next: patch.prev };
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
    case 'replace':
      return { ...doc, words: patch.next, rev: doc.rev + 1 };
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
      return patch.prev === patch.next;
    case 'replace':
      return false;
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
      return 100;
    case 'replace':
      return (patch.prev.length + patch.next.length) * 130;
  }
}
