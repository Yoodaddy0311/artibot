#!/usr/bin/env node
/**
 * PC handoff runner for the 2026-10-23 practicality work — the executable form
 * of `07_PC_HANDOFF.md` in this folder. A fresh session on the owner's PC runs
 * it first and follows what it prints.
 *
 *   node .artibot/guides/v5-design/practicality-improvement-20261023/pc-handoff.mjs [command] [flags]
 *
 *   (none) | start     check + the ordered next steps + the kickoff prompt
 *   check              branch / HEAD / clean · node · claude --version and flags ·
 *                      installed plugin vs this branch · state dir · ledger · vitest
 *   census             run the three live denominators (07 §A-2) and write the
 *                      evidence file  [--out <file>] [--state-dir <dir>]
 *                      [--store-dir <dir>] [--since <iso|epoch-ms>] [--dry-run]
 *   tests              the three Windows-sensitive test files (07 §A-4)
 *                      [--full] [--max-workers <n>]
 *   host-probe         print the host integration commands (07 §A-3, costs cents)
 *                      — or verify a finished run: --verify [--state-dir <dir>]
 *                      [--session <sid>]
 *   experiment-plan    write the B/C manifest skeletons of 05 §4 and print the
 *                      D-07 arm commands  [--out <dir>] [--budget-usd <n>]
 *   help
 *
 * RULES THIS FILE KEEPS
 *  - Zero dependencies, Node >= 20, ESM. Nothing here calls a model: `claude` is
 *    spawned only with `--version` / `--help`. `host-probe` PRINTS the paid
 *    command and never runs it.
 *  - It writes exactly two places, each only on its own command: `census` writes
 *    `.artibot/guides/v5-design/evidence/pc-handoff-census-<YYYYMMDD>.md` (+ JSON
 *    sidecars) and refuses to overwrite an existing file; `experiment-plan`
 *    writes under `reports/` (gitignored — manifests stay out of the repo, 05 §4)
 *    and skips files that exist. Everything else is read-only.
 *  - Zero is not null: a census that finds no store prints `unmeasured:*` and
 *    the evidence file records that status, never a 0.
 *  - Numbers travel with their reproduction command. Every census block in the
 *    evidence file starts with the exact command that produced it.
 *
 * WHY IT LIVES HERE AND NOT UNDER `plugins/artibot/scripts/`
 *  It is tied to this design folder (its documents, branch and decisions), not to
 *  the shipped plugin, so it must not ride into the plugin cache. The price is
 *  that `eslint .` run from `plugins/artibot` cannot reach it (flat config base
 *  path — see `plugins/artibot/eslint.shared-rules.js`). Lint it from the plugin
 *  dir with the Node API, the same way `tests/firewall/cowork-scripts-lint.test.js`
 *  reaches the cowork scripts:
 *
 *    cd plugins/artibot && node --input-type=module -e "
 *      import { ESLint } from 'eslint'; import js from '@eslint/js'; import globals from 'globals'; import path from 'node:path';
 *      import { SCRIPT_RULES } from './eslint.shared-rules.js';
 *      const e = new ESLint({ cwd: path.resolve('../..'), overrideConfigFile: true, baseConfig: [js.configs.recommended,
 *        { languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: { ...globals.node } }, rules: SCRIPT_RULES }] });
 *      const r = await e.lintFiles(['.artibot/guides/v5-design/practicality-improvement-20261023/pc-handoff.mjs']);
 *      console.log((await e.loadFormatter('stylish')).format(r) || 'clean');"
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DOC_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolveRepoRoot(DOC_DIR);
const PLUGIN_ROOT = path.join(REPO_ROOT, 'plugins', 'artibot');
const EVIDENCE_DIR = path.join(REPO_ROOT, '.artibot', 'guides', 'v5-design', 'evidence');
const DOC_REL = toPosix(path.relative(REPO_ROOT, DOC_DIR));
const SELF_REL = `${DOC_REL}/pc-handoff.mjs`;

/** The branch this handoff lives on (07 §0). */
const BRANCH = 'claude/jolly-newton-qmi4eb';
/** Host version the cloud measurements (04 · 05 §8.1 · 06) were taken on. */
const CLOUD_HOST_VERSION = '2.1.309';
/** Flags the D-07 arm commands and 02 §2 pre-checks rely on. */
const HOST_FLAGS = ['--bare', '--setting-sources', '--plugin-dir', '--output-format', '--include-hook-events',
  '--max-budget-usd', '--effort', '--safe-mode', '--debug', '--verbose'];
/** 07 §A-4 — the files whose behaviour differs by path separator, atomic write and git.exe. */
const TARGET_TESTS = [
  'tests/hooks/tool-tracker-loop-state.test.js',
  'tests/hooks/tool-tracker-bash-receipt.test.js',
  'tests/autopilot/report-verify-gate-deterministic.test.js',
];
/** 02 §3 Phase 1 pilot: 6 tasks × B/C × 2 trials = 24 runs. Task bodies are the owner's. */
const PILOT_TASKS = [
  { task_id: 'T-01', type: 'SIMPLE' }, { task_id: 'T-02', type: 'SIMPLE' },
  { task_id: 'T-03', type: 'BUGFIX' }, { task_id: 'T-04', type: 'BUGFIX' },
  { task_id: 'T-05', type: 'FEATURE' }, { task_id: 'T-06', type: 'PARALLEL-or-RESUME' },
];
const PILOT_ARMS = ['B', 'C'];
const PILOT_TRIALS = [1, 2];
/** The host-probe prompt: three identical Reads (loop warn threshold 3) + one unclassified Bash (D-03). */
// No quotes, backticks or dollar signs: the prompt is printed inside a double-quoted shell argument.
const PROBE_PROMPT = 'README.md 파일을 Read 도구로 정확히 3번 연속 읽어라(매번 같은 인자). 그 다음 Bash 도구로 echo artibot-probe 를 1번 실행하라. 다른 도구는 쓰지 말고, 끝나면 끝 이라는 한 단어만 답하라.';

