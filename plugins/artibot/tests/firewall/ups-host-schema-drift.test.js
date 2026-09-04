import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';

/**
 * FIREWALL — the UserPromptSubmit stdout allowlist must not drift from the
 * INSTALLED host's schema (DESIGN-UPS-additionalContext-migration.md §4.3-1).
 *
 * `_userprompt-dispatcher.js` hard-codes the set of keys the host accepts. That
 * set is a MEASUREMENT of one host version, not a standard. When the host adds
 * or removes a field, the constant silently lags and the dispatcher either
 * emits a key that gets stripped (the exact six-week failure this migration
 * repairs — INCIDENT-2026-09-03-hook-payload-contract.md) or refuses to emit a
 * key that would now work.
 *
 * So the gate reads the schema back out of the installed binary and compares.
 *
 * FAIL-CLOSED ON ABSENCE, deliberately (design §4.3-1, rules §10): if no host
 * binary can be found this test FAILS rather than skipping. A skip on a machine
 * with no host would make "the allowlist matches the host" look verified when
 * nothing was measured — the same class of false green the incident came from.
 * Point `ARTIBOT_HOST_BINARY` at a binary to run it elsewhere.
 *
 * WHAT THIS GATE CANNOT SEE
 *   - Schema keys the host validates but never names as a literal in the
 *     bundle (none observed on 2.1.259/2.1.260, but the scan is textual).
 *   - Whether an allowlisted key has the SEMANTICS we assume. It compares key
 *     names, not behaviour — `suppressOriginalPrompt` is in the schema and this
 *     plugin never emits it.
 *   - Host versions that are installed but not the newest under `versions/`.
 *     It measures exactly one binary, named in the failure message.
 *   - Runtime enforcement. The dispatcher could still fail to APPLY its own
 *     constant; ups-stdout-allowlist.test.js is what covers that.
 */

const PLUGIN_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..',
);
const DISPATCHER = path.join(PLUGIN_ROOT, 'scripts', 'hooks', '_userprompt-dispatcher.js');

/**
 * Locate the installed Claude Code binary.
 * @returns {{ path: string, label: string } | null}
 */
function findHostBinary() {
  const override = process.env.ARTIBOT_HOST_BINARY;
  if (override && existsSync(override)) return { path: override, label: `env:${override}` };

  const versionsDir = path.join(homedir(), '.local', 'share', 'claude', 'versions');
  if (!existsSync(versionsDir)) return null;
  const entries = readdirSync(versionsDir)
    .filter((n) => /^\d+\.\d+\.\d+$/.test(n))
    .sort((a, b) => {
      const pa = a.split('.').map(Number);
      const pb = b.split('.').map(Number);
      for (let i = 0; i < 3; i += 1) {
        if (pa[i] !== pb[i]) return pa[i] - pb[i];
      }
      return 0;
    });
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const p = path.join(versionsDir, entries[i]);
    try {
      if (statSync(p).isFile()) return { path: p, label: entries[i] };
    } catch { /* keep looking */ }
  }
  return null;
}

/**
 * Read a 200+MB bundle once and pull the two schema literals out of it.
 * Read as latin1: the literals are ASCII and this avoids UTF-8 decode cost.
 *
 * @param {string} binPath
 * @returns {{ topLevel: string[] | null, ups: string[] | null }}
 */
function extractHostSchema(binPath) {
  const text = readFileSync(binPath, 'latin1');

  // Top-level hook output schema. Anchored on `continue:` + `suppressOutput:`
  // (measured shape on 2.1.259 offset 187026302 / 2.1.260) and terminated at
  // the `hookSpecificOutput` field, which is always last.
  // The leading `{` is part of the match on purpose: `fieldNames` anchors each
  // label on `{` or `,`, so starting at `continue:` would silently drop the
  // FIRST field of every schema it reads.
  const topRe = /\{continue:[A-Za-z0-9_$]{1,4}\(\)\.optional\(\),suppressOutput:[\s\S]{0,900}?hookSpecificOutput:/;
  const topMatch = topRe.exec(text);

  // The UserPromptSubmit variant of hookSpecificOutput.
  const upsRe = /\{hookEventName:[A-Za-z0-9_$]{1,4}\("UserPromptSubmit"\)[\s\S]{0,600}?\}\)\)/;
  const upsMatch = upsRe.exec(text);

  return {
    topLevel: topMatch ? fieldNames(topMatch[0]) : null,
    ups: upsMatch ? fieldNames(upsMatch[0]) : null,
  };
}

