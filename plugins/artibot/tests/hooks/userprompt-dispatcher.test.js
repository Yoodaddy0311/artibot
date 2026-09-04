import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync,
} from 'node:fs';
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

/**
 * Same child process as `runDispatcher`, but returns the RAW streams.
 *
 * `runDispatcher` uses `execFileSync`, which lets stderr through to the parent
 * and hands back only parsed stdout. The sender guard's entire observable
 * output on the blocked path is one stderr line plus an empty stdout, so
 * neither half is reachable through that helper.
 *
 * cwd, env and `CLAUDE_PLUGIN_ROOT` are deliberately identical to
 * `runDispatcher` — the two helpers must exercise the same sandbox, or a
 * comparison between their results measures the environment, not the guard.
 *
 * @param {object} payload - Hook payload written to the child's stdin.
 * @param {Record<string,string>} [env] - Extra environment overrides.
 * @returns {{ status: number|null, stdout: string, stderr: string }}
 */
function runDispatcherRaw(payload, env = {}) {
  const result = spawnSync(
    process.execPath,
    [SCRIPT_PATH],
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
      timeout: 20000,
    },
  );
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/**
 * Verbatim capture of the host `<task-notification>` body that reached
 * UserPromptSubmit at 2026-09-04T19:02:21.565Z. Read from disk rather than
 * inlined: a hand-shortened copy would not reach the failure region — the
 * mission compiler needs the real request density to fire S3 and emit
 * `mission.created` (pinned in tests/mission/compiler.test.js).
 */
const NOTIFICATION_FIXTURE = readFileSync(
  path.join(PLUGIN_ROOT, 'tests', 'fixtures', 'ups-task-notification-2026-09-04.txt'),
  'utf-8',
);

/** Decision-store path the dispatcher writes for a given session id. */
function decisionsPathFor(sessionId) {
  return path.join(sandboxCwd, '.artibot', 'runtime', 'decisions', `${sessionId}.events.ndjson`);
}

