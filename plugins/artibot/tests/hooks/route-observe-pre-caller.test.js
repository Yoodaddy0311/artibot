/**
 * `scripts/hooks/route-observe-pre.js` - WHO ASKED for the spawn, recorded beside
 * what policy predicted and never mixed into it (SH-19, part A).
 *
 * One additive receipt key, always present:
 *   - `caller_agent_id` - the PreToolUse payload's own `agent_id`: the subagent
 *     that CALLED the Agent tool, or null when the payload carries none. It is the
 *     requester of the spawn, NOT the spawned agent (that id is
 *     `route.bound.data.agent_id`, joined on `tool_use_id`), and it feeds nothing:
 *     never the router, never the decision or a reason code.
 *
 * THE KEY AND THE SCHEMA MOVE TOGETHER. `route.selected` is validated against the
 * closed `schemas/route-receipt.schema.json` (`additionalProperties:false`) by the
 * ledger writer. An undeclared key is REJECTED and a `ledger.rejected` row lands
 * where the receipt should be - measured 2026-09-29 through the real writer as
 * `receipt-additional:caller_agent_id`. So this key ships in the same commit as
 * its schema property, and the coupling is pinned below rather than assumed.
 *
 * Separate file because `route-observe-pre.test.js` is already past 1000 lines
 * (the same reason `route-observe-pre-request.test.js` exists). Same harness: the
 * hook is spawned as the host runs it (JSON on stdin, temp HOME, temp git repo as
 * cwd) and the run ledger is read back.
 *
 * WHAT THIS FILE DOES NOT PROVE (rules section 9):
 *   - THAT THE HOST SENDS `agent_id` ON AN Agent CALL MADE INSIDE A SUBAGENT. The
 *     host's payload schema documents it (2.1.284 binary, R7 recon); no such
 *     payload was ever captured, and the frozen fixture holds main-thread spawns
 *     only. Every payload below is synthesized.
 *   - THAT NULL MEANS "MAIN THREAD" IN PRODUCTION. It means the payload named no
 *     agent; the reading "main thread" is the host's documentation, not a
 *     measurement made here.
 *   - THAT THE CALLER EQUALS THE PARENT THE HOST LATER WRITES TO
 *     `agent-<id>.meta.json` (`parentAgentId`). No join is attempted or asserted.
 *   - THE MUTE-OBSERVER PROPERTY. Zero stdout bytes and exit 0 are asserted for
 *     the payloads here; the eight-shape gate and the source scan live in
 *     `tests/firewall/host-payload-contract.test.js`.
 *
 * @module tests/hooks/route-observe-pre-caller
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ledgerFilePath } from '../../lib/runtime/ledger.js';
import { validateAgainstSchema } from '../../lib/runtime/ledger-schema.js';
import { routeModel } from '../../lib/routing/adaptive-model-router.js';
import { buildReceipt } from '../../scripts/hooks/route-observe-pre.js';

// Pass-through wrapper, so the arguments `buildReceipt` hands the router are
// observable (a module mock replaces the binding the hook's NAMED import calls).
vi.mock('../../lib/routing/adaptive-model-router.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, routeModel: vi.fn(mod.routeModel) };
});

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK = path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'route-observe-pre.js');
const ROUTE_SCHEMA = JSON.parse(readFileSync(
  path.join(PLUGIN_ROOT, 'schemas', 'route-receipt.schema.json'),
  'utf-8',
));

const require = createRequire(import.meta.url);

/** The same ajv oracle the sibling receipt tests use (a missing ajv is a failure). */
function compileWithAjv(doc) {
  const Ajv = require('ajv');
  return new Ajv({ allErrors: false, strict: false }).compile(doc);
}
const validateRoute = compileWithAjv(ROUTE_SCHEMA);

/** Both validators - ajv (the oracle) and the ledger writer's keyword subset. */
const verdicts = (data) => ({
  ajv: validateRoute(data),
  writer: validateAgainstSchema(data, ROUTE_SCHEMA) === null,
});

