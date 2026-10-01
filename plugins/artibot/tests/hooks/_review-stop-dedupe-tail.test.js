import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ledgerFilePath } from '../../lib/runtime/ledger.js';
import { recordReviewFromStop } from '../../scripts/hooks/_review-stop-record.js';

/**
 * SH-05 follow-up (opus review SHOULD-2): the review path's `existingKeys` port
 * read the WHOLE ledger (`readAllEvents`) for every recognised reviewer - 204-273 ms
 * over a 24.6 MB ledger, 5.3-6.0 s over a 20x copy, past the 5,000 ms SubagentStop
 * budget, which loses the handler's own `recordSpawn`. It now reads the LAST 8 MiB
 * (`lib/review/review-keys.js`).
 *
 * WHAT THIS PINS, both sides of the trade it made:
 *   - a redelivered stop is still deduped while its first row is inside the window;
 *   - a redelivery OLDER than the window is NOT deduped and writes a second row. That
 *     is the recorded gap, asserted here so nobody mistakes it for an accident or
 *     quietly widens it;
 *   - a read that could not reach the window's edge refuses to write
 *     (`rejected:port-threw:existingKeys`) instead of risking a duplicate.
 *
 * WHAT GREEN HERE DOES NOT PROVE: the milliseconds (the lane report has them at 1x and
 * 20x; asserting a wall-clock here would be a flake), or how often a real host
 * redelivers a stop and how late.
 */

const SID = 'sess-dedupe-tail';
const AGENT_ID = 'agent-dedupe-tail';
const MIB = 1024 * 1024;

let tmp;
let repo;
let transcript;

/** A valid `reviewOutputV2` document. */
function v2Doc(over = {}) {
  return {
    schema_version: 2,
    verdict: 'PASS',
    findings: [],
    evidence: [{ kind: 'file', file: 'scripts/hooks/_review-stop-record.js', line: 1 }],
    recommended_action: 'proceed',
    mission_id: 'M-20260930-001',
    intent_revision: 1,
    plan_revision: 1,
    diff_ref: 'HEAD~1..HEAD',
    test_evidence: [{ kind: 'command', command: 'npx vitest run tests/hooks', output: 'ok' }],
    regression_evidence: [{ kind: 'command', command: 'npx vitest run tests/hooks', output: 'ok' }],
    verification_id: 'v-dedupe-tail',
    next_steps: [],
    ...over,
  };
}

/** One stop of a reviewer that answers with a verdict and an audit. */
function stopOnce() {
  const text = [
    'REVIEW', '',
    '```json', JSON.stringify(v2Doc(), null, 2), '```', '',
    '```json', JSON.stringify({
      claim_audit: { subject_agent_type: 'tdd-guide', nature: 'process', claims_total: 5, claims_refuted: 1, evidence_refs: ['a:1'] },
    }, null, 2), '```', '',
  ].join('\n');
  const message = { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text }] };
  writeFileSync(transcript, `${JSON.stringify({ type: 'assistant', message })}\n`, 'utf-8');
  return recordReviewFromStop(
    { agent_transcript_path: transcript, last_assistant_message: text },
    { agentId: AGENT_ID, agentType: 'code-reviewer', sessionId: SID, missionId: 'M-20260930-001' },
    repo,
  );
}

/** Append `bytes` of ledger growth: what the session writes after the verdict. */
function grow(bytes) {
  const chunks = [];
  let written = 0;
  for (let i = 0; written < bytes; i += 1) {
    const line = `${JSON.stringify({
      v: 1, ts: '2026-09-30T09:00:00.000Z', event: 'hook.fired', session_id: SID, source: 'hook', pid: 2, seq: 0,
      data: { slot: 'PostToolUse', hooks: ['quality-gate', 'post-edit-format'], failed: [], count: 2, tool: 'Edit', i },
    })}\n`;
    chunks.push(line);
    written += Buffer.byteLength(line);
  }
  // ONE append: tens of thousands of open/append/close calls take tens of seconds on Windows.
  appendFileSync(ledgerFilePath(repo), chunks.join(''));
}

const reviewRows = () => readFileSync(ledgerFilePath(repo), 'utf-8').split('\n').filter(Boolean)
  .map((l) => JSON.parse(l)).filter((r) => r.event === 'review.completed' || r.event === 'review.claim_audit');

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'artibot-dedupe-tail-')));
  repo = path.join(tmp, 'repo');
  // `resolveGitCommonDir` is pure-fs, so a bare `.git` directory is the repository the ledger path needs.
  mkdirSync(path.join(repo, '.git'), { recursive: true });
  transcript = path.join(tmp, 'agent.jsonl');
});
afterEach(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
});

describe('recordReviewFromStop - the dedupe port reads a bounded tail', () => {
  it('writes both lines on a ledger that does not exist yet, and dedupes the redelivered stop', () => {
    expect(stopOnce()).toMatchObject({ review: 'appended', claimAudit: 'appended' });
    expect(stopOnce()).toMatchObject({ review: 'deduped', claimAudit: 'deduped' });
    expect(reviewRows()).toHaveLength(2);
  });

  it('still dedupes when the first row is 3 MiB back - inside the window', () => {
    expect(stopOnce()).toMatchObject({ review: 'appended' });
    grow(3 * MIB);
    expect(stopOnce()).toMatchObject({ review: 'deduped', claimAudit: 'deduped' });
    expect(reviewRows()).toHaveLength(2);
  });

  it('THE RECORDED GAP: a redelivery older than the 8 MiB window is NOT deduped and writes a second row', () => {
    expect(stopOnce()).toMatchObject({ review: 'appended', claimAudit: 'appended' });
    grow(9 * MIB);
    expect(stopOnce()).toMatchObject({ review: 'appended', claimAudit: 'appended' });
    const rows = reviewRows();
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((r) => r.idempotency_key)).size).toBe(2);
  });

  it('refuses to write when the read could not reach the window\'s edge (rejected, never a possible duplicate)', () => {
    // A directory where the ledger file belongs: present, unreadable as a file, and not a ledger.
    mkdirSync(ledgerFilePath(repo), { recursive: true });
    expect(stopOnce()).toMatchObject({
      review: 'rejected',
      reviewReason: 'port-threw:existingKeys',
      claimAudit: 'rejected',
      claimAuditReason: 'port-threw:existingKeys',
    });
  });
});
