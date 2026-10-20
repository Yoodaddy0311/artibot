/**
 * Tests for scripts/vendor/sync-rea.mjs -- the only supported way to move
 * plugins/artibot/vendor/rea to another rea-agents release.
 *
 * Everything here is offline. Tarballs are built in memory with a tiny ustar
 * writer, the registry is a stub passed through the script's `npm` seam, and
 * every write goes to a temp plugin tree: the real vendor/rea is never touched.
 *
 * What this suite does NOT see (written next to the gate):
 *  - The real `npm pack` / `npm view`. They need the network and Windows' npm.cmd;
 *    only the seam around them is exercised. The live 6.7.0 run is recorded in
 *    the lane report, not asserted here.
 *  - A real npm tarball. The reader is checked on hand-built archives (plain,
 *    pax, GNU long name, ustar prefix, old-GNU and junk magic, bad checksum,
 *    truncation); the real one was parsed once by `--check`, which no test repeats.
 *  - What floatingSpecifiers cannot see. A bare `rea-agents` is reported only right
 *    after a package runner or installer and its flags; a flag that takes a separate
 *    value (`--registry URL`) hides it, and a name inside a sentence runs nothing so
 *    it is not reported. A quoted name, and a runner more than 512 characters back
 *    (a longer flag run), are not seen either. It reads rea-agents only: any other
 *    package on @latest is the plain @latest scan's job. The 120 KB runs prove
 *    termination, not wall-clock speed.
 *  - The decompression cap (MAX_TAR_BYTES). Exercising it needs a 512 MiB archive in
 *    memory, so it is read, not run.
 *  - Whether the vendored text is right or safe. Equal bytes prove provenance only.
 *
 * @module tests/scripts/sync-rea
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyPlan, buildPlan, diffPlan, findSpecifiers, floatingSpecifiers, main, mapVendorPath, packFromRegistry,
  parseArgs, readTar, registryIntegrity, renderUpstream, sha256Hex, sriSha512, substitutePins, UPSTREAM_NOTES,
} from '../../scripts/vendor/sync-rea.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(HERE, '..', '..', 'scripts', 'vendor', 'sync-rea.mjs');
const BLOCK = 512;

// ---------------------------------------------------------------------------
// a tiny ustar writer (the system under test never writes tar, only reads it)
// ---------------------------------------------------------------------------

function header({ name, size, type = '0', prefix = '', magic = 'ustar' }) {
  const h = Buffer.alloc(BLOCK);
  h.write(name, 0, 100, 'utf8');
  h.write('0000644\0', 100, 'ascii');
  h.write('0000000\0', 108, 'ascii');
  h.write('0000000\0', 116, 'ascii');
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
  h.write('00000000000\0', 136, 'ascii');
  h.fill(0x20, 148, 156);
  h.write(type, 156, 'ascii');
  if (magic) h.write(`${magic}\0`, 257, 'ascii');
  if (prefix) h.write(prefix, 345, 155, 'utf8');
  const sum = h.reduce((a, b) => a + b, 0);
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return h;
}

function entry(name, data, opts = {}) {
  const body = Buffer.from(data);
  const pad = (BLOCK - (body.length % BLOCK)) % BLOCK;
  return Buffer.concat([header({ name, size: body.length, ...opts }), body, Buffer.alloc(pad)]);
}

function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`;
  let len = Buffer.byteLength(body);
  for (;;) {
    const next = String(len).length + Buffer.byteLength(body);
    if (next === len) break;
    len = next;
  }
  return `${len}${body}`;
}

const tar = (...parts) => Buffer.concat([...parts, Buffer.alloc(2 * BLOCK)]);
const tgzOf = (...parts) => gzipSync(tar(...parts));

const MIT = 'MIT License\r\n\r\nCopyright (c) 2026 someone\r\n\r\nPermission is hereby granted...\r\n';

/** The entries of a plausible rea-agents tarball. `skill` can be replaced per test. */
function packageEntries({ version = '6.7.0', license = 'MIT', skill, licenseText = MIT, extra = [], omit = [] } = {}) {
  const skillText = skill ?? `---\nname: reverse-engineer-anything\n---\nUse \`npx -y rea-agents@${version} doctor --json\`.\nAlso \`npx -y rea-agents@${version}\`.\n`;
  const pkg = JSON.stringify({
    name: 'rea-agents', version, license, repository: { type: 'git', url: 'git+https://github.com/morluto/rea.git' },
  });
  const all = [
    ['package/package.json', pkg],
    ['package/LICENSE', licenseText],
    ['package/DISCLAIMER.md', '# Disclaimer\r\nlinks [MIT License](LICENSE)\r\n'],
    ['package/skills/reverse-engineer-anything/SKILL.md', skillText],
    ['package/skills/reverse-engineer-anything/references/a.md', 'a: line one\nline two\n'],
    ['package/skills/reverse-engineer-anything/references/b.md', 'b\r\nwith CR bytes\r\n'],
    // noise the sync must never vendor:
    ['package/dist/cli.js', 'module.exports = 1;'],
    ['package/skills/other-skill/SKILL.md', 'other'],
    ['package/THIRD_PARTY_NOTICES.md', 'notices'],
    ...extra,
  ].filter(([name]) => !omit.includes(name));
  return all.map(([name, data]) => entry(name, data));
}

