/**
 * Real-process contract for the argument surface of `scripts/ledger/route-compare.mjs`:
 * the `--since` cutoff, and what the CLI refuses to answer (a malformed request exits 2
 * with an empty stdout; an unreadable ledger path still exits 0 and says so in the census).
 *
 * Split out of `route-compare-cli.test.js` for the 800-line standard (V5-BACKLOG section 3);
 * the cases moved verbatim. The helpers they use (project root, CLI runner, one-line
 * parser, bind seeder) are repeated below instead of shared. Isolation is the original's:
 * every case builds its own `mkdtempSync` root and uses it as both the child cwd and
 * `--cwd`. The design rationale, why every root carries `artibot.config.json`, and the
 * list of what the suite cannot see are in `route-compare-cli.test.js`.
 *
 * @module tests/ledger/route-compare-cli-args
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendLedgerEvent } from '../../lib/runtime/ledger.js';
import { ledgerFilePath } from '../../lib/runtime/event-writer.js';

// This file spawns child processes. The budget buys headroom for load; nothing
// here waits on a timer.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(PLUGIN_ROOT, 'scripts', 'ledger', 'route-compare.mjs');

/**
 * The exact key set, IN ORDER, that the module header promises a caller can
 * parse blind. Order is pinned as well as membership: the promise is a fixed
 * line shape, and a reader diffing two runs of this tool reads the diff by eye.
 */
const STDOUT_KEYS = [
  'events', 'measured_at', 'ledger_path', 'since',
  'binds', 'duplicate_binds', 'malformed_binds',
  'receipts', 'main_thread_receipts', 'subagent_receipts', 'malformed_receipts',
  'model_mismatch', 'duplicate_receipts',
  'pairs', 'compared', 'excluded_fifo', 'excluded_no_recommendation',
  'by_agreement', 'agreement_rate', 'by_confidence',
  'agreed_by_model', 'divergence', 'multi_model_runs',
  'cost', 'usage_totals', 'latency',
  'unjoined_binds', 'unjoined_receipts', 'score', 'census',
];

/** @type {string} */
let tmp;

/** A project root the Artibot guards will actually run inside. */
function makeRoot(name) {
  const root = path.join(tmp, name);
  mkdirSync(path.join(root, '.git'), { recursive: true });
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'artibot.config.json'), '{}\n', 'utf-8');
  return root;
}

/** Run the CLI inside a project root. */
function runCli(args, root) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf-8', windowsHide: true, cwd: root, env: { ...process.env },
  });
  return { status: res.status, stdout: String(res.stdout || ''), stderr: String(res.stderr || '') };
}

/** The one JSON line, parsed, with the stream discipline checked first. */
function parseOne(out) {
  expect(out.stderr).toBe('');
  expect(out.status).toBe(0);
  expect(out.stdout.trim().split('\n')).toHaveLength(1);
  return JSON.parse(out.stdout);
}

/**
 * Append one `route.bound` row in the shape the SubagentStart hook writes.
 *
 * @param {string} root
 * @param {string} sessionId
 * @param {string} agentId
 * @param {{confidence: string, method: string, recommended?: string|null,
 *          selected?: string, now?: () => Date}} o
 * @returns {void}
 */
function seedBind(root, sessionId, agentId, o) {
  // KEY ORDER MIRRORS THE WRITER, `subagent-handler.js#bindRoute`: the four
  // required keys, then agent_type, matched_on, selected_model,
  // recommended_model, action_class in that order. Nothing validates key order,
  // so this buys no assertion — it is fixture honesty. A fixture that does not
  // look like the row it stands in for is the thing a reader trusts and should
  // not, and the two optional model keys are conditional in the writer too.
  const data = {
    tool_use_id: `toolu_${agentId}`,
    agent_id: agentId,
    confidence: o.confidence,
    method: o.method,
    agent_type: 'tdd-guide',
    matched_on: 'name',
  };
  if (typeof o.selected === 'string') data.selected_model = o.selected;
  if (typeof o.recommended === 'string') data.recommended_model = o.recommended;
  data.action_class = 'implement';
  const res = appendLedgerEvent(root, {
    event: 'route.bound',
    session_id: sessionId,
    source: 'hook',
    idempotency_key: `route.bound:${agentId}`,
    data,
  }, o.now === undefined ? {} : { now: o.now });
  // The seed is the premise of every count below; a silent write failure would
  // read as "the CLI counted wrong".
  expect(res.ok).toBe(true);
}

