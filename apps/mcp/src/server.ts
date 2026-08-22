import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import {
  AGENT_SYSTEM_PROMPT,
  AGENT_TOOLS,
} from '../../../packages/core/src/agent-tools.ts';
import { zodShapeFor, toToolContent } from '../../server/src/tool-schema.ts';
import { appLogs, editorStatus, wakeEditor } from './lifecycle.ts';
import * as relay from './relay.ts';

/**
 * Jumpcut, as an MCP server.
 *
 * Every one of the seventy tools is the SAME tool the in-app assistant uses —
 * same schema out of packages/core, same executor in the browser, same undo
 * history. An edit made from here is indistinguishable afterwards from one made
 * by hand, which is the property that makes handing the app to an outside agent
 * reasonable rather than alarming.
 *
 * Five tools are added that only make sense from outside, and none of them go
 * through the bridge: an external caller needs to be able to ask "is it even
 * running" and "start it" precisely when the answer to the first is no.
 *
 * The prompts and resources are not decoration. The user's ask was to hand over
 * "all the existing control tools, memory, and style" — tools are the control,
 * AGENT_SYSTEM_PROMPT is the style (verbatim, from the same constant the panel
 * uses, so the two cannot drift), and the folder briefs are the memory. Serving
 * the last two as resources means the agent can read them without spending a
 * tool call, which matters when a host loads context up front.
 */

/** Where an unattached call should send the caller. Matches the server's wording. */
const NO_WINDOW =
  'No editor window is attached, and this tool edits the live document. Call wake_editor to open one, or editor_status to see what is running.';

