#!/usr/bin/env node
/**
 * benchmark-joint-policy.mjs — Independent vs Joint agent+skill policy
 * benchmark harness (v3.7).
 *
 * The routing stack currently trains two *independent* softmax heads:
 *   - `agent-policy.js`  — per-taskFamily softmax over agents
 *   - `skill-policy.js`  — per-skill linear triggers
 *
 * Hypothesis (v3.7): for some task families, the *joint* distribution
 * P(agent, skill | family) carries correlations that independent training
 * cannot capture (e.g. family=refactor prefers `architect` agent + `code-review`
 * skill, but `backend-developer` + `tdd-guide`). A small joint-policy model
 * — a per-family matrix over (agent × skill) cells plus a correlation
 * regularizer — should outperform the product of marginals on end-to-end
 * accuracy of matching the correct (agent, skill) pair.
 *
 * This harness:
 *   1. Generates a deterministic synthetic episode corpus where certain
 *      task families have intentional (agent, skill) correlation structure.
 *   2. Trains the independent pipeline (agent-policy + skill-policy) and
 *      the joint pipeline (joint-policy, or a mock stub when JP1 is absent).
 *   3. Compares end-to-end accuracy (correct pair), per-policy training
 *      time, correlation-matrix sparsity, and convergence iterations.
 *
 * USAGE
 *   node plugins/artibot/scripts/benchmark-joint-policy.mjs
 *   node plugins/artibot/scripts/benchmark-joint-policy.mjs --episodes 600 --seed 7
 *   node plugins/artibot/scripts/benchmark-joint-policy.mjs --output _reports/out.json
 *   node plugins/artibot/scripts/benchmark-joint-policy.mjs --dry-run
 *
 * DATA POLICY
 *   Local-only. Zero external deps. Zero network IO. Deterministic under seed.
 *
 * @module scripts/benchmark-joint-policy
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFile } from 'node:fs/promises';

// ---------------------------------------------------------------------------
// Module resolution (Windows + Korean-path safe)
// ---------------------------------------------------------------------------

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(SCRIPT_DIR, '..');

function toFileUrl(absPath) {
  return pathToFileURL(absPath).href;
}

async function loadAgentPolicyModule() {
  const mod = await import(
    toFileUrl(resolve(PLUGIN_ROOT, 'lib/learning/grpo/agent-policy.js'))
  );
  return mod;
}

async function loadSkillPolicyModule() {
  const mod = await import(
    toFileUrl(resolve(PLUGIN_ROOT, 'lib/learning/grpo/skill-policy.js'))
  );
  return mod;
}

/**
 * Best-effort dynamic import of JP1's joint-policy module. Returns `null`
 * when missing or wrongly shaped. Harness substitutes an in-process mock
 * stub so wiring and metrics can still be exercised.
 *
 * @returns {Promise<null | {
 *   createJointPolicy?: Function,
 *   trainBatch?: Function,
 *   evaluatePolicy?: Function,
 *   sparsity?: Function,
 * }>}
 */
