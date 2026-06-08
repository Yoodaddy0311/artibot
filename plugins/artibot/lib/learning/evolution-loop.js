/**
 * Self-Evolution Learning Loop.
 * Orchestrates session-memory -> knowledge-graph -> skill-evolver -> auto-research
 * into an automated pipeline that runs at session end.
 *
 * @module lib/learning/evolution-loop
 */

import { createSessionMemory } from './session-memory.js';
import { createKnowledgeGraph, EDGE_RELATIONS, NODE_TYPES } from './knowledge-graph.js';
import { createSkillEvolver } from './skill-evolver.js';
import { buildContribution } from '../swarm/collective-hub.js';
import { loadFromDisk, saveToDisk } from '../swarm/swarm-persistence.js';
import { scrub as scrubPii } from '../privacy/pii-scrubber.js';

// Layer constraint: Layer-3 (learning) must not import Layer-4 (cognitive).
// `autoResearch` is dependency-injected by the caller (e.g. session-end hook).
// When not provided, Stage 4 (research) is skipped — pipeline stays best-effort.

/**
 * Extract knowledge graph nodes from a compressed memory record.
 * @param {object} memory - from sessionMemory.compress()
 * @returns {Array<{id: string, type: string, data: object}>}
 */
function extractNodes(memory) {
  if (!memory?.keywords) return [];
  return memory.keywords.map((keyword) => ({
    id: `kw-${keyword}`,
    type: NODE_TYPES.CONCEPT,
    data: { label: keyword, source: memory.sessionId, eventCount: memory.eventCount },
  }));
}

/**
 * Run the auto-research stage. Returns `{ triggered, findings }` or `null`
 * when the optional `autoResearch` dependency was not injected. Extracting
 * this keeps `run()`'s cyclomatic complexity below the project budget.
 *
 * @param {object|null} autoResearch
 * @param {object} routingResult
 * @param {object|null} compressed
 * @returns {Promise<{ triggered: boolean, findings: object|null }|null>}
 */
async function runResearchStage(autoResearch, routingResult, compressed) {
  if (!autoResearch) return null;
  if (!autoResearch.shouldResearch(routingResult)) return { triggered: false, findings: null };
  // Scrub PII (paths, emails, tokens, homes) before any query leaves Layer-3.
  // router.input is verbatim user prompt — never feed it to searchFn/grepFn raw.
  const rawQuery = routingResult?.input || compressed?.summary || '';
  const query = rawQuery ? scrubPii(rawQuery) : '';
  const scopeResult = autoResearch.scope(query);
  const gathered = await autoResearch.gather(scopeResult);
  return { triggered: true, findings: autoResearch.synthesize(gathered) };
}

/**
 * Pick the highest-confidence category from a categorizer's result list.
 * Returns a frozen entry exposing only the public-contract fields
 * (`categoryId`, `confidence`, `severity`) — `matchedSignals` and `weight`
 * are categorizer-internal and must not leak into the pipeline result.
 *
 * @param {Array<object>} categories
 * @returns {Readonly<{categoryId: string, confidence: number, severity: string}>|null}
 */
function pickTopCategory(categories) {
  if (!Array.isArray(categories) || categories.length === 0) return null;
  let top = categories[0];
  for (let i = 1; i < categories.length; i++) {
    if ((categories[i].confidence ?? 0) > (top.confidence ?? 0)) top = categories[i];
  }
  return Object.freeze({
    categoryId: top.categoryId,
    confidence: top.confidence,
    severity: top.severity,
  });
}

/**
 * Run Stage 5 contribution. Returns `null` when nothing was shared (skipped
 * stage, no qualifying patterns, or empty batch). Extracted from `run()` to
 * keep that function's cyclomatic complexity below the project budget.
 *
 * @param {Array<object>} skillEvaluations
 * @param {object} hubConfig
 * @returns {Promise<{patternsShared: number, batchId: string}|null>}
 */
