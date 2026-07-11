import { toParagraphs, speakerLabel } from '../../../packages/core/src/paragraphs.ts';
import type { Transcript } from '../../../packages/core/src/types.ts';

interface Props {
  transcript: Transcript;
  selection: Set<string>;
  playingIndex: number;
  showDeleted: boolean;
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
  playingIndex,
  showDeleted,
  onWordClick,
  onWordDoubleClick,
  onBackgroundClick,
}: Props) {
  const paragraphs = toParagraphs(transcript);

  // Word identity is by index into the flat list — that is what the caller's
  // selection and shift-ranges are expressed in.
  const indexOf = new Map(transcript.words.map((w, i) => [w.id, i]));

  return (
    <div className="page" onMouseDown={(e) => e.target === e.currentTarget && onBackgroundClick()}>
      {paragraphs.map((para, p) => {
        const visible = showDeleted ? para.words : para.words.filter((w) => !w.deleted);
        if (visible.length === 0) return null;

        const previous = paragraphs[p - 1];
        const sameSpeaker = previous?.speaker === para.speaker;

        return (
          <section key={p} className="para">
            <div className="speaker">
              {!sameSpeaker && (
                <>
                  <span className="name">{speakerLabel(para.speaker)}</span>
                  <span className="tc">{timecode(para.start)}</span>
                </>
              )}
            </div>

            <p className="text">
              {visible.map((word) => {
                const i = indexOf.get(word.id)!;
                return (
                  // The space lives OUTSIDE the span, as a real text node: inside,
                  // it would take the hover and selection highlight with it, and
                  // a CSS ::after space collapses and kills line wrapping.
                  <span key={word.id}>
                    <span
                      className={[
                        'w',
                        word.deleted ? 'cut' : '',
                        word.isFiller && !word.deleted ? 'filler' : '',
                        selection.has(word.id) ? 'sel' : '',
                        i === playingIndex ? 'playing' : '',
                      ].filter(Boolean).join(' ')}
                      title={`${word.start.toFixed(2)}s`}
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
      })}
    </div>
  );
}

function timecode(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
