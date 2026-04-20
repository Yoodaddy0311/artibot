/**
 * Adapter module re-exports.
 * @module lib/adapters
 */

export { BaseAdapter } from './base-adapter.js';
export { GeminiAdapter } from './gemini-adapter.js';
export { CodexAdapter } from './codex-adapter.js';
export { CursorAdapter } from './cursor-adapter.js';
export { AntigravityAdapter } from './antigravity-adapter.js';
export { createCliAdapter } from './cli-adapter.js';

// Universal Harness Adapter (multi-harness abstraction)
export { UniversalHarnessAdapter, detectHarness, convertAgentDefinition, mapHooks } from './universal-harness.js';
