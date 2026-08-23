import { test } from 'node:test';
import assert from 'node:assert/strict';

import { proxyPathFor, proxyUrlFor } from './proxy.ts';

/**
 * Where a proxy lives, and what the browser is told to play.
 *
 * These two have to agree exactly. The disk path is what ffmpeg writes and what
 * the freshness check stats; the URL is what the <video> loads. If they drift,
 * the symptom is not an error — it is a player that silently falls back to the
 * 1.3 GB original and a user who wonders why scrubbing is slow again.
 */

test('the proxy sits beside its source, always as .mp4', () => {
  assert.equal(proxyPathFor('/m/uploads/abc.mp4'), '/m/uploads/abc-proxy.mp4');
  // The source can be any container; the proxy is always H.264 in MP4, so the
  // extension is replaced rather than appended.
  assert.equal(proxyPathFor('/m/uploads/abc.MOV'), '/m/uploads/abc-proxy.mp4');
  assert.equal(proxyPathFor('/m/uploads/abc.mkv'), '/m/uploads/abc-proxy.mp4');
});

test('a source with no extension still gets a well-formed proxy name', () => {
  assert.equal(proxyPathFor('/m/uploads/abc'), '/m/uploads/abc-proxy.mp4');
});

test('the URL mirrors the path, so player and disk cannot disagree', () => {
  assert.equal(proxyUrlFor('/media/uploads/abc.mp4'), '/media/uploads/abc-proxy.mp4');
  assert.equal(proxyUrlFor('/media/uploads/abc.MOV'), '/media/uploads/abc-proxy.mp4');
});

test('a dot in a DIRECTORY name is not mistaken for the extension', () => {
  // lastIndexOf('.') on the whole URL would cut at ".v2" and produce a path that
  // no file is ever written to — a silent, permanent fallback to the original.
  assert.equal(proxyUrlFor('/media/my.v2/abc.mp4'), '/media/my.v2/abc-proxy.mp4');
  assert.equal(proxyPathFor('/media/my.v2/abc.mp4'), '/media/my.v2/abc-proxy.mp4');
});

test('an extensionless file under a dotted directory still resolves', () => {
  // The case that broke the naive lastIndexOf: the only dot is in the DIRECTORY,
  // so cutting there yields /media/my-proxy.mp4 — a file nothing ever writes,
  // and a player that falls back to the 1.3 GB original for good.
  assert.equal(proxyUrlFor('/media/my.v2/abc'), '/media/my.v2/abc-proxy.mp4');
  assert.equal(proxyPathFor('/media/my.v2/abc'), '/media/my.v2/abc-proxy.mp4');
});

test('path and URL stay in step for the same file', () => {
  // The invariant that matters: given one media id, both helpers must name the
  // same file. Anything else is the drift described in the header.
  for (const name of ['a.mp4', 'b.MOV', 'c.webm', 'd']) {
    const disk = proxyPathFor(`/srv/media/uploads/${name}`);
    const url = proxyUrlFor(`/media/uploads/${name}`);
    assert.equal(disk.split('/').pop(), url.split('/').pop(), `${name} must map to one filename`);
  }
});
