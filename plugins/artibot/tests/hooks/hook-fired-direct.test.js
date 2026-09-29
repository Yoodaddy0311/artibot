/**
 * OB-24 / R1 `ob24-direct-hook-carrier` -- the hooks registered DIRECTLY in
 * `hooks/hooks.json` record a `hook.fired` row, one per firing. This is the
 * SPAWNED half: every registration is run as a real child process. The in-process
 * half (slot allowlist, envelope, snapshot, recording switch, repo finder, no
 * spawn) is `hook-fired-direct-unit.test.js`; shared plumbing is
 * `tests/helpers/hook-fired-harness.js`.
 *
 * WHY THIS SUITE EXISTS. `lib/replay/existence-audit.js#CARRIERS.hooks` reads
 * `hook.fired.data.hooks`, which only the six dispatchers wrote. The hooks that
 * `hooks/hooks.json` registers directly (measured below: 24 registrations, 21
 * distinct scripts) ran outside any dispatcher, so a `fired: 0` for one of them
 * was a silence nobody was listening for. Each now taps its parsed payload
 * through `_main-entry.js#tapDirectFiring`, which hands the firing to
 * `_hook-fired-record.js#recordDirectHookFired`.
 *
 * WHAT IS PINNED
 *   1. REGISTRY: the 24/21/10 figures and the five scripts on BOTH paths are
 *      measured from `hooks.json` + `dispatch-table.json` and pinned.
 *   2. WIRING: exactly the direct scripts tap, nothing else does (both ways).
 *   3. BYTES UNCHANGED: each registration runs twice from a fresh sandbox with
 *      the same payload, recorder off (`ARTIBOT_HOOK_FIRED_DIRECT=off`) then on;
 *      exit code, stdout and stderr must match after path normalisation, and a
 *      PreToolUse passthrough must emit ZERO stdout bytes. Exactly one row.
 *   4. NO DOUBLE COUNT: five scripts are dispatcher handlers AND direct hooks
 *      (`pre-write-guard`, `tool-tracker`, `memory-tracker`, `subagent-handler`,
 *      `workflow-status`). A dispatcher spawns the SAME script with the SAME
 *      payload, so only `hook_event_name` tells them apart: the direct path is an
 *      allowlist of the ten host events with no dispatcher, so a dispatched child
 *      writes nothing. The end-to-end half lives in `tests/dispatcher/*`, which
 *      assert exactly one `hook.fired` row per real dispatch with these scripts
 *      as real children.
 *   5. FAIL-SILENT: no session id, no `hook_event_name`, a dispatcher slot, no
 *      repository, an unwritable ledger, unparsable stdin: no row, exit 0, and
 *      nothing on stdout or stderr. Each negative has a positive control.
 *   6. LINKED WORKTREE: the layout every `/split` limb runs in (`.git` is a
 *      FILE) writes to the shared central ledger, like a dispatcher row.
 *   7. THE RUNNER DEFAULT: a child that inherits `VITEST` records nothing unless
 *      told `on` (35 existing tests assert the exact ledger their hooks leave).
 *
 * WHAT THIS SUITE CANNOT SEE (rules section 9 -- read a green run as no more)
 *   - REAL HOST PAYLOADS FOR EIGHT OF THE TEN EVENTS. `hook_event_name` is
 *     measured live for PreToolUse and SubagentStart (and for three dispatcher
 *     events) in `tests/hooks/fixtures/host-payloads/`. PreCompact, PostCompact,
 *     TeammateIdle, TaskCompleted, PermissionRequest, PostToolUseFailure,
 *     Notification and InstructionsLoaded are documented but NOT frozen from a
 *     live host, so the payloads below are synthesised. A host that omitted the
 *     key on one of them would write no row for it (fail-closed), and only a
 *     live probe would show that.
 *   - LATENCY. Nothing here times anything; the cost of loading the ledger
 *     writer in every hook process is measured by hand and reported.
 *   - VOLUME. One row per firing roughly doubles the daily `hook.fired` line
 *     count; that is a fact about the live ledger, not about this code.
 *   - THE CLI INVENTORY. `scripts/ledger/existence-audit.mjs` still leaves the
 *     direct hooks out of `kinds.hooks` and lists them under
 *     `hooksOutsideCarrier`; the audit test at the bottom feeds the fold an
 *     inventory that names them, which is what the CLI would have to do.
 *   - A HOOK THAT THROWS THROUGH AN `exit: true` TAIL. The tap fires right
 *     after the payload parses, but the row lands when the writer finishes
 *     loading; a tail that calls `process.exit(0)` first can cut it. Not
 *     pinned, because the outcome is a race.
 *
 * @module tests/hooks/hook-fired-direct
 */