/**
 * Pull `name:` field labels out of a minified zod object literal, ignoring the
 * ones that appear inside `.describe("…")` strings.
 * @param {string} chunk
 * @returns {string[]}
 */
function fieldNames(chunk) {
  const withoutDescriptions = chunk.replace(/\.describe\((["'])(?:\\.|(?!\1).)*\1\)/g, '');
  const names = new Set();
  const re = /[{,]([A-Za-z_][A-Za-z0-9_]*):/g;
  let m = re.exec(withoutDescriptions);
  while (m) {
    names.add(m[1]);
    m = re.exec(withoutDescriptions);
  }
  return [...names];
}

describe('UPS host schema drift', () => {
  it('a host binary is present (absence is a FAILURE, not a skip)', () => {
    const found = findHostBinary();
    expect(
      found,
      'No Claude Code binary found under ~/.local/share/claude/versions and '
      + 'ARTIBOT_HOST_BINARY is unset. This gate compares the dispatcher\'s '
      + 'HOST_STDOUT_KEYS against the real host schema; with no binary it '
      + 'measures nothing, and a skip here would read as "verified". '
      + 'Set ARTIBOT_HOST_BINARY=<path> to run it.',
    ).not.toBeNull();
  });

  it('SELF-CHECK: the extractor really finds both schema literals', () => {
    const found = findHostBinary();
    if (!found) return; // the case above already failed
    const schema = extractHostSchema(found.path);
    // If the bundle shape changed enough that the regexes stop matching, the
    // comparisons below would go vacuously green on `null`. Fail loudly here
    // instead so the extractor gets re-derived rather than silently rotting.
    expect(schema.topLevel, `top-level schema not found in host ${found.label}`).not.toBeNull();
    expect(schema.ups, `UserPromptSubmit schema not found in host ${found.label}`).not.toBeNull();
    expect(schema.topLevel.length).toBeGreaterThan(3);
    expect(schema.ups.length).toBeGreaterThan(2);
    // POSITIVE CONTROL on the extractor's boundaries, independent of the
    // dispatcher constant: the first and last field of each schema must be
    // present. An anchor that starts one character too late drops the first
    // field and every comparison below then fails for the wrong reason.
    expect(schema.topLevel, 'first top-level field').toContain('continue');
    expect(schema.topLevel, 'last top-level field').toContain('hookSpecificOutput');
    expect(schema.ups, 'first UPS field').toContain('hookEventName');
    expect(schema.ups, 'last UPS field').toContain('suppressOriginalPrompt');
  });

  it('HOST_STDOUT_KEYS equals the host top-level output schema', async () => {
    const found = findHostBinary();
    if (!found) return;
    const { HOST_STDOUT_KEYS } = await import(DISPATCHER);
    const schema = extractHostSchema(found.path);
    if (!schema.topLevel) return;
    expect(
      [...HOST_STDOUT_KEYS].sort(),
      `host ${found.label} top-level schema`,
    ).toEqual([...schema.topLevel].sort());
  });

  it('HOST_UPS_KEYS equals the host UserPromptSubmit hookSpecificOutput schema', async () => {
    const found = findHostBinary();
    if (!found) return;
    const { HOST_UPS_KEYS } = await import(DISPATCHER);
    const schema = extractHostSchema(found.path);
    if (!schema.ups) return;
    expect(
      [...HOST_UPS_KEYS].sort(),
      `host ${found.label} UserPromptSubmit schema`,
    ).toEqual([...schema.ups].sort());
  });

  it('the source records where the allowlist came from', () => {
    const src = readFileSync(DISPATCHER, 'utf-8');
    // A bare list of strings rots without its provenance. The comment must name
    // the measurement so the next reader can re-derive it.
    expect(src).toMatch(/PROBE-effort-directive-delivery/);
    expect(src).toMatch(/2\.1\.2\d\d/);
  });
});
