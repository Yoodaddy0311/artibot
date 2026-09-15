/**
 * The deterministic layer's one honest source: the vitest reporter snapshot.
 *
 * WHY THIS MODULE EXISTS. `scripts/hooks/dev-verify-gate.js` fires on every
 * Stop that followed a main-agent edit and records the DENOMINATOR of the
 * verification measurement — four `verify.completed` lines, all `unmeasured`.
 * A denominator with no numerator answers nothing, so this module supplies the
 * only numerator the repo can produce today without lying: the exit status of
 * the last `npm test`, as written by
 * `tests/reporters/test-status-reporter.js` (:29-30, :90-98).
 *
 * WHY NOT THE OTHER LAYERS. lint, tsc and build leave no exit code anywhere a
 * hook can read (the PostToolUse Bash hooks read `tool_response.exit_code` and
 * persist nothing), there is no behavioral runner, and no operational readings
 * exist. Inventing any of those here would be the false measurement the ledger
 * exists to prevent, so they stay UNMEASURED and this module never touches them.
 *
 * ── THE FRESHNESS RULE (owner decision F1) ──────────────────────────────────
 * A result counts only when it is at least as new as the last main-agent edit
 * (`runtime/last-main-agent-edit.timestamp`, the same marker the gate uses to
 * decide whether to fire at all). Anything older described a tree that no
 * longer exists. There is deliberately NO time-to-live: a 24-hour window would
 * let a stale green survive an edit, which is exactly the failure F1 rejects.
 *
 * ── THE TWO ROOTS, AND WHY THEY DIFFER (owner decision R1) ──────────────────
 * The result file is read under the REPO root, not the plugin root. The
 * reporter writes it beside the sources it ran against, and the installed
 * plugin copy under `~/.claude/plugins/cache/` never has one — resolving it
 * against `CLAUDE_PLUGIN_ROOT` would make the live numerator permanently zero
 * (measured 2026-09-14: present in the checkout, absent in the install). The
 * marker, in contrast, really does live under the plugin root, because the
 * PostToolUse hook that writes it runs from the install. Comparing across the
 * two is sound: both values come from the same machine's wall clock.
 *
 * A consequence worth stating: run `npm test` in one worktree and edit in
 * another, and this reports UNMEASURED. That is the honest answer, not a bug —
 * the other worktree's run says nothing about this one's tree.
 *
 * ── PURITY ──────────────────────────────────────────────────────────────────
 * No `node:fs` import. Every byte arrives through injected ports, so the
 * decision table is testable without a filesystem and the Stop hook keeps the
 * only IO. `node:path` is the sole import, for joining the two roots.
 *
 * @module lib/verification/deterministic-source
 */

import path from 'node:path';

/**
 * Where the reporter writes, RELATIVE TO THE REPO ROOT. Relative on purpose:
 * this string is copied verbatim into ledger evidence, and an absolute path
 * would pin one machine's layout into a record other machines have to read.
 */
export const RESULT_FILE_RELPATH = 'plugins/artibot/runtime/last-test-result.json';

/** The marker the gate itself writes/reads, relative to the PLUGIN root. */
const MARKER_RELPARTS = Object.freeze(['runtime', 'last-main-agent-edit.timestamp']);

/**
 * Tolerance for a result timestamp that sits in the future.
 *
 * Both clocks are the same machine's, so a future timestamp means the file was
 * hand-written or the clock moved — neither is a measurement. One minute of
 * slack absorbs the only benign case (a clock adjustment mid-run) without
 * opening a window a stale file could hide in.
 */
const FUTURE_SKEW_TOLERANCE_MS = 60_000;

/**
 * Why a run could not be counted. EXPORTED AND FROZEN because these strings are
 * hashed into `verification_id` (`unified-verifier.js#buildVerificationId`) and
 * are the ONLY way a later reader can tell the branches apart — the ledger
 * stores `layer`, `result`, `evidence` and `verification_id`, never `reason`.
 * Editing one of these silently re-keys the live histogram, so
 * `tests/verification/deterministic-source.test.js` pins the resulting hashes.
 */
export const REASONS = Object.freeze({
  absent: `no vitest result at ${RESULT_FILE_RELPATH} — nothing was run in this repo copy`,
  corrupt: 'the vitest result file does not parse as a result record — refusing to guess what ran',
  badTimestamp: 'the vitest result file carries no usable timestamp — freshness is not decidable',
  noMarker: 'no last-main-agent-edit marker — there is nothing for a run to be fresher than',
  stale: 'the vitest result predates the last main-agent edit — that run did not cover this tree',
});

/** @param {unknown} v @returns {boolean} */
function isCount(v) {
  return Number.isInteger(v) && Number(v) >= 0;
}

/**
 * Parse the reporter payload, or say which way it was unusable.
 *
 * @param {string} text
 * @returns {{ ok: true, value: Record<string, any> }|{ ok: false, reason: string }}
 */
function parseResult(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: REASONS.corrupt };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: REASONS.corrupt };
  }
  const r = /** @type {Record<string, any>} */ (parsed);
  if (!isCount(r.totalTests) || !isCount(r.passed) || !isCount(r.failed) || !isCount(r.skipped)) {
    return { ok: false, reason: REASONS.corrupt };
  }
  return { ok: true, value: r };
}

