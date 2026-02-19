/**
 * Lifelong Learning Pipeline.
 * Collects daily experiences (tool usage, errors, successes, team compositions),
 * applies GRPO batch learning (rule-based relative comparison without judge AI),
 * extracts optimal patterns, and persists them for future sessions.
 *
 * Cycle: "experience during day -> learn at night -> smarter in the morning"
 *
 * @module lib/learning/lifelong-learner
 */

import path from 'node:path';
import os from 'node:os';
import { readJsonFile, writeJsonFile, ensureDir } from '../core/file.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ARTIBOT_DIR = path.join(os.homedir(), '.claude', 'artibot');
const EXPERIENCES_PATH = path.join(ARTIBOT_DIR, 'daily-experiences.json');
const PATTERNS_DIR = path.join(ARTIBOT_DIR, 'patterns');
const LEARNING_LOG_PATH = path.join(ARTIBOT_DIR, 'learning-log.json');

const MAX_EXPERIENCES = 1000;
const MAX_LOG_ENTRIES = 200;
const MIN_GROUP_SIZE = 2;

/**
 * GRPO weight factors for experience comparison.
 * Rule-based: no judge AI needed.
 */
const EXPERIENCE_WEIGHTS = {
  success: 0.35,
  speed: 0.25,
  errorRate: 0.25,
  resourceEfficiency: 0.15,
};

// ---------------------------------------------------------------------------
// Experience Collection
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} Experience
 * @property {string} id - Unique experience identifier
 * @property {string} type - Experience type: 'tool' | 'error' | 'success' | 'team'
 * @property {string} category - Sub-category within type (e.g. tool name, error class)
 * @property {object} data - Type-specific payload
 * @property {number} timestamp - Unix ms
 * @property {string} sessionId - Session that generated this experience
 */

/**
 * Collect a single experience event.
 * Call this during normal operation whenever a notable event occurs.
 *
 * @param {object} experience
 * @param {string} experience.type - 'tool' | 'error' | 'success' | 'team'
 * @param {string} experience.category - Sub-category for grouping
 * @param {object} experience.data - Event payload
 * @param {string} [experience.sessionId] - Current session ID
 * @returns {Promise<Experience>} The stored experience
 */
