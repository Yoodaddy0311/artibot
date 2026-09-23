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
 * ── WHY EVERY SESSION CASE BLANKS BOTH ENV SPELLINGS ───────────────────────
 *  `runCli` spawns with `{ ...process.env, ...env }`, so anything the PARENT
 *  shell exports reaches the child unless a case overrides it by name. The CLI
 *  now reads two spellings — `CLAUDE_SESSION_ID` then `CLAUDE_CODE_SESSION_ID`
 *  — and measured 2026-09-21 on Windows the host exports the SECOND one and
 *  leaves the first empty. A case that blanked only `CLAUDE_SESSION_ID` would
 *  therefore be green on a CI runner that exports neither and red on this
 *  machine; worse, the "no session" case would write a real row under the live
 *  session id instead of writing nothing. Every case whose outcome depends on
 *  the session environment names BOTH variables explicitly, which is what
 *  makes this file host-independent rather than merely green here.
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
 *  - WHETHER THE PROSE PIN CHANGES BEHAVIOUR. The last describe in this file
 *    pins the WORDING of `commands/verify.md` — that the invocation sits in a
 *    numbered step, carries `--cwd`, and names flags the real CLI accepts. It
 *    proves none of: that a model reads the step, that a model runs it, or
 *    that a model fills the placeholders correctly. A model that skips Step 5
 *    entirely leaves every assertion in this file green.
 *  - THE INSTALLED COPY OF THE COMMAND. The pin reads the `commands/verify.md`
 *    in THIS worktree. `~/.claude/commands/verify.md` and the plugin cache can
 *    lag a release by any amount, and nothing here notices.
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
import { evidenceRegistryPath } from '../../lib/verification/evidence-registry.js';
import { verify } from '../../lib/verification/unified-verifier.js';
import { recordVerification } from '../../lib/verification/verify-writer.js';
import { SELF_REPORT_NOTE } from '../../scripts/ledger/record-verify.mjs';

// This file spawns child processes. The budget buys headroom for load; nothing
// here waits on a timer.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(PLUGIN_ROOT, 'scripts', 'ledger', 'record-verify.mjs');

const SID = 'sessVGW00002';

/** A SECOND fixture id, so "which spelling won" is answerable from the row. */
const SID_CODE = 'sessVGW00003';

