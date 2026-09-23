/**
 * Unit contract for the §34 Final Mission Scorecard fold.
 *
 * ── WHAT THIS SUITE CANNOT SEE (repo rules §9) ──────────────────────────────
 *   - ZERO LIVE LEDGER LINES, AND ZERO LIVE OUTCOME ARTIFACTS. Every fixture is
 *     built here through `buildEnvelope`, and `outcome_present` is asserted by
 *     this file rather than by a real file on disk. The kill switch ships false
 *     (`runtime.artifactLifecycle.enabled`), so live `outcome.md` creation is 0
 *     and a live render of this card is therefore also 0 — which is the correct
 *     state, not a defect. A green suite says the arithmetic is right about
 *     invented data; it says nothing about SH-20 being done.
 *   - WHETHER THE CALLER'S EXISTENCE CHECK IS RIGHT. The refusal below proves
 *     the module refuses without the positive assertion. It cannot prove that
 *     whoever passes `true` actually looked at
 *     `.artibot/missions/<id>/outcome.md`; nothing in this repo executes a
 *     command body, so the `/scorecard --mission` snippet is unexecuted here.
 *   - FIXTURE SCALE ≠ LIVE SCALE. The largest fixture is a dozen lines.
 *   - WHETHER THE METRIC SET IS THE RIGHT ONE. The suite pins what each row
 *     computes and where its denominator comes from. That §34 wanted these
 *     seventeen rows rather than some other set is argued in the module header
 *     and asserted nowhere — absence of a metric has no mechanical signature.
 *
 * @module tests/scorecard/mission-scorecard
 */

import { describe, expect, it } from 'vitest';
import { buildReplay } from '../../lib/replay/index.js';
import { buildEnvelope } from '../../lib/runtime/event-writer.js';
import {
  buildMissionScorecard,
  METRIC_STATE,
  MISSION_KIND,
  OUTCOME_PRESENT_ASSERTION,
  renderScorecardMarkdown,
  UNMEASURED_TEXT,
} from '../../lib/scorecard/index.js';

const MISSION = 'M-20260921-201';
const OTHER_MISSION = 'M-20260921-202';
const SID = 'sess-ms-0001';
const OTHER_SID = 'sess-ms-0002';

/** The caller's positive assertion that this mission's outcome.md exists. */
const PRESENT = { mission_id: MISSION, outcome_present: OUTCOME_PRESENT_ASSERTION };

/**
 * One well-formed ledger line with fully controlled ordering terms.
 *
 * `ts`, `pid` and `seq` are always explicit: a fixture leaning on the real
 * clock or the real pid cannot make a claim about ordering.
 *
 * @param {object} fields - envelope fields; `event` at minimum.
 * @param {number} seq - ordering term; also drives the timestamp.
 * @returns {object} envelope.
 */
function line(fields, seq) {
  const ts = `2026-09-21T20:00:${String(seq).padStart(2, '0')}.000Z`;
  return buildEnvelope(
    { session_id: SID, source: 'hook', mission_id: MISSION, ts, ...fields },
    { pid: 200, seq },
  );
}

/**
 * A complete-enough mission: two sessions, two route receipts, two usage
 * receipts across two tiers, a retry, a review pair, a verification, an
 * asked/resolved pair, a context receipt, a completion line — plus one line of
 * a DIFFERENT mission so scoping has something to exclude.
 *
 * @returns {object[]} ledger lines in emission order.
 */
