/**
 * `lib/review/verdict-writer#recordReviewOutcome` — both blocks through the real ledger, the
 * never-throws contract, and how a folded row is reported (`ledger-truncated` vs `ledger-folded`).
 *
 * Split out of `verdict-writer.test.js` for the 800-line standard (V5-BACKLOG section 3); the
 * cases moved verbatim. The helpers they use are repeated below instead of shared, as in
 * `tests/ledger/session-coverage-cli-edges.test.js`. "above" and "below" in a moved comment
 * refer to the original single file. The properties the suite holds, and what it does NOT prove,
 * are in the header of `verdict-writer.test.js`.
 *
 * @module tests/review/verdict-writer-record
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { appendLedgerEvent, readAllEvents } from '../../lib/runtime/ledger.js';
import {
  buildEnvelope,
  foldOversized,
  getAllowlist,
  lineBytes,
  resetSeq,
} from '../../lib/runtime/event-writer.js';
import { parseReviewVerdict } from '../../lib/review/independent-reviewer.js';
import {
  buildReviewCompletedEvent,
  recordReviewOutcome,
  REVIEW_COMPLETED_EVENT,
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

describe('a folded row says whether it lost keys: ledger-truncated vs ledger-folded', () => {
  // `ledger-truncated` = the writer cut only the overflow array (`dropped: []`),
  // so every key is still on the row. Anything else folded — keys dropped, or a
  // result that does not say (`dropped` missing / not an array) — stays
  // `ledger-folded`, because an unknown fold must be read as a loss.

  /**
   * Record through the given append port and keep the writer results.
   * @param {object} args recordArgs overrides
   * @param {(input: object) => object} port append port
   * @returns {{out: object, results: object[]}}
   */
  function recordVia(args, port) {
    const results = [];
    const out = recordReviewOutcome(recordArgs(args), {
      append: (input) => {
        const res = port(input);
        results.push(res);
        return res;
      },
      existingKeys: () => [],
    });
    return { out, results };
  }

  it('reports ledger-truncated when redaction growth makes the writer cut only refs', () => {
    // The builder budgets BEFORE `redactDeep`; each `pwd=abcd ` then grows by
    // 18 B, so the admitted line is over the cap again and the writer's stage 2
    // cuts refs. Every claim_audit key is declared, so stage 1 drops nothing.
    const block = auditBlock({
      subject_model: 'claude-opus-5',
      subject_agent_id: 'agent-0123',
      evidence_refs: Array.from({ length: 200 }, (_, i) => `pwd=abcd lib/f-${i}.js:1`),
    });
    const text = ['```json', JSON.stringify({ claim_audit: block }), '```', ''].join('\n');
    const { out, results } = recordVia({ verdictText: text }, append);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ ok: true, folded: true, dropped: [] });
    expect(results[0].truncated).toMatchObject({ field: 'evidence_refs' });
    expect(out.claimAudit.status).toBe('appended');
    expect(out.claimAudit.reason).toBe('ledger-truncated');
    const [row] = rawLines();
    expect(row.data).toMatchObject({
      nature: 'judge', subject_model: 'claude-opus-5', subject_agent_id: 'agent-0123',
    });
    expect(row.data.evidence_refs.some((r) => r.startsWith('ledger-fold:evidence_refs-truncated=')))
      .toBe(true);
    expect(rejectedLines()).toHaveLength(0);
  });

  it('reports ledger-folded when the real writer drops keys from review.completed', () => {
    // A cap between the unfolded and the folded line, as in the lowered-cap
    // case above: every key is declared, so stages 1-2 have nothing to do and
    // `foldOversized` drops the optional keys.
    const verificationId = 'a'.repeat(VERIFICATION_ID_MAX_LENGTH);
    const built = buildReviewCompletedEvent({
      parsed: parseReviewVerdict(v2Doc({ verification_id: verificationId })),
      sessionId: SID, missionId: MISSION, model: MODEL, findingsRef: FINDINGS_REF,
      reviewerId: REVIEWER, intentBinding: 'match',
    });
    const opts = { pid: 1234, seq: 1, now: () => new Date('2026-09-23T00:00:00.000Z') };
    const env = buildEnvelope(built.input, opts);
    const folded = foldOversized(env, getAllowlist().events[REVIEW_COMPLETED_EVENT]).env;
    const cap = Math.floor((lineBytes(env) + lineBytes(folded)) / 2);
    const { out, results } = recordVia(
      {
        verdictText: answer({ verdict: { verification_id: verificationId }, audit: null }),
        intentBinding: 'match',
      },
      (input) => appendLedgerEvent(root, input, { ...opts, ledgerPath: LEDGER_REL, maxLineBytes: cap }),
    );
    expect(results[0].ok).toBe(true);
    expect(results[0].folded).toBe(true);
    expect(results[0].dropped).toEqual(
      ['intent_revision', 'plan_revision', 'intent_binding', 'verification_id'],
    );
    expect(out.review.status).toBe('appended');
    expect(out.review.reason).toBe('ledger-folded');
  });

  it.each([
    ['the old shape, no dropped', { ok: true, folded: true }],
    // Empty, so only the Array.isArray check can tell it from `[]`.
    ['dropped that is an empty string, not an array', { ok: true, folded: true, dropped: '' }],
    ['dropped that is non-empty', { ok: true, folded: true, dropped: ['nature'] }],
  ])('reports ledger-folded for %s', (_label, res) => {
    const { out } = recordVia({ verdictText: answer({ audit: null }) }, () => res);
    expect(out.review.status).toBe('appended');
    expect(out.review.reason).toBe('ledger-folded');
  });

  it('reports a clean append when nothing was folded, whatever dropped says', () => {
    const { out } = recordVia(
      { verdictText: answer({ audit: null }) },
      () => ({ ok: true, folded: false, dropped: [] }),
    );
    expect(out.review.status).toBe('appended');
    expect(out.review.reason).toBeUndefined();
  });
});
