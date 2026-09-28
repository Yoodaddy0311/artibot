/**
 * N3 — the artibot-cowork agent roster and its frontmatter `model:` values.
 *
 * WHY THIS GATE EXISTS. `artibot-cowork` has no resolver, config or hooks
 * (`scripts/validate.js` header: "Cross-plugin model policy needs its own
 * roster before it can be gated"). Its agents' frontmatter `model:` IS the
 * shipped routing: the host spawns on it, and
 * `lib/core/model-overrides.js#resolveEffectiveModel` answers every
 * `artibot-cowork:<name>` from the frontmatter map the caller injects (source
 * `cowork-frontmatter`). A value outside the tier vocabulary reads there as
 * unset (`cowork-frontmatter-unknown`), so the only place a bad value can be
 * caught before a spawn is here. This is that separate roster.
 *
 * THE ROSTER IS PINNED BY NAME (fail-closed): adding, removing or renaming a
 * cowork agent turns this RED until the list below is updated on purpose.
 *
 * ALLOWED VALUES: `haiku | sonnet | opus` — an allowlist, so any other word,
 * a model id, a role alias, a capitalized tier or a missing line is RED.
 * `fable` is deliberately OUT: fable is opt-in behind the core plugin's gate
 * (`agents.modelPolicy.fable.allowlist`), which names core agents only, and
 * `model-overrides.js#applyGates` therefore demotes any cowork fable pick to
 * opus with reason `fable-gate`. A cowork frontmatter `model: fable` would make
 * the host serve fable while Artibot computes opus — a built-in disagreement
 * with no gate that could ever lift it.
 *
 * ── WHAT THIS GATE CANNOT SEE (repo rules §9) ──────────────────────────────
 *  1. WHAT THE HOST SERVES. It reads source text. Whether the host honours the
 *     frontmatter (or an `Agent(model=…)` parameter over it) is
 *     `model-routing validate --live`'s question (`lib/replay/routing-honor.js`).
 *  2. THE INSTALLED COPY. It reads the repo tree, not the plugin cache or the
 *     packed `.plugin` (that drift is `cowork-plugin-zip-drift.test.js`).
 *  3. WHICH TIER IS RIGHT. It pins the vocabulary and the names, not each
 *     agent's value; moving an agent from sonnet to opus stays green.
 *  4. YAML IN GENERAL. The scanner requires exactly one top-level `model:` line
 *     in the leading `---` block and then judges its VALUE with the consumer's
 *     own reader, `scripts/model-routing/model-routing-roster.mjs#readFrontmatterModel`
 *     (one matched quote pair stripped, nothing else). A trailing `# comment`
 *     or an unbalanced quote is therefore RED even though a YAML parser might
 *     accept it: that reader reads it as unknown, and a gate looser than its
 *     consumer would be green while `show` prints `(unknown)` and
 *     `validate --live` marks the agent `expected-not-a-tier`. A multi-line or
 *     anchored YAML value is reported as not-a-tier, never interpreted.
 *
 * @module tests/firewall/cowork-model-frontmatter
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFrontmatterModel, readRoster } from '../../scripts/model-routing/model-routing-roster.mjs';
import { splitFrontmatter, stripComment } from './frontmatter-tools.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COWORK_AGENTS = join(__dirname, '..', '..', '..', 'artibot-cowork', 'agents');

/** The pinned roster (12, measured 2026-09-23: sonnet 9 · opus 3). */
const COWORK_ROSTER = Object.freeze([
  'ad-specialist',
  'case-study-writer',
  'content-marketer',
  'cro-specialist',
  'data-analyst',
  'doc-updater',
  'long-form-writer',
  'marketing-strategist',
  'orchestrator',
  'planner',
  'presentation-designer',
  'seo-specialist',
]);

/** Tier words a cowork frontmatter may carry (allowlist; `fable` excluded — see header). */
const COWORK_TIERS = Object.freeze(['haiku', 'sonnet', 'opus']);

/**
 * Read the `model:` and `name:` of one agent file.
 *
 * @param {string} text - the whole agent file.
 * @returns {{ ok: true, model: string, name: string|null } | { ok: false, reason: string }}
 */
function scanAgent(text) {
  const split = splitFrontmatter(text);
  if (split === null) return { ok: false, reason: 'no-frontmatter' };
  const lines = split.block.split(/\r?\n/);
  const models = lines.filter((l) => /^model:/.test(l));
  if (models.length === 0) return { ok: false, reason: 'no-model-line' };
  if (models.length > 1) return { ok: false, reason: 'duplicate-model-line' };
  // The consumer's reader, not a local strip: see header item 4.
  const { raw, tier: value } = readFrontmatterModel(text);
  if (!COWORK_TIERS.includes(value)) return { ok: false, reason: `not-a-tier:${JSON.stringify(raw ?? '')}` };
  const nameLine = lines.find((l) => /^name:/.test(l));
  return { ok: true, model: value, name: nameLine ? stripComment(nameLine.slice('name:'.length)) : null };
}

