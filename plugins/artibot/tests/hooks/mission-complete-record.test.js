/**
 * `scripts/hooks/mission-complete-record.js` — the SessionEnd child that turns
 * "this session verified something" into a `mission.completed{accepted: null}`
 * declaration and, behind the kill switch, into `outcome.md`.
 *
 * REAL CHILD PROCESSES for every property of the hook. Those cases spawn the
 * hook exactly as the dispatcher does — a fresh `node`, JSON on stdin — because
 * the properties under test are process properties: stdout must stay EMPTY (the
 * SessionEnd dispatcher fans children out and a byte there is a decision
 * channel), the exit status must be 0 on every path, and an import-time throw
 * must be caught. None of that is observable from an in-process call. The one
 * exception is the `registeredEvidenceIds` helper's contract (the folded-line
 * and throwing-port cases), which is a function property and is called directly.
 *
 * THE CHILD IS SPAWNED DIRECTLY, NEVER `_sessionend-dispatcher.js`. That is the
 * `tests/firewall/dispatcher-cwd-sandbox-required.test.js` ratchet: a suite that
 * spawns a dispatcher joins its writer axis and turns it red.
 *
 * EVERY CASE RUNS IN A `mkdtemp` SANDBOX with its own `.git` directory, its own
 * plugin-root copy of `artibot.config.json`, and HOME/USERPROFILE redirected —
 * the shape `tests/hooks/plan-observe-record.test.js` established. Nothing here
 * may reach the worktree's `.artibot/` or `.git/artibot/ledger.jsonl`: a test
 * that appended a `mission.completed` line to the live ledger would corrupt the
 * very measurement this hook exists to produce. The last case hashes both
 * before and after the suite and asserts they did not move.
 *
 * WHAT THIS FILE DOES NOT PROVE (rules §9 — write it next to the gate):
 *   - THAT THE HOST FIRES SessionEnd, or that `hooks/dispatch-table.json` lists
 *     this child. The table entry is the window leader's commit;
 *     `tests/dispatcher/dispatch-table.test.js` is where its count is pinned.
 *   - THE LIVE BLOCK DISTRIBUTION. Every fixture here is hand-built. The live
 *     answer comes from `scripts/ledger/outcome-census.mjs` run against the
 *     parent ledger, and the brief's §1.1 measurement (all live
 *     `verify.completed` rows `unmeasured`) is NOT re-measured by this suite.
 *   - LATENCY AS A BOUND. The timing case PRINTS a p95 and asserts nothing
 *     about it: a tmpdir repo is not a live repo, and a bound derived from one
 *     is a flake generator rather than a measurement.
 *   - THAT A DECLARATION MEANS COMPLETION. `{accepted: null}` is a trigger;
 *     `lib/runtime/ledger.js#currentMission` reads it as an OPEN mission.
 *
 * @module tests/hooks/mission-complete-record
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync,
  rmSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { appendLedgerEvent, ledgerFilePath } from '../../lib/runtime/ledger.js';
import { sessionFallbackMissionId } from '../../lib/runtime/event-writer.js';
import { createStateStore } from '../../lib/project-state/state-manager.js';
import { resolveGitCommonDir } from '../../lib/project-state/git-common-dir.js';
import { missionMutator } from '../../lib/runtime/middleware/tasks.js';
import { buildVerifyCompletedEvents, recordVerification } from '../../lib/verification/verify-writer.js';
import {
  evidenceRegistryPath, lookupEvidenceIds, readEvidenceIds, registerEvidence,
} from '../../lib/verification/evidence-registry.js';
import { checkArtifactHealth, CheckStatus } from '../../lib/project-state/doctor-checks.js';
import { BlockCode } from '../../lib/runtime/artifact-lifecycle-gates.js';
import { DEFAULT_PLAN_MODE, FIRST_PLAN_REVISION, serializePlanMd } from '../../lib/planning/plan-artifact.js';
import { FIRST_REVIEW_REVISION, serializeReviewMd } from '../../lib/review/review-artifact.js';
import { OUTCOME_SECTIONS, parseOutcomeMd } from '../../lib/mission/outcome-artifact.js';
import { evidenceRegistryPort, redactAsStored } from '../../scripts/ledger/record-verify.mjs';
import {
  DECLARATION_STATUSES, HOOK_BLOCK_CODES, registeredEvidenceIds, WriteStatus,
} from '../../scripts/hooks/mission-complete-record.js';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK = path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'mission-complete-record.js');
const REPO_ROOT = path.resolve(PLUGIN_ROOT, '..', '..');

const SESSION_ID = 'sess-outcome-1abcdefg';
const MISSION_TITLE = 'Declare completion at SessionEnd';
const VERIFICATION_ID = 'v1-83866286c2d8-42';

let tmp;
let home;
let repo;
let pluginRoot;
let missionId;

/** Parsed ledger lines of the SANDBOX repo, `[]` when the file never appeared. */
function readRunLedger(root) {
  const file = ledgerFilePath(root);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/** Just the declaration lines. */
function completedLines(root = repo) {
  return readRunLedger(root).filter((l) => l.event === 'mission.completed');
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
 * — a row whose mission has no `mission.created` event is an orphan.
 */
function seedMission(id = missionId, { withRow = true } = {}) {
  expect(appendLedgerEvent(repo, {
    event: 'mission.created',
    session_id: SESSION_ID,
    mission_id: id,
    source: 'hook',
    data: { title: MISSION_TITLE, intent_revision: 1 },
  }).ok).toBe(true);
  if (!withRow) return;
  const store = openStore(repo);
  expect(store.updateMission(id, missionMutator(id, MISSION_TITLE, 1), {
    reason: 'mission.created', expectedVersion: store.getState().state_version,
  }).ok).toBe(true);
  // `missionMutator` already seeds `plan` at revision 1 (`tasks.js:467`), which
  // is the revision `plan.md` below declares. A second `updateMission` to raise
  // it to the same value is refused as a no-op, so there is nothing to bump.
}

/**
 * Append the four `verify.completed` rows a verdict produces, THROUGH THE REAL
 * WRITER. Hand-rolled envelopes would drift from the bytes production writes —
 * the overall line carries no `layer` key at all, which is exactly the fact the
 * UNMEASURED gate's per-layer rule turns on.
 */
function seedVerify(id = missionId, status = 'UNMEASURED') {
  const built = buildVerifyCompletedEvents({
    verification_id: VERIFICATION_ID,
    status,
    evidence: [],
    layers: ['deterministic', 'behavioral', 'operational'].map((layer) => ({
      layer, status, evidence: [],
    })),
  }, { sessionId: SESSION_ID, missionId: id });
  expect(built.ok).toBe(true);
  expect(built.inputs).toHaveLength(4);
  for (const input of built.inputs) expect(appendLedgerEvent(repo, input).ok).toBe(true);
}

/** A `review.completed` row plus the `review.md` the gate expects beside it. */
function seedReview(id = missionId, verdict = 'PASS') {
  expect(appendLedgerEvent(repo, {
    event: 'review.completed',
    session_id: SESSION_ID,
    mission_id: id,
    // `reviewer`, not `hook`: the allowlist registers exactly one source for
    // this event, and a mis-sourced line is REJECTED rather than appended.
    source: 'reviewer',
    // `model` is a REQUIRED envelope field for a `reviewer` line
    // (`missing-required-envelope:model`, measured 2026-09-15): a verdict with
    // no model attached cannot be attributed to the judge that produced it.
    model: 'fixture-model',
    idempotency_key: `review.completed:${id}:1`,
    data: { verdict, findings_ref: `transcript:${SESSION_ID}`, verification_id: VERIFICATION_ID },
  }).ok).toBe(true);
}

/** Write `plan.md` and `review.md` with matching `based_on` edges. */
function seedArtifacts(id = missionId, { planText, reviewText } = {}) {
  const dir = path.join(repo, '.artibot', 'missions', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'plan.md'), planText ?? serializePlanMd({
    missionId: id,
    revision: FIRST_PLAN_REVISION,
    basedOn: { intentRevision: 1 },
    mode: DEFAULT_PLAN_MODE,
    actor: { type: 'hook', id: 'fixture' },
    ts: new Date().toISOString(),
  }), 'utf-8');
  writeFileSync(path.join(dir, 'review.md'), reviewText ?? serializeReviewMd({
    missionId: id,
    verdict: 'PASS',
    findingsRef: `transcript:${SESSION_ID}`,
    verificationId: VERIFICATION_ID,
    revision: FIRST_REVIEW_REVISION,
    basedOn: { intentRevision: 1, planRevision: FIRST_PLAN_REVISION },
    reviewerId: 'fixture',
    model: 'fixture-model',
    ts: new Date().toISOString(),
  }), 'utf-8');
}

/**
 * The per-project opt-in marker, relative to the project root. Written into the
 * sandbox config EXPLICITLY rather than inherited from the live file, so these
 * cases keep meaning the same thing on the day the shipped default is renamed.
 *
 * A DEDICATED FILE WITH NO OTHER MEANING. An earlier draft used
 * `.artibot/project.md`, which is the v5 project declaration DOCUMENT —
 * reusing it would have conflated "uses Artibot project-state" with "opted in
 * to mission artifacts", and a future scaffolder of that document would have
 * quietly made the gate global again.
 */
const PROJECT_MARKER = '.artibot/artifact-lifecycle.optin';

/**
 * Give the sandbox repo the marker that opts it into artifact writes.
 *
 * The SECOND half of the artifact gate (B4). Without it the global kill switch
 * is not enough, which is the whole point: turning the switch on must not start
 * seeding `.artibot/missions/` in every repository a session ends in.
 *
 * @param {string} [root] project root to opt in
 */
function seedProjectMarker(root = repo) {
  const file = path.join(root, ...PROJECT_MARKER.split('/'));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, '# project\n', 'utf-8');
}