const WIN = process.platform === 'win32';
/** On Windows these are .cmd shims that need a shell (CVE-2024-27980 made spawn refuse them). */
const SHELL_ON_WINDOWS = new Set(['claude', 'npm', 'npx']);
const VALUE_FLAGS = new Set(['--out', '--state-dir', '--store-dir', '--since', '--session', '--max-workers', '--budget-usd']);
const BOOL_FLAGS = new Set(['--full', '--dry-run', '--verify', '--force']);

const tally = { ok: 0, warn: 0, fail: 0, info: 0 };

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function resolveRepoRoot(dir) {
  const byLayout = path.resolve(dir, '..', '..', '..', '..');
  if (existsSync(path.join(byLayout, 'plugins', 'artibot', 'package.json'))) return byLayout;
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8', windowsHide: true });
  return top.status === 0 && top.stdout.trim() ? top.stdout.trim() : byLayout;
}

/**
 * Run a command synchronously. `inherit` streams the child's stdio to ours
 * (used for vitest); otherwise stdout/stderr are captured.
 */
function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd ?? REPO_ROOT,
    encoding: 'utf8',
    shell: WIN && SHELL_ON_WINDOWS.has(cmd),
    stdio: opts.inherit ? 'inherit' : 'pipe',
    timeout: opts.timeoutMs === null ? undefined : (opts.timeoutMs ?? 120_000),
    env: { ...process.env, ...(opts.env ?? {}) },
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    ok: !r.error && r.status === 0,
    status: r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    error: r.error ?? null,
  };
}

function git(args) {
  return sh('git', args, { cwd: REPO_ROOT });
}

