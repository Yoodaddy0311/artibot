/**
 * Tests for lib/learning/failure-categorizer.
 *
 * Filesystem is injected — no real I/O. Each test builds a tiny in-memory
 * fs stub satisfying the { stat, readFile } contract used by the module.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _resetCache,
  categorizeAll,
  categorizeFailure,
  loadFailurePatterns,
} from '../../lib/learning/failure-categorizer.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Mirrors the real .artibot/failure-patterns.json shape (trimmed). */
const VALID_DICT = {
  schemaVersion: 1,
  updatedAt: '2026-05-19T00:00:00.000Z',
  categories: [
    {
      id: 'ci-exit-mask',
      label: 'CI exit code masking',
      domain: 'ci',
      severity: 'high',
      signals: [
        {
          type: 'regex',
          pattern: 'reporter\\s+exit\\s+0[\\s\\S]{0,80}FAIL',
          scope: 'stderr',
        },
        {
          type: 'regex',
          pattern: 'vitest[\\s\\S]{0,40}reporter[\\s\\S]{0,40}(exit|process\\.exit)',
          scope: 'stdout',
        },
        { type: 'file', pattern: 'tests/reporters/*-reporter.js' },
      ],
      fixHints: ['hint'],
      examples: ['ex'],
      weight: 1.0,
    },
    {
      id: 'tz-mismatch-mtime',
      label: 'TZ mismatch',
      domain: 'ci',
      severity: 'high',
      signals: [
        {
          type: 'regex',
          pattern:
            'expected\\s+\\d{4}-\\d{2}-\\d{2}[\\s\\S]{0,80}received\\s+\\d{4}-\\d{2}-\\d{2}|off\\s+by\\s+(9|24)\\s*hours?',
          scope: 'stdout',
        },
        { type: 'regex', pattern: 'Asia/Seoul|Etc/UTC|TZ=UTC', scope: 'any' },
      ],
      fixHints: ['hint'],
      examples: ['ex'],
      weight: 1.0,
    },
    {
      id: 'libuv-handle-closing',
      label: 'libuv UV_HANDLE_CLOSING',
      domain: 'runtime',
      severity: 'high',
      signals: [
        {
          type: 'regex',
          pattern: 'UV_HANDLE_CLOSING|Assertion failed:[\\s\\S]{0,80}handle->flags',
          scope: 'stderr',
        },
      ],
      fixHints: ['hint'],
      examples: ['ex'],
      weight: 1.0,
    },
    {
      id: 'manifest-count-drift',
      label: 'Manifest count drift',
      domain: 'release',
      severity: 'medium',
      signals: [
        {
          type: 'regex',
          pattern: '(\\d+)\\s+(agents?|skills?|commands?)[\\s\\S]{0,200}(\\d+)\\s+\\2',
          scope: 'diff',
        },
        { type: 'file', pattern: '.claude-plugin/marketplace.json' },
      ],
      fixHints: ['hint'],
      examples: ['ex'],
      weight: 0.8,
    },
  ],
};

/** Tie-break fixture: two categories with identical single-signal coverage but different weights. */
const TIE_DICT = {
  schemaVersion: 1,
  categories: [
    {
      id: 'low-weight-cat',
      label: 'low',
      domain: 'ci',
      severity: 'high',
      signals: [{ type: 'regex', pattern: 'TIE_SIGNAL', scope: 'stderr' }],
      weight: 0.5,
    },
    {
      id: 'high-weight-cat',
      label: 'high',
      domain: 'ci',
      severity: 'low',
      signals: [{ type: 'regex', pattern: 'TIE_SIGNAL', scope: 'stderr' }],
      weight: 1.5,
    },
  ],
};

// ---------------------------------------------------------------------------
// Stub fs (injectable for the module)
// ---------------------------------------------------------------------------

/**
 * Build a minimal fs/promises stub satisfying { stat, readFile }.
 * `mtimeMs` is bumped on every `setContent` to simulate file edits.
 */
function makeFs(initialContent, initialMtime = 1000) {
  let content = initialContent;
  let mtimeMs = initialMtime;
  return {
    setContent(next, nextMtime) {
      content = next;
      mtimeMs = nextMtime ?? mtimeMs + 1;
    },
    async stat() {
      if (content === null) {
        const err = new Error('ENOENT');
        err.code = 'ENOENT';
        throw err;
      }
      return { mtimeMs };
    },
    async readFile() {
      if (content === null) {
        const err = new Error('ENOENT');
        err.code = 'ENOENT';
        throw err;
      }
      return content;
    },
  };
}

function dictFs(dict) {
  return makeFs(JSON.stringify(dict));
}

const CWD = '/repo';

beforeEach(() => _resetCache());
afterEach(() => _resetCache());

// ---------------------------------------------------------------------------
// loadFailurePatterns
// ---------------------------------------------------------------------------

