/**
 * Mission Scorecard — the FINAL card of MODEL-SWITCHING-SCORECARD.md §34,
 * folded from the ledger and nothing else.
 *
 * WHAT THIS IS
 * ---------------------------------------------------------------------------
 * §54 "Scorecard Levels" lists four levels; this is the third, "Final Mission
 * Scorecard — Mission accepted." §32 is explicit that "Session Scorecard ≠
 * Mission Scorecard", so this is a sibling of `session-scorecard.js` rather
 * than a wider call of it: the scope key is `mission_id`, and one mission may
 * span several sessions exactly as one session may touch several missions.
 *
 * WHY IT REFUSES WITHOUT AN OUTCOME ARTIFACT
 * ---------------------------------------------------------------------------
 * Design §32~§35 settles the trigger: "Final Scorecard 는 `outcome.md` 생성과
 * 같은 트리거(§3.4)에서 렌더 — 파일이 없으면 스코어카드도 없다." A mission with
 * no `outcome.md` is not a finished mission, and a final card drawn for one
 * would be a completion claim with no artifact behind it.
 *
 * This module cannot look for the file: `lib/scorecard/` is L2-pure and holds
 * no filesystem reference (index.js header, and the purity scan in
 * `tests/scorecard/scorecard.test.js`). So the CALLER checks, and hands the
 * answer in as `opts.outcome_present`. The check is a POSITIVE assertion —
 * only the literal `true` is accepted. A caller that forgets the option, or
 * passes something truthy-but-not-true, is refused rather than served, because
 * the fail-open shape here ("no flag means fine") would draw a final card for
 * every unfinished mission in the ledger.
 *
 * PURE. Input is a `lib/replay` index. No filesystem, no clock, no randomness,
 * and nothing here writes anything — the card is regenerable, exactly like the
 * replay index it reads (design §8.3-2, "정본은 ledger.jsonl 하나", and §36
 * "Scorecard 는 Receipt 들의 투영 … 삭제/재생성 가능").
 *
 * ── WHAT THIS CARD CANNOT SEE (repo rule §9: write it next to the gate) ──────
 *  1. WHETHER THE MISSION WAS ACCEPTED. `mission.completed` carries a
 *     three-valued `accepted` (true/false/null), and the allowlist says the
 *     writer appends `{accepted:null}` first and only later appends a second
 *     line with the verdict. Two things stop this card from folding it: no
 *     non-null writer has been confirmed in the repo, and the replay index does
 *     not expose `mission.completed` lines as an array at all — `buildReplay`
 *     projects four event arrays (routes, switches, usage, context) and nothing
 *     else. `mission.result` therefore pins its denominator at 0 and stays
 *     permanently `unmeasured`, the same shape and for the same reason as
 *     `compare-scorecard.js#compare.score`. The row is KEPT rather than omitted
 *     so its absence cannot be read as "not applicable".
 *  2. DURATION (§34 "Duration 18m 42s"). Every ledger line carries `ts`, so the
 *     span is derivable — but only through a date parser, and this directory
 *     deliberately holds no clock reference at all so that property is
 *     greppable rather than argued. A caller holding the ordered events can
 *     compute it itself. Same ruling as `session-scorecard.js` #3.
 *  3. USEFUL / WASTEFUL SWITCHES, SWITCH EFFICIENCY, TRANSITION COST AND TIME
 *     (§34 ROUTING, §37). §37 makes these a POST-HOC judgement of a switch that
 *     already happened, and Observe expects zero switches (design §8.4 puts the
 *     Switch Controller behind Canary). Judging quality from a fold of zero
 *     events would be an opinion wearing a percentage.
 *  4. COST (§34 ECONOMICS "Total Cost", "Cost / Outcome", "Retry Waste").
 *     Summing spend here would be a second answer to the question
 *     `lib/economics/usage-receipt.js` already owns as "the ONLY writer, so the
 *     same spend is never counted twice". `mission.model_tiers` counts USAGE
 *     RECEIPTS per tier, not tokens and not money.
 *  5. THE FOUR §34 CONTEXT FIGURES (Compression, Cache Hit Ratio, Rebuilds,
 *     Churn). `context.compiled` lines ARE in scope and are counted, but the
 *     four figures are token arithmetic over `context-receipt.schema.json`,
 *     which is a different question from "how many receipts were written". This
 *     card answers the second one only, by the same rule as #4.
 *  6. SUCCESS@1 (§34 PERFORMANCE). It needs a per-attempt success verdict keyed
 *     to the attempt, and no ledger event pairs an attempt with its outcome.
 *     `mission.attempts` and `mission.retries` are counts, not a rate.
 *  7. WHETHER `outcome.md` SAYS WHAT THE CARD SAYS. The caller asserts the file
 *     EXISTS; nothing here parses it. A present-but-empty outcome artifact
 *     draws a full card. Reading the artifact is `lib/mission/outcome-artifact.js`'s
 *     job and pairing the two is nobody's yet.
 *
 * @module lib/scorecard/mission-scorecard
 */

