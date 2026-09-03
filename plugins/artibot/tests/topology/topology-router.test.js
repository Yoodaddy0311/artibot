/**
 * Tests for `lib/topology/topology-router.js` (PRD T-36, Observe stage).
 *
 * What these tests DO cover: the 6-way mode mapping, precedence between the
 * escalation signals, the `measured:false => term is exactly 0` invariant, the
 * ParallelGain arithmetic, `*Ref` resolution being read-only, human-gate
 * classification vs unavailability, and purity/immutability of the result.
 *
 * WHAT THEY DO NOT COVER (write it down next to the gate, so the gate does not
 * become the next illusion — rules §9):
 *  - Whether the WEIGHTS are right. Every expected number here is arithmetic
 *    over `DEFAULT_GAIN_WEIGHTS`, which is uncalibrated. A green suite says the
 *    formula was applied, never that `net` predicts anything.
 *  - Whether the NL phrase list has usable recall on real prompts. The fixtures
 *    are the design's own example sentences (07 §Natural-language activation);
 *    zero live operator prompts have been scored against them.
 *  - Whether `mergeRisk` reflects real merge conflicts. It is scored from
 *    caller-supplied `affectedPaths`, and this repository has 0 persisted
 *    merge-conflict outcomes to compare against (lane-5 §3-D).
 *  - Anything downstream. Nothing consumes this router yet (T-37 is the wiring
 *    task), so "routes correctly" here means "returns the right record".
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  DEFAULT_GAIN_WEIGHTS,
  DEFAULT_STARTUP_REFERENCE_MS,
  routeTopology,
  TOPOLOGY_MODES,
} from '../../lib/topology/topology-router.js';
// Drift gate only. The module under test does NOT import this at runtime; the
// coupling being checked is between two hand-written lexicons, not two modules.
import { cueMatches, interpretIntent, PERFORMANCE_CUES } from '../../lib/intent/interpreter.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

/** The real shipped config, so `*Ref` resolution is tested against reality. */
const realConfig = JSON.parse(readFileSync(path.join(repoRoot, 'artibot.config.json'), 'utf8'));

/** Minimal inline plan (what `buildWorkflowPlan` returns when the trigger misses). */
function inlinePlan(recommendation = null) {
  return { runner: 'inline', recommendation, teammates: [], effort: 'medium' };
}

/** Minimal team plan with N teammates across the given agents. */
function teamPlan(agents, recommendation = null) {
  return {
    runner: 'team',
    recommendation,
    teammates: agents.map((agent, i) => ({ agent, command: `cmd${i}`, effort: 'high', budget: 0 })),
    effort: 'xhigh',
  };
}

/** Intent carrying N recommendations across the given agents. */
function intentWith(agents) {
  return { recommendations: agents.map((agent, i) => ({ agents: [agent], commands: [`cmd${i}`] })) };
}

describe('routeTopology — mode mapping', () => {
  it('inline runner with no sub-objectives maps to solo', () => {
    const result = routeTopology({ intent: {}, workflowPlan: inlinePlan(), config: {}, evidence: {} });
    expect(result.mode).toBe('solo');
    expect(result.exception).toBeNull();
  });

  it('team runner maps to team', () => {
    const result = routeTopology({
      intent: {},
      workflowPlan: teamPlan(['frontend-developer', 'backend-developer']),
      config: {},
      evidence: {},
    });
    expect(result.mode).toBe('team');
    expect(result.exception).toBeNull();
  });

  it('inline runner with >=2 subs in ONE domain maps to subagent', () => {
    const result = routeTopology({
      intent: intentWith(['backend-developer', 'backend-developer', 'backend-developer']),
      workflowPlan: inlinePlan(),
      config: {},
      evidence: {},
    });
    expect(result.mode).toBe('subagent');
    expect(result.reason).toContain('domains:1');
  });

  it('inline runner with >=2 subs across MULTIPLE domains stays solo (subagent needs one domain)', () => {
    const result = routeTopology({
      intent: intentWith(['backend-developer', 'frontend-developer']),
      workflowPlan: inlinePlan(),
      config: {},
      evidence: {},
    });
    expect(result.mode).toBe('solo');
  });

  it('a single sub-objective never reaches subagent', () => {
    const result = routeTopology({
      intent: intentWith(['backend-developer']),
      workflowPlan: inlinePlan(),
      config: {},
      evidence: {},
    });
    expect(result.mode).toBe('solo');
  });

  it('recommendation=autopilot maps to autopilot with no exception', () => {
    const result = routeTopology({
      intent: {},
      workflowPlan: inlinePlan('autopilot'),
      config: {},
      evidence: {},
    });
    expect(result.mode).toBe('autopilot');
    expect(result.exception).toBeNull();
  });

  it('recommendation=split maps to split with exception=split', () => {
    const result = routeTopology({
      intent: {},
      workflowPlan: inlinePlan('split'),
      config: {},
      evidence: {},
    });
    expect(result.mode).toBe('split');
    expect(result.exception).toBe('split');
  });

  it('recommendation=workflow is NOT a topology mode and does not escalate', () => {
    // `deriveRecommendation` can return 'workflow', which has no run-ledger
    // enum value. It must fall through to the runner mapping, not leak out.
    const result = routeTopology({
      intent: {},
      workflowPlan: teamPlan(['a', 'b'], 'workflow'),
      config: {},
      evidence: {},
    });
    expect(result.mode).toBe('team');
    expect(TOPOLOGY_MODES).toContain(result.mode);
  });

  it('every produced mode is a member of the run-ledger enum', () => {
    const cases = [
      routeTopology({ workflowPlan: inlinePlan() }),
      routeTopology({ intent: intentWith(['a', 'a']), workflowPlan: inlinePlan() }),
      routeTopology({ workflowPlan: teamPlan(['a', 'b']) }),
      routeTopology({ workflowPlan: inlinePlan('autopilot') }),
      routeTopology({ workflowPlan: inlinePlan('split') }),
      routeTopology({ workflowPlan: inlinePlan(), evidence: { promptText: '최대한 빨리 끝내줘' } }),
    ];
    const produced = new Set(cases.map((c) => c.mode));
    for (const mode of produced) expect(TOPOLOGY_MODES).toContain(mode);
    // All six enum values are reachable — the point of correcting the spec's
    // first-match ordering, which made four of them dead.
    expect(produced).toEqual(new Set(TOPOLOGY_MODES));
  });
});

