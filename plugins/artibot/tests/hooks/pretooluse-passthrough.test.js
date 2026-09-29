/**
 * PreToolUse passthrough gate: a hook that does not BLOCK must not GRANT.
 *
 * V5-BACKLOG CA-04 (security). Measured on host claude 2.1.284 by the CA-04 L0
 * probe (60 nested `claude -p` cells, commit 6094ed98): a PreToolUse hook that
 * prints the legacy `{"decision":"approve"}` is read by the host as `allow`, and
 * an allow from a hook skips the permission prompt ("Hook approved tool use for
 * Bash, bypassing permission prompt") in default, acceptEdits and even dontAsk
 * mode, where the same command with no hook is refused. `pre-bash.js`,
 * `pre-write.js` and `pre-write-checkpoint.js` printed exactly that for EVERY
 * call their guards did not block, so an installed Artibot switched the user's
 * permission settings off for Bash, Write and Edit.
 *
 * THE CONTRACT THIS FILE PINS
 *   - block  : `{"decision":"block","reason":"..."}` on stdout, exit 0. Unchanged.
 *   - pass   : ZERO bytes on stdout, exit 0 (passthrough). The host's own
 *              permission flow decides. Same shape as `bash-risk-guard.js` and
 *              `route-observe-pre.js`.
 *   - never  : a value that grants. The host maps top-level `decision` "approve"
 *              to allow and "block" to deny, and THROWS on any other value, so
 *              there is no neutral legacy word to print; and a hookSpecificOutput
 *              `permissionDecision` of "allow" is the same grant in the new
 *              spelling. Stdout that does not start with `{` is read as plain
 *              text and carries no decision. (Host facts read from the installed
 *              2.1.284 binary's own hook-output mapper on 2026-09-29; the
 *              behavioural half is the probe above.)
 *   - tail   : the fail-closed tail (a hook error blocks) is unchanged.
 *
 * ORDER IS DISCIPLINE: the scanner's self-check comes BEFORE the live scan, and
 * every zero-byte assertion sits next to a block control run through the same
 * harness. A hook that silently did nothing (the `isMainEntry` trap) also prints
 * zero bytes, so a pass-path result only means something beside a block that
 * happened.
 *
 * WHAT THIS GATE CANNOT SEE
 *   - The live host. These are child-process byte checks. That empty PreToolUse
 *     stdout yields the host's normal permission flow is the documented contract
 *     and what the host's mapper does with it; it was not re-measured here with a
 *     nested `claude -p` run.
 *   - Indirect emitters. The scan looks for the quoted words in the hook file
 *     itself; a hook that got its verdict from a helper printing an approve
 *     would not be seen.
 *   - Other events. `stop-review-gate.js` prints `decision:'approve'` on Stop;
 *     Stop has no permission prompt and is not a PreToolUse hook, so it is not
 *     scanned. PermissionRequest is the one event whose job IS to grant; it is
 *     pinned default-off below, not scanned.
 *   - Hooks from the user's own settings or from other plugins.
 *   - Payload realism. Payloads carry the key set the probe observed but are
 *     hand-built.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ledgerFilePath } from '../../lib/runtime/event-writer.js';

// Every case here spawns a child process; the budget buys headroom for load,
// not for a slow assertion.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS_DIR = path.join(PLUGIN_ROOT, 'scripts', 'hooks');
const HOOKS_JSON = JSON.parse(readFileSync(path.join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf-8'));
const hookPath = (name) => path.join(HOOKS_DIR, name);

const CONVERTED = Object.freeze(['pre-bash.js', 'pre-write.js', 'pre-write-checkpoint.js', 'pre-write-guard.js']);

/**
 * PreToolUse scripts that STILL grant. Empty since pre-write-guard.js was converted.
 * An entry is a debt, not an exemption: the ratchet below fails when an entry no
 * longer grants (delete it) and when a script outside this map grants (fix it).
 */
const KNOWN_PENDING = Object.freeze({});

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

