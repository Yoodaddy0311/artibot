/**
 * lib/project-state/rules-digest.js — the ≤1,500-byte stand-in for the rules a
 * marketplace install cannot load (`plugin.json#rules` is not read by the host).
 *
 * What is pinned here:
 *   - WHEN it is injected: only when `~/.claude/rules/artibot/` holds no rules.
 *     The "home" is a temp directory handed in as `homeDir`; the USERPROFILE/HOME
 *     seam the hooks really use is exercised by the spawned hook test.
 *   - The CAP: a UTF-8 BYTE ceiling, met by dropping whole trailing lines, and
 *     `null` when even the header cannot fit.
 *   - The SYNC: the curated table must name exactly the `rules/*.md` files (and
 *     the `plugin.json` manifest), so adding or removing a rule file is red
 *     until the digest is told.
 *
 * WHAT THIS FILE DOES NOT SEE: whether a curated line still says what its rule
 * says (only a person can judge that), and how the host displays
 * `additionalContext` — the digest's size is asserted, its reception is not.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { runProjectBootstrap } from '../../lib/project-state/project-bootstrap.js';
import {
  buildRulesDigest,
  DIGEST_MAX_BYTES,
  hasInstalledUserRules,
  listRuleNames,
  RULE_SUMMARIES,
  userRulesDir,
} from '../../lib/project-state/rules-digest.js';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REAL_RULES_DIR = path.join(PLUGIN_ROOT, 'rules');

const bytes = (text) => Buffer.byteLength(text, 'utf8');

/** Everything made during a test, removed in afterEach. */
const made = [];

afterEach(() => {
  while (made.length) fs.rmSync(made.pop(), { recursive: true, force: true });
});

/** @returns {string} A fresh temp directory, registered for cleanup. */
function tmp(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `artibot-digest-${tag}-`));
  made.push(dir);
  return dir;
}

/** A plugin root holding stub rule files with the given names, under `root`. */
function makeRoot(names, root = tmp('root')) {
  fs.mkdirSync(path.join(root, 'rules'), { recursive: true });
  for (const name of names) fs.writeFileSync(path.join(root, 'rules', `${name}.md`), `# ${name}\n`);
  return root;
}

/** A fake home; `rules` are file names to place under `.claude/rules/artibot/`, or null for no such directory. */
function makeHome(rules) {
  const home = tmp('home');
  if (rules !== null) {
    const dir = userRulesDir(home);
    fs.mkdirSync(dir, { recursive: true });
    for (const file of rules) fs.writeFileSync(path.join(dir, file), '# rule\n');
  }
  return home;
}

const REAL_NAMES = listRuleNames(REAL_RULES_DIR);

describe('hasInstalledUserRules — the injection gate', () => {
  it('is false when ~/.claude/rules/artibot/ does not exist', () => {
    expect(hasInstalledUserRules(makeHome(null))).toBe(false);
  });

  it('is true when the directory holds rule files (the owner\'s machine)', () => {
    expect(hasInstalledUserRules(makeHome(['dev-protocol.md']))).toBe(true);
  });

  it('is false for an existing but EMPTY directory — an install that died after mkdir loads nothing', () => {
    expect(hasInstalledUserRules(makeHome([]))).toBe(false);
  });

  it('is false when the only entries are parked copies, not .md files', () => {
    expect(hasInstalledUserRules(makeHome(['dev-protocol.md.artibot-new']))).toBe(false);
  });

  it('is false for a missing home and for a path that is a file', () => {
    expect(hasInstalledUserRules('')).toBe(false);
    expect(hasInstalledUserRules(undefined)).toBe(false);
    const file = path.join(tmp('f'), 'not-a-dir');
    fs.writeFileSync(file, 'x');
    expect(hasInstalledUserRules(file)).toBe(false);
  });

  it('looks under <home>/.claude/rules/artibot', () => {
    expect(userRulesDir('/h')).toBe(path.join('/h', '.claude', 'rules', 'artibot'));
  });
});

