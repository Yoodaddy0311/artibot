/**
 * Tests for barrel file re-exports.
 * Verifies that index.js files correctly re-export their module contents.
 *
 * @module tests/barrel-exports
 */

import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// lib/privacy/index.js
// ---------------------------------------------------------------------------
describe('lib/privacy/index.js barrel exports', () => {
  it('re-exports pii-detector constants and functions', async () => {
    const mod = await import('../lib/privacy/index.js');
    expect(mod.BUILTIN_PATTERNS).toBeDefined();
    expect(mod.TOKENS).toBeDefined();
    expect(mod.VALIDATION_CHECKS).toBeDefined();
    expect(typeof mod.hintMatches).toBe('function');
  });

  it('re-exports pii-scrubber functions', async () => {
    const mod = await import('../lib/privacy/index.js');
    expect(typeof mod.scrub).toBe('function');
    expect(typeof mod.scrubPattern).toBe('function');
    expect(typeof mod.scrubPatterns).toBe('function');
    expect(typeof mod.addCustomPattern).toBe('function');
    expect(typeof mod.removeCustomPattern).toBe('function');
    expect(typeof mod.listPatterns).toBe('function');
    expect(typeof mod.resetPatterns).toBe('function');
    expect(typeof mod.resetStats).toBe('function');
    expect(typeof mod.getScrubStats).toBe('function');
    expect(typeof mod.validateScrubbed).toBe('function');
    expect(typeof mod.createScopedScrubber).toBe('function');
    expect(typeof mod.buildHomePathPatterns).toBe('function');
  });

  it('re-exports homoglyph-detector functions', async () => {
    const mod = await import('../lib/privacy/index.js');
    expect(typeof mod.detectHomoglyphs).toBe('function');
    expect(typeof mod.normalizeHomoglyphs).toBe('function');
    expect(typeof mod.checkMixedScript).toBe('function');
    expect(typeof mod.getHomoglyphMap).toBe('function');
  });

  it('re-exports token-rotation functions', async () => {
    const mod = await import('../lib/privacy/index.js');
    expect(typeof mod.generateToken).toBe('function');
    expect(typeof mod.rotateToken).toBe('function');
    expect(typeof mod.revokeToken).toBe('function');
    expect(typeof mod.isTokenValid).toBe('function');
    expect(typeof mod.getTokenInfo).toBe('function');
    expect(typeof mod.getTokenStats).toBe('function');
    expect(typeof mod.listTokens).toBe('function');
    expect(typeof mod.resetTokenStore).toBe('function');
    expect(typeof mod.configureTokens).toBe('function');
    expect(typeof mod.cleanupTokens).toBe('function');
    expect(typeof mod.restoreFromPersistence).toBe('function');
  });

  it('re-exports differential-privacy functions', async () => {
    const mod = await import('../lib/privacy/index.js');
    expect(typeof mod.createNoiseFunction).toBe('function');
    expect(typeof mod.validateDPConfig).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// lib/system/index.js
// ---------------------------------------------------------------------------
describe('lib/system/index.js barrel exports', () => {
  it('re-exports lsp-client functions', async () => {
    const mod = await import('../lib/system/index.js');
    expect(typeof mod.parseDiagnostic).toBe('function');
    expect(typeof mod.parseTscOutput).toBe('function');
    expect(typeof mod.parseEslintOutput).toBe('function');
    expect(typeof mod.collectDiagnostics).toBe('function');
    expect(typeof mod.collectTscDiagnostics).toBe('function');
    expect(typeof mod.collectEslintDiagnostics).toBe('function');
    expect(typeof mod.addDiagnosticContext).toBe('function');
    expect(typeof mod.getLastDiagnostics).toBe('function');
    expect(typeof mod.resetDiagnostics).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// lib/context/index.js
// ---------------------------------------------------------------------------
describe('lib/context/index.js barrel exports', () => {
  it('re-exports session functions', async () => {
    const mod = await import('../lib/context/index.js');
    expect(typeof mod.addHistory).toBe('function');
    expect(typeof mod.addTask).toBe('function');
    expect(typeof mod.getActiveAgents).toBe('function');
    expect(typeof mod.getInProgressTasks).toBe('function');
    expect(typeof mod.loadSessionState).toBe('function');
    expect(typeof mod.registerAgent).toBe('function');
    expect(typeof mod.saveSessionState).toBe('function');
    expect(typeof mod.unregisterAgent).toBe('function');
    expect(typeof mod.updateTaskStatus).toBe('function');
  });
});