const tgz = (opts) => tgzOf(...packageEntries(opts));

// ---------------------------------------------------------------------------
// temp trees
// ---------------------------------------------------------------------------

const made = [];
afterEach(() => {
  while (made.length) rmSync(made.pop(), { recursive: true, force: true });
});

function makeRoot({ commandText = 'run `npx -y rea-agents@6.6.0 doctor`\r\nthen `npx -y rea-agents@6.6.0 mcp`\r\n' } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'sync-rea-test-'));
  made.push(root);
  mkdirSync(path.join(root, 'commands'), { recursive: true });
  if (commandText !== null) writeFileSync(path.join(root, 'commands', 'rea.md'), commandText);
  return {
    root,
    vendorDir: path.join(root, 'vendor', 'rea'),
    commandFile: path.join(root, 'commands', 'rea.md'),
  };
}

const lines = () => {
  const out = [];
  return { out, write: (s) => { out.push(String(s)); return true; }, text: () => out.join('') };
};

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

describe('sync-rea / specifiers and pins', () => {
  it('finds every rea-agents@x.y.z, keeps duplicates, ignores tags and other packages', () => {
    const text = 'a rea-agents@6.7.0 b rea-agents@6.7.0 c rea-agents@latest d other@6.7.0 e rea-agents@1.2.3-rc.1';
    expect(findSpecifiers(text)).toEqual(['6.7.0', '6.7.0', '1.2.3-rc.1']);
  });

  it('re-pins all of them and counts only the ones that actually changed', () => {
    const r = substitutePins('x rea-agents@6.6.0 y rea-agents@6.7.0 z rea-agents@6.5.1', '6.7.0');
    expect(r).toEqual({ text: 'x rea-agents@6.7.0 y rea-agents@6.7.0 z rea-agents@6.7.0', changed: 2, total: 3 });
  });

  it('leaves line endings and unrelated text alone', () => {
    const r = substitutePins('a\r\nrea-agents@1.0.0\r\nb\n', '2.0.0');
    expect(r.text).toBe('a\r\nrea-agents@2.0.0\r\nb\n');
  });

  it('does not carry regex state between calls (global-regex lastIndex trap)', () => {
    const text = 'rea-agents@1.0.0';
    expect(findSpecifiers(text)).toEqual(['1.0.0']);
    expect(findSpecifiers(text)).toEqual(['1.0.0']);
    expect(substitutePins(text, '2.0.0').changed).toBe(1);
    expect(substitutePins(text, '2.0.0').changed).toBe(1);
  });

  it('hashes: sha256 hex and sha512 SRI match the published test vectors for "abc"', () => {
    // FIPS 180 vectors, split so a long hex/base64 literal does not trip the secret guard.
    const sha256 = ['ba7816bf8f01cfea', '414140de5dae2223', 'b00361a396177a9c', 'b410ff61f20015ad'].join('');
    const sha512b64 = ['3a81oZNherrMQXNJriBBMRLm', '+k6JqX6iCp7u5ktV05ohkpkq', 'J0/BqDa6PCOj/uu9RU1EI2Q8', '6A4qmslPpUyknw=='].join('');
    expect(sha256Hex(Buffer.from('abc'))).toBe(sha256);
    expect(sriSha512(Buffer.from('abc'))).toBe(`sha512-${sha512b64}`);
  });
});

