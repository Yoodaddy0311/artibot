#!/usr/bin/env node
/**
 * Stop hook — DEV Verify Gate.
 *
 * Stop ONLY: `hooks/dispatch-table.json` lists this file under the Stop slot
 * and not under SubagentStop. `resolveHookEventName` below still echoes a
 * SubagentStop payload correctly, because the hook is spawnable by hand and a
 * wrong event name in advisory output would be a lie — but no dispatcher
 * sends one today.
 *
 * Conditionally surfaces the DEV verify checklist (DECOMPOSE → EXECUTE → VERIFY)
 * to the model AFTER turns that modified code. Read-only / diagnostic turns
 * skip this entirely — enforcing EXECUTE/VERIFY on a turn with no edits is
 * overkill and was the source of repeating "pending verification" loops.
 *
 * Replaces the previous `prompt`-type Stop hook entry which fired
 * unconditionally on every Stop.
 *
 * Schema (mode-dependent — see lib/core/dev-verify-output.js):
 *   - enforce (default): `decision: "block" + reason` → block stop, model gets
 *     reason as feedback. Always-supported shape (every Claude Code version).
 *   - advisory: `hookSpecificOutput.additionalContext` → non-blocking soft
 *     feedback (Claude Code ≥ 2.1.163; silently dropped on older versions).
 *   - no output → allow stop (read-only turn)
 *
 * Mode source: ARTIBOT_DEV_VERIFY_MODE env > config.devProtocol.verifyMode >
 * 'enforce'. Default preserves the prior enforcing behavior.
 *
 * Loop guards:
 *   - `stop_hook_active === true` → bail (Claude Code retry after block)
 *   - SHA + file fingerprint cache (`runtime/last-dev-verify-sha.txt`)
 *     prevents repeated verification asks for the same working-tree state.
 *
 * Ledger side effect (OB-07): a fire also records four `verify.completed`
 * lines (three layers + overall). See {@link recordVerifyDenominator}. The
 * deterministic line carries a real `pass`/`fail` when — and only when — the
 * vitest reporter's output is at least as new as the last main-agent edit
 * (owner decision F1), read from the REPO root rather than the plugin root
 * (owner decision R1); the decision table lives in
 * `lib/verification/deterministic-source.js`. Every other case, and the other
 * two layers always, stay `unmeasured`. It is observation only: the write
 * cannot change what this hook prints, and the fingerprint cache above — not
 * the writer's idempotency key — is what keeps one working-tree state from
 * being counted twice. The record is written AFTER stdout, and no time budget
 * guards it — see the ordering note in `main()` for the dispatcher behaviour
 * that makes both of those safe.
 *
 * WHAT THIS RECORD CANNOT SEE (rules §9, next to the gate): whether the model
 * actually verified anything after being asked (the deterministic line reports
 * the last test run, which may predate the ask), lint / tsc / build (no hook
 * persists their exit codes, so those layers have no source at all), turns
 * where the gate correctly bailed, whether a reported run was the whole suite
 * or a targeted one (the counts ride in `evidence[0].note` so a reader can
 * judge), and any fire in a repo whose ledger is unwritable — that one is a
 * silent absence by design, since the alternative was to let a bookkeeping
 * failure break Stop.
 *
 * @module scripts/hooks/dev-verify-gate
 */

import path from 'node:path';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  atomicWriteSync,
  getPluginRoot,
  parseJSON,
  readStdin,
  resolveConfigPath,
  writeStdout,
} from '../utils/index.js';
import { createErrorHandler, isArtibotRepo, logHookError } from '../../lib/core/hook-utils.js';
import {
  getHeadSha as getCachedHeadSha,
  getRepoRoot as getCachedRepoRoot,
} from '../../lib/git/repo-root-cache.js';
import { buildDevVerifyOutput, resolveDevVerifyMode } from '../../lib/core/dev-verify-output.js';
import { isMainEntry } from './_main-entry.js';

const HOOK_NAME = 'dev-verify-gate';
const STATE_FILE = 'last-dev-verify-sha.txt';
const MARKER_FILE = 'last-main-agent-edit.timestamp';

