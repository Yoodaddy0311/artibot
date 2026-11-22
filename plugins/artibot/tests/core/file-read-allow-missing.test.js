/**
 * lib/core/file.js#readTextAllowMissing — the ENOENT-only read rule shared by
 * the locked re-reads in lib/learning/kill-switch.js#readStateFile and
 * lib/learning/tool-history.js#readDiskHistory.
 *
 * The rule is an allowlist: ENOENT, and only ENOENT, means "no file". Every
 * other read error is thrown, so a caller that is about to write can never take
 * a transient failure (EBUSY while another process renames over the file on
 * Windows, EACCES, EMFILE, …) for an absent file and put defaults over the real
 * state. The injected-errno cases for the two callers live in
 * tests/learning/kill-switch-read-error.test.js and
 * tests/learning/tool-history-read-error.test.js; here the errors are real.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readTextAllowMissing } from '../../lib/core/file.js';

let dir;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'artibot-read-allow-missing-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('readTextAllowMissing()', () => {
  it('returns the UTF-8 text of an existing file', () => {
    const file = path.join(dir, 'state.json');
    writeFileSync(file, '{"a":"한글"}', 'utf-8');
    expect(readTextAllowMissing(file)).toBe('{"a":"한글"}');
  });

  it('returns an empty string for an empty file (empty is not missing)', () => {
    const file = path.join(dir, 'empty.json');
    writeFileSync(file, '');
    expect(readTextAllowMissing(file)).toBe('');
  });

  it('returns null when the file does not exist (ENOENT)', () => {
    expect(readTextAllowMissing(path.join(dir, 'absent.json'))).toBeNull();
  });

  it('returns null when a parent directory does not exist either', () => {
    expect(readTextAllowMissing(path.join(dir, 'no', 'such', 'dir', 'x.json'))).toBeNull();
  });

  it('throws any other read error with its code intact (a directory: EISDIR)', () => {
    const sub = path.join(dir, 'a-directory');
    mkdirSync(sub);
    let caught = null;
    try { readTextAllowMissing(sub); } catch (err) { caught = err; }
    expect(caught).not.toBeNull();
    expect(caught.code).toBe('EISDIR');
  });
});
