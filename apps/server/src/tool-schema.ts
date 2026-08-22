import { z, type ZodTypeAny } from 'zod';

import type { AgentToolSpec } from '../../../packages/core/src/agent-tools.ts';

/**
 * JSON Schema → Zod, and tool results → MCP content blocks.
 *
 * AGENT_TOOLS is written once in OpenAI function-spec shape, because Grok and
 * every local OpenAI-compatible model consume it directly. Both MCP surfaces —
 * the in-process one the Jumpy panel drives (agent-claude.ts) and the external
 * one Hermes connects to (apps/mcp) — need Zod instead, because neither the
 * Agent SDK's tool() nor McpServer.registerTool accepts raw JSON Schema.
 *
 * This lived inside agent-claude.ts until there were two callers. It is lifted
 * out unchanged rather than reimplemented: a second converter that disagreed
 * with the first about, say, whether an absent `required` entry means optional
 * would produce two different tool contracts for the same 70 tools, and the
 * disagreement would only show up as a model getting an argument wrong.
 *
 * The specs use a deliberately small slice of JSON Schema — string, integer,
 * number, boolean, array-of-scalar, string enums, ["T","null"] unions,
 * descriptions and required — which is what keeps this total. agent-tools.test.ts
 * pins that: if a future tool introduces a type this does not handle, it fails
 * there rather than silently reaching the model as `unknown`, which reads as
 * "any" and is an argument the model cannot see the shape of.
 */
export function zodForProperty(spec: Record<string, unknown>): ZodTypeAny {
  if (Array.isArray(spec.enum)) {
    // Every enum in AGENT_TOOLS is a set of string literals (modes, presets, fonts).
    return z.enum(spec.enum as [string, ...string[]]);
  }
  const types = Array.isArray(spec.type) ? spec.type : [spec.type];
  const nullable = types.includes('null');
  const base = types.find((t) => t !== 'null');
  let t: ZodTypeAny;
  switch (base) {
    case 'string':
      t = z.string();
      break;
    case 'integer':
    case 'number':
      t = z.number();
      break;
    case 'boolean':
      t = z.boolean();
      break;
    case 'array':
      // Arrays are always arrays of a scalar here (clip ids, filler words), so
      // the item type recurses through this same function. Without this branch
      // they fell through to z.unknown(), which reaches the model as "any" — and
      // an argument the model cannot see the shape of is one it gets wrong.
      t = z.array(zodForProperty((spec.items as Record<string, unknown>) ?? { type: 'string' }));
      break;
    default:
      t = z.unknown();
  }
  return nullable ? t.nullable() : t;
}

export function zodShapeFor(spec: AgentToolSpec): Record<string, ZodTypeAny> {
  const { properties, required = [] } = spec.function.parameters;
  const req = new Set(required);
  const shape: Record<string, ZodTypeAny> = {};
  for (const [key, raw] of Object.entries(properties)) {
    const prop = raw as Record<string, unknown>;
    let t = zodForProperty(prop);
    if (typeof prop.description === 'string') t = t.describe(prop.description);
    if (!req.has(key)) t = t.optional();
    shape[key] = t;
  }
  return shape;
}

/** The MCP content-block shape, identical between the Agent SDK and the MCP SDK. */
export type ToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

/**
 * A tool that returns a PICTURE returns it as a picture.
 *
 * look_at_frame renders one finished frame so the model can check its own work —
 * a caption's position, a crop, a grade. Handing that back as a data-URL string
 * would be words about an image rather than the image, which is the one thing
 * that makes the tool worth having. The browser marks such a result with an
 * IMAGE: sentinel (see apps/web/src/agent/tools.ts); everything else is ordinary
 * text and takes the path it always did.
 *
 * Backends that cannot carry an image — Grok, the local models — get the trailing
 * note only. Degraded, not broken.
 */
export function toToolContent(result: string): { content: ToolContent[] } {
  const image = /^IMAGE:([a-z/+.-]+);base64,([\s\S]+?)\n([\s\S]*)$/i.exec(result);
  if (image) {
    return {
      content: [
        { type: 'image', data: image[2], mimeType: image[1] },
        { type: 'text', text: image[3] },
      ],
    };
  }
  return { content: [{ type: 'text', text: result }] };
}
