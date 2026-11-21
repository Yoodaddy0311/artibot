import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  defaultJudge,
  entryCoversTool,
  evaluatePermission,
  matchesAllowEntry,
} from '../../scripts/hooks/permission-auto-approve.js';

/** Plugin root — `executeChain` only runs `artibot-policy` guards inside it. */
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK_PATH = path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'permission-auto-approve.js');

/** Assembled so the literal never appears in a Bash command this repo guards. */
const FORCE_PUSH = `git push --${'force'} origin main`;
// 2026-09-11 재교체: 강제 푸시 계열은 더 이상 "L2 만 잡는" 예시가 아니다.
// lease 단독은 오너 결정 ① 이후 두 정본이 합의하고(L1 pass / L2 caution),
// `-f`+lease 는 같은 날 L1 의 safeOverrides 구멍이 닫히면서 두 정본 모두
// 차단으로 합의했다 — L1 이 먼저 block 을 내므로 withheld.reason 이 L2 의
// matchedId 가 아니라 L1 라벨이 된다. 한쪽만 잡는 예시로는 SQL 문이 남는다:
// L1 은 `TRUNCATE TABLE/DATABASE` 형만 차단해 bare 문을 통과시키고,
// L2 는 sql-truncate 로 danger 를 낸다(실측 2026-09-11, 파리티 매트릭스의
// owner-decision 행과 같은 명령).
const L2_ONLY_DANGER = `${'TRUNC'}ATE users;`;

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
  it('도구를 명시한 allowlist 라도 파괴적 명령은 보류 (defaultJudge)', () => {
    const out = evaluatePermission({
      toolName: 'Bash',
      toolInput: { command: FORCE_PUSH },
      allowlist: [{ tool: 'Bash' }],
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
        allowlist: [{ tool: 'Bash' }],
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
  // 측정 2026-09-11: blocked-patterns 의 SQL 규칙은 `truncate\s+table\b` 와
  // `(DROP|TRUNCATE)\s+(TABLE|DATABASE)` 뿐이라 키워드 없는 bare 문을
  // approve 한다. safety.js#classifyRisk 의 sql-truncate 는 같은 문을
  // danger 로 본다. 한쪽만 잡는다 — L1 이 통과시켜야만 이 방향이 증명된다.
  it('safety.js 만 잡는 케이스 → 보류 (blocked-patterns 는 approve)', () => {
    const out = evaluatePermission({
      toolName: 'Bash',
      toolInput: { command: L2_ONLY_DANGER },
      allowlist: [{ tool: 'Bash' }],
    });
    expect(out.decision).toBeNull();
    expect(out.withheld?.kind).toBe('destructive');
    // 형식은 `${matchedId}: ${reason}` (permission-auto-approve.js#defaultJudge).
    // 접두사로 고정해 L1 라벨이 대신 실리면 바로 깨지게 한다.
    expect(out.withheld?.reason).toMatch(/^sql-truncate: /);
  });

  // 측정 2026-09-11: 반대 방향. blocked-patterns 는 `dd\s+if=` 로 모든 dd 를
  // block 하는데 classifyRisk 의 dd-device-write 는 `of=` 가 /dev/ 를 가리킬
  // 때만 danger 다. 그래서 파일 대 파일 dd 는 L1 block / L2 safe 로 갈린다.
  // 종전 예시였던 `of=/dev/sda` 는 오너 결정 ③ 이후 양쪽이 합의해(block+danger)
  // 이 방향을 더 이상 증명하지 못한다.
  it('blocked-patterns 만 잡는 케이스 → 보류 (classifyRisk 는 safe)', () => {
    const out = evaluatePermission({
      toolName: 'Bash',
      toolInput: { command: 'dd if=a.img of=b.img' },
      allowlist: [{ tool: 'Bash' }],
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

describe('defaultJudge/PowerShell 도 같은 위험 필터를 거친다 (S1 교차검수, 2026-11-07)', () => {
  // PermissionRequest 매처는 `*` 라 PowerShell 요청도 이 훅에 온다. 종전에는
  // toolName !== 'Bash' 면 null(= 깨끗함)이라, allowlist 에 PowerShell 을 둔
  // 사용자는 위험 필터 없이 자동 승인을 받았다.
  const PS_DELETE = `Remove-Item -Recurse -${'Force'} C:\\proj\\build`;

  it('PowerShell 고유 파괴 명령은 destructive 로 보류', () => {
    const v = defaultJudge({ toolName: 'PowerShell', toolInput: { command: PS_DELETE } });
    expect(v?.kind).toBe('destructive');
    expect(v?.reason).toContain('Remove-Item -Recurse -Force (PowerShell)');
  });

  it('PowerShell 체인으로 판정한다 — 백틱 줄이음도 보류', () => {
    const command = 'Remove-Item C:\\proj\\build `\n  -Recurse -Force';
    expect(defaultJudge({ toolName: 'PowerShell', toolInput: { command } })?.kind).toBe('destructive');
  });

  it('allowlist 에 PowerShell 을 둬도 파괴 명령은 자동 승인되지 않는다', () => {
    const out = evaluatePermission({
      toolName: 'PowerShell',
      toolInput: { command: PS_DELETE },
      allowlist: [{ tool: 'PowerShell' }],
    });
    expect(out.decision).toBeNull();
    expect(out.withheld?.kind).toBe('destructive');
  });

  it('안전한 PowerShell 명령은 allow, 읽을 수 없는 명령은 unjudgeable', () => {
    expect(evaluatePermission({
      toolName: 'PowerShell',
      toolInput: { command: 'Get-ChildItem -Recurse' },
      allowlist: [{ tool: 'PowerShell' }],
    }).decision).toBe('allow');
    expect(defaultJudge({ toolName: 'PowerShell', toolInput: {} })?.kind).toBe('unjudgeable');
  });

  it('허용목록 밖 이름은 여전히 판정 대상이 아니다', () => {
    for (const toolName of ['powershell', 'constructor', 'Write']) {
      expect(defaultJudge({ toolName, toolInput: { command: PS_DELETE } }), toolName).toBeNull();
    }
  });
});

describe('evaluatePermission/와일드카드 항목은 셸 도구를 승인하지 않는다 (L3, 2026-11-21)', () => {
  // 검수 2026-11-21: opt-in `{tool:'*'}` 하나로 아래 명령이 전부 allow 였다. 두 정본
  // 판정기 어느 쪽 목록에도 없는 셸 명령은 통과하므로(헤더 "이 필터가 못 보는 것"),
  // 부정 목록을 늘리는 대신 "셸 호출을 승인할 수 있는 항목"을 허용 목록으로 좁힌다:
  // 그 도구 이름을 명시했거나(`{tool:'Bash'}`) commandPattern 으로 명령을 제한한 항목만.
  const UNLISTED_DANGER = [
    `echo eA== | base64 -d | ${'ba'}sh`,
    `find . ${'-del'}ete`,
    'ls > ~/.bashrc',
    'echo ssh-ed25519 AAAA >> ~/.ssh/authorized_keys',
  ];
  const WILDCARDS = [[{ tool: '*' }], [{}]];

  it('측정: 이 명령들은 두 판정기 어느 쪽 목록에도 걸리지 않는다 — 판정기로는 못 막는다', () => {
    for (const command of UNLISTED_DANGER) {
      expect(defaultJudge({ toolName: 'Bash', toolInput: { command } }), command).toBeNull();
    }
  });

  it('commandPattern 없는 와일드카드는 Bash 를 승인하지 않고, 판정기도 부르지 않는다', () => {
    for (const allowlist of WILDCARDS) {
      for (const command of [...UNLISTED_DANGER, 'git status']) {
        let calls = 0;
        const out = evaluatePermission(
          { toolName: 'Bash', toolInput: { command }, allowlist },
          { judge: () => { calls += 1; return null; } },
        );
        expect(out.decision, `${JSON.stringify(allowlist)} ${command}`).toBeNull();
        expect(out.withheld?.kind).toBe('wildcard-shell');
        expect(calls).toBe(0);
      }
    }
  });

  it('PowerShell 도 같다', () => {
    const out = evaluatePermission({
      toolName: 'PowerShell',
      toolInput: { command: 'Get-ChildItem' },
      allowlist: [{ tool: '*' }],
    });
    expect(out.decision).toBeNull();
    expect(out.withheld?.kind).toBe('wildcard-shell');
  });

  it('commandPattern 을 단 와일드카드, 도구 이름을 명시한 항목은 여전히 승인한다(판정기 통과 시)', () => {
    expect(evaluatePermission({
      toolName: 'Bash',
      toolInput: { command: 'git status' },
      allowlist: [{ tool: '*', commandPattern: '^git status$' }],
    }).decision).toBe('allow');
    expect(evaluatePermission({
      toolName: 'Bash',
      toolInput: { command: 'git status' },
      allowlist: [{ tool: 'Bash' }],
    }).decision).toBe('allow');
  });

  it('와일드카드 옆에 셸을 승인하는 항목이 있으면 그 항목이 이긴다 — 순서 무관', () => {
    const narrow = { tool: 'Bash', commandPattern: '^npm test$' };
    for (const allowlist of [[{ tool: '*' }, narrow], [narrow, { tool: '*' }]]) {
      expect(evaluatePermission({ toolName: 'Bash', toolInput: { command: 'npm test' }, allowlist }).decision)
        .toBe('allow');
      const other = evaluatePermission({ toolName: 'Bash', toolInput: { command: `find . ${'-del'}ete` }, allowlist });
      expect(other.decision).toBeNull();
      expect(other.withheld?.kind).toBe('wildcard-shell');
    }
  });

  // 검수 2026-11-21 xcC LOW: commandPattern 이 "있긴 하지만 명령을 제한하지 않는" 값.
  // matchesAllowEntry 는 '' 와 0 을 "패턴 없음"으로 보고(모든 명령에 매치), 배열은
  // RegExp 가 문자열로 강제 변환해(['.+'] → /.+/) 역시 모든 명령에 매치한다. 그래서
  // 셸 승인 여부는 entryCoversTool 의 "비어 있지 않은 문자열" 조건 하나에 달려 있다.
  const NON_RESTRICTING_PATTERNS = [
    ['빈 문자열', ''],
    ['숫자 0', 0],
    ['숫자 123', 123],
    ['배열', ['.+']],
    ['객체', { source: '.+' }],
    ['null', null],
  ];

  it.each(NON_RESTRICTING_PATTERNS)('entryCoversTool: 와일드카드 + commandPattern=%s 는 셸을 덮지 않는다', (_label, commandPattern) => {
    expect(entryCoversTool({ tool: '*', commandPattern }, 'Bash')).toBe(false);
    expect(entryCoversTool({ commandPattern }, 'PowerShell')).toBe(false);
  });

  it.each(NON_RESTRICTING_PATTERNS)('evaluatePermission: 와일드카드 + commandPattern=%s 는 승인하지 않고 판정기도 부르지 않는다', (_label, commandPattern) => {
    // '123' 을 넣어 숫자 패턴(/123/)도 매치 단계를 통과하게 한다 — 매치되고도 보류돼야 한다.
    const command = `find . ${'-del'}ete 123`;
    let calls = 0;
    const out = evaluatePermission(
      { toolName: 'Bash', toolInput: { command }, allowlist: [{ tool: '*', commandPattern }] },
      { judge: () => { calls += 1; return null; } },
    );
    expect(out.decision).toBeNull();
    expect(calls).toBe(0);
    // 매치 단계를 통과한 경우에만 withheld 가 붙는다. 이 입력에서는 6종 모두 통과한다.
    expect(out.withheld?.kind).toBe('wildcard-shell');
  });

  it('entryCoversTool: 도구 이름을 명시했거나 셸이 아닌 도구면 패턴 값과 무관하게 덮는다', () => {
    expect(entryCoversTool({ tool: 'Bash', commandPattern: '' }, 'Bash')).toBe(true);
    expect(entryCoversTool({ tool: '*', commandPattern: 0 }, 'Read')).toBe(true);
    expect(entryCoversTool({ tool: '*', commandPattern: '^git status$' }, 'Bash')).toBe(true);
  });

  it('셸이 아닌 도구에 대한 와일드카드 의미는 그대로다', () => {
    expect(evaluatePermission({
      toolName: 'Read',
      toolInput: { file_path: 'a.js' },
      allowlist: [{ tool: '*' }],
    }).decision).toBe('allow');
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

  it('구멍의 위치: judge 는 호출되지만 Bash 가 아니라 판정을 포기한다', () => {
    // 구멍은 "judge 를 안 부른다"가 아니라 "불러도 Bash 가 아니면 null"이다.
    // 나중에 Write 판정 정본이 생기면 고칠 자리는 defaultJudge 안이지
    // evaluatePermission 의 호출 여부가 아니다.
    const seen = [];
    const out = evaluatePermission(
      {
        toolName: 'Write',
        toolInput: { file_path: '.env', content: 'X=1' },
        allowlist: [{ tool: '*' }],
      },
      {
        judge: (call) => {
          seen.push(call.toolName);
          return defaultJudge(call);
        },
      },
    );
    expect(seen).toEqual(['Write']);
    expect(out.decision).toBe('allow');
  });

  it('Bash 가 아닌 도구는 judge 가 즉시 null 을 낸다', () => {
    expect(defaultJudge({ toolName: 'Write', toolInput: { file_path: '.env' } })).toBeNull();
    expect(defaultJudge({ toolName: 'Edit', toolInput: { file_path: 'id_rsa' } })).toBeNull();
    expect(defaultJudge({ toolName: 'Read', toolInput: { file_path: 'a.js' } })).toBeNull();
  });

  it('판정 불가 Bash 입력은 보류(fail-closed)', () => {
    // 두 정본 모두 문자열이 아닌 command 를 볼 수 없다. 여기서 "매치 없음"은
    // "안전하다"가 아니라 "보지 못했다"이므로 승인을 아낀다.
    for (const toolInput of [{}, { command: 123 }, { command: '' }, { command: null }]) {
      const verdict = defaultJudge({ toolName: 'Bash', toolInput });
      expect(verdict?.kind).toBe('unjudgeable');
      expect(verdict?.reason).toBe('command is not a non-empty string');
    }
  });

  it('판정 불가 Bash 는 allowlist 를 매치해도 결정 없음 — deny 는 아니다', () => {
    const out = evaluatePermission({
      toolName: 'Bash',
      toolInput: { command: 123 },
      allowlist: [{ tool: 'Bash' }],
    });
    expect(out.decision).toBeNull();
    expect(out.withheld?.kind).toBe('unjudgeable');
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

  it('도구 명시 항목 + 파괴적 명령 → stdout 0바이트, stderr 보류 1줄, exit 0', () => {
    const r = runHook([{ tool: 'Bash' }], {
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

  it('와일드카드 + 판정기 목록 밖 셸 명령 → stdout 0바이트, stderr wildcard-shell 1줄 (L3)', () => {
    const r = runHook([{ tool: '*' }], {
      tool_name: 'Bash',
      tool_input: { command: `find . ${'-del'}ete` },
      cwd: sandbox,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('auto-approve withheld: wildcard-shell');
    expect(r.stderr.trim().split('\n')).toHaveLength(1);
  });

  it('deny 는 절대 내지 않는다 — 보류는 결정 없음이다', () => {
    const r = runHook([{ tool: 'Bash' }], {
      tool_name: 'Bash',
      tool_input: { command: FORCE_PUSH },
      cwd: sandbox,
    });
    expect(r.stdout).not.toContain('deny');
    expect(r.stdout).toBe('');
  });
});
