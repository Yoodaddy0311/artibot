import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  defaultJudge,
  evaluatePermission,
  matchesAllowEntry,
} from '../../scripts/hooks/permission-auto-approve.js';

/** Plugin root — `executeChain` only runs `artibot-policy` guards inside it. */
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK_PATH = path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'permission-auto-approve.js');

/** Assembled so the literal never appears in a Bash command this repo guards. */
const FORCE_PUSH = `git push --${'force'} origin main`;
const LEASE_PUSH = `git push --${'force'}-with-lease origin main`;

describe('matchesAllowEntry/edge cases', () => {
  it('null entry → false', () => {
    expect(matchesAllowEntry(null, 'Bash', {})).toBe(false);
  });

  it('non-object entry → false', () => {
    expect(matchesAllowEntry('Bash', 'Bash', {})).toBe(false);
    expect(matchesAllowEntry(42, 'Bash', {})).toBe(false);
  });

  it('빈 entry {} → 모두 매치 (와일드카드)', () => {
    expect(matchesAllowEntry({}, 'Bash', {})).toBe(true);
    expect(matchesAllowEntry({}, 'Edit', { file_path: '/tmp/x' })).toBe(true);
  });
});

describe('matchesAllowEntry/tool matching', () => {
  it('정확한 tool 매치', () => {
    expect(matchesAllowEntry({ tool: 'Bash' }, 'Bash', {})).toBe(true);
    expect(matchesAllowEntry({ tool: 'Bash' }, 'Edit', {})).toBe(false);
  });

  it('와일드카드 tool=*', () => {
    expect(matchesAllowEntry({ tool: '*' }, 'Bash', {})).toBe(true);
    expect(matchesAllowEntry({ tool: '*' }, 'Read', {})).toBe(true);
  });
});