function say(level, msg) {
  tally[level] += 1;
  console.log(`[${level}] ${msg}`);
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function listDirs(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

function claudeConfigDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

/** Mirror of `lib/core/config.js#resolveArtibotDir`: the override counts only while paired with the home in force. */
function artibotStateDir() {
  const homeDerived = path.join(os.homedir(), '.claude', 'artibot');
  const override = process.env.ARTIBOT_STATE_DIR;
  const mintedFor = process.env.ARTIBOT_STATE_DIR_HOME;
  if (!override || !mintedFor) return homeDerived;
  return path.resolve(mintedFor) === path.resolve(os.homedir()) ? override : homeDerived;
}

function parseArgs(argv) {
  const opts = { command: 'start', flags: {}, errors: [] };
  const [first, ...rest] = argv;
  const positional = first && !first.startsWith('--') ? rest : argv;
  if (first && !first.startsWith('--')) opts.command = first;
  for (let i = 0; i < positional.length; i += 1) {
    const flag = positional[i];
    if (VALUE_FLAGS.has(flag)) {
      const value = positional[i + 1];
      if (value === undefined || value.startsWith('--')) opts.errors.push(`${flag} 에 값이 없다`);
      else {
        opts.flags[flag.slice(2)] = value;
        i += 1;
      }
    } else if (BOOL_FLAGS.has(flag)) opts.flags[flag.slice(2)] = true;
    else opts.errors.push(`모르는 인자: ${flag}`);
  }
  return opts;
}

// ---------------------------------------------------------------------------
// check — what this PC has, against what the branch expects
// ---------------------------------------------------------------------------

function checkRepo() {
  if (!git(['rev-parse', '--is-inside-work-tree']).ok) {
    say('fail', `git 리포가 아니다: ${REPO_ROOT}`);
    return { branch: null, head: null, dirty: null };
  }
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
  const head = git(['rev-parse', 'HEAD']).stdout.trim();
  const dirty = git(['status', '--porcelain']).stdout.trim().length > 0;
  const onBranch = branch === BRANCH;
  say(onBranch ? 'ok' : 'warn', `브랜치 ${branch} @ ${head.slice(0, 8)}${onBranch ? '' : ` — 기대 ${BRANCH} (git fetch origin ${BRANCH} && git checkout ${BRANCH})`}`);
  say(dirty ? 'warn' : 'ok', dirty ? '워킹트리에 커밋되지 않은 변경이 있다 (git status)' : '워킹트리 clean');
  if (git(['rev-parse', '--verify', '--quiet', 'origin/master']).ok) {
    const ahead = git(['rev-list', '--count', 'origin/master..HEAD']).stdout.trim();
    say('info', `origin/master 위 커밋 ${ahead}개 (git log --oneline origin/master..HEAD)`);
  }
  const upstream = git(['rev-list', '--left-right', '--count', `HEAD...origin/${BRANCH}`]);
  if (upstream.ok) {
    const [local, remote] = upstream.stdout.trim().split(/\s+/);
    const synced = Number(local) + Number(remote) === 0;
    say(synced ? 'ok' : 'warn', synced ? `origin/${BRANCH} 와 같다` : `origin/${BRANCH} 대비 로컬만 +${local} · 원격만 +${remote} (git fetch origin ${BRANCH})`);
  }
  return { branch, head, dirty };
}

function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  say(major >= 20 ? 'ok' : 'fail', `node ${process.version}${major >= 20 ? '' : ' — 20 이상 필요'}`);
  return { version: process.version, ok: major >= 20 };
}

function checkHost() {
  const v = sh('claude', ['--version']);
  if (!v.ok) {
    const why = v.error?.code ?? (v.stderr.trim() || `exit ${v.status}`);
    say('warn', `claude 를 실행하지 못했다 (${why}) — 호스트 통합(§A-3)·훅 지연(§A-5)은 이 PC 의 Claude Code 로만 된다`);
    return { version: null, flags: null };
  }
  const version = v.stdout.trim().split(/\s+/)[0] || null;
  say('ok', `claude ${v.stdout.trim()} (클라우드 측정 호스트 ${CLOUD_HOST_VERSION})`);
  const helpOut = sh('claude', ['--help']);
  const text = `${helpOut.stdout}\n${helpOut.stderr}`;
  const flags = Object.fromEntries(HOST_FLAGS.map((f) => [f, text.includes(f)]));
  const missing = HOST_FLAGS.filter((f) => !flags[f]);
  say(missing.length ? 'warn' : 'ok', missing.length
    ? `claude --help 에 없는 플래그: ${missing.join(' ')} — 실험 명령(D-07)에서 조용히 쓰지 않는다(02 §2)`
    : `실험 명령이 쓰는 플래그 ${HOST_FLAGS.length}개가 claude --help 에 있다`);
  return { version, flags };
}

function pickInstalled(registry) {
  const plugins = registry?.plugins ?? registry ?? {};
  const raw = plugins['artibot@artibot'];
  if (Array.isArray(raw)) return { entry: raw[0] ?? null, count: raw.length };
  return { entry: raw && typeof raw === 'object' ? raw : null, count: raw ? 1 : 0 };
}

function checkInstalled(repo) {
  const file = path.join(claudeConfigDir(), 'plugins', 'installed_plugins.json');
  const branchVersion = readJson(path.join(PLUGIN_ROOT, 'package.json'))?.version ?? null;
  const result = { version: null, sha: null, installPath: null, branchVersion };
  const registry = readJson(file);
  if (!registry) {
    say('warn', `설치 레지스트리를 읽지 못했다: ${file} — 이 브랜치는 "claude --plugin-dir ${PLUGIN_ROOT}" 로 한 세션만 태우는 것이 안전하다(§A-1)`);
    return result;
  }
  const { entry, count } = pickInstalled(registry);
  if (!entry) {
    say('warn', 'installed_plugins.json 에 artibot@artibot 항목이 없다');
    return result;
  }
  const { version = null, gitCommitSha = null, installPath = null, lastUpdated = null } = entry;
  say('info', `설치본 artibot@artibot ${version ?? '?'} @ ${gitCommitSha ? gitCommitSha.slice(0, 8) : '?'} (lastUpdated ${lastUpdated ?? '?'}${count > 1 ? ` · 항목 ${count}개 중 첫째` : ''})`);
  const same = version === branchVersion;
  say(same ? 'ok' : 'info', `브랜치 package.json ${branchVersion} ${same ? '= 설치본' : `≠ 설치본 ${version} — 릴리스 전이면 정상; 이 브랜치의 변경은 설치본에 없다`}`);
  if (gitCommitSha && repo.head) {
    if (gitCommitSha === repo.head) say('ok', '설치본 커밋 = HEAD');
    else {
      const ancestor = git(['merge-base', '--is-ancestor', gitCommitSha, repo.head]).ok;
      say(ancestor ? 'info' : 'warn', ancestor
        ? '설치본 커밋은 HEAD 의 조상 — 호스트 통합(§A-3)은 설치본이 아니라 --plugin-dir 로 이 워킹트리를 태운다'
        : `설치본 커밋 ${gitCommitSha.slice(0, 8)} 은 HEAD 의 조상이 아니다 (다른 줄기이거나 fetch 가 필요)`);
    }
  }
  if (installPath) say(existsSync(installPath) ? 'ok' : 'warn', `installPath ${existsSync(installPath) ? '존재' : '없음'}: ${installPath}`);
  const globalVersion = readJson(path.join(os.homedir(), '.claude', 'artibot', 'package.json'))?.version;
  if (globalVersion) say('info', `전역 사본 ~/.claude/artibot/package.json ${globalVersion} (상태줄 버전 출처, install.sh files 산출)`);
  return { ...result, version, sha: gitCommitSha, installPath };
}

function checkState() {
  const dir = artibotStateDir();
  const ledger = path.join(REPO_ROOT, '.git', 'artibot', 'ledger.jsonl');
  const result = { dir, sessions: 0, loopFiles: 0, ledger: existsSync(ledger) ? ledger : null };
  if (!existsSync(dir)) say('info', `상태 디렉터리 없음: ${dir} — 이 PC 에서 Artibot 훅이 돈 적이 없다(loop census 는 unmeasured)`);
  else {
    const sessionsRoot = path.join(dir, 'runtime', 'sessions');
    const sids = listDirs(sessionsRoot);
    const loopFiles = sids.filter((s) => existsSync(path.join(sessionsRoot, s, 'loop-state.json'))).length
      + (existsSync(path.join(dir, 'loop-state.json')) ? 1 : 0);
    const toolHistory = existsSync(path.join(dir, 'tool-history.json')) ? '있음' : '없음';
    say('info', `상태 디렉터리 ${dir}: 세션 ${sids.length}개 · loop-state.json ${loopFiles}개(D-01 은 설치본이 이 브랜치를 포함한 뒤부터 쌓임) · tool-history.json ${toolHistory}`);
    Object.assign(result, { sessions: sids.length, loopFiles });
  }
  say(result.ledger ? 'info' : 'warn', result.ledger
    ? `원장 ${ledger} ${fmtBytes(statSync(ledger).size)}`
    : `원장 없음: ${ledger} — existence-audit 는 unmeasured 로 나온다`);
  return result;
}

function checkDeps() {
  const vitest = path.join(PLUGIN_ROOT, 'node_modules', 'vitest', 'vitest.mjs');
  const present = existsSync(vitest);
  say(present ? 'ok' : 'warn', present ? 'vitest 설치됨 (plugins/artibot/node_modules)' : `vitest 없음 — 테스트 전에: cd ${PLUGIN_ROOT} && npm ci`);
  return { vitest: present ? vitest : null };
}

function check() {
  console.log(`# pc-handoff check — ${new Date().toISOString()} · ${os.platform()} ${os.release()} ${os.arch()} · ${REPO_ROOT}`);
  const repo = checkRepo();
  const ctx = { repo, node: checkNode(), host: checkHost(), installed: checkInstalled(repo), state: checkState(), deps: checkDeps() };
  console.log(`\n요약: ok ${tally.ok} · warn ${tally.warn} · fail ${tally.fail}`);
  return ctx;
}

/** Quiet identity for evidence headers — the same facts as `check`, no printing. */
function identity() {
  const head = git(['rev-parse', 'HEAD']).stdout.trim() || null;
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim() || null;
  const dirty = git(['status', '--porcelain']).stdout.trim().length > 0;
  const claude = sh('claude', ['--version']);
  const { entry } = pickInstalled(readJson(path.join(claudeConfigDir(), 'plugins', 'installed_plugins.json')));
  return {
    measuredAt: new Date().toISOString(),
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    node: process.version,
    hostVersion: claude.ok ? claude.stdout.trim() : null,
    head, branch, dirty,
    installedVersion: entry?.version ?? null,
    installedSha: entry?.gitCommitSha ?? null,
    branchVersion: readJson(path.join(PLUGIN_ROOT, 'package.json'))?.version ?? null,
  };
}

// ---------------------------------------------------------------------------
// census — the three live denominators (07 §A-2), recorded as evidence
// ---------------------------------------------------------------------------

function censusRuns(flags) {
  const script = (name) => path.join(PLUGIN_ROOT, 'scripts', 'ledger', name);
  return [
    {
      name: 'verify-result-census', ref: '05 D-04 1단계 · 07 §B-2 의 입력',
      what: 'REPORT 에 도달한 autopilot 세션 중 verifyResult 가 PASS/FAIL/UNMEASURED 인 비율과, evidenceMode 를 explicit-pass 로 바꾸면 늘어날 pause 수',
      cwd: PLUGIN_ROOT, args: [script('verify-result-census.mjs'), ...(flags['store-dir'] ? ['--dir', flags['store-dir']] : [])],
    },
    {
      name: 'loop-detection-census', ref: '05 D-02 1단계 · 07 §B-1 의 입력',
      what: '루프 감지 warn/block 수 · 도구 분포 · 반복 fingerprint (설치본이 D-01 을 포함한 뒤부터 쌓인다)',
      cwd: PLUGIN_ROOT, args: [script('loop-detection-census.mjs'), ...(flags['state-dir'] ? ['--state-dir', flags['state-dir']] : [])],
    },
    {
      name: 'existence-audit', ref: 'CLAUDE.md Existence Audit · 06 §8 #3(a) · 07 §B-6 의 입력',
      what: '훅·커맨드·스킬·lib 모듈의 발화 수와 소비처 — "소비처 0 + 발화 0 이 2릴리스 연속" 후보 목록',
      cwd: REPO_ROOT, args: [script('existence-audit.mjs'), '--cwd', REPO_ROOT, '--plugin-root', PLUGIN_ROOT, ...(flags.since ? ['--since', flags.since] : [])],
    },
  ];
}

function displayCommand(run) {
  const rel = (a) => (path.isAbsolute(a) && a.startsWith(REPO_ROOT) ? toPosix(path.relative(REPO_ROOT, a)) || '.' : a);
  return `node ${run.args.map(rel).join(' ')}`;
}

function parseLastJsonLine(stdout) {
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      // not this line
    }
  }
  return null;
}

