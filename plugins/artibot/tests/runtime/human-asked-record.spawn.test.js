/**
 * Real-process gate for the `human.asked` record on the two WRITE hooks.
 *
 * `tests/runtime/human-asked-record.test.js` stubs the ledger, so it proves
 * the recorder BUILDS the right object and proves nothing about whether that
 * object survives contact with `appendLedgerEvent`. A `data` shape the
 * allowlist rejects lands as `ledger.rejected` and the record is lost — green
 * unit tests and an empty ledger are perfectly compatible. So this file spawns
 * the actual hooks, lets them write an actual `.artibot/runtime/ledger.jsonl`,
 * and reads it back.
 *
 * It is the Write/Edit counterpart to
 * `tests/firewall/hook-decision-invariance.test.js`, which already covers
 * pre-Bash and is NOT duplicated here.
 *
 * ── WHY EVERY TMP ROOT CARRIES `artibot.config.json` ────────────────────────
 *  This is the load-bearing fixture detail. `executeChain` drops every
 *  `artibot-policy` guard when the cwd is outside an Artibot repo
 *  (lib/core/guard-registry.js:85-90), and BOTH pre-phase Write/Edit guards —
 *  `sensitive-file` and `content-secret` — are `artibot-policy`
 *  (:572-586). A bare `.git/` directory is NOT enough: measured 2026-09-05, a
 *  Write of `<tmp>/.env` under a root with only `.git/` is APPROVED. Every
 *  "one record per block" assertion below would then pass vacuously against a
 *  block that never happened. For Bash the question does not arise — all three
 *  pre-phase Bash guards are `security-critical`.
 *
 * ── THE STDOUT-INVARIANCE CONDITIONS ────────────────────────────────────────
 *   A  writable project root                      → the record lands
 *   B  `<root>/.artibot` is a regular FILE        → mkdir fails ENOTDIR, dropped
 *   C  no `cwd` key in the payload                → never attempted
 *
 *  The child's PROCESS cwd is the condition root in all three, so `cwd ||
 *  process.cwd()` resolves to an Artibot repo either way and the guard set is
 *  identical. The only thing the payload key moves is where the ledger goes.
 *  Condition D from the pre-Bash gate (a payload cwd that does not exist) is
 *  deliberately absent: for Write/Edit it would ALSO drop the policy guards and
 *  flip the decision to approve, so it measures nothing about the ledger.
 *
 * ── WHAT THIS FILE CANNOT SEE ───────────────────────────────────────────────
 *  - **The live hook payload.** Payloads are hand-built. Nothing here verifies
 *    that Claude Code's real PreToolUse JSON carries `cwd` and `session_id` in
 *    the shape the recorder reads.
 *  - **Line folding.** `foldOversized` drops every non-required `data` key past
 *    4096 bytes, which for this event leaves only `question_id`. The reasons
 *    these hooks emit are ~100-300 bytes, so the threshold is never approached;
 *    a future reason that embeds file CONTENT would silently gut the record and
 *    this file would stay green. The `evidence_refs` assertion below is a
 *    tripwire for that, not a test of folding.
 *  - **Ordering under a kill.** The append runs after `writeStdout`. These runs
 *    wait for exit, so the window where a parent reads stdout and kills the
 *    process is never observed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildQuestionId } from '../../lib/runtime/human-asked-record.js';

// This file spawns ~15 child processes; the budget buys headroom for load, not
// for a slow assertion. Nothing here waits on a timer.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PRE_WRITE = path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'pre-write.js');
const PRE_WRITE_GUARD = path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'pre-write-guard.js');

/** @type {string} */
let tmp;

/**
 * A project root the Artibot guards will actually run inside.
 * @param {string} name
 * @returns {string} absolute root
 */