describe('listRuleNames', () => {
  it('lists *.md files directly inside, sorted, without the suffix', () => {
    const root = makeRoot(['b-rule', 'a-rule']);
    fs.writeFileSync(path.join(root, 'rules', 'notes.txt'), 'x');
    expect(listRuleNames(path.join(root, 'rules'))).toEqual(['a-rule', 'b-rule']);
  });

  it('does not treat sub-directories as rules, even one named like a file', () => {
    const root = makeRoot(['real']);
    fs.mkdirSync(path.join(root, 'rules', 'csv'));
    fs.writeFileSync(path.join(root, 'rules', 'csv', 'nested.md'), 'x');
    fs.mkdirSync(path.join(root, 'rules', 'dir-named.md'));
    expect(listRuleNames(path.join(root, 'rules'))).toEqual(['real']);
  });

  it('returns [] for a missing directory', () => {
    expect(listRuleNames(path.join(tmp('x'), 'nope'))).toEqual([]);
  });
});

describe('buildRulesDigest — content', () => {
  const digest = buildRulesDigest({ pluginRoot: PLUGIN_ROOT });

  it('builds a digest from the real plugin rules, within the cap', () => {
    expect(typeof digest).toBe('string');
    expect(bytes(digest)).toBeLessThanOrEqual(DIGEST_MAX_BYTES);
    expect(digest.startsWith('[artibot:rules]')).toBe(true);
  });

  it('names the reason and the place the rules would normally be', () => {
    expect(digest).toContain('~/.claude/rules/artibot/');
    expect(digest).toContain('not auto-loaded');
  });

  it('gives the ABSOLUTE rules directory, once, so the full text can be read on demand', () => {
    const at = digest.indexOf('Full text: ');
    expect(at).toBeGreaterThan(0);
    const pointer = digest.slice(at + 'Full text: '.length).split('\n')[0];
    const dir = pointer.slice(0, pointer.indexOf(`${path.sep}<name>.md`));
    expect(path.isAbsolute(dir)).toBe(true);
    expect(dir).toBe(REAL_RULES_DIR);
    expect(digest.split(REAL_RULES_DIR).length - 1).toBe(1);
  });

  it('has one core line for every rule file, in priority order, none cut short', () => {
    const ruleLines = digest.split('\n').filter((l) => l.startsWith('- '));
    expect(ruleLines.map((l) => l.slice(2, l.indexOf(':')))).toEqual(Object.keys(RULE_SUMMARIES));
    for (const line of ruleLines) {
      const name = line.slice(2, line.indexOf(':'));
      expect(line).toBe(`- ${name}: ${RULE_SUMMARIES[name]}`);
    }
  });

  it('puts the always-on rules before the path-scoped domain rules', () => {
    const order = Object.keys(RULE_SUMMARIES);
    const alwaysOn = ['verification-discipline', 'dev-protocol', 'agent-coordination', 'quality-gates', 'question-recommendations'];
    for (const name of alwaysOn) {
      for (const scoped of ['backend-patterns', 'frontend-patterns', 'test-patterns']) {
        expect(order.indexOf(name), `${name} before ${scoped}`).toBeLessThan(order.indexOf(scoped));
      }
    }
  });

  it('keeps every summary to one non-empty line', () => {
    for (const [name, summary] of Object.entries(RULE_SUMMARIES)) {
      expect(summary.length, name).toBeGreaterThan(0);
      expect(summary.includes('\n'), name).toBe(false);
      expect(bytes(summary), name).toBeLessThanOrEqual(140);
    }
  });

  it('is deterministic', () => {
    expect(buildRulesDigest({ pluginRoot: PLUGIN_ROOT })).toBe(digest);
  });
});

