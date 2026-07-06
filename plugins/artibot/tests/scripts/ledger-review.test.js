/**
 * Tests for scripts/ledger-review.js — the F-06 `/learning review` gate CLI.
 *
 * Two layers:
 *   - real end-to-end STAGE against a temp ledger (default deps — stage only
 *     touches the local queue/corpus, never the ~/.claude learning store);
 *   - injected-deps dispatch tests for approve/reject so `collectExperience`
 *     (the default promote path) is never exercised against the real store.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseReviewArgs, runReview } from '../../scripts/ledger-review.js';

const userLine = (text) =>
  JSON.stringify({ type: 'user', message: { role: 'user', content: text } });

describe('parseReviewArgs()', () => {
  it('defaults to the stage action with no args', () => {
    expect(parseReviewArgs([])).toMatchObject({ action: 'stage', ids: [], all: false });
  });

  it('detects approve/reject and collects positional ids', () => {
    expect(parseReviewArgs(['approve', 's1#a', 's1#b'])).toMatchObject({
      action: 'approve', ids: ['s1#a', 's1#b'], all: false,
    });
    expect(parseReviewArgs(['reject', 's1#a'])).toMatchObject({ action: 'reject', ids: ['s1#a'] });
  });

  it('honours --all, --session, and --limit', () => {
    expect(parseReviewArgs(['approve', '--all'])).toMatchObject({ action: 'approve', all: true });
    expect(parseReviewArgs(['--session', 's7'])).toMatchObject({ sessionId: 's7' });
    expect(parseReviewArgs(['--limit', '5'])).toMatchObject({ limit: 5 });
  });

  it('tolerates non-array / junk input', () => {
    expect(parseReviewArgs(undefined)).toMatchObject({ action: 'stage', ids: [] });
    expect(parseReviewArgs(['--limit', 'x'])).toMatchObject({ limit: undefined });
  });

  it('ignores a leading `review` token (verbatim $ARGUMENTS forwarding)', () => {
    expect(parseReviewArgs(['review'])).toMatchObject({ action: 'stage' });
    expect(parseReviewArgs(['review', 'approve', 's1#a'])).toMatchObject({
      action: 'approve', ids: ['s1#a'],
    });
    expect(parseReviewArgs(['review', 'reject', '--all'])).toMatchObject({
      action: 'reject', all: true,
    });
  });
});

describe('runReview() — stage (real temp ledger, default deps)', () => {
  let root;
  const ledgerDir = () => path.join(root, '.artibot', 'ledger');

  beforeEach(() => { root = mkdtempSync(path.join(os.tmpdir(), 'artibot-revcli-')); });
  afterEach(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* noop */ } });

  it('stages new corpus, lists pending, and prints the approve/reject hint', async () => {
    mkdirSync(ledgerDir(), { recursive: true });
    writeFileSync(path.join(ledgerDir(), 's1.jsonl'), `${userLine('hello world')}\n`, 'utf-8');

    const { action, text, result } = await runReview(root, []);
    expect(action).toBe('stage');
    expect(result.staged).toBe(1);
    expect(text).toContain('신규 코퍼스 1건');
    expect(text).toContain('hello world');
    expect(text).toContain('/learning review approve');
  });

  it('no hint and zero staged when the ledger is empty', async () => {
    const { text, result } = await runReview(root, []);
    expect(result.staged).toBe(0);
    expect(text).toContain('신규 코퍼스 0건');
    expect(text).not.toContain('/learning review approve');
  });
});

describe('runReview() — approve/reject dispatch (injected deps)', () => {
  const pending = [{ id: 's1#a', session: 's1', role: 'user', text: 'q1' }];
  let deps;

  beforeEach(() => {
    deps = {
      enqueueFromCorpus: vi.fn(async () => ({ staged: 0 })),
      listPending: vi.fn(async () => []),
      approve: vi.fn(async () => ({ promoted: 1, remaining: 0 })),
      reject: vi.fn(async () => ({ removed: 1, remaining: 0 })),
      renderReviewReport: vi.fn(() => '검토 대기 항목 없음.'),
    };
  });

  it('approve <id> forwards an ids selector and reports promotion', async () => {
    const { result, text } = await runReview('/root', ['approve', 's1#a'], deps);
    expect(deps.approve).toHaveBeenCalledWith('/root', { ids: ['s1#a'] });
    expect(result).toEqual({ promoted: 1, remaining: 0 });
    expect(text).toContain('승인 완료 — 1건 학습 승격');
  });

  it('approve --all forwards an all selector', async () => {
    await runReview('/root', ['approve', '--all'], deps);
    expect(deps.approve).toHaveBeenCalledWith('/root', { all: true });
  });

  it('reject <id> forwards an ids selector and does NOT call approve', async () => {
    const { text } = await runReview('/root', ['reject', 's1#a'], deps);
    expect(deps.reject).toHaveBeenCalledWith('/root', { ids: ['s1#a'] });
    expect(deps.approve).not.toHaveBeenCalled();
    expect(text).toContain('반려 완료 — 1건 폐기');
  });

  it('approve/reject with no ids and no --all is a no-op guard', async () => {
    const approveRes = await runReview('/root', ['approve'], deps);
    expect(approveRes.result).toBeNull();
    expect(approveRes.text).toContain('대상 미지정');
    expect(deps.approve).not.toHaveBeenCalled();

    const rejectRes = await runReview('/root', ['reject'], deps);
    expect(rejectRes.text).toContain('대상 미지정');
    expect(deps.reject).not.toHaveBeenCalled();
  });

  it('stage action forwards --session/--limit to enqueueFromCorpus', async () => {
    deps.listPending.mockResolvedValueOnce(pending);
    await runReview('/root', ['--session', 's1', '--limit', '3'], deps);
    expect(deps.enqueueFromCorpus).toHaveBeenCalledWith('/root', { sessionId: 's1', limit: 3 });
  });
});
