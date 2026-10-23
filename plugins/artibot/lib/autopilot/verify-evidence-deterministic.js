/**
 * Rule 7 of the REPORT verify-evidence gate — the DETERMINISTIC evidence check.
 *
 * `report-verify-gate.js` rules 1-6 read what the driver REPORTED: journal rows
 * and `state.verifyResult`. None of them can tell whether a test run actually
 * happened against the tree being reported. This module answers that one
 * question from the only deterministic numerator the repo has, the vitest
 * reporter snapshot (`lib/verification/deterministic-source.js`), and binds it
 * to the tree with the git identity the snapshot carries since schemaVersion 3
 * (`tests/reporters/test-status-reporter.js`). Design:
 * `.artibot/guides/v5-design/practicality-improvement-20261023/05_REVISED_DESIGN.md`
 * D-04, `evidenceMode: 'deterministic'`.
 *
 * ## The decision (an allowlist — only the last line is a pass)
 *
 *   1. No usable repo root, no readable snapshot          -> MISSING
 *   2. Snapshot carries no git identity (pre-v3 / no git) -> MISSING
 *   3. HEAD of the repo root cannot be resolved           -> MISSING
 *   4. Snapshot sha is not HEAD                           -> STALE
 *   5. VERIFY hand-out instant unusable                   -> MISSING
 *   6. Snapshot older than the hand-out (F1 applied to    -> STALE
 *      the attempt start instead of the edit marker)
 *   7. Any other UNMEASURED verdict of the source         -> MISSING
 *   8. Fresh run with failures                            -> FAILED
 *   9. Fresh run, same sha, exit 0                        -> ok
 *
 * MISSING means "nothing measured this tree" and STALE means "something was
 * measured, but not this tree or not this attempt"; both are refusals, and
 * neither is a FAIL — a reader of the pause code must not count them as test
 * failures. FAILED is the one case where the run itself said no.
 *
 * ## Pure, through ports
 *
 * No `node:fs`, no `node:child_process`: the caller hands in `readFile` and
 * `headSha`. A port that throws reads as the thing it could not produce
 * (MISSING), never as a verdict. The reporter's `gitSha` is the full 40-hex id;
 * an abbreviated id another writer might record is accepted when it is a
 * prefix of HEAD, 7 digits or more (`deterministic-source.js#readSnapshotIdentity`
 * already allowlists the shape).
 *
 * ## What this check cannot see (write it beside the gate — rules §9)
 *
 *   - Only the TEST layer is deterministic. lint, tsc and build leave no exit
 *     code anywhere (`deterministic-source.js` header), so a pass here is a
 *     pass of `npm test`, nothing wider.
 *   - A dirty tree at the same sha: `gitDirty` is REPORTED in `reason` but is
 *     not a gate condition. In the autopilot flow the tree is dirty by
 *     construction (EXECUTE edits are uncommitted), so the hand-out instant —
 *     not the sha — is what separates "tested after the edits" from "before";
 *     the sha separates "this checkout" from "another one".
 *   - The snapshot lives under `plugins/artibot/runtime/` of the REPO root
 *     (`RESULT_FILE_RELPATH`, owner decision R1). A project that is not this
 *     repository, and an installed-plugin session, never have one: MISSING,
 *     always, by design.
 *   - Whether the run covered the files the attempt changed: the reporter
 *     records counts, not a file filter.
 *
 * @module lib/autopilot/verify-evidence-deterministic
 */

import path from 'node:path';
import {
  deterministicLayerFrom,
  readSnapshotIdentity,
  REASONS,
  RESULT_FILE_RELPATH,
} from '../verification/deterministic-source.js';

/**
 * The three refusal codes of rule 7. Distinct from the driver-result codes of
 * `report-verify-gate.js#REPORT_VERIFY_CODES` on purpose: a pause message must
 * say which SOURCE refused — what the driver wrote, or what the tree shows.
 *
 * @type {Readonly<{MISSING: 'VERIFY_EVIDENCE_MISSING', STALE: 'VERIFY_EVIDENCE_STALE',
 *   FAILED: 'VERIFY_EVIDENCE_FAILED'}>}
 */
export const DETERMINISTIC_EVIDENCE_CODES = Object.freeze({
  MISSING: 'VERIFY_EVIDENCE_MISSING',
  STALE: 'VERIFY_EVIDENCE_STALE',
  FAILED: 'VERIFY_EVIDENCE_FAILED',
});

/** Shortest abbreviated id accepted as a prefix of HEAD (git's own default). */
const MIN_ABBREV = 7;

/**
 * @typedef {object} DeterministicEvidenceVerdict
 * @property {boolean} ok - True only on line 9 of the decision table.
 * @property {string|null} code - One of {@link DETERMINISTIC_EVIDENCE_CODES}, or `null` when ok.
 * @property {string} reason - One sentence a pause message can quote.
 * @property {{gitSha: string|null, gitDirty: boolean|null, measuredAtMs: number|null}} snapshot
 * @property {string|null} headSha - HEAD as the port answered it (`null` when it could not).
 */

/**
 * @param {string} code
 * @param {string} reason
 * @param {ReturnType<typeof readSnapshotIdentity>} snapshot
 * @param {string|null} headSha
 * @returns {DeterministicEvidenceVerdict}
 */
function refuse(code, reason, snapshot, headSha) {
  return { ok: false, code, reason, snapshot, headSha };
}

