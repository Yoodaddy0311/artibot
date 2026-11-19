/**
 * `scripts/orca/preflight.mjs` - the seven fail-closed readiness checks behind `/orca plan`.
 *
 * FIXTURES ARE REAL OUTPUT, NOT INVENTED: `tests/orca/fixtures/agent-context/` holds three files derived from live
 * Orca 1.4.259 output (2026-11-19) - the CLI schema reduced to the commands `REQUIRED_ORCA_COMMANDS` names, `status`
 * and `repo list` - with bulky fields dropped and personal paths and names replaced (PROVENANCE.md there). The
 * negative controls (a verb removed, a flag removed, a field flipped) are derived from those documents in memory.
 *
 * NO TEST CALLS THE REAL `orca`: in-process cases inject an executor, and `guardedExec` throws on any Orca verb
 * outside the read allowlist, so "zero state-changing calls" is enforced by every test. The process-level cases run
 * the script with an empty PATH.
 *
 * WHAT THIS FILE CANNOT SEE (rules 9): how `orca status` answers while Orca is NOT running (not measured - that
 * path is driven by a synthetic failure), whether a chat-session leader is woken by `worker_done`, and any behaviour
 * of the verbs themselves: only their NAMES are compared.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  callOrcaJson,
  checkOrcaVerbs,
  defaultExec,
  describeFailure,
  formatPreflight,
  KNOWN_SCHEMA_VERSIONS,
  main,
  MIN_GIT_VERSION,
  normalizeRepoPath,
  parseJsonText,
  parsePreflightArgs,
  PREFLIGHT_CHECK_NAMES,
  READ_ONLY_ORCA_VERBS,
  REQUIRED_ORCA_COMMANDS,
  runPreflight,
} from '../../scripts/orca/preflight.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(HERE, '..', '..', 'scripts', 'orca', 'preflight.mjs');
const FIXTURE_DIR = path.join(HERE, 'fixtures', 'agent-context');
const SCHEMA_FILE = path.join(FIXTURE_DIR, 'agent-context-1.4.259.excerpt.json');

const readFixture = (name) => fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
const SCHEMA_TEXT = fs.readFileSync(SCHEMA_FILE, 'utf8');
const STATUS_TEXT = readFixture('status-1.4.259.json');
const REPOS_TEXT = readFixture('repo-list-1.4.259.json');
const clone = (value) => JSON.parse(JSON.stringify(value));

const ARTIBOT_ID = 'd56eb7c9-5a43-4fcf-8c27-05cfbf914642';
const PARENT = '<HOME>/Desktop/AI/Artibot';
const ENV = Object.freeze({
  ORCA_TERMINAL_HANDLE: 'term_00000000-0000-4000-8000-000000000001',
  ORCA_WORKTREE_ID: `${ARTIBOT_ID}::${PARENT}`,
  ORCA_APP_VERSION: '1.4.259',
});

const identity = (value) => value;
const GUARD_ALLOWED_FIRST_ARGS = new Set(['status', 'repo', 'agent-context']);

const tmpDirs = [];
const makeTmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-orca-'));
  tmpDirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const okRes = (stdout) => ({ ok: true, status: 0, stdout, stderr: '', error: null });
const failRes = (over = {}) => ({ ok: false, status: 1, stdout: '', stderr: '', error: 'exit 1', ...over });

/**
 * Executor keyed by `<file> <args...>`. Throws on an Orca verb outside the read allowlist or on an unscripted
 * call, so a test cannot pass by accident while the script reaches for something it should not.
 */
function guardedExec(table) {
  const calls = [];
  const exec = (file, args) => {
    const key = `${file} ${args.join(' ')}`;
    calls.push(key);
    if (file === 'orca' && !GUARD_ALLOWED_FIRST_ARGS.has(args[0])) throw new Error(`state-changing or unknown orca verb: ${key}`);
    if (!(key in table)) throw new Error(`unscripted call: ${key}`);
    const entry = table[key];
    return typeof entry === 'function' ? entry() : entry;
  };
  exec.calls = calls;
  return exec;
}

const GOOD_TABLE = Object.freeze({
  'orca status --json': okRes(STATUS_TEXT),
  'orca repo list --json': okRes(REPOS_TEXT),
  'orca agent-context --json': okRes(SCHEMA_TEXT),
  'git --version': okRes('git version 2.54.0.windows.1\n'),
});

/** Preflight over the good fixtures; `over` replaces any option, `table` any scripted call. */
function run(over = {}, table = {}) {
  const exec = guardedExec({ ...GOOD_TABLE, ...table });
  const result = runPreflight({
    parentRoot: PARENT, env: ENV, exec, config: { orca: { enabled: true } }, agentContextFile: SCHEMA_FILE, realpath: identity, ...over,
  });
  return { result, exec };
}

const byName = (result, name) => result.checks.find((check) => check.name === name);

const withStatus = (mutate) => {
  const doc = clone(JSON.parse(STATUS_TEXT));
  mutate(doc);
  return okRes(JSON.stringify(doc));
};
const withRepos = (mutate) => {
  const doc = clone(JSON.parse(REPOS_TEXT));
  mutate(doc.result.repos);
  return okRes(JSON.stringify(doc));
};

