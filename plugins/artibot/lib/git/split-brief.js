/**
 * `/split dispatch` brief materialisation — the pure half of
 * `scripts/split/dispatch.mjs`.
 *
 * Measured pain (Ontology campaign, 2026-09-02, proposal A5): the leader
 * pasted a ~2.5KB window prompt per lane by hand, nine times, and made
 * template-substitution mistakes doing it. The window only ever needs a
 * one-line pointer — the brief on disk is the source of truth
 * (`lib/git/split-dispatch.js#buildLimbMessage`). This module renders the
 * prompt from a template, refuses any unresolved placeholder (fail-closed),
 * copies the parent brief into the worktree atomically, and checks that the
 * brief still carries its required sections before anything is sent.
 *
 * Nothing here sends a message, spawns a process, or touches git. The only
 * filesystem contact is `materializeLimb` (read parent brief, write worktree
 * brief + prompt).
 *
 * @module lib/git/split-brief
 */

import fs from 'node:fs';
import path from 'node:path';
import { buildLimbMessage } from './split-dispatch.js';
import { resolveModel } from '../core/model-policy.js';

/** Placeholders `renderPrompt` accepts. Anything else in `{UPPER_SNAKE}` form is an error. */
export const PROMPT_PLACEHOLDERS = Object.freeze([
  'RUN', 'LIMB', 'WORKTREE_DIR', 'WORKTREE_PATH', 'BRANCH', 'BASE', 'PARENT', 'PARENT_ROOT',
  'SLUG', 'REPO_SHORT', 'MODEL_POLICY', 'GOTCHAS_DELTA', 'REPORT_CONTRACT', 'BUDGET',
]);

/**
 * Headings a limb brief must carry. `commands/split.md` "open" step 4 writes
 * 소유 파일 allowlist and 완료 기준; a brief that lost either would let a
 * window start without knowing what it may touch or when it is done.
 */
export const DEFAULT_REQUIRED_SECTIONS = Object.freeze([/소유|allowlist/i, /완료/]);

/** Fence-block regex shared with `tests/commands/report-contract-parity.test.js#extractBlock`. */
const CONTRACT_BLOCK = /```\r?\n(\[보고 계약\][\s\S]*?)\r?\n```/;

/** Unresolved-placeholder shape: ASCII upper-snake only, so `{리더 이름}` / `{측정시각}` survive. */
const UNRESOLVED = /\{[A-Z][A-Z0-9_]*\}/g;

/**
 * Substitute `{KEY}` placeholders. Pure. Throws (listing them) when any
 * `{UPPER_SNAKE}` placeholder is still present after substitution — a
 * half-rendered prompt is worse than none, because the window would read
 * `{WORKTREE_PATH}` as a path.
 *
 * Values are inserted verbatim (no escaping); a value may itself contain
 * `{...}` text such as the contract's `{측정시각}`, which is not a placeholder.
 * Substitution is single-pass, so a value containing `{LIMB}` is NOT expanded
 * again — but it is detected as unresolved and rejected.
 *
 * @param {string} template
 * @param {Record<string, string|number>} vars - keys from {@link PROMPT_PLACEHOLDERS}
 * @returns {string}
 */
export function renderPrompt(template, vars) {
  if (typeof template !== 'string') throw new TypeError('renderPrompt: template must be a string');
  const values = vars && typeof vars === 'object' ? vars : {};
  const unknownKeys = Object.keys(values).filter((k) => !PROMPT_PLACEHOLDERS.includes(k));
  if (unknownKeys.length) {
    throw new Error(`renderPrompt: unknown placeholder keys: ${unknownKeys.join(', ')}`);
  }
  const out = template.replace(UNRESOLVED, (token) => {
    const key = token.slice(1, -1);
    const v = values[key];
    if (!PROMPT_PLACEHOLDERS.includes(key) || v === undefined || v === null) return token;
    return String(v);
  });
  const left = [...new Set((out.match(UNRESOLVED) || []))];
  if (left.length) {
    throw new Error(`renderPrompt: unresolved placeholders: ${left.join(' ')}`);
  }
  return out;
}

/**
 * Pull the fenced `[보고 계약]` block out of `commands/split.md` verbatim
 * (CRLF normalised, trimmed). `split.md` is the single source of truth for the
 * split carrier; `tests/commands/report-contract-parity.test.js` keeps it
 * character-identical to `team.md`, so reading it here inherits that gate.
 * Throws when the block is absent — a prompt without the contract must not
 * be produced.
 *
 * @param {string} splitMdText
 * @returns {string}
 */
export function extractReportContract(splitMdText) {
  const m = typeof splitMdText === 'string' ? splitMdText.match(CONTRACT_BLOCK) : null;
  if (!m) throw new Error('extractReportContract: [보고 계약] fenced block not found in commands/split.md');
  return m[1].replace(/\r\n/g, '\n').trim();
}

/** Representative agents per role; the tier text comes from `resolveModel`, never from here. */
const POLICY_ROLES = Object.freeze([
  ['구현·테스트·게이트 실행 서브에이전트', ['tdd-guide', 'backend-developer']],
  ['검수(교차 검수·최종 inspection)', ['code-reviewer']],
  ['설계(브리프·아키텍처)', ['architect']],
]);

