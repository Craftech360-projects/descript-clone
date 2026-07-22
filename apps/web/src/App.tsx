import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  waitForJob,
  type Capabilities,
  type JobKind,
  type MediaItem,
  type Project,
  type RenderResult,
  type AsrOptions,
  type Thumbs,
} from './api.ts';
import Script from './Script.tsx';
import Timeline from './Timeline.tsx';
import TitleBar from './shell/TitleBar.tsx';
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
  selectedIds,
  setSaver,
  setSelection,
  setSelectionDeleted,
  undoEdit,
  updateCut,
  updateCaptions,
  updateSpeed,
  beginCaptionDrag,
  endCaptionDrag,
  useEditor,
  flushSave,
} from './store/editor.ts';
import { DEFAULT_CAPTIONS } from '../../../packages/core/src/caption-style.ts';
import CaptionOverlay from './shell/CaptionOverlay.tsx';
import { lastStartingAtOrBefore } from '../../../packages/core/src/paragraphs.ts';
import { speakers, colorMap } from './speakers.ts';
import { usePlayback } from './store/playback.ts';
import { cutFromWire, cutToWire, DEFAULT_SPEED, type CutSettings } from '../../../packages/core/src/doc.ts';
import { compileEdl, outputDuration } from '../../../packages/core/src/edl.ts';
import { wordAt } from '../../../packages/core/src/paragraphs.ts';

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
  const [asr, setAsr] = useState<AsrOptions | null>(null);
  const [fillerMode, setFillerMode] = useState<FillerMode>('hesitations');
  const [retakeMin, setRetakeMin] = useState(2);

  const [showDeleted, setShowDeleted] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [followEdit, setFollowEdit] = useState(true);
  const [result, setResult] = useState<RenderResult | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const { doc, selection, flash, reveal, saveStatus } = useEditor();

  const words = doc?.words ?? [];
  const cut = doc?.cut ?? null;
  const captions = doc?.captions ?? DEFAULT_CAPTIONS;
  const speed = doc?.speed ?? DEFAULT_SPEED;
  const history = historyState();

  useEffect(() => {
    api.capabilities().then((c) => { setCaps(c); setAsr(c.asrDefaults); }).catch((e) => setError(e.message));
    api.list().then(setLibrary).catch(() => {});
  }, []);

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

  const edl = useMemo(
    () => (doc ? compileEdl({ mediaId: '', duration: project?.duration ?? 0, words: doc.words }, doc.cut) : null),
    [doc?.words, doc?.cut, project?.duration],
  );

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
  // prop would re-render the whole app on every animation frame.
  const getCurrentTime = useCallback(() => videoRef.current?.currentTime ?? 0, []);

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

  /** Play just the selected words, then stop at the end of them. */
  const playSelection = useCallback(() => {
    const video = videoRef.current;
    if (!video || !selectionRange) return;
    video.currentTime = selectionRange.start;
    void video.play();

    const stopAt = selectionRange.end;
    const tick = () => {
      if (video.paused) return;
      if (video.currentTime >= stopAt) return video.pause();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, [selectionRange]);

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
    // missing, and each falls back: cutFromWire to the engine defaults, captions
    // to DEFAULT_CAPTIONS, speed (via clampSpeed downstream) to 1.
    if (p.transcript) {
      loadDoc(p.transcript, cutFromWire(p.cut, defaults), p.captions ?? DEFAULT_CAPTIONS, p.speed);
    } else clearDoc();
  };

  // --- library -----------------------------------------------------------------
  const importFile = (file: File) =>
    run('import', async () => {
      const p = await api.import(file);
      setProject(p);
      openTranscript(p, editDefaults(caps));
      setResult(null);
      setLibrary(await api.list());
      // Import does NOT transcribe — that is your call. The rail now offers it
      // in place, so there is no tab to send you to.
      return p;
    });

  const openProject = (id: string) =>
    run('open', async () => {
      const p = await api.get(id);
      setProject(p);
      openTranscript(p, editDefaults(caps));
      setResult(null);
      return p;
    });

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
      });
      setJob({ id: jobId, progress: -1, stage: 'Starting', kind: 'render' });

      const r = await waitForJob<RenderResult>(jobId, (j) =>
        setJob({ id: jobId, progress: j.progress, stage: j.stage, kind: 'render' }),
      );

      setResult(r);
      setDialog(null);
      setNotice(
        r.captionsSkipped
          ? 'Rendered without captions — this project is audio only, so there is no picture to burn them onto.'
          : `Rendered ${fmtShort(r.outputDuration)} in ${r.renderMs}ms.`,
      );
      return r;
    }).finally(() => setJob(null));

  // --- playback ----------------------------------------------------------------
  const seek = useCallback((t: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = t;
    setCurrentTime(t);
  }, []);

  // timeupdate now only feeds the karaoke highlight (~4Hz is plenty — words
  // average ~400ms). Skipping cut material is usePlayback's job, on rAF.
  const onTimeUpdate = () => {
    const video = videoRef.current;
    if (video) setCurrentTime(video.currentTime);
  };

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.paused ? video.play() : video.pause();
  }, []);

  const onPlaybackEnded = useCallback(() => setPlaying(false), []);

  // Declared after onPlaybackEnded on purpose: a const is in its temporal dead
  // zone until its initialiser runs, so calling this above would throw.
  usePlayback({ videoRef, edl, followEdit, playing, speed, onEnded: onPlaybackEnded });

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
      const now = video.currentTime;
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
    [words, seek],
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
    const n = removeFillers(fillerMode === 'all');
    setResult(null);
    setNotice(n === 0 ? 'No filler words found to cut.' : `${n} filler words cut.`);
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
      else if (e.key === 'Escape') setSelection(null);
      else if (e.key === ' ') { e.preventDefault(); togglePlay(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePlay]);

  if (!caps || !asr) return <div className="boot">Loading workspace…</div>;

  // --- workspace ---------------------------------------------------------------
  return (
    <div className="app">
      <TitleBar
        name={project?.name ?? null}
        saveStatus={saveStatus}
        onRetrySave={retrySave}
        canUndo={history.canUndo}
        canRedo={history.canRedo}
        undoLabel={history.undoLabel}
        redoLabel={history.redoLabel}
        onUndo={() => { const l = undoEdit(); if (l) setNotice(`Undid: ${l}`); }}
        onRedo={() => { const l = redoEdit(); if (l) setNotice(`Redid: ${l}`); }}
        hasAsr={caps.hasAsr}
        onExport={() => setDialog('export')}
        canExport={!!doc}
        exporting={busy === 'render'}
      />

      {/* ---- media library + speakers ---- */}
      <Library
        library={library}
        openId={project?.id ?? null}
        speakers={cast}
        hasScript={!!doc}
        importing={busy === 'import'}
        onOpen={openProject}
        onImport={importFile}
        onSeek={seek}
      />

        <Splitter className="sp1" variable="--w-library" min={180} max={320} initial={216} side="left" />

        {/* ---- the program monitor holds the centre stage ---- */}
        <Monitor
          ref={videoRef}
          project={project}
          result={result}
          onTimeUpdate={onTimeUpdate}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          overlay={
            project?.hasVideo ? (
              <CaptionOverlay
                videoRef={videoRef}
                words={words}
                edl={edl}
                captions={captions}
                playing={playing}
                getCurrentTime={getCurrentTime}
                onDragStart={beginCaptionDrag}
                onMove={(x, y) => updateCaptions({ ...captions, x, y })}
                onDragEnd={endCaptionDrag}
              />
            ) : null
          }
        />

        <Splitter className="sp2" variable="--w-rail" min={380} max={860} initial={560} side="right" />

        {/* ---- the document, and the inspector for whatever is selected ---- */}
        <div className="right">
          <main className="script">
            {error && <p className="error" onClick={() => setError(null)}>{error}</p>}
            {notice && !error && <p className="notice" onClick={() => setNotice(null)}>{notice}</p>}

            {!project && (
              <div className="canvas-empty">
                <h2>Nothing open</h2>
                <p>Import media from the left. Nothing is transcribed until you ask for it.</p>
              </div>
            )}

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
                onWordDoubleClick={(i) => { seek(words[i].start); videoRef.current?.play(); }}
                onBackgroundClick={() => setSelection(null)}
              />
            )}
          </main>

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
            fillerMode={fillerMode}
            setFillerMode={setFillerMode}
            retakeMin={retakeMin}
            setRetakeMin={setRetakeMin}
            fillerCount={doc ? countFillers(fillerMode === 'all') : 0}
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
        </div>

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
