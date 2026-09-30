/**
 * `scripts/hooks/route-observe-pre.js` — what the CALLER ASKED FOR, recorded
 * beside what policy predicted and never mixed into it.
 *
 * Two additive receipt keys, both always present:
 *   - `requested_model` — `tool_input.model` as the caller passed it, or null.
 *     It is a REQUEST. Nothing here (or anywhere) may read it as the model that
 *     served; that identity comes only from `usage.receipt` (transcript usage).
 *     `route.bound` supplies the `agent_id` join key, and its `selected_model`
 *     is a policy value too — not a served one either.
 *   - `requested_task`  — the class the request TEXT classifies to on its own,
 *     without the agent table that wins in `action.type`, as
 *     `{ class, source: 'text' }`, or `{ class: null, source: 'unmeasured' }`
 *     when the text names no class.
 *
 * Separate file because `route-observe-pre.test.js` is already past 1000 lines.
 * Same harness shape: the hook is spawned as the host runs it (JSON on stdin,
 * temp HOME, temp git repo as cwd) and the run ledger is read back.
 *
 * WHAT THIS FILE DOES NOT PROVE (rules §9):
 *   - THAT THE HOST EVER FORWARDS `tool_input.model`. The frozen host fixture
 *     never observed it; the payloads here are synthesized.
 *   - WHAT MODEL ACTUALLY RAN. No model is executed here; `requested_model`
 *     is compared against nothing served.
 *   - CLASSIFIER ACCURACY. `requested_task` reports what the keyword table
 *     says about the text, not whether that is what the caller meant.
 *
 * @module tests/hooks/route-observe-pre-request
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
// observable. `vi.spyOn` on the namespace would not see the hook's NAMED import;
// a module mock replaces the binding the hook actually calls.
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

/**
 * The same oracle `tests/firewall/ledger-vocab-allowlist.test.js` uses. ajv
 * resolves only as a transitive dev dependency; a missing ajv is a failure
 * here, not a skip.
 */
function compileWithAjv(doc) {
  const Ajv = require('ajv');
  return new Ajv({ allErrors: false, strict: false }).compile(doc);
}
const validateRoute = compileWithAjv(ROUTE_SCHEMA);

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
const withoutRequest = (receipt) => {
  const {
    route_receipt_id: _rid, timestamp: _ts, requested_model: _rm, ...rest
  } = receipt;
  return rest;
};

/**
 * The Codex R6 probe input: an agent whose TABLE class (doc-updater ->
 * edit-routine) differs from what its request text says (review).
 */
const DOC_UPDATER_INPUT = Object.freeze({
  subagent_type: 'artibot:doc-updater',
  model: 'sonnet',
  description: 'Review existing documentation',
  prompt: 'Read the docs folder and report what is stale.',
});

describe('route-observe-pre — requested model and task, as the host runs it', () => {
  let tmp;
  let home;
  let repo;

  const payloadFor = (toolInput, over = {}) => ({
    cwd: repo,
    hook_event_name: 'PreToolUse',
    prompt_id: 'pid-req-1',
    session_id: 'sess-req-1',
    tool_name: 'Agent',
    tool_use_id: 'toolu_req_1',
    transcript_path: path.join(tmp, 'transcript.jsonl'),
    ...over,
    tool_input: { ...toolInput },
  });

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'artibot-req-pre-')));
    home = path.join(tmp, 'home');
    repo = path.join(tmp, 'repo');
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore', windowsHide: true });
  });
  afterEach(() => {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  });

  it('records the requested model and the text class beside the agent-default class', () => {
    const r = runHook(payloadFor(DOC_UPDATER_INPUT), home);
    expect(r.status).toBe(0);
    expect(Buffer.byteLength(r.stdout, 'utf8')).toBe(0);

    const lines = readRunLedger(repo);
    expect(lines).toHaveLength(1);
    const [line] = lines;
    // Not `ledger.rejected`: the writer's own schema check admitted the keys.
    expect(line.event).toBe('route.selected');
    const { data } = line;

    expect(data.requested_model).toBe('sonnet');
    expect(data.requested_task).toEqual({ class: 'review', source: 'text' });
    // The agent table still wins where it always did — measured, not assumed.
    expect(data.action.type).toBe('edit-routine');
    expect(data.requested_task.class).not.toBe(data.action.type);
    expect(validateRoute(data)).toBe(true);
  });

  it('leaves models.selected where policy put it, with or without a requested model', () => {
    expect(runHook(payloadFor(DOC_UPDATER_INPUT), home).status).toBe(0);
    const { model: _m, ...noModel } = DOC_UPDATER_INPUT;
    expect(runHook(payloadFor(noModel, { tool_use_id: 'toolu_req_2' }), home).status).toBe(0);

    const [withModel, without] = readRunLedger(repo).map((l) => l.data);
    expect(withModel.requested_model).toBe('sonnet');
    // `sonnet` was asked for and is NOT what the policy prediction says.
    expect(withModel.models.selected).toEqual(without.models.selected);
    expect(withModel.models.selected.tier).not.toBe('sonnet');
    expect(withModel.decision).toEqual(without.decision);
    expect(withModel.action).toEqual(without.action);
    expect(withModel.reason).toEqual(without.reason);
  });

  it('writes requested_model: null — key present — when the caller passed no model', () => {
    const { model: _m, ...noModel } = DOC_UPDATER_INPUT;
    const r = runHook(payloadFor(noModel), home);
    expect(r.status).toBe(0);
    expect(Buffer.byteLength(r.stdout, 'utf8')).toBe(0);

    const [line] = readRunLedger(repo);
    expect(Object.prototype.hasOwnProperty.call(line.data, 'requested_model')).toBe(true);
    expect(line.data.requested_model).toBeNull();
    expect(validateRoute(line.data)).toBe(true);
  });

  it('caps an oversized model string at 128 characters and still validates', () => {
    const long = `m${'x'.repeat(400)}`;
    expect(runHook(payloadFor({ ...DOC_UPDATER_INPUT, model: long }), home).status).toBe(0);
    const [line] = readRunLedger(repo);
    expect(line.data.requested_model).toBe(long.slice(0, 128));
    expect(validateRoute(line.data)).toBe(true);
  });

  it('appends the two keys after `source`, so every pre-existing key keeps its position', () => {
    expect(runHook(payloadFor(DOC_UPDATER_INPUT), home).status).toBe(0);
    const [line] = readRunLedger(repo);
    const keys = Object.keys(line.data);
    // `caller_agent_id` (SH-19) is appended after these two; its own test file pins the tail.
    expect(keys.slice(-3)).toEqual(['requested_model', 'requested_task', 'caller_agent_id']);
    expect(keys[keys.length - 4]).toBe('source');
  });
});

