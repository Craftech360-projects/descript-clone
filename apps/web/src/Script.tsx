import {
  memo,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
  type MouseEvent as ReactMouseEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type FocusEvent as ReactFocusEvent,
} from 'react';
import { toParagraphs, speakerLabel, type Paragraph } from '../../../packages/core/src/paragraphs.ts';
import type { Transcript, Word } from '../../../packages/core/src/types.ts';

interface Props {
  transcript: Transcript;
  selection: Set<string>;
  /** Ids to pulse after an undo too large to re-select. */
  flash: Set<string>;
  playingIndex: number;
  showDeleted: boolean;
  /** speaker → `var(--spk-N)`. See speakers.ts for why order, not hash. */
  colors: Map<string | undefined, string>;
  /** `clicks` is the native detail count — 2 means this is half of a double. */
  onWordClick: (index: number, shift: boolean, clicks: number) => void;
  /**
   * Commit a corrected spelling for a word. ASR is not always right — a name or
   * an off-dictionary word comes back misspelled — so double-clicking a word
   * turns it into a field you can fix in place. See correctText in the store:
   * it is undoable and coalesces a burst of typing into one history step.
   */
  onCorrectWord: (id: string, text: string) => void;
  /** Drag-select: the run from the word the drag began on to the one under the cursor now. */
  onSelectRange: (anchorId: string, focusId: string) => void;
  /**
   * Put the keyboard cursor on a word: select it and seek there, or — with
   * `extend` — stretch the live selection's focus end onto it.
   *
   * Deliberately the same two rules a click and a shift-click follow (see
   * moveCursor in App, which clickWord now goes through as well), so the mouse
   * and the keyboard cannot end up disagreeing about what "the selection" is.
   */
  onMoveCursor: (id: string, extend: boolean) => void;
  /** Cut the selection — the same edit the global Backspace makes. */
  onDeleteSelection: () => void;
  /** Open the Transcribe dialog to redo the script. Sits at the end of the page. */
  onRetranscribe: () => void;
}

/**
 * The script IS the document.
 *
 * This is the whole point of Descript's interface: the transcript is not a panel
 * beside a video editor, it is the surface you edit on. It reads like a page —
 * speaker names in the margin, generous measure, a text cursor that doubles as
 * the playhead. The video is subordinate to it.
 */
