/**
 * System 2: Deliberate reasoning engine.
 * Implements the Plan -> Execute -> Reflect loop for complex problem solving.
 * Supports self-correction with up to 3 retry attempts per task.
 *
 * Based on dual-process theory:
 *   - System 1 (fast/intuitive) handles simple tasks
 *   - System 2 (slow/deliberate) handles complex reasoning
 *
 * Integration points:
 *   - Sandbox: Safe command execution with blocked-pattern validation
 *   - Agent Teams: TeamCreate recommendation for multi-agent tasks
 *   - Self-Evaluator: Result quality assessment
 *
 * This module is a barrel re-export from:
 *   - system2-core.js: Plan-Execute-Reflect loop and public API
 *   - system2-strategies.js: Strategy patterns, risk assessment, team recommendations
 *
 * @module lib/cognitive/system2
 */

// Core: Plan -> Execute -> Reflect loop
export {
  plan,
  execute,
  reflect,
  solve,
  assessComplexity,
} from './system2-core.js';

// Strategies: risk, complexity, team, correction heuristics
export {
  TEAM_THRESHOLDS,
  estimateStepComplexity,
  analyzeDependencies,
  assessRisks,
  estimateComplexity,
  recommendTeam,
  selectTeammates,
  suggestCorrection,
} from './system2-strategies.js';