import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  DISPATCHED_SCRIPTS, DISPATCHER_SLOTS, DISTINCT_SCRIPTS, ENTRIES, firedRows, HOOKS_DIR, HOOKS_JSON,
  ledgerLines, makeLinkedWorktree, makeSandbox, PER_EVENT, removeSandboxes, runScript,
} from '../helpers/hook-fired-harness.js';
import { buildExistenceAudit, CARRIERS, foldFiredCounts } from '../../lib/replay/existence-audit.js';
import { ledgerFilePath, readAllEvents } from '../../lib/runtime/ledger.js';

afterEach(removeSandboxes);

describe('registry: the direct registrations, measured from hooks.json', () => {
  it('finds 24 direct registrations over 21 distinct scripts (six commands go through dispatchers)', () => {
    const all = Object.values(HOOKS_JSON.hooks).flat().flatMap((g) => g.hooks).length;
    expect(all).toBe(30);
    expect(ENTRIES).toHaveLength(24);
    expect(DISTINCT_SCRIPTS).toHaveLength(21);
  });

  it('spreads them over ten host events, none of which has a dispatcher', () => {
    expect(PER_EVENT).toEqual({
      PreToolUse: 9,
      PreCompact: 1,
      PostCompact: 1,
      SubagentStart: 2,
      TeammateIdle: 2,
      TaskCompleted: 2,
      PermissionRequest: 1,
      PostToolUseFailure: 3,
      Notification: 2,
      InstructionsLoaded: 1,
    });
    expect(DISPATCHER_SLOTS).toEqual(['PostToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'SubagentStop', 'UserPromptSubmit']);
    for (const event of Object.keys(PER_EVENT)) expect(DISPATCHER_SLOTS).not.toContain(event);
  });

  it('has five scripts on BOTH paths: the double-count risk this change has to defuse', () => {
    const both = DISTINCT_SCRIPTS.filter((s) => DISPATCHED_SCRIPTS.has(s)).map((s) => s.replace(/\.js$/, ''));
    expect(both.sort()).toEqual(['memory-tracker', 'pre-write-guard', 'subagent-handler', 'tool-tracker', 'workflow-status']);
  });
});

describe('wiring: exactly the direct scripts tap their payload', () => {
  const TAP_CALL = /tapDirectFiring\(import\.meta\.url,/g;

  it.each(DISTINCT_SCRIPTS)('%s imports the tap from _main-entry.js and calls it once', (script) => {
    const src = readFileSync(path.join(HOOKS_DIR, script), 'utf-8');
    expect(src).toMatch(/import \{[^}]*\btapDirectFiring\b[^}]*\} from '\.\/_main-entry\.js'/);
    expect(src.match(TAP_CALL) ?? []).toHaveLength(1);
  });

  it('no other script under scripts/hooks taps (allowlist in both directions)', () => {
    const tapping = readdirSync(HOOKS_DIR)
      .filter((f) => /\.m?js$/.test(f) && f !== '_main-entry.js')
      .filter((f) => /tapDirectFiring\(/.test(readFileSync(path.join(HOOKS_DIR, f), 'utf-8')))
      .sort();
    expect(tapping).toEqual(DISTINCT_SCRIPTS);
  });
});

/**
 * POSITIVE CONTROL for every "wrote nothing" assertion. A negative result is
 * only evidence if the same sandbox, environment and spawn path DO record when
 * the payload is good; without this a broken recorder would pass every
 * fail-silent case for free. Runs pre-bash on a well-formed PreToolUse payload
 * and expects exactly one new row.
 */
function expectRecorderAlive(sb) {
  const before = firedRows(sb).length;
  const control = {
    session_id: randomUUID(),
    transcript_path: path.join(sb.root, 'transcript.jsonl'),
    cwd: sb.repo,
    permission_mode: 'default',
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'echo control' },
    tool_use_id: 'toolu_r1_control',
  };
  const out = runScript(sb, 'pre-bash.js', [], JSON.stringify(control), { ARTIBOT_HOOK_FIRED_DIRECT: 'on' });
  expect(out.status, `control run (stderr: ${out.stderr.slice(0, 200)})`).toBe(0);
  const rows = firedRows(sb);
  expect(rows, 'the positive control must record, or the silence above proves nothing').toHaveLength(before + 1);
  expect(rows.at(-1).data.hooks).toEqual(['pre-bash']);
}

/**
 * The one PreToolUse registration whose OWN output is not a passthrough:
 * `webfetch-cache-pre` reports a cache verdict as `{continue:true,
 * hookSpecificOutput:{additionalContext}}` -- informational, no decision, and
 * not part of `pretooluse-passthrough.test.js`. Every other PreToolUse
 * registration is held to zero bytes; a new one is strict until someone decides.
 */
const INFORMATIONAL_PRETOOLUSE = new Set(['webfetch-cache-pre.js']);

/** Make two sandboxes' outputs comparable: their own paths and clocks are the only permitted difference. */
function normalise(text, sb) {
  const roots = [sb.root, sb.root.replace(/\\/g, '/'), sb.root.replace(/\\/g, '\\\\')];
  let out = text;
  for (const r of roots) out = out.split(r).join('<SB>');
  return out
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, '<TS>')
    .replace(/\b1[67]\d{11}\b/g, '<MS>');
}

