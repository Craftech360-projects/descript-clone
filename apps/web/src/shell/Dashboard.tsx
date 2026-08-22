import { useEffect, useRef, useState } from 'react';
import Icon from '../ui/Icon.tsx';
import { timecode } from '../../../../packages/core/src/timeline.ts';
import type { Folder, MediaItem } from '../api.ts';

interface Props {
  projects: MediaItem[];
  /** Every folder, for the top level. */
  folders: Folder[];
  /**
   * The folder currently open, or null at the top level.
   *
   * Navigation state rather than a filter: the dashboard shows FOLDERS until you
   * are inside one, and projects only within. A project belongs somewhere.
   */
  openFolder: Folder | null;
  onOpenFolder: (id: string | null) => void;
  onCreateFolder: (name: string) => void;
  onRenameFolder: (id: string, name: string) => void;
  onDeleteFolder: (id: string) => void;
  /** Save the open folder's memory — what the AI should know about this work. */
  onSaveBrief: (id: string, brief: string) => void;
  /** Put a project in a different folder. '' means Unfiled. */
  onMoveProject: (id: string, folderId: string) => void;
  /** An import is in flight — a placeholder card holds its slot. */
  importing: boolean;
  /** Progress of the job behind the import, 0..1, or null when there is none. */
  progress: number | null;
  /** A project is being opened; the grid goes inert so nothing double-fires. */
  opening: boolean;
  onOpen: (id: string) => void;
  /** Delete the project and the media behind it. The card confirms first. */
  onDelete: (id: string) => void;
  /** Rename it. Already trimmed, non-empty, and never the name it already had. */
  onRename: (id: string, name: string) => void;
  onImport: (file: File) => void;
  error: string | null;
  onDismissError: () => void;
  /** Open the API-keys dialog (assistant + transcription credentials). */
  onOpenSettings: () => void;
}

/**
 * "3 days ago" — the only date form worth the width on a card.
 *
 * An absolute date answers a question nobody asked of their own work; what you
 * actually want to know at a glance is which of these you touched last, and the
 * grid is already in that order. Past a fortnight the relative form stops
 * meaning anything, so it hands over to the real date.
 */
