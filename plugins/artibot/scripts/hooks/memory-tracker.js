#!/usr/bin/env node
/**
 * Memory tracker hook.
 * Collects and persists memories at session lifecycle events:
 * - SessionStart: loads previous memories and injects relevant context
 * - SessionEnd: summarizes session and saves learnings
 * - Error events: saves error pattern + resolution pairs
 *
 * Designed to be invoked by the hook system with event data on stdin.
 */

import { readStdin, writeStdout, parseJSON } from '../utils/index.js';
import path from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MEMORY_STORE_FILES = {
  userPreferences: 'user-preferences.json',
  projectContexts: 'project-contexts.json',
  commandHistory: 'command-history.json',
  errorPatterns: 'error-patterns.json',
};

const MAX_COMMAND_HISTORY = 500;
const MAX_ERROR_PATTERNS = 200;

// ---------------------------------------------------------------------------
// Path Helpers
// ---------------------------------------------------------------------------

function getMemoryDir() {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  return path.join(home, '.claude', 'artibot', 'memory');
}

function getStorePath(storeKey) {
  return path.join(getMemoryDir(), MEMORY_STORE_FILES[storeKey]);
}

// ---------------------------------------------------------------------------
// File Helpers (sync for hook scripts)
// ---------------------------------------------------------------------------

