/**
 * The deterministic layer's one honest source: the vitest reporter snapshot.
 *
 * WHY THIS MODULE EXISTS. `scripts/hooks/dev-verify-gate.js` fires on every
 * Stop that followed a main-agent edit and records the DENOMINATOR of the
 * verification measurement — four `verify.completed` lines, all `unmeasured`.
 * A denominator with no numerator answers nothing, so this module supplies the
 * only numerator the repo can produce today without lying: the outcome of the
 * last `npm test`, as written by
 * `tests/reporters/test-status-reporter.js` (:51-52, :125-140).
 *
 * WHY NOT THE OTHER LAYERS. lint, tsc and build leave no exit code anywhere a
 * hook can read (the PostToolUse Bash hooks read `tool_response.exit_code` and
 * persist nothing), there is no behavioral runner, and no operational readings
 * exist. Inventing any of those here would be the false measurement the ledger
 * exists to prevent, so they stay UNMEASURED and this module never touches them.
 *
 * ── THE FRESHNESS RULE (owner decision F1) ──────────────────────────────────
 * A result counts only when it is at least as new as the last main-agent edit
 * (`last-main-agent-edit.timestamp`, the same marker the gate uses to decide
 * whether to fire at all). Anything older described a tree that no longer
 * exists. There is deliberately NO time-to-live: a 24-hour window would let a
 * stale green survive an edit, which is exactly the failure F1 rejects.
 *
 * ── THE COMPLETION RULE (records that carry `completion`, "v2") ─────────────
 * `failed === 0` says no TEST failed. It does not say the RUN ended well: an
 * unobserved promise rejection, an exception thrown from a timer, a hook that
 * throws inside a `describe`, a worker killed mid-file and a run stopped by
 * `--bail` all leave `failed: 0` while vitest itself exits 1 (measured on vitest
 * 4.0.18, 2026-10-06; VERIFICATION-ECONOMICS-DESIGN §3.2). So the reporter also
 * writes `schemaVersion: 2` and `completion: { reason, unhandledErrorCount,
 * unfinishedCount }`, and a record that carries them is judged in this order —
 * the first rule that applies wins, and a CERTAIN failure outranks every
 * "cannot tell" below it:
 *
 *   1. failed > 0                   -> exitCode 1
 *   2. unhandledErrorCount > 0      -> exitCode 1
 *   3. reason 'failed'              -> exitCode 1  (vitest itself judged the run failed)
 *   4. reason 'interrupted'         -> UNMEASURED
 *   5. unfinishedCount > 0          -> UNMEASURED
 *   6. reason 'passed' AND 0 unhandled AND 0 unfinished -> exitCode 0, the ONLY pass
 *   7. anything else (a field missing, null, mistyped, outside the vocabulary,
 *      or a reason vitest adds later)                   -> UNMEASURED
 *
 * The pass is an ALLOWLIST (6), so nothing reaches exitCode 0 by being left out
 * of a list of failures. A record WITHOUT `completion` (the reporter as it was
 * before 2026-10-06) is read exactly as it always was, `failed === 0`: its gap
 * was scope — a targeted run — which this module cannot see either, and it stays
 * readable. A record is v2 when it has a `completion` key or a `schemaVersion`
 * that is not a number below 2; a version that is present but is not a number is
 * not a record this module can vouch for, so it fails closed rather than reading
 * as v1.
 *
 * The ledger drops `reason`, so the verdicts that carry an exitCode append
 * `completion=… unhandled=… unfinished=…` to the evidence note; the three new
 * UNMEASURED outcomes keep the reason-only shape and are told apart by their
 * hash (`REASONS.interrupted`, `.unfinished`, `.completionUnreadable`).
 *
 * ── THE TWO LOCATIONS, AND WHY THEY DIFFER (owner decision R1) ──────────────
 * The result file is read under the REPO root, not the plugin root. The
 * reporter writes it beside the sources it ran against, and the installed
 * plugin copy under `~/.claude/plugins/cache/` never has one — resolving it
 * against `CLAUDE_PLUGIN_ROOT` would make the live numerator permanently zero
 * (measured 2026-09-14: present in the checkout, absent in the install).
 *
 * The marker is read from a path the CALLER hands in (`markerPath`). It lives in
 * the session's own gate directory under the project store
 * (`lib/project-state/gate-markers.js`), no longer under the plugin root: a
 * plugin-root marker was shared by every project and lost on every update, so a
 * run could be judged fresh or stale against an edit made somewhere else. This
 * module stays ignorant of that layout on purpose — it is pure, and the one
 * caller that knows the layout is the one that already gated on the same file.
 * Comparing the two values is sound: both come from the same machine's wall clock.
 *
 * A consequence worth stating: run `npm test` in one worktree and edit in
 * another, and this reports UNMEASURED. That is the honest answer, not a bug —
 * the other worktree's run says nothing about this one's tree.
 *
 * ── PURITY ──────────────────────────────────────────────────────────────────
 * No `node:fs` import. Every byte arrives through injected ports, so the
 * decision table is testable without a filesystem and the Stop hook keeps the
 * only IO. `node:path` is the sole import, for joining the repo root.
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
 * The last three arrived with the `completion` record; the first six are
 * byte-identical to what shipped before it.
 */