async function runContributionStage(skillEvaluations, hubConfig) {
  if (!hubConfig.optIn || skillEvaluations.length === 0) return null;
  const minUsage = hubConfig.minUsageCount || 5;
  const localPatterns = skillEvaluations
    .filter((ev) => ev.metrics.usageCount >= minUsage)
    .map((ev) => ({
      type: 'skill',
      name: ev.name,
      signature: ev.name,
      successRate: ev.metrics.successRate,
      usageCount: ev.metrics.usageCount,
      metadata: { classification: ev.classification, trend: ev.metrics.trend },
    }));
  const batch = buildContribution(localPatterns, hubConfig);
  if (!batch) return null;
  const existing = await loadFromDisk().catch(() => ({ patterns: [] }));
  const allPatterns = [...(existing.patterns || []), ...batch.patterns];
  await saveToDisk({ patterns: allPatterns });
  return { patternsShared: batch.patterns.length, batchId: batch.batchId };
}

/**
 * Run Stage 6 categorization. Per-failure isolation: a single throw is
 * captured into `errors` and the loop continues. Extracted from `run()` to
 * keep that function's cyclomatic complexity below the project budget.
 *
 * @param {(failure: object) => Promise<Array<object>>} categorizer
 * @param {Array<object>} failures
 * @returns {Promise<{entries: Array<object>, distribution: object, errors: Array<{stage: string, message: string}>}>}
 */
async function runCategorizationStage(categorizer, failures) {
  const entries = [];
  const distribution = {};
  const errors = [];
  for (const failure of failures) {
    try {
      const top = pickTopCategory(await categorizer(failure));
      if (!top) continue;
      entries.push(top);
      distribution[top.categoryId] = (distribution[top.categoryId] || 0) + 1;
    } catch (err) {
      errors.push({ stage: 'categorize', message: err.message });
    }
  }
  return { entries, distribution, errors };
}

/**
 * Build edges between co-occurring keywords in a memory.
 * @param {Array<{id: string}>} nodes
 * @returns {Array<{from: string, to: string, relation: string}>}
 */
function buildEdges(nodes) {
  const edges = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      edges.push({
        from: nodes[i].id,
        to: nodes[j].id,
        relation: EDGE_RELATIONS.RELATES_TO,
      });
    }
  }
  return edges;
}

/**
 * Create a self-evolution loop instance.
 * @param {object} [options]
 * @param {object} [options.sessionMemory] - Prebuilt session memory instance
 * @param {object} [options.knowledgeGraph] - Prebuilt knowledge graph instance
 * @param {object} [options.skillEvolver] - Prebuilt skill evolver instance
 * @param {object} [options.autoResearch] - Prebuilt auto research instance
 * @param {(failure: object) => Promise<Array<{categoryId: string, confidence: number, severity: string}>>} [options.categorizer] - Stage 6 failure categorizer (DI). When omitted, Stage 6 is skipped.
 * @param {() => number} [options.now] - Clock injection
 * @returns {object} Evolution loop API
 */
