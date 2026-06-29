import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { markCorpusConsumed, readSessionCorpus } from '../../../lib/learning/ledger/corpus.js';

// The ledger persists already-denoised+redacted JSONL lines in the original
// transcript schema. These helpers mirror that on-disk shape.
const userLine = (text) =>
  JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
const asstLine = (text) =>
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });

describe('corpus — denoised ledger reader (F-06 D1)', () => {
  let root;
  const ledgerDir = () => path.join(root, '.artibot', 'ledger');

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'artibot-corpus-'));
  });
  afterEach(() => {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* noop */ }
  });

  function writeLedger(sid, lines) {
    mkdirSync(ledgerDir(), { recursive: true });
    writeFileSync(path.join(ledgerDir(), `${sid}.jsonl`), `${lines.join('\n')}\n`, 'utf-8');
  }

  it('returns empty entries when the ledger dir is absent (graceful, no throw)', async () => {
    const res = await readSessionCorpus(root);
    expect(res.entries).toEqual([]);
    expect(res.positions).toEqual({});
  });

  it('reads denoised {role,text} entries from a session ledger', async () => {
    writeLedger('s1', [userLine('q1'), asstLine('a1')]);
    const { entries } = await readSessionCorpus(root, { sessionId: 's1' });
    expect(entries).toEqual([
      { session: 's1', role: 'user', text: 'q1' },
      { session: 's1', role: 'assistant', text: 'a1' },
    ]);
  });

  it('sessionId filter returns only that session', async () => {
    writeLedger('s1', [userLine('q1')]);
    writeLedger('s2', [userLine('q2')]);
    const { entries } = await readSessionCorpus(root, { sessionId: 's2' });
    expect(entries.map((e) => e.text)).toEqual(['q2']);
  });

  it('aggregates across all sessions when no sessionId given', async () => {
    writeLedger('s1', [userLine('q1')]);
    writeLedger('s2', [userLine('q2'), asstLine('a2')]);
    const { entries } = await readSessionCorpus(root);
    expect(entries.map((e) => e.text).sort()).toEqual(['a2', 'q1', 'q2']);
  });

  it('limit caps the number of entries to the most recent N', async () => {
    writeLedger('s1', [userLine('q1'), asstLine('a1'), userLine('q2')]);
    const { entries } = await readSessionCorpus(root, { sessionId: 's1', limit: 2 });
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.text)).toEqual(['a1', 'q2']);
  });

  it('skips malformed / non-conversation lines (never throws)', async () => {
    writeLedger('s1', [
      userLine('q1'),
      '{not json',
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'X', input: {} }] } }),
      asstLine('a1'),
    ]);
    const { entries } = await readSessionCorpus(root, { sessionId: 's1' });
    expect(entries.map((e) => e.text)).toEqual(['q1', 'a1']);
  });

  it('sinceCursor skips already-consumed lines after markCorpusConsumed', async () => {
    writeLedger('s1', [userLine('q1'), asstLine('a1')]);
    const first = await readSessionCorpus(root, { sessionId: 's1', sinceCursor: true });
    expect(first.entries.map((e) => e.text)).toEqual(['q1', 'a1']);
    await markCorpusConsumed(root, first.positions);

    // No new lines yet → second read returns nothing.
    const second = await readSessionCorpus(root, { sessionId: 's1', sinceCursor: true });
    expect(second.entries).toEqual([]);

    // Append a new turn → only the new line is returned.
    writeLedger('s1', [userLine('q1'), asstLine('a1'), userLine('q2')]);
    const third = await readSessionCorpus(root, { sessionId: 's1', sinceCursor: true });
    expect(third.entries.map((e) => e.text)).toEqual(['q2']);
  });

  it('does NOT advance consumption on read alone (review gate: explicit mark only)', async () => {
    writeLedger('s1', [userLine('q1')]);
    await readSessionCorpus(root, { sessionId: 's1', sinceCursor: true });
    // Without markCorpusConsumed, the same lines remain available.
    const again = await readSessionCorpus(root, { sessionId: 's1', sinceCursor: true });
    expect(again.entries.map((e) => e.text)).toEqual(['q1']);
  });

  it('uses a SEPARATE cursor file — never touches store write cursor (.cursor.json)', async () => {
    writeLedger('s1', [userLine('q1')]);
    const storeCursor = path.join(ledgerDir(), '.cursor.json');
    writeFileSync(storeCursor, JSON.stringify({ s1: { lines: 1 } }), 'utf-8');
    const { positions } = await readSessionCorpus(root, { sessionId: 's1', sinceCursor: true });
    await markCorpusConsumed(root, positions);
    // store's write cursor is untouched; a distinct corpus cursor exists.
    expect(JSON.parse(readFileSync(storeCursor, 'utf-8'))).toEqual({ s1: { lines: 1 } });
    expect(existsSync(path.join(ledgerDir(), '.corpus-cursor.json'))).toBe(true);
  });

  it('the corpus cursor file is not treated as a session', async () => {
    writeLedger('s1', [userLine('q1')]);
    await markCorpusConsumed(root, { s1: 1 });
    const { entries } = await readSessionCorpus(root);
    expect(entries.map((e) => e.session)).toEqual(['s1']);
  });

  it('tolerates a non-object opts and missing projectRoot (never throws)', async () => {
    await expect(readSessionCorpus(root, null)).resolves.toBeTruthy();
    await expect(readSessionCorpus(undefined)).resolves.toEqual({ entries: [], positions: {} });
  });
});
