#!/usr/bin/env node
/**
 * PostCompact hook — rehydrate the compacted context (vNext PR-CX01).
 *
 * Closes the loop `scripts/hooks/pre-compact.js` left open: that hook has
 * written `~/.claude/artibot-pre-compact.json` since AD-40 and NOTHING read
 * it back (measured 2026-09-02: `rg artibot-pre-compact` → writer + its two
 * tests only). This hook reads it, checks it belongs to the tree we are in,
 * folds it with the latest HANDOFF pointer, `/split` run files and lane
 * briefs into a ≤ `maxRehydrateBytes` bundle
 * (`lib/context/rehydration.js`), saves the bundle + the harness's
 * `compact_summary`, and reports.
 *
 * ── Hook contract (per claude-code-guide, 2026-09-02, code.claude.com/docs/en/hooks) ──
 *   stdin  : { session_id, cwd, permission_mode, hook_event_name: "PostCompact",
 *              compact_trigger: "manual"|"auto", compact_summary }
 *   stdout : `{ "systemMessage": … }` is honoured (user-visible). PostCompact
 *            does NOT support `additionalContext` and plain stdout is NOT
 *            added to the model context; it cannot block (exit 2 is
 *            meaningless). The documented way to put text INTO the model's
 *            context after compaction is `SessionStart` with matcher
 *            `"compact"` (plain stdout is injected there).
 *   So: on PostCompact this hook emits `systemMessage` + file pointers. When
 *   it is invoked for `SessionStart` with `source === "compact"` (a
 *   registration the leader may add) it prints the bundle as plain text,
 *   which that event injects. Any other SessionStart source → silent.
 *
 * ── Behaviour contract ───────────────────────────────────────────────────────
 *   - never throws; stdout carries nothing but the JSON / bundle
 *   - automation 0: reads, writes its own two files, reports
 *   - wrong branch/worktree snapshot is NOT injected — the bundle says so
 *   - budget 8s (hooks.json); git calls are shell-free with 2s timeouts
 *   - gated by `split.contextLifecycle` (read with defaults, config not edited here):
 *       enabled: false (ships OFF — S0: exit 0 with zero bytes on stdout AND stderr),
 *       postCompactRehydrate: true, maxRehydrateBytes: 10240
 *     Env `ARTIBOT_CONTEXT_LIFECYCLE_JSON` (a JSON object) overlays those keys —
 *     the test seam and an operator's per-shell override.
 *
 * Files written (both under `~/.claude`, never in the repo):
 *   `~/.claude/artibot-post-compact.json`            latest run, machine-readable
 *   `~/.claude/artibot/post-compact/<stamp>.md`      the bundle text + full compact_summary
 *
 * @module scripts/hooks/post-compact-rehydrate
 */

import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseJSON, readStdin, writeStdout } from '../utils/index.js';
import { createErrorHandler, getClaudeDir, logHookError } from '../../lib/core/hook-utils.js';
import { loadConfig } from '../../lib/core/config.js';
import { resolveProjectRoot } from '../../lib/git/project-root.js';
import { readLatestHandoff } from '../../lib/handoff/handoff-store.js';
import { buildRehydrationBundle, DEFAULT_MAX_BYTES, reportContextReceipt } from '../../lib/context/rehydration.js';
import { buildContextPressureEvent, computeContextPressure, estimateTokens } from '../../lib/context/context-pressure.js';
import { appendEvent } from '../../lib/supervisor/run-store.js';
import { isMainEntry } from './_main-entry.js';

const HOOK_NAME = 'post-compact-rehydrate';
const ENV_OVERRIDE = 'ARTIBOT_CONTEXT_LIFECYCLE_JSON';
const MAX_BRIEFS = 2;
const log = (msg) => process.stderr.write(`[artibot:${HOOK_NAME}] ${msg}\n`);

/**
 * Defaults the leader will mirror into `artibot.config.json#split.contextLifecycle`.
 */
export const LIFECYCLE_DEFAULTS = Object.freeze({
  enabled: false,
  postCompactRehydrate: true,
  maxRehydrateBytes: DEFAULT_MAX_BYTES,
  // Where `appendEvent` writes the supervisor stream. null = the store's own
  // default (`lib/observability/split-telemetry.js#getSplitStoreDir`). This is
  // a TEST SEAM: production config names no directory, and no new env var was
  // added for it — it rides the one overlay that already exists.
  supervisorStoreDir: null,
});

