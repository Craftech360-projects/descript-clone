import { useId, useRef, useState } from 'react';
import {
  Field,
  Hint,
  Slider,
  Segmented,
  Section,
  SectionGroup,
  Warn,
  Check,
  Color,
} from '../ui/Field.tsx';
import { timecode } from '../../../../packages/core/src/timeline.ts';
import { bedLoops } from '../../../../packages/core/src/music.ts';
import type { CutSettings } from '../../../../packages/core/src/doc.ts';
import {
  MIN_OVERLAY_SEC,
  OVERLAY_TRANSITIONS,
  type ImageOverlay,
  type OverlayTransition,
} from '../../../../packages/core/src/overlay.ts';
import {
  CAPTION_FONTS,
  MIN_CAPTION_BOX,
  strokeRole,
  type Backdrop,
  type CaptionSettings,
} from '../../../../packages/core/src/caption-style.ts';
import {
  FRAME_PRESETS,
  MAX_DIM,
  MAX_ZOOM,
  MIN_DIM,
  MIN_ZOOM,
  fitZoom,
  frameSize,
  normalizeFrame,
  type FramePreset,
  type FrameSettings,
} from '../../../../packages/core/src/frame.ts';
import { MAX_PUNCH_ZOOM } from '../../../../packages/core/src/frame-track.ts';
import {
  COLOR_PRESETS,
  MAX_SATURATION,
  MIN_SATURATION,
  colorSummary,
  presetSettings,
  resolveColor,
  type ColorPreset,
  type ColorSettings,
} from '../../../../packages/core/src/color.ts';
import GradeFilter from '../ui/GradeFilter.tsx';
import { api, type CustomFont, type MusicProvider, type MusicResult, type Project } from '../api.ts';

export type FillerMode = 'off' | 'hesitations' | 'all';

interface Props {
  project: Project;
  verbatim: boolean;
  asrProvider: string | null;
  stats: { words: number; kept: number; cuts: number; outputSec: number; sourceSec: number };

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

  /** The output frame — resolution plus the crop that fills it. */
  frame: FrameSettings;
  setFrame: (f: FrameSettings) => void;
  onFrameDragStart: () => void;
  onFrameDragEnd: (label: string) => void;

  /**
   * Push-ins: mark a portion of the picture and zoom into it for a stretch of
   * the video, optionally following it. These live on `frame.moves` — the panel
   * takes them apart only so it does not have to rebuild the whole settings
   * object to change one move.
   */
  onMarkMove: (id: string) => void;
  onRemoveMove: (id: string) => void;
  onSetMove: (id: string, patch: { zoom?: number; ease?: number }) => void;
  onFollowMove: (id: string) => void;
  onClearFollow: (id: string) => void;
  /** The move whose box is being dragged on the monitor right now. */
  markingMoveId: string | null;
  /** The move being tracked, and how far along, so the row can say so. */
  following: { id: string; progress: number } | null;
  /** Jump the playhead — used to preview a move from its own start. */
  onSeek: (time: number) => void;

  /**
   * Image inserts: a picture over the video for a stretch of the transcript.
   *
   * Unlike push-ins these are NOT part of `frame` — an overlay composites pixels
   * from another file rather than re-cropping this one — so they arrive as their
   * own list with their own edit callbacks. See core/overlay.ts.
   */
  overlays: ImageOverlay[];
  /** assetId → URL, for the thumbnail on each row. */
  imageUrls: Record<string, string>;
  /** assetId → filename, so a row can name its picture. */
  imageNames: Record<string, string>;
  onSetOverlay: (id: string, patch: Partial<ImageOverlay>) => void;
  onRemoveOverlay: (id: string) => void;
  /** Bracket a slider drag into one undo step — see beginOverlayDrag. */
  onOverlayDragStart: () => void;
  onOverlayDragEnd: (label: string) => void;
  /** The overlay being framed on the monitor, held visible outside its window. */
  editingOverlayId: string | null;
  onEditOverlay: (id: string | null) => void;
  /** Describe a picture; it is generated and placed where the prompt points. */
  onGenerateImage: (prompt: string) => void;
  /** Import one from disk instead. Placed at the selection, else the playhead. */
  onImportImage: (file: File) => void;
  /** Move an insert onto a word the user typed, rather than one they selected. */
  onRetargetOverlayToWord: (id: string, phrase: string) => void;
  /** True while a generation is in flight — it takes seconds, not milliseconds. */
  generatingImage: boolean;
  /** False when the server has no GEMINI_API_KEY; import still works. */
  canGenerateImages: boolean;

  /** The colour grade — which look, and where its six knobs sit. */
  color: ColorSettings;
  setColor: (c: ColorSettings) => void;
  onColorDragStart: () => void;
  onColorDragEnd: (label: string) => void;

  /** Imported caption fonts, shared across every project. */
  customFonts: CustomFont[];
  onImportFont: (file: File) => void;
  onRemoveFont: (id: string) => void;
  fontBusy: boolean;

  /** Background music, per project — lives on `project.music`. */
  onImportMusic: (file: File) => void;
  onUpdateMusic: (patch: { volume?: number; durationSec?: number | null; loop?: boolean }) => void;
  onRemoveMusic: () => void;
  musicBusy: boolean;
  /** Attach a track found through the picker. The server does the downloading. */
  onPickMusic: (track: MusicResult) => void;
  /** Catalogues the server can search. Never empty; the second entry is a fallback. */
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
  busy: string | null;
}

/**
 * The user's own filler words, added on top of the built-in hesitation shapes.
 *
 * Holds only the draft text of the input; the committed list lives in App so it
 * can be persisted and fed to the detector. Enter or the Add button commits;
 * App normalizes and de-dupes, so this stays dumb.
 */
