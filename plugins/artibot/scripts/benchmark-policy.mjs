#!/usr/bin/env node
/**
 * benchmark-policy.mjs — Linear vs MLP routing-policy benchmark harness (v3.6).
 *
 * Generates a reproducible synthetic episode corpus and trains both the linear
 * logistic-regression policy (v3.4, policy-updater.js) and the NL1 MLP policy
 * (neural-policy.js) on identical data, then emits a side-by-side Markdown
 * comparison table covering:
 *
 *   logLoss            — cross-entropy on held-out split
 *   accuracyVsHeuristic — fraction of decisions matching labeled system
 *   trainingTimeMs     — wall-clock training duration
 *   convergenceIters   — iterations to reach logLoss < 0.4 (or -1 if never)
 *   paramCount         — trainable weight count
 *
 * The harness is resilient to NL1 absence: when `neural-policy.js` cannot be
 * imported it skips the MLP branch, labels metrics as N/A, and appends a
 * "pending NL1" footer. Tests can drive the harness via `--dry-run` without
 * executing any training.
 *
 * USAGE
 *   node plugins/artibot/scripts/benchmark-policy.mjs
 *   node plugins/artibot/scripts/benchmark-policy.mjs --episodes 500 --seed 42
 *   node plugins/artibot/scripts/benchmark-policy.mjs --output _reports/out.json
 *   node plugins/artibot/scripts/benchmark-policy.mjs --dry-run
 *
 * DATA POLICY
 *   Local-only. Zero external deps. Zero network IO. Deterministic under seed.
 *
 * @module scripts/benchmark-policy
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFile } from 'node:fs/promises';

// ---------------------------------------------------------------------------
// Module resolution (Windows + Korean-path safe, mirrors utils/toFileUrl)
// ---------------------------------------------------------------------------

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(SCRIPT_DIR, '..');

function toFileUrl(absPath) {
  // Avoid percent-encoding issues on Windows paths with non-ASCII chars.
  return pathToFileURL(absPath).href;
}

async function loadLinearPolicyModule() {
  const mod = await import(
    toFileUrl(resolve(PLUGIN_ROOT, 'lib/learning/grpo/policy-updater.js'))
  );
  return mod;
}

/**
 * Best-effort dynamic import of NL1's neural-policy module. Returns `null`
 * when the file is missing or exports an incompatible shape — the harness
 * treats that as "MLP not yet available" and emits a pending-NL1 note.
 *
 * @returns {Promise<null | {
 *   createNeuralPolicy: Function,
 *   evaluateNeuralPolicy?: Function,
 *   FEATURE_DIM?: number,
 * }>}
 */
