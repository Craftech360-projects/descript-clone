import { test } from 'node:test';
import assert from 'node:assert/strict';

import { summarizeTap } from './dev.ts';

/**
 * What the agent is told when the tests fail.
 *
 * This is the only channel through which an autonomous agent learns that the
 * change it just made was wrong, so the failure has to arrive as something it can
 * act on: which test, and why. A count alone sends it re-reading the whole diff;
 * the raw 500-line TAP dump buries the two lines that matter.
 */

const green = `
TAP version 13
ok 1 - something
1..563
# tests 563
# suites 0
# pass 562
# fail 0
# cancelled 0
# skipped 1
`;

const red = `
TAP version 13
not ok 208 - speed divides the output duration
  ---
  duration_ms: 0.361708
  type: 'test'
  location: '/repo/packages/core/src/edl.test.ts:350:1'
  failureType: 'testCodeFailure'
  error: |-
    2x halves what the cut left

    4 !== 1

  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  ...
1..563
# tests 563
# pass 561
# fail 1
# skipped 1
`;

const inlineErr = `
not ok 12 - a plain message
  ---
  error: 'expected true'
  code: 'ERR_ASSERTION'
  ...
# tests 20
# pass 19
# fail 1
# skipped 0
`;

test('a green run is one line — there is nothing to read', () => {
  const out = summarizeTap(green);
  assert.match(out, /563 tests, 562 pass, 0 fail, 1 skipped\./);
  assert.match(out, /Green\./);
  assert.ok(!out.includes('Failing'), 'nothing failed, so do not print a heading for it');
});

test('a red run names the test AND the assertion', () => {
  const out = summarizeTap(red);
  assert.match(out, /speed divides the output duration/);
  // The reason is the half that tells the agent what to change. node --test emits
  // it as a YAML block scalar, so a naive /error: (.+)/ captures the literal "|-"
  // and throws the message away — which is what this asserts against.
  assert.match(out, /4 !== 1/);
  assert.ok(!out.includes('|-'), 'the YAML block marker must not reach the agent');
});

test('a single-line error is read too', () => {
  const out = summarizeTap(inlineErr);
  assert.match(out, /a plain message/);
  assert.match(out, /expected true/);
  assert.ok(!out.includes("'expected true'"), 'quotes stripped');
});

test('output that is not TAP at all is passed through rather than swallowed', () => {
  // npm itself failing, a missing module, a syntax error in a test file: none of
  // these produce a "# pass" line, and reporting "0 tests" would be a lie.
  const raw = 'Error: Cannot find module ./nope.ts';
  assert.match(summarizeTap(raw), /Cannot find module/);
});

test('many failures do not bury the counts', () => {
  const many = `${Array.from({ length: 40 }, (_, i) => `not ok ${i} - failure ${i}`).join('\n')}
# tests 100
# pass 60
# fail 40
# skipped 0`;
  const out = summarizeTap(many);
  assert.match(out.split('\n')[0], /100 tests, 60 pass, 40 fail/, 'the summary comes first');
});
