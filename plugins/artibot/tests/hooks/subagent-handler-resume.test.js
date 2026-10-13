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
 *
 * WHAT THIS FILE DOES NOT PROVE (rules section 9 - the gate's blind spots):
 *   - THAT THE HOST RESUMES WITH THE SAME agent_id AND agent_type. The live evidence is
 *     indirect: one agent id with `start`, `stop`, `start` rows two seconds apart, and
 *     194 `skipped:already-bound` START rows. The payloads below are hand-written.
 *   - THAT A RESUME ARRIVES INSIDE THE LEDGER TAIL WINDOW. A resume after the first bind
 *     line has aged out of the 128 KB window records `skipped:unbound`; the carry is keyed
 *     on the registered entry, not on that string, so it holds there too, but only the
 *     `already-bound` outcome is exercised end to end.
 *
 * @module tests/hooks/subagent-handler-resume
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../../lib/core/config.js';
import { getModel } from '../../lib/core/model-catalog.js';
import { resolveModel } from '../../lib/core/model-policy.js';
import { readSpawns } from '../../lib/learning/ledger/spawn-ledger.js';
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
  const stateEntry = () => JSON.parse(
    readFileSync(path.join(home, '.claude', 'artibot-state.json'), 'utf-8'),
  ).agents[AGENT];

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
