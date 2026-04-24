/**
 * MCP tool: get Artibot hierarchical memory stats.
 *
 * Reports per-layer (working/episodic/semantic) hit-rate metrics from the
 * v3.3 hierarchical memory system. If the metrics file does not exist yet
 * (cold start), reports zeros rather than failing. Read-only.
 *
 * @module lib/mcp/tools/get-memory-stats
 */

import path from 'node:path';
import { exists, readJsonFile } from '../../core/file.js';
import { getPluginRoot } from '../../core/platform.js';

const INPUT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    metricsPath: { type: 'string' },
  },
});

function emptyLayer() {
  return { hits: 0, queries: 0, rate: 0 };
}

async function handler(args = {}) {
  const metricsPath = typeof args.metricsPath === 'string' && args.metricsPath.length > 0
    ? args.metricsPath
    : path.join(getPluginRoot(), 'runtime', 'memory-metrics.json');
  const present = await exists(metricsPath);
  let stats;
  if (present) {
    stats = await readJsonFile(metricsPath);
  }
  if (!stats || typeof stats !== 'object') {
    stats = {
      date: new Date().toISOString().slice(0, 10),
      working: emptyLayer(),
      episodic: emptyLayer(),
      semantic: emptyLayer(),
    };
  }
  const layers = ['working', 'episodic', 'semantic'];
  const aggregate = { hits: 0, queries: 0 };
  for (const layer of layers) {
    const bucket = stats[layer] || emptyLayer();
    aggregate.hits += bucket.hits || 0;
    aggregate.queries += bucket.queries || 0;
  }
  const aggregateRate = aggregate.queries === 0 ? 0 : aggregate.hits / aggregate.queries;
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            metricsPath,
            present,
            date: stats.date,
            layers: {
              working: stats.working || emptyLayer(),
              episodic: stats.episodic || emptyLayer(),
              semantic: stats.semantic || emptyLayer(),
            },
            aggregate: { ...aggregate, rate: aggregateRate },
          },
          null,
          2,
        ),
      },
    ],
  };
}

export const getMemoryStatsTool = Object.freeze({
  name: 'artibot.get_memory_stats',
  description: 'Report Artibot hierarchical memory hit-rate stats (working/episodic/semantic).',
  inputSchema: INPUT_SCHEMA,
  handler,
});