// Single line on purpose: Claude Code ≥ 2.1.172 renders Stop-hook
// additionalContext verbatim in the terminal ("Stop hook feedback:") and
// suppressOutput cannot hide it (upstream anthropics/claude-code#67193).
// The full DECOMPOSE/EXECUTE/VERIFY checklist lives in plugins/artibot/
// CLAUDE.md (DEV Protocol), which the model already has in context.
const DEV_VERIFY_REASON =
  'DEV verify (CLAUDE.md DEV Protocol): report per-item evidence (file:line); ' +
  "flag anything unproven as 'Pending verification'.";

/**
 * Run a git command in the given cwd, returning stdout verbatim.
 * Not trimmed: the sole caller parses NUL-separated `-z` output, where a path
 * may legitimately begin or end with a space.
 * Returns null on failure (silent — git unavailable / not a repo).
 *
 * @param {string} cmd
 * @param {string} [cwd]
 * @returns {string|null}
 */
function git(cmd, cwd) {
  try {
    return execSync(cmd, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
      windowsHide: true,
    });
  } catch (err) {
    logHookError(HOOK_NAME, `git failed: ${cmd}`, err);
    return null;
  }
}

/** @returns {string|null} */
function getRepoRoot() {
  return getCachedRepoRoot();
}

/** @returns {string|null} */
function getHeadSha(repoRoot) {
  return getCachedHeadSha(repoRoot);
}

/**
 * Files written by other Stop hooks that race with this gate. Excluded so
 * the gate doesn't spuriously fire on its own dispatcher's side-effects.
 *
 * Background: session-notes.js appends to .artibot/SESSION-NOTES.md during
 * Stop. Because Stop hooks run in parallel (Promise.allSettled in
 * _stop-dispatcher.js), dev-verify-gate often observes the dirty file
 * before git-autopilot-close.js commits it, producing a false-positive
 * DECOMPOSE/EXECUTE/VERIFY ask on read-only turns.
 *
 * @type {Set<string>}
 */
const EXCLUDED_FILES = new Set([
  '.artibot/SESSION-NOTES.md',
]);

/**
 * Collect changed files vs HEAD: working tree + staged.
 * Last-commit (HEAD~1..HEAD) is intentionally excluded — already-committed
 * changes from a prior turn shouldn't re-trigger DEV verify.
 *
 * @param {string} repoRoot
 * @returns {string[]}
 */
function getChangedFiles(repoRoot) {
  const merged = new Set();
  // `-z` : NUL-separated output. It also suppresses `core.quotepath`, though
  // that axis is inert here — these paths are never dereferenced, only counted,
  // matched against EXCLUDED_FILES, and folded into the fingerprint.
  // The axis that DID bite: a leading/trailing space is not C-quoted by git, so
  // the old per-line `.trim()` silently rewrote " .artibot/SESSION-NOTES.md"
  // into the excluded name and the gate went quiet on a file it should flag.
  for (const cmd of [
    'git diff --name-only -z HEAD',
    'git diff --name-only -z --cached',
  ]) {
    const out = git(cmd, repoRoot);
    if (!out) continue;
    for (const file of out.split('\0')) {
      if (file && !EXCLUDED_FILES.has(file)) merged.add(file);
    }
  }
  return [...merged];
}

/**
 * Build the cache fingerprint for loop-guard.
 *
 * Includes a short hash of `repoRoot` so different worktrees / repos sharing
 * one plugin install don't collide on the same fingerprint file (worktree A's
 * Stop would otherwise suppress worktree B's DEV verify reminder).
 *
 * @param {string} repoRoot
 * @param {string} sha
 * @param {string[]} files
 * @returns {string}
 */
function buildFingerprint(repoRoot, sha, files) {
  // 32-bit SHA1 truncation: collision impact = one suppressed DEV verify
  // reminder. Not a security boundary — purely a deduplication key.
  const repoHash = createHash('sha1').update(repoRoot).digest('hex').slice(0, 8);
  return `${repoHash}|${sha}|${files.slice().sort().join(',')}`;
}

/**
 * @param {string} pluginRoot
 * @returns {string}
 */
function readLastFingerprint(pluginRoot) {
  try {
    const filePath = path.join(pluginRoot, 'runtime', STATE_FILE);
    if (!existsSync(filePath)) return '';
    return readFileSync(filePath, 'utf-8').trim();
  } catch {
    return '';
  }
}

