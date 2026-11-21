/**
 * scripts/utils/index.js#toFileUrl — the URL every hook hands to dynamic import()
 * (2026-11-21 review L2).
 *
 * The helper deliberately does not percent-encode: `pathToFileURL()` turns the owner's
 * `바탕 화면` into `%EB%B0%94…`, and the import that broke on that is why this helper exists.
 * But a URL parser still gives three ASCII characters a meaning, whatever the helper intends:
 *   `#` starts a fragment  -> everything after it is dropped from the path
 *   `?` starts a query     -> same
 *   `%` starts an escape   -> `%41` is read back as `A`, `%zz` is invalid
 * So exactly those three are encoded (`%` first, or the other two escapes would be
 * double-encoded) and everything else — Hangul, spaces — is left as written.
 *
 * THE IMPORT RUNS IN A CHILD `node`, not in this test process: vitest rewrites `import()`
 * in test code through its own resolver, which is not the loader a hook runs under. The
 * child is spawned with an argv array (no shell), so no MSYS path mangling applies.
 *
 * WHAT THIS FILE CANNOT SEE
 *  1. `?` in a real directory name: Windows forbids it in file names, so `?` is pinned on
 *     the string only. POSIX accepts it; a CI run on Linux does not exercise it either.
 *  2. UNC paths (`\\server\share`) — the helper has never handled them and still does not.
 *  3. The inline copies in commands/*.md (autopilot, autopilot-queue, go, install, plan,
 *     split — census 2026-11-21) are prose a model pastes into `node -e`; nothing here runs
 *     them. They still lack the `%`/`#`/`?` encoding.
 *
 * The former second copy, scripts/gen-model-catalog-docs.js#toFileUrl ("Mirrors" this one,
 * with no stated reason to be a copy), now re-exports this helper; the identity test below
 * keeps it from drifting back into a copy.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { toFileUrl } from '../../scripts/utils/index.js';

const UTILS = fileURLToPath(new URL('../../scripts/utils/index.js', import.meta.url));

/**
 * Import `modulePath` through toFileUrl in a fresh node and return what it printed.
 * @param {string} modulePath
 * @returns {{ status: number|null, stdout: string, stderr: string }}
 */
function importInChild(modulePath) {
  const code = [
    'const { toFileUrl } = await import(process.argv[1]);',
    'const m = await import(toFileUrl(process.argv[2]));',
    'process.stdout.write(String(m.marker));',
  ].join('\n');
  const r = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', code, pathToFileURL(UTILS).href, modulePath],
    { encoding: 'utf-8', timeout: 30_000 },
  );
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

let root;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'artibot-tofileurl-'));
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('toFileUrl: string form', () => {
  it('keeps Hangul and spaces literal on a Windows drive path', () => {
    const url = toFileUrl('C:\\Users\\nowhe\\바탕 화면\\AI\\x.js');
    expect(url).toBe('file:///C:/Users/nowhe/바탕 화면/AI/x.js');
  });

  it('keeps a POSIX path literal', () => {
    expect(toFileUrl('/home/u/바탕 화면/x.js')).toBe('file:///home/u/바탕 화면/x.js');
  });

  it('encodes % first, then # and ?, so no escape is double-encoded', () => {
    expect(toFileUrl('C:\\a%41\\b#c\\d?e.js')).toBe('file:///C:/a%2541/b%23c/d%3Fe.js');
    expect(toFileUrl('/a%23/x.js')).toBe('file:///a%2523/x.js');
  });

  it('round-trips through fileURLToPath for every encoded character (POSIX form)', () => {
    const p = '/tmp/바탕 화면/a%41/b#c/d?e.js';
    expect(fileURLToPath(toFileUrl(p), { windows: false })).toBe(p);
  });
});

describe('toFileUrl: a real import() in a child node', () => {
  it('imports a module under a Hangul + space directory', () => {
    const dir = path.join(root, '바탕 화면');
    mkdirSync(dir, { recursive: true });
    const mod = path.join(dir, 'plain.mjs');
    writeFileSync(mod, 'export const marker = "plain-ok";\n');
    const r = importInChild(mod);
    expect(r.stderr).toBe('');
    expect(r.stdout).toBe('plain-ok');
  });

  it('imports a module under a directory whose name holds # and %', () => {
    const dir = path.join(root, '바탕 화면 #1 %41');
    mkdirSync(dir, { recursive: true });
    const mod = path.join(dir, 'hash.mjs');
    writeFileSync(mod, 'export const marker = "hash-ok";\n');
    const r = importInChild(mod);
    expect(r.stderr).toBe('');
    expect(r.stdout).toBe('hash-ok');
  });
});

describe('scripts/gen-model-catalog-docs.js#toFileUrl is this helper, not a copy', () => {
  it('re-exports the same function (one implementation to fix)', async () => {
    const gen = await import('../../scripts/gen-model-catalog-docs.js');
    expect(gen.toFileUrl).toBe(toFileUrl);
  });

  it('therefore encodes # and % too', async () => {
    const gen = await import('../../scripts/gen-model-catalog-docs.js');
    expect(gen.toFileUrl('C:\\a%41\\b#c\\x.js')).toBe('file:///C:/a%2541/b%23c/x.js');
  });
});
