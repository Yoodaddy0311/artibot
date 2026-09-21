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
import { executionProfile } from '../routing/execution-profile.js';
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

// ---------------------------------------------------------------------------
// CA-12 — opt-in mission objective on the fast plan
// ---------------------------------------------------------------------------

/**
 * Strict `=== true`, i.e. an allowlist of one value.
 *
 * This is a Canary-stage behaviour change whose rollback contract is a single
 * config key, so a truthy test would be the wrong shape: `"false"`, `0` as a
 * string, or a stray object would all turn it on, and turning it back off
 * again would then depend on guessing which falsy spelling the operator used.
 */
function wantsFastObjective(limits) {
  return limits?.applyObjective === true;
}

/**
 * Compile the objective a `--fast` mission runs under.
 *
 * The token is never spelled in this module: it comes from
 * `lib/routing/execution-profile.js`. The path taken here is the FLAG adapter
 * — `FLAG_TO_PRIORITY` maps the `fast` flag straight onto `maximum`, and
 * `OBJECTIVE_BY_PRIORITY.maximum` supplies the token. `PRIORITY_ALIASES.fast`
 * is a different door onto the same answer, read only when `intent.md`
 * frontmatter declares `priority: 'fast'`; this call passes no frontmatter.
 * A null objective there is the G-1 fail-closed case, so this returns null
 * too instead of substituting a token of its own.
 *
 * `applied` separates "requested" from "in force". A blocked or demoted plan
 * fans nothing out, so its directives reach no worker — a consumer that reads
 * only `token` would otherwise report an objective that never ran.
 *
 * @param {boolean} enabled Whether the plan actually fans out.
 * @returns {{token: string, reason: string, directives: object,
 *   source: string, applied: boolean}|null}
 */
function compileFastObjective(enabled) {
  let compiled;
  try {
    compiled = executionProfile({ flags: { fast: true } });
  } catch {
    // The compiler's only throw is a schema rejection, which is a routing
    // concern. Planning fan-out must not fail because the metadata did.
    return null;
  }
  if (typeof compiled?.objective !== 'string' || !compiled.directives) return null;
  return {
    token: compiled.objective,
    reason: compiled.objective_reason,
    // A plain copy: the compiler deep-freezes its result, and handing the
    // frozen reference onward would make every downstream write a silent
    // no-op in sloppy mode and a throw in strict mode.
    directives: { ...compiled.directives },
    source: compiled.source,
    applied: enabled === true,
  };
}

/**
 * Attach or strip the objective block according to the CURRENT flag.
 *
 * A persisted profile may carry a block written under a different flag state,
 * so what was stored never decides what is returned. With the flag off the key
 * is REMOVED rather than nulled: a plan must stay deep-equal (and
 * JSON-identical) to what the pre-CA-12 planner produced.
 */
