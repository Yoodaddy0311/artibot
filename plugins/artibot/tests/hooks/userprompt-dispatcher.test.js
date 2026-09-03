import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * UserPromptSubmit dispatcher integration tests.
 *
 * The dispatcher is exec'd as a child process so we exercise the same code
 * path that hooks.json uses (single node entry, stdin JSON in, stdout JSON
 * out). Unit-level tests for `mergeHookResults` cover the merging logic.
 *
 * `git-autopilot-save` is one of the 7 hooks this slot fans out to, and it is
 * the reason `cwd` is redirected to a throwaway NON-git directory.
 *
 * A previous version of this comment claimed the child "returns immediately
 * without touching git ... the same path users hit in non-allowlisted repos".
 * That was wrong: `isAutopilotAllowed()` resolves this repo's remote
 * (`Yoodaddy0311/artibot`) and returns TRUE — it IS allowlisted. The only thing
 * holding git writes back was `.git/autopilot.json` `enabled:false`, a mutable
 * runtime flag that `/autopilot` setup rewrites. With it flipped, this suite
 * would drive the semantic strategy's `git stash` against a shared worktree.
 *
 * There is no env kill switch for the git hooks — neither references
 * `process.env` at all — so cwd is the only lever. From a non-repo cwd,
 * `getRepoRoot()` returns null and the hook returns at
 * git-autopilot-save.js:318, before the allowlist and config gates are reached.
 *
 * That covers the SPAWN vector, and still does: the dispatcher launches real
 * child processes, which no import-time guard can reach. The separate IMPORT
 * vector — a test importing the hook module and running its top-level body — is
 * now closed by the direct-run guard in git-autopilot-save.js. The two cover
 * different entry points; neither makes the other redundant.
 *
 * Verified equivalent, not assumed: every payload below was diffed between
 * cwd=PLUGIN_ROOT and cwd=<non-repo>; output was identical, including
 * `additionalContext` byte-for-byte (263 chars for the ambiguity-guard case).
 */

const PLUGIN_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..',
);
const SCRIPT_PATH = path.join(PLUGIN_ROOT, 'scripts', 'hooks', '_userprompt-dispatcher.js');

/** Throwaway home and working directory for the spawned dispatcher. */
let sandboxHome;
let sandboxCwd;
let sandboxRoot;

/**
 * SETUP-ONLY ISOLATION (assertions and fixtures are untouched).
 *
 * This suite already redirected HOME and cwd, but still passed the REAL
 * `CLAUDE_PLUGIN_ROOT` — the blind spot the note above `runDispatcher` records.
 * So every run mutated the developer's live `runtime/`: `token-usage-session
 * .json` each time, and a line in the real decision store that
 * `/doctor` reads once the recorder-stats flush landed. Writing fixture data
 * into the store a health check reads is worse than recording nothing.
 *
 * The sandbox LINKS the real `lib/`, `commands/`, `skills/` and `agents/` and
 * copies the real `artibot.config.json`, so the dispatcher still resolves the
 * REAL modules and config and the exercised path is unchanged. Only the
 * writable `runtime/` directory is redirected. `SCRIPT_PATH` still points at the
 * real dispatcher — the script under test is not a copy.
 */
beforeAll(() => {
  sandboxHome = mkdtempSync(path.join(tmpdir(), 'artibot-userprompt-home-'));
  sandboxCwd = mkdtempSync(path.join(tmpdir(), 'artibot-userprompt-cwd-'));
  sandboxRoot = mkdtempSync(path.join(tmpdir(), 'artibot-userprompt-root-'));
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
  if (sandboxHome) rmSync(sandboxHome, { recursive: true, force: true });
  if (sandboxCwd) rmSync(sandboxCwd, { recursive: true, force: true });
  if (sandboxRoot) rmSync(sandboxRoot, { recursive: true, force: true });
});

