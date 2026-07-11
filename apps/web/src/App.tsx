import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  type Capabilities,
  type CutSettings,
  type MediaItem,
  type Project,
  type RenderResult,
  type AsrOptions,
} from './api.ts';
import Script from './Script.tsx';
import Timeline from './Timeline.tsx';
import Inspector, { type FillerMode, type Tab } from './Inspector.tsx';

import { compileEdl, outputDuration, sourceToOutput } from '../../../packages/core/src/edl.ts';
import { wordAt } from '../../../packages/core/src/paragraphs.ts';
import type { Word } from '../../../packages/core/src/types.ts';

export default function App() {
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [library, setLibrary] = useState<MediaItem[]>([]);
  const [project, setProject] = useState<Project | null>(null);

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [tab, setTab] = useState<Tab>('transcribe');
  const [asr, setAsr] = useState<AsrOptions | null>(null);
  const [cut, setCut] = useState<CutSettings>({ padMs: 40, fadeMs: 12, mergeWithinMs: 20, maxGapMs: 0 });
  const [fillerMode, setFillerMode] = useState<FillerMode>('hesitations');
  const [retakeMin, setRetakeMin] = useState(2);

  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<number | null>(null);
  const [showDeleted, setShowDeleted] = useState(true);

  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [followEdit, setFollowEdit] = useState(true);
  const [result, setResult] = useState<RenderResult | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const words = project?.transcript?.words ?? [];

  useEffect(() => {
    api.capabilities().then((c) => { setCaps(c); setAsr(c.asrDefaults); }).catch((e) => setError(e.message));
    api.list().then(setLibrary).catch(() => {});
  }, []);

  const edl = useMemo(
    () =>
      project?.transcript
        ? compileEdl(project.transcript, {
            ...cut,
            maxGapMs: cut.maxGapMs > 0 ? cut.maxGapMs : Infinity,
          })
        : null,
    [project, cut],
  );

  const playingIndex = useMemo(
    () => (playing ? wordAt(words, currentTime) : -1),
    [playing, words, currentTime],
  );

  const stats = {
    words: words.length,
    kept: words.filter((w) => !w.deleted).length,
    cuts: edl?.keep.length ?? 0,
    outputSec: edl ? outputDuration(edl) : 0,
    sourceSec: project?.duration ?? 0,
  };

  // --- run helper --------------------------------------------------------------
  const run = async <T,>(label: string, fn: () => Promise<T>) => {
    setBusy(label);
    setError(null);
    try { return await fn(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); return null; }
    finally { setBusy(null); }
  };

  // --- library -----------------------------------------------------------------
  const importFile = (file: File) =>
    run('import', async () => {
      const p = await api.import(file);
      setProject(p);
      setResult(null);
      setSelection(new Set());
      setTab('transcribe'); // import does NOT transcribe — that is your call
      setLibrary(await api.list());
      setNotice(`Imported ${p.name}. Configure the transcription and press Transcribe.`);
      return p;
    });

  const openProject = (id: string) =>
    run('open', async () => {
      const p = await api.get(id);
      setProject(p);
      setResult(null);
      setSelection(new Set());
      setTab(p.transcript ? 'cuts' : 'transcribe');
      return p;
    });

  // --- stages ------------------------------------------------------------------
  const doTranscribe = () =>
    run('transcribe', async () => {
      const p = await api.transcribe(project!.id, asr!);
      setProject(p);
      setResult(null);
      setTab('cuts');
      setNotice(
        p.verbatim
          ? null
          : 'This transcript is not verbatim — the model dropped fillers before you saw them. The filler tool will find little to nothing.',
      );
      return p;
    });

  const doAction = (action: string, options: Record<string, unknown> = {}) =>
    run(action, async () => {
      const r = await api.action(project!.id, action, options);
      setProject({ ...project!, transcript: r.transcript });
      setResult(null);
      setNotice(`${r.changed} words cut.`);
      return r;
    });

  const doCaptions = (format: string) =>
    run('captions', async () => {
      const r = await api.captions(project!.id, { format, ...cut });
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
      const r = await api.render(project!.id, cut);
      setResult(r);
      return r;
    });

  // --- playback ----------------------------------------------------------------
  const onTimeUpdate = () => {
    const video = videoRef.current;
    if (!video) return;
    setCurrentTime(video.currentTime);

    if (!followEdit || !playing || !edl) return;
    if (sourceToOutput(edl, video.currentTime) !== null) return;

    const next = edl.keep.find((r) => r.start > video.currentTime);
    if (next) video.currentTime = next.start;
    else { video.pause(); setPlaying(false); }
  };

  const seek = (t: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = t;
    setCurrentTime(t);
  };

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    video.paused ? video.play() : video.pause();
  };

  // --- editing -----------------------------------------------------------------
  const mutate = (fn: (words: Word[]) => void) => {
    if (!project?.transcript) return;
    const next = structuredClone(project);
    fn(next.transcript!.words);
    setProject(next);
    setResult(null);
    api.setDeleted(next.id, next.transcript!.words.filter((w) => w.deleted).map((w) => w.id))
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
      seek(words[index].start);
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
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement;
      if (typing) return;

      if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); setSelectionDeleted(true); }
      else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); setSelectionDeleted(false); }
      else if (e.key === 'Escape') setSelection(new Set());
      else if (e.key === ' ') { e.preventDefault(); togglePlay(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setSelectionDeleted]);

  if (!caps || !asr) return <div className="boot">Loading workspace…</div>;

  // --- workspace ---------------------------------------------------------------
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="dot" />
          <strong>Workspace</strong>
        </div>

        <div className="transport">
          <button className="play" onClick={togglePlay} disabled={!project}>
            {playing ? '❚❚' : '▶'}
          </button>
          <span className="clock">
            {clock(currentTime)} / {clock(project?.duration ?? 0)}
          </span>
          <label className="check">
            <input type="checkbox" checked={followEdit} onChange={(e) => setFollowEdit(e.target.checked)} />
            Play the edit
          </label>
          <label className="check">
            <input type="checkbox" checked={showDeleted} onChange={(e) => setShowDeleted(e.target.checked)} />
            Show cut text
          </label>
        </div>

        <div className="out">
          {project?.transcript ? (
            <>
              <strong>{clock(stats.outputSec)}</strong>
              <em>{stats.cuts} segments</em>
            </>
          ) : (
            <span className="fal-state">{caps.hasFal ? 'fal connected' : 'no FAL_KEY — mock only'}</span>
          )}
        </div>
      </header>

      <div className="middle">
        {/* ---- media library ---- */}
        <aside className="library">
          <div className="lib-head">
            <h3>Media</h3>
            <label className="import">
              +
              <input
                type="file"
                accept="video/*,audio/*"
                onChange={(e) => e.target.files?.[0] && importFile(e.target.files[0])}
              />
            </label>
          </div>

          {library.length === 0 && <p className="empty-panel">Import a file to start.</p>}

          <ul className="items">
            {library.map((m) => (
              <li
                key={m.id}
                className={m.id === project?.id ? 'item on' : 'item'}
                onClick={() => openProject(m.id)}
              >
                <span className="kind">{m.hasVideo ? '▣' : '♪'}</span>
                <span className="nm">{m.name}</span>
                <span className={m.status === 'transcribed' ? 'st done' : 'st'}>
                  {m.status === 'transcribed' ? 'script' : 'raw'}
                </span>
              </li>
            ))}
          </ul>

          {busy === 'import' && <p className="empty-panel">Importing…</p>}
        </aside>

        {/* ---- script ---- */}
        <main className="script">
          {error && <p className="error" onClick={() => setError(null)}>{error}</p>}
          {notice && !error && <p className="notice" onClick={() => setNotice(null)}>{notice}</p>}

          {!project && (
            <div className="canvas-empty">
              <h2>Nothing open</h2>
              <p>Import media from the left. Nothing is transcribed until you ask for it.</p>
            </div>
          )}

          {project && !project.transcript && (
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

          {project?.transcript && (
            <Script
              transcript={project.transcript}
              selection={selection}
              playingIndex={playingIndex}
              showDeleted={showDeleted}
              onWordClick={clickWord}
              onWordDoubleClick={(i) => { seek(words[i].start); videoRef.current?.play(); }}
              onBackgroundClick={() => setSelection(new Set())}
            />
          )}
        </main>

        {/* ---- preview + inspector ---- */}
        <div className="right">
          <div className="viewer">
            {project ? (
              <video
                ref={videoRef}
                src={project.sourceUrl}
                onTimeUpdate={onTimeUpdate}
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
              />
            ) : (
              <div className="viewer-empty" />
            )}

            {result && (
              <div className="result">
                <a href={result.url} download>
                  Download render · {fmtShort(result.outputDuration)} · {result.renderMs}ms
                </a>
              </div>
            )}
          </div>

          <Inspector
            tab={tab}
            setTab={setTab}
            project={project}
            caps={caps}
            busy={busy}
            asr={asr}
            setAsr={setAsr}
            onTranscribe={doTranscribe}
            cut={cut}
            setCut={setCut}
            fillerMode={fillerMode}
            setFillerMode={setFillerMode}
            retakeMin={retakeMin}
            setRetakeMin={setRetakeMin}
            onRemoveFillers={() =>
              doAction('remove-fillers', { includeDiscourseMarkers: fillerMode === 'all' })
            }
            onRemoveRetakes={() => doAction('remove-retakes', { minWords: retakeMin })}
            onRestoreAll={() => doAction('restore-all')}
            onCaptions={doCaptions}
            onRender={doRender}
            stats={stats}
          />
        </div>
      </div>

      <footer className="tl">
        <Timeline
          peaks={project?.peaks ?? []}
          duration={project?.duration ?? 0}
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

function fmtShort(seconds: number): string {
  return seconds >= 60 ? clock(seconds) : `${seconds.toFixed(1)}s`;
}
