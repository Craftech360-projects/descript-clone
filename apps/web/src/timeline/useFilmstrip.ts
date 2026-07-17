import { useEffect, useState } from 'react';
import type { Thumbs } from '../api.ts';
import type { Filmstrip } from './draw.ts';

/**
 * Decode the filmstrip's sheets, redrawing as each one arrives.
 *
 * Sheets land one at a time, so the strip fills in left to right rather than
 * appearing all at once after five round trips. `images` is sparse until they
 * all land; drawFilmstrip skips the holes.
 *
 * Each arrival yields a NEW Filmstrip object wrapping the same images array.
 * That is deliberate: the caller hangs its redraw effect on this value, and
 * mutating the array in place would leave the object identical and the canvas
 * stale.
 */
export function useFilmstrip(thumbs: Thumbs | undefined): Filmstrip | null {
  const [strip, setStrip] = useState<Filmstrip | null>(null);

  useEffect(() => {
    if (!thumbs) {
      setStrip(null);
      return;
    }

    let live = true;
    const images: (HTMLImageElement | undefined)[] = new Array(thumbs.sheets.length);
    setStrip({
      interval: thumbs.interval,
      cols: thumbs.cols,
      rows: thumbs.rows,
      tileW: thumbs.tileW,
      tileH: thumbs.tileH,
      count: thumbs.count,
      images,
    });

    const pending: HTMLImageElement[] = [];
    thumbs.sheets.forEach((url, i) => {
      const img = new Image();
      pending.push(img);
      img.onload = () => {
        if (!live) return;
        images[i] = img;
        setStrip((s) => (s ? { ...s } : s));
      };
      // A sheet that 404s stays a hole: a gap in the strip beats throwing and
      // taking the whole timeline down with it.
      img.onerror = () => {};
      img.src = url;
    });

    return () => {
      live = false;
      // Drop the handlers, or a late decode writes into a stale array.
      for (const img of pending) {
        img.onload = null;
        img.onerror = null;
      }
    };
  }, [thumbs]);

  return strip;
}