function makeRoot(name) {
  const root = path.join(tmp, name);
  mkdirSync(path.join(root, '.git'), { recursive: true });
  mkdirSync(path.join(root, 'src'), { recursive: true });
  // The marker `isArtibotRepo` looks for — see the header.
  writeFileSync(path.join(root, 'artibot.config.json'), '{}\n', 'utf-8');
  return root;
}

/**
 * Spawn a hook with one payload.
 * @param {string} hook absolute hook path
 * @param {object} payload
 * @param {string} cwd child process cwd
 * @param {Record<string,string>} [env] extra env
 * @returns {{status: number|null, stdout: string, stderr: string}}
 */
function runHook(hook, payload, cwd, env = {}) {
  const res = spawnSync(process.execPath, [hook], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    windowsHide: true,
    cwd,
    env: { ...process.env, ...env },
  });
  return { status: res.status, stdout: String(res.stdout || ''), stderr: String(res.stderr || '') };
}

/**
 * Every well-formed event in a project's ledger.
 * @param {string|null} root
 * @returns {object[]}
 */
function ledgerEvents(root) {
  if (root === null) return [];
  const file = path.join(root, '.artibot', 'runtime', 'ledger.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf-8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

/**
 * The `human.asked` lines in a project's ledger, with the rejected count
 * checked first — a rejected line means the record violated its own contract
 * and was silently lost, which is the failure this whole file exists to catch.
 * @param {string} root
 * @returns {object[]}
 */
function askedIn(root) {
  const events = ledgerEvents(root);
  expect(events.filter((e) => e.event === 'ledger.rejected')).toEqual([]);
  return events.filter((e) => e.event === 'human.asked');
}

/** A fake AWS key, assembled so this test file does not trip the hook it tests. */
function fakeAwsKey() {
  return 'AKI' + 'AIOSFODNN7EXAMPLE';
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'artibot-hasym-')));
});
afterEach(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
});

