/**
 * On-device transcription through Apple's Speech framework (macOS 26+).
 *
 * The only provider here that is neither a network call nor a fake. The model
 * ships with the OS: no key, no upload, no per-minute cost, and the audio never
 * leaves the machine.
 *
 * It is in this product for one MEASURED reason. Feeding it
 * "So um, today I want to, uh, talk about building a video editor" returns
 * `um` and `ah` as their own timed words instead of tidying them away — so the
 * filler remover, which is the feature this whole editor is arranged around,
 * actually has something to find. Whisper-family models normalize those away;
 * see the README's "Known gaps".
 *
 * What it does NOT do is diarization. Words come back without a speaker, the
 * margin stops naming who is talking, and `--spk-N` colours go unused. That is
 * the honest trade for local + free + verbatim, and it is why ElevenLabs stays
 * the default whenever its key is present.
 *
 * ── the binary ──────────────────────────────────────────────────────────────
 *
 * `native/apple-speech/main.swift` is compiled with `swiftc` to a binary beside
 * itself IN DEVELOPMENT; the packaged app ships one built at package time and
 * points APPLE_SPEECH_BIN at it, because an app bundle is read-only and a clean
 * Mac has no Xcode. Either way nothing is checked in: a downloaded binary that spawns is
 * a thing users are right to be suspicious of, and the toolchain is already on
 * any Mac with the Command Line Tools. Compilation happens once, lazily, on the
 * first transcription — about ten seconds — and is cached thereafter. Concurrent
 * callers share one build: `building` holds the in-flight promise so a second
 * request waits on the first rather than racing swiftc against itself over the
 * same output path.
 */

