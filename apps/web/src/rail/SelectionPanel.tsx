import { Field, Hint } from '../ui/Field.tsx';
import { timecode } from '../../../../packages/core/src/timeline.ts';
import { speakerLabel } from '../../../../packages/core/src/paragraphs.ts';
import type { Word } from '../../../../packages/core/src/types.ts';

interface Props {
  words: Word[];
  onDelete: () => void;
  onRestore: () => void;
  onPlaySelection: () => void;
  /**
   * Push in on exactly these words. Absent on an audio-only project, which has
   * no picture to push in on.
   */
  onPunchIn?: () => void;
  /**
   * Why the push-in cannot be made here — an existing one already covers part of
   * this selection. Stated rather than left as a dead button.
   */
  punchBlocked?: string | null;
}

/** What the rail shows when words are selected: facts, and what you can do. */
export default function SelectionPanel({
  words,
  onDelete,
  onRestore,
  onPlaySelection,
  onPunchIn,
  punchBlocked,
}: Props) {
  const first = words[0];
  const last = words[words.length - 1];
  const start = first.start;
  const end = last.end;

  const cut = words.filter((w) => w.deleted).length;
  const fillers = words.filter((w) => w.isFiller && !w.deleted).length;
  const speakers = [...new Set(words.map((w) => w.speaker))];

  return (
    <div className="panel">
      <div className="hero">
        <strong>{words.length === 1 ? `"${first.text}"` : `${words.length} words`}</strong>
        <small>{timecode(end - start, { ms: true })} · {speakers.map(speakerLabel).join(', ')}</small>
      </div>

      <div className="readout">
        <span>in {timecode(start, { ms: true })}</span>
        <span>out {timecode(end, { ms: true })}</span>
      </div>

      <Field label="Edit">
        {/* Every action names its shortcut. The rail is a third discovery
          * surface, and it costs nothing. */}
        <button onClick={onDelete} disabled={cut === words.length}>
          Delete <kbd>Backspace</kbd>
        </button>
        <button onClick={onRestore} disabled={cut === 0}>
          Restore <kbd>Ctrl D</kbd>
        </button>
        <button onClick={onPlaySelection}>Play selection</button>
      </Field>

      {/* The picture, for as long as these words last.
        *
        * It belongs here and not in the Frame panel because the decision it
        * makes is WHEN, and when is a range of words — which is the one thing
        * this panel already has and the Frame panel would have to invent a
        * second timeline to express. The other half (WHAT to push in on) is a
        * spatial judgement and happens on the monitor, which is why this button
        * hands straight over to a marquee rather than opening more controls. */}
      {onPunchIn && (
        <Field label="Picture">
          <button onClick={onPunchIn} disabled={Boolean(punchBlocked)}>
            Push in here
          </button>
          {punchBlocked ? <Hint>{punchBlocked}</Hint> : (
            <Hint>Then drag a box around what to follow.</Hint>
          )}
        </Field>
      )}

      {cut > 0 && cut < words.length && (
        <Hint>{cut} of these {words.length} words are already cut.</Hint>
      )}
      {fillers > 0 && (
        <Hint>{fillers} {fillers === 1 ? 'is a flagged filler' : 'are flagged fillers'}.</Hint>
      )}
    </div>
  );
}
