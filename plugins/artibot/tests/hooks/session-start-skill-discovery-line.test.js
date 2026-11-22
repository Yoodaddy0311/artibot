/**
 * session-start.js#maybeInjectSkillDiscovery — the first-of-day line says what
 * happened (2026-11-22, raised by lane A's cross-review).
 *
 * The production path is `skill-discovery-inject.js#maybeInject`, which records the
 * once-per-local-day gate and returns true; it injects nothing. The function that
 * does inject the meta-skill prose (`skill-discovery-inject.js#main`) is registered
 * in neither hooks/hooks.json nor hooks/dispatch-table.json. The line used to say
 * the meta-skill was "surfaced" — it never was. Registration is not changed here.
 *
 * The day gate lives in the state dir, pointed at a temp dir for this test.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { maybeInjectSkillDiscovery } from '../../scripts/hooks/session-start.js';
import { pointStateDirAt } from '../helpers/state-dir.js';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let tmp;
let restoreStateDir;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'artibot-ss-skill-line-'));
  restoreStateDir = pointStateDirAt(path.join(tmp, 'state'));
});

afterEach(() => {
  restoreStateDir();
  rmSync(tmp, { recursive: true, force: true });
});

describe('maybeInjectSkillDiscovery — the line does not claim an injection', () => {
  it('first session of the day: says the gate was recorded and that nothing was injected', async () => {
    const lines = [];
    await maybeInjectSkillDiscovery(PLUGIN_ROOT, lines);

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toMatch(/surfaced|appears in|injected \(/);
    expect(lines[0]).toContain('not injected');
  });

  it('second session the same day: no line', async () => {
    await maybeInjectSkillDiscovery(PLUGIN_ROOT, []);
    const again = [];
    await maybeInjectSkillDiscovery(PLUGIN_ROOT, again);
    expect(again).toEqual([]);
  });
});
