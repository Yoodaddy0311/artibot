import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Meta-tests for hooks/hooks.json (issue-scanner A2 P2 #11).
 *
 * v4.7.1 shipped a schema-migration regression because nothing caught the
 * "args[]" vs "args:" structural drift. These tests are a tripwire: any
 * change to the hooks.json description or hook bag shape requires updating
 * tests/hooks-schema-fingerprint.txt as a deliberate two-step.
 *
 * Checks:
 *   1. Every hook entry has at least one args[] element ending in `.js` that
 *      matches `scripts/hooks/<kebab-name>.js` (uniform exec form).
 *   2. Every args[0] starts with `${CLAUDE_PLUGIN_ROOT}` (no relative paths).
 *   3. Every referenced .js file exists on disk.
 *   4. Every hook entry declares a numeric timeout.
 *   5. SHA1 fingerprint of {description, hooks} matches the snapshot file —
 *      change either side and both must update.
 */

const PLUGIN_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const HOOKS_JSON_PATH = path.join(PLUGIN_ROOT, 'hooks', 'hooks.json');
const FINGERPRINT_PATH = path.join(PLUGIN_ROOT, 'tests', 'hooks-schema-fingerprint.txt');

const RAW = readFileSync(HOOKS_JSON_PATH, 'utf-8');
const HOOKS_DOC = JSON.parse(RAW);

/**
 * Recursively walk the hook event groups, yielding each leaf hook entry
 * (the inner object with type/command/args/timeout).
 */
function* iterHookEntries(doc) {
  for (const [event, groups] of Object.entries(doc.hooks || {})) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!Array.isArray(group.hooks)) continue;
      for (const entry of group.hooks) {
        yield { event, entry };
      }
    }
  }
}

describe('hooks.json schema shape', () => {
  it('every hook entry has at least one args[] element pointing at scripts/hooks/<name>.js', () => {
    const re = /scripts\/hooks\/[a-z_][a-z0-9_-]*\.(js|mjs)$/;
    for (const { event, entry } of iterHookEntries(HOOKS_DOC)) {
      const args = entry.args || [];
      expect(Array.isArray(args), `${event}: args must be an array`).toBe(true);
      expect(args.length, `${event}: args must be non-empty`).toBeGreaterThan(0);
      const scriptArg = args.find((a) => re.test(a));
      expect(scriptArg, `${event}: no args[] element matches ${re}`).toBeTruthy();
    }
  });

  it('every args[0] starts with the ${CLAUDE_PLUGIN_ROOT} placeholder', () => {
    for (const { event, entry } of iterHookEntries(HOOKS_DOC)) {
      const args = entry.args || [];
      expect(args[0], `${event}: args[0] is missing`).toBeTruthy();
      expect(
        args[0].startsWith('${CLAUDE_PLUGIN_ROOT}'),
        `${event}: args[0]="${args[0]}" must start with \${CLAUDE_PLUGIN_ROOT}`,
      ).toBe(true);
    }
  });

  it('every referenced .js / .mjs file exists on disk', () => {
    const missing = [];
    for (const { event, entry } of iterHookEntries(HOOKS_DOC)) {
      for (const arg of entry.args || []) {
        if (!arg.startsWith('${CLAUDE_PLUGIN_ROOT}')) continue;
        if (!/\.(js|mjs)$/.test(arg)) continue;
        const rel = arg.replace('${CLAUDE_PLUGIN_ROOT}/', '');
        const abs = path.join(PLUGIN_ROOT, rel);
        if (!existsSync(abs)) missing.push(`${event}: ${rel}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('every hook entry declares a numeric timeout', () => {
    for (const { event, entry } of iterHookEntries(HOOKS_DOC)) {
      expect(
        typeof entry.timeout,
        `${event}: timeout must be a number (got ${typeof entry.timeout})`,
      ).toBe('number');
      expect(entry.timeout).toBeGreaterThan(0);
    }
  });

  it('SHA1 fingerprint of {description, hooks} matches snapshot', () => {
    // Hash the normalized JSON of the load-bearing keys. If a contributor
    // changes the schema description or hook bag, this fails — and the
    // fix is to update tests/hooks-schema-fingerprint.txt explicitly, which
    // forces a PR-level review of the change.
    const canonical = JSON.stringify({
      description: HOOKS_DOC.description,
      hooks: HOOKS_DOC.hooks,
    });
    const actual = createHash('sha1').update(canonical).digest('hex');

    if (!existsSync(FINGERPRINT_PATH)) {
      // Bootstrap: first run writes the file. Subsequent runs assert.
      writeFileSync(FINGERPRINT_PATH, actual + '\n');
      // eslint-disable-next-line no-console
      console.warn(`[hooks-schema] bootstrapped fingerprint to ${actual}`);
      return;
    }

    const expected = readFileSync(FINGERPRINT_PATH, 'utf-8').trim();
    expect(
      actual,
      `hooks.json shape changed. If this is intentional, update ${path.basename(FINGERPRINT_PATH)} to "${actual}".`,
    ).toBe(expected);
  });
});
