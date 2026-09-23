/**
 * `lib/review/verdict-writer` — the `review.completed` /
 * `review.claim_audit` LEDGER WRITERS.
 *
 * The parsers, which live in `lib/review/independent-reviewer.js` and are
 * covered by `tests/review/independent-reviewer.test.js` and
 * `tests/review/claim-audit.test.js`, decide whether a reviewer's answer is
 * admissible; the functions under test here turn an admissible answer into the
 * INPUT of a ledger line. They still perform
 * no I/O: the append and the already-written-keys lookup arrive as ports, which
 * is what lets this suite drive the REAL writer without the module importing L5.
 *
 * ── The five properties this suite is here to hold ─────────────────────────
 *  1. A BUILT INPUT IS ACCEPTED BY THE REAL WRITER. Every happy-path case runs
 *     through `lib/runtime/ledger.js#appendLedgerEvent` into a `mkdtemp`
 *     project root and then COUNTS `ledger.rejected` lines in the raw file. A
 *     rejected line is written to the same file and `ok:false` is returned, so
 *     asserting `ok:true` alone would not see a line the contract refused —
 *     and asserting only the line count would count the rejection as the line.
 *  2. AN INADMISSIBLE ANSWER PRODUCES NO LINE AT ALL. Legacy vocabulary,
 *     ambiguous tokens, a missing envelope `model`, `claims_refuted >
 *     claims_total` — each yields zero bytes in the ledger. Design §3.4: a
 *     schema violation is never read as a pass, and "no usable answer" must not
 *     become a `PASS` row in the measurement store.
 *  3. AN ABSENT OPTIONAL FIELD OMITS ITS KEY. `subject_model` and `nature` are
 *     absent, not null and not `'unknown'`. The allowlist declares both as
 *     `type: string` / `enum_ref`, and `lib/runtime/ledger-schema.js
 *     #matchesType` rejects null — so a key present with a placeholder value is
 *     either a rejected line or, worse, a value that later aggregates as if it
 *     were a model.
 *  4. RE-RUNNING WRITES NOTHING TWICE. The idempotency key is derived from the
 *     answer's identity, and a second `recordReviewOutcome` over the same text
 *     dedupes rather than appending. Mirrors `scripts/hooks/session-end.js
 *     #existingReceiptKeys`.
 *  5. A PORT THAT THROWS DOES NOT ESCAPE. `recordReviewOutcome` is called from
 *     hook-shaped contexts; its own bookkeeping may not take the caller down.
 *
 * ── What this suite does NOT prove ─────────────────────────────────────────
 *  - That a real reviewer agent emits either block. A production caller DOES
 *    exist now — `scripts/hooks/_review-stop-record.js:573` calls
 *    `recordReviewOutcome` on SubagentStop (read 2026-09-22) — so the old
 *    "no production caller yet" line here was stale. Green still says the
 *    writer accepts what this module builds, not that an agent builds it.
 *  - That `claims_total` was counted by the rule of 설계 §4.4 #2. A well-formed
 *    block with an invented denominator is green, exactly as in
 *    `tests/review/claim-audit.test.js`.
 *  - Anything about concurrency. One process, sequential appends.
 *  - That the temp-root path resolution matches a real project's: every write
 *    here passes an explicit `ledgerPath`, which bypasses the git-common-dir
 *    rule in `event-writer.js#ledgerFilePath` on purpose.
 *  - THAT A LINE SURVIVES THE 4096-BYTE CAP WITH ITS OPTIONAL KEYS. This is the
 *    gap most likely to turn a green suite into a wrong measurement, because the
 *    loss is silent and the blocks here are small. `event-writer.js
 *    #DEFAULT_LINE_MAX_BYTES` is 4096 (read 2026-09-12, `event-writer.js:125`),
 *    and an oversized line goes through `foldOversized` (`:658`), which keeps
 *    only `requiredDataKeys(spec)` plus `evidence_refs`. For
 *    `review.claim_audit` the allowlist requires exactly `subject_agent_type`,
 *    `claims_total`, `claims_refuted` (`schemas/ledger-events.allowlist.json`
 *    `:342-346`, no `data_schema`, so the fold does apply) — therefore `nature`,
 *    `subject_model` and `subject_agent_id` are the FIRST things dropped. A real
 *    audit with long `evidence_refs` keeps its two counts and loses precisely
 *    the three fields §4.1 stratifies by, so the row survives as a line and
 *    still falls out of the stratified denominator. No test is added here: the
 *    cap and the fold are the ledger writer's behaviour, not this module's, and
 *    the allowlist is read-only to us. A test belongs beside `foldOversized`.
 *    The audit fold is no longer SILENT, though: `recordReviewOutcome` reports
 *    a folded append as `appended` with `reason: 'ledger-folded'`.
 *    `review.completed` is different — its builder now refuses any line that
 *    would reach the fold, and the "never loses a key to the ledger fold"
 *    block below pins that.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { appendLedgerEvent, readAllEvents } from '../../lib/runtime/ledger.js';
import {
  buildEnvelope,
  DEFAULT_LINE_MAX_BYTES,
  foldOversized,
  getAllowlist,
  getLedgerSettings,
  lineBytes,
  resetSeq,
} from '../../lib/runtime/event-writer.js';
import { parseClaimAudit, parseReviewVerdict } from '../../lib/review/independent-reviewer.js';
import {
  buildClaimAuditEvent,
  buildReviewCompletedEvent,
  claimAuditIdempotencyKey,
  ENVELOPE_RESERVE_BYTES,
  LEDGER_LINE_MAX_BYTES,
  recordReviewOutcome,
  REVIEW_CLAIM_AUDIT_EVENT,
  REVIEW_COMPLETED_EVENT,
  REVIEW_LEDGER_SOURCE,
  reviewCompletedIdempotencyKey,
  VERIFICATION_ID_MAX_LENGTH,
} from '../../lib/review/verdict-writer.js';

const LEDGER_REL = 'ledger.jsonl';
const SID = 'sess-review-writer';
const MISSION = 'M-20260912-001';
const MODEL = 'claude-fable-5-1';
const FINDINGS_REF = '.artibot/missions/M-20260912-001/review.md';
const REVIEWER = 'agent-reviewer-7';

let root;

/**
 * @param {object} [over] field overrides; `undefined` deletes the key
 * @returns {object} a valid reviewOutputV2 document
 */
