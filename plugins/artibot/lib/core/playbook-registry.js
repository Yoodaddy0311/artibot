/**
 * Playbook Registry for Artibot.
 * Manages discovery, storage, and retrieval of system and user playbooks.
 *
 * System playbooks: loaded from artibot.config.json playbooks section.
 * User playbooks: stored in ~/.claude/artibot/playbooks/ directory.
 *
 * Zero runtime dependencies. ESM only.
 * @module lib/core/playbook-registry
 */

import path from 'node:path';
import { ensureDir, listFiles, readJsonFile, writeJsonFile } from './file.js';
import { getHomeDir } from './platform.js';
import { KNOWN_PATTERNS, parsePlaybook, validatePlaybook } from './playbook-parser.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default directory for user-saved playbooks */
const USER_PLAYBOOKS_DIR = path.join(getHomeDir(), '.claude', 'artibot', 'playbooks');

/** Domain detection map: keyword → domain */
const DOMAIN_KEYWORDS = {
  development: ['feature', 'bugfix', 'refactor', 'build', 'release', 'hotfix'],
  marketing: ['marketing', 'content', 'competitive', 'campaign', 'launch', 'seo', 'ad'],
  security: ['security', 'audit', 'pentest', 'vuln', 'threat'],
  quality: ['quality', 'test', 'qa', 'review', 'lint'],
};

// ---------------------------------------------------------------------------
// Types (JSDoc only)
// ---------------------------------------------------------------------------

/**
 * @typedef {object} PlaybookInfo
 * @property {string} name - Playbook identifier
 * @property {string} description - Human-readable description
 * @property {'system'|'user'} source - Where the playbook was loaded from
 * @property {string} domain - Inferred domain ('development'|'marketing'|'security'|'quality'|'general')
 * @property {import('./playbook-parser.js').PlaybookPhase[]} phases - Parsed phases
 * @property {number} phaseCount - Number of phases
 * @property {string[]} patterns - Unique patterns used in phases
 * @property {string[]} tags - Inferred tags for the playbook
 */

/**
 * @typedef {{ valid: boolean, errors: string[] }} ValidationResult
 */

// ---------------------------------------------------------------------------
// Domain & Tag helpers
// ---------------------------------------------------------------------------

/**
 * Infer domain from playbook name and phase actions.
 *
 * @param {string} name - Playbook name
 * @param {import('./playbook-parser.js').PlaybookPhase[]} phases - Parsed phases
 * @returns {string} Domain string
 */
function inferDomain(name, phases) {
  const lower = name.toLowerCase();
  const actionStr = phases.map((p) => p.action).join(' ');
  const searchStr = `${lower} ${actionStr}`;

  for (const [domain, keywords] of Object.entries(DOMAIN_KEYWORDS)) {
    if (keywords.some((kw) => searchStr.includes(kw))) {
      return domain;
    }
  }
  return 'general';
}

/**
 * Generate tags from playbook name and actions.
 *
 * @param {string} name - Playbook name
 * @param {import('./playbook-parser.js').PlaybookPhase[]} phases - Parsed phases
 * @returns {string[]} Tag array
 */
function buildTags(name, phases) {
  const tags = new Set();
  // Add name parts (split by dash/underscore)
  for (const part of name.split(/[-_]/)) {
    if (part) tags.add(part);
  }
  // Add unique actions
  for (const phase of phases) {
    if (phase.action) tags.add(phase.action);
  }
  return [...tags];
}

/**
 * Build a PlaybookInfo object from raw data.
 *
 * @param {string} name - Playbook name
 * @param {string|object} raw - Raw playbook string or object
 * @param {'system'|'user'} source - Source of the playbook
 * @param {object} [meta] - Optional metadata from playbookMeta section
 * @returns {PlaybookInfo}
 */
