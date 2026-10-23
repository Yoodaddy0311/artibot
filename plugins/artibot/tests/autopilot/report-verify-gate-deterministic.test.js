/**
 * REPORT verify-evidence gate — evidenceMode 'deterministic' (05 D-04, rule 7).
 *
 * Layers:
 *   1. The pure evaluator under 'deterministic': rules 1-6′ still decide first,
 *      then rule 7 reads the vitest snapshot and HEAD through injected ports and
 *      maps the decision module's three refusals onto the gate's codes; 'ack'
 *      and 'explicit-pass' never touch a port.
 *   2. The vocabulary: three modes, ten codes, the three evidence codes spelled
 *      by `verify-evidence-deterministic.js`, the reader and the loader accept
 *      'deterministic'.
 *   3. The two entry points with a real session: a pause carries the code, the
 *      Korean hint and the `근거:` detail; a pass leaves a gate tick naming the run.
 *   4. The default ports: with nothing injected the gate really reads the file
 *      under the project root and really asks git — a root that is not a
 *      repository is MISSING, never a guess.
 *
 * Isolation: the autopilot store is sandboxed by `tests/setup/state-dir.js`;
 * PRD/report files and the fake snapshot go under a mkdtemp project root.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  evaluateReportVerifyEvidence,
  gateReportOnVerify,
  loadReportVerifyGateConfig,
  readReportVerifyGateEvidenceMode,
  refuseRecordedReport,
  REPORT_VERIFY_CODES,
  REPORT_VERIFY_EVIDENCE_MODES,
} from '../../lib/autopilot/report-verify-gate.js';
import { DETERMINISTIC_EVIDENCE_CODES } from '../../lib/autopilot/verify-evidence-deterministic.js';
import { REASONS, RESULT_FILE_RELPATH } from '../../lib/verification/deterministic-source.js';
import { abortAutopilot, startAutopilot } from '../../lib/autopilot/index.js';
import { PHASES } from '../../lib/autopilot/engine-state.js';
import { deleteSessionArtifacts, loadSession } from '../../lib/autopilot/session-store.js';
import { readEvents } from '../../lib/autopilot/telemetry.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const HEAD = 'c'.repeat(40);
const OTHER = 'd'.repeat(40);
const HAND_OUT = '2026-10-23T10:00:00.000Z';
const RUN_AFTER = '2026-10-23T10:05:00.000Z';
const RUN_BEFORE = '2026-10-23T09:55:00.000Z';
const NOW = Date.parse('2026-10-23T10:10:00.000Z');
const REPO = '/fixture-repo';

const row = (attemptId, phase, event, reason = null, at = '2026-10-23T09:50:00.000Z') => ({
  attemptId, phase, event, from: null, to: null, reason, at,
});
/** EXECUTE done, then a VERIFY handed out at HAND_OUT and acknowledged done. */
const JOURNAL = [
  row('e1', 'EXECUTE', 'started'), row('e1', 'EXECUTE', 'acknowledged', 'done'),
  row('v1', 'VERIFY', 'started', null, HAND_OUT), row('v1', 'VERIFY', 'acknowledged', 'done'),
];
const stateOf = (verifyResult = { status: 'PASS' }, extra = {}) => ({
  attemptJournal: JOURNAL, activePhaseAttempt: null, verifyResult, ...extra,
});

function snapshot(over = {}) {
  return JSON.stringify({
    timestamp: RUN_AFTER, durationMs: 1000, modules: 3, totalTests: 10, passed: 10, failed: 0, skipped: 0,
    failedFiles: [], schemaVersion: 3,
    completion: { reason: 'passed', unhandledErrorCount: 0, unfinishedCount: 0 },
    gitSha: HEAD, gitDirty: false, ...over,
  });
}

/** Ports over an in-memory snapshot; `calls` records every read so a test can assert silence. */
function ports({ text = snapshot(), head = HEAD } = {}) {
  const calls = [];
  return {
    calls,
    readFile: (file) => { calls.push(['readFile', file]); return file === `${REPO}/${RESULT_FILE_RELPATH}` ? text : null; },
    headSha: (cwd) => { calls.push(['headSha', cwd]); return head; },
  };
}
const THROWING = { readFile: () => { throw new Error('must not be read'); }, headSha: () => { throw new Error('must not be asked'); } };