/**
 * One realistic payload per host event (synthesised -- see the header).
 *
 * @param {{event: string, matcher: string}} e a direct registration
 * @param {{repo: string, root: string}} sb
 * @param {string} sessionId
 */
function payloadFor(e, sb, sessionId) {
  const common = {
    session_id: sessionId,
    transcript_path: path.join(sb.root, 'transcript.jsonl'),
    cwd: sb.repo,
    permission_mode: 'default',
    hook_event_name: e.event,
  };
  const bash = { tool_name: 'Bash', tool_input: { command: 'echo hello' } };
  const mate = { teammate_name: 'r1-mate', team_name: 'r1-team' };
  switch (e.event) {
    case 'PreToolUse': {
      const byMatcher = {
        Bash: { ...bash, tool_use_id: 'toolu_r1_bash' },
        Agent: {
          prompt_id: 'r1-prompt',
          tool_name: 'Agent',
          tool_input: { description: 'Summarise the repo', prompt: 'Reply ok.', subagent_type: 'general-purpose' },
          tool_use_id: 'toolu_r1_agent',
        },
        WebFetch: { tool_name: 'WebFetch', tool_input: { url: 'https://example.com/', prompt: 'summarise' }, tool_use_id: 'toolu_r1_fetch' },
      };
      const write = {
        tool_name: 'Write',
        tool_input: { file_path: path.join(sb.repo, 'src', 'new-file.js'), content: 'const b = 2;\n' },
        tool_use_id: 'toolu_r1_write',
      };
      return { ...common, ...(byMatcher[e.matcher] ?? write) };
    }
    case 'PreCompact': return { ...common, trigger: 'manual', custom_instructions: '' };
    case 'PostCompact': return { ...common, trigger: 'manual', compact_summary: 'r1 summary' };
    case 'SubagentStart': return { ...common, prompt_id: 'r1-prompt', agent_id: 'agent-r1', agent_type: 'general-purpose' };
    case 'TeammateIdle': return { ...common, ...mate };
    case 'TaskCompleted': return { ...common, ...mate, task_id: '1', task_subject: 'r1 task' };
    case 'PermissionRequest': return { ...common, ...bash };
    case 'PostToolUseFailure':
      return {
        ...common,
        tool_name: 'Bash',
        tool_input: { command: 'false' },
        tool_use_id: 'toolu_r1_fail',
        error: 'Command exited with non-zero status code 1',
        is_interrupt: false,
      };
    case 'Notification': return { ...common, message: 'r1 needs attention', notification_type: 'idle_prompt' };
    case 'InstructionsLoaded':
      return { ...common, file_path: path.join(sb.repo, 'CLAUDE.md'), memory_type: 'Project', load_reason: 'session_start' };
    default:
      throw new Error(`no payload builder for host event ${e.event}: add one, do not skip the hook`);
  }
}