export default function Script({
  transcript,
  selection,
  flash,
  playingIndex,
  showDeleted,
  colors,
  onWordClick,
  onCorrectWord,
  onSelectRange,
  onMoveCursor,
  onDeleteSelection,
  onRetranscribe,
}: Props) {
  const paragraphs = toParagraphs(transcript);
  const pageRef = useRef<HTMLDivElement>(null);

  // Which word is currently being spelled-corrected inline, if any. A purely
  // local view concern — it is not part of the document — so it lives here and
  // never touches the store until a commit. Double-click or Enter opens it;
  // Enter or a click away commits; Escape cancels. See WordEditor below.
  const [editingId, setEditingId] = useState<string | null>(null);

  // Where focus goes when an edit ENDS ON A KEY. The field is about to unmount,
  // and focus would land on <body> — so a keyboard user who pressed Enter to fix
  // a spelling would lose the cursor and have to Tab back in from the top of the
  // page. A blur-commit must NOT do this: the click that caused the blur has
  // already put focus somewhere the user chose, and yanking it back to the word
  // would fight them.
  const returnFocusTo = useRef<string | null>(null);

  const commitEdit = (id: string, text: string, byKey: boolean) => {
    if (byKey) returnFocusTo.current = id;
    setEditingId(null);
    onCorrectWord(id, text);
  };
  const cancelEdit = (id: string, byKey: boolean) => {
    if (byKey) returnFocusTo.current = id;
    setEditingId(null);
  };

  useEffect(() => {
    const id = returnFocusTo.current;
    if (editingId !== null || id == null) return;
    returnFocusTo.current = null;
    focusWord(id);
  }, [editingId]);

  // Word identity is by index into the flat list — that is what the caller's
  // selection and shift-ranges are expressed in. Ids are NOT indices: real ASR
  // ids run w0, w2, w4…, so this map is the only safe way across.
  const indexOf = new Map(transcript.words.map((w, i) => [w.id, i]));

  // ── the keyboard cursor ─────────────────────────────────────────────────────
  //
  // The words a cursor can stand on, in the order they are painted. NOT
  // transcript.words: with "Show cuts" off a deleted word is not in the DOM at
  // all, so stepping onto one would focus nothing and strand the cursor
  // mid-transcript with no way out but the mouse.
  const visible = showDeleted ? transcript.words : transcript.words.filter((w) => !w.deleted);

  // A roving tabindex: exactly ONE word is tabbable and the rest are -1, so Tab
  // enters the script and then LEAVES it. Making every word tabbable would bury
  // the next control behind 2282 stops, which is a worse trap than not being
  // reachable at all.
  //
  // DOM focus is the real cursor; this state only exists so the right span
  // renders tabIndex=0 and so Tab comes back to the word you left. It FOLLOWS
  // focus (see onFocus below) rather than leading it, which is why every move
  // here is a focusWord() call and not a setState.
  const [cursorId, setCursorId] = useState<string | null>(null);
  const cursorWord = cursorId == null ? undefined : transcript.words[indexOf.get(cursorId) ?? -1];
  // A cursor word that has just been cut is gone from the DOM with "Show cuts"
  // off, and a tabIndex=0 on a span that does not exist takes the whole script
  // out of the tab order. Fall back to the first word.
  const tabbableId =
    cursorWord && (showDeleted || !cursorWord.deleted) ? cursorId : visible[0]?.id ?? null;

  /** Move DOM focus onto a word and bring it on screen. */
  function focusWord(id: string): void {
    const el = pageRef.current?.querySelector<HTMLElement>(`[data-wid="${cssEscape(id)}"] > .w`);
    if (!el) return;
    // 'nearest', explicitly, rather than whatever focus() decides on its own: a
    // step onto a word that is already on screen must not move the page at all,
    // or holding an arrow key walks the transcript out from under you.
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  const moveCursorTo = (id: string, extend: boolean) => {
    onMoveCursor(id, extend);
    focusWord(id);
  };

  /**
   * The word one visual LINE away, in the column you started in.
   *
   * Measured off the DOM rather than computed, because prose wraps: where a line
   * breaks is a layout fact that only the browser knows, and it changes with the
   * splitter, the font and the window. The boxes come out in DOM order, which is
   * `visible` order, so an index here is an index there.
   */
  const lineStep = (at: number, direction: 1 | -1): number => {
    const els = pageRef.current?.querySelectorAll<HTMLElement>('[data-wid] > .w');
    if (!els || els.length !== visible.length) return at;
    const box = (i: number) => els[i].getBoundingClientRect();
    const start = box(at);
    // Vertical OVERLAP, not equal tops: sub-pixel layout and a taller neighbour
    // move `top` by fractions of a pixel, so equality is the first thing to
    // break. Measured on this page: a word box is 22.5px tall and lines sit
    // 29px apart (17px × 1.7), so two real lines clear each other by 6.5px and
    // there is no way for the test to be ambiguous.
    const shares = (a: DOMRect, b: DOMRect) => a.top < b.bottom && b.top < a.bottom;

    // Walk off the line we are on; the first word past it starts the next one.
    let i = at + direction;
    while (i >= 0 && i < els.length && shares(box(i), start)) i += direction;
    if (i < 0 || i >= els.length) return at;

    const line = box(i);
    const column = (start.left + start.right) / 2;
    const gap = (r: DOMRect) => Math.abs((r.left + r.right) / 2 - column);
    let best = i;
    let bestGap = gap(line);
    for (let j = i + direction; j >= 0 && j < els.length; j += direction) {
      const r = box(j);
      if (!shares(r, line)) break;
      // Sweeping a line, the distance to the column falls and then rises. The
      // first rise is the answer; measuring the rest of the line cannot beat it.
      if (gap(r) >= bestGap) break;
      best = j;
      bestGap = gap(r);
    }
    return best;
  };

  /**
   * The transcript, from the keyboard.
   *
   * This lives here and not in App's global handler because every one of these
   * keys means something only in terms of the RENDERED text: which words are on
   * screen, which line they wrapped onto, which one has focus. App keeps the
   * keys that mean something to the whole app (undo, Space, Escape, the razor).
   *
   * Handled keys are stopped, not just prevented — App's window listener binds
   * ArrowLeft/ArrowRight to the transport's word-step, and both firing would
   * scrub the playhead away from the word you just moved onto.
   */
  const onKeyDown = (e: ReactKeyboardEvent) => {
    // Only keys pressed ON a word, and only while none of them is a field.
    // Re-transcribe is a button on this same page and Enter there has to stay
    // Enter-the-button; an open WordEditor stops its own keys before they get
    // this far, and the second test says so out loud rather than relying on it.
    const from = (e.target as HTMLElement).closest<HTMLElement>('[data-wid]')?.dataset.wid;
    if (from == null || editingId != null) return;
    // Shift is the only modifier that means anything here. The rest are commands
    // — Cmd+Z, Cmd+S, Alt+Left for browser-back — and swallowing those to move a
    // word cursor would be a worse bug than not moving it.
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    const at = visible.findIndex((w) => w.id === from);
    if (at === -1) return;

    let to: number;
    switch (e.key) {
      case 'ArrowRight': to = at + 1; break;
      case 'ArrowLeft': to = at - 1; break;
      case 'ArrowDown': to = lineStep(at, 1); break;
      case 'ArrowUp': to = lineStep(at, -1); break;
      case 'Home': to = 0; break;
      case 'End': to = visible.length - 1; break;

      case 'Enter':
        e.preventDefault();
        e.stopPropagation();
        setEditingId(from);
        return;

      case 'Backspace':
      case 'Delete': {
        // With nothing selected there is nothing to cut: leave it to App's
        // handler, which no-ops, rather than swallowing the key here.
        if (selection.size === 0) return;
        // Where the cursor lands afterwards. Every word in the selection is
        // about to go, so the first word PAST it is the first survivor — and
        // landing there is what makes Backspace repeatable, the way holding it
        // down in a text editor eats one word after another. Falling back to the
        // word BEFORE the run covers cutting the tail of the transcript.
        let first = -1;
        let last = -1;
        for (let i = 0; i < visible.length; i++) {
          if (!selection.has(visible[i].id)) continue;
          if (first === -1) first = i;
          last = i;
        }
        const next = visible[last + 1] ?? visible[first - 1];
        e.preventDefault();
        e.stopPropagation();
        onDeleteSelection();
        // Before React unmounts the cut words: this span exists in the DOM we
        // are still standing in, and it survives the re-render (keyed by id), so
        // focus rides through the edit instead of falling to <body>.
        if (next) moveCursorTo(next.id, false);
        return;
      }

      default: return;
    }

    // Swallowed even when the cursor cannot move: at the last word, Right must
    // not fall through to the transport and scrub the playhead off the word you
    // are looking at.
    e.preventDefault();
    e.stopPropagation();
    const target = visible[Math.min(Math.max(to, 0), visible.length - 1)];
    if (target && target.id !== from) moveCursorTo(target.id, e.shiftKey);
  };

  // Focus is the cursor, so the cursor is whatever took focus — a click, a Tab,
  // or one of our own focusWord calls. focusin bubbles, so one handler on the
  // page covers every word without a listener per span.
  const onFocus = (e: ReactFocusEvent) => {
    const wid = (e.target as HTMLElement).closest<HTMLElement>('[data-wid]')?.dataset.wid;
    if (wid) setCursorId(wid);
  };

  // ── drag to select ──────────────────────────────────────────────────────────
  //
  // Selecting words is the app's job, not the browser's. Native text selection
  // is off (user-select: none in app.css), so a press-and-drag would do nothing
  // at all without this. We track the word the drag began on and, on each move,
  // paint the run from there to the word under the cursor — the same anchor/focus
  // model a click uses, so drag and shift-click agree.
  //
  // Refs, not state: a drag fires dozens of moves a second and none of them
  // should re-render this component. Only onSelectRange (which updates the store)
  // causes a repaint, and only when the covered run actually changes.
  const anchorId = useRef<string | null>(null);
  const dragged = useRef(false);
  // The far end of the drag, so the release can leave DOM focus there. The
  // keyboard cursor IS the selection's focus end — without this, a Shift+Arrow
  // straight after a drag would extend from the word the drag STARTED on and
  // collapse everything the drag just painted.
  const dragFocusId = useRef<string | null>(null);

  // Double-click detection, done by hand rather than trusting the native
  // dblclick event or e.detail — both of which the drag-select machinery can
  // eat. Every word click records its id and time; a second click on the same
  // word within the window opens the inline editor. See the word's onClick.
  const lastClick = useRef<{ id: string; at: number }>({ id: '', at: 0 });

  const widUnder = (x: number, y: number): string | null =>
    document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-wid]')?.dataset.wid ?? null;

  const onPointerDown = (e: ReactPointerEvent) => {
    // Left button only, and only when the press lands on a word — a press on the
    // background is a "clear selection", handled by onMouseDown below.
    if (e.button !== 0) return;
    const wid = (e.target as HTMLElement).closest<HTMLElement>('[data-wid]')?.dataset.wid;
    if (!wid) return;
    anchorId.current = wid;
    dragged.current = false;
    // NOTE: capture is deliberately NOT taken here. A pointer captured on press
    // redirects the click that follows to .page — and, worse, the SECOND click of
    // a double-click — so it never reaches the word. That silently broke
    // double-click-to-edit. Capture is now taken on the first real drag move
    // below, once we actually know this is a drag and not a click.
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    // buttons === 1: left button still held. A hover with no press must not select.
    if (anchorId.current == null || e.buttons !== 1) return;
    const wid = widUnder(e.clientX, e.clientY);
    if (!wid) return;
    // Stay a plain click until the cursor actually crosses onto another word, so
    // a click with a hand-tremor still seeks-and-toggles instead of selecting.
    if (!dragged.current && wid === anchorId.current) return;
    // First move that proves this is a drag: NOW take the capture, so a fast drag
    // that outruns the pointer still delivers its moves here. Taking it here
    // rather than on press is what keeps plain clicks (and double-clicks) intact.
    if (!dragged.current) {
      dragged.current = true;
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* no pointer */ }
    }
    dragFocusId.current = wid;
    onSelectRange(anchorId.current, wid);
  };

  const onPointerUp = () => {
    anchorId.current = null;
    if (dragged.current && dragFocusId.current) focusWord(dragFocusId.current);
    dragFocusId.current = null;
  };

  // A drag ends in a click event on the anchor word; left unchecked it would run
  // the click handler and collapse the very selection the drag just made. Swallow
  // it in the capture phase, before it reaches the word.
  const onClickCapture = (e: ReactMouseEvent) => {
    if (!dragged.current) return;
    e.stopPropagation();
    dragged.current = false;
  };

  return (
    // Clearing the selection by clicking empty space is handled one level up, on
    // the whole .script surface (see App.tsx) — the page is only 640px wide and
    // as tall as its text, so the black gutters and the area below the last line
    // are NOT this element. Catching background clicks here left most of the
    // obvious "empty" space dead; the scroll container is the honest hit target.
    <div
      className="page"
      ref={pageRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onClickCapture={onClickCapture}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
    >
      {paragraphs.map((para, p) => {
        const previous = paragraphs[p - 1];
        return (
          <Para
            key={para.words[0]?.id ?? p}
            para={para}
            showSpeaker={previous?.speaker !== para.speaker}
            selection={selection}
            flash={flash}
            playingIndex={playingIndex}
            showDeleted={showDeleted}
            color={colors.get(para.speaker)}
            indexOf={indexOf}
            editingId={editingId}
            tabbableId={tabbableId}
            lastClick={lastClick}
            onWordClick={onWordClick}
            onStartEdit={setEditingId}
            onCommitEdit={commitEdit}
            onCancelEdit={cancelEdit}
          />
        );
      })}

      {/* The script's own end-matter. Re-transcribing is a thing you do TO this
        * text, so its button lives where the text ends rather than in a side
        * panel — the way you would reach for "start over" after reading through. */}
      <div className="script-end">
        <button type="button" className="retrans" onClick={onRetranscribe}>
          Re-transcribe…
        </button>
        {/* The keys, where the text ends.
          *
          * Only Enter is genuinely undiscoverable — the arrows are already in
          * the transport's tooltips and Backspace is named in the rail — but a
          * legend that listed one key would read as a list of one. It sits at
          * the foot of the page as a footnote, at the quietest weight the
          * palette has, because it is reference and not an affordance. */}
        <p className="script-keys">
          <kbd>←</kbd> <kbd>→</kbd> <kbd>↑</kbd> <kbd>↓</kbd> move · <kbd>Shift</kbd> select ·{' '}
          <kbd>Enter</kbd> fix a spelling · <kbd>Backspace</kbd> cut
        </p>
      </div>
    </div>
  );
}

