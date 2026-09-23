/**
 * Unit contract for `lib/runtime/human-asked-record.js` — the single recorder
 * the three PreToolUse hooks share (T-39 symmetry).
 *
 * WHAT THIS FILE PINS, AND WHY EACH PROPERTY IS LOAD-BEARING
 *  - **`cwd` gates the whole append.** The root is injected, never derived: a
 *    record filed under the wrong project is a false history, a missing record
 *    is merely a gap. So "no cwd → zero appends" is the first case, not an
 *    afterthought.
 *  - **The `data` KEY SET, not just its values.** `gate` and `path` are
 *    conditional keys and `command` must never appear. Asserting
 *    `Object.keys(data)` is what makes those absences measurable; an
 *    `objectContaining` assertion would pass while the recorder leaked a
 *    command string into the ledger.
 *  - **Never throws.** Recording runs after the decision is already on stdout.
 *    A recorder that rejects turns bookkeeping into an unhandled rejection in
 *    a security hook.
 *
 * ── MOCK BOUNDARY (deliberate) ──────────────────────────────────────────────
 *  `lib/runtime/ledger.js` and `lib/git/project-root.js` are mocked — they are
 *  the filesystem edge. `lib/security/human-gates.js` is NOT: it is a pure
 *  classifier, and mocking it would make every `hits`/`gate` expectation below
 *  a restatement of the mock instead of a measurement of the matrix. The gate
 *  ids asserted here are therefore real outputs of `classify()`.
 *
 * ── WHAT THIS FILE CANNOT SEE ───────────────────────────────────────────────
 *  - Whether the hooks actually CALL the recorder at their block points, and
 *    whether they call it after `writeStdout`. That is
 *    `tests/hooks/*.test.js` (ordering) and
 *    `tests/runtime/human-asked-record.spawn.test.js` (real process).
 *  - Whether the produced line survives the ledger allowlist. `appendLedgerEvent`
 *    is a spy here, so a shape that would land as `ledger.rejected` still
 *    passes. The spawn suite reads a real ledger file for exactly that reason.
 *  - Line folding. `lib/runtime/event-writer.js#foldOversized` drops every
 *    non-required `data` key past 4096 bytes, which for this event means
 *    everything except `question_id` survives a long `reason`. Nothing here
 *    exercises that threshold.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const RECORDER = '../../lib/runtime/human-asked-record.js';
const LEDGER = '../../lib/runtime/ledger.js';
const PROJECT_ROOT = '../../lib/git/project-root.js';

const mocks = vi.hoisted(() => ({ append: vi.fn() }));

const SID = 'sess1234abcd';
const CWD = '/project';
/**
 * What the stubbed `resolveProjectRoot` returns. A REAL relative path rather
 * than a decorated sentinel: if a mock ever fails to install, the genuine
 * `appendLedgerEvent` runs, and a sentinel with `<>` or `:` in it would be
 * silently unwritable on Windows while creating a junk directory on Linux CI.
 * A plain path fails the same way everywhere.
 */
const RESOLVED_ROOT = `/resolved-root${CWD}`;

/**
 * (Re-)install both filesystem-edge stubs.
 *
 * Registered per test rather than once at module scope on purpose: two cases
 * below swap a dependency for a throwing one, and `vi.doMock` overrides are
 * sticky. Re-registering here means every test starts from the spy no matter
 * what its predecessor did — the alternative (`vi.doUnmock`) removes the
 * registration outright and lets the REAL ledger load in the next test, which
 * is exactly how this file first went green against a spy that was never
 * called.
 */
function installEdgeMocks() {
  vi.doMock(LEDGER, () => ({ appendLedgerEvent: mocks.append }));
  // The stub keeps `resolveProjectRoot`'s own git-walking out of scope; what
  // this file measures is that the recorder routes the payload cwd through it,
  // not how it resolves.
  vi.doMock(PROJECT_ROOT, () => ({ resolveProjectRoot: (cwd) => `/resolved-root${cwd}` }));
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  installEdgeMocks();
});

/**
 * Load the recorder fresh. Dynamic rather than static so the cases that swap a
 * dependency for a throwing one (via `vi.doMock` + `vi.resetModules`) get a
 * module graph built against that swap.
 * @returns {Promise<object>}
 */
