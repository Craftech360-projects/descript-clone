import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AGENT_TOOLS, AGENT_TOOL_NAMES, AGENT_SYSTEM_PROMPT } from './agent-tools.ts';

/**
 * The shared tool contract, which had no test at all until now.
 *
 * AGENT_TOOLS is consumed by four things that cannot see each other: the Grok
 * loop, the local-model loop, the in-process MCP server the Jumpy panel drives,
 * and the external MCP server Hermes connects to. A spec that is wrong here is
 * wrong in all four, and the symptom is not a crash — it is a model quietly
 * getting an argument wrong.
 *
 * The type check below is the one that earns its keep. tool-schema.ts converts
 * these to Zod through a deliberately small slice of JSON Schema; anything
 * outside it falls through to `z.unknown()`, which reaches the model as "any".
 * That is invisible at runtime and produces a tool the model cannot aim. This
 * test is what makes adding such a property fail loudly instead.
 */

/** Exactly what zodForProperty in apps/server/src/tool-schema.ts can express. */
const HANDLED = new Set(['string', 'integer', 'number', 'boolean', 'array', 'null']);

test('every tool has a unique name, and the name list agrees', () => {
  const names = AGENT_TOOLS.map((t) => t.function.name);
  assert.equal(new Set(names).size, names.length, 'duplicate tool name');
  assert.deepEqual([...names].sort(), [...AGENT_TOOL_NAMES].sort());
});

test('every tool describes itself, and every argument describes itself', () => {
  for (const t of AGENT_TOOLS) {
    const { name, description, parameters } = t.function;
    assert.ok(description && description.trim().length > 10, `${name}: thin description`);
    for (const [key, raw] of Object.entries(parameters.properties)) {
      const prop = raw as Record<string, unknown>;
      assert.ok(
        typeof prop.description === 'string' && prop.description.trim().length > 0,
        `${name}.${key}: an argument with no description is one the model guesses at`,
      );
    }
  }
});

test('no property uses a JSON Schema type the converter would silently widen to any', () => {
  for (const t of AGENT_TOOLS) {
    for (const [key, raw] of Object.entries(t.function.parameters.properties)) {
      const prop = raw as Record<string, unknown>;
      if (Array.isArray(prop.enum)) {
        assert.ok(
          prop.enum.every((v) => typeof v === 'string'),
          `${t.function.name}.${key}: z.enum only takes string literals`,
        );
        continue;
      }
      const types = Array.isArray(prop.type) ? prop.type : [prop.type];
      for (const ty of types) {
        assert.ok(
          typeof ty === 'string' && HANDLED.has(ty),
          `${t.function.name}.${key}: type "${String(ty)}" is not handled by zodForProperty — ` +
            'it would reach the model as `unknown`. Extend the converter, or use a handled type.',
        );
      }
      if (types.includes('array')) {
        assert.ok(prop.items, `${t.function.name}.${key}: an array without items becomes array<string> by default`);
      }
    }
  }
});

test('required entries actually name properties that exist', () => {
  for (const t of AGENT_TOOLS) {
    const { name, parameters } = t.function;
    for (const req of parameters.required ?? []) {
      assert.ok(
        req in parameters.properties,
        `${name}: required lists "${req}", which is not a property — it can never be satisfied`,
      );
    }
  }
});

test('the system prompt still introduces the assistant by name', () => {
  // It is shared verbatim with Hermes as an MCP prompt, so this is the one place
  // the persona is defined for every surface at once.
  assert.match(AGENT_SYSTEM_PROMPT, /Jumpy/);
  assert.ok(AGENT_SYSTEM_PROMPT.length > 500);
});