describe('routeTopology — natural-language activation (design 07 example phrases)', () => {
  const fastPhrases = [
    '최대한 빨리 정확하게 끝내줘.',
    '토큰 아끼지 말고 제대로 처리해.',
    '시간이 중요해. 병렬로 최대한 진행해.',
  ];
  const splitPhrases = [
    '작업량이 크니까 여러 작업으로 나눠 동시에 해.',
    '파일별로 병렬 작업하고 합쳐줘.',
    '이 대규모 변경 최대한 병렬로 처리해.',
  ];

  it.each(fastPhrases)('fast phrase routes to autopilot_fast: %s', (promptText) => {
    const result = routeTopology({ workflowPlan: inlinePlan(), evidence: { promptText } });
    expect(result.mode).toBe('autopilot_fast');
    expect(result.exception).toBe('autopilot_fast');
  });

  it.each(splitPhrases)('split phrase routes to split: %s', (promptText) => {
    const result = routeTopology({ workflowPlan: inlinePlan(), evidence: { promptText } });
    expect(result.mode).toBe('split');
    expect(result.exception).toBe('split');
  });

  it('the third fast phrase contains 병렬 yet still routes fast, not split', () => {
    // Guards the one design sentence that carries both vocabularies.
    const result = routeTopology({
      workflowPlan: inlinePlan(),
      evidence: { promptText: '시간이 중요해. 병렬로 최대한 진행해.' },
    });
    expect(result.mode).toBe('autopilot_fast');
  });

  it('fast wins over split when a prompt carries both (design lists fast first)', () => {
    const result = routeTopology({
      workflowPlan: inlinePlan(),
      evidence: { promptText: '최대한 빨리 끝내고, 파일별로 병렬 작업해줘.' },
    });
    expect(result.mode).toBe('autopilot_fast');
  });

  it('NL fast overrides a recommendation=split plan', () => {
    const result = routeTopology({
      workflowPlan: inlinePlan('split'),
      evidence: { promptText: '토큰 아끼지 말고 제대로 처리해.' },
    });
    expect(result.mode).toBe('autopilot_fast');
  });

  it('NL split overrides a team runner', () => {
    const result = routeTopology({
      workflowPlan: teamPlan(['a', 'b']),
      evidence: { promptText: '파일별로 병렬 작업하고 합쳐줘.' },
    });
    expect(result.mode).toBe('split');
  });

  it('explicit --fast flag activates autopilot_fast', () => {
    const result = routeTopology({
      workflowPlan: inlinePlan(),
      evidence: { promptText: '/autopilot --fast go' },
    });
    expect(result.mode).toBe('autopilot_fast');
    expect(result.reason).toContain('nl-match:flag-fast');
  });

  it('explicit /split command activates split', () => {
    const result = routeTopology({ workflowPlan: inlinePlan(), evidence: { promptText: '/split plan' } });
    expect(result.mode).toBe('split');
    expect(result.reason).toContain('nl-match:flag-split');
  });

  it('an unrelated prompt matches no pattern', () => {
    const result = routeTopology({
      workflowPlan: inlinePlan(),
      evidence: { promptText: '이 버그 하나만 고쳐줘' },
    });
    expect(result.mode).toBe('solo');
    expect(result.reason.some((r) => r.startsWith('nl-match:'))).toBe(false);
  });

  it('intent.text is accepted when evidence.promptText is absent', () => {
    const result = routeTopology({
      intent: { text: '최대한 빨리 정확하게 끝내줘.' },
      workflowPlan: inlinePlan(),
    });
    expect(result.mode).toBe('autopilot_fast');
  });

  it('evidence.promptText wins over intent.text', () => {
    const result = routeTopology({
      intent: { text: '파일별로 병렬 작업하고 합쳐줘.' },
      workflowPlan: inlinePlan(),
      evidence: { promptText: '최대한 빨리 정확하게 끝내줘.' },
    });
    expect(result.mode).toBe('autopilot_fast');
  });

  it('absent prompt text records nl:unavailable rather than a silent non-match', () => {
    const result = routeTopology({ workflowPlan: inlinePlan() });
    expect(result.reason).toContain('nl:unavailable');
  });

  it('present prompt text does NOT record nl:unavailable', () => {
    const result = routeTopology({ workflowPlan: inlinePlan(), evidence: { promptText: 'hello' } });
    expect(result.reason).not.toContain('nl:unavailable');
  });

  it('a blank prompt string counts as unavailable, not as a checked non-match', () => {
    const result = routeTopology({ workflowPlan: inlinePlan(), evidence: { promptText: '   ' } });
    expect(result.reason).toContain('nl:unavailable');
  });
});

