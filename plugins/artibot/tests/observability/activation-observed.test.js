/**
 * The pure half of the NL-activation writer.
 *
 * WHAT THIS SUITE CANNOT SEE:
 *  1. It never writes a file. Persistence, the store gate and the recorder's
 *     own field filtering are `tests/observability/decision-events-activation.test.js`.
 *  2. It never runs the hook. That `scripts/hooks/runtime-prompt.js` actually
 *     calls the recorder on a real prompt is the sibling limb's wiring test;
 *     nothing here proves a single live record exists.
 *  3. The parity cases feed a synthetic `{mode}` rather than a real
 *     `routeTopology` result, so they prove the projection agrees, not that the
 *     router can produce every mode named.
 */

import { describe, expect, it } from 'vitest';
import { projectCommandActivation } from '../../lib/mission/compiler.js';
import {
  ACTIVATION_DATA_KEYS,
  buildActivationRecord,
  derivePredictedSignal,
  extractNlMatch,
  HINT_SLASH_MAP,
  MEASURABLE_ACTIVATION_KEYS,
  PREDICTED_SIGNALS,
  resolveHint,
  UNMEASURED_ACTIVATION_KEYS,
} from '../../lib/observability/activation-observed.js';

/** Every mode `topology-router.js#decideMode` can return (read 2026-09-17). */
const ALL_MODES = ['solo', 'subagent', 'team', 'autopilot', 'autopilot_fast', 'split'];

describe('command_activation is the compiler projection, not a second opinion', () => {
  for (const mode of ALL_MODES) {
    it(`projects ${mode} exactly as projectCommandActivation does`, () => {
      const { command_activation: actual } = buildActivationRecord({ topology: { mode } });
      expect(actual).toEqual(projectCommandActivation({ topology: { mode } }));
    });
  }

  it('sets exactly the three measurable keys, and only autopilot_fast sets two true', () => {
    // The projection's own contract, asserted on values rather than on shape:
    // `autopilot` is deliberately true for autopilot_fast (compiler.js:399), so
    // a `/autopilot` prompt agrees with an autopilot_fast prediction.
    const fast = buildActivationRecord({ topology: { mode: 'autopilot_fast' } }).command_activation;
    expect(Object.keys(fast).sort()).toEqual([...MEASURABLE_ACTIVATION_KEYS].sort());
    expect(fast).toEqual({ autopilot: true, autopilot_fast: true, split: false });

    const split = buildActivationRecord({ topology: { mode: 'split' } }).command_activation;
    expect(split).toEqual({ autopilot: false, autopilot_fast: false, split: true });
  });

  it('never emits the keys that have no runtime producer', () => {
    for (const mode of ALL_MODES) {
      const { command_activation: a } = buildActivationRecord({ topology: { mode } });
      for (const absent of UNMEASURED_ACTIVATION_KEYS) {
        expect(Object.keys(a)).not.toContain(absent);
      }
    }
  });

  it('is null when there is no mode to project', () => {
    expect(buildActivationRecord({}).command_activation).toBeNull();
    expect(buildActivationRecord({ topology: {} }).command_activation).toBeNull();
    expect(buildActivationRecord({ topology: { mode: 42 } }).command_activation).toBeNull();
    expect(buildActivationRecord().command_activation).toBeNull();
  });

  it('projects an unknown mode to three false flags rather than null', () => {
    // Fail-visible, not fail-silent: the compiler still emits the three keys,
    // so a new router mode lands in the denominator as "predicted nothing"
    // instead of vanishing from the count.
    expect(buildActivationRecord({ topology: { mode: 'quantum' } }).command_activation)
      .toEqual({ autopilot: false, autopilot_fast: false, split: false });
  });
});

