/**
 * `scripts/hooks/_plan-observe-record.js` — the `plan.md` half of the
 * PreToolUse(`Write|Edit`) observer: a write to `.artibot/missions/<M>/plan.md`
 * becomes a StateStore `plan.revision` bump plus a `plan.revised` ledger line,
 * and — behind the kill switch only — a rendered `plan.md`.
 *
 * Two layers, the same split `tests/hooks/intent-observe-pre.test.js` uses:
 *   - `observePlanWrite` called IN PROCESS against a sandbox repo, because the
 *     named early-return reasons and the `artifact` labels exist only in the
 *     return value (the module is mute by design and cannot report them);
 *   - ONE spawn of the REAL `intent-observe-pre.js` as a CHILD PROCESS, which is
 *     the only thing that proves the delegation actually fires in the process
 *     the host launches, and the only place stdout bytes and the exit status
 *     are observable.
 *
 * PreToolUse IS A BLOCK POINT. exit 2 plus a `permissionDecision` on stdout is
 * how such a hook CANCELS the user's tool call, so every stdout/exit assertion
 * below is a safety assertion, not a tidiness one.
 *
 * EVERY CASE RUNS IN A `mkdtemp` SANDBOX with its own `.git` directory and its
 * own `CLAUDE_PLUGIN_ROOT`. Nothing here may reach `<worktree>/.artibot/`,
 * `<repo>/.git/artibot/` or `runtime/` — a test that wrote a `plan.revised`
 * line into the live ledger would corrupt the very measurement this module
 * exists to produce.
 *
 * WHAT THIS FILE DOES NOT PROVE (rules §9 — write it next to the gate):
 *   - THAT THE HOST FIRES PreToolUse FOR `Write`/`Edit` IN PRODUCTION. The
 *     registration assertions live in `intent-observe-pre.test.js` and check the
 *     FILE, not the host.
 *   - WHOSE BYTES WIN WHEN THE GATE IS OPEN. On this branch the tool call that
 *     triggers the hook is itself about to write `plan.md`, so a first `Write`
 *     races the runtime's render and an `Edit` always hits `ALREADY_EXISTS`.
 *     The cases below pin what THIS module does; the successor rule is a
 *     Wave-11 decision (the outcome-md emitter) and is not decided here.
 *   - LATENCY. There is no timing case: a tmpdir repo with a handful of ledger
 *     lines is not a live repo, and a bound derived from one would be a flake
 *     generator rather than a measurement.
 *   - THAT A `plan.revised` LINE MEANS THE PLAN WAS WRITTEN. PreToolUse fires
 *     BEFORE the tool runs. A cancelled or failed write still records.
 *
 * @module tests/hooks/plan-observe-record
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { appendLedgerEvent, ledgerFilePath } from '../../lib/runtime/ledger.js';
import { computeIdempotencyKey } from '../../lib/runtime/artifact-lifecycle.js';
import { sessionFallbackMissionId } from '../../lib/runtime/event-writer.js';
import { createStateStore } from '../../lib/project-state/state-manager.js';
import { resolveGitCommonDir } from '../../lib/project-state/git-common-dir.js';
import { missionMutator, planRevisionMutator } from '../../lib/runtime/middleware/tasks.js';
import {
  DEFAULT_PLAN_MODE, FIRST_PLAN_REVISION, parsePlanMd,
} from '../../lib/planning/plan-artifact.js';
import { observePlanWrite } from '../../scripts/hooks/_plan-observe-record.js';

/**
 * STORE INJECTION, for the two cases the real store cannot produce.
 *
 * `openMissionStore` is wrapped rather than replaced: `storeOverride` is null
 * for every case below except the two that set it, so those cases run against
 * the REAL StateStore, on the real filesystem, and nothing about them is
 * stubbed. When it is set, the override receives the real store and returns a
 * decorated copy — so `getState`, `location` and everything the module does not
 * care about stay genuine, and only the one port under test is a fake.
 *
 * WHY A FAKE IS NECESSARY AT ALL. Both cases are states the store REFUSES to
 * enter: `validate.js#validateMission:94-97` rejects a mission row without an
 * integer `intent.revision`, and a two-in-a-row `updateMission` conflict needs a
 * second writer racing this one. Reaching them any other way would mean either
 * a vacuous test or production code bent to be testable.
 *
 * `vi.hoisted` because `vi.mock` factories are hoisted above the imports; the
 * flag has to exist before the factory can close over it.
 */
