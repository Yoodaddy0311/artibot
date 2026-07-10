/**
 * Tests for lib/planning/scorecard.js — the /scorecard evidence-gated scoring
 * engine (snapshots model). Confirmed contract (leader + sl-dev Task #12):
 *   - loadScorecard({projectRoot}) -> { snapshots: [] } (absent -> empty)
 *   - addSnapshot(store, { label, areas, now }) -> NEW store (input never mutated).
 *       areas = [{ name, score, evidence:[{file,note}] }]; score clamped 0..100;
 *       an area with empty evidence is kept but marked { unverified: true }.
 *   - diffSnapshots(prev, curr) -> [{ name, before, after, delta, remaining }]
 *       added: before=null; removed: after=null & delta=null; remaining = 100 - after.
 *   - renderScorecard(rows, { barWidth=10 }) -> GFM table + ▰▱ gauge; before null -> "—";
 *       unverified area -> name '*' + footnote.
 *   - saveScorecard({projectRoot}, store) -> atomic (tmp -> rename), no residue.
 *   - `now` is an injected param (no direct Date.now()).
 *
 * @module tests/planning/scorecard
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'lib', 'planning', 'scorecard.js');

/** Run the scorecard CLI in `cwd`, piping `stdin` (for `add`). Returns { stdout, status }. */
function runCli(args, { cwd, stdin = '' } = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd, input: stdin, encoding: 'utf8' });
}

// Guarded import: until sl-dev lands the snapshots-model rewrite, missing exports
// surface as clear per-test failures instead of a collection crash (TDD RED).
let mod = {};
try {
  mod = await import('../../lib/planning/scorecard.js');
} catch {
  mod = {};
}

const FIXED_NOW = () => new Date('2026-07-10T04:00:00.000Z');

/** area with real evidence */
function area(name, score, note = `${name} 근거`) {
  return { name, score, evidence: [{ file: `src/${name}.js`, note }] };
}

/** Build a store by adding one snapshot with the given areas. */
function storeWith(areas, label = 'snap', now = FIXED_NOW) {
  const empty = { snapshots: [] };
  return mod.addSnapshot(empty, { label, areas, now });
}

describe('addSnapshot — immutability', () => {
  it('returns a new store and never mutates the input', () => {
    expect(typeof mod.addSnapshot, 'scorecard.js must export addSnapshot').toBe('function');
    const before = { snapshots: [] };
    const after = mod.addSnapshot(before, { label: 'v1', areas: [area('perf', 80)], now: FIXED_NOW });
    expect(after).not.toBe(before);
    expect(before.snapshots).toHaveLength(0); // original untouched
    expect(after.snapshots).toHaveLength(1);
  });

  it('appends successive snapshots without dropping earlier ones', () => {
    let store = { snapshots: [] };
    store = mod.addSnapshot(store, { label: 'v1', areas: [area('perf', 50)], now: FIXED_NOW });
    const afterFirst = store;
    store = mod.addSnapshot(store, { label: 'v2', areas: [area('perf', 70)], now: FIXED_NOW });
    expect(afterFirst.snapshots).toHaveLength(1); // prior store snapshot unchanged
    expect(store.snapshots).toHaveLength(2);
  });
});

describe('addSnapshot — score clamp', () => {
  it('clamps below 0 up to 0 and above 100 down to 100', () => {
    expect(typeof mod.addSnapshot).toBe('function');
    const store = storeWith([area('low', -5), area('high', 150)]);
    const snap = store.snapshots.at(-1);
    const byName = Object.fromEntries(snap.areas.map((a) => [a.name, a.score]));
    expect(byName.low).toBe(0);
    expect(byName.high).toBe(100);
  });

  it('keeps in-range scores unchanged', () => {
    const snap = storeWith([area('mid', 73)]).snapshots.at(-1);
    expect(snap.areas[0].score).toBe(73);
  });
});

describe('addSnapshot — evidence & unverified marking', () => {
  it('marks an area with empty evidence as unverified (kept, not rejected)', () => {
    expect(typeof mod.addSnapshot).toBe('function');
    const store = mod.addSnapshot(
      { snapshots: [] },
      { label: 'v', areas: [{ name: 'perf', score: 80, evidence: [] }], now: FIXED_NOW },
    );
    const a = store.snapshots.at(-1).areas.find((x) => x.name === 'perf');
    expect(a).toBeTruthy(); // kept, not dropped
    expect(a.unverified).toBe(true);
    // unverified is an honesty flag, NOT a penalty — the score stays as given.
    expect(a.score).toBe(80);
  });

  it('does not mark an area that has evidence', () => {
    const a = storeWith([area('perf', 80)]).snapshots.at(-1).areas[0];
    expect(a.unverified).toBeFalsy();
  });

  it('uses the injected now for the snapshot timestamp (no wall-clock)', () => {
    const snap = storeWith([area('perf', 80)], 'v', FIXED_NOW).snapshots.at(-1);
    // Whatever field holds the time, it must reflect the injected now, not "now".
    const serialized = JSON.stringify(snap);
    expect(serialized).toContain('2026-07-10T04:00:00.000Z');
  });
});

