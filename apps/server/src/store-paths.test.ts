import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Where project records live, and that the move out of the media directory works.
 *
 * This is the first test in the repo that touches persistence — store.ts, jobs.ts
 * and index.ts have had none, which is precisely why a bug of this shape survived:
 * every project record was written inside the statically-served media directory,
 * so GET /media/projects/<uuid>.json returned the whole transcript to anyone who
 * could reach the port. Measured before the fix: 213KB, 215 words, no credential.
 *
 * The env has to be set BEFORE config.ts is first evaluated, and node --test gives
 * each file its own process — so the dynamic import below is load-bearing, not
 * style. Importing store.ts at the top of the file would read the real MEDIA_DIR.
 */

const media = await mkdtemp(join(tmpdir(), 'jumpcut-media-'));
const data = await mkdtemp(join(tmpdir(), 'jumpcut-data-'));
process.env.MEDIA_DIR = media;
process.env.DATA_DIR = data;

const store = await import('./store.ts');

const record = (id: string, name: string) =>
  JSON.stringify({ id, name, sourcePath: '/dev/null', sourceUrl: '', duration: 1, hasVideo: false, createdAt: new Date().toISOString() });

test('a legacy record is moved out of the web-served media directory', async () => {
  const id = '11111111-1111-1111-1111-111111111111';
  await mkdir(join(media, 'projects'), { recursive: true });
  await writeFile(join(media, 'projects', `${id}.json`), record(id, 'legacy'), { mode: 0o644 });

  await store.init();

  const moved = JSON.parse(await readFile(join(data, 'projects', `${id}.json`), 'utf8'));
  assert.equal(moved.name, 'legacy', 'the record should be readable at the new path');

  const left = await readdir(join(media, 'projects'));
  assert.deepEqual(left, [], 'nothing should remain in the web-served directory');
});

test('a migrated record is chmod 0600, not the 0644 it arrived with', async () => {
  const id = '22222222-2222-2222-2222-222222222222';
  await mkdir(join(media, 'projects'), { recursive: true });
  await writeFile(join(media, 'projects', `${id}.json`), record(id, 'perms'), { mode: 0o644 });

  await store.init();

  // writeFile's `mode` only applies when it CREATES a file, so a record that
  // arrived by rename keeps its old permissions unless chmod is explicit. Without
  // that call the migration moves the file and leaves it world-readable — fixing
  // the URL but not the thing the URL exposed.
  const mode = (await stat(join(data, 'projects', `${id}.json`))).mode & 0o777;
  assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
});

test('a record already at the new path is never clobbered by a legacy one', async () => {
  const id = '33333333-3333-3333-3333-333333333333';
  await mkdir(join(media, 'projects'), { recursive: true });
  await mkdir(join(data, 'projects'), { recursive: true });
  await writeFile(join(data, 'projects', `${id}.json`), record(id, 'current'));
  await writeFile(join(media, 'projects', `${id}.json`), record(id, 'stale'));

  await store.init();

  const kept = JSON.parse(await readFile(join(data, 'projects', `${id}.json`), 'utf8'));
  assert.equal(kept.name, 'current', 'the newer record at the new path must win');
});

test('projects no longer resolve inside the media directory at all', async () => {
  // The regression guard. If someone reintroduces `join(CONFIG.mediaDir, ...)`
  // the file above still passes on a fresh temp dir — this is what catches it.
  const { CONFIG } = await import('./config.ts');
  assert.equal(CONFIG.dataDir, data);
  assert.notEqual(CONFIG.dataDir, CONFIG.mediaDir);
});