async function loadRecorder() {
  return import(RECORDER);
}

/** A Bash PreToolUse payload. @returns {object} */
function bashData(command, { cwd = CWD, sessionId = SID } = {}) {
  const data = { tool_name: 'Bash', tool_input: { command }, session_id: sessionId };
  if (cwd !== null) data.cwd = cwd;
  return data;
}

/** A Write/Edit PreToolUse payload. @returns {object} */
function writeData(filePath, { tool = 'Write', cwd = CWD, sessionId = SID } = {}) {
  const input = filePath === null ? {} : { file_path: filePath };
  const data = { tool_name: tool, tool_input: input, session_id: sessionId };
  if (cwd !== null) data.cwd = cwd;
  return data;
}

/** The single event handed to `appendLedgerEvent`. @returns {object} */
function onlyEvent() {
  expect(mocks.append).toHaveBeenCalledTimes(1);
  return mocks.append.mock.calls[0][1];
}

describe('recordHumanAsked — when it records at all', () => {
  it.each([
    ['absent', null],
    ['an empty string', ''],
  ])('appends nothing when cwd is %s', async (_label, cwd) => {
    const { recordHumanAsked } = await loadRecorder();
    const hookData = bashData('rm -rf /tmp/data', { cwd });

    await recordHumanAsked({ hookData, tool: 'Bash', reason: 'blocked' });

    expect(mocks.append).not.toHaveBeenCalled();
  });

  it('appends nothing when there is no payload at all', async () => {
    const { recordHumanAsked } = await loadRecorder();

    await recordHumanAsked({ hookData: null, tool: 'Write', reason: 'blocked' });

    expect(mocks.append).not.toHaveBeenCalled();
  });

  it('anchors the append on the resolved project root, not the raw cwd', async () => {
    const { recordHumanAsked } = await loadRecorder();

    await recordHumanAsked({ hookData: bashData('rm -rf /tmp/data'), tool: 'Bash', reason: 'r' });

    expect(mocks.append.mock.calls[0][0]).toBe(RESOLVED_ROOT);
  });

  it('writes a hook-sourced human.asked envelope carrying the session id', async () => {
    const { recordHumanAsked } = await loadRecorder();

    await recordHumanAsked({ hookData: bashData('rm -rf /tmp/data'), tool: 'Bash', reason: 'r' });

    const event = onlyEvent();
    expect(event.event).toBe('human.asked');
    expect(event.source).toBe('hook');
    expect(event.session_id).toBe(SID);
  });
});

describe('recordHumanAsked — Bash data shape', () => {
  /**
   * The same three commands the pre-Bash invariance gate measures
   * (`tests/firewall/hook-decision-invariance.test.js`), chosen for their hit
   * count: none, one, two. Hardcoded rather than computed from `classify()` so
   * this is an assertion about the matrix and not a tautology.
   */
  const BLOCKED = [
    { command: 'rm -rf /tmp/data', hits: [], gate: null },
    { command: 'git push --force origin main', hits: ['HG-07'], gate: 'HG-07' },
    // HG-07 and HG-13 are BOTH `default: 'human'` (human-gates.js:171 and :292,
    // measured 2026-09-05), so this is a severity TIE, not a ranking. The tie
    // breaks toward the first hit — which is why `gate` reads HG-07 and not the
    // later, more specific-sounding HG-13. The pre-Bash invariance gate encodes
    // the same expectation as `data.gate === spec.hits[0]`.
    { command: 'git push --force --no-verify origin main', hits: ['HG-07', 'HG-13'], gate: 'HG-07' },
  ];

  it.each(BLOCKED)('records hits $hits for: $command', async ({ command, hits, gate }) => {
    const { buildQuestionId, recordHumanAsked } = await loadRecorder();
    const reason = `DANGEROUS COMMAND DETECTED: ${command}`;

    await recordHumanAsked({ hookData: bashData(command), tool: 'Bash', reason });

    const { data } = onlyEvent();
    expect(data.hits).toEqual(hits);
    expect(data.tool).toBe('Bash');
    expect(data.decision).toBe('block');
    expect(data.reason).toBe(reason);
    expect(data.question_id).toBe(buildQuestionId(SID, gate, command));
  });

  it.each(BLOCKED)('omits `gate` only when nothing claims: $command', async ({ command, gate }) => {
    const { recordHumanAsked } = await loadRecorder();

    await recordHumanAsked({ hookData: bashData(command), tool: 'Bash', reason: 'r' });

    const { data } = onlyEvent();
    // The allowlist types `human.asked.data.gate` as a string, so a null would
    // make the whole line a `ledger.rejected` and the record would be lost.
    // Absence, not null, is the contract.
    if (gate === null) {
      expect(Object.prototype.hasOwnProperty.call(data, 'gate')).toBe(false);
    } else {
      expect(data.gate).toBe(gate);
    }
  });

  it('carries the command in `reason` and nowhere else', async () => {
    const { recordHumanAsked } = await loadRecorder();
    const command = 'git push --force origin main';

    await recordHumanAsked({
      hookData: bashData(command), tool: 'Bash', reason: `blocked: ${command}`,
    });

    const { data } = onlyEvent();
    // A `command` key would be a second, unreviewed copy of the subject in the
    // ledger — the Bash record deliberately has one home for it.
    expect(Object.keys(data).sort()).toEqual(
      ['decision', 'gate', 'hits', 'question_id', 'reason', 'tool'],
    );
  });

  it('records an empty hit list when the payload carries no command', async () => {
    const { buildQuestionId, recordHumanAsked } = await loadRecorder();
    const hookData = { tool_name: 'Bash', tool_input: {}, session_id: SID, cwd: CWD };

    await recordHumanAsked({ hookData, tool: 'Bash', reason: 'hook error' });

    const { data } = onlyEvent();
    expect(data.hits).toEqual([]);
    expect(data.question_id).toBe(buildQuestionId(SID, null, ''));
  });
});