/** Point `getPluginRoot()` at a sandbox config with the knobs this hook reads. */
function writeSandboxConfig({ enabled = false, requiredLayers } = {}) {
  const live = JSON.parse(readFileSync(path.join(PLUGIN_ROOT, 'artibot.config.json'), 'utf-8'));
  live.runtime.artifactLifecycle.enabled = enabled;
  // Explicit, always: the resolver reads the marker NAME from config, and a
  // sandbox that inherited it silently would stop testing the gate the day the
  // live default moves.
  live.runtime.artifactLifecycle.projectMarker = PROJECT_MARKER;
  if (requiredLayers !== undefined) {
    live.review = live.review ?? {};
    live.review.verify = { ...(live.review.verify ?? {}), requiredLayers };
  }
  writeFileSync(
    path.join(pluginRoot, 'artibot.config.json'), JSON.stringify(live, null, 2), 'utf-8',
  );
}

/** Run the REAL hook exactly as the dispatcher does: fresh process, JSON on stdin. */
function runHook(raw) {
  const res = spawnSync(process.execPath, [HOOK], {
    input: raw,
    cwd: tmp,
    env: {
      ...process.env, HOME: home, USERPROFILE: home, CLAUDE_PLUGIN_ROOT: pluginRoot,
    },
    encoding: 'utf-8',
    windowsHide: true,
  });
  return {
    status: res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    lines: (res.stderr ?? '').split('\n').filter(Boolean),
  };
}

