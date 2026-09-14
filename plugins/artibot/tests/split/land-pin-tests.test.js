/**
 * `scripts/split/land.mjs#pinTestsFor` — "이 줄기가 바꾼 설정 파일의 basename 을
 * 리터럴로 인용하는 테스트 파일" 목록을 내는 순수 함수.
 *
 * 왜 있나 (Wave 8 p4, 2026-09-13): 줄기가 `hooks/hooks.json` 을 바꿨는데
 * `tests/hooks-schema-shape.test.js` 가 allowlist·표적 스위트 밖이라 배치가
 * not-green 이었다. land 가 후보를 출력하면 리더가 표적 스위트에 넣을 수 있다.
 *
 * 이 스위트가 증명하지 못하는 것 (rules §9):
 *   - 이 목록이 "충분하다"는 것. grep 은 사각 3종(조립 파일명·글롭 로더·
 *     스냅샷 파일)을 구조적으로 못 본다 — (d) 케이스가 그 사각을 고정한다.
 *   - 나열된 테스트를 실제로 돌리면 통과/실패한다는 것. 이 기능은 실행하지 않는다.
 *   - 실 리포 스캔 케이스의 분모는 세션마다 변한다(다른 줄기가 테스트를 늘린다).
 *     그래서 정확한 수치가 아니라 하한 + 포함 여부로만 단언한다.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONFIG_PIN_BASENAMES, formatPinTests, pinTestsFor, runLand } from '../../scripts/split/land.mjs';

/** 이 파일은 `<plugin-root>/tests/split/` 에 있다 → 위로 둘이 플러그인 루트. */
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REAL_TESTS = path.join(PLUGIN_ROOT, 'tests');

describe('pinTestsFor — 설정 파일 → 그 basename 을 인용하는 테스트', () => {
  it('실 리포: hooks.json 변경 → hooks-schema-shape.test.js 가 후보에 든다', () => {
    const changed = ['plugins/artibot/hooks/hooks.json'];
    const r = pinTestsFor(changed, REAL_TESTS);

    // 실측: `grep -rl --include=*.test.js -F hooks.json tests | wc -l`
    //   2026-09-14 01:29 KST → 23 (이 파일 작성 전)
    //   2026-09-14 01:34 KST → 24 (이 파일 자신이 hooks.json 을 인용해 +1;
    //                              pinTestsFor 스캔도 같은 24, 분모 674)
    // 수치를 하드코딩하지 않는다 — 다른 줄기가 테스트를 늘린다. 하한만 건다.
    const hits = r.pinTests['plugins/artibot/hooks/hooks.json'];
    expect(hits.some((f) => f.endsWith('hooks-schema-shape.test.js'))).toBe(true);
    expect(hits.length).toBeGreaterThanOrEqual(20);
    expect(r.scanned).toBeGreaterThan(hits.length);
    // 경로 구분자는 `/` 로 통일한다 (Windows 에서 깨지면 리더가 그대로 못 붙인다).
    expect(hits.every((f) => !f.includes('\\'))).toBe(true);
  });

  it('설정 파일이 아니면 스캔 자체를 하지 않는다 (scanned 0)', () => {
    const r = pinTestsFor(['plugins/artibot/lib/x.js', 'README.md'], REAL_TESTS);
    expect(r.pinTests).toEqual({});
    expect(r.scanned).toBe(0);
    expect(r.unreadable).toBe(0);
  });

  it('빈 입력·비배열도 빈 결과', () => {
    expect(pinTestsFor([], REAL_TESTS).scanned).toBe(0);
    expect(pinTestsFor(undefined, REAL_TESTS).pinTests).toEqual({});
  });

  it('path.join(ROOT, "hooks", "hooks.json") 조립형은 잡힌다 (basename 리터럴 존재)', () => {
    const deps = {
      listTests: () => ['a.test.js', 'b.test.mjs'],
      readFile: (p) => (p.endsWith('a.test.js')
        ? "const P = path.join(ROOT, 'hooks', 'hooks.json');\n"
        : 'nothing relevant here\n'),
    };
    const r = pinTestsFor(['plugins/artibot/hooks/hooks.json'], '/fake/tests', deps);
    expect(r.pinTests['plugins/artibot/hooks/hooks.json']).toEqual(['a.test.js']);
    expect(r.scanned).toBe(2);
  });

  it('사각 ①: 변수로 조립한 파일명(`${name}.json`)은 못 본다 — 0건으로 고정', () => {
    const deps = {
      listTests: () => ['tpl.test.js'],
      readFile: () => 'const f = `${name}.json`; load(f);\n',
    };
    const r = pinTestsFor(['plugins/artibot/hooks/hooks.json'], '/fake/tests', deps);
    expect(r.pinTests['plugins/artibot/hooks/hooks.json']).toEqual([]);
    expect(r.scanned).toBe(1);
  });

  it('schemas/ 아래 .json 은 basename 이 allowlist 밖이어도 대상', () => {
    const deps = {
      listTests: () => ['s.test.js'],
      readFile: () => "readFileSync('schemas/foo.schema.json');\n",
    };
    const r = pinTestsFor(['plugins/artibot/schemas/foo.schema.json'], '/fake/tests', deps);
    expect(r.pinTests['plugins/artibot/schemas/foo.schema.json']).toEqual(['s.test.js']);
  });

  it('CONFIG_PIN_BASENAMES 의 모든 basename 이 대상으로 인정된다', () => {
    expect(CONFIG_PIN_BASENAMES.length).toBeGreaterThanOrEqual(5);
    const deps = { listTests: () => [], readFile: () => '' };
    for (const b of CONFIG_PIN_BASENAMES) {
      const r = pinTestsFor([`plugins/artibot/${b}`], '/fake/tests', deps);
      expect(Object.keys(r.pinTests)).toEqual([`plugins/artibot/${b}`]);
    }
  });

  it('읽기 실패 파일은 건너뛰고 unreadable 에 센다', () => {
    const deps = {
      listTests: () => ['ok.test.js', 'boom.test.js'],
      readFile: (p) => {
        if (p.endsWith('boom.test.js')) throw new Error('EACCES');
        return 'hooks.json\n';
      },
    };
    const r = pinTestsFor(['plugins/artibot/hooks/hooks.json'], '/fake/tests', deps);
    expect(r.pinTests['plugins/artibot/hooks/hooks.json']).toEqual(['ok.test.js']);
    expect(r.unreadable).toBe(1);
    expect(r.scanned).toBe(2);
  });

  it('결정성: 같은 입력 두 번 → deep-equal, 결과는 frozen', () => {
    const deps = {
      listTests: () => ['z.test.js', 'a.test.js'],
      readFile: () => 'hooks.json\n',
    };
    const a = pinTestsFor(['plugins/artibot/hooks/hooks.json'], '/fake/tests', deps);
    const b = pinTestsFor(['plugins/artibot/hooks/hooks.json'], '/fake/tests', deps);
    expect(a).toEqual(b);
    // 정렬: 디렉터리 순서가 아니라 사전순.
    expect(a.pinTests['plugins/artibot/hooks/hooks.json']).toEqual(['a.test.js', 'z.test.js']);
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(a.pinTests)).toBe(true);
  });
});

