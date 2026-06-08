/**
 * Unit tests for lib/autopilot/prd-generator.js
 * Covers slugify and generatePRD (with real I/O via tmpdir).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
  let projectRoot = null;

  beforeEach(() => {
    projectRoot = mkdtempSync(path.join(tmpdir(), 'artibot-prd-gen-'));
  });

  afterEach(() => {
    if (projectRoot) {
      try { rmSync(projectRoot, { recursive: true, force: true }); } catch { /* ignore */ }
      projectRoot = null;
    }
  });

  it('writes PRD file to docs/PRD/ and returns content', () => {
    const sessionId = `ap-test-${Date.now()}`;
    const result = generatePRD({
      task: 'autopilot 단위 테스트 케이스',
      sessionId,
      projectRoot,
    });
    expect(existsSync(result.filePath)).toBe(true);
    // Verify the file is rooted at the tmpdir (no real-project leak)
    expect(result.filePath.startsWith(projectRoot)).toBe(true);
    const fileContent = readFileSync(result.filePath, 'utf-8');
    expect(fileContent).toContain('# PRD:');
    expect(fileContent).toContain(sessionId);
    expect(result.slug).toBeTruthy();
  });

  it('throws when sessionId missing', () => {
    expect(() => generatePRD({ task: 'x', projectRoot })).toThrow();
  });
});

describe('renderPRD — Goal Contract section (v4.6.0)', () => {
  it('omits the Goal Contract section when options.goalContract is absent (legacy backward compat)', () => {
    const md = renderPRD({
      task: 'legacy task',
      sessionId: 'ap-legacy',
      options: {},
    });
    expect(md).not.toContain('Goal Contract');
    expect(md).toContain('## 2. 목표');
    expect(md).toContain('## 3. 범위');
  });

  it('renders a Goal Contract section between section 2 and 3 when supplied', () => {
    const contract = {
      objective: 'migrate API to v2',
      stoppingCondition: 'all endpoints return 200',
      validationCommand: 'npm run ci',
      forbiddenChanges: [],
      maxIterations: 3,
    };
    const md = renderPRD({
      task: 'migration task',
      sessionId: 'ap-goal-1',
      options: { goalContract: contract },
    });
    expect(md).toContain('## 2.5 Goal Contract');
    expect(md).toContain('"objective": "migrate API to v2"');
    expect(md).toContain('"stoppingCondition": "all endpoints return 200"');
    // Section ordering: 2 → 2.5 → 3
    const idx2 = md.indexOf('## 2. 목표');
    const idx25 = md.indexOf('## 2.5 Goal Contract');
    const idx3 = md.indexOf('## 3. 범위');
    expect(idx2).toBeLessThan(idx25);
    expect(idx25).toBeLessThan(idx3);
  });

  it('emits the Goal Contract as a valid JSON-fenced block parseable by prd-parser', async () => {
    const { parseGoalContract } = await import('../../lib/autopilot/prd-parser.js');
    const contract = {
      objective: 'X',
      stoppingCondition: 'Y',
      validationCommand: null,
      forbiddenChanges: ['a.md'],
      maxIterations: 2,
    };
    const md = renderPRD({
      task: 'roundtrip task',
      sessionId: 'ap-roundtrip',
      options: { goalContract: contract },
    });
    const parsed = parseGoalContract(md);
    expect(parsed.found).toBe(true);
    expect(parsed.errors).toEqual([]);
    expect(parsed.contract).toEqual(contract);
  });
});
