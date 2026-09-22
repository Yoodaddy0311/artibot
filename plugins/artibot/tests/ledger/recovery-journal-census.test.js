/**
 * Real-process contract for `scripts/ledger/recovery-journal-census.mjs` — the
 * read-only CLI that reports how many `state.recoveryJournal` rows the
 * autopilot session store holds and how they split on `divergent`.
 *
 * WHY THESE CASES SPAWN A PROCESS. The counting rule is not in any library:
 * `lib/autopilot/recovery-record.js` WRITES rows and never counts them, and
 * `lib/autopilot/session-store.js` lists files without opening them. Only a
 * spawn shows the store-directory resolution, the exit codes, the stdout/
 * stderr split, and the one property that matters most here.
 *
 * READ-ONLY IS ASSERTED, NOT DECLARED — the standard
 * `tests/ledger/verify-call-rate.test.js` set. The import set of the source is
 * checked as an ALLOWLIST (four specifiers, nothing else) rather than as a
 * deny list of writer names, because a deny list is fail-open against the next
 * writer somebody adds; and the scanner that enforces it is itself given a
 * fabricated source carrying a writer import, so a scanner that cannot show a
 * red does not get to be green. On top of the source check, the store's bytes,
 * sizes, mtimes and directory listing are captured around a real spawn.
 *
 * WHAT THIS SCANNER CANNOT SEE (rules §9 — written next to the gate, so the
 * gate does not become the next illusion):
 *  - IMPORT FORMS IT DOES NOT PARSE. `importSpecifiers` reads static `import
 *    … from '…'` and `import '…'` in BOTH quote styles. A dynamic `import()`,
 *    `require`/`createRequire`, or a re-export (`export … from '…'`) could
 *    reach a writer and scan clean.
 *  - FS VERBS OUTSIDE THE TOKEN LIST. `WRITER_TOKENS` names seven spellings;
 *    `createWriteStream`, `openSync`, `cpSync` and the promise API are
 *    invisible to it. The behavioural check below, not this regex, is the real
 *    backstop.
 *  - THE TRANSITIVE GRAPH, in principle. Here it happens to be clean —
 *    `lib/core/platform.js` takes only `existsSync` from `node:fs` and
 *    `scripts/hooks/_main-entry.js` only `realpathSync` (both read
 *    2026-09-22) — but nothing below proves that by static means, and the
 *    sentence would go stale silently if either file grew an import.
 *  So the only evidence that a run wrote nothing is behavioural: the store's
 *  bytes, sizes, mtimes and listing captured around a real spawn.
 *
 * THE FIXTURES ARE NOT THE LIVE STORE (rules §9). Measured by the limb author
 * on this machine's live store 2026-09-22: 6 `{sessionId}.json` files and NOT
 * ONE carries a `recoveryJournal`, so the live `rows` is 0 and the live
 * `ratio` is `null` (`unmeasured:no-journal`). Every journal row below was
 * written by this file. A green run here says the arithmetic is right; it says
 * nothing about what the live denominator is.
 *
 * @module tests/ledger/recovery-journal-census
 */

