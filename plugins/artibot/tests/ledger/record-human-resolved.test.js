/**
 * Real-process contract for `scripts/ledger/record-human-resolved.mjs` — the
 * thin CLI a model runs to close a `human.asked` it caused.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM THE UNIT SUITE.
 * `tests/runtime/human-resolved-record.test.js` stubs `appendLedgerEvent`, so
 * it proves the recorder BUILDS the right object and proves nothing about
 * whether that object survives the allowlist. A `data` shape the writer rejects
 * lands as `ledger.rejected` and the record is lost — green unit tests and an
 * empty ledger are perfectly compatible. So every case here spawns the real
 * script, lets it write a real ledger file (wherever `ledgerFilePath` puts it,
 * `<root>/.git/artibot/ledger.jsonl` under ADR-011), and READS THE FILE BACK.
 * "It did not throw" is a necessary condition, not the contract.
 *
 * THE PAIRING CASE IS THE POINT. `records a line that pairs with a real
 * human.asked` spawns the pre-write HOOK to produce a genuine block, then runs
 * the CLI over the same path, and compares the two `question_id` values as
 * bytes. Both ids come out of separate OS processes through separate entry
 * points, which is the only arrangement that can catch the two subject
 * extractions drifting apart.
 *
 * ── WHY EVERY TMP ROOT CARRIES `artibot.config.json` ────────────────────────
 *  Inherited verbatim from `tests/runtime/human-asked-record.spawn.test.js`:
 *  `executeChain` drops every `artibot-policy` guard when the cwd is outside an
 *  Artibot repo, and both pre-phase Write guards are `artibot-policy`. A bare
 *  `.git/` directory is NOT enough — a Write of `<tmp>/.env` under a root with
 *  only `.git/` is APPROVED, and the pairing case would then compare against a
 *  block that never happened.
 *
 * ── ISOLATION ───────────────────────────────────────────────────────────────
 *  Every case builds its own `mkdtempSync` root and passes it as BOTH the child
 *  process cwd and `--cwd`, so nothing here can reach the repository's own
 *  `.artibot/runtime/` or `.git/artibot/` store. The one case that omits
 *  `--cwd` still runs with the child cwd inside the temp root, which is exactly
 *  the defaulting behaviour it is there to measure.
 *
 * ── WHAT THIS FILE CANNOT SEE ───────────────────────────────────────────────
 *  - WHETHER ANY MODEL EVER RUNS THIS. Nothing invokes the script: no hook, no
 *    command, no CI step. Its call rate is unmeasured, and a green run here says
 *    only that it works when called.
 *  - WHETHER THE `kind` IS TRUE. The script records what it is told. `kind`,
 *    and `decision` with it, are self-reports — see the module header.
 *  - THE INSTALLED COPY. These cases run the file in this worktree.
 *  - LINE FOLDING. `foldOversized` drops every non-required `data` key past the
 *    4 KB cap, which for this event leaves only `decision` — so a long decision
 *    would drop `question_id` itself and silently unjoin the pair. The
 *    decisions here are a few dozen bytes and never approach it.
 *
 * @module tests/ledger/record-human-resolved
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildQuestionId } from '../../lib/runtime/human-asked-record.js';
import { ledgerFilePath } from '../../lib/runtime/event-writer.js';

// This file spawns child processes, including one full hook run. The budget
// buys headroom for load; nothing here waits on a timer.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(PLUGIN_ROOT, 'scripts', 'ledger', 'record-human-resolved.mjs');
const PRE_WRITE = path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'pre-write.js');

const SID = 'sessRRRRssss';

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
function runCli(args, root, env = {}) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf-8', windowsHide: true, cwd: root, env: { ...process.env, ...env },
  });
  return { status: res.status, stdout: String(res.stdout || ''), stderr: String(res.stderr || '') };
}

/** Every well-formed event in a project's ledger. */
function ledgerEvents(root) {
  const file = ledgerFilePath(root);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf-8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

/**
 * The `human.resolved` lines, with the rejected count checked FIRST. A rejected
 * line means the record violated its own contract and was silently lost, which
 * is the failure this whole file exists to catch.
 */
function resolvedIn(root) {
  const events = ledgerEvents(root);
  expect(events.filter((e) => e.event === 'ledger.rejected')).toEqual([]);
  return events.filter((e) => e.event === 'human.resolved');
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'artibot-hres-')));
});
afterEach(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
});

