/**
 * Tests for scripts/rea/make-view-request.mjs -- the jq-free way to turn the
 * `rea-agents` CLI evidence file into an `inspect-analysis-view` request, the
 * one step of upstream's large-output recipe that needs a JSON tool.
 *
 * Everything here is offline: it writes only to temp dirs and never runs npx.
 *
 * What this suite does NOT see (written next to the gate):
 *  - That REA accepts the request. `inspect-analysis-view` is not run here (it
 *    needs npx and the network); only the shape of the upstream recipe is pinned:
 *    {source: {kind: "inline", evidence}, view: {kind: "summary"}}.
 *  - A real Evidence record. Fixtures are hand-made objects; the largest one is
 *    about 16 MB, a real analysis of a large app can be bigger.
 *  - V8's string limit (about 512 MB). Reading it would need a file that size, so
 *    the "fails with the engine's message" path is read, not run.
 *  - Windows PowerShell 5.1 itself. The UTF-16 refusal is tested on the bytes it
 *    produces, not on a live `>` redirect.
 *
 * @module tests/scripts/make-view-request
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildViewRequest, DEFAULT_VIEW, main, parseArgs, parseView,
} from '../../scripts/rea/make-view-request.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(HERE, '..', '..', 'scripts', 'rea', 'make-view-request.mjs');

const made = [];
afterEach(() => {
  while (made.length) rmSync(made.pop(), { recursive: true, force: true });
});

function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'make-view-request-test-'));
  made.push(dir);
  return dir;
}

const lines = () => {
  const out = [];
  return { out, write: (s) => { out.push(String(s)); return true; }, text: () => out.join('') };
};

const EVIDENCE = { evidence_id: 'ev_abc', operation: 'analyze_javascript_application', normalized_result: { modules: [{ path: 'main.js' }] } };
const evidenceText = (value = EVIDENCE) => JSON.stringify(value, null, 2);

// ---------------------------------------------------------------------------
// the transform
// ---------------------------------------------------------------------------

describe('make-view-request / buildViewRequest', () => {
  it('wraps the evidence the way upstream\'s jq filter does, summary view by default', () => {
    const text = buildViewRequest(evidenceText());
    expect(JSON.parse(text)).toEqual({ source: { kind: 'inline', evidence: EVIDENCE }, view: { kind: 'summary' } });
    expect(Object.keys(JSON.parse(text))).toEqual(['source', 'view']);
    expect(text.startsWith('{"source":{"kind":"inline","evidence":{')).toBe(true);
    expect(text.endsWith('}\n')).toBe(true);
    expect(text.indexOf('\n')).toBeGreaterThan(0);
    expect(DEFAULT_VIEW).toEqual({ kind: 'summary' });
  });

  it('copies the evidence text instead of re-serializing it (numbers and escapes stay byte-identical)', () => {
    const raw = '{"a": 1.0, "b": 1e3, "big": 18446744073709551615, "e": "\\u00e9", "s": "a\\/b", "z": -0}';
    const text = buildViewRequest(raw);
    for (const literal of ['1.0', '1e3', '18446744073709551615', '"\\u00e9"', '"a\\/b"', '-0']) {
      expect(text, literal).toContain(literal);
    }
    expect(text).toContain(raw);
  });

  it('takes bytes as well as text, drops a UTF-8 BOM and the whitespace around the object', () => {
    const body = evidenceText();
    const want = buildViewRequest(body);
    expect(buildViewRequest(Buffer.from(body))).toBe(want);
    expect(buildViewRequest(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body)]))).toBe(want);
    expect(buildViewRequest(`\r\n  ${body}\r\n\r\n`)).toBe(want);
  });

  it('asks for the view it is given, verbatim', () => {
    const view = { kind: 'page', collection: 'modules', offset: 0, limit: 16 };
    expect(JSON.parse(buildViewRequest(evidenceText(), view)).view).toEqual(view);
  });

  it.each([
    ['an empty file', '', /not JSON/],
    ['plain text', 'error: could not read the path', /not JSON/],
    ['truncated JSON', '{"evidence_id": "ev_abc", "normalized_result": {', /not JSON/],
    ['two objects in a row', '{} {}', /not JSON/],
    ['a JSON array', '[1, 2]', /one JSON object/],
    ['null', 'null', /one JSON object/],
    ['a number', '42', /one JSON object/],
    ['a string', '"x"', /one JSON object/],
  ])('refuses %s as evidence', (_name, text, message) => {
    expect(() => buildViewRequest(text)).toThrow(message);
  });

  it('refuses UTF-16 output (what Windows PowerShell 5.1 redirection writes) and says how to redo it', () => {
    const utf16le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(evidenceText(), 'utf16le')]);
    const utf16be = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(evidenceText(), 'utf16le').swap16()]);
    for (const bytes of [utf16le, utf16be]) {
      expect(() => buildViewRequest(bytes)).toThrow(/UTF-16.*POSIX shell/);
    }
  });

  it('handles an evidence file of about 16 MB (real analyses are large)', () => {
    const modules = Array.from({ length: 4 }, (_, i) => ({ id: i, text: 'x'.repeat(1024 * 1024) }));
    const filler = Array.from({ length: 12 }, () => 'y'.repeat(1024 * 1024));
    const big = JSON.stringify({ evidence_id: 'ev_big', modules, filler });
    expect(big.length).toBeGreaterThan(16 * 1024 * 1024);
    const request = JSON.parse(buildViewRequest(big));
    expect(request.source.evidence.evidence_id).toBe('ev_big');
    expect(request.source.evidence.filler).toHaveLength(12);
    expect(request.view).toEqual({ kind: 'summary' });
  });
});

describe('make-view-request / parseView', () => {
  it('accepts any JSON object with a string kind', () => {
    expect(parseView('{"kind":"summary"}')).toEqual({ kind: 'summary' });
    expect(parseView('{"kind":"javascript","collection":"modules","where":{"path":"main.js"},"limit":16}')).toMatchObject({ kind: 'javascript', limit: 16 });
  });

  it.each([
    ['text that is not JSON', 'summary', /not JSON/],
    ['an array', '[{"kind":"summary"}]', /JSON object with a string "kind"/],
    ['null', 'null', /JSON object with a string "kind"/],
    ['an object without kind', '{"collection":"modules"}', /JSON object with a string "kind"/],
    ['an empty kind', '{"kind":""}', /JSON object with a string "kind"/],
    ['a non-string kind', '{"kind":7}', /JSON object with a string "kind"/],
  ])('refuses %s', (_name, text, message) => {
    expect(() => parseView(text)).toThrow(message);
  });
});

// ---------------------------------------------------------------------------
// arguments and main()
// ---------------------------------------------------------------------------

describe('make-view-request / parseArgs', () => {
  it('takes the evidence path, the request path and an optional --view', () => {
    expect(parseArgs(['e.json', 'r.json'])).toEqual({ evidence: 'e.json', request: 'r.json', view: null, help: false });
    expect(parseArgs(['e.json', 'r.json', '--view', '{"kind":"x"}'])).toEqual({ evidence: 'e.json', request: 'r.json', view: '{"kind":"x"}', help: false });
    expect(parseArgs(['--help']).help).toBe(true);
  });

  it('refuses a missing path, an extra argument, an unknown option and --view without a value', () => {
    expect(() => parseArgs([])).toThrow(/need an evidence file and a request file/);
    expect(() => parseArgs(['e.json'])).toThrow(/need an evidence file and a request file/);
    expect(() => parseArgs(['e.json', 'r.json', 'x.json'])).toThrow(/unexpected argument/);
    expect(() => parseArgs(['e.json', 'r.json', '--bogus'])).toThrow(/unknown option/);
    expect(() => parseArgs(['e.json', 'r.json', '--view'])).toThrow(/requires a value/);
    expect(() => parseArgs(['e.json', 'r.json', '--view', '--help'])).toThrow(/requires a value/);
  });

  it('refuses to write the request over the evidence file', () => {
    expect(() => parseArgs(['same.json', 'same.json'])).toThrow(/same file/);
    expect(() => parseArgs(['dir/a.json', 'dir/../dir/a.json'])).toThrow(/same file/);
  });
});

describe('make-view-request / main', () => {
  const setup = (text = evidenceText()) => {
    const dir = tempDir();
    const evidence = path.join(dir, 'evidence.json');
    const request = path.join(dir, 'request.json');
    writeFileSync(evidence, text);
    return { dir, evidence, request };
  };

  it('writes the request file and leaves the evidence file untouched (exit 0)', () => {
    const t = setup();
    const before = readFileSync(t.evidence);
    const io = { stdout: lines(), stderr: lines() };
    expect(main([t.evidence, t.request], io)).toBe(0);
    expect(io.stderr.text()).toBe('');
    expect(io.stdout.text()).toContain('view: summary');
    expect(JSON.parse(readFileSync(t.request, 'utf8'))).toEqual({ source: { kind: 'inline', evidence: EVIDENCE }, view: { kind: 'summary' } });
    expect(readFileSync(t.evidence).equals(before)).toBe(true);
  });

  it('writes the view asked for with --view', () => {
    const t = setup();
    const view = '{"kind":"item","collection":"modules","selector":{"node_id":"jag_node_X"}}';
    expect(main([t.evidence, t.request, '--view', view], { stdout: lines(), stderr: lines() })).toBe(0);
    expect(JSON.parse(readFileSync(t.request, 'utf8')).view).toEqual(JSON.parse(view));
  });

  it('replaces an earlier request at the same path (one request file, many views)', () => {
    const t = setup();
    const io = () => ({ stdout: lines(), stderr: lines() });
    expect(main([t.evidence, t.request], io())).toBe(0);
    expect(main([t.evidence, t.request, '--view', '{"kind":"page","collection":"modules","offset":0,"limit":4}'], io())).toBe(0);
    expect(JSON.parse(readFileSync(t.request, 'utf8')).view.kind).toBe('page');
  });

  it('exits 1 and writes nothing when the evidence is unreadable, not JSON or not an object', () => {
    for (const text of ['{"cut off":', '[1]', '']) {
      const t = setup(text);
      const io = { stdout: lines(), stderr: lines() };
      expect(main([t.evidence, t.request], io), JSON.stringify(text)).toBe(1);
      expect(io.stderr.text()).toMatch(/failed: evidence file/);
      expect(existsSync(t.request)).toBe(false);
    }
    const t = setup();
    const missing = { stdout: lines(), stderr: lines() };
    expect(main([path.join(t.dir, 'nope.json'), t.request], missing)).toBe(1);
    expect(missing.stderr.text()).toMatch(/failed/);
    expect(existsSync(t.request)).toBe(false);
  });

  it('exits 1 and keeps an earlier request when the new view is invalid', () => {
    const t = setup();
    const io = () => ({ stdout: lines(), stderr: lines() });
    expect(main([t.evidence, t.request], io())).toBe(0);
    const earlier = readFileSync(t.request);
    const bad = io();
    expect(main([t.evidence, t.request, '--view', '{"nokind":1}'], bad)).toBe(1);
    expect(bad.stderr.text()).toMatch(/--view/);
    expect(readFileSync(t.request).equals(earlier)).toBe(true);
  });

  it('exits 2 on a usage error and 0 on --help, writing nothing', () => {
    const t = setup();
    const usage = { stdout: lines(), stderr: lines() };
    expect(main([t.evidence], usage)).toBe(2);
    expect(usage.stderr.text()).toMatch(/usage: node scripts\/rea\/make-view-request\.mjs/);
    const same = { stdout: lines(), stderr: lines() };
    expect(main([t.evidence, t.evidence], same)).toBe(2);
    expect(readFileSync(t.evidence, 'utf8')).toBe(evidenceText());
    const help = { stdout: lines(), stderr: lines() };
    expect(main(['--help'], help)).toBe(0);
    expect(help.stdout.text()).toMatch(/usage: node scripts\/rea\/make-view-request\.mjs/);
  });

  it.skipIf(process.platform === 'win32')('creates the request readable by its owner only (it embeds the whole evidence)', () => {
    const t = setup();
    expect(main([t.evidence, t.request], { stdout: lines(), stderr: lines() })).toBe(0);
    expect(statSync(t.request).mode & 0o777).toBe(0o600);
  });
});

// ---------------------------------------------------------------------------
// pure by construction, and run directly
// ---------------------------------------------------------------------------

describe('make-view-request / executes nothing', () => {
  it('imports only node:fs, node:path and the entry guard (no child_process, no network)', () => {
    const source = readFileSync(SCRIPT, 'utf8');
    const imports = [...source.matchAll(/^import\s[^;]*?from\s+'([^']+)';/gm)].map((m) => m[1]).sort();
    expect(imports).toEqual(['../hooks/_main-entry.js', 'node:fs', 'node:path']);
    expect(source).not.toMatch(/child_process|\bspawn(Sync)?\(|\bexec(File)?(Sync)?\(|\bfetch\(|node:https?|node:net\b|node:dgram/);
  });
});

describe('make-view-request / run directly (the entry guard)', () => {
  it('prints usage and exits 0 for --help', () => {
    const out = execFileSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8', timeout: 60_000 });
    expect(out).toContain('usage: node scripts/rea/make-view-request.mjs');
  });

  it('turns an evidence file into a request file when run as a process', () => {
    const dir = tempDir();
    const evidence = path.join(dir, 'evidence.json');
    const request = path.join(dir, 'request.json');
    writeFileSync(evidence, evidenceText());
    const out = execFileSync(process.execPath, [SCRIPT, evidence, request], { encoding: 'utf8', timeout: 60_000 });
    expect(out).toContain('wrote');
    expect(JSON.parse(readFileSync(request, 'utf8')).source.evidence).toEqual(EVIDENCE);
  });

  it('exits 2 for a missing request path', () => {
    let status = null;
    try {
      execFileSync(process.execPath, [SCRIPT, 'only-one.json'], { stdio: 'pipe', timeout: 60_000 });
    } catch (err) {
      status = err.status;
    }
    expect(status).toBe(2);
  });
});
