/**
 * Unit contract for `lib/runtime/question-gate-record.js` — the one ledger line
 * per prompt that records the question gate's four conditions and `required`.
 *
 * WHAT THIS FILE PINS, AND WHY EACH PROPERTY IS LOAD-BEARING
 *  - **The booleans are the gate's, not a copy.** Every fixture prompt is also
 *    run through `evaluateConditions` + `requiresQuestion` directly and the two
 *    must agree. Hardcoded expectations sit beside that differential so a gate
 *    change that flips a fixture is visible here as a changed fixture, not only
 *    as an agreeing pair.
 *  - **The absent-input marker is in the DATA.** Since CA-15 the UserPromptSubmit
 *    path feeds `interpretIntent()` (and the router's classification), so
 *    `interpretation_present:false` now means only that a caller supplied none;
 *    rows written before CA-15 are always false. The marker is what lets a
 *    reader of the line tell "false because the prompt had no cue" from "false
 *    because the input that could have made it true was never supplied".
 *  - **The status names WHY, and a throw is not a row from before CA-15.**
 *    `interpretation_status` (`ok` | `threw` | `absent`, CA-15 follow-up b) is
 *    what separates an interpreter that threw from a caller that supplied none;
 *    a row written before it existed has no such key at all. The vocabulary is
 *    pinned equal to the allowlist's enum, `interpretation_present` is pinned
 *    true exactly when the status is `ok`, and only the boolean `true` counts as
 *    a throw report.
 *  - **Data keys ⊆ declared allowlist fields, and required ⊆ emitted.** The
 *    writer passes an UNDECLARED data key through untyped
 *    (`tests/firewall/ledger-vocab-allowlist.test.js` "lets an UNDECLARED data
 *    key through untouched"), so a writer-accepts assertion alone could not
 *    notice a key the allowlist never typed. The key sets are compared head-on.
 *  - **One line per call, on a real ledger file.** The append tests use the
 *    REAL writer against a `mkdtemp` root — never the repository's own
 *    `.artibot` — and read the file back.
 *
 * ── WHAT THIS FILE CANNOT SEE ───────────────────────────────────────────────
 *  - WHETHER ANY CALLER INVOKES THIS. The caller is
 *    `lib/runtime/middleware/tasks.js#recordQuestionGate` (wired 2026-09-23);
 *    that wiring, its failure containment and the two-line ledger it produces
 *    are pinned in `tests/runtime/tasks-compile-mission.test.js`, not here.
 *  - WHETHER THE CALLER SUPPLIES THE INPUTS. Fixtures below hand `classification`
 *    and `interpretation` straight to the builder, which is how CA-15's two
 *    dead inputs (no `interpretIntent` caller; `routing.classification` always
 *    undefined on the router's real output) stayed green. The production shape,
 *    through the real router, is `tests/runtime/tasks-question-gate-inputs.test.js`.
 *  - WHETHER THE HOOK SCANNER CLASSIFIES THE CALL AS (A). That is
 *    `tests/firewall/hook-emitter-sources-rule.test.js`'s question; since the
 *    wiring made this module reachable from a hook entry point, its
 *    `KNOWN_EMITTER_FLOOR` pins the event to this file, the aliased `append`
 *    call included.
 *  - THE QUALITY OF THE CUES. A `true` here means a cue list matched, not that
 *    a human value judgment was in fact required.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  decideQuestionGateEnforcement,
  evaluateConditions,
  GATE_CONDITIONS,
  requiresQuestion,
} from '../../lib/planning/question-gate.js';
import {
  getAllowlist,
  ledgerFilePath,
  sessionFallbackMissionId,
} from '../../lib/runtime/event-writer.js';
import { readAllEvents } from '../../lib/runtime/ledger.js';
import {
  appendQuestionGateEvent,
  buildQuestionGateData,
  INTERPRETATION_PRESENT_KEY,
  INTERPRETATION_STATUS_KEY,
  INTERPRETATION_STATUSES,
  QUESTION_GATE_EVENT,
} from '../../lib/runtime/question-gate-record.js';

const NOW_MS = Date.parse('2026-09-23T02:30:00.000Z');
const SID = 'sess-qgate-0001';

/** A prompt carrying a cue for every one of the four conditions. */
const ALL_FOUR_PROMPT = 'Which should we pick for the public API contract? It is a '
  + 'product decision with no right answer, and a wrong call is costly rework.';