export async function collectExperience(experience) {
  await ensureDir(ARTIBOT_DIR);

  const entry = {
    id: `exp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type: experience.type,
    category: experience.category ?? 'general',
    data: experience.data ?? {},
    timestamp: Date.now(),
    sessionId: experience.sessionId ?? null,
  };

  const existing = await loadExperiences();
  const updated = [...existing, entry];
  const pruned = updated.length > MAX_EXPERIENCES
    ? updated.slice(updated.length - MAX_EXPERIENCES)
    : updated;

  await writeJsonFile(EXPERIENCES_PATH, pruned);
  return entry;
}

/**
 * Collect all notable experiences from a completed session.
 * Aggregates tool usage, errors, successes, and team compositions
 * from the provided session data.
 *
 * @param {object} sessionData
 * @param {string} [sessionData.sessionId]
 * @param {Array<{event: string, data?: object}>} [sessionData.history]
 * @param {object} [sessionData.toolUsage] - { toolName: { calls: number, successes: number, totalMs: number } }
 * @param {object[]} [sessionData.errors] - Array of error objects
 * @param {object[]} [sessionData.completedTasks] - Array of completed task results
 * @param {object} [sessionData.teamConfig] - { pattern, size, agents, domain }
 * @returns {Promise<Experience[]>} All collected experiences
 */
export async function collectDailyExperiences(sessionData = {}) {
  const { sessionId, toolUsage = {}, errors = [], completedTasks = [], teamConfig } = sessionData;
  const collected = [];

  // Tool usage experiences
  for (const [toolName, usage] of Object.entries(toolUsage)) {
    const exp = await collectExperience({
      type: 'tool',
      category: toolName,
      data: {
        calls: usage.calls ?? 0,
        successes: usage.successes ?? 0,
        totalMs: usage.totalMs ?? 0,
        avgMs: usage.calls > 0 ? Math.round((usage.totalMs ?? 0) / usage.calls) : 0,
        successRate: usage.calls > 0 ? (usage.successes ?? 0) / usage.calls : 0,
      },
      sessionId,
    });
    collected.push(exp);
  }

  // Error experiences
  for (const error of errors) {
    const exp = await collectExperience({
      type: 'error',
      category: error.type ?? error.code ?? 'unknown',
      data: {
        message: error.message ?? String(error),
        code: error.code ?? null,
        tool: error.tool ?? null,
        recoverable: error.recoverable ?? null,
      },
      sessionId,
    });
    collected.push(exp);
  }

  // Success experiences
  for (const task of completedTasks) {
    const exp = await collectExperience({
      type: 'success',
      category: task.type ?? task.taskType ?? 'task',
      data: {
        taskId: task.id ?? null,
        duration: task.duration ?? null,
        strategy: task.strategy ?? null,
        filesModified: task.filesModified?.length ?? 0,
        testsPass: task.testsPass ?? null,
      },
      sessionId,
    });
    collected.push(exp);
  }

  // Team composition experience
  if (teamConfig) {
    const exp = await collectExperience({
      type: 'team',
      category: teamConfig.pattern ?? 'unknown',
      data: {
        pattern: teamConfig.pattern ?? null,
        size: teamConfig.size ?? 0,
        agents: teamConfig.agents ?? [],
        domain: teamConfig.domain ?? 'general',
        successRate: teamConfig.successRate ?? null,
        duration: teamConfig.duration ?? null,
      },
      sessionId,
    });
    collected.push(exp);
  }

  return collected;
}

// ---------------------------------------------------------------------------
// GRPO Batch Learning
// ---------------------------------------------------------------------------

/**
 * Run GRPO batch learning on collected experiences.
 * Groups experiences by type+category, performs rule-based relative comparison
 * within each group, and extracts optimal patterns.
 *
 * @param {Experience[]} [experiences] - Experiences to learn from; loads from disk if omitted
 * @returns {Promise<{
 *   groupsProcessed: number,
 *   patternsExtracted: number,
 *   patterns: object[],
 *   summary: object
 * }>}
 */
export async function batchLearn(experiences) {
  const allExperiences = experiences ?? await loadExperiences();

  if (allExperiences.length < MIN_GROUP_SIZE) {
    return {
      groupsProcessed: 0,
      patternsExtracted: 0,
      patterns: [],
      summary: { message: 'Insufficient experiences for batch learning' },
    };
  }

  // Group by type + category
  const groups = groupExperiences(allExperiences);
  const extractedPatterns = [];

  for (const [groupKey, groupEntries] of Object.entries(groups)) {
    if (groupEntries.length < MIN_GROUP_SIZE) continue;

    // GRPO: rule-based relative comparison within group
    const ranked = grpoRankGroup(groupEntries);
    const pattern = extractPattern(groupKey, ranked);

    if (pattern) {
      extractedPatterns.push(pattern);
    }
  }

  // Persist patterns
  if (extractedPatterns.length > 0) {
    await updatePatterns(extractedPatterns);
  }

  // Log learning round
  const logEntry = {
    id: `learn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    experienceCount: allExperiences.length,
    groupsProcessed: Object.keys(groups).length,
    patternsExtracted: extractedPatterns.length,
    patternSummary: extractedPatterns.map((p) => ({
      key: p.key,
      confidence: p.confidence,
      insight: p.insight,
    })),
  };

  await appendLearningLog(logEntry);

  return {
    groupsProcessed: Object.keys(groups).length,
    patternsExtracted: extractedPatterns.length,
    patterns: extractedPatterns,
    summary: logEntry,
  };
}

/**
 * Group experiences by "type::category" key.
 * @param {Experience[]} experiences
 * @returns {Object<string, Experience[]>}
 */
