/**
 * Real-process contract for `scripts/ledger/loop-detection-census.mjs` — the read-only
 * CLI that reports how many loop detections the per-session `loop-state.json` files
 * (and the flat, sessionless one) hold, split by severity and tool.
 *
 * WHY THESE CASES SPAWN A PROCESS. The counting rule lives nowhere else:
 * `scripts/hooks/tool-tracker.js` WRITES the detection rows and never counts them.
 * Only a spawn shows the state-dir resolution, the exit codes, the stdout/stderr
 * split and the one property that matters most — that a census writes nothing.
 *
 * READ-ONLY IS ASSERTED, NOT DECLARED, the `tests/ledger/recovery-journal-census.test.js`
 * way: the source's import set is an ALLOWLIST (four specifiers), a writer-token scan
 * runs over the raw bytes, the scanner is shown to red on a fabricated writer, and the
 * fixture tree's bytes, sizes, mtimes and listing are snapshotted around a real spawn.
 *
 * WHAT THIS SCANNER CANNOT SEE (rules §9): import forms it does not parse (dynamic
 * `import()`, `createRequire`, re-exports), fs verbs outside `WRITER_TOKENS`, and the
 * transitive graph (`lib/core/platform.js` takes only `existsSync` from `node:fs`,
 * read 2026-10-23 — asserted here by name, not proven for every future edit).
 *
 * THE FIXTURES ARE NOT THE LIVE STATE DIR. Every detection row below was written by
 * this file; a green run says the arithmetic is right and nothing about any machine's
 * live count — which, until the 2026-10-23 flush fix, was zero files everywhere.
 *
 * @module tests/ledger/loop-detection-census
 */

import { spawnSync } from 'node:child_process';
import {
  mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveArtibotDir } from '../../lib/core/config.js';
import { RUNTIME_DIRNAME, SESSIONS_DIRNAME } from '../../lib/core/runtime-state.js';
import * as census from '../../scripts/ledger/loop-detection-census.mjs';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(PLUGIN_ROOT, 'scripts', 'ledger', 'loop-detection-census.mjs');

/** The exact key set the module header promises a caller can parse blind. */
const STDOUT_KEYS = [
  'ok', 'reason', 'inputPaths', 'measured_at', 'filesRead', 'parseFailures', 'sessions',
  'detections', 'byTool', 'topFingerprints', 'status',
];

let tmp;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'ldc-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** A state dir with a `runtime/sessions/` tree, created empty. */
function makeStateDir(name) {
  const dir = path.join(tmp, name);
  mkdirSync(path.join(dir, RUNTIME_DIRNAME, SESSIONS_DIRNAME), { recursive: true });
  return dir;
}

/** One detection row the way the hook writes it. */
function row(tool, severity, count, fp = 'abcdef012345') {
  return { ts: 1_700_000_000_000 + count, tool, severity, count, fingerprint_sha12: fp };
}

function writeSessionState(stateDir, sid, state) {
  const file = path.join(stateDir, RUNTIME_DIRNAME, SESSIONS_DIRNAME, sid, 'loop-state.json');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof state === 'string' ? state : `${JSON.stringify(state)}\n`, 'utf-8');
  return file;
}

function writeFlatState(stateDir, state) {
  const file = path.join(stateDir, 'loop-state.json');
  writeFileSync(file, typeof state === 'string' ? state : `${JSON.stringify(state)}\n`, 'utf-8');
  return file;
}

function run(argv, env = {}) {
  const out = spawnSync(process.execPath, [CLI, ...argv], {
    encoding: 'utf-8',
    env: { ...process.env, ...env },
    windowsHide: true,
  });
  let json = null;
  try { json = JSON.parse(out.stdout); } catch { /* left null; the caller asserts */ }
  return { status: out.status, stdout: out.stdout, stderr: out.stderr, json };
}

/** Every file under a directory, recursively: relative path → size, mtime, bytes. */
function snapshot(dir) {
  const snap = {};
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      const st = statSync(full);
      snap[path.relative(dir, full)] = { size: st.size, mtimeMs: st.mtimeMs, bytes: readFileSync(full, 'utf-8') };
    }
  };
  walk(dir);
  return snap;
}