/** An identity nobody recorded, for the early refusals. */
const NO_IDENTITY = Object.freeze({ gitSha: null, gitDirty: null, measuredAtMs: null });

/**
 * Does the snapshot's sha name HEAD? Full ids must match exactly; an
 * abbreviation of at least {@link MIN_ABBREV} digits must be a prefix of HEAD.
 *
 * @param {string} snapshotSha - lowercase hex, 7-40 digits (already allowlisted)
 * @param {string} headSha
 * @returns {boolean}
 */
function shaNamesHead(snapshotSha, headSha) {
  if (snapshotSha.length === headSha.length) return snapshotSha === headSha;
  if (snapshotSha.length < MIN_ABBREV || snapshotSha.length > headSha.length) return false;
  return headSha.startsWith(snapshotSha);
}

/**
 * Epoch ms of the VERIFY hand-out, from the journal row's ISO `at` (or a number).
 * @param {unknown} verifyStartedAt
 * @returns {number|null}
 */
function handOutMs(verifyStartedAt) {
  if (typeof verifyStartedAt === 'number') return Number.isFinite(verifyStartedAt) ? verifyStartedAt : null;
  if (typeof verifyStartedAt !== 'string') return null;
  const ms = Date.parse(verifyStartedAt);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Read the snapshot text through the port; a throwing or non-string answer is `null`.
 * @param {{readFile?: (p: string) => string|null}} ports
 * @param {string} repoRoot
 * @returns {string|null}
 */
function readSnapshotText(ports, repoRoot) {
  if (typeof ports?.readFile !== 'function') return null;
  try {
    const raw = ports.readFile(path.join(repoRoot, ...RESULT_FILE_RELPATH.split('/')));
    return typeof raw === 'string' ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Resolve HEAD through the port; a throwing or non-hex answer is `null`.
 * @param {{headSha?: (cwd: string) => string|null}} ports
 * @param {string} repoRoot
 * @returns {string|null}
 */
function resolveHead(ports, repoRoot) {
  if (typeof ports?.headSha !== 'function') return null;
  try {
    const raw = ports.headSha(repoRoot);
    return typeof raw === 'string' && /^[0-9a-f]{40}$/.test(raw.trim()) ? raw.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Decide rule 7 for one REPORT.
 *
 * @param {{readFile: (p: string) => string|null, headSha: (cwd: string) => string|null}} ports
 * @param {object} p
 * @param {string|null|undefined} p.repoRoot - Root of the checkout being reported on.
 * @param {string|number|null|undefined} p.verifyStartedAt - The VERIFY `started`
 *   journal row's `at` (ISO string) — the hand-out instant the run must postdate.
 * @param {number} [p.nowMs] - Wall clock, for the source's future-skew guard only.
 * @returns {DeterministicEvidenceVerdict}
 */
export function evaluateDeterministicEvidence(ports, { repoRoot, verifyStartedAt, nowMs } = {}) {
  const C = DETERMINISTIC_EVIDENCE_CODES;
  if (typeof repoRoot !== 'string' || repoRoot === '') {
    return refuse(C.MISSING, 'no repo root to read the vitest snapshot from', NO_IDENTITY, null);
  }
  const text = readSnapshotText(ports, repoRoot);
  if (text === null) return refuse(C.MISSING, REASONS.absent, NO_IDENTITY, null);

  const snapshot = readSnapshotIdentity(text);
  if (snapshot.gitSha === null) {
    return refuse(C.MISSING, 'the vitest snapshot carries no git identity (pre-v3 reporter, or git '
      + 'was unavailable when it ran) — it cannot be bound to this tree', snapshot, null);
  }
  const head = resolveHead(ports, repoRoot);
  if (head === null) {
    return refuse(C.MISSING, 'HEAD of the repo root could not be resolved (not a git repository, '
      + 'or git unavailable) — the snapshot cannot be compared to this tree', snapshot, null);
  }
  if (!shaNamesHead(snapshot.gitSha, head)) {
    return refuse(C.STALE, `the vitest snapshot measured ${snapshot.gitSha.slice(0, 12)}, HEAD is `
      + `${head.slice(0, 12)} — that run did not cover this checkout`, snapshot, head);
  }
  const startedMs = handOutMs(verifyStartedAt);
  if (startedMs === null) {
    return refuse(C.MISSING, 'the VERIFY hand-out instant is unusable — freshness against the '
      + 'attempt is not decidable', snapshot, head);
  }

  const layer = deterministicLayerFrom({ resultJsonText: text, markerMtimeMs: startedMs, nowMs });
  if (layer.exitCode === undefined) {
    const code = layer.reason === REASONS.stale ? C.STALE : C.MISSING;
    const why = layer.reason === REASONS.stale
      ? 'the vitest snapshot predates this VERIFY hand-out — that run did not cover this attempt'
      : layer.reason;
    return refuse(code, why, snapshot, head);
  }
  const dirty = snapshot.gitDirty === null ? '' : ` (tree ${snapshot.gitDirty ? 'dirty' : 'clean'} at run time)`;
  if (layer.exitCode !== 0) {
    return refuse(C.FAILED, `${layer.reason}${dirty} — the fresh run failed`, snapshot, head);
  }
  return { ok: true, code: null, reason: `${layer.reason}${dirty}`, snapshot, headSha: head };
}