describe('derivePredictedSignal() mirrors decideMode', () => {
  const table = [
    ['solo', [], 'config-default'],
    ['subagent', ['subs:3'], 'inference'],
    ['team', ['runner:team'], 'runner'],
    ['autopilot', ['recommendation:autopilot'], 'recommendation'],
    ['split', ['recommendation:split'], 'recommendation'],
    ['autopilot_fast', ['nl-match:flag-fast'], 'nl-explicit'],
    ['split', ['nl-match:flag-split'], 'nl-explicit'],
  ];
  for (const [mode, reason, expected] of table) {
    it(`maps ${mode} + [${reason}] to ${expected}`, () => {
      expect(derivePredictedSignal(mode, reason)).toBe(expected);
      expect(PREDICTED_SIGNALS).toContain(expected);
    });
  }

  it('lets nl-match win over the mode, because decideMode returns on it first', () => {
    // A split reached by pattern is "the user said so", not "the planner
    // guessed". Collapsing the two would make the axis unable to tell them
    // apart, so this is the one ordering that matters.
    expect(derivePredictedSignal('split', ['recommendation:split', 'nl-match:flag-split']))
      .toBe('nl-explicit');
  });

  it('returns null for a mode it does not know and a non-array reason', () => {
    expect(derivePredictedSignal('quantum', [])).toBeNull();
    expect(derivePredictedSignal(null, null)).toBeNull();
    expect(derivePredictedSignal('autopilot_fast', [])).toBeNull();
    expect(derivePredictedSignal('solo', 'runner:inline')).toBe('config-default');
  });
});

describe('extractNlMatch() keeps ids and drops anything that is not one', () => {
  it('returns the id of the first nl-match literal', () => {
    expect(extractNlMatch(['runner:inline', 'nl-match:nl-split-per-file'])).toBe('nl-split-per-file');
    expect(extractNlMatch(['nl-match:flag-split', 'nl-match:flag-fast'])).toBe('flag-split');
  });

  it('returns null when there is no nl-match literal', () => {
    expect(extractNlMatch(['runner:team', 'subs:2'])).toBeNull();
    expect(extractNlMatch([])).toBeNull();
    expect(extractNlMatch(undefined)).toBeNull();
    expect(extractNlMatch('nl-match:flag-split')).toBeNull();
  });

  it('drops an id carrying characters the router never produces', () => {
    expect(extractNlMatch(['nl-match:'])).toBeNull();
    expect(extractNlMatch(['nl-match:has space'])).toBeNull();
    expect(extractNlMatch(['nl-match:UPPER'])).toBeNull();
    expect(extractNlMatch([`nl-match:${'a'.repeat(33)}`])).toBeNull();
  });
});

describe('activation_observed carries a validated slash name or nothing', () => {
  it('keeps a well-formed command name', () => {
    expect(buildActivationRecord({ topology: { mode: 'split' }, slashCommand: 'split' })
      .activation_observed).toEqual({ slash: 'split' });
    expect(buildActivationRecord({ slashCommand: 'autopilot_fast' })
      .activation_observed).toEqual({ slash: 'autopilot_fast' });
  });

  it('omits the key entirely rather than writing null', () => {
    // The reader does `typeof observed?.slash === 'string'`, so both spell "no
    // slash"; the empty object is chosen so a human scanning the store cannot
    // read `slash: null` as "a command happened and we lost it".
    const rec = buildActivationRecord({ topology: { mode: 'solo' } });
    expect(rec.activation_observed).toEqual({});
    expect('slash' in rec.activation_observed).toBe(false);
  });

  it('rejects every spelling detectSlashCommand cannot produce', () => {
    const bad = [null, undefined, 42, '', 'Split', 'artibot:split', '/split', '1split',
      'a'.repeat(33), 'split arg'];
    for (const slashCommand of bad) {
      expect(buildActivationRecord({ slashCommand }).activation_observed,
        `slashCommand ${JSON.stringify(slashCommand)} must be dropped`).toEqual({});
    }
  });

  it('accepts the 32-character boundary and refuses 33', () => {
    const at32 = `a${'b'.repeat(31)}`;
    expect(at32).toHaveLength(32);
    expect(buildActivationRecord({ slashCommand: at32 }).activation_observed).toEqual({ slash: at32 });
    expect(buildActivationRecord({ slashCommand: `${at32}c` }).activation_observed).toEqual({});
  });
});