// ---------------------------------------------------------------------------

/** The four specifiers the reader may import, and nothing else. */
const ALLOWED_SPECIFIERS = [
  'node:fs',
  'node:path',
  '../../lib/core/platform.js',
  '../hooks/_main-entry.js',
];

/** Spellings that would make this reader a writer. */
const WRITER_TOKENS = /writeFileSync|appendFileSync|mkdirSync|unlinkSync|rmSync|renameSync|atomicWriteSync|saveLoopState/;

function importSpecifiers(source) {
  const pattern = /(?:^|\n)\s*import\s*(?:[^;'"]*?from\s*)?['"]([^'"]+)['"]/g;
  return [...source.matchAll(pattern)].map((m) => m[1]);
}

function readOnlyFindings(source) {
  const findings = [];
  for (const spec of importSpecifiers(source)) {
    if (!ALLOWED_SPECIFIERS.includes(spec)) findings.push(`unlisted import: ${spec}`);
  }
  const writer = WRITER_TOKENS.exec(source);
  if (writer !== null) findings.push(`writer token: ${writer[0]}`);
  return findings;
}

describe('loop-detection-census CLI: it imports no writer', () => {
  const source = readFileSync(CLI, 'utf-8');

  it('imports exactly the four allowlisted specifiers and no writer token', () => {
    expect(importSpecifiers(source).sort()).toEqual([...ALLOWED_SPECIFIERS].sort());
    expect(readOnlyFindings(source)).toEqual([]);
  });

  it('takes only read verbs from node:fs', () => {
    const named = /import\s+\{([^}]*)\}\s+from\s+'node:fs'/.exec(source);
    expect(named).not.toBe(null);
    expect(named[1].split(',').map((n) => n.trim()).filter((n) => n !== ''))
      .toEqual(['readdirSync', 'readFileSync', 'statSync']);
  });

  it('does not import the hook that writes the files, nor the runtime-state module (which carries a remover)', () => {
    expect(importSpecifiers(source).filter((s) => s.includes('tool-tracker') || s.includes('runtime-state'))).toEqual([]);
  });

  it('SELF-TEST: the same scanner reds on a fabricated source that writes', () => {
    const fake = "import { writeFileSync } from 'node:fs';\n"
      + "import { resolveScopedStatePath } from '../../lib/core/runtime-state.js';\n";
    const findings = readOnlyFindings(fake);
    expect(findings).toContain('unlisted import: ../../lib/core/runtime-state.js');
    expect(findings).toContain('writer token: writeFileSync');
  });

  it('leaves every state file byte-identical and creates no sibling', () => {
    const dir = makeStateDir('RO');
    writeSessionState(dir, 's1', { history: [], detections: [row('Read', 'warn', 3)], lastUpdated: 1 });
    writeFlatState(dir, { history: [], detections: [row('Bash', 'block', 5)], lastUpdated: 1 });
    const before = snapshot(dir);

    const out = run(['--state-dir', dir]);
    expect(out.status).toBe(0);
    expect(out.json.ok).toBe(true);

    expect(snapshot(dir)).toEqual(before);
  });

  it('creates nothing when the state dir does not exist', () => {
    const missing = path.join(tmp, 'never-made');
    const out = run(['--state-dir', missing]);
    expect(out.status).toBe(0);
    expect(out.json.ok).toBe(false);
    expect(out.json.reason).toContain('no state dir at');
    expect(() => statSync(missing)).toThrow();
  });
});

