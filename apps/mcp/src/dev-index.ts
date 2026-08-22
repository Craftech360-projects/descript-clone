#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { buildDevServer } from './dev.ts';

/**
 * `jumpcut-dev` — the second MCP server, the one that changes the code.
 *
 * Runs with the repo as its subject but should be INSTALLED OUTSIDE it, so an
 * agent editing Jumpcut cannot edit the thing that would undo the edit. Point it
 * at the checkout with JUMPCUT_REPO.
 *
 * stdout is the JSON-RPC wire; every diagnostic goes to stderr. See index.ts.
 */

const server = buildDevServer();
await server.connect(new StdioServerTransport());
process.stderr.write(`jumpcut-dev ready (repo: ${process.env.JUMPCUT_REPO ?? 'auto-detected'})\n`);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => void server.close().finally(() => process.exit(0)));
}
