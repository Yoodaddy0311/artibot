import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  findSpawnSubagentType,
  readStopMeta,
  resolveStopIdentity,
  STOP_META_MAX_BYTES,
  STOP_SCAN_BYTES,
  STOP_SCAN_CHUNK_BYTES,
  STOP_SCAN_MAX_CANDIDATES,
  STOP_START_SLACK_MS,
  subagentTypeFromReceiptKey,
} from '../../lib/review/stop-identity.js';
import { receiptKey } from '../../scripts/hooks/route-observe-pre.js';

/**
 * `lib/review/stop-identity.js` — who was this SubagentStop, when the payload
 * only carries a teammate NAME?
 *
 * The pure pieces (receipt-key parse, meta reader, reverse tail scan, the
 * orchestrator) are driven here with synthetic files. The scan is the piece a
 * bug hides in, so it runs at chunk sizes smaller than one ledger line (the carry
 * across chunk boundaries), with multibyte text on the boundaries, at the window
 * edge, and past every cap. `tests/hooks/_review-stop-identity.test.js` drives the
 * same resolver through `isReviewerStop`, and
 * `tests/hooks/subagent-handler-review-identity.test.js` through the real handler.
 *
 * WHAT GREEN HERE DOES NOT PROVE: that a live ledger line has the shape these
 * builders write (the E2E file uses the real writers for that), that the cap fits
 * every reviewer (it is sized from a measurement, 2026-09-30, n=276 reviewer-ish
 * stops), or how fast a scan is on a real disk - no timing is asserted because a
 * wall-clock assertion is a flake; `bytesRead` is the bounded-work witness.
 */

const SID = 'sess-lib-stop-identity';
const PROMPT = 'pid-lib';
const HEX = '0123456789abcdef';

let tmp;

const selectedRow = ({ epoch, name = null, type, session = SID, ts = '2026-09-30T08:00:00.000Z' }) => {
  const row = {
    v: 1, ts, event: 'route.selected', session_id: session, source: 'hook', pid: 1, seq: 0,
    mission_id: 'M-20260930-Slibstop', routing_epoch_id: epoch, action_id: epoch, data: { shadow_of: `tool_use:${epoch}` },
  };
  if (name !== null) row.worker = name;
  row.idempotency_key = receiptKey(epoch, PROMPT, type);
  return row;
};

const boundRow = ({ agentId, epoch, name = 'n', subagentType, confidence = 'exact', session = SID }) => ({
  v: 1, ts: '2026-09-30T08:00:02.000Z', event: 'route.bound', session_id: session, source: 'hook', pid: 1, seq: 0,
  mission_id: 'M-20260930-Slibstop', routing_epoch_id: agentId, run_id: agentId, action_id: epoch,
  data: {
    tool_use_id: epoch, agent_id: agentId, confidence, method: 'prompt_id+name', agent_type: name,
    ...(subagentType === undefined ? {} : { subagent_type: subagentType }),
  },
});

/** A `hook.fired` filler row with optional multibyte text, ~330 B like the live ones. */
const fillerRow = (i, note = '') => ({
  v: 1, ts: '2026-09-30T08:30:00.000Z', event: 'hook.fired', session_id: SID, source: 'hook', pid: 2, seq: 0,
  mission_id: 'M-20260930-Slibstop',
  data: { slot: 'PostToolUse', hooks: ['quality-gate', 'post-edit-format'], failed: [], count: 2, tool: 'Edit', i, note },
  action_id: `toolu_filler${i}`,
});

const fillerLines = (count, note = '') => Array.from({ length: count }, (_, i) => `${JSON.stringify(fillerRow(i, note))}\n`);
const linesOf = (rows) => rows.map((r) => `${JSON.stringify(r)}\n`);
const bytes = (lines) => lines.reduce((n, l) => n + Buffer.byteLength(l), 0);

/** Write raw text (already newline-terminated lines) and return the path. */
function writeRaw(lines, name = 'ledger.jsonl') {
  const file = path.join(tmp, name);
  writeFileSync(file, Array.isArray(lines) ? lines.join('') : lines, 'utf-8');
  return file;
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'artibot-lib-stop-identity-')));
});
afterEach(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
});

