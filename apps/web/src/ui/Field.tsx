import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import Icon, { type IconName } from './Icon.tsx';

/**
 * The small widget kit. These were written inside Inspector.tsx; they outlived
 * it, so they live here now.
 */

/**
 * A rail section: a row that STATES ITS VALUE, and opens to reveal the controls
 * behind it.
 *
 * This replaces `Field collapsible` in the Project panel, and the difference is
 * the whole point. A <details> whose summary reads only "Frame" is a table of
 * contents with no contents: to learn that you are exporting 1080×1920 with a
 * bed at 40% and captions on, you had to open five disclosures in turn. The
 * value on the right means the closed panel is a full status report — the
 * project's whole configuration, readable without a single click.
 *
 * `toggle` puts the on/off switch IN the header, outside the disclosure button.
 * Turning captions on is the most frequent thing anyone does here and it cost a
 * click to open, a click to switch, and a click to close. Now it costs one, and
 * you never have to look at the dozen controls behind it.
 *
 * Not a native <details>, which is what the rest of the app uses. A <summary>
 * swallows clicks on anything inside it, so a switch in the header would toggle
 * the section as well as the setting — and moving the switch out of the summary
 * means the row is no longer one element. So: an explicit button/aria-expanded
 * disclosure, which is the same contract <details> implements, spelled out.
 */
/**
 * Lets something outside a Section decide which one is open.
 *
 * The phone tool bar needs to open a named section — "Captions", say — and the
 * sections each held their own boolean, so nothing outside could reach them.
 * A context rather than props threaded through eleven call sites, because the
 * panel that renders them does not care about this and should not have to.
 *
 * It also makes the phone an accordion: setting one key closes the rest. That is
 * the right behaviour on a small screen, where eleven open sections is a very
 * long scroll and you only came here for one of them. On a desk there is no
 * provider, so sections keep their own state and any number can be open at once.
 */
export const SectionOpen = createContext<{
  key: string | null;
  set: (key: string | null) => void;
} | null>(null);

/** Stable key for a section, derived from its label so nothing has to be typed twice. */
export const sectionKey = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, '-');

export function Section({ icon, label, value, toggle, children, defaultOpen }: {
  icon: IconName;
  label: string;
  /** The live state, shown closed AND open — while open it is a readout that
    * tracks the controls below it, which is why it is not hidden on expand. */
  value?: ReactNode;
  toggle?: {
    checked: boolean;
    onChange: (v: boolean) => void;
    disabled?: boolean;
    /** Names the switch for assistive tech; drawn only by the section header. */
    label: string;
  };
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [selfOpen, setSelfOpen] = useState(Boolean(defaultOpen));
  const bodyId = useId();

  // Controlled when a provider is present (the phone), self-managed otherwise.
  const shared = useContext(SectionOpen);
  const key = sectionKey(label);
  const open = shared ? shared.key === key : selfOpen;
  const setOpen = (next: boolean) => {
    if (shared) shared.set(next ? key : null);
    else setSelfOpen(next);
  };

  return (
    <section className={`sect${open ? ' open' : ''}`} data-sect={key}>
      <div className="sect-head">
        <button
          type="button"
          className="sect-disc"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((o) => !o)}
        >
          <span className="sect-caret" aria-hidden="true" />
          <Icon name={icon} size={15} className="sect-icon" />
          <span className="sect-name">{label}</span>
          {value !== undefined && value !== null && value !== '' && (
            <span className="sect-value">{value}</span>
          )}
        </button>
        {toggle && (
          <Check
            checked={toggle.checked}
            onChange={toggle.onChange}
            disabled={toggle.disabled}
            label={toggle.label}
            hideLabel
          />
        )}
      </div>
      {/* Hidden rather than unmounted, so a search you ran in the music browser
        * — or a half-typed filler word — survives collapsing the section to
        * glance at something else. [hidden] is honoured explicitly in app.css:
        * .sect-body sets display:flex, which would otherwise beat the UA rule
        * and leave a "closed" section fully visible and fully tabbable. */}
      <div className="sect-body" id={bodyId} hidden={!open}>{children}</div>
    </section>
  );
}

/** The small caption over a group of sections. */
export function SectionGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="pgroup">
      <h3 className="pgroup-head">{label}</h3>
      {children}
    </div>
  );
}

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
/**
 * The nearest Field's label, so a Slider inside it has a name without every call
 * site repeating one.
 *
 * 18 sliders had no accessible name at all. Threading a `label` prop through all
 * of them would have worked and would also have been 18 chances to forget. A
 * Field already knows what it is called; a Slider inside it is almost always
 * "that Field's value", so the heading is the right default. A Field holding
 * SEVERAL sliders (the push-in zoom and ease, the six colour knobs) should still
 * pass an explicit `label` — this makes the floor "named", not "named well".
 */
const FieldLabel = createContext<string | undefined>(undefined);

