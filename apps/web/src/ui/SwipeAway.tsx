import { useEffect, useRef, useState, type ReactNode } from 'react';
import { verdictFor } from './swipe.ts';

/** How long the banner takes to leave, in ms. Matches the transition below. */
const FLIGHT = 220;

/**
 * A banner you can throw off the side of the screen with a thumb.
 *
 * The only way to clear a phone banner used to be a precise tap on the banner
 * itself. That is the same motion as tapping the work behind it, so it fires by
 * accident — and if the thumb lands a few pixels off it does nothing at all,
 * which reads as a message that is simply stuck there. Dragging sideways is the
 * gesture a phone user already has for "make this go away", so that is the one
 * offered: the banner follows the finger, and past ESCAPE it keeps going out
 * the side it was already heading.
 *
 * Pointer events rather than touch events, so a trackpad drag in a narrow
 * window behaves identically and there is one path to reason about. A tap still
 * dismisses, because that is what the banner did before and some people will
 * have learned it.
 */
export function SwipeAway({ onDismiss, children }: { onDismiss: () => void; children: ReactNode }) {
  const [dx, setDx] = useState(0);
  const [flung, setFlung] = useState(0);
  const from = useRef<number | null>(null);
  const moved = useRef(0);
  /** The finger's current offset, written synchronously — see release(). */
  const live = useRef(0);

  /**
   * Retire the banner once it has flown out.
   *
   * A clock rather than transitionend: the transform and the transition that
   * animates it are enabled in the same commit, and a browser that decides not
   * to interpolate that never fires the event — leaving a banner parked
   * off-screen, still in the DOM, with the message it carried apparently
   * undismissable. The timer owes nothing to whether the paint happened.
   *
   * Through a ref because the parent passes a fresh arrow every render, and a
   * dependency that changes every render would restart the timer forever.
   */
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  useEffect(() => {
    if (!flung) return;
    const t = setTimeout(() => dismiss.current(), FLIGHT);
    return () => clearTimeout(t);
  }, [flung]);

  /**
   * The decision reads the ref, never the state.
   *
   * `dx` is one render behind the finger — React may not have committed the last
   * move by the time the pointer comes up, and a quick flick is exactly the
   * gesture that outruns it. Judging the throw on the state value made a
   * decisive swipe spring back as though it had been a nudge. The ref is written
   * synchronously in the move handler, so it is always the real distance.
   */
  const release = () => {
    const dragging = from.current !== null;
    from.current = null;
    if (!dragging) return;
    const verdict = verdictFor(live.current, moved.current);
    if (verdict === 'right' || verdict === 'left') setFlung(verdict === 'right' ? 1 : -1);
    else if (verdict === 'tap') onDismiss();
    else {
      live.current = 0;
      setDx(0);
    }
  };

  return (
    <div
      className="swipeaway"
      style={{
        transform: flung ? `translateX(${flung * 120}%)` : `translateX(${dx}px)`,
        // Fades as it travels, so the gesture reads as "leaving" well before it
        // commits — and the banner never blinks out from full opacity.
        opacity: flung ? 0 : Math.max(0, 1 - Math.abs(dx) / 220),
        // No transition WHILE a finger is down: the banner must sit exactly
        // under the thumb, not lag behind it.
        transition: from.current === null ? `transform ${FLIGHT}ms ease, opacity ${FLIGHT}ms ease` : 'none',
        // Vertical scrolling still belongs to the page; only the x axis is ours.
        touchAction: 'pan-y',
      }}
      onPointerDown={(e) => {
        from.current = e.clientX;
        moved.current = 0;
        live.current = 0;
        // Capture keeps the drag alive when the finger leaves the banner, but a
        // pointer the browser has already released throws here — and losing the
        // capture is survivable, while losing the gesture is not.
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          /* drag still tracks via the move handler */
        }
      }}
      onPointerMove={(e) => {
        if (from.current === null) return;
        const d = e.clientX - from.current;
        live.current = d;
        moved.current = Math.max(moved.current, Math.abs(d));
        setDx(d);
      }}
      onPointerUp={release}
      onPointerCancel={release}
    >
      {children}
    </div>
  );
}
