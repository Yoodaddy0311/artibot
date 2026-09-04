/**
 * `lib/review/independent-reviewer#parseClaimAudit` — reading the refutation
 * count out of an auditor's answer.
 *
 * The measurement this feeds is "how many of a teammate's claims were
 * overturned in review" (DESIGN-MODEL-POLICY-role-override.md §4.1): numerator
 * `claims_refuted`, denominator `claims_total`, stratified by subject model ×
 * `nature` × agent definition, stored as the ledger event
 * `review.claim_audit` (ARTIBOT-5.0-DESIGN.md 부록 0-2 후속(3) MP-4).
 *
 * ── The four properties this suite holds ───────────────────────────────────
 *  1. A DENOMINATOR IS MANDATORY. `claims_refuted: 0` with no `claims_total`
 *     is not "zero refutations", it is an unusable document. §4.1 says a
 *     numerator without a denominator is not used, so a missing denominator
 *     must be `ok:false` and never a silent pass.
 *  2. NOTHING IS GUESSED. Two fenced blocks that disagree are escalated, not
 *     averaged or first-wins. Same rule `parseReviewVerdict` applies to an
 *     ambiguous token.
 *  3. ABSENT IS NOT INVALID, FOR THE TWO OPTIONAL FIELDS ONLY. `nature` is
 *     dropped from the denominator when the leader did not tag it (§4.4 #4)
 *     and `subject_model` cannot be filled before L2 D1's route-receipt bind
 *     lands, so both parse to `null` rather than failing. Every other missing
 *     or mistyped field fails closed.
 *  4. TYPES ARE NOT COERCED. `"12"` is not 12. The ledger declares
 *     `claims_total` as an integer and `lib/runtime/ledger-schema.js
 *     #matchesType` tests it with `Number.isInteger`, so a string that the
 *     parser quietly coerced would be rejected one layer later — or worse,
 *     accepted with a denominator nobody counted.
 *
 * ── What this suite does NOT prove ─────────────────────────────────────────
 *  - That the counting rule was applied. §4.4 #2: "one file:line citation = 1
 *    claim, one number = 1 claim, one judgement sentence = 1 claim" is a rule
 *    for the human or agent writing the document. A well-formed document with
 *    an invented `claims_total` is green here.
 *  - That an emitted `review.claim_audit` line is accepted by the writer. That
 *    is `tests/firewall/ledger-vocab-allowlist.test.js` and the writer's own
 *    suite; this file never touches the filesystem.
 *  - That `subject_model` is the model the subject actually ran on. The parser
 *    carries whatever it is handed; the join is L2 D1's.
 */

import { describe, expect, it } from 'vitest';

import {
  CLAIM_NATURES,
  parseClaimAudit,
} from '../../lib/review/independent-reviewer.js';

/**
 * A well-formed claim_audit payload, overridable per test.
 *
 * @param {object} [over] field overrides; `undefined` deletes the key
 * @returns {object} the `claim_audit` value
 */
function audit(over = {}) {
  const base = {
    subject_agent_type: 'code-reviewer',
    subject_model: 'fable',
    nature: 'judge',
    claims_total: 12,
    claims_refuted: 1,
    evidence_refs: ['lib/x.js#fn'],
  };
  const out = { ...base, ...over };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete out[k];
  }
  return out;
}

/**
 * @param {object} [over] overrides passed to {@link audit}
 * @returns {object} the wrapper document a reviewer emits
 */
function doc(over = {}) {
  return { claim_audit: audit(over) };
}

/**
 * @param {object} d wrapper document
 * @param {string} [lang] fence info string
 * @returns {string} the document inside a markdown fence
 */
function fenced(d, lang = 'json') {
  return `\`\`\`${lang}\n${JSON.stringify(d, null, 2)}\n\`\`\``;
}

/**
 * @param {object} res parse result
 * @returns {string[]} error codes, in order
 */
function codes(res) {
  return res.errors.map((e) => e.code);
}

/**
 * @param {object} res parse result
 * @returns {(string|undefined)[]} error paths, in order
 */
function paths(res) {
  return res.errors.map((e) => e.path);
}

