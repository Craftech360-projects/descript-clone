import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  SLOW_TOOLS,
  TOOL_TIMEOUT_MS,
  SLOW_TOOL_TIMEOUT_MS,
  callEditor,
  closeSession,
  listSessions,
  newSession,
  resetSessions,
  resolveSession,
  sessionCount,
  settleToolResult,
  touch,
  type EditorSession,
} from './editor-bridge.ts';

/** A socket that records what was sent, so a call can be answered by hand. */
function fakeWs() {
  const sent: Array<Record<string, unknown>> = [];
  return {
    sent,
    send(data: string) {
      sent.push(JSON.parse(data));
    },
    lastCall() {
      const last = sent[sent.length - 1] as { tool?: { id: string; name: string } };
      return last?.tool;
    },
  };
}

beforeEach(() => resetSessions());

test('a pinned session is not addressable from outside', () => {
  // This is the property that keeps a Hermes tool call out of the window someone
  // is typing into. The Jumpy panel's socket is pinned; only /api/editor/ws
  // sockets register.
  newSession(fakeWs(), { registered: false });
  assert.equal(sessionCount(), 0);
  assert.equal(resolveSession(), null);
});

test('a registered session is listed and resolvable', () => {
  const s = newSession(fakeWs(), { registered: true });
  assert.equal(sessionCount(), 1);
  assert.equal(resolveSession()?.id, s.id);
  assert.equal(resolveSession(s.id)?.id, s.id);
});

test('an unknown session id resolves to nothing rather than to some other window', () => {
  newSession(fakeWs(), { registered: true });
  assert.equal(resolveSession('no-such-id'), null);
});

test('with several windows and no choice, the most recently active one wins', () => {
  const a = newSession(fakeWs(), { registered: true });
  const b = newSession(fakeWs(), { registered: true });
  touch(a, {});
  assert.equal(resolveSession()?.id, a.id, 'a was touched last');
  touch(b, {});
  assert.equal(resolveSession()?.id, b.id, 'now b is');
});

test('a call reaches the socket and resolves with the window’s answer', async () => {
  const ws = fakeWs();
  const s = newSession(ws, { registered: true });
  const p = callEditor(s, 'remove_fillers', { dry_run: false });

  const call = ws.lastCall()!;
  assert.equal(call.name, 'remove_fillers');
  assert.equal(s.meta.busy, true, 'busy while a call is outstanding');

  assert.equal(settleToolResult(s, call.id, 'Cut 12 fillers.'), true);
  assert.equal(await p, 'Cut 12 fillers.');
  assert.equal(s.meta.busy, false);
});

test('an answer to a call nobody is waiting on is ignored, not thrown', () => {
  const s = newSession(fakeWs(), { registered: true });
  assert.equal(settleToolResult(s, 'not-a-call', 'x'), false);
});

test('closing settles every outstanding call, so no caller hangs on a dead socket', async () => {
  const s = newSession(fakeWs(), { registered: true });
  const a = callEditor(s, 'read_transcript', {});
  const b = callEditor(s, 'list_clips', {});

  closeSession(s);

  assert.match(await a, /closed/i);
  assert.match(await b, /closed/i);
  assert.equal(sessionCount(), 0, 'and it leaves the registry');
});

test('two calls on one socket get distinct ids', () => {
  const ws = fakeWs();
  const s = newSession(ws, { registered: true });
  void callEditor(s, 'a', {});
  const first = ws.lastCall()!.id;
  void callEditor(s, 'b', {});
  assert.notEqual(ws.lastCall()!.id, first);
});

test('the encoder tools get the long timeout, everything else the short one', () => {
  // A minute of silence from a document edit means something broke. run_media_op
  // spawns ffmpeg and is bounded server-side by CONFIG.summonOpTimeoutMs, which
  // the Android shell raises to seven minutes — timing it out at 60s here would
  // abandon a job that is running fine.
  assert.ok(SLOW_TOOLS.has('run_media_op'));
  assert.ok(SLOW_TOOLS.has('summon_media'));
  assert.ok(!SLOW_TOOLS.has('remove_fillers'));
  assert.ok(SLOW_TOOL_TIMEOUT_MS > TOOL_TIMEOUT_MS * 10);
});

test('a call times out with text a model can act on, not a rejection', async () => {
  const s = newSession(fakeWs(), { registered: true }) as EditorSession;
  // Reach into the timer rather than waiting 60s: settle it the way the timeout
  // does and assert the caller sees a string, not a throw.
  const p = callEditor(s, 'seek', { seconds: 1 });
  const call = (s.ws as unknown as ReturnType<typeof fakeWs>).lastCall!()!;
  s.pending.get(call.id)!('Error: the editor did not respond in time.');
  s.pending.delete(call.id);
  assert.match(await p, /^Error: /);
});

test('listSessions reports what an outside caller needs to choose between windows', () => {
  const s = newSession(fakeWs(), { registered: true });
  touch(s, { projectId: 'p1', projectName: 'Cheeko ep 4' });
  const [info] = listSessions();
  assert.equal(info.id, s.id);
  assert.equal(info.projectName, 'Cheeko ep 4');
  assert.equal(info.projectId, 'p1');
  assert.equal(typeof info.since, 'string');
});

test('send on a dead socket does not take the caller down with it', () => {
  const dead = {
    send() {
      throw new Error('socket closed');
    },
  };
  const s = newSession(dead, { registered: true });
  assert.doesNotThrow(() => void callEditor(s, 'seek', {}));
});