describe('loop-detection-census CLI: the count', () => {
  it('prints the fixed key set, one line of JSON on stdout, the human line on stderr', () => {
    const dir = makeStateDir('keys');
    writeSessionState(dir, 's1', { history: [], detections: [row('Read', 'warn', 3)], lastUpdated: 1 });
    const out = run(['--state-dir', dir]);
    expect(out.status).toBe(0);
    expect(out.stdout.trim().split('\n')).toHaveLength(1);
    expect(Object.keys(out.json).sort()).toEqual([...STDOUT_KEYS].sort());
    expect(out.stderr).toContain('loop-detection-census:');
    expect(typeof out.json.measured_at).toBe('string');
    expect(Number.isNaN(Date.parse(out.json.measured_at))).toBe(false);
  });

  it('folds session files and the flat file, splits warn/block, groups by tool and ranks fingerprints', () => {
    const dir = makeStateDir('fold');
    writeSessionState(dir, 's1', {
      history: [],
      detections: [row('Read', 'warn', 3, 'aaaaaaaaaaaa'), row('Read', 'warn', 4, 'aaaaaaaaaaaa'), row('Read', 'block', 5, 'aaaaaaaaaaaa')],
      lastUpdated: 1,
    });
    writeSessionState(dir, 's2', { history: [{ tool: 'Grep', fingerprint: 'x' }], lastUpdated: 1 }); // pre-detections file
    writeFlatState(dir, { history: [], detections: [row('Bash', 'warn', 3, 'bbbbbbbbbbbb')], lastUpdated: 1 });

    const out = run(['--state-dir', dir]);
    expect(out.status).toBe(0);
    expect(out.json.ok).toBe(true);
    expect(out.json.status).toBe('measured');
    expect(out.json.inputPaths).toEqual([
      path.join(dir, RUNTIME_DIRNAME, SESSIONS_DIRNAME),
      path.join(dir, 'loop-state.json'),
    ]);
    expect(out.json.filesRead).toBe(3);
    expect(out.json.parseFailures).toBe(0);
    expect(out.json.sessions).toBe(2);
    expect(out.json.detections).toEqual({ warn: 3, block: 1, total: 4 });
    expect(out.json.byTool).toEqual({ Read: { warn: 2, block: 1 }, Bash: { warn: 1, block: 0 } });
    expect(out.json.topFingerprints).toEqual([
      { fingerprint_sha12: 'aaaaaaaaaaaa', tool: 'Read', count: 3 },
      { fingerprint_sha12: 'bbbbbbbbbbbb', tool: 'Bash', count: 1 },
    ]);
  });

  it('counts a file that does not parse as a parse failure, not as zero detections', () => {
    const dir = makeStateDir('corrupt');
    writeSessionState(dir, 's1', '{ not json');
    writeSessionState(dir, 's2', { history: [], detections: [row('Read', 'warn', 3)], lastUpdated: 1 });
    const out = run(['--state-dir', dir]);
    expect(out.json.filesRead).toBe(2);
    expect(out.json.parseFailures).toBe(1);
    expect(out.json.detections.total).toBe(1);
  });

  it('ignores rows that are not detection rows (a tool or severity that is not a string)', () => {
    const dir = makeStateDir('shape');
    writeSessionState(dir, 's1', {
      history: [],
      detections: [row('Read', 'warn', 3), { ts: 1, tool: 7, severity: 'warn', count: 3 }, null, 'x'],
      lastUpdated: 1,
    });
    const out = run(['--state-dir', dir]);
    expect(out.json.detections).toEqual({ warn: 1, block: 0, total: 1 });
  });

  it('caps topFingerprints at 10, most frequent first', () => {
    const dir = makeStateDir('top');
    const detections = [];
    for (let i = 0; i < 12; i += 1) {
      for (let k = 0; k <= i; k += 1) detections.push(row('Read', 'warn', 3, String(i).padStart(12, '0')));
    }
    writeSessionState(dir, 's1', { history: [], detections, lastUpdated: 1 });
    const out = run(['--state-dir', dir]);
    expect(out.json.topFingerprints).toHaveLength(10);
    expect(out.json.topFingerprints[0].count).toBe(12);
    expect(out.json.topFingerprints[9].count).toBe(3);
  });
});