describe('routeTopology — ParallelGain measured flags', () => {
  it('contextDup and tokenDup are always 0 and always measured:false', () => {
    const result = routeTopology({
      intent: intentWith(['a', 'b', 'c']),
      workflowPlan: teamPlan(['a', 'b', 'c']),
      evidence: {
        tasks: [{ affectedPaths: ['src/a.js'] }, { affectedPaths: ['src/b.js'] }],
        spawnDurationsMs: [1000, 2000],
      },
    });
    expect(result.parallelGain.contextDup).toBe(0);
    expect(result.parallelGain.tokenDup).toBe(0);
    expect(result.parallelGain.measured.contextDup).toBe(false);
    expect(result.parallelGain.measured.tokenDup).toBe(false);
  });

  it('every measured:false term is EXACTLY 0 (an unmeasured term never looks measured)', () => {
    const samples = [
      routeTopology({ workflowPlan: inlinePlan() }),
      routeTopology({ intent: intentWith(['a', 'b']), workflowPlan: inlinePlan() }),
      routeTopology({
        workflowPlan: teamPlan(['a', 'b', 'c']),
        evidence: { tasks: [{ affectedPaths: ['src/x.js'] }] },
      }),
      routeTopology({
        workflowPlan: teamPlan(['a', 'b']),
        evidence: { spawnDurationsMs: ['nope', null] },
      }),
    ];
    for (const sample of samples) {
      for (const [term, isMeasured] of Object.entries(sample.parallelGain.measured)) {
        if (!isMeasured) expect(sample.parallelGain[term]).toBe(0);
      }
    }
  });

  it('mergeRisk is measured only when >=2 tasks carry affected paths', () => {
    const one = routeTopology({
      workflowPlan: teamPlan(['a', 'b']),
      evidence: { tasks: [{ affectedPaths: ['src/a.js'] }] },
    });
    expect(one.parallelGain.measured.mergeRisk).toBe(false);
    expect(one.parallelGain.mergeRisk).toBe(0);

    const two = routeTopology({
      workflowPlan: teamPlan(['a', 'b']),
      evidence: { tasks: [{ affectedPaths: ['src/a.js'] }, { affectedPaths: ['src/b.js'] }] },
    });
    expect(two.parallelGain.measured.mergeRisk).toBe(true);
  });

  it('tasks with EMPTY affectedPaths do not count toward the mergeRisk sample', () => {
    const result = routeTopology({
      workflowPlan: teamPlan(['a', 'b']),
      evidence: { tasks: [{ affectedPaths: ['src/a.js'] }, { affectedPaths: [] }, { id: 'no-paths' }] },
    });
    expect(result.parallelGain.measured.mergeRisk).toBe(false);
  });

  it('fully disjoint paths give mergeRisk 0 WITH measured:true (a measured zero)', () => {
    const result = routeTopology({
      workflowPlan: teamPlan(['a', 'b']),
      evidence: {
        tasks: [
          { affectedPaths: ['lib/topology/topology-router.js'] },
          { affectedPaths: ['scripts/hooks/pre-bash.js'] },
        ],
      },
    });
    expect(result.parallelGain.mergeRisk).toBe(0);
    expect(result.parallelGain.measured.mergeRisk).toBe(true);
  });

  it('overlapping paths raise mergeRisk to the full weight when every pair conflicts', () => {
    const result = routeTopology({
      workflowPlan: teamPlan(['a', 'b']),
      evidence: {
        tasks: [{ affectedPaths: ['src/shared.js'] }, { affectedPaths: ['src/shared.js'] }],
      },
    });
    expect(result.parallelGain.mergeRisk).toBe(DEFAULT_GAIN_WEIGHTS.mergeRisk);
  });

  it('mergeRisk is the conflicting-pair FRACTION, not a count', () => {
    // 3 tasks = 3 pairs; a+b conflict on src/shared, c is disjoint => 1/3.
    const result = routeTopology({
      workflowPlan: teamPlan(['a', 'b', 'c']),
      evidence: {
        tasks: [
          { affectedPaths: ['src/shared.js'] },
          { affectedPaths: ['src/shared.js'] },
          { affectedPaths: ['docs/readme.md'] },
        ],
      },
    });
    expect(result.parallelGain.mergeRisk).toBeCloseTo(DEFAULT_GAIN_WEIGHTS.mergeRisk / 3, 4);
  });

  it('startup is measured from supplied spawn durations and uses the MEDIAN', () => {
    // Median of [1000, 30000, 90000] is 30000 => 30000/60000 = 0.5.
    const result = routeTopology({
      workflowPlan: teamPlan(['a', 'b']),
      evidence: { spawnDurationsMs: [90000, 1000, 30000] },
    });
    expect(result.parallelGain.measured.startup).toBe(true);
    expect(result.parallelGain.startup).toBeCloseTo(DEFAULT_GAIN_WEIGHTS.startup * 0.5, 4);
  });

  it('a median at or above the reference window saturates startup at the full weight', () => {
    const result = routeTopology({
      workflowPlan: teamPlan(['a', 'b']),
      evidence: { spawnDurationsMs: [DEFAULT_STARTUP_REFERENCE_MS * 10] },
    });
    expect(result.parallelGain.startup).toBe(DEFAULT_GAIN_WEIGHTS.startup);
  });

  it('a solo run pays no startup even with durations present (measured, but zero)', () => {
    const result = routeTopology({
      workflowPlan: inlinePlan(),
      evidence: { spawnDurationsMs: [30000] },
    });
    expect(result.parallelGain.measured.startup).toBe(true);
    expect(result.parallelGain.startup).toBe(0);
  });

  it('non-finite duration entries are discarded, not coerced', () => {
    const result = routeTopology({
      workflowPlan: teamPlan(['a', 'b']),
      evidence: { spawnDurationsMs: [NaN, 'abc', undefined, -5, 30000] },
    });
    expect(result.parallelGain.startup).toBeCloseTo(DEFAULT_GAIN_WEIGHTS.startup * 0.5, 4);
  });
});

