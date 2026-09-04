/**
 * `scripts/hooks/route-observe-pre.js` — the PreToolUse(Agent) shadow receipt.
 *
 * Two layers, deliberately kept apart:
 *   - the pure extraction/classification helpers, imported directly;
 *   - the hook as the host runs it, spawned as a CHILD PROCESS with JSON on
 *     stdin, because what is under test there is an ON-DISK fact (a line in
 *     `.artibot/runtime/ledger.jsonl`) plus two process-level guarantees
 *     (empty stdout, exit 0) that an in-process call cannot observe.
 *
 * EVERY PAYLOAD HERE IS SHAPED BY THE FROZEN FIXTURE
 * `tests/hooks/fixtures/host-payloads/PreToolUse.Agent.json` — key names from
 * a live host (2.1.260), values synthesized here. The fixture is read at the
 * top of this file and asserted against, so a re-probe that changes the host
 * contract turns this suite red instead of leaving it testing a payload shape
 * the host stopped sending.
 *
 * WHAT THIS FILE DOES NOT PROVE (rules §9):
 *   - THAT THE HOST FIRES PreToolUse FOR THE Agent TOOL IN PRODUCTION. That is
 *     the D0 probe's measurement (6/6 rows, 3 scenarios, host 2.1.260) and the
 *     D2 live burn's; a green run here says nothing about registration.
 *   - THAT THE RECOMMENDATION IS ANY GOOD. `route-scorer` is uncalibrated in
 *     Phase 0. These assert a receipt is well-formed and recorded.
 *   - LATENCY. A new node process now runs before every Agent spawn; its cost
 *     is unmeasured.
 *   - THE `model` KEY. No probe scenario passed a model argument, so whether
 *     the host forwards one is unmeasured; the hook reads it defensively and
 *     nothing here can confirm it ever arrives.
 *
 * @module tests/hooks/route-observe-pre
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ledgerFilePath } from '../../lib/runtime/ledger.js';
import {
  AGENT_TOOL,
  buildReceipt,
  extractActionText,
  receiptKey,
  receiptPhase,
  resolveMissionId,
  TOOL_INPUT_KEYS,
} from '../../scripts/hooks/route-observe-pre.js';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK = path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'route-observe-pre.js');
const FIXTURE = JSON.parse(readFileSync(
  path.join(PLUGIN_ROOT, 'tests', 'hooks', 'fixtures', 'host-payloads', 'PreToolUse.Agent.json'),
  'utf-8',
));

/** Run the hook exactly as the host does: fresh process, JSON on stdin. */
function runHook(payload, home, { raw = null } = {}) {
  const res = spawnSync(process.execPath, [HOOK], {
    input: raw === null ? JSON.stringify(payload) : raw,
    encoding: 'utf-8',
    env: { ...process.env, HOME: home, USERPROFILE: home },
    windowsHide: true,
  });
  return { status: res.status, stdout: String(res.stdout ?? ''), stderr: String(res.stderr ?? '') };
}

