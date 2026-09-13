/**
 * Unit contract for `recordHumanResolved` — the `human.asked` recorder's twin,
 * living in the same module (`lib/runtime/human-asked-record.js`) so the two
 * halves of one pair cannot drift apart.
 *
 * WHAT THIS FILE PINS, AND WHY EACH PROPERTY IS LOAD-BEARING
 *  - **The join actually joins.** `question_id` is the only thing that makes an
 *    ask and its resolution one pair, and the two ids are produced by two
 *    different callers (a hook, and the model). So the first describe block
 *    asserts `toBe` between an id the ASKED path built from a hook payload and
 *    an id the RESOLVED path built from loose arguments. An assertion that only
 *    checked the resolved id against `buildQuestionId` would be a restatement of
 *    the implementation and would stay green through a subject-extraction
 *    change that silently unjoins every pair in the field.
 *  - **Zero `ledger.rejected` lines.** Every precondition this recorder checks
 *    (`cwd`, `session_id`, `decision`, `kind`) maps to a rejection the writer
 *    would otherwise emit — a rejected line is a LOST record plus a noise line,
 *    which is strictly worse than not writing. So the skip cases below assert
 *    `not.toHaveBeenCalled()`, not "called with something harmless".
 *  - **The `data` KEY SET, not just its values.** `kind`, `kind_source`, `gate`
 *    and `path` are all conditional keys. `Object.keys(data)` is what makes
 *    their ABSENCE measurable; `objectContaining` would pass while the recorder
 *    wrote `kind: null`, which the allowlist's `enum_ref` rejects outright.
 *
 * ── MOCK BOUNDARY (deliberate, inherited from the asked suite) ──────────────
 *  `lib/runtime/ledger.js` and `lib/git/project-root.js` are mocked — they are
 *  the filesystem edge. `lib/security/human-gates.js` is NOT: it is a pure
 *  classifier, and mocking it would turn every `gate` expectation below into a
 *  restatement of the mock. The gate ids here are real `classify()` outputs.
 *
 * ── WHAT THIS FILE CANNOT SEE ───────────────────────────────────────────────
 *  - Whether the produced line survives the allowlist. `appendLedgerEvent` is a
 *    spy, so a shape that would land as `ledger.rejected` still passes here.
 *    `tests/ledger/record-human-resolved.test.js` reads a REAL ledger file for
 *    exactly that reason, and it is the only evidence that the skips above buy
 *    what they claim.
 *  - Whether any caller invokes this at all. Nothing in the repository calls
 *    `recordHumanResolved` from a hook: it is reached through the CLI, by a
 *    model that chooses to run it. That choice is unmeasured and unenforced.
 *  - Line folding. `foldOversized` drops every non-required `data` key past the
 *    cap, which for this event leaves only `decision`. A long `decision` would
 *    therefore drop `question_id` itself and silently unjoin the pair. Nothing
 *    here approaches that threshold.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const RECORDER = '../../lib/runtime/human-asked-record.js';
const LEDGER = '../../lib/runtime/ledger.js';
const PROJECT_ROOT = '../../lib/git/project-root.js';

const mocks = vi.hoisted(() => ({ append: vi.fn() }));

const SID = 'sess1234abcd';
const CWD = '/project';
const RESOLVED_ROOT = `/resolved-root${CWD}`;

/**
 * A command the human-gate matrix claims, and one it does not. Both spellings
 * are reused verbatim from `tests/runtime/human-asked-record.test.js`, where
 * their hit lists are asserted against the real matrix — so this file inherits
 * that measurement instead of re-deriving it.
 */
const GATED_COMMAND = 'git push --force origin main';
const UNGATED_COMMAND = 'rm -rf /tmp/data';
const GATED_PATH = '/project/artibot.config.json';

/** (Re-)install both filesystem-edge stubs. See the asked suite for the why. */
function installEdgeMocks() {
  vi.doMock(LEDGER, () => ({ appendLedgerEvent: mocks.append }));
  vi.doMock(PROJECT_ROOT, () => ({ resolveProjectRoot: (cwd) => `/resolved-root${cwd}` }));
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  installEdgeMocks();
});

