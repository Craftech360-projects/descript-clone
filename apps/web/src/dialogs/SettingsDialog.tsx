import { useEffect, useState } from 'react';

import Dialog from '../ui/Dialog.tsx';
import { api, type KeyStatus } from '../api.ts';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Called after a successful save so the app can re-read capabilities. */
  onSaved: () => void;
}

/** The order the rows appear in; ids match the server's MANAGED_KEYS. */
const ROW_ORDER = ['xai', 'anthropic', 'claudeOauth', 'elevenlabs', 'gemini', 'jamendo'];

/**
 * View and update the app's API keys without touching .env or restarting.
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
      title="API keys"
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
                    onClick={() => setDraft(id, cleared ? (undefined as unknown as string) : '')}
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
        Keys are stored in plaintext on this machine and this local server is unauthenticated —
        fine for local use, not for a shared or exposed host.
      </p>
    </Dialog>
  );
}
