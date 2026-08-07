import { useEffect, useMemo, useRef } from 'react';
import {
  sampleOverlay,
  type ImageOverlay,
} from '../../../../packages/core/src/overlay.ts';

/**
 * The image inserts, drawn over the monitor.
 *
 * This is a preview of a composite ffmpeg will perform later, so the two have to
 * agree. They agree because both read the same `sampleOverlay`: the opacity and
 * the slide offset on screen come from the very function the render's `overlay`
 * expressions are a spelling of, and overlay.test.ts checks the two against each
 * other frame by frame, in pixels.
 *
 * ── why this is imperative, and mounted conditionally ────────────────────────
 *
 * An overlay animates, so it is the same problem the push-in is: it changes
 * every frame, and re-rendering the app at 60Hz to fade a picture is exactly
 * what the rest of this codebase refuses to do. So the effect below runs on rAF
 * and writes each image's opacity and transform IMPERATIVELY, and the loop
 * mounts only when the document actually has an overlay — a project that never
 * inserts one runs no loop and pays nothing.
 *
 * The elements themselves ARE React-rendered, one <img> per overlay, because
 * the list changes at human speed (adding an image, deleting one) while only
 * the numbers on them change at frame speed. That is the same split
 * CaptionOverlay draws between its cue index and its clock.
 *
 * ── the clock ────────────────────────────────────────────────────────────────
 *
 * Overlays are stored on the SOURCE clock and the <video> element plays the
 * source, so this samples `getCurrentTime()` with no EDL mapping at all —
 * exactly as the push-in preview does. The render is the side that has to map
 * (see overlaysToOutput), because it composites after the cut.
 *
 * ── where it sits ────────────────────────────────────────────────────────────
 *
 * Inside `.frame`, over the <video> and UNDER the caption layer. Both halves
 * mirror the render: the grade is an SVG filter on the video element, so an
 * <img> sibling is necessarily ungraded — which is what "composited after the
 * grade" means — and captions burn after the composite, so they must draw on
 * top here too.
 */

interface Props {
  overlays: ImageOverlay[];
  /** assetId → browser-reachable URL. An overlay whose asset is gone draws nothing. */
  urls: Record<string, string>;
  /** Read imperatively at 60Hz — see the rAF below. */
  getCurrentTime: () => number;
  /**
   * The overlay being framed, if any — held visible outside its own window so it
   * can be positioned from anywhere on the timeline. Placing a picture you
   * cannot see is not placing it.
   *
   * ONLY ever set by an explicit "Show while framing" toggle. Entering this
   * state automatically on insert is what made every newly added image sit on
   * the picture permanently: the hold is a placement aid, and an aid nobody
   * asked for is indistinguishable from the feature being broken.
   */
  editingId?: string | null;
  /**
   * Gates that hold. See CaptionOverlay, which draws its placement guide under
   * exactly the same rule and for the same reason: the render draws nothing
   * outside the overlay's window, so during playback neither may the preview.
   * Holding an image over moving pictures is the monitor lying about the frame,
   * and it is the one lie you cannot help noticing.
   */
  playing?: boolean;
}

export default function ImageOverlayLayer({
  overlays,
  urls,
  getCurrentTime,
  editingId,
  playing,
}: Props) {
  // Only the overlays that can actually draw. Filtering here rather than in the
  // loop keeps the rAF body proportional to what is on screen, and keeps the
  // element list stable across frames.
  const drawable = useMemo(
    () => overlays.filter((o) => urls[o.assetId]),
    [overlays, urls],
  );

  const refs = useRef(new Map<string, HTMLImageElement>());

  useEffect(() => {
    if (drawable.length === 0) return;

    let raf = 0;
    // Written only when they change. Assigning identical strings to a style
    // property is cheap but not free, and this runs 60 times a second for the
    // whole time a project has an image in it — most of which is spent nowhere
    // near one, where every frame's answer is the same one.
    const last = new Map<string, string>();

    const paint = () => {
      raf = requestAnimationFrame(paint);
      const t = getCurrentTime();

      for (const overlay of drawable) {
        const el = refs.current.get(overlay.id);
        if (!el) continue;

        const state = sampleOverlay(overlay, t);
        // The one being framed is held visible outside its own window so it can
        // be positioned from anywhere on the timeline — but only while PAUSED,
        // and only when the user asked for it. Inside its window it animates
        // normally either way, or the ramp would be impossible to judge.
        const holding = overlay.id === editingId && !playing;
        const shown = state ?? (holding ? { opacity: 1, dx: 0, dy: 0 } : null);

        const key = shown ? `${shown.opacity}|${shown.dx}|${shown.dy}` : 'off';
        if (last.get(overlay.id) === key) continue;
        last.set(overlay.id, key);

        if (!shown) {
          // visibility, not display:none — the element keeps its box, so nothing
          // re-lays-out sixty times a second as images come and go.
          el.style.visibility = 'hidden';
          continue;
        }
        el.style.visibility = 'visible';
        el.style.opacity = String(shown.opacity);
        // Percentages of the ELEMENT's own size would be wrong: the travel is a
        // fraction of the FRAME. Both are available here because the layer is
        // sized to the frame, so a fraction of 100% of the layer is what we want.
        el.style.transform =
          shown.dx === 0 && shown.dy === 0
            ? 'none'
            : `translate(${shown.dx * 100 / Math.max(overlay.box.width, 1e-6)}%, ${
                shown.dy * 100 / Math.max(overlay.box.height, 1e-6)
              }%)`;
      }
    };

    raf = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(raf);
  }, [drawable, getCurrentTime, editingId, playing]);

  if (drawable.length === 0) return null;

  return (
    <div className="img-layer">
      {drawable.map((overlay) => (
        <img
          key={overlay.id}
          ref={(el) => {
            if (el) refs.current.set(overlay.id, el);
            else refs.current.delete(overlay.id);
          }}
          className={`img-overlay${overlay.id === editingId ? ' editing' : ''}`}
          src={urls[overlay.assetId]}
          alt=""
          draggable={false}
          style={{
            left: `${overlay.box.x * 100}%`,
            top: `${overlay.box.y * 100}%`,
            width: `${overlay.box.width * 100}%`,
            height: `${overlay.box.height * 100}%`,
            // The preview's half of the render's scale/crop vs scale/pad. cover
            // fills and crops; contain fits and leaves the rest of the box
            // showing the video through, which is what the transparent pad does
            // in the filtergraph.
            objectFit: overlay.fit,
            // Hidden until the first rAF sets it, so an image never flashes at
            // full strength on the frame it mounts.
            visibility: 'hidden',
          }}
        />
      ))}
    </div>
  );
}