function runCensus(run) {
  const started = Date.now();
  const r = sh(process.execPath, run.args, { cwd: run.cwd, timeoutMs: 600_000 });
  const json = parseLastJsonLine(r.stdout);
  const status = json?.status ?? (json?.summary ? `entries ${json.summary.entries} · measured ${json.summary.measured} · unmeasured ${json.summary.unmeasured} · eventsReceived ${json.summary.eventsReceived}` : null);
  return { ...run, command: displayCommand(run), exit: r.status, error: r.error?.message ?? null, ms: Date.now() - started, human: r.stderr.trim(), json, status };
}

/** Keep a JSON block readable inline: top-level values over 2 KB are replaced by a pointer to the sidecar. */
function compactForInline(json) {
  if (!json || typeof json !== 'object') return json;
  const out = {};
  for (const [k, v] of Object.entries(json)) {
    const s = JSON.stringify(v);
    out[k] = s && s.length > 2048 ? `<omitted ${fmtBytes(s.length)} — see sidecar>` : v;
  }
  return out;
}

function candidateNames(json) {
  const names = [];
  for (const [kind, block] of Object.entries(json?.kinds ?? {})) {
    for (const e of block?.entries ?? []) if (e.candidate) names.push(`${kind}/${e.name}`);
  }
  return names;
}

