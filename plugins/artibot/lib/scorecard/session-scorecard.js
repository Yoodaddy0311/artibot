/**
 * Session Scorecard — the `/save` snapshot card of MODEL-SWITCHING-SCORECARD.md
 * §35, folded from the ledger and nothing else.
 *
 * WHAT THIS IS
 * ---------------------------------------------------------------------------
 * §36 "Scorecard Data Source" settles where the numbers come from: "Scorecard를
 * 별도 manual document로 만들지 않는다 … Route Receipts + Context Receipts +
 * Attempt Receipts + Usage Receipts + Task Graph + Review + Verification +
 * Outcome = Scorecard Projection. 따라서 Scorecard는 삭제/재생성 가능하다."
 * This module is that projection for the SESSION level (§54 "Scorecard Levels"
 * lists four: Live Status, Session Snapshot, Final Mission, Project — this is
 * the second, and §32 is explicit that "Session Scorecard ≠ Mission Scorecard").
 *
 * PURE. Input is a `lib/replay` index. No filesystem, no clock, no randomness,
 * and nothing here writes anything — the card is regenerable, exactly like the
 * replay index it reads (design §8.3-2, "정본은 ledger.jsonl 하나").
 *
 * ── WHAT THIS CARD CANNOT SEE (repo rule §9: write it next to the gate) ──────
 *  1. ZERO LIVE LEDGER LINES — AND "WIRED" IS NOT "POPULATED". Ledger writers
 *     landed in this batch (`scripts/hooks/pre-bash.js#recordBlock` human.asked,
 *     `scripts/hooks/subagent-handler.js#observeRoute` route.selected,
 *     `lib/runtime/middleware/tasks.js#createTasksMiddleware` Mission Contract), so the earlier
 *     claim here that Phase 0 wires none was WRONG. What is still true is that
 *     nothing below has met a real line: hooks register through
 *     `${CLAUDE_PLUGIN_ROOT}` (`hooks/hooks.json:38·182`), so an install that
 *     predates the wiring runs the old copy until `npm run sync:local`, and
 *     until then every metric renders `unmeasured`. That is the correct output,
 *     not a defect to paper over with a zero. File wired != executed !=
 *     appended: do not read any one of the three as the others.
 *  2. PROGRESS AND STATUS (§35 rows "Progress 64%", "Status SAVED · IN
 *     PROGRESS"). Both need the Task Graph and the state store; T-14 owns the
 *     graph and neither has landed. A percentage invented from the events that
 *     happen to exist would be a number with no denominator, which is the one
 *     thing this directory refuses to emit. Absent by decision, not oversight.
 *  3. ELAPSED (§35 "Elapsed 12m 41s"). The ledger carries `ts` on every line,
 *     so the span is derivable — but only through a date parser, and this
 *     module deliberately holds no `Date` reference at all so the "no clock"
 *     property is greppable rather than argued. A caller that wants elapsed
 *     time has the ordered events and can compute it itself.
 *  4. TOKENS AND COST (§35 "… tokens" per tier, §34 ECONOMICS). `model_tiers`
 *     counts USAGE RECEIPTS per tier, not tokens. Summing spend here would be
 *     a second answer to the question `ledger.js#foldMissions` already answers,
 *     and `lib/economics/usage-receipt.js` is named in the allowlist as "the
 *     ONLY writer, so the same spend is never counted twice". One answer.
 *  5. WHETHER AN ACTION IS ONE ACTION. Inherited whole from `lib/replay`:
 *     `action_id` is optional, so most groupings are derived. `session.actions`
 *     reports the ATTRIBUTION mix rather than hiding it, and its ratio is the
 *     share keyed by a real `action_id`. A low ratio means low resolution, not
 *     damage.
 *  6. LEDGER GAPS. `replay.gaps` is not folded into any metric here. Judging
 *     gaps as a health verdict belongs to /doctor Check 8 (T-43); a second
 *     module scoring the same signal is how two answers to one question start.
 *
 * @module lib/scorecard/session-scorecard
 */

import {
  countWhere,
  freezeCard,
  histogramMetric,
  metric,
  readPath,
  sortedCounts,
  tallyBy,
} from './metric.js';

/** Card kind, used by the renderer to pick a heading. An allowlist of two. */
export const SESSION_KIND = 'session';

/**
 * Merge the per-action event histograms of a set of actions.
 *
 * The scoped line total is derived from `event_counts` rather than from
 * `action.events`, because `buildReplay(events, {includeEvents: false})`
 * empties the latter while leaving the counts intact. A denominator that
 * silently depends on a caller's option is a denominator that will be wrong
 * exactly once, in the call that mattered.
 *
 * @param {object[]} actions - action records from the replay index.
 * @returns {{counts: Record<string, number>, total: number}} merged histogram
 *   and its sum.
 */
export function mergeEventCounts(actions) {
  const counts = {};
  let total = 0;
  for (const action of actions) {
    for (const [event, n] of Object.entries(action.event_counts ?? {})) {
      counts[event] = (counts[event] ?? 0) + n;
      total += n;
    }
  }
  return { counts: sortedCounts(counts), total };
}