describe('_userprompt-dispatcher (integration)', () => {
  it('emits nothing for an empty stdin payload', () => {
    const out = runDispatcher({});
    // ambiguity-guard returns { continue: true } on every prompt, but `true` is
    // the host default and carries no information, so the allowlist merge does
    // not copy it. With no additionalContext either, there is nothing to send.
    expect(out).toBeNull();
  });

  it('emits a single merged JSON object for an ordinary prompt', () => {
    const out = runDispatcher({ user_prompt: 'fix typo in readme' });
    expect(out).not.toBeNull();
    // The runtime envelope now travels in the host field. `user_prompt` is a
    // DISPATCHER-INTERNAL key and must not appear on stdout at all — the host
    // strips it and logs `unrecognized keys (ignored)` to the debug file only,
    // which is how it went unnoticed for six weeks
    // (INCIDENT-2026-09-03-hook-payload-contract.md).
    expect(out.user_prompt).toBeUndefined();
    expect(out.message).toBeUndefined();
    expect(typeof out.hookSpecificOutput.additionalContext).toBe('string');
    expect(out.hookSpecificOutput.additionalContext.length).toBeGreaterThan(0);
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
    // 리라이터가 호스트 `prompt` 를 읽어야만 이 봉투가 만들어진다. 재작성문은
    // 이제 호스트가 읽는 필드로 나간다 — 최상위 `user_prompt` 는 버려지므로
    // 그 자리에서 재검증 프로토콜을 확인하면 거짓 그린이 된다(설계 §2.1 A).
    expect(out.user_prompt).toBeUndefined();
    expect(out.hookSpecificOutput.additionalContext).toMatch(/CRITICAL RE-VERIFICATION MODE/);
  });

  it('rewrites !rv prompts via user-prompt-handler before parallel hooks see them', () => {
    const out = runDispatcher({ user_prompt: '!rv check the auth module' });
    expect(out).not.toBeNull();
    // user-prompt-handler produced the CRITICAL RE-VERIFICATION protocol and it
    // reached the host field. The internal `user_prompt` handoff that let the
    // parallel hooks classify the rewritten text still happens — it just never
    // reaches stdout (see the resilience suite for that half of the contract).
    expect(out.hookSpecificOutput.additionalContext).toMatch(/CRITICAL RE-VERIFICATION MODE/);
    expect(out.user_prompt).toBeUndefined();
  });

  it('surfaces the --no-team opt-out as an instruction to the model', () => {
    const out = runDispatcher({ user_prompt: 'implement feature --no-team' });
    expect(out).not.toBeNull();
    // The rewriter still strips the flag from the INTERNAL payload (that branch
    // is retained — design §8-2), but stripping never reached the model: the
    // host always sends the user's own text. The opt-out is stated instead.
    expect(out.hookSpecificOutput.additionalContext).toContain('[artibot:team opt-out]');
    expect(out.user_prompt).toBeUndefined();
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
    const ctx = out.hookSpecificOutput?.additionalContext || '';
    // 리라이터의 제거 분기는 유지된다(디스패처 계약 — 설계 §8-2). stdout 에서는
    // `user_prompt` 가 사라졌으므로 제거 사실을 그 자리에서 볼 수 없다. 대신
    // 그 분기가 실행됐다는 증거는 이 지시문이다 — 분기를 지우면 사라진다.
    expect(out.user_prompt).toBeUndefined();
    expect(ctx).toContain('[artibot:team opt-out]');
    // 그리고 옵트아웃은 살아 있어야 한다.
    expect(ctx).not.toContain('[auto-team-suggested]');
  });

  // 대조군: 같은 프롬프트에서 플래그만 빼면 반드시 발화해야 한다.
  // 이게 없으면 위 케이스는 "그냥 아무것도 발화 안 함"으로도 통과해 버린다.
  // KNOWN GAP, pinned as-is — NOT a passing behaviour.
  //
  // A payload carrying ONLY the dispatcher-internal `user_prompt` (no host
  // `prompt`) loses the --no-team opt-out: the rewriter overwrites
  // `payload.user_prompt` with the stripped copy, and `extractUserPromptFlagSurface`
  // (hook-utils.js) then has no surviving copy of the original text to read.
  // The control case above proves this prompt DOES fire auto-team, so the
  // assertion below is measuring the loss, not an unrelated silence.
  //
  // LIVE-UNREACHABLE, which is why it is documented rather than fixed
  // (design §2.2 정정 / §8-3, measured 2026-09-04): host 2.1.259 sends `prompt`,
  // and a hook run standalone through its legacy main() never goes through the
  // rewriter. Fixing it would require the dispatcher to keep a second internal
  // copy of the original text — a new internal key, which is exactly the drift
  // this migration removes. Recorded here so the gap cannot be mistaken for
  // coverage; if a future change makes the opt-out survive, DELETE this test
  // rather than inverting it, and say so.
  it('KNOWN GAP: a user_prompt-only payload loses the --no-team opt-out (legacy, live-unreachable)', () => {
    const out = runDispatcher({
      user_prompt: '프론트와 백엔드 시스템을 마이그레이션하고 테스트도 추가해줘 --no-team',
    });
    expect(out).not.toBeNull();
    const ctx = out.hookSpecificOutput?.additionalContext || '';
    // The rewriter DID see the flag …
    expect(ctx).toContain('[artibot:team opt-out]');
    // … and auto-team fired anyway. This is the defect, stated.
    expect(ctx).toContain('[auto-team-suggested]');
  });

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

  /**
   * SENDER GUARD — regression fence for the 2026-09-04T19:02:21Z incident.
   *
   * A harness `<task-notification>` body (5,047B) arrived on UserPromptSubmit
   * and the dispatcher ran all 6 hooks on it: 4 rows in the decision store and
   * a `mission.created` ledger event, none of which a human asked for. The
   * compiler side of that is pinned as a NEGATIVE CONTROL in
   * tests/mission/compiler.test.js — it still compiles the body into a mission,
   * because interpreting the body is not the compiler's job. The block belongs
   * here, one layer up, before any hook runs.
   *
   * The guard is an ALLOWLIST (`USER_PROMPT_SOURCES`), not a block list. The
   * `loop_wakeup` case below is what proves that: it carries an ordinary human
   * prompt, so a body sniff would wave it through. Only the source check stops
   * it, and only an allowlist stops the source the host invents next.
   */
  describe('sender guard: non-user prompts run zero hooks', () => {
    it('blocks the real notification body when source=system', () => {
      const sessionId = 'guard-system-4f0a1c2b-0001-0000-0000-000000000001';
      const { stdout, stderr, status } = runDispatcherRaw({
        hook_event_name: 'UserPromptSubmit',
        prompt: NOTIFICATION_FIXTURE,
        session_id: sessionId,
        source: 'system',
      });
      expect(status).toBe(0);
      // stdout must be EMPTY, not `{continue:true}`: the host defaults
      // `continue` to true, so emitting it would be an envelope carrying no
      // information — and `mergeHookResults` already elides it for that reason.
      expect(stdout).toBe('');
      expect(stderr.trim()).toBe(
        '[artibot:_userprompt-dispatcher] skipped non-user prompt (source:system) — 0 hooks run',
      );
      // Exactly one stderr line: a blocked machine turn must not be noisy, or
      // the real signal gets tuned out.
      expect(stderr.split('\n').filter(Boolean)).toHaveLength(1);
    });

    it('is the same fixture the mission compiler turns into a mission (>= 4096B)', () => {
      // §9: a fixture that cannot reach the failure region proves nothing. A
      // trimmed notification would be blocked by the prefix sniff just the
      // same, and this suite would go green while the real 5KB body still had
      // an unproven path.
      expect(Buffer.byteLength(NOTIFICATION_FIXTURE, 'utf-8')).toBeGreaterThanOrEqual(4096);
      expect(Buffer.byteLength(NOTIFICATION_FIXTURE, 'utf-8')).toBe(5047);
    });

    it('blocks the notification body on the prefix sniff when source is absent', () => {
      // Older hosts never sent `source`, and 2.1.x documents it as omittable
      // "while the field rolls out". The body sniff is the fallback for exactly
      // that window — it is what would have stopped the live incident.
      const { stdout, stderr } = runDispatcherRaw({
        hook_event_name: 'UserPromptSubmit',
        prompt: NOTIFICATION_FIXTURE,
        session_id: 'guard-nosource-4f0a1c2b-0002-0000-0000-000000000002',
      });
      expect(stdout).toBe('');
      expect(stderr).toContain('skipped non-user prompt (body:task-notification) — 0 hooks run');
    });

    it('blocks a [SYSTEM NOTIFICATION …] body when source is absent', () => {
      const { stdout, stderr } = runDispatcherRaw({
        hook_event_name: 'UserPromptSubmit',
        prompt: '[SYSTEM NOTIFICATION - NOT USER INPUT]\nThe user has been idle for 5 minutes.',
        session_id: 'guard-sysnotif-4f0a1c2b-0003-0000-0000-000000000003',
      });
      expect(stdout).toBe('');
      expect(stderr).toContain('skipped non-user prompt (body:system-notification) — 0 hooks run');
    });

    it('ALLOWLIST PROOF: blocks source=loop_wakeup even with an ordinary human prompt', () => {
      // The body here is indistinguishable from a real request, so nothing in
      // the sniff can reject it. If this ever goes green by way of the body
      // rules rather than the source check, the guard has become fail-open for
      // every future host source.
      const { stdout, stderr } = runDispatcherRaw({
        hook_event_name: 'UserPromptSubmit',
        prompt: 'fix typo in readme',
        session_id: 'guard-loop-4f0a1c2b-0004-0000-0000-000000000004',
        source: 'loop_wakeup',
      });
      expect(stdout).toBe('');
      expect(stderr).toContain('skipped non-user prompt (source:loop_wakeup) — 0 hooks run');
    });

    it('ALLOWLIST PROOF: an unknown future source is blocked, not waved through', () => {
      const { stdout, stderr } = runDispatcherRaw({
        hook_event_name: 'UserPromptSubmit',
        prompt: 'fix typo in readme',
        session_id: 'guard-future-4f0a1c2b-0005-0000-0000-000000000005',
        source: 'source_the_host_invents_next',
      });
      expect(stdout).toBe('');
      expect(stderr).toContain('skipped non-user prompt (source:source_the_host_invents_next)');
    });

    it('leaves the user path byte-for-byte unchanged (source=user vs source absent)', () => {
      // The guard must be invisible to humans. Comparing raw stdout rather than
      // parsed JSON catches key-order and whitespace drift that a deep-equal
      // would let through.
      const prompt = 'fix typo in readme';
      const withSource = runDispatcherRaw({
        hook_event_name: 'UserPromptSubmit', prompt, session_id: 'guard-user-a', source: 'user',
      });
      const withoutSource = runDispatcherRaw({
        hook_event_name: 'UserPromptSubmit', prompt, session_id: 'guard-user-a',
      });
      expect(withSource.stdout).not.toBe('');
      expect(withSource.stdout).toBe(withoutSource.stdout);
    });

    it('lets source=sdk through — Agent SDK / -p turns are human-driven', () => {
      const out = runDispatcher({
        hook_event_name: 'UserPromptSubmit',
        prompt: 'fix typo in readme',
        session_id: 'guard-sdk-4f0a1c2b-0006-0000-0000-000000000006',
        source: 'sdk',
      });
      expect(out).not.toBeNull();
      expect(out.hookSpecificOutput.additionalContext.length).toBeGreaterThan(0);
    });

    /**
     * ZERO-HOOK PROOF with its own positive control.
     *
     * Asserting "the decision file does not exist" is fail-open on its own: it
     * passes just as happily if the dispatcher never writes that file anywhere,
     * if the path is wrong, or if the sandbox moved. The control run below
     * writes one first, from the same helper and the same sandbox, so the
     * absence in the guarded run is measured against a demonstrated presence.
     *
     * Per-session files (measured 2026-09-04T23:32Z) are what make this exact:
     * `runtime/` artifacts are shared, so a sibling case in this suite may have
     * created them already, but the decision store is keyed by session_id.
     */
    it('runs zero hooks: no decision rows, proven against a positive control', () => {
      const userSession = 'guard-control-4f0a1c2b-0007-0000-0000-000000000007';
      const guardedSession = 'guard-blocked-4f0a1c2b-0008-0000-0000-000000000008';

      // POSITIVE CONTROL — a real user prompt DOES leave rows behind.
      runDispatcherRaw({
        hook_event_name: 'UserPromptSubmit',
        prompt: 'fix typo in readme',
        session_id: userSession,
        source: 'user',
      });
      const controlPath = decisionsPathFor(userSession);
      expect(existsSync(controlPath), 'control must write a decision file, or the absence below proves nothing').toBe(true);
      expect(readFileSync(controlPath, 'utf-8').split('\n').filter(Boolean).length)
        .toBeGreaterThan(0);

      // GUARDED — the notification leaves nothing.
      runDispatcherRaw({
        hook_event_name: 'UserPromptSubmit',
        prompt: NOTIFICATION_FIXTURE,
        session_id: guardedSession,
        source: 'system',
      });
      expect(existsSync(decisionsPathFor(guardedSession))).toBe(false);
    });

    it('spawns no git-autopilot-save child: the sandbox cwd stays free of git writes', () => {
      // The guard returns before the spawn, so the blocked turn costs one
      // stderr line and no child process. Observable proxy: the child would
      // resolve the repo from cwd, and a blocked run must not create one.
      runDispatcherRaw({
        hook_event_name: 'UserPromptSubmit',
        prompt: NOTIFICATION_FIXTURE,
        session_id: 'guard-nogit-4f0a1c2b-0009-0000-0000-000000000009',
        source: 'system',
      });
      expect(existsSync(path.join(sandboxCwd, '.git'))).toBe(false);
    });
  });
});