describe('constants are the measured ones', () => {
  it('sizes the window from the measurement, not from the 128 KB receipt-scan default', () => {
    // reviewer-ish p99 1,378,829 B, max 1,465,464 B (n=276); all spawns p99 3,385,771 B,
    // max 4,971,110 B (n=1,216): bytes between a spawn's bind row and its stop. A 128 KB window
    // covers 54.3% of the reviewer-ish stops and 43.3% of all; 8 MiB covers 100% of both.
    expect(STOP_SCAN_BYTES).toBe(8 * 1024 * 1024);
    expect(STOP_SCAN_BYTES).toBeGreaterThan(4_971_110);
    expect(STOP_SCAN_BYTES).toBeGreaterThan(3_385_771);
    expect(STOP_SCAN_BYTES).toBeGreaterThan(1_465_464);
    expect(STOP_SCAN_CHUNK_BYTES).toBe(256 * 1024);
    expect(STOP_SCAN_MAX_CANDIDATES).toBe(512);
    expect(STOP_META_MAX_BYTES).toBe(65536);
    expect(STOP_START_SLACK_MS).toBe(1000);
  });
});

describe('subagentTypeFromReceiptKey', () => {
  it.each([
    ['route.pre:toolu_01A:pid-1:artibot:code-reviewer', 'toolu_01A', 'artibot:code-reviewer'],
    ['route.pre:toolu_01A:pid-1:general-purpose', 'toolu_01A', 'general-purpose'],
    ['route.pre:toolu_01A::general-purpose', 'toolu_01A', 'general-purpose'],
    ['route.pre:toolu_01A:pid-1:a:b:c', 'toolu_01A', 'a:b:c'],
  ])('%s -> %s', (key, epoch, expected) => {
    expect(subagentTypeFromReceiptKey(key, epoch)).toBe(expected);
  });

  it.each([
    ['route.pre:toolu_01A:pid-1:', 'toolu_01A'],
    ['route.pre:toolu_01A:pid-1', 'toolu_01A'],
    ['route.pre:toolu_01A', 'toolu_01A'],
    ['route.pre:toolu_OTHER:pid-1:artibot:code-reviewer', 'toolu_01A'],
    ['spawn:agent-1', 'toolu_01A'],
    ['route.pre:toolu_01A:pid-1:x', ''],
    [undefined, 'toolu_01A'],
    [42, 'toolu_01A'],
    ['route.pre:toolu_01A:pid-1:x', undefined],
  ])('%s with epoch %s is not a key this reader may trust -> null', (key, epoch) => {
    expect(subagentTypeFromReceiptKey(key, epoch)).toBeNull();
  });

  it('round-trips the WRITER: route-observe-pre.js#receiptKey', () => {
    for (const [epoch, prompt, type] of [
      ['toolu_01', 'pid', 'artibot:code-reviewer'], ['toolu_02', null, 'auditor'], ['toolu_03', 'p', 'artibot-cowork:doc-updater'],
    ]) {
      expect(subagentTypeFromReceiptKey(receiptKey(epoch, prompt, type), epoch)).toBe(type);
    }
    expect(subagentTypeFromReceiptKey(receiptKey('toolu_04', 'pid', null), 'toolu_04')).toBeNull();
  });
});

