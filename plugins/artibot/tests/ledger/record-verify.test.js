/**
 * Real-process contract for `scripts/ledger/record-verify.mjs` — the CLI a
 * model runs to report the outcome of the `/verify` pipeline.
 *
 * WHY THE CASES SPAWN A PROCESS AND READ THE FILE BACK.
 * `tests/verification/verify-writer.test.js` drives `recordVerification`
 * through stub ports, so it proves the writer BUILDS the right envelopes and
 * proves nothing about whether those envelopes survive the ledger's allowlist,
 * envelope validation and byte cap. A `data` shape the writer refuses lands as
 * `ledger.rejected` and the record is lost — green unit tests and an empty
 * ledger are perfectly compatible. So every case here spawns the real script,
 * lets it write a real ledger file (`<root>/.git/artibot/ledger.jsonl` under
 * ADR-011, wherever `ledgerFilePath` puts it), and reads the file back. "It
 * did not throw" is a necessary condition, not the contract.
 *
 * FOUR LINES IS THE CONTRACT, NOT THREE. One run writes one line per layer
 * plus one overall fold. The two layers nobody can self-report land as
 * `unmeasured`, on purpose: an ABSENT line reads to
 * `lib/runtime/artifact-lifecycle-gates.js#tallyLayer` as a smaller
 * denominator, while an `unmeasured` one reads as a layer that was not
 * measured. Every positive case therefore asserts the count AND the per-layer
 * results, because a regression that dropped the two unmeasured lines would
 * still leave a green "the pass landed" assertion behind.
 *
 * THE EVIDENCE NOTE IS THE ONLY MARKER. `verify.completed` has no
 * `kind_source` field (`schemas/ledger-events.allowlist.json`, read
 * 2026-09-14) and the layer `reason` is not written to the ledger at all, so
 * `SELF_REPORT_NOTE` inside `data.evidence` is the single thing separating a
 * self-reported line from one a hook measured. `sanitizeEvidence` drops an
 * entry that fails its kind's required fields SILENTLY, so the note reaching
 * the file is a real risk and is asserted as bytes rather than assumed.
 *
 * ── WHY EVERY TMP ROOT CARRIES `artibot.config.json` ────────────────────────
 *  Inherited from `tests/ledger/record-human-resolved.test.js`: Artibot guards
 *  drop out entirely when the cwd is outside an Artibot repo, and a bare
 *  `.git/` directory is not enough to make a temp directory look like one.
 *  Nothing in this file depends on a guard firing, so the file is cheap
 *  insurance rather than load-bearing here — it keeps these roots the same
 *  shape as the precedent's.
 *
 * ── ISOLATION ───────────────────────────────────────────────────────────────
 *  Every case builds its own `mkdtempSync` root and passes it as BOTH the child
 *  process cwd and `--cwd`, so nothing here can reach the repository's own
 *  `.git/artibot/` store. The one case that omits `--cwd` still runs with the
 *  child cwd inside the temp root, which is the defaulting behaviour it
 *  measures. `resolveGitCommonDir` is pure `fs` (no `git` subprocess), so the
 *  path this file computes and the path the child computes come from the same
 *  function over the same root.
 *
 * ── WHY IDEMPOTENCY IS PROVED TWICE, IN TWO DIFFERENT WAYS ─────────────────
 *  `verification_id` embeds `measured_at` at SECOND resolution
 *  (`unified-verifier.js#buildVerificationId`), so two spawns of the same
 *  command produce the same id only when they land inside one second. That is
 *  a race, not a contract, and a test that asserted either outcome would be
 *  flaky. So the spawn case asserts the INVARIANT that holds under both
 *  timings — `appended + deduped === 4`, and the file grew by exactly
 *  `appended` — while key-level dedupe is proved separately by an in-process
 *  call of `recordVerification` twice over ONE verdict object, where the id is
 *  fixed by construction.
 *
 * ── WHAT THIS FILE CANNOT SEE ───────────────────────────────────────────────
 *  - WHETHER ANY MODEL EVER RUNS THIS. `commands/verify.md` asks for it; no
 *    hook, command or CI step executes it. Its call rate is unmeasured, and a
 *    green run here says only that it works when called.
 *  - WHETHER THE `--status` IS TRUE. The script records what it is told; there
 *    is no linter behind it. See the module header.
 *  - THE INSTALLED COPY. These cases run the file in this worktree.
 *  - THE BYTE CAP. `fitLine` shortens `output`/`note` and then drops whole
 *    entries, and nothing here passes evidence large enough to trip it. A
 *    caller pasting a 40 KB test log into `--command` is unexercised.
 *
 * @module tests/ledger/record-verify
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ledgerFilePath } from '../../lib/runtime/event-writer.js';
import { verify } from '../../lib/verification/unified-verifier.js';
import { recordVerification } from '../../lib/verification/verify-writer.js';
import { SELF_REPORT_NOTE } from '../../scripts/ledger/record-verify.mjs';

// This file spawns child processes. The budget buys headroom for load; nothing
// here waits on a timer.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(PLUGIN_ROOT, 'scripts', 'ledger', 'record-verify.mjs');

const SID = 'sessVGW00002';

/** The exact key set the module header promises a caller can parse blind. */
const STDOUT_KEYS = [
  'event', 'verification_id', 'session', 'status',
  'recorded', 'appended', 'deduped', 'rejected', 'skipped', 'reason',
];

