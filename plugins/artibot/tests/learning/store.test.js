import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  _internals, captureTurn, finalizeSession, rotateLedger, safeSession,
} from '../../lib/learning/ledger/store.js';

const FAKE_OPENAI = `sk-${'x'.repeat(32)}`;
const userLine = (text) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
const asstLine = (text) =>
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const toolLine = () =>
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: {} }] } });

describe('store — incremental append + rotation (F-03)', () => {
  let root;
  const sid = 'sess-abc';
  const ledgerFile = () => _internals.sessionFile(root, sid);
  const ledgerDir = () => path.dirname(_internals.cursorPath(root));

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'artibot-ledger-'));
  });
  afterEach(() => {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* noop */ }
    delete process.env.ARTIBOT_LEDGER_KEEP;
  });

  function writeTranscript(lines) {
    const tp = path.join(root, 'transcript.jsonl');
    writeFileSync(tp, `${lines.join('\n')}\n`, 'utf-8');
    return tp;
  }

  it('captures only conversation lines on first turn', async () => {
    const tp = writeTranscript([userLine('q1'), toolLine(), asstLine('a1')]);
    const res = await captureTurn({ projectRoot: root, sessionId: sid, transcriptPath: tp });
    expect(res.ok).toBe(true);
    expect(res.appended).toBe(2);
    const out = readFileSync(ledgerFile(), 'utf-8').trim().split('\n');
    expect(out).toEqual([userLine('q1'), asstLine('a1')]);
  });

  it('AC2: second turn appends ONLY new lines (no full rewrite, no dup)', async () => {
    const tp = writeTranscript([userLine('q1'), asstLine('a1')]);
    await captureTurn({ projectRoot: root, sessionId: sid, transcriptPath: tp });
    writeTranscript([userLine('q1'), asstLine('a1'), userLine('q2'), asstLine('a2')]);
    const res = await captureTurn({ projectRoot: root, sessionId: sid, transcriptPath: tp });
    expect(res.appended).toBe(2);
    const out = readFileSync(ledgerFile(), 'utf-8').trim().split('\n');
    expect(out).toEqual([userLine('q1'), asstLine('a1'), userLine('q2'), asstLine('a2')]);
  });

  it('redacts secrets before persisting', async () => {
    const tp = writeTranscript([userLine(`token ${FAKE_OPENAI}`)]);
    await captureTurn({ projectRoot: root, sessionId: sid, transcriptPath: tp });
    const disk = readFileSync(ledgerFile(), 'utf-8');
    expect(disk).not.toContain(FAKE_OPENAI);
    expect(disk).toMatch(/REDACTED/);
  });

  it('finalizeSession is idempotent (no duplicate lines)', async () => {
    const tp = writeTranscript([userLine('q1'), asstLine('a1')]);
    await captureTurn({ projectRoot: root, sessionId: sid, transcriptPath: tp });
    await finalizeSession({ projectRoot: root, sessionId: sid, transcriptPath: tp });
    const out = readFileSync(ledgerFile(), 'utf-8').trim().split('\n');
    expect(out).toEqual([userLine('q1'), asstLine('a1')]);
  });

  it('AC3: rotation keeps at most N session files', async () => {
    process.env.ARTIBOT_LEDGER_KEEP = '2';
    const tp = writeTranscript([userLine('x'), asstLine('y')]);
    for (const s of ['s1', 's2', 's3', 's4']) {
       
      await captureTurn({ projectRoot: root, sessionId: s, transcriptPath: tp });
    }
    await rotateLedger(root, 2);
    const files = readdirSync(ledgerDir()).filter((f) => f.endsWith('.jsonl'));
    expect(files.length).toBeLessThanOrEqual(2);
  });

  it('safeSession rejects path traversal', () => {
    expect(safeSession('../../etc/passwd')).toBe('passwd');
    expect(safeSession('.')).toBe('session');
    expect(safeSession('..')).toBe('session');
    expect(safeSession('')).toBe('session');
    expect(safeSession('normal-id')).toBe('normal-id');
  });

  it('returns ok:false when transcript is missing (never throws)', async () => {
    const res = await captureTurn({ projectRoot: root, sessionId: sid, transcriptPath: path.join(root, 'nope.jsonl') });
    expect(res).toEqual({ appended: 0, ok: false });
  });
});