function withFastObjective(plan, limits) {
  const objective = wantsFastObjective(limits) ? compileFastObjective(plan.enabled) : null;
  if (objective) return { ...plan, objective };
  if (!Object.hasOwn(plan, 'objective')) return plan;
  const stripped = { ...plan };
  delete stripped.objective;
  return stripped;
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
 * Demote an accepted fast plan back to standard execution.
 *
 * Fan-out is only safe on a **fixed** integration base: every worker worktree
 * is branched from `integration.baseSha`, and the instruction also tells the
 * driver to WIP-commit every 30 minutes. With no session worktree,
 * {@link retainFastIntegrationWorktree} yields `{cwd:null, baseSha:null}`, so
 * a driver that reads `null` as "the repo root" would branch up to
 * `maxWorktrees` workers off a **moving HEAD** instead of a pinned commit.
 *
 * Demotion is the deliberate response, rather than forcing `useWorktree` on:
 * `--fast` is not consent to create a worktree the user never asked for.
 * The returned profile keeps every measured field (cpuCount, parallelism,
 * serial entries) so `:status` can still explain what was requested and why
 * it did not run — only the parts that would drive fan-out are cleared.
 *
 * **Consumers: read `enabled` and `fallbackReason` first.** The parallelism
 * fields on a demoted profile are what was *requested*, not what will run —
 * reading `plannedParallelism` without checking `enabled` reports a fan-out
 * that was refused.
 *
 * @param {object} fast Accepted profile from {@link planFastExecution}.
 * @param {string} reason Fallback reason recorded on the demoted profile.
 * @returns {object} A new profile; the input is never mutated.
 */
export function demoteFastToStandard(fast, reason) {
  if (!fast || fast.enabled !== true) return fast;
  const demoted = {
    ...fast,
    enabled: false,
    fallbackReason: reason,
    worktrees: { required: false, count: 0 },
    waves: [],
    serialReasons: [...new Set([...(fast.serialReasons ?? []), reason])],
  };
  // The objective was still REQUESTED; it just no longer governs anything.
  // The block is kept with `applied:false` as a record of that. Measured
  // 2026-09-21: no reader consumes it yet — `:status` does not surface it —
  // so this is a written-down fact awaiting a consumer, not a live signal.
  if (!fast.objective) return demoted;
  return { ...demoted, objective: { ...fast.objective, applied: false } };
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
    // One spelling only. `options.noTeam` was accepted here too, but a repo-wide
    // census found zero producers for it and it appears nowhere in
    // `commands/autopilot.md` — an undocumented alias that nothing writes is a
    // second door onto the same decision, so it is gone. The surviving contract
    // is `options.team === false`: the command driver normalizes the documented
    // `--no-team` flag (autopilot.md § Fast Fan-out Profile) into it, and the
    // engine's obligation is the `team-disabled` telemetry + standard
    // `team-create` instruction that the same table promises.
    : state?.options?.team === false
      ? 'team-disabled'
      : null;
  const persisted = blockedReason ? null : getPersistedFastProfile(state);
  if (persisted) return withFastObjective(persisted, limits);
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
  return withFastObjective({
    ...plan,
    serial,
    cpuCount,
    requested: true,
    requestedParallelism: plan.requestedTaskCount,
    serialReasons,
    fallbackReason,
    reused: false,
  }, limits);
}

/** Worker ids are generated from indexes, never from untrusted task IDs. */
function buildFastWorktreePlan(state, fast, workerPrefix) {
  const integration = isStableIntegration(state?.fastIntegration)
    ? state.fastIntegration : { cwd: null, baseSha: null };
  return {
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
}

/**
 * One instruction line, assembled from the directive VALUES rather than from a
 * sentence written out by hand, so a change in `PERFORMANCE_DIRECTIVES` cannot
 * leave the prose asserting something the routing no longer does.
 *
 * The closing clause is deliberately value-FREE, unlike the rest of the line.
 * A low cost weight reads as "cost is not a factor", and a driver that took
 * that as "spend freely" would run past the session budget guard. That guard
 * is not lifted at ANY weight, so quoting a number there would make the
 * sentence a claim about one directive value instead of the standing rule it
 * actually is — and would contradict the line's own first half the moment the
 * weight changed.
 */
function describeFastObjective(objective) {
  const directives = objective.directives ?? {};
  return [
    `Objective ${objective.token} (${objective.reason}).`,
    `cost weight ${directives.costWeight},`,
    `effort 하한 ${directives.effortFloor ?? '없음'},`,
    `downgrade ${directives.downgradeEnabled ? '활성' : '비활성'},`,
    `accuracy 부목표 ${directives.accuracySecondaryObjective ? '있음' : '없음'}.`,
    '이 objective 는 예산을 해제하지 않습니다 — 세션 예산 가드와 승인 게이트는 그대로 유효합니다.',
  ].join(' ');
}

/**
 * Produce the isolated team instruction for a validated fast execution plan.
 * @param {object} state
 * @param {object} fast
 * @returns {object}
 */
export function buildFastTeamInstruction(state, fast) {
  const workerPrefix = `${state.sessionId}-fast-worker-`;
  const worktreePlan = buildFastWorktreePlan(state, fast, workerPrefix);
  const instruction = {
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
  if (!fast.objective) return instruction;
  instruction.instructions.push(describeFastObjective(fast.objective));
  instruction.teamHint.objective = fast.objective.token;
  return instruction;
}