describe('parseClaimAudit — the shapes it accepts', () => {
  it('accepts the object form and carries every field through', () => {
    const res = parseClaimAudit(doc());
    expect(res.ok).toBe(true);
    expect(res.errors).toEqual([]);
    expect(res.claims_total).toBe(12);
    expect(res.claims_refuted).toBe(1);
    expect(res.nature).toBe('judge');
    expect(res.subject_agent_type).toBe('code-reviewer');
    expect(res.subject_model).toBe('fable');
    expect(res.evidence_refs).toEqual(['lib/x.js#fn']);
  });

  it('accepts a bare JSON string', () => {
    const res = parseClaimAudit(JSON.stringify(doc()));
    expect(res.ok).toBe(true);
    expect(res.claims_total).toBe(12);
  });

  it('accepts a fenced JSON block', () => {
    const res = parseClaimAudit(fenced(doc()));
    expect(res.ok).toBe(true);
    expect(res.claims_refuted).toBe(1);
  });

  it('accepts a fenced block surrounded by markdown prose', () => {
    const text = [
      '## 검수 결과',
      '',
      '팀원 보고에서 인용 1건이 뒤집혔다.',
      '',
      fenced(doc()),
      '',
      '나머지는 재측정으로 확인했다.',
    ].join('\n');
    const res = parseClaimAudit(text);
    expect(res.ok).toBe(true);
    expect(res.subject_agent_type).toBe('code-reviewer');
  });

  it('accepts an unlabelled fence, the same way the verdict parser does', () => {
    const res = parseClaimAudit(fenced(doc(), ''));
    expect(res.ok).toBe(true);
  });

  it('carries subject_agent_id when the document has one', () => {
    const res = parseClaimAudit({
      claim_audit: { ...audit(), subject_agent_id: 'agent-7f3a' },
    });
    expect(res.ok).toBe(true);
    expect(res.subject_agent_id).toBe('agent-7f3a');
  });

  it('reads zero refutations out of a counted denominator', () => {
    const res = parseClaimAudit(doc({ claims_total: 40, claims_refuted: 0 }));
    expect(res.ok).toBe(true);
    expect(res.claims_refuted).toBe(0);
    expect(res.claims_total).toBe(40);
  });

  it('accepts refuted === total', () => {
    const res = parseClaimAudit(doc({ claims_total: 3, claims_refuted: 3 }));
    expect(res.ok).toBe(true);
  });

  it('accepts both declared natures', () => {
    for (const nature of CLAIM_NATURES) {
      expect(parseClaimAudit(doc({ nature })).nature).toBe(nature);
    }
  });
});

describe('parseClaimAudit — the two fields that may be absent', () => {
  it('leaves nature null when the leader did not tag it (§4.4 #4)', () => {
    const res = parseClaimAudit(doc({ nature: undefined }));
    expect(res.ok).toBe(true);
    expect(res.nature).toBeNull();
  });

  it('leaves subject_model null until the L2 D1 bind lands', () => {
    const res = parseClaimAudit(doc({ subject_model: undefined }));
    expect(res.ok).toBe(true);
    expect(res.subject_model).toBeNull();
  });

  it('leaves subject_agent_id null when absent', () => {
    const res = parseClaimAudit(doc());
    expect(res.ok).toBe(true);
    expect(res.subject_agent_id).toBeNull();
  });

  it('defaults evidence_refs to an empty array, never to null', () => {
    const res = parseClaimAudit(doc({ evidence_refs: undefined }));
    expect(res.ok).toBe(true);
    expect(res.evidence_refs).toEqual([]);
  });

  it('does not invent a model when one is absent', () => {
    // The failure this closes: a parser that defaults to the tier the reviewer
    // itself ran on would attribute every row to one model and the whole
    // stratification would be a tautology.
    const res = parseClaimAudit(doc({ subject_model: undefined }));
    expect(res.subject_model).toBeNull();
    expect(res.subject_model).not.toBe('fable');
  });
});

