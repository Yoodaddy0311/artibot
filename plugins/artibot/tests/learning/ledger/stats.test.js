import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computeLedgerStats } from '../../../lib/learning/ledger/stats.js';

const userLine = (text) =>
  JSON.stringify({ type: 'user', message: { role: 'user', content: text } });

describe('stats — ledger capture/redaction metrics (F-09)', () => {
  let root;
  const ledgerDir = () => path.join(root, '.artibot', 'ledger');

  beforeEach(() => { root = mkdtempSync(path.join(os.tmpdir(), 'artibot-stats-')); });
  afterEach(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* noop */ } });

  function writeLedger(sid, lines) {
    mkdirSync(ledgerDir(), { recursive: true });
    writeFileSync(path.join(ledgerDir(), `${sid}.jsonl`), `${lines.join('\n')}\n`, 'utf-8');
  }

  it('returns all-zero stats when the ledger dir is absent (never throws)', async () => {
    const s = await computeLedgerStats(root);
    expect(s).toMatchObject({ sessions: 0, lines: 0, redactions: 0, bytes: 0, consumed: 0, pending: 0 });
  });

  it('counts sessions and captured lines across files', async () => {
    writeLedger('s1', [userLine('q1'), userLine('q2')]);
    writeLedger('s2', [userLine('q3')]);
    const s = await computeLedgerStats(root);
    expect(s.sessions).toBe(2);
    expect(s.lines).toBe(3);
    expect(s.bytes).toBeGreaterThan(0);
  });

  it('counts redaction tokens of every kind', async () => {
    writeLedger('s1', [
      userLine('key [REDACTED_KEY] and [REDACTED_SECRET]'),
      userLine('tok [REDACTED_TOKEN] env [ENV_VAR] pem [PRIVATE_KEY] conn [CONNECTION_STRING]'),
    ]);
    const s = await computeLedgerStats(root);
    expect(s.redactions).toBe(6);
  });

  it('reads consumed lines from the corpus cursor (sum across sessions)', async () => {
    writeLedger('s1', [userLine('q1')]);
    writeFileSync(path.join(ledgerDir(), '.corpus-cursor.json'), JSON.stringify({ s1: 3, s2: 2 }), 'utf-8');
    const s = await computeLedgerStats(root);
    expect(s.consumed).toBe(5);
  });

  it('reads pending count from the review queue', async () => {
    writeLedger('s1', [userLine('q1')]);
    writeFileSync(
      path.join(ledgerDir(), '.review-queue.json'),
      JSON.stringify({ items: [{ id: 'a' }, { id: 'b' }] }), 'utf-8',
    );
    const s = await computeLedgerStats(root);
    expect(s.pending).toBe(2);
  });

  it('does not count cursor/queue dotfiles as sessions', async () => {
    writeLedger('s1', [userLine('q1')]);
    writeFileSync(path.join(ledgerDir(), '.corpus-cursor.json'), '{}', 'utf-8');
    writeFileSync(path.join(ledgerDir(), '.review-queue.json'), '{"items":[]}', 'utf-8');
    const s = await computeLedgerStats(root);
    expect(s.sessions).toBe(1);
  });

  it('tolerates malformed cursor / queue (never throws, zero those metrics)', async () => {
    writeLedger('s1', [userLine('q1')]);
    writeFileSync(path.join(ledgerDir(), '.corpus-cursor.json'), '{bad', 'utf-8');
    writeFileSync(path.join(ledgerDir(), '.review-queue.json'), '{bad', 'utf-8');
    const s = await computeLedgerStats(root);
    expect(s).toMatchObject({ consumed: 0, pending: 0, lines: 1 });
  });

  it('falsy projectRoot returns zero stats', async () => {
    expect(await computeLedgerStats(undefined)).toMatchObject({ sessions: 0, lines: 0 });
  });
});
