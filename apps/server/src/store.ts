import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { CONFIG } from './config.ts';
import type { AsrOptions } from './asr.ts';
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

  /** Imported media is not transcribed until the user asks. */
  status: 'imported' | 'transcribed';
  transcript: Transcript | null;
  asrProvider: string | null;
  asrOptions?: AsrOptions;
  /** Whether the transcript actually preserves fillers. Drives a UI warning. */
  verbatim: boolean;

  /** Waveform envelope, computed at import (it is free and always useful). */
  peaks: number[];
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
    cache.set(id, project);
    return project;
  } catch {
    return null;
  }
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
