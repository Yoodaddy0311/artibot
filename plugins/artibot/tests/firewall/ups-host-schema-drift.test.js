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
 * ONE CARVE-OUT — CI. 설계 §4.3-1 수정 필요 — 리더 권장 채택 2026-09-04, 오너 미질의.
 * A GitHub runner has no Claude Code install, so unconditional fail-closed makes
 * every push red and the gate gets deleted rather than fixed. When the binary is
 * absent AND `CI` is set, the binary-dependent cases SKIP — but the skip is
 * loud, not silent: the reason is appended to each test name and printed once to
 * stderr, and the wording says UNMEASURED rather than passed. Locally (no `CI`)
 * absence is still a hard failure, so the developer who owns the allowlist is
 * the one who gets told. `ARTIBOT_HOST_BINARY=<path>` re-arms it on CI.
 *
 * The carve-out is scoped to binary ABSENCE only: with a binary present, CI
 * compares exactly as a developer machine does. A DISAGREEMENT never skips.
 *
 * WHAT THIS GATE CANNOT SEE
 *   - Schema keys the host validates but never names as a literal in the
 *     bundle (none observed on 2.1.259/2.1.260, but the scan is textual).
 *   - Whether an allowlisted key has the SEMANTICS we assume. It compares key
 *     names, not behaviour — `suppressOriginalPrompt` is in the schema and this
 *     plugin never emits it.
 *   - Every installed host except the newest one. The search collects
 *     candidates from the npm global prefix AND `~/.local/share/claude/
 *     versions/`, then measures exactly ONE — the highest semver — named in
 *     the failure message with its origin (`npm:` / `versions:` / `env:`).
 *     An older host still on disk is not measured and cannot be.
 *   - Whether the `source` enum members it reads are actually EMITTED. The
 *     enum comparison is textual and structural: it proves the dispatcher's
 *     `HOST_PROMPT_SOURCES` names the same strings the host's UPS input
 *     schema accepts. It says nothing about what each value MEANS, and
 *     nothing about whether a member is behind a rollout flag the host may
 *     never actually fire on this account.
 *   - Runtime enforcement. The dispatcher could still fail to APPLY its own
 *     constant; ups-stdout-allowlist.test.js is what covers that.
 *   - Drift on CI when no binary is installed. That run measures NOTHING here;
 *     the green comes from the other cases in this file and from the suites
 *     listed above. Only a developer machine (or a CI job with
 *     `ARTIBOT_HOST_BINARY`) actually closes this loop.
 */

const PLUGIN_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..',
);
const DISPATCHER = path.join(PLUGIN_ROOT, 'scripts', 'hooks', '_userprompt-dispatcher.js');

/**
 * A real host bundle is ~200MB. The npm package also ships `cli-wrapper.cjs`
 * and `install.cjs` (a few KB); picking one of those up would make the
 * extractor find nothing and read as "the bundle shape changed".
 */
const MIN_BUNDLE_BYTES = 50 * 1024 * 1024;

/** `readdirSync` that yields `[]` instead of throwing on a missing dir. */
function safeReaddir(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** @returns {[number, number, number] | null} */
function parseSemver(text) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(text ?? ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Descending semver; a missing version always ranks last. */
function bySemverDesc(a, b) {
  if (a.version === null && b.version === null) return 0;
  if (a.version === null) return 1;
  if (b.version === null) return -1;
  for (let i = 0; i < 3; i += 1) {
    if (a.version[i] !== b.version[i]) return b.version[i] - a.version[i];
  }
  return 0;
}

/** True only for a path that exists, is a file, and is bundle-sized. */
function isBundleSizedFile(p) {
  try {
    const st = statSync(p);
    return st.isFile() && st.size > MIN_BUNDLE_BYTES;
  } catch {
    return false;
  }
}

/**
 * Directories that an npm global install of `@anthropic-ai/claude-code` can
 * land in. Filesystem only — no `npm root -g`, no `which`: a child process is
 * slow against a 200MB read and resolves differently under CI's PATH.
 * @returns {string[]}
 */
function npmPackageDirs() {
  const home = homedir();
  const roots = [];
  if (process.platform === 'win32') {
    if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, 'npm', 'node_modules'));
  } else {
    roots.push('/usr/local/lib/node_modules');
    roots.push('/usr/lib/node_modules');
    roots.push(path.join(home, '.npm-global', 'lib', 'node_modules'));
    const nvmNode = path.join(home, '.nvm', 'versions', 'node');
    for (const v of safeReaddir(nvmNode)) {
      roots.push(path.join(nvmNode, v, 'lib', 'node_modules'));
    }
  }
  return roots.map((r) => path.join(r, '@anthropic-ai', 'claude-code'));
}

