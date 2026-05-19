/**
 * Tests for scripts/backfill-grpo-categories.js (Stage C #1).
 *
 * Filesystem is injected for both the script (input/output JSON) and the
 * underlying failure-categorizer (patterns dictionary), so no real disk I/O
 * occurs.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';

import {
  aggregateCategories,
  bucketsToWeights,
  formatReport,
  isFailureRecord,
  mergeCategoryWeights,
  parseArgs,
  runBackfill,
  toFailureContext,
} from '../../scripts/backfill-grpo-categories.js';
import { _resetCache } from '../../lib/learning/failure-categorizer.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PATTERNS_DICT = {
  schemaVersion: 1,
  categories: [
    {
      id: 'ci-exit-mask',
      label: 'CI exit code masking',
      domain: 'ci',
      severity: 'high',
      signals: [
        { type: 'regex', pattern: 'vitest[\\s\\S]{0,40}reporter[\\s\\S]{0,40}(exit|process\\.exit)', scope: 'stdout' },
        { type: 'regex', pattern: 'reporter\\s+exit\\s+0[\\s\\S]{0,80}FAIL', scope: 'stderr' },
      ],
      weight: 1.0,
    },
    {
      id: 'libuv-handle-closing',
      label: 'libuv UV_HANDLE_CLOSING',
      domain: 'runtime',
      severity: 'high',
      signals: [
        { type: 'regex', pattern: 'UV_HANDLE_CLOSING', scope: 'stderr' },
      ],
      weight: 1.0,
    },
  ],
};

// ---------------------------------------------------------------------------
// In-memory fs stubs
// ---------------------------------------------------------------------------

/**
 * Build a fs/promises stub backed by an in-memory map. Supports
 *   - readFile(path, encoding)
 *   - writeFile(path, data, encoding)
 *   - stat(path) (returns synthetic mtimeMs)
 * Throws ENOENT-shaped errors for missing paths.
 */
function makeMemFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  let mtimeCounter = 1000;
  function bumpMtime() { mtimeCounter += 1; return mtimeCounter; }
  const mtimes = new Map();
  for (const k of files.keys()) mtimes.set(k, bumpMtime());

  return {
    files,
    mtimes,
    async readFile(p) {
      if (!files.has(p)) {
        const err = new Error(`ENOENT: ${p}`);
        err.code = 'ENOENT';
        throw err;
      }
      return files.get(p);
    },
    async writeFile(p, data) {
      files.set(p, String(data));
      mtimes.set(p, bumpMtime());
    },
    async stat(p) {
      if (!files.has(p)) {
        const err = new Error(`ENOENT: ${p}`);
        err.code = 'ENOENT';
        throw err;
      }
      return { mtimeMs: mtimes.get(p) };
    },
  };
}

/** Build a categorizer fs stub that serves the dictionary under any cwd. */
function makePatternsFs(dict, { cwd = '/repo' } = {}) {
  // path.join produces platform-native separators (backslashes on Windows);
  // mirror that so the categorizer's lookup key matches the in-memory store.
  const key = path.join(cwd, '.artibot/failure-patterns.json');
  const memFs = makeMemFs({ [key]: JSON.stringify(dict) });
  return memFs;
}

beforeEach(() => _resetCache());

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

describe('parseArgs', () => {
  it('defaults to dry-run mode', () => {
    expect(parseArgs([]).mode).toBe('dry-run');
  });

  it('selects apply mode with --apply', () => {
    expect(parseArgs(['--apply']).mode).toBe('apply');
  });

  it('parses --input / --output / --limit', () => {
    const args = parseArgs(['--input', '/in.json', '--output', '/out.json', '--limit', '25']);
    expect(args.input).toBe('/in.json');
    expect(args.output).toBe('/out.json');
    expect(args.limit).toBe(25);
  });

  it('throws on unknown flag', () => {
    expect(() => parseArgs(['--what'])).toThrow(/unknown flag/);
  });

  it('throws on negative --limit', () => {
    expect(() => parseArgs(['--limit', '-1'])).toThrow(/non-negative/);
  });
});

// ---------------------------------------------------------------------------
// isFailureRecord — filter logic
// ---------------------------------------------------------------------------

