/**
 * Unit tests for lib/autopilot/memory.js
 * Covers extractKey, normalizeLesson, appendLesson, tokenize, jaccard,
 * recallLessons, compactFeature, and concurrent/malformed-line behavior.
 *
 * Korean-path safe; uses unique feature keys per test for filesystem isolation.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { appendFileSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import {
  appendLesson,
  compactFeature,
  extractKey,
  getFeaturePath,
  getMemoryDir,
  jaccard,
  normalizeLesson,
  recallLessons,
  scoreLesson,
  tokenize,
} from '../../lib/autopilot/memory.js';

const createdKeys = [];

function uniqueKey(label) {
  const k = `memtest-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  createdKeys.push(k);
  return k;
}

afterEach(() => {
  const dir = getMemoryDir();
  if (!existsSync(dir)) {
    createdKeys.length = 0;
    return;
  }
  let files = [];
  try { files = readdirSync(dir); } catch { /* missing dir is fine */ }
  while (createdKeys.length) {
    const key = createdKeys.pop();
    for (const f of files) {
      if (f.startsWith(`${key}.`) || f === `${key}.jsonl`) {
        try { unlinkSync(path.join(dir, f)); } catch { /* ignore */ }
      }
    }
  }
});

describe('extractKey', () => {
  it('slugifies Korean+English title with hyphenated whitespace', () => {
    const key = extractKey('Autopilot Memory 구현');
    expect(key).toMatch(/autopilot-memory-구현/);
    expect(key.includes(' ')).toBe(false);
  });

  it('strips non-word symbols like !@#', () => {
    const key = extractKey('!!!special@@@chars###');
    expect(key).toBe('specialchars');
  });

  it('caps length at 64 chars', () => {
    const key = extractKey('a'.repeat(200));
    expect(key.length).toBeLessThanOrEqual(64);
    expect(key.length).toBeGreaterThan(0);
  });

  it('returns "untitled" fallback for empty/symbol-only input', () => {
    expect(extractKey('!!!')).toBe('untitled');
    expect(extractKey('')).toBe('untitled');
  });
});

describe('normalizeLesson', () => {
  it('fills missing ts and taskHash with defaults', () => {
    const out = normalizeLesson({ lesson: 'hello' });
    expect(typeof out.ts).toBe('string');
    expect(out.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(typeof out.taskHash).toBe('string');
    expect(out.taskHash.length).toBe(12);
    expect(out.lesson).toBe('hello');
    expect(out.sessionId).toBeNull();
  });

  it('truncates lesson body over 240 chars', () => {
    const big = 'x'.repeat(500);
    const out = normalizeLesson({ lesson: big });
    expect(out.lesson.length).toBe(240);
  });

  it('preserves optional fields when provided', () => {
    const out = normalizeLesson({
      lesson: '한글 lesson',
      errorPattern: 'TypeError',
      successPattern: 'green',
      tokenCost: 42,
      sourcePhase: 'plan',
      sessionId: 'ap-x',
    });
    expect(out.errorPattern).toBe('TypeError');
    expect(out.successPattern).toBe('green');
    expect(out.tokenCost).toBe(42);
    expect(out.sourcePhase).toBe('plan');
    expect(out.sessionId).toBe('ap-x');
  });
});

describe('appendLesson + recallLessons roundtrip', () => {
  it('writes a Korean lesson to <key>.jsonl preserving UTF-8', () => {
    const key = uniqueKey('append-ko');
    const out = appendLesson(key, { lesson: '한글 lesson 본문' });
    const filePath = getFeaturePath(key);
    expect(existsSync(filePath)).toBe(true);
    expect(out.lesson).toBe('한글 lesson 본문');
  });

  it('roundtrips a lesson via recallLessons with featureKey option', () => {
    const key = uniqueKey('roundtrip');
    appendLesson(key, { lesson: '결제 모듈 인증 흐름 정리' });
    const recalled = recallLessons('결제 인증', { featureKey: key });
    expect(recalled.length).toBeGreaterThanOrEqual(1);
    expect(recalled[0].lesson).toBe('결제 모듈 인증 흐름 정리');
  });

  it('respects limit option (3 seeded -> 2 returned)', () => {
    const key = uniqueKey('limit');
    appendLesson(key, { lesson: 'alpha refactor pattern' });
    appendLesson(key, { lesson: 'alpha test coverage' });
    appendLesson(key, { lesson: 'alpha logging adjustment' });
    const recalled = recallLessons('alpha', { featureKey: key, limit: 2 });
    expect(recalled).toHaveLength(2);
  });

  it('returns empty array when feature file does not exist', () => {
    const recalled = recallLessons('anything', { featureKey: 'no-such-key-zzzzz' });
    expect(recalled).toEqual([]);
  });
});

describe('tokenize', () => {
  it('emits 2-char Hangul shingles for Korean tokens', () => {
    const tokens = tokenize('결제 모듈 리팩토링');
    expect(tokens).toContain('결제');
    expect(tokens).toContain('모듈');
    expect(tokens).toContain('리팩');
    expect(tokens).toContain('팩토');
  });

  it('splits English text by Unicode word boundaries', () => {
    const tokens = tokenize('Hello World foo');
    expect(tokens).toContain('hello');
    expect(tokens).toContain('world');
    expect(tokens).toContain('foo');
  });

  it('returns empty array for empty/non-string input', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize(null)).toEqual([]);
  });
});

