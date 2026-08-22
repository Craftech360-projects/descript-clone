import { useCallback, useEffect, useState } from 'react';

import { api, type BridgeStatus } from '../api.ts';

/**
 * Connect Hermes — hand this editor to an agent running outside the browser.
 *
 * Jumpy, in the panel, is one way to have an assistant drive the app: it uses
 * whatever key is set above, and it lives inside this window. This is the other
 * way: an agent in its own process — a Hermes host, or any MCP client — drives
 * the SAME seventy tools through this window.
 *
 * Both work at once, deliberately. Turning this on takes nothing away from Jumpy;
 * they are two doors into one document.
 *
 * The most useful thing on this panel is the attached-window line, which is why
 * it sits above the configuration rather than below it. An outside agent can only
 * edit a transcript while a window is open to edit it in — that is not a
 * limitation of the bridge but of where the document lives — so "is a window
 * attached" is the difference between an agent that works and one that reports
 * mysterious failures. A panel that asks you to switch something on without
 * showing you whether it is working is not much of a panel.
 */
export default function BridgePanel() {
  const [status, setStatus] = useState<BridgeStatus | null>(null);
  const [token, setToken] = useState('');
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api.bridge
      .status()
      .then(setStatus)
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    load();
    // Poll while the panel is open: a window attaching is the event the reader is
    // waiting for, and it happens in another process.
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [load]);

  const toggle = async (on: boolean) => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await api.bridge.setEnabled(on);
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const reveal = async () => {
    try {
      const { token } = await api.bridge.token();
      setToken(token);
      setShown(true);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const rotate = async () => {
    setBusy(true);
    setNote(null);
    try {
      const { token } = await api.bridge.rotate();
      setToken(token);
      setShown(true);
      setNote('New token. Any agent already connected is cut off until it reconnects.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const copy = (text: string, what: string) =>
    navigator.clipboard?.writeText(text).then(
      () => setNote(`${what} copied.`),
      () => setError('Could not reach the clipboard.'),
    );

  const config = JSON.stringify(
    { mcpServers: { jumpstart: { command: 'jumpstart-mcp' } } },
    null,
    2,
  );

  const on = status?.enabled ?? false;
  const windows = status?.windows ?? 0;

  return (
    <div className="set-bridge">
      <div className="set-key-head">
        <label htmlFor="bridge-on">Let an outside agent control this editor</label>
        <span className={`set-badge ${on ? 'on' : 'off'}`}>{on ? 'on' : 'off'}</span>
      </div>

      <div className="set-key-row">
        <button id="bridge-on" onClick={() => void toggle(!on)} disabled={busy}>
          {on ? 'Turn off' : 'Turn on'}
        </button>
        <span className="set-note">
          {on
            ? 'An agent holding the token below can run every tool this app has.'
            : 'Off. Requests from outside agents are refused.'}
        </span>
      </div>

      {/* What a person actually needs to know: can it reach a window right now. */}
      <p className={`set-attached ${windows > 0 ? 'live' : 'idle'}`}>
        {windows === 0
          ? 'No editor window attached — an agent could not edit a transcript right now.'
          : `${windows} window${windows === 1 ? '' : 's'} attached`}
        {status?.sessions?.length
          ? ` · ${status.sessions
              .map((s) => `${s.projectName ?? 'no project open'}${s.busy ? ' (working)' : ''}`)
              .join(' · ')}`
          : ''}
      </p>

      {on && (
        <>
          <p className="set-note">
            Point your Hermes host at this. It names a <em>command</em>, not a port, because the
            desktop app takes a fresh port every launch and the command finds it each time.
          </p>
          <pre className="set-config">{config}</pre>
          <button onClick={() => copy(config, 'Config')}>Copy config</button>

          <div className="set-key-head">
            <label>Token</label>
            <span className="set-badge on">{shown ? 'visible' : 'hidden'}</span>
          </div>
          <div className="set-key-row">
            <input
              type="text"
              readOnly
              value={shown ? token : '••••••••••••••••'}
              onFocus={(e) => e.currentTarget.select()}
              spellCheck={false}
            />
            {shown ? (
              <button onClick={() => copy(token, 'Token')}>Copy</button>
            ) : (
              <button onClick={() => void reveal()}>Show</button>
            )}
            <button onClick={() => void rotate()} disabled={busy}>
              Regenerate
            </button>
          </div>
          <p className="set-note">
            Only needed if you connect over HTTP instead of the command above — that one reads the
            token itself.
          </p>

          {status?.watch && (
            <p className="set-note">
              This server is running under <code>--watch</code>, so an agent editing server code
              will restart it. In-flight renders do not survive that.
            </p>
          )}
        </>
      )}

      {note && <p className="set-note">{note}</p>}
      {error && <p className="set-warn">{error}</p>}

      <p className="set-warn">
        An outside agent gets every control this app has, including export and delete. It is a
        separate program with its own instructions — you are trusting those, not just this app.
        Jumpy still works from the keys above; both can be on at once.
      </p>
    </div>
  );
}