function v2Doc(over = {}) {
  const base = {
    schema_version: 2,
    verdict: 'PASS',
    findings: [],
    evidence: [{ kind: 'file', file: 'lib/review/independent-reviewer.js', line: 1 }],
    recommended_action: 'proceed',
    mission_id: MISSION,
    intent_revision: 3,
    plan_revision: 1,
    diff_ref: 'HEAD~1..HEAD',
    test_evidence: [{ kind: 'command', command: 'npx vitest run tests/review', output: 'ok' }],
    regression_evidence: [{ kind: 'command', command: 'npx vitest run tests/review', output: 'ok' }],
    verification_id: 'v1-abc',
    next_steps: [],
    ...over,
  };
  for (const [k, v] of Object.entries(over)) if (v === undefined) delete base[k];
  return base;
}

/**
 * @param {object} [over] field overrides; `undefined` deletes the key
 * @returns {object} a valid `claim_audit` block payload
 */
function auditBlock(over = {}) {
  const base = {
    subject_agent_type: 'code-reviewer',
    nature: 'judge',
    claims_total: 12,
    claims_refuted: 3,
    evidence_refs: ['lib/review/independent-reviewer.js:699'],
    ...over,
  };
  for (const [k, v] of Object.entries(over)) if (v === undefined) delete base[k];
  return base;
}

/**
 * One reviewer answer carrying the verdict document and the audit block as two
 * fenced JSON blocks, verdict first — the order a Phase 4.5 answer uses.
 *
 * @param {object} [parts] `{verdict, audit}` overrides; `audit:null` omits the
 *   audit block, `verdict:null` omits the verdict document
 * @returns {string} markdown
 */
function answer({ verdict = {}, audit = {} } = {}) {
  const blocks = ['검수 결과를 아래에 첨부한다.', ''];
  if (verdict !== null) {
    blocks.push('```json', JSON.stringify(v2Doc(verdict), null, 2), '```', '');
  }
  if (audit !== null) {
    blocks.push('```json', JSON.stringify({ claim_audit: auditBlock(audit) }, null, 2), '```', '');
  }
  return blocks.join('\n');
}

/** @returns {string} absolute path of the temp ledger */
function ledgerFile() {
  return path.join(root, LEDGER_REL);
}

/** @returns {object[]} every parsed line of the raw file, rejections INCLUDED */
function rawLines() {
  const file = ledgerFile();
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf-8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

/** @returns {object[]} only the writer's own refusal lines */
function rejectedLines() {
  return rawLines().filter((l) => l.event === 'ledger.rejected');
}

/**
 * Append one built input through the real writer.
 *
 * @param {object} input a `build*Event` result's `input`
 * @returns {object} the writer's result
 */
function append(input) {
  return appendLedgerEvent(root, input, { ledgerPath: LEDGER_REL });
}

/**
 * Ports wired to the real ledger: the append precedent plus the
 * already-written-keys lookup of `session-end.js#existingReceiptKeys`.
 *
 * @returns {{append: Function, existingKeys: Function, appended: object[]}}
 */
function livePorts() {
  const appended = [];
  return {
    appended,
    append: (input) => {
      appended.push(input);
      return append(input);
    },
    existingKeys: () => readAllEvents(root, { session_id: SID, ledgerPath: LEDGER_REL })
      .map((e) => e.idempotency_key)
      .filter((k) => typeof k === 'string' && k.length > 0),
  };
}

/**
 * The arguments `recordReviewOutcome` takes for the happy path.
 *
 * @param {object} [over] overrides
 * @returns {object} args
 */
function recordArgs(over = {}) {
  return {
    verdictText: answer(),
    sessionId: SID,
    missionId: MISSION,
    model: MODEL,
    findingsRef: FINDINGS_REF,
    reviewerId: REVIEWER,
    ...over,
  };
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'artibot-review-writer-'));
  resetSeq();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('the event vocabulary this module writes', () => {
  it('names the two events and the one permitted source', () => {
    expect(REVIEW_COMPLETED_EVENT).toBe('review.completed');
    expect(REVIEW_CLAIM_AUDIT_EVENT).toBe('review.claim_audit');
    expect(REVIEW_LEDGER_SOURCE).toBe('reviewer');
  });
});

