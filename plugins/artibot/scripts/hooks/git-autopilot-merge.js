#!/usr/bin/env node
/**
 * Git Autopilot — Merge conflict auto-resolution engine (shared module).
 * Provides utility functions for conflict detection, strategy selection,
 * and resolution. Imported by other git-autopilot-* scripts.
 * @module scripts/hooks/git-autopilot-merge
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

// -------------------------------------------------------------------------
// Constants
// -------------------------------------------------------------------------

/** Regex to detect conflict markers in file content. */
const CONFLICT_MARKER_RE = /^<{7} |^={7}$|^>{7} /m;

/** Conflict block pattern (captures ours / theirs sections). */
const CONFLICT_BLOCK_RE = /<{7} .+?\n([\s\S]*?)={7}\n([\s\S]*?)>{7} .+/g;

// -------------------------------------------------------------------------
// Conflict Detection
// -------------------------------------------------------------------------

/**
 * Check whether a file contains unresolved conflict markers.
 * @param {string} filePath - Absolute or repo-relative path
 * @returns {boolean}
 */
export function hasConflicts(filePath) {
  try {
    const content = readFileSync(filePath, 'utf-8');
    return CONFLICT_MARKER_RE.test(content);
  } catch {
    return false;
  }
}

/**
 * List all files with unresolved conflicts in the current repo.
 * @param {string} cwd - Repository working directory
 * @returns {string[]} Array of file paths with conflicts
 */
export function listConflictedFiles(cwd) {
  try {
    // `-z` : NUL-separated, and it suppresses `core.quotepath` C-quoting. That
    // matters here because these paths are fed straight back to git
    // (`checkout --ours -- <path>`) and to readFileSync by the resolution
    // strategies below — a C-quoted path names a file that does not exist, so
    // every conflict on a non-ASCII path silently failed to auto-resolve.
    // No `.trim()`: a path may legitimately begin or end with a space.
    const output = execFileSync('git', ['diff', '--name-only', '-z', '--diff-filter=U'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return output.split('\0').filter(Boolean);
  } catch {
    return [];
  }
}

// -------------------------------------------------------------------------
// Resolution Strategies
// -------------------------------------------------------------------------

/**
 * Resolve conflict by keeping "ours" (HEAD) version.
 * @param {string} filePath
 * @param {string} cwd
 * @returns {{ resolved: boolean, strategy: string }}
 */
export function resolveOurs(filePath, cwd) {
  try {
    execFileSync('git', ['checkout', '--ours', '--', filePath], {
      cwd,
      stdio: 'ignore',
    });
    execFileSync('git', ['add', '--', filePath], { cwd, stdio: 'ignore' });
    return { resolved: true, strategy: 'ours' };
  } catch (err) {
    return { resolved: false, strategy: 'ours', error: err.message };
  }
}

/**
 * Resolve conflict by keeping "theirs" (incoming) version.
 * @param {string} filePath
 * @param {string} cwd
 * @returns {{ resolved: boolean, strategy: string }}
 */
export function resolveTheirs(filePath, cwd) {
  try {
    execFileSync('git', ['checkout', '--theirs', '--', filePath], {
      cwd,
      stdio: 'ignore',
    });
    execFileSync('git', ['add', '--', filePath], { cwd, stdio: 'ignore' });
    return { resolved: true, strategy: 'theirs' };
  } catch (err) {
    return { resolved: false, strategy: 'theirs', error: err.message };
  }
}

/**
 * Attempt a union merge: keep both sides by removing markers only.
 * Safe for non-overlapping additions (e.g. imports, list items).
 * @param {string} filePath
 * @param {string} cwd
 * @returns {{ resolved: boolean, strategy: string }}
 */
export function resolveUnion(filePath, cwd) {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const resolved = content.replace(CONFLICT_BLOCK_RE, (_match, ours, theirs) => {
      return `${ours.trimEnd()}\n${theirs.trimEnd()}`;
    });

    // If still has markers, union failed
    if (CONFLICT_MARKER_RE.test(resolved)) {
      return { resolved: false, strategy: 'union' };
    }

    writeFileSync(filePath, resolved, 'utf-8');
    execFileSync('git', ['add', '--', filePath], { cwd, stdio: 'ignore' });
    return { resolved: true, strategy: 'union' };
  } catch (err) {
    return { resolved: false, strategy: 'union', error: err.message };
  }
}

// -------------------------------------------------------------------------
// Auto-Resolution Dispatcher
// -------------------------------------------------------------------------

/**
 * Select and apply the best resolution strategy for a conflicted file.
 * Strategy priority: union → ours (default safe fallback).
 * Lock files and generated files always use ours.
 * @param {string} filePath
 * @param {string} cwd
 * @returns {{ resolved: boolean, strategy: string, filePath: string }}
 */
export function autoResolveFile(filePath, cwd) {
  const isLockFile = filePath.endsWith('.lock') || filePath.endsWith('-lock.json');
  const isGenerated = filePath.includes('dist/') || filePath.includes('build/');

  if (isLockFile || isGenerated) {
    const result = resolveOurs(filePath, cwd);
    return { ...result, filePath };
  }

  // Try union merge first (preserves both sides)
  const union = resolveUnion(filePath, cwd);
  if (union.resolved) return { ...union, filePath };

  // Fall back to ours
  const ours = resolveOurs(filePath, cwd);
  return { ...ours, filePath };
}

/**
 * Attempt to resolve all conflicted files in the repo.
 * @param {string} cwd - Repository working directory
 * @returns {{ results: Array<{filePath, resolved, strategy}>, allResolved: boolean }}
 */
export function autoResolveAll(cwd) {
  const conflicted = listConflictedFiles(cwd);
  if (conflicted.length === 0) {
    return { results: [], allResolved: true };
  }

  const results = conflicted.map((f) => autoResolveFile(f, cwd));
  const allResolved = results.every((r) => r.resolved);
  return { results, allResolved };
}