describe('recordHumanAsked — Write/Edit data shape', () => {
  it.each(['Write', 'Edit'])('%s to artibot.config.json hits both HG-02 and HG-13', async (tool) => {
    const { buildQuestionId, recordHumanAsked } = await loadRecorder();
    const filePath = '/project/artibot.config.json';

    await recordHumanAsked({ hookData: writeData(filePath, { tool }), tool, reason: 'r' });

    const { data } = onlyEvent();
    // Measured against the real matrix on 2026-09-05: HG-02 (local edit,
    // `default: auto`) and HG-13 (security policy, `default: human`). The
    // strictest of the two is what `gate` reports.
    expect(data.hits).toEqual(['HG-02', 'HG-13']);
    expect(data.gate).toBe('HG-13');
    expect(data.tool).toBe(tool);
    expect(data.path).toBe(filePath);
    expect(data.question_id).toBe(buildQuestionId(SID, 'HG-13', filePath));
    expect(Object.keys(data).sort()).toEqual(
      ['decision', 'gate', 'hits', 'path', 'question_id', 'reason', 'tool'],
    );
  });

  it('omits `gate` for a path no gate row claims', async () => {
    const { buildQuestionId, recordHumanAsked } = await loadRecorder();
    const filePath = '/project/.env';

    await recordHumanAsked({ hookData: writeData(filePath), tool: 'Write', reason: 'r' });

    const { data } = onlyEvent();
    // NOT an oversight in the matrix and NOT a bug here: HG-11's signature is a
    // COMMAND pattern (`^\s*cat …`), so a Write whose *path* is `.env` matches
    // no row even though the pre-write hook blocks it on other grounds. The
    // record is still worth writing — it just carries no gate id.
    expect(data.hits).toEqual([]);
    expect(Object.prototype.hasOwnProperty.call(data, 'gate')).toBe(false);
    expect(data.path).toBe(filePath);
    expect(data.question_id).toBe(buildQuestionId(SID, null, filePath));
  });

  it('omits `path` when the payload carries no file_path', async () => {
    const { buildQuestionId, recordHumanAsked } = await loadRecorder();

    await recordHumanAsked({ hookData: writeData(null), tool: 'Write', reason: 'hook error' });

    const { data } = onlyEvent();
    expect(data.hits).toEqual([]);
    expect(Object.prototype.hasOwnProperty.call(data, 'path')).toBe(false);
    expect(data.question_id).toBe(buildQuestionId(SID, null, ''));
    expect(Object.keys(data).sort()).toEqual(
      ['decision', 'hits', 'question_id', 'reason', 'tool'],
    );
  });

  it('subjects the question id on the path, so two files are two questions', async () => {
    const { buildQuestionId } = await loadRecorder();

    expect(buildQuestionId(SID, null, '/project/a.env'))
      .not.toBe(buildQuestionId(SID, null, '/project/b.env'));
  });
});

