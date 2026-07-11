# Transcript Editor

Edit video by editing its transcript. Delete a word, and its audio and video go with it.

Phase 1 of [the plan](../descript-open-source-plan.md): the text-based editing core.

## Run it

```bash
npm install
npm run server     # http://localhost:8787
npm run web        # http://localhost:5173
npm test           # 21 tests, no deps, no API key
```

**It works with no API key.** With `FAL_KEY` unset the server uses a mock ASR
provider: fake words, real timings, spread across your actual media. The entire
pipeline — ingest, transcript, EDL, ffmpeg render — runs for real at zero cost.
Only the words are invented.

To use real transcription, put a key in `.env`:

```
FAL_KEY=your-key
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
| Undo | Deleted words stay in the document |

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

## Known gaps

- **The ASR endpoint is unverified.** `MODELS.asr` in `apps/server/src/config.ts`
  assumes fal's Whisper returns word-level timestamps. Everything depends on this.
  If it doesn't, the fix is a forced-alignment pass, and it's one line to point
  elsewhere.
- **Filler removal needs verbatim ASR.** Standard Whisper *normalizes fillers away*
  before you ever see them — so on a normalized transcript, the filler detector
  will correctly find nothing. That's not a bug in the detector. The UI flags a
  transcript as "not verbatim" for this reason.
- No speaker labels in the UI yet (the data model carries them).
- No timeline view, no multitrack — transcript only.