describe('prompt_id and the idempotency key', () => {
  it('derives the key from the prompt id, without a run id', () => {
    // The run id belongs to the recorder. The half-formed key never reaches
    // disk — decision-events-activation.test.js asserts the final spelling.
    const rec = buildActivationRecord({ topology: { mode: 'split' }, promptId: 'p-1' });
    expect(rec.prompt_id).toBe('p-1');
    expect(rec.idempotency_key).toBe('activation:p-1');
  });

  it('nulls both when the prompt id is absent or over the bound', () => {
    for (const promptId of [undefined, null, '', 7, 'x'.repeat(129)]) {
      const rec = buildActivationRecord({ promptId });
      expect(rec.prompt_id, JSON.stringify(promptId)).toBeNull();
      expect(rec.idempotency_key).toBeNull();
    }
    const at128 = 'x'.repeat(128);
    expect(buildActivationRecord({ promptId: at128 }).idempotency_key).toBe(`activation:${at128}`);
  });
});

describe('the payload shape is closed', () => {
  it('emits exactly ACTIVATION_DATA_KEYS, no more and no fewer', () => {
    const rec = buildActivationRecord({
      topology: { mode: 'split', reason: ['nl-match:flag-split'] },
      slashCommand: 'split',
      promptId: 'p-1',
    });
    expect(Object.keys(rec).sort()).toEqual([...ACTIVATION_DATA_KEYS].sort());
    expect(rec.observe_only).toBe(true);
  });

  it('emits the same key set when every input is missing', () => {
    expect(Object.keys(buildActivationRecord()).sort()).toEqual([...ACTIVATION_DATA_KEYS].sort());
  });

  it('never copies the router result itself', () => {
    const topology = { mode: 'split', reason: ['nl-match:flag-split'], confidence: 0.7, secret: 'x' };
    const rec = buildActivationRecord({ topology });
    expect(rec.reason).toBeUndefined();
    expect(rec.confidence).toBeUndefined();
    expect(rec.secret).toBeUndefined();
  });
});

describe('privacy — prompt-derived text cannot reach the payload', () => {
  it('drops a reason literal carrying prompt text and a slash name carrying arguments', () => {
    const rec = buildActivationRecord({
      topology: { mode: 'split', reason: ['nl-match:secret prompt text'] },
      slashCommand: '/split please leak',
      promptId: 'p-9',
    });
    const json = JSON.stringify(rec);
    expect(json).not.toContain('secret prompt text');
    expect(json).not.toContain('please leak');
    expect(rec.predicted_nl_match).toBeNull();
    expect(rec.activation_observed).toEqual({});
    // The signal still says nl-explicit: the PREFIX is the router's own, and
    // only the id after it failed the charset. Losing that would understate
    // how the mode was reached.
    expect(rec.predicted_signal).toBe('nl-explicit');
  });

  it('keeps nothing from a reason array full of text', () => {
    const rec = buildActivationRecord({
      topology: { mode: 'team', reason: ['runner:team', 'user asked about passwords'] },
    });
    expect(JSON.stringify(rec)).not.toContain('passwords');
  });
});

describe('HINT_SLASH_MAP, the vocabulary the hint axis resolves against', () => {
  it('has no workflow entry, because there is no /workflow to accept', () => {
    expect(Object.hasOwn(HINT_SLASH_MAP, 'workflow')).toBe(false);
    expect(HINT_SLASH_MAP.workflow).toBeUndefined();
  });

  it('maps each recommendation to a command of the same name', () => {
    expect(HINT_SLASH_MAP).toEqual({ split: 'split', autopilot: 'autopilot', watch: 'watch' });
    expect(Object.isFrozen(HINT_SLASH_MAP)).toBe(true);
  });
});

