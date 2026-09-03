import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readSpawns, spawnLedgerPath } from '../../lib/learning/ledger/spawn-ledger.js';
import { ledgerFilePath } from '../../lib/runtime/ledger.js';
import { getActionClassForAgent } from '../../lib/routing/action-classifier.js';
import { loadConfig } from '../../lib/core/config.js';
import { resolveModel } from '../../lib/core/model-policy.js';

/**
 * T-31 — the v5 routing columns the SubagentStart hook adds to the spawn
 * ledger, and the single `route.selected` line it appends to the central run
 * ledger beside them.
 *
 * Every assertion runs the hook as a CHILD PROCESS against a temporary git
 * repo, because the two properties under test are both on-disk facts: which
 * columns land in `.artibot/ledger/spawns.ndjson`, and whether a receipt line
 * lands in `.artibot/runtime/ledger.jsonl`. No test here touches the
 * developer's own `.artibot/` tree — HOME and `cwd` both point into a temp dir.
 *
 * WHAT THIS FILE DOES NOT PROVE (rules §9 — write the gate's blind spots next
 * to the gate):
 *   - That Claude Code's LIVE SubagentStart payload carries `tool_input.prompt`
 *     (or any of the other text keys `extractActionText` reads). Every payload
 *     here is hand-written to the documented shape. If the live payload names
 *     none of them, production records `route_ledger: 'skipped:no-action-text'`
 *     on every spawn and the run ledger stays empty — a green run of this file
 *     says nothing about that.
 *   - That the recommendation is any GOOD. `route-scorer` is uncalibrated in
 *     Phase 0; these tests assert the receipt is well-formed and recorded, not
 *     that `models.recommended` is the right tier.
 *   - Hook LATENCY. Five new module imports were added to a per-spawn process;
 *     the cost is unmeasured.
 */

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK = path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'subagent-handler.js');

/** Keys every pre-T-31 start record carried. The snapshot must stay a superset. */
const LEGACY_START_KEYS = Object.freeze([
  'ts', 'sessionId', 'agentId', 'agentName', 'agentType',
  'requestedModel', 'canonicalModel', 'modelMismatch', 'event',
]);

/** The six routing columns T-31 adds, plus the ledger-outcome column. */
const ROUTING_KEYS = Object.freeze([
  'recommendedModel', 'actionClass', 'routing_epoch_id', 'depth', 'mission_id', 'route_ledger',
]);

/**
 * Run the hook the way the dispatcher does: fresh node process, JSON on stdin,
 * sub-command as argv. HOME/USERPROFILE point at the sandbox so the state file
 * never lands in the developer's home.
 *
 * @param {object} payload - Hook payload written to stdin
 * @param {string} action - 'start' or 'stop'
 * @param {string} home - Sandbox HOME
 * @returns {{ status: number|null, stdout: string, stderr: string }}
 */
function runHook(payload, action, home) {
  const res = spawnSync(process.execPath, [HOOK, action], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    env: { ...process.env, HOME: home, USERPROFILE: home },
    windowsHide: true,
  });
  return { status: res.status, stdout: String(res.stdout || ''), stderr: String(res.stderr || '') };
}

