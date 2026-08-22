import {
  normalizeCaptionStyles,
  removeCaptionStyle,
  saveCaptionStyle,
  type CaptionStyle,
} from '../../../../packages/core/src/caption-preset.ts';

/**
 * Where saved caption styles live: this browser, not the project file.
 *
 * The whole reason the feature exists is that a look is reused ACROSS projects —
 * you save "Reel bold, gold highlight, caps" once and want it on the next four
 * videos. Putting the list in the document would give every project its own copy
 * of your house style and no way to reach the one you saved yesterday, which is
 * the opposite of the thing being asked for. So: localStorage, the same home as
 * the custom filler words and the on-import chain, and for the same reason —
 * these describe how YOU work, not what is in any one video.
 *
 * The consequence is worth stating plainly rather than hiding: styles do not
 * travel. A different browser, a different machine, or a cleared site data and
 * the saved list is gone. That is the correct trade for a preference with no
 * account system behind it, and the panel says so.
 *
 * Everything that decides anything is in packages/core/caption-preset.ts. This
 * file is only the two lines that touch storage, and the try/catch that keeps
 * private mode from taking the editor down.
 */

const KEY = 'jumpcut.captionStyles';

/** The styles this browser has saved. Built-ins are code and are not in here. */
export function loadCaptionStyles(): CaptionStyle[] {
  try {
    const raw = localStorage.getItem(KEY);
    // Coerced field by field on the way in, exactly like loadAutoImport: a list
    // written by an older build, or hand-edited, must not reach a colour swatch
    // as undefined — that throw unmounts the editor.
    return normalizeCaptionStyles(raw ? JSON.parse(raw) : null);
  } catch {
    return [];
  }
}

function write(list: CaptionStyle[]): CaptionStyle[] {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* private mode, or the quota: keep the list for this session only */
  }
  return list;
}

/** Save (or replace) one style and return the new list. */
export function persistCaptionStyle(list: readonly CaptionStyle[], style: CaptionStyle): CaptionStyle[] {
  return write(saveCaptionStyle(list, style));
}

/** Forget one style and return the new list. */
export function forgetCaptionStyle(list: readonly CaptionStyle[], id: string): CaptionStyle[] {
  return write(removeCaptionStyle(list, id));
}
