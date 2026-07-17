# Hosting spec & API contract

Sizing here is **derived from what the code actually does**, not measured. Every
render returns `renderMs` — measure with your own media before you commit to an
instance size. Where I am guessing, it says so.

---

## 1. What this thing is, for sizing purposes

Three workloads with completely different shapes:

| Stage | Bound by | Where it runs |
|---|---|---|
| Import (`probe` + `computePeaks`) | Disk + a short CPU burst | Local ffmpeg |
| Transcribe | **Network + wall-clock wait** on ElevenLabs | Remote — you are billed per minute of audio |
| Cuts / captions (`compileEdl`, `toCues`) | Nothing. Pure array maths on ≤10k words | Local, sub-millisecond |
| **Render** | **CPU, hard** — x264 encode | Local ffmpeg |

Only render sizes the box. Cuts and captions are free — `packages/core` has zero
dependencies and touches no I/O.

---

## 2. The one thing that will surprise you: render cost is O(segments × duration)

Not O(output duration). This is the most important fact for capacity planning.

`buildRenderPlan` emits one `trim` chain per kept range, all fed from the same
input label:

```
[0:v]trim=start=1.2:end=3.4,setpts=PTS-STARTPTS[v0];
[0:v]trim=start=5.1:end=9.8,setpts=PTS-STARTPTS[v1];
...
[v0][a0][v1][a1]...concat=n=N:v=1:a=1[outv][outa]
```

Reusing `[0:v]` N times makes ffmpeg **implicitly split the decoded stream N
ways**. Each of the N trim chains then sees *every frame* of the source and
discards the ones outside its window. So:

- Decode happens once, but **filtering is N × full-stream**.
- `concat` needs all N inputs live, so buffering grows with N.
- A 10-min 1080p video with **5 cuts** renders quickly.
- The same video with **400 cuts** — a realistic filler-removal pass — does
  roughly 400× the filter work. This is the difference between seconds and
  "did it hang?".

Removing every "um" from an hour-long podcast is exactly the case that produces
hundreds of segments. **Test that case before sizing.** If it is too slow, the
fix is the concat demuxer (segment to temp files, concat losslessly) or
`select`/`aselect` with a single expression — both replace N chains with one.

---

## 3. Instance spec

**Assumption: 1080p30 H.264 source, x264 `veryfast` `crf 20`, no GPU path in the
code.** ffmpeg here is CPU-only — a GPU instance buys you nothing without code
changes (`-c:v h264_nvenc`).

| Profile | vCPU | RAM | Disk | Fits |
|---|---|---|---|---|
| Demo / single user | 2 | 4 GB | 20 GB | Short clips, few cuts. Renders block. |
| **Small team (start here)** | **4** | **8 GB** | **100 GB SSD** | 1080p, one render at a time |
| Heavier | 8 | 16 GB | 500 GB SSD | Concurrent renders, longer media |

**Why 4 GB is the floor, not a round number:**

- `parseBody()` buffers the **entire upload in memory** before it hits disk
  (`Buffer.from(await file.arrayBuffer())`) — and transiently holds ~2× while
  copying the ArrayBuffer into a Buffer. A 512 MB upload can spike ~1 GB. This is
  why `MAX_UPLOAD_MB` exists; the default 512 assumes ≥4 GB RAM.
- `computePeaks` buffers the whole decoded 8 kHz mono PCM in RAM: ~57 MB/hour of
  media, all at once.
- x264 at 1080p `veryfast` sits around 300–600 MB, plus the concat buffering above.
- `store.ts` caches **every project in a `Map` that never evicts**. Transcripts
  and peaks accumulate for the process lifetime. Restarts are currently your GC.

**Disk grows without bound.** Nothing is ever deleted:

- `uploads/{id}.ext` — the original, kept forever (correct: edits are non-destructive).
- `uploads/{id}.asr.wav` — 16 kHz mono PCM, **~115 MB per hour of media**, written
  on every transcribe and never cleaned up.
- `renders/{id}-{timestamp}.mp4` — **a new file per export**, never cleaned up.
- `projects/{id}.json` — peaks + words; ~1 MB per hour of transcript.

Budget roughly `(source + 115 MB + N×render) per hour of media`, then add a
reaper or a lifecycle policy. Put `/data` on a volume that can grow.

