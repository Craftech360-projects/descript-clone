import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCues, toSrt, toAss, scaleCues } from './captions.ts';
import { compileEdl } from './edl.ts';
import { buildRenderPlan, escapeSubtitlePath } from './render.ts';
import type { Transcript } from './types.ts';

function fromText(text: string, deletedIdx: number[] = []): Transcript {
  const words = text.split(/\s+/).map((t, i) => ({
    id: `w${i}`,
    text: t,
    start: i,
    end: i + 1,
    deleted: deletedIdx.includes(i),
  }));
  return { mediaId: 'test', duration: words.length, words };
}

const NO_PAD = { padMs: 0, mergeWithinMs: 0 };

test('an explicitly undefined option falls back to the default, not past it', () => {
  // The server destructures these out of a JSON body, so an omitted field
  // arrives as undefined. A plain spread let that override maxChars, and the
  // whole transcript came out as one unwrapped cue.
  const t = fromText('one two three four five six seven eight nine ten');
  const edl = compileEdl(t, NO_PAD);

  const explicit = toCues(t, edl, { maxChars: undefined, maxDurationMs: undefined });
  const omitted = toCues(t, edl, {});

  assert.deepEqual(
    explicit.map((c) => c.text),
    omitted.map((c) => c.text),
    'passing undefined must behave exactly like passing nothing',
  );
  assert.ok(explicit.length > 1, 'the default 42-char wrap must still apply');
  for (const cue of explicit) assert.ok(cue.text.length <= 42, `cue over 42 chars: ${cue.text}`);
});

test('toAss keeps its defaults when handed undefined style fields', () => {
  const t = fromText('one two three');
  const cues = toCues(t, compileEdl(t, NO_PAD), {});
  const ass = toAss(cues, { fontSize: undefined, playResX: undefined });

  assert.ok(!ass.includes('undefined'), 'an undefined style field leaked into the ASS header');
  assert.ok(ass.includes('PlayResX: 1920'));
});

test('burn-in is chained after the cut, so cues match it', () => {
  // Cues are timed on the OUTPUT timeline. Burning before the cut would drift
  // every caption by however much was removed before it.
  const t = fromText('one two three four', [1]);
  const edl = compileEdl(t, NO_PAD);
  const plan = buildRenderPlan(edl, {
    input: 'in.mp4',
    output: 'out.mp4',
    hasVideo: true,
    subtitlePath: 'C:\\tmp\\cap.ass',
  });

  const cutLine = plan.filterScript.split('\n').find((l) => l.startsWith('[0:v]'))!;
  assert.ok(cutLine.endsWith('[vcut];'), 'the cut must feed the subtitles filter, not [outv]');
  assert.ok(!cutLine.includes('subtitles'), 'subtitles must not be inside the cut chain');
  assert.match(plan.filterScript, /\[vcut\]subtitles=filename='.+'\[outv\]$/m);
});

test('rendering without captions leaves the cut wired straight to the output', () => {
  const t = fromText('one two three four', [1]);
  const edl = compileEdl(t, NO_PAD);
  const plan = buildRenderPlan(edl, { input: 'in.mp4', output: 'out.mp4', hasVideo: true });

  assert.ok(!plan.filterScript.includes('subtitles'));
  const lines = plan.filterScript.trimEnd().split('\n');
  assert.ok(lines.some((l) => l.startsWith('[0:v]') && l.endsWith('[outv];')), plan.filterScript);
  assert.ok(lines.some((l) => l.startsWith('[0:a]') && l.endsWith('[outa]')), plan.filterScript);
});

test('an audio-only project ignores a subtitle path rather than emitting a video filter', () => {
  const t = fromText('one two three');
  const edl = compileEdl(t, NO_PAD);
  const plan = buildRenderPlan(edl, {
    input: 'in.m4a',
    output: 'out.m4a',
    hasVideo: false,
    subtitlePath: 'C:\\tmp\\cap.ass',
  });

  assert.ok(!plan.filterScript.includes('subtitles'), 'there is no picture to burn onto');
});

test('subtitle paths are escaped for the filtergraph', () => {
  // Verified against ffmpeg 8.1: the drive colon is special even inside the
  // single quotes, and 'C:/x.ass' fails to parse where 'C\:/x.ass' works.
  assert.equal(escapeSubtitlePath('C:\\tmp\\cap.ass'), 'C\\:/tmp/cap.ass');
  assert.equal(escapeSubtitlePath('C:\\my videos\\cap.ass'), 'C\\:/my videos/cap.ass');
  assert.equal(escapeSubtitlePath('/var/tmp/cap.ass'), '/var/tmp/cap.ass');
});

