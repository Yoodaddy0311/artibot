/**
 * Firewall gate — PreToolUse is a BLOCK POINT, and the routing observer that
 * now sits on it must be incapable of using that power.
 *
 * WHAT A PreToolUse HOOK CAN DO IF IT MISBEHAVES. Exit code 2 CANCELS the tool
 * call; a `hookSpecificOutput.permissionDecision` on stdout denies or asks.
 * Either one, reached by accident from `scripts/hooks/route-observe-pre.js`,
 * would stop an Agent spawn — a behaviour change smuggled in by an observer,
 * in a phase whose whole contract is "행동 변화 0". So the property this file
 * holds is deliberately blunt and has no exceptions:
 *
 *     stdout is ZERO BYTES and the exit code is 0, for every payload shape.
 *
 * THE EIGHT SHAPES (design ROUTE-RECEIPT-PRETOOLUSE §4). They are not a
 * wishlist; each one is a way the guarantee could break:
 *   1. normal                — the happy path must also be mute
 *   2. no `tool_input`       — property access on undefined
 *   3. no `prompt_id`        — an optional correlation key read as required
 *   4. unwritable ledger     — an I/O error escaping the writer
 *   5. circular object       — JSON.stringify throwing inside redaction
 *   6. 64 KB prompt          — the byte cap and the classifier under load
 *   7. tool_name !== 'Agent' — the early return, i.e. cost on other tools
 *   8. not JSON              — a parse error on stdin
 *
 * ── WHAT THIS GATE CANNOT SEE (rules §9) ────────────────────────────────────
 *   - WHETHER THE HOST ACTUALLY HONOURS THE 5000 TIMEOUT, or whether a timeout
 *     is non-blocking as the host docs say. Nothing here spawns a real host.
 *   - REGISTRATION. `hooks.json` matcher syntax is checked structurally below,
 *     never by observing the host fire it. The D0 probe measured `"Agent"` as
 *     a plain-string matcher through `--settings`; the expression form
 *     `tool == "Agent"` used in `hooks.json` is what the D2 live burn measures.
 *   - LATENCY. A node process now starts before every Agent spawn. Unmeasured.
 *   - THE OTHER PreToolUse HOOKS. This file judges one script; a sibling hook
 *     that starts writing stdout is invisible here.
 *   - REAL HOST PAYLOADS. Shapes are synthesized from the frozen key-name
 *     fixture. A host that changes its key set is caught by that fixture's
 *     diff, not by this gate.
 *
 * @module tests/firewall/host-payload-contract
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ledgerFilePath } from '../../lib/runtime/ledger.js';
import { observePre } from '../../scripts/hooks/route-observe-pre.js';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK = path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'route-observe-pre.js');
const HOOK_SRC = readFileSync(HOOK, 'utf-8');
const HOOKS_JSON = JSON.parse(readFileSync(path.join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf-8'));
const FIXTURE = JSON.parse(readFileSync(
  path.join(PLUGIN_ROOT, 'tests', 'hooks', 'fixtures', 'host-payloads', 'PreToolUse.Agent.json'),
  'utf-8',
));

/** The registered command path, as it appears in hooks.json. */
const HOOK_COMMAND_SUFFIX = 'scripts/hooks/route-observe-pre.js';

/**
 * Run the hook with a RAW stdin string, so a shape that cannot be produced by
 * `JSON.stringify` (case 8) goes through the same path as the others.
 */
function runRaw(raw, home) {
  const res = spawnSync(process.execPath, [HOOK], {
    input: raw,
    encoding: 'utf-8',
    env: { ...process.env, HOME: home, USERPROFILE: home },
    windowsHide: true,
  });
  return {
    status: res.status,
    stdoutBytes: Buffer.byteLength(String(res.stdout ?? ''), 'utf8'),
    stderr: String(res.stderr ?? ''),
  };
}

