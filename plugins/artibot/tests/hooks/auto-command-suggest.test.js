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

// Each ADR positive case represents a real-world phrasing a non-developer
// or beginner might type. A regression here means /adr is silently NOT
// suggested and the user gets ad-hoc tech advice instead of a structured
// 7-section ADR with hidden costs and 2-year debt analysis.
describe('classifyCommandIntent — ADR positives (≥ 8 cases)', () => {
  it('matches "PostgreSQL vs MongoDB"', () => {
    // Blocks: classic A vs B comparison going unrecognised.
    const r = classifyCommandIntent('PostgreSQL vs MongoDB for our analytics workload');
    expect(r?.command).toBe('adr');
  });

  it('matches Korean "X 와 Y 중에" pattern', () => {
    // Blocks: Korean comparative form unrecognised.
    const r = classifyCommandIntent('Redis 와 Memcached 중에 뭐가 좋을까');
    expect(r?.command).toBe('adr');
  });

  it('matches "라이브러리 선택" keyword', () => {
    // Blocks: library-choice keyword missed.
    const r = classifyCommandIntent('차트 라이브러리 선택 좀 도와줘');
    expect(r?.command).toBe('adr');
  });

  it('matches English "should I use X or Y"', () => {
    // Blocks: English "should I" question form missed.
    const r = classifyCommandIntent('should I use Postgres or MySQL for this');
    expect(r?.command).toBe('adr');
  });

  it('matches "어떤 게 좋아 / 좋을까" question form', () => {
    // Blocks: Korean open-ended "which is better" missed.
    const r = classifyCommandIntent('어떤 디비를 쓰는 게 좋을까요');
    expect(r?.command).toBe('adr');
  });

  it('matches "스택 결정" / "stack decision" keyword', () => {
    // Blocks: explicit stack-decision keyword missed.
    const r = classifyCommandIntent('백엔드 스택 결정 도와줘 — Node 쓸까 Go 쓸까');
    expect(r?.command).toBe('adr');
  });

  it('matches "which is better" English form', () => {
    // Blocks: bilingual "which is better" missed.
    const r = classifyCommandIntent('which is better for state management Zustand or Redux');
    expect(r?.command).toBe('adr');
  });

  it('matches "어떤 프레임워크" question form', () => {
    // Blocks: framework-choice phrasing missed.
    const r = classifyCommandIntent('어떤 프레임워크가 좋을지 골라줘');
    expect(r?.command).toBe('adr');
  });

  it('matches "choose between" English form', () => {
    // Blocks: explicit choose-between phrasing missed.
    const r = classifyCommandIntent('help me choose between Kafka and RabbitMQ');
    expect(r?.command).toBe('adr');
  });
});

// Each Migrate positive is a phrasing that commits the user to production
// risk if missed. /migrate loads the zero-downtime checklist with backup,
// rollback, and comms plans — silently skipping it can land a customer-
// facing outage. False-negatives here are the highest-cost class of bug.
describe('classifyCommandIntent — Migrate positives (≥ 8 cases)', () => {
  it('matches Korean "마이그레이션" noun', () => {
    // Blocks: explicit migration noun unrecognised.
    const r = classifyCommandIntent('인증 시스템 마이그레이션 계획 짜줘');
    expect(r?.command).toBe('migrate');
  });

  it('matches "X 에서 Y 로 이전" pattern', () => {
    // Blocks: Korean transition phrasing missed.
    const r = classifyCommandIntent('MySQL 에서 PostgreSQL 로 이전하려고 해');
    expect(r?.command).toBe('migrate');
  });

  it('matches English "migrate from X to Y"', () => {
    // Blocks: classic English migrate-from phrasing missed.
    const r = classifyCommandIntent('migrate from Redis to Memcached safely');
    expect(r?.command).toBe('migrate');
  });

  it('matches "zero-downtime rollout"', () => {
    // Blocks: zero-downtime keyword missed — high-stakes flag.
    const r = classifyCommandIntent('plan a zero-downtime rollout for the new API');
    expect(r?.command).toBe('migrate');
  });

  it('matches "무중단 전환"', () => {
    // Blocks: Korean zero-downtime phrasing missed.
    const r = classifyCommandIntent('무중단 전환 계획이 필요해');
    expect(r?.command).toBe('migrate');
  });

  it('matches "X → Y 이전" arrow notation', () => {
    // Blocks: arrow-notation migration missed.
    const r = classifyCommandIntent('MySQL → PostgreSQL 이전 작업 정리');
    expect(r?.command).toBe('migrate');
  });

  it('matches Korean version-upgrade migration', () => {
    // Blocks: runtime upgrade (huge blast radius) missed.
    const r = classifyCommandIntent('Node 18에서 22로 업그레이드 마이그레이션');
    expect(r?.command).toBe('migrate');
  });

  it('matches English "switch from X to Y"', () => {
    // Blocks: English switch-from phrasing missed.
    const r = classifyCommandIntent('switch from Stripe to Toss Payments');
    expect(r?.command).toBe('migrate');
  });

  it('matches "rollout plan" English keyword', () => {
    // Blocks: rollout-plan English keyword missed.
    const r = classifyCommandIntent('we need a rollout plan for the new payment service');
    expect(r?.command).toBe('migrate');
  });
});