function renderCensusMarkdown(id, results, stem) {
  const head = [
    `# PC 인수인계 census — ${id.measuredAt.slice(0, 10)}`,
    '',
    `- 측정: ${id.measuredAt} · ${id.platform} · node ${id.node} · claude ${id.hostVersion ?? '미실행'} · HEAD ${id.head ? id.head.slice(0, 8) : '?'} (${id.branch ?? '?'}${id.dirty ? ', dirty' : ''}) · 설치본 ${id.installedVersion ?? '없음'}${id.installedSha ? `@${id.installedSha.slice(0, 8)}` : ''} · 브랜치 package.json ${id.branchVersion ?? '?'}`,
    `- 러너: \`node ${SELF_REL} census\` (07 §A-2). 세 수치는 05 §8.1 로 옮길 때 각 절의 재현 명령과 함께 적는다. \`unmeasured:*\` 는 0 이 아니라 부재다.`,
    '',
  ];
  const body = results.flatMap((r, i) => {
    const inline = JSON.stringify(r.json);
    const sidecar = inline && inline.length > 8192 ? `${stem}.${r.name}.json` : null;
    const shown = sidecar ? compactForInline(r.json) : r.json;
    const lines = [
      `## ${i + 1}. ${r.name}`,
      '',
      `- 무엇: ${r.what} (${r.ref})`,
      `- 재현: \`${r.command}\` · exit ${r.exit}${r.error ? ` · error ${r.error}` : ''} · ${r.ms} ms`,
      `- 상태: \`${r.status ?? 'JSON 없음'}\``,
      `- 한 줄: ${r.human ? r.human.split(/\r?\n/).pop() : '(stderr 없음)'}`,
    ];
    if (sidecar) lines.push(`- 전체 JSON(${fmtBytes(inline.length)}): \`${sidecar}\` (같은 폴더)`);
    if (r.name === 'existence-audit' && r.json) {
      const cands = candidateNames(r.json);
      lines.push(`- 제거 후보(candidate true): ${cands.length}건${cands.length ? ` — ${cands.slice(0, 40).join(', ')}${cands.length > 40 ? ' …' : ''}` : ''}`);
    }
    lines.push('', '```json', JSON.stringify(shown, null, 2), '```', '');
    return lines;
  });
  return [...head, ...body].join('\n');
}

function census(flags) {
  const id = identity();
  const results = censusRuns(flags).map(runCensus);
  for (const r of results) console.log(`${r.name}: ${r.status ?? 'JSON 없음'} (exit ${r.exit}, ${r.ms} ms)\n  $ ${r.command}\n  ${r.human.split(/\r?\n/).pop() || ''}`);
  const out = flags.out ? path.resolve(flags.out) : path.join(EVIDENCE_DIR, `pc-handoff-census-${today()}.md`);
  const stem = path.basename(out).replace(/\.md$/, '');
  if (flags['dry-run']) {
    console.log(`\n[dry-run] 쓰지 않음 — 썼다면: ${out}`);
    return 0;
  }
  if (existsSync(out) && !flags.force) {
    console.log(`\n[fail] 이미 있다: ${out} — 증거는 덮어쓰지 않는다 (--out <다른 파일> 또는 --force)`);
    return 1;
  }
  mkdirSync(path.dirname(out), { recursive: true });
  for (const r of results) {
    const inline = JSON.stringify(r.json);
    if (inline && inline.length > 8192) writeFileSync(path.join(path.dirname(out), `${stem}.${r.name}.json`), `${inline}\n`);
  }
  writeFileSync(out, `${renderCensusMarkdown(id, results, stem)}\n`);
  console.log(`\n썼다: ${out}`);
  console.log(`evidence/README.md 표에 더할 행(손으로 붙인다):\n| \`${path.basename(out)}\` | 07 §A-2 라이브 분모 3종 — ${results.map((r) => `${r.name} \`${r.status ?? '?'}\``).join(' · ')} | \`node ${SELF_REL} census\` — 측정 ${id.measuredAt}, HEAD ${id.head ? id.head.slice(0, 8) : '?'}, 설치본 ${id.installedVersion ?? '없음'} |`);
  return 0;
}

// ---------------------------------------------------------------------------
// tests — 07 §A-4
// ---------------------------------------------------------------------------

function readSnapshot() {
  const file = path.join(PLUGIN_ROOT, 'runtime', 'last-test-result.json');
  const snap = readJson(file);
  if (!snap) return null;
  return { file, schemaVersion: snap.schemaVersion, gitSha: snap.gitSha, gitDirty: snap.gitDirty, failed: snap.failed, passed: snap.passed, completion: snap.completion?.reason ?? null, measuredAt: snap.measuredAt ?? snap.timestamp ?? null };
}

function tests(flags) {
  const vitest = path.join(PLUGIN_ROOT, 'node_modules', 'vitest', 'vitest.mjs');
  if (!existsSync(vitest)) {
    console.log(`[fail] vitest 가 없다: ${vitest}\n  먼저: cd ${PLUGIN_ROOT} && npm ci`);
    return 2;
  }
  const workers = Number(flags['max-workers'] ?? (flags.full ? 8 : 4));
  if (!Number.isInteger(workers) || workers < 1) {
    console.log('[fail] --max-workers 는 1 이상의 정수');
    return 2;
  }
  const args = flags.full
    ? [vitest, 'run', '--reporter=default', '--reporter=./tests/reporters/test-status-reporter.js', `--maxWorkers=${workers}`]
    : [vitest, 'run', ...TARGET_TESTS, `--maxWorkers=${workers}`];
  console.log(`$ cd ${PLUGIN_ROOT} && node ${args.map((a) => (path.isAbsolute(a) ? toPosix(path.relative(PLUGIN_ROOT, a)) : a)).join(' ')}`);
  if (flags.full) console.log('(= npm test -- --maxWorkers=8 — NEXT-SESSION 규칙: 기본 워커로 돌리지 않고, VITEST_MAX_WORKERS 는 쓰지 않는다)');
  const started = Date.now();
  const r = sh(process.execPath, args, { cwd: PLUGIN_ROOT, inherit: true, timeoutMs: null });
  console.log(`\nvitest exit ${r.status ?? r.error?.code} · ${Math.round((Date.now() - started) / 1000)} s · ${os.platform()} ${os.release()} · node ${process.version}`);
  const snap = readSnapshot();
  if (snap && flags.full) console.log(`리포터 스냅샷 ${snap.file}: schemaVersion ${snap.schemaVersion} · gitSha ${snap.gitSha ? String(snap.gitSha).slice(0, 12) : null} · gitDirty ${snap.gitDirty} · failed ${snap.failed} · completion ${snap.completion} (규칙 7 이 읽는 것)`);
  console.log('기록: 결과(OS · node · 소요 · 실패 목록)를 05 §8.1 에 위 명령과 함께 덧붙인다 (07 §A-4).');
  return r.status ?? 1;
}