describe('parseClaimAudit — unusable input', () => {
  it('rejects a null input', () => {
    const res = parseClaimAudit(null);
    expect(res.ok).toBe(false);
    expect(codes(res)).toEqual(['not_parseable']);
  });

  it('rejects a number', () => {
    expect(codes(parseClaimAudit(42))).toEqual(['not_parseable']);
  });

  it('rejects an array', () => {
    expect(codes(parseClaimAudit([doc()]))).toEqual(['not_parseable']);
  });

  it('rejects an empty string', () => {
    expect(codes(parseClaimAudit(''))).toEqual(['not_parseable']);
  });

  it('rejects a whitespace-only string', () => {
    expect(codes(parseClaimAudit('   \n\t  '))).toEqual(['not_parseable']);
  });

  it('rejects an object with no claim_audit key', () => {
    const res = parseClaimAudit({ schema_version: 2, verdict: 'PASS' });
    expect(res.ok).toBe(false);
    expect(codes(res)).toEqual(['no_claim_audit']);
  });

  it('rejects prose that carries no JSON at all', () => {
    const res = parseClaimAudit('검수 결과 주장 12건 중 1건이 뒤집혔다.');
    expect(res.ok).toBe(false);
    expect(codes(res)).toEqual(['no_claim_audit']);
  });

  it('rejects a fenced block whose JSON has no claim_audit key', () => {
    const res = parseClaimAudit(fenced({ verdict: 'PASS', claims_refuted: 1 }));
    expect(codes(res)).toEqual(['no_claim_audit']);
  });

  it('rejects a claim_audit that is not an object', () => {
    for (const value of [12, 'judge', null, ['a']]) {
      const res = parseClaimAudit({ claim_audit: value });
      expect(res.ok, JSON.stringify(value)).toBe(false);
      expect(codes(res)).toEqual(['invalid_field']);
      expect(paths(res)).toEqual(['claim_audit']);
    }
  });
});

describe('parseClaimAudit — two blocks that disagree are escalated', () => {
  it('rejects two fenced blocks carrying different claim_audit values', () => {
    const text = `${fenced(doc({ claims_refuted: 1 }))}\n\n중간 서술\n\n${
      fenced(doc({ claims_refuted: 5 }))}`;
    const res = parseClaimAudit(text);
    expect(res.ok).toBe(false);
    expect(codes(res)).toEqual(['ambiguous_claim_audit']);
    expect(res.claims_refuted).toBeNull();
  });

  it('does not pick the first block, and does not pick the last', () => {
    const text = `${fenced(doc({ claims_total: 4 }))}\n${fenced(doc({ claims_total: 9 }))}`;
    const res = parseClaimAudit(text);
    expect(res.claims_total).toBeNull();
  });

  it('reads a bare document only when the whole string is that document', () => {
    // Inherited from `extractJsonDocument`: the bare path parses the ENTIRE
    // trimmed string, so JSON followed by prose is not a document. It fails
    // closed (no_claim_audit), which is the safe direction — but it is a real
    // limitation and it is asserted here rather than left to be discovered.
    const bareThenProse = `${JSON.stringify(doc())}\n\n위는 집계다.`;
    expect(codes(parseClaimAudit(bareThenProse))).toEqual(['no_claim_audit']);
    expect(parseClaimAudit(JSON.stringify(doc())).ok).toBe(true);
  });

  it('sees a JSON fence that follows a non-JSON fence', () => {
    // Regression guard for a measured defect in the single-document reader:
    // /```(?:json)?\s*\r?\n([\s\S]*?)```/g consumes the CLOSING fence of a
    // bash block as an opening one and then misses the JSON block entirely
    // (measured 2026-09-05 17:1x, node one-liner: one match, body "").
    // The multi-document scanner is line-based for exactly this reason.
    const text = `\`\`\`bash\nnpx vitest run tests/review\n\`\`\`\n\n${fenced(doc())}`;
    const res = parseClaimAudit(text);
    expect(res.ok).toBe(true);
    expect(res.claims_total).toBe(12);
  });

  it('sees the SECOND of two adjacent JSON fences when they disagree', () => {
    // Same defect, other direction: if the scanner could only ever find one
    // block, `ambiguous_claim_audit` would be unreachable and two disagreeing
    // reports would silently resolve to whichever one was found.
    const text = `${fenced(doc({ claims_refuted: 1 }))}\n${fenced(doc({ claims_refuted: 9 }))}`;
    expect(codes(parseClaimAudit(text))).toEqual(['ambiguous_claim_audit']);
  });

  it('accepts two blocks that repeat the SAME claim_audit', () => {
    // Repetition is not disagreement. Rejecting it would punish a reviewer for
    // restating the block in a summary section.
    const text = `${fenced(doc())}\n\n요약\n\n${fenced(doc())}`;
    const res = parseClaimAudit(text);
    expect(res.ok).toBe(true);
    expect(res.claims_total).toBe(12);
  });

  it('treats key order as the same document, not as a second one', () => {
    const a = { claim_audit: { claims_total: 5, claims_refuted: 1, subject_agent_type: 'auditor' } };
    const b = { claim_audit: { subject_agent_type: 'auditor', claims_refuted: 1, claims_total: 5 } };
    const res = parseClaimAudit(`${fenced(a)}\n${fenced(b)}`);
    expect(res.ok).toBe(true);
    expect(res.claims_total).toBe(5);
  });
});

