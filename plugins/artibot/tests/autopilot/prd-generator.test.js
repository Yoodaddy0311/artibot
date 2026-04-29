/**
 * Unit tests for lib/autopilot/prd-generator.js
 * Covers slugify and generatePRD (with real I/O via tmpdir).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import {
  generatePRD,
  renderPRD,
  slugify,
} from '../../lib/autopilot/prd-generator.js';

describe('slugify', () => {
  it('lowercases ASCII letters and joins with hyphen', () => {
    expect(slugify('Build New Feature')).toBe('build-new-feature');
  });

  it('preserves Hangul characters', () => {
    const s = slugify('자동 빌드 기능');
    expect(s).toContain('자동');
    expect(s).toContain('빌드');
    expect(s).toContain('기능');
    expect(s).toMatch(/-/);
  });

  it('strips special characters and collapses to hyphen', () => {
    expect(slugify('Hello, World! @#$%')).toBe('hello-world');
  });

  it('returns "task" for empty input', () => {
    expect(slugify('')).toBe('task');
    expect(slugify(null)).toBe('task');
  });

  it('caps slug at 60 characters', () => {
    const long = 'a'.repeat(200);
    expect(slugify(long).length).toBeLessThanOrEqual(60);
  });
});

describe('renderPRD', () => {
  it('contains all required section headers', () => {
    const out = renderPRD({ task: '테스트 작업', sessionId: 'ap-test-1' });
    expect(out).toContain('# PRD: 테스트 작업');
    expect(out).toContain('## 1. 배경');
    expect(out).toContain('## 2. 목표');
    expect(out).toContain('## 3. 범위');
    expect(out).toContain('## 7. 수락 기준');
    expect(out).toContain('ap-test-1');
  });
});

describe('generatePRD', () => {
  const created = [];

  afterEach(() => {
    while (created.length) {
      const p = created.pop();
      try { rmSync(p, { force: true }); } catch { /* ignore */ }
    }
  });

  it('writes PRD file to docs/PRD/ and returns content', () => {
    const sessionId = `ap-test-${Date.now()}`;
    const result = generatePRD({
      task: 'autopilot 단위 테스트 케이스',
      sessionId,
    });
    created.push(result.filePath);
    expect(existsSync(result.filePath)).toBe(true);
    const fileContent = readFileSync(result.filePath, 'utf-8');
    expect(fileContent).toContain('# PRD:');
    expect(fileContent).toContain(sessionId);
    expect(result.slug).toBeTruthy();
  });

  it('throws when sessionId missing', () => {
    expect(() => generatePRD({ task: 'x' })).toThrow();
  });
});
