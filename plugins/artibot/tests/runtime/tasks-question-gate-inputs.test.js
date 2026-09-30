/**
 * CA-15 — the question gate receives BOTH of its inputs on the production path.
 *
 * WHY THIS FILE EXISTS. `lib/runtime/middleware/tasks.js#recordQuestionGate`
 * evaluates the gate's four conditions from three inputs: the prompt, the
 * classification (`factors.risk` strengthens condition 4) and an
 * `interpretIntent()` output (an escalating completion or a structural work
 * purpose makes conditions 2 and 4 true on its own). Until CA-15, neither of
 * the last two ever arrived:
 *   - `interpretIntent` had no production caller at all;
 *   - the classification was read from `state.context.routing.classification`,
 *     but `middleware/router.js` SPREADS the classification into `routing`
 *     (`{ ...classification, system }`), so that key is always undefined.
 * Every test that touched the gate hid this, because each one supplied the input
 * by hand: `question-gate-record.test.js` passes `classification` straight to
 * the builder, and `tasks-compile-mission.test.js` hand-builds
 * `context.routing`. A green suite therefore proved the gate could USE the
 * inputs and nothing about whether the pipeline ever GAVE them.
 *
 * So every case here goes through the real `createArtibotAgent().preparePrompt`
 * (router -> tasks): the router produces the state shape, nothing is injected,
 * and the ledger row is read back off the real writer as well as off the port.
 *
 * FOLLOW-UP c (2026-09-30). The same dead key was read in two more places: the
 * `compileMission` call in `tasks.js` (deleted, since nothing consumes it) and
 * `workflow-mode.js#planWorkflow`'s `factors` (now read off `routing`). The last
 * `describe` pins both on the production path.
 *
 * FIXTURES ISOLATE ONE ROUTE EACH, and every case asserts that isolation as a
 * precondition read off the real router output, so a vocabulary change that
 * quietly stops isolating a route fails loudly here instead of passing for the
 * wrong reason. `conditionsBeforeTheFeed` is the pre-CA-15 call (no
 * interpretation, `routing.classification` = undefined); a fixture is only
 * meaningful if that call disagrees with the recorded row.
 *
 * ── WHAT THIS FILE CANNOT SEE ───────────────────────────────────────────────
 *  - THE LIVE DISTRIBUTION. Conditions 2 and 4 now fire on prompts they never
 *    fired on (any commit/PR/deploy completion, any design/migrate/release
 *    purpose, any router risk >= 0.5). Rows written before this change and rows
 *    after it are NOT comparable; nothing here measures the new rates.
 *  - THE HOOK'S STDOUT. Only `userPrompt` and `message` are pinned here. The
 *    hook document, `additionalContext` included, is composed from those plus
 *    the workflow plan (`runtime-prompt.js#composePromptParts`) and is covered
 *    by `tests/hooks/runtime-prompt.test.js`. That it is byte-identical across
 *    CA-15 with the switch off was measured once (before/after probe on
 *    491a4de8), not pinned. The three follow-ups (a: cue vocabulary, b: status
 *    field, c: dead reads) repeated that probe on ad8e5b28 against their tree:
 *    11 prompts, identical once the per-call `teardown(Nms)` and `ckpt=<random>`
 *    tokens are normalised. Also not pinned.
 *  - THE REAL HOOK PAYLOAD AND CONFIG. `hookData` is hand-built and the config
 *    is minimal (router + tasks only).
 *  - WHETHER THE MODEL OBEYS THE DIRECTIVE. With the switch on the block is
 *    advisory text next to the prompt; this pins the text, not a question.
 *  - THE QUALITY OF THE CUES. A `true` means a cue list matched. The commit and
 *    migrate cues are phrase allowlists (CA-15 follow-up a); the cases here pin a
 *    few false positives end to end, not the vocabulary, which is
 *    `tests/intent/interpreter.test.js`.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The ledger port and the interpreter, wrapped so a case can watch what the
 * pipeline hands them and, for the negative controls, withhold or break the
 * interpretation. Both run their REAL implementation unless a case swaps one,
 * and `afterEach` swaps it back.
 */