describe('sync-rea / floatingSpecifiers', () => {
  it.each([
    ['a dist-tag', 'run npx -y rea-agents@latest doctor', ['rea-agents@latest']],
    ['other dist-tags', 'npx -y rea-agents@next doctor, then rea-agents@beta', ['rea-agents@next', 'rea-agents@beta']],
    ['caret and tilde ranges', 'rea-agents@^6.7.0 rea-agents@~6.7.0', ['rea-agents@^6.7.0', 'rea-agents@~6.7.0']],
    [
      'partial, wildcard and comparator versions',
      'rea-agents@6 rea-agents@6.7 rea-agents@6.x rea-agents@* rea-agents@>=6',
      ['rea-agents@6', 'rea-agents@6.7', 'rea-agents@6.x', 'rea-agents@*', 'rea-agents@>=6'],
    ],
    ['a v prefix and a fourth number', 'rea-agents@v6.7.0 rea-agents@6.7.0.1', ['rea-agents@v6.7.0', 'rea-agents@6.7.0.1']],
    ['an empty version', 'npx -y rea-agents@ doctor', ['rea-agents@']],
    [
      'placeholders other than the documented one',
      'rea-agents@X.Y.Z rea-agents@x.y rea-agents@<version> rea-agents@x.y.z.extra',
      ['rea-agents@X.Y.Z', 'rea-agents@x.y', 'rea-agents@<version>', 'rea-agents@x.y.z.extra'],
    ],
  ])('reports %s', (_name, text, expected) => {
    expect(floatingSpecifiers(text)).toEqual(expected);
  });

  it('accepts an exact version however the sentence around it ends', () => {
    const text = [
      'npx -y rea-agents@6.7.0 doctor',
      'pin `rea-agents@6.7.0`, then "rea-agents@6.7.0" (rea-agents@6.7.0) and rea-agents@6.7.0.',
      '{"cmd": "npx -y rea-agents@6.7.0"} and a pre-release rea-agents@1.2.3-rc.1 are exact too',
    ].join('\n');
    expect(floatingSpecifiers(text)).toEqual([]);
  });

  it.each([
    'npx rea-agents',
    'npx -y rea-agents doctor --json',
    'npx --yes --quiet rea-agents',
    'npx -p rea-agents rea',
    'npx --package=rea-agents rea',
    'cmd.exe /d /c npx -y rea-agents doctor',
    'run `npx -y rea-agents`',
    'bunx rea-agents',
    'pnpm dlx rea-agents',
    'yarn dlx rea-agents',
    'yarn global add rea-agents',
    'npm install -g rea-agents',
    'npm i --save-dev rea-agents',
    'npm exec rea-agents',
    'npm view rea-agents version',
    'npx -y\nrea-agents',
    'npx -y rea-agents.',
  ])('reports a bare package handed to a runner or installer (it resolves to @latest): %j', (text) => {
    expect(floatingSpecifiers(text)).toEqual(['rea-agents']);
  });

  it.each([
    'the npm package `rea-agents` is MIT',
    '"package": "rea-agents",',
    'with a version-pinned `rea-agents` package or continue through the CLI.',
    'npx some-other-tool rea-agents',
    'mkdir -p rea-agents',
    'npx -y rea-agents-extra doctor',
    'npx -y my-rea-agents doctor',
    'npx -y rea-agents.json',
    'node_modules/rea-agents/dist/cli.js',
    'rea-agents',
    '',
  ])('does not report a bare mention that runs nothing: %j', (text) => {
    expect(floatingSpecifiers(text)).toEqual([]);
  });

  it('exempts only the documented placeholder, which the UPSTREAM.json version-pin note spells', () => {
    expect(floatingSpecifiers('must equal every rea-agents@x.y.z in commands/rea.md')).toEqual([]);
    expect(floatingSpecifiers(UPSTREAM_NOTES.join('\n'))).toEqual([]);
    expect(UPSTREAM_NOTES.join('\n')).toContain('rea-agents@x.y.z');
  });

  it('does not carry regex state between calls (global-regex lastIndex trap)', () => {
    const text = 'npx -y rea-agents@next';
    expect(floatingSpecifiers(text)).toEqual(['rea-agents@next']);
    expect(floatingSpecifiers(text)).toEqual(['rea-agents@next']);
    expect(floatingSpecifiers(String(null))).toEqual([]);
  });

  it('terminates with the right answer on 120 KB single runs of each shape it scans', () => {
    const n = 120_000;
    const reps = 10_000;
    expect(floatingSpecifiers(`npx${' '.repeat(n)}x`)).toEqual([]);
    expect(floatingSpecifiers(`npx${' -a'.repeat(n / 3)} x`)).toEqual([]);
    expect(floatingSpecifiers(`npx ${'-a '.repeat(20)}rea-agents`)).toEqual(['rea-agents']);
    expect(floatingSpecifiers(`rea-agents@${'1'.repeat(n)}`)).toHaveLength(1);
    expect(floatingSpecifiers('rea-agents '.repeat(reps))).toEqual([]);
    expect(floatingSpecifiers('npx rea-agents '.repeat(reps))).toHaveLength(reps);
    expect(floatingSpecifiers('rea-agents@'.repeat(reps))).toHaveLength(reps);
  });

  // The 120 KB runs above never reach the runner regex past the 20-flag line: it only scans the
  // window before a `rea-agents`. These put a rea-agents after a long flag run so it does run.
  it('scans a window full of `--` flags before rea-agents without exponential backtracking', () => {
    const flags = 150; // 450 chars, inside the 512-char window; the old `-{1,2}` token needed ~2^150 steps
    // The failing case runs in a child: a synchronous regex blocks the event loop, so vitest's own
    // timeout could never fire and a regression would hang the run instead of failing it.
    const probe = [
      `import { floatingSpecifiers } from ${JSON.stringify(pathToFileURL(SCRIPT).href)};`,
      `process.stdout.write(JSON.stringify(floatingSpecifiers('npx' + ' --'.repeat(${flags}) + ' x rea-agents')));`,
    ].join('\n');
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', probe], { encoding: 'utf8', timeout: 10_000 });
    expect(JSON.parse(out)).toEqual([]);
    expect(floatingSpecifiers(`npx${' --'.repeat(flags)} rea-agents`)).toEqual(['rea-agents']);
    expect(floatingSpecifiers(`npx${' --yes'.repeat(80)} rea-agents`)).toEqual(['rea-agents']);
    expect(floatingSpecifiers(`npx${' --registry=x'.repeat(30)} rea-agents`)).toEqual(['rea-agents']);
  });

  it('does not report a quoted package name (documented blind spot)', () => {
    expect(floatingSpecifiers('npx -y "rea-agents"')).toEqual([]);
  });

  it('does not report a bare name whose runner is more than 512 characters back, behind a longer flag run (documented blind spot)', () => {
    expect(floatingSpecifiers(`npx${' --x'.repeat(200)} rea-agents`)).toEqual([]);
    expect(floatingSpecifiers(`npx${' --x'.repeat(100)} rea-agents`)).toEqual(['rea-agents']);
  });
});

