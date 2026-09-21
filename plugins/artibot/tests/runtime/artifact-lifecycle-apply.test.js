/**
 * T-40 Shadow stage — `lib/runtime/artifact-lifecycle.js#apply` as a real writer.
 *
 * The dry-run sibling (`artifact-lifecycle-dryrun.test.js`) owns the proof that
 * `plan()` and a gated `apply()` touch no filesystem at all. This file owns the
 * other half: what happens when all THREE gates open, and — more importantly —
 * that every one of them still refuses on its own.
 *
 *   1. gate 3 (`write === true`) closed → byte-identical legacy shape, 0 fs calls.
 *      This is the "existing callers are unchanged" contract.
 *   2. gate 1 / gate 2 closed → throws, nothing on disk. Neither is satisfiable
 *      by a truthy value.
 *   3. all three open → one file per unblocked write, at the canonical mission
 *      path, with the caller's exact bytes.
 *   4. the four refusals that are NOT exceptions — NO_CONTENT, ALREADY_EXISTS,
 *      PATH_OUTSIDE_MISSIONS_DIR, WRITE_FAILED — each leaves the batch running.
 *   5. idempotency, twice: within one batch (plan() refuses the replay) and
 *      across runs (`appliedIdempotencyKeys`), plus the never-clobber backstop
 *      for a caller that forgot to carry the keys.
 *   6. the config key that opens gate 2 is present and is a real boolean.
 *
 * Fixtures are `mkdtemp` roots under the OS temp dir. Nothing here writes under
 * the repository's own `.artibot/`.
 *
 * Measured on win32 (this machine). Every expected path is built with
 * `path.join`, so the separator assertions hold on POSIX too.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  apply,
  APPLY_GATE_PATH,
  ARTIFACT_BASENAME,
  ArtifactKind,
  GateReason,
  MISSIONS_DIR,
  plan,
  PROJECT_MARKER_PATH,
  RefusalCode,
  resolveArtifactGate,
  SkipReason,
} from '../../lib/runtime/artifact-lifecycle.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, '..', '..');

const MISSION_ID = 'M-20260912-001';
const VID = 'v-9f2c1a';
/**
 * The shipped marker path, as segments. Gate 2 is now TWO conditions, not one:
 * the global `enabled` flag AND this file existing under the project root, so
 * every fixture that opens gate 3 has to be a project that opted in.
 */
const MARKER_SEGMENTS = Object.freeze(['.artibot', 'project.md']);
const MARKER_REL = MARKER_SEGMENTS.join('/');

const ENABLED_CONFIG = Object.freeze({
  runtime: { artifactLifecycle: { enabled: true, projectMarker: MARKER_REL } },
});

/**
 * Deliberately multibyte and deliberately CRLF: `bytes` must be a byte count,
 * not a character count, and the writer must not normalise line endings.
 */
const INTENT_MD = '# intent\r\nrevision: 1\r\ncafé\n';

let root;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'artibot-apply-'));
  seedMarker(root);
});

/**
 * Make `dir` a project that opted into the artifact writer. Seeding, never a
 * relaxed assertion: the marker is what the gate is now contracted to require,
 * so a fixture without one is a fixture that must not write.
 */
function seedMarker(dir) {
  const target = path.join(dir, ...MARKER_SEGMENTS);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, '# project\n');
  return target;
}

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Where the module is contracted to put an artifact of this kind. */
function expectedPath(kind) {
  return path.join(root, ...MISSIONS_DIR, MISSION_ID, ARTIFACT_BASENAME[kind]);
}

function envelope(event, data = {}, overrides = {}) {
  return {
    v: 1,
    ts: '2026-09-12T00:00:00Z',
    event,
    mission_id: MISSION_ID,
    session_id: 's-1',
    source: 'hook',
    pid: 100,
    seq: 0,
    data,
    ...overrides,
  };
}

