/**
 * `lib/context/rehydration` — pure bundle builder (vNext PR-CX01).
 *
 * Covers: identity gate (wrong branch/worktree refused, unknown refused),
 * byte budget with priority truncation/dropping, determinism, and the
 * "truncated is visible" rule. Sizes here are real (multi-KB fixtures), not
 * a few hundred bytes — the 16KB-cap lesson from rules §9.
 *
 * Not covered: whether the harness shows `systemMessage` at all (that is the
 * hook's contract, not this module's).
 */

import { describe, expect, it } from 'vitest';

import {
  buildRehydrationBundle,
  byteLength,
  compareIdentity,
  DEFAULT_MAX_BYTES,
  SECTION_CAPS,
  SECTION_ORDER,
  truncateToBytes,
} from '../../lib/context/rehydration.js';

const CWD = 'C:/Users/x/Desktop/Repo/.claude/worktrees/split-repo-a';

/**
 * @param {object} [over]
 * @returns {object}
 */
function snapshot(over = {}) {
  return {
    savedAt: '2026-09-02T01:00:00.000Z',
    reason: 'pre-compact',
    summary: {
      scope: { user: 3, assistant: 3, tool: 5 },
      tools_mentioned: ['Read', 'Edit'],
      recent_requests: ['first', 'implement rehydrate'],
      pending_work: ['TODO: write tests', 'next: wire hook'],
      key_files: ['lib/context/rehydration.js', 'scripts/hooks/post-compact-rehydrate.js'],
      current_work: 'Building the rehydration bundle',
      decisions: ['decided: systemMessage is the only PostCompact channel'],
    },
    gitState: { cwd: CWD, branch: 'worktree-split-repo-a', head: 'abc123def456', hasStatus: true },
    stateFilePath: 'C:/x/runtime/state/pre-compact-x.md',
    ...over,
  };
}

const CURRENT = { cwd: CWD, branch: 'worktree-split-repo-a', head: 'abc123def456' };

describe('helpers', () => {
  it('truncateToBytes never splits a code point and reports bytes cut', () => {
    const s = '한글abc한글'; // (3+3) + 3 + (3+3) = 15 bytes
    expect(byteLength(s)).toBe(15);
    expect(truncateToBytes(s, 15)).toEqual({ text: s, cut: 0 });
    expect(truncateToBytes(s, 7)).toEqual({ text: '한글a', cut: 8 }); // exact code-point boundary
    const r = truncateToBytes(s, 5); // cuts inside 글
    expect(r.text).toBe('한');
    expect(byteLength(r.text) + r.cut).toBe(15);
    expect(truncateToBytes(s, 0)).toEqual({ text: '', cut: 15 });
    expect(truncateToBytes(null, 5)).toEqual({ text: '', cut: 0 });
  });
});

describe('compareIdentity', () => {
  it('ok when cwd and branch match; head drift is informational', () => {
    const id = compareIdentity(snapshot().gitState, { ...CURRENT, head: 'ffff00001111' });
    expect(id.ok).toBe(true);
    expect(id.headMatch).toBe(false);
    expect(id.reasons).toEqual([]);
  });

  it('path comparison tolerates separators and, when told, case', () => {
    const win = compareIdentity({ cwd: 'C:\\Users\\X\\Repo\\', branch: 'b' }, { cwd: 'c:/users/x/repo', branch: 'b' }, { caseInsensitivePaths: true });
    expect(win.cwdMatch).toBe(true);
    const posix = compareIdentity({ cwd: '/home/X/repo', branch: 'b' }, { cwd: '/home/x/repo', branch: 'b' }, { caseInsensitivePaths: false });
    expect(posix.cwdMatch).toBe(false);
  });

  it('refuses on branch mismatch, cwd mismatch, and unknown identity (fail-closed)', () => {
    expect(compareIdentity(snapshot().gitState, { ...CURRENT, branch: 'master' }).ok).toBe(false);
    expect(compareIdentity(snapshot().gitState, { ...CURRENT, cwd: 'C:/elsewhere' }).ok).toBe(false);
    expect(compareIdentity(undefined, CURRENT).ok).toBe(false);
    expect(compareIdentity(snapshot().gitState, { cwd: CWD, branch: null }).reasons).toContain('branch unknown on one side');
    expect(compareIdentity({ cwd: CWD, branch: 'unknown' }, CURRENT).branchMatch).toBe(null);
  });
});