export async function loadNeuralPolicyModule() {
  try {
    const mod = await import(
      toFileUrl(resolve(PLUGIN_ROOT, 'lib/learning/grpo/neural-policy.js'))
    );
    if (!mod || typeof mod.createNeuralPolicy !== 'function') return null;
    return mod;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Seeded RNG (Mulberry32 — deterministic across platforms)
// ---------------------------------------------------------------------------

/**
 * Seeded PRNG factory. Same seed always yields the same stream.
 *
 * @param {number} seed - any 32-bit integer
 * @returns {() => number} function returning floats in [0, 1)
 */
export function createRng(seed) {
  let s = (seed | 0) || 1;
  return function rng() {
    s = (s + 0x6d2b79f5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rng) {
  // Box-Muller — uses two uniform draws per call.
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ---------------------------------------------------------------------------
// Synthetic episode generator
// ---------------------------------------------------------------------------

const INTENT_FAMILIES = [
  'code-edit',
  'refactor',
  'bug-fix',
  'feature',
  'doc-update',
  'research',
];

/**
 * True labeling function: high complexity / risk → S2 (label=1).
 * The harness evaluates each policy against this ground truth.
 *
 * @param {{steps:number,domains:number,uncertainty:number,risk:number,novelty:number}} f
 * @returns {0|1}
 */
export function heuristicLabel(f) {
  const score = 0.25 * f.steps + 0.2 * f.domains + 0.2 * f.uncertainty
    + 0.25 * f.risk + 0.1 * f.novelty;
  return score > 0.5 ? 1 : 0;
}

/**
 * Generate a deterministic episode batch given a seed. Each episode is
 * reward-capture-shaped and policy-updater-normalizable.
 *
 * @param {{count:number, seed:number}} options
 * @returns {object[]}
 */
export function generateEpisodes({ count, seed }) {
  const rng = createRng(seed);
  const episodes = [];

  for (let i = 0; i < count; i++) {
    const steps = Math.max(0, Math.min(1, rng()));
    const domains = Math.max(0, Math.min(1, rng()));
    const uncertainty = Math.max(0, Math.min(1, rng()));
    const risk = Math.max(0, Math.min(1, rng()));
    const novelty = Math.max(0, Math.min(1, rng()));
    const factors = { steps, domains, uncertainty, risk, novelty };

    const label = heuristicLabel(factors);

    // Reward aligns with label: S2 episodes that succeed give +reward;
    // noisy episodes give mild negative. Include small gaussian jitter.
    const noise = gaussian(rng) * 0.15;
    const reward = label === 1 ? 0.6 + noise : -0.2 + noise;

    const family = INTENT_FAMILIES[Math.floor(rng() * INTENT_FAMILIES.length)];

    episodes.push({
      classification: { factors, system: label === 1 ? 2 : 1 },
      context: {
        s1SuccessRate: rng(),
        sessionDepth: Math.floor(rng() * 20),
        errorRateMa10: rng() * 0.3,
      },
      reward,
      intentFamily: family,
      isExploration: rng() < 0.05, // ~5% exploration flag
    });
  }

  return episodes;
}

/**
 * Split episodes into train/held-out. Deterministic: first `trainRatio`
 * fraction becomes train, remainder becomes held-out.
 *
 * @param {object[]} episodes
 * @param {number} trainRatio - in (0, 1)
 * @returns {{train: object[], heldOut: object[]}}
 */
export function splitEpisodes(episodes, trainRatio = 0.8) {
  const cutoff = Math.floor(episodes.length * trainRatio);
  return {
    train: episodes.slice(0, cutoff),
    heldOut: episodes.slice(cutoff),
  };
}

// ---------------------------------------------------------------------------
// Metric helpers
// ---------------------------------------------------------------------------

/**
 * Count trainable parameters. For linear: FEATURE_DIM. For MLP:
 * input*hidden + hidden + hidden*output + output (single hidden layer).
 *
 * @param {'linear'|'mlp'} kind
 * @param {{featureDim:number, hiddenDim?:number, outputDim?:number}} dims
 * @returns {number}
 */
export function paramCount(kind, dims) {
  const { featureDim, hiddenDim = 16, outputDim = 1 } = dims;
  if (kind === 'linear') return featureDim;
  return featureDim * hiddenDim + hiddenDim + hiddenDim * outputDim + outputDim;
}

/**
 * Train linear policy and record convergence per iteration.
 *
 * @param {{
 *   linearMod: object,
 *   train: object[],
 *   heldOut: object[],
 *   iterations: number,
 *   targetLogLoss: number,
 * }} options
 * @returns {{
 *   logLoss: number,
 *   accuracyVsHeuristic: number,
 *   trainingTimeMs: number,
 *   convergenceIters: number,
 *   paramCount: number,
 * }}
 */
export function benchmarkLinear({ linearMod, train, heldOut, iterations, targetLogLoss }) {
  const { FEATURE_DIM, trainBatch, evaluatePolicy } = linearMod;
  const start = hiresNow();
  let theta = new Array(FEATURE_DIM).fill(0);
  let convergenceIters = -1;

  for (let it = 0; it < iterations; it++) {
    const res = trainBatch(train, theta, { iterations: 1 });
    theta = res.theta;
    if (convergenceIters === -1) {
      const m = evaluatePolicy(theta, heldOut);
      if (m.logLoss < targetLogLoss) convergenceIters = it + 1;
    }
  }

  const final = evaluatePolicy(theta, heldOut);
  return {
    logLoss: final.logLoss,
    accuracyVsHeuristic: final.accuracyVsHeuristic,
    trainingTimeMs: hiresNow() - start,
    convergenceIters,
    paramCount: paramCount('linear', { featureDim: FEATURE_DIM }),
  };
}

/**
 * Train MLP policy via NL1 module. Returns null when module absent.
 *
 * Supports two module shapes:
 *   A) NL1 production shape — module-level `createTheta`, `trainBatch`,
 *      `evaluatePolicy` (async) that mirror the linear policy API but over
 *      an MLP theta object. This is the real contract as of 2026-04-24.
 *   B) Legacy stub shape (used in unit tests) — `createNeuralPolicy` that
 *      returns `{ trainOne?, train?, evaluate }`.
 *
 * @param {{
 *   neuralMod: object|null,
 *   train: object[],
 *   heldOut: object[],
 *   iterations: number,
 *   targetLogLoss: number,
 *   seed: number,
 *   featureDim: number,
 *   hiddenDim: number,
 * }} options
 * @returns {Promise<null | {
 *   logLoss: number,
 *   accuracyVsHeuristic: number,
 *   trainingTimeMs: number,
 *   convergenceIters: number,
 *   paramCount: number,
 * }>}
 */
export async function benchmarkMlp({
  neuralMod, train, heldOut, iterations, targetLogLoss, seed, featureDim, hiddenDim,
}) {
  if (!neuralMod) return null;

  // Shape A: module-level theta API (NL1 production)
  if (typeof neuralMod.createTheta === 'function'
    && typeof neuralMod.trainBatch === 'function'
    && typeof neuralMod.evaluatePolicy === 'function') {
    const start = hiresNow();
    let theta = neuralMod.createTheta({ seed });
    let convergenceIters = -1;
    for (let it = 0; it < iterations; it++) {
      const res = await neuralMod.trainBatch(train, theta, { iterations: 1 });
      theta = res.theta;
      if (convergenceIters === -1) {
        const m = await neuralMod.evaluatePolicy(theta, heldOut);
        if (m && m.logLoss < targetLogLoss) convergenceIters = it + 1;
      }
    }
    const final = await neuralMod.evaluatePolicy(theta, heldOut);
    return {
      logLoss: final.logLoss,
      accuracyVsHeuristic: final.accuracyVsHeuristic,
      trainingTimeMs: hiresNow() - start,
      convergenceIters,
      paramCount: paramCount('mlp', { featureDim, hiddenDim }),
    };
  }

  // Shape B: stateful factory (stub API)
  if (typeof neuralMod.createNeuralPolicy !== 'function') return null;
  const start = hiresNow();
  const policy = neuralMod.createNeuralPolicy({ featureDim, hiddenDim, seed });
  let convergenceIters = -1;

  if (typeof policy.trainOne === 'function' && typeof policy.evaluate === 'function') {
    for (let it = 0; it < iterations; it++) {
      policy.trainOne(train);
      if (convergenceIters === -1) {
        const m = policy.evaluate(heldOut);
        if (m && m.logLoss < targetLogLoss) convergenceIters = it + 1;
      }
    }
  } else if (typeof policy.train === 'function' && typeof policy.evaluate === 'function') {
    policy.train(train, { iterations });
  }

  const final = (typeof policy.evaluate === 'function')
    ? policy.evaluate(heldOut)
    : { logLoss: Number.NaN, accuracyVsHeuristic: Number.NaN };

  return {
    logLoss: final.logLoss,
    accuracyVsHeuristic: final.accuracyVsHeuristic,
    trainingTimeMs: hiresNow() - start,
    convergenceIters,
    paramCount: paramCount('mlp', { featureDim, hiddenDim }),
  };
}

function hiresNow() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  const [s, ns] = process.hrtime();
  return s * 1e3 + ns / 1e6;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function fmt(n, digits = 4) {
  if (n === null || n === undefined) return 'N/A';
  if (!Number.isFinite(n)) return 'N/A';
  return n.toFixed(digits);
}

/**
 * Render a Markdown table comparing linear vs MLP metrics.
 *
 * @param {object} result - output of `runBenchmark`
 * @returns {string}
 */
export function renderMarkdown(result) {
  const { linear, mlp, config } = result;
  const rows = [
    ['Metric', 'Linear (v3.4)', 'MLP (NL1)'],
    ['logLoss', fmt(linear?.logLoss), fmt(mlp?.logLoss)],
    ['accuracyVsHeuristic', fmt(linear?.accuracyVsHeuristic), fmt(mlp?.accuracyVsHeuristic)],
    ['trainingTimeMs', fmt(linear?.trainingTimeMs, 2), fmt(mlp?.trainingTimeMs, 2)],
    ['convergenceIters', String(linear?.convergenceIters ?? 'N/A'), String(mlp?.convergenceIters ?? 'N/A')],
    ['paramCount', String(linear?.paramCount ?? 'N/A'), String(mlp?.paramCount ?? 'N/A')],
  ];
  const header = `| ${rows[0].join(' | ')} |`;
  const sep = `| ${rows[0].map(() => '---').join(' | ')} |`;
  const body = rows.slice(1).map((r) => `| ${r.join(' | ')} |`).join('\n');

  const footer = mlp
    ? ''
    : '\n\n> **Note**: MLP metrics unavailable — `neural-policy.js` not found. Re-run after NL1 merge.';
  const cfg = `\n\nConfig: episodes=${config.episodes}, seed=${config.seed}, iterations=${config.iterations}, trainRatio=${config.trainRatio}.`;
  return [header, sep, body].join('\n') + cfg + footer;
}

// ---------------------------------------------------------------------------
// Top-level benchmark runner
// ---------------------------------------------------------------------------

/**
 * Execute the full benchmark pipeline.
 *
 * @param {{
 *   episodes?: number,
 *   seed?: number,
 *   iterations?: number,
 *   trainRatio?: number,
 *   targetLogLoss?: number,
 *   hiddenDim?: number,
 *   dryRun?: boolean,
 *   linearMod?: object,
 *   neuralMod?: object|null,
 * }} [options]
 * @returns {Promise<{
 *   config: object,
 *   linear: object|null,
 *   mlp: object|null,
 *   episodesGenerated: number,
 *   skipped: boolean,
 * }>}
 */
export async function runBenchmark(options = {}) {
  const config = {
    episodes: options.episodes ?? 400,
    seed: options.seed ?? 42,
    iterations: options.iterations ?? 30,
    trainRatio: options.trainRatio ?? 0.8,
    targetLogLoss: options.targetLogLoss ?? 0.4,
    hiddenDim: options.hiddenDim ?? 16,
  };

  if (options.dryRun) {
    return { config, linear: null, mlp: null, episodesGenerated: 0, skipped: true };
  }

  const linearMod = options.linearMod ?? await loadLinearPolicyModule();
  const neuralMod = options.neuralMod !== undefined
    ? options.neuralMod
    : await loadNeuralPolicyModule();

  const episodes = generateEpisodes({ count: config.episodes, seed: config.seed });
  const { train, heldOut } = splitEpisodes(episodes, config.trainRatio);

  const linear = benchmarkLinear({
    linearMod,
    train,
    heldOut,
    iterations: config.iterations,
    targetLogLoss: config.targetLogLoss,
  });

  const mlp = await benchmarkMlp({
    neuralMod,
    train,
    heldOut,
    iterations: config.iterations,
    targetLogLoss: config.targetLogLoss,
    seed: config.seed,
    featureDim: linearMod.FEATURE_DIM,
    hiddenDim: config.hiddenDim,
  });

  return {
    config,
    linear,
    mlp,
    episodesGenerated: episodes.length,
    skipped: false,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const args = {
    episodes: 400,
    seed: 42,
    iterations: 30,
    output: null,
    dryRun: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--episodes') args.episodes = Number(argv[++i]);
    else if (a === '--seed') args.seed = Number(argv[++i]);
    else if (a === '--iterations') args.iterations = Number(argv[++i]);
    else if (a === '--output') args.output = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function printHelp() {
  process.stderr.write(
    [
      'benchmark-policy.mjs — Linear vs MLP routing-policy benchmark',
      '',
      'Usage:',
      '  node benchmark-policy.mjs [options]',
      '',
      'Options:',
      '  --episodes N     Number of synthetic episodes (default: 400)',
      '  --seed S         RNG seed for deterministic data (default: 42)',
      '  --iterations N   Training iterations per policy (default: 30)',
      '  --output PATH    Write JSON result to PATH (Markdown still goes to stdout)',
      '  --dry-run        Skip training, validate wiring only',
      '  --help           Show this help',
      '',
    ].join('\n'),
  );
}

/**
 * CLI entry. Returns the exit code (0 = success, 1 = failure).
 *
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
export async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return 0;
  }

  if (!Number.isFinite(args.episodes) || args.episodes <= 0) {
    process.stderr.write('error: --episodes must be a positive integer\n');
    return 1;
  }
  if (!Number.isFinite(args.seed)) {
    process.stderr.write('error: --seed must be a number\n');
    return 1;
  }
  if (!Number.isFinite(args.iterations) || args.iterations <= 0) {
    process.stderr.write('error: --iterations must be a positive integer\n');
    return 1;
  }

  const result = await runBenchmark({
    episodes: args.episodes,
    seed: args.seed,
    iterations: args.iterations,
    dryRun: args.dryRun,
  });

  const md = renderMarkdown(result);
  process.stdout.write(md + '\n');

  if (args.output) {
    await writeFile(resolve(args.output), JSON.stringify(result, null, 2), 'utf8');
    process.stderr.write(`wrote JSON result -> ${args.output}\n`);
  }

  return 0;
}

// Run CLI when invoked directly (not when imported by tests).
const invokedDirectly = process.argv[1]
  && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`fatal: ${err?.stack ?? err}\n`);
      process.exit(1);
    });
}