/** Run one direct registration from a fresh sandbox; returns the outputs and the rows it left. */
function runEntry(e, extraEnv) {
  const sb = makeSandbox(e.stem);
  const input = JSON.stringify(payloadFor(e, sb, `r1-${e.stem}-sess-0001`));
  const out = runScript(sb, e.script, e.args, input, extraEnv);
  return { sb, out, rows: firedRows(sb), all: ledgerLines(sb) };
}

describe('live: each direct registration records exactly one row and leaves its bytes alone', () => {
  it.each(ENTRIES.map((e) => [e.label, e]))('%s', (_label, e) => {
    const off = runEntry(e, { ARTIBOT_HOOK_FIRED_DIRECT: 'off' });
    const on = runEntry(e, { ARTIBOT_HOOK_FIRED_DIRECT: 'on' });

    // The control really is off, so the row below comes from the tap and nothing else.
    expect(off.rows, `${e.label}: the off switch must silence the tap`).toEqual([]);

    // Bytes and exit code are the hook's own, recording on or off.
    expect(on.out.status, `${e.label}: exit code (stderr: ${on.out.stderr.slice(0, 300)})`).toBe(off.out.status);
    expect(on.out.status).toBe(0);
    expect(normalise(on.out.stdout, on.sb), `${e.label}: stdout`).toBe(normalise(off.out.stdout, off.sb));
    expect(normalise(on.out.stderr, on.sb), `${e.label}: stderr`).toBe(normalise(off.out.stderr, off.sb));
    if (e.event === 'PreToolUse' && !INFORMATIONAL_PRETOOLUSE.has(e.script)) {
      expect(on.out.stdout, `${e.label}: a PreToolUse passthrough is ZERO bytes`).toBe('');
    }

    // Exactly one row, naming this hook, in this event's slot.
    expect(on.rows, `${e.label}: hook.fired rows (stderr: ${on.out.stderr.slice(0, 300)})`).toHaveLength(1);
    const [row] = on.rows;
    expect(row.data.hooks).toEqual([e.stem]);
    expect(row.data.slot).toBe(e.event);
    expect(row.data.count).toBe(1);
    expect(row.data.failed).toEqual([]);
    expect(row.session_id).toBe(`r1-${e.stem}-sess-0001`);
    expect(row.source).toBe('hook');
    // A rejection is also a written line, so a row the writer refused would still add one.
    // Only rejections that name hook.fired are this change's; another writer's are not.
    expect(
      on.all.filter((l) => l.event === 'ledger.rejected' && JSON.stringify(l).includes('hook.fired')),
      `${e.label}: the writer rejected the hook.fired row`,
    ).toEqual([]);
  });
});

