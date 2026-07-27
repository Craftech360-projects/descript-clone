import type { Hono } from 'hono';
import type { UpgradeWebSocket, WSContext } from 'hono/ws';
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z, type ZodTypeAny } from 'zod';

import { CONFIG } from './config.ts';
import {
  AGENT_TOOLS,
  AGENT_TOOL_NAMES,
  AGENT_SYSTEM_PROMPT,
  type AgentToolSpec,
} from '../../../packages/core/src/agent-tools.ts';

/**
 * The AI assistant, Claude branch — served through the Claude Agent SDK.
 *
 * This is the OPPOSITE control flow from the Grok proxy in agent.ts. Grok is a
 * one-turn HTTP proxy and the BROWSER runs the loop; here the SDK owns the loop
 * (it authenticates with the user's Claude subscription and orchestrates turns),
 * so the SERVER drives and the browser becomes a tool executor. The two backends
 * live side by side and the model picker chooses between them: a `claude-*` id is
 * routed here, everything else to /api/agent.
 *
 * The wire is one WebSocket per chat panel. The browser can't be reached over the
 * SDK's in-process MCP tools directly — the tools mutate the live editor document,
 * which lives in the renderer — so each tool call the model makes is FORWARDED over
 * the socket, the browser runs it against the doc (the same runTool the Grok path
 * uses), and the result is fed back into the SDK. The one real piece of new
 * plumbing is that round trip.
 *
 * Token frugality (the whole reason we resume rather than resend): the SDK holds
 * the conversation server-side, so `resume` carries prior turns without us
 * re-posting a growing history every turn — the expensive habit of the Grok path.
 * On top of that: a static custom `systemPrompt` (NOT the claude_code preset, which
 * is huge), `tools: []` to strip every built-in file/bash/web tool from context,
 * and `settingSources: []` so no CLAUDE.md or user settings are loaded. Only the 24
 * JumpCut tools reach the model.
 */

/**
 * The Claude models the picker offers when a subscription/key is present. Curated,
 * not a live catalogue — these are the ids worth pointing an agentic, tool-calling
 * workload at. The first is the default. Availability ultimately depends on what
 * the account's plan grants; an unavailable id surfaces as a model_not_found error.
 */
export const CLAUDE_MODELS = ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5'] as const;

/** The MCP server name our tools live under; the SDK prefixes tool ids with it. */
const MCP_NAME = 'jumpcut';
/** Auto-approve exactly our tools (no permission prompt — there is no human at the server). */
const ALLOWED_TOOLS = AGENT_TOOL_NAMES.map((n) => `mcp__${MCP_NAME}__${n}`);
/** A confused model cannot spin forever — same guard as the Grok loop's MAX_STEPS. */
const MAX_TURNS = 12;
/** How long a single tool round-trip to the browser may take before we give up on it. */
const TOOL_TIMEOUT_MS = 60_000;

// ── JSON Schema → Zod ────────────────────────────────────────────────────────
//
// AGENT_TOOLS carry plain JSON Schema (they were written for Grok's OpenAI-format
// function specs). The SDK's tool() wants a Zod raw shape, which it turns back into
// JSON Schema for the model — so we convert once here. The schemas only use a small
// slice of JSON Schema (string/integer/number/boolean, string enums, type unions
// with "null", descriptions, required), which keeps this converter small and total.

function zodForProperty(spec: Record<string, unknown>): ZodTypeAny {
  if (Array.isArray(spec.enum)) {
    // Every enum in AGENT_TOOLS is a set of string literals (modes, presets, fonts).
    return z.enum(spec.enum as [string, ...string[]]);
  }
  const types = Array.isArray(spec.type) ? spec.type : [spec.type];
  const nullable = types.includes('null');
  const base = types.find((t) => t !== 'null');
  let t: ZodTypeAny;
  switch (base) {
    case 'string':
      t = z.string();
      break;
    case 'integer':
    case 'number':
      t = z.number();
      break;
    case 'boolean':
      t = z.boolean();
      break;
    default:
      t = z.unknown();
  }
  return nullable ? t.nullable() : t;
}

