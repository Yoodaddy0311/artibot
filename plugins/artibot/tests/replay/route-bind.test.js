/**
 * Unit contract for the receipt ↔ bind join (`lib/replay/route-bind.js`).
 *
 * ── WHAT THIS SUITE CANNOT SEE (repo rules §9) ──────────────────────────────
 *   - ZERO LIVE LINES. Every receipt and bind below is hand-built in the shape
 *     `route-observe-pre.js` and `subagent-handler.js#bindRoute` write; nothing
 *     here was read from a real ledger. The tree that landed this file did
 *     produce live lines once its review agents spawned (2026-09-05 02:34:
 *     3 receipts, 3 binds, all bound, 0 conflicts — pinned in
 *     `commands/doctor.md` Check 10), but nothing below reads them.
 *   - WHETHER A BOUND PAIR IS RIGHT. The join reports what bound; these tests
 *     pin the arithmetic, never that a FIFO bind picked the right receipt.
 *   - FIXTURE SCALE. Single-digit lines; nothing about the join at size.
 *
 * @module tests/replay/route-bind
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildReplay,
  countUnboundSpawns,
  isPreToolUseReceipt,
  joinRouteBinds,
  serializeIndex,
  TOOL_USE_SHADOW_PREFIX,
  UNBOUND_ROUTE_LEDGER,
} from '../../lib/replay/index.js';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SID = 'sess-bind-0001';
const MISSION = 'M-20260905-001';

let seqCounter = 0;

/** A minimal, well-formed envelope around `fields`. */
function line(fields, ts = '2026-09-05T02:00:00.000Z') {
  seqCounter += 1;
  return {
    v: 1, ts, mission_id: MISSION, session_id: SID, source: 'hook', pid: 4242, seq: seqCounter,
    ...fields,
  };
}

/** A PreToolUse receipt for `toolUseId`, as route-observe-pre.js writes it. */
function receipt(toolUseId, extra = {}, ts) {
  return line({
    event: 'route.selected',
    routing_epoch_id: toolUseId,
    action_id: toolUseId,
    data: { shadow_of: `tool_use:${toolUseId}`, action: { type: 'implement' } },
    ...extra,
  }, ts);
}

/** A bind for (`toolUseId`, `agentId`), as bindRoute writes it. */
function bind(toolUseId, agentId, extra = {}, ts) {
  return line({
    event: 'route.bound',
    routing_epoch_id: agentId,
    run_id: agentId,
    action_id: toolUseId,
    data: {
      tool_use_id: toolUseId, agent_id: agentId, confidence: 'exact', method: 'prompt_id+name',
    },
    ...extra,
  }, ts);
}

function shuffled(arr) {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = (i * 7919) % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

describe('isPreToolUseReceipt()', () => {
  it('accepts the shape route-observe-pre.js writes', () => {
    expect(isPreToolUseReceipt(receipt('tu-1'))).toBe(true);
  });

  it('rejects the retired SubagentStart receipt shape and malformed lines', () => {
    expect(isPreToolUseReceipt(receipt('tu-1', { data: { shadow_of: 'spawn:a1' } }))).toBe(false);
    expect(isPreToolUseReceipt(receipt('', {}))).toBe(false);
    expect(isPreToolUseReceipt(line({ event: 'route.selected' }))).toBe(false);
    expect(isPreToolUseReceipt(line({ event: 'tool.used' }))).toBe(false);
    expect(isPreToolUseReceipt(null)).toBe(false);
  });

  it('restates the two hook literals it cannot import', () => {
    // subagent-handler.js is a script; L2 cannot import it. Pin the spelling.
    const handler = readFileSync(path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'subagent-handler.js'), 'utf-8');
    expect(handler).toContain(`'${TOOL_USE_SHADOW_PREFIX}'`);
    expect(handler).toContain(`'${UNBOUND_ROUTE_LEDGER}'`);
  });
});

