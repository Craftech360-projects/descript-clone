import { useRef, useState } from 'react';
import { Field, Hint, Slider, Segmented, Warn, Check, Color } from '../ui/Field.tsx';
import { timecode } from '../../../../packages/core/src/timeline.ts';
import type { CutSettings } from '../../../../packages/core/src/doc.ts';
import {
  CAPTION_FONTS,
  strokeRole,
  type Backdrop,
  type CaptionSettings,
} from '../../../../packages/core/src/caption-style.ts';
import type { CustomFont, Project } from '../api.ts';

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
  const commit = () => {
    onAdd(draft);
    setDraft('');
  };

  return (
    <div className="custom-fillers">
      <div className="chip-input">
        <input
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
  // 0 is the sentinel for "keep every pause": Infinity does not survive JSON, so
  // the wire speaks 0 and the document holds Infinity.
  const gap = p.cut.maxGapMs === Infinity ? 0 : p.cut.maxGapMs;

  return (
    <div className="panel panel-project">
      {/* The output-length summary that led this panel now lives in the title bar,
        * beside Export — it is the document's running state, not a control. */}

      {/* Left: the words — which of them survive. The transcript's provenance and
        * the Re-transcribe action moved out: the summary lives in the Transcribe
        * dialog (it is the "before" a re-transcribe replaces), and the entry point
        * sits at the end of the script itself. */}
      <div className="pcol">
        <Field label="Clean up" collapsible>
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
        <Field label="Pauses" collapsible>
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

        <MusicField {...p} />

        <CaptionsField {...p} />
      </div>

      <Advanced {...p} />
    </div>
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

  const pick = () => inputRef.current?.click();
  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) p.onImportMusic(file);
    e.target.value = ''; // let the same file re-fire onChange
  };

  // Length lives on the output clock. Without looping it can be no longer than
  // the file itself (a bed would otherwise trail off into silence); with looping
  // it can run the whole program. Either way the video length is the ceiling.
  const loop = Boolean(music?.loop);
  const lenCeil = loop ? p.stats.outputSec : Math.min(music?.sourceDuration ?? 0, p.stats.outputSec);
  const maxLen = Math.max(1, Math.floor(lenCeil));
  const trimmed = music?.durationSec !== undefined;
  const lenValue = Math.min(maxLen, Math.round(music?.durationSec ?? maxLen));

  return (
    <Field label="Background music" collapsible>
      <input ref={inputRef} type="file" accept="audio/*" hidden onChange={onFile} />

      {!music ? (
        <>
          <button onClick={pick} disabled={p.musicBusy}>
            {p.musicBusy ? 'Importing…' : 'Import music…'}
          </button>
          <Hint>
            A music bed under the finished video. It plays across the whole cut — never chopped with
            the words — and you set its volume and how long it runs.
          </Hint>
        </>
      ) : (
        <>
          <div className="music-file">
            <span className="music-name" title={music.name}>{music.name}</span>
            <div className="font-actions">
              <button className="link" onClick={pick} disabled={p.musicBusy}>Replace…</button>
              <button className="link danger" onClick={p.onRemoveMusic} disabled={p.musicBusy}>Remove</button>
            </div>
          </div>

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
    </Field>
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
    <Field label="Captions" collapsible>
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
