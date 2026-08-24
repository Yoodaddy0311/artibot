#!/usr/bin/env node
/**
 * ledger-review.js — F-06 D2 human review gate for the ambient conversation
 * ledger. The command surface (`/learning review`) that promotes denoised
 * ledger corpus into the learning store, one human approval at a time.
 *
 * Pull-model (leader decision, 2026-07-02): staging happens on INVOCATION of
 * `/learning review` — NOT from a SessionEnd hook. Keeps the human explicitly
 * in the loop (privacy-sensitive promotion) and avoids background enqueue.
 *
 *   review           (default) → enqueueFromCorpus (stage NEW corpus, advance
 *                                watermark) → listPending → renderReviewReport
 *   review approve <id…|--all> → approve() → collectExperience promotion + dequeue
 *   review reject  <id…|--all> → reject()  → dequeue WITHOUT promotion
 *
 * Sibling of the READ-ONLY `learning-diag.js`: this one MUTATES (queue file +
 * corpus watermark + learning store on approval), so it is deliberately a
 * SEPARATE script — `learning-diag.js` keeps its "pure observation" contract.
 * The queue/corpus operate on the PROJECT-LOCAL ledger (`<cwd>/.artibot/ledger/`).
 *
 * DATA POLICY: local file reads/writes only, no network. The underlying
 * review-queue API is best-effort and never throws.
 *
 * Usage:
 *   node scripts/ledger-review.js                 # stage new corpus + list pending
 *   node scripts/ledger-review.js --session <sid> # stage only that session
 *   node scripts/ledger-review.js approve <id>    # promote one item
 *   node scripts/ledger-review.js approve --all    # promote all pending
 *   node scripts/ledger-review.js reject <id>     # drop one item (no promotion)
 */

import {
  approve, enqueueFromCorpus, listPending, reject, renderReviewReport,
} from '../lib/learning/ledger/review-queue.js';
import { isMainEntry } from './hooks/_main-entry.js';

// Default engine wiring — overridable in tests so approval never touches the
// real learning store (~/.claude/artibot) or a temp ledger's collectExperience.
const DEFAULT_DEPS = Object.freeze({
  enqueueFromCorpus, listPending, approve, reject, renderReviewReport,
});

const REVIEW_HINT = '승인: `/learning review approve <id> [<id>…]` 또는 `--all` · 반려: `/learning review reject …`';

/**
 * Parse the review argv (already stripped of the leading `review` token by the
 * command). Positional non-flag tokens are queue item ids; `--all` selects all.
 * @param {string[]} argv
 * @returns {{ action: 'stage'|'approve'|'reject', ids: string[], all: boolean, sessionId?: string, limit?: number }}
 */
export function parseReviewArgs(argv) {
  const args = { action: 'stage', ids: [], all: false, sessionId: undefined, limit: undefined };
  let list = Array.isArray(argv) ? argv : [];
  // Tolerate a leading `review` token so the `/learning` command can forward
  // `$ARGUMENTS` verbatim (no fragile shell parameter-expansion stripping).
  if (list[0] === 'review') list = list.slice(1);
  for (let i = 0; i < list.length; i += 1) {
    const a = list[i];
    if (a === 'approve') args.action = 'approve';
    else if (a === 'reject') args.action = 'reject';
    else if (a === '--all') args.all = true;
    else if (a === '--session') args.sessionId = list[++i];
    else if (a === '--limit') {
      const n = Number.parseInt(list[++i], 10);
      if (Number.isFinite(n) && n >= 0) args.limit = n;
    } else if (typeof a === 'string' && a.length > 0 && !a.startsWith('--')) {
      args.ids.push(a);
    }
  }
  return args;
}

/**
 * Run the review gate against a project's ledger. Pure w.r.t. output: returns
 * the rendered text + structured result so it is unit-testable with injected
 * engine deps (no subprocess, no store writes).
 * @param {string} projectRoot
 * @param {string[]} argv
 * @param {typeof DEFAULT_DEPS} [deps]
 * @returns {Promise<{ action: string, text: string, result: object }>}
 */
export async function runReview(projectRoot, argv, deps = DEFAULT_DEPS) {
  const { action, ids, all, sessionId, limit } = parseReviewArgs(argv);

  if (action === 'approve' || action === 'reject') {
    if (!all && ids.length === 0) {
      return {
        action,
        text: `대상 미지정 — id를 지정하거나 --all 을 사용하세요. 예: \`/learning review ${action} <id>\``,
        result: null,
      };
    }
    const selector = all ? { all: true } : { ids };

    if (action === 'approve') {
      const res = await deps.approve(projectRoot, selector); // default promote = collectExperience(toExperience)
      const pending = await deps.listPending(projectRoot);
      const text = [
        `승인 완료 — ${res.promoted}건 학습 승격, ${res.remaining}건 검토 대기 잔여.`,
        deps.renderReviewReport(pending),
      ].join('\n\n');
      return { action, text, result: res };
    }

    const res = await deps.reject(projectRoot, selector);
    const pending = await deps.listPending(projectRoot);
    const text = [
      `반려 완료 — ${res.removed}건 폐기(학습 미승격), ${res.remaining}건 검토 대기 잔여.`,
      deps.renderReviewReport(pending),
    ].join('\n\n');
    return { action, text, result: res };
  }

  // Default: stage NEW corpus into the queue, then present the review report.
  const staged = await deps.enqueueFromCorpus(projectRoot, { sessionId, limit });
  const pending = await deps.listPending(projectRoot);
  const text = [
    `신규 코퍼스 ${staged.staged}건 검토 대기열 적재.`,
    deps.renderReviewReport(pending),
    pending.length > 0 ? REVIEW_HINT : '',
  ].filter(Boolean).join('\n\n');
  return { action: 'stage', text, result: staged };
}

async function main() {
  const { text } = await runReview(process.cwd(), process.argv.slice(2));
  process.stdout.write(`${text}\n`);
}

// Run as CLI only when invoked directly, not when imported by tests.
if (isMainEntry(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`ledger-review failed: ${err?.message || err}\n`);
    process.exitCode = 1;
  });
}

export const _internals = Object.freeze({ REVIEW_HINT, DEFAULT_DEPS });