/** A plain edit request: no cue for any condition. */
const NONE_PROMPT = 'fix the typo in the README heading';

/** A factual lookup — the T-24 case that must never open the gate. */
const FACTUAL_PROMPT = 'where is the config loader defined?';

/**
 * Representative inputs, each run through the recorder AND through the gate
 * directly. `expected` is the hardcoded half of the check.
 */
const FIXTURES = Object.freeze([
  {
    name: 'no cue at all',
    input: { prompt: NONE_PROMPT },
    expected: [false, false, false, false],
  },
  {
    name: 'a cue for all four conditions',
    input: { prompt: ALL_FOUR_PROMPT },
    expected: [true, true, true, true],
  },
  {
    name: 'a factual lookup',
    input: { prompt: FACTUAL_PROMPT },
    expected: [false, false, false, false],
  },
  {
    name: 'no cue, but a high risk factor from the classifier',
    input: { prompt: NONE_PROMPT, classification: { factors: { risk: 0.7 } } },
    expected: [false, false, false, true],
  },
  {
    name: 'no cue, but an interpretation that escalates to a commit',
    input: { prompt: NONE_PROMPT, interpretation: { completion_expectation: 'commit' } },
    expected: [false, true, false, true],
  },
]);

/** @type {string} */
let root;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'artibot-qgate-record-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * The identity shape `resolveMissionIdentity` (middleware/mission-ledger.js)
 * produces.
 * @param {object} [over]
 * @returns {{projectRoot: string|null, sessionId: string|null, missionId: string|null}}
 */
function identity(over = {}) {
  return {
    projectRoot: root,
    sessionId: SID,
    missionId: sessionFallbackMissionId(SID, new Date(NOW_MS)),
    ...over,
  };
}

/**
 * Every line of the temp ledger, rejections included.
 * @returns {object[]}
 */
function allLines() {
  return readAllEvents(root, { includeRejected: true });
}

describe('QUESTION_GATE_EVENT', () => {
  it('names a registered event that a hook may emit', () => {
    const spec = getAllowlist().events[QUESTION_GATE_EVENT];
    expect(spec, `${QUESTION_GATE_EVENT} is not in the allowlist`).toBeDefined();
    expect(spec.sources).toEqual(['hook']);
  });
});

describe('buildQuestionGateData — the four booleans and required', () => {
  for (const { name, input, expected } of FIXTURES) {
    it(`matches the gate itself on: ${name}`, () => {
      const data = buildQuestionGateData(input);
      const conditions = evaluateConditions(input);

      expect(GATE_CONDITIONS.map((k) => data[k])).toEqual(expected);
      for (const key of GATE_CONDITIONS) expect(data[key], key).toBe(conditions[key]);
      expect(data.required).toBe(requiresQuestion(conditions));
    });
  }

  it('opens the gate only when all four hold', () => {
    const fired = FIXTURES.filter(({ input }) => buildQuestionGateData(input).required);
    expect(fired.map((f) => f.name)).toEqual(['a cue for all four conditions']);
  });

  it('emits strict booleans for every key but the status, never undefined or a truthy look-alike', () => {
    // RE-PINNED by CA-15 follow-up b (intended): `interpretation_status` is the
    // one key that is a closed-vocabulary string, not a boolean.
    for (const { input } of FIXTURES) {
      const data = buildQuestionGateData(input);
      for (const [key, value] of Object.entries(data)) {
        if (key === INTERPRETATION_STATUS_KEY) {
          expect(INTERPRETATION_STATUSES, key).toContain(value);
        } else {
          expect(typeof value, key).toBe('boolean');
        }
      }
    }
  });

  it('returns a new object per call', () => {
    const a = buildQuestionGateData({ prompt: NONE_PROMPT });
    const b = buildQuestionGateData({ prompt: NONE_PROMPT });
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });
});