import { spawnSync } from 'node:child_process';
import {
  mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// This file spawns child processes. The budget buys headroom for load; nothing
// here waits on a timer.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(PLUGIN_ROOT, 'scripts', 'ledger', 'recovery-journal-census.mjs');

/** The exact key set the module header promises a caller can parse blind. */
const STDOUT_KEYS = [
  'ok', 'reason', 'inputPath', 'measuredAt', 'rows', 'divergentTrue', 'divergentFalse',
  'divergentMissing', 'ratio', 'status', 'census',
];

/** @type {string} */
let tmp;
let seq = 0;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'rjc-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/**
 * An empty session store directory.
 *
 * @param {string} name
 * @returns {string}
 */
function makeStore(name) {
  const dir = path.join(tmp, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Write one `{sessionId}.json` into a store.
 *
 * @param {string} dir
 * @param {object} state the whole session state object
 * @param {string} [id]
 * @returns {string} the session id
 */
function writeSession(dir, state, id) {
  seq += 1;
  const sessionId = id ?? `ap-2026092${seq}-aaaaaa-${seq}`;
  writeFileSync(path.join(dir, `${sessionId}.json`), `${JSON.stringify(state)}\n`, 'utf-8');
  return sessionId;
}

/**
 * Run the CLI against a store.
 *
 * @param {string[]} argv
 * @param {Record<string,string>} [env] extra environment
 * @returns {{status: number, stdout: string, stderr: string, json: object|null}}
 */
function run(argv, env = {}) {
  const out = spawnSync(process.execPath, [CLI, ...argv], {
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  });
  let json = null;
  try { json = JSON.parse(out.stdout); } catch { /* left null; the caller asserts */ }
  return { status: out.status, stdout: out.stdout, stderr: out.stderr, json };
}

/**
 * A snapshot of every file in a directory: name, size, mtime and bytes.
 *
 * @param {string} dir
 * @returns {Record<string,{size: number, mtimeMs: number, bytes: string}>}
 */
function snapshot(dir) {
  const snap = {};
  for (const name of readdirSync(dir).sort()) {
    const file = path.join(dir, name);
    const st = statSync(file);
    snap[name] = { size: st.size, mtimeMs: st.mtimeMs, bytes: readFileSync(file, 'utf-8') };
  }
  return snap;
}

// ---------------------------------------------------------------------------

/** The four specifiers the reader is allowed to import, and nothing else. */
const ALLOWED_SPECIFIERS = [
  'node:fs',
  'node:path',
  '../../lib/core/platform.js',
  '../hooks/_main-entry.js',
];

/** Spellings that would make this reader a writer. */
const WRITER_TOKENS = /writeFileSync|appendFileSync|mkdirSync|unlinkSync|rmSync|renameSync|saveSession/;

/**
 * Every static import specifier in a source, in order of appearance.
 *
 * BOTH QUOTE STYLES, and a bare side-effect `import '…'` too: a scanner that
 * only understood single quotes would pass a double-quoted writer import
 * silently, which is the fail-open direction.
 *
 * @param {string} source
 * @returns {string[]}
 */
function importSpecifiers(source) {
  const pattern = /(?:^|\n)\s*import\s*(?:[^;'"]*?from\s*)?['"]([^'"]+)['"]/g;
  return [...source.matchAll(pattern)].map((m) => m[1]);
}

/**
 * The read-only property, as one function so the self-test can aim at it.
 *
 * @param {string} source
 * @returns {string[]} findings; empty means clean
 */
function readOnlyFindings(source) {
  const findings = [];
  for (const spec of importSpecifiers(source)) {
    if (!ALLOWED_SPECIFIERS.includes(spec)) findings.push(`unlisted import: ${spec}`);
  }
  const writer = WRITER_TOKENS.exec(source);
  if (writer !== null) findings.push(`writer token: ${writer[0]}`);
  return findings;
}

describe('recovery-journal-census CLI: it imports no writer', () => {
  const source = readFileSync(CLI, 'utf-8');

  it('imports exactly the four allowlisted specifiers and no writer token', () => {
    expect(importSpecifiers(source).sort()).toEqual([...ALLOWED_SPECIFIERS].sort());
    expect(readOnlyFindings(source)).toEqual([]);
  });

  it('takes only read verbs from node:fs', () => {
    const named = /import\s+\{([^}]*)\}\s+from\s+'node:fs'/.exec(source);
    expect(named).not.toBe(null);
    expect(named[1].split(',').map((n) => n.trim()).filter((n) => n !== ''))
      .toEqual(['existsSync', 'readdirSync', 'readFileSync']);
  });

  it('does not import the session store, which is the writer', () => {
    // Its directory listing lives beside its save and delete entry points, so
    // importing it for convenience would put a writer one identifier away.
    // Asserted on the SPECIFIERS, not the raw bytes: a future comment that
    // names the module by path is documentation, not an import.
    expect(importSpecifiers(source).filter((s) => s.includes('session-store'))).toEqual([]);
  });

  it('SELF-TEST: the same scanner reds on a fabricated source that writes', () => {
    // A detector that cannot show a red proves nothing when it is green.
    const fake = "import { writeFileSync } from 'node:fs';\n"
      + "import { saveSession } from '../../lib/autopilot/session-store.js';\n";
    const findings = readOnlyFindings(fake);
    expect(findings).toContain('unlisted import: ../../lib/autopilot/session-store.js');
    expect(findings).toContain('writer token: writeFileSync');
  });

  it('SELF-TEST: it reds on a DOUBLE-QUOTED and on a side-effect import too', () => {
    const doubleQuoted = 'import { mkdirSync } from "node:fs";\n';
    const sideEffect = "import '../../lib/autopilot/session-store.js';\n";
    expect(importSpecifiers(doubleQuoted)).toEqual(['node:fs']);
    expect(importSpecifiers(sideEffect)).toEqual(['../../lib/autopilot/session-store.js']);
    expect(readOnlyFindings(doubleQuoted)).toContain('writer token: mkdirSync');
    expect(readOnlyFindings(sideEffect))
      .toContain('unlisted import: ../../lib/autopilot/session-store.js');
  });

  it('leaves every store file byte-identical and creates no sibling', () => {
    const dir = makeStore('RO');
    writeSession(dir, { sessionId: 'a', recoveryJournal: [{ divergent: true }] }, 'a');
    writeSession(dir, { sessionId: 'b', recoveryJournal: [{ divergent: false }] }, 'b');
    const before = snapshot(dir);

    const out = run(['--dir', dir]);
    expect(out.status).toBe(0);
    expect(out.json.rows).toBe(2);

    expect(snapshot(dir)).toEqual(before);
    expect(readdirSync(dir).sort()).toEqual(['a.json', 'b.json']);
  });

  it('creates nothing when the store directory does not exist', () => {
    const missing = path.join(tmp, 'never-made');
    const out = run(['--dir', missing]);
    expect(out.status).toBe(0);
    expect(out.json.ok).toBe(false);
    expect(out.json.reason).toContain('no session store at');
    expect(() => statSync(missing)).toThrow();
  });
});

describe('recovery-journal-census CLI: a zero denominator is null', () => {
  it('reports null when there is no store at all', () => {
    const out = run(['--dir', path.join(tmp, 'absent')]);
    expect(out.json.rows).toBe(0);
    expect(out.json.ratio).toBe(null);
    expect(out.json.status).toBe('unmeasured:no-store');
  });

  it('separates "no store" from "store alive, no journal anywhere"', () => {
    const dir = makeStore('alive');
    writeSession(dir, { sessionId: 'x', phase: 'VERIFY' });
    const out = run(['--dir', dir]);
    expect(out.json.ok).toBe(true);
    expect(out.json.rows).toBe(0);
    expect(out.json.ratio).toBe(null);
    expect(out.json.status).toBe('unmeasured:no-journal');
    expect(out.json.census.filesRead).toBe(1);
    expect(out.json.census.filesWithJournal).toBe(0);
  });

  it('an EMPTY journal array is a read file with zero rows, still null', () => {
    const dir = makeStore('empty-array');
    writeSession(dir, { sessionId: 'x', recoveryJournal: [] });
    const out = run(['--dir', dir]);
    expect(out.json.census.filesWithJournal).toBe(1);
    expect(out.json.rows).toBe(0);
    expect(out.json.ratio).toBe(null);
    expect(out.json.status).toBe('unmeasured:no-journal');
  });

  it('types ratio as null-or-object, which is what NaN would break', () => {
    const dir = makeStore('nan');
    writeSession(dir, { sessionId: 'x', recoveryJournal: [] });
    const zero = run(['--dir', dir]).json;
    expect(zero.ratio).toBe(null);
    expect(JSON.stringify(zero)).not.toContain('NaN');

    writeSession(dir, { sessionId: 'y', recoveryJournal: [{ divergent: true }] }, 'y');
    const one = run(['--dir', dir]).json;
    expect(typeof one.ratio).toBe('object');
    expect(Number.isFinite(one.ratio.divergentTrue)).toBe(true);
  });
});

describe('recovery-journal-census CLI: the three-way split', () => {
  it('splits true / false / missing and the three sum to rows', () => {
    const dir = makeStore('split');
    writeSession(dir, {
      sessionId: 'a',
      recoveryJournal: [
        { divergent: true },
        { divergent: true },
        { divergent: false },
        { class: 'implementation' },
      ],
    }, 'a');
    writeSession(dir, {
      sessionId: 'b',
      recoveryJournal: [{ divergent: false }, { divergent: undefined }],
    }, 'b');

    const r = run(['--dir', dir]).json;
    expect(r.rows).toBe(6);
    expect(r.divergentTrue).toBe(2);
    expect(r.divergentFalse).toBe(2);
    expect(r.divergentMissing).toBe(2);
    expect(r.divergentTrue + r.divergentFalse + r.divergentMissing).toBe(r.rows);
    expect(r.ratio).toEqual({
      divergentTrue: 2 / 6, divergentFalse: 2 / 6, divergentMissing: 2 / 6,
    });
    expect(r.status).toBe('measured');
  });

  it('never coerces: the STRING "false" is missing, not true', () => {
    // `'false'` is truthy in JavaScript. A coercing reader would file it under
    // divergentTrue and inflate the exact number CA-03 is waiting on.
    const dir = makeStore('coerce');
    writeSession(dir, {
      sessionId: 'a',
      recoveryJournal: [
        { divergent: 'false' }, { divergent: 'true' }, { divergent: 1 },
        { divergent: 0 }, { divergent: null },
      ],
    }, 'a');
    const r = run(['--dir', dir]).json;
    expect(r.rows).toBe(5);
    expect(r.divergentTrue).toBe(0);
    expect(r.divergentFalse).toBe(0);
    expect(r.divergentMissing).toBe(5);
  });

  it('counts a non-object row as missing rather than throwing', () => {
    const dir = makeStore('hostile-rows');
    writeSession(dir, {
      sessionId: 'a',
      recoveryJournal: [null, 7, 'divergent', [], { divergent: true }],
    }, 'a');
    const r = run(['--dir', dir]).json;
    expect(r.rows).toBe(5);
    expect(r.divergentTrue).toBe(1);
    expect(r.divergentMissing).toBe(4);
  });

  it('a non-array recoveryJournal contributes no rows and is reported', () => {
    // `recovery-record.js#pushJournal` REPLACES a non-array with a fresh `[]`,
    // so such a file is a journal about to be discarded, not one of length 1.
    const dir = makeStore('non-array');
    writeSession(dir, { sessionId: 'a', recoveryJournal: { divergent: true } }, 'a');
    writeSession(dir, { sessionId: 'b', recoveryJournal: 'corrupt' }, 'b');
    const r = run(['--dir', dir]).json;
    expect(r.rows).toBe(0);
    expect(r.ratio).toBe(null);
    expect(r.census.filesNonArray).toBe(2);
    expect(r.census.filesWithJournal).toBe(0);
  });

  it('an unparsable file is counted apart, not as an empty journal', () => {
    const dir = makeStore('unparsable');
    writeFileSync(path.join(dir, 'broken.json'), '{ not json', 'utf-8');
    writeSession(dir, { sessionId: 'ok', recoveryJournal: [{ divergent: true }] }, 'ok');
    const r = run(['--dir', dir]).json;
    expect(r.census.filesSeen).toBe(2);
    expect(r.census.filesRead).toBe(1);
    expect(r.census.filesUnparsable).toBe(1);
    expect(r.rows).toBe(1);
  });

  it('ignores the .events.ndjson siblings the store keeps beside each session', () => {
    const dir = makeStore('ndjson');
    writeSession(dir, { sessionId: 'a', recoveryJournal: [{ divergent: true }] }, 'a');
    writeFileSync(path.join(dir, 'a.events.ndjson'), '{"event":"x"}\n', 'utf-8');
    const r = run(['--dir', dir]).json;
    expect(r.census.filesSeen).toBe(1);
    expect(r.rows).toBe(1);
  });
});

describe('recovery-journal-census CLI: the report carries its provenance', () => {
  it('prints the fixed key set, in order', () => {
    const dir = makeStore('keys');
    writeSession(dir, { sessionId: 'a', recoveryJournal: [{ divergent: true }] }, 'a');
    const r = run(['--dir', dir]).json;
    expect(Object.keys(r)).toEqual(STDOUT_KEYS);
  });

  it('stamps measuredAt as a parsable ISO instant and inputPath as the store', () => {
    const dir = makeStore('stamp');
    writeSession(dir, { sessionId: 'a', recoveryJournal: [] }, 'a');
    const before = Date.now();
    const r = run(['--dir', dir]).json;
    expect(Number.isFinite(Date.parse(r.measuredAt))).toBe(true);
    expect(Date.parse(r.measuredAt)).toBeGreaterThanOrEqual(before - 1000);
    expect(path.resolve(r.inputPath)).toBe(path.resolve(dir));
  });

  it('writes ONE line of JSON to stdout and the human line to stderr', () => {
    const dir = makeStore('streams');
    writeSession(dir, {
      sessionId: 'a', recoveryJournal: [{ divergent: true }, { divergent: false }],
    }, 'a');
    const out = run(['--dir', dir]);
    expect(out.stdout.split('\n').filter((l) => l.trim() !== '')).toHaveLength(1);
    // The human line must never land inside the caller's JSON.parse.
    expect(() => JSON.parse(out.stdout)).not.toThrow();
    expect(out.stderr).toContain('recovery journal: 2 rows');
    expect(out.stderr).toContain('divergent true 1 (50.0%)');
    expect(out.stderr).toContain('measured ');
    expect(out.stderr.split('\n').filter((l) => l.trim() !== '')).toHaveLength(1);
  });

  it('says "0 rows — ratio null" in the human line rather than a percentage', () => {
    const dir = makeStore('human-zero');
    writeSession(dir, { sessionId: 'a', recoveryJournal: [] }, 'a');
    const out = run(['--dir', dir]);
    expect(out.stderr).toContain('0 rows — ratio null');
    expect(out.stderr).toContain('unmeasured:no-journal');
    expect(out.stderr).not.toContain('%');
  });
});

describe('recovery-journal-census CLI: --session narrows the store', () => {
  it('counts only the named session file', () => {
    const dir = makeStore('narrow');
    writeSession(dir, { sessionId: 'a', recoveryJournal: [{ divergent: true }] }, 'a');
    writeSession(dir, {
      sessionId: 'b', recoveryJournal: [{ divergent: false }, { divergent: false }],
    }, 'b');

    expect(run(['--dir', dir]).json.rows).toBe(3);
    const only = run(['--dir', dir, '--session', 'b']).json;
    expect(only.rows).toBe(2);
    expect(only.divergentFalse).toBe(2);
    expect(only.census.sessionFilter).toBe('b');
    expect(only.census.filesSeen).toBe(1);
  });

  it('an unknown session is "no store", not a measured zero', () => {
    const dir = makeStore('unknown');
    writeSession(dir, { sessionId: 'a', recoveryJournal: [{ divergent: true }] }, 'a');
    const r = run(['--dir', dir, '--session', 'nope']).json;
    expect(r.rows).toBe(0);
    expect(r.ratio).toBe(null);
    expect(r.status).toBe('unmeasured:no-store');
  });
});

describe('recovery-journal-census CLI: a malformed command line', () => {
  const cases = [
    ['an unknown flag', ['--bogus', 'x']],
    ['a bare positional', ['store']],
    ['--dir with no value', ['--dir']],
    ['--session with no value', ['--dir', 'x', '--session']],
    ['an empty --dir', ['--dir', '  ']],
    ['a --session with a separator', ['--session', '../escape']],
  ];

  for (const [label, argv] of cases) {
    it(`exits 2 and writes nothing to stdout for ${label}`, () => {
      const out = run(argv);
      expect(out.status).toBe(2);
      expect(out.stdout).toBe('');
      expect(out.stderr.split('\n').filter((l) => l !== '')).toHaveLength(1);
      expect(out.stderr).toContain('usage: recovery-journal-census.mjs');
    });
  }

  it('does not touch the store on a usage error', () => {
    const dir = makeStore('usage');
    writeSession(dir, { sessionId: 'a', recoveryJournal: [{ divergent: true }] }, 'a');
    const before = snapshot(dir);
    expect(run(['--dir', dir, '--bogus']).status).toBe(2);
    expect(snapshot(dir)).toEqual(before);
  });
});

describe('recovery-journal-census CLI: the store directory resolution', () => {
  it('honours the env override only when its recorded root matches', () => {
    const root = path.join(tmp, 'root');
    const store = makeStore('override-store');
    mkdirSync(root, { recursive: true });
    writeSession(store, { sessionId: 'a', recoveryJournal: [{ divergent: true }] }, 'a');

    const honoured = run([], {
      CLAUDE_PLUGIN_ROOT: root,
      ARTIBOT_AUTOPILOT_STORE_DIR: store,
      ARTIBOT_AUTOPILOT_STORE_DIR_ROOT: root,
    }).json;
    expect(path.resolve(honoured.inputPath)).toBe(path.resolve(store));
    expect(honoured.rows).toBe(1);
  });

  it('IGNORES an override with no recorded root — fail-closed, not fail-open', () => {
    // An override we cannot place must not be trusted; otherwise a spawned
    // child inherits the parent's store and reports the wrong denominator.
    const root = path.join(tmp, 'root2');
    const store = makeStore('override-store2');
    mkdirSync(root, { recursive: true });
    writeSession(store, { sessionId: 'a', recoveryJournal: [{ divergent: true }] }, 'a');

    const ignored = run([], {
      CLAUDE_PLUGIN_ROOT: root,
      ARTIBOT_AUTOPILOT_STORE_DIR: store,
      ARTIBOT_AUTOPILOT_STORE_DIR_ROOT: '',
    }).json;
    expect(path.resolve(ignored.inputPath))
      .toBe(path.resolve(path.join(root, 'runtime', 'autopilot')));
    expect(ignored.rows).toBe(0);
  });

  it('IGNORES an override minted for a DIFFERENT root', () => {
    const root = path.join(tmp, 'root3');
    const otherRoot = path.join(tmp, 'other-root');
    const store = makeStore('override-store3');
    mkdirSync(root, { recursive: true });
    mkdirSync(otherRoot, { recursive: true });
    writeSession(store, { sessionId: 'a', recoveryJournal: [{ divergent: true }] }, 'a');

    const ignored = run([], {
      CLAUDE_PLUGIN_ROOT: root,
      ARTIBOT_AUTOPILOT_STORE_DIR: store,
      ARTIBOT_AUTOPILOT_STORE_DIR_ROOT: otherRoot,
    }).json;
    expect(path.resolve(ignored.inputPath))
      .toBe(path.resolve(path.join(root, 'runtime', 'autopilot')));
  });

  it('--dir overrules the env pair', () => {
    const root = path.join(tmp, 'root4');
    const envStore = makeStore('env-store');
    const cliStore = makeStore('cli-store');
    mkdirSync(root, { recursive: true });
    writeSession(envStore, { sessionId: 'a', recoveryJournal: [{ divergent: true }] }, 'a');
    writeSession(cliStore, {
      sessionId: 'b', recoveryJournal: [{ divergent: false }, { divergent: false }],
    }, 'b');

    const r = run(['--dir', cliStore], {
      CLAUDE_PLUGIN_ROOT: root,
      ARTIBOT_AUTOPILOT_STORE_DIR: envStore,
      ARTIBOT_AUTOPILOT_STORE_DIR_ROOT: root,
    }).json;
    expect(path.resolve(r.inputPath)).toBe(path.resolve(cliStore));
    expect(r.rows).toBe(2);
    expect(r.divergentFalse).toBe(2);
  });
});

describe('recovery-journal-census CLI: it is safe to import', () => {
  it('does nothing when imported rather than run', async () => {
    const mod = await import(`file://${CLI.split(path.sep).join('/')}`);
    expect(typeof mod.main).toBe('function');
    expect(typeof mod.census).toBe('function');
    expect(typeof mod.bucketOf).toBe('function');
    expect(typeof mod.resolveStoreDir).toBe('function');
  });

  it('bucketOf is total — every input lands in exactly one named bucket', async () => {
    const { bucketOf } = await import(`file://${CLI.split(path.sep).join('/')}`);
    const names = ['divergentTrue', 'divergentFalse', 'divergentMissing'];
    const inputs = [
      { divergent: true }, { divergent: false }, {}, null, undefined, 0, '', [],
      { divergent: 'true' }, Object.create(null),
    ];
    for (const input of inputs) expect(names).toContain(bucketOf(input));
    expect(bucketOf({ divergent: true })).toBe('divergentTrue');
    expect(bucketOf({ divergent: false })).toBe('divergentFalse');
  });

  it('bucketOf survives a throwing accessor on the divergent key', async () => {
    const { bucketOf } = await import(`file://${CLI.split(path.sep).join('/')}`);
    const hostile = {};
    Object.defineProperty(hostile, 'divergent', {
      get() { throw new Error('hostile'); },
      enumerable: true,
    });
    expect(bucketOf(hostile)).toBe('divergentMissing');
  });
});

describe('recovery-journal-census CLI: per-session and whole-store in one run', () => {
  it('gives one entry per journal-carrying file whose rows sum to the total', () => {
    const dir = makeStore('per-session');
    writeSession(dir, { sessionId: 'a', recoveryJournal: [{ divergent: true }] }, 'a');
    writeSession(dir, {
      sessionId: 'b', recoveryJournal: [{ divergent: false }, { divergent: 'false' }],
    }, 'b');

    const r = run(['--dir', dir]).json;
    expect(r.census.perSession).toEqual([{ sessionId: 'a', rows: 1 }, { sessionId: 'b', rows: 2 }]);
    // The breakdown and the total are ONE read at two grains, so the sum is an
    // identity rather than a coincidence two separate runs would have to keep.
    const summed = r.census.perSession.reduce((n, e) => n + e.rows, 0);
    expect(summed).toBe(r.rows);
    expect(summed).toBe(3);
  });

  it('omits a file with no journal instead of reporting it as zero rows', () => {
    // "This session recorded no recovery decision" and "this session has no
    // journal to break down" are different findings; a zero row would print
    // the second as the first.
    const dir = makeStore('per-session-absent');
    writeSession(dir, { sessionId: 'a', recoveryJournal: [{ divergent: true }] }, 'a');
    writeSession(dir, { sessionId: 'b' }, 'b');
    writeSession(dir, { sessionId: 'c', recoveryJournal: { divergent: true } }, 'c');

    const r = run(['--dir', dir]).json;
    expect(r.census.perSession).toEqual([{ sessionId: 'a', rows: 1 }]);
    expect(r.census.filesRead).toBe(3);
    expect(r.census.filesWithJournal).toBe(1);
    expect(r.census.filesNonArray).toBe(1);
  });

  it('an empty journal IS an entry of zero rows, because the file carries one', () => {
    const dir = makeStore('per-session-empty');
    writeSession(dir, { sessionId: 'a', recoveryJournal: [] }, 'a');
    const r = run(['--dir', dir]).json;
    expect(r.census.perSession).toEqual([{ sessionId: 'a', rows: 0 }]);
    expect(r.rows).toBe(0);
  });

  it('--session narrows the breakdown to the one file it narrows the count to', () => {
    const dir = makeStore('per-session-narrow');
    writeSession(dir, { sessionId: 'a', recoveryJournal: [{ divergent: true }] }, 'a');
    writeSession(dir, {
      sessionId: 'b', recoveryJournal: [{ divergent: false }, { divergent: false }],
    }, 'b');

    const only = run(['--dir', dir, '--session', 'b']).json;
    expect(only.census.perSession).toEqual([{ sessionId: 'b', rows: 2 }]);
    expect(only.rows).toBe(2);
  });
});

describe('recovery-journal-census CLI: the mirrored resolver stays in step', () => {
  // `resolveStoreDir` is a deliberate COPY of
  // `lib/autopilot/session-store.js#getStoreDir`: the reader may not import the
  // writer (the allowlist above is what forbids it), so the duplication is the
  // price of the allowlist. A copy drifts in silence, and the reader would go
  // on reporting a confident denominator for a directory the writer had left.
  // These four cases are the whole decision table of the env pair, and each
  // asserts the two resolvers AGREE before asserting what they agree on, so a
  // drift stays red even if both halves were moved to some third rule.
  const KEYS = [
    'CLAUDE_PLUGIN_ROOT',
    'ARTIBOT_AUTOPILOT_STORE_DIR',
    'ARTIBOT_AUTOPILOT_STORE_DIR_ROOT',
  ];
  /** @type {Record<string, string|undefined>} */
  let savedEnv;

  beforeEach(() => {
    savedEnv = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  /**
   * Apply one environment, then read both resolvers under exactly that one.
   *
   * @param {Record<string, string|undefined>} env
   * @returns {Promise<{mirror: string, canonical: string}>}
   */
  async function bothUnder(env) {
    for (const k of KEYS) {
      if (env[k] === undefined) delete process.env[k];
      else process.env[k] = env[k];
    }
    const { resolveStoreDir } = await import(`file://${CLI.split(path.sep).join('/')}`);
    const { getStoreDir } = await import('../../lib/autopilot/session-store.js');
    return { mirror: resolveStoreDir(), canonical: getStoreDir() };
  }

  it('agrees on the plugin-root default when no override is set', async () => {
    const root = path.join(tmp, 'pair-root');
    const { mirror, canonical } = await bothUnder({ CLAUDE_PLUGIN_ROOT: root });
    expect(mirror).toBe(canonical);
    expect(mirror).toBe(path.join(root, 'runtime', 'autopilot'));
  });

  it('agrees on discarding an override with no recorded root', async () => {
    const root = path.join(tmp, 'pair-root');
    const { mirror, canonical } = await bothUnder({
      CLAUDE_PLUGIN_ROOT: root,
      ARTIBOT_AUTOPILOT_STORE_DIR: path.join(tmp, 'pair-store'),
    });
    expect(mirror).toBe(canonical);
    expect(mirror).toBe(path.join(root, 'runtime', 'autopilot'));
  });

  it('agrees on honouring an override minted for the root in force', async () => {
    const root = path.join(tmp, 'pair-root');
    const store = path.join(tmp, 'pair-store');
    const { mirror, canonical } = await bothUnder({
      CLAUDE_PLUGIN_ROOT: root,
      ARTIBOT_AUTOPILOT_STORE_DIR: store,
      ARTIBOT_AUTOPILOT_STORE_DIR_ROOT: root,
    });
    expect(mirror).toBe(canonical);
    expect(mirror).toBe(path.resolve(store));
  });

  it('agrees on discarding an override minted for a different root', async () => {
    const root = path.join(tmp, 'pair-root');
    const { mirror, canonical } = await bothUnder({
      CLAUDE_PLUGIN_ROOT: root,
      ARTIBOT_AUTOPILOT_STORE_DIR: path.join(tmp, 'pair-store'),
      ARTIBOT_AUTOPILOT_STORE_DIR_ROOT: path.join(tmp, 'pair-other'),
    });
    expect(mirror).toBe(canonical);
    expect(mirror).toBe(path.join(root, 'runtime', 'autopilot'));
  });
});