/** The payload the SessionEnd dispatcher hands its children. */
function payload(over = {}) {
  return JSON.stringify({
    cwd: repo,
    hook_event_name: 'SessionEnd',
    session_id: SESSION_ID,
    ...over,
  });
}

/** Parse one stderr line into its four fixed fields. */
function fields(line) {
  const m = /^\[artibot:mission-complete-record] mission=(\S+) declared=(\S+) block=(\S+) write=(\S+)$/
    .exec(line);
  expect(m, `stderr line did not match the fixed vocabulary: ${line}`).not.toBeNull();
  return {
    mission: m[1], declared: m[2], block: m[3], write: m[4],
  };
}

/** sha256 of a file, or `'absent'`. Used for the real-store isolation proof. */
function digest(file) {
  if (!existsSync(file)) return 'absent';
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

const LIVE_LEDGER = path.join(REPO_ROOT, '.git', 'artibot', 'ledger.jsonl');
const LIVE_MISSIONS = path.join(PLUGIN_ROOT, '.artibot', 'missions');
let liveLedgerBefore;
let liveMissionsBefore;

beforeAll(() => {
  liveLedgerBefore = digest(LIVE_LEDGER);
  liveMissionsBefore = existsSync(LIVE_MISSIONS);
});

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'artibot-outcome-hook-')));
  home = path.join(tmp, 'home');
  repo = path.join(tmp, 'repo');
  pluginRoot = path.join(tmp, 'plugin-root');
  mkdirSync(path.join(home, '.claude'), { recursive: true });
  mkdirSync(repo, { recursive: true });
  mkdirSync(pluginRoot, { recursive: true });
  // A REAL `.git` DIRECTORY. After ADR-011 the ledger sits inside the git common
  // dir, so a sandbox without one would resolve to an ancestor — which is how a
  // test writes into a real store.
  execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore', windowsHide: true });
  missionId = sessionFallbackMissionId(SESSION_ID, new Date());
  // SHIPPED VALUE BY DEFAULT. Cases that measure the writer open it explicitly,
  // so a green run is never mistaken for a file the shipped config would produce.
  writeSandboxConfig({ enabled: false });
  // The PROJECT half of the gate is opted in by default, so every case here
  // measures the half it names. The cases that mean "this project never opted
  // in" remove it explicitly.
  seedProjectMarker();
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('declaration — the derived `mission.completed{accepted: null}` line', () => {
  it('appends exactly one declaration and reports ARTIFACT_ABSENT with the switch closed', () => {
    seedMission();
    seedVerify();

    const res = runHook(payload());

    expect(res.status).toBe(0);
    expect(res.stdout).toBe('');
    const rows = completedLines();
    expect(rows).toHaveLength(1);
    expect(rows[0].data.accepted).toBeNull();
    expect(rows[0].data.verification_id).toBe(VERIFICATION_ID);
    expect(rows[0].source).toBe('hook');
    expect(rows[0].idempotency_key).toBe(`mission.completed:${missionId}:null`);
    // Decision 7 (a): pointer strings, never a registry id.
    expect(rows[0].data.evidence_refs).toEqual([
      `ledger:verify.completed:${SESSION_ID}:${VERIFICATION_ID}:operational`,
      `transcript:${SESSION_ID}`,
    ]);

    const f = fields(res.lines[0]);
    expect(f).toMatchObject({
      mission: missionId, declared: 'new', block: 'ARTIFACT_ABSENT', write: WriteStatus.BLOCKED,
    });
    expect(existsSync(path.join(repo, '.artibot', 'missions', missionId, 'outcome.md'))).toBe(false);
  });

  it('reaches the UNMEASURED gate once plan.md and review.md parse', () => {
    seedMission();
    seedVerify();
    seedReview();
    seedArtifacts();

    const res = runHook(payload());

    expect(res.status).toBe(0);
    expect(fields(res.lines[0]).block).toBe(BlockCode.UNMEASURED_VERIFICATION);
    expect(completedLines()).toHaveLength(1);
  });

  it('separates a MISSING artifact from an UNPARSEABLE one', () => {
    seedMission();
    seedVerify();
    seedArtifacts(missionId, { planText: 'not frontmatter at all\n' });

    expect(fields(runHook(payload()).lines[0]).block).toBe('ARTIFACT_UNPARSEABLE');
  });

  it('reports STATE_ROW_ABSENT when the StateStore has no row', () => {
    seedMission(missionId, { withRow: false });
    seedVerify();
    seedArtifacts();

    const f = fields(runHook(payload()).lines[0]);
    expect(f.block).toBe('STATE_ROW_ABSENT');
    // The declaration is still appended: the gate distribution needs the
    // denominator even for a mission whose row is gone.
    expect(f.declared).toBe('new');
    expect(completedLines()).toHaveLength(1);
  });

  it('declares only the mission that carries a verify.completed row', () => {
    // An ISSUED id, not a second `sessionFallbackMissionId`: that helper keys
    // on the session id's FIRST 8 CHARACTERS, so two ids sharing a prefix
    // (`sess-out…`) collapse to ONE mission and this case would pass vacuously.
    const other = 'M-20260915-777';
    seedMission();
    seedVerify();
    seedMission(other);
    // `other` gets a ledger row in this session but no verification.
    expect(appendLedgerEvent(repo, {
      event: 'human.asked',
      session_id: SESSION_ID,
      mission_id: other,
      source: 'hook',
      data: { question_id: 'q-1' },
    }).ok).toBe(true);

    const res = runHook(payload());

    expect(completedLines()).toHaveLength(1);
    expect(completedLines()[0].mission_id).toBe(missionId);
    expect(res.lines).toHaveLength(1);
  });
});

