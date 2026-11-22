#!/usr/bin/env node
/**
 * PostToolUse hook for WebFetch — persist the response body locally so the
 * pre-hook can surface a cache hit on next request.
 *
 * Adoption AD-24 (TRANSFORM). NO HTTP from this hook. The response we
 * persist is whatever the WebFetch tool itself produced; we never re-query
 * the origin. Validators (etag/lastModified) are best-effort: if the tool
 * exposes them via tool_response.headers we capture them; otherwise we
 * record null. Storage path: `<state dir>/runtime/cache/webfetch/<sha1(url)>.json`
 * (`webfetch-cache-pre.js#cacheDir`, shared with the pre-hook).
 *
 * Schema:
 *   { url, etag, lastModified, content, truncated, fetchedAt }
 * `content` is capped at {@link MAX_BYTES} UTF-8 bytes, cut on a code point boundary.
 *
 * @module scripts/hooks/webfetch-cache-post
 */

import path from 'node:path';
import { parseJSON, readStdin, writeStdout } from '../utils/index.js';
import { atomicWriteJson } from '../../lib/core/file.js';
import { createErrorHandler } from '../../lib/core/hook-utils.js';
import { cacheDir, cacheKey } from './webfetch-cache-pre.js';
import { isMainEntry } from './_main-entry.js';

const HOOK_NAME = 'webfetch-cache-post';
/**
 * Per-entry cap on `content`: 262,144 UTF-8 BYTES. It used to compare `content.length` (UTF-16
 * code units), so Hangul — 3 bytes per character — stored up to 768 KiB (review, 2026-11-22).
 */
const MAX_BYTES = 256 * 1024;

/**
 * The longest prefix of `text` that fits in `maxBytes` UTF-8 bytes, cut on a CODE POINT
 * boundary: a multi-byte code point (an astral one is a surrogate pair in JS) that straddles
 * the cap is dropped whole, so the result never ends in U+FFFD or a lone surrogate.
 * It does NOT respect grapheme clusters: a base letter and its combining mark, or the parts of
 * a ZWJ emoji sequence, are separate code points and can be split at the cap (the visible
 * "character" may lose its accent or decompose into separate emoji).
 * @param {string} text
 * @param {number} maxBytes
 * @returns {{ text: string, truncated: boolean }}
 */
export function truncateUtf8(text, maxBytes) {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return { text, truncated: false };
  let end = maxBytes;
  // 0b10xxxxxx is a continuation byte: step back to the lead byte of that code point.
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
  return { text: buf.subarray(0, end).toString('utf8'), truncated: true };
}

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
 * Build the cache record; `content` is capped at {@link MAX_BYTES} UTF-8 bytes ({@link truncateUtf8}).
 * @param {object} params
 * @returns {object}
 */
export function buildRecord({ url, content, etag, lastModified }) {
  const capped = truncateUtf8(content, MAX_BYTES);
  return {
    url,
    etag,
    lastModified,
    content: capped.text,
    truncated: capped.truncated,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Persist the cache entry under `<state dir>/runtime/cache/webfetch/<sha>.json`.
 *
 * Atomic (`lib/core/file.js#atomicWriteJson`: tmp sibling + rename): the cache is GLOBAL, so
 * sessions in different projects can write one entry at once, and a plain write could leave a
 * half-written file or destroy the previous entry. `atomicWriteJson` throws when the write does
 * not land (after removing its tmp file); that is reported as `persisted: false` and otherwise
 * swallowed — the cache is best-effort and PostToolUse must never block the agent.
 * @param {string} url
 * @param {string} content
 * @param {{ etag: string|null, lastModified: string|null }} validators
 * @returns {Promise<{ key: string, persisted: boolean, bytes: number }>} `bytes` is the stored
 *   content's UTF-8 size (not its character count); 0 when nothing was persisted
 */
export async function persistCacheEntry(url, content, validators) {
  const key = cacheKey(url);
  const filePath = path.join(cacheDir(), `${key}.json`);
  const record = buildRecord({ url, content, ...validators });
  try {
    await atomicWriteJson(filePath, record);
    return { key, persisted: true, bytes: Buffer.byteLength(record.content, 'utf8') };
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

if (isMainEntry(import.meta.url)) {
  main().catch(createErrorHandler(HOOK_NAME, { exit: true }));
}
