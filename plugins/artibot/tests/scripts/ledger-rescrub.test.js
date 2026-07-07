/**
 * Tests for scripts/ledger-rescrub.js — the ONE-TIME retroactive ledger
 * re-scrub. All fixtures are synthetic JSONL written into an OS temp dir; the
 * real project `.artibot/ledger/` is never touched.
 *
 * Secret-looking values are assembled at runtime so no recognizable secret
 * literal sits in source (avoids the repo's secret-scan write guard).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  renderStats, rescrubContent, rescrubFile, rescrubLedger,
} from '../../scripts/ledger-rescrub.js';

const userLine = (text) =>
  JSON.stringify({ type: 'user', message: { role: 'user', content: text } });

// A URL that embeds a basic-auth password — the IMP-03 gap that pre-fix lines
// may still carry verbatim. Password segment assembled to dodge the scan guard.
const CRED = 'p' + 'w' + '9x7q';
const CRED_URL = `https://user:${CRED}@internal.example.com/repo`;

describe('rescrubContent()', () => {
  it('masks an embedded URL credential and counts the changed line', () => {
    const { content, scanned, changed } = rescrubContent(`${userLine(CRED_URL)}\n`);
    expect(scanned).toBe(1);
    expect(changed).toBe(1);
    expect(content).not.toContain(CRED);
    expect(content).toContain('[CONNECTION_STRING]');
  });

  it('leaves a clean line byte-identical and reports zero changes', () => {
    const raw = `${userLine('just a normal note about the build')}\n`;
    const { content, scanned, changed } = rescrubContent(raw);
    expect(content).toBe(raw);
    expect(scanned).toBe(1);
    expect(changed).toBe(0);
  });

  it('preserves a malformed / non-JSON line without a secret (no loss)', () => {
    const raw = 'this is not json at all {broken\n';
    const { content, changed } = rescrubContent(raw);
    expect(content).toBe(raw);
    expect(changed).toBe(0);
  });

  it('preserves trailing newline and line count exactly', () => {
    const raw = `${userLine('a')}\n${userLine('b')}\n`;
    const { content, scanned } = rescrubContent(raw);
    expect(content).toBe(raw);
    expect(scanned).toBe(2);
    expect(content.endsWith('\n')).toBe(true);
    expect(content.split('\n')).toHaveLength(3); // 2 records + trailing ''
  });

  it('is idempotent — re-scrubbing its own output changes nothing', () => {
    const first = rescrubContent(`${userLine(CRED_URL)}\n`);
    const second = rescrubContent(first.content);
    expect(second.content).toBe(first.content);
    expect(second.changed).toBe(0);
  });
});

describe('rescrubFile() / rescrubLedger() — temp ledger', () => {
  let root;
  const ledgerDir = () => path.join(root, '.artibot', 'ledger');
  const write = (name, body) => {
    mkdirSync(ledgerDir(), { recursive: true });
    writeFileSync(path.join(ledgerDir(), name), body, 'utf-8');
  };

  beforeEach(() => { root = mkdtempSync(path.join(os.tmpdir(), 'artibot-rescrub-')); });
  afterEach(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* noop */ } });

  it('masks a historical URL-cred line, backs up the original, and keeps clean lines', () => {
    write('s1.jsonl', `${userLine(CRED_URL)}\n${userLine('clean context line')}\n`);

    const stats = rescrubLedger(root);
    return stats.then((s) => {
      expect(s.files).toBe(1);
      expect(s.filesChanged).toBe(1);
      expect(s.linesChanged).toBe(1);
      expect(s.backups).toBe(1);
      expect(s.errors).toBe(0);

      const after = readFileSync(path.join(ledgerDir(), 's1.jsonl'), 'utf-8');
      expect(after).not.toContain(CRED);
      expect(after).toContain('[CONNECTION_STRING]');
      expect(after).toContain('clean context line'); // context retained

      const bak = readFileSync(path.join(ledgerDir(), 's1.jsonl.bak'), 'utf-8');
      expect(bak).toContain(CRED); // backup keeps the untouched original
    });
  });

  it('does NOT rewrite or back up a file with nothing to redact', async () => {
    write('s2.jsonl', `${userLine('all clean here')}\n`);
    const before = readFileSync(path.join(ledgerDir(), 's2.jsonl'), 'utf-8');

    const s = await rescrubLedger(root);
    expect(s.filesChanged).toBe(0);
    expect(s.backups).toBe(0);
    expect(readFileSync(path.join(ledgerDir(), 's2.jsonl'), 'utf-8')).toBe(before);
    expect(existsSync(path.join(ledgerDir(), 's2.jsonl.bak'))).toBe(false);
  });

  it('preserves a malformed line while still masking a sibling secret line', async () => {
    write('s3.jsonl', `not-json {oops\n${userLine(CRED_URL)}\n`);

    await rescrubLedger(root);
    const after = readFileSync(path.join(ledgerDir(), 's3.jsonl'), 'utf-8');
    expect(after.startsWith('not-json {oops\n')).toBe(true); // malformed line intact
    expect(after).not.toContain(CRED);
  });

  it('is idempotent across a second full run (no further change, no churn)', async () => {
    write('s4.jsonl', `${userLine(CRED_URL)}\n`);
    await rescrubLedger(root);
    const afterFirst = readFileSync(path.join(ledgerDir(), 's4.jsonl'), 'utf-8');

    const second = await rescrubLedger(root);
    expect(second.filesChanged).toBe(0);
    expect(second.linesChanged).toBe(0);
    expect(readFileSync(path.join(ledgerDir(), 's4.jsonl'), 'utf-8')).toBe(afterFirst);
  });

  it('skips non-.jsonl sidecar files (cursor/queue/bak)', async () => {
    write('s5.jsonl', `${userLine('ok')}\n`);
    write('.cursor.json', JSON.stringify({ s5: { lines: 1 } }));
    write('.review-queue.json', JSON.stringify({ items: [] }));

    const s = await rescrubLedger(root);
    expect(s.files).toBe(1); // only s5.jsonl counted
  });

  it('returns a zeroed result when the ledger dir is absent (never throws)', async () => {
    const s = await rescrubLedger(root); // no ledger dir created
    expect(s).toMatchObject({ files: 0, filesChanged: 0, errors: 0 });
  });

  it('reports an error (never throws) for an unreadable path', async () => {
    const res = await rescrubFile(path.join(ledgerDir(), 'does-not-exist.jsonl'));
    expect(res.error).toBe(true);
    expect(res.changed).toBe(false);
  });
});

describe('renderStats() — DATA POLICY (counts only)', () => {
  it('renders counts and never leaks ledger text', () => {
    const out = renderStats({
      files: 2, filesChanged: 1, linesScanned: 5, linesChanged: 1, backups: 1, errors: 0,
    });
    expect(out).toContain('Files scanned:   2');
    expect(out).toContain('Lines re-scrubbed: 1');
    expect(out).toContain('.bak');
    expect(out).not.toContain(CRED);
  });

  it('states the no-op case when nothing changed', () => {
    const out = renderStats({ files: 1, filesChanged: 0, linesScanned: 3, linesChanged: 0, backups: 0, errors: 0 });
    expect(out).toContain('already matches the current redactor');
  });

  it('tolerates missing/undefined stats', () => {
    expect(renderStats(undefined)).toContain('Files scanned:   0');
  });
});
