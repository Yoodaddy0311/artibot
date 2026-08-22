import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T2 — auto-team decision-owner unification
 * (PRD docs/PRD/command-improvement-verified-20260822.md §파동2-8).
 *
 * Before T2 there were TWO evaluators for the same config keys:
 *   - `scripts/hooks/auto-team-trigger.js#evaluatePrompt` (hook-local)
 *   - `lib/cognitive/workflow-plan.js#evaluateTrigger`    (canonical)
 * and a comment in the hook claimed they "never disagree". They disagreed on
 * four axes. After T2 the hook only ADAPTS + RENDERS the canonical decision.
 *
 * Each divergence test below is an A/B: the canonical path is exercised through
 * the real `handleUserPromptSubmit`, and the preserved pre-T2 evaluator
 * (`legacyEvaluatePrompt`, kept behind the one-line rollback toggle) is called
 * directly on the SAME prompt + SAME triggers. Asserting only the new behavior
 * would be a tautology — asserting that the old evaluator produces the OPPOSITE
 * result is what proves the test is aimed at a real divergence.
 *
 * Plus an ABSOLUTE EMISSION FLOOR (PRD 위험 ③): "disagreement 0" is a hollow
 * gate because a hook that emits nothing at all also has zero disagreements.
 * The floor asserts a representative corpus still fires under the REAL shipped
 * artibot.config.json thresholds, and that a missing/failed canonical decision
 * is loud (stderr WARN), not silent.
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

/** The REAL shipped config — the emission floor must protect what ships. */
const SHIPPED_CONFIG_RAW = await readFile(
  new URL('../../artibot.config.json', import.meta.url),
  'utf-8',
);
const SHIPPED_TRIGGERS = JSON.parse(SHIPPED_CONFIG_RAW).team.autoApplyTriggers;

const HOOK_SRC = await readFile(
  new URL('../../scripts/hooks/auto-team-trigger.js', import.meta.url),
  'utf-8',
);

let stderrSpy;
let hook;

/** Point the mocked fs at a synthetic artibot.config.json body. */
function stubConfig(raw) {
  mockState.existsSyncResults = { 'artibot.config.json': true };
  mockState.readFileSyncImpl = (p) => {
    if (String(p).includes('artibot.config.json')) return raw;
    throw new Error('ENOENT');
  };
}

/** Shorthand: enabled team with the given autoApplyTriggers. */
function stubTriggers(triggers) {
  stubConfig(JSON.stringify({ team: { autoApply: true, autoApplyTriggers: triggers } }));
}

beforeEach(async () => {
  vi.resetModules();
  mockState.existsSyncResults = {};
  mockState.readFileSyncImpl = () => { throw new Error('ENOENT'); };
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  hook = await import('../../scripts/hooks/auto-team-trigger.js');
});

afterEach(() => {
  stderrSpy.mockRestore();
  vi.clearAllMocks();
});

/** @returns {boolean} did the hook emit an auto-team suggestion? */
function fires(prompt) {
  const result = hook.handleUserPromptSubmit({ user_prompt: prompt });
  if (result === null) return false;
  expect(result.hookSpecificOutput.additionalContext).toContain('[auto-team-suggested]');
  return true;
}

describe('T2 divergence #1 — minComplexity was loaded but never compared', () => {
  // Thresholds put the size signal permanently out of reach, so the ONLY thing
  // that can fire the trigger is the configured complexity tier.
  const TRIGGERS = { minSubtasks: 99, minFiles: 99, minComplexity: 'medium' };
  // 2 domains (backend+frontend), 1 conjunction, no complexity KEYWORD
  // -> medium tier, which the config accepts.
  const PROMPT = 'update the server endpoint and the react component styling here';

  it('canonical: a medium-tier prompt fires when minComplexity=medium', () => {
    stubTriggers(TRIGGERS);
    expect(fires(PROMPT)).toBe(true);
  });

  it('negative control: the pre-T2 evaluator does NOT fire (it ignored minComplexity)', () => {
    // The old code only ever asked "does a complexity KEYWORD appear?" — it
    // never compared against the configured tier, so lowering minComplexity
    // had no effect whatsoever.
    expect(hook.legacyEvaluatePrompt(PROMPT, TRIGGERS)).toBeNull();
  });
});