/** Run the hook exactly as the host does: fresh process, JSON on stdin. */
function runHook(payload, home) {
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
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

/** The receipt minus the fields that move between runs and the one under test. */
const withoutCaller = (receipt) => {
  const {
    route_receipt_id: _rid, timestamp: _ts, caller_agent_id: _caller, ...rest
  } = receipt;
  return rest;
};

const CALLER = 'agent-caller-sh19-1';

describe('route-observe-pre - caller_agent_id, as the host runs it', () => {
  let tmp;
  let home;
  let repo;

  const payloadFor = (over = {}) => ({
    cwd: repo,
    hook_event_name: 'PreToolUse',
    prompt_id: 'pid-caller-1',
    session_id: 'sess-caller-1',
    tool_name: 'Agent',
    tool_use_id: 'toolu_caller_1',
    transcript_path: path.join(tmp, 'transcript.jsonl'),
    tool_input: {
      description: 'Review existing documentation',
      prompt: 'Read the docs folder and report what is stale.',
      subagent_type: 'artibot:doc-updater',
    },
    ...over,
  });

  /** The single ledger line a run must leave, failing with the writer's own reason. */
  const onlyLine = () => {
    const lines = readRunLedger(repo);
    expect(lines).toHaveLength(1);
    const [line] = lines;
    // A rejected receipt is a `ledger.rejected` row carrying the reason: show it.
    expect(line.event, String(line.data?.reason)).toBe('route.selected');
    return line;
  };

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'artibot-caller-pre-')));
    home = path.join(tmp, 'home');
    repo = path.join(tmp, 'repo');
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore', windowsHide: true });
  });
  afterEach(() => {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  });

  it('a payload that names no agent records caller_agent_id: null - key present, hook mute', () => {
    const r = runHook(payloadFor(), home);
    expect(r.status).toBe(0);
    expect(Buffer.byteLength(r.stdout, 'utf8')).toBe(0);

    const { data } = onlyLine();
    expect(Object.prototype.hasOwnProperty.call(data, 'caller_agent_id')).toBe(true);
    expect(data.caller_agent_id).toBeNull();
    expect(validateRoute(data)).toBe(true);
  });

  it('a spawn made from inside a subagent records that subagent as the caller, once', () => {
    const r = runHook(payloadFor({ agent_id: CALLER }), home);
    expect(r.status).toBe(0);
    expect(Buffer.byteLength(r.stdout, 'utf8')).toBe(0);

    const line = onlyLine();
    expect(line.data.caller_agent_id).toBe(CALLER);
    expect(validateRoute(line.data)).toBe(true);
    // The requester's id sits in exactly one place on the line: it is not copied
    // into the envelope (worker / idempotency_key / epoch) or any prediction field.
    expect(JSON.stringify(line).split(CALLER)).toHaveLength(2);
  });

  it('leaves the prediction, decision and reasons where policy put them, with or without a caller', () => {
    expect(runHook(payloadFor({ agent_id: CALLER }), home).status).toBe(0);
    expect(runHook(payloadFor({ tool_use_id: 'toolu_caller_2' }), home).status).toBe(0);

    const lines = readRunLedger(repo);
    expect(lines.map((l) => l.event)).toEqual(['route.selected', 'route.selected']);
    const [withCaller, without] = lines.map((l) => l.data);
    expect(withCaller.caller_agent_id).toBe(CALLER);
    expect(without.caller_agent_id).toBeNull();
    for (const key of [
      'models', 'decision', 'action', 'reason', 'predicted', 'transition', 'terms',
      'actionsSinceSwitch', 'source', 'requested_model', 'requested_task',
    ]) {
      expect(withCaller[key], key).toEqual(without[key]);
    }
  });

  it.each([
    ['a number', 42],
    ['a boolean', true],
    ['an object', { id: 'x' }],
    ['an array', ['x']],
    ['an empty string', ''],
    ['a blank string', '   '],
    ['null', null],
  ])('an agent_id that is %s is recorded as null, and the hook stays mute', (_label, value) => {
    const r = runHook(payloadFor({ agent_id: value }), home);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');

    const { data } = onlyLine();
    expect(data.caller_agent_id).toBeNull();
    expect(validateRoute(data)).toBe(true);
  });

  it('trims the id and caps it at 128 characters, and both rows still validate', () => {
    expect(runHook(payloadFor({ agent_id: `  ${CALLER}  ` }), home).status).toBe(0);
    const long = `a${'x'.repeat(400)}`;
    expect(runHook(payloadFor({ agent_id: long, tool_use_id: 'toolu_caller_3' }), home).status).toBe(0);

    const lines = readRunLedger(repo);
    expect(lines.map((l) => l.event)).toEqual(['route.selected', 'route.selected']);
    const [trimmed, capped] = lines.map((l) => l.data);
    expect(trimmed.caller_agent_id).toBe(CALLER);
    expect(capped.caller_agent_id).toBe(long.slice(0, 128));
    expect(validateRoute(capped)).toBe(true);
  });

  it('appends caller_agent_id last, so every pre-existing key keeps its position', () => {
    expect(runHook(payloadFor({ agent_id: CALLER }), home).status).toBe(0);
    const keys = Object.keys(onlyLine().data);
    expect(keys.slice(-3)).toEqual(['requested_model', 'requested_task', 'caller_agent_id']);
    expect(keys[keys.length - 4]).toBe('source');
  });
});