describe('formatPinTests — 정보 출력', () => {
  it('대상 0건이면 한 줄', () => {
    const text = formatPinTests({ pinTests: {}, scanned: 0, unreadable: 0 });
    expect(text).toContain('pin tests: 설정 파일 변경 0건');
    expect(text).not.toContain('실행하지 않는다');
  });

  it('대상이 있으면 파일별 건수·분모·목록, 0건이면 사각 3종 안내', () => {
    const text = formatPinTests({
      pinTests: {
        'plugins/artibot/hooks/hooks.json': ['hooks-schema-shape.test.js'],
        'plugins/artibot/plugin.json': [],
      },
      scanned: 300,
      unreadable: 0,
    });
    expect(text).toContain('실행하지 않는다');
    expect(text).toContain('plugins/artibot/hooks/hooks.json → 1건 / 스캔 300: hooks-schema-shape.test.js');
    expect(text).toContain('plugins/artibot/plugin.json → 0건 (사각 3종 가능');
  });
});

describe('runLand 배선 — 정보 출력일 뿐 판정은 무변경', () => {
  let repo = '';
  let planBase = '';

  const git = (args, cwd) => execFileSync('git', args, {
    cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
  }).trim();

  const capture = () => {
    const out = [];
    const err = [];
    return { out, err, io: { stdout: (s) => out.push(s), stderr: (s) => err.push(s) } };
  };

  beforeAll(() => {
    // 임시 디렉터리에만 만든다 — 실 리포에 worktree 를 만들지 않는다.
    repo = fsSync.mkdtempSync(path.join(os.tmpdir(), 'artibot-land-pin-'));
    git(['init', '-q', '-b', 'main', '.'], repo);
    git(['config', 'user.email', 'test@example.invalid'], repo);
    git(['config', 'user.name', 'test'], repo);
    git(['config', 'commit.gpgsign', 'false'], repo);
    fsSync.writeFileSync(path.join(repo, 'seed.txt'), 'main\n');
    git(['add', 'seed.txt'], repo);
    git(['commit', '-q', '-m', 'chore: seed'], repo);
    planBase = git(['rev-parse', 'HEAD'], repo);

    git(['checkout', '-q', '-b', 'limb-good', 'main'], repo);
    fsSync.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fsSync.writeFileSync(path.join(repo, 'src', 'x.txt'), 'x\n');
    git(['add', 'src/x.txt'], repo);
    git(['commit', '-q', '-m', 'feat: x', '-m', 'Split-Limb: done'], repo);
    git(['checkout', '-q', 'main'], repo);

    fsSync.mkdirSync(path.join(repo, '.artibot', 'split'), { recursive: true });
    fsSync.writeFileSync(path.join(repo, '.artibot', 'split', 'plan.json'), JSON.stringify({
      runId: 'pin-test',
      base: planBase,
      repoShort: 'tt',
      limbs: [{ limb: 'good', branch: 'limb-good', worktreePath: '', affectedPaths: ['src/**'] }],
    }));
  });

  afterAll(() => {
    try {
      fsSync.rmSync(repo, { recursive: true, force: true });
    } catch { /* best effort */ }
  });

  it('표 모드에 pin tests 절이 붙는다 (설정 파일 0건)', () => {
    const { out, io } = capture();
    runLand({ argv: ['good'], cwd: repo, ...io });
    expect(out.join('\n')).toContain('pin tests: 설정 파일 변경 0건');
  });

  it('--json 에 pinTests·pinTestsScanned 가 있고 checks 길이는 7 그대로', () => {
    const { out, io } = capture();
    runLand({ argv: ['good', '--json'], cwd: repo, ...io });
    const parsed = JSON.parse(out.join('\n'));
    // 소유 밖 핀: tests/git/limb-landing-check.test.js 가 같은 7 을 건다.
    // checks[] 에 행을 추가하면 그 테스트가 깨진다.
    expect(parsed.checks).toHaveLength(7);
    expect(parsed.pinTests).toEqual({});
    expect(parsed.pinTestsScanned).toBe(0);
  });
});