describe('route-observe-pre — requested_model never reaches the router', () => {
  const ctxWith = (over = {}) => ({
    toolUseId: 'toolu_req_pure',
    sessionId: 'sess-req-pure',
    missionId: 'M-20260928-Sabcdefgh',
    agentType: 'artibot:doc-updater',
    text: 'Review existing documentation',
    config: undefined,
    ...over,
  });

  beforeEach(() => {
    routeModel.mockClear();
  });

  it('builds the same receipt, byte for byte, whatever model was requested', () => {
    const absent = buildReceipt(ctxWith());
    expect(absent).not.toBeNull();
    expect(absent.requested_model).toBeNull();
    const baseline = JSON.stringify(withoutRequest(absent));

    // `fable` and `opus` are real tiers the router could have been steered to;
    // `haiku`/`sonnet` are tiers it never selects for this agent.
    for (const requestedModel of ['sonnet', 'haiku', 'fable', 'opus', 'claude-sonnet-5']) {
      const receipt = buildReceipt(ctxWith({ requestedModel }));
      expect(receipt.requested_model, requestedModel).toBe(requestedModel);
      expect(JSON.stringify(withoutRequest(receipt)), requestedModel).toBe(baseline);
    }
  });

  it('hands routeModel nothing that carries the requested value', () => {
    const sentinel = 'SENTINEL-REQUESTED-MODEL-NOT-A-ROUTING-INPUT';
    const receipt = buildReceipt(ctxWith({ requestedModel: sentinel }));
    // The value really was in ctx — without this the absence below is vacuous.
    expect(receipt.requested_model).toBe(sentinel);

    expect(routeModel).toHaveBeenCalledTimes(1);
    const [arg] = routeModel.mock.calls[0];
    expect(JSON.stringify(arg)).not.toContain(sentinel);
    expect(arg).not.toHaveProperty('model');
    expect(arg).not.toHaveProperty('requestedModel');
    expect(arg.input).not.toHaveProperty('model');
  });

  it('drops a blank or non-string model to null rather than recording it', () => {
    for (const requestedModel of ['', '   ', 42, { tier: 'opus' }, null, undefined]) {
      const receipt = buildReceipt(ctxWith({ requestedModel }));
      expect(receipt.requested_model, String(requestedModel)).toBeNull();
    }
  });
});

describe('route-observe-pre — requested_task is the text class, or unmeasured', () => {
  const ctxWith = (over = {}) => ({
    toolUseId: 'toolu_task_pure',
    sessionId: 'sess-task-pure',
    missionId: 'M-20260928-Sabcdefgh',
    agentType: 'artibot:doc-updater',
    text: 'Review existing documentation',
    config: undefined,
    ...over,
  });

  it('reports the text class even where the agent table decided action.type', () => {
    const receipt = buildReceipt(ctxWith());
    expect(receipt.action.type).toBe('edit-routine');
    expect(receipt.requested_task).toEqual({ class: 'review', source: 'text' });
  });

  it('is unmeasured — not the fallback class — when the text names nothing', () => {
    const receipt = buildReceipt(ctxWith({ agentType: 'artibot:tdd-guide', text: 'aaa bbb ccc' }));
    // The receipt still exists: the agent table identified the action.
    expect(receipt.action.type).toBe('implement');
    expect(receipt.requested_task).toEqual({ class: null, source: 'unmeasured' });
  });

  it('does not depend on the agent type — same text, same requested_task', () => {
    const text = 'find the root cause of the flake';
    const a = buildReceipt(ctxWith({ agentType: 'artibot:doc-updater', text }));
    const b = buildReceipt(ctxWith({ agentType: 'artibot:tdd-guide', text }));
    expect(a.action.type).not.toBe(b.action.type);
    expect(a.requested_task).toEqual({ class: 'complex-debug', source: 'text' });
    expect(b.requested_task).toEqual(a.requested_task);
  });
});

