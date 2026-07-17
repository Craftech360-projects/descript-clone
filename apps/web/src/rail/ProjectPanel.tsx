import { Field, Hint, Slider, Segmented, Warn, Check, Color } from '../ui/Field.tsx';
import { timecode } from '../../../../packages/core/src/timeline.ts';
import type { CutSettings } from '../../../../packages/core/src/doc.ts';
import {
  CAPTION_FONTS,
  strokeRole,
  type Backdrop,
  type CaptionSettings,
} from '../../../../packages/core/src/caption-style.ts';
import type { Project } from '../api.ts';

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
  busy: string | null;
}

/** What the mode flags, said once, instead of inside all three option labels. */
const FILLER_HINT: Record<FillerMode, string> = {
  off: 'Fillers are left alone and nothing is marked in the script.',
  hesitations: 'Flags um, uh, er — the sounds nobody means to say.',
  all: 'Also flags you know, I mean, sort of.',
};

/**
 * What the rail shows when nothing is selected.
 *
 * This is the reframe that retires the tabs: with no selection, the context IS
 * the document. The old "Cuts" tab was already the document's inspector — it
 * just sat in a row of pipeline stages and so read as one.
 *
 * On the arrangement, see .panel-project in app.css: the rail is wide and
 * short, so this is two columns — the words on the left, the render on the
 * right — rather than one stack that outran the box by 2-3x while half the
 * width sat unused.
 */
export default function ProjectPanel(p: Props) {
  const removed = Math.max(0, p.stats.sourceSec - p.stats.outputSec);
  // 0 is the sentinel for "keep every pause": Infinity does not survive JSON, so
  // the wire speaks 0 and the document holds Infinity.
  const gap = p.cut.maxGapMs === Infinity ? 0 : p.cut.maxGapMs;

  return (
    <div className="panel panel-project">
      {/* The one big number, and the three facts that qualify it. Stacked, these
        * were four short lines rattling around a 560px well; the width was
        * already paid for. */}
      <div className="hero stat">
        <div className="hero-main">
          <strong>{timecode(p.stats.outputSec)}</strong>
          <small>output</small>
        </div>
        <dl className="hero-stats">
          <div>
            <dt>Removed</dt>
            <dd>−{timecode(removed)}</dd>
          </div>
          <div>
            <dt>Segments</dt>
            <dd>{p.stats.cuts}</dd>
          </div>
          <div>
            <dt>Words kept</dt>
            <dd>
              {p.stats.kept}
              <span className="of">/{p.stats.words}</span>
            </dd>
          </div>
        </dl>
      </div>

      {/* Left: the words — where they came from, and which of them survive. */}
      <div className="pcol">
        <Field label="Transcript">
          <Hint>
            {p.stats.words} words · {p.asrProvider ?? 'unknown model'}
            {p.verbatim ? ' · verbatim' : ' · not verbatim'}
          </Hint>
          {!p.verbatim && (
            <Warn>
              This transcript is not verbatim — the model dropped fillers before you saw them, so
              the filler tool will find little to nothing. Re-transcribe with ElevenLabs Scribe v2
              to keep them.
            </Warn>
          )}
          <button onClick={p.onRetranscribe} disabled={!!p.busy}>Re-transcribe…</button>
        </Field>

        <Field label="Clean up">
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
        </Field>

      </div>

      {/* Right: the render — how it is paced, and what it says on screen.
        *
        * Pauses is here rather than next to Clean up, which is where it belongs
        * by meaning, because Captions swings from one checkbox to a dozen
        * controls and nothing else in the panel does. Alone on the right it
        * balanced the left beautifully with captions ON and left half the panel
        * blank with them OFF — which is the default. Pauses is the ballast that
        * keeps this column real in both states. */}
      <div className="pcol">
        <Field label="Pauses">
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
        </Field>

        <CaptionsField {...p} />
      </div>

      <Advanced {...p} />
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

  return (
    <Field label="Captions">
      <Check
        checked={c.enabled && hasVideo}
        onChange={(v) => commit(v ? 'Enable captions' : 'Disable captions')({ enabled: v })}
        disabled={!hasVideo}
        label="Burn captions into the video"
      />

      {!hasVideo && (
        <Hint>This project is audio only, so there is no picture to burn captions onto.</Hint>
      )}

      {c.enabled && hasVideo && (
        <>
          <Hint>Drag the caption on the monitor to place it.</Hint>

          <select
            value={c.font}
            onChange={(e) => commit('Change caption font')({ font: e.target.value })}
          >
            {CAPTION_FONTS.map((f) => (
              <option key={f.id} value={f.id}>{f.label}</option>
            ))}
          </select>

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
            label="Text"
          />
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

          <Slider
            value={c.maxChars}
            min={16}
            max={80}
            step={1}
            onPointerDown={p.onCaptionDragStart}
            onPointerUp={() => p.onCaptionDragEnd(`Wrap captions at ${c.maxChars} characters`)}
            onChange={(v) => set({ maxChars: v })}
            format={(v) => `Wrap past ${v} characters`}
          />
          {/* Three lines of hint was ~50px of a field that is already the
            * tallest thing in the panel. Same two facts, two lines. */}
          <Hint>
            Applies to the downloaded subtitles too, not just the burn. 42 is the broadcast
            convention.
          </Hint>
        </>
      )}
    </Field>
  );
}

/* Cut padding and micro-fades are engine constants with correct defaults, not
 * decisions. Surfacing them as top-level sliders is a large part of why this
 * read as a debug panel. Native <details>: full keyboard and screen-reader
 * support, no JS. */
function Advanced(p: Props) {
  return (
    <details className="advanced">
        <summary>Advanced</summary>

        {/* Spans both columns, so these two sit side by side rather than
          * extending the scroll by another 260px. */}
        <div className="adv-grid">
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
        </div>
    </details>
  );
}
