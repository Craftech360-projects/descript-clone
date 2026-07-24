import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  clipsOf,
  clipGlobalTime,
  clipLocalTime,
  waitForJob,
  type Capabilities,
  type Clip,
  type CustomFont,
  type JobKind,
  type MediaItem,
  type MusicResult,
  type Project,
  type RenderResult,
  type AsrOptions,
  type Thumbs,
} from './api.ts';
import { renderFilename, saveAs } from './download.ts';
import Script from './Script.tsx';
import Timeline from './Timeline.tsx';
import TitleBar from './shell/TitleBar.tsx';
import Dashboard from './shell/Dashboard.tsx';
import Library from './shell/Library.tsx';
import Monitor from './shell/Monitor.tsx';
import Transport from './shell/Transport.tsx';
import Splitter from './shell/Splitter.tsx';
import Rail from './shell/Rail.tsx';
import TranscribeDialog from './dialogs/TranscribeDialog.tsx';
import ExportDialog from './dialogs/ExportDialog.tsx';
import type { FillerMode } from './rail/ProjectPanel.tsx';

import {
  beginCutDrag,
  clearDoc,
  correctText,
  countFillers,
  countRetakes,
  endCutDrag,
  historyState,
  loadDoc,
  redoEdit,
  removeFillers,
  removeRetakes,
  restoreAll,
  retrySave,
  runImportChain,
  selectedIds,
  setSaver,
  setSelection,
  setSelectionDeleted,
  undoEdit,
  updateCut,
  updateCaptions,
  updateSpeed,
  updateStudioSound,
  updateFrame,
  beginFrameDrag,
  endFrameDrag,
  addPunchIn,
  setMove,
  setMovePath,
  deletePunchIn,
  updateColor,
  beginColorDrag,
  endColorDrag,
  beginCaptionDrag,
  endCaptionDrag,
  useEditor,
  flushSave,
} from './store/editor.ts';
import { DEFAULT_CAPTIONS, normalizeCaptions } from '../../../packages/core/src/caption-style.ts';
import CaptionOverlay from './shell/CaptionOverlay.tsx';
import { lastStartingAtOrBefore } from '../../../packages/core/src/paragraphs.ts';
import { speakers, colorMap } from './speakers.ts';
import { usePlayback } from './store/playback.ts';
import { useMusicPreview } from './store/musicPreview.ts';
import { useStudioSoundPreview } from './store/studioSound.ts';
import {
  autoImportCount,
  loadAutoImport,
  saveAutoImport,
  type AutoImport,
} from './store/autoImport.ts';
import { cutFromWire, cutToWire, DEFAULT_SPEED, type CutSettings } from '../../../packages/core/src/doc.ts';
import { DEFAULT_FRAME, frameLayout } from '../../../packages/core/src/frame.ts';
import {
  MIN_MOVE_SEC,
  boxToPunch,
  punchToBox,
  type FrameBox,
} from '../../../packages/core/src/frame-track.ts';
import { FollowAborted, followObject } from './track/follow.ts';
import { DEFAULT_COLOR } from '../../../packages/core/src/color.ts';
import { clipAt, compileEdl, compileSequenceEdl, outputDuration, outputToSource } from '../../../packages/core/src/edl.ts';
import type { Edl, Transcript } from '../../../packages/core/src/types.ts';
import { wordAt } from '../../../packages/core/src/paragraphs.ts';

const CUSTOM_FILLERS_KEY = 'jumpcut.customFillers';

/**
 * The output(1x) time at a source moment: the kept duration lying before it.
 *
 * Unlike edl.ts's sourceToOutput, this never returns null inside a cut gap — it
 * clamps to the gap's near boundary — so the music trim handle can be dragged to
 * land anywhere on the timeline, cut material included, and still resolve to a
 * sensible length.
 */
function keptBefore(edl: Edl, sourceSec: number): number {
  let acc = 0;
  for (const r of edl.keep) {
    if (sourceSec <= r.start) break;
    acc += Math.min(sourceSec, r.end) - r.start;
    if (sourceSec < r.end) break;
  }
  return acc;
}

/**
 * Shift a project's LOCAL per-clip word times onto the one global timeline.
 *
 * The server stores each word's start/end in its own clip's file timeline (plus
 * a clipId). The editor runs on a single global clock, so each word is moved by
 * its clip's offset once, at load. A single-source project has one clip at offset
 * 0, so this returns the transcript untouched.
 */
function globalizeTranscript(p: Project): Transcript {
  const t = p.transcript!;
  const clips = clipsOf(p);
  if (clips.length <= 1) return t;
  const offsetOf = new Map(clips.map((c) => [c.id, c.offset]));
  const firstId = clips[0].id;
  return {
    ...t,
    duration: clips.reduce((sum, c) => sum + c.duration, 0),
    words: t.words.map((w) => {
      const off = offsetOf.get(w.clipId ?? firstId) ?? 0;
      return { ...w, start: w.start + off, end: w.end + off };
    }),
  };
}

