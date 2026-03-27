/**
 * Skill Freshness Checker.
 * Tracks skill versioning and staleness based on SKILL.md frontmatter
 * fields `version` and `lastVerified`.
 *
 * @module lib/learning/skill-freshness
 */

import { readdir } from 'node:fs/promises';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_AGE_DAYS = 90;
const DEFAULT_WARNING_DAYS = 60;
const MS_PER_DAY = 86_400_000;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Parse a YYYY-MM-DD date string into a Date object.
 * Returns null for invalid or missing input.
 *
 * @param {string|undefined|null} dateStr
 * @returns {Date|null}
 */
function parseDate(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return null;
  const trimmed = dateStr.trim().replace(/^["']|["']$/g, '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  const d = new Date(`${trimmed}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Calculate days between two dates.
 *
 * @param {Date} from
 * @param {Date} to
 * @returns {number}
 */
function daysBetween(from, to) {
  return Math.floor((to.getTime() - from.getTime()) / MS_PER_DAY);
}

/**
 * Extract frontmatter fields from SKILL.md content string.
 * Looks for `version:` and `lastVerified:` in YAML frontmatter.
 *
 * @param {string} content
 * @returns {{ name: string|null, version: string|null, lastVerified: string|null }}
 */
function parseFrontmatter(content) {
  if (!content || typeof content !== 'string') {
    return { name: null, version: null, lastVerified: null };
  }

  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!fmMatch) {
    return { name: null, version: null, lastVerified: null };
  }

  const fm = fmMatch[1];

  const extract = (key) => {
    const re = new RegExp(`^${key}:\\s*(.+)$`, 'm');
    const m = fm.match(re);
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
  };

  return {
    name: extract('name'),
    version: extract('version'),
    lastVerified: extract('lastVerified'),
  };
}

/**
 * Update the `lastVerified` field in a SKILL.md content string.
 * If the field exists, replaces it. If not, inserts before the closing `---`.
 * Returns a new string (immutable — does not write to disk).
 *
 * @param {string} content - Original SKILL.md content
 * @param {string} dateStr - New date (YYYY-MM-DD)
 * @returns {string} Updated content
 */
function updateLastVerified(content, dateStr) {
  if (!content || typeof content !== 'string') return content;

  const hasField = /^lastVerified:\s*.+$/m.test(content);

  if (hasField) {
    return content.replace(
      /^lastVerified:\s*.+$/m,
      `lastVerified: "${dateStr}"`,
    );
  }

  // Insert before closing ---
  return content.replace(
    /\n---(\s*)$/m,
    `\nlastVerified: "${dateStr}"\n---$1`,
  );
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a skill freshness checker.
 *
 * @param {object} [config]
 * @param {number} [config.maxAgeDays=90]     - Days after which a skill is stale.
 * @param {number} [config.warningDays=60]    - Days after which a skill gets a warning.
 * @param {() => Date} [config.now]           - Clock injection for tests.
 * @param {(p: string) => Promise<string>} [config.readFile] - File reader injection.
 * @returns {object}
 */
export function createSkillFreshnessChecker(config = {}) {
  const maxAgeDays = config.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;
  const warningDays = config.warningDays ?? DEFAULT_WARNING_DAYS;
  const nowFn = config.now ?? (() => new Date());
  const readFileFn = config.readFile ?? null;

  return {
    /**
     * Check freshness of a single skill.
     *
     * @param {{ name?: string, lastVerified?: string, version?: string }} skillMeta
     * @returns {{ status: 'fresh'|'warning'|'stale'|'unknown', daysSinceVerified: number|null, skill: string }}
     */
    checkFreshness(skillMeta) {
      const name = skillMeta?.name ?? 'unknown';
      const verified = parseDate(skillMeta?.lastVerified);

      if (!verified) {
        return { status: 'unknown', daysSinceVerified: null, skill: name };
      }

      const days = daysBetween(verified, nowFn());

      if (days > maxAgeDays) {
        return { status: 'stale', daysSinceVerified: days, skill: name };
      }
      if (days > warningDays) {
        return { status: 'warning', daysSinceVerified: days, skill: name };
      }
      return { status: 'fresh', daysSinceVerified: days, skill: name };
    },

    /**
     * Scan all SKILL.md files in a skills directory.
     *
     * @param {string} skillsDir - Absolute path to skills/ directory
     * @returns {Promise<Array<{ status: string, daysSinceVerified: number|null, skill: string, version: string|null, path: string }>>}
     */
    async scanAllSkills(skillsDir) {
      let entries;
      try {
        entries = await readdir(skillsDir, { withFileTypes: true });
      } catch {
        return [];
      }

      const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
      const results = [];

      for (const dir of dirs) {
        const skillPath = path.join(skillsDir, dir, 'SKILL.md');
        let content;
        try {
          if (readFileFn) {
            content = await readFileFn(skillPath);
          } else {
            const { readFile } = await import('node:fs/promises');
            content = await readFile(skillPath, 'utf8');
          }
        } catch {
          continue; // No SKILL.md in this dir
        }

        const meta = parseFrontmatter(content);
        const freshness = this.checkFreshness(meta);

        results.push({
          ...freshness,
          version: meta.version ?? null,
          path: skillPath,
        });
      }

      return results;
    },

    /**
     * Generate an updated SKILL.md string with today's date as lastVerified.
     * Does NOT write to disk — returns new content string (immutable).
     *
     * @param {string} content - Original SKILL.md content
     * @returns {string} Updated content
     */
    markVerified(content) {
      const today = nowFn().toISOString().slice(0, 10);
      return updateLastVerified(content, today);
    },

    /**
     * Generate a freshness report from scan results.
     *
     * @param {Array<{ status: string, skill: string, daysSinceVerified: number|null, version: string|null, path: string }>} results
     * @returns {{ total: number, fresh: number, warning: number, stale: number, unknown: number, staleSkills: string[], warningSkills: string[] }}
     */
    generateReport(results) {
      const counts = { fresh: 0, warning: 0, stale: 0, unknown: 0 };
      const staleSkills = [];
      const warningSkills = [];

      for (const r of results) {
        counts[r.status] = (counts[r.status] || 0) + 1;
        if (r.status === 'stale') staleSkills.push(r.skill);
        if (r.status === 'warning') warningSkills.push(r.skill);
      }

      return {
        total: results.length,
        ...counts,
        staleSkills,
        warningSkills,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Exports for testing
// ---------------------------------------------------------------------------

export {
  parseDate as _parseDate,
  daysBetween as _daysBetween,
  parseFrontmatter as _parseFrontmatter,
  updateLastVerified as _updateLastVerified,
};