describe('REQUIRED_ORCA_COMMANDS', () => {
  it('is a frozen allowlist of unique commands with unique, dash-less flag names', () => {
    expect(Object.isFrozen(REQUIRED_ORCA_COMMANDS)).toBe(true);
    const names = REQUIRED_ORCA_COMMANDS.map((entry) => entry.command);
    expect(new Set(names).size).toBe(names.length);
    for (const entry of REQUIRED_ORCA_COMMANDS) {
      expect(Object.isFrozen(entry)).toBe(true);
      expect(entry.flags.length).toBeGreaterThan(0);
      expect(new Set(entry.flags).size).toBe(entry.flags.length);
      for (const flag of entry.flags) expect(flag).toMatch(/^[a-z][a-z-]*$/);
    }
  });

  it('names the verbs the leader types as well as the read verbs the scripts call', () => {
    const names = new Set(REQUIRED_ORCA_COMMANDS.map((entry) => entry.command));
    const wanted = ['status', 'repo list', 'agent-context', 'orchestration check', 'orchestration worker-list', 'orchestration run-create',
      'worktree create', 'orchestration task-create', 'orchestration worker-start', 'orchestration worker-release', 'worktree rm'];
    for (const verb of wanted) expect(names.has(verb), verb).toBe(true);
  });

  it('pins the report order of the seven checks', () => {
    expect(PREFLIGHT_CHECK_NAMES).toEqual([
      'orca-runtime', 'orca-session', 'orca-repo', 'orca-verbs', 'git-version', 'orca-enabled', 'permission-posture',
    ]);
    expect(MIN_GIT_VERSION).toEqual({ major: 2, minor: 38 });
    expect(KNOWN_SCHEMA_VERSIONS).toEqual([1]);
  });
});

describe('callOrcaJson - the read-only gate', () => {
  it('is exactly the three read verbs the script uses, and preflight verifies each of them in the schema', () => {
    expect(Object.isFrozen(READ_ONLY_ORCA_VERBS)).toBe(true);
    expect([...READ_ONLY_ORCA_VERBS]).toEqual(['status', 'repo list', 'agent-context']);
    const required = new Set(REQUIRED_ORCA_COMMANDS.map((entry) => entry.command));
    for (const verb of READ_ONLY_ORCA_VERBS) expect(required.has(verb), verb).toBe(true);
  });

  it('refuses a state-changing, unknown or empty verb BEFORE the executor is reached', () => {
    const exec = guardedExec({});
    const refused = [
      ['worktree', 'rm', '--worktree', 'x', '--json'], ['worktree', 'create', '--json'], ['orchestration', 'worker-start', '--json'],
      ['orchestration', 'send', '--to', 'x'], ['orchestration', 'check', '--run', 'x'], ['status', 'extra'], ['repo', 'rm'], [], ['--json'],
    ];
    for (const args of refused) expect(() => callOrcaJson(exec, args), JSON.stringify(args)).toThrow(/refused/);
    expect(exec.calls).toEqual([]);
  });

  it('lets the three read verbs through (flags in any position) and returns the parsed document', () => {
    const answers = { status: '{"ok":true,"result":{"n":1}}', repo: '{"result":{"repos":[]}}', 'agent-context': '{"schemaVersion":1}' };
    const exec = (file, args) => okRes(answers[args.find((arg) => !arg.startsWith('-'))]); // the guard above is first-arg only
    expect(callOrcaJson(exec, ['--json', 'status'])).toEqual({ ok: true, doc: { ok: true, result: { n: 1 } } });
    expect(callOrcaJson(exec, ['repo', 'list', '--json']).ok).toBe(true);
    expect(callOrcaJson(exec, ['agent-context', '--json']).doc).toEqual({ schemaVersion: 1 });
  });

  it('turns a failing executor result into { ok:false, error } instead of throwing', () => {
    const exec = guardedExec({ 'orca status --json': failRes({ stderr: 'down\n' }) });
    expect(callOrcaJson(exec, ['status', '--json'])).toEqual({ ok: false, error: 'down' });
  });
});