describe('loop-detection-census CLI: a zero denominator is null', () => {
  it('no state dir at all: null measurements, unmeasured:no-state', () => {
    const out = run(['--state-dir', path.join(tmp, 'absent')]);
    expect(out.json.ok).toBe(false);
    expect(out.json.filesRead).toBe(0);
    expect(out.json.sessions).toBe(0);
    expect(out.json.detections).toBe(null);
    expect(out.json.byTool).toBe(null);
    expect(out.json.topFingerprints).toBe(null);
    expect(out.json.status).toBe('unmeasured:no-state');
    expect(JSON.stringify(out.json)).not.toContain('NaN');
  });

  it('a state dir with no loop-state file anywhere is also unmeasured, and says so differently', () => {
    const dir = makeStateDir('alive-empty');
    const out = run(['--state-dir', dir]);
    expect(out.json.ok).toBe(true);
    expect(out.json.filesRead).toBe(0);
    expect(out.json.detections).toBe(null);
    expect(out.json.status).toBe('unmeasured:no-files');
  });

  it('files read but no detection anywhere is a MEASURED zero, not null', () => {
    const dir = makeStateDir('measured-zero');
    writeSessionState(dir, 's1', { history: [{ tool: 'Read', fingerprint: 'x' }], detections: [], lastUpdated: 1 });
    const out = run(['--state-dir', dir]);
    expect(out.json.ok).toBe(true);
    expect(out.json.filesRead).toBe(1);
    expect(out.json.detections).toEqual({ warn: 0, block: 0, total: 0 });
    expect(out.json.byTool).toEqual({});
    expect(out.json.topFingerprints).toEqual([]);
    expect(out.json.status).toBe('measured:no-detections');
  });
});

describe('loop-detection-census CLI: the command line', () => {
  it('an unknown argument is exit 2 with an empty stdout', () => {
    const out = run(['--bogus']);
    expect(out.status).toBe(2);
    expect(out.stdout).toBe('');
    expect(out.stderr).toContain('unknown argument');
  });

  it('a value flag without a value is exit 2', () => {
    const out = run(['--state-dir']);
    expect(out.status).toBe(2);
    expect(out.stdout).toBe('');
  });

  it('an empty --state-dir is exit 2', () => {
    const out = run(['--state-dir', '  ']);
    expect(out.status).toBe(2);
  });
});

describe('loop-detection-census: resolvers agree with the writers', () => {
  const SAVED = {};
  const KEYS = ['ARTIBOT_STATE_DIR', 'ARTIBOT_STATE_DIR_HOME', 'HOME', 'USERPROFILE'];

  beforeEach(() => { for (const k of KEYS) SAVED[k] = process.env[k]; });
  afterEach(() => {
    for (const k of KEYS) {
      if (SAVED[k] === undefined) delete process.env[k];
      else process.env[k] = SAVED[k];
    }
  });

  it('the layout constants are the ones lib/core/runtime-state.js exports', () => {
    expect(census.RUNTIME_DIRNAME).toBe(RUNTIME_DIRNAME);
    expect(census.SESSIONS_DIRNAME).toBe(SESSIONS_DIRNAME);
  });

  it('resolveStateDir mirrors lib/core/config.js#resolveArtibotDir across the override cases', () => {
    const home = path.join(tmp, 'home');
    const other = path.join(tmp, 'other');
    const override = path.join(tmp, 'state');
    process.env.HOME = home;
    process.env.USERPROFILE = home;

    delete process.env.ARTIBOT_STATE_DIR;
    delete process.env.ARTIBOT_STATE_DIR_HOME;
    expect(census.resolveStateDir()).toBe(resolveArtibotDir());

    process.env.ARTIBOT_STATE_DIR = override;
    process.env.ARTIBOT_STATE_DIR_HOME = home;
    expect(census.resolveStateDir()).toBe(resolveArtibotDir());
    expect(census.resolveStateDir()).toBe(override);

    process.env.ARTIBOT_STATE_DIR_HOME = other;
    expect(census.resolveStateDir()).toBe(resolveArtibotDir());
    expect(census.resolveStateDir()).toBe(path.join(home, '.claude', 'artibot'));

    delete process.env.ARTIBOT_STATE_DIR_HOME;
    expect(census.resolveStateDir()).toBe(resolveArtibotDir());
  });
});
