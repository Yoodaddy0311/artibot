/**
 * Self-Evolution Learning Loop.
 * Orchestrates session-memory -> knowledge-graph -> skill-evolver -> auto-research
 * into an automated pipeline that runs at session end.
 *
 * @module lib/learning/evolution-loop
 */

import { createSessionMemory } from './session-memory.js';
import { createKnowledgeGraph, NODE_TYPES, EDGE_RELATIONS } from './knowledge-graph.js';
import { createSkillEvolver } from './skill-evolver.js';
import { createAutoResearch } from '../cognitive/auto-research.js';
import { buildContribution } from '../swarm/collective-hub.js';
import { saveToDisk, loadFromDisk } from '../swarm/swarm-persistence.js';

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
 * Create a self-evolution loop instance.
 * @param {object} [options]
 * @param {object} [options.sessionMemory] - Prebuilt session memory instance
 * @param {object} [options.knowledgeGraph] - Prebuilt knowledge graph instance
 * @param {object} [options.skillEvolver] - Prebuilt skill evolver instance
 * @param {object} [options.autoResearch] - Prebuilt auto research instance
 * @param {() => number} [options.now] - Clock injection
 * @returns {object} Evolution loop API
 */
export function createEvolutionLoop(options = {}) {
  const now = options.now || Date.now;
  const sessionMemory = options.sessionMemory || createSessionMemory({ now });
  const knowledgeGraph = options.knowledgeGraph || createKnowledgeGraph();
  const skillEvolver = options.skillEvolver || createSkillEvolver({ now });
  const autoResearch = options.autoResearch || createAutoResearch();
  const hubConfig = options.hubConfig || { optIn: false, minSuccessRate: 0.6, minUsageCount: 5 };

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
        skillEvaluations: [],
        researchTriggered: false,
        researchFindings: null,
        contribution: null,
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