function seed() {
  return [
    line({ event: 'mission.created', data: { title: 'T', intent_revision: 1 } }, 0),
    line({
      event: 'route.selected',
      source: 'scheduler',
      action_id: 'act-1',
      routing_epoch_id: 'ep-1',
      data: { decision: { type: 'route' }, models: { selected: { tier: 'opus' } } },
    }, 1),
    line({
      event: 'route.selected',
      source: 'scheduler',
      action_id: 'act-2',
      routing_epoch_id: 'ep-1',
      data: { decision: { type: 'pin' }, models: { selected: { tier: 'fable' } } },
    }, 2),
    line({
      event: 'usage.receipt',
      source: 'worker',
      action_id: 'act-1',
      model: 'claude-opus-5',
      data: { model_identity: { tier: 'opus' } },
    }, 3),
    line({
      event: 'usage.receipt',
      source: 'worker',
      action_id: 'act-2',
      model: 'claude-fable-5-1',
      data: { model_identity: { tier: 'fable' } },
    }, 4),
    line({ event: 'retry.scheduled', action_id: 'act-1', data: { attempt: 2, reason: 'x' } }, 5),
    line({ event: 'review.requested', action_id: 'act-1', data: { scope: 'diff' } }, 6),
    line({
      event: 'review.completed',
      source: 'reviewer',
      action_id: 'act-1',
      model: 'claude-fable-5-1',
      data: { verdict: 'PASS', findings_ref: 'review.md#1' },
    }, 7),
    line({
      event: 'verify.completed',
      source: 'gate',
      action_id: 'act-1',
      data: { result: 'pass', evidence: ['npx vitest run'] },
    }, 8),
    line({ event: 'human.asked', action_id: 'act-1', data: { question_id: 'q1' } }, 9),
    line({
      event: 'human.resolved',
      source: 'human',
      action_id: 'act-1',
      data: { question_id: 'q1', decision: 'go' },
    }, 10),
    line({
      event: 'context.compiled',
      source: 'worker',
      action_id: 'act-2',
      data: { context_receipt_id: 'cr-1' },
    }, 11),
    line({
      event: 'mission.completed',
      source: 'hook',
      data: { accepted: null, evidence_refs: ['outcome.md'] },
    }, 12),
    // A SECOND session of the SAME mission — a mission may span sessions (§32).
    buildEnvelope(
      {
        session_id: OTHER_SID,
        source: 'hook',
        mission_id: MISSION,
        ts: '2026-09-21T20:00:13.000Z',
        event: 'tool.used',
        action_id: 'act-3',
        data: { tool: 'Read', ok: true, duration_ms: 1 },
      },
      { pid: 200, seq: 13 },
    ),
    // A DIFFERENT mission. Everything scoped must exclude it.
    buildEnvelope(
      {
        session_id: SID,
        source: 'worker',
        mission_id: OTHER_MISSION,
        ts: '2026-09-21T20:00:14.000Z',
        event: 'usage.receipt',
        action_id: 'act-9',
        model: 'claude-opus-5',
        data: { model_identity: { tier: 'opus' } },
      },
      { pid: 200, seq: 14 },
    ),
  ];
}

