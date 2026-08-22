import type { Hono } from 'hono';
import type { UpgradeWebSocket, WSContext } from 'hono/ws';
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

import { CONFIG } from './config.ts';
import { zodShapeFor, toToolContent } from './tool-schema.ts';
import {
  callEditor,
  closeSession,
  newSession,
  send,
  settleToolResult,
  type EditorSession,
} from './editor-bridge.ts';
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
 * and `settingSources: []` so no CLAUDE.md or user settings are loaded. Only the
 * JumpCut tools (AGENT_TOOLS) reach the model.
 */

/**
 * The Claude models the picker offers when a subscription/key is present. Curated,
 * not a live catalogue — these are the ids worth pointing an agentic, tool-calling
 * workload at. The first is the default. Availability ultimately depends on what
 * the account's plan grants; an unavailable id surfaces as a model_not_found error.
 */
/**
 * The Claude models the picker offers.
 *
 * Hand-maintained, because the Agent SDK has no catalogue endpoint to ask — so
 * this list is the one thing here that goes stale silently. It was three entries
 * and had drifted a generation behind, which is why the picker looked empty of
 * choice.
 *
 * Ordered by capability, heaviest first, so the top of the list is the strongest
 * answer and the bottom is the cheapest. An id the account cannot reach fails at
 * request time with the provider's own message rather than being hidden here —
 * guessing entitlement client-side would hide models people are paying for.
 */
export const CLAUDE_MODELS = [
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-haiku-4-5',
  'claude-opus-4-8',
  'claude-sonnet-4-6',
] as const;

/**
 * What each id is FOR, shown beside it in the picker.
 *
 * A dropdown of bare model ids asks the user to already know the lineup. This
 * app's workload is agentic and tool-heavy, so the useful distinction is not
 * benchmark scores but "does this one hold a long tool loop together".
 */
export const CLAUDE_MODEL_HINTS: Record<string, string> = {
  'claude-opus-5': 'Strongest reasoning. Best for long multi-step edits.',
  'claude-sonnet-5': 'Balanced. A good default for everyday editing.',
  'claude-haiku-4-5': 'Fastest and cheapest. Fine for short, direct commands.',
  'claude-opus-4-8': 'Previous generation, still very capable.',
  'claude-sonnet-4-6': 'Previous generation, balanced.',
};

/** The MCP server name our tools live under; the SDK prefixes tool ids with it. */
const MCP_NAME = 'jumpcut';
/** Auto-approve exactly our tools (no permission prompt — there is no human at the server). */
const ALLOWED_TOOLS = AGENT_TOOL_NAMES.map((n) => `mcp__${MCP_NAME}__${n}`);
/** A confused model cannot spin forever — same guard as the Grok loop's MAX_STEPS. */
const MAX_TURNS = 12;

/**
 * Find the Claude Code CLI the SDK will spawn, so a missing native binary does
 * not kill the assistant.
 *
 * The SDK normally spawns a binary shipped as a platform-specific OPTIONAL
 * dependency (@anthropic-ai/claude-agent-sdk-<platform>). When that package is
 * absent — node_modules copied between a Mac and Windows, or an install run with
 * `--omit=optional` — the SDK throws "Native CLI binary for <platform> not
 * found" the first time you send a message. Rather than make the user reinstall,
 * we locate a usable `claude` ourselves and pass it as pathToClaudeCodeExecutable.
 *
 * Order: an explicit override, then the SDK's own binary if it IS installed, then
 * any Claude Code CLI already on this machine's PATH (the common dev case — if
 * you have Claude Code, the app can just borrow it). null means "let the SDK try
 * its default", which is only reached when nothing else was found.
 */