const injected = vi.hoisted(() => ({ storeOverride: null }));

vi.mock('../../lib/runtime/middleware/tasks.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    openMissionStore: (...args) => {
      const real = actual.openMissionStore(...args);
      return injected.storeOverride === null ? real : injected.storeOverride(real);
    },
  };
});

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK = path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'intent-observe-pre.js');

const SESSION_ID = 'sess-planmd-1abcdefg';
const MISSION_TITLE = 'Emit plan.md on a plan write';

let tmp;
let home;
let repo;
let pluginRoot;
let missionId;

/** The one path a mission's plan document may occupy. */
function planPath(root, id) {
  return path.join(root, '.artibot', 'missions', id, 'plan.md');
}

/** Parsed ledger lines, `[]` when the file was never created. */
function readRunLedger(root) {
  const file = ledgerFilePath(root);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/** Just the plan.revised lines. */
function planLines(root) {
  return readRunLedger(root).filter((l) => l.event === 'plan.revised');
}

/** A store against the sandbox repo, with the ports the hook binds. */
function openStore(root) {
  return createStateStore({
    projectRoot: root,
    sessionId: SESSION_ID,
    source: 'hook',
    appendEvent: (envelope) => appendLedgerEvent(root, envelope),
    resolveGitCommonDir: () => resolveGitCommonDir(root),
  });
}

/**
 * Seed a mission the way stage ② leaves it: the `mission.created` ledger line
 * FIRST, then the store row. The order is the orphan rule (`/doctor` Check 8-③)
 * — a row whose mission has no `mission.created` event is an orphan, and a
 * fixture that produced one would be testing against an invalid store.
 */
function seedMission(id = missionId) {
  expect(appendLedgerEvent(repo, {
    event: 'mission.created',
    session_id: SESSION_ID,
    mission_id: id,
    source: 'hook',
    data: { title: MISSION_TITLE, intent_revision: 1 },
  }).ok).toBe(true);
  const store = openStore(repo);
  const commit = store.updateMission(id, missionMutator(id, MISSION_TITLE, 1), {
    reason: 'mission.created', expectedVersion: store.getState().state_version,
  });
  expect(commit.ok).toBe(true);
}

/** A PreToolUse payload aimed at this mission's plan.md. */
function payload(over = {}) {
  const filePath = over.filePath ?? planPath(repo, missionId);
  return {
    cwd: repo,
    hook_event_name: 'PreToolUse',
    session_id: SESSION_ID,
    tool_name: over.tool_name ?? 'Write',
    tool_use_id: over.tool_use_id === undefined ? 'toolu_plan_1' : over.tool_use_id,
    tool_input: { file_path: filePath, content: '# plan\n' },
  };
}

/**
 * The per-project marker, relative to the project root.
 *
 * The shipped value of `runtime.artifactLifecycle.projectMarker`. Spelled out
 * rather than read from the live config, so a change to that key turns the
 * matrix below RED instead of quietly following it.
 */
const PROJECT_MARKER = '.artibot/project.md';

/** Create the marker file that opens the per-project half of the gate. */
function seedProjectMarker(root) {
  const file = path.join(root, ...PROJECT_MARKER.split('/'));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, '# project\n', 'utf-8');
  return file;
}

/**
 * Point `getPluginRoot()` at a sandbox config with the kill switch set.
 *
 * `projectMarker` is written EXPLICITLY. The gate has two halves now —
 * `artifact-lifecycle.js#resolveArtifactGate` wants the global switch AND the
 * marker file — and a fixture that inherited the key from the copied live
 * config would stop stating which marker path its repo seeds.
 *
 * @param {boolean} enabled the GLOBAL switch
 * @param {string} [root] which plugin root to write into
 */
function setKillSwitch(enabled, root = pluginRoot) {
  const live = JSON.parse(readFileSync(path.join(PLUGIN_ROOT, 'artibot.config.json'), 'utf-8'));
  live.runtime.artifactLifecycle.enabled = enabled;
  live.runtime.artifactLifecycle.projectMarker = PROJECT_MARKER;
  writeFileSync(
    path.join(root, 'artibot.config.json'), JSON.stringify(live, null, 2), 'utf-8',
  );
}

