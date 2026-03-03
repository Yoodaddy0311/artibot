/**
 * System module re-exports.
 * @module lib/system
 */

export {
  addDiagnosticContext,
  collectDiagnostics,
  collectEslintDiagnostics,
  collectTscDiagnostics,
  getLastDiagnostics,
  parseDiagnostic,
  parseEslintOutput,
  parseTscOutput,
  resetDiagnostics,
} from './lsp-client.js';