describe('routeTopology — ParallelGain arithmetic', () => {
  it('work is (n-1)/n of the work weight', () => {
    const four = routeTopology({ workflowPlan: teamPlan(['a', 'b', 'c', 'd']) });
    expect(four.parallelGain.work).toBeCloseTo(DEFAULT_GAIN_WEIGHTS.work * 0.75, 4);
  });

  it('a single sub-objective parallelizes nothing', () => {
    const one = routeTopology({ workflowPlan: teamPlan(['a']) });
    expect(one.parallelGain.work).toBe(0);
    expect(one.parallelGain.coordination).toBe(0);
  });

  it('coordination saturates at the full weight for large fan-outs', () => {
    const big = routeTopology({ workflowPlan: teamPlan(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) });
    expect(big.parallelGain.coordination).toBe(DEFAULT_GAIN_WEIGHTS.coordination);
  });

  it('net equals work minus every cost term', () => {
    const result = routeTopology({
      workflowPlan: teamPlan(['a', 'b', 'c']),
      evidence: {
        tasks: [{ affectedPaths: ['src/shared.js'] }, { affectedPaths: ['src/shared.js'] }],
        spawnDurationsMs: [30000],
      },
    });
    const g = result.parallelGain;
    const expected = g.work - g.coordination - g.contextDup - g.mergeRisk - g.startup - g.tokenDup;
    expect(g.net).toBeCloseTo(expected, 4);
  });

  it('net can go negative when the costs exceed the parallelizable work', () => {
    const result = routeTopology({
      workflowPlan: teamPlan(['a', 'b']),
      evidence: {
        tasks: [{ affectedPaths: ['src/shared.js'] }, { affectedPaths: ['src/shared.js'] }],
        spawnDurationsMs: [DEFAULT_STARTUP_REFERENCE_MS],
      },
    });
    // work 0.5 - coordination 0.1 - mergeRisk 0.75 - startup 0.25 = -0.6
    expect(result.parallelGain.net).toBeLessThan(0);
  });

  it('config weights override the defaults per key', () => {
    const config = { topology: { parallelGain: { weights: { work: 2 } } } };
    const result = routeTopology({ workflowPlan: teamPlan(['a', 'b']), config });
    expect(result.parallelGain.work).toBeCloseTo(1, 4);
    // Untouched key keeps its default rather than collapsing to zero.
    expect(result.parallelGain.coordination).toBeCloseTo(DEFAULT_GAIN_WEIGHTS.coordination * 0.2, 4);
  });

  it('a malformed weight falls back for THAT key only', () => {
    const config = { topology: { parallelGain: { weights: { work: 'heavy', coordination: 0 } } } };
    const result = routeTopology({ workflowPlan: teamPlan(['a', 'b']), config });
    expect(result.parallelGain.work).toBeCloseTo(DEFAULT_GAIN_WEIGHTS.work * 0.5, 4);
    expect(result.parallelGain.coordination).toBe(0);
  });

  it('a configured startup reference window is honoured', () => {
    const config = { topology: { parallelGain: { startupReferenceMs: 10000 } } };
    const result = routeTopology({
      workflowPlan: teamPlan(['a', 'b']),
      config,
      evidence: { spawnDurationsMs: [5000] },
    });
    expect(result.parallelGain.startup).toBeCloseTo(DEFAULT_GAIN_WEIGHTS.startup * 0.5, 4);
  });
});

