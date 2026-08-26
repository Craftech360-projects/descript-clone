/**
 * The Social routes: folders with a standing brief, and the copy they inform.
 *
 * Generation runs through whichever model the user picked — including a local
 * one — because this is exactly the workload a 7B model is good at: short,
 * bounded, one answer, no tool loop to hold together. With Ollama running, a
 * title and description never leave the machine.
 */

import type { Hono } from 'hono';

import * as folders from './folders.ts';
import * as store from './store.ts';
import { CONFIG } from './config.ts';
import * as local from './agent-local.ts';
import { completeOnce } from './agent-claude.ts';
import {
  buildPrompt,
  condenseTranscript,
  parseDraft,
  targetFor,
} from '../../../packages/core/src/social.ts';

/** One non-streaming completion from whichever backend the id names. */
async function once(model: string, prompt: string): Promise<{ text?: string; error?: string }> {
  if (local.isLocalModel(model)) {
    // No tools: this is a writing task, and tool schemas are the thing small
    // models handle worst. See agent-local's note on tool breadth.
    const r = await local.chat(local.stripPrefix(model), [{ role: 'user', content: prompt }], []);
    if (r.error) return { error: r.error };
    const content = (r.message as { content?: unknown })?.content;
    return { text: typeof content === 'string' ? content : '' };
  }

  // Claude does not speak the OpenAI chat API — it goes through the Agent SDK.
  // Missing this branch is why picking a Claude model here reported "no model
  // available" while the picker was happily offering three of them.
  if (model.startsWith('claude-') && CONFIG.hasClaude()) {
    try {
      return { text: await completeOnce(model, prompt) };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }

  if (CONFIG.hasAgent()) {
    try {
      const res = await fetch(`${CONFIG.xaiBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CONFIG.xaiKey}` },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }] }),
      });
      const data = (await res.json()) as any;
      if (!res.ok) return { error: data?.error?.message ?? `provider returned ${res.status}` };
      return { text: data?.choices?.[0]?.message?.content ?? '' };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }

  return {
    error:
      'No model is available for writing. Start a local model (Ollama or LM Studio) and pick it in the assistant, or configure a hosted one.',
  };
}

/**
 * The chosen model first, a local one as the safety net.
 *
 * Claude answers when it can, and is the default. But it is the only part of
 * this that needs the network and a live token, and a title is not worth
 * failing the request over — if the machine has a local runtime it is sitting
 * idle at loopback and is good at exactly this shape of work: short, bounded,
 * one answer, no tool loop to hold together.
 *
 * The fallback only ever runs DOWNHILL. A local model that fails has nowhere
 * cheaper to go, so it is never retried against a hosted one — that would spend
 * the user's money to paper over a runtime they chose deliberately.
 *
 * And it is never silent: the caller is told which model actually answered.
 * Copy from a 7B and copy from Claude are not the same thing, and whoever is
 * about to publish it should know which one they are reading.
 */
async function complete(
  model: string,
  prompt: string,
): Promise<{ text?: string; error?: string; ranOn?: string; fellBack?: boolean }> {
  const first = await once(model, prompt);
  if (!first.error) return { ...first, ranOn: model };

  if (local.isLocalModel(model) || !local.hasLocalAgent()) return first;

  const backup = local.localAgent()?.models[0];
  if (!backup) return first;

  const second = await once(local.LOCAL_PREFIX + backup, prompt);
  if (second.error) {
    // Both failed: say so in one message. Reporting only the second would blame
    // the backup for a problem that started upstream.
    return {
      error: `${model} failed (${first.error}) and the local backup ${backup} also failed (${second.error}).`,
    };
  }
  return { ...second, ranOn: local.LOCAL_PREFIX + backup, fellBack: true };
}

