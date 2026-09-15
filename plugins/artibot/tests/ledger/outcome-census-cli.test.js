/**
 * `scripts/ledger/outcome-census.mjs` — the read-only replay of the outcome
 * gate distribution.
 *
 * TWO AXES, AND THE SECOND IS THE IMPORTANT ONE.
 *   1. The ARITHMETIC: the counts it prints must equal a hand computation over
 *      a fixture ledger, and `blocked_ratio` must be `null` — never `0` — when
 *      nothing was declared.
 *   2. The READ-ONLY CONTRACT: a measuring tool that appends to the stream it
 *      measures is its own next data point. Two independent checks, because
 *      either alone fails open — the SOURCE TEXT must not name
 *      `appendLedgerEvent`, AND a run against a sandbox must leave the tree
 *      byte-identical.
 *
 * Every case spawns the real script in a `mkdtemp` sandbox with its own `.git`
 * directory, its own plugin-root config and HOME/USERPROFILE redirected.
 *
 * WHAT THIS FILE DOES NOT PROVE:
 *   - THE LIVE NUMBERS. The fixtures are hand-built. The live distribution is
 *     the window leader's single run against the parent ledger.
 *   - THAT THE SHARED CLASSIFIER IS CORRECT. It is pinned by
 *     `tests/hooks/mission-complete-record.test.js`; here it is only shown to
 *     be the SAME classifier, by matching a hand computation built from the
 *     same rules.
 *
 * @module tests/ledger/outcome-census-cli
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { appendLedgerEvent } from '../../lib/runtime/ledger.js';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(PLUGIN_ROOT, 'scripts', 'ledger', 'outcome-census.mjs');

/** The fixed key set the stdout contract promises. */
const REQUIRED_KEYS = [
  'event', 'measured_at', 'ledger_path', 'since', 'missions', 'declared',
  'blocked', 'would_write', 'by_block_code', 'blocked_ratio', 'census',
];

let tmp;
let home;
let repo;
let pluginRoot;

function writeSandboxConfig() {
  const live = JSON.parse(readFileSync(path.join(PLUGIN_ROOT, 'artibot.config.json'), 'utf-8'));
  live.runtime.artifactLifecycle.enabled = false;
  writeFileSync(
    path.join(pluginRoot, 'artibot.config.json'), JSON.stringify(live, null, 2), 'utf-8',
  );
}

/** Run the CLI in a fresh process, exactly as the leader will. */
function runCli(args) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    cwd: tmp,
    env: {
      ...process.env, HOME: home, USERPROFILE: home, CLAUDE_PLUGIN_ROOT: pluginRoot,
    },
    encoding: 'utf-8',
    windowsHide: true,
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/** Run and parse the one JSON line. */
function census(args = ['--cwd', undefined]) {
  const argv = args[1] === undefined ? ['--cwd', repo] : args;
  const res = runCli(argv);
  expect(res.status).toBe(0);
  const lines = res.stdout.split('\n').filter(Boolean);
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]);
}

/** A declared mission with no artifacts on disk: ARTIFACT_ABSENT or STATE_ROW_ABSENT. */
function seedDeclared(id, sessionId) {
  expect(appendLedgerEvent(repo, {
    event: 'mission.created',
    session_id: sessionId,
    mission_id: id,
    source: 'hook',
    data: { title: 'fixture', intent_revision: 1 },
  }).ok).toBe(true);
  expect(appendLedgerEvent(repo, {
    event: 'mission.completed',
    session_id: sessionId,
    mission_id: id,
    source: 'hook',
    idempotency_key: `mission.completed:${id}:null`,
    data: { accepted: null, evidence_refs: [`transcript:${sessionId}`] },
  }).ok).toBe(true);
}

