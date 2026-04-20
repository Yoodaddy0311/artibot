/**
 * Skill content hashing utilities.
 *
 * Computes deterministic 8-char SHA-256 hashes of SKILL.md body content
 * (excluding YAML frontmatter) for cache invalidation and freshness checks.
 *
 * Phase 1 Quick Win — adopted from makabakaxy/mcp2cli benchmark.
 *
 * @module lib/core/skill-hash
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const FRONTMATTER_FENCE = '---';
const HASH_LENGTH = 8;

/**
 * Compute the deterministic 8-char hash of arbitrary content.
 * Normalizes line endings (CRLF -> LF) and trims trailing whitespace
 * to keep cross-platform results stable.
 *
 * @param {string} content - Raw text content to hash.
 * @returns {string} First 8 hex chars of SHA-256.
 */
export function computeHash(content) {
  const normalized = String(content).replace(/\r\n/g, '\n').trimEnd();
  return createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, HASH_LENGTH);
}

/**
 * Strip the YAML frontmatter block from a raw SKILL.md string.
 * Handles three cases:
 *   1. File starts with `---\n...\n---\n` — strip the block.
 *   2. No frontmatter — return raw content unchanged.
 *   3. Malformed (only opening fence) — return raw content unchanged.
 *
 * @param {string} raw - Full SKILL.md file contents.
 * @returns {string} Body without frontmatter.
 */
export function extractSkillBody(raw) {
  const text = String(raw).replace(/\r\n/g, '\n');
  if (!text.startsWith(FRONTMATTER_FENCE)) {
    return text;
  }
  const lines = text.split('\n');
  // First line is the opening fence; find the closing fence after it.
  let closingIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === FRONTMATTER_FENCE) {
      closingIdx = i;
      break;
    }
  }
  if (closingIdx === -1) {
    return text;
  }
  return lines.slice(closingIdx + 1).join('\n');
}

/**
 * Read a SKILL.md file and return both the parsed frontmatter (raw lines)
 * and the body. Uses a minimal line-based parser to avoid pulling in a YAML
 * dependency (Artibot is zero-runtime-deps per package.json policy).
 *
 * @param {string} skillPath - Absolute path to a SKILL.md file.
 * @returns {Promise<{ frontmatter: Record<string,string>, body: string, raw: string }>}
 */
export async function readSkillFrontmatter(skillPath) {
  const raw = await readFile(skillPath, 'utf-8');
  const text = raw.replace(/\r\n/g, '\n');
  const frontmatter = {};
  if (!text.startsWith(FRONTMATTER_FENCE)) {
    return { frontmatter, body: text, raw };
  }
  const lines = text.split('\n');
  let closingIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === FRONTMATTER_FENCE) {
      closingIdx = i;
      break;
    }
  }
  if (closingIdx === -1) {
    return { frontmatter, body: text, raw };
  }
  for (let i = 1; i < closingIdx; i++) {
    const line = lines[i];
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (key) frontmatter[key] = value;
  }
  return {
    frontmatter,
    body: lines.slice(closingIdx + 1).join('\n'),
    raw,
  };
}

/**
 * Verify whether a skill's stored `source_hash` matches its current body hash.
 *
 * @param {string} skillPath - Absolute path to a SKILL.md file.
 * @returns {Promise<{ current: string, stored: string|null, match: boolean }>}
 */
export async function verifyHash(skillPath) {
  const { frontmatter, body } = await readSkillFrontmatter(skillPath);
  const current = computeHash(body);
  const stored = frontmatter.source_hash || null;
  return {
    current,
    stored,
    match: stored !== null && stored === current,
  };
}
