import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRenderPlan } from './render.ts';
import { MAX_SPEED } from './doc.ts';
import type { Edl } from './types.ts';

/**
 * The filtergraph is the one place an edit becomes bytes, and it is a string —
 * so nothing but a test can tell a working graph from a plausible one. These
 * assert the SHAPE (which filter, in which order, on which label), not the
 * formatting.
 *
 * Burn-in and path escaping are exercised in captions.test.ts, next to the cues
 * they exist for. This file owns speed, and the ordering between the two.
 */

const edl = (keep: Array<[number, number]>, fadeMs = 12): Edl => ({
  sourceDuration: 100,
  keep: keep.map(([start, end]) => ({ start, end })),
  fadeMs,
});

const plan = (e: Edl, options: Partial<Parameters<typeof buildRenderPlan>[1]> = {}) =>
  buildRenderPlan(e, { input: 'in.mp4', output: 'out.mp4', hasVideo: true, fps: 25, ...options });

// ── the cut must stay O(1) in memory ─────────────────────────────────────────
//
// This is the one property in this file that is not about output correctness.
// The graph it replaced — one `trim`/`atrim` branch per kept range, spliced back
// with concat — made ffmpeg queue every decoded frame of every branch concat had
// not reached yet, with nothing bounding the queue. Measured on the 885s 720p
// sample: 2.9 GB after 45 seconds with SIX cuts and still climbing, and 1.6 GB
// for a 40-cut render that did finish. Exporting anything long took the machine
// down rather than failing honestly.
//
// select/aselect decide frame by frame on one linear pass, so the cost of a cut
// is a comparison rather than a buffered frame: the same 40-cut render peaks at
// 25 MB of audio and flat video.

test('neither chain branches per segment, however many cuts the edit has', () => {
  const { filterScript } = plan(edl([[0, 5], [10, 20], [30, 33], [40, 44]]));
  assert.ok(!/\btrim=/.test(filterScript), 'no per-segment branch on either stream');
  assert.ok(!filterScript.includes('concat='), 'nothing to splice back together');
  // Each source stream is read exactly once, by exactly one chain.
  assert.equal(filterScript.match(/\[0:v\]/g)?.length, 1);
  assert.equal(filterScript.match(/\[0:a\]/g)?.length, 1);
});

test('select and aselect keep exactly the ranges the EDL kept', () => {
  const { filterScript } = plan(edl([[0, 5], [10, 20]]));
  const ranges = "between(t,0.0000,5.0000)+between(t,10.0000,20.0000)";
  assert.ok(
    filterScript.includes(`[0:v]select='${ranges}',setpts=N/25.0000/TB[outv];`),
    filterScript,
  );
  // Both streams are cut by the same expression, which is what keeps them in
  // sync — one list of ranges, applied twice.
  assert.ok(filterScript.includes(`aselect='${ranges}',asetpts=N/SR/TB[outa]`), filterScript);
});

test('audio is re-framed small enough that a cut lands where it was asked to', () => {
  // aselect drops whole frames, and a decoder hands out ~1024 samples (21ms) at
  // a time. Left alone that quantises every cut point and drifts audio against
  // picture; 64 samples puts the error at 1.3ms.
  const chain = plan(edl([[0, 5]])).filterScript.split('\n').find((l) => l.includes('aselect='))!;
  assert.match(chain, /asetnsamples=n=64:p=0,aselect=/);
});

test('the re-framing comes after the fades, not before', () => {
  // Everything downstream of asetnsamples runs 16x more often. Ordering it last
  // leaves two filters paying that, not all 2N fades: on the 885s sample at 400
  // cuts, 905s of encoding against ~60s. This is the whole reason a heavily cut
  // edit exports in a reasonable time.
  const chain = plan(edl([[0, 5], [10, 20]])).filterScript.split('\n').find((l) => l.startsWith('[0:a]'))!;
  assert.ok(chain.indexOf('afade=') < chain.indexOf('asetnsamples='), chain);
});

test('setpts renumbers against the source rate, closing the holes select leaves', () => {
  // Without this the dropped frames stay as gaps in the PTS and the picture
  // freezes across every cut for exactly as long as the cut removed.
  assert.ok(plan(edl([[0, 5]]), { fps: 29.97 }).filterScript.includes('setpts=N/29.9700/TB'));
  // No fps to work from: hand the job to ffmpeg's own constant rather than
  // emitting `N/undefined/TB`, which every frame would evaluate to NaN.
  assert.ok(plan(edl([[0, 5]]), { fps: undefined }).filterScript.includes('setpts=N/FRAME_RATE/TB'));
  assert.ok(plan(edl([[0, 5]]), { fps: 0 }).filterScript.includes('setpts=N/FRAME_RATE/TB'));
});

// ── the 1x graph must not move ────────────────────────────────────────────────

