/**
 * Android stand-in for apps/server/src/agent-claude.ts.
 *
 * The real module drives @anthropic-ai/claude-agent-sdk, which locates and
 * spawns a native CLI binary — there is no Android build of that binary, so the
 * SDK cannot run on-device. build.mjs resolves the module id to this file
 * instead (an esbuild onResolve plugin: `alias` cannot match relative imports),
 * which keeps the SDK and its zod dependency out of the bundle entirely.
 *
 * The surface mirrors exactly what the rest of the server imports:
 *   - index.ts:  registerClaudeAgent(app, upgradeWebSocket)
 *   - agent.ts:  CLAUDE_MODELS
 *
 * CONFIG.hasClaude() is env-gated and no Claude token is ever set on Android,
 * so the capabilities endpoint already reports claude: false — the UI never
 * offers the models this stub does not have. The Grok agent is plain HTTP and
 * still works when a key is present.
 */

export const CLAUDE_MODELS: readonly string[] = [];

export function registerClaudeAgent(..._args: unknown[]): void {
  // No WebSocket route is registered. The client only opens
  // /api/agent/claude/ws when capabilities says Claude exists, which it never
  // does on Android.
}