const ev = {
  missionCreated: (intentRevision = 2) =>
    envelope('mission.created', { title: 'x', intent_revision: intentRevision }),
  planRevised: (revision = 5) => envelope('plan.revised', { revision, mode: 'plan' }),
  reviewCompleted: (verdict = 'PASS') =>
    envelope('review.completed', { verdict, findings_ref: 'E-001', verification_id: VID }),
  missionCompleted: () =>
    envelope('mission.completed', {
      accepted: null,
      evidence_refs: ['E-001'],
      verification_id: VID,
    }),
  verifyCompleted: (result = 'pass') =>
    envelope('verify.completed', { result, evidence: ['E-001'], verification_id: VID }),
  humanAsked: (questionId) => envelope('human.asked', { question_id: questionId }),
};

function healthyState(overrides = {}) {
  return {
    missionId: MISSION_ID,
    intentRevision: 2,
    planRevision: 5,
    reviewRevision: 1,
    artifacts: {
      plan: { based_on: { intent_revision: 2 } },
      review: { based_on: { intent_revision: 2, plan_revision: 5 } },
    },
    ...overrides,
  };
}

function completionEvents() {
  return [
    ev.missionCreated(2),
    ev.planRevised(5),
    ev.verifyCompleted('pass'),
    ev.reviewCompleted('PASS'),
    ev.missionCompleted(),
  ];
}

function runPlan(events, missionState = healthyState()) {
  return plan({ events, missionState, projectRoot: root });
}

/**
 * Every file under the fixture root that the writer could have created, as
 * root-relative POSIX paths.
 *
 * The opt-in marker seeded by `beforeEach` is excluded — it is fixture
 * scaffolding the test itself wrote, not an artifact, and listing it would
 * change the meaning of every pre-existing `toEqual([])` from "the writer
 * created nothing" into "the writer created nothing except the file we put
 * there". `filesUnderIncludingMarker` keeps the unfiltered view available, and
 * one test below asserts the marker really is on disk, so the exclusion cannot
 * hide a fixture that silently stopped being seeded.
 */
function filesUnder(dir) {
  return filesUnderIncludingMarker(dir).filter((rel) => rel !== MARKER_REL);
}

function filesUnderIncludingMarker(dir) {
  const out = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(root, full).split(path.sep).join('/'));
    }
  };
  walk(dir);
  return out.sort();
}

