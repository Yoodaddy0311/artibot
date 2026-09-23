/**
 * `lib/verification/evidence-registry.js` — the E-nnn evidence registry.
 *
 * What this proves: that the same evidence content (in any key order) gets the
 * same id and appends nothing, within one call and across calls; that new
 * content gets the next sequential id; that a row carries only
 * id/type/source/hash/created_at and never the entry's payload; that
 * `registerEvidence` never throws; that `readEvidenceIds` tells an ABSENT
 * registry (`[]`, measured-and-empty) from an unreadable one (`null`); that
 * `lookupEvidenceIds` answers by hash without the lock and without a write; and that
 * id allocation waits on the file lock, measured by a child process that is
 * held behind a live lock and appends only after it is released.
 *
 * Every store here is a mkdtemp root. A root that needs the git branch of the
 * placement rule gets its own `.git` DIRECTORY, so the real resolver answers
 * without ever looking at this repository.
 *
 * What it cannot prove:
 *  1. That the lock excludes a holder that outlives the stale window. A lock
 *     file older than `staleMs` (5 s) is taken over by age. A live writer
 *     stalled that long then shares the critical section with the taker, and
 *     two takers of one stranded lock can both win in a narrow window. The
 *     module header says how far that window is narrowed. No test here stalls
 *     a real holder.
 *  2. That exclusion holds on a filesystem without atomic O_EXCL create
 *     (network shares, some FUSE mounts). Every run here is local NTFS or the
 *     CI runner's disk. The stress test is 8 writers x 3 rounds, far from what
 *     the scratch driver ran (80 rounds).
 *  3. That the production callers register evidence. The port on
 *     `recordVerification` is optional; `scripts/hooks/dev-verify-gate.js` and
 *     `scripts/ledger/record-verify.mjs` bind it, and their own suites measure
 *     that binding — nothing here does.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  evidenceHash,
  evidenceRegistryPath,
  lookupEvidenceIds,
  readEvidenceIds,
  registerEvidence,
  REGISTRY_LOCK_DEFAULTS,
  releaseLock,
} from '../../lib/verification/evidence-registry.js';

const MODULE_URL = pathToFileURL(path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../lib/verification/evidence-registry.js',
)).href;

const AT = () => new Date('2026-09-23T03:00:00.000Z');
const SOURCE = 'verify.completed:sess-er-01:v1-000000000000-20260923T030000Z';

const cmd = (output = 'ok') => ({ kind: 'command', command: 'npx vitest run x', output });
const file = (line = 12) => ({ kind: 'file', file: 'lib/a.js', line });

let root;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'artibot-evidence-registry-'));
  mkdirSync(path.join(root, '.git'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Register through the real resolver, into this test's temp root only. */
function reg(entries, opts = {}) {
  return registerEvidence(entries, { projectRoot: root, source: SOURCE, now: AT, ...opts });
}