function runDispatcher(payload, env = {}) {
  const stdout = execFileSync(
    process.execPath,
    [SCRIPT_PATH],
    {
      cwd: sandboxCwd,
      env: {
        ...process.env,
        CLAUDE_PLUGIN_ROOT: sandboxRoot,
        // Disable downstream side-effects that would otherwise touch
        // network / disk / runtime caches during the test run.
        // getHomeDir() reads USERPROFILE then HOME — both must point at the
        // sandbox or the real learning store gets the fixtures.
        USERPROFILE: sandboxHome,
        HOME: sandboxHome,
        ARTIBOT_RUNTIME_CHECKPOINT_DISABLE: '1',
        ARTIBOT_RUNTIME_MEMORY_DISABLE: '1',
        ...env,
      },
      input: JSON.stringify(payload),
      encoding: 'utf-8',
      timeout: 20000,
    },
  ).trim();
  return stdout ? JSON.parse(stdout) : null;
}

describe('_userprompt-dispatcher (integration)', () => {
  it('emits at most a pass-through envelope when stdin payload is empty', () => {
    const out = runDispatcher({});
    // ambiguity-guard always returns { continue: true } even on empty input,
    // so the merged output is either null or a no-op pass-through. No
    // user_prompt rewriting and no additionalContext should be present.
    if (out !== null) {
      expect(out.user_prompt).toBeUndefined();
      expect(out.hookSpecificOutput).toBeUndefined();
    }
  });

  it('emits a single merged JSON object for an ordinary prompt', () => {
    const out = runDispatcher({ user_prompt: 'fix typo in readme' });
    expect(out).not.toBeNull();
    // runtime-prompt always contributes user_prompt for non-empty input.
    expect(typeof out.user_prompt).toBe('string');
    expect(out.user_prompt.length).toBeGreaterThan(0);
  });

  // 호스트 2.1.259 스키마 형태 — 회귀 방지.
  // 이 파일의 다른 케이스는 전부 `user_prompt` 를 심어 디스패처의 내부 계약(리라이터가
  // 이미 쓴 상태)을 재현한다. 그 계약도 여전히 유효하므로 지우지 않았고, 대신 호스트가
  // 실제로 보내는 형태를 한 건 추가한다 — 라이브에서 전 체인이 죽어 있던 그 형태다.
  it('drives the whole chain from the host `prompt` key alone (no user_prompt)', () => {
    const out = runDispatcher({
      hook_event_name: 'UserPromptSubmit',
      prompt: '!rv check the auth module',
      session_id: '9120048e-3385-4855-a35b-09c89e5dd684',
    });
    expect(out).not.toBeNull();
    // 리라이터가 호스트 `prompt` 를 읽어야만 이 봉투가 만들어진다.
    expect(out.user_prompt).toMatch(/CRITICAL RE-VERIFICATION MODE/);
  });

  it('rewrites !rv prompts via user-prompt-handler before parallel hooks see them', () => {
    const out = runDispatcher({ user_prompt: '!rv check the auth module' });
    expect(out).not.toBeNull();
    // user-prompt-handler rewrote into the CRITICAL RE-VERIFICATION envelope.
    expect(out.user_prompt).toMatch(/CRITICAL RE-VERIFICATION MODE/);
    // runtime-prompt, in turn, prefixed/appended runtime envelope content.
    // (It composed on top of the rewriter's output — confirms the ordering.)
  });

  it('strips --no-team flag from the prompt', () => {
    const out = runDispatcher({ user_prompt: 'implement feature --no-team' });
    expect(out).not.toBeNull();
    // user-prompt-handler stripped --no-team. runtime-prompt then rebuilt the
    // user_prompt envelope, but the underlying prompt no longer contains
    // --no-team.
    expect(out.user_prompt).not.toMatch(/--no-team/);
  });

  // 호스트 2.1.259 스키마 형태 — 회귀 방지.
  // --no-team 옵트아웃이 리라이터에 의해 무력화되지 않는지. 이 결함은 오직 체인
  // 전체를 돌릴 때만 보인다: 리라이터가 플래그를 제거한 뒤 `payload.user_prompt`
  // 에 제거본을 넣고, auto-team-trigger 가 그 제거본을 1순위로 읽기 때문이다.
  // 핸들러 단독 테스트는 리라이터를 거치지 않으므로 이 결함을 절대 못 잡는다.
  it('--no-team survives the rewriter: auto-team must not fire from the host prompt', () => {
    const out = runDispatcher({
      hook_event_name: 'UserPromptSubmit',
      // 옵트아웃이 없었다면 auto-team 이 반드시 발화하는 프롬프트(3도메인·다중동사).
      prompt: '프론트와 백엔드 시스템을 마이그레이션하고 테스트도 추가해줘 --no-team',
      session_id: '9120048e-3385-4855-a35b-09c89e5dd684',
    });
    expect(out).not.toBeNull();
    // 리라이터는 플래그를 제거한다(디스패처 계약 — 유지).
    expect(out.user_prompt).not.toMatch(/--no-team/);
    // 그러나 옵트아웃은 살아 있어야 한다.
    const ctx = out.hookSpecificOutput?.additionalContext || '';
    expect(ctx).not.toContain('[auto-team-suggested]');
  });

  // 대조군: 같은 프롬프트에서 플래그만 빼면 반드시 발화해야 한다.
  // 이게 없으면 위 케이스는 "그냥 아무것도 발화 안 함"으로도 통과해 버린다.
  it('control: the same prompt WITHOUT --no-team does fire auto-team', () => {
    const out = runDispatcher({
      hook_event_name: 'UserPromptSubmit',
      prompt: '프론트와 백엔드 시스템을 마이그레이션하고 테스트도 추가해줘',
      session_id: '9120048e-3385-4855-a35b-09c89e5dd684',
    });
    expect(out).not.toBeNull();
    const ctx = out.hookSpecificOutput?.additionalContext || '';
    expect(ctx).toContain('[auto-team-suggested]');
  });

  it('flags short destructive prompts via ambiguity-guard additionalContext', () => {
    const out = runDispatcher({ user_prompt: 'delete it' });
    expect(out).not.toBeNull();
    const ctx = out.hookSpecificOutput?.additionalContext || '';
    expect(ctx).toContain('ambiguity-guard');
  });

  it('respects ARTIBOT_DISABLE_DISPATCHER=1 (no-op)', () => {
    const out = runDispatcher(
      { user_prompt: 'this would normally trigger several hooks' },
      { ARTIBOT_DISABLE_DISPATCHER: '1' },
    );
    expect(out).toBeNull();
  });

  it('finishes within the 8000ms hooks.json timeout for typical prompts', () => {
    const start = Date.now();
    runDispatcher({ user_prompt: 'add a small comment to lib/index.js' });
    const elapsed = Date.now() - start;
    // Generous bound — the spec'd timeout is 8000ms, so we assert well under.
    expect(elapsed).toBeLessThan(15000);
  });

  /**
   * Isolation self-check.
   *
   * The blind spot this note used to record — `CLAUDE_PLUGIN_ROOT` pointing at
   * the real plugin, so `runtime-prompt` kept writing
   * `plugins/artibot/runtime/*.json` in the repo — is CLOSED: the env now names
   * the linked sandbox root (see the beforeAll above). Being gitignored was
   * never the whole test: `runtime/decisions/` is what `/doctor` reads to decide
   * whether recording is alive, so fixture lines there corrupt a health signal
   * without ever dirtying git.
   */
  it('keeps every side effect inside the sandbox', () => {
    // Structural proof the git path is shut, independent of the mutable
    // `.git/autopilot.json` `enabled` flag: the hooks find the repo from cwd,
    // and there is no repo here.
    expect(() => execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: sandboxCwd, stdio: ['pipe', 'pipe', 'pipe'],
    })).toThrow();

    // Canary: this slot writes no learning store today. A future hook that does
    // will trip this in a temp dir rather than in the developer's real store.
    expect(existsSync(path.join(sandboxHome, '.claude'))).toBe(false);
  });
});