/** Load the recorder fresh, against whatever mocks this test registered. */
async function loadRecorder() {
  return import(RECORDER);
}

/** A Bash PreToolUse payload, as the hook would hand it to the asked path. */
function bashData(command, { cwd = CWD, sessionId = SID } = {}) {
  const data = { tool_name: 'Bash', tool_input: { command }, session_id: sessionId };
  if (cwd !== null) data.cwd = cwd;
  return data;
}

/** A Write/Edit PreToolUse payload. */
function writeData(filePath, { tool = 'Write', cwd = CWD, sessionId = SID } = {}) {
  const data = { tool_name: tool, tool_input: { file_path: filePath }, session_id: sessionId };
  if (cwd !== null) data.cwd = cwd;
  return data;
}

/** Arguments that record something, so each case varies exactly one field. */
function resolvedArgs(over = {}) {
  return {
    cwd: CWD, sessionId: SID, tool: 'Bash', subject: GATED_COMMAND, decision: 'go ahead', ...over,
  };
}

/** The single event handed to `appendLedgerEvent`. */
function onlyEvent() {
  expect(mocks.append).toHaveBeenCalledTimes(1);
  return mocks.append.mock.calls[0][1];
}

/** The nth event handed to `appendLedgerEvent`, for the pairing cases. */
function eventAt(index) {
  return mocks.append.mock.calls[index][1];
}

describe('recordHumanResolved — the question_id join', () => {
  /**
   * Each row runs the ASKED path and the RESOLVED path over the same subject
   * and asserts the two ids are the same bytes. This is the whole point of the
   * feature: `human.asked` is written by a hook out of a payload, and
   * `human.resolved` is written by a model out of flags, so the two subject
   * extractions are the thing most likely to drift.
   */
  const PAIRS = [
    { label: 'a Bash command a gate row claims', tool: 'Bash', subject: GATED_COMMAND },
    { label: 'a Bash command no gate row claims', tool: 'Bash', subject: UNGATED_COMMAND },
    { label: 'a Write path two gate rows claim', tool: 'Write', subject: GATED_PATH },
  ];

  it.each(PAIRS)('pairs asked with resolved for $label', async ({ tool, subject }) => {
    const { recordHumanAsked, recordHumanResolved } = await loadRecorder();
    const hookData = tool === 'Bash' ? bashData(subject) : writeData(subject, { tool });

    await recordHumanAsked({ hookData, tool, reason: 'blocked' });
    await recordHumanResolved(resolvedArgs({ tool, subject }));

    expect(mocks.append).toHaveBeenCalledTimes(2);
    const asked = eventAt(0);
    const resolved = eventAt(1);
    expect(asked.event).toBe('human.asked');
    expect(resolved.event).toBe('human.resolved');
    // Byte identity, not deep equality of two separately computed ids.
    expect(resolved.data.question_id).toBe(asked.data.question_id);
    // NEGATIVE CONTROL: an id both sides computed as the same EMPTY-subject
    // fallback would satisfy the line above while joining nothing. The two
    // subjects below must therefore produce different ids.
    const { buildQuestionId } = await loadRecorder();
    expect(resolved.data.question_id).not.toBe(buildQuestionId(SID, null, ''));
  });

  it('carries the strictest gate onto the resolved line too', async () => {
    const { recordHumanResolved } = await loadRecorder();

    await recordHumanResolved(resolvedArgs({ tool: 'Write', subject: GATED_PATH }));

    // Measured against the real matrix: HG-02 (`default: auto`) and HG-13
    // (`default: human`); the strictest is what `gate` reports.
    expect(onlyEvent().data.gate).toBe('HG-13');
  });

  it('omits `gate` when no row claims the subject', async () => {
    const { recordHumanResolved } = await loadRecorder();

    await recordHumanResolved(resolvedArgs({ subject: UNGATED_COMMAND }));

    const { data } = onlyEvent();
    // A null would be a type violation against a declared string field on the
    // asked side and pointless noise here. Absence is the contract.
    expect(Object.prototype.hasOwnProperty.call(data, 'gate')).toBe(false);
  });

  it('subjects the id on the subject, so two answers are two questions', async () => {
    const { recordHumanResolved } = await loadRecorder();

    await recordHumanResolved(resolvedArgs({ tool: 'Write', subject: '/project/a.env' }));
    await recordHumanResolved(resolvedArgs({ tool: 'Write', subject: '/project/b.env' }));

    expect(eventAt(0).data.question_id).not.toBe(eventAt(1).data.question_id);
  });
});

