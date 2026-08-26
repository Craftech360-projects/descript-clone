#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { buildServer } from './server.ts';

/**
 * `jumpstart-mcp` — the entry point a Hermes host spawns.
 *
 * ── stdout is the wire ──────────────────────────────────────────────────────
 *
 * MCP over stdio frames JSON-RPC on stdout, so ANY stray byte written there
 * corrupts the stream and the host sees a parse error rather than a message.
 * That is why this file is the only one allowed to touch stdout, and why every
 * diagnostic below goes to stderr. It is an easy rule to break by reflex — one
 * console.log while debugging is enough — and the failure looks like a broken
 * MCP implementation rather than like a stray print.
 *
 * (Checked before building on it: Electron under ELECTRON_RUN_AS_NODE=1 writes
 * nothing of its own to stdout, so the packaged app can ship this same server
 * using its own bundled Node rather than requiring one on the machine.)
 *
 * ── why a separate process from the app ─────────────────────────────────────
 *
 * The agent is allowed to edit this project's code. When it breaks the server,
 * the app dies — and if the MCP server had been mounted inside the app, the
 * agent's hands would die with it, leaving it unable to read the log or revert
 * the change that caused the problem. Running here, the editor tools go quiet
 * but editor_status, app_logs and wake_editor keep working. That is the whole
 * reason for the split.
 */

const server = buildServer();
const transport = new StdioServerTransport();

await server.connect(transport);

// stderr, never stdout. See above.
process.stderr.write('jumpstart-mcp ready\n');

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void server.close().finally(() => process.exit(0));
  });
}
