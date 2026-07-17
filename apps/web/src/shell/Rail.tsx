import ProjectPanel, { type FillerMode } from '../rail/ProjectPanel.tsx';
import SelectionPanel from '../rail/SelectionPanel.tsx';
import { Empty } from '../ui/Field.tsx';
import { timecode } from '../../../../packages/core/src/timeline.ts';
import type { CutSettings } from '../../../../packages/core/src/doc.ts';
import type { CaptionSettings } from '../../../../packages/core/src/caption-style.ts';
import type { Word } from '../../../../packages/core/src/types.ts';
import type { Project } from '../api.ts';

interface Props {
  project: Project | null;
  hasScript: boolean;
  selectedWords: Word[];
  stats: { words: number; kept: number; cuts: number; outputSec: number; sourceSec: number };
  verbatim: boolean;
  asrProvider: string | null;

  cut: CutSettings;
  setCut: (c: CutSettings) => void;
  onCutDragStart: () => void;
  onCutDragEnd: (label: string) => void;

  captions: CaptionSettings;
  setCaptions: (c: CaptionSettings) => void;
  onCaptionDragStart: () => void;
  onCaptionDragEnd: (label: string) => void;

  fillerMode: FillerMode;
  setFillerMode: (m: FillerMode) => void;
  retakeMin: number;
  setRetakeMin: (n: number) => void;
  fillerCount: number;
  retakeCount: number;

  onRemoveFillers: () => void;
  onRemoveRetakes: () => void;
  onRestoreAll: () => void;
  onRetranscribe: () => void;
  onTranscribe: () => void;
  onDeleteSelection: () => void;
  onRestoreSelection: () => void;
  onPlaySelection: () => void;
  busy: string | null;
}

/**
 * The inspector, driven by what you have selected rather than by the pipeline.
 *
 * What was here: four tabs named Transcribe / Cuts / Tools / Export — the
 * engine's stages, in engine order, permanently on screen. Three of them were
 * not inspectors at all: transcription is a per-import decision, captions are an
 * export format, and export is a terminal commitment. They are dialogs now. The
 * fourth, "Cuts", was already the document's inspector and only needed saying so.
 */
export default function Rail(p: Props) {
  if (!p.project) {
    return (
      <div className="rail">
        <div className="rail-head">Nothing open</div>
        <div className="panel">
          <Empty>Import media to begin.</Empty>
        </div>
      </div>
    );
  }

  if (!p.hasScript) {
    return (
      <div className="rail">
        <div className="rail-head">{p.project.name}</div>
        <div className="panel">
          <div className="hero">
            <strong>{timecode(p.project.duration)}</strong>
            <small>
              {p.project.hasVideo ? `${p.project.width}×${p.project.height}` : 'Audio only'}
              {p.project.fps ? ` · ${Math.round(p.project.fps * 100) / 100} fps` : ''}
            </small>
          </div>
          <p className="hint">
            No script yet. Transcribing is the one thing this app will not do behind your back.
          </p>
          <button className="primary go" onClick={p.onTranscribe} disabled={!!p.busy}>
            Transcribe…
          </button>
        </div>
      </div>
    );
  }

  if (p.selectedWords.length > 0) {
    return (
      <div className="rail">
        <div className="rail-head">Selection</div>
        <SelectionPanel
          words={p.selectedWords}
          onDelete={p.onDeleteSelection}
          onRestore={p.onRestoreSelection}
          onPlaySelection={p.onPlaySelection}
        />
      </div>
    );
  }

  return (
    <div className="rail">
      <div className="rail-head">Project</div>
      <ProjectPanel
        project={p.project}
        verbatim={p.verbatim}
        asrProvider={p.asrProvider}
        stats={p.stats}
        cut={p.cut}
        setCut={p.setCut}
        onCutDragStart={p.onCutDragStart}
        onCutDragEnd={p.onCutDragEnd}
        captions={p.captions}
        setCaptions={p.setCaptions}
        onCaptionDragStart={p.onCaptionDragStart}
        onCaptionDragEnd={p.onCaptionDragEnd}
        fillerMode={p.fillerMode}
        setFillerMode={p.setFillerMode}
        retakeMin={p.retakeMin}
        setRetakeMin={p.setRetakeMin}
        fillerCount={p.fillerCount}
        retakeCount={p.retakeCount}
        onRemoveFillers={p.onRemoveFillers}
        onRemoveRetakes={p.onRemoveRetakes}
        onRestoreAll={p.onRestoreAll}
        onRetranscribe={p.onRetranscribe}
        busy={p.busy}
      />
    </div>
  );
}
