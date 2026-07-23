import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CONFIG } from './config.ts';
import { readFontInfo, type FontFormat } from './fontmeta.ts';

/**
 * Imported caption fonts, stored ONCE for the whole install rather than per
 * project — a font you add is offered on every project, present and future, and
 * outlives any single one. That is the whole ask: universal, not per-file.
 *
 * The same file does double duty. The browser loads it via @font-face for the
 * live preview, and libass loads it from this directory (passed as the burn's
 * fontsdir — see render.ts) to rasterise the same glyphs into the export. So
 * preview and burn are the identical font, not two lookalikes.
 */

export interface CustomFont {
  /** Random, opaque: names the file on disk and addresses the DELETE route. */
  id: string;
  /**
   * The font's real family name, read from its `name` table. This is the value
   * stored in CaptionSettings.font, written as the ASS Fontname, and used as the
   * @font-face family — all three must be this exact string or they disagree.
   */
  family: string;
  /** What the font picker shows. The family reads well enough to be the label. */
  label: string;
  /** Browser-reachable URL for the file, for the preview's @font-face. */
  url: string;
  /** The @font-face `format()` hint the browser wants. */
  format: FontFormat;
  createdAt: string;
}

/** One entry as persisted: `url` is derived from `file` on read, never stored. */
type StoredFont = Omit<CustomFont, 'url'> & { file: string };

const dir = join(CONFIG.mediaDir, 'fonts');
const manifestPath = join(dir, 'manifest.json');

/** Absolute path libass scans for imported families. */
export function fontsDir(): string {
  return dir;
}

export async function init(): Promise<void> {
  await mkdir(dir, { recursive: true });
}

const EXT: Record<FontFormat, string> = {
  truetype: '.ttf',
  opentype: '.otf',
  woff: '.woff',
  woff2: '.woff2',
};

/** Accepted upload extensions, only used to reject obvious non-fonts up front. */
export const ACCEPTED_FONT_EXTENSIONS = ['.ttf', '.otf', '.ttc', '.woff', '.woff2'];

async function readManifest(): Promise<StoredFont[]> {
  try {
    return JSON.parse(await readFile(manifestPath, 'utf8')) as StoredFont[];
  } catch {
    // No manifest yet, or an unreadable one: an empty library, not an error.
    return [];
  }
}

async function writeManifest(fonts: StoredFont[]): Promise<void> {
  await writeFile(manifestPath, JSON.stringify(fonts, null, 2));
}

function toCustomFont(f: StoredFont): CustomFont {
  const { file, ...rest } = f;
  return { ...rest, url: `/media/fonts/${file}` };
}

export async function list(): Promise<CustomFont[]> {
  return (await readManifest()).map(toCustomFont);
}

/**
 * Store an uploaded font and return its library entry.
 *
 * Keyed by family: importing a family that already exists REPLACES it, keeping
 * the same id so any project already pointing at it keeps working — the natural
 * meaning of dropping in a newer cut of the same face. Throws (before touching
 * disk) when the bytes are not a font we can name.
 */
export async function add(buffer: Buffer): Promise<CustomFont> {
  // Parse first: a file we cannot read a family from must not leave a stray file
  // or a manifest entry behind.
  const info = readFontInfo(buffer);
  const fonts = await readManifest();

  const existing = fonts.find((f) => f.family === info.family);
  const id = existing?.id ?? randomUUID();
  const file = `${id}${EXT[info.format]}`;

  // A replacement can arrive in a different format than the original; drop the
  // old file if its name no longer matches, so nothing orphaned lingers.
  if (existing && existing.file !== file) {
    await unlink(join(dir, existing.file)).catch(() => {});
  }

  await writeFile(join(dir, file), buffer);

  const entry: StoredFont = {
    id,
    family: info.family,
    label: info.family,
    format: info.format,
    file,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  };

  const next = existing ? fonts.map((f) => (f.id === id ? entry : f)) : [...fonts, entry];
  await writeManifest(next);
  return toCustomFont(entry);
}

/** Remove a font by id. Returns false when there was nothing to remove. */
export async function remove(id: string): Promise<boolean> {
  const fonts = await readManifest();
  const target = fonts.find((f) => f.id === id);
  if (!target) return false;

  await unlink(join(dir, target.file)).catch(() => {});
  await writeManifest(fonts.filter((f) => f.id !== id));
  return true;
}
