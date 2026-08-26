import { useSyncExternalStore } from 'react';

import {
  api,
  type AgentWireMessage,
  type ChatEntry,
  type ProjectChat,
  type ToolChip,
} from '../api.ts';
import { buildContext, noteUserMessage, resetUserMessages, runTool } from '../agent/tools.ts';

export type { ChatEntry, ToolChip };

/**
 * The chat store and the agent loop.
 *
 * Same shape as the editor store (useSyncExternalStore over a module singleton) so
 * it needs no provider and no store library. Two views of the conversation are
 * kept: `entries` for the panel (user text, assistant text, and one chip per tool
 * call) and `wire` for the model (the exact OpenAI-format history Grok is resent
 * each turn). They are separate because the panel wants a readable timeline while
 * the model wants the literal tool_call / tool result plumbing.
 *
 * The loop is client-orchestrated: post one turn to /api/agent, and if the reply
 * asks for tools, run them locally (they mutate the live editor document), append
 * the results, and post again — up to a hard cap so a confused model cannot spin
 * forever. Every turn resends a fresh state snapshot, so the model always sees the
 * document as its own edits have just left it.
 */

interface AgentState {
  entries: ChatEntry[];
  status: 'idle' | 'busy';
  model: string;
  models: string[];
  /** id -> where it runs and why you'd pick it. Empty until the list loads. */
  catalogue: { id: string; label: string; hint: string; where: string }[];
  /** True once capabilities say the server has an xAI key. */
  enabled: boolean;
}

const MAX_STEPS = 12;

let state: AgentState = { entries: [], status: 'idle', model: '', models: [], catalogue: [], enabled: false };
/** The literal history sent to the model. Not React state — the panel never reads it. */
let wire: AgentWireMessage[] = [];

// ── per-project persistence ─────────────────────────────────────────────────────
//
// The conversation is saved with the project (server-side, one PUT per completed
// turn) so it survives a reload and a project switch — the same guarantee cut
// settings and captions already have. `currentProjectId` is the save target, kept
// in step with the open project by setChatProject (called from App). A null target
// means no project is open, so nothing is saved.

/** The project the current chat belongs to; the save target. Null when none is open. */
let currentProjectId: string | null = null;
/** The Claude Agent SDK session to resume, so Claude keeps context across reloads. */
let claudeSessionId: string | null = null;

const listeners = new Set<() => void>();

function set(next: Partial<AgentState>): void {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

const getSnapshot = () => state;

export function useAgent(): AgentState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    getSnapshot,
    getSnapshot,
  );
}

let seq = 0;
const newId = () => `c${Date.now().toString(36)}-${seq++}`;

function push(entry: ChatEntry): void {
  set({ entries: [...state.entries, entry] });
}

/** The model currently chosen, for callers outside React (the tool bridge). */
export function agentModel(): string {
  return state.model;
}

export function setModel(model: string): void {
  set({ model });
  /**
   * Remember it. This used to be in-memory only, so a reload put you back on
   * whatever the server called default — you would choose a model, refresh, and
   * be quietly somewhere else. Saved on the SERVER rather than in localStorage
   * because it is a property of the installation, not of the window.
   *
   * Fire and forget: failing to persist a preference must never block changing
   * it, and the next change tries again.
   */
  void api.preferences.patch({ model }).catch(() => {});
}

/**
 * Load the model list and enabled flag. Called once when the panel first mounts.
 * Independent of the main capabilities fetch so the picker can populate from the
 * live xAI catalogue rather than a static list.
 */
export async function initAgent(defaultModel: string, enabled: boolean): Promise<void> {
  set({ enabled });
  if (state.model === '') set({ model: defaultModel });
  try {
    const { models, catalogue, default: def } = await api.agent.models();
    // A remembered choice outranks the server's default — that is what choosing
    // it meant. Only fall back when it names a model that is no longer offered.
    const saved = await api.preferences.get().then((p) => p.model).catch(() => '');
    set({
      models,
      catalogue: catalogue ?? [],
      // Keep any model the user already chose; otherwise prefer the server default.
      model:
        state.model && models.includes(state.model)
          ? state.model
          : saved && models.includes(saved)
            ? saved
            : def || models[0] || state.model,
    });
  } catch {
    // Leave whatever default we have; the picker just shows the one entry.
  }
}