// ---------------------------------------------------------------------------
// host-probe — 07 §A-3 (print only) and its verification
// ---------------------------------------------------------------------------

function printHostProbe() {
  const tmp = WIN ? '%TEMP%\\artibot-probe' : '/tmp/artibot-probe';
  console.log(`## 호스트 통합 테스트 (07 §A-3) — 모델 호출 있음(몇 센트). 이 러너는 명령을 출력만 한다; 실행은 사람이 비용을 보고 한다.

1) 작은 임시 git 리포 (프로젝트 CLAUDE.md 없음 → 플러그인 훅만 로드):
   mkdir ${tmp} && cd ${tmp} && git init -q && echo probe > README.md && git add README.md && git commit -qm init

2) 이 워킹트리의 플러그인을 한 세션만 태운다 (설치본은 건드리지 않는다):
   claude --plugin-dir "${PLUGIN_ROOT}" -p "${PROBE_PROMPT}" --output-format stream-json --verbose --include-hook-events --max-budget-usd 0.2 > probe.jsonl
   - --verbose 는 -p 에서 stream-json 을 쓰기 위한 조건. --max-budget-usd 는 클라이언트 추정 상한(안전망).
   - 세션 id: probe.jsonl 의 첫 행(type "system", subtype "init")의 session_id.
   - 훅 발화 스트림: probe.jsonl 의 hook 이벤트 행 — PostToolUse 에 tool-tracker 가 들어 있어야 한다.

3) 검증 (API 0):
   node ${SELF_REL} host-probe --verify [--state-dir <dir>] [--session <sid>]
   PASS 기준(D-01 · D-03 의 "호스트 통합 PASS"):
   - <state>/runtime/sessions/<sid>/loop-state.json 이 있고 history ≥ 4 (Read 3 + Bash 1), detections ≥ 1 (같은 Read 3회 → warn; 5회면 block)
   - <state>/tool-history.json 의 contexts 에 bash:unknown:shell 키 (echo 는 분류 규칙이 없는 명령 → D-03 수용 행)
   - FAIL 이면 05 §6 "서브에이전트 payload 의 session_id" 와 06 §4 의 미확인이 그대로다 — 수치와 함께 05 §8.1 에 적는다.

## 훅 지연 실측 (07 §A-5, P-13) — 같은 세션 또는 대화형 세션에서
   claude --debug 로 Write 또는 Edit 1회 → 디버그 출력에서 PreToolUse 훅 5개의 소요(ms)를 읽어 06 §2 의 벤치(각 68~94 ms, 호스트 IPC 제외)와 비교한다. 차이가 크면 06 §8 #6(디스패처 통합)을 연다.`);
  return 0;
}

function newestSessionWithLoopState(sessionsRoot) {
  let best = null;
  for (const sid of listDirs(sessionsRoot)) {
    const file = path.join(sessionsRoot, sid, 'loop-state.json');
    if (!existsSync(file)) continue;
    const mtime = statSync(file).mtimeMs;
    if (!best || mtime > best.mtime) best = { sid, mtime };
  }
  return best?.sid ?? null;
}

function verifyHostProbe(flags) {
  const dir = flags['state-dir'] ? path.resolve(flags['state-dir']) : artibotStateDir();
  const sessionsRoot = path.join(dir, 'runtime', 'sessions');
  const sid = flags.session ?? newestSessionWithLoopState(sessionsRoot);
  console.log(`# host-probe verify — state ${dir}`);
  if (!sid) {
    say('fail', `loop-state.json 을 가진 세션이 없다: ${sessionsRoot} — 훅이 돌지 않았거나(--plugin-dir 경로 · hooks.json), 상태 디렉터리가 다르다(--state-dir)`);
    return 1;
  }
  const loop = readJson(path.join(sessionsRoot, sid, 'loop-state.json'));
  if (!loop) {
    say('fail', `읽지 못했다: ${path.join(sessionsRoot, sid, 'loop-state.json')}`);
    return 1;
  }
  const history = Array.isArray(loop.history) ? loop.history.length : 0;
  const detections = Array.isArray(loop.detections) ? loop.detections : [];
  const bySeverity = detections.reduce((acc, d) => ({ ...acc, [d.severity]: (acc[d.severity] ?? 0) + 1 }), {});
  say(history >= 4 ? 'ok' : 'warn', `세션 ${sid}: history ${history} (기준 ≥ 4)`);
  say(detections.length >= 1 ? 'ok' : 'fail', `detections ${detections.length} ${JSON.stringify(bySeverity)} · 도구 ${[...new Set(detections.map((d) => d.tool))].join(',') || '-'} (기준 ≥ 1, Read)`);
  const toolHistory = readJson(path.join(dir, 'tool-history.json'));
  const bashKeys = Object.keys(toolHistory?.contexts ?? {}).filter((k) => /^bash:[a-z-]+:shell$/.test(k));
  say(bashKeys.includes('bash:unknown:shell') ? 'ok' : 'fail', `tool-history.json contexts 의 bash 키: ${bashKeys.join(', ') || '없음'} (기준: bash:unknown:shell 포함)`);
  const pass = tally.fail === 0;
  console.log(`\n판정: ${pass ? 'PASS' : 'FAIL'} — D-01 · D-03 호스트 통합 (05 §8.1 에 세션 id · 호스트 버전과 함께 적는다)`);
  return pass ? 0 : 1;
}

