/**
 * Central metrics collector.
 * Aggregates operational metrics from distributed getStats() sources
 * into a unified snapshot for observability and dashboards.
 *
 * Design: Lazy registration — source modules register themselves
 * when imported. collect() always returns a new frozen object.
 *
 * @module lib/core/metrics-collector
 */

/**
 * Create a metrics collector instance.
 *
 * @returns {{
 *   registerSource: (name: string, collectFn: () => object | Promise<object>) => void,
 *   collect: () => Promise<object>,
 *   getSummary: () => Promise<object>,
 *   reset: () => void,
 *   listSources: () => string[],
 * }}
 * @example
 * const collector = createMetricsCollector();
 * collector.registerSource('eventBus', () => getEventBusStats());
 * const snapshot = await collector.collect();
 */

/**
 * Extract KPI summary from a collected snapshot's sources.
 * @param {object} s - snapshot.sources object
 * @returns {object} KPI entries to merge into summary
 */
// eslint-disable-next-line complexity -- linear dispatch over many KPI types
function extractKpis(s) {
  const kpis = {};

  if (s.eventBus && !s.eventBus.error) {
    kpis.eventBus = Object.freeze({
      eventTypes: s.eventBus.eventTypes ?? 0,
      totalListeners: s.eventBus.totalListeners ?? 0,
      cachedEvents: s.eventBus.cachedEvents ?? 0,
    });
  }

  if (s.cognitiveRouter && !s.cognitiveRouter.error) {
    kpis.cognitiveRouter = Object.freeze({
      totalRouted: s.cognitiveRouter.totalRouted ?? 0,
      system1Ratio: s.cognitiveRouter.system1Ratio ?? 0,
      successRate: s.cognitiveRouter.successRate ?? { system1: 0, system2: 0 },
      recentTrend: s.cognitiveRouter.recentTrend ?? 'stable',
    });
  }

  if (s.grpo && !s.grpo.error) {
    kpis.grpo = Object.freeze({
      totalRounds: s.grpo.totalRounds ?? 0,
      weights: s.grpo.weights ?? {},
      teamWeights: s.grpo.teamWeights ?? {},
    });
  }

  if (s.evalCalibrator && !s.evalCalibrator.error) {
    kpis.evalCalibrator = Object.freeze({
      avgDelta: s.evalCalibrator.avgDelta ?? 0,
      avgAbsDelta: s.evalCalibrator.avgAbsDelta ?? 0,
      totalOverrides: s.evalCalibrator.totalOverrides ?? 0,
    });
  }

  if (s.guards && !s.guards.error) kpis.guards = Object.freeze({ ...s.guards });
  if (s.hooks && !s.hooks.error) kpis.hooks = Object.freeze({ ...s.hooks });
  if (s.toolCalls && !s.toolCalls.error) kpis.toolCalls = Object.freeze({ ...s.toolCalls });

  return kpis;
}
export function createMetricsCollector() {
  /** @type {Map<string, () => object | Promise<object>>} */
  let sources = new Map();

  /**
   * Register a named metrics source.
   *
   * @param {string} name - Unique source identifier
   * @param {() => object | Promise<object>} collectFn - Returns metrics snapshot
   * @throws {Error} If name is empty or collectFn is not a function
   */
  function registerSource(name, collectFn) {
    if (typeof name !== 'string' || !name) {
      throw new TypeError('name must be a non-empty string');
    }
    if (typeof collectFn !== 'function') {
      throw new TypeError('collectFn must be a function');
    }
    sources = new Map(sources);
    sources.set(name, collectFn);
  }

  /**
   * Collect metrics from all registered sources.
   * Each source is called independently; failures are captured
   * as error entries rather than breaking the entire collection.
   *
   * @returns {Promise<Readonly<{ timestamp: string, sources: object }>>}
   */
  async function collect() {
    const timestamp = new Date().toISOString();
    const entries = {};

    const names = [...sources.keys()];
    const results = await Promise.allSettled(
      names.map((name) => {
        const fn = sources.get(name);
        return Promise.resolve(fn());
      }),
    );

    for (let i = 0; i < names.length; i++) {
      const result = results[i];
      if (result.status === 'fulfilled') {
        entries[names[i]] = Object.freeze({ ...result.value });
      } else {
        entries[names[i]] = Object.freeze({
          error: result.reason?.message ?? String(result.reason),
        });
      }
    }

    return Object.freeze({ timestamp, sources: Object.freeze(entries) });
  }

  /**
   * Produce a KPI summary for operational dashboards.
   * Extracts key indicators from known source shapes.
   *
   * @returns {Promise<Readonly<object>>}
   */
  async function getSummary() {
    const snapshot = await collect();
    const s = snapshot.sources;

    const summary = {
      timestamp: snapshot.timestamp,
      sourceCount: Object.keys(s).length,
      ...extractKpis(s),
    };

    return Object.freeze(summary);
  }

  /**
   * List registered source names.
   * @returns {string[]}
   */
  function listSources() {
    return [...sources.keys()];
  }

  /**
   * Reset the collector, removing all registered sources.
   */
  function reset() {
    sources = new Map();
  }

  return { registerSource, collect, getSummary, reset, listSources };
}

/**
 * Default shared metrics collector instance.
 * Source modules should import this and call registerSource() at load time.
 */
export const defaultCollector = createMetricsCollector();
