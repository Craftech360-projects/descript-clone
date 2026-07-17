import {
  affectedIds,
  applyPatch,
  invertPatch,
  isEmptyPatch,
  patchBytes,
  type Doc,
  type DocPatch,
} from './doc.ts';

/**
 * A real undo stack.
 *
 * What this replaces: a single line binding Cmd+Z to "un-delete the current
 * selection". Because deleting also CLEARS the selection, undo-immediately-
 * after-delete read an empty selection and returned. It was not flaky — it was
 * structurally incapable of working, and it could never undo a filler sweep, a
 * retake sweep, or a settings change at all.
 *
 * Pure and dependency-free so it runs under `node --test` with no browser, for
 * the same reason compileEdl is: the thing that guards correctness should be
 * testable without media.
 */

export interface HistoryEntry {
  patch: DocPatch;
  /** Human label: "Delete 12 words", "Remove 34 filler words". */
  label: string;
  /** Groups adjacent edits of the same kind, e.g. "type:w42". Null never merges. */
  coalesceKey: string | null;
  /** When this entry last absorbed an edit; drives the idle window. */
  endedAt: number;
  /** Selection at the time of the edit, restored on undo/redo respectively. */
  selectionBefore: string[];
  selectionAfter: string[];
}

export interface History {
  past: HistoryEntry[];
  future: HistoryEntry[];
}

export const emptyHistory = (): History => ({ past: [], future: [] });

export interface CommitOptions {
  label: string;
  coalesceKey?: string | null;
  selectionBefore?: string[];
  selectionAfter?: string[];
  /** Injectable so tests are deterministic. */
  now?: number;
}

/** Merge window for same-key edits. Word uses ~300ms; CodeMirror defaults to 500. */
export const COALESCE_MS = 500;

/** Keep the stack bounded two ways — a `replace` entry can be ~600KB on its own. */
export const MAX_ENTRIES = 200;
export const MAX_BYTES = 8_000_000;

export interface CommitResult {
  doc: Doc;
  history: History;
}

/**
 * Apply a patch and record it. Any new commit invalidates the redo stack.
 */
export function commit(
  doc: Doc,
  history: History,
  patch: DocPatch,
  options: CommitOptions,
): CommitResult {
  // A no-op edit must not consume a history slot, or Cmd+Z starts doing nothing
  // visible — the exact failure this whole module exists to remove.
  if (isEmptyPatch(patch)) return { doc, history };

  const now = options.now ?? Date.now();
  const coalesceKey = options.coalesceKey ?? null;
  const top = history.past[history.past.length - 1];

  const canMerge =
    top !== undefined &&
    coalesceKey !== null &&
    top.coalesceKey === coalesceKey &&
    now - top.endedAt < COALESCE_MS &&
    // Only same-shape patches merge; a cut change never folds into a text edit.
    top.patch.kind === patch.kind &&
    patch.kind === 'words';

  const nextDoc = applyPatch(doc, patch);

  if (canMerge && top.patch.kind === 'words' && patch.kind === 'words') {
    // Keep the OLDEST prev and the NEWEST next, per word, so five keystrokes
    // invert as one.
    const merged = new Map(top.patch.edits.map((e) => [e.id, { ...e }]));
    for (const edit of patch.edits) {
      const existing = merged.get(edit.id);
      if (existing) existing.next = { ...existing.next, ...edit.next };
      else merged.set(edit.id, { ...edit });
    }

    const entry: HistoryEntry = {
      ...top,
      patch: { kind: 'words', edits: [...merged.values()] },
      label: options.label,
      endedAt: now,
      selectionAfter: options.selectionAfter ?? top.selectionAfter,
    };

    return {
      doc: nextDoc,
      history: { past: [...history.past.slice(0, -1), entry], future: [] },
    };
  }

  const entry: HistoryEntry = {
    patch,
    label: options.label,
    coalesceKey,
    endedAt: now,
    selectionBefore: options.selectionBefore ?? [],
    selectionAfter: options.selectionAfter ?? [],
  };

  return { doc: nextDoc, history: { past: prune([...history.past, entry]), future: [] } };
}

/** Evict oldest entries past either budget. */
function prune(past: HistoryEntry[]): HistoryEntry[] {
  let out = past.length > MAX_ENTRIES ? past.slice(past.length - MAX_ENTRIES) : past;
  let bytes = out.reduce((sum, e) => sum + patchBytes(e.patch), 0);
  let from = 0;
  while (bytes > MAX_BYTES && from < out.length - 1) {
    bytes -= patchBytes(out[from].patch);
    from++;
  }
  return from > 0 ? out.slice(from) : out;
}

/**
 * Seal the current coalescing group, so the next edit starts a fresh entry.
 * Called when the caret leaves a word, on blur, and before any other command.
 */
export function breakCoalescing(history: History): History {
  const top = history.past[history.past.length - 1];
  if (!top || top.coalesceKey === null) return history;
  return {
    ...history,
    past: [...history.past.slice(0, -1), { ...top, coalesceKey: null }],
  };
}

export interface StepResult {
  doc: Doc;
  history: History;
  /** What changed — the caller scrolls to, selects, or flashes these. */
  affected: string[];
  /** Selection to restore. */
  selection: string[];
  label: string;
}

export function canUndo(history: History): boolean {
  return history.past.length > 0;
}
export function canRedo(history: History): boolean {
  return history.future.length > 0;
}

/** Label for the menu/tooltip, e.g. "Undo Delete 12 words". */
export function undoLabel(history: History): string | null {
  return history.past[history.past.length - 1]?.label ?? null;
}
export function redoLabel(history: History): string | null {
  return history.future[history.future.length - 1]?.label ?? null;
}

export function undo(doc: Doc, history: History): StepResult | null {
  const entry = history.past[history.past.length - 1];
  if (!entry) return null;

  return {
    doc: applyPatch(doc, invertPatch(entry.patch)),
    history: { past: history.past.slice(0, -1), future: [...history.future, entry] },
    // Undo must show its work. For a sweep, selectionBefore is empty — restoring
    // it literally would leave 34 words un-striking somewhere off-screen and the
    // app looking dead. So the caller always gets the ids that actually changed.
    affected: affectedIds(entry.patch),
    selection: entry.selectionBefore,
    label: entry.label,
  };
}

export function redo(doc: Doc, history: History): StepResult | null {
  const entry = history.future[history.future.length - 1];
  if (!entry) return null;

  return {
    doc: applyPatch(doc, entry.patch),
    history: { past: [...history.past, entry], future: history.future.slice(0, -1) },
    affected: affectedIds(entry.patch),
    selection: entry.selectionAfter,
    label: entry.label,
  };
}

/** "Delete 12 words" / `Delete "reality"` — count in the label, not after it. */
export function describeWords(texts: string[], verb: string): string {
  if (texts.length === 1) return `${verb} "${texts[0]}"`;
  if (texts.length <= 3) return `${verb} "${texts.join(' ')}"`;
  return `${verb} ${texts.length} words`;
}
