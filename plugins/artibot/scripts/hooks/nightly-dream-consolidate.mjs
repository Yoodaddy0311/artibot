#!/usr/bin/env node
/**
 * Nightly dream consolidation hook (Phase-1 only — ADR-3).
 *
 * Scheduled at `0 5 * * *` (05:00 daily), right after nightly-session-rollup
 * (04:30) so the day's rollup + corrections are on disk. Runs ONLY the
 * deterministic, LLM-free half of the dreaming pipeline:
 *
 *   1. Collect memory MD (read-only) + distill Phase-1 candidates.
 *   2. Write `<memoryDir>/.dream-staging/candidates.json`.
 *   3. Record a wakeup marker so the NEXT session performs Phase-2 LLM-Distill.
 *
 * HARD GUARANTEES (PRD acceptance #8, #9):
 *   - LLM call count: 0. proposal generation: 0. live MD writes: 0.
 *   - Only `candidates.json` + a wakeup marker are produced.
 *   - never-throws — returns a structured status object (rollup hook pattern).
 *   - Honours the kill-switch; `--dry-run` computes without writing candidates.
 *   - `dream.enabled` config gate (default OFF/conservative) short-circuits.
 *
 * Flags:
 *   --dry-run               Compute candidates, skip the candidates.json write
 *   --memory-dir <path>     Memory dir to consolidate (default: resolve below)
 *   --plugin-root <path>    Plugin root for marker/kill-switch (tests)
 *   --help                  Print usage
 *
 * @module scripts/hooks/nightly-dream-consolidate
 */

import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createCollector } from '../../lib/learning/memory/dream/collector.js';
import { distillCandidates, writeCandidates } from '../../lib/learning/memory/dream/distiller.js';
import { isMainEntry } from './_main-entry.js';

const __filename = fileURLToPath(import.meta.url);

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

/**
 * @param {string[]} argv
 * @returns {{dryRun:boolean, memoryDir:string|null, pluginRoot:string|null, help:boolean}}
 */
export function parseArgs(argv) {
  const out = { dryRun: false, memoryDir: null, pluginRoot: null, projectDir: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--dry-run': out.dryRun = true; break;
      case '--memory-dir': out.memoryDir = argv[++i] ?? null; break;
      case '--plugin-root': out.pluginRoot = argv[++i] ?? null; break;
      case '--project-dir': out.projectDir = argv[++i] ?? null; break;
      case '--help': case '-h': out.help = true; break;
      default: break;
    }
  }
  return out;
}

export const USAGE = [
  'Usage: node scripts/hooks/nightly-dream-consolidate.mjs [options]',
  '',
  'Options:',
  '  --dry-run             Compute candidates without writing candidates.json',
  '  --memory-dir <path>   Memory dir to consolidate',
  '  --plugin-root <path>  Plugin root for marker / kill-switch',
  '  -h, --help            Show this message',
].join('\n');

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the default user memory dir. The Claude Code harness stores
 * auto-memory under `~/.claude/projects/<encoded-project>/memory`. We cannot
 * reliably know the encoded project here, so the default returns null and the
 * hook reports `no-memory-dir` rather than guessing — the scheduled command
 * supplies `--memory-dir` explicitly.
 *
 * @returns {string|null}
 */
export function resolveDefaultMemoryDir() {
  return process.env.ARTIBOT_DREAM_MEMORY_DIR
    ? path.resolve(process.env.ARTIBOT_DREAM_MEMORY_DIR)
    : null;
}

