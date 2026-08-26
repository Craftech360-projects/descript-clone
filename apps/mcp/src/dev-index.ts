#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { buildDevServer } from './dev.ts';

/**
 * `jumpstart-dev` — the second MCP server, the one that changes the code.
 *
 * Runs with the repo as its subject but should be INSTALLED OUTSIDE it, so an
 * agent editing Jumpstart cannot edit the thing that would undo the edit. Point it
 * at the checkout with JUMPSTART_REPO.
 *
 * stdout is the JSON-RPC wire; every diagnostic goes to stderr. See index.ts.
 */

const server = buildDevServer();
await server.connect(new StdioServerTransport());
process.stderr.write(`jumpstart-dev ready (repo: ${process.env.JUMPSTART_REPO ?? 'auto-detected'})\n`);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => void server.close().finally(() => process.exit(0)));
}
