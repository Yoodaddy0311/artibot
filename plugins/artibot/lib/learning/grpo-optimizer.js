/**
 * GRPO (Group Relative Policy Optimization) module.
 * Lightweight, rule-based self-learning without external judge AI.
 * Generates multiple candidate solutions, evaluates them via deterministic rules,
 * ranks by relative group performance, and updates strategy weights.
 *
 * Also applies GRPO to team orchestration: simulates team compositions
 * and learns which configurations yield the best results per domain.
 *
 * @module lib/learning/grpo-optimizer
 */

import path from 'node:path';
import { readJsonFile, writeJsonFile, ensureDir } from '../core/file.js';
import { getHomeDir } from '../core/platform.js';

const GRPO_FILENAME = 'grpo-history.json';
const MAX_HISTORY = 300;
const DEFAULT_CANDIDATE_COUNT = 5;

// ---------------------------------------------------------------------------
// CLI-environment rule-based evaluators
// ---------------------------------------------------------------------------

/**
 * Built-in rules for CLI task evaluation.
 * Each rule takes a result object and returns a score in [0, 1].
 */
const DEFAULT_RULES = {
  exitCode: (result) => (result.exitCode === 0 ? 1.0 : 0.0),
  errorFree: (result) => (result.errors === 0 ? 1.0 : 0.0),
  speed: (result) => 1.0 / (1 + (result.duration ?? 0) / 1000),
  brevity: (result) => 1.0 / (1 + (result.commandLength ?? 0) / 50),
  sideEffects: (result) => (result.sideEffects === 0 ? 1.0 : 0.5),
};

/**
 * Team composition rule evaluators.
 * Score how well a team configuration performed.
 */
const TEAM_RULES = {
  successRate: (r) => (r.taskCount > 0 ? r.successCount / r.taskCount : 0),
  efficiency: (r) => 1.0 / (1 + (r.duration ?? 0) / 60000),
  resourceUse: (r) => 1.0 / (1 + (r.teamSize ?? 1) / 5),
  completeness: (r) => (r.taskCount > 0 ? r.completedCount / r.taskCount : 0),
};

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

function getStorageDir() {
  return path.join(getHomeDir(), '.claude', 'artibot');
}

function getHistoryPath() {
  return path.join(getStorageDir(), GRPO_FILENAME);
}

async function loadHistory() {
  const data = await readJsonFile(getHistoryPath());
  if (!data || typeof data !== 'object') {
    return { rounds: [], weights: {}, teamWeights: {} };
  }
  return {
    rounds: Array.isArray(data.rounds) ? data.rounds : [],
    weights: data.weights && typeof data.weights === 'object' ? data.weights : {},
    teamWeights: data.teamWeights && typeof data.teamWeights === 'object' ? data.teamWeights : {},
  };
}

async function saveHistory(history) {
  await ensureDir(getStorageDir());
  const trimmed = {
    ...history,
    rounds: history.rounds.slice(-MAX_HISTORY),
  };
  await writeJsonFile(getHistoryPath(), trimmed);
}

// ---------------------------------------------------------------------------
// Core GRPO functions
// ---------------------------------------------------------------------------

/**
 * Generate candidate solution descriptors for a task.
 * In a CLI agent context, candidates represent different approaches/strategies
 * rather than actual code generation (which the LLM handles).
 *
 * @param {object} task - { id, type, description, domain }
 * @param {number} [count=5] - Number of candidates to generate
 * @returns {object[]} Array of candidate descriptors with strategy metadata
 */
export function generateCandidates(task, count = DEFAULT_CANDIDATE_COUNT) {
  const strategies = getStrategiesForDomain(task.domain ?? 'general', task.type ?? 'unknown');
  const candidates = [];

  for (let i = 0; i < count; i++) {
    const strategy = strategies[i % strategies.length];
    candidates.push({
      id: `cand-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 6)}`,
      taskId: task.id ?? null,
      taskType: task.type ?? 'unknown',
      domain: task.domain ?? 'general',
      strategy: strategy.name,
      description: strategy.description,
      params: strategy.params,
      index: i,
    });
  }

  return candidates;
}

/**
 * Evaluate a group of candidates using rule-based scoring and rank them.
 * Each candidate's result is scored against every rule, then a weighted
 * composite score determines the relative ranking within the group.
 *
 * @param {object[]} candidates - Array of { id, result: { exitCode, errors, duration, commandLength, sideEffects, ... } }
 * @param {object} [rules] - Custom rules object; defaults to DEFAULT_RULES
 * @returns {{
 *   rankings: { candidateId: string, strategy: string, scores: object, composite: number, rank: number }[],
 *   best: object,
 *   worst: object,
 *   spread: number
 * }}
 */