describe('buildRulesDigest — the byte cap', () => {
  it('defaults to 1,500 bytes', () => {
    expect(DIGEST_MAX_BYTES).toBe(1500);
  });

  it('keeps every rule at a realistic, long install path (about 100 characters)', () => {
    const base = tmp('base');
    const filler = Math.max(1, 100 - base.length - 1);
    const root = makeRoot(Object.keys(RULE_SUMMARIES), path.join(base, 'p'.repeat(filler)));
    const text = buildRulesDigest({ pluginRoot: root });
    expect(bytes(text)).toBeLessThanOrEqual(DIGEST_MAX_BYTES);
    expect(text.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(Object.keys(RULE_SUMMARIES).length);
    expect(text).not.toContain('more rule files');
  });

  it('never exceeds the cap for any cap: null, or within it', () => {
    for (let cap = 0; cap <= 1700; cap += 25) {
      const text = buildRulesDigest({ pluginRoot: PLUGIN_ROOT, maxBytes: cap });
      if (text !== null) expect(bytes(text), `cap ${cap}`).toBeLessThanOrEqual(cap);
    }
  });

  it('drops only TRAILING lines, states how many, and never cuts a line in half', () => {
    const full = buildRulesDigest({ pluginRoot: PLUGIN_ROOT, maxBytes: 100000 });
    const fullLines = full.split('\n');
    const tight = buildRulesDigest({ pluginRoot: PLUGIN_ROOT, maxBytes: 800 });
    const tightLines = tight.split('\n');

    expect(bytes(tight)).toBeLessThanOrEqual(800);
    const kept = tightLines.filter((l) => l.startsWith('- '));
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(Object.keys(RULE_SUMMARIES).length);
    // The kept lines are an exact prefix of the full list — priority order, whole lines.
    expect(kept).toEqual(fullLines.filter((l) => l.startsWith('- ')).slice(0, kept.length));
    const dropped = Object.keys(RULE_SUMMARIES).length - kept.length;
    expect(tightLines.at(-1)).toBe(`(+${dropped} more rule files in that directory)`);
    expect(kept[0].startsWith('- verification-discipline:')).toBe(true);
  });

  it('squeezes the domain rules out first when the install path is very long', () => {
    const base = tmp('long');
    const root = makeRoot(Object.keys(RULE_SUMMARIES), path.join(base, 'a'.repeat(120), 'b'.repeat(120)));
    const text = buildRulesDigest({ pluginRoot: root });
    expect(bytes(text)).toBeLessThanOrEqual(DIGEST_MAX_BYTES);
    expect(text).toContain('- verification-discipline:');
    expect(text).not.toContain('- frontend-patterns:');
    expect(text).toMatch(/\(\+\d+ more rule files in that directory\)$/);
  });

  it('measures UTF-8 BYTES, not characters — a digest a character cap would accept is cut', () => {
    const base = tmp('utf8');
    const root = makeRoot(Object.keys(RULE_SUMMARIES), path.join(base, '한'.repeat(100)));
    const full = buildRulesDigest({ pluginRoot: root, maxBytes: 100000 });
    // Precondition, asserted so the case cannot pass vacuously: the full text is
    // under 1,500 CHARACTERS and over 1,500 BYTES.
    expect(full.length).toBeLessThanOrEqual(DIGEST_MAX_BYTES);
    expect(bytes(full)).toBeGreaterThan(DIGEST_MAX_BYTES);

    const capped = buildRulesDigest({ pluginRoot: root });
    expect(bytes(capped)).toBeLessThanOrEqual(DIGEST_MAX_BYTES);
    expect(capped).toMatch(/\(\+\d+ more rule files in that directory\)$/);
  });

  it('gives no digest at all when even the header cannot fit', () => {
    const base = tmp('huge');
    const deep = path.join(base, ...Array.from({ length: 16 }, (_, i) => String.fromCharCode(97 + i).repeat(120)));
    // Windows refuses paths this long without long-path support, which is itself
    // the point of the next case; build the root only where the OS allows it.
    let root;
    try {
      root = makeRoot(['dev-protocol'], deep);
    } catch {
      root = null;
    }
    if (root !== null) expect(buildRulesDigest({ pluginRoot: root })).toBeNull();
    // A cap smaller than the header gives the same answer on every platform.
    expect(buildRulesDigest({ pluginRoot: PLUGIN_ROOT, maxBytes: 50 })).toBeNull();
    expect(buildRulesDigest({ pluginRoot: PLUGIN_ROOT, maxBytes: 0 })).toBeNull();
  });
});

describe('buildRulesDigest — what is on disk wins', () => {
  it('lists a rule file that has no curated summary, with a fallback, after the curated ones', () => {
    const root = makeRoot(['dev-protocol', 'zz-brand-new-rule']);
    const text = buildRulesDigest({ pluginRoot: root });
    const lines = text.split('\n').filter((l) => l.startsWith('- '));
    expect(lines).toEqual([
      `- dev-protocol: ${RULE_SUMMARIES['dev-protocol']}`,
      '- zz-brand-new-rule: see the file.',
    ]);
  });

  it('omits a curated summary whose file is gone — never a pointer at a missing file', () => {
    const text = buildRulesDigest({ pluginRoot: makeRoot(['dev-protocol']) });
    expect(text).toContain('- dev-protocol:');
    expect(text).not.toContain('- quality-gates:');
  });

  it('does not read a prototype member as a summary for a file with a prototype-like name', () => {
    const root = makeRoot(['constructor', 'toString', 'hasOwnProperty']);
    const lines = buildRulesDigest({ pluginRoot: root }).split('\n').filter((l) => l.startsWith('- '));
    expect(lines).toEqual([
      '- constructor: see the file.',
      '- hasOwnProperty: see the file.',
      '- toString: see the file.',
    ]);
  });

  it.each([
    ['no rules directory', () => tmp('bare')],
    ['an empty rules directory', () => makeRoot([])],
    ['only non-markdown files', () => { const r = makeRoot([]); fs.writeFileSync(path.join(r, 'rules', 'x.txt'), 'x'); return r; }],
    ['only a sub-directory', () => { const r = makeRoot([]); fs.mkdirSync(path.join(r, 'rules', 'csv')); return r; }],
  ])('gives null for %s — nothing to point at', (_label, make) => {
    expect(buildRulesDigest({ pluginRoot: make() })).toBeNull();
  });

  it('gives null for a missing or non-string plugin root', () => {
    for (const pluginRoot of [undefined, null, '', 7]) expect(buildRulesDigest({ pluginRoot })).toBeNull();
    expect(buildRulesDigest()).toBeNull();
  });
});

describe('digest <-> rules/*.md list sync', () => {
  it('the curated table names exactly the rule files on disk', () => {
    // Add or remove a file under rules/ and this is red until RULE_SUMMARIES says
    // what the new rule is in one line (or drops the old one).
    expect(Object.keys(RULE_SUMMARIES).sort()).toEqual(REAL_NAMES);
  });

  it('and exactly the rules the plugin manifest declares', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
    const declared = manifest.rules.map((file) => path.basename(file, '.md')).sort();
    expect(declared).toEqual(REAL_NAMES);
  });

  it('scans a real rules directory (self-check: a vacuous census would sync empty to empty)', () => {
    expect(REAL_NAMES.length).toBeGreaterThanOrEqual(10);
    expect(REAL_NAMES).toContain('verification-discipline');
    expect(REAL_NAMES).not.toContain('csv');
  });
});

