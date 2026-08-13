# Jumpcut

Edit video by editing its transcript. Delete a word, and its audio and video go with it.

Named for what it makes: cut speech out of the middle of a take and you have made
a jump cut. The whole product is that one edit, done from the text.

Phase 1 of [the plan](../descript-open-source-plan.md): the text-based editing core.

## Run it

```bash
npm install
npm run server     # http://localhost:8787  (--watch; restarts on save)
npm run web        # http://localhost:5173
npm test           # no deps, no API key
```

`npm run dev` chains the two with `&`, which is POSIX-only — on Windows run them
in separate terminals.

**Use `npm run server:prod` when a render matters.** `npm run server` runs under
`--watch`, so saving any server file restarts the process and kills whatever job
was in flight. Jobs are persisted, so the UI reports an honest failure rather
than hanging — but the render is still gone.

**It works with no API key.** With both transcription keys unset the server uses a
mock ASR provider: fake words, real timings, spread across your actual media. The
entire pipeline — ingest, transcript, EDL, ffmpeg render — runs for real at zero
cost. Only the words are invented.

To use real transcription, put a key in `.env`:

```
ELEVENLABS_API_KEY=your-key
# or
SARVAM_API_KEY=your-key
```

Sarvam uses Saaras v3's batch API for long media. Its timestamps are per phrase,
so the editor distributes each phrase across its words; ElevenLabs retains native
word timings. When both keys are set, choose the on-import provider in Library >
On import; when only one is set, automatic import uses that provider.

Requires `ffmpeg` and `ffprobe` on PATH, and Node 24+ (it runs TypeScript directly,
no build step).

## How it works

The whole product is one idea:

> Every word knows its `[start, end]` in the source media. So deleting words from
> the transcript is a **range subtraction** over the timeline. An edit is a list
> of keep-ranges — an **Edit Decision List** — and rendering is
> `concat(source, EDL)`. The source file is never touched.

Everything else falls out of that:

| Feature | Implementation |
|---|---|
| Delete a word | Mark it deleted; the EDL loses that range |
| Remove fillers | Tag "um"/"uh", mark deleted. Same EDL path. |
| Remove retakes | n-gram match adjacent phrases, keep the last take. **No model.** |
| Shorten pauses | A gap over the cap becomes a split in the EDL |
| Preview without rendering | Play the source, skip cut ranges live |
| Undo | Inverse patches over the deleted set — see `history.ts` |
| Captions | Cues timed on the *output* timeline: a sidecar file, or burned into the picture |
| Caption style | One `CaptionSettings` read by both the preview and the burn — see `caption-style.ts` |
| Filmstrip | One `tile=10x10` ffmpeg pass → sheets the canvas blits from — see `thumbs.ts` |
| Speaker colours | `Word.speaker` → `--spk-1..8`, by order of first appearance |
| Show an image on a word | Generate it, match the prompt to the script, composite with one `overlay` filter |

`packages/core` is pure TypeScript with **zero dependencies** — so the *same*
`compileEdl` runs in the browser for instant preview and on the server for the
final render. They cannot disagree, because they are the same function.

## Layout

```
packages/core/     transcript model, EDL compiler, renderer, fillers, retakes
  edl.ts           ← the heart. Read this first.
  overlay.ts       images over the picture, keyed to words
  image-prompt.ts  which word a prompt belongs on, and what shape to generate
apps/server/       ffmpeg ingest + render, ASR adapter
  config.ts        ← every remote model id, in one place
apps/web/          transcript editor
```

## Two details that are not optional

**A cut has to be worth making.** Shortening a pause by 20ms is free to compile
and expensive to watch. In the preview a cut is a seek, and a seek re-decodes
from the previous H.264 keyframe: measured against this app's own media in a
real browser, **116ms at p50, 215ms at p90**, with the file *fully buffered* —
so it is codec cost, not network, and no amount of preloading removes it. In the
render a cut is a dropped range of frames plus a micro-fade each side, 24ms of
ramp to delete 20ms of silence. At a 500ms cap, 65 of 175 cuts each froze the picture
for longer than the silence they removed: the edit made the preview *worse* than
no edit. `minTrimMs` (250ms, just above that p90) is the floor — below it the
pause stays. Measured effect at a 500ms cap: 175 cuts → 110, frozen picture
21.2s → 13.3s, at a cost of 8.9s of retained silence spread over 65 pauses.

It governs **pauses only**. A deletion is cut however small the hole, because
that hole contains a word you asked to lose — `trimWorthMaking` is not consulted
on that branch, and a test pins it.