const OPUS = 'claude-opus-5';
const SESSION = 'sessSpawn0001';

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'artibot-rcmp-')));
});
afterEach(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
});

describe('route-compare: --since', () => {
  it('excludes rows written before the cutoff and says so in the census', () => {
    const root = makeRoot('G');
    seedBind(root, SESSION, 'old1', {
      confidence: 'exact', method: 'prompt_id+name', recommended: OPUS,
      now: () => new Date('2026-09-01T00:00:00Z'),
    });
    seedBind(root, SESSION, 'new2', {
      confidence: 'exact', method: 'prompt_id+name', recommended: OPUS,
      now: () => new Date('2026-09-13T00:00:00Z'),
    });

    const all = parseOne(runCli(['--cwd', root], root));
    const recent = parseOne(runCli(['--cwd', root, '--since', '2026-09-10T00:00:00Z'], root));

    expect(all.binds).toBe(2);
    expect(all.since).toBeNull();
    expect(recent.binds).toBe(1);
    // The cutoff is echoed as the RESOLVED instant, so a reader never has to
    // re-parse the argument to know what was actually cut at.
    expect(recent.since).toBe('2026-09-10T00:00:00.000Z');
    // A filtered row is SELECTION, not loss: a rate built from survivors alone
    // cannot tell the two apart.
    expect(recent.census.dropped.selection.filtered_out).toBe(1);
    expect(recent.census.dropped_total.loss).toBe(0);
  });

  it('accepts epoch milliseconds and cuts at the same instant as the ISO form', () => {
    const root = makeRoot('H');
    seedBind(root, SESSION, 'old1', {
      confidence: 'exact', method: 'prompt_id+name', recommended: OPUS,
      now: () => new Date('2026-09-01T00:00:00Z'),
    });
    seedBind(root, SESSION, 'new2', {
      confidence: 'exact', method: 'prompt_id+name', recommended: OPUS,
      now: () => new Date('2026-09-13T00:00:00Z'),
    });

    const iso = parseOne(runCli(['--cwd', root, '--since', '2026-09-10T00:00:00Z'], root));
    const epoch = parseOne(runCli([
      '--cwd', root, '--since', String(Date.parse('2026-09-10T00:00:00Z')),
    ], root));

    // Date.parse reads an all-digit string as something other than a stamp, so
    // this case is the one that catches a regression to a bare Date.parse.
    expect(epoch.since).toBe(iso.since);
    expect(epoch.since).toBe('2026-09-10T00:00:00.000Z');
    expect(epoch.binds).toBe(1);
    expect(epoch.binds).toBe(iso.binds);
  });
});

describe('route-compare: what it refuses to answer', () => {
  it.each([
    ['an unknown flag is passed', ['--oops']],
    ['a flag has no value', ['--cwd']],
    ['--since has no value', ['--since']],
    ['--since does not parse to a time', ['--since', 'nonsense']],
    ['--since is empty', ['--since', '   ']],
  ])('exits 2 with an empty stdout when %s', (_label, args) => {
    const root = makeRoot('I');

    const out = runCli(args, root);

    // A malformed request is not an observation. Exiting 0 here would report a
    // measurement that was never taken, so a typo could read as success.
    expect(out.status).toBe(2);
    expect(out.stdout).toBe('');
    expect(out.stderr.trim().split('\n')).toHaveLength(1);
    expect(out.stderr.startsWith('route-compare:')).toBe(true);
    expect(existsSync(ledgerFilePath(root))).toBe(false);
  });

  it('still exits 0 when the ledger path is not a readable file', () => {
    const root = makeRoot('J');
    // A DIRECTORY where the ledger file belongs: present, not readable as text.
    mkdirSync(ledgerFilePath(root), { recursive: true });

    const printed = parseOne(runCli(['--cwd', root], root));

    // "The ledger cannot be read" is a finding about the project, not a failure
    // of this script — and the JSON is what says which of the two it was.
    expect(printed.census.file.present).toBe(true);
    expect(printed.census.file.readable).toBe(false);
    expect(printed.binds).toBe(0);
    expect(printed.receipts).toBe(0);
    expect(printed.agreement_rate).toBeNull();
    // The reader swallows an unreadable path and reports it in the census, so
    // this branch is NOT the `error` branch: `error` is reserved for a throw
    // that escaped the reader. A test that expected `error` here would be
    // asserting a shape this repo's reader never produces.
    expect(printed.error).toBeUndefined();
    expect(Object.keys(printed)).toEqual(STDOUT_KEYS);
  });
});
