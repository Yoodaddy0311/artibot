/**
 * Rules digest — a small stand-in for the rules a marketplace install cannot load.
 *
 * ── The gap ───────────────────────────────────────────────────────────────
 * `plugin.json#rules` is not read by the host, so a project that got Artibot
 * through the marketplace alone runs with ZERO of `rules/*.md`: the rules only
 * reach a session when `install.sh` / `install.ps1` copy them into
 * `~/.claude/rules/artibot/`. This module builds the text a SessionStart hook
 * injects in that one case, so the model at least knows the rules exist, what
 * each says in a line, and where the full text is.
 *
 * ── Why a module and not `rules/_digest.md` ───────────────────────────────
 * Both installers copy EVERY `rules/*.md` into `~/.claude/rules/artibot/`, where
 * it would be loaded as an always-on rule — the digest would double-load next to
 * the rules it summarises — and `marketplace.json#entryPoints.rules.count` is
 * pinned to the number of `rules/*.md` files. A file under `rules/` is the wrong
 * place for something that must NOT be a rule.
 *
 * ── Shape and cap ─────────────────────────────────────────────────────────
 * One header line, one `- <rule>: <core line>` per rule file, and the ABSOLUTE
 * rules directory stated once (per-rule absolute paths would not fit the cap).
 * {@link DIGEST_MAX_BYTES} is a UTF-8 BYTE cap — the install path may hold
 * non-ASCII — and is met by dropping the lowest-priority lines, never by cutting
 * a line in half. If even the header does not fit, there is no digest.
 *
 * ── Drift ─────────────────────────────────────────────────────────────────
 * {@link RULE_SUMMARIES} is curated by hand, and its KEYS must equal the set of
 * `rules/*.md` files: `tests/rules/rules-digest.test.js` fails when a rule file
 * is added or removed without touching this table. At run time a rule file that
 * has no summary is still listed (name and path), and a summary whose file is
 * gone is omitted, so a stale table degrades to a less informative digest, never
 * to a pointer at a missing file. What no gate can see: whether a summary still
 * says what its rule says.
 *
 * Layer: L2. Reads the file system and nothing else.
 *
 * @module lib/project-state/rules-digest
 */

import fs from 'node:fs';
import path from 'node:path';

/** Hard ceiling on the digest, in UTF-8 bytes. */
export const DIGEST_MAX_BYTES = 1500;

/**
 * One core line per rule file, keyed by file name without `.md`. Insertion order
 * IS the priority order: the always-on rules first (no `paths:` frontmatter),
 * the path-scoped domain rules last, because they are the first to go when a long
 * install path squeezes the cap.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const RULE_SUMMARIES = Object.freeze({
  'verification-discipline':
    'Verify before asserting; label claims measured/inferred/unverified; search the whole repo before saying "none".',
  'dev-protocol':
    'Decompose into numbered items; read, change, re-read each; report with file:line evidence.',
  'agent-coordination':
    'Delegate complex work to specialist agents; parallelize independent tasks; "done" needs proof.',
  'quality-gates':
    'Read before write, re-read after; report every request item with evidence.',
  'question-recommendations':
    'In AskUserQuestion put the recommended option first; its label ends " (Recommended)" (Korean: " (권장)").',
  'clean-state':
    'At task completion: lint clean, related tests pass, no debug leftovers.',
  'config-safety':
    'Read a config fully before editing; validate JSON/YAML after; never commit secrets.',
  'test-patterns':
    'TDD red-green-refactor; behavior-named tests; mock external I/O only.',
  'backend-patterns':
    'Validate input at boundaries; parameterized SQL; structured errors; no secrets in code.',
  'frontend-patterns':
    'Functional components; WCAG 2.1 AA; mobile-first; design tokens.',
});

/** Line used for a rule file that has no curated summary yet. */
const FALLBACK_SUMMARY = 'see the file.';

/**
 * The user-level rules directory the installers fill and the host loads.
 *
 * @param {string} homeDir - The user's home directory.
 * @returns {string} `<home>/.claude/rules/artibot`.
 */
