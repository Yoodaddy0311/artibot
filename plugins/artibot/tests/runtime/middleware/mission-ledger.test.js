/**
 * The mission ledger append, tested at its own module boundary.
 *
 * `mission-ledger.js` was split out of `tasks.js` on 2026-09-23 for the
 * 800-line file ceiling. The end-to-end wiring (compile → append → store) stays
 * pinned through the middleware in `tests/runtime/tasks-compile-mission.test.js`
 * and `tests/runtime/middleware/tasks.test.js`; this file pins the four moved
 * exports directly, so a refusal branch the middleware tests never reach still
 * has an owner.
 *
 * WHAT THIS FILE DOES NOT SEE
 *  - A REAL HOOK PAYLOAD. States are hand-built from the keys
 *    `resolveMissionIdentity` reads; whether a live UserPromptSubmit payload
 *    carries them is unmeasured here.
 *  - THE GIT-COMMON-DIR ROUTE. Every project root is a fresh `mkdtemp` outside
 *    any repository, so the ledger lands at `<root>/.artibot/runtime/`. The
 *    common-dir branch of `event-writer.js#ledgerFilePath` is its own suite's.
 *  - The writer's validation. A refused append is produced by stubbing the
 *    `ledger.js` port, not by feeding the real writer a bad envelope.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * The append port, wrapped so one test can make it refuse or throw. The real
 * implementation runs by default — every other test writes a real line.
 */
vi.mock('../../../lib/runtime/ledger.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, appendLedgerEvent: vi.fn(actual.appendLedgerEvent) };
});

const { appendLedgerEvent } = await import('../../../lib/runtime/ledger.js');
const { resetSeq } = await import('../../../lib/runtime/event-writer.js');
const {
  appendMissionEvent,
  missionIntentRevision,
  missionTitle,
  resolveMissionIdentity,
} = await import('../../../lib/runtime/middleware/mission-ledger.js');
const tasksModule = await import('../../../lib/runtime/middleware/tasks.js');

/** 2023-11-14T22:13:20.000Z */
const NOW = 1700000000000;
const SESSION = 'sess-mledger-0001';
/** `M-<UTC date>-S<first 8 alnum of the session id>`, spelled out, not derived. */
const MISSION_ID = 'M-20231114-Ssessmled';

let projectRoot;

beforeEach(() => {
  resetSeq();
  projectRoot = mkdtempSync(path.join(tmpdir(), 'artibot-mission-ledger-'));
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
  vi.mocked(appendLedgerEvent).mockClear();
});

/** @returns {string} the ledger file under the temp project root */
function ledgerPath() {
  return path.join(projectRoot, '.artibot', 'runtime', 'ledger.jsonl');
}