describe('readStopMeta', () => {
  const metaFor = (meta, { raw = null, suffix = '.meta.json' } = {}) => {
    const dir = path.join(tmp, 'subagents');
    mkdirSync(dir, { recursive: true });
    const transcript = path.join(dir, 'agent-a1.jsonl');
    writeFileSync(transcript, '', 'utf-8');
    writeFileSync(path.join(dir, `agent-a1${suffix}`), raw ?? JSON.stringify(meta), 'utf-8');
    return transcript;
  };
  const NONE = { agentType: null, customAgentType: null };

  it('reads agentType and customAgentType from the sibling meta file', () => {
    expect(readStopMeta(metaFor({ agentType: 'rv-w36', customAgentType: 'code-reviewer', name: 'rv-w36' })))
      .toEqual({ agentType: 'rv-w36', customAgentType: 'code-reviewer' });
  });

  it('reports a missing key as null, per key', () => {
    expect(readStopMeta(metaFor({ agentType: 'general-purpose' }))).toEqual({ agentType: 'general-purpose', customAgentType: null });
  });

  it.each([
    ['a path that is not a .jsonl', () => path.join(tmp, 'agent-a1.txt')],
    ['a missing meta file', () => path.join(tmp, 'nowhere', 'agent-a1.jsonl')],
    ['garbled JSON', () => metaFor(null, { raw: '{not json' })],
    ['a JSON array', () => metaFor(null, { raw: '[1,2]' })],
    ['a JSON scalar', () => metaFor(null, { raw: '"agentType"' })],
    ['an oversize file', () => metaFor(null, { raw: JSON.stringify({ agentType: 'x'.repeat(STOP_META_MAX_BYTES) }) })],
    ['a DIRECTORY at the meta path', () => {
      const dir = path.join(tmp, 'subagents2');
      mkdirSync(path.join(dir, 'agent-a2.meta.json'), { recursive: true });
      return path.join(dir, 'agent-a2.jsonl');
    }],
  ])('%s yields no value', (_label, make) => {
    expect(readStopMeta(make())).toEqual(NONE);
  });

  it('treats non-string and empty keys as no value, and non-strings as a path it cannot read', () => {
    expect(readStopMeta(metaFor({ agentType: 7, customAgentType: '' }))).toEqual(NONE);
    for (const v of [undefined, null, 5, {}, '', []]) expect(readStopMeta(v)).toEqual(NONE);
  });
});

