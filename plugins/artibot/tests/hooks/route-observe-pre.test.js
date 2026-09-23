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
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MODELS } from '../../lib/core/model-catalog.js';

import { ledgerFilePath } from '../../lib/runtime/ledger.js';
import {
  AGENT_TOOL,
  buildReceipt,
  countActionsSinceSwitch,
  extractActionText,
  receiptKey,
  receiptPhase,
  RESIDENCY_TAIL_BYTES,
  resolveIncumbentTier,
  resolveMissionId,
  TOOL_INPUT_KEYS,
  TRANSCRIPT_TAIL_BYTES,
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
    // K1: the incumbent tier is read out of the host transcript, so that key is
    // now a SOURCE this hook consumes and belongs in the same contract check.
    // A host that stops sending it turns this red instead of silently reverting
    // every receipt to `models.current: null`.
    expect(FIXTURE.PreToolUse.top_level_keys).toContain('transcript_path');
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

/** One assistant transcript record, carrying ONLY what the hook may read. */
const assistant = (model) => ({ type: 'assistant', message: { role: 'assistant', model } });

/** A `route.selected` ledger row as this hook writes it, reduced to the keys the counter reads. */
const selectedRow = (sessionId, tier) => ({
  event: 'route.selected',
  session_id: sessionId,
  data: { models: { current: tier === null ? null : { tier, model_id: `id-${tier}` } } },
});

/** A non-assistant record of at least `bytes`, used to push older records out of the window. */
const filler = (bytes) => ({
  type: 'user',
  message: { role: 'user', content: 'x'.repeat(Math.max(1, bytes)) },
});

describe('route-observe-pre — incumbent tier and residency (K1), pure functions', () => {
  let tmp;

  /** Write NDJSON records to a fresh temp transcript and return its path. */
  function writeTranscript(records, name = `t-${records.length}-${Math.random()}.jsonl`) {
    const file = path.join(tmp, name);
    writeFileSync(file, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf-8');
    return file;
  }

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'artibot-k1-pure-')));
  });
  afterEach(() => {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  });

  it('pins the transcript window at 256 KB, twice the ledger default', () => {
    // MEASURED basis (21 transcripts of this project, 2026-09-15): distance
    // from EOF back to the last assistant record was p50 11.8 KB / p90 28.0 KB
    // / max 81.9 KB over the 18 that had one. This value is not free to drift:
    // shrinking it silently un-supplies `models.current` on long tool-result
    // tails, and growing it puts an unbounded read on a BLOCK POINT.
    expect(TRANSCRIPT_TAIL_BYTES).toBe(262144);
  });

  it('pins the residency window at 512 KB, sized against false shortfalls', () => {
    // MEASURED on the live ledger (987,547 B / 1,175 rows, 2026-09-15 02:54Z):
    // the share of rows whose preceding three SAME-SESSION rows all fall inside
    // the window was 69/73 at 128 KB, 73/73 at 256 KB, 73/73 at 512 KB. The
    // 128 KB default would have produced 4/73 FALSE `minimum-residency` holds —
    // a switch blocked by a shortfall that never happened. 256 KB clears the
    // sample with ZERO margin (largest same-session gap: 134,596 B), so the
    // constant is one step above it.
    expect(RESIDENCY_TAIL_BYTES).toBe(524288);
    // The two windows are independent budgets over two different streams, and
    // the ledger's is the larger one: concurrent sessions interleave rows, so
    // reaching three of THIS session's rows costs more than reaching one
    // transcript record.
    expect(RESIDENCY_TAIL_BYTES).toBeGreaterThan(TRANSCRIPT_TAIL_BYTES);
  });

  it('maps a full model id to its tier, and refuses anything it cannot name', () => {
    expect(resolveIncumbentTier(writeTranscript([assistant(MODELS.opus.id)]))).toBe('opus');
    expect(resolveIncumbentTier(writeTranscript([assistant(MODELS.fable.id)]))).toBe('fable');
    // Unknown id — the 'claude-zeta-9' case. Not a tier this repo can price, so
    // it is not a tier this hook will claim.
    expect(resolveIncumbentTier(writeTranscript([assistant('claude-zeta-9')]))).toBeNull();
    // A BARE TIER ALIAS IS NOT A MODEL ID. 0/8769 assistant records carried one
    // in the measured sample; the match stays exact rather than growing a
    // second, looser vocabulary.
    expect(resolveIncumbentTier(writeTranscript([assistant('opus')]))).toBeNull();
  });

  // LITERAL ids on purpose, never `MODELS.opus.id`: a fixture built from the
  // catalog moves with the catalog, so it could not see the 2026-09-23 id change
  // strand every transcript that still says `claude-opus-5`.
  it.each([
    ['claude-opus-5', 'opus'],
    ['claude-opus-5[1m]', 'opus'],
    ['claude-opus-5-5', 'opus'],
    ['claude-opus-5-5[1m]', 'opus'],
    ['claude-fable-5-1[1m]', 'fable'],
  ])('maps the transcript model %s to %s (legacy id and context variant)', (raw, tier) => {
    expect(resolveIncumbentTier(writeTranscript([assistant(raw)]))).toBe(tier);
  });

  it('still refuses a near-miss id: stripping qualifiers is not prefix matching', () => {
    for (const raw of ['claude-opus-5-6', 'claude-opus', 'claude-opus-5-5-x', 'claude-opus-5[1m]x']) {
      expect(resolveIncumbentTier(writeTranscript([assistant(raw)])), raw).toBeNull();
    }
  });

  it('reads the LAST assistant record, not the first and not a user record', () => {
    const file = writeTranscript([
      assistant(MODELS.fable.id),
      { type: 'user', message: { role: 'user', content: 'go' } },
      assistant(MODELS.opus.id),
      { type: 'user', message: { role: 'user', content: 'again' } },
    ]);
    expect(resolveIncumbentTier(file)).toBe('opus');
  });

  it('scans past a <synthetic> record instead of reading it as unknown', () => {
    // 30/8769 assistant records carried '<synthetic>' in the measured sample,
    // and on 1/21 transcripts it was the LAST one. It is a host-injected
    // placeholder, not a model turn, so it must not erase a known incumbent.
    const file = writeTranscript([assistant(MODELS.fable.id), assistant('<synthetic>')]);
    expect(resolveIncumbentTier(file)).toBe('fable');
  });

  it('yields null for a missing path, a missing file, and a transcript with no assistant', () => {
    expect(resolveIncumbentTier(undefined)).toBeNull();
    expect(resolveIncumbentTier('')).toBeNull();
    expect(resolveIncumbentTier(path.join(tmp, 'does-not-exist.jsonl'))).toBeNull();
    expect(resolveIncumbentTier(writeTranscript([
      { type: 'user', message: { role: 'user', content: 'only a user turn' } },
    ]))).toBeNull();
    // Corrupt content is a no-op, not a throw: this runs on a block point.
    const corrupt = path.join(tmp, 'corrupt.jsonl');
    writeFileSync(corrupt, 'not json at all\n{"type":"assistant"\n', 'utf-8');
    expect(resolveIncumbentTier(corrupt)).toBeNull();
  });

  it('finds the last assistant record across a transcript larger than the window', () => {
    // The fixture is deliberately BIGGER than the real cap — a few-hundred-byte
    // transcript proves nothing about a 256 KB window (rules §9).
    const file = writeTranscript([
      assistant(MODELS.fable.id),
      filler(TRANSCRIPT_TAIL_BYTES),
      assistant(MODELS.opus.id),
      filler(16384),
    ]);
    expect(statSync(file).size).toBeGreaterThan(TRANSCRIPT_TAIL_BYTES);
    expect(resolveIncumbentTier(file)).toBe('opus');
  });

  it('does not see an assistant record that fell out of the window', () => {
    // This is what makes the constant load-bearing rather than decorative: an
    // unbounded read would answer 'opus' here.
    const file = writeTranscript([assistant(MODELS.opus.id), filler(TRANSCRIPT_TAIL_BYTES * 2)]);
    expect(statSync(file).size).toBeGreaterThan(TRANSCRIPT_TAIL_BYTES);
    expect(resolveIncumbentTier(file)).toBeNull();
  });

  it('counts the consecutive run of this session on this tier', () => {
    const rows = [selectedRow('s1', 'fable'), selectedRow('s1', 'fable')];
    expect(countActionsSinceSwitch(rows, 's1', 'fable')).toBe(2);
    expect(countActionsSinceSwitch([...rows, selectedRow('s1', 'fable')], 's1', 'fable')).toBe(3);
    expect(countActionsSinceSwitch([], 's1', 'fable')).toBe(0);
  });

  it('stops at the switch — a different tier, or a row with no current at all', () => {
    expect(countActionsSinceSwitch([
      selectedRow('s1', 'fable'), selectedRow('s1', 'opus'), selectedRow('s1', 'opus'),
    ], 's1', 'opus')).toBe(2);
    expect(countActionsSinceSwitch([
      selectedRow('s1', 'opus'), selectedRow('s1', null), selectedRow('s1', 'opus'),
    ], 's1', 'opus')).toBe(1);
  });

  it('skips other sessions and other events rather than treating them as the switch', () => {
    // A neighbour session's row between two of mine must not read as a
    // boundary: a false shortfall is the reading that BLOCKS a switch.
    expect(countActionsSinceSwitch([
      selectedRow('s1', 'opus'),
      selectedRow('OTHER', 'fable'),
      selectedRow('s1', 'opus'),
      { event: 'route.bound', session_id: 's1', data: {} },
    ], 's1', 'opus')).toBe(2);
    expect(countActionsSinceSwitch([selectedRow('OTHER', 'opus')], 's1', 'opus')).toBe(0);
  });

  it('degrades to 0 on nonsense input instead of throwing', () => {
    expect(countActionsSinceSwitch(null, 's1', 'opus')).toBe(0);
    expect(countActionsSinceSwitch([selectedRow('s1', 'opus')], 's1', null)).toBe(0);
    expect(countActionsSinceSwitch([selectedRow('s1', 'opus')], null, 'opus')).toBe(0);
  });
});