describe('route-observe-pre - caller_agent_id never reaches the router', () => {
  const ctxWith = (over = {}) => ({
    toolUseId: 'toolu_caller_pure',
    sessionId: 'sess-caller-pure',
    missionId: 'M-20260929-Sabcdefgh',
    agentType: 'artibot:doc-updater',
    text: 'Review existing documentation',
    config: undefined,
    ...over,
  });

  beforeEach(() => {
    routeModel.mockClear();
  });

  it('builds the same receipt, byte for byte, whatever caller was named', () => {
    const absent = buildReceipt(ctxWith());
    expect(absent).not.toBeNull();
    expect(absent.caller_agent_id).toBeNull();
    const baseline = JSON.stringify(withoutCaller(absent));

    for (const callerAgentId of ['a1', CALLER, 'x'.repeat(200)]) {
      const receipt = buildReceipt(ctxWith({ callerAgentId }));
      expect(receipt.caller_agent_id, callerAgentId).toBe(callerAgentId.slice(0, 128));
      expect(JSON.stringify(withoutCaller(receipt)), callerAgentId).toBe(baseline);
    }
  });

  it('hands routeModel nothing that carries the caller id', () => {
    const sentinel = 'SENTINEL-CALLER-AGENT-NOT-A-ROUTING-INPUT';
    const receipt = buildReceipt(ctxWith({ callerAgentId: sentinel }));
    // The value really was in ctx - without this the absence below is vacuous.
    expect(receipt.caller_agent_id).toBe(sentinel);

    expect(routeModel).toHaveBeenCalledTimes(1);
    const [arg] = routeModel.mock.calls[0];
    expect(JSON.stringify(arg)).not.toContain(sentinel);
    expect(arg).not.toHaveProperty('callerAgentId');
    expect(arg).not.toHaveProperty('agent_id');
  });

  it('records null for a blank or non-string caller rather than the value', () => {
    for (const callerAgentId of ['', '   ', 42, { id: 'x' }, ['x'], true, null, undefined]) {
      expect(buildReceipt(ctxWith({ callerAgentId })).caller_agent_id, String(callerAgentId))
        .toBeNull();
    }
  });
});