function groupExperiences(experiences) {
  const groups = {};
  for (const exp of experiences) {
    const key = `${exp.type}::${exp.category}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(exp);
  }
  return groups;
}

/**
 * GRPO rule-based ranking within a group of same-type experiences.
 * Scores each experience against deterministic rules, computes composite,
 * and ranks by relative advantage over group mean.
 *
 * @param {Experience[]} group
 * @returns {{ entries: object[], groupMean: number, bestEntry: object | null }}
 */
function grpoRankGroup(group) {
  const entries = group.map((exp) => {
    const scores = scoreExperience(exp);
    const composite = Object.entries(EXPERIENCE_WEIGHTS).reduce(
      (sum, [key, weight]) => sum + (scores[key] ?? 0) * weight,
      0,
    );
    return { experience: exp, scores, composite: round(composite) };
  });

  const groupMean = entries.length > 0
    ? entries.reduce((sum, e) => sum + e.composite, 0) / entries.length
    : 0;

  // Add relative advantage
  for (const entry of entries) {
    entry.relativeAdvantage = round(entry.composite - groupMean);
  }

  entries.sort((a, b) => b.composite - a.composite);

  return {
    entries,
    groupMean: round(groupMean),
    bestEntry: entries[0] ?? null,
  };
}

/**
 * Score a single experience using rule-based evaluators.
 * @param {Experience} exp
 * @returns {object} Scores per dimension
 */
function scoreExperience(exp) {
  const data = exp.data ?? {};

  switch (exp.type) {
    case 'tool':
      return {
        success: clamp01(data.successRate ?? 0),
        speed: data.avgMs != null ? clamp01(1.0 / (1 + data.avgMs / 5000)) : 0.5,
        errorRate: clamp01(1.0 - (data.calls > 0 ? (data.calls - (data.successes ?? 0)) / data.calls : 0)),
        resourceEfficiency: clamp01(data.calls > 0 ? Math.min(1, 10 / data.calls) : 0.5),
      };

    case 'error':
      return {
        success: 0,
        speed: 0.5,
        errorRate: 0,
        resourceEfficiency: data.recoverable ? 0.3 : 0,
      };

    case 'success':
      return {
        success: 1.0,
        speed: data.duration != null ? clamp01(1.0 / (1 + data.duration / 60000)) : 0.5,
        errorRate: data.testsPass === true ? 1.0 : data.testsPass === false ? 0.3 : 0.5,
        resourceEfficiency: clamp01(1.0 / (1 + (data.filesModified ?? 0) / 20)),
      };

    case 'team':
      return {
        success: clamp01(data.successRate ?? 0),
        speed: data.duration != null ? clamp01(1.0 / (1 + data.duration / 120000)) : 0.5,
        errorRate: clamp01(data.successRate ?? 0.5),
        resourceEfficiency: clamp01(1.0 / (1 + (data.size ?? 1) / 5)),
      };

    default:
      return { success: 0.5, speed: 0.5, errorRate: 0.5, resourceEfficiency: 0.5 };
  }
}

/**
 * Extract an optimal pattern from ranked group entries.
 * The best-performing entry's characteristics become the pattern.
 *
 * @param {string} groupKey - "type::category"
 * @param {{ entries: object[], groupMean: number, bestEntry: object | null }} ranked
 * @returns {object | null} Extracted pattern or null if insufficient signal
 */
function extractPattern(groupKey, ranked) {
  const { bestEntry, groupMean, entries } = ranked;
  if (!bestEntry || entries.length < MIN_GROUP_SIZE) return null;

  // Only extract pattern if the best clearly outperforms the mean
  if (bestEntry.composite <= groupMean + 0.05) return null;

  const [type, category] = groupKey.split('::');
  const topEntries = entries.filter((e) => e.composite > groupMean);
  const confidence = round(
    Math.min(1.0, (topEntries.length / entries.length) * bestEntry.composite),
  );

  return {
    key: groupKey,
    type,
    category,
    confidence,
    bestComposite: bestEntry.composite,
    groupMean,
    sampleSize: entries.length,
    insight: generateInsight(type, category, bestEntry, groupMean),
    bestData: bestEntry.experience.data,
    extractedAt: new Date().toISOString(),
  };
}

/**
 * Generate a human-readable insight from pattern extraction.
 * @param {string} type
 * @param {string} category
 * @param {object} bestEntry
 * @param {number} groupMean
 * @returns {string}
 */
function generateInsight(type, category, bestEntry, groupMean) {
  const advantage = round((bestEntry.composite - groupMean) * 100);

  switch (type) {
    case 'tool':
      return `Tool "${category}" performs ${advantage}% above average. ` +
        `Best success rate: ${round(bestEntry.scores.success * 100)}%.`;
    case 'error':
      return `Error pattern "${category}" detected. ` +
        `Recoverable: ${bestEntry.experience.data?.recoverable ?? 'unknown'}.`;
    case 'success':
      return `Task type "${category}" best approach scores ${advantage}% above group mean. ` +
        `Strategy: ${bestEntry.experience.data?.strategy ?? 'default'}.`;
    case 'team':
      return `Team pattern "${category}" scores ${advantage}% above average. ` +
        `Optimal size: ${bestEntry.experience.data?.size ?? 'unknown'}.`;
    default:
      return `Pattern "${category}" shows ${advantage}% advantage over group mean.`;
  }
}

// ---------------------------------------------------------------------------
// Pattern Storage
// ---------------------------------------------------------------------------

/**
 * Persist extracted patterns to ~/.claude/artibot/patterns/ directory.
 * Merges with existing patterns, updating those with same key.
 *
 * @param {object[]} patterns - Patterns from batchLearn
 * @returns {Promise<void>}
 */
export async function updatePatterns(patterns) {
  await ensureDir(PATTERNS_DIR);

  // Group patterns by type for separate storage
  const byType = {};
  for (const pattern of patterns) {
    const type = pattern.type ?? 'general';
    if (!byType[type]) byType[type] = [];
    byType[type].push(pattern);
  }

  for (const [type, typePatterns] of Object.entries(byType)) {
    const filePath = path.join(PATTERNS_DIR, `${type}-patterns.json`);
    const existing = (await readJsonFile(filePath)) ?? { patterns: [], updatedAt: null };
    const existingPatterns = Array.isArray(existing.patterns) ? existing.patterns : [];

    // Merge: update existing by key, append new
    const patternMap = new Map(existingPatterns.map((p) => [p.key, p]));
    for (const newPattern of typePatterns) {
      const existingPattern = patternMap.get(newPattern.key);
      if (existingPattern) {
        // Update with new data, keep history of confidence evolution
        patternMap.set(newPattern.key, {
          ...newPattern,
          previousConfidence: existingPattern.confidence,
          consecutiveSuccesses: (existingPattern.consecutiveSuccesses ?? 0) +
            (newPattern.confidence > existingPattern.confidence ? 1 : 0),
          consecutiveFailures: newPattern.confidence < existingPattern.confidence
            ? (existingPattern.consecutiveFailures ?? 0) + 1
            : 0,
          firstSeen: existingPattern.firstSeen ?? existingPattern.extractedAt,
          updateCount: (existingPattern.updateCount ?? 0) + 1,
        });
      } else {
        patternMap.set(newPattern.key, {
          ...newPattern,
          consecutiveSuccesses: 0,
          consecutiveFailures: 0,
          firstSeen: newPattern.extractedAt,
          updateCount: 0,
        });
      }
    }

    await writeJsonFile(filePath, {
      patterns: [...patternMap.values()],
      updatedAt: new Date().toISOString(),
    });
  }
}

// ---------------------------------------------------------------------------
// Learning Summary
// ---------------------------------------------------------------------------

/**
 * Generate a comprehensive learning summary report.
 * Shows what was learned, pattern evolution, and improvement areas.
 *
 * @param {object} [options]
 * @param {number} [options.lookback=50] - Number of recent log entries to analyze
 * @returns {Promise<{
 *   totalSessions: number,
 *   totalExperiences: number,
 *   totalPatternsExtracted: number,
 *   patternsByType: object,
 *   recentLearnings: object[],
 *   trend: string,
 *   recommendations: string[]
 * }>}
 */
export async function getLearningSummary(options = {}) {
  const { lookback = 50 } = options;

  const experiences = await loadExperiences();
  const log = await loadLearningLog();
  const recentLog = log.slice(-lookback);

  // Load all pattern files
  const patternsByType = {};
  for (const type of ['tool', 'error', 'success', 'team', 'general']) {
    const filePath = path.join(PATTERNS_DIR, `${type}-patterns.json`);
    const data = await readJsonFile(filePath);
    if (data?.patterns?.length > 0) {
      patternsByType[type] = {
        count: data.patterns.length,
        avgConfidence: round(
          data.patterns.reduce((sum, p) => sum + (p.confidence ?? 0), 0) / data.patterns.length,
        ),
        topPatterns: data.patterns
          .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
          .slice(0, 3)
          .map((p) => ({ key: p.key, confidence: p.confidence, insight: p.insight })),
      };
    }
  }

  // Compute trend from recent learning sessions
  let trend = 'insufficient_data';
  if (recentLog.length >= 4) {
    const half = Math.floor(recentLog.length / 2);
    const firstHalf = recentLog.slice(0, half);
    const secondHalf = recentLog.slice(half);
    const firstAvg = firstHalf.reduce((s, l) => s + (l.patternsExtracted ?? 0), 0) / firstHalf.length;
    const secondAvg = secondHalf.reduce((s, l) => s + (l.patternsExtracted ?? 0), 0) / secondHalf.length;
    trend = secondAvg > firstAvg + 0.5 ? 'accelerating' :
      secondAvg < firstAvg - 0.5 ? 'decelerating' : 'stable';
  }

  // Generate recommendations
  const recommendations = [];
  const totalPatterns = Object.values(patternsByType)
    .reduce((sum, t) => sum + t.count, 0);

  if (experiences.length < 10) {
    recommendations.push('Collect more experiences to improve learning quality.');
  }
  if (totalPatterns === 0) {
    recommendations.push('No patterns extracted yet. Run batchLearn after collecting sufficient experiences.');
  }
  if (patternsByType.error?.count > (patternsByType.success?.count ?? 0)) {
    recommendations.push('Error patterns outnumber success patterns. Focus on error prevention strategies.');
  }
  if (recommendations.length === 0) {
    recommendations.push('Learning pipeline is healthy. Continue normal operation.');
  }

  return {
    totalSessions: recentLog.length,
    totalExperiences: experiences.length,
    totalPatternsExtracted: totalPatterns,
    patternsByType,
    recentLearnings: recentLog.slice(-5).map((l) => ({
      timestamp: l.timestamp,
      experienceCount: l.experienceCount,
      patternsExtracted: l.patternsExtracted,
    })),
    trend,
    recommendations,
  };
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

/**
 * Schedule learning to run at session end.
 * Returns a shutdown handler that collects final experiences and runs batch learning.
 *
 * @param {object} [sessionContext]
 * @param {string} [sessionContext.sessionId]
 * @returns {{ onSessionEnd: (sessionData: object) => Promise<object> }}
 */
export function scheduleLearning(sessionContext = {}) {
  return {
    /**
     * Call this when the session ends to trigger the learning cycle.
     * @param {object} sessionData - Session data with toolUsage, errors, completedTasks, teamConfig
     * @returns {Promise<object>} Learning result
     */
    onSessionEnd: async (sessionData = {}) => {
      const dataWithSession = {
        ...sessionData,
        sessionId: sessionData.sessionId ?? sessionContext.sessionId ?? `session-${Date.now()}`,
      };

      // Step 1: Collect all experiences from this session
      await collectDailyExperiences(dataWithSession);

      // Step 2: Run batch learning on all accumulated experiences
      const result = await batchLearn();

      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// Persistence Helpers
// ---------------------------------------------------------------------------

/**
 * Load experiences from disk.
 * @returns {Promise<Experience[]>}
 */
async function loadExperiences() {
  const data = await readJsonFile(EXPERIENCES_PATH);
  return Array.isArray(data) ? data : [];
}

/**
 * Load learning log from disk.
 * @returns {Promise<object[]>}
 */
async function loadLearningLog() {
  const data = await readJsonFile(LEARNING_LOG_PATH);
  return Array.isArray(data) ? data : [];
}

/**
 * Append a learning log entry.
 * @param {object} entry
 * @returns {Promise<void>}
 */
async function appendLearningLog(entry) {
  const log = await loadLearningLog();
  const updated = [...log, entry];
  const pruned = updated.length > MAX_LOG_ENTRIES
    ? updated.slice(updated.length - MAX_LOG_ENTRIES)
    : updated;
  await writeJsonFile(LEARNING_LOG_PATH, pruned);
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function clamp01(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function round(n) {
  return Math.round(n * 1000) / 1000;
}
