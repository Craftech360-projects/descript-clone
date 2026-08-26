/**
 * Where the file is going, and what that destination wants.
 *
 * Export had no notion of a destination: it produced a file at whatever shape
 * the frame said and whatever loudness the source happened to be. Two of those
 * three things matter enormously for a reel and neither was reachable.
 *
 * ── on loudness, which is the part people miss ──────────────────────────────
 *
 * Every major platform normalises playback loudness. Upload something quieter
 * than the target and it is played quieter than everything around it in the
 * feed; upload something louder and it is turned DOWN, which squashes the
 * dynamics you mixed. Either way the fix is to arrive at the target rather than
 * be dragged to it.
 *
 * -14 LUFS integrated is the number the streaming platforms converged on, and it
 * is what these presets aim at — AIM being the honest word. `loudnorm` here runs
 * single-pass, which measures and corrects in one go rather than analysing the
 * whole programme first, and it lands close rather than exact: measured on this
 * project's own media, a -14 target came out at -15.6 LUFS.
 *
 * That is the right trade for now. Landing a little under target is the benign
 * direction — a platform raises a quiet upload, where it would COMPRESS a loud
 * one — and two-pass would mean decoding the entire programme before the render
 * could start. Exactness is a follow-up, not a reason to ship nothing. The app's own Studio Sound chain has always run
 * `loudnorm` at -16, which is a speech-broadcast number and a reasonable default
 * for a voice — but it only ran when Studio Sound was ON, so a user who wanted
 * correct loudness had to accept a voice chain they may not have wanted.
 *
 * ── these numbers move ──────────────────────────────────────────────────────
 *
 * Durations especially: platforms change their limits often and differ by
 * account and region. They are advisory here — the export WARNS and never
 * refuses, because a limit remembered wrong should not be able to stop you
 * shipping a file.
 */

export type PresetId = 'source' | 'reels' | 'tiktok' | 'shorts';

export interface ExportPreset {
  id: PresetId;
  label: string;
  /** Output size, or null to keep whatever the project's frame already says. */
  size: { width: number; height: number } | null;
  /** Integrated loudness target in LUFS, or null to leave the audio alone. */
  lufs: number | null;
  /** True peak ceiling in dBTP. Only meaningful alongside `lufs`. */
  truePeak: number;
  /** Advisory maximum length in seconds, or null where there is no useful limit. */
  maxSeconds: number | null;
  hint: string;
}

/** The streaming consensus. Every preset below that normalises aims here. */
export const STREAMING_LUFS = -14;

export const EXPORT_PRESETS: readonly ExportPreset[] = [
  {
    id: 'source',
    label: 'This project',
    size: null,
    lufs: null,
    truePeak: -1.5,
    maxSeconds: null,
    hint: 'Whatever the Frame panel says, and the audio exactly as mixed.',
  },
  {
    id: 'reels',
    label: 'Instagram Reels',
    size: { width: 1080, height: 1920 },
    lufs: STREAMING_LUFS,
    truePeak: -1.5,
    maxSeconds: 90,
    hint: '1080×1920, aimed at −14 LUFS. Reels are watched in a feed at low volume.',
  },
  {
    id: 'tiktok',
    label: 'TikTok',
    size: { width: 1080, height: 1920 },
    lufs: STREAMING_LUFS,
    truePeak: -1.5,
    maxSeconds: 600,
    hint: '1080×1920, aimed at −14 LUFS.',
  },
  {
    id: 'shorts',
    label: 'YouTube Shorts',
    size: { width: 1080, height: 1920 },
    lufs: STREAMING_LUFS,
    truePeak: -1.5,
    maxSeconds: 180,
    hint: '1080×1920, aimed at −14 LUFS.',
  },
] as const;

export function presetFor(id: string): ExportPreset {
  return EXPORT_PRESETS.find((p) => p.id === id) ?? EXPORT_PRESETS[0];
}

/**
 * Is this cut too long for where it is going?
 *
 * Returns null when it fits or when the preset has no limit — the caller shows
 * nothing rather than a reassurance nobody asked for.
 */
export function overBy(id: string, outputSeconds: number): number | null {
  const preset = presetFor(id);
  if (preset.maxSeconds === null) return null;
  if (!Number.isFinite(outputSeconds) || outputSeconds <= preset.maxSeconds) return null;
  return outputSeconds - preset.maxSeconds;
}

/**
 * The `loudnorm` stage for a preset, or null to leave the audio untouched.
 *
 * Single-pass loudnorm: it measures and corrects in one go, which is less exact
 * than the two-pass form but does not require running the whole programme
 * through ffmpeg twice before the render can start.
 *
 * Measured accuracy on this project's media: a -14 target landed at -15.6 LUFS.
 * Close enough to be worth having, not close enough to call exact.
 *
 * `aresample=48000` is NOT optional and is the caller's job to keep after this —
 * loudnorm runs its internals at 192kHz and leaves the stream there.
 */
export function loudnessStage(id: string): string | null {
  const preset = presetFor(id);
  if (preset.lufs === null) return null;
  return `loudnorm=I=${preset.lufs}:TP=${preset.truePeak}:LRA=11`;
}