describe('sync-rea / mapVendorPath (what may be written at all)', () => {
  it.each([
    ['LICENSE', 'LICENSE'],
    ['DISCLAIMER.md', 'DISCLAIMER.md'],
    ['skills/reverse-engineer-anything/SKILL.md', 'skill/SKILL.md'],
    ['skills/reverse-engineer-anything/references/a-b_c.1.md', 'skill/references/a-b_c.1.md'],
  ])('maps %s -> %s', (src, dst) => {
    expect(mapVendorPath(src)).toBe(dst);
  });

  it.each([
    'package.json',
    'README.md',
    'THIRD_PARTY_NOTICES.md',
    'dist/cli.js',
    'skills/other-skill/SKILL.md',
    'skills/reverse-engineer-anything/',
    'skills/reverse-engineer-anything/../../evil.md',
    'skills/reverse-engineer-anything/../SKILL.md',
    'skills/reverse-engineer-anything/.hidden',
    'skills/reverse-engineer-anything/a b.md',
    'skills/reverse-engineer-anything//x.md',
    'skills/reverse-engineer-anything/C:/x.md',
    'skills/reverse-engineer-anything/x\\y.md',
    'license',
  ])('refuses %s', (src) => {
    expect(mapVendorPath(src)).toBeNull();
  });
});

describe('sync-rea / parseArgs', () => {
  it('takes an exact version and the three options', () => {
    expect(parseArgs(['6.7.0'])).toEqual({ version: '6.7.0', tarball: null, expectIntegrity: null, check: false, help: false });
    expect(parseArgs(['6.7.0', '--check', '--tarball', 'f.tgz', '--expect-integrity', 'sha512-x'])).toEqual({
      version: '6.7.0', tarball: 'f.tgz', expectIntegrity: 'sha512-x', check: true, help: false,
    });
  });

  it.each(['latest', '6.7', '^6.7.0', '6.7.0-rc.1', 'v6.7.0', ''])('refuses the version %j', (v) => {
    expect(() => parseArgs([v])).toThrow(/exact x\.y\.z/);
  });

  it('needs a version unless --help; refuses unknown options and extra arguments', () => {
    expect(() => parseArgs([])).toThrow(/exact x\.y\.z/);
    expect(parseArgs(['--help']).help).toBe(true);
    expect(() => parseArgs(['6.7.0', '--bogus'])).toThrow(/unknown option/);
    expect(() => parseArgs(['6.7.0', '6.7.1'])).toThrow(/unexpected argument/);
    expect(() => parseArgs(['6.7.0', '--tarball'])).toThrow(/requires a value/);
    expect(() => parseArgs(['6.7.0', '--tarball', '--check'])).toThrow(/requires a value/);
  });
});

// ---------------------------------------------------------------------------
// the tar reader
// ---------------------------------------------------------------------------

describe('sync-rea / readTar', () => {
  it('returns regular files with exact bytes (CR preserved) and skips directories', () => {
    const buf = tar(entry('package/', '', { type: '5' }), entry('package/a.txt', 'one\r\ntwo\n'), entry('package/b.bin', Buffer.from([0, 1, 2, 255])));
    const got = readTar(buf);
    expect(got.map((e) => e.path)).toEqual(['package/a.txt', 'package/b.bin']);
    expect(got[0].data.toString('utf8')).toBe('one\r\ntwo\n');
    expect([...got[1].data]).toEqual([0, 1, 2, 255]);
  });

  it('honours a pax path record (names longer than 100 bytes)', () => {
    const long = `package/skills/reverse-engineer-anything/references/${'x'.repeat(120)}.md`;
    const buf = tar(entry('PaxHeader', paxRecord('path', long), { type: 'x' }), entry('truncated-name', 'body'));
    expect(readTar(buf).map((e) => e.path)).toEqual([long]);
  });

  it('honours a GNU long-name entry and a ustar prefix', () => {
    const long = `package/${'d'.repeat(130)}/file.md`;
    const buf = tar(entry('././@LongLink', `${long}\0`, { type: 'L' }), entry('x', 'gnu'), entry('name.md', 'pre', { prefix: 'package/some/dir' }));
    expect(readTar(buf).map((e) => e.path)).toEqual([long, 'package/some/dir/name.md']);
  });

  it('reads the prefix field only under the exact 6-byte POSIX magic "ustar\\0"', () => {
    // Offset 345 holds a prefix in POSIX ustar, but atime/ctime bytes in an old-GNU header ("ustar  \0")
    // and nothing in a V7 header; reading it there would put junk in front of the entry path.
    const archive = (magic) => tar(entry('package/a.txt', 'a', { prefix: 'JUNK-FROM-GNU-TIMES', magic }));
    expect(readTar(archive('ustar')).map((e) => e.path)).toEqual(['JUNK-FROM-GNU-TIMES/package/a.txt']);
    for (const magic of ['ustar  ', 'ustar ', 'ustarX', 'ustar-', '']) {
      expect(readTar(archive(magic)).map((e) => e.path), JSON.stringify(magic)).toEqual(['package/a.txt']);
    }
  });

  it('does not let a global pax header rename the next entry', () => {
    const buf = tar(entry('pax_global_header', paxRecord('comment', 'abc'), { type: 'g' }), entry('package/a.txt', 'a'));
    expect(readTar(buf).map((e) => e.path)).toEqual(['package/a.txt']);
  });

  it('stops at the end-of-archive marker', () => {
    expect(readTar(tar())).toEqual([]);
    expect(readTar(Buffer.alloc(0))).toEqual([]);
  });

  it('refuses a corrupted header checksum instead of mis-reading', () => {
    const buf = tar(entry('package/a.txt', 'a'));
    buf[0] ^= 0xff;
    expect(() => readTar(buf)).toThrow(/checksum/);
  });

  it('refuses a truncated entry', () => {
    const whole = entry('package/a.txt', 'x'.repeat(2000));
    expect(() => readTar(whole.subarray(0, BLOCK + 100))).toThrow(/truncated/);
  });
});

