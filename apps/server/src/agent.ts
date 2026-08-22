import type { Hono } from 'hono';
import * as local from './agent-local.ts';

import { CONFIG } from './config.ts';
import { CLAUDE_MODELS } from './agent-claude.ts';
import { AGENT_TOOLS, AGENT_SYSTEM_PROMPT } from '../../../packages/core/src/agent-tools.ts';

/**
 * The AI assistant, as a thin proxy in front of xAI (Grok).
 *
 * The server owns exactly two things — the API key and the tool schemas — and
 * nothing else. It does NOT run the agent loop: the tools mutate the live editor
 * document, which lives in the browser, so the loop is client-orchestrated. Each
 * POST here is one turn: the client sends the running conversation plus a compact
 * snapshot of the current app state, the server prepends the system brief and
 * attaches the tools, calls Grok once, and hands the assistant message straight
 * back. The client executes any tool calls locally and posts again.
 *
 * Keeping the key here is the whole reason this endpoint exists — it must never
 * reach the browser — and it is the same posture as the ASR and music routes.
 */

/**
 * Shown in the model picker when a live list cannot be fetched (no key, or xAI's
 * /models is unreachable). A curated set rather than the full catalogue: these
 * are the Grok models worth pointing an agentic, tool-calling workload at.
 */
const FALLBACK_MODELS = [
  'grok-4',
  'grok-4-fast-reasoning',
  'grok-4-fast-non-reasoning',
  'grok-3',
  'grok-3-mini',
  'grok-code-fast-1',
];

interface WireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: unknown;
  tool_call_id?: string;
  name?: string;
}

export function registerAgent(app: Hono): void {
  /**
   * The models the picker offers. Fetched live from xAI so it tracks their
   * catalogue, with the curated fallback when there is no key or the call fails —
   * so the dropdown is never empty and the app never blocks on it.
   */
  app.get('/api/agent/models', async (c) => {
    // Claude ids are appended whenever a subscription/key is present, so one picker
    // offers both backends. A `claude-*` id tells the client to use the WebSocket
    // branch (agent-claude.ts) instead of this HTTP proxy.
    const claude = CONFIG.hasClaude() ? [...CLAUDE_MODELS] : [];
    /**
     * Local models are offered alongside the hosted ones, prefixed so the id
     * itself says where a turn should go. A machine running Ollama gets an
     * assistant with no key and no network.
     */
    const localIds = local.hasLocalAgent()
      ? (local.localAgent()?.models ?? []).map((m) => `${local.LOCAL_PREFIX}${m}`)
      : [];
    const enabled = CONFIG.hasAnyAgent() || localIds.length > 0;
    // Prefer the Claude default (Haiku) when a Claude backend is present; fall
    // back to Grok's model only when Claude is not configured.
    const def = CONFIG.hasClaude() ? CONFIG.claudeModel : CONFIG.xaiModel;

    if (!CONFIG.hasAgent()) {
      // Grok off: the picker is Claude-only (or empty if nothing is configured).
      return c.json({ models: [...claude, ...localIds], default: localIds.length && !claude.length ? localIds[0] : def, enabled });
    }
    try {
      const r = await fetch(`${CONFIG.xaiBaseUrl}/models`, {
        headers: { Authorization: `Bearer ${CONFIG.xaiKey}` },
      });
      if (!r.ok) throw new Error(String(r.status));
      const data = (await r.json()) as { data?: Array<{ id?: string }> };
      const grok = (data.data ?? []).map((m) => m.id).filter((id): id is string => Boolean(id));
      return c.json({
        models: [...(grok.length ? grok.sort() : FALLBACK_MODELS), ...claude, ...localIds],
        default: def,
        enabled,
      });
    } catch {
      return c.json({ models: [...FALLBACK_MODELS, ...claude], default: def, enabled });
    }
  });

  /**
   * One turn of the conversation. Body: { model, context, messages } where
   * `messages` is the OpenAI-format history WITHOUT the system prompt (the client
   * never sees it) and `context` is a fresh snapshot of app state to inject.
   */
  app.post('/api/agent', async (c) => {
    // Read the body ONCE — the request stream cannot be replayed — then decide
    // where the turn goes.
    const body = await c.req.json<{ model?: string; context?: string; messages?: WireMessage[] }>().catch(
      () => ({}) as { model?: string; context?: string; messages?: WireMessage[] },
    );

    const requested = typeof body.model === 'string' && body.model ? body.model : '';
    const wantsLocal = requested !== '' && local.isLocalModel(requested);

    /**
     * A local model needs no key, so the credential check must not run for it.
     * Refusing an offline assistant because XAI_API_KEY is unset would be
     * exactly backwards.
     */
    if (!wantsLocal && !CONFIG.hasAgent()) {
      return c.json(
        { error: 'The AI assistant is not configured. Set XAI_API_KEY on the server to enable it.' },
        400,
      );
    }

    const model = requested || CONFIG.xaiModel;
    const context = typeof body.context === 'string' ? body.context : '';
    const history = Array.isArray(body.messages) ? body.messages : [];

    // System = the fixed brief plus the live snapshot. The snapshot changes every
    // turn, which is fine — Grok has no prompt-prefix cache to protect, so the
    // model always sees current state without any staleness dance.
    const system = context
      ? `${AGENT_SYSTEM_PROMPT}\n\n# Current app state\n${context}`
      : AGENT_SYSTEM_PROMPT;

    const messages: WireMessage[] = [{ role: 'system', content: system }, ...history];

    if (wantsLocal) {
      const result = await local.chat(local.stripPrefix(model), messages, AGENT_TOOLS);
      if (result.error) return c.json({ error: result.error }, (result.status ?? 502) as 400 | 502);
      return c.json({ message: result.message });
    }

    try {
      const r = await fetch(`${CONFIG.xaiBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CONFIG.xaiKey}` },
        body: JSON.stringify({ model, messages, tools: AGENT_TOOLS, tool_choice: 'auto' }),
      });

      // Read the body as text first: an xAI error may not be JSON at all, and its
      // JSON error shape varies (`{error: "..."}` string vs `{error: {message}}`
      // object vs `{msg}` / `{code}`), so parse defensively rather than assuming.
      const raw = await r.text();
      let data: unknown = undefined;
      try {
        data = JSON.parse(raw);
      } catch {
        /* not JSON — `raw` itself is the message */
      }

      if (!r.ok) {
        const detail = extractError(data) || raw.trim();
        // Log the real reason server-side too — 403s are almost always the key,
        // the account's model access, or credits, and the message says which.
        console.error(`xAI ${r.status} for model "${model}": ${detail}`);
        return c.json({ error: `xAI ${r.status}: ${detail || 'request failed'} (model: ${model})` }, 502);
      }

      const message = (data as { choices?: Array<{ message?: unknown }> })?.choices?.[0]?.message;
      if (!message) return c.json({ error: 'The model returned no message.' }, 502);
      return c.json({ message });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
    }
  });
}

/** Pull a human message out of whatever shape xAI returned the error in. */
function extractError(data: unknown): string {
  if (!data || typeof data !== 'object') return '';
  const d = data as Record<string, unknown>;
  if (typeof d.error === 'string') return d.error;
  if (d.error && typeof d.error === 'object') {
    const msg = (d.error as Record<string, unknown>).message;
    if (typeof msg === 'string') return msg;
  }
  if (typeof d.msg === 'string') return d.msg;
  if (typeof d.message === 'string') return d.message;
  return '';
}
