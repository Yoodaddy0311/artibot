import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Hook-level guarantees for session-ledger.mjs (F-01 / NFR):
 *   - never writes stdout (Codex parses Stop-hook stdout as a decision)
 *   - always exits 0 (a logging failure must never block the session)
 *   - actually persists the denoised ledger under .artibot/ledger/
 */

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK = path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'session-ledger.mjs');

const userLine = (t) => JSON.stringify({ type: 'user', message: { role: 'user', content: t } });
const asstLine = (t) =>
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: t }] } });

function runHook(payload, args = []) {
  const res = spawnSync(process.execPath, [HOOK, ...args], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
  });
  return { status: res.status, stdout: String(res.stdout || ''), stderr: String(res.stderr || '') };
}

describe('session-ledger hook (F-01, non-block)', () => {
  let root;
  beforeEach(() => { root = mkdtempSync(path.join(os.tmpdir(), 'artibot-ledger-hook-')); });
  afterEach(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* noop */ } });

  function transcript(lines) {
    const tp = path.join(root, 't.jsonl');
    writeFileSync(tp, `${lines.join('\n')}\n`, 'utf-8');
    return tp;
  }

  it('exits 0 and writes NO stdout on a normal turn', () => {
    const tp = transcript([userLine('hi'), asstLine('hello')]);
    const r = runHook({ transcript_path: tp, cwd: root, session_id: 'abc' });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('persists the denoised ledger under .artibot/ledger/', () => {
    const tp = transcript([userLine('q'), asstLine('a')]);
    runHook({ transcript_path: tp, cwd: root, session_id: 'abc' });
    const ledger = path.join(root, '.artibot', 'ledger', 'abc.jsonl');
    expect(existsSync(ledger)).toBe(true);
    expect(readFileSync(ledger, 'utf-8').trim().split('\n')).toEqual([userLine('q'), asstLine('a')]);
  });

  it('exits 0 and no stdout with missing transcript_path', () => {
    const r = runHook({ cwd: root });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('exits 0 and no stdout on malformed stdin', () => {
    const res = spawnSync(process.execPath, [HOOK], { input: '{ not json', encoding: 'utf-8' });
    expect(res.status).toBe(0);
    expect(String(res.stdout || '')).toBe('');
  });

  it('SessionEnd arg finalizes without duplicating', () => {
    const tp = transcript([userLine('q'), asstLine('a')]);
    runHook({ transcript_path: tp, cwd: root, session_id: 'abc' });
    runHook({ transcript_path: tp, cwd: root, session_id: 'abc' }, ['SessionEnd']);
    const ledger = path.join(root, '.artibot', 'ledger', 'abc.jsonl');
    expect(readFileSync(ledger, 'utf-8').trim().split('\n')).toEqual([userLine('q'), asstLine('a')]);
  });

  it('does not create a git-tracked path outside .artibot/ledger/', () => {
    const tp = transcript([userLine('q')]);
    runHook({ transcript_path: tp, cwd: root, session_id: '../escape' });
    // traversal sanitized to basename → file lives inside ledger dir
    const dir = path.join(root, '.artibot', 'ledger');
    const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.jsonl')) : [];
    expect(files).toEqual(['escape.jsonl']);
  });
});