describe('routeTopology — config is read, never applied (Observe)', () => {
  it('config.topology.default does NOT override the derived mode', () => {
    const config = { topology: { default: 'team' } };
    const result = routeTopology({ workflowPlan: inlinePlan(), config });
    expect(result.mode).toBe('solo');
    expect(result.reason).toContain('config-default-ignored:team');
  });

  it('no divergence line is recorded when the default already agrees', () => {
    const config = { topology: { default: 'solo' } };
    const result = routeTopology({ workflowPlan: inlinePlan(), config });
    expect(result.mode).toBe('solo');
    expect(result.reason.some((r) => r.startsWith('config-default-ignored:'))).toBe(false);
  });

  it('the shipped config default is solo and is still not applied to a team plan', () => {
    expect(realConfig.topology.default).toBe('solo');
    const result = routeTopology({ workflowPlan: teamPlan(['a', 'b']), config: realConfig });
    expect(result.mode).toBe('team');
    expect(result.reason).toContain('config-default-ignored:solo');
  });

  it('autopilot_fast resolves its four *Ref pointers against the real config', () => {
    const result = routeTopology({
      workflowPlan: inlinePlan(),
      config: realConfig,
      evidence: { promptText: '--fast' },
    });
    expect(result.mode).toBe('autopilot_fast');
    expect(result.reason).toContain(
      `policy:autopilot_fast.hardMaxAgents=${realConfig.autopilot.fast.hardMaxAgents}(observe-only)`,
    );
    expect(result.reason).toContain(
      `policy:autopilot_fast.maxRisk=${JSON.stringify(realConfig.autopilot.fast.maxRisk)}(observe-only)`,
    );
    // Read-only: none of the resolved numbers changed the mode or the gain.
    expect(result.exception).toBe('autopilot_fast');
  });

  it('split resolves its three *Ref pointers against the real config', () => {
    const result = routeTopology({ workflowPlan: inlinePlan('split'), config: realConfig });
    expect(result.reason).toContain(`policy:split.maxWindows=${realConfig.split.maxWindows}(observe-only)`);
    expect(result.reason).toContain(`policy:split.minStems=${realConfig.split.minStems}(observe-only)`);
    expect(result.reason).toContain(
      `policy:split.dispatchBudget=${realConfig.split.dispatch.budget}(observe-only)`,
    );
  });

  it('a dangling *Ref renders as unset instead of throwing', () => {
    const config = { topology: { split: { maxWindowsRef: 'nope.not.here', minStemsRef: 'split.minStems' }, default: 'solo' }, split: { minStems: 2 } };
    const result = routeTopology({ workflowPlan: inlinePlan('split'), config });
    expect(result.reason).toContain('policy:split.maxWindows=unset(observe-only)');
    expect(result.reason).toContain('policy:split.minStems=2(observe-only)');
  });

  it('a missing topology section records absence rather than silently skipping', () => {
    const result = routeTopology({ workflowPlan: inlinePlan('split'), config: {} });
    expect(result.reason).toContain('policy:split=absent');
  });

  it('modes without a policy section emit no policy lines', () => {
    const result = routeTopology({ workflowPlan: teamPlan(['a', 'b']), config: realConfig });
    expect(result.reason.some((r) => r.startsWith('policy:'))).toBe(false);
  });
});

