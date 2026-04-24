/**
 * GRPO-RLVR Joint Agent + Skill Policy (v3.7, Sections 5.4 + 5.5).
 *
 * Extends the independent per-axis GRPO surfaces into a **joint policy** that
 * couples agent selection and skill triggering through a per-family correlation
 * matrix. Instead of introducing a new reward signal, it reuses the verifiable
 * rewards already captured by `agent-policy.js` and `skill-policy.js` and adds
 * a co-occurrence tensor so callers can ask "given this task family + intent,
 * which (agent, skill-set) combination historically wins together?".
 *
 * Pipeline:
 *   1. Marginal pass — delegate agent weights to `agent-policy` and skill
 *      scores to `skill-policy` (zero rewrite of their internals).
 *   2. Correlation adjustment — for each (taskFamily, agent, skill) tuple,
 *      maintain `count(agent,skill co-use) / count(agent use)` as a
 *      conditional probability estimate. Skill scores are multiplied by
 *      `(1 + lambda * corr)` to nudge high-covariance skills up when the
 *      chosen agent is present in the co-occurrence column.
 *   3. Fallback — a brand-new task family with zero correlation evidence
 *      degrades cleanly to the independent (marginal) setting.
 *
 * Persistence lives alongside the other GRPO policies at
 *   `~/.claude/artibot/policies/joint-policy-v1.json`
 * and holds only the correlation/co-occurrence tensor — the agent weights and
 * skill weights stay in their own files, so training and rollback remain
 * orthogonal.
 *
 * Zero external deps. Deterministic under `NODE_ENV=test`. No network IO.
 *
 * See `_design/grpo-rlvr-routing-2026-04-24.md` Sections 5.4, 5.5, 6.
 *
 * @module lib/learning/grpo/joint-policy
 */

import path from 'node:path';
import { ensureDir, readJsonFile, writeJsonFile } from '../../core/file.js';
import { getHomeDir } from '../../core/platform.js';

import {
  createAgentPolicy,
  getRecommendation as getAgentRecommendation,
  selectAgent as selectAgentMarginal,
  defaultCandidates as defaultAgentCandidates,
  loadPolicy as loadAgentPolicy,
  normalizeEpisode as normalizeAgentEpisode,
} from './agent-policy.js';

import {
  createSkillPolicy,
  scoreSkillsWith,
  selectFromScores,
  loadPolicy as loadSkillPolicy,
  emptyPolicy as emptySkillPolicy,
} from './skill-policy.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const POLICY_VERSION = 1;
export const MODEL_TYPE = 'joint-correlation';

/** Training + selection defaults. Conservative; callers override via `config`. */
export const DEFAULTS = Object.freeze({
  /** Correlation influence on skill scores. `score' = score * (1 + lambda*corr)`. */
  lambda: 0.5,
  /** Minimum episodes per family before correlation is trusted (else independent). */
  minCorrelationEpisodes: 5,
  /** Threshold + cap forwarded to skill selection. */
  threshold: 0.5,
  maxTriggers: 3,
  /** Neutral skill bias when the skill policy lacks a trained entry. */
  neutralScore: 0.5,
  /** Max agents tracked per family (LRU by usage count). */
  maxAgentsPerFamily: 32,
  /** Max skills tracked per (family, agent) cell (LRU by count). */
  maxSkillsPerCell: 64,
});

// ---------------------------------------------------------------------------
// Joint policy record schema
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} JointCell
 * @property {number} agentCount   - count(agent used in family)
 * @property {Record<string, number>} skills - skill co-use counts
 */

/**
 * @typedef {Object} JointPolicyRecord
 * @property {number} version
 * @property {string} modelType
 * @property {Record<string, Record<string, JointCell>>} correlation
 *   correlation[family][agent] = JointCell
 * @property {string|null} trainedAt
 * @property {object} metrics
 */

/**
 * Build an empty correlation record.
 * @returns {JointPolicyRecord}
 */
export function emptyPolicy() {
  return {
    version: POLICY_VERSION,
    modelType: MODEL_TYPE,
    correlation: Object.create(null),
    trainedAt: null,
    metrics: {},
  };
}