// ---------------------------------------------------------------------------
// experiment-plan — 05 §4 manifest skeletons + D-07 arm commands (dry run)
// ---------------------------------------------------------------------------

function manifestSkeleton(task, arm, trial, id) {
  return {
    task_id: task.task_id, task_type: task.type, trial, arm,
    host_version: id.hostVersion, plugin_commit: arm === 'C' ? id.head : null,
    base_git_sha: null, final_git_sha: null,
    config_digest: null, profile_manifest_digest: null,
    session_id: null, started_at: null, ended_at: null,
    human_minutes: null,
    hidden_check: { command: `npm test -- tests/hidden/${task.task_id}.test.js`, exit_code: null, ran_at: null },
    independent_review: { verdict: null, reviewer: null },
    measurement_status: 'unmeasured:not-run',
    notes: '',
  };
}

function shuffled(list) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function printArmCommands(id) {
  const sha = id.head ? id.head.slice(0, 12) : '<sha>';
  console.log(`
## D-07 군별 명령 골격 ($P = 실험 프로필 루트, 전부 사용자 실제 홈과 분리 · 인증은 실험 전용 계정)
A Pure   : CLAUDE_CONFIG_DIR=$P/A claude --bare -p "<task prompt>" <공통>
B Native : CLAUDE_CONFIG_DIR=$P/B claude --setting-sources project -p "<task prompt>" <공통>
           + 워크트리 CLAUDE.md 의 Artibot 절 제거 · .claude/rules/ 에 artibot 없음 확인
C Full   : CLAUDE_CONFIG_DIR=$P/C claude --setting-sources project --plugin-dir <artibot checkout @ ${sha}>/plugins/artibot -p "<task prompt>" <공통>
D Lite   : C 와 같되 config 스위치 사전 고정(Phase 1 뒤 결정)
<공통>   : --effort <값> --model <모델> --permission-mode <모드> --output-format stream-json --verbose --include-hook-events --max-budget-usd <trial 상한>
           trial 마다 깨끗한 worktree @ base SHA · 숨김 acceptance 검사는 모델 실행 뒤 별도 체크아웃에서

## 사전 점검(실행 전 등록 — 02 §2 · D-07)
- 각 프로필에서 claude --help 로 플래그 존재 확인 (이 러너의 check 가 이 PC 의 claude 로 한 번 한다)
- B 프로필 안에 artibot 문자열 0:   grep -ril artibot $P/B | wc -l   → 0
- 프로필 안 plugins/ · rules/ · CLAUDE.md 부재(B) / 존재(C) 를 find 로 매니페스트에 기록 (profile_manifest_digest = 그 목록의 sha256)
- 프로젝트 CLAUDE.md 의 Artibot 절 유무:   grep -n "Artibot" <worktree>/CLAUDE.md
- 구독 사용량과 API 과금 구별 · agent/child 비용 이중 집계 방지 · 자동 승인/위험 permission 우회 금지

## 첫 시운전(Phase 0 잔여, API 0 — Wave 5 첫 항목)
B 군 프로필에서 transcript 가 영수증으로 접히는지:
   node plugins/artibot/scripts/ledger/usage-cost-table.mjs --projects-dir $P/B/projects --live-session <id>
C 군은 원장(.git/artibot/ledger.jsonl) + MEASUREMENT-RUNBOOK 판독기. 결과 보관은 evidence/README 관례(리포에는 요약만).`);
}

