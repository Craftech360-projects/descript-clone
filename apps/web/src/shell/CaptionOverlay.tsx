import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { sourceToOutput } from '../../../../packages/core/src/edl.ts';
import { karaokeSpans, toCues } from '../../../../packages/core/src/captions.ts';
import {
  CAPTION_REFERENCE_HEIGHT,
  captionBoxFill,
  clampAnchor,
  fontStack,
  type CaptionSettings,
} from '../../../../packages/core/src/caption-style.ts';
import type { Edl, Word } from '../../../../packages/core/src/types.ts';

interface Props {
  videoRef: RefObject<HTMLVideoElement | null>;
  /**
   * The output frame — the rectangle the render will actually produce.
   *
   * Captions are placed as a fraction of the OUTPUT, and the render burns them
   * after the reframe crop, so this is the rectangle to measure. Measuring the
   * <video> instead would place them against the source: on a 16:9 recording
   * cropped to a 9:16 reel, a caption at x=0.5 would sit in the middle of a
   * picture whose middle is not the middle of the frame that ships.
   */
  frameRef: RefObject<HTMLDivElement | null>;
  words: Word[];
  edl: Edl | null;
  captions: CaptionSettings;
  /** Families of imported fonts, so a caption set to one previews in that font. */
  customFamilies: string[];
  /** Gates the placement guide — see the render below. */
  playing: boolean;
  /** Read imperatively at 60Hz — see the rAF below. */
  getCurrentTime: () => number;
  onDragStart: () => void;
  onMove: (x: number, y: number) => void;
  onDragEnd: (label: string) => void;
}

/** The video's picture within its element, once object-fit: contain letterboxes it. */
interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The draggable caption, drawn over the monitor.
 *
 * This is a preview of a burn that libass will do later, so the two have to
 * agree. They agree because both read the same CaptionSettings and both scale
 * from the same 1080p reference — position is a fraction of the picture, so it
 * survives the monitor being 480px wide and the render being 4K.
 *
 * Line breaks are not approximated, they are shared: toCues breaks at maxChars
 * before either engine sees the text, libass is told not to wrap (WrapStyle 2)
 * and this is `white-space: pre`. Neither side gets a vote. That is what fixed
 * the long-standing complaint that the preview "auto-layouts" — it was the
 * browser and libass each choosing their own break points and agreeing only by
 * luck.
 *
 * What remains approximate, and deliberately: the browser and libass are
 * different text engines, so glyph rasterisation and outline joins differ by a
 * pixel here and there. Placement, size, colour, break points, outline
 * thickness and shadow offset are exact; the antialiasing is not.
 */
