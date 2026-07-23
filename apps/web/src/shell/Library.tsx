import Icon from '../ui/Icon.tsx';
import type { Speaker } from '../speakers.ts';
import type { Clip, MediaItem } from '../api.ts';

interface Props {
  library: MediaItem[];
  openId: string | null;
  speakers: Speaker[];
  hasScript: boolean;
  importing: boolean;
  /** The open project's clips, in play order. Empty when nothing is open. */
  clips: Clip[];
  activeClipId: string | null;
  addingClip: boolean;
  onAddClip: (file: File) => void;
  onRemoveClip: (clipId: string) => void;
  onMoveClip: (clipId: string, delta: -1 | 1) => void;
  onSelectClip: (clip: Clip) => void;
  /** The drawer is open. When closed it stays mounted (off-canvas) so it slides. */
  open: boolean;
  onClose: () => void;
  onOpen: (id: string) => void;
  onImport: (file: File) => void;
  onSeek: (time: number) => void;
}

/** m:ss for a clip's length. */
function clipTime(seconds: number): string {
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * The left rail: what is open, and who is in it.
 *
 * A drawer, not a column: it holds the two genuinely navigational things —
 * what media is open, and who is in it — behind the ☰, so the transcript can
 * own the left edge. It stays mounted while closed (translated off-canvas) so
 * opening and closing slide. A scrim over the workspace catches the click that
 * dismisses it.
 */
export default function Library({
  library,
  openId,
  speakers,
  hasScript,
  importing,
  clips,
  activeClipId,
  addingClip,
  onAddClip,
  onRemoveClip,
  onMoveClip,
  onSelectClip,
  open,
  onClose,
  onOpen,
  onImport,
  onSeek,
}: Props) {
  return (
    <>
      {open && <div className="lib-scrim" onClick={onClose} />}
      <aside className={open ? 'library open' : 'library'} aria-hidden={!open}>
        <div className="lib-top">
          <h2>Library</h2>
          <button className="icon" onClick={onClose} aria-label="Close library">
            <Icon name="close" size={16} />
          </button>
        </div>

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
            </li>
          ))}
        </ul>

        {importing && <p className="lib-empty">Importing…</p>}
      </section>

      {/* The clips that make up the OPEN project, in play order. This is where a
        * second video is added into the current project — as opposed to Media
        * above, where a file becomes its own new project. */}
      {clips.length > 0 && (
        <section className="lib-section">
          <div className="lib-head">
            <h3>Clips</h3>
            <label className="import" title="Add a clip to this project">
              <Icon name="plus" size={13} />
              <input
                type="file"
                accept="video/*,audio/*"
                disabled={addingClip}
                onChange={(e) => e.target.files?.[0] && onAddClip(e.target.files[0])}
              />
            </label>
          </div>

          <ul className="clip-list">
            {clips.map((c, i) => (
              <li key={c.id} className={c.id === activeClipId ? 'clip-row on' : 'clip-row'}>
                <button className="clip-main" onClick={() => onSelectClip(c)} title="Jump to this clip">
                  <span className="kind">
                    <Icon name={c.hasVideo ? 'video' : 'audio'} size={14} />
                  </span>
                  <span className="clip-nm">Clip {i + 1}</span>
                  <span className="clip-dur">{clipTime(c.duration)}</span>
                </button>
                <span className="clip-order">
                  <button
                    className="icon clip-move"
                    aria-label={`Move clip ${i + 1} earlier`}
                    title="Move earlier"
                    disabled={i === 0 || addingClip}
                    onClick={() => onMoveClip(c.id, -1)}
                  >
                    ▲
                  </button>
                  <button
                    className="icon clip-move"
                    aria-label={`Move clip ${i + 1} later`}
                    title="Move later"
                    disabled={i === clips.length - 1 || addingClip}
                    onClick={() => onMoveClip(c.id, 1)}
                  >
                    ▼
                  </button>
                </span>
                <button
                  className="icon clip-x"
                  aria-label={`Remove clip ${i + 1}`}
                  title={clips.length <= 1 ? 'A project needs at least one clip' : 'Remove clip'}
                  disabled={clips.length <= 1 || addingClip}
                  onClick={() => onRemoveClip(c.id)}
                >
                  <Icon name="close" size={13} />
                </button>
              </li>
            ))}
          </ul>

          {addingClip && <p className="lib-empty">Adding clip…</p>}
        </section>
      )}

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
    </>
  );
}