describe('buildQuestionGateData — the interpretation-absent marker', () => {
  it('records interpretation_present:false when no interpretation is supplied', () => {
    // A caller that supplies none. Since CA-15 `tasks.js#recordQuestionGate`
    // does so only when its own interpretIntent() call fails.
    const data =buildQuestionGateData({ prompt: ALL_FOUR_PROMPT, intent: {}, classification: null });
    expect(data[INTERPRETATION_PRESENT_KEY]).toBe(false);
  });

  it('records interpretation_present:true when one is supplied', () => {
    const data = buildQuestionGateData({
      prompt: NONE_PROMPT,
      interpretation: { completion_expectation: 'commit' },
    });
    expect(data[INTERPRETATION_PRESENT_KEY]).toBe(true);
  });

  it('treats a non-object interpretation as absent', () => {
    for (const interpretation of [null, undefined, 'commit', 7, true]) {
      const data = buildQuestionGateData({ prompt: NONE_PROMPT, interpretation });
      expect(data[INTERPRETATION_PRESENT_KEY], String(interpretation)).toBe(false);
    }
  });

  it('shows why the marker matters: the same prompt reads differently with and without it', () => {
    const without = buildQuestionGateData({ prompt: NONE_PROMPT });
    const withIt = buildQuestionGateData({
      prompt: NONE_PROMPT,
      interpretation: { completion_expectation: 'commit' },
    });
    expect(without.materialDownstreamImpact).toBe(false);
    expect(withIt.materialDownstreamImpact).toBe(true);
  });
});

describe('buildQuestionGateData — the interpretation status (CA-15 follow-up b)', () => {
  // `interpretation_present:false` is written both by a caller that supplied no
  // interpretation and by `tasks.js#interpretForGate` when `interpretIntent`
  // THREW, and every row written before CA-15 also read false with no key at
  // all. The status is what tells a throw from the other two without `ts`.
  const STATUS = INTERPRETATION_STATUS_KEY;

  it('names its key and pins the closed vocabulary', () => {
    expect(STATUS).toBe('interpretation_status');
    expect(INTERPRETATION_STATUSES).toEqual(['ok', 'threw', 'absent']);
    expect(Object.isFrozen(INTERPRETATION_STATUSES)).toBe(true);
  });

  it('records ok when an interpretation was supplied', () => {
    const data = buildQuestionGateData({ prompt: NONE_PROMPT, interpretation: { completion_expectation: 'answer' } });
    expect(data[STATUS]).toBe('ok');
    expect(data[INTERPRETATION_PRESENT_KEY]).toBe(true);
  });

  it('records absent when none was supplied and nothing threw', () => {
    for (const input of [{ prompt: NONE_PROMPT }, { prompt: NONE_PROMPT, interpretation: null }, undefined]) {
      const data = buildQuestionGateData(input);
      expect(data[STATUS], JSON.stringify(input)).toBe('absent');
      expect(data[INTERPRETATION_PRESENT_KEY]).toBe(false);
    }
  });

  it('records threw when the caller reports a throw and supplies no interpretation', () => {
    const data = buildQuestionGateData({ prompt: NONE_PROMPT, interpretationThrew: true });
    expect(data[STATUS]).toBe('threw');
    expect(data[INTERPRETATION_PRESENT_KEY]).toBe(false);
  });

  it('tells a throw from a caller that supplied none: same conditions, same marker, different status', () => {
    const threw = buildQuestionGateData({ prompt: ALL_FOUR_PROMPT, interpretationThrew: true });
    const none = buildQuestionGateData({ prompt: ALL_FOUR_PROMPT });
    const { [STATUS]: threwStatus, ...threwRest } = threw;
    const { [STATUS]: noneStatus, ...noneRest } = none;
    expect(threwRest).toEqual(noneRest);
    expect(threwStatus).not.toBe(noneStatus);
  });

  it('lets a supplied interpretation outrank a throw report: present holds exactly when ok', () => {
    const data = buildQuestionGateData({
      prompt: NONE_PROMPT, interpretation: { completion_expectation: 'commit' }, interpretationThrew: true,
    });
    expect(data[STATUS]).toBe('ok');
    expect(data[INTERPRETATION_PRESENT_KEY]).toBe(true);
  });

  it.each([['the string "true"', 'true'], ['1', 1], ['an object', {}], ['an array', [true]],
    ['null', null], ['undefined', undefined], ['false', false], ['the word threw', 'threw']])(
    'reads only the boolean true as a throw report, not %s',
    (_label, report) => {
      expect(buildQuestionGateData({ prompt: NONE_PROMPT, interpretationThrew: report })[STATUS]).toBe('absent');
    },
  );

  it('always lands in the vocabulary and agrees with the presence marker, on every input shape', () => {
    const interpretations = [undefined, null, 'commit', 7, true, {}, { completion_expectation: 'commit' }, []];
    for (const interpretation of interpretations) {
      for (const interpretationThrew of [undefined, true, false]) {
        const data = buildQuestionGateData({ prompt: NONE_PROMPT, interpretation, interpretationThrew });
        const label = `${JSON.stringify(interpretation)} / ${interpretationThrew}`;
        expect(INTERPRETATION_STATUSES, label).toContain(data[STATUS]);
        expect(data[INTERPRETATION_PRESENT_KEY], label).toBe(data[STATUS] === 'ok');
      }
    }
  });
});

