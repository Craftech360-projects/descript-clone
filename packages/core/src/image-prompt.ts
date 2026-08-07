/**
 * Turning "a friendly robot waving" into a place in the video and a shape to
 * generate at.
 *
 * This is the half of the image feature that has no user interface: you say what
 * you want to see, and the app decides WHERE it belongs and WHAT SHAPE it should
 * be. Both answers are derived rather than asked for, so both live here as pure
 * functions the UI and the assistant call identically — the alternative is the
 * panel and the chat quietly disagreeing about where an image goes.
 *
 * ── why placement is a word match and not a model call ───────────────────────
 *
 * The obvious design is to ask an LLM "where in this transcript does a robot
 * belong". It is also the wrong one for the common case, and expensively so: the
 * user typed the noun, the speaker said the noun, and the answer is the noun. A
 * round trip that returns "0:12" for a question whose answer is already sitting
 * in two strings is latency the feature cannot afford — this runs while the user
 * waits for a picture that is already generating.
 *
 * The assistant is still free to place an image anywhere it likes by naming the
 * phrase itself (add_image_at_words). This is the DEFAULT, not the ceiling.
 *
 * What it deliberately does not attempt: synonyms, embeddings, or "this passage
 * is thematically about robots". Those are the cases where a wrong answer is
 * confidently wrong and impossible for the user to predict, and where the honest
 * move is to place nothing and say so — see `placeByPrompt` returning null.
 */

import type { Word } from './types.ts';

/**
 * Words that carry no picture.
 *
 * Two groups, and they earn their place differently. The first is ordinary
 * stopwords — matching "a" would put an image on the first article in the
 * script. The second is the vocabulary of ASKING for a picture ("image of",
 * "a shot of", "photo") which appears in prompts constantly and never in
 * speech about the subject; without it, "a picture of a robot" would try to
 * land on the word "picture".
 */
const IGNORED = new Set([
  // articles, conjunctions, prepositions, auxiliaries
  'a', 'an', 'the', 'and', 'or', 'but', 'of', 'in', 'on', 'at', 'to', 'for',
  'with', 'from', 'by', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'it', 'its', 'this', 'that', 'these', 'those', 'there', 'here', 'into', 'over',
  'under', 'up', 'down', 'out', 'off', 'very', 'some', 'any', 'my', 'your',
  // the vocabulary of requesting an image
  'image', 'images', 'picture', 'pictures', 'photo', 'photos', 'photograph',
  'shot', 'render', 'rendering', 'illustration', 'drawing', 'art', 'artwork',
  'graphic', 'graphics', 'show', 'showing', 'depicting', 'featuring', 'style',
  'background', 'closeup', 'close', 'wide', 'angle', 'view', 'scene',
]);

