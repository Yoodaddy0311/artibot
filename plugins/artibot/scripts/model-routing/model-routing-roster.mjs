/**
 * Agent roster discovery and `show` rendering for `model-routing.mjs`.
 *
 * WHAT LIVES HERE. Reading the two agent rosters (frontmatter `model:` per
 * agent), locating the artibot-cowork roster, and turning `show` rows into the
 * text table or the JSON document. Every function takes explicit paths or data
 * and returns a value: no process, argv, exit code or stdout/stderr here, and no
 * main entry. Argument parsing, subcommand dispatch, resolving, diffing, file
 * writes and exit codes stay in `model-routing.mjs`.
 *
 * ARTIBOT-COWORK ROSTER DISCOVERY (first hit wins, never guessed)
 *   --cowork-root <dir>/agents, else the dev tree `<pluginRoot>/../artibot-cowork/agents`,
 *   else the plugin cache `<pluginRoot>/../../artibot-cowork/<highest semver>/agents`.
 *   None of them → null, which the CLI reports as `unavailable:roster-not-found`.
 *
 * @module scripts/model-routing/model-routing-roster
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { listTiers } from '../../lib/core/model-catalog.js';
import { extractFrontmatter } from '../ci/ci-utils.js';

/** Files under agents/ that are catalogs, not agent definitions. */
const NON_AGENT_FILES = new Set(['INDEX.md', 'README.md']);

/**
 * @param {string} dir
 * @returns {boolean}
 */