describe('the write path, with the kill switch open', () => {
  /** The fixture every gate passes: deterministic PASS, review PASS, no questions. */
  function seedPassing() {
    seedMission();
    seedVerify(missionId, 'PASS');
    seedReview();
    seedArtifacts();
    writeSandboxConfig({ enabled: true, requiredLayers: ['deterministic'] });
  }

  it('writes a 7-section outcome.md its own parser accepts with zero findings', () => {
    seedPassing();

    const res = runHook(payload());

    expect(res.status).toBe(0);
    expect(res.stdout).toBe('');
    const f = fields(res.lines[0]);
    expect(f).toMatchObject({ declared: 'new', block: 'none', write: WriteStatus.WRITTEN });

    const file = path.join(repo, '.artibot', 'missions', missionId, 'outcome.md');
    expect(existsSync(file)).toBe(true);
    const parsed = parseOutcomeMd(readFileSync(file, 'utf-8'));
    expect(parsed.errors).toEqual([]);
    expect(parsed.ok).toBe(true);
    expect(parsed.findings).toEqual([]);
    expect(parsed.outcome.accepted).toBeNull();
    expect(parsed.outcome.supersedes).toBeUndefined();
    expect(parsed.outcome.verificationId).toBe(VERIFICATION_ID);
    expect(parsed.outcome.actor).toEqual({ type: 'hook', id: 'mission-complete-record' });
    for (const { heading } of OUTCOME_SECTIONS) {
      expect(readFileSync(file, 'utf-8')).toContain(`## ${heading}`);
    }
  });

  it('is idempotent on a re-fire: one declaration, one file, already-exists', () => {
    seedPassing();
    expect(fields(runHook(payload()).lines[0]).write).toBe(WriteStatus.WRITTEN);
    const file = path.join(repo, '.artibot', 'missions', missionId, 'outcome.md');
    const first = readFileSync(file, 'utf-8');

    const res = runHook(payload());

    expect(res.status).toBe(0);
    const f = fields(res.lines[0]);
    expect(f.declared).toBe('existing');
    expect(f.write).toBe(WriteStatus.ALREADY_EXISTS);
    expect(completedLines()).toHaveLength(1);
    // Never clobbered: the bytes on disk are the first render's.
    expect(readFileSync(file, 'utf-8')).toBe(first);
  });

  it('writes nothing when the switch is closed, and says so', () => {
    seedPassing();
    writeSandboxConfig({ enabled: false, requiredLayers: ['deterministic'] });

    const f = fields(runHook(payload()).lines[0]);

    expect(f.block).toBe('none');
    expect(f.write).toBe(WriteStatus.WRITE_DISABLED);
    expect(existsSync(path.join(repo, '.artibot', 'missions', missionId, 'outcome.md'))).toBe(false);
  });
});

/**
 * B4 — the artifact gate's COMPLETION CRITERION, as a matrix.
 *
 * The gate is a conjunction of two independent conditions, so one open switch
 * and one present marker are not interchangeable evidence. Three runs of the
 * REAL hook against three configurations, compared to each other rather than to
 * a remembered expectation:
 *
 *   (a) global false + marker present   -> no file
 *   (b) global true  + marker absent    -> no file        <- the B4 behaviour
 *   (c) global true  + marker present   -> outcome.md
 *
 * WHAT IS ASSERTED ACROSS ALL THREE, not just in (c): the exit status, the
 * stdout BYTES (length included — a truncation that happened to share a prefix
 * would pass a string compare on some shells), and the presence of the
 * `mission.completed` ledger line. The gate suppresses a FILE and nothing else;
 * a gate that also swallowed the declaration would be a measurement hole, and
 * (b) is exactly where such a hole would open.
 *
 * WHAT THIS DOES NOT PROVE (rules §9): that the LIVE configuration opts any
 * real project in. Every root here is a sandbox, and the shipped global value
 * is pinned separately by the suite above.
 */
