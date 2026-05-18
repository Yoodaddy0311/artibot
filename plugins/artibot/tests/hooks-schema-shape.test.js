import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Meta-tests for hooks/hooks.json (issue-scanner A2 P2 #11).
 *
 * v4.7.1 shipped a schema-migration regression where nothing caught the
 * "args[]" structural drift. v4.6.4 then migrated to exec-form
 * (`command: "node"` + `args: [...]`) on the assumption that Claude Code
 * supported args[] — but Claude Code 2.1.x ignores args[] silently. The
 * result: `node` was invoked with no script, read stdin (the JSON payload)
 * as code, and crashed every Stop hook with `Unexpected token ':'` from
 * `internal/main/eval_stdin`.
 *
 * v4.8.2 reverts to shell-form (`command: "node ${CLAUDE_PLUGIN_ROOT}/.../*.js"`).
 * These tests are the tripwire: any change to the hooks.json description
 * or hook bag shape requires updating tests/hooks-schema-fingerprint.txt
 * as a deliberate two-step.
 *
 * Checks:
 *   1. Every hook entry has a `command` string in shell-form starting with
 *      `node ${CLAUDE_PLUGIN_ROOT}/scripts/hooks/<name>.js` (optionally
 *      followed by space-separated subcommand args, e.g. ` start`).
 *   2. No hook entry uses the deprecated exec-form `args[]` field.
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
 * (the inner object with type/command/timeout).
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

const COMMAND_RE =
  /^node \$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/hooks\/([a-z_][a-z0-9_-]*\.(?:js|mjs))(?:\s+\S+)*$/;

describe('hooks.json schema shape', () => {
  it('every hook entry has a shell-form command starting with node ${CLAUDE_PLUGIN_ROOT}/scripts/hooks/<name>.js', () => {
    for (const { event, entry } of iterHookEntries(HOOKS_DOC)) {
      expect(
        typeof entry.command,
        `${event}: command must be a string (got ${typeof entry.command})`,
      ).toBe('string');
      expect(
        COMMAND_RE.test(entry.command),
        `${event}: command="${entry.command}" must match ${COMMAND_RE}`,
      ).toBe(true);
    }
  });

  it('no hook entry uses deprecated exec-form args[] field (Claude Code 2.1.x ignores it)', () => {
    const violations = [];
    for (const { event, entry } of iterHookEntries(HOOKS_DOC)) {
      if (entry.args !== undefined) {
        violations.push(`${event}: entry has forbidden args[] field`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('every referenced .js / .mjs file exists on disk', () => {
    const missing = [];
    for (const { event, entry } of iterHookEntries(HOOKS_DOC)) {
      const match = entry.command?.match(COMMAND_RE);
      if (!match) continue;
      const scriptName = match[1];
      const abs = path.join(PLUGIN_ROOT, 'scripts', 'hooks', scriptName);
      if (!existsSync(abs)) missing.push(`${event}: scripts/hooks/${scriptName}`);
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
