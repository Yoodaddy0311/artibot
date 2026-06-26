/**
 * Unit tests for the cross-session ambient read-back advisory (Roadmap N1).
 *
 * @see lib/learning/ledger/readback.js
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _internals, buildReadbackAdvisory } from '../../../lib/learning/ledger/readback.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const tmpRoots = [];

function makeRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'artibot-readback-'));
  tmpRoots.push(root);
  return root;
}

function writeHandoff(root, body) {
  const dir = path.join(root, '.artibot');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'HANDOFF.md'), body, 'utf8');
}

function writeLedger(root, sessionId, line = '{"type":"user","message":{"content":"hi"}}') {
  const dir = path.join(root, '.artibot', 'ledger');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${sessionId}.jsonl`), `${line}\n`, 'utf8');
}

function writeWakeup(root, reason) {
  const dir = path.join(root, 'runtime');
  mkdirSync(dir, { recursive: true });
  const payload = { entries: [{ id: 'w1', reason, fulfilled: false }] };
  writeFileSync(path.join(dir, 'wakeup-requests.json'), JSON.stringify(payload), 'utf8');
}

afterEach(() => {
  while (tmpRoots.length) {
    try { rmSync(tmpRoots.pop(), { recursive: true, force: true }); } catch { /* noop */ }
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildReadbackAdvisory', () => {
  it('extracts the "> 다음 P0:" summary from the latest handoff (source=handoff)', async () => {
    const root = makeRoot();
    writeHandoff(
      root,
      ['# Handoff', '', '> 다음 P0: **N1 read-back** 미구현 — 세션 시작 advisory 배선 필요', ''].join('\n'),
    );

    const res = await buildReadbackAdvisory({ projectRoot: root });

    expect(res.source).toBe('handoff');
    expect(res.advisory).toContain('N1 read-back');
    expect(res.advisory).not.toContain('**'); // markdown emphasis stripped
    expect(res.advisory).toMatch(/^\[Artibot] 지난 세션: .* · 자세히 \/resume$/);
  });

  it('falls back to ledger when no handoff exists (source=ledger)', async () => {
    const root = makeRoot();
    writeLedger(root, 'prior-session');

    const res = await buildReadbackAdvisory({ projectRoot: root, currentSessionId: 'current' });

    expect(res.source).toBe('ledger');
    expect(res.advisory).toContain('/resume');
  });

  it('returns null/null for an empty project root', async () => {
    const root = makeRoot();

    const res = await buildReadbackAdvisory({ projectRoot: root });

    expect(res).toEqual({ advisory: null, source: null });
  });

  it('does not count the current session as a prior ledger', async () => {
    const root = makeRoot();
    writeLedger(root, 'only-me');

    const res = await buildReadbackAdvisory({ projectRoot: root, currentSessionId: 'only-me' });

    expect(res).toEqual({ advisory: null, source: null });
  });

  it('prefers handoff over ledger when both are present', async () => {
    const root = makeRoot();
    writeHandoff(root, '> 다음 P0: 핸드오프 우선 확인');
    writeLedger(root, 'prior-session');

    const res = await buildReadbackAdvisory({ projectRoot: root, currentSessionId: 'current' });

    expect(res.source).toBe('handoff');
    expect(res.advisory).toContain('핸드오프 우선');
  });

  it('surfaces a pending wakeup reason when handoff/ledger are absent (source=wakeup)', async () => {
    const root = makeRoot();
    writeWakeup(root, '벤치마크 재검증 대기 중');

    const res = await buildReadbackAdvisory({ projectRoot: root });

    expect(res.source).toBe('wakeup');
    expect(res.advisory).toContain('벤치마크 재검증');
  });

  it('never throws on missing/undefined opts or a non-directory root', async () => {
    await expect(buildReadbackAdvisory(undefined)).resolves.toEqual({ advisory: null, source: null });
    await expect(buildReadbackAdvisory({})).resolves.toEqual({ advisory: null, source: null });

    const root = makeRoot();
    const filePath = path.join(root, 'not-a-dir.txt');
    writeFileSync(filePath, 'x', 'utf8');
    // projectRoot points at a regular file → every source read fails gracefully.
    await expect(buildReadbackAdvisory({ projectRoot: filePath })).resolves.toEqual({
      advisory: null,
      source: null,
    });
  });

  it('truncates an over-long handoff headline to the cap', async () => {
    const root = makeRoot();
    const long = 'x'.repeat(300);
    writeHandoff(root, `> 다음 P0: ${long}`);

    const res = await buildReadbackAdvisory({ projectRoot: root });

    expect(res.source).toBe('handoff');
    expect(res.detail.headline.length).toBeLessThanOrEqual(_internals.MAX_HEADLINE);
    expect(res.detail.headline.endsWith('…')).toBe(true);
  });
});
