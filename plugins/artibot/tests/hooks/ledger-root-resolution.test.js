import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The ambient ledger anchored its store on the hook payload's `cwd`, so any
 * mid-session `cd` started a second store under the new directory — one live
 * session was observed split across three `.artibot/ledger/` trees. These tests
 * pin the two properties that prevent it: the writer collapses subdirectories
 * onto the project root, and the reader resolves to that same root.
 */

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LEDGER_HOOK = path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'session-ledger.mjs');
const READBACK_HOOK = path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'session-readback.mjs');

const userLine = (t) => JSON.stringify({ type: 'user', message: { role: 'user', content: t } });
const asstLine = (t) =>
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: t }] } });

function runHook(hook, payload, args = []) {
  const res = spawnSync(process.execPath, [hook, ...args], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
  });
  return { status: res.status, stdout: String(res.stdout || ''), stderr: String(res.stderr || '') };
}

describe('ledger project-root resolution (cwd-drift regression)', () => {
  let tmp;
  let repo;
  let nested;

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'artibot-ledger-root-')));
    repo = path.join(tmp, 'repo');
    nested = path.join(repo, 'plugins', 'artibot', 'scripts', 'hooks');
    mkdirSync(nested, { recursive: true });
    execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore', windowsHide: true });
  });
  afterEach(() => {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  });

  function transcript(lines) {
    const tp = path.join(tmp, 't.jsonl');
    writeFileSync(tp, `${lines.join('\n')}\n`, 'utf-8');
    return tp;
  }

  const ledgerFile = (root, sid) => path.join(root, '.artibot', 'ledger', `${sid}.jsonl`);

  it('writes to the repo root when cwd is a nested subdirectory', () => {
    const tp = transcript([userLine('q'), asstLine('a')]);
    const r = runHook(LEDGER_HOOK, { transcript_path: tp, cwd: nested, session_id: 'sid' });

    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(existsSync(ledgerFile(repo, 'sid'))).toBe(true);
    expect(existsSync(ledgerFile(nested, 'sid'))).toBe(false);
  });

  it('keeps ONE ledger when cwd changes mid-session', () => {
    const tp = transcript([userLine('q1'), asstLine('a1')]);
    runHook(LEDGER_HOOK, { transcript_path: tp, cwd: repo, session_id: 'sid' });

    // Same session, shell has since cd'd deeper — the exact shape that forked
    // the store into three trees before this fix.
    writeFileSync(tp, `${[userLine('q1'), asstLine('a1'), userLine('q2'), asstLine('a2')].join('\n')}\n`, 'utf-8');
    runHook(LEDGER_HOOK, { transcript_path: tp, cwd: nested, session_id: 'sid' });

    const mid = path.join(repo, 'plugins', 'artibot');
    expect(existsSync(ledgerFile(nested, 'sid'))).toBe(false);
    expect(existsSync(ledgerFile(mid, 'sid'))).toBe(false);

    // One store, and the second turn appended rather than restarting: the cursor
    // is read from the same root, so nothing is duplicated.
    const lines = readFileSync(ledgerFile(repo, 'sid'), 'utf-8').trim().split('\n');
    expect(lines).toEqual([userLine('q1'), asstLine('a1'), userLine('q2'), asstLine('a2')]);
  });

  it('reader resolves to the same root the writer used', () => {
    const tp = transcript([userLine('q'), asstLine('a')]);
    // Writer runs from one subdirectory...
    runHook(LEDGER_HOOK, { transcript_path: tp, cwd: nested, session_id: 'prior' });

    // ...reader starts a NEW session from a different subdirectory.
    const other = path.join(repo, 'docs');
    mkdirSync(other, { recursive: true });
    const r = runHook(READBACK_HOOK, { cwd: other, session_id: 'current' });

    expect(r.status).toBe(0);
    // A non-empty advisory proves the reader found the writer's prior-session
    // ledger; before the fix each root saw only its own slice.
    expect(r.stdout).not.toBe('');
    const parsed = JSON.parse(r.stdout);
    expect(parsed.hookSpecificOutput.additionalContext).toContain('지난 세션');
  });

  it('non-git project still stores at its own root, not an ancestor', () => {
    // Guards the fallback: a markerless directory must not climb to some
    // unrelated ancestor (notably never the home directory).
    const plain = path.join(tmp, 'plain');
    mkdirSync(plain, { recursive: true });
    const tp = transcript([userLine('q'), asstLine('a')]);

    runHook(LEDGER_HOOK, { transcript_path: tp, cwd: plain, session_id: 'sid' });

    expect(existsSync(ledgerFile(plain, 'sid'))).toBe(true);
    expect(existsSync(ledgerFile(tmp, 'sid'))).toBe(false);
  });
});