describe('T2 divergence #2 — bypassIntents had zero references in the hook', () => {
  const TRIGGERS = {
    minSubtasks: 3, minFiles: 3, minComplexity: 'high', bypassIntents: ['explain'],
  };
  // Complexity keywords present (전체/시스템/아키텍처) AND an explain intent (설명).
  const PROMPT = '백엔드와 프론트엔드 전체 시스템 아키텍처를 자세히 설명해줘';

  it('canonical: an explain-intent prompt is bypassed even with high complexity', () => {
    stubTriggers(TRIGGERS);
    expect(fires(PROMPT)).toBe(false);
  });

  it('negative control: the pre-T2 evaluator fires (bypassIntents unreferenced)', () => {
    expect(hook.legacyEvaluatePrompt(PROMPT, TRIGGERS)).toContain('complexity');
  });

  it('bypass is config-driven, not hard-coded: same prompt fires with bypassIntents=[]', () => {
    stubTriggers({ ...TRIGGERS, bypassIntents: [] });
    expect(fires(PROMPT)).toBe(true);
  });
});

describe('T2 divergence #3 — logic was always OR in the hook', () => {
  const TRIGGERS = { logic: 'AND', minSubtasks: 2, minFiles: 2, minComplexity: 'high' };
  // Size signal met (2 domains / 2 subtasks), complexity signal NOT met.
  const PROMPT = 'update the server endpoint and the react component styling here';

  it('canonical: logic=AND withholds the trigger when only one signal is met', () => {
    stubTriggers(TRIGGERS);
    expect(fires(PROMPT)).toBe(false);
  });

  it('negative control: the pre-T2 evaluator fires (hard-coded OR)', () => {
    expect(hook.legacyEvaluatePrompt(PROMPT, TRIGGERS)).toContain('subtasks=2');
  });

  it('same triggers with logic=OR do fire — proving the AND path is the difference', () => {
    stubTriggers({ ...TRIGGERS, logic: 'OR' });
    expect(fires(PROMPT)).toBe(true);
  });
});

describe('T2 divergence #4 — minFiles was compared against a domain count', () => {
  // The canonical evaluator collapses minSubtasks/minFiles into ONE size
  // threshold at max(minSubtasks, minFiles) because both proxy off the same
  // sub-objective count. The pre-T2 hook treated minFiles as an INDEPENDENT
  // threshold against a *domain* count — same key, different unit. Setting
  // minSubtasks > minFiles makes the two readings disagree.
  const TRIGGERS = { minSubtasks: 6, minFiles: 2, minComplexity: 'high' };
  // 4 domains (auth+backend+frontend+test), 2 subtasks, no complexity keyword.
  const PROMPT = 'update the login endpoint and the react component test';

  it('canonical: size threshold is max(minSubtasks,minFiles)=6 > proxy 4 -> no fire', () => {
    stubTriggers(TRIGGERS);
    expect(fires(PROMPT)).toBe(false);
  });

  it('negative control: the pre-T2 evaluator fires on domainCount>=minFiles', () => {
    const reason = hook.legacyEvaluatePrompt(PROMPT, TRIGGERS);
    expect(reason).toContain('domains=[');
    expect(reason).not.toContain('subtasks=');
  });

  it('raising minFiles to 6 as well leaves the canonical decision unchanged', () => {
    // Confirms the canonical reading really is max(): 6/6 == 6/2 here.
    stubTriggers({ ...TRIGGERS, minFiles: 6 });
    expect(fires(PROMPT)).toBe(false);
  });
});