describe('B4 artifact gate — the completion criterion matrix', () => {
  /** Everything the write path needs except the gate itself. */
  function seedPassing() {
    seedMission();
    seedVerify(missionId, 'PASS');
    seedReview();
    seedArtifacts();
  }

  /** @returns {string} the path `outcome.md` would take */
  const outcomeFile = () => path.join(repo, '.artibot', 'missions', missionId, 'outcome.md');

  /** Remove the opt-in marker `beforeEach` seeded. @returns {void} */
  function removeProjectMarker() {
    rmSync(path.join(repo, ...PROJECT_MARKER.split('/')), { force: true });
  }

  /**
   * Run one cell of the matrix.
   *
   * @param {{enabled: boolean, marker: boolean}} cell the gate's two halves
   * @returns {{res: object, wrote: boolean, declared: boolean}} what came out
   */
  function runCell({ enabled, marker }) {
    seedPassing();
    writeSandboxConfig({ enabled, requiredLayers: ['deterministic'] });
    if (!marker) removeProjectMarker();

    const res = runHook(payload());
    return {
      res,
      wrote: existsSync(outcomeFile()),
      declared: completedLines().length === 1,
    };
  }

  it('writes outcome.md ONLY when the switch is open AND the project opted in', () => {
    const a = runCell({ enabled: false, marker: true });
    expect(a.wrote).toBe(false);

    // A fresh repo per cell: the previous cell's ledger and store row would
    // change what `declared` means on the next run.
    rmSync(repo, { recursive: true, force: true });
    mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore', windowsHide: true });
    seedProjectMarker();
    const b = runCell({ enabled: true, marker: false });
    expect(b.wrote).toBe(false);

    rmSync(repo, { recursive: true, force: true });
    mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore', windowsHide: true });
    seedProjectMarker();
    const c = runCell({ enabled: true, marker: true });
    expect(c.wrote).toBe(true);

    for (const cell of [a, b, c]) {
      expect(cell.res.status).toBe(0);
      // The declaration is the gate's blind spot by design: it happens whether
      // or not a file does.
      expect(cell.declared).toBe(true);
    }

    // stdout is BYTES, compared as Buffers, length first.
    const bytes = [a, b, c].map((cell) => Buffer.from(cell.res.stdout, 'utf-8'));
    expect(bytes[1].length).toBe(bytes[0].length);
    expect(bytes[2].length).toBe(bytes[0].length);
    expect(bytes[1].equals(bytes[0])).toBe(true);
    expect(bytes[2].equals(bytes[0])).toBe(true);

    // ...and both refusals name the SAME status. `global-off` and `project-off`
    // are one word to this hook on purpose — a second string would be a new
    // decision channel on a path contracted to decide nothing.
    expect(fields(a.res.lines[0]).write).toBe(WriteStatus.WRITE_DISABLED);
    expect(fields(b.res.lines[0]).write).toBe(WriteStatus.WRITE_DISABLED);
    expect(fields(c.res.lines[0]).write).toBe(WriteStatus.WRITTEN);
  });

  it('treats a DIRECTORY at the marker path as no marker at all', () => {
    seedPassing();
    writeSandboxConfig({ enabled: true, requiredLayers: ['deterministic'] });
    // A regular file is required, not merely an existing path: `.artibot` is a
    // directory people create for other reasons, and `existsSync` alone would
    // opt a project in for having one.
    removeProjectMarker();
    mkdirSync(path.join(repo, ...PROJECT_MARKER.split('/')), { recursive: true });

    const res = runHook(payload());

    expect(res.status).toBe(0);
    expect(existsSync(outcomeFile())).toBe(false);
    expect(fields(res.lines[0]).write).toBe(WriteStatus.WRITE_DISABLED);
  });
});

/**
 * SH-15b — outcome.md `evidence_refs` are §23 registry ids, resolved READ-ONLY
 * by content hash from the cited verification's `verify.completed` rows.
 *
 * Evidence is registered here through the PRODUCTION port
 * (`scripts/ledger/record-verify.mjs#evidenceRegistryPort`, redacted as the
 * ledger stores it) into the sandbox repo's own `.git/artibot/evidence.jsonl`.
 * The `afterAll` isolation proof covers the live ledger; the live registry sits
 * beside it and no case here resolves a root outside `tmp`.
 *
 * WHAT THIS DOES NOT PROVE: that live verifications carry evidence at all. As
 * of 2026-09-23 no declared mission's verify rows did (the doctor.md figure).
 */