describe('route-observe-pre — route-receipt.schema.json admits the keys, closed', () => {
  const receipt = () => buildReceipt({
    toolUseId: 'toolu_schema',
    sessionId: 'sess-schema',
    missionId: 'M-20260928-Sabcdefgh',
    agentType: 'artibot:doc-updater',
    text: 'Review existing documentation',
    config: undefined,
    requestedModel: 'sonnet',
  });

  /** Both validators — ajv (the oracle) and the ledger writer's subset. */
  const verdicts = (data) => ({
    ajv: validateRoute(data),
    writer: validateAgainstSchema(data, ROUTE_SCHEMA) === null,
  });

  it('accepts every shape the hook emits, on both validators', () => {
    const base = receipt();
    for (const data of [
      base,
      { ...base, requested_model: null },
      { ...base, requested_model: 'y'.repeat(128) },
      { ...base, requested_task: { class: null, source: 'unmeasured' } },
    ]) {
      expect(verdicts(data)).toEqual({ ajv: true, writer: true });
    }
  });

  it('keeps a receipt written before these keys existed valid', () => {
    const { requested_model: _rm, requested_task: _rt, ...old } = receipt();
    expect(verdicts(old)).toEqual({ ajv: true, writer: true });
    expect(ROUTE_SCHEMA.required).not.toContain('requested_model');
    expect(ROUTE_SCHEMA.required).not.toContain('requested_task');
  });

  it('rejects a bogus source, an extra nested key, and out-of-bounds model strings', () => {
    const base = receipt();
    const bad = {
      'bogus source': { ...base, requested_task: { class: 'review', source: 'bogus' } },
      'extra nested key': { ...base, requested_task: { class: 'review', source: 'text', why: 'x' } },
      'unknown class': { ...base, requested_task: { class: 'reviewing', source: 'text' } },
      'missing source': { ...base, requested_task: { class: 'review' } },
      'empty model': { ...base, requested_model: '' },
      'non-string model': { ...base, requested_model: 7 },
    };
    for (const [label, data] of Object.entries(bad)) {
      expect(verdicts(data), label).toEqual({ ajv: false, writer: false });
    }
  });

  it('bounds the model string at 128 under ajv; the writer does not run maxLength', () => {
    // MEASURED GAP, written next to the gate (rules §9): `lib/runtime/
    // ledger-schema.js` enforces minLength but not maxLength, and does not list
    // it in UNCHECKED_SCHEMA_KEYWORDS either. The hook's own 128-char slice is
    // what keeps a live row inside the bound; this pins both halves so a writer
    // that starts enforcing maxLength turns this red and gets noticed.
    const over = { ...receipt(), requested_model: 'z'.repeat(129) };
    expect(verdicts(over)).toEqual({ ajv: false, writer: true });
  });

  it('ties unmeasured to a null class under ajv (the writer skips if/then, declared)', () => {
    const base = receipt();
    expect(validateRoute({ ...base, requested_task: { class: 'review', source: 'unmeasured' } }))
      .toBe(false);
    expect(validateRoute({ ...base, requested_task: { class: null, source: 'text' } })).toBe(false);
  });

  it('closes requested_task.class to the same eight classes as action.type, plus null', () => {
    const actionClasses = ROUTE_SCHEMA.properties.action.properties.type.enum;
    const taskClass = ROUTE_SCHEMA.properties.requested_task.properties.class;
    expect(taskClass.enum).toEqual([...actionClasses, null]);
    expect(ROUTE_SCHEMA.properties.requested_task.additionalProperties).toBe(false);
    expect(ROUTE_SCHEMA.properties.requested_task.properties.source.enum)
      .toEqual(['text', 'unmeasured']);
  });

  it('says in the schema that requested_model is not evidence of what served', () => {
    const { description } = ROUTE_SCHEMA.properties.requested_model;
    expect(description).toMatch(/tool_input\.model/);
    expect(description).toMatch(/NOT evidence/);
    // And the prediction is labelled as one — the old "actually used/ran" claim is gone.
    const selected = ROUTE_SCHEMA.properties.models.properties.selected.description;
    expect(selected).toMatch(/POLICY PREDICTION/);
    expect(selected).not.toMatch(/actually used/);
    expect(ROUTE_SCHEMA.properties.action.properties.type.description)
      .not.toMatch(/actually ran/);
  });
});