describe('parseReviewVerdict exposes verification_id', () => {
  it('carries the v2 document value on ok:true', () => {
    expect(parseReviewVerdict(v2Doc()).verificationId).toBe('v1-abc');
    expect(parseReviewVerdict(v2Doc({ verification_id: 'v1-zzz' })).verificationId).toBe('v1-zzz');
  });

  it('is null for every answer that is not an admissible v2 document', () => {
    expect(parseReviewVerdict('APPROVE').verificationId).toBeNull();
    expect(parseReviewVerdict(v2Doc({ verification_id: undefined })).verificationId).toBeNull();
    expect(parseReviewVerdict(null).verificationId).toBeNull();
  });

  it('keeps every pre-existing key of the result', () => {
    const r = parseReviewVerdict(v2Doc());
    for (const key of ['ok', 'verdict', 'errors', 'schemaVersion', 'foldedVerdict', 'sources']) {
      expect(Object.prototype.hasOwnProperty.call(r, key), key).toBe(true);
    }
  });

  it('exposes exactly these 9 keys and no others on an admissible document', () => {
    // Exactness, not presence: the test above cannot see a key being ADDED, and
    // a new field on the parse result is a decision this writer has to make
    // (hash it into an idempotency key, put it in `data`, or ignore it). Failing
    // here is the intended way for that decision to become visible. `ambiguous`
    // and `candidates` are deliberately out of scope — they appear only on the
    // ambiguous path, which never reaches a builder.
    // Deliberately raised from 7 to 9 on 2026-09-22: `intentRevision` and
    // `planRevision` were added to the parse result, and the decision this pin
    // forces has been made — both go into `data`, see the key list below.
    expect(Object.keys(parseReviewVerdict(v2Doc())).sort()).toEqual([
      'errors',
      'foldedVerdict',
      'intentRevision',
      'ok',
      'planRevision',
      'schemaVersion',
      'sources',
      'verdict',
      'verificationId',
    ]);
  });
});