describe('diffSnapshots — added / removed / delta / remaining', () => {
  it('computes per-area delta and remaining, and flags added/removed areas', () => {
    expect(typeof mod.diffSnapshots, 'scorecard.js must export diffSnapshots').toBe('function');
    const prev = storeWith([area('perf', 50), area('security', 60)]).snapshots.at(-1);
    const curr = storeWith([area('perf', 80), area('a11y', 70)]).snapshots.at(-1); // security removed, a11y added

    const rows = mod.diffSnapshots(prev, curr);
    const byName = Object.fromEntries(rows.map((r) => [r.name, r]));

    // changed
    expect(byName.perf).toMatchObject({ before: 50, after: 80, delta: 30, remaining: 20 });
    // added -> before null, remaining = 100 - after
    expect(byName.a11y).toMatchObject({ before: null, after: 70, remaining: 30 });
    // removed -> after null, delta null
    expect(byName.security).toMatchObject({ before: 60, after: null, delta: null });
  });

  it('returns flat rows (not an {added,removed,deltas} object)', () => {
    const rows = mod.diffSnapshots(
      storeWith([area('perf', 50)]).snapshots.at(-1),
      storeWith([area('perf', 60)]).snapshots.at(-1),
    );
    expect(Array.isArray(rows)).toBe(true);
    expect(rows[0]).toHaveProperty('name');
    expect(rows[0]).toHaveProperty('remaining');
  });

  it('carries the unverified flag through into the diff row', () => {
    const prev = storeWith([area('perf', 50)]).snapshots.at(-1);
    const curr = mod.addSnapshot({ snapshots: [] }, {
      label: 'v', now: FIXED_NOW,
      areas: [{ name: 'perf', score: 90, evidence: [] }], // unverified
    }).snapshots.at(-1);
    const row = mod.diffSnapshots(prev, curr).find((r) => r.name === 'perf');
    expect(row.unverified).toBe(true);
  });
});

describe('renderScorecard — GFM table + gauge', () => {
  const rows = () => mod.diffSnapshots(
    storeWith([area('perf', 50)]).snapshots.at(-1),
    storeWith([area('perf', 80), area('new', 40)]).snapshots.at(-1),
  );

  it('renders the confirmed column header and a gauge honoring barWidth', () => {
    expect(typeof mod.renderScorecard, 'scorecard.js must export renderScorecard').toBe('function');
    const md = mod.renderScorecard(rows(), { barWidth: 10 });
    expect(md).toContain('| 평가 항목 | 작업 전 | 작업 후 | 상승폭 | 남은 갭 |');
    expect(md).toMatch(/[▰▱]/); // gauge glyphs present
    // gauge must not exceed barWidth cells
    for (const m of md.matchAll(/([▰▱]+)/g)) {
      expect(m[1].length, `gauge "${m[1]}" exceeds barWidth`).toBeLessThanOrEqual(10);
    }
  });

  it('renders a null "before" (added area) as an em dash', () => {
    const md = mod.renderScorecard(rows(), { barWidth: 10 });
    expect(md).toContain('—');
  });

  it('flags an unverified area with a * marker and a footnote', () => {
    const prev = storeWith([area('perf', 50)]).snapshots.at(-1);
    const curr = mod.addSnapshot({ snapshots: [] }, {
      label: 'v', now: FIXED_NOW,
      areas: [{ name: 'perf', score: 90, evidence: [] }], // unverified
    }).snapshots.at(-1);
    const md = mod.renderScorecard(mod.diffSnapshots(prev, curr), { barWidth: 10 });
    expect(md).toMatch(/perf\s*\*|\*\s*perf|perf\*/); // name carries a * marker
    expect(md).toContain('*'); // footnote marker present
  });
});

