/**
 * Firewall — v5 "정본 추적 / 산출물 로컬" 경계가 루트 `.gitignore` 에 실제로
 * 걸려 있는가.
 *
 * 왜 게이트가 필요한가. 이 경계는 **두 방향으로 조용히 깨진다.**
 *   1) 로컬이어야 할 것이 추적된다 — `.artibot/transcripts/` 는 사용자/어시스턴트
 *      대화 원문이다. 규칙이 없으면 `git add -A` 한 번에 커밋되고, 커밋된 뒤에는
 *      규칙을 추가해도 이미 추적 중인 파일은 계속 추적된다(gitignore 는 추적
 *      파일에 영향이 없다). 되돌리려면 히스토리를 고쳐야 한다.
 *   2) 추적이어야 할 것이 조용히 ignore 된다 — 설계 결정 B1 이 지목한 실패다.
 *      `.artibot/` 에 폭넓은 규칙을 걸면 `project.md`·`missions/`·`adr/` 가
 *      말없이 사라진다. `git add` 는 에러를 내지 않고 그냥 아무 일도 안 한다.
 *
 * 그래서 이 파일은 **양쪽을 다 잰다**. 한쪽만 재는 게이트는 반대편 사고를
 * 막지 못한다.
 *
 * ── 판정 방법 ───────────────────────────────────────────────────────────────
 * `git check-ignore --no-index` 로 잰다. 경로를 실제로 만들지 않는다 —
 * check-ignore 는 경로의 존재 여부를 보지 않고 규칙만 대조하므로, 픽스처
 * 파일을 만들었다가 지우는 것보다 정확하고 부작용이 없다.
 *
 * `--no-index` 는 필수다. 이것을 빼면 check-ignore 가 인덱스를 먼저 보고
 * **추적 중인 파일은 규칙과 무관하게 "not ignored"** 로 답한다. 그러면 아래
 * "추적 6경로" 테스트가 규칙이 아니라 인덱스를 확인하는 꼴이 되어, 규칙이
 * 통째로 잘못돼도 초록으로 통과한다. 거짓 그린의 정확한 경로다.
 *
 * ── 실측 (커밋 의존 — 시점을 지우지 마라) ───────────────────────────────────
 * **기준 커밋 `dc9a4c12`, 2026-09-02 16:07 +0900 측정.**
 * 규칙 추가 직전 baseline: 로컬 5경로 중 ignored 는 `.artibot/HANDOFF.md`
 * **1건뿐**이었고 `runtime/`·`transcripts/`·`generated/`·`state.yaml`
 * **4건은 전부 미ignored** 였다. 추적 6경로는 그때도 지금도 전부 미ignored.
 *
 * 같은 시점 `git ls-files -z | git check-ignore --no-index --stdin -z` =
 * **10건 / 추적 1,783건**. 그 10건은 전부 **선행 규칙** 소산이다 —
 * `.gitignore:74` 의 _design 규칙 5건, `:24` 의 plugins/artibot/docs 규칙 5건.
 * 이번에 추가한 4규칙에 걸리는 추적 파일은 **0건**이다. 10건은 이 게이트의 대상이
 * 아니며 여기서 고치지 않는다(범위 밖, 별도 판단 필요).
 *
 * ── 이 게이트가 못 보는 것 (초록을 그 이상으로 읽지 마라) ────────────────────
 *  1. **이미 추적 중인 파일.** gitignore 는 추적 파일에 아무 힘이 없다. 누군가
 *     `.artibot/transcripts/x.jsonl` 을 `git add -f` 로 넣으면 이 게이트는
 *     계속 초록이다. "규칙이 있다"와 "그 경로가 커밋되지 않았다"는 다른 진술이다.
 *  2. **쓰기 시점의 실제 경로.** 런타임 코드가 원장을 `.artibot/runtime/` 이
 *     아닌 다른 곳(예: 리포 루트, `_logs/`)에 쓰면 규칙은 맞아도 데이터는
 *     새어 나간다. 이 파일은 `.gitignore` 만 보고 writer 를 보지 않는다.
 *     writer 경로는 원장 쪽 게이트 소관이다.
 *  3. **추적되어야 할 파일의 실재.** `ARTIBOT.md`·`.artibot/project.md` 등
 *     6경로는 측정 시점에 **아직 하나도 존재하지 않는다**. 여기서 "미ignored"
 *     라는 것은 *만들면 추적된다* 는 뜻일 뿐, 만들어졌다는 뜻이 아니다.
 *     **2026-09-03 갱신**: 결정 B2 로 `.artibot/adr/` 만은 실물이 생겼다(ADR
 *     001~010 + INDEX). 그래도 이 게이트는 여전히 규칙만 본다 — 그 디렉터리에
 *     ADR 이 실제로 몇 개 있고 계열이 하나인지는 `artifact-governance.test.js`
 *     의 #2 가 `git ls-files` 로 잰다. 나머지 5경로는 여전히 가설이다.
 *  4. **전역 gitignore·`.git/info/exclude`·중첩 `.gitignore`.** check-ignore 는
 *     그것들도 함께 본다. 어떤 경로가 ignored 로 나와도 그 근거가 루트
 *     `.gitignore` 라는 보장은 없다 — 그래서 규칙 문자열 존재를 따로 검사한다.
 *  5. **`.artibot/ledger/` 개명.** 설계는 `ledger/` → `runtime/` 이동을 말하지만
 *     이번 범위가 아니라 두 규칙이 공존한다. 이 게이트는 공존을 문제 삼지 않는다.
 */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 리포 루트. 워크트리에서도 그 워크트리의 루트를 돌려준다. */
