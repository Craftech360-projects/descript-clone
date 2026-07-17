import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { ASR_ENDPOINT, ASR_MODELS, CONFIG, type AsrModelId } from './config.ts';
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
  // Scribe is verbatim by construction — there is no flag to ask for it, and no
  // Whisper-family option left to fall back to. `verbatim` below is now a
  // statement about the model, not a request sent anywhere.
  model: 'scribe_v1',
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

/**
 * Progress reporting for ASR.
 *
 * There is nothing honest to put in a bar here, and `progress: -1` says so.
 * Going direct traded fal's queue channel for a single blocking POST: fal at
 * least reported "Queued · position 3", which was a fact. The direct endpoint
 * reports nothing until it returns the finished transcript, so `stage` is all
 * that is left to be truthful with. A percentage would be invention.
 */
export interface AsrProgress {
  /** 0..1 where a real fraction exists, -1 where it genuinely does not. */
  progress: number;
  stage: string;
}

export async function transcribe(
  audioPath: string,
  duration: number,
  options: AsrOptions,
  onProgress?: (p: AsrProgress) => void,
): Promise<AsrResult> {
  if (options.model === 'mock' || !CONFIG.hasAsr()) {
    // The mock is synchronous and instant. It gets no progress bar, because
    // there is no progress to report and a fake one would be a lie.
    return mockTranscribe(duration);
  }
  return elevenLabsTranscribe(audioPath, options, onProgress);
}

// ---------------------------------------------------------------------------
// ElevenLabs
// ---------------------------------------------------------------------------

/**
 * Build the multipart body.
 *
 * Direct means the audio IS the request body — there is no upload-to-storage
 * step and no public URL, which is one less hop and one less place a user's
 * recording sits at a guessable address.
 *
 * FormData coerces values with String(), so a boolean would arrive as the
 * string "false" — which is truthy on the far side. Every flag is stringified
 * deliberately here rather than left to chance.
 */
export function buildForm(file: Blob, filename: string, options: AsrOptions): FormData {
  const form = new FormData();
  form.set('file', file, filename);
  form.set('model_id', options.model);
  // The whole product hinges on this being honoured: word-level or nothing.
  form.set('timestamps_granularity', 'word');
  form.set('diarize', String(options.diarize));
  // Surfaces [laughter]/[applause] as their own timed tokens.
  form.set('tag_audio_events', 'true');

  if (options.language !== 'auto') form.set('language_code', options.language);
  // Under fal this knob did not exist and the setting was dead. Direct, Scribe
  // accepts a speaker count — so the Transcribe panel's control now does something.
  if (options.speakers > 0) form.set('num_speakers', String(options.speakers));

  return form;
}

async function elevenLabsTranscribe(
  audioPath: string,
  options: AsrOptions,
  onProgress?: (p: AsrProgress) => void,
): Promise<AsrResult> {
  const bytes = await readFile(audioPath);
  const form = buildForm(new Blob([bytes], { type: 'audio/wav' }), basename(audioPath), options);

  // One stage for the whole remote call. The POST uploads and transcribes in a
  // single request that reports nothing until it returns, so splitting this into
  // "Uploading" then "Transcribing" would be a guess about a boundary we cannot
  // observe.
  onProgress?.({ progress: -1, stage: 'Transcribing' });

  const res = await fetch(ASR_ENDPOINT, {
    method: 'POST',
    headers: { 'xi-api-key': CONFIG.elevenLabsKey },
    body: form,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(
      `ElevenLabs returned ${res.status}${res.status === 401 ? ' — check ELEVENLABS_API_KEY' : ''}` +
        `${detail ? `: ${detail.slice(0, 400)}` : ''}`,
    );
  }

  const payload: any = await res.json();

  // The response shape is the one unverified assumption the product rests on.
  // Log its skeleton so a mismatch is obvious rather than archaeological.
  console.log('[asr] keys:', Object.keys(payload ?? {}));
  const sample = payload?.words?.[0];
  if (sample) console.log('[asr] first item:', JSON.stringify(sample));

  const words = normalizeToWords(payload);

  if (words.length === 0) {
    throw new Error(
      `${options.model} returned no usable WORD-level timings (keys: ` +
        `${Object.keys(payload ?? {}).join(', ')}). Either the response shape differs — ` +
        `fix normalizeToWords() — or timestamps_granularity was not honoured, ` +
        `which cannot support word-level editing.`,
    );
  }

  const declared = ASR_MODELS.find((m) => m.id === options.model);

  return {
    words,
    provider: options.model,
    // Still read from the declared model rather than assumed: verbatim is a
    // property of the model, and the UI's filler warning depends on it being true.
    verbatim: declared?.verbatim ?? false,
  };
}

/**
 * Scribe's flat `words[]` is the only shape parsed now.
 *
 * The Whisper-family branches (`chunks`, `segments[].words`, `[start, end]`
 * timestamp tuples) went with fal — they described providers this can no longer
 * reach, and a fallback for a shape nothing sends is a shape nothing tests.
 *
 * `type` still matters: Scribe emits the whitespace BETWEEN words as its own
 * token. Spacing carries real timings, so it survives the end > start filter and
 * would otherwise land in the document as blank words. Audio events
 * ([laughter], [applause]) are kept deliberately — they are timed tokens the
 * editor can cut like any other word.
 */
export function normalizeToWords(payload: any): Word[] {
  const raw: any[] = payload?.words ?? [];

  return raw
    .map((item, i) => {
      if (item.type === 'spacing') return null;

      const text = (item.text ?? '').trim();
      if (typeof item.start !== 'number' || typeof item.end !== 'number' || !text) return null;

      return {
        id: `w${i}`,
        text,
        start: item.start,
        end: item.end,
        speaker: item.speaker_id ?? undefined,
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
