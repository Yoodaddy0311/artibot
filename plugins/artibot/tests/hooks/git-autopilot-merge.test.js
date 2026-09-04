import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * git-autopilot-merge.js — conflict auto-resolution helpers.
 *
 * Phase 2c P0 D-1 fix: filePath is passed as an explicit argv-array element
 * to execFileSync (NOT spliced into a shell command).  Even when filePath
 * contains shell metacharacters, git must receive it verbatim as a single
 * argument and never spawn a shell.
 */

const execFileSyncSpy = vi.fn();
const readFileSyncMock = vi.fn();
const writeFileSyncMock = vi.fn();

vi.mock('node:child_process', () => ({
  execFileSync: (...args) => execFileSyncSpy(...args),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs');
  return {
    ...actual,
    readFileSync: (...args) => readFileSyncMock(...args),
    writeFileSync: (...args) => writeFileSyncMock(...args),
  };
});

let resolveOurs;
let resolveTheirs;
let resolveUnion;
let listConflictedFiles;

beforeEach(async () => {
  execFileSyncSpy.mockReset();
  readFileSyncMock.mockReset();
  writeFileSyncMock.mockReset();
  // Default: return empty stdout for any git call.
  execFileSyncSpy.mockReturnValue('');
  if (!resolveOurs) {
    const mod = await import('../../scripts/hooks/git-autopilot-merge.js');
    resolveOurs = mod.resolveOurs;
    resolveTheirs = mod.resolveTheirs;
    resolveUnion = mod.resolveUnion;
    listConflictedFiles = mod.listConflictedFiles;
  }
});

afterEach(() => {
  vi.clearAllMocks();
});

const MALICIOUS = '; touch /tmp/pwn ; echo "; rm -rf /"';

describe('resolveOurs — argv-array safety (D-1)', () => {
  it('passes the file path as a separate argv element (no shell expansion)', () => {
    const r = resolveOurs(MALICIOUS, '/repo');
    expect(r.resolved).toBe(true);
    // Two execFileSync calls: checkout --ours -- <path>, then add -- <path>.
    expect(execFileSyncSpy).toHaveBeenCalledTimes(2);
    const [firstFile, firstArgs] = execFileSyncSpy.mock.calls[0];
    expect(firstFile).toBe('git');
    expect(Array.isArray(firstArgs)).toBe(true);
    // Crucially: the malicious path is the LAST element, intact, with no escaping.
    expect(firstArgs[firstArgs.length - 1]).toBe(MALICIOUS);
    // And the args BEFORE it form the literal git invocation.
    expect(firstArgs.slice(0, -1)).toEqual(['checkout', '--ours', '--']);
    // No call uses a shell option.
    for (const call of execFileSyncSpy.mock.calls) {
      const opts = call[2] || {};
      expect(opts.shell).toBeFalsy();
    }
  });

  it('reports unresolved with strategy=ours when execFileSync throws', () => {
    execFileSyncSpy.mockImplementation(() => {
      throw new Error('git: pathspec did not match');
    });
    const r = resolveOurs(MALICIOUS, '/repo');
    expect(r.resolved).toBe(false);
    expect(r.strategy).toBe('ours');
  });
});

describe('resolveTheirs — argv-array safety (D-1)', () => {
  it('passes the file path as a separate argv element', () => {
    const r = resolveTheirs(MALICIOUS, '/repo');
    expect(r.resolved).toBe(true);
    expect(execFileSyncSpy).toHaveBeenCalledTimes(2);
    const [firstFile, firstArgs] = execFileSyncSpy.mock.calls[0];
    expect(firstFile).toBe('git');
    expect(firstArgs.slice(0, -1)).toEqual(['checkout', '--theirs', '--']);
    expect(firstArgs[firstArgs.length - 1]).toBe(MALICIOUS);
    for (const call of execFileSyncSpy.mock.calls) {
      const opts = call[2] || {};
      expect(opts.shell).toBeFalsy();
    }
  });
});

describe('resolveUnion — argv-array safety (D-1)', () => {
  it('passes the file path as a separate argv element when staging the union result', () => {
    // No conflict markers in returned content -> union "resolves" trivially.
    readFileSyncMock.mockReturnValue('clean content with no markers\n');
    const r = resolveUnion(MALICIOUS, '/repo');
    expect(r.resolved).toBe(true);
    // Exactly one execFileSync call (the `git add -- <path>` after writeFileSync).
    expect(execFileSyncSpy).toHaveBeenCalledTimes(1);
    const [file, args] = execFileSyncSpy.mock.calls[0];
    expect(file).toBe('git');
    expect(args.slice(0, -1)).toEqual(['add', '--']);
    expect(args[args.length - 1]).toBe(MALICIOUS);
  });
});


// ---------------------------------------------------------------------------
// listConflictedFiles — git 경로 출력 디코딩 (후속 19 #8, :47)
// ---------------------------------------------------------------------------
//
// 여기서 나온 경로는 곧바로 `git checkout --ours -- <path>` 와 readFileSync
// 로 넘어간다(:163 이하 해소 전략). 그래서 core.quotepath 가 C-quote 를 씌우면
// 훅이 **존재하지 않는 파일명**으로 git 을 부르고 자동 해소가 통째로 실패한다.
// 비-ASCII 경로가 든 충돌은 자동 해소 대상에서 조용히 탈락한다.
//
// 목은 -z 유무로 형태를 가른다 — 옛 코드가 -z 를 넘기지 않는다는 사실 자체가
// RED 로 드러나야 하기 때문이다.
describe('listConflictedFiles — 경로 디코딩 (후속 19 #8)', () => {
  const KO = 'src/한글폴더/설계문서.md';
  const SPACE = 'src/with space/파일 이름.md';
  const C_QUOTED =
    '"src/\\355\\225\\234\\352\\270\\200\\355\\217\\264\\353\\215\\224/'
    + '\\354\\204\\244\\352\\263\\204\\353\\254\\270\\354\\204\\234.md"';

  beforeEach(() => {
    execFileSyncSpy.mockImplementation((_file, args) => {
      if (Array.isArray(args) && args.includes('--diff-filter=U')) {
        return args.includes('-z')
          ? `${KO}\0${SPACE}\0`
          : `${C_QUOTED}\n"src/with space/..."\n`;
      }
      return '';
    });
  });

  it('-z 를 넘긴다', () => {
    listConflictedFiles('/repo');
    const [, args] = execFileSyncSpy.mock.calls[0];
    expect(args).toContain('-z');
  });

  it('한글·공백 경로를 실제 경로로 돌려준다', () => {
    expect(listConflictedFiles('/repo')).toEqual([KO, SPACE]);
  });

  it('C-quote 잔재가 남지 않는다', () => {
    const files = listConflictedFiles('/repo');
    // 자기검증: 목록이 비면 아래 루프는 공허하게 통과한다.
    expect(files.length).toBe(2);
    for (const f of files) {
      expect(f.startsWith('"')).toBe(false);
      expect(f).not.toMatch(/\\[0-7]{3}/);
    }
  });

  it('충돌이 없으면 빈 배열 (꼬리 NUL 을 파일로 세지 않는다)', () => {
    execFileSyncSpy.mockImplementation(() => '');
    expect(listConflictedFiles('/repo')).toEqual([]);
  });

  it('git 이 던지면 빈 배열로 강등한다(회귀)', () => {
    execFileSyncSpy.mockImplementation(() => { throw new Error('not a repo'); });
    expect(listConflictedFiles('/repo')).toEqual([]);
  });
});
