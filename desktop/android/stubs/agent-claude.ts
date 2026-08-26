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
 *   - index.ts:   registerClaudeAgent(app, upgradeWebSocket)
 *   - agent.ts:   CLAUDE_MODELS, CLAUDE_MODEL_HINTS
 *   - social.ts:  completeOnce
 *
 * Every export the real module gains has to be added here or the Android bundle
 * stops building — which is the point. esbuild fails loudly on a missing export,
 * so this file cannot silently fall behind the thing it stands in for.
 *
 * CONFIG.hasClaude() is env-gated and no Claude token is ever set on Android,
 * so the capabilities endpoint already reports claude: false — the UI never
 * offers the models this stub does not have. The Grok agent is plain HTTP and
 * still works when a key is present.
 */

export const CLAUDE_MODELS: readonly string[] = [];

/** Empty for the same reason CLAUDE_MODELS is: there are no models to describe. */
export const CLAUDE_MODEL_HINTS: Record<string, string> = {};

export function registerClaudeAgent(..._args: unknown[]): void {
  // No WebSocket route is registered. The client only opens
  // /api/agent/claude/ws when capabilities says Claude exists, which it never
  // does on Android.
}

/**
 * One-shot completion, used by the social copy writer.
 *
 * Throws rather than returning empty text. social.ts routes to this branch only
 * when the chosen model id starts with `claude-` AND CONFIG.hasClaude() is true,
 * which cannot happen on Android — so reaching here means the routing changed,
 * and a thrown message naming the reason is far easier to diagnose than a draft
 * that silently comes back blank.
 */
export async function completeOnce(_model: string, _prompt: string): Promise<string> {
  throw new Error('Claude is not available on Android. Pick a local or Grok model.');
}
