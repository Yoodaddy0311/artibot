/**
 * Tests for source-driven-development skill (Adoption ID AD-32).
 * Validates frontmatter, body sections, and integration with sdd-cache hook.
 *
 * @see plugins/artibot/skills/source-driven-development/SKILL.md
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { findEgress } from '../helpers/no-egress.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Resolve plugin root: tests/skills/ → tests/ → plugins/artibot/
const PLUGIN_ROOT = resolve(__dirname, '..', '..');
const SKILL_PATH = resolve(PLUGIN_ROOT, 'skills', 'source-driven-development', 'SKILL.md');

let skillText;

beforeAll(() => {
  skillText = readFileSync(SKILL_PATH, 'utf8');
});

/**
 * The text of one `## ` section, heading included, up to the next `## ` heading.
 * @param {string} heading - e.g. '## Cache-Aware Operation'
 * @returns {string}
 */
function sectionOf(heading) {
  const start = skillText.indexOf(heading);
  if (start === -1) return '';
  const end = skillText.indexOf('\n## ', start + heading.length);
  return skillText.slice(start, end === -1 ? undefined : end);
}

// ---------------------------------------------------------------------------
// Frontmatter parsing helper (lightweight; intentionally local to this file)
// ---------------------------------------------------------------------------

function parseFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) return null;
  const body = match[1];
  const fields = {};
  const lines = body.split(/\r?\n/);
  let currentArray = null;
  for (const line of lines) {
    const arrayItemMatch = line.match(/^\s+-\s+(.+)$/);
    if (arrayItemMatch && currentArray) {
      currentArray.push(arrayItemMatch[1].replace(/^["']|["']$/g, ''));
      continue;
    }
    const kvMatch = line.match(/^([a-zA-Z_-]+):\s*(.*)$/);
    if (!kvMatch) continue;
    const [, key, rawVal] = kvMatch;
    const val = rawVal.trim();
    if (val === '' || val === '|') {
      currentArray = [];
      fields[key] = currentArray;
    } else if (val.startsWith('[') && val.endsWith(']')) {
      fields[key] = val.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, ''));
      currentArray = null;
    } else {
      fields[key] = val.replace(/^["']|["']$/g, '');
      currentArray = null;
    }
  }
  return fields;
}

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

describe('source-driven-development SKILL.md frontmatter', () => {
  it('has name = source-driven-development', () => {
    const fm = parseFrontmatter(skillText);
    expect(fm).not.toBeNull();
    expect(fm.name).toBe('source-driven-development');
  });

  it('has whenNotToUse field (Squad B schema requirement)', () => {
    const fm = parseFrontmatter(skillText);
    expect(fm.whenNotToUse).toBeDefined();
    expect(typeof fm.whenNotToUse).toBe('string');
    expect(fm.whenNotToUse.length).toBeGreaterThan(20);
  });

  it('has description', () => {
    const fm = parseFrontmatter(skillText);
    expect(fm.description).toBeDefined();
    expect(fm.description.length).toBeGreaterThan(20);
  });

  it('has triggers list', () => {
    const fm = parseFrontmatter(skillText);
    expect(Array.isArray(fm.triggers)).toBe(true);
    expect(fm.triggers.length).toBeGreaterThanOrEqual(8);
  });

  it('triggers list contains framework keywords', () => {
    const fm = parseFrontmatter(skillText);
    expect(fm.triggers).toContain('framework');
    expect(fm.triggers).toContain('library');
    expect(fm.triggers).toContain('SDK');
    expect(fm.triggers).toContain('official docs');
    expect(fm.triggers).toContain('MDN');
    expect(fm.triggers).toContain('deprecated');
    expect(fm.triggers).toContain('migration');
  });

  it('has Korean triggers for Korean-primary user', () => {
    const fm = parseFrontmatter(skillText);
    const koTriggers = fm.triggers.filter((t) => /[\u3131-\uD79D]/u.test(t));
    expect(koTriggers.length).toBeGreaterThanOrEqual(2);
  });

  it('has level field', () => {
    const fm = parseFrontmatter(skillText);
    expect(fm.level).toBeDefined();
  });

  it('declares allowed-tools including WebFetch and Context7 MCP', () => {
    expect(skillText).toContain('allowed-tools');
    expect(skillText).toContain('WebFetch');
    expect(skillText).toContain('context7');
  });
});

// ---------------------------------------------------------------------------
// Body sections
// ---------------------------------------------------------------------------

describe('source-driven-development SKILL.md body sections', () => {
  it('contains DETECT-FETCH-IMPLEMENT-CITE process flow', () => {
    expect(skillText).toContain('DETECT');
    expect(skillText).toContain('FETCH');
    expect(skillText).toContain('IMPLEMENT');
    expect(skillText).toContain('CITE');
  });

  it('contains Common Rationalizations section', () => {
    expect(skillText).toMatch(/##\s*Common Rationalizations/);
  });

  it('contains Red Flags section', () => {
    expect(skillText).toMatch(/##\s*Red Flags/);
  });

  it('contains Verification section', () => {
    expect(skillText).toMatch(/##\s*Verification/);
  });

  it('contains When NOT to Use section', () => {
    expect(skillText).toMatch(/##\s*When NOT to Use/);
  });

  it('contains Source Hierarchy table', () => {
    expect(skillText).toMatch(/##\s*Source Hierarchy/);
    expect(skillText).toContain('react.dev');
    expect(skillText).toContain('MDN');
  });

  it('contains Citation Rules section', () => {
    expect(skillText).toMatch(/##\s*Citation Rules/);
  });

  it('Common Rationalizations table has at least 5 rows', () => {
    const start = skillText.indexOf('## Common Rationalizations');
    const end = skillText.indexOf('## Red Flags', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const section = skillText.slice(start, end);
    const rows = section.split('\n').filter((l) => /^\s*\|/.test(l) && (l.match(/\|/g) || []).length >= 4);
    const dataRows = rows.length - 2; // minus header + separator
    expect(dataRows).toBeGreaterThanOrEqual(5);
  });

  it('Red Flags has at least 5 bullet items', () => {
    const start = skillText.indexOf('## Red Flags');
    const end = skillText.indexOf('## Verification', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const section = skillText.slice(start, end);
    const bullets = section.split('\n').filter((l) => /^\s*-\s+\S/.test(l));
    expect(bullets.length).toBeGreaterThanOrEqual(5);
  });

  it('rejects Stack Overflow as primary source', () => {
    expect(skillText).toMatch(/Stack Overflow/i);
    expect(skillText).toMatch(/[Nn]ot authoritative|never.*primary|never authoritative/);
  });

  it('mandates UNVERIFIED markers when docs absent', () => {
    expect(skillText).toContain('UNVERIFIED');
  });
});

// ---------------------------------------------------------------------------
// sdd-cache hook integration (Squad C deliverable)
// ---------------------------------------------------------------------------

describe('source-driven-development sdd-cache integration', () => {
  it('cites Squad C webfetch-cache hook by name', () => {
    expect(skillText).toContain('webfetch-cache-pre.js');
    expect(skillText).toContain('webfetch-cache-post.js');
  });

  it('describes cache-aware operation', () => {
    expect(skillText).toMatch(/##\s*Cache-Aware Operation/);
  });

  // The hooks make no HTTP request (webfetch-cache-pre.js header: "NO HTTP / fetch / external
  // egress") and never answer a WebFetch from the cache. Until 2026-11-22 the skill promised
  // upstream sdd-cache behaviour instead (304 revalidation, conditional headers, "skip the WebFetch
  // entirely") and this test pinned /304/. What the skill may claim is scoped to the HOOKS: whether
  // the host's WebFetch tool caches on its own is not something this repository can verify.
  it('describes the cache as local-only with no HTTP revalidation, matching the hook source', () => {
    const section = sectionOf('## Cache-Aware Operation');
    expect(section).toMatch(/never make an HTTP request/);
    expect(section).toMatch(/no TTL/);
    expect(section).toMatch(/do NOT make a repeat fetch cheaper/);
    expect(section).toMatch(/never serve a WebFetch from the cache/);
    expect(section).toMatch(/262,144 UTF-8 bytes/); // webfetch-cache-post.js#MAX_BYTES, a byte cap
    // TRADE-OFF (lane D review, 2026-11-22): this vocabulary ban also turns an HONEST negation red —
    // "the hooks do not send If-None-Match" or "there is no 304 revalidation" would fail here. It
    // stays because it is what catches regressions c1/c2 (the old claims put back). If the skill
    // ever needs such a negation, change this regex (e.g. allow the token only in a sentence that
    // also says "not"/"no"), do not reword the skill around the test.
    expect(skillText).not.toMatch(/\b304\b|If-None-Match|If-Modified-Since|near-free|cheap revalidation/);
    expect(skillText).not.toMatch(/skip the WebFetch/i);
    for (const hook of ['webfetch-cache-pre.js', 'webfetch-cache-post.js']) {
      const src = readFileSync(resolve(PLUGIN_ROOT, 'scripts', 'hooks', hook), 'utf8');
      expect(findEgress(src), hook).toEqual([]);
    }
  });

  // Every false sentence the 2026-11-22 correction removed, VERBATIM. Extracted with
  // `git diff HEAD -U0 -- skills/source-driven-development/SKILL.md | grep '^-'` (HEAD 2ee834f1);
  // list markers ("- ", "1. ", "- [ ] ") are stripped so a sentence put back as prose is caught
  // too, and whitespace is collapsed on both sides. The last two are this correction's own
  // overreach about the host tool, removed again the same day. Lines that were TRUE and only
  // reworded (e.g. the post-hook "See Also" entry) are not listed.
  //
  // WHAT THIS GATE CANNOT SEE: a falsehood put back in OTHER words. The vocabulary check above
  // (304, If-None-Match, near-free, …) catches the obvious tokens, but a paraphrase such as "they
  // handle revalidation automatically, so repeated fetches are nearly free" (review mutant g1) or
  // "if the hit is fresh you can skip the fetch and read the cached body" (g3) passes both checks.
  // No regex closes that; it is left to review against webfetch-cache-pre.js / -post.js.
  const REMOVED_FALSE_SENTENCES = Object.freeze([
    'Pairs with sdd-cache hook for cheap revalidation.',
    'automatically handle HTTP 304 revalidation, so repeated fetches of the same doc page within a session are nearly free.',
    "hooks (the Artibot port of agent-skills' sdd-cache, Adoption ID AD-24) intercept WebFetch calls and:",
    'On `WebFetch.pre`: compute a cache key from the URL, look up `runtime/cache/webfetch/<sha>.json`, send `If-None-Match` / `If-Modified-Since` headers if available',
    'On `WebFetch.post`: if upstream returned 304, serve cached body; otherwise update cache with new ETag/Last-Modified + body',
    'Re-fetching the same doc page within minutes is ~free (304 response, no body transfer)',
    "The cache lives at `runtime/cache/webfetch/`, gitignored, never leaves the user's machine (DATA POLICY compliant)",
    'HEAD request is the only revalidation traffic — no body is transmitted unless content actually changed',
    'See `plugins/artibot/docs/webfetch-cache.md` for the cache key format and TTL policy',
    "If the cache hit is fresh (within the cache's freshness window), you can skip the WebFetch entirely.",
    'The hook surfaces this via a hint in the WebFetch tool result; persona just reads the cached body.',
    'The sdd-cache hook makes repeat fetches near-free',
    'Fetch on first use; rely on cache for revalidation in the same session',
    'Verify even simple framework-specific patterns; the cache makes it cheap',
    'Ignoring the `webfetch-cache` hint that says "cached body available"',
    'WebFetch cache hits leveraged (no redundant body transfers when 304 was available)',
    '`plugins/artibot/docs/webfetch-cache.md` — cache key format, freshness, eviction (from Squad C)',
    '`plugins/artibot/scripts/hooks/webfetch-cache-pre.js` — pre-fetch revalidation hook',
    'so every WebFetch still goes to the network and a repeat fetch costs the same as the first.',
    'A repeat fetch of the same page is NOT cheaper: WebFetch runs again in full.',
  ]);
  const squash = (s) => s.replace(/\s+/g, ' ');

  it.each(REMOVED_FALSE_SENTENCES)('never brings back the removed false sentence: %s', (sentence) => {
    expect(squash(skillText)).not.toContain(squash(sentence));
  });

  it('confirms cache stays local (DATA POLICY)', () => {
    expect(skillText).toContain('runtime/cache/webfetch');
    expect(skillText).toMatch(/local|never leaves|DATA POLICY/i);
  });

  it('cites adoption ID AD-24 (sdd-cache) and AD-32 (this skill)', () => {
    expect(skillText).toMatch(/AD-24|sdd-cache/);
    expect(skillText).toMatch(/AD-32|agent-skills/);
  });
});

// ---------------------------------------------------------------------------
// Cross-link integrity
// ---------------------------------------------------------------------------

describe('source-driven-development cross-links', () => {
  // `plugins/artibot/docs/*` is gitignored (.gitignore:26) and docs/webfetch-cache.md was never
  // committed, so a link to it is dead in every checkout and install. The hook sources ship.
  it('points at the shipped hook sources, not the unshipped docs page', () => {
    expect(skillText).not.toContain('webfetch-cache.md');
    expect(skillText).toContain('scripts/hooks/webfetch-cache-pre.js');
    expect(existsSync(resolve(PLUGIN_ROOT, 'scripts', 'hooks', 'webfetch-cache-pre.js'))).toBe(true);
  });

  it('links to persona-distill (See Also section)', () => {
    expect(skillText).toContain('persona-distill');
  });

  it('does not introduce DATA POLICY violations (no external chat APIs)', () => {
    expect(skillText).not.toMatch(/feishu|dingtalk|slack-bot|wechat-api/i);
  });
});