describe('buildRehydrationBundle — content', () => {
  it('includes every section in priority order when everything fits, deterministically', () => {
    const input = {
      snapshot: snapshot(),
      current: CURRENT,
      compactSummary: 'Harness summary.',
      handoff: { path: 'C:/x/.artibot/HANDOFF.md', content: '# HANDOFF\n다음 단계: tests', mtime: 1 },
      split: { runJson: { runId: 'split-t1', stage: 'dispatched', limbs: ['a', 'b'] }, briefs: [{ limb: 'a', path: 'C:/w/.artibot/split/a/brief.md', text: '# brief a\n소유: src/a/\n완료: trailer' }] },
      paths: { bundlePath: 'C:/h/.claude/artibot/post-compact/x.md', snapshotPath: 'C:/h/.claude/artibot-pre-compact.json', stateFilePath: 'C:/x/state.md' },
    };
    const a = buildRehydrationBundle(input);
    const b = buildRehydrationBundle(input);
    expect(a).toEqual(b);
    expect(a.text).toBe(b.text);
    expect(a.bytes).toBe(byteLength(a.text));
    expect(a.bytes).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
    expect(a.truncated).toBe(false);
    expect(a.identity.ok).toBe(true);
    expect(a.sections.map((s) => s.name)).toEqual([...SECTION_ORDER]);
    expect(a.sections.every((s) => s.status === 'included')).toBe(true);
    for (const needle of [
      'identity: OK',
      'restate the next action in ONE line',
      'current: Building the rehydration bundle',
      '  - TODO: write tests',
      'decided: systemMessage',
      'key files: lib/context/rehydration.js',
      '/split run split-t1 stage=dispatched limbs=a,b',
      '### lane brief a (C:/w/.artibot/split/a/brief.md)',
      '## Latest HANDOFF (C:/x/.artibot/HANDOFF.md)',
      'Harness summary.',
      'bundle: C:/h/.claude/artibot/post-compact/x.md',
      '[rehydrate]',
    ]) expect(a.text, needle).toContain(needle);
    const idx = (s) => a.text.indexOf(s);
    expect(idx('identity: OK')).toBeLessThan(idx('current: Building'));
    expect(idx('current: Building')).toBeLessThan(idx('/split run'));
    expect(idx('/split run')).toBeLessThan(idx('Latest HANDOFF'));
    expect(idx('Latest HANDOFF')).toBeLessThan(idx('Harness summary'));
  });

  it('with no inputs at all still yields identity + resume + footer, under budget, with a warning', () => {
    const r = buildRehydrationBundle({});
    expect(r.identity.ok).toBe(false);
    expect(r.warnings).toContain('no pre-compact snapshot found');
    expect(r.text).toContain('identity: REFUSED');
    expect(r.sections.filter((s) => s.status === 'included').map((s) => s.name)).toEqual(['identity', 'resume']);
    expect(r.bytes).toBeLessThan(1500);
  });

  it('wrong branch → snapshot-work refused, current-tree sections still included, warning says why', () => {
    const r = buildRehydrationBundle({
      snapshot: snapshot(),
      current: { ...CURRENT, branch: 'master' },
      compactSummary: 'S',
      split: { runJson: { runId: 'split-t1' } },
    });
    expect(r.identity.ok).toBe(false);
    expect(r.sections.find((s) => s.name === 'snapshot-work').status).toBe('refused');
    expect(r.sections.find((s) => s.name === 'split-lane').status).toBe('included');
    expect(r.sections.find((s) => s.name === 'compact-summary').status).toBe('included');
    expect(r.text).not.toContain('Building the rehydration bundle');
    expect(r.text).toContain('identity: REFUSED — branch mismatch: snapshot worktree-split-repo-a ≠ current master');
    expect(r.warnings.join(' ')).toContain('snapshot refused');
  });

  it('refused identity never lists the snapshot/state paths, and says not to read them', () => {
    const paths = { bundlePath: 'C:/h/.claude/artibot/post-compact/x.md', snapshotPath: 'C:/h/.claude/artibot-pre-compact.json', stateFilePath: 'C:/x/runtime/state/pre-compact-x.md' };
    const refused = buildRehydrationBundle({ snapshot: snapshot(), current: { ...CURRENT, branch: 'master' }, paths });
    expect(refused.text).not.toContain(paths.snapshotPath);
    expect(refused.text).not.toContain(paths.stateFilePath);
    expect(refused.text).toContain('Do NOT read the pre-compact snapshot/state files');
    expect(refused.text).toContain(`bundle: ${paths.bundlePath}`);
    expect(refused.text).not.toContain('files below');
    const ok = buildRehydrationBundle({ snapshot: snapshot(), current: CURRENT, paths });
    expect(ok.text).toContain(paths.snapshotPath);
    expect(ok.text).toContain(paths.stateFilePath);
  });

  it('wrong worktree (cwd) is refused the same way', () => {
    const r = buildRehydrationBundle({ snapshot: snapshot(), current: { ...CURRENT, cwd: 'C:/Users/x/Desktop/Repo' } });
    expect(r.sections.find((s) => s.name === 'snapshot-work').status).toBe('refused');
    expect(r.text).toContain('cwd mismatch');
  });

  it('per-section caps: brief > 2KB and handoff > 1.5KB are cut with a visible marker before the global budget applies', () => {
    const big = 'x'.repeat(5000);
    const r = buildRehydrationBundle({
      snapshot: snapshot(), current: CURRENT,
      split: { briefs: [{ limb: 'a', text: big }] },
      handoff: { content: big },
      compactSummary: big,
    });
    expect(r.truncated).toBe(false); // caps are not budget truncation
    expect(r.text).toMatch(/\[brief truncated, \d+ bytes omitted — read the file\]/);
    expect(r.text).toMatch(/\[handoff truncated, \d+ bytes omitted — read the file\]/);
    expect(r.text).toMatch(/\[\d+ bytes omitted — full text saved with the bundle\]/);
    const brief = r.sections.find((s) => s.name === 'split-lane');
    expect(brief.bytes).toBeLessThan(SECTION_CAPS.brief + 300);
    expect(r.bytes).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
  });
});