function CustomFillers({ words, onAdd, onRemove }: {
  words: string[];
  onAdd: (word: string) => void;
  onRemove: (word: string) => void;
}) {
  const [draft, setDraft] = useState('');
  const inputId = useId();
  const commit = () => {
    onAdd(draft);
    setDraft('');
  };

  return (
    <div className="custom-fillers">
      <div className="chip-input">
        {/* A real label rather than the placeholder alone. The placeholder is
          * the example, not the name — and it vanishes the moment you type, so
          * a screen reader reaching this field mid-edit had nothing left to
          * announce it by. Unpainted: the field sits under a heading that
          * already says what it is. */}
        <label className="sr-only" htmlFor={inputId}>Add a filler word</label>
        <input
          id={inputId}
          type="text"
          value={draft}
          placeholder="Add a word — e.g. basically, literally"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            }
          }}
        />
        <button type="button" onClick={commit} disabled={!draft.trim()}>Add</button>
      </div>
      {words.length > 0 && (
        <ul className="chips">
          {words.map((w) => (
            <li key={w} className="chip">
              <span>{w}</span>
              <button type="button" aria-label={`Remove ${w}`} onClick={() => onRemove(w)}>×</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** What the mode flags, said once, instead of inside all three option labels. */
const FILLER_HINT: Record<FillerMode, string> = {
  off: 'Fillers are left alone and nothing is marked in the script.',
  hesitations: 'Flags um, uh, er, and a "so" that only opens a sentence.',
  all: 'Also flags you know, I mean, sort of.',
};

/**
 * What the rail shows when nothing is selected.
 *
 * This is the reframe that retires the tabs: with no selection, the context IS
 * the document. The old "Cuts" tab was already the document's inspector — it
 * just sat in a row of pipeline stages and so read as one.
 *
 * ── The panel states itself ───────────────────────────────────────────────
 * Every section is a row carrying its own VALUE — "Reel · 1080×1920", "Capped
 * at 400ms", "warm-piano.mp3". Closed, this panel is now a full status report
 * on the project. It used to be a list of nouns: seven disclosures reading
 * "Frame", "Captions", "Background music", so the only way to learn what you
 * were about to export was to open all seven in turn and then close them again.
 * That, not the control count, is what made this read as a settings dump.
 *
 * The two switches ride in their section headers for the same reason. Turning
 * captions on is the single most frequent act in this panel and it used to cost
 * three clicks — open, switch, close — with a dozen controls you did not want
 * to see in between.
 *
 * ── The grouping is the meaning, not the layout ───────────────────────────
 * Two groups, and they are a real distinction rather than a shelf each:
 * EDIT changes which words survive — it moves the timeline. OUTPUT changes how
 * the surviving words are delivered — it never moves a cut.
 *
 * Pauses is under Edit, where it belongs. It sat under the render column
 * before, and the old comment here was honest about why: Captions swings from
 * one switch to a dozen controls, so Pauses was BALLAST, there to stop the
 * right column collapsing when captions were off. Rows that are uniformly one
 * line tall until you open them need no ballast, so the meaning gets its place
 * back.
 */
export default function ProjectPanel(p: Props) {
  return (
    <div className="panel panel-project">
      {/* The output-length summary that led this panel now lives in the title bar,
        * beside Export — it is the document's running state, not a control. */}

      {/* The words — which of them survive. The transcript's provenance and the
        * Re-transcribe action moved out: the summary lives in the Transcribe
        * dialog (it is the "before" a re-transcribe replaces), and the entry
        * point sits at the end of the script itself. */}
      <SectionGroup label="Edit">
        <CleanUpField {...p} />
        <PausesField {...p} />
        <AdvancedField {...p} />
      </SectionGroup>

      {/* The delivery — its shape, its sound, and what it says on screen. */}
      <SectionGroup label="Output">
        <FrameField {...p} />
        <MovesField {...p} />
        <ImagesField {...p} />
        <ColorField {...p} />
        <StudioSoundField {...p} />
        <MusicField {...p} />
        <CaptionsField {...p} />
      </SectionGroup>
    </div>
  );
}

/**
 * Fillers and false starts: what gets swept out of the script.
 *
 * The header value counts what is currently FLAGGED — the work waiting for you
 * — because that is the one number that decides whether this section is worth
 * opening at all. False starts are detected whichever filler mode you are in,
 * so they count even at Off, and Off with retakes pending must not read as
 * "nothing to do here".
 */
function CleanUpField(p: Props) {
  const fillers = p.fillerMode === 'off' ? 0 : p.fillerCount;
  const flagged = fillers + p.retakeCount;
  const value =
    p.fillerMode === 'off' && p.retakeCount === 0
      ? 'Off'
      : flagged === 0
        ? 'Nothing flagged'
        : `${flagged} flagged`;

  return (
    <Section icon="scissors" label="Clean up" value={value}>
      <Segmented
        name="filler"
        value={p.fillerMode}
        onChange={(v) => p.setFillerMode(v as FillerMode)}
        options={[
          ['off', 'Off'],
          ['hesitations', 'Hesitations'],
          ['all', 'All'],
        ]}
      />
      {/* The examples moved out of the option labels and into one line that
        * follows the choice — three long labels were most of this field's
        * height, and only one of them was ever the answer. */}
      <Hint>{FILLER_HINT[p.fillerMode]}</Hint>
      {p.fillerMode === 'all' && (
        <Warn>
          "Sort of" and "kind of" are sometimes load-bearing. Review before cutting — these are
          flagged, never cut automatically.
        </Warn>
      )}

      {/* Your own words fold into the same sweep as the built-in hesitations.
        * Hidden when the tool is off, since nothing is flagged then. */}
      {p.fillerMode !== 'off' && (
        <CustomFillers
          words={p.customFillers}
          onAdd={p.onAddCustomFiller}
          onRemove={p.onRemoveCustomFiller}
        />
      )}

      {/* The count lives IN the label, so you know the outcome before you
        * commit rather than reading it in a notice afterwards. */}
      <button
        onClick={p.onRemoveFillers}
        disabled={!!p.busy || p.fillerMode === 'off' || p.fillerCount === 0}
      >
        {p.fillerMode === 'off'
          ? 'Remove filler words'
          : p.fillerCount === 0
            ? 'No filler words found'
            : `Remove ${p.fillerCount} filler word${p.fillerCount === 1 ? '' : 's'}`}
      </button>

      <button onClick={p.onRemoveRetakes} disabled={!!p.busy || p.retakeCount === 0}>
        {p.retakeCount === 0
          ? 'No false starts found'
          : `Remove ${p.retakeCount} false start${p.retakeCount === 1 ? '' : 's'}`}
      </button>

      <button onClick={p.onRestoreAll} disabled={!!p.busy || p.stats.kept === p.stats.words}>
        Restore everything
      </button>
    </Section>
  );
}

function PausesField(p: Props) {
  // 0 is the sentinel for "keep every pause": Infinity does not survive JSON, so
  // the wire speaks 0 and the document holds Infinity.
  const gap = p.cut.maxGapMs === Infinity ? 0 : p.cut.maxGapMs;

  return (
    <Section
      icon="clock"
      label="Pauses"
      value={gap === 0 ? 'All kept' : `Capped at ${gap}ms`}
    >
      <Slider
        value={gap}
        min={0}
        max={2000}
        step={50}
        onPointerDown={p.onCutDragStart}
        onPointerUp={() =>
          p.onCutDragEnd(gap === 0 ? 'Keep every pause' : `Shorten pauses to ${gap}ms`)
        }
        onChange={(v) => p.setCut({ ...p.cut, maxGapMs: v > 0 ? v : Infinity })}
        format={(v) => (v === 0 ? 'Keep every pause' : `Cap at ${v}ms`)}
      />
    </Section>
  );
}

function StudioSoundField(p: Props) {
  return (
    <Section
      icon="sparkle"
      label="Studio Sound"
      toggle={{
        checked: p.studioSound,
        onChange: p.onToggleStudioSound,
        label: 'Studio Sound',
      }}
    >
      <Hint>
        Cleans up the voice: removes rumble and background noise, lifts presence, evens
        out the level, and normalises to broadcast loudness. Music beds are left alone.
        The monitor previews the tone; noise reduction and final loudness are applied on
        export.
      </Hint>
    </Section>
  );
}

/**
 * The caption font control: the built-in families, the imported ones, and the
 * import/remove affordances that manage the shared library inline.
 *
 * The dropdown value is CaptionSettings.font — a built-in id for the built-ins,
 * and the real family NAME for an imported font (that name is what the burn's ASS
 * Fontname and the preview's @font-face both key off, so it is the stable handle,
 * not the opaque id). Remove is offered only while an imported font is selected;
 * it is the one place that library is destructive, so it stays out of reach until
 * you are actually looking at the font it would delete.
 */
function FontPicker({ value, onChange, customFonts, onImport, onRemove, busy }: {
  value: string;
  onChange: (font: string) => void;
  customFonts: CustomFont[];
  onImport: (file: File) => void;
  onRemove: (id: string) => void;
  busy: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const selectedCustom = customFonts.find((f) => f.family === value) ?? null;

  return (
    <div className="font-picker">
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <optgroup label="Built-in">
          {CAPTION_FONTS.map((f) => (
            <option key={f.id} value={f.id}>{f.label}</option>
          ))}
        </optgroup>
        {customFonts.length > 0 && (
          <optgroup label="Imported">
            {customFonts.map((f) => (
              <option key={f.id} value={f.family}>{f.label}</option>
            ))}
          </optgroup>
        )}
      </select>

      <div className="font-actions">
        <input
          ref={inputRef}
          type="file"
          accept=".ttf,.otf,.ttc,.woff,.woff2"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onImport(file);
            // Clear the value so re-importing the SAME file fires onChange again.
            e.target.value = '';
          }}
        />
        <button className="link" onClick={() => inputRef.current?.click()} disabled={busy}>
          {busy ? 'Importing…' : 'Import font…'}
        </button>
        {selectedCustom && (
          <button className="link danger" onClick={() => onRemove(selectedCustom.id)} disabled={busy}>
            Remove “{selectedCustom.label}”
          </button>
        )}
      </div>

      <Hint>TTF, OTF, WOFF or WOFF2. Imported fonts are saved for every project.</Hint>
    </div>
  );
}

/**
 * The output frame: what shape the video is, and which part of the source fills it.
 *
 * The panel deliberately owns only the DECISIONS — which delivery, how big, how
 * far in. Choosing WHAT IS IN SHOT is a spatial judgement about a picture, so it
 * belongs on the picture: the monitor is dragged directly. This is the same split
 * as captions, where the style lives here and the placement is a drag on the
 * frame, and for the same reason — a pair of numeric x/y fields for "put the
 * speaker's face in the reel" is a worse tool than the face.
 *
 * Zoom is here as well as on the wheel because a slider is the only affordance
 * that shows its range and its current value, and because a trackpad wheel over a
 * video is a gesture people expect to scroll the page.
 */
function FrameField(p: Props) {
  const { frame } = p;
  const source = { width: p.project.width ?? 0, height: p.project.height ?? 0 };
  const out = frameSize(frame, source);
  // A crop only exists where the picture overflows the frame. At the source
  // preset with no zoom there is nothing to move, and saying so beats offering a
  // control that silently does nothing.
  const cropped =
    frame.zoom > 1 ||
    (source.width > 0 && Math.abs(out.width / out.height - source.width / source.height) > 0.01);
  // The zoom that shows all of the source. 1 when the shapes already match.
  const fit = fitZoom(source, out);

  const presetName =
    frame.preset === 'source' ? 'Source'
      : frame.preset === 'custom' ? 'Custom'
        : FRAME_PRESETS[frame.preset].label;
  // The zoom only earns a place in the header when it is doing something. At 1×
  // it is the default and saying "1.00×" would spend the row's scarcest space on
  // the absence of a decision.
  const zoomed = Math.abs(frame.zoom - 1) >= 0.005;

  const setPreset = (preset: FramePreset) => {
    // Panning is expressed as a fraction of the overflow, so it stays meaningful
    // across a preset change — the same 0.3 keeps framing the same third of the
    // picture whether the crop is 9:16 or 1:1. Only the size changes here.
    const next = normalizeFrame(
      preset === 'custom'
        ? { ...frame, preset, width: out.width, height: out.height }
        : { ...frame, preset },
    );
    p.setFrame(next);
  };

  return (
    <Section
      icon="crop"
      label="Frame"
      value={`${presetName} · ${out.width}×${out.height}${zoomed ? ` · ${frame.zoom.toFixed(2)}×` : ''}`}
    >
      <Segmented
        name="frame-preset"
        value={frame.preset}
        onChange={(v) => setPreset(v as FramePreset)}
        options={[
          ['source', 'Source'],
          ['reel', 'Reel'],
          ['youtube', 'YouTube'],
          ['square', 'Square'],
          ['custom', 'Custom'],
        ]}
      />

      {frame.preset === 'custom' ? (
        <div className="dim-input">
          <label>
            <span>Width</span>
            <input
              type="number"
              min={MIN_DIM}
              max={MAX_DIM}
              step={2}
              value={frame.width}
              onChange={(e) => p.setFrame(normalizeFrame({ ...frame, width: Number(e.target.value) }))}
            />
          </label>
          <span className="dim-x">×</span>
          <label>
            <span>Height</span>
            <input
              type="number"
              min={MIN_DIM}
              max={MAX_DIM}
              step={2}
              value={frame.height}
              onChange={(e) => p.setFrame(normalizeFrame({ ...frame, height: Number(e.target.value) }))}
            />
          </label>
        </div>
      ) : (
        <Hint>
          {frame.preset === 'source'
            ? `Keeps the source resolution — ${out.width}×${out.height}.`
            : `${FRAME_PRESETS[frame.preset].hint} — ${out.width}×${out.height}.`}
        </Hint>
      )}

      <Slider
        value={frame.zoom}
        min={MIN_ZOOM}
        max={MAX_ZOOM}
        step={0.01}
        onChange={(zoom) => p.setFrame({ ...frame, zoom })}
        format={(v) =>
          Math.abs(v - 1) < 0.005
            ? 'Fill the frame'
            : `${v < 1 ? 'Out' : 'In'} — ${v.toFixed(2)}×`
        }
        onPointerDown={p.onFrameDragStart}
        onPointerUp={() => p.onFrameDragEnd('Zoom frame')}
      />

      <Hint>
        {cropped
          ? 'Drag the picture in the monitor to choose what stays in shot. Scroll over it to zoom.'
          : 'The source already fills this frame. Zoom, or pick another size, to change the shot.'}
        {' '}
        Below 1× the whole picture fits and the rest of the frame is filled black.
      </Hint>

      <div className="frame-actions">
        {/* Offered only when fit and fill are different pictures — at a matching
          * aspect they are the same, and a button that does nothing is noise. */}
        {fit < 0.995 && (
          <button
            type="button"
            disabled={Math.abs(frame.zoom - fit) < 0.005}
            onClick={() => p.setFrame({ ...frame, zoom: fit, x: 0, y: 0 })}
          >
            Fit whole video
          </button>
        )}
        {(frame.zoom !== 1 || frame.x !== 0 || frame.y !== 0) && (
          <button type="button" onClick={() => p.setFrame({ ...frame, zoom: 1, x: 0, y: 0 })}>
            Fill frame
          </button>
        )}
      </div>
    </Section>
  );
}

/**
 * Push-ins: the marked object, and the shot that follows it.
 *
 * A section of its own rather than more controls inside Frame, and the division
 * is the same one the panel already draws between Edit and Output: Frame is one
 * decision about the whole video, and this is a list of decisions about MOMENTS
 * in it. Folding a list into a settings row is what makes a settings row read as
 * a dump.
 *
 * The header counts them, because that is the one number that decides whether
 * the section is worth opening — the same rule Clean up follows.
 *
 * Nothing here places a move. Marking is a spatial judgement about a picture, so
 * it happens ON the picture (the monitor's marquee), and choosing WHEN happens
 * in the script, where the words are. This panel owns only what is left: how far
 * in, how long the ease, and whether it follows.
 */
function MovesField(p: Props) {
  const moves = p.frame.moves;
  const hasVideo = Boolean(p.project.hasVideo);

  return (
    <Section
      icon="target"
      label="Push-ins"
      value={moves.length === 0 ? 'None' : `${moves.length}`}
    >
      {!hasVideo ? (
        <Hint>This project is audio only, so there is no picture to push in on.</Hint>
      ) : moves.length === 0 ? (
        <Hint>
          Select the words you want to punch in on, then choose “Push in here”. You mark the object
          on the picture and it holds — or follows — for as long as those words last.
        </Hint>
      ) : (
        <ul className="moves">
          {moves.map((m) => {
            const tracked = m.path.length > 0;
            const busy = p.following?.id === m.id;
            return (
              <li key={m.id} className={`move${p.markingMoveId === m.id ? ' marking' : ''}`}>
                <button
                  type="button"
                  className="move-when"
                  onClick={() => p.onSeek(m.start)}
                  title="Jump to the start of this push-in"
                >
                  {timecode(m.start)} – {timecode(m.end)}
                  <small>
                    {m.zoom.toFixed(2)}× · {tracked ? `following (${m.path.length} points)` : 'held'}
                  </small>
                </button>

                <Slider
                  value={m.zoom}
                  min={1}
                  max={MAX_PUNCH_ZOOM}
                  step={0.05}
                  onChange={(zoom) => p.onSetMove(m.id, { zoom })}
                  onPointerDown={p.onFrameDragStart}
                  onPointerUp={() => p.onFrameDragEnd(`Set push-in to ${m.zoom.toFixed(2)}×`)}
                  format={(v) => (v <= 1.001 ? 'No push-in' : `${v.toFixed(2)}× in`)}
                />

                <Slider
                  value={Math.min(m.ease, (m.end - m.start) / 2)}
                  min={0}
                  max={Math.max(0.1, (m.end - m.start) / 2)}
                  step={0.05}
                  onChange={(ease) => p.onSetMove(m.id, { ease })}
                  onPointerDown={p.onFrameDragStart}
                  onPointerUp={() => p.onFrameDragEnd('Set push-in ease')}
                  format={(v) => (v < 0.03 ? 'Hard cut in and out' : `${v.toFixed(2)}s ease`)}
                />

                <div className="move-actions">
                  <button type="button" onClick={() => p.onMarkMove(m.id)} disabled={busy}>
                    {p.markingMoveId === m.id ? 'Marking…' : tracked ? 'Re-mark' : 'Mark object'}
                  </button>
                  {/* Following needs something to follow, so it is offered only
                    * once a box has been marked — at the default centre framing
                    * a tracker would lock onto whatever happens to be in the
                    * middle of the frame and follow that with total confidence. */}
                  <button
                    type="button"
                    onClick={() => (tracked ? p.onClearFollow(m.id) : p.onFollowMove(m.id))}
                    disabled={busy || m.zoom <= 1.001}
                  >
                    {busy
                      ? `Following… ${Math.round((p.following?.progress ?? 0) * 100)}%`
                      : tracked
                        ? 'Stop following'
                        : 'Follow this'}
                  </button>
                  <button
                    type="button"
                    className="link danger"
                    onClick={() => p.onRemoveMove(m.id)}
                    disabled={busy}
                  >
                    Remove
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {hasVideo && moves.length > 0 && (
        <Hint>
          Following re-reads the video a few times a second, so it takes a moment. It holds the last
          good position when it loses the subject rather than guessing — if a follow drifts, mark it
          again on a frame where the subject is clearer.
        </Hint>
      )}
    </Section>
  );
}

/**
 * Image inserts: a picture over the video while a word is said.
 *
 * A sibling of Push-ins and shaped the same way, for the same reason: this is a
 * list of decisions about MOMENTS, not one decision about the whole video.
 *
 * Nothing here PLACES an insert either. Choosing when is a judgement about the
 * words, so it happens in the script (select, then “Show an image here”); this
 * panel owns what is left — which is exactly the two things the picture cannot
 * tell you on its own: how it arrives, and how long it stays.
 *
 * ── why the transition is a row of buttons and not a dropdown ────────────────
 *
 * There are six of them and they are the reason most people open this section.
 * A <select> hides five of the six behind a click and gives the one on show no
 * more weight than the others; the difference between a dissolve and a hard cut
 * is the single most visible choice here, so it costs one click and no reading.
 */
function ImagesField(p: Props) {
  const hasVideo = Boolean(p.project.hasVideo);
  const overlays = p.overlays;
  const [prompt, setPrompt] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  const submit = () => {
    const text = prompt.trim();
    if (!text || p.generatingImage) return;
    p.onGenerateImage(text);
    // Cleared on submit rather than on success: the picture is already on its
    // way and the next thing the user wants to type is the next one.
    setPrompt('');
  };

  return (
    <Section
      icon="image"
      label="Images"
      value={overlays.length === 0 ? 'None' : `${overlays.length}`}
    >
      {!hasVideo ? (
        <Hint>This project is audio only, so there is no picture to show an image over.</Hint>
      ) : (
        <>
          {/* Describe it, and it lands where the words are.
            *
            * The prompt is the whole input: `placeByPrompt` looks for the
            * prompt's subject in the script and puts the picture on the first
            * time it is said, so there is nothing to select first. Every row
            * below can be retargeted afterwards, which is what makes an
            * automatic placement safe to make at all. */}
          <Field label="Describe an image">
            <textarea
              rows={2}
              value={prompt}
              placeholder="a friendly robot waving"
              disabled={p.generatingImage || !p.canGenerateImages}
              onChange={(e) => setPrompt(e.currentTarget.value)}
              onKeyDown={(e) => {
                // Enter submits; Shift+Enter is a newline. A prompt is a
                // sentence, not a document.
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
            />
            <button onClick={submit} disabled={p.generatingImage || !prompt.trim() || !p.canGenerateImages}>
              {p.generatingImage ? 'Generating…' : 'Generate and place'}
            </button>
            {p.canGenerateImages ? (
              <Hint>
                It is made at this video’s own shape, and placed on the first time you say what you
                asked for. Move it afterwards if it guessed wrong.
              </Hint>
            ) : (
              <Hint>
                Image generation needs a Gemini API key on the server. You can still import a file.
              </Hint>
            )}
            <input
              ref={fileInput}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => {
                const file = e.currentTarget.files?.[0];
                // Cleared at once so picking the SAME file twice still fires a
                // change event — otherwise a failed import cannot be retried.
                e.currentTarget.value = '';
                if (file) p.onImportImage(file);
              }}
            />
            <button
              type="button"
              className="link"
              disabled={p.generatingImage}
              onClick={() => fileInput.current?.click()}
            >
              Import a file instead
            </button>
          </Field>

          {overlays.length === 0 ? (
            <Hint>No images on this video yet.</Hint>
          ) : (
        <ul className="moves">
          {overlays.map((o) => {
            const url = p.imageUrls[o.assetId];
            const span = o.end - o.start;
            const full = o.box.width > 0.95 && o.box.height > 0.95;
            return (
              <li key={o.id} className={`move${p.editingOverlayId === o.id ? ' marking' : ''}`}>
                <button
                  type="button"
                  className="move-when"
                  onClick={() => p.onSeek(o.start)}
                  title="Jump to the start of this image"
                >
                  {/* The picture names the row. A filename is what the file
                    * system calls it; the thumbnail is what the user calls it. */}
                  {url && <img className="ov-thumb" src={url} alt="" />}
                  <span>
                    {o.wordText ? `“${o.wordText}”` : timecode(o.start)}
                    <small>
                      {timecode(o.start)} – {timecode(o.end)} · {span.toFixed(1)}s ·{' '}
                      {p.imageNames[o.assetId] ?? 'missing picture'}
                    </small>
                  </span>
                </button>

                {/* Which word it plays on, as an editable field.
                  *
                  * The cheap half of correcting an automatic placement: the user
                  * can already NAME the word, so making them find it in the
                  * script and drag over it is asking for a scroll to fix a typo.
                  * Selecting words still works (SelectionPanel's "Move … here")
                  * and is the right tool for a phrase or an exact moment; this
                  * is the one for "no, the OTHER robot". */}
                <OverlayWordField
                  value={o.wordText ?? ''}
                  onSubmit={(text) => p.onRetargetOverlayToWord(o.id, text)}
                />

                <div className="ov-transitions">
                  {OVERLAY_TRANSITIONS.map((t) => (
                    <button
                      key={t}
                      type="button"
                      className={o.transition === t ? 'on' : ''}
                      onClick={() => p.onSetOverlay(o.id, { transition: t })}
                      title={TRANSITION_HELP[t]}
                    >
                      {TRANSITION_LABEL[t]}
                    </button>
                  ))}
                </div>

                {/* Meaningless on a hard cut, so it is not offered there — a
                  * slider that cannot change anything is worse than no slider. */}
                {o.transition !== 'cut' && (
                  <Slider
                    value={Math.min(o.ease, span / 2)}
                    min={0}
                    max={Math.max(0.1, span / 2)}
                    step={0.05}
                    onChange={(ease) => p.onSetOverlay(o.id, { ease })}
                    onPointerDown={p.onOverlayDragStart}
                    onPointerUp={() => p.onOverlayDragEnd('Set image transition')}
                    format={(v) => (v < 0.03 ? 'Instant' : `${v.toFixed(2)}s in and out`)}
                  />
                )}

                <Slider
                  value={span}
                  min={MIN_OVERLAY_SEC}
                  max={Math.max(MIN_OVERLAY_SEC + 0.1, 15)}
                  step={0.1}
                  onChange={(len) => p.onSetOverlay(o.id, { end: o.start + len })}
                  onPointerDown={p.onOverlayDragStart}
                  onPointerUp={() => p.onOverlayDragEnd('Set image duration')}
                  format={(v) => `${v.toFixed(1)}s on screen`}
                />

                <div className="move-actions">
                  {/* No "move to selection" here, deliberately.
                    *
                    * The rail swaps this whole panel out for SelectionPanel the
                    * moment anything is selected, so a retarget button in this
                    * list could never be pressed with a selection to act on —
                    * it would be permanently disabled furniture. The escape
                    * hatch from an automatic placement lives in SelectionPanel
                    * instead, where the words you are pointing at are on screen. */}
                  <button
                    type="button"
                    onClick={() =>
                      p.onSetOverlay(o.id, {
                        box: full
                          ? { x: 0.6, y: 0.58, width: 0.34, height: 0.34 }
                          : { x: 0, y: 0, width: 1, height: 1 },
                      })
                    }
                  >
                    {full ? 'Make it a corner card' : 'Fill the frame'}
                  </button>
                  <button
                    type="button"
                    onClick={() => p.onEditOverlay(p.editingOverlayId === o.id ? null : o.id)}
                  >
                    {p.editingOverlayId === o.id ? 'Done framing' : 'Show while framing'}
                  </button>
                  <button
                    type="button"
                    className="link danger"
                    onClick={() => p.onRemoveOverlay(o.id)}
                  >
                    Remove
                  </button>
                </div>
              </li>
            );
          })}
            </ul>
          )}
        </>
      )}
    </Section>
  );
}

/**
 * The word an insert plays on, editable in place.
 *
 * Local state rather than a controlled field driven by the overlay, because the
 * two disagree ON PURPOSE while you are typing: half of "robot" is not a word to
 * go looking for, and re-placing the image on every keystroke would move it four
 * times and push four undo steps. It commits on Enter or on blur, and Escape
 * puts back whatever the overlay actually says.
 *
 * `key`ed on the incoming value by the caller's list, so an overlay retargeted
 * from somewhere else (the selection button, the assistant) refreshes the field
 * rather than showing a stale word.
 */
function OverlayWordField({ value, onSubmit }: { value: string; onSubmit: (text: string) => void }) {
  const [draft, setDraft] = useState(value);
  // The overlay moved under us — adopt the new word, unless the user is
  // mid-edit, in which case their text is the more recent intention.
  const [dirty, setDirty] = useState(false);
  if (!dirty && draft !== value) setDraft(value);

  const commit = () => {
    const text = draft.trim();
    setDirty(false);
    if (!text || text === value) return setDraft(value);
    onSubmit(text);
  };

  return (
    <label className="ov-word">
      <span>on the word</span>
      <input
        type="text"
        value={draft}
        placeholder="robot"
        onChange={(e) => {
          setDraft(e.currentTarget.value);
          setDirty(true);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            e.currentTarget.blur(); // blur commits, so Enter and click-away agree
          }
          if (e.key === 'Escape') {
            setDraft(value);
            setDirty(false);
            e.currentTarget.blur();
          }
        }}
        onBlur={commit}
      />
    </label>
  );
}

/** Short enough to sit in a row of six without wrapping. */
const TRANSITION_LABEL: Record<OverlayTransition, string> = {
  cut: 'Cut',
  fade: 'Fade',
  'slide-left': '←',
  'slide-right': '→',
  'slide-up': '↑',
  'slide-down': '↓',
};

/** The arrows say WHERE IT COMES FROM, which an arrow alone cannot. */
const TRANSITION_HELP: Record<OverlayTransition, string> = {
  cut: 'Appears and disappears instantly',
  fade: 'Dissolves in and out',
  'slide-left': 'Slides in from the left, and leaves the way it came',
  'slide-right': 'Slides in from the right, and leaves the way it came',
  'slide-up': 'Slides in from the top, and leaves the way it came',
  'slide-down': 'Slides in from the bottom, and leaves the way it came',
};

/**
 * The colour grade: how the picture looks.
 *
 * ── the chips are the footage, not swatches ──────────────────────────────────
 *
 * Each look is previewed on THIS PROJECT'S poster frame, wearing the very SVG
 * filter the monitor would wear — the same resolveColor, the same coefficients,
 * the same code path. A row of abstract gradient tiles would be a legend for the
 * looks; this is the looks. "Warm" means nothing until you have seen what it does
 * to the face that is actually in the shot, and every one of these is a decision
 * about a face.
 *
 * ── a preset is a starting point, not a mode ─────────────────────────────────
 *
 * The sliders below are the SAME six numbers the chips set, so touching one
 * continues from where the look left off rather than dropping out of it. The
 * preset field then reads 'custom', exactly as FrameField's does once a custom
 * size is typed — it records where you started, and the header says so.
 */
function ColorField(p: Props) {
  const { color } = p;
  // useId's output is only guaranteed unique, not URL-safe — React 19 spells it
  // «r0», and these ids are referenced as `url(#…)` fragments rather than looked
  // up as selectors. Keeping the alphanumerics is enough to stay unique and
  // removes the question.
  const chipId = `grade${useId().replace(/[^a-zA-Z0-9]/g, '')}`;

  // Grading is a picture operation, and the server drops it for an audio-only
  // project. Say that rather than offering seven looks for a waveform.
  if (!p.project.hasVideo) {
    return (
      <Section icon="contrast" label="Colour" value="Audio only">
        <Hint>Grading changes the picture. This project has no video track.</Hint>
      </Section>
    );
  }

  const set = (next: Partial<ColorSettings>) => p.setColor({ ...color, ...next, preset: 'custom' });

  // Every knob, in the order they are dialled in practice: get the exposure and
  // the white balance right first, then decide how much of a look to put on top.
  const knobs: Array<{
    key: keyof Omit<ColorSettings, 'preset'>;
    label: string;
    min: number;
    max: number;
    format: (v: number) => string;
  }> = [
    { key: 'exposure', label: 'Exposure', min: -1, max: 1, format: (v) => stops(v) },
    { key: 'temperature', label: 'Temperature', min: -1, max: 1, format: (v) => bipolar(v, 'Cooler', 'Warmer') },
    { key: 'tint', label: 'Tint', min: -1, max: 1, format: (v) => bipolar(v, 'Greener', 'Magenta') },
    {
      key: 'saturation',
      label: 'Saturation',
      min: MIN_SATURATION,
      max: MAX_SATURATION,
      format: (v) => (v === 0 ? 'Black and white' : `${Math.round(v * 100)}%`),
    },
    { key: 'contrast', label: 'Contrast', min: -1, max: 1, format: (v) => bipolar(v, 'Flatter', 'Punchier') },
    { key: 'shadows', label: 'Shadows', min: -1, max: 1, format: (v) => bipolar(v, 'Crushed', 'Lifted') },
  ];

  return (
    <Section icon="contrast" label="Colour" value={colorSummary(color)}>
      <div className="grade-chips">
        {(['none', ...(Object.keys(COLOR_PRESETS) as Array<keyof typeof COLOR_PRESETS>)] as ColorPreset[]).map(
          (preset) => (
            <GradeChip
              key={preset}
              id={`${chipId}-${preset}`}
              preset={preset}
              posterUrl={p.project.posterUrl}
              // Chosen when the look is this one AND nothing has been moved since.
              // An edited Warm is no longer the Warm chip: highlighting it would
              // misreport what is about to be exported.
              chosen={isExactly(color, preset)}
              onPick={() => p.setColor(presetSettings(preset))}
            />
          ),
        )}
      </div>

      {knobs.map((k) => (
        <Field key={k.key} label={k.label}>
          <Slider
            value={color[k.key]}
            min={k.min}
            max={k.max}
            step={0.01}
            onChange={(v) => set({ [k.key]: v })}
            format={k.format}
            onPointerDown={p.onColorDragStart}
            onPointerUp={() => p.onColorDragEnd(`Adjust ${k.label.toLowerCase()}`)}
          />
        </Field>
      ))}

      <Hint>
        The grade is applied to the picture only — a burned caption stays the colour you set it,
        in the monitor and in the file.
      </Hint>

      {color.preset !== 'none' && (
        <div className="frame-actions">
          <button type="button" onClick={() => p.setColor(presetSettings('none'))}>
            Remove grade
          </button>
        </div>
      )}
    </Section>
  );
}

/**
 * One look, shown on the project's own frame.
 *
 * Falls back to a colour ramp when there is no poster yet — the server builds
 * those lazily from the dashboard listing, so a project opened straight after
 * import genuinely may not have one. The ramp wears the same filter, so it still
 * shows the grade rather than standing in for it.
 */
function GradeChip({
  id,
  preset,
  posterUrl,
  chosen,
  onPick,
}: {
  id: string;
  preset: ColorPreset;
  posterUrl?: string;
  chosen: boolean;
  onPick: () => void;
}) {
  const settings = presetSettings(preset);
  const grade = resolveColor(settings);
  const label = preset === 'none' ? 'None' : COLOR_PRESETS[preset as keyof typeof COLOR_PRESETS].label;
  const title = preset === 'none' ? 'No grade' : COLOR_PRESETS[preset as keyof typeof COLOR_PRESETS].hint;

  return (
    <button
      type="button"
      className={`grade-chip${chosen ? ' chosen' : ''}`}
      aria-pressed={chosen}
      title={title}
      onClick={onPick}
    >
      <GradeFilter id={id} grade={grade} />
      <span className="grade-chip-img" style={grade ? { filter: `url(#${id})` } : undefined}>
        {posterUrl ? <img src={posterUrl} alt="" loading="lazy" /> : <span className="grade-chip-ramp" />}
      </span>
      <span className="grade-chip-name">{label}</span>
    </button>
  );
}

/** True when the grade is still exactly the look it was picked from. */
function isExactly(color: ColorSettings, preset: ColorPreset): boolean {
  const at = presetSettings(preset);
  return (Object.keys(at) as Array<keyof ColorSettings>).every((k) => at[k] === color[k]);
}

/** "+0.35 stops", and the one value that is worth spelling out in words. */
function stops(v: number): string {
  if (Math.abs(v) < 0.005) return 'As shot';
  return `${v > 0 ? '+' : '−'}${Math.abs(v).toFixed(2)} stops`;
}

/** A knob that means two opposite things either side of zero says which it is on. */
function bipolar(v: number, below: string, above: string): string {
  if (Math.abs(v) < 0.005) return 'Neutral';
  return `${v < 0 ? below : above} ${Math.round(Math.abs(v) * 100)}%`;
}

/**
 * The background-music bed: import, volume, and how long it plays.
 *
 * The defining behaviour, said in the hint because it is the surprising part:
 * the bed rides UNDER the finished cut and is never chopped with the words. So
 * its length is measured on the OUTPUT clock — "play music for the first 20s of
 * the final video" — not on the source. Volume and length persist per project
 * (debounced by App); there is no history entry, so no drag-commit dance.
 */
function MusicField(p: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const music = p.project.music;
  const [browsing, setBrowsing] = useState(false);

  const pick = () => inputRef.current?.click();
  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) p.onImportMusic(file);
    e.target.value = ''; // let the same file re-fire onChange
  };

  // Length lives on the output clock. Without looping it can be no longer than
  // the file itself (a bed would otherwise trail off into silence); with looping
  // it can run the whole program. Either way the video length is the ceiling.
  // Absent means looping, not off — a bed that stops halfway through the video is
  // something you choose, never something you get by default. See bedLoops.
  const loop = music ? bedLoops(music) : false;
  const lenCeil = loop ? p.stats.outputSec : Math.min(music?.sourceDuration ?? 0, p.stats.outputSec);
  const maxLen = Math.max(1, Math.floor(lenCeil));
  const trimmed = music?.durationSec !== undefined;
  const lenValue = Math.min(maxLen, Math.round(music?.durationSec ?? maxLen));

  return (
    <Section icon="music" label="Background music" value={music ? music.name : 'None'}>
      <input ref={inputRef} type="file" accept="audio/*" hidden onChange={onFile} />

      {!music ? (
        <>
          <div className="music-sources">
            <button onClick={() => setBrowsing((v) => !v)} disabled={p.musicBusy}>
              {browsing ? 'Close browser' : 'Browse free music…'}
            </button>
            <button className="link" onClick={pick} disabled={p.musicBusy}>
              {p.musicBusy ? 'Importing…' : 'Import a file…'}
            </button>
          </div>
          <Hint>
            A music bed under the finished video. It plays across the whole cut — never chopped with
            the words — and you set its volume and how long it runs.
          </Hint>
          {browsing && (
            <MusicBrowser
              providers={p.musicProviders}
              busy={p.musicBusy}
              onPick={(t) => {
                p.onPickMusic(t);
                setBrowsing(false);
              }}
            />
          )}
        </>
      ) : (
        <>
          <div className="music-file">
            <span className="music-name" title={music.name}>{music.name}</span>
            <div className="font-actions">
              <button className="link" onClick={() => setBrowsing((v) => !v)} disabled={p.musicBusy}>
                {browsing ? 'Close' : 'Browse…'}
              </button>
              <button className="link" onClick={pick} disabled={p.musicBusy}>Replace…</button>
              <button className="link danger" onClick={p.onRemoveMusic} disabled={p.musicBusy}>Remove</button>
            </div>
          </div>

          {browsing && (
            <MusicBrowser
              providers={p.musicProviders}
              busy={p.musicBusy}
              onPick={(t) => {
                p.onPickMusic(t);
                setBrowsing(false);
              }}
            />
          )}

          {/* The credit, when the bed came from the picker. Not a Hint but a
            * Warn, because it is not advice: a CC BY track used without this
            * line in the video's description breaks the licence, and the person
            * who has to act on that is the one exporting. Imported files have no
            * attribution and show nothing. */}
          {music.attribution && (
            <Warn>
              Credit required — put this in your video description:
              <span className="music-credit">{music.attribution}</span>
              {music.sourceLink && (
                <a href={music.sourceLink} target="_blank" rel="noreferrer noopener">Track page</a>
              )}
            </Warn>
          )}

          <Slider
            value={Math.round(music.volume * 100)}
            min={0}
            max={100}
            step={5}
            onChange={(v) => p.onUpdateMusic({ volume: v / 100 })}
            format={(v) => `${v}% volume`}
          />

          <Check
            checked={loop}
            onChange={(v) => p.onUpdateMusic(v ? { loop: true, durationSec: null } : { loop: false })}
            label="Loop to fill the video"
          />

          <Check
            checked={trimmed}
            onChange={(v) => p.onUpdateMusic({ durationSec: v ? maxLen : null })}
            label="Limit how long it plays"
          />
          {trimmed && (
            <Slider
              value={lenValue}
              min={1}
              max={maxLen}
              step={1}
              onChange={(v) => p.onUpdateMusic({ durationSec: v })}
              format={(v) => `Plays for ${timecode(v)}`}
            />
          )}

          <Hint>
            Or drag the music track’s right edge in the timeline to trim it, and “Fill” to loop it
            across the whole video.
          </Hint>
        </>
      )}
    </Section>
  );
}

/**
 * Search the web for a bed, audition it, take one.
 *
 * Audition is the point. A music bed is chosen by ear in about four seconds, so
 * the flow is search → click play → click play → Use, and nothing is downloaded
 * until that last click: preview streams straight from the provider's CDN into
 * one shared <audio>, costing this app nothing per track heard.
 *
 * One <audio> and not one per row, because two beds playing at once is never
 * what anyone meant — starting a track is also how you stop the last one.
 */
function MusicBrowser({ providers, busy, onPick }: {
  providers: MusicProvider[];
  busy: boolean;
  onPick: (track: MusicResult) => void;
}) {
  const [q, setQ] = useState('');
  const [instrumental, setInstrumental] = useState(true);
  const [provider, setProvider] = useState<MusicProvider>(providers[0] ?? 'openverse');
  const [results, setResults] = useState<MusicResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  // Search on submit, not on keystroke. Both catalogues are public goods on
  // donated infrastructure — Openverse allows 200 anonymous searches a DAY — and
  // debounced search-as-you-type would spend that budget on prefixes nobody
  // meant to search for.
  const search = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!q.trim() || searching) return;
    setSearching(true);
    setError(null);
    try {
      const r = await api.music.search(q, { instrumental, provider });
      setResults(r.results);
    } catch (err) {
      setResults(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSearching(false);
    }
  };

  const toggle = (track: MusicResult) => {
    const el = audioRef.current;
    if (!el) return;
    if (playing === track.id) {
      el.pause();
      setPlaying(null);
      return;
    }
    el.src = track.previewUrl;
    el.play().then(
      () => setPlaying(track.id),
      // A CDN hiccup or a dead track should not look like a broken app.
      () => setError(`Could not play “${track.title}”.`),
    );
  };

  return (
    <div className="music-browser">
      <form className="music-search" onSubmit={search}>
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="calm piano, upbeat, cinematic…"
          aria-label="Search free music"
        />
        <button type="submit" disabled={searching || !q.trim()}>
          {searching ? '…' : 'Search'}
        </button>
      </form>

      <Check
        checked={instrumental}
        onChange={setInstrumental}
        label="Instrumental only"
      />
      {/* On by default and worth defending: a bed with a vocal fights the voice
        * it is sitting under. Jamendo filters on it properly; Openverse has no
        * such field, so there it only weights the keywords. */}
      {provider === 'openverse' && instrumental && (
        <Hint>Openverse has no instrumental filter — this only nudges the search terms.</Hint>
      )}

      {providers.length > 1 && (
        <Segmented
          name="music-provider"
          value={provider}
          onChange={(v) => {
            setProvider(v as MusicProvider);
            setResults(null);
          }}
          options={providers.map((id) => [id, id === 'jamendo' ? 'Jamendo' : 'Openverse'] as [string, string])}
        />
      )}

      {/* alert, because this box is the ONLY report that a search you just ran
        * failed — nothing takes focus and nothing else says so. */}
      {error && <Warn alert>{error}</Warn>}

      {results?.length === 0 && (
        <p className="music-empty">
          Nothing matched. Try a mood rather than a title — “warm”, “tense”, “lo-fi”.
        </p>
      )}

      {results && results.length > 0 && (
        <ul className="music-results">
          {results.map((t) => (
            <li key={t.id} className={playing === t.id ? 'music-hit on' : 'music-hit'}>
              <button
                className="music-play"
                onClick={() => toggle(t)}
                aria-label={playing === t.id ? `Stop ${t.title}` : `Preview ${t.title}`}
              >
                {playing === t.id ? '❚❚' : '▶'}
              </button>
              <span className="music-meta">
                <span className="music-title" title={t.title}>{t.title}</span>
                <span className="music-sub">
                  {t.artist} · {timecode(t.durationSec)}
                  {t.license && <em className="music-lic">CC {t.license.toUpperCase()}</em>}
                </span>
              </span>
              <button className="link" disabled={busy} onClick={() => onPick(t)}>
                Use
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* Said once, here, where a track is chosen — rather than only at export,
        * when it is too late to pick a different one. */}
      <Hint>
        Creative Commons tracks. Most require crediting the artist in your video description —
        the credit line is kept with the project once you pick one.
      </Hint>

      <audio ref={audioRef} onEnded={() => setPlaying(null)} hidden />
    </div>
  );
}

/**
 * Caption look and placement.
 *
 * The controls only appear once captions are on. Off is the default and the
 * common case, and a dozen dimmed inputs for a feature you are not using is
 * most of what makes a panel read as a settings dump.
 */
function CaptionsField(p: Props) {
  const hasVideo = Boolean(p.project.hasVideo);
  const c = p.captions;
  const isBox = strokeRole(c.backdrop) === 'box';
  const set = (patch: Partial<CaptionSettings>) => p.setCaptions({ ...c, ...patch });

  /** Commit one history entry for a control with no pointerup of its own. */
  const commit = (label: string) => (patch: Partial<CaptionSettings>) => {
    p.onCaptionDragStart();
    p.setCaptions({ ...c, ...patch });
    p.onCaptionDragEnd(label);
  };

  const on = c.enabled && hasVideo;

  return (
    <Section
      icon="captions"
      label="Captions"
      /* `c.font` and not the CAPTION_FONTS label: the stored value is the family
       * name for BOTH a built-in and an imported font ("Arial", "Inter Tight"),
       * which is short and is what anyone recognises. The picker's labels are
       * long on purpose — "Sans — Arial / Liberation Sans" names the fallback
       * you get on a Linux render box — and one of those in a header would
       * truncate away the size, which is the number worth reading here. */
      value={on ? `${c.font} · ${c.fontSize}px` : undefined}
      toggle={{
        checked: on,
        onChange: (v) => commit(v ? 'Enable captions' : 'Disable captions')({ enabled: v }),
        disabled: !hasVideo,
        label: 'Burn captions into the video',
      }}
    >
      {!hasVideo && (
        <Hint>This project is audio only, so there is no picture to burn captions onto.</Hint>
      )}

      {on && (
        <>
          <Hint>Drag the caption on the monitor to place it, or its handles to size the box.</Hint>

          <FontPicker
            value={c.font}
            onChange={(font) => commit('Change caption font')({ font })}
            customFonts={p.customFonts}
            onImport={p.onImportFont}
            onRemove={p.onRemoveFont}
            busy={p.fontBusy}
          />

          <Slider
            value={c.fontSize}
            min={16}
            max={140}
            step={2}
            onPointerDown={p.onCaptionDragStart}
            onPointerUp={() => p.onCaptionDragEnd(`Set caption size to ${c.fontSize}`)}
            onChange={(v) => set({ fontSize: v })}
            // Authored at 1080p and scaled to the real frame, so the number is
            // stable across projects rather than meaning a different size in each.
            format={(v) => `${v}px at 1080p`}
          />

          <Color
            value={c.color}
            onChange={(v) => set({ color: v })}
            onCommit={() => commit('Change caption colour')({})}
            label={c.karaoke ? 'Spoken' : 'Text'}
          />

          <Check
            checked={c.karaoke}
            onChange={(v) => commit(v ? 'Enable word highlight' : 'Disable word highlight')({ karaoke: v })}
            label="Highlight each word as it is spoken"
          />
          {/* The direction surprises people, so the labels say it outright: the
            * highlight is what a word waits in, and "Spoken" is where it lands. */}
          {c.karaoke && (
            <Color
              value={c.highlightColor}
              onChange={(v) => set({ highlightColor: v })}
              onCommit={() => commit('Change highlight colour')({})}
              label="Not yet spoken"
            />
          )}
          {/* One ASS field, two jobs: BorderStyle 3 fills the box with the
            * OUTLINE colour and draws no glyph outline at all. Rather than
            * offer a dead control, the label follows what it actually paints. */}
          <Color
            value={c.strokeColor}
            onChange={(v) => set({ strokeColor: v })}
            onCommit={() => commit('Change caption outline')({})}
            label={isBox ? 'Box' : 'Outline'}
          />

          <Slider
            value={c.strokeWidth}
            min={0}
            max={12}
            step={1}
            onPointerDown={p.onCaptionDragStart}
            onPointerUp={() => p.onCaptionDragEnd(`Set caption outline to ${c.strokeWidth}px`)}
            onChange={(v) => set({ strokeWidth: v })}
            format={(v) =>
              isBox
                ? v === 0
                  ? 'Box hugs the text'
                  : `${v}px box padding`
                : v === 0
                  ? 'No outline'
                  : `${v}px outline`
            }
          />

          <Segmented
            name="backdrop"
            value={c.backdrop}
            onChange={(v) => commit('Change caption backdrop')({ backdrop: v as Backdrop })}
            options={[
              ['none', 'No backdrop'],
              ['shadow', 'Drop shadow'],
              ['box', 'Solid box'],
            ]}
          />
          {c.backdrop === 'none' && c.strokeWidth === 0 && (
            <Warn>
              With no outline and no backdrop, captions will disappear against light footage.
            </Warn>
          )}

          <Check
            checked={c.allCaps}
            onChange={(v) => commit('Toggle caption caps')({ allCaps: v })}
            label="ALL CAPS"
          />

          {/* The box, for anyone who would rather type a number than drag a
            * corner. Same two values the monitor's handles write, so the panel
            * and the frame are never showing different boxes. */}
          <Slider
            value={Math.round(c.boxWidth * 100)}
            min={Math.ceil(MIN_CAPTION_BOX.width * 100)}
            max={100}
            step={1}
            onPointerDown={p.onCaptionDragStart}
            onPointerUp={() => p.onCaptionDragEnd('Resize captions')}
            onChange={(v) => set({ boxWidth: v / 100 })}
            format={(v) => `${v}% wide`}
          />
          <Slider
            value={Math.round(c.boxHeight * 100)}
            min={Math.ceil(MIN_CAPTION_BOX.height * 100)}
            max={100}
            step={1}
            onPointerDown={p.onCaptionDragStart}
            onPointerUp={() => p.onCaptionDragEnd('Resize captions')}
            onChange={(v) => set({ boxHeight: v / 100 })}
            format={(v) => `${v}% tall`}
          />
          <Hint>
            Width folds a caption onto more lines without changing its words. Extra height is
            shared out between those lines as spacing.
          </Hint>

          <Slider
            value={c.maxChars}
            min={16}
            max={80}
            step={1}
            onPointerDown={p.onCaptionDragStart}
            onPointerUp={() => p.onCaptionDragEnd(`Split captions at ${c.maxChars} characters`)}
            onChange={(v) => set({ maxChars: v })}
            format={(v) => `Split past ${v} characters`}
          />
          {/* Three lines of hint was ~50px of a field that is already the
            * tallest thing in the panel. Same two facts, two lines. */}
          <Hint>
            How much text one caption holds — not how wide it is drawn. Applies to the downloaded
            subtitles too; 42 is the broadcast convention.
          </Hint>
        </>
      )}
    </Section>
  );
}

/* Cut padding and micro-fades are engine constants with correct defaults, not
 * decisions. Surfacing them as top-level sliders is a large part of why this
 * read as a debug panel.
 *
 * It is a Section like the rest now rather than a lone <details> slung under
 * both columns. Its old full-width, two-up shape existed to keep it off the
 * scroll; a row that is one line tall until you ask has no such problem, and
 * being the last row under EDIT is also where it belongs — every control in
 * here shapes the cut. */
function AdvancedField(p: Props) {
  return (
    <Section icon="sliders" label="Advanced">
        <Field label="Retake detection">
          <Slider
            value={p.retakeMin}
            min={2}
            max={8}
            step={1}
            onChange={p.setRetakeMin}
            format={(v) => `${v}+ repeated words`}
          />
          <Hint>Lower catches more false starts, but starts matching ordinary repetition.</Hint>
        </Field>

        <Field label="Cut shaping">
          <Slider
            value={p.cut.padMs}
            min={0}
            max={200}
            step={5}
            onPointerDown={p.onCutDragStart}
            onPointerUp={() => p.onCutDragEnd(`Set cut padding to ${p.cut.padMs}ms`)}
            onChange={(v) => p.setCut({ ...p.cut, padMs: v })}
            format={(v) => `${v}ms padding`}
          />
          <Hint>Breathing room around each cut. Too little clips consonants.</Hint>

          <Slider
            value={p.cut.fadeMs}
            min={0}
            max={50}
            step={1}
            onPointerDown={p.onCutDragStart}
            onPointerUp={() => p.onCutDragEnd(`Set crossfade to ${p.cut.fadeMs}ms`)}
            onChange={(v) => p.setCut({ ...p.cut, fadeMs: v })}
            format={(v) => (v === 0 ? 'No crossfade' : `${v}ms crossfade`)}
          />
          {p.cut.fadeMs === 0 && <Warn>0ms will click audibly at every cut.</Warn>}
        </Field>
    </Section>
  );
}