export function Field({ label, children, collapsible, defaultOpen }: {
  label: string;
  children: ReactNode;
  collapsible?: boolean;
  defaultOpen?: boolean;
}) {
  if (collapsible) {
    return (
      <FieldLabel.Provider value={label}>
        <details className="field field-c" open={defaultOpen}>
          <summary>{label}</summary>
          <div className="field-body">{children}</div>
        </details>
      </FieldLabel.Provider>
    );
  }
  return (
    <FieldLabel.Provider value={label}>
      <section className="field">
        <h3>{label}</h3>
        {children}
      </section>
    </FieldLabel.Provider>
  );
}

export function Hint({ children }: { children: ReactNode }) {
  return <p className="hint">{children}</p>;
}

/**
 * Where the app admits what it does not know. This voice is the best thing in
 * the codebase — keep it.
 */
export function Warn({ children, alert }: { children: ReactNode; alert?: boolean }) {
  /* `alert` for a message that APPEARED in response to something you just did —
   * a failed search, say. Without role="alert" a screen reader never learns the
   * box arrived, because nothing moved focus and nothing else announced it. Not
   * the default: the standing warnings here are part of the page, and a live
   * region that fires on every render would interrupt constantly. */
  return <p className="warn-box" role={alert ? 'alert' : undefined}>{children}</p>;
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
export function Check({ checked, onChange, label, disabled, hideLabel }: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
  /** Draw the switch alone. The label text stays in the DOM, unpainted, so the
    * control keeps its accessible name — used in a Section header, where the
    * section's own heading is already the visible label. */
  hideLabel?: boolean;
}) {
  return (
    <label className={`switch${disabled ? ' disabled' : ''}${hideLabel ? ' bare' : ''}`}>
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
      <span className={hideLabel ? 'sr-only' : 'switch-label'}>{label}</span>
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

/**
 * A number you set by dragging a bar — or, when the bar is fighting you, by
 * clicking − and + to step it.
 *
 * The bar alone was the whole control and it asked for a pixel-accurate grab on
 * a thumb the browser drew at whatever size it felt like. The buttons are the
 * escape hatch: one click is exactly one `step`, so the fiddly last 20px of a
 * drag becomes a click, and the value can be reached without any dragging at
 * all. The bar stays for the coarse move — it is still the fastest way to cross
 * a range — but it is no longer the only way across.
 *
 * The track and thumb are painted by us now rather than by the platform, so the
 * thumb is a 16px target on a 22px-tall hit strip instead of the ~10px sliver
 * Windows hands out. See `.slider` in app.css.
 */
export function Slider({ value, min, max, step, onChange, format, label, onPointerDown, onPointerUp }: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  format: (v: number) => string;
  /**
   * What this slider controls, spoken.
   *
   * Without it the input has no accessible name at all: the `<h3>` a Field
   * renders above is a heading, not a label, and the formatted readout beside
   * the bar is an unassociated `<span>`. Every slider in the Inspector — pause
   * cap, frame zoom, all six colour knobs, caption size — announced itself as a
   * bare "slider", while the − and + buttons flanking it were properly named
   * "Less" and "More". Optional so no call site breaks, but pass it.
   */
  label?: string;
  /** Bracket the gesture so a drag is ONE undo step rather than one per frame. */
  onPointerDown?: () => void;
  onPointerUp?: () => void;
}) {
  // An explicit label wins; otherwise inherit the enclosing Field's heading.
  const inherited = useContext(FieldLabel);
  const name = label ?? inherited;

  /* A nudge is a whole gesture in one click, so it has to open AND close the
   * history bracket. Closing it inline would seal the entry with the label the
   * parent built from the OLD value — the label closes over the props of the
   * render we were clicked in. Deferring to an effect (deliberately dep-less, so
   * it runs after every render) means the commit fires on the next render, where
   * `onPointerUp` is the freshly-built closure that knows the new value. This is
   * the same trick the keyboard path gets for free from onBlur. */
  const pendingCommit = useRef(false);
  useEffect(() => {
    if (!pendingCommit.current) return;
    pendingCommit.current = false;
    onPointerUp?.();
  });

  const nudge = (dir: 1 | -1) => {
    // Snap from `min`, not from 0 — a range starting at 2 with step 1 is on a
    // different grid than the integers.
    const stepped = min + Math.round((value - min) / step + dir) * step;
    const next = Math.min(max, Math.max(min, stepped));
    if (next === value) return;
    onPointerDown?.();
    pendingCommit.current = true;
    onChange(next);
  };

  return (
    <div className="slider">
      <div className="slider-row">
        <button
          type="button"
          className="nudge"
          aria-label={name ? `Less ${name}` : 'Less'}
          disabled={value <= min}
          onClick={() => nudge(-1)}
        >
          −
        </button>
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          aria-label={name}
          // The raw number is meaningless read aloud — "40" against a range of
          // 0..500 says nothing. `format` is already the human reading of this
          // value ("40ms padding"), so it is what gets announced.
          aria-valuetext={format(value)}
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
          // A keyboard nudge has no pointerup to seal the group, so treat blur as
          // the end of the gesture.
          onBlur={onPointerUp}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <button
          type="button"
          className="nudge"
          aria-label={name ? `More ${name}` : 'More'}
          disabled={value >= max}
          onClick={() => nudge(1)}
        >
          +
        </button>
      </div>
      <span>{format(value)}</span>
    </div>
  );
}