describe('buildRehydrationBundle — budget', () => {
  const heavy = () => ({
    snapshot: snapshot({ summary: { ...snapshot().summary, pending_work: Array.from({ length: 5 }, (_, i) => `pending item ${i} ${'p'.repeat(120)}`) } }),
    current: CURRENT,
    compactSummary: 'c'.repeat(900),
    handoff: { path: 'H', content: 'h'.repeat(1400) },
    split: { runJson: { runId: 'split-t1' }, briefs: [{ limb: 'a', text: 'b'.repeat(1900) }, { limb: 'b', text: 'b'.repeat(1900) }] },
  });

  it('never exceeds maxBytes; lowest-priority sections go first (dropped or truncated with a marker)', () => {
    const full = buildRehydrationBundle(heavy());
    expect(full.truncated).toBe(false);
    expect(full.bytes).toBeGreaterThan(5000);

    for (const max of [6000, 4000, 2500, 1200, 700]) {
      const r = buildRehydrationBundle({ ...heavy(), maxBytes: max });
      expect(r.bytes, `max=${max}`).toBeLessThanOrEqual(max);
      expect(r.truncated).toBe(true);
      expect(r.text).toContain('TRUNCATED');
      // identity always survives; resume survives at any budget a real config would set
      expect(r.sections[0]).toMatchObject({ name: 'identity', status: 'included' });
      if (max >= 1200) expect(r.sections[1]).toMatchObject({ name: 'resume', status: 'included' });
      // whatever was cut is named in the footer
      for (const s of r.sections.filter((x) => x.status === 'truncated' || x.status === 'dropped')) {
        expect(r.text).toContain(`${s.name}(${s.status})`);
      }
    }
  });

  it('priority is monotone: a section dropped at budget B is not included at a smaller budget', () => {
    let prevIncluded = null;
    for (const max of [10240, 6000, 4000, 2500, 1200]) {
      const r = buildRehydrationBundle({ ...heavy(), maxBytes: max });
      const included = new Set(r.sections.filter((s) => s.status === 'included').map((s) => s.name));
      if (prevIncluded) for (const name of included) expect(prevIncluded.has(name), `${name} at ${max}`).toBe(true);
      prevIncluded = included;
    }
  });

  it('a prose section is truncated with a budget marker rather than dropped when there is room', () => {
    const r = buildRehydrationBundle({ ...heavy(), maxBytes: 2600 });
    const shrunk = r.sections.find((s) => s.status === 'truncated');
    expect(shrunk).toBeDefined();
    expect(r.text).toMatch(new RegExp(`\\[${shrunk.name} truncated for budget, \\d+ bytes omitted\\]`));
  });

  it('cap is absolute on the final string: deep paths, refused identity, tiny caps (review finding: 10594B/10240, 621B/200)', () => {
    const deep = 'C:/Users/HeechangLee/Desktop/Very/Deep/Nested/Path/To/A/Project/.claude/worktrees/split-project-some-really-long-limb-name-for-testing-purposes';
    const longBranch = 'worktree-split-project-some-really-long-limb-name-';
    const bigSnap = snapshot({
      summary: { ...snapshot().summary, current_work: 'w'.repeat(3000), pending_work: Array.from({ length: 5 }, (_, i) => `pending ${i} ${'p'.repeat(150)}`), decisions: Array.from({ length: 5 }, (_, i) => `decided ${i} ${'d'.repeat(150)}`) },
      gitState: { cwd: `${deep}-A`, branch: `${longBranch}alpha`, head: 'a'.repeat(12) },
    });
    const heavyRest = {
      split: { runJson: { runId: 'split-t1' }, briefs: [{ limb: 'a', text: 'b'.repeat(2100) }, { limb: 'b', text: 'b'.repeat(2100) }] },
      handoff: { path: `${deep}-B/.artibot/HANDOFF.md`, content: 'h'.repeat(1600) },
      compactSummary: 'c'.repeat(1100),
      paths: { bundlePath: `${deep}-B/bundle.md`, snapshotPath: `${deep}-A/snap.json`, stateFilePath: `${deep}-A/state.md` },
    };
    const cases = [
      ['deep paths, identity ok, 10240', { snapshot: bigSnap, current: { cwd: `${deep}-A`, branch: `${longBranch}alpha`, head: 'b'.repeat(12) }, ...heavyRest }],
      ['deep paths, refused, 10240', { snapshot: bigSnap, current: { cwd: `${deep}-B`, branch: `${longBranch}beta` }, ...heavyRest }],
      ['deep paths, refused, cap 200', { snapshot: bigSnap, current: { cwd: `${deep}-B`, branch: `${longBranch}beta` }, ...heavyRest, maxBytes: 200 }],
      ['no inputs, cap 200', { maxBytes: 200 }],
      ['deep paths, ok, cap 900', { snapshot: bigSnap, current: { cwd: `${deep}-A`, branch: `${longBranch}alpha` }, ...heavyRest, maxBytes: 900 }],
    ];
    for (const [label, input] of cases) {
      const r = buildRehydrationBundle(input);
      expect(Buffer.byteLength(r.text, 'utf8'), label).toBeLessThanOrEqual(r.maxBytes);
      expect(r.bytes, label).toBe(Buffer.byteLength(r.text, 'utf8'));
      if (r.maxBytes <= 900) expect(r.truncated, label).toBe(true);
    }
    const tiny = buildRehydrationBundle(cases[2][1]);
    expect(tiny.text).toMatch(/hard-truncated to cap|\u2026\[cap\]/);
  });

  it('bad maxBytes falls back to the 10KB default', () => {
    expect(buildRehydrationBundle({ maxBytes: -1 }).maxBytes).toBe(DEFAULT_MAX_BYTES);
    expect(buildRehydrationBundle({ maxBytes: '5000' }).maxBytes).toBe(DEFAULT_MAX_BYTES);
  });
});