describe('buildReviewCompletedEvent — the real writer accepts the input', () => {
  it('writes exactly one review.completed line and zero rejections', () => {
    const built = buildReviewCompletedEvent({
      parsed: parseReviewVerdict(v2Doc()),
      sessionId: SID,
      missionId: MISSION,
      model: MODEL,
      findingsRef: FINDINGS_REF,
      reviewerId: REVIEWER,
    });
    expect(built.ok).toBe(true);

    const res = append(built.input);
    expect(res.ok).toBe(true);

    const lines = rawLines();
    expect(lines).toHaveLength(1);
    expect(rejectedLines()).toHaveLength(0);

    const [line] = lines;
    expect(line.event).toBe('review.completed');
    expect(line.source).toBe('reviewer');
    expect(line.model).toBe(MODEL);
    expect(line.mission_id).toBe(MISSION);
    expect(line.session_id).toBe(SID);
    expect(line.worker).toBe(REVIEWER);
    expect(line.idempotency_key).toBe('review.completed:sess-review-writer:v1-abc');
    expect(line.data.verdict).toBe('PASS');
    expect(line.data.findings_ref).toBe(FINDINGS_REF);
    expect(line.data.verification_id).toBe('v1-abc');
  });

  it('accepts all five canonical verdicts', () => {
    for (const verdict of ['PASS', 'REPAIR_REQUIRED', 'REPLAN_REQUIRED',
      'INTENT_REVIEW_REQUIRED', 'BLOCK']) {
      const built = buildReviewCompletedEvent({
        parsed: parseReviewVerdict(v2Doc({ verdict })),
        sessionId: SID,
        model: MODEL,
        findingsRef: FINDINGS_REF,
      });
      expect(built.ok, verdict).toBe(true);
      expect(append(built.input).ok, verdict).toBe(true);
    }
    expect(rawLines()).toHaveLength(5);
    expect(rejectedLines()).toHaveLength(0);
  });

  it('keeps envelope-only keys out of data', () => {
    const built = buildReviewCompletedEvent({
      parsed: parseReviewVerdict(v2Doc()),
      sessionId: SID,
      missionId: MISSION,
      model: MODEL,
      findingsRef: FINDINGS_REF,
      reviewerId: REVIEWER,
    });
    for (const key of ['session_id', 'mission_id', 'model', 'worker', 'source',
      'idempotency_key', 'event']) {
      expect(Object.prototype.hasOwnProperty.call(built.input.data, key), key).toBe(false);
    }
    // Deliberately widened from 3 keys to 5 on 2026-09-22. `intent_revision`
    // and `plan_revision` are UNDECLARED for this event in the allowlist and
    // ride through untouched, which the firewall suite already pins; they are
    // recorded, not required, and the fold test below states what that costs.
    expect(Object.keys(built.input.data).sort())
      .toEqual(['findings_ref', 'intent_revision', 'plan_revision', 'verdict',
        'verification_id']);
  });

  it('records both revisions in the written line without moving the key', () => {
    const built = buildReviewCompletedEvent({
      parsed: parseReviewVerdict(v2Doc()),
      sessionId: SID,
      model: MODEL,
      findingsRef: FINDINGS_REF,
    });
    expect(append(built.input).ok).toBe(true);
    expect(rejectedLines()).toHaveLength(0);
    const [line] = rawLines();
    expect(line.data.intent_revision).toBe(3);
    expect(line.data.plan_revision).toBe(1);
    // The idempotency key is derived from the verification id alone. Adding
    // data keys must not move it, or one answer would write two rows.
    expect(line.idempotency_key).toBe('review.completed:sess-review-writer:v1-abc');
  });

  it('writes revision 0 as 0 rather than dropping it', () => {
    const built = buildReviewCompletedEvent({
      parsed: parseReviewVerdict(v2Doc({ intent_revision: 0, plan_revision: 0 })),
      sessionId: SID,
      model: MODEL,
      findingsRef: FINDINGS_REF,
    });
    expect(built.input.data.intent_revision).toBe(0);
    expect(built.input.data.plan_revision).toBe(0);
    expect(append(built.input).ok).toBe(true);
  });

  it('omits both keys, and never writes null, when the parse carries neither', () => {
    // A hand-made parse result, not one this parser can produce: the v2 gate
    // requires both fields. It is here because the builder must not be the
    // place a null enters the ledger if that ever changes.
    const built = buildReviewCompletedEvent({
      parsed: { ok: true, verdict: 'PASS', verificationId: 'v1-abc' },
      sessionId: SID,
      model: MODEL,
      findingsRef: FINDINGS_REF,
    });
    expect(built.ok).toBe(true);
    expect(Object.keys(built.input.data).sort())
      .toEqual(['findings_ref', 'verdict', 'verification_id']);
    expect(append(built.input).ok).toBe(true);
    expect(rejectedLines()).toHaveLength(0);
  });


  it('accepts that an oversized line loses both revisions', () => {
    // `foldOversized` keeps only the required data keys plus `evidence_refs`.
    // `review.completed` requires `verdict` and `findings_ref`, so the two
    // revisions and the verification id are the first keys dropped.
    // This suite allows it: the bundle records the numbers, it does not
    // promise their survival.
    const built = buildReviewCompletedEvent({
      parsed: parseReviewVerdict(v2Doc()),
      sessionId: SID,
      model: MODEL,
      findingsRef: FINDINGS_REF,
    });
    const fold = foldOversized(built.input, getAllowlist().events[REVIEW_COMPLETED_EVENT]);
    expect(fold.dropped).toContain('intent_revision');
    expect(fold.dropped).toContain('plan_revision');
    expect(Object.keys(fold.env.data).sort())
      .toEqual(['evidence_refs', 'findings_ref', 'verdict']);
    // In THIS fixture the fold does not rescue the line: with a 6-char
    // verification id the marker costs more bytes than the three dropped keys
    // save (439 B folded against roughly 420-430 B unfolded, the spread being
    // pid/seq digits), so under a 400 B cap the row is rejected outright.
    // A caller-lowered cap is not this builder's to guard: the refusal is the
    // writer's own, and it is counted as a `ledger.rejected` line. The OTHER
    // loss mode — a row that survives the fold without its revisions — is
    // what the "never loses a key to the ledger fold" block below closes.
    const res = appendLedgerEvent(root, built.input, {
      ledgerPath: LEDGER_REL,
      maxLineBytes: 400,
    });
    expect(res.ok).toBe(false);
    expect(res.reason.startsWith('line-too-large:')).toBe(true);
    expect(rejectedLines()).toHaveLength(1);
  });

  it('omits mission_id when it does not match the ledger pattern', () => {
    const built = buildReviewCompletedEvent({
      parsed: parseReviewVerdict(v2Doc()),
      sessionId: SID,
      missionId: 'not-a-mission-id',
      model: MODEL,
      findingsRef: FINDINGS_REF,
    });
    expect(built.ok).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(built.input, 'mission_id')).toBe(false);
    expect(append(built.input).ok).toBe(true);
    expect(rejectedLines()).toHaveLength(0);
  });

  it('omits worker when no reviewer id was given', () => {
    const built = buildReviewCompletedEvent({
      parsed: parseReviewVerdict(v2Doc()),
      sessionId: SID,
      model: MODEL,
      findingsRef: FINDINGS_REF,
    });
    expect(Object.prototype.hasOwnProperty.call(built.input, 'worker')).toBe(false);
  });

  it.each([
    ['legacy APPROVE text', { parsed: parseReviewVerdict('APPROVE') }],
    ['ambiguous SPEC_FAIL text', { parsed: parseReviewVerdict('SPEC_FAIL') }],
    ['a v2 document missing a required field',
      { parsed: parseReviewVerdict(v2Doc({ verdict: undefined })) }],
  ])('refuses to build from %s', (_label, over) => {
    const built = buildReviewCompletedEvent({
      sessionId: SID,
      model: MODEL,
      findingsRef: FINDINGS_REF,
      ...over,
    });
    expect(built.ok).toBe(false);
    expect(typeof built.reason).toBe('string');
    expect(built.input).toBeUndefined();
  });

  it('records the folded legacy verdict nowhere — APPROVE leaves no line', () => {
    const parsed = parseReviewVerdict('APPROVE');
    expect(parsed.foldedVerdict).toBe('PASS');
    expect(buildReviewCompletedEvent({
      parsed, sessionId: SID, model: MODEL, findingsRef: FINDINGS_REF,
    }).ok).toBe(false);
    expect(rawLines()).toHaveLength(0);
  });

  it.each([
    ['model', { model: undefined }],
    ['model (blank)', { model: '' }],
    ['sessionId', { sessionId: undefined }],
    ['sessionId (blank)', { sessionId: '' }],
    ['findingsRef', { findingsRef: undefined }],
    ['findingsRef (blank)', { findingsRef: '' }],
  ])('refuses to build when %s is missing', (_label, over) => {
    const built = buildReviewCompletedEvent({
      parsed: parseReviewVerdict(v2Doc()),
      sessionId: SID,
      model: MODEL,
      findingsRef: FINDINGS_REF,
      ...over,
    });
    expect(built.ok).toBe(false);
  });
});