describe('buildQuestionGateData — the record is the enforcement input (CA-15)', () => {
  it('blocks exactly where the record says required, and the interpretation marker feeds provenance only', () => {
    // `tasks.js` hands this very object to the decision as `conditions`, extra
    // keys included, instead of re-evaluating the prompt.
    for (const { name, input } of FIXTURES) {
      const data = buildQuestionGateData(input);
      const decision = decideQuestionGateEnforcement({
        conditions: data,
        enforce: true,
        interpretationPresent: data[INTERPRETATION_PRESENT_KEY] === true,
      });
      expect(decision.block, name).toBe(data.required);
      expect(decision.inputs_absent, name)
        .toEqual(data[INTERPRETATION_PRESENT_KEY] ? [] : ['interpretation']);
    }
  });
});

describe('buildQuestionGateData — config is not forwarded', () => {
  it('ignores config.question_gate.force, so a forced value is never recorded as observed', () => {
    const force = Object.fromEntries(GATE_CONDITIONS.map((k) => [k, true]));
    const config = { question_gate: { force } };
    // Positive control: the gate itself DOES honour the pin.
    expect(requiresQuestion(evaluateConditions({ prompt: NONE_PROMPT, config }))).toBe(true);
    // The record does not.
    expect(buildQuestionGateData({ prompt: NONE_PROMPT, config }))
      .toEqual(buildQuestionGateData({ prompt: NONE_PROMPT }));
  });
});

describe('buildQuestionGateData — never throws', () => {
  it('returns null when evaluating the prompt throws', () => {
    const hostile = { toString() { throw new Error('boom'); } };
    expect(() => buildQuestionGateData({ prompt: hostile })).not.toThrow();
    expect(buildQuestionGateData({ prompt: hostile })).toBeNull();
  });

  it('returns null when reading the interpretation throws', () => {
    const interpretation = {};
    Object.defineProperty(interpretation, 'completion_expectation', {
      get() { throw new Error('getter'); },
    });
    expect(buildQuestionGateData({ prompt: NONE_PROMPT, interpretation })).toBeNull();
  });

  it('evaluates an empty or missing input as the no-cue case', () => {
    const empty = buildQuestionGateData();
    expect(empty).toEqual(buildQuestionGateData({ prompt: '' }));
    expect(empty.required).toBe(false);
  });
});