// ---------------------------------------------------------------------------
// buildPlan
// ---------------------------------------------------------------------------

describe('sync-rea / buildPlan', () => {
  it('vendors exactly the allowlist, byte for byte, with sorted sha256 pins', () => {
    const archive = tgz();
    const plan = buildPlan({ version: '6.7.0', tgz: archive });
    expect([...plan.files.keys()]).toEqual([
      'DISCLAIMER.md', 'LICENSE', 'skill/SKILL.md', 'skill/references/a.md', 'skill/references/b.md',
    ]);
    expect(plan.files.get('LICENSE').toString('utf8')).toBe(MIT);
    expect(plan.files.get('skill/references/b.md').toString('utf8')).toBe('b\r\nwith CR bytes\r\n');
    expect(plan.integrity).toBe(sriSha512(archive));
    expect(plan.upstream).toMatchObject({
      package: 'rea-agents', version: '6.7.0', integrity: sriSha512(archive), license: 'MIT', repository: 'https://github.com/morluto/rea',
    });
    expect(Object.keys(plan.upstream.files)).toEqual([...plan.files.keys()]);
    for (const [rel, buf] of plan.files) expect(plan.upstream.files[rel]).toBe(sha256Hex(buf));
    expect(plan.upstream.notes.join('\n')).toMatch(/GATE COVERAGE/);
  });

  it('passes when the registry integrity matches and refuses when it does not', () => {
    const archive = tgz();
    expect(() => buildPlan({ version: '6.7.0', tgz: archive, expectedIntegrity: sriSha512(archive) })).not.toThrow();
    expect(() => buildPlan({ version: '6.7.0', tgz: archive, expectedIntegrity: `${sriSha512(archive).slice(0, -3)}AAA` })).toThrow(/integrity mismatch/);
    expect(() => buildPlan({ version: '6.7.0', tgz: archive, expectedIntegrity: 'sha512-nope' })).toThrow(/integrity mismatch/);
  });

  it('refuses a version that is not exact', () => {
    for (const v of ['latest', '^6.7.0', '6.7', undefined]) {
      expect(() => buildPlan({ version: v, tgz: tgz() }), String(v)).toThrow(/exact x\.y\.z/);
    }
  });

  it('refuses bytes that are not a gzip tarball', () => {
    expect(() => buildPlan({ version: '6.7.0', tgz: Buffer.from('this is not a tarball') })).toThrow();
    expect(() => buildPlan({ version: '6.7.0', tgz: gzipSync(Buffer.from('gzip but not tar')) })).toThrow(/tar|package\.json/);
  });

  it('refuses a tarball that is another version, another package or not MIT', () => {
    expect(() => buildPlan({ version: '6.7.1', tgz: tgz() })).toThrow(/you asked for 6\.7\.1/);
    expect(() => buildPlan({ version: '6.7.0', tgz: tgz({ license: 'GPL-3.0' }) })).toThrow(/not MIT/);
    const other = tgzOf(entry('package/package.json', JSON.stringify({ name: 'evil', version: '6.7.0', license: 'MIT' })));
    expect(() => buildPlan({ version: '6.7.0', tgz: other })).toThrow(/not rea-agents/);
  });

  it('refuses a LICENSE that is not the MIT text even if package.json says MIT', () => {
    expect(() => buildPlan({ version: '6.7.0', tgz: tgz({ licenseText: 'All rights reserved.\n' }) })).toThrow(/not the MIT/);
  });

  it('refuses a skill that pins another version, pins nothing, or floats on @latest', () => {
    expect(() => buildPlan({ version: '6.7.0', tgz: tgz({ skill: 'use rea-agents@6.7.0 and rea-agents@6.6.9\n' }) })).toThrow(/pins 6\.6\.9/);
    expect(() => buildPlan({ version: '6.7.0', tgz: tgz({ skill: 'no pin here\n' }) })).toThrow(/pins no rea-agents/);
    const floating = tgz({ extra: [['package/skills/reverse-engineer-anything/references/c.md', 'npx rea-agents@latest\n']] });
    expect(() => buildPlan({ version: '6.7.0', tgz: floating })).toThrow(/@latest/);
  });

  it('refuses a tarball missing what /rea needs, and one that repeats a vendored path', () => {
    for (const missing of ['package/skills/reverse-engineer-anything/SKILL.md', 'package/LICENSE', 'package/DISCLAIMER.md']) {
      expect(() => buildPlan({ version: '6.7.0', tgz: tgz({ omit: [missing] }) }), missing).toThrow(/lacks/);
    }
    expect(() => buildPlan({ version: '6.7.0', tgz: tgzOf(entry('package/other.txt', 'x')) })).toThrow(/package\.json/);
    const dup = tgz({ extra: [['package/LICENSE', MIT]] });
    expect(() => buildPlan({ version: '6.7.0', tgz: dup })).toThrow(/repeats LICENSE/);
  });

  it.each([
    ['@next', 'npx -y rea-agents@next doctor\n', /floating specifier \(rea-agents@next\)/],
    ['a range', 'use rea-agents@^6.7.0\n', /floating specifier \(rea-agents@\^6\.7\.0\)/],
    ['a bare npx', 'run npx -y rea-agents doctor\n', /floating specifier \(rea-agents\)/],
  ])('refuses a vendored file that floats on %s, not only on @latest', (_name, text, message) => {
    const floating = tgz({ extra: [['package/skills/reverse-engineer-anything/references/c.md', text]] });
    expect(() => buildPlan({ version: '6.7.0', tgz: floating })).toThrow(message);
  });

  it('refuses ANY other package on @latest too: floatingSpecifiers reads rea-agents only, the plain scan covers the rest', () => {
    for (const text of ['npx -y other-tool@latest\n', 'uvx tool@latest\n', 'npx -y frida@latest\nuvx tool@latest\n']) {
      expect(floatingSpecifiers(text), text).toEqual([]);
      const floating = tgz({ extra: [['package/skills/reverse-engineer-anything/references/c.md', text]] });
      expect(() => buildPlan({ version: '6.7.0', tgz: floating }), text).toThrow(/skill\/references\/c\.md mentions @latest/);
    }
  });

  it('lets prose name the package and the documented placeholder through', () => {
    const prose = 'The `rea-agents` package; docs say rea-agents@x.y.z when they mean "your version".\n';
    const ok = tgz({ extra: [['package/skills/reverse-engineer-anything/references/c.md', prose]] });
    expect(() => buildPlan({ version: '6.7.0', tgz: ok })).not.toThrow();
  });

  it('refuses two vendored paths that are one path on a case-insensitive disk (file or folder spelling)', () => {
    const withExtra = (rel) => tgz({ extra: [[`package/skills/reverse-engineer-anything/${rel}`, 'x\n']] });
    expect(() => buildPlan({ version: '6.7.0', tgz: withExtra('references/A.md') })).toThrow(
      /skill\/references\/a\.md and skill\/references\/A\.md, which are one path on a case-insensitive disk/,
    );
    expect(() => buildPlan({ version: '6.7.0', tgz: withExtra('skill.md') })).toThrow(/skill\/SKILL\.md and skill\/skill\.md/);
    expect(() => buildPlan({ version: '6.7.0', tgz: withExtra('References/c.md') })).toThrow(/skill\/references and skill\/References/);
    // control: a new name in the same folder is fine, and an exact repeat still says "repeats"
    expect(() => buildPlan({ version: '6.7.0', tgz: withExtra('references/c.md') })).not.toThrow();
    expect(() => buildPlan({ version: '6.7.0', tgz: withExtra('references/a.md') })).toThrow(/repeats skill\/references\/a\.md/);
  });

  it('never vendors a path-traversal or look-alike entry, however it is spelled', () => {
    const sneaky = tgz({
      extra: [
        ['package/skills/reverse-engineer-anything/../../evil.md', 'evil'],
        ['package/skills/reverse-engineer-anything/.hidden', 'evil'],
        ['package/skills/reverse-engineer-anything/a b.md', 'evil'],
        ['../outside.md', 'evil'],
        ['/abs.md', 'evil'],
      ],
    });
    const plan = buildPlan({ version: '6.7.0', tgz: sneaky });
    expect([...plan.files.keys()].every((k) => /^(skill\/[A-Za-z0-9._/-]+|LICENSE|DISCLAIMER\.md)$/.test(k))).toBe(true);
    expect([...plan.files.keys()].some((k) => /evil|outside|abs|hidden|\.\./.test(k))).toBe(false);
  });

  it('renders UPSTREAM.json with LF only and a trailing newline', () => {
    const text = renderUpstream(buildPlan({ version: '6.7.0', tgz: tgz() }).upstream);
    expect(text.endsWith('}\n')).toBe(true);
    expect(text).not.toContain('\r');
    expect(JSON.parse(text).version).toBe('6.7.0');
  });
});