describe('review.completed never loses a key to the ledger fold', () => {
  // Before the bound, ids of about 1,846..3,663 chars put the unfolded line
  // over the 4096 B cap and the folded one under it, so the row LANDED without
  // intent_revision, plan_revision and verification_id and the writer said
  // `ok:true` (Wave 18 scratch probe). The id is written twice — in `data` and
  // inside `idempotency_key` — and the fold drops only the first, which is why
  // a long id is the input that makes the fold "succeed".

  /**
   * One answer whose verdict carries a verification id of `length` chars and
   * no audit block, so the review half is the only line in play.
   *
   * @param {number} length id length
   * @returns {{id: string, text: string}} the id and the answer
   */
  function answerWithIdOf(length) {
    const id = 'a'.repeat(length);
    return { id, text: answer({ verdict: { verification_id: id }, audit: null }) };
  }

  it('bounds verification_id at 256 characters', () => {
    expect(VERIFICATION_ID_MAX_LENGTH).toBe(256);
  });

  it('mirrors the ledger line cap it budgets against', () => {
    // L2 may not import the runtime writer, so the cap is a copy. A copy is a
    // thing that drifts; this pin makes the drift RED instead of a fold.
    expect(LEDGER_LINE_MAX_BYTES).toBe(DEFAULT_LINE_MAX_BYTES);
    expect(LEDGER_LINE_MAX_BYTES).toBe(getLedgerSettings().maxLineBytes);
    expect(LEDGER_LINE_MAX_BYTES).toBe(getAllowlist().limits.line_max_bytes);
  });

  it.each([1, 256, 257, 1845, 1846, 2500, 3663, 3664, 5000])(
    'L=%i: the row keeps every key, or no row is built and the refusal is reported',
    (length) => {
      const { id, text } = answerWithIdOf(length);
      const results = [];
      const out = recordReviewOutcome(recordArgs({ verdictText: text }), {
        append: (input) => {
          const res = append(input);
          results.push(res);
          return res;
        },
        existingKeys: () => [],
      });
      const rows = rawLines().filter((l) => l.event === REVIEW_COMPLETED_EVENT);

      if (length <= VERIFICATION_ID_MAX_LENGTH) {
        expect(out.review).toEqual({
          status: 'appended', key: `review.completed:${SID}:${id}`,
        });
        expect(results.map((r) => r.folded)).toEqual([false]);
        expect(rows).toHaveLength(1);
        expect(rows[0].data.intent_revision).toBe(3);
        expect(rows[0].data.plan_revision).toBe(1);
        expect(rows[0].data.verification_id).toBe(id);
        expect(rows[0].data.evidence_refs).toBeUndefined();
      } else {
        // `skipped` + reason is what `_review-stop-record.js#reviewLedgerColumn`
        // writes into the spawn record's `review_ledger` column — the channel
        // every other refusal of this builder is counted through.
        expect(out.review).toEqual({ status: 'skipped', reason: 'oversize:verification_id' });
        expect(results).toHaveLength(0);
        expect(rows).toHaveLength(0);
      }
      expect(rejectedLines()).toHaveLength(0);
    },
  );

  it('refuses at the builder, before any port is touched', () => {
    const built = buildReviewCompletedEvent({
      parsed: parseReviewVerdict(v2Doc({ verification_id: 'a'.repeat(257) })),
      sessionId: SID,
      model: MODEL,
      findingsRef: FINDINGS_REF,
    });
    expect(built).toEqual({ ok: false, reason: 'oversize:verification_id' });
  });

  /**
   * Build with a `findingsRef` padded so the serialized input is `bytes` long.
   * The id is short, so only the line budget can be what refuses.
   *
   * @param {number} bytes target `JSON.stringify(input)` byte length
   * @returns {object} the builder result
   */
  function buildInputOf(bytes) {
    const args = {
      parsed: parseReviewVerdict(v2Doc({ verification_id: 'v1-abc' })),
      sessionId: SID,
      model: MODEL,
      reviewerId: REVIEWER,
    };
    const probe = buildReviewCompletedEvent({ ...args, findingsRef: 'f' });
    const pad = bytes - Buffer.byteLength(JSON.stringify(probe.input), 'utf8');
    return buildReviewCompletedEvent({ ...args, findingsRef: 'f'.repeat(1 + pad) });
  }

  it('lands the largest input the budget admits, unfolded, under the worst envelope', () => {
    // Worst case of what the writer adds around the input: no mission_id (so
    // the session fallback is added), a 10-digit pid and a 16-digit seq. If
    // ENVELOPE_RESERVE_BYTES were too small, this row would fold.
    const budget = LEDGER_LINE_MAX_BYTES - ENVELOPE_RESERVE_BYTES;
    const built = buildInputOf(budget);
    expect(built.ok).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(built.input), 'utf8')).toBe(budget);
    const res = appendLedgerEvent(root, built.input, {
      ledgerPath: LEDGER_REL, pid: 4294967295, seq: Number.MAX_SAFE_INTEGER,
    });
    expect(res.ok).toBe(true);
    expect(res.folded).toBe(false);
    const [row] = rawLines();
    expect(row.data.intent_revision).toBe(3);
    expect(row.data.plan_revision).toBe(1);
    expect(row.data.verification_id).toBe('v1-abc');
  });

  it('refuses one byte over the budget as oversize:line, whatever field made it long', () => {
    const budget = LEDGER_LINE_MAX_BYTES - ENVELOPE_RESERVE_BYTES;
    expect(buildInputOf(budget + 1)).toEqual({ ok: false, reason: 'oversize:line' });
    const out = recordReviewOutcome(recordArgs({
      verdictText: answer({ audit: null }),
      findingsRef: 'f'.repeat(LEDGER_LINE_MAX_BYTES),
    }), livePorts());
    expect(out.review).toEqual({ status: 'skipped', reason: 'oversize:line' });
    expect(rawLines()).toHaveLength(0);
  });

  it('reports ledger-folded when the writer folds anyway under a lowered cap', () => {
    // The residual this builder cannot see: an operator-lowered cap, or a
    // redaction that lengthens a string. The row still lands, so the outcome
    // must SAY it was folded rather than read as a clean append.
    const built = buildReviewCompletedEvent({
      parsed: parseReviewVerdict(v2Doc({ verification_id: 'a'.repeat(256) })),
      sessionId: SID,
      model: MODEL,
      findingsRef: FINDINGS_REF,
    });
    const opts = { pid: 1234, seq: 1, now: () => new Date('2026-09-23T00:00:00.000Z') };
    const env = buildEnvelope(built.input, opts);
    const unfolded = lineBytes(env);
    const folded = lineBytes(foldOversized(env, getAllowlist().events[REVIEW_COMPLETED_EVENT]).env);
    expect(folded).toBeLessThan(unfolded);
    const cap = Math.floor((unfolded + folded) / 2);

    const out = recordReviewOutcome(recordArgs({
      verdictText: answer({ verdict: { verification_id: 'a'.repeat(256) }, audit: null }),
      missionId: undefined,
      reviewerId: undefined,
    }), {
      append: (input) => appendLedgerEvent(root, input, {
        ...opts, ledgerPath: LEDGER_REL, maxLineBytes: cap,
      }),
      existingKeys: () => [],
    });
    expect(out.review.status).toBe('appended');
    expect(out.review.reason).toBe('ledger-folded');
    const [row] = rawLines();
    expect(row.data.evidence_refs[0].startsWith('ledger-fold:dropped=')).toBe(true);
  });
});

