import { baseUrl, read, token, type Bridge } from './discovery.ts';

/**
 * The client half: turn an MCP tool call into a call on the running editor.
 *
 * Plain HTTP rather than a persistent socket, and that is a considered choice.
 * The MCP process is spawned per client and may outlive several app restarts —
 * an agent that edits server code restarts the app constantly — so a long-lived
 * connection would spend its life reconnecting to a moving target. A stateless
 * request that re-reads bridge.json each time simply cannot go stale.
 *
 * The cost is the fifteen-minute encode tools, which hold a request open that
 * long. Node's fetch has no default timeout, so this works; the server bounds
 * the wait at its end (SLOW_TOOL_TIMEOUT_MS in editor-bridge.ts) and always
 * answers with text rather than hanging.
 */

export interface CallResult {
  result: string;
  attached: boolean;
  session?: string;
}

export class NotRunning extends Error {
  constructor() {
    super('Jumpcut is not running.');
    this.name = 'NotRunning';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const bridge = await read();
  if (!bridge || !bridge.port) throw new NotRunning();

  const res = await fetch(`${baseUrl(bridge)}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token(bridge)}`,
      ...(init?.headers ?? {}),
    },
  }).catch(() => {
    // Connection refused: the file said a port but nothing is listening.
    throw new NotRunning();
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || `${path} failed (${res.status})`);
  }
  return (await res.json()) as T;
}

/** Run one tool in an attached editor window. */
export async function call(
  name: string,
  args: Record<string, unknown>,
  session?: string | null,
): Promise<string> {
  const out = await request<CallResult>('/api/bridge/call', {
    method: 'POST',
    body: JSON.stringify({ name, args, session: session ?? undefined }),
  });
  return out.result;
}

export interface Status {
  enabled: boolean;
  url: string;
  mode: string;
  pid: number;
  startedAt: string;
  logPath: string | null;
  watch: boolean;
  windows: number;
  sessions: Array<{
    id: string;
    projectId: string | null;
    projectName: string | null;
    since: string;
    busy: boolean;
  }>;
}

export function status(): Promise<Status> {
  return request<Status>('/api/bridge/status');
}

/** Read the current bridge file without going over the network. */
export function bridge(): Promise<Bridge | null> {
  return read();
}

/** Is the server answering right now? Cheap, and does not need the bridge enabled. */
export async function reachable(): Promise<boolean> {
  try {
    const b = await read();
    if (!b || !b.port) return false;
    const res = await fetch(`${baseUrl(b)}/api/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok || res.status === 503; // 503 means listening but ffmpeg is missing.
  } catch {
    return false;
  }
}