interface ParaProps {
  para: Paragraph;
  showSpeaker: boolean;
  selection: Set<string>;
  flash: Set<string>;
  playingIndex: number;
  showDeleted: boolean;
  color: string | undefined;
  indexOf: Map<string, number>;
  /** The word being spelling-corrected, or null. Passed to every paragraph, but
   * only the one holding it swaps its span for a field — the rest ignore it. */
  editingId: string | null;
  /** The one word carrying tabIndex=0. Same deal: every paragraph is told, one acts. */
  tabbableId: string | null;
  /** Shared across paragraphs so a double-click is detected wherever it lands. */
  lastClick: MutableRefObject<{ id: string; at: number }>;
  onWordClick: (index: number, shift: boolean, clicks: number) => void;
  onStartEdit: (id: string) => void;
  onCommitEdit: (id: string, text: string, byKey: boolean) => void;
  onCancelEdit: (id: string, byKey: boolean) => void;
}

/**
 * Memoised per paragraph. With structural sharing upstream, editing one word
 * re-renders ~60 spans instead of all 2282 — the old structuredClone broke every
 * object identity, so this boundary could not have worked at all.
 */
const Para = memo(function Para({
  para,
  showSpeaker,
  selection,
  flash,
  playingIndex,
  showDeleted,
  color,
  indexOf,
  editingId,
  tabbableId,
  lastClick,
  onWordClick,
  onStartEdit,
  onCommitEdit,
  onCancelEdit,
}: ParaProps) {
  const visible = showDeleted ? para.words : para.words.filter((w) => !w.deleted);
  if (visible.length === 0) return null;

  return (
    // --spk cascades to both the margin label and the rule down the text, so a
    // speaker's colour cannot disagree with itself. Consecutive paragraphs from
    // one speaker resolve to the same colour, which is what makes the rule read
    // as continuous down a whole turn.
    <section className="para" style={color ? ({ ['--spk' as string]: color }) : undefined}>
      <div className="speaker">
        {showSpeaker && (
          <>
            <span className="name">{speakerLabel(para.speaker)}</span>
            <span className="tc">{timecode(para.start)}</span>
          </>
        )}
      </div>

      <p className="text">
        {visible.map((word, v) => {
          const i = indexOf.get(word.id)!;
          const selected = selection.has(word.id);
          // A selection should read as one continuous bar, not a row of pills.
          // The space lives on the wrapper, so the wrapper carries the highlight
          // whenever this word AND the next one are both in the run — which
          // leaves the trailing space after the last word unhighlighted, exactly
          // as a text editor does.
          const runsOn = selected && !!visible[v + 1] && selection.has(visible[v + 1].id);
          const editing = word.id === editingId;

          return (
            // The space lives OUTSIDE the .w span, as a real text node: inside,
            // it would take the hover highlight with it, and a CSS ::after space
            // collapses and kills line wrapping.
            //
            // data-wid rides on this OUTER wrapper, not on .w, so a DOM Range
            // landing in the space still maps to its preceding word.
            <span key={word.id} data-wid={word.id} className={runsOn ? 'wrap run' : 'wrap'}>
              {editing ? (
                <WordEditor
                  initial={word.text}
                  className={className(word, false, selected, false) + ' editing'}
                  onCommit={(text, byKey) => onCommitEdit(word.id, text, byKey)}
                  onCancel={(byKey) => onCancelEdit(word.id, byKey)}
                />
              ) : (
                <span
                  className={className(word, i === playingIndex, selected, flash.has(word.id))}
                  /**
                   * Roving tabindex. One word in the whole script is tabbable;
                   * the others are -1 so the cursor can be MOVED onto them
                   * without any of them being a Tab stop.
                   *
                   * No role, deliberately. The obvious candidate is a listbox of
                   * options, but that would make a screen reader announce the
                   * transcript as 2282 options instead of reading it as the
                   * prose it is — and role="button" is worse still: App's Space
                   * handler steps aside for [role="button"], so play/pause would
                   * die on every focused word to activate a span that has no
                   * activation behaviour at all.
                   */
                  tabIndex={word.id === tabbableId ? 0 : -1}
                  aria-keyshortcuts="Enter Backspace"
                  // Single click selects and seeks (handled upstream). A second
                  // click on the SAME word within 450ms opens the inline editor.
                  // We time it ourselves rather than trust the native dblclick /
                  // e.detail, either of which the drag-select machinery can eat.
                  onClick={(e) => {
                    onWordClick(i, e.shiftKey, e.detail);
                    const prev = lastClick.current;
                    if (prev.id === word.id && e.timeStamp - prev.at < 450) {
                      lastClick.current = { id: '', at: 0 };
                      onStartEdit(word.id);
                    } else {
                      lastClick.current = { id: word.id, at: e.timeStamp };
                    }
                  }}
                >
                  {word.text}
                </span>
              )}{' '}
            </span>
          );
        })}
      </p>
    </section>
  );
});

