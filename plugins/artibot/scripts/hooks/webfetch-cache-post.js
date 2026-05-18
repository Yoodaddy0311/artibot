#!/usr/bin/env node
/**
 * PostToolUse hook for WebFetch — persist the response body locally so the
 * pre-hook can surface a cache hit on next request.
 *
 * Adoption AD-24 (TRANSFORM). NO HTTP from this hook. The response we
 * persist is whatever the WebFetch tool itself produced; we never re-query
 * the origin. Validators (etag/lastModified) are best-effort: if the tool
 * exposes them via tool_response.headers we capture them; otherwise we
 * record null. Storage path: `runtime/cache/webfetch/<sha1(url)>.json`.
 *
 * Schema:
 *   { url, etag, lastModified, content, fetchedAt }
 *
 * @module scripts/hooks/webfetch-cache-post
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPluginRoot, parseJSON, readStdin, writeStdout } from '../utils/index.js';
import { createErrorHandler } from '../../lib/core/hook-utils.js';
import { cacheDir, cacheKey } from './webfetch-cache-pre.js';

const HOOK_NAME = 'webfetch-cache-post';
const MAX_BYTES = 256 * 1024; // 256 KB cap per entry — keep cache local-friendly.

/**
 * Pull the textual content out of a WebFetch tool_response object.
 * Tries the common shapes Claude Code emits; returns '' when none match.
 * @param {*} toolResponse
 * @returns {string}
 */
export function extractContent(toolResponse) {
  if (!toolResponse) return '';
  if (typeof toolResponse === 'string') return toolResponse;
  if (typeof toolResponse !== 'object') return '';
  const candidates = [
    toolResponse.result,
    toolResponse.output,
    toolResponse.text,
    toolResponse.content,
    toolResponse.body,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) return c;
  }
  return '';
}

/**
 * Pull etag / lastModified from optional headers on the tool_response.
 * @param {*} toolResponse
 * @returns {{ etag: string|null, lastModified: string|null }}
 */
export function extractValidators(toolResponse) {
  const headers = toolResponse && typeof toolResponse === 'object' ? toolResponse.headers : null;
  if (!headers || typeof headers !== 'object') return { etag: null, lastModified: null };
  const get = (k) => {
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === k) return String(headers[key]);
    }
    return null;
  };
  return {
    etag: get('etag'),
    lastModified: get('last-modified'),
  };
}

/**
 * Build the cache record.
 * @param {object} params
 * @returns {object}
 */
export function buildRecord({ url, content, etag, lastModified }) {
  const truncated = content.length > MAX_BYTES;
  return {
    url,
    etag,
    lastModified,
    content: truncated ? content.slice(0, MAX_BYTES) : content,
    truncated,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Persist the cache entry under runtime/cache/webfetch/<sha>.json.
 * Best-effort — silently swallows write failures so PostToolUse never
 * blocks the agent.
 * @param {string} url
 * @param {string} content
 * @param {{ etag: string|null, lastModified: string|null }} validators
 * @param {string} [pluginRoot]
 * @returns {Promise<{ key: string, persisted: boolean, bytes: number }>}
 */
export async function persistCacheEntry(url, content, validators, pluginRoot = getPluginRoot()) {
  const key = cacheKey(url);
  const dir = cacheDir(pluginRoot);
  const filePath = path.join(dir, `${key}.json`);
  const record = buildRecord({ url, content, ...validators });
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(filePath, JSON.stringify(record, null, 2), 'utf-8');
    return { key, persisted: true, bytes: record.content.length };
  } catch {
    return { key, persisted: false, bytes: 0 };
  }
}

async function main() {
  const raw = await readStdin();
  const hookData = parseJSON(raw) ?? {};
  const url = hookData?.tool_input?.url || hookData?.url || '';
  if (!url) {
    writeStdout({ continue: true });
    return;
  }
  const content = extractContent(hookData?.tool_response);
  if (!content) {
    writeStdout({ continue: true });
    return;
  }
  const validators = extractValidators(hookData?.tool_response);
  const result = await persistCacheEntry(url, content, validators);
  writeStdout({
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      cacheKey: result.key,
      persisted: result.persisted,
      bytes: result.bytes,
    },
  });
}

const isMain = (() => {
  try {
    const argv1 = process.argv[1] ? path.resolve(process.argv[1]) : '';
    const here = path.resolve(fileURLToPath(import.meta.url));
    return argv1 === here;
  } catch {
    return false;
  }
})();

if (isMain) {
  main().catch(createErrorHandler(HOOK_NAME, { exit: true }));
}
