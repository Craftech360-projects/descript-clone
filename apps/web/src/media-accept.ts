/**
 * What the file picker will accept — and why it is not the same on a phone.
 *
 * `accept="video/*,audio/*"` reads as "either kind of media", which is right on a
 * desktop where the dialog lists everything anyway. On a touch device it is the
 * reason the gallery does not appear.
 *
 * Android turns a multi-type accept into an intent with mimeType `*​/*` plus
 * EXTRA_MIME_TYPES, and several OEM pickers — Samsung's among them — answer that
 * with the document/Files chooser rather than the gallery. What you get is
 * Camera, Camcorder and Files: three ways in, none of them your videos. A single
 * `video/*` maps to the photo picker instead. iOS is the same shape of problem:
 * "Photo Library" appears when the accepted types are ones Photos can supply, and
 * audio is not.
 *
 * So the phone gets the narrower accept, which is also the honest one — there are
 * no audio files in a camera roll. A desktop keeps both, because there the dialog
 * is a filesystem browser and nothing is hidden by asking for more.
 */
export const MEDIA_ACCEPT_ALL = 'video/*,audio/*';
export const MEDIA_ACCEPT_GALLERY = 'video/*';

/**
 * Coarse pointer means a finger, which in practice means a phone or tablet whose
 * file picker is a gallery rather than a filesystem. Read at call time rather
 * than cached: a Fold changes size and input on the way open, and a value read
 * once at module load would be whichever it was first.
 */
export function mediaAccept(): string {
  if (typeof window === 'undefined' || !window.matchMedia) return MEDIA_ACCEPT_ALL;
  return window.matchMedia('(pointer: coarse)').matches ? MEDIA_ACCEPT_GALLERY : MEDIA_ACCEPT_ALL;
}