/** @type {string} */
let tmp;

/** A project root the Artibot guards will actually run inside. */
function makeRoot(name) {
  const root = path.join(tmp, name);
  mkdirSync(path.join(root, '.git'), { recursive: true });
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'artibot.config.json'), '{}\n', 'utf-8');
  return root;
}

/** Run the CLI inside a project root. */
function runCli(args, root, env = {}) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf-8', windowsHide: true, cwd: root, env: { ...process.env, ...env },
  });
  return { status: res.status, stdout: String(res.stdout || ''), stderr: String(res.stderr || '') };
}

/** Every well-formed event in a project's ledger. */
function ledgerEvents(root) {
  const file = ledgerFilePath(root);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf-8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

/**
 * The `verify.completed` lines, with the rejected count checked FIRST. A
 * rejected line means the record violated its own contract and was silently
 * lost, which is the failure this whole file exists to catch.
 */
function verifyLinesIn(root) {
  const events = ledgerEvents(root);
  expect(events.filter((e) => e.event === 'ledger.rejected')).toEqual([]);
  return events.filter((e) => e.event === 'verify.completed');
}

/** The one line for a layer, or the overall line when `layer` is null. */
function lineFor(lines, layer) {
  const match = lines.filter((e) => (layer === null
    ? !Object.prototype.hasOwnProperty.call(e.data, 'layer')
    : e.data.layer === layer));
  expect(match, `expected exactly one line for layer ${String(layer)}`).toHaveLength(1);
  return match[0];
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'artibot-rverify-')));
});
afterEach(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
});