export async function loadJointPolicyModule() {
  try {
    const mod = await import(
      toFileUrl(resolve(PLUGIN_ROOT, 'lib/learning/grpo/joint-policy.js'))
    );
    if (!mod) return null;
    const ok = typeof mod.createJointPolicy === 'function'
      || (typeof mod.trainBatch === 'function' && typeof mod.evaluatePolicy === 'function');
    return ok ? mod : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Seeded RNG (Mulberry32 — matches benchmark-policy.mjs)
// ---------------------------------------------------------------------------

/**
 * Seeded PRNG factory. Same seed always yields the same stream.
 *
 * @param {number} seed
 * @returns {() => number}
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

// ---------------------------------------------------------------------------
// Synthetic domain: task families × agents × skills with embedded correlation
// ---------------------------------------------------------------------------

export const TASK_FAMILIES = [
  'code-edit',
  'refactor',
  'bug-fix',
  'feature',
  'doc-update',
  'research',
];

export const AGENTS = [
  'backend-developer',
  'frontend-developer',
  'architect',
  'code-reviewer',
  'tdd-guide',
];

export const SKILLS = [
  'code-review',
  'tdd',
  'refactoring',
  'api-design',
  'doc-writing',
];

/**
 * Per-family preferred (agent, skill) pair. These define the ground truth
 * for end-to-end accuracy. The generator emits this pair with probability
 * `p` and a random non-preferred pair with probability `1 - p`.
 *
 * @type {Record<string, { agent: string, skill: string, p: number }>}
 */
export const FAMILY_PREFERENCES = Object.freeze({
  'code-edit':  { agent: 'backend-developer',  skill: 'tdd',          p: 0.80 },
  'refactor':   { agent: 'architect',          skill: 'refactoring',  p: 0.85 },
  'bug-fix':    { agent: 'tdd-guide',          skill: 'tdd',          p: 0.82 },
  'feature':    { agent: 'backend-developer',  skill: 'api-design',   p: 0.78 },
  'doc-update': { agent: 'code-reviewer',      skill: 'doc-writing',  p: 0.85 },
  'research':   { agent: 'architect',          skill: 'code-review',  p: 0.70 },
});

function pickOther(arr, exclude, rng) {
  const pool = arr.filter((v) => v !== exclude);
  if (pool.length === 0) return exclude;
  return pool[Math.floor(rng() * pool.length)];
}

/**
 * Generate a deterministic episode corpus with embedded (agent, skill)
 * correlation per task family.
 *
 * @param {{ count: number, seed: number, correlationStrength?: number }} options
 * @returns {Array<{
 *   taskFamily: string,
 *   intent: string,
 *   context: { commands: string[], intents: string[] },
 *   selectedAgent: string,
 *   skillsUsed: string[],
 *   labeledAgent: string,
 *   labeledSkill: string,
 *   reward: number,
 *   isExploration: boolean,
 * }>}
 */
export function generateEpisodes({ count, seed, correlationStrength = 1.0 }) {
  const rng = createRng(seed);
  const episodes = [];
  const strength = Math.max(0, Math.min(1, correlationStrength));

  for (let i = 0; i < count; i++) {
    const family = TASK_FAMILIES[Math.floor(rng() * TASK_FAMILIES.length)];
    const pref = FAMILY_PREFERENCES[family];
    const effP = pref.p * strength;

    const useCorrelated = rng() < effP;
    const labeledAgent = pref.agent;
    const labeledSkill = pref.skill;

    const selectedAgent = useCorrelated
      ? labeledAgent
      : pickOther(AGENTS, labeledAgent, rng);
    const selectedSkill = useCorrelated
      ? labeledSkill
      : pickOther(SKILLS, labeledSkill, rng);

    const correctPair = selectedAgent === labeledAgent && selectedSkill === labeledSkill;
    const rewardBase = correctPair ? 0.7 : -0.25;
    const noise = (rng() - 0.5) * 0.2;
    const reward = rewardBase + noise;

    episodes.push({
      taskFamily: family,
      intent: `${family} work ${i}`,
      context: {
        commands: [family],
        intents: [family],
      },
      selectedAgent,
      skillsUsed: [selectedSkill],
      labeledAgent,
      labeledSkill,
      reward,
      isExploration: rng() < 0.05,
    });
  }

  return episodes;
}

/**
 * Split episodes into train/held-out (deterministic, by index).
 *
 * @param {object[]} episodes
 * @param {number} [trainRatio=0.8]
 * @returns {{ train: object[], heldOut: object[] }}
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

function hiresNow() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  const [s, ns] = process.hrtime();
  return s * 1e3 + ns / 1e6;
}

/**
 * Compute sparsity (fraction of zero-valued cells) across a per-family
 * weight object. For independent policies we form the outer-product matrix
 * per family; for the joint policy we inspect its emitted matrix directly.
 *
 * @param {Record<string, number[][]>} matrices - family -> 2D weights
 * @param {number} [threshold=1e-6]
 * @returns {number} in [0, 1]
 */
export function matrixSparsity(matrices, threshold = 1e-6) {
  let zeros = 0;
  let total = 0;
  for (const mat of Object.values(matrices ?? {})) {
    if (!Array.isArray(mat)) continue;
    for (const row of mat) {
      if (!Array.isArray(row)) continue;
      for (const v of row) {
        total++;
        if (!Number.isFinite(v) || Math.abs(v) < threshold) zeros++;
      }
    }
  }
  return total === 0 ? 0 : zeros / total;
}

/**
 * End-to-end accuracy for an (agent, skill) predictor function against
 * held-out episodes. `predict(episode)` must return
 * `{ agent: string|null, skill: string|null }`.
 *
 * @param {object[]} heldOut
 * @param {(ep: object) => { agent: string|null, skill: string|null }} predict
 * @returns {number} in [0, 1]
 */
export function pairAccuracy(heldOut, predict) {
  if (!Array.isArray(heldOut) || heldOut.length === 0) return 0;
  let correct = 0;
  for (const ep of heldOut) {
    const p = predict(ep) ?? {};
    if (p.agent === ep.labeledAgent && p.skill === ep.labeledSkill) correct++;
  }
  return correct / heldOut.length;
}

// ---------------------------------------------------------------------------
// Independent pipeline benchmark
// ---------------------------------------------------------------------------

/**
 * Train the independent (agent-policy + skill-policy) pipeline and derive
 * end-to-end metrics.
 *
 * @param {{
 *   agentMod: object,
 *   skillMod: object,
 *   train: object[],
 *   heldOut: object[],
 *   iterations: number,
 *   targetAccuracy: number,
 * }} options
 * @returns {{
 *   pairAccuracy: number,
 *   agentTrainMs: number,
 *   skillTrainMs: number,
 *   trainingTimeMs: number,
 *   convergenceIters: number,
 *   sparsity: number,
 *   familiesTouched: number,
 * }}
 */
export function benchmarkIndependent({
  agentMod, skillMod, train, heldOut, iterations, targetAccuracy,
}) {
  const start = hiresNow();

  // Agent policy: per-family softmax weights
  const aStart = hiresNow();
  let agentWeights = {};
  for (let it = 0; it < iterations; it++) {
    const upd = agentMod.updatePolicy(train, agentWeights, { iterations: 1 });
    agentWeights = upd.weights;
  }
  const agentTrainMs = hiresNow() - aStart;

  // Skill policy: per-skill linear weights
  const sStart = hiresNow();
  const skillPolicy = skillMod.emptyPolicy();
  for (let it = 0; it < iterations; it++) {
    skillMod.trainBatch(skillPolicy, train);
  }
  const skillTrainMs = hiresNow() - sStart;

  const predict = (ep) => {
    const sel = agentMod.selectAgent(agentWeights, ep.taskFamily, {
      candidates: AGENTS,
    });
    const scores = skillMod.scoreSkillsWith(
      skillPolicy,
      ep.intent,
      ep.context,
      SKILLS,
    );
    const ranked = skillMod.selectFromScores(scores, {
      threshold: 0, maxTriggers: 1,
    });
    return {
      agent: sel.agent,
      skill: ranked[0]?.name ?? null,
    };
  };

  // Convergence detection — walk iterations one by one and re-check accuracy
  let convergenceIters = -1;
  {
    let aW = {};
    const sp = skillMod.emptyPolicy();
    for (let it = 0; it < iterations; it++) {
      const upd = agentMod.updatePolicy(train, aW, { iterations: 1 });
      aW = upd.weights;
      skillMod.trainBatch(sp, train);
      const acc = pairAccuracy(heldOut, (ep) => {
        const sel = agentMod.selectAgent(aW, ep.taskFamily, { candidates: AGENTS });
        const scores = skillMod.scoreSkillsWith(sp, ep.intent, ep.context, SKILLS);
        const ranked = skillMod.selectFromScores(scores, { threshold: 0, maxTriggers: 1 });
        return { agent: sel.agent, skill: ranked[0]?.name ?? null };
      });
      if (acc >= targetAccuracy) {
        convergenceIters = it + 1;
        break;
      }
    }
  }

  // Sparsity: outer-product view of agent × skill marginals per family.
  const outerMatrices = {};
  for (const fam of TASK_FAMILIES) {
    const fam_w = agentWeights[fam] ?? {};
    const agentVec = AGENTS.map((a) => (typeof fam_w[a] === 'number' ? fam_w[a] : 0));
    const skillVec = SKILLS.map((s) => {
      const entry = skillPolicy.skills?.[s];
      const bias = entry?.baseline_bias ?? 0;
      return bias;
    });
    outerMatrices[fam] = agentVec.map((a) => skillVec.map((s) => a * s));
  }

  return {
    pairAccuracy: pairAccuracy(heldOut, predict),
    agentTrainMs,
    skillTrainMs,
    trainingTimeMs: hiresNow() - start,
    convergenceIters,
    sparsity: matrixSparsity(outerMatrices),
    familiesTouched: Object.keys(agentWeights).length,
  };
}

// ---------------------------------------------------------------------------
// Joint pipeline benchmark (JP1 or mock stub)
// ---------------------------------------------------------------------------

/**
 * Lightweight in-process mock of the JP1 joint policy. Used when
 * `lib/learning/grpo/joint-policy.js` is not yet merged so the harness
 * can be exercised end-to-end. This is NOT a production replacement —
 * tests surface that JP1 is absent via `jointMock: true` in the result.
 *
 * Implementation: per-family matrix `W[agent][skill]` trained by
 * softmax-over-pairs cross-entropy with group-relative advantage.
 *
 * @returns {{
 *   train: (eps: object[]) => void,
 *   predict: (ep: object) => { agent: string, skill: string },
 *   sparsity: () => number,
 *   matrices: () => Record<string, number[][]>,
 * }}
 */
function createJointMock({ learningRate = 0.08 } = {}) {
  const W = {};
  for (const fam of TASK_FAMILIES) {
    W[fam] = AGENTS.map(() => SKILLS.map(() => 0));
  }

  function softmaxPairs(fam) {
    const flat = [];
    for (let a = 0; a < AGENTS.length; a++) {
      for (let s = 0; s < SKILLS.length; s++) flat.push(W[fam][a][s]);
    }
    let max = -Infinity;
    for (const v of flat) if (v > max) max = v;
    if (!Number.isFinite(max)) max = 0;
    let sum = 0;
    const exp = flat.map((v) => {
      const e = Math.exp(v - max);
      sum += e;
      return e;
    });
    const probs = sum > 0 ? exp.map((e) => e / sum) : exp.map(() => 1 / flat.length);
    const out = [];
    let idx = 0;
    for (let a = 0; a < AGENTS.length; a++) {
      const row = [];
      for (let s = 0; s < SKILLS.length; s++) {
        row.push(probs[idx++]);
      }
      out.push(row);
    }
    return out;
  }

  function train(eps) {
    const trainable = (eps ?? []).filter((e) => !e.isExploration);
    if (trainable.length === 0) return;
    const rewards = trainable.map((e) => e.reward);
    const mean = rewards.reduce((a, b) => a + b, 0) / rewards.length;
    const sqSum = rewards.reduce((a, b) => a + (b - mean) * (b - mean), 0);
    const std = Math.sqrt(sqSum / rewards.length) || 1;
    const advs = rewards.map((r) => (r - mean) / std);

    for (let i = 0; i < trainable.length; i++) {
      const ep = trainable[i];
      const fam = ep.taskFamily;
      if (!W[fam]) continue;
      const ai = AGENTS.indexOf(ep.selectedAgent);
      const si = SKILLS.indexOf(ep.skillsUsed?.[0]);
      if (ai < 0 || si < 0) continue;
      const probs = softmaxPairs(fam);
      for (let a = 0; a < AGENTS.length; a++) {
        for (let s = 0; s < SKILLS.length; s++) {
          const indicator = (a === ai && s === si) ? 1 : 0;
          W[fam][a][s] += learningRate * advs[i] * (indicator - probs[a][s]);
          // Clip
          if (W[fam][a][s] > 5) W[fam][a][s] = 5;
          else if (W[fam][a][s] < -5) W[fam][a][s] = -5;
        }
      }
    }
  }

  function predict(ep) {
    const fam = ep.taskFamily;
    const mat = W[fam];
    if (!mat) return { agent: AGENTS[0], skill: SKILLS[0] };
    let best = { a: 0, s: 0, v: -Infinity };
    for (let a = 0; a < AGENTS.length; a++) {
      for (let s = 0; s < SKILLS.length; s++) {
        if (mat[a][s] > best.v) best = { a, s, v: mat[a][s] };
      }
    }
    return { agent: AGENTS[best.a], skill: SKILLS[best.s] };
  }

  function matrices() {
    const out = {};
    for (const fam of TASK_FAMILIES) {
      out[fam] = W[fam].map((row) => [...row]);
    }
    return out;
  }

  function sparsity() {
    return matrixSparsity(matrices());
  }

  return { train, predict, sparsity, matrices };
}

/**
 * Benchmark the joint policy (JP1) — falls back to mock when absent.
 *
 * @param {{
 *   jointMod: object|null,
 *   train: object[],
 *   heldOut: object[],
 *   iterations: number,
 *   targetAccuracy: number,
 * }} options
 * @returns {{
 *   pairAccuracy: number,
 *   trainingTimeMs: number,
 *   convergenceIters: number,
 *   sparsity: number,
 *   usedMock: boolean,
 * }}
 */
export function benchmarkJoint({
  jointMod, train, heldOut, iterations, targetAccuracy,
}) {
  let policy;
  let usedMock = false;

  if (jointMod && typeof jointMod.createJointPolicy === 'function') {
    policy = jointMod.createJointPolicy({ agents: AGENTS, skills: SKILLS, families: TASK_FAMILIES });
  } else {
    policy = createJointMock();
    usedMock = true;
  }

  const start = hiresNow();
  let convergenceIters = -1;

  for (let it = 0; it < iterations; it++) {
    if (typeof policy.train === 'function') {
      policy.train(train);
    } else if (typeof policy.trainBatch === 'function') {
      policy.trainBatch(train);
    }
    if (convergenceIters === -1) {
      const acc = pairAccuracy(heldOut, (ep) => policy.predict(ep));
      if (acc >= targetAccuracy) convergenceIters = it + 1;
    }
  }

  const totalMs = hiresNow() - start;
  const finalAcc = pairAccuracy(heldOut, (ep) => policy.predict(ep));
  const sp = typeof policy.sparsity === 'function'
    ? policy.sparsity()
    : matrixSparsity(typeof policy.matrices === 'function' ? policy.matrices() : {});

  return {
    pairAccuracy: finalAcc,
    trainingTimeMs: totalMs,
    convergenceIters,
    sparsity: sp,
    usedMock,
  };
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
 * Render a GFM Markdown table comparing the two pipelines.
 *
 * @param {object} result - output of `runBenchmark`
 * @returns {string}
 */
export function renderMarkdown(result) {
  const { independent, joint, config, jointMock } = result;
  const rows = [
    ['Metric', 'Independent', 'Joint'],
    ['pairAccuracy', fmt(independent?.pairAccuracy), fmt(joint?.pairAccuracy)],
    ['trainingTimeMs', fmt(independent?.trainingTimeMs, 2), fmt(joint?.trainingTimeMs, 2)],
    ['convergenceIters', String(independent?.convergenceIters ?? 'N/A'), String(joint?.convergenceIters ?? 'N/A')],
    ['sparsity', fmt(independent?.sparsity), fmt(joint?.sparsity)],
    ['familiesTouched', String(independent?.familiesTouched ?? 'N/A'), 'N/A'],
  ];
  const header = `| ${rows[0].join(' | ')} |`;
  const sep = `| ${rows[0].map(() => '---').join(' | ')} |`;
  const body = rows.slice(1).map((r) => `| ${r.join(' | ')} |`).join('\n');

  const footer = jointMock
    ? '\n\n> **Note**: Joint pipeline ran on the harness mock stub — '
      + '`lib/learning/grpo/joint-policy.js` (JP1) not yet merged. '
      + 'Re-run after JP1 merge for production numbers.'
    : '';
  const cfg = `\n\nConfig: episodes=${config.episodes}, seed=${config.seed}, iterations=${config.iterations}, trainRatio=${config.trainRatio}, correlationStrength=${config.correlationStrength}.`;
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
 *   targetAccuracy?: number,
 *   correlationStrength?: number,
 *   dryRun?: boolean,
 *   agentMod?: object,
 *   skillMod?: object,
 *   jointMod?: object|null,
 * }} [options]
 * @returns {Promise<{
 *   config: object,
 *   independent: object|null,
 *   joint: object|null,
 *   jointMock: boolean,
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
    targetAccuracy: options.targetAccuracy ?? 0.75,
    correlationStrength: options.correlationStrength ?? 1.0,
  };

  if (options.dryRun) {
    return {
      config,
      independent: null,
      joint: null,
      jointMock: false,
      episodesGenerated: 0,
      skipped: true,
    };
  }

  const agentMod = options.agentMod ?? await loadAgentPolicyModule();
  const skillMod = options.skillMod ?? await loadSkillPolicyModule();
  const jointMod = options.jointMod !== undefined
    ? options.jointMod
    : await loadJointPolicyModule();

  const episodes = generateEpisodes({
    count: config.episodes,
    seed: config.seed,
    correlationStrength: config.correlationStrength,
  });
  const { train, heldOut } = splitEpisodes(episodes, config.trainRatio);

  const independent = benchmarkIndependent({
    agentMod, skillMod, train, heldOut,
    iterations: config.iterations,
    targetAccuracy: config.targetAccuracy,
  });

  const joint = benchmarkJoint({
    jointMod, train, heldOut,
    iterations: config.iterations,
    targetAccuracy: config.targetAccuracy,
  });

  return {
    config,
    independent,
    joint,
    jointMock: joint?.usedMock === true,
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
    correlationStrength: 1.0,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--episodes') args.episodes = Number(argv[++i]);
    else if (a === '--seed') args.seed = Number(argv[++i]);
    else if (a === '--iterations') args.iterations = Number(argv[++i]);
    else if (a === '--output') args.output = argv[++i];
    else if (a === '--correlation') args.correlationStrength = Number(argv[++i]);
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function printHelp() {
  process.stderr.write(
    [
      'benchmark-joint-policy.mjs — Independent vs Joint agent+skill benchmark',
      '',
      'Usage:',
      '  node benchmark-joint-policy.mjs [options]',
      '',
      'Options:',
      '  --episodes N       Number of synthetic episodes (default: 400)',
      '  --seed S           RNG seed for deterministic data (default: 42)',
      '  --iterations N     Training iterations per policy (default: 30)',
      '  --correlation X    Correlation strength in [0, 1] (default: 1.0)',
      '  --output PATH      Write JSON result to PATH (Markdown still to stdout)',
      '  --dry-run          Skip training, validate wiring only',
      '  --help             Show this help',
      '',
    ].join('\n'),
  );
}

/**
 * CLI entry. Returns exit code (0 = success, 1 = failure).
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
  if (!Number.isFinite(args.correlationStrength)
    || args.correlationStrength < 0
    || args.correlationStrength > 1) {
    process.stderr.write('error: --correlation must be a number in [0, 1]\n');
    return 1;
  }

  const result = await runBenchmark({
    episodes: args.episodes,
    seed: args.seed,
    iterations: args.iterations,
    correlationStrength: args.correlationStrength,
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
