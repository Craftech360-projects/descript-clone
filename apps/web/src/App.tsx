import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type Project, type RenderResult, type Word } from './api.ts';
import Script from './Script.tsx';
import Timeline from './Timeline.tsx';

// The SAME compiler the server renders with. Preview and render are literally the
// same function, so they cannot disagree.
import { compileEdl, outputDuration, sourceToOutput } from '../../../packages/core/src/edl.ts';
import { wordAt } from '../../../packages/core/src/paragraphs.ts';

export default function App() {
  const [project, setProject] = useState<Project | null>(null);
  const [peaks, setPeaks] = useState<number[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<number | null>(null);
  const [showDeleted, setShowDeleted] = useState(true);
  const [maxGapMs, setMaxGapMs] = useState(0);

  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [followEdit, setFollowEdit] = useState(true);
  const [result, setResult] = useState<RenderResult | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const words = project?.transcript.words ?? [];

  const edl = useMemo(
    () =>
      project
        ? compileEdl(project.transcript, {
            padMs: 40,
            fadeMs: 12,
            mergeWithinMs: 20,
            maxGapMs: maxGapMs > 0 ? maxGapMs : Infinity,
          })
        : null,
    [project, maxGapMs],
  );

  const playingIndex = useMemo(
    () => (playing ? wordAt(words, currentTime) : -1),
    [playing, words, currentTime],
  );

  // --- playback: the text cursor is the playhead -------------------------------
  const onTimeUpdate = () => {
    const video = videoRef.current;
    if (!video) return;
    setCurrentTime(video.currentTime);

    // "Follow edit" plays the CUT version straight from the source: when the
    // playhead wanders into removed material, jump over it. This is preview
    // without rendering — the thing that makes the edit feel live.
    if (!followEdit || !playing || !edl) return;
    if (sourceToOutput(edl, video.currentTime) !== null) return;

    const next = edl.keep.find((r) => r.start > video.currentTime);
    if (next) video.currentTime = next.start;
    else { video.pause(); setPlaying(false); }
  };

  const seek = (time: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = time;
    setCurrentTime(time);
  };

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) { video.play(); setPlaying(true); }
    else { video.pause(); setPlaying(false); }
  };

  // --- editing -----------------------------------------------------------------
  const mutate = (fn: (words: Word[]) => void) => {
    if (!project) return;
    const next = structuredClone(project);
    fn(next.transcript.words);
    setProject(next);
    setResult(null);
    api
      .setDeleted(next.id, next.transcript.words.filter((w) => w.deleted).map((w) => w.id))
      .catch((e) => setError(e.message));
  };

  const clickWord = (index: number, shift: boolean) => {
    const next = new Set<string>();
    if (shift && anchor !== null) {
      const [lo, hi] = anchor < index ? [anchor, index] : [index, anchor];
      for (let i = lo; i <= hi; i++) next.add(words[i].id);
    } else {
      next.add(words[index].id);
      setAnchor(index);
      seek(words[index].start); // cursor == playhead
    }
    setSelection(next);
  };

  const setSelectionDeleted = useCallback(
    (deleted: boolean) => {
      if (selection.size === 0) return;
      mutate((ws) => ws.forEach((w) => { if (selection.has(w.id)) w.deleted = deleted; }));
      if (deleted) setSelection(new Set());
    },
    [selection, project],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); setSelectionDeleted(true); }
      else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); setSelectionDeleted(false); }
      else if (e.key === 'Escape') setSelection(new Set());
      else if (e.key === ' ' && !(e.target instanceof HTMLInputElement)) { e.preventDefault(); togglePlay(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setSelectionDeleted]);

  // --- server ------------------------------------------------------------------
  const run = async <T,>(label: string, fn: () => Promise<T>) => {
    setBusy(label);
    setError(null);
    try { return await fn(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); return null; }
    finally { setBusy(null); }
  };

  const upload = (file: File) =>
    run('Transcribing…', async () => {
      const p = await api.upload(file);
      setProject(p);
      setSelection(new Set());
      setResult(null);
      api.peaks(p.id).then((r) => setPeaks(r.peaks)).catch(() => {});
      return p;
    });

  const action = (name: 'remove-fillers' | 'remove-retakes' | 'restore-all') =>
    run(name, async () => {
      const r = await api.action(project!.id, name);
      setProject({ ...project!, transcript: r.transcript });
      setResult(null);
      return r;
    });

  const render = () =>
    run('Rendering…', async () => {
      const r = await api.render(project!.id, maxGapMs > 0 ? maxGapMs : undefined);
      setResult(r);
      return r;
    });

  // --- empty state -------------------------------------------------------------
  if (!project) {
    return (
      <div className="start">
        <div className="start-inner">
          <h1>Edit video by editing the words.</h1>
          <p>
            Drop in a recording. You get a script. Delete a sentence from the script and it
            disappears from the video.
          </p>
          <label className="drop">
            <input
              type="file"
              accept="video/*,audio/*"
              onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
            />
            <strong>{busy ?? 'Choose a video or audio file'}</strong>
            <small>{busy ? 'This can take a moment' : 'mp4, mov, mp3, wav…'}</small>
          </label>
          {error && <p className="error">{error}</p>}
        </div>
      </div>
    );
  }

  const kept = words.filter((w) => !w.deleted).length;
  const outSec = edl ? outputDuration(edl) : 0;
  const cut = project.duration - outSec;

  return (
    <div className="app">
      <header className="topbar">
        <div className="file">
          <strong>{project.name}</strong>
          <span>
            {words.length} words · {project.asrProvider}
            {!project.verbatim && (
              <b className="warn" title="Standard ASR normalizes fillers away before you ever see them. Filler removal will find little to nothing until a verbatim model is wired up.">
                not verbatim
              </b>
            )}
          </span>
        </div>

        <div className="transport">
          <button className="play" onClick={togglePlay}>{playing ? '❚❚' : '▶'}</button>
          <span className="clock">{clock(currentTime)} / {clock(project.duration)}</span>
          <label className="check">
            <input type="checkbox" checked={followEdit} onChange={(e) => setFollowEdit(e.target.checked)} />
            Play the edit
          </label>
        </div>

        <div className="out">
          <strong>{clock(outSec)}</strong>
          {cut > 0.05 && <em>−{fmt(cut)} · {edl?.keep.length} cuts</em>}
        </div>
      </header>

      <div className="body">
        <aside className="rail">
          <div className="group">
            <h3>Edit</h3>
            <button onClick={() => action('remove-fillers')} disabled={!!busy}>Remove filler words</button>
            <button onClick={() => action('remove-retakes')} disabled={!!busy}>Remove retakes</button>
            <button onClick={() => action('restore-all')} disabled={!!busy}>Restore everything</button>
          </div>

          <div className="group">
            <h3>Shorten pauses</h3>
            <input
              type="range" min={0} max={2000} step={100}
              value={maxGapMs}
              onChange={(e) => { setMaxGapMs(Number(e.target.value)); setResult(null); }}
            />
            <span className="val">{maxGapMs === 0 ? 'Keep all pauses' : `Cap at ${maxGapMs}ms`}</span>
          </div>

          <div className="group">
            <h3>View</h3>
            <label className="check">
              <input type="checkbox" checked={showDeleted} onChange={(e) => setShowDeleted(e.target.checked)} />
              Show deleted text
            </label>
          </div>

          <div className="group grow" />

          <button className="primary" onClick={render} disabled={!!busy || kept === 0}>
            {busy === 'Rendering…' ? 'Rendering…' : 'Export'}
          </button>
        </aside>

        <main className="script">
          {error && <p className="error">{error}</p>}
          <Script
            transcript={project.transcript}
            selection={selection}
            playingIndex={playingIndex}
            showDeleted={showDeleted}
            onWordClick={clickWord}
            onWordDoubleClick={(i) => { seek(words[i].start); videoRef.current?.play(); setPlaying(true); }}
            onBackgroundClick={() => setSelection(new Set())}
          />
        </main>

        <aside className="preview">
          <video
            ref={videoRef}
            src={project.sourceUrl}
            onTimeUpdate={onTimeUpdate}
            onPause={() => setPlaying(false)}
            onPlay={() => setPlaying(true)}
          />

          {result ? (
            <div className="result">
              <h3>Export ready</h3>
              <p>{fmt(result.outputDuration)} from {fmt(result.sourceDuration)} · {result.segments} segments · {result.renderMs}ms</p>
              <video src={result.url} controls />
              <a href={result.url} download>Download</a>
            </div>
          ) : (
            <p className="hint">
              Click a word to move the playhead. Select and press <kbd>Backspace</kbd> to cut it
              from the video. <kbd>Space</kbd> plays.
            </p>
          )}
        </aside>
      </div>

      <footer className="tl">
        <Timeline
          peaks={peaks}
          duration={project.duration}
          edl={edl}
          currentTime={currentTime}
          onSeek={seek}
        />
      </footer>
    </div>
  );
}

function clock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function fmt(seconds: number): string {
  return seconds >= 60 ? clock(seconds) : `${seconds.toFixed(1)}s`;
}
