/**
 * Unit contract for the routing-honor fold (`lib/replay/routing-honor.js`).
 *
 * Every fixture goes through the REAL `joinSpawnOutcomes` from synthetic ledger
 * lines, so a change to the pair shape that producer emits turns this suite red
 * instead of leaving it green against a hand-made pair.
 *
 * -- WHAT THIS SUITE CANNOT SEE (repo rules section 9) ----------------------
 *   - ZERO LIVE LINES. The rows are hand-built in the envelope layout of
 *     `tests/replay/spawn-outcome.test.js`. Nothing here says what the live
 *     honor rate IS; on the shared ledger at 2026-09-23T07:40Z only 1 of 190
 *     joined pairs had a qualified `agent_type`, so the live measured
 *     population is tiny and this suite's 3 measured rows are not a sample of it.
 *   - THE HOST. Whether the host actually serves frontmatter or an
 *     `Agent(model=...)` parameter is the thing being measured, not something
 *     a fixture can show.
 *   - THE CLI WIRING. The "CLI-shaped" case below wires the real
 *     `resolveEffectiveModel` and `resolveModelIdentity`, but how the CLI builds
 *     the roster and the cowork frontmatter map is that CLI suite's business.
 *   - THE SETTING IN FORCE AT SPAWN TIME (module CANNOT SEE #6). The resolver
 *     answers with the fixture's overrides; the suite does not model time.
 *
 * @module tests/replay/routing-honor
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { joinSpawnOutcomes } from '../../lib/replay/spawn-outcome.js';
import {
  foldRoutingHonor,
  ROUTING_HONOR_VERDICTS,
  UNMEASURED_REASONS,
} from '../../lib/replay/routing-honor.js';
import { emptyOverrides, resolveEffectiveModel, setOverride } from '../../lib/core/model-overrides.js';
import { resolveModelIdentity } from '../../lib/economics/usage-receipt.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCE = join(__dirname, '..', '..', 'lib', 'replay', 'routing-honor.js');

const MISSION = 'M-20260923-001';
const SESS_A = 'sess-a';
const SESS_B = 'sess-b';
const OPUS = 'claude-opus-5-5';
const SONNET = 'claude-sonnet-5';
const FABLE = 'claude-fable-5-1';

let seqCounter = 0;

/**
 * A `route.bound` row in the live envelope key order (see spawn-outcome.test.js).
 *
 * @param {object} spec - agentId, session, confidence and the optional agentType / subagentType.
 * @returns {object} ledger line.
 */
function bound(spec) {
  const { agentId, session = SESS_A, confidence = 'exact', agentType, subagentType } = spec;
  seqCounter += 1;
  return {
    v: 1,
    ts: '2026-09-23T01:00:00.000Z',
    event: 'route.bound',
    session_id: session,
    source: 'hook',
    pid: 4242,
    seq: seqCounter,
    mission_id: MISSION,
    routing_epoch_id: agentId,
    run_id: agentId,
    action_id: `toolu_${agentId}`,
    data: {
      tool_use_id: `toolu_${agentId}`,
      agent_id: agentId,
      confidence,
      method: confidence === 'fifo' ? 'prompt_id+fifo' : 'prompt_id+name',
      ...(agentType === undefined ? {} : { agent_type: agentType }),
      ...(subagentType === undefined ? {} : { subagent_type: subagentType }),
      matched_on: 'name',
      recommended_model: OPUS,
      action_class: 'implement',
    },
  };
}

/**
 * A `usage.receipt` row. `model: null` writes no readable model on either the
 * identity block or the envelope, which is how a pair ends up with no served
 * model.
 *
 * @param {string} runId - `agent-<id>` for a subagent, a bare session id for the main thread.
 * @param {string|null} model - served model id.
 * @param {string} [session]
 * @returns {object} ledger line.
 */
