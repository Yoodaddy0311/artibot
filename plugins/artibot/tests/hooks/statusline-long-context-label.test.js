/**
 * statusline.sh — the long-context label must not claim what the host never got (L4,
 * review 2026-11-21).
 *
 * session-start.js#activateLongContext appends the 1M beta header to ANTHROPIC_BETA in
 * its OWN process — a child of Claude Code — so the host's requests never carry it. The
 * marker it writes said only `enabled: true`, and this script rendered `🪟 1M` from that
 * alone. The writer now adds `hostApplied: false`; the plain `🪟 1M` needs a literal
 * `hostApplied: true`, anything else (false, missing, a string) is shown as requested.
 * Both fields are read with the block's own `_json_file_true` (JSON boolean `true`
 * only), matching lib/tui/dashboard.js#readDashboardState; `_json_file_get` printed the
 * string "true" like the boolean (xcC LOW, 2026-11-21).
 *
 * ── how this runs ────────────────────────────────────────────────────────────
 * A full statusline.sh run takes 34-165 s on this host (see
 * statusline-runtime-state.test.js), so the label block is EXTRACTED from the script
 * between its `# >>> artibot-longctx-label >>>` markers (which include `_json_file_true`),
 * together with the script's own `_json_file_get`, and run with `state_file` stubbed to
 * the fixture file. A missing marker is RED, not a skip.
 *
 * ── what this does NOT see ───────────────────────────────────────────────────
 * Where LONGCTX_LABEL lands on the rendered line (the one end-to-end run in
 * statusline-runtime-state.test.js covers that), and the jq path vs the node path of
 * `_json_file_true` separately — whichever this machine has is the one exercised (a
 * machine without jq runs only the node path).
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { announceBashSkip, probeBash, toBashPath } from '../../scripts/utils/bash-compat.js';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const STATUSLINE_SRC = path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'statusline.sh');
const BEGIN = '# >>> artibot-longctx-label >>>';
const END = '# <<< artibot-longctx-label <<<';

const BASH = probeBash();
if (!BASH.ok) announceBashSkip('statusline-long-context-label', BASH.reason);

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const sourceText = readFileSync(STATUSLINE_SRC, 'utf8').replace(/\r\n/g, '\n');

/** The script's text between two markers (inclusive of nothing outside), or null. */
function between(begin, end) {
  const s = sourceText.indexOf(begin);
  const e = sourceText.indexOf(end);
  if (s < 0 || e < 0 || e < s) return null;
  return sourceText.slice(s + begin.length, e);
}

/** The script's own `_json_file_get` definition, through its closing brace. */
function jsonFileGetDef() {
  const m = sourceText.match(/^_json_file_get\(\) \{\n[\s\S]*?\n\}\n/m);
  return m ? m[0] : null;
}

let base;

beforeAll(() => {
  base = mkdtempSync(path.join(os.tmpdir(), 'artibot-sl-longctx-'));
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

/**
 * Run the label block against one marker file and return LONGCTX_LABEL.
 * @param {object|null} marker - null = no marker file
 * @returns {string}
 */
function labelFor(marker) {
  const block = between(BEGIN, END);
  const getter = jsonFileGetDef();
  if (block === null || getter === null) throw new Error('statusline.sh lost its artibot-longctx-label markers or _json_file_get');
  const file = path.join(base, `marker-${Math.random().toString(36).slice(2)}.json`);
  if (marker !== null) writeFileSync(file, JSON.stringify(marker));
  const script = path.join(base, 'probe.sh');
  writeFileSync(script, [
    'set -euo pipefail',
    getter,
    `state_file() { if [ -f "$FIXTURE" ]; then STATE_FILE="$FIXTURE"; else STATE_FILE=''; fi; }`,
    block,
    'printf %s "$LONGCTX_LABEL"',
    '',
  ].join('\n'));
  const r = spawnSync('bash', [toBashPath(script)], {
    encoding: 'utf8',
    env: { ...process.env, FIXTURE: toBashPath(file) },
  });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout;
}

describe('statusline.sh — long-context label block', () => {
  it('is present between its markers (fail-closed, never a skip)', () => {
    expect(between(BEGIN, END)).not.toBeNull();
    expect(jsonFileGetDef()).not.toBeNull();
  });

  describe.skipIf(!BASH.ok)('rendered label', () => {
    it('the writer\'s marker (hostApplied:false) is shown as requested, not as 1M on', () => {
      const label = labelFor({ enabled: true, hostApplied: false });
      expect(label).toBe('🪟 1M 요청(미적용)');
    });

    it('a marker without the field (older writer, same never-applied path) is shown as requested', () => {
      expect(labelFor({ enabled: true })).toBe('🪟 1M 요청(미적용)');
    });

    it('only a literal hostApplied:true is shown as the plain 1M label', () => {
      expect(labelFor({ enabled: true, hostApplied: true })).toBe('🪟 1M');
    });

    // Parity with lib/tui/dashboard.js#readDashboardState, which tests `=== true`
    // (xcC LOW, 2026-11-21): `_json_file_get` prints the STRING "true" exactly like
    // the boolean, so the block used to show the plain 1M label for a string.
    it('a STRING hostApplied:"true" is shown as requested, not as 1M on', () => {
      expect(labelFor({ enabled: true, hostApplied: 'true' })).toBe('🪟 1M 요청(미적용)');
    });

    it('a STRING enabled:"true" shows nothing, as the dashboard does', () => {
      expect(labelFor({ enabled: 'true', hostApplied: true })).toBe('');
    });

    it('a non-boolean truthy hostApplied (1) is shown as requested', () => {
      expect(labelFor({ enabled: true, hostApplied: 1 })).toBe('🪟 1M 요청(미적용)');
    });

    it('disabled or absent marker shows nothing', () => {
      expect(labelFor({ enabled: false, hostApplied: true })).toBe('');
      expect(labelFor(null)).toBe('');
    });
  });
});
