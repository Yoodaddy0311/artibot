/**
 * 검사 목적: 유니코드 위생 가드 — skills/·commands/·agents/ 전 .md 파일에서
 * 보이지 않는(invisible) / 양방향(bidi) 제어 문자가 0건임을 단언한다.
 *
 * Trojan Source 공격(CVE-2021-42574, Boucher & Anderson 2021)은 Unicode 양방향
 * override 문자(U+202A~U+202E)와 isolate 문자(U+2066~U+2069)를 사용해 소스/문서의
 * 시각적 렌더링과 논리적 바이트 순서를 어긋나게 만든다. 동일하게 zero-width 문자
 * (U+200B~U+200F)는 트리거 발화·프론트매터에 숨은 글자를 심어 스킬 매칭이나 리뷰를
 * 우회할 수 있다. 같은 부류로 word joiner·보이지 않는 연산자(U+2060~U+2064),
 * BOM/zero-width no-break space(U+FEFF), soft hyphen(U+00AD), Arabic letter
 * mark(U+061C)도 화면에는 안 보이고 바이트에는 남는다. 마크다운 지침 파일은 모델
 * 행동을 직접 좌우하므로 이 영역의 은닉 문자는 prompt-injection 벡터가 된다.
 *
 * 실측(2026-10-20, 이 테스트가 훑는 skills/·commands/·agents/ 의 .md 339개): 위 범위
 * 전체 0건. 같은 스캐너가 같은 파일들에서 U+2014(em dash)를 3천 건 넘게 잡는 것을
 * 양성 대조로 확인했다. 리포 전체 추적 텍스트 파일(약 2,400개)에는 의도된 fixture 3개가
 * 있다 — tests/core/test-status.test.js(U+202E 1), tests/git/split-run-file.test.js ·
 * tests/scripts/task-feed-user-switch.test.js(U+FEFF 각 1). 스캔 범위를 이 3개 디렉토리
 * 밖으로 넓힌다면 이 셋을 사유와 함께 따로 면제해야 한다.
 *
 * data-policy-outbound-guard.test.js 패턴 미러: 디렉토리 부재 시 skip(리네임 내성),
 * 단 대상 디렉토리 3개가 모두 부재하면 스위트 자체를 fail시켜 설정 오류를 조기 감지.
 *
 * @module tests/ci/unicode-hygiene
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** 플러그인 루트 (`plugins/artibot/`) */
const PLUGIN_ROOT = join(__dirname, '..', '..');

/** 스캔 대상 디렉토리 (플러그인 루트 기준 상대 경로). */
const TARGET_DIRS = ['skills', 'commands', 'agents'];

/**
 * 금지 코드포인트 범위 목록(코드포인트 오름차순). 각 항목은 [start, end] inclusive 범위와 라벨.
 * tests/vendor/rea-vendor.test.js 의 HIDDEN_RE 가 같은 8개 범위를 반복한다 — 한쪽을 바꾸면 다른 쪽도 바꾼다.
 * - U+00AD: soft hyphen (렌더링에서 사라지는 하이픈)
 * - U+061C: Arabic letter mark (방향 표식)
 * - U+200B~U+200F: zero-width space/joiner/non-joiner + LTR/RTL mark
 * - U+202A~U+202E: bidi embedding/override (Trojan Source 핵심)
 * - U+2060~U+2064: word joiner + function application / invisible times / separator / plus
 * - U+2066~U+2069: bidi isolate (Trojan Source 핵심)
 * - U+FEFF: BOM / zero-width no-break space
 * - U+E0000~U+E007F: Unicode Tags block (은닉 ASCII 인코딩 채널)
 */
const FORBIDDEN_RANGES = [
  { start: 0x00ad, end: 0x00ad, label: 'soft hyphen (U+00AD)' },
  { start: 0x061c, end: 0x061c, label: 'Arabic letter mark (U+061C)' },
  { start: 0x200b, end: 0x200f, label: 'zero-width / directional mark (U+200B–U+200F)' },
  { start: 0x202a, end: 0x202e, label: 'bidi embedding/override (U+202A–U+202E)' },
  { start: 0x2060, end: 0x2064, label: 'word joiner / invisible operator (U+2060–U+2064)' },
  { start: 0x2066, end: 0x2069, label: 'bidi isolate (U+2066–U+2069)' },
  { start: 0xfeff, end: 0xfeff, label: 'BOM / zero-width no-break space (U+FEFF)' },
  { start: 0xe0000, end: 0xe007f, label: 'Unicode Tags block (U+E0000–U+E007F)' },
];

/**
 * 디렉토리를 재귀 순회하며 .md 파일의 절대 경로를 수집한다.
 *
 * @param {string} dir - 순회 시작 절대 경로.
 * @returns {string[]} .md 파일 절대 경로 배열.
 */
function collectMarkdown(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectMarkdown(abs));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      out.push(abs);
    }
  }
  return out;
}

/**
 * 텍스트에서 금지 코드포인트의 첫 매치를 찾아 보고용 정보를 반환한다.
 *
 * @param {string} text - 파일 내용.
 * @returns {Array<{cp:string, label:string, line:number, col:number}>} 위반 목록.
 */