describe('route-receipt.schema.json - caller_agent_id, closed', () => {
  const receipt = (over = {}) => ({
    ...buildReceipt({
      toolUseId: 'toolu_caller_schema',
      sessionId: 'sess-caller-schema',
      missionId: 'M-20260929-Sabcdefgh',
      agentType: 'artibot:doc-updater',
      text: 'Review existing documentation',
      config: undefined,
    }),
    ...over,
  });

  it('declares it with the same shape as requested_model, optional, in a closed schema', () => {
    const { caller_agent_id: caller, requested_model: model } = ROUTE_SCHEMA.properties;
    expect(caller).toBeDefined();
    expect(caller.type).toEqual(['string', 'null']);
    expect({ type: caller.type, minLength: caller.minLength, maxLength: caller.maxLength })
      .toEqual({ type: model.type, minLength: model.minLength, maxLength: model.maxLength });
    expect(ROUTE_SCHEMA.required).not.toContain('caller_agent_id');
    expect(ROUTE_SCHEMA.additionalProperties).toBe(false);
  });

  it('accepts every shape the hook emits, on both validators', () => {
    for (const data of [
      receipt(),
      receipt({ caller_agent_id: null }),
      receipt({ caller_agent_id: CALLER }),
      receipt({ caller_agent_id: 'y'.repeat(128) }),
    ]) {
      expect(verdicts(data)).toEqual({ ajv: true, writer: true });
    }
  });

  it('keeps a receipt written before the key existed valid', () => {
    const { caller_agent_id: _dropped, ...old } = receipt();
    expect(verdicts(old)).toEqual({ ajv: true, writer: true });
  });

  it('rejects an empty string and non-string ids on both validators', () => {
    const bad = {
      'empty id': receipt({ caller_agent_id: '' }),
      'numeric id': receipt({ caller_agent_id: 7 }),
      'object id': receipt({ caller_agent_id: { id: 'x' } }),
    };
    for (const [label, data] of Object.entries(bad)) {
      expect(verdicts(data), label).toEqual({ ajv: false, writer: false });
      // Rejected for what the value IS (type, minLength), not merely because the
      // key is unknown - without the schema property every one of these would be
      // rejected as `additional:caller_agent_id` and this test would prove nothing.
      expect(validateAgainstSchema(data, ROUTE_SCHEMA), label).not.toMatch(/^additional:/);
    }
  });

  it('bounds the id at 128 under ajv; the writer does not run maxLength', () => {
    // MEASURED GAP, written next to the gate (rules section 9): the writer's
    // keyword subset (`lib/runtime/ledger-schema.js`) enforces minLength but not
    // maxLength - the same gap `requested_model` documents. The hook's own slice
    // is what keeps a live row inside the bound; this pins both halves so a writer
    // that starts enforcing maxLength turns this red and gets noticed.
    expect(verdicts(receipt({ caller_agent_id: 'z'.repeat(129) })))
      .toEqual({ ajv: false, writer: true });
  });

  it('is the property that admits the key: a schema without it rejects the receipt', () => {
    const withCaller = receipt({ caller_agent_id: CALLER });
    const without = JSON.parse(JSON.stringify(ROUTE_SCHEMA));
    delete without.properties.caller_agent_id;
    // The failure mode the schema property prevents: through appendLedgerEvent this
    // reads `receipt-additional:caller_agent_id` and a `ledger.rejected` row replaces
    // the receipt (measured 2026-09-29).
    expect(validateAgainstSchema(withCaller, without)).toBe('additional:caller_agent_id');
    expect(validateAgainstSchema(withCaller, ROUTE_SCHEMA)).toBeNull();
  });

  it('says it is the requester, not the spawned agent, and that null is documentation', () => {
    const { description } = ROUTE_SCHEMA.properties.caller_agent_id;
    expect(description).toMatch(/CALLED the Agent tool/);
    expect(description).toMatch(/NOT the spawned agent/);
    expect(description).toMatch(/route\.bound/);
    expect(description).toMatch(/documentation, not a measurement/);
  });
});
