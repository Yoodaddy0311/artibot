/**
 * Autopilot engine — Phase orchestrator.
 *
 * Important contract: the engine itself never invokes agents directly.
 * Each Phase function returns an instruction object that the main Claude
 * uses to issue the actual Agent() / SendMessage() / Bash() calls.
 *
 * Reference: PRD docs/PRD/autopilot-mode.md sections 5.4 and 13.2.
 *
 * @module lib/autopilot/engine
 */
import { readFileSync } from 'node:fs';
import nodePath from 'node:path';
import { getPluginRoot } from '../core/platform.js';
import { generatePRD } from './prd-generator.js';
import { generateReport } from './report-generator.js';
import { parseGoalContract } from './prd-parser.js';
import { runPhaseGoalEvaluate } from './goal-loop.js';
import { acquireSessionKeepAwake, buildCostWarningInstruction, buildTuiInstruction, makeInitialState, maybeDangerNote, notePhaseCost, notePhaseProgress, persist, recordPhase, releaseSessionKeepAwake, tick } from './_engine-helpers.js';
import { loadSession } from './session-store.js';
import { pauseReason, shouldPause } from './safety.js';
import {
  notifyCompletion,
  notifyDanger,
  notifyPause,
  notifyPhaseProgress,
} from './notification.js';
import { extractKey, recallLessons } from './memory.js';
import {
  attemptCreateWorktree,
  reapSessionArtifacts,
} from './engine-cleanup.js';
import { safeAppendLesson } from './engine-state.js';
import { acquireLock, isLocked, releaseLock } from './lock.js';
import { loadAllowList } from './mcp-verifier.js';
import { buildFastTeamInstruction, loadFastProfileConfig, planFastExecution, retainFastIntegrationWorktree } from './fast-execution.js';
/**
 * Phase names in canonical order.
 *
 * EVALUATE (v4.6.0) sits between IMPROVE and REPORT and is a no-op
 * "gate" for legacy sessions (no Goal Contract). When a Goal Contract
 * is present, runPhaseGoalEvaluate may instead emit a re-EXECUTE
 * instruction to start another iteration.
 */
export const PHASES = Object.freeze([
  'INTAKE',
  'PLAN',
  'EXECUTE',
  'CROSS_CHECK',
  'VERIFY',
  'IMPROVE',
  'EVALUATE',
  'REPORT',
]);

/**
 * Check if the session should freeze; returns a pause instruction when true.
 * @param {object} state
 * @returns {object|null} pause instruction or null
 */
function maybePause(state) {
  if (!shouldPause(state)) return null;
  const reason = pauseReason(state) || 'safety-trigger';
  if (state.phase && state.phase !== 'PAUSED') {
    state.lastPhase = state.phase;
  }
  state.phase = 'PAUSED';
  state.pausedReason = reason;
  safeAppendLesson(state, {
    lesson: `Pause at ${state.lastPhase || 'unknown'}: ${reason}`,
    errorPattern: reason,
    sourcePhase: state.lastPhase || null,
  });
  persist(state);
  tick(state.sessionId, {
    phase: state.lastPhase || 'PAUSED',
    type: 'pause',
    level: 'warn',
    message: `Autopilot paused: ${reason}`,
    data: { reason },
  });
  const note = notifyPause(state.sessionId, reason);
  const dangerNote = maybeDangerNote(state, reason);
  return {
    type: 'pause',
    sessionId: state.sessionId,
    reason,
    notification: note,
    dangerNotification: dangerNote,
    instructions: [
      'Autopilot 세션이 자동 일시정지되었습니다.',
      `사유: ${reason}`,
      '사용자 결정 후 /autopilot:resume <sessionId> 로 재개할 수 있습니다.',
    ],
  };
}

/**
 * Phase 0 — Intake: generate PRD via prd-generator.
 * @param {object} state
 * @returns {object} instruction
 */
