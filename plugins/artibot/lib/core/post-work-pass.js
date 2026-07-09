/**
 * Shared machinery for post-work Stop-hook passes (blindspot-check, teach-back).
 *
 * Both hooks are advisory-only siblings of dev-verify-gate.js: they run at Stop
 * AFTER a turn that modified code and inject a non-blocking
 * `hookSpecificOutput.additionalContext` directive — never `decision: "block"`.
 * The fire conditions (git repo, changed-files vs HEAD, fingerprint dedup,
 * stop_hook_active loop guard) mirror dev-verify-gate exactly. The ONE
 * deliberate difference: post-work passes are NOT scope-guarded to the Artibot
 * repo — when toggled on they apply to any project the user is working in.
 *
 * Enablement is opt-in per section (config.postWork.<section>.enabled === true,
 * default false) with a per-hook env kill-switch that always wins over config.
 *
 * Keeping the orchestration here (not duplicated across the two thin hook
 * scripts) makes the gate logic unit-testable and DRY, following the same
 * lib/core extraction pattern as lib/core/dev-verify-output.js.
 *
 * @module lib/core/post-work-pass
 */

import path from 'node:path';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { atomicWriteSync, getPluginRoot, resolveConfigPath } from '../../scripts/utils/index.js';
import { logHookError } from './hook-utils.js';

/**
 * Files written by sibling Stop hooks that race with these passes. Excluded so
 * the pass doesn't spuriously fire on the dispatcher's own side-effects. Kept
 * in sync with dev-verify-gate.js EXCLUDED_FILES.
 * @type {Set<string>}
 */
export const EXCLUDED_FILES = new Set([
  '.artibot/SESSION-NOTES.md',
]);

/**
 * Load and parse artibot.config.json best-effort. A missing/unreadable/invalid
 * config returns {} — config IO must never break the Stop slot.
 * @returns {object}
 */
export function loadArtibotConfig() {
  try {
    return JSON.parse(readFileSync(resolveConfigPath('artibot.config.json'), 'utf-8'));
  } catch {
    return {};
  }
}

/**
 * Resolve whether a post-work pass is enabled. The env kill-switch wins over
 * config: a truthy env var force-disables the pass even when config opts in.
 *
 * @param {object} config - Parsed artibot.config.json (or a slice)
 * @param {object} opts
 * @param {string} opts.section - Key under config.postWork (e.g. 'blindspot')
 * @param {string} opts.envVar - Kill-switch env var name (e.g. 'ARTIBOT_DISABLE_BLINDSPOT')
 * @param {object} [env] - Environment object (defaults to process.env)
 * @returns {boolean}
 */
export function resolvePassEnabled(config, { section, envVar }, env = process.env) {
  const kill = env?.[envVar];
  if (kill === '1' || kill === 'true') return false;
  return config?.postWork?.[section]?.enabled === true;
}

/**
 * Default number of teach-back comprehension quiz questions.
 */
export const DEFAULT_TEACHBACK_QUESTIONS = 3;

/**
 * Blindspot ("사각지대 점검") directive injected after DEV verify. Instructs the
 * model to decompose the turn's requirement, scan for missing evidence, and
 * report gaps earliest-blocking-first — recommend-only, no auto-fix. The report
 * must open with a horizontal rule + emoji header so it never reads as ordinary
 * prose (user feedback 2026-07-09: plain-paragraph output was invisible).
 * @returns {string}
 */
export function buildBlindspotContext() {
  return (
    'DEV 검증이 끝난 뒤 사각지대 점검을 수행하라: ' +
    '(1) 이번 턴의 원래 요구사항을 필수 구성요소(엔티티·속성·연결·제약)로 분해하라 ' +
    '(2) 각 구성요소에 대해 실제 산출물/검증 증거가 있는지 스캔하라 ' +
    "(3) 증거가 없거나 불충분한 구성요소를 '가장 먼저 막히는 지점(earliest blocking hop)'부터 순서대로 리스트업하라 " +
    '(4) 발견된 사각지대는 보고만 하고 자동으로 수정하지 마라(recommend-only). ' +
    "출력 형식: 반드시 수평선(---) 다음 '### 🔍 사각지대 점검' 헤더로 시작하는 별도 블록으로 작성하라 — 본문 문단에 섞지 마라. " +
    "사각지대가 없으면 그 헤더 아래 '이상 없음' 한 줄만 출력하라."
  );
}

