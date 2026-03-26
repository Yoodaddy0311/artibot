import { describe, expect, it } from 'vitest';
import {
  _detectTriggerDuplicates,
  _formatTableReport,
  _parseFrontmatter,
  _summarize,
  _validateSkill,
  REQUIRED_FIELDS,
  VALID_CONTEXTS,
} from '../../scripts/gen-skill-docs.js';

// ---------------------------------------------------------------------------
// Unit: parseFrontmatter
// ---------------------------------------------------------------------------

describe('gen-skill-docs/_parseFrontmatter', () => {
  it('기본 frontmatter 파싱', () => {
    const content = `---
name: my-skill
description: A test skill
context: forked
triggers:
  - keyword1
  - keyword2
---

# Body content`;

    const fields = _parseFrontmatter(content);
    expect(fields.name).toBe('my-skill');
    expect(fields.description).toBe('A test skill');
    expect(fields.context).toBe('forked');
    expect(fields.triggers).toEqual(['keyword1', 'keyword2']);
  });

  it('인라인 배열 파싱 [a, b, c]', () => {
    const content = `---
name: test
platforms: [claude-code, gemini-cli]
---`;

    const fields = _parseFrontmatter(content);
    expect(fields.platforms).toEqual(['claude-code', 'gemini-cli']);
  });

  it('frontmatter 없으면 null', () => {
    expect(_parseFrontmatter('# Just a heading')).toBeNull();
    expect(_parseFrontmatter('no frontmatter')).toBeNull();
  });

  it('빈 frontmatter → null (파싱할 키 없음)', () => {
    const content = `---
---`;
    // Empty frontmatter block has no content between delimiters → regex may not match
    const fields = _parseFrontmatter(content);
    expect(fields).toBeNull();
  });

  it('따옴표 제거', () => {
    const content = `---
name: "quoted-name"
description: 'single-quoted'
---`;

    const fields = _parseFrontmatter(content);
    expect(fields.name).toBe('quoted-name');
    expect(fields.description).toBe('single-quoted');
  });

  it('배열 항목 따옴표 제거', () => {
    const content = `---
triggers:
  - "trigger-one"
  - 'trigger-two'
---`;

    const fields = _parseFrontmatter(content);
    expect(fields.triggers).toEqual(['trigger-one', 'trigger-two']);
  });

  it('숫자 필드는 문자열로 파싱', () => {
    const content = `---
level: 3
tokens: 500
---`;

    const fields = _parseFrontmatter(content);
    expect(fields.level).toBe('3');
    expect(fields.tokens).toBe('500');
  });

  it('다중 키-값 쌍', () => {
    const content = `---
name: multi
description: desc
context: forked
category: testing
level: 2
---`;

    const fields = _parseFrontmatter(content);
    expect(fields.name).toBe('multi');
    expect(fields.category).toBe('testing');
    expect(fields.level).toBe('2');
  });
});

// ---------------------------------------------------------------------------
// Unit: validateSkill
// ---------------------------------------------------------------------------

