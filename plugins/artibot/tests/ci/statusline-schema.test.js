/**
 * Tripwire: statusline.sh must read the OFFICIAL Claude Code statusLine stdin
 * schema, not the fields an early version assumed.
 *
 * Why: the script silently read `.context_window.current_tokens` /
 * `.max_tokens` / `.cost.total_cost` / `.cost.elapsed_seconds` / `.model`
 * (as a string) — none of which exist in the real statusLine payload. The
 * context-usage % bar therefore never rendered. This test fails CI if the
 * correct field names ever regress out of the script.
 *
 * Official schema (per Claude Code docs):
 *   context_window.used_percentage | .total_input_tokens | .context_window_size
 *   cost.total_cost_usd | cost.total_duration_ms
 *   model.display_name | model.id
 *
 * Both variants are wired in the wild — install.sh/install.ps1 register the
 * plain statusline.sh by default, and theme-apply.js swaps in the themed one
 * when /theme is applied — so BOTH get tripwires covering the shared fields
 * above and the richer stdin surface captured from Claude Code 2.1.172:
 *   rate_limits.five_hour.used_percentage | rate_limits.seven_day.used_percentage
 *   effort.level | thinking.enabled | fast_mode
 * plus the account-badge cache path string each reads (shared cache = parity).
 *
 * @module tests/ci/statusline-schema
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PLUGIN_ROOT = join(__dirname, '..', '..');
const statusline = readFileSync(join(PLUGIN_ROOT, 'scripts', 'hooks', 'statusline.sh'), 'utf8');
const themedPath = join(PLUGIN_ROOT, 'scripts', 'hooks', 'statusline-themed.sh');
const themed = readFileSync(themedPath, 'utf8');
const hasBash = spawnSync('bash', ['--version']).status === 0;

describe('statusline.sh reads the official Claude Code statusLine schema', () => {
  it('reads context_window.used_percentage (the pre-computed %)', () => {
    expect(statusline).toMatch(/\.context_window\.used_percentage/);
  });

  it('reads context_window.context_window_size (not max_tokens as primary)', () => {
    expect(statusline).toMatch(/\.context_window\.context_window_size/);
  });

  it('reads context_window.total_input_tokens as the token fallback', () => {
    expect(statusline).toMatch(/\.context_window\.total_input_tokens/);
  });

  it('reads cost.total_cost_usd', () => {
    expect(statusline).toMatch(/\.cost\.total_cost_usd/);
  });

  it('reads cost.total_duration_ms', () => {
    expect(statusline).toMatch(/\.cost\.total_duration_ms/);
  });

  it('reads model.display_name / model.id (model is an object, not a string)', () => {
    expect(statusline).toMatch(/\.model\.display_name/);
    expect(statusline).toMatch(/\.model\.id/);
  });

  // v4.36.5: the account badge shipped themed-only in v4.33.0, so default
  // installs (which wire statusline.sh) never showed it. Both scripts must
  // share the same cache file so the badge stays consistent across variants.
  it('references the account-badge cache path (parity with themed)', () => {
    expect(statusline).toMatch(/runtime\/account-badge\.json/);
  });

  // v4.37: the usage-limit gauge and the stdin effort/thinking/fast badge
  // shipped themed-only in v4.33.0. Ported to the plain variant so default
  // installs render the same rate-limit and effort surface.
  it('reads rate_limits.five_hour.used_percentage', () => {
    expect(statusline).toMatch(/\.rate_limits\.five_hour/);
  });

  it('reads rate_limits.seven_day.used_percentage', () => {
    expect(statusline).toMatch(/\.rate_limits\.seven_day/);
  });

  it('reads effort.level from stdin (preferred over the runtime file)', () => {
    expect(statusline).toMatch(/\.effort\.level/);
  });

  it('reads thinking.enabled', () => {
    expect(statusline).toMatch(/\.thinking\.enabled/);
  });

  it('reads fast_mode', () => {
    expect(statusline).toMatch(/\.fast_mode/);
  });
});

/*
 * The themed script parses the stdin JSON once via object destructuring
 * (e.g. `const cw=o.context_window` then `cw.used_percentage`) rather than
 * repeated dotted-path lookups, so these tripwires assert on the official JSON
 * key bindings (`o.context_window`, `.used_percentage`, ...) — the thing that
 * regresses if a field name is dropped — not on a single dotted-path string.
 */
describe('statusline-themed.sh reads the official Claude Code statusLine schema', () => {
  it('reads context_window.used_percentage (the pre-computed %)', () => {
    expect(themed).toMatch(/o\.context_window/);
    expect(themed).toMatch(/\.used_percentage/);
  });

  it('reads cost.total_cost_usd', () => {
    expect(themed).toMatch(/o\.cost/);
    expect(themed).toMatch(/\.total_cost_usd/);
  });

  it('reads model.display_name / model.id (model is an object, not a string)', () => {
    expect(themed).toMatch(/o\.model/);
    expect(themed).toMatch(/\.display_name/);
    expect(themed).toMatch(/\.id\b/);
  });

  it('reads rate_limits.five_hour.used_percentage', () => {
    expect(themed).toMatch(/o\.rate_limits/);
    expect(themed).toMatch(/\.five_hour/);
  });

  it('reads rate_limits.seven_day.used_percentage', () => {
    expect(themed).toMatch(/\.seven_day/);
  });

  it('reads effort.level', () => {
    expect(themed).toMatch(/o\.effort/);
    expect(themed).toMatch(/\.level/);
  });

  it('reads thinking.enabled', () => {
    expect(themed).toMatch(/o\.thinking/);
    expect(themed).toMatch(/\.enabled/);
  });

  it('reads fast_mode', () => {
    expect(themed).toMatch(/\.fast_mode/);
  });

  it('references the account-badge cache path', () => {
    expect(themed).toMatch(/runtime\/account-badge\.json/);
  });
});

describe('statusline-themed.sh is syntactically valid bash', () => {
  it.skipIf(!hasBash)('passes bash -n (parse-only) syntax check', () => {
    const result = spawnSync('bash', ['-n', themedPath], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
  });
});

describe('statusline.sh is syntactically valid bash', () => {
  it.skipIf(!hasBash)('passes bash -n (parse-only) syntax check', () => {
    const result = spawnSync('bash', ['-n', join(PLUGIN_ROOT, 'scripts', 'hooks', 'statusline.sh')], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
  });
});
