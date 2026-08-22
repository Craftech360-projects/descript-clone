import { randomUUID } from 'node:crypto';

/**
 * The relay that lets something outside the browser run the editor's tools.
 *
 * ── why this has to exist at all ────────────────────────────────────────────
 *
 * All 70 tools execute in the BROWSER. packages/core/src/agent-tools.ts holds
 * only their schemas; the implementations are the `executors` table in
 * apps/web/src/agent/tools.ts, and about forty of them read and write a document
 * that lives in renderer memory and nowhere else — the undo stack, the current
 * selection, the caption settings being previewed. The copy on disk is a lagging
 * projection, written 800ms after the fact. There is no server-side document to
 * drive, so anything that wants to edit has to ask a window to do it.
 *
 * agent-claude.ts already proved the shape: the server owns the model loop and
 * the browser becomes a tool executor over a socket. This file is that mechanism
 * with the Claude parts removed, so a second caller — the MCP server Hermes talks
 * to — can use it without dragging the Agent SDK along.
 *
 * ── registered vs pinned sessions, which is the subtle part ─────────────────
 *
 * agent-claude.ts runs its tool round-trip over THE SAME SOCKET as its chat. That
 * is not incidental: it means a Claude turn started in window A can only ever
 * touch window A, which is what a person expects when they type into that
 * window's panel. If its calls were routed through the registry below they could
 * land in a different window, silently.
 *
 * So there are two kinds of session. A PINNED one (registered: false) is owned by
 * whoever holds the reference and never appears in the registry — that is what
 * the Jumpy panel uses, unchanged. A REGISTERED one comes from /api/editor/ws and
 * is addressable by an outside caller. Both use the same call/timeout machinery.
 */

/** Anything with a send() — the real WSContext, or a fake in tests. */
export interface Sendable {
  send(data: string): void;
}

/** How long a single tool round-trip to a window may take before we give up. */
export const TOOL_TIMEOUT_MS = 60_000;

/**
 * Tools that run an encoder rather than edit a document, and so are allowed to
 * take far longer than a minute.
 *
 * Every other tool is a state change the browser answers in milliseconds, and a
 * minute of silence there means something broke. These two spawn ffmpeg and wait
 * — bounded on the server by CONFIG.summonOpTimeoutMs, which the Android shell
 * raises to seven minutes because software H.264 on a phone is slow. Timing them
 * out here at sixty seconds would abandon a job that is running perfectly well
 * and leave the caller to report a failure that did not happen.
 */
export const SLOW_TOOLS = new Set(['run_media_op', 'summon_media']);
export const SLOW_TOOL_TIMEOUT_MS = 15 * 60_000;

export interface SessionMeta {
  /** The project this window currently has open, if any. */
  projectId: string | null;
  projectName: string | null;
  /** ISO timestamp of when the window attached. */
  since: string;
  /** Epoch ms of the last thing we heard from it, for display. */
  lastSeen: number;
  /**
   * Monotonic activity counter, for ORDERING.
   *
   * lastSeen is wall-clock milliseconds, and two windows touched inside the same
   * millisecond compare equal — so "most recently active" became a coin flip
   * exactly when it mattered, with two windows both in use. This never ties.
   */
  order: number;
  /** True while a tool call is outstanding — surfaced so a caller can see contention. */
  busy: boolean;
}

export interface EditorSession {
  id: string;
  ws: Sendable;
  /** Resolvers for tool calls awaiting this window's reply, keyed by call id. */
  pending: Map<string, (result: string) => void>;
  seq: number;
  /** Registered sessions are addressable by outside callers; pinned ones are not. */
  registered: boolean;
  meta: SessionMeta;
}

/** Registered sessions only. Pinned ones are held by their owner and never listed. */
const sessions = new Map<string, EditorSession>();

/** Ever-increasing, so activity ordering never ties. See SessionMeta.order. */
let tick = 0;

export function newSession(ws: Sendable, opts: { registered: boolean } = { registered: false }): EditorSession {
  const s: EditorSession = {
    id: randomUUID(),
    ws,
    pending: new Map(),
    seq: 0,
    registered: opts.registered,
    meta: {
      projectId: null,
      projectName: null,
      since: new Date().toISOString(),
      lastSeen: Date.now(),
      order: ++tick,
      busy: false,
    },
  };
  if (s.registered) sessions.set(s.id, s);
  return s;
}

export function send(s: EditorSession, msg: unknown): void {
  try {
    s.ws.send(JSON.stringify(msg));
  } catch {
    /* socket closed mid-turn — nothing to do */
  }
}

/**
 * Forward one tool call to a window and await its result string.
 *
 * Never rejects. The browser side (runTool) already turns every throw into result
 * TEXT, and a timeout resolves with an error string for the same reason: a model
 * reads "Error: …" and can try something else, where a rejected promise becomes a
 * transport failure several layers up with no way back into the conversation.
 */
