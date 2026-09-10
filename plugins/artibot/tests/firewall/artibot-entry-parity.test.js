/**
 * ARTIBOT.md 진입 계약 parity — read-order 드리프트와 거짓 "미착지" 표기 차단.
 *
 * ── 왜 이 파일이 있는가 ─────────────────────────────────────────────────────
 * 하네스는 `CLAUDE.md` 계층과 `.claude/rules` 만 자동 로드한다. 그래서 리포의
 * 진입 계약이 실효를 가지려면 두 개가 동시에 참이어야 한다 —
 *   (a) `ARTIBOT.md` 가 존재하고 정본 읽기 순서를 담는다,
 *   (b) 자동 로드되는 루트 `CLAUDE.md` 가 그것을 읽으라고 가리킨다.
 * 설계 §3.7 은 이를 "대체 아님 · **병존 필수**" 로 못박고, 남는 위험을
 * "read-order 드리프트" 로 지목하면서 그 완화를 `tests/firewall/` 게이트
 * 1건("CLAUDE.md 가 ARTIBOT.md 를 가리킨다")으로 지정했다. 이 파일이 그 1건이다.
 *
 * 결정 B3(include vs 8줄 복제)은 조사 I3(호스트가 CLAUDE.md 파일 include 를
 * 지원하는가) 미해소 상태다. 그래서 실제 배선은 include 가 아니라 **어댑터 1줄 +
 * parity 게이트** 이고, 이 파일이 그 parity 쪽을 든다.
 *
 * ── 정본을 이 파일에 복사하지 않는 이유 ─────────────────────────────────────
 * 읽기 순서와 정본 규칙의 기대값을 테스트 안에 문자열로 박으면, 정본이 바뀔 때
 * 고쳐야 할 자리가 둘(설계 템플릿 · 이 테스트)이 되고 그중 하나만 고치면 게이트가
 * 조용히 다른 것을 지키게 된다. 그래서 기대값은 추적 파일인 설계 템플릿
 * `.artibot/guides/v5-design/package-v1.1/19_ARTIBOT_TEMPLATE.md` 에서 **매번
 * 파싱해 온다.** 결과적으로 이 게이트는 "ARTIBOT.md == 설계 템플릿" 을 본다.
 * 템플릿이 다른 레인에서 바뀌면 여기가 레드가 되는데, 그것이 의도다 — 정본이
 * 움직였다는 신호이지 이 게이트의 오작동이 아니다.
 *
 * ── "미착지" 표기를 게이트가 드는 이유 ──────────────────────────────────────
 * 읽기 순서 1·2 가 가리키는 `.artibot/project.md`·`.artibot/state.yaml` 과 3·4 의
 * `.artibot/missions/` 는 2026-09-02 16:0x 기준 전부 부재다(실측: `ls .artibot/`
 * 에 셋 다 없음). 그래서 그 줄에 `not yet landed` 를 붙였다. 표기는 썩는다 —
 * 산출물이 생겼는데 표기가 남거나, 표기를 지웠는데 산출물이 없거나. 그래서
 * **표기 유무와 실제 존재를 양방향으로 대조**한다. 어느 쪽으로 어긋나도 레드다.
 *
 * ── 이 게이트가 못 보는 것 ──────────────────────────────────────────────────
 *  1. **호스트가 실제로 CLAUDE.md 를 읽는지 못 본다.** 파일 내용만 본다. 어댑터
 *     1줄이 세션에 실제로 주입되는지는 조사 I3 의 영역이고 여기서는 미확인이다.
 *     즉 "가리킨다" 는 증명하지만 "도달한다" 는 증명하지 않는다.
 *  2. **모델이 그 지시를 따르는지 못 본다.** 배선의 존재와 행동의 발생은 다른
 *     진술이다.
 *  3. **읽기 순서가 "옳은" 순서인지 못 본다.** 템플릿과 같은지만 본다. 템플릿
 *     자체가 틀렸으면 여기는 그린이다 — 이 게이트가 막는 것은 오설계가 아니라
 *     **양쪽의 무단 이탈**이다.
 *  4. **구체 경로가 없는 항목(5 `Relevant ADRs`, 6 `Review / Outcome`)의 미착지
 *     여부는 못 본다.** ADR 정본 계열은 결정 B2 미결이라 대조할 단일 경로가
 *     아직 없다.
 *  5. **`.artibot/project.md` 의 내용**은 보지 않는다. 존재만 본다. 내용 계약은
 *     `project-md-contract` 게이트(T-02)의 몫이다.
 *  6. **`IGNORED_RUNTIME_PATHS` 항목의 실재는 보지 않는다.** 런타임 산출물이라
 *     CI 신규 체크아웃에는 없기 때문이다(설계상 포기한 절반). 그래서 그 경로의
 *     기능이 **정말 동작하는지**는 이 게이트의 근거가 될 수 없다 — 표기가 거짓이
 *     아님만 본다. 대신 그 경로가 실제로 gitignore 대상인지는 `git check-ignore`
 *     로 잠근다(추적 파일을 몰래 실재 검사에서 빼내는 것을 막는 뒷문 잠금).
 *  7. **`ARTIBOT.md` 는 리포 루트 문서 링크 스캐너의 대상이 아니다.**
 *     `scripts/ci/ci-utils.js#ROOT_SCAN_FILES` 는 명시 allowlist 5종이고 거기에
 *     `ARTIBOT.md` 가 없다(실측 2026-09-02). 따라서 이 파일 안의 깨진 링크는
 *     `docs:check` 가 잡지 못하며, 이 게이트도 링크 도달성은 보지 않는다.
 *
 * @module tests/firewall/artibot-entry-parity
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** `<repo>/plugins/artibot/tests/firewall` 에서 네 단계 위가 리포 루트다. */
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const PLUGIN_ROOT = join(__dirname, '..', '..');