interface WordEditorProps {
  initial: string;
  className: string;
  /** `byKey` distinguishes Enter/Escape from a click-away — see returnFocusTo. */
  onCommit: (text: string, byKey: boolean) => void;
  onCancel: (byKey: boolean) => void;
}

/**
 * A single word, made editable in place.
 *
 * contentEditable rather than an <input>: an input is a replaced element that
 * cannot line-wrap with the prose around it, so a word at the end of a line
 * would jump to its own box. A contentEditable span flows exactly where the
 * word did. React must not own its children while it is live — a re-render
 * would move the caret to the start on every keystroke — so the text is set
 * once, imperatively, and this element renders empty.
 *
 * The global shortcut handler in App already skips keys typed inside a
 * contentEditable, so Space, Backspace and the arrows all reach the field
 * instead of scrubbing the transport.
 */
function WordEditor({ initial, className, onCommit, onCancel }: WordEditorProps) {
  const ref = useRef<HTMLSpanElement>(null);
  // Enter, Escape and blur all race to end the edit; the first one wins and the
  // rest no-op, so a value is never committed twice or committed after a cancel.
  const done = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.textContent = initial;
    el.focus();
    // Select the whole word, the way double-clicking a word anywhere does, so
    // the correction can be typed straight over it.
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }, [initial]);

  const finish = (commit: boolean, byKey: boolean) => {
    if (done.current) return;
    done.current = true;
    // Collapse any pasted newlines/runs of space — this is one word, always.
    const text = (ref.current?.textContent ?? '').replace(/\s+/g, ' ').trim();
    // An empty field is a cancel, not a delete: use the transcript's own
    // delete for that, which is reversible and cuts the media too.
    if (commit && text) onCommit(text, byKey);
    else onCancel(byKey);
  };

  return (
    <span
      ref={ref}
      className={className}
      contentEditable
      suppressContentEditableWarning
      spellCheck={false}
      role="textbox"
      aria-label={`Edit word: ${initial}`}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); finish(true, true); }
        else if (e.key === 'Escape') { e.preventDefault(); finish(false, true); }
        // Keep keystrokes off the page's shortcut handler regardless.
        e.stopPropagation();
      }}
      onBlur={() => finish(true, false)}
      // While it is a field it is not a word: swallow the click/drag/double-click
      // gestures so they neither seek nor re-open the editor mid-edit.
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    />
  );
}

function className(word: Word, playing: boolean, selected: boolean, flashing: boolean): string {
  return [
    'w',
    word.deleted ? 'cut' : '',
    word.isFiller && !word.deleted ? 'filler' : '',
    selected ? 'sel' : '',
    playing ? 'playing' : '',
    flashing ? 'flash' : '',
  ]
    .filter(Boolean)
    .join(' ');
}

/** Ids come from ASR, so they are not guaranteed to be selector-safe. */
function cssEscape(value: string): string {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(value) : value;
}

function timecode(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