const evaluate = (state, p, mode = 'deterministic') => evaluateReportVerifyEvidence(state, {
  evidenceMode: mode, evidence: { ports: p, repoRoot: REPO, nowMs: NOW },
});

// ---------------------------------------------------------------------------
// 1. The pure evaluator
// ---------------------------------------------------------------------------

describe("evaluateReportVerifyEvidence — rule 7 under 'deterministic'", () => {
  it('passes an explicit PASS backed by a fresh, same-sha, exit-0 snapshot and names the run in detail', () => {
    const p = ports();
    const v = evaluate(stateOf(), p);
    expect(v).toMatchObject({ ok: true, code: 'ok', attemptId: 'v1', checkpointSha: null });
    expect(v.detail).toContain('vitest result fresh');
    expect(v.detail).toContain('tree clean at run time');
    expect(p.calls.map(([k]) => k)).toEqual(['readFile', 'headSha']);
  });

  it('refuses VERIFY_EVIDENCE_MISSING when no snapshot exists, with the source reason as detail', () => {
    const v = evaluate(stateOf(), ports({ text: null }));
    expect(v).toMatchObject({ ok: false, code: 'VERIFY_EVIDENCE_MISSING', attemptId: 'v1', detail: REASONS.absent });
  });

  it('refuses VERIFY_EVIDENCE_MISSING for a pre-v3 snapshot that names no commit', () => {
    const parsed = JSON.parse(snapshot({ schemaVersion: 2 }));
    delete parsed.gitSha;
    delete parsed.gitDirty;
    const v = evaluate(stateOf(), ports({ text: JSON.stringify(parsed) }));
    expect(v.code).toBe('VERIFY_EVIDENCE_MISSING');
    expect(v.detail).toContain('no git identity');
  });

  it('refuses VERIFY_EVIDENCE_STALE for a snapshot of another commit, naming both ids', () => {
    const v = evaluate(stateOf(), ports({ text: snapshot({ gitSha: OTHER }) }));
    expect(v).toMatchObject({ ok: false, code: 'VERIFY_EVIDENCE_STALE' });
    expect(v.detail).toContain(OTHER.slice(0, 12));
    expect(v.detail).toContain(HEAD.slice(0, 12));
  });

  it('refuses VERIFY_EVIDENCE_STALE for a same-sha run written before the VERIFY hand-out', () => {
    const v = evaluate(stateOf(), ports({ text: snapshot({ timestamp: RUN_BEFORE }) }));
    expect(v).toMatchObject({ ok: false, code: 'VERIFY_EVIDENCE_STALE' });
    expect(v.detail).toContain('predates this VERIFY hand-out');
  });

  it('refuses VERIFY_EVIDENCE_FAILED when the fresh same-sha run failed, whatever the driver wrote', () => {
    const failing = snapshot({ passed: 9, failed: 1, completion: { reason: 'failed', unhandledErrorCount: 0, unfinishedCount: 0 } });
    const v = evaluate(stateOf({ status: 'PASS' }), ports({ text: failing }));
    expect(v).toMatchObject({ ok: false, code: 'VERIFY_EVIDENCE_FAILED' });
    expect(v.detail).toContain('1 failed');
  });

  it("applies rule 6′ first: no explicit PASS is VERIFY_RESULT_UNMEASURED and the ports are never consulted", () => {
    for (const vr of [null, undefined, {}, 'FAIL', { status: 'fail' }, { mcp: { ok: false } }, { summary: 'tests not run' }]) {
      // Not stateOf(): its default parameter would turn `undefined` into a PASS.
      const v = evaluate({ attemptJournal: JOURNAL, activePhaseAttempt: null, verifyResult: vr }, THROWING);
      expect(v).toMatchObject({ ok: false, code: 'VERIFY_RESULT_UNMEASURED', attemptId: 'v1' });
      expect(v).not.toHaveProperty('detail');
    }
  });

  it('applies rule 6 first too: an explicit FAIL is VERIFY_RESULT_FAILED without a port read', () => {
    const v = evaluate(stateOf({ status: 'FAIL' }), THROWING);
    expect(v).toMatchObject({ ok: false, code: 'VERIFY_RESULT_FAILED' });
  });

  it('keeps rules 1-5 ahead of rule 7: a stale or unacknowledged VERIFY never reaches the ports', () => {
    const unacked = { ...stateOf(), attemptJournal: JOURNAL.slice(0, 3) };
    expect(evaluate(unacked, THROWING).code).toBe('VERIFY_NOT_ACKED');
    const none = { ...stateOf(), attemptJournal: [] };
    expect(evaluate(none, THROWING).code).toBe('NO_VERIFY_ATTEMPT');
  });

  it("never touches a port under 'ack' or 'explicit-pass', and their verdicts carry no detail key", () => {
    for (const mode of ['ack', 'explicit-pass']) {
      const v = evaluate(stateOf(), THROWING, mode);
      expect(v).toEqual({ ok: true, code: 'ok', attemptId: 'v1', checkpointSha: null });
    }
  });

  it("reads the hand-out instant from the VERIFY started row's `at`, not from the acknowledgement", () => {
    // Same snapshot, but the hand-out moved after the run: now stale.
    const late = { ...stateOf(), attemptJournal: [JOURNAL[0], JOURNAL[1], row('v1', 'VERIFY', 'started', null, RUN_AFTER.replace('10:05', '10:06')), JOURNAL[3]] };
    expect(evaluate(late, ports()).code).toBe('VERIFY_EVIDENCE_STALE');
  });

  it('refuses VERIFY_EVIDENCE_MISSING when the hand-out instant is unusable', () => {
    const noAt = { ...stateOf(), attemptJournal: [JOURNAL[0], JOURNAL[1], { ...JOURNAL[2], at: undefined }, JOURNAL[3]] };
    const v = evaluate(noAt, ports());
    expect(v.code).toBe('VERIFY_EVIDENCE_MISSING');
    expect(v.detail).toContain('hand-out instant');
  });

  it('takes the repo root from state.options.projectRoot when none is injected', () => {
    const p = ports();
    const v = evaluateReportVerifyEvidence(stateOf({ status: 'PASS' }, { options: { projectRoot: REPO } }), {
      evidenceMode: 'deterministic', evidence: { ports: p, nowMs: NOW },
    });
    expect(v.ok).toBe(true);
    expect(p.calls[0]).toEqual(['readFile', `${REPO}/${RESULT_FILE_RELPATH}`]);
    expect(p.calls[1]).toEqual(['headSha', REPO]);
  });

  it('does not mutate the state it reads', () => {
    const s = stateOf();
    const before = JSON.stringify(s);
    evaluate(s, ports());
    expect(JSON.stringify(s)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// 2. Vocabulary, reader, loader
// ---------------------------------------------------------------------------

describe('vocabulary and config for the third mode', () => {
  it('lists three modes, frozen, with deterministic last', () => {
    expect(REPORT_VERIFY_EVIDENCE_MODES).toEqual(['ack', 'explicit-pass', 'deterministic']);
    expect(Object.isFrozen(REPORT_VERIFY_EVIDENCE_MODES)).toBe(true);
  });

  it('carries ten codes, the three evidence codes spelled by the decision module', () => {
    expect(Object.values(REPORT_VERIFY_CODES)).toHaveLength(10);
    expect(REPORT_VERIFY_CODES.VERIFY_EVIDENCE_MISSING).toBe(DETERMINISTIC_EVIDENCE_CODES.MISSING);
    expect(REPORT_VERIFY_CODES.VERIFY_EVIDENCE_STALE).toBe(DETERMINISTIC_EVIDENCE_CODES.STALE);
    expect(REPORT_VERIFY_CODES.VERIFY_EVIDENCE_FAILED).toBe(DETERMINISTIC_EVIDENCE_CODES.FAILED);
    expect(Object.isFrozen(REPORT_VERIFY_CODES)).toBe(true);
  });

  it("reads 'deterministic' from a config with no reason, and a cased or unknown spelling as ack with a reason", () => {
    const at = (v) => ({ autopilot: { reportVerifyGate: { evidenceMode: v } } });
    expect(readReportVerifyGateEvidenceMode(at('deterministic'))).toEqual({ evidenceMode: 'deterministic', reason: null });
    expect(readReportVerifyGateEvidenceMode(at('Deterministic'))).toEqual({ evidenceMode: 'ack', reason: 'evidenceMode-unknown:Deterministic' });
    expect(readReportVerifyGateEvidenceMode(at('strict'))).toEqual({ evidenceMode: 'ack', reason: 'evidenceMode-unknown:strict' });
  });

  it("loads 'deterministic' off a plugin-root config file, enforce on, state on", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'artibot-gate-det-cfg-'));
    const previous = process.env.CLAUDE_PLUGIN_ROOT;
    try {
      writeFileSync(path.join(root, 'artibot.config.json'), JSON.stringify({
        autopilot: { reportVerifyGate: { enforce: true, evidenceMode: 'deterministic' } },
      }));
      process.env.CLAUDE_PLUGIN_ROOT = root;
      expect(loadReportVerifyGateConfig()).toEqual({ enforce: true, evidenceMode: 'deterministic', state: 'on', reason: null });
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_PLUGIN_ROOT; else process.env.CLAUDE_PLUGIN_ROOT = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ships 'ack': the checkout's own config does not turn rule 7 on", () => {
    const cfg = loadReportVerifyGateConfig();
    expect(cfg.evidenceMode).toBe('ack');
    expect(cfg.state).toBe('on');
  });
});

// ---------------------------------------------------------------------------
// 3. The two entry points with a real session
// ---------------------------------------------------------------------------

let artifactRoot = '';
beforeAll(() => {
  artifactRoot = mkdtempSync(path.join(os.tmpdir(), 'artibot-report-verify-gate-det-'));
});
afterAll(() => {
  try { rmSync(artifactRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

const sessionsToClean = new Set();
afterEach(async () => {
  for (const id of sessionsToClean) {
    try { await abortAutopilot(id, { graceful: false }); } catch { /* ignore */ }
    try { deleteSessionArtifacts(id); } catch { /* ignore */ }
  }
  sessionsToClean.clear();
});

let counter = 0;
async function sessionAtReport(label, verifyResult = { status: 'PASS' }) {
  counter += 1;
  const r = await startAutopilot({
    task: `report verify gate deterministic ${label}`,
    mode: 'default',
    options: { cpuCount: 2, projectRoot: artifactRoot },
    sessionId: `ap-rvg-det-${label}-${process.pid}-${Date.now()}-${counter}`,
  });
  sessionsToClean.add(r.sessionId);
  return { ...loadSession(r.sessionId), attemptJournal: [...JOURNAL], activePhaseAttempt: null, verifyResult, phase: 'REPORT' };
}
const config = (p) => ({ enforce: true, evidenceMode: 'deterministic', evidence: { ports: p, repoRoot: REPO, nowMs: NOW } });

describe("the gate under evidenceMode 'deterministic'", () => {
  it('engine path: pauses with VERIFY_EVIDENCE_MISSING, the Korean hint and the 근거 detail when no snapshot exists', async () => {
    const state = await sessionAtReport('missing');

    const result = gateReportOnVerify(state, config(ports({ text: null })));

    expect(result).toMatchObject({
      type: 'pause', code: 'VERIFY_EVIDENCE_MISSING', attemptId: 'v1',
      reason: 'report-verify-evidence-missing:VERIFY_EVIDENCE_MISSING',
    });
    const text = result.instructions.join('\n');
    expect(text).toContain("evidenceMode 'deterministic'");
    expect(text).toContain(`근거: ${REASONS.absent}`);
    expect(state).toMatchObject({ phase: 'PAUSED', lastPhase: 'REPORT', pendingPhase: 'VERIFY' });
    const pauses = readEvents(state.sessionId).filter((e) => e.type === 'pause');
    expect(pauses).toHaveLength(1);
    expect(pauses[0].data).toMatchObject({ code: 'VERIFY_EVIDENCE_MISSING', detail: REASONS.absent });
    expect(typeof pauses[0].data.hint).toBe('string');
  });

  it('engine path: lets a fresh same-sha pass through and the gate tick names the run', async () => {
    const state = await sessionAtReport('pass');

    expect(gateReportOnVerify(state, config(ports()))).toBeNull();

    expect(state.phase).toBe('REPORT');
    const ticks = readEvents(state.sessionId).filter((e) => e.type === 'report-verify-gate');
    expect(ticks).toHaveLength(1);
    expect(ticks[0].data).toMatchObject({ code: 'ok', attemptId: 'v1', enforced: true });
    expect(ticks[0].data.detail).toContain('vitest result fresh');
  });

  it('engine path: an empty result slot is still VERIFY_RESULT_UNMEASURED, before any evidence is read', async () => {
    const state = await sessionAtReport('unmeasured', null);
    const result = gateReportOnVerify(state, config(THROWING));
    expect(result).toMatchObject({ type: 'pause', code: 'VERIFY_RESULT_UNMEASURED' });
    expect(result.instructions.join('\n')).not.toContain('근거:');
  });

  it('driver path: refuses the REPORT and pauses with the same code and detail', async () => {
    const state = await sessionAtReport('driver-stale');

    const refused = refuseRecordedReport(state, { status: 'done' }, config(ports({ text: snapshot({ gitSha: OTHER }) })), PHASES);

    expect(refused).toBe(true);
    expect(state).toMatchObject({ phase: 'PAUSED', pendingPhase: 'VERIFY', pausedReason: 'report-verify-evidence-missing:VERIFY_EVIDENCE_STALE' });
    const pauses = readEvents(state.sessionId).filter((e) => e.type === 'pause');
    expect(pauses).toHaveLength(1);
    expect(pauses[0].data).toMatchObject({ code: 'VERIFY_EVIDENCE_STALE', claimedStatus: 'done' });
    expect(pauses[0].data.detail).toContain('did not cover this checkout');
  });

  it('driver path: a fresh pass is let through with a gate tick that names the run', async () => {
    const state = await sessionAtReport('driver-pass');
    expect(refuseRecordedReport(state, { status: 'done' }, config(ports()), PHASES)).toBe(false);
    const ticks = readEvents(state.sessionId).filter((e) => e.type === 'report-verify-gate');
    expect(ticks).toHaveLength(1);
    expect(ticks[0].data).toMatchObject({ code: 'ok', via: 'recordPhaseResult' });
    expect(ticks[0].data.detail).toContain('vitest result fresh');
  });
});

// ---------------------------------------------------------------------------
// 4. The default ports
// ---------------------------------------------------------------------------

describe('rule 7 with nothing injected — the real reads', () => {
  it('reads the snapshot under the project root and asks git; a root that is no repository is MISSING, naming HEAD', async () => {
    const state = await sessionAtReport('default-ports');
    const file = path.join(artifactRoot, ...RESULT_FILE_RELPATH.split('/'));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, snapshot(), 'utf8');
    // Keep git from walking up into whatever repository the temp dir may sit under.
    const previous = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = path.dirname(artifactRoot);
    try {
      const result = gateReportOnVerify(state, { enforce: true, evidenceMode: 'deterministic' });
      expect(result).toMatchObject({ type: 'pause', code: 'VERIFY_EVIDENCE_MISSING' });
      expect(result.instructions.join('\n')).toContain('HEAD');
    } finally {
      if (previous === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = previous;
    }
  });

  it('with no snapshot under the project root the default read is MISSING before git is ever asked', async () => {
    const state = await sessionAtReport('default-absent');
    const result = gateReportOnVerify(state, { enforce: true, evidenceMode: 'deterministic', evidence: { repoRoot: path.join(artifactRoot, 'nowhere') } });
    expect(result).toMatchObject({ type: 'pause', code: 'VERIFY_EVIDENCE_MISSING' });
    expect(result.instructions.join('\n')).toContain(REASONS.absent);
  });
});
