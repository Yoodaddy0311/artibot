/**
 * `scripts/hooks/_hook-fired-record.js` — the `hook.fired` WRITER.
 *
 * WHY THIS SUITE EXISTS. `lib/replay/existence-audit.js#CARRIERS.hooks` was
 * null: no registered event named a hook in any `data` field, so the CLAUDE.md
 * Existence Audit rule could not be evaluated for a single hook. This suite
 * pins the writer that closes that gap, at two levels:
 *
 *   1. `buildHookFiredEnvelope` IN PROCESS — the omit/null decisions, the
 *      action_id precedence and the failed-subset arithmetic live in the return
 *      value and nowhere else (the module is mute by design).
 *   2. `appendLedgerEvent` ROUND TRIP against a `mkdtemp` + `git init` sandbox
 *      — proves the envelope survives BOTH validation layers, because a
 *      rejected line is still a WRITTEN line (`ledger.rejected`) and a suite
 *      that only counted rows would read a rejection as a success.
 *
 * NO PROCESS SPAWNS HERE, deliberately. The dispatcher round trip needs a
 * dispatcher spawn, which `tests/firewall/dispatcher-cwd-sandbox-required.test.js`
 * admits only from files on its `KNOWN_DISPATCHER_SPAWNERS` ratchet; it lives in
 * `tests/dispatcher/posttooluse-dispatcher.test.js`, which is already on it.
 *
 * EVERY CASE RUNS IN A `mkdtemp` SANDBOX WITH ITS OWN `.git`. After ADR-011 the
 * ledger lives inside the git common dir, so a sandbox without one resolves to
 * an ancestor — which is how a test writes into the real store it is measuring.
 *
 * THE UNDERSCORE IN THE FILENAME IS ON PURPOSE. It mirrors the module under
 * test, and `scripts/hooks/stop-review-gate.js:362` exempts `_`-prefixed
 * basenames from the review gate.
 *
 * WHAT THIS FILE DOES NOT PROVE (rules §9 — write it next to the gate):
 *   - THAT ANY DISPATCHER CALLS IT. Every `results` array below is SYNTHETIC.
 *     The six call sites are measured elsewhere — each slot's own dispatcher
 *     suite spawns the real process and reads the row back, and
 *     `tests/dispatcher/hook-fired-wiring.test.js` pins the wiring statically
 *     — so a `slot: 'Stop'` case here proves the writer accepts the value,
 *     never that a Stop dispatch produces one.
 *   - ANY LIVE FIRING RATE. Nothing here says how often a dispatch happens.
 *   - THAT THE NAMES MATCH REAL FILES. Names are recorded raw; whether a name
 *     resolves to a script is the audit's question, not the writer's.
 *
 * @module tests/hooks/_hook-fired-record
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { appendLedgerEvent, ledgerFilePath } from '../../lib/runtime/ledger.js';
import {
  buildEnvelope, lineBytes, validateEnvelope, validateEventContract,
} from '../../lib/runtime/event-writer.js';
import {
  buildHookFiredEnvelope, HOOK_FIRED_EVENT, recordHookFired,
} from '../../scripts/hooks/_hook-fired-record.js';

/** >= 8 alphanumerics so the session fallback mission id is issuable. */
const SESSION_ID = 'sess-hook-fired-record-fixture-0001';
const TOOL_USE_ID = 'toolu_01HookFiredRecordFixture';
const PROMPT_ID = 'prompt_01HookFiredRecordFixture';

/** The six handlers a real PostToolUse Edit dispatch selects. */
const EDIT_HOOKS = [
  'quality-gate', 'post-edit-format', 'post-edit-recovery',
  'post-write-tdd', 'mark-main-agent-edit', 'tool-tracker',
];

let tmp;
let repo;

/** `spawnHook`-shaped results, all ok. */
function okResults(names = EDIT_HOOKS) {
  return names.map((name) => ({ name, status: 'ok', stdout: '' }));
}

function payload(over = {}) {
  return {
    hook_event_name: 'PostToolUse',
    session_id: SESSION_ID,
    cwd: repo,
    tool_name: 'Edit',
    tool_use_id: TOOL_USE_ID,
    ...over,
  };
}