describe('findSpawnSubagentType - the reverse tail scan', () => {
  const AGENT = `areview-f1-${HEX}`;
  const trail = ({ type = 'artibot:code-reviewer', name = 'review-f1', epoch = 'toolu_01AAAA', boundType = true } = {}) => [
    selectedRow({ epoch, name, type }),
    boundRow({ agentId: AGENT, epoch, name, subagentType: boundType ? type : undefined }),
  ];
  const find = (file, query = {}, opts = {}) => findSpawnSubagentType(
    file, { agentId: AGENT, name: 'review-f1', sessionId: SID, ...query }, opts,
  );

  it('resolves through the bind row when it carries subagent_type', () => {
    const r = find(writeRaw(linesOf(trail())));
    expect(r).toMatchObject({ type: 'artibot:code-reviewer', source: 'route.bound' });
  });

  it('resolves bind -> selected when the bind row has no subagent_type (every row before 2026-09-30)', () => {
    const r = find(writeRaw(linesOf(trail({ boundType: false }))));
    expect(r).toMatchObject({ type: 'artibot:code-reviewer', source: 'route.bound>route.selected' });
  });

  it('falls back to the name join with no bind row, taking the MOST RECENT same-session row', () => {
    const file = writeRaw(linesOf([
      selectedRow({ epoch: 'toolu_01', name: 'review-f1', type: 'artibot:tdd-guide' }),
      selectedRow({ epoch: 'toolu_02', name: 'review-f1', type: 'artibot:code-reviewer' }),
    ]));
    expect(find(file, { agentId: null })).toMatchObject({ type: 'artibot:code-reviewer', source: 'route.selected:worker' });
  });

  it('the exact join wins over the name join even when they disagree', () => {
    const file = writeRaw(linesOf([
      ...trail({ type: 'artibot:code-reviewer', epoch: 'toolu_01' }),
      selectedRow({ epoch: 'toolu_99', name: 'review-f1', type: 'artibot:frontend-developer' }),
    ]));
    expect(find(file)).toMatchObject({ type: 'artibot:code-reviewer', source: 'route.bound' });
  });

  it('ignores a FIFO (or unlabelled) bind and lets the name join answer', () => {
    for (const confidence of ['fifo', null, 'guess']) {
      const file = writeRaw(linesOf([
        selectedRow({ epoch: 'toolu_01', name: 'other', type: 'artibot:code-reviewer' }),
        boundRow({ agentId: AGENT, epoch: 'toolu_01', subagentType: 'artibot:code-reviewer', confidence }),
        selectedRow({ epoch: 'toolu_02', name: 'review-f1', type: 'artibot:frontend-developer' }),
      ]));
      expect(find(file)).toMatchObject({ type: 'artibot:frontend-developer', source: 'route.selected:worker' });
    }
  });

  it('bounds the name join by the agent\'s START: a later same-name receipt is skipped, an unbounded query takes it', () => {
    const file = writeRaw(linesOf([
      selectedRow({ epoch: 'toolu_old', name: 'review-f1', type: 'artibot:code-reviewer', ts: '2026-09-30T08:00:00.000Z' }),
      selectedRow({ epoch: 'toolu_new', name: 'review-f1', type: 'artibot:frontend-developer', ts: '2026-09-30T09:00:00.000Z' }),
    ]));
    const started = Date.parse('2026-09-30T08:00:03.000Z');
    expect(find(file, { agentId: null, startedAtMs: started })).toMatchObject({ type: 'artibot:code-reviewer' });
    expect(find(file, { agentId: null })).toMatchObject({ type: 'artibot:frontend-developer' });
  });

  it('allows the START slack for clock granularity and not a millisecond more', () => {
    const started = Date.parse('2026-09-30T08:00:00.000Z');
    const at = (offsetMs) => writeRaw(linesOf([selectedRow({
      epoch: 'toolu_s', name: 'review-f1', type: 'artibot:code-reviewer', ts: new Date(started + offsetMs).toISOString(),
    })]), `slack${offsetMs}.jsonl`);
    expect(find(at(STOP_START_SLACK_MS), { agentId: null, startedAtMs: started })).toMatchObject({ type: 'artibot:code-reviewer' });
    expect(find(at(STOP_START_SLACK_MS + 1), { agentId: null, startedAtMs: started })).toMatchObject({ type: null });
  });

  it('never takes a name-join receipt whose timestamp is unreadable once a START bound is given', () => {
    const row = selectedRow({ epoch: 'toolu_bad', name: 'review-f1', type: 'artibot:code-reviewer' });
    row.ts = 'not a time';
    const file = writeRaw(linesOf([row]));
    expect(find(file, { agentId: null, startedAtMs: Date.parse('2026-09-30T08:00:03.000Z') })).toMatchObject({ type: null });
    expect(find(file, { agentId: null })).toMatchObject({ type: 'artibot:code-reviewer' });
  });

  it('does not use a row from another session for the name join, but the agent-id join needs no session', () => {
    const other = writeRaw(linesOf([selectedRow({ epoch: 'toolu_01', name: 'review-f1', type: 'artibot:code-reviewer', session: 'other' })]));
    expect(find(other, { agentId: null })).toMatchObject({ type: null });
    const bound = writeRaw(linesOf(trail()), 'bound.jsonl');
    expect(find(bound, { sessionId: 'a-different-session' })).toMatchObject({ type: 'artibot:code-reviewer' });
  });

  it('keeps looking for the selected row when the bind is found first, and gives up cleanly when it is gone', () => {
    const file = writeRaw(linesOf([boundRow({ agentId: AGENT, epoch: 'toolu_gone' })]));
    expect(find(file, { name: null })).toMatchObject({ type: null, source: null });
  });

  it('a trusted bind without a type falls back to the name join when the selected row is out of the file', () => {
    const file = writeRaw(linesOf([
      selectedRow({ epoch: 'toolu_zz', name: 'review-f1', type: 'artibot:spec-reviewer' }),
      boundRow({ agentId: AGENT, epoch: 'toolu_gone' }),
    ]));
    expect(find(file)).toMatchObject({ type: 'artibot:spec-reviewer', source: 'route.selected:worker' });
  });

  it.each([64, 97, 200, 1000, 4096, STOP_SCAN_CHUNK_BYTES])('finds the rows at chunk size %i - lines cross chunk boundaries', (chunkBytes) => {
    const note = '검수 결과 — 한글과 emoji 🚀 가 경계에 걸려도 깨지지 않는다';
    const file = writeRaw([
      ...fillerLines(30, note),
      ...linesOf(trail({ boundType: false })),
      ...fillerLines(60, note),
    ]);
    const r = find(file, {}, { chunkBytes });
    expect(r).toMatchObject({ type: 'artibot:code-reviewer', source: 'route.bound>route.selected' });
  });

  it('matches a multibyte teammate name at every chunk size', () => {
    const name = '검수-1';
    const file = writeRaw([
      ...fillerLines(20, '한글'),
      ...linesOf([selectedRow({ epoch: 'toolu_k', name, type: 'artibot:auditor' })]),
      ...fillerLines(40, '한글'),
    ]);
    for (const chunkBytes of [50, 101, 333, 4096]) {
      expect(find(file, { agentId: null, name }, { chunkBytes })).toMatchObject({ type: 'artibot:auditor' });
    }
  });

  it('finds the FIRST line of the file (no newline before it)', () => {
    // The name join is the only path that needs line 1 here: the selected row is the file's first line.
    const file = writeRaw([...linesOf(trail()), ...fillerLines(50)]);
    for (const chunkBytes of [64, 500, STOP_SCAN_CHUNK_BYTES]) {
      expect(find(file, { agentId: null }, { chunkBytes })).toMatchObject({
        type: 'artibot:code-reviewer', source: 'route.selected:worker',
      });
    }
  });

  it('reads the newest chunk only when the row is there (early exit), and never more than the cap when it is not', () => {
    const head = fillerLines(6000);
    const file = writeRaw([...head, ...linesOf(trail())]);
    const early = find(file, {}, { chunkBytes: 65536 });
    expect(early.type).toBe('artibot:code-reviewer');
    expect(early.bytesRead).toBeLessThanOrEqual(65536);
    expect(bytes(head)).toBeGreaterThan(1_500_000);

    const miss = find(file, { agentId: 'anobody-0000000000000000', name: 'nobody' }, { maxBytes: 300_000, chunkBytes: 65536 });
    expect(miss.type).toBeNull();
    expect(miss.bytesRead).toBeGreaterThan(0);
    // The cap, plus the ONE byte of look-behind that tells a cut line from a whole one.
    expect(miss.bytesRead).toBeLessThanOrEqual(300_000 + 1);
  });

  it('does not see a row older than the window, and drops the line the window edge cuts', () => {
    const rows = linesOf(trail());
    const tail = fillerLines(400);
    const file = writeRaw([...rows, ...tail]);
    const pastBoth = bytes(tail) + bytes(rows) + 10;
    expect(find(file, {}, { maxBytes: pastBoth, chunkBytes: 256 })).toMatchObject({ type: 'artibot:code-reviewer' });
    // The edge lands INSIDE the first row: its tail parses as nothing, and the cut line is dropped.
    const cutsIntoBound = bytes(tail) + Buffer.byteLength(rows[1]) - 5;
    expect(find(file, {}, { maxBytes: cutsIntoBound, chunkBytes: 256 })).toMatchObject({ type: null });
    // Only the bind row is inside the window, and it carries its own type.
    const onlyBound = bytes(tail) + Buffer.byteLength(rows[1]);
    expect(find(file, {}, { maxBytes: onlyBound, chunkBytes: 256 })).toMatchObject({ type: 'artibot:code-reviewer' });
  });

  it('stops at the candidate cap', () => {
    const noise = Array.from({ length: 50 }, (_, i) => selectedRow({ epoch: `toolu_n${i}`, name: 'review-f1', type: 'artibot:tdd-guide', session: 'other' }));
    const file = writeRaw([...linesOf([selectedRow({ epoch: 'toolu_hit', name: 'review-f1', type: 'artibot:code-reviewer' })]), ...linesOf(noise)]);
    expect(find(file, { agentId: null }, { maxCandidates: 10 })).toMatchObject({ type: null });
    expect(find(file, { agentId: null }, { maxCandidates: 100 })).toMatchObject({ type: 'artibot:code-reviewer' });
  });

  it('honours endOffset, the as-of seam: rows appended after it are invisible', () => {
    const early = linesOf(trail({ type: 'artibot:code-reviewer' }));
    const late = linesOf([selectedRow({ epoch: 'toolu_late', name: 'review-f1', type: 'artibot:frontend-developer' })]);
    const file = writeRaw([...early, ...late]);
    expect(find(file, { agentId: null })).toMatchObject({ type: 'artibot:frontend-developer' });
    expect(find(file, { agentId: null }, { endOffset: bytes(early) })).toMatchObject({ type: 'artibot:code-reviewer' });
  });

  it('skips a torn last line and corrupt lines instead of failing', () => {
    const file = writeRaw([
      ...linesOf(trail()),
      'garbage line\n',
      `{"event":"route.bound","data":{"agent_id":"${AGENT}"\n`,
      '{"v":1,"ts":"2026-09-30T09:00:00.000Z","event":"hook.fired","data":{"slot":"Post',
    ]);
    expect(find(file)).toMatchObject({ type: 'artibot:code-reviewer' });
  });

  it('never throws: missing file, directory, empty file, binary, one giant line, bad inputs', () => {
    const empty = writeRaw('', 'empty.jsonl');
    const binary = path.join(tmp, 'bin.jsonl');
    writeFileSync(binary, Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 37) % 256)));
    const giant = writeRaw(`${'x'.repeat(300_000)}\n`, 'giant.jsonl');
    for (const target of [path.join(tmp, 'nope.jsonl'), tmp, empty, binary, giant, undefined, null, 7, '']) {
      const r = find(target);
      expect(r.type).toBeNull();
    }
    const ok = writeRaw(linesOf(trail()), 'ok.jsonl');
    for (const query of [{ agentId: null, name: null }, { agentId: 'unknown', name: null }, { agentId: {}, name: [] }, null, undefined]) {
      expect(() => findSpawnSubagentType(ok, query)).not.toThrow();
    }
    expect(findSpawnSubagentType(ok, { agentId: 'unknown', name: null }).type).toBeNull();
  });
});