function ago(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 14) return `${days} days ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * The frame a card wears.
 *
 * A still the server cut with one ffmpeg seek — see poster.ts for why it is not
 * the filmstrip sheets and not a <video> in the grid. Audio has no picture to
 * take, and a cover that 404s is not worth a broken-image glyph, so both fall
 * back to the mark.
 */
function Poster({ item }: { item: MediaItem }) {
  const [failed, setFailed] = useState(false);

  if (!item.posterUrl || failed) {
    return (
      <div className="dc-poster dc-poster-blank">
        <Icon name={item.hasVideo ? 'video' : 'audio'} size={26} />
      </div>
    );
  }

  return (
    <div className="dc-poster">
      <img src={item.posterUrl} alt="" loading="lazy" onError={() => setFailed(true)} />
    </div>
  );
}

function ProjectCard({ item, folders, onOpen, onDelete, onRename, onMove }: {
  item: MediaItem;
  /** Everywhere this project could go, for the move menu. */
  folders: Folder[];
  onOpen: () => void;
  onDelete: () => void;
  onRename: (name: string) => void;
  /** '' takes it out of every folder and back to Unfiled. */
  onMove: (folderId: string) => void;
}) {
  /* Moving is a menu rather than a drag: a drag needs a visible target, and the
   * folder you want is on the previous screen. */
  const [moving, setMoving] = useState(false);
  /* Deleting takes the media file with it and there is no undo on either side,
   * so the button arms the card rather than firing. The confirmation is the card
   * itself — a modal would ask "are you sure?" about a project it cannot show
   * you, while this covers the very poster you are deciding about. */
  const [arming, setArming] = useState(false);
  /* The name being typed, or null when the card is showing the real one. A
   * string so "" is a state the field can pass through; it is validated once, on
   * commit. Same shape as the transport's custom speed, for the same reason. */
  const [draft, setDraft] = useState<string | null>(null);
  /** Set by Escape, so the blur it causes throws the draft away instead of taking it. */
  const cancelled = useRef(false);

  const transcribed = item.status === 'transcribed';
  const parts = [
    timecode(item.duration, { ms: false }),
    item.hasVideo ? `${item.width}×${item.height}` : 'Audio',
    ago(item.createdAt),
  ];

  const commit = () => {
    const name = (draft ?? '').replace(/\s+/g, ' ').trim();
    const abandon = cancelled.current;
    cancelled.current = false;
    setDraft(null);
    // Blank means "never mind", not "call it nothing": clearing the field and
    // clicking away is a cancel, and the server would refuse it anyway.
    if (!abandon && name && name !== item.name) onRename(name);
  };

  /* Identical under both branches, so it is written once rather than kept in
   * sync twice. The rename swaps the title for a field; everything below it is
   * the same card. */
  const meta = (
    <span className="dc-meta">
      <span className="dc-dur">{parts[0]}</span>
      <span className="dc-dot" aria-hidden="true" />
      <span>{parts[1]}</span>
      <span className="dc-dot" aria-hidden="true" />
      <span>{parts[2]}</span>
    </span>
  );

  /* A wrapper, because the card is a <button> and a button can hold neither
   * another button nor a text field. The slot is the grid cell; the card and its
   * actions are siblings inside it. */
  return (
    <div className="dcard-slot">
      {draft === null ? (
        <button className="dcard" onClick={onOpen} title={`Open ${item.name}`}>
          <Poster item={item} />
          <span className="dc-body">
            <span className="dc-name">{item.name}</span>
            {meta}
          </span>
          {/* Only the exception is worth a badge. A library where everything is
            * transcribed would otherwise wear a row of identical pills saying so —
            * noise on every card to carry information on none. Absent means ready;
            * present means this one still needs a pass before it can be edited. */}
          {!transcribed && <span className="dc-pill">No script</span>}
        </button>
      ) : (
        <div className="dcard renaming">
          <Poster item={item} />
          <div className="dc-body">
            <input
              className="dc-rename"
              type="text"
              aria-label="Project name"
              value={draft}
              maxLength={120}
              autoFocus
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              // Both keys leave through blur, so commit is the single exit and
              // the only thing that can change the name.
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
                else if (e.key === 'Escape') {
                  cancelled.current = true;
                  e.currentTarget.blur();
                }
              }}
              // The card is inside a drop target; a drag that starts in a text
              // field would otherwise read as a file arriving.
              onDragEnter={(e) => e.stopPropagation()}
            />
            {meta}
          </div>
        </div>
      )}

      {/* Over the poster, opposite the status pill, and revealed by hover or by
        * focus — so they are reachable from the keyboard without sitting on
        * every card at rest. Two direct buttons rather than an ⋯ menu: there are
        * only two, and this app has no popover to borrow. */}
      <div className="dc-acts">
        <button
          className="dc-act"
          aria-label={`Move ${item.name} to another folder`}
          title="Move to folder"
          onClick={() => setMoving((v) => !v)}
        >
          <Icon name="video" size={13} />
        </button>
        <button
          className="dc-act"
          aria-label={`Rename ${item.name}`}
          title="Rename"
          onClick={() => setDraft(item.name)}
        >
          <Icon name="pencil" size={13} />
        </button>
        <button
          className="dc-act dc-x"
          aria-label={`Delete ${item.name}`}
          title="Delete project"
          onClick={() => setArming(true)}
        >
          <Icon name="trash" size={13} />
        </button>
      </div>

      {moving && (
        <div className="dc-move">
          <p>Move “{item.name}” to</p>
          <select
            autoFocus
            value={item.folderId ?? ''}
            aria-label={`Folder for ${item.name}`}
            onChange={(e) => { onMove(e.target.value); setMoving(false); }}
          >
            <option value="">Unfiled</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>{f.name}</option>
            ))}
          </select>
          <button onClick={() => setMoving(false)}>Cancel</button>
        </div>
      )}

      {arming && (
        <div className="dc-confirm">
          <p>Delete “{item.name}” and its media file? This cannot be undone.</p>
          <div className="dc-confirm-row">
            <button className="danger" onClick={onDelete}>Delete</button>
            <button autoFocus onClick={() => setArming(false)}>Keep</button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The start screen: every project as a card, and a way to make another.
 *
 * This is what the app opens on, in place of an editor with nothing in it. The
 * old empty state was the full three-column workspace — monitor, rail, timeline,
 * transport — all of it disabled around a line of text telling you to go find a
 * menu. That is a tool pretending to be busy. A grid of what you have made, with
 * one tile that makes the next one, says the same thing and is also useful.
 *
 * The new-project tile leads rather than trails: it is the only action on the
 * screen for a first-time user, and putting it at the end would hide it behind a
 * scroll the moment the grid fills up.
 */
export default function Dashboard({
  projects,
  folders,
  openFolder,
  onOpenFolder,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onSaveBrief,
  onMoveProject,
  importing,
  progress,
  opening,
  onOpen,
  onDelete,
  onRename,
  onImport,
  error,
  onDismissError,
  onOpenSettings,
}: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [newFolder, setNewFolder] = useState('');
  /**
   * The open folder's memory, edited locally and saved on blur.
   *
   * Prose, not a form: a form with fields for "tone" and "audience" collects
   * what the form's author imagined mattered, while a paragraph collects what
   * the person actually knows about their own work.
   */
  const [brief, setBrief] = useState('');
  useEffect(() => { setBrief(openFolder?.brief ?? ''); }, [openFolder?.id, openFolder?.brief]);
  /** A file is over the window. Drives the drop outline; never a layout change. */
  const [dropping, setDropping] = useState(false);
  /** dragenter/leave fire per descendant, so the outline needs a depth count. */
  const depth = useRef(0);

  const take = (file: File | undefined) => {
    // A drop needs somewhere to land. At the top level there is no folder yet,
    // and silently filing it under "Unfiled" would teach people that folders are
    // decoration.
    if (file && openFolder === null) return;
    if (file) onImport(file);
  };

  return (
    <div
      className={dropping ? 'dash dropping' : 'dash'}
      onDragEnter={(e) => {
        e.preventDefault();
        depth.current += 1;
        setDropping(true);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={() => {
        depth.current -= 1;
        if (depth.current <= 0) setDropping(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        depth.current = 0;
        setDropping(false);
        take(e.dataTransfer.files?.[0]);
      }}
    >
      <input
        ref={fileRef}
        className="dash-file"
        type="file"
        accept="video/*,audio/*"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = ''; // same file twice fires no change unless cleared
          take(file);
        }}
      />

      <header className="dash-top">
        <span className="dash-logo">Jumpstart</span>
        <p className="dash-tag">Edit video by editing its transcript.</p>
        {/* API keys live here so the assistant and transcription can be turned on
          * without editing .env or restarting the server. */}
        <button className="dash-settings" onClick={onOpenSettings} title="API keys">
          <Icon name="sliders" size={16} />
          <span>Settings</span>
        </button>
      </header>

      <div className="dash-body">
        {/*
          Two levels, not a filter.

          The top level is FOLDERS: a piece of work is a series before it is a
          file, and the folder is where its standing context lives. Projects
          appear once you are inside one, which is also the only place an import
          can land somewhere meaningful.
        */}
        {openFolder === null ? (
          <>
            <div className="dash-head">
              <h1>Folders</h1>
              <span className="dash-count">
                {folders.length === 0
                  ? 'None yet'
                  : `${folders.length} folder${folders.length === 1 ? '' : 's'}`}
              </span>
            </div>

            {error && <p className="error" onClick={onDismissError}>{error}</p>}

            <div className="dash-newfolder">
              <input
                value={newFolder}
                onChange={(e) => setNewFolder(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newFolder.trim()) {
                    onCreateFolder(newFolder.trim());
                    setNewFolder('');
                  }
                }}
                placeholder="New folder — Cheeko, China trip, Client work…"
                aria-label="New folder name"
              />
              <button
                className="primary"
                disabled={!newFolder.trim()}
                onClick={() => { onCreateFolder(newFolder.trim()); setNewFolder(''); }}
              >
                Create folder
              </button>
            </div>

            <div className="dash-folders">
              {folders.map((f) => {
                const count = projects.filter((p) => p.folderId === f.id).length;
                return (
                  <button
                    key={f.id}
                    className="fcard"
                    onClick={() => onOpenFolder(f.id)}
                    aria-label={`Open folder ${f.name}`}
                  >
                    <Icon name="video" size={22} />
                    <span className="fcard-name">{f.name}</span>
                    <span className="fcard-meta">
                      {count === 0 ? 'Empty' : `${count} project${count === 1 ? '' : 's'}`}
                      {f.brief.trim() ? ' · has memory' : ' · no memory yet'}
                    </span>
                  </button>
                );
              })}

              {/* Anything imported before folders existed. Not an error state —
                  it is where every project starts until it is put somewhere. */}
              {projects.some((p) => !p.folderId) && (
                <button
                  className="fcard fcard-loose"
                  onClick={() => onOpenFolder('')}
                  aria-label="Open unfiled projects"
                >
                  <Icon name="video" size={22} />
                  <span className="fcard-name">Unfiled</span>
                  <span className="fcard-meta">
                    {projects.filter((p) => !p.folderId).length} project
                    {projects.filter((p) => !p.folderId).length === 1 ? '' : 's'} · no memory
                  </span>
                </button>
              )}
            </div>

            {folders.length === 0 && (
              <p className="dash-empty">
                Make a folder for each kind of video you make. Everything inside it shares one
                memory — who is in it, what the channel is, how the titles usually sound — and that
                is what makes the titles and descriptions sound like yours.
              </p>
            )}
          </>
        ) : (
          <>
            <div className="dash-head">
              <button className="dash-back" onClick={() => onOpenFolder(null)}>
                <Icon name="chevron-left" size={14} /> All folders
              </button>
              <h1>{openFolder.id ? openFolder.name : 'Unfiled'}</h1>
              <span className="dash-count">
                {projects.length === 0
                  ? 'Nothing yet'
                  : `${projects.length} project${projects.length === 1 ? '' : 's'}`}
              </span>
              {openFolder.id && (
                <span className="dash-folder-acts">
                  <button
                    onClick={() => {
                      const name = prompt('Rename folder', openFolder.name);
                      if (name?.trim()) onRenameFolder(openFolder.id, name.trim());
                    }}
                  >
                    Rename
                  </button>
                  <button
                    onClick={() => {
                      if (confirm(`Delete the folder "${openFolder.name}"? The videos inside it are kept.`))
                        onDeleteFolder(openFolder.id);
                    }}
                  >
                    Delete folder
                  </button>
                </span>
              )}
            </div>

            {error && <p className="error" onClick={onDismissError}>{error}</p>}

            {openFolder.id ? (
              <section className="dash-memory">
                <h2>Memory</h2>
                <textarea
                  value={brief}
                  onChange={(e) => setBrief(e.target.value)}
                  onBlur={() => { if (brief !== openFolder.brief) onSaveBrief(openFolder.id, brief); }}
                  rows={6}
                  placeholder={`What should the AI know about everything in ${openFolder.name}?\n\nWho is in these videos, what the channel is, who watches it, how titles usually sound.`}
                  aria-label={`What the AI should know about ${openFolder.name}`}
                />
                <p className="dash-memory-hint">
                  Saved when you click away. Every video in this folder is written with this in
                  mind — it is the difference between “Listen to a silly crow story” and “Cheeko’s
                  first try at a rhyming game”.
                </p>
              </section>
            ) : (
              <p className="dash-empty">
                These are not in a folder yet, so they have no memory to write from. Make a folder
                and move them in.
              </p>
            )}
          </>
        )}

        {/* Projects live INSIDE a folder. At the top level there is nothing to
            show here — and an import tile at the top level would have to land
            somewhere, which is exactly the decision the folder makes. */}
        {openFolder !== null && (
        <div className={opening ? 'dash-grid busy' : 'dash-grid'}>
          <button
            className="dcard dcard-new"
            onClick={() => fileRef.current?.click()}
            disabled={importing}
            title="Import a video or audio file as a new project"
          >
            <span className="dcn-disc">
              <Icon name="plus" size={26} />
            </span>
            <span className="dcn-label">New project</span>
            <span className="dcn-sub">Import video or audio</span>
          </button>

          {importing && (
            <div className="dcard dcard-busy" aria-live="polite">
              <div className="dc-poster dc-poster-blank">
                <Icon name="video" size={26} />
              </div>
              <span className="dc-body">
                <span className="dc-name">Importing…</span>
                <span className="dc-meta">
                  <span className="dcb-bar">
                    <i style={{ width: `${Math.round((progress ?? 0) * 100)}%` }} />
                  </span>
                </span>
              </span>
            </div>
          )}

          {projects.map((p) => (
            <ProjectCard
              key={p.id}
              item={p}
              folders={folders}
              onOpen={() => onOpen(p.id)}
              onDelete={() => onDelete(p.id)}
              onRename={(name) => onRename(p.id, name)}
              onMove={(folderId) => onMoveProject(p.id, folderId)}
            />
          ))}
        </div>
        )}

        {openFolder !== null && projects.length === 0 && !importing && (
          <p className="dash-empty">
            Drop a file anywhere on this page, or use the tile above. Nothing is transcribed
            until you ask for it.
          </p>
        )}
      </div>

      {/* Outside the scroll container, so the outline frames the window rather
        * than whatever fraction of the page happens to be scrolled into view. */}
      <div className="dash-drop" aria-hidden="true">
        <span>Drop to import</span>
      </div>
    </div>
  );
}
