import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  approve, enqueueFromCorpus, listPending, reject, renderReviewReport, toExperience,
} from '../../../lib/learning/ledger/review-queue.js';

const userLine = (text) =>
  JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
const asstLine = (text) =>
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });

describe('review-queue — F-06 D2 (human review gate)', () => {
  let root;
  const ledgerDir = () => path.join(root, '.artibot', 'ledger');

  beforeEach(() => { root = mkdtempSync(path.join(os.tmpdir(), 'artibot-revq-')); });
  afterEach(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* noop */ } });

  function writeLedger(sid, lines) {
    mkdirSync(ledgerDir(), { recursive: true });
    writeFileSync(path.join(ledgerDir(), `${sid}.jsonl`), `${lines.join('\n')}\n`, 'utf-8');
  }

  it('enqueueFromCorpus stages corpus entries and advances the corpus watermark', async () => {
    writeLedger('s1', [userLine('q1'), asstLine('a1')]);
    const res = await enqueueFromCorpus(root, { sessionId: 's1' });
    expect(res.staged).toBe(2);
    const pending = await listPending(root);
    expect(pending.map((i) => i.text)).toEqual(['q1', 'a1']);
    expect(pending.every((i) => typeof i.id === 'string' && i.id.length > 0)).toBe(true);
  });

  it('enqueue is idempotent — re-enqueue with no new corpus stages nothing', async () => {
    writeLedger('s1', [userLine('q1')]);
    await enqueueFromCorpus(root, { sessionId: 's1' });
    const second = await enqueueFromCorpus(root, { sessionId: 's1' });
    expect(second.staged).toBe(0);
    expect((await listPending(root)).length).toBe(1);
  });

  it('enqueue picks up only NEW corpus lines after the watermark advanced', async () => {
    writeLedger('s1', [userLine('q1')]);
    await enqueueFromCorpus(root, { sessionId: 's1' });
    writeLedger('s1', [userLine('q1'), asstLine('a1')]);
    const res = await enqueueFromCorpus(root, { sessionId: 's1' });
    expect(res.staged).toBe(1);
    expect((await listPending(root)).map((i) => i.text)).toEqual(['q1', 'a1']);
  });

  it('approve(ids) promotes only those items and removes them from the queue', async () => {
    writeLedger('s1', [userLine('q1'), asstLine('a1')]);
    await enqueueFromCorpus(root, { sessionId: 's1' });
    const [first] = await listPending(root);
    const promoted = [];
    const res = await approve(root, { ids: [first.id] }, { promote: (item) => { promoted.push(item.text); } });
    expect(res.promoted).toBe(1);
    expect(promoted).toEqual(['q1']);
    expect((await listPending(root)).map((i) => i.text)).toEqual(['a1']);
  });

  it('approve({all:true}) promotes every pending item', async () => {
    writeLedger('s1', [userLine('q1'), asstLine('a1')]);
    await enqueueFromCorpus(root, { sessionId: 's1' });
    const promoted = [];
    const res = await approve(root, { all: true }, { promote: (item) => { promoted.push(item.text); } });
    expect(res.promoted).toBe(2);
    expect(promoted.sort()).toEqual(['a1', 'q1']);
    expect(await listPending(root)).toEqual([]);
  });

  it('approve keeps exactly the FAILED item queued on a mid-list promotion error', async () => {
    writeLedger('s1', [userLine('q1'), asstLine('a1'), userLine('q2')]);
    await enqueueFromCorpus(root, { sessionId: 's1' });
    const pending = await listPending(root);
    const failId = pending[1].id; // 'a1' will throw
    const res = await approve(root, { all: true }, {
      promote: (item) => { if (item.id === failId) throw new Error('boom'); },
    });
    expect(res.promoted).toBe(2);
    const remaining = await listPending(root);
    expect(remaining.map((i) => i.text)).toEqual(['a1']); // only the failed one stays
  });

  it('reject removes items WITHOUT promoting', async () => {
    writeLedger('s1', [userLine('q1')]);
    await enqueueFromCorpus(root, { sessionId: 's1' });
    const [item] = await listPending(root);
    const res = await reject(root, { ids: [item.id] });
    expect(res.removed).toBe(1);
    expect(await listPending(root)).toEqual([]);
  });

  it('renderReviewReport summarizes pending items (session + text visible)', async () => {
    writeLedger('s1', [userLine('hello world')]);
    await enqueueFromCorpus(root, { sessionId: 's1' });
    const report = renderReviewReport(await listPending(root));
    expect(report).toContain('s1');
    expect(report).toContain('hello world');
  });

  it('toExperience maps a queue item to a collectExperience-shaped record', () => {
    const exp = toExperience({ id: 'x', session: 's1', role: 'user', text: 'hi' });
    expect(exp.type).toBe('success');
    expect(exp.category).toBe('ledger-corpus');
    expect(exp.sessionId).toBe('s1');
    expect(exp.data).toMatchObject({ role: 'user', text: 'hi' });
  });

  it('graceful on empty: enqueue/list/approve/reject never throw with no ledger', async () => {
    await expect(enqueueFromCorpus(root, {})).resolves.toMatchObject({ staged: 0 });
    await expect(listPending(root)).resolves.toEqual([]);
    await expect(approve(root, { all: true }, { promote: () => {} })).resolves.toMatchObject({ promoted: 0 });
    await expect(reject(root, { all: true })).resolves.toMatchObject({ removed: 0 });
  });

  it('falsy projectRoot short-circuits every function (never throws)', async () => {
    await expect(enqueueFromCorpus(undefined, {})).resolves.toEqual({ staged: 0 });
    await expect(listPending(undefined)).resolves.toEqual([]);
    await expect(approve(undefined, { all: true })).resolves.toEqual({ promoted: 0, remaining: 0 });
    await expect(reject(undefined, { all: true })).resolves.toEqual({ removed: 0, remaining: 0 });
  });

  it('selector with neither ids nor all targets nothing', async () => {
    writeLedger('s1', [userLine('q1')]);
    await enqueueFromCorpus(root, { sessionId: 's1' });
    const approved = await approve(root, {}, { promote: () => {} });
    expect(approved.promoted).toBe(0);
    const rejected = await reject(root, {});
    expect(rejected.removed).toBe(0);
    expect((await listPending(root)).length).toBe(1);
  });

  it('tolerates a malformed queue file (listPending returns [])', async () => {
    mkdirSync(ledgerDir(), { recursive: true });
    writeFileSync(path.join(ledgerDir(), '.review-queue.json'), '{not json', 'utf-8');
    expect(await listPending(root)).toEqual([]);
  });

  it('renderReviewReport handles empty / non-array input', () => {
    expect(renderReviewReport([])).toContain('없음');
    expect(renderReviewReport(null)).toContain('없음');
  });
});