vi.mock('../../lib/runtime/ledger.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, appendLedgerEvent: vi.fn(actual.appendLedgerEvent) };
});
vi.mock('../../lib/intent/interpreter.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, interpretIntent: vi.fn(actual.interpretIntent) };
});
// CA-15 follow-up (c): the two other places `tasks.js` used to read
// `routing.classification`. Wrapped, never replaced, so a case can read the
// argument each was handed on the production path.
vi.mock('../../lib/mission/compiler.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, compileMission: vi.fn(actual.compileMission) };
});
vi.mock('../../lib/cognitive/workflow-plan.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, buildWorkflowPlan: vi.fn(actual.buildWorkflowPlan) };
});

import { createArtibotAgent } from '../../lib/runtime/create-artibot-agent.js';
import { resetRouter } from '../../lib/cognitive/router.js';
import { resetSeq } from '../../lib/runtime/event-writer.js';
import { appendLedgerEvent, readAllEvents } from '../../lib/runtime/ledger.js';
import { interpretIntent } from '../../lib/intent/interpreter.js';
import { compileMission } from '../../lib/mission/compiler.js';
import { buildWorkflowPlan } from '../../lib/cognitive/workflow-plan.js';
import { evaluateConditions, GATE_CONDITIONS, requiresQuestion } from '../../lib/planning/question-gate.js';

const realLedger = await vi.importActual('../../lib/runtime/ledger.js');
const realInterpreter = await vi.importActual('../../lib/intent/interpreter.js');
const realCompiler = await vi.importActual('../../lib/mission/compiler.js');

const GATE_EVENT = 'adr.question_gate_evaluated';
const NOW = 1700000000000;
const SESSION = 'sess-ca15-inputs-0001';
const TEAM = {
  enabled: true,
  autoApplyTriggers: { logic: 'OR', minSubtasks: 2, minFiles: 2, minComplexity: 'high' },
};
/** The mission keys with the switch off, in emission order. */
const MISSION_KEYS_OFF = [
  'contract', 'mode', 'signals', 'substantive', 'deferred', 'ledger', 'store', 'question_gate', 'ok',
];

// -- Fixtures ----------------------------------------------------------------
// Conditions are written [valueJudgment, downstreamImpact, evidenceCannotDecide, wrongAssumptionCost].

/** No cue for any condition, no risk, nothing for the interpreter: [F,F,F,F] both ways. */
const NONE_PROMPT = 'fix the typo in the README heading';
/** Router risk 0.6 (two risk keywords), no cost cue, inert to the interpreter: only the RISK route. */
const RISK_PROMPT = 'delete the audit notes';
/** An escalating completion (commit) and nothing else: only the INTERPRETATION route, [F,T,F,T]. */
const COMMIT_PROMPT = 'README 오타 고치고 커밋까지 해줘';
/** A structural work purpose (design) and nothing else: only the INTERPRETATION route, [F,T,F,T]. */
const DESIGN_PROMPT = '새 알림 흐름 설계해줘';
/**
 * Conditions 1 and 3 by prompt cue; 2 and 4 ONLY through the interpretation
 * (commit). The commit request is a real one ("commit the change"). It used to
 * read "... so commit to it.", which is a decision idiom and not a git commit:
 * the fixture leaned on the interpreter's bare `commit` cue, i.e. on the false
 * positive CA-15 follow-up (a) removed. That sentence is now COMMIT_TO_IT_PROMPT.
 */
const BLOCK_PROMPT = 'Which should we pick? It is a product decision with no right answer, so decide and commit the change.';
/** Conditions 1 and 3 by prompt cue, and NO commit request: "commit to it" is a decision idiom. */
const COMMIT_TO_IT_PROMPT = 'Which should we pick? It is a product decision with no right answer, so commit to it.';
/** "에이전트" (agent) contains the syllables "이전"; a bare "이전" cue read it as a migration. */
const AGENT_PROMPT = '에이전트 팀을 구성해줘';
/** The owner's own phrasing: "upgrade X" means "improve X", not a version migration. */
const UPGRADE_PROMPT = 'split 을 업그레이드해줘';
/** A multi-step prompt that routes agentTeam, so the Execution contract suffix is in play. */
const SYSTEM2_PROMPT = 'Plan the migration, refactor the backend API, redesign the frontend components, '
  + 'update the database schema, and verify security across the whole system';