describe('record-human-resolved: the line lands in a real ledger', () => {
  it('writes exactly one approval line, and no rejected line', () => {
    const root = makeRoot('A');
    const subject = 'git push --force origin main';

    const out = runCli([
      '--tool', 'Bash', '--subject', subject, '--decision', 'owner said go',
      '--kind', 'approval', '--session', SID, '--cwd', root,
    ], root);

    expect(out.status).toBe(0);
    expect(out.stderr).toBe('');

    const resolved = resolvedIn(root);
    expect(resolved).toHaveLength(1);
    const [event] = resolved;
    expect(event.source).toBe('human');
    expect(event.session_id).toBe(SID);
    expect(event.data.decision).toBe('owner said go');
    expect(event.data.kind).toBe('approval');
    expect(event.data.kind_source).toBe('self-report');
    expect(event.data.tool).toBe('Bash');
    // HG-07 is the strictest row this command hits, measured against the real
    // matrix by tests/runtime/human-asked-record.test.js.
    expect(event.data.gate).toBe('HG-07');
    expect(event.data.question_id).toBe(buildQuestionId(SID, 'HG-07', subject));
    // Tripwire for silent line folding: `foldOversized` leaves this marker
    // behind. If it ever fires, every assertion above reads a lost record.
    expect(event.data.evidence_refs).toBeUndefined();
  });

  it('prints the same question_id it wrote', () => {
    const root = makeRoot('B');
    const subject = 'git push --force origin main';

    const out = runCli([
      '--tool', 'Bash', '--subject', subject, '--decision', 'go',
      '--kind', 'decision', '--session', SID, '--cwd', root,
    ], root);

    const printed = JSON.parse(out.stdout);
    expect(printed.event).toBe('human.resolved');
    expect(printed.recorded).toBe(true);
    expect(printed.skipped).toBeNull();
    expect(printed.kind).toBe('decision');
    expect(printed.session).toBe(SID);
    // The id on stdout is what the model will quote; the id in the file is what
    // a reader will join on. If those two ever differ the join is broken AND
    // invisible.
    expect(printed.question_id).toBe(resolvedIn(root)[0].data.question_id);
  });

  it('records a line that pairs with a real human.asked from the hook', () => {
    const root = makeRoot('C');
    const target = path.join(root, '.env');

    // A genuine block, in its own process, through the real hook.
    const hook = spawnSync(process.execPath, [PRE_WRITE], {
      input: JSON.stringify({
        tool_name: 'Write',
        tool_input: { file_path: target, content: 'X=1' },
        session_id: SID,
        cwd: root,
      }),
      encoding: 'utf-8',
      windowsHide: true,
      cwd: root,
    });
    // NEGATIVE CONTROL: if the guard did not fire there is no ask to pair with
    // and the comparison below would be vacuous.
    expect(JSON.parse(String(hook.stdout)).decision).toBe('block');

    const out = runCli([
      '--tool', 'Write', '--subject', target, '--decision', 'owner approved the write',
      '--kind', 'approval', '--session', SID, '--cwd', root,
    ], root);
    expect(out.status).toBe(0);

    const events = ledgerEvents(root);
    expect(events.filter((e) => e.event === 'ledger.rejected')).toEqual([]);
    const asked = events.filter((e) => e.event === 'human.asked');
    const resolved = events.filter((e) => e.event === 'human.resolved');
    expect(asked).toHaveLength(1);
    expect(resolved).toHaveLength(1);
    // The whole feature, in one assertion: two processes, two entry points, one
    // id. Byte identity, not deep equality of two separate computations.
    expect(resolved[0].data.question_id).toBe(asked[0].data.question_id);
    // And the two lines are distinguishable by who wrote them.
    expect(asked[0].source).toBe('hook');
    expect(resolved[0].source).toBe('human');
  });

  it('omits both kind keys when --kind is not given', () => {
    const root = makeRoot('D');

    const out = runCli([
      '--tool', 'Bash', '--subject', 'ls -al', '--decision', 'fine',
      '--session', SID, '--cwd', root,
    ], root);

    expect(out.status).toBe(0);
    expect(JSON.parse(out.stdout).kind).toBeNull();
    const [event] = resolvedIn(root);
    expect(Object.prototype.hasOwnProperty.call(event.data, 'kind')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(event.data, 'kind_source')).toBe(false);
  });

  it('falls back to CLAUDE_SESSION_ID when --session is absent', () => {
    const root = makeRoot('E');

    const out = runCli(
      ['--tool', 'Bash', '--subject', 'ls -al', '--decision', 'fine', '--cwd', root],
      root,
      { CLAUDE_SESSION_ID: SID },
    );

    expect(out.status).toBe(0);
    expect(JSON.parse(out.stdout).session).toBe(SID);
    expect(resolvedIn(root)[0].session_id).toBe(SID);
  });

  it('defaults the project root to the process cwd', () => {
    const root = makeRoot('F');

    const out = runCli(
      ['--tool', 'Bash', '--subject', 'ls -al', '--decision', 'fine', '--session', SID],
      root,
    );

    expect(out.status).toBe(0);
    // The one place this CLI departs from the recorder's injected-root rule,
    // and it is allowed only because a model runs it from the project root.
    expect(resolvedIn(root)).toHaveLength(1);
  });
});