describe('record-verify: the lines land in a real ledger', () => {
  it('writes four lines for a PASS — one per layer plus the overall fold', () => {
    const root = makeRoot('A');

    const out = runCli([
      '--status', 'PASS', '--command', '/verify: all pass',
      '--evidence', 'tests/x.test.js:12', '--session', SID, '--cwd', root,
    ], root);

    expect(out.stderr).toBe('');
    expect(out.status).toBe(0);

    const lines = verifyLinesIn(root);
    expect(lines).toHaveLength(4);
    expect(lineFor(lines, 'deterministic').data.result).toBe('pass');
    // The two layers no caller can self-report are RECORDED as unmeasured, not
    // omitted — an omitted layer reads as a smaller denominator.
    expect(lineFor(lines, 'behavioral').data.result).toBe('unmeasured');
    expect(lineFor(lines, 'operational').data.result).toBe('unmeasured');
    expect(lineFor(lines, null).data.result).toBe('pass');

    for (const line of lines) {
      // `gate` is the only source the allowlist accepts for this event; a
      // different one would be rejected and the record lost.
      expect(line.source).toBe('gate');
      expect(line.session_id).toBe(SID);
      expect(typeof line.data.verification_id).toBe('string');
    }
    expect(new Set(lines.map((l) => l.data.verification_id)).size).toBe(1);
  });

  it('carries the self-report note and the caller evidence into the file', () => {
    const root = makeRoot('B');

    runCli([
      '--status', 'PASS', '--command', '/verify: lint PASS typecheck PASS',
      '--evidence', 'tests/x.test.js:12', '--evidence', 'npm run lint',
      '--session', SID, '--cwd', root,
    ], root);

    const deterministic = lineFor(verifyLinesIn(root), 'deterministic');
    const evidence = deterministic.data.evidence;
    expect(Array.isArray(evidence)).toBe(true);
    // THE MARKER. Asserted as bytes: `sanitizeEvidence` drops a malformed entry
    // silently, so "the note is in there somewhere" is exactly the claim that
    // could be false while every other assertion passes.
    expect(evidence[0]).toEqual({
      kind: 'command',
      command: '/verify: lint PASS typecheck PASS',
      output: '',
      note: SELF_REPORT_NOTE,
    });
    // The marker is FIRST because `fitLine` drops evidence from the END.
    expect(evidence[0].note).toBe(SELF_REPORT_NOTE);
    // A `path:line` ref becomes a file entry; anything else a command entry.
    expect(evidence[1]).toEqual({ kind: 'file', file: 'tests/x.test.js', line: 12 });
    expect(evidence[2]).toEqual({ kind: 'command', command: 'npm run lint', output: '' });
  });

  it('writes fail for --status FAIL, on the layer and on the fold', () => {
    const root = makeRoot('C');

    const out = runCli([
      '--status', 'FAIL', '--command', '/verify: test FAIL', '--session', SID, '--cwd', root,
    ], root);

    expect(out.status).toBe(0);
    const lines = verifyLinesIn(root);
    expect(lines).toHaveLength(4);
    expect(lineFor(lines, 'deterministic').data.result).toBe('fail');
    // A FAIL on a required layer must not be diluted by the two unmeasured
    // ones: the fold is FAIL, never `unmeasured`.
    expect(lineFor(lines, null).data.result).toBe('fail');
    expect(JSON.parse(out.stdout).status).toBe('FAIL');
  });

  it('prints one line of JSON with the fixed key set', () => {
    const root = makeRoot('D');

    const out = runCli([
      '--status', 'PASS', '--session', SID, '--cwd', root,
    ], root);

    expect(out.stdout.trim().split('\n')).toHaveLength(1);
    const printed = JSON.parse(out.stdout);
    expect(Object.keys(printed).sort()).toEqual([...STDOUT_KEYS].sort());
    expect(printed.event).toBe('verify.completed');
    expect(printed.recorded).toBe(true);
    expect(printed.appended).toBe(4);
    expect(printed.deduped).toBe(0);
    expect(printed.rejected).toBe(0);
    expect(printed.skipped).toBe(0);
    expect(printed.reason).toBeNull();
    expect(printed.session).toBe(SID);
    // The id on stdout is what the model will quote; the id in the file is what
    // a reader joins on. If those two differ the join is broken AND invisible.
    expect(printed.verification_id).toBe(verifyLinesIn(root)[0].data.verification_id);
  });

  it('defaults --command to /verify and --layer to deterministic', () => {
    const root = makeRoot('E');

    const out = runCli(['--status', 'PASS', '--session', SID, '--cwd', root], root);

    expect(out.status).toBe(0);
    const lines = verifyLinesIn(root);
    expect(lineFor(lines, 'deterministic').data.evidence[0].command).toBe('/verify');
    expect(lineFor(lines, 'deterministic').data.result).toBe('pass');
  });

  it('accepts --layer deterministic explicitly, with the same result', () => {
    const root = makeRoot('F');

    const out = runCli([
      '--status', 'PASS', '--layer', 'deterministic', '--session', SID, '--cwd', root,
    ], root);

    expect(out.status).toBe(0);
    expect(verifyLinesIn(root)).toHaveLength(4);
  });

  it('falls back to CLAUDE_SESSION_ID and to the process cwd', () => {
    const root = makeRoot('G');

    const out = runCli(['--status', 'PASS'], root, { CLAUDE_SESSION_ID: SID });

    expect(out.status).toBe(0);
    expect(JSON.parse(out.stdout).session).toBe(SID);
    // The one place this CLI departs from the writer's injected-root rule, and
    // it is allowed only because a model runs it from the project root.
    expect(verifyLinesIn(root)).toHaveLength(4);
  });
});

