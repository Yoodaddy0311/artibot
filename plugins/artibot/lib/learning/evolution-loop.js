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
import { createAutoResearch } from '../cognitive/auto-research.js';
import { buildContribution } from '../swarm/collective-hub.js';
import { loadFromDisk, saveToDisk } from '../swarm/swarm-persistence.js';

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
 * Resolve the categorize function — either the injected override, or a lazy
 * dynamic import of `categorizeAll` from `./failure-categorizer.js`.
 * Returns null + records the error on load failure so Stage 6 can short-circuit.
 *
 * @param {Function|null} customCategorizer
 * @param {string|null} patternsDictPath
 * @param {{stage: string, message: string}[]} errors
 * @returns {Promise<Function|null>}
 */
async function resolveCategorize(customCategorizer, patternsDictPath, errors) {
  if (customCategorizer) return customCategorizer;
  try {
    const mod = await import('./failure-categorizer.js');
    const baseOpts = patternsDictPath ? { cwd: patternsDictPath } : undefined;
    return (failureContext) => mod.categorizeAll(failureContext, baseOpts);
  } catch (err) {
    errors.push({ stage: 'categorize', message: err.message });
    return null;
  }
}

/**
 * Run Stage 6 — categorize each failure context, write top-1 per failure into
 * `result.categorizedFailures` and a `{ categoryId: count }` distribution.
 * Per-failure throws are caught and recorded; other failures keep processing.
 *
 * @param {object} result - Mutable result object being assembled by run().
 * @param {Array} failures - context.failures (already array-checked, non-empty).
 * @param {Function} categorize - Resolved categorizer function.
 */
async function runCategorizeStage(result, failures, categorize) {
  const categorized = [];
  const distribution = {};
  for (const failure of failures) {
    try {
      const ranked = await categorize(failure);
      if (Array.isArray(ranked) && ranked.length > 0) {
        const top = ranked[0];
        categorized.push(Object.freeze({
          categoryId: top.categoryId,
          confidence: top.confidence,
          severity: top.severity,
        }));
        distribution[top.categoryId] = (distribution[top.categoryId] || 0) + 1;
      }
    } catch (err) {
      result.errors.push({ stage: 'categorize', message: err.message });
    }
  }
  result.categorizedFailures = Object.freeze(categorized);
  result.categoryDistribution = Object.freeze(distribution);
}

/**
 * Create a self-evolution loop instance.
 * @param {object} [options]
 * @param {object} [options.sessionMemory] - Prebuilt session memory instance
 * @param {object} [options.knowledgeGraph] - Prebuilt knowledge graph instance
 * @param {object} [options.skillEvolver] - Prebuilt skill evolver instance
 * @param {object} [options.autoResearch] - Prebuilt auto research instance
 * @param {() => number} [options.now] - Clock injection
 * @param {(failureContext: object, opts?: object) => Promise<Array>} [options.categorizer]
 *   Async function returning ranked category results for a failure context.
 *   Defaults to a lazy dynamic import of `categorizeAll` from
 *   `./failure-categorizer.js`. Inject in tests to avoid filesystem I/O.
 * @param {string} [options.patternsDictPath] - cwd override forwarded to the
 *   default categorizer as `{ cwd }`. Ignored when a custom categorizer is supplied.
 * @returns {object} Evolution loop API
 */
export function createEvolutionLoop(options = {}) {
  const now = options.now || Date.now;
  const sessionMemory = options.sessionMemory || createSessionMemory({ now });
  const knowledgeGraph = options.knowledgeGraph || createKnowledgeGraph();
  const skillEvolver = options.skillEvolver || createSkillEvolver({ now });
  const autoResearch = options.autoResearch || createAutoResearch();
  const hubConfig = options.hubConfig || { optIn: false, minSuccessRate: 0.6, minUsageCount: 5 };
  const customCategorizer = typeof options.categorizer === 'function' ? options.categorizer : null;
  const patternsDictPath = typeof options.patternsDictPath === 'string' ? options.patternsDictPath : null;

  return Object.freeze({
    /**
     * Run the full evolution pipeline after session end.
     * Each stage is independent — if one fails, others still run.
     *
     * @param {object} [context]
     * @param {Array} [context.events] - Session events to capture
     * @param {Array} [context.skillUsages] - Skill usage records [{name, invoked, success, userEdited, editDistance}]
     * @param {object} [context.routingResult] - Last routing result for auto-research trigger
     * @param {Array<{stderr?: string, stdout?: string, diff?: string, files?: string[]}>} [context.failures]
     *   Failure contexts from the session. Stage 6 categorizes each via the
     *   injected `categorizer` and aggregates a per-category distribution.
     *   When absent or empty, Stage 6 is skipped and the result stays identical
     *   to pre-Stage-6 callers.
     * @returns {Promise<object>} Pipeline result with per-stage outcomes
     */

    async run(context = {}) {
      const result = {
        compressed: null,
        graphNodes: 0,
        graphEdges: 0,
        skillEvaluations: [],
        researchTriggered: false,
        researchFindings: null,
        contribution: null,
        categorizedFailures: [],
        categoryDistribution: {},
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

      // Stage 4: Auto-research if confidence was low
      try {
        if (autoResearch.shouldResearch(context.routingResult)) {
          result.researchTriggered = true;
          const query = context.routingResult?.input || result.compressed?.summary || '';
          const scopeResult = autoResearch.scope(query);
          const gathered = await autoResearch.gather(scopeResult);
          result.researchFindings = autoResearch.synthesize(gathered);
        }
      } catch (err) {
        result.errors.push({ stage: 'research', message: err.message });
      }

      // Stage 5: Contribute qualified patterns to collective hub
      try {
        if (hubConfig.optIn && result.skillEvaluations.length > 0) {
          const localPatterns = result.skillEvaluations
            .filter((ev) => ev.metrics.usageCount >= (hubConfig.minUsageCount || 5))
            .map((ev) => ({
              type: 'skill',
              name: ev.name,
              signature: ev.name,
              successRate: ev.metrics.successRate,
              usageCount: ev.metrics.usageCount,
              metadata: { classification: ev.classification, trend: ev.metrics.trend },
            }));

          const batch = buildContribution(localPatterns, hubConfig);
          if (batch) {
            // Load existing patterns, append new, save
            const existing = await loadFromDisk().catch(() => ({ patterns: [] }));
            const allPatterns = [...(existing.patterns || []), ...batch.patterns];
            await saveToDisk({ patterns: allPatterns });
            result.contribution = Object.freeze({
              patternsShared: batch.patterns.length,
              batchId: batch.batchId,
            });
          }
        }
      } catch (err) {
        result.errors.push({ stage: 'contribute', message: err.message });
      }

      // Stage 6: Categorize session failures (per-category fix-pattern learning)
      const failures = Array.isArray(context.failures) ? context.failures : [];
      if (failures.length > 0) {
        const categorize = await resolveCategorize(customCategorizer, patternsDictPath, result.errors);
        if (categorize) {
          await runCategorizeStage(result, failures, categorize);
        }
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