describe('recordHumanAsked — never throws', () => {
  it('resolves when the ledger module cannot be loaded', async () => {
    vi.doMock('../../lib/runtime/ledger.js', () => {
      throw new Error('ledger module is broken');
    });
    const { recordHumanAsked } = await loadRecorder();

    await expect(
      recordHumanAsked({ hookData: bashData('rm -rf /tmp/data'), tool: 'Bash', reason: 'r' }),
    ).resolves.toBeUndefined();

  });

  it('resolves when appendLedgerEvent itself throws', async () => {
    mocks.append.mockImplementationOnce(() => { throw new Error('disk is gone'); });
    const { recordHumanAsked } = await loadRecorder();

    await expect(
      recordHumanAsked({ hookData: bashData('rm -rf /tmp/data'), tool: 'Bash', reason: 'r' }),
    ).resolves.toBeUndefined();

    // NEGATIVE CONTROL: the throw has to have come from the real call path.
    // Without this the case would pass just as well if the recorder had
    // skipped the append entirely.
    expect(mocks.append).toHaveBeenCalledTimes(1);
  });

  it('resolves when the project root cannot be resolved', async () => {
    vi.doMock('../../lib/git/project-root.js', () => ({
      resolveProjectRoot: () => { throw new Error('no root'); },
    }));
    const { recordHumanAsked } = await loadRecorder();

    await expect(
      recordHumanAsked({ hookData: bashData('rm -rf /tmp/data'), tool: 'Bash', reason: 'r' }),
    ).resolves.toBeUndefined();
    expect(mocks.append).not.toHaveBeenCalled();

  });

  /**
   * A non-object argument must not reject.
   *
   * "Never throws" is the recorder's whole safety story: it runs AFTER the
   * decision is already on stdout, inside the hook's async tail. A rejection
   * there is an unhandled promise rejection in a PreToolUse security hook, and
   * on a non-zero exit Claude Code has a hook that produced a decision AND an
   * error — the exact ambiguity the fail-closed design exists to avoid.
   *
   * `null` is the case that actually bites: the argument is destructured in the
   * PARAMETER LIST, so `= {}` only covers `undefined`. `null` reaches the
   * destructuring and throws a TypeError before the `try` block is ever
   * entered, which no amount of internal error handling can catch. `42` and
   * `'str'` box into objects and pass through harmlessly, so they are the
   * controls that show the fix is about nullish-ness and not about "object or
   * bust". Found by cross-check (④) 2026-09-05, reproduced by the leader.
   */
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a number', 42],
    ['a string', 'str'],
  ])('resolves when the argument is %s', async (_label, arg) => {
    const { recordHumanAsked } = await loadRecorder();

    await expect(recordHumanAsked(arg)).resolves.toBeUndefined();

    // NEGATIVE CONTROL: a non-object argument carries no `cwd`, so the correct
    // behaviour is to resolve AND record nothing. Without this, a "fix" that
    // swallowed the TypeError while still appending a rootless line would pass.
    expect(mocks.append).not.toHaveBeenCalled();
  });

  it('resolves when called with no argument at all', async () => {
    const { recordHumanAsked } = await loadRecorder();

    await expect(recordHumanAsked()).resolves.toBeUndefined();
    expect(mocks.append).not.toHaveBeenCalled();
  });
});

