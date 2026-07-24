import Icon from '../ui/Icon.tsx';
import { timecode } from '../../../../packages/core/src/timeline.ts';
import type { SaveStatus } from '../store/editor.ts';

/** The edit summary, or null when nothing is transcribed to summarise. */
export interface EditStats {
  words: number;
  kept: number;
  cuts: number;
  outputSec: number;
  sourceSec: number;
}

interface Props {
  name: string | null;
  saveStatus: SaveStatus;
  onRetrySave: () => void;
  onToggleLibrary: () => void;
  /** Back to the project grid — the screen the app starts on. */
  onHome: () => void;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
  onUndo: () => void;
  onRedo: () => void;
  /** The live edit summary — shown beside Export. Null hides the strip. */
  stats: EditStats | null;
  onExport: () => void;
  canExport: boolean;
  exporting: boolean;
}

/**
 * The window chrome. A title bar with the document's name and its save state is
 * the cheapest, strongest signal that this is an application and not a web page.
 *
 * The save state is not decoration: there is a real dirty → saving → saved
 * lifecycle here and nothing surfaced it, so the app was silently writing to
 * disk on every keystroke with no way to know whether it had worked.
 */
export default function TitleBar({
  name,
  saveStatus,
  onRetrySave,
  onToggleLibrary,
  onHome,
  canUndo,
  canRedo,
  undoLabel,
  redoLabel,
  onUndo,
  onRedo,
  stats,
  onExport,
  canExport,
  exporting,
}: Props) {
  return (
    <header className="titlebar">
      <div className="tb-left">
        {/* The ☰ opens the media library + speakers, which no longer hold a
          * permanent column. The wordmark is the app; the document name is what
          * you are doing to it — and it only appears once something is open. */}
        <button
          className="icon tb-menu"
          onClick={onToggleLibrary}
          title="Media & speakers"
          aria-label="Open library"
        >
          <Icon name="menu" size={18} />
        </button>
        {/* Beside the ☰, not on the wordmark: a logo that navigates is a web
          * convention, and this is a window. The grid it goes back to is a real
          * screen, so it gets a real control. */}
        <button
          className="icon tb-home"
          onClick={onHome}
          title="All projects"
          aria-label="All projects"
        >
          <Icon name="grid" size={17} />
        </button>
        <img className="tb-logo" src="/jumpcut.png" alt="JumpCut" draggable={false} />
        {name && <span className="tb-sep" aria-hidden="true" />}
        {name && <strong className="tb-name">{name}</strong>}
        {name && <SaveState status={saveStatus} onRetry={onRetrySave} />}
      </div>

      <div className="tb-mid">
        <button
          className="icon"
          onClick={onUndo}
          disabled={!canUndo}
          title={undoLabel ? `Undo ${undoLabel}  (Ctrl+Z)` : 'Nothing to undo'}
          aria-label="Undo"
        >
          <Icon name="undo" />
        </button>
        <button
          className="icon"
          onClick={onRedo}
          disabled={!canRedo}
          title={redoLabel ? `Redo ${redoLabel}  (Ctrl+Shift+Z)` : 'Nothing to redo'}
          aria-label="Redo"
        >
          <Icon name="redo" />
        </button>
      </div>

      <div className="tb-right">
        {stats && <EditSummary stats={stats} />}
        <button className="primary" onClick={onExport} disabled={!canExport || exporting}>
          {exporting ? 'Exporting…' : 'Export'}
        </button>
      </div>
    </header>
  );
}

/**
 * The edit summary, docked beside Export.
 *
 * Just the output length now: the one number that is the thing you are making.
 * The removed / segments / words-kept trio that used to sit here was fine print —
 * it qualified the number without ever being acted on — so it is gone.
 */
function EditSummary({ stats }: { stats: EditStats }) {
  return (
    <div className="tb-stats" title="Length of the finished cut">
      <span className="tb-stat lead">
        <b>{timecode(stats.outputSec)}</b>
        <i>output</i>
      </span>
    </div>
  );
}

const LABEL: Record<SaveStatus, string> = {
  idle: '',
  unsaved: 'Unsaved changes',
  saving: 'Saving…',
  saved: 'Saved',
  error: "Couldn't save",
};

function SaveState({ status, onRetry }: { status: SaveStatus; onRetry: () => void }) {
  if (status === 'idle') return null;

  // An error is the one state that must be actionable rather than ambient.
  if (status === 'error') {
    return (
      <button className="save-state err" onClick={onRetry} title="Retry saving">
        {LABEL.error} · Retry
      </button>
    );
  }
  return <span className={`save-state ${status}`}>{LABEL[status]}</span>;
}
