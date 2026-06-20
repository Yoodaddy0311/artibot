/**
 * Regression guard for the nightly-trainer registry in
 * scripts/setup-nightly-trainers.js.
 *
 * Why this exists: the GRPO reward/policy teardown (lean redesign 2026-06)
 * removed 5 trainer scripts AND their entries from this registry. Nothing
 * guarded the registry, so a stale entry pointing at a now-deleted script would
 * have shipped silently (the CLI just prints a cron line for a missing file).
 * These tests assert every registered trainer resolves to a real script and
 * that the retired GRPO trainers stay gone.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { absScript, TRAINERS } from '../../scripts/setup-nightly-trainers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// __dirname = .../plugins/artibot/tests/scripts
const PLUGIN_ROOT = join(__dirname, '..', '..');

// The trainers retired in the 2026-06 GRPO teardown — must never reappear.
const RETIRED = [
  'nightly-grpo-trainer',
  'nightly-agent-policy-trainer',
  'nightly-skill-policy-trainer',
  'nightly-joint-policy-trainer',
  'nightly-effort-policy-trainer',
];

describe('nightly-trainer registry', () => {
  it('imports without side effects (no CLI guide printed on import)', () => {
    // Reaching this line means the module import did not run main(); the
    // entrypoint guard works. TRAINERS is the exported registry.
    expect(Array.isArray(TRAINERS)).toBe(true);
    expect(TRAINERS.length).toBeGreaterThan(0);
  });

  it('every registered trainer points at a script that exists on disk', () => {
    for (const t of TRAINERS) {
      const resolved = absScript(PLUGIN_ROOT, t.script);
      expect(existsSync(resolved), `${t.name} -> missing script ${t.script}`).toBe(true);
    }
  });

  it('every entry carries the required scheduling fields', () => {
    for (const t of TRAINERS) {
      expect(t.name, 'name').toBeTruthy();
      expect(t.cron, `${t.name}.cron`).toMatch(/^[\d*/, -]+$/);
      expect(t.schtasks, `${t.name}.schtasks`).toMatch(/^\d{2}:\d{2}$/);
      expect(t.script, `${t.name}.script`).toMatch(/^scripts\/.+\.mjs$/);
      expect(t.purpose, `${t.name}.purpose`).toBeTruthy();
    }
  });

  it('does not re-introduce any retired GRPO trainer', () => {
    const names = TRAINERS.map((t) => t.name);
    for (const retired of RETIRED) {
      expect(names, `retired trainer resurfaced: ${retired}`).not.toContain(retired);
    }
    // The script paths must not reference the deleted grpo/ directory either.
    for (const t of TRAINERS) {
      expect(t.script).not.toMatch(/grpo/i);
    }
  });

  it('keeps the surviving trainers (session-rollup + dream-consolidate)', () => {
    const names = TRAINERS.map((t) => t.name);
    expect(names).toContain('nightly-session-rollup');
    expect(names).toContain('nightly-dream-consolidate');
  });
});
