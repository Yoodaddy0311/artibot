/**
 * A SubagentStart for an agent id that is already registered - the host resuming a
 * teammate for another turn, or redelivering the hook - must not wipe the policy
 * columns the first START bound.
 *
 * WHY THIS EXISTS. `handleStart` replaces the whole `agents[id]` entry, and a resume
 * START cannot recompute those columns: `bindRoute` answers `skipped:already-bound`
 * before it looks at a receipt, and a teammate's `agent_type` is its NAME, which no
 * policy lists. So the entry went from `canonicalModel: "opus"` to null on the second
 * START, the next STOP read that null back, and the served-versus-policy flag
 * (`servedFields`) had no policy tier to compare against. Measured 2026-10-13 on this
 * repo's spawn ledger: 335 of 814 agent ids have 2 or more START rows, and of the 244
 * ids whose first START recorded a `canonicalModel`, 231 have a later START row where
 * it is null. The state entry of the agent that wrote this fix read null the same way.
 *
 * WHAT IS PINNED HERE
 *   - `carryPolicyColumns` fills a null policy column from the entry being replaced and
 *     never overrides a value the START just computed, never crosses to another
 *     `agentType`, and invents nothing.
 *   - The hook, as a child process: a resumed named spawn keeps its tier on the state
 *     entry and on the START row, still says `skipped:already-bound`, and the next STOP
 *     reads `servedDrift` against that tier. A spawn that never had a tier stays null.
 *   - A RESUME BINDS NOTHING, WINDOW OR NO WINDOW. The state entry (same id AND same agent
 *     type, `isSameRegisteredAgent`) decides, so the START says `skipped:already-bound` also
 *     after the first bind line has left the 128 KB ledger window (the ledger is padded
 *     below and the window re-read with `readLedgerTail` to prove it), writes no second
 *     `route.bound`, and leaves a sibling's pending receipt to the sibling. Before this rule
 *     such a START took that receipt by FIFO: the live ledger holds 4 agent ids with two or
 *     more `route.bound` lines (doctor Check 10 `agent_bound_twice`, 5 conflicts). The same
 *     id under ANOTHER agent type is another spawn and binds. A state file nobody can read
 *     leaves the decision to the ledger window, as before, and a row no START wrote (the
 *     shape `workflow-status.js` leaves) is not a resume.
 *
 * WHAT THIS FILE DOES NOT PROVE (rules section 9 - the gate's blind spots):
 *   - THAT THE HOST RESUMES WITH THE SAME agent_id AND agent_type. The live evidence is
 *     indirect: one agent id with `start`, `stop`, `start` rows two seconds apart, and
 *     194 `skipped:already-bound` START rows. The payloads below are hand-written.
 *   - THE WINDOW EDGE. The padding is far past the tail; a bind line cut in half by the
 *     window edge, and aging by the 10-minute receipt window instead of by bytes, are not
 *     exercised, and neither matters to a START the state entry already calls a resume.
 *   - A RESUME THE STATE ENTRY DOES NOT KNOW. A finished row is pruned after 7 days
 *     (`_team-state.js#AGENT_RETENTION_MS`), and two teammates the host gives ONE id (a
 *     name cut to a fixed length; 3 START rows in the live spawn ledger) overwrite each
 *     other's row, so only the type the row currently holds is recognised. Both keep the
 *     old behaviour (the bind runs, the window decides), and neither is exercised here.
 *
 * @module tests/hooks/subagent-handler-resume
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../../lib/core/config.js';
import { getModel } from '../../lib/core/model-catalog.js';
import { resolveModel } from '../../lib/core/model-policy.js';
import { readSpawns } from '../../lib/learning/ledger/spawn-ledger.js';
import { ledgerFilePath } from '../../lib/runtime/ledger.js';
import { readLedgerTail } from '../../lib/runtime/ledger-tail.js';
import { isSameRegisteredAgent } from '../../lib/runtime/subagent-spawn-columns.js';
import { carryPolicyColumns } from '../../scripts/hooks/subagent-handler.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '..', '..');
const HOOK = path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'subagent-handler.js');
const PRE_HOOK = path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'route-observe-pre.js');

// ---------------------------------------------------------------------------
// carryPolicyColumns - the rule, unit level
// ---------------------------------------------------------------------------

describe('carryPolicyColumns', () => {
  const NAME = 'team-x-impl';
  const before = { agentType: NAME, canonicalModel: 'opus', recommendedModel: 'claude-opus-5-5', actionClass: 'implement' };
  const NOTHING = { canonicalModel: null, recommendedModel: null, actionClass: null };

  it('POSITIVE CONTROL: a START that computed nothing takes all three columns from the entry it replaces', () => {
    expect(carryPolicyColumns(before, NAME, NOTHING)).toEqual({
      canonicalModel: 'opus', recommendedModel: 'claude-opus-5-5', actionClass: 'implement',
    });
  });

  it('never overrides a column the START just computed', () => {
    const fresh = { canonicalModel: 'sonnet', recommendedModel: null, actionClass: 'review' };
    expect(carryPolicyColumns(before, NAME, fresh)).toEqual({
      canonicalModel: 'sonnet', recommendedModel: 'claude-opus-5-5', actionClass: 'review',
    });
  });

  it('carries column by column: only the null ones are filled', () => {
    const out = carryPolicyColumns(before, NAME, { ...NOTHING, actionClass: 'explore' });
    expect(out).toEqual({ canonicalModel: 'opus', recommendedModel: 'claude-opus-5-5', actionClass: 'explore' });
  });

  it('does not cross to another agentType: a reused id is a different agent', () => {
    expect(carryPolicyColumns(before, 'someone-else', NOTHING)).toEqual(NOTHING);
    expect(carryPolicyColumns({ ...before, agentType: undefined }, NAME, NOTHING)).toEqual(NOTHING);
  });

  it('does not take two missing agentTypes for the same agent', () => {
    // Identity is the only thing that licenses a carry; "both unknown" is not identity.
    expect(carryPolicyColumns({ canonicalModel: 'opus' }, undefined, NOTHING)).toEqual(NOTHING);
    expect(carryPolicyColumns({ agentType: '', canonicalModel: 'opus' }, '', NOTHING)).toEqual(NOTHING);
  });

  it('invents nothing: no entry, or an entry that never had a value, stays null', () => {
    expect(carryPolicyColumns(undefined, NAME, NOTHING)).toEqual(NOTHING);
    expect(carryPolicyColumns({ agentType: NAME }, NAME, NOTHING)).toEqual(NOTHING);
    expect(carryPolicyColumns({ agentType: NAME, canonicalModel: null }, NAME, NOTHING)).toEqual(NOTHING);
  });

  it.each([
    ['a number', 7],
    ['an empty string', ''],
    ['an object', { tier: 'opus' }],
    ['a boolean', true],
  ])('ignores a stored column that is %s', (_label, junk) => {
    const entry = { agentType: NAME, canonicalModel: junk, recommendedModel: junk, actionClass: junk };
    expect(carryPolicyColumns(entry, NAME, NOTHING)).toEqual(NOTHING);
  });

  it.each([undefined, null, 42, 'text', []])('never throws on a previous entry of %j', (previous) => {
    expect(() => carryPolicyColumns(previous, NAME, NOTHING)).not.toThrow();
    expect(carryPolicyColumns(previous, NAME, NOTHING)).toEqual(NOTHING);
  });

  it('a fresh value of the wrong type counts as not computed', () => {
    expect(carryPolicyColumns(before, NAME, { canonicalModel: 7, recommendedModel: '', actionClass: undefined })).toEqual({
      canonicalModel: 'opus', recommendedModel: 'claude-opus-5-5', actionClass: 'implement',
    });
    expect(carryPolicyColumns(before, NAME, undefined)).toEqual({
      canonicalModel: 'opus', recommendedModel: 'claude-opus-5-5', actionClass: 'implement',
    });
  });

  it('does not mutate its inputs', () => {
    const frozenBefore = Object.freeze({ ...before });
    const frozenFresh = Object.freeze({ ...NOTHING });
    expect(() => carryPolicyColumns(frozenBefore, NAME, frozenFresh)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// isSameRegisteredAgent - the identity rule behind the carry AND the skipped bind
// ---------------------------------------------------------------------------

describe('isSameRegisteredAgent', () => {
  const NAME = 'team-x-impl';
  const entry = { agentType: NAME, startedAt: '2026-10-13T00:00:00.000Z', active: false };

  it('POSITIVE CONTROL: the entry of the same non-empty agent type is the same registered agent', () => {
    expect(isSameRegisteredAgent(entry, NAME)).toBe(true);
    // Finished or running makes no difference: a resume usually arrives after a STOP.
    expect(isSameRegisteredAgent({ ...entry, active: true }, NAME)).toBe(true);
  });

  it('another agent type is another spawn: an id the host reused', () => {
    expect(isSameRegisteredAgent(entry, 'team-x-review')).toBe(false);
  });

  it('"both unknown" is not identity', () => {
    expect(isSameRegisteredAgent({ agentType: undefined }, undefined)).toBe(false);
    expect(isSameRegisteredAgent({}, undefined)).toBe(false);
    expect(isSameRegisteredAgent({ agentType: '' }, '')).toBe(false);
    expect(isSameRegisteredAgent(entry, '')).toBe(false);
    expect(isSameRegisteredAgent(entry, null)).toBe(false);
  });

  it('a row no START wrote (the shape workflow-status leaves) is not registered', () => {
    const row = { role: 'teammate', active: true, updatedAt: '2026-10-13T00:00:00.000Z', sessionId: 's' };
    expect(isSameRegisteredAgent(row, NAME)).toBe(false);
  });

  it.each([undefined, null, 42, 'text', true, []])('is false, and does not throw, for a previous entry of %j', (previous) => {
    expect(() => isSameRegisteredAgent(previous, NAME)).not.toThrow();
    expect(isSameRegisteredAgent(previous, NAME)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The hook itself, as a child process - what actually lands on disk
// ---------------------------------------------------------------------------

describe('subagent-handler resume START (child process)', () => {
  let tmp;
  let home;
  let repo;
  let subDir;
  let policyTier;
  let otherTier;
  let otherId;

  const NAME = 'split-artibot-resume-impl';
  const AGENT = 'ateam-resume-1';
  const SIBLING = 'split-artibot-resume-sibling';
  const SIBLING_AGENT = 'ateam-resume-sibling';
  const SESSION = 'sess-resume-1';
  const transcriptPath = () => path.join(subDir, `agent-${AGENT}.jsonl`);
  const putTranscript = (model) => writeFileSync(
    transcriptPath(),
    `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'go' } })}\n`
      + `${JSON.stringify({ type: 'assistant', message: { model, role: 'assistant', content: [{ type: 'text', text: 'ok' }] } })}\n`,
  );

  const prePayload = (over = {}) => ({
    cwd: repo,
    hook_event_name: 'PreToolUse',
    prompt_id: 'pid-resume-1',
    session_id: SESSION,
    tool_name: 'Agent',
    tool_use_id: 'toolu_resume_1',
    tool_input: {
      description: 'Implement the ledger byte cap across three modules and add regression tests',
      prompt: 'the full prompt body',
      subagent_type: 'tdd-guide',
      name: NAME,
    },
    ...over,
  });
  const startPayload = (over = {}) => ({
    session_id: SESSION,
    agent_id: AGENT,
    agent_type: NAME,
    hook_event_name: 'SubagentStart',
    prompt_id: 'pid-resume-1',
    cwd: repo,
    ...over,
  });
  const stopPayload = (over = {}) => ({
    session_id: SESSION,
    agent_id: AGENT,
    agent_type: NAME,
    hook_event_name: 'SubagentStop',
    stop_hook_active: false,
    agent_transcript_path: transcriptPath(),
    last_assistant_message: 'ok',
    cwd: repo,
    ...over,
  });
  // A second Agent call of the same session: its receipt, and the START that should bind it.
  const siblingPre = () => prePayload({
    prompt_id: 'pid-resume-b',
    tool_use_id: 'toolu_resume_b',
    tool_input: {
      description: 'Implement the ledger byte cap across three modules and add regression tests',
      prompt: 'the full prompt body',
      subagent_type: 'tdd-guide',
      name: SIBLING,
    },
  });
  const siblingStart = () => startPayload({ agent_id: SIBLING_AGENT, agent_type: SIBLING, prompt_id: 'pid-resume-b' });

  function run(script, args, payload) {
    const res = spawnSync(process.execPath, [script, ...args], {
      input: JSON.stringify(payload),
      encoding: 'utf-8',
      // The host session ids must not leak into the child: both are blanked.
      env: {
        ...process.env, HOME: home, USERPROFILE: home, CLAUDE_SESSION_ID: '', CLAUDE_CODE_SESSION_ID: '',
      },
      windowsHide: true,
    });
    return { status: res.status, stdout: String(res.stdout || ''), stderr: String(res.stderr || '') };
  }
  const start = (payload) => run(HOOK, ['start'], payload);
  const stop = (payload) => run(HOOK, ['stop'], payload);
  const pre = (payload) => run(PRE_HOOK, [], payload);

  const rows = (event) => readSpawns(repo, { sessionId: SESSION }).filter((r) => r.event === event);
  const statePath = () => path.join(home, '.claude', 'artibot-state.json');
  const stateEntry = () => JSON.parse(readFileSync(statePath(), 'utf-8')).agents[AGENT];

  /** Every line the project ledger holds, parsed. */
  const ledgerLines = () => readFileSync(ledgerFilePath(repo), 'utf-8')
    .split('\n').filter(Boolean).map((line) => JSON.parse(line));
  /** This session's `route.bound` lines as [agent_id, tool_use_id], in ledger order. */
  const bindPairs = () => ledgerLines()
    .filter((line) => line.event === 'route.bound' && line.session_id === SESSION)
    .map((line) => [line.data.agent_id, line.data.tool_use_id]);
  /** How many lines of one event of this session the bind scan can still see (it reads the last 128 KiB). */
  const inWindow = (event) => readLedgerTail(repo).filter(
    (line) => line.session_id === SESSION && line.event === event,
  ).length;
  /** Push everything written so far out of that window with unrelated lines (about 160 KB). */
  const ageOutOfWindow = () => appendFileSync(
    ledgerFilePath(repo), `${JSON.stringify({ filler: 'x'.repeat(1000) })}\n`.repeat(160),
  );

  beforeEach(async () => {
    tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'artibot-resume-hook-')));
    home = path.join(tmp, 'home');
    repo = path.join(tmp, 'repo');
    subDir = path.join(tmp, 'projects', 'slug', 'sess', 'subagents');
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    mkdirSync(repo, { recursive: true });
    mkdirSync(subDir, { recursive: true });
    execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore', windowsHide: true });
    // The tier of the DEFINITION the receipt names (tdd-guide), from the policy itself.
    policyTier = resolveModel('tdd-guide', {}, await loadConfig());
    otherTier = policyTier === 'sonnet' ? 'opus' : 'sonnet';
    otherId = getModel(otherTier).id;
  });
  afterEach(() => {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  });

  it('POSITIVE CONTROL: the first START of a named spawn binds the definition tier', () => {
    expect(pre(prePayload()).status).toBe(0);
    expect(start(startPayload()).status).toBe(0);
    const [first] = rows('start');
    expect(first).toMatchObject({ route_ledger: 'ok:bound', canonicalModel: policyTier });
    // The receipt's own classification and recommendation: whatever they are, they are strings.
    expect(first.recommendedModel).toEqual(expect.any(String));
    expect(first.actionClass).toEqual(expect.any(String));
    expect(stateEntry()).toMatchObject({ canonicalModel: policyTier, active: true });
  });

  it('a resumed START keeps the tier, the recommendation and the action class on the state entry', () => {
    expect(pre(prePayload()).status).toBe(0);
    expect(start(startPayload()).status).toBe(0);
    const [first] = rows('start');
    expect(stop(stopPayload()).status).toBe(0);

    // The host resumes the same teammate: same id, same name, a new turn.
    expect(start(startPayload({ prompt_id: 'pid-resume-2' })).status).toBe(0);
    expect(stateEntry()).toMatchObject({
      active: true,
      canonicalModel: policyTier,
      recommendedModel: first.recommendedModel,
      actionClass: first.actionClass,
    });
    expect(stateEntry()).not.toHaveProperty('stoppedAt');
  });

  it('the resumed START row carries them too and still says the bind did not happen again', () => {
    expect(pre(prePayload()).status).toBe(0);
    expect(start(startPayload()).status).toBe(0);
    const [first] = rows('start');
    expect(start(startPayload({ prompt_id: 'pid-resume-2' })).status).toBe(0);

    const [, resumed] = rows('start');
    expect(resumed.route_ledger).toBe('skipped:already-bound');
    expect(resumed).toMatchObject({
      canonicalModel: policyTier, recommendedModel: first.recommendedModel, actionClass: first.actionClass,
    });
  });

  it('END TO END: after a resume, the next STOP still reads servedDrift against the carried tier', () => {
    expect(pre(prePayload()).status).toBe(0);
    expect(start(startPayload()).status).toBe(0);
    putTranscript(getModel(policyTier).id);
    expect(stop(stopPayload()).status).toBe(0);
    expect(rows('stop').at(-1)).toMatchObject({ servedDrift: false, modelMismatch: false });

    expect(start(startPayload({ prompt_id: 'pid-resume-2' })).status).toBe(0);
    putTranscript(otherId);
    expect(stop(stopPayload()).status).toBe(0);

    const second = rows('stop').at(-1);
    // Drift, not a START-meaning mismatch: modelMismatch stays false for an intended route.
    expect(second).toMatchObject({
      canonicalModel: policyTier, servedModel: otherId, servedTier: otherTier, servedDrift: true, modelMismatch: false,
    });
    expect(stateEntry()).toMatchObject({
      canonicalModel: policyTier, servedTier: otherTier, servedDrift: true, modelMismatch: false,
    });
  });

  it('END TO END: a resume START after the first bind aged out of the ledger window carries the tier and binds nothing', () => {
    expect(pre(prePayload()).status).toBe(0);
    expect(start(startPayload()).status).toBe(0);
    const [first] = rows('start');
    expect(first.route_ledger).toBe('ok:bound');
    // POSITIVE CONTROL for the aging: the receipt and its bind are inside the window now...
    expect(inWindow('route.selected')).toBe(1);
    expect(inWindow('route.bound')).toBe(1);
    ageOutOfWindow();
    // ...and after the padding neither is, so the next START cannot see that it was ever bound.
    expect(inWindow('route.selected')).toBe(0);
    expect(inWindow('route.bound')).toBe(0);

    expect(stop(stopPayload()).status).toBe(0);
    const resumed = start(startPayload({ prompt_id: 'pid-resume-2' }));
    expect(resumed.status).toBe(0);

    const [, resumedRow] = rows('start');
    // The ledger can no longer say it was bound (the in-window tests above never reach this path);
    // the state entry can. This was `skipped:unbound` before the entry decided.
    expect(resumedRow.route_ledger).toBe('skipped:already-bound');
    expect(resumedRow).toMatchObject({
      canonicalModel: policyTier, recommendedModel: first.recommendedModel, actionClass: first.actionClass,
    });
    expect(stateEntry()).toMatchObject({
      active: true,
      canonicalModel: policyTier,
      recommendedModel: first.recommendedModel,
      actionClass: first.actionClass,
    });
    expect(stateEntry()).not.toHaveProperty('stoppedAt');

    // The next STOP reads served drift against the carried tier.
    putTranscript(otherId);
    expect(stop(stopPayload()).status).toBe(0);
    expect(rows('stop').at(-1)).toMatchObject({
      canonicalModel: policyTier, servedModel: otherId, servedTier: otherTier, servedDrift: true, modelMismatch: false,
    });

    // The bind was not repeated (the one route.bound line is the first START's), and stdout is the usual literal.
    const binds = ledgerLines().filter((line) => line.event === 'route.bound' && line.data?.agent_id === AGENT);
    expect(binds).toHaveLength(1);
    expect(JSON.parse(resumed.stdout.trim())).toEqual({ message: `[team] Agent registered: ${AGENT} (${NAME})` });
  });

  it('a resume after the first bind aged out takes no sibling receipt: the sibling binds its own', () => {
    expect(pre(prePayload()).status).toBe(0);
    expect(start(startPayload()).status).toBe(0);
    ageOutOfWindow();
    // The sibling's receipt comes after the padding: inside the window, unbound, waiting for its START.
    expect(pre(siblingPre()).status).toBe(0);
    expect(inWindow('route.selected')).toBe(1);
    expect(inWindow('route.bound')).toBe(0);

    expect(start(startPayload({ prompt_id: 'pid-resume-2' })).status).toBe(0);
    expect(rows('start').at(-1)).toMatchObject({ agentId: AGENT, route_ledger: 'skipped:already-bound' });
    // Before the rule this START took that receipt by FIFO (`confidence: 'fifo'`): a second bind for AGENT.
    expect(bindPairs()).toEqual([[AGENT, 'toolu_resume_1']]);

    // POSITIVE CONTROL: the receipt was still there, and its own START binds it.
    expect(start(siblingStart()).status).toBe(0);
    expect(rows('start').at(-1)).toMatchObject({
      agentId: SIBLING_AGENT, route_ledger: 'ok:bound', canonicalModel: policyTier,
    });
    expect(bindPairs()).toEqual([[AGENT, 'toolu_resume_1'], [SIBLING_AGENT, 'toolu_resume_b']]);
  });

  it('the same agent id under ANOTHER agent type is another spawn: it binds', () => {
    expect(pre(prePayload()).status).toBe(0);
    expect(start(startPayload()).status).toBe(0);
    ageOutOfWindow();
    expect(pre(siblingPre()).status).toBe(0);

    // One id, the sibling's type: the host handed a single id to two teammates (a name cut to a fixed length).
    const second = start(startPayload({ agent_type: SIBLING, prompt_id: 'pid-resume-b' }));
    expect(second.status).toBe(0);

    expect(rows('start').at(-1)).toMatchObject({
      agentId: AGENT, agentType: SIBLING, route_ledger: 'ok:bound', canonicalModel: policyTier,
    });
    expect(bindPairs()).toEqual([[AGENT, 'toolu_resume_1'], [AGENT, 'toolu_resume_b']]);
    // The row now belongs to the type that registered last, and nothing was carried across types.
    expect(stateEntry()).toMatchObject({ agentType: SIBLING, active: true, canonicalModel: policyTier });
    expect(JSON.parse(second.stdout.trim())).toEqual({ message: `[team] Agent registered: ${AGENT} (${SIBLING})` });
  });

  it('a row that only workflow-status wrote (no agent type) is not a resume: the first START still binds', () => {
    // workflow-status.js runs on the same SubagentStart and may write the row first.
    writeFileSync(statePath(), JSON.stringify({
      agents: { [AGENT]: { role: 'teammate', active: true, updatedAt: new Date().toISOString(), sessionId: SESSION } },
    }));
    expect(pre(prePayload()).status).toBe(0);
    expect(start(startPayload()).status).toBe(0);
    expect(rows('start')[0]).toMatchObject({ route_ledger: 'ok:bound', canonicalModel: policyTier });
    expect(stateEntry()).toMatchObject({ agentType: NAME, active: true, canonicalModel: policyTier });
  });

  it('with the state file unreadable the bind is attempted as before: a first START still binds, and the file is left alone', () => {
    const corrupt = 'not json{{{';
    writeFileSync(statePath(), corrupt);
    expect(pre(prePayload()).status).toBe(0);

    const started = start(startPayload());

    expect(started.status).toBe(0);
    expect(rows('start')[0]).toMatchObject({ route_ledger: 'ok:bound', canonicalModel: policyTier });
    expect(readFileSync(statePath(), 'utf-8')).toBe(corrupt);
    // Said once, not twice: the lookup that precedes the bind is quiet, the write path says it.
    expect(started.stderr.split('team state left untouched').length - 1).toBe(1);
  });

  it('with the state file unreadable a resume inside the window is still caught by the ledger', () => {
    expect(pre(prePayload()).status).toBe(0);
    expect(start(startPayload()).status).toBe(0);
    writeFileSync(statePath(), 'not json{{{');

    expect(start(startPayload({ prompt_id: 'pid-resume-2' })).status).toBe(0);

    expect(rows('start').at(-1)).toMatchObject({ route_ledger: 'skipped:already-bound' });
    expect(bindPairs()).toEqual([[AGENT, 'toolu_resume_1']]);
  });

  it('NEGATIVE CONTROL: a spawn that never had a tier is not given one by a resume', () => {
    // No PreToolUse receipt, so the name binds nothing and records no tier.
    expect(start(startPayload()).status).toBe(0);
    expect(start(startPayload({ prompt_id: 'pid-resume-2' })).status).toBe(0);
    for (const row of rows('start')) {
      expect(row).toMatchObject({ canonicalModel: null, recommendedModel: null });
    }
    expect(stateEntry()).toMatchObject({ canonicalModel: null, recommendedModel: null });
    putTranscript(otherId);
    expect(stop(stopPayload()).status).toBe(0);
    expect(rows('stop').at(-1)).toMatchObject({
      canonicalModel: null, servedTier: otherTier, servedDrift: false, modelMismatch: false,
    });
  });

  it('a different agent id does not inherit another spawn\'s tier', () => {
    expect(pre(prePayload()).status).toBe(0);
    expect(start(startPayload()).status).toBe(0);
    expect(start(startPayload({ agent_id: 'ateam-resume-2' })).status).toBe(0);
    const second = rows('start').find((r) => r.agentId === 'ateam-resume-2');
    // Its own bind was refused (one receipt binds one spawn), and the first spawn's tier is not lent to it.
    expect(second).toMatchObject({ route_ledger: 'skipped:unbound', canonicalModel: null });
  });

  it('stdout is the pre-change literal on a resumed START', () => {
    expect(pre(prePayload()).status).toBe(0);
    const first = start(startPayload());
    const resumed = start(startPayload({ prompt_id: 'pid-resume-2' }));
    expect(resumed.status).toBe(0);
    expect(resumed.stdout).toBe(first.stdout);
    expect(JSON.parse(resumed.stdout.trim())).toEqual({ message: `[team] Agent registered: ${AGENT} (${NAME})` });
  });
});
