/**
 * Unit tests for `tests/helpers/patient-rename.js`.
 *
 * The wrapper cases inject the rename, the sleep and the log, so the retry rule
 * is exercised exactly and without wall time. The last block runs core's real
 * `atomicWriteTextSync` in a tmp dir against a destination that refuses seven
 * times: it throws without the helper (the negative control, which is the
 * failure seen on 2026-10-01) and lands with it (the positive control), and
 * that pair is also what shows core really calls the spied `fs.renameSync`.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { atomicWriteTextSync, TRANSIENT_RENAME_CODES } from '../../lib/core/file.js';
import {
  installPatientRename,
  PATIENT_ATTEMPTS,
  PATIENT_MAX_BACKOFF_MS,
  patientRename,
  usePatientRename,
} from './patient-rename.js';

/** An fs-shaped error carrying `code`. */
function fsError(code) {
  return Object.assign(new Error(`${code}: injected`), { code });
}

/** A rename that throws `code` on its first `failures` calls and then returns 'ok'. */
function flaky(failures, code = 'EPERM') {
  let calls = 0;
  return vi.fn(() => {
    calls += 1;
    if (calls <= failures) throw fsError(code);
    return 'ok';
  });
}

/** Like {@link flaky}, but the call that works performs the real rename. Build it BEFORE spying on `fs.renameSync`. */
function flakyThenReal(failures, code = 'EPERM') {
  const real = fs.renameSync.bind(fs);
  let calls = 0;
  return vi.fn((from, to) => {
    calls += 1;
    if (calls <= failures) throw fsError(code);
    return real(from, to);
  });
}

const sleptMs = (sleep) => sleep.mock.calls.map(([ms]) => ms);