**Network:** uploads dominate inbound; the full 16 kHz WAV goes **outbound to
ElevenLabs** on every transcribe (~115 MB/hour of audio) as the POST body. On
metered egress that is a real line item.

---

## 4. Blockers before this is production-ready

The container fixes packaging. It does not fix these. Ranked:

1. **No authentication, at all.** Every route is open — list projects, read
   transcripts, download source media, spend your ASR credit. `CORS_ORIGIN` narrows
   *browsers*, not `curl`. **Do not expose this to the internet without an auth
   layer in front.**
2. **Render blocks the HTTP request.** `POST /render` runs ffmpeg inline and
   returns when it finishes. A long render exceeds ALB/nginx/Cloudflare idle
   timeouts (typically 30–60 s) and the client sees a 504 while the server keeps
   burning CPU. **This needs a job queue** (`202 + job id`, poll or SSE) before it
   survives real media. This is the single biggest gap.
3. **Cannot scale horizontally.** State is JSON files plus a per-process in-memory
   `Map`. Two replicas behind a load balancer will serve divergent data and clobber
   each other's writes. **Run exactly one instance**, or move state to Postgres/S3
   first.
4. **Uploads buffered in memory** (see above). Should stream to disk.
5. **No cleanup.** Unbounded disk growth.
6. **`.env` with a live `FAL_KEY` is committed** (`5fd5e30`). The code no longer
   reads it, but the secret is still in history. See §7.

---

## 5. API contract

Base: `/api`. All JSON unless noted. Errors: `{ "error": "..." }` with 4xx/5xx.

### Health

```
GET /api/health → 200 {ok, ffmpeg, ffprobe, asr} | 503 when ffmpeg is missing
```

Use as the container/orchestrator probe. 503 means the image is broken — do not
route to it.

### Import (does not transcribe)

```
POST /api/projects            multipart/form-data, field "file"
  → 200 Project | 400 no file / no audio track | 413 over MAX_UPLOAD_MB
```

Probes the media and computes the waveform. Transcription is deliberately a
separate, explicit call because it costs money.

### Transcribe

```
POST /api/projects/:id/transcribe
{
  "model":    "scribe_v1" | "mock",
  "language": "auto" | ISO code,     // e.g. "en" → language_code
  "speakers": 0,                     // 0 = auto. >0 → num_speakers.
  "diarize":  true,
  "verbatim": true                   // Scribe is verbatim by construction; sent nowhere.
}
  → 200 Project (with .transcript, .verbatim, .asrProvider)
```

**Hard requirement: the model must return WORD-level timestamps.** The entire
product is range-subtraction over per-word `[start, end]`. Segment-level timings
cannot support it. The request sets `timestamps_granularity: 'word'`;
`normalizeToWords()` reads `words[]` and throws with the payload keys listed if it
finds nothing usable.

**One provider, one key.** ElevenLabs is the only remote dependency. There is no
storage hop — the WAV is the POST body, so a user's audio is never parked at a
public URL. Cuts, captions and render need no key at all.

**Verified live on 2026-07-16.** `scribe_v1` is a real id; `timestamps_granularity:
'word'` is honoured; the response carries `words[]` with per-word `start`/`end` in
**seconds** and `speaker_id`; `language_code` and `num_speakers` are accepted. The
`[asr] keys:` log line prints the response skeleton on every call, so a shape
change surfaces immediately rather than archaeologically.

`ELEVENLABS_API_KEY` unset → mock provider, full pipeline, zero cost.

### Edit state

```
PATCH /api/projects/:id/transcript   { "deletedIds": ["w3","w4"] }   → {ok}
POST  /api/projects/:id/actions/detect-fillers   { includeDiscourseMarkers?: bool }
POST  /api/projects/:id/actions/remove-fillers   { includeDiscourseMarkers?: bool }
POST  /api/projects/:id/actions/remove-retakes   { minWords?: int, maxInterruption?: int }
POST  /api/projects/:id/actions/restore-all
  → { ok, changed, transcript }
```

Deletes are soft — words stay in the document, so every edit is reversible.
The set of deleted word ids *is* the entire edit state.

### Cuts (`CompileOptions` — shared by captions and render)

