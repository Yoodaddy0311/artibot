/**
 * `lib/git/split-run-file.js` — run.json / plan.json read/write/update, the
 * window map, and the recorded fork point.
 *
 * WHAT THE `schema_version` CASES CANNOT SEE — they prove the stamp only for
 * bytes that go THROUGH this module, and the live plan.json usually does not:
 *   - `/split plan` step 7 (`commands/split.md:79`, read 2026-09-14 14:57 KST)
 *     has the LEADER write plan.json inline, not via `updatePlanJson`, so a
 *     freshly planned file carries no `schema_version` at all. It acquires one
 *     only at the first `dispatch`, which is the first writer to come through
 *     here. Nothing in these tests would notice if that never happened.
 *   - A plan.json whose limbs ALL have `forkPoint` pre-filled by hand stays
 *     unstamped forever: `dispatch.mjs#recordForkPoint` returns early when the
 *     value is already recorded and never calls `updatePlanJson`. That is
 *     consistent with the rule under test ("stamp on write, only when absent")
 *     rather than a defect in it — but note `commands/split.md:79` says plan
 *     must NOT write `forkPoint`, so that shape violates the doc first.
 * Consequence for a future reader: `schema_version` present means "some writer
 * used this module", never "this file is version 1". Do not gate on its absence.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  forkPointForLimb,
  planJsonPath,
  readPlanJson,
  readRunJson,
  runJsonPath,
  SPLIT_FILE_SCHEMA_VERSION,
  updatePlanJson,
  updateRunJson,
  windowForLimb,
  writeRunJson,
} from '../../lib/git/split-run-file.js';

const V = SPLIT_FILE_SCHEMA_VERSION;

const tmpDirs = [];
const mkTmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'split-run-'));
  tmpDirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('runJsonPath', () => {
  it('points at <parentRoot>/.artibot/split/run.json', () => {
    expect(runJsonPath('/r')).toBe(path.join('/r', '.artibot', 'split', 'run.json'));
  });
  it('rejects an empty root', () => {
    expect(() => runJsonPath('')).toThrow(TypeError);
  });
});

describe('readRunJson', () => {
  it('returns null when the file is missing (directory may not exist either)', () => {
    expect(readRunJson(mkTmp())).toBeNull();
  });

  it('parses an existing file, tolerating a BOM', () => {
    const root = mkTmp();
    fs.mkdirSync(path.dirname(runJsonPath(root)), { recursive: true });
    fs.writeFileSync(runJsonPath(root), '\uFEFF{"runId":"split-1"}');
    expect(readRunJson(root)).toEqual({ runId: 'split-1' });
  });

  it('throws on malformed JSON instead of pretending the ledger is empty', () => {
    const root = mkTmp();
    fs.mkdirSync(path.dirname(runJsonPath(root)), { recursive: true });
    fs.writeFileSync(runJsonPath(root), '{ not json');
    expect(() => readRunJson(root)).toThrow();
  });

  it('throws when the file is a JSON array or scalar', () => {
    const root = mkTmp();
    fs.mkdirSync(path.dirname(runJsonPath(root)), { recursive: true });
    fs.writeFileSync(runJsonPath(root), '[1,2]');
    expect(() => readRunJson(root)).toThrow(/not a JSON object/);
  });
});

describe('writeRunJson', () => {
  it('creates the directory, writes pretty JSON with a trailing newline, leaves no tmp file', () => {
    const root = mkTmp();
    const p = writeRunJson(root, { runId: 'split-2', limbs: ['a'] });
    expect(p).toBe(runJsonPath(root));
    const text = fs.readFileSync(p, 'utf-8');
    expect(text.endsWith('\n')).toBe(true);
    expect(JSON.parse(text)).toEqual({ runId: 'split-2', limbs: ['a'], schema_version: V });
    expect(fs.readdirSync(path.dirname(p)).filter((f) => f.includes('.tmp'))).toEqual([]);
  });

  it('round-trips through readRunJson', () => {
    const root = mkTmp();
    writeRunJson(root, { a: 1, nested: { b: [1, 2] } });
    expect(readRunJson(root)).toEqual({ a: 1, nested: { b: [1, 2] }, schema_version: V });
  });

  it('replaces the previous content atomically (no partial merge)', () => {
    const root = mkTmp();
    writeRunJson(root, { a: 1, b: 2 });
    writeRunJson(root, { c: 3 });
    expect(readRunJson(root)).toEqual({ c: 3, schema_version: V });
  });

  it('stamps schema_version last, leaving the caller object untouched', () => {
    const root = mkTmp();
    const obj = { runId: 'x', stage: 'planned' };
    const p = writeRunJson(root, obj);
    expect(Object.keys(obj)).toEqual(['runId', 'stage']); // 호출자 객체는 변형하지 않는다
    expect(Object.keys(JSON.parse(fs.readFileSync(p, 'utf-8')))).toEqual(['runId', 'stage', 'schema_version']);
  });

  it('preserves an existing schema_version instead of relabelling the file', () => {
    const root = mkTmp();
    writeRunJson(root, { schema_version: 99, a: 1 });
    expect(readRunJson(root).schema_version).toBe(99);
    // 명시적 falsy 값도 "없음" 이 아니다: hasOwn 으로 판정한다.
    writeRunJson(root, { schema_version: 0, a: 1 });
    expect(readRunJson(root).schema_version).toBe(0);
  });

  it('rejects non-object payloads', () => {
    const root = mkTmp();
    expect(() => writeRunJson(root, null)).toThrow(TypeError);
    expect(() => writeRunJson(root, [1])).toThrow(TypeError);
  });
});

describe('updateRunJson', () => {
  it('starts from {} when the file is missing and stores fn\'s return value', () => {
    const root = mkTmp();
    const out = updateRunJson(root, (cur) => ({ ...cur, stage: 'planned' }));
    // 반환값은 fn 의 결과 그대로다 — 스탬프는 기록되는 바이트에만 붙는다.
    expect(out).toEqual({ stage: 'planned' });
    expect(readRunJson(root)).toEqual({ stage: 'planned', schema_version: V });
  });

  it('keeps the mutated input when fn returns undefined', () => {
    const root = mkTmp();
    writeRunJson(root, { stage: 'planned' });
    updateRunJson(root, (cur) => { cur.stage = 'opened'; });
    expect(readRunJson(root)).toEqual({ stage: 'opened', schema_version: V });
  });

  it('preserves unrelated keys across updates', () => {
    const root = mkTmp();
    writeRunJson(root, { runId: 'x', windows: { a: 'sess-a @ /p' } });
    updateRunJson(root, (cur) => ({ ...cur, suspend: { at: 't' } }));
    expect(readRunJson(root)).toEqual({
      runId: 'x', windows: { a: 'sess-a @ /p' }, suspend: { at: 't' }, schema_version: V,
    });
  });

  it('rejects a non-function updater', () => {
    expect(() => updateRunJson(mkTmp(), null)).toThrow(TypeError);
  });
});

describe('planJsonPath / readPlanJson', () => {
  it('sits next to run.json', () => {
    expect(planJsonPath('/r')).toBe(path.join('/r', '.artibot', 'split', 'plan.json'));
    expect(() => planJsonPath('')).toThrow(TypeError);
  });

  it('returns null when missing, parses a BOM, throws on damage', () => {
    const root = mkTmp();
    expect(readPlanJson(root)).toBeNull();
    fs.mkdirSync(path.dirname(planJsonPath(root)), { recursive: true });
    fs.writeFileSync(planJsonPath(root), '﻿{"runId":"p-1"}');
    expect(readPlanJson(root)).toEqual({ runId: 'p-1' });
    fs.writeFileSync(planJsonPath(root), '{ not json');
    expect(() => readPlanJson(root)).toThrow();
    fs.writeFileSync(planJsonPath(root), '[1]');
    expect(() => readPlanJson(root)).toThrow(/not a JSON object/);
  });

  it('does not read run.json by mistake', () => {
    const root = mkTmp();
    writeRunJson(root, { runId: 'from-run' });
    expect(readPlanJson(root)).toBeNull();
  });
});

describe('updatePlanJson', () => {
  const plan = () => ({
    runId: 'split-9',
    base: 'b'.repeat(40),
    limbs: [{ limb: 'a', branch: 'limb-a' }, { limb: 'b', branch: 'limb-b' }],
  });

  it('records forkPoint on one limb, leaving every other key and limb intact', () => {
    const root = mkTmp();
    updatePlanJson(root, () => plan());
    updatePlanJson(root, (cur) => ({
      ...cur,
      limbs: cur.limbs.map((l) => (l.limb === 'a' ? { ...l, forkPoint: 'f'.repeat(40) } : l)),
    }));
    expect(readPlanJson(root)).toEqual({
      ...plan(),
      limbs: [{ limb: 'a', branch: 'limb-a', forkPoint: 'f'.repeat(40) }, { limb: 'b', branch: 'limb-b' }],
      schema_version: V,
    });
  });

  it('writes atomically and leaves no tmp file behind', () => {
    const root = mkTmp();
    updatePlanJson(root, () => plan());
    const text = fs.readFileSync(planJsonPath(root), 'utf-8');
    expect(text.endsWith('\n')).toBe(true);
    expect(fs.readdirSync(path.dirname(planJsonPath(root))).filter((f) => f.includes('.tmp'))).toEqual([]);
  });

  it('keeps a schema_version the plan already carries', () => {
    const root = mkTmp();
    updatePlanJson(root, () => ({ ...plan(), schema_version: 7 }));
    updatePlanJson(root, (cur) => { cur.base = 'c'.repeat(40); });
    expect(readPlanJson(root).schema_version).toBe(7);
  });

  it('starts from {} when the plan is missing, and rejects a bad updater or result', () => {
    const root = mkTmp();
    expect(updatePlanJson(root, (cur) => ({ ...cur, runId: 'new' }))).toEqual({ runId: 'new' });
    expect(() => updatePlanJson(root, null)).toThrow(TypeError);
    expect(() => updatePlanJson(root, () => [1])).toThrow(TypeError);
  });
});

/* ══════════ SH-11 pre-flip condition (3): plan.json read-modify-write is ONE at a time ══════════
 *
 * `updatePlanJson` used to read, run `fn`, then rename with nothing stopping a
 * second window from doing the same in between (the bind race the run-to-mission
 * binder documents as M1). The lock is `withFileLock(plan.json)`: a sentinel
 * `plan.json.lock`, exclusive, fail-closed (ELOCKTIMEOUT, the holder's lock
 * untouched), re-entry refused.
 *
 * WHAT THESE CASES CANNOT SEE: a holder slower than the lock's stale threshold
 * (10 s — `fn` here is a few lines), a lock stranded by SIGKILL (reclaimed by
 * the lock module's own stale rules, measured in tests/core/file-lock*.test.js),
 * and any writer that does not go through `updatePlanJson` — the leader's inline
 * plan write at `/split plan` time still takes no lock.
 */