export function isDirectory(dir) {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * One agent file's frontmatter `model:` exactly as the roster reads it. A
 * leading BOM and one MATCHED pair of surrounding quotes are stripped — nothing
 * else: a trailing `# comment` or an unbalanced quote stays in `raw` and makes
 * `tier` null. `tests/firewall/cowork-model-frontmatter.test.js` judges with this
 * function, so the gate cannot pass a value this reader reads as unknown.
 *
 * @param {string} text - the whole agent file.
 * @returns {{ raw: string|null, tier: string|null }} `raw` is null when there is
 *   no inline `model:` value; `tier` is null unless `raw` is a catalog tier.
 */
export function readFrontmatterModel(text) {
  const fm = extractFrontmatter(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  const raw = fm && typeof fm.model === 'string' ? fm.model.trim().replace(/^(["'])(.*)\1$/, '$2') : null;
  return { raw, tier: listTiers().includes(raw) ? raw : null };
}

/**
 * Agent name → frontmatter `model:` for one `agents/` directory, read by
 * {@link readFrontmatterModel}; anything that is not a catalog tier (absent,
 * `inherit`, a typo, a trailing comment) is null — unknown, never guessed.
 *
 * @param {string} agentsDir
 * @returns {Map<string, string|null>}
 */
export function readRoster(agentsDir) {
  const roster = new Map();
  const files = readdirSync(agentsDir)
    .filter((f) => f.endsWith('.md') && !NON_AGENT_FILES.has(f))
    .sort();
  for (const file of files) {
    const { tier } = readFrontmatterModel(readFileSync(path.join(agentsDir, file), 'utf8'));
    roster.set(path.basename(file, '.md'), tier);
  }
  return roster;
}

/**
 * Numeric compare of two `x.y.z` version directory names.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function compareSemver(a, b) {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10));
  const pb = b.split('.').map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

/**
 * Locate the artibot-cowork `agents/` directory (see the module header for the
 * order). Returns null when none exists — the caller reports that, never guesses.
 *
 * @param {string} pluginRoot
 * @param {string|undefined} coworkRoot - Explicit `--cowork-root`, exclusive when given.
 * @returns {string|null}
 */
export function findCoworkAgentsDir(pluginRoot, coworkRoot) {
  if (coworkRoot) {
    const dir = path.join(path.resolve(coworkRoot), 'agents');
    return isDirectory(dir) ? dir : null;
  }
  const devTree = path.join(pluginRoot, '..', 'artibot-cowork', 'agents');
  if (isDirectory(devTree)) return path.resolve(devTree);
  const cacheBase = path.join(pluginRoot, '..', '..', 'artibot-cowork');
  if (!isDirectory(cacheBase)) return null;
  const versions = readdirSync(cacheBase)
    .filter((v) => /^\d+\.\d+\.\d+$/.test(v) && isDirectory(path.join(cacheBase, v, 'agents')))
    .sort(compareSemver);
  if (versions.length === 0) return null;
  return path.resolve(cacheBase, versions[versions.length - 1], 'agents');
}

/**
 * Both rosters, keyed by plugin name. A roster that cannot be found is null.
 *
 * @param {string} pluginRoot - Absolute artibot plugin root.
 * @param {string|undefined} coworkRoot - Explicit `--cowork-root`, if any.
 * @returns {{ artibot: Map<string, string|null>|null, 'artibot-cowork': Map<string, string|null>|null }}
 */
export function loadRosters(pluginRoot, coworkRoot) {
  const artibotDir = path.join(pluginRoot, 'agents');
  const coworkDir = findCoworkAgentsDir(pluginRoot, coworkRoot);
  return {
    artibot: isDirectory(artibotDir) ? readRoster(artibotDir) : null,
    'artibot-cowork': coworkDir ? readRoster(coworkDir) : null,
  };
}

/**
 * Plain-text table, column-aligned.
 *
 * @param {string[]} header
 * @param {string[][]} body
 * @returns {string}
 */
export function renderTable(header, body) {
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((r) => r[i].length)));
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
  return [line(header), line(widths.map((w) => '-'.repeat(w))), ...body.map(line)].join('\n');
}

/**
 * Table cells for one row. Every model column may be null (a tierless cowork
 * agent resolves to nothing) and renders `(unknown)`, never a crash.
 *
 * @param {object} row
 * @returns {string[]}
 */
export function rowCells(row) {
  const why = row.reason ? `${row.source}/${row.reason}` : row.source;
  return [
    row.plugin,
    row.agent,
    row.frontmatter ?? '(unknown)',
    row.shipped ?? '(unknown)',
    row.override ?? '—',
    `${row.effective ?? '(unknown)'} [${why}]`,
    row.hostPath,
  ];
}

/**
 * `show --json` output. The view's key order is the document's key order.
 *
 * @param {{ file: string, overridesStatus: string, role: string|null, plugins: object, phases: object[] }} view
 * @returns {string} The document plus a trailing newline.
 */
export function renderShowJson(view) {
  return `${JSON.stringify(view, null, 2)}\n`;
}

/**
 * `show` text output: header line, one table row per agent in plugin order, an
 * `unavailable:` note per missing roster, the artibot phase-role line and the
 * needs-spawn-param footnote.
 *
 * @param {{ file: string, overridesStatus: string, role: string|null, plugins: object, phases: object[] }} view
 * @returns {string} The text plus a trailing newline.
 */
export function renderShowText(view) {
  const { file, overridesStatus, role, plugins, phases } = view;
  const header = ['plugin', 'agent', 'frontmatter', 'shipped', 'override', 'effective', 'host path'];
  const body = [];
  const notes = [];
  for (const [plugin, entry] of Object.entries(plugins)) {
    if (entry.status === 'ok') body.push(...entry.rows.map(rowCells));
    else notes.push(`${plugin}: unavailable:${entry.reason}`);
  }
  const lines = [
    `overrides: ${file} (${overridesStatus})${role ? ` · role=${role}` : ''}`,
    renderTable(header, body),
    ...notes,
    'phase roles (artibot): ' +
      phases.map((p) => `${p.phase}=${p.shipped}${p.override ? ` → user ${p.override}` : ''}`).join(' · '),
    'needs-spawn-param = the value takes effect only if the leader spawns with Agent(model=<resolve output>).',
  ];
  return `${lines.join('\n')}\n`;
}