/** Read the central run ledger's parsed lines; `[]` when the file is absent. */
function readRunLedger(projectRoot) {
  const file = ledgerFilePath(projectRoot);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

describe('subagent-handler v5 routing fields (child process)', () => {
  let tmp;
  let home;
  let repo;

  const basePayload = (over = {}) => ({
    session_id: 'sess-routing-1',
    agent_id: 'agent-route-1',
    agent_type: 'tdd-guide',
    name: 'lane-f',
    cwd: repo,
    tool_input: {
      prompt: 'Implement the ledger byte cap across three modules and add regression tests',
    },
    ...over,
  });

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'artibot-t31-')));
    home = path.join(tmp, 'home');
    repo = path.join(tmp, 'repo');
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore', windowsHide: true });
  });
  afterEach(() => {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  });

  it('start records the six routing columns and keeps every legacy key intact', async () => {
    const r = runHook(basePayload(), 'start', home);
    expect(r.status).toBe(0);

    const [rec] = readSpawns(repo, { sessionId: 'sess-routing-1' });
    expect(rec).toBeDefined();
    for (const key of ROUTING_KEYS) expect(rec).toHaveProperty(key);

    // Legacy keys: present, and carrying exactly what they carried before.
    for (const key of LEGACY_START_KEYS) expect(rec).toHaveProperty(key);
    expect({
      sessionId: rec.sessionId,
      agentId: rec.agentId,
      agentName: rec.agentName,
      agentType: rec.agentType,
      requestedModel: rec.requestedModel,
      canonicalModel: rec.canonicalModel,
      modelMismatch: rec.modelMismatch,
      event: rec.event,
    }).toEqual({
      sessionId: 'sess-routing-1',
      agentId: 'agent-route-1',
      agentName: 'lane-f',
      agentType: 'tdd-guide',
      requestedModel: null,
      canonicalModel: resolveModel('tdd-guide', {}, await loadConfig()),
      modelMismatch: false,
      event: 'start',
    });
  });

  it('routing_epoch_id is the agentId on both the record and the receipt', () => {
    expect(runHook(basePayload(), 'start', home).status).toBe(0);
    const [rec] = readSpawns(repo);
    expect(rec.routing_epoch_id).toBe('agent-route-1');
    expect(rec.routing_epoch_id).toBe(rec.agentId);

    const [line] = readRunLedger(repo);
    expect(line.routing_epoch_id).toBe('agent-route-1');
    expect(line.data.routing_epoch_id).toBe('agent-route-1');
  });

  it('appends exactly one route.selected receipt line to the run ledger', () => {
    expect(runHook(basePayload(), 'start', home).status).toBe(0);
    const lines = readRunLedger(repo);
    expect(lines).toHaveLength(1);
    const [line] = lines;
    expect(line.event).toBe('route.selected');
    // The emitter is a hook and the line says so. A source outside the
    // allowlist is refused and lands as `ledger.rejected` instead, so this
    // assertion doubles as proof that the allowlist admits `hook` — the entry
    // T-15 added on 2026-09-02.
    expect(line.source).toBe('hook');
    expect(line.mission_id).toBe(line.data.mission_id);
    expect(line.session_id).toBe('sess-routing-1');
    expect(line.data.source).toBe('shadow');
    expect(line.data.shadow_of).toBe('spawn:agent-route-1');
    expect(readSpawns(repo)[0].route_ledger).toBe('ok');
  });

  it('the raw ledger line carries the literal bytes "source":"hook"', () => {
    expect(runHook(basePayload(), 'start', home).status).toBe(0);
    const raw = readFileSync(ledgerFilePath(repo), 'utf-8');
    // Byte-level on purpose, one level below the parsed-object assertions: a
    // renamed envelope key or a re-nested source would still satisfy
    // `line.source === 'hook'` on some future shape, and would not satisfy
    // this. It also pins the two `source` fields apart — the receipt's own
    // provenance stays `shadow` on the SAME line.
    expect(raw).toContain('"source":"hook"');
    expect(raw).toContain('"source":"shadow"');
    expect(raw).not.toContain('"source":"scheduler"');
    // And the line is a real route.selected, not a `ledger.rejected` stand-in.
    expect(raw).toContain('"event":"route.selected"');
    expect(raw).not.toContain('ledger.rejected');
  });

  // -------------------------------------------------------------------------
  // action.phase (T-50 §4) — the field must be DERIVED or ABSENT, never
  // invented. Before T-50 the third case below silently recorded 'build'.
  // -------------------------------------------------------------------------

  it('phase comes from the payload role when the role names one', () => {
    // `crosscheck` is a REVIEW_ROLES member, while tdd-guide's action class is
    // `implement` — so a recorded 'review' can ONLY have come from derivePhase,
    // not from the class fallback. Picked precisely to tell the two apart.
    const r = runHook(basePayload({ role: 'crosscheck' }), 'start', home);
    expect(r.status).toBe(0);
    const [line] = readRunLedger(repo);
    expect(line.data.action.phase).toBe('review');
    expect(line.data.action.type).toBe('implement');
    expect(readSpawns(repo)[0].route_ledger).toBe('ok');
  });

  it('phase falls back to the action class when the role names none', () => {
    // agent_type `architect` → class `architecture`, a review-phase action.
    // `derivePhase('architect')` is null, so the class is what decided.
    const r = runHook(basePayload({ agent_type: 'architect' }), 'start', home);
    expect(r.status).toBe(0);
    const [line] = readRunLedger(repo);
    expect(line.data.action.type).toBe('architecture');
    expect(line.data.action.phase).toBe('review');
    expect(readSpawns(repo)[0].route_ledger).toBe('ok');
  });

  it('phase stays unrecorded, not invented, when nothing evidences either', () => {
    // Unknown agent + text matching no keyword => the classifier reports
    // `source: 'default'`, i.e. NOTHING identified the action. Its `implement`
    // is a fallback, not an observation, so no phase may be written.
    const r = runHook(
      basePayload({ agent_type: 'zzz-unknown-agent', tool_input: { prompt: 'aaa bbb ccc' } }),
      'start',
      home,
    );
    expect(r.status).toBe(0);

    // No receipt line at all — and specifically no `ledger.rejected` either,
    // because the gap is caught before the append is attempted.
    expect(existsSync(ledgerFilePath(repo))).toBe(false);

    // The spawn record is still written; only the receipt was withheld.
    const [rec] = readSpawns(repo);
    expect(rec.route_ledger).toBe('skipped:no-phase');
    expect(rec.agentId).toBe('agent-route-1');
    expect(rec.actionClass).toBe('implement');
    expect(rec.recommendedModel).not.toBeNull();
    expect(rec.routing_epoch_id).toBe('agent-route-1');
  });

  it('records the recommended MODEL ID and the observed action class', () => {
    expect(runHook(basePayload(), 'start', home).status).toBe(0);
    const [rec] = readSpawns(repo);
    const [line] = readRunLedger(repo);
    expect(rec.recommendedModel).toBe(line.data.models.recommended.model_id);
    // A model id, not a tier — canonicalModel is the tier, and the two columns
    // are deliberately different vocabularies.
    expect(rec.recommendedModel).toMatch(/^claude-/);
    expect(rec.actionClass).toBe(line.data.action.type);
    expect(rec.actionClass).toBe(getActionClassForAgent('tdd-guide'));
    // tdd-guide is an `implement` agent and the payload names no phase role,
    // so the class decides: a build-phase action.
    expect(line.data.action.phase).toBe('build');
  });

  it('mission_id falls back to the session form and matches the envelope', () => {
    expect(runHook(basePayload(), 'start', home).status).toBe(0);
    const [rec] = readSpawns(repo);
    const [line] = readRunLedger(repo);
    expect(rec.mission_id).toMatch(/^M-\d{8}-S[0-9A-Za-z]{8}$/);
    expect(rec.mission_id).toBe(line.mission_id);
  });

  it('carries task_id onto the record, the envelope and the receipt', () => {
    expect(runHook(basePayload({ task_id: 'T-31' }), 'start', home).status).toBe(0);
    const [rec] = readSpawns(repo);
    const [line] = readRunLedger(repo);
    expect(rec.task_id).toBe('T-31');
    expect(line.task_id).toBe('T-31');
    expect(line.data.task_id).toBe('T-31');
  });

  it('omits task_id entirely when the payload names none', () => {
    expect(runHook(basePayload(), 'start', home).status).toBe(0);
    expect(readSpawns(repo)[0]).not.toHaveProperty('task_id');
    expect(readRunLedger(repo)[0]).not.toHaveProperty('task_id');
  });

  it('depth is an explicit null when the payload names none, and kept when it does', () => {
    expect(runHook(basePayload(), 'start', home).status).toBe(0);
    const [rec] = readSpawns(repo);
    expect(rec).toHaveProperty('depth');
    expect(rec.depth).toBeNull();

    rmSync(spawnLedgerPath(repo));
    expect(runHook(basePayload({ agent_id: 'agent-route-2', depth: 2 }), 'start', home).status).toBe(0);
    expect(readSpawns(repo)[0].depth).toBe(2);
  });

  it('never attempts an append without an epoch: no session id => no ledger at all', () => {
    const r = runHook(basePayload({ session_id: undefined }), 'start', home);
    expect(r.status).toBe(0);
    // No session id => no mission id => the append is not attempted, so not
    // even a `ledger.rejected` line exists.
    expect(existsSync(ledgerFilePath(repo))).toBe(false);
    expect(readSpawns(repo)[0].route_ledger).toBe('skipped:no-session');
  });

  it('skips the append (no rejected line) when the payload carries no action text', () => {
    const r = runHook(basePayload({ tool_input: {} }), 'start', home);
    expect(r.status).toBe(0);
    expect(existsSync(ledgerFilePath(repo))).toBe(false);
    const [rec] = readSpawns(repo);
    expect(rec.route_ledger).toBe('skipped:no-action-text');
    // The routing columns still exist; only the ledger write was skipped.
    for (const key of ROUTING_KEYS) expect(rec).toHaveProperty(key);
    expect(rec.recommendedModel).toBeNull();
    expect(rec.actionClass).toBe(getActionClassForAgent('tdd-guide'));
  });

  it('an unwritable run ledger leaves stdout byte-identical and the spawn record intact', () => {
    // Baseline: the same payload with the run ledger writable.
    const ok = runHook(basePayload(), 'start', home);
    expect(ok.status).toBe(0);
    expect(readSpawns(repo)[0].route_ledger).toBe('ok');

    // Now block ONLY `.artibot/runtime` (a file where the directory must go).
    // `.artibot/ledger` stays writable, so the spawn record must still land.
    const repo2 = path.join(tmp, 'repo2');
    mkdirSync(path.join(repo2, '.artibot'), { recursive: true });
    execFileSync('git', ['init'], { cwd: repo2, stdio: 'ignore', windowsHide: true });
    writeFileSync(path.join(repo2, '.artibot', 'runtime'), 'not a dir', 'utf-8');

    const blocked = runHook({ ...basePayload(), cwd: repo2 }, 'start', home);
    expect(blocked.status).toBe(0);
    // Byte-for-byte identical stdout: the routing observer is invisible to the
    // hook's contract whether it succeeds or fails.
    expect(blocked.stdout).toBe(ok.stdout);
    expect(Object.keys(JSON.parse(blocked.stdout.trim()))).toEqual(['message']);

    const [rec] = readSpawns(repo2);
    expect(rec.agentId).toBe('agent-route-1');
    expect(rec.route_ledger.startsWith('skipped:')).toBe(true);
    expect(rec.route_ledger).not.toBe('ok');
    expect(rec.recommendedModel).not.toBeNull();
  });

  it('stdout is the pre-T-31 literal on start and on stop', () => {
    const start = runHook(basePayload(), 'start', home);
    expect(start.stdout.trim()).toBe(
      JSON.stringify({ message: '[team] Agent registered: agent-route-1 (tdd-guide)' }),
    );
    const stop = runHook(basePayload(), 'stop', home);
    expect(stop.stdout.trim()).toBe(
      JSON.stringify({ message: '[team] Agent deregistered: agent-route-1' }),
    );
  });

  it('stop carries the routing columns from state and writes no second receipt', () => {
    expect(runHook(basePayload(), 'start', home).status).toBe(0);
    const started = readSpawns(repo)[0];
    expect(runHook(basePayload(), 'stop', home).status).toBe(0);

    const recs = readSpawns(repo);
    expect(recs.map((x) => x.event)).toEqual(['start', 'stop']);
    const stop = recs[1];
    expect(stop.routing_epoch_id).toBe('agent-route-1');
    expect(stop.recommendedModel).toBe(started.recommendedModel);
    expect(stop.actionClass).toBe(started.actionClass);
    expect(stop.mission_id).toBe(started.mission_id);
    // One epoch, one routing decision: stop appends no route.selected line.
    expect(readRunLedger(repo)).toHaveLength(1);
    expect(stop).not.toHaveProperty('route_ledger');
  });

  it('the real spawn model decision is untouched: canonicalModel === receipt models.selected', async () => {
    expect(runHook(basePayload(), 'start', home).status).toBe(0);
    const [rec] = readSpawns(repo);
    const [line] = readRunLedger(repo);
    const expected = resolveModel('tdd-guide', {}, await loadConfig());
    expect(rec.canonicalModel).toBe(expected);
    expect(line.data.models.selected.tier).toBe(expected);
  });
});