function buildPlaybookInfo(name, raw, source, meta = {}) {
  const parsed = parsePlaybook(raw);
  const phases = parsed.phases;
  const uniquePatterns = [...new Set(phases.map((p) => p.pattern).filter(Boolean))];

  return {
    name,
    description: meta.description || '',
    source,
    domain: meta.domain || inferDomain(name, phases),
    phases,
    phaseCount: phases.length,
    patterns: uniquePatterns,
    tags: meta.tags || buildTags(name, phases),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load system playbooks from artibot.config.json.
 *
 * @param {string} configPath - Absolute path to artibot.config.json
 * @returns {Promise<Map<string, PlaybookInfo>>} Map of playbook name → PlaybookInfo
 * @example
 * const map = await loadSystemPlaybooks('/path/to/artibot.config.json');
 * map.get('feature'); // { name: 'feature', phases: [...], ... }
 */
export async function loadSystemPlaybooks(configPath) {
  const result = new Map();

  const config = await readJsonFile(configPath);
  if (!config) return result;

  const playbooks = config?.team?.playbooks;
  if (!playbooks || typeof playbooks !== 'object') return result;

  const meta = config?.team?.playbookMeta ?? {};

  for (const [name, raw] of Object.entries(playbooks)) {
    const info = buildPlaybookInfo(name, raw, 'system', meta[name] ?? {});
    result.set(name, info);
  }

  return result;
}

/**
 * Load user-defined playbooks from the user playbooks directory.
 *
 * @param {string} [userDir] - Directory to load from (defaults to ~/.claude/artibot/playbooks/)
 * @returns {Promise<Map<string, PlaybookInfo>>} Map of playbook name → PlaybookInfo
 * @example
 * const map = await loadUserPlaybooks();
 * map.get('my-workflow'); // { name: 'my-workflow', source: 'user', ... }
 */
export async function loadUserPlaybooks(userDir = USER_PLAYBOOKS_DIR) {
  const result = new Map();

  const files = await listFiles(userDir, '.json');

  for (const filePath of files) {
    const data = await readJsonFile(filePath);
    if (!data) continue;

    const name = data.name || path.basename(filePath, '.json');
    const raw = data.playbookString || data;
    const info = buildPlaybookInfo(name, raw, 'user', {
      description: data.description,
      domain: data.domain,
      tags: data.tags,
    });
    result.set(name, info);
  }

  return result;
}

/**
 * Save a user-defined playbook to disk.
 *
 * @param {string} name - Playbook name (used as filename)
 * @param {import('./playbook-parser.js').Playbook|string} playbook - Playbook object or string
 * @param {string} [userDir] - Directory to save to (defaults to ~/.claude/artibot/playbooks/)
 * @returns {Promise<{ saved: boolean, error?: string }>}
 * @example
 * await saveUserPlaybook('my-flow', '[leader] plan -> [swarm] implement');
 * // { saved: true }
 */
export async function saveUserPlaybook(name, playbook, userDir = USER_PLAYBOOKS_DIR) {
  if (!name || typeof name !== 'string') {
    return { saved: false, error: 'Name must be a non-empty string' };
  }

  const parsed = typeof playbook === 'string' ? parsePlaybook(playbook) : playbook;

  const validation = validatePlaybook(parsed);
  if (!validation.valid) {
    return { saved: false, error: validation.errors.join('; ') };
  }

  await ensureDir(userDir);

  const safeName = name.replace(/[^a-zA-Z0-9-_]/g, '-');
  const filePath = path.join(userDir, `${safeName}.json`);

  await writeJsonFile(filePath, {
    name,
    phases: parsed.phases,
  });

  return { saved: true };
}

/**
 * List playbooks with optional filtering.
 *
 * @param {object} [options] - Filter options
 * @param {string} [options.domain] - Filter by domain
 * @param {'system'|'user'} [options.source] - Filter by source
 * @param {string} [options.configPath] - Config path for system playbooks
 * @param {string} [options.userDir] - User dir for user playbooks
 * @returns {Promise<PlaybookInfo[]>} Filtered and sorted list of playbooks
 * @example
 * const list = await listPlaybooks({ domain: 'development' });
 * // [{ name: 'feature', domain: 'development', ... }, ...]
 */
export async function listPlaybooks(options = {}) {
  const { domain, source, configPath, userDir } = options;

  const all = new Map();

  if (!source || source === 'system') {
    const systemPath = configPath ?? path.join(
      new URL('..', new URL('..', import.meta.url)).pathname.replace(/^\/([A-Z]:)/i, '$1'),
      'artibot.config.json',
    );
    const systemMap = await loadSystemPlaybooks(systemPath);
    for (const [k, v] of systemMap) all.set(k, v);
  }

  if (!source || source === 'user') {
    const userMap = await loadUserPlaybooks(userDir ?? USER_PLAYBOOKS_DIR);
    for (const [k, v] of userMap) all.set(k, v);
  }

  let list = [...all.values()];

  if (domain) {
    list = list.filter((pb) => pb.domain === domain);
  }

  return list.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Get a single playbook by name.
 *
 * @param {string} name - Playbook name to look up
 * @param {object} [options] - Options
 * @param {string} [options.configPath] - Config path for system playbooks
 * @param {string} [options.userDir] - User dir for user playbooks
 * @returns {Promise<PlaybookInfo|null>} Playbook or null if not found
 * @example
 * const pb = await getPlaybook('feature');
 * pb?.phases[0]; // { order: 0, pattern: 'leader', action: 'plan', label: 'plan' }
 */
export async function getPlaybook(name, options = {}) {
  if (!name || typeof name !== 'string') return null;

  const list = await listPlaybooks(options);
  return list.find((pb) => pb.name === name) ?? null;
}

// ---------------------------------------------------------------------------
// Exported constants
// ---------------------------------------------------------------------------

export { USER_PLAYBOOKS_DIR, KNOWN_PATTERNS };
