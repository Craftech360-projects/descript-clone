/**
 * Making a picture instead of finding one.
 *
 * This replaced a web search, and the reason is the feature it serves: an insert
 * is supposed to illustrate the sentence being spoken, and a stock library can
 * only ever offer the nearest thing somebody already photographed. It also
 * removes the licence problem wholesale — a searched bed or image is almost
 * always CC BY, which means a credit obligation the user carries to publication;
 * a generated one is theirs.
 *
 * The other half is SHAPE. A generated image can be asked for at the aspect
 * ratio the video will actually ship in, so a full-frame cutaway has nothing to
 * crop. Search could not do that at all: you take the photograph's shape and
 * lose the sides. See nearestAspectRatio in core/image-prompt.ts.
 *
 * ── UNVERIFIED, and where the risk sits ──────────────────────────────────────
 *
 * This was written from Google's published documentation WITHOUT a live key to
 * check it against, which is a materially weaker position than the rest of this
 * codebase is written from — the ffmpeg graphs next door were each measured
 * against a real render before being committed. Two specifics:
 *
 *  1. **The aspect-ratio field has two documented spellings.** Google's own
 *     pages show `generationConfig.responseFormat.image.aspectRatio`, while
 *     several client libraries report `generationConfig.imageConfig.aspectRatio`.
 *     BOTH are sent below. They are additive and an unrecognised field is
 *     ignored, so sending both costs nothing and sending only the wrong one
 *     costs everything: an out-of-list or unread ratio is SILENTLY rewritten to
 *     1:1 rather than rejected, and a square image dropped into a widescreen
 *     frame looks like a cropping bug rather than an API mistake. Once someone
 *     confirms with a real key, delete the loser.
 *  2. **The response is interleaved.** `parts` carries text and image blocks in
 *     whatever order the model emits them, so the image is found by scanning for
 *     the first part with `inlineData` — never `parts[0]`.
 *
 * A refusal (safety, or a prompt it will not draw) comes back as a 200 with
 * prose and no image part. That is why the no-image branch surfaces the model's
 * own text: "generation failed" would hide the one thing that explains it.
 */

import { CONFIG } from './config.ts';
import type { GeneratedAspectRatio } from '../../../packages/core/src/image-prompt.ts';

/** What the caller gets back: bytes ready for disk, and what they are. */
export interface GeneratedImage {
  bytes: Buffer;
  /** e.g. 'image/png'. Decides the file extension the asset is stored under. */
  mime: string;
}

export interface GenerateRequest {
  prompt: string;
  /** Already snapped to a ratio the model honours — see nearestAspectRatio. */
  aspectRatio: GeneratedAspectRatio;
}

/**
 * "Nano Banana 2". The Flash image model rather than Pro: an insert is a
 * three-second cutaway behind someone talking, and the user is waiting for it
 * with the editor open — speed is worth more here than the last increment of
 * fidelity.
 */
const MODEL = 'gemini-3.1-flash-image';

/**
 * 2K, not 4K. The image is composited into a frame that is 1080p in the common
 * case and then re-encoded by x264, so 4K buys nothing the viewer can see and
 * costs generation time and disk on every insert.
 */
const IMAGE_SIZE = '2K';

const ENDPOINT = `https://generativelanguage.googleapis.com/v1/models/${MODEL}:generateContent`;

/** True when generation is configured at all. Drives the UI's affordance. */
export function canGenerateImages(): boolean {
  return Boolean(CONFIG.geminiApiKey);
}

export async function generateImage({ prompt, aspectRatio }: GenerateRequest): Promise<GeneratedImage> {
  if (!CONFIG.geminiApiKey) {
    throw new Error('Image generation needs GEMINI_API_KEY on the server.');
  }
  const text = prompt.trim();
  if (!text) throw new Error('Describe the image you want.');

  const body = {
    contents: [{ parts: [{ text: promptFor(text, aspectRatio) }] }],
    generationConfig: {
      // Both modalities, because the model may narrate what it drew — asking for
      // IMAGE alone is not a documented way to suppress that, and the parse
      // below tolerates the text either way.
      responseModalities: ['TEXT', 'IMAGE'],
      // See the header: two spellings, both sent, until one is confirmed.
      responseFormat: { image: { aspectRatio, imageSize: IMAGE_SIZE } },
      imageConfig: { aspectRatio, imageSize: IMAGE_SIZE },
    },
  };

  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        // A header, not a bearer token and not a query parameter — a key in the
        // URL would end up in every proxy and access log between here and Google.
        'x-goog-api-key': CONFIG.geminiApiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error(`Could not reach the image model: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (!res.ok) {
    // Google puts the useful sentence in `error.message`; the status alone is
    // "400" for a bad key, a bad model id and a rejected prompt alike.
    const detail = await res
      .json()
      .then((b: { error?: { message?: string } }) => b?.error?.message)
      .catch(() => undefined);
    if (res.status === 401 || res.status === 403) {
      throw new Error(`The Gemini API key was rejected${detail ? `: ${detail}` : '.'}`);
    }
    if (res.status === 429) {
      throw new Error('The image model is rate-limiting this key. Try again in a moment.');
    }
    throw new Error(`Image generation failed (${res.status})${detail ? `: ${detail}` : '.'}`);
  }

  const data = (await res.json()) as GeminiResponse;
  const parts = data.candidates?.[0]?.content?.parts ?? [];

  // Interleaved: scan for the image rather than indexing at 0.
  const image = parts.find((p) => p.inlineData?.data);
  if (!image?.inlineData) {
    // A refusal arrives as a 200 with prose and no picture. Say what it said.
    const said = parts
      .map((p) => p.text)
      .filter(Boolean)
      .join(' ')
      .trim();
    const why = data.candidates?.[0]?.finishReason;
    throw new Error(
      said
        ? `The model did not produce an image: ${said}`
        : `The model did not produce an image${why ? ` (${why})` : '.'}`,
    );
  }

  return {
    bytes: Buffer.from(image.inlineData.data, 'base64'),
    mime: image.inlineData.mimeType || 'image/png',
  };
}

/**
 * What is actually sent, as opposed to what the user typed.
 *
 * Two additions, both about the picture's JOB rather than its content. It is
 * composited full-frame behind someone talking, so it has to read in three
 * seconds at a glance and it must not carry text — a generated caption competes
 * with the real captions burned on top of it and is the single most obvious
 * "this was made by a machine" tell. The ratio is repeated in words because the
 * structured field is the part this file is least sure of; if it is being
 * ignored, this at least pushes the composition the right way.
 */
function promptFor(prompt: string, aspectRatio: GeneratedAspectRatio): string {
  return (
    `${prompt}\n\n` +
    `Compose this as a ${aspectRatio} image for use as a full-frame B-roll cutaway in a video. ` +
    `Fill the whole frame edge to edge, with the subject clear and centred enough to survive a small crop. ` +
    `No text, captions, watermarks, logos or borders.`
  );
}

interface GeminiResponse {
  candidates?: Array<{
    finishReason?: string;
    content?: {
      parts?: Array<{
        text?: string;
        inlineData?: { mimeType?: string; data: string };
      }>;
    };
  }>;
}

/** The file extension for what came back. Mirrors music's EXT_BY_TYPE. */
export function extensionFor(mime: string): string {
  return IMAGE_EXT[mime.split(';')[0].trim()] ?? '.png';
}

const IMAGE_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/webp': '.webp',
};