describe('recordHumanResolved — envelope and data shape', () => {
  it('writes a human-sourced envelope carrying the session id', async () => {
    const { recordHumanResolved } = await loadRecorder();

    await recordHumanResolved(resolvedArgs());

    const event = onlyEvent();
    expect(event.event).toBe('human.resolved');
    // `human` and not `hook`: the asked line is written BY the machinery that
    // blocked; this one is written by the model relaying a person's answer.
    // The allowlist permits both, so nothing but this test says which.
    expect(event.source).toBe('human');
    expect(event.session_id).toBe(SID);
  });

  it('anchors the append on the resolved project root, not the raw cwd', async () => {
    const { recordHumanResolved } = await loadRecorder();

    await recordHumanResolved(resolvedArgs());

    expect(mocks.append.mock.calls[0][0]).toBe(RESOLVED_ROOT);
  });

  it('carries the decision text verbatim', async () => {
    const { recordHumanResolved } = await loadRecorder();
    const decision = 'use the allowlist, not the deny list';

    await recordHumanResolved(resolvedArgs({ decision }));

    expect(onlyEvent().data.decision).toBe(decision);
  });

  it.each(['correction', 'decision', 'approval'])('records kind %s as a self-report', async (kind) => {
    const { recordHumanResolved } = await loadRecorder();

    await recordHumanResolved(resolvedArgs({ kind }));

    const { data } = onlyEvent();
    expect(data.kind).toBe(kind);
    // `kind_source` is the honesty marker: the model is reporting on its own
    // behaviour, and a reader must be able to tell that from a measurement.
    expect(data.kind_source).toBe('self-report');
    expect(Object.keys(data).sort()).toEqual(
      ['decision', 'gate', 'kind', 'kind_source', 'question_id', 'tool'],
    );
  });

  it('omits both kind keys when the kind is unknown', async () => {
    const { recordHumanResolved } = await loadRecorder();

    await recordHumanResolved(resolvedArgs({ kind: undefined }));

    const { data } = onlyEvent();
    // NOT `kind: null`. The allowlist declares `kind` with an `enum_ref`, and
    // `validateDeclaredFields` checks any key that is PRESENT — so a null makes
    // the whole line an `enum-violation:kind` rejection and the record is lost.
    expect(Object.prototype.hasOwnProperty.call(data, 'kind')).toBe(false);
    // And no dangling `kind_source` for a kind that is not there.
    expect(Object.prototype.hasOwnProperty.call(data, 'kind_source')).toBe(false);
    expect(Object.keys(data).sort()).toEqual(['decision', 'gate', 'question_id', 'tool']);
  });

  it('omits both kind keys when the kind is explicitly null', async () => {
    const { recordHumanResolved } = await loadRecorder();

    await recordHumanResolved(resolvedArgs({ kind: null }));

    const { data } = onlyEvent();
    expect(Object.prototype.hasOwnProperty.call(data, 'kind')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(data, 'kind_source')).toBe(false);
  });

  it.each(['Write', 'Edit'])('carries `path` for %s and never a `command` key', async (tool) => {
    const { recordHumanResolved } = await loadRecorder();

    await recordHumanResolved(resolvedArgs({ tool, subject: GATED_PATH, kind: 'approval' }));

    const { data } = onlyEvent();
    expect(data.path).toBe(GATED_PATH);
    expect(Object.keys(data).sort()).toEqual(
      ['decision', 'gate', 'kind', 'kind_source', 'path', 'question_id', 'tool'],
    );
  });

  it('omits `path` for Bash, where the subject is not a file', async () => {
    const { recordHumanResolved } = await loadRecorder();

    await recordHumanResolved(resolvedArgs());

    const { data } = onlyEvent();
    // Symmetric with the asked line, which also refuses to copy a Bash command
    // into a second field. The subject reaches the ledger only as a hash.
    expect(Object.prototype.hasOwnProperty.call(data, 'path')).toBe(false);
    expect(JSON.stringify(data)).not.toContain(GATED_COMMAND);
  });
});

