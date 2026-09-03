/**
 * Scorecard barrel — the ledger's fold into the §34/§35 cards.
 *
 * Every module here is pure (design §1-8, L2): no clock, no filesystem, no
 * randomness. Input is a `lib/replay` index, which is itself a regenerable
 * projection of `.artibot/runtime/ledger.jsonl`. NOTHING IN THIS DIRECTORY
 * WRITES A FILE, and that is a contract rather than a coincidence — a persisted
 * card would become a second source of truth beside the ledger, which design
 * §8.3-2 ruled out for exactly this family of projections.
 *
 * Reading the ledger from disk is the CALLER's job, and it is a two-step port
 * handoff: `lib/runtime/ledger.js#readAllEvents` goes into
 * `lib/replay#loadReplay`, whose result comes here. Neither this directory nor
 * `lib/replay` may import `lib/runtime` — both are L2 and runtime is L5
 * (`eslint.config.js`, the L2 no-restricted-imports block).
 *
 * NOT THE SAME THING AS `lib/planning/scorecard.js`. That engine scores FEATURE
 * COMPLETENESS from human-supplied evidence and persists snapshots to
 * `.artibot/scorecard.json`; `/scorecard` with no flag, `--baseline` and
 * `--diff` all go there and are untouched by this directory. This one folds the
 * RUN LEDGER and persists nothing. Two different questions, two engines, no
 * shared state — which is why `/scorecard --session|--routing` is a new path
 * beside the old one rather than a change to it (PRD §3: 기존 출력 경로 무변경).
 *
 * @module lib/scorecard
 */

export {
  COST_TERMS,
  DECISION_TYPES,
  ROUTING_KIND,
  buildRoutingScorecard,
  comparableTiers,
  divergedTier,
  foldCostTerms,
} from './routing-scorecard.js';

export { SESSION_KIND, buildSessionScorecard, mergeEventCounts } from './session-scorecard.js';

export {
  METRIC_STATE,
  UNMEASURED_TEXT,
  countWhere,
  freezeCard,
  histogramMetric,
  metric,
  readPath,
  sortedCounts,
  tallyBy,
} from './metric.js';

export { escapeCell, formatPercent, metricRow, renderScorecardMarkdown } from './render.js';