// Each negative case contains a literal "vs", "선택", "이동" or "옮기" token
// that a naive matcher would trip on. A false-positive here = the wrong
// command is suggested, which is worse than no suggestion: /migrate would
// frame a mundane file move as a production cutover, /adr would generate a
// full ADR for a casual UI question.
describe('classifyCommandIntent — Migrate false-positive suppression (≥ 5 cases)', () => {
  it('does NOT match "디렉토리 이동"', () => {
    // Blocks: filesystem dir-move misread as system migration.
    expect(classifyCommandIntent('src 디렉토리를 lib 로 이동시켜줘')).toBeNull();
  });

  it('does NOT match "VS Code 설치"', () => {
    // Blocks: editor install misread as migration.
    expect(classifyCommandIntent('VS Code 설치 도와줘')).toBeNull();
  });

  it('does NOT match "파일 이동"', () => {
    // Blocks: file move misread as data migration.
    expect(classifyCommandIntent('이 파일을 다른 폴더로 이동')).toBeNull();
  });

  it('does NOT match "cursor 이동"', () => {
    // Blocks: UI cursor movement misread as migration.
    expect(classifyCommandIntent('cursor 를 다음 줄로 이동')).toBeNull();
  });

  it('does NOT match "git branch switch"', () => {
    // Blocks: git workflow misread as system switch.
    expect(classifyCommandIntent('git branch switch 어떻게 해')).toBeNull();
  });

  it('does NOT match "다음 페이지로 이동"', () => {
    // Blocks: UI navigation misread as migration.
    expect(classifyCommandIntent('다음 페이지로 이동 어떻게 처리')).toBeNull();
  });
});

// ADR-specific false-positives: phrases with "vs"/"선택"/"choice" tokens that
// have nothing to do with technology decisions.
describe('classifyCommandIntent — ADR false-positive suppression (≥ 5 cases)', () => {
  it('does NOT match "git diff vs ..."', () => {
    // Blocks: git tooling question misread as ADR.
    expect(classifyCommandIntent('git diff vs git log 차이 뭐야')).toBeNull();
  });

  it('does NOT match "파일 선택 다이얼로그"', () => {
    // Blocks: file picker UI question misread as ADR.
    expect(classifyCommandIntent('파일 선택 다이얼로그 어떻게 구현해')).toBeNull();
  });

  it('does NOT match "다중 선택 컴포넌트"', () => {
    // Blocks: multi-select widget question misread as ADR.
    expect(classifyCommandIntent('다중 선택 컴포넌트 만들어줘')).toBeNull();
  });

  it('does NOT match trivially short "a vs b" noise', () => {
    // Blocks: single-char token noise (the \S{2,} floor must hold).
    expect(classifyCommandIntent('a vs b')).toBeNull();
  });

  it('does NOT match "commit vs the previous one"', () => {
    // Blocks: git history question misread as ADR.
    expect(classifyCommandIntent('commit vs the previous one — diff 보여줘')).toBeNull();
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

// The hook MUST only suggest, never act. Auto-execution of /migrate would
// frame a user's question as a committed cutover; auto-execution of /adr
// would generate a full 7-section document for casual comparisons. The hook
// contract is "advisory only via additionalContext".
describe('handleUserPromptSubmit — output envelope (suggest-only, never auto-execute)', () => {
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

  it('explicitly forbids auto-execution in the advisory text (ADR)', () => {
    // Blocks: regression where the hook stops emitting the "do not auto-run"
    // guard line and the orchestrator misreads the advisory as a command.
    const r = handleUserPromptSubmit({
      user_prompt: 'PostgreSQL vs MongoDB for analytics',
    });
    expect(r.hookSpecificOutput.additionalContext).toMatch(/자동 실행 금지|동의 없이/);
  });

  it('explicitly forbids auto-execution in the advisory text (Migrate)', () => {
    // Blocks: Migrate-side regression where the auto-execution guard is dropped.
    const r = handleUserPromptSubmit({
      user_prompt: 'MySQL에서 Postgres로 마이그레이션 계획',
    });
    expect(r.hookSpecificOutput.additionalContext).toMatch(/자동 실행 금지|동의 없이/);
  });

  it('never returns a tool_call / command field at the top level', () => {
    // Blocks: hook accidentally returning a tool-invocation shape that the
    // dispatcher could interpret as an immediate command run.
    const r = handleUserPromptSubmit({
      user_prompt: 'PostgreSQL vs MongoDB',
    });
    expect(r).not.toHaveProperty('tool_call');
    expect(r).not.toHaveProperty('command');
    expect(r).not.toHaveProperty('toolUse');
  });

  it('returns null (no emit) for unrelated prompts', () => {
    // Blocks: hook emitting noise on every prompt.
    expect(handleUserPromptSubmit({ user_prompt: '오늘 날씨 어때?' })).toBeNull();
    expect(handleUserPromptSubmit({ user_prompt: 'print hello world' })).toBeNull();
  });
});

// Hook is invoked on every UserPromptSubmit. A throw here would cascade into
// a dispatcher error and block other hooks (auto-team, autopilot-nlu) from
// running. Robustness on degenerate payloads is mandatory.
describe('handleUserPromptSubmit — input edge cases', () => {
  it('returns null for whitespace-only prompt', () => {
    expect(handleUserPromptSubmit({ user_prompt: '   \n\t  ' })).toBeNull();
  });

  it('returns null for missing user_prompt key', () => {
    expect(handleUserPromptSubmit({})).toBeNull();
  });

  it('accepts `content` as an alias for user_prompt', () => {
    // Blocks: prompt arriving on the alternate `content` field being dropped.
    const r = handleUserPromptSubmit({ content: 'PostgreSQL vs MongoDB 비교' });
    expect(r).not.toBeNull();
    expect(r.hookSpecificOutput.additionalContext).toContain('/adr');
  });

  it('classifyCommandIntent returns null for non-string input', () => {
    // Blocks: hook crashing on weird payload types that other hooks emit.
    expect(classifyCommandIntent(null)).toBeNull();
    expect(classifyCommandIntent(undefined)).toBeNull();
    expect(classifyCommandIntent(42)).toBeNull();
    expect(classifyCommandIntent({})).toBeNull();
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
