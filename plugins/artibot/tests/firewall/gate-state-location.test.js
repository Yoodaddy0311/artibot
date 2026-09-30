/**
 * Firewall — the gates' loop-guard state has ONE home, and it is not the plugin
 * directory (O2).
 *
 * WHY A SCAN AND NOT ONLY BEHAVIOUR TESTS. The spawn suites
 * (`tests/hooks/gate-state-project-scope.test.js`, `stop-review-gate-state`,
 * `pre-write-guard-state`) prove that the four hooks, AS THEY ARE, keep state
 * per project and per session. They cannot notice a FIFTH place quietly going
 * back to `path.join(getPluginRoot(), 'runtime', ...)` for one of these files,
 * nor a hook that keeps the names but derives the directory by hand — the
 * partial adoption that leaves a writer and a reader looking in different
 * places. `tests/firewall/hooks-no-dotgit-literal.test.js` is the precedent for
 * this shape: make the obvious regression red.
 *
 * WHAT IS SCANNED — an allowlist, and every clause has a self-check below:
 *   1. none of the four hooks, nor `deterministic-source.js`, joins a quoted
 *      `'runtime'` path segment (the plugin-root spelling, `path.join(root,
 *      'runtime', FILE)`);
 *   2. none of them spells a gate file name as a string literal — the names come
 *      from `GATE_FILES`, so there is one place to rename and one to read;
 *   3. each of the four hooks imports `lib/project-state/gate-markers.js`, so the
 *      directory is always the module's, never hand-built;
 *   4. `gate-markers.js` imports exactly the modules it is meant to, and in
 *      particular nothing that can name the plugin root.
 *
 * WHAT THIS GATE CANNOT SEE — do not read a green run as more than it is:
 *   - A path built from a variable, a template literal or `'run' + 'time'`. The
 *     scan is deliberately literal; it raises the cost of the obvious regression,
 *     not of a determined one.
 *   - Any other hook or module that keeps ITS OWN state in the plugin root. Only
 *     these five files are named here; the other runtime markers
 *     (`current-effort`, `user-profile`, `token-usage`, `current-teammates`,
 *     `first-run-state`, `task-budget`, ...) are not this gate's subject.
 *   - That the named hooks are registered or ever fire (`hooks/hooks.json`), and
 *     that two processes agree on the directory. The spawn suites measure the
 *     second; nothing here measures the first.
 *   - Comment text. Full-line comments are skipped so prose may name the old
 *     layout; a marker name or `'runtime'` written inside a trailing comment on a
 *     code line would still be flagged, which errs toward red.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(HERE, '..', '..');

/** The four hooks that own gate state. */
const HOOKS = Object.freeze([
  'scripts/hooks/mark-main-agent-edit.js',
  'scripts/hooks/dev-verify-gate.js',
  'scripts/hooks/stop-review-gate.js',
  'scripts/hooks/pre-write-guard.js',
]);

/** Files scanned for the plugin-root spelling and the name literals. */
const SCANNED = Object.freeze([...HOOKS, 'lib/verification/deterministic-source.js']);

const GATE_MARKERS = 'lib/project-state/gate-markers.js';