/** The user's saved custom filler words, or [] if none / unreadable. */
function loadCustomFillers(): string[] {
  try {
    const raw = localStorage.getItem(CUSTOM_FILLERS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((w): w is string => typeof w === 'string') : [];
  } catch {
    return [];
  }
}

export default function App() {
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [library, setLibrary] = useState<MediaItem[]>([]);
  const [project, setProject] = useState<Project | null>(null);

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  /** The long-running job in flight, if any: what it is and how far along. */
  const [job, setJob] = useState<
    { id: string; progress: number; stage: string; kind: JobKind } | null
  >(null);

  const [dialog, setDialog] = useState<'transcribe' | 'export' | null>(null);
  /** The media/speakers drawer behind the title-bar ☰. */
  const [libOpen, setLibOpen] = useState(false);
  const [asr, setAsr] = useState<AsrOptions | null>(null);
  const [fillerMode, setFillerMode] = useState<FillerMode>('hesitations');
  const [customFillers, setCustomFillers] = useState<string[]>(loadCustomFillers);
  const [retakeMin, setRetakeMin] = useState(2);

  // Which steps run by themselves on import. A personal preference, so it is
  // read from and written to localStorage, exactly like the custom filler words.
  const [autoImport, setAutoImport] = useState<AutoImport>(loadAutoImport);
  useEffect(() => saveAutoImport(autoImport), [autoImport]);

  // Persist the user's custom filler words across reloads. They are a personal
  // preference, not project data, so localStorage — not the server — is home.
  useEffect(() => {
    try {
      localStorage.setItem(CUSTOM_FILLERS_KEY, JSON.stringify(customFillers));
    } catch { /* private mode: keep them for this session only */ }
  }, [customFillers]);

  const [showDeleted, setShowDeleted] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [followEdit, setFollowEdit] = useState(true);
  const [result, setResult] = useState<RenderResult | null>(null);

  // Imported caption fonts are global — one library backs every project — so they
  // live at the top of the app, not on a project. See importFont / the @font-face
  // effect below.
  const [customFonts, setCustomFonts] = useState<CustomFont[]>([]);
  const [fontBusy, setFontBusy] = useState(false);

  // Background music is per project, so it rides on `project.music`; this only
  // tracks the in-flight import so the button can say so. See importMusic below.
  const [musicBusy, setMusicBusy] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  // The <audio> that plays the music bed in the monitor, on the output clock.
  const musicRef = useRef<HTMLAudioElement>(null);
  // The output frame element in the monitor. Shared with the caption overlay,
  // which measures the same rectangle so a caption is placed against the frame
  // that ships rather than against the source picture behind it.
  const frameRef = useRef<HTMLDivElement>(null);

  const { doc, selection, flash, reveal, saveStatus } = useEditor();

  const words = doc?.words ?? [];
  const cut = doc?.cut ?? null;
  const captions = doc?.captions ?? DEFAULT_CAPTIONS;
  const frame = doc?.frame ?? DEFAULT_FRAME;
  const color = doc?.color ?? DEFAULT_COLOR;
  const speed = doc?.speed ?? DEFAULT_SPEED;
  const history = historyState();

  // The project's clips, in play order with timeline offsets. One entry for a
  // single-source project — so everything below is one code path.
  const clips = useMemo(() => (project ? clipsOf(project) : []), [project]);

  // The seams the "+" markers sit on in the timeline: the start of every clip
  // (index 0 is the very start), plus one past the end for "append". Each carries
  // the play-order slot a new source dropped there would take — offset in global
  // source seconds so the timeline can place it under the current zoom/scroll.
  const clipInsertPoints = useMemo(() => {
    if (!project || clips.length === 0) return [];
    const points = clips.map((c, i) => ({ index: i, time: c.offset }));
    points.push({ index: clips.length, time: project.duration });
    return points;
  }, [clips, project?.duration]);

  // Which clip the one <video> element is currently showing. Playback and seeks
  // swap this as the global playhead crosses a clip seam; a single-clip project
  // never moves off its one clip.
  const [activeClipId, setActiveClipId] = useState<string | null>(null);
  const activeClip = useMemo(
    () => clips.find((c) => c.id === activeClipId) ?? clips[0] ?? null,
    [clips, activeClipId],
  );
  // The rAF playback loop and imperative seeks read the live clip without
  // re-subscribing every render.
  const activeClipRef = useRef<Clip | null>(null);
  activeClipRef.current = activeClip;

  // Reset to the first clip whenever the project changes (not on every clips
  // identity change — e.g. a filmstrip arriving must not yank playback to clip 0).
  useEffect(() => {
    setActiveClipId(clips[0]?.id ?? null);
  }, [project?.id]);

  useEffect(() => {
    api.capabilities().then((c) => { setCaps(c); setAsr(c.asrDefaults); }).catch((e) => setError(e.message));
    api.list().then(setLibrary).catch(() => {});
    api.fonts.list().then(setCustomFonts).catch(() => {});
  }, []);

  // Make every imported font available to the preview by declaring an @font-face
  // for it — the same family libass gets from fontsdir at render, so the monitor
  // and the burn show the identical typeface. One managed <style> holds them all;
  // it is rebuilt whenever the library changes and its rules never accumulate.
  useEffect(() => {
    const el = document.createElement('style');
    el.textContent = customFonts
      .map(
        (f) =>
          `@font-face{font-family:"${f.family.replace(/"/g, '')}";` +
          `src:url("${f.url}") format("${f.format}");font-display:swap;}`,
      )
      .join('\n');
    document.head.appendChild(el);
    return () => el.remove();
  }, [customFonts]);

  // Persist the deleted set, debounced and single-flighted by the store. It used
  // to fire on every word toggle with no debounce and no ordering guarantee —
  // and since the PATCH replaces the whole set, a late response could resurrect
  // words you had already cut.
  useEffect(() => {
    if (!project) return setSaver(null);
    const id = project.id;
    setSaver(async (d) => {
      try {
        await api.saveDoc(id, {
          deletedIds: d.words.filter((w) => w.deleted).map((w) => w.id),
          captions: d.captions,
          speed: d.speed,
          studioSound: d.studioSound,
          frame: d.frame,
          color: d.color,
          // Infinity ("keep every pause") does not survive JSON — cutToWire maps
          // it to the 0 the server and disk speak.
          cut: cutToWire(d.cut),
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });
    return () => setSaver(null);
  }, [project?.id]);

  useEffect(() => {
    const flush = () => flushSave();
    window.addEventListener('beforeunload', flush);
    return () => window.removeEventListener('beforeunload', flush);
  }, []);

  const edl = useMemo(() => {
    if (!doc) return null;
    // One clip: the original single-source compile, byte-identical.
    if (clips.length <= 1) {
      return compileEdl({ mediaId: '', duration: project?.duration ?? 0, words: doc.words }, doc.cut);
    }
    // Several clips: hand each its own words back on its LOCAL timeline (undo the
    // globalize) so compileSequenceEdl cuts at seams and never merges across a
    // file boundary. The result's ranges come back global, with clip metadata.
    const firstId = clips[0].id;
    const seq = clips.map((c) => ({
      clipId: c.id,
      duration: c.duration,
      words: doc.words
        .filter((w) => (w.clipId ?? firstId) === c.id)
        .map((w) => ({ ...w, start: w.start - c.offset, end: w.end - c.offset })),
    }));
    return compileSequenceEdl(seq, doc.cut);
  }, [doc?.words, doc?.cut, project?.duration, clips]);

  // Who is in this piece, and in what colour. Keyed on the words array, whose
  // identity structural sharing preserves — so this is a full scan per edit, not
  // per render, and it never runs during playback.
  const cast = useMemo(() => speakers(words), [words]);
  const castColors = useMemo(() => colorMap(cast), [cast]);

  const playingIndex = useMemo(
    () => (playing ? wordAt(words, currentTime) : -1),
    [playing, words, currentTime],
  );

  const selectedSet = useMemo(() => selectedIds(words, selection), [words, selection]);
  const flashSet = useMemo(() => new Set(flash), [flash]);

  // The timeline reads the clock imperatively at 60Hz. Passing currentTime as a
  // prop would re-render the whole app on every animation frame. The element's
  // currentTime is LOCAL to the loaded clip; add its offset to report the global
  // timeline position everything else speaks. Offset 0 for a single-clip project.
  const getCurrentTime = useCallback(() => {
    const clip = activeClipRef.current;
    const local = videoRef.current?.currentTime ?? 0;
    return clip ? clipGlobalTime(clip, local) : local;
  }, []);

  const selectedWords = useMemo(
    () => words.filter((w) => selectedSet.has(w.id)),
    [words, selectedSet],
  );

  /** The source range the script selection covers, so both surfaces agree. */
  const selectionRange = useMemo(() => {
    if (selectedWords.length === 0) return null;
    return {
      start: selectedWords[0].start,
      end: selectedWords[selectedWords.length - 1].end,
    };
  }, [selectedWords]);

  // Word edges and cut boundaries — the only places a selection can honestly
  // land, since the EDL is word-bounded.
  const snapTargets = useMemo(() => {
    const targets: number[] = [];
    for (const w of words) { targets.push(w.start); targets.push(w.end); }
    return targets;
  }, [words]);

  /** Dragging in the timeline selects the words that range covers. */
  const selectRange = useCallback(
    (range: { start: number; end: number } | null) => {
      if (!range) return setSelection(null);
      const covered = words.filter((w) => w.end > range.start && w.start < range.end);
      if (covered.length === 0) return setSelection(null);
      setSelection({ anchorId: covered[0].id, focusId: covered[covered.length - 1].id });
    },
    [words],
  );

  const stats = {
    words: words.length,
    kept: words.filter((w) => !w.deleted).length,
    cuts: edl?.keep.length ?? 0,
    outputSec: edl ? outputDuration(edl, speed) : 0,
    sourceSec: project?.duration ?? 0,
    speed,
  };

  const run = async <T,>(label: string, fn: () => Promise<T>) => {
    setBusy(label);
    setError(null);
    try { return await fn(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); return null; }
    finally { setBusy(null); }
  };

  const cancelJob = useCallback(() => {
    if (job) void api.cancelJob(job.id).catch(() => {});
  }, [job]);

  const openTranscript = (p: Project, defaults: CutSettings) => {
    // Cut settings, caption style and speed are all persisted per project, so
    // they come off the record. Anything a project saved before these existed is
    // missing, and each fills in: cutFromWire to the engine defaults,
    // normalizeCaptions per FIELD, speed (via clampSpeed downstream) to 1.
    //
    // Per field, not per object. This was `p.captions ?? DEFAULT_CAPTIONS`, which
    // only covers a project that never had captions at all — one that had them
    // before a setting was added kept the gap. See normalizeCaptions.
    if (p.transcript) {
      // The stored words hold LOCAL per-clip timestamps; the editor works on one
      // global timeline (playhead, EDL, selection, timeline). Shift each word by
      // its clip's offset once here, so every consumer downstream stays a single-
      // timeline code path and only the EDL compile splits back per clip. A
      // single-source project has offset 0, so this is a no-op for it.
      loadDoc(
        globalizeTranscript(p),
        cutFromWire(p.cut, defaults),
        normalizeCaptions(p.captions),
        p.speed,
        p.studioSound,
        p.frame,
        p.color,
      );
    } else clearDoc();
  };

  // --- the on-import chain ------------------------------------------------------
  /**
   * Take a file that just landed all the way to something you could export.
   *
   * Transcribe, cut the hesitations, cap the pauses, set the speed, enhance the
   * voice, turn on the captions — the six things you would otherwise do by hand,
   * in the only order they work in. Which of them run is the user's, in the
   * Library drawer under "On import"; see store/autoImport.ts.
   *
   * The split here is deliberate. Transcription is a SERVER JOB: it has to be
   * awaited, it can fail, and it replaces the document wholesale, so it lives up
   * here where the project state and the progress bar are. The steps after it are
   * pure edits to the document, so they go down into the store as one batch —
   * one undo step, one save, and no chance of racing the debounced write.
   *
   * Failures propagate to `run`, which shows the banner and clears busy. A chain
   * that dies at transcription leaves an imported, untranscribed project — which
   * is exactly the state importing has always left you in, so nothing is lost.
   */
  const runAutoImport = async (imported: Project): Promise<Project> => {
    const steps = autoImport;
    let p = imported;
    if (autoImportCount(steps) === 0) return p;

    let transcribed = false;
    if (steps.transcribe && !p.transcript) {
      if (!caps?.hasAsr || !asr) {
        setNotice(
          'Imported. The on-import chain starts with transcription, and no ASR provider is ' +
            'configured — set ELEVENLABS_API_KEY on the server, or run Transcribe by hand.',
        );
        return p;
      }
      const { jobId } = await api.transcribe(p.id, asr);
      setJob({ id: jobId, progress: -1, stage: 'Transcribing', kind: 'transcribe' });
      await waitForJob(jobId, (j) =>
        setJob({ id: jobId, progress: j.progress, stage: j.stage, kind: 'transcribe' }),
      );
      setJob(null);
      // The job returns an id, not the project — a 485KB payload has no business
      // in a record polled twice a second. Same reason as doTranscribe.
      p = await api.get(p.id);
      setProject(p);
      openTranscript(p, editDefaults(caps));
      setLibrary(await api.list());
      transcribed = true;
    }

    // Hesitations only, never the wider "All" sweep: "sort of" and "I mean" are
    // load-bearing often enough that nothing should cut them unasked. The custom
    // words ride along, since those the user chose by name.
    const done = runImportChain({
      fillers: steps.fillers
        ? { includeDiscourseMarkers: false, customWords: customFillers }
        : null,
      maxGapMs: steps.pauses ? steps.pauseCapMs : null,
      speed: steps.speed ? steps.speedValue : null,
      studioSound: steps.studioSound ? true : null,
      captions: steps.captions ? true : null,
    });

    // Land it now rather than 800ms from now: the chain is the last thing that
    // happens to an import, so there is nothing coming to coalesce with.
    flushSave();

    const applied = [...(transcribed ? ['transcribed'] : []), ...done.applied];
    setNotice(
      applied.length > 0
        ? `Ready — ${applied.join(', ')}. Undo takes the clean-up back in one step.`
        : 'Imported. Nothing in the on-import chain had anything to do.',
    );
    return p;
  };

  // --- library -----------------------------------------------------------------
  const importFile = (file: File) =>
    run('import', async () => {
      const p = await api.import(file);
      setProject(p);
      openTranscript(p, editDefaults(caps));
      setResult(null);
      setLibrary(await api.list());
      // Import still does not transcribe on its own — but if you have asked for
      // the on-import chain, this is where it runs. With every step off this
      // returns immediately and importing means exactly what it always did.
      //
      // After the api.list() await, deliberately: React has flushed the render
      // that setProject queued, so the effect keyed on project.id has installed
      // the saver and the chain's edits actually persist.
      return await runAutoImport(p);
    }).finally(() => setJob(null));

  /**
   * Append another source file to the OPEN project, extending its timeline.
   *
   * This is "add a video into this project": import lands a new project, this
   * lands a new clip on the current one. A transcribed project transcribes the
   * newcomer (a job); either way we re-fetch to pick up the stitched transcript
   * and the recomputed clip list. flushSave first so any pending word deletions
   * are on the server before it rewrites the transcript.
   */
  const addClip = (file: File, atIndex?: number) =>
    run('addClip', async () => {
      flushSave();
      // The clips present before the append — used both to spot which id is the
      // newcomer and to rebuild the order when inserting somewhere other than end.
      const before = clips.map((c) => c.id);
      const { jobId } = await api.addClip(project!.id, file);
      if (jobId) {
        setJob({ id: jobId, progress: -1, stage: 'Transcribing new clip', kind: 'transcribe' });
        await waitForJob(jobId, (j) =>
          setJob({ id: jobId, progress: j.progress, stage: j.stage, kind: 'transcribe' }),
        );
      }
      let fresh = await api.get(project!.id);
      // A positional insert is an append followed by a reorder: the server only
      // knows how to add at the end, so slot the new id into place ourselves.
      const newId = clipsOf(fresh)
        .map((c) => c.id)
        .find((id) => !before.includes(id));
      if (newId && atIndex != null && atIndex < before.length) {
        const order = before.slice();
        order.splice(atIndex, 0, newId);
        await api.reorderClips(project!.id, order);
        fresh = await api.get(project!.id);
      }
      setProject(fresh);
      openTranscript(fresh, editDefaults(caps));
      setResult(null);
      setLibrary(await api.list());

      // The on-import chain applies here too, but only its filler step, and only
      // over the clip that just arrived. The rest are DOCUMENT settings — pauses,
      // speed, the enhancer, captions — which this project already decided when it
      // was imported; re-asserting them would quietly overrule any change made
      // since. Adding footage is not permission to reset the edit.
      if (autoImport.fillers && newId && jobId) {
        const done = runImportChain({
          fillers: { includeDiscourseMarkers: false, customWords: customFillers },
          fillersInClipId: newId,
          maxGapMs: null,
          speed: null,
          studioSound: null,
          captions: null,
        });
        if (done.fillers > 0) setNotice(`Clip added — ${done.applied.join(', ')} from it.`);
      }
      return fresh;
    }).finally(() => setJob(null));

  /** Remove a clip from the open project. Refused server-side if it is the last. */
  const removeClip = (clipId: string) =>
    run('removeClip', async () => {
      flushSave();
      await api.removeClip(project!.id, clipId);
      const fresh = await api.get(project!.id);
      setProject(fresh);
      openTranscript(fresh, editDefaults(caps));
      setResult(null);
      return fresh;
    });

  /** Move a clip one place earlier (-1) or later (+1) in play order. */
  const moveClip = (clipId: string, delta: -1 | 1) =>
    run('reorderClip', async () => {
      flushSave();
      const ids = clips.map((c) => c.id);
      const from = ids.indexOf(clipId);
      const to = from + delta;
      if (from < 0 || to < 0 || to >= ids.length) return project!;
      [ids[from], ids[to]] = [ids[to], ids[from]];
      await api.reorderClips(project!.id, ids);
      const fresh = await api.get(project!.id);
      setProject(fresh);
      openTranscript(fresh, editDefaults(caps));
      setResult(null);
      return fresh;
    });

  /**
   * Cut the clip under the playhead in two, at the playhead — the razor. The two
   * pieces become independent clips (reorder, remove, add between). Instant and
   * non-destructive: the halves share the one source file. Refused at the very
   * edge of a clip, where there is nothing to cut off.
   */
  const splitAtPlayhead = () => {
    const t = getCurrentTime();
    const clip = clips.find((c) => t >= c.offset && t < c.offset + c.duration) ?? activeClip;
    if (!clip) return;
    const at = t - clip.offset;
    if (at <= 0.2 || at >= clip.duration - 0.2) {
      setNotice('Move the playhead into a clip, away from its edges, to split it.');
      return;
    }
    void run('splitClip', async () => {
      flushSave();
      await api.splitClip(project!.id, clip.id, at);
      const fresh = await api.get(project!.id);
      setProject(fresh);
      openTranscript(fresh, editDefaults(caps));
      setResult(null);
      setNotice('Clip split. The two pieces are now separate clips.');
      return fresh;
    });
  };
  // The global keydown effect below subscribes on a small dep set, so it would
  // otherwise close over a stale splitAtPlayhead (which reads clips/project). A
  // ref keeps the shortcut calling the current one without re-subscribing.
  const splitRef = useRef(splitAtPlayhead);
  splitRef.current = splitAtPlayhead;

  // --- fonts (global, shared across projects) ---------------------------------
  //
  // Its own busy flag, not `run`'s: importing a font must not read as the app
  // being busy, and it leaves the current selection and document untouched. The
  // returned entry replaces any font of the same family in place, so re-importing
  // an updated cut of a face just refreshes it.
  const importFont = async (file: File) => {
    setFontBusy(true);
    setError(null);
    try {
      const font = await api.fonts.upload(file);
      setCustomFonts((prev) => {
        const rest = prev.filter((f) => f.id !== font.id);
        return [...rest, font].sort((a, b) => a.label.localeCompare(b.label));
      });
      setNotice(`Imported “${font.label}”. It is available on every project.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setFontBusy(false);
    }
  };

  const removeFont = async (id: string) => {
    setFontBusy(true);
    setError(null);
    try {
      await api.fonts.remove(id);
      setCustomFonts((prev) => prev.filter((f) => f.id !== id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setFontBusy(false);
    }
  };

  // --- background music (per project) -----------------------------------------
  //
  // Its own busy flag rather than `run`'s, exactly like fonts: importing a bed is
  // not the app being "busy", and it must not touch the selection or the doc.
  // volume/length changes are optimistic on the project, then persisted debounced
  // — a slider drag would otherwise fire a PATCH per pixel.
  const importMusic = async (file: File) => {
    if (!project) return;
    setMusicBusy(true);
    setError(null);
    try {
      const p = await api.music.upload(project.id, file);
      setProject((cur) => (cur?.id === p.id ? p : cur));
      setNotice(`Added “${file.name}” as background music.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setMusicBusy(false);
    }
  };

  /**
   * Attach a bed found through the picker.
   *
   * Same shape as importMusic, and deliberately so — the difference is only
   * where the bytes come from, and the server does that fetching, so the browser
   * never holds them. Everything after this point cannot tell the two apart.
   */
  const pickMusic = async (track: MusicResult) => {
    if (!project) return;
    setMusicBusy(true);
    setError(null);
    try {
      const p = await api.music.fromUrl(project.id, track);
      setProject((cur) => (cur?.id === p.id ? p : cur));
      setNotice(
        track.attribution
          ? `Added “${track.title}”. Remember to credit ${track.artist} — the line is in the Music panel.`
          : `Added “${track.title}” as background music.`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setMusicBusy(false);
    }
  };

  const removeMusic = async () => {
    if (!project) return;
    setMusicBusy(true);
    setError(null);
    try {
      const p = await api.music.remove(project.id);
      setProject((cur) => (cur?.id === p.id ? p : cur));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setMusicBusy(false);
    }
  };

  // Coalesce rapid patches (a slider emits many) into one server write. The
  // pending patch accumulates FIELDS so a volume drag followed by a length change
  // both land, rather than the later timer clobbering the earlier field.
  type MusicPatch = { volume?: number; durationSec?: number | null; loop?: boolean };
  const pendingMusic = useRef<MusicPatch>({});
  const musicSaveTimer = useRef<number | null>(null);
  const updateMusic = (patch: MusicPatch) => {
    if (!project?.music) return;
    const id = project.id;
    // Optimistic: the panel and the preview read project.music, so reflect the
    // change at once and let the debounced PATCH catch up.
    setProject((cur) => {
      if (!cur?.music) return cur;
      const music = { ...cur.music };
      if (patch.volume !== undefined) music.volume = patch.volume;
      if (patch.loop !== undefined) music.loop = patch.loop;
      if (patch.durationSec !== undefined) {
        if (patch.durationSec === null) delete music.durationSec;
        else music.durationSec = patch.durationSec;
      }
      return { ...cur, music };
    });

    pendingMusic.current = { ...pendingMusic.current, ...patch };
    if (musicSaveTimer.current) window.clearTimeout(musicSaveTimer.current);
    musicSaveTimer.current = window.setTimeout(() => {
      const body = pendingMusic.current;
      pendingMusic.current = {};
      api.music
        .update(id, body)
        .then((p) => setProject((cur) => (cur?.id === p.id ? p : cur)))
        .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    }, 350);
  };

  // Trim/extend the bed by dragging its right edge on the timeline. The handle
  // reports a SOURCE time; convert it to a length on the output clock. keptBefore
  // is the output(1x) time at that source point (gap-safe, unlike sourceToOutput
  // which is null inside a cut); ÷ speed gives the post-speed length the bed and
  // the render both speak. Not looping caps it at the file's own length; looping
  // lets it run to the whole program.
  const resizeMusic = (endSourceSec: number) => {
    if (!project?.music || !edl) return;
    const out1x = keptBefore(edl, endSourceSec);
    const programSec = outputDuration(edl, speed);
    const cap = project.music.loop ? programSec : Math.min(project.music.sourceDuration, programSec);
    const durationSec = Math.min(Math.max(0.1, out1x / speed), cap);
    updateMusic({ durationSec });
  };

  // "Duplicate to fill": loop the track across the whole video. One gesture that
  // turns looping on and clears the length cap so the bed runs the full program.
  const fillMusic = () => updateMusic({ loop: true, durationSec: null });

  const openProject = (id: string) =>
    run('open', async () => {
      const p = await api.get(id);
      setProject(p);
      openTranscript(p, editDefaults(caps));
      setResult(null);
      return p;
    });

  /**
   * Close the project and go back to the grid.
   *
   * flushSave first, and awaited: edits are written on a debounce, so leaving the
   * editor is the one moment where a pending write has nowhere left to land —
   * clearDoc would drop it. Everything after is the reverse of openProject.
   */
  const goHome = async () => {
    await flushSave();
    videoRef.current?.pause();
    clearDoc();
    setProject(null);
    setResult(null);
    setLibOpen(false);
    setDialog(null);
    setError(null);
    setNotice(null);
    api.list().then(setLibrary).catch(() => {});
  };

  /**
   * Delete a project outright — the record and the media file behind it.
   *
   * The one action here with no undo, which is why both callers ask first. If it
   * is the open project, leave the editor BEFORE the request: goHome flushes the
   * debounced save, and a pending write landing on a record the server has just
   * deleted would either 404 into the error strip or, worse, recreate it.
   */
  /**
   * Rename a project, optimistically.
   *
   * The grid updates before the request lands. A rename is one string on a
   * record nothing else is keyed by, so the only failure mode is that it does
   * not stick — and the refresh in the catch puts the old name straight back.
   * Waiting a round trip to redraw a label you just typed is the worse trade.
   */
  const renameProject = async (id: string, name: string) => {
    const clean = name.replace(/\s+/g, ' ').trim();
    const before = library.find((m) => m.id === id);
    if (!clean || !before || clean === before.name) return;

    setLibrary((prev) => prev.map((m) => (m.id === id ? { ...m, name: clean } : m)));
    if (project?.id === id) setProject((p) => (p ? { ...p, name: clean } : p));
    try {
      await api.rename(id, clean);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setLibrary(await api.list().catch(() => library));
    }
  };

  const deleteProject = async (id: string) => {
    if (project?.id === id) await goHome();
    await run('delete', async () => {
      await api.remove(id);
      setLibrary(await api.list());
    });
  };

  /**
   * Build the filmstrip on first open of a video project.
   *
   * Lazy rather than at import because it costs ~8s of ffmpeg (measured on the
   * 885s file), and import should not sit on that. Fire-and-forget and silent on
   * failure: no strip degrades the timeline to a waveform, which is exactly what
   * it was before — it must never block the editor or raise an error banner.
   */
  useEffect(() => {
    const id = project?.id;
    if (!id || !project?.hasVideo || project.thumbs) return;

    let live = true;
    // Guard the write on the id: an 8s job easily outlives the user clicking
    // another project, and the strip belongs to the one that asked for it.
    const apply = (thumbs: Thumbs) =>
      live && setProject((p) => (p && p.id === id ? { ...p, thumbs } : p));

    void (async () => {
      try {
        const res = await api.thumbs(id);
        if (res.thumbs) return apply(res.thumbs);
        if (res.jobId) apply(await waitForJob<Thumbs>(res.jobId, () => {}));
      } catch {
        // No filmstrip. The waveform is still a timeline.
      }
    })();

    return () => { live = false; };
  }, [project?.id, project?.hasVideo, project?.thumbs]);

  // --- stages ------------------------------------------------------------------
  const doTranscribe = () =>
    run('transcribe', async () => {
      const { jobId } = await api.transcribe(project!.id, asr!);
      setJob({ id: jobId, progress: -1, stage: 'Starting', kind: 'transcribe' });

      await waitForJob(jobId, (j) =>
        setJob({ id: jobId, progress: j.progress, stage: j.stage, kind: 'transcribe' }),
      );

      // The job returns an id, not the project: a 485KB payload has no business
      // in a record polled twice a second.
      const p = await api.get(project!.id);
      setProject(p);
      openTranscript(p, editDefaults(caps));
      setResult(null);
      setDialog(null);
      setLibrary(await api.list());
      // The verbatim warning is not a toast — it lives in the rail next to the
      // filler tool it is about, where you can act on it.
      return p;
    }).finally(() => setJob(null));

  const doCaptions = (format: string) =>
    run('captions', async () => {
      // speed rides along: a sidecar file is read against the RENDERED clock, so
      // its cues have to be divided the way the render's are.
      const r = await api.captions(project!.id, { format, ...cut, speed });
      const blob = new Blob([r.content], { type: 'text/plain' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${project!.name.replace(/\.[^.]+$/, '')}.${format}`;
      a.click();
      URL.revokeObjectURL(a.href);
      setNotice(`${r.cues} caption cues, timed to the edit.`);
      return r;
    });

  const doRender = () =>
    run('render', async () => {
      // The server renders from ITS copy of the deleted set, so make sure the
      // edit has landed before asking for pixels.
      flushSave();
      const { jobId } = await api.render(project!.id, {
        ...cut!,
        burnCaptions: captions.enabled,
        captions,
        speed,
        // The bed's live settings ride along too, so an Export fired mid-debounce
        // still uses the volume/length on screen rather than the last saved ones.
        music: {
          enabled: project?.music ? true : false,
          volume: pendingMusic.current?.volume ?? project?.music?.volume ?? 1,
          durationSec: pendingMusic.current?.durationSec ?? project?.music?.durationSec ?? null,
          loop: pendingMusic.current?.loop ?? project?.music?.loop ?? false,
        },
        studioSound: doc?.studioSound ?? project?.studioSound ?? false,
        // Same reason as captions and speed above: an Export fired mid-debounce
        // must reframe to the crop on screen, not to the last one that saved.
        frame: doc?.frame ?? project?.frame,
        // …and grade to the look on screen, for the same reason.
        color: doc?.color ?? project?.color,
      });
      setJob({ id: jobId, progress: -1, stage: 'Starting', kind: 'render' });

      const r = await waitForJob<RenderResult>(jobId, (j) =>
        setJob({ id: jobId, progress: j.progress, stage: j.stage, kind: 'render' }),
      );

      setResult(r);
      setDialog(null);
      // Offer the save without being asked. A render is a terminal act — the
      // user came here to get a file out, and making them find a link
      // afterwards is a step that exists only because we did not take it.
      // The link in the monitor stays, for saving a second copy.
      saveAs(r.url, renderFilename(project!, r));
      setNotice(
        r.captionsSkipped
          ? 'Rendered without captions — this project is audio only, so there is no picture to burn them onto.'
          : `Rendered ${fmtShort(r.outputDuration)} in ${r.renderMs}ms — choose where to save it.`,
      );
      return r;
    }).finally(() => setJob(null));

  // --- playback ----------------------------------------------------------------

  // Live clips for the imperative seek/swap paths, without re-subscribing.
  const clipsRef = useRef<Clip[]>([]);
  clipsRef.current = clips;

  // A seek waiting on a clip's media to load. The swap sets the element's src via
  // activeClipId (React), then this lands the local time once the file is ready.
  const pendingSeekRef = useRef<{ clipId: string; local: number; resume: boolean } | null>(null);

  /**
   * Move the playhead to GLOBAL time `t`, swapping the loaded clip if `t` lives
   * in another one. Same-clip is an immediate local seek; cross-clip defers the
   * seek until the new src reports ready (see the effect below). A single-clip
   * project only ever takes the same-clip branch.
   */
  const requestClipSeek = useCallback((t: number, resume: boolean) => {
    const video = videoRef.current;
    if (!video) return;
    const list = clipsRef.current;
    const clip =
      list.find((c) => t >= c.offset && t < c.offset + c.duration) ?? list[list.length - 1] ?? null;
    if (!clip) {
      video.currentTime = t;
      if (resume) void video.play();
      return;
    }
    const local = clipLocalTime(clip, t);
    if (clip.id === activeClipRef.current?.id) {
      video.currentTime = local;
      if (resume) void video.play();
      return;
    }
    pendingSeekRef.current = { clipId: clip.id, local, resume };
    setActiveClipId(clip.id);
  }, []);

  // Land a pending cross-clip seek once its media is loaded. activeClipId changing
  // has already swapped the element's src (via Monitor); here we wait for the new
  // file to know its timeline, then seek into it and resume if we were playing.
  useEffect(() => {
    const video = videoRef.current;
    const pending = pendingSeekRef.current;
    if (!video || !pending || pending.clipId !== activeClipId) return;

    const apply = () => {
      if (pendingSeekRef.current !== pending) return;
      video.currentTime = pending.local;
      if (pending.resume) void video.play();
      pendingSeekRef.current = null;
    };
    if (video.readyState >= 1) apply();
    else video.addEventListener('loadedmetadata', apply, { once: true });
    return () => video.removeEventListener('loadedmetadata', apply);
  }, [activeClipId]);

  const seek = useCallback(
    (t: number) => {
      requestClipSeek(t, false);
      setCurrentTime(t);
    },
    [requestClipSeek],
  );

  /**
   * Play just the selected words, then stop at the end of them. Defined here,
   * after the seek coordinator, because it references requestClipSeek — its
   * dependency array would otherwise touch that const in its temporal dead zone.
   */
  const playSelection = useCallback(() => {
    if (!selectionRange) return;
    // Global start; requestClipSeek loads the right clip and plays. The stop test
    // reads the global clock too, so it holds whichever clip is showing.
    requestClipSeek(selectionRange.start, true);

    const stopAt = selectionRange.end;
    const tick = () => {
      const video = videoRef.current;
      if (!video || video.paused) return;
      if (getCurrentTime() >= stopAt) return video.pause();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, [selectionRange, requestClipSeek, getCurrentTime]);

  // timeupdate now only feeds the karaoke highlight (~4Hz is plenty — words
  // average ~400ms). Skipping cut material is usePlayback's job, on rAF.
  const onTimeUpdate = () => {
    if (videoRef.current) setCurrentTime(getCurrentTime());
  };

  // ── push-ins ───────────────────────────────────────────────────────────────
  //
  // Two pieces of view state, and neither belongs in the document: which move is
  // being marked (a modal gesture, not an edit) and which is being followed (a
  // job in flight). Everything a move IS lives on doc.frame.moves and undoes with
  // the rest of the edit.

  const [markingMoveId, setMarkingMoveId] = useState<string | null>(null);
  const [following, setFollowing] = useState<{ id: string; progress: number } | null>(null);
  const followAbort = useRef<AbortController | null>(null);

  /**
   * Why the selection cannot take a push-in, or null when it can.
   *
   * Computed rather than left to the button being dead, because "nothing
   * happens" is the least useful thing an interface can say. Overlap is the only
   * real refusal — normalizeMoves drops overlapping moves rather than blending
   * them, so offering one here would silently discard it on the next save.
   */
  const punchBlocked = useMemo(() => {
    if (!selectionRange) return 'Select the words this push-in should cover.';
    if (selectionRange.end - selectionRange.start < MIN_MOVE_SEC) {
      return 'Too short to push in on — select a little more.';
    }
    const clash = frame.moves.some(
      (m) => selectionRange.start < m.end && m.start < selectionRange.end,
    );
    return clash ? 'A push-in already covers part of this selection.' : null;
  }, [selectionRange, frame.moves]);

  /**
   * Mark a stretch, then hand straight over to the marquee.
   *
   * The playhead moves to the move's start first, and that is not a nicety: the
   * template the tracker hunts for is taken from the frame that is on screen
   * when the box is drawn, so marking against some unrelated moment produces a
   * follow that looks for something which is not there.
   */
  const punchInOnSelection = useCallback(() => {
    if (!selectionRange || punchBlocked) return;
    const id = addPunchIn(selectionRange.start, selectionRange.end);
    if (!id) return;
    seek(selectionRange.start);
    setMarkingMoveId(id);
  }, [selectionRange, punchBlocked, seek]);

  const markMove = useCallback(
    (id: string) => {
      const move = frame.moves.find((m) => m.id === id);
      if (move) seek(move.start);
      setMarkingMoveId(id);
    },
    [frame.moves, seek],
  );

  /**
   * A box was dragged over the picture: that is the shot.
   *
   * boxToPunch turns it into the zoom and pan the frame will hold, and a mark
   * always CLEARS any existing follow — the path was tracked from a template
   * taken at the old box, so keeping it would leave the move following something
   * the user just told it not to look at.
   */
  const applyMark = useCallback((id: string, box: FrameBox) => {
    setMarkingMoveId(null);
    const punch = boxToPunch(box);
    // The mark is kept alongside the shot it resolved to: the tracker wants the
    // rectangle that was actually drawn, not the wider window the frame's aspect
    // turned it into. See FrameMove.mark.
    setMove(id, { ...punch, mark: box, path: [] }, 'Mark push-in');
  }, []);

  const followMove = useCallback(
    async (id: string) => {
      const video = videoRef.current;
      const move = frame.moves.find((m) => m.id === id);
      const clip = activeClipRef.current;
      if (!video || !move || !project) return;

      // The follow reads one file. A move that spans a seam would need the app's
      // clip-swap coordinator inside the sample loop, which is a real feature and
      // not this one — say so rather than tracking the wrong footage.
      if (clip && (move.start < clip.offset || move.end > clip.offset + clip.duration)) {
        setNotice('That push-in crosses a clip boundary, which tracking cannot follow yet.');
        return;
      }

      const source = {
        width: clip?.width ?? project.width ?? 0,
        height: clip?.height ?? project.height ?? 0,
      };
      // Against a UNIT box, so the follow depends on the crop and not on how big
      // the monitor happened to be when it ran.
      const layout = frameLayout(frame, source, { width: 1, height: 1 });

      const abort = new AbortController();
      followAbort.current = abort;
      setFollowing({ id, progress: 0 });
      try {
        const result = await followObject({
          video,
          start: move.start,
          end: move.end,
          toLocal: (t) => (clip ? clipLocalTime(clip, t) : t),
          // The rectangle that was drawn, when there is one. Falling back to the
          // delivered window is the best available answer for a move framed with
          // the sliders instead — see FrameMove.mark.
          box: move.mark ?? punchToBox(move),
          layout,
          zoom: move.zoom,
          signal: abort.signal,
          onProgress: (progress) => setFollowing((f) => (f?.id === id ? { id, progress } : f)),
        });
        setMovePath(id, result.path);
        // The quality of a follow is how often it had nothing to go on, and that
        // is worth saying: a follow that held half its samples is pointing at
        // whatever was last recognised, which the user can see but not diagnose.
        setNotice(
          result.lost === 0
            ? `Following — ${result.samples} points.`
            : `Following, but lost the subject on ${result.lost} of ${result.samples} points. Mark it again on a clearer frame if it drifts.`,
        );
      } catch (err) {
        if (!(err instanceof FollowAborted)) {
          setNotice(err instanceof Error ? err.message : String(err));
        }
      } finally {
        followAbort.current = null;
        setFollowing(null);
      }
    },
    [frame, project],
  );

  // A follow in flight owns the <video>'s playhead, so it must not outlive the
  // project it was started on.
  useEffect(() => () => followAbort.current?.abort(), [project?.id]);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.paused ? video.play() : video.pause();
  }, []);

  const onPlaybackEnded = useCallback(() => setPlaying(false), []);

  // Declared after onPlaybackEnded on purpose: a const is in its temporal dead
  // zone until its initialiser runs, so calling this above would throw.
  usePlayback({
    videoRef,
    edl,
    followEdit,
    playing,
    speed,
    onEnded: onPlaybackEnded,
    activeClipRef,
    activeClipId,
    seekAcrossClip: requestClipSeek,
  });

  // The music bed's length on the OUTPUT clock: the shortest of any length the
  // user set, the music file itself, and the program — the same three-way cap the
  // server resolves for the render, so the preview ends where the export does.
  const musicEndSec = useMemo(() => {
    const m = project?.music;
    if (!m || !edl) return 0;
    const outLen = outputDuration(edl, speed);
    // Looping lets the bed run to the program length; otherwise the file's own
    // length caps it. Mirrors the server's render resolve.
    const fileCap = m.loop ? outLen : m.sourceDuration;
    return Math.min(m.durationSec ?? outLen, fileCap, outLen);
  }, [project?.music, edl, speed]);

  useMusicPreview({
    musicRef,
    edl,
    playing,
    speed,
    getCurrentTime,
    volume: project?.music?.volume ?? 0,
    endSec: musicEndSec,
    loop: Boolean(project?.music?.loop),
    sourceDuration: project?.music?.sourceDuration ?? 0,
  });

  // The voice enhancer on the monitor. Deliberately on the <video> only: the bed
  // has its own element and the render mixes it in AFTER the chain, so leaving it
  // out here is what makes the preview match.
  useStudioSoundPreview({ videoRef, enabled: doc?.studioSound ?? false });

  // The bed drawn as a lane on the timeline. The timeline is SOURCE time and the
  // bed lives on the OUTPUT clock, so map its end back: musicEndSec is post-speed,
  // so × speed gives the un-sped output position, which outputToSource turns into
  // the source time where the bed stops. It spans from the first kept moment
  // (output 0) to there — covering the cut gaps in between, which is honest: the
  // music plays straight through them in the finished cut.
  const musicLane = useMemo(() => {
    const m = project?.music;
    if (!m || !edl || edl.keep.length === 0 || musicEndSec <= 0) return null;
    const sum = outputDuration(edl, 1); // un-sped output length
    const endOut = Math.min(musicEndSec * speed, sum);
    const startSec = edl.keep[0].start;
    const endSec =
      endOut >= sum - 1e-6
        ? edl.keep[edl.keep.length - 1].end
        : outputToSource(edl, endOut) ?? edl.keep[edl.keep.length - 1].end;
    return { name: m.name, startSec, endSec, loop: Boolean(m.loop) };
  }, [project?.music, edl, musicEndSec, speed]);

  /**
   * Step to the previous/next word boundary.
   *
   * NOT "one frame". The document has no frames — the EDL is word-bounded and
   * carries float seconds, so a frame step would be a fiction that lands
   * somewhere the editor cannot act on. The word is this app's atomic unit, and
   * it is the more useful step anyway.
   */
  const stepWord = useCallback(
    (direction: -1 | 1) => {
      const video = videoRef.current;
      if (!video || words.length === 0) return;
      const now = getCurrentTime();
      const i = lastStartingAtOrBefore(words, now);

      if (direction === 1) {
        const next = words.find((w) => w.start > now + 1e-3);
        if (next) seek(next.start);
        return;
      }
      // Going back from mid-word lands on this word's start; pressing again on
      // the previous one — the behaviour every editor has.
      const current = words[i];
      if (current && now - current.start > 0.15) return seek(current.start);
      if (i > 0) seek(words[i - 1].start);
    },
    [words, seek, getCurrentTime],
  );

  // Undo/redo reveal: scroll the change into view and, when paused, seek to it.
  // Without this a sweep's undo restores words somewhere off-screen and the app
  // looks like it did nothing.
  useEffect(() => {
    if (!reveal) return;
    const el = document.querySelector<HTMLElement>(`[data-wid="${cssEscape(reveal.id)}"]`);
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const word = words.find((w) => w.id === reveal.id);
    if (reveal.seek && word && videoRef.current?.paused) seek(word.start);
  }, [reveal?.nonce]);

  // --- editing -----------------------------------------------------------------
  /**
   * Clicking a word always means "put the playhead here". What changes is the
   * selection: the word you clicked, extended from the anchor on shift — or
   * nothing at all, if that word was already the whole selection.
   *
   * That last case is the toggle. Without it a selection could only be cleared
   * with Escape or by hitting a paragraph gap, so one you made by accident just
   * sat there. The seek stays either way, which keeps the rule above true: the
   * highlight goes away, the playhead still lands where you pointed.
   */
  const clickWord = (index: number, shift: boolean, clicks: number) => {
    const word = words[index];
    if (!word) return;

    if (shift && selection) {
      setSelection({ anchorId: selection.anchorId, focusId: word.id });
      return;
    }

    // Only when this word IS the selection, not merely inside it — clicking
    // one word of a run collapses onto it, the way any text editor does, and a
    // second click then clears.
    //
    // `clicks === 1` keeps the second half of a double-click out of this. That
    // gesture means "play from here", and it would otherwise select on click
    // one and unselect on click two, flickering on its way to playing.
    const isWholeSelection =
      selection?.anchorId === word.id && selection?.focusId === word.id;

    setSelection(isWholeSelection && clicks === 1 ? null : { anchorId: word.id, focusId: word.id });
    seek(word.start);
  };

  const doFillers = () => {
    const n = removeFillers(fillerMode === 'all', customFillers);
    setResult(null);
    setNotice(n === 0 ? 'No filler words found to cut.' : `${n} filler words cut.`);
  };

  // Normalize on the way in so the chip matches what the detector matches:
  // trimmed, lowercased, no duplicates, no blanks. A pasted "Um, " becomes "um".
  const addCustomFiller = (raw: string) => {
    const word = raw.trim().toLowerCase();
    if (!word) return;
    setCustomFillers((prev) => (prev.includes(word) ? prev : [...prev, word]));
  };

  const removeCustomFiller = (word: string) => {
    setCustomFillers((prev) => prev.filter((w) => w !== word));
  };

  const doRetakes = () => {
    const n = removeRetakes(retakeMin);
    setResult(null);
    setNotice(n === 0 ? 'No retakes found.' : `${n} words cut.`);
  };

  const doRestoreAll = () => {
    const n = restoreAll();
    setResult(null);
    setNotice(n === 0 ? 'Nothing was cut.' : `${n} words restored.`);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // activeElement, not e.target: a key pressed while focus sits in a field
      // can retarget, and the old check missed textarea and contentEditable
      // entirely.
      if (document.activeElement?.closest('input,textarea,select,[contenteditable]')) return;

      const mod = e.metaKey || e.ctrlKey;

      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        const label = e.shiftKey ? redoEdit() : undoEdit();
        if (label) setNotice(`${e.shiftKey ? 'Redid' : 'Undid'}: ${label}`);
        return;
      }
      if (mod && e.key.toLowerCase() === 'y') { // Windows redo
        e.preventDefault();
        const label = redoEdit();
        if (label) setNotice(`Redid: ${label}`);
        return;
      }
      if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); flushSave(); return; }

      if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); setSelectionDeleted(true); }
      else if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); setSelectionDeleted(false); }
      // Escape closes the drawer first if it's open, otherwise clears selection.
      else if (e.key === 'Escape') { if (libOpen) setLibOpen(false); else setSelection(null); }
      else if (e.key === ' ') { e.preventDefault(); togglePlay(); }
      // The razor: cut the clip under the playhead in two. Bare S, like an NLE.
      else if (!mod && e.key.toLowerCase() === 's') { e.preventDefault(); splitRef.current(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePlay, libOpen]);

  if (!caps || !asr) return <div className="boot">Loading workspace…</div>;

  // --- the start screen ---------------------------------------------------------
  /**
   * With nothing open, the app IS the project grid — not the workspace with its
   * five columns greyed out around a line of text. The editor is a view onto a
   * document; with no document there is nothing for it to be a view onto.
   *
   * Every hook above still runs, so this early return is a rendering choice and
   * not a second app: opening a project from here flips it back with all the
   * state — capabilities, fonts, the on-import chain — already in place.
   */
  if (!project) {
    return (
      <Dashboard
        projects={library}
        importing={busy === 'import'}
        progress={job?.progress ?? null}
        opening={busy === 'open'}
        onOpen={(id) => void openProject(id)}
        onDelete={(id) => void deleteProject(id)}
        onRename={(id, name) => void renameProject(id, name)}
        onImport={importFile}
        error={error}
        onDismissError={() => setError(null)}
      />
    );
  }

  // --- workspace ---------------------------------------------------------------
  return (
    <div
      className="app"
      // Give the dock the extra height the music lane needs, rather than stealing
      // it from the waveform. Only when a bed is attached; no bed, no change.
      style={musicLane ? ({ '--h-dock': '298px' } as React.CSSProperties) : undefined}
    >
      <TitleBar
        name={project?.name ?? null}
        saveStatus={saveStatus}
        onRetrySave={retrySave}
        onToggleLibrary={() => setLibOpen((v) => !v)}
        onHome={() => void goHome()}
        canUndo={history.canUndo}
        canRedo={history.canRedo}
        undoLabel={history.undoLabel}
        redoLabel={history.redoLabel}
        onUndo={() => { const l = undoEdit(); if (l) setNotice(`Undid: ${l}`); }}
        onRedo={() => { const l = redoEdit(); if (l) setNotice(`Redid: ${l}`); }}
        stats={doc ? stats : null}
        onExport={() => setDialog('export')}
        canExport={!!doc}
        exporting={busy === 'render'}
      />

      {/* ---- the open project's clips + speakers: a drawer behind the ☰ ----
        * No longer the media library. Every project lives on the Dashboard, at a
        * size worth looking at; this is about the one you have open. */}
      <Library
        speakers={cast}
        hasScript={!!doc}
        clips={clips}
        activeClipId={activeClip?.id ?? null}
        addingClip={busy === 'addClip'}
        onAddClip={addClip}
        onRemoveClip={removeClip}
        onMoveClip={moveClip}
        onSelectClip={(c) => seek(c.offset)}
        open={libOpen}
        onClose={() => setLibOpen(false)}
        onSeek={seek}
        autoImport={autoImport}
        onAutoImport={setAutoImport}
        canTranscribe={!!caps?.hasAsr}
      />

      {/* ---- the transcript: the left column, the surface you edit on ---- */}
      <main
        className="script"
        // A press anywhere on the surface that isn't a word clears the
        // selection — the whole scroll area, not just the 640px text column.
        // Words keep their own selection via onWordClick; the drag gesture
        // presses on a word too, so its mousedown is caught by closest('.w').
        // Guarded on `selection` so an ordinary click on empty space doesn't
        // churn the store when there's nothing to clear.
        onMouseDown={(e) => {
          if (selection && !(e.target as HTMLElement).closest('.w')) setSelection(null);
        }}
      >
        {error && <p className="error" onClick={() => setError(null)}>{error}</p>}
        {notice && !error && <p className="notice" onClick={() => setNotice(null)}>{notice}</p>}

        {/* No "nothing open" state here any more: with no project the app renders
          * the Dashboard instead of this workspace, so `project` is non-null from
          * here down. */}
        {project && !doc && (
          <div className="canvas-empty">
            <h2>{project.name}</h2>
            <p>
              {clock(project.duration)} · {project.hasVideo ? `${project.width}×${project.height}` : 'audio only'}
            </p>
            <p className="sub">
              No script yet. Choose your settings in the Transcribe panel and run it.
            </p>
          </div>
        )}

        {doc && project && (
          <Script
            transcript={{ mediaId: project.id, duration: project.duration, words }}
            selection={selectedSet}
            flash={flashSet}
            playingIndex={playingIndex}
            showDeleted={showDeleted}
            colors={castColors}
            onWordClick={clickWord}
            onCorrectWord={correctText}
            onSelectRange={(anchorId, focusId) => setSelection({ anchorId, focusId })}
            onRetranscribe={() => setDialog('transcribe')}
          />
        )}
      </main>

        <Splitter className="sp1" variable="--w-script" min={300} max={640} initial={440} side="left" />

        {/* ---- the program monitor holds the centre stage ---- */}
        <Monitor
          ref={videoRef}
          project={project}
          activeClip={activeClip}
          result={result}
          onTimeUpdate={onTimeUpdate}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          frame={frame}
          frameRef={frameRef}
          onFrameChange={updateFrame}
          onFrameDragStart={beginFrameDrag}
          onFrameDragEnd={endFrameDrag}
          color={color}
          getCurrentTime={getCurrentTime}
          markingMoveId={markingMoveId}
          onMark={applyMark}
          onMarkCancel={() => setMarkingMoveId(null)}
          overlay={
            project?.hasVideo ? (
              <CaptionOverlay
                videoRef={videoRef}
                frameRef={frameRef}
                words={words}
                edl={edl}
                captions={captions}
                customFamilies={customFonts.map((f) => f.family)}
                playing={playing}
                getCurrentTime={getCurrentTime}
                onDragStart={beginCaptionDrag}
                onMove={(x, y) => updateCaptions({ ...captions, x, y })}
                onResize={(boxWidth, boxHeight) =>
                  updateCaptions({ ...captions, boxWidth, boxHeight })
                }
                onDragEnd={endCaptionDrag}
              />
            ) : null
          }
        />

        {/* The music bed, played on the output clock by useMusicPreview. Hidden
          * and controlled entirely in code — the dock transport is the only
          * transport. Keyed on the music id so swapping the bed reloads the src. */}
        <audio
          ref={musicRef}
          key={project?.music?.id ?? 'no-music'}
          src={project?.music?.sourceUrl}
          preload="auto"
          hidden
        />

        <Splitter className="sp2" variable="--w-rail" min={300} max={560} initial={372} side="right" />

        {/* ---- the inspector for whatever is selected: the full-height right column ---- */}
        <Rail
            project={project}
            hasScript={!!doc}
            selectedWords={selectedWords}
            stats={stats}
            verbatim={project?.verbatim ?? true}
            asrProvider={project?.asrProvider ?? null}
            cut={cut ?? editDefaults(caps)}
            setCut={updateCut}
            onCutDragStart={beginCutDrag}
            onCutDragEnd={endCutDrag}
            captions={captions}
            setCaptions={updateCaptions}
            onCaptionDragStart={beginCaptionDrag}
            onCaptionDragEnd={endCaptionDrag}
            studioSound={doc?.studioSound ?? false}
            onToggleStudioSound={updateStudioSound}
            frame={frame}
            setFrame={updateFrame}
            onFrameDragStart={beginFrameDrag}
            onFrameDragEnd={endFrameDrag}
            onPunchIn={punchInOnSelection}
            punchBlocked={punchBlocked}
            onMarkMove={markMove}
            onRemoveMove={deletePunchIn}
            onSetMove={setMove}
            onFollowMove={followMove}
            onClearFollow={(id) => setMovePath(id, [])}
            markingMoveId={markingMoveId}
            following={following}
            onSeek={seek}
            color={color}
            setColor={updateColor}
            onColorDragStart={beginColorDrag}
            onColorDragEnd={endColorDrag}
            customFonts={customFonts}
            onImportFont={importFont}
            onRemoveFont={removeFont}
            fontBusy={fontBusy}
            onImportMusic={importMusic}
            onPickMusic={pickMusic}
            musicProviders={caps.musicProviders ?? ['openverse']}
            onUpdateMusic={updateMusic}
            onRemoveMusic={removeMusic}
            musicBusy={musicBusy}
            fillerMode={fillerMode}
            setFillerMode={setFillerMode}
            customFillers={customFillers}
            onAddCustomFiller={addCustomFiller}
            onRemoveCustomFiller={removeCustomFiller}
            retakeMin={retakeMin}
            setRetakeMin={setRetakeMin}
            fillerCount={doc ? countFillers(fillerMode === 'all', customFillers) : 0}
            retakeCount={doc ? countRetakes(retakeMin) : 0}
            onRemoveFillers={doFillers}
            onRemoveRetakes={doRetakes}
            onRestoreAll={doRestoreAll}
            onRetranscribe={() => setDialog('transcribe')}
            onTranscribe={() => setDialog('transcribe')}
            onDeleteSelection={() => setSelectionDeleted(true)}
            onRestoreSelection={() => setSelectionDeleted(false)}
            onPlaySelection={playSelection}
            busy={busy}
          />

      <footer className="tl">
        <Transport
          getCurrentTime={getCurrentTime}
          duration={project?.duration ?? 0}
          edl={edl}
          playing={playing}
          followEdit={followEdit}
          setFollowEdit={setFollowEdit}
          showDeleted={showDeleted}
          setShowDeleted={setShowDeleted}
          speed={speed}
          setSpeed={updateSpeed}
          onPlayPause={togglePlay}
          onStep={stepWord}
          onHome={() => seek(0)}
          disabled={!project}
        />
        <Timeline
          peaks={project?.peaks ?? []}
          duration={project?.duration ?? 0}
          edl={edl}
          thumbs={project?.thumbs}
          getCurrentTime={getCurrentTime}
          playing={playing}
          onSeek={seek}
          selection={selectionRange}
          snapTargets={snapTargets}
          onSelectRange={selectRange}
          insertPoints={clipInsertPoints}
          clipBusy={busy === 'addClip' || busy === 'removeClip' || busy === 'reorderClip' || busy === 'splitClip'}
          onInsertClip={addClip}
          onSplit={project ? splitAtPlayhead : undefined}
          music={musicLane}
          onMusicResize={resizeMusic}
          onMusicFill={fillMusic}
        />
      </footer>

      <TranscribeDialog
        open={dialog === 'transcribe'}
        onClose={() => setDialog(null)}
        project={project}
        caps={caps}
        asr={asr}
        setAsr={setAsr}
        onTranscribe={doTranscribe}
        busy={busy}
        hasScript={!!doc}
        wordCount={stats.words}
        asrProvider={project?.asrProvider ?? null}
        verbatim={project?.verbatim ?? true}
        job={job?.kind === 'transcribe' ? job : null}
        onCancelJob={cancelJob}
      />

      <ExportDialog
        open={dialog === 'export'}
        onClose={() => setDialog(null)}
        project={project}
        stats={stats}
        burnCaptions={captions.enabled}
        setBurnCaptions={(v) => updateCaptions({ ...captions, enabled: v })}
        onRender={doRender}
        onCaptions={doCaptions}
        busy={busy}
        job={job?.kind === 'render' ? job : null}
        onCancelJob={cancelJob}
      />
    </div>
  );
}

/** The server ships defaults; the client used to hardcode over them. */
function editDefaults(caps: Capabilities | null): CutSettings {
  const d = caps?.editDefaults;
  return {
    padMs: d?.padMs ?? 40,
    fadeMs: d?.fadeMs ?? 12,
    mergeWithinMs: d?.mergeWithinMs ?? 20,
    // 0 from the wire means "keep every pause" — Infinity does not survive JSON.
    maxGapMs: d && d.maxGapMs > 0 ? d.maxGapMs : Infinity,
  };
}

function cssEscape(value: string): string {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(value) : value;
}

function clock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function fmtShort(seconds: number): string {
  return seconds >= 60 ? clock(seconds) : `${seconds.toFixed(1)}s`;
}
