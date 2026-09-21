/**
 * SH-29 part B — the COMMAND carrier's round trip.
 *
 * WHY THIS EXISTS. `lib/replay/existence-audit.js#CARRIERS.commands` was null:
 * no registered event named a command, so the CLAUDE.md Existence Audit rule
 * could not be evaluated for any command and a `fired: 0` would have been
 * indistinguishable from a silence nobody was listening for. The fix is a field
 * plus a writer, and a field with no writer is exactly the half-measure that
 * reads as a measurement. This suite drives the real UserPromptSubmit handler
 * in process and then reads the row back out of a sandboxed ledger, so "the
 * writer runs" and "the row survives both validation layers" are one
 * measurement rather than two hopeful halves.
 *
 * ONLY USER-TYPED SLASH COMMANDS (ⓑ2). A Skill-TOOL invocation (ⓑ1) is already
 * carried by `tool.used.skill` (Wave 11); recording it again here would
 * double-count one activation, so nothing in this file asserts one.
 *
 * WHAT THIS SUITE CANNOT SEE (rules §9 — written next to the gate so the gate
 * cannot become the next false assurance):
 *   1. THE HOST'S REAL PAYLOAD. Every payload below is synthetic. A host that
 *      stops sending `cwd` or `session_id` goes green here and silent in
 *      production.
 *   2. THE DISPATCHER ROUND TRIP. `runtime-prompt.js` runs in process inside
 *      `_userprompt-dispatcher.js`; that spawn is measured in the dispatcher
 *      suites, not here.
 *   3. ANY LIVE FIRING RATE. Nothing here says how often a slash prompt happens.
 *   4. THE NAMESPACED-SLASH GAP IS PINNED, NOT FIXED. Case (c) asserts that
 *      `/artibot:split` records NOTHING, because `detectSlashCommand`
 *      (`lib/mission/mission-id.js:139-144`) requires whitespace or end after
 *      the command word. The same gap is pinned from the activation side at
 *      `tests/hooks/runtime-prompt-activation-wiring.test.js` ("observes
 *      nothing for a NAMESPACED slash"). Widening the regex is not this limb's
 *      change; the assertion exists so a future one is visible.
 *   5. BYTE IDENTITY AGAINST A PRE-WIRING FIXTURE. That invariant lives in
 *      `tests/hooks/runtime-prompt-decision-wiring.test.js`. What is proven
 *      here is weaker and different: the SAME prompt produces the SAME output
 *      whether or not the ledger write can happen at all. And not the WHOLE
 *      document — the diagnostic `message` carries a fresh `ckpt=<id>` on every
 *      invocation, so that token is normalized out. The two channels the host
 *      reads, `user_prompt` and `hookSpecificOutput`, are compared raw.
 *
 * @module tests/hooks/runtime-prompt-command-wiring
 */

import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync,
} from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { handleUserPromptSubmit } from '../../scripts/hooks/runtime-prompt.js';
import { ledgerFilePath, readAllEvents } from '../../lib/runtime/ledger.js';
import { validateEventContract } from '../../lib/runtime/event-writer.js';
import { CARRIERS, foldFiredCounts } from '../../lib/replay/existence-audit.js';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REAL_CONFIG_PATH = path.join(PLUGIN_ROOT, 'artibot.config.json');

/** Directories the hook resolves through `getPluginRoot()` at runtime. */
const LINKED_DIRS = ['lib', 'commands', 'skills', 'agents'];
const linkType = process.platform === 'win32' ? 'junction' : 'dir';

let sandboxRoot = '';
let savedEnv;

/**
 * Build a sandbox plugin root that is ALSO a real git repository.
 *
 * `git init`, not a bare `.git` directory: after ADR-011 the ledger lives in
 * the git COMMON dir (`lib/runtime/event-writer.js#ledgerFilePath`), so a
 * sandbox git had to accept would otherwise resolve to an ancestor — which is
 * how a suite writes fixture lines into the real store it is measuring.
 *
 * Real modules are LINKED, not copied, so the real code runs and a missing link
 * cannot make an assertion pass for the wrong reason.
 *
 * @returns {string} the canonicalized sandbox root.
 */
function makeSandbox() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'artibot-command-wiring-')));
  for (const dir of LINKED_DIRS) {
    symlinkSync(path.join(PLUGIN_ROOT, dir), path.join(root, dir), linkType);
  }
  copyFileSync(REAL_CONFIG_PATH, path.join(root, 'artibot.config.json'));
  mkdirSync(path.join(root, 'runtime'), { recursive: true });
  execFileSync('git', ['init', '--quiet'], { cwd: root, stdio: 'ignore' });
  return root;
}

beforeAll(() => {
  sandboxRoot = makeSandbox();
});