import { spawn } from 'node:child_process';
import { access, mkdir, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { release } from 'node:os';

import type { Word } from '../../../packages/core/src/types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const NATIVE_DIR = join(here, '..', 'native', 'apple-speech');
const SOURCE = join(NATIVE_DIR, 'main.swift');

/**
 * The helper binary — built here in development, SHIPPED in the packaged app.
 *
 * APPLE_SPEECH_BIN is set by the desktop shells, exactly as FFMPEG_PATH already
 * is, and its presence means two things: the binary is prebuilt, and we are
 * inside a read-only app bundle where building is not merely unnecessary but
 * impossible. See `prebuilt` below — getting that distinction wrong is what
 * makes a packaged app spawn a doomed compiler on every single transcription.
 */
const BINARY = process.env.APPLE_SPEECH_BIN || join(NATIVE_DIR, 'jumpcut-stt');
const prebuilt = Boolean(process.env.APPLE_SPEECH_BIN);

/**
 * macOS 26 is Darwin 25. SpeechAnalyzer/SpeechTranscriber — the API that gives
 * word-level `audioTimeRange` — does not exist before it, and the older
 * SFSpeechRecognizer is not a substitute: its segment timings are unreliable and
 * it wants an authorization dialog a headless server cannot show.
 */
const MIN_DARWIN_MAJOR = 25;

export function platformSupported(): boolean {
  if (process.platform !== 'darwin') return false;
  const major = Number(release().split('.')[0]);
  return Number.isFinite(major) && major >= MIN_DARWIN_MAJOR;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** Is the compiled helper already present and executable? */
async function binaryReady(): Promise<boolean> {
  try {
    await access(BINARY, constants.X_OK);

    /**
     * A shipped binary has no source beside it to compare against.
     *
     * The mtime check below is right in development and catastrophic in a
     * package: stat(SOURCE) throws because main.swift was never copied into the
     * bundle, the catch returns false, and ensureBinary() then fires swiftc at a
     * read-only directory — on EVERY transcription, failing every time, while a
     * perfectly good binary sits right there. Executable is the whole test when
     * we did not build it.
     */
    if (prebuilt) return true;

    // A binary older than its source is a stale build — recompile rather than
    // run yesterday's logic against today's expectations.
    const [bin, src] = await Promise.all([stat(BINARY), stat(SOURCE)]);
    return bin.mtimeMs >= src.mtimeMs;
  } catch {
    return false;
  }
}

async function hasSwiftc(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('swiftc', ['--version'], { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

/**
 * Can this machine transcribe locally — today, without asking the user for
 * anything? Either the helper is already built, or the toolchain to build it is
 * present. Anything less and the capability must report false, because a model
 * offered in the panel that then fails at click time is worse than one absent.
 */
export async function available(): Promise<boolean> {
  if (!platformSupported()) return false;
  if (await binaryReady()) return true;
  return (await exists(SOURCE)) && (await hasSwiftc());
}

let building: Promise<string> | null = null;

async function build(): Promise<string> {
  await mkdir(NATIVE_DIR, { recursive: true });

  return new Promise<string>((resolve, reject) => {
    const child = spawn('swiftc', ['-O', SOURCE, '-o', BINARY], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (err) => reject(new Error(`swiftc could not be started: ${err.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolve(BINARY);
      else reject(new Error(`swiftc failed (${code}): ${stderr.slice(0, 600)}`));
    });
  });
}

async function ensureBinary(): Promise<string> {
  if (await binaryReady()) return BINARY;
  if (prebuilt) {
    // Shipped but not runnable: a broken package, not something to compile past.
    throw new Error(`The bundled speech helper at ${BINARY} is missing or not executable.`);
  }
  if (!building) {
    building = build().finally(() => {
      building = null;
    });
  }
  return building;
}

export interface AppleProgress {
  progress: number;
  stage: string;
}

interface RawWord {
  text: string;
  start: number;
  end: number;
}

/**
 * Transcribe one audio file locally.
 *
 * `audioPath` is the 16 kHz mono WAV `extractAudioForAsr` already writes — the
 * same file every other provider is handed, so nothing upstream has to know
 * which provider will run.
 */
export async function transcribe(
  audioPath: string,
  language: string,
  onProgress?: (p: AppleProgress) => void,
): Promise<{ words: Word[]; locale: string }> {
  if (!platformSupported()) {
    throw new Error('On-device speech needs macOS 26 or newer.');
  }

  onProgress?.({ progress: -1, stage: 'Preparing on-device model' });
  const binary = await ensureBinary();

  // 'auto' has no meaning to SpeechTranscriber — it wants a locale. English is
  // the honest default for a model whose other locales must be downloaded
  // individually, and the Swift side falls back by language code anyway.
  const locale = language && language !== 'auto' ? localeFor(language) : 'en-US';

  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['--locale', locale, audioPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderrTail = '';

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });

    // stderr carries two things: "#progress <n>" lines meant for the bar, and
    // human diagnostics meant for the log. Split them rather than dumping
    // progress spam into the server output.
    let pending = '';
    child.stderr.on('data', (chunk) => {
      pending += String(chunk);
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        const match = /^#progress (\d*\.?\d+)$/.exec(line.trim());
        if (match) {
          onProgress?.({ progress: Number(match[1]), stage: 'Transcribing on device' });
        } else if (line.trim()) {
          stderrTail = `${stderrTail}${line}\n`.slice(-1200);
          console.log('[asr:apple]', line.trim());
        }
      }
    });

    child.on('error', (err) => reject(new Error(`on-device speech failed to start: ${err.message}`)));

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`On-device speech failed (exit ${code}): ${stderrTail.trim().slice(0, 400)}`));
        return;
      }
      try {
        const payload = JSON.parse(stdout) as { words: RawWord[]; locale: string };
        resolve({ words: toWords(payload.words ?? []), locale: payload.locale ?? locale });
      } catch (err) {
        reject(new Error(`On-device speech returned unreadable output: ${(err as Error).message}`));
      }
    });
  });
}

/**
 * Word ids follow the same rule every other provider here obeys: `w<index>` over
 * the RAW list, before anything is dropped. Ids are not indices — see the
 * README — so the numbering is deliberately allowed to skip.
 */
function toWords(raw: RawWord[]): Word[] {
  return raw
    .map((item, i) => {
      const text = (item.text ?? '').trim();
      if (!text) return null;
      if (typeof item.start !== 'number' || typeof item.end !== 'number') return null;
      return { id: `w${i}`, text, start: item.start, end: item.end } satisfies Word;
    })
    .filter((w): w is Word => w !== null)
    .filter((w) => w.end > w.start);
}

/** The panel speaks ISO language codes; SpeechTranscriber wants BCP-47 locales. */
function localeFor(language: string): string {
  const map: Record<string, string> = {
    en: 'en-US', es: 'es-ES', fr: 'fr-FR', de: 'de-DE', it: 'it-IT',
    pt: 'pt-BR', ja: 'ja-JP', ko: 'ko-KR', zh: 'zh-CN', hi: 'hi-IN',
  };
  return map[language] ?? (language.includes('-') ? language : 'en-US');
}
