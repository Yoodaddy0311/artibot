import { describe, expect, it } from 'vitest';
import {
  DETERMINISTIC_EVIDENCE_CODES as C,
  evaluateDeterministicEvidence,
} from '../../lib/autopilot/verify-evidence-deterministic.js';
import { REASONS, RESULT_FILE_RELPATH } from '../../lib/verification/deterministic-source.js';

/**
 * Rule 7 of the REPORT gate, decided from injected ports only (no fs, no git).
 * The fixtures are the reporter's real v2/v3 shapes; the hand-out instant is the
 * VERIFY `started` journal row's ISO `at`.
 */

const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const REPO = '/repo';
const HAND_OUT = '2026-10-23T10:00:00.000Z';
const RUN_AFTER = '2026-10-23T10:05:00.000Z';
const RUN_BEFORE = '2026-10-23T09:55:00.000Z';
const NOW = Date.parse('2026-10-23T10:10:00.000Z');

function snapshot(over = {}) {
  return JSON.stringify({
    timestamp: RUN_AFTER,
    durationMs: 1000,
    modules: 3,
    totalTests: 10,
    passed: 10,
    failed: 0,
    skipped: 0,
    failedFiles: [],
    schemaVersion: 3,
    completion: { reason: 'passed', unhandledErrorCount: 0, unfinishedCount: 0 },
    gitSha: HEAD,
    gitDirty: true,
    ...over,
  });
}

function ports({ text = snapshot(), head = HEAD, readThrows = false, headThrows = false } = {}) {
  return {
    readFile: (p) => {
      if (readThrows) throw new Error('EACCES');
      return p === `${REPO}/${RESULT_FILE_RELPATH}` ? text : null;
    },
    headSha: () => {
      if (headThrows) throw new Error('git missing');
      return head;
    },
  };
}

const run = (p, over = {}) => evaluateDeterministicEvidence(p, { repoRoot: REPO, verifyStartedAt: HAND_OUT, nowMs: NOW, ...over });

describe('rule 7 — the one pass', () => {
  it('passes a fresh, same-sha, exit-0 snapshot and reports the dirty flag in the reason', () => {
    const v = run(ports());
    expect(v.ok).toBe(true);
    expect(v.code).toBeNull();
    expect(v.headSha).toBe(HEAD);
    expect(v.snapshot).toEqual({ gitSha: HEAD, gitDirty: true, measuredAtMs: Date.parse(RUN_AFTER) });
    expect(v.reason).toContain('vitest result fresh');
    expect(v.reason).toContain('tree dirty at run time');
  });

  it('accepts a 7+ digit abbreviation that is a prefix of HEAD', () => {
    const v = run(ports({ text: snapshot({ gitSha: HEAD.slice(0, 12) }) }));
    expect(v.ok).toBe(true);
  });

  it('reads the snapshot at RESULT_FILE_RELPATH under the repo root, not anywhere else', () => {
    const seen = [];
    const p = { readFile: (file) => { seen.push(file); return snapshot(); }, headSha: () => HEAD };
    run(p);
    expect(seen).toEqual([`${REPO}/${RESULT_FILE_RELPATH}`]);
  });

  it('accepts a numeric hand-out instant too', () => {
    expect(run(ports(), { verifyStartedAt: Date.parse(HAND_OUT) }).ok).toBe(true);
  });
});