export function runPhase0Intake(state) {
  state.phase = 'INTAKE';
  tick(state.sessionId, { phase: 'INTAKE', type: 'phase-start', level: 'info', message: 'Phase 0 INTAKE 시작' });
  try {
    const featureKey = extractKey(state.task || '');
    const priorLessons = recallLessons(state.task || '', { limit: 5 });
    state.featureKey = featureKey;
    state.priorLessons = priorLessons;
    tick(state.sessionId, {
      phase: 'INTAKE',
      type: 'memory-recall',
      level: 'info',
      message: `prior lessons recalled: ${priorLessons.length}`,
      data: { featureKey },
    });
  } catch {
    /* recall non-blocking */
  }
  const paused = maybePause(state);
  if (paused) return paused;
  const { filePath, slug } = generatePRD({
    task: state.task,
    sessionId: state.sessionId,
    options: { ...state.options, mode: state.mode },
    priorLessons: state.priorLessons,
    // Artifact root override (undefined = real project root, unchanged default).
    // Tests pass options.projectRoot so PRDs land in a tmpdir instead of the
    // developer's docs/PRD/.
    projectRoot: state.options?.projectRoot,
  });
  state.prdPath = filePath;

  // v4.6.0 — extract Goal Contract from the generated PRD when present.
  // Legacy PRDs (no Goal Contract section) silently fall through with
  // state.goalContract = null, preserving 100% backward compatibility.
  try {
    const prdContent = readFileSync(filePath, 'utf-8');
    const parsed = parseGoalContract(prdContent);
    if (parsed.found && parsed.contract) {
      state.goalContract = parsed.contract;
      tick(state.sessionId, {
        phase: 'INTAKE',
        type: 'goal-contract-parsed',
        level: 'info',
        message: `goal contract parsed: ${parsed.contract.objective}`,
        data: {
          maxIterations: parsed.contract.maxIterations,
          hasValidationCommand: Boolean(parsed.contract.validationCommand),
        },
      });
    } else if (parsed.found && parsed.errors.length > 0) {
      tick(state.sessionId, {
        phase: 'INTAKE',
        type: 'goal-contract-error',
        level: 'warn',
        message: `goal contract parse failed: ${parsed.errors.join('; ')}`,
      });
    }
  } catch {
    /* parse non-blocking — legacy behavior preserved */
  }

  recordPhase(state, { name: 'INTAKE', status: 'done', artifact: filePath, slug });
  persist(state);
  tick(state.sessionId, { phase: 'INTAKE', type: 'phase-end', level: 'info', message: 'Phase 0 INTAKE 완료', data: { prdPath: filePath } });
  notePhaseProgress(state, 'START', 'INTAKE');
  return {
    type: 'phase-result',
    phase: 'INTAKE',
    sessionId: state.sessionId,
    prdPath: filePath,
    nextPhase: 'PLAN',
  };
}

/** Phase 1 — Plan: instruction for main Claude to delegate to planner agent. */
export function runPhase1Plan(state) {
  state.phase = 'PLAN';
  tick(state.sessionId, { phase: 'PLAN', type: 'phase-start', level: 'info', message: 'Phase 1 PLAN 시작' });
  const paused = maybePause(state);
  if (paused) return paused;
  recordPhase(state, { name: 'PLAN', status: 'queued' });
  persist(state);
  tick(state.sessionId, { phase: 'PLAN', type: 'phase-end', level: 'info', message: 'Phase 1 PLAN 위임 완료' });
  notePhaseProgress(state, 'INTAKE', 'PLAN');
  return {
    type: 'delegate',
    phase: 'PLAN',
    sessionId: state.sessionId,
    agent: 'planner',
    nextPhase: 'EXECUTE',
    instructions: [
      `Autopilot 세션 ${state.sessionId} Phase 1.`,
      `PRD: ${state.prdPath}`,
      '계획 산출물: 작업 단위 분해, 위험 식별, 병렬화 가능 여부 표.',
      '결과는 markdown 표 + 우선순위로 반환.',
    ],
    promptFor: 'planner',
  };
}

/**
 * Load the ADR-003 runner config block from artibot.config.json.
 * Same direct-read + safe-default pattern as mcp-verifier's loadAllowList;
 * a broken or absent config always degrades to auto-select OFF.
 * @returns {{ autoSelect: boolean }}
 */