const S1 = 'System 1 mode: answer directly and keep it concise.\nOriginal request:\n';
const S2 = 'System 2 mode: use plan-execute-reflect and reason step-by-step.\nOriginal request:\n';
const EXEC = '\n\nExecution contract:\n- Create a plan first.\n- Execute in clear phases.\n- Validate before final answer.';
const TAG = '[artibot:question-gate required kind=product_decision at=adr_start]';

// -- Harness -----------------------------------------------------------------

const tempDirs = [];

beforeEach(() => {
  resetSeq();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.mocked(appendLedgerEvent).mockImplementation(realLedger.appendLedgerEvent);
  vi.mocked(interpretIntent).mockReset();
  vi.mocked(interpretIntent).mockImplementation(realInterpreter.interpretIntent);
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** @param {string} prefix @returns {string} a fresh temp directory, removed after the case */
function tempDir(prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/**
 * A plugin root whose config carries `runtime.questionGate.enforce` only when
 * one is given, so "key absent" is a real absence.
 * @param {boolean} [enforce]
 * @returns {string}
 */
function pluginRootWith(enforce) {
  const dir = tempDir('artibot-ca15-inputs-plugin-');
  const cfg = enforce === undefined
    ? { team: TEAM }
    : { team: TEAM, runtime: { questionGate: { enforce } } };
  writeFileSync(path.join(dir, 'artibot.config.json'), JSON.stringify(cfg));
  return dir;
}

/**
 * Run one prompt through the REAL default pipeline (router -> tasks) in a fresh
 * project root and collect what the gate recorded, from the port and from disk.
 *
 * @param {string} prompt
 * @param {{enforce?: boolean}} [opts] `enforce` sets the CA-15 switch; absent leaves the key out
 * @returns {Promise<object>}
 */
async function prepare(prompt, { enforce } = {}) {
  resetRouter();
  const projectRoot = tempDir('artibot-ca15-inputs-proj-');
  // A `.git` marker stops `resolveProjectRoot` at this sandbox, so the router's
  // decision record cannot walk out into the developer's live decisions store.
  mkdirSync(path.join(projectRoot, '.git'), { recursive: true });
  const agent = createArtibotAgent({
    pluginRoot: pluginRootWith(enforce),
    config: {
      automation: { supportedLanguages: ['en', 'ko'], ambiguityThreshold: 50 },
      cognitive: { router: { threshold: 0.4 } },
      runtime: { middleware: ['router', 'tasks'] },
    },
    now: () => NOW,
    middlewareOptions: { tasks: { resolveGitCommonDir: () => null } },
  });
  const callsBefore = vi.mocked(appendLedgerEvent).mock.calls.length;
  const prepared = await agent.preparePrompt({
    prompt,
    hookData: { session_id: SESSION, cwd: projectRoot, event: 'UserPromptSubmit' },
  });
  const portRows = vi.mocked(appendLedgerEvent).mock.calls
    .slice(callsBefore)
    .filter(([, envelope]) => envelope?.event === GATE_EVENT)
    .map(([root, envelope]) => ({ root, envelope }));
  const gateRows = readAllEvents(projectRoot, { includeRejected: true })
    .filter((row) => row.event === GATE_EVENT);
  return {
    prepared,
    projectRoot,
    portRows,
    gateRows,
    gate: gateRows[0]?.data,
    mission: prepared.context.tasks.mission,
    routing: prepared.context.routing,
  };
}

/** @param {object} data a gate row's data @returns {boolean[]} the four conditions, in gate order */
const flags = (data) => GATE_CONDITIONS.map((key) => data?.[key]);

/**
 * What `recordQuestionGate` computed BEFORE CA-15 fed its inputs, from the same
 * real state: the prompt and the intent, no interpretation, and the
 * classification read from `routing.classification` (undefined on the real shape).
 */
function conditionsBeforeTheFeed(run, prompt) {
  return evaluateConditions({
    prompt,
    intent: run.prepared.context.intent,
    classification: run.routing.classification,
  });
}

// -- Cases -------------------------------------------------------------------

describe('CA-15 gate inputs — the real pipeline feeds the recorder', () => {
  it('hands the ledger port one question-gate row that carries interpretation_present:true', async () => {
    const run = await prepare(NONE_PROMPT);

    expect(run.portRows).toHaveLength(1);
    const [{ root, envelope }] = run.portRows;
    expect(root).toBe(run.projectRoot);
    expect(envelope).toMatchObject({ event: GATE_EVENT, source: 'hook', session_id: SESSION });
    expect(envelope.data.interpretation_present).toBe(true);
    expect(envelope.data.interpretation_status).toBe('ok');
    // The same row, through the real writer, on disk.
    expect(run.mission.question_gate).toBe('appended');
    expect(run.gateRows).toHaveLength(1);
    expect(run.gateRows[0].data).toEqual(envelope.data);
  });

  it('calls interpretIntent once per prompt with prompt, intent and the routing object, and no config', async () => {
    const run = await prepare(COMMIT_PROMPT);

    expect(interpretIntent).toHaveBeenCalledTimes(1);
    const [arg] = vi.mocked(interpretIntent).mock.calls[0];
    // `question-gate-record.js` ("WHY config IS NOT FORWARDED"): a pinned
    // execution_profile is an operator override, not an observation.
    expect(Object.keys(arg).sort()).toEqual(['classification', 'intent', 'prompt']);
    expect(arg.prompt).toBe(COMMIT_PROMPT);
    expect(arg.intent).toBe(run.prepared.context.intent);
    expect(arg.classification).toMatchObject({ score: run.routing.score, factors: run.routing.factors });
  });

  describe('the classification route (condition 4 from factors.risk)', () => {
    it('reads the router\'s factors.risk off routing itself, with no cost cue in the prompt', async () => {
      const run = await prepare(RISK_PROMPT);

      // Preconditions, read off the REAL router output — nothing was injected.
      expect(run.routing.factors.risk).toBeGreaterThanOrEqual(0.5);
      expect(run.routing.classification).toBeUndefined();
      // Control: the route is isolated. The pre-CA-15 call and the interpretation
      // alone both leave condition 4 false for this prompt.
      expect(conditionsBeforeTheFeed(run, RISK_PROMPT).costOfWrongAssumptionMeaningful).toBe(false);
      const interpretation = realInterpreter.interpretIntent({
        prompt: RISK_PROMPT, intent: run.prepared.context.intent,
      });
      expect(evaluateConditions({ prompt: RISK_PROMPT, interpretation }).costOfWrongAssumptionMeaningful)
        .toBe(false);

      expect(flags(run.gate)).toEqual([false, false, false, true]);
    });
  });

  describe('the interpretation route (conditions 2 and 4 from interpretIntent)', () => {
    it.each([
      ['an escalating completion (commit)', COMMIT_PROMPT],
      ['a structural work purpose (design)', DESIGN_PROMPT],
    ])('makes conditions 2 and 4 true from the interpretation alone: %s', async (_name, prompt) => {
      const run = await prepare(prompt);

      // Preconditions: the risk route is not what fires, and the prompt alone is silent.
      expect(run.routing.factors.risk).toBeLessThan(0.5);
      const before = conditionsBeforeTheFeed(run, prompt);
      expect(before.materialDownstreamImpact).toBe(false);
      expect(before.costOfWrongAssumptionMeaningful).toBe(false);

      expect(flags(run.gate)).toEqual([false, true, false, true]);
      expect(run.gate.interpretation_present).toBe(true);
    });

    it('falls back to the pre-CA-15 record when the interpretation is withheld', async () => {
      vi.mocked(interpretIntent).mockReturnValueOnce(null);
      const run = await prepare(COMMIT_PROMPT);

      expect(flags(run.gate)).toEqual([false, false, false, false]);
      expect(run.gate.interpretation_present).toBe(false);
      // Nothing threw: the interpreter returned no interpretation.
      expect(run.gate.interpretation_status).toBe('absent');
    });
  });

  describe('cue words that are not the intent do not reach conditions 2 and 4 (follow-up a)', () => {
    // Each of these made conditions 2 and 4 true from the interpretation alone
    // before the cue vocabulary was narrowed to phrase allowlists (measured
    // 2026-09-30 on ad8e5b28: [.,T,.,T] for all three). The router risk is
    // asserted below 0.5 so the classification route is not what is being read.
    it.each([
      ['"commit to it" is a decision idiom, not a git commit', COMMIT_TO_IT_PROMPT, [true, false, true, false]],
      ['"이전" inside "에이전트" (agent) is not a migration', AGENT_PROMPT, [false, false, false, false]],
      ['a generic "업그레이드" (improve) is not a migration', UPGRADE_PROMPT, [false, false, false, false]],
    ])('%s', async (_name, prompt, expected) => {
      const run = await prepare(prompt);

      expect(run.routing.factors.risk).toBeLessThan(0.5);
      expect(flags(run.gate)).toEqual(expected);
      expect(run.gate.interpretation_present).toBe(true);
    });
  });
});

describe('CA-15 gate inputs — switch OFF: the record changes, the output does not', () => {
  // `userPrompt` and `message` as the tree produced them BEFORE the inputs were
  // fed (measured on 491a4de8 through the same createArtibotAgent setup as
  // `prepare`), so these pass on both sides of the change: they are the
  // OFF-invariance pin, not a RED-first case.
  it.each([
    ['no cue', NONE_PROMPT, `${S1}${NONE_PROMPT}`, '[runtime] route=SYSTEM1 | intent=action:fix | task=subAgent'],
    ['risk route', RISK_PROMPT, `${S1}${RISK_PROMPT}`, '[runtime] route=SYSTEM1 | intent=action:review | task=subAgent'],
    ['commit completion', COMMIT_PROMPT, `${S1}${COMMIT_PROMPT}`, '[runtime] route=SYSTEM1 | intent=action:document | task=subAgent'],
    ['design purpose', DESIGN_PROMPT, `${S1}${DESIGN_PROMPT}`, '[runtime] route=SYSTEM1 | intent=action:design | task=subAgent'],
    ['interpretation-only block prompt', BLOCK_PROMPT, `${S1}${BLOCK_PROMPT}`, '[runtime] route=SYSTEM1 | task=subAgent'],
    ['agentTeam', SYSTEM2_PROMPT, `${S2}${SYSTEM2_PROMPT}${EXEC}`, '[runtime] route=SYSTEM2 | intent=action:refactor | task=agentTeam'],
  ])('%s: userPrompt and message equal the pre-CA-15 run', async (_name, prompt, userPrompt, message) => {
    const run = await prepare(prompt);

    expect(run.prepared.userPrompt).toBe(userPrompt);
    expect(run.prepared.message).toBe(message);
    expect(run.prepared.userPrompt).not.toContain('[artibot:question-gate');
    expect(Object.keys(run.mission)).toEqual(MISSION_KEYS_OFF);
  });

  it('records different data but emits the same output when only the interpretation differs', async () => {
    const fed = await prepare(COMMIT_PROMPT);
    vi.mocked(interpretIntent).mockReturnValueOnce(null);
    const withheld = await prepare(COMMIT_PROMPT);

    // The record moves...
    expect(flags(fed.gate)).toEqual([false, true, false, true]);
    expect(flags(withheld.gate)).toEqual([false, false, false, false]);
    expect(fed.gate.interpretation_present).not.toBe(withheld.gate.interpretation_present);
    // ...and nothing the caller sees does.
    expect(withheld.prepared.userPrompt).toBe(fed.prepared.userPrompt);
    expect(withheld.prepared.message).toBe(fed.prepared.message);
    const strip = ({ id: _id, ...task }) => task;
    expect(strip(withheld.prepared.context.tasks)).toEqual(strip(fed.prepared.context.tasks));
  });
});

describe('CA-15 gate inputs — switch ON', () => {
  it('blocks a prompt whose conditions 2 and 4 come only from the interpretation, with inputs_absent: []', async () => {
    const off = await prepare(BLOCK_PROMPT);
    const on = await prepare(BLOCK_PROMPT, { enforce: true });

    // Control: without the two fed inputs this prompt does NOT open the gate.
    expect(requiresQuestion(conditionsBeforeTheFeed(on, BLOCK_PROMPT))).toBe(false);

    expect(flags(on.gate)).toEqual([true, true, true, true]);
    expect(on.gate).toMatchObject({ required: true, interpretation_present: true });
    expect(on.mission.question_gate_enforcement).toEqual({
      enforce: true,
      block: true,
      kind: 'product_decision',
      at: 'adr_start',
      reason: 'all-conditions',
      inputs_absent: [],
    });
    // Suffix only: everything OFF produced is still there, first.
    expect(on.prepared.userPrompt.startsWith(off.prepared.userPrompt)).toBe(true);
    expect(on.prepared.userPrompt.slice(off.prepared.userPrompt.length)).toMatch(
      new RegExp(`^\\n\\n${TAG.replace(/[[\]]/g, '\\$&')}\\n\\S`),
    );
    expect(on.prepared.message).toBe(`${off.prepared.message} | question-gate=block`);
  });

  it('does not block when the interpretation is withheld, and says the input was absent', async () => {
    const off = await prepare(BLOCK_PROMPT);
    vi.mocked(interpretIntent).mockReturnValueOnce(null);
    const on = await prepare(BLOCK_PROMPT, { enforce: true });

    expect(flags(on.gate)).toEqual([true, false, true, false]);
    expect(on.mission.question_gate_enforcement).toEqual({
      enforce: true,
      block: false,
      kind: null,
      at: 'adr_start',
      reason: 'conditions-not-met',
      inputs_absent: ['interpretation'],
    });
    expect(on.prepared.userPrompt).toBe(off.prepared.userPrompt);
    expect(on.prepared.message).toBe(off.prepared.message);
  });

  it('does not block "commit to it": a decision idiom is not a commit request, and the input is present', async () => {
    const off = await prepare(COMMIT_TO_IT_PROMPT);
    const on = await prepare(COMMIT_TO_IT_PROMPT, { enforce: true });

    // Conditions 1 and 3 hold from the prompt; 2 and 4 have nothing to stand on.
    // Before the vocabulary was narrowed this exact sentence was BLOCK_PROMPT.
    expect(flags(on.gate)).toEqual([true, false, true, false]);
    expect(on.mission.question_gate_enforcement).toEqual({
      enforce: true,
      block: false,
      kind: null,
      at: 'adr_start',
      reason: 'conditions-not-met',
      inputs_absent: [],
    });
    expect(on.prepared.userPrompt).toBe(off.prepared.userPrompt);
    expect(on.prepared.message).toBe(off.prepared.message);
  });
});

describe('CA-15 gate inputs — the interpreter cannot reach its neighbours', () => {
  it('a throwing interpreter still records the row, as interpretation absent, and the prompt goes through unchanged', async () => {
    vi.mocked(interpretIntent).mockImplementationOnce(() => { throw new Error('interp-boom'); });
    const run = await prepare(COMMIT_PROMPT);

    expect(run.mission.ok).toBe(true);
    expect(run.mission.question_gate).toBe('appended');
    expect(run.gate.interpretation_present).toBe(false);
    // The throw is recorded as one, not as a caller that supplied none, and not
    // as a row written before CA-15 (which has no status key at all).
    expect(run.gate.interpretation_status).toBe('threw');
    expect(flags(run.gate)).toEqual([false, false, false, false]);
    expect(run.prepared.userPrompt).toBe(`${S1}${COMMIT_PROMPT}`);
    expect(run.prepared.message).toBe('[runtime] route=SYSTEM1 | intent=action:document | task=subAgent');
  });

  it('tells a throw from a withheld interpretation: two rows that differ only in the status', async () => {
    vi.mocked(interpretIntent).mockImplementationOnce(() => { throw new Error('interp-boom'); });
    const threw = await prepare(COMMIT_PROMPT);
    vi.mocked(interpretIntent).mockReturnValueOnce(null);
    const withheld = await prepare(COMMIT_PROMPT);

    const { interpretation_status: threwStatus, ...threwRest } = threw.gate;
    const { interpretation_status: withheldStatus, ...withheldRest } = withheld.gate;
    expect(threwRest).toEqual(withheldRest);
    expect([threwStatus, withheldStatus]).toEqual(['threw', 'absent']);
  });

  it('with the switch on, a throwing interpreter degrades to not blocking, never to a crash', async () => {
    vi.mocked(interpretIntent).mockImplementationOnce(() => { throw new Error('interp-boom'); });
    const on = await prepare(BLOCK_PROMPT, { enforce: true });

    expect(on.mission.ok).toBe(true);
    expect(on.mission.question_gate_enforcement).toMatchObject({
      enforce: true, block: false, reason: 'conditions-not-met', inputs_absent: ['interpretation'],
    });
    expect(on.prepared.userPrompt).not.toContain(TAG);
  });
});

describe('CA-15 follow-up c — the other two reads of routing.classification', () => {
  // `tasks.js` read `routing.classification` in two more places than the gate:
  // the `compileMission` call and (via `workflow-mode.js#planWorkflow`) the
  // planner's `factors`. The router never writes that key, so both were
  // undefined on every prompt. One is deleted (nothing consumes it), the other
  // is read from where the router really puts it.

  it('hands compileMission the prompt, intent, clock and system, and no classification: it reads none', async () => {
    const run = await prepare(RISK_PROMPT);

    expect(compileMission).toHaveBeenCalledTimes(1);
    const [arg] = vi.mocked(compileMission).mock.calls[0];
    expect(Object.keys(arg).sort()).toEqual(['intent', 'nowMs', 'prompt', 'system']);
    expect(arg.prompt).toBe(RISK_PROMPT);
    expect(arg.intent).toBe(run.prepared.context.intent);
    expect(arg.nowMs).toBe(NOW);
    expect(arg.system).toBe('system1');
  });

  it('proves the deleted read was dead: the compile result is the same with or without a classification', async () => {
    const run = await prepare(RISK_PROMPT);
    const [arg] = vi.mocked(compileMission).mock.calls[0];

    const without = JSON.stringify(realCompiler.compileMission(arg));
    // Every shape a caller could plausibly hand it: the router's routing object,
    // and the nested shape the deleted read looked for.
    const shapes = [
      run.routing,
      { score: run.routing.score, factors: run.routing.factors },
      { factors: run.routing.factors, system: 2 },
    ];
    for (const classification of shapes) {
      expect(JSON.stringify(realCompiler.compileMission({ ...arg, classification }))).toBe(without);
    }
    // The comparison can see a difference: another prompt compiles differently.
    expect(JSON.stringify(realCompiler.compileMission({ ...arg, prompt: `${RISK_PROMPT} and rename the README` })))
      .not.toBe(without);
  });

  it("hands the planner the router's score and factors, read off routing itself", async () => {
    const run = await prepare(RISK_PROMPT);

    // Precondition, read off the REAL router: there is something to hand over.
    expect(run.routing.factors.risk).toBeGreaterThanOrEqual(0.5);
    expect(buildWorkflowPlan).toHaveBeenCalledTimes(1);
    const [classification] = vi.mocked(buildWorkflowPlan).mock.calls[0];
    expect(classification).toEqual({ score: run.routing.score, factors: run.routing.factors });
  });
});