test('speed 1 emits no retiming filters at all', () => {
  const { filterScript } = plan(edl([[0, 5]]), { speed: 1 });
  assert.ok(!filterScript.includes('atempo'), 'no atempo at 1x');
  assert.ok(!filterScript.includes('setpts=PTS/'), 'no output setpts at 1x');
  // Both chains write straight to the final labels, with no relabel hop.
  assert.ok(/\bselect=.*\[outv\];/.test(filterScript));
  assert.ok(/aselect=.*\[outa\]/.test(filterScript));
});

test('omitting speed is the same graph as passing 1', () => {
  assert.equal(plan(edl([[0, 5]])).filterScript, plan(edl([[0, 5]]), { speed: 1 }).filterScript);
});

test('a graph never ends in a semicolon', () => {
  for (const options of [{}, { speed: 1.5 }, { hasVideo: false }, { hasVideo: false, speed: 1.5 }]) {
    assert.ok(!plan(edl([[0, 5]]), options).filterScript.trimEnd().endsWith(';'));
  }
});

// ── speed ─────────────────────────────────────────────────────────────────────

test('speed retimes both streams by the same factor', () => {
  const { filterScript } = plan(edl([[0, 5]]), { speed: 1.2 });
  assert.ok(/\[vcut\]setpts=PTS\/1\.2000\[outv\]/.test(filterScript), filterScript);
  assert.ok(/\[acut\]atempo=1\.2000\[outa\]/.test(filterScript), filterScript);
  // Whatever the cut produced must now feed the retiming stages, not the output.
  assert.ok(/\bselect=.*\[vcut\];/.test(filterScript));
  assert.ok(/aselect=.*\[acut\];/.test(filterScript));
});

test('audio-only never gets a video stage, at any speed', () => {
  const { filterScript } = plan(edl([[0, 5]]), { hasVideo: false, speed: 1.5 });
  assert.ok(!filterScript.includes('setpts=PTS/'), 'no setpts without a video stream');
  assert.ok(!filterScript.includes('[0:v]'), 'no video input');
  assert.ok(/\[acut\]atempo=1\.5000\[outa\]/.test(filterScript), filterScript);
});

test('MAX_SPEED needs only one atempo instance', () => {
  // atempo was capped at 2.0 for years; a chain would be required past it. The
  // clamp is what lets this graph stay a single filter — if MAX_SPEED ever rises,
  // this fails rather than silently emitting a tempo ffmpeg rejects.
  const { filterScript } = plan(edl([[0, 5]]), { speed: MAX_SPEED });
  assert.equal(filterScript.match(/atempo=/g)?.length, 1);
  assert.ok(MAX_SPEED <= 2, 'atempo takes a single tempo only up to 2.0 on older ffmpeg');
});

// ── ordering: the reason burned captions need no re-timing ────────────────────

test('burn-in runs BEFORE the speed change, on one chain', () => {
  const { filterScript } = plan(edl([[0, 5]]), { speed: 2, subtitlePath: 'C:/caps.ass' });

  const line = filterScript.split('\n').find((l) => l.includes('subtitles='));
  assert.ok(line, 'a subtitles stage exists');
  assert.ok(
    line!.indexOf('subtitles=') < line!.indexOf('setpts=PTS/'),
    `subtitles must precede setpts so glyphs ride the frames: ${line}`,
  );
  // Both on the same [vcut]→[outv] chain: the burn must not go via its own label
  // and skip the retiming.
  assert.ok(line!.startsWith('[vcut]') && line!.endsWith('[outv];'), line);
});

test('subtitles are ignored on audio, so speed still owns the audio chain', () => {
  const { filterScript } = plan(edl([[0, 5]]), {
    hasVideo: false,
    speed: 1.2,
    subtitlePath: 'C:/caps.ass',
  });
  assert.ok(!filterScript.includes('subtitles='), 'nothing to burn onto');
  assert.ok(filterScript.includes('atempo=1.2000'));
});

// ── the parts speed must not disturb ──────────────────────────────────────────

test('every segment still gets its own pair of fades, and the mapping holds', () => {
  // The fades are what stop a cut mid-waveform from clicking, so going linear
  // must not cost them. They just moved onto the source clock: each one is gated
  // to its own 12ms window and bypassed everywhere else, which is the only
  // reason 2N of them can share one chain.
  const { filterScript, args, segments } = plan(edl([[0, 5], [10, 20]]), { speed: 1.2 });
  assert.equal(segments, 2);
  assert.equal(filterScript.match(/afade=/g)?.length, 4, 'in and out, per segment');
  assert.ok(
    filterScript.includes("afade=t=out:st=19.9880:d=0.0120:enable='between(t,19.9880,20.0000)'"),
    filterScript,
  );
  assert.ok(
    filterScript.includes("afade=t=in:st=10.0000:d=0.0120:enable='between(t,10.0000,10.0120)'"),
    filterScript,
  );
  // The map targets are fixed labels — speed must not rename the graph's exits.
  assert.deepEqual(
    args.filter((a, i) => args[i - 1] === '-map'),
    ['[outv]', '[outa]'],
  );
});

test('an empty EDL is refused rather than rendered', () => {
  assert.throws(() => plan(edl([])), /every word was deleted/i);
});
