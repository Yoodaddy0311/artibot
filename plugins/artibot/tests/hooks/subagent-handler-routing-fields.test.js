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
 * ledger, and the `route.bound` line it appends to the central run ledger
 * beside them.
 *
 * WHAT CHANGED, AND WHY THIS FILE LOOKS DIFFERENT FROM ITS PREVIOUS FORM. The
 * hook used to BUILD a shadow RouteReceipt here from `tool_input.prompt`. The
 * live SubagentStart payload has no such key — no `prompt`, no `description`,
 * no `tool_input` under any spelling (2.1.259 binary schema table; re-measured
 * live on host 2.1.260, whose SubagentStart top-level key set is exactly
 * agent_id / agent_type / cwd / hook_event_name / prompt_id / session_id /
 * transcript_path, `tests/hooks/fixtures/host-payloads/PreToolUse.Agent.json`).
 * The old tests passed because their `basePayload` hand-wrote a key the host
 * does not send: a fixture that made a dead path look alive, while production
 * recorded `skipped:no-action-text` on 71/71 spawns.
 *
 * So the receipt is now written by `scripts/hooks/route-observe-pre.js` at
 * PreToolUse, where the text exists, and this hook writes the JOIN. Every
 * payload below is restricted to the measured key set, and any test that needs
 * a receipt CREATES ONE by running the real PreToolUse hook first.
 *
 * Every assertion runs the hooks as CHILD PROCESSES against a temporary git
 * repo, because the properties under test are on-disk facts: which columns
 * land in `.artibot/ledger/spawns.ndjson`, and which lines land in
 * `.artibot/runtime/ledger.jsonl`. HOME and `cwd` both point into a temp dir,
 * so no test here touches the developer's own `.artibot/` tree.
 *
 * WHAT THIS FILE DOES NOT PROVE (rules §9 — write the gate's blind spots next
 * to the gate):
 *   - THAT THE HOST EMITS SubagentStart IN tool_use ORDER. The 3rd correlation
 *     tier (FIFO) assumes it for unnamed parallel spawns. The D0 probe saw the
 *     relative order agree in 3/3 scenarios but never verified sibling order by
 *     content, so it stays UNMEASURED — which is exactly why an unnamed bind
 *     records `confidence: 'fifo'` instead of claiming certainty.
 *   - THAT THE BIND IS RIGHT IN PRODUCTION. These tests choose the receipts;
 *     live, the host does. `confidence`/`method` are what make a wrong bind
 *     countable after the fact.
 *   - THAT THE RECOMMENDATION IS ANY GOOD. `route-scorer` is uncalibrated in
 *     Phase 0.
 *   - HOOK LATENCY. Two processes now run per spawn (pre + start). Unmeasured.
 */

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK = path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'subagent-handler.js');
const PRE_HOOK = path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'route-observe-pre.js');

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
 * Run a hook the way the dispatcher does: fresh node process, JSON on stdin,
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

/** Run the real PreToolUse hook, so the receipt under test is a real receipt. */
function runPre(payload, home) {
  const res = spawnSync(process.execPath, [PRE_HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    env: { ...process.env, HOME: home, USERPROFILE: home },
    windowsHide: true,
  });
  return { status: res.status, stdout: String(res.stdout || '') };
}