const ARTIBOT_MD = join(REPO_ROOT, 'ARTIBOT.md');
const ROOT_CLAUDE_MD = join(REPO_ROOT, 'CLAUDE.md');
const DESIGN_TEMPLATE = join(
  REPO_ROOT,
  '.artibot',
  'guides',
  'v5-design',
  'package-v1.1',
  '19_ARTIBOT_TEMPLATE.md',
);

/** 읽기 순서 항목에 붙일 수 있는 유일한 접미사. allowlist — 다른 표기는 없다. */
const NOT_LANDED = 'not yet landed';

/**
 * 런타임이 생성하고 `.gitignore` 되는 읽기 순서 항목 — **경로 allowlist**.
 *
 * 이 목록의 항목은 "기능으로는 착지했으나 파일은 추적되지 않는다". 그래서 판정이
 * 반쪽이다 —
 *   - 미착지 표기는 **없어야 한다**(남아 있으면 레드. fail-closed),
 *   - 실재는 **단언하지 않는다**(신규 체크아웃인 CI 에는 파일이 없다).
 *
 * ── 왜 `git check-ignore` 를 분기 조건으로 쓰지 않는가 ──────────────────────
 * 이유는 둘이고, 각각 독립적으로 치명적이다.
 *
 * (1) **`check-ignore` exit 0 은 "무시된다" 조차 신뢰할 수 없다.** 존재하지 않는
 *     디렉터리를 **뒤에 슬래시를 붙여** 물으면 git 은 빈 패턴을 근거로 0 을 준다.
 *     실측 2026-09-10 —
 *       `git check-ignore -v -- .artibot/missions/` → exit 0, `.gitignore:154:`
 *       `git check-ignore -v -- .artibot/zzz/`      → exit 0, `.gitignore:154:`  ← 없는 경로
 *       `git check-ignore -v -- .artibot/missions`  → exit 1 (슬래시만 뗀 것)
 *     `.gitignore:154` 는 **빈 줄**이고(`sed -n '154p' .gitignore | cat -A` → `$`),
 *     `.gitignore` 에서 missions 를 언급하는 곳은 :119 **주석** 한 줄뿐이다. 그 주석은
 *     오히려 missions 를 정본 추적 대상으로 적고 있다. 즉 **missions 는 무시 대상도
 *     아니고 실재하지도 않는다** — 이 파일의 이전 판(그리고 그 근거로 쓰인 리더 전제)은
 *     이 지점에서 틀렸었다.
 *
 * (2) 하필 `verifiablePath()` 가 읽기 순서 3·4(`Active mission …`)에 대해 돌려주는
 *     값이 **슬래시로 끝나는** `.artibot/missions/` 다(:217). 그래서 check-ignore 를
 *     분기로 쓰면 (1) 의 아티팩트만으로 missions 가 면제 분기로 쓸려 들어가, 아직
 *     실재하지 않는 missions 의 **정직한** 미착지 표기를 강제로 떼게 되고, missions 가
 *     실제로 착지하는 날을 이 게이트가 영영 못 보게 된다(fail-open).
 *
 * 정리하면 **check-ignore exit 0 은 "착지했다" 도 "무시된다" 도 함의하지 않는다.**
 * 그래서 "착지했다" 판정은 사람이 한 건씩 여기 적고, git 은 그 적힌 내용이 참인지
 * **검증만** 한다(아래 `allowlist 의 각 항목이 실제로 gitignore 되어 있다`).
 * 그 검증이 이 상수가 **추적 파일의 실재 검사를 빠져나가는 뒷문**이 되지 않게 하는
 * 잠금이며, 검증 자신이 (1) 에 당하지 않도록 **슬래시로 끝나는 항목을 먼저 거부**한다.
 */