describe('loadFailurePatterns', () => {
  it('loads a valid patterns file and caches by mtime', async () => {
    const fs = dictFs(VALID_DICT);
    let statCount = 0;
    let readCount = 0;
    const wrapped = {
      stat: (...a) => {
        statCount++;
        return fs.stat(...a);
      },
      readFile: (...a) => {
        readCount++;
        return fs.readFile(...a);
      },
    };

    const a = await loadFailurePatterns({ cwd: CWD, fs: wrapped });
    const b = await loadFailurePatterns({ cwd: CWD, fs: wrapped });

    expect(a.schemaVersion).toBe(1);
    expect(a.categories).toHaveLength(4);
    expect(a).toBe(b); // cache hit returns identical reference
    expect(statCount).toBe(2); // stat always runs to verify mtime
    expect(readCount).toBe(1); // readFile skipped on cache hit
  });

  it('throws on missing file', async () => {
    const fs = makeFs(null);
    await expect(loadFailurePatterns({ cwd: CWD, fs })).rejects.toThrow(/ENOENT|cannot stat/);
  });

  it('throws on malformed JSON', async () => {
    const fs = makeFs('{ not valid json');
    await expect(loadFailurePatterns({ cwd: CWD, fs })).rejects.toThrow(/malformed JSON/);
  });

  it('reloads when mtime changes', async () => {
    const fs = dictFs(VALID_DICT);
    const a = await loadFailurePatterns({ cwd: CWD, fs });
    fs.setContent(JSON.stringify({ ...VALID_DICT, schemaVersion: 2 }), 2000);
    const b = await loadFailurePatterns({ cwd: CWD, fs });
    expect(a).not.toBe(b);
    expect(b.schemaVersion).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// categorizeFailure
// ---------------------------------------------------------------------------

describe('categorizeFailure', () => {
  it('categorizes ci-exit-mask from stderr containing "vitest reporter exit 0 FAIL"', async () => {
    const fs = dictFs(VALID_DICT);
    const result = await categorizeFailure(
      {
        stderr: 'vitest custom reporter exit 0 — but 12 FAIL cases reported',
        stdout: '',
        files: ['tests/reporters/test-status-reporter.js'],
      },
      { cwd: CWD, fs },
    );
    expect(result).not.toBeNull();
    expect(result.categoryId).toBe('ci-exit-mask');
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.matchedSignals.length).toBeGreaterThanOrEqual(1);
  });

  it('categorizes tz-mismatch-mtime from "expected 2026-05-19 received 2026-05-18 off by 9 hours"', async () => {
    const fs = dictFs(VALID_DICT);
    const result = await categorizeFailure(
      {
        stdout:
          'AssertionError: expected 2026-05-19 received 2026-05-18 — off by 9 hours; TZ=UTC mismatch',
      },
      { cwd: CWD, fs },
    );
    expect(result).not.toBeNull();
    expect(result.categoryId).toBe('tz-mismatch-mtime');
  });

  it('categorizes libuv-handle-closing from "UV_HANDLE_CLOSING Assertion failed"', async () => {
    const fs = dictFs(VALID_DICT);
    const result = await categorizeFailure(
      {
        stderr: 'UV_HANDLE_CLOSING — Assertion failed: handle->flags & UV_CLOSING',
      },
      { cwd: CWD, fs },
    );
    expect(result).not.toBeNull();
    expect(result.categoryId).toBe('libuv-handle-closing');
  });

  it('categorizes manifest-count-drift from diff containing "27 agents" vs "28 agents"', async () => {
    const fs = dictFs(VALID_DICT);
    const result = await categorizeFailure(
      {
        diff: '- README.md says 27 agents\n+ marketplace.json reports 28 agents shipped',
        files: ['.claude-plugin/marketplace.json'],
      },
      { cwd: CWD, fs },
    );
    expect(result).not.toBeNull();
    expect(result.categoryId).toBe('manifest-count-drift');
  });

  it('returns null when no signals match', async () => {
    const fs = dictFs(VALID_DICT);
    const result = await categorizeFailure(
      {
        stderr: 'completely unrelated message about a network timeout',
        stdout: 'nothing to see here',
      },
      { cwd: CWD, fs },
    );
    expect(result).toBeNull();
  });

  it('tie-breaks by category weight when confidences are equal', async () => {
    const fs = dictFs(TIE_DICT);
    const result = await categorizeFailure(
      { stderr: 'oh no a TIE_SIGNAL appeared' },
      { cwd: CWD, fs },
    );
    expect(result).not.toBeNull();
    // Both categories match the single shared signal → confidence=1 for both.
    // Weight 1.5 (high-weight-cat) must beat weight 0.5 (low-weight-cat).
    expect(result.categoryId).toBe('high-weight-cat');
    expect(result.confidence).toBe(1);
  });

  it('categorizeAll returns sorted descending list above the floor', async () => {
    const fs = dictFs(TIE_DICT);
    const all = await categorizeAll({ stderr: 'TIE_SIGNAL again' }, { cwd: CWD, fs });
    expect(all).toHaveLength(2);
    expect(all[0].categoryId).toBe('high-weight-cat');
    expect(all[1].categoryId).toBe('low-weight-cat');
    expect(all[0].confidence).toBeGreaterThanOrEqual(all[1].confidence);
  });
});
