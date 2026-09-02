import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  appendSpawn, LEDGER_REL, readSpawns, SPAWN_FILE, spawnLedgerPath, summarizeSpawns,
} from '../../lib/learning/ledger/spawn-ledger.js';
import { _internals as storeInternals } from '../../lib/learning/ledger/store.js';
import { loadConfig } from '../../lib/core/config.js';
import { resolveModel } from '../../lib/core/model-policy.js';

/**
 * Subagent spawn ledger — unit tests for the NDJSON store plus a child-process
 * integration run of `scripts/hooks/subagent-handler.js start|stop`.
 *
 * Why a child process: the existing subagent-handler.test.js mocks node:fs and
 * the stdout writer, which is the right shape for state-machine assertions but
 * cannot prove the two properties this ledger cares about — that a real line
 * lands on disk under the project root resolved from the payload `cwd`, and
 * that the hook's stdout contract (`{ message }` JSON, exit 0) is unchanged.
 *
 * What this file does NOT prove (rules §9): that Claude Code's live
 * SubagentStart/SubagentStop payloads carry `cwd`/`session_id` under the keys
 * read here — the fixture payloads are hand-written to the documented shape.
 */

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK = path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'subagent-handler.js');

/**
 * Run the hook as the dispatcher would: fresh node process, JSON on stdin,
 * sub-command as argv. HOME/USERPROFILE point at the temp dir so
 * `~/.claude/artibot-state.json` is the sandbox's, never the developer's.
 * @param {object} payload
 * @param {string} action
 * @param {string} home
 * @returns {{ status: number|null, stdout: string, stderr: string }}
 */
function runHook(payload, action, home) {
  const res = spawnSync(process.execPath, [HOOK, action], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    env: { ...process.env, HOME: home, USERPROFILE: home },
    windowsHide: true,
  });
  return { status: res.status, stdout: String(res.stdout || ''), stderr: String(res.stderr || '') };
}

const startRecord = (over = {}) => ({
  sessionId: 'sess-1',
  agentId: 'a1',
  agentName: 'lane-f',
  agentType: 'tdd-guide',
  requestedModel: 'claude-opus-5',
  canonicalModel: 'claude-opus-5',
  modelMismatch: false,
  event: 'start',
  ...over,
});

