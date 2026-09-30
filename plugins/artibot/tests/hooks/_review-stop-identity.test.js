import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ledgerFilePath } from '../../lib/runtime/ledger.js';
import { isReviewerStop } from '../../scripts/hooks/_review-stop-record.js';

/**
 * SH-05 / CA-17 / SH-02 root cause: a NAMED teammate is never recognised as a
 * reviewer at SubagentStop, so `review.completed` and `review.claim_audit` have
 * 0 rows in the whole ledger.
 *
 * THE MECHANISM, MEASURED (ledger copy 2026-09-30T09:54Z, 62,152 lines):
 * `subagent-handler.js#handleStop` gates the review path on
 * `isReviewerStop(effectiveType, identityOf)`. For a team spawn the host reports
 * `agent_type === <the teammate's NAME>` (`review-f1`, `rv-w36`,
 * `review-portable-a` ...), which the allowlist ('code-reviewer',
 * 'spec-reviewer', 'quality-reviewer', 'auditor' and the `-inspector` suffix)
 * can never match. The real definition type lives only in the spawn's
 * `route.bound` / `route.selected` rows. 0 of the 4 stop rows that ever carried
 * a `review_ledger` column belonged to a name like that; all 4 were
 * `team-*-inspector` names.
 *
 * THIS FILE drives `isReviewerStop` with the call-site context the handler now
 * passes as a THIRD argument. Every case writes its ledger rows in the shape a
 * live ledger has (compact JSON, `route.pre:<tool_use_id>:<prompt_id>:<type>`
 * key, `worker` = the spawn's name) and reads them through the real
 * `ledgerFilePath`, because "the join finds the row" is an on-disk fact.
 *
 * WHAT THE NEGATIVE CASES PROVE, AND THE ONE THING THEY CANNOT: they prove a name
 * whose receipt says `frontend-developer` (or `security-reviewer`, which is NOT
 * on the allowlist) stays excluded. They cannot prove the join FOUND that type
 * - an excluded name and an unresolvable name both return false. The pairing
 * with the positive rows (same fixture, only the type in the key differs) is
 * what makes them a control, and `tests/review/stop-identity.test.js` asserts the
 * resolver's `seen` list for the same shape.
 *
 * WHAT GREEN HERE DOES NOT PROVE: that the handler passes the context (that is
 * `subagent-handler-review-identity.test.js`, a child process), that a real
 * reviewer then emits a parseable verdict block (producer side, out of scope),
 * or how long a real reviewer runs relative to the tail window.
 */

const SID = 'sess-stop-identity';
const PROMPT = 'pid-stop-identity';
const HEX = '0123456789abcdef';

/** Every identity normaliser the handler injects is this one. */
const identityOf = (value) => {
  if (typeof value !== 'string') return null;
  const bare = value.trim().split(':').pop();
  return bare.length > 0 ? bare : null;
};

let tmp;
let repo;

/** A `route.selected` row as route-observe-pre.js writes it (the PreToolUse receipt). */
function selectedRow({ epoch, name = null, type, session = SID, ts = '2026-09-30T08:00:00.000Z' }) {
  const row = {
    v: 1,
    ts,
    event: 'route.selected',
    session_id: session,
    source: 'hook',
    pid: 1,
    seq: 0,
    mission_id: 'M-20260930-Ssessstop',
    routing_epoch_id: epoch,
    action_id: epoch,
    data: { shadow_of: `tool_use:${epoch}` },
  };
  if (name !== null) row.worker = name;
  row.idempotency_key = `route.pre:${epoch}:${PROMPT}:${type ?? ''}`;
  return row;
}

/** A `route.bound` row as subagent-handler.js#bindRoute writes it at SubagentStart. */
function boundRow({ agentId, epoch, name, subagentType, confidence = 'exact', ts = '2026-09-30T08:00:02.000Z' }) {
  const data = {
    tool_use_id: epoch,
    agent_id: agentId,
    confidence,
    method: confidence === 'fifo' ? 'prompt_id+fifo' : 'prompt_id+name',
    agent_type: name,
  };
  if (subagentType !== undefined) data.subagent_type = subagentType;
  return {
    v: 1,
    ts,
    event: 'route.bound',
    session_id: SID,
    source: 'hook',
    pid: 1,
    seq: 0,
    mission_id: 'M-20260930-Ssessstop',
    routing_epoch_id: agentId,
    run_id: agentId,
    action_id: epoch,
    data,
  };
}