/**
 * Resolve the lifecycle settings: defaults ← config ← env overlay. Never throws.
 * @param {object|null} config
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ enabled: boolean, postCompactRehydrate: boolean, maxRehydrateBytes: number,
 *            supervisorStoreDir: string|null }}
 */
export function resolveLifecycle(config, env = process.env) {
  const fromConfig = config?.split?.contextLifecycle && typeof config.split.contextLifecycle === 'object'
    ? config.split.contextLifecycle : {};
  let fromEnv = {};
  if (typeof env[ENV_OVERRIDE] === 'string' && env[ENV_OVERRIDE]) {
    const parsed = parseJSON(env[ENV_OVERRIDE]);
    if (parsed && typeof parsed === 'object') fromEnv = parsed;
  }
  const merged = { ...LIFECYCLE_DEFAULTS, ...fromConfig, ...fromEnv };
  return {
    enabled: merged.enabled === true,
    postCompactRehydrate: merged.postCompactRehydrate !== false,
    maxRehydrateBytes: Number.isInteger(merged.maxRehydrateBytes) && merged.maxRehydrateBytes > 0
      ? merged.maxRehydrateBytes : DEFAULT_MAX_BYTES,
    supervisorStoreDir: typeof merged.supervisorStoreDir === 'string' && merged.supervisorStoreDir
      ? merged.supervisorStoreDir : null,
  };
}

/**
 * Shell-free git, 2s budget, never throws.
 * @param {string[]} args
 * @param {string} cwd
 * @returns {string|null}
 */
function git(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000, windowsHide: true,
    }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * @param {string} cwd
 * @returns {{ cwd: string, branch: string|null, head: string|null }}
 */
export function captureCurrentIdentity(cwd) {
  return {
    cwd,
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd),
    head: git(['rev-parse', '--short=12', 'HEAD'], cwd),
  };
}

/**
 * @param {string} file
 * @returns {object|null}
 */