describe('evidence_refs — registry ids by content hash (SH-15b)', () => {
  const EVIDENCE = [{ kind: 'command', command: 'npx vitest run tests/hooks', output: '12 passed' }];
  const OTHER = [{ kind: 'file', file: 'lib/other.js', line: 7 }];
  const outcomeFile = () => path.join(repo, '.artibot', 'missions', missionId, 'outcome.md');
  const registryOpts = () => ({ resolveGitCommonDir: () => resolveGitCommonDir(repo) });

  /**
   * A PASS verdict whose evidence rides ONLY the deterministic-layer line, so
   * the last `verify.completed` row is `:operational` with `evidence: []`.
   */
  function seedVerifyWithEvidence(id, {
    evidence = EVIDENCE, register = true, verificationId = VERIFICATION_ID,
  } = {}) {
    const res = recordVerification({
      verification_id: verificationId,
      status: 'PASS',
      evidence: [],
      layers: [
        { layer: 'deterministic', status: 'PASS', evidence },
        { layer: 'behavioral', status: 'PASS', evidence: [] },
        { layer: 'operational', status: 'PASS', evidence: [] },
      ],
    }, { sessionId: SESSION_ID, missionId: id }, {
      append: (input) => appendLedgerEvent(repo, input),
      ...(register ? { registerEvidence: evidenceRegistryPort(repo) } : {}),
    });
    expect(res.appended).toBe(4);
    return res;
  }

  function seedGatesOpen() {
    seedReview();
    seedArtifacts();
    writeSandboxConfig({ enabled: true, requiredLayers: ['deterministic'] });
  }

  /** Run the hook and return the parsed outcome.md plus its raw text. */
  function runAndParse() {
    const res = runHook(payload());
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('');
    expect(fields(res.lines[0]).write).toBe(WriteStatus.WRITTEN);
    const text = readFileSync(outcomeFile(), 'utf-8');
    const parsed = parseOutcomeMd(text);
    expect(parsed.ok).toBe(true);
    expect(parsed.findings).toEqual([]);
    return { res, text, parsed };
  }

  it('(i) cites the registered E-id and keeps the ledger/transcript pointers in the body', () => {
    seedMission();
    const reg = seedVerifyWithEvidence(missionId);
    expect(reg.evidence.ids).toEqual(['E-001']);
    seedGatesOpen();

    const { text, parsed } = runAndParse();

    expect(parsed.outcome.evidenceRefs).toEqual(['E-001']);
    const pointers = [
      `ledger:verify.completed:${SESSION_ID}:${VERIFICATION_ID}:operational`,
      `ledger:review.completed:${missionId}:1`,
      `transcript:${SESSION_ID}`,
    ];
    for (const pointer of pointers) expect(text).toContain(`- evidence: ${pointer}`);
    // The declaration line keeps its pointers: frontmatter changed, not the ledger.
    expect(completedLines()[0].data.evidence_refs).toEqual(pointers);
  });

  it('(ii) cites [] when the evidence was never registered, and the file still parses clean', () => {
    seedMission();
    seedVerifyWithEvidence(missionId, { register: false });
    seedGatesOpen();
    expect(existsSync(evidenceRegistryPath(repo, registryOpts()))).toBe(false);

    const { parsed } = runAndParse();

    expect(parsed.outcome.evidenceRefs).toEqual([]);
  });

  it('(iii) resolves by HASH: a row first registered from another line still answers', () => {
    seedMission();
    const earlier = 'verify.completed:sess-earlier:v-earlier:deterministic';
    expect(registerEvidence(redactAsStored(EVIDENCE), {
      projectRoot: repo, source: earlier, ...registryOpts(),
    }).ids).toEqual(['E-001']);
    seedVerifyWithEvidence(missionId, { register: false });
    seedGatesOpen();

    const { parsed } = runAndParse();

    expect(parsed.outcome.evidenceRefs).toEqual(['E-001']);
    // The only row names a source no line of this mission carries.
    const rows = readFileSync(evidenceRegistryPath(repo, registryOpts()), 'utf-8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(rows.map((r) => r.source)).toEqual([earlier]);
  });

  it('(iv) cites only the cited verification, not another one of the same mission', () => {
    seedMission();
    const other = seedVerifyWithEvidence(missionId, { evidence: OTHER, verificationId: 'v1-0ther0000000-7' });
    expect(other.evidence.ids).toEqual(['E-001']);
    const cited = seedVerifyWithEvidence(missionId);
    expect(cited.evidence.ids).toEqual(['E-002']);
    seedGatesOpen();

    const { parsed } = runAndParse();

    expect(parsed.outcome.verificationId).toBe(VERIFICATION_ID);
    expect(parsed.outcome.evidenceRefs).toEqual(['E-002']);
  });

  it('(v) cites [] when the registry cannot be read, and the hook still exits 0 silently', () => {
    seedMission();
    seedVerifyWithEvidence(missionId, { register: false });
    mkdirSync(evidenceRegistryPath(repo, registryOpts()), { recursive: true });
    seedGatesOpen();

    const { parsed } = runAndParse();

    expect(parsed.outcome.evidenceRefs).toEqual([]);
  });

  it('(vi) reads EVERY row of the verification, not the last one (the lastOf trap)', () => {
    seedMission();
    seedVerifyWithEvidence(missionId);
    seedGatesOpen();
    // Precondition: the last verify row is the operational line, carrying no
    // evidence. A helper that read only that row would cite nothing.
    const verifies = readRunLedger(repo).filter((l) => l.event === 'verify.completed');
    expect(verifies.at(-1).data.layer).toBe('operational');
    expect(verifies.at(-1).data.evidence).toEqual([]);

    expect(runAndParse().parsed.outcome.evidenceRefs).toEqual(['E-001']);
  });

  it('(vii) end to end: item 9 passes on the written outcome, and fails once the row is gone', () => {
    seedMission();
    seedVerifyWithEvidence(missionId);
    seedGatesOpen();
    const refs = runAndParse().parsed.outcome.evidenceRefs;
    expect(refs).toEqual(['E-001']);
    const item9 = (evidenceIds) => checkArtifactHealth({
      missionDirs: [{ mission_id: missionId, files: { outcome: { evidence_refs: refs } } }],
      evidenceIds,
    }).items.missing_evidence_reference;

    expect(item9(readEvidenceIds(repo, registryOpts()))).toMatchObject({
      status: CheckStatus.PASS, findings: [],
    });

    // Positive control: the same outcome against a registry without that row.
    writeFileSync(evidenceRegistryPath(repo, registryOpts()), '', 'utf-8');
    const failed = item9(readEvidenceIds(repo, registryOpts()));
    expect(failed.status).toBe(CheckStatus.FAIL);
    expect(failed.findings.map((f) => f.ref)).toEqual(['E-001']);
  });

  it('(viii) a FOLDED verify line keeps its evidence but loses verification_id: omitted, not mis-cited', () => {
    // `event-writer.js#foldOversized` keeps the event's required data keys
    // (`result`, `evidence`) and drops `layer` and `verification_id`.
    const longId = `v1-folded-${'segment-'.repeat(30)}`;
    const line = (output) => ({
      event: 'verify.completed', session_id: SESSION_ID, mission_id: missionId, source: 'gate',
      idempotency_key: `verify.completed:${SESSION_ID}:${longId}:deterministic`,
      data: {
        layer: 'deterministic', result: 'pass',
        evidence: [{ kind: 'command', command: 'npx vitest run', output }], verification_id: longId,
      },
    });
    // Size the output against a scratch root so the real line lands just over the cap.
    const probe = path.join(tmp, 'probe');
    mkdirSync(probe, { recursive: true });
    execFileSync('git', ['init'], { cwd: probe, stdio: 'ignore', windowsHide: true });
    const small = appendLedgerEvent(probe, line('ok. '));
    expect(small.folded).toBe(false);
    const folded = appendLedgerEvent(repo, line('ok. '.repeat(Math.ceil((4096 - small.bytes + 24) / 4) + 1)));
    expect(folded.ok).toBe(true);
    expect(folded.folded).toBe(true);
    expect(folded.dropped).toEqual(['layer', 'verification_id']);
    seedVerifyWithEvidence(missionId, { evidence: [] });

    const history = readRunLedger(repo).filter((l) => l.mission_id === missionId);
    const stored = history.find((l) => Array.isArray(l.data?.evidence_refs));
    expect(stored.data.verification_id).toBeUndefined();
    // Registered exactly as a production port would have after the append.
    expect(registerEvidence(stored.data.evidence, {
      projectRoot: repo, source: 'folded', ...registryOpts(),
    }).ids).toEqual(['E-001']);
    const d = { lookupEvidenceIds, resolveGitCommonDir };
    expect(lookupEvidenceIds(repo, stored.data.evidence, registryOpts())).toEqual(['E-001']);

    expect(registeredEvidenceIds(d, repo, history, VERIFICATION_ID)).toEqual([]);
    expect(registeredEvidenceIds(d, repo, history, longId)).toEqual([]);
  });

  it('turns a throwing or malformed lookup, or no verification id, into []', () => {
    const history = [{ event: 'verify.completed', data: { verification_id: 'v', evidence: EVIDENCE } }];
    const throwing = { lookupEvidenceIds: () => { throw new Error('boom'); }, resolveGitCommonDir };
    expect(registeredEvidenceIds(throwing, repo, history, 'v')).toEqual([]);
    expect(registeredEvidenceIds({ lookupEvidenceIds: () => null }, repo, history, 'v')).toEqual([]);
    expect(registeredEvidenceIds({}, repo, history, 'v')).toEqual([]);
    expect(registeredEvidenceIds({ lookupEvidenceIds }, repo, history, null)).toEqual([]);
    expect(registeredEvidenceIds({ lookupEvidenceIds }, repo, null, 'v')).toEqual([]);
  });
});

describe('safety — the properties that only a real process can show', () => {
  it.each([
    ['no cwd', payload({ cwd: undefined })],
    ['no session_id', payload({ session_id: undefined })],
    ['empty stdin', ''],
    ['malformed JSON', '{not json'],
    ['a bare array', '[]'],
  ])('does nothing for %s: 0 rows, 0 files, empty stdout, exit 0', (_label, raw) => {
    seedMission();
    seedVerify();

    const res = runHook(raw);

    expect(res.status).toBe(0);
    expect(res.stdout).toBe('');
    expect(completedLines()).toHaveLength(0);
    expect(existsSync(path.join(repo, '.artibot', 'missions'))).toBe(false);
  });

  it('runs nothing on import — the direct-run guard holds', () => {
    seedMission();
    seedVerify();
    const probe = path.join(tmp, 'probe.mjs');
    writeFileSync(
      probe,
      `import ${JSON.stringify(`file:///${HOOK.replace(/\\/g, '/')}`)};\n`
      + 'process.stdout.write("imported");\n',
      'utf-8',
    );

    const res = spawnSync(process.execPath, [probe], {
      cwd: tmp,
      env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_PLUGIN_ROOT: pluginRoot },
      encoding: 'utf-8',
      windowsHide: true,
    });

    expect(res.status).toBe(0);
    expect(res.stdout).toBe('imported');
    expect(completedLines()).toHaveLength(0);
  });

  it('emits only codes from the closed vocabulary across every seeded shape', () => {
    const allowed = new Set([...HOOK_BLOCK_CODES, ...Object.values(BlockCode), 'none']);
    const writes = new Set(Object.values(WriteStatus));
    const seen = [];

    for (const seed of [
      () => { seedMission(); seedVerify(); },
      () => { seedMission(missionId, { withRow: false }); seedVerify(); },
      () => {
        seedMission();
        seedVerify(); seedReview(); seedArtifacts();
      },
      () => {
        seedMission();
        seedVerify(missionId, 'PASS'); seedReview(); seedArtifacts();
        writeSandboxConfig({ enabled: true, requiredLayers: ['deterministic'] });
      },
      () => {
        seedMission();
        // `REPAIR_REQUIRED`, not `FAIL`: the allowlist enum `review_verdict` is
        // [PASS, REPAIR_REQUIRED, REPLAN_REQUIRED, INTENT_REVIEW_REQUIRED, BLOCK]
        // and a `FAIL` line is rejected rather than appended, so this shape
        // would have exercised nothing.
        seedVerify(missionId, 'PASS'); seedReview(missionId, 'REPAIR_REQUIRED');
        seedArtifacts();
        writeSandboxConfig({ enabled: true, requiredLayers: ['deterministic'] });
      },
    ]) {
      rmSync(repo, { recursive: true, force: true });
      mkdirSync(repo, { recursive: true });
      execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore', windowsHide: true });
      writeSandboxConfig({ enabled: false });
      seed();
      for (const line of runHook(payload()).lines) {
        const f = fields(line);
        expect(allowed, `unknown block code: ${f.block}`).toContain(f.block);
        expect(writes, `unknown write status: ${f.write}`).toContain(f.write);
        seen.push(f.block);
      }
    }

    // The sweep has to actually exercise more than one code, or a green run
    // would only prove the regex matched one line.
    expect(new Set(seen).size).toBeGreaterThanOrEqual(3);
  });

  it('prints spawn timings — reported, never asserted', () => {
    seedMission();
    const empty = [];
    for (let i = 0; i < 5; i += 1) {
      const t0 = performance.now();
      runHook(payload());
      empty.push(performance.now() - t0);
    }
    // A 1,000-row ledger, built once, so the read is the cost being observed.
    seedVerify();
    for (let i = 0; i < 1000; i += 1) {
      appendLedgerEvent(repo, {
        event: 'human.asked',
        session_id: `sess-filler-${i}`,
        mission_id: missionId,
        source: 'hook',
        data: { question_id: `q-${i}` },
      });
    }
    const loaded = [];
    for (let i = 0; i < 5; i += 1) {
      const t0 = performance.now();
      runHook(payload());
      loaded.push(performance.now() - t0);
    }
    const p95 = (xs) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil(0.95 * xs.length) - 1)];
    process.stderr.write(
      `[timing] mission-complete-record spawn p95: empty=${p95(empty).toFixed(0)}ms `
      + `loaded(1k rows)=${p95(loaded).toFixed(0)}ms\n`,
    );
    expect(empty).toHaveLength(5);
  }, 60_000);
});

