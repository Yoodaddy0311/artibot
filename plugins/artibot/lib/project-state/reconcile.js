/**
 * StateStore reconcile — does the derived snapshot still match the journal,
 * and does the journal still match the ledger?
 *
 * Three artefacts must agree, and the design fixes which one wins in each
 * disagreement (ARTIBOT-5.0-DESIGN.md §1-2):
 *
 * | disagreement                  | winner  | why |
 * |-------------------------------|---------|-----|
 * | snapshot vs journal           | journal | the snapshot is an explicitly deletable cache |
 * | store vs ledger               | ledger  | `ledger ⊇ store` is the stated invariant |
 *
 * REPORT-ONLY by default. Phase 0 is Observe — "기록만, 행동 변화 0" — so a
 * drift is described, not silently repaired. `apply: true` opts into the
 * rewrite, which is the design's `rebuild(ledger) ≠ store -> rewrite the
 * store` rule applied to the store's own append-only record.
 *
 * ── Reading the two asymmetric ledger comparisons ─────────────────────────
 * `missingInStore` (in the ledger, not in the store) is a crash between the
 * ledger append and the journal append. Unpleasant, but the superset
 * invariant HOLDS and the store is merely behind.
 *
 * `extraInStore` (in the store, not in the ledger) means a write committed
 * with no paired event. That is the invariant BROKEN, and it is the exact
 * signature lost-update detection depends on being able to see. The two are
 * reported separately because conflating them would hide the serious one
 * inside the benign one.
 *
 * ONE declared exception (design D11): a version the JOURNAL declares store-only (a lease
 * heartbeat committed with `heartbeatWorker({storeOnly: true})` — every record marked and
 * heartbeat-shaped, `journal.js#storeOnlyVersions`) has no event by design, so it is not
 * `extraInStore`. It is listed under `storeOnly` instead, so "nothing extra" and "extra, but
 * declared" stay distinguishable. A lost store-only write cannot show in this comparison.
 *
 * @module lib/project-state/reconcile
 */

import path from 'node:path';
import { atomicWriteTextSync, ensureDirSync, readJsonFileSync } from '../core/file.js';
import { readJournal, reduceProjectState, storeOnlyVersions } from './journal.js';
import { renderProjection } from './projection.js';

/**
 * Compare the journal, the snapshot and (optionally) the ledger.
 *
 * REPORT-ONLY by default. Phase 0 is Observe: "기록만, 행동 변화 0". Pass
 * `apply: true` to rewrite a drifted snapshot from the journal, which is the
 * `rebuild(ledger) ≠ store → ledger wins` rule of design §1-2 applied to the
 * store's own append-only record.
 *
 * @param {object} ctx - Store context (`paths`, `projectName`, `renderProjectionFile`).
 * @param {object} [opts] - Reconcile options.
 * @param {number[]} [opts.ledgerVersions] - `state_version` values seen in the ledger.
 * @param {boolean} [opts.apply=false] - Rewrite the snapshot when it has drifted.
 * @returns {object} `{ok, drifted, applied, gaps, missingInStore, extraInStore, storeOnly, warnings}`.
 */
export function reconcileStore(ctx, opts = {}) {
  const { records, torn } = readJournal(ctx.paths.journal);
  const { state: rebuilt, warnings } = reduceProjectState(records, { project: ctx.projectName });
  const onDisk = readJsonFileSync(ctx.paths.snapshot, null);
  if (torn > 0) warnings.push(`journal has ${torn} unparseable line(s)`);

  rebuilt.project = onDisk?.project ?? ctx.projectName;
  const drifted = onDisk === null
    ? records.length > 0
    : JSON.stringify(onDisk) !== JSON.stringify(rebuilt);

  let applied = false;
  if (drifted && opts.apply === true) {
    atomicWriteTextSync(ctx.paths.snapshot, JSON.stringify(rebuilt, null, 2) + '\n');
    if (ctx.renderProjectionFile) renderProjectionFile(ctx, rebuilt);
    applied = true;
  }

  const storeVersions = [...new Set(
    records.map((r) => r.state_version).filter(Number.isInteger),
  )].sort((a, b) => a - b);

  return {
    ok: !drifted || applied,
    drifted,
    applied,
    storeVersion: rebuilt.state_version,
    snapshotVersion: onDisk?.state_version ?? null,
    ...compareLedger(storeVersions, opts.ledgerVersions, storeOnlyVersions(records)),
    warnings,
  };
}

/**
 * Compare store versions against ledger versions.
 *
 * @param {number[]} storeVersions - Versions present in the journal.
 * @param {number[]|undefined} ledgerVersions - Versions seen in the ledger.
 * @param {number[]} [storeOnly=[]] - Versions the journal declares store-only (no event by design).
 * @returns {{gaps: number[], missingInStore: number[], extraInStore: number[], storeOnly: number[]}} Comparison.
 */
function compareLedger(storeVersions, ledgerVersions, storeOnly = []) {
  const gaps = [];
  for (let i = 1; i <= (storeVersions.at(-1) ?? 0); i += 1) {
    if (!storeVersions.includes(i)) gaps.push(i);
  }
  if (!Array.isArray(ledgerVersions)) return { gaps, missingInStore: [], extraInStore: [], storeOnly };
  const ledgerSet = new Set(ledgerVersions);
  const declared = new Set(storeOnly);
  return {
    gaps,
    // In the ledger but not the store: a crash between the ledger append and
    // the journal append. The `ledger ⊇ store` invariant still holds.
    missingInStore: ledgerVersions.filter((v) => !storeVersions.includes(v)),
    // In the store but not the ledger: the invariant is BROKEN — a write
    // landed with no event, which is the lost-update signature. A version the
    // journal declares store-only (design D11) is the one thing that is not.
    extraInStore: storeVersions.filter((v) => !ledgerSet.has(v) && !declared.has(v)),
    storeOnly,
  };
}

/**
 * Re-render the projection after a repair. Never fatal: the store is already
 * correct, and the projection is regenerable by definition.
 *
 * @param {object} ctx - Store context.
 * @param {object} snapshot - The snapshot to render.
 * @returns {void}
 */
function renderProjectionFile(ctx, snapshot) {
  try {
    ensureDirSync(path.dirname(ctx.paths.projection));
    atomicWriteTextSync(ctx.paths.projection, renderProjection(snapshot));
  } catch {
    /* the next commit re-renders */
  }
}