function readJsonSafe(file) {
  try {
    if (!existsSync(file)) return null;
    const v = JSON.parse(readFileSync(file, 'utf-8'));
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

/**
 * Collect `/split` evidence for the bundle: `run.json` + `plan.json` from the
 * project root, lane briefs from `<cwd>/.artibot/split/<limb>/brief.md`
 * (the copy `materializeLimb` places in a limb worktree). Read-only; each
 * read is individually guarded.
 *
 * @param {string} cwd
 * @param {string} projectRoot
 * @returns {{ runJson: object|null, planJson: object|null, briefs: Array<{ limb: string, path: string, text: string }> }}
 */
export function collectSplitEvidence(cwd, projectRoot) {
  const rootSplit = path.join(projectRoot, '.artibot', 'split');
  const out = {
    runJson: readJsonSafe(path.join(rootSplit, 'run.json')),
    planJson: readJsonSafe(path.join(rootSplit, 'plan.json')),
    briefs: [],
  };
  const cwdSplit = path.join(cwd, '.artibot', 'split');
  try {
    if (!existsSync(cwdSplit)) return out;
    for (const entry of readdirSync(cwdSplit, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const brief = path.join(cwdSplit, entry.name, 'brief.md');
      if (!existsSync(brief)) continue;
      try {
        out.briefs.push({ limb: entry.name, path: brief, text: readFileSync(brief, 'utf-8') });
      } catch { /* unreadable brief — skip */ }
      if (out.briefs.length >= MAX_BRIEFS) break;
    }
  } catch { /* no split dir */ }
  return out;
}

/**
 * Persist the bundle. Returns the paths written (null on failure), never throws.
 * @param {object} record
 * @param {string} bundleText
 * @param {string} claudeDir
 * @returns {{ jsonPath: string|null, mdPath: string|null }}
 */
function persist(record, bundleText, claudeDir) {
  const result = { jsonPath: null, mdPath: null };
  const stamp = String(record.savedAt).replace(/[:.]/g, '-');
  try {
    const dir = path.join(claudeDir, 'artibot', 'post-compact');
    mkdirSync(dir, { recursive: true });
    const mdPath = path.join(dir, `post-compact-${stamp}.md`);
    const md = [
      bundleText,
      '',
      '---',
      '## compact_summary (verbatim from the harness)',
      '',
      record.compactSummary ?? '(none)',
      '',
    ].join('\n');
    writeFileSync(mdPath, md, 'utf-8');
    result.mdPath = mdPath;
  } catch (err) {
    logHookError(HOOK_NAME, 'failed to write bundle markdown', err);
  }
  try {
    mkdirSync(claudeDir, { recursive: true });
    const jsonPath = path.join(claudeDir, 'artibot-post-compact.json');
    writeFileSync(jsonPath, JSON.stringify({ ...record, bundlePath: result.mdPath }, null, 2), 'utf-8');
    result.jsonPath = jsonPath;
  } catch (err) {
    logHookError(HOOK_NAME, 'failed to write post-compact json', err);
  }
  return result;
}

/**
 * Score how full the context window was (vNext PR-CX02). RECORD ONLY — the
 * `recommendation` string is never acted on here, and no worker is rotated.
 *
 * A REFUSED snapshot is never scored. It describes another worktree's
 * session, so its token counts are somebody else's; producing a number from
 * them would look exactly like a measurement of this session.
 *
 * The only capacity this hook may use is the host's own
 * `context_window.max_tokens`. `MODELS[tier].ctxLimit` is the catalog's
 * capacity, but only a caller that knows its tier can read it, and a
 * PostCompact payload names no model — so when the host reports no capacity
 * the result is an unscored `capacity-unknown`, not a borrowed number.
 *
 * @param {object|null} snapshot - the PreCompact snapshot
 * @param {object} hookData
 * @param {boolean} identityOk
 * @returns {{ pressure: object, capacitySource: string|null }}
 */
function scorePressure(snapshot, hookData, identityOk) {
  if (!identityOk) {
    return {
      pressure: { score: null, level: null, recommendation: 'none', reason: 'snapshot-refused' },
      capacitySource: null,
    };
  }
  const cw = snapshot?.contextWindow && typeof snapshot.contextWindow === 'object' ? snapshot.contextWindow : null;
  const hostMax = typeof cw?.max_tokens === 'number' && Number.isFinite(cw.max_tokens) && cw.max_tokens > 0
    ? cw.max_tokens : null;
  return {
    pressure: computeContextPressure({
      currentTokens: cw?.current_tokens,
      maxTokens: hostMax,
      tokenEstimate: snapshot?.tokenEstimate,
      transcriptBytes: snapshot?.transcriptBytes,
      compactTrigger: hookData.compact_trigger,
    }),
    capacitySource: hostMax !== null ? 'context_window.max_tokens' : null,
  };
}

/**
 * Append one `context-pressure` envelope to the run's supervisor stream, when
 * there is a run to attach it to. Write-only: nothing reads this back, nothing
 * rotates the file, and the reducer treats the type as a heartbeat.
 *
 * An unscored pressure is not appended — a null score in an append-only stream
 * is a row that can only ever be skipped by a reader.
 *
 * @param {object} pressure - a {@link scorePressure} result
 * @param {{ runJson: object|null, briefs: Array<{ limb: string }> }} split
 * @param {string|null} sessionId
 * @param {string|null} storeDir
 * @returns {{ appended: boolean, runId?: string, reason?: string, errors?: string[]|null }}
 */
function emitPressureEvent(pressure, split, sessionId, storeDir) {
  if (pressure.score === null) return { appended: false, reason: `not-scored:${pressure.reason ?? 'unknown'}` };
  const runId = typeof split.runJson?.runId === 'string' && split.runJson.runId ? split.runJson.runId : null;
  if (!runId) return { appended: false, reason: 'no-split-run' };
  const event = buildContextPressureEvent(pressure, { laneId: split.briefs[0]?.limb ?? null, sessionId });
  try {
    const res = appendEvent(runId, event, storeDir ? { storeDir } : {});
    return res.appended
      ? { appended: true, runId }
      : { appended: false, runId, reason: 'append-refused', errors: res.errors ?? null };
  } catch {
    // A hook may not die of its own bookkeeping.
    return { appended: false, runId, reason: 'append-threw' };
  }
}

/**
 * Assemble the Context Receipt and record the gap. `writer: null` is
 * DELIBERATE: measured 2026-09-12, the ledger writer refuses
 * `context.compiled` from `source: 'hook'` and records a `ledger.rejected`
 * line instead, so wiring a port here would write one rejection per
 * compaction and publish nothing. The eleven leaves this caller cannot fill
 * are recorded instead — see `lib/context/context-receipt.js`.
 *
 * @param {object} bundle
 * @param {object|null} snapshot
 * @param {string|null} compactSummary
 * @param {string|null} sessionId
 * @param {string} stamp
 * @returns {{ emitted: boolean, reason: string|null, missing: string[] }}
 */
function reportReceipt(bundle, snapshot, compactSummary, sessionId, stamp) {
  // Only a snapshot we accepted may supply the input side, and only from
  // `context_window.current_tokens`. NOT from `tokenEstimate`: the live
  // PreCompact payload carries no `messages`, so that field is saved as 1
  // (`scripts/hooks/pre-compact.js:328-330`). Passing the 1 through would
  // write a false measurement; leaving it out puts `input_tokens` in `missing`.
  const current = snapshot?.contextWindow?.current_tokens;
  const measuredInput = bundle.identity.ok && Number.isInteger(current) && current >= 0
    ? current
    : undefined;
  const r = reportContextReceipt({
    receiptInput: {
      receiptId: `ctx-${sessionId ? sessionId.slice(0, 8) : 'nosession'}-${stamp}`,
      missionId: null, // no mission is in scope at a compaction
      inputTokens: measuredInput,
      outputTokens: estimateTokens(compactSummary ?? '') + estimateTokens(bundle.text),
      protectedSections: [],
    },
    sessionId,
    source: 'hook',
    writer: null,
  });
  return { emitted: r.emitted, reason: r.reason, missing: r.missing };
}

/**
 * Read everything the bundle is folded from. Every read is individually
 * guarded: missing evidence degrades the bundle, it never stops the hook.
 *
 * @param {string} cwd
 * @param {string} snapshotPath
 * @param {object} hookData
 * @returns {Promise<{ snapshot: object|null, current: object, projectRoot: string,
 *                     handoff: object|null, split: object, compactSummary: string|null }>}
 */
async function gatherEvidence(cwd, snapshotPath, hookData) {
  let projectRoot = cwd;
  try {
    projectRoot = resolveProjectRoot(cwd) || cwd;
  } catch { /* keep cwd */ }
  let handoff = null;
  try {
    handoff = await readLatestHandoff(projectRoot);
  } catch { /* none */ }
  return {
    snapshot: readJsonSafe(snapshotPath),
    current: captureCurrentIdentity(cwd),
    projectRoot,
    handoff,
    split: collectSplitEvidence(cwd, projectRoot),
    compactSummary: typeof hookData.compact_summary === 'string' ? hookData.compact_summary : null,
  };
}

/**
 * @param {Awaited<ReturnType<typeof gatherEvidence>>} evidence
 * @param {string} snapshotPath
 * @param {string} plannedMdPath
 * @param {number} maxBytes
 * @returns {object} a {@link buildRehydrationBundle} result
 */
function composeBundle(evidence, snapshotPath, plannedMdPath, maxBytes) {
  const { snapshot } = evidence;
  return buildRehydrationBundle({
    snapshot,
    current: evidence.current,
    compactSummary: evidence.compactSummary,
    handoff: evidence.handoff,
    split: evidence.split,
    maxBytes,
    paths: {
      bundlePath: plannedMdPath,
      snapshotPath: snapshot ? snapshotPath : null,
      stateFilePath: typeof snapshot?.stateFilePath === 'string' ? snapshot.stateFilePath : null,
    },
  });
}

/**
 * The whole PR-CX02 measurement, in one place so `main` carries one line for
 * it. Record-only: none of these four fields reaches `systemMessage`.
 *
 * @param {{ evidence: object, hookData: object, bundle: object,
 *           sessionId: string|null, stamp: string, storeDir: string|null }} args
 * @returns {{ pressure: object, capacitySource: string|null,
 *             pressureEvent: object, contextReceipt: object }}
 */
function measureContext({ evidence, hookData, bundle, sessionId, stamp, storeDir }) {
  const { snapshot, split, compactSummary } = evidence;
  const { pressure, capacitySource } = scorePressure(snapshot, hookData, bundle.identity.ok);
  return {
    pressure,
    capacitySource,
    pressureEvent: emitPressureEvent(pressure, split, sessionId, storeDir),
    contextReceipt: reportReceipt(bundle, snapshot, compactSummary, sessionId, stamp),
  };
}

/**
 * The machine-readable record written to `~/.claude/artibot-post-compact.json`.
 *
 * @param {{ savedAt: string, event: string, sessionId: string|null, hookData: object,
 *           cwd: string, evidence: object, bundle: object, measured: object }} args
 * @returns {object}
 */
function buildRecord({ savedAt, event, sessionId, hookData, cwd, evidence, bundle, measured }) {
  return {
    savedAt,
    event,
    sessionId,
    trigger: typeof hookData.compact_trigger === 'string' ? hookData.compact_trigger : null,
    cwd,
    projectRoot: evidence.projectRoot,
    identity: bundle.identity,
    bytes: bundle.bytes,
    maxBytes: bundle.maxBytes,
    truncated: bundle.truncated,
    sections: bundle.sections,
    warnings: bundle.warnings,
    compactSummary: evidence.compactSummary,
    ...measured,
  };
}

/**
 * One stderr line for the PR-CX02 record. Stderr only: `systemMessage` is the
 * user-visible channel and this PR changes it by zero bytes.
 *
 * @param {object} pressure
 * @param {{ appended: boolean, reason?: string }} pressureEvent
 * @param {{ reason: string|null, missing: string[] }} receipt
 * @returns {string}
 */
function formatPressureLine(pressure, pressureEvent, receipt) {
  const event = pressureEvent.appended ? 'appended' : `skipped:${pressureEvent.reason ?? 'error'}`;
  return `pressure=${pressure.score ?? 'null'} level=${pressure.level ?? 'null'} event=${event}`
    + ` receipt=${receipt.reason ?? 'emitted'} missing=${receipt.missing.length}`;
}

/**
 * @returns {Promise<object|null>}
 */
async function loadConfigSafe() {
  try {
    return await loadConfig();
  } catch (err) {
    logHookError(HOOK_NAME, 'config load failed (defaults used)', err);
    return null;
  }
}

/**
 * Hook entry. Never throws (the direct-run tail attaches `createErrorHandler`).
 * @returns {Promise<void>}
 */
export async function main() {
  const raw = await readStdin();
  const hookData = parseJSON(raw) ?? {};
  const event = typeof hookData.hook_event_name === 'string' ? hookData.hook_event_name : 'PostCompact';
  if (event === 'SessionStart' && hookData.source !== 'compact') return; // not our moment; stay silent

  const lifecycle = resolveLifecycle(await loadConfigSafe());
  // Gate OFF = silent: no stdout, no stderr, no files. No ARTIBOT_DEBUG-style
  // convention exists in scripts/hooks to route a debug line through
  // (measured 2026-09-02: `rg ARTIBOT_DEBUG scripts/hooks` → 0 hits).
  if (!lifecycle.enabled || !lifecycle.postCompactRehydrate) return;

  const cwd = typeof hookData.cwd === 'string' && hookData.cwd ? hookData.cwd : process.cwd();
  const claudeDir = getClaudeDir();
  const snapshotPath = path.join(claudeDir, 'artibot-pre-compact.json');
  const evidence = await gatherEvidence(cwd, snapshotPath, hookData);

  const savedAt = new Date().toISOString();
  const stamp = savedAt.replace(/[:.]/g, '-');
  const plannedMdPath = path.join(claudeDir, 'artibot', 'post-compact', `post-compact-${stamp}.md`);
  const bundle = composeBundle(evidence, snapshotPath, plannedMdPath, lifecycle.maxRehydrateBytes);

  const sessionId = typeof hookData.session_id === 'string' ? hookData.session_id : null;
  // vNext PR-CX02 — recorded alongside the bundle; it never changes the bundle.
  const measured = measureContext({
    evidence, hookData, bundle, sessionId, stamp, storeDir: lifecycle.supervisorStoreDir,
  });

  const record = buildRecord({ savedAt, event, sessionId, hookData, cwd, evidence, bundle, measured });
  const written = persist(record, bundle.text, claudeDir);
  log(`bundle ${bundle.bytes}B/${bundle.maxBytes}B identity=${bundle.identity.ok ? 'ok' : 'refused'}${bundle.truncated ? ' truncated' : ''} → ${written.mdPath ?? 'unsaved'}`);
  log(formatPressureLine(measured.pressure, measured.pressureEvent, measured.contextReceipt));

  if (event === 'SessionStart') {
    // SessionStart(compact): plain stdout is injected into context (per claude-code-guide).
    process.stdout.write(`${bundle.text}\n`);
    return;
  }
  // PostCompact: systemMessage is the only honoured channel (per claude-code-guide).
  writeStdout({ systemMessage: bundle.text });
}

// Direct-run guard: importing this module (tests, import-safety sweep) must
// not block on stdin or fire side effects.
if (isMainEntry(import.meta.url)) {
  main().catch(createErrorHandler(HOOK_NAME));
}
