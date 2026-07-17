import { useEffect, useRef } from 'react';
import Icon from '../ui/Icon.tsx';
import { timecode } from '../../../../packages/core/src/timeline.ts';
import { outputDuration, sourceToOutput } from '../../../../packages/core/src/edl.ts';
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
  onPlayPause: () => void;
  onStep: (direction: -1 | 1) => void;
  onHome: () => void;
  disabled: boolean;
}

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
  onPlayPause,
  onStep,
  onHome,
  disabled,
}: Props) {
  const clockRef = useRef<HTMLSpanElement>(null);

  const outDuration = edl ? outputDuration(edl) : duration;
  const total = followEdit && edl ? outDuration : duration;

  useEffect(() => {
    const el = clockRef.current;
    if (!el) return;

    let raf = 0;
    let last = '';
    const frame = () => {
      const source = getCurrentTime();
      // Inside a cut, sourceToOutput returns null — hold the last known output
      // position rather than blanking the clock.
      const shown = followEdit && edl ? sourceToOutput(edl, source) : source;
      const text = shown === null ? last : timecode(shown, { ms: false });
      if (text !== last) {
        el.textContent = text;
        last = text;
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [getCurrentTime, followEdit, edl]);

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

      <div className="tp-toggles">
        {/* Checkboxes in a transport bar are the dev-app tell. These are toggles. */}
        <button
          className={followEdit ? 'toggle on' : 'toggle'}
          onClick={() => setFollowEdit(!followEdit)}
          title="Skip cut material while playing"
          aria-pressed={followEdit}
        >
          <Icon name="scissors" size={13} />
          Preview edit
        </button>
        <button
          className={showDeleted ? 'toggle on' : 'toggle'}
          onClick={() => setShowDeleted(!showDeleted)}
          title="Show cut words struck through in the script"
          aria-pressed={showDeleted}
        >
          Show cuts
        </button>
        {edl && (
          <span className="tp-saved" title="How much the edit removes">
            −{timecode(Math.max(0, duration - outDuration))}
          </span>
        )}
      </div>
    </div>
  );
}