/** Agent file stems on disk, sorted. */
function agentStems() {
  return readdirSync(COWORK_AGENTS)
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.slice(0, -'.md'.length))
    .sort();
}

describe('artibot-cowork agent roster (N3, fail-closed)', () => {
  it('the agents directory exists (a missing tree is RED, not "zero violations")', () => {
    expect(existsSync(COWORK_AGENTS)).toBe(true);
  });

  it('the files on disk are exactly the pinned 12', () => {
    expect(agentStems()).toEqual([...COWORK_ROSTER]);
  });

  it.each(COWORK_ROSTER.map((n) => [n]))('%s: frontmatter model is a tier word and name matches the file', (stem) => {
    const scan = scanAgent(readFileSync(join(COWORK_AGENTS, `${stem}.md`), 'utf-8'));
    expect(scan, JSON.stringify(scan)).toMatchObject({ ok: true });
    expect(COWORK_TIERS).toContain(scan.model);
    expect(scan.name).toBe(stem);
  });

  it('the consumer reads the same tier the gate passed, for every agent', () => {
    const roster = readRoster(COWORK_AGENTS);
    for (const stem of COWORK_ROSTER) {
      const scan = scanAgent(readFileSync(join(COWORK_AGENTS, `${stem}.md`), 'utf-8'));
      expect(roster.get(stem), stem).toBe(scan.model);
    }
  });
});

describe('scanner self-check (a gate that cannot fail proves nothing)', () => {
  const doc = (block) => `---\n${block}\n---\n\nbody\n`;

  it.each([
    ['a model id', doc('name: x\nmodel: claude-opus-5-5'), 'not-a-tier:"claude-opus-5-5"'],
    ['fable', doc('name: x\nmodel: fable'), 'not-a-tier:"fable"'],
    ['a capitalized tier', doc('name: x\nmodel: Sonnet'), 'not-a-tier:"Sonnet"'],
    ['a role alias', doc('name: x\nmodel: frontier'), 'not-a-tier:"frontier"'],
    ['an empty value', doc('name: x\nmodel:'), 'not-a-tier:""'],
    ['a missing model line', doc('name: x\ntools: Read'), 'no-model-line'],
    ['two model lines', doc('name: x\nmodel: opus\nmodel: sonnet'), 'duplicate-model-line'],
    ['no frontmatter', 'name: x\nmodel: opus\n', 'no-frontmatter'],
    ['a trailing comment', doc('name: x\nmodel: sonnet  # shipped'), 'not-a-tier:"sonnet  # shipped"'],
    ['a quoted value with a trailing comment', doc('name: x\nmodel: "sonnet"  # x'), 'not-a-tier:"\\"sonnet\\"  # x"'],
    ['an unbalanced quote', doc('name: x\nmodel: "sonnet'), 'not-a-tier:"\\"sonnet"'],
    ['mismatched quotes', doc('name: x\nmodel: "sonnet\''), 'not-a-tier:"\\"sonnet\'"'],
  ])('detects %s', (_label, text, reason) => {
    expect(scanAgent(text)).toEqual({ ok: false, reason });
  });

  it('a model: line in the BODY does not count', () => {
    expect(scanAgent(`${doc('name: x')}model: opus\n`)).toEqual({ ok: false, reason: 'no-model-line' });
  });

  it('accepts CRLF and one matched pair of quotes (what the consumer reader accepts)', () => {
    expect(scanAgent('---\r\nname: x\r\nmodel: "sonnet"\r\n---\r\n')).toEqual({ ok: true, model: 'sonnet', name: 'x' });
    expect(scanAgent(doc("name: x\nmodel: 'opus'"))).toEqual({ ok: true, model: 'opus', name: 'x' });
  });

  it('every value the scanner rejects, the consumer reads as unknown (no looser-than-consumer gap)', () => {
    for (const value of ['sonnet  # shipped', '"sonnet', 'Sonnet', 'fable', 'claude-sonnet-5']) {
      const text = doc(`name: x\nmodel: ${value}`);
      expect(scanAgent(text).ok, value).toBe(false);
      if (value !== 'fable') expect(readFrontmatterModel(text).tier, value).toBeNull();
    }
  });
});
