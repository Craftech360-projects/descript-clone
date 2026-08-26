import type { Hono } from 'hono';

import * as auth from './auth.ts';
import * as bridge from './bridge.ts';
import {
  callEditor,
  listSessions,
  resolveSession,
  sessionCount,
} from './editor-bridge.ts';

/**
 * The control surface an outside agent drives the editor through.
 *
 * Two different doors, with deliberately different rules — see the note in
 * bridge.ts. `/api/editor/ws` is where a WINDOW volunteers to execute tools.
 * These routes are where a CALLER asks for one to be executed. Attaching a
 * window and commanding one are not the same act and should not share a rule:
 * the window is the app itself and authenticates as the app; the caller is a
 * separate program the user has deliberately switched on.
 *
 * Hence the `enabled` gate here and not there. Until someone turns the bridge on
 * in Settings, every route below is 403 no matter how good the credential is.
 *
 * The status route is deliberately readable whenever the caller holds the app's
 * token, even with the bridge off — the Settings panel polls it to show whether
 * a window is attached, and a panel that cannot report the state it is asking
 * you to change is not much of a panel.
 */
export function registerBridgeRoutes(app: Hono): void {
  /** What is running, what is attached, and is the bridge on. */
  app.get('/api/bridge/status', (c) => {
    const s = bridge.state();
    return c.json({
      enabled: s.enabled,
      url: bridge.url(),
      mode: s.mode,
      pid: s.pid,
      startedAt: s.startedAt,
      logPath: s.logPath,
      /** Whether the server was started under --watch, so an edit will bounce it. */
      watch: process.execArgv.some((a) => a.startsWith('--watch')),
      sessions: listSessions(),
      windows: sessionCount(),
    });
  });

  /** Turn the bridge on or off. The switch in Settings. */
  app.post('/api/bridge', async (c) => {
    const body = await c.req.json<{ enabled?: unknown }>().catch(() => ({}));
    if (typeof body.enabled !== 'boolean') return c.json({ error: 'Provide enabled: true or false.' }, 400);
    const next = await bridge.setEnabled(body.enabled);
    return c.json({ enabled: next.enabled });
  });

  /**
   * Mint a new token.
   *
   * Every attached window keeps working — the renderer authenticates by Origin,
   * not by the token (see auth.ts) — but every EXTERNAL caller is cut off until
   * it re-reads bridge.json. That is the point of the button.
   */
  app.post('/api/bridge/rotate', async (c) => {
    const token = await auth.rotate();
    await bridge.publish(bridge.state().port);
    return c.json({ token });
  });

  /** The token, for the Settings panel to display and copy. */
  app.get('/api/bridge/token', (c) => c.json({ token: auth.currentToken() }));

  /**
   * Run one tool in an attached window.
   *
   * This is the whole external surface: the MCP server exposes seventy tools and
   * every one of them ends up here. Keeping it as a single route rather than
   * seventy is what stops the two sides needing to be redeployed together — the
   * tool list lives in packages/core and both read it from there.
   */
  app.post('/api/bridge/call', async (c) => {
    if (!bridge.enabled()) {
      return c.json(
        { error: 'The Hermes bridge is switched off. Turn it on in Settings → Connect Hermes.' },
        403,
      );
    }

    const body = await c.req
      .json<{ name?: unknown; args?: unknown; session?: unknown }>()
      .catch(() => ({}) as Record<string, unknown>);

    const name = typeof body.name === 'string' ? body.name : '';
    if (!name) return c.json({ error: 'Provide name.' }, 400);
    const args = (body.args && typeof body.args === 'object' ? body.args : {}) as Record<string, unknown>;
    const wanted = typeof body.session === 'string' ? body.session : null;

    const session = resolveSession(wanted);
    if (!session) {
      /**
       * Not an error status. A tool that needs a window and has none is a
       * situation the model can DO something about — call wake_editor — and a
       * 4xx here would surface several layers up as a transport failure with no
       * way back into the conversation. Answer in the tool's own voice instead.
       */
      return c.json({
        result: wanted
          ? `No editor window with id ${wanted} is attached. Call list_editor_sessions to see what is.`
          : 'No editor window is attached, and this tool edits the live document. Call wake_editor to open one, or editor_status to see what is running.',
        attached: false,
      });
    }

    const result = await callEditor(session, name, args);
    return c.json({ result, attached: true, session: session.id });
  });

  /** Which windows are attached, and what each is showing. */
  app.get('/api/bridge/sessions', (c) => {
    if (!bridge.enabled()) return c.json({ error: 'The Hermes bridge is switched off.' }, 403);
    return c.json({ sessions: listSessions() });
  });
}
