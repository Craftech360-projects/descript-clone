import { mkdir, readFile, writeFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { CONFIG } from './config.ts';

/**
 * Long work, made watchable and cancellable.
 *
 * /transcribe and /render used to be synchronous POSTs that held the connection
 * through a full ffmpeg pass and a remote ASR round trip. On the 885s sample
 * that is minutes of a frozen "Transcribing…" with no percentage, no cancel, and
 * no way to reload the tab without orphaning the work.
 *
 * Jobs are persisted, not just held in memory, for a specific reason: the dev
 * server runs under `node --watch`, so saving any server file restarts the
 * process. In-memory jobs would vanish and the client would poll a 404 forever.
 */

export type JobKind = 'transcribe' | 'render' | 'thumbs';
export type JobState = 'queued' | 'running' | 'done' | 'error' | 'canceled';

export interface Job {
  id: string;
  projectId: string;
  kind: JobKind;
  state: JobState;
  /**
   * 0..1, or -1 for HONESTLY INDETERMINATE.
   *
   * The ASR leg reports nothing at all — it is one blocking POST that returns a
   * finished transcript. Inventing a percentage would be the exact dishonesty
   * this codebase spends its comments refusing, so -1 means "we do not know" and
   * `stage` carries what we do know.
   */
  progress: number;
  stage: string;
  result?: unknown;
  error?: string;
  createdAt: string;
  endedAt?: string;
}

const jobsDir = join(CONFIG.mediaDir, 'jobs');
const jobs = new Map<string, Job>();

/** Child processes and abort flags, by job id. Never persisted. */
const children = new Map<string, ChildProcess>();
const canceled = new Set<string>();

export async function init(): Promise<void> {
  await mkdir(jobsDir, { recursive: true });
  await reconcile();
  void sweep();
  setInterval(() => void sweep(), 60 * 60 * 1000).unref();
}

/**
 * On boot, fail anything that claims to be running.
 *
 * It cannot be resumed: ffmpeg does not restart mid-encode, and on Windows a
 * non-detached child is re-parented rather than killed when we die — so its
 * output file is being written by a process we no longer own. Saying so is the
 * only honest option.
 */
async function reconcile(): Promise<void> {
  const files = await readdir(jobsDir).catch(() => [] as string[]);
  for (const file of files.filter((f) => f.endsWith('.json'))) {
    try {
      const job = JSON.parse(await readFile(join(jobsDir, file), 'utf8')) as Job;
      if (job.state === 'running' || job.state === 'queued') {
        job.state = 'error';
        job.error = 'The server restarted while this job was running.';
        job.endedAt = new Date().toISOString();
        await persist(job);
      }
      jobs.set(job.id, job);
    } catch {
      // A truncated job file is not worth crashing the boot over.
    }
  }
}

/** Drop finished jobs after a day. */
async function sweep(): Promise<void> {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [id, job] of jobs) {
    if (!job.endedAt || Date.parse(job.endedAt) > cutoff) continue;
    jobs.delete(id);
    await unlink(join(jobsDir, `${id}.json`)).catch(() => {});
  }
}

async function persist(job: Job): Promise<void> {
  jobs.set(job.id, job);
  await writeFile(join(jobsDir, `${job.id}.json`), JSON.stringify(job, null, 2)).catch(() => {});
}

export function get(id: string): Job | null {
  return jobs.get(id) ?? null;
}

export function list(projectId?: string): Job[] {
  return [...jobs.values()]
    .filter((j) => !projectId || j.projectId === projectId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export interface Progress {
  /** 0..1, or -1 when the truth is "we cannot know". */
  progress: number;
  stage: string;
}

export interface Runner {
  onProgress: (p: Progress) => void;
  /** Register the child so cancel can kill it. */
  track: (child: ChildProcess) => void;
  /** True once cancel has been requested — long loops should bail. */
  isCanceled: () => boolean;
}

/**
 * Start a job. Returns immediately; `work` runs detached.
 */
export function start(
  projectId: string,
  kind: JobKind,
  stage: string,
  work: (runner: Runner) => Promise<unknown>,
): Job {
  const job: Job = {
    id: randomUUID(),
    projectId,
    kind,
    state: 'running',
    progress: -1,
    stage,
    createdAt: new Date().toISOString(),
  };
  void persist(job);

  const runner: Runner = {
    onProgress: ({ progress, stage }) => {
      const live = jobs.get(job.id);
      if (!live || live.state !== 'running') return;
      live.progress = progress;
      live.stage = stage;
      // Deliberately not awaited and not written every tick — see below.
      throttledPersist(live);
    },
    track: (child) => children.set(job.id, child),
    isCanceled: () => canceled.has(job.id),
  };

  void (async () => {
    try {
      const result = await work(runner);
      const live = jobs.get(job.id)!;
      if (canceled.has(job.id)) {
        live.state = 'canceled';
        live.stage = 'Canceled';
      } else {
        live.state = 'done';
        live.progress = 1;
        live.stage = 'Done';
        live.result = result;
      }
      live.endedAt = new Date().toISOString();
      await persist(live);
    } catch (e) {
      const live = jobs.get(job.id)!;
      live.state = canceled.has(job.id) ? 'canceled' : 'error';
      live.error = e instanceof Error ? e.message : String(e);
      live.stage = live.state === 'canceled' ? 'Canceled' : 'Failed';
      live.endedAt = new Date().toISOString();
      await persist(live);
    } finally {
      children.delete(job.id);
      canceled.delete(job.id);
    }
  })();

  return job;
}

/**
 * Progress ticks arrive many times a second; the job file does not need to.
 * The in-memory record is always current — this only rate-limits the disk.
 */
const lastWrite = new Map<string, number>();
function throttledPersist(job: Job): void {
  const now = Date.now();
  if (now - (lastWrite.get(job.id) ?? 0) < 500) return;
  lastWrite.set(job.id, now);
  void persist(job);
}

export function cancel(id: string): boolean {
  const job = jobs.get(id);
  if (!job || job.state !== 'running') return false;

  canceled.add(id);
  const child = children.get(id);
  if (child) {
    // On Windows .kill() is TerminateProcess — there is no graceful SIGTERM, so
    // ffmpeg never finalises its output. Whatever it wrote is garbage, which is
    // why renders go to a .part file and are only renamed on success.
    child.kill();
    setTimeout(() => { if (!child.killed) child.kill('SIGKILL'); }, 5000).unref();
  }
  job.stage = 'Canceling…';
  void persist(job);
  return true;
}
