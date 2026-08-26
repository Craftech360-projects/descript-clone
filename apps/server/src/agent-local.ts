/**
 * The assistant, run on this machine — Ollama, LM Studio, llama.cpp, anything
 * that speaks the OpenAI chat API.
 *
 * ── why this is barely any code ─────────────────────────────────────────────
 *
 * Every local runtime worth using exposes `/v1/chat/completions` in OpenAI's
 * shape, which is the same shape the Grok branch already speaks. So this is not
 * a new agent: it is the same request with a different base URL and no
 * Authorization header. The client's tool loop, the system brief and the tool
 * schemas are untouched.
 *
 * ── the honest caveat about tools ──────────────────────────────────────────
 *
 * This editor's assistant is USELESS without tool calling — it exists to cut
 * words, not to chat. Local support for that varies by model far more than by
 * runtime: Qwen, Llama 3.1+ and Mistral emit tool calls reliably; Gemma is
 * strong at language and weaker at structured calls, and some runtimes do not
 * advertise tools for it at all. So `probe` reports what is REACHABLE and the
 * turn reports honestly when a model answers without ever calling a tool,
 * rather than leaving the user to wonder why nothing happened.
 *
 * Nothing here talks to the internet. With a local model configured the whole
 * product — transcription, editing, captions, render, assistant — runs offline.
 */

import type { Hono } from 'hono';

/**
 * Where local runtimes listen, in the order worth trying.
 *
 * Ollama first because it is the common default; LM Studio second; the last two
 * are what llama.cpp's own server and a few wrappers use. `LOCAL_LLM_URL` skips
 * the search entirely.
 */
const CANDIDATES = [
  'http://127.0.0.1:11434/v1', // Ollama
  'http://127.0.0.1:1234/v1',  // LM Studio
  'http://127.0.0.1:8080/v1',  // llama.cpp server
  'http://127.0.0.1:5001/v1',  // koboldcpp and friends
];

/** Model ids are prefixed so one picker can offer local and remote together. */
export const LOCAL_PREFIX = 'local:';

export const isLocalModel = (id: string): boolean => id.startsWith(LOCAL_PREFIX);
export const stripPrefix = (id: string): string => id.slice(LOCAL_PREFIX.length);

/**
 * The tools a local model gets — a subset, deliberately.
 *
 * Measured on this machine with Ollama 0.32 and qwen2.5:7b: handed ONE tool it
 * calls it correctly and says nothing else. Handed all 63 (34KB of schema) it
 * stops calling tools at all and answers in prose — in the observed case it
 * offered to transcribe a project that was already transcribed.
 *
 * That is not a plumbing failure and not really a model failure either: tool
 * selection degrades with breadth, and a 7B model choosing between sixty-three
 * options is being asked something a frontier model finds easy and it does not.
 * Hosted models keep the full set; local models get the editing verbs someone
 * actually asks for out loud, which is where the value is anyway.
 *
 * Ordered roughly by how often a person says the sentence that triggers them.
 */
const CORE_TOOLS = [
  'get_project_context',
  'read_transcript',
  'find_in_transcript',
  'remove_fillers',
  'remove_retakes',
  'delete_text',
  'restore_text',
  'correct_word',
  'select_text',
  'set_pause_cap',
  'split_at_playhead',
  'set_captions',
  'set_speed',
  'seek',
  'undo',
  'export_video',
];

/**
 * Narrow a tool list for a local model. Anything unrecognised is dropped rather
 * than passed through, so this stays a whitelist as the tool set grows.
 */
export function narrowTools(tools: unknown): unknown {
  if (!Array.isArray(tools)) return tools;
  const keep = new Set(CORE_TOOLS);
  const narrowed = tools.filter((t) => {
    const name = (t as { function?: { name?: string } })?.function?.name;
    return typeof name === 'string' && keep.has(name);
  });
  // If the shapes ever change and nothing matches, sending everything is a
  // better failure than sending nothing.
  return narrowed.length > 0 ? narrowed : tools;
}

interface Found {
  baseUrl: string;
  models: string[];
}

let found: Found | null = null;
let probed = false;

/** What was discovered at boot, for handlers that cannot await. */
export function localAgent(): Found | null {
  return found;
}

export function hasLocalAgent(): boolean {
  return found !== null && found.models.length > 0;
}

async function ask(baseUrl: string, timeoutMs = 1200): Promise<string[] | null> {
  const abort = AbortSignal.timeout(timeoutMs);
  try {
    const r = await fetch(`${baseUrl}/models`, { signal: abort });
    if (!r.ok) return null;
    const data = (await r.json()) as { data?: Array<{ id?: string }> };
    const ids = (data.data ?? []).map((m) => m.id).filter((id): id is string => Boolean(id));
    return ids;
  } catch {
    // Nothing listening, or it is not an OpenAI-shaped server. Either way: not this one.
    return null;
  }
}

/**
 * Look for a local runtime. Cheap and bounded — four connections to loopback
 * with a short timeout, once at boot, so a machine with nothing installed pays
 * a few milliseconds and moves on.
 */