/** Quoted spellings of a permission GRANT. Deny and ask are not grants. */
const GRANT_PATTERNS = Object.freeze([
  { kind: 'legacy-approve', re: /['"`]approve['"`]/ },
  { kind: 'permissionDecision-allow', re: /permissionDecision['"]?\s*:\s*['"`]allow['"`]/ },
]);

/**
 * Lines of `source` that spell a grant. Comment-only lines are prose and are
 * skipped; a trailing comment on a code line is NOT stripped, so a quoted
 * `'approve'` there is flagged (fail-closed: reword the comment).
 *
 * @param {string} source
 * @returns {Array<{line: number, kind: string}>}
 */
function findGrantSites(source) {
  const sites = [];
  source.split(/\r?\n/).forEach((text, i) => {
    const t = text.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
    for (const { kind, re } of GRANT_PATTERNS) {
      if (re.test(text)) sites.push({ line: i + 1, kind });
    }
  });
  return sites;
}

/** Script basenames registered on PreToolUse in hooks.json, sorted. */
function preToolUseScripts() {
  const names = new Set();
  for (const group of HOOKS_JSON.hooks.PreToolUse ?? []) {
    for (const h of group.hooks ?? []) {
      const m = /scripts\/hooks\/([A-Za-z0-9_.-]+\.js)/.exec(h.command ?? '');
      if (m) names.add(m[1]);
    }
  }
  return [...names].sort();
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** @type {string} */ let sandbox;
/** @type {string} */ let root;
/** @type {string} */ let home;
/** @type {string} */ let childTmp;

/**
 * A project root the Artibot guards actually run inside: `executeChain` drops
 * the artibot-policy guards (sensitive-file, content-secret) outside an Artibot
 * repo, so without the marker a `.env` write would PASS for the wrong reason and
 * the block controls below could never fire.
 *
 * @param {string} name
 * @returns {string} absolute root
 */
function makeRoot(name) {
  const r = path.join(sandbox, name);
  mkdirSync(path.join(r, '.git'), { recursive: true });
  mkdirSync(path.join(r, 'src'), { recursive: true });
  writeFileSync(path.join(r, 'artibot.config.json'), '{}\n', 'utf-8');
  writeFileSync(path.join(r, 'src', 'existing.js'), 'const a = 1;\n', 'utf-8');
  return r;
}

/** Every `human.asked` line a hook left in a project's ledger. */
function askedIn(r) {
  const file = ledgerFilePath(r);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf-8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l))
    .filter((e) => e.event === 'human.asked');
}

/** The key set the CA-04 probe observed on a PreToolUse payload. */
function hostPayload(toolName, toolInput, extra = {}) {
  return {
    session_id: 'pt-sess-0001',
    transcript_path: path.join(sandbox, 'transcript.jsonl'),
    cwd: root,
    permission_mode: 'default',
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: 'toolu_pt_0001',
    ...extra,
  };
}

/** Child env: sandboxed home/tmp, host session ids blanked, no inherited plugin root. */
function childEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith('CLAUDE_CODE_') || k === 'CLAUDECODE') delete env[k];
  }
  delete env.CLAUDE_PLUGIN_ROOT;
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    TEMP: childTmp,
    TMP: childTmp,
    TMPDIR: childTmp,
    CLAUDE_SESSION_ID: '',
    CLAUDE_CODE_SESSION_ID: '',
    ...extra,
  };
}

/**
 * @param {string} script hook basename
 * @param {object} payload
 * @param {Record<string,string>} [envExtra]
 * @param {string} [cwd] child process cwd (the payload carries its own `cwd`)
 * @returns {{status: number|null, stdout: string, stderr: string}}
 */
function runHook(script, payload, envExtra = {}, cwd = root) {
  const res = spawnSync(process.execPath, [hookPath(script)], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    windowsHide: true,
    cwd,
    env: childEnv(envExtra),
    timeout: 60_000,
  });
  return { status: res.status, stdout: String(res.stdout || ''), stderr: String(res.stderr || '') };
}

/**
 * Enter the hook as the main module with a stdin whose `setEncoding` throws, so
 * `main()` rejects and the REAL fail-closed tail runs. Installed as a VALUE, not
 * an accessor: an accessor fires while Node builds the `node:process` facade and
 * kills the process before the hook loads.
 */
function runErrorTail(script) {
  const stub = path.join(sandbox, 'stdin-throws.mjs');
  if (!existsSync(stub)) {
    writeFileSync(stub, [
      "Object.defineProperty(process, 'stdin', {",
      '  configurable: true,',
      "  value: { setEncoding() { throw new Error('stdin read failed'); }, on() {}, resume() {} },",
      '});',
      '',
    ].join('\n'), 'utf-8');
  }
  const res = spawnSync(process.execPath, ['--import', pathToFileURL(stub).href, hookPath(script)], {
    encoding: 'utf-8', windowsHide: true, cwd: root, env: childEnv(), timeout: 60_000,
  });
  return { status: res.status, stdout: String(res.stdout || ''), stderr: String(res.stderr || '') };
}

/** A pass must be exactly this: nothing on stdout, exit 0. */
function expectPassthrough(out, label) {
  expect(out.status, `${label}: exit code`).toBe(0);
  expect(out.stdout, `${label}: stdout must be zero bytes`).toBe('');
}

/** A block must be exactly `{"decision":"block","reason":<string>}`, no extra field or byte. */
function expectBlock(out, label) {
  expect(out.status, `${label}: exit code`).toBe(0);
  const parsed = JSON.parse(out.stdout);
  expect(parsed.decision, `${label}: decision`).toBe('block');
  expect(typeof parsed.reason, `${label}: reason`).toBe('string');
  expect(Object.keys(parsed), `${label}: keys`).toEqual(['decision', 'reason']);
  expect(out.stdout, `${label}: bytes`).toBe(JSON.stringify({ decision: 'block', reason: parsed.reason }));
  return parsed;
}

beforeAll(() => {
  sandbox = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'artibot-ptpass-')));
  home = path.join(sandbox, 'home');
  childTmp = path.join(sandbox, 'tmp');
  mkdirSync(home, { recursive: true });
  mkdirSync(childTmp, { recursive: true });
  root = makeRoot('proj');
});

afterAll(() => {
  try { rmSync(sandbox, { recursive: true, force: true }); } catch { /* noop */ }
});

// ---------------------------------------------------------------------------
// 1. Scanner self-check (before any live assertion)
// ---------------------------------------------------------------------------

describe('grant scanner: self-check', () => {
  it.each([
    ["writeStdout({ decision: 'approve' });", 'legacy-approve'],
    ['writeStdout({ decision: "approve" });', 'legacy-approve'],
    ['writeStdout({ decision: `approve` });', 'legacy-approve'],
    ["writeStdout({ decision: blocked ? 'block' : 'approve' });", 'legacy-approve'],
    ['process.stdout.write(\'{"decision":"approve"}\');', 'legacy-approve'],
    ["writeStdout({ hookSpecificOutput: { permissionDecision: 'allow' } });", 'permissionDecision-allow'],
    ['process.stdout.write(\'{"hookSpecificOutput":{"permissionDecision":"allow"}}\');', 'permissionDecision-allow'],
  ])('flags a planted grant: %s', (line, kind) => {
    expect(findGrantSites(`const x = 1;\n${line}\n`)).toEqual([{ line: 2, kind }]);
  });

  it.each([
    "writeStdout({ decision: 'block', reason });",
    "writeStdout({ hookSpecificOutput: { permissionDecision: 'deny' } });",
    "writeStdout({ hookSpecificOutput: { permissionDecision: 'ask' } });",
    '// approve by omission',
    ' * The approve path records NOTHING.',
    '/* the word approve in a block comment */',
    'const approved = true;',
    'return;',
  ])('does not flag: %s', (line) => {
    expect(findGrantSites(`${line}\n`)).toEqual([]);
  });

  it('reports CRLF sources with the right line numbers', () => {
    expect(findGrantSites("a\r\nb\r\nwriteStdout({ decision: 'approve' });\r\n"))
      .toEqual([{ line: 3, kind: 'legacy-approve' }]);
  });

  it('sees grants in REAL code: the Stop hook still prints an approve', () => {
    // Positive control against real source, so a scanner that stopped matching
    // would turn the live scan below into a vacuous green. It is anchored on a
    // Stop hook, which legitimately prints `decision:'approve'` (Stop has no
    // permission prompt), and NOT on KNOWN_PENDING: that map is meant to shrink
    // to empty, and a control that loops over an empty map proves nothing.
    const sites = findGrantSites(readFileSync(hookPath('stop-review-gate.js'), 'utf-8'));
    expect(sites.length, 'stop-review-gate.js should still contain an approve').toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Live scan of the PreToolUse registration
// ---------------------------------------------------------------------------

describe('PreToolUse registration: no registered script grants', () => {
  it('finds the converted hooks in hooks.json (the scan is not empty)', () => {
    const scripts = preToolUseScripts();
    for (const name of CONVERTED) expect(scripts).toContain(name);
    expect(scripts.length).toBeGreaterThanOrEqual(CONVERTED.length);
  });

  it('resolves a scanned script for EVERY PreToolUse command (nothing is silently skipped)', () => {
    // The scan keys on `scripts/hooks/<name>.js`. A command spelled any other way
    // (another directory, an inline `node -e`, a dispatcher that spawns children)
    // would be skipped and the ratchet below would stay green over it.
    const commands = (HOOKS_JSON.hooks.PreToolUse ?? [])
      .flatMap((g) => (g.hooks ?? []).map((h) => h.command ?? ''));
    const unresolved = commands.filter((c) => !/scripts\/hooks\/[A-Za-z0-9_.-]+\.js/.test(c));
    expect(unresolved, 'PreToolUse commands the scan cannot attribute to a hook script').toEqual([]);
    expect(commands.length).toBeGreaterThanOrEqual(CONVERTED.length);
  });

  it('every registered script passes through, except the named debt', () => {
    const offenders = [];
    for (const name of preToolUseScripts()) {
      if (name in KNOWN_PENDING) continue;
      const sites = findGrantSites(readFileSync(hookPath(name), 'utf-8'));
      if (sites.length > 0) offenders.push(`${name}: ${sites.map((s) => `${s.kind}@${s.line}`).join(', ')}`);
    }
    expect(offenders, 'PreToolUse scripts that GRANT permission (print a passthrough instead)').toEqual([]);
  });

  it('every KNOWN_PENDING entry is still registered and still grants (delete the entry once converted)', () => {
    const scripts = preToolUseScripts();
    for (const name of Object.keys(KNOWN_PENDING)) {
      expect(scripts, `${name} is no longer registered on PreToolUse: remove it from KNOWN_PENDING`).toContain(name);
      const sites = findGrantSites(readFileSync(hookPath(name), 'utf-8'));
      expect(sites.length, `${name} no longer grants: remove it from KNOWN_PENDING`).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Real-process behaviour
// ---------------------------------------------------------------------------

describe('pre-bash.js: pass writes nothing, block is unchanged', () => {
  it.each([
    ['a plain listing', { command: 'ls -la' }],
    ['git status', { command: 'git status' }],
    ['echo', { command: 'echo hello' }],
    ['an empty command', { command: '' }],
    ['no command key', {}],
  ])('passes through: %s', (label, toolInput) => {
    expectPassthrough(runHook('pre-bash.js', hostPayload('Bash', toolInput)), label);
  });

  it('records nothing in the ledger on the pass path', () => {
    const r = makeRoot('pb-pass');
    const out = runHook('pre-bash.js', hostPayload('Bash', { command: 'ls -la' }, { cwd: r }), {}, r);
    expectPassthrough(out, 'ls -la in a fresh root');
    expect(askedIn(r)).toEqual([]);
  });

  it('CONTROL: a dangerous command is still blocked with the same bytes and is recorded', () => {
    const r = makeRoot('pb-block');
    const out = runHook('pre-bash.js', hostPayload('Bash', { command: 'rm -rf /tmp/data' }, { cwd: r }), {}, r);
    const parsed = expectBlock(out, 'rm -rf');
    expect(parsed.reason).toContain('rm -rf /tmp/data');
    // The human-asked record of the block still lands (same fresh root as above).
    expect(askedIn(r)).toHaveLength(1);
  });
});

describe('pre-write.js: pass writes nothing, block is unchanged', () => {
  it.each([
    ['Write of a normal file', 'Write', { file_path: () => path.join(root, 'src', 'a.js'), content: 'const x = 1;\n' }],
    ['Edit of an existing file', 'Edit', { file_path: () => path.join(root, 'src', 'existing.js'), old_string: 'const a = 1;', new_string: 'const a = 2;' }],
    ['Write with no file_path', 'Write', {}],
    ['a tool this hook does not own', 'Read', { file_path: () => path.join(root, 'src', 'existing.js') }],
    ['a misdirected Bash payload', 'Write', { command: 'ls -la', file_path: () => path.join(root, 'src', 'a.js') }],
  ])('passes through: %s', (label, toolName, spec) => {
    const toolInput = Object.fromEntries(
      Object.entries(spec).map(([k, v]) => [k, typeof v === 'function' ? v() : v]),
    );
    expectPassthrough(runHook('pre-write.js', hostPayload(toolName, toolInput)), label);
  });

  it('CONTROL: a sensitive-file write is still blocked with the same bytes', () => {
    const out = runHook('pre-write.js', hostPayload('Write', {
      file_path: path.join(root, '.env'), content: 'X=1',
    }));
    const parsed = expectBlock(out, '.env write');
    expect(parsed.reason).toContain('.env');
  });
});

describe('pre-write-checkpoint.js: pass writes nothing, the snapshot still happens', () => {
  it('passes through a Write to a path that does not exist yet', () => {
    expectPassthrough(runHook('pre-write-checkpoint.js', hostPayload('Write', {
      file_path: path.join(root, 'src', 'brand-new.js'), content: 'x',
    })), 'new file');
  });

  it('passes through a tool this hook does not own', () => {
    expectPassthrough(runHook('pre-write-checkpoint.js', hostPayload('Read', {
      file_path: path.join(root, 'src', 'existing.js'),
    })), 'Read');
  });

  it('CONTROL: an existing file is snapshotted and the hook STILL prints nothing', () => {
    const sid = 'pt-cp-sess-0001';
    const out = runHook('pre-write-checkpoint.js', hostPayload('Edit', {
      file_path: path.join(root, 'src', 'existing.js'), old_string: 'const a = 1;', new_string: 'const a = 2;',
    }, { session_id: sid }));
    expectPassthrough(out, 'existing file');
    // Proof the hook ran its real work in this harness: a snapshot FILE landed in
    // the sandboxed temp dir (the directory alone appears as soon as the class
    // is constructed). Without this a zero-byte result could be a no-op.
    const dir = path.join(childTmp, `artibot-file-checkpoints-${sid}`);
    const snapshots = existsSync(dir) ? readdirSync(dir) : [];
    expect(snapshots.some((f) => f.endsWith('-existing.js.json')), `snapshot files: ${snapshots.join(',')}`).toBe(true);
  });
});

describe('fail-closed tail is unchanged', () => {
  it.each(['pre-bash.js', 'pre-write.js'])('%s blocks on a hook error with the fixed reason', (script) => {
    const out = runErrorTail(script);
    expect(out.status).toBe(0);
    expect(out.stdout).toBe(
      '{"decision":"block","reason":"Safety check failed due to hook error. Blocking by default."}',
    );
  });

  it('pre-write-checkpoint.js blocks on a hook error (its wording says "Approving", its behaviour is a block)', () => {
    // Pinned as-is: this limb changes no tail. `createErrorHandler` prints a
    // block whenever it is given a `blockReason`, and this hook gives it one, so
    // the reason string promises the opposite of what the bytes do.
    const out = runErrorTail('pre-write-checkpoint.js');
    expect(out.status).toBe(0);
    expect(out.stdout).toBe('{"decision":"block","reason":"File checkpoint hook error. Approving by default."}');
  });
});

// ---------------------------------------------------------------------------
// 4. PermissionRequest: the one event that grants, pinned default-off
// ---------------------------------------------------------------------------

describe('PermissionRequest: the only grant path is opt-in and ships empty', () => {
  it('ships an empty autoApprove allowlist', () => {
    const cfg = JSON.parse(readFileSync(path.join(PLUGIN_ROOT, 'artibot.config.json'), 'utf-8'));
    expect(cfg.permissions?.autoApprove, 'shipped default auto-approve allowlist').toEqual([]);
  });

  it('prints nothing for a benign Bash request under the shipped config', () => {
    const out = runHook('permission-auto-approve.js', {
      session_id: 'pt-sess-0001',
      cwd: root,
      hook_event_name: 'PermissionRequest',
      permission_mode: 'default',
      tool_name: 'Bash',
      tool_input: { command: 'ls -la' },
      permission_suggestions: [],
    }, { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT });
    expectPassthrough(out, 'PermissionRequest Bash');
  });
});