test('cues are timed against the OUTPUT timeline, not the source', () => {
  // "one two three four" with "two" and "three" cut. In the source, "four"
  // starts at 3s. In the 2s output, it must start at 1s.
  const t = fromText('one two three four', [1, 2]);
  const edl = compileEdl(t, NO_PAD);
  const cues = toCues(t, edl, { maxChars: 3 }); // force one word per cue

  assert.equal(cues.length, 2);
  assert.equal(cues[0].text, 'one');
  assert.equal(cues[0].start, 0);

  assert.equal(cues[1].text, 'four');
  assert.equal(
    cues[1].start,
    1,
    'four starts at 3s in the source but 1s in the cut — captioning off source time would drift by exactly the amount cut',
  );
});

test('deleted words never appear in captions', () => {
  const t = fromText('keep cut keep', [1]);
  const edl = compileEdl(t, NO_PAD);
  const text = toCues(t, edl).map((c) => c.text).join(' ');
  assert.equal(text.includes('cut'), false);
});

test('cues wrap at the character limit', () => {
  const t = fromText('alpha bravo charlie delta echo foxtrot');
  const edl = compileEdl(t, NO_PAD);
  const cues = toCues(t, edl, { maxChars: 14 });
  assert.ok(cues.length > 1);
  for (const cue of cues) {
    assert.ok(cue.text.length <= 14, `"${cue.text}" is ${cue.text.length} chars, over the limit`);
  }
});

test('a cue never spans a cut', () => {
  const t = fromText('a b c d e f', [2, 3]);
  const edl = compileEdl(t, NO_PAD);
  const cues = toCues(t, edl, { maxChars: 100, maxDurationMs: 100000 });

  // Even with limits that would happily merge everything, the splice forces a break.
  assert.ok(cues.length >= 1);
  for (const cue of cues) {
    assert.equal(cue.text.includes('c'), false);
    assert.equal(cue.text.includes('d'), false);
  }
});

test('cues respect the max duration', () => {
  const t = fromText('a b c d e f g h');
  const edl = compileEdl(t, NO_PAD);
  const cues = toCues(t, edl, { maxChars: 999, maxDurationMs: 3000 });
  for (const cue of cues) {
    assert.ok(cue.end - cue.start <= 3.5, `cue held ${(cue.end - cue.start).toFixed(1)}s`);
  }
});

test('SRT output is well formed', () => {
  const t = fromText('hello world');
  const edl = compileEdl(t, NO_PAD);
  const srt = toSrt(toCues(t, edl));

  assert.match(srt, /^1\n00:00:00,000 --> 00:00:0[12],\d{3}\nhello world\n/);
});

test('a gap too short to be a pause is closed, not left to flicker', () => {
  // Words run 0-1, 1-2, 2-3… so consecutive cues are a millisecond apart: the
  // space between two words, not a silence. Left alone that is a blank frame
  // between every pair of cues — measured on a real transcript, 275 of them,
  // median 41ms. The caption strobes.
  const t = fromText('alpha bravo charlie delta');
  const edl = compileEdl(t, NO_PAD);
  const cues = toCues(t, edl, { maxChars: 11 }); // two words per cue

  assert.ok(cues.length > 1, 'need at least two cues to have a gap');
  for (let i = 0; i < cues.length - 1; i++) {
    assert.equal(
      cues[i].end,
      cues[i + 1].start,
      `gap of ${((cues[i + 1].start - cues[i].end) * 1000).toFixed(0)}ms left between cues ${i} and ${i + 1}`,
    );
  }
});

test('shortening a pause does not make the caption cut with the picture', () => {
  // The regression this exists for: shortening a pause leaves a gap of exactly
  // maxGapMs + 2*padMs — 580ms at these settings — which is WIDER than the
  // short-gap threshold. The caption blanked at every single jump cut.
  const t: Transcript = {
    mediaId: 'test',
    duration: 20,
    words: [
      { id: 'w0', text: 'alpha', start: 0, end: 1, deleted: false },
      { id: 'w1', text: 'bravo', start: 9, end: 10, deleted: false }, // 8s pause before it
    ],
  };
  const edl = compileEdl(t, { maxGapMs: 500, padMs: 40, mergeWithinMs: 20 });
  assert.equal(edl.keep.length, 2, 'the pause must actually have been spliced');

  const cues = toCues(t, edl, { maxChars: 5 }); // one word per cue
  assert.equal(cues.length, 2);
  assert.equal(
    cues[0].end,
    cues[1].start,
    'a splice lands in this gap — that is time the editor removed, not a beat to blank through',
  );
});