describe('routeTopology — human gates (classification only)', () => {
  it('an absent matrix yields [] AND says so, so it is not read as zero hits', () => {
    const result = routeTopology({ workflowPlan: inlinePlan(), evidence: { plannedActions: ['git push'] } });
    expect(result.humanGateHits).toEqual([]);
    expect(result.reason).toContain('human-gates:unavailable');
  });

  it('absent plannedActions also counts as unavailable', () => {
    const result = routeTopology({
      workflowPlan: inlinePlan(),
      evidence: { humanGateMatrix: [{ id: 'HG-03', patterns: ['gh release'] }] },
    });
    expect(result.reason).toContain('human-gates:unavailable');
  });

  it('a supplied matrix with zero matches is a CHECKED zero, not unavailable', () => {
    const result = routeTopology({
      workflowPlan: inlinePlan(),
      evidence: {
        humanGateMatrix: [{ id: 'HG-03', patterns: ['gh release'] }],
        plannedActions: ['npm test'],
      },
    });
    expect(result.humanGateHits).toEqual([]);
    expect(result.reason).not.toContain('human-gates:unavailable');
  });

  it('string patterns match by substring and report the row id', () => {
    const result = routeTopology({
      workflowPlan: inlinePlan(),
      evidence: {
        humanGateMatrix: [
          { id: 'HG-03', patterns: ['gh release', 'docker push'] },
          { id: 'HG-09', patterns: ['push origin master'] },
        ],
        plannedActions: ['gh release create v1', 'git push origin master'],
      },
    });
    expect(result.humanGateHits).toEqual(['HG-03', 'HG-09']);
  });

  it('RegExp patterns are supported', () => {
    const result = routeTopology({
      workflowPlan: inlinePlan(),
      evidence: {
        humanGateMatrix: [{ id: 'HG-04', patterns: [/curl\s+-X\s+(POST|DELETE)/] }],
        plannedActions: ['curl -X POST https://example.test'],
      },
    });
    expect(result.humanGateHits).toEqual(['HG-04']);
  });

  it('a row id is reported at most once even when several patterns match', () => {
    const result = routeTopology({
      workflowPlan: inlinePlan(),
      evidence: {
        humanGateMatrix: [{ id: 'HG-03', patterns: ['gh release', 'docker push'] }],
        plannedActions: ['gh release create v1', 'docker push img'],
      },
    });
    expect(result.humanGateHits).toEqual(['HG-03']);
  });

  it('a malformed matrix row is skipped without throwing', () => {
    const result = routeTopology({
      workflowPlan: inlinePlan(),
      evidence: {
        humanGateMatrix: [null, { patterns: ['x'] }, { id: 'HG-01', patterns: ['deploy'] }],
        plannedActions: ['deploy now'],
      },
    });
    expect(result.humanGateHits).toEqual(['HG-01']);
  });

  it('gate hits never change the mode (the router classifies, it does not enforce)', () => {
    const without = routeTopology({ workflowPlan: teamPlan(['a', 'b']), config: realConfig });
    const withHits = routeTopology({
      workflowPlan: teamPlan(['a', 'b']),
      config: realConfig,
      evidence: {
        humanGateMatrix: [{ id: 'HG-03', patterns: ['gh release'] }],
        plannedActions: ['gh release create v1'],
      },
    });
    expect(withHits.humanGateHits).toEqual(['HG-03']);
    expect(withHits.mode).toBe(without.mode);
    expect(withHits.parallelGain.net).toBe(without.parallelGain.net);
  });
});

describe('routeTopology — sub-objective sourcing', () => {
  it('teammates are used when the plan carries them', () => {
    const result = routeTopology({
      intent: intentWith(['x']),
      workflowPlan: teamPlan(['a', 'b', 'c']),
    });
    expect(result.reason).toContain('subs:3');
    expect(result.reason).toContain('domains:3');
  });

  it('intent.recommendations are used when teammates is empty (the inline case)', () => {
    const result = routeTopology({
      intent: intentWith(['a', 'b']),
      workflowPlan: inlinePlan(),
    });
    expect(result.reason).toContain('subs:2');
  });

  it('teammates without agent names count as subs but contribute no domain', () => {
    const result = routeTopology({
      workflowPlan: { runner: 'team', recommendation: null, teammates: [{ command: 'a' }, { command: 'b' }] },
    });
    expect(result.reason).toContain('subs:2');
    expect(result.reason).toContain('domains:0');
  });

  it('domains:0 does not satisfy the subagent rule (which requires exactly one)', () => {
    const result = routeTopology({
      intent: { recommendations: [{ commands: ['a'] }, { commands: ['b'] }] },
      workflowPlan: inlinePlan(),
    });
    expect(result.mode).toBe('solo');
  });
});

describe('routeTopology — confidence', () => {
  it('an explicit NL signal outranks an inferred one', () => {
    const explicit = routeTopology({ workflowPlan: inlinePlan(), evidence: { promptText: '/split plan' } });
    const inferred = routeTopology({ intent: intentWith(['a', 'a']), workflowPlan: inlinePlan() });
    expect(explicit.confidence).toBeGreaterThan(inferred.confidence);
  });

  it('more measured terms raise confidence for the same signal', () => {
    const bare = routeTopology({ workflowPlan: teamPlan(['a', 'b']) });
    const measured = routeTopology({
      workflowPlan: teamPlan(['a', 'b']),
      evidence: {
        tasks: [{ affectedPaths: ['src/a.js'] }, { affectedPaths: ['src/b.js'] }],
        spawnDurationsMs: [1000],
      },
    });
    expect(measured.confidence).toBeGreaterThan(bare.confidence);
  });

  it('confidence never leaves [0,1] and never reaches 1 while two terms are unmeasurable', () => {
    const best = routeTopology({
      workflowPlan: teamPlan(['a', 'b']),
      evidence: {
        promptText: '/split plan',
        tasks: [{ affectedPaths: ['src/a.js'] }, { affectedPaths: ['src/b.js'] }],
        spawnDurationsMs: [1000],
      },
    });
    expect(best.confidence).toBeGreaterThan(0);
    expect(best.confidence).toBeLessThan(1);
  });
});

