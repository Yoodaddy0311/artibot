import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * FIREWALL — UserPromptSubmit dispatcher stdout must be a HOST ALLOWLIST.
 *
 * Why this file exists (DESIGN-UPS-additionalContext-migration.md §1, §4.5 D1):
 * host 2.1.259/2.1.260 validate a hook's stdout against a fixed schema and
 * STRIP every key outside it, logging `Hook JSON output had unrecognized keys
 * (ignored)` to the debug file only. For six weeks the dispatcher emitted the
 * runtime envelope as a top-level `user_prompt`, which is not in that schema —
 * so the effort/task-budget/team directives never reached the model and nothing
 * in the repo could see it (PROBE-effort-directive-delivery.md B1-B6).
 *
 * The gate therefore runs the REAL dispatcher as a child process on the REAL
 * host payload shape (`prompt`, not the dispatcher-internal `user_prompt`) and
 * asserts the three properties that failure had:
 *   1. every stdout key is inside the host allowlist,
 *   2. the directives are inside `hookSpecificOutput.additionalContext`,
 *   3. stdout stays under the host's 10,000 B spill threshold.
 *
 * WHAT THIS GATE CANNOT SEE
 *   - Whether the host actually DELIVERS additionalContext to the model. That
 *     is D4 (live transcript + `--debug-file`), impossible from a worktree
 *     because it needs an updated INSTALLED plugin (design §4.3-4, §4.5).
 *   - Whether the meta message carries the same weight as a prompt prefix
 *     (design §4.3-2 — unmeasured).
 *   - The 10 KB spill BEHAVIOUR. It pins the size, not what the host does at
 *     the boundary (design §4.3-3 — the truncation path was not read).
 *   - Host schema drift. That is ups-host-schema-drift.test.js.
 *   - Any hook not on the UserPromptSubmit slot.
 */

const PLUGIN_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..',
);
const DISPATCHER = path.join(PLUGIN_ROOT, 'scripts', 'hooks', '_userprompt-dispatcher.js');

/** Host stdout spill threshold (`lnr=1e4` in the 2.1.259 binary, PROBE §4). */
const HOST_SPILL_THRESHOLD_BYTES = 10000;

let sandboxHome;
let sandboxCwd;
let sandboxRoot;

beforeAll(() => {
  sandboxHome = mkdtempSync(path.join(tmpdir(), 'artibot-ups-fw-home-'));
  sandboxCwd = mkdtempSync(path.join(tmpdir(), 'artibot-ups-fw-cwd-'));
  sandboxRoot = mkdtempSync(path.join(tmpdir(), 'artibot-ups-fw-root-'));
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  for (const dir of ['lib', 'commands', 'skills', 'agents']) {
    symlinkSync(path.join(PLUGIN_ROOT, dir), path.join(sandboxRoot, dir), linkType);
  }
  copyFileSync(
    path.join(PLUGIN_ROOT, 'artibot.config.json'),
    path.join(sandboxRoot, 'artibot.config.json'),
  );
  mkdirSync(path.join(sandboxRoot, 'runtime'), { recursive: true });
});