describe('buildClaimAuditEvent — optional keys are ABSENT, never null', () => {
  it('writes one line whose subject_model key does not exist', () => {
    const built = buildClaimAuditEvent({
      parsed: parseClaimAudit({ claim_audit: auditBlock() }),
      sessionId: SID,
      missionId: MISSION,
      model: MODEL,
      reviewerId: REVIEWER,
    });
    expect(built.ok).toBe(true);
    expect('subject_model' in built.input.data).toBe(false);

    expect(append(built.input).ok).toBe(true);
    const lines = rawLines();
    expect(lines).toHaveLength(1);
    expect(rejectedLines()).toHaveLength(0);

    const [line] = lines;
    expect(line.event).toBe('review.claim_audit');
    expect(line.source).toBe('reviewer');
    expect('subject_model' in line.data).toBe(false);
    expect(line.data.nature).toBe('judge');
    expect(line.data.subject_agent_type).toBe('code-reviewer');
    expect(line.data.claims_total).toBe(12);
    expect(line.data.claims_refuted).toBe(3);
    expect(line.data.evidence_refs).toEqual(['lib/review/independent-reviewer.js:699']);
  });

  it('omits nature when the report was untagged', () => {
    const built = buildClaimAuditEvent({
      parsed: parseClaimAudit({ claim_audit: auditBlock({ nature: undefined }) }),
      sessionId: SID,
      model: MODEL,
    });
    expect(built.ok).toBe(true);
    expect('nature' in built.input.data).toBe(false);
    expect(append(built.input).ok).toBe(true);
    expect(rejectedLines()).toHaveLength(0);
  });

  it('includes subject_model and subject_agent_id when the block carried them', () => {
    const built = buildClaimAuditEvent({
      parsed: parseClaimAudit({
        claim_audit: auditBlock({ subject_model: 'claude-opus-5', subject_agent_id: 'ag-77' }),
      }),
      sessionId: SID,
      model: MODEL,
    });
    expect(built.input.data.subject_model).toBe('claude-opus-5');
    expect(built.input.data.subject_agent_id).toBe('ag-77');
    expect(append(built.input).ok).toBe(true);
    expect(rejectedLines()).toHaveLength(0);
  });

  it('omits evidence_refs when the block had none', () => {
    const built = buildClaimAuditEvent({
      parsed: parseClaimAudit({ claim_audit: auditBlock({ evidence_refs: undefined }) }),
      sessionId: SID,
    });
    expect(built.ok).toBe(true);
    expect('evidence_refs' in built.input.data).toBe(false);
  });

  it('builds without an envelope model — the allowlist does not require one here', () => {
    const built = buildClaimAuditEvent({
      parsed: parseClaimAudit({ claim_audit: auditBlock() }),
      sessionId: SID,
    });
    expect(built.ok).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(built.input, 'model')).toBe(false);
    expect(append(built.input).ok).toBe(true);
    expect(rejectedLines()).toHaveLength(0);
  });

  it('keeps envelope-only keys out of data', () => {
    const built = buildClaimAuditEvent({
      parsed: parseClaimAudit({ claim_audit: auditBlock() }),
      sessionId: SID,
      missionId: MISSION,
      model: MODEL,
      reviewerId: REVIEWER,
    });
    for (const key of ['session_id', 'mission_id', 'model', 'worker', 'source', 'event']) {
      expect(Object.prototype.hasOwnProperty.call(built.input.data, key), key).toBe(false);
    }
  });

  it.each([
    ['claims_refuted exceeds claims_total', { claims_total: 2, claims_refuted: 5 }],
    ['the denominator is missing', { claims_total: undefined }],
    ['a count is a string', { claims_total: '12' }],
    ['nature is off-enum', { nature: 'vibes' }],
    ['subject_agent_type is missing', { subject_agent_type: undefined }],
  ])('refuses to build when %s', (_label, over) => {
    const parsed = parseClaimAudit({ claim_audit: auditBlock(over) });
    expect(parsed.ok).toBe(false);
    const built = buildClaimAuditEvent({ parsed, sessionId: SID, model: MODEL });
    expect(built.ok).toBe(false);
    expect(built.input).toBeUndefined();
  });

  it('refuses to build without a session id', () => {
    expect(buildClaimAuditEvent({
      parsed: parseClaimAudit({ claim_audit: auditBlock() }),
    }).ok).toBe(false);
  });
});