const IGNORED_RUNTIME_PATHS = new Set([
  // 오너 결정 2026-09-10: 런타임이 이 파일을 실제로 쓰고 있다 = 착지. 표기 제거.
  // (`state_version` 은 세션 중에도 올라가는 값이라 여기 박지 않는다 — 재현 명령:
  //  `grep -m1 state_version .artibot/state.yaml`)
  '.artibot/state.yaml',
]);

/**
 * T-01 이전 루트 `CLAUDE.md` 의 내용 5줄. 어댑터는 **추가**이지 대체가 아니므로
 * 이 다섯 줄은 순서 그대로 살아 있어야 한다. 역사적 사실이라 여기 박아둔다 —
 * 파생할 소스가 없다(HEAD 를 읽으면 커밋 이후 자기 자신이 되어 공허해진다).
 */
const PRE_T01_CLAUDE_LINES = [
  '# Project Instructions',
  '',
  '## Artibot Integration',
  '',
  'See `~/.claude/rules/artibot/` for DEV Protocol, Agent Delegation, Quality Gates, and team auto-apply rules.',
];

/**
 * 진입 계약은 위키가 아니다(설계 package-v1.1 03 "Do not duplicate detailed
 * project instructions here"). 상한은 현재값(33줄/1287B, 2026-09-02 실측)의 약
 * 2배로 두어, 한 절이 늘어나는 정도는 통과시키되 문서가 이사 오는 것은 막는다.
 */
const MAX_ARTIBOT_LINES = 70;
const MAX_ARTIBOT_BYTES = 3000;

/**
 * CRLF/LF 무관하게 줄로 자른다. 이 리포의 워킹트리는 CRLF 다.
 * @param {string} text - 원문
 * @returns {string[]} 줄 배열
 */
function toLines(text) {
  return text.replace(/\r\n/g, '\n').split('\n');
}

/**
 * `## <heading>` 아래 다음 `## ` 전까지의 줄을 돌려준다.
 * @param {string} text - 마크다운 전문
 * @param {string} heading - `## ` 뒤의 제목
 * @returns {string[]|null} 절이 없으면 null
 */
function sectionLines(text, heading) {
  const lines = toLines(text);
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith('## '));
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * `1. foo` 형태의 순서 목록 본문만 순서대로 뽑는다.
 * @param {string} text - 마크다운 전문
 * @param {string} heading - 절 제목
 * @returns {string[]|null} 절이 없으면 null
 */
function orderedItems(text, heading) {
  const lines = sectionLines(text, heading);
  if (lines === null) return null;
  return lines
    .map((l) => /^\s*\d+\.\s+(.*\S)\s*$/.exec(l))
    .filter(Boolean)
    .map((m) => m[1]);
}

/**
 * `- foo` 형태의 불릿 본문만 순서대로 뽑는다.
 * @param {string} text - 마크다운 전문
 * @param {string} heading - 절 제목
 * @returns {string[]|null} 절이 없으면 null
 */
function bulletItems(text, heading) {
  const lines = sectionLines(text, heading);
  if (lines === null) return null;
  return lines
    .map((l) => /^\s*-\s+(.*\S)\s*$/.exec(l))
    .filter(Boolean)
    .map((m) => m[1]);
}

/**
 * 미착지 표기를 떼어낸다. 표기 유무 자체는 별도 단언이 본다.
 * @param {string} item - 목록 항목 본문
 * @returns {string} 표기를 뗀 본문
 */