export function evaluateGroup(candidates, rules) {
  const activeRules = rules ?? DEFAULT_RULES;
  const ruleNames = Object.keys(activeRules);

  const scored = candidates.map((c) => {
    const result = c.result ?? {};
    const scores = {};
    let composite = 0;

    for (const ruleName of ruleNames) {
      const fn = activeRules[ruleName];
      const score = typeof fn === 'function' ? clamp01(fn(result)) : 0;
      scores[ruleName] = Math.round(score * 1000) / 1000;
      composite += score;
    }

    composite = ruleNames.length > 0 ? composite / ruleNames.length : 0;

    return {
      candidateId: c.id,
      strategy: c.strategy ?? 'unknown',
      scores,
      composite: Math.round(composite * 1000) / 1000,
    };
  });

  // Sort descending by composite for ranking
  scored.sort((a, b) => b.composite - a.composite);
  const rankings = scored.map((s, i) => ({ ...s, rank: i + 1 }));

  const best = rankings[0] ?? null;
  const worst = rankings[rankings.length - 1] ?? null;
  const spread = best && worst ? Math.round((best.composite - worst.composite) * 1000) / 1000 : 0;

  return { rankings, best, worst, spread };
}

/**
 * Update strategy weights based on group rankings.
 * Higher-ranked candidates boost their strategy's weight;
 * lower-ranked candidates reduce it. Uses exponential moving average.
 *
 * @param {{ rankings: object[] }} groupResult - Output from evaluateGroup
 * @param {object} [options]
 * @param {number} [options.learningRate=0.1] - How fast weights adapt
 * @param {boolean} [options.persist=true] - Save to disk
 * @returns {Promise<object>} Updated weights map { strategy: weight }
 */
