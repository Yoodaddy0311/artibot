/**
 * Firewall gate — `/save` step 8 actually RENDERS the session scorecard, and it
 * renders it where the reader will not mistake it for the handoff.
 *
 * WHY THIS GATE EXISTS. Step 8 of the §31 order was, until this limb, a
 * placeholder: `commands/save.md` reserved the slot with the words "이 줄기
 * 밖이다" and named no symbol. `tests/firewall/save-checkpoint-order.test.js`
 * was — correctly — satisfied by that placeholder, because it pins the ORDER of
 * eight bold tokens and a token is a token whether it introduces a render
 * instruction or an IOU. So the sibling gate can never go red on a step 8 that
 * quietly stays unimplemented. That blind spot is this file's subject.
 *
 * WHAT IS PINNED, AND WHY EACH ONE.
 *
 *   - THE TWO SYMBOLS, INSIDE STEP 8'S OWN PARAGRAPH. `buildSessionScorecard`
 *     and `renderScorecardMarkdown` are the entire executable content of the
 *     step; prose that names neither is prose that tells the next session
 *     nothing it could act on. The paragraph is sliced from the bold token to
 *     the next blank line so a mention anywhere else in a 240-line command — in
 *     Anti-Patterns, in an edge case row — cannot stand in for the instruction.
 *   - THE CARD SECTION COMES AFTER THE RESULT TABLE. `## 세션 스코어카드` must
 *     appear inside the Output Format fence and AFTER `## 저장 결과`. The
 *     ordering is the point: `/save` exists to save a handoff, and a card that
 *     printed above the save result would make the run's headline the metrics
 *     rather than the file that was written. String indices, so a reordering
 *     edit has to come through this line.
 *   - THE HANDOFF STAYS BYTE-IDENTICAL. `renderHandoffMarkdown`'s output is
 *     unchanged by this limb, and the prose has to keep saying so. A future
 *     edit that "helpfully" folds the card into the handoff body would break
 *     `lib/handoff` output contracts that live in another directory's tests and
 *     would be invisible to every assertion above.
 *
 * SELF-VERIFICATION. `auditScorecardRender` is a pure function over a string
 * returning `{ pass, reasons }`, and the live assertions and the `the audit
 * itself` block call that same function. The negative cases are built by
 * mutating an IN-MEMORY COPY of the markdown — the file on disk is never
 * touched. One of them restores the pre-limb placeholder sentence verbatim, so
 * this gate is proven to have been red before the edit that made it green.
 *
 * ── WHAT THIS GATE CANNOT SEE (rules §9) ───────────────────────────────────
 *   - EXECUTION. Nothing here runs `/save`. That an implementation reads the
 *     ledger, builds a replay index, calls `buildSessionScorecard` and prints
 *     the result is UNMEASURED by this file and by every other file in this
 *     limb — the limb changed prose and tests only. A green here is compatible
 *     with the card never being printed.
 *   - THE CARD'S CONTENT. `renderScorecardMarkdown` owns the bytes; the example
 *     table in the Output Format fence is a placeholder skeleton, and this gate
 *     does not compare it to real renderer output. If the renderer grows a
 *     column, the example goes stale and nothing here notices.
 *   - THE PORT CHAIN'S TRUTH. The prose names
 *     `readAllEvents` → `loadReplay` → `buildSessionScorecard`. This file
 *     checks that the last two are NAMED, not that the chain is wired, not that
 *     `loadReplay` still throws without its `readEvents` port.
 *   - THE GATE. Step 8 sits inside Phase A½, which `runtime.checkpoint.saveOnSave`
 *     switches off; today it is `false`. The canary pin belongs to
 *     `save-checkpoint-order.test.js` and is not duplicated here — two files
 *     pinning one config value is two files to edit on the flip.
 *   - LINE NUMBERS. Citations of the form `file.js:NN` in the edited section are
 *     the repo-wide citation ratchet's subject, not this file's.
 *
 * @module tests/firewall/save-scorecard-render
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/** Normalised to LF: `commands/save.md` is CRLF on disk and every slice below is index-based. */
const SAVE_MD = readFileSync(new URL('../../commands/save.md', import.meta.url), 'utf-8').replace(/\r\n/g, '\n');

/** Heading of the section `commands/save.md` devotes to the §31 order. */
const PHASE_HEADING = '### Phase A½: 체크포인트';

/** The bold token that opens step 8, pinned identically by the sibling order gate. */
const STEP_EIGHT_TOKEN = '**Snapshot Scorecard**';

/** The two symbols step 8 has to name to be an instruction rather than a slot. */
const STEP_EIGHT_SYMBOLS = ['buildSessionScorecard', 'renderScorecardMarkdown'];

