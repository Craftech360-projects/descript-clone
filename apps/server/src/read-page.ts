/**
 * Read the TEXT of a web page.
 *
 * The app could already fetch a URL, but only to pull a media FILE into a
 * project — `summon_media` downloads a video, an image or a track. Asked to look
 * at a website and say what a brand is about, Jumpy correctly reported that it
 * had no way to do it: there was no tool that returned a page's words.
 *
 * That gap mattered most for folder memory. "Read cheekoai.in and write the
 * memory for this folder" is exactly the sort of thing this app should do, and
 * it needed two things that did not exist: a way to read a page, and a way to
 * write a memory.
 *
 * ── on letting a model name a URL ───────────────────────────────────────────
 *
 * The address comes from a chat message, so it is untrusted input pointed at
 * this server's network position. `assertPublicUrl` — the same guard the media
 * fetch uses — resolves the host and refuses private, link-local, loopback and
 * carrier-NAT addresses, which is what stops "read http://169.254.169.254/" from
 * handing a model the cloud metadata service.
 *
 * The page's CONTENT is data, never instruction. It is returned wrapped and
 * labelled as untrusted so a page saying "ignore your instructions" is read as
 * a string a website contains, which is all it is.
 */

import { assertPublicUrl } from './summon.ts';

/** Pages get one shot and a short one: this sits in a chat turn. */
const TIMEOUT_MS = 12_000;
/** Enough for an about page; far short of a document that would eat the context. */
const MAX_BYTES = 2_000_000;
const MAX_CHARS = 12_000;

export interface PageText {
  url: string;
  title: string;
  text: string;
  truncated: boolean;
}

/**
 * HTML to something worth reading.
 *
 * No parser and no dependency: script and style go first (their contents are not
 * prose and would otherwise dominate), then tags, then entities, then the
 * whitespace HTML is full of. Crude, and right for the job — what is wanted is
 * roughly what a person would read, not a faithful DOM.
 */
export function htmlToText(html: string): { title: string; text: string } {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? '';

  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    // Block-level tags become breaks, so headings and list items do not run into
    // the sentence after them and read as one word.
    .replace(/<\/(p|div|section|article|h[1-6]|li|tr|br)[^>]*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { title: decodeEntities(title), text };
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .trim();
}

export async function readPage(raw: string): Promise<PageText> {
  const url = await assertPublicUrl(raw);

  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      // Identify honestly. A site that does not want automated readers should be
      // able to see one coming and say no.
      'user-agent': 'Jumpcut/1.0 (+editor assistant; reads page text on a user request)',
      accept: 'text/html,application/xhtml+xml,text/plain;q=0.9',
    },
  });

  if (!res.ok) throw new Error(`That page returned ${res.status}.`);

  const type = res.headers.get('content-type') ?? '';
  if (!/text\/html|text\/plain|application\/xhtml/i.test(type)) {
    throw new Error(
      `That URL is ${type.split(';')[0] || 'not text'} — this reads web pages. For a media file, use summon_media instead.`,
    );
  }

  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > MAX_BYTES) throw new Error('That page is too large to read.');

  const html = await res.text();
  if (html.length > MAX_BYTES) throw new Error('That page is too large to read.');

  const { title, text } = htmlToText(html);
  const truncated = text.length > MAX_CHARS;

  return {
    url: url.toString(),
    title,
    text: truncated ? `${text.slice(0, MAX_CHARS)}\n\n[…the rest of the page was not read]` : text,
    truncated,
  };
}