describe('checkOrcaVerbs against the real 1.4.259 schema excerpt', () => {
  const schema = JSON.parse(SCHEMA_TEXT);

  it('passes: every required command and flag exists in the real schema', () => {
    const verdict = checkOrcaVerbs(schema);
    expect(verdict.missing).toEqual([]);
    expect(verdict.status).toBe('pass');
    expect(verdict.detail).toContain(`필수 ${REQUIRED_ORCA_COMMANDS.length}개`);
  });

  it('keeps the excerpt honest: schemaVersion and commandCount are the live values, and every command carries real flags', () => {
    expect(schema.schemaVersion).toBe(1);
    expect(schema.commandCount).toBe(334);
    expect(schema.commands.length).toBeLessThan(schema.commandCount);
    const have = new Set(schema.commands.map((entry) => entry.command));
    for (const { command } of REQUIRED_ORCA_COMMANDS) expect(have.has(command), command).toBe(true);
    for (const entry of schema.commands) {
      expect(entry.flags.every((flag) => typeof flag === 'string')).toBe(true);
      expect(entry.flags).toContain('json');
    }
  });

  it('negative control: a command removed from the schema fails and is named verbatim', () => {
    const variant = clone(schema);
    variant.commands = variant.commands.filter((entry) => entry.command !== 'orchestration worker-start');
    const verdict = checkOrcaVerbs(variant);
    expect(verdict.status).toBe('fail');
    expect(verdict.missing).toEqual(['orchestration worker-start']);
    expect(verdict.detail).toContain('orchestration worker-start');
  });

  it('negative control: a flag removed from one command fails and is named as `<command> --<flag>`', () => {
    const variant = clone(schema);
    const target = variant.commands.find((entry) => entry.command === 'orchestration worker-start');
    target.flags = target.flags.filter((flag) => flag !== 'retry-of');
    const verdict = checkOrcaVerbs(variant);
    expect(verdict.status).toBe('fail');
    expect(verdict.missing).toEqual(['orchestration worker-start --retry-of']);
  });

  it('reports every missing name, not just the first', () => {
    const variant = clone(schema);
    variant.commands = variant.commands.filter((entry) => entry.command !== 'worktree rm' && entry.command !== 'repo list');
    variant.commands.find((entry) => entry.command === 'orchestration check').flags = ['json'];
    const verdict = checkOrcaVerbs(variant);
    expect(verdict.status).toBe('fail');
    expect(verdict.missing).toEqual(expect.arrayContaining([
      'repo list', 'worktree rm', 'orchestration check --peek', 'orchestration check --run',
    ]));
    expect(verdict.missing).toHaveLength(4);
  });

  it('warns, not passes, on an unknown schemaVersion when nothing is missing', () => {
    const verdict = checkOrcaVerbs({ ...schema, schemaVersion: 2 });
    expect(verdict.status).toBe('warn');
    expect(verdict.missing).toEqual([]);
  });

  it('accepts the schema inside an { id, ok, result } envelope too', () => {
    expect(checkOrcaVerbs({ id: 'x', ok: true, result: schema }).status).toBe('pass');
  });

  it('fails closed on anything that is not a schema', () => {
    for (const bad of [null, undefined, 7, 'x', {}, { commands: 'nope' }, { result: { commands: {} } }]) {
      const verdict = checkOrcaVerbs(bad);
      expect(verdict.status, JSON.stringify(bad)).toBe('fail');
      expect(verdict.detail).toContain('스키마 형태');
    }
  });

  it('treats a command whose flags are not a string array as having no flags (every flag then reads as missing)', () => {
    const variant = clone(schema);
    variant.commands.find((entry) => entry.command === 'status').flags = [{ flag: 'json' }];
    const verdict = checkOrcaVerbs(variant);
    expect(verdict.status).toBe('fail');
    expect(verdict.missing).toEqual(['status --json']);
  });
});

describe('runPreflight - all green', () => {
  it('passes with the real fixtures, in the fixed order, and extracts appVersion / repoId / trust', () => {
    const { result } = run();
    expect(result.checks.map((check) => check.name)).toEqual(PREFLIGHT_CHECK_NAMES);
    expect(result.checks.map((check) => check.status)).toEqual(['pass', 'pass', 'pass', 'pass', 'pass', 'pass', 'info']);
    expect(result.ok).toBe(true);
    expect(result.orca).toEqual({ appVersion: '1.4.259', repoId: ARTIBOT_ID, trust: 'pre-trust' });
    expect(Object.keys(result.checks[0]).sort()).toEqual(['detail', 'name', 'status']);
  });

  it('makes exactly the read-only calls it should, and none that change Orca', () => {
    const fromFile = run();
    expect(fromFile.exec.calls).toEqual(['orca status --json', 'orca repo list --json', 'git --version']);
    const live = run({ agentContextFile: null });
    expect(live.exec.calls).toEqual(['orca status --json', 'orca repo list --json', 'orca agent-context --json', 'git --version']);
    expect(live.result.ok).toBe(true);
  });
});

describe('orca-runtime', () => {
  it('fails with a PATH hint when the orca binary cannot be started', () => {
    const { result, exec } = run({}, { 'orca status --json': failRes({ error: 'ENOENT', status: null }) });
    expect(byName(result, 'orca-runtime').status).toBe('fail');
    expect(byName(result, 'orca-runtime').detail).toContain('PATH 에서 찾지 못했다');
    expect(result.ok).toBe(false);
    expect(result.orca.appVersion).toBeNull();
    expect(exec.calls).not.toContain('orca repo list --json');
  });

  it('marks orca-repo as not evaluated (warn) instead of guessing when the runtime failed', () => {
    const { result } = run({}, { 'orca status --json': failRes({ stderr: 'runtime unavailable\n' }) });
    expect(byName(result, 'orca-runtime').detail).toContain('runtime unavailable');
    expect(byName(result, 'orca-repo')).toMatchObject({ status: 'warn' });
    expect(byName(result, 'orca-repo').detail).toContain('미평가');
    expect(byName(result, 'permission-posture').status).toBe('info');
    expect(result.ok).toBe(false);
  });

  it('fails on a timeout', () => {
    expect(byName(run({}, { 'orca status --json': failRes({ error: 'ETIMEDOUT', status: null }) }).result, 'orca-runtime').detail).toContain('시간 초과');
  });

  it('fails when the runtime is not reachable, not ready, or the graph is not ready', () => {
    const cases = [
      [(doc) => { doc.result.runtime.reachable = false; }, 'runtime.reachable=false'],
      [(doc) => { doc.result.runtime.state = 'starting'; }, 'runtime.state=starting'],
      [(doc) => { doc.result.graph.state = 'loading'; }, 'graph.state=loading'],
    ];
    for (const [mutate, needle] of cases) {
      const { result } = run({}, { 'orca status --json': withStatus(mutate) });
      expect(byName(result, 'orca-runtime').status, needle).toBe('fail');
      expect(byName(result, 'orca-runtime').detail).toContain(needle);
      expect(result.ok).toBe(false);
    }
  });

  it('fails on a body that is not JSON, an ok:false envelope, and a response without runtime', () => {
    const notJson = run({}, { 'orca status --json': okRes('Orca is not running') });
    expect(byName(notJson.result, 'orca-runtime').detail).toContain('JSON');
    const refused = run({}, { 'orca status --json': okRes(JSON.stringify({ id: 'x', ok: false, error: { code: 'x', message: 'runtime offline' } })) });
    expect(byName(refused.result, 'orca-runtime').detail).toContain('runtime offline');
    const empty = run({}, { 'orca status --json': okRes(JSON.stringify({ id: 'x', ok: true, result: {} })) });
    expect(byName(empty.result, 'orca-runtime').detail).toContain('runtime 정보가 없다');
    for (const outcome of [notJson, refused, empty]) expect(outcome.result.ok).toBe(false);
  });

  it('reads the version from the runtime first, then ORCA_APP_VERSION, else reports it unknown', () => {
    const fromRuntime = run({ env: { ...ENV, ORCA_APP_VERSION: '0.0.1' } });
    expect(fromRuntime.result.orca.appVersion).toBe('1.4.259');
    const noRuntimeVersion = withStatus((doc) => { delete doc.result.runtime.appVersion; });
    expect(run({}, { 'orca status --json': noRuntimeVersion }).result.orca.appVersion).toBe('1.4.259');
    const neither = run({ env: { ORCA_TERMINAL_HANDLE: ENV.ORCA_TERMINAL_HANDLE } }, { 'orca status --json': noRuntimeVersion });
    expect(neither.result.orca.appVersion).toBeNull();
    expect(byName(neither.result, 'orca-runtime').detail).toContain('버전 미확인');
    expect(byName(neither.result, 'orca-runtime').status).toBe('pass');
  });

  it('warns when the target is not the local runtime (only local was verified)', () => {
    const remote = withStatus((doc) => { doc.result.target.kind = 'remote'; });
    const { result } = run({}, { 'orca status --json': remote });
    expect(byName(result, 'orca-runtime').status).toBe('warn');
    expect(byName(result, 'orca-runtime').detail).toContain('로컬만 검증됨');
    expect(result.ok).toBe(true);
  });

  it('tolerates a UTF-8 BOM in front of the JSON', () => {
    const bom = String.fromCodePoint(0xfeff);
    const { result } = run({}, { 'orca status --json': okRes(`${bom}${STATUS_TEXT}`) });
    expect(byName(result, 'orca-runtime').status).toBe('pass');
  });
});

