import Icon from '../ui/Icon.tsx';
import type { Speaker } from '../speakers.ts';
import type { MediaItem } from '../api.ts';

interface Props {
  library: MediaItem[];
  openId: string | null;
  speakers: Speaker[];
  hasScript: boolean;
  importing: boolean;
  onOpen: (id: string) => void;
  onImport: (file: File) => void;
  onSeek: (time: number) => void;
}

/**
 * The left rail: what is open, and who is in it.
 *
 * This panel was 216px wide holding exactly one row — roughly 780px of unbroken
 * void, and the loudest "unfinished" signal in the window. The fix is not to
 * delete it (a media list is genuinely navigational) but to give it the second
 * thing that is genuinely navigational: the speakers, which the transcript
 * already knows and the UI was throwing away.
 */
export default function Library({
  library,
  openId,
  speakers,
  hasScript,
  importing,
  onOpen,
  onImport,
  onSeek,
}: Props) {
  return (
    <aside className="library">
      <section className="lib-section">
        <div className="lib-head">
          <h3>Media</h3>
          <label className="import" title="Import media">
            <Icon name="plus" size={13} />
            <input
              type="file"
              accept="video/*,audio/*"
              onChange={(e) => e.target.files?.[0] && onImport(e.target.files[0])}
            />
          </label>
        </div>

        {library.length === 0 && !importing && (
          <p className="lib-empty">Import a file to start. Nothing is transcribed until you ask.</p>
        )}

        <ul className="items">
          {library.map((m) => (
            <li
              key={m.id}
              className={m.id === openId ? 'item on' : 'item'}
              onClick={() => onOpen(m.id)}
            >
              <span className="kind">
                <Icon name={m.hasVideo ? 'video' : 'audio'} size={14} />
              </span>
              <span className="nm" title={m.name}>{m.name}</span>
              <span className={m.status === 'transcribed' ? 'st done' : 'st'}>
                {m.status === 'transcribed' ? 'script' : 'raw'}
              </span>
            </li>
          ))}
        </ul>

        {importing && <p className="lib-empty">Importing…</p>}
      </section>

      {hasScript && (
        <section className="lib-section">
          <div className="lib-head">
            <h3>Speakers</h3>
            <span className="lib-count">{speakers.length}</span>
          </div>

          {speakers.length === 0 ? (
            <p className="lib-empty">This transcript has no speaker labels.</p>
          ) : (
            <ul className="spk-list">
              {speakers.map((s) => (
                <li key={s.label} className="spk-row">
                  {/* The dot is the legend for the rule down the script margin —
                    * same custom property, so they cannot drift apart. */}
                  <span className="spk-dot" style={{ ['--spk' as string]: s.color }} />
                  <button
                    className="spk-name"
                    onClick={() => onSeek(s.start)}
                    title={`Jump to where ${s.label} first speaks`}
                  >
                    {s.label}
                  </button>
                  <span className="spk-count">{s.words.toLocaleString()}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </aside>
  );
}