**Micro-fades at cuts.** Cutting a waveform at an arbitrary sample leaves a step
discontinuity — a broadband click. Every segment gets a ~12ms fade in and out.
Inaudible as a fade, and it removes the click.

**The filter graph goes to a file.** It grows linearly with cut count, and an edit
with a few hundred cuts blows past Windows' ~32k command-line limit. Hence
`-filter_complex_script`.

**Preview seeks 30ms early.** Cuts are skipped from a `requestAnimationFrame`
loop, fired at `range.end - 30ms` rather than after the playhead is already past
it. Waiting until you are inside a cut means you hear it — and the old code
checked on `timeupdate`, which fires at ~4Hz, so it leaked up to 250ms of every
word you had deleted. The 40ms `padMs` around each range is what pays for the
early seek. The rule is `playStep` in `packages/core/src/timeline.ts`, pure and
tested, including a test asserting that the old reactive rule bleeds.

**Short gaps between cues are closed, or the captions strobe.** A cue ends at
its last word and the next starts at its first, so the space between them is
the space between two words — not a pause. Measured on a real 14-minute
transcript: 275 of 307 gaps were under 500ms, median 41ms, i.e. one blank frame
275 times. Replaying the overlay at 60Hz counted 242 sub-100ms flashes, median
33ms. `MIN_GAP_S` in `captions.ts` closes anything under 500ms — the same rule
broadcast subtitling uses — and real silences (32 of them, longest 6.5s) stay
blank. It matters for the burn as much as the preview: both read `toCues`.

**A caption never blanks at a splice, whatever the pause slider says.** A gap
between two cues is one of two opposite things, and `splicePoints` is how
`toCues` tells them apart: a **seam** is time the editor removed, and a
**silence** is time it kept. Blanking through a seam means the caption cuts at
every jump cut — the picture cutting is the edit, the caption cutting with it is
gratuitous, and it is the one you notice. A fixed threshold cannot do this job:
shortening a pause leaves a gap of exactly `maxGapMs + 2*padMs`, so at the
default 40ms padding a 500ms cap leaves 580ms and a 2000ms cap leaves 2080ms.
The first missed `MIN_GAP_S` by 80ms and blanked the caption at all 175 cuts;
no constant covers the whole slider. Seams close unconditionally; silences go
through `MIN_GAP_S`.

One narrow band survives, correctly: a pause between `maxGapMs` and
`maxGapMs + 2*padMs + mergeWithinMs` is split and then merged straight back
(padding is wider than the material to remove), so no cut happens and the
silence is really there. Measured 4 of 307 at a 500ms cap. The caption blanks,
because there is genuinely nothing being said and no cut to hide.

**The caption placement guide only shows while paused.** Between cues nothing is
being said and the burn draws nothing, so the preview must draw nothing too. The
guide exists because an empty overlay is impossible to grab; it is a placement
aid, not a claim about the frame. It used to fall back to `cues[0]`, so every
gap flashed the video's *first* line over whatever you were watching — half of
the flicker above. It now holds the last line you heard, dimmed, and only when
the picture is not moving.

**An image insert is timed in SOURCE seconds, and its ramps disagree on purpose.**
An overlay is stored against the same clock every `Word` carries, for the reason
`FrameMove` is: it is attached to CONTENT. Cut a sentence out ahead of a picture
and the picture must still land on the word it was aimed at; stored on the output
clock it would slide backwards by exactly the length of the cut, silently, every
time. The render maps it over with `overlaysToOutput`, because it composites
after the cut where the only clock is the output's.

The two ramps are *different curves* and that is not an oversight. Opacity is
spelt in the render as ffmpeg's `fade` with `alpha=1`, which is linear and has no
shaping parameter — measured against ffmpeg 8.0, the midpoint of a 0.5s fade
reads 134/252, a straight line — so `overlayFade` is linear too, or the preview
would dissolve on a curve the file does not have. Motion (the slide transitions)
goes through `overlay`'s own per-frame `x`/`y`, which *can* carry a smoothstep:
measured, a slide sampled mid-ramp put the image's left edge at −145px against a
predicted −145. So slides get the S-curve, for the reason `frame-track` gives —
a linear move reads as the image being shoved. A dissolve that eases looks like
it is hesitating; a move that does not looks broken.

