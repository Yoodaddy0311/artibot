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

  it('reads a bare document both alone and followed by prose', () => {
    // This asserted `no_claim_audit` for the second shape until 2026-09-05,
    // when the first real auditor report arrived in exactly that shape and the
    // measurement produced zero rows. The line scanner replaced the
    // whole-string-only rule; the multi-line bare case is still unread, and
    // that boundary is held by the negative controls further down.
    const bareThenProse = `${JSON.stringify(doc())}\n\n위는 집계다.`;
    expect(parseClaimAudit(bareThenProse).ok).toBe(true);
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

describe('parseClaimAudit — a bare claim_audit LINE among prose', () => {
  /**
   * The first real auditor report, VERBATIM (spawned 02:18~02:21 KST
   * 2026-09-05). Not a hand-trimmed excerpt: rules §9 — a fixture that does not
   * reach the failure region proves nothing, and the failure region here is the
   * whole unfenced line, evidence refs with spaces, parentheses, Korean text
   * and a `#` fragment included. The block arrived as ONE bare line between two
   * prose paragraphs; fed to the pre-fix parser it returned
   * `ok:false / no_claim_audit`, so the measurement produced zero rows from a
   * report that carried a valid count.
   *
   * The source below concatenates the bare line only to keep the FILE readable.
   * The joined string is byte-identical to what the auditor emitted.
   */
  const BARE_LINE = '{"claim_audit": {"subject_agent_type": "backend-developer", '
    + '"claims_total": 28, "claims_refuted": 2, "evidence_refs": ['
    + '"plugins/artibot/README.md#에이전트 시스템/orchestrator 행 (L1246, 02:20 기준)", '
    + '"plugins/artibot/README.md#모델 선택 기준", '
    + '"lib/core/model-policy.js#resolveModel", '
    + '"lib/core/model-policy.js#FABLE_DENYLIST", '
    + '"artibot.config.json#/agents/modelPolicy/fable/allowlist", '
    + '"README.md#Agents (루트, L532 orchestrator=fable)", '
    + '"tests/core/model-policy-allowed-tiers.test.js#denied"]}}';

  const AUDITOR_REPORT = [
    'claims_refuted: 2   (재현불가 0건)',
    '',
    BARE_LINE,
    '',
    '`subject_model` 생략: 원장 canonicalModel null, 실제 구동 모델 미확인. '
      + '`nature` 생략(미태깅): 리더가 스폰 시 태그를 달지 않았다.',
  ].join('\n');

  it('the fixture is the real artifact, not a rewrite of it', () => {
    // Scanner self-check: if the concatenation above ever loses a fragment,
    // every assertion below would still pass on a shorter, easier string.
    expect(JSON.parse(BARE_LINE).claim_audit.evidence_refs).toHaveLength(7);
    expect(AUDITOR_REPORT.split('\n')).toHaveLength(5);
    expect(AUDITOR_REPORT).toContain('(재현불가 0건)');
    expect(AUDITOR_REPORT).toContain('canonicalModel null');
  });

  it('the fixture still reaches the failure region (RED condition pinned)', () => {
    // The pre-fix reader had exactly one bare strategy: parse the WHOLE trimmed
    // string. Measured against the real pre-fix module extracted from commit
    // 5b9dad97 (verified to contain zero occurrences of `keepBareLine`), this
    // fixture returned `no_claim_audit` at 17:32:22Z.
    //
    // That module is gone, so what is pinned here is the CONDITION that made it
    // fail: the report is not itself one JSON document, and the block is not on
    // the first line. If someone later "tidies" the fixture into a bare JSON
    // string, these go red rather than letting the suite pass on an input that
    // no longer exercises the line scanner at all.
    expect(() => JSON.parse(AUDITOR_REPORT.trim())).toThrow();
    expect(AUDITOR_REPORT.trim().startsWith('{')).toBe(false);
    expect(AUDITOR_REPORT).not.toContain('```');
    expect(AUDITOR_REPORT.split('\n').indexOf(BARE_LINE)).toBe(2);
  });

  it('reads the real auditor report that returned no_claim_audit', () => {
    const res = parseClaimAudit(AUDITOR_REPORT);
    expect(res.ok).toBe(true);
    expect(res.claims_total).toBe(28);
    expect(res.claims_refuted).toBe(2);
    expect(res.subject_agent_type).toBe('backend-developer');
    expect(res.subject_model).toBeNull();
    expect(res.nature).toBeNull();
    expect(res.evidence_refs).toHaveLength(7);
    expect(res.evidence_refs[0])
      .toBe('plugins/artibot/README.md#에이전트 시스템/orchestrator 행 (L1246, 02:20 기준)');
    expect(res.evidence_refs[6]).toBe('tests/core/model-policy-allowed-tiers.test.js#denied');
  });

  it('reads a bare line that is indented', () => {
    const res = parseClaimAudit(`앞 문장\n\n   ${JSON.stringify(doc())}   \n\n뒤 문장`);
    expect(res.ok).toBe(true);
    expect(res.claims_total).toBe(12);
  });

  it('agrees with itself when the same block appears bare AND fenced', () => {
    const text = `${JSON.stringify(doc())}\n\n요약\n\n${fenced(doc())}`;
    const res = parseClaimAudit(text);
    expect(res.ok).toBe(true);
    expect(res.claims_total).toBe(12);
  });

  it('escalates when the bare line and the fenced block disagree', () => {
    const text = `${JSON.stringify(doc({ claims_refuted: 0 }))}\n\n${
      fenced(doc({ claims_refuted: 7 }))}`;
    const res = parseClaimAudit(text);
    expect(res.ok).toBe(false);
    expect(codes(res)).toEqual(['ambiguous_claim_audit']);
    expect(res.claims_refuted).toBeNull();
  });

  it('escalates when two bare lines disagree', () => {
    const text = `${JSON.stringify(doc({ claims_total: 4 }))}\n${
      JSON.stringify(doc({ claims_total: 9 }))}`;
    expect(codes(parseClaimAudit(text))).toEqual(['ambiguous_claim_audit']);
  });

  it('does NOT read a document embedded mid-line (negative control)', () => {
    // The rule is deliberately "the whole line is the object". Anything looser
    // would start hunting for braces inside prose, and a sentence that merely
    // QUOTES a claim_audit block would become a measurement.
    const text = `집계는 ${JSON.stringify(doc())} 였다.`;
    const res = parseClaimAudit(text);
    expect(res.ok).toBe(false);
    expect(codes(res)).toEqual(['no_claim_audit']);
  });

  it('does NOT read a multi-line bare object among prose (negative control)', () => {
    // One-line rule only. A pretty-printed object among prose stays unread and
    // fails closed rather than being reassembled by guesswork.
    const text = `앞 문장\n\n${JSON.stringify(doc(), null, 2)}\n\n뒤 문장`;
    expect(codes(parseClaimAudit(text))).toEqual(['no_claim_audit']);
  });

  it('does not treat a bare line inside a fence as a second document', () => {
    // The line scanner must respect fence state, or every fenced one-liner
    // would be counted twice and a legitimate single block could look like two.
    const text = `\`\`\`json\n${JSON.stringify(doc())}\n\`\`\``;
    const res = parseClaimAudit(text);
    expect(res.ok).toBe(true);
    expect(res.claims_total).toBe(12);
  });

  it('ignores a bare line that is not an object', () => {
    expect(codes(parseClaimAudit('앞\n\n{ broken json }\n\n뒤'))).toEqual(['no_claim_audit']);
    expect(codes(parseClaimAudit('앞\n\n[1,2,3]\n\n뒤'))).toEqual(['no_claim_audit']);
  });

  it('does not throw on prose braces that are not JSON (negative control)', () => {
    // A line can open and close with a brace and still be a sentence. The
    // parser must REFUSE it, not crash: an exception escaping here would take
    // down the caller that was only trying to record a measurement.
    for (const line of ['결과는 {claims_total: 28} 였다', '{claims_total: 28}',
      '{"claim_audit": 텍스트}', '{"claim_audit"}', '{,}']) {
      const text = `앞 문장\n\n${line}\n\n뒤 문장`;
      let res;
      expect(() => { res = parseClaimAudit(text); }).not.toThrow();
      expect(codes(res), line).toEqual(['no_claim_audit']);
    }
  });

  it('does not read a claim_audit split across two lines (negative control)', () => {
    // The one-line rule's exact boundary. Line 1 opens but does not close, line
    // 2 closes but does not open, so neither is a document and nothing is
    // reassembled. It fails closed, and that is the intended edge.
    const text = ['앞 문장', '', '{"claim_audit": {',
      '"subject_agent_type": "auditor", "claims_total": 5, "claims_refuted": 1}}',
      '', '뒤 문장'].join('\n');
    let res;
    expect(() => { res = parseClaimAudit(text); }).not.toThrow();
    expect(res.ok).toBe(false);
    expect(codes(res)).toEqual(['no_claim_audit']);
  });

  it('escalates the reviewer-reproduced bare-then-fence case, 1 vs 9', () => {
    // Cross-check finding (code-reviewer, 02:22): before the line scanner the
    // bare line failed the whole-string parse and was DISCARDED, so the fenced
    // 9 was adopted as ok:true — a first-wins read of two disagreeing reports.
    // Pinned with no blank line between them, which is how it was reproduced.
    const text = '{"claim_audit": {"subject_agent_type": "auditor", "claims_total": 20, '
      + '"claims_refuted": 1}}\n'
      + '```json\n{"claim_audit": {"subject_agent_type": "auditor", "claims_total": 20, '
      + '"claims_refuted": 9}}\n```';
    const res = parseClaimAudit(text);
    expect(res.ok).toBe(false);
    expect(codes(res)).toEqual(['ambiguous_claim_audit']);
    expect(res.claims_refuted).toBeNull();
  });

  it('ignores a bare line with no claim_audit key', () => {
    const text = `앞\n\n${JSON.stringify({ verdict: 'PASS' })}\n\n뒤`;
    expect(codes(parseClaimAudit(text))).toEqual(['no_claim_audit']);
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

  it('rejects evidence_refs whose entries are not strings', () => {
    // Cross-check finding (code-reviewer, 02:22). The allowlist declares only
    // `type: array`, so the writer would accept `[1, null, {}]` and the ledger
    // would carry refs nothing can follow. Checking the entries here cannot
    // conflict with the writer: it only refuses a subset of what array allows.
    const res = parseClaimAudit(doc({ evidence_refs: [1, null, {}] }));
    expect(res.ok).toBe(false);
    expect(codes(res)).toEqual(['invalid_field']);
    expect(paths(res)).toEqual(['evidence_refs']);
  });

  it('rejects a single bad entry among good ones', () => {
    expect(parseClaimAudit(doc({ evidence_refs: ['lib/a.js#f', 7] })).ok).toBe(false);
  });

  it('accepts an empty evidence_refs array', () => {
    expect(parseClaimAudit(doc({ evidence_refs: [] })).ok).toBe(true);
  });

  it('accepts entries with spaces, parentheses and non-ASCII', () => {
    // The real report's refs look like this. A stricter shape check here would
    // reject the artifact that motivated the whole field.
    const refs = ['plugins/artibot/README.md#에이전트 시스템/orchestrator 행 (L1246, 02:20 기준)'];
    expect(parseClaimAudit(doc({ evidence_refs: refs })).evidence_refs).toEqual(refs);
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