function resolveClaudeExecutable(): string | null {
  const override = process.env.CLAUDE_CODE_EXECUTABLE;
  if (override && existsSync(override)) return override;

  const bin = process.platform === 'win32' ? 'claude.exe' : 'claude';

  // The SDK's own optional binary, if that package got installed. Resolving it
  // here (rather than trusting the SDK to) lets us fall through cleanly to PATH
  // when it is missing, instead of the SDK throwing mid-turn.
  try {
    const require = createRequire(import.meta.url);
    return require.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/${bin}`);
  } catch {
    /* optional package not installed — try a system install next */
  }

  // A Claude Code CLI already on PATH. This is what rescues the copied-across-OSes
  // dev setup without any reinstall.
  try {
    const locator = process.platform === 'win32' ? 'where' : 'which';
    const found = execFileSync(locator, ['claude'], { encoding: 'utf8' })
      .split(/\r?\n/)[0]
      ?.trim();
    if (found && existsSync(found)) return found;
  } catch {
    /* not on PATH */
  }

  return null;
}

/** Resolved once — a `which` per boot is enough; a new install needs a restart (dev --watch gives that for free). */
let cachedExecutable: string | null | undefined;
function claudeExecutable(): string | null {
  if (cachedExecutable === undefined) {
    cachedExecutable = resolveClaudeExecutable();
    if (cachedExecutable) console.log(`agent   Claude CLI ${cachedExecutable}`);
  }
  return cachedExecutable;
}

/**
 * One bounded, tool-free completion through the Claude SDK.
 *
 * The Social panel writes a title and description — a single answer, no tool
 * loop, no session to resume. That is a different shape from the editing agent
 * this file otherwise serves, and it needs its own entry point: the WebSocket
 * branch exists to drive an interactive loop, and putting a one-shot write
 * through it would mean inventing a fake session and a fake client.
 *
 * `tools: []` and no MCP server, because the model is being asked to write prose
 * and every tool offered is one more way for a turn to end without any.
 */
export async function completeOnce(model: string, prompt: string): Promise<string> {
  const exe = claudeExecutable();
  const q = query({
    prompt,
    options: {
      model,
      tools: [],
      settingSources: [],
      permissionMode: 'bypassPermissions',
      ...(exe ? { pathToClaudeCodeExecutable: exe } : {}),
    },
  });

  let text = '';
  for await (const message of q) {
    const m = message as { type?: string; message?: { content?: Array<{ type?: string; text?: string }> } };
    if (m.type === 'assistant') {
      for (const block of m.message?.content ?? []) {
        if (block.type === 'text' && block.text) text += block.text;
      }
    }
  }
  return text;
}

// ── JSON Schema → Zod ────────────────────────────────────────────────────────
//
// AGENT_TOOLS carry plain JSON Schema (they were written for Grok's OpenAI-format
// function specs). Both MCP surfaces need Zod instead, so the conversion lives in
// tool-schema.ts — shared with apps/mcp so the external server and this one cannot
// drift into two different contracts for the same 70 tools.

// ── per-connection state ─────────────────────────────────────────────────────

/** What this socket sends the panel. Kept as documentation of the wire. */
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

/**
 * The Jumpy panel's session is PINNED, not registered.
 *
 * Its tool calls go back over the same socket the chat arrived on, so a turn
 * started in this window can only ever touch this window. Registering it would
 * make it addressable by an outside caller and let a Hermes tool call land in a
 * window someone is typing into. See editor-bridge.ts.
 */
type Conn = EditorSession & { sessionId: string | null; busy: boolean };

function newConn(ws: WSContext): Conn {
  return Object.assign(newSession(ws, { registered: false }), { sessionId: null, busy: false });
}

/** Build the in-process MCP tools (one per AGENT_TOOLS entry); each handler bridges to the browser over `conn`. */
function buildTools(conn: Conn) {
  return AGENT_TOOLS.map((spec) =>
    tool(spec.function.name, spec.function.description, zodShapeFor(spec), async (args) =>
      toToolContent(await callEditor(conn, spec.function.name, args as Record<string, unknown>)),
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
      const exe = claudeExecutable();
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
          // Point the SDK at a CLI we found ourselves, so a missing platform binary
          // does not sink the turn. Omitted when null — the SDK falls back to its
          // own lookup (which then produces the error we translate below).
          ...(exe ? { pathToClaudeCodeExecutable: exe } : {}),
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
      const raw = e instanceof Error ? e.message : String(e);
      // The raw "Native CLI binary…" message is developer-speak. If we reach it,
      // every fallback in claudeExecutable() also came up empty — say what to do.
      const msg = /Native CLI binary/i.test(raw)
        ? "Claude's local CLI isn't available. Fix any one of these: run `npm install` (without --omit=optional) in the app folder so the platform binary installs; install Claude Code so it's on your PATH; or set CLAUDE_CODE_EXECUTABLE to a claude binary."
        : raw;
      send(conn, { error: msg });
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
          conn = newConn(ws);
          if (!CONFIG.hasClaude()) {
            send(conn, {
              error:
                'Claude is not configured. Run `claude setup-token` and set CLAUDE_CODE_OAUTH_TOKEN (or ANTHROPIC_API_KEY) on the server.',
            });
          }
        },
        onMessage(evt, ws) {
          if (!conn) conn = newConn(ws);
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
            settleToolResult(conn, data.id, typeof data.result === 'string' ? data.result : String(data.result ?? ''));
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
          if (conn) closeSession(conn, 'Error: the panel was closed.');
          conn = null;
        },
      };
    }),
  );
}
