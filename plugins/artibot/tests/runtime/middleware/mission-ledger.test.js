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

const { appendLedgerEvent, readAllEvents } = await import('../../../lib/runtime/ledger.js');
const { resetSeq } = await import('../../../lib/runtime/event-writer.js');
const {
  appendMissionEvent,
  missionEventIdempotencyKey,
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

/** A host prompt id, UUID-shaped like the live UserPromptSubmit payload's. */
const PROMPT_ID = 'a6bf2474-77cd-4b1b-a4dc-a2d3ef6029a5';

/**
 * @param {unknown} promptId the payload's `prompt_id`
 * @returns {object} {@link makeState} with that prompt id in the hook payload
 */
function makePromptState(promptId) {
  return makeState({ hookData: { session_id: SESSION, cwd: projectRoot, prompt_id: promptId } });
}

describe('missionEventIdempotencyKey', () => {
  const data = { title: 'ship it', intent_revision: 1 };
  const key = (over = {}) => {
    const a = { event: 'mission.created', mission: MISSION_ID, prompt: PROMPT_ID, data, ...over };
    return missionEventIdempotencyKey(a.event, a.mission, a.prompt, a.data);
  };

  it('is <event>:<mission_id>:<prompt_id>:<16-hex digest of data>', () => {
    expect(key()).toMatch(
      new RegExp(`^mission\\.created:${MISSION_ID}:${PROMPT_ID}:[0-9a-f]{16}$`),
    );
  });

  it('gives the same inputs the same key — no clock, pid or seq is read', () => {
    expect(key()).toBe(key());
    expect(key({ data: { ...data } })).toBe(key());
  });

  it.each([
    ['event', { event: 'mission.candidate_deferred' }],
    ['mission id', { mission: 'M-20231115-Ssessmled' }],
    ['prompt id', { prompt: 'b9eb2211-2671-44be-8a37-cd3dda94b1d6' }],
    ['intent revision', { data: { ...data, intent_revision: 2 } }],
    ['title', { data: { ...data, title: 'ship it now' } }],
  ])('gives a different %s a different key', (_label, over) => {
    // Keyed first: a builder that returned null for the varied input would
    // otherwise pass the inequality below.
    expect(key(over)).toMatch(/^mission\.[a-z_]+:M-\d{8}-S[A-Za-z0-9]+:[^:]+:[0-9a-f]{16}$/);
    expect(key(over)).not.toBe(key());
  });

  it.each([
    ['no prompt id', { prompt: undefined }],
    ['an empty prompt id', { prompt: '' }],
    ['a non-string prompt id', { prompt: 42 }],
    ['a prompt id over 128 characters', { prompt: 'p'.repeat(129) }],
    ['no mission id', { mission: null }],
    ['no event', { event: '' }],
  ])('returns null on %s, so the caller omits the field', (_label, over) => {
    expect(key(over)).toBeNull();
  });

  it('keys a prompt id of exactly 128 characters', () => {
    expect(key({ prompt: 'p'.repeat(128) })).toMatch(/^mission\.created:/);
  });
});

describe('appendMissionEvent — idempotency_key', () => {
  const created = { meta: { ledgerEvent: 'mission.created' }, contract: { goal: 'ship it' } };
  const deferred = { meta: { ledgerEvent: 'mission-candidate-deferred' }, deferred: true, signals: ['s1'] };

  it.each([
    ['mission.created', created],
    ['mission.candidate_deferred', deferred],
  ])('writes %s with the key built from the line it appends', (eventName, result) => {
    expect(append(makePromptState(PROMPT_ID), result).status).toBe('appended');
    const [line] = readLedger();
    expect(line.event).toBe(eventName);
    expect(line.idempotency_key)
      .toBe(missionEventIdempotencyKey(eventName, MISSION_ID, PROMPT_ID, line.data));
  });

  it('keys a re-fired prompt identically, even at a later instant of the same UTC day', () => {
    const state = makePromptState(PROMPT_ID);
    appendMissionEvent(state, created, NOW, resolveMissionIdentity(state, NOW));
    const later = NOW + 60_000;
    appendMissionEvent(state, created, later, resolveMissionIdentity(state, later));
    const [first, second] = readLedger();
    expect(second.ts).not.toBe(first.ts);
    expect(first.idempotency_key).toMatch(/^mission\.created:/);
    expect(second.idempotency_key).toBe(first.idempotency_key);
  });

  it('keys a new prompt differently even when its text is the same', () => {
    append(makePromptState(PROMPT_ID), created);
    append(makePromptState('b9eb2211-2671-44be-8a37-cd3dda94b1d6'), created);
    const [first, second] = readLedger();
    expect(second.data).toEqual(first.data);
    expect(second.idempotency_key).not.toBe(first.idempotency_key);
  });

  it('omits the key, never blanks it, when the payload has no prompt id', () => {
    for (const promptId of [undefined, '', 'p'.repeat(129)]) {
      expect(append(makePromptState(promptId), created).status).toBe('appended');
    }
    const lines = readLedger();
    expect(lines).toHaveLength(3);
    for (const line of lines) expect(line).not.toHaveProperty('idempotency_key');
  });

  it('keeps a legacy keyless line readable beside a keyed one', () => {
    append(makeState(), deferred);
    append(makePromptState(PROMPT_ID), created);
    const events = readAllEvents(projectRoot, { session_id: SESSION });
    expect(events.map((e) => [e.event, e.mission_id, 'idempotency_key' in e])).toEqual([
      ['mission.candidate_deferred', MISSION_ID, false],
      ['mission.created', MISSION_ID, true],
    ]);
  });

  it('keeps a worst-case keyed line under the 4 KB cap without folding it', () => {
    const state = makeState({
      prompt: '가'.repeat(400),
      hookData: { session_id: SESSION, cwd: projectRoot, prompt_id: 'p'.repeat(128) },
    });
    append(state, { ...deferred, signals: Array.from({ length: 30 }, (_, i) => `signal-${i}`) });
    const raw = readFileSync(ledgerPath(), 'utf-8').split('\n')[0];
    expect(Buffer.byteLength(raw, 'utf8')).toBeLessThan(4096);
    const line = JSON.parse(raw);
    expect(line.idempotency_key).toMatch(/^mission\.candidate_deferred:/);
    expect(line.data).not.toHaveProperty('evidence_refs');
  });
});