function ensureFamily(policy, family) {
  if (!policy.correlation[family]) policy.correlation[family] = Object.create(null);
  return policy.correlation[family];
}

function ensureCell(policy, family, agent) {
  const famMap = ensureFamily(policy, family);
  if (!famMap[agent]) famMap[agent] = { agentCount: 0, skills: Object.create(null) };
  return famMap[agent];
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Resolve the joint-policy storage paths.
 * @param {string} [policyPath]
 * @returns {{ policyFile: string, snapshotDir: string }}
 */
export function resolvePolicyPaths(policyPath) {
  const file = policyPath && path.isAbsolute(policyPath)
    ? policyPath
    : path.join(getHomeDir(), '.claude', 'artibot', 'policies', 'joint-policy-v1.json');
  const dir = path.dirname(file);
  return { policyFile: file, snapshotDir: path.join(dir, 'joint-snapshots') };
}

/**
 * Load the persisted joint correlation tensor. Returns `null` on missing or
 * malformed files so callers can cleanly fall back to the independent path.
 *
 * @param {string} [policyPath]
 * @returns {Promise<JointPolicyRecord|null>}
 */
export async function loadPolicy(policyPath) {
  const { policyFile } = resolvePolicyPaths(policyPath);
  const data = await readJsonFile(policyFile);
  if (!data || typeof data !== 'object') return null;
  if (data.modelType !== MODEL_TYPE) return null;
  if (!data.correlation || typeof data.correlation !== 'object') return null;
  return data;
}

/**
 * Atomic-ish write of the correlation tensor.
 *
 * @param {JointPolicyRecord} policy
 * @param {object} [options]
 * @param {string} [options.policyPath]
 * @param {object} [options.metrics]
 * @returns {Promise<{ policy: JointPolicyRecord, policyFile: string }>}
 */
export async function savePolicy(policy, options = {}) {
  const { policyFile } = resolvePolicyPaths(options.policyPath);
  await ensureDir(path.dirname(policyFile));

  const record = {
    version: POLICY_VERSION,
    modelType: MODEL_TYPE,
    correlation: serializeCorrelation(policy.correlation ?? {}),
    trainedAt: new Date().toISOString(),
    metrics: {
      familiesTouched: options.metrics?.familiesTouched ?? 0,
      episodesUsed: options.metrics?.episodesUsed ?? 0,
      agentSkillPairs: options.metrics?.agentSkillPairs ?? 0,
    },
  };

  await writeJsonFile(policyFile, record);
  return { policy: record, policyFile };
}

function serializeCorrelation(corr) {
  const out = {};
  for (const fam of Object.keys(corr ?? {})) {
    const famMap = corr[fam];
    if (!famMap || typeof famMap !== 'object') continue;
    out[fam] = {};
    for (const agent of Object.keys(famMap)) {
      const cell = famMap[agent];
      if (!cell || typeof cell !== 'object') continue;
      out[fam][agent] = {
        agentCount: Number.isFinite(cell.agentCount) ? cell.agentCount : 0,
        skills: { ...(cell.skills ?? {}) },
      };
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Episode normalization (joint shape)
// ---------------------------------------------------------------------------

/**
 * Normalize a joint episode. Reuses the per-axis normalizers so any shape
 * accepted by agent-policy + skill-policy individually is also acceptable
 * here. Returns `null` on missing required fields.
 *
 * Expected shape:
 *   {
 *     reward: number,
 *     taskFamily: string,
 *     selectedAgent: string,
 *     skillsUsed?: string[],     // may be empty — still a valid agent episode
 *     isExploration?: boolean,
 *     candidates?: string[],
 *   }
 *
 * @param {object} episode
 * @returns {{
 *   family: string,
 *   agent: string,
 *   skills: string[],
 *   reward: number,
 *   exploration: boolean,
 * } | null}
 */
export function normalizeEpisode(episode) {
  const base = normalizeAgentEpisode(episode);
  if (!base) return null;
  const skills = Array.isArray(episode?.skillsUsed)
    ? episode.skillsUsed.filter((s) => typeof s === 'string' && s)
    : [];
  return {
    family: base.family,
    agent: base.agent,
    skills,
    reward: base.reward,
    exploration: base.exploration,
  };
}

// ---------------------------------------------------------------------------
// Correlation math
// ---------------------------------------------------------------------------

/**
 * Conditional co-use probability `P(skill | agent, family)` from the stored
 * counts. Returns 0 when the cell is missing or the agent was never observed.
 *
 * @param {JointPolicyRecord|null|undefined} policy
 * @param {string} family
 * @param {string} agent
 * @param {string} skill
 * @returns {number} in [0, 1]
 */
export function correlationOf(policy, family, agent, skill) {
  if (!policy || !policy.correlation) return 0;
  const cell = policy.correlation[family]?.[agent];
  if (!cell || !Number.isFinite(cell.agentCount) || cell.agentCount <= 0) return 0;
  const n = cell.skills?.[skill];
  if (!Number.isFinite(n) || n <= 0) return 0;
  const p = n / cell.agentCount;
  if (!Number.isFinite(p)) return 0;
  return Math.max(0, Math.min(1, p));
}

/**
 * Total episode count observed for a family — sum of agent usage. Used as the
 * fallback gate for "trust the correlation tensor".
 *
 * @param {JointPolicyRecord|null|undefined} policy
 * @param {string} family
 * @returns {number}
 */
export function familyEvidence(policy, family) {
  if (!policy || !policy.correlation) return 0;
  const famMap = policy.correlation[family];
  if (!famMap) return 0;
  let total = 0;
  for (const a of Object.keys(famMap)) {
    const c = famMap[a]?.agentCount;
    if (Number.isFinite(c)) total += c;
  }
  return total;
}

/**
 * Adjust a skill score with the correlation nudge.
 *   score' = clamp01(score * (1 + lambda * corr))
 *
 * @param {number} score
 * @param {number} corr
 * @param {number} [lambda=DEFAULTS.lambda]
 * @returns {number}
 */
export function adjustSkillScore(score, corr, lambda = DEFAULTS.lambda) {
  if (!Number.isFinite(score)) return 0;
  const c = Number.isFinite(corr) ? Math.max(0, Math.min(1, corr)) : 0;
  const l = Number.isFinite(lambda) ? lambda : 0;
  const adjusted = score * (1 + l * c);
  if (!Number.isFinite(adjusted)) return score;
  return Math.max(0, Math.min(1, adjusted));
}

// ---------------------------------------------------------------------------
// Batch update — correlation tensor
// ---------------------------------------------------------------------------

/**
 * Fold a batch of normalized episodes into an in-memory correlation tensor.
 * Non-exploration episodes only. Mutates `tensor` (caller owns clone).
 *
 * @param {JointPolicyRecord} tensor
 * @param {Array<ReturnType<typeof normalizeEpisode>>} episodes
 * @param {object} [options]
 * @returns {{ episodesUsed: number, familiesTouched: number, agentSkillPairs: number }}
 */
export function updateCorrelation(tensor, episodes, options = {}) {
  const maxAgents = options.maxAgentsPerFamily ?? DEFAULTS.maxAgentsPerFamily;
  const maxSkills = options.maxSkillsPerCell ?? DEFAULTS.maxSkillsPerCell;

  const touchedFamilies = new Set();
  let used = 0;
  let pairs = 0;

  for (const ep of episodes ?? []) {
    if (!ep || ep.exploration) continue;
    const cell = ensureCell(tensor, ep.family, ep.agent);
    cell.agentCount = (cell.agentCount ?? 0) + 1;
    for (const s of ep.skills) {
      cell.skills[s] = (cell.skills[s] ?? 0) + 1;
      pairs += 1;
    }
    touchedFamilies.add(ep.family);
    used += 1;
  }

  // LRU-style trim so hot cells do not grow unbounded.
  for (const fam of touchedFamilies) {
    trimFamily(tensor.correlation[fam], maxAgents, maxSkills);
  }

  return {
    episodesUsed: used,
    familiesTouched: touchedFamilies.size,
    agentSkillPairs: pairs,
  };
}

function trimFamily(famMap, maxAgents, maxSkills) {
  if (!famMap) return;
  const agents = Object.keys(famMap);
  if (agents.length > maxAgents) {
    const ranked = agents
      .map((a) => ({ a, c: famMap[a]?.agentCount ?? 0 }))
      .sort((x, y) => x.c - y.c);
    const drop = ranked.slice(0, agents.length - maxAgents);
    for (const { a } of drop) delete famMap[a];
  }
  for (const a of Object.keys(famMap)) {
    const cell = famMap[a];
    if (!cell || !cell.skills) continue;
    const skills = Object.keys(cell.skills);
    if (skills.length > maxSkills) {
      const ranked = skills
        .map((s) => ({ s, c: cell.skills[s] ?? 0 }))
        .sort((x, y) => x.c - y.c);
      const drop = ranked.slice(0, skills.length - maxSkills);
      for (const { s } of drop) delete cell.skills[s];
    }
  }
}

// ---------------------------------------------------------------------------
// Joint selection
// ---------------------------------------------------------------------------

/**
 * Perform joint selection given pre-loaded marginal weights + joint tensor.
 * Pure / synchronous; the facade handles IO.
 *
 * Algorithm:
 *   1. Rank agents by the marginal softmax; pick the argmax.
 *   2. For each candidate skill, compute the marginal score and adjust it by
 *      `(1 + lambda * corr(family, chosenAgent, skill))`.
 *   3. Apply threshold + maxTriggers to the adjusted scores.
 *   4. If family evidence < minCorrelationEpisodes, return the independent
 *      (marginal) result and tag `source: 'independent'`.
 *
 * @param {object} params
 * @param {object} params.agentWeights       - agent-policy weights tree
 * @param {object} params.skillPolicy        - skill-policy record (or empty)
 * @param {JointPolicyRecord|null} params.jointPolicy
 * @param {string} params.taskFamily
 * @param {string} params.intent
 * @param {object} [params.context]
 * @param {object} [params.options]
 * @returns {{
 *   agent: string|null,
 *   skills: Array<{ name: string, score: number, correlation: number }>,
 *   confidence: number,
 *   source: 'joint'|'independent'|'fallback',
 *   agentSource: 'policy'|'baseline'|'fallback',
 *   alternatives: Array<{ agent: string, prob: number, weight: number }>,
 * }}
 */
export function selectJointWith(params) {
  const {
    agentWeights = {},
    skillPolicy = emptySkillPolicy(),
    jointPolicy = null,
    taskFamily,
    intent,
    context = {},
    options = {},
  } = params ?? {};

  const candidateAgents = Array.isArray(options.agentCandidates)
    ? options.agentCandidates
    : defaultAgentCandidates(agentWeights, taskFamily, options.config);
  const candidateSkills = Array.isArray(options.skillCandidates)
    ? options.skillCandidates
    : [];

  const agentRec = getAgentRecommendation(agentWeights, taskFamily, {
    candidates: candidateAgents,
    temperature: options.temperature,
    config: options.config,
    minFamilyOccurrences: options.minFamilyOccurrences,
    topK: options.topK ?? 3,
  });

  const alternatives = agentRec.alternatives ?? [];
  const chosenAgent = agentRec.recommendation;

  // Skill marginal scores.
  const skillScores = scoreSkillsWith(
    skillPolicy,
    intent,
    context,
    candidateSkills,
    { neutralScore: options.neutralScore ?? DEFAULTS.neutralScore },
  );

  const evidence = familyEvidence(jointPolicy, taskFamily);
  const minEvidence = options.minCorrelationEpisodes ?? DEFAULTS.minCorrelationEpisodes;
  const useJoint = chosenAgent != null && evidence >= minEvidence;
  const lambda = options.lambda ?? DEFAULTS.lambda;

  const adjusted = Object.create(null);
  const perSkillCorr = Object.create(null);
  for (const name of candidateSkills) {
    const base = skillScores[name];
    if (typeof base !== 'number' || !Number.isFinite(base)) continue;
    const corr = useJoint
      ? correlationOf(jointPolicy, taskFamily, chosenAgent, name)
      : 0;
    perSkillCorr[name] = corr;
    adjusted[name] = useJoint ? adjustSkillScore(base, corr, lambda) : base;
  }

  const threshold = options.threshold ?? DEFAULTS.threshold;
  const maxTriggers = options.maxTriggers ?? DEFAULTS.maxTriggers;
  const picked = selectFromScores(adjusted, { threshold, maxTriggers });

  const skills = picked.map((p) => ({
    name: p.name,
    score: p.score,
    correlation: perSkillCorr[p.name] ?? 0,
  }));

  const source = chosenAgent == null
    ? 'fallback'
    : (useJoint ? 'joint' : 'independent');

  return {
    agent: chosenAgent,
    skills,
    confidence: typeof agentRec.confidence === 'number' ? agentRec.confidence : 0,
    source,
    agentSource: agentRec.source ?? 'fallback',
    alternatives,
  };
}

// ---------------------------------------------------------------------------
// Facade
// ---------------------------------------------------------------------------

/**
 * Create a stateful joint-policy instance.
 *
 * Delegates marginal agent + skill updates to the existing facades so both
 * per-axis snapshots, KL rejection, and metrics stay intact. This module only
 * owns the correlation tensor.
 *
 * @param {object} [options]
 * @param {string} [options.policyPath]          - joint-policy file override
 * @param {string} [options.agentPolicyPath]     - agent-policy file override
 * @param {string} [options.skillPolicyPath]     - skill-policy file override
 * @param {object} [options.config]              - joint-policy config
 * @param {object} [options.agentConfig]         - forwarded to createAgentPolicy
 * @param {object} [options.skillConfig]         - forwarded to createSkillPolicy
 * @param {object} [options.baseConfig]          - artibot.config.json (baselines)
 * @param {{ info: Function, warn: Function, error: Function }} [options.logger]
 * @returns {object}
 */
export function createJointPolicy(options = {}) {
  const jointPath = options.policyPath;
  const config = { ...DEFAULTS, ...(options.config ?? {}) };
  const logger = options.logger ?? { info() {}, warn() {}, error() {} };

  const agentFacade = createAgentPolicy({
    policyPath: options.agentPolicyPath,
    config: options.agentConfig,
    baseConfig: options.baseConfig,
    logger,
  });
  const skillFacade = createSkillPolicy({
    policyPath: options.skillPolicyPath,
    config: options.skillConfig,
    logger,
  });

  return {
    loadPolicy: () => loadPolicy(jointPath),
    loadMarginals: async () => ({
      agent: (await loadAgentPolicy(options.agentPolicyPath)) ?? null,
      skill: (await loadSkillPolicy(options.skillPolicyPath)) ?? null,
      joint: (await loadPolicy(jointPath)) ?? null,
    }),

    /**
     * Resolve a joint recommendation. Safe by construction — missing policy
     * files degrade to independent mode without throwing.
     */
    async selectJoint(taskFamily, intent, context = {}, opts = {}) {
      if (typeof taskFamily !== 'string' || !taskFamily) {
        return {
          agent: null,
          skills: [],
          confidence: 0,
          source: 'fallback',
          agentSource: 'fallback',
          alternatives: [],
        };
      }
      const agentPolicy = (await loadAgentPolicy(options.agentPolicyPath)) ?? { weights: {} };
      const skillPolicy = (await loadSkillPolicy(options.skillPolicyPath)) ?? emptySkillPolicy();
      const jointPolicy = await loadPolicy(jointPath);

      return selectJointWith({
        agentWeights: agentPolicy.weights ?? {},
        skillPolicy,
        jointPolicy,
        taskFamily,
        intent,
        context,
        options: {
          ...config,
          ...opts,
          config: opts.config ?? options.baseConfig,
        },
      });
    },

    /**
     * Co-train the joint surface.
     *
     * Steps:
     *   1. Delegate per-axis updates to agent-policy + skill-policy (each
     *      manages its own KL gate, snapshots, and persistence).
     *   2. Fold the same batch into the correlation tensor and persist.
     *
     * No new reward signal is introduced — we consume the same `reward` field
     * already present on each episode.
     */
    async updateJoint(episodes, heldOut) {
      const safe = Array.isArray(episodes) ? episodes : [];

      // 1. Marginal trainings — fan-out to the existing facades.
      const [agentRes, skillRes] = await Promise.all([
        agentFacade.trainFromEpisodes(safe, heldOut).catch((err) => {
          logger.warn(`joint-policy: agent-train failed: ${err?.message ?? err}`);
          return { policy: null, metrics: { reason: 'agent-train-error' } };
        }),
        skillFacade.updatePolicy(safe).catch((err) => {
          logger.warn(`joint-policy: skill-train failed: ${err?.message ?? err}`);
          return { policy: null, metrics: { reason: 'skill-train-error' } };
        }),
      ]);

      // 2. Correlation tensor update.
      const prev = (await loadPolicy(jointPath)) ?? emptyPolicy();
      const tensor = {
        ...prev,
        correlation: cloneCorrelation(prev.correlation ?? {}),
      };
      const normalized = safe
        .map((e) => normalizeEpisode(e))
        .filter((e) => e !== null);
      const metrics = updateCorrelation(tensor, normalized, {
        maxAgentsPerFamily: config.maxAgentsPerFamily,
        maxSkillsPerCell: config.maxSkillsPerCell,
      });

      let savedJoint = prev;
      if (metrics.episodesUsed > 0) {
        const out = await savePolicy(tensor, {
          policyPath: jointPath,
          metrics,
        });
        savedJoint = out.policy;
      } else {
        logger.info('joint-policy: no trainable joint episodes, skipping joint save');
      }

      return {
        agent: agentRes,
        skill: skillRes,
        joint: savedJoint,
        metrics: {
          ...metrics,
          agent: agentRes?.metrics ?? null,
          skill: skillRes?.metrics ?? null,
        },
      };
    },
  };
}

function cloneCorrelation(corr) {
  const out = Object.create(null);
  for (const fam of Object.keys(corr ?? {})) {
    const famMap = corr[fam];
    if (!famMap || typeof famMap !== 'object') continue;
    const next = Object.create(null);
    for (const a of Object.keys(famMap)) {
      const cell = famMap[a];
      if (!cell || typeof cell !== 'object') continue;
      next[a] = {
        agentCount: Number.isFinite(cell.agentCount) ? cell.agentCount : 0,
        skills: { ...(cell.skills ?? {}) },
      };
    }
    out[fam] = next;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Thin standalone helpers
// ---------------------------------------------------------------------------

/**
 * One-shot joint selection — loads all three policies each call. Prefer the
 * facade when doing multiple picks in a row.
 *
 * @param {string} taskFamily
 * @param {string} intent
 * @param {object} [context]
 * @param {object} [opts]
 * @returns {Promise<ReturnType<typeof selectJointWith>>}
 */
export async function selectJoint(taskFamily, intent, context = {}, opts = {}) {
  const facade = createJointPolicy(opts);
  return facade.selectJoint(taskFamily, intent, context, opts);
}

/**
 * Standalone joint trainer. Persists via savePolicy when any episode was
 * folded, otherwise returns the previous tensor untouched. The per-axis
 * policies update unconditionally (they own their own skip logic).
 *
 * @param {object[]} episodes
 * @param {object} [opts]
 * @returns {Promise<ReturnType<ReturnType<typeof createJointPolicy>['updateJoint']>>}
 */
export async function updateJoint(episodes, opts = {}) {
  const facade = createJointPolicy(opts);
  return facade.updateJoint(episodes, opts.heldOut);
}

// Re-exports so consumers (including grpo-bridge) can grab the important
// marginal selectors without a second import line.
export {
  getAgentRecommendation,
  selectAgentMarginal,
  selectFromScores,
  scoreSkillsWith,
};