describe('parseClaimAudit — the denominator is mandatory (negative control)', () => {
  it('rejects claims_refuted: 0 with no claims_total', () => {
    // The single most dangerous shape: a numerator of zero looks like "nothing
    // was refuted" to any reader that does not check for the denominator.
    const res = parseClaimAudit(doc({ claims_total: undefined, claims_refuted: 0 }));
    expect(res.ok).toBe(false);
    expect(codes(res)).toEqual(['invalid_field']);
    expect(paths(res)).toEqual(['claims_total']);
    expect(res.claims_refuted).toBeNull();
    expect(res.claims_total).toBeNull();
  });

  it('rejects a missing claims_refuted just as firmly', () => {
    const res = parseClaimAudit(doc({ claims_refuted: undefined }));
    expect(res.ok).toBe(false);
    expect(paths(res)).toEqual(['claims_refuted']);
  });

  it('rejects claims_total given as a string (negative control)', () => {
    const res = parseClaimAudit(doc({ claims_total: '12' }));
    expect(res.ok).toBe(false);
    expect(codes(res)).toEqual(['invalid_field']);
    expect(paths(res)).toEqual(['claims_total']);
    expect(res.claims_total).toBeNull();
  });

  it('rejects claims_refuted given as a string', () => {
    expect(paths(parseClaimAudit(doc({ claims_refuted: '1' })))).toEqual(['claims_refuted']);
  });

  it('rejects a non-integer count', () => {
    expect(parseClaimAudit(doc({ claims_total: 12.5 })).ok).toBe(false);
    expect(parseClaimAudit(doc({ claims_refuted: 0.5 })).ok).toBe(false);
  });

  it('rejects a negative count', () => {
    expect(paths(parseClaimAudit(doc({ claims_total: -1 })))).toEqual(['claims_total']);
    expect(paths(parseClaimAudit(doc({ claims_refuted: -1 })))).toEqual(['claims_refuted']);
  });

  it('rejects NaN and Infinity', () => {
    // JSON cannot carry these, but an object caller can.
    expect(parseClaimAudit(doc({ claims_total: Number.NaN })).ok).toBe(false);
    expect(parseClaimAudit(doc({ claims_total: Number.POSITIVE_INFINITY })).ok).toBe(false);
  });

  it('rejects a ratio above 1', () => {
    const res = parseClaimAudit(doc({ claims_total: 2, claims_refuted: 3 }));
    expect(res.ok).toBe(false);
    expect(codes(res)).toEqual(['invalid_field']);
    expect(paths(res)).toEqual(['claims_refuted']);
  });

  it('accepts a zero denominator only with a zero numerator', () => {
    expect(parseClaimAudit(doc({ claims_total: 0, claims_refuted: 0 })).ok).toBe(true);
    expect(parseClaimAudit(doc({ claims_total: 0, claims_refuted: 1 })).ok).toBe(false);
  });
});

describe('parseClaimAudit — the ledger-required and enum fields', () => {
  it('rejects a missing subject_agent_type', () => {
    const res = parseClaimAudit(doc({ subject_agent_type: undefined }));
    expect(res.ok).toBe(false);
    expect(codes(res)).toEqual(['invalid_field']);
    expect(paths(res)).toEqual(['subject_agent_type']);
  });

  it('rejects an empty or whitespace subject_agent_type', () => {
    expect(parseClaimAudit(doc({ subject_agent_type: '' })).ok).toBe(false);
    expect(parseClaimAudit(doc({ subject_agent_type: '   ' })).ok).toBe(false);
  });

  it('rejects a non-string subject_agent_type', () => {
    expect(paths(parseClaimAudit(doc({ subject_agent_type: 7 })))).toEqual(['subject_agent_type']);
  });

  it('rejects a nature outside the declared two', () => {
    const res = parseClaimAudit(doc({ nature: 'investigate' }));
    expect(res.ok).toBe(false);
    expect(codes(res)).toEqual(['invalid_field']);
    expect(paths(res)).toEqual(['nature']);
  });

  it('does not case-fold a nature — JUDGE is not judge', () => {
    // The allowlist enum is lowercase and the writer's enum check is exact
    // equality, so accepting a fold here would produce a row the ledger
    // refuses.
    expect(parseClaimAudit(doc({ nature: 'JUDGE' })).ok).toBe(false);
  });

  it('rejects a null nature rather than reading it as absent', () => {
    // Absent means "not tagged"; an explicit null is a document that made a
    // claim about the tag and got it wrong. Guessing which was meant is the
    // thing this module does not do.
    expect(paths(parseClaimAudit(doc({ nature: null })))).toEqual(['nature']);
  });

  it('rejects a non-string subject_model', () => {
    expect(paths(parseClaimAudit(doc({ subject_model: 5 })))).toEqual(['subject_model']);
  });

  it('does not police WHICH model string is used', () => {
    // Tier names are owned by lib/core/model-catalog.js. A second copy of that
    // vocabulary here would be a second source of truth.
    expect(parseClaimAudit(doc({ subject_model: 'claude-opus-5' })).ok).toBe(true);
  });

  it('rejects a non-array evidence_refs', () => {
    const res = parseClaimAudit(doc({ evidence_refs: 'lib/x.js#fn' }));
    expect(res.ok).toBe(false);
    expect(paths(res)).toEqual(['evidence_refs']);
  });

  it('rejects a non-string subject_agent_id', () => {
    expect(paths(parseClaimAudit({ claim_audit: { ...audit(), subject_agent_id: 3 } })))
      .toEqual(['subject_agent_id']);
  });

  it('reports every invalid field, not only the first', () => {
    const res = parseClaimAudit(doc({
      claims_total: '12',
      nature: 'guess',
      subject_agent_type: '',
    }));
    expect(res.ok).toBe(false);
    expect(paths(res).sort()).toEqual(['claims_total', 'nature', 'subject_agent_type']);
  });
});