Three ffmpeg facts the graph depends on, all verified rather than assumed:
`colorchannelmixer`'s `aa` is configuration-time (so it can set a constant
opacity and cannot animate one — the same trap `crop`'s w/h sets); `overlay`'s
x/y *are* per-frame, unlike `crop`'s w/h; and `-loop 1` without `-t` is an
infinite stream, which is how an export hangs. Hence `-loop 1 -framerate F -t D`
per image, bounded to that image's own length so a 4000px photo is not rescaled
for every frame of a ten-minute programme.

**The image track composites after the grade and before the burn.** After the
grade because that is the only ordering the preview can match — in the monitor
the grade is an SVG filter on the `<video>` and the image is a sibling `<img>`,
so it is necessarily ungraded. Before the burn so a caption is never hidden by a
cutaway. Same argument the grade itself makes about captions, one layer further
out.

**You describe the picture; the app works out where it goes.** There is no
"select a word, then pick an image" step, because the prompt already names the
subject: `placeByPrompt` takes the content words of "a friendly robot waving",
skips the vocabulary of *asking* for a picture ("image of", "wide shot"), and
puts the insert on the first time the speaker says the thing. First mention,
because that is where the idea is introduced and because it is the only rule a
user can predict without reading the code. Ties go to the earliest keyword in the
PROMPT, not the earliest match in the script — prompts lead with their subject,
so "a robot in a field" must not land on "field" just because it was said first.
No synonyms and no embeddings: those are where a wrong answer is confidently
wrong, and the honest move is to place nothing. When nothing matches, the image
goes to the selection, then to the playhead, and the panel says so — a picture
you cannot find is worse than one in the wrong place. Every placement is one
click from being moved (select the words, then "Move … here" in the selection
panel), which is what makes guessing safe to do at all.

**Generated, not searched, and at the video's own shape.** A stock library can
only offer the nearest thing somebody already photographed, and almost everything
in one is CC BY — a credit obligation the user carries to publication. The other
half is shape: a 16:9 photograph composited full-frame onto a 9:16 reel loses its
subject to the crop, so the ratio is `nearestAspectRatio(outputFrame)`, resolved
SERVER-side from the same values the render uses. Compared in log space, or a
portrait frame gets pulled towards square by arithmetic. **Unverified against the
live API** — see the header of `image-gen.ts`: the docs give two spellings for
the aspect-ratio field, both are sent, and the wrong one alone would silently
return a 1:1 image that reads as a cropping bug.

**A one-word image is not a one-word insert.** A word is ~0.3s, and a picture on
screen for 0.3s — a third of it fading in, a third fading out — is a flash, not a
cutaway. `suggestWindow` starts at the word and extends forward to 2.5s, floored
at `MIN_OVERLAY_SEC` and capped at 6s. The Insert button and the assistant's
`add_image_at_words` call the same function, so the UI and the chat cannot
disagree about how long an image should stay up.

**Word ids are not indices.** They run `w0, w2, w4…` — assigned from the raw ASR
array before spacing tokens are filtered out. Never parse the number out of an
id; go through an id→index map. `compileEdl` keys off array position, which is
also why reordering words is not merely unimplemented but actively unsafe.

**The filmstrip is sheets, not files.** A 15-minute video at one frame every two
seconds is 443 thumbnails; as separate JPEGs that is 443 requests and 443
decodes. One `fps=1/2,scale=W:64,tile=10x10` pass produces 5 sheets (measured:
562KB, 8.3s) and the canvas blits sub-rectangles out of them. The 8.3s is why
it is a job rather than part of import, and why `POST /api/projects/:id/thumbs`
is idempotent — it returns `{thumbs}` when they exist and `{jobId}` when it had
to start ffmpeg, so the client must branch on which.

**The monitor showing black at 0:00 is not a bug.** The sample media fades in
from black: measured `YAVG` is 17/255 at t=0 and 117 at t=1s, and sampling the
`<video>`'s own pixels at t=60 reads 112.6 against ffmpeg's 114.2 for the same
frame. The monitor shows the frame at the playhead, full stop. A `poster` would
make the picture disagree with the clock.

**The monitor video is absolutely positioned, and must stay that way.** `.stage`
is `display: grid; place-items: center`, which stops its item stretching — so
the implicit row is sized `auto`, from the video's own aspect. A plain
`height: 100%` then resolves against THAT row instead of the stage, and at a
wide monitor the element came out taller than its own container (measured:
483x361 inside a 483x348 stage) with `overflow: hidden` slicing the bottom off
the picture. Dragging the rail wider cropped more, and it ate the captions,
which sit at `y: 0.85`. `object-fit: contain` was never at fault — it was
letterboxing correctly inside an element that had outgrown the box. `position:
absolute; inset: 0` pins the element to the stage so contain measures against
the real bounds. `CaptionOverlay` depends on this too: it derives the picture's
offset from the element's rect and positions the layer against the stage, which
is only equivalent while the two coincide.