describe('orca-session', () => {
  it('warns (not passes) with workspace identity but no terminal handle - a chat leader is unmeasured', () => {
    const { result } = run({ env: { ORCA_WORKTREE_ID: ENV.ORCA_WORKTREE_ID } });
    expect(byName(result, 'orca-session').status).toBe('warn');
    expect(byName(result, 'orca-session').detail).toContain('미확인');
    expect(result.ok).toBe(true);
  });

  it('fails outside Orca: no ORCA_* identity at all, or blank values', () => {
    for (const env of [{}, { ORCA_TERMINAL_HANDLE: '', ORCA_WORKTREE_ID: '  ' }, { ORCA_APP_VERSION: '1.4.259' }]) {
      const { result } = run({ env });
      expect(byName(result, 'orca-session').status, JSON.stringify(env)).toBe('fail');
      expect(result.ok).toBe(false);
    }
  });
});

describe('orca-repo', () => {
  it('matches the registered path whatever the separator style (slash entry, backslash entry)', () => {
    const slash = run({ parentRoot: '<HOME>/Desktop/AI/Artibot/', env: { ORCA_TERMINAL_HANDLE: ENV.ORCA_TERMINAL_HANDLE } });
    expect(byName(slash.result, 'orca-repo').status).toBe('pass');
    expect(slash.result.orca.repoId).toBe(ARTIBOT_ID);
    const backslash = run({ parentRoot: '<HOME>/Desktop/AI/Other-A', env: { ORCA_TERMINAL_HANDLE: ENV.ORCA_TERMINAL_HANDLE } });
    expect(byName(backslash.result, 'orca-repo').status).toBe('pass');
    expect(backslash.result.orca.repoId).toBe('154fc440-97bb-4b06-b459-8c5c6c4f6ff6');
    expect(byName(backslash.result, 'orca-repo').detail).toContain('parent 경로 일치');
  });

  it('compares drive paths case-insensitively and ignores a trailing separator', () => {
    const repos = withRepos((list) => { list[0].path = 'D:\\Work\\Repo\\'; });
    const { result } = run({ parentRoot: 'd:/work/repo', env: { ORCA_TERMINAL_HANDLE: ENV.ORCA_TERMINAL_HANDLE } }, { 'orca repo list --json': repos });
    expect(byName(result, 'orca-repo').status).toBe('pass');
    expect(normalizeRepoPath('D:\\Work\\Repo\\', identity)).toBe('d:/work/repo');
    expect(normalizeRepoPath('/srv/Repo/', identity)).toBe('/srv/Repo'); // POSIX paths keep their case
    expect(normalizeRepoPath('', identity)).toBe('');
    expect(normalizeRepoPath(undefined, identity)).toBe('');
  });

  it('fails when the repo is not registered, and says how many were looked at', () => {
    const { result } = run({ parentRoot: '<HOME>/Desktop/AI/Elsewhere', env: { ORCA_TERMINAL_HANDLE: ENV.ORCA_TERMINAL_HANDLE } });
    expect(byName(result, 'orca-repo').status).toBe('fail');
    expect(byName(result, 'orca-repo').detail).toContain('등록 4개');
    expect(result.ok).toBe(false);
    expect(result.orca.repoId).toBeNull();
  });

  it('never matches an empty parent root against an entry without a path', () => {
    const repos = withRepos((list) => { delete list[0].path; });
    const { result } = run({ parentRoot: '', env: { ORCA_TERMINAL_HANDLE: ENV.ORCA_TERMINAL_HANDLE } }, { 'orca repo list --json': repos });
    expect(byName(result, 'orca-repo').status).toBe('fail');
  });

  it('rejects a registered folder (kind != git): worktrees need a git repo', () => {
    const { result } = run({ parentRoot: '<HOME>/Desktop/AI/Other-C', env: { ORCA_TERMINAL_HANDLE: ENV.ORCA_TERMINAL_HANDLE } });
    expect(byName(result, 'orca-repo').status).toBe('fail');
    expect(byName(result, 'orca-repo').detail).toContain('kind=folder');
  });

  it('falls back to the caller workspace when the path matches nothing (a subdirectory, a linked worktree) - as a WARNING, not a pass', () => {
    const { result } = run({ parentRoot: '<HOME>/orca/workspaces/Artibot/some-worktree' });
    expect(byName(result, 'orca-repo').status).toBe('warn');
    expect(byName(result, 'orca-repo').detail).toContain('ORCA_WORKTREE_ID');
    expect(byName(result, 'orca-repo').detail).toContain('등록된 repo 경로가 아니다');
    expect(result.orca.repoId).toBe(ARTIBOT_ID);
    expect(result.ok).toBe(true);
  });

  it('fails when the parent path and the terminal workspace point at different repos', () => {
    const { result } = run({ parentRoot: '<HOME>/Desktop/AI/Other-B' });
    expect(byName(result, 'orca-repo').status).toBe('fail');
    expect(byName(result, 'orca-repo').detail).toContain('다르다');
    expect(result.ok).toBe(false);
  });

  it('reports the trust label as null when repo list carries none (a real entry without agentWorkspaceTrust)', () => {
    const { result } = run({ parentRoot: '<HOME>/Desktop/AI/Other-B', env: { ORCA_TERMINAL_HANDLE: ENV.ORCA_TERMINAL_HANDLE } });
    expect(byName(result, 'orca-repo').status).toBe('pass');
    expect(result.orca.trust).toBeNull();
    expect(byName(result, 'permission-posture').detail).toContain('미확인');
  });

  it('fails on repo list failure and on a body without a repos array', () => {
    const down = run({}, { 'orca repo list --json': failRes({ stderr: 'boom\n' }) });
    expect(byName(down.result, 'orca-repo').detail).toContain('boom');
    const odd = run({}, { 'orca repo list --json': okRes(JSON.stringify({ id: 'x', ok: true, result: {} })) });
    expect(byName(odd.result, 'orca-repo').detail).toContain('repos 배열');
    expect(down.result.ok).toBe(false);
    expect(odd.result.ok).toBe(false);
  });

  it('canonicalises through realpath on both sides before comparing', () => {
    const seen = [];
    const realpath = (value) => { seen.push(value); return value.replace('short~1', 'long-name'); };
    const repos = withRepos((list) => { list[0].path = '/data/long-name/repo'; });
    const { result } = run({ parentRoot: '/data/short~1/repo', realpath, env: { ORCA_TERMINAL_HANDLE: ENV.ORCA_TERMINAL_HANDLE } }, { 'orca repo list --json': repos });
    expect(byName(result, 'orca-repo').status).toBe('pass');
    expect(seen).toContain('/data/short~1/repo');
  });

  it('the default realpath makes an existing directory equal to its canonical spelling (8.3 short names on Windows)', () => {
    const tmp = makeTmp(); // os.tmpdir() is spelled with a short name on some Windows setups
    expect(normalizeRepoPath(tmp)).toBe(normalizeRepoPath(fs.realpathSync.native(tmp)));
  });
});

