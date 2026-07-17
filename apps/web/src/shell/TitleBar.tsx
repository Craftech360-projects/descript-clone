import Icon from '../ui/Icon.tsx';
import type { SaveStatus } from '../store/editor.ts';

interface Props {
  name: string | null;
  saveStatus: SaveStatus;
  onRetrySave: () => void;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
  onUndo: () => void;
  onRedo: () => void;
  hasAsr: boolean;
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
  canUndo,
  canRedo,
  undoLabel,
  redoLabel,
  onUndo,
  onRedo,
  hasAsr,
  onExport,
  canExport,
  exporting,
}: Props) {
  return (
    <header className="titlebar">
      <div className="tb-left">
        <span className="dot" />
        <span className="tb-brand">Jumpcut</span>
        {/* The wordmark is the app; the document is what you are doing to it.
          * Before, the name slot held EITHER a project OR the product's name, so
          * the app had no identity the moment you opened anything. */}
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
        <span
          className={hasAsr ? 'chip ok' : 'chip'}
          title={
            hasAsr
              ? 'Transcription is live'
              : 'No ELEVENLABS_API_KEY — the mock provider invents the words'
          }
        >
          {hasAsr ? 'Scribe' : 'Mock ASR'}
        </span>
        <button className="primary" onClick={onExport} disabled={!canExport || exporting}>
          {exporting ? 'Exporting…' : 'Export'}
        </button>
      </div>
    </header>
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
