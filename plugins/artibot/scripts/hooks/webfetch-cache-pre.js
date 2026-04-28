#!/usr/bin/env node
/**
 * PreToolUse hook for WebFetch — local-only cache lookup.
 *
 * Adoption AD-24 (TRANSFORM of agent-skills sdd-cache). Cache key is
 * SHA-1 of the requested URL; entries live under
 * `runtime/cache/webfetch/<sha>.json`. The original benchmark performs
 * an HTTP HEAD revalidation on every reuse — that violates Artibot's
 * DATA POLICY (no external HTTP from a hook). Instead we publish the
 * cache key and a `cached` flag in the hookSpecificOutput so downstream
 * tooling (statusline, post-hook) can correlate the request with disk
 * state, while the actual WebFetch tool always does the network call.
 *
 * NO HTTP / fetch / external egress in this script.
 *
 * @module scripts/hooks/webfetch-cache-pre
 */

import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { getPluginRoot, parseJSON, readStdin, writeStdout } from '../utils/index.js';
import { createErrorHandler } from '../../lib/core/hook-utils.js';

const HOOK_NAME = 'webfetch-cache-pre';

/**
 * Resolve the cache directory for WebFetch entries.
 * @param {string} [pluginRoot]
 * @returns {string}
 */
export function cacheDir(pluginRoot = getPluginRoot()) {
  const repoRoot = path.resolve(pluginRoot, '..', '..');
  return path.join(repoRoot, 'runtime', 'cache', 'webfetch');
}

/**
 * SHA-1 of the URL — short, collision-safe enough for local cache keys.
 * @param {string} url
 * @returns {string}
 */
export function cacheKey(url) {
  return createHash('sha1').update(url, 'utf-8').digest('hex');
}

/**
 * Inspect the cached entry on disk. Returns metadata only — never the body —
 * so the pre-hook stays small. Missing/corrupt entries return `null`.
 * @param {string} dir
 * @param {string} key
 * @returns {Promise<{ etag: string|null, lastModified: string|null, fetchedAt: string|null, sizeBytes: number }|null>}
 */
export async function loadCachedMeta(dir, key) {
  const filePath = path.join(dir, `${key}.json`);
  try {
    const fileStat = await stat(filePath);
    const raw = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      etag: parsed.etag ?? null,
      lastModified: parsed.lastModified ?? null,
      fetchedAt: parsed.fetchedAt ?? null,
      sizeBytes: fileStat.size,
    };
  } catch {
    return null;
  }
}

/**
 * Build the hook output payload.
 * @param {object} params
 * @param {string} params.url
 * @param {string} params.key
 * @param {ReturnType<typeof loadCachedMeta>|null} params.meta
 * @returns {object}
 */
export function buildOutput({ url, key, meta }) {
  const cached = Boolean(meta);
  const hint = cached
    ? `[artibot:webfetch-cache] disk hit for ${url} (key=${key.slice(0, 12)} fetchedAt=${meta?.fetchedAt ?? 'unknown'}). The post-hook will refresh on completion; the WebFetch tool itself still owns the network call.`
    : `[artibot:webfetch-cache] miss for ${url} (key=${key.slice(0, 12)}); will populate after fetch.`;

  return {
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      cacheKey: key,
      cached,
      etag: meta?.etag ?? null,
      lastModified: meta?.lastModified ?? null,
      additionalContext: hint,
    },
  };
}

async function main() {
  const raw = await readStdin();
  const hookData = parseJSON(raw) ?? {};
  const url = hookData?.tool_input?.url || hookData?.url || '';
  if (!url) {
    writeStdout({ continue: true });
    return;
  }
  const key = cacheKey(url);
  const dir = cacheDir();
  const meta = await loadCachedMeta(dir, key);
  writeStdout(buildOutput({ url, key, meta }));
}

const isMain = (() => {
  try {
    const argv1 = process.argv[1] ? path.resolve(process.argv[1]) : '';
    const here = path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
    return argv1 === here;
  } catch {
    return false;
  }
})();

if (isMain) {
  main().catch(createErrorHandler(HOOK_NAME, { exit: true }));
}