/** Letters and digits only, lowercased — so "Robot," and "robot" match. */
function norm(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Crude singular/plural fold, applied to BOTH sides so it never has to be right
 * in the abstract — only consistent.
 *
 * "robots" → "robot" is the case that matters: the prompt is written in whatever
 * number reads well and the speaker said whatever they said, and an image that
 * fails to place because of a trailing s is a feature that looks broken. Left
 * deliberately shallow — a real stemmer would start folding "running" onto "run"
 * and "business" onto "busy", which is how a match becomes a surprise.
 */
function stem(word: string): string {
  if (word.length > 3 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith('es') && !word.endsWith('ses')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/** The content words of a prompt, in order, deduplicated. */
export function promptKeywords(prompt: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of prompt.split(/\s+/)) {
    const n = norm(raw);
    // Single characters are never the subject, and digits alone ("4k", "2")
    // are settings rather than content.
    if (n.length < 2 || IGNORED.has(n) || /^\d+$/.test(n)) continue;
    const s = stem(n);
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/** Where an image should go, and why — the `why` is shown to the user. */
export interface Placement {
  wordId: string;
  wordText: string;
  start: number;
  end: number;
  /** The prompt keyword that matched, so the UI can say "placed on ‘robot’". */
  matched: string;
}

/**
 * The first moment in the edit that the prompt is talking about, or null.
 *
 * ── why the FIRST occurrence ─────────────────────────────────────────────────
 *
 * Because that is where the idea is introduced, and an illustration belongs with
 * the introduction rather than with an incidental later mention. It is also the
 * only rule a user can predict without reading the code — "it goes on the first
 * time you say it" is a sentence; "it goes on the mention with the highest score"
 * is not, and an unpredictable placement is worse than a manual one.
 *
 * ── why keyword ORDER decides ties ───────────────────────────────────────────
 *
 * Prompts put their subject first ("a robot in a field", not "a field with a
 * robot") far more often than not, so when several keywords appear in the
 * script, the earliest keyword in the PROMPT wins rather than the earliest match
 * in the transcript. Placing "a robot in a field" on the word "field" because
 * the speaker happened to say it first is exactly the confidently-wrong answer
 * this function exists to avoid.
 *
 * Deleted words are skipped: they are not in the output, so an image placed on
 * one would appear over a moment that no longer exists.
 */
export function placeByPrompt(words: Word[], prompt: string): Placement | null {
  const keywords = promptKeywords(prompt);
  if (keywords.length === 0) return null;

  const live = words.filter((w) => !w.deleted);
  if (live.length === 0) return null;

  // Indexed once rather than scanned per keyword: a transcript is thousands of
  // words and a prompt is a handful, so this is the cheap direction.
  const firstByStem = new Map<string, Word>();
  for (const w of live) {
    const s = stem(norm(w.text));
    if (!s || firstByStem.has(s)) continue;
    firstByStem.set(s, w);
  }

  for (const keyword of keywords) {
    const hit = firstByStem.get(keyword);
    if (hit) {
      return { wordId: hit.id, wordText: hit.text, start: hit.start, end: hit.end, matched: keyword };
    }
  }
  return null;
}

// ── the shape to generate at ──────────────────────────────────────────────────

/**
 * The aspect ratios the image model will actually honour.
 *
 * This list is a CONSTRAINT, not a preference: a ratio outside it is silently
 * rewritten to 1:1 by the API rather than rejected, which would come back as a
 * square image dropped into a widescreen frame with no error anywhere. So the
 * request is snapped to this list here, on our side, where it can be tested.
 */
export const GENERATED_ASPECT_RATIOS = [
  '1:1',
  '2:3',
  '3:2',
  '3:4',
  '4:3',
  '4:5',
  '5:4',
  '9:16',
  '16:9',
  '21:9',
] as const;

export type GeneratedAspectRatio = (typeof GENERATED_ASPECT_RATIOS)[number];

/**
 * The supported ratio closest to the frame the video will actually ship in.
 *
 * Generating at the output's shape is the whole point of asking: an image made
 * 16:9 and composited full-frame onto a 9:16 reel is cropped to its middle
 * third, so the subject the user described is the first thing to go. Matching
 * the frame means `cover` has nothing to crop.
 *
 * Compared in LOG space, so "twice as wide as it should be" and "half as wide"
 * are the same size of mistake. Compared linearly, 21:9 (2.33) sits 0.55 from
 * 16:9 (1.78) while 9:16 (0.5625) sits only 0.44 from 1:1 — so a portrait frame
 * would be pulled towards square by arithmetic rather than by anything visual.
 */
export function nearestAspectRatio(width: number, height: number): GeneratedAspectRatio {
  // A frame with no area is a project whose dimensions have not been probed yet;
  // 16:9 is the honest default because it is what most source video is.
  if (!(width > 0) || !(height > 0)) return '16:9';

  const target = Math.log(width / height);
  let best: GeneratedAspectRatio = '1:1';
  let bestDistance = Infinity;

  for (const ratio of GENERATED_ASPECT_RATIOS) {
    const [w, h] = ratio.split(':').map(Number);
    const distance = Math.abs(Math.log(w / h) - target);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = ratio;
    }
  }
  return best;
}
