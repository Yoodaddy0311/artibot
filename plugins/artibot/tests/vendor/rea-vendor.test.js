/**
 * Pins for plugins/artibot/vendor/rea -- the third-party REA skill text that
 * /rea (commands/rea.md) tells the model to follow.
 *
 * What this protects, and why a test and not a script (script gates have passed
 * while destroying their own baseline; a missing test file is red, a missing
 * script is silence):
 *   1. sha256 1:1   every file under vendor/rea equals its pin in UPSTREAM.json;
 *                   a missing, changed OR extra file is red.
 *   2. version pin  commands/rea.md, UPSTREAM.json#version and skill/SKILL.md
 *                   name the SAME rea-agents@x.y.z. One character off is red.
 *   3. no floating  no `@latest` in rea.md, UPSTREAM.json or the vendored text.
 *   4. license      LICENSE is the MIT text and UPSTREAM.json says MIT.
 *   5. hidden text  no zero-width / bidi / tag characters in the vendored text.
 *   6. attributes   .gitattributes keeps `-text` on the tree (see below).
 *   7. rea.md       its pre-approved Bash patterns and its fenced commands stay
 *                   inside the set ADR-014 allows (allowlist; see checkCommand).
 *
 * Every check is a pure function of a tree on disk, so each is also run on a temp
 * copy with the bytes tampered DIRECTLY (not through git or a checkout): a check
 * that cannot be shown red proves nothing when it is green. The controls are
 * differential (they assert what their mutation ADDS), so a tree that is already
 * red shows ONE failing live check, not a wall of control failures on top of it.
 *
 * -- What this gate does NOT see (rules 9: written next to the gate) -----------
 *  - Whether the text is right or safe. Equal bytes prove "this is what we
 *    pinned", not "this is what upstream published" (that is
 *    `sync-rea.mjs --check` against the registry tarball) and not "this is good".
 *  - That the doc gates skip this tree. validate-doc-links, validate-md-rendering,
 *    the citation gate, unicode-hygiene and the skill lint walk commands/ skills/
 *    docs/ agents/ and the root docs; nothing here makes them look at vendor/.
 *    Check 5 re-implements only the hidden-character part of unicode-hygiene.
 *  - Line endings on a platform this suite did not run on. Local Windows
 *    (core.autocrlf=true) checks tracked text out as CRLF; the `-text` attribute is
 *    what keeps these bytes LF. Check 6 pins the attribute and the CRLF control
 *    writes the bytes itself, but only a Windows run proves a checkout keeps them.
 *  - Prose. Check 7 pins the commands and tool patterns rea.md may run, not what
 *    its sentences say. "Ask before --yes" is a sentence; only the order of the
 *    fenced lines and the absence of `--yes` in allowed-tools are enforced.
 *  - The live engine. Nothing here runs npx or talks to the registry.
 *
 * @module tests/vendor/rea-vendor
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { findSpecifiers, sha256Hex } from '../../scripts/vendor/sync-rea.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '..', '..');
const REPO_ROOT = path.resolve(PLUGIN_ROOT, '..', '..');

const LIVE = Object.freeze({
  vendorDir: path.join(PLUGIN_ROOT, 'vendor', 'rea'),
  commandFile: path.join(PLUGIN_ROOT, 'commands', 'rea.md'),
  attributesFile: path.join(REPO_ROOT, '.gitattributes'),
});

const ATTRIBUTE_PATTERN = 'plugins/artibot/vendor/rea/**';
const VERSION_RE = /^\d+\.\d+\.\d+$/;

// Same ranges as tests/ci/unicode-hygiene.test.js (a test file cannot be imported
// without re-registering its describe blocks, so the four ranges are repeated).
const HIDDEN_RE = /[\u{200B}-\u{200F}\u{202A}-\u{202E}\u{2066}-\u{2069}\u{E0000}-\u{E007F}]/u;

// ---------------------------------------------------------------------------
// checks (pure over a tree on disk)
// ---------------------------------------------------------------------------

const rd = (file) => readFileSync(file, 'utf8');
const lf = (text) => text.replace(/\r\n/g, '\n');

function listFiles(dir) {
  const out = [];
  const walk = (current, rel) => {
    for (const e of readdirSync(current, { withFileTypes: true })) {
      const next = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(current, e.name), next);
      else out.push(next);
    }
  };
  walk(dir, '');
  return out.sort();
}

const upstreamOf = (t) => JSON.parse(rd(path.join(t.vendorDir, 'UPSTREAM.json')));
const vendored = (t) => listFiles(t.vendorDir).filter((f) => f !== 'UPSTREAM.json');
const abs = (t, rel) => path.join(t.vendorDir, ...rel.split('/'));

/** Check 1. `checked` is the denominator: 0 problems over 0 files is not a pass. */
function checkHashes(t) {
  const pins = upstreamOf(t).files ?? {};
  const onDisk = vendored(t);
  const problems = [];
  for (const rel of Object.keys(pins)) {
    if (!onDisk.includes(rel)) problems.push(`missing: ${rel}`);
  }
  for (const rel of onDisk) {
    if (!(rel in pins)) problems.push(`extra (not pinned): ${rel}`);
  }
  let checked = 0;
  for (const rel of onDisk.filter((f) => f in pins)) {
    checked += 1;
    const bytes = readFileSync(abs(t, rel));
    if (sha256Hex(bytes) === pins[rel]) continue;
    const lfOnly = Buffer.from(bytes.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
    const hint = sha256Hex(lfOnly) === pins[rel] ? ' (CRLF-converted: check the -text attribute / autocrlf)' : '';
    problems.push(`changed: ${rel}${hint}`);
  }
  return { problems, checked };
}

/** Check 2. The pin triple. Each side must pin at least once and agree with UPSTREAM.json#version. */
function checkPins(t) {
  const version = upstreamOf(t).version;
  const problems = [];
  if (!VERSION_RE.test(String(version))) problems.push(`UPSTREAM.json version "${version}" is not x.y.z`);
  const sides = {
    'commands/rea.md': findSpecifiers(rd(t.commandFile)),
    'skill/SKILL.md': findSpecifiers(rd(abs(t, 'skill/SKILL.md'))),
  };
  for (const [name, found] of Object.entries(sides)) {
    if (found.length === 0) problems.push(`${name} pins no rea-agents@x.y.z`);
    const stray = [...new Set(found.filter((v) => v !== version))];
    if (stray.length) problems.push(`${name} pins ${stray.join(', ')} but UPSTREAM.json says ${version}`);
  }
  return { problems, version, counts: Object.fromEntries(Object.entries(sides).map(([k, v]) => [k, v.length])) };
}

/** Check 3. */
function checkNoFloating(t) {
  const files = [['commands/rea.md', rd(t.commandFile)], ['UPSTREAM.json', rd(path.join(t.vendorDir, 'UPSTREAM.json'))]];
  for (const rel of vendored(t)) files.push([rel, rd(abs(t, rel))]);
  return { problems: files.filter(([, text]) => /@latest\b/.test(text)).map(([name]) => `@latest in ${name}`), checked: files.length };
}

/** Check 4. */
function checkLicense(t) {
  const upstream = upstreamOf(t);
  const text = rd(abs(t, 'LICENSE'));
  const problems = [];
  if (upstream.license !== 'MIT') problems.push(`UPSTREAM.json license is ${upstream.license}`);
  if (upstream.package !== 'rea-agents') problems.push(`UPSTREAM.json package is ${upstream.package}`);
  if (!/^MIT License\b/.test(lf(text))) problems.push('LICENSE does not open with "MIT License"');
  if (!text.includes('Permission is hereby granted, free of charge')) problems.push('LICENSE lacks the MIT grant');
  return { problems };
}

/** Check 5. */
function checkHidden(t) {
  const problems = [];
  for (const rel of [...vendored(t), 'UPSTREAM.json']) {
    const text = rd(abs(t, rel));
    const hit = HIDDEN_RE.exec(text);
    if (hit) problems.push(`${rel}: U+${hit[0].codePointAt(0).toString(16).toUpperCase()} at offset ${hit.index}`);
  }
  return { problems };
}

/** Check 6: the attributes of ATTRIBUTE_PATTERN, last matching line wins (as in git). */
function attributesOf(gitattributes) {
  let attrs = null;
  for (const line of lf(gitattributes).split('\n')) {
    const [pattern, ...rest] = line.trim().split(/\s+/);
    if (pattern === ATTRIBUTE_PATTERN) attrs = rest;
  }
  return attrs;
}
const checkAttributes = (text) => ({ problems: attributesOf(text)?.includes('-text') ? [] : [`.gitattributes does not give ${ATTRIBUTE_PATTERN} the -text attribute`] });

/** Check 7. Allowlists, not denylists: a verb or shape nobody listed is red. */
const FENCED_ALLOWED = [
  /^npx -y rea-agents@\d+\.\d+\.\d+ doctor --client claude_code --json$/,
  /^npx -y rea-agents@\d+\.\d+\.\d+ setup --client claude_code --dry-run --json$/,
  /^npx -y rea-agents@\d+\.\d+\.\d+ setup --client claude_code --yes$/,
  /^npx -y rea-agents@\d+\.\d+\.\d+ analyze-javascript-application <[^>\s]+> --json$/,
];
const BASH_ALLOWED = [
  /^Bash\(node --version\)$/,
  /^Bash\(npx -y rea-agents@\d+\.\d+\.\d+ doctor:\*\)$/,
  /^Bash\(npx -y rea-agents@\d+\.\d+\.\d+ setup --client claude_code --dry-run:\*\)$/,
];

function allowedTools(text) {
  const m = /^allowed-tools:\s*\[(.*)\]\s*$/m.exec(lf(text));
  return m ? m[1].split(/,\s*(?![^()]*\))/).map((s) => s.trim()).filter(Boolean) : null;
}