function findForbidden(text) {
  const hits = [];
  const lines = text.split('\n');
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    for (const ch of line) {
      const cp = ch.codePointAt(0);
      const range = FORBIDDEN_RANGES.find((r) => cp >= r.start && cp <= r.end);
      if (range) {
        hits.push({
          cp: 'U+' + cp.toString(16).toUpperCase().padStart(4, '0'),
          label: range.label,
          line: li + 1,
          col: line.indexOf(ch) + 1,
        });
      }
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// 디렉토리 존재 여부 사전 집계 (전부 부재 → 스위트 fail)
// ---------------------------------------------------------------------------

const dirStatuses = TARGET_DIRS.map((rel) => {
  const abs = join(PLUGIN_ROOT, rel);
  return { rel, abs, exists: existsSync(abs) && statSync(abs).isDirectory() };
});

const existingDirs = dirStatuses.filter((d) => d.exists);
const allAbsent = existingDirs.length === 0;

describe('Unicode hygiene — invisible/bidi control chars (Trojan Source CVE-2021-42574)', () => {
  it('대상 디렉토리가 1개 이상 존재해야 한다 (설정 오류 감지)', () => {
    if (allAbsent) {
      throw new Error(
        '유니코드 위생 가드: 스캔 대상 디렉토리 3개가 모두 부재합니다. ' +
          'PLUGIN_ROOT 경로 또는 디렉토리명이 변경되었는지 확인하세요.\n' +
          `PLUGIN_ROOT: ${PLUGIN_ROOT}\n` +
          `대상: ${TARGET_DIRS.join(', ')}`,
      );
    }
    expect(existingDirs.length).toBeGreaterThan(0);
  });

  for (const { rel, abs, exists } of dirStatuses) {
    describe(`디렉토리: ${rel}`, () => {
      if (!exists) {
        it.skip('디렉토리 부재 — skip (미래 리네임 내성)', () => {});
        return;
      }

      const files = collectMarkdown(abs);

      it('스캔할 .md 파일이 1개 이상 존재한다', () => {
        expect(files.length).toBeGreaterThan(0);
      });

      for (const file of files) {
        const relPath = relative(PLUGIN_ROOT, file);
        it(`보이지 않는 문자 0건: ${relPath}`, () => {
          const text = readFileSync(file, 'utf-8');
          const hits = findForbidden(text);
          const detail = hits
            .map((h) => `${h.cp} (${h.label}) @ ${h.line}:${h.col}`)
            .join('; ');
          expect(hits, `Trojan Source 위험 문자 발견 — ${relPath}: ${detail}`).toHaveLength(0);
        });
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 스캐너 자기검증 — 범위를 넓힌 게이트가 거짓 그린이 되지 않도록 각 범위의 양 끝과
// 바로 바깥 코드포인트를 findForbidden 에 직접 먹여 본다. 위의 "0건" 테스트는 파일에
// 해당 문자가 없을 때도 통과하므로, 스캐너가 그 문자를 실제로 보는지는 여기서만 증명된다.
// ---------------------------------------------------------------------------

describe('Unicode hygiene — findForbidden 자기검증', () => {
  const label = (cp) => 'U+' + cp.toString(16).toUpperCase().padStart(4, '0');
  const inRanges = (cp) => FORBIDDEN_RANGES.some((r) => cp >= r.start && cp <= r.end);
  const outside = FORBIDDEN_RANGES.flatMap((r) => [r.start - 1, r.end + 1]).filter((cp) => !inRanges(cp));
  // 승인된 목록(각 범위의 양 끝과 대표값)을 표에서 유도하지 않고 그대로 적는다: 표에서 범위를 지우면 여기서 빨강이 된다.
  const REQUIRED = [
    0x00ad, 0x061c, 0x200b, 0x200f, 0x202a, 0x202e, 0x2060, 0x2062, 0x2064, 0x2066, 0x2069, 0xfeff, 0xe0000, 0xe0041, 0xe007f,
  ];

  it('범위는 오름차순이고 서로 겹치지 않는다', () => {
    for (let i = 1; i < FORBIDDEN_RANGES.length; i++) {
      expect(FORBIDDEN_RANGES[i].start).toBeGreaterThan(FORBIDDEN_RANGES[i - 1].end);
    }
  });

  it.each(REQUIRED.map((cp) => [label(cp), cp]))('필수 코드포인트 %s 는 잡는다', (_name, cp) => {
    expect(findForbidden(`a${String.fromCodePoint(cp)}b`).map((h) => h.cp)).toEqual([label(cp)]);
  });

  it.each(outside.map((cp) => [label(cp), cp]))('범위 바로 바깥 %s 는 잡지 않는다', (_name, cp) => {
    expect(findForbidden(`a${String.fromCodePoint(cp)}b`)).toEqual([]);
  });

  it('파일 맨 앞 BOM 을 잡고, 한글·em dash·화살표·NBSP 같은 보이는 글자는 잡지 않는다', () => {
    expect(findForbidden(`${String.fromCodePoint(0xfeff)}# 제목`)).toEqual([expect.objectContaining({ cp: 'U+FEFF', line: 1, col: 1 })]);
    expect(findForbidden(`한국어 — 화살표 → 그리고${String.fromCodePoint(0xa0)}공백`)).toEqual([]);
  });

  it('tests/vendor/rea-vendor.test.js 의 HIDDEN_RE 가 같은 범위를 반복한다 (한쪽만 바뀌면 빨강)', () => {
    const source = readFileSync(join(__dirname, '..', 'vendor', 'rea-vendor.test.js'), 'utf-8');
    const body = /const HIDDEN_RE = \/\[(.+)\]\/u;/.exec(source)?.[1];
    expect(body, 'HIDDEN_RE 정의를 못 찾았다').toBeDefined();
    const repeated = [...body.matchAll(/\\u\{([0-9A-Fa-f]+)\}(?:-\\u\{([0-9A-Fa-f]+)\})?/g)]
      .map(([, a, b]) => [parseInt(a, 16), parseInt(b ?? a, 16)]);
    expect(repeated).toEqual(FORBIDDEN_RANGES.map((r) => [r.start, r.end]));
  });
});
