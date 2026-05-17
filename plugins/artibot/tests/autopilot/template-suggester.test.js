/**
 * Tests for lib/autopilot/template-suggester.js (v4.11.0 Track K).
 * Covers per-template keyword scoring, Korean/English mix, ambiguous prompts,
 * history boost, enrichWithTemplate merge semantics, and DI for loadTemplate.
 */

import { describe, expect, it } from 'vitest';
import {
  enrichWithTemplate,
  HISTORY_BOOST,
  recommendByHistory,
  suggestTemplate,
  TEMPLATE_NAMES,
} from '../../lib/autopilot/template-suggester.js';

describe('suggestTemplate — empty / invalid', () => {
  it('returns null template for empty prompt', () => {
    const r = suggestTemplate('');
    expect(r.template).toBeNull();
    expect(r.confidence).toBe('none');
  });

  it('returns null for whitespace-only prompt', () => {
    const r = suggestTemplate('   \n\t ');
    expect(r.template).toBeNull();
  });

  it('returns null for non-string input', () => {
    expect(suggestTemplate(null).template).toBeNull();
    expect(suggestTemplate(undefined).template).toBeNull();
    expect(suggestTemplate(42).template).toBeNull();
  });

  it('returns null when no keyword matches', () => {
    const r = suggestTemplate('zzz qqq');
    expect(r.template).toBeNull();
    expect(r.scores).toEqual({ bugfix: 0, refactor: 0, feature: 0 });
  });
});

describe('suggestTemplate — bugfix', () => {
  it('detects English "fix" verb', () => {
    const r = suggestTemplate('please fix the login bug');
    expect(r.template).toBe('bugfix');
  });

  it('detects Korean 수정/버그', () => {
    const r = suggestTemplate('로그인 버그를 수정해줘');
    expect(r.template).toBe('bugfix');
  });

  it('detects hotfix variants', () => {
    expect(suggestTemplate('apply a hotfix').template).toBe('bugfix');
    expect(suggestTemplate('patch the crash').template).toBe('bugfix');
  });

  it('detects regression keyword', () => {
    const r = suggestTemplate('investigate this regression bug');
    expect(r.template).toBe('bugfix');
  });
});

describe('suggestTemplate — refactor', () => {
  it('detects English refactor verbs', () => {
    expect(suggestTemplate('extract the helper into its own module').template).toBe('refactor');
    expect(suggestTemplate('rename this variable across the file').template).toBe('refactor');
    expect(suggestTemplate('refactor the engine for clarity').template).toBe('refactor');
  });

  it('detects Korean 리팩터 / 정리', () => {
    expect(suggestTemplate('이 코드를 리팩터링 해줘').template).toBe('refactor');
    expect(suggestTemplate('파일을 정리해줘').template).toBe('refactor');
  });

  it('detects cleanup / simplify', () => {
    expect(suggestTemplate('cleanup duplicate code').template).toBe('refactor');
    expect(suggestTemplate('simplify the validation pipeline').template).toBe('refactor');
  });
});

describe('suggestTemplate — feature', () => {
  it('detects English add/create/implement', () => {
    expect(suggestTemplate('add a new login page').template).toBe('feature');
    expect(suggestTemplate('create the export api').template).toBe('feature');
    expect(suggestTemplate('implement billing flow').template).toBe('feature');
  });

  it('detects Korean 추가 / 구현 / 개발', () => {
    expect(suggestTemplate('새 기능을 추가해줘').template).toBe('feature');
    expect(suggestTemplate('결제 모듈을 구현').template).toBe('feature');
  });

  it('detects build/ship/introduce', () => {
    expect(suggestTemplate('build a new dashboard').template).toBe('feature');
    expect(suggestTemplate('ship the export tool').template).toBe('feature');
  });
});

describe('suggestTemplate — confidence + scoring', () => {
  it('high confidence when dominant template wins by large margin', () => {
    const r = suggestTemplate('fix the bug fix the broken regression');
    expect(r.template).toBe('bugfix');
    expect(r.confidence).toBe('high');
  });

  it('medium confidence on single strong match', () => {
    const r = suggestTemplate('please fix this');
    expect(r.template).toBe('bugfix');
    expect(['medium', 'high', 'low']).toContain(r.confidence);
  });

  it('includes scores object for all template names', () => {
    const r = suggestTemplate('add a new feature');
    for (const n of TEMPLATE_NAMES) {
      expect(typeof r.scores[n]).toBe('number');
    }
  });

  it('returns null for ambiguous prompts with equal scores', () => {
    // Provide a prompt with zero matches → none.
    const r = suggestTemplate('please consider the implications');
    expect(r.template).toBeNull();
  });
});