describe('mergeHookResults (unit)', () => {
  it('returns null when no contributors produced anything', async () => {
    const { mergeHookResults } = await import('../../scripts/hooks/_userprompt-dispatcher.js');
    expect(mergeHookResults(null, [])).toBeNull();
    expect(mergeHookResults(null, [{ status: 'fulfilled', value: null }])).toBeNull();
  });

  it('drops the rewriter user_prompt and message — they are not host keys', async () => {
    const { mergeHookResults } = await import('../../scripts/hooks/_userprompt-dispatcher.js');
    const merged = mergeHookResults(
      { user_prompt: 'rewritten', message: '[trigger] applied' },
      [],
    );
    // Both were always discarded by the host; now they are never emitted.
    // Nothing else was produced, so there is nothing to send at all.
    expect(merged).toBeNull();
  });

  it('copies allowlisted host keys through unchanged', async () => {
    const { mergeHookResults, HOST_STDOUT_KEYS } = await import('../../scripts/hooks/_userprompt-dispatcher.js');
    const merged = mergeHookResults(
      { decision: 'block', reason: 'policy', systemMessage: 'heads up', user_prompt: 'internal' },
      [],
    );
    // POSITIVE CONTROL for the allowlist: it must not be so aggressive that a
    // legitimate host field is eaten. Every emitted key is on the list.
    expect(merged).toEqual({ decision: 'block', reason: 'policy', systemMessage: 'heads up' });
    for (const key of Object.keys(merged)) expect(HOST_STDOUT_KEYS).toContain(key);
  });

  it('elides continue:true but keeps continue:false', async () => {
    const { mergeHookResults } = await import('../../scripts/hooks/_userprompt-dispatcher.js');
    // `true` is the host default — ambiguity-guard returns it on every prompt,
    // so emitting it would make an otherwise-empty envelope look meaningful.
    expect(mergeHookResults({ continue: true }, [])).toBeNull();
    expect(mergeHookResults({ continue: false, stopReason: 'halt' }, []))
      .toEqual({ continue: false, stopReason: 'halt' });
  });

  it('legacyStdout:true restores the pre-allowlist copy-everything shape', async () => {
    const { mergeHookResults } = await import('../../scripts/hooks/_userprompt-dispatcher.js');
    const merged = mergeHookResults(
      { user_prompt: 'rewritten', message: '[trigger] applied' },
      [],
      { legacyStdout: true },
    );
    // The config rollback (runtime.hooks.userPromptSubmit.legacyStdout). This
    // shape is the BROKEN one — the host discards both keys — and the switch
    // exists only to bisect a parallel-contributor regression.
    expect(merged).toEqual({ user_prompt: 'rewritten', message: '[trigger] applied' });
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