/** One 'hook.fired' filler row - the row kind that is 90% of a live ledger. */
function fillerRow(i) {
  return {
    v: 1,
    ts: '2026-09-30T08:30:00.000Z',
    event: 'hook.fired',
    session_id: SID,
    source: 'hook',
    pid: 2,
    seq: 0,
    mission_id: 'M-20260930-Ssessstop',
    data: { slot: 'PostToolUse', hooks: ['quality-gate', 'post-edit-format'], failed: [], count: 2, tool: 'Edit', i },
    action_id: `toolu_filler${i}`,
  };
}

/** Write the ledger at the path the hook itself would read. */
function writeLedger(rows, { fillerBytesBetween = 0, fillerBytesAfter = 0 } = {}) {
  const file = ledgerFilePath(repo);
  mkdirSync(path.dirname(file), { recursive: true });
  const chunks = [];
  const filler = (bytes) => {
    let written = 0;
    let i = 0;
    while (written < bytes) {
      const line = `${JSON.stringify(fillerRow(i))}\n`;
      chunks.push(line);
      written += Buffer.byteLength(line);
      i += 1;
    }
  };
  rows.forEach((row, idx) => {
    chunks.push(`${JSON.stringify(row)}\n`);
    if (idx === 0 && fillerBytesBetween > 0) filler(fillerBytesBetween);
  });
  if (fillerBytesAfter > 0) filler(fillerBytesAfter);
  writeFileSync(file, chunks.join(''), 'utf-8');
  return file;
}

/** When the START hook registered the agent: after the trail's rows (08:00:00 and 08:00:02). */
const STARTED_AT = '2026-09-30T08:00:03.000Z';

/** The context `subagent-handler.js#handleStop` hands the gate. */
function stop(over = {}) {
  const agentId = over.agentId ?? `areview-f1-${HEX}`;
  return {
    hookData: { agent_id: agentId, agent_type: 'review-f1', cwd: repo, session_id: SID },
    agentId,
    sessionId: SID,
    projectRoot: repo,
    // `startedAt` and `agentType` are written by the SubagentStart handler alone.
    tracked: { role: 'review-f1', agentType: 'review-f1', active: true, startedAt: STARTED_AT },
    ...over,
  };
}

/** A named reviewer's whole spawn trail: PreToolUse receipt + SubagentStart bind. */
function spawnTrail({ name = 'review-f1', type = 'artibot:code-reviewer', epoch = 'toolu_01AAAA', withBoundType = true } = {}) {
  const agentId = `a${name}-${HEX}`;
  return {
    agentId,
    rows: [
      selectedRow({ epoch, name, type }),
      boundRow({ agentId, epoch, name, subagentType: withBoundType ? type : undefined }),
    ],
  };
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'artibot-stop-identity-')));
  repo = path.join(tmp, 'repo');
  // `resolveGitCommonDir` is pure-fs (`<root>/.git` directory or nothing), so a bare directory
  // is the repository the ledger path needs; spawning `git init` per case cost ~400 ms each.
  mkdirSync(path.join(repo, '.git'), { recursive: true });
});

afterEach(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
});

describe('isReviewerStop - the two-argument gate is unchanged', () => {
  it.each([
    ['code-reviewer', true],
    ['artibot:code-reviewer', true],
    ['spec-reviewer', true],
    ['quality-reviewer', true],
    ['artibot:auditor', true],
    ['team-wave11-prep-89ada2-inspector', true],
    ['review-f1', false],
    ['frontend-developer', false],
    ['teammate', false],
    [undefined, false],
    ['', false],
  ])('%s -> %s with no stop context (positive and negative control)', (type, expected) => {
    expect(isReviewerStop(type, identityOf)).toBe(expected);
  });

  it('a named teammate is NOT recognised without the stop context, even with a perfect trail on disk', () => {
    const { rows } = spawnTrail();
    writeLedger(rows);
    expect(isReviewerStop('review-f1', identityOf)).toBe(false);
  });
});