export async function probe(): Promise<Found | null> {
  probed = true;
  const configured = process.env.LOCAL_LLM_URL?.replace(/\/+$/, '');
  const list = configured ? [configured] : CANDIDATES;

  for (const baseUrl of list) {
    const models = await ask(baseUrl);
    if (models) {
      found = { baseUrl, models };
      console.log(
        `agent   local runtime at ${baseUrl} (${models.length} model${models.length === 1 ? '' : 's'})`,
      );
      return found;
    }
  }
  found = null;
  return null;
}

/** Re-run the search — the user may have started Ollama after the server. */
export async function refresh(): Promise<Found | null> {
  return probe();
}

export function registerLocalAgent(app: Hono): void {
  /**
   * Look again, on demand. A local runtime is started and stopped by hand far
   * more often than an API key is rotated, so the picker needs a way to notice
   * without restarting the server.
   */
  app.post('/api/agent/local/refresh', async (c) => {
    const f = await refresh();
    return c.json({
      available: Boolean(f),
      baseUrl: f?.baseUrl ?? null,
      models: f?.models ?? [],
      probed,
    });
  });

  app.get('/api/agent/local', (c) =>
    c.json({
      available: hasLocalAgent(),
      baseUrl: found?.baseUrl ?? null,
      models: found?.models ?? [],
      hint:
        'Start Ollama (ollama serve) or LM Studio\'s local server, then pull a tool-calling model — ' +
        'qwen2.5, llama3.1 or mistral emit tool calls reliably. Set LOCAL_LLM_URL to point elsewhere.',
    }),
  );
}

/**
 * Rescue a tool call a small model emitted as PROSE.
 *
 * Observed with qwen2.5:7b: asked to cut long pauses it answered with the
 * content field set to
 *
 *     nostalgically {"name": "set_pause_cap", "arguments": {"ms": 500}}
 *
 * — the right call, in the wrong channel, with a stray word in front. The model
 * decided correctly and then failed at protocol, which is the characteristic
 * small-model failure and a silly reason to lose a turn.
 *
 * Deliberately narrow: it fires only when the model returned NO real tool calls,
 * it requires a name the tool list actually contains, and anything it cannot
 * parse cleanly is left alone as ordinary text. A false positive here would
 * invent an edit nobody asked for, so the bar is "unambiguous or nothing".
 */
export function salvageToolCall(message: any, tools: unknown): any {
  if (!message || (Array.isArray(message.tool_calls) && message.tool_calls.length > 0)) return message;
  const content = typeof message.content === 'string' ? message.content : '';
  if (!content.includes('"name"')) return message;

  const names = new Set(
    (Array.isArray(tools) ? tools : [])
      .map((t: any) => t?.function?.name)
      .filter((n: unknown): n is string => typeof n === 'string'),
  );

  // Scan for balanced JSON objects rather than regexing nested braces.
  for (let i = content.indexOf('{'); i !== -1; i = content.indexOf('{', i + 1)) {
    let depth = 0;
    for (let j = i; j < content.length; j++) {
      if (content[j] === '{') depth++;
      else if (content[j] === '}') depth--;
      if (depth !== 0) continue;

      try {
        const parsed = JSON.parse(content.slice(i, j + 1));
        if (parsed && typeof parsed.name === 'string' && names.has(parsed.name)) {
          const args = parsed.arguments ?? parsed.parameters ?? {};
          return {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: `salvaged_${parsed.name}`,
                type: 'function',
                function: {
                  name: parsed.name,
                  arguments: typeof args === 'string' ? args : JSON.stringify(args),
                },
              },
            ],
          };
        }
      } catch {
        /* not JSON, or not the shape we want — keep scanning */
      }
      break;
    }
  }
  return message;
}

/**
 * One turn against the local model. Same contract as the Grok branch: in goes
 * the conversation plus tools, out comes one assistant message for the client
 * to execute.
 */
export async function chat(
  model: string,
  messages: unknown[],
  tools: unknown,
): Promise<{ message?: unknown; error?: string; status?: number }> {
  const f = found;
  if (!f) {
    return {
      error:
        'No local model is running. Start Ollama (`ollama serve`) or LM Studio\'s server, then press Refresh in the model picker.',
      status: 400,
    };
  }

  try {
    const r = await fetch(`${f.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // No streaming: the client's loop wants one complete message per turn, and
      // a local model on a laptop is fast enough that the wait is not the problem.
      body: JSON.stringify({
        model,
        messages,
        tools: narrowTools(tools),
        tool_choice: 'auto',
        stream: false,
      }),
      // Generous: a 7B model on CPU can take a while for the first token, and
      // failing a turn that was merely slow is worse than waiting.
      signal: AbortSignal.timeout(180_000),
    });

    const raw = await r.text();
    let data: any;
    try {
      data = JSON.parse(raw);
    } catch {
      return { error: `The local model returned something that is not JSON: ${raw.slice(0, 200)}`, status: 502 };
    }

    if (!r.ok) {
      const detail = data?.error?.message ?? data?.error ?? raw.slice(0, 300);
      return { error: `Local model ${r.status}: ${detail} (model: ${model})`, status: 502 };
    }

    const message = data?.choices?.[0]?.message;
    if (!message) return { error: 'The local model returned no message.', status: 502 };
    return { message: salvageToolCall(message, narrowTools(tools)) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // A timeout here is almost always the model still loading into memory.
    return {
      error: msg.includes('timeout')
        ? `The local model did not answer in time. A model this size may still be loading — try again once it is warm.`
        : msg,
      status: 502,
    };
  }
}