function zodShapeFor(spec: AgentToolSpec): Record<string, ZodTypeAny> {
  const { properties, required = [] } = spec.function.parameters;
  const req = new Set(required);
  const shape: Record<string, ZodTypeAny> = {};
  for (const [key, raw] of Object.entries(properties)) {
    const prop = raw as Record<string, unknown>;
    let t = zodForProperty(prop);
    if (typeof prop.description === 'string') t = t.describe(prop.description);
    if (!req.has(key)) t = t.optional();
    shape[key] = t;
  }
  return shape;
}

// ── per-connection state ─────────────────────────────────────────────────────

interface WireOut {
  /** Streamed/whole assistant text to append in the panel. */
  text?: string;
  /** Ask the browser to run a tool and post back { t:'tool_result', id, result }. */
  tool?: { id: string; name: string; args: Record<string, unknown> };
  /** The SDK session id for this conversation — the client saves it and sends it
   *  back as `resume` next turn, so history is not resent and survives a reload. */
  session?: string;
  /** The turn finished; the panel can re-enable input. */
  done?: boolean;
  /** A turn-level error string to show. */
  error?: string;
}

interface Conn {
  ws: WSContext;
  /** Resolvers for tool calls awaiting the browser's reply, keyed by call id. */
  pending: Map<string, (result: string) => void>;
  /** The SDK session to resume, so history is not resent each turn. */
  sessionId: string | null;
  /** Guards against two overlapping turns on one socket (mirrors the client's busy flag). */
  busy: boolean;
  seq: number;
}

function send(conn: Conn, msg: WireOut): void {
  try {
    conn.ws.send(JSON.stringify(msg));
  } catch {
    /* socket closed mid-turn — nothing to do */
  }
}

/** Forward one tool call to the browser and await its result string. */
function callBrowser(conn: Conn, name: string, args: Record<string, unknown>): Promise<string> {
  return new Promise((resolve) => {
    const id = `t${conn.seq++}`;
    conn.pending.set(id, resolve);
    send(conn, { tool: { id, name, args } });
    setTimeout(() => {
      if (conn.pending.delete(id)) resolve('Error: the editor did not respond in time.');
    }, TOOL_TIMEOUT_MS);
  });
}

/** Build the 24 in-process MCP tools; each handler bridges to the browser over `conn`. */
function buildTools(conn: Conn) {
  return AGENT_TOOLS.map((spec) =>
    tool(
      spec.function.name,
      spec.function.description,
      zodShapeFor(spec),
      async (args) => {
        const result = await callBrowser(conn, spec.function.name, args as Record<string, unknown>);
        return { content: [{ type: 'text' as const, text: result }] };
      },
    ),
  );
}