/**
 * Build the session card.
 *
 * @param {object} replay - a `buildReplay` index (T-41). Read only.
 * @param {{session_id: string}} opts - `session_id` is REQUIRED. A card built
 *   without a scope would fold every session in the ledger into one snapshot
 *   and label it as one session, which is worse than refusing: §32 exists
 *   precisely because a session and a mission are different units.
 * @returns {object} `{kind, scope, metrics, unmeasured, notes}` — every field
 *   present on every call, so a consumer never branches on `undefined`.
 * @throws {TypeError} when `replay` is not an index or `session_id` is absent.
 */
export function buildSessionScorecard(replay, opts = {}) {
  if (!replay || typeof replay !== 'object' || !Array.isArray(replay.actions)) {
    throw new TypeError(
      'buildSessionScorecard requires a lib/replay index — pass the result of '
      + 'buildReplay(events) or loadReplay(root, {readEvents}).',
    );
  }
  const sessionId = opts.session_id;
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new TypeError(
      'buildSessionScorecard requires opts.session_id — an unscoped card would '
      + 'fold every session into one snapshot and label it as one session '
      + '(MODEL-SWITCHING-SCORECARD.md §32: Session Scorecard ≠ Mission Scorecard).',
    );
  }

  const inSession = (e) => e && e.session_id === sessionId;
  const actions = replay.actions.filter(inSession);
  const missions = (replay.missions ?? []).filter(
    (m) => Array.isArray(m.sessions) && m.sessions.includes(sessionId),
  );
  const usage = (replay.usage ?? []).filter(inSession);
  const routes = (replay.routes ?? []).filter(inSession);
  const switches = (replay.switches ?? []).filter(inSession);
  const { counts: eventCounts, total: lines } = mergeEventCounts(actions);
  const seen = (name) => eventCounts[name] ?? 0;

  const metrics = [
    metric({
      key: 'session.events',
      label: '이벤트 분포',
      source: 'replay.actions[].event_counts (세션 한정)',
      denominator: lines,
      counts: eventCounts,
      note: '이 세션에 귀속된 원장 줄 전체. 아래 모든 분모의 상위 집합이다.',
    }),
    metric({
      key: 'session.actions',
      label: 'Action 수 · 귀속 해상도',
      source: 'replay.actions[].keyed_by',
      denominator: actions.length,
      numerator: countWhere(actions, (a) => a.keyed_by === 'action_id'),
      counts: tallyBy(actions, (a) => a.keyed_by),
      note: '비율 = 실제 action_id 로 묶인 몫. 나머지는 epoch/세션에서 유도된 것이지 '
        + '누락이 아니다(lib/replay 헤더 #1).',
    }),
    metric({
      key: 'session.missions',
      label: 'Mission 별 Action',
      source: 'replay.actions[].mission_id',
      denominator: actions.length,
      counts: tallyBy(actions, (a) => a.mission_id),
      note: '한 Mission 이 여러 Session 을 가질 수 있고 그 역도 성립한다(§32).',
    }),
    histogramMetric(usage, (e) => readPath(e, ['data', 'model_identity', 'tier']), {
      key: 'session.model_tiers',
      label: '티어별 Usage Receipt',
      source: "usage.receipt · data.model_identity.tier",
      note: '§34 MODEL USAGE 의 분모. 토큰·비용이 아니라 RECEIPT 건수다 — 지출 합산은 '
        + 'lib/economics 의 단일 답이다(헤더 #4).',
    }),
    metric({
      key: 'session.attempts',
      label: 'Attempts',
      source: 'usage.receipt',
      denominator: lines,
      numerator: seen('usage.receipt'),
      note: '§34 PERFORMANCE "Attempts". Attempt Receipt 는 run 단위다.',
    }),
    metric({
      key: 'session.retries',
      label: 'Retries',
      source: 'retry.scheduled',
      denominator: lines,
      numerator: seen('retry.scheduled'),
      note: '§34 PERFORMANCE "Retries". Retry Waste(금액)는 여기서 계산하지 않는다.',
    }),
    metric({
      key: 'session.human_reach',
      label: 'Human 도달률 (resolved / asked)',
      source: 'human.resolved ÷ human.asked',
      denominator: seen('human.asked'),
      numerator: seen('human.resolved'),
      note: '발생률이 아니라 도달률이다. 비율 1 미만 = 물어보고 답을 못 받은 것, '
        + '1 초과 = asked 없이 resolved 가 있는 것 — 둘 다 신호이므로 클램프하지 않는다.',
    }),
    metric({
      key: 'session.checkpoints',
      label: 'Checkpoint',
      source: 'mission.checkpointed ÷ 세션의 Mission 수',
      denominator: missions.length,
      numerator: seen('mission.checkpointed'),
      note: '§35 "Checkpoint ✓ resumable". 재개 가능 여부는 판정하지 않는다 — 기록 건수만.',
    }),
    metric({
      key: 'session.switches',
      label: 'Model Switch (제안 대비)',
      source: 'model.switched ÷ route.selected',
      denominator: routes.length,
      numerator: switches.length,
      note: 'Observe 기대값은 0 이다 — 설계 §8.4 는 Switch Controller 실적용을 '
        + 'Canary 로 둔다. 0 이 아니면 기능이 아니라 발견이다.',
    }),
  ];

  return freezeCard({
    kind: SESSION_KIND,
    scope: { session_id: sessionId },
    metrics,
  });
}