import {
  freezeCard,
  histogramMetric,
  metric,
  readPath,
  tallyBy,
} from './metric.js';
import { mergeEventCounts } from './session-scorecard.js';

/** Card kind, used by the renderer to pick a heading. Registered in `render.js`. */
export const MISSION_KIND = 'mission';

/**
 * The value `opts.outcome_present` must carry. A constant so the test and the
 * guard cannot drift into "any truthy value".
 */
export const OUTCOME_PRESENT_ASSERTION = true;

/**
 * Build the final mission card.
 *
 * @param {object} replay - a `buildReplay` index. Read only.
 * @param {{mission_id: string, outcome_present: boolean}} opts - `mission_id`
 *   is REQUIRED for the same reason `session_id` is on the session card: an
 *   unscoped card folds every mission into one and labels it as one.
 *   `outcome_present` must be exactly `true` — the caller's positive assertion
 *   that `.artibot/missions/<id>/outcome.md` exists.
 * @returns {object} `{kind, scope, metrics, unmeasured, totals}` — every field
 *   present on every call, so a consumer never branches on `undefined`.
 * @throws {TypeError} when `replay` is not an index, `mission_id` is absent, or
 *   `outcome_present` is not the literal `true`.
 */
export function buildMissionScorecard(replay, opts = {}) {
  if (!replay || typeof replay !== 'object' || !Array.isArray(replay.actions)) {
    throw new TypeError(
      'buildMissionScorecard requires a lib/replay index — pass the result of '
      + 'buildReplay(events) or loadReplay(root, {readEvents}).',
    );
  }
  const missionId = opts.mission_id;
  if (typeof missionId !== 'string' || missionId.length === 0) {
    throw new TypeError(
      'buildMissionScorecard requires opts.mission_id — an unscoped card would '
      + 'fold every mission in the ledger into one final card and label it as '
      + 'one mission (MODEL-SWITCHING-SCORECARD.md §32: Session Scorecard ≠ '
      + 'Mission Scorecard).',
    );
  }
  if (opts.outcome_present !== OUTCOME_PRESENT_ASSERTION) {
    throw new TypeError(
      'buildMissionScorecard requires opts.outcome_present === true — the '
      + "caller's positive assertion that this mission's outcome.md exists "
      + '(design §32~§35: "Final Scorecard 는 outcome.md 생성과 같은 트리거에서 '
      + '렌더 — 파일이 없으면 스코어카드도 없다"). This module is L2-pure and '
      + 'cannot look for the file itself; see lib/mission/outcome-artifact.js'
      + '#outcomeArtifactPath. Only the literal true is accepted, so a caller '
      + 'that omits the option is refused rather than served a final card for '
      + `an unfinished mission. Got ${JSON.stringify(opts.outcome_present)}.`,
    );
  }

  const inMission = (e) => e && e.mission_id === missionId;
  const actions = replay.actions.filter(inMission);
  const missions = (replay.missions ?? []).filter((m) => m.mission_id === missionId);
  const usage = (replay.usage ?? []).filter(inMission);
  const routes = (replay.routes ?? []).filter(inMission);
  const switches = (replay.switches ?? []).filter(inMission);
  const context = (replay.context ?? []).filter(inMission);
  const { counts: eventCounts, total: lines } = mergeEventCounts(actions);
  const seen = (name) => eventCounts[name] ?? 0;

  const metrics = [
    metric({
      key: 'mission.events',
      label: '이벤트 분포',
      source: 'replay.actions[].event_counts (미션 한정)',
      denominator: lines,
      counts: eventCounts,
      note: '이 미션에 귀속된 원장 줄 전체. 아래 여러 분모의 상위 집합이다.',
    }),
    metric({
      key: 'mission.sessions',
      label: 'Session 별 Action',
      source: 'replay.actions[].session_id',
      denominator: actions.length,
      counts: tallyBy(actions, (a) => a.session_id),
      note: '한 Mission 이 여러 Session 을 가질 수 있고 그 역도 성립한다(§32). '
        + 'Session 카드의 mission 행과 축이 반대다 — 같은 수가 아니어도 모순이 아니다.',
    }),
    histogramMetric(usage, (e) => readPath(e, ['data', 'model_identity', 'tier']), {
      key: 'mission.model_tiers',
      label: '티어별 Usage Receipt',
      source: 'usage.receipt · data.model_identity.tier',
      note: '§34 MODEL USAGE 의 분모. 토큰·비용이 아니라 RECEIPT 건수다 — 지출 합산은 '
        + 'lib/economics 의 단일 답이다(헤더 #4).',
    }),
    metric({
      key: 'mission.route_decisions',
      label: 'Route Decisions',
      source: 'route.selected',
      denominator: lines,
      numerator: routes.length,
      note: '§34 ROUTING "Route Decisions". 결정 유형 분포는 라우팅 카드의 일이다 — '
        + '여기서 두 번째 답을 만들지 않는다.',
    }),
    metric({
      key: 'mission.switches',
      label: 'Model Switch (제안 대비)',
      source: 'model.switched ÷ route.selected',
      denominator: routes.length,
      numerator: switches.length,
      note: 'Observe 기대값은 0 이다 — 설계 §8.4 는 Switch Controller 실적용을 Canary 로 '
        + '둔다. 0 이 아니면 기능이 아니라 발견이다. Useful/Wasteful 판정은 헤더 #3.',
    }),
    metric({
      key: 'mission.attempts',
      label: 'Attempts',
      source: 'usage.receipt',
      denominator: lines,
      numerator: seen('usage.receipt'),
      note: '§34 PERFORMANCE "Attempts". 건수이지 성공률이 아니다(헤더 #6).',
    }),
    metric({
      key: 'mission.retries',
      label: 'Retries',
      source: 'retry.scheduled',
      denominator: lines,
      numerator: seen('retry.scheduled'),
      note: '§34 PERFORMANCE "Retries". Retry Waste(금액)는 여기서 계산하지 않는다(헤더 #4).',
    }),
    metric({
      key: 'mission.review_reach',
      label: 'Review 도달률 (completed / requested)',
      source: 'review.completed ÷ review.requested',
      denominator: seen('review.requested'),
      numerator: seen('review.completed'),
      note: '발생률이 아니라 도달률이다. 1 미만 = 요청하고 결과를 못 받은 것, 1 초과 = '
        + 'requested 없이 completed 가 있는 것 — 둘 다 신호라 클램프하지 않는다. '
        + 'verdict 별 분포는 없다: replay 인덱스가 review 줄을 배열로 노출하지 않는다.',
    }),
    metric({
      key: 'mission.verifications',
      label: 'Verification 기록 수',
      source: 'verify.completed',
      denominator: lines,
      numerator: seen('verify.completed'),
      note: '§34 "Verification ✓ PASS" 의 판정이 아니라 기록 건수다. result 별 판정은 '
        + 'lib/verification 과 /doctor 의 일이고, 재지 못한 층을 PASS 라 부르지 않는다.',
    }),
    metric({
      key: 'mission.human_reach',
      label: 'Human 도달률 (resolved / asked)',
      source: 'human.resolved ÷ human.asked',
      denominator: seen('human.asked'),
      numerator: seen('human.resolved'),
      note: '§34 PERFORMANCE 의 Human Corrections/Decisions 는 human.resolved{kind} 의 '
        + '3분리를 요구하는데 kind 는 아직 OPTIONAL 이라(allowlist) 여기서는 도달률 한 '
        + '행만 센다. writer 비대칭(asked=훅 · resolved=모델)이 보이는 자리다.',
    }),
    metric({
      key: 'mission.context_receipts',
      label: 'Context Receipt 수',
      source: 'context.compiled',
      denominator: lines,
      numerator: context.length,
      note: '§34 CONTEXT 4행(Compression·Cache Hit·Rebuilds·Churn)은 접지 않는다 — '
        + '그것은 토큰 산술이고 이 행은 영수증 건수다(헤더 #5).',
    }),
    metric({
      key: 'mission.completion',
      label: '완료 선언',
      source: 'mission.completed ÷ 색인된 Mission 수',
      denominator: missions.length,
      numerator: seen('mission.completed'),
      note: 'append-only 라 supersedes 재기록이 있으면 1 을 넘을 수 있다 — 클램프하지 '
        + '않는다. 선언이지 수락이 아니다: 수락 여부는 아래 mission.result 이고 그 행은 '
        + '영구 unmeasured 다.',
    }),
    metric({
      key: 'mission.result',
      label: 'Result (수락 여부 · 측정자 없음)',
      source: 'mission.completed · data.accepted',
      denominator: 0,
      note: 'accepted 는 true/false/null 3값이고, allowlist 는 writer 가 null 을 먼저 '
        + 'append 한 뒤 나중에 supersedes 로 판정을 덧붙인다고 적는다. non-null writer 는 '
        + '리포에서 확인되지 않았고, 그와 별개로 replay 인덱스는 mission.completed 줄을 '
        + '배열로 노출하지 않는다(buildReplay 는 routes·switches·usage·context 넷만 투영). '
        + '그래서 분모를 0 으로 고정해 영구 unmeasured 다 — compare.score 와 같은 모양이다. '
        + '행을 빼지 않는 이유는 부재가 "해당 없음"으로 읽히지 않게 하려는 것이다.',
    }),
    metric({
      key: 'mission.duration',
      label: 'Duration (시계 없음)',
      source: '원장 envelope 의 ts',
      denominator: 0,
      note: '§34 "Duration 18m 42s". 파싱하려면 날짜 파서가 필요하고 이 디렉터리는 시계 '
        + '참조를 하나도 두지 않는다 — 순수성이 논증이 아니라 grep 으로 확인되게 하려는 '
        + '것이다(헤더 #2). 정렬된 이벤트를 쥔 호출부가 직접 계산할 수 있다.',
    }),
    metric({
      key: 'mission.switch_quality',
      label: 'Useful/Wasteful · Switch Efficiency · Transition Cost/Time',
      source: '§37 Useful/Wasteful Switch 사후 판정',
      denominator: 0,
      note: '§37 은 이미 일어난 전환에 대한 사후 판정을 요구하는데 Observe 기대 전환 수는 '
        + '0 이다(§8.4). 0 건 fold 에서 효율을 내면 퍼센트를 입은 의견이 된다(헤더 #3). '
        + '한 행으로 묶은 이유는 넷이 같은 선행 조건 하나에 걸려 있기 때문이다.',
    }),
    metric({
      key: 'mission.economics',
      label: 'Total Cost · Cost/Outcome · Retry Waste',
      source: 'lib/economics/usage-receipt.js',
      denominator: 0,
      note: '§34 ECONOMICS. 여기서 합산하면 같은 지출을 두 번 세게 된다 — usage-receipt 가 '
        + '유일 writer 로 지정돼 있다(헤더 #4). 이 카드의 티어 행은 건수지 금액이 아니다.',
    }),
    metric({
      key: 'mission.success_at_1',
      label: 'Success@1 (짝지을 판정 없음)',
      source: '§34 PERFORMANCE "Success@1"',
      denominator: 0,
      note: 'attempt 하나하나에 성공/실패를 짝지어 주는 원장 이벤트가 없다. attempts 와 '
        + 'retries 는 건수이고, 건수 둘로 만든 비율은 Success@1 이 아니다(헤더 #6).',
    }),
  ];

  return freezeCard({
    kind: MISSION_KIND,
    scope: { mission_id: missionId, outcome: 'present' },
    metrics,
  });
}
