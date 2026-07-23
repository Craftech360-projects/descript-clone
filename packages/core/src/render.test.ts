import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRenderPlan, buildSequenceRenderPlan } from './render.ts';
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

test('an imported font adds fontsdir to the burn, escaped like the filename', () => {
  const { filterScript } = plan(edl([[0, 5]]), {
    subtitlePath: 'C:/caps.ass',
    fontsDir: 'C:/media/fonts',
  });
  const line = filterScript.split('\n').find((l) => l.includes('subtitles='))!;
  // fontsdir rides in the SAME single-quoted arg context as filename, so the
  // drive colon takes the same backslash escape — a bare C: fails to parse.
  assert.ok(line.includes(":fontsdir='C\\:/media/fonts'"), line);
  assert.ok(line.indexOf('filename=') < line.indexOf('fontsdir='), line);
});

test('no fontsDir means no fontsdir option, so a plain burn is unchanged', () => {
  const { filterScript } = plan(edl([[0, 5]]), { subtitlePath: 'C:/caps.ass' });
  assert.ok(filterScript.includes('subtitles='), 'still burns');
  assert.ok(!filterScript.includes('fontsdir='), 'nothing added when no font dir');
});

test('fontsdir is not emitted when there is nothing to burn onto', () => {
  const { filterScript } = plan(edl([[0, 5]]), { fontsDir: 'C:/media/fonts' });
  assert.ok(!filterScript.includes('fontsdir='), 'no subtitles stage, no fontsdir');
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

// ── multi-clip sequences ───────────────────────────────────────────────────────

/** A two-clip EDL: clip A [0,3] occupies global [0,3]; clip B [0,4] global [3,7]. */
const seqEdl: Edl = {
  sourceDuration: 7,
  fadeMs: 12,
  keep: [
    { start: 0, end: 3 }, // all of clip A
    { start: 3, end: 5 }, // clip B local [0,2]
  ],
  clips: [
    { clipId: 'A', offset: 0, sourceDuration: 3 },
    { clipId: 'B', offset: 3, sourceDuration: 4 },
  ],
};

const seqPlan = (e: Edl, options: Partial<Parameters<typeof buildSequenceRenderPlan>[1]> = {}) =>
  buildSequenceRenderPlan(e, {
    clips: [{ input: 'a.mp4', fps: 30 }, { input: 'b.mp4', fps: 25 }],
    output: 'out.mp4',
    hasVideo: true,
    width: 1280,
    height: 720,
    fps: 30,
    ...options,
  });

test('each clip is a separate input, cut on its OWN local timeline', () => {
  const { filterScript, args } = seqPlan(seqEdl);
  // Two inputs, in clip order.
  assert.deepEqual(args.filter((a, i) => args[i - 1] === '-i'), ['a.mp4', 'b.mp4']);
  // Clip A keeps its global range (offset 0); clip B's global [3,5] becomes local
  // [0,2] against its own file — the offset is stripped.
  assert.ok(filterScript.includes(`[0:v]select='between(t,0.0000,3.0000)'`), filterScript);
  assert.ok(filterScript.includes(`[1:v]select='between(t,0.0000,2.0000)'`), filterScript);
});

test('clips are normalised to a common frame and joined with concat', () => {
  const { filterScript } = seqPlan(seqEdl);
  // Every clip is letterboxed into the canonical frame and rate — concat rejects
  // clips that disagree on size, SAR, rate or pixel format.
  assert.ok(filterScript.includes('scale=1280:720:force_original_aspect_ratio=decrease'));
  assert.ok(filterScript.includes('pad=1280:720:(1280-iw)/2:(720-ih)/2'));
  assert.ok(filterScript.includes('setsar=1'));
  assert.ok(filterScript.includes('fps=30.0000'));
  // Joined as v,a,v,a into one concat of two clips.
  assert.ok(/\[v0\]\[a0\]\[v1\]\[a1\]concat=n=2:v=1:a=1/.test(filterScript), filterScript);
});

test('the frame renumber uses each clip\'s own source rate', () => {
  const { filterScript } = seqPlan(seqEdl);
  assert.ok(filterScript.includes('setpts=N/30.0000/TB'), 'clip A at 30fps');
  assert.ok(filterScript.includes('setpts=N/25.0000/TB'), 'clip B at 25fps');
});

test('a clip entirely cut drops out, and concat counts only the survivors', () => {
  // Keep only clip B's range — clip A contributes nothing.
  const e: Edl = { ...seqEdl, keep: [{ start: 3, end: 5 }] };
  const { filterScript } = seqPlan(e);
  assert.ok(!filterScript.includes('[0:v]'), 'clip A has no chain');
  assert.ok(filterScript.includes('[1:v]select='), 'clip B still cut');
  assert.ok(/concat=n=1:v=1:a=1/.test(filterScript), 'one survivor, concat n=1');
});

test('burn-in and speed happen once, after the join', () => {
  const { filterScript } = seqPlan(seqEdl, { speed: 1.5, subtitlePath: 'C:/caps.ass' });
  const line = filterScript.split('\n').find((l) => l.includes('subtitles='))!;
  assert.ok(line.startsWith('[vc]'), 'operates on the joined stream, not a clip');
  assert.ok(line.indexOf('subtitles=') < line.indexOf('setpts=PTS/'), 'glyphs ride the speed change');
  assert.ok(/\[ac\]atempo=1\.5000\[outa\]/.test(filterScript), filterScript);
});

test('audio-only sequence joins audio alone, no video map', () => {
  const { filterScript, args } = seqPlan(seqEdl, { hasVideo: false });
  assert.ok(!filterScript.includes(':v]'), 'no video chains');
  assert.ok(/\[a0\]\[a1\]concat=n=2:v=0:a=1\[outa\]/.test(filterScript), filterScript);
  assert.ok(!args.includes('[outv]'), 'nothing to map for video');
});

test('a 1x sequence with no burn writes concat straight to the output labels', () => {
  const { filterScript } = seqPlan(seqEdl);
  assert.ok(/concat=n=2:v=1:a=1\[outv\]\[outa\]/.test(filterScript), filterScript);
  assert.ok(!filterScript.includes('[vc]'), 'no relabel hop when nothing follows');
});

// ── background music: a bed on the OUTPUT clock, mixed under the program ───────
//
// The point of the feature: the music is NOT cut with the words and NOT sped
// with the picture. It is a separate input, gained and trimmed on the finished
// file's clock, amix'd under everything else. These assert it lands after the
// cut/speed, that it never touches the source select chain, and that adding it
// does not quietly duck the voice.

test('music adds its own input and mixes under the program without cutting it', () => {
  const { filterScript, args } = plan(edl([[0, 5], [10, 20]]), {
    bgMusic: { input: 'song.mp3', volume: 0.4, durationSec: 30 },
  });
  // The music is a second input, after the source.
  assert.deepEqual(args.filter((a, i) => args[i - 1] === '-i'), ['in.mp4', 'song.mp3']);
  // It rides on input 1, gained, and never appears in the aselect cut chain.
  assert.ok(filterScript.includes('[1:a]volume=0.400'), filterScript);
  const cut = filterScript.split('\n').find((l) => l.startsWith('[0:a]'))!;
  assert.ok(!cut.includes('volume='), 'music gain is not on the source cut chain');
  // amix ties length to the program (duration=first) and keeps the voice at unity
  // (normalize=0) — the two options that make this a bed rather than a 50/50 mix.
  assert.ok(/\[bgprog\]\[bgm\]amix=inputs=2:duration=first:normalize=0\[outa\]/.test(filterScript), filterScript);
});

test('the program audio feeds the mix, not the output, once music is present', () => {
  const { filterScript } = plan(edl([[0, 5]]), {
    bgMusic: { input: 'song.mp3', volume: 1, durationSec: 5 },
  });
  // The cut writes to the intermediate program label, and the mix owns [outa].
  assert.ok(/aselect=.*\[aprog\];/.test(filterScript), filterScript);
  assert.ok(!/aselect=.*\[outa\]/.test(filterScript), 'the cut must not still claim [outa]');
  assert.equal(filterScript.match(/\[outa\]/g)?.length, 1, 'exactly one producer of [outa]');
});

test('music is mixed AFTER the speed change, so the bed is not sped up', () => {
  const { filterScript } = plan(edl([[0, 5]]), {
    speed: 1.5,
    bgMusic: { input: 'song.mp3', volume: 0.5, durationSec: 10 },
  });
  // atempo retimes the program into [aprog]; the mix consumes that. The music
  // chain carries no atempo — it plays at its natural rate on the output clock.
  assert.ok(/\[acut\]atempo=1\.5000\[aprog\]/.test(filterScript), filterScript);
  const music = filterScript.split('\n').find((l) => l.startsWith('[1:a]'))!;
  assert.ok(!music.includes('atempo'), 'the bed is never time-stretched with the picture');
});

test('the bed is trimmed on the output clock and faded out at its end', () => {
  const { filterScript } = plan(edl([[0, 5]]), {
    bgMusic: { input: 'song.mp3', volume: 0.5, durationSec: 20, fadeOutSec: 2 },
  });
  const music = filterScript.split('\n').find((l) => l.startsWith('[1:a]'))!;
  assert.ok(music.includes('atrim=0:20.0000'), music);
  assert.ok(music.includes('afade=t=out:st=18.0000:d=2.0000'), music);
});

test('no bgMusic leaves the graph byte-identical to before it existed', () => {
  assert.equal(
    plan(edl([[0, 5], [10, 20]]), { speed: 1.2 }).filterScript,
    plan(edl([[0, 5], [10, 20]]), { speed: 1.2, bgMusic: undefined }).filterScript,
  );
});

test('music mixes onto an audio-only project too', () => {
  const { filterScript, args } = plan(edl([[0, 5]]), {
    hasVideo: false,
    bgMusic: { input: 'song.mp3', volume: 0.3, durationSec: 5 },
  });
  assert.ok(!filterScript.includes('[0:v]'), 'still no video');
  assert.ok(/amix=inputs=2:duration=first:normalize=0\[outa\]/.test(filterScript), filterScript);
  assert.deepEqual(args.filter((a, i) => args[i - 1] === '-map'), ['[outa]']);
});

test('loop adds -stream_loop -1 immediately before the music input', () => {
  const { args } = plan(edl([[0, 5]]), {
    bgMusic: { input: 'song.mp3', volume: 0.5, durationSec: 30, loop: true },
  });
  const i = args.indexOf('-i', args.indexOf('in.mp4')); // the music -i, after the source -i
  assert.equal(args[i + 1], 'song.mp3');
  assert.equal(args[i - 2], '-stream_loop', args.join(' '));
  assert.equal(args[i - 1], '-1');
});

test('no loop means no -stream_loop, and the bed just stops at its length', () => {
  const { args } = plan(edl([[0, 5]]), {
    bgMusic: { input: 'song.mp3', volume: 0.5, durationSec: 30 },
  });
  assert.ok(!args.includes('-stream_loop'), args.join(' '));
});

test('a sequence mixes music under the joined program, at the clip-count input index', () => {
  const { filterScript, args } = seqPlan(seqEdl, {
    speed: 1.5,
    bgMusic: { input: 'song.mp3', volume: 0.6, durationSec: 12 },
  });
  // Music is the input after the two clips.
  assert.deepEqual(args.filter((a, i) => args[i - 1] === '-i'), ['a.mp4', 'b.mp4', 'song.mp3']);
  // The joined+retimed program lands in [aprog]; the mix on input 2 owns [outa].
  assert.ok(/\[ac\]atempo=1\.5000\[aprog\]/.test(filterScript), filterScript);
  assert.ok(filterScript.includes('[2:a]volume=0.600'), filterScript);
  assert.ok(/amix=inputs=2:duration=first:normalize=0\[outa\]/.test(filterScript), filterScript);
});