/**
 * Decide the deterministic layer from raw inputs. Pure: same inputs, same
 * answer, no clock and no filesystem of its own.
 *
 * The return shape is what `unified-verifier.js#normalizeDeterministic` reads.
 * Omitting `exitCode` is not an oversight — it is how this module says
 * UNMEASURED, and the verifier turns it into exactly that (:323-325). The
 * unmeasured shape carries NO `evidence`, so those four ledger lines stay
 * byte-identical to the pre-numerator denominator and a reader can diff the
 * two eras without a special case.
 *
 * @param {object} p
 * @param {string|null} [p.resultJsonText] Contents of the reporter file, or
 *   `null` when it does not exist.
 * @param {number|null} [p.markerMtimeMs] Marker mtime in epoch ms, or `null`.
 * @param {number} [p.nowMs] Current wall clock. Used ONLY to reject a result
 *   dated in the future; an unusable value disables that guard rather than
 *   expiring anything (there is no TTL here by design).
 * @returns {{ exitCode?: number, reason: string, evidence?: Array<object> }}
 */
export function deterministicLayerFrom({ resultJsonText, markerMtimeMs, nowMs } = {}) {
  if (typeof resultJsonText !== 'string') return { reason: REASONS.absent };

  const parsed = parseResult(resultJsonText);
  if (!parsed.ok) return { reason: parsed.reason };
  const result = parsed.value;

  const timestamp = result.timestamp;
  const ranAtMs = typeof timestamp === 'string' ? Date.parse(timestamp) : Number.NaN;
  if (!Number.isFinite(ranAtMs)) return { reason: REASONS.badTimestamp };
  if (Number.isFinite(nowMs) && ranAtMs > Number(nowMs) + FUTURE_SKEW_TOLERANCE_MS) {
    return { reason: REASONS.badTimestamp };
  }

  if (!Number.isFinite(markerMtimeMs)) return { reason: REASONS.noMarker };
  // `>=`, not `>`: a run that finished at the edit instant still covered it.
  //
  // `Math.floor` because THE TWO SIDES DO NOT CARRY THE SAME RESOLUTION.
  // `statSync().mtimeMs` is fractional (measured: `…522131.7466`), while the
  // reporter's `toISOString()` truncates to whole milliseconds — so without
  // this, a run that finished in the same millisecond as the edit reads as up
  // to 1ms older than it was, and a covering run is called stale. Measured
  // 2026-09-15: 2 of 3 consecutive marker-then-result fixtures flipped to
  // `stale` on that fraction alone. Comparing at whole-millisecond resolution
  // is not a tolerance window — it is the resolution the timestamp actually has.
  if (ranAtMs < Math.floor(Number(markerMtimeMs))) return { reason: REASONS.stale };

  const { totalTests, passed, failed, skipped } = result;
  return {
    exitCode: failed === 0 ? 0 : 1,
    reason: `vitest result fresh — ${totalTests} tests, ${passed} passed, ${failed} failed, `
      + `${skipped} skipped (measured ${timestamp}, at or after the last main-agent edit)`,
    // The counts ride in `note` because the ledger drops `reason`. A reader
    // that wants to know whether this was the whole suite or a targeted run
    // has these four numbers and nothing else — say them plainly.
    evidence: [{
      kind: 'file',
      file: RESULT_FILE_RELPATH,
      line: 1,
      measured_at: timestamp,
      note: `vitest total=${totalTests} passed=${passed} failed=${failed} skipped=${skipped}`,
    }],
  };
}

/**
 * Read both inputs through ports and fold them into a `verify({ layers })`
 * argument.
 *
 * EVERY FAILURE DEGRADES, NOTHING THROWS. A port that throws is indistinguishable
 * from a file that is not there as far as honesty goes — in both cases nothing
 * was measured — and the caller is a Stop hook whose only contract is its stdout.
 * So a throwing result port reads as `absent` and a throwing marker port as
 * `noMarker`, and the gate records the same unmeasured denominator it always did.
 *
 * @param {{ readFile: (p: string) => string|null, statMtimeMs: (p: string) => number|null }} ports
 * @param {object} p
 * @param {string|null} p.repoRoot Root of the checkout the reporter wrote into.
 * @param {string|null} p.pluginRoot Root the marker lives under.
 * @param {number} [p.nowMs]
 * @returns {{ deterministic: { exitCode?: number, reason: string, evidence?: Array<object> } }}
 */
export function readDeterministicLayer(ports, { repoRoot, pluginRoot, nowMs } = {}) {
  const readFile = typeof ports?.readFile === 'function' ? ports.readFile : null;
  const statMtimeMs = typeof ports?.statMtimeMs === 'function' ? ports.statMtimeMs : null;

  if (!readFile || typeof repoRoot !== 'string' || repoRoot === '') {
    return { deterministic: { reason: REASONS.absent } };
  }

  let resultJsonText;
  try {
    const raw = readFile(path.join(repoRoot, ...RESULT_FILE_RELPATH.split('/')));
    resultJsonText = typeof raw === 'string' ? raw : null;
  } catch {
    return { deterministic: { reason: REASONS.absent } };
  }
  // Short-circuit: with no result there is nothing for the marker to date, and
  // `absent` is the more specific truth than whatever the marker would say.
  if (resultJsonText === null) return { deterministic: { reason: REASONS.absent } };

  if (!statMtimeMs || typeof pluginRoot !== 'string' || pluginRoot === '') {
    return { deterministic: { reason: REASONS.noMarker } };
  }

  let markerMtimeMs;
  try {
    const raw = statMtimeMs(path.join(pluginRoot, ...MARKER_RELPARTS));
    markerMtimeMs = Number.isFinite(raw) ? Number(raw) : null;
  } catch {
    return { deterministic: { reason: REASONS.noMarker } };
  }

  return { deterministic: deterministicLayerFrom({ resultJsonText, markerMtimeMs, nowMs }) };
}