/**
 * @param {string} pluginRoot
 * @param {string} fingerprint
 */
function saveFingerprint(pluginRoot, fingerprint) {
  try {
    const filePath = path.join(pluginRoot, 'runtime', STATE_FILE);
    atomicWriteSync(filePath, fingerprint + '\n');
  } catch (err) {
    logHookError(HOOK_NAME, 'failed to persist fingerprint', err);
  }
}

/**
 * Has the main orchestrator agent made an edit since the last gate fire?
 *
 * Compares `runtime/last-main-agent-edit.timestamp` (written by the
 * mark-main-agent-edit PostToolUse hook on Edit/Write/MultiEdit, only when
 * NOT inside a subagent context) against `runtime/last-dev-verify-sha.txt`
 * (written by this gate after a successful fire).
 *
 * Decision matrix:
 *   - marker missing       → no main-agent edits have ever fired   → bail (false)
 *   - cache missing        → first run, no baseline                → fire (true)
 *   - marker mtime > cache → new main-agent edits since last fire → fire (true)
 *   - marker mtime ≤ cache → no NEW edits (or only teammate edits) → bail (false)
 *
 * The "marker missing → bail" branch is critical: a fresh checkout with
 * dirty working-tree (e.g. an in-progress branch resumed from another
 * machine) must NOT spuriously fire the verify ask, because the orchestrator
 * has not actually edited anything in this session yet.
 *
 * @param {string} pluginRoot
 * @returns {boolean} true → fire gate, false → bail
 */
function hasNewerMainAgentEdit(pluginRoot) {
  const markerPath = path.join(pluginRoot, 'runtime', MARKER_FILE);
  const cachePath = path.join(pluginRoot, 'runtime', STATE_FILE);

  if (!existsSync(markerPath)) return false;
  if (!existsSync(cachePath)) return true;

  try {
    const markerMtime = statSync(markerPath).mtimeMs;
    const cacheMtime = statSync(cachePath).mtimeMs;
    return markerMtime > cacheMtime;
  } catch {
    return true; // stat failure — be safe, fire
  }
}

/**
 * Resolve the DEV-verify enforcement mode from config + env. Best-effort: a
 * missing/unreadable config falls back to the env override or the 'enforce'
 * default — config IO must never break the Stop slot.
 *
 * @returns {'enforce'|'advisory'}
 */
