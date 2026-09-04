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
 *   4. Every hook entry declares a numeric timeout — in SECONDS. The host
 *      reads `timeout` as seconds (command-hook default 600). Through v4.55.0
 *      this file carried `5000` / `30000`, i.e. 5,000 s / 30,000 s (retro #50).
 *      Any value above the host default is treated as a millisecond leftover
 *      and fails.
 *   5. SHA1 fingerprint of {description, hooks} matches the snapshot file —
 *      change either side and both must update.
 *   6. Every `matcher` is the plain form the host actually parses: `*`, an
 *      exact tool name, or tool names joined by `|`. The host has NO
 *      expression syntax; anything it cannot match exactly is compiled as an
 *      unanchored JS regex. Measured on host 2.1.260 (2026-09-04 17:01–17:02Z,
 *      headless `claude -p`, one Bash→Write→Edit→Read scenario per run, via
 *      both `--settings` and a plugin `hooks/hooks.json` loaded with
 *      `--plugin-dir`):
 *        `tool == "Bash"`                    → 0 fires on any tool (both loaders)
 *        `tool == "Write" || tool == "Edit"` → fired on Bash, Write, Edit AND
 *                                              Read — the `||` regex has an
 *                                              empty alternative, so it matches
 *                                              every tool (both loaders)
 *        `Bash` / `Write|Edit` / `*`         → exactly the intended tools
 *      So through v4.55.0 pre-bash.js and bash-risk-guard.js never fired, and
 *      the four Write|Edit hooks fired on every tool. Tests 6a–6c below are the
 *      regression gate: 6a allowlists the syntax (fail-closed), 6b simulates
 *      the host's match rule and pins each PreToolUse group to its intended
 *      tool set, 6c proves the simulator reproduces the measured A/B.
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

/** Host default for `command` hooks, in seconds. Anything above it is not a plausible seconds value. */
const HOST_TIMEOUT_DEFAULT_S = 600;
/** Measured 2026-09-04: 29 entries. A floor, so an empty parse cannot pass the loops vacuously. */
const MIN_HOOK_ENTRIES = 29;

/**
 * Matcher allowlist (fail-closed): `*`, one tool name, or tool names joined
 * by `|`. Tool names are identifier-shaped. Nothing else — no `=`, no quotes,
 * no spaces, no regex metacharacters. The expression forms that shipped
 * through v4.55.0 (`tool == "Bash"`) fail this on the first space.
 */
const MATCHER_RE = /^(?:\*|[A-Za-z][A-Za-z0-9_]*(?:\|[A-Za-z][A-Za-z0-9_]*)*)$/;

/**
 * The host's matcher rule, as measured (see header §6): `*`/empty matches
 * everything; an exact tool-name match wins; otherwise the matcher is compiled
 * as an unanchored JS regex and tested against the tool name.
 * @param {string} matcher
 * @param {string} tool
 * @returns {boolean}
 */
function hostMatches(matcher, tool) {
  if (matcher === undefined || matcher === '' || matcher === '*') return true;
  if (matcher === tool) return true;
  try { return new RegExp(matcher).test(tool); } catch { return false; }
}

/** Tools the PreToolUse groups are exercised against. Includes the ones that must NOT fire. */
const TOOL_UNIVERSE = ['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Read', 'Grep', 'Glob', 'Agent', 'WebFetch', 'WebSearch'];

/**
 * `Write|Edit` under the host rule. The regex is UNANCHORED, so it also
 * matches the other edit tools whose names contain "Edit" (MultiEdit,
 * NotebookEdit). That is the documented host behaviour, not a measurement —
 * the A/B exercised Bash/Write/Edit/Read only — and it is the intended set:
 * every one of these tools writes a file. Anchoring (`^(Write|Edit)$`) would
 * leave the allowlist in 6a, so the wider set is pinned here on purpose.
 */
const WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];

/**
 * Intended tool set per PreToolUse script. Keyed by script basename so the
 * table survives re-ordering of groups. A script missing here is a failure —
 * a new PreToolUse hook must declare what it is for.
 */
