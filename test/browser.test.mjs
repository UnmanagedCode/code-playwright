// Unit tests for the pure chromium-discovery logic in browser.mjs. These
// don't touch process.env/PATH — resolveChromiumBin takes every input
// explicitly, so we can verify probe order and the "tried" error text
// without needing a real Chromium install (or a Debian host).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveChromiumBin } from '../browser.mjs';

test('invalid PLAYWRIGHT_CHROMIUM_BIN override fails loud, does not fall through', () => {
  const result = resolveChromiumBin({ envOverride: '/does/not/exist' });
  assert.equal(result.path, null);
  assert.equal(result.overrideInvalid, true);
  assert.deepEqual(result.tried, ['/does/not/exist (PLAYWRIGHT_CHROMIUM_BIN)']);
});

test('valid PLAYWRIGHT_CHROMIUM_BIN override short-circuits PATH scan', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tpw-test-'));
  const bin = path.join(dir, 'my-chrome');
  writeFileSync(bin, '');
  try {
    const result = resolveChromiumBin({ envOverride: bin, pathEnv: '/nonexistent' });
    assert.equal(result.path, bin);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('nothing found lists every candidate name and no absolute fallbacks', () => {
  const result = resolveChromiumBin({
    pathEnv: '/nonexistent:/also-nonexistent',
    absoluteFallbacks: [],
  });
  assert.equal(result.path, null);
  assert.deepEqual(result.tried, [
    'chromium (on PATH)',
    'chromium-browser (on PATH)',
    'google-chrome-stable (on PATH)',
    'google-chrome (on PATH)',
  ]);
});

test('finds a candidate on a fake PATH dir', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tpw-test-'));
  const bin = path.join(dir, 'chromium');
  writeFileSync(bin, '');
  try {
    const result = resolveChromiumBin({
      pathEnv: `/nonexistent:${dir}`,
      names: ['chromium'],
      absoluteFallbacks: [],
    });
    assert.equal(result.path, bin);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('falls back to absolute path when nothing is on PATH', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tpw-test-'));
  const fakeAbs = path.join(dir, 'chromium-browser');
  writeFileSync(fakeAbs, '');
  try {
    const result = resolveChromiumBin({
      pathEnv: '/nonexistent',
      absoluteFallbacks: [fakeAbs],
    });
    assert.equal(result.path, fakeAbs);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('prefers the first absolute fallback over later ones (Playwright-managed download before Termux path)', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tpw-test-'));
  const first = path.join(dir, 'first-fallback');
  const second = path.join(dir, 'second-fallback');
  writeFileSync(first, '');
  writeFileSync(second, '');
  try {
    const result = resolveChromiumBin({
      pathEnv: '/nonexistent',
      absoluteFallbacks: [first, second],
    });
    assert.equal(result.path, first);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