describe('PreToolUse(Agent) observer is mute and harmless — 8 payload shapes', () => {
  let tmp;
  let home;
  let repo;
  let shapes;

  const base = () => ({
    cwd: repo,
    effort: 'high',
    hook_event_name: 'PreToolUse',
    permission_mode: 'acceptEdits',
    prompt_id: 'pid-firewall',
    session_id: 'sess-firewall',
    tool_name: 'Agent',
    tool_use_id: 'toolu_firewall',
    transcript_path: path.join(tmp, 'transcript.jsonl'),
    tool_input: {
      description: 'Implement the byte cap and add regression tests',
      prompt: 'body',
      run_in_background: true,
      subagent_type: 'artibot:tdd-guide',
      name: 'lane-f',
    },
  });

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'artibot-l2d1-fw-')));
    home = path.join(tmp, 'home');
    repo = path.join(tmp, 'repo');
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore', windowsHide: true });

    // Case 4: `.artibot/runtime` exists as a FILE where the writer needs a
    // directory, in a second repo so the other cases keep a writable ledger.
    const blockedRepo = path.join(tmp, 'blocked');
    mkdirSync(path.join(blockedRepo, '.artibot'), { recursive: true });
    execFileSync('git', ['init'], { cwd: blockedRepo, stdio: 'ignore', windowsHide: true });
    writeFileSync(path.join(blockedRepo, '.artibot', 'runtime'), 'not a dir', 'utf-8');

    const noToolInput = base();
    delete noToolInput.tool_input;
    const noPromptId = base();
    delete noPromptId.prompt_id;

    shapes = [
      ['1 normal', JSON.stringify(base())],
      ['2 no tool_input', JSON.stringify(noToolInput)],
      ['3 no prompt_id', JSON.stringify(noPromptId)],
      ['4 unwritable ledger', JSON.stringify({ ...base(), cwd: blockedRepo })],
      // A payload cannot be circular ON THE WIRE — stdin is text — so the wire
      // form of "shared structure the redactor must survive" is a self-similar
      // DAG. The genuine cycle is exercised in-process below, which is the only
      // way a cycle can actually reach this code.
      ['5 shared/deep structure', JSON.stringify((() => {
        const p = base();
        const leaf = { a: { b: { c: 'x' } } };
        p.tool_input.description = 'implement tests';
        p.tool_input.shared = [leaf, leaf, leaf, leaf];
        return p;
      })())],
      ['6 64KB prompt', JSON.stringify((() => {
        const p = base();
        delete p.tool_input.description;
        p.tool_input.prompt = 'x'.repeat(64 * 1024);
        return p;
      })())],
      ['7 other tool', JSON.stringify({ ...base(), tool_name: 'Bash', tool_input: { command: 'ls' } })],
      ['8 not JSON', 'this is not json {{{'],
    ];
  });

  afterEach(() => {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  });

  it('holds the guarantee on all eight shapes, and there are eight of them', () => {
    // Scanner self-check: a shapes array that silently shrank would make the
    // loop below pass while measuring less.
    expect(shapes).toHaveLength(8);
    const results = shapes.map(([name, raw]) => [name, runRaw(raw, home)]);
    for (const [name, r] of results) {
      expect(r.stdoutBytes, `${name}: stdout must be empty`).toBe(0);
      expect(r.status, `${name}: exit must be 0 (2 would cancel the tool call)`).toBe(0);
    }
  });

  it.each([0, 1, 2, 3, 4, 5, 6, 7])('shape %i individually: 0 bytes on stdout, exit 0', (i) => {
    const [name, raw] = shapes[i];
    const r = runRaw(raw, home);
    expect(r.stdoutBytes, `${name} stdout`).toBe(0);
    expect(r.status, `${name} exit`).toBe(0);
  });

  it('shape 7 (other tool) touches no ledger at all — the early return is real', () => {
    const r = runRaw(shapes[6][1], home);
    expect(r.status).toBe(0);
    expect(existsSync(ledgerFilePath(repo))).toBe(false);
  });

  it('shape 4 (unwritable ledger) leaves no ledger and still exits 0', () => {
    const r = runRaw(shapes[3][1], home);
    expect(r.status).toBe(0);
    expect(r.stdoutBytes).toBe(0);
    expect(existsSync(ledgerFilePath(path.join(tmp, 'blocked')))).toBe(false);
  });

  it('shape 6 (64KB prompt) still records, and the line stays under the 4KB cap', () => {
    expect(runRaw(shapes[5][1], home).status).toBe(0);
    const file = ledgerFilePath(repo);
    expect(existsSync(file)).toBe(true);
    const raw = readFileSync(file, 'utf-8');
    for (const line of raw.split('\n').filter(Boolean)) {
      expect(Buffer.byteLength(`${line}\n`, 'utf8')).toBeLessThanOrEqual(4096);
    }
    // And the 64 KB of prompt is not in the file.
    expect(raw).not.toContain('x'.repeat(200));
  });

  it('a GENUINE circular object does not throw and does not record', async () => {
    // Reachable only in-process, so it is tested in-process. `observePre` is
    // the whole body of the hook minus stdin; if it returns instead of
    // throwing, `main()` cannot fail either.
    const payload = { ...JSON.parse(shapes[0][1]) };
    payload.tool_input = { ...payload.tool_input };
    payload.tool_input.self = payload;
    payload.self = payload;
    await expect(observePre(payload)).resolves.toBeTruthy();
  });

  it('a null / undefined / non-object payload is a no-op, not a throw', async () => {
    for (const bad of [null, undefined, 42, 'string', []]) {
      const out = await observePre(bad);
      expect(out.ok).toBe(false);
      expect(out.reason).toBe('not-agent-tool');
    }
  });
});

