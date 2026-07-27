import type { ReactNode } from 'react';

/**
 * A small Markdown renderer for the assistant's replies.
 *
 * The model answers in Markdown — **bold**, numbered and bulleted lists, `code`,
 * the occasional heading — and the chat bubble used to print that verbatim, so a
 * recommendation arrived as a wall of asterisks and literal "1."s. Rather than
 * pull in a parser (this app ships no UI libraries by design), this handles the
 * subset the assistant actually emits: paragraphs, ATX headings, ordered and
 * bulleted lists with one level of nesting, and inline bold / italic / code / links.
 *
 * It is deliberately forgiving: anything it does not recognise falls through as
 * plain text, so a malformed list or an unclosed `**` never throws — it just
 * renders as whatever the model typed.
 */
export default function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Blank lines are block separators; they carry no content of their own.
    if (!line.trim()) {
      i++;
      continue;
    }

    // ATX heading: one to six leading hashes. Chat rarely goes past h3, so the
    // level is clamped and the two smallest just render as emphasised body text.
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const level = Math.min(h[1].length, 4);
      blocks.push(
        <div key={`b${key++}`} className={`md-h md-h${level}`}>
          {inline(h[2], `h${key}`)}
        </div>,
      );
      i++;
      continue;
    }

    // A list — ordered or bulleted. parseList consumes the whole run (including
    // blank lines between items and any nested sub-lists) and hands back where it
    // stopped.
    if (itemInfo(line)) {
      const [node, next] = parseList(lines, i, `b${key++}`);
      blocks.push(node);
      i = next;
      continue;
    }

    // Otherwise a paragraph: consecutive lines that are neither blank, a list, nor
    // a heading. Single newlines inside it become <br/> so a soft-wrapped reply
    // keeps its shape.
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !itemInfo(lines[i]) &&
      !/^#{1,6}\s+/.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    const kp = `b${key++}`;
    blocks.push(
      <p key={kp} className="md-p">
        {para.map((ln, li) => (
          <span key={li}>
            {li > 0 && <br />}
            {inline(ln, `${kp}-${li}`)}
          </span>
        ))}
      </p>,
    );
  }

  return <>{blocks}</>;
}

interface ItemInfo {
  /** Leading whitespace, in spaces (a tab counts as two), used to detect nesting. */
  indent: number;
  ordered: boolean;
  text: string;
}

/** Read one line as a list item, or null if it is not one. */
function itemInfo(line: string): ItemInfo | null {
  const m = /^(\s*)(?:(\d+)[.)]|[-*+])\s+(.*)$/.exec(line);
  if (!m) return null;
  return { indent: m[1].replace(/\t/g, '  ').length, ordered: m[2] !== undefined, text: m[3] };
}

/** Index of the next non-blank line at or after `from` (may be lines.length). */
function firstNonBlank(lines: string[], from: number): number {
  let i = from;
  while (i < lines.length && !lines[i].trim()) i++;
  return i;
}

/**
 * Consume one list starting at `start` and return its node plus the index of the
 * first line that is not part of it. Nesting is by indentation: a deeper item
 * hangs off the item above it; a shallower one ends this list. A blank line only
 * ends the list if what follows is not another item at this level or deeper — so
 * the space the model leaves between numbered points does not restart the count.
 */
function parseList(lines: string[], start: number, key: string): [ReactNode, number] {
  const first = itemInfo(lines[start])!;
  const base = first.indent;
  const ordered = first.ordered;
  const items: { text: string; children: ReactNode[] }[] = [];
  let i = start;

  while (i < lines.length) {
    if (!lines[i].trim()) {
      const n = firstNonBlank(lines, i);
      const info = n < lines.length ? itemInfo(lines[n]) : null;
      // Continue across the gap only if the next content still belongs to us.
      if (info && (info.indent > base || (info.indent === base && info.ordered === ordered))) {
        i = n;
        continue;
      }
      break;
    }

    const info = itemInfo(lines[i]);
    if (!info || info.indent < base) break;

    if (info.indent > base) {
      // Deeper than us → a sub-list belonging to the item just above.
      const [child, next] = parseList(lines, i, `${key}n${items.length}`);
      if (items.length) items[items.length - 1].children.push(child);
      i = next;
      continue;
    }

    // A switch between ordered and bulleted at the same indent is a new block.
    if (info.ordered !== ordered) break;
    items.push({ text: info.text, children: [] });
    i++;
  }

  const Tag = ordered ? 'ol' : 'ul';
  const node = (
    <Tag key={key} className="md-list">
      {items.map((it, idx) => (
        <li key={idx}>
          {inline(it.text, `${key}-${idx}`)}
          {it.children}
        </li>
      ))}
    </Tag>
  );
  return [node, i];
}

/**
 * Inline spans: `code`, **bold**, *italic*, and [links](url).
 *
 * One regex, alternated in precedence order: code first, so `*` or `_` inside a
 * span never reads as emphasis; then bold before italic, so `**` is not eaten one
 * `*` at a time.
 */
function inline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const re =
    /(`[^`]+`)|(\*\*[\s\S]+?\*\*)|(__[\s\S]+?__)|(\*[^*\n]+?\*)|(_[^_\n]+?_)|(\[[^\]]+?\]\([^)\s]+?\))/g;
  let last = 0;
  let n = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const tok = m[0];
    const k = `${keyPrefix}i${n++}`;
    if (m[1]) nodes.push(<code key={k}>{tok.slice(1, -1)}</code>);
    else if (m[2] || m[3]) nodes.push(<strong key={k}>{tok.slice(2, -2)}</strong>);
    else if (m[4] || m[5]) nodes.push(<em key={k}>{tok.slice(1, -1)}</em>);
    else if (m[6]) {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok);
      nodes.push(
        link ? (
          <a key={k} href={link[2]} target="_blank" rel="noreferrer">
            {link[1]}
          </a>
        ) : (
          tok
        ),
      );
    }
    last = m.index + tok.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}
