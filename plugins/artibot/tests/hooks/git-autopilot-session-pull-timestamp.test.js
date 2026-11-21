/**
 * L5 (review-fixes 2026-11-21): git-autopilot-session.js#recordPullTimestamp
 * rewrote `.git/autopilot.json` in place with writeFileSync. A write torn part
 * way (disk full, process killed) left a truncated file; loadConfig() then
 * fails to parse it and autopilot is silently OFF for that repo from the next
 * session on. It now goes through lib/core/file.js#atomicWriteJsonSync (tmp
 * sibling + rename), so a torn write damages only the tmp file.
 *
 * The tear is simulated by a node:fs mock that writes the first bytes of any
 * write aimed at `autopilot.json` (target or tmp sibling) and then throws, the
 * shape a real ENOSPC leaves. Real temp directory, real `.git` folder.
 *
 * Not covered: two sessions recording at the same moment (last writer wins on
 * `lastPullAt`, which is harmless — both values are "just now") and a user
 * editing the file at the same instant (their edit can be overwritten).
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tear = vi.hoisted(() => ({ on: false }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal();
  const tornWrite = (file, data, ...rest) => {
    if (tear.on && String(file).includes('autopilot.json')) {
      actual.writeFileSync(file, String(data).slice(0, 7));
      throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
    }
    return actual.writeFileSync(file, data, ...rest);
  };
  return { ...actual, writeFileSync: tornWrite, default: { ...actual, writeFileSync: tornWrite } };
});

const { recordPullTimestamp } = await import('../../scripts/hooks/git-autopilot-session.js');

let repo;
let configPath;
const ORIGINAL = { enabled: true, autoPullOnSession: true, branchPrefix: 'artibot/' };

beforeEach(() => {
  tear.on = false;
  repo = mkdtempSync(path.join(tmpdir(), 'ap-pull-ts-'));
  mkdirSync(path.join(repo, '.git'));
  configPath = path.join(repo, '.git', 'autopilot.json');
  writeFileSync(configPath, JSON.stringify(ORIGINAL, null, 2));
});

afterEach(() => {
  tear.on = false;
  rmSync(repo, { recursive: true, force: true });
});

describe('recordPullTimestamp', () => {
  it('records lastPullAt and keeps every other key', () => {
    const before = Date.now();
    recordPullTimestamp(repo);
    const saved = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(saved).toMatchObject(ORIGINAL);
    expect(Date.parse(saved.lastPullAt)).toBeGreaterThanOrEqual(before - 1000);
  });

  it('leaves the existing config parseable when the write is torn', () => {
    tear.on = true;
    expect(() => recordPullTimestamp(repo)).not.toThrow();
    tear.on = false;
    expect(JSON.parse(readFileSync(configPath, 'utf-8'))).toEqual(ORIGINAL);
    // The torn tmp sibling is cleaned up, not left beside the config.
    expect(readdirSync(path.join(repo, '.git'))).toEqual(['autopilot.json']);
  });
});
