import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { CONFIG } from './config.ts';
import { probe } from './ffmpeg.ts';
import type { AsrOptions } from './asr.ts';
import type { Thumbs } from './thumbs.ts';
import type { CaptionSettings } from '../../../packages/core/src/caption-style.ts';
import type { CutSettings } from '../../../packages/core/src/doc.ts';
import type { Transcript } from '../../../packages/core/src/types.ts';

export interface Project {
  id: string;
  name: string;
  /** Absolute path to the original upload. Never modified. */
  sourcePath: string;
  /** Browser-reachable URL for the same file, for preview without rendering. */
  sourceUrl: string;
  duration: number;
  hasVideo: boolean;
  width?: number;
  height?: number;
  /** Frames per second. Absent on audio, and on projects imported before it was read. */
  fps?: number;

  /** Imported media is not transcribed until the user asks. */
  status: 'imported' | 'transcribed';
  transcript: Transcript | null;
  asrProvider: string | null;
  asrOptions?: AsrOptions;
  /** Whether the transcript actually preserves fillers. Drives a UI warning. */
  verbatim: boolean;

  /** Waveform envelope, computed at import (it is free and always useful). */
  peaks: number[];
  /**
   * Filmstrip sheets. Absent on audio, and on video that has not been asked for
   * them yet — building them costs ~8s, so it is a job the client kicks off on
   * first open rather than something import blocks on.
   */
  thumbs?: Thumbs;
  /**
   * Caption look and placement. Persisted so a placement dragged by hand
   * survives a reload. Absent on projects saved before captions existed — the
   * client falls back to DEFAULT_CAPTIONS.
   */
  captions?: CaptionSettings;
  /**
   * Output speed multiplier. Persisted so a decision about the finished piece is
   * not lost on reload. Absent on projects saved before speed existed —
   * everything reading it goes through clampSpeed, which maps undefined to 1.
   */
  speed?: number;
  /**
   * Cut settings — pause cap, padding, fades. Persisted per project: these were
   * treated as engine defaults you rarely touch, but the pause cap is one people
   * set per piece and expect to stick, so losing it on every project switch read
   * as a bug. maxGapMs is stored the way the wire speaks it — 0 for "keep every
   * pause" — because Infinity does not survive JSON. Absent on projects saved
   * before this; the client falls back to the engine defaults via cutFromWire.
   */
  cut?: CutSettings;
  createdAt: string;
}

const projectsDir = join(CONFIG.mediaDir, 'projects');
const cache = new Map<string, Project>();

export async function init(): Promise<void> {
  await mkdir(projectsDir, { recursive: true });
  await mkdir(join(CONFIG.mediaDir, 'uploads'), { recursive: true });
  await mkdir(join(CONFIG.mediaDir, 'renders'), { recursive: true });
}

export async function save(project: Project): Promise<void> {
  cache.set(project.id, project);
  await writeFile(join(projectsDir, `${project.id}.json`), JSON.stringify(project, null, 2));
}

export async function get(id: string): Promise<Project | null> {
  const cached = cache.get(id);
  if (cached) return cached;

  try {
    const project = JSON.parse(
      await readFile(join(projectsDir, `${id}.json`), 'utf8'),
    ) as Project;
    // Migrate BEFORE caching. Callers mutate the object this returns and then
    // save it, so a post-cache migration would be silently dropped.
    const migrated = await migrate(project);
    cache.set(id, migrated);
    return migrated;
  } catch {
    return null;
  }
}

/**
 * Bring a project written by an older build up to date, lazily, on first open.
 *
 * Lazy rather than a migration pass: there is no schema version to key off, the
 * work is cheap, and a project that is never opened never needs it.
 */
async function migrate(project: Project): Promise<Project> {
  // fps was added after this project was imported. It is one ffprobe call, once,
  // and then it is on disk forever.
  if (project.hasVideo && project.fps === undefined) {
    try {
      const info = await probe(project.sourcePath);
      if (info.fps !== undefined) {
        const next = { ...project, fps: info.fps };
        await save(next);
        return next;
      }
    } catch {
      // The source may be gone, or ffprobe may not be installed. Neither is a
      // reason to fail opening the project — fps is a nicety.
    }
  }
  return project;
}

/** The media library listing. Peaks are omitted — too big, and not needed here. */
export async function list(): Promise<Array<Omit<Project, 'peaks' | 'transcript'>>> {
  const files = await readdir(projectsDir).catch(() => [] as string[]);
  const projects = await Promise.all(
    files.filter((f) => f.endsWith('.json')).map((f) => get(f.replace('.json', ''))),
  );

  return projects
    .filter((p): p is Project => p !== null)
    .map(({ peaks, transcript, ...rest }) => rest)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
