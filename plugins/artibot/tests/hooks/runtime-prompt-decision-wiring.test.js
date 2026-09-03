/**
 * T-37 — decision-events wiring for the topology sighting, and the proof that
 * wiring it changed the hook's stdout by ZERO bytes.
 *
 * WHAT THIS SUITE CANNOT SEE (stated next to the gate, so the gate cannot
 * become the next false assurance):
 *
 *  1. It does not prove the ledger refusal. That `topology.selected` and
 *     `context.compiled` are refused from a hook `source` is measured in
 *     tests/hooks/runtime-prompt-memory-instrumentation.test.js against the
 *     real writer; here it is only the REASON the events go to
 *     `runtime/decisions/` instead, not an assertion.
 *  2. Byte-identity is proven for the PROMPTS THIS FILE FIRES, not for all
 *     prompts. The structural argument (both recorders run after `output` is
 *     final and neither receives it) is what covers the rest; these cases are
 *     the sample that makes the argument checkable.
 *  3. It compares against a FROZEN FIXTURE of the pre-wiring hook, not the
 *     installed plugin and not live history. If that revision already carried a
 *     defect, this suite reproduces it identically and calls that a pass. The
 *     fixture is deliberately never refreshed, so any later change to the hook
 *     that is NOT the T-37 wiring is absent from the control too: this proves
 *     "the wiring changed no bytes", never "the hook still behaves as it did".
 *  4. It says nothing about whether the recorded topology `mode` is CORRECT.
 *     topology-router.js is an Observe-stage sighting function whose weights are
 *     uncalibrated by its own header; this only checks that what the router
 *     returned is what reached disk.
 *  5. The child-process cases run with memory and checkpoint middleware
 *     DISABLED via env, so they do not exercise the memory-injection path at
 *     all — that is the sibling suite's job.
 *  6. No test here runs the live hook against the real plugin root. Everything
 *     writes under a temp sandbox; a regression that only appears at the real
 *     root would not be seen.
 *  7. The recorder-stats assertions check a FLOOR, not a total. The counters are
 *     module state cumulative for the process, and the in-process cases here
 *     share one vitest worker, so an exact count would couple these tests to
 *     each other's order. Exact counts are asserted in
 *     tests/observability/decision-events-t37.test.js, which resets them.
 */

import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync,
  readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { handleUserPromptSubmit } from '../../scripts/hooks/runtime-prompt.js';
import {
  RECORDER_STATS,
  TOPOLOGY_RECOMMENDED,
  UNATTRIBUTED_RUN_ID,
} from '../../lib/observability/decision-events.js';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REAL_CONFIG_PATH = path.join(PLUGIN_ROOT, 'artibot.config.json');
const REAL_HOOK = path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'runtime-prompt.js');

/** Directories the hook resolves through `getPluginRoot()` at runtime. */
const LINKED_DIRS = ['lib', 'commands', 'skills', 'agents'];

const linkType = process.platform === 'win32' ? 'junction' : 'dir';

let sandboxRoot = '';
let baselineHook = '';
let savedEnv;

/**
 * The symbol whose presence means a source ALREADY carries the T-37 wiring.
 * Used to prove the control is pre-wiring, not to assert behavior.
 */
const WIRING_MARKER = 'recordObserveOnlyDecisions';

/**
 * The frozen pre-wiring hook. A CHECKED-IN FILE, not a `git log` lookup.
 *
 * This used to walk `git log -n 50 -- <hook>` at run time to find the newest
 * revision without the marker. That needs full history, and GitHub Actions
 * checks out SHALLOW — so on CI the revision did not exist and every test in
 * this file failed with "no pre-wiring revision … found in the last 50"
 * (run 33714134586: Linux ×3, Windows ×1). It passed locally only because a
 * developer clone carries the history, and it would have started failing
 * locally too once the hook gathered 50 more commits. The control could expire;
 * a file cannot.
 *
 * Provenance and the freeze rule live in the fixture's own header.
 */