function receipt(runId, model, session = SESS_A) {
  seqCounter += 1;
  return {
    v: 1,
    ts: `2026-09-23T01:05:${String(seqCounter % 60).padStart(2, '0')}.000Z`,
    event: 'usage.receipt',
    session_id: session,
    source: 'hook',
    pid: 4242,
    seq: seqCounter,
    mission_id: MISSION,
    run_id: runId,
    ...(model === null ? {} : { model }),
    idempotency_key: `usage.receipt:${session}:${runId}:${model}`,
    data: {
      schema_version: 1,
      run_id: runId,
      mission_id: MISSION,
      model_identity: { provider: 'anthropic', family: 'claude', model_id: model },
      usage: { source: 'transcript', fresh_input_tokens: 1, output_tokens: 1 },
      timing: { latency_ms: 10 },
      outcome: { status: 'unknown', accepted: null },
      cost: { total: null, pricing_version: 'unresolved' },
    },
  };
}

/** Qualified names with a definition. */
const ROSTER = Object.freeze([
  'artibot:doc-updater', 'artibot:planner', 'artibot-cowork:planner',
  'artibot:architect', 'artibot:code-reviewer', 'artibot:tdd-guide',
  'artibot:backend-developer', 'artibot:frontend-developer', 'artibot:auditor',
]);

/** What the fake resolver answers, per agent. Anything else resolves to `opus`. */
const EXPECTED = Object.freeze({
  'artibot:doc-updater': { model: 'sonnet', source: 'shipped', reason: null },
  'artibot:planner': { model: 'opus', source: 'shipped', reason: null },
  'artibot-cowork:planner': { model: 'sonnet', source: 'cowork-frontmatter', reason: null },
  'artibot:backend-developer': null,
  'artibot:frontend-developer': { model: 'claude-opus-5', source: 'shipped', reason: null },
});

/** Served id -> tier, as a catalog-built mapper would answer. */
const TIER_OF = Object.freeze({ [OPUS]: 'opus', [SONNET]: 'sonnet', [FABLE]: 'fable' });

/**
 * The ports with a call log, so a test can see WHICH names reached the resolver.
 *
 * @returns {{ports: object, calls: string[]}}
 */
function fakePorts() {
  const calls = [];
  const ports = {
    resolve: (name) => {
      calls.push(name);
      return Object.hasOwn(EXPECTED, name) ? EXPECTED[name] : { model: 'opus', source: 'shipped', reason: null };
    },
    tierOfServedModel: (id) => TIER_OF[id] ?? null,
    roster: ROSTER,
  };
  return { ports, calls };
}

/**
 * One row per verdict and per unmeasured reason, plus the join edge cases.
 *
 * @returns {object[]} ledger lines in file order.
 */
function fixture() {
  return [
    bound({ agentId: 'a01', agentType: 'artibot:doc-updater' }),
    receipt('agent-a01', SONNET),
    bound({ agentId: 'a02', agentType: 'artibot:planner' }),
    receipt('agent-a02', FABLE),
    bound({ agentId: 'a03', agentType: 'artibot-cowork:planner', confidence: 'fifo', session: SESS_B }),
    receipt('agent-a03', SONNET, SESS_B),
    bound({ agentId: 'a04' }),
    receipt('agent-a04', OPUS),
    bound({ agentId: 'a05', agentType: 'split-artibot-x-impl' }),
    receipt('agent-a05', OPUS),
    bound({ agentId: 'a06', agentType: 'artibot:ghost' }),
    receipt('agent-a06', OPUS),
    bound({ agentId: 'a07', agentType: 'artibot:architect' }),
    receipt('agent-a07', null),
    bound({ agentId: 'a08', agentType: 'artibot:code-reviewer' }),
    receipt('agent-a08', OPUS),
    receipt('agent-a08', FABLE),
    bound({ agentId: 'a09', agentType: 'artibot:tdd-guide' }),
    receipt('agent-a09', 'claude-mystery-9'),
    bound({ agentId: 'a10', agentType: 'artibot:backend-developer' }),
    receipt('agent-a10', OPUS),
    bound({ agentId: 'a11', agentType: 'artibot:frontend-developer' }),
    receipt('agent-a11', OPUS),
    // Bound, never wrote a receipt: in `binds`, not in `joined`.
    bound({ agentId: 'a12', agentType: 'artibot:auditor' }),
    // Wrote a subagent receipt, never bound: in `subagent_runs` only.
    receipt('agent-zz', OPUS),
    // Main-thread run: in no denominator.
    receipt(SESS_A, OPUS),
  ];
}