export function registerSocial(app: Hono): void {
  app.get('/api/folders', async (c) => c.json(await folders.list()));

  app.post('/api/folders', async (c) => {
    const body = await c.req.json<{ name?: string; brief?: string }>().catch(() => ({}));
    if (!body.name?.trim()) return c.json({ error: 'A folder needs a name.' }, 400);
    return c.json(await folders.create(body.name, body.brief ?? ''));
  });

  app.patch('/api/folders/:id', async (c) => {
    const body = await c.req.json<{ name?: string; brief?: string }>().catch(() => ({}));
    const updated = await folders.update(c.req.param('id'), body);
    return updated ? c.json(updated) : c.json({ error: 'No such folder' }, 404);
  });

  app.delete('/api/folders/:id', async (c) => {
    const gone = await folders.remove(c.req.param('id'));
    if (!gone) return c.json({ error: 'No such folder' }, 404);
    // Projects keep existing — a folder is context, not containment. Detach them
    // rather than deleting someone's footage along with a label.
    const all = await store.list();
    for (const p of all) {
      if ((p as { folderId?: string }).folderId === c.req.param('id')) {
        const full = await store.get(p.id);
        if (full) {
          delete (full as { folderId?: string }).folderId;
          await store.save(full);
        }
      }
    }
    return c.json({ ok: true });
  });

  /** Put a project in a folder, or take it out with a null id. */
  app.patch('/api/projects/:id/folder', async (c) => {
    const project = await store.get(c.req.param('id'));
    if (!project) return c.json({ error: 'No such project' }, 404);

    const { folderId } = await c.req.json<{ folderId?: string | null }>().catch(() => ({ folderId: null }));
    if (folderId) {
      const folder = await folders.get(folderId);
      if (!folder) return c.json({ error: 'No such folder' }, 404);
      (project as { folderId?: string }).folderId = folderId;
    } else {
      delete (project as { folderId?: string }).folderId;
    }
    await store.save(project);
    return c.json(project);
  });

  /**
   * Write the post: title, description, hashtags.
   *
   * The transcript says what happened; the folder's brief says what the channel
   * IS. Without the second, a model writes a competent summary of the words —
   * which is the one thing a title must not be.
   */
  app.post('/api/projects/:id/social', async (c) => {
    const project = await store.get(c.req.param('id'));
    if (!project) return c.json({ error: 'No such project' }, 404);

    const words = project.transcript?.words ?? [];
    if (words.length === 0) {
      return c.json(
        { error: 'Transcribe this project first — there are no words to write from.' },
        400,
      );
    }

    const body = await c.req.json<{ model?: string; target?: string }>().catch(() => ({}));
    const model = body.model?.trim();
    if (!model) return c.json({ error: 'Pick a model first.' }, 400);

    const target = targetFor(String(body.target ?? 'reels'));
    const folderId = (project as { folderId?: string }).folderId;
    const folder = folderId ? await folders.get(folderId) : null;

    const transcript = condenseTranscript(
      words.filter((w) => !w.deleted).map((w) => w.text).join(' '),
    );

    const prompt = buildPrompt({
      transcript,
      brief: folder?.brief ?? '',
      target,
      projectName: project.name,
    });

    const { text, error, ranOn, fellBack } = await complete(model, prompt);
    if (error) return c.json({ error }, 502);

    const draft = parseDraft(text ?? '', target);
    if (!draft) {
      // Say what came back rather than showing an empty form. A small model that
      // answered in prose is a fixable situation; a blank panel is a mystery.
      return c.json(
        {
          error: `${model} did not return usable copy. Try again, or pick a stronger model.`,
          raw: (text ?? '').slice(0, 400),
        },
        502,
      );
    }

    return c.json({
      draft,
      usedBrief: Boolean(folder?.brief?.trim()),
      folder: folder?.name ?? null,
      // Which model actually answered, and whether that was the second choice.
      // The panel and the agent both say so rather than presenting a local
      // draft as though Claude had written it.
      ranOn: ranOn ?? model,
      fellBack: Boolean(fellBack),
    });
  });
}