describe('idempotency keys', () => {
  it('spells review.completed as event:session:verification_id', () => {
    expect(reviewCompletedIdempotencyKey(SID, 'v1-abc'))
      .toBe('review.completed:sess-review-writer:v1-abc');
  });

  it('keeps the key byte-identical for a canonical verifier id after the size bound', () => {
    // The id format `unified-verifier.js#buildVerificationId` emits. The
    // bound refuses long ids; it must not respell the ones it admits, or
    // every already-written row would stop deduping against its redelivery.
    const id = 'v1-3f9a2b1c8d04-20260902T071530Z';
    const built = buildReviewCompletedEvent({
      parsed: parseReviewVerdict(v2Doc({ verification_id: id })),
      sessionId: SID,
      model: MODEL,
      findingsRef: FINDINGS_REF,
    });
    expect(built.ok).toBe(true);
    expect(built.input.idempotency_key)
      .toBe('review.completed:sess-review-writer:v1-3f9a2b1c8d04-20260902T071530Z');
  });

  it('spells claim_audit as event:session:subject_agent_type:12 hex', () => {
    const key = claimAuditIdempotencyKey(SID, parseClaimAudit({ claim_audit: auditBlock() }));
    expect(key).toMatch(/^review\.claim_audit:sess-review-writer:code-reviewer:[0-9a-f]{12}$/);
  });

  it('is stable across key order and repeated calls', () => {
    const a = claimAuditIdempotencyKey(SID, parseClaimAudit({ claim_audit: auditBlock() }));
    const b = claimAuditIdempotencyKey(SID, parseClaimAudit({
      claim_audit: {
        evidence_refs: ['lib/review/independent-reviewer.js:699'],
        claims_refuted: 3,
        claims_total: 12,
        nature: 'judge',
        subject_agent_type: 'code-reviewer',
      },
    }));
    expect(a).toBe(b);
  });

  it('changes when any counted field changes', () => {
    const base = claimAuditIdempotencyKey(SID, parseClaimAudit({ claim_audit: auditBlock() }));
    const variants = [
      { claims_total: 13 },
      { claims_refuted: 4 },
      { nature: 'process' },
      { subject_agent_type: 'tdd-guide' },
      { subject_agent_id: 'ag-1' },
      { evidence_refs: ['other.js:1'] },
    ];
    for (const over of variants) {
      const key = claimAuditIdempotencyKey(SID, parseClaimAudit({
        claim_audit: auditBlock(over),
      }));
      expect(key, JSON.stringify(over)).not.toBe(base);
    }
  });

  it('does NOT change when subject_model alone changes', () => {
    // What this pins is a LOSS, accepted deliberately: a reviewer that re-emits
    // the same audit with subject_model now filled in gets the richer line
    // deduped away. It is NOT protection against a before/after-bind pair —
    // buildClaimAuditEvent has no argument a bind could inject a model through,
    // so this writer cannot emit that pair at all. One audit is one measurement
    // and so one line; filling in the reviewed agent's model is the L2 D1
    // route-receipt bind's job (설계 §1.3), joining on subject_agent_id.
    const without = claimAuditIdempotencyKey(SID, parseClaimAudit({
      claim_audit: auditBlock(),
    }));
    const withModel = claimAuditIdempotencyKey(SID, parseClaimAudit({
      claim_audit: auditBlock({ subject_model: 'claude-opus-5' }),
    }));
    expect(withModel).toBe(without);
  });

  it('separates two sessions', () => {
    const a = claimAuditIdempotencyKey('s1', parseClaimAudit({ claim_audit: auditBlock() }));
    const b = claimAuditIdempotencyKey('s2', parseClaimAudit({ claim_audit: auditBlock() }));
    expect(a).not.toBe(b);
  });
});