function loadVerifyMode() {
  let config = {};
  try {
    const configPath = resolveConfigPath('artibot.config.json');
    config = JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch {
    // No config / unreadable — resolveDevVerifyMode applies env + default.
  }
  return resolveDevVerifyMode(config);
}

/**
 * Pick the hookSpecificOutput event name from the inbound payload. Stop and
 * SubagentStop share this gate; advisory output must echo the right event.
 *
 * @param {object} hookData
 * @returns {'Stop'|'SubagentStop'}
 */
function resolveHookEventName(hookData) {
  return hookData?.hook_event_name === 'SubagentStop' ? 'SubagentStop' : 'Stop';
}

/**
 * Record the verification measurement for this fire: one `verify.completed`
 * line per layer plus the overall line.
 *
 * WHICH LINE CAN CARRY A VERDICT, AND WHY ONLY THAT ONE. This gate ASKS the
 * model to verify; it runs nothing itself, so it may only report measurements
 * something else left behind. Exactly one such artefact exists:
 * `tests/reporters/test-status-reporter.js` writes the last `npm test` outcome
 * to `<repoRoot>/plugins/artibot/runtime/last-test-result.json` (owner decision
 * R1 — the installed plugin copy never has one, so resolving it against
 * `pluginRoot` would pin the live numerator at zero). That file becomes a
 * `pass`/`fail` on the DETERMINISTIC line only when it is at least as new as
 * `runtime/last-main-agent-edit.timestamp` (owner decision F1 — no TTL, because
 * a time window lets a stale green outlive the edit that invalidated it).
 * Anything else — absent, corrupt, undated, no marker, stale, or a run that
 * collected ZERO tests (`failed === 0` is true of a suite that never ran, so
 * the count is checked, not the status) — stays `unmeasured`, with the branch
 * recorded in the verdict `reason` and therefore in the `verification_id` hash. `lib/verification/deterministic-source.js`
 * holds that decision table and the pinned hashes are in its test.
 *
 * Behavioral and operational remain `unmeasured` unconditionally: there is no
 * behavioral runner and no source of operational readings. Writing a PASS for
 * either would be the exact false measurement the ledger exists to prevent, and
 * writing nothing at all — the behaviour before OB-07 — loses the DENOMINATOR
 * that makes "how often was the gate answered?" answerable. So every fire still
 * emits all four lines under one `verification_id` other lines can join on.
 *
 * WHY THE IMPORTS ARE LAZY. A static `import` of a module that throws while it
 * is evaluated kills the process before `main()` exists, and this hook's ONLY
 * contract is the stdout envelope. Deferring the six `lib/` modules into this
 * function puts an import-time throw inside the caller's catch, the same way
 * `scripts/hooks/intent-observe-pre.js#loadDeps` (:93) does. stdout is then
 * byte-identical whether the ledger write succeeds, is rejected, or never loads.
 *
 * WHY THE FS PORTS ARE INJECTED RATHER THAN IMPORTED BY THE SOURCE MODULE.
 * `deterministic-source.js` is L2 and pure — no `node:fs` at all — so its
 * decision table is testable without a filesystem and the only IO in this path
 * is the three calls below. Both are wrapped by the same catch as the ledger
 * write, so a permission error on the result file costs a measurement, never
 * the DEV verify ask.
 *
 * WHY `existingKeys` IS NOT WRAPPED IN A CATCH. `verify-writer.js#readExistingKeys`
 * (:466) turns a throwing port into "reject every line", and its header says why
 * that is deliberate and stricter than `scripts/hooks/session-end.js#existingReceiptKeys`
 * (:576): a duplicated `verify.completed` inflates the reader's per-layer tally
 * into a false measurement, while a line that was never written is a visible
 * absence. A denominator prefers the absence, so the throw is left to propagate
 * into the writer's own guard rather than swallowed here.
 *
 * NO TIME BUDGET GUARDS THIS, AND NONE IS NEEDED. Both the ledger read and the
 * append are SYNCHRONOUS fs calls, so a call already under way cannot be
 * interrupted; any budget could only be a precheck between steps. The caller
 * removes the need for one by printing stdout FIRST — see `main()`. A budget
 * measured from `main()` entry would also have been mostly spent on the three
 * `git` subprocesses above it (measured 2026-09-14 09:30 KST: median 1040ms,
 * p95 1355ms before this function is even called), so it would refuse valid
 * records on a busy machine — losing the denominator it was meant to protect.
 *
 * THE EVIDENCE REGISTRY IS OPTIONAL, SO ITS IMPORT FAILS ALONE. The registry
 * port is bound to the SAME `repoRoot` as the ledger append, so a row lands
 * beside the line it points at. Its two modules (the registry and the ledger's
 * redaction) are loaded in the same lazy batch but caught on their own promise
 * — see {@link loadEvidenceDeps}: joined bare into `Promise.all`, a registry
 * that fails to load would reject the whole batch and cost the four ledger
 * lines — trading the denominator for a side index of it. A failed load leaves
 * the port absent, and an absent port is the writer's exact pre-registry path
 * (`verify-writer.js#recordVerification` returns the same tally shape without
 * it). A port that fails at CALL time never throws out of the writer, which
 * folds it into `evidence.reason` and leaves the tally alone. Both failures are
 * therefore invisible on stdout; the load one is logged to stderr, the same
 * channel as every other failure in this function.
 *
 * @param {string} repoRoot Ledger root — the writer derives the file from it,
 *   and the vitest result file is resolved against it (R1). The evidence
 *   registry is bound to it too.
 * @param {string} pluginRoot Root the edit marker lives under. Passed in rather
 *   than re-resolved so this reads the SAME root `main()` already gated on.
 * @param {object} hookData Raw Stop payload; `session_id` is the join key.
 * @returns {Promise<object>} the writer's tally (`appended`/`deduped`/
 *   `rejected`/`skipped`). `skipped: 1` means the payload carried no
 *   `session_id`, which the writer refuses — no id is invented here.
 */
async function recordVerifyDenominator(repoRoot, pluginRoot, hookData) {
  const [verifier, writer, ledger, source, evidenceDeps] = await Promise.all([
    import('../../lib/verification/unified-verifier.js'),
    import('../../lib/verification/verify-writer.js'),
    import('../../lib/runtime/ledger.js'),
    import('../../lib/verification/deterministic-source.js'),
    loadEvidenceDeps(),
  ]);

  const layers = source.readDeterministicLayer(
    {
      readFile: (file) => (existsSync(file) ? readFileSync(file, 'utf-8') : null),
      statMtimeMs: (file) => (existsSync(file) ? statSync(file).mtimeMs : null),
    },
    { repoRoot, pluginRoot, nowMs: Date.now() },
  );

  const sessionId = typeof hookData?.session_id === 'string' ? hookData.session_id : undefined;
  // `mission_id` is passed through ONLY when the host declared one, matching
  // `session-end.js:534`. The writer derives a session-scoped fallback itself,
  // and reading the ledger a second time to resolve the current mission would
  // cost more than the line is worth.
  const missionId = typeof hookData?.mission_id === 'string' ? hookData.mission_id : undefined;

  return writer.recordVerification(
    verifier.verify({ layers }),
    { sessionId, missionId },
    {
      append: (input) => ledger.appendLedgerEvent(repoRoot, input),
      existingKeys: () => {
        const events = ledger.readAllEvents(repoRoot, {
          session_id: sessionId,
          event: writer.VERIFY_COMPLETED_EVENT,
        });
        const keys = [];
        for (const event of events) {
          const key = event?.idempotency_key;
          if (typeof key === 'string' && key.length > 0) keys.push(key);
        }
        return keys;
      },
      ...(evidenceDeps === null ? {} : {
        registerEvidence: (entries, lineKey) => evidenceDeps.registry.registerEvidence(
          redactAsStored(entries, evidenceDeps.redaction.redactDeep),
          { projectRoot: repoRoot, source: lineKey },
        ),
      }),
    },
  );
}

/**
 * Load the registry AND the ledger's redaction together, or neither.
 *
 * The pair is one dependency: a registry without redaction would hash the raw
 * entry, keeping a hash of a secret the ledger scrubbed — an offline oracle for
 * it (review F1). So if EITHER fails to load the port is dropped rather than
 * bound to unredacted input, and the ledger lines are written exactly as they
 * were before the registry existed.
 *
 * @returns {Promise<{registry: object, redaction: object}|null>}
 */
async function loadEvidenceDeps() {
  try {
    const [registry, redaction] = await Promise.all([
      import('../../lib/verification/evidence-registry.js'),
      import('../../lib/runtime/ledger-redaction.js'),
    ]);
    return { registry, redaction };
  } catch (err) {
    logHookError(HOOK_NAME, 'evidence registry unavailable, recording without it', err);
    return null;
  }
}

/**
 * The evidence exactly as the ledger line stores it, so a registry row's hash
 * is the hash of the entry on the line its `source` names.
 *
 * Redacted AT THE ENVELOPE'S OWN POSITION, not as a bare array.
 * `lib/runtime/ledger-redaction.js#walk` counts both its depth bound and its
 * node budget from the root it is handed, and
 * `lib/runtime/event-writer.js#assembleAndAppend` hands it the whole envelope,
 * where evidence sits at `data.evidence` (depth 2) behind exactly two object
 * nodes. A bare `redactDeep(entries)` cuts a note nested 61+ levels two levels
 * lower than the ledger does, so its hash matches nothing that was written.
 * Every other envelope key is a scalar, which is why this two-level wrapper is
 * the whole of the offset.
 *
 * Exported as a test seam only, and the redaction function is PASSED IN rather
 * than imported, so the ledger-redaction module stays inside the lazy load of
 * {@link loadEvidenceDeps}: importing this hook loads neither the registry nor
 * the redaction module (its static `lib/` imports are unchanged).
 *
 * @param {Array<unknown>} entries one appended line's `data.evidence`
 * @param {(value: unknown) => unknown} redactDeep `ledger-redaction.js#redactDeep`
 * @returns {Array<unknown>}
 */
export function redactAsStored(entries, redactDeep) {
  return redactDeep({ data: { evidence: entries } }).data.evidence;
}

export async function main() {
  // v4.5.8: emergency disable removed. The marker-file pattern below now
  // distinguishes main-agent edits (gate fires) from teammate edits and
  // working-tree drift (gate bails). See `mark-main-agent-edit.js` for the
  // PostToolUse hook that writes the marker.

  const raw = await readStdin();
  const hookData = parseJSON(raw) ?? {};

  // Loop guard: Claude Code sets stop_hook_active=true when re-running Stop
  // hooks after a previous block. Bail to prevent infinite block→retry loops.
  if (hookData.stop_hook_active === true) return;

  const repoRoot = getRepoRoot();
  if (!repoRoot) return;

  // Scope guard: DEV verify is an Artibot-internal policy. Bail silently in
  // any other project the user happens to be working in (the plugin installs
  // globally, so the Stop hook would otherwise fire everywhere).
  if (!isArtibotRepo(repoRoot)) return;

  const changedFiles = getChangedFiles(repoRoot);
  // Read-only / diagnostic turn — no DEV verify needed.
  if (changedFiles.length === 0) return;

  const pluginRoot = getPluginRoot();

  // Marker check: did the main orchestrator agent edit anything since the
  // last verify fire? If not (only teammates edited, or only working-tree
  // drift like autopilot WIP commits), bail. This is the v4.5.8 fix for
  // the v4.5.6 paralysis bug where every orchestrator Stop while teammates
  // were mid-edit got blocked with a spurious "Pending verification" ask.
  if (!hasNewerMainAgentEdit(pluginRoot)) return;

  const headSha = getHeadSha(repoRoot) || 'unknown';
  const fingerprint = buildFingerprint(repoRoot, headSha, changedFiles);
  if (readLastFingerprint(pluginRoot) === fingerprint) return; // already verified

  saveFingerprint(pluginRoot, fingerprint);

  // Mode-aware output: 'enforce' (default) blocks the stop; 'advisory' surfaces
  // the same checklist as non-blocking 2.1.163 additionalContext feedback.
  const mode = loadVerifyMode();
  const hookEventName = resolveHookEventName(hookData);
  writeStdout(buildDevVerifyOutput(DEV_VERIFY_REASON, { mode, hookEventName }));

  // STDOUT FIRST, LEDGER SECOND — and that ordering is the whole guard against a
  // slow ledger costing the model its DEV verify ask.
  //
  // `scripts/hooks/_dispatcher-utils.js#spawnHook` (:110) collects this child's
  // stdout into `chunks` as it arrives and, when the 8000ms timer fires, sends
  // SIGTERM and still RESOLVES with everything collected so far
  // (`finish('timeout')` :145 → `finish` :122-126). `_stop-dispatcher.js:74-76`
  // then reads ONLY `r.value.stdout` and never looks at `r.value.status`. So a
  // decision already written to stdout survives the timeout intact, and the
  // fail-open window for the block decision is ZERO no matter how long the
  // ledger takes. That is simpler than any budget, and it is why no budget is
  // armed here.
  //
  // The precedent that records BEFORE stdout, `scripts/hooks/subagent-handler.js
  // #handleStop` (:751-769), is not in conflict: its stdout is
  // `{ message: '[team] Agent deregistered: …' }`, which carries no decision, so
  // losing it costs a log line rather than a gate.
  //
  // UNMEASURED: on Windows a piped stdout write is asynchronous, so whether the
  // bytes are flushed before a SIGTERM that lands in the same tick is not
  // something this comment has tested.
  //
  // The record itself is a SIDE EFFECT ONLY: the tally is not read, nothing
  // branches on it, and every failure mode (import, read, append) is absorbed.
  try {
    await recordVerifyDenominator(repoRoot, pluginRoot, hookData);
  } catch (err) {
    logHookError(HOOK_NAME, 'failed to record the verify denominator', err);
  }
}

// Direct-run guard: importing this module (tests) must not execute the hook.
// main() blocks on stdin, so an import both hangs the importer and fires the
// hook's side effects. Production is unaffected — the dispatcher (or Claude
// Code) spawns this file as argv[1], so the guard passes there.
if (isMainEntry(import.meta.url)) {
  main().catch(createErrorHandler(HOOK_NAME, { exit: false }));
}