export async function updateWeights(groupResult, options = {}) {
  const { learningRate = 0.1, persist = true } = options;
  const { rankings } = groupResult;

  if (!rankings || rankings.length === 0) {
    return {};
  }

  const history = await loadHistory();
  const weights = { ...history.weights };
  const n = rankings.length;

  // Relative advantage: normalize rank to [-1, 1] range
  // Rank 1 (best) -> +1, Rank N (worst) -> -1
  for (const entry of rankings) {
    const advantage = n > 1 ? 1 - 2 * (entry.rank - 1) / (n - 1) : 0;
    const currentWeight = weights[entry.strategy] ?? 1.0;
    const updated = currentWeight + learningRate * advantage * entry.composite;
    weights[entry.strategy] = Math.round(Math.max(0.01, Math.min(5.0, updated)) * 1000) / 1000;
  }

  if (persist) {
    const round = {
      id: `grpo-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: new Date().toISOString(),
      type: 'task',
      candidateCount: rankings.length,
      bestStrategy: rankings[0]?.strategy,
      bestScore: rankings[0]?.composite,
      spread: groupResult.spread,
    };
    history.rounds = [...history.rounds, round];
    history.weights = weights;
    await saveHistory(history);
  }

  return weights;
}

// ---------------------------------------------------------------------------
// Team orchestration GRPO
// ---------------------------------------------------------------------------

/**
 * Generate team composition candidates for a given task domain.
 * Simulates different team configurations (Solo, Squad, Platoon, etc.)
 * to find the optimal setup.
 *
 * @param {object} task - { id, type, description, domain }
 * @param {object} [options]
 * @param {string[]} [options.patterns] - Patterns to compare; defaults to all
 * @returns {object[]} Array of team composition candidates
 */
export function generateTeamCandidates(task, options = {}) {
  const domain = task.domain ?? 'general';
  const patterns = options.patterns ?? ['solo', 'leader', 'council', 'swarm', 'pipeline'];

  const compositions = {
    solo: { size: 0, agents: [], pattern: 'solo', description: 'Direct execution, no team' },
    leader: {
      size: 3,
      agents: getAgentsForDomain(domain, 3),
      pattern: 'leader',
      description: 'Leader assigns tasks, collects results',
    },
    council: {
      size: 3,
      agents: getAgentsForDomain(domain, 3),
      pattern: 'council',
      description: 'Teammates discuss via messaging, leader decides',
    },
    swarm: {
      size: 5,
      agents: getAgentsForDomain(domain, 5),
      pattern: 'swarm',
      description: 'Independent parallel tasks, self-claim from shared list',
    },
    pipeline: {
      size: 4,
      agents: getAgentsForDomain(domain, 4),
      pattern: 'pipeline',
      description: 'Sequential tasks with dependency chains',
    },
  };

  return patterns
    .filter((p) => compositions[p])
    .map((p) => ({
      id: `team-cand-${Date.now()}-${p}-${Math.random().toString(36).slice(2, 6)}`,
      taskId: task.id ?? null,
      domain,
      ...compositions[p],
    }));
}

/**
 * Evaluate team composition candidates after execution and rank them.
 *
 * @param {object[]} teamCandidates - Each must have a `result` with:
 *   { taskCount, successCount, completedCount, duration, teamSize }
 * @param {object} [rules] - Custom team rules; defaults to TEAM_RULES
 * @returns {{ rankings: object[], best: object, worst: object, spread: number }}
 */
export function evaluateTeamGroup(teamCandidates, rules) {
  const activeRules = rules ?? TEAM_RULES;
  const ruleNames = Object.keys(activeRules);

  const scored = teamCandidates.map((c) => {
    const result = c.result ?? {};
    const scores = {};
    let composite = 0;

    for (const ruleName of ruleNames) {
      const fn = activeRules[ruleName];
      const score = typeof fn === 'function' ? clamp01(fn(result)) : 0;
      scores[ruleName] = Math.round(score * 1000) / 1000;
      composite += score;
    }

    composite = ruleNames.length > 0 ? composite / ruleNames.length : 0;

    return {
      candidateId: c.id,
      pattern: c.pattern ?? 'unknown',
      teamSize: c.size ?? 0,
      domain: c.domain ?? 'general',
      agents: c.agents ?? [],
      scores,
      composite: Math.round(composite * 1000) / 1000,
    };
  });

  scored.sort((a, b) => b.composite - a.composite);
  const rankings = scored.map((s, i) => ({ ...s, rank: i + 1 }));
  const best = rankings[0] ?? null;
  const worst = rankings[rankings.length - 1] ?? null;
  const spread = best && worst ? Math.round((best.composite - worst.composite) * 1000) / 1000 : 0;

  return { rankings, best, worst, spread };
}

/**
 * Update team composition weights based on group evaluation.
 * Keys are "pattern|size|domain" for specific composition tracking.
 *
 * @param {{ rankings: object[] }} groupResult - Output from evaluateTeamGroup
 * @param {object} [options]
 * @param {number} [options.learningRate=0.1]
 * @param {boolean} [options.persist=true]
 * @returns {Promise<object>} Updated teamWeights map
 */
export async function updateTeamWeights(groupResult, options = {}) {
  const { learningRate = 0.1, persist = true } = options;
  const { rankings } = groupResult;

  if (!rankings || rankings.length === 0) {
    return {};
  }

  const history = await loadHistory();
  const teamWeights = { ...history.teamWeights };
  const n = rankings.length;

  for (const entry of rankings) {
    const key = `${entry.pattern}|${entry.teamSize}|${entry.domain}`;
    const advantage = n > 1 ? 1 - 2 * (entry.rank - 1) / (n - 1) : 0;
    const currentWeight = teamWeights[key] ?? 1.0;
    const updated = currentWeight + learningRate * advantage * entry.composite;
    teamWeights[key] = Math.round(Math.max(0.01, Math.min(5.0, updated)) * 1000) / 1000;
  }

  if (persist) {
    const round = {
      id: `grpo-team-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: new Date().toISOString(),
      type: 'team',
      candidateCount: rankings.length,
      bestPattern: rankings[0]?.pattern,
      bestScore: rankings[0]?.composite,
      bestSize: rankings[0]?.teamSize,
      domain: rankings[0]?.domain,
      spread: groupResult.spread,
    };
    history.rounds = [...history.rounds, round];
    history.teamWeights = teamWeights;
    await saveHistory(history);
  }

  return teamWeights;
}

/**
 * Recommend the best strategy or team composition for a given context
 * based on accumulated GRPO weights.
 *
 * @param {'task'|'team'} type - Recommendation type
 * @param {object} [context] - { domain, taskType }
 * @returns {Promise<{ recommendation: string, weight: number, alternatives: object[] }>}
 */