describe('no double count: a dispatcher child writes nothing of its own', () => {
  /** The exact invocation a dispatcher makes: same script, same args, the slot's payload on stdin. */
  const DISPATCHED = [
    ['pre-write-guard.js', [], 'PostToolUse', { tool_name: 'Read', tool_input: { file_path: 'src/existing.js' }, tool_use_id: 'toolu_r1_read' }],
    ['tool-tracker.js', [], 'PostToolUse', { tool_name: 'Bash', tool_input: { command: 'echo hello' }, tool_response: { stdout: 'hello' }, tool_use_id: 'toolu_r1_pb' }],
    ['subagent-handler.js', ['stop'], 'SubagentStop', { agent_id: 'agent-r1', agent_type: 'general-purpose', stop_hook_active: false }],
    ['workflow-status.js', ['teammate-update'], 'SubagentStop', { agent_id: 'agent-r1', agent_type: 'general-purpose' }],
    ['memory-tracker.js', ['SessionStart'], 'SessionStart', { source: 'startup' }],
    ['memory-tracker.js', ['SessionEnd'], 'SessionEnd', { reason: 'other' }],
  ];

  it.each(DISPATCHED.map((d) => [`${d[0]} ${d[1].join(' ')} as a ${d[2]} child`.replace('  ', ' '), d]))(
    '%s: zero rows',
    (_label, [script, args, slot, extra]) => {
      expect(DISPATCHER_SLOTS).toContain(slot);
      const sb = makeSandbox(`dual-${script.replace('.js', '')}`);
      const input = JSON.stringify({
        session_id: randomUUID(),
        transcript_path: path.join(sb.root, 'transcript.jsonl'),
        cwd: sb.repo,
        permission_mode: 'default',
        hook_event_name: slot,
        ...extra,
      });
      const out = runScript(sb, script, args, input, { ARTIBOT_HOOK_FIRED_DIRECT: 'on' });
      expect(out.status).toBe(0);
      expect(firedRows(sb), 'the dispatcher, not the child, owns this slot\'s row').toEqual([]);
      expectRecorderAlive(sb);
    },
  );

  it('the dispatcher forwards the host payload to its children unchanged, hook_event_name included', async () => {
    // The child can only refuse a dispatched run if it sees the slot name. Prove
    // the forwarding half with the real spawn helper and a probe that echoes stdin.
    const { spawnHook } = await import(pathToFileURL(path.join(HOOKS_DIR, '_dispatcher-utils.js')).href);
    const sb = makeSandbox('forward');
    const probe = path.join(sb.root, 'echo-stdin.mjs');
    writeFileSync(probe, "process.stdin.on('data', (c) => process.stdout.write(c));\n", 'utf-8');
    const sent = { hook_event_name: 'PostToolUse', session_id: randomUUID(), cwd: sb.repo, tool_name: 'Read' };
    const got = await spawnHook(probe, sent, { name: 'probe', timeoutMs: 20_000 });
    expect(got.status).toBe('ok');
    expect(JSON.parse(got.stdout)).toEqual(sent);
  });
});