describe('routeTopology — purity and shape', () => {
  it('accepts a fully empty call without throwing', () => {
    const result = routeTopology();
    expect(result.mode).toBe('solo');
    expect(result.humanGateHits).toEqual([]);
  });

  it('tolerates null and wrong-typed inputs', () => {
    const result = routeTopology({
      intent: null,
      workflowPlan: 'not-a-plan',
      config: 42,
      evidence: ['nope'],
    });
    expect(TOPOLOGY_MODES).toContain(result.mode);
  });

  it('returns the full documented contract', () => {
    const result = routeTopology({ workflowPlan: teamPlan(['a', 'b']), config: realConfig });
    expect(Object.keys(result).sort()).toEqual(
      ['confidence', 'exception', 'humanGateHits', 'mode', 'parallelGain', 'reason'].sort(),
    );
    expect(Object.keys(result.parallelGain).sort()).toEqual(
      ['contextDup', 'coordination', 'measured', 'mergeRisk', 'net', 'startup', 'tokenDup', 'work'].sort(),
    );
    expect(Object.keys(result.parallelGain.measured).sort()).toEqual(
      ['contextDup', 'coordination', 'mergeRisk', 'startup', 'tokenDup', 'work'].sort(),
    );
  });

  it('the result and its nested objects are frozen', () => {
    const result = routeTopology({ workflowPlan: inlinePlan() });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.reason)).toBe(true);
    expect(Object.isFrozen(result.parallelGain)).toBe(true);
    expect(Object.isFrozen(result.parallelGain.measured)).toBe(true);
    expect(Object.isFrozen(result.humanGateHits)).toBe(true);
  });

  it('is deterministic — identical inputs give a byte-identical record', () => {
    const args = {
      intent: intentWith(['a', 'b']),
      workflowPlan: teamPlan(['a', 'b']),
      config: realConfig,
      evidence: {
        promptText: '작업량이 크니까 여러 작업으로 나눠 동시에 해.',
        tasks: [{ affectedPaths: ['src/a.js'] }, { affectedPaths: ['src/a.js'] }],
        spawnDurationsMs: [1234, 5678],
      },
    };
    expect(JSON.stringify(routeTopology(args))).toBe(JSON.stringify(routeTopology(args)));
  });

  it('does not mutate its arguments', () => {
    const intent = intentWith(['a', 'b']);
    const plan = teamPlan(['a', 'b']);
    const evidence = { tasks: [{ affectedPaths: ['src/a.js'] }, { affectedPaths: ['src/b.js'] }] };
    const before = JSON.stringify({ intent, plan, evidence });
    routeTopology({ intent, workflowPlan: plan, config: realConfig, evidence });
    expect(JSON.stringify({ intent, plan, evidence })).toBe(before);
  });

  it('imports nothing above its layer (L4 may only reach down)', async () => {
    const source = readFileSync(path.join(repoRoot, 'lib/topology/topology-router.js'), 'utf8');
    const imports = [...source.matchAll(/^import[^;]*from\s+'([^']+)'/gm)].map((m) => m[1]);
    expect(imports).toEqual(['../autopilot/fast-profile.js']);
    // No runtime layer, no I/O, no clock — the purity claim, checked.
    expect(source).not.toMatch(/from\s+'node:fs'/);
    expect(source).not.toMatch(/Date\.now\(\)/);
    expect(source).not.toMatch(/Math\.random\(\)/);
  });

  it('the module header states the pattern counts the lexicon actually has', () => {
    // The header claims "9 patterns — 7 natural-language rows ... plus 2
    // literal-invocation rows". A prose count rots the moment someone adds a
    // row, and a rotted count in a header is how the previous "not a
    // classifier" contradiction survived review. Count the source instead.
    const source = readFileSync(path.join(repoRoot, 'lib/topology/topology-router.js'), 'utf8');
    const ids = [...source.matchAll(/\{ id: '([a-z-]+)', re: /g)].map((m) => m[1]);
    expect(ids).toHaveLength(9);
    expect(ids.filter((id) => id.startsWith('nl-'))).toHaveLength(7);
    expect(ids.filter((id) => id.startsWith('flag-'))).toHaveLength(2);
  });
});

