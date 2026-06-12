/**
 * 검사 목적: 유니코드 위생 가드 — skills/·commands/·agents/ 전 .md 파일에서
 * 보이지 않는(invisible) / 양방향(bidi) 제어 문자가 0건임을 단언한다.
 *
 * Trojan Source 공격(CVE-2021-42574, Boucher & Anderson 2021)은 Unicode 양방향
 * override 문자(U+202A~U+202E)와 isolate 문자(U+2066~U+2069)를 사용해 소스/문서의
 * 시각적 렌더링과 논리적 바이트 순서를 어긋나게 만든다. 동일하게 zero-width 문자
 * (U+200B~U+200F)는 트리거 발화·프론트매터에 숨은 글자를 심어 스킬 매칭이나 리뷰를
 * 우회할 수 있다. 마크다운 지침 파일은 모델 행동을 직접 좌우하므로 이 영역의 은닉
 * 문자는 prompt-injection 벡터가 된다.
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
 * 금지 코드포인트 범위 목록. 각 항목은 [start, end] inclusive 범위와 라벨.
 * - U+200B~U+200F: zero-width space/joiner/non-joiner + LTR/RTL mark
 * - U+202A~U+202E: bidi embedding/override (Trojan Source 핵심)
 * - U+2066~U+2069: bidi isolate (Trojan Source 핵심)
 * - U+E0000~U+E007F: Unicode Tags block (은닉 ASCII 인코딩 채널)
 */
const FORBIDDEN_RANGES = [
  { start: 0x200b, end: 0x200f, label: 'zero-width / directional mark (U+200B–U+200F)' },
  { start: 0x202a, end: 0x202e, label: 'bidi embedding/override (U+202A–U+202E)' },
  { start: 0x2066, end: 0x2069, label: 'bidi isolate (U+2066–U+2069)' },
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
