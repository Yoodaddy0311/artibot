/**
 * Swarm Intelligence Module - Public API.
 *
 * Re-exports the three core swarm components:
 * - SwarmClient: HTTP client for server communication
 * - PatternPackager: Local pattern <-> shareable weight conversion
 * - SyncScheduler: Synchronization timing and lifecycle hooks
 *
 * @module lib/swarm
 */

export {
  uploadWeights,
  downloadLatestWeights,
  reportTelemetry,
  checkHealth,
  getContributionStats,
  flushOfflineQueue,
  computeChecksum,
  verifyChecksum,
} from './swarm-client.js';

export {
  packagePatterns,
  unpackWeights,
  mergeWeights,
} from './pattern-packager.js';

export {
  scheduleSync,
  cancelSync,
  forceSync,
  onSessionStart,
  onSessionEnd,
  getSyncStatus,
} from './sync-scheduler.js';