/** Start over — used by the panel's clear button. Clears the saved copy too. */
export function resetChat(): void {
  wire = [];
  claudeSessionId = null;
  claudeTurnId = null;
  // Clearing the chat withdraws any folder the user named in it: use_folder
  // matches against what they typed, and none of it is on screen any more.
  resetUserMessages();
  set({ entries: [] });
  void persistChat();
}

/**
 * Point the chat at a project, hydrating the panel from its saved conversation (or
 * clearing everything when `id` is null, i.e. the editor closed). Called from App on
 * every project-id change, so the target for saves and the visible timeline always
 * match the open project — switching projects never shows or overwrites another's chat.
 */
export function setChatProject(id: string | null, chat?: ProjectChat | null): void {
  currentProjectId = id;
  claudeSessionId = chat?.claudeSessionId ?? null;
  claudeTurnId = null;
  wire = chat?.wire ? [...chat.wire] : [];
  const entries = chat?.entries ? [...chat.entries] : [];
  // Reopening a conversation restores what the user typed in it, so a folder
  // they named yesterday is still theirs to reuse today without retyping it.
  resetUserMessages(entries.filter((e) => e.role === 'user').map((e) => e.text));
  set({ entries });
}

// A single-flight guard: turns finish seconds apart, but Clear-then-send or a fast
// tool loop can stack saves. We coalesce — one PUT at a time, and if the chat changed
// while a save was in flight, save once more when it lands.
let savingChat = false;
let chatDirty = false;

/** Persist the current conversation to the open project. A no-op when none is open. */
async function persistChat(): Promise<void> {
  const id = currentProjectId;
  if (!id) return;
  if (savingChat) {
    chatDirty = true;
    return;
  }
  savingChat = true;
  try {
    do {
      chatDirty = false;
      await api.saveChat(id, { entries: state.entries, wire, claudeSessionId });
    } while (chatDirty && currentProjectId === id);
  } catch {
    // A failed chat save is non-fatal: the conversation stays in memory and the next
    // completed turn saves it again. Losing history to a transient error, silently,
    // is worse than a missed save — so we simply try again rather than surface it.
  } finally {
    savingChat = false;
  }
}

/**
 * Send a user message and run the tool loop to completion.
 *
 * Guarded against re-entry by `status`: the input is disabled while busy, but a
 * stray call is a no-op rather than two interleaved loops on one `wire`.
 */
export async function sendMessage(text: string): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed || state.status === 'busy') return;

  // A `claude-*` model is served by the Agent SDK over a WebSocket (server-driven
  // loop), not this client-driven Grok proxy loop. Route and return.
  if (state.model.startsWith('claude')) {
    void sendViaClaude(trimmed);
    return;
  }

  push({ id: newId(), role: 'user', text: trimmed });
  noteUserMessage(trimmed);
  wire.push({ role: 'user', content: trimmed });
  set({ status: 'busy' });

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      let message: AgentWireMessage;
      try {
        const res = await api.agent.chat({ model: state.model, context: buildContext(), messages: wire });
        message = res.message as AgentWireMessage;
      } catch (e) {
        push({ id: newId(), role: 'error', text: e instanceof Error ? e.message : String(e) });
        return;
      }

      // Append the assistant turn verbatim — its tool_calls plumbing must survive
      // into the next request exactly as the model emitted it.
      wire.push(message);

      const calls = message.tool_calls ?? [];
      if (calls.length === 0) {
        push({ id: newId(), role: 'assistant', text: (message.content ?? '').trim() || '(done)' });
        return;
      }

      // Show any text the model wrote alongside its tool calls, then run them.
      const chips: ToolChip[] = [];
      for (const call of calls) {
        let args: Record<string, unknown> = {};
        try {
          args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
        } catch {
          args = {};
        }
        const result = await runTool(call.function.name, args);
        chips.push({ name: call.function.name, result });
        wire.push({ role: 'tool', tool_call_id: call.id, content: result });
      }
      push({
        id: newId(),
        role: 'assistant',
        text: (message.content ?? '').trim(),
        tools: chips,
      });
    }
    push({
      id: newId(),
      role: 'error',
      text: 'Stopped after too many steps. Ask me to continue if that was not finished.',
    });
  } finally {
    set({ status: 'idle' });
    // One save per exchange, after the whole tool loop settled — the entries and
    // wire are now in their final shape for this turn.
    void persistChat();
  }
}

