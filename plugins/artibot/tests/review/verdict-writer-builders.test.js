/**
 * `lib/review/verdict-writer` — the two builders (`buildReviewCompletedEvent`,
 * `buildClaimAuditEvent`) and `data.intent_binding`, each driven through the REAL ledger writer.
 *
 * Split out of `verdict-writer.test.js` for the 800-line standard (V5-BACKLOG section 3); the
 * cases moved verbatim. The helpers they use are repeated below instead of shared, as in
 * `tests/ledger/session-coverage-cli-edges.test.js`. "above" and "below" in a moved comment
 * refer to the original single file. The properties the suite holds, and what it does NOT prove,
 * are in the header of `verdict-writer.test.js`.
 *
 * @module tests/review/verdict-writer-builders
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { appendLedgerEvent, readAllEvents } from '../../lib/runtime/ledger.js';
import { foldOversized, getAllowlist, resetSeq } from '../../lib/runtime/event-writer.js';
import { parseClaimAudit, parseReviewVerdict } from '../../lib/review/independent-reviewer.js';
import {
  buildClaimAuditEvent,
  buildReviewCompletedEvent,
  recordReviewOutcome,
  REVIEW_COMPLETED_EVENT,
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
    // and `plan_revision` are declared `type: integer` for this event in the
    // allowlist (2026-09-28), which the firewall suite pins; they are
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

describe('data.intent_binding — CA-17 method A', () => {
  // The vocabulary is spelled out here rather than imported, so that a change
  // to `independent-reviewer.js#INTENT_BINDING_STATUSES` fails this pin
  // instead of silently redefining what the writer is tested against.
  const STATUSES = ['match', 'mismatch', 'input_absent', 'error'];

  /**
   * @param {object} [over] extra build arguments
   * @returns {object} a `buildReviewCompletedEvent` result
   */
  function build(over = {}) {
    return buildReviewCompletedEvent({
      parsed: parseReviewVerdict(v2Doc()),
      sessionId: SID,
      missionId: MISSION,
      model: MODEL,
      findingsRef: FINDINGS_REF,
      ...over,
    });
  }

  it.each(STATUSES)('writes %s verbatim and the real writer accepts it', (status) => {
    const built = build({ intentBinding: status });
    expect(built.ok).toBe(true);
    expect(built.input.data.intent_binding).toBe(status);
    expect(append(built.input).ok).toBe(true);
    expect(rejectedLines()).toHaveLength(0);
    const lines = rawLines();
    expect(lines).toHaveLength(1);
    expect(lines[0].data.intent_binding).toBe(status);
  });

  it('omits the key when no binding is given, leaving the pinned key set as it was', () => {
    const built = build();
    expect(Object.prototype.hasOwnProperty.call(built.input.data, 'intent_binding')).toBe(false);
    expect(Object.keys(built.input.data).sort())
      .toEqual(['findings_ref', 'intent_revision', 'plan_revision', 'verdict',
        'verification_id']);
  });

  it.each([
    ['an unknown word', 'bogus'],
    ['a case variant', 'MATCH'],
    ['an empty string', ''],
    ['null', null],
    ['a number', 1],
    ['the binder result object instead of its status', { status: 'match' }],
  ])('downgrades %s to error and still writes the row', (_label, value) => {
    const built = build({ intentBinding: value });
    expect(built.ok).toBe(true);
    expect(built.input.data.intent_binding).toBe('error');
    expect(append(built.input).ok).toBe(true);
    expect(rejectedLines()).toHaveLength(0);
    expect(rawLines()[0].data.intent_binding).toBe('error');
  });

  it('does not move the idempotency key', () => {
    const keys = [undefined, ...STATUSES].map((s) => build({ intentBinding: s }).input.idempotency_key);
    expect(new Set(keys).size).toBe(1);
  });

  it('writes no review.completed row for an inadmissible verdict, binding or not', () => {
    const built = build({ parsed: parseReviewVerdict('APPROVE'), intentBinding: 'match' });
    expect(built).toEqual({ ok: false, reason: 'verdict-not-admissible' });
  });

  it('is forwarded by recordReviewOutcome onto the verdict row only', () => {
    const out = recordReviewOutcome(recordArgs({ intentBinding: 'mismatch' }), livePorts());
    expect(out.review.status).toBe('appended');
    expect(out.claimAudit.status).toBe('appended');
    expect(rejectedLines()).toHaveLength(0);
    const review = rawLines().find((l) => l.event === 'review.completed');
    const audit = rawLines().find((l) => l.event === 'review.claim_audit');
    expect(review.data.intent_binding).toBe('mismatch');
    expect(Object.prototype.hasOwnProperty.call(audit.data, 'intent_binding')).toBe(false);
  });

  it('is absent from the row recordReviewOutcome writes without one', () => {
    recordReviewOutcome(recordArgs(), livePorts());
    const review = rawLines().find((l) => l.event === 'review.completed');
    expect(Object.prototype.hasOwnProperty.call(review.data, 'intent_binding')).toBe(false);
  });
});