/** @returns {object[]} every JSON line in the temp ledger */
function readLedger() {
  if (!existsSync(ledgerPath())) return [];
  return readFileSync(ledgerPath(), 'utf-8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

/**
 * @param {object} [input] merged over the default `state.input`
 * @returns {object} a middleware state carrying a root and a session
 */
function makeState(input = {}) {
  return {
    input: { prompt: 'build the dashboard', hookData: { session_id: SESSION, cwd: projectRoot }, ...input },
    context: {},
  };
}

/**
 * @param {object} state
 * @param {object} result a `compileMission()`-shaped result
 * @returns {{ok: boolean, status: string, event?: string}}
 */
function append(state, result) {
  return appendMissionEvent(state, result, NOW, resolveMissionIdentity(state, NOW));
}

describe('tasks.js export surface after the split', () => {
  it('still exports exactly the five names hooks import by path', () => {
    expect(Object.keys(tasksModule).sort()).toEqual([
      'FOLLOW_WORKFLOW_PLAN_CONFIG_KEY',
      'createTasksMiddleware',
      'missionMutator',
      'openMissionStore',
      'planRevisionMutator',
    ]);
  });
});

describe('missionTitle', () => {
  it('uses the contract goal when there is one', () => {
    expect(missionTitle({ contract: { goal: 'ship it' } }, 'raw prompt')).toBe('ship it');
  });

  it.each([
    ['no contract', {}],
    ['an empty goal', { contract: { goal: '' } }],
    ['a non-string goal', { contract: { goal: 42 } }],
  ])('falls back to the prompt on %s', (_label, result) => {
    expect(missionTitle(result, 'raw prompt')).toBe('raw prompt');
  });

  it('caps the title at 120 characters, goal or fallback', () => {
    expect(missionTitle({ contract: { goal: 'g'.repeat(400) } }, 'p')).toBe('g'.repeat(120));
    expect(missionTitle({}, '가'.repeat(400))).toBe('가'.repeat(120));
  });
});

describe('missionIntentRevision', () => {
  it('passes an integer revision through', () => {
    expect(missionIntentRevision({ contract: { intent_revision: 3 } })).toBe(3);
  });

  it.each([
    ['no contract', {}],
    ['a fractional revision', { contract: { intent_revision: 1.5 } }],
    ['a string revision', { contract: { intent_revision: '2' } }],
  ])('defaults to 1 on %s', (_label, result) => {
    expect(missionIntentRevision(result)).toBe(1);
  });
});

describe('resolveMissionIdentity', () => {
  it('derives the mission id from the ONE instant it is given', () => {
    expect(resolveMissionIdentity(makeState(), NOW)).toEqual({
      projectRoot, sessionId: SESSION, missionId: MISSION_ID,
    });
    // Two instants either side of a UTC midnight name two different missions,
    // which is why the caller must read the clock once and pass it here.
    const beforeMidnight = Date.UTC(2023, 10, 14, 23, 59, 59, 999);
    const afterMidnight = beforeMidnight + 1;
    expect(resolveMissionIdentity(makeState(), beforeMidnight).missionId).toBe('M-20231114-Ssessmled');
    expect(resolveMissionIdentity(makeState(), afterMidnight).missionId).toBe('M-20231115-Ssessmled');
  });

  it('returns a null mission id exactly when the session id is null', () => {
    for (const hookData of [{ cwd: projectRoot }, { cwd: projectRoot, session_id: '   ' }]) {
      expect(resolveMissionIdentity({ input: { hookData } }, NOW)).toEqual({
        projectRoot, sessionId: null, missionId: null,
      });
    }
  });

  it('trims the session id and prefers the hook payload over input.sessionId', () => {
    const state = { input: { sessionId: 'other-session', hookData: { session_id: `  ${SESSION} ` } } };
    expect(resolveMissionIdentity(state, NOW).sessionId).toBe(SESSION);
    expect(resolveMissionIdentity({ input: { sessionId: SESSION } }, NOW).sessionId).toBe(SESSION);
  });

  it('reads the project root in its stated precedence order', () => {
    const hookData = { cwd: '/c', working_directory: '/w', path: '/p' };
    const at = (state) => resolveMissionIdentity(state, NOW).projectRoot;
    expect(at({ input: { projectRoot: '/i', hookData }, context: { projectRoot: '/x' } })).toBe('/i');
    expect(at({ input: { hookData }, context: { projectRoot: '/x' } })).toBe('/x');
    expect(at({ input: { hookData } })).toBe('/c');
    expect(at({ input: { hookData: { working_directory: '/w', path: '/p' } } })).toBe('/w');
    expect(at({ input: { hookData: { path: '/p' } } })).toBe('/p');
    expect(at({ input: { hookData: { cwd: '' } } })).toBeNull();
  });
});

describe('appendMissionEvent — the compiler-name allowlist map', () => {
  it('appends mission.created with exactly its required data', () => {
    const status = append(makeState(), {
      meta: { ledgerEvent: 'mission.created' },
      contract: { goal: 'ship it', intent_revision: 2 },
    });
    expect(status).toEqual({ ok: true, status: 'appended', event: 'mission.created' });
    const lines = readLedger();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      event: 'mission.created',
      mission_id: MISSION_ID,
      session_id: SESSION,
      source: 'hook',
      ts: new Date(NOW).toISOString(),
      data: { title: 'ship it', intent_revision: 2 },
    });
    expect(Object.keys(lines[0].data).sort()).toEqual(['intent_revision', 'title']);
  });

  it.each([
    ['mission-candidate-deferred'],
    ['mission.candidate_deferred'],
  ])('writes the compiler spelling %s under the allowlist name', (compilerName) => {
    const status = append(makeState(), {
      meta: { ledgerEvent: compilerName },
      deferred: true,
      signals: Array.from({ length: 30 }, (_, i) => `s${i}`),
    });
    expect(status).toEqual({ ok: true, status: 'appended', event: 'mission.candidate_deferred' });
    const [line] = readLedger();
    expect(line.event).toBe('mission.candidate_deferred');
    expect(line.data.reason).toBe('substantive-gate:deferred');
    expect(line.data.signals).toHaveLength(20);
    expect(line.data.title).toBe('build the dashboard');
  });

  it('records a non-substantive candidate with its own reason and no signals list', () => {
    append(makeState(), { meta: { ledgerEvent: 'mission-candidate-deferred' }, deferred: false });
    const [line] = readLedger();
    expect(line.data.reason).toBe('substantive-gate:not-substantive');
    expect(line.data.signals).toEqual([]);
  });

  it.each([
    ['an unknown name', 'mission.bogus'],
    ['a missing name', undefined],
    ['an inherited Object property', 'toString'],
  ])('skips %s and writes nothing', (_label, compilerName) => {
    const status = append(makeState(), { meta: { ledgerEvent: compilerName } });
    expect(status).toEqual({ ok: false, status: `skipped:unknown-event:${compilerName}` });
    expect(existsSync(ledgerPath())).toBe(false);
    expect(appendLedgerEvent).not.toHaveBeenCalled();
  });
});

describe('appendMissionEvent — refusal statuses', () => {
  const created = { meta: { ledgerEvent: 'mission.created' }, contract: { goal: 'g' } };

  it('skips with no project root', () => {
    const state = { input: { prompt: 'p', hookData: { session_id: SESSION } } };
    expect(append(state, created)).toEqual({ ok: false, status: 'skipped:no-project-root' });
    expect(appendLedgerEvent).not.toHaveBeenCalled();
  });

  it('skips with no session id', () => {
    const state = { input: { prompt: 'p', hookData: { cwd: projectRoot } } };
    expect(append(state, created)).toEqual({ ok: false, status: 'skipped:no-session-id' });
    expect(appendLedgerEvent).not.toHaveBeenCalled();
    expect(existsSync(ledgerPath())).toBe(false);
  });

  it('reports a refused append as rejected, with the writer reason', () => {
    vi.mocked(appendLedgerEvent).mockReturnValueOnce({ ok: false, reason: 'probe-refusal' });
    expect(append(makeState(), created))
      .toEqual({ ok: false, status: 'rejected:probe-refusal', event: 'mission.created' });
  });

  it('reports a result-less append as rejected:unknown', () => {
    vi.mocked(appendLedgerEvent).mockReturnValueOnce(undefined);
    expect(append(makeState(), created))
      .toEqual({ ok: false, status: 'rejected:unknown', event: 'mission.created' });
  });

  it('turns a throwing append into an error status instead of throwing', () => {
    vi.mocked(appendLedgerEvent).mockImplementationOnce(() => { throw new Error('boom'); });
    expect(append(makeState(), created))
      .toEqual({ ok: false, status: 'error:boom', event: 'mission.created' });
  });
});
