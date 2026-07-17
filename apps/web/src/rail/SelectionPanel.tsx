import { Field, Hint } from '../ui/Field.tsx';
import { timecode } from '../../../../packages/core/src/timeline.ts';
import { speakerLabel } from '../../../../packages/core/src/paragraphs.ts';
import type { Word } from '../../../../packages/core/src/types.ts';

interface Props {
  words: Word[];
  onDelete: () => void;
  onRestore: () => void;
  onPlaySelection: () => void;
}

/** What the rail shows when words are selected: facts, and what you can do. */
export default function SelectionPanel({ words, onDelete, onRestore, onPlaySelection }: Props) {
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

      {cut > 0 && cut < words.length && (
        <Hint>{cut} of these {words.length} words are already cut.</Hint>
      )}
      {fillers > 0 && (
        <Hint>{fillers} {fillers === 1 ? 'is a flagged filler' : 'are flagged fillers'}.</Hint>
      )}
    </div>
  );
}