/**
 * The bundle inside one npm package dir: `bin/claude[.exe]` first, then the
 * per-platform optional dependency it is usually hard-linked from.
 * @param {string} pkgDir
 * @returns {string | null}
 */
function bundleInPackage(pkgDir) {
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const direct = path.join(pkgDir, 'bin', exe);
  if (isBundleSizedFile(direct)) return direct;
  // `claude-code-<platform>-<arch>` and its `-musl` variant. Matched by prefix
  // so a new arch does not need this list edited.
  const nested = path.join(pkgDir, 'node_modules', '@anthropic-ai');
  for (const name of safeReaddir(nested)) {
    if (!name.startsWith('claude-code-')) continue;
    const p = path.join(nested, name, exe);
    if (isBundleSizedFile(p)) return p;
  }
  return null;
}

/**
 * Locate the installed Claude Code binary: collect every candidate, then take
 * the highest semver. The npm global install is usually NEWER than anything
 * under `~/.local/share/claude/versions/` (measured 2026-09-05 on this
 * machine: npm 2.1.260 vs versions 2.1.108 / 2.1.31), so a versions-only
 * search reads a stale bundle and the extractor reports a false "schema not
 * found".
 *
 * `ARTIBOT_HOST_BINARY` still wins outright — it is how a CI job or a
 * negative-control run pins one exact bundle.
 *
 * @returns {{ path: string, label: string } | null}
 */