describe('the emitted key set against the allowlist', () => {
  const spec = getAllowlist().events[QUESTION_GATE_EVENT];

  it('declares a type for every key the builder emits', () => {
    // Not left to the writer: it passes an undeclared key through untyped.
    for (const { input } of FIXTURES) {
      const emitted = Object.keys(buildQuestionGateData(input));
      const declared = Object.keys(spec.fields ?? {});
      expect(emitted.filter((k) => !declared.includes(k))).toEqual([]);
    }
  });

  it('emits every key the allowlist requires', () => {
    for (const { input } of FIXTURES) {
      const emitted = Object.keys(buildQuestionGateData(input));
      expect(spec.required.filter((k) => !emitted.includes(k))).toEqual([]);
    }
  });

  it('requires every emitted key, so an oversized-line fold cannot drop one', () => {
    // event-writer.js#foldOversized keeps only required keys above the cap.
    const emitted = Object.keys(buildQuestionGateData({ prompt: NONE_PROMPT })).sort();
    expect([...spec.required].sort()).toEqual(emitted);
  });

  it('covers every gate condition (scanner self-check against an empty set)', () => {
    expect(GATE_CONDITIONS.length).toBe(4);
    for (const key of [...GATE_CONDITIONS, 'required', INTERPRETATION_PRESENT_KEY]) {
      expect(spec.fields[key]?.type, key).toBe('boolean');
    }
  });

  it('declares the status as a closed enum pinned to the recorder\'s own vocabulary, and requires it', () => {
    // The same shape as `human.resolved`'s `kind`: the recorder exports the
    // vocabulary, the allowlist owns the enum, and this pin keeps the two equal.
    expect(spec.fields[INTERPRETATION_STATUS_KEY]).toEqual({ enum_ref: 'interpretation_status' });
    expect(getAllowlist().enums.interpretation_status).toEqual([...INTERPRETATION_STATUSES]);
    // Required, not merely declared: a row that lost it would read as a row
    // written before CA-15, which is the very ambiguity the field removes.
    expect(spec.required).toContain(INTERPRETATION_STATUS_KEY);
  });
});

