import { describe, expect, it } from 'vitest';
import {
  hashShort,
  stripProvenancePII,
} from '../../lib/learning/auto-learning-extractor.js';

// ---------------------------------------------------------------------------
// hashShort
// ---------------------------------------------------------------------------

describe('auto-learning-extractor/hashShort', () => {
  it('유효한 문자열 → 8자 hex', () => {
    const result = hashShort('test@example.com');
    expect(result).toHaveLength(8);
    expect(result).toMatch(/^[0-9a-f]{8}$/);
  });

  it('같은 입력 → 같은 해시 (결정적)', () => {
    const a = hashShort('hello');
    const b = hashShort('hello');
    expect(a).toBe(b);
  });

  it('다른 입력 → 다른 해시', () => {
    const a = hashShort('alice@test.com');
    const b = hashShort('bob@test.com');
    expect(a).not.toBe(b);
  });

  it('빈 문자열 → "unknown"', () => {
    expect(hashShort('')).toBe('unknown');
  });

  it('null → "unknown"', () => {
    expect(hashShort(null)).toBe('unknown');
  });

  it('undefined → "unknown"', () => {
    expect(hashShort(undefined)).toBe('unknown');
  });

  it('숫자 입력 → "unknown" (string 아님)', () => {
    expect(hashShort(123)).toBe('unknown');
  });

  it('공백 문자열 → 유효한 해시 (빈 문자열 아님)', () => {
    const result = hashShort(' ');
    expect(result).toHaveLength(8);
    expect(result).toMatch(/^[0-9a-f]{8}$/);
  });

  it('긴 문자열도 8자 해시', () => {
    const result = hashShort('a'.repeat(10000));
    expect(result).toHaveLength(8);
  });

  it('유니코드 문자열', () => {
    const result = hashShort('한국어테스트');
    expect(result).toHaveLength(8);
    expect(result).toMatch(/^[0-9a-f]{8}$/);
  });

  it('SHA-256 기반 해시 (crypto 모듈)', () => {
    // Known SHA-256 for 'test' starts with '9f86d081'
    const result = hashShort('test');
    expect(result).toBe('9f86d081');
  });
});

// ---------------------------------------------------------------------------
// stripProvenancePII
// ---------------------------------------------------------------------------

describe('auto-learning-extractor/stripProvenancePII', () => {
  const fullProvenance = {
    user: 'Artience',
    emailHash: 'abc12345',
    machineHash: 'def67890',
    project: 'https://github.com/user/repo.git',
    projectName: 'Artibot',
    branch: 'artibot/master',
    commitRange: 'abc1234..def5678',
    extractedAt: '2026-03-25T03:00:00.000Z',
    pipelineVersion: '1.14.0',
  };

  it('user 필드 제거', () => {
    const result = stripProvenancePII(fullProvenance);
    expect(result).not.toHaveProperty('user');
  });

  it('emailHash 필드 제거', () => {
    const result = stripProvenancePII(fullProvenance);
    expect(result).not.toHaveProperty('emailHash');
  });

  it('machineHash 필드 제거', () => {
    const result = stripProvenancePII(fullProvenance);
    expect(result).not.toHaveProperty('machineHash');
  });

  it('project 메타데이터 보존', () => {
    const result = stripProvenancePII(fullProvenance);
    expect(result.project).toBe('https://github.com/user/repo.git');
    expect(result.projectName).toBe('Artibot');
    expect(result.branch).toBe('artibot/master');
    expect(result.commitRange).toBe('abc1234..def5678');
    expect(result.extractedAt).toBe('2026-03-25T03:00:00.000Z');
    expect(result.pipelineVersion).toBe('1.14.0');
  });

  it('null 입력 → 빈 객체', () => {
    expect(stripProvenancePII(null)).toEqual({});
  });

  it('undefined 입력 → 빈 객체', () => {
    expect(stripProvenancePII(undefined)).toEqual({});
  });

  it('빈 객체 → 빈 객체', () => {
    expect(stripProvenancePII({})).toEqual({});
  });

  it('PII 필드만 있는 경우 → 빈 객체', () => {
    const result = stripProvenancePII({
      user: 'test',
      emailHash: 'abc',
      machineHash: 'def',
    });
    expect(result).toEqual({});
  });

  it('원본 객체 불변 (새 객체 반환)', () => {
    const original = { ...fullProvenance };
    const result = stripProvenancePII(original);
    // Original should still have all fields
    expect(original).toHaveProperty('user');
    expect(original).toHaveProperty('emailHash');
    // Result should not
    expect(result).not.toHaveProperty('user');
  });

  it('추가 필드도 보존', () => {
    const input = {
      ...fullProvenance,
      customField: 'preserved',
    };
    const result = stripProvenancePII(input);
    expect(result.customField).toBe('preserved');
  });
});