describe('mergeHookResults (unit)', () => {
  it('returns null when no contributors produced anything', async () => {
    const { mergeHookResults } = await import('../../scripts/hooks/_userprompt-dispatcher.js');
    expect(mergeHookResults(null, [])).toBeNull();
    expect(mergeHookResults(null, [{ status: 'fulfilled', value: null }])).toBeNull();
  });

  it('preserves the rewriter user_prompt and message', async () => {
    const { mergeHookResults } = await import('../../scripts/hooks/_userprompt-dispatcher.js');
    const merged = mergeHookResults(
      { user_prompt: 'rewritten', message: '[trigger] applied' },
      [],
    );
    expect(merged.user_prompt).toBe('rewritten');
    expect(merged.message).toBe('[trigger] applied');
  });

  it('concatenates additionalContext from every fulfilled contributor', async () => {
    const { mergeHookResults } = await import('../../scripts/hooks/_userprompt-dispatcher.js');
    const merged = mergeHookResults(null, [
      {
        status: 'fulfilled',
        value: {
          hookSpecificOutput: {
            hookEventName: 'UserPromptSubmit',
            additionalContext: 'first',
          },
        },
      },
      {
        status: 'fulfilled',
        value: {
          hookSpecificOutput: {
            hookEventName: 'UserPromptSubmit',
            additionalContext: 'second',
          },
        },
      },
    ]);
    expect(merged.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    expect(merged.hookSpecificOutput.additionalContext).toBe('first\n\nsecond');
  });

  it('ignores rejected contributors without breaking', async () => {
    const { mergeHookResults } = await import('../../scripts/hooks/_userprompt-dispatcher.js');
    const merged = mergeHookResults(null, [
      { status: 'rejected', reason: new Error('boom') },
      {
        status: 'fulfilled',
        value: {
          hookSpecificOutput: {
            hookEventName: 'UserPromptSubmit',
            additionalContext: 'survived',
          },
        },
      },
    ]);
    expect(merged.hookSpecificOutput.additionalContext).toBe('survived');
  });
});

describe('dispatcher writes a single newline-free JSON document to stdout', () => {
  it('emits exactly one JSON object (not NDJSON)', async () => {
    // We capture raw stdout (no JSON.parse) to verify there is at most one
    // JSON object — multiple writes would break Claude Code's hook protocol.
    const raw = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [SCRIPT_PATH], {
        // `sandboxCwd`, like `runDispatcher` — NOT PLUGIN_ROOT. This case only
        // inspects stdout shape, so the cwd is not load-bearing for it, but
        // since 2026-09-03 the decision store resolves from the PROJECT ROOT of
        // the cwd (`decision-events.js#getDecisionStoreDir`). Spawning from
        // PLUGIN_ROOT put this suite's recorder-stats line in the repository's
        // own store — the exact "fixture data in the store /doctor reads"
        // failure this file's header says it exists to avoid.
        cwd: sandboxCwd,
        env: {
          ...process.env,
          CLAUDE_PLUGIN_ROOT: sandboxRoot,
          ARTIBOT_RUNTIME_CHECKPOINT_DISABLE: '1',
          ARTIBOT_RUNTIME_MEMORY_DISABLE: '1',
        },
        stdio: ['pipe', 'pipe', 'inherit'],
        windowsHide: true,
      });
      const chunks = [];
      child.stdout.on('data', (c) => chunks.push(c));
      child.on('exit', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      child.on('error', reject);
      child.stdin.end(JSON.stringify({ user_prompt: 'fix a small bug' }));
    });
    // Exactly zero or one newline-separated JSON document.
    const trimmed = raw.trim();
    if (trimmed.length === 0) return; // permissible: hook chose to pass through
    // Should parse as a single JSON value.
    expect(() => JSON.parse(trimmed)).not.toThrow();
  });
});