afterAll(() => {
  for (const dir of [sandboxHome, sandboxCwd, sandboxRoot]) {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/** Run the real dispatcher and return RAW stdout (bytes matter for the cap). */
function runDispatcherRaw(payload, env = {}) {
  return execFileSync(
    process.execPath,
    [DISPATCHER],
    {
      cwd: sandboxCwd,
      env: {
        ...process.env,
        CLAUDE_PLUGIN_ROOT: sandboxRoot,
        USERPROFILE: sandboxHome,
        HOME: sandboxHome,
        ARTIBOT_RUNTIME_CHECKPOINT_DISABLE: '1',
        ARTIBOT_RUNTIME_MEMORY_DISABLE: '1',
        ...env,
      },
      input: JSON.stringify(payload),
      encoding: 'utf-8',
      timeout: 30000,
    },
  );
}

/** The host payload shape measured on 2.1.259 (PROBE §3) — `prompt`, no `user_prompt`. */
const hostPayload = (prompt) => ({
  hook_event_name: 'UserPromptSubmit',
  prompt,
  prompt_id: 'e3b0c442-98fc-1c14-9afb-f4c8996fb924',
  session_id: '9120048e-3385-4855-a35b-09c89e5dd684',
  cwd: sandboxCwd,
});

describe('UPS stdout allowlist — source constant', () => {
  it('the allowlist is a POSITIVE list, not a deny list', () => {
    const src = readFileSync(DISPATCHER, 'utf-8');
    // The constant must exist and name the host schema keys.
    expect(src).toMatch(/HOST_STDOUT_KEYS/);
    expect(src).toMatch(/HOST_UPS_KEYS/);
    // Deny-list phrasing is the failure mode this design forbids (design §1.3,
    // rules/verification-discipline.md §8: a negative list is fail-OPEN for
    // every key that has not been invented yet). `user_prompt` and `message`
    // must be absent from the merge decision entirely — they are NOT copied,
    // rather than being copied and then deleted.
    expect(src).not.toMatch(/DROP_KEYS|DENY_KEYS|BLOCKED_KEYS|FORBIDDEN_KEYS/);
    expect(src).not.toMatch(/delete\s+out\[/);
  });

  it('exports the allowlist so drift can be cross-checked against the host', async () => {
    const mod = await import(DISPATCHER);
    expect(Array.isArray(mod.HOST_STDOUT_KEYS)).toBe(true);
    expect(Array.isArray(mod.HOST_UPS_KEYS)).toBe(true);
    expect(mod.HOST_STDOUT_KEYS).toContain('hookSpecificOutput');
    expect(mod.HOST_UPS_KEYS).toContain('additionalContext');
    // The keys the incident was about must NOT be in the allowlist.
    expect(mod.HOST_STDOUT_KEYS).not.toContain('user_prompt');
    expect(mod.HOST_STDOUT_KEYS).not.toContain('message');
  });
});

describe('UPS stdout allowlist — real dispatcher, real host payload', () => {
  /** @type {{ raw: string, parsed: object }} */
  let slash;
  /** @type {{ raw: string, parsed: object }} */
  let plain;

  beforeAll(() => {
    const rawSlash = runDispatcherRaw(hostPayload('/team 프론트와 백엔드 시스템을 마이그레이션하고 테스트도 추가해줘'));
    const rawPlain = runDispatcherRaw(hostPayload('프론트와 백엔드 시스템을 마이그레이션하고 테스트도 추가해줘'));
    slash = { raw: rawSlash, parsed: JSON.parse(rawSlash.trim()) };
    plain = { raw: rawPlain, parsed: JSON.parse(rawPlain.trim()) };
  }, 90000);

  it('NEGATIVE CONTROL: both payloads actually produced an envelope', () => {
    // Without this, every assertion below could pass on an empty stdout.
    expect(slash.raw.trim().length).toBeGreaterThan(0);
    expect(plain.raw.trim().length).toBeGreaterThan(0);
    expect(typeof slash.parsed.hookSpecificOutput?.additionalContext).toBe('string');
    expect(typeof plain.parsed.hookSpecificOutput?.additionalContext).toBe('string');
  });

  it('every top-level stdout key is inside the host allowlist', async () => {
    const { HOST_STDOUT_KEYS } = await import(DISPATCHER);
    for (const out of [slash.parsed, plain.parsed]) {
      for (const key of Object.keys(out)) {
        expect(HOST_STDOUT_KEYS, `top-level key "${key}"`).toContain(key);
      }
      expect(Object.keys(out)).not.toContain('user_prompt');
      expect(Object.keys(out)).not.toContain('message');
    }
  });

  it('every hookSpecificOutput key is inside the UPS allowlist', async () => {
    const { HOST_UPS_KEYS } = await import(DISPATCHER);
    for (const out of [slash.parsed, plain.parsed]) {
      for (const key of Object.keys(out.hookSpecificOutput)) {
        expect(HOST_UPS_KEYS, `hookSpecificOutput key "${key}"`).toContain(key);
      }
      expect(out.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    }
  });

  it('a slash command puts the effort + task-budget directives on the FIRST line', () => {
    const ctx = slash.parsed.hookSpecificOutput.additionalContext;
    const firstLine = ctx.split('\n')[0];
    expect(firstLine).toMatch(/\[artibot:effort level=\w+ command=\w+\]/);
    expect(firstLine).toMatch(/\[artibot:task-budget max_tokens=\d+\]/);
  });

  it('a non-slash prompt carries the auto-team hint in the SAME field', () => {
    const ctx = plain.parsed.hookSpecificOutput.additionalContext;
    expect(ctx).toContain('[auto-team-suggested]');
  });

  it('the router wrapper and the raw prompt are NOT echoed back', () => {
    for (const out of [slash.parsed, plain.parsed]) {
      const ctx = out.hookSpecificOutput.additionalContext;
      // `Original request:` framing is meaningless once the host sends the
      // prompt itself alongside the context (design E5).
      expect(ctx).not.toContain('Original request:');
      expect(ctx).not.toContain('System 1 mode:');
      expect(ctx).not.toContain('System 2 mode:');
    }
  });

  it('stdout stays under the host 10,000 B spill threshold', () => {
    for (const [label, out] of [['slash', slash], ['plain', plain]]) {
      const bytes = Buffer.byteLength(out.raw, 'utf-8');
      expect(bytes, `${label} stdout bytes=${bytes}`).toBeLessThan(HOST_SPILL_THRESHOLD_BYTES);
    }
  });
});
