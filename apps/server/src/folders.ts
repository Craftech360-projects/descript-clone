/**
 * Folders, and the standing brief each one carries.
 *
 * ── the problem this solves ─────────────────────────────────────────────────
 *
 * A transcript tells you what was SAID. It does not tell you what the channel
 * is, who the audience is, what the recurring character is called, or how the
 * last forty videos were titled. Ask a model for a title from the transcript
 * alone and you get a competent description of the words — which is exactly what
 * a title should not be.
 *
 * So a folder is not filing. It is CONTEXT. "Cheeko" is a folder whose brief
 * says who Cheeko is and how these videos usually open; "China trip" is a folder
 * whose brief says it is travel, shot on a phone, aimed at friends. The same
 * transcript in those two folders should produce two very different titles, and
 * that difference is the whole point.
 *
 * The brief is plain prose on purpose. A form with fields for "tone" and "target
 * audience" collects what the form's author imagined mattered; a paragraph
 * collects what the person actually knows.
 *
 * Stored as one JSON file rather than one per folder: there will be tens of
 * these, never thousands, and the whole set is read on every listing.
 */

import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { CONFIG } from './config.ts';

export interface Folder {
  id: string;
  name: string;
  /**
   * What the model should know before it writes anything for this folder — the
   * memory the user described. Free prose; may be empty while a folder is new.
   */
  brief: string;
  createdAt: string;
  updatedAt: string;
}

const file = () => join(CONFIG.mediaDir, 'folders.json');

let cache: Folder[] | null = null;

export async function init(): Promise<void> {
  await mkdir(dirname(file()), { recursive: true }).catch(() => {});
  cache = await read();
}

async function read(): Promise<Folder[]> {
  try {
    const raw = await readFile(file(), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isFolder) : [];
  } catch {
    // Absent or unreadable both mean "no folders yet". A corrupt file must not
    // stop the app opening — the projects are the valuable thing, not this.
    return [];
  }
}

function isFolder(v: unknown): v is Folder {
  const f = v as Folder;
  return Boolean(f && typeof f.id === 'string' && typeof f.name === 'string');
}

/** Write through a temp file: a half-written folders.json would lose every brief. */
async function flush(list: Folder[]): Promise<void> {
  cache = list;
  const target = file();
  const tmp = `${target}.tmp`;
  await writeFile(tmp, JSON.stringify(list, null, 2), 'utf8');
  await rename(tmp, target);
}

export async function list(): Promise<Folder[]> {
  if (!cache) cache = await read();
  return [...cache].sort((a, b) => a.name.localeCompare(b.name));
}

export async function get(id: string): Promise<Folder | null> {
  return (await list()).find((f) => f.id === id) ?? null;
}

export async function create(name: string, brief = ''): Promise<Folder> {
  const now = new Date().toISOString();
  const folder: Folder = {
    id: randomUUID(),
    name: name.trim().slice(0, 80) || 'Untitled folder',
    brief: brief.slice(0, MAX_BRIEF),
    createdAt: now,
    updatedAt: now,
  };
  await flush([...(await list()), folder]);
  return folder;
}

/**
 * How much brief is worth keeping.
 *
 * Generous — this is someone describing their own show, and cutting them off
 * mid-thought would be the wrong economy — but bounded, because the whole thing
 * is prepended to every generation and an unbounded field becomes an unbounded
 * prompt.
 */
export const MAX_BRIEF = 8000;

export async function update(
  id: string,
  patch: { name?: string; brief?: string },
): Promise<Folder | null> {
  const all = await list();
  const i = all.findIndex((f) => f.id === id);
  if (i < 0) return null;

  const next: Folder = {
    ...all[i],
    ...(patch.name !== undefined ? { name: patch.name.trim().slice(0, 80) || all[i].name } : {}),
    ...(patch.brief !== undefined ? { brief: patch.brief.slice(0, MAX_BRIEF) } : {}),
    updatedAt: new Date().toISOString(),
  };
  const list2 = [...all];
  list2[i] = next;
  await flush(list2);
  return next;
}

export async function remove(id: string): Promise<boolean> {
  const all = await list();
  const next = all.filter((f) => f.id !== id);
  if (next.length === all.length) return false;
  await flush(next);
  return true;
}
