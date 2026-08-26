import { runTool } from '../agent/tools.ts';

/**
 * This window, volunteering as a tool executor for callers outside it.
 *
 * The Jumpy panel already runs tools here, but only ones IT asked for, over its
 * own chat socket. This is the other direction: an external agent — Hermes,
 * through the MCP server — needs a window to execute in, because about forty of
 * the seventy tools read and write a document that exists only in this tab's
 * memory. Without a socket like this one, an outside caller can list projects and
 * start renders but cannot cut a single word.
 *
 * It deliberately holds no state of its own. Everything it does goes through the
 * same `runTool` the panel uses, so an external edit lands in the same undo
 * history, triggers the same debounced save, and is indistinguishable afterwards
 * from one the user made by hand. That is the point: two ways in, one document.
 *
 * ── reconnect is not polish ─────────────────────────────────────────────────
 *
 * `npm run server` runs under --watch, so every time the agent edits a server
 * file the process restarts and this socket dies. An agent that is allowed to
 * change the app's code will do that constantly. Backoff is what makes "Hermes
 * added a feature and the app came back" happen without anyone touching the
 * window.
 */

let ws: WebSocket | null = null;
let closed = false;
let attempt = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let current: { projectId: string | null; projectName: string | null } = {
  projectId: null,
  projectName: null,
};

function url(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/api/editor/ws`;
}

function send(msg: unknown): void {
  if (ws?.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* closing under us — the reconnect will handle it */
    }
  }
}

/** Tell the server which project this window is showing, so a caller can choose. */
export function reportProject(projectId: string | null, projectName: string | null): void {
  current = { projectId, projectName };
  send({ t: 'hello', ...current });
}

function schedule(): void {
  if (closed || timer) return;
  // 0.5s, 1s, 2s, 4s… capped at 15s. Fast enough that a --watch restart is
  // invisible, slow enough that a server that is properly down is not hammered.
  const delay = Math.min(15_000, 500 * 2 ** attempt++);
  timer = setTimeout(() => {
    timer = null;
    open();
  }, delay);
}

function open(): void {
  if (closed || ws) return;

  let sock: WebSocket;
  try {
    sock = new WebSocket(url());
  } catch {
    schedule();
    return;
  }
  ws = sock;

  sock.onopen = () => {
    attempt = 0;
    send({ t: 'hello', ...current });
  };

  sock.onmessage = (evt) => {
    let data: { t?: string; tool?: { id: string; name: string; args: Record<string, unknown> } };
    try {
      data = JSON.parse(String(evt.data));
    } catch {
      return;
    }

    if (data.t === 'ping') {
      send({ t: 'pong' });
      return;
    }

    const call = data.tool;
    if (!call) return;

    // runTool never throws — it turns every failure into result TEXT, which is
    // exactly the contract a relay needs. The `.then` shape rather than an async
    // handler keeps one slow tool (a 15-minute encode) from blocking the next
    // message on this socket.
    void Promise.resolve(runTool(call.name, call.args))
      .then((result) => send({ t: 'tool_result', id: call.id, result }))
      .catch((e: unknown) =>
        send({ t: 'tool_result', id: call.id, result: `Error: ${e instanceof Error ? e.message : String(e)}` }),
      );
  };

  const drop = () => {
    if (ws === sock) ws = null;
    schedule();
  };
  sock.onclose = drop;
  sock.onerror = drop;
}

export function connectEditorBridge(): () => void {
  closed = false;
  open();
  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    timer = null;
    ws?.close();
    ws = null;
  };
}
