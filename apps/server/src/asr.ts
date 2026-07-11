import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { ASR_MODELS, CONFIG, type AsrModelId } from './config.ts';
import type { Word } from '../../../packages/core/src/types.ts';

/** Everything the Transcribe panel lets the user decide. */
export interface AsrOptions {
  model: AsrModelId;
  /** ISO code, or 'auto'. */
  language: string;
  /** Fixed speaker count, or 0 for auto. */
  speakers: number;
  /** Ask for speaker labels at all. */
  diarize: boolean;
  /** Ask for a verbatim transcript that keeps "um"/"uh". */
  verbatim: boolean;
}

export const ASR_DEFAULTS: AsrOptions = {
  model: 'fal-ai/whisper',
  language: 'auto',
  speakers: 0,
  diarize: true,
  verbatim: true,
};

export interface AsrResult {
  words: Word[];
  provider: string;
  /** True only if the transcript actually preserves fillers. */
  verbatim: boolean;
}

export async function transcribe(
  audioPath: string,
  duration: number,
  options: AsrOptions,
): Promise<AsrResult> {
  if (options.model === 'mock' || !CONFIG.hasFal()) {
    return mockTranscribe(duration);
  }
  return falTranscribe(audioPath, options);
}

// ---------------------------------------------------------------------------
// fal
// ---------------------------------------------------------------------------

async function falTranscribe(audioPath: string, options: AsrOptions): Promise<AsrResult> {
  const { fal } = await import('@fal-ai/client');
  fal.config({ credentials: CONFIG.falKey });

  const bytes = await readFile(audioPath);
  const file = new File([bytes], basename(audioPath), { type: 'audio/wav' });
  const audioUrl = await fal.storage.upload(file);

  const input: Record<string, unknown> = {
    audio_url: audioUrl,
    task: 'transcribe',
    // The whole product hinges on this being honoured.
    chunk_level: 'word',
    diarize: options.diarize,
  };
  if (options.language !== 'auto') input.language = options.language;
  if (options.speakers > 0) input.num_speakers = options.speakers;

  const result: any = await fal.subscribe(options.model, { input });
  const payload = result?.data ?? result;

  // The response shape is the one unverified assumption the product rests on.
  // Log its skeleton so a mismatch is obvious rather than archaeological.
  console.log('[asr] keys:', Object.keys(payload ?? {}));
  const sample = payload?.chunks?.[0] ?? payload?.words?.[0] ?? payload?.segments?.[0];
  if (sample) console.log('[asr] first item:', JSON.stringify(sample));

  const words = normalizeToWords(payload);

  if (words.length === 0) {
    throw new Error(
      `${options.model} returned no usable WORD-level timings (keys: ` +
        `${Object.keys(payload ?? {}).join(', ')}). Either the response shape differs — ` +
        `fix normalizeToWords() — or this endpoint only does segment-level timestamps, ` +
        `which cannot support word-level editing.`,
    );
  }

  const declared = ASR_MODELS.find((m) => m.id === options.model);

  return {
    words,
    provider: options.model,
    // Asking for verbatim does not make it so. Standard Whisper normalizes
    // fillers away regardless, and claiming otherwise would make the filler
    // tool look broken instead of unavailable.
    verbatim: declared?.verbatim ?? false,
  };
}

/** Providers disagree wildly about response shape. Accept the common ones. */
export function normalizeToWords(payload: any): Word[] {
  const raw: any[] =
    payload?.chunks ??
    payload?.words ??
    payload?.segments?.flatMap((s: any) => s.words ?? []) ??
    [];

  return raw
    .map((item, i) => {
      const start = Array.isArray(item.timestamp) ? item.timestamp[0] : item.start;
      const end = Array.isArray(item.timestamp) ? item.timestamp[1] : item.end;
      const text = (item.text ?? item.word ?? '').trim();

      if (typeof start !== 'number' || typeof end !== 'number' || !text) return null;

      return {
        id: `w${i}`,
        text,
        start,
        end,
        speaker: item.speaker ?? item.speaker_id ?? undefined,
      } satisfies Word;
    })
    .filter((w): w is Word => w !== null)
    .filter((w) => w.end > w.start);
}

// ---------------------------------------------------------------------------
// mock
// ---------------------------------------------------------------------------

/**
 * Not a toy. With no GPU and no verified endpoint, this is what lets the whole
 * pipeline be built and driven at zero cost. Only the words are fake — the
 * timings are real and every downstream stage runs for real.
 *
 * Contains fillers, a false start, and two speakers so the tools have something
 * to find.
 */
const MOCK_SCRIPT: Array<[string, string]> = [
  ['SPEAKER_00', 'So'], ['SPEAKER_00', 'um'], ['SPEAKER_00', 'today'], ['SPEAKER_00', 'I'],
  ['SPEAKER_00', 'want'], ['SPEAKER_00', 'to'], ['SPEAKER_00', 'I'], ['SPEAKER_00', 'want'],
  ['SPEAKER_00', 'to'], ['SPEAKER_00', 'talk'], ['SPEAKER_00', 'about'], ['SPEAKER_00', 'building'],
  ['SPEAKER_00', 'a'], ['SPEAKER_00', 'video'], ['SPEAKER_00', 'editor'], ['SPEAKER_00', 'uh'],
  ['SPEAKER_00', 'that'], ['SPEAKER_00', 'edits'], ['SPEAKER_00', 'by'], ['SPEAKER_00', 'transcript'],
  ['SPEAKER_01', 'Right'], ['SPEAKER_01', 'and'], ['SPEAKER_01', 'the'], ['SPEAKER_01', 'hard'],
  ['SPEAKER_01', 'part'], ['SPEAKER_01', 'is'], ['SPEAKER_01', 'um'], ['SPEAKER_01', 'not'],
  ['SPEAKER_01', 'the'], ['SPEAKER_01', 'models'], ['SPEAKER_01', 'you'], ['SPEAKER_01', 'know'],
  ['SPEAKER_01', 'it'], ['SPEAKER_01', 'is'], ['SPEAKER_01', 'the'], ['SPEAKER_01', 'editor'],
  ['SPEAKER_00', 'Exactly'], ['SPEAKER_00', 'that'], ['SPEAKER_00', 'is'], ['SPEAKER_00', 'the'],
  ['SPEAKER_00', 'whole'], ['SPEAKER_00', 'insight'],
];

function mockTranscribe(duration: number): AsrResult {
  const n = MOCK_SCRIPT.length;
  const speechStart = Math.min(0.4, duration * 0.05);
  const speechEnd = Math.max(speechStart + 0.5, duration * 0.95);
  const slot = (speechEnd - speechStart) / n;

  const words: Word[] = MOCK_SCRIPT.map(([speaker, text], i) => ({
    id: `w${i}`,
    text,
    start: speechStart + i * slot,
    end: speechStart + i * slot + slot * 0.8,
    speaker,
  }));

  return { words, provider: 'mock', verbatim: true };
}