describe('jaccard', () => {
  it('computes 1/3 for [a,b] vs [b,c]', () => {
    expect(jaccard(['a', 'b'], ['b', 'c'])).toBeCloseTo(1 / 3, 5);
  });

  it('returns 1 for identical sets', () => {
    expect(jaccard(['x', 'y'], ['x', 'y'])).toBe(1);
  });

  it('returns 0 when both inputs are empty/non-arrays', () => {
    expect(jaccard([], [])).toBe(0);
    expect(jaccard(null, undefined)).toBe(0);
  });
});

describe('scoreLesson', () => {
  it('boosts score by 0.1 when errorPattern token matches', () => {
    const taskTokens = tokenize('TypeError handling');
    const base = scoreLesson(taskTokens, { lesson: 'unrelated body' });
    const boosted = scoreLesson(taskTokens, {
      lesson: 'unrelated body',
      errorPattern: 'TypeError occurs here',
    });
    expect(boosted).toBeGreaterThan(base);
  });
});

describe('compactFeature', () => {
  it('is a noop below threshold', () => {
    const key = uniqueKey('noop');
    for (let i = 0; i < 5; i += 1) {
      appendLesson(key, { lesson: `lesson ${i}` });
    }
    const result = compactFeature(key, { threshold: 100, keepLatest: 50 });
    expect(result.archived).toBe(0);
    expect(result.kept).toBe(5);
  });

  it('archives older lessons at custom threshold (avoiding F5 auto-trigger)', () => {
    const key = uniqueKey('compact');
    // 11 entries < DEFAULT_COMPACT_THRESHOLD(100), so auto-compact does not fire.
    for (let i = 0; i < 11; i += 1) {
      appendLesson(key, { lesson: `entry-${i}` });
    }
    const result = compactFeature(key, { threshold: 10, keepLatest: 5 });
    expect(result.archived).toBe(6);
    expect(result.kept).toBe(5);
    const dir = getMemoryDir();
    const files = readdirSync(dir);
    const archives = files.filter((f) => f.startsWith(`${key}.`) && f.includes('archive'));
    expect(archives.length).toBeGreaterThanOrEqual(1);
    for (const f of archives) createdKeys.push(f.replace('.jsonl', ''));
    const remaining = recallLessons('entry', { featureKey: key, limit: 100 });
    expect(remaining.length).toBeLessThanOrEqual(5);
  });
});

describe('F3 dedup (v1.1)', () => {
  it('skips append when last entry has identical taskHash + lesson body', () => {
    const key = uniqueKey('dedup');
    const a = appendLesson(key, { sessionId: 's1', lesson: '동일 lesson 본문' });
    const b = appendLesson(key, { sessionId: 's1', lesson: '동일 lesson 본문' });
    expect(b.ts).toBe(a.ts);
    const all = recallLessons('동일', { featureKey: key, limit: 100 });
    expect(all.length).toBe(1);
  });

  it('appends when lesson body differs (no false-positive dedup)', () => {
    const key = uniqueKey('nodedup');
    appendLesson(key, { sessionId: 's1', lesson: 'lesson A' });
    appendLesson(key, { sessionId: 's1', lesson: 'lesson B' });
    const all = recallLessons('lesson', { featureKey: key, limit: 100 });
    expect(all.length).toBe(2);
  });
});

describe('F5 auto-compact (v1.1)', () => {
  it('auto-compacts on append when DEFAULT_COMPACT_THRESHOLD (100) is reached', () => {
    const key = uniqueKey('autocompact');
    for (let i = 0; i < 100; i += 1) {
      appendLesson(key, { lesson: `auto-${i}` });
    }
    const dir = getMemoryDir();
    const files = readdirSync(dir);
    const archives = files.filter((f) => f.startsWith(`${key}.`) && f.includes('archive'));
    expect(archives.length).toBeGreaterThanOrEqual(1);
    for (const f of archives) createdKeys.push(f.replace('.jsonl', ''));
    const remaining = recallLessons('auto', { featureKey: key, limit: 200 });
    expect(remaining.length).toBeLessThanOrEqual(50);
  });
});

describe('malformed lines are skipped on recall', () => {
  it('ignores broken JSONL rows but still returns valid lessons', () => {
    const key = uniqueKey('malformed');
    const filePath = getFeaturePath(key);
    appendLesson(key, { lesson: 'first valid 한글 lesson' });
    appendFileSync(filePath, '{not valid json\n', 'utf-8');
    appendLesson(key, { lesson: 'second valid lesson' });
    const recalled = recallLessons('valid', { featureKey: key, limit: 10 });
    expect(recalled.length).toBe(2);
    const bodies = recalled.map((l) => l.lesson);
    expect(bodies).toContain('first valid 한글 lesson');
    expect(bodies).toContain('second valid lesson');
  });
});

describe('concurrent appends are safe', () => {
  it('preserves all 50 parallel-appended lessons', async () => {
    const key = uniqueKey('parallel');
    const tasks = [];
    for (let i = 0; i < 50; i += 1) {
      tasks.push(Promise.resolve().then(() => appendLesson(key, { lesson: `parallel-${i}` })));
    }
    await Promise.all(tasks);
    const recalled = recallLessons('parallel', { featureKey: key, limit: 100 });
    expect(recalled.length).toBe(50);
  });
});
