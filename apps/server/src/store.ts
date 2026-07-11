import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { CONFIG } from './config.ts';
import type { Transcript } from '../../../packages/core/src/types.ts';

export interface Project {
  id: string;
  name: string;
  /** Absolute path to the original upload. Never modified. */
  sourcePath: string;
  /** Browser-reachable URL for the same file, so the editor can preview edits
   *  against the source without rendering anything. */
  sourceUrl: string;
  duration: number;
  hasVideo: boolean;
  transcript: Transcript;
  asrProvider: string;
  /** Whether the transcript preserves fillers. Drives a UI warning if not. */
  verbatim: boolean;
  /** Waveform peaks, computed once on first request. */
  peaks?: number[];
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
    const raw = await readFile(join(projectsDir, `${id}.json`), 'utf8');
    const project = JSON.parse(raw) as Project;
    cache.set(id, project);
    return project;
  } catch {
    return null;
  }
}

export async function list(): Promise<Array<Pick<Project, 'id' | 'name' | 'duration' | 'createdAt'>>> {
  const files = await readdir(projectsDir).catch(() => [] as string[]);
  const projects = await Promise.all(
    files.filter((f) => f.endsWith('.json')).map((f) => get(f.replace('.json', ''))),
  );
  return projects
    .filter((p): p is Project => p !== null)
    .map(({ id, name, duration, createdAt }) => ({ id, name, duration, createdAt }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