afterAll(() => {
  if (sandboxRoot) rmSync(sandboxRoot, { recursive: true, force: true });
});

beforeEach(() => {
  savedEnv = {
    CLAUDE_PLUGIN_ROOT: process.env.CLAUDE_PLUGIN_ROOT,
    ARTIBOT_RUNTIME_CHECKPOINT_DISABLE: process.env.ARTIBOT_RUNTIME_CHECKPOINT_DISABLE,
    ARTIBOT_RUNTIME_MEMORY_DISABLE: process.env.ARTIBOT_RUNTIME_MEMORY_DISABLE,
  };
  process.env.CLAUDE_PLUGIN_ROOT = sandboxRoot;
  process.env.ARTIBOT_RUNTIME_CHECKPOINT_DISABLE = '1';
  process.env.ARTIBOT_RUNTIME_MEMORY_DISABLE = '1';
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  // Per-test reset: every case asserts EXACT row counts, which would otherwise
  // accumulate across cases in the shared vitest worker.
  rmSync(ledgerFilePath(sandboxRoot), { force: true });
});

/**
 * Fire one prompt through the exported handler.
 *
 * @param {{prompt: string, sid?: string|null, pid?: string, cwd?: string|null}} args
 *   `sid`/`cwd` omitted deliberately when null — that is the fail-closed input.
 * @returns {Promise<object|null>} the hook's output document.
 */
function submit({ prompt, sid, pid, cwd = sandboxRoot }) {
  const payload = { user_prompt: prompt, event: 'UserPromptSubmit', prompt_id: pid };
  if (sid) payload.session_id = sid;
  if (cwd) payload.cwd = cwd;
  return handleUserPromptSubmit(payload);
}

/**
 * @param {string} [event] - event name to keep; all events when omitted.
 * @returns {object[]} ledger rows, REJECTIONS INCLUDED — a rejected line is
 *   still a written line, and a suite that only counted accepted rows would
 *   read a rejection as an absence.
 */
function rows(event) {
  const all = readAllEvents(sandboxRoot, { includeRejected: true });
  return event ? all.filter((e) => e.event === event) : all;
}

describe('the command sandbox seam', () => {
  it('carries the linked modules and its own git dir', () => {
    // NEGATIVE CONTROL. Without these, "nothing recorded" and "recorder
    // correctly skipped" are the same observation.
    for (const dir of LINKED_DIRS) expect(existsSync(path.join(sandboxRoot, dir))).toBe(true);
    expect(existsSync(path.join(sandboxRoot, '.git'))).toBe(true);
    // The ledger must resolve INSIDE the sandbox. If this ever points at the
    // real repository every assertion below is writing to production.
    expect(ledgerFilePath(sandboxRoot).startsWith(sandboxRoot)).toBe(true);
  });
});

