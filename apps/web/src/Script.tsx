import { memo } from 'react';
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
  onWordClick: (index: number, shift: boolean) => void;
  onWordDoubleClick: (index: number) => void;
  onBackgroundClick: () => void;
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
  onWordDoubleClick,
  onBackgroundClick,
}: Props) {
  const paragraphs = toParagraphs(transcript);

  // Word identity is by index into the flat list — that is what the caller's
  // selection and shift-ranges are expressed in. Ids are NOT indices: real ASR
  // ids run w0, w2, w4…, so this map is the only safe way across.
  const indexOf = new Map(transcript.words.map((w, i) => [w.id, i]));

  return (
    <div className="page" onMouseDown={(e) => e.target === e.currentTarget && onBackgroundClick()}>
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
            onWordClick={onWordClick}
            onWordDoubleClick={onWordDoubleClick}
          />
        );
      })}
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
  onWordClick: (index: number, shift: boolean) => void;
  onWordDoubleClick: (index: number) => void;
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
  onWordClick,
  onWordDoubleClick,
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

          return (
            // The space lives OUTSIDE the .w span, as a real text node: inside,
            // it would take the hover highlight with it, and a CSS ::after space
            // collapses and kills line wrapping.
            //
            // data-wid rides on this OUTER wrapper, not on .w, so a DOM Range
            // landing in the space still maps to its preceding word.
            <span key={word.id} data-wid={word.id} className={runsOn ? 'wrap run' : 'wrap'}>
              <span
                className={className(word, i === playingIndex, selected, flash.has(word.id))}
                onClick={(e) => onWordClick(i, e.shiftKey)}
                onDoubleClick={() => onWordDoubleClick(i)}
              >
                {word.text}
              </span>{' '}
            </span>
          );
        })}
      </p>
    </section>
  );
});

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