/** Parsed ledger lines for a sandbox root, `[]` when the file was never made. */
function readLedger(root) {
  const file = ledgerFilePath(root);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'artibot-hook-fired-')));
  repo = path.join(tmp, 'repo');
  mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore', windowsHide: true });
});

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe('buildHookFiredEnvelope', () => {
  it('folds one dispatch into one row with hooks, failed and count', () => {
    const env = buildHookFiredEnvelope({
      slot: 'PostToolUse', payload: payload(), results: okResults(), tool: 'Edit',
    });
    expect(env.event).toBe(HOOK_FIRED_EVENT);
    expect(env.source).toBe('hook');
    expect(env.session_id).toBe(SESSION_ID);
    expect(env.data.slot).toBe('PostToolUse');
    expect(env.data.hooks).toEqual(EDIT_HOOKS);
    expect(env.data.failed).toEqual([]);
    expect(env.data.count).toBe(6);
    expect(env.data.tool).toBe('Edit');
  });

  it('records failed as the subset whose status is not ok', () => {
    const env = buildHookFiredEnvelope({
      slot: 'PostToolUse',
      payload: payload(),
      results: [
        { name: 'quality-gate', status: 'ok' },
        { name: 'post-edit-format', status: 'timeout' },
        { name: 'tool-tracker', status: 'error' },
      ],
    });
    expect(env.data.hooks).toEqual(['quality-gate', 'post-edit-format', 'tool-tracker']);
    expect(env.data.failed).toEqual(['post-edit-format', 'tool-tracker']);
    expect(env.data.count).toBe(3);
  });

  it('keeps names RAW — no normalisation, no extension stripping', () => {
    const env = buildHookFiredEnvelope({
      slot: 'SessionStart',
      payload: payload({ hook_event_name: 'SessionStart' }),
      results: [{ name: 'Session_Start.JS', status: 'ok' }],
    });
    expect(env.data.hooks).toEqual(['Session_Start.JS']);
  });

  it('OMITS tool rather than writing null when there is none', () => {
    for (const tool of [null, undefined, '', '   ', 7]) {
      const env = buildHookFiredEnvelope({
        slot: 'Stop', payload: payload(), results: okResults(['stop-review-gate']), tool,
      });
      expect(Object.prototype.hasOwnProperty.call(env.data, 'tool')).toBe(false);
    }
  });

  it('action_id precedence: tool_use_id > prompt_id > omitted', () => {
    const both = buildHookFiredEnvelope({
      slot: 'PostToolUse',
      payload: payload({ prompt_id: PROMPT_ID }),
      results: okResults(),
    });
    expect(both.action_id).toBe(TOOL_USE_ID);

    const promptOnly = buildHookFiredEnvelope({
      slot: 'UserPromptSubmit',
      payload: payload({ tool_use_id: undefined, prompt_id: PROMPT_ID }),
      results: okResults(),
    });
    expect(promptOnly.action_id).toBe(PROMPT_ID);

    const neither = buildHookFiredEnvelope({
      slot: 'Stop',
      payload: payload({ tool_use_id: '', prompt_id: '  ' }),
      results: okResults(),
    });
    expect(Object.prototype.hasOwnProperty.call(neither, 'action_id')).toBe(false);
  });

  it('skips result entries that name nothing, and count follows hooks.length', () => {
    const env = buildHookFiredEnvelope({
      slot: 'PostToolUse',
      payload: payload(),
      results: [
        { name: 'tool-tracker', status: 'ok' },
        { name: '', status: 'ok' },
        { status: 'error' },
        null,
        { name: 42, status: 'ok' },
      ],
    });
    expect(env.data.hooks).toEqual(['tool-tracker']);
    expect(env.data.count).toBe(1);
  });

  it('returns null when slot, session, payload or results is unusable', () => {
    const base = { slot: 'PostToolUse', payload: payload(), results: okResults() };
    expect(buildHookFiredEnvelope({ ...base, slot: undefined })).toBeNull();
    expect(buildHookFiredEnvelope({ ...base, slot: '' })).toBeNull();
    expect(buildHookFiredEnvelope({ ...base, slot: 12 })).toBeNull();
    expect(buildHookFiredEnvelope({ ...base, results: undefined })).toBeNull();
    expect(buildHookFiredEnvelope({ ...base, results: 'quality-gate' })).toBeNull();
    expect(buildHookFiredEnvelope({ ...base, payload: null })).toBeNull();
    expect(buildHookFiredEnvelope({ ...base, payload: [] })).toBeNull();
    expect(buildHookFiredEnvelope({ ...base, payload: { cwd: '/x' } })).toBeNull();
    expect(buildHookFiredEnvelope()).toBeNull();
  });

  it('accepts sessionId as the camelCase alias', () => {
    const env = buildHookFiredEnvelope({
      slot: 'Stop',
      payload: { sessionId: SESSION_ID, cwd: repo },
      results: okResults(['stop-review-gate']),
    });
    expect(env.session_id).toBe(SESSION_ID);
  });

  it('an empty results array is still a row — zero handlers NAMED, not zero dispatch', () => {
    const env = buildHookFiredEnvelope({ slot: 'Stop', payload: payload(), results: [] });
    expect(env.data.hooks).toEqual([]);
    expect(env.data.count).toBe(0);
  });
});