export function buildServer(): McpServer {
  const mcp = new McpServer({ name: 'jumpcut', version: '0.1.0' });

  /**
   * Which window to drive, for the life of this MCP connection.
   *
   * Deliberately NOT a parameter on the seventy shared specs: those are consumed
   * by Grok and by local models that have no notion of a session, and leaking
   * transport plumbing into the tool contract would change the schema everywhere
   * to serve one caller. A separate tool pins it instead.
   */
  let pinned: string | null = null;

  // ── the seventy ────────────────────────────────────────────────────────────
  for (const spec of AGENT_TOOLS) {
    mcp.registerTool(
      spec.function.name,
      { description: spec.function.description, inputSchema: zodShapeFor(spec) },
      async (args: Record<string, unknown>) => {
        try {
          return toToolContent(await relay.call(spec.function.name, args, pinned));
        } catch (e) {
          /**
           * Answer in the tool's own voice, never by throwing.
           *
           * A model reads "Jumpcut is not running — call wake_editor" and does
           * something about it. A transport rejection surfaces several layers up
           * as a protocol error with no way back into the conversation, and the
           * agent's next move is usually to give up or to retry identically.
           */
          if (e instanceof relay.NotRunning) {
            return toToolContent('Jumpcut is not running. Call wake_editor to start it.');
          }
          return toToolContent(`Error: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    );
  }

  // ── the five that only make sense from outside ─────────────────────────────

  mcp.registerTool(
    'editor_status',
    {
      description:
        'Is Jumpcut running, is the bridge on, and which editor windows are attached. Call this first when a tool says the editor is not ready.',
      inputSchema: {},
    },
    async () => toToolContent(await editorStatus()),
  );

  mcp.registerTool(
    'wake_editor',
    {
      description:
        'Start Jumpcut if it is not running and wait until an editor window is attached and ready to take tool calls. Safe to call when it is already up.',
      inputSchema: {},
    },
    async () => toToolContent(await wakeEditor()),
  );

  mcp.registerTool(
    'list_editor_sessions',
    {
      description:
        'List the attached editor windows, with the project each is showing. Use when more than one is open and you need to choose.',
      inputSchema: {},
    },
    async () => {
      try {
        const s = await relay.status();
        if (!s.windows) return toToolContent(NO_WINDOW);
        return toToolContent(
          s.sessions
            .map(
              (w) =>
                `${w.id} · ${w.projectName ?? '(no project open)'}${w.busy ? ' · working' : ''} · attached ${w.since}`,
            )
            .join('\n'),
        );
      } catch (e) {
        if (e instanceof relay.NotRunning) return toToolContent('Jumpcut is not running. Call wake_editor.');
        throw e;
      }
    },
  );

  mcp.registerTool(
    'use_editor_session',
    {
      description:
        'Send every later tool call to one specific editor window. Pass no id to go back to the most recently active one.',
      inputSchema: { session_id: z.string().optional().describe('From list_editor_sessions. Omit to unpin.') },
    },
    async (args: { session_id?: string }) => {
      pinned = args.session_id ?? null;
      return toToolContent(
        pinned ? `Pinned to window ${pinned}.` : 'Unpinned — using the most recently active window.',
      );
    },
  );

  mcp.registerTool(
    'app_logs',
    {
      description:
        "Read the tail of Jumpcut's server log. Works when the app is down, which is when it matters.",
      inputSchema: { lines: z.number().optional().describe('How many trailing lines. Default 80.') },
    },
    async (args: { lines?: number }) => toToolContent(await appLogs(Math.round(args.lines ?? 80))),
  );

  // ── style ──────────────────────────────────────────────────────────────────

  mcp.registerPrompt(
    'jumpy',
    {
      title: 'Jumpy — the editing brief',
      description:
        "The same system prompt the in-app assistant works to: how to act, when to ask, and how to think about music, captions and cuts.",
    },
    () => ({
      messages: [{ role: 'user' as const, content: { type: 'text' as const, text: AGENT_SYSTEM_PROMPT } }],
    }),
  );

  mcp.registerPrompt(
    'video_editor',
    {
      title: 'An experienced video editor',
      description: 'Jumpy’s brief plus the current state of the editor, ready to start work.',
    },
    async () => {
      let context = '';
      try {
        context = await relay.call('get_project_context', {}, pinned);
      } catch {
        context = 'Jumpcut is not running yet. Call wake_editor before trying to edit.';
      }
      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: `${AGENT_SYSTEM_PROMPT}\n\n# Where things stand\n\n${context}`,
            },
          },
        ],
      };
    },
  );

  // ── memory ─────────────────────────────────────────────────────────────────

  mcp.registerResource(
    'system-prompt',
    'jumpcut://system-prompt',
    { title: 'Jumpy’s brief', description: 'The editing brief, verbatim.', mimeType: 'text/markdown' },
    async (uri: URL) => ({
      contents: [{ uri: uri.href, mimeType: 'text/markdown', text: AGENT_SYSTEM_PROMPT }],
    }),
  );

  mcp.registerResource(
    'folders',
    'jumpcut://folders',
    {
      title: 'Folders and their memory',
      description:
        'Each folder’s brief — what the channel is, who it is for, how its titles should read. This is what stops a written title sounding like a summary of the words.',
      mimeType: 'text/markdown',
    },
    async (uri: URL) => {
      let text: string;
      try {
        text = await relay.call('list_folders', {}, pinned);
      } catch {
        text = 'Jumpcut is not running.';
      }
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text }] };
    },
  );

  mcp.registerResource(
    'projects',
    'jumpcut://projects',
    { title: 'The library', description: 'Every project, with its id.', mimeType: 'text/markdown' },
    async (uri: URL) => {
      let text: string;
      try {
        text = await relay.call('list_projects', {}, pinned);
      } catch {
        text = 'Jumpcut is not running.';
      }
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text }] };
    },
  );

  mcp.registerResource(
    'transcript',
    new ResourceTemplate('jumpcut://projects/{id}/transcript', { list: undefined }),
    { title: 'A project’s transcript', description: 'The script, as timestamped lines.', mimeType: 'text/markdown' },
    async (uri: URL, vars: { id: string | string[] }) => {
      const id = Array.isArray(vars.id) ? vars.id[0] : vars.id;
      let text: string;
      try {
        await relay.call('open_project', { project_id: id }, pinned);
        text = await relay.call('read_transcript', {}, pinned);
      } catch {
        text = 'Jumpcut is not running.';
      }
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text }] };
    },
  );

  mcp.registerResource(
    'editor',
    'jumpcut://editor',
    { title: 'What the editor is showing', description: 'Live state of the open project.', mimeType: 'text/markdown' },
    async (uri: URL) => ({
      contents: [{ uri: uri.href, mimeType: 'text/markdown', text: await editorStatus() }],
    }),
  );

  return mcp;
}
