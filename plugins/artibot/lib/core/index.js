/**
 * Core module re-exports.
 * @module lib/core
 */

export { getPlatform, getNodeInfo, checkNodeVersion, getPluginRoot, resolveFromRoot } from './platform.js';
export { loadConfig, getConfig, resetConfig } from './config.js';
export { Cache, defaultCache } from './cache.js';
export { readStdinJSON, readStdin, writeJSON, writeText, writeError, writeHookResult } from './io.js';
export { debug, createDebugger, isDebugEnabled } from './debug.js';
export { exists, readJsonFile, writeJsonFile, readTextFile, ensureDir, listFiles, listDirs } from './file.js';
