/**
 * Autopilot module barrel.
 * Re-exports the public surface for engine, safety, generators, store, and notifications.
 *
 * @module lib/autopilot
 */

export {
  startAutopilot,
  resumeAutopilot,
  getStatus,
  abortAutopilot,
  runPhase0Intake,
  runPhase1Plan,
  runPhase2Execute,
  runPhase3CrossCheck,
  runPhase4Verify,
  runPhase5Improve,
  runPhase6Report,
  PHASES,
} from './engine.js';

export {
  classifyRisk,
  shouldPause,
  pauseReason,
  parseDuration,
  DANGEROUS_PATTERNS,
} from './safety.js';

export {
  generatePRD,
  renderPRD,
  slugify,
} from './prd-generator.js';

export {
  generateReport,
  renderReport,
} from './report-generator.js';

export {
  saveSession,
  loadSession,
  listSessions,
  deleteSession,
  newSessionId,
  getSessionPath,
  getStoreDir,
} from './session-store.js';

export {
  notifyCompletion,
  notifyPause,
} from './notification.js';

export {
  appendEvent,
  readEvents,
  tailEventsStream,
  getEventsPath,
} from './telemetry.js';