export function userRulesDir(homeDir) {
  return path.join(homeDir, '.claude', 'rules', 'artibot');
}

/**
 * True when Artibot's rules are installed where the host loads them.
 *
 * "Installed" means the directory exists AND holds at least one `.md` file. An
 * empty directory is not: `install.sh` makes it before copying, so a copy that
 * died halfway leaves exactly that, and it loads nothing.
 *
 * @param {string} homeDir - The user's home directory.
 * @returns {boolean} `false` for an absent, unreadable or empty directory.
 */
export function hasInstalledUserRules(homeDir) {
  if (typeof homeDir !== 'string' || homeDir === '') return false;
  try {
    return fs.readdirSync(userRulesDir(homeDir)).some((name) => name.endsWith('.md'));
  } catch {
    return false;
  }
}

/**
 * Rule names present in a rules directory: `*.md` files directly inside it.
 * Sub-directories (`csv/` holds lookup tables consumed BY rules) are not rules.
 *
 * @param {string} rulesDir - Absolute path of a `rules/` directory.
 * @returns {string[]} Sorted names without the `.md` suffix; `[]` when unreadable.
 */
export function listRuleNames(rulesDir) {
  try {
    return fs.readdirSync(rulesDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => entry.name.slice(0, -'.md'.length))
      .sort();
  } catch {
    return [];
  }
}

/** UTF-8 byte length. */
function byteLength(text) {
  return Buffer.byteLength(text, 'utf8');
}

/** The header: why this text exists, and the one place the full rules live. */
function headerLine(rulesDir) {
  return '[artibot:rules] Artibot rules are not installed (~/.claude/rules/artibot/ has no rule files and '
    + 'the plugin "rules" field is not auto-loaded); apply this digest. '
    + `Full text: ${path.join(rulesDir, '<name>.md')} - read on demand.`;
}

/**
 * Join header, rule lines and — when lines were dropped — a count, keeping the
 * longest prefix of rule lines that fits `maxBytes`.
 *
 * @param {string} header - Header line.
 * @param {string[]} lines - Rule lines in priority order.
 * @param {number} maxBytes - UTF-8 byte ceiling.
 * @returns {string|null} The digest, or `null` when not even the header fits.
 */
function fitToCap(header, lines, maxBytes) {
  for (let keep = lines.length; keep >= 0; keep -= 1) {
    const dropped = lines.length - keep;
    const parts = [header, ...lines.slice(0, keep)];
    if (dropped > 0) parts.push(`(+${dropped} more rule files in that directory)`);
    const text = parts.join('\n');
    if (byteLength(text) <= maxBytes) return text;
  }
  return null;
}

/**
 * Build the digest for a plugin root.
 *
 * @param {object} [params] - Inputs.
 * @param {string} [params.pluginRoot] - Absolute plugin root; `rules/` under it is read.
 * @param {number} [params.maxBytes] - UTF-8 byte ceiling; defaults to {@link DIGEST_MAX_BYTES}.
 * @returns {string|null} The digest text, or `null` when there are no rule files to
 *   point at or the cap cannot be met.
 */
export function buildRulesDigest({ pluginRoot, maxBytes = DIGEST_MAX_BYTES } = {}) {
  if (typeof pluginRoot !== 'string' || pluginRoot === '') return null;

  const rulesDir = path.join(pluginRoot, 'rules');
  const onDisk = listRuleNames(rulesDir);
  if (onDisk.length === 0) return null;

  const curated = Object.keys(RULE_SUMMARIES).filter((name) => onDisk.includes(name));
  const uncurated = onDisk.filter((name) => !Object.hasOwn(RULE_SUMMARIES, name));
  const lines = [...curated, ...uncurated].map(
    (name) => `- ${name}: ${Object.hasOwn(RULE_SUMMARIES, name) ? RULE_SUMMARIES[name] : FALLBACK_SUMMARY}`,
  );

  return fitToCap(headerLine(rulesDir), lines, maxBytes);
}
