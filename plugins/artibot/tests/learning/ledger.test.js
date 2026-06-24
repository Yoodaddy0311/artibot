import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { claudeHasText, contentText, slimLines, slimRaw } from '../../lib/learning/ledger/slim.js';
import { redactLines, redactSecrets, SECRET_CATEGORIES } from '../../lib/learning/ledger/redact.js';
import {
  _internals, captureTurn, finalizeSession, rotateLedger, safeSession,
} from '../../lib/learning/ledger/store.js';

// Synthetic secret fixtures, assembled at runtime so no recognizable secret
// literal appears in source (avoids the repo's secret-scan write guard while
// still exercising the redactor's regexes).
const FAKE_OPENAI = `sk-${'x'.repeat(32)}`;        // matches /sk-[A-Za-z0-9_-]{20,}/
const FAKE_AWS = `AKIA${'A'.repeat(16)}`;          // matches /AKIA[A-Z0-9]{16}/

// JSONL line builders mirroring the claude-code transcript schema.
const userLine = (text) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
const asstLine = (text) =>
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const toolLine = () =>
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: {} }] } });
const thinkingLine = () =>
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', text: 'reasoning' }] } });
const metaLine = (text) => JSON.stringify({ type: 'user', isMeta: true, message: { role: 'user', content: text } });

// ---------------------------------------------------------------------------
// T4: slim (denoise)
// ---------------------------------------------------------------------------
describe('slim — conversation denoise (F-02)', () => {
  it('keeps user/assistant text lines verbatim', () => {
    const lines = [userLine('hello'), asstLine('hi there')];
    expect(slimLines(lines)).toEqual(lines);
  });

  it('AC1: excludes tool_use and thinking lines', () => {
    const lines = [userLine('q'), toolLine(), thinkingLine(), asstLine('a')];
    expect(slimLines(lines)).toEqual([userLine('q'), asstLine('a')]);
  });

  it('AC2: excludes isMeta lines (e.g. /context dumps)', () => {
    const lines = [userLine('real'), metaLine('/context huge dump')];
    expect(slimLines(lines)).toEqual([userLine('real')]);
  });

  it('AC3: returns empty (no verbatim fallback) when no conversation line', () => {
    expect(slimLines([toolLine(), thinkingLine()])).toEqual([]);
    expect(slimRaw('not json\n{bad')).toEqual([]);
  });

  it('skips blank and unparseable lines', () => {
    expect(slimLines(['', '  ', 'xxx', userLine('ok')])).toEqual([userLine('ok')]);
  });

  it('contentText extracts text blocks only', () => {
    expect(contentText('plain')).toBe('plain');
    expect(contentText([{ type: 'text', text: 'a' }, { type: 'tool_use' }, { type: 'text', text: 'b' }])).toBe('a\nb');
    expect(contentText([{ type: 'tool_use' }])).toBe('');
  });

  it('claudeHasText rejects non-conversation objects', () => {
    expect(claudeHasText({ type: 'system' })).toBe(false);
    expect(claudeHasText({ type: 'user', isMeta: true, message: { content: 'x' } })).toBe(false);
    expect(claudeHasText(null)).toBe(false);
    expect(claudeHasText({ type: 'user', message: { content: '' } })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T5: redact (secret scrubbing, context preserved)
// ---------------------------------------------------------------------------
describe('redact — secret scrubbing (F-04)', () => {
  it('AC1: removes an sk- API key and leaves a redaction marker', () => {
    const out = redactSecrets(`my key is ${FAKE_OPENAI} ok`);
    expect(out).not.toContain(FAKE_OPENAI);
    expect(out).toMatch(/REDACTED/);
  });

  it('AC2: AWS access key does not survive into the output', () => {
    const out = redactSecrets(`aws ${FAKE_AWS}`);
    expect(out).not.toContain(FAKE_AWS);
  });

  it('preserves non-secret context (email / IP) — scope = secrets only', () => {
    const out = redactSecrets('contact me@example.com at 10.0.0.5');
    expect(out).toContain('me@example.com');
    expect(out).toContain('10.0.0.5');
  });

  it('redactLines maps over an array', () => {
    const [a, b] = redactLines([`x ${FAKE_OPENAI}`, 'clean']);
    expect(a).not.toContain(FAKE_OPENAI);
    expect(b).toBe('clean');
  });

  it('scope categories are secret-bearing only', () => {
    expect([...SECRET_CATEGORIES].sort()).toEqual(['auth', 'credentials', 'env', 'secrets']);
  });
});

// ---------------------------------------------------------------------------
// T6: store (incremental append + rotation + safe session)
// ---------------------------------------------------------------------------
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
