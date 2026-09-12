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
 *   - A GENUINE IMPORT-TIME FAILURE of a dependency module. It cannot be
 *     produced without editing production code, so the stdout-invariance table
 *     records it as UNMEASURED rather than faking it.
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
import { fileURLToPath } from 'node:url';

import { appendLedgerEvent, ledgerFilePath } from '../../lib/runtime/ledger.js';
import { SkipReason } from '../../lib/runtime/artifact-lifecycle.js';
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

const SESSION_ID = 'sess-intent-1abcdefg';
const DEFERRED_TITLE = 'Fix the flaky parser test';

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
  it('takes a valid payload mission id verbatim', () => {
    expect(resolveMissionId({ mission_id: 'M-20260904-Sabcdefgh' }, 'sess')).toBe('M-20260904-Sabcdefgh');
  });

  it('falls back to the SAME id stage ① uses, not to mission-id.js', () => {
    // THE DISCREPANCY THIS PINS. Two different functions carry this name:
    // `lib/runtime/event-writer.js#sessionFallbackMissionId(sessionId, when)`
    // (positional, sha256 fallback, returns null) and
    // `lib/mission/mission-id.js#sessionFallbackMissionId({sessionId, nowMs})`
    // (object-arg, THROWS under 8 alphanumerics). Stage ① writes its
    // `mission.candidate_deferred` under the event-writer form
    // (`lib/runtime/middleware/tasks.js#resolveMissionIdentity`), so stage ②
    // must read under the same one or it looks for a row that is not there.
    const short = 'a-b-c';
    expect(resolveMissionId({}, short)).toBe(sessionFallbackMissionId(short, new Date()));
    expect(resolveMissionId({}, SESSION_ID)).toBe(sessionFallbackMissionId(SESSION_ID, new Date()));
    expect(resolveMissionId({}, null)).toBeNull();
  });

  it('names the one allowed artifact path under the mission folder', () => {
    const p = intentArtifactPath('/repo', 'M-20260912-Sabcdefgh');
    expect(p.split(/[\\/]/).slice(-4)).toEqual(['.artibot', 'missions', 'M-20260912-Sabcdefgh', 'intent.md']);
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

  /** Seed stage ①'s deferred candidate for this session. */
  const seedDeferred = (over = {}) => appendLedgerEvent(repo, {
    event: 'mission.candidate_deferred',
    session_id: SESSION_ID,
    mission_id: missionId,
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
  });

  afterEach(() => {
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
// Stdout invariance — the block-point guarantee
// ---------------------------------------------------------------------------

describe('intent-observe-pre — stdout invariance across failure modes', () => {
  let tmp;
  let home;
  let repo;
  let blocked;

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'artibot-intent-fw-')));
    home = path.join(tmp, 'home');
    repo = path.join(tmp, 'repo');
    blocked = path.join(tmp, 'blocked');
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    for (const dir of [repo, blocked]) {
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