describe('spawn-ledger store', () => {
  let tmp;

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'artibot-spawn-ledger-')));
  });
  afterEach(() => {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  });

  it('shares the ambient ledger directory convention with store.js', () => {
    expect(LEDGER_REL).toBe(storeInternals.LEDGER_REL);
    expect(spawnLedgerPath(tmp)).toBe(path.join(tmp, '.artibot', 'ledger', SPAWN_FILE));
    // `.ndjson` keeps the file out of rotateLedger's `*.jsonl` sweep.
    expect(SPAWN_FILE.endsWith('.jsonl')).toBe(false);
  });

  it('appendSpawn writes one valid NDJSON line per call and creates the dir', () => {
    const fixedNow = () => new Date('2026-09-02T01:02:03.000Z');
    const r1 = appendSpawn(tmp, startRecord(), { now: fixedNow });
    const r2 = appendSpawn(tmp, startRecord({ event: 'stop', durationMs: 1234.6 }), { now: fixedNow });
    expect(r1).toEqual({ ok: true, path: spawnLedgerPath(tmp) });
    expect(r2.ok).toBe(true);

    const raw = readFileSync(spawnLedgerPath(tmp), 'utf-8');
    expect(raw.endsWith('\n')).toBe(true);
    const lines = raw.split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed[0]).toEqual({
      ts: '2026-09-02T01:02:03.000Z',
      sessionId: 'sess-1',
      agentId: 'a1',
      agentName: 'lane-f',
      agentType: 'tdd-guide',
      requestedModel: 'claude-opus-5',
      canonicalModel: 'claude-opus-5',
      modelMismatch: false,
      event: 'start',
    });
    expect(parsed[0]).not.toHaveProperty('durationMs');
    expect(parsed[1].event).toBe('stop');
    expect(parsed[1].durationMs).toBe(1235);
  });

  it('appendSpawn normalizes missing fields to null and drops unknown keys', () => {
    appendSpawn(tmp, { event: 'start', agentId: 'x', bogus: 'dropped', modelMismatch: 'yes' });
    const [rec] = readSpawns(tmp);
    expect(rec.sessionId).toBeNull();
    expect(rec.requestedModel).toBeNull();
    expect(rec.canonicalModel).toBeNull();
    expect(rec.modelMismatch).toBe(false);
    expect(rec).not.toHaveProperty('bogus');
    expect(typeof rec.ts).toBe('string');
  });

  it('appendSpawn never throws: bad root / bad event / unwritable path', () => {
    expect(appendSpawn('', startRecord())).toEqual({ ok: false, reason: 'no-project-root' });
    expect(appendSpawn(tmp, { ...startRecord(), event: 'boom' })).toEqual({ ok: false, reason: 'invalid-event' });
    expect(appendSpawn(tmp, null)).toEqual({ ok: false, reason: 'invalid-event' });
    // A regular file where the ledger DIRECTORY must go → mkdir fails.
    const blocked = path.join(tmp, 'blocked');
    mkdirSync(blocked);
    writeFileSync(path.join(blocked, '.artibot'), 'not a dir', 'utf-8');
    const r = appendSpawn(blocked, startRecord());
    expect(r.ok).toBe(false);
    expect(typeof r.reason).toBe('string');
    expect(existsSync(spawnLedgerPath(blocked))).toBe(false);
  });

  it('appendSpawn redacts secrets per string field and keeps the line valid JSON', () => {
    // Built at runtime so no secret-shaped literal lives in the source tree.
    // Matches pii-detector's `credential_assignment` (category: secrets).
    const secretValue = 'v'.repeat(24);
    appendSpawn(tmp, startRecord({ agentName: `credential=${secretValue}` }));
    const raw = readFileSync(spawnLedgerPath(tmp), 'utf-8');
    expect(raw).not.toContain(secretValue);
    expect(raw).toContain('REDACTED');
    // Per-field scrubbing: the line must still parse and the other fields
    // must be untouched. (Scrubbing the serialized line instead lets the
    // pattern's optional trailing quote eat the JSON closing quote.)
    const rec = JSON.parse(raw.trim());
    expect(rec.agentName).toContain('REDACTED');
    expect(rec.agentId).toBe('a1');
    expect(rec.event).toBe('start');
  });

  it('readSpawns returns [] when the file is missing and tolerates corrupt lines', () => {
    expect(readSpawns(tmp)).toEqual([]);
    expect(readSpawns('')).toEqual([]);
    appendSpawn(tmp, startRecord({ agentId: 'good-1' }));
    writeFileSync(spawnLedgerPath(tmp), '{"broken": \n\n[1,2,3]\n"just a string"\n', { flag: 'a' });
    appendSpawn(tmp, startRecord({ agentId: 'good-2' }));
    const ids = readSpawns(tmp).map((r) => r.agentId);
    expect(ids).toEqual(['good-1', 'good-2']);
  });

  it('readSpawns filters by sessionId and since', () => {
    const at = (iso) => ({ now: () => new Date(iso) });
    appendSpawn(tmp, startRecord({ sessionId: 's1', agentId: 'old' }), at('2026-09-01T00:00:00.000Z'));
    appendSpawn(tmp, startRecord({ sessionId: 's2', agentId: 'mid' }), at('2026-09-02T00:00:00.000Z'));
    appendSpawn(tmp, startRecord({ sessionId: 's1', agentId: 'new' }), at('2026-09-03T00:00:00.000Z'));

    expect(readSpawns(tmp, { sessionId: 's1' }).map((r) => r.agentId)).toEqual(['old', 'new']);
    expect(readSpawns(tmp, { since: '2026-09-02T00:00:00.000Z' }).map((r) => r.agentId)).toEqual(['mid', 'new']);
    expect(readSpawns(tmp, { since: Date.parse('2026-09-03T00:00:00.000Z'), sessionId: 's1' }).map((r) => r.agentId)).toEqual(['new']);
  });

  it('summarizeSpawns counts start events per session and model, tracks lastTs', () => {
    const recs = [
      { ts: '2026-09-02T00:00:01.000Z', sessionId: 's1', event: 'start', canonicalModel: 'claude-opus-5' },
      { ts: '2026-09-02T00:00:02.000Z', sessionId: 's1', event: 'start', canonicalModel: 'claude-fable-5-1' },
      { ts: '2026-09-02T00:00:05.000Z', sessionId: 's1', event: 'stop', canonicalModel: 'claude-opus-5', durationMs: 4000 },
      { ts: '2026-09-02T00:00:03.000Z', sessionId: 's2', event: 'start', canonicalModel: null, requestedModel: 'claude-opus-5' },
      { ts: '2026-09-02T00:00:04.000Z', event: 'start' },
      null,
      'garbage',
    ];
    expect(summarizeSpawns(recs)).toEqual({
      total: 4,
      bySession: {
        s1: { count: 2, byModel: { 'claude-opus-5': 1, 'claude-fable-5-1': 1 } },
        s2: { count: 1, byModel: { 'claude-opus-5': 1 } },
        unknown: { count: 1, byModel: { unknown: 1 } },
      },
      lastTs: '2026-09-02T00:00:05.000Z',
    });
    expect(summarizeSpawns([])).toEqual({ total: 0, bySession: {}, lastTs: null });
    expect(summarizeSpawns(undefined)).toEqual({ total: 0, bySession: {}, lastTs: null });
  });

  it('summarizeSpawns is pure (does not mutate its input)', () => {
    const recs = [{ ts: 't', sessionId: 's', event: 'start', canonicalModel: 'm' }];
    const snapshot = JSON.stringify(recs);
    summarizeSpawns(recs);
    expect(JSON.stringify(recs)).toBe(snapshot);
  });
});