describe('T2 — absolute emission floor (PRD 위험 ③)', () => {
  /**
   * Prompts chosen as "a user would obviously want parallel teammates here":
   * multi-domain and/or explicitly system-wide. Four fire via the complexity
   * path and three via the size path, so neither path can silently go dead.
   */
  const MUST_FIRE = [
    '프론트와 백엔드 시스템을 마이그레이션하고 테스트도 추가해줘',
    'Refactor the auth module, migrate the database schema, and update the api routes',
    '결제 서버 아키텍처를 재설계하고 프론트 컴포넌트도 새로 만들어줘',
    'Add jwt auth to the backend, write integration tests for it, and update the react ui',
    '전체 시스템 리팩토링하고 문서도 갱신해줘',
    'Build the graphql api layer, add the prisma schema, and wire the svelte frontend',
    '인증 훅을 새로 만들고 백엔드 라우트도 정리하고 테스트 커버리지도 올려줘',
  ];

  it('fires on MORE THAN ZERO representative prompts under the shipped config', () => {
    stubConfig(SHIPPED_CONFIG_RAW);
    const fired = MUST_FIRE.filter((p) => fires(p));
    // The floor proper: a hook that emits nothing trivially has "0
    // disagreements" with the canonical evaluator, so agreement alone can
    // never be the acceptance criterion.
    expect(fired.length).toBeGreaterThan(0);
    expect(fired.length).toBe(MUST_FIRE.length);
  });

  it.each(MUST_FIRE)('fires for: %s', (prompt) => {
    stubConfig(SHIPPED_CONFIG_RAW);
    expect(fires(prompt)).toBe(true);
  });

  it('the shipped config still carries the keys the canonical evaluator reads', () => {
    // Guards the floor from the other side: if these keys were dropped from
    // the shipped config the corpus would still fire (canonical defaults), and
    // the divergence tests above would stop describing production.
    expect(SHIPPED_TRIGGERS).toMatchObject({
      logic: expect.any(String),
      minSubtasks: expect.any(Number),
      minFiles: expect.any(Number),
      minComplexity: expect.any(String),
      bypassIntents: expect.any(Array),
    });
  });

  it('still suppresses a trivial single-domain prompt (floor is not "always fire")', () => {
    stubConfig(SHIPPED_CONFIG_RAW);
    expect(fires('fix typo')).toBe(false);
  });
});

describe('T2 — no canonical decision is loud, not silent', () => {
  /**
   * plan-critic I5: stderr is this hook's ONLY operator signal. A failed or
   * absent workflow-plan decision must not throw (it would block the user's
   * prompt) and must not exit quietly (nobody would ever learn the auto-team
   * trigger had stopped working).
   */
  async function importHookWith(evaluateTriggerImpl) {
    vi.resetModules();
    vi.doMock('../../lib/cognitive/workflow-plan.js', () => ({
      evaluateTrigger: evaluateTriggerImpl,
    }));
    return import('../../scripts/hooks/auto-team-trigger.js');
  }

  afterEach(() => {
    vi.doUnmock('../../lib/cognitive/workflow-plan.js');
  });

  const PROMPT = '프론트와 백엔드 시스템을 마이그레이션하고 테스트도 추가해줘';

  it('returns null and WARNs when workflow-plan yields no decision object', async () => {
    const mod = await importHookWith(() => undefined);
    stubConfig(SHIPPED_CONFIG_RAW);

    const result = mod.handleUserPromptSubmit({ user_prompt: PROMPT });

    expect(result).toBeNull();
    const stderr = stderrSpy.mock.calls.map(([m]) => m).join('');
    expect(stderr).toMatch(/returned no decision/);
  });

  it('returns null and WARNs (does not throw) when workflow-plan throws', async () => {
    const mod = await importHookWith(() => { throw new Error('boom'); });
    stubConfig(SHIPPED_CONFIG_RAW);

    let result;
    expect(() => { result = mod.handleUserPromptSubmit({ user_prompt: PROMPT }); }).not.toThrow();
    expect(result).toBeNull();
    const stderr = stderrSpy.mock.calls.map(([m]) => m).join('');
    expect(stderr).toMatch(/canonical evaluator threw \(boom\)/);
  });

  it('the pre-existing malformed-config WARN is preserved', async () => {
    // Regression guard for the instruction "keep the existing stderr WARN":
    // the new failure paths must not have displaced the old one.
    stubConfig('{ "team": { broken');
    const result = hook.handleUserPromptSubmit({ user_prompt: PROMPT });
    expect(result).toBeNull();
    const stderr = stderrSpy.mock.calls.map(([m]) => m).join('');
    expect(stderr).toMatch(/WARN: malformed config/);
  });
});

describe('T2 — decision-owner anti-drift (source-level)', () => {
  it('the hook statically imports the canonical evaluator', () => {
    // Static, not `await import(...)`: this hook is on the UserPromptSubmit
    // hot path, so resolution cost is paid once per process, not per prompt.
    expect(HOOK_SRC).toMatch(
      /^import \{ evaluateTrigger \} from '\.\.\/\.\.\/lib\/cognitive\/workflow-plan\.js';$/m,
    );
    expect(HOOK_SRC).not.toMatch(/await import\([^)]*workflow-plan/);
  });

  it('the false "never disagree" guarantee comment is gone', () => {
    expect(HOOK_SRC).not.toMatch(/never disagree/);
  });

  it('the rollback toggle exists and ships disabled', () => {
    expect(HOOK_SRC).toMatch(/const USE_LEGACY_TRIGGER_EVALUATOR = false;/);
  });
});
