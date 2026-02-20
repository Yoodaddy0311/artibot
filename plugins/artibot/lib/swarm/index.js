/**
 * Swarm Intelligence Module - Public API.
 *
 * Re-exports the four core swarm components:
 * - SwarmClient: HTTP client for server communication
 * - PatternPackager: Local pattern <-> shareable weight conversion
 * - SyncScheduler: Synchronization timing and lifecycle hooks
 * - SwarmPersistence: File-based persistence layer for swarm data
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

export {
  loadFromDisk,
  saveToDisk,
  clearPersistence,
  getPattern,
  setPattern,
  removePattern,
  getAllPatterns,
  setWeights,
  getWeights,
  updateMetadata,
  getMetadata,
  isDirty,
  isLoaded,
  getDbPath,
  setDebounceDelay,
  scheduleSave,
  _resetForTesting,
} from './swarm-persistence.js';
