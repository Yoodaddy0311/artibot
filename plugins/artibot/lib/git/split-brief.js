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
import { renameWithRetry } from '../core/file.js';
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

/**
 * Files copied into the worktree beside `brief.md` when the parent has them.
 *
 * An ALLOWLIST of exact names, deliberately not a glob: the same folder is
 * where recon output (`brief-draft.md`) and the leader's scratch land, and a
 * glob would ship all of it into every limb window. A missing file is not an
 * error — the addendum is optional by construction.
 */
export const SIBLING_FILES = Object.freeze(['leader-addendum.md']);

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

/**
 * Representative agents per role; the tier text comes from the resolver, never from here.
 * The third element is the phase role an injected `resolveEffective` receives
 * (the design row has none); the default path does not pass it to `resolveModel`.
 */
const POLICY_ROLES = Object.freeze([
  ['구현·테스트·게이트 실행 서브에이전트', ['tdd-guide', 'backend-developer'], 'build'],
  ['검수(교차 검수·최종 inspection)', ['code-reviewer'], 'review'],
  ['설계(브리프·아키텍처)', ['architect'], undefined],
]);

const SHIPPED_HEADER = '[모델 운용 정책 — artibot.config.json#/agents/modelPolicy 를 resolveModel 로 해석한 값이다]';
const EFFECTIVE_HEADER = '[모델 운용 정책 — 사용자 override 를 포함한 실효값이다 (호출자가 주입한 resolveEffective 로 해석, 괄호 = 해석 출처(source; reason))]';

/** Optional printable text field: absent/null/'' → '', a one-line string → trimmed, anything else throws. */
function provenanceText(agent, key, value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || /[\r\n]/.test(value)) {
    throw new Error(`resolveEffective(artibot:${agent}) returned an unprintable ${key}`);
  }
  return value.trim();
}

/** Shipped value for one agent — the pre-injection behavior, unchanged. */
function shippedEntry(agent, config) {
  const tier = resolveModel(agent, {}, config);
  if (typeof tier !== 'string' || !tier) throw new Error(`resolveModel(${agent}) returned ${JSON.stringify(tier)}`);
  return `${agent}→${tier}`;
}

/**
 * Effective value for one agent from the caller's resolver. Throws on any
 * result it cannot render faithfully, so the block degrades as a whole.
 */
function effectiveEntry(agent, role, resolveEffective) {
  const result = resolveEffective(`artibot:${agent}`, { role });
  const obj = result !== null && typeof result === 'object' ? result : null;
  const tier = typeof result === 'string' ? result : (obj?.model ?? obj?.tier);
  if (typeof tier !== 'string' || !/^\S+$/.test(tier)) {
    // An async resolver hands back a Promise; if it rejects, nobody else holds it,
    // and an unhandled rejection can crash the dispatching process. Promise.resolve
    // adopts any thenable and turns a throwing `then` accessor into a rejection.
    if (result !== null && (typeof result === 'object' || typeof result === 'function')) {
      Promise.resolve(result).catch(() => {});
    }
    throw new Error(`resolveEffective(artibot:${agent}) returned no usable tier`);
  }
  const source = provenanceText(agent, 'source', obj?.source);
  const reason = provenanceText(agent, 'reason', obj?.reason);
  if (source) return `${agent}→${tier} (source: ${source}${reason ? `; ${reason}` : ''})`;
  return reason ? `${agent}→${tier} (reason: ${reason})` : `${agent}→${tier}`;
}