describe('resolveHint() splits "what was recommended" from "could it be accepted"', () => {
  const MAPPED = ['split', 'autopilot', 'watch'];
  for (const value of MAPPED) {
    it(`resolves ${value} through the map`, () => {
      expect(resolveHint(value)).toEqual({ hint_recommend: value, hint_resolved_by: 'slash-map' });
    });
  }

  it('keeps workflow but marks it unmapped, rather than mapping it onto a neighbour', () => {
    // The whole point of the axis: `recommend=workflow` was emitted, and no
    // slash command exists to accept it. Recording it as `split` would
    // manufacture agreement out of a recommendation nobody could act on;
    // dropping it would hide that the hint fired at all.
    expect(resolveHint('workflow')).toEqual({
      hint_recommend: 'workflow', hint_resolved_by: 'unmapped',
    });
  });

  it('keeps an unknown but command-shaped value as unmapped, so a new hint is visible', () => {
    // Same fail-visible trade `predicted_mode` makes: the bound is a charset,
    // not an allowlist of today's three, so a hint added to the hook appears
    // in the store instead of silently becoming null.
    expect(resolveHint('quantum_hint')).toEqual({
      hint_recommend: 'quantum_hint', hint_resolved_by: 'unmapped',
    });
  });

  it('nulls both keys for every spelling the hook cannot emit', () => {
    for (const bad of [undefined, null, '', 42, true, ['split'], { split: true }, 'Split',
      '/split', '1split', 'split arg', 'a'.repeat(33)]) {
      expect(resolveHint(bad), JSON.stringify(bad) ?? String(bad)).toEqual({
        hint_recommend: null, hint_resolved_by: null,
      });
    }
  });

  it('does not let a prototype member masquerade as a mapped hint', () => {
    // `'constructor' in HINT_SLASH_MAP` is true; own-key membership is the only
    // safe test, and `constructor`/`tostring` also happen to pass the charset.
    for (const key of ['constructor', 'tostring', 'valueof', 'hasownproperty']) {
      expect(resolveHint(key), key).toEqual({
        hint_recommend: key, hint_resolved_by: 'unmapped',
      });
    }
    // `__proto__` fails the charset (leading underscore), so it nulls out.
    expect(resolveHint('__proto__')).toEqual({ hint_recommend: null, hint_resolved_by: null });
  });
});

describe('the hint keys ride on the record at top level', () => {
  it('sits beside command_activation, not inside activation_observed', () => {
    const rec = buildActivationRecord({
      topology: { mode: 'split' }, slashCommand: 'split', hintRecommend: 'split',
    });
    expect(rec.hint_recommend).toBe('split');
    expect(rec.hint_resolved_by).toBe('slash-map');
    expect(rec.activation_observed).toEqual({ slash: 'split' });
    expect('hint_recommend' in rec.activation_observed).toBe(false);
  });

  it('is present and null when no hint was emitted', () => {
    const rec = buildActivationRecord({ topology: { mode: 'solo' } });
    expect(rec.hint_recommend).toBeNull();
    expect(rec.hint_resolved_by).toBeNull();
    expect(Object.keys(rec).sort()).toEqual([...ACTIVATION_DATA_KEYS].sort());
  });

  it('carries every value the hook can recommend, each with its resolution', () => {
    const table = [
      ['split', 'split', 'slash-map'],
      ['autopilot', 'autopilot', 'slash-map'],
      ['watch', 'watch', 'slash-map'],
      ['workflow', 'workflow', 'unmapped'],
      [null, null, null],
    ];
    for (const [hintRecommend, recommend, resolvedBy] of table) {
      const rec = buildActivationRecord({ topology: { mode: 'solo' }, hintRecommend });
      expect(rec.hint_recommend, String(hintRecommend)).toBe(recommend);
      expect(rec.hint_resolved_by, String(hintRecommend)).toBe(resolvedBy);
    }
  });

  it('drops a hint carrying prompt text instead of a recommendation name', () => {
    // The charset is the privacy boundary here exactly as it is for
    // `slashCommand`: a sentence is not something the hook's hint can be.
    const rec = buildActivationRecord({
      topology: { mode: 'split' }, hintRecommend: 'please leak this sentence',
    });
    expect(JSON.stringify(rec)).not.toContain('please leak this sentence');
    expect(rec.hint_recommend).toBeNull();
    expect(rec.hint_resolved_by).toBeNull();
  });
});
