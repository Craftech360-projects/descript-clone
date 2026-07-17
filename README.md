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

**It works with no API key.** With `ELEVENLABS_API_KEY` unset the server uses a
mock ASR provider: fake words, real timings, spread across your actual media. The
entire pipeline — ingest, transcript, EDL, ffmpeg render — runs for real at zero
cost. Only the words are invented.

To use real transcription, put a key in `.env`:

```
ELEVENLABS_API_KEY=your-key
```

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

`packages/core` is pure TypeScript with **zero dependencies** — so the *same*
`compileEdl` runs in the browser for instant preview and on the server for the
final render. They cannot disagree, because they are the same function.

## Layout

```
packages/core/     transcript model, EDL compiler, renderer, fillers, retakes
  edl.ts           ← the heart. Read this first.
apps/server/       ffmpeg ingest + render, ASR adapter
  config.ts        ← every remote model id, in one place
apps/web/          transcript editor
```

## Two details that are not optional

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
- **No multitrack, and it is not a UI gap.** `buildRenderPlan` trims `[0:v]` and
  `[0:a]` with the *same* keep-range and concatenates them together — there is
  exactly one `keep[]`. A track UI would offer operations the compiler cannot
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
  starts amber and turns to your chosen colour once spoken, rather than lighting
  up as it is said. That is what `\k` does — it flips SecondaryColour to
  PrimaryColour — and the amber is not exposed as a control yet.
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
