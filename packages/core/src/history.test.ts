import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyPatch,
  buildWordPatch,
  docFromTranscript,
  invertPatch,
  isEmptyPatch,
  type CutSettings,
  type Doc,
} from './doc.ts';
import {
  breakCoalescing,
  canRedo,
  canUndo,
  commit,
  COALESCE_MS,
  describeWords,
  emptyHistory,
  MAX_ENTRIES,
  redo,
  undo,
  undoLabel,
} from './history.ts';
import type { Transcript, Word } from './types.ts';

const CUT: CutSettings = { padMs: 40, fadeMs: 12, mergeWithinMs: 20, maxGapMs: Infinity };

/** Ids are deliberately non-contiguous — real ASR output runs w0, w2, w4… */
function transcript(count = 6): Transcript {
  const words: Word[] = Array.from({ length: count }, (_, i) => ({
    id: `w${i * 2}`,
    text: `word${i}`,
    start: i,
    end: i + 0.5,
  }));
  return { mediaId: 'm', duration: count, words };
}

const doc = (count = 6): Doc => docFromTranscript(transcript(count), CUT);
const deletedIds = (d: Doc) => d.words.filter((w) => w.deleted).map((w) => w.id);

test('THE BUG: undo immediately after a delete restores the word', () => {
  // Today Backspace clears the selection, then Cmd+Z reads the now-empty
  // selection and returns. This is the regression test for that.
  let d = doc();
  let h = emptyHistory();

  const patch = buildWordPatch(d.words, ['w4'], { deleted: true });
  ({ doc: d, history: h } = commit(d, h, patch, {
    label: 'Delete "word2"',
    selectionBefore: ['w4'],
    selectionAfter: [], // delete clears the selection — exactly as the app does
  }));
  assert.deepEqual(deletedIds(d), ['w4']);

  const step = undo(d, h);
  assert.ok(step, 'undo must be available right after a delete');
  assert.deepEqual(deletedIds(step.doc), [], 'the word must come back');
  assert.deepEqual(step.affected, ['w4'], 'undo reports what it changed');
});

test('undo of a sweep reports every affected word, not the empty selection', () => {
  // A sweep starts with nothing selected. Restoring selectionBefore literally
  // would give the user zero feedback — the app would look dead.
  let d = doc(10);
  let h = emptyHistory();

  const ids = ['w0', 'w4', 'w8', 'w12'];
  ({ doc: d, history: h } = commit(d, h, buildWordPatch(d.words, ids, { deleted: true }), {
    label: 'Remove 4 filler words',
    selectionBefore: [],
    selectionAfter: [],
  }));

  const step = undo(d, h)!;
  assert.deepEqual(deletedIds(step.doc), []);
  assert.deepEqual(step.affected, ids, 'undo must point at what it restored');
  assert.equal(step.label, 'Remove 4 filler words');
});

test('a multi-word delete is ONE undo step', () => {
  let d = doc(10);
  let h = emptyHistory();
  const ids = ['w0', 'w2', 'w4', 'w6'];

  ({ doc: d, history: h } = commit(d, h, buildWordPatch(d.words, ids, { deleted: true }), {
    label: 'Delete 4 words',
  }));

  assert.equal(h.past.length, 1, 'four words, one entry');
  const step = undo(d, h)!;
  assert.deepEqual(deletedIds(step.doc), []);
  assert.equal(canUndo(step.history), false);
});

test('typing coalesces inside the idle window and breaks outside it', () => {
  let d = doc();
  let h = emptyHistory();
  const t0 = 1_000_000;

  for (let i = 1; i <= 5; i++) {
    const patch = buildWordPatch(d.words, ['w4'], { text: 'Stanfor'.slice(0, i) });
    ({ doc: d, history: h } = commit(d, h, patch, {
      label: 'Correct text',
      coalesceKey: 'type:w4',
      now: t0 + i * 50, // well inside COALESCE_MS
    }));
  }
  assert.equal(h.past.length, 1, 'five keystrokes, one undo step');

  // A pause past the window starts a fresh entry.
  ({ doc: d, history: h } = commit(d, h, buildWordPatch(d.words, ['w4'], { text: 'Stanford' }), {
    label: 'Correct text',
    coalesceKey: 'type:w4',
    now: t0 + 250 + COALESCE_MS + 1,
  }));
  assert.equal(h.past.length, 2);

  // The first entry must still invert to the ORIGINAL text, not an intermediate.
  const once = undo(d, h)!;
  const twice = undo(once.doc, once.history)!;
  assert.equal(twice.doc.words.find((w) => w.id === 'w4')!.text, 'word2');
});

test('coalescing never merges across different words', () => {
  let d = doc();
  let h = emptyHistory();
  const now = 5_000;

  ({ doc: d, history: h } = commit(d, h, buildWordPatch(d.words, ['w4'], { text: 'a' }), {
    label: 'Correct text', coalesceKey: 'type:w4', now,
  }));
  ({ doc: d, history: h } = commit(d, h, buildWordPatch(d.words, ['w6'], { text: 'b' }), {
    label: 'Correct text', coalesceKey: 'type:w6', now: now + 10,
  }));

  assert.equal(h.past.length, 2, 'different words are different undo steps');
});

test('breakCoalescing seals the group so the next edit is a new entry', () => {
  let d = doc();
  let h = emptyHistory();
  const now = 7_000;

  ({ doc: d, history: h } = commit(d, h, buildWordPatch(d.words, ['w4'], { text: 'a' }), {
    label: 'Correct text', coalesceKey: 'type:w4', now,
  }));
  h = breakCoalescing(h);
  ({ doc: d, history: h } = commit(d, h, buildWordPatch(d.words, ['w4'], { text: 'ab' }), {
    label: 'Correct text', coalesceKey: 'type:w4', now: now + 10, // inside the window
  }));

  assert.equal(h.past.length, 2, 'a sealed group must not absorb the next edit');
});