describe('record-human-resolved: what it refuses to write', () => {
  it('writes nothing and says so when no session id can be found', () => {
    const root = makeRoot('G');

    const out = runCli(
      ['--tool', 'Bash', '--subject', 'ls -al', '--decision', 'fine', '--cwd', root],
      root,
      { CLAUDE_SESSION_ID: '' },
    );

    // Exit 0: a missing session is an observation about the environment, not a
    // mistake in the command line.
    expect(out.status).toBe(0);
    const printed = JSON.parse(out.stdout);
    expect(printed.session).toBe('none');
    // The skip is REPORTED. `buildQuestionId` tolerates a missing session, so
    // the id looks fine and the line would still be rejected by the envelope —
    // a silent exit 0 here would tell the model it had recorded something.
    expect(printed.recorded).toBe(false);
    expect(printed.skipped).toBe('no-session-id');
    expect(ledgerEvents(root)).toEqual([]);
  });

  it('writes nothing for a --kind outside the enum', () => {
    const root = makeRoot('H');

    const out = runCli([
      '--tool', 'Bash', '--subject', 'ls -al', '--decision', 'fine',
      '--kind', 'guess', '--session', SID, '--cwd', root,
    ], root);

    // A typo in an enumerated flag is a usage error, the same class as a bad
    // --tool. Exiting 0 having written nothing would be the silent fail-open.
    expect(out.status).toBe(2);
    expect(out.stderr.trim().split('\n')).toHaveLength(1);
    expect(ledgerEvents(root)).toEqual([]);
  });

  it.each([
    ['--decision is missing', ['--tool', 'Bash', '--subject', 'ls -al']],
    ['--decision is empty', ['--tool', 'Bash', '--subject', 'ls -al', '--decision', '']],
    ['--tool is missing', ['--subject', 'ls -al', '--decision', 'fine']],
    ['--tool is not one of the three', ['--tool', 'WebFetch', '--subject', 'x', '--decision', 'y']],
    ['--subject is missing', ['--tool', 'Bash', '--decision', 'fine']],
    ['a flag has no value', ['--tool', 'Bash', '--subject', 'ls -al', '--decision']],
    ['an unknown flag is passed', ['--tool', 'Bash', '--subject', 'x', '--decision', 'y', '--oops']],
  ])('exits 2 and writes nothing when %s', (_label, args) => {
    const root = makeRoot('I');

    const out = runCli([...args, '--session', SID, '--cwd', root], root);

    expect(out.status).toBe(2);
    expect(out.stdout).toBe('');
    expect(out.stderr.trim().split('\n')).toHaveLength(1);
    // A usage error must leave the ledger untouched — not even a rejected line.
    expect(ledgerEvents(root)).toEqual([]);
  });
});

describe('record-human-resolved: it is safe to import', () => {
  it('does nothing when imported rather than run', async () => {
    // The direct-run guard is what lets a test or a sibling import this file
    // without running a migration-like side effect. A guard that answers FALSE
    // on a real direct run is fail-open in the quietest way (see
    // tests/ci/direct-run-guard.test.js), and every case above is the positive
    // half of that pin; this is the negative half.
    const mod = await import(`file:///${CLI.replace(/\\/g, '/')}`);

    expect(typeof mod.main).toBe('function');
  });
});