describe('isFailureRecord', () => {
  it('treats type=tool with score < 0.5 as failure', () => {
    expect(isFailureRecord({ type: 'tool', data: { score: 0.2 } })).toBe(true);
  });

  it('rejects type=tool with score >= 0.5', () => {
    expect(isFailureRecord({ type: 'tool', data: { score: 0.9 } })).toBe(false);
  });

  it('treats type=error as failure regardless of data', () => {
    expect(isFailureRecord({ type: 'error', data: {} })).toBe(true);
  });

  it('treats records with data.errorMessage as failure', () => {
    expect(isFailureRecord({ type: 'tool', data: { errorMessage: 'boom' } })).toBe(true);
  });

  it('treats records with data.stderr as failure', () => {
    expect(isFailureRecord({ type: 'tool', data: { stderr: 'crash' } })).toBe(true);
  });

  it('returns false for non-objects, missing data, or unrelated types', () => {
    expect(isFailureRecord(null)).toBe(false);
    expect(isFailureRecord({ type: 'agent' })).toBe(false);
    expect(isFailureRecord({ type: 'tool' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// toFailureContext
// ---------------------------------------------------------------------------

describe('toFailureContext', () => {
  it('maps stderr/stdout/diff/files directly when present', () => {
    const ctx = toFailureContext({
      data: {
        stderr: 'err',
        stdout: 'out',
        diff: 'd',
        files: ['a.js'],
      },
    });
    expect(ctx).toEqual({ stderr: 'err', stdout: 'out', diff: 'd', files: ['a.js'] });
  });

  it('falls back to errorMessage when stderr missing', () => {
    const ctx = toFailureContext({ data: { errorMessage: 'msg' } });
    expect(ctx.stderr).toBe('msg');
  });

  it('returns null for records without data block', () => {
    expect(toFailureContext({ id: 'x' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// aggregateCategories + bucketsToWeights
// ---------------------------------------------------------------------------

describe('aggregateCategories', () => {
  it('groups top category and tracks samples + avgConfidence', () => {
    const entries = [
      { record: { id: 'r1' }, categories: [{ categoryId: 'A', confidence: 0.8 }] },
      { record: { id: 'r2' }, categories: [{ categoryId: 'A', confidence: 0.4 }] },
      { record: { id: 'r3' }, categories: [{ categoryId: 'B', confidence: 0.9 }] },
      { record: { id: 'r4' }, categories: [] },
    ];
    const buckets = aggregateCategories(entries);
    expect(buckets.A.count).toBe(2);
    expect(buckets.A.avgConfidence).toBeCloseTo(0.6, 3);
    expect(buckets.A.sampleRecordIds).toEqual(['r1', 'r2']);
    expect(buckets.B.count).toBe(1);
    expect(buckets.__unmatched__.count).toBe(1);
  });

  it('caps sample list to 3 ids', () => {
    const entries = Array.from({ length: 6 }, (_, i) => ({
      record: { id: `r${i}` },
      categories: [{ categoryId: 'A', confidence: 0.5 }],
    }));
    const buckets = aggregateCategories(entries);
    expect(buckets.A.sampleRecordIds).toHaveLength(3);
  });
});

describe('bucketsToWeights', () => {
  it('drops unmatched bucket and scales weights by avgConfidence * count', () => {
    const buckets = {
      A: { count: 4, avgConfidence: 0.5, confidenceSum: 2, sampleRecordIds: [] },
      __unmatched__: { count: 10, avgConfidence: 0, confidenceSum: 0, sampleRecordIds: [] },
    };
    const w = bucketsToWeights(buckets);
    expect(w.A).toBeCloseTo(2.0, 3);
    expect(w.__unmatched__).toBeUndefined();
  });

  it('caps the multiplier component at 100', () => {
    const buckets = {
      A: { count: 500, avgConfidence: 1.0, confidenceSum: 500, sampleRecordIds: [] },
    };
    expect(bucketsToWeights(buckets).A).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// mergeCategoryWeights
// ---------------------------------------------------------------------------

describe('mergeCategoryWeights', () => {
  it('does not touch existing top-level keys other than categoryWeights', () => {
    const existing = {
      rounds: [{ id: 'r1' }],
      weights: { fix: 1.0 },
      teamWeights: { alpha: 0.5 },
    };
    const merged = mergeCategoryWeights(existing, { A: 0.7 });
    expect(merged.rounds).toBe(existing.rounds);
    expect(merged.weights).toBe(existing.weights);
    expect(merged.teamWeights).toBe(existing.teamWeights);
    expect(merged.categoryWeights).toEqual({ A: 0.7 });
  });

  it('averages prior and new weight when both present', () => {
    const merged = mergeCategoryWeights(
      { categoryWeights: { A: 0.4 } },
      { A: 0.8 },
    );
    expect(merged.categoryWeights.A).toBeCloseTo(0.6, 3);
  });

  it('keeps prior keys not in the new weight map', () => {
    const merged = mergeCategoryWeights(
      { categoryWeights: { A: 0.4, B: 0.9 } },
      { A: 0.6 },
    );
    expect(merged.categoryWeights.B).toBe(0.9);
  });
});

// ---------------------------------------------------------------------------
// runBackfill — end-to-end with injected fs
// ---------------------------------------------------------------------------

describe('runBackfill', () => {
  const INPUT = '/exp/daily.json';
  const OUTPUT = '/exp/grpo-history.json';
  const PATTERNS_CWD = '/repo';

  function makeRecords() {
    return [
      // Failure with libuv-handle-closing stderr
      {
        id: 'rec-1',
        type: 'tool',
        category: 'Bash',
        data: { score: 0.1, stderr: 'UV_HANDLE_CLOSING crash' },
      },
      // Failure with ci-exit-mask stdout signal
      {
        id: 'rec-2',
        type: 'tool',
        category: 'Test',
        data: { score: 0.2, stdout: 'vitest custom reporter process.exit 0 with FAIL' },
      },
      // type=error with no matching signals → unmatched bucket
      {
        id: 'rec-3',
        type: 'error',
        data: { errorMessage: 'something went wrong but nothing categorizable' },
      },
      // Healthy tool record → ignored
      { id: 'rec-4', type: 'tool', data: { score: 0.9 } },
      // Agent record → ignored
      { id: 'rec-5', type: 'agent', data: {} },
    ];
  }

  it('dry-run produces a report and writes NOTHING', async () => {
    const fs = makeMemFs({ [INPUT]: JSON.stringify(makeRecords()) });
    const patternsFs = makePatternsFs(PATTERNS_DICT, { cwd: PATTERNS_CWD });
    const beforeKeys = new Set(fs.files.keys());

    const result = await runBackfill({
      mode: 'dry-run',
      input: INPUT,
      output: OUTPUT,
      fs,
      patternsFs,
      patternsCwd: PATTERNS_CWD,
    });

    expect(new Set(fs.files.keys())).toEqual(beforeKeys);
    expect(fs.files.has(OUTPUT)).toBe(false);
    expect(result.summary.scanned).toBe(5);
    expect(result.summary.failed).toBe(3);
    expect(result.summary.categorized).toBe(2);
    expect(result.summary.unmatched).toBe(1);
    expect(Object.keys(result.summary.buckets)).toContain('libuv-handle-closing');
    expect(Object.keys(result.summary.buckets)).toContain('ci-exit-mask');
    expect(result.report).toContain('[DRY RUN] no files written');
    expect(result.backup).toBeNull();
  });

  it('apply mode merges categoryWeights and creates a backup of the existing output', async () => {
    const existing = {
      rounds: [{ id: 'old-round' }],
      weights: { fix: 1.0 },
      teamWeights: { alpha: 0.5 },
      categoryWeights: { libuv: 0.3 },
    };
    const fs = makeMemFs({
      [INPUT]: JSON.stringify(makeRecords()),
      [OUTPUT]: JSON.stringify(existing),
    });
    const patternsFs = makePatternsFs(PATTERNS_DICT, { cwd: PATTERNS_CWD });

    const result = await runBackfill({
      mode: 'apply',
      input: INPUT,
      output: OUTPUT,
      fs,
      patternsFs,
      patternsCwd: PATTERNS_CWD,
      now: () => Date.UTC(2026, 4, 19, 12, 0, 0),
    });

    expect(result.backup).not.toBeNull();
    expect(fs.files.has(result.backup)).toBe(true);
    expect(fs.files.get(result.backup)).toBe(JSON.stringify(existing));

    const written = JSON.parse(fs.files.get(OUTPUT));
    // Existing top-level keys preserved
    expect(written.rounds).toEqual(existing.rounds);
    expect(written.weights).toEqual(existing.weights);
    expect(written.teamWeights).toEqual(existing.teamWeights);
    // categoryWeights has new keys
    expect(written.categoryWeights['libuv-handle-closing']).toBeGreaterThan(0);
    expect(written.categoryWeights['ci-exit-mask']).toBeGreaterThan(0);
    // Prior key untouched (not in newWeights)
    expect(written.categoryWeights.libuv).toBe(0.3);
    expect(result.report).toContain(`Wrote ${OUTPUT}`);
    expect(result.report).toContain('backup:');
  });

  it('apply mode writes a fresh grpo-history.json when the output does not yet exist', async () => {
    const fs = makeMemFs({ [INPUT]: JSON.stringify(makeRecords()) });
    const patternsFs = makePatternsFs(PATTERNS_DICT, { cwd: PATTERNS_CWD });

    const result = await runBackfill({
      mode: 'apply',
      input: INPUT,
      output: OUTPUT,
      fs,
      patternsFs,
      patternsCwd: PATTERNS_CWD,
    });

    expect(fs.files.has(OUTPUT)).toBe(true);
    expect(result.backup).toBeNull();
    const written = JSON.parse(fs.files.get(OUTPUT));
    expect(written.rounds).toEqual([]);
    expect(written.weights).toEqual({});
    expect(written.categoryWeights).toBeTypeOf('object');
  });

  it('empty input yields zero counts and no writes (dry-run)', async () => {
    const fs = makeMemFs({ [INPUT]: '[]' });
    const patternsFs = makePatternsFs(PATTERNS_DICT, { cwd: PATTERNS_CWD });
    const result = await runBackfill({
      mode: 'dry-run',
      input: INPUT,
      output: OUTPUT,
      fs,
      patternsFs,
      patternsCwd: PATTERNS_CWD,
    });
    expect(result.summary.scanned).toBe(0);
    expect(result.summary.failed).toBe(0);
    expect(fs.files.has(OUTPUT)).toBe(false);
  });

  it('malformed records are skipped and counted in reportError', async () => {
    const records = [
      // Non-object entry
      'not-a-record',
      // Numeric entry
      42,
      // Missing data block but type=error
      { id: 'rec-err', type: 'error' },
    ];
    const fs = makeMemFs({ [INPUT]: JSON.stringify(records) });
    const patternsFs = makePatternsFs(PATTERNS_DICT, { cwd: PATTERNS_CWD });
    const result = await runBackfill({
      mode: 'dry-run',
      input: INPUT,
      output: OUTPUT,
      fs,
      patternsFs,
      patternsCwd: PATTERNS_CWD,
    });
    expect(result.summary.scanned).toBe(3);
    // Two strings/numbers fail the filter (not counted as failures, just ignored).
    // The third (type=error, no data) qualifies as failure but yields toFailureContext=null → reportError.
    expect(result.summary.reportError).toBeGreaterThanOrEqual(1);
  });

  it('missing input file throws ENOENT-like error', async () => {
    const fs = makeMemFs({});
    const patternsFs = makePatternsFs(PATTERNS_DICT, { cwd: PATTERNS_CWD });
    await expect(
      runBackfill({ mode: 'dry-run', input: INPUT, output: OUTPUT, fs, patternsFs, patternsCwd: PATTERNS_CWD }),
    ).rejects.toThrow(/input not found/);
  });

  it('non-array input throws a clear error', async () => {
    const fs = makeMemFs({ [INPUT]: JSON.stringify({ records: [] }) });
    const patternsFs = makePatternsFs(PATTERNS_DICT, { cwd: PATTERNS_CWD });
    await expect(
      runBackfill({ mode: 'dry-run', input: INPUT, output: OUTPUT, fs, patternsFs, patternsCwd: PATTERNS_CWD }),
    ).rejects.toThrow(/not an array/);
  });

  it('--limit truncates the records processed', async () => {
    const fs = makeMemFs({ [INPUT]: JSON.stringify(makeRecords()) });
    const patternsFs = makePatternsFs(PATTERNS_DICT, { cwd: PATTERNS_CWD });
    const result = await runBackfill({
      mode: 'dry-run',
      input: INPUT,
      output: OUTPUT,
      limit: 2,
      fs,
      patternsFs,
      patternsCwd: PATTERNS_CWD,
    });
    expect(result.summary.scanned).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// formatReport
// ---------------------------------------------------------------------------

describe('formatReport', () => {
  const baseSummary = {
    scanned: 10,
    failed: 5,
    categorized: 4,
    unmatched: 1,
    reportError: 0,
    buckets: {
      'ci-exit-mask': { count: 3, avgConfidence: 0.78, sampleRecordIds: ['r1', 'r2'] },
      'libuv-handle-closing': { count: 1, avgConfidence: 0.5, sampleRecordIds: ['r3'] },
    },
  };

  it('reports dry-run footer', () => {
    const out = formatReport(baseSummary, { mode: 'dry-run', output: '/o.json', backup: null });
    expect(out).toContain('[DRY RUN] no files written');
    expect(out).toContain('ci-exit-mask');
    expect(out).toContain('count=   3');
  });

  it('reports apply footer with output + backup paths', () => {
    const out = formatReport(baseSummary, { mode: 'apply', output: '/o.json', backup: '/o.json.bak-X' });
    expect(out).toContain('Wrote /o.json (backup: /o.json.bak-X)');
  });
});