describe('pre-write: human.asked lands in a real ledger', () => {
  it('writes exactly one line for a blocked Write, joinable by question_id', () => {
    const root = makeRoot('A');
    const target = path.join(root, '.env');
    const sid = 'sessAAAAbbbb';

    const out = runHook(PRE_WRITE, {
      tool_name: 'Write',
      tool_input: { file_path: target, content: 'X=1' },
      session_id: sid,
      cwd: root,
    }, root);

    const parsed = JSON.parse(out.stdout);
    expect(parsed.decision).toBe('block');
    // No extra stdout field may appear alongside the decision.
    expect(Object.keys(parsed)).toEqual(['decision', 'reason']);

    const asked = askedIn(root);
    expect(asked).toHaveLength(1);
    const [event] = asked;
    expect(event.source).toBe('hook');
    expect(event.session_id).toBe(sid);
    expect(event.data.tool).toBe('Write');
    expect(event.data.decision).toBe('block');
    expect(event.data.path).toBe(target);
    expect(event.data.reason).toBe(parsed.reason);
    // A `.env` PATH matches no gate row (HG-11's signature is a command
    // pattern), so the key is absent rather than null — a null would be typed
    // out by the allowlist and the whole line would be rejected.
    expect(event.data.hits).toEqual([]);
    expect(Object.prototype.hasOwnProperty.call(event.data, 'gate')).toBe(false);
    expect(event.data.question_id).toBe(buildQuestionId(sid, null, target));
    // Tripwire for silent line folding: `foldOversized` keeps only
    // `question_id` and leaves this marker behind. If it ever fires, every
    // other assertion above is measuring a record that production lost.
    expect(event.data.evidence_refs).toBeUndefined();
  });

  it('writes one line for a blocked Edit carrying a secret', () => {
    const root = makeRoot('A');
    const target = path.join(root, 'src', 'api.js');
    const sid = 'sessCCCCdddd';

    const out = runHook(PRE_WRITE, {
      tool_name: 'Edit',
      tool_input: { file_path: target, new_string: `const k = "${fakeAwsKey()}";` },
      session_id: sid,
      cwd: root,
    }, root);

    expect(JSON.parse(out.stdout).decision).toBe('block');

    const asked = askedIn(root);
    expect(asked).toHaveLength(1);
    expect(asked[0].data.tool).toBe('Edit');
    expect(asked[0].data.path).toBe(target);
    // A `.js` path under the repo is HG-02 and nothing stricter.
    expect(asked[0].data.hits).toEqual(['HG-02']);
    expect(asked[0].data.gate).toBe('HG-02');
    expect(asked[0].data.question_id).toBe(buildQuestionId(sid, 'HG-02', target));
    // The secret must not be copied into the ledger as a field of its own; the
    // reason is the single channel and it names the finding, not the value.
    expect(Object.prototype.hasOwnProperty.call(asked[0].data, 'content')).toBe(false);
    expect(JSON.stringify(asked[0])).not.toContain(fakeAwsKey());
  });

  it('writes nothing on the approve path', () => {
    const root = makeRoot('A');
    const target = path.join(root, 'src', 'a.js');

    const out = runHook(PRE_WRITE, {
      tool_name: 'Write',
      tool_input: { file_path: target, content: 'const x = 1;\n' },
      session_id: 'sessEEEEffff',
      cwd: root,
    }, root);

    expect(JSON.parse(out.stdout)).toEqual({ decision: 'approve' });
    expect(ledgerEvents(root)).toEqual([]);
  });

  it('emits byte-identical stdout whether the record lands, fails, or is skipped', () => {
    const payloadFor = (root, withCwd) => {
      const p = {
        tool_name: 'Write',
        tool_input: { file_path: path.join(root, '.env'), content: 'X=1' },
        session_id: 'sessGGGGhhhh',
      };
      if (withCwd) p.cwd = root;
      return p;
    };

    // A — writable root, the record lands.
    const rootA = makeRoot('inv-A');
    const a = runHook(PRE_WRITE, payloadFor(rootA, true), rootA);

    // B — `<root>/.artibot` is a regular FILE, so mkdir of `.artibot/runtime`
    // fails with ENOTDIR. Portable; a read-only directory bit is not enforced
    // for the owner on Windows.
    const rootB = makeRoot('inv-B');
    writeFileSync(path.join(rootB, '.artibot'), 'not a directory\n', 'utf-8');
    const b = runHook(PRE_WRITE, payloadFor(rootB, true), rootB);

    // C — no `cwd` key at all, so the append is never attempted.
    const rootC = makeRoot('inv-C');
    const c = runHook(PRE_WRITE, payloadFor(rootC, false), rootC);

    expect([a.stdout, b.stdout, c.stdout]).toEqual([a.stdout, a.stdout, a.stdout]);
    expect(JSON.parse(a.stdout).decision).toBe('block');

    // NEGATIVE CONTROL: the three conditions must genuinely differ downstream.
    // Without this, an all-approve run would satisfy the equality above and
    // prove nothing at all.
    expect(askedIn(rootA)).toHaveLength(1);
    expect(ledgerEvents(rootB)).toEqual([]);
    expect(ledgerEvents(rootC)).toEqual([]);

    // A dropped record must also stay silent — the hook may not narrate its
    // own bookkeeping failure onto the model's channel.
    expect(b.stderr).toBe('');
    expect(c.stderr).toBe('');
  });
});