const PRE_WIRING_FIXTURE = path.join(
  PLUGIN_ROOT, 'tests', 'hooks', 'fixtures', 'runtime-prompt.pre-wiring.js.txt',
);

/**
 * Build a sandbox plugin root: real modules LINKED in (not copied, so the real
 * code runs and a missing link cannot make an assertion pass for the wrong
 * reason) plus a real config file, which `getPluginRoot()` validates for.
 * @param {string} prefix
 * @returns {string}
 */
function makeSandbox(prefix) {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  for (const dir of LINKED_DIRS) {
    symlinkSync(path.join(PLUGIN_ROOT, dir), path.join(root, dir), linkType);
  }
  copyFileSync(REAL_CONFIG_PATH, path.join(root, 'artibot.config.json'));
  mkdirSync(path.join(root, 'runtime'), { recursive: true });
  return root;
}

beforeAll(() => {
  sandboxRoot = makeSandbox('artibot-t37-wiring-');

  // The PRE-WIRING hook, from the frozen fixture. Placed inside its own scripts/
  // tree so its three relative imports resolve: '../utils/index.js' via a link
  // to the real utils, '../../lib/core/hook-utils.js' via the linked lib, and
  // './_main-entry.js' via a copy (copied rather than linked so `isMainEntry`
  // compares two real paths).
  const hooksDir = path.join(sandboxRoot, 'scripts', 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  symlinkSync(
    path.join(PLUGIN_ROOT, 'scripts', 'utils'),
    path.join(sandboxRoot, 'scripts', 'utils'),
    linkType,
  );
  copyFileSync(
    path.join(PLUGIN_ROOT, 'scripts', 'hooks', '_main-entry.js'),
    path.join(hooksDir, '_main-entry.js'),
  );
  baselineHook = path.join(hooksDir, 'runtime-prompt.js');
  writeFileSync(baselineHook, readFileSync(PRE_WIRING_FIXTURE, 'utf-8'), 'utf-8');
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
  const store = path.join(sandboxRoot, 'runtime', 'decisions');
  rmSync(store, { recursive: true, force: true });
});

/** @returns {object[]} every decision event written under the sandbox store. */
function readSandboxDecisions() {
  const store = path.join(sandboxRoot, 'runtime', 'decisions');
  if (!existsSync(store)) return [];
  return readdirSync(store)
    .filter((f) => f.endsWith('.ndjson'))
    .flatMap((f) => readFileSync(path.join(store, f), 'utf-8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l)));
}

/**
 * Run one hook file as a child process, exactly as Claude Code invokes it.
 * The hook's `main()` blocks on stdin, so this is the only way to exercise the
 * real entry point; the in-process tests below call the exported handler.
 * @param {string} hookPath
 * @param {object} payload
 * @returns {{stdout: string, status: number, stderr: string}}
 */
function runHook(hookPath, payload) {
  // Reset the MUTABLE runtime state first. The hook both writes and reads
  // runtime/token-usage-session.json (the token counter accumulates across
  // invocations and lands in `message` as `tokens=N`) and
  // runtime/current-effort.json. Without this reset the second spawn of a pair
  // starts from state the first one left, and the resulting difference would be
  // blamed on the T-37 wiring instead of on run order — measured 2026-09-02,
  // where the same payload passed or failed depending on which ran first.
  for (const f of [
    'current-effort.json', 'current-task-budget.json',
    'token-usage-session.json', 'decision-trail.json',
  ]) {
    rmSync(path.join(sandboxRoot, 'runtime', f), { force: true });
  }
  const res = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    env: {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: sandboxRoot,
      ARTIBOT_RUNTIME_CHECKPOINT_DISABLE: '1',
      ARTIBOT_RUNTIME_MEMORY_DISABLE: '1',
    },
  });
  return { stdout: res.stdout ?? '', stderr: res.stderr ?? '', status: res.status };
}

describe('T-37 sandbox seam', () => {
  it('carries the linked modules and the baseline hook', () => {
    // NEGATIVE CONTROL. Without the links every dynamic import in the hook falls
    // into its catch block, and "nothing recorded" would look identical to
    // "recorder correctly skipped". Assert the seam rather than trusting it.
    for (const dir of LINKED_DIRS) {
      expect(existsSync(path.join(sandboxRoot, dir))).toBe(true);
    }
    expect(existsSync(path.join(sandboxRoot, 'lib', 'topology', 'topology-router.js'))).toBe(true);
    expect(existsSync(path.join(sandboxRoot, 'lib', 'observability', 'decision-events.js'))).toBe(true);
    expect(existsSync(baselineHook)).toBe(true);
  });

  it('has a pre-wiring fixture that exists and is not empty', () => {
    // FAIL-CLOSED. A missing or truncated fixture must go red here rather than
    // produce an empty baseline whose stdout trivially matches nothing.
    expect(existsSync(PRE_WIRING_FIXTURE)).toBe(true);
    const raw = readFileSync(PRE_WIRING_FIXTURE, 'utf-8');
    expect(raw.trim().length).toBeGreaterThan(0);
    // Not merely non-empty: it must actually be the hook. A stray file that
    // happened to sit at this path would otherwise satisfy the length check.
    expect(raw).toContain('handleUserPromptSubmit');
  });

  it('has a fixture that is genuinely PRE-wiring', () => {
    // FAIL-CLOSED, and the reason the fixture is frozen. If anyone regenerates
    // it from a wired revision, the byte comparison below would be comparing the
    // change to itself and pass vacuously. This turns that into a red test.
    expect(readFileSync(PRE_WIRING_FIXTURE, 'utf-8')).not.toContain(WIRING_MARKER);
    expect(readFileSync(baselineHook, 'utf-8')).not.toContain(WIRING_MARKER);
  });
});

describe('topology sighting reaches runtime/decisions/', () => {
  it('writes exactly one topology-recommended event per prompt', async () => {
    const out = await handleUserPromptSubmit({
      user_prompt: 'add oauth login to the settings page',
      session_id: 'sess-t37-topology-a',
      event: 'UserPromptSubmit',
    });
    expect(out).not.toBeNull();

    const topo = readSandboxDecisions().filter((e) => e.type === TOPOLOGY_RECOMMENDED);
    expect(topo).toHaveLength(1);
    expect(topo[0].data.observe_only).toBe(true);
    expect(topo[0].data.mode).toBeTypeOf('string');
    expect(topo[0].phase).toBe('ROUTE');
  });

  it('records the router humanGateHits as advisory, never as a verdict', async () => {
    await handleUserPromptSubmit({
      user_prompt: 'run rm -rf build and then deploy to production',
      session_id: 'sess-t37-topology-b',
      event: 'UserPromptSubmit',
    });
    const [topo] = readSandboxDecisions().filter((e) => e.type === TOPOLOGY_RECOMMENDED);
    expect(topo.data.humanGateHits.advisory).toBe(true);
    expect(Array.isArray(topo.data.humanGateHits.hits)).toBe(true);
  });

  it('never writes prompt text into the recorded reason list', async () => {
    // A distinctive token that appears ONLY in the prompt. topology-router.js
    // returns pattern ids from a fixed table, so no reason may carry it.
    const canary = 'zqxjkvbrpm-canary-9182';
    await handleUserPromptSubmit({
      user_prompt: `대규모 변경을 파일별로 병렬 처리해줘 ${canary}`,
      session_id: 'sess-t37-topology-c',
      event: 'UserPromptSubmit',
    });
    const [topo] = readSandboxDecisions().filter((e) => e.type === TOPOLOGY_RECOMMENDED);
    expect(JSON.stringify(topo)).not.toContain(canary);
    // The NL port is live: supplying evidence.promptText is what makes the
    // split phrases reachable at all (T-36's finding).
    expect(topo.data.reason.some((r) => r.startsWith('nl-match:'))).toBe(true);
  });

  it('records no decision events when the payload carries no session id', async () => {
    const out = await handleUserPromptSubmit({
      user_prompt: 'a prompt with no session',
      event: 'UserPromptSubmit',
    });
    expect(out).not.toBeNull();
    // No date-bucket fallback: an absent session is counted as skipped, never
    // bucketed into a file that would make the store look alive.
    const decisions = readSandboxDecisions()
      .filter((e) => e.type !== RECORDER_STATS);
    expect(decisions).toHaveLength(0);
  });

  it('leaves the skipped count readable in the _unattributed file', async () => {
    // The counters used to die with the process. Without this line the drop is
    // counted in memory nobody reads — the same "nobody can see it" failure the
    // module header claims to have fixed. Filed under `_unattributed` because
    // the drop was CAUSED by the missing session, so there is no session to
    // file it under.
    await handleUserPromptSubmit({
      user_prompt: 'another prompt with no session',
      event: 'UserPromptSubmit',
    });

    const statsFile = path.join(
      sandboxRoot, 'runtime', 'decisions', `${UNATTRIBUTED_RUN_ID}.events.ndjson`,
    );
    expect(existsSync(statsFile)).toBe(true);

    const lines = readFileSync(statsFile, 'utf-8').split('\n').filter((l) => l.trim())
      .map((l) => JSON.parse(l));
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const last = lines[lines.length - 1];
    expect(last.type).toBe(RECORDER_STATS);
    // Counts are cumulative for the process and this suite shares one worker
    // with earlier cases, so assert the SHAPE and a floor, not an exact total.
    expect(last.data.skipped).toBeGreaterThan(0);
    expect(last.data).toHaveProperty('failed');
    expect(last.data.runId).toBeUndefined();
  });

  it('still returns output when the topology module cannot be imported', async () => {
    // Point the root at a sandbox with NO lib/, so the dynamic import throws.
    const bare = mkdtempSync(path.join(tmpdir(), 'artibot-t37-bare-'));
    copyFileSync(REAL_CONFIG_PATH, path.join(bare, 'artibot.config.json'));
    process.env.CLAUDE_PLUGIN_ROOT = bare;
    try {
      const out = await handleUserPromptSubmit({
        user_prompt: '/implement add a feature',
        session_id: 'sess-t37-import-fail',
        event: 'UserPromptSubmit',
      });
      expect(out).not.toBeNull();
      expect(out.user_prompt).toContain('add a feature');
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

/**
 * Mask the TWO tokens this hook has always emitted nondeterministically, both
 * inside `message` and both pre-existing — neither was introduced by T-37:
 *
 *   ckpt=<5 chars>       checkpoint.js:14 builds `ckpt-<ts36>-<Math.random()>`
 *                        and checkpoint.js:172 pushes its last 5 characters.
 *   teardown(<N>ms)      a measured wall-clock duration, observed as both 0ms
 *                        and 1ms for the same payload.
 *
 * Found by DIFFING the two hooks' real output rather than by reasoning about
 * what ought to vary: the first pass of this suite masked only `ckpt` and the
 * remaining `teardown` drift produced a failure that looked like a wiring
 * regression. Recorded here so the next reader does not repeat that inference.
 *
 * The mask is two anchored tokens and nothing else. The first test below is
 * what keeps it honest: it asserts the mask is NECESSARY (one hook's raw output
 * against itself differs) and SUFFICIENT (masked, it matches). A mask that had
 * grown to cover a real difference would have to break that pair first.
 *
 * @param {string} s
 * @returns {string}
 */
function maskVolatile(s) {
  return s
    .replace(/ckpt=[a-z0-9]+/g, 'ckpt=<masked>')
    .replace(/teardown\(\d+ms\)/g, 'teardown(<masked>ms)');
}

describe('stdout is byte-identical to the pre-wiring hook', () => {
  const PAYLOADS = [
    { label: 'slash command', user_prompt: '/implement add oauth login', session_id: 'sess-bytes-1' },
    { label: 'plain prompt', user_prompt: 'explain how the router works', session_id: 'sess-bytes-2' },
    { label: 'split phrase', user_prompt: '대규모 변경을 파일별로 병렬 처리해줘', session_id: 'sess-bytes-3' },
    { label: 'youtube hint', user_prompt: 'summarize https://youtu.be/dQw4w9WgXcQ', session_id: 'sess-bytes-4' },
    { label: 'no session', user_prompt: 'a prompt with no session at all' },
  ];

  it('pins the pre-existing nondeterminism the mask exists for', () => {
    // PRECONDITION, and the mask's own justification. The SAME hook run twice
    // must differ, and must match once masked. Without this pair the comparisons
    // below could pass because the mask hid a real change.
    // This payload is chosen because it actually EMITS `ckpt=`. Emission is
    // payload-dependent — the smart pipeline drops the checkpoint middleware for
    // some prompts, and 'explain how the router works' is one of them, which is
    // why an earlier draft of this test asserted determinism it had not
    // established. Measured 2026-09-02.
    const payload = { user_prompt: 'a prompt with no session at all' };
    const a = runHook(REAL_HOOK, payload);
    const b = runHook(REAL_HOOK, payload);
    expect(a.status).toBe(0);
    expect(a.stdout.length).toBeGreaterThan(0);

    // Both masked tokens are actually present, so neither pattern is dead code
    // silently covering nothing.
    expect(a.stdout).toContain('ckpt=');
    expect(a.stdout).toMatch(/teardown\(\d+ms\)/);

    // Necessary: one hook's raw bytes against ITSELF are not stable. `ckpt` is
    // seeded from Math.random(), so this holds on every run, not by luck.
    expect(a.stdout).not.toBe(b.stdout);
    // Sufficient: masking those tokens makes them equal.
    expect(maskVolatile(a.stdout)).toBe(maskVolatile(b.stdout));
  });

  it.each(PAYLOADS)('$label — HEAD and current emit the same bytes', (payload) => {
    const { label: _label, ...hookData } = payload;
    const before = runHook(baselineHook, { ...hookData, event: 'UserPromptSubmit' });
    const after = runHook(REAL_HOOK, { ...hookData, event: 'UserPromptSubmit' });

    expect(before.status).toBe(0);
    expect(after.status).toBe(0);
    expect(after.stdout.length).toBeGreaterThan(0);

    // Compare BYTES, not parsed JSON: key order and whitespace are part of what
    // the model receives, and a parsed comparison would hide a reordering.
    const beforeBytes = Buffer.from(maskVolatile(before.stdout), 'utf-8');
    const afterBytes = Buffer.from(maskVolatile(after.stdout), 'utf-8');
    expect(afterBytes.equals(beforeBytes)).toBe(true);

    // Stop the mask from doing structural work: both sides must carry the SAME
    // NUMBER of volatile tokens, so an added or removed `ckpt=` / `teardown(…)`
    // cannot be absorbed into equality.
    //
    // An earlier draft instead compared raw bytes whenever `ckpt=` was absent.
    // That branch was UNREACHABLE — `teardown(<N>ms)` is emitted on every
    // prompt, so the raw strings can differ even with no `ckpt` — and it failed
    // intermittently in the full-suite run while passing in isolation. Counting
    // the tokens is the check that branch was reaching for.
    const countOf = (s, re) => (s.match(re) || []).length;
    for (const re of [/ckpt=[a-z0-9]+/g, /teardown\(\d+ms\)/g]) {
      expect(countOf(after.stdout, re)).toBe(countOf(before.stdout, re));
    }
  });

  it('the wiring did run during those comparisons (identity is not vacuous)', () => {
    // Guard against the failure mode where the recorders silently no-op and the
    // byte comparison passes because nothing happened at all.
    runHook(REAL_HOOK, {
      user_prompt: 'explain how the router works',
      session_id: 'sess-not-vacuous',
      event: 'UserPromptSubmit',
    });
    const topo = readSandboxDecisions().filter((e) => e.type === TOPOLOGY_RECOMMENDED);
    expect(topo.length).toBeGreaterThanOrEqual(1);
  });
});
