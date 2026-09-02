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
import { buildRehydrationBundle, DEFAULT_MAX_BYTES } from '../../lib/context/rehydration.js';
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
});

/**
 * Resolve the lifecycle settings: defaults ← config ← env overlay. Never throws.
 * @param {object|null} config
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ enabled: boolean, postCompactRehydrate: boolean, maxRehydrateBytes: number }}
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
  const snapshot = readJsonSafe(snapshotPath);
  const current = captureCurrentIdentity(cwd);

  let projectRoot = cwd;
  try {
    projectRoot = resolveProjectRoot(cwd) || cwd;
  } catch { /* keep cwd */ }
  let handoff = null;
  try {
    handoff = await readLatestHandoff(projectRoot);
  } catch { /* none */ }
  const split = collectSplitEvidence(cwd, projectRoot);
  const compactSummary = typeof hookData.compact_summary === 'string' ? hookData.compact_summary : null;

  const savedAt = new Date().toISOString();
  const stamp = savedAt.replace(/[:.]/g, '-');
  const plannedMdPath = path.join(claudeDir, 'artibot', 'post-compact', `post-compact-${stamp}.md`);
  const bundle = buildRehydrationBundle({
    snapshot,
    current,
    compactSummary,
    handoff,
    split,
    maxBytes: lifecycle.maxRehydrateBytes,
    paths: {
      bundlePath: plannedMdPath,
      snapshotPath: snapshot ? snapshotPath : null,
      stateFilePath: typeof snapshot?.stateFilePath === 'string' ? snapshot.stateFilePath : null,
    },
  });

  const record = {
    savedAt,
    event,
    sessionId: typeof hookData.session_id === 'string' ? hookData.session_id : null,
    trigger: typeof hookData.compact_trigger === 'string' ? hookData.compact_trigger : null,
    cwd,
    projectRoot,
    identity: bundle.identity,
    bytes: bundle.bytes,
    maxBytes: bundle.maxBytes,
    truncated: bundle.truncated,
    sections: bundle.sections,
    warnings: bundle.warnings,
    compactSummary,
  };
  const written = persist(record, bundle.text, claudeDir);
  log(`bundle ${bundle.bytes}B/${bundle.maxBytes}B identity=${bundle.identity.ok ? 'ok' : 'refused'}${bundle.truncated ? ' truncated' : ''} → ${written.mdPath ?? 'unsaved'}`);

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