describe('loadScorecard / saveScorecard — persistence', () => {
  let projectRoot;
  beforeEach(() => { projectRoot = mkdtempSync(join(tmpdir(), 'scorecard-')); });
  afterEach(() => { rmSync(projectRoot, { recursive: true, force: true }); });

  it('load on an absent file yields an empty snapshots store (no throw)', async () => {
    expect(typeof mod.loadScorecard, 'scorecard.js must export loadScorecard').toBe('function');
    const store = await mod.loadScorecard({ projectRoot });
    expect(store).toMatchObject({ snapshots: [] });
  });

  it('save then load round-trips the store intact', async () => {
    expect(typeof mod.saveScorecard, 'scorecard.js must export saveScorecard').toBe('function');
    const store = storeWith([area('perf', 80), area('security', 90)], 'round');
    await mod.saveScorecard({ projectRoot }, store);
    const loaded = await mod.loadScorecard({ projectRoot });
    expect(loaded.snapshots).toHaveLength(store.snapshots.length);
    expect(loaded.snapshots.at(-1).areas.map((a) => a.name).sort()).toEqual(['perf', 'security']);
  });

  it('save is atomic — no temp-file residue is left behind', async () => {
    const store = storeWith([area('perf', 80)], 'atomic');
    await mod.saveScorecard({ projectRoot }, store);
    // scan the whole projectRoot tree for any *.tmp* residue
    const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = join(dir, e.name);
      return e.isDirectory() ? walk(p) : [p];
    });
    const all = walk(projectRoot);
    expect(all.some((f) => /\.tmp/.test(f)), `temp residue: ${all.join(', ')}`).toBe(false);
    // the persisted scorecard file is complete, valid JSON
    const jsonFiles = all.filter((f) => f.endsWith('.json'));
    expect(jsonFiles.length).toBeGreaterThanOrEqual(1);
    for (const f of jsonFiles) expect(() => JSON.parse(readFileSync(f, 'utf8'))).not.toThrow();
  });
});

describe('CLI diff — last-2 auto-select (the structural fix for the id-sort bug)', () => {
  let projectRoot;
  beforeEach(() => { projectRoot = mkdtempSync(join(tmpdir(), 'scorecard-cli-')); });
  afterEach(() => { rmSync(projectRoot, { recursive: true, force: true }); });

  const payload = (label, name, score) =>
    JSON.stringify({ label, areas: [{ name, score, evidence: [{ file: 'a.js:1', note: 'n' }] }] });

  it('degrades gracefully when fewer than 2 snapshots exist', () => {
    const zero = runCli(['diff'], { cwd: projectRoot });
    expect(zero.status).toBe(0);
    expect(zero.stdout).toMatch(/2개|2 개|필요/); // Korean "needs 2 snapshots" notice

    runCli(['add'], { cwd: projectRoot, stdin: payload('before', 'perf', 50) });
    const one = runCli(['diff'], { cwd: projectRoot });
    expect(one.status).toBe(0);
    expect(one.stdout).toMatch(/1개|필요/);
  });

  it('diffs the last two snapshots by insertion order (time order), label order irrelevant', () => {
    // Insert an alphabetically-LATER label first, then an EARLIER one, to prove the
    // old lexical-id-sort bug cannot recur: selection is by array position, not name.
    runCli(['add'], { cwd: projectRoot, stdin: payload('zzz-before', 'perf', 20) });
    runCli(['add'], { cwd: projectRoot, stdin: payload('aaa-after', 'perf', 80) });
    const diff = runCli(['diff'], { cwd: projectRoot });
    expect(diff.status).toBe(0);
    // before=20 (first inserted), after=80 (last inserted) -> +60, NOT reversed.
    expect(diff.stdout).toContain('20');
    expect(diff.stdout).toContain('80');
    expect(diff.stdout).toMatch(/▲\s*\+60/);
  });
});

// ── NEON THEMED renderer (renderScorecardTty + loadThemePalette) ─────────────

const ESC = String.fromCharCode(27); // \x1b — built at runtime to keep regexes control-char-free
const ANSI_SGR = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');
const ANSI_TRUECOLOR = new RegExp(`${ESC}\\[38;2;`);

/** Strip ANSI SGR sequences so we can measure visible column layout. */
function stripAnsi(s) {
  return String(s).replace(ANSI_SGR, '');
}

/** A SAKURA-ish palette injected directly — no theme file, no I/O. */
const SAKURA_PALETTE = {
  signals: { primary: [255, 183, 197], accent: [168, 216, 160], danger: [255, 122, 154], dim: [90, 46, 66], warn: [255, 217, 160] },
  glyphs: { fill: '❀', empty: '·', sep: '✿✿', spark: '✿' },
};

const rowsFixture = () => mod.diffSnapshots(
  storeWith([area('자막 추출', 50), area('perf', 60)]).snapshots.at(-1),
  storeWith([area('자막 추출', 90), area('신규영역', 40)]).snapshots.at(-1),
);