function stripMarker(item) {
  return item.replace(new RegExp(`\\s*[—-]\\s*${NOT_LANDED}\\s*$`), '').trim();
}

/**
 * 백틱과 연속 공백만 지운다. 대소문자·구두점은 남긴다 — 정본과 글자 그대로 맞춰야 한다.
 * @param {string} item - 목록 항목 본문
 * @returns {string} 비교용 정규화 문자열
 */
function normalize(item) {
  return stripMarker(item).replace(/`/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * 읽기 순서 항목이 가리키는 **검증 가능한 리포 상대 경로**를 돌려준다.
 * 두 형태만 인정한다(allowlist):
 *   - 백틱 안에 `.artibot/…` 로 시작하는 경로가 있다.
 *   - 본문이 `Active mission` 으로 시작한다 → `.artibot/missions/`.
 * 그 밖은 null(= 이 게이트의 사각지대, 헤더 4번).
 *
 * @param {string} item - 목록 항목 본문
 * @returns {string|null} 리포 상대 경로 또는 null
 */
function verifiablePath(item) {
  const backticked = /`(\.artibot\/[^`]+)`/.exec(item);
  if (backticked) return backticked[1];
  if (/^Active mission\b/.test(stripMarker(item))) return '.artibot/missions/';
  return null;
}

/**
 * 슬래시로 끝나는 항목만 골라낸다 — 뒷문 잠금이 **자기 자신을 무력화당하지 않게**
 * 하는 술어.
 *
 * `git check-ignore -q -- '<없는 디렉터리>/'` 는 빈 패턴(`.gitignore:154:`)을 근거로
 * exit 0 을 준다(실측 2026-09-10: 없는 경로 `.artibot/zzz/` 가 `.artibot/missions/`
 * 와 동일 출력, 슬래시를 떼면 둘 다 exit 1). 그래서 슬래시로 끝나는 항목이
 * allowlist 에 들어오면 잠금이 **공허하게 초록**이 된다.
 *
 * 순수 함수로 뽑아 둔 이유는 자기검증 때문이다 — 실제 allowlist 에는 슬래시 항목이
 * 없어서, 인라인 `filter` 로 두면 그 줄을 통째로 지워도 스위트가 초록이다(양성 대조
 * 부재). 아래 자기검증이 이 함수에 슬래시 항목을 직접 먹여 그 구멍을 막는다.
 *
 * @param {string[]} rels - 검사할 리포 상대 경로 목록
 * @returns {string[]} 슬래시로 끝나는 항목(정상이면 빈 배열)
 */
function trailingSlashEntries(rels) {
  return rels.filter((r) => r.endsWith('/'));
}

/**
 * 표기·실재 대조의 (실제값, 기대값) 쌍을 만든다.
 *
 * **순수 함수다 — FS 도 git 도 보지 않는다.** 그래서 자기검증이 CI(파일 부재)와
 * 로컬(파일 존재) 양쪽을 실제 리포를 건드리지 않고 픽스처로 재현할 수 있다.
 *
 * @param {string} rel - 리포 상대 경로
 * @param {boolean} marked - 미착지 표기가 붙어 있는가
 * @param {boolean} exists - 실제로 존재하는가
 * @returns {{actual: object, expected: object}} 같으면 그린, 다르면 레드
 */
function parityVerdict(rel, marked, exists) {
  if (IGNORED_RUNTIME_PATHS.has(rel)) {
    // 실재를 비교 대상에서 **뺀다** — 있어도 없어도 판정이 같아야 한다.
    return { actual: { path: rel, marked }, expected: { path: rel, marked: false } };
  }
  return {
    actual: { path: rel, marked, exists },
    expected: { path: rel, marked: !exists, exists },
  };
}

const artibotText = existsSync(ARTIBOT_MD) ? readFileSync(ARTIBOT_MD, 'utf8') : null;
const claudeText = existsSync(ROOT_CLAUDE_MD) ? readFileSync(ROOT_CLAUDE_MD, 'utf8') : null;
const templateText = existsSync(DESIGN_TEMPLATE) ? readFileSync(DESIGN_TEMPLATE, 'utf8') : null;

describe('ARTIBOT.md 진입 계약 — 분모', () => {
  it('세 파일이 전부 실재한다 (하나라도 없으면 아래 단언은 공허하다)', () => {
    expect({
      artibot: artibotText !== null,
      claude: claudeText !== null,
      template: templateText !== null,
    }).toEqual({ artibot: true, claude: true, template: true });
  });

  it('설계 템플릿에서 비어 있지 않은 기대값이 파싱된다', () => {
    expect(orderedItems(templateText, 'Read Order').length).toBeGreaterThan(0);
    expect(bulletItems(templateText, 'Canonical Rules').length).toBeGreaterThan(0);
  });
});

describe('병존 — 어댑터는 추가이지 대체가 아니다', () => {
  it('루트 CLAUDE.md 가 ARTIBOT.md 를 가리킨다', () => {
    expect(claudeText).toContain('ARTIBOT.md');
  });

  it('T-01 이전 5줄이 순서 그대로 살아 있다', () => {
    const lines = toLines(claudeText).map((l) => l.replace(/\s+$/, ''));
    let cursor = -1;
    for (const expected of PRE_T01_CLAUDE_LINES) {
      const at = lines.indexOf(expected, cursor + 1);
      expect({ line: expected, found: at !== -1 }).toEqual({ line: expected, found: true });
      cursor = at;
    }
  });

  it('어댑터로 늘어난 비어 있지 않은 줄은 정확히 1줄이다', () => {
    const nonBlank = toLines(claudeText).filter((l) => l.trim() !== '');
    const baselineNonBlank = PRE_T01_CLAUDE_LINES.filter((l) => l.trim() !== '').length;
    expect(nonBlank.length).toBe(baselineNonBlank + 1);
  });

  it('별층 문서는 이 계약의 대상이 아니며 그대로 있다', () => {
    // 설계 §3.7: `plugins/artibot/CLAUDE.md`(개발자용) · `AGENTS.md`(타툴 투영)는
    // **별층 무변경**. ARTIBOT.md 가 이들을 대체했는지 여부를 존재로 확인한다.
    expect(existsSync(join(PLUGIN_ROOT, 'CLAUDE.md'))).toBe(true);
    expect(existsSync(join(PLUGIN_ROOT, 'AGENTS.md'))).toBe(true);
  });
});

describe('parity — ARTIBOT.md 가 설계 템플릿과 어긋나지 않는다', () => {
  it('읽기 순서가 템플릿과 항목·순서까지 같다', () => {
    const actual = orderedItems(artibotText, 'Read Order').map(normalize);
    const expected = orderedItems(templateText, 'Read Order').map(normalize);
    expect(actual).toEqual(expected);
  });

  it('정본 규칙이 템플릿과 항목·순서까지 같다', () => {
    const actual = bulletItems(artibotText, 'Canonical Rules').map(normalize);
    const expected = bulletItems(templateText, 'Canonical Rules').map(normalize);
    expect(actual).toEqual(expected);
  });

  it('진입 계약은 짧게 유지된다 (위키가 아니다)', () => {
    expect(toLines(artibotText).length).toBeLessThanOrEqual(MAX_ARTIBOT_LINES);
    expect(Buffer.byteLength(artibotText)).toBeLessThanOrEqual(MAX_ARTIBOT_BYTES);
  });
});

describe('미착지 표기 — 표기와 실제가 양방향으로 일치한다', () => {
  const items = orderedItems(artibotText ?? '', 'Read Order') ?? [];

  it('검증 가능한 항목이 최소 1건 있다 (분모)', () => {
    expect(items.filter((i) => verifiablePath(i) !== null).length).toBeGreaterThan(0);
  });

  it('실재까지 대조하는 항목이 최소 1건 남아 있다 (allowlist 가 게이트를 비우지 않았다)', () => {
    const stillChecked = items
      .map(verifiablePath)
      .filter((p) => p !== null && !IGNORED_RUNTIME_PATHS.has(p));
    expect(stillChecked.length).toBeGreaterThan(0);
  });

  it('allowlist 의 각 항목이 실제로 gitignore 되어 있다 (뒷문 잠금)', () => {
    const rels = [...IGNORED_RUNTIME_PATHS];

    const verdicts = rels.map((rel) => {
      try {
        // exit 0 = 무시됨. exit 1(비무시)·128(오류)·git 부재는 전부 throw → 불합격.
        execFileSync('git', ['check-ignore', '-q', '--', rel], {
          cwd: REPO_ROOT,
          stdio: 'ignore',
        });
        return { path: rel, ignored: true };
      } catch {
        return { path: rel, ignored: false };
      }
    });
    // 슬래시 검사와 무시 판정을 **한 단언으로 묶는다.** 따로 두면 슬래시 검사 줄만
    // 지워도 스위트가 초록이라(실측: 그 변이가 26 passed 통과) 잠금이 조용히 빠진다.
    // 한 객체로 묶으면 키를 빼는 순간 구조가 어긋나 레드다 — 두 곳을 협조 편집해야만
    // 지울 수 있고, 그건 테스트를 통째로 지우는 것과 같은 수준의 행위다.
    // 슬래시 항목을 거부하는 사유는 `trailingSlashEntries` JSDoc 참조.
    expect({ trailingSlash: trailingSlashEntries(rels), verdicts }).toEqual({
      trailingSlash: [],
      verdicts: rels.map((rel) => ({ path: rel, ignored: true })),
    });
  });

  for (const item of items) {
    const rel = verifiablePath(item);
    if (rel === null) continue;
    const marked = item.includes(NOT_LANDED);
    const label = IGNORED_RUNTIME_PATHS.has(rel)
      ? `${rel} — 런타임 산출물: 표기(${marked ? '미착지' : '착지'})만 보고 실재는 묻지 않는다`
      : `${rel} — 표기(${marked ? '미착지' : '착지'})와 실제 존재가 일치한다`;
    it(label, () => {
      const exists = existsSync(join(REPO_ROOT, rel));
      const { actual, expected } = parityVerdict(rel, marked, exists);
      expect(actual).toEqual(expected);
    });
  }
});

describe('스캐너 자기검증 — 추출기가 실제로 드리프트를 본다', () => {
  const GOOD = [
    '# ARTIBOT',
    '',
    '## Read Order',
    '',
    '1. `.artibot/project.md` — not yet landed',
    '2. `.artibot/state.yaml`',
    '3. Active mission `intent.md`',
    '',
    '## Canonical Rules',
    '',
    '- Rule one.',
    '- Rule two.',
  ].join('\n');

  it('절이 없으면 null 을 돌려준다 (빈 배열로 통과하지 않는다)', () => {
    expect(orderedItems('# ARTIBOT\n', 'Read Order')).toBeNull();
    expect(bulletItems('# ARTIBOT\n', 'Canonical Rules')).toBeNull();
  });

  it('절 경계를 넘어가 다음 절 항목을 빨아들이지 않는다', () => {
    expect(orderedItems(GOOD, 'Read Order')).toHaveLength(3);
    expect(bulletItems(GOOD, 'Canonical Rules')).toHaveLength(2);
  });

  it('순서가 바뀌면 비교가 실패한다 (집합 비교로 새지 않는다)', () => {
    const swapped = GOOD.replace(
      '1. `.artibot/project.md` — not yet landed\n2. `.artibot/state.yaml`',
      '1. `.artibot/state.yaml`\n2. `.artibot/project.md` — not yet landed',
    );
    const a = orderedItems(GOOD, 'Read Order').map(normalize);
    const b = orderedItems(swapped, 'Read Order').map(normalize);
    expect(a).not.toEqual(b);
    expect([...a].sort()).toEqual([...b].sort());
  });

  it('항목이 하나 사라지면 비교가 실패한다', () => {
    const dropped = GOOD.replace('3. Active mission `intent.md`\n', '');
    expect(orderedItems(dropped, 'Read Order').map(normalize)).not.toEqual(
      orderedItems(GOOD, 'Read Order').map(normalize),
    );
  });

  it('미착지 표기는 비교에서만 벗겨지고 탐지에는 남는다', () => {
    const items = orderedItems(GOOD, 'Read Order');
    expect(normalize(items[0])).toBe('.artibot/project.md');
    expect(items[0].includes(NOT_LANDED)).toBe(true);
    expect(items[1].includes(NOT_LANDED)).toBe(false);
  });

  it('검증 가능한 경로만 골라낸다', () => {
    const items = orderedItems(GOOD, 'Read Order');
    expect(items.map(verifiablePath)).toEqual([
      '.artibot/project.md',
      '.artibot/state.yaml',
      '.artibot/missions/',
    ]);
    expect(verifiablePath('Relevant ADRs')).toBeNull();
    expect(verifiablePath('Review / Outcome when applicable')).toBeNull();
  });

  /**
   * `parityVerdict` 결과가 그린인지 **boolean 으로** 답한다.
   *
   * `toEqual` 로 대체할 수 없다 — 그건 단언이라 값을 안 준다. 네 경우의 통과/실패를
   * **한 배열로 한 번에** 비교하려면 술어가 필요하다. 두 객체 다 `parityVerdict`
   * 안에서 같은 키 순서의 평평한 리터럴로 만들어지므로 직렬화 비교로 충분하고,
   * 혹시 순서가 어긋나면 여기가 레드가 난다(fail-closed — 조용히 통과하지 않는다).
   *
   * @param {{actual: object, expected: object}} v - parityVerdict 결과
   * @returns {boolean} 그린이면 true
   */
  const agrees = (v) => JSON.stringify(v.actual) === JSON.stringify(v.expected);

  it('런타임 allowlist 항목 — 표기 부재는 실재와 무관하게 통과, 표기 잔존은 레드', () => {
    const rel = '.artibot/state.yaml';
    expect(IGNORED_RUNTIME_PATHS.has(rel)).toBe(true);

    // [표기, 실재] → 통과 여부. 3·4행이 CI(신규 체크아웃, 파일 부재) 시나리오다.
    const cases = [
      [false, true],
      [true, true],
      [false, false],
      [true, false],
    ];
    expect(cases.map(([m, e]) => agrees(parityVerdict(rel, m, e)))).toEqual([
      true, // 표기 없음 + 로컬 존재  → 그린
      false, // 표기 남음 + 로컬 존재  → 레드 (썩은 표기)
      true, // 표기 없음 + CI 부재    → 그린 ← 이 분기가 이번 변경의 목적
      false, // 표기 남음 + CI 부재    → 레드 (fail-closed: 무시 경로도 표기는 금지)
    ]);

    // 실재를 아예 단언 대상에 넣지 않는다(있음/없음이 같은 판정을 낸다).
    expect('exists' in parityVerdict(rel, false, true).actual).toBe(false);
    expect(parityVerdict(rel, false, true)).toEqual(parityVerdict(rel, false, false));
  });

  it('allowlist 밖 경로는 양방향 대조가 그대로다 (기존 계약 무변경)', () => {
    const rel = '.artibot/project.md';
    expect(IGNORED_RUNTIME_PATHS.has(rel)).toBe(false);

    const cases = [
      [false, true],
      [true, false],
      [false, false],
      [true, true],
    ];
    expect(cases.map(([m, e]) => agrees(parityVerdict(rel, m, e)))).toEqual([
      true, // 착지 표기 + 실재    → 그린
      true, // 미착지 표기 + 부재  → 그린
      false, // 표기 없는데 부재    → 레드 (allowlist 밖이면 CI 부재도 레드가 맞다)
      false, // 표기 있는데 실재    → 레드 (썩은 표기)
    ]);
  });

  it('슬래시로 끝나는 allowlist 항목을 실제로 집어낸다 (뒷문 잠금의 양성 대조)', () => {
    // 양성 대조 — 실제 allowlist 에는 슬래시 항목이 **없어서** 잠금 쪽 단언만으로는
    // 이 술어가 동작하는지 증명되지 않는다(항상 빈 배열이라 술어를 망가뜨려도 초록).
    // 그래서 여기서 슬래시 항목을 직접 먹인다. 리포에는 아무것도 쓰지 않는다.
    expect(trailingSlashEntries(['.artibot/missions/'])).toEqual(['.artibot/missions/']);

    // 섞여 있어도 슬래시 항목만 골라내고, 순서를 보존한다.
    expect(
      trailingSlashEntries(['.artibot/state.yaml', '.artibot/missions/', '.artibot/adr/']),
    ).toEqual(['.artibot/missions/', '.artibot/adr/']);

    // 음성 대조 — 슬래시가 없으면 빈 배열. 현재 allowlist 가 여기 해당한다.
    expect(trailingSlashEntries(['.artibot/state.yaml'])).toEqual([]);
    expect(trailingSlashEntries([])).toEqual([]);
    expect(trailingSlashEntries([...IGNORED_RUNTIME_PATHS])).toEqual([]);
  });

  it('어댑터 없는 CLAUDE.md 를 통과시키지 않는다', () => {
    expect(PRE_T01_CLAUDE_LINES.join('\n')).not.toContain('ARTIBOT.md');
  });
});