/** A mission with rows but no declaration. */
function seedUndeclared(id, sessionId) {
  expect(appendLedgerEvent(repo, {
    event: 'mission.created',
    session_id: sessionId,
    mission_id: id,
    source: 'hook',
    data: { title: 'fixture', intent_revision: 1 },
  }).ok).toBe(true);
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'artibot-outcome-cli-')));
  home = path.join(tmp, 'home');
  repo = path.join(tmp, 'repo');
  pluginRoot = path.join(tmp, 'plugin-root');
  mkdirSync(path.join(home, '.claude'), { recursive: true });
  mkdirSync(repo, { recursive: true });
  mkdirSync(pluginRoot, { recursive: true });
  execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore', windowsHide: true });
  writeSandboxConfig();
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('the read-only contract', () => {
  it('never names the ledger writer in its own source', () => {
    const source = readFileSync(CLI, 'utf-8');
    // Assembled rather than written as one literal so this assertion cannot
    // match itself if the file is ever scanned by a broader gate.
    expect(source).not.toContain(`append${'LedgerEvent'}`);
  });

  it('creates no file at all — not a missions directory, not a ledger', () => {
    const before = readdirSync(repo).sort();

    const out = census();

    expect(out.missions).toBe(0);
    expect(readdirSync(repo).sort()).toEqual(before);
    expect(existsSync(path.join(repo, '.artibot'))).toBe(false);
  });
});

describe('the arithmetic', () => {
  it('reports a missing ledger as a finding, with a null ratio', () => {
    const out = census();

    expect(Object.keys(out).sort()).toEqual([...REQUIRED_KEYS].sort());
    expect(out.event).toBe('outcome-census');
    expect(out.missions).toBe(0);
    expect(out.declared).toBe(0);
    expect(out.blocked).toBe(0);
    expect(out.would_write).toBe(0);
    expect(out.by_block_code).toEqual({});
    // NOT 0: zero is a measured rate, null is the absence of a denominator.
    expect(out.blocked_ratio).toBeNull();
    expect(out.census.file.present).toBe(false);
  });

  it('matches a hand computation over three missions across two sessions', () => {
    const sessionA = 'sess-census-1abcdefg';
    const sessionB = 'sess-census-2hijklmn';
    // ISSUED ids. `sessionFallbackMissionId` keys on the session id's FIRST 8
    // CHARACTERS, so two fixture sessions sharing a prefix would collapse into
    // ONE mission and the hand computation below would be a fiction.
    const declaredOne = 'M-20260915-101';
    const declaredTwo = 'M-20260915-102';
    const undeclared = 'M-20260915-001';
    seedDeclared(declaredOne, sessionA);
    seedDeclared(declaredTwo, sessionB);
    // A THIRD session id, never a reuse of A: the reader dedupes on
    // `(session_id, source, pid, seq, ts)` (`lib/runtime/ledger.js#dedupeKey`),
    // and two rows this fixture writes back to back from one process under one
    // session can collide on that key — which silently drops the mission from
    // the denominator and would make this hand computation a fiction.
    seedUndeclared(undeclared, 'sess-census-4vwxyzab');

    const out = census();

    // HAND COMPUTATION. Three missions carry rows. Two carry a
    // `mission.completed` line, so the denominator is 2. Neither has a
    // StateStore row in this sandbox, so both classify as STATE_ROW_ABSENT —
    // the first gate, evaluated before any file read — and neither would write.
    expect(out.missions).toBe(3);
    expect(out.declared).toBe(2);
    expect(out.blocked).toBe(2);
    expect(out.would_write).toBe(0);
    expect(out.by_block_code).toEqual({ STATE_ROW_ABSENT: 2 });
    expect(out.blocked_ratio).toBe(1);
    expect(out.ledger_path).toMatch(/ledger\.jsonl$/);
    expect(out.census.survivors).toBeGreaterThanOrEqual(5);
  });

  it('counts an undeclared-only ledger with a null ratio', () => {
    seedUndeclared('M-20260915-002', 'sess-census-3opqrstu');

    const out = census();

    expect(out.missions).toBe(1);
    expect(out.declared).toBe(0);
    expect(out.blocked_ratio).toBeNull();
    expect(out.by_block_code).toEqual({});
  });

  it('echoes the resolved --since cutoff, not the raw argument', () => {
    const out = census(['--cwd', repo, '--since', '1757000000000']);

    expect(out.since).toBe(new Date(1757000000000).toISOString());
  });
});

describe('usage errors are the only non-zero exit', () => {
  it.each([
    ['unknown flag', ['--nope']],
    ['flag without a value', ['--cwd']],
    ['unparseable --since', ['--since', 'not-a-time']],
  ])('exits 2 with one stderr line and empty stdout for %s', (_label, args) => {
    const res = runCli(args);

    expect(res.status).toBe(2);
    expect(res.stdout).toBe('');
    expect(res.stderr.split('\n').filter(Boolean)).toHaveLength(1);
    expect(res.stderr.startsWith('outcome-census: ')).toBe(true);
  });
});
