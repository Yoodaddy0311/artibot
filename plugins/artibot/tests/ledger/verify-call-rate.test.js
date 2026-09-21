/**
 * Real-process contract for `scripts/ledger/verify-call-rate.mjs` — the
 * read-only CLI that reports how many sessions that CALLED `/verify` also left
 * a `record-verify` self-report behind.
 *
 * WHY THESE CASES SPAWN A PROCESS. The counting rule this CLI adds is not in
 * any library: `lib/verification/verify-rate.js` knows nothing about a carrier
 * row, and `tests/verification/verify-rate.test.js` therefore cannot see the
 * join this file exercises. Only a spawn shows the single `readLedgerCensus`
 * read, the two separate denominators, the exit codes, and the one property
 * that matters most here.
 *
 * READ-ONLY IS ASSERTED, NOT DECLARED — the same standard
 * `tests/ledger/verify-rate.test.js` set. The import set of the source is
 * checked as an ALLOWLIST (three specifiers, nothing else) rather than as a
 * deny list of writer names, because a deny list is fail-open against the next
 * writer somebody adds; and the scanner that enforces it is itself given a
 * fabricated source string carrying a writer import, so a scanner that cannot
 * show a red does not get to be green. On top of the source check, the ledger's
 * bytes, size, mtime and directory listing are captured around a real spawn.
 *
 * THE FIXTURES ARE NOT THE LIVE LEDGER (rules §9). Measured by the limb leader
 * on this machine's live ledger 2026-09-21 17:56 KST, 9,591 lines: 11
 * `intent.detected` rows and 4 `tool.used` Skill rows, and NOT ONE of the 15
 * names `verify`. Every verify-carrying line below was written by this file.
 * A green run here says the arithmetic is right; it says nothing about what the
 * live rate is, and the live rate is `null` on both carriers.
 *
 * @module tests/ledger/verify-call-rate
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync,
  statSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ledgerFilePath } from '../../lib/runtime/event-writer.js';
import { computeVerifyRate, SELF_REPORT_NOTE } from '../../lib/verification/verify-rate.js';

// This file spawns child processes. The budget buys headroom for load; nothing
// here waits on a timer.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(PLUGIN_ROOT, 'scripts', 'ledger', 'verify-call-rate.mjs');
const SIBLING_CLI = path.join(PLUGIN_ROOT, 'scripts', 'ledger', 'verify-rate.mjs');

/** The exact key set the module header promises a caller can parse blind. */
const STDOUT_KEYS = ['ok', 'reason', 'file', 'call_rate', 'census'];

/** The key order of one carrier report, pinned so a caller can read positionally. */
const CARRIER_KEYS = [
  'rows', 'sessions', 'verify_rows', 'verify_sessions', 'answered_sessions',
  'rate', 'status', 'self_report_sessions',
];

const STAMP = '20260921T120000Z';

/** @type {string} */
let tmp;
let seq = 0;

/**
 * A project root the Artibot guards will actually run inside — a bare `.git/`
 * is not enough, per `tests/ledger/record-verify.test.js:33-39`.
 *
 * @param {string} name
 * @returns {string}
 */
function makeRoot(name) {
  const root = path.join(tmp, name);
  mkdirSync(path.join(root, '.git'), { recursive: true });
  writeFileSync(path.join(root, 'artibot.config.json'), '{}\n', 'utf-8');
  return root;
}

/**
 * One `verify.completed` envelope. `seq` is unique per line because
 * `lib/runtime/ledger.js#dedupeKey` keys on session/source/pid/seq/ts.
 *
 * @param {{session: string|null, vid: string, layer: string|null, result: string,
 *          note?: string, ts: string}} p
 * @returns {object}
 */
function line({ session, vid, layer, result, note, ts }) {
  seq += 1;
  const data = {
    result,
    evidence: note === undefined ? [] : [{ kind: 'command', command: '/verify', output: '', note }],
    verification_id: vid,
  };
  if (layer !== null) data.layer = layer;
  const envelope = {
    ts, event: 'verify.completed', source: 'gate', pid: 4242, seq,
    idempotency_key: `${vid}:${layer ?? 'overall'}`, data,
  };
  if (session !== null) envelope.session_id = session;
  return envelope;
}