describe('resolveStopIdentity', () => {
  const AGENT = `areview-f1-${HEX}`;
  const accept = (type) => ['code-reviewer', 'spec-reviewer', 'quality-reviewer', 'auditor'].includes(type.split(':').pop());
  const trailFile = (type, boundType = true) => writeRaw(linesOf([
    selectedRow({ epoch: 'toolu_01', name: 'review-f1', type }),
    boundRow({ agentId: AGENT, epoch: 'toolu_01', name: 'review-f1', subagentType: boundType ? type : undefined }),
  ]));
  const stop = (over = {}) => ({ agentType: 'review-f1', agentId: AGENT, sessionId: SID, transcriptPath: null, ...over });
  const probe = (file) => {
    const calls = { n: 0 };
    return { calls, ports: { accept, ledgerPath: () => { calls.n += 1; return file; } } };
  };

  it('answers from the stop\'s own type with no I/O, through the injected allowlist', () => {
    const { calls, ports } = probe(trailFile('artibot:frontend-developer'));
    const r = resolveStopIdentity(stop({ agentType: 'artibot:code-reviewer' }), ports);
    expect(r).toMatchObject({ identity: 'artibot:code-reviewer', source: 'stop-type' });
    expect(calls.n).toBe(0);
  });

  it('answers from the host meta before it touches the ledger', () => {
    const dir = path.join(tmp, 'subagents');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'agent-a9.jsonl'), '', 'utf-8');
    writeFileSync(path.join(dir, 'agent-a9.meta.json'), JSON.stringify({ agentType: 'judge-1', customAgentType: 'code-reviewer' }), 'utf-8');
    const { calls, ports } = probe(trailFile('artibot:frontend-developer'));
    const r = resolveStopIdentity(stop({ agentType: 'judge-1', transcriptPath: path.join(dir, 'agent-a9.jsonl') }), ports);
    expect(r).toMatchObject({ identity: 'code-reviewer', source: 'meta.customAgentType' });
    expect(calls.n).toBe(0);
  });

  it('answers from the ledger join, naming the source, and lists every candidate it considered', () => {
    const { ports } = probe(trailFile('artibot:code-reviewer'));
    const r = resolveStopIdentity(stop(), ports);
    expect(r).toMatchObject({ identity: 'artibot:code-reviewer', source: 'route.bound' });
    expect(r.seen).toEqual([
      { source: 'stop-type', type: 'review-f1' },
      { source: 'route.bound', type: 'artibot:code-reviewer' },
    ]);
  });

  it('NEGATIVE CONTROL WITH EVIDENCE: a non-reviewer type is FOUND by the join and still not accepted', () => {
    const { ports } = probe(trailFile('artibot:frontend-developer'));
    const r = resolveStopIdentity(stop(), ports);
    expect(r.identity).toBeNull();
    expect(r.seen).toContainEqual({ source: 'route.bound', type: 'artibot:frontend-developer' });
  });

  it('applies only the injected allowlist: it cannot be widened from inside the resolver', () => {
    const { ports } = probe(trailFile('artibot:security-reviewer'));
    expect(resolveStopIdentity(stop(), ports).identity).toBeNull();
    expect(resolveStopIdentity(stop(), { ...ports, accept: () => true }).identity).toBe('review-f1');
  });

  it('does not fall back to the name join once the exact join has answered with a non-reviewer', () => {
    const file = writeRaw(linesOf([
      selectedRow({ epoch: 'toolu_x', name: 'review-f1', type: 'artibot:code-reviewer', session: SID }),
      selectedRow({ epoch: 'toolu_01', name: 'other', type: 'artibot:frontend-developer' }),
      boundRow({ agentId: AGENT, epoch: 'toolu_01', name: 'review-f1', subagentType: 'artibot:frontend-developer' }),
    ]));
    const { ports } = probe(file);
    expect(resolveStopIdentity(stop(), ports).identity).toBeNull();
  });

  it('hands the agent\'s START time to the name join', () => {
    const file = writeRaw(linesOf([
      selectedRow({ epoch: 'toolu_old', name: 'review-f1', type: 'artibot:code-reviewer', ts: '2026-09-30T08:00:00.000Z' }),
      selectedRow({ epoch: 'toolu_new', name: 'review-f1', type: 'artibot:frontend-developer', ts: '2026-09-30T09:00:00.000Z' }),
    ]));
    const { ports } = probe(file);
    const base = stop({ agentId: 'anobody-0000000000000000' });
    expect(resolveStopIdentity({ ...base, startedAtMs: Date.parse('2026-09-30T08:00:03.000Z') }, ports))
      .toMatchObject({ identity: 'artibot:code-reviewer', source: 'route.selected:worker' });
    expect(resolveStopIdentity(base, ports).identity).toBeNull();
  });

  it('never throws and always returns the same shape', () => {
    const shape = expect.objectContaining({ identity: null, source: null, seen: expect.any(Array) });
    expect(resolveStopIdentity(stop(), { accept: () => { throw new Error('boom'); }, ledgerPath: () => null })).toEqual(shape);
    expect(resolveStopIdentity(stop(), { accept, ledgerPath: () => { throw new Error('boom'); } })).toEqual(shape);
    expect(resolveStopIdentity(stop(), { accept, ledgerPath: () => path.join(tmp, 'nope.jsonl') })).toEqual(shape);
    expect(resolveStopIdentity(stop(), {})).toEqual(shape);
    for (const garbage of [undefined, null, 5, 'x', []]) {
      expect(resolveStopIdentity(garbage, { accept, ledgerPath: () => null })).toEqual(shape);
    }
  });

  it('skips the ledger stage when no ledger path can be named', () => {
    const { ports } = probe(null);
    expect(resolveStopIdentity(stop(), ports).identity).toBeNull();
  });
});
