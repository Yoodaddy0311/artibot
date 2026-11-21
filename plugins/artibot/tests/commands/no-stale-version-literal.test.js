/**
 * Command docs must not show a concrete plugin version in an example payload.
 *
 * -- What broke (review L12, 2026-11-21) ----------------------------------------
 * `commands/doctor.md`'s `--json` example read `"version": "4.13.1"` while the
 * plugin was at 4.71.16. A literal in an example output is copied by the model
 * as if it were the answer, and no lockstep gate (release-check.js) looks at it,
 * so it rots silently. The example now uses a placeholder.
 *
 * -- What this gate cannot see --------------------------------------------------
 *  - Versions written any other way than a JSON `"version": "X.Y.Z"` pair (for
 *    example in prose, or `version: X.Y.Z` in YAML). Measured 2026-11-21, the one
 *    other `4.x.y` in commands/ is a dated observation in split.md ("4.50.0
 *    실측"), which is history and must not be rewritten.
 *  - skills/, agents/ and output-styles/ (0 hits there on 2026-11-21, not gated).
 *
 * @module tests/commands/no-stale-version-literal
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const COMMANDS = path.join(PLUGIN_ROOT, 'commands');
const LITERAL = /"version"\s*:\s*"\d+\.\d+\.\d+"/;

const files = readdirSync(COMMANDS).filter((f) => f.endsWith('.md')).sort();

describe('commands/*.md: no concrete version in a JSON example', () => {
  it('scans every command document (0 hits is not 0 files)', () => {
    expect(files.length).toBeGreaterThan(70);
    expect(files).toContain('doctor.md');
  });

  it('no command document carries a "version": "X.Y.Z" literal', () => {
    const hits = files.flatMap((f) =>
      readFileSync(path.join(COMMANDS, f), 'utf-8')
        .split('\n')
        .flatMap((line, i) => (LITERAL.test(line) ? [`commands/${f}:${i + 1} ${line.trim()}`] : [])),
    );
    expect(hits, hits.join('\n')).toEqual([]);
  });

  it('the matcher catches the broken form and leaves the placeholder alone (self-check)', () => {
    expect(LITERAL.test('  "version": "4.13.1",')).toBe(true);
    expect(LITERAL.test('"version":"10.0.0"')).toBe(true);
    expect(LITERAL.test('  "version": "<artibot.config.json version, from Check 1>",')).toBe(false);
    expect(LITERAL.test('  "schema_version": 1,')).toBe(false);
  });
});
