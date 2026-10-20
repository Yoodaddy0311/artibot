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
 *   3. no floating  no floating rea-agents (@latest, @next, any other tag or range,
 *                   a bare `npx rea-agents`) in rea.md, UPSTREAM.json or the
 *                   vendored text (sync-rea.mjs#floatingSpecifiers).
 *   4. license      LICENSE is the MIT text and UPSTREAM.json says MIT.
 *   5. hidden text  no zero-width / bidi / tag / word-joiner / BOM / soft-hyphen /
 *                   Arabic-letter-mark characters in the vendored text.
 *   6. attributes   .gitattributes keeps `-text` on the tree (see below).
 *   7. rea.md       what its allowed-tools pre-approves and which commands it
 *                   fences stay inside the set ADR-014 allows: exact read-only
 *                   command strings (no `*` or `:*` wildcard, no MCP tool, Read
 *                   only for the installed skill folder), each one a fenced
 *                   command verbatim (allowlist; see checkCommand). The CLI
 *                   fallback writes the JSON to a file and reads a view of it.
 *   8. no slash     rea.md never tells the user to type `/rea` (Auto-invoke).
 *   9. checklist    rea.md's benchmarking table keeps its seven axes, each with an
 *                   observable and a not-observable cell, and the coverage formula.
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
 *    Checks 8 and 9 pin two structural facts of it (no `/rea` instruction, the
 *    seven-axis table) and nothing else: whether the cells are RIGHT, or the
 *    "not observable" classification honest, is for a reader.
 *  - What the host does with the Read rule. TOOLS_ALLOWED pins the string
 *    `Read(~/.claude/skills/reverse-engineer-anything/**)`. That Claude Code reads a
 *    path rule from allowed-tools, and anchors `~/` at the home directory for it, comes
 *    from the permissions docs and from reading the installed 2.1.304 binary
 *    (2026-10-20); no prompt was observed. `${CLAUDE_PLUGIN_ROOT}` is documented as
 *    substituted in Bash rules only, so the plugin's own copy of the skill cannot be
 *    named here and its Read stays on the normal permission flow.
 *  - What the host does with everything NOT pre-approved. allowed-tools is a grant
 *    (Claude Code docs: it "does not restrict which tools are available"; the
 *    installed 2.1.303 puts it in alwaysAllowRules.command), so REA's tools, `--yes`
 *    and any other command fall to the normal permission prompt. That is documented
 *    and read from the binary, not exercised by this suite.
 *  - The live engine. Nothing here runs npx or talks to the registry.
 *
 * @module tests/vendor/rea-vendor
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { findSpecifiers, floatingSpecifiers, sha256Hex } from '../../scripts/vendor/sync-rea.mjs';

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
// without re-registering its describe blocks, so the eight ranges are repeated).
const HIDDEN_RE = /[\u{00AD}\u{061C}\u{200B}-\u{200F}\u{202A}-\u{202E}\u{2060}-\u{2064}\u{2066}-\u{2069}\u{FEFF}\u{E0000}-\u{E007F}]/u;

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

/** Check 3. Any floating rea-agents, not only @latest; the placeholder UPSTREAM.json spells in its pin note is exempt. */
function checkNoFloating(t) {
  const files = [['commands/rea.md', rd(t.commandFile)], ['UPSTREAM.json', rd(path.join(t.vendorDir, 'UPSTREAM.json'))]];
  for (const rel of vendored(t)) files.push([rel, rd(abs(t, rel))]);
  const problems = files.flatMap(([name, text]) => [...new Set(floatingSpecifiers(text))].map((spec) => `floating ${spec} in ${name}`));
  return { problems, checked: files.length };
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
  // CLI fallback for a local JavaScript tree: the complete JSON goes to a file (a bare `--json` would print it
  // into the transcript), the transform wraps it, and only a view of it is read. Every path is a <placeholder>.
  /^npx -y rea-agents@\d+\.\d+\.\d+ analyze-javascript-application <[^>\s]+> --json > <[^>\s]+>$/,
  /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/rea\/make-view-request\.mjs" <[^>\s]+> <[^>\s]+>$/,
  /^npx -y rea-agents@\d+\.\d+\.\d+ inspect-analysis-view <[^>\s]+>$/,
];
/**
 * What rea.md may pre-approve in allowed-tools. That field is a GRANT, not a limit
 * (Claude Code docs: it "does not restrict which tools are available"): whatever is
 * listed runs without a permission prompt, everything else prompts. So the list is
 * the exact set of read-only commands, written as whole strings. A rule with no `*`
 * matches ONE command; a prefix rule (`:*` or a trailing `*`) also approves whatever
 * is appended to it, e.g. `--dry-run --no-dry-run --yes`, and REA reads untrusted
 * targets, so a prompt-injected target could use that gap. No MCP tool is listed:
 * REA's tools go through the host permission prompt, exactly as upstream's do.
 * Read is one exact path rule, the folder `rea setup` installs the skill into. A bare
 * `Read` would also pre-approve the investigated target and anything else on disk.
 */
const TOOLS_ALLOWED = [
  /^Read\(~\/\.claude\/skills\/reverse-engineer-anything\/\*\*\)$/,
  /^Bash\(node --version\)$/,
  /^Bash\(npx -y rea-agents@\d+\.\d+\.\d+ doctor --client claude_code --json\)$/,
  /^Bash\(npx -y rea-agents@\d+\.\d+\.\d+ setup --client claude_code --dry-run --json\)$/,
];
const READ_RULE = 'Read(~/.claude/skills/reverse-engineer-anything/**)';
const MCP_REASON = ' (REA tools go through the host permission prompt, as upstream)';

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
  const fenced = fencedCommandLines(text);
  for (const tool of tools) {
    if (!TOOLS_ALLOWED.some((re) => re.test(tool))) {
      problems.push(`allowed-tools pre-approves ${tool}${tool.startsWith('mcp__') ? MCP_REASON : ''}`);
      continue;
    }
    // A pre-approved npx command is a fenced command verbatim, so the grant cannot drift from the doc.
    const inner = /^Bash\((npx .+)\)$/.exec(tool)?.[1];
    if (inner !== undefined && !fenced.includes(inner)) problems.push(`pre-approved command is not a fenced command verbatim: ${inner}`);
  }
  for (const line of fenced) {
    if (!FENCED_ALLOWED.some((re) => re.test(line))) problems.push(`fenced command not on the allowlist: ${line}`);
  }
  const dry = fenced.findIndex((l) => l.includes('--dry-run'));
  const yes = fenced.findIndex((l) => l.includes('--yes'));
  if (yes !== -1 && (dry === -1 || dry > yes)) problems.push('--dry-run must come before --yes');
  // The CLI fallback is a chain: analysis, wrapped request, view. An analysis line alone leaves the complete JSON with no way to read a view of it.
  const step = (re) => fenced.findIndex((l) => re.test(l));
  const [analyze, wrap, view] = [step(/ analyze-javascript-application /), step(/make-view-request\.mjs/), step(/ inspect-analysis-view /)];
  if (analyze !== -1 && !(analyze < wrap && wrap < view)) problems.push('CLI fallback must run analyze, then make-view-request, then inspect-analysis-view');
  return { problems, tools, fenced };
}