describe('orca-verbs', () => {
  it('reads the schema from the CLI when no file is given, and from the file when one is', () => {
    expect(byName(run({ agentContextFile: null }).result, 'orca-verbs').status).toBe('pass');
    expect(byName(run().result, 'orca-verbs').status).toBe('pass');
  });

  it('fails closed and names the missing verb when the live schema lacks one', () => {
    const variant = clone(JSON.parse(SCHEMA_TEXT));
    variant.commands = variant.commands.filter((entry) => entry.command !== 'orchestration worker-release');
    const { result } = run({ agentContextFile: null }, { 'orca agent-context --json': okRes(JSON.stringify(variant)) });
    expect(byName(result, 'orca-verbs').status).toBe('fail');
    expect(byName(result, 'orca-verbs').detail).toContain('orchestration worker-release');
    expect(result.ok).toBe(false);
  });

  it('fails when the schema cannot be obtained: CLI failure, missing file, unparseable file', () => {
    const cli = run({ agentContextFile: null }, { 'orca agent-context --json': failRes({ stderr: 'no schema\n' }) });
    expect(byName(cli.result, 'orca-verbs').detail).toContain('no schema');
    const missing = run({ agentContextFile: 'no-such-file.json', cwd: os.tmpdir() });
    expect(byName(missing.result, 'orca-verbs').status).toBe('fail');
    expect(byName(missing.result, 'orca-verbs').detail).toContain('읽을 수 없다');
    const garbage = run({ agentContextFile: 'x.json', readFile: () => '{ not json' });
    expect(byName(garbage.result, 'orca-verbs').detail).toContain('JSON');
    for (const outcome of [cli, missing, garbage]) expect(outcome.result.ok).toBe(false);
  });

  it('strips a BOM and resolves a relative schema path against cwd', () => {
    const bom = String.fromCodePoint(0xfeff);
    const seen = [];
    const readFile = (file) => { seen.push(file); return `${bom}${SCHEMA_TEXT}`; };
    const { result } = run({ agentContextFile: 'schema.json', cwd: FIXTURE_DIR, readFile });
    expect(byName(result, 'orca-verbs').status).toBe('pass');
    expect(seen).toEqual([path.join(FIXTURE_DIR, 'schema.json')]);
  });
});

