import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The API needs a token now (apps/server/src/auth.ts), and the dev server is the
 * one caller that cannot be handed one the usual way.
 *
 * In every other mode the server itself serves the page, so it can set the
 * cookie on the way past. Here Vite serves the page on :5173 and only PROXIES
 * /api and /media to :8787 — so nothing in the chain ever visits a route that
 * issues a credential, and every request would 401.
 *
 * Reading the token file directly is fine and is not a leak: this runs in Node,
 * at dev-server startup, on the same machine that owns the file. It never
 * reaches the browser bundle.
 */
function devToken(): string {
  if (process.env.JUMPSTART_TOKEN) return process.env.JUMPSTART_TOKEN;
  const path =
    process.env.DATA_DIR
      ? `${process.env.DATA_DIR}/token`
      : fileURLToPath(new URL('../../data/token', import.meta.url));
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    // Server has not booted yet, so it has not minted one. Start the server
    // first; a restart of `npm run web` picks it up.
    return '';
  }
}

const token = devToken();
const headers = token ? { Authorization: `Bearer ${token}` } : undefined;

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      // ws:true so the Claude agent's WebSocket (/api/agent/claude/ws) is proxied
      // in dev too — the string shorthand only forwards HTTP. In the packaged app
      // the server serves the UI on the same origin, so no proxy is involved.
      '/api': { target: 'http://localhost:8787', ws: true, headers },
      '/media': { target: 'http://localhost:8787', headers },
    },
  },
  plugins: [react()],
});