describe('isReviewerStop - a named teammate is resolved through its spawn trail', () => {
  it('RED on base: review-f1 (agent_type = its NAME, receipt type artibot:code-reviewer) is a reviewer stop', () => {
    const { agentId, rows } = spawnTrail();
    writeLedger(rows);
    expect(isReviewerStop('review-f1', identityOf, stop({ agentId }))).toBe(true);
  });

  it.each([
    'artibot:code-reviewer', 'code-reviewer', 'artibot:spec-reviewer', 'artibot:quality-reviewer', 'artibot:auditor', 'auditor',
  ])('an allowlisted receipt type (%s) makes the stop a reviewer stop', (type) => {
    const { agentId, rows } = spawnTrail({ type });
    writeLedger(rows);
    expect(isReviewerStop('review-f1', identityOf, stop({ agentId }))).toBe(true);
  });

  it.each([
    'artibot:frontend-developer', 'artibot:tdd-guide', 'general-purpose', 'artibot:investigator', 'Explore', 'fork',
  ])('a NON-reviewer receipt type (%s) stays excluded - same fixture, only the type differs', (type) => {
    const { agentId, rows } = spawnTrail({ type });
    writeLedger(rows);
    expect(isReviewerStop('review-f1', identityOf, stop({ agentId }))).toBe(false);
  });

  it('does NOT widen the allowlist: artibot:security-reviewer is reviewer-shaped but not on it', () => {
    const { agentId, rows } = spawnTrail({ name: 'rv-ca01', type: 'artibot:security-reviewer' });
    writeLedger(rows);
    expect(isReviewerStop('rv-ca01', identityOf, stop({ agentId }))).toBe(false);
  });

  it('applies the -inspector suffix rule to the resolved type exactly as to a direct one', () => {
    const { agentId, rows } = spawnTrail({ type: 'custom-inspector' });
    writeLedger(rows);
    expect(isReviewerStop('review-f1', identityOf, stop({ agentId }))).toBe(true);
  });

  it('resolves through route.selected alone when the bind row does not carry subagent_type (every row before 2026-09-30)', () => {
    const { agentId, rows } = spawnTrail({ withBoundType: false });
    writeLedger(rows);
    expect(isReviewerStop('review-f1', identityOf, stop({ agentId }))).toBe(true);
  });

  it('falls back to the NAME join when no bind row exists (bind skipped:unbound)', () => {
    writeLedger([selectedRow({ epoch: 'toolu_01NOBIND', name: 'review-f1', type: 'artibot:code-reviewer' })]);
    expect(isReviewerStop('review-f1', identityOf, stop({ agentId: `areview-f1-${HEX}` }))).toBe(true);
  });

  it('the exact agent-id join beats the name join: two spawns sharing a name resolve to their OWN types', () => {
    const first = spawnTrail({ name: 'shared-name', type: 'artibot:code-reviewer', epoch: 'toolu_01FIRST' });
    const second = spawnTrail({ name: 'shared-name', type: 'artibot:frontend-developer', epoch: 'toolu_02SECOND' });
    // The second spawn is the MOST RECENT row for the name; the first spawn's stop must still be a reviewer.
    second.agentId = 'ashared-name-fedcba9876543210';
    second.rows[1].data.agent_id = second.agentId;
    second.rows[1].run_id = second.agentId;
    second.rows[1].routing_epoch_id = second.agentId;
    writeLedger([...first.rows, ...second.rows]);
    const ctx = (agentId) => stop({ agentId });
    expect(isReviewerStop('shared-name', identityOf, ctx(first.agentId))).toBe(true);
    expect(isReviewerStop('shared-name', identityOf, ctx(second.agentId))).toBe(false);
  });

  it('never trusts a FIFO bind: a probabilistic receipt pairing cannot turn a builder into a reviewer', () => {
    // The bind matched by position only (confidence fifo), so its receipt may belong to ANOTHER spawn.
    const agentId = `abuilder-${HEX}`;
    writeLedger([
      selectedRow({ epoch: 'toolu_01OTHER', name: 'some-reviewer', type: 'artibot:code-reviewer' }),
      boundRow({ agentId, epoch: 'toolu_01OTHER', name: 'builder', subagentType: 'artibot:code-reviewer', confidence: 'fifo' }),
    ]);
    expect(isReviewerStop('builder', identityOf, stop({ agentId }))).toBe(false);
  });

  it('ignores a same-named row from ANOTHER session in the name join', () => {
    writeLedger([selectedRow({ epoch: 'toolu_01OLD', name: 'review-f1', type: 'artibot:code-reviewer', session: 'other-session' })]);
    expect(isReviewerStop('review-f1', identityOf, stop())).toBe(false);
  });

  it('the name join takes the newest receipt written NO LATER than this agent\'s START, not a later same-name spawn', () => {
    // An old BUILDER spawn and a newer REVIEWER spawn share a name; this stop belongs to the old
    // builder (started 08:00:03). The newer receipt (09:00) cannot be its own, so the builder stays excluded.
    writeLedger([
      selectedRow({ epoch: 'toolu_01OLD', name: 'shared', type: 'artibot:frontend-developer', ts: '2026-09-30T08:00:00.000Z' }),
      selectedRow({ epoch: 'toolu_02NEW', name: 'shared', type: 'artibot:code-reviewer', ts: '2026-09-30T09:00:00.000Z' }),
    ]);
    const old = stop({ agentId: `ashared-${HEX}` });
    expect(isReviewerStop('shared', identityOf, old)).toBe(false);
    // ...and the mirror: the old spawn WAS the reviewer, the newer one a builder.
    writeLedger([
      selectedRow({ epoch: 'toolu_01OLD', name: 'shared', type: 'artibot:code-reviewer', ts: '2026-09-30T08:00:00.000Z' }),
      selectedRow({ epoch: 'toolu_02NEW', name: 'shared', type: 'artibot:frontend-developer', ts: '2026-09-30T09:00:00.000Z' }),
    ]);
    expect(isReviewerStop('shared', identityOf, old)).toBe(true);
  });

  it('a receipt with no readable timestamp is never taken for a name-join hit', () => {
    const row = selectedRow({ epoch: 'toolu_01', name: 'review-f1', type: 'artibot:code-reviewer' });
    row.ts = 'not a time';
    writeLedger([row]);
    expect(isReviewerStop('review-f1', identityOf, stop())).toBe(false);
  });
});