describe('strictestGate', () => {
  it('ranks human above policy above auto, and returns null for no hits', async () => {
    const { strictestGate } = await loadRecorder();
    const rows = {
      A: { default: 'auto' },
      P: { default: 'policy' },
      H: { default: 'human' },
      U: { default: 'not-a-severity' },
    };
    const get = (id) => rows[id] ?? null;

    expect(strictestGate([], get)).toBeNull();
    expect(strictestGate([{ id: 'A' }], get)).toBe('A');
    expect(strictestGate([{ id: 'A' }, { id: 'P' }], get)).toBe('P');
    expect(strictestGate([{ id: 'A' }, { id: 'P' }, { id: 'H' }], get)).toBe('H');
    // Order must not decide the answer.
    expect(strictestGate([{ id: 'H' }, { id: 'A' }], get)).toBe('H');
    // An unknown severity scores zero, so it never wins — and a hit list made
    // only of unknowns yields null rather than an arbitrary first element.
    expect(strictestGate([{ id: 'U' }], get)).toBeNull();
    expect(strictestGate([{ id: 'U' }, { id: 'A' }], get)).toBe('A');
    // A row the registry does not know at all must not throw.
    expect(strictestGate([{ id: 'MISSING' }], get)).toBeNull();
  });

  it('ties break toward the first hit, so the value is order-stable', async () => {
    const { strictestGate } = await loadRecorder();
    const get = () => ({ default: 'human' });

    expect(strictestGate([{ id: 'X' }, { id: 'Y' }], get)).toBe('X');
  });
});

/**
 * SH-14: both events carry a deterministic envelope `idempotency_key`.
 *
 * The expected keys are spelled out as literals built from `buildQuestionId`
 * rather than by calling the key builders, so a builder that drifted would
 * fail here instead of agreeing with itself.
 */
describe('idempotency keys — builders', () => {
  const QID = 'q-sess1234-0123456789ab';

  it('keys an ask on its session and question id', async () => {
    const { humanAskedIdempotencyKey } = await loadRecorder();

    expect(humanAskedIdempotencyKey(SID, QID)).toBe(`human.asked:${SID}:${QID}`);
    expect(humanAskedIdempotencyKey(SID, QID)).toBe(humanAskedIdempotencyKey(SID, QID));
    expect(humanAskedIdempotencyKey(SID, 'q-sess1234-ba9876543210'))
      .not.toBe(humanAskedIdempotencyKey(SID, QID));
    expect(humanAskedIdempotencyKey('otherSession', QID))
      .not.toBe(humanAskedIdempotencyKey(SID, QID));
  });

  it('keys a resolve on its session, question id and decision', async () => {
    const { humanResolvedIdempotencyKey } = await loadRecorder();
    const key = humanResolvedIdempotencyKey(SID, QID, 'yes, push it');

    expect(key).toMatch(new RegExp(`^human\\.resolved:${SID}:${QID}:[0-9a-f]{12}$`));
    expect(humanResolvedIdempotencyKey(SID, QID, 'yes, push it')).toBe(key);
    // A different answer to the same question is a new fact.
    expect(humanResolvedIdempotencyKey(SID, QID, 'no, keep it')).not.toBe(key);
  });

  it('never gives an ask and its resolve the same key', async () => {
    const { humanAskedIdempotencyKey, humanResolvedIdempotencyKey } = await loadRecorder();

    expect(humanResolvedIdempotencyKey(SID, QID, 'yes'))
      .not.toBe(humanAskedIdempotencyKey(SID, QID));
  });

  it('bounds the resolve key regardless of the decision length', async () => {
    const { humanResolvedIdempotencyKey } = await loadRecorder();
    const long = '결'.repeat(1000);

    const key = humanResolvedIdempotencyKey(SID, QID, long);

    expect(key).not.toContain('결');
    expect(key.length).toBe(`human.resolved:${SID}:${QID}:`.length + 12);
  });

  it.each([
    ['undefined', undefined],
    ['an empty string', ''],
    ['a number', 42],
  ])('returns null, never an empty string, when the session is %s', async (_label, sid) => {
    const { humanAskedIdempotencyKey, humanResolvedIdempotencyKey } = await loadRecorder();

    expect(humanAskedIdempotencyKey(sid, QID)).toBeNull();
    expect(humanResolvedIdempotencyKey(sid, QID, 'yes')).toBeNull();
  });

  it('returns null when the question id or the decision is missing', async () => {
    const { humanAskedIdempotencyKey, humanResolvedIdempotencyKey } = await loadRecorder();

    expect(humanAskedIdempotencyKey(SID, '')).toBeNull();
    expect(humanResolvedIdempotencyKey(SID, '', 'yes')).toBeNull();
    expect(humanResolvedIdempotencyKey(SID, QID, '')).toBeNull();
    expect(humanResolvedIdempotencyKey(SID, QID, undefined)).toBeNull();
  });
});