export default function CaptionOverlay(p: Props) {
  const [box, setBox] = useState<Box | null>(null);
  const [cueIndex, setCueIndex] = useState(-1);
  // How many words of the current cue have started. \k flips a word to
  // PrimaryColour at the INSTANT its syllable begins, so this is a count of
  // spans already reached, not of spans finished.
  const [spoken, setSpoken] = useState(0);
  // The last cue that was really on screen. The placement guide falls back to
  // it, so pausing in a silence holds the line you just heard rather than
  // jumping to some unrelated one.
  const [guideIndex, setGuideIndex] = useState(0);
  const dragging = useRef(false);

  const cues = useMemo(
    () =>
      p.edl
        ? toCues({ mediaId: '', duration: 0, words: p.words }, p.edl, {
            maxChars: p.captions.maxChars,
          })
        : [],
    [p.words, p.edl, p.captions.maxChars],
  );

  // Precomputed per cue rather than per frame: the spans for a cue never change
  // while it is on screen, and rebuilding them at 60Hz to answer "which word"
  // would be the one genuinely wasteful thing in this loop.
  const spans = useMemo(() => cues.map(karaokeSpans), [cues]);

  // ── keep the overlay glued to the output frame ──────────────────────────────
  //
  // The frame element IS the output rectangle — the monitor sizes it to the
  // target aspect and clips the picture to it — so the box is simply its own
  // size, and the overlay is a child of it. This used to derive the picture's
  // contain-box from videoWidth/videoHeight, which was the right answer back when
  // the monitor showed the source letterboxed and the wrong one now: the picture
  // is deliberately larger than the frame whenever it is zoomed or cropped, and
  // captions belong to the frame.
  useEffect(() => {
    const el = p.frameRef.current;
    if (!el) return;

    const measure = () => {
      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height) return setBox(null);
      setBox({ left: 0, top: 0, width: rect.width, height: rect.height });
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [p.frameRef, p.captions.enabled]);

  // ── which cue is on screen ──────────────────────────────────────────────────
  //
  // The clock is still read outside React, on rAF — that part matters, because
  // `timeupdate` fires at ~4Hz and would drop captions a quarter-second late.
  // But only the cue INDEX crosses into React, and that changes at cue
  // boundaries — about once a second, not 60 times. setState bails out when the
  // value is unchanged, so the frames in between cost a comparison and nothing
  // else.
  //
  // This used to write textContent through a ref, on the theory that the
  // timeline's imperative idiom applied here too. It did not: the ref is null
  // on any render this component returns null from, and it returns null until
  // `box` is measured — which cannot happen until the video reports
  // videoWidth. So the effect ran once against a null ref, never scheduled its
  // rAF, and the caption stayed permanently blank once the box did arrive.
  useEffect(() => {
    const edl = p.edl;
    if (!p.captions.enabled || !edl) return;

    let raf = 0;
    const frame = () => {
      raf = requestAnimationFrame(frame);

      // Don't move the caption while the picture is in flight. Assigning
      // currentTime updates the reported position AT ONCE, but the frame does
      // not land until the decoder has run up from the previous H.264 keyframe
      // — measured 116ms at p50 against this app's own media, ~7 of these
      // frames. Reading it anyway swaps the caption to the next line over a
      // picture still showing the last one, at every cut. usePlayback guards
      // the same way for the same reason; the caption and the frame have to be
      // talking about the same moment.
      const video = p.videoRef.current;
      if (video?.seeking) return;

      const output = sourceToOutput(edl, p.getCurrentTime());
      // null means the playhead is in material the edit removed — a transient
      // of playback mechanics, not a statement that nothing is being said. Hold
      // the last cue rather than blanking through it.
      if (output === null) return;

      const i = cues.findIndex((c) => output >= c.start && output < c.end);
      setCueIndex(i);
      if (i < 0) return;
      setGuideIndex(i);

      // Linear scan, not findIndex-and-negate: a cue is a handful of words, and
      // this has to answer "how many have started" even when the playhead is
      // past all of them.
      const list = spans[i];
      let n = 0;
      while (n < list.length && list[n].start <= output) n++;
      setSpoken(n);
    };

    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [cues, spans, p.edl, p.getCurrentTime, p.captions.enabled, p.videoRef]);

  if (!p.captions.enabled || !box) return null;

  // Between cues nothing is being said, and the burn draws nothing there — so
  // while playing, neither does this. Showing anything in a 41ms gap is both a
  // lie about the frame and, 275 times over a 14-minute video, the strobe this
  // used to be: it fell back to cues[0], so every gap flashed the video's FIRST
  // line over whatever you were watching. toCues now closes the short gaps; the
  // ones left are real silences, and a real silence has no caption.
  //
  // Paused, the dimmed guide comes back — an empty overlay is impossible to
  // grab, and placing it is the one job that needs it.
  const active = cueIndex >= 0 ? cues[cueIndex] : null;
  const placeholder = active === null;
  const hidden = placeholder && p.playing;
  const text = active?.text ?? cues[guideIndex]?.text ?? cues[0]?.text ?? 'Captions';

  // Word-by-word only over a cue that is really on screen. The placement guide
  // is a still: animating a line nobody is speaking would misrepresent the
  // frame, and the guide exists to be grabbed, not watched.
  const karaoke = p.captions.karaoke && active ? spans[cueIndex] : null;

  // Every length scales off the picture height, exactly as toAss does.
  const scale = box.height / CAPTION_REFERENCE_HEIGHT;
  const fontSize = p.captions.fontSize * scale;
  const strokeSize = p.captions.strokeWidth * scale;
  const boxFill = captionBoxFill(p.captions);
  // In box mode the stroke colour IS the box, and libass draws no glyph
  // outline. Drawing one here would show an outline the render will not have.
  const outline = boxFill === null ? strokeSize : 0;

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    // The frame behind this pans on drag. Without stopping here, grabbing the
    // caption would move the caption AND the picture under it.
    e.stopPropagation();
    dragging.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    p.onDragStart();
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    const el = p.frameRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    // Screen -> frame -> 0..1. Clamped, so it can never be lost off-frame.
    const { x, y } = clampAnchor(
      (e.clientX - rect.left) / rect.width,
      (e.clientY - rect.top) / rect.height,
    );
    p.onMove(x, y);
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    dragging.current = false;
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    p.onDragEnd('Move captions');
  };

  return (
    <div
      className="cap-layer"
      style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
    >
      <div
        className={`cap-text${placeholder ? ' ph' : ''}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        style={{
          // Hidden rather than unmounted: pointer capture bypasses hit testing,
          // so a drag that outlives its cue keeps receiving events.
          visibility: hidden ? 'hidden' : undefined,
          left: `${p.captions.x * 100}%`,
          top: `${p.captions.y * 100}%`,
          fontFamily: fontStack(p.captions.font, p.customFamilies),
          fontSize: `${fontSize}px`,
          color: p.captions.color,
          textTransform: p.captions.allCaps ? 'uppercase' : 'none',
          // DOUBLED, and that is not a fudge factor.
          //
          // libass Outline:N grows the glyph N pixels OUTWARD — measured, ink
          // bbox grows by exactly 2N in both axes. CSS centres its stroke on the
          // glyph path, so half falls inside the letterform and paint-order
          // hides it under the fill. A CSS stroke of N therefore shows N/2
          // outside, and the preview drew every outline at half strength.
          WebkitTextStrokeWidth: outline > 0 ? `${outline * 2}px` : undefined,
          WebkitTextStrokeColor: outline > 0 ? p.captions.strokeColor : undefined,
          paintOrder: 'stroke fill',
          // Opaque, and the stroke colour — that is what libass fills a
          // BorderStyle 3 box with. See captionBoxFill.
          background: boxFill ?? 'transparent',
          // ASS reuses the outline width as the box's padding.
          padding: boxFill !== null ? `${strokeSize}px ${strokeSize * 2}px` : 0,
          // A HARD shadow, offset only. ASS Shadow:N is a copy of the glyph
          // displaced N px down-right with no blur at all — measured, ink grows
          // by exactly +N in width and +N in height, never more. The 2px blur
          // this used to draw had no counterpart in the burn. Alpha is 0.5
          // because toAss sets BackColour alpha to 0x80.
          textShadow:
            p.captions.backdrop === 'shadow'
              ? `${3 * scale}px ${3 * scale}px 0 rgba(0,0,0,0.5)`
              : undefined,
          // No max-width and no wrapping. toCues already broke this text at
          // maxChars; letting the browser break it again is the whole bug. See
          // the WrapStyle 2 note in toAss.
          whiteSpace: 'pre',
        }}
      >
        {karaoke
          ? karaoke.map((span, i) => (
              <span
                key={i}
                // Before its syllable begins a word waits in highlightColor;
                // from that instant on it holds `color`. That is \k, exactly.
                style={{ color: i < spoken ? p.captions.color : p.captions.highlightColor }}
              >
                {i > 0 ? ' ' : ''}
                {span.text}
              </span>
            ))
          : text}
      </div>
    </div>
  );
}
