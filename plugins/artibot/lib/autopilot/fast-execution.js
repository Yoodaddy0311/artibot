/**
 * Autopilot --fast execution instruction builder.
 *
 * The engine remains responsible for phase transitions; this module turns
 * explicit planner metadata into a bounded, inspectable team/worktree plan.
 * It never creates worktrees or agents itself.
 *
 * @module lib/autopilot/fast-execution
 */

import os from 'node:os';
import { readFileSync } from 'node:fs';
import nodePath from 'node:path';
import { getPluginRoot } from '../core/platform.js';
import { getHeadSha } from '../git/repo-root-cache.js';
import { buildFastFanoutPlan, normalizeFastProfile } from './fast-profile.js';

function getFastTasks(state) {
  if (Array.isArray(state?.fastTasks)) return state.fastTasks;
  if (Array.isArray(state?.options?.fastTasks)) return state.options.fastTasks;
  return [];
}

function dynamicRunnerBlockReason(state) {
  const savedReason = state?.executeRunner?.reason;
  if (savedReason === 'explicit-runner-dynamic' || savedReason === 'auto-runner-dynamic') {
    return savedReason;
  }
  return state?.options?.runner === 'dynamic'
    ? 'explicit-runner-dynamic' : 'auto-runner-dynamic';
}