/** Both env spellings blanked — the only spelling of "no session" that holds. */
const NO_SESSION_ENV = { CLAUDE_SESSION_ID: '', CLAUDE_CODE_SESSION_ID: '' };

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

    const out = runCli(['--status', 'PASS'], root, {
      CLAUDE_SESSION_ID: SID, CLAUDE_CODE_SESSION_ID: '',
    });

    expect(out.status).toBe(0);
    expect(JSON.parse(out.stdout).session).toBe(SID);
    // The id on stdout is not the contract — the id in the ROW is what a reader
    // joins on, so it is read back from the file rather than trusted.
    expect(verifyLinesIn(root).map((l) => l.session_id)).toEqual([SID, SID, SID, SID]);
    // The one place this CLI departs from the writer's injected-root rule, and
    // it is allowed only because a model runs it from the project root.
    expect(verifyLinesIn(root)).toHaveLength(4);
  });

  it('falls back to CLAUDE_CODE_SESSION_ID when CLAUDE_SESSION_ID is empty', () => {
    const root = makeRoot('G2');

    // THE CASE THE LIMB EXISTS FOR. Measured 2026-09-21 on Windows: this is the
    // shape the host actually presents, and before the second read it produced
    // `recorded:false, reason "no session_id"` for every uninstrumented call.
    const out = runCli(['--status', 'PASS', '--cwd', root], root, {
      CLAUDE_SESSION_ID: '', CLAUDE_CODE_SESSION_ID: SID_CODE,
    });

    expect(out.status).toBe(0);
    const printed = JSON.parse(out.stdout);
    expect(printed.recorded).toBe(true);
    expect(printed.session).toBe(SID_CODE);
    expect(verifyLinesIn(root).map((l) => l.session_id)).toEqual(
      [SID_CODE, SID_CODE, SID_CODE, SID_CODE],
    );
  });

  it('prefers CLAUDE_SESSION_ID when both env spellings are set', () => {
    const root = makeRoot('G3');

    // The two ids DIFFER, so a row proves which source won. Equal fixtures would
    // leave a reversed precedence green.
    const out = runCli(['--status', 'PASS', '--cwd', root], root, {
      CLAUDE_SESSION_ID: SID, CLAUDE_CODE_SESSION_ID: SID_CODE,
    });

    expect(out.status).toBe(0);
    expect(JSON.parse(out.stdout).session).toBe(SID);
    expect(new Set(verifyLinesIn(root).map((l) => l.session_id))).toEqual(new Set([SID]));
  });

  it('prefers --session over both env spellings', () => {
    const root = makeRoot('G4');
    const explicit = 'sessVGW00004';

    const out = runCli(['--status', 'PASS', '--session', explicit, '--cwd', root], root, {
      CLAUDE_SESSION_ID: SID, CLAUDE_CODE_SESSION_ID: SID_CODE,
    });

    expect(out.status).toBe(0);
    expect(JSON.parse(out.stdout).session).toBe(explicit);
    expect(new Set(verifyLinesIn(root).map((l) => l.session_id))).toEqual(new Set([explicit]));
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

    // BOTH spellings blanked. Blanking only the first lets the host's
    // `CLAUDE_CODE_SESSION_ID` through and files a row under the LIVE session.
    const out = runCli(['--status', 'PASS', '--cwd', root], root, NO_SESSION_ENV);

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

/** Parsed rows of a root's evidence registry; `[]` when it was never written. */
function registryRows(root) {
  const file = evidenceRegistryPath(root);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf-8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

/**
 * THE EVIDENCE REGISTRY PORT (sh15). The deterministic line and the overall
 * fold carry the same entries, so one run with one `--evidence` ref registers
 * TWO distinct entries (the self-report note and the ref) and no more.
 *
 * WHAT THIS CANNOT SEE: a registry module that fails to import. The CLI imports
 * it statically, exactly as it imports the writer, so a module that throws at
 * load stops the script before `main` — the same exposure the writer's own
 * import already has.
 */
describe('record-verify: the evidence registry', () => {
  const ARGS = ['--status', 'PASS', '--command', '/verify: all pass', '--evidence', 'tests/x.test.js:12'];

  it('registers the evidence of the appended lines under --cwd, beside the ledger', () => {
    const root = makeRoot('R1');

    const out = runCli([...ARGS, '--session', SID, '--cwd', root], root);

    expect(out.status).toBe(0);
    expect(JSON.parse(out.stdout).appended).toBe(4);
    expect(evidenceRegistryPath(root)).toBe(path.join(path.dirname(ledgerFilePath(root)), 'evidence.jsonl'));
    const rows = registryRows(root);
    expect(rows.map((r) => r.type).sort()).toEqual(['command', 'file']);
    const keys = verifyLinesIn(root).map((e) => e.idempotency_key);
    for (const row of rows) expect(keys).toContain(row.source);
  });

  it('adds no row when the same evidence is recorded again', () => {
    const root = makeRoot('R2');
    const args = [...ARGS, '--session', SID, '--cwd', root];

    runCli(args, root);
    expect(registryRows(root)).toHaveLength(2);
    const second = JSON.parse(runCli(args, root).stdout);

    // Whether the second run shares the first run's `verification_id` is a
    // race (see "running it twice"); either way the CONTENT is the same, so the
    // registry must not grow.
    expect(second.appended + second.deduped).toBe(4);
    expect(registryRows(root)).toHaveLength(2);
  });

  it('prints the same line and exit when the registry cannot be written', () => {
    const normalRoot = makeRoot('R3a');
    const normal = runCli([...ARGS, '--session', SID, '--cwd', normalRoot], normalRoot);
    // POSITIVE CONTROL: the port fired where it could, so the blocked case
    // below measures a registry failure rather than an unbound port.
    expect(registryRows(normalRoot)).toHaveLength(2);

    const root = makeRoot('R3b');
    // A DIRECTORY where the registry file has to be, so its append fails.
    mkdirSync(evidenceRegistryPath(root), { recursive: true });
    const blocked = runCli([...ARGS, '--session', SID, '--cwd', root], root);

    expect(blocked.status).toBe(normal.status);
    expect(blocked.stderr).toBe('');
    // `verification_id` embeds the second the run landed in, so it is the one
    // key allowed to differ between the two roots.
    const strip = ({ verification_id: _id, ...rest }) => rest;
    expect(strip(JSON.parse(blocked.stdout))).toEqual(strip(JSON.parse(normal.stdout)));
    expect(Object.keys(JSON.parse(blocked.stdout)).sort()).toEqual([...STDOUT_KEYS].sort());
    expect(verifyLinesIn(root)).toHaveLength(4);
  });
});

/**
 * The invocation `commands/verify.md` asks a model to run, byte for byte.
 * A wording change here is the regression this describe exists to catch, so the
 * string is spelled out rather than built from parts.
 */
const DOC_CALL = 'node "$REC" --status <PASS|FAIL> --command "<one-line summary>"'
  + ' --session "${CLAUDE_SESSION_ID:-$CLAUDE_CODE_SESSION_ID}" --cwd "<project root>"';

/**
 * The WHOLE fenced line, resolution chain included — `DOC_CALL` alone leaves the
 * `REC=` chain unpinned, so reverting it to the bare relative path that only
 * resolves inside this repository would stay green. Measured 2026-09-21: the
 * host sets `CLAUDE_CODE_SESSION_ID` and leaves `CLAUDE_SESSION_ID` empty, so a
 * call naming only the first spelling records nothing.
 */
const DOC_LINE = 'REC="$HOME/.claude/artibot/scripts/ledger/record-verify.mjs";'
  + ' [ -f "$REC" ] || REC="${CLAUDE_PLUGIN_ROOT:-}/scripts/ledger/record-verify.mjs";'
  + ' [ -f "$REC" ] || REC="plugins/artibot/scripts/ledger/record-verify.mjs";'
  + ` if [ -f "$REC" ]; then ${DOC_CALL};`
  + ' else echo "record-verify not found - outcome NOT recorded"; fi';

/** The flags the doc's call is expected to name — the loop's cardinality anchor. */
const DOC_FLAGS = ['--status', '--command', '--session', '--cwd'];

/** Concrete values for those flags, so the doc's names can be fed to the real CLI. */
const DOC_FLAG_VALUES = {
  '--status': 'PASS',
  '--command': '/verify: doc-pinned invocation',
  '--session': SID,
};

/** `commands/verify.md`, newline-normalized (the file is CRLF in the worktree). */
function verifyDoc() {
  return readFileSync(path.join(PLUGIN_ROOT, 'commands', 'verify.md'), 'utf-8')
    .replace(/\r\n/g, '\n');
}

/** How many times `needle` occurs in `haystack`. */
function countOf(haystack, needle) {
  return haystack.split(needle).length - 1;
}

describe('record-verify: the prose in commands/verify.md', () => {
  it('spells the invocation exactly once, and only in a numbered step', () => {
    const doc = verifyDoc();

    // Exactly once: two copies drift, and a model told twice records twice.
    expect(countOf(doc, DOC_CALL)).toBe(1);
    // The resolution chain is pinned too. Without this, reverting `REC=` to the
    // bare relative path — which resolves only inside this repository — passes.
    expect(countOf(doc, DOC_LINE)).toBe(1);
    // And no SECOND, differently-worded invocation anywhere. Measured
    // 2026-09-21: `node ` occurs exactly once in this document, which makes it
    // a usable discriminator; a future doc that runs some other node script
    // will need a narrower one.
    expect(countOf(doc, 'node ')).toBe(1);

    const execution = doc.indexOf('## Execution Flow');
    const step5 = doc.indexOf('**Step 5 - Record**');
    const report = doc.indexOf('4. **Report**');
    const behavior = doc.indexOf('## Pipeline Behavior');
    const call = doc.indexOf(DOC_CALL);
    for (const [label, at] of Object.entries({ execution, step5, report, behavior, call })) {
      expect(at, `${label} must be present in commands/verify.md`).toBeGreaterThan(-1);
    }
    // The whole point of the limb: the call is a numbered STEP, not a bullet
    // under Pipeline Behavior that a model reads as commentary. `report` is the
    // UPPER bound — without it, moving the call into a paragraph after
    // `4. **Report**` still precedes Pipeline Behavior and still passes.
    expect(execution).toBeLessThan(step5);
    expect(step5).toBeLessThan(call);
    expect(call).toBeLessThan(report);
    expect(report).toBeLessThan(behavior);
  });

  it('leaves no invocation behind in the Pipeline Behavior section', () => {
    const doc = verifyDoc();
    const start = doc.indexOf('## Pipeline Behavior');
    expect(start).toBeGreaterThan(-1);
    const rest = doc.slice(start + '## Pipeline Behavior'.length);
    const end = rest.indexOf('\n## ');
    expect(end, 'Pipeline Behavior must be followed by another section').toBeGreaterThan(-1);
    const section = rest.slice(0, end);

    // A prose reminder that Step 5 still runs is allowed; a second copy of the
    // script's name means a second invocation is being described.
    expect(countOf(section, 'record-verify.mjs')).toBe(0);
    expect(countOf(section, 'node ')).toBe(0);
  });

  it('names --cwd, and every flag it names is one the real CLI accepts', () => {
    const doc = verifyDoc();
    expect(countOf(doc, DOC_CALL)).toBe(1);

    const flags = DOC_CALL.match(/--[a-z][a-z-]*/g) ?? [];
    // CARDINALITY ANCHOR. Without this the run below could iterate an empty
    // flag list and pass while the doc named nothing at all.
    expect(flags).toEqual(DOC_FLAGS);
    expect(flags).toContain('--cwd');

    const root = makeRoot('DOC');
    const args = [];
    for (const flag of flags) {
      args.push(flag, flag === '--cwd' ? root : DOC_FLAG_VALUES[flag]);
    }
    expect(args).toHaveLength(flags.length * 2);

    const out = runCli(args, root);

    // A flag the doc invented would be rejected as an unknown argument (exit 2),
    // which is precisely the drift a wording-only pin cannot see.
    expect(out.stderr).toBe('');
    expect(out.status).toBe(0);
    const printed = JSON.parse(out.stdout);
    expect(printed.recorded).toBe(true);
    expect(printed.appended).toBe(4);
    expect(verifyLinesIn(root)).toHaveLength(4);
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
