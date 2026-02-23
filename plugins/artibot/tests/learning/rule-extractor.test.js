import { describe, expect, it } from 'vitest';
import { classifyRule, extractRules, RULE_PATTERNS } from '../../lib/learning/rule-extractor.js';

// ---------------------------------------------------------------------------
// RULE_PATTERNS export
// ---------------------------------------------------------------------------

describe('RULE_PATTERNS', () => {
  it('is a non-empty array', () => {
    expect(Array.isArray(RULE_PATTERNS)).toBe(true);
    expect(RULE_PATTERNS.length).toBeGreaterThan(0);
  });

  it('every entry has required fields', () => {
    for (const p of RULE_PATTERNS) {
      expect(typeof p.type).toBe('string');
      expect(typeof p.lang).toBe('string');
      expect(p.pattern instanceof RegExp).toBe(true);
      expect(typeof p.confidence).toBe('number');
      expect(typeof p.extract).toBe('function');
    }
  });

  it('all confidences are in 0-1 range', () => {
    for (const p of RULE_PATTERNS) {
      expect(p.confidence).toBeGreaterThan(0);
      expect(p.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('covers all four rule types', () => {
    const types = new Set(RULE_PATTERNS.map((p) => p.type));
    expect(types.has('preference')).toBe(true);
    expect(types.has('prohibition')).toBe(true);
    expect(types.has('decision')).toBe(true);
    expect(types.has('tool-preference')).toBe(true);
  });

  it('covers Korean and English languages', () => {
    const langs = new Set(RULE_PATTERNS.map((p) => p.lang));
    expect(langs.has('ko')).toBe(true);
    expect(langs.has('en')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// classifyRule()
// ---------------------------------------------------------------------------

describe('classifyRule()', () => {
  // -- Guard clauses --
  it('returns null for null input', () => {
    expect(classifyRule(null)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(classifyRule(undefined)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(classifyRule('')).toBeNull();
  });

  it('returns null for non-string input', () => {
    expect(classifyRule(42)).toBeNull();
    expect(classifyRule({})).toBeNull();
  });

  it('returns null for very short text', () => {
    expect(classifyRule('hi')).toBeNull();
  });

  it('returns null for unrecognized text', () => {
    expect(classifyRule('The weather is nice today')).toBeNull();
  });

  // -- English: preference --
  it('classifies "Always use TypeScript" as preference', () => {
    const rule = classifyRule('Always use TypeScript');
    expect(rule).not.toBeNull();
    expect(rule.type).toBe('preference');
    expect(rule.content).toContain('TypeScript');
    expect(rule.lang).toBe('en');
  });

  it('classifies "Always run tests before committing" as preference', () => {
    const rule = classifyRule('Always run tests before committing');
    expect(rule).not.toBeNull();
    expect(rule.type).toBe('preference');
  });

  it('classifies "Make sure to validate inputs" as preference', () => {
    const rule = classifyRule('Make sure to validate inputs');
    expect(rule).not.toBeNull();
    expect(rule.type).toBe('preference');
  });

  it('classifies "Remember to add error handling" as preference', () => {
    const rule = classifyRule('Remember to add error handling');
    expect(rule).not.toBeNull();
    expect(rule.type).toBe('preference');
  });

  // -- English: prohibition --
  it('classifies "Never use var" as prohibition', () => {
    const rule = classifyRule('Never use var');
    expect(rule).not.toBeNull();
    expect(rule.type).toBe('prohibition');
    expect(rule.content).toContain('var');
  });

  it('classifies "Don\'t mutate state" as prohibition', () => {
    const rule = classifyRule("Don't mutate state");
    expect(rule).not.toBeNull();
    expect(rule.type).toBe('prohibition');
  });

  it('classifies "Do not use console.log" as prohibition', () => {
    const rule = classifyRule('Do not use console.log');
    expect(rule).not.toBeNull();
    expect(rule.type).toBe('prohibition');
  });

  it('classifies "Avoid deeply nested callbacks" as prohibition', () => {
    const rule = classifyRule('Avoid deeply nested callbacks');
    expect(rule).not.toBeNull();
    expect(rule.type).toBe('prohibition');
  });

  // -- English: decision --
  it('classifies "We decided to use React" as decision', () => {
    const rule = classifyRule('We decided to use React');
    expect(rule).not.toBeNull();
    expect(rule.type).toBe('decision');
    expect(rule.content).toContain('React');
  });

  it('classifies "We\'ve decided to use PostgreSQL" as decision', () => {
    const rule = classifyRule("We've decided to use PostgreSQL");
    expect(rule).not.toBeNull();
    expect(rule.type).toBe('decision');
  });

  it('classifies "The decision is to migrate to Bun" as decision', () => {
    const rule = classifyRule('The decision is to migrate to Bun');
    expect(rule).not.toBeNull();
    expect(rule.type).toBe('decision');
  });

  it('classifies "We will use vitest for testing" as decision', () => {
    const rule = classifyRule('We will use vitest for testing');
    expect(rule).not.toBeNull();
    expect(rule.type).toBe('decision');
  });

  // -- English: tool-preference --
  it('classifies "Use pnpm instead of npm" as tool-preference', () => {
    const rule = classifyRule('Use pnpm instead of npm');
    expect(rule).not.toBeNull();
    expect(rule.type).toBe('tool-preference');
    expect(rule.content).toContain('pnpm');
    expect(rule.content).toContain('npm');
  });

  it('classifies "Prefer zod over joi" as tool-preference', () => {
    const rule = classifyRule('Prefer zod over joi');
    expect(rule).not.toBeNull();
    expect(rule.type).toBe('tool-preference');
    expect(rule.content).toContain('zod');
  });

  // -- Korean: preference --
  it('classifies "항상 테스트를 먼저 작성해라" as preference', () => {
    const rule = classifyRule('항상 테스트를 먼저 작성해라');
    expect(rule).not.toBeNull();
    expect(rule.type).toBe('preference');
    expect(rule.lang).toBe('ko');
    expect(rule.content).toContain('테스트');
  });

  it('classifies "항상 ESLint를 실행하세요" as preference', () => {
    const rule = classifyRule('항상 ESLint를 실행하세요');
    expect(rule).not.toBeNull();
    expect(rule.type).toBe('preference');
    expect(rule.lang).toBe('ko');
  });

  // -- Korean: prohibition --
  it('classifies "var를 사용하지 마라" as prohibition', () => {
    const rule = classifyRule('var를 사용하지 마라');
    expect(rule).not.toBeNull();
    expect(rule.type).toBe('prohibition');
    expect(rule.lang).toBe('ko');
  });

  it('classifies "콘솔 로그를 남기지 마세요" as prohibition', () => {
    const rule = classifyRule('콘솔 로그를 남기지 마세요');
    expect(rule).not.toBeNull();
    expect(rule.type).toBe('prohibition');
    expect(rule.lang).toBe('ko');
  });

  it('classifies "절대 시크릿을 커밋하지 마" as prohibition', () => {
    const rule = classifyRule('절대 시크릿을 커밋하지 마');
    expect(rule).not.toBeNull();
    expect(rule.type).toBe('prohibition');
    expect(rule.lang).toBe('ko');
  });

  // -- Korean: decision --
  it('classifies "Bun으로 결정했다" as decision', () => {
    const rule = classifyRule('Bun으로 결정했다');
    expect(rule).not.toBeNull();
    expect(rule.type).toBe('decision');
    expect(rule.lang).toBe('ko');
  });

  it('classifies "vitest를 쓰기로 했다" as decision', () => {
    const rule = classifyRule('vitest를 쓰기로 했다');
    expect(rule).not.toBeNull();
    expect(rule.type).toBe('decision');
    expect(rule.lang).toBe('ko');
  });

  // -- Korean: tool-preference --
  it('classifies "pnpm을 사용하세요" as tool-preference', () => {
    const rule = classifyRule('pnpm을 사용하세요');
    expect(rule).not.toBeNull();
    expect(rule.type).toBe('tool-preference');
    expect(rule.lang).toBe('ko');
  });

  it('classifies "npm 대신 pnpm를 사용해" as tool-preference', () => {
    const rule = classifyRule('npm 대신 pnpm를 사용해');
    expect(rule).not.toBeNull();
    expect(rule.type).toBe('tool-preference');
    expect(rule.lang).toBe('ko');
    expect(rule.content).toContain('pnpm');
  });

  // -- Rule metadata --
  it('returned rule has all required fields', () => {
    const rule = classifyRule('Always use TypeScript');
    expect(rule).toMatchObject({
      type: expect.any(String),
      content: expect.any(String),
      confidence: expect.any(Number),
      source: 'conversation',
      lang: expect.any(String),
      extractedAt: expect.any(String),
      rawMatch: expect.any(String),
    });
  });

  it('extractedAt is a valid ISO timestamp', () => {
    const rule = classifyRule('Always use TypeScript');
    expect(() => new Date(rule.extractedAt)).not.toThrow();
    expect(new Date(rule.extractedAt).toISOString()).toBe(rule.extractedAt);
  });

  it('returns the highest-confidence match when multiple patterns could match', () => {
    // "Never use var" matches prohibition patterns
    const rule = classifyRule('Never use var');
    expect(rule.type).toBe('prohibition');
    expect(rule.confidence).toBeGreaterThanOrEqual(0.8);
  });
});

// ---------------------------------------------------------------------------
// extractRules()
// ---------------------------------------------------------------------------

describe('extractRules()', () => {
  // -- Guard clauses --
  it('returns [] for null', () => {
    expect(extractRules(null)).toEqual([]);
  });

  it('returns [] for undefined', () => {
    expect(extractRules(undefined)).toEqual([]);
  });

  it('returns [] for empty string', () => {
    expect(extractRules('')).toEqual([]);
  });

  it('returns [] for non-string', () => {
    expect(extractRules(42)).toEqual([]);
    expect(extractRules([])).toEqual([]);
  });

  it('returns [] for message with no recognizable rules', () => {
    expect(extractRules('The sun is shining and the weather is nice.')).toEqual([]);
  });

  // -- Single rule extraction --
  it('extracts a single preference rule from English', () => {
    const rules = extractRules('Always use TypeScript.');
    expect(rules.length).toBeGreaterThanOrEqual(1);
    const pref = rules.find((r) => r.type === 'preference');
    expect(pref).toBeDefined();
    expect(pref.content).toContain('TypeScript');
  });

  it('extracts a single prohibition rule from English', () => {
    const rules = extractRules("Don't use var.");
    expect(rules.length).toBeGreaterThanOrEqual(1);
    const prohibition = rules.find((r) => r.type === 'prohibition');
    expect(prohibition).toBeDefined();
  });

  it('extracts a decision rule from English', () => {
    const rules = extractRules('We decided to use Bun as our runtime.');
    expect(rules.length).toBeGreaterThanOrEqual(1);
    const decision = rules.find((r) => r.type === 'decision');
    expect(decision).toBeDefined();
    expect(decision.content).toContain('Bun');
  });

  it('extracts a Korean preference rule', () => {
    const rules = extractRules('항상 TypeScript를 사용해라.');
    expect(rules.length).toBeGreaterThanOrEqual(1);
    const pref = rules.find((r) => r.type === 'preference');
    expect(pref).toBeDefined();
  });

  it('extracts a Korean prohibition rule', () => {
    const rules = extractRules('var를 사용하지 마라.');
    expect(rules.length).toBeGreaterThanOrEqual(1);
    const p = rules.find((r) => r.type === 'prohibition');
    expect(p).toBeDefined();
  });

  it('extracts a Korean decision rule', () => {
    const rules = extractRules('vitest를 쓰기로 했다.');
    expect(rules.length).toBeGreaterThanOrEqual(1);
    const d = rules.find((r) => r.type === 'decision');
    expect(d).toBeDefined();
  });

  // -- Multi-rule extraction --
  it('extracts multiple rules from a multi-sentence message', () => {
    const msg = [
      'Always use TypeScript.',
      "Don't use var.",
      'We decided to use vitest.',
    ].join('\n');

    const rules = extractRules(msg);
    expect(rules.length).toBeGreaterThanOrEqual(2);

    const types = new Set(rules.map((r) => r.type));
    expect(types.has('preference')).toBe(true);
    expect(types.has('prohibition')).toBe(true);
    expect(types.has('decision')).toBe(true);
  });

  it('extracts rules from mixed Korean and English message', () => {
    const msg = '항상 TypeScript를 사용해라. Never commit secrets.';
    const rules = extractRules(msg);
    const langs = rules.map((r) => r.lang);
    expect(langs).toContain('ko');
    expect(langs).toContain('en');
  });

  // -- Deduplication --
  it('deduplicates identical rules (same type + content)', () => {
    const msg = 'Always use TypeScript. Always use TypeScript.';
    const rules = extractRules(msg);
    const prefs = rules.filter((r) => r.type === 'preference');
    // Should not have two identical entries
    const contents = prefs.map((r) => r.content.toLowerCase().trim());
    const unique = new Set(contents);
    expect(unique.size).toBe(contents.length);
  });

  // -- Sort order --
  it('returns rules sorted by confidence descending', () => {
    const msg = [
      'Always use TypeScript.',
      'Use pnpm instead of npm.',
      "Don't use console.log.",
    ].join('\n');

    const rules = extractRules(msg);
    for (let i = 1; i < rules.length; i++) {
      expect(rules[i - 1].confidence).toBeGreaterThanOrEqual(rules[i].confidence);
    }
  });

  // -- Rule structure --
  it('every extracted rule has all required fields', () => {
    const rules = extractRules('Always use TypeScript. Never use var.');
    for (const rule of rules) {
      expect(rule).toMatchObject({
        type: expect.any(String),
        content: expect.any(String),
        confidence: expect.any(Number),
        source: 'conversation',
        lang: expect.any(String),
        extractedAt: expect.any(String),
        rawMatch: expect.any(String),
      });
      expect(rule.confidence).toBeGreaterThan(0);
      expect(rule.confidence).toBeLessThanOrEqual(1);
    }
  });

  // -- Edge cases --
  it('handles message with only whitespace', () => {
    expect(extractRules('   \n\t  ')).toEqual([]);
  });

  it('handles very long message', () => {
    const filler = 'Some random text here. '.repeat(50);
    const msg = filler + 'Always use TypeScript.';
    const rules = extractRules(msg);
    const pref = rules.find((r) => r.type === 'preference');
    expect(pref).toBeDefined();
  });

  it('handles message with only punctuation', () => {
    expect(extractRules('... !!! ???')).toEqual([]);
  });

  it('is case-insensitive for English patterns', () => {
    const upper = extractRules('ALWAYS USE TYPESCRIPT.');
    const lower = extractRules('always use typescript.');
    // Both should detect a preference
    expect(upper.some((r) => r.type === 'preference')).toBe(true);
    expect(lower.some((r) => r.type === 'preference')).toBe(true);
  });
});