/** Load optional operator-configured --fast limits with a safe default. */
export function loadFastProfileConfig() {
  try {
    const cfgPath = nodePath.join(getPluginRoot(), 'artibot.config.json');
    const limits = JSON.parse(readFileSync(cfgPath, 'utf8'))?.autopilot?.fast;
    return limits && typeof limits === 'object' ? limits : {};
  } catch {
    return {};
  }
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function hasCanonicalLimits(limits) {
  if (!limits || typeof limits !== 'object' || Array.isArray(limits)) return false;
  const normalized = normalizeFastProfile(limits);
  return ['hardMaxAgents', 'agentsPerCpu', 'maxWorktrees', 'maxRisk']
    .every((name) => limits[name] === normalized[name]);
}

function readFastWaveSchedule(profile) {
  const taskIds = new Set();
  let largestWave = 0;
  for (const wave of profile.waves) {
    if (!wave || !Array.isArray(wave.taskIds)
      || !isPositiveInteger(wave.worktreeCount)
      || wave.taskIds.length !== wave.worktreeCount
      || wave.taskIds.length > profile.eligibleParallelism) return null;
    if (wave.taskIds.some((id) => typeof id !== 'string' || !id.trim() || taskIds.has(id))) return null;
    wave.taskIds.forEach((id) => taskIds.add(id));
    largestWave = Math.max(largestWave, wave.taskIds.length);
  }
  return { taskIds, largestWave };
}

function readSerialTasks(serial, disallowedIds = new Set()) {
  const taskIds = new Set();
  for (const entry of serial) {
    if (!entry || typeof entry.taskId !== 'string' || !entry.taskId.trim()
      || typeof entry.reason !== 'string' || !entry.reason.trim()
      || taskIds.has(entry.taskId) || disallowedIds.has(entry.taskId)) return null;
    taskIds.add(entry.taskId);
  }
  return taskIds;
}

function hasConsistentReasons(profile) {
  if (!Array.isArray(profile.serialReasons)
    || profile.serialReasons.some((reason) => typeof reason !== 'string' || !reason.trim())) return false;
  const actual = new Set(profile.serialReasons);
  if (actual.size !== profile.serialReasons.length) return false;
  const expected = new Set(profile.serial.map((entry) => entry.reason));
  if (profile.fallbackReason) expected.add(profile.fallbackReason);
  return actual.size === expected.size && [...actual].every((reason) => expected.has(reason));
}

function hasValidConflictGroups(profile, knownTaskIds) {
  if (!Array.isArray(profile.conflictGroups)) return false;
  const groupIds = new Set();
  const groupedTasks = new Set();
  return profile.conflictGroups.every((group) => {
    if (!group || typeof group.id !== 'string' || !group.id.trim() || groupIds.has(group.id)
      || !Array.isArray(group.taskIds) || group.taskIds.length < 2) return false;
    groupIds.add(group.id);
    return group.taskIds.every((taskId) => {
      if (typeof taskId !== 'string' || !knownTaskIds.has(taskId) || groupedTasks.has(taskId)) return false;
      groupedTasks.add(taskId);
      return true;
    });
  });
}

function hasBaseProfileShape(profile) {
  const counts = ['requestedTaskCount', 'eligibleTaskCount', 'requestedParallelism',
    'eligibleParallelism', 'plannedParallelism'];
  return profile && typeof profile === 'object' && !Array.isArray(profile)
    && profile.requested === true && typeof profile.enabled === 'boolean'
    && counts.every((name) => isNonNegativeInteger(profile[name]))
    && profile.requestedParallelism === profile.requestedTaskCount
    && profile.eligibleTaskCount <= profile.requestedTaskCount
    && isPositiveInteger(profile.cpuCount)
    && hasCanonicalLimits(profile.limits)
    && profile.worktrees && typeof profile.worktrees.required === 'boolean'
    && isNonNegativeInteger(profile.worktrees.count)
    && Array.isArray(profile.waves) && Array.isArray(profile.serial)
    && Number.isFinite(profile.estimatedSpeedup) && profile.estimatedSpeedup >= 1
    && profile.estimatedSpeedup <= Math.max(1, profile.requestedTaskCount);
}

function isReusableStandardProfile(profile) {
  const expectedParallelism = profile.requestedTaskCount > 0 ? 1 : 0;
  const serialIds = readSerialTasks(profile.serial);
  return profile.profile === 'standard' && profile.enabled === false
    && typeof profile.fallbackReason === 'string' && profile.fallbackReason.length > 0
    && profile.eligibleParallelism === expectedParallelism
    && profile.plannedParallelism === expectedParallelism
    && profile.worktrees.required === false && profile.worktrees.count === 0
    && profile.waves.length === 0 && profile.serial.length === profile.requestedTaskCount
    && profile.estimatedSpeedup === 1 && serialIds !== null
    && hasConsistentReasons(profile) && hasValidConflictGroups(profile, serialIds);
}

function isReusableEnabledProfile(profile) {
  if (profile.profile !== 'fast' || profile.enabled !== true || profile.fallbackReason !== null
    || profile.eligibleTaskCount < 2 || profile.plannedParallelism < 2
    || profile.plannedParallelism > profile.eligibleParallelism) return false;
  const capacity = Math.min(profile.limits.hardMaxAgents,
    profile.limits.agentsPerCpu * profile.cpuCount,
    profile.limits.maxWorktrees, profile.eligibleTaskCount);
  if (profile.eligibleParallelism !== capacity || !profile.worktrees.required
    || profile.worktrees.count !== profile.plannedParallelism) return false;
  const schedule = readFastWaveSchedule(profile);
  if (!schedule || schedule.taskIds.size !== profile.eligibleTaskCount
    || schedule.largestWave !== profile.plannedParallelism) return false;
  const serialIds = readSerialTasks(profile.serial, schedule.taskIds);
  if (!serialIds || profile.requestedTaskCount !== profile.eligibleTaskCount + serialIds.size) return false;
  const knownIds = new Set([...schedule.taskIds, ...serialIds]);
  return hasConsistentReasons(profile) && hasValidConflictGroups(profile, knownIds);
}

function isReusableFastProfile(profile) {
  try {
    if (!hasBaseProfileShape(profile)) return false;
    return profile.enabled ? isReusableEnabledProfile(profile) : isReusableStandardProfile(profile);
  } catch {
    return false;
  }
}

function getPersistedFastProfile(state) {
  const profile = state?.fastProfile;
  if (!isReusableFastProfile(profile)) return null;
  return {
    ...profile,
    limits: normalizeFastProfile(profile.limits),
    worktrees: { ...profile.worktrees },
    waves: profile.waves.map((wave) => ({ ...wave, taskIds: [...wave.taskIds] })),
    serial: profile.serial.map((entry) => ({ ...entry })),
    serialReasons: [...profile.serialReasons],
    conflictGroups: profile.conflictGroups.map((group) => ({ ...group, taskIds: [...group.taskIds] })),
    reused: true,
  };
}

/**
 * Resolve host parallelism. `testOptions.cpuCount` exists only as a deterministic
 * test override; production sessions use the OS scheduler's available count.
 * @param {{ cpuCount?: number }} [testOptions]
 * @returns {number}
 */
export function resolveFastCpuCount(testOptions = {}) {
  const override = Number(testOptions?.cpuCount);
  if (Number.isInteger(override) && override > 0) return override;
  try {
    const available = typeof os.availableParallelism === 'function' ? os.availableParallelism() : 0;
    if (Number.isInteger(available) && available > 0) return available;
  } catch { /* fall through to cpus() */ }
  try {
    const detected = os.cpus().length;
    return Number.isInteger(detected) && detected > 0 ? detected : 1;
  } catch { return 1; }
}

function isStableIntegration(integration) {
  const validSha = (value) => typeof value === 'string' && /^[0-9a-f]{40,64}$/i.test(value);
  return integration && typeof integration === 'object'
    && ((integration.cwd === null && integration.baseSha === null)
      || (typeof integration.cwd === 'string' && integration.cwd
        && validSha(integration.baseSha)));
}

/**
 * Preserve the base integration worktree used by worker worktree creation.
 * @param {object} state
 * @param {string|null} worktreePath
 * @returns {{ cwd: string|null, baseSha: string|null }}
 */
export function retainFastIntegrationWorktree(state, worktreePath) {
  const existing = state?.fastIntegration;
  if (isStableIntegration(existing) && existing.cwd) return existing;
  const cwd = typeof worktreePath === 'string' && worktreePath ? worktreePath : null;
  const integration = { cwd, baseSha: cwd ? getHeadSha(cwd) : null };
  if (state && typeof state === 'object') state.fastIntegration = integration;
  return integration;
}

/**
 * Plan a requested fast execution profile from explicit task metadata.
 * Explicit runners and no-team remain authoritative and force a safe fallback.
 * @param {object} state
 * @param {'team-create'|'dynamic-run'} runner
 * @param {object} [limits]
 * @param {{ cpuCount?: number }} [testOptions] deterministic unit-test seam
 * @returns {object|null}
 */
export function planFastExecution(state, runner, limits = {}, testOptions = {}) {
  if (state?.options?.fast !== true) return null;
  const blockedReason = runner === 'dynamic-run'
    ? dynamicRunnerBlockReason(state)
    : state?.options?.noTeam === true || state?.options?.team === false
      ? 'team-disabled'
      : null;
  const persisted = blockedReason ? null : getPersistedFastProfile(state);
  if (persisted) return persisted;
  const cpuCount = resolveFastCpuCount(testOptions);
  const plan = buildFastFanoutPlan({
    fast: blockedReason === null,
    tasks: getFastTasks(state),
    cpuCount,
    limits,
  });
  const serial = blockedReason ? plan.serial.map((entry) => entry.reason === 'fast-not-requested'
    ? { ...entry, reason: blockedReason } : entry) : plan.serial;
  const fallbackReason = blockedReason || plan.fallbackReason;
  const serialReasons = [...new Set([
    ...serial.map((entry) => entry.reason).filter(Boolean),
    ...(fallbackReason ? [fallbackReason] : []),
  ])];
  return {
    ...plan,
    serial,
    cpuCount,
    requested: true,
    requestedParallelism: plan.requestedTaskCount,
    serialReasons,
    fallbackReason,
    reused: false,
  };
}

/**
 * Produce the isolated team instruction for a validated fast execution plan.
 * Worker ids are generated from indexes, never untrusted task IDs.
 * @param {object} state
 * @param {object} fast
 * @returns {object}
 */
export function buildFastTeamInstruction(state, fast) {
  const workerPrefix = `${state.sessionId}-fast-worker-`;
  const integration = isStableIntegration(state?.fastIntegration)
    ? state.fastIntegration : { cwd: null, baseSha: null };
  const worktreePlan = {
    required: true,
    cap: fast.limits.maxWorktrees,
    count: fast.worktrees.count,
    integration: { cwd: integration.cwd, baseSha: integration.baseSha },
    workerPrefix,
    cleanup: 'remove each worker worktree after its wave; persist only successfully-created worker ids',
    waves: fast.waves.map((wave, index) => ({
      ...wave,
      workers: wave.taskIds.map((taskId, taskIndex) => ({
        id: `${workerPrefix}${index + 1}-${taskIndex + 1}`,
        taskId,
        baseCwd: integration.cwd,
        baseSha: integration.baseSha,
      })),
    })),
  };
  return {
    type: 'team-create',
    phase: 'EXECUTE',
    sessionId: state.sessionId,
    nextPhase: 'CROSS_CHECK',
    fast: { ...fast, worktreePlan },
    instructions: [
      `Autopilot 세션 ${state.sessionId} Phase 2 (fast profile).`,
      `검증된 독립 작업 wave만 병렬 실행합니다 (최대 ${fast.plannedParallelism} agents, worktree ${fast.worktrees.count}/${fast.limits.maxWorktrees}).`,
      '각 wave task는 전용 worktree와 한 명의 agent에만 배정하고, wave 완료 뒤 worktree를 정리합니다.',
      '파일 소유권이 겹치거나 위험도가 제한을 넘는 작업은 병렬 실행하지 말고 standard 경로로 직렬화합니다.',
      `동일 길이 작업 기준 예상 wall-clock speedup은 약 ${fast.estimatedSpeedup}x이며, 실제 성능 보장은 아닙니다.`,
      '외부 송신/destructive action 금지. WIP commit 30분 주기, checkpoint SHA를 session.checkpoints에 기록합니다.',
    ],
    teamHint: {
      parallel: true,
      leadAgent: 'orchestrator',
      profile: 'fast',
      plannedParallelism: fast.plannedParallelism,
      eligibleParallelism: fast.eligibleParallelism,
      worktreeCount: fast.worktrees.count,
      conflictIsolation: 'disjoint-file-ownership',
      waves: worktreePlan.waves,
    },
  };
}