/** Read the central run ledger's parsed lines; `[]` when the file is absent. */
function readRunLedger(projectRoot) {
  const file = ledgerFilePath(projectRoot);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

const eventsOf = (projectRoot) => readRunLedger(projectRoot).map((l) => l.event);
const boundLine = (projectRoot) => readRunLedger(projectRoot).find((l) => l.event === 'route.bound');
const receiptLine = (projectRoot) => readRunLedger(projectRoot).find((l) => l.event === 'route.selected');

describe('subagent-handler v5 routing fields (child process)', () => {
  let tmp;
  let home;
  let repo;

  /**
   * A SubagentStart payload with EXACTLY the keys host 2.1.260 sends. No
   * `name`, no `tool_input` — writing those back in is what hid the defect
   * this design fixes.
   */
  const basePayload = (over = {}) => ({
    session_id: 'sess-routing-1',
    agent_id: 'agent-route-1',
    agent_type: 'tdd-guide',
    hook_event_name: 'SubagentStart',
    prompt_id: 'pid-routing-1',
    cwd: repo,
    ...over,
  });

  /** The matching PreToolUse payload — the receipt half of the pair. */
  const prePayload = (over = {}) => ({
    cwd: repo,
    hook_event_name: 'PreToolUse',
    prompt_id: 'pid-routing-1',
    session_id: 'sess-routing-1',
    tool_name: 'Agent',
    tool_use_id: 'toolu_route_1',
    ...over,
    tool_input: {
      description: 'Implement the ledger byte cap across three modules and add regression tests',
      prompt: 'the full prompt body',
      run_in_background: true,
      subagent_type: 'tdd-guide',
      // Named spawn: the host reports agent_type === this name on the matching
      // SubagentStart, which is the 2nd correlation tier.
      name: 'tdd-guide',
      ...(over.tool_input ?? {}),
    },
  });

  /** The happy path both hooks together: receipt then bind. */
  function spawnPair(preOver = {}, startOver = {}) {
    expect(runPre(prePayload(preOver), home).status).toBe(0);
    const r = runHook(basePayload(startOver), 'start', home);
    expect(r.status).toBe(0);
    return r;
  }

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

  // -------------------------------------------------------------------------
  // The spawn record's columns
  // -------------------------------------------------------------------------

  it('start records the six routing columns and keeps every legacy key intact', async () => {
    spawnPair();

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
      // NULL, not a name: the live SubagentStart payload carries no `name` key,
      // and the old fixture's 'lane-f' came from a key the host never sends.
      agentName: null,
      agentType: 'tdd-guide',
      requestedModel: null,
      canonicalModel: resolveModel('tdd-guide', {}, await loadConfig()),
      modelMismatch: false,
      event: 'start',
    });
  });

  it('routing_epoch_id is the agentId on the record and on the bind envelope', () => {
    spawnPair();
    const [rec] = readSpawns(repo);
    expect(rec.routing_epoch_id).toBe('agent-route-1');
    expect(rec.routing_epoch_id).toBe(rec.agentId);

    // G1: the epoch is the SPAWN. The receipt's tool_use_id was a temporary
    // stand-in and is preserved inside `data`, not promoted to the envelope.
    const bound = boundLine(repo);
    expect(bound.routing_epoch_id).toBe('agent-route-1');
    expect(bound.run_id).toBe('agent-route-1');
    expect(bound.data.agent_id).toBe('agent-route-1');
    expect(bound.data.tool_use_id).toBe('toolu_route_1');
    expect(bound.action_id).toBe('toolu_route_1');
  });

  // -------------------------------------------------------------------------
  // The join
  // -------------------------------------------------------------------------

  it('appends exactly one route.bound line beside the receipt', () => {
    spawnPair();
    expect(eventsOf(repo)).toEqual(['route.selected', 'route.bound']);
    const bound = boundLine(repo);
    // The emitter is a hook and the line says so. A source outside the
    // allowlist is refused and lands as `ledger.rejected` instead, so this
    // doubles as proof that the allowlist admits `hook` for the NEW event.
    expect(bound.source).toBe('hook');
    expect(bound.session_id).toBe('sess-routing-1');
    expect(bound.mission_id).toBe(receiptLine(repo).mission_id);
    expect(readSpawns(repo)[0].route_ledger).toBe('ok:bound');
  });

  it('the raw bind line carries the literal bytes of its event and source', () => {
    spawnPair();
    const raw = readFileSync(ledgerFilePath(repo), 'utf-8');
    // Byte-level on purpose, one level below the parsed-object assertions: a
    // renamed envelope key or a re-nested source would still satisfy
    // `line.source === 'hook'` on some future shape, and would not satisfy this.
    expect(raw).toContain('"event":"route.bound"');
    expect(raw).toContain('"source":"hook"');
    expect(raw).not.toContain('ledger.rejected');
    // The receipt's own provenance is a DIFFERENT field and stays `shadow` on
    // the other line.
    expect(raw).toContain('"source":"shadow"');
  });

  it('a named spawn inside the same prompt binds with confidence exact', () => {
    spawnPair();
    const { data } = boundLine(repo);
    expect(data.confidence).toBe('exact');
    expect(data.method).toBe('prompt_id+name');
    expect(data.matched_on).toBe('name');
  });

  it('binds on subagent_type when the host reports the TYPE as agent_type', () => {
    // MEASURED, not hypothetical (host 2.1.260, 2026-09-04 D2 burn): an
    // Agent-tool spawn reports `agent_type === subagent_type` even when the
    // caller passed a `name`. Design §2.1 assumed the name; on this path the
    // name never reaches SubagentStart, so a name-only tier would never fire
    // and every Agent spawn would degrade to a FIFO guess.
    expect(runPre(prePayload({
      tool_input: { subagent_type: 'artibot:code-reviewer', name: 'd2probe' },
    }), home).status).toBe(0);
    expect(runHook(basePayload({ agent_type: 'artibot:code-reviewer' }), 'start', home).status).toBe(0);

    const { data } = boundLine(repo);
    expect(data.confidence).toBe('exact');
    expect(data.matched_on).toBe('subagent_type');
  });

  it('normalizes past the artibot: prefix on both sides of the identity tier', () => {
    expect(runPre(prePayload({
      tool_input: { subagent_type: 'artibot:code-reviewer', name: undefined },
    }), home).status).toBe(0);
    // Host reports the bare form; the receipt carries the prefixed one.
    expect(runHook(basePayload({ agent_type: 'code-reviewer' }), 'start', home).status).toBe(0);
    const { data } = boundLine(repo);
    expect(data.confidence).toBe('exact');
    expect(data.matched_on).toBe('subagent_type');
  });

  it('an UNnamed spawn in the same prompt binds by FIFO and says so', () => {
    const pre = prePayload();
    delete pre.tool_input.name;
    expect(runPre(pre, home).status).toBe(0);
    // Unnamed spawns report agent_type 'teammate' (D0: `a<hex16>` /
    // agent_type "teammate"), which matches no receipt name.
    expect(runHook(basePayload({ agent_type: 'teammate' }), 'start', home).status).toBe(0);

    const { data } = boundLine(repo);
    expect(data.confidence).toBe('fifo');
    expect(data.method).toBe('prompt_id+fifo');
  });

  it('without prompt_id the name tier still decides — and the confidence drops', () => {
    const pre = prePayload();
    delete pre.prompt_id;
    expect(runPre(pre, home).status).toBe(0);
    const start = basePayload();
    delete start.prompt_id;
    expect(runHook(start, 'start', home).status).toBe(0);

    const { data } = boundLine(repo);
    // Deterministic (the name matched) but unscoped (no prompt partition), so
    // it is neither `exact` nor a guess.
    expect(data.confidence).toBe('name');
    expect(data.method).toBe('name-only');
  });

  it('with neither prompt_id nor a name, the bind is a FIFO guess and is labelled one', () => {
    const pre = prePayload();
    delete pre.prompt_id;
    delete pre.tool_input.name;
    expect(runPre(pre, home).status).toBe(0);
    const start = basePayload({ agent_type: 'teammate' });
    delete start.prompt_id;
    expect(runHook(start, 'start', home).status).toBe(0);

    const { data } = boundLine(repo);
    expect(data.confidence).toBe('fifo');
    expect(data.method).toBe('fifo-only');
  });

  it('a prompt_id that matches nothing widens the pool rather than refusing the bind', () => {
    expect(runPre(prePayload({ prompt_id: 'pid-other' }), home).status).toBe(0);
    expect(runHook(basePayload(), 'start', home).status).toBe(0);
    const { data } = boundLine(repo);
    // The name still decides; the confidence records that tier 1 did not fire.
    expect(data.confidence).toBe('name');
    expect(data.method).toBe('name-only');
  });

  it('carries the receipt\'s classification onto the record and the bind row', () => {
    spawnPair();
    const [rec] = readSpawns(repo);
    const receipt = receiptLine(repo);
    const { data } = boundLine(repo);

    expect(rec.recommendedModel).toBe(receipt.data.models.recommended.model_id);
    // A model id, not a tier — canonicalModel is the tier, and the two columns
    // are deliberately different vocabularies.
    expect(rec.recommendedModel).toMatch(/^claude-/);
    expect(rec.actionClass).toBe(receipt.data.action.type);
    expect(rec.actionClass).toBe(getActionClassForAgent('tdd-guide'));
    expect(data.recommended_model).toBe(rec.recommendedModel);
    expect(data.action_class).toBe(rec.actionClass);
    expect(data.agent_type).toBe('tdd-guide');
  });

  it('records the policy model beside the receipt\'s prediction, so the two are comparable', async () => {
    spawnPair();
    const expected = resolveModel('tdd-guide', {}, await loadConfig());
    const [rec] = readSpawns(repo);
    const { data } = boundLine(repo);
    // `selected_model` is the answer for the agent that ACTUALLY spawned;
    // the receipt's `models.selected` was the prediction from subagent_type.
    expect(data.selected_model).toBe(expected);
    expect(rec.canonicalModel).toBe(expected);
    expect(receiptLine(repo).data.models.selected.tier).toBe(expected);
  });

  // -------------------------------------------------------------------------
  // Unbound is a first-class, correct outcome
  // -------------------------------------------------------------------------

  it('a spawn with no receipt records skipped:unbound and writes no bind line', () => {
    // The SDK / scheduler / loop entry points never go through the Agent tool,
    // so this is the normal shape of those spawns — not a defect.
    expect(runHook(basePayload(), 'start', home).status).toBe(0);
    expect(existsSync(ledgerFilePath(repo))).toBe(false);

    const [rec] = readSpawns(repo);
    expect(rec.route_ledger).toBe('skipped:unbound');
    for (const key of ROUTING_KEYS) expect(rec).toHaveProperty(key);
    expect(rec.recommendedModel).toBeNull();
    // The agent-table class is still recorded: it needs no receipt.
    expect(rec.actionClass).toBe(getActionClassForAgent('tdd-guide'));
  });

  it('a PreToolUse that fired but wrote no receipt is indistinguishable from one that never fired', () => {
    // An agent the classifier does not know, with keyword-free text, lands on
    // `factors.source === 'default'`; `receiptPhase` answers null and
    // `observePre` returns `no-receipt` WITHOUT appending anything. The bind
    // side then sees exactly what it sees when the hook never ran. This pins
    // the CURRENT contract (measured 2026-09-05): the ledgers carry nothing
    // that separates the two, so the reason string stays `skipped:unbound`.
    const pre = prePayload({
      tool_input: { subagent_type: 'zzz-unknown-agent', name: 'zzz-unknown-agent', description: 'aaa bbb ccc', prompt: 'ddd eee' },
    });
    expect(runPre(pre, home).status).toBe(0);
    expect(existsSync(ledgerFilePath(repo))).toBe(false);
    expect(runHook(basePayload({ agent_type: 'zzz-unknown-agent' }), 'start', home).status).toBe(0);
    expect(existsSync(ledgerFilePath(repo))).toBe(false);
    expect(readSpawns(repo)[0].route_ledger).toBe('skipped:unbound');
  });

  it('a receipt from a DIFFERENT session is not a candidate', () => {
    expect(runPre(prePayload({ session_id: 'sess-other' }), home).status).toBe(0);
    expect(runHook(basePayload(), 'start', home).status).toBe(0);
    expect(readSpawns(repo)[0].route_ledger).toBe('skipped:unbound');
    expect(eventsOf(repo)).toEqual(['route.selected']);
  });

  it('a legacy SubagentStart-era receipt (shadow_of spawn:) is not bindable', () => {
    // Hand-written because the code that produced this shape is gone. An old
    // ledger must not be re-interpreted under the new scheme.
    const file = ledgerFilePath(repo);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({
      v: 1,
      ts: new Date().toISOString(),
      event: 'route.selected',
      session_id: 'sess-routing-1',
      mission_id: 'M-20260904-Ssessrout',
      source: 'hook',
      pid: 1,
      seq: 0,
      routing_epoch_id: 'agent-old-1',
      data: { shadow_of: 'spawn:agent-old-1', action: { type: 'implement' } },
    })}\n`, 'utf-8');

    expect(runHook(basePayload(), 'start', home).status).toBe(0);
    expect(readSpawns(repo)[0].route_ledger).toBe('skipped:unbound');
    expect(eventsOf(repo)).toEqual(['route.selected']);
  });

  it('never attempts a bind without an epoch: no session id => no ledger at all', () => {
    const r = runHook(basePayload({ session_id: undefined }), 'start', home);
    expect(r.status).toBe(0);
    // No session id => no mission id => the bind is not attempted, so not even
    // a `ledger.rejected` line exists.
    expect(existsSync(ledgerFilePath(repo))).toBe(false);
    expect(readSpawns(repo)[0].route_ledger).toBe('skipped:no-session');
  });

  // -------------------------------------------------------------------------
  // Invariant 1 — one receipt, one spawn (design §2.3)
  // -------------------------------------------------------------------------

  it('one receipt binds ONE spawn: the second spawn is unbound, not a duplicate', () => {
    spawnPair();
    expect(runHook(basePayload({ agent_id: 'agent-route-2' }), 'start', home).status).toBe(0);

    expect(eventsOf(repo)).toEqual(['route.selected', 'route.bound']);
    const recs = readSpawns(repo);
    expect(recs.map((r) => r.route_ledger)).toEqual(['ok:bound', 'skipped:unbound']);
  });

  it('one spawn binds ONCE: a replayed SubagentStart records already-bound', () => {
    spawnPair();
    // Same agent_id twice — a redelivered hook, or a retried spawn.
    expect(runPre(prePayload({ tool_use_id: 'toolu_route_2' }), home).status).toBe(0);
    expect(runHook(basePayload(), 'start', home).status).toBe(0);

    expect(eventsOf(repo).filter((e) => e === 'route.bound')).toHaveLength(1);
    expect(readSpawns(repo).map((r) => r.route_ledger)).toEqual(['ok:bound', 'skipped:already-bound']);
  });

  it('two named spawns in one prompt bind to their OWN receipts', () => {
    expect(runPre(prePayload({
      tool_use_id: 'toolu_a', tool_input: { name: 'tdd-guide', subagent_type: 'tdd-guide' },
    }), home).status).toBe(0);
    expect(runPre(prePayload({
      tool_use_id: 'toolu_b', tool_input: { name: 'architect', subagent_type: 'architect' },
    }), home).status).toBe(0);

    expect(runHook(basePayload({ agent_id: 'a-arch', agent_type: 'architect' }), 'start', home).status).toBe(0);
    expect(runHook(basePayload({ agent_id: 'a-tdd', agent_type: 'tdd-guide' }), 'start', home).status).toBe(0);

    const bounds = readRunLedger(repo).filter((l) => l.event === 'route.bound');
    expect(bounds).toHaveLength(2);
    expect(bounds.map((b) => [b.data.agent_id, b.data.tool_use_id, b.data.confidence])).toEqual([
      ['a-arch', 'toolu_b', 'exact'],
      ['a-tdd', 'toolu_a', 'exact'],
    ]);
  });

  // -------------------------------------------------------------------------
  // Envelope passthrough and the stop side
  // -------------------------------------------------------------------------

  it('carries task_id onto the record and the bind envelope', () => {
    spawnPair({}, { task_id: 'T-31' });
    expect(readSpawns(repo)[0].task_id).toBe('T-31');
    expect(boundLine(repo).task_id).toBe('T-31');
  });

  it('omits task_id entirely when the payload names none', () => {
    spawnPair();
    expect(readSpawns(repo)[0]).not.toHaveProperty('task_id');
    expect(boundLine(repo)).not.toHaveProperty('task_id');
  });

  it('mission_id falls back to the session form and matches the envelope', () => {
    spawnPair();
    const [rec] = readSpawns(repo);
    expect(rec.mission_id).toMatch(/^M-\d{8}-S[0-9A-Za-z]{8}$/);
    expect(rec.mission_id).toBe(boundLine(repo).mission_id);
    // Receipt and bind must agree, or the pair splits across two missions.
    expect(rec.mission_id).toBe(receiptLine(repo).mission_id);
  });

  it('depth is an explicit null when the payload names none, and kept when it does', () => {
    spawnPair();
    const [rec] = readSpawns(repo);
    expect(rec).toHaveProperty('depth');
    expect(rec.depth).toBeNull();

    rmSync(spawnLedgerPath(repo));
    expect(runHook(basePayload({ agent_id: 'agent-route-2', depth: 2 }), 'start', home).status).toBe(0);
    expect(readSpawns(repo)[0].depth).toBe(2);
  });

  it('an unwritable run ledger leaves stdout byte-identical and the spawn record intact', () => {
    // Baseline: the same payload with the run ledger writable.
    spawnPair();
    const ok = runHook(basePayload({ agent_id: 'agent-baseline' }), 'start', home);
    expect(ok.status).toBe(0);

    // Now block ONLY `.artibot/runtime` (a file where the directory must go).
    // `.artibot/ledger` stays writable, so the spawn record must still land.
    const repo2 = path.join(tmp, 'repo2');
    mkdirSync(path.join(repo2, '.artibot'), { recursive: true });
    execFileSync('git', ['init'], { cwd: repo2, stdio: 'ignore', windowsHide: true });
    writeFileSync(path.join(repo2, '.artibot', 'runtime'), 'not a dir', 'utf-8');

    const blocked = runHook({ ...basePayload({ agent_id: 'agent-baseline' }), cwd: repo2 }, 'start', home);
    expect(blocked.status).toBe(0);
    // Byte-for-byte identical stdout: the routing observer is invisible to the
    // hook's contract whether it succeeds or fails.
    expect(blocked.stdout).toBe(ok.stdout);
    expect(Object.keys(JSON.parse(blocked.stdout.trim()))).toEqual(['message']);

    const [rec] = readSpawns(repo2);
    expect(rec.agentId).toBe('agent-baseline');
    expect(rec.route_ledger.startsWith('skipped:')).toBe(true);
    expect(rec.route_ledger).not.toBe('ok:bound');
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

  it('stop carries the routing columns from state and writes no second bind line', () => {
    spawnPair();
    const started = readSpawns(repo)[0];
    expect(runHook(basePayload(), 'stop', home).status).toBe(0);

    const recs = readSpawns(repo);
    expect(recs.map((x) => x.event)).toEqual(['start', 'stop']);
    const stop = recs[1];
    expect(stop.routing_epoch_id).toBe('agent-route-1');
    expect(stop.recommendedModel).toBe(started.recommendedModel);
    expect(stop.actionClass).toBe(started.actionClass);
    expect(stop.mission_id).toBe(started.mission_id);
    // One epoch, one binding: stop appends nothing to the run ledger.
    expect(eventsOf(repo)).toEqual(['route.selected', 'route.bound']);
    expect(stop).not.toHaveProperty('route_ledger');
  });
});