export async function getRecommendation(type, context = {}) {
  const history = await loadHistory();

  if (type === 'team') {
    const domain = context.domain ?? 'general';
    const entries = Object.entries(history.teamWeights)
      .filter(([key]) => key.endsWith(`|${domain}`) || domain === 'general')
      .map(([key, weight]) => {
        const [pattern, size] = key.split('|');
        return { key, pattern, size: Number(size), weight };
      })
      .sort((a, b) => b.weight - a.weight);

    if (entries.length === 0) {
      return { recommendation: 'leader|3', weight: 1.0, alternatives: [] };
    }

    return {
      recommendation: `${entries[0].pattern}|${entries[0].size}`,
      weight: entries[0].weight,
      alternatives: entries.slice(1, 4),
    };
  }

  // Task strategy recommendation
  const entries = Object.entries(history.weights)
    .sort(([, a], [, b]) => b - a);

  if (entries.length === 0) {
    return { recommendation: 'balanced', weight: 1.0, alternatives: [] };
  }

  return {
    recommendation: entries[0][0],
    weight: entries[0][1],
    alternatives: entries.slice(1, 4).map(([strategy, weight]) => ({ strategy, weight })),
  };
}

/**
 * Get GRPO optimization history and statistics.
 *
 * @param {object} [options]
 * @param {number} [options.lookback=50]
 * @returns {Promise<{
 *   totalRounds: number,
 *   taskRounds: number,
 *   teamRounds: number,
 *   weights: object,
 *   teamWeights: object,
 *   recentRounds: object[]
 * }>}
 */
export async function getGrpoStats(options = {}) {
  const { lookback = 50 } = options;
  const history = await loadHistory();
  const recent = history.rounds.slice(-lookback);

  return {
    totalRounds: history.rounds.length,
    taskRounds: recent.filter((r) => r.type === 'task').length,
    teamRounds: recent.filter((r) => r.type === 'team').length,
    weights: { ...history.weights },
    teamWeights: { ...history.teamWeights },
    recentRounds: recent,
  };
}

// ---------------------------------------------------------------------------
// Strategy catalog
// ---------------------------------------------------------------------------

function getStrategiesForDomain(domain, taskType) {
  const base = [
    { name: 'balanced', description: 'Balanced approach with moderate depth', params: { depth: 'moderate', parallel: false } },
    { name: 'thorough', description: 'Deep analysis with comprehensive coverage', params: { depth: 'deep', parallel: false } },
    { name: 'rapid', description: 'Quick execution with minimal overhead', params: { depth: 'shallow', parallel: false } },
    { name: 'parallel', description: 'Parallel execution with multiple sub-agents', params: { depth: 'moderate', parallel: true } },
    { name: 'iterative', description: 'Iterative refinement with progressive enhancement', params: { depth: 'moderate', parallel: false, iterations: 3 } },
  ];

  const domainStrategies = {
    frontend: [
      { name: 'component-first', description: 'Component-driven development with design system', params: { depth: 'moderate', focus: 'components' } },
      { name: 'accessibility-first', description: 'Accessibility-driven with WCAG compliance', params: { depth: 'deep', focus: 'a11y' } },
    ],
    backend: [
      { name: 'api-first', description: 'API contract-first development', params: { depth: 'moderate', focus: 'api' } },
      { name: 'tdd', description: 'Test-driven development with full coverage', params: { depth: 'deep', focus: 'testing' } },
    ],
    security: [
      { name: 'threat-model', description: 'Threat modeling with STRIDE framework', params: { depth: 'deep', focus: 'threats' } },
      { name: 'audit-scan', description: 'Automated vulnerability scanning', params: { depth: 'moderate', focus: 'vulnerabilities' } },
    ],
  };

  const extras = domainStrategies[domain] ?? [];
  return [...base, ...extras];
}

function getAgentsForDomain(domain, count) {
  const domainAgents = {
    frontend: ['frontend-developer', 'code-reviewer', 'e2e-runner', 'architect', 'tdd-guide'],
    backend: ['backend-developer', 'code-reviewer', 'database-reviewer', 'security-reviewer', 'tdd-guide'],
    security: ['security-reviewer', 'code-reviewer', 'backend-developer', 'architect', 'devops-engineer'],
    infrastructure: ['devops-engineer', 'architect', 'security-reviewer', 'backend-developer', 'build-error-resolver'],
    documentation: ['doc-updater', 'code-reviewer', 'architect', 'planner', 'tdd-guide'],
    general: ['architect', 'code-reviewer', 'planner', 'tdd-guide', 'backend-developer'],
  };

  const pool = domainAgents[domain] ?? domainAgents.general;
  return pool.slice(0, count);
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function clamp01(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/** Exported rule sets for external use and customization */
export const CLI_RULES = { ...DEFAULT_RULES };
export const TEAM_EVALUATION_RULES = { ...TEAM_RULES };