/** Deterministic shuffle (same construction as `tests/replay/spawn-outcome.test.js`). */
function shuffled(arr) {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = (i * 7919) % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** The row for one agent id. */
function rowOf(result, agentId) {
  return result.rows.find((r) => r.agent_id === agentId);
}

describe('foldRoutingHonor() verdicts', () => {
  const result = foldRoutingHonor(joinSpawnOutcomes(fixture()), fakePorts().ports);

  it('honored: served tier equals the expected tier', () => {
    expect(rowOf(result, 'a01')).toMatchObject({
      agent_type: 'artibot:doc-updater', served_model: SONNET, served_tier: 'sonnet',
      expected_tier: 'sonnet', expected_source: 'shipped', verdict: 'honored', reason: null,
    });
  });

  it('unhonored: both tiers known and different', () => {
    expect(rowOf(result, 'a02')).toMatchObject({
      served_tier: 'fable', expected_tier: 'opus', verdict: 'unhonored', reason: null,
    });
    expect(result.unhonored_by_transition).toEqual({ 'opus->fable': 1 });
  });

  it('a fifo-bound pair IS measured: confidence grades the router receipt, not agent_type or served', () => {
    expect(rowOf(result, 'a03')).toMatchObject({ confidence: 'fifo', verdict: 'honored' });
    expect(result.measured_by_confidence).toEqual({ exact: 2, fifo: 1 });
  });

  it.each([
    ['a04', UNMEASURED_REASONS.noAgentType],
    ['a05', UNMEASURED_REASONS.unqualifiedAgentType],
    ['a06', UNMEASURED_REASONS.notInRoster],
    ['a07', UNMEASURED_REASONS.noServedModel],
    ['a08', UNMEASURED_REASONS.multiModelRun],
    ['a09', UNMEASURED_REASONS.servedModelUnknown],
    ['a10', UNMEASURED_REASONS.notResolvable],
    ['a11', UNMEASURED_REASONS.expectedNotATier],
  ])('%s is unmeasured with reason %s', (agentId, reason) => {
    const row = rowOf(result, agentId);
    expect(row.verdict).toBe('unmeasured');
    expect(row.reason).toBe(reason);
    expect(row.expected_tier).toBeNull();
  });

  it('every unmeasured reason is exercised once and listed even at zero', () => {
    const all = Object.values(UNMEASURED_REASONS);
    expect(Object.keys(result.unmeasured_by_reason)).toEqual([...all].sort());
    expect(Object.values(result.unmeasured_by_reason)).toEqual(all.map(() => 1));
  });

  it('reports the served id it could not map, and no tier for it', () => {
    expect(rowOf(result, 'a09')).toMatchObject({ served_model: 'claude-mystery-9', served_tier: null });
  });

  it('splits measured verdicts by where the expectation came from', () => {
    expect(result.by_expected_source).toEqual({
      honored: { 'cowork-frontmatter': 1, shipped: 1 },
      unhonored: { shipped: 1 },
    });
  });
});

describe('foldRoutingHonor() denominators', () => {
  const result = foldRoutingHonor(joinSpawnOutcomes(fixture()), fakePorts().ports);

  it('binds is the primary denominator; the receipt side and coverage sit beside it', () => {
    expect(result.denominators).toEqual({ binds: 12, joined: 11, subagent_runs: 12, measured: 3 });
    expect(result.verdicts).toEqual({ honored: 2, unhonored: 1, unmeasured: 8 });
    expect(result.rates).toEqual({
      join_of_binds: 11 / 12,
      join_of_subagent_runs: 11 / 12,
      measured_of_joined: 3 / 11,
      honored_of_measured: 2 / 3,
    });
  });

  it('verdict counts add up to the joined pairs', () => {
    const { honored, unhonored, unmeasured } = result.verdicts;
    expect(honored + unhonored + unmeasured).toBe(result.denominators.joined);
    expect(result.rows).toHaveLength(result.denominators.joined);
  });

  it('an empty ledger yields null rates, never 0', () => {
    const empty = foldRoutingHonor(joinSpawnOutcomes([]), fakePorts().ports);
    expect(empty.denominators).toEqual({ binds: 0, joined: 0, subagent_runs: 0, measured: 0 });
    expect(Object.values(empty.rates)).toEqual([null, null, null, null]);
    expect(Object.values(empty.unmeasured_by_reason).every((n) => n === 0)).toBe(true);
    expect(empty.rows).toEqual([]);
  });

  it('pairs but nothing measurable: join rates are numbers, the honor rate is null', () => {
    const lines = [bound({ agentId: 'b1', agentType: 'Explore' }), receipt('agent-b1', OPUS)];
    const r = foldRoutingHonor(joinSpawnOutcomes(lines), fakePorts().ports);
    expect(r.rates).toEqual({
      join_of_binds: 1, join_of_subagent_runs: 1, measured_of_joined: 0, honored_of_measured: null,
    });
  });
});

describe('the roster is checked before the resolver is asked', () => {
  it('a resolver that answers every name still cannot honor a teammate or an unknown agent', () => {
    const { ports, calls } = fakePorts();
    foldRoutingHonor(joinSpawnOutcomes(fixture()), ports);
    // Only rows that passed the identity and served checks reach the resolver.
    expect([...calls].sort()).toEqual([
      'artibot-cowork:planner', 'artibot:backend-developer', 'artibot:doc-updater',
      'artibot:frontend-developer', 'artibot:planner',
    ]);
  });

  it('roster membership is exact: case and a missing prefix do not match', () => {
    const lines = [
      bound({ agentId: 'c1', agentType: 'artibot:Doc-Updater' }), receipt('agent-c1', SONNET),
      bound({ agentId: 'c2', agentType: 'doc-updater' }), receipt('agent-c2', SONNET),
    ];
    const r = foldRoutingHonor(joinSpawnOutcomes(lines), fakePorts().ports);
    expect(rowOf(r, 'c1').reason).toBe(UNMEASURED_REASONS.notInRoster);
    expect(rowOf(r, 'c2').reason).toBe(UNMEASURED_REASONS.unqualifiedAgentType);
  });

  it('a throwing port reads as no answer, never as a verdict', () => {
    const boom = () => { throw new Error('boom'); };
    const lines = [bound({ agentId: 'd1', agentType: 'artibot:planner' }), receipt('agent-d1', OPUS)];
    const noResolve = foldRoutingHonor(joinSpawnOutcomes(lines), { ...fakePorts().ports, resolve: boom });
    expect(rowOf(noResolve, 'd1').reason).toBe(UNMEASURED_REASONS.notResolvable);
    const noTier = foldRoutingHonor(joinSpawnOutcomes(lines), { ...fakePorts().ports, tierOfServedModel: boom });
    expect(rowOf(noTier, 'd1').reason).toBe(UNMEASURED_REASONS.servedModelUnknown);
  });

  it('a mapper answering a non-tier word is unknown, not a mismatch', () => {
    const lines = [bound({ agentId: 'e1', agentType: 'artibot:planner' }), receipt('agent-e1', OPUS)];
    const r = foldRoutingHonor(joinSpawnOutcomes(lines), { ...fakePorts().ports, tierOfServedModel: () => 'high' });
    expect(rowOf(r, 'e1').reason).toBe(UNMEASURED_REASONS.servedModelUnknown);
  });
});

/** A teammate name, as the host reports it on a named spawn. */
const TEAMMATE = 'split-x-impl';

/**
 * Fold one named spawn through the REAL join: its bind and one receipt.
 *
 * @param {object} spec - `bound()` spec; `served` is the receipt's model.
 * @returns {{row: object, calls: string[]}} the spawn's row and the resolver calls.
 */
function judgeNamed(spec) {
  const { served = OPUS, ...bind } = spec;
  const { ports, calls } = fakePorts();
  const r = foldRoutingHonor(joinSpawnOutcomes([bound(bind), receipt(`agent-${bind.agentId}`, served)]), ports);
  return { row: rowOf(r, bind.agentId), calls };
}

describe('named spawns: judged on the caller subagent_type when the host agent_type is not qualified', () => {
  it('teammate name + artibot:doc-updater + exact bind is measured, through the real join', () => {
    const { row, calls } = judgeNamed({
      agentId: 'n1', agentType: TEAMMATE, subagentType: 'artibot:doc-updater', served: SONNET,
    });
    expect(row).toMatchObject({
      agent_type: TEAMMATE, subagent_type: 'artibot:doc-updater',
      judged_agent: 'artibot:doc-updater', judged_on: 'subagent_type',
      served_tier: 'sonnet', expected_tier: 'sonnet', verdict: 'honored', reason: null,
    });
    expect(calls).toEqual(['artibot:doc-updater']);
  });

  it('a name-confidence bind is judged the same way', () => {
    const { row } = judgeNamed({
      agentId: 'n2', agentType: TEAMMATE, subagentType: 'artibot-cowork:planner', confidence: 'name',
    });
    expect(row).toMatchObject({ judged_agent: 'artibot-cowork:planner', expected_tier: 'sonnet', verdict: 'unhonored' });
  });

  it('a bare host definition name matched to a qualified receipt is judged on the receipt', () => {
    // The caller named the plugin definition explicitly; the host reported it bare.
    const { row } = judgeNamed({
      agentId: 'n3', agentType: 'code-reviewer', subagentType: 'artibot:code-reviewer', confidence: 'name',
    });
    expect(row).toMatchObject({ judged_agent: 'artibot:code-reviewer', judged_on: 'subagent_type', verdict: 'honored' });
  });

  it.each([
    ['an unprefixed subagent_type', 'doc-updater'],
    ['a built-in subagent_type', 'Explore'],
    ['general-purpose', 'general-purpose'],
  ])('%s is judged as written and stays unqualified-agent-type', (_label, subagentType) => {
    const { row, calls } = judgeNamed({ agentId: 'n4', agentType: TEAMMATE, subagentType });
    expect(row).toMatchObject({
      judged_agent: subagentType, judged_on: 'subagent_type',
      verdict: 'unmeasured', reason: UNMEASURED_REASONS.unqualifiedAgentType,
    });
    expect(calls).toEqual([]);
  });

  it('a qualified subagent_type off the roster is agent-not-in-roster', () => {
    const { row, calls } = judgeNamed({ agentId: 'n5', agentType: TEAMMATE, subagentType: 'artibot:ghost' });
    expect(row).toMatchObject({ judged_agent: 'artibot:ghost', reason: UNMEASURED_REASONS.notInRoster });
    expect(calls).toEqual([]);
  });

  it('a qualified host agent_type wins over the subagent_type', () => {
    const { row, calls } = judgeNamed({
      agentId: 'n6', agentType: 'artibot:planner', subagentType: 'artibot:doc-updater',
    });
    expect(row).toMatchObject({ judged_agent: 'artibot:planner', judged_on: 'agent_type', verdict: 'honored' });
    expect(calls).toEqual(['artibot:planner']);
  });

  it.each([
    ['fifo', 'fifo'],
    ['no confidence', null],
  ])('a %s bind never lends its subagent_type: unqualified, resolver not called', (_label, confidence) => {
    const { row, calls } = judgeNamed({
      agentId: 'n7', agentType: TEAMMATE, subagentType: 'artibot:doc-updater', confidence,
    });
    expect(row).toMatchObject({
      judged_agent: TEAMMATE, judged_on: 'agent_type',
      verdict: 'unmeasured', reason: UNMEASURED_REASONS.unqualifiedAgentType,
    });
    expect(calls).toEqual([]);
  });

  it('a bind written before the column existed is judged on the host value', () => {
    const { row } = judgeNamed({ agentId: 'n8', agentType: TEAMMATE });
    expect(row).toMatchObject({ subagent_type: null, judged_agent: TEAMMATE, reason: UNMEASURED_REASONS.unqualifiedAgentType });
  });

  it('a foreign-prefixed host agent_type is not overridden', () => {
    const { row } = judgeNamed({
      agentId: 'n9', agentType: 'other-plugin:reviewer', subagentType: 'artibot:code-reviewer',
    });
    expect(row).toMatchObject({ judged_agent: 'other-plugin:reviewer', reason: UNMEASURED_REASONS.unqualifiedAgentType });
  });

  it('no host agent_type on a fifo bind stays no-agent-type', () => {
    // The live shape: with no agent_type the writer's identity tier cannot fire,
    // so such a bind is always fifo.
    const { row } = judgeNamed({ agentId: 'n10', subagentType: 'artibot:doc-updater', confidence: 'fifo' });
    expect(row).toMatchObject({ judged_agent: null, judged_on: null, reason: UNMEASURED_REASONS.noAgentType });
  });

  it('named rows keep the fold byte-deterministic under shuffling', () => {
    const lines = [
      ...fixture(),
      bound({ agentId: 'n11', agentType: TEAMMATE, subagentType: 'artibot:doc-updater' }),
      receipt('agent-n11', SONNET),
      bound({ agentId: 'n12', agentType: 'team-y', subagentType: 'Explore', confidence: 'fifo' }),
      receipt('agent-n12', OPUS),
    ];
    const expected = JSON.stringify(foldRoutingHonor(joinSpawnOutcomes(lines), fakePorts().ports));
    expect(JSON.stringify(foldRoutingHonor(joinSpawnOutcomes(shuffled(lines)), fakePorts().ports))).toBe(expected);
    expect(JSON.stringify(foldRoutingHonor(joinSpawnOutcomes([...lines].reverse()), fakePorts().ports))).toBe(expected);
  });
});

describe('CLI-shaped wiring: real resolveEffectiveModel + resolveModelIdentity', () => {
  it('an override-sourced expectation is honored or unhonored against the catalog tier', () => {
    const withCowork = setOverride(emptyOverrides(), {
      scope: 'agent', plugin: 'artibot-cowork', key: 'planner', tier: 'haiku',
    });
    const overrides = setOverride(withCowork, {
      scope: 'agent', plugin: 'artibot', key: 'doc-updater', tier: 'sonnet',
    });
    const ctx = { overrides, coworkFrontmatter: { planner: 'opus' } };
    const lines = [
      bound({ agentId: 'f1', agentType: 'artibot-cowork:planner' }),
      receipt('agent-f1', 'claude-haiku-4-5-20251001'),
      // A legacy opus id still maps to the opus tier through the catalog.
      bound({ agentId: 'f2', agentType: 'artibot:doc-updater' }),
      receipt('agent-f2', 'claude-opus-5'),
    ];
    const r = foldRoutingHonor(joinSpawnOutcomes(lines), {
      resolve: (name) => resolveEffectiveModel(name, {}, ctx),
      tierOfServedModel: (id) => resolveModelIdentity(id)?.tier ?? null,
      roster: ['artibot-cowork:planner', 'artibot:doc-updater'],
    });
    expect(rowOf(r, 'f1')).toMatchObject({
      served_tier: 'haiku', expected_tier: 'haiku', expected_source: 'override-agent', verdict: 'honored',
    });
    expect(rowOf(r, 'f2')).toMatchObject({
      served_tier: 'opus', expected_tier: 'sonnet', expected_source: 'override-agent', verdict: 'unhonored',
    });
  });
});

describe('producer shape and determinism', () => {
  it('joinSpawnOutcomes still emits every pair field this fold reads', () => {
    const fold = joinSpawnOutcomes(fixture());
    expect(fold.pairs.length).toBeGreaterThan(0);
    for (const pair of fold.pairs) {
      expect(Object.keys(pair)).toEqual(expect.arrayContaining([
        'agent_id', 'session_id', 'agent_type', 'confidence', 'served_models',
      ]));
    }
    expect(Number.isInteger(fold.binds)).toBe(true);
    expect(Number.isInteger(fold.unjoined_receipts)).toBe(true);
  });

  it('joinSpawnOutcomes emits subagent_type on every pair, the fallback column this fold reads', () => {
    for (const pair of joinSpawnOutcomes(fixture()).pairs) {
      expect(Object.keys(pair)).toEqual(expect.arrayContaining(['subagent_type']));
    }
  });

  it('a shuffled ledger serializes to the same bytes', () => {
    const lines = fixture();
    const expected = JSON.stringify(foldRoutingHonor(joinSpawnOutcomes(lines), fakePorts().ports));
    const again = JSON.stringify(foldRoutingHonor(joinSpawnOutcomes(shuffled(lines)), fakePorts().ports));
    const reversed = JSON.stringify(foldRoutingHonor(joinSpawnOutcomes([...lines].reverse()), fakePorts().ports));
    expect(again).toBe(expected);
    expect(reversed).toBe(expected);
  });

  it('rows are sorted by session then agent id', () => {
    const r = foldRoutingHonor(joinSpawnOutcomes(shuffled(fixture())), fakePorts().ports);
    const keys = r.rows.map((row) => `${row.session_id}|${row.agent_id}`);
    expect(keys).toEqual([...keys].sort());
  });

  it('exported vocabularies are frozen', () => {
    expect(Object.isFrozen(ROUTING_HONOR_VERDICTS)).toBe(true);
    expect(Object.isFrozen(UNMEASURED_REASONS)).toBe(true);
    expect(ROUTING_HONOR_VERDICTS).toEqual(['honored', 'unhonored', 'unmeasured']);
  });
});

describe('ports are required (a caller bug is loud, not "all unmeasured")', () => {
  const fold = joinSpawnOutcomes([]);

  it.each([
    ['resolve', { resolve: undefined }],
    ['tierOfServedModel', { tierOfServedModel: 'x' }],
    ['roster', { roster: null }],
    ['roster as a string', { roster: 'artibot:planner' }],
  ])('rejects a missing or wrong %s', (_label, patch) => {
    expect(() => foldRoutingHonor(fold, { ...fakePorts().ports, ...patch })).toThrow(TypeError);
  });

  it('rejects something that is not a spawn-outcome fold', () => {
    expect(() => foldRoutingHonor([], fakePorts().ports)).toThrow(TypeError);
    expect(() => foldRoutingHonor(null, fakePorts().ports)).toThrow(TypeError);
  });
});

describe('purity (design section 1-8, L2)', () => {
  const text = readFileSync(SOURCE, 'utf-8');

  it('imports only the catalog, and nothing with effects', () => {
    const specifiers = [...text.matchAll(/^import\s[^;]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    expect(specifiers).toEqual(['../core/model-catalog.js']);
  });

  it('reads no clock, randomness, environment or filesystem', () => {
    const banned = /\bDate\b|\bMath\.random\b|\bprocess\.|node:fs|\brequire\(/;
    const hits = text.split('\n').filter((line) => banned.test(line));
    expect(hits).toEqual([]);
  });

  it('gate self-check: the purity pattern fires on a line that has a clock', () => {
    const banned = /\bDate\b|\bMath\.random\b|\bprocess\.|node:fs|\brequire\(/;
    expect(banned.test('const now = Date.now();')).toBe(true);
    expect(banned.test('const tiers = listTiers();')).toBe(false);
  });
});