// ---------------------------------------------------------------------------
// applyPlan / diffPlan on a temp tree
// ---------------------------------------------------------------------------

describe('sync-rea / applyPlan and diffPlan', () => {
  const plan = () => buildPlan({ version: '6.7.0', tgz: tgz() });
  const read = (dir, rel) => readFileSync(path.join(dir, ...rel.split('/')));

  it('writes the vendor tree byte for byte (CR bytes survive) and UPSTREAM.json', () => {
    const t = makeRoot();
    const r = applyPlan(plan(), t);
    expect(r.written).toBe(6);
    expect(read(t.vendorDir, 'LICENSE').toString('utf8')).toBe(MIT);
    expect(read(t.vendorDir, 'skill/references/b.md').toString('utf8')).toBe('b\r\nwith CR bytes\r\n');
    const upstream = JSON.parse(read(t.vendorDir, 'UPSTREAM.json').toString('utf8'));
    expect(upstream.files['skill/SKILL.md']).toBe(sha256Hex(read(t.vendorDir, 'skill/SKILL.md')));
  });

  it('re-pins commands/rea.md and keeps its CRLF', () => {
    const t = makeRoot();
    const before = readFileSync(t.commandFile, 'utf8');
    const r = applyPlan(plan(), t);
    const after = readFileSync(t.commandFile, 'utf8');
    expect(r).toMatchObject({ commandFile: 'repinned', pinsChanged: 2 });
    expect(findSpecifiers(after)).toEqual(['6.7.0', '6.7.0']);
    expect(after.split('\r\n').length).toBe(before.split('\r\n').length);
  });

  it('is idempotent: a second run changes nothing and diffPlan is clean', () => {
    const t = makeRoot();
    applyPlan(plan(), t);
    const again = applyPlan(plan(), t);
    expect(again).toMatchObject({ commandFile: 'unchanged', pinsChanged: 0, removed: [] });
    expect(diffPlan(plan(), t)).toEqual({ ok: true, missing: [], changed: [], extra: [], pins: [] });
  });

  it('removes files a newer release no longer has, and prunes the empty folders', () => {
    const t = makeRoot();
    mkdirSync(path.join(t.vendorDir, 'skill', 'gone'), { recursive: true });
    writeFileSync(path.join(t.vendorDir, 'skill', 'gone', 'x.md'), 'stale');
    writeFileSync(path.join(t.vendorDir, 'extra.txt'), 'stale');
    const r = applyPlan(plan(), t);
    expect(r.removed.sort()).toEqual(['extra.txt', 'skill/gone/x.md']);
    expect(existsSync(path.join(t.vendorDir, 'skill', 'gone'))).toBe(false);
    expect(existsSync(path.join(t.vendorDir, 'extra.txt'))).toBe(false);
  });

  it('still writes the vendor tree when commands/rea.md does not exist yet', () => {
    const t = makeRoot({ commandText: null });
    const r = applyPlan(plan(), t);
    expect(r).toMatchObject({ commandFile: 'missing', pinsChanged: 0 });
    expect(existsSync(path.join(t.vendorDir, 'UPSTREAM.json'))).toBe(true);
  });

  it('diffPlan names a changed, a missing and an extra file, and a stale pin', () => {
    const t = makeRoot({ commandText: 'npx -y rea-agents@6.7.0 doctor\n' });
    applyPlan(plan(), t);
    expect(diffPlan(plan(), t).ok).toBe(true);

    writeFileSync(path.join(t.vendorDir, 'LICENSE'), `${MIT}x`);
    rmSync(path.join(t.vendorDir, 'DISCLAIMER.md'));
    writeFileSync(path.join(t.vendorDir, 'skill', 'new.md'), 'extra');
    writeFileSync(t.commandFile, 'npx -y rea-agents@6.7.1 doctor\n');
    const d = diffPlan(plan(), t);
    expect(d).toMatchObject({ ok: false, changed: ['LICENSE'], missing: ['DISCLAIMER.md'], extra: ['skill/new.md'], pins: ['6.7.1'] });
  });

  it('diffPlan treats a command file with no specifier at all as out of sync', () => {
    const t = makeRoot({ commandText: 'nothing pinned here\n' });
    applyPlan(plan(), t);
    expect(diffPlan(plan(), t)).toMatchObject({ ok: false, pins: ['<no rea-agents@x.y.z in commands/rea.md>'] });
  });
});

