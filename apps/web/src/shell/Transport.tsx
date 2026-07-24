import { useEffect, useRef, useState } from 'react';
import Icon from '../ui/Icon.tsx';
import { timecode } from '../../../../packages/core/src/timeline.ts';
import { outputDuration, sourceToOutput } from '../../../../packages/core/src/edl.ts';
import { MAX_SPEED, MIN_SPEED, SPEEDS } from '../../../../packages/core/src/doc.ts';
import { formatSpeed } from '../store/editor.ts';
import type { Edl } from '../../../../packages/core/src/types.ts';

interface Props {
  getCurrentTime: () => number;
  duration: number;
  edl: Edl | null;
  playing: boolean;
  followEdit: boolean;
  setFollowEdit: (v: boolean) => void;
  showDeleted: boolean;
  setShowDeleted: (v: boolean) => void;
  speed: number;
  setSpeed: (v: number) => void;
  onPlayPause: () => void;
  onStep: (direction: -1 | 1) => void;
  onHome: () => void;
  disabled: boolean;
}

/**
 * The <select> value that means "let me type one" rather than a speed.
 *
 * A string no number can collide with, since <option value> is always compared
 * as text: 1.3 typed into the box comes back as "1.3", never as this.
 */
const CUSTOM = 'custom';

/**
 * The transport lives in the timeline dock, not the title bar.
 *
 * Two things it does that the old topbar did not:
 *
 * 1. The clock reads OUTPUT time when you are previewing the edit. The old
 *    header showed source position over source duration while a panel eighteen
 *    lines away showed the output length — two numbers from different universes,
 *    side by side, with nothing to tell them apart. The suffix says which.
 *
 * 2. It updates outside React. The clock ticks at 60Hz off a rAF loop writing
 *    textContent directly; as state it would re-render the app every frame.
 */