describe('git-version', () => {
  const verdict = (stdout, over = {}) => byName(run({}, { 'git --version': { ...okRes(stdout), ...over } }).result, 'git-version');

  it('passes at and above 2.38, including a Windows build string', () => {
    for (const text of ['git version 2.38.0', 'git version 2.54.0.windows.1', 'git version 3.0.1', 'git version 2.100.0']) {
      expect(verdict(text).status, text).toBe('pass');
    }
  });

  it('fails below 2.38 and says what is needed', () => {
    for (const text of ['git version 2.37.9', 'git version 1.99.0', 'git version 2.9.5']) {
      expect(verdict(text).status, text).toBe('fail');
    }
    expect(verdict('git version 2.30.0').detail).toContain('2.38');
  });

  it('fails when the version cannot be read or git cannot run, and names git (not orca) when it is missing', () => {
    expect(verdict('something else').status).toBe('fail');
    const missing = verdict('', failRes({ error: 'ENOENT', status: null }));
    expect(missing.status).toBe('fail');
    expect(missing.detail).toContain('git 실행 파일을 PATH 에서 찾지 못했다');
    expect(missing.detail).not.toContain('orca');
  });
});

describe('describeFailure and parseJsonText (shared with plan.mjs)', () => {
  it('names the program that could not be started, and keeps the timeout and exit-code fallbacks', () => {
    expect(describeFailure(failRes({ error: 'ENOENT' }), null, 'git')).toBe('git 실행 파일을 PATH 에서 찾지 못했다');
    expect(describeFailure(failRes({ error: 'ENOENT' }), null)).toBe('orca 실행 파일을 PATH 에서 찾지 못했다');
    expect(describeFailure(failRes({ error: 'ETIMEDOUT' }), null)).toContain('시간 초과');
    expect(describeFailure(failRes({ status: 7, error: 'exit 7' }), null)).toBe('종료 코드 7');
  });

  it('prefers the envelope message, then the first stderr line, then stdout', () => {
    const doc = { ok: false, error: { message: 'from envelope' } };
    expect(describeFailure(failRes({ stderr: 'from stderr\nsecond\n' }), doc)).toBe('from envelope');
    expect(describeFailure(failRes({ stderr: '\n  from stderr  \nsecond\n' }), null)).toBe('from stderr');
    expect(describeFailure(failRes({ stdout: 'only stdout' }), null)).toBe('only stdout');
    expect(describeFailure(failRes({ stderr: 'x'.repeat(500) }), null).length).toBeLessThanOrEqual(200);
  });

  it('parseJsonText drops a BOM and reports garbage without throwing', () => {
    expect(parseJsonText(`${String.fromCodePoint(0xfeff)}{"a":1}`)).toEqual({ ok: true, value: { a: 1 } });
    expect(parseJsonText('{ nope').ok).toBe(false);
    expect(parseJsonText('').ok).toBe(false);
    expect(parseJsonText(undefined).ok).toBe(false);
  });
});

describe('orca-enabled', () => {
  const verdict = (config, configError = null) => byName(run({ config, configError }).result, 'orca-enabled');

  it('treats an absent orca block as normal: info "defaults used", never a failure (an install that predates the block)', () => {
    for (const config of [{}, { orca: null }, { split: { maxWindows: 8 } }]) {
      expect(verdict(config), JSON.stringify(config)).toMatchObject({ status: 'info', detail: expect.stringContaining('orca config block absent — defaults used') });
      expect(run({ config }).result.ok).toBe(true);
    }
  });

  it('passes when the block is present and enabled is unset or the literal true', () => {
    for (const config of [{ orca: {} }, { orca: { enabled: true, agent: 'claude' } }]) expect(verdict(config).status, JSON.stringify(config)).toBe('pass');
  });

  it('fails on the kill switch and points at /split', () => {
    expect(verdict({ orca: { enabled: false } })).toMatchObject({ status: 'fail', detail: expect.stringContaining('/split') });
    expect(run({ config: { orca: { enabled: false } } }).result.ok).toBe(false);
  });

  it('fails closed on anything that is neither absent nor a boolean', () => {
    for (const config of [{ orca: { enabled: 'false' } }, { orca: { enabled: 0 } }, { orca: { enabled: null } }, { orca: 'on' }, { orca: [] }]) {
      expect(verdict(config).status, JSON.stringify(config)).toBe('fail');
    }
  });

  it('fails when the config could not be loaded, and passes the reason along', () => {
    expect(verdict(null, 'unreadable')).toMatchObject({ status: 'fail', detail: expect.stringContaining('unreadable') });
  });
});

describe('permission-posture', () => {
  it('is always info, shows the trust label, and never states a permission mode', () => {
    const { result } = run();
    const posture = byName(result, 'permission-posture');
    expect(posture.status).toBe('info');
    expect(posture.detail).toContain('pre-trust');
    expect(posture.detail).toContain('CLI 로 읽을 수 없다');
    expect(posture.detail.toLowerCase()).not.toContain('bypass');
  });

  it('stays info even when everything else fails', () => {
    const { result } = run({ env: {}, config: { orca: { enabled: false } } }, {
      'orca status --json': failRes({ error: 'ENOENT', status: null }),
      'git --version': failRes({ error: 'ENOENT', status: null }),
    });
    expect(result.ok).toBe(false);
    expect(byName(result, 'permission-posture').status).toBe('info');
    // orca-repo is `warn` (not evaluated) and orca-verbs reads the saved schema file, so neither is in the list.
    expect(result.checks.filter((check) => check.status === 'fail').map((check) => check.name))
      .toEqual(['orca-runtime', 'orca-session', 'git-version', 'orca-enabled']);
  });
});