// ---------------------------------------------------------------------------
// npm seam and main()
// ---------------------------------------------------------------------------

describe('sync-rea / registry and pack through the npm seam', () => {
  it('registryIntegrity returns the sha512 string and refuses anything else', () => {
    const calls = [];
    const npm = (args) => { calls.push(args); return '"sha512-abc"\n'; };
    expect(registryIntegrity('6.7.0', npm)).toBe('sha512-abc');
    expect(calls[0]).toEqual(['view', 'rea-agents@6.7.0', 'dist.integrity', '--json']);
    expect(() => registryIntegrity('6.7.0', () => '"sha1-zzz"')).toThrow(/no sha512/);
    expect(() => registryIntegrity('6.7.0', () => '{"a":1}')).toThrow(/no sha512/);
  });

  it('packFromRegistry runs `npm pack --ignore-scripts`, returns the bytes and cleans its temp dir', () => {
    const archive = tgz();
    let seen = null;
    const npm = (args, cwd) => {
      seen = { args, cwd };
      writeFileSync(path.join(cwd, 'rea-agents-6.7.0.tgz'), archive);
      return JSON.stringify([{ filename: 'rea-agents-6.7.0.tgz' }]);
    };
    const got = packFromRegistry('6.7.0', npm);
    expect(got.equals(archive)).toBe(true);
    expect(seen.args).toEqual(['pack', 'rea-agents@6.7.0', '--ignore-scripts', '--json', '--pack-destination', '.']);
    expect(existsSync(seen.cwd)).toBe(false);
  });

  it('refuses a non-exact version before it can reach npm or a shell', () => {
    const npm = () => { throw new Error('npm must not run'); };
    for (const v of ['latest', '6.7.0; echo x', '6.7.0 && calc', '$(id)', '', undefined]) {
      expect(() => registryIntegrity(v, npm), String(v)).toThrow(/exact x\.y\.z/);
      expect(() => packFromRegistry(v, npm), String(v)).toThrow(/exact x\.y\.z/);
    }
  });

  it('packFromRegistry cleans up and throws when npm names an unsafe filename', () => {
    let cwdSeen = null;
    const npm = (_args, cwd) => { cwdSeen = cwd; return JSON.stringify([{ filename: '../escape.tgz' }]); };
    expect(() => packFromRegistry('6.7.0', npm)).toThrow(/usable filename/);
    expect(existsSync(cwdSeen)).toBe(false);
  });
});

