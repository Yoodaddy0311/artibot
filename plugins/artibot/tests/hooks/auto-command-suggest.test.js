import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * auto-command-suggest.js — UserPromptSubmit hook that detects natural-language
 * ADR ("A vs B") and Migrate ("X 에서 Y 로") intent and injects a
 * `[command-suggested]` advisory into additionalContext.
 *
 * Tests cover:
 *   - Pattern classification: positives (KR + EN), negatives (innocuous moves),
 *     and tie-breaking (migrate > adr when both could match).
 *   - Opt-out: --no-command-suggest, --no-team, team.autoApply=false,
 *     commandSuggest.enabled=false.
 *   - Fail-closed: malformed artibot.config.json returns null + WARN.
 */

const mockState = {
  existsSyncResults: {},
  readFileSyncImpl: () => { throw new Error('ENOENT'); },
};

vi.mock('../../scripts/utils/index.js', () => ({
  readStdin: vi.fn(),
  parseJSON: vi.fn((str) => {
    try { return JSON.parse(str); }
    catch { return null; }
  }),
  writeStdout: vi.fn(),
  getPluginRoot: vi.fn(() => '/plugin/root'),
}));

vi.mock('../../lib/core/hook-utils.js', () => ({
  createErrorHandler: vi.fn(() => () => {}),
  logHookError: vi.fn(),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs');
  return {
    ...actual,
    existsSync: vi.fn((p) => {
      for (const [key, val] of Object.entries(mockState.existsSyncResults)) {
        if (String(p).includes(key)) return val;
      }
      return false;
    }),
    readFileSync: vi.fn((...args) => mockState.readFileSyncImpl(...args)),
  };
});

let stderrSpy;
let handleUserPromptSubmit;
let classifyCommandIntent;

beforeEach(async () => {
  vi.resetModules();
  mockState.existsSyncResults = {};
  mockState.readFileSyncImpl = () => { throw new Error('ENOENT'); };
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  ({ handleUserPromptSubmit, classifyCommandIntent } =
    await import('../../scripts/hooks/auto-command-suggest.js'));
});

afterEach(() => {
  stderrSpy.mockRestore();
  vi.clearAllMocks();
});

describe('classifyCommandIntent — ADR positives', () => {
  it('matches "PostgreSQL vs MongoDB"', () => {
    const r = classifyCommandIntent('PostgreSQL vs MongoDB for our analytics workload');
    expect(r?.command).toBe('adr');
  });

  it('matches Korean "X 와 Y 중에" pattern', () => {
    const r = classifyCommandIntent('Redis 와 Memcached 중에 뭐가 좋을까');
    expect(r?.command).toBe('adr');
  });

  it('matches "라이브러리 선택" keyword', () => {
    const r = classifyCommandIntent('차트 라이브러리 선택 좀 도와줘');
    expect(r?.command).toBe('adr');
  });

  it('matches English "should I use X or Y"', () => {
    const r = classifyCommandIntent('should I use Postgres or MySQL for this');
    expect(r?.command).toBe('adr');
  });

  it('matches "어떤 게 좋아 / 좋을까" question form', () => {
    const r = classifyCommandIntent('어떤 디비를 쓰는 게 좋을까요');
    expect(r?.command).toBe('adr');
  });
});

describe('classifyCommandIntent — Migrate positives', () => {
  it('matches Korean "마이그레이션" noun', () => {
    const r = classifyCommandIntent('인증 시스템 마이그레이션 계획 짜줘');
    expect(r?.command).toBe('migrate');
  });

  it('matches "X 에서 Y 로 이전" pattern', () => {
    const r = classifyCommandIntent('MySQL 에서 PostgreSQL 로 이전하려고 해');
    expect(r?.command).toBe('migrate');
  });

  it('matches English "migrate from X to Y"', () => {
    const r = classifyCommandIntent('migrate from Redis to Memcached safely');
    expect(r?.command).toBe('migrate');
  });

  it('matches "zero-downtime rollout"', () => {
    const r = classifyCommandIntent('plan a zero-downtime rollout for the new API');
    expect(r?.command).toBe('migrate');
  });

  it('matches "무중단 전환"', () => {
    const r = classifyCommandIntent('무중단 전환 계획이 필요해');
    expect(r?.command).toBe('migrate');
  });
});

describe('classifyCommandIntent — false-positive suppression', () => {
  it('does NOT match "디렉토리 이동"', () => {
    expect(classifyCommandIntent('src 디렉토리를 lib 로 이동시켜줘')).toBeNull();
  });

  it('does NOT match "VS Code 설치"', () => {
    expect(classifyCommandIntent('VS Code 설치 도와줘')).toBeNull();
  });

  it('does NOT match "파일 이동"', () => {
    expect(classifyCommandIntent('이 파일을 다른 폴더로 이동')).toBeNull();
  });

  it('does NOT match "git diff vs ..."', () => {
    expect(classifyCommandIntent('git diff vs git log 차이 뭐야')).toBeNull();
  });

  it('does NOT match "cursor 이동"', () => {
    expect(classifyCommandIntent('cursor 를 다음 줄로 이동')).toBeNull();
  });
});

describe('classifyCommandIntent — tie-breaking', () => {
  it('prefers migrate when both ADR + migrate signals are present', () => {
    // "PostgreSQL 에서 MongoDB 로 마이그" — vs-like wording + clear migrate verb
    const r = classifyCommandIntent('PostgreSQL 에서 MongoDB 로 마이그레이션 가능?');
    expect(r?.command).toBe('migrate');
  });
});

describe('handleUserPromptSubmit — opt-outs', () => {
  it('returns null on empty prompt', () => {
    expect(handleUserPromptSubmit({})).toBeNull();
  });

  it('returns null when --no-command-suggest is present', () => {
    expect(
      handleUserPromptSubmit({
        user_prompt: 'PostgreSQL vs MongoDB --no-command-suggest',
      }),
    ).toBeNull();
  });

  it('returns null when --no-team is present (umbrella opt-out)', () => {
    expect(
      handleUserPromptSubmit({
        user_prompt: 'PostgreSQL vs MongoDB --no-team',
      }),
    ).toBeNull();
  });

  it('returns null when team.autoApply=false in config', () => {
    mockState.existsSyncResults = { 'artibot.config.json': true };
    mockState.readFileSyncImpl = (p) => {
      if (String(p).includes('artibot.config.json')) {
        return JSON.stringify({ team: { autoApply: false } });
      }
      throw new Error('ENOENT');
    };
    expect(
      handleUserPromptSubmit({ user_prompt: 'PostgreSQL vs MongoDB' }),
    ).toBeNull();
  });

  it('returns null when commandSuggest.enabled=false in config', () => {
    mockState.existsSyncResults = { 'artibot.config.json': true };
    mockState.readFileSyncImpl = (p) => {
      if (String(p).includes('artibot.config.json')) {
        return JSON.stringify({ commandSuggest: { enabled: false } });
      }
      throw new Error('ENOENT');
    };
    expect(
      handleUserPromptSubmit({ user_prompt: 'PostgreSQL vs MongoDB' }),
    ).toBeNull();
  });
});

describe('handleUserPromptSubmit — output envelope', () => {
  it('emits hookSpecificOutput with [command-suggested] and /adr cmd', () => {
    const r = handleUserPromptSubmit({
      user_prompt: 'PostgreSQL vs MongoDB for analytics',
    });
    expect(r).not.toBeNull();
    expect(r.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    expect(r.hookSpecificOutput.additionalContext).toContain('[command-suggested]');
    expect(r.hookSpecificOutput.additionalContext).toContain('/adr');
  });

  it('emits hookSpecificOutput with /migrate cmd on migrate intent', () => {
    const r = handleUserPromptSubmit({
      user_prompt: 'Redis 에서 Memcached 로 이전 계획',
    });
    expect(r).not.toBeNull();
    expect(r.hookSpecificOutput.additionalContext).toContain('/migrate');
  });
});

describe('handleUserPromptSubmit — fail-closed on malformed config', () => {
  it('returns null (no emit) and warns on malformed JSON', () => {
    mockState.existsSyncResults = { 'artibot.config.json': true };
    mockState.readFileSyncImpl = (p) => {
      if (String(p).includes('artibot.config.json')) return '{ "team": { broken';
      throw new Error('ENOENT');
    };

    const result = handleUserPromptSubmit({
      user_prompt: 'PostgreSQL vs MongoDB',
    });

    expect(result).toBeNull();
    const stderr = stderrSpy.mock.calls.map(([m]) => m).join('');
    expect(stderr).toMatch(/WARN: malformed config/);
  });

  it('emits suggestion when config is missing (default enabled=true)', () => {
    mockState.existsSyncResults = { 'artibot.config.json': false };

    const result = handleUserPromptSubmit({
      user_prompt: 'PostgreSQL vs MongoDB for analytics',
    });

    expect(result).not.toBeNull();
    expect(result.hookSpecificOutput.additionalContext).toContain('[command-suggested]');
    const stderr = stderrSpy.mock.calls.map(([m]) => m).join('');
    expect(stderr).not.toMatch(/WARN: malformed config/);
  });
});