/** Check 8. The one prose rule: no sentence tells the user to type the command (`/rea` in code ticks). "# /rea" is only its name. */
function checkNoSlashInstruction(text) {
  const hits = lf(text).split('\n').filter((line) => line.includes('`/rea`'));
  return { problems: hits.map((line) => `rea.md tells the user to type /rea: ${line.trim().slice(0, 80)}`) };
}

const AXES = ['기능', '디자인', '시스템', '워크플로우', '메커니즘', '레이아웃', '코드 구조'];

/** Check 9. Structure only: a 3-column table (axis, observable, not observable) with one filled row per axis, and the coverage formula. */
function checkBenchmarkChecklist(text) {
  const body = lf(text);
  const rows = body.split('\n').filter((l) => l.trim().startsWith('|')).map((l) => l.trim().split('|').slice(1, -1).map((c) => c.trim()));
  const problems = [];
  const header = rows.find((r) => r.length === 3 && r[0] === '축');
  if (!header || !header[1].startsWith('관찰 가능') || !header[2].startsWith('관찰 불가')) problems.push('checklist header lacks the 관찰 가능 / 관찰 불가 columns');
  for (const axis of AXES) {
    const row = rows.find((r) => r.length === 3 && r[0] === axis);
    if (!row || !row[1] || !row[2]) problems.push(`checklist has no complete row for ${axis}`);
  }
  if (!body.includes('답함 ÷ (전체 - 관찰 불가)')) problems.push('coverage formula 답함 ÷ (전체 - 관찰 불가) is missing');
  return { problems };
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

  it('3. nothing floats: no @latest, @next, other tag or range, bare npx rea-agents', () => {
    const r = checkNoFloating(LIVE);
    expect(r.problems).toEqual([]);
    expect(r.checked).toBe(vendored(LIVE).length + 2);
  });

  it('4. LICENSE is MIT', () => {
    expect(checkLicense(LIVE).problems).toEqual([]);
  });

  it('5. the vendored text hides no zero-width, bidi, tag, word-joiner, BOM, soft-hyphen or Arabic-letter-mark characters', () => {
    expect(checkHidden(LIVE).problems).toEqual([]);
  });

  it('6. .gitattributes keeps -text on the tree', () => {
    expect(checkAttributes(rd(LIVE.attributesFile)).problems).toEqual([]);
  });

  it('7. rea.md pre-approves only exact read-only commands and one skill-folder Read (no wildcard command, no MCP tool) and fences only allowlisted ones', () => {
    const r = checkCommand(rd(LIVE.commandFile));
    expect(r.problems).toEqual([]);
    expect(r.tools).toContain(READ_RULE);
    expect(r.tools).not.toContain('Read');
    expect(r.tools.filter((t) => t.startsWith('Read'))).toEqual([READ_RULE]);
    expect(r.tools.filter((t) => t.startsWith('mcp__'))).toEqual([]);
    // the Read path glob is the only `*` in the grant; every Bash rule is a whole command
    expect(r.tools.filter((t) => t.includes('*'))).toEqual([READ_RULE]);
    expect(r.tools.filter((t) => t.startsWith('Bash(npx '))).toHaveLength(2);
    // doctor, dry-run, --yes, then the CLI fallback chain (analyze, wrap, view)
    expect(r.fenced).toHaveLength(6);
  });

  it('8. rea.md never tells the user to type /rea', () => {
    expect(checkNoSlashInstruction(rd(LIVE.commandFile)).problems).toEqual([]);
  });

  it('9. the benchmarking checklist keeps its seven axes, both columns and the coverage formula', () => {
    expect(checkBenchmarkChecklist(rd(LIVE.commandFile)).problems).toEqual([]);
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

  describe('3. floating rea-agents', () => {
    it('@latest is red in rea.md', () => {
      const added = addedBy(checkNoFloating, (t) => edit(t.commandFile, (s) => `${s}\nnpx -y rea-agents@latest doctor\n`));
      expect(added).toEqual(['floating rea-agents@latest in commands/rea.md']);
    });

    it('@latest is red in UPSTREAM.json', () => {
      const added = addedBy(checkNoFloating, (t) => rewriteUpstream(t, (u) => ({ ...u, extra: 'rea-agents@latest' })));
      expect(added).toEqual(['floating rea-agents@latest in UPSTREAM.json']);
    });

    it('@latest is red in a vendored file', () => {
      const added = addedBy(checkNoFloating, (t) => edit(abs(t, 'skill/references/evidence-workflows.md'), (s) => `${s}\nrea-agents@latest\n`));
      expect(added).toEqual(['floating rea-agents@latest in skill/references/evidence-workflows.md']);
    });

    it('@next, another tag, a range and a bare npx are red too, not only @latest', () => {
      const file = 'skill/references/evidence-workflows.md';
      const cases = [
        ['\nnpx -y rea-agents@next doctor\n', 'floating rea-agents@next'],
        ['\nrea-agents@beta\n', 'floating rea-agents@beta'],
        ['\nrea-agents@^6.7.0\n', 'floating rea-agents@^6.7.0'],
        ['\nrea-agents@6\n', 'floating rea-agents@6'],
        ['\nnpx -y rea-agents doctor\n', 'floating rea-agents'],
        ['\nnpm install -g rea-agents\n', 'floating rea-agents'],
      ];
      for (const [appended, message] of cases) {
        expect(addedBy(checkNoFloating, (t) => edit(abs(t, file), (s) => `${s}${appended}`)), message).toEqual([`${message} in ${file}`]);
        expect(addedBy(checkNoFloating, (t) => edit(t.commandFile, (s) => `${s}${appended}`)), message).toEqual([`${message} in commands/rea.md`]);
      }
    });

    it('the documented placeholder is not floating, a look-alike is, and a bare name in prose is not', () => {
      const file = 'skill/references/evidence-workflows.md';
      expect(addedBy(checkNoFloating, (t) => edit(abs(t, file), (s) => `${s}\nsee rea-agents@x.y.z and the \`rea-agents\` package\n`))).toEqual([]);
      expect(addedBy(checkNoFloating, (t) => edit(abs(t, file), (s) => `${s}\nrea-agents@X.Y.Z\n`))).toEqual([`floating rea-agents@X.Y.Z in ${file}`]);
      // the live UPSTREAM.json spells the placeholder in its version-pin note, so the exemption is exercised on the real file
      expect(rd(path.join(LIVE.vendorDir, 'UPSTREAM.json'))).toContain('rea-agents@x.y.z');
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
      ['word joiner (first of U+2060-2064)', 0x2060],
      ['invisible times', 0x2062],
      ['invisible plus (last of U+2060-2064)', 0x2064],
      ['zero-width no-break space / BOM', 0xfeff],
      ['soft hyphen', 0x00ad],
      ['arabic letter mark', 0x061c],
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

    it('the code points next to each widened range are not hidden characters', () => {
      // U+205F medium space, U+2065 (unassigned), U+00AC not sign, U+00AE registered sign, U+061B / U+061D Arabic marks, U+FEFE, U+FF00
      const neighbours = [0x205f, 0x2065, 0x00ac, 0x00ae, 0x061b, 0x061d, 0xfefe, 0xff00];
      const text = neighbours.map((cp) => String.fromCodePoint(cp)).join(' ');
      expect(addedBy(checkHidden, (t) => edit(abs(t, 'skill/SKILL.md'), (s) => `${s}\n${text}\n`))).toEqual([]);
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

    it('a prefix rule is red, including the old doctor and dry-run forms (the appended-flags hole)', () => {
      for (const tool of [
        `Bash(npx -y rea-agents@${version()} doctor:*)`,
        `Bash(npx -y rea-agents@${version()} setup --client claude_code --dry-run:*)`,
        `Bash(npx -y rea-agents@${version()} doctor --client claude_code --json:*)`,
        `Bash(npx -y rea-agents@${version()} doctor --client claude_code --json *)`,
        `Bash(npx -y rea-agents@${version()} setup --client claude_code --dry-run --json *)`,
        'Bash(node --version *)',
        'Bash(node *)',
      ]) {
        expect(addedText(checkCommand, live(), withTool(live(), tool)), tool).toEqual([`allowed-tools pre-approves ${tool}`]);
      }
    });

    it('an exact string with something appended is red (--no-dry-run --yes smuggled behind --dry-run)', () => {
      for (const tool of [
        `Bash(npx -y rea-agents@${version()} setup --client claude_code --dry-run --no-dry-run --yes)`,
        `Bash(npx -y rea-agents@${version()} setup --client claude_code --dry-run --json --yes)`,
        `Bash(npx -y rea-agents@${version()} setup --client claude_code --dry-run --yes --json)`,
        `Bash(npx -y rea-agents@${version()} doctor --client claude_code --json --fix)`,
        `Bash(npx -y rea-agents@${version()} doctor --client codex --json)`,
        `Bash(npx -y rea-agents@latest doctor --client claude_code --json)`,
      ]) {
        expect(addedText(checkCommand, live(), withTool(live(), tool)), tool).toEqual([`allowed-tools pre-approves ${tool}`]);
      }
    });

    it('an MCP tool in allowed-tools is red: REA tools keep the host permission prompt, as upstream', () => {
      for (const tool of ['mcp__rea', 'mcp__rea__open_binary', 'mcp__rea__*']) {
        const added = addedText(checkCommand, live(), withTool(live(), tool));
        expect(added, tool).toHaveLength(1);
        expect(added[0], tool).toMatch(new RegExp(`^allowed-tools pre-approves ${tool.replace(/[*]/g, '\\*')} \\(REA tools go through the host permission prompt`));
      }
      // the original form of this entry, put back at the end of the live list, is red too
      expect(addedText(checkCommand, live(), live().replace(/\]\n/, ', mcp__rea]\n'))).toHaveLength(1);
    });

    it('any tool nobody listed is red, not only Bash and MCP (Write, Edit, Glob, Agent)', () => {
      for (const tool of ['Write', 'Edit', 'Glob', 'Agent', 'WebFetch']) {
        expect(addedText(checkCommand, live(), withTool(live(), tool)), tool).toEqual([`allowed-tools pre-approves ${tool}`]);
      }
    });

    it('a bare Read, or a Read path wider than the installed skill folder, is red', () => {
      for (const tool of [
        'Read',
        'Read(*)',
        'Read(**)',
        'Read(~/**)',
        'Read(//**)',
        'Read(~/.claude/**)',
        'Read(~/.claude/skills/**)',
        'Read(~/.ssh/**)',
        'Read(./**)',
        'Read(~/.claude/skills/reverse-engineer-anything)',
        'Read(~/.claude/skills/reverse-engineer-anything/**/*.md)',
        'Read(${CLAUDE_PLUGIN_ROOT}/vendor/rea/skill/**)',
      ]) {
        expect(addedText(checkCommand, live(), withTool(live(), tool)), tool).toEqual([`allowed-tools pre-approves ${tool}`]);
      }
    });

    it('a pre-approved npx command that is not a fenced command verbatim is red', () => {
      const text = live();
      const doctor = `npx -y rea-agents@${version()} doctor --client claude_code --json`;
      const withoutFence = text.split('\n').filter((l) => l.trim() !== doctor).join('\n');
      expect(withoutFence).not.toBe(text);
      expect(addedText(checkCommand, text, withoutFence)).toEqual([`pre-approved command is not a fenced command verbatim: ${doctor}`]);
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

    it('the CLI fallback is allowlisted only as the redirected chain: a bare --json, a real path, an append, a pipe or another script is red', () => {
      const v = version();
      for (const line of [
        `npx -y rea-agents@${v} analyze-javascript-application <절대경로> --json`,
        `npx -y rea-agents@${v} analyze-javascript-application <절대경로> --json > /tmp/evidence.json`,
        `npx -y rea-agents@${v} analyze-javascript-application <절대경로> --json >> <증거파일>`,
        `npx -y rea-agents@${v} analyze-javascript-application <절대경로> --json > <증거파일> && rm -rf <절대경로>`,
        `npx -y rea-agents@${v} analyze-javascript-application <절대경로> --json | tee <증거파일>`,
        `npx -y rea-agents@${v} analyze-javascript-application /home/me/app --json > <증거파일>`,
        `npx -y rea-agents@${v} inspect-analysis-view /tmp/request.json`,
        `npx -y rea-agents@${v} inspect-analysis-view <요청파일> --export`,
        'node "${CLAUDE_PLUGIN_ROOT}/scripts/rea/other.mjs" <증거파일> <요청파일>',
        'node "${CLAUDE_PLUGIN_ROOT}/scripts/rea/make-view-request.mjs" /tmp/e.json /tmp/r.json',
        'node -e "process.exit(0)"',
      ]) {
        expect(addedText(checkCommand, live(), withFence(live(), line)), line).toEqual([`fenced command not on the allowlist: ${line}`]);
      }
    });

    it('the CLI fallback must stay a chain: analyze, then make-view-request, then inspect-analysis-view', () => {
      const v = version();
      const analyze = `npx -y rea-agents@${v} analyze-javascript-application <절대경로> --json > <증거파일>`;
      const wrap = 'node "${CLAUDE_PLUGIN_ROOT}/scripts/rea/make-view-request.mjs" <증거파일> <요청파일>';
      const view = `npx -y rea-agents@${v} inspect-analysis-view <요청파일>`;
      const message = 'CLI fallback must run analyze, then make-view-request, then inspect-analysis-view';
      const text = live();
      const lines = text.split('\n');
      const at = (cmd) => lines.findIndex((l) => l.trim() === cmd);
      // positive control: the live file really holds the three lines, in this order
      expect(at(analyze)).toBeGreaterThan(-1);
      expect(at(wrap)).toBeGreaterThan(at(analyze));
      expect(at(view)).toBeGreaterThan(at(wrap));
      for (const dropped of [[wrap], [view], [wrap, view]]) {
        const without = lines.filter((l) => !dropped.includes(l.trim())).join('\n');
        expect(without, dropped.join()).not.toBe(text);
        expect(addedText(checkCommand, text, without), dropped.join()).toEqual([message]);
      }
      const swapped = [...lines];
      [swapped[at(wrap)], swapped[at(view)]] = [lines[at(view)], lines[at(wrap)]];
      expect(addedText(checkCommand, text, swapped.join('\n'))).toEqual([message]);
    });

    it('wrapping a report table in a code fence is red: fenced lines are commands', () => {
      const row = '| 기능 | n | n | n | n | n | % |';
      expect(addedText(checkCommand, live(), withFence(live(), row))).toEqual([`fenced command not on the allowlist: ${row}`]);
    });

    it('--yes before --dry-run, or --yes with no --dry-run at all, is red', () => {
      const text = live();
      const dry = `npx -y rea-agents@${version()} setup --client claude_code --dry-run --json`;
      const yes = `npx -y rea-agents@${version()} setup --client claude_code --yes`;
      // The dry-run command also sits in allowed-tools, so swap whole FENCE lines, not the first match.
      const lines = text.split('\n');
      const at = (cmd) => lines.findIndex((l) => l.trim() === cmd);
      expect(at(dry)).toBeGreaterThan(-1);
      expect(at(yes)).toBeGreaterThan(at(dry));
      const swappedLines = [...lines];
      [swappedLines[at(dry)], swappedLines[at(yes)]] = [lines[at(yes)], lines[at(dry)]];
      const swapped = swappedLines.join('\n');
      expect(swapped).not.toBe(text);
      expect(addedText(checkCommand, text, swapped)).toEqual(['--dry-run must come before --yes']);
      // With the dry-run fence line gone, its pre-approval no longer matches a fenced command either.
      const noDry = lines.filter((l) => l.trim() !== dry).join('\n');
      expect(noDry).not.toBe(text);
      expect(addedText(checkCommand, text, noDry)).toEqual([
        `pre-approved command is not a fenced command verbatim: ${dry}`,
        '--dry-run must come before --yes',
      ]);
    });

    it('allowed-tools that is not an inline list is red instead of skipped', () => {
      expect(checkCommand('---\ndescription: x\nallowed-tools:\n  - Read\n---\n').problems).toEqual(['allowed-tools is not an inline [..] list']);
      expect(checkCommand('no frontmatter\n').problems).toEqual(['allowed-tools is not an inline [..] list']);
    });

    it('reads allowed-tools with CRLF line endings the same way', () => {
      expect(checkCommand(live().replace(/\n/g, '\r\n')).problems).toEqual(checkCommand(live()).problems);
    });
  });

  describe('8. no instruction to type /rea', () => {
    const live = () => lf(rd(LIVE.commandFile));

    it('the two sentences this check was written for are red; the heading and a bare mention are not', () => {
      for (const sentence of [
        '원래 요청으로 `/rea` 를 다시 실행한다.',
        '그 전의 첫 진입은 이렇게 `/rea` 로 명시 호출한다.',
      ]) {
        expect(checkNoSlashInstruction(`# /rea\n\n${sentence}\n`).problems, sentence).toEqual([`rea.md tells the user to type /rea: ${sentence}`]);
        expect(addedText(checkNoSlashInstruction, live(), `${live()}\n${sentence}\n`), sentence).toHaveLength(1);
      }
      expect(checkNoSlashInstruction('# /rea\n\n/rea 는 이 커맨드의 이름이다.\n').problems).toEqual([]);
    });
  });

  describe('9. benchmarking checklist', () => {
    const live = () => lf(rd(LIVE.commandFile));
    const checklistRow = (line, axis) => line.startsWith(`| ${axis} |`) && line.split('|').length === 5;

    it('control: the live file is green', () => {
      expect(checkBenchmarkChecklist(live()).problems).toEqual([]);
    });

    it('a missing axis row, an empty cell, a renamed column or a lost formula is red', () => {
      const text = live();
      const lines = text.split('\n');
      for (const axis of AXES) {
        expect(lines.filter((l) => checklistRow(l, axis)), axis).toHaveLength(1);
        const dropped = lines.filter((l) => !checklistRow(l, axis)).join('\n');
        expect(addedText(checkBenchmarkChecklist, text, dropped), axis).toEqual([`checklist has no complete row for ${axis}`]);
        const emptied = lines.map((l) => (checklistRow(l, axis) ? `| ${axis} | 내용 |  |` : l)).join('\n');
        expect(addedText(checkBenchmarkChecklist, text, emptied), axis).toEqual([`checklist has no complete row for ${axis}`]);
      }
      const renamed = text.replace('관찰 불가 (사유와 함께 적는다)', '모름');
      expect(renamed).not.toBe(text);
      expect(addedText(checkBenchmarkChecklist, text, renamed)).toEqual(['checklist header lacks the 관찰 가능 / 관찰 불가 columns']);
      const formula = '답함 ÷ (전체 - 관찰 불가)';
      expect(text).toContain(formula);
      expect(addedText(checkBenchmarkChecklist, text, text.split(formula).join('x'))).toEqual([`coverage formula ${formula} is missing`]);
    });

    it('a file with no checklist at all is red on every count, not vacuously green', () => {
      expect(checkBenchmarkChecklist('# /rea\n').problems).toHaveLength(AXES.length + 2);
    });
  });
});
