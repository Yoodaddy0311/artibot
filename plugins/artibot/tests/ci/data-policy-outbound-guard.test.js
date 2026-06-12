/**
 * 검사 목적: DATA POLICY 정적 가드 — 모델 경제 모듈은 순수 로컬 연산이어야 함.
 *
 * 외부 DB 접근, 외부 플러그인 연결, 외부 데이터 송신을 금지하는 Artibot DATA POLICY를
 * 정적 소스 스캔으로 강제한다. 아래 대상 파일 각각에서 outbound 네트워크 패턴이 0건임을
 * 단언한다. 파일이 존재하지 않으면 해당 항목은 skip 처리(미래 리네임 내성). 단, 대상
 * 5개 파일이 모두 부재하면 테스트 스위트 자체를 fail시켜 설정 오류를 조기 감지한다.
 *
 * @module tests/ci/data-policy-outbound-guard
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** 플러그인 루트 (`plugins/artibot/`) */
const PLUGIN_ROOT = join(__dirname, '..', '..');

/**
 * 스캔 대상 파일 목록 (플러그인 루트 기준 상대 경로).
 * 이번 업그레이드의 신규/핵심 모델 경제 모듈.
 */
const TARGET_FILES = [
  'lib/core/model-catalog.js',
  'lib/core/model-policy.js',
  'lib/planning/session-sizer.js',
  'lib/runtime/task-budget.js',
  'scripts/gen-model-catalog-docs.js',
];

/**
 * outbound 네트워크 호출을 나타내는 정규식 패턴 목록.
 * 각 패턴에 매치가 발생하면 DATA POLICY 위반으로 간주한다.
 */
const OUTBOUND_PATTERNS = [
  { label: 'fetch()', pattern: /\bfetch\s*\(/ },
  { label: 'http/https URL literal (non-localhost)', pattern: /\bhttps?:\/\/(?!localhost|127\.0\.0\.1)/ },
  { label: "require('http'/'https')", pattern: /require\(['"]https?['"]\)/ },
  { label: "import from 'node:http'/'node:https'", pattern: /from\s+['"]node:https?['"]/ },
  { label: 'axios / node-fetch / undici', pattern: /\b(?:axios|node-fetch|undici)\b/ },
];

// ---------------------------------------------------------------------------
// 파일 존재 여부 사전 집계 (전부 부재 → 스위트 fail)
// ---------------------------------------------------------------------------

const fileStatuses = TARGET_FILES.map((rel) => ({
  rel,
  abs: join(PLUGIN_ROOT, rel),
  exists: existsSync(join(PLUGIN_ROOT, rel)),
}));

const existingFiles = fileStatuses.filter((f) => f.exists);
const allAbsent = existingFiles.length === 0;

describe('DATA POLICY — outbound network guard (model economy modules)', () => {
  it('대상 파일이 1개 이상 존재해야 한다 (설정 오류 감지)', () => {
    if (allAbsent) {
      throw new Error(
        'DATA POLICY 가드: 스캔 대상 파일 5개가 모두 부재합니다. ' +
          'PLUGIN_ROOT 경로 또는 파일명이 변경되었는지 확인하세요.\n' +
          `PLUGIN_ROOT: ${PLUGIN_ROOT}\n` +
          `대상: ${TARGET_FILES.join(', ')}`,
      );
    }
    expect(existingFiles.length).toBeGreaterThan(0);
  });

  for (const { rel, abs, exists } of fileStatuses) {
    describe(`파일: ${rel}`, () => {
      if (!exists) {
        it.skip('파일 부재 — skip (미래 리네임 내성)', () => {});
        return;
      }

      const source = readFileSync(abs, 'utf-8');

      for (const { label, pattern } of OUTBOUND_PATTERNS) {
        it(`outbound 패턴 "${label}" 0건`, () => {
          const matches = source.match(new RegExp(pattern.source, 'g')) ?? [];
          expect(matches).toHaveLength(0);
        });
      }
    });
  }
});
