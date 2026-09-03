/**
 * `lib/recovery/recovery-controller` — failure class -> recommended action.
 *
 * The ladder under test is ADDENDUM-HARDENING section 35. The two rules that
 * counters may not override (unknown goes to a person, framing only ever
 * proposes) get their own blocks, because those are the ones a later tuning
 * pass would be tempted to soften.
 */

import { describe, expect, it } from 'vitest';

import { classify } from '../../lib/recovery/failure-classifier.js';
import { decide, RECOVERY_ACTIONS } from '../../lib/recovery/recovery-controller.js';

/** The payload `engine.js:503` already emits, unchanged. */
const ENGINE_ON_FAILURE = Object.freeze({
  agent: 'build-error-resolver',
  retryLimit: 3,
  escalateTo: 'pause',
});

describe('action vocabulary', () => {
  it('exposes exactly the five recommendable actions', () => {
    expect([...RECOVERY_ACTIONS]).toEqual([
      'repair',
      'replan',
      'propose_ultraplan',
      'ask_human',
      'pause',
    ]);
  });

  it('every decision names an action from that list and a target', () => {
    const classes = ['implementation', 'plan', 'framing', 'human-value', 'unknown', 'nonsense'];
    for (const failureClass of classes) {
      const result = decide(failureClass);
      expect(RECOVERY_ACTIONS).toContain(result.action);
      expect(typeof result.target).toBe('string');
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });
});

describe('unknown always goes to a person', () => {
  it('unknown -> ask_human', () => {
    const result = decide('unknown');
    expect(result.action).toBe('ask_human');
    expect(result.target).toBe('human');
  });

  it('no counter can turn unknown into a machine action', () => {
    const states = [
      {},
      { repairAttempts: 0, replanAttempts: 0 },
      { repairAttempts: 99, replanAttempts: 99, sameClassAttempts: 99 },
      { ultraplanProposed: true },
      { onFailure: { retryLimit: 99, escalateTo: 'repair' } },
    ];
    for (const state of states) {
      expect(decide('unknown', state).action).toBe('ask_human');
    }
  });

  it('escalateTo:"pause" does not downgrade the question to a stop', () => {
    expect(decide('unknown', { onFailure: ENGINE_ON_FAILURE }).action).toBe('ask_human');
  });

  it('an unrecognized classification is handled as unknown, so it asks', () => {
    for (const bogus of ['whatever', '', null, undefined, 42, {}, { class: 'nope' }]) {
      expect(decide(bogus).action).toBe('ask_human');
    }
  });

  it('a classify() result flows straight in', () => {
    expect(decide(classify({ verification: { status: 'UNMEASURED' } })).action).toBe('ask_human');
  });
});

describe('framing proposes an ultraplan and never fires one', () => {
  it('framing -> propose_ultraplan', () => {
    const result = decide('framing');
    expect(result.action).toBe('propose_ultraplan');
    expect(result.target).toBe('mission');
  });

  it('no state produces an action that starts an ultraplan', () => {
    const states = [
      {},
      { repairAttempts: 5 },
      { replanAttempts: 5 },
      { sameClassAttempts: 5 },
      { onFailure: ENGINE_ON_FAILURE },
    ];
    for (const state of states) {
      expect(decide('framing', state).action).toBe('propose_ultraplan');
    }
  });

  it('says in the reason that it is a proposal, not a start', () => {
    expect(decide('framing').reason).toMatch(/PROPOSED, not started/);
  });

  it('once an ultraplan was proposed and it still fails, a person decides', () => {
    const result = decide('framing', { ultraplanProposed: true });
    expect(result.action).toBe('ask_human');
    expect(result.reason).toMatch(/already proposed/);
  });

  it('asking is the default terminal rung when no escalateTo is declared', () => {
    for (const state of [{ ultraplanProposed: true }, { ultraplanProposed: true, onFailure: {} }]) {
      expect(decide('framing', state).action).toBe('ask_human');
    }
  });

  it('an explicit escalateTo:"ask_human" reaches the same place', () => {
    const result = decide('framing', {
      ultraplanProposed: true,
      onFailure: { escalateTo: 'ask_human' },
    });
    expect(result.action).toBe('ask_human');
  });

  it('honours escalateTo:"pause" from the engine payload at the terminal rung', () => {
    const result = decide('framing', {
      ultraplanProposed: true,
      onFailure: ENGINE_ON_FAILURE,
    });
    expect(result.action).toBe('pause');
  });
});

describe('implementation failures: repair, then replan on repeat', () => {
  it('first sighting -> repair', () => {
    const result = decide('implementation', { onFailure: ENGINE_ON_FAILURE });
    expect(result.action).toBe('repair');
    expect(result.target).toBe('implementation');
  });

  it('the same class twice -> replan (section 35 rung 2)', () => {
    const result = decide('implementation', {
      sameClassAttempts: 2,
      onFailure: ENGINE_ON_FAILURE,
    });
    expect(result.action).toBe('replan');
    expect(result.target).toBe('plan');
    expect(result.reason).toMatch(/repeated failure/);
  });

  it('the repeat count is read from a classify() result when the caller has none', () => {
    const first = classify({ verdict: 'REPAIR_REQUIRED', history: [] });
    expect(decide(first).action).toBe('repair');

    const repeat = classify({
      verdict: 'REPAIR_REQUIRED',
      history: [{ class: 'implementation' }],
    });
    expect(repeat.signals.priorSameClass).toBe(1);
    expect(decide(repeat).action).toBe('replan');
  });

  it('an explicit sameClassAttempts overrides the classifier signal', () => {
    const repeat = classify({
      verdict: 'REPAIR_REQUIRED',
      history: [{ class: 'implementation' }],
    });
    expect(decide(repeat, { sameClassAttempts: 1 }).action).toBe('repair');
  });

  it('repairs are capped by onFailure.retryLimit even on a first sighting', () => {
    const spent = { repairAttempts: 3, onFailure: ENGINE_ON_FAILURE };
    const result = decide('implementation', spent);
    expect(result.action).toBe('replan');
    expect(result.reason).toMatch(/onFailure\.retryLimit/);
  });

  it('stays on repair while budget remains', () => {
    for (const repairAttempts of [0, 1, 2]) {
      expect(decide('implementation', { repairAttempts, onFailure: ENGINE_ON_FAILURE }).action)
        .toBe('repair');
    }
  });

  it('retryLimit 0 means no repair at all', () => {
    expect(decide('implementation', { onFailure: { retryLimit: 0 } }).action).toBe('replan');
  });

  it('defaults to the retryLimit of 3 the engine emits when onFailure is absent', () => {
    expect(decide('implementation', { repairAttempts: 2 }).action).toBe('repair');
    expect(decide('implementation', { repairAttempts: 3 }).action).toBe('replan');
  });
});

describe('plan failures: replan, then propose an ultraplan', () => {
  it('plan -> replan', () => {
    expect(decide('plan').action).toBe('replan');
  });

  it('stays on replan below the limit', () => {
    expect(decide('plan', { replanAttempts: 1, replanLimit: 2 }).action).toBe('replan');
  });

  it('multiple replans -> propose_ultraplan (section 35 rung 3)', () => {
    const result = decide('plan', { replanAttempts: 2 });
    expect(result.action).toBe('propose_ultraplan');
    expect(result.reason).toMatch(/multiple replans/);
  });

  it('honours an explicit replanLimit', () => {
    expect(decide('plan', { replanAttempts: 2, replanLimit: 5 }).action).toBe('replan');
    expect(decide('plan', { replanAttempts: 5, replanLimit: 5 }).action).toBe('propose_ultraplan');
  });

  it('replanLimit 0 goes straight to the ultraplan rung', () => {
    expect(decide('plan', { replanLimit: 0 }).action).toBe('propose_ultraplan');
  });
});

describe('the ladder cascades in one call', () => {
  it('a repeated implementation failure after two replans reaches propose_ultraplan', () => {
    const result = decide('implementation', {
      sameClassAttempts: 2,
      replanAttempts: 2,
      onFailure: ENGINE_ON_FAILURE,
    });
    expect(result.action).toBe('propose_ultraplan');
  });

  it('and once an ultraplan was already proposed, it reaches the terminal rung', () => {
    const result = decide('implementation', {
      sameClassAttempts: 2,
      replanAttempts: 2,
      ultraplanProposed: true,
      onFailure: ENGINE_ON_FAILURE,
    });
    expect(result.action).toBe('pause');
    expect(result.reason).toMatch(/escalateTo/);
  });

  it('the cascade reason names every rung it climbed', () => {
    const reason = decide('implementation', {
      sameClassAttempts: 2,
      replanAttempts: 2,
      onFailure: ENGINE_ON_FAILURE,
    }).reason;
    expect(reason).toMatch(/repeated failure/);
    expect(reason).toMatch(/multiple replans/);
  });
});

describe('human-value failures', () => {
  it('human-value -> ask_human, whatever escalateTo says', () => {
    expect(decide('human-value').action).toBe('ask_human');
    expect(decide('human-value', { onFailure: ENGINE_ON_FAILURE }).action).toBe('ask_human');
  });

  it('explains that no machine rung sits below it', () => {
    expect(decide('human-value').reason).toMatch(/value decision/);
  });

  it('BLOCK and INTENT_REVIEW_REQUIRED both land there end to end', () => {
    for (const verdict of ['BLOCK', 'INTENT_REVIEW_REQUIRED']) {
      expect(decide(classify({ verdict }), { onFailure: ENGINE_ON_FAILURE }).action)
        .toBe('ask_human');
    }
  });
});

describe('end to end over all five verdicts', () => {
  const attemptState = { onFailure: ENGINE_ON_FAILURE };

  it.each([
    ['PASS', 'ask_human'],
    ['REPAIR_REQUIRED', 'repair'],
    ['REPLAN_REQUIRED', 'replan'],
    ['INTENT_REVIEW_REQUIRED', 'ask_human'],
    ['BLOCK', 'ask_human'],
  ])('%s (no history) -> %s', (verdict, expected) => {
    expect(decide(classify({ verdict }), attemptState).action).toBe(expected);
  });

  it.each([
    ['PASS', 'ask_human'],
    ['REPAIR_REQUIRED', 'replan'],
    ['REPLAN_REQUIRED', 'replan'],
    ['INTENT_REVIEW_REQUIRED', 'ask_human'],
    ['BLOCK', 'ask_human'],
  ])('%s (one prior of the same class) -> %s', (verdict, expected) => {
    const history = [{ class: classify({ verdict }).class }];
    expect(decide(classify({ verdict, history }), attemptState).action).toBe(expected);
  });

  it('REPLAN_REQUIRED with an architecture contradiction only ever proposes', () => {
    const classification = classify({
      verdict: 'REPLAN_REQUIRED',
      planDelta: { contradictions: ['two owners for one path'] },
    });
    expect(classification.class).toBe('framing');
    expect(decide(classification, attemptState).action).toBe('propose_ultraplan');
  });
});

describe('purity', () => {
  it('does not mutate attemptState', () => {
    const state = {
      repairAttempts: 1,
      replanAttempts: 1,
      onFailure: { ...ENGINE_ON_FAILURE },
    };
    const snapshot = JSON.stringify(state);
    decide('implementation', state);
    expect(JSON.stringify(state)).toBe(snapshot);
  });

  it('does not mutate the classification', () => {
    const classification = classify({ verdict: 'REPAIR_REQUIRED' });
    const snapshot = JSON.stringify(classification);
    decide(classification, { repairAttempts: 9 });
    expect(JSON.stringify(classification)).toBe(snapshot);
  });

  it('is deterministic for the same inputs', () => {
    const state = { sameClassAttempts: 2, onFailure: ENGINE_ON_FAILURE };
    expect(decide('implementation', state)).toEqual(decide('implementation', state));
  });

  it('returns a frozen result', () => {
    expect(Object.isFrozen(decide('plan'))).toBe(true);
  });

  it('tolerates a malformed attemptState', () => {
    for (const state of [null, undefined, 'nope', 42, { onFailure: 'nope' }]) {
      expect(RECOVERY_ACTIONS).toContain(decide('implementation', state).action);
    }
  });
});