| Field | Default | Meaning |
|---|---|---|
| `padMs` | 40 | Widens each kept range. ASR marks the onset of phonation; without padding, cuts clip plosives. |
| `fadeMs` | 12 | Micro-fade at every boundary. **Not polish** — cutting mid-waveform is a step discontinuity, i.e. an audible click. |
| `mergeWithinMs` | 20 | Ranges closer than this merge instead of producing a cut. |
| `maxGapMs` | `0` = keep every pause | Cap on silence *between* kept words. Over the cap becomes a split. **`0` over the wire means Infinity** — see `toCompileOptions`. |

Pure functions over the transcript. No I/O, no cost, safe to call per keystroke.
The same `compileEdl` runs in the browser for preview and here for render — they
cannot disagree, because they are the same function.

### Captions

```
POST /api/projects/:id/captions
{ "format": "srt" | "vtt" | "ass", "maxChars": 42, "maxDurationMs": 5000, ...CompileOptions }
  → { format, cues, content }
```

**Cues are timed against the OUTPUT timeline, not the source.** A word at 4:32 in
the raw footage is not at 4:32 in a cut that removed 90 seconds before it. This is
the single most common way this feature ships broken. Because cues are compiled
from the same EDL as the render, they track the cut by construction.

`ass` carries per-word `\k` karaoke timing (the animated-caption look) and is what
burn-in uses.

### Render

```
POST /api/projects/:id/render
{ ...CompileOptions, "burnCaptions": bool, "captionFontSize": int, "maxChars": int, "maxDurationMs": int }
  → { url, segments, burnedIn, captionsSkipped, sourceDuration, outputDuration, renderMs }
  → 400 when every word is deleted
```

**Synchronous — it blocks until ffmpeg exits.** See blocker #2.

Burn-in is video-only and post-concat (burning before would drift every caption by
the amount cut before it). `captionsSkipped: true` means you asked for captions on
an audio-only project. `renderMs` is your measurement hook — use it.

---

## 6. Container notes

```bash
docker build -t jumpcut .
docker run -p 8787:8787 -v media:/data -e ELEVENLABS_API_KEY=... jumpcut
# or: docker compose up --build
```

| Env | Default | Notes |
|---|---|---|
| `PORT` | 8787 | |
| `MEDIA_DIR` | `/data` in image | **Must be a volume.** Default in dev sits in the source tree. |
| `WEB_DIST` | `./apps/web/dist` in image | Serves the UI from the API server, so one container is the product. Unset in dev — Vite serves and proxies. |
| `ELEVENLABS_API_KEY` | — | The only key this product needs. Unset → mock ASR. |
| `CORS_ORIGIN` | unset = `*` | Pin it. `*` + no auth = anyone's page drives your API. |
| `MAX_UPLOAD_MB` | 512 | Bounded by RAM, not policy. |

Why the image carries what it does:

- **ffmpeg** — without it the app boots fine and dies on first import with
  `spawn ffprobe ENOENT`. `/api/health` reports 503 instead of letting that happen
  in front of a user.
- **fonts-liberation + fontconfig** — the ASS style names `Arial`, which does not
  exist on Debian. Liberation Sans is metric-compatible and fontconfig substitutes
  it, so burned captions keep their intended size. With **no** fonts installed,
  libass renders nothing and the burn silently no-ops.
- **tini** — node as PID 1 does not reap children, and this spawns an ffmpeg per render.
- **non-root (`node`)**, and `/data` is a volume so state survives deploys.

---

## 7. Secret hygiene — act on this

`.env` containing a live `FAL_KEY` is **committed in git history** (`5fd5e30`).
Dropping fal from the code does **not** revoke that key — it is still valid, still
in history, and anyone with repo access has it.

1. **Revoke the fal key at fal.** It is unused now, so revoking costs nothing and
   is the only step that actually helps. Deleting the line from `.env` does not.
2. **Do not let `ELEVENLABS_API_KEY` repeat the mistake.** `.gitignore` currently
   does **not** list `.env`, so the new key is one `git add .` from the same fate.
3. Keep it in the runtime environment/secret manager, never a file.
4. Optionally scrub history (`git filter-repo`), but revocation is what matters —
   history may already be cloned.

`.dockerignore` excludes `.env` so the image does not bake it in.
