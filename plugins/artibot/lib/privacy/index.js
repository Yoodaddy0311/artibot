/**
 * Privacy module re-exports.
 * Integrates PII detection, scrubbing, homoglyph detection,
 * token rotation, and differential privacy.
 * @module lib/privacy
 */

// PII Detector (patterns and matching)
export {
  BUILTIN_PATTERNS,
  TOKENS,
  VALIDATION_CHECKS,
  hintMatches,
} from './pii-detector.js';

// PII Scrubber (masking and scrubbing)
export {
  addCustomPattern,
  buildHomePathPatterns,
  createScopedScrubber,
  getScrubStats,
  listPatterns,
  removeCustomPattern,
  resetPatterns,
  resetStats,
  scrub,
  scrubPattern,
  scrubPatterns,
  validateScrubbed,
} from './pii-scrubber.js';

// Homoglyph Detector
export {
  checkMixedScript,
  detectHomoglyphs,
  getHomoglyphMap,
  normalizeHomoglyphs,
} from './homoglyph-detector.js';

// Token Rotation
export {
  cleanup as cleanupTokens,
  configure as configureTokens,
  generateToken,
  getTokenInfo,
  getTokenStats,
  isTokenValid,
  listTokens,
  resetTokenStore,
  restoreFromPersistence,
  revokeToken,
  rotateToken,
} from './token-rotation.js';

// Differential Privacy
export {
  createNoiseFunction,
  validateDPConfig,
} from './differential-privacy.js';

// Data Egress Guard (DATA POLICY runtime enforcement)
export {
  EgressBlockedError,
  assertEgressAllowed,
  isLocalhost,
  loadAllowlist,
  safeFetch,
} from '../core/data-egress-guard.js';
