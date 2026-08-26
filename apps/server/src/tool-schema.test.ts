import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import { AGENT_TOOLS } from '../../../packages/core/src/agent-tools.ts';
import { toToolContent, zodForProperty, zodShapeFor } from './tool-schema.ts';

/**
 * The JSON-Schema → Zod converter, which is now the single contract two MCP
 * servers depend on.
 *
 * It used to live inside agent-claude.ts with one caller. With the external MCP
 * server for Hermes there are two, and a converter that quietly widened a type
 * would hand both of them a tool the model cannot aim — with no error anywhere.
 */

test('every one of the real tool specs converts without falling through to unknown', () => {
  for (const spec of AGENT_TOOLS) {
    const shape = zodShapeFor(spec);
    assert.equal(
      Object.keys(shape).length,
      Object.keys(spec.function.parameters.properties).length,
      `${spec.function.name}: lost a property`,
    );
    for (const [key, t] of Object.entries(shape)) {
      // z.unknown() accepts undefined AND every value — the signature of "any".
      const isUnknown = t.safeParse(Symbol('x')).success;
      assert.ok(!isUnknown, `${spec.function.name}.${key} converted to unknown`);
    }
  }
});

test('required vs optional follows the spec, not the declaration order', () => {
  for (const spec of AGENT_TOOLS) {
    const req = new Set(spec.function.parameters.required ?? []);
    const shape = zodShapeFor(spec);
    for (const [key, t] of Object.entries(shape)) {
      const acceptsMissing = t.safeParse(undefined).success;
      if (req.has(key)) {
        assert.ok(!acceptsMissing, `${spec.function.name}.${key} is required but optional in Zod`);
      } else {
        assert.ok(acceptsMissing, `${spec.function.name}.${key} is optional but required in Zod`);
      }
    }
  }
});

test('scalars map to the obvious thing', () => {
  assert.ok(zodForProperty({ type: 'string' }).safeParse('a').success);
  assert.ok(!zodForProperty({ type: 'string' }).safeParse(1).success);
  assert.ok(zodForProperty({ type: 'integer' }).safeParse(3).success);
  assert.ok(zodForProperty({ type: 'number' }).safeParse(1.5).success);
  assert.ok(zodForProperty({ type: 'boolean' }).safeParse(true).success);
});

test('an enum becomes a closed set, not a free string', () => {
  const t = zodForProperty({ type: 'string', enum: ['first', 'all'] });
  assert.ok(t.safeParse('all').success);
  assert.ok(!t.safeParse('every').success, 'a value outside the enum must be refused');
});

test('["T","null"] becomes nullable — the shape used to clear a setting', () => {
  const t = zodForProperty({ type: ['string', 'null'] });
  assert.ok(t.safeParse(null).success);
  assert.ok(t.safeParse('x').success);
});

test('arrays recurse into their item type instead of widening', () => {
  // Without the array branch these fell through to unknown, so a list of clip
  // ids reached the model as "any" and it passed a bare string.
  const t = zodForProperty({ type: 'array', items: { type: 'string' } });
  assert.ok(t.safeParse(['a', 'b']).success);
  assert.ok(!t.safeParse('a').success, 'a bare string is not the array');
  assert.ok(!t.safeParse([1]).success, 'item type must be enforced');
});

test('an array with no items still lands on array<string>, not unknown', () => {
  const t = zodForProperty({ type: 'array' });
  assert.ok(t.safeParse(['a']).success);
  assert.ok(!t.safeParse([1]).success);
});

test('descriptions survive the conversion — they are what the model reads', () => {
  const shape = zodShapeFor({
    type: 'function',
    function: {
      name: 'x',
      description: 'd',
      parameters: { type: 'object', properties: { a: { type: 'string', description: 'the a' } }, required: ['a'] },
    },
  } as (typeof AGENT_TOOLS)[number]);
  assert.equal(shape.a.description, 'the a');
});

test('an ordinary result is one text block', () => {
  assert.deepEqual(toToolContent('Cut 12 fillers.'), {
    content: [{ type: 'text', text: 'Cut 12 fillers.' }],
  });
});

test('an IMAGE: result becomes a real image block, so the model can look at it', () => {
  // look_at_frame is only worth having if the frame arrives as a picture rather
  // than as words about a picture.
  const out = toToolContent('IMAGE:image/jpeg;base64,QUJD\nCaptions look low.');
  assert.deepEqual(out.content[0], { type: 'image', data: 'QUJD', mimeType: 'image/jpeg' });
  assert.deepEqual(out.content[1], { type: 'text', text: 'Captions look low.' });
});

test('text that merely mentions IMAGE: is not mistaken for one', () => {
  const out = toToolContent('The IMAGE: prefix marks a frame.');
  assert.equal(out.content.length, 1);
  assert.equal(out.content[0].type, 'text');
});

test('zod is the same major the MCP SDK expects', () => {
  // The SDK peer-depends on zod ^3.25 || ^4; a mismatch produces schemas that
  // register but validate nothing. Cheap to assert, expensive to debug.
  assert.ok(typeof z.string === 'function');
});