/** Spy on every fs write entry point; returns a `assertNone()` helper. */
function spyOnFsWrites() {
  const syncTargets = [
    'writeFileSync',
    'appendFileSync',
    'mkdirSync',
    'rmSync',
    'renameSync',
    'copyFileSync',
    'openSync',
    'createWriteStream',
  ];
  const asyncTargets = ['writeFile', 'appendFile', 'mkdir', 'rm', 'rename', 'open'];
  const spies = [
    ...syncTargets.map((name) => vi.spyOn(fs, name)),
    ...asyncTargets.map((name) => vi.spyOn(fsPromises, name)),
  ];
  return {
    assertNone() {
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    },
    restore() {
      for (const spy of spies) spy.mockRestore();
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Gate 3 closed — the legacy shape, unchanged
// ---------------------------------------------------------------------------

describe('gate 3 (write) closed — existing callers see no change', () => {
  it('returns exactly the dry-run shape when write is omitted', () => {
    const result = runPlan([...completionEvents(), ev.humanAsked('q1')]);
    const report = apply(result, { dryRun: true, config: ENABLED_CONFIG });

    expect(Object.keys(report).sort()).toEqual(['blocked', 'dryRun', 'wouldWrite', 'written']);
    expect(report.dryRun).toBe(true);
    expect(report.written).toEqual([]);
    expect(report.wouldWrite.map((w) => w.kind)).toEqual([
      ArtifactKind.INTENT,
      ArtifactKind.PLAN,
      ArtifactKind.REVIEW,
    ]);
    expect(report.blocked.map((w) => w.kind)).toEqual([ArtifactKind.OUTCOME]);
    expect(filesUnder(root)).toEqual([]);
  });

  it('calls no fs write entry point with gate 3 closed (dynamic proof)', () => {
    const spies = spyOnFsWrites();
    try {
      const result = runPlan(completionEvents());
      expect(result.writes.length).toBeGreaterThan(0);
      apply(result, { dryRun: true, config: ENABLED_CONFIG });
      apply(result, {
        dryRun: true,
        config: ENABLED_CONFIG,
        content: { [ArtifactKind.INTENT]: INTENT_MD },
        projectRoot: root,
      });
      spies.assertNone();
    } finally {
      spies.restore();
    }
  });

  it.each([false, 'true', 1, undefined])('refuses to write for write: %j', (value) => {
    const result = runPlan([ev.missionCreated(2)]);
    const report = apply(result, {
      dryRun: true,
      config: ENABLED_CONFIG,
      write: value,
      projectRoot: root,
      content: { [ArtifactKind.INTENT]: INTENT_MD },
    });
    expect(report.dryRun).toBe(true);
    expect(report.written).toEqual([]);
    expect(filesUnder(root)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. Gates 1 and 2 still throw, and still create nothing
// ---------------------------------------------------------------------------

describe('gates 1 and 2 are unchanged by the writer', () => {
  const withWrite = (options) => ({
    write: true,
    projectRoot: root,
    content: { [ArtifactKind.INTENT]: INTENT_MD },
    ...options,
  });

  it('throws when dryRun is not true, even with write: true', () => {
    const result = runPlan([ev.missionCreated(2)]);
    expect(() => apply(result, withWrite({ config: ENABLED_CONFIG }))).toThrow(/dry-run only/);
    expect(() => apply(result, withWrite({ dryRun: false, config: ENABLED_CONFIG }))).toThrow(
      /dry-run only/,
    );
    expect(filesUnder(root)).toEqual([]);
  });

  it('throws when the config gate is absent', () => {
    const result = runPlan([ev.missionCreated(2)]);
    expect(() => apply(result, withWrite({ dryRun: true }))).toThrow(
      new RegExp(APPLY_GATE_PATH.replace(/\./g, '\\.')),
    );
    expect(filesUnder(root)).toEqual([]);
  });

  it.each([
    ['string true', 'true'],
    ['number 1', 1],
    ['boolean false', false],
    ['object', {}],
  ])('throws when runtime.artifactLifecycle.enabled is a %s', (_label, enabled) => {
    const result = runPlan([ev.missionCreated(2)]);
    expect(() =>
      apply(
        result,
        withWrite({ dryRun: true, config: { runtime: { artifactLifecycle: { enabled } } } }),
      ),
    ).toThrow(/requires config/);
    expect(filesUnder(root)).toEqual([]);
  });

  it('throws a TypeError when write is true but projectRoot is missing', () => {
    const result = runPlan([ev.missionCreated(2)]);
    expect(() =>
      apply(result, {
        dryRun: true,
        config: ENABLED_CONFIG,
        write: true,
        content: { [ArtifactKind.INTENT]: INTENT_MD },
      }),
    ).toThrow(TypeError);
    expect(filesUnder(root)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. All three gates open — the artifact lands
// ---------------------------------------------------------------------------

describe('all three gates open', () => {
  function applyWrite(result, content, options = {}) {
    return apply(result, {
      dryRun: true,
      config: ENABLED_CONFIG,
      write: true,
      projectRoot: root,
      content,
      ...options,
    });
  }

  it('writes intent.md at the canonical mission path with the caller bytes', () => {
    const result = runPlan([ev.missionCreated(2)]);
    const report = applyWrite(result, { [ArtifactKind.INTENT]: INTENT_MD });

    expect(report.dryRun).toBe(false);
    expect(report.wouldWrite).toEqual([]);
    expect(report.skipped).toEqual([]);
    expect(report.written).toHaveLength(1);
    expect(report.written[0].path).toBe(expectedPath(ArtifactKind.INTENT));
    expect(report.written[0].bytes).toBe(Buffer.byteLength(INTENT_MD));

    const onDisk = fs.readFileSync(expectedPath(ArtifactKind.INTENT));
    expect(onDisk.equals(Buffer.from(INTENT_MD, 'utf8'))).toBe(true);
    expect(filesUnder(root)).toEqual([
      `${MISSIONS_DIR.join('/')}/${MISSION_ID}/${ARTIFACT_BASENAME[ArtifactKind.INTENT]}`,
    ]);
  });

  it('leaves no temp file behind', () => {
    const result = runPlan([ev.missionCreated(2)]);
    applyWrite(result, { [ArtifactKind.INTENT]: INTENT_MD });
    expect(filesUnder(root).filter((f) => f.includes('.tmp'))).toEqual([]);
  });

  it('writes one file per unblocked kind and never the blocked one', () => {
    const result = runPlan([...completionEvents(), ev.humanAsked('q1')]);
    const content = {
      [ArtifactKind.INTENT]: 'i',
      [ArtifactKind.PLAN]: 'p',
      [ArtifactKind.REVIEW]: 'r',
      [ArtifactKind.OUTCOME]: 'o',
    };
    const report = applyWrite(result, content);

    expect(report.written.map((w) => w.kind)).toEqual([
      ArtifactKind.INTENT,
      ArtifactKind.PLAN,
      ArtifactKind.REVIEW,
    ]);
    expect(report.blocked.map((w) => w.kind)).toEqual([ArtifactKind.OUTCOME]);
    expect(fs.existsSync(expectedPath(ArtifactKind.OUTCOME))).toBe(false);
    expect(filesUnder(root)).toHaveLength(3);
  });

  it('writes once when the same event replays inside one batch', () => {
    const result = runPlan([ev.missionCreated(2), ev.missionCreated(2)]);
    expect(result.refused.map((r) => r.code)).toContain(RefusalCode.IDEMPOTENT_REPLAY);

    const report = applyWrite(result, { [ArtifactKind.INTENT]: INTENT_MD });
    expect(report.written).toHaveLength(1);
    expect(filesUnder(root)).toHaveLength(1);
  });

  it('writes nothing on a second run whose keys were already applied', () => {
    const first = runPlan([ev.missionCreated(2)]);
    applyWrite(first, { [ArtifactKind.INTENT]: INTENT_MD });

    const second = plan({
      events: [ev.missionCreated(2)],
      missionState: healthyState({
        appliedIdempotencyKeys: first.writes.map((w) => w.idempotencyKey),
      }),
      projectRoot: root,
    });
    expect(second.writes).toEqual([]);
    expect(second.refused.map((r) => r.code)).toContain(RefusalCode.IDEMPOTENT_REPLAY);

    const report = applyWrite(second, { [ArtifactKind.INTENT]: 'REPLACED' });
    expect(report.written).toEqual([]);
    expect(fs.readFileSync(expectedPath(ArtifactKind.INTENT), 'utf8')).toBe(INTENT_MD);
  });
});

// ---------------------------------------------------------------------------
// 4. The non-throwing refusals
// ---------------------------------------------------------------------------

describe('per-write refusals (reported, never thrown)', () => {
  function applyWrite(result, content, options = {}) {
    return apply(result, {
      dryRun: true,
      config: ENABLED_CONFIG,
      write: true,
      projectRoot: root,
      content,
      ...options,
    });
  }

  it('never clobbers a file that already exists', () => {
    const existing = 'HAND EDITED\n';
    const target = expectedPath(ArtifactKind.INTENT);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, existing, 'utf8');

    // A caller that FORGOT appliedIdempotencyKeys: plan() has no reason to
    // refuse, so this is the second line of defence.
    const result = runPlan([ev.missionCreated(2)]);
    expect(result.writes).toHaveLength(1);

    const report = applyWrite(result, { [ArtifactKind.INTENT]: INTENT_MD });
    expect(report.written).toEqual([]);
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0].reason).toBe('ALREADY_EXISTS');
    expect(report.skipped[0].reason).toBe(SkipReason.ALREADY_EXISTS);
    expect(report.skipped[0].kind).toBe(ArtifactKind.INTENT);
    expect(fs.readFileSync(target, 'utf8')).toBe(existing);
  });

  it('skips a write whose content the caller did not supply', () => {
    const result = runPlan([ev.missionCreated(2)]);
    const report = applyWrite(result, {});
    expect(report.written).toEqual([]);
    expect(report.skipped[0].reason).toBe(SkipReason.NO_CONTENT);
    expect(filesUnder(root)).toEqual([]);
  });

  it.each([
    ['a number', 7],
    ['null', null],
    ['an object', { md: 'x' }],
  ])('skips NO_CONTENT when the content is %s rather than a string', (_label, value) => {
    const result = runPlan([ev.missionCreated(2)]);
    const report = applyWrite(result, { [ArtifactKind.INTENT]: value });
    expect(report.skipped[0].reason).toBe(SkipReason.NO_CONTENT);
    expect(filesUnder(root)).toEqual([]);
  });

  it('skips NO_CONTENT when content is omitted entirely', () => {
    const result = runPlan([ev.missionCreated(2)]);
    const report = applyWrite(result, undefined);
    expect(report.written).toEqual([]);
    expect(report.skipped[0].reason).toBe(SkipReason.NO_CONTENT);
  });

  it('refuses a tampered path that escapes the missions directory', () => {
    const planned = runPlan([ev.missionCreated(2)]);
    const escapee = path.join(root, 'evil.md');
    const tampered = {
      ...planned,
      writes: [{ ...planned.writes[0], path: escapee }],
    };

    const report = applyWrite(tampered, { [ArtifactKind.INTENT]: INTENT_MD });
    expect(report.written).toEqual([]);
    expect(report.skipped[0].reason).toBe(SkipReason.PATH_OUTSIDE_MISSIONS_DIR);
    expect(fs.existsSync(escapee)).toBe(false);
    expect(filesUnder(root)).toEqual([]);
  });

  it('refuses a traversal path that climbs out of the project root', () => {
    const planned = runPlan([ev.missionCreated(2)]);
    const escapee = path.join(root, ...MISSIONS_DIR, '..', '..', 'escaped.md');
    const tampered = { ...planned, writes: [{ ...planned.writes[0], path: escapee }] };

    const report = applyWrite(tampered, { [ArtifactKind.INTENT]: INTENT_MD });
    expect(report.skipped[0].reason).toBe(SkipReason.PATH_OUTSIDE_MISSIONS_DIR);
    expect(fs.existsSync(path.resolve(escapee))).toBe(false);
  });

  it('reports a failing write instead of throwing, and keeps going', () => {
    const result = runPlan([ev.missionCreated(2), ev.planRevised(5)]);
    expect(result.writes).toHaveLength(2);

    // `lib/core/file.js#atomicWriteTextSync` writes through `fsSync.writeFileSync`,
    // so failing that one property is the honest way to simulate a full disk.
    const real = fs.writeFileSync;
    let calls = 0;
    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation((...args) => {
      calls += 1;
      if (calls === 1) throw new Error('ENOSPC: simulated');
      return real.apply(fs, args);
    });

    let report;
    try {
      report = apply(result, {
        dryRun: true,
        config: ENABLED_CONFIG,
        write: true,
        projectRoot: root,
        content: { [ArtifactKind.INTENT]: 'i', [ArtifactKind.PLAN]: 'p' },
      });
    } finally {
      spy.mockRestore();
    }

    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0].reason).toBe(SkipReason.WRITE_FAILED);
    expect(report.skipped[0].kind).toBe(ArtifactKind.INTENT);
    expect(report.skipped[0].error).toMatch(/ENOSPC/);
    expect(report.written.map((w) => w.kind)).toEqual([ArtifactKind.PLAN]);
    expect(fs.existsSync(expectedPath(ArtifactKind.PLAN))).toBe(true);
  });

  it('still refuses a plan result that is not one', () => {
    expect(() =>
      apply({ writes: 'nope' }, {
        dryRun: true,
        config: ENABLED_CONFIG,
        write: true,
        projectRoot: root,
      }),
    ).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// 5. The config key that opens gate 2
// ---------------------------------------------------------------------------

describe('gate 2 wiring (artibot.config.json)', () => {
  const config = JSON.parse(
    fs.readFileSync(path.join(PKG_ROOT, 'artibot.config.json'), 'utf8'),
  );

  it('ships runtime.artifactLifecycle.enabled false in 4.61.0 (Observe)', () => {
    expect(config.runtime.artifactLifecycle.enabled).toBe(false);
    expect(typeof config.runtime.artifactLifecycle.enabled).toBe('boolean');
  });

  it('documents the key, as every neighbouring runtime key does', () => {
    expect(typeof config.runtime.artifactLifecycle.comment).toBe('string');
    expect(config.runtime.artifactLifecycle.comment.length).toBeGreaterThan(120);
  });

  it('ships the project marker path, and exactly three keys under the block', () => {
    expect(config.runtime.artifactLifecycle.projectMarker).toBe('.artibot/project.md');
    expect(Object.keys(config.runtime.artifactLifecycle).sort()).toEqual([
      'comment',
      'enabled',
      'projectMarker',
    ]);
  });

  it('is reachable at the exact dotted path resolveArtifactGate reads', () => {
    const value = PROJECT_MARKER_PATH.split('.').reduce((node, key) => node?.[key], config);
    expect(value).toBe('.artibot/project.md');
  });

  it('is reachable at the exact dotted path apply() reads', () => {
    const value = APPLY_GATE_PATH.split('.').reduce((node, key) => node?.[key], config);
    expect(value).toBe(false);
    expect(typeof value).toBe('boolean');
  });

  it('keeps the LIVE config closed at gate 2, so apply() throws', () => {
    const result = runPlan(completionEvents());
    expect(() => apply(result, { dryRun: true, config })).toThrow(/requires config/);
    expect(filesUnder(root)).toEqual([]);
  });

  // The shipped value is false in 4.61.0; the gate-2 mechanism is exercised
  // with an explicit true so that turning the key on stays covered, not assumed.
  it('opens gate 2 on an explicit true, and gate 3 still holds the line', () => {
    const result = runPlan(completionEvents());
    const report = apply(result, { dryRun: true, config: ENABLED_CONFIG });
    expect(report.dryRun).toBe(true);
    expect(report.written).toEqual([]);
    expect(filesUnder(root)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 6. The per-project gate (B4) — `enabled` alone no longer opens gate 2
// ---------------------------------------------------------------------------

describe('resolveArtifactGate — reason table', () => {
  /** A probe that records every path it was asked about and answers `answer`. */
  function probe(answer = false) {
    const calls = [];
    const isFile = (target) => {
      calls.push(target);
      return answer;
    };
    isFile.calls = calls;
    return isFile;
  }

  it('reports GLOBAL_OFF without touching the filesystem', () => {
    const isFile = probe(true);
    for (const enabled of [undefined, false, 'true', 1, {}]) {
      const gate = resolveArtifactGate({
        config: { runtime: { artifactLifecycle: { enabled, projectMarker: MARKER_REL } } },
        projectRoot: root,
        isFile,
      });
      expect(gate).toEqual({ open: false, reason: GateReason.GLOBAL_OFF });
    }
    expect(resolveArtifactGate({ projectRoot: root, isFile })).toEqual({
      open: false,
      reason: GateReason.GLOBAL_OFF,
    });
    expect(isFile.calls).toEqual([]);
  });

  it.each([
    ['undefined', undefined],
    ['the empty string', ''],
    ['a number', 1],
    ['null', null],
  ])('reports NO_PROJECT_ROOT for %s, without probing', (_label, projectRoot) => {
    const isFile = probe(true);
    expect(resolveArtifactGate({ config: ENABLED_CONFIG, projectRoot, isFile })).toEqual({
      open: false,
      reason: GateReason.NO_PROJECT_ROOT,
    });
    expect(isFile.calls).toEqual([]);
  });

  it.each([
    ['absent', undefined],
    ['a traversal', '../outside.md'],
    ['a backslash path', '.artibot\\project.md'],
    ['an absolute path', '/etc/passwd'],
    ['a drive letter', 'C:/project.md'],
    ['an array', ['.artibot', 'project.md']],
    ['the empty string', ''],
  ])('reports MARKER_INVALID when projectMarker is %s, without probing', (_label, marker) => {
    const isFile = probe(true);
    const gate = resolveArtifactGate({
      config: { runtime: { artifactLifecycle: { enabled: true, projectMarker: marker } } },
      projectRoot: root,
      isFile,
    });
    expect(gate).toEqual({ open: false, reason: GateReason.MARKER_INVALID });
    expect(isFile.calls).toEqual([]);
  });

  it('probes the joined path exactly once and opens on a real file', () => {
    const isFile = probe(true);
    expect(resolveArtifactGate({ config: ENABLED_CONFIG, projectRoot: root, isFile })).toEqual({
      open: true,
      reason: GateReason.OPEN,
    });
    expect(isFile.calls).toEqual([path.join(root, ...MARKER_SEGMENTS)]);
  });

  it('reports PROJECT_OFF when the probe says no', () => {
    const isFile = probe(false);
    expect(resolveArtifactGate({ config: ENABLED_CONFIG, projectRoot: root, isFile })).toEqual({
      open: false,
      reason: GateReason.PROJECT_OFF,
    });
    expect(isFile.calls).toHaveLength(1);
  });

  it.each([
    ['a truthy non-true', 'yes'],
    ['1', 1],
    ['an object', {}],
  ])('reports PROJECT_OFF when the probe returns %s, not just falsy', (_label, answer) => {
    const gate = resolveArtifactGate({
      config: ENABLED_CONFIG,
      projectRoot: root,
      isFile: () => answer,
    });
    expect(gate).toEqual({ open: false, reason: GateReason.PROJECT_OFF });
  });

  it('reports PROJECT_OFF when the probe throws, rather than propagating', () => {
    const gate = resolveArtifactGate({
      config: ENABLED_CONFIG,
      projectRoot: root,
      isFile: () => {
        throw new Error('EACCES');
      },
    });
    expect(gate).toEqual({ open: false, reason: GateReason.PROJECT_OFF });
  });

  it('never throws, whatever it is handed', () => {
    for (const bad of [undefined, null, 'string', 42, []]) {
      expect(() => resolveArtifactGate(bad)).not.toThrow();
      expect(resolveArtifactGate(bad).open).toBe(false);
    }
    expect(resolveArtifactGate()).toEqual({ open: false, reason: GateReason.GLOBAL_OFF });
  });

  it('uses the real filesystem when no probe is injected', () => {
    // The seeded marker is a regular file, so the default probe opens the gate.
    expect(fs.statSync(path.join(root, ...MARKER_SEGMENTS)).isFile()).toBe(true);
    expect(filesUnderIncludingMarker(root)).toEqual([MARKER_REL]);
    expect(resolveArtifactGate({ config: ENABLED_CONFIG, projectRoot: root })).toEqual({
      open: true,
      reason: GateReason.OPEN,
    });
  });

  it('reports PROJECT_OFF when the marker path is a DIRECTORY, not a file', () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'artibot-marker-dir-'));
    try {
      fs.mkdirSync(path.join(other, ...MARKER_SEGMENTS), { recursive: true });
      expect(resolveArtifactGate({ config: ENABLED_CONFIG, projectRoot: other })).toEqual({
        open: false,
        reason: GateReason.PROJECT_OFF,
      });
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it('reports PROJECT_OFF for a project root with no marker at all', () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'artibot-no-marker-'));
    try {
      expect(resolveArtifactGate({ config: ENABLED_CONFIG, projectRoot: other })).toEqual({
        open: false,
        reason: GateReason.PROJECT_OFF,
      });
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it('closes on the LIVE shipped config, because enabled ships false', () => {
    const shipped = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'artibot.config.json'), 'utf8'));
    expect(resolveArtifactGate({ config: shipped, projectRoot: root })).toEqual({
      open: false,
      reason: GateReason.GLOBAL_OFF,
    });
  });

  it('exports a frozen five-member reason vocabulary', () => {
    expect(Object.isFrozen(GateReason)).toBe(true);
    expect(Object.values(GateReason).sort()).toEqual([
      'global-off',
      'marker-invalid',
      'no-project-root',
      'open',
      'project-off',
    ]);
  });
});

describe('apply() routes gate 2 through the project gate', () => {
  const writeOptions = (overrides = {}) => ({
    dryRun: true,
    config: ENABLED_CONFIG,
    write: true,
    projectRoot: root,
    content: { [ArtifactKind.INTENT]: INTENT_MD },
    ...overrides,
  });

  it('writes when the marker is present (the seeded fixture)', () => {
    const report = apply(runPlan([ev.missionCreated(2)]), writeOptions());
    expect(report.written).toHaveLength(1);
    expect(fs.existsSync(expectedPath(ArtifactKind.INTENT))).toBe(true);
  });

  it('throws and writes nothing when the marker is absent', () => {
    fs.rmSync(path.join(root, ...MARKER_SEGMENTS), { force: true });
    expect(() => apply(runPlan([ev.missionCreated(2)]), writeOptions())).toThrow(
      new RegExp(PROJECT_MARKER_PATH.replace(/\./g, '\\.')),
    );
    expect(filesUnder(root)).toEqual([]);
  });

  it('names the reason in the refusal', () => {
    fs.rmSync(path.join(root, ...MARKER_SEGMENTS), { force: true });
    expect(() => apply(runPlan([ev.missionCreated(2)]), writeOptions())).toThrow(
      new RegExp(GateReason.PROJECT_OFF),
    );
  });

  it('throws MARKER_INVALID-flavoured refusal when projectMarker is malformed', () => {
    const config = { runtime: { artifactLifecycle: { enabled: true, projectMarker: '../x.md' } } };
    expect(() => apply(runPlan([ev.missionCreated(2)]), writeOptions({ config }))).toThrow(
      new RegExp(GateReason.MARKER_INVALID),
    );
    expect(filesUnder(root)).toEqual([]);
  });

  it('still throws the ORIGINAL gate-2 message when enabled is not true', () => {
    const config = { runtime: { artifactLifecycle: { enabled: false, projectMarker: MARKER_REL } } };
    expect(() => apply(runPlan([ev.missionCreated(2)]), writeOptions({ config }))).toThrow(
      /requires config/,
    );
    expect(filesUnder(root)).toEqual([]);
  });

  it('keeps the dry-run path free of the filesystem and of projectRoot', () => {
    const spies = spyOnFsWrites();
    try {
      const statSpy = vi.spyOn(fs, 'statSync');
      const report = apply(runPlan(completionEvents()), {
        dryRun: true,
        config: ENABLED_CONFIG,
      });
      expect(report.dryRun).toBe(true);
      expect(report.written).toEqual([]);
      expect(statSpy).not.toHaveBeenCalled();
      spies.assertNone();
    } finally {
      spies.restore();
    }
  });

  it('leaves no direct enabled read inside apply() (static proof)', () => {
    const source = fs.readFileSync(
      path.join(PKG_ROOT, 'lib', 'runtime', 'artifact-lifecycle.js'),
      'utf8',
    );
    const applyAt = source.indexOf('export function apply(');
    const resolverAt = source.indexOf('export function resolveArtifactGate(');
    expect(applyAt).toBeGreaterThan(0);
    expect(resolverAt).toBeGreaterThan(applyAt);
    const applyBody = source.slice(applyAt, resolverAt);
    expect(applyBody).not.toMatch(/artifactLifecycle\?\.enabled/);
    expect(applyBody).toContain('resolveArtifactGate(');
  });
});
