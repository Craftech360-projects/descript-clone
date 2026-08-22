import Icon from '../ui/Icon.tsx';
import { Check, Field, Hint, Segmented, Slider, Warn } from '../ui/Field.tsx';
import { formatSpeed } from '../store/editor.ts';
import {
  autoImportCount,
  AUTO_IMPORT_STEPS,
  AUTO_SPEEDS,
  MAX_PAUSE_MS,
  MIN_PAUSE_MS,
  type AutoImport,
} from '../store/autoImport.ts';
import type { Speaker } from '../speakers.ts';
import type { Clip } from '../api.ts';

interface Props {
  speakers: Speaker[];
  hasScript: boolean;
  /** The open project's clips, in play order. Empty when nothing is open. */
  clips: Clip[];
  activeClipId: string | null;
  addingClip: boolean;
  onAddClip: (file: File) => void;
  onRemoveClip: (clipId: string) => void;
  onMoveClip: (clipId: string, delta: -1 | 1) => void;
  onSelectClip: (clip: Clip) => void;
  /** The drawer is open. When closed it stays mounted (off-canvas) so it slides. */
  open: boolean;
  onClose: () => void;
  onSeek: (time: number) => void;

  /** The chain that runs itself on every import. See store/autoImport.ts. */
  autoImport: AutoImport;
  onAutoImport: (next: AutoImport) => void;
  /** No ASR provider configured — the chain cannot transcribe, so nor can it run. */
  canTranscribe: boolean;
  asrProviders: { elevenlabs: boolean; sarvam: boolean };
}

/**
 * The on-import chain, as a checklist in the order it runs.
 *
 * A list of switches rather than one master toggle because the steps are not
 * equally cheap: transcription spends real ElevenLabs credits per minute, and
 * the other four are free, local, and instant. Someone who wants the cleanup but
 * not the unattended spend has to be able to say so, and unchecking every box is
 * how the whole thing is turned off — no separate master to fall out of sync.
 *
 * Collapsed by default (Field's `collapsible`), so the drawer still reads as
 * Media / Clips / Speakers until you go looking for this.
 */
function AutoImportField({ value, onChange, canTranscribe, asrProviders }: {
  value: AutoImport;
  onChange: (next: AutoImport) => void;
  canTranscribe: boolean;
  asrProviders: { elevenlabs: boolean; sarvam: boolean };
}) {
  const set = <K extends keyof AutoImport>(key: K, v: AutoImport[K]) =>
    onChange({ ...value, [key]: v });

  const on = autoImportCount(value);
  // Everything below transcription needs a script. If the chain will not produce
  // one and the file arrives without one, those steps have nothing to act on.
  const stranded = !value.transcribe && on > 0;

  return (
    <Field label={`On import · ${on} of ${AUTO_IMPORT_STEPS.length}`} collapsible>
      <Hint>
        Runs on every file you import, in this order. It lands as a single edit —
        one Undo puts the raw transcript back.
      </Hint>

      <Check
        checked={value.transcribe}
        onChange={(v) => set('transcribe', v)}
        disabled={!canTranscribe}
        label="Transcribe"
      />
      {!canTranscribe && (
        <Hint>Needs ELEVENLABS_API_KEY on the server. Without it nothing here can run.</Hint>
      )}
      {canTranscribe && value.transcribe && (
        <Warn>
          This spends ASR credits on every file you import, without asking first. Switch it off
          if you would rather start transcription by hand.
        </Warn>
      )}
      {value.transcribe && asrProviders.elevenlabs && asrProviders.sarvam && (
        <Field label="Transcription provider">
          <select
            value={value.asrProvider}
            onChange={(e) => set('asrProvider', e.target.value === 'sarvam' ? 'sarvam' : 'elevenlabs')}
          >
            <option value="elevenlabs">ElevenLabs Scribe</option>
            <option value="sarvam">Sarvam Saaras v3</option>
          </select>
          <Hint>Used automatically on import while both API keys are available.</Hint>
        </Field>
      )}

      <Check
        checked={value.fillers}
        onChange={(v) => set('fillers', v)}
        label="Remove hesitations"
      />
      <Hint>
        um, uh, er — plus any words you added under Clean up. The wider “All” sweep stays manual:
        “sort of” and “I mean” are load-bearing often enough that nothing should cut them unasked.
      </Hint>

      <Check checked={value.pauses} onChange={(v) => set('pauses', v)} label="Cap pauses" />
      {value.pauses && (
        <Slider
          value={value.pauseCapMs}
          min={MIN_PAUSE_MS}
          max={MAX_PAUSE_MS}
          step={50}
          onChange={(v) => set('pauseCapMs', v)}
          format={(v) => `Shorten every silence to ${v}ms`}
        />
      )}

      {/* Beside Pauses, because both are pacing: one closes the gaps between the
        * words, the other plays the whole thing out faster. */}
      <Check checked={value.speed} onChange={(v) => set('speed', v)} label="Speed up" />
      {value.speed && (
        <>
          <Segmented
            name="auto-speed"
            value={String(value.speedValue)}
            onChange={(v) => set('speedValue', Number(v))}
            options={AUTO_SPEEDS.map((s) => [String(s), formatSpeed(s)] as [string, string])}
          />
          <Hint>
            The output clock only — every timestamp in the edit stays where it is, so cutting a
            word later still lands on the right frame. Below 1x is not offered here: an automatic
            speed step is for tightening, and the transport has the whole ladder for the one video
            that wants slowing down.
          </Hint>
        </>
      )}

      <Check
        checked={value.studioSound}
        onChange={(v) => set('studioSound', v)}
        label="Studio Sound"
      />

      <Check checked={value.captions} onChange={(v) => set('captions', v)} label="Captions" />

      {stranded && (
        <Warn>
          With Transcribe off, these only apply to a file that already has a script — a plain
          import arrives without one, so nothing will happen.
        </Warn>
      )}
    </Field>
  );
}