describe('joinRouteBinds()', () => {
  it('pairs a receipt with its bind and reports nothing left over', () => {
    const j = joinRouteBinds([receipt('tu-1'), bind('tu-1', 'agent-a')]);
    expect(j.receipts).toBe(1);
    expect(j.binds).toBe(1);
    expect(j.bound).toHaveLength(1);
    expect(j.bound[0]).toMatchObject({ tool_use_id: 'tu-1', agent_id: 'agent-a', confidence: 'exact' });
    expect(j.unbound_receipts).toEqual([]);
    expect(j.orphan_binds).toEqual([]);
    expect(j.conflicts).toEqual([]);
    expect(j.by_session).toEqual({ [SID]: { receipts: 1, binds: 1, bound: 1, unbound_receipts: 0, orphan_binds: 0 } });
  });

  it('lists a receipt no bind names as unbound', () => {
    const j = joinRouteBinds([receipt('tu-1'), receipt('tu-2'), bind('tu-1', 'agent-a')]);
    expect(j.unbound_receipts.map((r) => r.tool_use_id)).toEqual(['tu-2']);
    expect(j.by_session[SID].unbound_receipts).toBe(1);
  });

  it('lists a bind whose receipt is not in the input as an orphan, not a conflict', () => {
    const j = joinRouteBinds([bind('tu-gone', 'agent-a')]);
    expect(j.orphan_binds.map((b) => b.tool_use_id)).toEqual(['tu-gone']);
    expect(j.bound).toEqual([]);
    expect(j.conflicts).toEqual([]);
  });

  it('reports invariant-1 violations in both directions', () => {
    const j = joinRouteBinds([
      receipt('tu-1'), receipt('tu-2'),
      bind('tu-1', 'agent-a'), bind('tu-1', 'agent-b'), // one tool_use bound twice
      bind('tu-2', 'agent-a'), // one agent bound twice (tu-1 and tu-2)
    ]);
    expect(j.conflicts).toEqual([
      { type: 'tool_use_bound_twice', tool_use_id: 'tu-1', agent_ids: ['agent-a', 'agent-b'], count: 2 },
      { type: 'agent_bound_twice', agent_id: 'agent-a', tool_use_ids: ['tu-1', 'tu-2'], count: 2 },
    ]);
  });

  it('reports a receipt written twice as a conflict and keeps the first', () => {
    const j = joinRouteBinds([receipt('tu-1'), receipt('tu-1')]);
    expect(j.receipts).toBe(1);
    expect(j.conflicts).toEqual([{ type: 'receipt_duplicate', tool_use_id: 'tu-1', session_id: SID }]);
  });

  it('ignores retired spawn-shaped receipts and malformed binds, and says so', () => {
    const j = joinRouteBinds([
      receipt('a1', { data: { shadow_of: 'spawn:a1' } }),
      line({ event: 'route.bound', data: { tool_use_id: 'tu-1' } }), // no agent_id
    ]);
    expect(j.receipts).toBe(0);
    expect(j.binds).toBe(0);
    expect(j.ignored).toEqual({ pre_tool_use_only: 1, malformed_binds: 1 });
  });

  it('is deterministic under input permutation', () => {
    const events = [
      receipt('tu-1', {}, '2026-09-05T02:00:01.000Z'), receipt('tu-2', {}, '2026-09-05T02:00:02.000Z'),
      receipt('tu-3', { session_id: 'sess-other' }, '2026-09-05T02:00:00.500Z'),
      bind('tu-1', 'agent-a', {}, '2026-09-05T02:00:03.000Z'), bind('tu-9', 'agent-z', {}, '2026-09-05T02:00:04.000Z'),
      bind('tu-2', 'agent-a', {}, '2026-09-05T02:00:05.000Z'),
    ];
    const straight = JSON.stringify(joinRouteBinds(events));
    for (let i = 0; i < 4; i += 1) {
      expect(JSON.stringify(joinRouteBinds(shuffled(events)))).toBe(straight);
    }
  });

  it('is embedded in buildReplay as route_binds and serializes identically', () => {
    const events = [receipt('tu-1'), bind('tu-1', 'agent-a'), receipt('tu-2')];
    const index = buildReplay(events);
    expect(index.route_binds.unbound_receipts.map((r) => r.tool_use_id)).toEqual(['tu-2']);
    expect(serializeIndex(buildReplay(shuffled(events)))).toBe(serializeIndex(index));
  });

  it('tolerates non-array and garbage input', () => {
    expect(joinRouteBinds(undefined).receipts).toBe(0);
    expect(joinRouteBinds([null, 1, 'x', {}]).binds).toBe(0);
  });
});

describe('countUnboundSpawns()', () => {
  const start = (agentId, routeLedger, sessionId = SID) => ({
    ts: '2026-09-05T02:00:00.000Z', sessionId, agentId, event: 'start', route_ledger: routeLedger,
  });
  const stop = (agentId, sessionId = SID) => ({
    ts: '2026-09-05T02:01:00.000Z', sessionId, agentId, event: 'stop',
  });

  it('counts distinct agent ids, not lines, on both axes', () => {
    const c = countUnboundSpawns([
      start('a1', UNBOUND_ROUTE_LEDGER), start('a1', UNBOUND_ROUTE_LEDGER), stop('a1'), // one spawn, twice
      start('a2', 'ok:bound'), stop('a2'),
      stop('a3'), // stop only — still one spawn, never unbound
    ]);
    expect(c).toMatchObject({ spawns: 3, unbound: 1, unbound_agent_ids: ['a1'] });
    expect(c.by_session).toEqual({ [SID]: { spawns: 3, unbound: 1 } });
  });

  it('reads route_ledger on start rows only', () => {
    const c = countUnboundSpawns([{ ...stop('a1'), route_ledger: UNBOUND_ROUTE_LEDGER }]);
    expect(c.unbound).toBe(0);
    expect(c.spawns).toBe(1);
  });

  it('scopes to one session when asked and buckets session-less records under null', () => {
    const records = [
      start('a1', UNBOUND_ROUTE_LEDGER, SID),
      start('b1', UNBOUND_ROUTE_LEDGER, 'sess-other'),
      start('c1', UNBOUND_ROUTE_LEDGER, null),
    ];
    expect(countUnboundSpawns(records, { sessionId: SID })).toMatchObject({ spawns: 1, unbound: 1 });
    const all = countUnboundSpawns(records);
    expect(all.unbound).toBe(3);
    expect(all.by_session.null).toEqual({ spawns: 1, unbound: 1 });
  });

  it('tolerates non-array and garbage input', () => {
    expect(countUnboundSpawns(undefined)).toMatchObject({ spawns: 0, unbound: 0 });
    expect(countUnboundSpawns([null, {}, { agentId: 3 }])).toMatchObject({ spawns: 0, unbound: 0 });
  });
});