function experimentPlan(flags) {
  const id = identity();
  const out = flags.out ? path.resolve(flags.out) : path.join(REPO_ROOT, 'reports', `practicality-experiment-${today()}`);
  const budget = flags['budget-usd'] === undefined ? null : Number(flags['budget-usd']);
  if (budget !== null && !(budget > 0)) {
    console.log('[fail] --budget-usd 는 0 보다 큰 수');
    return 2;
  }
  console.log(`# experiment-plan — 매니페스트 골격 (05 §4) → ${out}`);
  if (budget === null) say('warn', '예산(USD 상한)이 없다 — 05 §4 #5: 오너가 매니페스트 머리에 상한을 적은 뒤에만 Phase 1 을 시작한다(07 §B-4). 골격만 만든다.');
  mkdirSync(out, { recursive: true });
  const ignored = git(['check-ignore', '-q', out]).ok;
  if (out.startsWith(REPO_ROOT) && !ignored) say('warn', `${out} 은 리포 안인데 gitignore 되지 않았다 — trial 매니페스트는 리포에 두지 않는다(05 §4). reports/ 아래나 리포 밖을 --out 으로.`);
  const runs = PILOT_TASKS.flatMap((t) => PILOT_ARMS.flatMap((arm) => PILOT_TRIALS.map((trial) => ({ task: t, arm, trial }))));
  let written = 0;
  let skipped = 0;
  for (const { task, arm, trial } of runs) {
    const file = path.join(out, `${task.task_id}-${arm}-${trial}.json`);
    if (existsSync(file)) {
      skipped += 1;
      continue;
    }
    writeFileSync(file, `${JSON.stringify(manifestSkeleton(task, arm, trial, id), null, 2)}\n`);
    written += 1;
  }
  const headFile = path.join(out, 'MANIFEST-HEAD.json');
  if (!existsSync(headFile) || flags.force) {
    writeFileSync(headFile, `${JSON.stringify({
      created_at: id.measuredAt, budget_usd: budget, budget_decision: '05 §7 #4 · 07 §B-4 · NEXT-SESSION $6 중단선 재론',
      host_version: id.hostVersion, plugin_commit: id.head, plugin_branch: id.branch,
      arms: PILOT_ARMS, tasks: PILOT_TASKS, trials_per_arm: PILOT_TRIALS.length, runs: runs.length,
      run_order: shuffled(runs.map((r) => `${r.task.task_id}-${r.arm}-${r.trial}`)),
      pairing: '같은 task_id 와 trial 의 B/C 를 짝지어 비교(02 §2)',
      verified_pass: 'hidden_check.exit_code === 0 && independent_review.verdict === "PASS"',
      cost_join: 'session_id 로 usage.receipt 에 조인; measurement_status 는 usage.source 등급과 함께 보고',
      isolation: 'D-07', notes: '',
    }, null, 2)}\n`);
  }
  say('ok', `매니페스트 ${written}개 씀 · ${skipped}개 있음(건너뜀) · 머리 ${path.basename(headFile)} (run_order 는 무작위, 02 §2)`);
  printArmCommands(id);
  return 0;
}

// ---------------------------------------------------------------------------
// start — check + next steps + kickoff prompt
// ---------------------------------------------------------------------------

const KICKOFF = `브랜치 ${BRANCH} 의 인수인계를 이어서 진행해줘. 먼저 ${DOC_REL}/07_PC_HANDOFF.md 를 읽어. 러너는 같은 폴더의 pc-handoff.mjs 이고 리포 루트에서 node 로 돌린다(인자 없이 돌리면 점검과 다음 순서가 나온다). 순서는 07 §A 그대로다: (1) check 로 설치본·로드 확인 — 릴리스 전이면 --plugin-dir 로 한 세션만, (2) census 로 라이브 분모 3종을 evidence/ 에 기록하고 evidence/README 표에 행을 더해, (3) tests 로 Windows 재현(전체는 --full), (4) host-probe 가 출력한 명령으로 호스트 통합 테스트 — 비용(몇 센트)을 먼저 말하고 내 확인을 받은 뒤 실행, 끝나면 host-probe --verify, (5) claude --debug 로 훅 지연 1회. 수치는 전부 재현 명령과 함께 05 §8.1 에 덧붙이고, 07 §B 의 결정 8건은 기본값대로 두되 내가 정할 것을 질문 목록으로 올려. 비교 실험(§C)은 예산 결정 전에는 experiment-plan 의 골격 생성까지만. 커밋은 이 브랜치에만 하고 PR 은 열지 마.`;

function printNextSteps() {
  console.log(`
## 다음 순서 (07 §A — 각 줄이 러너 명령, 모델 호출은 4번만)
1. 설치·로드 확인: 위 check 의 "설치본" 줄. 릴리스 전이면 설치본을 바꾸지 않고 --plugin-dir ${toPosix(path.relative(REPO_ROOT, PLUGIN_ROOT))} 로 한 세션만 태운다 (§A-1)
2. node ${SELF_REL} census                 → ${toPosix(path.relative(REPO_ROOT, EVIDENCE_DIR))}/pc-handoff-census-<날짜>.md (라이브 분모 3종, §A-2)
3. node ${SELF_REL} tests [--full]         → Windows 재현 3파일 / 전체는 --maxWorkers=8 (§A-4)
4. node ${SELF_REL} host-probe             → 호스트 통합 명령 출력(몇 센트) → 실행 뒤 host-probe --verify (§A-3)
5. claude --debug 로 Write/Edit 1회의 PreToolUse 훅 지연 → 06 §2 와 비교 (§A-5)
6. node ${SELF_REL} experiment-plan [--budget-usd N] → 매니페스트 골격 + D-07 군별 명령 (결정 #4 뒤, §C)
결정 8건(07 §B)은 기본값으로 진행하고, 바뀐 것만 05 §7 에 적는다.

## 새 Claude Code 세션에 붙일 킥오프 프롬프트 (리포 루트에서 세션을 연 뒤)
---
${KICKOFF}
---`);
}

function start() {
  check();
  printNextSteps();
  return tally.fail ? 1 : 0;
}

function help() {
  const header = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 22).map((l) => l.replace(/^ \* ?/, '')).join('\n');
  console.log(header);
  return 0;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main(argv) {
  const { command, flags, errors } = parseArgs(argv);
  if (errors.length) {
    console.log(errors.map((e) => `[fail] ${e}`).join('\n'));
    return 2;
  }
  switch (command) {
    case 'start': return start();
    case 'check': { check(); return tally.fail ? 1 : 0; }
    case 'census': return census(flags);
    case 'tests': return tests(flags);
    case 'host-probe': return flags.verify ? verifyHostProbe(flags) : printHostProbe();
    case 'experiment-plan': return experimentPlan(flags);
    case 'help': case '--help': case '-h': return help();
    default:
      console.log(`[fail] 모르는 명령: ${command} (help 를 본다)`);
      return 2;
  }
}

process.exitCode = main(process.argv.slice(2));
