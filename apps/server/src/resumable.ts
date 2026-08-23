/**
 * Uploads that survive being interrupted.
 *
 * The plain import (POST /api/projects) sends the whole file as one request
 * body. That is efficient and it is fine on a desk, but it is all-or-nothing:
 * a refresh, a tab switch that lets the phone sleep, or a Tailscale blip aborts
 * the fetch and the bytes already on the wire are lost. On a phone, uploading a
 * month of holiday footage, that is the difference between a tool that works and
 * one that cannot be used at all.
 *
 * So: the client opens a session, sends the file in chunks at explicit offsets,
 * and asks where it got to if it is interrupted. The server only ever appends,
 * and only ever at the offset it already holds — so a duplicated or out-of-order
 * chunk is refused rather than corrupting the file silently.
 *
 * Sessions live in dataDir, NOT in mediaDir: a half-uploaded file is not media
 * yet and mediaDir is served over HTTP. See the note on folders.ts.
 *
 * What this deliberately does NOT solve: a browser cannot re-read a File after a
 * reload without the user choosing it again. Resuming therefore means "pick the
 * same file and it carries on from where it stopped", not "it continues by
 * itself". That is a browser security boundary, not something to engineer around.
 */

import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, stat, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

import { CONFIG } from './config.ts';

export interface UploadSession {
  id: string;
  /** The display name the finished project takes. */
  name: string;
  /** Resolved from the name; the assembled file keeps it. */
  ext: string;
  /** What the client says the whole file weighs, so we can refuse it early. */
  size: number;
  /** Bytes safely on disk. The only number that decides where a resume starts. */
  offset: number;
  createdAt: string;
  updatedAt: string;
}

/** Sessions older than this are swept — an abandoned upload must not keep disk forever. */
const STALE_MS = 24 * 60 * 60 * 1000;

const dir = () => join(CONFIG.dataDir, 'uploads');
const metaPath = (id: string) => join(dir(), `${id}.json`);
/** The bytes themselves, growing as chunks land. */
export const partPath = (id: string) => join(dir(), `${id}.part`);

async function writeMeta(s: UploadSession): Promise<void> {
  await mkdir(dir(), { recursive: true });
  // 0600 for the same reason folder memories are: this names a user's file.
  await writeFile(metaPath(s.id), JSON.stringify(s), { mode: 0o600 });
}

export async function get(id: string): Promise<UploadSession | null> {
  try {
    return JSON.parse(await readFile(metaPath(id), 'utf8')) as UploadSession;
  } catch {
    return null;
  }
}

export async function create(opts: { id: string; name: string; ext: string; size: number }): Promise<UploadSession> {
  const now = new Date().toISOString();
  const session: UploadSession = { ...opts, offset: 0, createdAt: now, updatedAt: now };
  await mkdir(dir(), { recursive: true });
  // Truthfully empty: a stale .part from a reused id would otherwise be treated
  // as the head of this upload and produce a corrupt file with no error.
  await writeFile(partPath(session.id), '');
  await writeMeta(session);
  return session;
}

/**
 * Append one chunk, but only if it starts exactly where the file currently ends.
 *
 * The offset check is the whole integrity story. A client that retries a chunk
 * it already sent, or whose two requests race, would otherwise append the same
 * bytes twice — and the result is a file that is the right size in the metadata,
 * the wrong size on disk, and broken in a way that only shows up as a corrupt
 * video much later. Refusing with the real offset lets the client re-seek.
 */
export async function append(
  session: UploadSession,
  offset: number,
  body: ReadableStream | null,
): Promise<{ ok: true; session: UploadSession } | { ok: false; expected: number }> {
  // Trust the file, not the record: if a write was interrupted mid-flight the
  // metadata may claim more than actually landed.
  const onDisk = await stat(partPath(session.id)).then((s) => s.size).catch(() => 0);
  if (offset !== onDisk) return { ok: false, expected: onDisk };
  if (!body) return { ok: false, expected: onDisk };

  await pipeline(
    Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]),
    // 'a' — append. Never 'w', which would silently restart the file at zero.
    createWriteStream(partPath(session.id), { flags: 'a' }),
  );

  const now = await stat(partPath(session.id));
  const updated: UploadSession = { ...session, offset: now.size, updatedAt: new Date().toISOString() };
  await writeMeta(updated);
  return { ok: true, session: updated };
}

/** Drop a session and its bytes — on completion, on cancel, or when stale. */
export async function discard(id: string): Promise<void> {
  await rm(metaPath(id), { force: true }).catch(() => {});
  await rm(partPath(id), { force: true }).catch(() => {});
}

/**
 * Sweep abandoned uploads.
 *
 * Called at boot rather than on a timer: a server that has just started is the
 * one moment we know no upload is in flight, so nothing in progress can be
 * mistaken for abandoned.
 */
export async function sweep(): Promise<number> {
  let removed = 0;
  let names: string[];
  try {
    names = await readdir(dir());
  } catch {
    return 0;
  }
  const cutoff = Date.now() - STALE_MS;
  for (const f of names) {
    if (!f.endsWith('.json')) continue;
    const id = f.slice(0, -'.json'.length);
    const s = await get(id);
    if (!s || Date.parse(s.updatedAt) < cutoff) {
      await discard(id);
      removed++;
    }
  }
  return removed;
}

/**
 * Every upload that started and did not finish.
 *
 * The reason this exists: resuming worked, but only if you happened to re-pick
 * the exact same file. A phone that discards a backgrounded tab mid-upload takes
 * the progress bar, the error and the page with it — so from the user's side a
 * 1.5 GB upload silently "vanished", while 271 MB of it sat on the server that
 * nothing would ever mention again. An interrupted upload has to be able to say
 * so.
 */
export async function list(): Promise<UploadSession[]> {
  let names: string[];
  try {
    names = await readdir(dir());
  } catch {
    return [];
  }
  const out: UploadSession[] = [];
  for (const f of names) {
    if (!f.endsWith('.json')) continue;
    const s = await get(f.slice(0, -'.json'.length));
    // Trust the file over the record, exactly as append() does.
    if (!s) continue;
    const on = await stat(partPath(s.id)).then((x) => x.size).catch(() => 0);
    // Nothing landed yet: a session opened and abandoned before the first chunk
    // is noise, not unfinished work worth offering to resume.
    if (on <= 0) continue;
    out.push({ ...s, offset: on });
  }
  // Most recent first: the one you just lost is the one you want back.
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