## Not built yet

These were once five permanently-disabled rows in the UI, badged "not wired".
That was defended as honesty, but a disabled button is an advertisement for
absence that every user pays for on every session. A roadmap is the honest place
for an unbuilt feature:

| Tool | What it needs |
|---|---|
| Studio Sound | An audio-enhance endpoint (denoise + dereverb) |
| Overdub | A TTS endpoint. **This is the blocker for typing new words** — see below |
| Translate / dub | Translation + cross-lingual TTS |
| Find clips | An LLM pass scoring the transcript for self-contained moments |
| Green screen | A matting endpoint |

**Why you cannot type new words.** Every word carries its own `[start, end]` in
the source, and that is what makes text edits compile to media edits. A word you
type has no timing, so there is no audio for it to point at. You *can* correct a
word's spelling — that changes the captions, which read `word.text` — and the
editor marks corrected words so it never pretends the audio changed. Making the
audio say something new needs Overdub, and Overdub needs a TTS endpoint.

## Known gaps

- **Filler removal needs verbatim ASR.** Whisper-family models *normalize fillers
  away* before you ever see them — so on a normalized transcript, the filler
  detector will correctly find nothing. That's not a bug in the detector. The UI
  flags a transcript as "not verbatim" for this reason.

  The only real model is therefore ElevenLabs Scribe, which transcribes fillers
  verbatim (its batch endpoint has no "no-verbatim" mode to opt out of). Whisper
  and Wizper are gone: they were reachable only through fal, and going direct to
  ElevenLabs would have meant a second provider and a second key to keep models
  that report `verbatim: false` — i.e. that defeat the feature this product is
  built around.
- **One provider, one key.** Transcription is the only thing here that needs a
  remote service. Cuts, captions, retakes and fillers are pure functions in
  `packages/core`; ingest and render are local ffmpeg. Nothing else takes a key.
- No speaker renaming yet. The margin shows who is talking; you cannot correct it.
- **No multitrack, and it is not a UI gap.** `buildRenderPlan` cuts `[0:v]` and
  `[0:a]` against the *same* keep-ranges — there is exactly one `keep[]`. A track UI would offer operations the compiler cannot
  represent, so it would be a lie. Tracks arrive when a second input does.
- **Reordering words would render the wrong audio.** `compileEdl` decides where
  to cut with `cur.index === prev.index + 1`, which conflates "adjacent in the
  document" with "adjacent in the source". That holds only because word order
  never changes today. See the skipped test in `edl.test.ts`.
- **`-filter_complex_script` is deprecated as of ffmpeg 8.** It still works (it
  warns, it does not fail), but the replacement spelling is `-/filter_complex`.
  Worth moving to once the minimum ffmpeg version is pinned — `buildRenderPlan`
  emits the flag in one place.
- **The karaoke `\k` colours read "backwards"** from most social captions: a word
  starts in the highlight colour and turns to your chosen colour once spoken,
  rather than lighting up as it is said. That is what `\k` does — it flips
  SecondaryColour to PrimaryColour. Both ends are controls now ("Not yet spoken"
  and "Spoken"), and the panel labels them in that direction rather than trying
  to talk anyone out of the semantics.
- **Caption fonts are limited to three, on purpose.** libass resolves families
  through fontconfig on the machine running ffmpeg. Arial / Times New Roman /
  Courier New are metric-compatible with the Liberation faces the Docker image
  installs, so fontconfig substitutes them at identical metrics and the preview
  stays honest. Anything without such an alias (Impact, Georgia, Inter) would
  preview correctly and silently fall back in the container. Adding fonts means
  shipping the files and pointing libass at them with `fontsdir`.
- **The caption preview is exact about placement, not rasterisation.** Position,
  size, colour, caps and wrapping all come from the same `CaptionSettings` the
  burn reads, scaled from the same 1080p reference — but the browser and libass
  are different text engines, so antialiasing and outline joins differ slightly.
- **`BorderStyle: 3` fills the box from `OutlineColour`, not `BackColour`.**
  Nothing in the ASS spec makes this obvious and coding it the other way renders
  a box in the wrong colour with no error. `captionBoxFill()` is the single
  answer both sides read; there is a test render behind it.
