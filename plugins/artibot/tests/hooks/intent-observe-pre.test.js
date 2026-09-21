/**
 * `scripts/hooks/intent-observe-pre.js` — stage ② of mission_id 발급
 * (design §3.1, §3.3): the PreToolUse(`Write|Edit`) observer that confirms S1
 * on the first write tool of a session, promotes a deferred candidate to
 * `mission.created`, registers the mission in the StateStore, and writes
 * `.artibot/missions/<M>/intent.md`.
 *
 * Two layers, deliberately kept apart — the same split
 * `tests/hooks/route-observe-pre.test.js` uses:
 *   - the pure helpers, imported directly;
 *   - the hook as the host runs it, spawned as a CHILD PROCESS with JSON on
 *     stdin, because what is under test is an ON-DISK fact (a ledger line, a
 *     store row, a file) plus two process-level guarantees (empty stdout,
 *     exit 0) that an in-process call cannot observe.
 *
 * PreToolUse IS A BLOCK POINT. exit 2 plus a `permissionDecision` on stdout is
 * how a PreToolUse hook CANCELS the tool call, so every assertion about stdout
 * and exit status here is a safety assertion, not a tidiness one.
 *
 * WHAT THIS FILE DOES NOT PROVE (rules §9 — write it next to the gate):
 *   - THAT THE HOST FIRES PreToolUse FOR `Write`/`Edit` IN PRODUCTION. A green
 *     run here says nothing about registration actually firing; the hooks.json
 *     assertion below checks the FILE, not the host.
 *   - THAT `intent.md` IS WRITTEN, unconditionally. The write goes through
 *     `lib/runtime/artifact-lifecycle.js#apply`, whose gate 3 (`write: true`)
 *     only became a real writer when the Shadow-stage writer landed. The
 *     file-existence case is therefore stated as a CONDITIONAL on
 *     {@link APPLY_CAN_WRITE} and skips itself, loudly, on a tree where `apply`
 *     still cannot write. Measured 2026-09-12: the branch EXISTS, so that case
 *     RAN and the file write below is a measurement, not an aspiration.
 *   - THAT EVERY DEPENDENCY IS COVERED BY THE IMPORT-FAILURE CASE. One module
 *     (`lib/runtime/ledger.js`) is broken at import time and measured — stdout
 *     0 bytes, exit 0, no ledger line — which is the third row of the brief's
 *     stdout table and was UNMEASURED before. The other nine lazy imports are
 *     assumed to behave the same because they are awaited by the same
 *     `Promise.all` inside the same try, NOT because each was measured.
 *   - LATENCY IN PRODUCTION. The spawn budget below is informational: a tmpdir
 *     repo with a handful of ledger lines is not a live repo.
 *
 * @module tests/hooks/intent-observe-pre
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { resetConfig } from '../../lib/core/config.js';
import { appendLedgerEvent, ledgerFilePath } from '../../lib/runtime/ledger.js';
import { ARTIFACT_BASENAME, MISSIONS_DIR, SkipReason } from '../../lib/runtime/artifact-lifecycle.js';
import { sessionFallbackMissionId } from '../../lib/runtime/event-writer.js';
import { createStateStore } from '../../lib/project-state/state-manager.js';
import { resolveGitCommonDir } from '../../lib/project-state/git-common-dir.js';
import { missionMutator } from '../../lib/runtime/middleware/tasks.js';
import { checkSpanConsistency, parseIntentMd, serializeIntentMd } from '../../lib/intent/artifact.js';
import {
  intentArtifactPath,
  observeIntent,
  resolveMissionId,
  s1Action,
  WRITE_TOOLS,
} from '../../scripts/hooks/intent-observe-pre.js';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK = path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'intent-observe-pre.js');
const HOOK_SRC = readFileSync(HOOK, 'utf-8');
const HOOKS_JSON = JSON.parse(readFileSync(path.join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf-8'));
const LIFECYCLE_SRC = readFileSync(
  path.join(PLUGIN_ROOT, 'lib', 'runtime', 'artifact-lifecycle.js'), 'utf-8',
);

/**
 * Can `artifact-lifecycle.js#apply` write a file yet?
 *
 * Bundle A adds the `options.write === true` branch. Until it lands, `apply`
 * returns `written: []` under every input, so an unconditional file-existence
 * assertion here would be RED for a reason that has nothing to do with this
 * hook. Source-probed rather than behaviour-probed so the reason a test is
 * skipped is legible in one grep.
 */
const APPLY_CAN_WRITE = /options\.write\s*===\s*true/.test(LIFECYCLE_SRC);

/**
 * The per-project marker, relative to the project root.
 *
 * The shipped value of `runtime.artifactLifecycle.projectMarker`, spelled out
 * rather than read from the live config: a fixture that seeds the marker from
 * the same value it configures can never disagree with itself, and would go
 * green against any spelling at all.
 *
 * WHAT THIS CONSTANT DOES NOT GATE (rules §9 — write down what the gate cannot
 * see, next to the gate). It does NOT catch the shipped value drifting away
 * from this literal. Every sandbox below WRITES `projectMarker` from this
 * constant into its own config, so the shipped key is never consulted and a
 * rename in `artibot.config.json` leaves these suites green while silently
 * disagreeing with production. Agreement between the two is pinned in the
 * lifecycle module's own suites, not here. Verified equal by hand at
 * 2026-09-21T09:58Z; that is a point-in-time check, not a gate.
 *
 * A DEDICATED FILE, carrying no other meaning. The earlier candidate was the
 * v5 project declaration document, which conflates two different statements —
 * "this project uses Artibot project-state" and "this project opted in to
 * mission artifact files". Anything that scaffolded the declaration would have
 * re-opened the gate everywhere, which is the failure this gate exists to
 * prevent.
 */
const PROJECT_MARKER = '.artibot/artifact-lifecycle.optin';

/** Create the marker file that opens the per-project half of the gate. */
function seedProjectMarker(root) {
  const file = path.join(root, ...PROJECT_MARKER.split('/'));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, '# project\n', 'utf-8');
  return file;
}