describe('formatPreflight', () => {
  it('prints a verdict line, one line per check, and the Orca summary', () => {
    const text = formatPreflight(run().result);
    const lines = text.split('\n');
    expect(lines[0]).toBe('Orca preflight: PASS');
    expect(lines).toHaveLength(1 + PREFLIGHT_CHECK_NAMES.length + 1);
    expect(lines[1]).toMatch(/^ {2}PASS {2}orca-runtime {2}/);
    expect(lines[7]).toMatch(/^ {2}INFO {2}permission-posture {2}/);
    expect(lines[8]).toBe(`Orca: appVersion=1.4.259 repoId=${ARTIBOT_ID} trust=pre-trust`);
  });

  it('says FAIL when a check failed', () => {
    expect(formatPreflight(run({ env: {} }).result)).toMatch(/^Orca preflight: FAIL\n[\s\S]*FAIL {2}orca-session/);
  });
});

describe('parsePreflightArgs', () => {
  it('parses the three documented flags (space and equals forms)', () => {
    expect(parsePreflightArgs([])).toEqual({ ok: true, value: { json: false, parent: null, agentContext: null, help: false } });
    expect(parsePreflightArgs(['--json', '--parent', 'a b', '--agent-context=x.json'])).toEqual({
      ok: true, value: { json: true, parent: 'a b', agentContext: 'x.json', help: false },
    });
    expect(parsePreflightArgs(['--help']).value.help).toBe(true);
  });

  it('rejects unknown flags, positionals and a flag missing its value', () => {
    for (const argv of [['--nope'], ['stray'], ['--parent'], ['--json=yes']]) {
      const parsed = parsePreflightArgs(argv);
      expect(parsed.ok, JSON.stringify(argv)).toBe(false);
      expect(parsed.error).toContain('인자 오류');
    }
  });
});

describe('main', () => {
  const capture = () => {
    const out = [];
    const err = [];
    return { io: { stdout: (text) => out.push(text), stderr: (text) => err.push(text) }, out, err };
  };
  // `--parent PARENT` resolves against cwd (HERE), so the registered path must be that resolved spelling for a real path match.
  const MAIN_TABLE = { ...GOOD_TABLE, 'orca repo list --json': withRepos((list) => { list[0].path = path.resolve(HERE, PARENT); }) };
  const baseIo = (sink, over = {}) => ({
    ...sink.io, exec: guardedExec(MAIN_TABLE), env: ENV, cwd: '.', config: {}, realpath: identity, ...over,
  });

  it('--json prints exactly one JSON document and exits 0 when nothing failed', async () => {
    const sink = capture();
    const code = await main(['--json', '--parent', PARENT, '--agent-context', SCHEMA_FILE], baseIo(sink, { cwd: HERE }));
    expect(code).toBe(0);
    expect(sink.out).toHaveLength(1);
    const doc = JSON.parse(sink.out[0]);
    expect(doc.ok).toBe(true);
    expect(doc.checks).toHaveLength(7);
    expect(doc.checks.find((check) => check.name === 'orca-repo').status).toBe('pass');
    expect(doc.orca.repoId).toBe(ARTIBOT_ID);
    expect(sink.err).toEqual([]);
  });

  it('exits 1 with the full document when a check fails (--json) and with the table otherwise', async () => {
    const failing = guardedExec({ ...MAIN_TABLE, 'git --version': okRes('git version 2.1.0') });
    const jsonSink = capture();
    expect(await main(['--json', '--parent', PARENT, '--agent-context', SCHEMA_FILE], baseIo(jsonSink, { exec: failing, cwd: HERE }))).toBe(1);
    const doc = JSON.parse(jsonSink.out[0]);
    expect(doc.ok).toBe(false);
    expect(doc.checks.find((check) => check.name === 'git-version').status).toBe('fail');

    const tableSink = capture();
    expect(await main(['--parent', PARENT, '--agent-context', SCHEMA_FILE], baseIo(tableSink, { exec: guardedExec({ ...MAIN_TABLE, 'git --version': okRes('git version 2.1.0') }), cwd: HERE }))).toBe(1);
    expect(tableSink.out[0].split('\n')[0]).toBe('Orca preflight: FAIL');
  });

  it('resolves --parent against cwd', async () => {
    const tmp = makeTmp();
    const repoPath = path.join(tmp, 'repo');
    fs.mkdirSync(repoPath);
    const repos = withRepos((list) => { list[0].path = repoPath; });
    const exec = guardedExec({ ...GOOD_TABLE, 'orca repo list --json': repos });
    const sink = capture();
    const code = await main(['--json', '--parent', 'repo', '--agent-context', SCHEMA_FILE], baseIo(sink, { exec, cwd: tmp, env: { ORCA_TERMINAL_HANDLE: ENV.ORCA_TERMINAL_HANDLE } }));
    expect(code).toBe(0);
    expect(JSON.parse(sink.out[0]).orca.repoId).toBe(ARTIBOT_ID);
  });

  it('--help prints the usage on stdout and exits 0 without calling anything', async () => {
    const sink = capture();
    const exec = guardedExec({});
    expect(await main(['--help'], baseIo(sink, { exec }))).toBe(0);
    expect(sink.out[0]).toContain('usage: node scripts/orca/preflight.mjs');
    expect(exec.calls).toEqual([]);
  });

  it('a usage error exits 1: usage on stderr, or { ok:false, error } on stdout under --json', async () => {
    const plain = capture();
    expect(await main(['--bogus'], baseIo(plain))).toBe(1);
    expect(plain.out).toEqual([]);
    expect(plain.err[0]).toContain('인자 오류');
    const json = capture();
    expect(await main(['--json', '--bogus'], baseIo(json))).toBe(1);
    expect(JSON.parse(json.out[0])).toMatchObject({ ok: false });
    expect(json.err).toEqual([]);
  });

  it('reads the real artibot.config.json when no config is injected, and the kill switch is not thrown', async () => {
    const sink = capture();
    const io = baseIo(sink, { cwd: HERE });
    delete io.config;
    await main(['--json', '--parent', PARENT, '--agent-context', SCHEMA_FILE], io);
    const doc = JSON.parse(sink.out[0]);
    expect(doc.checks.find((check) => check.name === 'orca-enabled').status).toBe('pass');
  });
});