/**
 * Render the model-operating-policy block for a window prompt from
 * `lib/core/model-policy.js#resolveModel`. No model IDs or tiers are written
 * in this file: flip `artibot.config.json#/agents/modelPolicy` and the text
 * follows. Returns `(model policy 미해석)` when resolution fails, so a broken
 * policy shows up in the prompt instead of a stale guess.
 *
 * @param {object|null|undefined} config - loaded `artibot.config.json` (passed through to `resolveModel`)
 * @returns {string}
 */
export function renderModelPolicy(config) {
  try {
    const lines = ['[모델 운용 정책 — artibot.config.json#/agents/modelPolicy 를 resolveModel 로 해석한 값이다]'];
    for (const [label, agents] of POLICY_ROLES) {
      const tiers = agents.map((a) => {
        const tier = resolveModel(a, {}, config);
        if (typeof tier !== 'string' || !tier) throw new Error(`resolveModel(${a}) returned ${JSON.stringify(tier)}`);
        return `${a}→${tier}`;
      });
      lines.push(`- ${label}: Agent 호출 시 model 을 명시한다 (${tiers.join(', ')})`);
    }
    lines.push('- 창(터미널) 메인 세션 모델은 창이 못 바꾼다 — 오너가 그 터미널에서 /model 로 조정한다.');
    return lines.join('\n');
  } catch {
    return '(model policy 미해석)';
  }
}

/** Parent-side and worktree-side brief locations for one limb. */
function limbPaths(root, limb) {
  const dir = path.join(root, '.artibot', 'split', limb);
  return { dir, brief: path.join(dir, 'brief.md'), prompt: path.join(dir, 'prompt.md') };
}

/** Byte-exact atomic write: tmp sibling + rename, tmp removed on failure. */
function atomicWriteBytes(dest, bytes) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp.${process.pid}.${Date.now()}`;
  try {
    fs.writeFileSync(tmp, bytes);
    fs.renameSync(tmp, dest);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw err;
  }
}

/**
 * Check a brief carries every required section heading.
 *
 * @param {string} briefText
 * @param {ReadonlyArray<RegExp>} [requiredSections=DEFAULT_REQUIRED_SECTIONS]
 * @returns {string[]} sources of the regexes that did NOT match (empty = ok)
 */
export function missingSections(briefText, requiredSections = DEFAULT_REQUIRED_SECTIONS) {
  const text = String(briefText ?? '').replace(/\r\n/g, '\n');
  return requiredSections.filter((re) => !re.test(text)).map((re) => String(re));
}

/**
 * Copy `<parentRoot>/.artibot/split/<limb>/brief.md` into the worktree
 * (atomic, byte-exact), verify its required sections, write `prompt.md`
 * beside it, and return the one-line pointer the leader sends.
 *
 * Refuses (throws) when the parent brief is missing — a worktree brief is a
 * copy, never an original — and when a required section is absent. When the
 * worktree IS the parent (window-reuse runs point `worktreePath` at an
 * existing checkout) the copy is skipped, not overwritten with itself.
 *
 * @param {object} input
 * @param {string} input.parentRoot
 * @param {string} input.worktreePath
 * @param {string} input.limb
 * @param {string} input.branch - limb branch (for the pointer message)
 * @param {{ runId: string, base: string }} input.plan - plan.json (for the pointer message)
 * @param {string} [input.prompt] - rendered prompt; omitted = no prompt.md written
 * @param {ReadonlyArray<RegExp>} [input.requiredSections]
 * @param {boolean} [input.dryRun=false] - verify only; write nothing
 * @returns {{ briefPath: string, promptPath: string|null, sourceBrief: string, pointer: string, copied: boolean }}
 */
export function materializeLimb({
  parentRoot, worktreePath, limb, branch, plan, prompt, requiredSections = DEFAULT_REQUIRED_SECTIONS, dryRun = false,
} = {}) {
  for (const [k, v] of [['parentRoot', parentRoot], ['worktreePath', worktreePath], ['limb', limb]]) {
    if (typeof v !== 'string' || !v) throw new TypeError(`materializeLimb: ${k} is required`);
  }
  const src = limbPaths(parentRoot, limb);
  const dst = limbPaths(worktreePath, limb);
  if (!fs.existsSync(src.brief)) {
    throw new Error(`materializeLimb: parent brief missing: ${src.brief} — run /split open ${limb} first`);
  }
  const bytes = fs.readFileSync(src.brief);
  const missing = missingSections(bytes.toString('utf-8'), requiredSections);
  if (missing.length) {
    throw new Error(`materializeLimb: brief ${src.brief} lacks required sections: ${missing.join(', ')}`);
  }
  const sameFile = path.resolve(src.brief) === path.resolve(dst.brief);
  const willCopy = !sameFile;
  if (!dryRun) {
    if (willCopy) atomicWriteBytes(dst.brief, bytes);
    if (typeof prompt === 'string') atomicWriteBytes(dst.prompt, Buffer.from(prompt, 'utf-8'));
  }
  const pointer = buildLimbMessage(
    { runId: String(plan?.runId ?? ''), base: String(plan?.base ?? '') },
    { limb, worktreePath, branch: String(branch ?? '') },
  );
  return {
    briefPath: dst.brief,
    promptPath: typeof prompt === 'string' ? dst.prompt : null,
    sourceBrief: src.brief,
    pointer,
    copied: !dryRun && willCopy,
  };
}