/** Parsed rows of the temp registry. */
function rows() {
  const p = evidenceRegistryPath(root);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

describe('evidenceHash', () => {
  it('is a sha256 hex digest', () => {
    expect(evidenceHash(cmd())).toMatch(/^[0-9a-f]{64}$/);
  });

  it('ignores key order, at every depth', () => {
    const a = { kind: 'command', command: 'c', output: 'o', note: { x: 1, y: [1, { p: 1, q: 2 }] } };
    const b = { note: { y: [1, { q: 2, p: 1 }], x: 1 }, output: 'o', command: 'c', kind: 'command' };
    expect(evidenceHash(a)).toBe(evidenceHash(b));
  });

  it('separates different content, including array order', () => {
    expect(evidenceHash(cmd('ok'))).not.toBe(evidenceHash(cmd('ko')));
    expect(evidenceHash({ kind: 'x', a: [1, 2] })).not.toBe(evidenceHash({ kind: 'x', a: [2, 1] }));
  });

  it('refuses an entry it cannot serialize instead of hashing a stand-in', () => {
    const loop = { kind: 'command' };
    loop.self = loop;
    expect(() => evidenceHash(loop)).toThrow();
  });
});

describe('evidenceRegistryPath', () => {
  it('places the registry under the git common dir when one resolves', () => {
    expect(evidenceRegistryPath(root)).toBe(path.join(root, '.git', 'artibot', 'evidence.jsonl'));
  });

  it('falls back to the per-root runtime dir when no git dir resolves', () => {
    const bare = mkdtempSync(path.join(tmpdir(), 'artibot-evidence-registry-bare-'));
    try {
      expect(evidenceRegistryPath(bare))
        .toBe(path.join(bare, '.artibot', 'runtime', 'evidence.jsonl'));
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it('uses an injected port, and treats a throwing port as unresolved', () => {
    const common = path.join(root, 'elsewhere', '.git');
    expect(evidenceRegistryPath(root, { resolveGitCommonDir: () => common }))
      .toBe(path.join(common, 'artibot', 'evidence.jsonl'));
    const boom = () => { throw new Error('git gone'); };
    expect(evidenceRegistryPath(root, { resolveGitCommonDir: boom }))
      .toBe(path.join(root, '.artibot', 'runtime', 'evidence.jsonl'));
  });
});

describe('registerEvidence', () => {
  it('mints E-001 for the first entry and writes one row', () => {
    const out = reg([cmd()]);
    expect(out).toEqual({ ids: ['E-001'], appended: 1, reused: 0 });
    expect(rows()).toHaveLength(1);
  });

  it('gives the same content the same id across calls and appends nothing', () => {
    const first = reg([cmd()]);
    const again = reg([cmd()]);
    const reordered = reg([{ output: 'ok', command: 'npx vitest run x', kind: 'command' }]);
    expect(again).toEqual({ ids: first.ids, appended: 0, reused: 1 });
    expect(reordered.ids).toEqual(first.ids);
    expect(rows()).toHaveLength(1);
  });

  it('gives a repeated entry inside one call one id and one row', () => {
    const out = reg([cmd(), file(), cmd()]);
    expect(out).toEqual({ ids: ['E-001', 'E-002', 'E-001'], appended: 2, reused: 1 });
    expect(rows().map((r) => r.id)).toEqual(['E-001', 'E-002']);
  });

  it('numbers new content sequentially after what is already there', () => {
    reg([cmd('a')]);
    reg([cmd('b')]);
    const out = reg([cmd('c'), cmd('a')]);
    expect(out.ids).toEqual(['E-003', 'E-001']);
    expect(rows().map((r) => r.id)).toEqual(['E-001', 'E-002', 'E-003']);
  });

  it('pads to three digits and grows past E-999 instead of wrapping', () => {
    const p = evidenceRegistryPath(root);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, `${JSON.stringify({ id: 'E-999', type: 'command', source: 's', hash: 'a'.repeat(64), created_at: 't' })}\n`);
    expect(reg([cmd()]).ids).toEqual(['E-1000']);
  });

  it('stores id/type/source/hash/created_at and nothing from the payload', () => {
    reg([{ kind: 'command', command: 'probe', output: 'PAYLOAD-MARKER-7f3', note: 'NOTE-MARKER-9c1' }]);
    const [row] = rows();
    expect(Object.keys(row)).toEqual(['id', 'type', 'source', 'hash', 'created_at']);
    expect(row).toMatchObject({ id: 'E-001', type: 'command', source: SOURCE, created_at: AT().toISOString() });
    expect(row.hash).toBe(evidenceHash({ kind: 'command', command: 'probe', output: 'PAYLOAD-MARKER-7f3', note: 'NOTE-MARKER-9c1' }));
    const raw = readFileSync(evidenceRegistryPath(root), 'utf8');
    expect(raw).not.toContain('PAYLOAD-MARKER-7f3');
    expect(raw).not.toContain('NOTE-MARKER-9c1');
    expect(raw).not.toContain('probe');
  });

  it('keeps the first source when later content repeats under another source', () => {
    reg([cmd()]);
    reg([cmd()], { source: 'verify.completed:other' });
    expect(rows().map((r) => r.source)).toEqual([SOURCE]);
  });

  it('writes nothing for an empty list', () => {
    expect(reg([])).toEqual({ ids: [], appended: 0, reused: 0 });
    expect(existsSync(evidenceRegistryPath(root))).toBe(false);
  });

  it('never throws, and a refused call writes nothing and returns no ids', () => {
    const loop = { kind: 'command' };
    loop.self = loop;
    const cases = [
      ['not an array', () => reg('nope')],
      ['no source', () => reg([cmd()], { source: '' })],
      ['entry without kind', () => reg([{ command: 'c', output: 'o' }])],
      ['entry not an object', () => reg([cmd(), 42])],
      ['circular entry', () => reg([cmd(), loop])],
      ['no projectRoot', () => registerEvidence([cmd()], { source: SOURCE })],
      ['now throws', () => reg([cmd()], { now: () => { throw new Error('clock'); } })],
    ];
    for (const [label, run] of cases) {
      let out;
      expect(() => { out = run(); }, label).not.toThrow();
      expect({ label, ids: out.ids, appended: out.appended }).toEqual({ label, ids: [], appended: 0 });
      expect({ label, reason: typeof out.reason }).toEqual({ label, reason: 'string' });
    }
    expect(rows()).toEqual([]);
  });

  it('reports an unwritable registry as a reason, not an exception', () => {
    // The registry path is a DIRECTORY, so the append itself fails.
    mkdirSync(evidenceRegistryPath(root), { recursive: true });
    let out;
    expect(() => { out = reg([cmd()]); }).not.toThrow();
    expect(out.ids).toEqual([]);
    expect(typeof out.reason).toBe('string');
  });

  it('appends past a torn last line without gluing onto it', () => {
    const p = evidenceRegistryPath(root);
    reg([cmd('a')]);
    writeFileSync(p, `${readFileSync(p, 'utf8')}{"id":"E-00`, { flag: 'w' });
    const out = reg([cmd('b')]);
    expect(out.ids).toEqual(['E-002']);
    expect(readEvidenceIds(root)).toEqual(['E-001', 'E-002']);
  });
});

describe('readEvidenceIds', () => {
  it('returns [] for an absent registry — measured and empty', () => {
    expect(readEvidenceIds(root)).toEqual([]);
  });

  it('returns null when the registry cannot be read — unmeasured', () => {
    mkdirSync(evidenceRegistryPath(root), { recursive: true });
    expect(readEvidenceIds(root)).toBeNull();
  });

  it('returns the ids that were registered, in order', () => {
    reg([cmd('a'), cmd('b')]);
    reg([cmd('a'), file()]);
    expect(readEvidenceIds(root)).toEqual(['E-001', 'E-002', 'E-003']);
  });

  it('skips torn and foreign lines rather than throwing', () => {
    const p = evidenceRegistryPath(root);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, [
      '{"id":"E-001","type":"command","source":"s","hash":"h","created_at":"t"}',
      'not json',
      '{"id":"X-9"}',
      '[1,2]',
      '{"id":"E-002","type":"file","source":"s","hash":"h2","created_at":"t"}',
      '{"id":"E-0',
    ].join('\n'));
    expect(readEvidenceIds(root)).toEqual(['E-001', 'E-002']);
  });

  it('reads the same place the writer wrote through an injected port', () => {
    const common = path.join(root, 'shared-common');
    const port = () => common;
    registerEvidence([cmd()], { projectRoot: root, source: SOURCE, now: AT, resolveGitCommonDir: port });
    expect(readEvidenceIds(root, { resolveGitCommonDir: port })).toEqual(['E-001']);
    expect(readEvidenceIds(root)).toEqual([]);
  });
});

describe('lookupEvidenceIds', () => {
  /** sha256 of the registry file, or 'absent'. */
  const registrySha = () => {
    const p = evidenceRegistryPath(root);
    return existsSync(p) ? createHash('sha256').update(readFileSync(p)).digest('hex') : 'absent';
  };

  it('returns the id of content that was registered, matched by hash', () => {
    reg([cmd('a'), file()]);
    expect(lookupEvidenceIds(root, [file()])).toEqual(['E-002']);
    // Same content in another key order is the same evidence.
    expect(lookupEvidenceIds(root, [{ line: 12, file: 'lib/a.js', kind: 'file' }])).toEqual(['E-002']);
  });

  it('omits content that was never registered', () => {
    reg([cmd('a')]);
    expect(lookupEvidenceIds(root, [cmd('never'), cmd('a')])).toEqual(['E-001']);
    expect(lookupEvidenceIds(root, [cmd('never')])).toEqual([]);
  });

  it('keeps the FIRST id when two rows share a hash, as the writer does', () => {
    const p = evidenceRegistryPath(root);
    mkdirSync(path.dirname(p), { recursive: true });
    const h = evidenceHash(cmd('dup'));
    writeFileSync(p, [
      JSON.stringify({ id: 'E-004', type: 'command', source: 's', hash: h, created_at: 't' }),
      JSON.stringify({ id: 'E-002', type: 'command', source: 's', hash: h, created_at: 't' }),
      '',
    ].join('\n'));
    expect(lookupEvidenceIds(root, [cmd('dup')])).toEqual(['E-004']);
    // The writer agrees: registering the same content reuses that first id.
    expect(reg([cmd('dup')]).ids).toEqual(['E-004']);
  });

  it('returns [] for an absent registry, and creates nothing', () => {
    expect(lookupEvidenceIds(root, [cmd()])).toEqual([]);
    expect(existsSync(evidenceRegistryPath(root))).toBe(false);
    expect(existsSync(path.dirname(evidenceRegistryPath(root)))).toBe(false);
  });

  it('returns null when the registry cannot be read, and never throws', () => {
    mkdirSync(evidenceRegistryPath(root), { recursive: true });
    expect(lookupEvidenceIds(root, [cmd()])).toBeNull();
    expect(lookupEvidenceIds('', [cmd()])).toBeNull();
    expect(lookupEvidenceIds(root, [cmd()], { resolveGitCommonDir: () => { throw new Error('x'); } }))
      .toEqual([]);
  });

  it('skips a torn trailing line: a strict prefix of a row never parses', () => {
    reg([cmd('a')]);
    const p = evidenceRegistryPath(root);
    const whole = JSON.stringify({
      id: 'E-002', type: 'command', source: 's', hash: evidenceHash(cmd('b')), created_at: 't',
    });
    // Every strict prefix, the one a reader racing the append can see.
    for (let cut = 1; cut < whole.length; cut += 1) {
      writeFileSync(p, `${JSON.stringify({
        id: 'E-001', type: 'command', source: 's', hash: evidenceHash(cmd('a')), created_at: 't',
      })}\n${whole.slice(0, cut)}`);
      expect(lookupEvidenceIds(root, [cmd('a'), cmd('b')])).toEqual(['E-001']);
    }
    writeFileSync(p, `${readFileSync(p, 'utf8').split('\n')[0]}\n${whole}\n`);
    expect(lookupEvidenceIds(root, [cmd('a'), cmd('b')])).toEqual(['E-001', 'E-002']);
  });

  it('answers in entry order, each id once', () => {
    reg([cmd('a'), cmd('b')]);
    expect(lookupEvidenceIds(root, [cmd('b'), cmd('a'), cmd('b'), cmd('a')])).toEqual(['E-002', 'E-001']);
  });

  it('skips an entry it cannot hash, and a non-array list gives []', () => {
    reg([cmd('a')]);
    const loop = { kind: 'command' };
    loop.self = loop;
    expect(lookupEvidenceIds(root, [loop, cmd('a')])).toEqual(['E-001']);
    expect(lookupEvidenceIds(root, undefined)).toEqual([]);
    expect(lookupEvidenceIds(root, [])).toEqual([]);
  });

  it('never takes the lock and never writes: the registry bytes do not move', () => {
    reg([cmd('a')]);
    const p = evidenceRegistryPath(root);
    const before = registrySha();
    const mtime = statSync(p).mtimeMs;
    expect(lookupEvidenceIds(root, [cmd('a'), cmd('new')])).toEqual(['E-001']);
    expect(registrySha()).toBe(before);
    expect(statSync(p).mtimeMs).toBe(mtime);
    expect(readdirSync(path.dirname(p))).toEqual(['evidence.jsonl']);
  });

  it('does not wait behind a held lock, and leaves the holder alone', () => {
    reg([cmd('a')]);
    const lockPath = `${evidenceRegistryPath(root)}.lock`;
    writeFileSync(lockPath, JSON.stringify({ token: 'held', pid: 1, timestamp: Date.now() }));
    const t0 = Date.now();
    expect(lookupEvidenceIds(root, [cmd('a')])).toEqual(['E-001']);
    // A reader that queued behind this fresh lock would wait until the stale
    // window (5 s) let it take the lock over, and then the holder's file would
    // be gone, so both assertions below discriminate.
    expect(Date.now() - t0).toBeLessThan(REGISTRY_LOCK_DEFAULTS.staleMs);
    expect(readFileSync(lockPath, 'utf8')).toContain('held');
  });

  it('reads the same place the writer wrote through an injected port', () => {
    const port = () => path.join(root, 'shared-common');
    registerEvidence([cmd()], { projectRoot: root, source: SOURCE, now: AT, resolveGitCommonDir: port });
    expect(lookupEvidenceIds(root, [cmd()], { resolveGitCommonDir: port })).toEqual(['E-001']);
    expect(lookupEvidenceIds(root, [cmd()])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Concurrency — separate processes, because the lock is a cross-process lock.
//
// "waits for a held lock" PROVES the lock is taken and that it covers the READ.
// With the lock replaced by a direct call (mutation run 2026-09-23 12:43 KST)
// it went red while the unsynchronised race tests stayed green: child start-up
// on Windows staggers the writers enough that they rarely overlap. The foreign
// row it writes under the held lock is what catches a read taken outside the
// lock (review F3).
//
// The STRESS test closes the other gap. Its children wait on a barrier file and
// call `registerEvidence` together. Against the earlier `withFileLock` (a plain
// existsSync-then-writeFileSync, no O_EXCL) the same shape duplicated ids in
// 44 of 50 rounds of 4 writers and 30 of 30 rounds of 8 (scratch driver,
// 2026-09-23 13:54 KST). CI had caught it once without a barrier: GitHub run
// 35819414568 got 3 distinct ids from 4 writers.
// ---------------------------------------------------------------------------

const CHILD = [
  "import { existsSync } from 'node:fs';",
  "import path from 'node:path';",
  `import { registerEvidence } from ${JSON.stringify(MODULE_URL)};`,
  'const [projectRoot, entryJson, barrier] = process.argv.slice(2);',
  "process.stdout.write('ready\\n');",
  "if (barrier === '1') {",
  '  const sab = new Int32Array(new SharedArrayBuffer(4));',
  "  while (!existsSync(path.join(projectRoot, 'go'))) Atomics.wait(sab, 0, 0, 1);",
  '}',
  "const out = registerEvidence([JSON.parse(entryJson)], { projectRoot, source: 'child' });",
  "process.stdout.write(JSON.stringify(out) + '\\n');",
].join('\n');

/**
 * Run one registering child. Resolves with its parsed result; `onReady` fires
 * when the child is about to call `registerEvidence` (or, with `barrier`, to
 * wait for `<projectRoot>/go`).
 */
function runChild(entry, onReady = () => {}, { projectRoot = root, barrier = false } = {}) {
  const script = path.join(root, 'child.mjs');
  if (!existsSync(script)) writeFileSync(script, CHILD);
  return new Promise((resolve, reject) => {
    const args = [script, projectRoot, JSON.stringify(entry), barrier ? '1' : '0'];
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => {
      out += d;
      if (out.startsWith('ready\n')) onReady();
    });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) { reject(new Error(`child exit ${code}: ${err}`)); return; }
      resolve(JSON.parse(out.split('\n')[1]));
    });
  });
}

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

describe('id allocation under the file lock', () => {
  it('waits for a held lock before appending', async () => {
    const p = evidenceRegistryPath(root);
    mkdirSync(path.dirname(p), { recursive: true });
    const lock = `${p}.lock`;
    writeFileSync(lock, JSON.stringify({ pid: process.pid, timestamp: Date.now() }));
    let ready = false;
    const done = runChild(cmd(), () => { ready = true; });
    while (!ready) await sleep(20);
    await sleep(400);
    // Still inside the 5 s stale window, so a writer that honours the lock has
    // not appended yet.
    expect(existsSync(p) ? readFileSync(p, 'utf8') : '').toBe('');
    // Another writer's row lands WHILE the child waits. The lock must cover the
    // child's READ as well as its append: a child that read the (empty) file
    // before taking the lock would mint E-001 a second time.
    writeFileSync(p, `${JSON.stringify({ id: 'E-001', type: 'file', source: 'other', hash: 'b'.repeat(64), created_at: 't' })}\n`);
    rmSync(lock, { force: true });
    const out = await done;
    expect(out.ids).toEqual(['E-002']);
    expect(rows().map((r) => r.id)).toEqual(['E-001', 'E-002']);
  }, 20000);

  it('two writers registering the same new content mint one id', async () => {
    const [a, b] = await Promise.all([runChild(cmd()), runChild(cmd())]);
    expect(a.ids).toEqual(b.ids);
    expect(rows()).toHaveLength(1);
    expect(a.appended + b.appended).toBe(1);
  }, 20000);

  it('four writers registering different content mint four distinct ids', async () => {
    const outs = await Promise.all([1, 2, 3, 4].map((n) => runChild(cmd(`w${n}`))));
    const ids = outs.flatMap((o) => o.ids);
    expect(new Set(ids).size).toBe(4);
    expect(rows().map((r) => r.id).sort()).toEqual(['E-001', 'E-002', 'E-003', 'E-004']);
  }, 20000);

  it('eight writers released together mint eight distinct ids, three rounds running', async () => {
    const WRITERS = 8;
    for (let round = 0; round < 3; round += 1) {
      const projectRoot = path.join(root, `round-${round}`);
      mkdirSync(path.join(projectRoot, '.git'), { recursive: true });
      let ready = 0;
      const release = () => {
        ready += 1;
        if (ready === WRITERS) writeFileSync(path.join(projectRoot, 'go'), '');
      };
      const outs = await Promise.all(Array.from({ length: WRITERS }, (_, i) => runChild(
        cmd(`round${round}-writer${i}`), release, { projectRoot, barrier: true },
      )));
      const ids = outs.flatMap((o) => o.ids);
      const stored = readFileSync(evidenceRegistryPath(projectRoot), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      expect({ round, reasons: outs.filter((o) => o.reason).length, distinct: new Set(ids).size })
        .toEqual({ round, reasons: 0, distinct: WRITERS });
      expect({ round, rows: stored.length, distinctRowIds: new Set(stored.map((r) => r.id)).size })
        .toEqual({ round, rows: WRITERS, distinctRowIds: WRITERS });
    }
  }, 60000);
});

describe('the registry lock', () => {
  const lockOf = () => `${evidenceRegistryPath(root)}.lock`;
  const plantLock = (content, ageMs = 0) => {
    const lock = lockOf();
    mkdirSync(path.dirname(lock), { recursive: true });
    writeFileSync(lock, content);
    if (ageMs > 0) {
      const then = new Date(Date.now() - ageMs);
      utimesSync(lock, then, then);
    }
    return lock;
  };

  it('does not steal a FRESH lock whose content is empty or unparseable', () => {
    // A holder's lock is empty between its create and its write, so an empty
    // file is what a racing reader sees. Staleness is judged by age alone.
    for (const content of ['', '{"pid":12', 'not json']) {
      const lock = plantLock(content);
      const out = reg([cmd()], { lock: { timeoutMs: 150 } });
      expect({ content, out }).toEqual({ content, out: { ids: [], appended: 0, reused: 0, reason: 'lock-timeout' } });
      expect({ content, kept: existsSync(lock) && readFileSync(lock, 'utf8') }).toEqual({ content, kept: content });
      rmSync(lock, { force: true });
    }
    expect(existsSync(evidenceRegistryPath(root))).toBe(false);
  }, 20000);

  it('fails closed on timeout: no ids, no row, and the holder keeps its lock', () => {
    const lock = plantLock(JSON.stringify({ pid: process.pid, timestamp: Date.now() }));
    const started = Date.now();
    const out = reg([cmd()], { lock: { timeoutMs: 200 } });
    expect(out).toEqual({ ids: [], appended: 0, reused: 0, reason: 'lock-timeout' });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(existsSync(evidenceRegistryPath(root))).toBe(false);
    expect(existsSync(lock)).toBe(true);
  }, 20000);

  it('takes over a lock whose file is older than the stale window', () => {
    const lock = plantLock('', 60_000);
    const out = reg([cmd()], { lock: { timeoutMs: 1000, staleMs: 5000 } });
    expect(out).toEqual({ ids: ['E-001'], appended: 1, reused: 0 });
    expect(existsSync(lock)).toBe(false);
  });

  it('release removes only a lock that carries its own token', () => {
    // A holder taken over after `staleMs` must not delete the new holder's lock.
    const foreign = JSON.stringify({ token: 'foreign-holder-token', pid: 1, timestamp: Date.now() });
    const lock = plantLock(foreign);
    releaseLock(lock, 'our-holder-token');
    expect(existsSync(lock) && readFileSync(lock, 'utf8')).toBe(foreign);
    // Positive control: the owner's release does remove it.
    releaseLock(lock, 'foreign-holder-token');
    expect(existsSync(lock)).toBe(false);
  });

  it('leaves nothing but the registry behind after a registration', () => {
    reg([cmd('a')]);
    reg([cmd('b')]);
    expect(readdirSync(path.dirname(evidenceRegistryPath(root)))).toEqual(['evidence.jsonl']);
  });
});