/** A quoted `runtime` path segment: `path.join(root, 'runtime', FILE)`. */
const RUNTIME_SEGMENT = /(['"`])runtime\1/;

/** A gate file name written as a string literal. */
const MARKER_NAME_LITERAL = /(['"`])last-(?:main-agent-edit|dev-verify-sha|review-gate-sha|pre-write-block)\./;

/** What `gate-markers.js` may import — nothing that can name the plugin root. */
const ALLOWED_IMPORTS = Object.freeze([
  './git-common-dir.js',
  './store-location.js',
  'node:crypto',
  'node:fs',
  'node:path',
]);

/**
 * The lines of a source file that are not a comment line on their own.
 *
 * @param {string} source
 * @returns {Array<{ line: number, text: string }>}
 */
export function codeLines(source) {
  return source.split(/\r?\n/)
    .map((text, i) => ({ line: i + 1, text: text.trim() }))
    .filter(({ text }) => text !== '' && !text.startsWith('//') && !text.startsWith('*') && !text.startsWith('/*'));
}

/**
 * @param {string} source
 * @param {RegExp} pattern
 * @returns {string[]} `line: text` of every code line that matches
 */
export function offending(source, pattern) {
  return codeLines(source)
    .filter(({ text }) => pattern.test(text))
    .map(({ line, text }) => `${line}: ${text}`);
}

/**
 * Module specifiers a source file imports (static `import ... from '<x>'`).
 *
 * @param {string} source
 * @returns {string[]}
 */
export function importSpecifiers(source) {
  return [...source.matchAll(/^\s*import\s[^;]*?from\s+(['"])([^'"]+)\1/gms)].map((m) => m[2]);
}

const read = (rel) => readFileSync(path.join(PLUGIN, rel), 'utf-8');

describe('gate state location — the scanner checks itself first', () => {
  it('flags the plugin-root spelling and ignores prose about it', () => {
    expect(RUNTIME_SEGMENT.test("path.join(pluginRoot, 'runtime', STATE_FILE)")).toBe(true);
    expect(RUNTIME_SEGMENT.test('path.join(root, "runtime", f)')).toBe(true);
    expect(RUNTIME_SEGMENT.test("import x from '../../lib/runtime/ledger.js'")).toBe(false);
    expect(offending('// path.join(pluginRoot, \'runtime\', F)\nconst ok = 1;', RUNTIME_SEGMENT)).toEqual([]);
    expect(offending(' * was `<pluginRoot>/runtime/` \n', RUNTIME_SEGMENT)).toEqual([]);
  });

  it('flags a gate file name written as a literal', () => {
    expect(MARKER_NAME_LITERAL.test("const F = 'last-dev-verify-sha.txt';")).toBe(true);
    expect(MARKER_NAME_LITERAL.test('const F = "last-main-agent-edit.timestamp";')).toBe(true);
    expect(MARKER_NAME_LITERAL.test('GATE_FILES.devVerifyFingerprint')).toBe(false);
    expect(MARKER_NAME_LITERAL.test("const T = 'last-test-result.json';")).toBe(false);
  });

  it('reads import specifiers across lines and ignores prose', () => {
    const src = [
      "import { a } from 'node:fs';",
      'import {',
      '  b,',
      "} from './x.js';",
      "// import c from 'ignored';",
      "const d = 'from \"nope\"';",
    ].join('\n');
    expect(importSpecifiers(src)).toEqual(['node:fs', './x.js']);
  });

  it('actually finds the thing it scans for in the real sources (non-vacuous)', () => {
    // A scanner that found no hook to read would pass forever.
    for (const rel of SCANNED) expect(read(rel).length, rel).toBeGreaterThan(1000);
    expect(importSpecifiers(read('scripts/hooks/dev-verify-gate.js')).length).toBeGreaterThan(5);
  });
});

describe('gate state location — the hooks keep their state out of the plugin directory', () => {
  for (const rel of SCANNED) {
    it(`${rel} joins no quoted 'runtime' segment`, () => {
      expect(offending(read(rel), RUNTIME_SEGMENT)).toEqual([]);
    });

    it(`${rel} spells no gate file name as a literal`, () => {
      expect(offending(read(rel), MARKER_NAME_LITERAL)).toEqual([]);
    });
  }

  for (const rel of HOOKS) {
    it(`${rel} takes its directory from gate-markers.js`, () => {
      const specs = importSpecifiers(read(rel));
      expect(specs.some((s) => s.endsWith('/lib/project-state/gate-markers.js')), specs.join(', ')).toBe(true);
    });
  }
});

describe('gate state location — gate-markers.js cannot name the plugin root', () => {
  it('imports only the allowlisted modules', () => {
    expect([...new Set(importSpecifiers(read(GATE_MARKERS)))].sort()).toEqual([...ALLOWED_IMPORTS].sort());
  });

  it('reads no environment variable and calls no plugin-root resolver in code', () => {
    const code = codeLines(read(GATE_MARKERS)).map(({ text }) => text).join('\n');
    expect(code).not.toMatch(/process\.env|CLAUDE_PLUGIN_ROOT|getPluginRoot|resolveConfigPath/);
  });
});
