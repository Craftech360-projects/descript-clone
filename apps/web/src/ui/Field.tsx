import { useId, type ReactNode } from 'react';

/**
 * The small widget kit. These were written inside Inspector.tsx; they outlived
 * it, so they live here now.
 */

/**
 * A titled group of controls.
 *
 * `collapsible` turns it into a native <details> — the section header becomes a
 * disclosure you click to reveal the controls, collapsed by default. The rail
 * uses this so its sections read as a short list of headers until you open the
 * one you want; dialogs leave it off, since a control you opened a dialog to
 * reach should already be on screen. Native <details> keeps full keyboard and
 * screen-reader support with no JS.
 */
export function Field({ label, children, collapsible, defaultOpen }: {
  label: string;
  children: ReactNode;
  collapsible?: boolean;
  defaultOpen?: boolean;
}) {
  if (collapsible) {
    return (
      <details className="field field-c" open={defaultOpen}>
        <summary>{label}</summary>
        <div className="field-body">{children}</div>
      </details>
    );
  }
  return (
    <section className="field">
      <h3>{label}</h3>
      {children}
    </section>
  );
}

export function Hint({ children }: { children: ReactNode }) {
  return <p className="hint">{children}</p>;
}

/**
 * Where the app admits what it does not know. This voice is the best thing in
 * the codebase — keep it.
 */
export function Warn({ children }: { children: ReactNode }) {
  return <p className="warn-box">{children}</p>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty-panel">{children}</p>;
}

/**
 * An exclusive choice, laid out as one bar rather than a stack of rows.
 *
 * This was a column of radios. Three of them cost 70px of height and read as
 * three independent questions; the bar costs 28px and reads as one question
 * with three answers, which is what it is. Height is the scarce axis in the
 * rail — see the note on .panel-project in app.css.
 *
 * Still native radios underneath: arrow keys cycle the group, screen readers
 * announce "2 of 3", and the checked state survives with CSS off. The input is
 * transparent and stretched over its label, so the paint is the label and the
 * behaviour is the browser's.
 */
export function Segmented({ name, value, onChange, options }: {
  /** Names the group for assistive tech. Uniqueness is handled below. */
  name: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<[string, string]>;
}) {
  /* A radio group is scoped by `name` across the WHOLE document, not by parent.
   * Two Segmenteds sharing a literal name silently join into one group and
   * uncheck each other — and the rail is mounted while a dialog is open, so
   * that collision is reachable, not theoretical. useId keeps each instance its
   * own group no matter who else is on screen. */
  const group = `${name}-${useId()}`;

  return (
    <div className="seg">
      {options.map(([v, label]) => (
        <label key={v} className={`seg-opt${value === v ? ' on' : ''}`}>
          <input type="radio" name={group} checked={value === v} onChange={() => onChange(v)} />
          <span>{label}</span>
        </label>
      ))}
    </div>
  );
}

/**
 * A single on/off setting, drawn as a toggle switch rather than a checkbox.
 *
 * Still a native <input type="checkbox"> underneath — role="switch" so assistive
 * tech announces "on/off" instead of "checked", the label wraps it so the whole
 * row is the hit target, and the state survives with CSS off. The track and thumb
 * are the paint; the checkbox is the behaviour. See `.switch` in app.css.
 */
export function Check({ checked, onChange, label, disabled }: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <label className={`switch${disabled ? ' disabled' : ''}`}>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="switch-track" aria-hidden="true">
        <span className="switch-thumb" />
      </span>
      <span className="switch-label">{label}</span>
    </label>
  );
}

/**
 * A colour swatch.
 *
 * <input type="color"> fires `change` continuously while the OS picker is open,
 * so onCommit exists to separate "the user is scrubbing the picker" from "the
 * user settled on this" — the same split the Slider makes with pointer events,
 * and for the same reason: one undo entry per colour, not one per hue.
 */
export function Color({ value, onChange, onCommit, label }: {
  value: string;
  onChange: (v: string) => void;
  onCommit?: () => void;
  label: string;
}) {
  // Settings arrive from disk, where the type is a promise rather than a
  // guarantee. `value.toUpperCase()` on a field a stored project predates threw,
  // and a throw during render unmounts the tree — so one absent colour blanked
  // the whole editor. A control that cannot render its input should show a
  // fallback, not take the app down with it.
  const hex = /^#[0-9a-f]{6}$/i.test(value) ? value : '#000000';
  return (
    <label className="color-row">
      <input
        type="color"
        value={hex}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onCommit}
      />
      <span>{label}</span>
      <code>{hex.toUpperCase()}</code>
    </label>
  );
}

export function Slider({ value, min, max, step, onChange, format, onPointerDown, onPointerUp }: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  format: (v: number) => string;
  /** Bracket the gesture so a drag is ONE undo step rather than one per frame. */
  onPointerDown?: () => void;
  onPointerUp?: () => void;
}) {
  return (
    <div className="slider">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        // A keyboard nudge has no pointerup to seal the group, so treat blur as
        // the end of the gesture.
        onBlur={onPointerUp}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span>{format(value)}</span>
    </div>
  );
}