describe('route-observe-pre — incumbent tier and residency (K1), as the host runs it', () => {
  let tmp;
  let home;
  let repo;

  /**
   * The data a HEAD (pre-K1) receipt carried for the absent-transcript case,
   * minus the three fields that move between runs.
   *
   * `mission_id` IS NOT PINNED HERE. The payloads below declare none, so the
   * hook falls back to `sessionFallbackMissionId({ sessionId, nowMs: Date.now() })`
   * (`scripts/hooks/route-observe-pre.js#resolveMissionId`), whose date half is
   * the UTC calendar day of the run. A literal `M-20260915-Ssesspre1` froze the
   * generation day into the fixture and turned the suite red on 2026-09-16 and
   * every day after. The session-derived half — the part K1 could actually
   * regress — is asserted separately as `/^M-\d{8}-Ssesspre1$/`, the same shape
   * assertion `resolveMissionId`'s own unit test already uses at :202.
   *
   * GENERATED, NOT HAND-WRITTEN: produced 2026-09-15T02:23:53Z by spawning the
   * then-current `scripts/hooks/route-observe-pre.js` against the payload
   * `absentPayload()` builds below and dumping `line.data`. It is pinned here so
   * that supplying the two new inputs cannot change what a receipt looks like
   * when neither input is available.
   *
   * WHICH "UNCHANGED" THIS IS. The baseline is the dd4771ca (H1) hook output,
   * NOT the live corpus. It differs from base 2b10fd31 and from the 220/220
   * receipts already on disk in exactly one reason code —
   * `hysteresis:minimum-residency` became `hysteresis:residency-unknown` — and
   * that substitution IS H1's intended change: an absent counter must not be
   * reported as a measured shortfall. So this pin holds K1 against H1's output,
   * and a diff against a live row is expected to show that one code.
   */
  const HEAD_ABSENT_RECEIPT = {
    schema_version: 1,
    session_id: 'sess-pre-1',
    execution_profile_version: 1,
    shadow_of: 'tool_use:toolu_pre_1',
    routing_epoch_id: 'toolu_pre_1',
    action: { type: 'implement', phase: 'build', complexity: 0.14, uncertainty: 0, risk: 0 },
    // Re-pinned 2026-09-23 (owner decision): catalog opus id -> claude-opus-5-5, CATALOG_VERSION bumped.
    models: {
      current: null,
      recommended: {
        provider: 'anthropic',
        family: 'claude',
        tier: 'opus',
        model_id: 'claude-opus-5-5',
        version: 'claude-opus-5-5',
        catalog_version: '2026-09-23',
      },
      selected: {
        provider: 'anthropic',
        family: 'claude',
        tier: 'opus',
        model_id: 'claude-opus-5-5',
        version: 'claude-opus-5-5',
        catalog_version: '2026-09-23',
      },
    },
    decision: { type: 'route' },
    predicted: {
      success: 0.8, cost: 0, latency: 8000, retry_probability: 0.19999999999999996,
    },
    transition: {
      context_rebuild_tokens: 0,
      cache_loss_estimate: 0,
      handoff_tokens: 0,
      predicted_time_ms: 0,
      predicted_cost: 0,
    },
    terms: {
      contextSerialization: { value: 0, measured: false },
      contextRebuild: { value: 0, measured: false },
      cacheLoss: { value: 0, measured: false },
      handoffTokens: { value: 0, measured: false },
      handoffLatency: { value: 0, measured: false },
      reorientationRisk: { value: 0, measured: false },
      expectedRetry: { value: 0, measured: false },
    },
    actionsSinceSwitch: 0,
    reason: [
      'class:agent',
      'effort:unavailable',
      'budget:unavailable',
      'route:opus',
      'policy:opus',
      'hysteresis:residency-unknown',
      'residency:unavailable',
    ],
    source: 'shadow',
  };

  /** A transcript file whose last assistant record names `tier`'s model. */
  function transcriptFor(tier, name) {
    const file = path.join(tmp, name ?? `tr-${tier}.jsonl`);
    const rec = { type: 'assistant', message: { role: 'assistant', model: MODELS[tier].id } };
    writeFileSync(file, `${JSON.stringify(rec)}\n`, 'utf-8');
    return file;
  }

  const payloadFor = (over = {}) => ({
    cwd: repo,
    hook_event_name: 'PreToolUse',
    prompt_id: 'pid-1',
    session_id: 'sess-pre-1',
    tool_name: 'Agent',
    tool_use_id: 'toolu_pre_1',
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

  /** The exact payload the pinned HEAD baseline above was generated from. */
  const absentPayload = () => payloadFor({
    effort: 'high',
    permission_mode: 'acceptEdits',
    transcript_path: path.join(tmp, 'transcript.jsonl'),
  });

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'artibot-k1-hook-')));
    home = path.join(tmp, 'home');
    repo = path.join(tmp, 'repo');
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore', windowsHide: true });
  });
  afterEach(() => {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  });

  it('names the incumbent tier from the transcript and pins when it equals the selection', () => {
    const payload = payloadFor({ transcript_path: transcriptFor('opus') });
    const r = runHook(payload, home);
    expect(r.status).toBe(0);
    expect(Buffer.byteLength(r.stdout, 'utf8')).toBe(0);

    const [line] = readRunLedger(repo);
    expect(line.data.models.current.tier).toBe('opus');
    expect(line.data.models.current.model_id).toBe(MODELS.opus.id);
    expect(line.data.actionsSinceSwitch).toBe(0);
    // The counter is now MEASURED, so the router must stop saying it is not.
    expect(line.data.reason).not.toContain('residency:unavailable');
    expect(line.data.reason).not.toContain('hysteresis:residency-unknown');
    // tdd-guide selects opus and the incumbent IS opus: staying put.
    expect(line.data.decision.type).toBe('pin');
    expect(line.data.reason).toContain('hysteresis:same-tier');
  });

  it('routes away from a different incumbent, and reports a MEASURED residency shortfall', () => {
    // fable incumbent, opus selection: `from !== to`, so the residency barrier
    // (default 3, route-hysteresis.js DEFAULT_SWITCH_POLICY) actually applies.
    const payload = payloadFor({ transcript_path: transcriptFor('fable') });
    expect(runHook(payload, home).status).toBe(0);
    const [line] = readRunLedger(repo);
    expect(line.data.models.current.tier).toBe('fable');
    expect(line.data.decision.type).toBe('route');
    expect(line.data.actionsSinceSwitch).toBe(0);
    // 0 < 3, but it is a COUNT now, not a gap — the distinct code is the point.
    expect(line.data.reason).toContain('hysteresis:minimum-residency');
    expect(line.data.reason).not.toContain('hysteresis:residency-unknown');
  });

  it('counts prior receipts of the same session, and clears the barrier at three', () => {
    const tr = transcriptFor('fable');
    const run = (id) => expect(runHook(payloadFor({
      transcript_path: tr, tool_use_id: id,
    }), home).status).toBe(0);

    run('toolu_1');
    run('toolu_2');
    run('toolu_3');
    run('toolu_4');

    const counts = readRunLedger(repo).map((l) => l.data.actionsSinceSwitch);
    expect(counts).toEqual([0, 1, 2, 3]);

    const lines = readRunLedger(repo);
    // 2 is still short of the barrier; 3 meets it and the hold reason changes.
    expect(lines[2].data.reason).toContain('hysteresis:minimum-residency');
    expect(lines[3].data.reason).not.toContain('hysteresis:minimum-residency');
    expect(lines[3].data.reason.some((c) => c.startsWith('hysteresis:'))).toBe(true);
  });

  it('does not count another session rows, and stops at a row with no incumbent', () => {
    const tr = transcriptFor('fable');
    // Two rows with NO transcript at all: `models.current` is null on both.
    expect(runHook(payloadFor({ tool_use_id: 'toolu_a' }), home).status).toBe(0);
    // A different session on the same ledger, same tier.
    expect(runHook(payloadFor({
      transcript_path: tr, tool_use_id: 'toolu_b', session_id: 'OTHER-SESSION',
    }), home).status).toBe(0);
    expect(runHook(payloadFor({ transcript_path: tr, tool_use_id: 'toolu_c' }), home).status).toBe(0);
    expect(runHook(payloadFor({ transcript_path: tr, tool_use_id: 'toolu_d' }), home).status).toBe(0);

    const lines = readRunLedger(repo);
    expect(lines).toHaveLength(4);
    // toolu_c is the session's first fable row: the null-current row before it
    // is the switch, and the OTHER-SESSION row in between is not a boundary.
    expect(lines[2].data.actionsSinceSwitch).toBe(0);
    expect(lines[3].data.actionsSinceSwitch).toBe(1);
    // The neighbour session counted only its own history, which is none.
    expect(lines[1].session_id).toBe('OTHER-SESSION');
    expect(lines[1].data.actionsSinceSwitch).toBe(0);
  });

  it('leaves the receipt byte-identical to HEAD when no incumbent can be named', () => {
    // Four ways to have no tier; every one must produce the SAME receipt the
    // hook produced before it could read a transcript at all.
    const unknownModel = path.join(tmp, 'zeta.jsonl');
    writeFileSync(unknownModel, `${JSON.stringify({
      type: 'assistant', message: { role: 'assistant', model: 'claude-zeta-9' },
    })}\n`, 'utf-8');
    const noAssistant = path.join(tmp, 'user-only.jsonl');
    writeFileSync(noAssistant, `${JSON.stringify({ type: 'user', message: {} })}\n`, 'utf-8');

    const cases = {
      'missing file': absentPayload(),
      'no transcript_path key': payloadFor({ effort: 'high', permission_mode: 'acceptEdits' }),
      'unknown model id': payloadFor({
        effort: 'high', permission_mode: 'acceptEdits', transcript_path: unknownModel,
      }),
      'no assistant record': payloadFor({
        effort: 'high', permission_mode: 'acceptEdits', transcript_path: noAssistant,
      }),
    };

    for (const [label, payload] of Object.entries(cases)) {
      rmSync(ledgerFilePath(repo), { force: true });
      expect(runHook(payload, home).status, label).toBe(0);
      const [line] = readRunLedger(repo);
      // `route_receipt_id` and `timestamp` move every run and `mission_id`
      // carries the run's UTC calendar day; everything else is the frozen HEAD
      // shape.
      const {
        route_receipt_id: rid, timestamp, mission_id: missionId, ...rest
      } = line.data;
      expect(rest, label).toEqual(HEAD_ABSENT_RECEIPT);
      expect(rid, label).toMatch(/^rr-toolu_pre_1-/);
      expect(timestamp, label).toEqual(expect.any(String));
      expect(missionId, label).toMatch(/^M-\d{8}-Ssesspre1$/);
    }
  });

  it('never lets transcript content other than the model id reach the ledger', () => {
    const secret = 'SENTINEL-TRANSCRIPT-CONTENT-DO-NOT-PERSIST';
    const file = path.join(tmp, 'leaky.jsonl');
    writeFileSync(file, [
      JSON.stringify({
        type: 'assistant',
        uuid: `${secret}-uuid`,
        cwd: `/somewhere/${secret}`,
        message: {
          // fable, NOT the selected tier: `recommended` and `selected` are both
          // opus for this agent, so an opus id would appear in the ledger even
          // with the transcript read switched off and this test would pass
          // vacuously. fable can only have come from the transcript.
          role: 'assistant',
          model: MODELS.fable.id,
          id: `${secret}-msgid`,
          content: [{ type: 'text', text: `${secret} full reasoning text` }],
        },
      }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: `${secret} tool result` } }),
      '',
    ].join('\n'), 'utf-8');

    const r = runHook(payloadFor({ transcript_path: file }), home);
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain(secret);
    expect(Buffer.byteLength(r.stdout, 'utf8')).toBe(0);

    // The read happened at all — without this the leak assertion below is
    // green for a hook that never opened the file.
    const [line] = readRunLedger(repo);
    expect(line.data.models.current.model_id).toBe(MODELS.fable.id);

    const raw = readFileSync(ledgerFilePath(repo), 'utf-8');
    // The model id got through; NOTHING else from the transcript did.
    expect(raw).toContain(MODELS.fable.id);
    expect(raw).not.toContain(secret);
  });

  it('stays mute and exit-0 on a transcript path that is a directory', () => {
    const r = runHook(payloadFor({ transcript_path: tmp }), home);
    expect(r.status).toBe(0);
    expect(Buffer.byteLength(r.stdout, 'utf8')).toBe(0);
    const [line] = readRunLedger(repo);
    expect(line.data.models.current).toBeNull();
  });

  it('stays mute for an Agent call under the SHIPPED empty canary allowlist', () => {
    // The child process loads the real `artibot.config.json`, so this is the
    // shipped `routing.canary.actionClasses: []` reaching the hook for real —
    // not a synthesized one. Read here rather than pinned, so a flip of that
    // key retires this test's premise instead of leaving it asserting a value
    // the file no longer has.
    const shipped = JSON.parse(readFileSync(path.join(PLUGIN_ROOT, 'artibot.config.json'), 'utf-8'));
    expect(shipped.routing.canary.actionClasses).toEqual([]);

    const r = runHook(payloadFor({ transcript_path: transcriptFor('fable') }), home);
    expect(r.status).toBe(0);
    expect(Buffer.byteLength(r.stdout, 'utf8')).toBe(0);
    expect(readRunLedger(repo)).toHaveLength(1);
  });
});

