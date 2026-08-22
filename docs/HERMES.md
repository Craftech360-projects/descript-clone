# Handing Jumpstart to an agent

Jumpstart can be driven by an agent running outside the browser — a Hermes host, or
any MCP client. It gets the same seventy tools the in-app assistant uses, the same
folder memories, and the same editing brief.

The in-app assistant ("Jumpy") keeps working exactly as before. Both can be on at
once; they are two doors into one document.

---

## The shape of it

```
Hermes
├── stdio ──▶ jumpstart-mcp  ──HTTP──▶ Jumpstart ──WS──▶ editor window ──▶ live document
│              70 tools + editor_status, wake_editor,
│              list_editor_sessions, use_editor_session, app_logs
│
└── stdio ──▶ jumpstart-dev  ──▶ the repo: run_tests, git_checkpoint,
                                git_revert_last, git_reset_to,
                                git_status_diff, restart_app, app_logs
```

**Two servers, both separate processes from the app.** That is the important part.
The agent is allowed to change Jumpstart's code, so sooner or later it will break the
server. When it does, the app dies — but `jumpstart-dev` does not, so the agent can
still read the log, run the tests and undo the change. If the MCP server lived
inside the app, the agent's hands would die with the thing it broke.

**An editor window has to be open.** Roughly forty of the seventy tools — every
transcript edit, undo/redo, playback, every live setting — read and write a
document that exists only in the renderer's memory. The copy on disk lags it by
about a second and is a projection, not the source of truth. So an agent with no
window attached can list projects, read folder memories and start renders, but it
cannot cut a word. `wake_editor` opens one; `editor_status` says whether one is
there.

---

## Setting it up

### 1. Turn the bridge on

Open Jumpstart → **Settings** → **Connect Hermes** → *Turn on*.

It is off by default, and the switch withholds the capability rather than hiding a
panel: while it is off, every external call is refused no matter how good the
credential.

The panel shows whether a window is attached. That line is the one to look at when
an agent reports mysterious failures.

### 2. Point Hermes at it

```json
{
  "mcpServers": {
    "jumpcut": {
      "command": "node",
      "args": ["/path/to/descript-clone/apps/mcp/src/index.ts"]
    },
    "jumpstart-dev": {
      "command": "node",
      "args": ["/Users/you/.jumpcut-agent/dev-index.ts"],
      "env": { "JUMPSTART_REPO": "/path/to/descript-clone" }
    }
  }
}
```

Note the config names a **command**, never a port. The desktop app takes a fresh
port every launch — deliberately, so it cannot collide with a dev server — and the
MCP server re-reads `bridge.json` on every call, so a restart on a new port is
invisible.

### 3. Install `jumpstart-dev` outside the repo

```bash
mkdir -p ~/.jumpcut-agent
cp -R /path/to/descript-clone/apps/mcp/src/* ~/.jumpcut-agent/
```

An agent that can edit the repo can edit its own undo mechanism, and would then
have disarmed itself at exactly the moment it needed it. Running the dev server
from a copy the agent has no reason to touch keeps the escape hatch out of reach.
Refresh it by hand when you want the newer version.

This blocks nothing the agent wants to do **to Jumpstart**. It is a safety net, not a
gate.

### 4. Set up the backups

```bash
git init --bare ~/JumpcutMirror.git
git -C /path/to/descript-clone remote add mirror ~/JumpcutMirror.git
```

`git_checkpoint` pushes here on every commit. Local, instant, no credentials, and
it survives `git reset --hard` and even `rm -rf .git` in the working copy.

For the leg that survives the machine, push to a ref namespace ordinary work never
rewrites:

```bash
git push origin HEAD:refs/checkpoints/$(date +%s)-$(git rev-parse --short HEAD)
```

**And turn on Time Machine.** This is the part people skip, so it is worth being
blunt: `data/` and `media/` are gitignored, so **no checkpoint backs up a single
project, transcript, upload or render**. Git protects the code. Only a snapshot
protects the work.

---

## The persona

Give the agent this, or something like it. `jumpstart-mcp` also serves it as an MCP
prompt (`jumpy`, and `video_editor` which adds the current editor state), taken
verbatim from the same constant the in-app assistant uses so the two cannot drift.