export function createEvolutionLoop(options = {}) {
  const now = options.now || Date.now;
  const sessionMemory = options.sessionMemory || createSessionMemory({ now });
  const knowledgeGraph = options.knowledgeGraph || createKnowledgeGraph();
  const skillEvolver = options.skillEvolver || createSkillEvolver({ now });
  const autoResearch = options.autoResearch || null;
  const categorizer = typeof options.categorizer === 'function' ? options.categorizer : null;
  const hubConfig = options.hubConfig || { optIn: false, minSuccessRate: 0.6, minUsageCount: 5 };
  const graphPruneMaxAgeDays = typeof options.graphPruneMaxAgeDays === 'number'
    ? options.graphPruneMaxAgeDays
    : 90;

  return Object.freeze({
    /**
     * Run the full evolution pipeline after session end.
     * Each stage is independent — if one fails, others still run.
     *
     * @param {object} [context]
     * @param {Array} [context.events] - Session events to capture
     * @param {Array} [context.skillUsages] - Skill usage records [{name, invoked, success, userEdited, editDistance}]
     * @param {object} [context.routingResult] - Last routing result for auto-research trigger
     * @returns {Promise<object>} Pipeline result with per-stage outcomes
     */
     
    async run(context = {}) {
      const result = {
        compressed: null,
        graphNodes: 0,
        graphEdges: 0,
        graphPruned: 0,
        skillEvaluations: [],
        researchTriggered: false,
        researchFindings: null,
        contribution: null,
        categorizedFailures: Object.freeze([]),
        categoryDistribution: Object.freeze({}),
        errors: [],
        durationMs: 0,
      };

      const start = now();

      // Stage 1: Compress session events into memory
      try {
        if (context.events?.length > 0) {
          for (const event of context.events) {
            sessionMemory.capture(event);
          }
        }
        result.compressed = await sessionMemory.compress();
      } catch (err) {
        result.errors.push({ stage: 'compress', message: err.message });
      }

      // Stage 2: Ingest into knowledge graph
      try {
        if (result.compressed) {
          const nodes = extractNodes(result.compressed);
          const edges = buildEdges(nodes);

          for (const node of nodes) {
            knowledgeGraph.addNode(node.id, node.type, node.data);
          }
          for (const edge of edges) {
            knowledgeGraph.addEdge(edge.from, edge.to, edge.relation);
          }

          result.graphNodes = nodes.length;
          result.graphEdges = edges.length;

          // Bound graph growth before persistence. Pruning here (after ingest,
          // before save) keeps the saved snapshot trimmed and matches the
          // audit fix in `.artibot/REPORTS/audit-learning-cognitive-2026-06-08.md`.
          if (typeof knowledgeGraph.prune === 'function') {
            try {
              result.graphPruned = knowledgeGraph.prune(graphPruneMaxAgeDays);
            } catch (pruneErr) {
              result.errors.push({ stage: 'prune', message: pruneErr.message });
            }
          }

          // Persist graph
          if (typeof knowledgeGraph.save === 'function') {
            await knowledgeGraph.save();
          }
        }
      } catch (err) {
        result.errors.push({ stage: 'ingest', message: err.message });
      }

      // Stage 3: Evaluate skill usage patterns
      try {
        if (context.skillUsages?.length > 0) {
          for (const usage of context.skillUsages) {
            skillEvolver.track(usage.name, {
              invoked: usage.invoked ?? true,
              success: usage.success ?? true,
              userEdited: usage.userEdited ?? false,
              editDistance: usage.editDistance ?? 0,
            });

            const metrics = skillEvolver.evaluate(usage.name);
            const classification = skillEvolver.classify(metrics);
            const suggestion = skillEvolver.suggest(usage.name);

            result.skillEvaluations.push(Object.freeze({
              name: usage.name,
              metrics,
              classification,
              suggestion,
            }));
          }
        }
      } catch (err) {
        result.errors.push({ stage: 'evaluate', message: err.message });
      }

      // Stage 4: Auto-research if confidence was low. Skipped when caller did
      // not inject `autoResearch` (preserves Layer-3 isolation from Layer-4).
      try {
        const research = await runResearchStage(autoResearch, context.routingResult, result.compressed);
        if (research) {
          result.researchTriggered = research.triggered;
          result.researchFindings = research.findings;
        }
      } catch (err) {
        result.errors.push({ stage: 'research', message: err.message });
      }

      // Stage 5: Contribute qualified patterns to collective hub. Logic
      // lives in `runContributionStage()` — keeps run() under the project's
      // cyclomatic-complexity budget. BUG-1 fix preserved: saveToDisk() now
      // accepts a `{patterns}` payload that gets merged before flush.
      try {
        const shared = await runContributionStage(result.skillEvaluations, hubConfig);
        if (shared) result.contribution = Object.freeze(shared);
      } catch (err) {
        result.errors.push({ stage: 'contribute', message: err.message });
      }

      // Stage 6: Categorize failures via injected categorizer (DI). Skipped
      // entirely when no failures supplied or no categorizer injected.
      // Logic lives in `runCategorizationStage()` — keeps run() under the
      // project's cyclomatic-complexity budget.
      if (context.failures?.length > 0 && categorizer) {
        const stage6 = await runCategorizationStage(categorizer, context.failures);
        result.categorizedFailures = Object.freeze(stage6.entries);
        result.categoryDistribution = Object.freeze(stage6.distribution);
        if (stage6.errors.length > 0) result.errors.push(...stage6.errors);
      }

      result.durationMs = now() - start;
      return Object.freeze(result);
    },

    /** Expose sub-components for external wiring */
    get sessionMemory() { return sessionMemory; },
    get knowledgeGraph() { return knowledgeGraph; },
    get skillEvolver() { return skillEvolver; },
    get autoResearch() { return autoResearch; },
  });
}