describe('route-observe-pre — the canary value is forwarded, never interpreted (CA-GA02)', () => {
  /** The ctx `buildReceipt` takes, with only `config` varying between cases. */
  const ctxWith = (config) => ({
    toolUseId: 'toolu_canary_1',
    sessionId: 'sess-canary-1',
    missionId: 'M-20260904-Sabcdefgh',
    agentType: 'artibot:tdd-guide',
    text: 'Implement the ledger byte cap across three modules and add regression tests',
    config,
  });

  /** A config whose `routing.canary` read is counted, so "who touched it" is observable. */
  function countingConfig(value) {
    let reads = 0;
    const routing = {};
    Object.defineProperty(routing, 'canary', {
      get() { reads += 1; return value; },
      enumerable: true,
    });
    return { config: { routing }, reads: () => reads };
  }

  /** The receipt minus the two fields that move between runs. */
  const stable = (receipt) => {
    const { route_receipt_id: rid, timestamp, ...rest } = receipt;
    expect(rid).toMatch(/^rr-toolu_canary_1-/);
    expect(timestamp).toEqual(expect.any(String));
    return rest;
  };

  it('reads config.routing.canary exactly once — one pass-through, no inspection', () => {
    // EXACTLY ONE read is the hook's whole contract here, and it holds on both
    // sides of the lib change: the hook hands the value over and never looks at
    // it again. Zero reads would mean the argument is not being passed at all;
    // more than one would mean the hook is doing work that belongs in
    // `adaptive-model-router.js`.
    const { config, reads } = countingConfig({ actionClasses: [] });
    expect(buildReceipt(ctxWith(config))).not.toBeNull();
    expect(reads()).toBe(1);
  });

  it('does not normalise or mutate the value it forwards', () => {
    // Interpretation lives in the lib. A hook that lower-cased, de-duplicated or
    // defaulted this list would be a second, silent vocabulary for the same key.
    const value = { actionClasses: ['Review', 'review', ''], stray: 1 };
    buildReceipt(ctxWith({ routing: { canary: value } }));
    expect(value).toEqual({ actionClasses: ['Review', 'review', ''], stray: 1 });
  });

  it('is byte-identical across absent routing, empty routing and the shipped empty allowlist', () => {
    // Same normalisation as the "byte-identical to HEAD" case above: only
    // `route_receipt_id` and `timestamp` move. `mission_id` is supplied here, so
    // it does not.
    const absent = stable(buildReceipt(ctxWith({})));
    const emptyRouting = stable(buildReceipt(ctxWith({ routing: {} })));
    const shipped = stable(buildReceipt(ctxWith({ routing: { canary: { actionClasses: [] } } })));

    expect(emptyRouting).toEqual(absent);
    expect(shipped).toEqual(absent);
    // The pin that makes the three comparisons mean something: an empty
    // allowlist applies to nothing, so `selected` stays the policy answer.
    expect(shipped.models.selected.tier).toBe('opus');
    expect(shipped.decision.type).toBe('route');
    expect(shipped.reason.some((c) => c.startsWith('canary:'))).toBe(false);
  });

  /**
   * Explicit policy fixture, mirroring the CONFIG in
   * `tests/routing/adaptive-router.test.js`: `architect` is fable-allowlisted,
   * so the scorer's recommendation (fable) and the policy answer (opus) DIVERGE.
   * That divergence is what makes a moved seat observable at all — with the two
   * tiers equal, a canary that applied and one that never matched look alike in
   * `models.selected`. Frozen and explicit so an `artibot.config.json` edit
   * cannot turn this red.
   */
  const POLICY_CONFIG = Object.freeze({
    agents: {
      modelPolicy: {
        fable: { enabled: true, allowlist: ['architect'] },
        high: { model: 'opus', agents: ['architect', 'backend-developer'] },
        medium: { model: 'opus', agents: [] },
        phaseRoles: { build: 'opus', review: 'fable' },
      },
    },
  });

  /** The same architect ctx, varying only the allowlist. */
  const architectCtx = (actionClasses) => ({
    ...ctxWith({ ...POLICY_CONFIG, routing: { canary: { actionClasses } } }),
    agentType: 'artibot:architect',
    text: 'design the module boundary and dependency strategy',
  });

  it('hands the list to the key routeModel actually reads — the moved seat is the proof', () => {
    // EFFECT-LEVEL, not read-count. Every other test in this block stays green
    // if the key at the `routeModel` call is misspelled, because they only
    // observe that the hook touched `config.routing.canary`. This one observes
    // the value ARRIVING: a wrong key leaves the list unread and the seat where
    // policy put it.
    //
    // The class is MEASURED, not guessed — ask the receipt what this input
    // resolved to, then allowlist exactly that.
    const baseline = buildReceipt(architectCtx([]));
    const actionClass = baseline.action.type;
    expect(actionClass).toBe('architecture');
    expect(baseline.models.recommended.tier).toBe('fable');
    expect(baseline.models.selected.tier).toBe('opus');
    expect(baseline.reason.some((c) => c.startsWith('canary:'))).toBe(false);

    const matched = buildReceipt(architectCtx([actionClass]));
    expect(matched.models.selected.tier).toBe(matched.models.recommended.tier);
    expect(matched.models.selected.tier).toBe('fable');
    expect(matched.reason).toContain(`canary:${matched.models.recommended.tier}`);
    // The policy answer is not erased, only demoted to a reason code — that
    // counterfactual is what the Phase 0 divergence metric is built on.
    expect(matched.reason).toContain('policy:opus');
    // No new receipt key and no new decision vocabulary.
    expect(matched.decision.type).toBe('route');
    expect(Object.keys(matched).sort()).toEqual(Object.keys(baseline).sort());
  });

  it('never throws on a config that cannot carry a canary at all', () => {
    // `ctx.config` is whatever `loadConfig()` returned, and the hook's own catch
    // sets it to `undefined` when that read threw — so undefined is a LIVE case,
    // not a hypothetical one (`scripts/hooks/route-observe-pre.js#observePre`).
    for (const config of [undefined, null, {}, { routing: null }]) {
      expect(buildReceipt(ctxWith(config)), String(config)).not.toBeNull();
    }
  });

  it('never throws on a canary value of the wrong type, and still returns a receipt', () => {
    // Rejecting these is the lib's job; the hook's job is to survive them.
    for (const value of [null, undefined, 42, 'x', [], { actionClasses: 'review' }]) {
      const receipt = buildReceipt(ctxWith({ routing: { canary: value } }));
      expect(receipt, JSON.stringify(value ?? null)).not.toBeNull();
      expect(receipt.action.phase).toBe('build');
    }
  });
});