describe('parseClaimAudit — a rejected document carries no readable numbers', () => {
  const rejected = [
    ['not parseable', null],
    ['no claim_audit', { verdict: 'PASS' }],
    ['string denominator', doc({ claims_total: '12' })],
    ['missing denominator', doc({ claims_total: undefined })],
    ['bad nature', doc({ nature: 'guess' })],
    ['missing agent type', doc({ subject_agent_type: undefined })],
    ['refuted > total', doc({ claims_total: 1, claims_refuted: 2 })],
  ];

  for (const [label, input] of rejected) {
    it(`nulls every field when the document is rejected: ${label}`, () => {
      const res = parseClaimAudit(input);
      expect(res.ok).toBe(false);
      expect(res.claims_total).toBeNull();
      expect(res.claims_refuted).toBeNull();
      expect(res.nature).toBeNull();
      expect(res.subject_agent_type).toBeNull();
      expect(res.subject_model).toBeNull();
      expect(res.subject_agent_id).toBeNull();
      expect(res.evidence_refs).toEqual([]);
      expect(res.errors.length).toBeGreaterThan(0);
    });
  }

  it('always returns the same key set, ok or not', () => {
    const keys = [
      'ok', 'claims_total', 'claims_refuted', 'nature', 'subject_agent_type',
      'subject_model', 'subject_agent_id', 'evidence_refs', 'errors',
    ].sort();
    expect(Object.keys(parseClaimAudit(doc())).sort()).toEqual(keys);
    expect(Object.keys(parseClaimAudit(null)).sort()).toEqual(keys);
  });

  it('every error carries a machine-readable code and a message', () => {
    for (const [, input] of rejected) {
      for (const err of parseClaimAudit(input).errors) {
        expect(typeof err.code).toBe('string');
        expect(err.message.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('parseClaimAudit does not disturb parseReviewVerdict', () => {
  it('a v2 verdict document with no claim_audit is still a valid verdict', async () => {
    const { parseReviewVerdict } = await import('../../lib/review/independent-reviewer.js');
    const v2 = {
      schema_version: 2,
      verdict: 'PASS',
      findings: [],
      evidence: ['a'],
      recommended_action: 'proceed',
      mission_id: 'M-20260902-001',
      intent_revision: 3,
      plan_revision: 1,
      diff_ref: 'HEAD',
      test_evidence: ['t'],
      regression_evidence: ['r'],
      verification_id: 'V-1',
      next_steps: [],
    };
    expect(parseReviewVerdict(v2).ok).toBe(true);
    expect(parseClaimAudit(v2).ok).toBe(false);
  });

  it('one string can carry both a verdict block and a claim_audit block', () => {
    // They are separate documents by design: reviewOutputV2 is
    // `additionalProperties:false`, so claim_audit cannot live inside it.
    const text = `${fenced({ schema_version: 2, verdict: 'PASS' })}\n\n${fenced(doc())}`;
    expect(parseClaimAudit(text).ok).toBe(true);
  });
});
