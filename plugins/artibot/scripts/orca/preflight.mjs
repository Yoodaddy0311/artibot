#!/usr/bin/env node
/**
 * `orca preflight` - fail-closed readiness check that `/orca plan` and `/orca launch` start with.
 *
 *   node scripts/orca/preflight.mjs [--json] [--parent <root>] [--agent-context <file>] [--help]
 *
 * Seven checks, always reported in this order (DESIGN 11.5 / IC-3):
 *
 *   orca-runtime        `orca status --json`: runtime reachable and ready, graph ready (not "app window up")
 *   orca-session        this process runs inside an Orca terminal (needed to be woken by `worker_done`)
 *   orca-repo           `orca repo list --json` registers this repo (kind git); yields repoId + trust label.
 *                       A match through the caller's workspace only (the path is not a registered repo path: a
 *                       subdirectory, a linked worktree) is `warn`; a path and a terminal that name different repos is `fail`
 *   orca-verbs          REQUIRED_ORCA_COMMANDS (verbs + flags DESIGN 4.4 uses) all exist in the CLI schema
 *   git-version         git >= 2.38
 *   orca-enabled        the kill switch is an explicit artibot.config.json#orca.enabled=false; an absent orca block is
 *                       `info` ("defaults used"), never a failure
 *   permission-posture  ALWAYS `info`: Orca's permission mode has no CLI surface, so it is shown, never judged
 *
 * `ok` is false when any check is `fail`; the CLI then exits 1. `warn` and `info` never fail the run.
 *
 * READ-ONLY. The only external calls are `orca status|repo list|agent-context --json` and `git --version`,
 * all through ONE injectable executor (`exec`) that never uses a shell. `callOrcaJson` refuses any verb outside
 * READ_ONLY_ORCA_VERBS before the executor is reached, so no state-changing Orca verb can be added by accident,
 * and no test calls the real `orca`.
 *
 * Where the Orca app version comes from (measured 2026-11-19 on 1.4.259, all three agreed): `orca status
 * --json` -> `result.runtime.appVersion` (the RUNNING runtime, preferred), then the `ORCA_APP_VERSION`
 * variable Orca sets for the terminal at launch (can be stale after an app update), else null. The CLI's own
 * `--version` is not used: it names the binary, not the runtime that will do the work.
 *
 * WHAT THIS CANNOT SEE (do not read a PASS as more than it is):
 *   - `orca-session` tests for identity variables, not for delivery. Wake-up on `worker_done` was measured
 *     for a TERMINAL leader only; a chat leader is unmeasured (it reports `warn`, never `pass`).
 *   - `orca-verbs` compares names. A flag that keeps its name and changes meaning still passes; behaviour is
 *     what the P0 probes measured, not something this check re-proves.
 *   - `permission-posture` cannot read the new-agent permission mode (P0-16: no CLI surface).
 *   - The `orca status` output while Orca is NOT running was not measured (the runtime was not stopped to find
 *     out); that failure path is covered through the injected executor only.
 *   - `orca-repo` matches paths lexically after a best-effort realpath; a repo registered through a path
 *     mapping the OS cannot resolve (a `subst` drive, say) is reported as not registered.
 *
 * @module scripts/orca/preflight
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from '../../lib/core/config.js';
import { isMainEntry } from '../hooks/_main-entry.js';

/** The seven checks in report order. Tests pin both the set and the order. */
export const PREFLIGHT_CHECK_NAMES = Object.freeze([
  'orca-runtime',
  'orca-session',
  'orca-repo',
  'orca-verbs',
  'git-version',
  'orca-enabled',
  'permission-posture',
]);

/** `git merge-tree --write-tree` (the landing preflight) needs 2.38. */
export const MIN_GIT_VERSION = Object.freeze({ major: 2, minor: 38 });

/** `agent-context` schemaVersion values this check was written against. Another value is `warn`, not `pass`. */
export const KNOWN_SCHEMA_VERSIONS = Object.freeze([1]);

/** Terminal identity Orca injects into every terminal it manages (the same handle a worker's `--from` carries). */
const SESSION_HANDLE_KEY = 'ORCA_TERMINAL_HANDLE';
/** Workspace identity variables; present without a terminal handle means "inside Orca, but not a terminal". */
const SESSION_WORKSPACE_KEYS = Object.freeze(['ORCA_WORKTREE_ID', 'ORCA_WORKSPACE_ID']);