describe('updatePlanJson — one read-modify-write at a time (SH-11 pre-flip 3)', () => {
  const lockOf = (root) => `${planJsonPath(root)}.lock`;
  const libUrl = new URL('../../lib/git/split-run-file.js', import.meta.url).href;

  it('holds the plan.json lock for the whole read-modify-write, and the holder is this process', () => {
    const root = mkTmp();
    let seen = null;
    updatePlanJson(root, (cur) => {
      seen = fs.existsSync(lockOf(root)) ? JSON.parse(fs.readFileSync(lockOf(root), 'utf-8')) : null;
      return { ...cur, runId: 'split-lock' };
    });
    expect(seen).not.toBeNull();
    expect(seen.pid).toBe(process.pid);
    expect(readPlanJson(root).runId).toBe('split-lock');
  });

  it('releases the lock afterwards — on success and when fn throws — and leaves no tmp file', () => {
    const root = mkTmp();
    updatePlanJson(root, () => ({ runId: 'a' }));
    expect(fs.existsSync(lockOf(root))).toBe(false);
    expect(() => updatePlanJson(root, () => { throw new Error('boom'); })).toThrow('boom');
    expect(fs.existsSync(lockOf(root))).toBe(false);
    expect(() => updatePlanJson(root, () => [1])).toThrow(TypeError);
    expect(fs.existsSync(lockOf(root))).toBe(false);
    expect(fs.readdirSync(path.dirname(planJsonPath(root))).sort()).toEqual(['plan.json']);
    expect(readPlanJson(root)).toEqual({ runId: 'a', schema_version: V }); // and the failed attempts wrote nothing
  });

  it('a nested update from inside fn is refused instead of interleaving — the outer write keeps its read', () => {
    const root = mkTmp();
    updatePlanJson(root, () => ({ runId: 'split-nest', base: 'b'.repeat(40) }));
    let inner = null;
    updatePlanJson(root, (cur) => {
      try {
        updatePlanJson(root, (c2) => ({ ...c2, inner: true }));
      } catch (err) {
        inner = err;
      }
      return { ...cur, outer: true };
    });
    expect(inner?.code).toBe('ELOCKREENTRANT');
    expect(readPlanJson(root)).toEqual({ runId: 'split-nest', base: 'b'.repeat(40), outer: true, schema_version: V });
  });

  describe('across processes', () => {
    const kids = [];
    afterEach(() => {
      for (const k of kids.splice(0)) {
        try { k.kill('SIGKILL'); } catch { /* already gone */ }
      }
    });
    const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    const waitFor = (file, ms) => {
      const until = Date.now() + ms;
      while (!fs.existsSync(file)) {
        if (Date.now() > until) throw new Error(`timed out waiting for ${path.basename(file)}`);
        pause(5);
      }
    };

    /**
     * A child that parks at a barrier file, then does ONE `updatePlanJson` and writes its verdict to a file.
     * It is up and parked BEFORE this process takes any lock, so how long it takes to start cannot
     * lengthen the time the lock is held (the lock goes stale after 10 s).
     */
    function startChild(root, tag) {
      const script = path.join(root, 'plan-writer-child.mjs');
      if (!fs.existsSync(script)) {
        fs.writeFileSync(script, [
          "import { existsSync, writeFileSync } from 'node:fs';",
          `import { updatePlanJson } from ${JSON.stringify(libUrl)};`,
          'const [root, ready, go, result] = process.argv.slice(2);',
          'const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);',
          "writeFileSync(ready, '1');",
          'const until = Date.now() + 20000;',
          'while (!existsSync(go)) { if (Date.now() > until) process.exit(98); pause(2); }',
          'try {',
          "  updatePlanJson(root, (cur) => ({ ...cur, child: 'wrote' }));",
          "  writeFileSync(result, 'WROTE');",
          '} catch (err) {',
          "  writeFileSync(result, 'FAILED:' + (err && err.code));",
          '}',
          '',
        ].join('\n'));
      }
      const at = (ext) => path.join(root, `${tag}.${ext}`);
      const p = { ready: at('ready'), go: at('go'), result: at('result') };
      kids.push(spawn(process.execPath, [script, root, p.ready, p.go, p.result], { stdio: 'ignore', windowsHide: true }));
      waitFor(p.ready, 20_000);
      return p;
    }

    it('another PROCESS cannot interleave: it fails closed while this one holds the lock, and writes once the lock is free', () => {
      const root = mkTmp();
      updatePlanJson(root, () => ({ runId: 'split-proc' }));

      const held = startChild(root, 'held');
      updatePlanJson(root, (cur) => {
        fs.writeFileSync(held.go, ''); // release the child while THIS process holds the lock...
        waitFor(held.result, 20_000); // ...and wait for its answer: it gives up after the lock's wait budget
        return { ...cur, outer: true };
      });
      expect(fs.readFileSync(held.result, 'utf-8')).toBe('FAILED:ELOCKTIMEOUT');
      expect(readPlanJson(root)).toEqual({ runId: 'split-proc', outer: true, schema_version: V });

      // CONTROL: the same child, released with the lock free, writes — so the refusal above was the lock, not a broken child.
      const free = startChild(root, 'free');
      fs.writeFileSync(free.go, '');
      waitFor(free.result, 20_000);
      expect(fs.readFileSync(free.result, 'utf-8')).toBe('WROTE');
      expect(readPlanJson(root)).toEqual({ runId: 'split-proc', outer: true, child: 'wrote', schema_version: V });
      expect(fs.existsSync(lockOf(root))).toBe(false);
    }, 60_000);
  });
});