describe('appendQuestionGateEvent — statuses on a real ledger file', () => {
  it('appends exactly one line per call, source hook, on the given mission', () => {
    const data = buildQuestionGateData({ prompt: ALL_FOUR_PROMPT });
    expect(appendQuestionGateEvent(identity(), data, NOW_MS)).toBe('appended');

    const lines = allLines();
    expect(lines).toHaveLength(1);
    const [line] = lines;
    expect(line.event).toBe(QUESTION_GATE_EVENT);
    expect(line.source).toBe('hook');
    expect(line.session_id).toBe(SID);
    expect(line.mission_id).toBe(identity().missionId);
    expect(line.ts).toBe(new Date(NOW_MS).toISOString());
    expect(line.data).toEqual(data);
    expect(line.idempotency_key).toBeUndefined();

    expect(appendQuestionGateEvent(identity(), data, NOW_MS)).toBe('appended');
    expect(allLines()).toHaveLength(2);
  });

  it('writes to the injected project root and nowhere else', () => {
    appendQuestionGateEvent(identity(), buildQuestionGateData({ prompt: NONE_PROMPT }), NOW_MS);
    const file = ledgerFilePath(root);
    expect(file.startsWith(root)).toBe(true);
    expect(readFileSync(file, 'utf-8').trim().split('\n')).toHaveLength(1);
  });

  it('skips without writing when data is null (the builder failed)', () => {
    expect(appendQuestionGateEvent(identity(), null, NOW_MS)).toBe('skipped:no-data');
    expect(allLines()).toHaveLength(0);
  });

  it('skips without writing when there is no project root', () => {
    const data = buildQuestionGateData({ prompt: NONE_PROMPT });
    expect(appendQuestionGateEvent(identity({ projectRoot: null }), data, NOW_MS))
      .toBe('skipped:no-project-root');
    expect(allLines()).toHaveLength(0);
  });

  it('skips without writing when the session or mission id is missing', () => {
    const data = buildQuestionGateData({ prompt: NONE_PROMPT });
    expect(appendQuestionGateEvent(identity({ sessionId: null }), data, NOW_MS))
      .toBe('skipped:no-session-id');
    expect(appendQuestionGateEvent(identity({ missionId: null }), data, NOW_MS))
      .toBe('skipped:no-session-id');
    expect(appendQuestionGateEvent(undefined, data, NOW_MS)).toBe('skipped:no-project-root');
    expect(allLines()).toHaveLength(0);
  });

  it('reports a writer refusal as rejected:<reason>, and the writer records it', () => {
    const bad = { ...buildQuestionGateData({ prompt: NONE_PROMPT }), required: 'yes' };
    expect(appendQuestionGateEvent(identity(), bad, NOW_MS))
      .toBe('rejected:type-violation:required');
    const lines = allLines();
    expect(lines).toHaveLength(1);
    expect(lines[0].event).toBe('ledger.rejected');
    expect(readAllEvents(root)).toHaveLength(0);
  });

  it('refuses a status outside the vocabulary, and the writer records the refusal', () => {
    const bad = { ...buildQuestionGateData({ prompt: NONE_PROMPT }), [INTERPRETATION_STATUS_KEY]: 'timeout' };
    expect(appendQuestionGateEvent(identity(), bad, NOW_MS))
      .toBe('rejected:enum-violation:interpretation_status');
    expect(readAllEvents(root)).toHaveLength(0);
    expect(allLines().map((l) => l.event)).toEqual(['ledger.rejected']);
  });

  it('refuses a line that lost its status, which would read as a row written before CA-15', () => {
    const { [INTERPRETATION_STATUS_KEY]: _lost, ...data } = buildQuestionGateData({ prompt: NONE_PROMPT });
    expect(appendQuestionGateEvent(identity(), data, NOW_MS))
      .toBe('rejected:missing-required-data:interpretation_status');
    expect(readAllEvents(root)).toHaveLength(0);
  });

  it('writes each of the three states to disk, so they can be told apart when read back', () => {
    const inputs = [
      { prompt: NONE_PROMPT, interpretation: { completion_expectation: 'answer' } },
      { prompt: NONE_PROMPT, interpretationThrew: true },
      { prompt: NONE_PROMPT },
    ];
    for (const input of inputs) {
      expect(appendQuestionGateEvent(identity(), buildQuestionGateData(input), NOW_MS)).toBe('appended');
    }
    expect(readAllEvents(root).map((l) => l.data[INTERPRETATION_STATUS_KEY]))
      .toEqual(['ok', 'threw', 'absent']);
  });

  it('reports a thrown append as error:<message> and does not throw', () => {
    const deps = { appendLedgerEvent: () => { throw new Error('disk gone'); } };
    const data = buildQuestionGateData({ prompt: NONE_PROMPT });
    expect(() => appendQuestionGateEvent(identity(), data, NOW_MS, deps)).not.toThrow();
    expect(appendQuestionGateEvent(identity(), data, NOW_MS, deps)).toBe('error:disk gone');
  });

  it('reports a non-ok result with no reason as rejected:unknown', () => {
    const deps = { appendLedgerEvent: () => ({ ok: false }) };
    const data = buildQuestionGateData({ prompt: NONE_PROMPT });
    expect(appendQuestionGateEvent(identity(), data, NOW_MS, deps)).toBe('rejected:unknown');
  });

  it('hands the port the envelope and a clock pinned to nowMs', () => {
    const calls = [];
    const deps = { appendLedgerEvent: (...args) => { calls.push(args); return { ok: true }; } };
    const data = buildQuestionGateData({ prompt: NONE_PROMPT });
    expect(appendQuestionGateEvent(identity(), data, NOW_MS, deps)).toBe('appended');
    expect(calls).toHaveLength(1);
    const [projectRoot, envelope, opts] = calls[0];
    expect(projectRoot).toBe(root);
    expect(envelope).toEqual({
      event: QUESTION_GATE_EVENT,
      mission_id: identity().missionId,
      session_id: SID,
      source: 'hook',
      data,
    });
    expect(opts.now().toISOString()).toBe(new Date(NOW_MS).toISOString());
  });
});
