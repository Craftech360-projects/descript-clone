import {
  memo,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
  type MouseEvent as ReactMouseEvent,
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
  onRetranscribe,
}: Props) {
  const paragraphs = toParagraphs(transcript);

  // Which word is currently being spelled-corrected inline, if any. A purely
  // local view concern — it is not part of the document — so it lives here and
  // never touches the store until a commit. Double-click opens it; Enter or a
  // click away commits; Escape cancels. See WordEditor below.
  const [editingId, setEditingId] = useState<string | null>(null);
  const commitEdit = (id: string, text: string) => {
    setEditingId(null);
    onCorrectWord(id, text);
  };

  // Word identity is by index into the flat list — that is what the caller's
  // selection and shift-ranges are expressed in. Ids are NOT indices: real ASR
  // ids run w0, w2, w4…, so this map is the only safe way across.
  const indexOf = new Map(transcript.words.map((w, i) => [w.id, i]));

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
    onSelectRange(anchorId.current, wid);
  };

  const onPointerUp = () => {
    anchorId.current = null;
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
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onClickCapture={onClickCapture}
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
            lastClick={lastClick}
            onWordClick={onWordClick}
            onStartEdit={setEditingId}
            onCommitEdit={commitEdit}
            onCancelEdit={() => setEditingId(null)}
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
  /** Shared across paragraphs so a double-click is detected wherever it lands. */
  lastClick: MutableRefObject<{ id: string; at: number }>;
  onWordClick: (index: number, shift: boolean, clicks: number) => void;
  onStartEdit: (id: string) => void;
  onCommitEdit: (id: string, text: string) => void;
  onCancelEdit: () => void;
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
                  onCommit={(text) => onCommitEdit(word.id, text)}
                  onCancel={onCancelEdit}
                />
              ) : (
                <span
                  className={className(word, i === playingIndex, selected, flash.has(word.id))}
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
  onCommit: (text: string) => void;
  onCancel: () => void;
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

  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    // Collapse any pasted newlines/runs of space — this is one word, always.
    const text = (ref.current?.textContent ?? '').replace(/\s+/g, ' ').trim();
    // An empty field is a cancel, not a delete: use the transcript's own
    // delete for that, which is reversible and cuts the media too.
    if (commit && text) onCommit(text);
    else onCancel();
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
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
        // Keep keystrokes off the page's shortcut handler regardless.
        e.stopPropagation();
      }}
      onBlur={() => finish(true)}
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

function timecode(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
