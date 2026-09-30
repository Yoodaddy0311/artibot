/**
 * OB-24 / R1 follow-up (review R1 SHOULD 2, 2026-09-30) -- the DENY-branch byte pin.
 *
 * WHAT WAS MISSING. `hook-fired-direct.test.js` runs each of the 24 direct
 * registrations twice, recorder off and then on, and requires the same exit code,
 * stdout and stderr. But each run gets ONE realistic payload and that payload is
 * benign, so for a PreToolUse guard the bytes being compared are its PASSTHROUGH:
 * zero of them (that file even asserts it: "a PreToolUse passthrough is ZERO
 * bytes"). The branch a guard exists for, the one that writes a `block`
 * decision, was never run with the tap switched on. Measured 2026-09-30:
 * `grep -in deny` over `hook-fired-direct.test.js`, `hook-fired-direct-unit.test.js`,
 * `hook-fired-direct-marker.test.js` and `tests/helpers/hook-fired-harness.js`
 * prints nothing, and no payload in that suite holds a command a guard blocks.
 * A tap that put a byte on stdout, or changed the exit code, only when the guard
 * DENIES would have left every test there green.
 *
 * WHAT IS PINNED, for `bash-risk-guard.js` (a directly registered PreToolUse guard
 * whose `danger` branch writes `{decision:'block', reason}`), once per rule family:
 *   1. The control arm (recording off) really denies: a parsable block document
 *      that names the matched rule and echoes the command, exactly as
 *      `JSON.stringify` writes it. A pin over two EMPTY outputs would prove nothing.
 *   2. Recording ON, FIRST firing of the session-day (the writer loads, one row is
 *      appended, the marker is claimed): exit code, stdout and stderr equal the
 *      control arm's, byte for byte, with NO path normalisation. The deny document
 *      holds no sandbox path, so a path appearing in it would itself be a finding.
 *   3. Recording ON, SECOND firing (the marker exists: the writer is never
 *      loaded): the same bytes again. Production spends nearly all its firings on
 *      this path, so pinning only the first one would leave it unmeasured.
 *   4. The recorder was alive in the arms compared: exactly one `hook.fired` row
 *      and one marker after the first ON firing, nothing added by the second, and
 *      nothing at all in the control arm. Without this, "identical" could mean
 *      "the tap never ran".
 *   5. The comparison can fail: its own self-check reports a one-byte difference
 *      on each of the three channels.
 *
 * WHY `bash-risk-guard.js`. Its `danger` branch writes the decision AFTER an
 * awaited dynamic import (`recordDangerForActiveSession`), so the tap's own
 * pending imports run concurrently with the guard's last async step before
 * `writeStdout`. A passthrough has no async step after the tap and cannot show
 * that interleaving; this branch can. `pre-write-guard.js` is another lane's.
 *
 * WHAT THIS FILE CANNOT SEE (rules section 9 -- read a green run as no more)
 *   - ONE GUARD. `pre-bash.js`, `git-autopilot-guard.js` and the rest call the
 *     tap through the same line, and that line does not know which guard it is
 *     in, but that is an inference from the code, not a measurement of them.
 *   - THE ORDER OF THE WRITES. Only the bytes and the exit code are compared. Whether
 *     the decision reaches stdout before the row reaches the ledger is not pinned
 *     here (for this guard it is not even fixed: see above).
 *   - A REAL HOST. The payload is synthesised: its PreToolUse envelope keys are the
 *     ones frozen from a live host for the Agent matcher
 *     (`tests/hooks/fixtures/host-payloads/PreToolUse.Agent.json`, key names only),
 *     while the Bash `tool_input.command` shape is not frozen there. And the host
 *     never reads the bytes written here.
 *   - THE `exit: true` TAIL RACE, and real parallelism between two first
 *     firings: not pinned, because the outcome is a race (see the sibling files).
 *
 * @module tests/hooks/hook-fired-direct-deny
 */

import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';

import {
  firedRows, makeSandbox, markerFiles, removeSandboxes, runScript,
} from '../helpers/hook-fired-harness.js';

afterEach(removeSandboxes);

const GUARD = 'bash-risk-guard.js';
const HOOK_NAME = 'bash-risk-guard';
const SESSION = 'r1-deny-sess-0001';

/**
 * [label, command, rule id]. A command is only TEXT in `tool_input.command`: the
 * guard classifies it and never runs it. Three different rule families, so the
 * pin does not ride on one regex.
 */