describe('isReviewerStop - fail closed', () => {
  const trail = () => spawnTrail();

  it.each([
    ['no tracked entry at all', undefined],
    ['a null entry', null],
    // What `workflow-status.js teammate-update` writes for an agent the START handler never saw:
    // it runs in parallel on every SubagentStop and CREATES `state.agents[id]` without these two keys.
    ['an entry workflow-status created (no startedAt)', { role: 'teammate', active: true, updatedAt: STARTED_AT }],
    ['a non-string startedAt', { startedAt: 1_700_000_000_000 }],
    ['an unparseable startedAt', { startedAt: 'yesterday-ish' }],
  ])('is false when the stop was never registered at SubagentStart: %s', (_label, tracked) => {
    const { agentId, rows } = trail();
    writeLedger(rows);
    expect(isReviewerStop('review-f1', identityOf, stop({ agentId, tracked }))).toBe(false);
  });

  it('is false when the payload gave no project root - it never guesses one from process.cwd()', () => {
    const { agentId, rows } = trail();
    writeLedger(rows);
    const before = process.cwd();
    try {
      process.chdir(repo);
      expect(isReviewerStop('review-f1', identityOf, stop({ agentId, projectRoot: null }))).toBe(false);
    } finally {
      process.chdir(before);
    }
  });

  it('is false for a ledger that does not exist', () => {
    expect(isReviewerStop('review-f1', identityOf, stop())).toBe(false);
  });

  it('is false for a ledger with no row for this spawn', () => {
    writeLedger([selectedRow({ epoch: 'toolu_01X', name: 'somebody-else', type: 'artibot:code-reviewer' })]);
    expect(isReviewerStop('review-f1', identityOf, stop())).toBe(false);
  });

  it('is false, without throwing, for a corrupt ledger and for garbage context', () => {
    const file = ledgerFilePath(repo);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, 'not json\n{"event":"route.bound"\n\u0000\u0000\n', 'utf-8');
    expect(isReviewerStop('review-f1', identityOf, stop())).toBe(false);
    for (const garbage of [null, 7, 'x', [], { tracked: 1 }, { tracked: {}, projectRoot: 5, agentId: {} }]) {
      expect(() => isReviewerStop('review-f1', identityOf, garbage)).not.toThrow();
      expect(isReviewerStop('review-f1', identityOf, garbage)).toBe(false);
    }
  });

  it('is false when the row is older than the scan window, and true while it is inside it', () => {
    // The window is sized from a MEASUREMENT (reviewer-ish p99 1.38 MB, all spawns p99 3.39 MB,
    // max 4.97 MB of ledger growth between a spawn's bind row and its stop), not from the 128 KB
    // receipt-scan default, which would have covered only 54% of reviewer-ish stops (43% of
    // all). 8 MiB = 1.6x that max.
    const { agentId, rows } = trail();
    // 5.5 MiB: past the largest distance measured AND past a 4 MiB window - still inside.
    writeLedger(rows, { fillerBytesAfter: 5.5 * 1024 * 1024 });
    expect(isReviewerStop('review-f1', identityOf, stop({ agentId }))).toBe(true);
    // 9 MiB: what a far longer-running reviewer would leave behind - outside, so not recorded.
    writeLedger(rows, { fillerBytesAfter: 9 * 1024 * 1024 });
    expect(isReviewerStop('review-f1', identityOf, stop({ agentId }))).toBe(false);
  });
});

