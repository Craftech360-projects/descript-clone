import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { CONFIG, MODELS } from './config.ts';
import type { Word } from '../../../packages/core/src/types.ts';

export interface AsrResult {
  words: Word[];
  provider: string;
  /** True when the transcript preserves "um"/"uh". Filler removal needs this. */
  verbatim: boolean;
}

export interface AsrProvider {
  name: string;
  transcribe(audioPath: string, duration: number): Promise<AsrResult>;
}

export function getAsrProvider(): AsrProvider {
  return CONFIG.provider === 'fal' ? falAsr : mockAsr;
}

// ---------------------------------------------------------------------------
// fal
// ---------------------------------------------------------------------------

const falAsr: AsrProvider = {
  name: 'fal',

  async transcribe(audioPath, _duration) {
    const { fal } = await import('@fal-ai/client');
    fal.config({ credentials: CONFIG.falKey });

    const bytes = await readFile(audioPath);
    const file = new File([bytes], basename(audioPath), { type: 'audio/wav' });
    const audioUrl = await fal.storage.upload(file);

    const result: any = await fal.subscribe(MODELS.asr.endpoint, {
      input: {
        audio_url: audioUrl,
        task: 'transcribe',
        // The whole product hinges on this being honoured.
        chunk_level: 'word',
        diarize: true,
      },
    });

    const payload = result?.data ?? result;

    // The response shape is the one unverified assumption the product rests on.
    // Log its skeleton (keys and one sample item, not the whole transcript) so
    // that when it does not match, the fix is obvious instead of archaeological.
    console.log('[asr] response keys:', Object.keys(payload ?? {}));
    const sample = payload?.chunks?.[0] ?? payload?.words?.[0] ?? payload?.segments?.[0];
    if (sample) console.log('[asr] first item:', JSON.stringify(sample));

    const words = normalizeToWords(payload);

    if (words.length === 0) {
      throw new Error(
        `${MODELS.asr.endpoint} returned no usable WORD-level timings. Got keys: ` +
          `[${Object.keys(payload ?? {}).join(', ')}]. Either the response shape differs ` +
          `(fix normalizeToWords) or this endpoint only does segment-level timestamps, ` +
          `which is not enough for word-level editing — point MODELS.asr elsewhere.`,
      );
    }

    return { words, provider: `fal:${MODELS.asr.endpoint}`, verbatim: false };
  },
};

/**
 * ASR providers disagree wildly about response shape, and the exact shape of
 * this one is unverified. Rather than guess once and fail opaquely, accept the
 * three common shapes and fail loudly with the payload if none match.
 */
export function normalizeToWords(payload: any): Word[] {
  const raw: any[] =
    payload?.chunks ??
    payload?.words ??
    payload?.segments?.flatMap((s: any) => s.words ?? []) ??
    [];

  return raw
    .map((item, i) => {
      // [start, end] tuple, or explicit fields.
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
    // A word must occupy time, or the EDL produces zero-length ranges.
    .filter((w) => w.end > w.start);
}

// ---------------------------------------------------------------------------
// mock
// ---------------------------------------------------------------------------

/**
 * Not a toy. With no GPU and no API key, this is what lets the real pipeline —
 * ingest, EDL compile, ffmpeg render — be built and verified end to end at zero
 * cost. Only the words are fake; the timings are real, spread across the actual
 * media duration, and every downstream stage is exercised for real.
 *
 * It deliberately contains fillers and a false start so the filler and retake
 * detectors have something to find.
 */
const MOCK_SCRIPT = [
  'So', 'um', 'today', 'I', 'want', 'to', 'I', 'want', 'to', 'talk',
  'about', 'building', 'a', 'video', 'editor', 'uh', 'that', 'edits',
  'by', 'transcript', 'It', 'turns', 'out', 'the', 'hard', 'part',
  'is', 'not', 'the', 'models', 'you', 'know', 'it', 'is', 'the',
  'editor', 'itself', 'um', 'and', 'that', 'is', 'the', 'whole', 'insight',
];

const mockAsr: AsrProvider = {
  name: 'mock',

  async transcribe(_audioPath, duration) {
    const n = MOCK_SCRIPT.length;
    // Leave a little head and tail silence so top-and-tail trimming is visible.
    const speechStart = Math.min(0.4, duration * 0.05);
    const speechEnd = Math.max(speechStart + 0.5, duration * 0.95);
    const slot = (speechEnd - speechStart) / n;

    const words: Word[] = MOCK_SCRIPT.map((text, i) => ({
      id: `w${i}`,
      text,
      start: speechStart + i * slot,
      // 80% of the slot is the word, 20% is the gap to the next one.
      end: speechStart + i * slot + slot * 0.8,
      speaker: 'SPEAKER_00',
    }));

    return { words, provider: 'mock', verbatim: true };
  },
};