function loadStoreSync(storeKey) {
  const filePath = getStorePath(storeKey);
  try {
    const content = readFileSync(filePath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return { entries: [], metadata: { createdAt: new Date().toISOString() } };
  }
}

function saveStoreSync(storeKey, store) {
  const memDir = getMemoryDir();
  mkdirSync(memDir, { recursive: true });
  const updated = {
    ...store,
    metadata: { ...store.metadata, updatedAt: new Date().toISOString() },
  };
  writeFileSync(getStorePath(storeKey), JSON.stringify(updated, null, 2), 'utf-8');
}

// ---------------------------------------------------------------------------
// Event Handlers
// ---------------------------------------------------------------------------

/**
 * Handle SessionStart: load previous memories, return relevant context.
 * @param {object} hookData
 * @returns {object} Message for stdout
 */
function handleSessionStart(hookData) {
  const memDir = getMemoryDir();
  if (!existsSync(memDir)) {
    return { message: 'Memory system: no previous memories found.' };
  }

  // Load preferences and recent project contexts
  const prefs = loadStoreSync('userPreferences');
  const contexts = loadStoreSync('projectContexts');

  const activePrefs = prefs.entries.filter((e) => !isExpired(e));
  const recentContexts = contexts.entries
    .filter((e) => !isExpired(e))
    .slice(-5);

  const prefCount = activePrefs.length;
  const contextCount = recentContexts.length;

  if (prefCount === 0 && contextCount === 0) {
    return { message: 'Memory system: initialized (no relevant memories).' };
  }

  const parts = [];
  if (prefCount > 0) parts.push(`${prefCount} preferences`);
  if (contextCount > 0) parts.push(`${contextCount} project contexts`);

  return {
    message: `Memory system: loaded ${parts.join(', ')}.`,
  };
}

/**
 * Handle SessionEnd: summarize session and save to project contexts.
 * @param {object} hookData
 */
function handleSessionEnd(hookData) {
  const summary = {
    sessionId: hookData?.session_id || null,
    project: hookData?.project || path.basename(process.cwd()),
    endedAt: new Date().toISOString(),
    cwd: process.cwd(),
    metadata: {
      platform: process.platform,
      nodeVersion: process.version,
    },
  };

  // Save session summary to project contexts
  const store = loadStoreSync('projectContexts');
  const entry = {
    id: `context_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    type: 'context',
    data: summary,
    tags: ['session-summary', summary.project].filter(Boolean),
    source: 'memory-tracker',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
    accessCount: 0,
    lastAccessedAt: null,
  };

  // Keep only non-expired entries, enforce reasonable limits
  const kept = store.entries.filter((e) => !isExpired(e)).slice(-100);
  saveStoreSync('projectContexts', { ...store, entries: [...kept, entry] });
}

/**
 * Handle error events: save error pattern + resolution.
 * @param {object} hookData
 */
function handleError(hookData) {
  const errorData = hookData?.error || hookData;

  const entry = {
    id: `error_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    type: 'error',
    data: {
      message: errorData?.message || String(errorData),
      command: errorData?.command || null,
      file: errorData?.file || null,
      resolution: errorData?.resolution || null,
      project: path.basename(process.cwd()),
    },
    tags: extractErrorTags(errorData),
    source: 'memory-tracker',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
    accessCount: 0,
    lastAccessedAt: null,
  };

  const store = loadStoreSync('errorPatterns');
  const kept = store.entries.filter((e) => !isExpired(e)).slice(-(MAX_ERROR_PATTERNS - 1));
  saveStoreSync('errorPatterns', { ...store, entries: [...kept, entry] });
}

/**
 * Handle command events: track command usage.
 * @param {object} hookData
 */
function handleCommand(hookData) {
  const commandData = hookData?.command || hookData;

  const entry = {
    id: `command_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    type: 'command',
    data: {
      command: typeof commandData === 'string' ? commandData : commandData?.name || 'unknown',
      args: commandData?.args || null,
      project: path.basename(process.cwd()),
    },
    tags: extractCommandTags(commandData),
    source: 'memory-tracker',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    accessCount: 0,
    lastAccessedAt: null,
  };

  const store = loadStoreSync('commandHistory');
  const kept = store.entries.filter((e) => !isExpired(e)).slice(-(MAX_COMMAND_HISTORY - 1));
  saveStoreSync('commandHistory', { ...store, entries: [...kept, entry] });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isExpired(entry) {
  if (!entry.expiresAt) return false;
  return new Date(entry.expiresAt).getTime() < Date.now();
}

function extractErrorTags(errorData) {
  const tags = ['error'];
  if (typeof errorData === 'string') {
    tags.push(
      ...errorData
        .toLowerCase()
        .split(/[\s:]+/)
        .filter((t) => t.length >= 3 && t.length <= 30)
        .slice(0, 10),
    );
  } else if (errorData?.message) {
    tags.push(
      ...errorData.message
        .toLowerCase()
        .split(/[\s:]+/)
        .filter((t) => t.length >= 3 && t.length <= 30)
        .slice(0, 10),
    );
  }
  return [...new Set(tags)];
}

function extractCommandTags(commandData) {
  const tags = ['command'];
  const name = typeof commandData === 'string' ? commandData : commandData?.name;
  if (name) {
    tags.push(
      ...name
        .toLowerCase()
        .split(/[\s/\-_]+/)
        .filter((t) => t.length >= 2),
    );
  }
  return [...new Set(tags)];
}

// ---------------------------------------------------------------------------
// Main Entry Point
// ---------------------------------------------------------------------------

async function main() {
  const raw = await readStdin();
  const hookData = parseJSON(raw);

  const eventType = hookData?.event_type || hookData?.hook_type || 'unknown';

  try {
    switch (eventType) {
      case 'SessionStart':
      case 'session_start': {
        const result = handleSessionStart(hookData);
        writeStdout(result);
        break;
      }
      case 'SessionEnd':
      case 'session_end':
        handleSessionEnd(hookData);
        break;
      case 'error':
      case 'Error':
        handleError(hookData);
        break;
      case 'command':
      case 'Command':
        handleCommand(hookData);
        break;
      default:
        // For unrecognized events, attempt error tracking if error data present
        if (hookData?.error) {
          handleError(hookData);
        }
        break;
    }
  } catch (err) {
    process.stderr.write(`[artibot:memory-tracker] ${err.message}\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`[artibot:memory-tracker] ${err.message}\n`);
  process.exit(0); // Don't block on errors
});