/** Parsed ledger lines, `[]` when the file was never created. */
function readRunLedger(projectRoot) {
  const file = ledgerFilePath(projectRoot);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

describe('route-observe-pre — the fixture is the contract', () => {
  it('reads the frozen host fixture, and the keys this hook consumes are in it', () => {
    // Self-check first: an unreadable fixture would make every assertion below
    // vacuous rather than red.
    expect(FIXTURE.verdict).toBe('D1-go');
    expect(FIXTURE.PreToolUse.tool_name).toBe(AGENT_TOOL);

    // The three keys the design declares REQUIRED for D1 are present on every
    // live row; `name` is conditional and `model` was never observed.
    for (const key of FIXTURE.required_keys_for_D1) {
      expect(FIXTURE.PreToolUse.tool_input_keys_always, key).toContain(key);
    }
    expect(FIXTURE.PreToolUse.tool_input_keys_union).toContain('name');
    expect(FIXTURE.PreToolUse.tool_input_keys_conditional.model).toMatch(/NOT OBSERVED/);

    // The hook's read allowlist must not exceed what the host is known to send
    // plus the one defensively-read key. A key here that the host never sends
    // is dead code posing as a source.
    const known = new Set([...FIXTURE.PreToolUse.tool_input_keys_union, 'model']);
    for (const key of TOOL_INPUT_KEYS) expect(known, key).toContain(key);

    // The correlation tiers this hook records only exist because the host
    // supplies them.
    expect(FIXTURE.PreToolUse.top_level_keys).toContain('prompt_id');
    expect(FIXTURE.PreToolUse.top_level_keys).toContain('tool_use_id');
    expect(FIXTURE.SubagentStart.top_level_keys).toContain('prompt_id');
    expect(FIXTURE.SubagentStart.top_level_keys).not.toContain('tool_use_id');
  });
});

describe('route-observe-pre — extraction rules (§1.3)', () => {
  it('prefers description over prompt', () => {
    expect(extractActionText({ description: 'short intent', prompt: 'x'.repeat(50) }))
      .toBe('short intent');
  });

  it('falls back to a truncated prompt when there is no description', () => {
    const text = extractActionText({ prompt: 'p'.repeat(5000) });
    expect(text).toHaveLength(2000);
  });

  it('treats blank strings as absent rather than as text', () => {
    expect(extractActionText({ description: '   ', prompt: 'real prompt' })).toBe('real prompt');
    expect(extractActionText({ description: '', prompt: '  ' })).toBeNull();
    expect(extractActionText({})).toBeNull();
    expect(extractActionText(null)).toBeNull();
  });

  it('ignores non-string values under the text keys', () => {
    expect(extractActionText({ description: { toString: () => 'nope' }, prompt: 42 })).toBeNull();
  });

  it('encodes the correlation key so the reader can verify the id it carries', () => {
    expect(receiptKey('toolu_1', 'pid-a', 'artibot:tdd-guide'))
      .toBe('route.pre:toolu_1:pid-a:artibot:tdd-guide');
    // Both payload segments may be empty; the SHAPE is constant so the reader
    // can parse positionally.
    expect(receiptKey('toolu_1', null, null)).toBe('route.pre:toolu_1::');
  });
});

describe('route-observe-pre — phase is derived or absent, never invented', () => {
  it('review-class actions are review-phase', () => {
    expect(receiptPhase({ actionClass: 'review', factors: { source: 'agent' } })).toBe('review');
    expect(receiptPhase({ actionClass: 'architecture', factors: { source: 'agent' } })).toBe('review');
  });

  it('an identified non-review action is build-phase', () => {
    expect(receiptPhase({ actionClass: 'implement', factors: { source: 'agent' } })).toBe('build');
  });

  it('an UNidentified action has no phase — the fallback class is not evidence', () => {
    // `source: 'default'` is the classifier reporting that nothing matched.
    expect(receiptPhase({ actionClass: 'implement', factors: { source: 'default' } })).toBeNull();
    expect(buildReceipt({
      toolUseId: 'toolu_x', sessionId: 's', missionId: 'M-20260904-Sabcdefgh',
      agentType: 'zzz-unknown-agent', text: 'aaa bbb ccc', config: undefined,
    })).toBeNull();
  });

  // The live gap this limb closes. Both spawns below were reaching the hook and
  // producing NOTHING: neither agent was in `AGENT_ACTION_CLASS`, the
  // descriptions carried no keyword, so the classifier answered
  // `source: 'default'` and `receiptPhase` correctly refused to invent a phase.
  // The fix is coverage in the agent table, NOT loosening the rule above — the
  // `zzz-unknown-agent` case keeps asserting the rule still holds.
  it('a bare host built-in with keyword-free text now yields a build receipt', () => {
    const receipt = buildReceipt({
      toolUseId: 'toolu_explore', sessionId: 's', missionId: 'M-20260904-Sabcdefgh',
      agentType: 'Explore', text: 'aaa bbb ccc', config: undefined,
    });
    expect(receipt).not.toBeNull();
    expect(receipt.action.phase).toBe('build');
    expect(receipt.action.type).toBe('explore');
  });

  it('a prefixed roster agent with keyword-free text now yields a build receipt', () => {
    const receipt = buildReceipt({
      toolUseId: 'toolu_inv', sessionId: 's', missionId: 'M-20260904-Sabcdefgh',
      agentType: 'artibot:investigator', text: 'Spawn probe', config: undefined,
    });
    expect(receipt).not.toBeNull();
    expect(receipt.action.phase).toBe('build');
    expect(receipt.action.type).toBe('explore');
  });
});

describe('route-observe-pre — mission id', () => {
  it('takes a valid payload mission id verbatim', () => {
    expect(resolveMissionId({ mission_id: 'M-20260904-Sabcdefgh' }, 'sess')).toBe('M-20260904-Sabcdefgh');
  });

  it('falls back to the session form, and is null without a session', () => {
    expect(resolveMissionId({}, 'sess-pre-1')).toMatch(/^M-\d{8}-S[0-9A-Za-z]{8}$/);
    expect(resolveMissionId({}, null)).toBeNull();
  });
});

describe('route-observe-pre — the hook as the host runs it (child process)', () => {
  let tmp;
  let home;
  let repo;

  const prePayload = (over = {}) => ({
    // Top-level keys: exactly the ten the live host sends (fixture), values
    // synthesized. `effort` and `permission_mode` are carried unread, on
    // purpose — the hook must not care.
    cwd: repo,
    effort: 'high',
    hook_event_name: 'PreToolUse',
    permission_mode: 'acceptEdits',
    prompt_id: 'pid-1',
    session_id: 'sess-pre-1',
    tool_name: 'Agent',
    tool_use_id: 'toolu_pre_1',
    transcript_path: path.join(tmp, 'transcript.jsonl'),
    ...over,
    tool_input: {
      description: 'Implement the ledger byte cap across three modules and add regression tests',
      prompt: 'A much longer prompt body that the classifier would otherwise score',
      run_in_background: true,
      subagent_type: 'artibot:tdd-guide',
      name: 'lane-f',
      ...(over.tool_input ?? {}),
    },
  });

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'artibot-l2d1-pre-')));
    home = path.join(tmp, 'home');
    repo = path.join(tmp, 'repo');
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore', windowsHide: true });
  });
  afterEach(() => {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  });

  it('writes exactly one route.selected receipt, and writes nothing to stdout', () => {
    const r = runHook(prePayload(), home);
    expect(r.status).toBe(0);
    expect(Buffer.byteLength(r.stdout, 'utf8')).toBe(0);

    const lines = readRunLedger(repo);
    expect(lines).toHaveLength(1);
    const [line] = lines;
    expect(line.event).toBe('route.selected');
    expect(line.source).toBe('hook');
    expect(line.data.source).toBe('shadow');
    // NOT `ledger.rejected` — the receipt satisfies route-receipt.schema.json.
    expect(line.data.schema_version).toBe(1);
  });

  it('uses the tool_use_id as the temporary epoch, on the envelope and inside the receipt', () => {
    expect(runHook(prePayload(), home).status).toBe(0);
    const [line] = readRunLedger(repo);
    expect(line.routing_epoch_id).toBe('toolu_pre_1');
    expect(line.data.routing_epoch_id).toBe('toolu_pre_1');
    expect(line.action_id).toBe('toolu_pre_1');
    // The pairing pointer names the tool call, not a spawn: at PreToolUse
    // there is no agent_id in existence yet.
    expect(line.data.shadow_of).toBe('tool_use:toolu_pre_1');
  });

  it('carries the two correlation tiers the bind side needs', () => {
    expect(runHook(prePayload(), home).status).toBe(0);
    const [line] = readRunLedger(repo);
    expect(line.idempotency_key).toBe(receiptKey('toolu_pre_1', 'pid-1', 'artibot:tdd-guide'));
    expect(line.worker).toBe('lane-f');
  });

  it('omits the name tier for an unnamed spawn instead of writing an empty one', () => {
    // Scenarios a and c of the frozen fixture: `name` absent from tool_input.
    const payload = prePayload();
    delete payload.tool_input.name;
    expect(runHook(payload, home).status).toBe(0);
    const [line] = readRunLedger(repo);
    expect(line).not.toHaveProperty('worker');
    // The subagent_type tier survives: it is the identity host 2.1.260 reports
    // as agent_type for an Agent-tool spawn.
    expect(line.idempotency_key).toBe(receiptKey('toolu_pre_1', 'pid-1', 'artibot:tdd-guide'));
  });

  it('records without prompt_id — the key is optional and the receipt is not', () => {
    const payload = prePayload();
    delete payload.prompt_id;
    expect(runHook(payload, home).status).toBe(0);
    const [line] = readRunLedger(repo);
    // The key is still written — only its prompt_id segment is empty.
    expect(line.idempotency_key).toBe(receiptKey('toolu_pre_1', null, 'artibot:tdd-guide'));
    expect(line.worker).toBe('lane-f');
  });

  it('classifies from subagent_type with the artibot: prefix stripped', () => {
    expect(runHook(prePayload(), home).status).toBe(0);
    const [line] = readRunLedger(repo);
    // tdd-guide is an `implement` agent; the prefix must not defeat the lookup.
    expect(line.data.action.type).toBe('implement');
    expect(line.data.action.phase).toBe('build');
    expect(line.data.models.recommended.model_id).toMatch(/^claude-/);
    expect(line.data.reason).toContain('class:agent');
  });

  it('scores an architecture agent as a review-phase action', () => {
    const payload = prePayload({ tool_input: { subagent_type: 'artibot:architect' } });
    expect(runHook(payload, home).status).toBe(0);
    const [line] = readRunLedger(repo);
    expect(line.data.action.type).toBe('architecture');
    expect(line.data.action.phase).toBe('review');
  });

  it('never writes the action text itself into the ledger', () => {
    const secret = 'SENTINEL-PROMPT-TEXT-DO-NOT-PERSIST';
    const payload = prePayload({ tool_input: { description: `${secret} implement tests` } });
    expect(runHook(payload, home).status).toBe(0);
    const raw = readFileSync(ledgerFilePath(repo), 'utf-8');
    // The receipt schema has no field for text and none is smuggled in: the
    // ledger carries the CLASSIFICATION, never the prompt.
    expect(raw).not.toContain(secret);
  });

  it('two Agent calls in one prompt leave two independent receipts', () => {
    expect(runHook(prePayload(), home).status).toBe(0);
    expect(runHook(prePayload({ tool_use_id: 'toolu_pre_2' }), home).status).toBe(0);
    const lines = readRunLedger(repo);
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.routing_epoch_id)).toEqual(['toolu_pre_1', 'toolu_pre_2']);
    // Same prompt: the 1st-tier key is shared, which is exactly what makes it
    // a partition and not a selector.
    expect(new Set(lines.map((l) => l.idempotency_key.split(':')[2])).size).toBe(1);
  });
});