/** Run the REAL hook exactly as the host does: fresh process, JSON on stdin. */
function runHook(raw) {
  const res = spawnSync(process.execPath, [HOOK], {
    input: raw,
    env: {
      ...process.env, HOME: home, USERPROFILE: home, CLAUDE_PLUGIN_ROOT: pluginRoot,
    },
    windowsHide: true,
  });
  const stdout = res.stdout ?? Buffer.alloc(0);
  return { status: res.status, stdout, stdoutBytes: stdout.length };
}

let previousPluginRoot;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'artibot-plan-md-')));
  home = path.join(tmp, 'home');
  repo = path.join(tmp, 'repo');
  pluginRoot = path.join(tmp, 'plugin-root');
  mkdirSync(path.join(home, '.claude'), { recursive: true });
  mkdirSync(repo, { recursive: true });
  mkdirSync(pluginRoot, { recursive: true });
  // A REAL `.git` DIRECTORY. After ADR-011 the ledger sits inside the git common
  // dir, so a sandbox without one would either fail to resolve a project root or
  // resolve to an ancestor — which is how a test writes into a real store.
  execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore', windowsHide: true });
  missionId = sessionFallbackMissionId(SESSION_ID, new Date());
  // The per-project half of the gate, held OPEN for the whole file: the global
  // switch alone no longer authorises a file, and the cases that measure the
  // writer are measuring the WRITER, not this marker. The marker's own effect
  // is measured in the a/b/c matrix at the end of this file.
  seedProjectMarker(repo);
  // SHIPPED VALUE BY DEFAULT (4.61.0 ships `false`). Cases that measure the
  // writer open it explicitly, so a green run is never mistaken for a file the
  // shipped configuration would have produced.
  setKillSwitch(false);
  previousPluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  process.env.CLAUDE_PLUGIN_ROOT = pluginRoot;
});

