/**
 * `scripts/split/fanout-probe.mjs` — classification is a pure function over
 * fake directory listings. The real `~/.claude/projects` is never read: the
 * scanner is pointed at a temp dir with hand-made `.jsonl` files whose mtimes
 * are set with `utimesSync`.
 *
 * Not covered: the harness's transcript layout staying what it was on
 * 2026-09-02 (main `<sid>.jsonl` + subagents under `<sid>/`). If that
 * changes, every window reads as `idle` and the probe goes quiet — a known
 * blind spot, listed in laneC-notes.md.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  classifyWindows,
  DEFAULT_PROBE,
  formatEvents,
  limbByWindow,
  observedProjectSlug,
  parseArgs,
  projectDirPrefixes,
  scanWindows,
  WORKTREE_INFIX,
} from '../../scripts/split/fanout-probe.mjs';

const NOW = Date.parse('2026-09-02T12:00:00Z');
const MIN = 60000;

/**
 * @param {Partial<import('../../scripts/split/fanout-probe.mjs').WindowScan>} w
 * @returns {object}
 */
const win = (w) => ({ window: 'split-repo-a', prefix: 'p', sid: 'abcdef0123456789', mainMtimeMs: NOW - MIN, subTotal: 3, subActive: 1, ...w });

describe('classifyWindows (pure)', () => {
  const run = { lanes: { a: { state: 'active' }, r: 'review', d: 'done' } };
  const byWin = new Map([['split-repo-a', 'a'], ['split-repo-r', 'r'], ['split-repo-d', 'd']]);
  const base = { nowMs: NOW, mainActiveMs: 10 * MIN, limbByWindow: byWin, run };

  it('active lane, main fresh, no subagent activity → solo', () => {
    const [e] = classifyWindows({ ...base, windows: [win({ subActive: 0 })] });
    expect(e).toMatchObject({ kind: 'solo', limb: 'a', opsState: 'active', mainAgeMin: 1, subTotal: 3, subActive: 0 });
  });

  it('active lane with subagent activity → ok', () => {
    expect(classifyWindows({ ...base, windows: [win({})] })[0].kind).toBe('ok');
  });

  it('main transcript older than the window → idle regardless of subagents', () => {
    expect(classifyWindows({ ...base, windows: [win({ mainMtimeMs: NOW - 11 * MIN, subActive: 0 })] })[0].kind).toBe('idle');
    expect(classifyWindows({ ...base, windows: [win({ mainMtimeMs: null })] })[0]).toMatchObject({ kind: 'idle', mainAgeMin: null });
  });

  it('known non-active ops state suppresses the alert (skip)', () => {
    const out = classifyWindows({ ...base, windows: [win({ window: 'split-repo-r', subActive: 0 }), win({ window: 'split-repo-d', subActive: 0 })] });
    expect(out.map((e) => e.kind)).toEqual(['skip', 'skip']);
    expect(out[0].opsState).toBe('review');
  });

  it('fails closed: unknown window or unknown state still alerts, marked opsState null', () => {
    const unknownWindow = classifyWindows({ ...base, windows: [win({ window: 'stray-window', subActive: 0 })] })[0];
    expect(unknownWindow).toMatchObject({ kind: 'solo', limb: null, opsState: null });
    const noLanes = classifyWindows({ ...base, run: { limbs: ['a'] }, windows: [win({ subActive: 0 })] })[0];
    expect(noLanes).toMatchObject({ kind: 'solo', limb: 'a', opsState: null });
    const bogusState = classifyWindows({ ...base, run: { lanes: { a: 'paused' } }, windows: [win({ subActive: 0 })] })[0];
    expect(bogusState).toMatchObject({ kind: 'solo', opsState: null });
  });

  it('window name match is case-insensitive; malformed entries are skipped', () => {
    const e = classifyWindows({ ...base, windows: [win({ window: 'Split-Repo-A', subActive: 0 }), null, { nope: 1 }] });
    expect(e).toHaveLength(1);
    expect(e[0].limb).toBe('a');
  });
});

describe('formatEvents', () => {
  const events = [
    { kind: 'solo', window: 'w1', sid: 'abcdef0123', mainAgeMin: 2, subTotal: 4, subActive: 0, limb: 'a', opsState: 'active' },
    { kind: 'solo', window: 'w2', sid: null, mainAgeMin: 0, subTotal: 0, subActive: 0, limb: null, opsState: null },
    { kind: 'ok', window: 'w3', sid: 'x', mainAgeMin: 1, subTotal: 2, subActive: 2, limb: 'b', opsState: 'active' },
    { kind: 'skip', window: 'w4', sid: 'x', mainAgeMin: 1, subTotal: 2, subActive: 0, limb: 'c', opsState: 'review' },
    { kind: 'idle', window: 'w5', sid: 'x', mainAgeMin: 40, subTotal: 2, subActive: 0, limb: 'd', opsState: 'active' },
  ];

  it('prints only SOLO by default; unknown state gets the suffix', () => {
    const lines = formatEvents(events);
    expect(lines).toEqual([
      '[fanout SOLO] w1 limb=a sid=abcdef01 main活2분전 서브에이전트 누계=4 5분내활동=0 state=active',
      '[fanout SOLO] w2 sid=- main活0분전 서브에이전트 누계=0 5분내활동=0 (state unknown)',
    ]);
  });

  it('--all adds ok/skip/idle lines; quiet input prints nothing', () => {
    const lines = formatEvents(events, { all: true });
    expect(lines).toHaveLength(5);
    expect(lines[2]).toBe('[fanout ok] w3 limb=b 누계=2 활동=2 state=active');
    expect(lines[3]).toBe('[fanout skip] w4 limb=c state=review (not active)');
    expect(lines[4]).toBe('[fanout idle] w5 limb=d main 40분전');
    expect(formatEvents([])).toEqual([]);
    expect(formatEvents([events[2]])).toEqual([]);
  });
});