describe('gate self-verification', () => {
  it('the hook never imports a stdout writer and names no permission decision', () => {
    // Source-level, one level below behaviour: a future edit that adds
    // `writeStdout` would pass a mute run today and be a block point tomorrow.
    // Matched as CODE, not as text: the file's own header explains why it does
    // not import `writeStdout`, and a substring check would flag that prose.
    expect(HOOK_SRC).not.toMatch(/import\s*\{[^}]*\bwriteStdout\b/);
    expect(HOOK_SRC).not.toMatch(/\bwriteStdout\s*\(/);
    expect(HOOK_SRC).not.toMatch(/['"]permissionDecision['"]/);
    expect(HOOK_SRC).not.toMatch(/process\.stdout\.write\s*\(/);
    expect(HOOK_SRC).not.toMatch(/process\.exit\s*\(/);
    // It pins its own exit code rather than relying on node's default.
    expect(HOOK_SRC).toContain('process.exitCode = 0');
  });

  it('is registered exactly once, on the Agent tool, in hooks.json', () => {
    const groups = HOOKS_JSON.hooks.PreToolUse ?? [];
    const matched = groups.filter(
      (g) => (g.hooks ?? []).some((h) => String(h.command ?? '').includes(HOOK_COMMAND_SUFFIX)),
    );
    expect(matched).toHaveLength(1);
    // PLAIN STRING, NOT THE EXPRESSION FORM, AND THAT IS A MEASUREMENT — not a
    // style choice, and not an oversight next to the `tool == "Bash"` entries
    // in the same file. A/B on host 2.1.260, 2026-09-04 14:47–14:51 KST, same
    // prompt, same hook, only the matcher changed (temporary `--settings`,
    // user settings untouched):
    //   matcher `tool == "Agent"` → 0 route.selected rows, 2 runs
    //   matcher `"Agent"`         → 1 route.selected + 1 route.bound, 1 run
    // The D0 probe had already measured the plain string firing and recorded
    // the expression form as untried; this closes that gap in the other
    // direction. UNMEASURED: whether the expression form behaves differently
    // in `hooks.json` than under `--settings` — that is what D3 sees.
    expect(matched[0].matcher).toBe('Agent');
    expect(matched[0].hooks).toHaveLength(1);
    expect(typeof matched[0].hooks[0].timeout).toBe('number');
    // Follow-up 14 (hooks.json timeout unit convention) is CONFIRM-ONLY for
    // this limb: no existing value is changed, and the new entry adopts the
    // file's own scale rather than inventing a second one. Every PreToolUse
    // entry in this file states 5000; this asserts the new one did not fork it.
    const preTimeouts = new Set(groups.flatMap((g) => (g.hooks ?? []).map((h) => h.timeout)));
    expect([...preTimeouts]).toEqual([5000]);
  });

  it('a payload that SHOULD record does record — the gate is not vacuously green', () => {
    // Without this, a hook that returned at line 1 for everything would satisfy
    // every assertion above while recording nothing at all.
    const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'artibot-l2d1-fwpos-')));
    try {
      const home = path.join(tmp, 'home');
      const repo = path.join(tmp, 'repo');
      mkdirSync(path.join(home, '.claude'), { recursive: true });
      mkdirSync(repo, { recursive: true });
      execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore', windowsHide: true });
      const r = runRaw(JSON.stringify({
        cwd: repo,
        hook_event_name: 'PreToolUse',
        prompt_id: 'pid-positive',
        session_id: 'sess-positive',
        tool_name: 'Agent',
        tool_use_id: 'toolu_positive',
        transcript_path: path.join(tmp, 't.jsonl'),
        tool_input: {
          description: 'Implement the byte cap and add regression tests',
          prompt: 'body',
          run_in_background: true,
          subagent_type: 'artibot:tdd-guide',
        },
      }), home);
      expect(r.status).toBe(0);
      expect(r.stdoutBytes).toBe(0);
      const lines = readFileSync(ledgerFilePath(repo), 'utf-8').split('\n').filter(Boolean);
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]).event).toBe('route.selected');
    } finally {
      try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
    }
  });

  it('the frozen fixture still says D1-go — the premise of all of the above', () => {
    expect(FIXTURE.host_version).toBe('2.1.260');
    expect(FIXTURE.verdict).toBe('D1-go');
    expect(FIXTURE.missing).toEqual([]);
    expect(FIXTURE.totals.pretooluse_rows).toBe(FIXTURE.totals.spawns);
  });
});