export function loadRunnerConfig() {
  try {
    const cfgPath = nodePath.join(getPluginRoot(), 'artibot.config.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    return { autoSelect: cfg?.autopilot?.runner?.autoSelect === true };
  } catch {
    return { autoSelect: false };
  }
}

/**
 * Resolve the Phase 2 EXECUTE runner (ADR-003).
 *
 * Priority ladder:
 *   1. Valid persisted selection; otherwise explicit `options.runner` (Stage 1).
 *   2. Config gate `autopilot.runner.autoSelect` OFF (default) → team-create.
 *   3. Auto-select (Stage 2): the classifier recommendation injected at
 *      session start as `options.recommendedRunner === 'workflow'` (homogeneous
 *      fan-out per lib/cognitive/workflow-plan.js deriveRecommendation —
 *      consumed here, never recomputed: L2 must not import L4) → dynamic-run.
 *   4. Everything else (legacy states included) → team-create.
 *
 * The runner is fixed at session start and never re-evaluated on resume.
 * @param {object} state
 * @param {{ autoSelect?: boolean }} [config] - injectable for tests; defaults
 *   to loadRunnerConfig().
 * @returns {'team-create'|'dynamic-run'}
 */
export function resolveExecuteRunner(state, config) {
  const saved = readExecuteRunnerSelection(state);
  if (saved) return saved.runner;
  const explicit = state?.options?.runner;
  if (explicit === 'dynamic') return 'dynamic-run';
  // Any other non-empty explicit value ('team', typos, unknown strings) pins
  // the adaptive runner — preserves the Stage 1 invariant that only the exact
  // literal 'dynamic' can select the deterministic runner, even under
  // auto-select. Absent/empty falls through to the config-gated ladder.
  if (typeof explicit === 'string' && explicit.length > 0) return 'team-create';
  const cfg = config || loadRunnerConfig();
  if (cfg.autoSelect === true && state?.options?.recommendedRunner === 'workflow') {
    return 'dynamic-run';
  }
  return 'team-create';
}

function runnerSelectionReason(state, runner) {
  if (runner === 'dynamic-run') {
    return state?.options?.runner === 'dynamic'
      ? 'explicit-runner-dynamic' : 'auto-runner-dynamic';
  }
  return typeof state?.options?.runner === 'string' && state.options.runner
    ? 'explicit-runner-team' : 'default-runner-team';
}

function readExecuteRunnerSelection(state) {
  const selection = state?.executeRunner;
  if (!selection || typeof selection !== 'object') return null;
  const validReasons = selection.runner === 'dynamic-run'
    ? ['explicit-runner-dynamic', 'auto-runner-dynamic']
    : selection.runner === 'team-create'
      ? ['explicit-runner-team', 'default-runner-team'] : [];
  return validReasons.includes(selection.reason)
    ? { runner: selection.runner, reason: selection.reason } : null;
}

/** Capture runner+reason exactly once, then reuse the persisted pair. */
export function retainExecuteRunnerSelection(state, config) {
  const saved = readExecuteRunnerSelection(state);
  if (saved) return saved;
  const runner = resolveExecuteRunner(state, config);
  const selection = { runner, reason: runnerSelectionReason(state, runner) };
  if (state && typeof state === 'object') state.executeRunner = selection;
  return selection;
}

/**
 * Build the deterministic EXECUTE instruction (harness Workflow-tool run).
 * @param {object} state
 * @returns {object}
 */
function buildDynamicRunInstruction(state) {
  return {
    type: 'dynamic-run',
    phase: 'EXECUTE',
    sessionId: state.sessionId,
    nextPhase: 'CROSS_CHECK',
    runner: 'dynamic-run',
    instructions: [
      `Autopilot 세션 ${state.sessionId} Phase 2 (deterministic runner).`,
      'Workflow 도구로 스크립트를 작성·실행. Phase 1 PLAN 의 작업 단위를 워크리스트로 매핑, pipeline() 기본.',
      '세션 잔여 토큰 예산을 Workflow budget 으로 전달 (이중 계상 금지).',
      'checkpoint 는 run 경계(시작 전/완료 후) WIP commit. 각 agent 는 본 작업 디렉토리만 수정, 외부 송신/destructive action 금지.',
      '실패/빈 결과 시 같은 Phase 를 team-create 로 1회 폴백하고 runner-fallback 이벤트를 기록.',
    ],
  };
}

/**
 * Phase 2 — Execute: instruction to spin up a parallel team, or (when the
 * session opted into the deterministic runner via `--runner dynamic`) a
 * harness Workflow-tool run. Default path is byte-identical to the legacy
 * team-create instruction (ADR-003 Stage 1 contract).
 * @param {object} state
 * @returns {object}
 */
export function runPhase2Execute(state) {
  state.phase = 'EXECUTE';
  tick(state.sessionId, { phase: 'EXECUTE', type: 'phase-start', level: 'info', message: 'Phase 2 EXECUTE 시작' });
  const paused = maybePause(state);
  if (paused) return paused;

  const { runner } = retainExecuteRunnerSelection(state);
  const fast = planFastExecution(state, runner, loadFastProfileConfig());
  // The session worktree is the integration base for fast worker worktrees.
  // Standard execution retains the same best-effort worktree behavior.
  const savedWorktree = typeof state.worktreePath === 'string' && state.worktreePath
    ? state.worktreePath : null;
  const worktreePath = savedWorktree || attemptCreateWorktree(state);
  if (fast?.enabled) retainFastIntegrationWorktree(state, worktreePath);

  if (fast) {
    state.fastProfile = fast;
    tick(state.sessionId, {
      phase: 'EXECUTE',
      type: fast.reused ? 'fast-profile-reused' : 'fast-profile-planned',
      level: fast.enabled ? 'info' : 'warn',
      message: fast.reused
        ? 'Fast execution profile reused from the paused session'
        : fast.enabled ? 'Fast parallel execution plan accepted' : 'Fast request fell back to standard execution',
      data: {
        requested: fast.requested,
        reused: fast.reused === true,
        cpuCount: fast.cpuCount,
        requestedParallelism: fast.requestedParallelism,
        eligibleParallelism: fast.eligibleParallelism,
        plannedParallelism: fast.plannedParallelism,
        worktrees: fast.worktrees,
        serialReasons: fast.serialReasons,
        fallbackReason: fast.fallbackReason,
      },
    });
  }

  recordPhase(state, { name: 'EXECUTE', status: 'queued' });
  persist(state);
  tick(state.sessionId, {
    phase: 'EXECUTE',
    type: 'phase-end',
    level: 'info',
    message: runner === 'dynamic-run'
      ? 'Phase 2 EXECUTE 위임 완료 (runner=dynamic-run)'
      : 'Phase 2 EXECUTE 위임 완료',
  });
  notePhaseProgress(state, 'PLAN', 'EXECUTE');
  const instruction = runner === 'dynamic-run' ? buildDynamicRunInstruction(state) : fast?.enabled
    ? buildFastTeamInstruction(state, fast) : {
    type: 'team-create',
    phase: 'EXECUTE',
    sessionId: state.sessionId,
    nextPhase: 'CROSS_CHECK',
    instructions: [
      `Autopilot 세션 ${state.sessionId} Phase 2.`,
      'Agent(name=…) 로 병렬 teammate 를 생성하고 Phase 1 의 작업 단위를 분배.',
      '각 teammate 는 본 작업 디렉토리만 수정. 외부 송신/destructive action 금지.',
      'WIP commit 30분 주기. checkpoint SHA 를 session.checkpoints 에 기록.',
    ],
    teamHint: { parallel: true, leadAgent: 'orchestrator' },
  };
  if (fast && !fast.enabled) instruction.fast = fast;
  if (worktreePath) {
    instruction.worktreePath = worktreePath;
    instruction.cwdHint = worktreePath;
  }
  return instruction;
}

/**
 * Phase 3 — Cross-check: instruct reviewer agents.
 * @param {object} state
 * @returns {object}
 */
export function runPhase3CrossCheck(state) {
  state.phase = 'CROSS_CHECK';
  tick(state.sessionId, { phase: 'CROSS_CHECK', type: 'phase-start', level: 'info', message: 'Phase 3 CROSS_CHECK 시작' });
  const paused = maybePause(state);
  if (paused) return paused;
  recordPhase(state, { name: 'CROSS_CHECK', status: 'queued' });
  persist(state);
  tick(state.sessionId, { phase: 'CROSS_CHECK', type: 'phase-end', level: 'info', message: 'Phase 3 CROSS_CHECK 위임 완료' });
  notePhaseProgress(state, 'EXECUTE', 'CROSS_CHECK');
  return {
    type: 'delegate',
    phase: 'CROSS_CHECK',
    sessionId: state.sessionId,
    agents: ['code-reviewer', 'spec-reviewer'],
    nextPhase: 'VERIFY',
    instructions: [
      `Autopilot 세션 ${state.sessionId} Phase 3.`,
      'Phase 2 의 변경 파일에 대해 code-reviewer + spec-reviewer 를 동시 소환.',
      '결론을 state.crossCheck.verdict ("pass"|"warn"|"fail") 와 notes 로 기록.',
    ],
  };
}

/**
 * Attach MCP-verify metadata to a Phase 4 instruction (W2 integration).
 * Mutates `state.verifyResult.mcp` slot and emits a telemetry tick.
 * @param {object} state
 * @param {object} instruction - Phase 4 instruction to be augmented
 */
function attachMcpVerify(state, instruction) {
  const allow = loadAllowList();
  instruction.mcp = {
    enabled: true,
    allowedPrefix: 'plugin:artibot:',
    allowList: Array.from(allow.entries),
    blockExternal: allow.blockExternal,
    instructions: [
      '추가로 자체 plugin MCP 검증을 수행하세요.',
      'Artibot 자체 plugin MCP 만 호출 (plugin:artibot: prefix).',
      '외부 host로 데이터 송신/수신 절대 금지.',
      'MCP 응답을 받으면 validateMcpResponse(response)로 검증.',
      'violations 발견 시 즉시 phase abort.',
    ],
  };
  state.verifyResult = state.verifyResult || {};
  state.verifyResult.mcp = state.verifyResult.mcp || { ok: null, violations: [] };
  persist(state);
  tick(state.sessionId, {
    phase: 'VERIFY',
    type: 'mcp-verify-enabled',
    level: 'info',
    message: 'MCP-driven verification enabled',
    data: { allowList: Array.from(allow.entries) },
  });
}

/**
 * Phase 4 — Verify: run npm run ci; on failure, summon build-error-resolver.
 * When state.options.mcpVerify is true, an additional MCP-verify directive
 * is attached (instruction.mcp + state.verifyResult.mcp slot).
 * @param {object} state
 * @returns {object}
 */
export function runPhase4Verify(state) {
  state.phase = 'VERIFY';
  tick(state.sessionId, { phase: 'VERIFY', type: 'phase-start', level: 'info', message: 'Phase 4 VERIFY 시작' });
  const paused = maybePause(state);
  if (paused) return paused;
  recordPhase(state, { name: 'VERIFY', status: 'queued' });
  persist(state);
  tick(state.sessionId, { phase: 'VERIFY', type: 'phase-end', level: 'info', message: 'Phase 4 VERIFY 위임 완료' });
  notePhaseProgress(state, 'CROSS_CHECK', 'VERIFY');
  const instruction = {
    type: 'verify',
    phase: 'VERIFY',
    sessionId: state.sessionId,
    nextPhase: 'IMPROVE',
    command: 'npm run ci',
    onFailure: {
      agent: 'build-error-resolver',
      retryLimit: 3,
      escalateTo: 'pause',
    },
    instructions: [
      `Autopilot 세션 ${state.sessionId} Phase 4.`,
      'Bash 로 npm run ci 실행. 결과(lint/typecheck/test/build) 를 state.verifyResult 에 기록.',
      '실패 시 build-error-resolver 호출. 3회 재시도 후에도 실패면 pause.',
      '실패할 때마다 state.counters.buildFailures 또는 testFailures 증가.',
    ],
  };
  if (state.options?.mcpVerify) {
    attachMcpVerify(state, instruction);
  }
  return instruction;
}

/**
 * Phase 5 — Improve: refactor-cleaner + performance-engineer analysis.
 * @param {object} state
 * @returns {object}
 */
export function runPhase5Improve(state) {
  state.phase = 'IMPROVE';
  tick(state.sessionId, { phase: 'IMPROVE', type: 'phase-start', level: 'info', message: 'Phase 5 IMPROVE 시작' });
  const paused = maybePause(state);
  if (paused) return paused;
  recordPhase(state, { name: 'IMPROVE', status: 'queued' });
  persist(state);
  tick(state.sessionId, { phase: 'IMPROVE', type: 'phase-end', level: 'info', message: 'Phase 5 IMPROVE 위임 완료' });
  notePhaseProgress(state, 'VERIFY', 'IMPROVE');
  // v4.6.0 — when a Goal Contract is present, route through EVALUATE
  // instead of jumping straight to REPORT. Legacy sessions continue
  // straight to REPORT unchanged.
  const nextPhaseFromImprove = state.goalContract ? 'EVALUATE' : 'REPORT';
  return {
    type: 'delegate',
    phase: 'IMPROVE',
    sessionId: state.sessionId,
    agents: ['refactor-cleaner', 'performance-engineer'],
    nextPhase: nextPhaseFromImprove,
    instructions: [
      `Autopilot 세션 ${state.sessionId} Phase 5.`,
      'refactor-cleaner: 중복/스타일/dead-code 제안.',
      'performance-engineer: 핫패스/메모리/캐시 제안.',
      '제안은 state.improvements (array of string) 와 state.futurePlans 에 기록.',
    ],
  };
}

/** Phase 6 — Report: generate completion report and notify. */
export function runPhase6Report(state) {
  state.phase = 'REPORT';
  tick(state.sessionId, { phase: 'REPORT', type: 'phase-start', level: 'info', message: 'Phase 6 REPORT 시작' });
  const paused = maybePause(state);
  if (paused) return paused;
  state.completedAt = new Date().toISOString();
  const { filePath } = generateReport(state.sessionId, { projectRoot: state.options?.projectRoot });
  state.reportPath = filePath;
  state.phase = 'COMPLETED';
  recordPhase(state, { name: 'REPORT', status: 'done', artifact: filePath });
  safeAppendLesson(state, {
    lesson: `Completed: ${(state.task || '').slice(0, 160)}`,
    successPattern: 'session-complete',
    tokenCost: state.tokenUsage || 0,
    sourcePhase: 'REPORT',
  });
  persist(state);
  tick(state.sessionId, { phase: 'REPORT', type: 'phase-end', level: 'info', message: 'Phase 6 REPORT 완료', data: { reportPath: filePath } });
  tick(state.sessionId, { phase: 'COMPLETED', type: 'session-complete', level: 'info', message: 'Autopilot 세션 완료' });
  notePhaseProgress(state, 'IMPROVE', 'REPORT');
  // Release the feature lock + keep-awake acquired in startAutopilot.
  // Best-effort — mirrors the cleanup pattern already used in abortAutopilot.
  try {
    if (state.featureKey) releaseLock(state.featureKey, state.sessionId);
  } catch { /* cleanup non-blocking */ }
  // Finalize cleanup: remove this session's worktree+branch and sweep any
  // orphaned autopilot/* artifacts so a completed run never leaks branches.
  reapSessionArtifacts(state, { force: false });
  releaseSessionKeepAwake(state.sessionId).catch(() => {});
  const note = notifyCompletion(state.sessionId, 'COMPLETED');
  return {
    type: 'phase-result',
    phase: 'REPORT',
    sessionId: state.sessionId,
    reportPath: filePath,
    notification: note,
    nextPhase: null,
  };
}

/**
 * Start a new autopilot session.
 * Persists initial state and runs Phase 0 (PRD).
 * Returns sessionId + prdPath; subsequent phases are driven by the main Claude
 * via resumeAutopilot or direct phase calls.
 *
 * @param {{ task: string, mode?: string, options?: object, sessionId?: string }} args
 * @returns {Promise<{ sessionId: string, prdPath: string, phase: string, instruction: object, paused?: boolean, reason?: string }>}
 */
export async function startAutopilot({ task, mode, options, sessionId } = {}) {
  if (!task || typeof task !== 'string') {
    throw new TypeError('task is required');
  }
  const state = makeInitialState({ task, mode, options, sessionId });
  retainExecuteRunnerSelection(state);

  // Derive featureKey early so we can guard against concurrent sessions
  // working on the same feature (worktree/branch collision).
  const featureKey = extractKey(task);
  state.featureKey = featureKey;

  // Attempt to acquire a cross-process feature lock. On collision we pause
  // the new session immediately rather than racing the existing holder.
  const lockResult = acquireLock(featureKey, state.sessionId);
  if (!lockResult.ok) {
    const holderId = lockResult.holder?.sessionId || 'unknown';
    state.phase = 'PAUSED';
    state.pausedReason = `lock-held-by-${holderId}`;
    persist(state);
    tick(state.sessionId, {
      phase: 'PAUSED',
      type: 'lock-collision',
      level: 'warn',
      message: `Autopilot start paused: featureKey ${featureKey} held by ${holderId}`,
      data: { featureKey, holder: lockResult.holder || null },
    });
    return {
      sessionId: state.sessionId,
      prdPath: null,
      phase: 'PAUSED',
      instruction: {
        type: 'pause',
        sessionId: state.sessionId,
        reason: state.pausedReason,
      },
      paused: true,
      reason: state.pausedReason,
    };
  }
  state.lockPath = lockResult.lockPath;

  try {
    await acquireSessionKeepAwake(state);
    persist(state);
    const instruction = runPhase0Intake(state);
    const tui = buildTuiInstruction(state, { isTTY: process.stdout.isTTY });
    const base = {
      sessionId: state.sessionId,
      prdPath: state.prdPath,
      phase: state.phase,
      instruction,
      ...(tui ? { tui } : {}),
    };
    if (instruction.type === 'pause') {
      return { ...base, paused: true, reason: instruction.reason };
    }
    return base;
  } catch (err) {
    // Lock leak guard: if Phase 0 throws (e.g. PRD generation, persist failure)
    // we must release the feature lock before propagating, otherwise the holder
    // appears stuck and blocks future sessions on the same feature.
    try { releaseLock(featureKey, state.sessionId); } catch { /* best-effort */ }
    releaseSessionKeepAwake(state.sessionId).catch(() => {});
    throw err;
  }
}

const PHASE_TO_RUNNER = Object.freeze({
  INTAKE: runPhase0Intake,
  PLAN: runPhase1Plan,
  EXECUTE: runPhase2Execute,
  CROSS_CHECK: runPhase3CrossCheck,
  VERIFY: runPhase4Verify,
  IMPROVE: runPhase5Improve,
  EVALUATE: runPhaseGoalEvaluate,
  REPORT: runPhase6Report,
});

/**
 * Determine the next phase to run from the current phase label.
 * @param {string} current
 * @returns {string|null}
 */
function nextPhaseAfter(current) {
  if (current === 'COMPLETED' || current === 'ABORTED') return null;
  if (current === 'PAUSED') return null;
  const idx = PHASES.indexOf(current);
  if (idx === -1) return 'PLAN';
  if (idx >= PHASES.length - 1) return null;
  return PHASES[idx + 1];
}

/**
 * Resume a session by running its next phase exactly once.
 * Returns the phase label it just attempted plus a status string.
 * @param {string} sessionId
 * @returns {Promise<{ phase: string, status: string, instruction?: object }>}
 */
export async function resumeAutopilot(sessionId) {
  if (!sessionId) throw new TypeError('sessionId required');
  const state = loadSession(sessionId);
  if (!state) throw new Error(`session not found: ${sessionId}`);
  if (state.phase === 'COMPLETED') return { phase: 'COMPLETED', status: 'noop' };
  if (state.phase === 'ABORTED') return { phase: 'ABORTED', status: 'noop' };

  // F4: Symmetric lock contract with startAutopilot. If a different live
  // session holds the featureKey lock, pause this resume. If we already hold
  // it (same sessionId) — typical in single-process Claude Code — proceed.
  // Stale lock (dead pid) is auto-reclaimed by acquireLock.
  if (state.featureKey) {
    const status = isLocked(state.featureKey);
    const heldByOther =
      status.locked && status.holder?.sessionId && status.holder.sessionId !== sessionId;
    if (heldByOther) {
      const holderId = status.holder.sessionId;
      tick(sessionId, {
        phase: state.phase || 'PAUSED',
        type: 'pause',
        level: 'warn',
        message: `Autopilot resume paused: featureKey ${state.featureKey} held by ${holderId}`,
        data: { featureKey: state.featureKey, holder: status.holder || null },
      });
      return {
        phase: state.phase || 'PAUSED',
        status: 'paused',
        instruction: {
          type: 'pause',
          reason: `lock-held-by-${holderId}`,
          holder: status.holder,
        },
      };
    }
    // Either unlocked or already ours — refresh acquisition (best-effort).
    if (!status.locked) {
      try { acquireLock(state.featureKey, sessionId); } catch { /* best-effort */ }
    }
  }

  const target = state.phase === 'PAUSED'
    ? state.lastPhase || 'PLAN'
    : nextPhaseAfter(state.phase) || state.phase;
  const runner = PHASE_TO_RUNNER[target];
  if (!runner) {
    return { phase: state.phase, status: 'unknown-phase' };
  }
  const instruction = runner(state);
  return {
    phase: state.phase,
    status: instruction?.type === 'pause' ? 'paused' : 'ok',
    instruction,
  };
}

/**
 * Get current session status. If sessionId omitted, returns the most-recent session.
 * @param {string} [sessionId]
 * @returns {Promise<object|null>}
 */
export async function getStatus(sessionId) {
  if (sessionId) return loadSession(sessionId);
  // Fallback: pick the most recent session by createdAt.
  const { listSessions } = await import('./session-store.js');
  const ids = listSessions();
  if (!ids.length) return null;
  let best = null;
  for (const id of ids) {
    const s = loadSession(id);
    if (!s) continue;
    if (!best || (s.createdAt || '') > (best.createdAt || '')) best = s;
  }
  return best;
}

/**
 * Abort an active session. Generates a final report when graceful.
 * @param {string} sessionId
 * @param {{ graceful?: boolean }} [opts]
 * @returns {Promise<{ sessionId: string, status: string, reportPath?: string }>}
 */
export async function abortAutopilot(sessionId, { graceful = true } = {}) {
  if (!sessionId) throw new TypeError('sessionId required');
  const state = loadSession(sessionId);
  if (!state) throw new Error(`session not found: ${sessionId}`);
  state.phase = 'ABORTED';
  state.abortedAt = new Date().toISOString();
  state.summary = state.summary || `Aborted ${graceful ? 'gracefully' : 'forcefully'} by user.`;
  persist(state);
  tick(sessionId, {
    phase: 'ABORTED',
    type: 'abort',
    level: 'warn',
    message: `Autopilot ${graceful ? 'graceful' : 'forced'} abort`,
    data: { graceful },
  });
  let reportPath = null;
  if (graceful) {
    try {
      const r = generateReport(sessionId, { projectRoot: state.options?.projectRoot });
      reportPath = r.filePath;
      state.reportPath = reportPath;
      persist(state);
    } catch {
      /* report generation best-effort on abort */
    }
  }
  // Abort cleanup: remove this session's worktree + autopilot branch (forced
  // when non-graceful) and sweep orphaned autopilot/* artifacts.
  reapSessionArtifacts(state, { force: !graceful });
  try {
    if (state.featureKey) releaseLock(state.featureKey, sessionId);
  } catch { /* cleanup non-blocking */ }
  releaseSessionKeepAwake(sessionId).catch(() => {});
  return { sessionId, status: 'ABORTED', reportPath };
}

export { notifyCompletion, notifyDanger, notifyPause, notifyPhaseProgress };
export { notePhaseCost, buildCostWarningInstruction };

// Public surface preserved via re-export after extraction (no behavior change).
// Worktree lifecycle / reaping → engine-cleanup.js
export { listActiveWorktrees } from './engine-cleanup.js';
// State record/mutation helpers → engine-state.js
export {
  classifyFailure,
  recordCheckpoint,
  recordPhaseResult,
  recordSecretLeak,
  recordRiskEvent,
} from './engine-state.js';