const req = (command, ...flags) => Object.freeze({ command, flags: Object.freeze([...flags]) });

/**
 * Allowlist of the Orca verbs and flags DESIGN 4.4 / 4.1-4 / 11.2 / 11.6 use, flag names WITHOUT the leading
 * dashes (the form `orca agent-context --json` lists them in). `orca-verbs` reports every name that is absent
 * from the live schema, verbatim, and fails closed.
 *
 * Two groups, one list: the read verbs the scripts call themselves, and the state-changing verbs the LEADER
 * types one line at a time (the scripts only print those lines). Naming the second group here is what lets
 * preflight catch a renamed flag before the owner has approved a launch, not halfway through it.
 */
export const REQUIRED_ORCA_COMMANDS = Object.freeze([
  // Read verbs the scripts call (DESIGN 11.2).
  req('status', 'json'),
  req('repo list', 'json'),
  req('agent-context', 'json'),
  req('worktree show', 'worktree', 'json'),
  req('worktree list', 'json'),
  req('worktree ps', 'json'),
  req('orchestration worker-list', 'run', 'json'),
  req('orchestration task-list', 'run', 'json'),
  req('orchestration worker-show', 'dispatch', 'json'),
  req('orchestration inbox', 'terminal', 'limit', 'json'),
  req('orchestration check', 'peek', 'run', 'json'),
  req('terminal read', 'terminal', 'screen', 'json'),
  // Verbs the leader types (DESIGN 4.4 launch / wake handling / close / resume).
  req('orchestration run-create', 'objective', 'json'),
  req('orchestration run-use', 'id', 'json'),
  req('worktree create', 'name', 'branch', 'base-branch', 'parent-worktree', 'setup', 'json'),
  req('orchestration task-create', 'spec-file', 'task-title', 'json'),
  req('orchestration worker-start', 'task', 'worktree', 'agent', 'model', 'retry-of', 'json'),
  req('orchestration send', 'to', 'subject', 'body', 'json'),
  req('orchestration reply', 'id', 'body', 'json'),
  req('orchestration deny', 'dispatch', 'reason', 'json'),
  req('orchestration task-update', 'id', 'status', 'result', 'json'),
  req('orchestration worker-release', 'dispatch', 'json'),
  req('worktree rm', 'worktree', 'force', 'delete-branch', 'json'),
]);

const EXEC_TIMEOUT_MS = 30_000;
const EXEC_MAX_BUFFER = 64 * 1024 * 1024;

const USAGE = [
  'usage: node scripts/orca/preflight.mjs [--json] [--parent <root>] [--agent-context <file>]',
  '',
  '  --json                 print one JSON document: { ok, checks:[{name,status,detail}], orca:{appVersion,repoId,trust} }',
  '  --parent <root>        repo root to look up in `orca repo list` (default: the current directory)',
  '  --agent-context <file> read the CLI schema from a saved `orca agent-context --json` file instead of running it',
  '',
  'exit 0 when no check failed, 1 otherwise (a failed check or a usage error).',
].join('\n');

// ---------------------------------------------------------------------------------------------------------
// Process and text helpers
// ---------------------------------------------------------------------------------------------------------

const asText = (value) => (typeof value === 'string' ? value : '');

/**
 * Production executor. Shell-free (`execFileSync`), never throws: a failure comes back as `{ ok:false, ... }`
 * so every caller handles "could not run" and "ran and failed" through one shape.
 *
 * @param {string} file
 * @param {string[]} args
 * @param {{ cwd?: string, timeoutMs?: number }} [options]
 * @returns {{ ok: boolean, status: number|null, stdout: string, stderr: string, error: string|null }}
 */