export const REASONS = Object.freeze({
  absent: `no vitest result at ${RESULT_FILE_RELPATH} — nothing was run in this repo copy`,
  corrupt: 'the vitest result file does not parse as a result record — refusing to guess what ran',
  badTimestamp: 'the vitest result file carries no usable timestamp — freshness is not decidable',
  noMarker: 'no last-main-agent-edit marker — there is nothing for a run to be fresher than',
  stale: 'the vitest result predates the last main-agent edit — that run did not cover this tree',
  emptyRun: '0 tests ran — an empty run does not measure the tree, whatever its exit status',
  interrupted: 'vitest reported the run as interrupted — a stopped run does not measure the tree, '
    + 'whatever its failure count',
  unfinished: 'some tests never reached a final state — a run that did not finish does not '
    + 'measure the tree, whatever its failure count',
  completionUnreadable: 'the vitest result file carries no usable completion record — whether the '
    + 'run ended cleanly is not decidable',
});

/**
 * The values vitest 4 documents for `onTestRunEnd`'s third argument, which the
 * reporter writes verbatim as `completion.reason`. The reporter cannot import
 * this module and this module cannot import the reporter (the reporter's test
 * copies that single file out of the tree), so the vocabulary exists on both
 * sides; the writer-to-reader round trip in
 * `tests/reporters/test-status-reporter.test.js` is what keeps them in step.
 */
const COMPLETION_REASONS = Object.freeze(['passed', 'interrupted', 'failed']);

/** @param {unknown} v @returns {boolean} */
function isCount(v) {
  return Number.isInteger(v) && Number(v) >= 0;
}

/**
 * Does this snapshot carry — or claim to carry — a completion record?
 *
 * v1 is the one shape the reporter wrote before `completion`: no `completion`
 * key, and either no `schemaVersion` or a number below 2. Everything else is v2,
 * including a version that is present but not a number.
 *
 * @param {Record<string, any>} r
 * @returns {boolean}
 */
function isV2Record(r) {
  if (Object.hasOwn(r, 'completion')) return true;
  if (!Object.hasOwn(r, 'schemaVersion')) return false;
  const version = r.schemaVersion;
  return !(typeof version === 'number' && version < 2);
}

/**
 * Read `completion` one field at a time. A field that is not usable becomes
 * `null` — "unknown" — and never a default that would read as a clean run.
 *
 * @param {Record<string, any>} r
 * @returns {{ reason: string|null, unhandledErrorCount: number|null, unfinishedCount: number|null }}
 */
function readCompletion(r) {
  const c = r.completion && typeof r.completion === 'object' && !Array.isArray(r.completion)
    ? r.completion
    : {};
  return {
    reason: COMPLETION_REASONS.includes(c.reason) ? c.reason : null,
    unhandledErrorCount: isCount(c.unhandledErrorCount) ? c.unhandledErrorCount : null,
    unfinishedCount: isCount(c.unfinishedCount) ? c.unfinishedCount : null,
  };
}

/**
 * The v2 verdict; the rule order is the one in the module header.
 *
 * @param {number} failed
 * @param {ReturnType<typeof readCompletion>} c
 * @returns {{ exitCode: 0|1, clause: string }|{ unmeasured: string }}
 */
function completionVerdict(failed, c) {
  if (failed > 0) return { exitCode: 1, clause: '' };
  if (c.unhandledErrorCount !== null && c.unhandledErrorCount > 0) {
    return { exitCode: 1, clause: `; ${c.unhandledErrorCount} unhandled error(s) outside the tests` };
  }
  if (c.reason === 'failed') return { exitCode: 1, clause: '; vitest itself ended the run as failed' };
  if (c.reason === 'interrupted') return { unmeasured: REASONS.interrupted };
  if (c.unfinishedCount !== null && c.unfinishedCount > 0) return { unmeasured: REASONS.unfinished };
  // The ONLY way to a v2 pass, written as an allowlist: a reason vitest adds
  // later, or a field this module cannot read, lands in UNMEASURED below instead
  // of being waved through by omission.
  if (c.reason === 'passed' && c.unhandledErrorCount === 0 && c.unfinishedCount === 0) {
    return { exitCode: 0, clause: '; the run ended cleanly (no unhandled errors, no unfinished tests)' };
  }
  return { unmeasured: REASONS.completionUnreadable };
}