describe('limbByWindow / prefixes / args', () => {
  it('maps plan worktreePath (over worktreeName), run.windowReuse "@ path" and run.windows objects', () => {
    const plan = { limbs: [
      { limb: 'schema', worktreeName: 'split-ontology-schema', worktreePath: 'C:/x/.claude/worktrees/split-ontology-w2a-schema' },
      { limb: 'plain', worktreeName: 'split-ontology-plain' },
    ] };
    const run = {
      windowReuse: { hardening: 'curious-inventing-lagoon-9f @ C:/x/.claude/worktrees/curious-inventing-lagoon', broken: 'no-at-sign' },
      windows: { objform: { session: 's', worktreePath: 'C:\\x\\.claude\\worktrees\\Obj-Form\\' } },
    };
    const m = limbByWindow(plan, run);
    expect(m.get('split-ontology-w2a-schema')).toBe('schema');
    expect(m.get('split-ontology-schema')).toBe('schema');
    expect(m.get('split-ontology-plain')).toBe('plain');
    expect(m.get('curious-inventing-lagoon')).toBe('hardening');
    expect(m.get('obj-form')).toBe('objform');
    expect(m.has('no-at-sign')).toBe(false);
    expect(limbByWindow(null, null).size).toBe(0);
  });

  it('projectDirPrefixes carries the OBSERVED harness encoding (C--Users-…) as well as the canonical slug', () => {
    expect(observedProjectSlug('C:/Users/x/Desktop/Ontology')).toBe('C--Users-x-Desktop-Ontology');
    expect(observedProjectSlug('C:\\Users\\x\\Desktop\\AI\\Artibot\\')).toBe('C--Users-x-Desktop-AI-Artibot');
    const prefixes = projectDirPrefixes('C:/Users/x/Desktop/Ontology');
    expect(prefixes).toContain(`C--Users-x-Desktop-Ontology${WORKTREE_INFIX}`);
    expect(new Set(prefixes).size).toBe(prefixes.length);
    for (const p of prefixes) expect(p.endsWith(WORKTREE_INFIX)).toBe(true);
  });

  it('parseArgs', () => {
    expect(parseArgs(['--all', '--parent', 'C:/tmp/x'])).toEqual({ all: true, parent: path.resolve('C:/tmp/x') });
    expect(parseArgs([]).all).toBe(false);
    expect(DEFAULT_PROBE).toEqual({ mainActiveMinutes: 10, subagentActiveMinutes: 5 });
  });
});

describe('scanWindows on a fake projects dir', () => {
  /** @type {string} */ let root = '';
  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'fanout-projects-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /**
   * @param {string} file
   * @param {number} mtimeMs
   */
  function touch(file, mtimeMs) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '{}\n');
    utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
  }

  it('finds windows by prefix, picks the newest main, counts active subagents; ignores other dirs', () => {
    const prefix = `C--Users-x-Desktop-Repo${WORKTREE_INFIX}`;
    const solo = path.join(root, `${prefix}split-repo-solo`);
    touch(path.join(solo, 'old.jsonl'), NOW - 60 * MIN);
    touch(path.join(solo, 'sid-solo.jsonl'), NOW - 1 * MIN);
    touch(path.join(solo, 'sid-solo', 'sub1.jsonl'), NOW - 30 * MIN);
    const busy = path.join(root, `${prefix}split-repo-busy`);
    touch(path.join(busy, 'sid-busy.jsonl'), NOW - 2 * MIN);
    touch(path.join(busy, 'sid-busy', 'deep', 'sub1.jsonl'), NOW - 1 * MIN);
    touch(path.join(busy, 'sid-busy', 'sub2.jsonl'), NOW - 20 * MIN);
    touch(path.join(root, 'C--Users-x-Desktop-Other--claude-worktrees-z', 'sid.jsonl'), NOW);
    mkdirSync(path.join(root, `${prefix}empty`));

    const scanned = scanWindows({ projectsRoot: root, prefixes: [prefix], nowMs: NOW, subActiveMs: 5 * MIN })
      .sort((a, b) => a.window.localeCompare(b.window));
    expect(scanned.map((w) => w.window)).toEqual(['empty', 'split-repo-busy', 'split-repo-solo']);
    expect(scanned[0]).toMatchObject({ sid: null, mainMtimeMs: null, subTotal: 0, subActive: 0 });
    expect(scanned[1]).toMatchObject({ sid: 'sid-busy', subTotal: 2, subActive: 1 });
    expect(scanned[2]).toMatchObject({ sid: 'sid-solo', subTotal: 1, subActive: 0 });

    const events = classifyWindows({ windows: scanned, nowMs: NOW, mainActiveMs: 10 * MIN, limbByWindow: new Map([['split-repo-solo', 'solo'], ['split-repo-busy', 'busy']]), run: { lanes: { solo: 'active', busy: 'active' } } })
      .sort((a, b) => a.window.localeCompare(b.window));
    expect(events.map((e) => e.kind)).toEqual(['idle', 'ok', 'solo']);
    expect(formatEvents(events)).toEqual(['[fanout SOLO] split-repo-solo limb=solo sid=sid-solo main活1분전 서브에이전트 누계=1 5분내활동=0 state=active']);
  });

  it('missing projects dir → [] (never throws)', () => {
    expect(scanWindows({ projectsRoot: path.join(root, 'nope'), prefixes: ['x'], nowMs: NOW, subActiveMs: MIN })).toEqual([]);
  });
});
