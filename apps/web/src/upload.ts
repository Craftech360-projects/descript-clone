import type { Project } from './api.ts';

/**
 * Uploading a file in pieces, so an interruption costs a chunk rather than the
 * whole thing.
 *
 * The plain import sends the file as one request body, which dies with the page.
 * On a phone that happens constantly: a refresh, a tab switch that lets the
 * screen sleep, a network hiccup on the way to the Mini. This sends the file in
 * chunks at explicit offsets and remembers the session id, so picking the same
 * file again carries on instead of starting over.
 *
 * The honest limit, stated because it shapes the UI: a browser cannot re-open a
 * File after a reload without the user choosing it again — that is a security
 * boundary, not an oversight. So "resume" means *re-select the same file and it
 * continues from where it stopped*, never "it finishes by itself".
 */

/** Big enough that the per-request overhead is noise; small enough that losing one is cheap. */
const CHUNK = 8 * 1024 * 1024;

/** How a File is recognised across a reload. Not a hash — reading 4 GB to compute one costs more than the resume saves. */
const signatureOf = (f: File) => `jumpstart.upload.${f.name}:${f.size}:${f.lastModified}`;

interface Started {
  uploadId: string;
  offset: number;
}

async function json<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({ error: res.statusText }));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`);
  return body as T;
}

/** Reopen the session recorded for this file, if the server still has it. */
async function resume(file: File): Promise<Started | null> {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(signatureOf(file));
  } catch {
    // Private mode, or storage disabled. Not a reason to fail the upload — it
    // just means this one cannot be resumed.
    return null;
  }
  if (!saved) return null;
  try {
    const s = await json<{ uploadId: string; offset: number; size: number }>(
      await fetch(`/api/uploads/${saved}`),
    );
    // A session for a different file (id reused, or the name/size coincided) must
    // not be resumed into — that would splice two files together.
    if (s.size !== file.size) throw new Error('size mismatch');
    return { uploadId: s.uploadId, offset: s.offset };
  } catch {
    try {
      localStorage.removeItem(signatureOf(file));
    } catch {
      /* nothing to clean */
    }
    return null;
  }
}

/**
 * Send `file`, resuming if we have been here before.
 *
 * `onProgress` receives 0..1. It is called per chunk rather than per byte: a
 * progress bar that updates eight times a second is indistinguishable from one
 * that updates continuously, and this way there is no upload-side throttling to
 * get wrong.
 */
export async function uploadResumable(
  file: File,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
  /**
   * Continue THIS session rather than looking one up.
   *
   * Passed when the user picks a file to finish an upload the dashboard is
   * offering. Without it, resuming depends on localStorage still holding the
   * signature — and the phone that discarded the tab mid-upload is exactly the
   * one that may have dropped the storage too.
   */
  continueId?: string,
): Promise<Project> {
  let started: Started | null = null;
  if (continueId) {
    const s = await json<{ uploadId: string; offset: number; size: number }>(
      await fetch(`/api/uploads/${continueId}`),
    );
    // Guard the splice: a different file of a different length must never be
    // appended onto this one's bytes.
    if (s.size !== file.size) {
      throw new Error('That is a different file from the one this upload started with.');
    }
    started = { uploadId: s.uploadId, offset: s.offset };
  }
  started = started ?? (await resume(file));

  if (!started) {
    const created = await json<Started>(
      await fetch('/api/uploads', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: file.name, size: file.size }),
      }),
    );
    started = created;
    try {
      localStorage.setItem(signatureOf(file), created.uploadId);
    } catch {
      /* unresumable, but still uploadable */
    }
  }

  let offset = started.offset;
  onProgress?.(file.size ? offset / file.size : 0);

  while (offset < file.size) {
    if (signal?.aborted) throw new DOMException('Upload cancelled', 'AbortError');
    const end = Math.min(offset + CHUNK, file.size);
    const res = await fetch(`/api/uploads/${started.uploadId}?offset=${offset}`, {
      method: 'PATCH',
      body: file.slice(offset, end),
      signal,
    });

    if (res.status === 409) {
      // The server and we disagree about how much landed — it is right, because
      // it is the one holding the bytes. Re-seek rather than failing: this is the
      // ordinary path for a chunk that was retried, not an error.
      const { expected } = await res.json().catch(() => ({ expected: offset }));
      offset = typeof expected === 'number' ? expected : offset;
      continue;
    }

    const { offset: next } = await json<{ offset: number }>(res);
    offset = next;
    onProgress?.(file.size ? offset / file.size : 0);
  }

  const project = await json<Project>(
    await fetch(`/api/uploads/${started.uploadId}/finish`, { method: 'POST' }),
  );
  try {
    localStorage.removeItem(signatureOf(file));
  } catch {
    /* already gone */
  }
  return project;
}

/** Whether re-picking this file would continue an upload rather than restart it. */
export function hasResumable(file: File): boolean {
  try {
    return Boolean(localStorage.getItem(signatureOf(file)));
  } catch {
    return false;
  }
}
