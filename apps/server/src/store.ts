import { mkdir, readFile, writeFile, readdir, unlink } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { CONFIG } from './config.ts';
import { probe } from './ffmpeg.ts';
import * as poster from './poster.ts';
import * as thumbs from './thumbs.ts';
import type { AsrOptions } from './asr.ts';
import type { Thumbs } from './thumbs.ts';
import type { CaptionSettings } from '../../../packages/core/src/caption-style.ts';
import type { CutSettings } from '../../../packages/core/src/doc.ts';
import type { ColorSettings } from '../../../packages/core/src/color.ts';
import type { FrameSettings } from '../../../packages/core/src/frame.ts';
import type { Transcript } from '../../../packages/core/src/types.ts';

/**
 * One source file in a project's sequence, server side.
 *
 * The counterpart of the client's Clip, plus `sourcePath` — the on-disk file the
 * render, probe, and transcribe passes read. A project is moving from one media
 * file to an ordered list of these; a single-source project is exactly one clip,
 * derived on demand by `clipsOf` from the flat fields below. `offset` is derived
 * from ordering, never stored, so a reorder is a list move.
 */
export interface StoredClip {
  id: string;
  sourcePath: string;
  sourceUrl: string;
  duration: number;
  hasVideo: boolean;
  width?: number;
  height?: number;
  fps?: number;
  peaks: number[];
  thumbs?: Thumbs;
  /**
   * Where in its source file this clip begins, in seconds. Absent (≡ 0) for a
   * whole-file clip — every clip until one is split. Splitting a clip makes two
   * clips that share one file: the first keeps sourceStart 0 and a shortened
   * `duration`, the second gets sourceStart at the cut. `duration` is always the
   * clip's own length (out − in), so the file window is [sourceStart, +duration].
   * The render adds this to each kept range to address the real file frames.
   */
  sourceStart?: number;
}

export interface Clip extends StoredClip {
  /** Seconds this clip begins at on the project timeline: Σ of prior durations. */
  offset: number;
}

/**
 * A background-music bed attached to a project.
 *
 * Per-project, not global like fonts: a bed is a creative choice about THIS
 * piece. The file lives in uploads/ alongside the sources; the render mixes it
 * UNDER the finished program (post-cut, post-speed) so it is never chopped by the
 * word edits — see BgMusicRender in render.ts.
 */
export interface BgMusic {
  id: string;
  /** Original filename, for display in the panel. */
  name: string;
  /** Absolute path to the imported audio on disk. Server-only. */
  sourcePath: string;
  /** Browser-reachable URL, for the preview <audio> element. */
  sourceUrl: string;
  /** The music file's own length in seconds, probed on import. Bounds the trim. */
  sourceDuration: number;
  /** Linear gain, 0..N. 1 is unity; the panel defaults it lower so it sits under. */
  volume: number;
  /**
   * How long the bed plays, in OUTPUT seconds. Absent means "as long as the
   * program runs" — the mix caps it at the program length regardless.
   */
  durationSec?: number;
  /**
   * Loop the track to fill its length. Off: a bed shorter than `durationSec`
   * stops early (and the length is capped at the file's own duration). On: the
   * track repeats to cover the whole requested length — how a short song fills a
   * long video. See BgMusicRender.loop.
   */
  loop?: boolean;

  /**
   * Where the bed came from, when it was found on the web rather than imported.
   *
   * All three are absent for a file the user supplied — they own that, and owe
   * nobody a credit. For a searched track they are not decoration: the catalogue
   * behind the picker is overwhelmingly CC BY / BY-SA (a sample of Openverse's
   * music category turned up zero CC0), so publishing a video with one of these
   * beds REQUIRES the credit line. Storing it with the project is what makes it
   * still available at export time, long after the picker was closed.
   */
  attribution?: string;
  /** Short licence code — 'by', 'by-sa'. Drives the badge beside the bed. */
  license?: string;
  /** The track's page on the provider, so the credit can link back. */
  sourceLink?: string;
}

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

  /**
   * The source clips, in play order. Absent on single-source projects (every
   * project today): read them through `clipsOf`, which derives one clip from the
   * flat fields when this is unset. Populated only once a project holds more than
   * one source.
   */
  clips?: StoredClip[];

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
  /**
   * Studio sound voice enhancer
   */
  studioSound?: boolean;
  /**
   * The cover frame shown on the dashboard card, as a /media URL. Absent on
   * audio, and on video whose cover has not been built yet — `list` builds any
   * that are missing, since the dashboard is the only thing that reads it. See
   * poster.ts.
   */
  posterUrl?: string;
  /**
   * The output frame — target resolution plus the zoom/pan that decides which part
   * of the source fills it. Absent on projects saved before reframing existed, and
   * on every project that has never left the source's own resolution; the client
   * falls back to DEFAULT_FRAME via normalizeFrame.
   */
  frame?: FrameSettings;
  /**
   * The colour grade — which look, and where its six knobs sit. Absent on
   * projects saved before grading existed and on every project still ungraded;
   * the client falls back to DEFAULT_COLOR via normalizeColor.
   */
  color?: ColorSettings;
  /**
   * The background-music bed, if one has been imported. Absent on projects with
   * no music (all of them, until asked for). Mixed under the render — see BgMusic.
   */
  music?: BgMusic;
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
 * Delete a project and everything on disk that exists only for it.
 *
 * The record, its uploads, its cover, and its filmstrip sheets. Renders are left
 * alone: an exported file is a thing you made and may have been keeping here, not
 * an artefact of the project — deleting the project should not reach into it.
 *
 * Every unlink is best-effort. A source that was already moved or deleted by hand
 * must not stop the project record from going away, or the library would be stuck
 * showing a row that cannot be removed. Returns false only when there was no such
 * project to begin with.
 *
 * Unlike removeClip — which leaves media on disk because the project it belonged
 * to is still there to reference it — nothing survives this to point at the files.
 */
