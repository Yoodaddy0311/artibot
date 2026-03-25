import { describe, expect, it } from 'vitest';
import {
  parseLintOutput,
  parseTestOutput,
} from '../../lib/learning/auto-learning-scanner.js';

// ---------------------------------------------------------------------------
// parseLintOutput
// ---------------------------------------------------------------------------

describe('auto-learning-scanner/parseLintOutput', () => {
  it('에러 0개 → passed=true', () => {
    const json = JSON.stringify([
      { errorCount: 0, warningCount: 2, filePath: 'file1.js' },
      { errorCount: 0, warningCount: 1, filePath: 'file2.js' },
    ]);
    const result = parseLintOutput(json);
    expect(result.errorCount).toBe(0);
    expect(result.warningCount).toBe(3);
    expect(result.passed).toBe(true);
  });

  it('에러 있으면 → passed=false', () => {
    const json = JSON.stringify([
      { errorCount: 3, warningCount: 1, filePath: 'file1.js' },
      { errorCount: 1, warningCount: 0, filePath: 'file2.js' },
    ]);
    const result = parseLintOutput(json);
    expect(result.errorCount).toBe(4);
    expect(result.warningCount).toBe(1);
    expect(result.passed).toBe(false);
  });

  it('빈 배열 → 에러 0, passed=true', () => {
    const result = parseLintOutput('[]');
    expect(result.errorCount).toBe(0);
    expect(result.warningCount).toBe(0);
    expect(result.passed).toBe(true);
  });

  it('단일 파일 결과', () => {
    const json = JSON.stringify([
      { errorCount: 5, warningCount: 10, filePath: 'test.js' },
    ]);
    const result = parseLintOutput(json);
    expect(result.errorCount).toBe(5);
    expect(result.warningCount).toBe(10);
    expect(result.passed).toBe(false);
  });

  it('경고만 → passed=true', () => {
    const json = JSON.stringify([
      { errorCount: 0, warningCount: 100, filePath: 'warn.js' },
    ]);
    const result = parseLintOutput(json);
    expect(result.passed).toBe(true);
    expect(result.warningCount).toBe(100);
  });

  it('다수 파일 집계', () => {
    const files = Array.from({ length: 10 }, (_, i) => ({
      errorCount: i,
      warningCount: i * 2,
      filePath: `file${i}.js`,
    }));
    const result = parseLintOutput(JSON.stringify(files));
    // sum of 0..9 = 45
    expect(result.errorCount).toBe(45);
    expect(result.warningCount).toBe(90);
    expect(result.passed).toBe(false);
  });

  it('잘못된 JSON → 예외 throw', () => {
    expect(() => parseLintOutput('not json')).toThrow();
  });

  it('반환 구조: errorCount, warningCount, passed', () => {
    const result = parseLintOutput('[]');
    expect(result).toHaveProperty('errorCount');
    expect(result).toHaveProperty('warningCount');
    expect(result).toHaveProperty('passed');
    expect(Object.keys(result)).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// parseTestOutput
// ---------------------------------------------------------------------------

describe('auto-learning-scanner/parseTestOutput', () => {
  it('모든 테스트 통과 → allPassed=true', () => {
    const json = JSON.stringify({
      numPassedTests: 100,
      numFailedTests: 0,
    });
    const result = parseTestOutput(json);
    expect(result.passed).toBe(100);
    expect(result.failed).toBe(0);
    expect(result.total).toBe(100);
    expect(result.allPassed).toBe(true);
  });

  it('실패 있음 → allPassed=false', () => {
    const json = JSON.stringify({
      numPassedTests: 95,
      numFailedTests: 5,
    });
    const result = parseTestOutput(json);
    expect(result.passed).toBe(95);
    expect(result.failed).toBe(5);
    expect(result.total).toBe(100);
    expect(result.allPassed).toBe(false);
  });

  it('필드 누락 → 0 기본값', () => {
    const result = parseTestOutput('{}');
    expect(result.passed).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.total).toBe(0);
    expect(result.allPassed).toBe(true); // 0 failed = all passed
  });

  it('passed만 있을 때', () => {
    const json = JSON.stringify({ numPassedTests: 50 });
    const result = parseTestOutput(json);
    expect(result.passed).toBe(50);
    expect(result.failed).toBe(0);
    expect(result.total).toBe(50);
    expect(result.allPassed).toBe(true);
  });

  it('failed만 있을 때', () => {
    const json = JSON.stringify({ numFailedTests: 3 });
    const result = parseTestOutput(json);
    expect(result.passed).toBe(0);
    expect(result.failed).toBe(3);
    expect(result.total).toBe(3);
    expect(result.allPassed).toBe(false);
  });

  it('잘못된 JSON → 예외 throw', () => {
    expect(() => parseTestOutput('invalid')).toThrow();
  });

  it('대규모 테스트 결과', () => {
    const json = JSON.stringify({
      numPassedTests: 3765,
      numFailedTests: 0,
    });
    const result = parseTestOutput(json);
    expect(result.total).toBe(3765);
    expect(result.allPassed).toBe(true);
  });

  it('반환 구조: passed, failed, total, allPassed', () => {
    const result = parseTestOutput('{}');
    expect(result).toHaveProperty('passed');
    expect(result).toHaveProperty('failed');
    expect(result).toHaveProperty('total');
    expect(result).toHaveProperty('allPassed');
    expect(Object.keys(result)).toHaveLength(4);
  });

  it('total = passed + failed', () => {
    const json = JSON.stringify({
      numPassedTests: 42,
      numFailedTests: 8,
    });
    const result = parseTestOutput(json);
    expect(result.total).toBe(result.passed + result.failed);
  });

  it('단일 실패', () => {
    const json = JSON.stringify({
      numPassedTests: 999,
      numFailedTests: 1,
    });
    const result = parseTestOutput(json);
    expect(result.allPassed).toBe(false);
  });
});