function findHostBinary() {
  const override = process.env.ARTIBOT_HOST_BINARY;
  if (override && existsSync(override)) return { path: override, label: `env:${override}` };

  /** @type {{ path: string, label: string, version: [number,number,number] | null }[]} */
  const candidates = [];

  for (const pkgDir of npmPackageDirs()) {
    const binPath = bundleInPackage(pkgDir);
    if (!binPath) continue;
    let version = null;
    try {
      version = parseSemver(JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf-8')).version);
    } catch { /* unversioned candidate: still usable, just ranked last */ }
    candidates.push({
      path: binPath,
      label: `npm:${version ? version.join('.') : 'unknown'} (${binPath})`,
      version,
    });
  }

  const versionsDir = path.join(homedir(), '.local', 'share', 'claude', 'versions');
  for (const name of safeReaddir(versionsDir)) {
    if (!/^\d+\.\d+\.\d+$/.test(name)) continue;
    const p = path.join(versionsDir, name);
    try {
      if (!statSync(p).isFile()) continue;
    } catch { continue; }
    candidates.push({ path: p, label: `versions:${name}`, version: parseSemver(name) });
  }

  if (candidates.length === 0) return null;
  candidates.sort(bySemverDesc);
  return { path: candidates[0].path, label: candidates[0].label };
}

/**
 * Read a 200+MB bundle once and pull the two schema literals out of it.
 * Read as latin1: the literals are ASCII and this avoids UTF-8 decode cost.
 *
 * @param {string} binPath
 * @returns {{ topLevel: string[] | null, ups: string[] | null, sources: string[] | null }}
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

  // The UserPromptSubmit INPUT schema — what the host sends the hook, not what
  // the hook sends back. `source` is the enum the dispatcher branches on; a new
  // member the dispatcher has never seen is exactly the drift this catches.
  // Anchored on the two fields that always precede it so the enum cannot be
  // confused with another `source:` in a 200MB bundle (there are many).
  const srcRe = /hook_event_name:[A-Za-z0-9_$]{1,4}\("UserPromptSubmit"\),prompt:[A-Za-z0-9_$]{1,4}\(\),source:[A-Za-z0-9_$]{1,4}\(\[([\s\S]{0,300}?)\]\)/;
  const srcMatch = srcRe.exec(text);

  return {
    topLevel: topMatch ? fieldNames(topMatch[0]) : null,
    ups: upsMatch ? fieldNames(upsMatch[0]) : null,
    sources: srcMatch ? enumMembers(srcMatch[1]) : null,
  };
}

/**
 * Pull the string literals out of a minified zod enum argument list.
 * @param {string} chunk
 * @returns {string[]}
 */
function enumMembers(chunk) {
  const out = [];
  const re = /"([A-Za-z0-9_]+)"/g;
  let m = re.exec(chunk);
  while (m) {
    out.push(m[1]);
    m = re.exec(chunk);
  }
  return out;
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

/** Resolved once: every case below asks the same question of the same host. */
const HOST_BINARY = findHostBinary();

/**
 * `CI` is set to `true` by GitHub Actions and by every other runner worth
 * naming. Compared as a string so a literal `CI=false` does not read as on.
 */
const ON_CI = !['', '0', 'false'].includes(String(process.env.CI ?? '').toLowerCase());

/** Absence + CI = the one condition the leader's carve-out covers. */
const SKIP_ON_CI = HOST_BINARY === null && ON_CI;

const SKIP_REASON = 'host binary absent on CI — drift UNMEASURED, not passed';

/** Appended to each skipped test's NAME so the reason survives into the report. */
const NAME_SUFFIX = SKIP_ON_CI ? ` [SKIPPED: ${SKIP_REASON}]` : '';

if (SKIP_ON_CI) {
  // Printed once, at the top, in a shape that survives a scroll-back. A skip
  // that only shows as a dimmed line in the reporter is how "unmeasured" turns
  // into "verified" in someone's summary three weeks later.
  process.stderr.write(
    `\n${'!'.repeat(78)}\n`
    + `!! ups-host-schema-drift: ${SKIP_REASON.toUpperCase()}\n`
    + '!! The dispatcher\'s HOST_STDOUT_KEYS was NOT compared against any host\n'
    + '!! schema in this run. This is a HOLE, not a pass. Set ARTIBOT_HOST_BINARY\n'
    + '!! to close it on CI; locally, absence is still a hard failure.\n'
    + `${'!'.repeat(78)}\n\n`,
  );
} else if (HOST_BINARY) {
  // The counterpart to the banner above: name the ONE binary that was actually
  // measured. Several hosts can be installed at once and the newest wins; a
  // report that says "drift gate green" without naming the bundle is the same
  // unmeasured-reads-as-verified problem in a different shape.
  process.stderr.write(`[ups-host-schema-drift] measuring host ${HOST_BINARY.label}\n`);
}

describe('UPS host schema drift', () => {
  it.skipIf(SKIP_ON_CI)(`a host binary is present (absence is a FAILURE, not a skip)${NAME_SUFFIX}`, () => {
    expect(
      HOST_BINARY,
      'No Claude Code binary found in the npm global node_modules '
      + '(@anthropic-ai/claude-code) or under ~/.local/share/claude/versions, '
      + 'and ARTIBOT_HOST_BINARY is unset. This gate compares the dispatcher\'s '
      + 'HOST_STDOUT_KEYS against the real host schema; with no binary it '
      + 'measures nothing, and a skip here would read as "verified". '
      + 'Set ARTIBOT_HOST_BINARY=<path> to run it.',
    ).not.toBeNull();
  });

  it('the CI carve-out is scoped to ABSENCE, never to disagreement', () => {
    // Runs everywhere, including CI. Guards the carve-out itself: if someone
    // later widens `SKIP_ON_CI` to cover a failing comparison, the gate would
    // go quiet on real drift — the exact failure mode this file exists to catch.
    expect(SKIP_ON_CI).toBe(HOST_BINARY === null && ON_CI);
    if (HOST_BINARY !== null) {
      expect(SKIP_ON_CI, 'a present binary must never skip, CI or not').toBe(false);
    }
  });

  it.skipIf(SKIP_ON_CI)(`SELF-CHECK: the extractor really finds both schema literals${NAME_SUFFIX}`, () => {
    const found = HOST_BINARY;
    if (!found) return; // the case above already failed
    const schema = extractHostSchema(found.path);
    // If the bundle shape changed enough that the regexes stop matching, the
    // comparisons below would go vacuously green on `null`. Fail loudly here
    // instead so the extractor gets re-derived rather than silently rotting.
    expect(schema.topLevel, `top-level schema not found in host ${found.label}`).not.toBeNull();
    expect(schema.ups, `UserPromptSubmit schema not found in host ${found.label}`).not.toBeNull();
    expect(
      schema.sources,
      `UserPromptSubmit input \`source\` enum not found in host ${found.label}`,
    ).not.toBeNull();
    expect(schema.topLevel.length).toBeGreaterThan(3);
    expect(schema.ups.length).toBeGreaterThan(2);
    expect(schema.sources.length).toBeGreaterThan(1);
    // POSITIVE CONTROL on the extractor's boundaries, independent of the
    // dispatcher constant: the first and last field of each schema must be
    // present. An anchor that starts one character too late drops the first
    // field and every comparison below then fails for the wrong reason.
    expect(schema.topLevel, 'first top-level field').toContain('continue');
    expect(schema.topLevel, 'last top-level field').toContain('hookSpecificOutput');
    expect(schema.ups, 'first UPS field').toContain('hookEventName');
    expect(schema.ups, 'last UPS field').toContain('suppressOriginalPrompt');
    // Same boundary check for the enum: `user` is its first member and
    // `system` a host-originated one, so an anchor that lands on the wrong
    // `source:` in the bundle cannot pass this quietly.
    expect(schema.sources, 'first source enum member').toContain('user');
    expect(schema.sources, 'host-originated source enum member').toContain('system');
  });

  it.skipIf(SKIP_ON_CI)(`HOST_STDOUT_KEYS equals the host top-level output schema${NAME_SUFFIX}`, async () => {
    const found = HOST_BINARY;
    if (!found) return;
    const { HOST_STDOUT_KEYS } = await import(DISPATCHER);
    const schema = extractHostSchema(found.path);
    if (!schema.topLevel) return;
    expect(
      [...HOST_STDOUT_KEYS].sort(),
      `host ${found.label} top-level schema`,
    ).toEqual([...schema.topLevel].sort());
  });

  it.skipIf(SKIP_ON_CI)(`HOST_UPS_KEYS equals the host UserPromptSubmit hookSpecificOutput schema${NAME_SUFFIX}`, async () => {
    const found = HOST_BINARY;
    if (!found) return;
    const { HOST_UPS_KEYS } = await import(DISPATCHER);
    const schema = extractHostSchema(found.path);
    if (!schema.ups) return;
    expect(
      [...HOST_UPS_KEYS].sort(),
      `host ${found.label} UserPromptSubmit schema`,
    ).toEqual([...schema.ups].sort());
  });

  it.skipIf(SKIP_ON_CI)(`HOST_PROMPT_SOURCES equals the host UserPromptSubmit input source enum${NAME_SUFFIX}`, async () => {
    const found = HOST_BINARY;
    if (!found) return;
    const mod = await import(DISPATCHER);
    const schema = extractHostSchema(found.path);
    if (!schema.sources) return; // SELF-CHECK above is what fails on a null
    expect(
      mod.HOST_PROMPT_SOURCES,
      '_userprompt-dispatcher.js does not export HOST_PROMPT_SOURCES. The '
      + 'dispatcher branches on the UserPromptSubmit `source` value, so the set '
      + 'it recognises has to be a named constant this gate can read back.',
    ).toBeDefined();
    expect(
      [...mod.HOST_PROMPT_SOURCES].sort(),
      `host ${found.label} UserPromptSubmit input source enum`,
    ).toEqual([...schema.sources].sort());
  });

  it('the source records where the allowlist came from', () => {
    const src = readFileSync(DISPATCHER, 'utf-8');
    // A bare list of strings rots without its provenance. The comment must name
    // the measurement so the next reader can re-derive it.
    expect(src).toMatch(/PROBE-effort-directive-delivery/);
    expect(src).toMatch(/2\.1\.2\d\d/);
  });
});