describe('patientRename', () => {
  let sleep;
  let log;
  beforeEach(() => {
    sleep = vi.fn();
    log = vi.fn();
  });

  it('pins the budget: 12 attempts and a 250ms ceiling (core has 5 attempts and no ceiling)', () => {
    expect(PATIENT_ATTEMPTS).toBe(12);
    expect(PATIENT_MAX_BACKOFF_MS).toBe(250);
  });

  it('① a rename that works first time is called once, never sleeps and logs nothing', () => {
    const rename = flaky(0);

    expect(patientRename(rename, { sleep, log })('a.tmp', 'b.json')).toBe('ok');

    expect(rename).toHaveBeenCalledTimes(1);
    expect(rename).toHaveBeenCalledWith('a.tmp', 'b.json');
    expect(sleep).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('② absorbs transient refusals below the budget, backs off 10-20ms, and says so exactly once', () => {
    const rename = flaky(2);

    expect(patientRename(rename, { sleep, log })('a.tmp', 'b.json')).toBe('ok');

    expect(rename).toHaveBeenCalledTimes(3);
    expect(sleptMs(sleep)).toEqual([10, 20]);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toBe('[patient-rename] rename onto b.json landed on attempt 3 of 12\n');
  });

  it('③ retries every transient code core retries, and no other', () => {
    expect([...TRANSIENT_RENAME_CODES].sort()).toEqual(['EACCES', 'EBUSY', 'EPERM']);
    for (const code of TRANSIENT_RENAME_CODES) {
      const rename = flaky(1, code);
      expect(patientRename(rename, { sleep, log })('a', 'b')).toBe('ok');
      expect(rename, code).toHaveBeenCalledTimes(2);
    }
  });

  it('④ a refusal that outlasts the budget is rethrown as the ORIGINAL error, after exactly 12 attempts and the capped backoff', () => {
    const boom = fsError('EPERM');
    const rename = vi.fn(() => { throw boom; });
    let caught;

    try {
      patientRename(rename, { sleep, log })('a', 'b');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBe(boom);
    expect(rename).toHaveBeenCalledTimes(PATIENT_ATTEMPTS);
    expect(sleptMs(sleep)).toEqual([10, 20, 40, 80, 160, 250, 250, 250, 250, 250, 250]);
    expect(log).not.toHaveBeenCalled();
  });

  it('⑤ a non-transient code is thrown on the first attempt, with no sleep', () => {
    for (const code of ['ENOENT', 'EXDEV', 'EEXIST', 'EISDIR', undefined]) {
      const rename = vi.fn(() => { throw fsError(code); });

      expect(() => patientRename(rename, { sleep, log })('a', 'b'), String(code)).toThrow(/injected/);

      expect(rename, String(code)).toHaveBeenCalledTimes(1);
    }
    expect(sleep).not.toHaveBeenCalled();
  });

  it('⑥ attempts and maxBackoffMs are options, and the ceiling clamps one sleep, not the doubling', () => {
    const rename = vi.fn(() => { throw fsError('EBUSY'); });

    expect(() => patientRename(rename, { attempts: 5, maxBackoffMs: 30, sleep, log })('a', 'b')).toThrow(/EBUSY/);

    expect(rename).toHaveBeenCalledTimes(5);
    expect(sleptMs(sleep)).toEqual([10, 20, 30, 30]);
  });

  it('⑦ names only the destination file, never the directory', () => {
    patientRename(flaky(1), { sleep, log })('/srv/store/project-state.json.tmp.1.2.x', '/srv/someone/store/project-state.json');

    expect(log.mock.calls[0][0]).toContain('project-state.json');
    expect(log.mock.calls[0][0]).not.toContain('someone');
    expect(log.mock.calls[0][0]).not.toContain('.tmp.');
  });

  it('⑧ with no injected log the line goes to this process\'s stderr (the control for ②)', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      patientRename(flaky(1), { sleep })('a.tmp', 'b.json');
      patientRename(flaky(0), { sleep })('a.tmp', 'b.json');
      const lines = write.mock.calls.map(([chunk]) => String(chunk)).filter((s) => s.startsWith('[patient-rename]'));
      expect(lines).toEqual(['[patient-rename] rename onto b.json landed on attempt 2 of 12\n']);
    } finally {
      write.mockRestore();
    }
  });
});

describe('against the real filesystem — core calls the spied fs.renameSync', () => {
  let dir;
  let dest;
  /** @type {Array<() => void>} */ let restores;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'artibot-patient-rename-'));
    dest = path.join(dir, 'project-state.json');
    restores = [];
    // Core's own backoff would spend wall time between its five attempts.
    const wait = vi.spyOn(Atomics, 'wait').mockImplementation(() => 'timed-out');
    restores.push(() => wait.mockRestore());
  });
  afterEach(() => {
    for (const restore of restores.reverse()) restore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('negative control: WITHOUT the helper a destination that refuses 7 times defeats core\'s 5 attempts (the 2026-10-01 failure)', () => {
    const underneath = flakyThenReal(7);
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation(underneath);
    restores.push(() => spy.mockRestore());

    expect(() => atomicWriteTextSync(dest, 'payload')).toThrow(/EPERM/);

    expect(underneath).toHaveBeenCalledTimes(5);
    expect(fs.readdirSync(dir)).toEqual([]); // core removes its tmp file; nothing landed
  });

  it('positive control: WITH the helper the same destination takes the write on the 8th underlying attempt, and the log says so', () => {
    const sleep = vi.fn();
    const log = vi.fn();
    const underneath = flakyThenReal(7);
    restores.push(installPatientRename({ rename: underneath, sleep, log }));

    atomicWriteTextSync(dest, 'payload');

    expect(underneath).toHaveBeenCalledTimes(8);
    expect(fs.readFileSync(dest, 'utf-8')).toBe('payload');
    expect(fs.readdirSync(dir)).toEqual(['project-state.json']);
    expect(sleptMs(sleep)).toEqual([10, 20, 40, 80, 160, 250, 250]);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain('landed on attempt 8 of 12');
  });

  it('it does not mask a hard failure: a destination that never opens still throws EPERM, after core\'s 5 x 12 attempts', () => {
    const underneath = vi.fn(() => { throw fsError('EPERM'); });
    restores.push(installPatientRename({ rename: underneath, sleep: vi.fn(), log: vi.fn() }));

    expect(() => atomicWriteTextSync(dest, 'payload')).toThrow(/EPERM/);

    expect(underneath).toHaveBeenCalledTimes(5 * PATIENT_ATTEMPTS);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('installPatientRename returns a restore that puts the original fs.renameSync back', () => {
    const original = fs.renameSync;
    const restore = installPatientRename({ sleep: vi.fn(), log: vi.fn() });

    expect(vi.isMockFunction(fs.renameSync)).toBe(true);
    expect(fs.renameSync).not.toBe(original);
    restore();

    expect(fs.renameSync).toBe(original);
  });
});

describe('usePatientRename — installs around each test and restores after it', () => {
  const original = fs.renameSync;

  describe('inside a describe that calls it', () => {
    usePatientRename({ sleep: () => {}, log: () => {} });

    it('fs.renameSync is wrapped while the test runs, and a real rename still works through it', () => {
      expect(vi.isMockFunction(fs.renameSync)).toBe(true);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'artibot-patient-rename-use-'));
      try {
        fs.writeFileSync(path.join(dir, 'a'), 'x');
        fs.renameSync(path.join(dir, 'a'), path.join(dir, 'b'));
        expect(fs.readdirSync(dir)).toEqual(['b']);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('in a sibling describe that does not', () => {
    it('fs.renameSync is the original again', () => {
      expect(vi.isMockFunction(fs.renameSync)).toBe(false);
      expect(fs.renameSync).toBe(original);
    });
  });
});