const DENIED = [
  ['rm -rf on the filesystem root', 'rm -rf /', 'rm-rf-root'],
  ['a SQL table drop', 'psql -c "DROP TABLE users;"', 'sql-drop-table'],
  ['a force push', 'git push --force origin main', 'git-force-push'],
];

/** The PreToolUse payload a host sends for a Bash call, for one command. */
function denyPayload(sb, command) {
  return JSON.stringify({
    session_id: SESSION,
    transcript_path: path.join(sb.root, 'transcript.jsonl'),
    cwd: sb.repo,
    permission_mode: 'default',
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command },
    tool_use_id: 'toolu_r1_deny',
  });
}

/** Run the guard once, exactly as the host would, with the recorder `on` or `off`. */
function runGuard(sb, command, mode) {
  return runScript(sb, GUARD, [], denyPayload(sb, command), { ARTIBOT_HOOK_FIRED_DIRECT: mode });
}

/**
 * Every way two runs differ, as readable lines; `[]` means byte-identical on all
 * three channels. Raw comparison: no normalisation, so any path or clock that
 * leaks into a decision is a difference, not noise.
 */
function differences(a, b) {
  const out = [];
  if (a.status !== b.status) out.push(`exit code ${a.status} vs ${b.status}`);
  if (a.stdout !== b.stdout) out.push(`stdout ${JSON.stringify(a.stdout)} vs ${JSON.stringify(b.stdout)}`);
  if (a.stderr !== b.stderr) out.push(`stderr ${JSON.stringify(a.stderr)} vs ${JSON.stringify(b.stderr)}`);
  return out;
}

describe('the deny branch of a direct guard is byte-identical with the tap on and off', () => {
  it.each(DENIED)('%s: off, on (first firing) and on (marker present) write the same block', (_label, command, ruleId) => {
    const offSb = makeSandbox('deny-off');
    const onSb = makeSandbox('deny-on');

    const off = runGuard(offSb, command, 'off');
    const first = runGuard(onSb, command, 'on');
    const rowsAfterFirst = firedRows(onSb);
    const markersAfterFirst = markerFiles(onSb);
    const second = runGuard(onSb, command, 'on');

    // 1. The control arm really denies, and says what it denied.
    expect(off.status, `control exit (stderr: ${off.stderr.slice(0, 200)})`).toBe(0);
    const doc = JSON.parse(off.stdout);
    expect(doc.decision).toBe('block');
    expect(doc.reason).toContain(`(matched: ${ruleId})`);
    expect(doc.reason).toContain(`Command: "${command}"`);
    expect(off.stdout, 'the exact serialisation: compact JSON, no trailing newline').toBe(JSON.stringify(doc));
    expect(off.stderr).toBe('');

    // 2 + 3. The same bytes, exit code and stderr with the tap on, on both of its paths.
    expect(differences(off, first), 'first firing of the session-day').toEqual([]);
    expect(differences(off, second), 'second firing: the marker exists').toEqual([]);

    // 4. The recorder was alive where it was compared, and silent where it was not.
    expect(rowsAfterFirst, 'the first ON firing must append its row').toHaveLength(1);
    expect(rowsAfterFirst[0].data).toMatchObject({ slot: 'PreToolUse', hooks: [HOOK_NAME], count: 1, failed: [] });
    expect(rowsAfterFirst[0].session_id).toBe(SESSION);
    expect(markersAfterFirst, 'and claim the marker').toHaveLength(1);
    expect(firedRows(onSb), 'the second ON firing adds no row').toHaveLength(1);
    expect(markerFiles(onSb), 'and no marker').toEqual(markersAfterFirst);
    expect(firedRows(offSb), 'the control arm records nothing').toEqual([]);
    expect(markerFiles(offSb), 'and claims nothing').toEqual([]);
  });

  it('the comparison can fail: one byte on stdout, one on stderr or another exit code is each reported', () => {
    const base = { status: 0, stdout: '{"decision":"block","reason":"x"}', stderr: '' };
    expect(differences(base, { ...base })).toEqual([]);
    expect(differences(base, { ...base, stdout: `${base.stdout}\n` })).toHaveLength(1);
    expect(differences(base, { ...base, stdout: base.stdout.replace('block', 'blocK') })).toHaveLength(1);
    expect(differences(base, { ...base, stderr: 'x' })).toHaveLength(1);
    expect(differences(base, { ...base, status: 1 })).toHaveLength(1);
    expect(differences(base, { status: 1, stdout: '', stderr: 'x' })).toHaveLength(3);
  });
});