export async function remove(id: string): Promise<boolean> {
  const project = await get(id);
  if (!project) return false;

  // Two clips split from one file share a sourcePath, so unlink the set, not the
  // list. Music rides along; renders deliberately do not.
  const files = new Set<string>(clipsOf(project).map((c) => c.sourcePath));
  files.add(project.sourcePath);
  if (project.music) files.add(project.music.sourcePath);
  for (const file of files) await unlinkInMedia(file);

  await unlinkInMedia(join(poster.posterDir(), `${id}.jpg`));

  // The sheets are `<id>-000.jpg`, `<id>-001.jpg`… — named, not listed anywhere,
  // so the directory is the index. Same prefix scan the builder uses to clear a
  // stale set before a rebuild.
  const dir = thumbs.thumbsDir();
  const sheets = await readdir(dir).catch(() => [] as string[]);
  for (const name of sheets) {
    if (name.startsWith(`${id}-`) && name.endsWith('.jpg')) await unlinkInMedia(join(dir, name));
  }

  cache.delete(id);
  await unlink(join(projectsDir, `${id}.json`)).catch(() => {});
  return true;
}

/**
 * Unlink, but only inside the media directory.
 *
 * Paths here come from our own JSON, so this should never fire — which is the
 * point. This is the one operation in the server that destroys user files, and a
 * project file that has been hand-edited (or written by a build with a different
 * mediaDir) should not be able to aim it somewhere else.
 */
async function unlinkInMedia(path: string): Promise<void> {
  const rel = relative(CONFIG.mediaDir, resolve(path));
  if (rel.startsWith('..') || isAbsolute(rel)) return;
  await unlink(path).catch(() => {});
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
  const live = projects.filter((p): p is Project => p !== null);

  // Build any missing dashboard covers here rather than in `migrate`, because a
  // project saved this session is already in the cache and `get` returns before
  // migrate ever runs. This is also the only endpoint that needs them, so one
  // pass over the listing covers every case exactly once — after the first call
  // the files exist and `ensure` is a stat.
  await Promise.all(live.map(ensurePoster));

  return live
    .map(({ peaks, transcript, ...rest }) => rest)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Give a project its cover frame if it has none, and remember it. */
async function ensurePoster(project: Project): Promise<void> {
  if (project.posterUrl) return;
  const url = await poster
    .ensure(project.sourcePath, project.id, project.duration, project.hasVideo)
    .catch(() => null);
  // Nothing on failure: a project with no cover shows its mark instead, and the
  // next listing tries again. Persisting a null would make that permanent.
  if (!url) return;
  project.posterUrl = url;
  await save(project);
}

/**
 * The project's clips, in order, each with its computed timeline offset.
 *
 * The server seam mirroring the client's `clipsOf`: everything reading
 * project.sourcePath / .duration / .peaks / .thumbs as "the media" — render,
 * thumbs, transcribe — should move behind this so single-source and multi-clip
 * are one path. A project with no `clips` array reads as one clip derived from
 * the flat fields, offset 0, so it is total and old projects need no migration.
 */
export function clipsOf(project: Project): Clip[] {
  const raw: StoredClip[] = project.clips ?? [singleClipFrom(project)];
  let offset = 0;
  return raw.map((c) => {
    const withOffset: Clip = { ...c, offset };
    offset += c.duration;
    return withOffset;
  });
}

/**
 * Ensure `project.clips` exists, materialising the implicit single clip if not.
 *
 * The moment a project gains a second source it stops being describable by the
 * flat fields alone, so the first clip is written out explicitly. Existing
 * transcript words carry no clipId (they predate clips); they are stamped with
 * the first clip's id here, so from this point every word names its clip and the
 * incremental transcribe path can tell which clips still need words. Returns the
 * now-guaranteed clips array (the same reference stored on the project).
 */
export function ensureClips(project: Project): StoredClip[] {
  if (!project.clips) {
    const first = singleClipFrom(project);
    project.clips = [first];
    if (project.transcript) {
      for (const w of project.transcript.words) if (w.clipId === undefined) w.clipId = first.id;
    }
  }
  return project.clips;
}

/**
 * Re-derive the project-level aggregates from its clips, after an append/remove.
 *
 * The flat fields stay meaningful for code paths that read the "primary" clip
 * (clip 0): sourcePath/sourceUrl/width/height/fps follow it. `duration` and
 * `peaks`, though, describe the WHOLE timeline — that is what the client's edl
 * and ruler span — so they are the concatenation across clips. hasVideo is true
 * if any clip has a picture. The transcript's duration tracks the total too.
 */
export function recomputeAggregates(project: Project): void {
  const clips = ensureClips(project);
  const first = clips[0];
  project.sourcePath = first.sourcePath;
  project.sourceUrl = first.sourceUrl;
  project.width = first.width;
  project.height = first.height;
  project.fps = first.fps;
  project.hasVideo = clips.some((c) => c.hasVideo);
  project.duration = clips.reduce((sum, c) => sum + c.duration, 0);
  project.peaks = clips.flatMap((c) => c.peaks);
  if (project.transcript) project.transcript.duration = project.duration;
}

/** The flat single-source fields, read as the one clip an old project holds. */
function singleClipFrom(p: Project): StoredClip {
  return {
    id: p.id,
    sourcePath: p.sourcePath,
    sourceUrl: p.sourceUrl,
    duration: p.duration,
    hasVideo: p.hasVideo,
    width: p.width,
    height: p.height,
    fps: p.fps,
    peaks: p.peaks,
    thumbs: p.thumbs,
  };
}