const SESSION_ID = 'sess-intent-1abcdefg';
const DEFERRED_TITLE = 'Fix the flaky parser test';
/** One UTC day. The mission id's date part is `new Date()`-derived, so this is
 * how a session that crossed midnight is reproduced without a fake clock. */
const ONE_DAY_MS = 86_400_000;

/** Run the hook exactly as the host does: fresh process, JSON on stdin. */
function runHook(payload, home, { raw = null } = {}) {
  // NO `encoding` option, on purpose: that makes `spawnSync` hand back raw
  // Buffers, and the invariance case below compares stdout BYTE FOR BYTE across
  // failure modes. A decoded string would fold two different byte sequences
  // onto one value under a lossy decode.
  const res = spawnSync(process.execPath, [HOOK], {
    input: raw === null ? JSON.stringify(payload) : raw,
    env: { ...process.env, HOME: home, USERPROFILE: home },
    windowsHide: true,
  });
  const stdout = res.stdout ?? Buffer.alloc(0);
  return {
    status: res.status,
    stdout,
    stdoutBytes: stdout.length,
    stderr: String(res.stderr ?? ''),
  };
}

/**
 * Run the hook with `lib/runtime/ledger.js` FAILING AT IMPORT TIME.
 *
 * The third row of the stdout-invariance table, and the one the earlier
 * revision of this file recorded as UNMEASURED. It is produced without editing
 * production code: `module.register()` installs a `load` hook that replaces the
 * ledger module's source with a throw, so every importer of it — the hook's own
 * lazy import and `tasks.js`'s static one alike — rejects.
 *
 * A RUNNER, not a direct spawn, because the loader hook has to be registered
 * before the hook module is resolved. `main()` is called explicitly since
 * `isMainEntry` is false under an importing runner.
 *
 * The runner puts `main()`'s return value in a FILE, never on stdout, and the
 * caller asserts on it: without that, a `load` hook that silently stopped
 * matching would leave this case green while measuring the ordinary path.
 *
 * @param {object} payload
 * @param {string} home
 * @param {string} dir - scratch directory for the generated .mjs files
 * @returns {{status: number|null, stdout: Buffer, stdoutBytes: number,
 *   stderr: string, outcome: object|null}}
 */
function runHookWithBrokenLedger(payload, home, dir) {
  const LEDGER = 'lib/runtime/ledger.js';
  const hooks = path.join(dir, 'break-ledger-hooks.mjs');
  writeFileSync(hooks, [
    'export async function load(url, context, nextLoad) {',
    `  if (url.replace(/\\\\/g, '/').endsWith(${JSON.stringify(LEDGER)})) {`,
    '    return {',
    "      format: 'module',",
    '      shortCircuit: true,',
    '      source: \'throw new Error("ledger module failed to load");\',',
    '    };',
    '  }',
    '  return nextLoad(url, context);',
    '}',
    '',
  ].join('\n'), 'utf-8');

  const outFile = path.join(dir, 'break-ledger-outcome.json');
  const runner = path.join(dir, 'break-ledger-runner.mjs');
  writeFileSync(runner, [
    "import { register } from 'node:module';",
    "import { writeFileSync as wf } from 'node:fs';",
    `register(${JSON.stringify(pathToFileURL(hooks).href)});`,
    `const mod = await import(${JSON.stringify(pathToFileURL(HOOK).href)});`,
    'const out = await mod.main();',
    `wf(${JSON.stringify(outFile)}, JSON.stringify(out ?? null), 'utf-8');`,
    '',
  ].join('\n'), 'utf-8');

  const res = spawnSync(process.execPath, [runner], {
    input: JSON.stringify(payload),
    env: { ...process.env, HOME: home, USERPROFILE: home },
    windowsHide: true,
  });
  const stdout = res.stdout ?? Buffer.alloc(0);
  return {
    status: res.status,
    stdout,
    stdoutBytes: stdout.length,
    stderr: String(res.stderr ?? ''),
    outcome: existsSync(outFile) ? JSON.parse(readFileSync(outFile, 'utf-8')) : null,
  };
}