describe('gen-skill-docs/_validateSkill', () => {
  function compliantFields(name = 'test-skill') {
    return {
      name,
      description: 'A valid skill',
      context: 'forked',
      triggers: ['keyword'],
      platforms: ['claude-code'],
      level: '3',
      category: 'testing',
      tokens: '500',
      agents: ['orchestrator'],
    };
  }

  it('완전 준수 스킬 → 이슈 없음', () => {
    const issues = _validateSkill('test-skill', compliantFields());
    expect(issues).toHaveLength(0);
  });

  it('필수 필드 누락 → error', () => {
    const issues = _validateSkill('test', { description: 'only desc' });
    const errors = issues.filter((i) => i.severity === 'error');
    expect(errors.length).toBeGreaterThanOrEqual(3); // name, context, triggers missing
    expect(errors.some((e) => e.field === 'name')).toBe(true);
    expect(errors.some((e) => e.field === 'context')).toBe(true);
    expect(errors.some((e) => e.field === 'triggers')).toBe(true);
  });

  it('추천 필드 누락 → warn', () => {
    const fields = {
      name: 'test',
      description: 'desc',
      context: 'forked',
      triggers: ['kw'],
    };
    const issues = _validateSkill('test', fields);
    const warns = issues.filter((i) => i.severity === 'warn');
    expect(warns.length).toBeGreaterThanOrEqual(1);
  });

  it('name ≠ directory → error', () => {
    const fields = compliantFields('wrong-name');
    const issues = _validateSkill('actual-dir', fields);
    expect(issues.some((i) => i.severity === 'error' && i.field === 'name')).toBe(true);
  });

  it('유효하지 않은 context → error', () => {
    const fields = { ...compliantFields(), context: 'invalid' };
    const issues = _validateSkill('test-skill', fields);
    expect(issues.some((i) => i.severity === 'error' && i.field === 'context')).toBe(true);
  });

  it('유효한 context 값들 → 통과', () => {
    for (const ctx of VALID_CONTEXTS) {
      const fields = { ...compliantFields(), context: ctx };
      const issues = _validateSkill('test-skill', fields);
      const ctxErrors = issues.filter((i) => i.field === 'context' && i.severity === 'error');
      expect(ctxErrors).toHaveLength(0);
    }
  });

  it('triggers가 빈 배열 → error', () => {
    const fields = { ...compliantFields(), triggers: [] };
    const issues = _validateSkill('test-skill', fields);
    expect(issues.some((i) => i.field === 'triggers' && i.severity === 'error')).toBe(true);
  });

  it('triggers가 비배열 → error', () => {
    const fields = { ...compliantFields(), triggers: 'not-array' };
    const issues = _validateSkill('test-skill', fields);
    expect(issues.some((i) => i.field === 'triggers' && i.severity === 'error')).toBe(true);
  });

  it('알 수 없는 platform → warn', () => {
    const fields = { ...compliantFields(), platforms: ['unknown-platform'] };
    const issues = _validateSkill('test-skill', fields);
    expect(issues.some((i) => i.field === 'platforms' && i.severity === 'warn')).toBe(true);
  });

  it('알 수 없는 category → warn', () => {
    const fields = { ...compliantFields(), category: 'nonexistent' };
    const issues = _validateSkill('test-skill', fields);
    expect(issues.some((i) => i.field === 'category' && i.severity === 'warn')).toBe(true);
  });

  it('level 범위 밖 → warn', () => {
    const fields = { ...compliantFields(), level: '0' };
    const issues = _validateSkill('test-skill', fields);
    expect(issues.some((i) => i.field === 'level')).toBe(true);

    const fields2 = { ...compliantFields(), level: '6' };
    const issues2 = _validateSkill('test-skill', fields2);
    expect(issues2.some((i) => i.field === 'level')).toBe(true);
  });

  it('level NaN → warn', () => {
    const fields = { ...compliantFields(), level: 'abc' };
    const issues = _validateSkill('test-skill', fields);
    expect(issues.some((i) => i.field === 'level')).toBe(true);
  });

  it('완전히 빈 fields → 모든 필수 필드 error', () => {
    const issues = _validateSkill('test', {});
    const errors = issues.filter((i) => i.severity === 'error');
    expect(errors.length).toBe(REQUIRED_FIELDS.length);
  });
});

// ---------------------------------------------------------------------------
// Unit: detectTriggerDuplicates
// ---------------------------------------------------------------------------