/**
 * Resolve the number of teach-back quiz questions from config, defaulting to
 * {@link DEFAULT_TEACHBACK_QUESTIONS}. A non-positive / non-numeric value falls
 * back to the default rather than producing a nonsensical prompt.
 * @param {object} [config] - Parsed artibot.config.json (or a slice)
 * @returns {number}
 */
export function resolveTeachBackQuestions(config) {
  const raw = config?.postWork?.teachBack?.questions;
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TEACHBACK_QUESTIONS;
}

/**
 * Teach-back ("교육적 학습 루프") directive appended after the work report:
 * a plain-language explanation of the general concepts underlying the change,
 * plus a comprehension quiz on those concepts. Deliberately NOT about this
 * turn's implementation details, chosen approach, or rationale (user feedback
 * 2026-07-09: teach transferable concept knowledge, not change-specific
 * narrative; no age framing in the output). Wrong answers get
 * answer+explanation only — no retry demand, no perfect-score gate, and
 * answering is never forced.
 * @param {number} [questions=DEFAULT_TEACHBACK_QUESTIONS] - Quiz question count
 * @returns {string}
 */
export function buildTeachBackContext(questions = DEFAULT_TEACHBACK_QUESTIONS) {
  return (
    '작업 보고를 마친 뒤 학습 코너를 덧붙여라. ' +
    "출력 형식: 수평선(---) 다음 '### 📚 학습 코너' 헤더로 시작하는 별도 블록. " +
    '(1) 이번 작업의 바탕이 되는 일반 개념·원리를 쉬운 말로 설명하라 — ' +
    "'12세', '어린이용' 같은 수준 표현은 쓰지 마라. " +
    '이번 변경의 구현 경과·선택 사유·세부사항이 아니라, 그 주제를 처음 접하는 사람에게 필요한 기본 개념 지식만 다뤄라 ' +
    `(2) 이해 확인 퀴즈 ${questions}문항을 제시하라 — 퀴즈도 일반 개념을 묻는 기초 문제로 하고, 이번 작업의 세부사항·경위를 묻지 마라. ` +
    '사용자가 답하면 채점하되, 틀린 문항은 정답과 해설만 알려주고 끝내라 — 재시도 요구·만점 게이트 금지. ' +
    '사용자가 퀴즈에 답하지 않아도 되며 강요하지 마라.'
  );
}

/**
 * Run a git command in the given cwd, returning trimmed stdout.
 * Returns null on failure (silent — git unavailable / not a repo).
 * @param {string} cmd
 * @param {string} cwd
 * @param {string} hookName
 * @returns {string|null}
 */
function git(cmd, cwd, hookName) {
  try {
    return execSync(cmd, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
      windowsHide: true,
    }).trim();
  } catch (err) {
    logHookError(hookName, `git failed: ${cmd}`, err);
    return null;
  }
}

/**
 * Resolve the git repo root for the current cwd. Returns null outside a repo.
 * Resolved inline (not via lib/git/repo-root-cache) because each hook runs as
 * its own child process, so the cross-hook memoization gives no benefit and
 * lib/core (L1) must not import from lib/git (L2).
 * @param {string} hookName
 * @returns {string|null}
 */
function resolveRepoRoot(hookName) {
  return git('git rev-parse --show-toplevel', process.cwd(), hookName) || null;
}

/**
 * Resolve HEAD sha for the given repo. Returns 'unknown' when unavailable.
 * @param {string} repoRoot
 * @param {string} hookName
 * @returns {string}
 */
function resolveHeadSha(repoRoot, hookName) {
  return git('git rev-parse HEAD', repoRoot, hookName) || 'unknown';
}

/**
 * Collect changed files vs HEAD: working tree + staged (excludes EXCLUDED_FILES).
 * Same logic/exclusions as dev-verify-gate.getChangedFiles.
 * @param {string} repoRoot
 * @param {string} hookName
 * @returns {string[]}
 */
