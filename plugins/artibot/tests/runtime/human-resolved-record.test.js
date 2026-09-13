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
 *  - THE BYTE CAP, except through the drift pin at the bottom. `decision` is
 *    the only REQUIRED key of this event, so an oversized one has two distinct
 *    bad outcomes and `appendLedgerEvent` is a spy for both of them here:
 *      * slightly over  — `foldOversized` keeps `{decision, evidence_refs}` and
 *        drops everything else INCLUDING `question_id`, so the line lands and
 *        joins nothing;
 *      * far over       — the folded line is still over the cap and the whole
 *        record becomes a `ledger.rejected` line (measured: a 5,000-byte
 *        decision produced `line-too-large:5251` on 2026-09-13).
 *    `HUMAN_RESOLVED_DECISION_MAX_BYTES` closes both, and
 *    `tests/ledger/record-human-resolved.test.js` is where a real ledger file
 *    is read back to prove it.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
/**
 * The REAL writer, imported statically and never stubbed.
 *
 * `vi.doMock` is not hoisted, so this binding is resolved at module-eval time —
 * before any `beforeEach` runs — and keeps pointing at the genuine module no
 * matter what the edge mocks below do. `event-writer.js#writeEvent` rather than
 * `ledger.js#appendLedgerEvent` only to put the point beyond argument: the
 * latter is a one-line passthrough to the former AND is the specifier the mocks
 * replace, so naming it here would invite the question every time.
 */
import { ledgerFilePath, writeEvent } from '../../lib/runtime/event-writer.js';

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
    // `line-too-large` — see the drift pin at the bottom of this file for the
    // measurement, and the header for the two ways an oversized decision goes
    // wrong. 5,000 bytes is the size the reviewer reproduced on 2026-09-13.
    ['the decision is far over the cap', { decision: 'y'.repeat(5000) }],
    ['the decision is one byte over the cap', { decision: 'y'.repeat(3073) }],
  ];

  it.each(SKIPS)('appends nothing when %s', async (_label, over) => {
    const { recordHumanResolved } = await loadRecorder();

    await recordHumanResolved(resolvedArgs(over));

    expect(mocks.append).not.toHaveBeenCalled();
  });

  it('records a decision exactly at the cap', async () => {
    const { recordHumanResolved } = await loadRecorder();

    await recordHumanResolved(resolvedArgs({ decision: 'y'.repeat(3072) }));

    // NEGATIVE CONTROL for the two rows above: the guard must be a BOUNDARY,
    // not a blanket refusal of long decisions. Without this, a check that
    // rejected everything over a few bytes would pass the skip cases.
    expect(onlyEvent().data.decision).toHaveLength(3072);
  });

  it('measures the cap in BYTES, not characters', async () => {
    const { recordHumanResolved } = await loadRecorder();

    // 1,100 Korean characters are 3,300 UTF-8 bytes but only 1,100 `.length`.
    // A `.length` check would wave this through and the writer would then
    // reject or fold the line — the failure this guard exists to prevent.
    await recordHumanResolved(resolvedArgs({ decision: '가'.repeat(1100) }));

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

describe('recordHumanAsked — the key order T-40 must not have moved', () => {
  /**
   * INSERTION ORDER, asserted without `.sort()`.
   *
   * Every other assertion about the asked line in this repository sorts the key
   * list, so all of them would stay green if the T-40 refactor had reordered
   * the `data` object — and a reordered object serializes to different BYTES
   * for a line that is already in the field. The asked suite is required to
   * stay unmodified, so the pin for that refactor belongs here, next to the
   * code that introduced the risk.
   *
   * These two rows cover both conditional keys: `gate` (present only when a row
   * claims the subject) and `path` (present only for Write and Edit).
   */
  const ORDERS = [
    {
      label: 'a Write with both conditional keys',
      tool: 'Write',
      subject: GATED_PATH,
      keys: ['question_id', 'hits', 'reason', 'decision', 'tool', 'gate', 'path'],
    },
    {
      label: 'a Bash call with neither',
      tool: 'Bash',
      subject: UNGATED_COMMAND,
      keys: ['question_id', 'hits', 'reason', 'decision', 'tool'],
    },
  ];

  it.each(ORDERS)('keeps the field order for $label', async ({ tool, subject, keys }) => {
    const { recordHumanAsked } = await loadRecorder();
    const hookData = tool === 'Bash' ? bashData(subject) : writeData(subject, { tool });

    await recordHumanAsked({ hookData, tool, reason: 'blocked' });

    expect(Object.keys(onlyEvent().data)).toEqual(keys);
  });
});

describe('HUMAN_RESOLVED_DECISION_MAX_BYTES', () => {
  /** Temp roots this block made, removed at the end. */
  const roots = [];
  afterAll(() => {
    for (const root of roots) {
      try { rmSync(root, { recursive: true, force: true }); } catch { /* noop */ }
    }
  });

  it('leaves room for the writer overhead under the allowlist cap', async () => {
    const { HUMAN_RESOLVED_DECISION_MAX_BYTES } = await loadRecorder();
    const here = path.dirname(fileURLToPath(import.meta.url));
    const allowlistPath = path.resolve(here, '..', '..', 'schemas', 'ledger-events.allowlist.json');
    const cap = JSON.parse(readFileSync(allowlistPath, 'utf-8')).limits.line_max_bytes;

    // The overhead is MEASURED, never hardcoded: write one real line through
    // the real writer and subtract the decision's own bytes. A hardcoded number
    // would drift the day the envelope gains a field, and the guard would go
    // from "comfortably under the cap" to "over it" with this test still green.
    const root = mkdtempSync(path.join(os.tmpdir(), 'artibot-hres-budget-'));
    roots.push(root);
    const decision = 'd'.repeat(64);
    const result = writeEvent(root, {
      event: 'human.resolved',
      session_id: SID,
      source: 'human',
      // The WIDEST data shape this recorder can emit, minus `path` — the point
      // of the subtraction below is the fixed cost, and `path` is the variable
      // term this guard deliberately does not model.
      data: {
        question_id: buildIdShape(),
        decision,
        tool: 'Write',
        kind: 'approval',
        kind_source: 'self-report',
        gate: 'HG-13',
      },
    });
    expect(result.ok).toBe(true);
    const line = readFileSync(ledgerFilePath(root), 'utf-8').trim();
    const overhead = Buffer.byteLength(line, 'utf-8') - Buffer.byteLength(decision, 'utf-8');

    expect(HUMAN_RESOLVED_DECISION_MAX_BYTES + overhead).toBeLessThanOrEqual(cap);

    // THE HOLE, stated as a number rather than a hope. Whatever is left over is
    // the entire budget for `path`, which is a caller-supplied file path of
    // unbounded length and is NOT checked by the guard. A Write whose path
    // exceeds this still overflows the cap exactly as before.
    const pathBudget = cap - (HUMAN_RESOLVED_DECISION_MAX_BYTES + overhead);
    expect(pathBudget).toBeGreaterThan(0);
    // Measured 2026-09-13 22:4x: overhead 303 bytes, budget 721. Neither is
    // asserted as an equality — the pid and seq digit counts move the overhead
    // by a byte or two between runs, so an equality here would be a flake.
    // The floor must fail when the headroom COLLAPSES, not when a field is
    // renamed.
    expect(pathBudget).toBeGreaterThan(512);
  });
});

/** A question id of the real shape, for byte-accurate measurement. */
function buildIdShape() {
  return `q-${'s'.repeat(8)}-${'0'.repeat(12)}`;
}

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