describe('gen-skill-docs/_detectTriggerDuplicates', () => {
  it('중복 없음 → 빈 배열', () => {
    const map = {
      'skill-a': { triggers: ['alpha', 'beta'] },
      'skill-b': { triggers: ['gamma', 'delta'] },
    };
    expect(_detectTriggerDuplicates(map)).toEqual([]);
  });

  it('중복 감지', () => {
    const map = {
      'skill-a': { triggers: ['deploy', 'build'] },
      'skill-b': { triggers: ['deploy', 'test'] },
    };
    const dupes = _detectTriggerDuplicates(map);
    expect(dupes).toHaveLength(1);
    expect(dupes[0].trigger).toBe('deploy');
    expect(dupes[0].skills).toContain('skill-a');
    expect(dupes[0].skills).toContain('skill-b');
  });

  it('대소문자 무시 (normalize)', () => {
    const map = {
      'skill-a': { triggers: ['Deploy'] },
      'skill-b': { triggers: ['deploy'] },
    };
    const dupes = _detectTriggerDuplicates(map);
    expect(dupes).toHaveLength(1);
  });

  it('공백 trim', () => {
    const map = {
      'skill-a': { triggers: ['  test  '] },
      'skill-b': { triggers: ['test'] },
    };
    const dupes = _detectTriggerDuplicates(map);
    expect(dupes).toHaveLength(1);
  });

  it('triggers 없는 스킬 무시', () => {
    const map = {
      'skill-a': { description: 'no triggers' },
      'skill-b': { triggers: ['kw'] },
    };
    expect(_detectTriggerDuplicates(map)).toEqual([]);
  });

  it('3개 이상 스킬 중복 — count 순 정렬', () => {
    const map = {
      'a': { triggers: ['shared', 'unique-a'] },
      'b': { triggers: ['shared'] },
      'c': { triggers: ['shared'] },
      'd': { triggers: ['pair', 'unique-d'] },
      'e': { triggers: ['pair'] },
    };
    const dupes = _detectTriggerDuplicates(map);
    expect(dupes).toHaveLength(2);
    // shared (3 skills) should come before pair (2 skills)
    expect(dupes[0].trigger).toBe('shared');
    expect(dupes[0].skills).toHaveLength(3);
    expect(dupes[1].trigger).toBe('pair');
    expect(dupes[1].skills).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Unit: summarize
// ---------------------------------------------------------------------------

describe('gen-skill-docs/_summarize', () => {
  it('기본 통계 계산', () => {
    const results = {
      'skill-a': { issues: [] },
      'skill-b': { issues: [{ severity: 'error', field: 'name', message: 'err' }] },
      'skill-c': { issues: [{ severity: 'warn', field: 'level', message: 'warn' }] },
    };
    const s = _summarize(results);
    expect(s.total).toBe(3);
    expect(s.errors).toBe(1);
    expect(s.warnings).toBe(1);
    expect(s.compliant).toBe(1);
  });

  it('빈 results → 0', () => {
    const s = _summarize({});
    expect(s.total).toBe(0);
    expect(s.errors).toBe(0);
    expect(s.compliant).toBe(0);
  });

  it('모두 준수 → compliant = total', () => {
    const results = {
      'a': { issues: [] },
      'b': { issues: [] },
    };
    const s = _summarize(results);
    expect(s.compliant).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Unit: formatTableReport
// ---------------------------------------------------------------------------

describe('gen-skill-docs/_formatTableReport', () => {
  it('Markdown 형식 리포트 생성', () => {
    const results = {
      'skill-a': {
        fields: { category: 'testing' },
        issues: [{ severity: 'error', field: 'name', message: 'missing name' }],
      },
    };
    const report = _formatTableReport(results, []);

    expect(report).toContain('## SKILL.md Validation Report');
    expect(report).toContain('1 skills');
    expect(report).toContain('1 errors');
    expect(report).toContain('**ERROR**');
    expect(report).toContain('missing name');
  });

  it('중복 테이블 포함', () => {
    const results = { 'a': { fields: {}, issues: [] } };
    const dupes = [{ trigger: 'deploy', skills: ['a', 'b'] }];
    const report = _formatTableReport(results, dupes);

    expect(report).toContain('### Trigger Duplicates');
    expect(report).toContain('`deploy`');
    expect(report).toContain('a, b');
  });

  it('카테고리 분포 테이블', () => {
    const results = {
      'a': { fields: { category: 'testing' }, issues: [] },
      'b': { fields: { category: 'testing' }, issues: [] },
      'c': { fields: { category: 'security' }, issues: [] },
    };
    const report = _formatTableReport(results, []);

    expect(report).toContain('### Category Distribution');
    expect(report).toContain('testing');
    expect(report).toContain('security');
  });

  it('이슈 없으면 Issues 섹션 생략', () => {
    const results = { 'a': { fields: {}, issues: [] } };
    const report = _formatTableReport(results, []);

    expect(report).not.toContain('### Issues');
  });

  it('category 없는 스킬 → uncategorized', () => {
    const results = {
      'a': { fields: {}, issues: [] },
    };
    const report = _formatTableReport(results, []);

    expect(report).toContain('uncategorized');
  });
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('gen-skill-docs/constants', () => {
  it('REQUIRED_FIELDS 포함 확인', () => {
    expect(REQUIRED_FIELDS).toContain('name');
    expect(REQUIRED_FIELDS).toContain('description');
    expect(REQUIRED_FIELDS).toContain('context');
    expect(REQUIRED_FIELDS).toContain('triggers');
  });

  it('VALID_CONTEXTS 포함 확인', () => {
    expect(VALID_CONTEXTS).toContain('fork');
    expect(VALID_CONTEXTS).toContain('forked');
    expect(VALID_CONTEXTS).toContain('native');
    expect(VALID_CONTEXTS).toContain('shared');
  });
});