export default function Transport({
  getCurrentTime,
  duration,
  edl,
  playing,
  followEdit,
  setFollowEdit,
  showDeleted,
  setShowDeleted,
  speed,
  setSpeed,
  onPlayPause,
  onStep,
  onHome,
  disabled,
}: Props) {
  const clockRef = useRef<HTMLSpanElement>(null);

  /**
   * The draft of a hand-typed speed, or null when the ladder is showing.
   *
   * A string, not a number: "1." and "" are states the field passes through on
   * the way to 1.3, and coercing every keystroke would fight the caret. It is
   * parsed once, on commit.
   */
  const [draft, setDraft] = useState<string | null>(null);
  /** Set by Escape so the blur it causes throws the draft away instead of taking it. */
  const cancelled = useRef(false);

  /**
   * Speed divides the EDIT clock and nothing else.
   *
   * In edit space the clock is quoting the file you are about to download, and
   * that file is `speed` times shorter — so both the position and the total have
   * to be divided, or they would describe a render nobody is going to get.
   *
   * Source space is deliberately left alone. There, the number is the playhead's
   * position in the original media, which does not move because you chose to play
   * it faster; dividing it would make the clock disagree with the timeline right
   * below it, which is drawn in source seconds.
   */
  const outDuration = edl ? outputDuration(edl, speed) : duration;
  const total = followEdit && edl ? outDuration : duration;

  // A <select> whose value is not among its options renders BLANK, and an
  // off-ladder speed is now an ordinary thing to hold: "Custom…" below types one,
  // and the API clamps to [0.5, 2] without snapping to the ladder. Splice it in so
  // 1.3 reads as 1.3x rather than as an empty control that appears broken.
  const options: readonly number[] = (SPEEDS as readonly number[]).includes(speed)
    ? SPEEDS
    : [...SPEEDS, speed].sort((a, b) => a - b);

  /**
   * Take the typed speed, or abandon it.
   *
   * Blank and unparseable both mean "never mind" rather than a value: clampSpeed
   * would happily turn "" into 1 and silently change the edit, which is not what
   * clicking away from an empty box asks for. Anything real is rounded to the two
   * decimals formatSpeed shows and held inside ffmpeg's atempo range, so the
   * ladder can render it as an option afterwards instead of going blank.
   */
  const commitDraft = () => {
    const n = Number(draft);
    const abandon = cancelled.current;
    cancelled.current = false;
    setDraft(null);
    if (abandon || draft === null || draft.trim() === '' || !Number.isFinite(n)) return;
    const next = Math.min(MAX_SPEED, Math.max(MIN_SPEED, Math.round(n * 100) / 100));
    if (next !== speed) setSpeed(next);
  };

  useEffect(() => {
    const el = clockRef.current;
    if (!el) return;

    let raf = 0;
    let last = '';
    const frame = () => {
      const source = getCurrentTime();
      // Inside a cut, sourceToOutput returns null — hold the last known output
      // position rather than blanking the clock.
      const output = followEdit && edl ? sourceToOutput(edl, source) : null;
      const shown = followEdit && edl ? (output === null ? null : output / speed) : source;
      const text = shown === null ? last : timecode(shown, { ms: false });
      if (text !== last) {
        el.textContent = text;
        last = text;
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [getCurrentTime, followEdit, edl, speed]);

  return (
    <div className="transport">
      <div className="tp-buttons">
        <button className="icon" onClick={onHome} disabled={disabled} title="Go to start (Home)" aria-label="Go to start">
          <Icon name="skip-start" />
        </button>
        <button className="icon" onClick={() => onStep(-1)} disabled={disabled} title="Previous word (←)" aria-label="Previous word">
          <Icon name="step-back" />
        </button>
        <button className="play" onClick={onPlayPause} disabled={disabled} title="Play/pause (Space)" aria-label={playing ? 'Pause' : 'Play'}>
          <Icon name={playing ? 'pause' : 'play'} size={17} />
        </button>
        <button className="icon" onClick={() => onStep(1)} disabled={disabled} title="Next word (→)" aria-label="Next word">
          <Icon name="step-forward" />
        </button>
      </div>

      <div className="tp-clock">
        <span ref={clockRef} className="tc">0:00</span>
        <span className="tc-total">/ {timecode(total)}</span>
        <span className="tc-space">{followEdit && edl ? 'edit' : 'source'}</span>
      </div>

      {/*
        * A menu, not a row of toggles like its neighbours on the right.
        *
        * Seven mutually exclusive values is too many to spend a transport bar's
        * width on, and speed is the one control every player already hides behind
        * exactly this. Native <select>: it is a real listbox on every platform,
        * keyboard and screen reader included, and this app has no popover to
        * borrow.
        *
        * It sits by the clock rather than with the view toggles because it is not
        * one. "Preview edit" and "Show cuts" change what you are looking at;
        * this changes what you are going to ship — hence the title.
        *
        * The ladder is the fast path, not the whole range: "Custom…" swaps the
        * menu for a number field so any speed in [0.5, 2] — 1.3, 1.35 — is
        * typable. It swaps BACK once committed, because the value is then just
        * another option (see `options` above), and a box left open would be a
        * second place the current speed lives.
        */}
      <label className="tp-speed">
        {draft === null ? (
          <select
            className={speed === 1 ? undefined : 'fast'}
            aria-label="Playback and export speed"
            title="Speed. This is part of the edit — the render comes out at this speed too."
            value={speed}
            // Not the bar's own `disabled`, which only means "no project". Speed
            // lives on the DOCUMENT, so there is nowhere to put it until a script
            // exists — while play and step still work on untranscribed media.
            disabled={disabled || !edl}
            onChange={(e) => {
              // Seed the field with the speed already in force, so typing over it
              // starts from something true rather than from blank.
              if (e.target.value === CUSTOM) setDraft(String(speed));
              else setSpeed(Number(e.target.value));
            }}
          >
            {options.map((s) => (
              <option key={s} value={s}>
                {formatSpeed(s)}
              </option>
            ))}
            <option value={CUSTOM}>Custom…</option>
          </select>
        ) : (
          <input
            type="number"
            className="tp-speed-input"
            aria-label="Custom playback and export speed"
            title={`Any speed from ${MIN_SPEED}x to ${MAX_SPEED}x. Enter to apply, Esc to cancel.`}
            value={draft}
            min={MIN_SPEED}
            max={MAX_SPEED}
            step={0.05}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitDraft}
            // Both keys leave through blur, so there is exactly one exit from the
            // field and commitDraft is the only thing that can change the speed.
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              else if (e.key === 'Escape') {
                cancelled.current = true;
                e.currentTarget.blur();
              }
            }}
          />
        )}
      </label>

      <div className="tp-toggles">
        {/* Real switches, not highlighted buttons: the sliding knob carries the
          * on/off state, so the control never lights its whole self up. */}
        <button
          className={followEdit ? 'toggle on' : 'toggle'}
          onClick={() => setFollowEdit(!followEdit)}
          title="Skip cut material while playing"
          aria-pressed={followEdit}
        >
          <span className="sw" aria-hidden="true" />
          Preview edit
        </button>
        <button
          className={showDeleted ? 'toggle on' : 'toggle'}
          onClick={() => setShowDeleted(!showDeleted)}
          title="Show cut words struck through in the script"
          aria-pressed={showDeleted}
        >
          <span className="sw" aria-hidden="true" />
          Show cuts
        </button>
        {/* Speed counts toward this now, so it can go the other way: at 0.5x the
          * output is LONGER than the source, and a rose "−0:00" would be a lie
          * told twice. */}
        {edl && (
          <span
            className={duration >= outDuration ? 'tp-saved' : 'tp-saved longer'}
            title="How much shorter the edit makes it, speed included"
          >
            {duration >= outDuration ? '−' : '+'}
            {timecode(Math.abs(duration - outDuration))}
          </span>
        )}
      </div>
    </div>
  );
}
