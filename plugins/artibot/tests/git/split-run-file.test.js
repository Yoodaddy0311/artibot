/**
 * `lib/git/split-run-file.js` — run.json read/write/update and the window map.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  readRunJson,
  runJsonPath,
  updateRunJson,
  windowForLimb,
  writeRunJson,
} from '../../lib/git/split-run-file.js';

const tmpDirs = [];
const mkTmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'split-run-'));
  tmpDirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('runJsonPath', () => {
  it('points at <parentRoot>/.artibot/split/run.json', () => {
    expect(runJsonPath('/r')).toBe(path.join('/r', '.artibot', 'split', 'run.json'));
  });
  it('rejects an empty root', () => {
    expect(() => runJsonPath('')).toThrow(TypeError);
  });
});

describe('readRunJson', () => {
  it('returns null when the file is missing (directory may not exist either)', () => {
    expect(readRunJson(mkTmp())).toBeNull();
  });

  it('parses an existing file, tolerating a BOM', () => {
    const root = mkTmp();
    fs.mkdirSync(path.dirname(runJsonPath(root)), { recursive: true });
    fs.writeFileSync(runJsonPath(root), '\uFEFF{"runId":"split-1"}');
    expect(readRunJson(root)).toEqual({ runId: 'split-1' });
  });

  it('throws on malformed JSON instead of pretending the ledger is empty', () => {
    const root = mkTmp();
    fs.mkdirSync(path.dirname(runJsonPath(root)), { recursive: true });
    fs.writeFileSync(runJsonPath(root), '{ not json');
    expect(() => readRunJson(root)).toThrow();
  });

  it('throws when the file is a JSON array or scalar', () => {
    const root = mkTmp();
    fs.mkdirSync(path.dirname(runJsonPath(root)), { recursive: true });
    fs.writeFileSync(runJsonPath(root), '[1,2]');
    expect(() => readRunJson(root)).toThrow(/not a JSON object/);
  });
});

describe('writeRunJson', () => {
  it('creates the directory, writes pretty JSON with a trailing newline, leaves no tmp file', () => {
    const root = mkTmp();
    const p = writeRunJson(root, { runId: 'split-2', limbs: ['a'] });
    expect(p).toBe(runJsonPath(root));
    const text = fs.readFileSync(p, 'utf-8');
    expect(text.endsWith('\n')).toBe(true);
    expect(JSON.parse(text)).toEqual({ runId: 'split-2', limbs: ['a'] });
    expect(fs.readdirSync(path.dirname(p)).filter((f) => f.includes('.tmp'))).toEqual([]);
  });

  it('round-trips through readRunJson', () => {
    const root = mkTmp();
    writeRunJson(root, { a: 1, nested: { b: [1, 2] } });
    expect(readRunJson(root)).toEqual({ a: 1, nested: { b: [1, 2] } });
  });

  it('replaces the previous content atomically (no partial merge)', () => {
    const root = mkTmp();
    writeRunJson(root, { a: 1, b: 2 });
    writeRunJson(root, { c: 3 });
    expect(readRunJson(root)).toEqual({ c: 3 });
  });

  it('rejects non-object payloads', () => {
    const root = mkTmp();
    expect(() => writeRunJson(root, null)).toThrow(TypeError);
    expect(() => writeRunJson(root, [1])).toThrow(TypeError);
  });
});

describe('updateRunJson', () => {
  it('starts from {} when the file is missing and stores fn\'s return value', () => {
    const root = mkTmp();
    const out = updateRunJson(root, (cur) => ({ ...cur, stage: 'planned' }));
    expect(out).toEqual({ stage: 'planned' });
    expect(readRunJson(root)).toEqual({ stage: 'planned' });
  });

  it('keeps the mutated input when fn returns undefined', () => {
    const root = mkTmp();
    writeRunJson(root, { stage: 'planned' });
    updateRunJson(root, (cur) => { cur.stage = 'opened'; });
    expect(readRunJson(root)).toEqual({ stage: 'opened' });
  });

  it('preserves unrelated keys across updates', () => {
    const root = mkTmp();
    writeRunJson(root, { runId: 'x', windows: { a: 'sess-a @ /p' } });
    updateRunJson(root, (cur) => ({ ...cur, suspend: { at: 't' } }));
    expect(readRunJson(root)).toEqual({ runId: 'x', windows: { a: 'sess-a @ /p' }, suspend: { at: 't' } });
  });

  it('rejects a non-function updater', () => {
    expect(() => updateRunJson(mkTmp(), null)).toThrow(TypeError);
  });
});

describe('windowForLimb', () => {
  it('reads the Ontology string form "<session> @ <path>" from windowReuse', () => {
    expect(windowForLimb({ windowReuse: { auth: 'split-x-auth-3f @ C:/wt' } }, 'auth')).toBe('split-x-auth-3f');
  });

  it('prefers windows[limb] over windowReuse[limb]', () => {
    const run = { windows: { auth: { session: 'new-1' } }, windowReuse: { auth: 'old-1 @ p' } };
    expect(windowForLimb(run, 'auth')).toBe('new-1');
  });

  it('accepts object entries with session / name / to', () => {
    expect(windowForLimb({ windows: { a: { name: 'n1' } } }, 'a')).toBe('n1');
    expect(windowForLimb({ windows: { a: { to: 'n2' } } }, 'a')).toBe('n2');
  });

  it('returns null for unknown limb, empty name, or missing tables', () => {
    expect(windowForLimb({ windowReuse: { a: 'x @ p' } }, 'b')).toBeNull();
    expect(windowForLimb({ windowReuse: { a: ' @ p' } }, 'a')).toBeNull();
    expect(windowForLimb({}, 'a')).toBeNull();
    expect(windowForLimb(null, 'a')).toBeNull();
    expect(windowForLimb({ windows: { a: 42 } }, 'a')).toBeNull();
  });
});