/** m:ss for a clip's length. */
function clipTime(seconds: number): string {
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * The left drawer: what the open project is made of, and who is in it.
 *
 * A drawer, not a column, so the transcript can own the left edge. It stays
 * mounted while closed (translated off-canvas) so opening and closing slide, and
 * a scrim over the workspace catches the click that dismisses it.
 *
 * It no longer lists the media library — that is the Dashboard's job, and the
 * duplicate meant switching projects had two doors. What is left is the open
 * project's clips, its speakers, and the chain that runs on import.
 */
export default function Library({
  speakers,
  hasScript,
  clips,
  activeClipId,
  addingClip,
  onAddClip,
  onRemoveClip,
  onMoveClip,
  onSelectClip,
  open,
  onClose,
  onSeek,
  autoImport,
  onAutoImport,
  canTranscribe,
  asrProviders,
}: Props) {
  return (
    <>
      {open && <div className="lib-scrim" onClick={onClose} />}
      {/* `inert`, not `aria-hidden`. The drawer is moved off-canvas with a
          transform and never unmounted, so its close button, switches and
          sliders stayed focusable: tabbing from the title bar walked focus into
          an invisible panel and appeared to lose it. `inert` removes it from the
          tab order and the accessibility tree together — and aria-hidden alone
          on a container with focusable children is itself an error. */}
      <aside className={open ? 'library open' : 'library'} inert={!open}>
        <div className="lib-top">
          <h2>Library</h2>
          <button className="icon" onClick={onClose} aria-label="Close library">
            <Icon name="close" size={16} />
          </button>
        </div>

      {/* Media — every project in the library, and a button to import another —
        * used to lead this drawer. It is gone: the Dashboard is that list, at a
        * size where a cover frame is worth looking at, and a second copy behind
        * the ☰ meant switching projects had two doors that behaved differently.
        * What is left is about the project you are IN.
        *
        * What happens to a file by itself, the moment it lands. It leads now: it
        * is the only thing here that is not about the open project, and it is the
        * setting that decides what "import" even means — whether the Dashboard's
        * new-project tile puts a file on disk or gets it ready to edit. */}
      <section className="lib-section lib-auto">
        <AutoImportField
          value={autoImport}
          onChange={onAutoImport}
          canTranscribe={canTranscribe}
          asrProviders={asrProviders}
        />
      </section>

      {/* The clips that make up the OPEN project, in play order. This is where a
        * second video is added into the current project — as opposed to Media
        * above, where a file becomes its own new project. */}
      {clips.length > 0 && (
        <section className="lib-section">
          <div className="lib-head">
            <h3>Clips</h3>
            <label className="import" title="Add a clip to this project">
              <Icon name="plus" size={13} />
              <input
                type="file"
                accept="video/*,audio/*"
                disabled={addingClip}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  // Clear the value even when we take the file. Without this the
                  // element still holds it, so re-picking the SAME file after a
                  // cancel or a failure fires no change event and the control is
                  // simply dead. Every other file input here does this.
                  e.target.value = '';
                  if (file) onAddClip(file);
                }}
              />
            </label>
          </div>

          <ul className="clip-list">
            {clips.map((c, i) => (
              <li key={c.id} className={c.id === activeClipId ? 'clip-row on' : 'clip-row'}>
                <button className="clip-main" onClick={() => onSelectClip(c)} title="Jump to this clip">
                  <span className="kind">
                    <Icon name={c.hasVideo ? 'video' : 'audio'} size={14} />
                  </span>
                  <span className="clip-nm">Clip {i + 1}</span>
                  <span className="clip-dur">{clipTime(c.duration)}</span>
                </button>
                <span className="clip-order">
                  <button
                    className="icon clip-move"
                    aria-label={`Move clip ${i + 1} earlier`}
                    title="Move earlier"
                    disabled={i === 0 || addingClip}
                    onClick={() => onMoveClip(c.id, -1)}
                  >
                    ▲
                  </button>
                  <button
                    className="icon clip-move"
                    aria-label={`Move clip ${i + 1} later`}
                    title="Move later"
                    disabled={i === clips.length - 1 || addingClip}
                    onClick={() => onMoveClip(c.id, 1)}
                  >
                    ▼
                  </button>
                </span>
                <button
                  className="icon clip-x"
                  aria-label={`Remove clip ${i + 1}`}
                  title={clips.length <= 1 ? 'A project needs at least one clip' : 'Remove clip'}
                  disabled={clips.length <= 1 || addingClip}
                  onClick={() => onRemoveClip(c.id)}
                >
                  <Icon name="close" size={13} />
                </button>
              </li>
            ))}
          </ul>

          {addingClip && <p className="lib-empty">Adding clip…</p>}
        </section>
      )}

      {hasScript && (
        <section className="lib-section">
          <div className="lib-head">
            <h3>Speakers</h3>
            <span className="lib-count">{speakers.length}</span>
          </div>

          {speakers.length === 0 ? (
            <p className="lib-empty">This transcript has no speaker labels.</p>
          ) : (
            <ul className="spk-list">
              {speakers.map((s) => (
                <li key={s.label} className="spk-row">
                  {/* The dot is the legend for the rule down the script margin —
                    * same custom property, so they cannot drift apart. */}
                  <span className="spk-dot" style={{ ['--spk' as string]: s.color }} />
                  <button
                    className="spk-name"
                    onClick={() => onSeek(s.start)}
                    title={`Jump to where ${s.label} first speaks`}
                  >
                    {s.label}
                  </button>
                  <span className="spk-count">{s.words.toLocaleString()}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      </aside>
    </>
  );
}