function fencedCommandLines(text) {
  const out = [];
  let inFence = false;
  for (const raw of lf(text).split('\n')) {
    if (/^\s*```/.test(raw)) {
      inFence = !inFence;
    } else if (inFence && raw.trim() !== '') {
      out.push(raw.trim());
    }
  }
  return out;
}

function checkCommand(text) {
  const problems = [];
  const tools = allowedTools(text);
  if (tools === null) return { problems: ['allowed-tools is not an inline [..] list'], tools: [], fenced: [] };
  if (!tools.includes('mcp__rea')) problems.push('allowed-tools lacks mcp__rea');
  for (const tool of tools.filter((t) => t.startsWith('Bash'))) {
    if (!BASH_ALLOWED.some((re) => re.test(tool))) problems.push(`allowed-tools pre-approves ${tool}`);
  }
  const fenced = fencedCommandLines(text);
  for (const line of fenced) {
    if (!FENCED_ALLOWED.some((re) => re.test(line))) problems.push(`fenced command not on the allowlist: ${line}`);
  }
  const dry = fenced.findIndex((l) => l.includes('--dry-run'));
  const yes = fenced.findIndex((l) => l.includes('--yes'));
  if (yes !== -1 && (dry === -1 || dry > yes)) problems.push('--dry-run must come before --yes');
  return { problems, tools, fenced };
}

// ---------------------------------------------------------------------------
// temp copies with direct byte tampering
// ---------------------------------------------------------------------------

const made = [];
afterEach(() => {
  while (made.length) rmSync(made.pop(), { recursive: true, force: true });
});

/** A byte-for-byte copy of the live tree in a temp dir. */
function cloneLive() {
  const root = mkdtempSync(path.join(tmpdir(), 'rea-vendor-test-'));
  made.push(root);
  const t = { vendorDir: path.join(root, 'vendor', 'rea'), commandFile: path.join(root, 'commands', 'rea.md') };
  mkdirSync(path.dirname(t.commandFile), { recursive: true });
  writeFileSync(t.commandFile, readFileSync(LIVE.commandFile));
  for (const rel of listFiles(LIVE.vendorDir)) {
    mkdirSync(path.dirname(abs(t, rel)), { recursive: true });
    writeFileSync(abs(t, rel), readFileSync(path.join(LIVE.vendorDir, ...rel.split('/'))));
  }
  return t;
}

/** Rewrite one file's text through `fn`, writing the resulting bytes straight to disk. */
const edit = (file, fn) => writeFileSync(file, fn(readFileSync(file, 'utf8')));

const upstreamFile = (t) => path.join(t.vendorDir, 'UPSTREAM.json');
const rewriteUpstream = (t, fn) => writeFileSync(upstreamFile(t), JSON.stringify(fn(JSON.parse(readFileSync(upstreamFile(t), 'utf8')))));

/** Problems a mutation ADDS to a fresh copy of the live tree (differential). */
function addedBy(check, mutate) {
  const t = cloneLive();
  const before = check(t).problems;
  mutate(t);
  return check(t).problems.filter((p) => !before.includes(p));
}

/** Problems `mutated` has that `base` does not, for the checks that read one file's text. */
const addedText = (check, base, mutated) => check(mutated).problems.filter((p) => !check(base).problems.includes(p));

// ---------------------------------------------------------------------------
// live tree
// ---------------------------------------------------------------------------

describe('rea-vendor / live tree', () => {
  it('has a non-trivial denominator (0 problems over 0 files is not a pass)', () => {
    const upstream = upstreamOf(LIVE);
    for (const required of ['skill/SKILL.md', 'LICENSE', 'DISCLAIMER.md']) {
      expect(Object.keys(upstream.files), required).toContain(required);
    }
    expect(vendored(LIVE).length).toBe(Object.keys(upstream.files).length);
    expect(checkHashes(LIVE).checked).toBe(Object.keys(upstream.files).length);
    expect(upstream.integrity).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/);
    expect(upstream.notes.join(' ')).toMatch(/GATE COVERAGE/);
  });

  it('1. every vendored file equals its sha256 pin, none missing, none extra', () => {
    expect(checkHashes(LIVE).problems).toEqual([]);
  });

  it('2. rea.md, UPSTREAM.json and SKILL.md pin one and the same version', () => {
    const r = checkPins(LIVE);
    expect(r.problems).toEqual([]);
    expect(r.counts['commands/rea.md']).toBeGreaterThan(0);
    expect(r.counts['skill/SKILL.md']).toBeGreaterThan(0);
  });

  it('3. nothing floats on @latest', () => {
    const r = checkNoFloating(LIVE);
    expect(r.problems).toEqual([]);
    expect(r.checked).toBe(vendored(LIVE).length + 2);
  });

  it('4. LICENSE is MIT', () => {
    expect(checkLicense(LIVE).problems).toEqual([]);
  });

  it('5. the vendored text hides no zero-width, bidi or tag characters', () => {
    expect(checkHidden(LIVE).problems).toEqual([]);
  });

  it('6. .gitattributes keeps -text on the tree', () => {
    expect(checkAttributes(rd(LIVE.attributesFile)).problems).toEqual([]);
  });

  it('7. rea.md pre-approves only read-only commands and fences only allowlisted ones', () => {
    const r = checkCommand(rd(LIVE.commandFile));
    expect(r.problems).toEqual([]);
    expect(r.tools.length).toBeGreaterThan(2);
    expect(r.fenced.length).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// negative controls: each check goes red when the bytes are tampered
// ---------------------------------------------------------------------------

describe('rea-vendor / negative controls', () => {
  it('control: an untouched copy is green for every tree check', () => {
    const t = cloneLive();
    for (const check of [checkHashes, checkPins, checkNoFloating, checkLicense, checkHidden]) {
      expect(check(t).problems, check.name).toEqual([]);
    }
  });

  describe('1. sha256', () => {
    it('one changed byte is red', () => {
      const added = addedBy(checkHashes, (t) => edit(abs(t, 'skill/SKILL.md'), (s) => s.replace('REA', 'REa')));
      expect(added).toEqual(['changed: skill/SKILL.md']);
    });

    it('a deleted file is red', () => {
      expect(addedBy(checkHashes, (t) => rmSync(abs(t, 'DISCLAIMER.md')))).toEqual(['missing: DISCLAIMER.md']);
    });

    it('an added file is red, even one that looks harmless', () => {
      const added = addedBy(checkHashes, (t) => writeFileSync(abs(t, 'skill/references/extra.md'), 'harmless\n'));
      expect(added).toEqual(['extra (not pinned): skill/references/extra.md']);
    });

    it('CRLF written straight into the bytes is red and says why (no checkout involved)', () => {
      const added = addedBy(checkHashes, (t) => edit(abs(t, 'skill/SKILL.md'), (s) => s.replace(/\n/g, '\r\n')));
      expect(added).toHaveLength(1);
      expect(added[0]).toMatch(/^changed: skill\/SKILL\.md \(CRLF-converted/);
    });

    it('an edited pin in UPSTREAM.json is red', () => {
      const flip = (c) => (c === '0' ? '1' : '0');
      const added = addedBy(checkHashes, (t) => rewriteUpstream(t, (u) => {
        u.files.LICENSE = u.files.LICENSE.replace(/^./, flip);
        return u;
      }));
      expect(added).toEqual(['changed: LICENSE']);
    });

    it('a tree with no pins at all is red, not vacuously green', () => {
      const t = cloneLive();
      rewriteUpstream(t, (u) => ({ ...u, files: {} }));
      const { problems, checked } = checkHashes(t);
      expect(checked).toBe(0);
      expect(problems.length).toBeGreaterThan(5);
    });
  });

  describe('2. the pin triple', () => {
    const NEXT = '9.9.9';
    const live = () => checkPins(LIVE).version;

    it('one specifier in rea.md off by a version is red', () => {
      const added = addedBy(checkPins, (t) => edit(t.commandFile, (s) => s.replace(`rea-agents@${live()}`, `rea-agents@${NEXT}`)));
      expect(added).toEqual([`commands/rea.md pins ${NEXT} but UPSTREAM.json says ${live()}`]);
    });

    it('one specifier in SKILL.md off by a version is red', () => {
      const added = addedBy(checkPins, (t) => edit(abs(t, 'skill/SKILL.md'), (s) => s.replace(`rea-agents@${live()}`, `rea-agents@${NEXT}`)));
      expect(added).toEqual([`skill/SKILL.md pins ${NEXT} but UPSTREAM.json says ${live()}`]);
    });

    it('UPSTREAM.json moved alone is red on BOTH other sides', () => {
      const added = addedBy(checkPins, (t) => rewriteUpstream(t, (u) => ({ ...u, version: NEXT })));
      expect(added).toHaveLength(2);
    });

    it('a one-character edit of a version digit is red', () => {
      const bumped = live().replace(/\d$/, (d) => String((Number(d) + 1) % 10));
      const added = addedBy(checkPins, (t) => edit(t.commandFile, (s) => s.replace(`rea-agents@${live()}`, `rea-agents@${bumped}`)));
      expect(added).toEqual([`commands/rea.md pins ${bumped} but UPSTREAM.json says ${live()}`]);
    });

    it('a rea.md or SKILL.md with no pin at all is red, not vacuously green', () => {
      const added = addedBy(checkPins, (t) => {
        edit(t.commandFile, (s) => s.replace(/rea-agents@\d+\.\d+\.\d+/g, 'rea-agents'));
        edit(abs(t, 'skill/SKILL.md'), (s) => s.replace(/rea-agents@\d+\.\d+\.\d+/g, 'rea-agents'));
      });
      expect(added).toEqual(['commands/rea.md pins no rea-agents@x.y.z', 'skill/SKILL.md pins no rea-agents@x.y.z']);
    });

    it('a non-x.y.z version in UPSTREAM.json is red', () => {
      const added = addedBy(checkPins, (t) => rewriteUpstream(t, (u) => ({ ...u, version: 'latest' })));
      expect(added[0]).toMatch(/not x\.y\.z/);
    });
  });

  describe('3. @latest', () => {
    it('is red in rea.md', () => {
      const added = addedBy(checkNoFloating, (t) => edit(t.commandFile, (s) => `${s}\nnpx -y rea-agents@latest doctor\n`));
      expect(added).toEqual(['@latest in commands/rea.md']);
    });

    it('is red in UPSTREAM.json', () => {
      const added = addedBy(checkNoFloating, (t) => rewriteUpstream(t, (u) => ({ ...u, extra: 'rea-agents@latest' })));
      expect(added).toEqual(['@latest in UPSTREAM.json']);
    });

    it('is red in a vendored file', () => {
      const added = addedBy(checkNoFloating, (t) => edit(abs(t, 'skill/references/evidence-workflows.md'), (s) => `${s}\nrea-agents@latest\n`));
      expect(added).toEqual(['@latest in skill/references/evidence-workflows.md']);
    });
  });

  describe('4. license', () => {
    it('a LICENSE that is not MIT is red', () => {
      const added = addedBy(checkLicense, (t) => writeFileSync(abs(t, 'LICENSE'), 'All rights reserved.\n'));
      expect(added).toEqual(['LICENSE does not open with "MIT License"', 'LICENSE lacks the MIT grant']);
    });

    it('UPSTREAM.json claiming another license or package is red', () => {
      const added = addedBy(checkLicense, (t) => rewriteUpstream(t, (u) => ({ ...u, license: 'GPL-3.0', package: 'other' })));
      expect(added).toEqual(['UPSTREAM.json license is GPL-3.0', 'UPSTREAM.json package is other']);
    });

    it('a CRLF MIT text still counts as MIT (the check reads text, not line endings)', () => {
      expect(addedBy(checkLicense, (t) => edit(abs(t, 'LICENSE'), (s) => s.replace(/\n/g, '\r\n')))).toEqual([]);
    });
  });

  describe('5. hidden characters', () => {
    it.each([
      ['zero-width space', 0x200b],
      ['right-to-left override', 0x202e],
      ['bidi isolate', 0x2066],
      ['unicode tag letter', 0xe0041],
    ])('%s in a vendored file is red', (_name, codePoint) => {
      const added = addedBy(checkHidden, (t) => edit(abs(t, 'skill/SKILL.md'), (s) => s.replace('REA', `RE${String.fromCodePoint(codePoint)}A`)));
      expect(added).toHaveLength(1);
      expect(added[0]).toMatch(new RegExp(`^skill/SKILL\\.md: U\\+${codePoint.toString(16).toUpperCase()} at offset`));
    });

    it('is red in UPSTREAM.json too', () => {
      const added = addedBy(checkHidden, (t) => rewriteUpstream(t, (u) => ({ ...u, note: `x${String.fromCodePoint(0x200b)}y` })));
      expect(added).toHaveLength(1);
      expect(added[0]).toMatch(/^UPSTREAM\.json: U\+200B/);
    });

    it('ordinary non-ASCII text is not mistaken for a hidden character', () => {
      const added = addedBy(checkHidden, (t) => edit(abs(t, 'skill/SKILL.md'), (s) => `${s}\n한국어 and an arrow → and an en dash –\n`));
      expect(added).toEqual([]);
    });
  });

  describe('6. attributes', () => {
    it('is red when the rule is absent, when it is not -text, and when a later line overrides it', () => {
      expect(checkAttributes('# nothing\nreports/** -text\n').problems).toHaveLength(1);
      expect(checkAttributes(`${ATTRIBUTE_PATTERN} text eol=lf\n`).problems).toHaveLength(1);
      expect(checkAttributes(`${ATTRIBUTE_PATTERN} -text\n${ATTRIBUTE_PATTERN} text\n`).problems).toHaveLength(1);
    });

    it('is green for the rule, with CRLF line endings and trailing blanks', () => {
      expect(checkAttributes(`# c\r\n${ATTRIBUTE_PATTERN} -text  \r\n`).problems).toEqual([]);
      expect(checkAttributes(`${ATTRIBUTE_PATTERN} text\n${ATTRIBUTE_PATTERN} -text\n`).problems).toEqual([]);
    });
  });

  describe('7. rea.md command safety', () => {
    // LF-normalised: the working tree may hold CRLF (core.autocrlf), and these controls replace whole lines.
    const live = () => lf(rd(LIVE.commandFile));
    const withTool = (text, tool) => text.replace(/^(allowed-tools: \[.*)\]/m, `$1, ${tool}]`);
    const withFence = (text, line) => `${text}\n\`\`\`bash\n${line}\n\`\`\`\n`;
    const version = () => checkPins(LIVE).version;

    it('control: the live file is green', () => {
      expect(checkCommand(live()).problems).toEqual([]);
    });

    it('pre-approving the write step is red (--yes, setup without --dry-run, update, a bare Bash)', () => {
      for (const tool of [
        `Bash(npx -y rea-agents@${version()} setup --client claude_code --yes:*)`,
        `Bash(npx -y rea-agents@${version()} setup:*)`,
        `Bash(npx -y rea-agents@${version()} update:*)`,
        'Bash',
        'Bash(npx:*)',
      ]) {
        expect(addedText(checkCommand, live(), withTool(live(), tool)), tool).toEqual([`allowed-tools pre-approves ${tool}`]);
      }
    });

    it('dropping mcp__rea from allowed-tools is red', () => {
      expect(addedText(checkCommand, live(), live().replace(/, mcp__rea\b/, ''))).toEqual(['allowed-tools lacks mcp__rea']);
    });

    it('a fenced command outside the allowlist is red (update, uninstall, another client, a pipe)', () => {
      for (const line of [
        `npx -y rea-agents@${version()} update`,
        `npx -y rea-agents@${version()} uninstall`,
        `npx -y rea-agents@${version()} setup --client codex --yes`,
        `npx -y rea-agents@${version()} setup --client claude_code --yes --install-hopper`,
        'npx -y rea-agents@latest doctor --client claude_code --json',
        'npm install --global rea-agents',
        `npx -y rea-agents@${version()} doctor --client claude_code --json | sh`,
      ]) {
        expect(addedText(checkCommand, live(), withFence(live(), line)), line).toEqual([`fenced command not on the allowlist: ${line}`]);
      }
    });

    it('--yes before --dry-run, or --yes with no --dry-run at all, is red', () => {
      const text = live();
      const dry = `npx -y rea-agents@${version()} setup --client claude_code --dry-run --json`;
      const yes = `npx -y rea-agents@${version()} setup --client claude_code --yes`;
      const swapped = text.replace(dry, '@@DRY@@').replace(yes, dry).replace('@@DRY@@', yes);
      expect(swapped).not.toBe(text);
      expect(addedText(checkCommand, text, swapped)).toEqual(['--dry-run must come before --yes']);
      const noDry = text.replace(`${dry}\n`, '');
      expect(noDry).not.toBe(text);
      expect(addedText(checkCommand, text, noDry)).toEqual(['--dry-run must come before --yes']);
    });

    it('allowed-tools that is not an inline list is red instead of skipped', () => {
      expect(checkCommand('---\ndescription: x\nallowed-tools:\n  - Read\n---\n').problems).toEqual(['allowed-tools is not an inline [..] list']);
      expect(checkCommand('no frontmatter\n').problems).toEqual(['allowed-tools is not an inline [..] list']);
    });

    it('reads allowed-tools with CRLF line endings the same way', () => {
      expect(checkCommand(live().replace(/\n/g, '\r\n')).problems).toEqual(checkCommand(live()).problems);
    });
  });
});
