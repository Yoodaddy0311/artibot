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
  MISSIONS_DIR,
  plan,
  RefusalCode,
  SkipReason,
} from '../../lib/runtime/artifact-lifecycle.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, '..', '..');

const MISSION_ID = 'M-20260912-001';
const VID = 'v-9f2c1a';
const ENABLED_CONFIG = Object.freeze({ runtime: { artifactLifecycle: { enabled: true } } });

/**
 * Deliberately multibyte and deliberately CRLF: `bytes` must be a byte count,
 * not a character count, and the writer must not normalise line endings.
 */
const INTENT_MD = '# intent\r\nrevision: 1\r\ncafé\n';

let root;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'artibot-apply-'));
});

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

/** Every file under the fixture root, as repo-relative POSIX paths. */
function filesUnder(dir) {
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

  it('declares runtime.artifactLifecycle.enabled as a real boolean true', () => {
    expect(config.runtime.artifactLifecycle.enabled).toBe(true);
    expect(typeof config.runtime.artifactLifecycle.enabled).toBe('boolean');
  });

  it('documents the key, as every neighbouring runtime key does', () => {
    expect(typeof config.runtime.artifactLifecycle.comment).toBe('string');
    expect(config.runtime.artifactLifecycle.comment.length).toBeGreaterThan(120);
  });

  it('is reachable at the exact dotted path apply() reads', () => {
    const value = APPLY_GATE_PATH.split('.').reduce((node, key) => node?.[key], config);
    expect(value).toBe(true);
  });

  it('lets the LIVE config open gate 2, and gate 3 still holds the line', () => {
    const result = runPlan(completionEvents());
    const report = apply(result, { dryRun: true, config });
    expect(report.dryRun).toBe(true);
    expect(report.written).toEqual([]);
    expect(filesUnder(root)).toEqual([]);
  });
});