/**
 * The completion facts as one deterministic evidence-note clause. An unusable
 * field is spelled `unknown`; its raw value is never copied into the ledger.
 *
 * @param {ReturnType<typeof readCompletion>} c
 * @returns {string}
 */
function completionNoteClause(c) {
  return ` completion=${c.reason ?? 'unknown'} unhandled=${c.unhandledErrorCount ?? 'unknown'} `
    + `unfinished=${c.unfinishedCount ?? 'unknown'}`;
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

  // FAIL-OPEN GUARD. `failed === 0` is true of a suite that passed AND of one
  // that never collected a test — a filter that matched nothing, or a run that
  // died during collection, writes `totalTests: 0, failed: 0` and would
  // otherwise be recorded as a verdict about a tree nobody looked at. Found by
  // cross-review with a real spawn (2026-09-15: a zero-test file landed as
  // deterministic `pass`, `v1-a69aa375bbc0-…`). The COUNT is the only field
  // that separates the two cases, so the count is what this checks. A run whose
  // tests were all SKIPPED still collected them and is left alone.
  //
  // `failed === 0` is ALSO true of a run that ended badly without failing a test
  // (an unhandled error, a hook that threw inside a `describe`, a killed worker,
  // an interrupted run). That second fail-open is closed at the verdict below,
  // for records that carry `completion`; the guards in between are untouched and
  // still run first, in this order.
  if (result.totalTests === 0) return { reason: REASONS.emptyRun };

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
  // The reporter's count of test FILES, added after this module shipped. A
  // snapshot written before that has no `modules` at all, and one hand-edited
  // or written by another tool could carry anything — in both cases the clause
  // is LEFT OUT rather than defaulted to 0, because `modules=0` in the ledger
  // would read as a run that collected no files, which is a different claim
  // from "the run did not record this".
  const modulesClause = isCount(result.modules) ? ` modules=${result.modules}` : '';

  // v1 keeps `failed === 0` and appends nothing, so its reason, note and id stay
  // byte-identical. A v2 record is judged on how the run ENDED as well; the
  // three UNMEASURED outcomes leave here with the reason-only shape.
  let exitCode = failed === 0 ? 0 : 1;
  let reasonClause = '';
  let noteClause = '';
  if (isV2Record(result)) {
    const completion = readCompletion(result);
    const verdict = completionVerdict(failed, completion);
    if ('unmeasured' in verdict) return { reason: verdict.unmeasured };
    exitCode = verdict.exitCode;
    reasonClause = verdict.clause;
    noteClause = completionNoteClause(completion);
  }

  return {
    exitCode,
    reason: `vitest result fresh — ${totalTests} tests, ${passed} passed, ${failed} failed, `
      + `${skipped} skipped (measured ${timestamp}, at or after the last main-agent edit)${reasonClause}`,
    // The counts ride in `note` because the ledger drops `reason`. A reader
    // that wants to know whether this was the whole suite or a targeted run
    // has these numbers and nothing else — say them plainly. `modules` (the
    // number of test FILES) narrows that question without answering it: a
    // filter matching every file counts the same as no filter, and the vitest
    // reporter API exposes no filter, so no "was targeted" flag is written.
    // The completion clause (v2 only) rides here for the same reason: it is the
    // only place a later reader can see how the run ended.
    evidence: [{
      kind: 'file',
      file: RESULT_FILE_RELPATH,
      line: 1,
      measured_at: timestamp,
      note: `vitest total=${totalTests} passed=${passed} failed=${failed} `
        + `skipped=${skipped}${modulesClause}${noteClause}`,
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
 * @param {string|null} p.markerPath Absolute path of the session's
 *   `last-main-agent-edit.timestamp`; an empty or missing value reads as "no
 *   marker", never as a guess at where one might be.
 * @param {number} [p.nowMs]
 * @returns {{ deterministic: { exitCode?: number, reason: string, evidence?: Array<object> } }}
 */
export function readDeterministicLayer(ports, { repoRoot, markerPath, nowMs } = {}) {
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

  if (!statMtimeMs || typeof markerPath !== 'string' || markerPath === '') {
    return { deterministic: { reason: REASONS.noMarker } };
  }

  let markerMtimeMs;
  try {
    const raw = statMtimeMs(markerPath);
    markerMtimeMs = Number.isFinite(raw) ? Number(raw) : null;
  } catch {
    return { deterministic: { reason: REASONS.noMarker } };
  }

  return { deterministic: deterministicLayerFrom({ resultJsonText, markerMtimeMs, nowMs }) };
}