describe('rule 7 — MISSING: nothing measured this tree', () => {
  it.each([
    ['undefined', undefined],
    ['empty string', ''],
    ['not a string', 42],
  ])('refuses without a repo root (%s) and consults no port', (_label, repoRoot) => {
    const p = { readFile: () => { throw new Error('must not be called'); }, headSha: () => { throw new Error('must not be called'); } };
    const v = evaluateDeterministicEvidence(p, { repoRoot, verifyStartedAt: HAND_OUT });
    expect(v).toMatchObject({ ok: false, code: C.MISSING, headSha: null });
  });

  it('refuses when the snapshot is absent, with the source\'s own reason', () => {
    const v = run(ports({ text: null }));
    expect(v).toMatchObject({ ok: false, code: C.MISSING, reason: REASONS.absent, headSha: null });
  });

  it('refuses when the read port throws — a throw is not a measurement', () => {
    expect(run(ports({ readThrows: true }))).toMatchObject({ ok: false, code: C.MISSING, reason: REASONS.absent });
  });

  it('refuses a v2 snapshot (no gitSha) before resolving HEAD — it cannot be bound to a tree', () => {
    const v2 = snapshot({ schemaVersion: 2 });
    const parsed = JSON.parse(v2);
    delete parsed.gitSha;
    delete parsed.gitDirty;
    const p = { readFile: () => JSON.stringify(parsed), headSha: () => { throw new Error('must not be called'); } };
    const v = run(p);
    expect(v).toMatchObject({ ok: false, code: C.MISSING, headSha: null });
    expect(v.reason).toContain('no git identity');
    expect(v.snapshot.gitSha).toBeNull();
  });

  it('refuses when HEAD cannot be resolved (port returns null or throws, or answers out of shape)', () => {
    for (const p of [ports({ head: null }), ports({ headThrows: true }), ports({ head: 'HEAD' }), ports({ head: HEAD.toUpperCase() })]) {
      const v = run(p);
      expect(v).toMatchObject({ ok: false, code: C.MISSING, headSha: null });
      expect(v.reason).toContain('HEAD');
    }
  });

  it('refuses when the hand-out instant is unusable', () => {
    for (const at of [undefined, null, '', 'yesterday', Number.NaN]) {
      const v = run(ports(), { verifyStartedAt: at });
      expect(v).toMatchObject({ ok: false, code: C.MISSING, headSha: HEAD });
      expect(v.reason).toContain('hand-out instant');
    }
  });

  it('maps every non-stale UNMEASURED verdict of the source to MISSING with that reason', () => {
    const cases = [
      ['corrupt', '{"gitSha":"' + HEAD + '","timestamp":"' + RUN_AFTER + '"}', REASONS.corrupt],
      ['empty run', snapshot({ totalTests: 0, passed: 0 }), REASONS.emptyRun],
      ['bad timestamp', snapshot({ timestamp: 'not-a-date' }), null],
      ['interrupted', snapshot({ completion: { reason: 'interrupted', unhandledErrorCount: 0, unfinishedCount: 0 } }), REASONS.interrupted],
    ];
    for (const [label, text, reason] of cases) {
      const v = run(ports({ text }));
      expect(v.ok, label).toBe(false);
      expect(v.code, label).toBe(C.MISSING);
      if (reason) expect(v.reason, label).toBe(reason);
    }
  });

  it('a bad timestamp has no identity for freshness but keeps the sha it did read', () => {
    const v = run(ports({ text: snapshot({ timestamp: 'not-a-date' }) }));
    expect(v.snapshot.gitSha).toBe(HEAD);
    expect(v.snapshot.measuredAtMs).toBeNull();
  });
});

describe('rule 7 — STALE: something was measured, not this tree or not this attempt', () => {
  it('refuses a snapshot of another commit', () => {
    const v = run(ports({ text: snapshot({ gitSha: OTHER }) }));
    expect(v).toMatchObject({ ok: false, code: C.STALE, headSha: HEAD });
    expect(v.reason).toContain(OTHER.slice(0, 12));
    expect(v.reason).toContain(HEAD.slice(0, 12));
  });

  it('refuses an abbreviation that is not a prefix of HEAD, and one shorter than 7 digits', () => {
    expect(run(ports({ text: snapshot({ gitSha: OTHER.slice(0, 12) }) })).code).toBe(C.STALE);
    // 6 digits is below git's own abbreviation floor: readSnapshotIdentity already
    // refuses it as an id, so it reads as "no identity" (MISSING), never as a match.
    expect(run(ports({ text: snapshot({ gitSha: HEAD.slice(0, 6) }) })).code).toBe(C.MISSING);
  });

  it('refuses a same-sha snapshot that predates the VERIFY hand-out (F1 against the attempt)', () => {
    const v = run(ports({ text: snapshot({ timestamp: RUN_BEFORE }) }));
    expect(v).toMatchObject({ ok: false, code: C.STALE, headSha: HEAD });
    expect(v.reason).toContain('predates this VERIFY hand-out');
  });

  it('treats a run that ended in the same millisecond as the hand-out as covering it', () => {
    expect(run(ports({ text: snapshot({ timestamp: HAND_OUT }) })).ok).toBe(true);
  });
});

describe('rule 7 — FAILED: the fresh run itself said no', () => {
  it('refuses a fresh same-sha run with a failed test, naming the counts', () => {
    const v = run(ports({ text: snapshot({ passed: 9, failed: 1, completion: { reason: 'failed', unhandledErrorCount: 0, unfinishedCount: 0 } }) }));
    expect(v).toMatchObject({ ok: false, code: C.FAILED, headSha: HEAD });
    expect(v.reason).toContain('1 failed');
    expect(v.reason).toContain('the fresh run failed');
  });

  it('refuses a run vitest ended as failed although no test failed (completion rule 3)', () => {
    const v = run(ports({ text: snapshot({ completion: { reason: 'failed', unhandledErrorCount: 0, unfinishedCount: 0 } }) }));
    expect(v.code).toBe(C.FAILED);
  });
});

describe('rule 7 — never throws, codes are a closed set', () => {
  it('survives a missing ports object', () => {
    const v = evaluateDeterministicEvidence(undefined, { repoRoot: REPO, verifyStartedAt: HAND_OUT });
    expect(v).toMatchObject({ ok: false, code: C.MISSING });
  });

  it('exposes exactly three refusal codes, all prefixed VERIFY_EVIDENCE_', () => {
    expect(Object.values(C).sort()).toEqual(['VERIFY_EVIDENCE_FAILED', 'VERIFY_EVIDENCE_MISSING', 'VERIFY_EVIDENCE_STALE']);
    expect(Object.isFrozen(C)).toBe(true);
  });
});