describe('pre-write-guard: human.asked lands in a real ledger', () => {
  /**
   * Arrange a guard block that is not short-circuited by any of the four
   * earlier exits (whitelist, non-Artibot repo, new file, degraded mode).
   *
   * The tracking file must EXIST and be empty: with no tracking file at all the
   * guard takes its degraded branch and approves, so omitting this step is the
   * difference between measuring the block and measuring nothing.
   *
   * @param {string} sid unique per case — the loop guard downgrades the SECOND
   *   block of the same (session, tool, path) to approve.
   * @returns {{root: string, target: string, tracking: string, env: object}}
   */
  function arrange(sid) {
    const root = makeRoot(`g-${sid}`);
    const target = path.join(root, 'src', 'a.js');
    writeFileSync(target, 'const x = 1;\n', 'utf-8');
    const tracking = path.join(os.tmpdir(), `artibot-read-tracking-${sid}.json`);
    writeFileSync(tracking, '[]', 'utf-8');
    return {
      root,
      target,
      tracking,
      env: {
        // Keep the block fingerprint out of the real plugin `runtime/` dir.
        // `getPluginRoot` reads this env first (lib/core/platform.js:105-116).
        CLAUDE_PLUGIN_ROOT: path.join(root, 'plugin'),
        ARTIBOT_WRITE_GUARD_MODE: 'block',
      },
    };
  }

  /** @type {string[]} */
  let tracked = [];
  afterEach(() => {
    for (const f of tracked) {
      try { rmSync(f, { force: true }); } catch { /* noop */ }
    }
    tracked = [];
  });

  it('writes exactly one line for a write-before-read block', () => {
    const sid = 'guard1111aaaa';
    const { root, target, tracking, env } = arrange(sid);
    tracked.push(tracking);

    const out = runHook(PRE_WRITE_GUARD, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: target },
      session_id: sid,
      cwd: root,
    }, root, env);

    const parsed = JSON.parse(out.stdout);
    expect(parsed.decision).toBe('block');
    expect(Object.keys(parsed)).toEqual(['decision', 'reason']);
    expect(parsed.reason).toContain('WRITE-BEFORE-READ');

    const asked = askedIn(root);
    expect(asked).toHaveLength(1);
    expect(asked[0].session_id).toBe(sid);
    expect(asked[0].source).toBe('hook');
    expect(asked[0].data.tool).toBe('Write');
    expect(asked[0].data.decision).toBe('block');
    expect(asked[0].data.path).toBe(target);
    expect(asked[0].data.reason).toBe(parsed.reason);
    expect(asked[0].data.hits).toEqual(['HG-02']);
    expect(asked[0].data.gate).toBe('HG-02');
    expect(asked[0].data.question_id).toBe(buildQuestionId(sid, 'HG-02', target));
    expect(asked[0].data.evidence_refs).toBeUndefined();
  });

  it('records the Edit tool name, not a Write default', () => {
    const sid = 'guard2222bbbb';
    const { root, target, tracking, env } = arrange(sid);
    tracked.push(tracking);

    const out = runHook(PRE_WRITE_GUARD, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: target },
      session_id: sid,
      cwd: root,
    }, root, env);

    expect(JSON.parse(out.stdout).decision).toBe('block');
    const asked = askedIn(root);
    expect(asked).toHaveLength(1);
    expect(asked[0].data.tool).toBe('Edit');
  });

  it('writes nothing when the file was already read this session', () => {
    const sid = 'guard3333cccc';
    const { root, target, tracking, env } = arrange(sid);
    tracked.push(tracking);
    // Same normalization the guard applies: forward slashes.
    writeFileSync(tracking, JSON.stringify([target.replace(/\\/g, '/')]), 'utf-8');

    const out = runHook(PRE_WRITE_GUARD, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: target },
      session_id: sid,
      cwd: root,
    }, root, env);

    expect(JSON.parse(out.stdout)).toEqual({ decision: 'approve' });
    expect(ledgerEvents(root)).toEqual([]);
  });

  it('writes nothing when the payload carries no cwd', () => {
    const sid = 'guard4444dddd';
    const { root, target, tracking, env } = arrange(sid);
    tracked.push(tracking);

    const out = runHook(PRE_WRITE_GUARD, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: target },
      session_id: sid,
    }, root, env);

    // NEGATIVE CONTROL: the block still happens. Only the record is withheld,
    // which is what distinguishes "no root injected" from "guard did not fire".
    expect(JSON.parse(out.stdout).decision).toBe('block');
    expect(ledgerEvents(root)).toEqual([]);
  });
});