/** Parsed ledger lines, `[]` when the file was never created. */
function readRunLedger(projectRoot) {
  const file = ledgerFilePath(projectRoot);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/** Open a store against the tmp repo with the same ports the hook binds. */
function openStore(projectRoot) {
  return createStateStore({
    projectRoot,
    sessionId: SESSION_ID,
    source: 'hook',
    appendEvent: (envelope) => appendLedgerEvent(projectRoot, envelope),
    resolveGitCommonDir: () => resolveGitCommonDir(projectRoot),
  });
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('intent-observe-pre — the tool allowlist', () => {
  it('answers to Write and Edit and to nothing else', () => {
    expect([...WRITE_TOOLS].sort()).toEqual(['Edit', 'Write']);
  });

  it('returns not-write-tool for every other tool, before any I/O', async () => {
    for (const tool of ['Bash', 'Agent', 'Read', 'WebFetch', undefined, null, 42]) {
      const out = await observeIntent({ tool_name: tool });
      expect(out.ok).toBe(false);
      expect(out.reason).toBe('not-write-tool');
    }
  });
});

describe('intent-observe-pre — S1 action allowlist (§3.3)', () => {
  it('classifies a path under a tests/ segment as a test action', () => {
    expect(s1Action('plugins/artibot/tests/hooks/a.js')).toBe('test');
    expect(s1Action('C:\\repo\\tests\\unit\\b.js')).toBe('test');
  });

  it('classifies a .test./.spec. basename as a test action wherever it sits', () => {
    expect(s1Action('lib/runtime/ledger.test.js')).toBe('test');
    expect(s1Action('src/a.spec.ts')).toBe('test');
  });

  it('classifies a markdown file as an artifact action', () => {
    expect(s1Action('docs/DESIGN.md')).toBe('artifact');
    expect(s1Action('README.MD')).toBe('artifact');
  });

  it('falls back to implement for everything else', () => {
    expect(s1Action('lib/core/config.js')).toBe('implement');
    expect(s1Action('')).toBe('implement');
    expect(s1Action(null)).toBe('implement');
  });

  it('only ever names S1 write actions — the allowlist cannot leak a non-S1 verb', () => {
    // The promotion asserts `mission.created`; an action outside S1_WRITE_ACTIONS
    // would silently make that branch unreachable instead of red.
    const S1 = ['artifact', 'implement', 'test'];
    const paths = [
      'tests/a.js', 'a.test.js', 'a.spec.tsx', 'docs/x.md', 'lib/y.js', '', null, undefined,
      'weird/path/with.no.ext', 'a/b/c/tests', '.md', 'tests/',
    ];
    for (const p of paths) expect(S1, String(p)).toContain(s1Action(p));
  });
});

describe('intent-observe-pre — mission id', () => {
  it('takes a valid payload mission id verbatim', async () => {
    expect(await resolveMissionId({ mission_id: 'M-20260904-Sabcdefgh' }, 'sess')).toBe('M-20260904-Sabcdefgh');
  });

  it('falls back to the SAME id stage ① uses, not to mission-id.js', async () => {
    // THE DISCREPANCY THIS PINS. Two different functions carry this name:
    // `lib/runtime/event-writer.js#sessionFallbackMissionId(sessionId, when)`
    // (positional, sha256 fallback, returns null) and
    // `lib/mission/mission-id.js#sessionFallbackMissionId({sessionId, nowMs})`
    // (object-arg, THROWS under 8 alphanumerics). Stage ① writes its
    // `mission.candidate_deferred` under the event-writer form
    // (`lib/runtime/middleware/tasks.js#resolveMissionIdentity`), so stage ②
    // must read under the same one or it looks for a row that is not there.
    const short = 'a-b-c';
    expect(await resolveMissionId({}, short)).toBe(sessionFallbackMissionId(short, new Date()));
    expect(await resolveMissionId({}, SESSION_ID)).toBe(sessionFallbackMissionId(SESSION_ID, new Date()));
    expect(await resolveMissionId({}, null)).toBeNull();
  });

  it('names the one allowed artifact path under the mission folder', () => {
    const p = intentArtifactPath('/repo', 'M-20260912-Sabcdefgh');
    expect(p.split(/[\\/]/).slice(-4)).toEqual(['.artibot', 'missions', 'M-20260912-Sabcdefgh', 'intent.md']);
  });

  it('joins the SAME segments artifact-lifecycle owns, so the latch cannot drift', () => {
    // The hook keeps its own join (the constants live behind a lazy import and
    // this helper is synchronous). That is a DUPLICATE DEFINITION, so the
    // drift is caught here instead: if `MISSIONS_DIR` or `ARTIFACT_BASENAME`
    // ever moves, the latch would silently test a path the writer no longer
    // produces, and this assertion goes red first.
    const id = 'M-20260912-Sabcdefgh';
    expect(intentArtifactPath('/repo', id))
      .toBe(path.join('/repo', ...MISSIONS_DIR, id, ARTIFACT_BASENAME.intent));
  });
});

// ---------------------------------------------------------------------------
// The hook as the host runs it
// ---------------------------------------------------------------------------

describe('intent-observe-pre — the hook as the host runs it (child process)', () => {
  let tmp;
  let home;
  let repo;
  let missionId;
  let pluginRootOverride;
  let previousPluginRoot;

  const writePayload = (over = {}) => ({
    cwd: repo,
    hook_event_name: 'PreToolUse',
    permission_mode: 'acceptEdits',
    prompt_id: 'pid-intent-1',
    session_id: SESSION_ID,
    tool_name: 'Write',
    tool_use_id: 'toolu_intent_1',
    ...over,
    tool_input: {
      file_path: path.join(repo, 'lib', 'parser.js'),
      content: 'export const x = 1;\n',
      ...(over.tool_input ?? {}),
    },
  });

  /**
   * Seed stage ①'s deferred candidate for this session. `over.missionId` files
   * it under a DIFFERENT id than today's derived one — that is the whole
   * cross-midnight case, and stage ① is the half that owns id issuance.
   */
  const seedDeferred = (over = {}) => appendLedgerEvent(repo, {
    event: 'mission.candidate_deferred',
    session_id: SESSION_ID,
    mission_id: over.missionId ?? missionId,
    source: 'hook',
    data: {
      reason: 'substantive-gate:deferred',
      signals: [],
      title: DEFERRED_TITLE,
      ...(over.data ?? {}),
    },
  });

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'artibot-intent-pre-')));
    home = path.join(tmp, 'home');
    repo = path.join(tmp, 'repo');
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore', windowsHide: true });
    missionId = sessionFallbackMissionId(SESSION_ID, new Date());

    // GATE 2, HELD OPEN ON PURPOSE. 4.61.0 ships
    // `runtime.artifactLifecycle.enabled: false` (Observe), and the hook checks
    // that key AFTER its ledger/store records — so on the shipped config every
    // write-through case below would go green for the wrong reason: no file,
    // because the gate is shut, not because the writer was measured. The cases
    // here measure the WRITER, so they supply their own open gate through the
    // documented override (`CLAUDE_PLUGIN_ROOT` → `lib/core/platform.js#getPluginRoot`)
    // instead of depending on whatever the release happens to ship. The shipped
    // value is pinned in tests/runtime/artifact-lifecycle-{apply,dryrun}.test.js.
    // Everything but the one key is copied from the real config, so this is the
    // live configuration with the kill switch flipped, not a stub.
    pluginRootOverride = path.join(tmp, 'plugin-root');
    mkdirSync(pluginRootOverride, { recursive: true });
    const liveConfig = JSON.parse(
      readFileSync(path.join(PLUGIN_ROOT, 'artibot.config.json'), 'utf-8'),
    );
    liveConfig.runtime.artifactLifecycle.enabled = true;
    // GATE 2b, THE PER-PROJECT HALF. The global switch alone no longer opens
    // the gate: `artifact-lifecycle.js#resolveArtifactGate` also demands the
    // marker file this key names, so that flipping the switch on does not start
    // writing `.artibot/missions/` into every checkout. Set EXPLICITLY rather
    // than relied on from the copied live config, so these cases state the
    // marker path they seed instead of inheriting it silently.
    liveConfig.runtime.artifactLifecycle.projectMarker = PROJECT_MARKER;
    writeFileSync(
      path.join(pluginRootOverride, 'artibot.config.json'),
      JSON.stringify(liveConfig, null, 2),
      'utf-8',
    );
    seedProjectMarker(repo);
    previousPluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
    process.env.CLAUDE_PLUGIN_ROOT = pluginRootOverride;
    // `loadConfig` memoises by (path, mtime); the in-process case below would
    // otherwise read a config cached by an earlier suite.
    resetConfig();
  });

  afterEach(() => {
    if (previousPluginRoot === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
    else process.env.CLAUDE_PLUGIN_ROOT = previousPluginRoot;
    resetConfig();
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  });

  it('promotes a deferred candidate: exactly one mission.created, store row, empty stdout', () => {
    expect(seedDeferred().ok).toBe(true);

    const r = runHook(writePayload(), home);
    expect(r.status).toBe(0);
    expect(r.stdoutBytes).toBe(0);

    const created = readRunLedger(repo).filter((l) => l.event === 'mission.created');
    expect(created).toHaveLength(1);
    expect(created[0].mission_id).toBe(missionId);
    expect(created[0].session_id).toBe(SESSION_ID);
    expect(created[0].source).toBe('hook');
    expect(created[0].data.title).toBe(DEFERRED_TITLE);
    expect(created[0].data.intent_revision).toBe(1);

    const mission = openStore(repo).getMission(missionId);
    expect(mission).not.toBeNull();
    expect(mission.title).toBe(DEFERRED_TITLE);
    expect(mission.intent.revision).toBe(1);
    expect(mission.intent.path).toBe(`missions/${missionId}/intent.md`);
  });

  it('is latched: a second Write in the same session appends no second mission.created', () => {
    expect(seedDeferred().ok).toBe(true);
    expect(runHook(writePayload(), home).status).toBe(0);
    const after1 = readRunLedger(repo).filter((l) => l.event === 'mission.created').length;

    const r2 = runHook(writePayload({ tool_use_id: 'toolu_intent_2' }), home);
    expect(r2.status).toBe(0);
    expect(r2.stdoutBytes).toBe(0);
    const after2 = readRunLedger(repo).filter((l) => l.event === 'mission.created').length;

    expect(after1).toBe(1);
    expect(after2).toBe(1);
  });

  it('adopts the CANDIDATE ROW\'s mission id when the session crossed UTC midnight', () => {
    // THE REGRESSION THIS PINS (review R1, Important 1). The mission id's date
    // part comes from `new Date()`, so a session that starts before 00:00 UTC
    // and writes after it derives a DIFFERENT id at stage ② than stage ① filed
    // its candidate under. Deriving the id first and filtering the ledger by it
    // made every such session a permanent `no-candidate` — in KST that is every
    // session crossing 09:00 local. Stage ① holds the issuing authority, so the
    // row's own `mission_id` is what stage ② must adopt.
    const yesterday = sessionFallbackMissionId(SESSION_ID, new Date(Date.now() - ONE_DAY_MS));
    expect(yesterday).not.toBe(missionId);
    expect(seedDeferred({ missionId: yesterday }).ok).toBe(true);

    const r = runHook(writePayload(), home);
    expect(r.status).toBe(0);
    expect(r.stdoutBytes).toBe(0);

    const created = readRunLedger(repo).filter((l) => l.event === 'mission.created');
    expect(created).toHaveLength(1);
    expect(created[0].mission_id).toBe(yesterday);
    expect(created[0].data.title).toBe(DEFERRED_TITLE);

    const mission = openStore(repo).getMission(yesterday);
    expect(mission).not.toBeNull();
    expect(mission.intent.path).toBe(`missions/${yesterday}/intent.md`);

    // The document follows the ADOPTED id, and today's derived id gets nothing.
    expect(existsSync(intentArtifactPath(repo, yesterday))).toBe(APPLY_CAN_WRITE);
    expect(existsSync(intentArtifactPath(repo, missionId))).toBe(false);
  });

  it.skipIf(!APPLY_CAN_WRITE)('latches on the ADOPTED id, not on the date-derived one', () => {
    // Without this the cross-midnight fix would promote on EVERY write of the
    // session: the latch reads `<derived>/intent.md`, which never appears.
    const yesterday = sessionFallbackMissionId(SESSION_ID, new Date(Date.now() - ONE_DAY_MS));
    expect(seedDeferred({ missionId: yesterday }).ok).toBe(true);
    expect(runHook(writePayload(), home).status).toBe(0);

    const r2 = runHook(writePayload({ tool_use_id: 'toolu_intent_2' }), home);
    expect(r2.status).toBe(0);
    expect(r2.stdoutBytes).toBe(0);
    expect(readRunLedger(repo).filter((l) => l.event === 'mission.created')).toHaveLength(1);
  });

  it('adopts the LATEST candidate row when the session filed more than one', () => {
    const older = sessionFallbackMissionId(SESSION_ID, new Date(Date.now() - 2 * ONE_DAY_MS));
    const newer = sessionFallbackMissionId(SESSION_ID, new Date(Date.now() - ONE_DAY_MS));
    expect(older).not.toBe(newer);
    expect(seedDeferred({ missionId: older, data: { title: 'the older one' } }).ok).toBe(true);
    expect(seedDeferred({ missionId: newer }).ok).toBe(true);

    expect(runHook(writePayload(), home).status).toBe(0);

    const created = readRunLedger(repo).filter((l) => l.event === 'mission.created');
    expect(created).toHaveLength(1);
    expect(created[0].mission_id).toBe(newer);
    expect(created[0].data.title).toBe(DEFERRED_TITLE);
  });

  it('records nothing when there is no candidate for this session (fail-closed)', () => {
    const r = runHook(writePayload(), home);
    expect(r.status).toBe(0);
    expect(r.stdoutBytes).toBe(0);
    expect(readRunLedger(repo).filter((l) => l.event === 'mission.created')).toHaveLength(0);
    expect(existsSync(intentArtifactPath(repo, missionId))).toBe(false);
  });

  it('touches no ledger at all for a non-write tool — the early return is real', () => {
    const r = runHook({ ...writePayload(), tool_name: 'Bash', tool_input: { command: 'ls' } }, home);
    expect(r.status).toBe(0);
    expect(r.stdoutBytes).toBe(0);
    expect(existsSync(ledgerFilePath(repo))).toBe(false);
  });

  it('appends no second mission.created when stage ① already created the mission', () => {
    // Stage ① path: the ledger line AND the store row already exist.
    expect(appendLedgerEvent(repo, {
      event: 'mission.created',
      session_id: SESSION_ID,
      mission_id: missionId,
      source: 'hook',
      data: { title: DEFERRED_TITLE, intent_revision: 1 },
    }).ok).toBe(true);
    const store = openStore(repo);
    const commit = store.updateMission(missionId, missionMutator(missionId, DEFERRED_TITLE, 1), {
      reason: 'mission.created', expectedVersion: store.getState().state_version,
    });
    expect(commit.ok).toBe(true);

    const r = runHook(writePayload(), home);
    expect(r.status).toBe(0);
    expect(r.stdoutBytes).toBe(0);
    expect(readRunLedger(repo).filter((l) => l.event === 'mission.created')).toHaveLength(1);
  });

  it('leaves .artibot/missions untouched when the payload names no cwd', () => {
    const p = writePayload();
    delete p.cwd;
    const r = runHook(p, home);
    expect(r.status).toBe(0);
    expect(r.stdoutBytes).toBe(0);
    expect(existsSync(ledgerFilePath(repo))).toBe(false);
  });

  describe('intent.md write-through (gated on bundle A)', () => {
    it.skipIf(!APPLY_CAN_WRITE)('writes intent.md exactly once, and a round trip is byte-identical', () => {
      expect(seedDeferred().ok).toBe(true);
      expect(runHook(writePayload(), home).status).toBe(0);

      const file = intentArtifactPath(repo, missionId);
      expect(existsSync(file)).toBe(true);
      const text = readFileSync(file, 'utf-8');

      const parsed = parseIntentMd(text);
      expect(parsed.contract.mission_id).toBe(missionId);
      expect(parsed.contract.intent_revision).toBe(1);
      expect(parsed.source.originalRequest).toBe(DEFERRED_TITLE);
      // Revision mode with an unmodified contract is byte-identical by design.
      expect(serializeIntentMd(parsed.contract, { originalText: text })).toBe(text);
      const spans = checkSpanConsistency(parsed.contract, parsed.source.originalRequest);
      expect(spans.issues.filter((i) => i.severity === 'error')).toEqual([]);

      // Second Write: the latch means the file is not rewritten.
      const before = readFileSync(file, 'utf-8');
      expect(runHook(writePayload({ tool_use_id: 'toolu_intent_2' }), home).status).toBe(0);
      expect(readFileSync(file, 'utf-8')).toBe(before);
    });

    it.skipIf(!APPLY_CAN_WRITE)('still records the mission when the FILE write fails', () => {
      // The records and the document are not one transaction, and this is the
      // case that proves which way the asymmetry runs: the ledger line and the
      // store row are written first and survive, the file does not appear, and
      // the process still exits 0 with empty stdout.
      //
      // A REAL failure, not a stub: the mission directory exists as a FILE
      // where `apply` needs a directory, so `ensureDirSync` throws inside
      // `writeOneArtifact` and comes back as `SkipReason.WRITE_FAILED`. The
      // latch above does not fire, because `<M>/intent.md` does not exist.
      expect(seedDeferred().ok).toBe(true);
      mkdirSync(path.join(repo, '.artibot', 'missions'), { recursive: true });
      writeFileSync(path.join(repo, '.artibot', 'missions', missionId), 'not a dir', 'utf-8');

      const r = runHook(writePayload(), home);
      expect(r.status).toBe(0);
      expect(r.stdoutBytes).toBe(0);

      // The promotion happened even though the document did not.
      const created = readRunLedger(repo).filter((l) => l.event === 'mission.created');
      expect(created).toHaveLength(1);
      expect(openStore(repo).getMission(missionId)).not.toBeNull();
      expect(existsSync(intentArtifactPath(repo, missionId))).toBe(false);
    });

    it.skipIf(!APPLY_CAN_WRITE)('names WHY the file write produced nothing', async () => {
      // In-process, because the child process is mute by design and the reason
      // exists only in the return value. Without this the case above would be
      // green for any failure whatsoever — including the hook throwing before
      // it ever reached `apply` — and could not tell the two apart.
      //
      // A SECOND session id, so this does not collide with the child-process
      // case above: the mission id is a pure function of (session id, UTC date).
      const sessionId = 'sess-writefail-2bcdefgh';
      const id = sessionFallbackMissionId(sessionId, new Date());
      expect(appendLedgerEvent(repo, {
        event: 'mission.candidate_deferred',
        session_id: sessionId,
        mission_id: id,
        source: 'hook',
        data: { reason: 'substantive-gate:deferred', signals: [], title: DEFERRED_TITLE },
      }).ok).toBe(true);
      mkdirSync(path.join(repo, '.artibot', 'missions'), { recursive: true });
      writeFileSync(path.join(repo, '.artibot', 'missions', id), 'not a dir', 'utf-8');

      const out = await observeIntent({
        cwd: repo,
        session_id: sessionId,
        tool_name: 'Write',
        tool_input: { file_path: path.join(repo, 'lib', 'parser.js'), content: 'x' },
      });

      expect(out.ok).toBe(true);
      expect(out.promoted).toBe(true);
      expect(out.written).toBe(0);
      // The exact code, from `artifact-lifecycle.js#SkipReason`. This is what
      // makes the assertion a measurement of the filesystem refusal rather than
      // of "something went wrong somewhere".
      expect(out.skipped).toEqual([SkipReason.WRITE_FAILED]);
    });

    it('states the gate when apply() still cannot write', () => {
      // Not a placeholder: this records WHICH side of the gate the suite ran
      // on, so a green run is never mistaken for a measured file write.
      expect(typeof APPLY_CAN_WRITE).toBe('boolean');
    });
  });
});