describe('matchesAllowEntry/regex command match', () => {
  it('regex 매치 → true', () => {
    const e = { tool: 'Bash', commandPattern: '^npm (install|test)' };
    expect(matchesAllowEntry(e, 'Bash', { command: 'npm test' })).toBe(true);
    expect(matchesAllowEntry(e, 'Bash', { command: 'npm install' })).toBe(true);
  });

  it('regex 미매치 → false', () => {
    const e = { tool: 'Bash', commandPattern: '^npm test$' };
    expect(matchesAllowEntry(e, 'Bash', { command: 'rm -rf /' })).toBe(false);
  });

  it('Edit 도구는 file_path로 매치', () => {
    const e = { tool: 'Edit', commandPattern: '\\.test\\.js$' };
    expect(matchesAllowEntry(e, 'Edit', { file_path: 'x.test.js' })).toBe(true);
    expect(matchesAllowEntry(e, 'Edit', { file_path: 'x.js' })).toBe(false);
  });

  it('잘못된 regex 패턴 → false (안전 fallback)', () => {
    const e = { tool: 'Bash', commandPattern: '[invalid(' };
    expect(matchesAllowEntry(e, 'Bash', { command: 'anything' })).toBe(false);
  });

  it('command/file_path 둘 다 없음 → 빈 문자열로 처리, 패턴 미매치', () => {
    const e = { tool: 'Bash', commandPattern: '.+' };
    expect(matchesAllowEntry(e, 'Bash', {})).toBe(false);
  });

  it('non-string command → false', () => {
    const e = { tool: 'Bash', commandPattern: '.+' };
    expect(matchesAllowEntry(e, 'Bash', { command: 123 })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Danger filter — allowlist match is necessary but no longer sufficient.
// ---------------------------------------------------------------------------

describe('evaluatePermission/danger filter (pure, judge injected)', () => {
  it('와일드카드 allowlist 라도 파괴적 명령은 보류 (defaultJudge)', () => {
    const out = evaluatePermission({
      toolName: 'Bash',
      toolInput: { command: FORCE_PUSH },
      allowlist: [{ tool: '*' }],
    });
    expect(out.decision).toBeNull();
    expect(out.withheld?.kind).toBe('destructive');
    expect(out.withheld?.reason).toContain('dangerous-command');
  });

  it('안전한 명령이 패턴에 매치되면 allow', () => {
    const out = evaluatePermission({
      toolName: 'Bash',
      toolInput: { command: 'git status' },
      allowlist: [{ tool: 'Bash', commandPattern: '^git status' }],
    });
    expect(out.decision).toBe('allow');
    expect(out.withheld).toBeUndefined();
  });

  it('judge 가 throw 하면 fail-closed — 결정 없음, kind judge-error', () => {
    const out = evaluatePermission(
      {
        toolName: 'Bash',
        toolInput: { command: 'git status' },
        allowlist: [{ tool: '*' }],
      },
      {
        judge: () => {
          throw new Error('judge exploded');
        },
      },
    );
    expect(out.decision).toBeNull();
    expect(out.withheld?.kind).toBe('judge-error');
    expect(out.withheld?.reason).toContain('judge exploded');
  });

  it('allowlist 미매치면 judge 를 호출조차 하지 않는다', () => {
    let calls = 0;
    const out = evaluatePermission(
      {
        toolName: 'Bash',
        toolInput: { command: 'npm test' },
        allowlist: [{ tool: 'Bash', commandPattern: '^git status' }],
      },
      {
        judge: () => {
          calls += 1;
          return null;
        },
      },
    );
    expect(out.decision).toBeNull();
    expect(out.withheld).toBeUndefined();
    expect(calls).toBe(0);
  });

  it('빈 allowlist → 결정 없음 (기본 OFF 불변)', () => {
    const out = evaluatePermission({
      toolName: 'Bash',
      toolInput: { command: 'git status' },
      allowlist: [],
    });
    expect(out.decision).toBeNull();
    expect(out.withheld).toBeUndefined();
  });
});

describe('evaluatePermission/합집합이 실제로 작동한다는 증거', () => {
  // 측정 2026-09-10: blocked-patterns 는 --force-with-lease 를 exempt 하고
  // safety.js#classifyRisk 는 danger(git-force-push) 로 본다. 한쪽만 잡는다.
  it('safety.js 만 잡는 케이스 → 보류 (blocked-patterns 는 approve)', () => {
    const out = evaluatePermission({
      toolName: 'Bash',
      toolInput: { command: LEASE_PUSH },
      allowlist: [{ tool: '*' }],
    });
    expect(out.decision).toBeNull();
    expect(out.withheld?.kind).toBe('destructive');
    expect(out.withheld?.reason).toContain('git-force-push');
  });

  // 측정 2026-09-10: 반대 방향. blocked-patterns 는 block, classifyRisk 는 safe.
  it('blocked-patterns 만 잡는 케이스 → 보류 (classifyRisk 는 safe)', () => {
    const out = evaluatePermission({
      toolName: 'Bash',
      toolInput: { command: 'dd if=/dev/zero of=/dev/sda' },
      allowlist: [{ tool: '*' }],
    });
    expect(out.decision).toBeNull();
    expect(out.withheld?.kind).toBe('destructive');
  });

  it('두 정본 모두 통과하는 명령만 allow 로 남는다', () => {
    expect(defaultJudge({ toolName: 'Bash', toolInput: { command: 'npm test' } })).toBeNull();
    expect(defaultJudge({ toolName: 'Bash', toolInput: { command: FORCE_PUSH } })).not.toBeNull();
  });
});

describe('defaultJudge/판정은 명령 문자열만 본다 (cwd 비의존)', () => {
  it('판정기는 cwd 인자를 받지 않는다 — 서명에 없다', () => {
    // 두 정본 모두 동기 정규식 매처라 타임아웃 축도 없다.
    expect(defaultJudge.length).toBe(1);
    const call = { toolName: 'Bash', toolInput: { command: FORCE_PUSH } };
    expect(defaultJudge(call)).toEqual(defaultJudge(call));
  });

  it('process.cwd() 를 리포 밖으로 옮겨도 같은 판정', () => {
    // 유닛(리포 cwd)과 스폰(mkdtemp cwd) 양쪽에서 같은 명령이 보류되는 것은
    // 아래 스폰 스위트가 덮는다. 여기서는 같은 프로세스에서 직접 흔든다.
    const original = process.cwd();
    const before = defaultJudge({ toolName: 'Bash', toolInput: { command: FORCE_PUSH } });
    try {
      process.chdir(tmpdir());
      const after = defaultJudge({ toolName: 'Bash', toolInput: { command: FORCE_PUSH } });
      expect(after).toEqual(before);
      expect(after?.kind).toBe('destructive');
    } finally {
      process.chdir(original);
    }
  });

  it('연속 호출해도 가드 중복 등록으로 판정이 흔들리지 않는다', () => {
    const call = { toolName: 'Bash', toolInput: { command: 'npm test' } };
    expect(defaultJudge(call)).toBeNull();
    expect(defaultJudge(call)).toBeNull();
    expect(defaultJudge(call)).toBeNull();
  });
});

describe('evaluatePermission/이 필터가 못 보는 것 (알려진 구멍을 고정한다)', () => {
  // 측정 2026-09-10: pre/Write 가드(sensitive-file·content-secret)는
  // artibot-policy 라 executeChain 이 플러그인 리포 밖 cwd 에서 건너뛴다.
  // cwd 에 따라 답이 달라지는 판정은 판정이 아니므로 Bash 만 거른다.
  // 이 테스트는 통과를 자랑하는 게 아니라 구멍의 현재 크기를 못박는다.
  it('Write .env 는 allowlist 매치 시 필터 없이 allow (후속 결정)', () => {
    const out = evaluatePermission({
      toolName: 'Write',
      toolInput: { file_path: '.env', content: 'X=1' },
      allowlist: [{ tool: '*' }],
    });
    expect(out.decision).toBe('allow');
    expect(out.withheld).toBeUndefined();
  });

  it('Bash 가 아닌 도구는 judge 가 즉시 null 을 낸다', () => {
    expect(defaultJudge({ toolName: 'Write', toolInput: { file_path: '.env' } })).toBeNull();
    expect(defaultJudge({ toolName: 'Edit', toolInput: { file_path: 'id_rsa' } })).toBeNull();
    expect(defaultJudge({ toolName: 'Read', toolInput: { file_path: 'a.js' } })).toBeNull();
  });

  it('command 가 없거나 문자열이 아닌 Bash 는 판정 불가 → allow', () => {
    expect(defaultJudge({ toolName: 'Bash', toolInput: {} })).toBeNull();
    expect(defaultJudge({ toolName: 'Bash', toolInput: { command: 123 } })).toBeNull();
  });
});

describe('permission-auto-approve 훅 스폰 (실제 자식 프로세스)', () => {
  let sandbox;

  /**
   * Run the real hook in a throwaway plugin root so the repo's own
   * artibot.config.json is never read or written.
   * @param {object[]} autoApprove
   * @param {object} payload
   * @returns {{status: number|null, stdout: string, stderr: string}}
   */
  function runHook(autoApprove, payload) {
    writeFileSync(
      path.join(sandbox, 'artibot.config.json'),
      JSON.stringify({ permissions: { autoApprove } }),
      'utf-8',
    );
    const res = spawnSync(process.execPath, [HOOK_PATH], {
      cwd: sandbox,
      env: {
        ...process.env,
        CLAUDE_PLUGIN_ROOT: sandbox,
        HOME: sandbox,
        USERPROFILE: sandbox,
      },
      input: JSON.stringify(payload),
      encoding: 'utf-8',
    });
    return { status: res.status, stdout: res.stdout, stderr: res.stderr };
  }

  beforeAll(() => {
    sandbox = mkdtempSync(path.join(tmpdir(), 'artibot-autoapprove-'));
  });

  afterAll(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('와일드카드 + 파괴적 명령 → stdout 0바이트, stderr 보류 1줄, exit 0', () => {
    const r = runHook([{ tool: '*' }], {
      tool_name: 'Bash',
      tool_input: { command: FORCE_PUSH },
      cwd: sandbox,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('auto-approve withheld: destructive');
    expect(r.stderr.trim().split('\n')).toHaveLength(1);
  });

  it('안전 명령 + 패턴 매치 → allow 봉투, stderr 없음', () => {
    const r = runHook([{ tool: 'Bash', commandPattern: '^git status' }], {
      tool_name: 'Bash',
      tool_input: { command: 'git status' },
      cwd: sandbox,
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe('PermissionRequest');
    expect(out.hookSpecificOutput.decision.behavior).toBe('allow');
  });

  it('빈 allowlist → stdout·stderr 모두 0바이트 (기본 OFF 불변)', () => {
    const r = runHook([], {
      tool_name: 'Bash',
      tool_input: { command: 'git status' },
      cwd: sandbox,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('');
  });

  it('deny 는 절대 내지 않는다 — 보류는 결정 없음이다', () => {
    const r = runHook([{ tool: '*' }], {
      tool_name: 'Bash',
      tool_input: { command: FORCE_PUSH },
      cwd: sandbox,
    });
    expect(r.stdout).not.toContain('deny');
    expect(r.stdout).toBe('');
  });
});