export function getChangedFiles(repoRoot, hookName) {
  const merged = new Set();
  for (const cmd of ['git diff --name-only HEAD', 'git diff --name-only --cached']) {
    const out = git(cmd, repoRoot, hookName);
    if (!out) continue;
    for (const line of out.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !EXCLUDED_FILES.has(trimmed)) merged.add(trimmed);
    }
  }
  return [...merged];
}

/**
 * Build the cache fingerprint for loop-guard. Includes a short hash of repoRoot
 * so different worktrees sharing one plugin install don't collide.
 * @param {string} repoRoot
 * @param {string} sha
 * @param {string[]} files
 * @returns {string}
 */
export function buildFingerprint(repoRoot, sha, files) {
  const repoHash = createHash('sha1').update(repoRoot).digest('hex').slice(0, 8);
  return `${repoHash}|${sha}|${files.slice().sort().join(',')}`;
}

/**
 * @param {string} pluginRoot
 * @param {string} stateFile
 * @returns {string}
 */
function readLastFingerprint(pluginRoot, stateFile) {
  try {
    const filePath = path.join(pluginRoot, 'runtime', stateFile);
    if (!existsSync(filePath)) return '';
    return readFileSync(filePath, 'utf-8').trim();
  } catch {
    return '';
  }
}

/**
 * @param {string} pluginRoot
 * @param {string} stateFile
 * @param {string} fingerprint
 * @param {string} hookName
 */
function saveFingerprint(pluginRoot, stateFile, fingerprint, hookName) {
  try {
    atomicWriteSync(path.join(pluginRoot, 'runtime', stateFile), fingerprint + '\n');
  } catch (err) {
    logHookError(hookName, 'failed to persist fingerprint', err);
  }
}

/**
 * Pick the hookSpecificOutput event name from the inbound payload.
 * @param {object} hookData
 * @returns {'Stop'|'SubagentStop'}
 */
export function resolveHookEventName(hookData) {
  return hookData?.hook_event_name === 'SubagentStop' ? 'SubagentStop' : 'Stop';
}

/**
 * Build the advisory (non-blocking) Stop-hook stdout envelope.
 * `suppressOutput: true` keeps the directive out of the terminal transcript —
 * the model still receives additionalContext, but the user no longer sees the
 * full Korean directive dumped as "Stop hook feedback" noise.
 * @param {string} additionalContext
 * @param {'Stop'|'SubagentStop'} [hookEventName='Stop']
 * @returns {object}
 */
export function buildAdditionalContextOutput(additionalContext, hookEventName = 'Stop') {
  return { suppressOutput: true, hookSpecificOutput: { hookEventName, additionalContext } };
}

/**
 * Run the shared post-work gate. Assumes the caller has already confirmed the
 * pass is enabled (see resolvePassEnabled). Returns `{ fire, output }`:
 * `fire` is false (and output undefined) when any gate condition fails.
 *
 * Fire conditions (all must hold): not stop_hook_active; in a git repo;
 * changed-files length > 0; fingerprint differs from the saved one. On fire the
 * new fingerprint is persisted before returning.
 *
 * @param {object} opts
 * @param {object} opts.hookData - Parsed Stop payload
 * @param {string} opts.hookName - Hook name (for logging + state)
 * @param {string} opts.stateFile - Fingerprint filename under runtime/
 * @param {string} opts.additionalContext - Korean directive to inject on fire
 * @returns {{ fire: boolean, output?: object }}
 */
export function runPostWorkPass({ hookData, hookName, stateFile, additionalContext }) {
  if (hookData?.stop_hook_active === true) return { fire: false };

  const repoRoot = resolveRepoRoot(hookName);
  if (!repoRoot) return { fire: false };

  const changedFiles = getChangedFiles(repoRoot, hookName);
  if (changedFiles.length === 0) return { fire: false };

  const pluginRoot = getPluginRoot();
  const headSha = resolveHeadSha(repoRoot, hookName);
  const fingerprint = buildFingerprint(repoRoot, headSha, changedFiles);
  if (readLastFingerprint(pluginRoot, stateFile) === fingerprint) return { fire: false };

  saveFingerprint(pluginRoot, stateFile, fingerprint, hookName);
  const output = buildAdditionalContextOutput(additionalContext, resolveHookEventName(hookData));
  return { fire: true, output };
}