describe('refusals and throws — the failure modes a green fixture hides', () => {
  it('reports declared=refused when the ledger cannot be appended to', () => {
    seedMission();
    seedVerify();
    const ledger = ledgerFilePath(repo);
    const before = readRunLedger(repo).length;
    // READ-ONLY LEDGER, the reviewer's reproduction. Reads still succeed, so
    // the mission is still found and still declarable; only the append fails.
    // `appendLedgerEvent` NEVER THROWS for this — it returns `{ok: false}` —
    // which is exactly why ignoring the result printed `declared=new` over a
    // ledger that gained nothing.
    chmodSync(ledger, 0o444);
    let res;
    try {
      res = runHook(payload());
    } finally {
      chmodSync(ledger, 0o666);
    }

    expect(res.status).toBe(0);
    expect(res.stdout).toBe('');
    const f = fields(res.lines[0]);
    expect(f.mission).toBe(missionId);
    expect(f.declared).toBe('refused');
    // No declaration exists, so the gates judged nothing: `block=none` here
    // means "not evaluated", and the `write=blocked` says no file followed.
    expect(f.block).toBe('none');
    expect(f.write).toBe(WriteStatus.BLOCKED);
    // THE POINT OF THE CASE: the log and the ledger agree.
    expect(completedLines()).toHaveLength(0);
    expect(readRunLedger(repo)).toHaveLength(before);
  });

  it('keeps going for the NEXT mission when one mission cannot be read', () => {
    const healthy = 'M-20260915-778';
    // `plan.md` as a DIRECTORY: `existsSync` is true, `readFileSync` throws
    // EISDIR. Before the guard this took the whole pass down and every later
    // mission lost its declaration permanently — SessionEnd fires once.
    seedMission();
    seedVerify();
    mkdirSync(path.join(repo, '.artibot', 'missions', missionId, 'plan.md'), { recursive: true });
    writeFileSync(path.join(repo, '.artibot', 'missions', missionId, 'review.md'), 'x', 'utf-8');
    seedMission(healthy);
    seedVerify(healthy);

    const res = runHook(payload());

    expect(res.status).toBe(0);
    expect(res.lines).toHaveLength(2);
    const byMission = Object.fromEntries(res.lines.map((l) => [fields(l).mission, fields(l)]));
    expect(byMission[missionId].block).toBe('ARTIFACT_UNPARSEABLE');
    expect(byMission[healthy].declared).toBe('new');
    expect(byMission[healthy].block).toBe('ARTIFACT_ABSENT');
    // BOTH declarations survive: the unreadable mission is classified, not skipped.
    expect(completedLines().map((l) => l.mission_id).sort())
      .toEqual([healthy, missionId].sort());
  });

  it('skips a malformed mission_id without touching the other missions', () => {
    seedMission();
    seedVerify();
    // Written straight to the ledger file: the writer validates `mission_id`
    // and would refuse this row, so the only way such a line exists is a path
    // this hook cannot name — which is exactly the case the filter is for.
    const bad = { ...readRunLedger(repo)[0], mission_id: 'not a mission id!!', seq: 9001 };
    appendFileSync(ledgerFilePath(repo), `${JSON.stringify(bad)}\n`, 'utf-8');

    const res = runHook(payload());

    expect(res.status).toBe(0);
    // ONE line, for the real mission. The malformed id never reaches `mission=`,
    // where its spaces would have split the line into unrejoinable fields.
    expect(res.lines).toHaveLength(1);
    expect(fields(res.lines[0]).mission).toBe(missionId);
    expect(res.stderr).not.toContain('not a mission id');
    expect(completedLines()).toHaveLength(1);
  });

  it('declares every value it prints from the two closed vocabularies', () => {
    expect(DECLARATION_STATUSES).toEqual(['new', 'existing', 'refused']);
    expect(Object.values(WriteStatus)).toContain(WriteStatus.BLOCKED);
  });
});

afterAll(() => {
  // THE ISOLATION PROOF. Not a tidiness check: a single leaked append into the
  // repository's own ledger would become a data point in the very distribution
  // this hook is built to measure, and nothing downstream could tell it apart
  // from a real one.
  expect(digest(LIVE_LEDGER)).toBe(liveLedgerBefore);
  expect(existsSync(LIVE_MISSIONS)).toBe(liveMissionsBefore);
});