describe('forkPointForLimb', () => {
  const planWith = (forkPoint) => ({ base: 'b', limbs: [{ limb: 'a', forkPoint }, { limb: 'z' }] });

  it('returns the recorded sha for the named limb', () => {
    expect(forkPointForLimb(planWith('f'.repeat(40)), 'a')).toBe('f'.repeat(40));
    expect(forkPointForLimb(planWith(' f0f0 \n'), 'a')).toBe('f0f0');
  });

  it('returns null when nothing was recorded — never falls back to plan.base', () => {
    // 폴백은 호출자의 결정이다: "기록됨" 과 "base 와 같음" 은 다른 사실이다.
    expect(forkPointForLimb(planWith(undefined), 'a')).toBeNull();
    expect(forkPointForLimb(planWith(''), 'a')).toBeNull();
    expect(forkPointForLimb(planWith('   '), 'a')).toBeNull();
    expect(forkPointForLimb(planWith(42), 'a')).toBeNull();
    expect(forkPointForLimb(planWith('f'), 'z')).toBeNull();
  });

  it('returns null for an unknown limb or a malformed plan', () => {
    expect(forkPointForLimb(planWith('f'), 'nope')).toBeNull();
    expect(forkPointForLimb({ limbs: 'not-an-array' }, 'a')).toBeNull();
    expect(forkPointForLimb({ limbs: [null, 'x'] }, 'a')).toBeNull();
    expect(forkPointForLimb(null, 'a')).toBeNull();
    expect(forkPointForLimb(planWith('f'), 42)).toBeNull();
  });
});