test('the seam rule holds at any pause cap, not just the tuned one', () => {
  // A fixed threshold happens to cover a 250ms cap and miss a 1000ms one. The
  // rule must not depend on where the slider sits.
  for (const maxGapMs of [100, 250, 500, 1000, 2000]) {
    const t: Transcript = {
      mediaId: 'test',
      duration: 30,
      words: [
        { id: 'w0', text: 'alpha', start: 0, end: 1, deleted: false },
        { id: 'w1', text: 'bravo', start: 15, end: 16, deleted: false },
      ],
    };
    const edl = compileEdl(t, { maxGapMs, padMs: 40, mergeWithinMs: 20 });
    const cues = toCues(t, edl, { maxChars: 5 });
    assert.equal(cues.length, 2, `cap ${maxGapMs}ms`);
    assert.equal(
      cues[0].end,
      cues[1].start,
      `caption blanked through a shortened pause at a ${maxGapMs}ms cap`,
    );
  }
});

test('a real silence stays blank', () => {
  // Closing gaps must not turn into holding a caption over a pause. Two words
  // three seconds apart is a silence, and a silence has no caption.
  const t: Transcript = {
    mediaId: 'test',
    duration: 10,
    words: [
      { id: 'w0', text: 'alpha', start: 0, end: 1, deleted: false },
      { id: 'w1', text: 'bravo', start: 4, end: 5, deleted: false },
    ],
  };
  const edl = compileEdl(t, NO_PAD);
  const cues = toCues(t, edl, { maxChars: 5 }); // one word per cue

  assert.equal(cues.length, 2);
  assert.ok(
    cues[1].start - cues[0].end > 2,
    'a 3s pause must stay blank, not hold the previous line across it',
  );
});

test('closing gaps does not stretch a cue far past its max duration', () => {
  // The hold can push a cue up to MIN_GAP_S long, and no further.
  const t = fromText('a b c d e f g h');
  const edl = compileEdl(t, NO_PAD);
  const cues = toCues(t, edl, { maxChars: 999, maxDurationMs: 3000 });
  for (const cue of cues) {
    assert.ok(cue.end - cue.start <= 3.5, `cue held ${(cue.end - cue.start).toFixed(2)}s`);
  }
});

test('no cues when everything is deleted, rather than a crash', () => {
  const t = fromText('a b', [0, 1]);
  const edl = compileEdl(t, NO_PAD);
  assert.deepEqual(toCues(t, edl), []);
});

test('sidecar cues are re-timed by speed, karaoke tags included', () => {
  // A .srt is read against the finished file's clock, and that clock has already
  // been divided by speed. Burned captions must NOT come through here — they ride
  // the frames instead. See scaleCues.
  const t = fromText('one two three four', [1]);
  const edl = compileEdl(t, NO_PAD);
  const cues = toCues(t, edl);
  const fast = scaleCues(cues, 2);

  assert.equal(fast.length, cues.length, 'speed re-times cues, it never drops them');
  assert.equal(fast[0].start, cues[0].start / 2);
  assert.equal(fast[0].end, cues[0].end / 2);
  assert.equal(fast[0].text, cues[0].text);
  // toAss reads word start/end as a DELTA for \k. Left unscaled, each word would
  // hold twice as long as the picture it is painted over.
  assert.equal(fast[0].words[0].end - fast[0].words[0].start, (cues[0].words[0].end - cues[0].words[0].start) / 2);
});

test('scaleCues at 1x is a no-op that copies nothing', () => {
  const t = fromText('one two three');
  const cues = toCues(t, compileEdl(t, NO_PAD));
  assert.equal(scaleCues(cues, 1), cues, 'the common path must not rebuild every cue');
});

test('a sped-up SRT carries the scaled times through to the file', () => {
  const t = fromText('one two three four');
  const cues = toCues(t, compileEdl(t, NO_PAD));
  const srt = toSrt(scaleCues(cues, 2));

  assert.match(srt, /^1\n00:00:00,000 --> /);
  assert.equal(srt.split('-->').length - 1, cues.length, 'one timing line per cue');
});