describe('isReviewerStop - host meta file', () => {
  /** Write `agent-<id>.jsonl` + its sibling meta and return the transcript path. */
  function withMeta(meta) {
    const dir = path.join(tmp, 'subagents');
    mkdirSync(dir, { recursive: true });
    const transcript = path.join(dir, 'agent-ameta.jsonl');
    writeFileSync(transcript, '', 'utf-8');
    writeFileSync(path.join(dir, 'agent-ameta.meta.json'), JSON.stringify(meta), 'utf-8');
    return transcript;
  }

  const ctxWith = (transcript) => stop({
    hookData: { agent_transcript_path: transcript, cwd: repo, session_id: SID },
    agentId: 'ameta',
  });

  it('accepts an allowlisted customAgentType (the /split judge teammates) without touching the ledger', () => {
    const transcript = withMeta({ agentType: 'split-x-judge-b1', customAgentType: 'code-reviewer', name: 'split-x-judge-b1' });
    expect(isReviewerStop('split-x-judge-b1', identityOf, ctxWith(transcript))).toBe(true);
  });

  it('accepts an allowlisted meta agentType', () => {
    const transcript = withMeta({ agentType: 'artibot:spec-reviewer' });
    expect(isReviewerStop('some-name', identityOf, ctxWith(transcript))).toBe(true);
  });

  it('keeps a NON-reviewer customAgentType excluded', () => {
    const transcript = withMeta({ agentType: 'impl-1', customAgentType: 'tdd-guide' });
    expect(isReviewerStop('impl-1', identityOf, ctxWith(transcript))).toBe(false);
  });

  it('a name-typed meta (agentType === name, the live shape of 426 files) resolves nothing on its own', () => {
    const transcript = withMeta({ agentType: 'review-f1', name: 'review-f1', teamName: 'session-x' });
    expect(isReviewerStop('review-f1', identityOf, ctxWith(transcript))).toBe(false);
  });
});