export function callEditor(s: EditorSession, name: string, args: Record<string, unknown>): Promise<string> {
  return new Promise((resolve) => {
    const id = `t${s.seq++}`;
    const settle = (text: string) => {
      s.meta.busy = s.pending.size > 0;
      resolve(text);
    };
    s.pending.set(id, settle);
    s.meta.busy = true;
    send(s, { tool: { id, name, args } });
    setTimeout(
      () => {
        if (s.pending.delete(id)) settle('Error: the editor did not respond in time.');
      },
      SLOW_TOOLS.has(name) ? SLOW_TOOL_TIMEOUT_MS : TOOL_TIMEOUT_MS,
    ).unref?.();
  });
}

/** Settle a pending call with the window's answer. Returns false if nothing was waiting. */
export function settleToolResult(s: EditorSession, id: string, result: string): boolean {
  const resolve = s.pending.get(id);
  if (!resolve) return false;
  s.pending.delete(id);
  s.meta.lastSeen = Date.now();
  s.meta.order = ++tick;
  resolve(result);
  return true;
}

/**
 * Drop a session, settling everything still waiting on it.
 *
 * Leaving them unsettled would hang the caller until its own timeout — up to
 * fifteen minutes for a slow tool — on a socket we already know is gone.
 */
export function closeSession(s: EditorSession, reason = 'Error: the editor window was closed.'): void {
  for (const resolve of s.pending.values()) resolve(reason);
  s.pending.clear();
  s.meta.busy = false;
  sessions.delete(s.id);
}

export interface SessionInfo extends SessionMeta {
  id: string;
}

export function listSessions(): SessionInfo[] {
  return [...sessions.values()]
    .map((s) => ({ id: s.id, ...s.meta }))
    .sort((a, b) => b.order - a.order);
}

export function sessionCount(): number {
  return sessions.size;
}

/**
 * Pick the window a call should go to.
 *
 * With one attached, use it. With several and no explicit choice, the
 * most-recently-active one — because the person is looking at one window, and
 * that is the best guess available; list_editor_sessions exists for when the
 * guess is wrong. With none, null, and the caller says so in the tool's own
 * voice rather than throwing a transport error.
 */
export function resolveSession(id?: string | null): EditorSession | null {
  if (id) return sessions.get(id) ?? null;
  let best: EditorSession | null = null;
  for (const s of sessions.values()) {
    if (!best || s.meta.order > best.meta.order) best = s;
  }
  return best;
}

export function touch(s: EditorSession, meta: Partial<SessionMeta>): void {
  Object.assign(s.meta, meta, { lastSeen: Date.now(), order: ++tick });
}

/** Test seam: forget every registered session. */
export function resetSessions(): void {
  sessions.clear();
}

// ── the socket a window attaches with ────────────────────────────────────────

/**
 * `/api/editor/ws` — how a browser or Electron renderer volunteers as a tool
 * executor for callers that are not its own chat panel.
 *
 * The wire is a deliberate subset of the one agent-claude.ts already speaks, so
 * there is no second protocol to learn:
 *
 *   browser → { t: 'hello', projectId, projectName }   on open, and on project change
 *   server  → { tool: { id, name, args } }
 *   browser → { t: 'tool_result', id, result }
 *   server  → { t: 'ping' }  /  browser → { t: 'pong' }
 *
 * Auth note: this socket EXECUTES tool calls, so attaching to it is not a
 * read-only act — a hostile page that attached could answer Hermes's calls with
 * whatever it liked. The middleware in index.ts requires the usual credential;
 * the renderer has it as a cookie, which page JavaScript cannot read.
 */
export function registerEditorBridge(app: HonoLike, upgradeWebSocket: UpgradeLike): void {
  app.get(
    '/api/editor/ws',
    upgradeWebSocket(() => {
      let s: EditorSession | null = null;
      return {
        onOpen(_evt: unknown, ws: Sendable) {
          s = newSession(ws, { registered: true });
          send(s, { t: 'hello', session: s.id });
        },
        onMessage(evt: { data: unknown }, ws: Sendable) {
          if (!s) s = newSession(ws, { registered: true });
          let data: { t?: string; id?: string; result?: unknown; projectId?: unknown; projectName?: unknown };
          try {
            data = JSON.parse(String(evt.data));
          } catch {
            return;
          }

          if (data.t === 'tool_result' && typeof data.id === 'string') {
            settleToolResult(s, data.id, typeof data.result === 'string' ? data.result : String(data.result ?? ''));
            return;
          }
          if (data.t === 'hello') {
            touch(s, {
              projectId: typeof data.projectId === 'string' ? data.projectId : null,
              projectName: typeof data.projectName === 'string' ? data.projectName : null,
            });
            return;
          }
          if (data.t === 'pong') touch(s, {});
        },
        onClose() {
          if (s) closeSession(s);
          s = null;
        },
      };
    }),
  );
}

/** Minimal structural types, so this file does not import Hono for two signatures. */
interface HonoLike {
  get(path: string, handler: unknown): unknown;
}
type UpgradeLike = (fn: () => Record<string, unknown>) => unknown;
