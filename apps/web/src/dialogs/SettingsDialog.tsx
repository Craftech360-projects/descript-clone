import { useEffect, useState } from 'react';

import Dialog from '../ui/Dialog.tsx';
import { api, type KeyStatus } from '../api.ts';
import BridgePanel from './BridgePanel.tsx';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Called after a successful save so the app can re-read capabilities. */
  onSaved: () => void;
}

/** The order the rows appear in; ids match the server's MANAGED_KEYS. */
const ROW_ORDER = ['xai', 'anthropic', 'claudeOauth', 'elevenlabs', 'sarvam', 'deepgram', 'gemini', 'jamendo'];

/**
 * The app's settings: its API keys, and who is allowed to drive it.
 *
 * Titled "Settings" rather than "API keys" since it grew a second section — the
 * Hermes bridge is not a key, and a dialog whose title names only half of what is
 * in it sends people looking elsewhere for the other half.
 *
 * Keys can be updated without touching .env or restarting.
 *
 * The server never sends a secret back — only whether each key is set and a short
 * tail hint — so a configured key shows as a placeholder ("…a1b2") and the input
 * stays empty until you type a replacement. Typing edits that one key; leaving it
 * blank leaves it alone; "Clear" queues its removal. Save sends only what changed.
 */
export default function SettingsDialog({ open, onClose, onSaved }: Props) {
  const [keys, setKeys] = useState<Record<string, KeyStatus>>({});
  const [backends, setBackends] = useState<
    { grok: boolean; claude: boolean; asr: boolean; images: boolean } | null
  >(null);
  /** Only the keys the user has edited this session: value to set, or '' to clear. */
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load current (masked) status each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setDrafts({});
    api.settings
      .keys()
      .then((r) => {
        setKeys(r.keys);
        setBackends(r.backends);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [open]);

  const setDraft = (id: string, value: string) => setDrafts((d) => ({ ...d, [id]: value }));
  /** Queue this key for removal, or undo that (drop it from drafts entirely). */
  const toggleClear = (id: string, cleared: boolean) =>
    setDrafts((d) => {
      if (cleared) {
        const { [id]: _drop, ...rest } = d;
        return rest;
      }
      return { ...d, [id]: '' };
    });

  const save = async () => {
    if (Object.keys(drafts).length === 0) {
      onClose();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await api.settings.save(drafts);
      setKeys(r.keys);
      setBackends(r.backends);
      setDrafts({});
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const rows = ROW_ORDER.filter((id) => keys[id]);

  return (
    <Dialog
      open={open}
      title="Settings"
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="primary" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      {backends && (
        <p className="set-status">
          Assistant: {backends.grok || backends.claude ? 'on' : 'off'}
          {backends.grok ? ' · Grok' : ''}
          {backends.claude ? ' · Claude' : ''} &nbsp;·&nbsp; Transcription:{' '}
          {backends.asr ? 'on' : 'off'} &nbsp;·&nbsp; Image generation:{' '}
          {backends.images ? 'on' : 'off'}
        </p>
      )}

      {error && <p className="error">{error}</p>}

      <div className="set-keys">
        {rows.map((id) => {
          const k = keys[id];
          const draft = drafts[id];
          const cleared = draft === '';
          return (
            <div className="set-key" key={id}>
              <div className="set-key-head">
                <label htmlFor={`key-${id}`}>{k.label}</label>
                <span className={`set-badge ${k.configured && !cleared ? 'on' : 'off'}`}>
                  {cleared ? 'will clear' : k.configured ? `set ${k.hint}` : 'not set'}
                </span>
              </div>
              <div className="set-key-row">
                <input
                  id={`key-${id}`}
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={draft ?? ''}
                  placeholder={k.configured ? 'Enter a new value to replace' : 'Paste key to enable'}
                  onChange={(e) => setDraft(id, e.target.value)}
                  disabled={busy}
                />
                {k.configured && (
                  <button
                    className="set-clear"
                    onClick={() => toggleClear(id, cleared)}
                    disabled={busy}
                    title="Remove this key on save"
                  >
                    {cleared ? 'Undo' : 'Clear'}
                  </button>
                )}
              </div>
              <p className="set-note">{k.note}</p>
            </div>
          );
        })}
      </div>

      <p className="set-warn">
        Keys are stored in plaintext on this machine. The server now requires a token and listens
        on this machine only — still fine for local use, still not a multi-user auth layer.
      </p>

      <hr className="set-rule" />
      <h3 className="set-section">Connect Hermes</h3>
      <BridgePanel />
    </Dialog>
  );
}