/** Run one user turn to completion, streaming assistant text and tool calls to the browser. */
async function runTurn(
  conn: Conn,
  msg: { text: string; model?: string; context?: string; resume?: string },
): Promise<void> {
  if (conn.busy) {
    send(conn, { error: 'Still working on the previous message.' });
    return;
  }
  conn.busy = true;

  const mcp = createSdkMcpServer({ name: MCP_NAME, version: '1.0.0', tools: buildTools(conn) });
  // The app-state snapshot travels WITH the user message (tiny — a dozen lines) so
  // the static systemPrompt stays byte-identical across turns and stays cacheable.
  const prompt = msg.context
    ? `# Current app state\n${msg.context}\n\n${msg.text}`
    : msg.text;
  const model = msg.model && msg.model.startsWith('claude') ? msg.model : CONFIG.claudeModel;

  // Whether any assistant text has reached the browser this turn. Guards the
  // stale-resume retry below: we only retry if the resumed run failed before
  // producing anything, so a retry can never duplicate visible output.
  let emitted = false;

  /**
   * One pass through the SDK. Returns 'ok' when the run completed, 'retry' when a
   * resumed run threw before emitting anything (a stale session id — the server
   * restarted, or the transcript was pruned — so the client's saved id no longer
   * resolves), and 'fail' when it threw for any other reason (already reported).
   */
  const attempt = async (resume: string | null): Promise<'ok' | 'retry' | 'fail'> => {
    try {
      const q = query({
        prompt,
        options: {
          model,
          systemPrompt: AGENT_SYSTEM_PROMPT,
          // Token frugality + safety, all three doing real work — see the file header.
          tools: [],
          settingSources: [],
          mcpServers: { [MCP_NAME]: mcp },
          allowedTools: ALLOWED_TOOLS,
          permissionMode: 'bypassPermissions',
          maxTurns: MAX_TURNS,
          // Resume the same session so the SDK carries history for us.
          ...(resume ? { resume } : {}),
        },
      });

      for await (const m of q) {
        if (m.type === 'assistant') {
          const blocks = (m.message.content ?? []) as Array<{ type: string; text?: string }>;
          const text = blocks
            .filter((b) => b.type === 'text' && b.text)
            .map((b) => b.text)
            .join('');
          if (text.trim()) {
            send(conn, { text });
            emitted = true;
          }
          if (m.error) send(conn, { error: `Claude: ${m.error}` });
        } else if (m.type === 'result') {
          conn.sessionId = m.session_id;
          // Hand the id to the client so it persists with the chat and resumes next
          // turn — this is what carries context across a reload, not conn.sessionId
          // (which dies with the socket).
          send(conn, { session: m.session_id });
          if (m.subtype !== 'success') {
            send(conn, { error: 'The assistant stopped without finishing. Try again.' });
          }
        }
      }
      return 'ok';
    } catch (e) {
      if (resume && !emitted) return 'retry';
      send(conn, { error: e instanceof Error ? e.message : String(e) });
      return 'fail';
    }
  };

  try {
    // Prefer the client's saved id (survives reload); fall back to this socket's own.
    const first = msg.resume || conn.sessionId || null;
    if ((await attempt(first)) === 'retry') {
      // Stale id — start a fresh session so a reloaded conversation still works. The
      // visible history is intact on the client; only Claude's own context resets.
      conn.sessionId = null;
      await attempt(null);
    }
  } finally {
    conn.busy = false;
    send(conn, { done: true });
  }
}

/**
 * Register the Claude WebSocket route. `upgradeWebSocket` comes from
 * @hono/node-ws, created in index.ts where the Node server it must be injected
 * into also lives.
 */
export function registerClaudeAgent(app: Hono, upgradeWebSocket: UpgradeWebSocket): void {
  app.get(
    '/api/agent/claude/ws',
    upgradeWebSocket(() => {
      let conn: Conn | null = null;
      return {
        onOpen(_evt, ws) {
          conn = { ws, pending: new Map(), sessionId: null, busy: false, seq: 0 };
          if (!CONFIG.hasClaude()) {
            send(conn, {
              error:
                'Claude is not configured. Run `claude setup-token` and set CLAUDE_CODE_OAUTH_TOKEN (or ANTHROPIC_API_KEY) on the server.',
            });
          }
        },
        onMessage(evt, ws) {
          if (!conn) conn = { ws, pending: new Map(), sessionId: null, busy: false, seq: 0 };
          let data: {
            t?: string;
            id?: string;
            result?: string;
            text?: string;
            model?: string;
            context?: string;
            resume?: string;
          };
          try {
            data = JSON.parse(String(evt.data));
          } catch {
            return;
          }
          if (data.t === 'tool_result' && typeof data.id === 'string') {
            const resolve = conn.pending.get(data.id);
            if (resolve) {
              conn.pending.delete(data.id);
              resolve(typeof data.result === 'string' ? data.result : String(data.result ?? ''));
            }
            return;
          }
          if (data.t === 'user' && typeof data.text === 'string' && CONFIG.hasClaude()) {
            void runTurn(conn, {
              text: data.text,
              model: data.model,
              context: data.context,
              resume: typeof data.resume === 'string' ? data.resume : undefined,
            });
          }
        },
        onClose() {
          // Free any tool calls still waiting so their promises settle.
          if (conn) for (const resolve of conn.pending.values()) resolve('Error: the panel was closed.');
          conn = null;
        },
      };
    }),
  );
}