const PRETOOLUSE_INTENT = {
  'pre-write.js': WRITE_TOOLS,
  'pre-write-guard.js': WRITE_TOOLS,
  'git-autopilot-guard.js': WRITE_TOOLS,
  'pre-write-checkpoint.js': WRITE_TOOLS,
  'pre-bash.js': ['Bash'],
  'bash-risk-guard.js': ['Bash'],
  'route-observe-pre.js': ['Agent'],
  'webfetch-cache-pre.js': ['WebFetch'],
};

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

  it('every timeout is in seconds — no value above the host default (600), which only a millisecond leftover reaches', () => {
    // Self-check first: the loop below must actually see entries.
    const entries = [...iterHookEntries(HOOKS_DOC)];
    expect(entries.length).toBeGreaterThanOrEqual(MIN_HOOK_ENTRIES);
    for (const { event, entry } of entries) {
      expect(Number.isInteger(entry.timeout), `${event}: timeout must be an integer number of seconds`).toBe(true);
      expect(
        entry.timeout,
        `${event}: timeout=${entry.timeout} exceeds the host's 600 s default — a v4.55.0-style millisecond value?`,
      ).toBeLessThanOrEqual(HOST_TIMEOUT_DEFAULT_S);
    }
  });

  it('6a. every matcher is plain: `*`, a tool name, or names joined by `|` (fail-closed allowlist)', () => {
    const groups = Object.entries(HOOKS_DOC.hooks).flatMap(([event, gs]) => gs.map((g) => ({ event, matcher: g.matcher })));
    expect(groups.length).toBeGreaterThan(0);
    for (const { event, matcher } of groups) {
      expect(typeof matcher, `${event}: matcher must be a string`).toBe('string');
      expect(
        MATCHER_RE.test(matcher),
        `${event}: matcher "${matcher}" is not plain — the host has no expression syntax (see header §6)`,
      ).toBe(true);
    }
    // Self-check: the shipped-through-v4.55.0 forms are rejected by this allowlist.
    for (const bad of ['tool == "Bash"', 'tool == "Write" || tool == "Edit"', 'Write |Edit', "tool == 'WebFetch'", 'Write|']) {
      expect(MATCHER_RE.test(bad), `allowlist must reject "${bad}"`).toBe(false);
    }
  });

  it('6b. under the host match rule, each PreToolUse group fires on exactly its intended tools', () => {
    const groups = HOOKS_DOC.hooks.PreToolUse;
    expect(groups.length).toBeGreaterThanOrEqual(Object.keys(PRETOOLUSE_INTENT).length);
    for (const group of groups) {
      for (const entry of group.hooks) {
        const script = entry.command.match(COMMAND_RE)?.[1];
        const intended = PRETOOLUSE_INTENT[script];
        expect(intended, `PreToolUse: ${script} has no entry in PRETOOLUSE_INTENT — declare its tools`).toBeDefined();
        const fires = TOOL_UNIVERSE.filter((t) => hostMatches(group.matcher, t));
        expect(fires, `${script} (matcher "${group.matcher}") fires on the wrong tool set`).toEqual(intended);
      }
    }
  });

  it('6c. the simulator reproduces the measured A/B: expression forms fire on none / on every tool', () => {
    // Anchors hostMatches to the 2026-09-04 measurement so 6b cannot drift into
    // testing a rule the host does not have.
    expect(TOOL_UNIVERSE.filter((t) => hostMatches('tool == "Bash"', t))).toEqual([]);
    expect(TOOL_UNIVERSE.filter((t) => hostMatches('tool == "Write" || tool == "Edit"', t))).toEqual(TOOL_UNIVERSE);
    expect(TOOL_UNIVERSE.filter((t) => hostMatches('Bash', t))).toEqual(['Bash']);
    // Measured on Write/Edit/Read/Bash; MultiEdit/NotebookEdit follow from the unanchored rule (see WRITE_TOOLS).
    expect(TOOL_UNIVERSE.filter((t) => hostMatches('Write|Edit', t))).toEqual(WRITE_TOOLS);
    expect(TOOL_UNIVERSE.filter((t) => hostMatches('*', t))).toEqual(TOOL_UNIVERSE);
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