describe('defaultExec (the production executor)', () => {
  it('returns stdout on success without a shell', () => {
    const res = defaultExec(process.execPath, ['-e', 'process.stdout.write("a b|c")']);
    expect(res).toEqual({ ok: true, status: 0, stdout: 'a b|c', stderr: '', error: null });
  });

  it('returns a structured failure instead of throwing: exit code, stderr, ENOENT, timeout', () => {
    const exit = defaultExec(process.execPath, ['-e', 'process.stderr.write("bad"); process.exit(3)']);
    expect(exit).toMatchObject({ ok: false, status: 3, stderr: 'bad', error: 'exit 3' });
    const missing = defaultExec('definitely-not-a-real-binary-xyz', ['--version']);
    expect(missing).toMatchObject({ ok: false, error: 'ENOENT' });
    const slow = defaultExec(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { timeoutMs: 300 });
    expect(slow).toMatchObject({ ok: false, error: 'ETIMEDOUT' });
  });

  it('passes shell metacharacters through as plain arguments', () => {
    const res = defaultExec(process.execPath, ['-e', 'process.stdout.write(process.argv.slice(1).join("|"))', '&& echo pwned', '$(x)']);
    expect(res.stdout).toBe('&& echo pwned|$(x)');
  });
});

describe('the script as a process', () => {
  const emptyPathEnv = () => ({ PATH: '', SystemRoot: process.env.SystemRoot, windir: process.env.windir });
  const spawnCli = (args, cwd) => spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8', env: emptyPathEnv(), cwd, timeout: 60_000, windowsHide: true,
  });

  it('--help exits 0 (the direct-run guard fires) and prints usage', () => {
    const res = spawnCli(['--help'], makeTmp());
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('usage: node scripts/orca/preflight.mjs');
  });

  it('an unknown flag exits 1 with the message on stderr', () => {
    const res = spawnCli(['--bogus'], makeTmp());
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('인자 오류');
  });

  it('with no orca or git on PATH it fails closed: exit 1 and one JSON document with every check present', () => {
    const res = spawnCli(['--json', '--agent-context', SCHEMA_FILE], makeTmp());
    expect(res.status).toBe(1);
    const doc = JSON.parse(res.stdout);
    expect(doc.ok).toBe(false);
    expect(doc.checks.map((check) => check.name)).toEqual(PREFLIGHT_CHECK_NAMES);
    const status = Object.fromEntries(doc.checks.map((check) => [check.name, check.status]));
    expect(status['orca-runtime']).toBe('fail');
    expect(status['git-version']).toBe('fail');
    expect(status['orca-verbs']).toBe('pass');
    expect(status['permission-posture']).toBe('info');
    expect(doc.checks.find((check) => check.name === 'orca-runtime').detail).toContain('PATH 에서 찾지 못했다');
  });
});

describe('source pins', () => {
  const source = fs.readFileSync(SCRIPT, 'utf8');
  /** Names imported from node:child_process, one list per import statement. */
  const childProcessImports = (text) => [...text.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"](?:node:)?child_process['"]/g)]
    .map((match) => match[1].split(',').map((name) => name.trim()).filter(Boolean));
  const usesShellOption = (text) => /\bshell\s*:/.test(text);

  it('the scanners see what they claim to see (self-check)', () => {
    expect(childProcessImports("import { execSync } from 'node:child_process';")).toEqual([['execSync']]);
    expect(childProcessImports('import { spawn, execFileSync } from "child_process"')).toEqual([['spawn', 'execFileSync']]);
    expect(childProcessImports("import fs from 'node:fs';")).toEqual([]);
    expect(usesShellOption('execFileSync("a", [], { shell: true })')).toBe(true);
    expect(usesShellOption('execFileSync("a", [], { windowsHide: true })')).toBe(false);
  });

  it('spawns only through execFileSync (shell-free), from exactly one call site, with no shell option', () => {
    expect(childProcessImports(source)).toEqual([['execFileSync']]);
    expect(source.match(/execFileSync\s*\(/g)).toHaveLength(1);
    expect(usesShellOption(source)).toBe(false);
  });

  it('keeps the entry decision on isMainEntry(import.meta.url) and hides no BOM or no-break space literal', () => {
    expect(source).toContain('isMainEntry(import.meta.url)');
    expect(source.includes(String.fromCodePoint(0xfeff))).toBe(false);
    expect(source.includes(String.fromCodePoint(0x00a0))).toBe(false);
    expect(source.includes(String.fromCodePoint(0x200b))).toBe(false);
  });
});
