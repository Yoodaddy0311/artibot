/**
 * Supervisor barrel — observe-mode spine (PR-SV01 + PR-SV02).
 *
 * Automation level S0 (design §03): everything here reads, reduces and
 * reports. The only writes are the supervisor's own files
 * (`{runId}.supervisor.ndjson`, `{runId}.state.json`); nothing touches
 * worktrees, sessions, or the record-only split telemetry stream.
 *
 * @module lib/supervisor
 */

export {
  isKnownEvent,
  isSupervisorEvent,
  isTelemetryEvent,
  SOURCES,
  SUPERVISOR_EVENT_TYPES,
  TELEMETRY_EVENT_TYPES,
} from './event-types.js';

export {
  isLaneOpsState,
  isLaneState,
  isLaneTerminal,
  isRunState,
  isRunTerminal,
  LANE_OPS_STATES,
  LANE_OPS_TO_LANE_STATE,
  LANE_STATES,
  LANE_TERMINAL_STATES,
  REVIEW_VERDICTS,
  RUN_LINEAR_STATES,
  RUN_STATES,
  RUN_TERMINAL_STATES,
  validateEvent,
  validateLaneState,
  validateRunState,
} from './contracts.js';

export { reduce } from './state-reducer.js';

export {
  appendEvent,
  getStatePath,
  getSupervisorEventsPath,
  normalizeEnvelope,
  parseNdjson,
  readAllEvents,
  readState,
  readSupervisorEvents,
  rebuildState,
  STATE_SUFFIX,
  SUPERVISOR_EVENTS_SUFFIX,
} from './run-store.js';

export {
  assessLane,
  DEFAULT_THRESHOLDS,
  HEALTH_STATES,
  opsStateToLaneState,
  readLaneOpsState,
} from './lane-monitor.js';
