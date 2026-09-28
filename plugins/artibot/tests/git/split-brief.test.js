/**
 * `lib/git/split-brief.js` — prompt rendering, contract extraction, model
 * policy text, brief materialisation.
 *
 * What this file cannot see (rules §9): whether a window actually reads the
 * materialised brief, and whether the leader actually sends the pointer.
 * Both are live observations (`status` / trailer).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_REQUIRED_SECTIONS,
  extractReportContract,
  materializeLimb,
  missingSections,
  PROMPT_PLACEHOLDERS,
  renderModelPolicy,
  renderPrompt,
  SIBLING_FILES,
} from '../../lib/git/split-brief.js';
import { buildLimbMessage } from '../../lib/git/split-dispatch.js';
import { loadConfig } from '../../lib/core/config.js';
import { resolveModel } from '../../lib/core/model-policy.js';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const readMd = (rel) => fs.readFileSync(path.join(PLUGIN_ROOT, rel), 'utf-8');

/** Same rule as `tests/commands/report-contract-parity.test.js#extractBlock`. */
function extractBlock(src, label) {
  const m = src.match(new RegExp('```\\r?\\n(\\[' + label + '\\][\\s\\S]*?)\\r?\\n```'));
  return m ? m[1].replace(/\r\n/g, '\n').trim() : null;
}

const tmpDirs = [];
const mkTmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'split-brief-'));
  tmpDirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const ALL_VARS = Object.freeze(Object.fromEntries(PROMPT_PLACEHOLDERS.map((k) => [k, `<${k.toLowerCase()}>`])));

describe('shipped PROMPT-TEMPLATE.md — 줄기 내부 팬아웃 절 (gotchas #16 · #21 · #24)', () => {
  // 2026-09-04 실측: 4창 중 3창이 팀원을 한 명도 띄우지 않고 혼자 일했다.
  // 템플릿이 팀원 스폰을 이름 규칙으로만 언급했기 때문이다.
  //
  // 이 절은 정적 텍스트여야 한다 — 새 {PLACEHOLDER} 를 만들면
  // lib/git/split-brief.js#PROMPT_PLACEHOLDERS 허용목록에 등록해야 하고,
  // 그순간 산문이 코드가 된다(미등록 플레이스홀더는 refuse 로 떨어진다).
  //
  // 이 테스트가 못 보는 것: 창이 실제로 팬아웃을 하는지. 그건 스폰 원장이
  // 답하며(scripts/split/fanout-probe.mjs), 문서는 필요조건일 뿐이다.
  const tpl = readMd('templates/split/PROMPT-TEMPLATE.md');

  it('팬아웃 절이 실재하고 렌더 결과에도 살아남는다', () => {
    expect(tpl).toContain('줄기 내부 팬아웃');
    const out = renderPrompt(tpl, ALL_VARS);
    expect(out).toContain('줄기 내부 팬아웃');
    expect(out).not.toMatch(/\{[A-Z][A-Z0-9_]*\}/);
  });

  it.each([
    ['분해 권장 단위', /분해 권장 단위/],
    ['창은 배정·검증·커밋만 (#16)', /배정·검증·커밋뿐이다/],
    ['모델은 resolveModel 이 정본', /resolveModel/],
    ['모델 ID 하드코딩 금지', /모델 ID 를 프롬프트에 하드코딩하지 않는다/],
    ['팀원 스폰에 보고 계약 삽입 (#24)', /\[보고 계약\] 8줄을 그대로 삽입/],
    ['스폰 원장이 관측점', /spawns\.ndjson/],
    ['계수 축은 start ∪ stop distinct', /start ∪ stop/],
    ['ref 조작 금지 (#21)', /branch -f \/ `-m` \/ `-D`|ref 조작 금지/],
  ])('팬아웃 절에 "%s" 규약이 있다', (_label, re) => {
    expect(tpl).toMatch(re);
  });

  it('새 플레이스홀더를 만들지 않았다 — 허용목록이 정본이다', () => {
    const used = new Set([...tpl.matchAll(/\{([A-Z][A-Z0-9_]*)\}/g)].map((m) => m[1]));
    for (const k of used) expect(PROMPT_PLACEHOLDERS, `\${k} \uac00 \ud5c8\uc6a9\ubaa9\ub85d \ubc16\uc774\ub2e4`).toContain(k);
  });
});
describe('renderPrompt', () => {
  it('substitutes every documented placeholder', () => {
    const template = PROMPT_PLACEHOLDERS.map((k) => `${k}={${k}}`).join('\n');
    const out = renderPrompt(template, ALL_VARS);
    for (const k of PROMPT_PLACEHOLDERS) expect(out).toContain(`${k}=<${k.toLowerCase()}>`);
    expect(out).not.toMatch(/\{[A-Z][A-Z0-9_]*\}/);
  });

  it('accepts numbers (BUDGET) and leaves non-ASCII braces such as {측정시각} alone', () => {
    const out = renderPrompt('b={BUDGET} t={측정시각} n={리더 이름}', { ...ALL_VARS, BUDGET: 600000 });
    expect(out).toBe('b=600000 t={측정시각} n={리더 이름}');
  });

  it('throws listing every unresolved placeholder (fail-closed)', () => {
    const rest = Object.fromEntries(Object.entries(ALL_VARS).filter(([k]) => k !== 'RUN' && k !== 'LIMB'));
    expect(() => renderPrompt('{RUN} {LIMB} {BRANCH} {LIMB}', rest)).toThrow(/unresolved placeholders: \{RUN\} \{LIMB\}$/);
  });

  it('throws on a placeholder the template invents', () => {
    expect(() => renderPrompt('{RUN} {NOT_A_KEY}', ALL_VARS)).toThrow(/\{NOT_A_KEY\}/);
  });

  it('throws on an unknown vars key (typo in the caller)', () => {
    expect(() => renderPrompt('{RUN}', { ...ALL_VARS, RUNN: 'x' })).toThrow(/unknown placeholder keys: RUNN/);
  });

  it('does not expand placeholders inside values, and rejects them as unresolved', () => {
    expect(() => renderPrompt('{RUN}', { ...ALL_VARS, RUN: 'run-{LIMB}' })).toThrow(/\{LIMB\}/);
  });

  it('is pure: same inputs, same output, inputs untouched', () => {
    const vars = { ...ALL_VARS };
    const snapshot = JSON.stringify(vars);
    const a = renderPrompt('{RUN}/{LIMB}', vars);
    const b = renderPrompt('{RUN}/{LIMB}', vars);
    expect(a).toBe(b);
    expect(JSON.stringify(vars)).toBe(snapshot);
  });

  it('rejects a non-string template', () => {
    expect(() => renderPrompt(null, ALL_VARS)).toThrow(TypeError);
  });
});