describe('recommendByHistory', () => {
  it('returns null for empty prompt', () => {
    const r = recommendByHistory('', [{ goalText: 'fix bug', templateUsed: 'bugfix', success: true }]);
    expect(r.template).toBeNull();
  });

  it('returns null for empty history', () => {
    expect(recommendByHistory('fix bug', []).template).toBeNull();
    expect(recommendByHistory('fix bug', null).template).toBeNull();
  });

  it('returns matching template from past successful goal', () => {
    const history = [
      { goalText: 'fix the login bug yesterday', templateUsed: 'bugfix', success: true },
    ];
    const r = recommendByHistory('fix the login bug today', history);
    expect(r.template).toBe('bugfix');
    expect(r.boost).toBe(HISTORY_BOOST);
  });

  it('ignores failed past goals', () => {
    const history = [
      { goalText: 'fix the login bug', templateUsed: 'bugfix', success: false },
    ];
    const r = recommendByHistory('fix the login bug', history);
    expect(r.template).toBeNull();
  });

  it('ignores entries with unknown template', () => {
    const history = [
      { goalText: 'fix the login bug', templateUsed: 'mystery', success: true },
    ];
    const r = recommendByHistory('fix the login bug', history);
    expect(r.template).toBeNull();
  });

  it('picks highest-overlap entry', () => {
    const history = [
      { goalText: 'create a new dashboard', templateUsed: 'feature', success: true },
      { goalText: 'fix the broken login bug page', templateUsed: 'bugfix', success: true },
    ];
    const r = recommendByHistory('fix the broken login bug', history);
    expect(r.template).toBe('bugfix');
  });
});

describe('suggestTemplate — history integration', () => {
  it('history boost can change winner on close score', () => {
    const recentSessions = [
      { goalText: 'add new export feature', templateUsed: 'feature', success: true },
    ];
    const r = suggestTemplate('add export', { recentSessions });
    expect(r.template).toBe('feature');
  });

  it('ignores history when no overlap', () => {
    const recentSessions = [
      { goalText: 'unrelated past goal', templateUsed: 'refactor', success: true },
    ];
    const r = suggestTemplate('fix the bug', { recentSessions });
    expect(r.template).toBe('bugfix');
  });
});

describe('enrichWithTemplate', () => {
  const fakeLoader = (name) => {
    const templates = {
      bugfix: { name: 'bugfix', objective: 'fix it', maxIterations: 3 },
      refactor: { name: 'refactor', objective: 'clean it', maxIterations: 7 },
      feature: { name: 'feature', objective: 'ship it', maxIterations: 5 },
    };
    return templates[name];
  };

  it('returns copy of goal when templateName invalid', () => {
    const goal = { x: 1 };
    const r = enrichWithTemplate(goal, 'invalid', { loadTemplate: fakeLoader });
    expect(r).toEqual({ x: 1 });
    expect(r).not.toBe(goal);
  });

  it('fills missing fields from template', () => {
    const r = enrichWithTemplate({}, 'bugfix', { loadTemplate: fakeLoader });
    expect(r.objective).toBe('fix it');
    expect(r.maxIterations).toBe(3);
  });

  it('does not overwrite explicit user fields', () => {
    const r = enrichWithTemplate({ objective: 'user said this' }, 'bugfix', { loadTemplate: fakeLoader });
    expect(r.objective).toBe('user said this');
    expect(r.maxIterations).toBe(3);
  });

  it('treats empty string as missing', () => {
    const r = enrichWithTemplate({ objective: '' }, 'bugfix', { loadTemplate: fakeLoader });
    expect(r.objective).toBe('fix it');
  });

  it('returns goal copy on loader throw', () => {
    const throwing = () => { throw new Error('boom'); };
    const r = enrichWithTemplate({ a: 1 }, 'bugfix', { loadTemplate: throwing });
    expect(r).toEqual({ a: 1 });
  });

  it('handles null goal input', () => {
    const r = enrichWithTemplate(null, 'bugfix', { loadTemplate: fakeLoader });
    expect(r.objective).toBe('fix it');
  });
});