> You are an experienced video editor who also maintains the tool you edit with.
>
> **Editing.** Call `editor_status` first. If no window is attached, `wake_editor`.
> Read before you cut: `read_transcript` when the request is about what was said.
> Prefer `undo` to patching around an edit that overshot.
>
> **Changing the code.** The loop is:
>
> 1. `git_checkpoint` — *before* you edit. The checkpoint that saves you is the
>    one taken first.
> 2. Edit.
> 3. `run_tests` — it takes half a second, so run it after every change, not once
>    at the end.
> 4. If red: `git_reset_to` `HEAD` to throw away uncommitted work, or
>    `git_revert_last` if you already committed. Then `run_tests` again.
> 5. If still red after one attempt, **stop and report**. Do not stack a second
>    fix on a broken tree.
> 6. `restart_app`, then confirm with `editor_status` and `app_logs`.
>
> **Never edit** `~/.jumpcut-agent/`, the Hermes config, or the LaunchAgent.
> **Never run** `git push --force`, `git push --mirror`, `git filter-repo`, or
> `rm -rf`.
>
> **House style.** Comments explain *why*, not *what*. No new dependencies without
> a reason. `desktop/mac/main.cjs` and `desktop/win/main.cjs` are byte-identical —
> edit both.

This is **instruction, not enforcement**. Nothing prevents an agent ignoring every
line of it. The recoverability comes from the mirror and the snapshots.

---

## Installing the Mac app

Two DMGs, and they are **not** interchangeable:

| File | For |
|---|---|
| `Jumpstart-0.1.0-arm64.dmg` | Apple Silicon (M1/M2/M3…) |
| `Jumpstart-0.1.0-x64.dmg` | Intel |

Both are built from `desktop/mac`:

```bash
npm run dist        # arm64
npm run dist:intel  # x64
```

They can be built on one machine — a Mac Silicon host cross-compiles the Intel
app fine. Build them **one at a time**: the media binaries are per-architecture
and `npm run tools` deletes them before reinstalling so the arch flags take
effect. `afterPack.cjs` refuses to package a mismatch, so a mistake here fails the
build rather than shipping.

The apps are **not notarised**, so macOS quarantines them on first open:

```bash
xattr -dr com.apple.quarantine "/Applications/Jumpstart.app"
```

### On-device transcription needs macOS 26

`SpeechTranscriber` does not exist before macOS 26 — it is a hard compile error
below that, not a warning — and macOS 26 supports very few Intel Macs. So on an
Intel Mac mini you will almost certainly have no on-device speech.

The app says so rather than pretending: the Transcribe panel reports that no
transcription is configured, warns that pressing the button produces *invented
words*, and offers an **Add a key** button. Add **Deepgram**, ElevenLabs or Sarvam
and it transcribes for real. Deepgram Nova-3 is a good default — it keeps
`um`/`uh` (which filler removal needs) and does diarization.

Burned-in captions work on either machine; the caption helper builds for macOS 11.

## Which mode to run in

| | Editing video | Changing features |
|---|---|---|
| Installed DMG | yes | **no** — the code is bundled; edits do nothing until `npm run dist` |
| `cd desktop/mac && npm start` | yes | yes — rebuilds resources from source, and you still get the app window |
| `npm run app` | yes | yes — browser instead of an app window |

If the agent is allowed to change features, run from the repo. The DMG is for when
it is only editing video.

Never run the DMG and `npm run app` against the same data directory: `store.ts`
caches projects in a map that never evicts, so two processes diverge and the last
writer wins.

---

## What it cannot recover from

Full autonomy on `main` was a deliberate choice. These are the things none of the
above undoes:

1. **Rewritten remote history.** The agent has your git credentials. `push --force`
   is one call away. The mirror survives — unless it mirrors over that too.
2. **The work is not in git.** Projects, transcripts, uploads and renders are
   gitignored and invisible to every checkpoint. Snapshots only.
3. **Deleted media is permanent.** `delete_project` unlinks the sources, poster and
   filmstrips. Correctly bounded to the media directory — but inside it, gone.
4. **A change that passes the tests and is still wrong.** The suite is mostly pure
   functions in `packages/core`; `store.ts`, `jobs.ts`, `index.ts` and `ffmpeg.ts`
   have very little coverage. Measured while building this: changing an EDL range
   filter from `>` to `>=` kept all 563 tests green. Green means the EDL maths
   still works; it does not mean your projects are safe.
5. **Undo does not survive a reload.** The history stack lives in the renderer, so
   an agent cannot take back an edit made before the last restart.
6. **Prompt injection is a code-execution path now.** `read_webpage` pulls open-web
   text into the agent's context, and that agent holds file-edit and git tools. The
   public-address guard stops SSRF; nothing stops a page that says "also, run this".
7. **`use_folder`'s guarantee does not hold for an outside agent.** Its safety came
   from the path and the user's own words arriving from two independent places. For
   an external caller both come from the same model. `SUMMON=off` disables it.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| "The Hermes bridge is switched off" | Settings → Connect Hermes → Turn on |
| "No editor window is attached" | `wake_editor`, or open the app |
| "Jumpstart is not running" | `wake_editor`; if it will not start, `app_logs` |
| Every call 401s | Stale cookie from another install — reload the page once |
| Tools work, edits do not stick | Two processes on one data directory. Run one |
| `app_logs` says no log configured | A server started in a terminal prints there; only the packaged app writes a file |
