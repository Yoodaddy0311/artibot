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
 *  6. **`ARTIBOT.md` 는 리포 루트 문서 링크 스캐너의 대상이 아니다.**
 *     `scripts/ci/ci-utils.js#ROOT_SCAN_FILES` 는 명시 allowlist 5종이고 거기에
 *     `ARTIBOT.md` 가 없다(실측 2026-09-02). 따라서 이 파일 안의 깨진 링크는
 *     `docs:check` 가 잡지 못하며, 이 게이트도 링크 도달성은 보지 않는다.
 *
 * @module tests/firewall/artibot-entry-parity
 */

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

  for (const item of items) {
    const rel = verifiablePath(item);
    if (rel === null) continue;
    const marked = item.includes(NOT_LANDED);
    it(`${rel} — 표기(${marked ? '미착지' : '착지'})와 실제 존재가 일치한다`, () => {
      const exists = existsSync(join(REPO_ROOT, rel));
      expect({ path: rel, marked, exists }).toEqual({ path: rel, marked: !exists, exists });
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

  it('어댑터 없는 CLAUDE.md 를 통과시키지 않는다', () => {
    expect(PRE_T01_CLAUDE_LINES.join('\n')).not.toContain('ARTIBOT.md');
  });
});