describe('recordHumanResolved — what it refuses to write', () => {
  /**
   * Each row is a precondition whose absence the LEDGER WRITER would turn into
   * a `ledger.rejected` line. Skipping is not timidity: a rejected line loses
   * the record AND writes a noise line, so the recorder checks first.
   */
  const SKIPS = [
    // No injected root — the header's "WHY THE PROJECT ROOT IS NOT DERIVED".
    ['cwd is absent', { cwd: undefined }],
    ['cwd is an empty string', { cwd: '' }],
    ['cwd is not a string', { cwd: 42 }],
    // `invalid-envelope:session_id` — event-writer.js#validateEnvelope requires
    // a NON-EMPTY string, measured 2026-09-13. `buildQuestionId` tolerates a
    // missing session (`nosess`), which is exactly why this has to be checked
    // here: the id would be well-formed and the LINE would still be rejected.
    ['the session id is absent', { sessionId: undefined }],
    ['the session id is an empty string', { sessionId: '' }],
    // `missing-required-data:decision` — the allowlist's only required key.
    ['the decision is absent', { decision: undefined }],
    ['the decision is an empty string', { decision: '' }],
    ['the decision is not a string', { decision: { text: 'yes' } }],
    // `enum-violation:kind` — declared with an `enum_ref`, checked when present.
    ['the kind is outside the enum', { kind: 'guess' }],
    ['the kind is an empty string', { kind: '' }],
    ['the kind is a number', { kind: 3 }],
    // Case is NOT folded for this enum: `ENUM_CASE_FOLD` in
    // lib/runtime/ledger-schema.js carries `verify_result` only, so an
    // uppercase spelling reaches the validator unchanged and is rejected.
    ['the kind is uppercase', { kind: 'APPROVAL' }],
  ];

  it.each(SKIPS)('appends nothing when %s', async (_label, over) => {
    const { recordHumanResolved } = await loadRecorder();

    await recordHumanResolved(resolvedArgs(over));

    expect(mocks.append).not.toHaveBeenCalled();
  });

  it('still records when the subject is empty — an unclassified ask is an ask', async () => {
    const { buildQuestionId, recordHumanResolved } = await loadRecorder();

    await recordHumanResolved(resolvedArgs({ subject: '' }));

    // NEGATIVE CONTROL for the block above: the skips must be about the four
    // preconditions and nothing else. An empty subject is a legal (if
    // uninformative) question, exactly as it is on the asked side.
    expect(onlyEvent().data.question_id).toBe(buildQuestionId(SID, null, ''));
  });
});

describe('recordHumanResolved — never throws', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a number', 42],
    ['a string', 'str'],
  ])('resolves when the argument is %s', async (_label, arg) => {
    const { recordHumanResolved } = await loadRecorder();

    await expect(recordHumanResolved(arg)).resolves.toBeUndefined();

    // NEGATIVE CONTROL: a non-object argument carries no `cwd`, so resolving is
    // only half the contract — it must also have written nothing.
    expect(mocks.append).not.toHaveBeenCalled();
  });

  it('resolves when called with no argument at all', async () => {
    const { recordHumanResolved } = await loadRecorder();

    await expect(recordHumanResolved()).resolves.toBeUndefined();
    expect(mocks.append).not.toHaveBeenCalled();
  });

  it('resolves when the ledger module cannot be loaded', async () => {
    vi.doMock(LEDGER, () => { throw new Error('ledger module is broken'); });
    const { recordHumanResolved } = await loadRecorder();

    await expect(recordHumanResolved(resolvedArgs())).resolves.toBeUndefined();
  });

  it('resolves when appendLedgerEvent itself throws', async () => {
    mocks.append.mockImplementationOnce(() => { throw new Error('disk is gone'); });
    const { recordHumanResolved } = await loadRecorder();

    await expect(recordHumanResolved(resolvedArgs())).resolves.toBeUndefined();

    // NEGATIVE CONTROL: the throw has to have come from the real call path.
    expect(mocks.append).toHaveBeenCalledTimes(1);
  });

  it('resolves when the project root cannot be resolved', async () => {
    vi.doMock(PROJECT_ROOT, () => ({
      resolveProjectRoot: () => { throw new Error('no root'); },
    }));
    const { recordHumanResolved } = await loadRecorder();

    await expect(recordHumanResolved(resolvedArgs())).resolves.toBeUndefined();
    expect(mocks.append).not.toHaveBeenCalled();
  });
});