/**
 * @param {{session: string, vid: string, ts: string}} p
 * @returns {object[]}
 */
function hookRun({ session, vid, ts }) {
  return ['deterministic', 'behavioral', 'operational', null]
    .map((layer) => line({ session, vid, layer, result: 'unmeasured', ts }));
}

/**
 * @param {{session: string|null, vid: string, ts: string}} p
 * @returns {object[]}
 */
function selfReportRun({ session, vid, ts }) {
  return [
    line({ session, vid, layer: 'deterministic', result: 'pass', note: SELF_REPORT_NOTE, ts }),
    line({ session, vid, layer: 'behavioral', result: 'unmeasured', ts }),
    line({ session, vid, layer: 'operational', result: 'unmeasured', ts }),
    line({ session, vid, layer: null, result: 'pass', ts }),
  ];
}

/**
 * One `intent.detected` carrier row, shaped exactly as
 * `scripts/hooks/runtime-prompt.js#recordSlashCommandInvoked` writes it.
 *
 * @param {{session: string|null, command: unknown, ts: string}} p
 * @returns {object}
 */
function intentRow({ session, command, ts }) {
  seq += 1;
  const envelope = {
    ts, event: 'intent.detected', source: 'hook', pid: 4243, seq,
    data: { type: 'slash-command', confidence: 1 },
  };
  if (command !== undefined) envelope.data.command = command;
  if (session !== null) envelope.session_id = session;
  return envelope;
}

/**
 * One `tool.used` Skill carrier row, shaped as
 * `scripts/hooks/tool-used-record.js` writes it (an unknown skill OMITS the
 * key rather than writing null — see that file's decision ①).
 *
 * @param {{session: string|null, skill: unknown, ts: string, tool?: string}} p
 * @returns {object}
 */
function toolRow({ session, skill, ts, tool = 'Skill' }) {
  seq += 1;
  const envelope = {
    ts, event: 'tool.used', source: 'hook', pid: 4244, seq,
    data: { tool, ok: true, duration_ms: 7 },
  };
  if (skill !== undefined) envelope.data.skill = skill;
  if (session !== null) envelope.session_id = session;
  return envelope;
}

/**
 * Write a list of events to the root's real ledger path, one JSON line each.
 *
 * @param {string} root
 * @param {object[]} events
 * @returns {string} the ledger file path
 */