describe('renderScorecardTty — palette injection + ANSI structure', () => {
  it('emits truecolor ANSI sequences and honors the injected palette glyphs', () => {
    expect(typeof mod.renderScorecardTty, 'scorecard.js must export renderScorecardTty').toBe('function');
    const out = mod.renderScorecardTty(rowsFixture(), { palette: SAKURA_PALETTE, barWidth: 10 });
    // truecolor foreground sequence present
    expect(out).toMatch(ANSI_TRUECOLOR);
    // injected fill/empty glyphs used for the gauge (not the neon-city defaults)
    expect(out).toContain('❀');
    expect(out).toContain('·');
    expect(out).not.toContain('▰'); // neon-city default fill must NOT appear
  });

  it('distinguishes ▲ / ▼ / — deltas', () => {
    const rows = mod.diffSnapshots(
      storeWith([area('up', 10), area('down', 90), area('gone', 50)]).snapshots.at(-1),
      storeWith([area('up', 40), area('down', 30), area('added', 20)]).snapshots.at(-1),
    );
    const plain = stripAnsi(mod.renderScorecardTty(rows, { palette: SAKURA_PALETTE, barWidth: 10 }));
    expect(plain).toMatch(/▲/); // up improved
    expect(plain).toMatch(/▼/); // down regressed
    expect(plain).toContain('—'); // added/removed have no delta
  });

  it('aligns the name column by DISPLAY width so Korean (wide) and ASCII labels line up', () => {
    // The themed renderer pads columns with spaces using display width (CJK = 2 cells),
    // not GFM pipes. Alignment is correct when the score column begins at the same
    // visible offset on every data row despite mixed-width labels.
    const dispWidth = (s) => [...s].reduce((w, ch) => w + (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1), 0);
    const out = mod.renderScorecardTty(rowsFixture(), { palette: SAKURA_PALETTE, barWidth: 10 });
    const dataRows = stripAnsi(out).split('\n').filter((l) => /[0-9]/.test(l) && !l.startsWith('평가'));
    expect(dataRows.length).toBeGreaterThanOrEqual(2);
    // The name column is left-padded to a fixed display width, so the `before` score
    // column begins at a constant visible offset. Measure the leading run (padded name)
    // up to the first score token (a digit or em dash) and assert it is constant.
    const scoreColOffset = (l) => dispWidth(l.match(/^(.*?)(?=[0-9—])/)[1]);
    const offsets = dataRows.map(scoreColOffset);
    expect(new Set(offsets).size, `score column misaligned across rows: ${offsets}`).toBe(1);
    expect(offsets[0]).toBeGreaterThan(0);
  });
});

describe('loadThemePalette — theme-file fallback', () => {
  let home;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'scorecard-home-')); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  const themePath = () => join(home, '.claude', 'artibot', 'runtime', 'current-theme.json');
  const writeTheme = (content) => {
    const p = themePath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  };

  it('reads signals + glyphs from a present theme file', async () => {
    expect(typeof mod.loadThemePalette, 'scorecard.js must export loadThemePalette').toBe('function');
    writeTheme(JSON.stringify({ theme: 'sakura', label: 'SAKURA', signals: SAKURA_PALETTE.signals, glyphs: SAKURA_PALETTE.glyphs }));
    const p = await mod.loadThemePalette({ home });
    expect(p.glyphs.fill).toBe('❀');
    expect(p.signals.primary).toEqual([255, 183, 197]);
  });

  it('falls back to the neon-city palette when the theme file is absent', async () => {
    const p = await mod.loadThemePalette({ home }); // nothing written
    expect(p.glyphs.fill).toBe('▰'); // neon-city default
    expect(p.signals.primary).toEqual([0, 245, 255]);
  });

  it('falls back to neon-city when the theme file is corrupt JSON', async () => {
    writeTheme('{ this is not valid json');
    const p = await mod.loadThemePalette({ home });
    expect(p.glyphs.fill).toBe('▰');
    expect(p.signals.primary).toEqual([0, 245, 255]);
  });
});

describe('CLI isTTY branching — non-TTY pipe yields plain GFM', () => {
  let projectRoot;
  beforeEach(() => { projectRoot = mkdtempSync(join(tmpdir(), 'scorecard-tty-')); });
  afterEach(() => { rmSync(projectRoot, { recursive: true, force: true }); });

  const payload = (label, name, score) =>
    JSON.stringify({ label, areas: [{ name, score, evidence: [{ file: 'a.js:1', note: 'n' }] }] });

  it('a piped (non-TTY) `diff` prints the GFM table without ANSI color', () => {
    runCli(['add'], { cwd: projectRoot, stdin: payload('before', 'perf', 50) });
    runCli(['add'], { cwd: projectRoot, stdin: payload('after', 'perf', 80) });
    const diff = runCli(['diff'], { cwd: projectRoot }); // spawnSync pipes -> stdout not a TTY
    expect(diff.status).toBe(0);
    expect(diff.stdout).toContain('| 평가 항목 | 작업 전 | 작업 후 | 상승폭 | 남은 갭 |');
    expect(diff.stdout).not.toMatch(ANSI_TRUECOLOR); // no truecolor when piped
  });
});