describe('describeHumanQuestion', () => {
  it('reports the same id, gate and hits the recorder writes', async () => {
    const { describeHumanQuestion, recordHumanResolved } = await loadRecorder();

    const described = await describeHumanQuestion(
      { sessionId: SID, tool: 'Write', subject: GATED_PATH },
    );
    await recordHumanResolved(resolvedArgs({ tool: 'Write', subject: GATED_PATH }));

    // The CLI prints from `describeHumanQuestion` and records through
    // `recordHumanResolved`. If those were two derivations, the id a model
    // reads on stdout could differ from the one in the ledger — the single
    // failure that would make the whole join untrustworthy AND invisible.
    const { data } = onlyEvent();
    expect(described.question_id).toBe(data.question_id);
    expect(described.gate).toBe('HG-13');
    expect(described.hits).toEqual(['HG-02', 'HG-13']);
    expect(described.subject).toBe(GATED_PATH);
  });

  it('reports a null gate and no hits for an unclassified subject', async () => {
    const { describeHumanQuestion } = await loadRecorder();

    const described = await describeHumanQuestion(
      { sessionId: SID, tool: 'Bash', subject: UNGATED_COMMAND },
    );

    expect(described.gate).toBeNull();
    expect(described.hits).toEqual([]);
  });

  it('treats an unrecognised tool as an empty subject, on both paths alike', async () => {
    const { buildQuestionId, describeHumanQuestion } = await loadRecorder();

    const described = await describeHumanQuestion(
      { sessionId: SID, tool: 'WebFetch', subject: 'https://example.invalid' },
    );

    // The gate matrix is an ALLOWLIST, so a tool with no row is UNCLASSIFIED,
    // not safe. The asked path collapses such a subject to '' and this must do
    // the same or the pair would not join.
    expect(described.subject).toBe('');
    expect(described.question_id).toBe(buildQuestionId(SID, null, ''));
  });
});

describe('HUMAN_RESOLVED_KINDS', () => {
  it('matches the allowlist enum it exists to enforce', async () => {
    const { HUMAN_RESOLVED_KINDS } = await loadRecorder();
    const here = path.dirname(fileURLToPath(import.meta.url));
    const allowlistPath = path.resolve(here, '..', '..', 'schemas', 'ledger-events.allowlist.json');
    const allowlist = JSON.parse(readFileSync(allowlistPath, 'utf-8'));

    // DRIFT PIN. The constant is a COPY of the schema's vocabulary, kept in
    // code so the recorder does not have to read and parse a JSON file on a
    // path that must never throw. A copy without a comparison is how the two
    // silently diverge: widen the schema and this recorder would start dropping
    // a legal kind, narrow it and it would start emitting rejected lines.
    expect(HUMAN_RESOLVED_KINDS).toEqual(allowlist.enums.human_resolved_kind);
    expect(allowlist.events['human.resolved'].fields.kind.enum_ref).toBe('human_resolved_kind');
    // The other two preconditions this module enforces come from the same file.
    expect(allowlist.events['human.resolved'].required).toEqual(['decision']);
    expect(allowlist.events['human.resolved'].sources).toContain('human');
  });
});
