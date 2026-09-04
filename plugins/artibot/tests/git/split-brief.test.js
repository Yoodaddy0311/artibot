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
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_REQUIRED_SECTIONS,
  extractReportContract,
  materializeLimb,
  missingSections,
  PROMPT_PLACEHOLDERS,
  renderModelPolicy,
  renderPrompt,
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
    expect(r.pointer).toBe(buildLimbMessage(plan, { limb: 'auth', worktreePath: wt, branch: 'worktree-split-x-auth' }));
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
});