export function defaultExec(file, args, options = {}) {
  try {
    const stdout = execFileSync(file, args, {
      encoding: 'utf8',
      cwd: options.cwd,
      timeout: options.timeoutMs ?? EXEC_TIMEOUT_MS,
      maxBuffer: EXEC_MAX_BUFFER,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, status: 0, stdout, stderr: '', error: null };
  } catch (err) {
    const status = typeof err?.status === 'number' ? err.status : null;
    return {
      ok: false,
      status,
      stdout: asText(err?.stdout),
      stderr: asText(err?.stderr),
      error: typeof err?.code === 'string' ? err.code : `exit ${status ?? '?'}`,
    };
  }
}

/** Parses JSON text (a leading BOM is dropped); never throws. Shared with plan.mjs. */
export function parseJsonText(text) {
  try {
    return { ok: true, value: JSON.parse(asText(text).replace(/^\u{FEFF}/u, '')) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function firstLine(text, max = 200) {
  const line = asText(text).split(/\r?\n/).map((s) => s.trim()).find(Boolean) ?? '';
  return line.length > max ? `${line.slice(0, max - 3)}...` : line;
}

const isNonEmpty = (value) => typeof value === 'string' && value.trim() !== '';

/** The message an Orca `{ ok:false, error }` envelope carries; `error` may be a string or `{ message }`. */
function envelopeMessage(doc) {
  const error = doc?.error;
  if (typeof error === 'string') return error;
  return isNonEmpty(error?.message) ? error.message : '';
}

/** One line saying why `program` could not deliver; `doc` is its parsed stdout when there was one. Shared with plan.mjs. */
export function describeFailure(res, doc, program = 'orca') {
  if (res.error === 'ENOENT') return `${program} 실행 파일을 PATH 에서 찾지 못했다`;
  if (res.error === 'ETIMEDOUT') return `응답 시간 초과(${EXEC_TIMEOUT_MS / 1000}초)`;
  const message = envelopeMessage(doc) || firstLine(res.stderr) || firstLine(res.stdout);
  return message || `종료 코드 ${res.status ?? '?'}`;
}

/**
 * The only Orca invocations this script makes (DESIGN 11.2: read verbs only). `callOrcaJson` refuses anything else,
 * so a state-changing verb cannot slip in by accident - it throws before the executor is reached.
 */
export const READ_ONLY_ORCA_VERBS = Object.freeze(['status', 'repo list', 'agent-context']);

/**
 * Runs an Orca read verb and returns its parsed JSON document, or a one-line reason.
 *
 * @param {typeof defaultExec} exec
 * @param {string[]} args e.g. `['status', '--json']`
 * @returns {{ ok: true, doc: any } | { ok: false, error: string }}
 * @throws {Error} when the verb is not in {@link READ_ONLY_ORCA_VERBS} (a programming error, not a runtime state)
 */
export function callOrcaJson(exec, args) {
  const verb = args.filter((arg) => !arg.startsWith('-')).slice(0, 2).join(' ');
  if (!READ_ONLY_ORCA_VERBS.includes(verb)) throw new Error(`refused: "orca ${verb}" is not a read-only verb of this script`);
  const res = exec('orca', args);
  const parsed = parseJsonText(res.stdout);
  if (!res.ok) return { ok: false, error: describeFailure(res, parsed.ok ? parsed.value : null, 'orca') };
  if (!parsed.ok) return { ok: false, error: `응답이 JSON 이 아니다(${parsed.error})` };
  if (parsed.value?.ok === false) return { ok: false, error: envelopeMessage(parsed.value) || 'ok:false 응답' };
  return { ok: true, doc: parsed.value };
}

const outcome = (name, status, detail, extra = {}) => ({ name, status, detail, ...extra });

// ---------------------------------------------------------------------------------------------------------
// The seven checks
// ---------------------------------------------------------------------------------------------------------

/** orca-runtime: the live runtime must be reachable AND ready; it also names the app version. */
function checkRuntime(exec, env) {
  const name = 'orca-runtime';
  const call = callOrcaJson(exec, ['status', '--json']);
  if (!call.ok) return outcome(name, 'fail', `Orca 런타임에 닿을 수 없다 - ${call.error}`);
  const result = call.doc?.result;
  const runtime = result?.runtime;
  if (runtime === null || typeof runtime !== 'object') {
    return outcome(name, 'fail', 'status 응답에 runtime 정보가 없다');
  }
  const graph = result.graph?.state;
  const problems = [];
  if (runtime.reachable !== true) problems.push(`runtime.reachable=${String(runtime.reachable)}`);
  if (runtime.state !== 'ready') problems.push(`runtime.state=${String(runtime.state)}`);
  if (graph !== undefined && graph !== 'ready') problems.push(`graph.state=${String(graph)}`);
  if (problems.length > 0) return outcome(name, 'fail', `Orca 런타임이 준비되지 않았다 - ${problems.join(', ')}`);
  const appVersion = [runtime.appVersion, env.ORCA_APP_VERSION].find(isNonEmpty) ?? null;
  const kind = result.target?.kind;
  const local = kind === undefined || kind === 'local';
  const detail = `Orca ${appVersion ?? '버전 미확인'} - runtime ready - graph ${graph ?? '미보고'}`;
  return outcome(name, local ? 'pass' : 'warn', local ? detail : `${detail} - target=${String(kind)} (로컬만 검증됨)`, { appVersion });
}

/** orca-session: is this process inside an Orca terminal (so Orca can wake it)? */
function checkSession(env) {
  const name = 'orca-session';
  if (isNonEmpty(env[SESSION_HANDLE_KEY])) return outcome(name, 'pass', `${SESSION_HANDLE_KEY} 있음 - Orca 터미널 세션`);
  const present = SESSION_WORKSPACE_KEYS.filter((key) => isNonEmpty(env[key]));
  if (present.length > 0) {
    return outcome(name, 'warn', `Orca 워크스페이스 안(${present.join(', ')})이지만 ${SESSION_HANDLE_KEY} 가 없다 - 채팅 세션이면 worker_done 기상 수신은 미확인`);
  }
  return outcome(name, 'fail', 'Orca 세션이 아니다(ORCA_* 식별 변수 없음) - worker_done 기상을 받을 수 없다. Orca 터미널 안에서 실행하라');
}

/** Best-effort canonical spelling: resolves links and 8.3 short names; a path that does not exist stays as given. */
export function realpathSafe(target) {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return target;
  }
}

/**
 * Comparable form of a repo path: forward slashes, no trailing slash, lower case when it is a drive path
 * (Windows file systems are case-insensitive; Orca stores both `C:/x` and `C:\x` spellings).
 */
export function normalizeRepoPath(target, realpath = realpathSafe) {
  if (!isNonEmpty(target)) return '';
  const unified = realpath(target).replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[A-Za-z]:/.test(unified) ? unified.toLowerCase() : unified;
}

/** The repo id inside `ORCA_WORKTREE_ID` (`<repoId>::<worktree path>`), or null. */
function callerRepoId(env) {
  const raw = env.ORCA_WORKTREE_ID;
  if (!isNonEmpty(raw)) return null;
  const at = raw.indexOf('::');
  return at > 0 ? raw.slice(0, at) : null;
}

function pickRepo(repos, { parentRoot, env, realpath }) {
  const target = normalizeRepoPath(parentRoot, realpath);
  const byPath = target === '' ? null : repos.find((repo) => normalizeRepoPath(repo?.path, realpath) === target) ?? null;
  const callerId = callerRepoId(env);
  const byCaller = callerId === null ? null : repos.find((repo) => repo?.id === callerId) ?? null;
  return { byPath, byCaller, callerId };
}

/** orca-repo: this repo must be a registered git repo; also yields repoId and the trust label. */
function checkRepo(exec, { parentRoot, env, realpath }) {
  const name = 'orca-repo';
  const call = callOrcaJson(exec, ['repo', 'list', '--json']);
  if (!call.ok) return outcome(name, 'fail', `repo list 실패 - ${call.error}`);
  const repos = call.doc?.result?.repos;
  if (!Array.isArray(repos)) return outcome(name, 'fail', 'repo list 응답에 repos 배열이 없다');
  const { byPath, byCaller, callerId } = pickRepo(repos, { parentRoot, env, realpath });
  if (byPath && callerId !== null && byPath.id !== callerId) {
    return outcome(name, 'fail', `parent 경로의 repo(${byPath.id})와 이 터미널의 워크스페이스 repo(${callerId})가 다르다 - 같은 리포 안에서 실행하라`);
  }
  const repo = byPath ?? byCaller;
  if (repo === null) {
    return outcome(name, 'fail', `이 리포가 Orca 에 등록되어 있지 않다(등록 ${repos.length}개 중 경로 일치 없음) - Orca 에서 리포를 추가하라`);
  }
  if (repo.kind !== 'git') {
    return outcome(name, 'fail', `등록은 되어 있으나 kind=${String(repo.kind)} 이다 - git 리포여야 worktree 를 만들 수 있다`, { repoId: repo.id ?? null });
  }
  const trust = isNonEmpty(repo.agentWorkspaceTrust) ? repo.agentWorkspaceTrust : null;
  const who = `${repo.displayName ?? repo.id} (${repo.id})`;
  // Matched by the caller's workspace only: the path itself is not a registered repo path (a subdirectory, or a linked
  // worktree). That is a guess about where run.json should live, so it is shown as a warning, not a pass.
  const [status, via] = byPath
    ? ['pass', 'parent 경로 일치']
    : ['warn', '호출 워크스페이스(ORCA_WORKTREE_ID) 기준으로만 일치 - parent 경로는 등록된 repo 경로가 아니다(하위 디렉터리이거나 링크된 worktree)'];
  return outcome(name, status, `${who} - ${via}`, { repoId: repo.id ?? null, trust });
}

function indexSchema(schema) {
  const root = Array.isArray(schema?.result?.commands) ? schema.result : schema;
  if (root === null || typeof root !== 'object' || !Array.isArray(root.commands)) {
    return { ok: false, reason: 'commands 배열이 없다' };
  }
  const flagsByCommand = new Map();
  for (const entry of root.commands) {
    if (typeof entry?.command !== 'string') continue;
    // Flag names are strings in the measured schema; anything else can never equal a required name and reads as missing.
    flagsByCommand.set(entry.command, new Set(Array.isArray(entry.flags) ? entry.flags : []));
  }
  return { ok: true, schemaVersion: root.schemaVersion, flagsByCommand };
}

/**
 * Pure verb/flag check against an `orca agent-context --json` document.
 * Fail-closed: every required name that is absent is returned verbatim in `missing`
 * (`<command>` when the command is gone, `<command> --<flag>` when only the flag is).
 *
 * @param {unknown} schema
 * @param {ReadonlyArray<{ command: string, flags: ReadonlyArray<string> }>} [required]
 * @returns {{ status: 'pass'|'warn'|'fail', detail: string, missing: string[] }}
 */
export function checkOrcaVerbs(schema, required = REQUIRED_ORCA_COMMANDS) {
  const index = indexSchema(schema);
  if (!index.ok) return { status: 'fail', detail: `agent-context 스키마 형태를 알 수 없다 - ${index.reason}`, missing: [] };
  const missing = [];
  for (const { command, flags } of required) {
    const have = index.flagsByCommand.get(command);
    if (have === undefined) {
      missing.push(command);
    } else {
      missing.push(...flags.filter((flag) => !have.has(flag)).map((flag) => `${command} --${flag}`));
    }
  }
  if (missing.length > 0) {
    return { status: 'fail', detail: `필수 verb·flag ${missing.length}건 누락: ${missing.join('; ')}`, missing };
  }
  const summary = `필수 ${required.length}개 명령·flag 전부 있음(schemaVersion ${String(index.schemaVersion)})`;
  if (!KNOWN_SCHEMA_VERSIONS.includes(index.schemaVersion)) {
    return { status: 'warn', detail: `${summary} - 알려진 schemaVersion(${KNOWN_SCHEMA_VERSIONS.join(',')})이 아니다`, missing };
  }
  return { status: 'pass', detail: summary, missing };
}

function readSchemaFile(file, { cwd, readFile }) {
  try {
    const parsed = parseJsonText(readFile(path.resolve(cwd, file)));
    return parsed.ok ? { ok: true, doc: parsed.value } : { ok: false, error: `${file}: JSON 이 아니다(${parsed.error})` };
  } catch (err) {
    return { ok: false, error: `${file}: 읽을 수 없다(${err.code ?? err.message})` };
  }
}

/** orca-verbs: schema from a saved file when given, else from `orca agent-context --json`. */
function checkVerbs(exec, { agentContextFile, cwd, readFile }) {
  const name = 'orca-verbs';
  const loaded = agentContextFile === null
    ? callOrcaJson(exec, ['agent-context', '--json'])
    : readSchemaFile(agentContextFile, { cwd, readFile });
  if (!loaded.ok) return outcome(name, 'fail', `agent-context 스키마를 얻지 못했다 - ${loaded.error}`);
  const verdict = checkOrcaVerbs(loaded.doc);
  return outcome(name, verdict.status, verdict.detail);
}

/** git-version: `git version 2.54.0.windows.1` -> 2.54 >= 2.38. */
function checkGit(exec) {
  const name = 'git-version';
  const res = exec('git', ['--version']);
  if (!res.ok) return outcome(name, 'fail', `git 을 실행할 수 없다 - ${describeFailure(res, null, 'git')}`);
  const match = /git version (\d+)\.(\d+)/.exec(asText(res.stdout));
  if (match === null) return outcome(name, 'fail', `git 버전을 읽을 수 없다: ${firstLine(res.stdout)}`);
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const enough = major > MIN_GIT_VERSION.major || (major === MIN_GIT_VERSION.major && minor >= MIN_GIT_VERSION.minor);
  const need = `${MIN_GIT_VERSION.major}.${MIN_GIT_VERSION.minor}`;
  return enough
    ? outcome(name, 'pass', `git ${major}.${minor} (>= ${need})`)
    : outcome(name, 'fail', `git ${major}.${minor} 은 너무 낮다(>= ${need} 필요)`);
}

/**
 * orca-enabled: the kill switch is an explicit `orca.enabled: false`, nothing else.
 *
 * An ABSENT `orca` block is normal, not a failure: an install whose artibot.config.json predates the block reads
 * `config.orca === undefined` after `loadConfig` (its DEFAULTS carry no `orca` key, like `split`), and the documented
 * defaults apply - `enabled` true, `agent` "claude", `branchPrefix` "orca/", `launch.requireApproval` true,
 * `stallCheckMinutes` 30. It is reported as `info`. This script reads only `enabled`; the others belong to the scripts
 * that use them. A block that is present but malformed (not an object, or a non-boolean `enabled`) fails closed:
 * a value somebody wrote on purpose, such as the string "false", must not read as "on".
 */
function checkEnabled(config, configError) {
  const name = 'orca-enabled';
  if (config === null || config === undefined) {
    return outcome(name, 'fail', `artibot.config.json 을 읽지 못해 킬스위치를 확인할 수 없다${configError ? ` - ${configError}` : ''}`);
  }
  const block = config.orca;
  if (block === undefined || block === null) return outcome(name, 'info', 'orca config block absent — defaults used (enabled=true)');
  if (typeof block !== 'object' || Array.isArray(block)) return outcome(name, 'fail', 'orca 설정 블록이 객체가 아니다');
  if (block.enabled === undefined) return outcome(name, 'pass', 'orca.enabled 미지정 - 기본 true');
  if (block.enabled === true) return outcome(name, 'pass', 'orca.enabled=true');
  if (block.enabled === false) return outcome(name, 'fail', 'orca.enabled=false - 킬스위치가 꺼져 있다. /split 을 쓰라');
  return outcome(name, 'fail', `orca.enabled 가 boolean 이 아니다(${JSON.stringify(block.enabled)}) - 안전하게 거부`);
}

/** permission-posture: ALWAYS info. Shows the repo trust label; never judges, never hard-codes this PC's mode. */
function checkPosture(trust) {
  const shown = trust === null ? '미확인(repo list 에 값이 없다)' : trust;
  return outcome('permission-posture', 'info',
    `repo trust(agentWorkspaceTrust)=${shown} - 워커는 Orca 새 에이전트 설정을 따른다. 권한 모드는 CLI 로 읽을 수 없다(P0-16) - Orca 설정에서 확인`);
}

const publicCheck = ({ name, status, detail }) => ({ name, status, detail });

/**
 * Runs the seven checks. Synchronous: every external call goes through the injected `exec`.
 *
 * @param {object} [options]
 * @param {string} [options.parentRoot] repo root to look up (default: cwd)
 * @param {Record<string, string|undefined>} [options.env]
 * @param {typeof defaultExec} [options.exec]
 * @param {object|null} [options.config] loaded artibot config (`null` = could not be loaded)
 * @param {string|null} [options.configError] why `config` is null
 * @param {string|null} [options.agentContextFile] saved schema to read instead of running the CLI
 * @param {string} [options.cwd] base for a relative `agentContextFile`
 * @param {(file: string) => string} [options.readFile]
 * @param {(p: string) => string} [options.realpath]
 * @returns {{ ok: boolean, checks: Array<{name: string, status: string, detail: string}>, orca: { appVersion: string|null, repoId: string|null, trust: string|null } }}
 */
export function runPreflight(options = {}) {
  const {
    parentRoot = process.cwd(), env = process.env, exec = defaultExec, config = null, configError = null,
    agentContextFile = null, cwd = process.cwd(), readFile = (file) => fs.readFileSync(file, 'utf8'), realpath = realpathSafe,
  } = options;
  const runtime = checkRuntime(exec, env);
  const repo = runtime.status === 'fail'
    ? outcome('orca-repo', 'warn', '미평가 - orca-runtime 이 실패했다')
    : checkRepo(exec, { parentRoot, env, realpath });
  const checks = [
    runtime,
    checkSession(env),
    repo,
    checkVerbs(exec, { agentContextFile, cwd, readFile }),
    checkGit(exec),
    checkEnabled(config, configError),
    checkPosture(repo.trust ?? null),
  ];
  return {
    ok: !checks.some((check) => check.status === 'fail'),
    checks: checks.map(publicCheck),
    orca: { appVersion: runtime.appVersion ?? null, repoId: repo.repoId ?? null, trust: repo.trust ?? null },
  };
}

// ---------------------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------------------

const CLI_OPTIONS = {
  json: { type: 'boolean' },
  parent: { type: 'string' },
  'agent-context': { type: 'string' },
  help: { type: 'boolean' },
};

/** @param {string[]} argv @returns {{ ok: true, value: object } | { ok: false, error: string }} */
export function parsePreflightArgs(argv) {
  try {
    const { values } = parseArgs({ args: argv, options: CLI_OPTIONS, strict: true, allowPositionals: false });
    return {
      ok: true,
      value: {
        json: values.json === true,
        parent: values.parent ?? null,
        agentContext: values['agent-context'] ?? null,
        help: values.help === true,
      },
    };
  } catch (err) {
    return { ok: false, error: `인자 오류: ${err.message}` };
  }
}

/** Human-readable report: one line per check, then the Orca summary line. */
export function formatPreflight(result) {
  const width = Math.max(...result.checks.map((check) => check.name.length));
  const lines = [`Orca preflight: ${result.ok ? 'PASS' : 'FAIL'}`];
  for (const check of result.checks) {
    lines.push(`  ${check.status.toUpperCase().padEnd(4)}  ${check.name.padEnd(width)}  ${check.detail}`);
  }
  const { appVersion, repoId, trust } = result.orca;
  lines.push(`Orca: appVersion=${appVersion ?? '미확인'} repoId=${repoId ?? '미확인'} trust=${trust ?? '미확인'}`);
  return lines.join('\n');
}

/** `artibot.config.json` through the shared loader; a failure is returned, not thrown. Shared with plan.mjs. */
export async function loadConfigSafe() {
  try {
    return { config: await loadConfig(), configError: null };
  } catch (err) {
    return { config: null, configError: err?.message ?? String(err) };
  }
}

/**
 * CLI body. Returns the exit code instead of exiting, so callers (and tests) own the process.
 *
 * @param {string[]} argv
 * @param {{ stdout?: (s: string) => void, stderr?: (s: string) => void, exec?: typeof defaultExec,
 *   env?: object, cwd?: string, config?: object|null, readFile?: (f: string) => string, realpath?: (p: string) => string }} [io]
 * @returns {Promise<number>}
 */
export async function main(argv, io = {}) {
  const stdout = io.stdout ?? ((text) => process.stdout.write(`${text}\n`));
  const stderr = io.stderr ?? ((text) => process.stderr.write(`${text}\n`));
  const parsed = parsePreflightArgs(argv);
  if (!parsed.ok) {
    if (argv.includes('--json')) stdout(JSON.stringify({ ok: false, error: parsed.error }, null, 2));
    else stderr(`${parsed.error}\n${USAGE}`);
    return 1;
  }
  if (parsed.value.help) {
    stdout(USAGE);
    return 0;
  }
  const cwd = io.cwd ?? process.cwd();
  const loaded = io.config === undefined ? await loadConfigSafe() : { config: io.config, configError: null };
  const result = runPreflight({
    parentRoot: path.resolve(cwd, parsed.value.parent ?? '.'),
    env: io.env ?? process.env,
    exec: io.exec ?? defaultExec,
    config: loaded.config,
    configError: loaded.configError,
    agentContextFile: parsed.value.agentContext,
    cwd,
    ...(io.readFile ? { readFile: io.readFile } : {}),
    ...(io.realpath ? { realpath: io.realpath } : {}),
  });
  stdout(parsed.value.json ? JSON.stringify(result, null, 2) : formatPreflight(result));
  return result.ok ? 0 : 1;
}

if (isMainEntry(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (err) => {
      process.stderr.write(`orca preflight: ${err?.message ?? err}\n`);
      process.exitCode = 1;
    },
  );
}