describe('extractReportContract', () => {
  const splitMd = readMd('commands/split.md');

  it('returns the [보고 계약] block from the real commands/split.md, CRLF-normalised', () => {
    const got = extractReportContract(splitMd);
    expect(got.startsWith('[보고 계약]')).toBe(true);
    expect(got).not.toContain('\r');
    expect(got).toBe(extractBlock(splitMd, '보고 계약'));
  });

  it('matches the team.md canonical block (parity gate inherited, not re-implemented)', () => {
    expect(extractReportContract(splitMd)).toBe(extractBlock(readMd('commands/team.md'), '보고 계약'));
  });

  it('works on CRLF input identically', () => {
    const crlf = splitMd.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
    expect(extractReportContract(crlf)).toBe(extractReportContract(splitMd));
  });

  it('throws when the block is absent', () => {
    expect(() => extractReportContract('# nothing here')).toThrow(/\[보고 계약\]/);
    expect(() => extractReportContract(undefined)).toThrow(/\[보고 계약\]/);
  });
});

describe('renderModelPolicy', () => {
  const AGENTS = ['tdd-guide', 'backend-developer', 'code-reviewer', 'architect'];

  it('prints what resolveModel returns for every representative agent (real config)', async () => {
    const config = await loadConfig();
    const out = renderModelPolicy(config);
    for (const a of AGENTS) expect(out).toContain(`${a}→${resolveModel(a, {}, config)}`);
    expect(out).toContain('resolveModel');
  });

  it('follows a changed policy — no tier is hardcoded', () => {
    const cfg = {
      agents: { modelPolicy: { high: { model: 'opus', agents: [] }, medium: { model: 'sonnet', agents: ['tdd-guide'] } } },
    };
    const out = renderModelPolicy(cfg);
    const expected = resolveModel('tdd-guide', {}, cfg);
    expect(out).toContain(`tdd-guide→${expected}`);
    expect(expected).not.toBe(resolveModel('code-reviewer', {}, cfg));
    expect(out).toContain(`code-reviewer→${resolveModel('code-reviewer', {}, cfg)}`);
  });

  it('source carries no model id or tier literal', () => {
    const src = fs.readFileSync(path.join(PLUGIN_ROOT, 'lib', 'git', 'split-brief.js'), 'utf-8');
    expect(src).not.toMatch(/claude-[a-z]+-\d/);
    expect(src).not.toMatch(/['"](fable|opus|sonnet|haiku)['"]/);
  });

  it('degrades to "(model policy 미해석)" when resolution throws', () => {
    const poison = new Proxy({}, { get() { throw new Error('boom'); } });
    expect(renderModelPolicy(poison)).toBe('(model policy 미해석)');
  });
});

describe('renderModelPolicy — effective values injected by the caller', () => {
  // 목표: dispatch 가 명시적으로 해석기를 넘길 때만 실효값(+override 출처)을 보인다.
  // 기본 경로는 사용자 파일을 읽지 않는다 — 창 프롬프트가 머신 상태에 의존하면 안 된다.
  //
  // 이 절이 못 보는 것: 주입된 해석기가 사용자 override 를 올바르게 계산하는지
  // (그건 해석기 소유 모듈의 테스트 몫), 그리고 dispatch 가 실제로 주입하는지.
  const FAILED = '(model policy 미해석)';
  const SHIPPED_HEADER = '[모델 운용 정책 — artibot.config.json#/agents/modelPolicy 를 resolveModel 로 해석한 값이다]';
  const TAIL = '- 창(터미널) 메인 세션 모델은 창이 못 바꾼다 — 오너가 그 터미널에서 /model 로 조정한다.';
  const row = (label, pairs) => `- ${label}: Agent 호출 시 model 을 명시한다 (${pairs})`;
  const BUILD = '구현·테스트·게이트 실행 서브에이전트';
  const REVIEW = '검수(교차 검수·최종 inspection)';
  const DESIGN = '설계(브리프·아키텍처)';

  /** Today's algorithm, verbatim — the oracle the no-injection path must keep matching. */
  const legacyRender = (config) => {
    try {
      const rows = [
        [BUILD, ['tdd-guide', 'backend-developer']],
        [REVIEW, ['code-reviewer']],
        [DESIGN, ['architect']],
      ].map(([label, agents]) => row(label, agents.map((a) => {
        const tier = resolveModel(a, {}, config);
        if (typeof tier !== 'string' || !tier) throw new Error('unresolved');
        return `${a}→${tier}`;
      }).join(', ')));
      return [SHIPPED_HEADER, ...rows, TAIL].join('\n');
    } catch {
      return FAILED;
    }
  };

  const SYNTHETIC = Object.freeze({
    fableTwoTier: {
      agents: {
        modelPolicy: {
          high: { model: 'fable', agents: ['tdd-guide', 'backend-developer', 'code-reviewer', 'architect'] },
          fable: { enabled: true, allowlist: ['code-reviewer', 'architect'] },
          phaseRoles: { build: 'opus', review: 'fable' },
        },
      },
    },
    mediumSonnet: { agents: { modelPolicy: { high: { model: 'opus', agents: [] }, medium: { model: 'sonnet', agents: ['tdd-guide'] } } } },
    empty: {},
  });

  /** Captured from the pre-change module (base b3be03f5) for the configs above. */
  const PINNED = Object.freeze({
    fableTwoTier: [SHIPPED_HEADER, row(BUILD, 'tdd-guide→opus, backend-developer→opus'),
      row(REVIEW, 'code-reviewer→fable'), row(DESIGN, 'architect→fable'), TAIL].join('\n'),
    mediumSonnet: [SHIPPED_HEADER, row(BUILD, 'tdd-guide→sonnet, backend-developer→opus'),
      row(REVIEW, 'code-reviewer→opus'), row(DESIGN, 'architect→opus'), TAIL].join('\n'),
    empty: [SHIPPED_HEADER, row(BUILD, 'tdd-guide→opus, backend-developer→opus'),
      row(REVIEW, 'code-reviewer→opus'), row(DESIGN, 'architect→opus'), TAIL].join('\n'),
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  describe('no injection — byte-identical to the pre-change output', () => {
    it('matches the pinned text for every synthetic config, with and without an empty opts', () => {
      for (const [name, cfg] of Object.entries(SYNTHETIC)) {
        expect(renderModelPolicy(cfg), name).toBe(PINNED[name]);
        expect(renderModelPolicy(cfg, {}), name).toBe(PINNED[name]);
        expect(renderModelPolicy(cfg, undefined), name).toBe(PINNED[name]);
        expect(renderModelPolicy(cfg, { resolveEffective: undefined }), name).toBe(PINNED[name]);
        expect(legacyRender(cfg), `oracle ${name}`).toBe(PINNED[name]);
      }
    });

    it('matches the legacy algorithm for the shipped config', async () => {
      const config = await loadConfig();
      const expected = legacyRender(config);
      expect(expected).not.toBe(FAILED);
      expect(renderModelPolicy(config)).toBe(expected);
      expect(renderModelPolicy(config, {})).toBe(expected);
    });

    it('never reads the user model-routing file, even when one sits in every state-dir seam', async () => {
      const home = mkTmp();
      const stateDir = path.join(home, 'state');
      const overrides = JSON.stringify({
        schemaVersion: 1,
        plugins: {
          artibot: {
            default: 'haiku',
            agents: { 'tdd-guide': 'haiku', 'backend-developer': 'haiku', 'code-reviewer': 'haiku', architect: 'haiku' },
            phaseRoles: { build: 'haiku', review: 'haiku' },
          },
        },
      });
      for (const dir of [path.join(home, '.claude', 'artibot'), stateDir]) {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'model-routing.json'), overrides);
      }
      vi.stubEnv('HOME', home);
      vi.stubEnv('USERPROFILE', home);
      vi.stubEnv('ARTIBOT_STATE_DIR', stateDir);
      vi.stubEnv('ARTIBOT_STATE_DIR_HOME', home);
      vi.resetModules();
      const fresh = await import('../../lib/git/split-brief.js');
      const freshConfig = await import('../../lib/core/config.js');

      for (const [name, cfg] of Object.entries(SYNTHETIC)) {
        const out = fresh.renderModelPolicy(cfg);
        expect(out, name).toBe(PINNED[name]);
        expect(out, name).not.toContain('haiku');
      }

      // Positive control: the planted file is exactly where a reader would look,
      // and consuming it DOES change the block — so the equality above is not vacuous.
      const planted = path.join(freshConfig.resolveArtibotDir(), 'model-routing.json');
      expect(fs.existsSync(planted)).toBe(true);
      const readsFile = (qualified) => ({
        model: JSON.parse(fs.readFileSync(planted, 'utf-8')).plugins.artibot.agents[qualified.split(':')[1]],
        source: 'user agent',
      });
      const injected = fresh.renderModelPolicy(SYNTHETIC.empty, { resolveEffective: readsFile });
      expect(injected).toContain('code-reviewer→haiku (source: user agent)');
    });
  });

  describe('injection — effective values with override provenance', () => {
    const CALLS = [
      ['artibot:tdd-guide', 'build'],
      ['artibot:backend-developer', 'build'],
      ['artibot:code-reviewer', 'review'],
      ['artibot:architect', undefined],
    ];

    it('calls the resolver once per representative agent with the qualified name and phase role', () => {
      const seen = [];
      renderModelPolicy(SYNTHETIC.empty, {
        resolveEffective: (agent, ctx) => { seen.push([agent, ctx]); return 'tier-x'; },
      });
      expect(seen.map(([a]) => a)).toEqual(CALLS.map(([a]) => a));
      for (const [i, [, role]] of CALLS.entries()) {
        expect(seen[i][1]).toBeTypeOf('object');
        expect(seen[i][1].role).toBe(role);
      }
    });

    it('prints the resolver values (not resolveModel) and switches the header to "effective incl. overrides"', () => {
      const out = renderModelPolicy(SYNTHETIC.empty, { resolveEffective: (a) => `eff-${a.split(':')[1]}` });
      const lines = out.split('\n');
      expect(lines).toHaveLength(5);
      expect(lines[0]).not.toBe(SHIPPED_HEADER);
      expect(lines[0]).toMatch(/^\[모델 운용 정책 — .*실효값.*\]$/);
      expect(lines[0]).toMatch(/override/);
      expect(lines[1]).toBe(row(BUILD, 'tdd-guide→eff-tdd-guide, backend-developer→eff-backend-developer'));
      expect(lines[2]).toBe(row(REVIEW, 'code-reviewer→eff-code-reviewer'));
      expect(lines[3]).toBe(row(DESIGN, 'architect→eff-architect'));
      expect(lines[4]).toBe(TAIL);
    });

    it('pins the resolveEffectiveModel shape { model, source, reason }: model plus "(source: s; reason)"', () => {
      const results = {
        'artibot:tdd-guide': { model: 'sonnet', source: 'user-agent', reason: 'plugins.artibot.agents' },
        'artibot:backend-developer': { model: 'opus', source: 'user-phase', reason: 'phaseRoles.build' },
        'artibot:code-reviewer': { model: 'sonnet', source: 'user-agent', reason: 'plugins.artibot.agents' },
        'artibot:architect': { model: 'opus', source: 'shipped-policy', reason: '' },
      };
      const out = renderModelPolicy(SYNTHETIC.empty, { resolveEffective: (a) => results[a] });
      const lines = out.split('\n');
      expect(lines[1]).toBe(row(BUILD,
        'tdd-guide→sonnet (source: user-agent; plugins.artibot.agents), backend-developer→opus (source: user-phase; phaseRoles.build)'));
      expect(lines[2]).toBe(row(REVIEW, 'code-reviewer→sonnet (source: user-agent; plugins.artibot.agents)'));
      expect(lines[3]).toBe(row(DESIGN, 'architect→opus (source: shipped-policy)'));
    });

    it('pins the landed 5-field shape { model, source, reason, requested, scope }: extra fields of any type are ignored', () => {
      const base = { model: 'sonnet', source: 'user-agent', reason: 'plugins.artibot.agents' };
      const results = {
        'artibot:tdd-guide': { model: 'sonnet', source: 'user-agent', reason: 'plugins.artibot.agents', requested: 'sonnet', scope: 'agent' },
        'artibot:backend-developer': { model: 'opus', source: 'shipped', reason: '', requested: null, scope: { plugin: 'artibot' } },
        'artibot:code-reviewer': { ...base, requested: ['sonnet', 'opus'], scope: [] },
        'artibot:architect': { ...base, requested: 42, scope: () => 'agent' },
      };
      const out = renderModelPolicy(SYNTHETIC.empty, { resolveEffective: (a) => results[a] });
      const expected = (a) => `${a}→sonnet (source: user-agent; plugins.artibot.agents)`;
      const lines = out.split('\n');
      expect(out).not.toBe(FAILED);
      expect(lines[1]).toBe(row(BUILD, `${expected('tdd-guide')}, backend-developer→opus (source: shipped)`));
      expect(lines[2]).toBe(row(REVIEW, expected('code-reviewer')));
      expect(lines[3]).toBe(row(DESIGN, expected('architect')));
    });

    it('stays tolerant: tier for model, reason alone, no provenance at all', () => {
      const results = {
        'artibot:tdd-guide': { tier: 'sonnet', source: 'user agent' },
        'artibot:backend-developer': { tier: 'opus', reason: 'user phase' },
        'artibot:code-reviewer': 'sonnet',
        'artibot:architect': { tier: 'opus' },
      };
      const out = renderModelPolicy(SYNTHETIC.empty, { resolveEffective: (a) => results[a] });
      const lines = out.split('\n');
      expect(lines[1]).toBe(row(BUILD, 'tdd-guide→sonnet (source: user agent), backend-developer→opus (reason: user phase)'));
      expect(lines[2]).toBe(row(REVIEW, 'code-reviewer→sonnet'));
      expect(lines[3]).toBe(row(DESIGN, 'architect→opus'));
    });

    it('renders every source label — none is special-cased as "the shipped one"', () => {
      const results = {
        'artibot:tdd-guide': { model: 'opus', source: 'shipped' },
        'artibot:backend-developer': { model: 'opus', source: 'default' },
        'artibot:code-reviewer': { model: 'opus', source: '', reason: '' },
        'artibot:architect': { model: 'opus', source: null, reason: null },
      };
      const out = renderModelPolicy(SYNTHETIC.empty, { resolveEffective: (a) => results[a] });
      const lines = out.split('\n');
      expect(lines[1]).toBe(row(BUILD, 'tdd-guide→opus (source: shipped), backend-developer→opus (source: default)'));
      expect(lines[2]).toBe(row(REVIEW, 'code-reviewer→opus'));
      expect(lines[3]).toBe(row(DESIGN, 'architect→opus'));
    });

    it('ignores config when injected — the resolver owns resolution', () => {
      const poison = new Proxy({}, { get() { throw new Error('boom'); } });
      const out = renderModelPolicy(poison, { resolveEffective: () => 'tier-x' });
      expect(out).not.toBe(FAILED);
      expect(out).toContain('code-reviewer→tier-x');
    });
  });

  describe('injection — fail-closed, never a silent fallback to shipped values', () => {
    const bad = {
      throws: () => { throw new Error('resolver down'); },
      emptyString: () => '',
      nullResult: () => null,
      undefinedResult: () => undefined,
      numberResult: () => 3,
      emptyObject: () => ({}),
      emptyModel: () => ({ model: '' }),
      whitespaceTier: () => ({ tier: 'op us' }),
      nonStringSource: () => ({ model: 'opus', source: 5 }),
      multilineSource: () => ({ model: 'opus', source: 'user\nagent' }),
      nonStringReason: () => ({ model: 'opus', source: 'user-agent', reason: { why: 'x' } }),
      multilineReason: () => ({ model: 'opus', source: 'user-agent', reason: 'a\r\nb' }),
      promise: () => Promise.resolve('opus'),
    };
    for (const [name, fn] of Object.entries(bad)) {
      it(`returns "${FAILED}" when the resolver result is invalid: ${name}`, () => {
        expect(renderModelPolicy(SYNTHETIC.empty, { resolveEffective: fn })).toBe(FAILED);
      });
    }

    /** Render with `resolveEffective`, then wait a macrotask and return any unhandled rejections. */
    const renderAndCollectLeaks = async (resolveEffective) => {
      const leaked = [];
      const onLeak = (reason) => leaked.push(reason);
      process.on('unhandledRejection', onLeak);
      try {
        const out = renderModelPolicy(SYNTHETIC.empty, { resolveEffective });
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { out, leaked };
      } finally {
        process.off('unhandledRejection', onLeak);
      }
    };

    it('fails closed on a rejecting async resolver without leaking an unhandled rejection', async () => {
      const { out, leaked } = await renderAndCollectLeaks(async () => { throw new Error('async-boom'); });
      expect(out).toBe(FAILED);
      expect(leaked).toEqual([]);
    });

    it('fails closed when the result is a thenable whose then accessor throws, without a leak', async () => {
      const hostile = Object.defineProperty({}, 'then', { get() { throw new Error('hostile then'); } });
      const { out, leaked } = await renderAndCollectLeaks(() => hostile);
      expect(out).toBe(FAILED);
      expect(leaked).toEqual([]);
    });

    it('fails the whole block when only one agent is invalid (no partial block)', () => {
      const fn = (a) => (a === 'artibot:architect' ? '' : 'opus');
      expect(renderModelPolicy(SYNTHETIC.empty, { resolveEffective: fn })).toBe(FAILED);
    });

    for (const [name, value] of Object.entries({ nullValue: null, stringValue: 'opus', objectValue: {}, numberValue: 1 })) {
      it(`returns "${FAILED}" when resolveEffective is present but not a function: ${name}`, () => {
        expect(renderModelPolicy(SYNTHETIC.empty, { resolveEffective: value })).toBe(FAILED);
      });
    }
  });
});

describe('missingSections', () => {
  it('defaults to 소유/allowlist and 완료', () => {
    expect(DEFAULT_REQUIRED_SECTIONS).toHaveLength(2);
    expect(missingSections('## 소유 파일\n## 완료 기준')).toEqual([]);
    expect(missingSections('## Allowlist\n## 완료')).toEqual([]);
    expect(missingSections('## 목표')).toHaveLength(2);
  });
});

describe('materializeLimb', () => {
  const plan = { runId: 'split-abc123', base: 'deadbeef' };
  const BRIEF = '# brief\r\n\r\n## 소유 파일 allowlist\r\n- a\r\n\r\n## 완료 기준\r\n- b\r\n';

  function seed(root, limb, text = BRIEF) {
    const dir = path.join(root, '.artibot', 'split', limb);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'brief.md'), text);
  }

  it('refuses when the parent brief is missing', () => {
    const parent = mkTmp();
    const wt = mkTmp();
    expect(() => materializeLimb({ parentRoot: parent, worktreePath: wt, limb: 'auth', branch: 'b', plan })).toThrow(/parent brief missing/);
    expect(fs.existsSync(path.join(wt, '.artibot'))).toBe(false);
  });

  it('refuses a brief lacking a required section and writes nothing', () => {
    const parent = mkTmp();
    const wt = mkTmp();
    seed(parent, 'auth', '# brief\n## 목표\nno sections');
    expect(() => materializeLimb({ parentRoot: parent, worktreePath: wt, limb: 'auth', branch: 'b', plan, prompt: 'p' })).toThrow(/lacks required sections/);
    expect(fs.existsSync(path.join(wt, '.artibot', 'split', 'auth', 'prompt.md'))).toBe(false);
  });

  it('honours a custom requiredSections list', () => {
    const parent = mkTmp();
    const wt = mkTmp();
    seed(parent, 'auth', '## 목표\n## deps');
    expect(() => materializeLimb({ parentRoot: parent, worktreePath: wt, limb: 'auth', branch: 'b', plan, requiredSections: [/deps/] })).not.toThrow();
  });

  it('copies the brief byte-exactly (CRLF preserved), writes prompt.md, returns the pointer', () => {
    const parent = mkTmp();
    const wt = mkTmp();
    seed(parent, 'auth');
    const r = materializeLimb({ parentRoot: parent, worktreePath: wt, limb: 'auth', branch: 'worktree-split-x-auth', plan, prompt: 'PROMPT' });
    expect(r.copied).toBe(true);
    expect(fs.readFileSync(r.briefPath)).toEqual(Buffer.from(BRIEF));
    expect(fs.readFileSync(r.promptPath, 'utf-8')).toBe('PROMPT');
    expect(r.pointer).toBe(buildLimbMessage(plan, {
      limb: 'auth', worktreePath: wt, branch: 'worktree-split-x-auth', promptPath: r.promptPath,
    }));
    expect(r.sourceBrief).toBe(path.join(parent, '.artibot', 'split', 'auth', 'brief.md'));
    const leftovers = fs.readdirSync(path.dirname(r.briefPath)).filter((f) => f.includes('.tmp.'));
    expect(leftovers).toEqual([]);
  });

  it('is idempotent: a second run overwrites with identical bytes', () => {
    const parent = mkTmp();
    const wt = mkTmp();
    seed(parent, 'auth');
    materializeLimb({ parentRoot: parent, worktreePath: wt, limb: 'auth', branch: 'b', plan, prompt: 'P1' });
    const r = materializeLimb({ parentRoot: parent, worktreePath: wt, limb: 'auth', branch: 'b', plan, prompt: 'P2' });
    expect(fs.readFileSync(r.briefPath)).toEqual(Buffer.from(BRIEF));
    expect(fs.readFileSync(r.promptPath, 'utf-8')).toBe('P2');
  });

  it('dryRun verifies but writes nothing', () => {
    const parent = mkTmp();
    const wt = mkTmp();
    seed(parent, 'auth');
    const r = materializeLimb({ parentRoot: parent, worktreePath: wt, limb: 'auth', branch: 'b', plan, prompt: 'P', dryRun: true });
    expect(r.copied).toBe(false);
    expect(fs.existsSync(r.briefPath)).toBe(false);
    expect(fs.existsSync(r.promptPath)).toBe(false);
    expect(r.pointer).toContain('[split:dispatch run=split-abc123 limb=auth]');
  });

  it('skips the copy when the worktree is the parent (window reuse) instead of overwriting itself', () => {
    const parent = mkTmp();
    seed(parent, 'auth');
    const r = materializeLimb({ parentRoot: parent, worktreePath: parent, limb: 'auth', branch: 'b', plan, prompt: 'P' });
    expect(r.copied).toBe(false);
    expect(fs.readFileSync(r.briefPath)).toEqual(Buffer.from(BRIEF));
    expect(fs.readFileSync(r.promptPath, 'utf-8')).toBe('P');
  });

  it('omits prompt.md when no prompt is given', () => {
    const parent = mkTmp();
    const wt = mkTmp();
    seed(parent, 'auth');
    const r = materializeLimb({ parentRoot: parent, worktreePath: wt, limb: 'auth', branch: 'b', plan });
    expect(r.promptPath).toBeNull();
    expect(fs.existsSync(path.join(wt, '.artibot', 'split', 'auth', 'prompt.md'))).toBe(false);
  });

  it('rejects missing required inputs', () => {
    expect(() => materializeLimb({ parentRoot: '', worktreePath: 'x', limb: 'a' })).toThrow(TypeError);
    expect(() => materializeLimb()).toThrow(TypeError);
  });

  // 2026-09-15 실측: 부하 하 두 번 dispatch 하는 시퀀스 480회 중 4회(0.83%) 가
  // `EPERM: operation not permitted, rename '<dest>.tmp.<pid>.<ts>' -> '<dest>'`
  // 로 거부됐다. 목적지가 이미 존재하는 두 번째 dispatch 에서만 났다 — Windows 는
  // 목적지에 열린 핸들(백신·인덱서)이 남아 있으면 rename 에 EPERM 을 준다.
  // `tests/scripts/split-tools.test.js` F07 플래키의 원인이었다.
  //
  // 이 절이 못 보는 것(rules §9): 실제 Windows 핸들 경합. 여기서는 renameSync 를
  // 대역해 재시도 경로만 핀한다. 빈도가 실제로 줄었는지는 부하 반복 실측이 답한다.
  // EBUSY·EACCES 도 같은 재시도 경로를 타지만 이 site 에서 실측된 코드는 EPERM 뿐이라
  // 케이스는 늘리지 않는다 — 두 코드의 근거는 session-store.js:41 선례다.
  describe('transient Windows rename lock', () => {
    /** Throw `code` on the first `failures` calls, then delegate to the real rename. */
    function flakyRename(failures, code) {
      const real = fs.renameSync.bind(fs);
      let calls = 0;
      const spy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
        calls += 1;
        if (calls <= failures) {
          const err = new Error(`${code}: injected rename failure`);
          err.code = code;
          throw err;
        }
        return real(from, to);
      });
      return { spy, count: () => calls };
    }

    it('EPERM 2회 뒤 성공하면 바이트가 동일하고 tmp 잔존이 0 이다', () => {
      const parent = mkTmp();
      const wt = mkTmp();
      seed(parent, 'auth');
      const { spy, count } = flakyRename(2, 'EPERM');
      try {
        const r = materializeLimb({ parentRoot: parent, worktreePath: wt, limb: 'auth', branch: 'b', plan, prompt: 'P' });
        // brief 3회(EPERM·EPERM·성공) + prompt 1회. seed 는 sibling 을 만들지 않는다.
        expect(count()).toBe(4);
        expect(fs.readFileSync(r.briefPath)).toEqual(Buffer.from(BRIEF));
        expect(fs.readFileSync(r.promptPath, 'utf-8')).toBe('P');
        expect(fs.readdirSync(path.dirname(r.briefPath)).filter((f) => f.includes('.tmp.'))).toEqual([]);
      } finally {
        spy.mockRestore();
      }
    });

    it('ENOENT 는 재시도 없이 즉시 throw 하고 tmp 를 남기지 않는다', () => {
      const parent = mkTmp();
      const wt = mkTmp();
      seed(parent, 'auth');
      const { spy, count } = flakyRename(Number.POSITIVE_INFINITY, 'ENOENT');
      try {
        expect(() => materializeLimb({ parentRoot: parent, worktreePath: wt, limb: 'auth', branch: 'b', plan, prompt: 'P' }))
          .toThrow(/ENOENT/);
        expect(count()).toBe(1);
      } finally {
        spy.mockRestore();
      }
      expect(fs.readdirSync(path.join(wt, '.artibot', 'split', 'auth')).filter((f) => f.includes('.tmp.'))).toEqual([]);
    });
  });

  // 2026-09-14 실측(라이브 1건): 부모에 leader-addendum.md 가 있어도 worktree 로
  // 가지 않아 리더가 손으로 복사했다. 아래는 그 복사를 코드로 옮긴 것의 핀이다.
  // 이 절이 못 보는 것: 창이 addendum 을 실제로 읽는지(라이브 관측).
  describe('sibling files', () => {
    const ADDENDUM = '# addendum\r\n- 창 보충 지시\r\n';
    const siblingOf = (root, limb, name) => path.join(root, '.artibot', 'split', limb, name);
    const write = (root, limb, name, text) => {
      fs.mkdirSync(path.join(root, '.artibot', 'split', limb), { recursive: true });
      fs.writeFileSync(siblingOf(root, limb, name), text);
    };

    it('is an allowlist of exact names, not a glob', () => {
      expect(SIBLING_FILES).toEqual(['leader-addendum.md']);
      expect(Object.isFrozen(SIBLING_FILES)).toBe(true);
      expect(SIBLING_FILES.some((n) => n.includes('*'))).toBe(false);
    });

    it('copies leader-addendum.md byte-exactly when the parent has one', () => {
      const parent = mkTmp();
      const wt = mkTmp();
      seed(parent, 'auth');
      write(parent, 'auth', 'leader-addendum.md', ADDENDUM);
      const r = materializeLimb({ parentRoot: parent, worktreePath: wt, limb: 'auth', branch: 'b', plan, prompt: 'P' });
      expect(r.siblings).toEqual([{
        name: 'leader-addendum.md',
        copied: true,
        sourcePath: siblingOf(parent, 'auth', 'leader-addendum.md'),
        destPath: siblingOf(wt, 'auth', 'leader-addendum.md'),
      }]);
      expect(fs.readFileSync(r.siblings[0].destPath)).toEqual(Buffer.from(ADDENDUM));
      expect(fs.readdirSync(path.dirname(r.briefPath)).filter((f) => f.includes('.tmp.'))).toEqual([]);
    });

    it('reports copied:false and writes nothing when the parent has no addendum', () => {
      const parent = mkTmp();
      const wt = mkTmp();
      seed(parent, 'auth');
      const r = materializeLimb({ parentRoot: parent, worktreePath: wt, limb: 'auth', branch: 'b', plan, prompt: 'P' });
      expect(r.siblings.map((s) => [s.name, s.copied])).toEqual([['leader-addendum.md', false]]);
      expect(fs.existsSync(siblingOf(wt, 'auth', 'leader-addendum.md'))).toBe(false);
    });

    it('does not carry brief-draft.md across — a recon artefact is not on the allowlist', () => {
      const parent = mkTmp();
      const wt = mkTmp();
      seed(parent, 'auth');
      write(parent, 'auth', 'brief-draft.md', '# 정찰 초안');
      const r = materializeLimb({ parentRoot: parent, worktreePath: wt, limb: 'auth', branch: 'b', plan, prompt: 'P' });
      expect(fs.existsSync(siblingOf(wt, 'auth', 'brief-draft.md'))).toBe(false);
      expect(r.siblings.map((s) => s.name)).toEqual(['leader-addendum.md']);
      expect(fs.readdirSync(path.dirname(r.briefPath)).sort()).toEqual(['brief.md', 'prompt.md']);
    });

    it('dryRun writes no sibling', () => {
      const parent = mkTmp();
      const wt = mkTmp();
      seed(parent, 'auth');
      write(parent, 'auth', 'leader-addendum.md', ADDENDUM);
      const r = materializeLimb({ parentRoot: parent, worktreePath: wt, limb: 'auth', branch: 'b', plan, prompt: 'P', dryRun: true });
      expect(r.siblings[0].copied).toBe(false);
      expect(fs.existsSync(path.join(wt, '.artibot'))).toBe(false);
    });

    it('skips the sibling copy when the worktree is the parent (window reuse)', () => {
      const parent = mkTmp();
      seed(parent, 'auth');
      write(parent, 'auth', 'leader-addendum.md', ADDENDUM);
      const r = materializeLimb({ parentRoot: parent, worktreePath: parent, limb: 'auth', branch: 'b', plan, prompt: 'P' });
      expect(r.siblings[0].copied).toBe(false);
      expect(fs.readFileSync(siblingOf(parent, 'auth', 'leader-addendum.md'))).toEqual(Buffer.from(ADDENDUM));
    });
  });

  describe('pointer names prompt.md (F06)', () => {
    it('carries a 프롬프트 line pointing at the written prompt.md', () => {
      const parent = mkTmp();
      const wt = mkTmp();
      seed(parent, 'auth');
      const r = materializeLimb({ parentRoot: parent, worktreePath: wt, limb: 'auth', branch: 'b', plan, prompt: 'P' });
      expect(r.pointer).toContain(`프롬프트: ${r.promptPath}`);
      expect(r.pointer).toContain('leader-addendum.md');
      expect(r.pointer.indexOf('브리프:')).toBeLessThan(r.pointer.indexOf('프롬프트:'));
      expect(r.pointer.indexOf('프롬프트:')).toBeLessThan(r.pointer.indexOf('브랜치:'));
    });

    it('has no 프롬프트 line when no prompt was rendered', () => {
      const parent = mkTmp();
      const wt = mkTmp();
      seed(parent, 'auth');
      const r = materializeLimb({ parentRoot: parent, worktreePath: wt, limb: 'auth', branch: 'b', plan });
      expect(r.promptPath).toBeNull();
      expect(r.pointer).not.toContain('프롬프트:');
    });
  });
});