describe('recordReviewOutcome — both blocks, through the real ledger', () => {
  it('appends two lines from one answer and zero rejections', () => {
    const ports = livePorts();
    const out = recordReviewOutcome(recordArgs(), ports);

    expect(out.review.status).toBe('appended');
    expect(out.claimAudit.status).toBe('appended');
    expect(out.parsed.verdict.ok).toBe(true);
    expect(out.parsed.claimAudit.ok).toBe(true);

    const lines = rawLines();
    expect(lines).toHaveLength(2);
    expect(rejectedLines()).toHaveLength(0);
    expect(lines.map((l) => l.event).sort())
      .toEqual(['review.claim_audit', 'review.completed']);
  });

  it('dedupes both events on a second identical call', () => {
    const ports = livePorts();
    const first = recordReviewOutcome(recordArgs(), ports);
    expect(first.review.status).toBe('appended');
    expect(first.claimAudit.status).toBe('appended');
    expect(rawLines()).toHaveLength(2);

    const second = recordReviewOutcome(recordArgs(), ports);
    expect(second.review.status).toBe('deduped');
    expect(second.claimAudit.status).toBe('deduped');
    expect(second.review.key).toBe(first.review.key);
    expect(second.claimAudit.key).toBe(first.claimAudit.key);

    expect(rawLines()).toHaveLength(2);
    expect(rejectedLines()).toHaveLength(0);
  });

  it('skips the review half and still writes the audit half for legacy text', () => {
    const ports = livePorts();
    const text = ['APPROVE — 문제 없다.', '',
      JSON.stringify({ claim_audit: auditBlock() }), ''].join('\n');
    const out = recordReviewOutcome(recordArgs({ verdictText: text }), ports);

    expect(out.review.status).toBe('skipped');
    expect(out.claimAudit.status).toBe('appended');
    const lines = rawLines();
    expect(lines).toHaveLength(1);
    expect(lines[0].event).toBe('review.claim_audit');
    expect(rejectedLines()).toHaveLength(0);
  });

  it.each([
    ['legacy APPROVE', 'APPROVE'],
    ['ambiguous SPEC_FAIL', 'SPEC_FAIL'],
    ['prose with no token', '검수했고 괜찮아 보인다.'],
  ])('writes nothing at all for %s', (_label, text) => {
    const out = recordReviewOutcome(recordArgs({ verdictText: text }), livePorts());
    expect(out.review.status).toBe('skipped');
    expect(out.claimAudit.status).toBe('skipped');
    expect(rawLines()).toHaveLength(0);
    expect(existsSync(ledgerFile())).toBe(false);
  });

  it('writes nothing when the envelope model is missing', () => {
    const out = recordReviewOutcome(recordArgs({ model: undefined }), livePorts());
    expect(out.review.status).toBe('skipped');
    // The audit half does not require an envelope model, so it still lands.
    expect(out.claimAudit.status).toBe('appended');
    expect(rawLines().filter((l) => l.event === 'review.completed')).toHaveLength(0);
    expect(rejectedLines()).toHaveLength(0);
  });

  it('skips the audit half when claims_refuted exceeds claims_total', () => {
    const ports = livePorts();
    const text = answer({ audit: { claims_total: 2, claims_refuted: 5 } });
    const out = recordReviewOutcome(recordArgs({ verdictText: text }), ports);

    expect(out.claimAudit.status).toBe('skipped');
    expect(out.review.status).toBe('appended');
    const lines = rawLines();
    expect(lines).toHaveLength(1);
    expect(lines[0].event).toBe('review.completed');
  });

  it('skips the audit half when the answer carries no audit block', () => {
    const out = recordReviewOutcome(
      recordArgs({ verdictText: answer({ audit: null }) }), livePorts(),
    );
    expect(out.review.status).toBe('appended');
    expect(out.claimAudit.status).toBe('skipped');
    expect(rawLines()).toHaveLength(1);
  });

  it('passes the validateSchema port through to the verdict parser', () => {
    const calls = [];
    const out = recordReviewOutcome(recordArgs({
      validateSchema: (doc) => {
        calls.push(doc.verdict);
        return { ok: false, errors: ['nope'] };
      },
    }), livePorts());
    expect(calls).toEqual(['PASS']);
    expect(out.review.status).toBe('skipped');
    expect(rawLines().filter((l) => l.event === 'review.completed')).toHaveLength(0);
  });
});

describe('recordReviewOutcome — never throws', () => {
  it('reports port-threw:append and lets no exception escape', () => {
    const out = recordReviewOutcome(recordArgs(), {
      append: () => { throw new Error('disk on fire'); },
      existingKeys: () => [],
    });
    expect(out.review.status).toBe('rejected');
    expect(out.review.reason.startsWith('port-threw:')).toBe(true);
    expect(out.review.reason).toBe('port-threw:append');
    expect(out.claimAudit.status).toBe('rejected');
    expect(out.claimAudit.reason).toBe('port-threw:append');
  });

  it('reports port-threw:existingKeys without appending', () => {
    let appends = 0;
    const out = recordReviewOutcome(recordArgs(), {
      append: () => { appends += 1; return { ok: true }; },
      existingKeys: () => { throw new Error('unreadable'); },
    });
    expect(out.review.status).toBe('rejected');
    expect(out.review.reason).toBe('port-threw:existingKeys');
    expect(out.claimAudit.reason).toBe('port-threw:existingKeys');
    expect(appends).toBe(0);
  });

  it('reports the writer reason when the append port refuses', () => {
    const out = recordReviewOutcome(recordArgs(), {
      append: () => ({ ok: false, reason: 'unregistered-event', rejected: true }),
      existingKeys: () => [],
    });
    expect(out.review.status).toBe('rejected');
    expect(out.review.reason).toBe('unregistered-event');
  });

  it('rejects rather than throwing when a port is missing', () => {
    const out = recordReviewOutcome(recordArgs(), {});
    expect(out.review.status).toBe('rejected');
    expect(out.review.reason).toBe('port-missing:append');
    expect(out.claimAudit.status).toBe('rejected');
  });

  it('rejects rather than throwing when ports is absent entirely', () => {
    const out = recordReviewOutcome(recordArgs());
    expect(out.review.status).toBe('rejected');
    expect(out.claimAudit.status).toBe('rejected');
  });

  it.each([
    ['undefined args', undefined],
    ['null args', null],
    ['a number', 42],
    ['an empty object', {}],
  ])('returns a fully shaped result for %s', (_label, args) => {
    const out = recordReviewOutcome(args, { append: () => ({ ok: true }), existingKeys: () => [] });
    expect(out.review.status).toBe('skipped');
    expect(out.claimAudit.status).toBe('skipped');
    expect(out.parsed.verdict.ok).toBe(false);
    expect(out.parsed.claimAudit.ok).toBe(false);
  });

  it('accepts an iterable of keys, not only an array', () => {
    const keys = new Set([reviewCompletedIdempotencyKey(SID, 'v1-abc')]);
    const out = recordReviewOutcome(recordArgs(), {
      append: (input) => append(input),
      existingKeys: () => keys,
    });
    expect(out.review.status).toBe('deduped');
    expect(out.claimAudit.status).toBe('appended');
    expect(rawLines()).toHaveLength(1);
  });
});