/** Heading of the Output Format section, whose fenced block is the rendered shape. */
const OUTPUT_HEADING = '## Output Format';

/** The `/save` result table, printed first because saving the handoff is the job. */
const RESULT_SECTION = '## 저장 결과';

/** The new card section, printed after it. */
const CARD_SECTION = '## 세션 스코어카드';

/** The invariance the limb must not lose: the handoff body is unchanged. */
const INVARIANCE_SYMBOL = 'renderHandoffMarkdown';
const INVARIANCE_PHRASE = '출력 바이트는 불변';
const OUT_OF_BODY_PHRASE = 'HANDOFF 본문에 넣지 않는다';

/**
 * The Phase A½ section only: from its heading to the next `###`.
 *
 * @param {string} text - Full markdown of `commands/save.md`, or a synthetic one.
 * @returns {string|null} The section body, or null when the heading is absent.
 */
function slicePhaseSection(text) {
  const start = text.indexOf(PHASE_HEADING);
  if (start === -1) return null;
  const rest = text.slice(start + PHASE_HEADING.length);
  const end = rest.indexOf('\n### ');
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * Step 8's own paragraph: from its bold token to the next blank line, inside the
 * Phase A½ section. Deliberately narrow — a symbol named elsewhere in the file
 * must not be able to satisfy the step.
 *
 * @param {string} text - Markdown to slice.
 * @returns {string|null} The paragraph, or null when step 8 is absent.
 */
function sliceStepEight(text) {
  const section = slicePhaseSection(text);
  if (section === null) return null;
  const start = section.indexOf(STEP_EIGHT_TOKEN);
  if (start === -1) return null;
  const rest = section.slice(start);
  const end = rest.indexOf('\n\n');
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * The fenced block under `## Output Format`, which is what `/save` prints.
 *
 * @param {string} text - Markdown to slice.
 * @returns {string|null} The fence body, or null when it is absent.
 */
function sliceOutputFence(text) {
  const headingAt = text.indexOf(OUTPUT_HEADING);
  if (headingAt === -1) return null;
  const rest = text.slice(headingAt);
  const open = rest.indexOf('```');
  if (open === -1) return null;
  const body = rest.slice(open + 3);
  const close = body.indexOf('```');
  return close === -1 ? null : body.slice(0, close);
}

/**
 * Audit `commands/save.md` for the step 8 render contract.
 *
 * @param {string} text - Markdown to audit.
 * @returns {{pass: boolean, reasons: string[], marks: object}} Verdict plus the
 *   raw positions the ordering reason was derived from.
 */
function auditScorecardRender(text) {
  const reasons = [];
  const marks = { resultAt: -1, cardAt: -1 };

  const stepEight = sliceStepEight(text);
  if (stepEight === null) {
    reasons.push(`step 8 paragraph absent: ${STEP_EIGHT_TOKEN} inside ${PHASE_HEADING}`);
  } else {
    for (const symbol of STEP_EIGHT_SYMBOLS) {
      if (!stepEight.includes(symbol)) {
        reasons.push(`step 8 names no render path: ${symbol} absent from the ${STEP_EIGHT_TOKEN} paragraph`);
      }
    }
  }

  const fence = sliceOutputFence(text);
  if (fence === null) {
    reasons.push(`Output Format fenced block absent under ${OUTPUT_HEADING}`);
  } else {
    marks.resultAt = fence.indexOf(RESULT_SECTION);
    marks.cardAt = fence.indexOf(CARD_SECTION);
    if (marks.resultAt === -1) reasons.push(`result table absent from the output fence: ${RESULT_SECTION}`);
    if (marks.cardAt === -1) {
      reasons.push(`card section absent from the output fence: ${CARD_SECTION}`);
    } else if (marks.resultAt !== -1 && marks.cardAt < marks.resultAt) {
      reasons.push(
        `${CARD_SECTION} at ${marks.cardAt} must follow ${RESULT_SECTION} at ${marks.resultAt}: `
        + 'saving the handoff is the headline, the card is the elaboration',
      );
    }
  }

  if (!text.includes(INVARIANCE_SYMBOL) || !text.includes(INVARIANCE_PHRASE)) {
    reasons.push(`handoff invariance sentence lost: ${INVARIANCE_SYMBOL} … ${INVARIANCE_PHRASE}`);
  }
  if (!text.includes(OUT_OF_BODY_PHRASE)) {
    reasons.push(`prose no longer says the results stay out of the handoff body: ${OUT_OF_BODY_PHRASE}`);
  }

  return { pass: reasons.length === 0, reasons, marks };
}

/** The placeholder step 8 carried before this limb, verbatim from the pre-edit file. */
const PLACEHOLDER_STEP_EIGHT = `${STEP_EIGHT_TOKEN} — 이 줄기 밖이다 (OB-19, 별도 줄기). 순서상 자리만 확정해 둔다.`;

describe('commands/save.md step 8 renders the session scorecard', () => {
  it('names both scorecard symbols inside the Snapshot Scorecard paragraph', () => {
    const audit = auditScorecardRender(SAVE_MD);
    expect(audit.reasons).toEqual([]);
    expect(audit.pass).toBe(true);
  });

  it('keeps the two symbols in step 8 itself, not merely somewhere in the command', () => {
    const stepEight = sliceStepEight(SAVE_MD);
    expect(stepEight).not.toBeNull();
    expect(stepEight).toContain('buildSessionScorecard');
    expect(stepEight).toContain('renderScorecardMarkdown');
  });

  it('prints the card section after the save-result table inside the output fence', () => {
    const { marks } = auditScorecardRender(SAVE_MD);
    expect(marks.resultAt).toBeGreaterThan(-1);
    expect(marks.cardAt).toBeGreaterThan(marks.resultAt);
  });

  it('still declares the handoff body byte-identical and the results out of it', () => {
    expect(SAVE_MD).toContain(INVARIANCE_SYMBOL);
    expect(SAVE_MD).toContain(INVARIANCE_PHRASE);
    expect(SAVE_MD).toContain(OUT_OF_BODY_PHRASE);
  });
});

describe('the audit itself', () => {
  it('goes red on the pre-limb placeholder step 8, so this gate was red before it was green', () => {
    const stepEight = sliceStepEight(SAVE_MD);
    const reverted = SAVE_MD.replace(stepEight, PLACEHOLDER_STEP_EIGHT);
    expect(reverted).not.toBe(SAVE_MD);
    const bad = auditScorecardRender(reverted);
    expect(bad.pass).toBe(false);
    expect(bad.reasons.join(' | ')).toContain('step 8 names no render path: buildSessionScorecard');
    expect(bad.reasons.join(' | ')).toContain('renderScorecardMarkdown');
  });

  it('goes red when step 8 is deleted outright', () => {
    const stepEight = sliceStepEight(SAVE_MD);
    const deleted = SAVE_MD.replace(stepEight, '');
    const bad = auditScorecardRender(deleted);
    expect(bad.pass).toBe(false);
    expect(bad.reasons.join(' | ')).toContain('step 8 paragraph absent');
  });

  it('goes red when the symbols move out of step 8 into the rest of the command', () => {
    const stepEight = sliceStepEight(SAVE_MD);
    const moved = SAVE_MD.replace(stepEight, `${STEP_EIGHT_TOKEN} — 세션 카드를 인쇄한다.`);
    const bad = auditScorecardRender(moved);
    expect(bad.pass).toBe(false);
    expect(bad.reasons.join(' | ')).toContain('absent from the **Snapshot Scorecard** paragraph');
  });

  it('goes red when the card section is printed above the save-result table', () => {
    const swapped = SAVE_MD
      .replace(`${RESULT_SECTION}\n`, '@@RESULT@@\n')
      .replace(`${CARD_SECTION}\n`, `${RESULT_SECTION}\n`)
      .replace('@@RESULT@@\n', `${CARD_SECTION}\n`);
    const bad = auditScorecardRender(swapped);
    expect(bad.pass).toBe(false);
    expect(bad.reasons.join(' | ')).toContain('must follow');
  });

  it('goes red when the card section is dropped from the output fence', () => {
    const dropped = SAVE_MD.replace(`${CARD_SECTION}\n`, '## 무언가 다른 절\n');
    const bad = auditScorecardRender(dropped);
    expect(bad.pass).toBe(false);
    expect(bad.reasons.join(' | ')).toContain('card section absent from the output fence');
  });

  it('goes red when the handoff invariance sentence is lost', () => {
    const lost = SAVE_MD.split(INVARIANCE_PHRASE).join('출력은 달라질 수 있고');
    const bad = auditScorecardRender(lost);
    expect(bad.pass).toBe(false);
    expect(bad.reasons.join(' | ')).toContain('handoff invariance sentence lost');
  });

  it('goes red when the prose stops keeping the results out of the handoff body', () => {
    const folded = SAVE_MD.split(OUT_OF_BODY_PHRASE).join('HANDOFF 본문에 함께 넣는다');
    const bad = auditScorecardRender(folded);
    expect(bad.pass).toBe(false);
    expect(bad.reasons.join(' | ')).toContain('out of the handoff body');
  });

  it('goes red on markdown with no Phase A½ section at all', () => {
    const bad = auditScorecardRender('# save\n\nnothing here\n');
    expect(bad.pass).toBe(false);
    expect(bad.reasons.join(' | ')).toContain('step 8 paragraph absent');
  });
});
