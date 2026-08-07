import { useState } from 'react';

import ProjectPanel, { type FillerMode } from '../rail/ProjectPanel.tsx';
import SelectionPanel from '../rail/SelectionPanel.tsx';
import AgentPanel from '../agent/AgentPanel.tsx';
import { Empty } from '../ui/Field.tsx';
import { timecode } from '../../../../packages/core/src/timeline.ts';
import type { CutSettings } from '../../../../packages/core/src/doc.ts';
import type { CaptionSettings } from '../../../../packages/core/src/caption-style.ts';
import type { FrameSettings } from '../../../../packages/core/src/frame.ts';
import type { ColorSettings } from '../../../../packages/core/src/color.ts';
import type { ImageOverlay } from '../../../../packages/core/src/overlay.ts';
import type { Word } from '../../../../packages/core/src/types.ts';
import type { CustomFont, MusicProvider, MusicResult, Project } from '../api.ts';

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

  studioSound: boolean;
  onToggleStudioSound: (enabled: boolean) => void;

  frame: FrameSettings;
  setFrame: (f: FrameSettings) => void;
  onFrameDragStart: () => void;
  onFrameDragEnd: (label: string) => void;

  /** Push-ins. See ProjectPanel's MovesField and SelectionPanel's "Push in here". */
  onPunchIn: () => void;
  punchBlocked: string | null;
  onMarkMove: (id: string) => void;
  onRemoveMove: (id: string) => void;
  onSetMove: (id: string, patch: { zoom?: number; ease?: number }) => void;
  onFollowMove: (id: string) => void;
  onClearFollow: (id: string) => void;
  markingMoveId: string | null;
  following: { id: string; progress: number } | null;
  onSeek: (time: number) => void;

  /** Image inserts. See ProjectPanel's ImagesField — describe a picture and it
   *  is generated and placed on the words the prompt names. */
  overlays: ImageOverlay[];
  imageUrls: Record<string, string>;
  imageNames: Record<string, string>;
  onSetOverlay: (id: string, patch: Partial<ImageOverlay>) => void;
  onRemoveOverlay: (id: string) => void;
  onOverlayDragStart: () => void;
  onOverlayDragEnd: (label: string) => void;
  editingOverlayId: string | null;
  onEditOverlay: (id: string | null) => void;
  onGenerateImage: (prompt: string) => void;
  onImportImage: (file: File) => void;
  onRetargetOverlayToWord: (id: string, phrase: string) => void;
  generatingImage: boolean;
  canGenerateImages: boolean;
  /** Move the image being framed onto the current selection. See SelectionPanel. */
  onMoveImageHere?: () => void;
  moveImageLabel?: string;

  color: ColorSettings;
  setColor: (c: ColorSettings) => void;
  onColorDragStart: () => void;
  onColorDragEnd: (label: string) => void;

  customFonts: CustomFont[];
  onImportFont: (file: File) => void;
  onRemoveFont: (id: string) => void;
  fontBusy: boolean;

  onImportMusic: (file: File) => void;
  onUpdateMusic: (patch: { volume?: number; durationSec?: number | null }) => void;
  onRemoveMusic: () => void;
  musicBusy: boolean;
  onPickMusic: (track: MusicResult) => void;
  musicProviders: MusicProvider[];

  fillerMode: FillerMode;
  setFillerMode: (m: FillerMode) => void;
  customFillers: string[];
  onAddCustomFiller: (word: string) => void;
  onRemoveCustomFiller: (word: string) => void;
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

  /** The AI assistant. `enabled` is false until a Grok or Claude key is set. */
  agentEnabled: boolean;
  agentDefaultModel: string;
  /** Open the API-keys dialog — surfaced from the assistant panel when it is off. */
  onOpenSettings: () => void;
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
  // The rail is two tabs: the manual inspector and the assistant (drive the editor
  // from chat). The inspector is first and the default — the hands-on surface you
  // land on — with the assistant one click away. Kept above the early return below
  // so the hook order never changes.
  const [tab, setTab] = useState<'chat' | 'inspector'>('inspector');

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

  const inspector = !p.hasScript ? (
    <>
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
          No script yet. Transcribing is the one thing this app will not do behind your back —
          though you can just ask the assistant to do it.
        </p>
        <button className="primary go" onClick={p.onTranscribe} disabled={!!p.busy}>
          Transcribe…
        </button>
      </div>
    </>
  ) : p.selectedWords.length > 0 ? (
    <>
      <div className="rail-head">Selection</div>
      <SelectionPanel
        words={p.selectedWords}
        onDelete={p.onDeleteSelection}
        onRestore={p.onRestoreSelection}
        onPlaySelection={p.onPlaySelection}
        // Audio has no picture to push in on, so the affordance is absent
        // rather than present and permanently disabled.
        onPunchIn={p.project.hasVideo ? p.onPunchIn : undefined}
        punchBlocked={p.punchBlocked}
        // Absent on audio for the same reason, and absent again when there is
        // no insert to move — an enabled button with nothing to act on is worse
        // than no button.
        onMoveImageHere={p.project.hasVideo ? p.onMoveImageHere : undefined}
        moveImageLabel={p.moveImageLabel}
      />
    </>
  ) : (
    <>
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
        studioSound={p.studioSound}
        onToggleStudioSound={p.onToggleStudioSound}
        frame={p.frame}
        setFrame={p.setFrame}
        onFrameDragStart={p.onFrameDragStart}
        onFrameDragEnd={p.onFrameDragEnd}
        onMarkMove={p.onMarkMove}
        onRemoveMove={p.onRemoveMove}
        onSetMove={p.onSetMove}
        onFollowMove={p.onFollowMove}
        onClearFollow={p.onClearFollow}
        markingMoveId={p.markingMoveId}
        following={p.following}
        onSeek={p.onSeek}
        overlays={p.overlays}
        imageUrls={p.imageUrls}
        imageNames={p.imageNames}
        onSetOverlay={p.onSetOverlay}
        onRemoveOverlay={p.onRemoveOverlay}
        onOverlayDragStart={p.onOverlayDragStart}
        onOverlayDragEnd={p.onOverlayDragEnd}
        editingOverlayId={p.editingOverlayId}
        onEditOverlay={p.onEditOverlay}
        onGenerateImage={p.onGenerateImage}
        onImportImage={p.onImportImage}
        onRetargetOverlayToWord={p.onRetargetOverlayToWord}
        generatingImage={p.generatingImage}
        canGenerateImages={p.canGenerateImages}
        color={p.color}
        setColor={p.setColor}
        onColorDragStart={p.onColorDragStart}
        onColorDragEnd={p.onColorDragEnd}
        customFonts={p.customFonts}
        onImportFont={p.onImportFont}
        onRemoveFont={p.onRemoveFont}
        fontBusy={p.fontBusy}
        onImportMusic={p.onImportMusic}
        onUpdateMusic={p.onUpdateMusic}
        onRemoveMusic={p.onRemoveMusic}
        musicBusy={p.musicBusy}
        onPickMusic={p.onPickMusic}
        musicProviders={p.musicProviders}
        fillerMode={p.fillerMode}
        setFillerMode={p.setFillerMode}
        customFillers={p.customFillers}
        onAddCustomFiller={p.onAddCustomFiller}
        onRemoveCustomFiller={p.onRemoveCustomFiller}
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
    </>
  );

  return (
    <div className="rail">
      <div className="rail-tabs">
        <button
          className={`rail-tab ${tab === 'inspector' ? 'on' : ''}`}
          onClick={() => setTab('inspector')}
        >
          Inspector
        </button>
        <button
          className={`rail-tab ${tab === 'chat' ? 'on' : ''}`}
          onClick={() => setTab('chat')}
        >
          Assistant
        </button>
      </div>
      {tab === 'chat' ? (
        <AgentPanel
          enabled={p.agentEnabled}
          defaultModel={p.agentDefaultModel}
          onOpenSettings={p.onOpenSettings}
        />
      ) : (
        inspector
      )}
    </div>
  );
}