// ---------------------------------------------------------------------------
// The per-project gate — the completion criterion, measured on the real hook
// ---------------------------------------------------------------------------

describe('intent-observe-pre — the per-project gate (a/b/c matrix)', () => {
  let tmp;
  let previousPluginRoot;

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'artibot-intent-gate-')));
    previousPluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  });

  afterEach(() => {
    if (previousPluginRoot === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
    else process.env.CLAUDE_PLUGIN_ROOT = previousPluginRoot;
    resetConfig();
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  });

  /**
   * One sandbox: its own repo, its own plugin root, its own config. `marker`
   * chooses what sits at the marker path — nothing, a regular file, or a
   * DIRECTORY, which is the shape a `!isFile` resolver has to reject.
   */
  function sandbox(name, { enabled, marker }) {
    const home = path.join(tmp, name, 'home');
    const repo = path.join(tmp, name, 'repo');
    const root = path.join(tmp, name, 'plugin-root');
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    mkdirSync(repo, { recursive: true });
    mkdirSync(root, { recursive: true });
    execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore', windowsHide: true });

    const live = JSON.parse(readFileSync(path.join(PLUGIN_ROOT, 'artibot.config.json'), 'utf-8'));
    live.runtime.artifactLifecycle.enabled = enabled;
    live.runtime.artifactLifecycle.projectMarker = PROJECT_MARKER;
    writeFileSync(path.join(root, 'artibot.config.json'), JSON.stringify(live, null, 2), 'utf-8');

    if (marker === 'file') seedProjectMarker(repo);
    if (marker === 'dir') {
      mkdirSync(path.join(repo, ...PROJECT_MARKER.split('/')), { recursive: true });
    }

    const missionId = sessionFallbackMissionId(SESSION_ID, new Date());
    expect(appendLedgerEvent(repo, {
      event: 'mission.candidate_deferred',
      session_id: SESSION_ID,
      mission_id: missionId,
      source: 'hook',
      data: { reason: 'substantive-gate:deferred', signals: [], title: DEFERRED_TITLE },
    }).ok).toBe(true);

    return { home, repo, root, missionId };
  }

  /** Run the hook in that sandbox and report only what the criterion names. */
  function measure(box) {
    process.env.CLAUDE_PLUGIN_ROOT = box.root;
    resetConfig();
    const r = runHook({
      cwd: box.repo,
      hook_event_name: 'PreToolUse',
      session_id: SESSION_ID,
      tool_name: 'Write',
      tool_use_id: 'toolu_gate_1',
      tool_input: { file_path: path.join(box.repo, 'lib', 'parser.js'), content: 'x\n' },
    }, box.home);
    return {
      status: r.status,
      stdout: r.stdout,
      stdoutBytes: r.stdoutBytes,
      file: existsSync(intentArtifactPath(box.repo, box.missionId)),
      created: readRunLedger(box.repo).filter((l) => l.event === 'mission.created').length,
    };
  }

  it('suppresses the FILE and nothing else: a/b closed, c open', () => {
    // (a) global false + marker present — the shipped 4.61.0 configuration.
    // (b) global true  + marker absent  — the case this gate exists for: the
    //     owner flipped the switch on, and an unmarked project still gets
    //     nothing. Before the per-project gate this wrote a file.
    // (c) global true  + marker present — the only combination that writes.
    const a = measure(sandbox('a', { enabled: false, marker: 'file' }));
    const b = measure(sandbox('b', { enabled: true, marker: 'none' }));
    const c = measure(sandbox('c', { enabled: true, marker: 'file' }));

    // Exit status and stdout are IDENTICAL across all three. A PreToolUse hook
    // that spoke would cancel the user's tool call, so the gate must be
    // invisible on both channels — asserted as bytes, not as a decoded string.
    for (const [name, m] of [['a', a], ['b', b], ['c', c]]) {
      expect(m.status, `${name}: exit`).toBe(0);
      expect(m.stdoutBytes, `${name}: stdout length`).toBe(0);
      expect(m.stdout.equals(a.stdout), `${name}: stdout bytes`).toBe(true);
    }

    // The RECORD happens in all three — ledger writes are Observe-legal.
    expect([a.created, b.created, c.created]).toEqual([1, 1, 1]);

    // The FILE happens only in (c).
    expect([a.file, b.file]).toEqual([false, false]);
    expect(c.file).toBe(APPLY_CAN_WRITE);
  });

  it('answers write-disabled IN PROCESS when the marker is absent', async () => {
    // WHAT THE a/b/c MATRIX CANNOT SEE, AND WHY THIS CASE EXISTS. Revert the
    // gate to a direct `runtime.artifactLifecycle.enabled` read and case (b)
    // stays GREEN: the hook would call `apply({write: true})`, `apply` throws
    // on the closed PROJECT gate, and `observeIntent`'s own catch turns that
    // into exit 0, empty stdout, no file and a recorded mission — the four
    // things the matrix measures, unchanged. Only the RETURN VALUE separates
    // "the gate said no" from "the writer exploded and was swallowed", and the
    // child process is mute by design, so this has to run in process.
    //
    // MEASURED: with that reversion in place this case goes RED and reports
    // `ok: false` with `apply`'s marker-path message.
    const box = sandbox('b-in-process', { enabled: true, marker: 'none' });
    process.env.CLAUDE_PLUGIN_ROOT = box.root;
    resetConfig();

    const out = await observeIntent({
      cwd: box.repo,
      session_id: SESSION_ID,
      tool_name: 'Write',
      tool_input: { file_path: path.join(box.repo, 'lib', 'parser.js'), content: 'x\n' },
    });

    // The SAME vocabulary the global-off case returns. Project-off is not a new
    // status: downstream readers pin `write-disabled` and must not have to
    // learn a second spelling for "no file, on purpose".
    expect(out.ok).toBe(true);
    expect(out.reason).toBe('write-disabled');
    expect(out.written).toBe(0);
    // The records still happened — the gate suppresses the file and nothing else.
    expect(out.promoted).toBe(true);
    expect(existsSync(intentArtifactPath(box.repo, box.missionId))).toBe(false);
  });

  it('writes nothing when the marker path is a DIRECTORY, not a file', () => {
    // `existsSync` alone would call this open. The resolver's contract says a
    // REGULAR FILE, and a directory is the cheapest way a project accidentally
    // satisfies a laxer check.
    const m = measure(sandbox('dir', { enabled: true, marker: 'dir' }));
    expect(m.status).toBe(0);
    expect(m.stdoutBytes).toBe(0);
    expect(m.created).toBe(1);
    expect(m.file).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Stdout invariance — the block-point guarantee
// ---------------------------------------------------------------------------

describe('intent-observe-pre — stdout invariance across failure modes', () => {
  let tmp;
  let home;
  let repo;
  let blocked;
  let broken;

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'artibot-intent-fw-')));
    home = path.join(tmp, 'home');
    repo = path.join(tmp, 'repo');
    blocked = path.join(tmp, 'blocked');
    broken = path.join(tmp, 'broken');
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    for (const dir of [repo, blocked, broken]) {
      mkdirSync(dir, { recursive: true });
      execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore', windowsHide: true });
    }
    // The ledger's own parent exists as a FILE where the writer needs a
    // directory (the shape `tests/firewall/host-payload-contract.test.js` uses
    // for its case 4). `git init` runs first because after ADR-011 that parent
    // sits inside the repository's git common dir.
    writeFileSync(path.dirname(ledgerFilePath(blocked)), 'not a dir', 'utf-8');
  });

  afterEach(() => {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  });

  it('produces byte-identical empty stdout and exit 0 on every reachable path', () => {
    const sid = SESSION_ID;
    const base = (over = {}) => ({
      cwd: repo,
      hook_event_name: 'PreToolUse',
      session_id: sid,
      tool_name: 'Write',
      tool_use_id: 'toolu_fw_1',
      tool_input: { file_path: path.join(repo, 'a.js'), content: 'x' },
      ...over,
    });
    const missionId = sessionFallbackMissionId(sid, new Date());
    expect(appendLedgerEvent(repo, {
      event: 'mission.candidate_deferred',
      session_id: sid,
      mission_id: missionId,
      source: 'hook',
      data: { reason: 'substantive-gate:deferred', signals: [], title: DEFERRED_TITLE },
    }).ok).toBe(true);

    const cases = [
      ['1 success (promotion)', JSON.stringify(base())],
      ['2 unwritable ledger', JSON.stringify(base({ cwd: blocked }))],
      ['3 no candidate', JSON.stringify(base({ session_id: 'sess-other-9zyxwvut' }))],
      ['4 non-write tool', JSON.stringify(base({ tool_name: 'Bash', tool_input: { command: 'ls' } }))],
      ['5 not JSON', 'this is not json {{{'],
      ['6 tool_input of the wrong type', JSON.stringify(base({ tool_input: 42 }))],
    ];
    // Scanner self-check: a silently shrunken table would measure less while
    // staying green.
    expect(cases).toHaveLength(6);

    const results = cases.map(([name, raw]) => [name, runHook(null, home, { raw })]);
    for (const [name, r] of results) {
      expect(r.stdoutBytes, `${name}: stdout must be empty`).toBe(0);
      expect(r.status, `${name}: exit must be 0 (2 would cancel the tool call)`).toBe(0);
    }
    // Byte-identical, not merely both-empty.
    const first = results[0][1].stdout;
    for (const [name, r] of results) {
      expect(r.stdout.equals(first), `${name}: stdout bytes must match case 1`).toBe(true);
    }
  });

  it('holds stdout and exit status when a dependency FAILS AT IMPORT TIME', () => {
    // The third measurement of the brief's stdout table, compared against the
    // two that were already measured, IN ONE PLACE — (a) the success path and
    // (b) a real ledger WRITE failure. Comparing them here is the point: an
    // import failure is the mode that used to kill the process before `main()`
    // ran, which left stdout at 0 bytes but exit at 1. exit 1 does not cancel a
    // tool call (only exit 2 does), so that was never a block-point breach —
    // but it was an unmeasured claim, and the hook's own header promises exit 0
    // "under every input".
    const sid = SESSION_ID;
    const missionId = sessionFallbackMissionId(sid, new Date());
    const payload = (cwd) => ({
      cwd,
      hook_event_name: 'PreToolUse',
      session_id: sid,
      tool_name: 'Write',
      tool_use_id: 'toolu_imp_1',
      tool_input: { file_path: path.join(cwd, 'a.js'), content: 'x' },
    });
    const candidate = (root) => appendLedgerEvent(root, {
      event: 'mission.candidate_deferred',
      session_id: sid,
      mission_id: missionId,
      source: 'hook',
      data: { reason: 'substantive-gate:deferred', signals: [], title: DEFERRED_TITLE },
    });
    expect(candidate(repo).ok).toBe(true);
    expect(candidate(broken).ok).toBe(true);
    const beforeBroken = readRunLedger(broken).length;

    const importFailure = runHookWithBrokenLedger(payload(broken), home, tmp);
    const results = [
      ['a success', runHook(payload(repo), home)],
      ['b ledger write failure', runHook(payload(blocked), home)],
      ['c ledger import failure', importFailure],
    ];
    expect(results).toHaveLength(3);

    // FIXTURE SELF-CHECK. `main()` has to have RETURNED, and have returned the
    // import rejection — a `load` hook that stopped matching would otherwise
    // leave this case green while quietly measuring the ordinary path.
    expect(importFailure.outcome).not.toBeNull();
    expect(importFailure.outcome.ok).toBe(false);
    expect(importFailure.outcome.reason).toMatch(/ledger module failed to load/);

    for (const [name, r] of results) {
      expect(r.stdoutBytes, `${name}: stdout must be empty`).toBe(0);
      expect(r.status, `${name}: exit must be 0`).toBe(0);
      expect(r.stdout.equals(results[0][1].stdout), `${name}: stdout bytes must match (a)`).toBe(true);
    }

    // (a) really promoted, so the comparison is against a LIVE success and not
    // against three mutually silent no-ops.
    expect(readRunLedger(repo).filter((l) => l.event === 'mission.created')).toHaveLength(1);
    // (c) wrote nothing: the module that appends is the module that failed.
    expect(readRunLedger(broken)).toHaveLength(beforeBroken);
    expect(readRunLedger(broken).filter((l) => l.event === 'mission.created')).toHaveLength(0);
    expect(existsSync(intentArtifactPath(broken, missionId))).toBe(false);
  });

  it('leaves no ledger behind when the ledger directory is unwritable', () => {
    const r = runHook({
      cwd: blocked,
      session_id: SESSION_ID,
      tool_name: 'Write',
      tool_input: { file_path: path.join(blocked, 'a.js'), content: 'x' },
    }, home);
    expect(r.status).toBe(0);
    expect(r.stdoutBytes).toBe(0);
    expect(existsSync(ledgerFilePath(blocked))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Gate self-verification
// ---------------------------------------------------------------------------

describe('intent-observe-pre — gate self-verification', () => {
  it('never imports a stdout writer and names no permission decision', () => {
    expect(HOOK_SRC).not.toMatch(/import\s*\{[^}]*\bwriteStdout\b/);
    expect(HOOK_SRC).not.toMatch(/\bwriteStdout\s*\(/);
    expect(HOOK_SRC).not.toMatch(/['"]permissionDecision['"]/);
    expect(HOOK_SRC).not.toMatch(/process\.stdout\.write\s*\(/);
    expect(HOOK_SRC).not.toMatch(/process\.exit\s*\(/);
    expect(HOOK_SRC).not.toMatch(/console\.(log|info|warn|error)\s*\(/);
  });

  it('pins its exit code as the first statement of main(), before any await', () => {
    expect(HOOK_SRC).toContain('process.exitCode = 0');
    // SCOPED TO main(). A file-wide position check is the wrong measurement:
    // `observeIntent` is declared above `main` and legitimately awaits
    // `loadConfig`, so a whole-file "first await" index says nothing about the
    // entry point. What matters is that the process cannot reach an await in
    // THIS function with an unpinned exit code.
    const body = HOOK_SRC.slice(HOOK_SRC.indexOf('export async function main()'));
    const pin = body.indexOf('process.exitCode = 0');
    const firstAwait = body.search(/\bawait\b/);
    expect(pin).toBeGreaterThan(-1);
    expect(firstAwait).toBeGreaterThan(pin);
  });

  it('is registered exactly once, on Write|Edit, under PreToolUse', () => {
    const groups = HOOKS_JSON.hooks.PreToolUse ?? [];
    const matched = groups.filter(
      (g) => (g.hooks ?? []).some(
        (h) => String(h.command ?? '').endsWith('scripts/hooks/intent-observe-pre.js'),
      ),
    );
    expect(matched).toHaveLength(1);
    // PLAIN STRING matcher, never the `tool == "..."` expression form: the A/B
    // recorded in tests/firewall/host-payload-contract.test.js measured the
    // expression form firing 0 times on host 2.1.260.
    expect(matched[0].matcher).toBe('Write|Edit');
    expect(matched[0].hooks).toHaveLength(1);
    // SECONDS, not milliseconds — the whole file moved 5000 → 5 (retro #50).
    expect(matched[0].hooks[0].timeout).toBe(5);
    expect(matched[0].hooks[0].type).toBe('command');
  });

  it('does not fork the PreToolUse timeout scale', () => {
    const groups = HOOKS_JSON.hooks.PreToolUse ?? [];
    const timeouts = new Set(groups.flatMap((g) => (g.hooks ?? []).map((h) => h.timeout)));
    expect([...timeouts]).toEqual([5]);
  });
});

// ---------------------------------------------------------------------------
// Spawn budget — informational
// ---------------------------------------------------------------------------

describe('intent-observe-pre — spawn budget (informational)', () => {
  let tmp;
  let home;
  let repo;

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'artibot-intent-lat-')));
    home = path.join(tmp, 'home');
    repo = path.join(tmp, 'repo');
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore', windowsHide: true });
  });

  afterEach(() => {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  });

  it('runs the latched path N=20 times under a 3000 ms headroom', () => {
    const missionId = sessionFallbackMissionId(SESSION_ID, new Date());
    const dir = path.join(repo, '.artibot', 'missions', missionId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'intent.md'), '# already here\n', 'utf-8');

    const payload = {
      cwd: repo,
      session_id: SESSION_ID,
      tool_name: 'Write',
      tool_input: { file_path: path.join(repo, 'a.js'), content: 'x' },
    };

    const samples = [];
    for (let i = 0; i < 20; i += 1) {
      const t0 = Date.now();
      const r = runHook(payload, home);
      samples.push(Date.now() - t0);
      expect(r.status).toBe(0);
      expect(r.stdoutBytes).toBe(0);
    }
    samples.sort((a, b) => a - b);
    const p50 = samples[Math.floor(samples.length * 0.5)];
    const p95 = samples[Math.floor(samples.length * 0.95)];
    // HEADROOM, not a calibrated budget. A tighter bound on a shared CI box is
    // a flake generator, and this file has no measurement that would justify
    // one (rules §9: write next to the gate what it cannot see).
    expect(p50).toBeLessThan(3000);
    expect(p95).toBeLessThan(3000);
    // The latch must not have appended anything.
    expect(readRunLedger(repo).filter((l) => l.event === 'mission.created')).toHaveLength(0);
  });
});