function writeLedger(root, events) {
  const file = ledgerFilePath(root);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${events.map((e) => JSON.stringify(e)).join('\n')}\n`, 'utf-8');
  return file;
}

/**
 * The mixed fixture the denominator cases share.
 *
 * Four sessions, deliberately asymmetric so the two carriers CANNOT report the
 * same numbers:
 *   S1 — intent `/verify` + a self-report            (answered on intent only)
 *   S2 — intent `/verify`, no self-report            (unanswered on intent)
 *   S3 — tool.used `artibot:verify` + a self-report  (answered on tool only)
 *   S4 — a self-report and NO carrier row at all     (the third split bucket)
 * Plus negative controls that must not count as a verify call anywhere:
 * `verify-something`, `artibot:save`, and a non-Skill `tool.used` row.
 *
 * @param {string} root
 * @returns {string} the ledger file path
 */
function writeMixedFixture(root) {
  const ts = '2026-09-21T12:00:00.000Z';
  return writeLedger(root, [
    intentRow({ session: 'S1', command: 'verify', ts }),
    intentRow({ session: 'S2', command: '/verify', ts }),
    intentRow({ session: 'S2', command: 'verify-something', ts }),
    intentRow({ session: 'S3', command: 'split', ts }),
    toolRow({ session: 'S3', skill: 'artibot:verify', ts }),
    toolRow({ session: 'S1', skill: 'artibot:save', ts }),
    toolRow({ session: 'S2', skill: 'verify', tool: 'Read', ts }),
    ...selfReportRun({ session: 'S1', vid: `v1-aaaaaaaaaaaa-${STAMP}`, ts }),
    ...selfReportRun({ session: 'S3', vid: `v1-bbbbbbbbbbbb-${STAMP}`, ts }),
    ...selfReportRun({ session: 'S4', vid: `v1-cccccccccccc-${STAMP}`, ts }),
    ...hookRun({ session: 'S2', vid: `v1-dddddddddddd-${STAMP}`, ts }),
  ]);
}

/**
 * @param {string[]} args
 * @param {string} root child cwd
 * @param {string} [cli]
 * @returns {{status: number|null, stdout: string, stderr: string}}
 */
function runCli(args, root, cli = CLI) {
  const res = spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf-8', windowsHide: true, cwd: root,
  });
  return { status: res.status, stdout: String(res.stdout || ''), stderr: String(res.stderr || '') };
}

/** The one JSON line, with its key set checked before anything reads a field. */
function parseOut(out) {
  expect(out.stdout.split('\n').filter((l) => l.trim() !== '')).toHaveLength(1);
  const printed = JSON.parse(out.stdout);
  expect(Object.keys(printed)).toEqual(STDOUT_KEYS);
  return printed;
}

/** Snapshot of everything a writer would disturb. */
function snapshot(file) {
  const dir = path.dirname(file);
  return {
    bytes: readFileSync(file),
    mtimeMs: statSync(file).mtimeMs,
    size: statSync(file).size,
    listing: readdirSync(dir).sort(),
  };
}

/** @param {string} file @param {ReturnType<typeof snapshot>} before */
function expectUntouched(file, before) {
  const after = statSync(file);
  expect(after.mtimeMs).toBe(before.mtimeMs);
  expect(after.size).toBe(before.size);
  expect(readFileSync(file).equals(before.bytes)).toBe(true);
  expect(readdirSync(path.dirname(file)).sort()).toEqual(before.listing);
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'artibot-vcall-')));
});
afterEach(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
});

// ── 1. writer import 0 ──────────────────────────────────────────────────────

/** The ONLY three specifiers this reader may import. An allowlist, not a deny list. */
const ALLOWED_SPECIFIERS = [
  '../../lib/runtime/ledger.js',
  '../../lib/verification/verify-rate.js',
  '../hooks/_main-entry.js',
];

/** Spellings that would make this reader a writer. */
const WRITER_TOKENS = /appendLedgerEvent|recordVerification|writeFileSync|appendFileSync|mkdirSync/;

/**
 * Every `from '...'` specifier in a source, in order of appearance.
 *
 * @param {string} source
 * @returns {string[]}
 */
function importSpecifiers(source) {
  return [...source.matchAll(/(?:^|\n)\s*import[^;]*?from\s+'([^']+)'/g)].map((m) => m[1]);
}

/**
 * The read-only property, as one function so the self-test can aim at it.
 *
 * @param {string} source
 * @returns {string[]} findings; empty means clean
 */
function readOnlyFindings(source) {
  const findings = [];
  for (const spec of importSpecifiers(source)) {
    if (!ALLOWED_SPECIFIERS.includes(spec)) findings.push(`unlisted import: ${spec}`);
  }
  const writer = WRITER_TOKENS.exec(source);
  if (writer !== null) findings.push(`writer token: ${writer[0]}`);
  return findings;
}

describe('verify-call-rate CLI: it imports no writer', () => {
  const source = readFileSync(CLI, 'utf-8');

  it('imports exactly the three allowlisted specifiers and no writer token', () => {
    expect(importSpecifiers(source).sort()).toEqual([...ALLOWED_SPECIFIERS].sort());
    expect(readOnlyFindings(source)).toEqual([]);
  });

  it('takes only readLedgerCensus from the ledger module', () => {
    const named = /import\s+\{([^}]*)\}\s+from\s+'\.\.\/\.\.\/lib\/runtime\/ledger\.js'/.exec(source);
    expect(named).not.toBe(null);
    expect(named[1].split(',').map((n) => n.trim()).filter((n) => n !== ''))
      .toEqual(['readLedgerCensus']);
  });

  it('SELF-TEST: the same scanner reds on a fabricated source that writes', () => {
    // A detector that cannot show a red proves nothing when it is green
    // (tests/ci/direct-run-guard.test.js says the same about entry guards).
    const fake = "import { appendLedgerEvent } from '../../lib/runtime/ledger.js';\n"
      + "import { x } from '../../lib/runtime/event-writer.js';\n";
    const findings = readOnlyFindings(fake);
    expect(findings).toContain('unlisted import: ../../lib/runtime/event-writer.js');
    expect(findings).toContain('writer token: appendLedgerEvent');
  });

  it('leaves the ledger byte-identical and creates no sibling file', () => {
    const root = makeRoot('RO');
    const file = writeMixedFixture(root);
    const before = snapshot(file);

    const out = runCli(['--cwd', root], root);

    expect(out.status).toBe(0);
    expect(out.stderr).toBe('');
    expectUntouched(file, before);
  });
});

// ── 2. an absent denominator reads null, never 0 and never NaN ──────────────

describe('verify-call-rate CLI: a zero denominator is null', () => {
  /** @param {object} printed */
  function bothCarriers(printed) {
    return [printed.call_rate.carriers.intent_command, printed.call_rate.carriers.tool_used_skill];
  }

  it('reports null on both carriers when there is no ledger at all', () => {
    const root = makeRoot('N1');
    const file = ledgerFilePath(root);
    expect(existsSync(file)).toBe(false);

    const out = runCli(['--cwd', root], root);

    expect(out.status).toBe(0);
    const printed = parseOut(out);
    expect(printed.ok).toBe(false);
    expect(printed.reason).toContain(file);
    for (const carrier of bothCarriers(printed)) {
      expect(carrier.rate).toBe(null);
      expect(carrier.status).toBe('unmeasured:no-carrier');
      expect(carrier.rows).toBe(0);
    }
  });

  it('reports null on both carriers when the ledger is empty', () => {
    const root = makeRoot('N2');
    writeLedger(root, []);

    const printed = parseOut(runCli(['--cwd', root], root));

    expect(printed.ok).toBe(true);
    for (const carrier of bothCarriers(printed)) {
      expect(carrier.rate).toBe(null);
      expect(carrier.status).toBe('unmeasured:no-carrier');
    }
  });

  it('separates "no carrier" from "carrier alive, nobody called /verify"', () => {
    const root = makeRoot('N3');
    const ts = '2026-09-21T12:00:00.000Z';
    // intent rows exist but name other commands; tool.used has no row at all.
    writeLedger(root, [
      intentRow({ session: 'S1', command: 'split', ts }),
      intentRow({ session: 'S1', command: 'save', ts }),
    ]);

    const printed = parseOut(runCli(['--cwd', root], root));
    const { intent_command: intent, tool_used_skill: tool } = printed.call_rate.carriers;

    expect(intent.rows).toBe(2);
    expect(intent.verify_sessions).toBe(0);
    expect(intent.rate).toBe(null);
    expect(intent.status).toBe('unmeasured:no-verify-call');
    expect(tool.rows).toBe(0);
    expect(tool.rate).toBe(null);
    expect(tool.status).toBe('unmeasured:no-carrier');
  });

  it('never prints NaN, and never prints 0 where the denominator is absent', () => {
    const root = makeRoot('N4');
    writeLedger(root, []);

    const out = runCli(['--cwd', root], root);

    expect(out.stdout).not.toContain('NaN');
    expect(out.stdout).not.toContain('null,"status":"measured"');
  });
});

// ── 3. the sibling CLI's stdout is unchanged, byte for byte ─────────────────

describe('verify-call-rate CLI: verify-rate.mjs is untouched', () => {
  it('prints byte-identical stdout before and after this reader runs', () => {
    const root = makeRoot('B1');
    writeMixedFixture(root);

    const first = runCli(['--cwd', root], root, SIBLING_CLI);
    const mine = runCli(['--cwd', root], root);
    const second = runCli(['--cwd', root], root, SIBLING_CLI);

    expect(mine.status).toBe(0);
    expect(first.status).toBe(0);
    expect(second.stdout).toBe(first.stdout);
    expect(Buffer.from(second.stdout, 'utf-8').equals(Buffer.from(first.stdout, 'utf-8')))
      .toBe(true);
  });

  it('pins the sibling rate to the exact literal it printed for this fixture', () => {
    // The path-dependent fields are excluded on purpose; `rate` is the part
    // that is the same on every machine. The literal below was copied from a
    // real run of verify-rate.mjs against writeMixedFixture, not predicted.
    const root = makeRoot('B2');
    writeMixedFixture(root);

    const printed = JSON.parse(runCli(['--cwd', root], root, SIBLING_CLI).stdout);

    expect(JSON.stringify(printed.rate)).toBe(
      '{"lines":{"total":16,"verify_completed":16,"skipped":0},'
      + '"ids":{"hook":1,"self_report":3,"other":0,"unknown_stamp":0,"measured":0},'
      + '"sessions":{"hook":1,"self_report":3,"answered":0,"rate":0,"measured":0},'
      + '"firings":{"hook":1,"answered":0,"unordered":0,"rate":0,"measured":0,'
      + '"measured_rate":0}}',
    );
  });
});

// ── 4. two denominators, counted separately ─────────────────────────────────

describe('verify-call-rate CLI: the two carriers are separate denominators', () => {
  it('reports different numbers per carrier over the mixed fixture', () => {
    const root = makeRoot('D1');
    writeMixedFixture(root);

    const printed = parseOut(runCli(['--cwd', root], root));
    const { intent_command: intent, tool_used_skill: tool } = printed.call_rate.carriers;

    expect(Object.keys(printed.call_rate)).toEqual(['self_report', 'carriers']);
    expect(Object.keys(printed.call_rate.carriers))
      .toEqual(['intent_command', 'tool_used_skill']);
    expect(Object.keys(intent)).toEqual(CARRIER_KEYS);

    // intent: 4 rows (S1 verify, S2 /verify, S2 verify-something, S3 split).
    // Two of them are verify calls, in S1 and S2; only S1 self-reported.
    expect(intent.rows).toBe(4);
    expect(intent.sessions).toBe(3);
    expect(intent.verify_rows).toBe(2);
    expect(intent.verify_sessions).toBe(2);
    expect(intent.answered_sessions).toBe(1);
    expect(intent.rate).toBe(0.5);
    expect(intent.status).toBe('measured');

    // tool.used: 2 Skill rows (artibot:verify in S3, artibot:save in S1). The
    // `Read` row is not a Skill row and is not counted at all.
    expect(tool.rows).toBe(2);
    expect(tool.sessions).toBe(2);
    expect(tool.verify_rows).toBe(1);
    expect(tool.verify_sessions).toBe(1);
    expect(tool.answered_sessions).toBe(1);
    expect(tool.rate).toBe(1);
    expect(tool.status).toBe('measured');
  });

  it('splits the self-report sessions three ways, per carrier, summing to the whole', () => {
    const root = makeRoot('D2');
    writeMixedFixture(root);

    const printed = parseOut(runCli(['--cwd', root], root));
    const { self_report: self, carriers } = printed.call_rate;

    expect(self.sessions).toBe(3);
    // On the intent carrier: S1 called /verify, S3 has an intent row that is
    // not a verify call, S4 has no intent row at all.
    expect(carriers.intent_command.self_report_sessions).toEqual({
      with_verify_call: 1, without_verify_call: 1, 'unmeasured:no-carrier': 1,
    });
    // On the tool carrier: S3 called it, S1 has a Skill row that is not verify,
    // S4 has none.
    expect(carriers.tool_used_skill.self_report_sessions).toEqual({
      with_verify_call: 1, without_verify_call: 1, 'unmeasured:no-carrier': 1,
    });
    for (const carrier of Object.values(carriers)) {
      const split = carrier.self_report_sessions;
      const sum = split.with_verify_call + split.without_verify_call
        + split['unmeasured:no-carrier'];
      expect(sum).toBe(self.sessions);
    }
  });

  it('agrees with computeVerifyRate on the self-report pair count', () => {
    const root = makeRoot('D3');
    const file = writeMixedFixture(root);
    const events = readFileSync(file, 'utf-8').split('\n')
      .filter((l) => l.trim() !== '').map((l) => JSON.parse(l));

    const printed = parseOut(runCli(['--cwd', root], root));

    // Two implementations of "what is a self-report pair" that disagree is a
    // red here, which is the point of asserting it rather than documenting it.
    expect(printed.call_rate.self_report.pairs).toBe(computeVerifyRate(events).ids.self_report);
    expect(printed.call_rate.self_report.pairs).toBe(3);
  });

  it('counts a sessionless self-report pair without joining it to any session', () => {
    const root = makeRoot('D4');
    const ts = '2026-09-21T12:00:00.000Z';
    writeLedger(root, [
      intentRow({ session: 'S1', command: 'verify', ts }),
      ...selfReportRun({ session: null, vid: `v1-eeeeeeeeeeee-${STAMP}`, ts }),
    ]);

    const printed = parseOut(runCli(['--cwd', root], root));
    const { self_report: self, carriers } = printed.call_rate;

    expect(self).toEqual({ pairs: 1, sessions: 0, sessionless_pairs: 1 });
    // The sessionless pair answers nothing: S1 called /verify and stays
    // unanswered. Pooling it under an empty key would invent a rate of 1.
    expect(carriers.intent_command.verify_sessions).toBe(1);
    expect(carriers.intent_command.answered_sessions).toBe(0);
    expect(carriers.intent_command.rate).toBe(0);
  });

  it('counts a sessionless carrier row in rows but in no session', () => {
    const root = makeRoot('D5');
    const ts = '2026-09-21T12:00:00.000Z';
    writeLedger(root, [
      intentRow({ session: null, command: 'verify', ts }),
      toolRow({ session: null, skill: 'verify', ts }),
    ]);

    const printed = parseOut(runCli(['--cwd', root], root));
    const { intent_command: intent, tool_used_skill: tool } = printed.call_rate.carriers;

    for (const carrier of [intent, tool]) {
      expect(carrier.rows).toBe(1);
      expect(carrier.verify_rows).toBe(1);
      expect(carrier.sessions).toBe(0);
      expect(carrier.verify_sessions).toBe(0);
      expect(carrier.rate).toBe(null);
      expect(carrier.status).toBe('unmeasured:no-verify-call');
    }
  });
});

// ── 5. the command line itself ──────────────────────────────────────────────

describe('verify-call-rate CLI: a malformed command line', () => {
  const cases = [
    ['an unknown flag', ['--oops']],
    ['a flag with no value', ['--cwd']],
    ['an empty --cwd', ['--cwd', '']],
    ['an unparsable --since', ['--since', 'notadate']],
  ];

  for (const [label, args] of cases) {
    it(`exits 2 and writes nothing to stdout for ${label}`, () => {
      const root = makeRoot(`U${label.length}`);
      writeMixedFixture(root);

      const out = runCli(args, root);

      expect(out.status).toBe(2);
      expect(out.stdout).toBe('');
      const lines = out.stderr.split('\n').filter((l) => l !== '');
      expect(lines).toHaveLength(1);
      expect(lines[0].startsWith('verify-call-rate: ')).toBe(true);
      expect(lines[0]).toContain('usage:');
    });
  }

  it('does not touch the ledger on a usage error', () => {
    const root = makeRoot('U9');
    const file = writeMixedFixture(root);
    const before = snapshot(file);

    runCli(['--oops'], root);

    expectUntouched(file, before);
  });

  it('defaults --cwd to the process cwd', () => {
    const root = makeRoot('U0');
    writeMixedFixture(root);

    const printed = parseOut(runCli([], root));

    expect(printed.ok).toBe(true);
    expect(printed.call_rate.carriers.intent_command.rows).toBe(4);
  });
});

describe('verify-call-rate CLI: the selection filters reach the census', () => {
  it('narrows to one session and says how many lines that removed', () => {
    const root = makeRoot('F1');
    writeMixedFixture(root);

    const printed = parseOut(runCli(['--cwd', root, '--session', 'S1'], root));

    expect(printed.call_rate.carriers.intent_command.verify_sessions).toBe(1);
    expect(printed.call_rate.carriers.intent_command.answered_sessions).toBe(1);
    expect(printed.call_rate.carriers.intent_command.rate).toBe(1);
    // 23 lines in the fixture; S1 keeps 1 intent + 1 tool + 4 self-report = 6.
    expect(printed.census.survivors).toBe(6);
    expect(printed.census.dropped.selection.filtered_out).toBe(17);
  });

  it('honours --since', () => {
    const root = makeRoot('F2');
    const ts = '2026-09-21T12:00:00.000Z';
    writeLedger(root, [
      intentRow({ session: 'S1', command: 'verify', ts }),
      intentRow({ session: 'S2', command: 'verify', ts: '2026-09-21T13:00:00.000Z' }),
    ]);

    const printed = parseOut(runCli(['--cwd', root, '--since', '2026-09-21T12:30:00.000Z'], root));

    expect(printed.call_rate.carriers.intent_command.rows).toBe(1);
    expect(printed.census.dropped.selection.filtered_out).toBe(1);
  });

  it('reads the ledger ONCE — the census describes that single read', () => {
    const root = makeRoot('F3');
    writeMixedFixture(root);

    const printed = parseOut(runCli(['--cwd', root], root));

    // No event filter is passed, so every line of the file is a survivor and
    // the census can be read as a statement about the whole ledger. A second
    // read per event kind would leave this number describing only the last one.
    expect(printed.census.survivors).toBe(23);
    expect(printed.census.lines.nonblank).toBe(23);
    expect(printed.census.dropped_total).toEqual({ loss: 0, selection: 0 });
  });
});

// ── 6. hostile input ────────────────────────────────────────────────────────

describe('verify-call-rate CLI: hostile input does not throw', () => {
  it('survives null data, non-string command, a missing skill and a bare line', () => {
    const root = makeRoot('X1');
    const ts = '2026-09-21T12:00:00.000Z';
    const bad = [
      { ts, session_id: 'S1', event: 'intent.detected', source: 'hook', pid: 1, seq: 901, data: null },
      intentRow({ session: 'S1', command: 42, ts }),
      intentRow({ session: 'S1', command: undefined, ts }),
      intentRow({ session: 7, command: 'verify', ts }),
      toolRow({ session: 'S1', skill: undefined, ts }),
      toolRow({ session: 'S1', skill: { name: 'verify' }, ts }),
      toolRow({ session: 'S1', skill: '  /artibot:verify  ', ts }),
      { ts, session_id: 'S1', event: 'tool.used', source: 'hook', pid: 1, seq: 902 },
    ];
    const file = writeLedger(root, bad);
    const before = snapshot(file);

    const out = runCli(['--cwd', root], root);

    expect(out.status).toBe(0);
    expect(out.stderr).toBe('');
    const printed = parseOut(out);
    const { intent_command: intent, tool_used_skill: tool } = printed.call_rate.carriers;
    // Only the row whose `command` is a string counts, and a numeric
    // session_id is not a session to join on.
    expect(intent.rows).toBe(1);
    expect(intent.verify_rows).toBe(1);
    expect(intent.sessions).toBe(0);
    // Whitespace and a leading slash are trimmed; the namespace prefix is
    // dropped at the LAST colon, so `/artibot:verify` is a verify call.
    expect(tool.rows).toBe(1);
    expect(tool.verify_rows).toBe(1);
    expect(tool.verify_sessions).toBe(1);
    expectUntouched(file, before);
  });

  it('exits 0 when the ledger path cannot be opened', () => {
    const root = makeRoot('X2');
    // A regular FILE where the ledger's directory has to be.
    const dir = path.dirname(ledgerFilePath(root));
    mkdirSync(path.dirname(dir), { recursive: true });
    writeFileSync(dir, 'not a directory\n', 'utf-8');

    const out = runCli(['--cwd', root], root);

    expect(out.status).toBe(0);
    const printed = parseOut(out);
    expect(printed.ok).toBe(false);
    expect(typeof printed.reason).toBe('string');
    expect(printed.reason.length).toBeGreaterThan(0);
    expect(printed.call_rate.carriers.intent_command.rate).toBe(null);
  });
});

describe('verify-call-rate CLI: it is safe to import', () => {
  it('does nothing when imported rather than run', async () => {
    const mod = await import(`file:///${CLI.replace(/\\/g, '/')}`);

    expect(typeof mod.main).toBe('function');
  });
});