afterEach(() => {
  // FIRST, before anything can fail: a leaked override would silently stub the
  // store for every later case in the file.
  injected.storeOverride = null;
  if (previousPluginRoot === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
  else process.env.CLAUDE_PLUGIN_ROOT = previousPluginRoot;
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
});

// ---------------------------------------------------------------------------
// (a) the record itself
// ---------------------------------------------------------------------------

describe('_plan-observe-record — one plan.md write', () => {
  it('bumps the row 1 → 2 and appends exactly one plan.revised line', async () => {
    seedMission();
    expect(openStore(repo).getMission(missionId).plan.revision).toBe(FIRST_PLAN_REVISION);

    const out = await observePlanWrite(payload());

    expect(out.ok).toBe(true);
    expect(out.missionId).toBe(missionId);
    expect(out.revision).toBe(2);
    expect(out.ledger).toBe('appended');
    expect(out.store).toBe('written');

    const lines = planLines(repo);
    expect(lines).toHaveLength(1);
    expect(lines[0].mission_id).toBe(missionId);
    expect(lines[0].session_id).toBe(SESSION_ID);
    expect(lines[0].source).toBe('hook');
    expect(lines[0].data.revision).toBe(2);
    expect(lines[0].data.mode).toBe(DEFAULT_PLAN_MODE);
    expect(lines[0].data.tool_use_id).toBe('toolu_plan_1');
    // The exact key `artifact-lifecycle.js#computeIdempotencyKey` produces, so a
    // hand-built string here cannot drift from the one the writer would use.
    expect(lines[0].idempotency_key).toBe(`mission:${missionId}:plan:rev-2`);
    expect(lines[0].idempotency_key)
      .toBe(computeIdempotencyKey({ missionId, kind: 'plan', revision: 2 }));

    const row = openStore(repo).getMission(missionId);
    expect(row.plan.revision).toBe(2);
    expect(row.plan.path).toBe(`missions/${missionId}/plan.md`);
    // PRESERVED, not replaced — the mutator's whole contract.
    expect(row.title).toBe(MISSION_TITLE);
    expect(row.intent.revision).toBe(1);
    expect(row.status).toBe('queued');
  });

  it('takes the mission from the PATH, not from the session', async () => {
    // A plan under a DIFFERENT mission than the session's fallback id. If the
    // mission came from the session, this would record against the wrong one —
    // or find no row and refuse.
    const other = 'M-20260101-042';
    seedMission(other);
    const out = await observePlanWrite(payload({ filePath: planPath(repo, other) }));
    expect(out.ok).toBe(true);
    expect(out.missionId).toBe(other);
    expect(planLines(repo).map((l) => l.mission_id)).toEqual([other]);
  });
});

// ---------------------------------------------------------------------------
// (b) redelivery vs. a genuine second edit
// ---------------------------------------------------------------------------

describe('_plan-observe-record — dedupe on tool_use_id', () => {
  it('records the SAME tool_use_id once, and does not bump the row again', async () => {
    seedMission();
    expect((await observePlanWrite(payload())).revision).toBe(2);

    const again = await observePlanWrite(payload());
    expect(again.ok).toBe(true);
    expect(again.reason).toBe('deduped');
    expect(again.ledger).toBe('deduped');
    expect(again.store).toBe('skipped');

    expect(planLines(repo)).toHaveLength(1);
    expect(openStore(repo).getMission(missionId).plan.revision).toBe(2);
  });

  it('treats a DIFFERENT tool_use_id as a second revision', async () => {
    seedMission();
    expect((await observePlanWrite(payload())).revision).toBe(2);

    const second = await observePlanWrite(payload({ tool_use_id: 'toolu_plan_2' }));
    expect(second.ok).toBe(true);
    expect(second.revision).toBe(3);
    expect(planLines(repo).map((l) => l.data.revision)).toEqual([2, 3]);
    expect(openStore(repo).getMission(missionId).plan.revision).toBe(3);
  });

  it('scans past a FOLDED line that lost its tool_use_id, and writes the revision anyway', async () => {
    // `tool_use_id` is an UNDECLARED `data` key, so the writer's oversize fold
    // may drop it from a line that is already on disk:
    // `event-writer.js#foldOversized` keeps only `requiredDataKeys(spec)` —
    // `revision`, `mode` — plus `evidence_refs`. The dedupe scan must therefore
    // never DEPEND on the key being present. This fixture is a hand-built
    // folded line, marker and all; the scan has to walk past it without
    // throwing and without treating it as a match.
    seedMission();
    expect(appendLedgerEvent(repo, {
      event: 'plan.revised',
      session_id: SESSION_ID,
      mission_id: missionId,
      source: 'hook',
      data: {
        revision: 2,
        mode: DEFAULT_PLAN_MODE,
        evidence_refs: ['ledger-fold:dropped=tool_use_id'],
      },
    }).ok).toBe(true);
    const seeded = planLines(repo);
    expect(seeded).toHaveLength(1);
    expect(seeded[0].data.tool_use_id).toBeUndefined();

    const out = await observePlanWrite(payload());

    expect(out.ok).toBe(true);
    expect(out.reason).toBeUndefined();
    expect(out.ledger).toBe('appended');
    expect(out.revision).toBe(2);

    const lines = planLines(repo);
    expect(lines).toHaveLength(2);
    expect(lines[1].data.tool_use_id).toBe('toolu_plan_1');
    // BOTH LINES SAY revision 2, and that is the harm bound: the reader's fold
    // takes the maximum, so this reads as one revision. The line count is the
    // only place the un-deduped repeat stays visible.
    expect(lines.map((l) => l.data.revision)).toEqual([2, 2]);
    expect(openStore(repo).getMission(missionId).plan.revision).toBe(2);
  });

  it('has NO dedupe without a tool_use_id — harmless to the fold, visible in the count', async () => {
    // The other half of the header's claim. The ledger fold takes the MAXIMUM
    // revision, so two lines read as one revision; the LINE COUNT is where the
    // double bump remains visible, and that is what is asserted.
    seedMission();
    expect((await observePlanWrite(payload({ tool_use_id: null }))).revision).toBe(2);
    expect((await observePlanWrite(payload({ tool_use_id: null }))).revision).toBe(3);

    const lines = planLines(repo);
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line.data.tool_use_id).toBeUndefined();
    expect(Math.max(...lines.map((l) => l.data.revision))).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// (c) the cheap common exit
// ---------------------------------------------------------------------------

describe('_plan-observe-record — everything that is not a mission plan', () => {
  it('stops at not-plan-path before any ledger or store file appears', async () => {
    seedMission();
    const before = readRunLedger(repo).length;
    const paths = [
      path.join(repo, 'src', 'x.js'),
      // A near-miss INSIDE the mission directory: the basename rule is what
      // separates the plan document from every other markdown file there.
      path.join(repo, '.artibot', 'missions', missionId, 'plan-v2.md'),
      path.join(repo, '.artibot', 'missions', missionId, 'intent.md'),
      path.join(repo, 'docs', 'plan.md'),
    ];
    expect(paths).toHaveLength(4);

    for (const filePath of paths) {
      const out = await observePlanWrite(payload({ filePath }));
      expect(out.ok, filePath).toBe(false);
      expect(out.reason, filePath).toBe('not-plan-path');
    }
    expect(planLines(repo)).toHaveLength(0);
    expect(readRunLedger(repo)).toHaveLength(before);
    expect(openStore(repo).getMission(missionId).plan.revision).toBe(FIRST_PLAN_REVISION);
  });

  it('creates no ledger at all for a non-plan write in a virgin repo', async () => {
    // The strongest form of the "nothing loads" claim available from outside the
    // process: with no seeding whatsoever, a non-plan write leaves no file
    // behind, so no ledger, store or lifecycle module reached its writer.
    const out = await observePlanWrite(payload({ filePath: path.join(repo, 'src', 'x.js') }));
    expect(out.reason).toBe('not-plan-path');
    expect(existsSync(ledgerFilePath(repo))).toBe(false);
  });

  it('returns not-write-tool for every other tool, before the path is read', async () => {
    for (const tool of ['Bash', 'Read', 'Agent', 'MultiEdit', 'NotebookEdit', undefined, 42]) {
      // Assigned AFTER the builder so `undefined` stays undefined: the builder's
      // own `?? 'Write'` default would otherwise turn that case into a plan write.
      const out = await observePlanWrite({ ...payload(), tool_name: tool });
      expect(out.ok, String(tool)).toBe(false);
      expect(out.reason, String(tool)).toBe('not-write-tool');
    }
    expect(existsSync(ledgerFilePath(repo))).toBe(false);
  });

  it('names the missing half when the payload cannot say where it is', async () => {
    seedMission();
    const noSession = payload();
    delete noSession.session_id;
    expect((await observePlanWrite(noSession)).reason).toBe('no-session');

    const noCwd = payload();
    delete noCwd.cwd;
    expect((await observePlanWrite(noCwd)).reason).toBe('no-cwd');

    expect(planLines(repo)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// (f) fail-closed
// ---------------------------------------------------------------------------

describe('_plan-observe-record — fail-closed on a missing store row', () => {
  it('records nothing for a mission the store never opened', async () => {
    const out = await observePlanWrite(payload());
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('no-mission-row');
    expect(out.missionId).toBe(missionId);
    expect(planLines(repo)).toHaveLength(0);
    expect(existsSync(planPath(repo, missionId))).toBe(false);
  });

  it('refuses when the row carries no intent revision to base the plan on', async () => {
    // A DEFENSIVE BRANCH, REACHED THROUGH THE PORT. An earlier revision of this
    // case tried to write the row through the real store and was VACUOUS:
    // `validate.js#validateMission:94-97` rejects a mission without an integer
    // `intent.revision`, so the commit never took and `observePlanWrite` was
    // never called — the test passed while measuring nothing.
    //
    // The branch is therefore unreachable in production through a validated
    // row, and this asserts the GUARD, not a reachable state. It is worth
    // asserting because `getMission` is a port: the guard is what keeps a
    // surprising row from becoming an invented `based_on` edge.
    seedMission();
    const store = openStore(repo);
    expect(store.updateMission(missionId, (current) => {
      const next = { ...current };
      delete next.intent;
      return next;
    }, { reason: 'test-fixture', expectedVersion: store.getState().state_version }).ok)
      .toBe(false);

    injected.storeOverride = (real) => ({
      ...real,
      getMission: (id) => {
        const row = real.getMission(id);
        if (row === null) return null;
        const next = { ...row };
        delete next.intent;
        return next;
      },
    });

    const out = await observePlanWrite(payload());
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('no-intent-revision');
    expect(out.missionId).toBe(missionId);
    // Refused BEFORE the append — the order that matters.
    expect(planLines(repo)).toHaveLength(0);
    expect(openStore(repo).getMission(missionId).plan.revision).toBe(FIRST_PLAN_REVISION);
  });

  it('reports ok:false when the store refuses the bump, keeping the ledger line', async () => {
    // WHY `ok` IS FALSE HERE. The next revision is computed from the ROW, and
    // the row wins over the ledger when they disagree (`artifact-lifecycle.js`
    // :264, "Live revisions: StateStore wins"). A row left at 1 by a failed
    // bump makes the NEXT plan.md write compute revision 2 again and append a
    // second line under the same idempotency key. Reporting that as a success
    // is what would hide it — which is what an earlier revision of the module
    // did, and what `intent-observe-pre.js#promote:361` already got right.
    seedMission();
    let attempts = 0;
    injected.storeOverride = (real) => ({
      ...real,
      updateMission: () => {
        attempts += 1;
        return { ok: false, conflict: true };
      },
    });

    const out = await observePlanWrite(payload());

    expect(out.ok).toBe(false);
    expect(out.reason).toBe('store-failed');
    expect(out.store).toBe('conflict');
    expect(out.revision).toBe(2);
    // ONE retry, not a loop — a hook that spins on a lock delays the user's edit.
    expect(attempts).toBe(2);
    // THE LEDGER LINE IS REAL AND IS KEPT, and so is its Shadow record: the
    // append genuinely happened, and dropping either would lose a measurement
    // that was legitimately taken.
    expect(out.ledger).toBe('appended');
    expect(out.artifact.status).toBe('write-disabled');
    expect(out.artifact.wouldWrite).toBe(1);

    const lines = planLines(repo);
    expect(lines).toHaveLength(1);
    expect(lines[0].data.revision).toBe(2);
    // The row did NOT move. This is the state `ok: false` exists to report.
    expect(openStore(repo).getMission(missionId).plan.revision).toBe(FIRST_PLAN_REVISION);
  });
});

// ---------------------------------------------------------------------------
// (d) (e) the kill switch
// ---------------------------------------------------------------------------

describe('_plan-observe-record — the artifact kill switch', () => {
  it('still records to ledger and store with the switch OFF, and writes no file', async () => {
    // The brief's invariant: `plan.revised` reaches the live ledger regardless
    // of the kill switch. Ledger and store writes are Observe-legal; artifact
    // FILES are not (design §7.3), so a closed gate suppresses the file only.
    setKillSwitch(false);
    seedMission();

    const out = await observePlanWrite(payload());
    expect(out.ok).toBe(true);
    expect(out.artifact.status).toBe('write-disabled');
    // `plan()` is pure and always runs, so the Shadow counts exist even here.
    expect(out.artifact.wouldWrite).toBe(1);
    expect(out.artifact.blocked).toBe(0);
    expect(out.artifact.refused).toBe(0);

    expect(planLines(repo)).toHaveLength(1);
    expect(openStore(repo).getMission(missionId).plan.revision).toBe(2);
    expect(existsSync(planPath(repo, missionId))).toBe(false);
  });

  it('writes a parseable plan.md with the switch ON, once', async () => {
    setKillSwitch(true);
    seedMission();

    const out = await observePlanWrite(payload());
    expect(out.ok).toBe(true);
    expect(out.artifact.status).toBe('written');

    const file = planPath(repo, missionId);
    expect(existsSync(file)).toBe(true);
    const parsed = parsePlanMd(readFileSync(file, 'utf-8'));
    expect(parsed.errors).toEqual([]);
    expect(parsed.ok).toBe(true);
    expect(parsed.plan.missionId).toBe(missionId);
    expect(parsed.plan.revision).toBe(2);
    expect(parsed.plan.basedOn.intentRevision).toBe(1);
    expect(parsed.plan.mode).toBe(DEFAULT_PLAN_MODE);
    expect(parsed.plan.actor).toEqual({ type: 'hook', id: 'plan-observe-record' });

    // A SECOND revision: the ledger still gets its line, and the file is never
    // clobbered — `apply` refuses with ALREADY_EXISTS.
    const before = readFileSync(file, 'utf-8');
    const second = await observePlanWrite(payload({ tool_use_id: 'toolu_plan_2' }));
    expect(second.ok).toBe(true);
    expect(second.revision).toBe(3);
    expect(second.artifact.status).toBe('skipped');
    expect(second.artifact.skipped).toEqual(['ALREADY_EXISTS']);
    expect(planLines(repo)).toHaveLength(2);
    expect(readFileSync(file, 'utf-8')).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// the store half in isolation
// ---------------------------------------------------------------------------

describe('planRevisionMutator', () => {
  it('raises plan.revision and preserves every other field', () => {
    seedMission();
    const store = openStore(repo);
    const before = store.getMission(missionId);
    const commit = store.updateMission(missionId, planRevisionMutator(missionId, 7), {
      reason: 'plan.revised', expectedVersion: store.getState().state_version,
    });
    expect(commit.ok).toBe(true);

    const after = openStore(repo).getMission(missionId);
    expect(after.plan).toEqual({ path: `missions/${missionId}/plan.md`, revision: 7 });
    expect(after.title).toBe(before.title);
    expect(after.status).toBe(before.status);
    expect(after.intent).toEqual(before.intent);
  });

  it('is a pure function of its arguments, mutating nothing', () => {
    const current = Object.freeze({
      title: 't', status: 'executing', intent: { path: 'i', revision: 3 },
      plan: { path: 'p', revision: 1 },
    });
    const next = planRevisionMutator('M-20260914-001', 4)(current);
    expect(next).not.toBe(current);
    expect(current.plan.revision).toBe(1);
    expect(next.plan.revision).toBe(4);
    expect(next.status).toBe('executing');
  });

  it('seeds a row that had none', () => {
    expect(planRevisionMutator('M-20260914-001', 2)(null))
      .toEqual({ plan: { path: 'missions/M-20260914-001/plan.md', revision: 2 } });
  });
});

// ---------------------------------------------------------------------------
// (g) the delegation, in the process the host launches
// ---------------------------------------------------------------------------

describe('_plan-observe-record — delegation from intent-observe-pre (child process)', () => {
  it('records the plan revision from the REAL hook, mute and exit 0', () => {
    seedMission();
    const r = runHook(JSON.stringify(payload()));
    expect(r.status).toBe(0);
    expect(r.stdoutBytes).toBe(0);

    // THE DELEGATION PROOF. Nothing in this assertion is reachable unless
    // `main()` actually called into the sibling module in the spawned process.
    const lines = planLines(repo);
    expect(lines).toHaveLength(1);
    expect(lines[0].data.revision).toBe(2);
    expect(lines[0].data.mode).toBe(DEFAULT_PLAN_MODE);
    expect(openStore(repo).getMission(missionId).plan.revision).toBe(2);
  });

  it('holds stdout and exit status byte-for-byte across payload shapes', () => {
    seedMission();
    const cases = [
      ['1 plan.md write', JSON.stringify(payload({ tool_use_id: 'toolu_mute_1' }))],
      ['2 non-plan write', JSON.stringify(payload({
        filePath: path.join(repo, 'src', 'x.js'), tool_use_id: 'toolu_mute_2',
      }))],
      ['3 malformed stdin', 'this is not json {{{'],
      ['4 no cwd', JSON.stringify({ ...payload(), cwd: undefined })],
    ];
    expect(cases).toHaveLength(4);

    const results = cases.map(([name, raw]) => [name, runHook(raw)]);
    for (const [name, r] of results) {
      expect(r.stdoutBytes, `${name}: stdout must be empty`).toBe(0);
      expect(r.status, `${name}: exit must be 0 (2 would cancel the tool call)`).toBe(0);
      expect(r.stdout.equals(results[0][1].stdout), `${name}: stdout bytes`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// The per-project gate — the completion criterion, on the real hook
// ---------------------------------------------------------------------------

describe('_plan-observe-record — the per-project gate (a/b/c matrix)', () => {
  /**
   * A sandbox of its own: repo, plugin root and config, independent of the
   * file-level fixture so both halves of the gate can be set per case.
   * `marker: 'dir'` puts a DIRECTORY at the marker path — the shape a resolver
   * that only called `existsSync` would wrongly read as open.
   */
  function sandbox(name, { enabled, marker }) {
    const base = path.join(tmp, 'gate', name);
    const boxHome = path.join(base, 'home');
    const boxRepo = path.join(base, 'repo');
    const boxRoot = path.join(base, 'plugin-root');
    mkdirSync(path.join(boxHome, '.claude'), { recursive: true });
    mkdirSync(boxRepo, { recursive: true });
    mkdirSync(boxRoot, { recursive: true });
    execFileSync('git', ['init'], { cwd: boxRepo, stdio: 'ignore', windowsHide: true });
    setKillSwitch(enabled, boxRoot);
    if (marker === 'file') seedProjectMarker(boxRepo);
    if (marker === 'dir') {
      mkdirSync(path.join(boxRepo, ...PROJECT_MARKER.split('/')), { recursive: true });
    }

    const id = sessionFallbackMissionId(SESSION_ID, new Date());
    expect(appendLedgerEvent(boxRepo, {
      event: 'mission.created',
      session_id: SESSION_ID,
      mission_id: id,
      source: 'hook',
      data: { title: MISSION_TITLE, intent_revision: 1 },
    }).ok).toBe(true);
    const store = createStateStore({
      projectRoot: boxRepo,
      sessionId: SESSION_ID,
      source: 'hook',
      appendEvent: (envelope) => appendLedgerEvent(boxRepo, envelope),
      resolveGitCommonDir: () => resolveGitCommonDir(boxRepo),
    });
    expect(store.updateMission(id, missionMutator(id, MISSION_TITLE, 1), {
      reason: 'mission.created', expectedVersion: store.getState().state_version,
    }).ok).toBe(true);

    return { home: boxHome, repo: boxRepo, root: boxRoot, missionId: id };
  }

  /** Spawn the REAL hook against that sandbox and report the criterion. */
  function measure(box) {
    const res = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({
        cwd: box.repo,
        hook_event_name: 'PreToolUse',
        session_id: SESSION_ID,
        tool_name: 'Write',
        tool_use_id: 'toolu_gate_1',
        tool_input: { file_path: planPath(box.repo, box.missionId), content: '# plan\n' },
      }),
      env: {
        ...process.env, HOME: box.home, USERPROFILE: box.home, CLAUDE_PLUGIN_ROOT: box.root,
      },
      windowsHide: true,
    });
    const stdout = res.stdout ?? Buffer.alloc(0);
    return {
      status: res.status,
      stdout,
      stdoutBytes: stdout.length,
      file: existsSync(planPath(box.repo, box.missionId)),
      revised: planLines(box.repo).length,
    };
  }

  it('suppresses the FILE and nothing else: a/b closed, c open', () => {
    // (a) global false + marker present — the shipped 4.61.0 configuration.
    // (b) global true  + marker absent  — the case the per-project gate exists
    //     for: the switch is on and an unmarked project still gets no file.
    // (c) global true  + marker present — the only combination that writes.
    const a = measure(sandbox('a', { enabled: false, marker: 'file' }));
    const b = measure(sandbox('b', { enabled: true, marker: 'none' }));
    const c = measure(sandbox('c', { enabled: true, marker: 'file' }));

    for (const [name, m] of [['a', a], ['b', b], ['c', c]]) {
      expect(m.status, `${name}: exit`).toBe(0);
      expect(m.stdoutBytes, `${name}: stdout length`).toBe(0);
      expect(m.stdout.equals(a.stdout), `${name}: stdout bytes`).toBe(true);
    }

    // The plan.revised line lands in ALL THREE — the gate suppresses the file
    // and nothing else (design §7.3).
    expect([a.revised, b.revised, c.revised]).toEqual([1, 1, 1]);

    expect([a.file, b.file, c.file]).toEqual([false, false, true]);
  });

  it('writes nothing when the marker path is a DIRECTORY named project.md', () => {
    const m = measure(sandbox('dir', { enabled: true, marker: 'dir' }));
    expect(m.status).toBe(0);
    expect(m.stdoutBytes).toBe(0);
    expect(m.revised).toBe(1);
    expect(m.file).toBe(false);
  });
});
