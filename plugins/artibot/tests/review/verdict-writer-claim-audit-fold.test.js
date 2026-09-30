/**
 * `review.claim_audit` never loses a declared key to the ledger fold — the evidence_refs
 * budget of `buildClaimAuditEvent`, driven through `recordReviewOutcome` and the real writer.
 *
 * Split out of `verdict-writer.test.js` for the 800-line standard (V5-BACKLOG section 3); the
 * cases moved verbatim. The helpers they use are repeated below instead of shared, as in
 * `tests/ledger/session-coverage-cli-edges.test.js`. "above" and "below" in a moved comment
 * refer to the original single file. The properties the suite holds, and what it does NOT prove,
 * are in the header of `verdict-writer.test.js`.
 *
 * @module tests/review/verdict-writer-claim-audit-fold
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
import { parseClaimAudit } from '../../lib/review/independent-reviewer.js';
import {
  buildClaimAuditEvent,
  claimAuditIdempotencyKey,
  ENVELOPE_RESERVE_BYTES,
  LEDGER_LINE_MAX_BYTES,
  recordReviewOutcome,
  REVIEW_CLAIM_AUDIT_EVENT,
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

describe('review.claim_audit never loses a declared key to the ledger fold', () => {
  // Before the budget, a long `evidence_refs` pushed the line past 4096 B and
  // `foldOversized` kept only the three required keys plus `evidence_refs` —
  // the field that caused the overflow — so `nature`, `subject_model` and
  // `subject_agent_id` went, and the row fell out of §4.1's stratified
  // denominator while landing `appended`. Further over, the folded line was
  // still too long and the whole audit became a `ledger.rejected` line.

  const BUDGET = LEDGER_LINE_MAX_BYTES - ENVELOPE_RESERVE_BYTES;
  const MARKER_RE = /^claim-audit:evidence_refs-truncated=kept(\d+)\/total(\d+)$/;
  /** A 126-char id, so the old fold had enough to drop for its row to land. */
  const SUBJECT = Object.freeze({
    subject_model: 'claude-opus-5',
    subject_agent_id: `agent-${'x'.repeat(120)}`,
  });

  /**
   * @param {number} i index
   * @returns {string} a fixed-width ref, so each one costs the same bytes
   */
  const ref = (i) => `lib/review/file-${String(i).padStart(4, '0')}.js:1`;

  /** @param {object} input @returns {number} serialized input bytes */
  const inputBytes = (input) => Buffer.byteLength(JSON.stringify(input), 'utf8');

  /**
   * An answer carrying `block` verbatim. Not `answer()`: that re-merges over
   * `auditBlock`'s defaults, which would put a ref back into a no-refs block.
   *
   * @param {object} block a `claim_audit` payload
   * @returns {string} markdown with one fenced JSON block
   */
  const auditText = (block) => ['```json', JSON.stringify({ claim_audit: block }), '```', '']
    .join('\n');

  /**
   * @param {object} block a `claim_audit` payload
   * @returns {object} the builder result under the envelope `recordArgs` uses
   */
  function buildOf(block) {
    return buildClaimAuditEvent({
      parsed: parseClaimAudit({ claim_audit: block }),
      sessionId: SID,
      missionId: MISSION,
      model: MODEL,
      reviewerId: REVIEWER,
    });
  }

  /**
   * Serialized bytes of the UNTRUNCATED input for `block`, measured without
   * trusting the builder to leave a long input alone: a one-ref probe (which
   * fits) plus each further ref's `,"<ref>"` — the key is 12 hex whatever the
   * refs are, so nothing else moves.
   *
   * @param {object} block a `claim_audit` payload with at least one ref
   * @returns {number} bytes
   */
  function fullInputBytes(block) {
    const [first, ...rest] = block.evidence_refs;
    const probe = buildOf({ ...block, evidence_refs: [first] });
    expect(probe.ok).toBe(true);
    return rest.reduce((sum, r) => sum + inputBytes(r) + 1, inputBytes(probe.input));
  }

  /**
   * A block whose untruncated input is exactly `bytes` long: fixed-width refs,
   * the last one padded by the remainder.
   *
   * @param {number} bytes target untruncated input bytes
   * @returns {object} the block
   */
  function blockOfBytes(bytes) {
    const base = auditBlock({ ...SUBJECT, evidence_refs: [ref(0)] });
    const one = fullInputBytes(base);
    const per = inputBytes(ref(0)) + 1;
    const extra = Math.floor((bytes - one) / per);
    const refs = Array.from({ length: extra + 1 }, (_, i) => ref(i));
    refs[extra] += 'z'.repeat(bytes - one - extra * per);
    const block = { ...base, evidence_refs: refs };
    expect(fullInputBytes(block)).toBe(bytes);
    return block;
  }

  const CASES = [
    ['short', () => auditBlock(SUBJECT), 'kept'],
    ['exactly the budget', () => blockOfBytes(BUDGET), 'kept'],
    ['one byte over the budget', () => blockOfBytes(BUDGET + 1), 'truncated'],
    ['just over the 4096 B fold boundary', () => blockOfBytes(4077), 'truncated'],
    ['far over — 5000 B', () => blockOfBytes(5000), 'truncated'],
    ['far over — 500 long refs', () => auditBlock({
      ...SUBJECT,
      evidence_refs: Array.from({ length: 500 }, (_, i) => `${ref(i)}${'q'.repeat(40)}`),
    }), 'truncated'],
    ['a first ref that alone overflows', () => auditBlock({
      ...SUBJECT, evidence_refs: ['r'.repeat(5000), ref(1)],
    }), 'truncated'],
    ['no refs and an oversized agent id', () => auditBlock({
      ...SUBJECT, subject_agent_id: 'a'.repeat(5000), evidence_refs: undefined,
    }), 'refused'],
    ['refs and an agent id that alone overflows', () => auditBlock({
      ...SUBJECT, subject_agent_id: 'a'.repeat(5000),
    }), 'refused'],
  ];

  it.each(CASES)('%s: the row keeps every declared key, or the refusal is counted', (
    _label, makeBlock, expected,
  ) => {
    const block = makeBlock();
    const results = [];
    const out = recordReviewOutcome(recordArgs({
      verdictText: auditText(block),
    }), {
      append: (input) => {
        const res = append(input);
        results.push(res);
        return res;
      },
      existingKeys: () => [],
    });
    const rows = rawLines().filter((l) => l.event === REVIEW_CLAIM_AUDIT_EVENT);
    expect(rejectedLines()).toHaveLength(0);

    if (expected === 'refused') {
      // `skipped` + reason is the `review_ledger` column's counted channel.
      expect(out.claimAudit).toEqual({ status: 'skipped', reason: 'oversize:line' });
      expect(results).toHaveLength(0);
      expect(rows).toHaveLength(0);
      return;
    }

    expect(out.claimAudit.status).toBe('appended');
    expect(out.claimAudit.reason).toBeUndefined();
    expect(results.map((r) => r.folded)).toEqual([false]);
    expect(rows).toHaveLength(1);
    const { data } = rows[0];
    expect(data.nature).toBe('judge');
    expect(data.subject_model).toBe(SUBJECT.subject_model);
    expect(data.subject_agent_id).toBe(block.subject_agent_id);
    expect(data.subject_agent_type).toBe('code-reviewer');
    expect(data.claims_total).toBe(12);
    expect(data.claims_refuted).toBe(3);
    expect(data.evidence_refs.some((r) => r.startsWith('ledger-fold:'))).toBe(false);

    const refs = data.evidence_refs;
    if (expected === 'kept') {
      expect(refs).toEqual(block.evidence_refs);
      return;
    }
    const match = MARKER_RE.exec(refs[refs.length - 1]);
    expect(match).not.toBeNull();
    const kept = Number(match[1]);
    expect(Number(match[2])).toBe(block.evidence_refs.length);
    expect(refs).toHaveLength(kept + 1);
    expect(refs.slice(0, kept)).toEqual(block.evidence_refs.slice(0, kept));
    expect(kept).toBeLessThan(block.evidence_refs.length);
  });

  it('puts the just-over case in the old silent band, so the sweep can see it', () => {
    // The fixture's own check: the untruncated line folds, and the folded line
    // FITS — the shape that used to land `appended` without the three keys.
    const block = blockOfBytes(4077);
    const probe = buildOf({ ...block, evidence_refs: [block.evidence_refs[0]] });
    const full = {
      ...probe.input,
      data: { ...probe.input.data, evidence_refs: block.evidence_refs },
    };
    const env = buildEnvelope(full, { pid: process.pid, seq: 0 });
    const spec = getAllowlist().events[REVIEW_CLAIM_AUDIT_EVENT];
    expect(lineBytes(env)).toBeGreaterThan(LEDGER_LINE_MAX_BYTES);
    const folded = foldOversized(env, spec);
    expect(folded.dropped).toEqual(['nature', 'subject_model', 'subject_agent_id']);
    expect(lineBytes(folded.env)).toBeLessThanOrEqual(LEDGER_LINE_MAX_BYTES);
  });

  it('keeps the LONGEST prefix that fits with the marker', () => {
    const block = blockOfBytes(5000);
    const built = buildOf(block);
    expect(built.ok).toBe(true);
    expect(inputBytes(built.input)).toBeLessThanOrEqual(BUDGET);
    const refs = built.input.data.evidence_refs;
    const kept = refs.length - 1;
    const total = block.evidence_refs.length;
    const oneMore = {
      ...built.input,
      data: {
        ...built.input.data,
        evidence_refs: [
          ...block.evidence_refs.slice(0, kept + 1),
          `claim-audit:evidence_refs-truncated=kept${kept + 1}/total${total}`,
        ],
      },
    };
    expect(inputBytes(oneMore)).toBeGreaterThan(BUDGET);
  });

  it('keeps the marker alone when not even the first ref fits', () => {
    const built = buildOf(auditBlock({ ...SUBJECT, evidence_refs: ['r'.repeat(5000), ref(1)] }));
    expect(built.ok).toBe(true);
    expect(built.input.data.evidence_refs)
      .toEqual(['claim-audit:evidence_refs-truncated=kept0/total2']);
  });

  it('computes the idempotency key from the FULL audit, not the truncated refs', () => {
    const block = blockOfBytes(5000);
    const parsed = parseClaimAudit({ claim_audit: block });
    const built = buildOf(block);
    const kept = built.input.data.evidence_refs.slice(0, -1);
    expect(kept.length).toBeLessThan(block.evidence_refs.length);
    expect(built.input.idempotency_key).toBe(claimAuditIdempotencyKey(SID, parsed));
    expect(built.input.idempotency_key)
      .not.toBe(claimAuditIdempotencyKey(SID, { ...parsed, evidence_refs: kept }));
  });

  it('dedupes a truncated audit delivered twice', () => {
    const text = auditText(blockOfBytes(5000));
    const ports = livePorts();
    const first = recordReviewOutcome(recordArgs({ verdictText: text }), ports);
    const second = recordReviewOutcome(recordArgs({ verdictText: text }), ports);
    expect(first.claimAudit.status).toBe('appended');
    expect(second.claimAudit).toEqual({ status: 'deduped', key: first.claimAudit.key });
    expect(rawLines()).toHaveLength(1);
  });

  it('leaves a short input byte-identical, key included', () => {
    // Literal captured from the UNMODIFIED builder (scratch probe, 2026-09-23
    // 07:3x UTC): the budget must not respell what it admits, or every row
    // already written would stop deduping against its redelivery.
    const built = buildClaimAuditEvent({
      parsed: parseClaimAudit({ claim_audit: auditBlock() }),
      sessionId: SID,
      missionId: MISSION,
      model: MODEL,
      reviewerId: REVIEWER,
    });
    expect(JSON.stringify(built)).toBe('{"ok":true,"input":{"event":"review.claim_audit",'
      + '"session_id":"sess-review-writer","mission_id":"M-20260912-001","source":"reviewer",'
      + '"model":"claude-fable-5-1","worker":"agent-reviewer-7",'
      + '"idempotency_key":"review.claim_audit:sess-review-writer:code-reviewer:4f64fd5ca05c",'
      + '"data":{"subject_agent_type":"code-reviewer","claims_total":12,"claims_refuted":3,'
      + '"nature":"judge","evidence_refs":["lib/review/independent-reviewer.js:699"]}}}');
  });
});