describe('idempotency keys — what reaches appendLedgerEvent', () => {
  const COMMAND = 'git push --force origin main';

  it('puts the ask key on the human.asked envelope', async () => {
    const { buildQuestionId, recordHumanAsked } = await loadRecorder();

    await recordHumanAsked({ hookData: bashData(COMMAND), tool: 'Bash', reason: 'r' });

    const event = onlyEvent();
    expect(event.idempotency_key)
      .toBe(`human.asked:${SID}:${buildQuestionId(SID, 'HG-07', COMMAND)}`);
    // Envelope, not data: the allowlist says envelope keys are never repeated
    // inside `data`.
    expect(Object.prototype.hasOwnProperty.call(event.data, 'idempotency_key')).toBe(false);
  });

  it('reuses the key when the same block is recorded twice', async () => {
    const { recordHumanAsked } = await loadRecorder();

    await recordHumanAsked({ hookData: bashData(COMMAND), tool: 'Bash', reason: 'r' });
    await recordHumanAsked({ hookData: bashData(COMMAND), tool: 'Bash', reason: 'r' });

    expect(mocks.append).toHaveBeenCalledTimes(2);
    const [first, second] = mocks.append.mock.calls.map((call) => call[1].idempotency_key);
    expect(typeof first).toBe('string');
    expect(second).toBe(first);
  });

  it('gives a different subject a different key', async () => {
    const { recordHumanAsked } = await loadRecorder();

    await recordHumanAsked({ hookData: writeData('/project/a.env'), tool: 'Write', reason: 'r' });
    await recordHumanAsked({ hookData: writeData('/project/b.env'), tool: 'Write', reason: 'r' });

    const [a, b] = mocks.append.mock.calls.map((call) => call[1].idempotency_key);
    expect(a).not.toBe(b);
  });

  it('omits the key, rather than writing an empty one, when the payload has no session', async () => {
    const { recordHumanAsked } = await loadRecorder();
    const hookData = { tool_name: 'Bash', tool_input: { command: COMMAND }, cwd: CWD };

    await recordHumanAsked({ hookData, tool: 'Bash', reason: 'r' });

    // The writer rejects a session-less line as `invalid-envelope:session_id`
    // either way; the key must not change that reason into a key rejection.
    expect(Object.prototype.hasOwnProperty.call(onlyEvent(), 'idempotency_key')).toBe(false);
  });

  it('puts the resolve key on the human.resolved envelope', async () => {
    const { buildQuestionId, recordHumanResolved } = await loadRecorder();
    const qid = buildQuestionId(SID, 'HG-07', COMMAND);

    await recordHumanResolved({
      cwd: CWD, sessionId: SID, tool: 'Bash', subject: COMMAND, decision: 'go ahead',
    });

    const event = onlyEvent();
    expect(event.event).toBe('human.resolved');
    expect(event.idempotency_key).toMatch(
      new RegExp(`^human\\.resolved:${SID}:${qid}:[0-9a-f]{12}$`),
    );
    expect(Object.prototype.hasOwnProperty.call(event.data, 'idempotency_key')).toBe(false);
  });

  it('keys the ask and the resolve of one question apart, and a repeated resolve alike', async () => {
    const { recordHumanAsked, recordHumanResolved } = await loadRecorder();
    const resolve = (decision) => recordHumanResolved({
      cwd: CWD, sessionId: SID, tool: 'Bash', subject: COMMAND, decision,
    });

    await recordHumanAsked({ hookData: bashData(COMMAND), tool: 'Bash', reason: 'r' });
    await resolve('go ahead');
    await resolve('go ahead');
    await resolve('do not');

    const events = mocks.append.mock.calls.map((call) => call[1]);
    expect(events.map((e) => e.event))
      .toEqual(['human.asked', 'human.resolved', 'human.resolved', 'human.resolved']);
    const [ask, res1, res2, res3] = events;
    // One question, so the join key is shared...
    expect(new Set(events.map((e) => e.data.question_id)).size).toBe(1);
    // ...but the facts are not.
    expect(res1.idempotency_key).not.toBe(ask.idempotency_key);
    expect(res2.idempotency_key).toBe(res1.idempotency_key);
    expect(res3.idempotency_key).not.toBe(res1.idempotency_key);
  });
});
