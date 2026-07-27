import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      // ws:true so the Claude agent's WebSocket (/api/agent/claude/ws) is proxied
      // in dev too — the string shorthand only forwards HTTP. In the packaged app
      // the server serves the UI on the same origin, so no proxy is involved.
      '/api': { target: 'http://localhost:8787', ws: true },
      '/media': 'http://localhost:8787',
    },
  },
  plugins: [react()],
});