/** A deterministic permutation — no randomness, so a failure reproduces. */
function shuffled(events) {
  const out = [...events];
  for (let i = 0; i < out.length; i += 1) {
    const j = (i * 7 + 3) % out.length;
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Find one metric by key, failing loudly rather than returning undefined.
 *
 * @param {object} card - a scorecard.
 * @param {string} key - metric key.
 * @returns {object} the metric.
 */
function pick(card, key) {
  const found = card.metrics.find((m) => m.key === key);
  expect(found, `metric ${key} 없음. 있는 키: ${card.metrics.map((m) => m.key).join(', ')}`)
    .toBeTruthy();
  return found;
}

const replay = buildReplay(seed());
const card = buildMissionScorecard(replay, PRESENT);
const emptyCard = buildMissionScorecard(buildReplay([]), PRESENT);

// ---------------------------------------------------------------------------
describe('buildMissionScorecard — outcome.md 없으면 카드도 없다', () => {
  it('outcome_present 를 빼면 던진다 (없는 플래그가 통과가 되지 않는다)', () => {
    expect(() => buildMissionScorecard(replay, { mission_id: MISSION }))
      .toThrow(/outcome_present === true/);
  });

  it('false 면 던진다', () => {
    expect(() => buildMissionScorecard(replay, { mission_id: MISSION, outcome_present: false }))
      .toThrow(/outcome_present === true/);
  });

  it.each([['1', 1], ["'true'", 'true'], ['{}', {}]])(
    'truthy 이지만 true 가 아닌 %s 도 던진다 — 양성 단언이지 truthy 검사가 아니다',
    (_label, value) => {
      expect(() => buildMissionScorecard(replay, { mission_id: MISSION, outcome_present: value }))
        .toThrow(/outcome_present === true/);
    },
  );

  it('mission_id 없이 부르면 던진다 (전 미션을 한 미션인 척 접지 않는다)', () => {
    expect(() => buildMissionScorecard(replay, { outcome_present: true }))
      .toThrow(/opts\.mission_id/);
  });

  it('replay 인덱스가 아니면 던진다', () => {
    expect(() => buildMissionScorecard({ actions: 'nope' }, PRESENT))
      .toThrow(/lib\/replay index/);
  });

  it('통과하면 scope 에 미션과 outcome 단언이 함께 남는다', () => {
    expect(card.kind).toBe(MISSION_KIND);
    expect(card.scope).toEqual({ mission_id: MISSION, outcome: 'present' });
  });
});

// ---------------------------------------------------------------------------
describe('buildMissionScorecard — 미션 범위', () => {
  it('다른 미션 줄은 분모에 들어오지 않는다', () => {
    const tiers = pick(card, 'mission.model_tiers');
    // 픽스처의 usage.receipt 는 3건이지만 1건은 다른 미션이다.
    expect(tiers.denominator).toBe(2);
    expect(tiers.counts).toEqual({ fable: 1, opus: 1 });
  });

  it('한 미션이 여러 세션을 가진다 (§32) — Session 별 Action 행이 그것을 보여준다', () => {
    const sessions = pick(card, 'mission.sessions');
    expect(Object.keys(sessions.counts).sort()).toEqual([SID, OTHER_SID].sort());
    expect(sessions.denominator).toBe(sessions.denominator && Object.values(sessions.counts)
      .reduce((a, b) => a + b, 0));
  });

  it('Route Decisions 는 미션 한정 route.selected 다', () => {
    expect(pick(card, 'mission.route_decisions').numerator).toBe(2);
  });

  it('Observe 기대대로 스위치는 0 이고, 분모가 있으므로 측정된 0 이다', () => {
    const m = pick(card, 'mission.switches');
    expect(m.numerator).toBe(0);
    expect(m.denominator).toBe(2);
    expect(m.state).toBe(METRIC_STATE.MEASURED);
    expect(m.ratio).toBe(0);
  });

  it('Attempts 와 Retries 가 §34 대로 각각 센다', () => {
    expect(pick(card, 'mission.attempts').numerator).toBe(2);
    expect(pick(card, 'mission.retries').numerator).toBe(1);
  });

  it('Review 도달률은 completed ÷ requested 다', () => {
    const m = pick(card, 'mission.review_reach');
    expect([m.numerator, m.denominator]).toEqual([1, 1]);
    expect(m.ratio).toBe(1);
  });

  it('Verification 은 판정이 아니라 기록 건수다', () => {
    expect(pick(card, 'mission.verifications').numerator).toBe(1);
  });

  it('Human 도달률은 resolved ÷ asked 다', () => {
    const m = pick(card, 'mission.human_reach');
    expect([m.numerator, m.denominator]).toEqual([1, 1]);
  });

  it('Context 행은 영수증 건수이지 토큰 산술이 아니다', () => {
    expect(pick(card, 'mission.context_receipts').numerator).toBe(1);
  });

  it('완료 선언 분모는 색인된 미션 수(1)다', () => {
    const m = pick(card, 'mission.completion');
    expect(m.denominator).toBe(1);
    expect(m.numerator).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('못 재는 행은 0% 가 아니라 영구 unmeasured 다', () => {
  it.each([
    ['mission.result'],
    ['mission.duration'],
    ['mission.switch_quality'],
    ['mission.economics'],
    ['mission.success_at_1'],
  ])('%s 는 분모 0 · ratio null · unmeasured 다', (key) => {
    const m = pick(card, key);
    expect(m.denominator).toBe(0);
    expect(m.ratio).toBeNull();
    expect(m.state).toBe(METRIC_STATE.UNMEASURED);
  });

  it('다섯 행이 카드에서 빠지지 않는다 — 부재가 "해당 없음"으로 읽히면 안 된다', () => {
    for (const key of ['mission.result', 'mission.duration', 'mission.switch_quality',
      'mission.economics', 'mission.success_at_1']) {
      expect(card.unmeasured).toContain(key);
    }
  });

  it('measured 한 행이 하나라도 있어야 이 절이 공허하지 않다 (자기검증)', () => {
    expect(card.totals.measured).toBeGreaterThan(0);
    expect(card.totals.metrics).toBe(card.totals.measured + card.totals.unmeasured);
  });

  it('빈 원장이면 전 지표가 unmeasured 이고 그것이 정상 출력이다', () => {
    expect(emptyCard.unmeasured.length).toBe(emptyCard.metrics.length);
    expect(emptyCard.totals.measured).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('렌더 · 결정성', () => {
  it('kind 가 렌더러에 등록돼 MISSION SCORECARD 제목이 선다', () => {
    expect(renderScorecardMarkdown(card).split('\n')[0]).toBe('# ARTIBOT · MISSION SCORECARD');
  });

  it('등록되지 않은 kind 는 여전히 던진다 (등록이 allowlist 를 넓히지 않았다)', () => {
    expect(() => renderScorecardMarkdown({ kind: 'nope', metrics: [], unmeasured: [] }))
      .toThrow(/unknown card kind/);
  });

  it('분모 0 인 행은 unmeasured 로 쓰고 퍼센트 수치를 찍지 않는다', () => {
    const md = renderScorecardMarkdown(emptyCard);
    expect(md).toContain(UNMEASURED_TEXT);
    expect(md).not.toMatch(/\|\s*0\.0%\s*\|/);
  });

  it('입력 순서를 바꿔도 같은 카드가 나온다', () => {
    const other = buildMissionScorecard(buildReplay(shuffled(seed())), PRESENT);
    expect(JSON.stringify(other)).toBe(JSON.stringify(card));
  });

  it('같은 카드를 두 번 렌더하면 바이트가 같다', () => {
    expect(renderScorecardMarkdown(card)).toBe(renderScorecardMarkdown(card));
  });

  it('카드는 얼어 있다 — 소비자가 지표를 덧칠할 수 없다', () => {
    expect(Object.isFrozen(card)).toBe(true);
    expect(Object.isFrozen(card.metrics)).toBe(true);
    expect(() => { card.metrics[0].numerator = 99; }).toThrow();
  });

  it('입력을 변형하지 않는다', () => {
    const events = seed();
    const before = JSON.stringify(events);
    buildMissionScorecard(buildReplay(events), PRESENT);
    expect(JSON.stringify(events)).toBe(before);
  });
});
