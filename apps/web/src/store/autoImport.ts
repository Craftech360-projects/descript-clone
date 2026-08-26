/**
 * What runs by itself when a file lands.
 *
 * The chain is a fixed pipeline in a fixed order — transcribe, cut the
 * hesitations, cap the pauses, set the speed, enhance the voice, turn on the
 * captions — and this is only which of those steps are switched on. The order is
 * not a setting because it is not a preference: each step reads what the one
 * before it wrote. Transcription has to be first because nothing after it has a
 * script to work on, and the filler sweep has to precede the pause cap because
 * cutting a word creates the silence the cap then closes.
 *
 * Speed is the exception that proves the rule: it commutes with everything, and
 * sits where it does only because it reads next to Pauses. It is a transform on
 * the OUTPUT — it never moves a source timestamp — so the cuts above it land on
 * the same frames whether it runs before them, after them, or not at all.
 *
 * A personal preference, not project data, so localStorage is home — the same
 * place the custom filler words live, and for the same reason: it describes how
 * YOU work, not what is in any one video.
 *
 * On the defaults: every step is on. This is a feature you go and find, and the
 * only reason to find it is to have all of it. The one that costs real money is
 * `transcribe` — it spends ElevenLabs credits per minute of media, unattended —
 * so it is the step the drawer names first and warns about.
 */

const KEY = 'jumpcut.autoImport';

export interface AutoImport {
  /** Run ASR the moment the import lands. Nothing after this works without it. */
  transcribe: boolean;
  /** Provider to prefer when both real ASR keys are configured. */
  asrProvider: 'elevenlabs' | 'sarvam';
  /** Sweep filler words. Hesitations only — um, uh, er — plus your custom list. */
  fillers: boolean;
  /** Shorten every silence to `pauseCapMs`. */
  pauses: boolean;
  pauseCapMs: number;
  /** Play the finished cut out at `speedValue`. */
  speed: boolean;
  speedValue: number;
  /** The voice enhancer. */
  studioSound: boolean;
  /** Turn captions on, so they burn into the export and show on the monitor. */
  captions: boolean;
}

/**
 * What happens to a file on import, and what does NOT.
 *
 * Everything that CHANGES THE VIDEO is off. An import should hand you your
 * footage as you shot it; cleaning it up is an edit, and an edit is something
 * you ask for. With fillers, pauses and speed all on by default, a freshly
 * imported clip skipped in a dozen places and ran 1.2x fast before its owner had
 * touched anything — which reads as the tool being broken, not as it having been
 * helpful. The controls are all still there, one tap away, for when you do want
 * them.
 *
 * `transcribe` stays on because without words there is nothing to edit with —
 * it adds information and removes none. `captions` stays on because it is a
 * display setting this editor exists to drive, it cuts nothing, and it is
 * visible and reversible the moment you see it.
 *
 * The values (50ms, 1.2x) are kept, not zeroed: they are the right settings for
 * when the switch IS turned on, and forgetting them would make the feature worse
 * the first time someone reaches for it.
 */
export const AUTO_IMPORT_DEFAULTS: AutoImport = {
  transcribe: true,
  asrProvider: 'sarvam',
  fillers: false,
  pauses: false,
  pauseCapMs: 50,
  speed: false,
  speedValue: 1.2,
  studioSound: false,
  captions: true,
};

/** The steps, in the order they run. The drawer renders straight off this. */
export const AUTO_IMPORT_STEPS = [
  'transcribe',
  'fillers',
  'pauses',
  'speed',
  'studioSound',
  'captions',
] as const;

/**
 * The speeds the on-import step offers. A subset of the transport's SPEEDS
 * ladder, and deliberately: the half below 1x is missing because an AUTOMATIC
 * speed step exists to tighten pacing, and nothing is served by slowing every
 * file you import down by default. The transport still has the whole ladder for
 * the one video that wants 0.75x.
 */
export const AUTO_SPEEDS = [1.2, 1.5, 1.75, 2] as const;

export type AutoImportStep = (typeof AUTO_IMPORT_STEPS)[number];

/** How many steps are switched on — the count the drawer header shows. */
export function autoImportCount(a: AutoImport): number {
  return AUTO_IMPORT_STEPS.filter((s) => a[s]).length;
}

/**
 * Read the saved preference, field by field.
 *
 * Per field rather than per object so a build that adds a sixth step does not
 * silently reset the five a user already chose — the same reasoning as
 * normalizeCaptions and cutFromWire. Anything absent, mistyped or hand-edited
 * falls back to its default rather than reaching the chain as undefined.
 */
export function loadAutoImport(): AutoImport {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return AUTO_IMPORT_DEFAULTS;
    const saved = JSON.parse(raw) as Partial<AutoImport>;
    const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
    return {
      transcribe: bool(saved.transcribe, AUTO_IMPORT_DEFAULTS.transcribe),
      asrProvider: saved.asrProvider === 'elevenlabs' ? 'elevenlabs' : 'sarvam',
      fillers: bool(saved.fillers, AUTO_IMPORT_DEFAULTS.fillers),
      pauses: bool(saved.pauses, AUTO_IMPORT_DEFAULTS.pauses),
      // Clamped to the slider's own range: a stored 0 would mean "keep every
      // pause", which is the opposite of what the switch being on promises.
      pauseCapMs: clampPause(saved.pauseCapMs),
      speed: bool(saved.speed, AUTO_IMPORT_DEFAULTS.speed),
      speedValue: snapSpeed(saved.speedValue),
      studioSound: bool(saved.studioSound, AUTO_IMPORT_DEFAULTS.studioSound),
      captions: bool(saved.captions, AUTO_IMPORT_DEFAULTS.captions),
    };
  } catch {
    return AUTO_IMPORT_DEFAULTS;
  }
}

export function saveAutoImport(value: AutoImport): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(value));
  } catch {
    /* private mode: keep the choice for this session only */
  }
}

export const MIN_PAUSE_MS = 50;
export const MAX_PAUSE_MS = 2000;

function clampPause(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return AUTO_IMPORT_DEFAULTS.pauseCapMs;
  return Math.min(MAX_PAUSE_MS, Math.max(MIN_PAUSE_MS, Math.round(n / 50) * 50));
}

/**
 * Snap a stored speed onto the offered ladder, rather than clamping to a range.
 *
 * The control is a set of buttons, so a value off the ladder has no button to
 * light up — it would render as "none of these are selected" while still being
 * what the chain applies. Anything unrecognised falls back to the default.
 */
function snapSpeed(value: unknown): number {
  const n = Number(value);
  return (AUTO_SPEEDS as readonly number[]).includes(n) ? n : AUTO_IMPORT_DEFAULTS.speedValue;
}