const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  cwd: HERE,
  encoding: 'utf-8',
  stdio: ['ignore', 'pipe', 'pipe'],
}).trim();

const GITIGNORE = path.join(REPO_ROOT, '.gitignore');

/**
 * `git check-ignore --no-index -q <p>` 의 판정.
 * exit 0 = ignored, 1 = not ignored, 그 외 = 도구 오류(그대로 던진다 —
 * 오류를 "not ignored" 로 삼키면 이 게이트가 통째로 거짓 그린이 된다).
 */
function isIgnored(relPath) {
  try {
    execFileSync('git', ['check-ignore', '--no-index', '-q', '--', relPath], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    return true;
  } catch (err) {
    if (err.status === 1) return false;
    throw new Error(
      `git check-ignore 가 예상 밖 종료(${err.status}) — path=${relPath}: ${err.stderr ?? ''}`,
      { cause: err },
    );
  }
}

/** 로컬(재생성 가능하거나 사적 데이터) — 반드시 ignored. */
const LOCAL_PATHS = [
  '.artibot/runtime/ledger.jsonl',
  '.artibot/transcripts/session-abc.jsonl',
  '.artibot/generated/architecture.md',
  '.artibot/state.yaml',
  '.artibot/HANDOFF.md',
];

/** 정본 — 반드시 미ignored(만들면 추적된다). */
const TRACKED_PATHS = [
  'ARTIBOT.md',
  '.artibot/project.md',
  '.artibot/missions/m-0001.md',
  // 2026-09-03, 결정 B2: 이 경로가 이제 **ADR 정본**이다(그 전에는 아직 비어 있는
  // 계획상의 자리였다). `plugins/artibot/docs/adr/` 5건이 `git mv` 로, 루트
  // `docs/adr/` 5건이 006~010 재번호로 여기 모였고 두 원본 디렉터리는 사라졌다.
  // 이 줄이 red 가 되면 ADR 정본 11파일이 통째로 로컬에만 남는다.
  //
  // 파일명이 4자리(`ADR-0001.md`)인데 실물은 3자리+슬러그(`ADR-001-…md`)인 것은
  // 의도된 불일치가 아니라 **무관**하다: 이 게이트는 `check-ignore --no-index` 로
  // 규칙만 대조하고 경로를 만들지도 존재를 보지도 않으며(위 "판정 방법"), 여기
  // 걸리는 규칙은 전부 `.artibot/adr/` **디렉터리 접두**라 basename 이 판정을
  // 바꾸지 않는다. 실물과 맞추면 "이 파일이 있다" 는 착각을 부르고, 존재 여부는
  // 이 게이트가 아니라 artifact-governance 의 #2 가 인덱스 기준으로 잰다.
  '.artibot/adr/ADR-0001.md',
  '.artibot/memory/promoted-note.md',
  '.artibot/guides/v5-design/ARTIBOT-5.0-DESIGN.md',
];

/** 이번 T-08 이 추가한 규칙. 문자열 그대로 — 삭제/개명 시 red. */
const NEW_RULES = [
  '**/.artibot/runtime/',
  '**/.artibot/transcripts/',
  '**/.artibot/generated/',
  '**/.artibot/state.yaml',
];

/** 새 규칙이 덮는 추적 경로를 잡아내기 위한 패턴(줄번호 비의존). */
const NEWLY_LOCAL = /(^|\/)\.artibot\/(runtime|transcripts|generated)\/|(^|\/)\.artibot\/state\.yaml$/;

describe('gitignore boundary — v5 정본/로컬 경계', () => {
  it('하네스 자기검증: 판정기가 양쪽 답을 모두 낼 수 있다', () => {
    // 한쪽만 낼 수 있는 판정기는 그쪽으로 전부 통과시킨다.
    expect(isIgnored('node_modules/anything.js')).toBe(true);
    expect(isIgnored('README.md')).toBe(false);
  });

  it('루트 .gitignore 가 읽히고 비어 있지 않다', () => {
    // 파일이 없으면 red. 조용히 skip 하면 게이트가 사라진 걸 아무도 모른다.
    expect(fsSync.existsSync(GITIGNORE)).toBe(true);
    expect(fsSync.readFileSync(GITIGNORE, 'utf-8').length).toBeGreaterThan(1000);
  });

  it.each(NEW_RULES)('규칙 %s 가 루트 .gitignore 에 문자열로 있다', (rule) => {
    // 못 보는 것 #4 대응 — 판정만 보면 근거가 전역 gitignore 일 수도 있다.
    const lines = fsSync.readFileSync(GITIGNORE, 'utf-8')
      .split(/\r?\n/)
      .map((l) => l.trim());
    expect(lines).toContain(rule);
  });

  it.each(LOCAL_PATHS)('로컬 경로 %s 는 ignored 다', (p) => {
    expect(isIgnored(p)).toBe(true);
  });

  it.each(TRACKED_PATHS)('정본 경로 %s 는 ignored 가 아니다', (p) => {
    expect(isIgnored(p)).toBe(false);
  });

  it('훅 projectRoot 가 중첩 cwd 로 잡혀도 로컬 규칙이 걸린다', () => {
    // `**/` 를 붙인 이유. 실재 증거: plugins/artibot/scripts/hooks/.artibot/ledger/
    expect(isIgnored('plugins/artibot/scripts/hooks/.artibot/runtime/ledger.jsonl')).toBe(true);
    expect(isIgnored('plugins/artibot/scripts/hooks/.artibot/transcripts/s.jsonl')).toBe(true);
  });

  // 후속 19 (#10): `-z` 가 없으면 core.quotepath 가 비-ASCII 경로를
  // "\.artibot/adr/ADR-006-split-\354\226\264\355\234\230..." 로 감싼다.
  // 그러면 NEWLY_LOCAL 정규식이 **실제 경로가 아닌 이스케이프 문자열**에
  // 걸리므로, 무시 규칙이 덮는 자리에 한글 경로 파일이 추적되고 있어도
  // 이 게이트가 통과한다 — fail-open 이다.
  // 이건 가상의 위험이 아니다: 이 리포에는 이미 비-ASCII 추적 경로가 실재한다
  // (측정 2026-09-04 14:3x, `git ls-files -z` 기준 1961건 중 5건, 전부
  // `.artibot/adr/ADR-0xx-...md`).
  function trackedPaths() {
    return execFileSync('git', ['ls-files', '-z'], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).split('\0').filter(Boolean);
  }

  it('새 규칙이 덮는 자리에 추적 중인 파일이 하나도 없다', () => {
    const tracked = trackedPaths();

    // 자기검증: 목록이 비면 아래 필터는 항상 통과한다.
    expect(tracked.length).toBeGreaterThan(500);

    expect(tracked.filter((f) => NEWLY_LOCAL.test(f))).toEqual([]);
  });

  it('추적 목록이 비-ASCII 경로를 C-quote 없이 그대로 싣는다', () => {
    const tracked = trackedPaths();
    const nonAscii = tracked.filter((f) => /[^\x20-\x7e]/.test(f));

    // 자기검증: 이 리포에 비-ASCII 추적 경로가 하나도 없다면 이 테스트는
    // 아무것도 재지 못한다. 그때는 이 단언이 먼저 깨져 알려준다.
    expect(nonAscii.length).toBeGreaterThan(0);

    for (const f of nonAscii) {
      expect(f.startsWith('"')).toBe(false);
      expect(f).not.toMatch(/\\[0-7]{3}/);
    }
  });
});
