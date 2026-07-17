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
  /** Bumped on every committed change. The saver uses it to detect staleness. */
  rev: number;
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
  /** Escape hatch for a wholesale transcript swap (re-transcribe). */
  | { kind: 'replace'; prev: Word[]; next: Word[] };

export function docFromTranscript(
  transcript: Transcript,
  cut: CutSettings,
  captions: CaptionSettings = DEFAULT_CAPTIONS,
): Doc {
  return { words: transcript.words, cut, captions, rev: 0 };
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
      return 100;
    case 'replace':
      return (patch.prev.length + patch.next.length) * 130;
  }
}