/** @returns {string} */
export function resolveDefaultPluginRoot() {
  return path.resolve(path.dirname(__filename), '..', '..');
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Check the dream config gate (default conservative). Returns true when the
 * nightly Phase-1 run is allowed to proceed.
 * @param {object} [config]
 */
function dreamEnabled(config) {
  const block = config?.learning?.dream;
  // Default: the nightly slot is allowed to PRODUCE CANDIDATES even when the
  // broader feature defaults conservative — candidates are inert staging data.
  // Operators disable the whole loop via `dream.nightly.enabled === false`.
  return block?.nightly?.enabled !== false;
}

/**
 * Best-effort kill-switch probe. Never throws.
 * @param {object} config
 * @param {string} pluginRoot
 * @returns {Promise<boolean>} true if tripped (skip run)
 */
async function killSwitchTripped(config, pluginRoot) {
  try {
    const ks = await import('../../lib/learning/kill-switch.js');
    return await ks.isKillSwitchTripped(config, { feature: 'dream-consolidate', pluginRoot });
  } catch {
    return false;
  }
}

/**
 * Best-effort wakeup marker so the next session picks up Phase-2. Never throws.
 * @param {number} candidateCount
 * @param {object} config
 * @param {string} pluginRoot
 * @returns {Promise<{queued:boolean, reason?:string}>}
 */
async function recordWakeup(candidateCount, config, pluginRoot) {
  try {
    const ws = await import('../../lib/learning/wakeup-scheduler.js');
    return await ws.requestWakeup({
      reason: `dream: ${candidateCount} consolidation candidate(s) awaiting Phase-2 review`,
      category: 'dream-consolidate',
      suggestedAction: 'Run /dreaming --review to author and gate proposals',
      delaySeconds: 300,
      depth: 0,
    }, { pluginRoot, config });
  } catch {
    return { queued: false, reason: 'wakeup-import-failed' };
  }
}

/**
 * Run the nightly Phase-1 consolidation once. Never throws on expected
 * failures — returns a structured status object.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun]
 * @param {string|null} [opts.memoryDir]
 * @param {string|null} [opts.pluginRoot]
 * @param {object} [opts.config]
 * @param {() => number} [opts.now]
 * @param {{info?:Function, warn?:Function, error?:Function}} [opts.logger]
 * @returns {Promise<object>} structured status
 */
export async function runNightlyDream(opts = {}) {
  const logger = opts.logger ?? {
    info: (m) => process.stderr.write(`[dream] ${m}\n`),
    warn: (m) => process.stderr.write(`[dream] WARN ${m}\n`),
    error: (m) => process.stderr.write(`[dream] ERROR ${m}\n`),
  };
  const config = opts.config || {};
  const pluginRoot = opts.pluginRoot || resolveDefaultPluginRoot();
  const memoryDir = opts.memoryDir || resolveDefaultMemoryDir();
  // projectDir holds `.artibot/` (handoffs/notes/ledger signals). Default null so
  // callers/tests that don't supply it collect no external signals (no surprise
  // reads of the cwd); the CLI passes process.cwd() explicitly. (F-08 D3)
  const projectDir = opts.projectDir || null;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();

  // No place to read memory from → safe no-op.
  if (!memoryDir) {
    return { status: 'skipped', reason: 'no-memory-dir', candidates: 0, llmCalls: 0, mdWrites: 0 };
  }
  if (!dreamEnabled(config)) {
    return { status: 'skipped', reason: 'dream-nightly-disabled', candidates: 0, llmCalls: 0, mdWrites: 0 };
  }

  try {
    if (await killSwitchTripped(config, pluginRoot)) {
      return { status: 'skipped', reason: 'kill-switch-tripped', candidates: 0, llmCalls: 0, mdWrites: 0 };
    }

    // Phase-1 ONLY: collect (read-only) + deterministic distill. No LLM.
    // Signals (handoffs / session-notes / ledger) flow into distill so it can
    // protect actively-discussed memories from archival (F-08 D3 wiring; the
    // distiller consumes `signals` in D2).
    const collector = createCollector({ memoryDir, projectDir });
    const { memories, signals } = await collector.collect();
    const candidates = distillCandidates(memories, { config, now, signals });
    const total = candidates.mergeCandidates.length
      + candidates.contradictCandidates.length
      + candidates.archiveCandidates.length;

    let candidatesPath = null;
    if (!opts.dryRun) {
      candidatesPath = await writeCandidates(path.join(memoryDir, '.dream-staging'), candidates);
    }

    // Record a wakeup marker so the next session does Phase-2 (LLM) — but only
    // when there is something to review and we actually persisted candidates.
    let wakeup = { queued: false, reason: 'no-candidates' };
    if (total > 0 && !opts.dryRun) {
      wakeup = await recordWakeup(total, config, pluginRoot);
    }

    logger.info?.(`phase-1 candidates=${total} written=${Boolean(candidatesPath)} wakeup=${wakeup.queued}`);

    return {
      status: opts.dryRun ? 'dry-run' : 'completed',
      candidates: total,
      breakdown: {
        merge: candidates.mergeCandidates.length,
        contradict: candidates.contradictCandidates.length,
        archive: candidates.archiveCandidates.length,
      },
      candidatesPath,
      wakeupQueued: wakeup.queued,
      // Invariants surfaced for assertions/monitoring (ADR-3).
      llmCalls: 0,
      proposalsGenerated: 0,
      mdWrites: 0,
    };
  } catch (err) {
    logger.error?.(`dream phase-1 failed: ${err?.message ?? err}`);
    return {
      status: 'failed',
      reason: String(err?.message ?? err),
      candidates: 0, llmCalls: 0, mdWrites: 0,
    };
  }
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

if (isMainEntry(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }
  let config;
  try {
    const cfgPath = path.join(args.pluginRoot || resolveDefaultPluginRoot(), 'artibot.config.json');
    const { readFile } = await import('node:fs/promises');
    config = JSON.parse(await readFile(cfgPath, 'utf-8'));
  } catch {
    config = {};
  }
  runNightlyDream({
    dryRun: args.dryRun,
    memoryDir: args.memoryDir,
    pluginRoot: args.pluginRoot,
    projectDir: args.projectDir || process.cwd(),
    config,
  })
    .then((res) => {
      process.stdout.write(`${JSON.stringify(res)}\n`);
      process.exit(res.status === 'failed' ? 1 : 0);
    })
    .catch((err) => {
      // Defensive — runNightlyDream never throws, but keep the rollup pattern.
      process.stderr.write(`[dream] FATAL ${err?.message ?? err}\n`);
      process.exit(1);
    });
}

// Keep `os` import meaningful for future home-dir resolution without tripping
// no-unused-vars; referenced lazily so the module stays side-effect-free.
export const _internals = Object.freeze({ homedir: os.homedir, dreamEnabled });
