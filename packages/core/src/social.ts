/**
 * Turning a transcript into something you can actually post.
 *
 * A title, a description and hashtags — written from what was SAID plus what the
 * folder's brief says this channel IS. The second half is what makes it useful:
 * from the transcript alone a model writes a competent summary of the words,
 * which is precisely what a title should not be. "We went to the market and it
 * was busy" is a description. "Cheeko meets his first dragon fruit" is a title,
 * and you can only write it if you know who Cheeko is.
 *
 * This module is the pure half — building the request and making sense of the
 * answer. It has no idea which model runs it, which is what lets the same code
 * serve a local Qwen and a hosted Claude.
 */

/** Platform conventions, so the copy fits where it is going. */
export interface SocialTarget {
  id: 'reels' | 'tiktok' | 'shorts' | 'generic';
  label: string;
  /** Where the title stops being read. */
  titleMax: number;
  /** Where the description gets truncated in the feed. */
  descriptionMax: number;
  /** How many tags are useful before they read as spam. */
  hashtagMax: number;
}

export const SOCIAL_TARGETS: readonly SocialTarget[] = [
  { id: 'reels', label: 'Instagram Reels', titleMax: 80, descriptionMax: 2200, hashtagMax: 10 },
  { id: 'tiktok', label: 'TikTok', titleMax: 80, descriptionMax: 2200, hashtagMax: 8 },
  { id: 'shorts', label: 'YouTube Shorts', titleMax: 100, descriptionMax: 1500, hashtagMax: 8 },
  { id: 'generic', label: 'Anywhere', titleMax: 90, descriptionMax: 1500, hashtagMax: 8 },
] as const;

export function targetFor(id: string): SocialTarget {
  return SOCIAL_TARGETS.find((t) => t.id === id) ?? SOCIAL_TARGETS[3];
}

export interface SocialDraft {
  title: string;
  description: string;
  hashtags: string[];
}

/**
 * How much transcript to send.
 *
 * A long recording is mostly middle, and a title comes from the shape of the
 * thing — how it opens, what it turns on, how it lands. Sending the whole
 * transcript costs context for very little: past a few thousand characters the
 * model is reading filler, and on a local 7B model it is the difference between
 * an answer and a timeout.
 *
 * So: the opening in full, then a thinned middle, then the ending in full.
 */
export function condenseTranscript(text: string, budget = 4000): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= budget) return clean;

  const head = Math.floor(budget * 0.5);
  const tail = Math.floor(budget * 0.3);
  const middle = budget - head - tail;

  const start = clean.slice(0, head);
  const end = clean.slice(-tail);
  // A slice from the centre rather than nothing: a video often turns in the
  // middle, and an ellipsis tells the model it is not seeing everything.
  const centre = clean.slice(
    Math.floor(clean.length / 2 - middle / 2),
    Math.floor(clean.length / 2 + middle / 2),
  );
  return `${start}\n…\n${centre}\n…\n${end}`;
}

/**
 * The instruction sent to whichever model is chosen.
 *
 * Written to be followed by a small local model as well as a large hosted one,
 * which means: say the output shape once, plainly, and do not bury it in prose.
 * JSON rather than a tool call, because tool-calling reliability is exactly what
 * varies most across local models and this needs to work on all of them.
 */
export function buildPrompt(opts: {
  transcript: string;
  brief: string;
  target: SocialTarget;
  projectName: string;
}): string {
  const { transcript, brief, target, projectName } = opts;

  const context = brief.trim()
    ? `## About this channel — use it, this is what makes the copy specific\n${brief.trim()}\n`
    : `## About this channel\nNothing recorded yet. Write from the transcript alone, and keep it plain rather than inventing a personality the channel may not have.\n`;

  return `You write social copy for short vertical video. You are given a transcript and, where it exists, a standing brief about the channel.

${context}
## The video
File: ${projectName}

Transcript:
"""
${transcript}
"""

## What to write, for ${target.label}
- title: at most ${target.titleMax} characters. Specific to THIS video. Not a summary of the words — a reason to watch. No clickbait, no ALL CAPS, no emoji unless the brief shows the channel uses them.
- description: at most ${target.descriptionMax} characters, but shorter is better — two or three sentences. Say what happens and why someone would care.
- hashtags: up to ${target.hashtagMax}, lowercase, no punctuation beyond the #, ordered from most specific to most general. Skip generic filler like #viral and #fyp unless the brief asks for them.

If the brief names a recurring person, pet, or series, use that name — it is the single most useful thing you have.

Reply with ONLY a JSON object, no prose around it, no code fence:
{"title": "...", "description": "...", "hashtags": ["#one", "#two"]}`;
}

/**
 * Read a draft out of whatever the model said.
 *
 * Small models wrap JSON in prose, in code fences, or both, and drop the array
 * for a comma-separated string often enough that refusing those answers would
 * throw away good copy over punctuation. So this is forgiving about the shape
 * and strict about the result: anything it cannot read becomes null and the
 * caller says so, rather than showing an empty box that looks like a bad answer.
 */
export function parseDraft(raw: string, target: SocialTarget): SocialDraft | null {
  if (!raw) return null;

  // Strip a code fence if there is one, then find the outermost object.
  const unfenced = raw.replace(/```(?:json)?/gi, '');
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start < 0 || end <= start) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(unfenced.slice(start, end + 1));
  } catch {
    return null;
  }

  const o = parsed as Record<string, unknown>;
  const title = typeof o.title === 'string' ? o.title.trim() : '';
  const description = typeof o.description === 'string' ? o.description.trim() : '';
  if (!title && !description) return null;

  return {
    title: title.slice(0, target.titleMax),
    description: description.slice(0, target.descriptionMax),
    hashtags: normalizeHashtags(o.hashtags, target.hashtagMax),
  };
}

/** Accepts an array, or the comma/space separated string a small model often sends. */
export function normalizeHashtags(value: unknown, max: number): string[] {
  const raw: string[] = Array.isArray(value)
    ? value.map((v) => String(v))
    : typeof value === 'string'
      ? value.split(/[,\s]+/)
      : [];

  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    // \p{M} — combining marks — is not optional. Without it Devanagari loses its
    // matras and "#यात्रा" comes out "#यतर", which is not a word. Any script that
    // builds letters from a base plus marks breaks the same way.
    const tag = `#${item.trim().replace(/^#+/, '').replace(/[^\p{L}\p{M}\p{N}_]/gu, '')}`.toLowerCase();
    if (tag.length < 2) continue;
    if (seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length >= max) break;
  }
  return out;
}