/**
 * Render the model-operating-policy block for a window prompt. No model IDs
 * or tiers are written in this file: the values come from a resolver.
 *
 * - Default (no `opts.resolveEffective`): `lib/core/model-policy.js#resolveModel`
 *   over `config`, byte-identical to the pre-injection output. Flip
 *   `artibot.config.json#/agents/modelPolicy` and the text follows. No user
 *   file is read — a window prompt must not depend on the dispatching
 *   machine's state unless the caller says so.
 * - Injected: `opts.resolveEffective(qualifiedAgent, { role })` is called per
 *   representative agent with the QUALIFIED name `artibot:<name>` (never the
 *   bare name) and `role` = `build` (구현 row), `review` (검수 row) or
 *   `undefined` (설계 row); `config` is not consulted.
 *   The resolver returns either a non-empty tier/model string, rendered with no
 *   parentheses, or an object — the user-override resolver `resolveEffectiveModel`
 *   returns `{ model, source, reason, requested, scope }`. Only `model` (or
 *   `tier`), `source` and `reason` are read; every other field, of any type, is
 *   ignored and never fails the block. A
 *   non-empty `source` is always rendered, whatever its label (no label is
 *   treated as "the shipped one"): `name→tier (source: <source>)`, or
 *   `(source: <source>; <reason>)` when `reason` is non-empty too; a `reason`
 *   without a `source` renders as `(reason: <reason>)`. The header says the
 *   values are effective ones including user overrides. A synchronous
 *   resolver is required — a Promise has no tier and fails (a rejection is
 *   absorbed, so it cannot surface as an unhandled rejection).
 *   Adapter details: when both `model` and `tier` are present, `model` wins;
 *   a whitespace-only `source`/`reason` counts as absent (no parentheses);
 *   `source`/`reason` are rendered verbatim, not escaped; and `model` is not
 *   checked against tier names — a resolver returning a model ID shows it
 *   as-is, so the adapter owns what it returns.
 *
 * Returns `(model policy 미해석)` when resolution fails — including a present
 * but non-function `resolveEffective`, a throwing resolver, or any result that
 * is not one of the two shapes above — so a broken policy shows up in the
 * prompt instead of a stale guess, and an injected run never falls back to
 * shipped values while claiming overrides were applied.
 *
 * @param {object|null|undefined} config - loaded `artibot.config.json` (passed through to `resolveModel`)
 * @param {{ resolveEffective?: (qualifiedAgent: string, ctx: { role: ('build'|'review'|undefined) }) => (string|{ model?: string, tier?: string, source?: string|null, reason?: string|null }) }} [opts]
 * @returns {string}
 */
export function renderModelPolicy(config, opts = {}) {
  try {
    const options = opts && typeof opts === 'object' ? opts : {};
    const { resolveEffective } = options;
    const injected = resolveEffective !== undefined;
    if (injected && typeof resolveEffective !== 'function') throw new TypeError('resolveEffective must be a function');
    const lines = [injected ? EFFECTIVE_HEADER : SHIPPED_HEADER];
    for (const [label, agents, role] of POLICY_ROLES) {
      const tiers = agents.map((a) => (injected ? effectiveEntry(a, role, resolveEffective) : shippedEntry(a, config)));
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

/**
 * Byte-exact atomic write: tmp sibling + rename, tmp removed on failure.
 *
 * The rename goes through `lib/core/file.js#renameWithRetry` because a second
 * dispatch writes over an existing destination, and on Windows that is where a
 * transient EPERM appears (measured 2026-09-15: 4 of 480 runs under parallel
 * vitest load — the `split-tools.test.js` F07 flake).
 */
function atomicWriteBytes(dest, bytes) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp.${process.pid}.${Date.now()}`;
  try {
    fs.writeFileSync(tmp, bytes);
    renameWithRetry(tmp, dest);
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
 * Copy the parent limb brief into the worktree (atomic, byte-exact), verify
 * its required sections, write `prompt.md` beside it, copy every
 * {@link SIBLING_FILES} the parent has, and return the one-line pointer the
 * leader sends.
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
 * @param {string|null} [input.forkPoint] - recorded fork point for the pointer's base line; omitted/empty = `plan.base` (see {@link buildLimbMessage})
 * @param {ReadonlyArray<RegExp>} [input.requiredSections]
 * @param {boolean} [input.dryRun=false] - verify only; write nothing
 * @returns {{ briefPath: string, promptPath: string|null, sourceBrief: string, pointer: string, copied: boolean, siblings: Array<{ name: string, copied: boolean, sourcePath: string, destPath: string }> }}
 */
export function materializeLimb({
  parentRoot, worktreePath, limb, branch, plan, prompt, forkPoint, requiredSections = DEFAULT_REQUIRED_SECTIONS, dryRun = false,
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
  const siblings = SIBLING_FILES.map((name) => {
    const sourcePath = path.join(src.dir, name);
    const destPath = path.join(dst.dir, name);
    const copy = !dryRun && path.resolve(sourcePath) !== path.resolve(destPath) && fs.existsSync(sourcePath);
    if (copy) atomicWriteBytes(destPath, fs.readFileSync(sourcePath));
    return { name, copied: copy, sourcePath, destPath };
  });
  const promptPath = typeof prompt === 'string' ? dst.prompt : null;
  const pointer = buildLimbMessage(
    { runId: String(plan?.runId ?? ''), base: String(plan?.base ?? '') },
    {
      limb,
      worktreePath,
      branch: String(branch ?? ''),
      promptPath,
      forkPoint: typeof forkPoint === 'string' && forkPoint ? forkPoint : null,
    },
  );
  return {
    briefPath: dst.brief,
    promptPath,
    sourceBrief: src.brief,
    pointer,
    copied: !dryRun && willCopy,
    siblings,
  };
}