describe('contract layer', () => {
  it('validateEnvelope and validateEventContract both accept the envelope', () => {
    const env = buildEnvelope(buildHookFiredEnvelope({
      slot: 'PostToolUse', payload: payload(), results: okResults(), tool: 'Edit',
    }));
    expect(validateEnvelope(env)).toBeNull();
    expect(validateEventContract(env)).toBeNull();
    // Well under the 4,096 B cap, so a real dispatch never folds.
    expect(lineBytes(env)).toBeLessThan(1024);
  });
});

describe('recordHookFired', () => {
  it('round trips one accepted hook.fired row, with no rejection', () => {
    const res = recordHookFired({
      slot: 'PostToolUse', payload: payload(), results: okResults(), tool: 'Edit',
    });
    expect(res).toEqual({ ok: true, folded: false });

    const lines = readLedger(repo);
    expect(lines.filter((l) => l.event === 'ledger.rejected')).toEqual([]);
    const rows = lines.filter((l) => l.event === HOOK_FIRED_EVENT);
    expect(rows).toHaveLength(1);
    expect(rows[0].data.hooks).toEqual(EDIT_HOOKS);
    expect(rows[0].data.count).toBe(6);
    expect(rows[0].data.failed).toEqual([]);
    expect(rows[0].data.tool).toBe('Edit');
    expect(rows[0].action_id).toBe(TOOL_USE_ID);
    expect(rows[0].source).toBe('hook');
  });

  it('writes nothing and fails closed when the payload names no cwd', () => {
    const res = recordHookFired({
      slot: 'PostToolUse',
      payload: payload({ cwd: undefined }),
      results: okResults(),
    });
    expect(res).toEqual({ ok: false, reason: 'no-cwd' });
    expect(readLedger(repo)).toEqual([]);
  });

  it('returns not-recordable, and writes nothing, for an unusable call', () => {
    expect(recordHookFired({ slot: '', payload: payload(), results: [] }))
      .toEqual({ ok: false, reason: 'not-recordable' });
    expect(readLedger(repo)).toEqual([]);
  });

  it('never throws on garbage, and never returns undefined', () => {
    const garbage = [
      undefined, null, 0, 'PostToolUse', [], { slot: {}, payload: 1, results: {} },
      { slot: 'Stop', payload: { session_id: SESSION_ID, cwd: 12 }, results: [] },
      { slot: 'Stop', payload: { session_id: 'short', cwd: repo }, results: [] },
    ];
    for (const args of garbage) {
      let out;
      expect(() => { out = recordHookFired(args); }).not.toThrow();
      expect(out.ok).toBe(false);
      expect(typeof out.reason).toBe('string');
    }
  });

  it('two dispatches append two rows — the fold is per dispatch, not per session', () => {
    recordHookFired({ slot: 'PostToolUse', payload: payload(), results: okResults(), tool: 'Edit' });
    recordHookFired({
      slot: 'PostToolUse',
      payload: payload({ tool_name: 'Bash', tool_use_id: 'toolu_01Second' }),
      results: okResults(['post-bash', 'post-bash-failure', 'tool-tracker']),
      tool: 'Bash',
    });
    const rows = readLedger(repo).filter((l) => l.event === HOOK_FIRED_EVENT);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.data.count)).toEqual([6, 3]);
    expect(rows[1].data.tool).toBe('Bash');
  });

  it('a directly appended row is accepted by the writer, arrays and all', () => {
    const result = appendLedgerEvent(repo, buildHookFiredEnvelope({
      slot: 'SubagentStop',
      payload: payload({ hook_event_name: 'SubagentStop' }),
      results: [{ name: 'subagent-stop-a', status: 'timeout' }],
    }));
    expect(result.ok).toBe(true);
    const rows = readLedger(repo).filter((l) => l.event === HOOK_FIRED_EVENT);
    expect(rows).toHaveLength(1);
    expect(rows[0].data.failed).toEqual(['subagent-stop-a']);
  });
});
