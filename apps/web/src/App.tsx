import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type Project, type RenderResult, type Word } from './api.ts';

// The SAME compiler the server renders with. Running it in the browser means the
// preview can never disagree with the final render — they are literally the same
// function, not two implementations of one spec.
import { compileEdl, outputDuration, sourceToOutput } from '../../../packages/core/src/edl.ts';

export default function App() {
  const [project, setProject] = useState<Project | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<number | null>(null);
  const [maxGapMs, setMaxGapMs] = useState<number>(0); // 0 = keep all pauses
  const [result, setResult] = useState<RenderResult | null>(null);
  const [playing, setPlaying] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const words = project?.transcript.words ?? [];

  const edl = useMemo(() => {
    if (!project) return null;
    return compileEdl(project.transcript, {
      padMs: 40,
      fadeMs: 12,
      mergeWithinMs: 20,
      maxGapMs: maxGapMs > 0 ? maxGapMs : Infinity,
    });
  }, [project, maxGapMs]);

  // --- preview playback: skip cut regions live, no render needed ---------------
  const onTimeUpdate = useCallback(() => {
    const video = videoRef.current;
    if (!video || !edl || !playing) return;

    if (sourceToOutput(edl, video.currentTime) !== null) return; // inside kept material

    const next = edl.keep.find((r) => r.start > video.currentTime);
    if (next) {
      video.currentTime = next.start;
    } else {
      video.pause();
      setPlaying(false);
    }
  }, [edl, playing]);

  const playEdit = () => {
    const video = videoRef.current;
    if (!video || !edl || edl.keep.length === 0) return;
    video.currentTime = edl.keep[0].start;
    video.play();
    setPlaying(true);
  };

  // --- editing -----------------------------------------------------------------
  const mutate = (fn: (words: Word[]) => void) => {
    if (!project) return;
    const next = structuredClone(project);
    fn(next.transcript.words);
    setProject(next);
    setResult(null);
    api.setDeleted(
      next.id,
      next.transcript.words.filter((w) => w.deleted).map((w) => w.id),
    ).catch((e) => setError(e.message));
  };

  const clickWord = (index: number, shift: boolean) => {
    const next = new Set<string>();
    if (shift && anchor !== null) {
      const [lo, hi] = anchor < index ? [anchor, index] : [index, anchor];
      for (let i = lo; i <= hi; i++) next.add(words[i].id);
    } else {
      next.add(words[index].id);
      setAnchor(index);
    }
    setSelection(next);
  };

  const deleteSelection = useCallback(() => {
    if (selection.size === 0) return;
    mutate((ws) => ws.forEach((w) => { if (selection.has(w.id)) w.deleted = true; }));
    setSelection(new Set());
  }, [selection, project]);

  const restoreSelection = useCallback(() => {
    if (selection.size === 0) return;
    mutate((ws) => ws.forEach((w) => { if (selection.has(w.id)) w.deleted = false; }));
    setSelection(new Set());
  }, [selection, project]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); deleteSelection(); }
      if (e.key === 'Escape') setSelection(new Set());
      if ((e.metaKey || e.ctrlKey) && e.key === 'z') { e.preventDefault(); restoreSelection(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [deleteSelection, restoreSelection]);

  // --- server actions ----------------------------------------------------------
  const run = async <T,>(label: string, fn: () => Promise<T>): Promise<T | null> => {
    setBusy(label);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setBusy(null);
    }
  };

  const upload = (file: File) =>
    run('Transcribing…', async () => {
      const p = await api.upload(file);
      setProject(p);
      setResult(null);
      setSelection(new Set());
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

  // --- render ------------------------------------------------------------------
  if (!project) {
    return (
      <main className="empty">
        <h1>Transcript Editor</h1>
        <p>Edit video by editing its transcript. Delete a word, and its audio and video go with it.</p>
        <label className="drop">
          <input
            type="file"
            accept="video/*,audio/*"
            onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
          />
          <span>{busy ?? 'Choose a video or audio file'}</span>
        </label>
        {error && <p className="error">{error}</p>}
      </main>
    );
  }

  const kept = words.filter((w) => !w.deleted).length;
  const outSec = edl ? outputDuration(edl) : 0;
  const saved = project.duration - outSec;

  return (
    <main>
      <header>
        <div>
          <h1>{project.name}</h1>
          <p className="meta">
            {words.length} words · {project.asrProvider}
            {!project.verbatim && (
              <span className="warn" title="Standard ASR strips most fillers before you ever see them. Filler removal will find little to nothing until a verbatim model is wired up.">
                {' '}· not verbatim
              </span>
            )}
          </p>
        </div>
        <div className="stats">
          <strong>{fmt(outSec)}</strong>
          <span>from {fmt(project.duration)}</span>
          {saved > 0.05 && <em>−{fmt(saved)} cut · {edl?.keep.length} segments</em>}
        </div>
      </header>

      <nav className="toolbar">
        <button onClick={() => action('remove-fillers')} disabled={!!busy}>Remove fillers</button>
        <button onClick={() => action('remove-retakes')} disabled={!!busy}>Remove retakes</button>
        <button onClick={() => action('restore-all')} disabled={!!busy}>Restore all</button>

        <label className="gap">
          Shorten pauses
          <input
            type="range" min={0} max={2000} step={100}
            value={maxGapMs}
            onChange={(e) => { setMaxGapMs(Number(e.target.value)); setResult(null); }}
          />
          <span>{maxGapMs === 0 ? 'off' : `max ${maxGapMs}ms`}</span>
        </label>

        <div className="spacer" />
        <button onClick={playEdit} disabled={!!busy || kept === 0}>▶ Preview edit</button>
        <button className="primary" onClick={render} disabled={!!busy || kept === 0}>
          {busy === 'Rendering…' ? 'Rendering…' : 'Render'}
        </button>
      </nav>

      {error && <p className="error">{error}</p>}

      <div className="stage">
        <video
          ref={videoRef}
          src={project.sourceUrl}
          controls
          onTimeUpdate={onTimeUpdate}
          onPause={() => setPlaying(false)}
        />
        {result && (
          <div className="result">
            <p>
              Rendered {fmt(result.outputDuration)} from {fmt(result.sourceDuration)} ·{' '}
              {result.segments} segments · {result.renderMs}ms
            </p>
            <video src={result.url} controls />
            <a href={result.url} download>Download</a>
          </div>
        )}
      </div>

      <article className="transcript" onMouseDown={(e) => { if (e.target === e.currentTarget) setSelection(new Set()); }}>
        {words.map((word, i) => (
          <span
            key={word.id}
            className={[
              'word',
              word.deleted ? 'deleted' : '',
              word.isFiller ? 'filler' : '',
              selection.has(word.id) ? 'selected' : '',
            ].filter(Boolean).join(' ')}
            title={`${word.start.toFixed(2)}s – ${word.end.toFixed(2)}s${word.speaker ? ` · ${word.speaker}` : ''}`}
            onClick={(e) => clickWord(i, e.shiftKey)}
            onDoubleClick={() => {
              const video = videoRef.current;
              if (video) { video.currentTime = word.start; video.play(); setPlaying(false); }
            }}
          >
            {word.text}{' '}
          </span>
        ))}
      </article>

      <footer>
        Click a word to select · Shift-click for a range · <kbd>Backspace</kbd> to cut ·{' '}
        <kbd>Ctrl</kbd>+<kbd>Z</kbd> to restore · double-click to play from there
      </footer>
    </main>
  );
}

function fmt(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}:${s.toFixed(0).padStart(2, '0')}` : `${s.toFixed(1)}s`;
}