describe('subagent-handler.js spawn ledger integration (child process)', () => {
  let tmp;
  let home;
  let repo;
  let nested;

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'artibot-spawn-hook-')));
    home = path.join(tmp, 'home');
    repo = path.join(tmp, 'repo');
    nested = path.join(repo, 'packages', 'app');
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    mkdirSync(nested, { recursive: true });
    execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore', windowsHide: true });
  });
  afterEach(() => {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  });

  it('start appends a start record under the repo root resolved from a nested cwd', async () => {
    const r = runHook({
      session_id: 'sess-int',
      agent_id: 'agent-int-1',
      agent_type: 'tdd-guide',
      name: 'lane-f',
      cwd: nested,
    }, 'start', home);

    expect(r.status).toBe(0);
    // stdout contract: exactly one JSON object carrying `message`.
    const out = JSON.parse(r.stdout.trim());
    expect(Object.keys(out)).toEqual(['message']);
    expect(out.message).toContain('[team] Agent registered: agent-int-1');

    const file = spawnLedgerPath(repo);
    expect(existsSync(file)).toBe(true);
    expect(existsSync(spawnLedgerPath(nested))).toBe(false);
    const recs = readSpawns(repo, { sessionId: 'sess-int' });
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({
      sessionId: 'sess-int',
      agentId: 'agent-int-1',
      agentName: 'lane-f',
      agentType: 'tdd-guide',
      event: 'start',
      requestedModel: null,
      modelMismatch: false,
    });
    // tdd-guide is listed in the shipped policy, so the hook records the
    // effective policy TIER from resolveModel (e.g. 'opus'), not a model id.
    // Compare against the policy itself so a tier change cannot rot this test.
    const expectedTier = resolveModel('tdd-guide', {}, await loadConfig());
    expect(typeof expectedTier).toBe('string');
    expect(recs[0].canonicalModel).toBe(expectedTier);
    // State file landed in the sandboxed HOME, not the developer's.
    expect(existsSync(path.join(home, '.claude', 'artibot-state.json'))).toBe(true);
  });

  it('stop appends a stop record with durationMs when the start was tracked', () => {
    const payload = { session_id: 'sess-int', agent_id: 'agent-int-2', agent_type: 'tdd-guide', cwd: repo };
    expect(runHook(payload, 'start', home).status).toBe(0);
    const r = runHook(payload, 'stop', home);

    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(Object.keys(out)).toEqual(['message']);
    expect(out.message).toBe('[team] Agent deregistered: agent-int-2');

    const recs = readSpawns(repo, { sessionId: 'sess-int' });
    expect(recs.map((x) => x.event)).toEqual(['start', 'stop']);
    const stop = recs[1];
    expect(stop.agentId).toBe('agent-int-2');
    expect(stop.agentType).toBe('tdd-guide');
    expect(stop.canonicalModel).toBe(recs[0].canonicalModel);
    expect(Number.isInteger(stop.durationMs)).toBe(true);
    expect(stop.durationMs).toBeGreaterThanOrEqual(0);
    expect(summarizeSpawns(recs)).toMatchObject({ total: 1, bySession: { 'sess-int': { count: 1 } } });
  });

  it('stop for an untracked agent records no durationMs but still exits 0', () => {
    const r = runHook({ session_id: 'sess-int', agent_id: 'ghost', cwd: repo }, 'stop', home);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout.trim()).message).toContain('deregistered');
    const [rec] = readSpawns(repo);
    expect(rec).toMatchObject({ event: 'stop', agentId: 'ghost', canonicalModel: null });
    expect(rec).not.toHaveProperty('durationMs');
  });

  it('skips the ledger (no file, same stdout, exit 0) when the payload has no cwd', () => {
    const r = runHook({ session_id: 'sess-int', agent_id: 'no-cwd', agent_type: 'tdd-guide' }, 'start', home);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout.trim()).message).toContain('[team] Agent registered: no-cwd');
    expect(existsSync(spawnLedgerPath(repo))).toBe(false);
  });
});