test('a slider drag committed once is one entry, and inverts to the original', () => {
  let d = doc();
  let h = emptyHistory();

  const next = { ...CUT, maxGapMs: 350 };
  ({ doc: d, history: h } = commit(d, h, { kind: 'cut', prev: d.cut, next }, {
    label: 'Shorten pauses to 350ms',
  }));

  assert.equal(d.cut.maxGapMs, 350);
  const step = undo(d, h)!;
  assert.equal(step.doc.cut.maxGapMs, Infinity, 'cut settings are undoable');
});

test('redo replays, and a new commit invalidates the redo stack', () => {
  let d = doc();
  let h = emptyHistory();

  ({ doc: d, history: h } = commit(d, h, buildWordPatch(d.words, ['w4'], { deleted: true }), {
    label: 'Delete "word2"',
  }));

  const undone = undo(d, h)!;
  assert.equal(canRedo(undone.history), true);

  const redone = redo(undone.doc, undone.history)!;
  assert.deepEqual(deletedIds(redone.doc), ['w4']);
  assert.equal(canRedo(redone.history), false);

  // Undo, then a fresh edit: the redo future must be dropped.
  const back = undo(redone.doc, redone.history)!;
  const after = commit(back.doc, back.history, buildWordPatch(back.doc.words, ['w0'], { deleted: true }), {
    label: 'Delete "word0"',
  });
  assert.equal(canRedo(after.history), false, 'a new edit invalidates redo');
});

test('invert is an involution', () => {
  const d = doc();
  const patch = buildWordPatch(d.words, ['w0', 'w4'], { deleted: true });
  assert.deepEqual(invertPatch(invertPatch(patch)), patch);
});

test('apply then invert round-trips the document exactly', () => {
  const d = doc();
  const patch = buildWordPatch(d.words, ['w0', 'w4'], { deleted: true, text: 'x' });
  const forward = applyPatch(d, patch);
  const back = applyPatch(forward, invertPatch(patch));
  assert.deepEqual(back.words, d.words);
});

test('applyPatch shares structure — untouched words keep their identity', () => {
  // This is what makes React.memo work. structuredClone breaks it, which is why
  // nothing in the app could be memoised before.
  const d = doc();
  const next = applyPatch(d, buildWordPatch(d.words, ['w4'], { deleted: true }));

  assert.equal(next.words[0], d.words[0], 'untouched words must be the SAME object');
  assert.notEqual(next.words[2], d.words[2], 'the edited word must be a new object');
  assert.notEqual(next, d, 'the doc itself is new');
});

test('a no-op edit produces no history entry', () => {
  const d = doc();
  // w4 is not deleted; "restoring" it changes nothing.
  const patch = buildWordPatch(d.words, ['w4'], { deleted: false });
  assert.equal(isEmptyPatch(patch), true);

  const { history } = commit(d, emptyHistory(), patch, { label: 'Restore' });
  assert.equal(history.past.length, 0, 'Cmd+Z must not burn a step on nothing');
});

test('deleted:undefined and deleted:false are the same state', () => {
  // Word.deleted is optional. Without normalising, "restore" on a never-deleted
  // word would record undefined→false and undo would look like a change.
  const d = doc();
  assert.equal(isEmptyPatch(buildWordPatch(d.words, ['w0'], { deleted: false })), true);
});

test('buildWordPatch only touches the ids it is given', () => {
  const d = doc();
  const patch = buildWordPatch(d.words, ['w4'], { deleted: true });
  assert.equal(patch.kind === 'words' && patch.edits.length, 1);
  assert.equal(patch.kind === 'words' && patch.edits[0].id, 'w4');
});

test('history is bounded by entry count', () => {
  let d = doc(400);
  let h = emptyHistory();

  for (let i = 0; i < MAX_ENTRIES + 25; i++) {
    ({ doc: d, history: h } = commit(d, h, buildWordPatch(d.words, [`w${i * 2}`], { deleted: true }), {
      label: `Delete ${i}`,
      now: i * 10_000, // far apart, so nothing coalesces
    }));
  }
  assert.equal(h.past.length, MAX_ENTRIES);
  assert.equal(undoLabel(h), `Delete ${MAX_ENTRIES + 24}`, 'the newest entry survives');
});

test('undo restores the selection that was live before the edit', () => {
  let d = doc();
  let h = emptyHistory();

  ({ doc: d, history: h } = commit(d, h, buildWordPatch(d.words, ['w4'], { deleted: true }), {
    label: 'Delete',
    selectionBefore: ['w4'],
    selectionAfter: [],
  }));

  assert.deepEqual(undo(d, h)!.selection, ['w4']);
});

test('describeWords keeps the count in the label', () => {
  assert.equal(describeWords(['reality'], 'Delete'), 'Delete "reality"');
  assert.equal(describeWords(['a', 'b', 'c'], 'Delete'), 'Delete "a b c"');
  assert.equal(describeWords(['a', 'b', 'c', 'd'], 'Delete'), 'Delete 4 words');
});

test('undo/redo on an empty history is a safe no-op', () => {
  const d = doc();
  assert.equal(undo(d, emptyHistory()), null);
  assert.equal(redo(d, emptyHistory()), null);
  assert.equal(undoLabel(emptyHistory()), null);
});