// ── Claude branch: the WebSocket-bridged, server-orchestrated loop ──────────────
//
// Unlike Grok, the SERVER runs the agent loop (via the Claude Agent SDK, on the
// user's subscription). This socket carries three things the other way: streamed
// assistant text, tool-run requests (which we execute locally with the SAME
// runTool the Grok path uses, then post the result back), and a done/error signal.
// One assistant bubble is built per turn: text is appended and tool chips are added
// as they arrive.

let claudeWs: WebSocket | null = null;
/** The assistant entry being built during the current Claude turn (null between turns). */
let claudeTurnId: string | null = null;

function claudeUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/api/agent/claude/ws`;
}

/** Open (or reuse) the Claude socket, resolving once it is ready to send. */
function ensureClaudeSocket(): Promise<WebSocket> {
  if (claudeWs && claudeWs.readyState === WebSocket.OPEN) return Promise.resolve(claudeWs);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(claudeUrl());
    ws.onopen = () => {
      claudeWs = ws;
      resolve(ws);
    };
    ws.onerror = () => reject(new Error('Could not reach the Claude assistant. Is the server running?'));
    ws.onclose = () => {
      if (claudeWs === ws) claudeWs = null;
    };
    ws.onmessage = (evt) => void onClaudeMessage(evt);
  });
}

/** The assistant bubble for this turn, created lazily on first content. */
function currentClaudeEntry(): string {
  if (claudeTurnId) return claudeTurnId;
  const id = newId();
  claudeTurnId = id;
  push({ id, role: 'assistant', text: '', tools: [] });
  return id;
}

function updateEntry(id: string, fn: (e: ChatEntry) => ChatEntry): void {
  set({ entries: state.entries.map((e) => (e.id === id ? fn(e) : e)) });
}

async function onClaudeMessage(evt: MessageEvent): Promise<void> {
  let msg: {
    text?: string;
    tool?: { id: string; name: string; args: Record<string, unknown> };
    session?: string;
    done?: boolean;
    error?: string;
  };
  try {
    msg = JSON.parse(String(evt.data));
  } catch {
    return;
  }

  if (msg.error) {
    push({ id: newId(), role: 'error', text: msg.error });
    return;
  }

  if (typeof msg.session === 'string') {
    // The SDK's session id for this conversation. Held so we can send it back as
    // `resume` next turn, and saved with the chat so a reloaded conversation keeps
    // Claude's context without resending the history. See sendViaClaude / persistChat.
    claudeSessionId = msg.session;
    return;
  }

  if (typeof msg.text === 'string' && msg.text.trim()) {
    const id = currentClaudeEntry();
    const chunk = msg.text;
    updateEntry(id, (e) => ({ ...e, text: e.text ? `${e.text}\n\n${chunk}` : chunk }));
    return;
  }

  if (msg.tool) {
    const { id, name, args } = msg.tool;
    // Run the tool locally against the live document — same executor as Grok —
    // then post the result back so the SDK loop can continue.
    const result = await runTool(name, args);
    const entryId = currentClaudeEntry();
    updateEntry(entryId, (e) => ({ ...e, tools: [...(e.tools ?? []), { name, result }] }));
    claudeWs?.send(JSON.stringify({ t: 'tool_result', id, result }));
    return;
  }

  if (msg.done) {
    // A turn that produced nothing still gets a closing bubble, like Grok's '(done)'.
    if (claudeTurnId) {
      updateEntry(claudeTurnId, (e) =>
        e.text.trim() || (e.tools && e.tools.length) ? e : { ...e, text: '(done)' },
      );
    }
    claudeTurnId = null;
    set({ status: 'idle' });
    // The turn (text, tools, and the session id) is final — save it to the project.
    void persistChat();
  }
}

/** Send a user message over the Claude socket and let the server drive the loop. */
async function sendViaClaude(text: string): Promise<void> {
  push({ id: newId(), role: 'user', text });
  noteUserMessage(text);
  set({ status: 'busy' });
  claudeTurnId = null;
  try {
    const ws = await ensureClaudeSocket();
    // Send `resume` (the saved session id) so the server continues this project's
    // conversation rather than starting fresh — this is what carries context across
    // a reload. On a brand-new chat it is null and the server opens a new session.
    ws.send(
      JSON.stringify({
        t: 'user',
        text,
        model: state.model,
        context: buildContext(),
        resume: claudeSessionId ?? undefined,
      }),
    );
    // status returns to 'idle' when the server sends { done: true }.
  } catch (e) {
    push({ id: newId(), role: 'error', text: e instanceof Error ? e.message : String(e) });
    set({ status: 'idle' });
  }
}