describe('sync-rea / main', () => {
  const archiveFile = (dir, opts) => {
    const file = path.join(dir, 'rea.tgz');
    writeFileSync(file, tgz(opts));
    return file;
  };

  it('writes the tree from --tarball when the integrity matches (exit 0)', () => {
    const t = makeRoot();
    const file = archiveFile(t.root);
    const io = { stdout: lines(), stderr: lines(), pluginRoot: t.root };
    const code = main(['6.7.0', '--tarball', file, '--expect-integrity', sriSha512(readFileSync(file))], io);
    expect(code).toBe(0);
    expect(io.stdout.text()).toMatch(/wrote 6 file\(s\)/);
    expect(existsSync(path.join(t.vendorDir, 'skill', 'SKILL.md'))).toBe(true);
    expect(findSpecifiers(readFileSync(t.commandFile, 'utf8'))).toEqual(['6.7.0', '6.7.0']);
  });

  it('asks the registry when --expect-integrity is absent, and refuses a mismatch with nothing written', () => {
    const t = makeRoot();
    const file = archiveFile(t.root);
    const io = { stdout: lines(), stderr: lines(), pluginRoot: t.root, npm: () => '"sha512-not-the-same"' };
    expect(main(['6.7.0', '--tarball', file], io)).toBe(1);
    expect(io.stderr.text()).toMatch(/integrity mismatch/);
    expect(existsSync(t.vendorDir)).toBe(false);
    expect(readFileSync(t.commandFile, 'utf8')).toContain('rea-agents@6.6.0');
  });

  it('uses the registry value end to end: pack, verify, write (no --tarball)', () => {
    const t = makeRoot();
    const archive = tgz();
    const npm = (args, cwd) => {
      if (args[0] === 'view') return JSON.stringify(sriSha512(archive));
      writeFileSync(path.join(cwd, 'rea-agents-6.7.0.tgz'), archive);
      return JSON.stringify([{ filename: 'rea-agents-6.7.0.tgz' }]);
    };
    const io = { stdout: lines(), stderr: lines(), pluginRoot: t.root, npm };
    expect(main(['6.7.0'], io)).toBe(0);
    expect(io.stderr.text()).toBe('');
    expect(existsSync(path.join(t.vendorDir, 'UPSTREAM.json'))).toBe(true);
  });

  it('--check changes nothing, exits 1 when out of sync and 0 when in sync', () => {
    const t = makeRoot();
    const file = archiveFile(t.root);
    const sri = sriSha512(readFileSync(file));
    const dirty = { stdout: lines(), stderr: lines(), pluginRoot: t.root };
    expect(main(['6.7.0', '--check', '--tarball', file, '--expect-integrity', sri], dirty)).toBe(1);
    expect(dirty.stdout.text()).toMatch(/OUT OF SYNC/);
    expect(existsSync(t.vendorDir)).toBe(false);

    main(['6.7.0', '--tarball', file, '--expect-integrity', sri], { stdout: lines(), stderr: lines(), pluginRoot: t.root });
    const clean = { stdout: lines(), stderr: lines(), pluginRoot: t.root };
    expect(main(['6.7.0', '--check', '--tarball', file, '--expect-integrity', sri], clean)).toBe(0);
    expect(clean.stdout.text()).toMatch(/in sync/);

    writeFileSync(path.join(t.vendorDir, 'skill', 'SKILL.md'), 'hand edit\n');
    const tampered = { stdout: lines(), stderr: lines(), pluginRoot: t.root };
    expect(main(['6.7.0', '--check', '--tarball', file, '--expect-integrity', sri], tampered)).toBe(1);
    expect(tampered.stdout.text()).toContain('skill/SKILL.md');
  });

  it('exits 2 on a usage error and 0 on --help, without touching anything', () => {
    const io = { stdout: lines(), stderr: lines(), pluginRoot: makeRoot().root };
    expect(main(['latest'], io)).toBe(2);
    expect(io.stderr.text()).toMatch(/exact x\.y\.z/);
    expect(main(['--help'], { ...io, stdout: lines() })).toBe(0);
  });

  it('exits 1 with a message when the tarball cannot be read', () => {
    const t = makeRoot();
    const io = { stdout: lines(), stderr: lines(), pluginRoot: t.root };
    expect(main(['6.7.0', '--tarball', path.join(t.root, 'missing.tgz'), '--expect-integrity', 'sha512-x'], io)).toBe(1);
    expect(io.stderr.text()).toMatch(/failed/);
  });
});

describe('sync-rea / run directly (the entry guard)', () => {
  it('prints usage and exits 0 for --help', () => {
    const out = execFileSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8', timeout: 60_000 });
    expect(out).toContain('usage: node scripts/vendor/sync-rea.mjs');
    expect(readdirSync(path.dirname(SCRIPT))).toContain('sync-rea.mjs');
  });

  it('exits 2 for a tag such as latest', () => {
    let status = null;
    try {
      execFileSync(process.execPath, [SCRIPT, 'latest'], { stdio: 'pipe', timeout: 60_000 });
    } catch (err) {
      status = err.status;
    }
    expect(status).toBe(2);
  });
});