describe('record-verify: what it refuses to write', () => {
  it.each([
    ['--status is missing', ['--command', '/verify']],
    ['--status is outside the enum', ['--status', 'MAYBE']],
    ['--status is UNMEASURED', ['--status', 'UNMEASURED']],
    ['--layer is a layer nobody can self-report', ['--status', 'PASS', '--layer', 'behavioral']],
    ['--layer is unknown', ['--status', 'PASS', '--layer', 'cosmic']],
    ['--command is empty', ['--status', 'PASS', '--command', '   ']],
    ['a flag has no value', ['--status']],
    ['an unknown flag is passed', ['--status', 'PASS', '--oops']],
  ])('exits 2 and writes nothing when %s', (_label, args) => {
    const root = makeRoot('H');

    const out = runCli([...args, '--session', SID, '--cwd', root], root);

    // A malformed request is not the same class of event as a failed write.
    // Exiting 0 here would report success for a record that does not exist.
    expect(out.status).toBe(2);
    expect(out.stdout).toBe('');
    expect(out.stderr.trim().split('\n')).toHaveLength(1);
    expect(out.stderr.startsWith('record-verify:')).toBe(true);
    // A usage error must leave the ledger untouched — not even a rejected line.
    expect(ledgerEvents(root)).toEqual([]);
  });

  it('writes nothing and says so when no session id can be found', () => {
    const root = makeRoot('I');

    const out = runCli(['--status', 'PASS', '--cwd', root], root, { CLAUDE_SESSION_ID: '' });

    // Exit 0: a missing session is an observation about the environment, not a
    // mistake in the command line.
    expect(out.status).toBe(0);
    const printed = JSON.parse(out.stdout);
    expect(printed.session).toBe('none');
    expect(printed.recorded).toBe(false);
    expect(printed.skipped).toBe(1);
    expect(printed.appended).toBe(0);
    expect(printed.reason).toMatch(/session/i);
    expect(ledgerEvents(root)).toEqual([]);
  });

  it('exits 0 and reports rejected when the ledger cannot be written', () => {
    const root = makeRoot('J');
    // Put a regular FILE where the ledger's directory has to be, so the
    // writer's `mkdirSync` fails. Derived from `ledgerFilePath` rather than
    // hardcoded, so this keeps working if the store location moves.
    const dir = path.dirname(ledgerFilePath(root));
    mkdirSync(path.dirname(dir), { recursive: true });
    writeFileSync(dir, 'not a directory\n', 'utf-8');

    const out = runCli(['--status', 'PASS', '--session', SID, '--cwd', root], root);

    // The Observe contract: a recording failure is not the caller's problem and
    // must not fail its step.
    expect(out.status).toBe(0);
    const printed = JSON.parse(out.stdout);
    expect(printed.recorded).toBe(false);
    expect(printed.appended).toBe(0);
    expect(printed.rejected).toBeGreaterThanOrEqual(1);
    // The reason names what happened rather than being a bare `false`.
    expect(typeof printed.reason).toBe('string');
    expect(printed.reason.length).toBeGreaterThan(0);
    expect(existsSync(ledgerFilePath(root))).toBe(false);
  });
});

describe('record-verify: running it twice', () => {
  it('never double-counts a layer, whichever second the two runs land in', () => {
    const root = makeRoot('K');
    const args = ['--status', 'PASS', '--command', '/verify: all pass', '--session', SID, '--cwd', root];

    const first = JSON.parse(runCli(args, root).stdout);
    expect(first.appended).toBe(4);
    const before = verifyLinesIn(root).length;

    const second = JSON.parse(runCli(args, root).stdout);

    // `verification_id` embeds a SECOND-resolution stamp, so whether the two
    // runs share an id is a race. The invariant that holds either way: every
    // planned line is accounted for exactly once, and the file grew by exactly
    // the number the script says it appended.
    expect(second.appended + second.deduped).toBe(4);
    expect(second.rejected).toBe(0);
    expect(verifyLinesIn(root)).toHaveLength(before + second.appended);
    if (second.deduped === 4) expect(second.verification_id).toBe(first.verification_id);
    else expect(second.verification_id).not.toBe(first.verification_id);
  });

  it('dedupes on the idempotency key when the verdict is identical', () => {
    // In-process, no spawn: this is the half of idempotency the spawn case
    // cannot pin, because here ONE verdict object is recorded twice and the id
    // is fixed by construction rather than by the clock.
    const verdict = verify({
      layers: { deterministic: { exitCode: 0, reason: 'PASS self-reported', evidence: [] } },
    });
    const written = [];
    const ports = {
      append: (input) => { written.push(input); return { ok: true }; },
      existingKeys: () => written.map((e) => e.idempotency_key),
    };

    const first = recordVerification(verdict, { sessionId: SID }, ports);
    const second = recordVerification(verdict, { sessionId: SID }, ports);

    expect(first.appended).toBe(4);
    expect(first.deduped).toBe(0);
    expect(second.appended).toBe(0);
    expect(second.deduped).toBe(4);
    expect(written).toHaveLength(4);
  });
});

describe('record-verify: it is safe to import', () => {
  it('does nothing when imported rather than run', async () => {
    // The direct-run guard is what lets a test or a sibling import this file
    // without running a side effect. A guard that answers FALSE on a real
    // direct run is fail-open in the quietest way (tests/ci/direct-run-guard);
    // every case above is the positive half of that pin, this is the negative
    // half — and this file's own top-level import of SELF_REPORT_NOTE would
    // hang or write if the guard were wrong.
    const mod = await import(`file:///${CLI.replace(/\\/g, '/')}`);

    expect(typeof mod.main).toBe('function');
    expect(mod.SELF_REPORT_NOTE).toBe(SELF_REPORT_NOTE);
  });
});