describe('fail-silent: an unrecordable firing writes nothing and changes nothing', () => {
  const on = { ARTIBOT_HOOK_FIRED_DIRECT: 'on' };
  const good = (sb, over = {}) => ({
    session_id: randomUUID(),
    transcript_path: path.join(sb.root, 'transcript.jsonl'),
    cwd: sb.repo,
    permission_mode: 'default',
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'echo hello' },
    tool_use_id: 'toolu_r1_silent',
    ...over,
  });

  it.each([
    ['no session_id', { session_id: undefined }],
    ['no hook_event_name', { hook_event_name: undefined }],
    ['a dispatcher slot as hook_event_name', { hook_event_name: 'PostToolUse' }],
    ['an unknown hook_event_name', { hook_event_name: 'FutureHostEvent' }],
    ['no cwd', { cwd: undefined }],
  ])('pre-bash with %s: exit 0, zero bytes on stdout and stderr, no row', (_label, over) => {
    const sb = makeSandbox('silent');
    const out = runScript(sb, 'pre-bash.js', [], JSON.stringify(good(sb, over)), on);
    expect(out).toEqual({ status: 0, stdout: '', stderr: '' });
    expect(firedRows(sb)).toEqual([]);
    expectRecorderAlive(sb);
  });

  it('pre-bash on unparsable stdin: exit 0, no row, nothing recorded for a payload that never parsed', () => {
    const sb = makeSandbox('silent');
    const out = runScript(sb, 'pre-bash.js', [], '{"truncated":', on);
    expect(out.status).toBe(0);
    expect(firedRows(sb)).toEqual([]);
    expectRecorderAlive(sb);
  });

  it('pre-bash with a cwd that has no repository above it: no row, no directory created, no stderr', () => {
    const sb = makeSandbox('silent');
    const bare = path.join(sb.root, 'not-a-repo');
    mkdirSync(bare);
    const before = readdirSync(bare);
    const out = runScript(sb, 'pre-bash.js', [], JSON.stringify(good(sb, { cwd: bare })), on, bare);
    expect(out).toEqual({ status: 0, stdout: '', stderr: '' });
    expect(readdirSync(bare)).toEqual(before);
    expect(firedRows(sb)).toEqual([]);
    expectRecorderAlive(sb);
  });

  it('pre-bash with an unwritable ledger: same exit and bytes as a healthy run, no row', () => {
    const healthy = makeSandbox('healthy');
    const blocked = makeSandbox('blocked');
    // A FILE where the ledger's parent directory must go makes every append fail.
    writeFileSync(path.dirname(ledgerFilePath(blocked.repo)), 'not a directory', 'utf-8');
    const a = runScript(healthy, 'pre-bash.js', [], JSON.stringify(good(healthy)), on);
    const b = runScript(blocked, 'pre-bash.js', [], JSON.stringify(good(blocked)), on);
    expect(b.status).toBe(a.status);
    expect(b.status).toBe(0);
    expect(b.stdout).toBe(a.stdout);
    expect(b.stderr).toBe(a.stderr);
    expect(firedRows(healthy)).toHaveLength(1);
    expect(existsSync(ledgerFilePath(blocked.repo))).toBe(false);
  });

  it('in a linked worktree (.git is a FILE) the row lands in the shared central ledger, like a dispatcher row', () => {
    const sb = makeSandbox('linked');
    const wt = makeLinkedWorktree(sb);
    expect(ledgerFilePath(wt)).toBe(ledgerFilePath(sb.repo));

    const out = runScript(sb, 'pre-bash.js', [], JSON.stringify(good(sb, { cwd: wt })), on, wt);
    expect(out).toEqual({ status: 0, stdout: '', stderr: '' });
    expect(firedRows(sb)).toHaveLength(1);
    expect(existsSync(path.join(wt, '.artibot'))).toBe(false);
  });

  it('the off switch is exact: only the literal "off" silences the tap (child scrubbed of VITEST, like production)', () => {
    const sb = makeSandbox('switch');
    const input = JSON.stringify(good(sb));
    for (const value of ['0', 'false', 'OFF', 'no', '']) {
      const out = runScript(sb, 'pre-bash.js', [], input, { ARTIBOT_HOOK_FIRED_DIRECT: value });
      expect(out.status).toBe(0);
    }
    // Five other spellings all left the recorder on: five rows, none silenced.
    expect(firedRows(sb)).toHaveLength(5);
  });

  it('inside the vitest runner the tap is inert by default, and only "on" overrides that', () => {
    const sb = makeSandbox('runner');
    const input = JSON.stringify(good(sb));
    // The harness scrubs VITEST from every child; put it back to emulate a hook spawned BY a test.
    const inert = runScript(sb, 'pre-bash.js', [], input, { VITEST: 'true' });
    expect(inert).toEqual({ status: 0, stdout: '', stderr: '' });
    expect(firedRows(sb)).toEqual([]);
    const forced = runScript(sb, 'pre-bash.js', [], input, { VITEST: 'true', ARTIBOT_HOOK_FIRED_DIRECT: 'on' });
    expect(forced.status).toBe(0);
    expect(firedRows(sb)).toHaveLength(1);
  });
});

describe('existence audit: a direct hook is counted, not read as a false zero', () => {
  it('folds three real firings into per-hook counts and keeps a silent hook at a measured zero', () => {
    const sb = makeSandbox('audit');
    const sid = randomUUID();
    const bash = { session_id: sid, cwd: sb.repo, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo hello' } };
    const write = { session_id: sid, cwd: sb.repo, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(sb.repo, 'src', 'a.js'), content: 'x' } };
    const on = { ARTIBOT_HOOK_FIRED_DIRECT: 'on' };
    runScript(sb, 'pre-bash.js', [], JSON.stringify({ ...bash, tool_use_id: 'toolu_r1_a1' }), on);
    runScript(sb, 'pre-bash.js', [], JSON.stringify({ ...bash, tool_use_id: 'toolu_r1_a2' }), on);
    runScript(sb, 'pre-write.js', [], JSON.stringify({ ...write, tool_use_id: 'toolu_r1_a3' }), on);

    const events = readAllEvents(sb.repo);
    expect(foldFiredCounts(events, CARRIERS.hooks)).toEqual({
      counts: { 'pre-bash': 2, 'pre-write': 1 },
      absent: 0,
      denominator: 3,
    });
    const audit = buildExistenceAudit(events, { inventory: { hooks: ['clean-state-check', 'pre-bash', 'pre-write'] } });
    const byName = Object.fromEntries(audit.kinds.hooks.entries.map((h) => [h.name, [h.fired, h.measured]]));
    expect(byName).toEqual({
      'clean-state-check': [0, true],
      'pre-bash': [2, true],
      'pre-write': [1, true],
    });
  });
});