describe('windowForLimb', () => {
  it('reads the Ontology string form "<session> @ <path>" from windowReuse', () => {
    expect(windowForLimb({ windowReuse: { auth: 'split-x-auth-3f @ C:/wt' } }, 'auth')).toBe('split-x-auth-3f');
  });

  it('prefers windows[limb] over windowReuse[limb]', () => {
    const run = { windows: { auth: { session: 'new-1' } }, windowReuse: { auth: 'old-1 @ p' } };
    expect(windowForLimb(run, 'auth')).toBe('new-1');
  });

  it('accepts object entries with session / name / to', () => {
    expect(windowForLimb({ windows: { a: { name: 'n1' } } }, 'a')).toBe('n1');
    expect(windowForLimb({ windows: { a: { to: 'n2' } } }, 'a')).toBe('n2');
  });

  it('returns null for unknown limb, empty name, or missing tables', () => {
    expect(windowForLimb({ windowReuse: { a: 'x @ p' } }, 'b')).toBeNull();
    expect(windowForLimb({ windowReuse: { a: ' @ p' } }, 'a')).toBeNull();
    expect(windowForLimb({}, 'a')).toBeNull();
    expect(windowForLimb(null, 'a')).toBeNull();
    expect(windowForLimb({ windows: { a: 42 } }, 'a')).toBeNull();
  });
});
