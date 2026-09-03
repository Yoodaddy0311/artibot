/**
 * Mission compiler barrel.
 *
 * Every module here is pure (design §1-8, L2): no clock, no filesystem, no
 * randomness. Effects arrive as injected ports. Nothing in this directory
 * writes a file — `intent.md` creation is a Shadow-stage concern and Phase 0
 * excludes it.
 *
 * @module lib/mission
 */

export {
  MISSION_CONTRACT_FIELDS,
  REQUIRED_FIELDS_FULL,
  REQUIRED_FIELDS_REDUCED,
  REDUCED_ALLOWED_FIELDS,
  MISSION_STATUS,
  AUTONOMY_MODES,
  PERFORMANCE_PRIORITIES,
  PLANNING_MODES,
  TOPOLOGY_MODES,
  FINDING_CLASSES,
  SUCCESS_SECTIONS,
  COMMAND_ACTIVATION_FLAGS,
  MISSION_ID_PATTERN,
  validateMissionContract,
  checkIntentFidelity,
  verifyExplicitRequestSpans,
  tokenizeForFidelity,
} from './contract.js';

export {
  BOUNDARY_CLASSES,
  CANDIDATE_RELATIONS,
  FINDING_DISPOSITIONS,
  classifyBoundary,
  buildScope,
  classifyFinding,
} from './problem-boundary.js';

export {
  BOUNDED_CONDITIONS,
  classifyBlindspot,
  scanBlindspots,
} from './blindspot-scanner.js';

export {
  SUBSTANTIVE_SIGNALS,
  PROMPT_STAGE_SIGNALS,
  EXECUTION_STAGE_SIGNALS,
  COMPLETION_ACTIONS,
  S1_WRITE_ACTIONS,
  S2_SHIP_ACTIONS,
  S5_COMMANDS,
  detectSlashCommand,
  judgeSubstantive,
  formatMissionDate,
  issueMissionId,
  sessionFallbackMissionId,
  isMissionId,
  inheritMissionId,
} from './mission-id.js';

export {
  extractExplicitRequests,
  deriveRequestedTargets,
  projectCommandActivation,
  compileMission,
} from './compiler.js';