describe('intent.detected carries the user-typed slash command', () => {
  it('writes exactly one row for /split status, with no rejection', async () => {
    const out = await submit({ prompt: '/split status', sid: 'sess-cmd-a', pid: 'prompt-cmd-a' });
    expect(out).not.toBeNull();

    const detected = rows('intent.detected');
    expect(detected).toHaveLength(1);
    const [row] = detected;
    expect(row.data).toEqual({ type: 'slash-command', confidence: 1, command: 'split' });
    expect(row.source).toBe('hook');
    expect(row.session_id).toBe('sess-cmd-a');
    expect(row.action_id).toBe('prompt-cmd-a');
    // Session fallback mission id, the same shape `_hook-fired-record.js` uses.
    expect(row.mission_id).toMatch(/^M-\d{8}-S[0-9a-z]{8}$/);

    // A REJECTED LINE IS STILL A LINE. Counting only `intent.detected` above
    // would pass even if the writer's every row were refused and rewritten as
    // `ledger.rejected`, so the refusals are counted separately.
    expect(rows('ledger.rejected')).toHaveLength(0);

    // The contract the writer has to satisfy, asserted against the allowlist
    // rather than restated: registered event, permitted source, required data
    // keys, declared field types.
    expect(validateEventContract(row)).toBeNull();

    // And the reader the field exists for can actually fold it.
    const fold = foldFiredCounts(detected, CARRIERS.commands);
    expect(fold).toEqual({ counts: { split: 1 }, absent: 0, denominator: 1 });
  });

  it('writes nothing for a plain prompt', async () => {
    await submit({
      prompt: 'explain how the router works', sid: 'sess-cmd-b', pid: 'prompt-cmd-b',
    });
    expect(rows('intent.detected')).toHaveLength(0);
    expect(rows('ledger.rejected')).toHaveLength(0);
  });

  it('writes nothing for a NAMESPACED slash — a known gap, pinned', async () => {
    // `detectSlashCommand` returns null for `/artibot:split`, so there is no
    // name to record and the writer skips rather than inventing one. Pinned
    // from the activation side too; see this file's header note 4.
    await submit({
      prompt: '/artibot:split status', sid: 'sess-cmd-c', pid: 'prompt-cmd-c',
    });
    expect(rows('intent.detected')).toHaveLength(0);
  });

  it('writes nothing when the payload carries no session id', async () => {
    const out = await submit({ prompt: '/split status', sid: null, pid: 'prompt-cmd-d' });
    expect(out).not.toBeNull();
    expect(rows('intent.detected')).toHaveLength(0);
    // FAIL-CLOSED, not fallback: a synthesized session would scatter one
    // session's rows across two missions.
    expect(rows()).toHaveLength(0);
  });

  it('writes nothing when the payload carries no cwd', async () => {
    const out = await submit({
      prompt: '/split status', sid: 'sess-cmd-e', pid: 'prompt-cmd-e', cwd: null,
    });
    expect(out).not.toBeNull();
    // FAIL-CLOSED. Falling back to `process.cwd()` would aim the write at
    // whichever repository the host launched the dispatcher from — under vitest
    // that is THIS repository, so the fallback would be a live write.
    expect(rows('intent.detected')).toHaveLength(0);
  });

  it('measures the on-disk size of one intent.detected row', async () => {
    await submit({ prompt: '/split status', sid: 'sess-cmd-z', pid: 'prompt-cmd-z' });
    const [row] = rows('intent.detected');
    const bytes = Buffer.byteLength(`${JSON.stringify(row)}\n`, 'utf-8');
    // Bounded, not pinned: an exact byte assertion would go red on any harmless
    // field rename. Measured 256 B on 2026-09-17 — well under the 4,096 B
    // `ledger.maxLineBytes` cap, so `foldOversized` never strips `command` off
    // this row.
    expect(bytes).toBeLessThan(4096);
  });

  it('records the command name lowercased and without its arguments', async () => {
    await submit({ prompt: '/SPLIT status --dry-run', sid: 'sess-cmd-f', pid: 'prompt-cmd-f' });
    const [row] = rows('intent.detected');
    expect(row.data.command).toBe('split');
    // PRIVACY: the row names a command, never what the user typed after it.
    expect(JSON.stringify(row)).not.toContain('--dry-run');
    expect(JSON.stringify(row)).not.toContain('status');
  });
});

describe('the ledger write cannot move the hook output by one byte', () => {
  it('returns the identical document with and without a usable cwd', async () => {
    // The position of the call is the guarantee: it runs AFTER `output` is
    // final and never receives it. This measures that guarantee from outside,
    // by comparing the SAME prompt in the one configuration where the write
    // definitely happens against the one where it definitely cannot.
    const withWrite = await submit({
      prompt: '/split status', sid: 'sess-cmd-g', pid: 'prompt-cmd-g',
    });
    expect(rows('intent.detected')).toHaveLength(1);
    rmSync(ledgerFilePath(sandboxRoot), { force: true });

    const withoutWrite = await submit({
      prompt: '/split status', sid: 'sess-cmd-g', pid: 'prompt-cmd-g', cwd: null,
    });
    expect(rows('intent.detected')).toHaveLength(0);

    // THE TWO CHANNELS THE HOST ACTUALLY READS, compared byte for byte.
    expect(withoutWrite.user_prompt).toBe(withWrite.user_prompt);
    expect(JSON.stringify(withoutWrite.hookSpecificOutput))
      .toBe(JSON.stringify(withWrite.hookSpecificOutput));
    expect(Buffer.byteLength(withoutWrite.user_prompt, 'utf-8'))
      .toBe(Buffer.byteLength(withWrite.user_prompt, 'utf-8'));

    // `message` is the diagnostic line, and it carries `ckpt=<id>` — a fresh
    // per-invocation checkpoint id that differs between ANY two runs and has
    // nothing to do with this writer (measured 2026-09-17: the only difference
    // between these two documents). It is normalized out rather than skipped,
    // so the rest of the line is still compared.
    // `lifecycle=teardown(<n>ms)` is wall-clock elapsed time pushed by
    // `lib/runtime/middleware/lifecycle.js:133`. It drifts 0ms/1ms between the
    // two invocations on a loaded CI runner (Node 20, run 35184252643 attempt 1),
    // so it is normalized out for the same reason as `ckpt`.
    const normalize = (s) => String(s)
      .replace(/ckpt=\w+/, 'ckpt=<id>')
      .replace(/teardown\(\d+ms\)/g, 'teardown(<ms>)');
    expect(normalize(withoutWrite.message)).toBe(normalize(withWrite.message));

    // Same key set, same order — a new key would escape the two checks above.
    expect(Object.keys(withoutWrite)).toEqual(Object.keys(withWrite));
  });
});