/**
 * Drift gate against `lib/intent/interpreter.js` (T-49 review #1).
 *
 * Two modules independently transcribe ONE design table — v5 §07's activation
 * phrases. `interpreter.js:155-175` cites the very same two sentences this
 * router keys on, and `PERFORMANCE_CUES.maximum_performance` holds the literal
 * `'토큰 아끼지 말고'` that `nl-fast-spend-tokens` also matches. Nothing links
 * them, so they can drift apart in silence. These tests import the interpreter
 * (a legal L4 -> L2 direction) and pin the CURRENT measured relationship in
 * both directions: where the modules agree, and the one design sentence where
 * they do NOT.
 *
 * Deliberately NOT done here: making them agree. The disagreement is a real
 * property of two lexicons written from one table, and the fix (if it is one)
 * belongs to whoever owns the interpreter's cue list, not to a gate. Widening
 * this router's patterns to manufacture agreement would be shaving the gate.
 */
describe('routeTopology — interpreter.js drift gate', () => {
  const FAST_PHRASES = [
    '최대한 빨리 정확하게 끝내줘.',
    '토큰 아끼지 말고 제대로 처리해.',
    '시간이 중요해. 병렬로 최대한 진행해.',
  ];

  it('the interpreter still exports the seams this gate depends on', () => {
    expect(typeof cueMatches).toBe('function');
    expect(typeof interpretIntent).toBe('function');
    expect(Object.keys(PERFORMANCE_CUES)).toContain('maximum_performance');
  });

  it('the shared cue string is still literally present in the interpreter lexicon', () => {
    // `nl-fast-spend-tokens` (/토큰\s*아끼지\s*말/) and this entry are the same
    // design phrase written twice. If the interpreter renames or drops it, the
    // two modules have diverged and this goes red.
    expect(PERFORMANCE_CUES.maximum_performance).toContain('토큰 아끼지 말고');
    expect(cueMatches('토큰 아끼지 말고 제대로 처리해.', '토큰 아끼지 말고')).toBe(true);
  });

  it.each([
    ['최대한 빨리 정확하게 끝내줘.', 'fast'],
    ['토큰 아끼지 말고 제대로 처리해.', 'maximum_performance'],
  ])('agreement: %s routes autopilot_fast here and resolves to %s there', (prompt, performance) => {
    expect(routeTopology({ workflowPlan: inlinePlan(), evidence: { promptText: prompt } }).mode)
      .toBe('autopilot_fast');
    const interpreted = interpretIntent({ prompt });
    expect(interpreted.performance).toBe(performance);
    // Not a fallback — the interpreter actually matched a cue for this phrase.
    expect(interpreted.defaulted).not.toContain('performance');
  });

  it('DISAGREEMENT (measured 2026-09-02): the third fast phrase fires no interpreter cue', () => {
    // This router routes '시간이 중요해...' to autopilot_fast via
    // `nl-fast-time-matters`. The interpreter has no cue for it — not '시간이
    // 중요', not '병렬' — so its performance axis DEFAULTS to 'balanced', the
    // opposite end from "spend freely, go fast".
    //
    // Pinned, not fixed. If someone adds a matching cue to the interpreter this
    // test goes red, which is the point: the realignment should be a decision
    // someone makes, not a coincidence nobody notices.
    const prompt = '시간이 중요해. 병렬로 최대한 진행해.';
    expect(routeTopology({ workflowPlan: inlinePlan(), evidence: { promptText: prompt } }).mode)
      .toBe('autopilot_fast');
    const interpreted = interpretIntent({ prompt });
    expect(interpreted.performance).toBe('balanced');
    expect(interpreted.defaulted).toContain('performance');
  });

  it('no fast phrase is read by the interpreter as the OPPOSITE pole (economy)', () => {
    // The invariant that would actually be a bug: this router reading a phrase
    // as "spend more, go fast" while the interpreter reads it as "save tokens".
    // 'balanced' (no signal) is a gap; 'economy' would be a contradiction.
    for (const prompt of FAST_PHRASES) {
      expect(interpretIntent({ prompt }).performance).not.toBe('economy');
    }
  });

  it('split phrases have NO counterpart on the interpreter performance axis', () => {
    // Documented non-overlap, so a future reader does not mistake the absence
    // of a split assertion for an oversight. `split` is a topology decision;
    // the interpreter's performance axis is about spend-vs-speed and says
    // nothing about how many windows the work is divided into. All three split
    // sentences therefore default, and asserting "same axis" for them would be
    // asserting a correspondence that does not exist.
    const splitPhrases = [
      '작업량이 크니까 여러 작업으로 나눠 동시에 해.',
      '파일별로 병렬 작업하고 합쳐줘.',
      '이 대규모 변경 최대한 병렬로 처리해.',
    ];
    for (const prompt of splitPhrases) {
      expect(routeTopology({ workflowPlan: inlinePlan(), evidence: { promptText: prompt } }).mode)
        .toBe('split');
      expect(interpretIntent({ prompt }).defaulted).toContain('performance');
    }
  });
});