describe('injection decision — dir present vs absent (fake HOME)', () => {
  /** Run the bootstrap over a directory that is not a repository, with a clean env. */
  function bootstrap({ homeDir, config = {}, env = {} }) {
    return runProjectBootstrap({
      payload: { cwd: tmp('proj') }, env, homeDir, pluginRoot: PLUGIN_ROOT, config,
    });
  }

  it('injects the digest when ~/.claude/rules/artibot/ is absent', () => {
    const { additionalContext } = bootstrap({ homeDir: makeHome(null) });
    expect(additionalContext).toBe(buildRulesDigest({ pluginRoot: PLUGIN_ROOT }));
    expect(bytes(additionalContext)).toBeLessThanOrEqual(DIGEST_MAX_BYTES);
  });

  it('injects NOTHING when the rules are installed', () => {
    expect(bootstrap({ homeDir: makeHome(['dev-protocol.md', 'quality-gates.md']) }).additionalContext).toBeNull();
  });

  it('injects when the directory exists but is empty', () => {
    expect(bootstrap({ homeDir: makeHome([]) }).additionalContext).not.toBeNull();
  });

  it('projectBootstrap.rulesDigest=false injects nothing even when the rules are absent', () => {
    const { additionalContext, policy } = bootstrap({
      homeDir: makeHome(null), config: { projectBootstrap: { rulesDigest: false } },
    });
    expect(additionalContext).toBeNull();
    expect(policy.rulesDigest).toMatchObject({ enabled: false, source: 'config' });
  });

  it('env ARTIBOT_PROJECT_BOOTSTRAP=off injects nothing', () => {
    expect(bootstrap({ homeDir: makeHome(null), env: { ARTIBOT_PROJECT_BOOTSTRAP: 'off' } }).additionalContext).toBeNull();
  });

  it('injects nothing when the plugin has no rules to point at', () => {
    const { additionalContext } = runProjectBootstrap({
      payload: { cwd: tmp('proj') }, env: {}, homeDir: makeHome(null), pluginRoot: tmp('bare-root'), config: {},
    });
    expect(additionalContext).toBeNull();
  });
});
