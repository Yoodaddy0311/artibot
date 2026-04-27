/**
 * PRD generator for autopilot sessions.
 * Renders a markdown PRD from a free-form task and writes it to docs/PRD/.
 *
 * Reference: PRD docs/PRD/autopilot-mode.md sections 5.4, 6.
 *
 * @module lib/autopilot/prd-generator
 */

import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { getPluginRoot } from '../core/platform.js';

/**
 * Resolve the project root one level above the plugin root.
 * @returns {string}
 */
function getProjectRoot() {
  return path.resolve(getPluginRoot(), '..', '..');
}

/**
 * Build a slug suitable for filenames from a Korean/English task string.
 * Keeps Hangul, ASCII letters, digits; replaces other runs with '-'.
 * Caps at 60 visible characters.
 * @param {string} text
 * @returns {string}
 */
export function slugify(text) {
  if (!text || typeof text !== 'string') return 'task';
  let slug = text
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length > 60) slug = slug.slice(0, 60).replace(/-+$/g, '');
  return slug || 'task';
}

/**
 * Format a date as YYYY-MM-DD for the PRD header.
 * @param {Date} d
 * @returns {string}
 */
function isoDate(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

/**
 * Escape a markdown table cell: convert `|` to `\|`, collapse newlines, truncate.
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
function escapeCell(text, max = 200) {
  const s = String(text ?? '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/**
 * Render the Prior Lessons section. Returns empty string if no lessons.
 * @param {Array<object>} lessons
 * @returns {string}
 */
function renderPriorLessons(lessons) {
  if (!Array.isArray(lessons) || lessons.length === 0) return '';
  const rows = lessons.map((l) => {
    const ts = escapeCell(l?.ts || '', 40);
    const src = escapeCell(l?.sourcePhase || l?.sessionId || '', 60);
    const body = escapeCell(l?.lesson || '', 200);
    return `| ${ts} | ${src} | ${body} |`;
  }).join('\n');
  return `## Prior Lessons

이전 세션에서 추출된 학습 (자동 회수, 외부 송신 0):

| ts | source | lesson |
|----|--------|--------|
${rows}

`;
}

/**
 * Render the PRD body. Pure function — no I/O.
 * @param {{ task: string, sessionId: string, options?: object, priorLessons?: Array<object> }} input
 * @returns {string}
 */
export function renderPRD({ task, sessionId, options = {}, priorLessons }) {
  const safeTask = (task || '').trim() || '(작업 설명 없음)';
  const created = isoDate();
  const mode = options.mode || 'default';
  const maxDuration = options.maxDuration || '4h';
  const budget = options.budget ?? 2_000_000;
  const priorSection = renderPriorLessons(priorLessons);

  return `# PRD: ${safeTask}

- 상태: DRAFT (Autopilot Phase 0)
- 세션: \`${sessionId}\`
- 작성일: ${created}
- 모드: ${mode}
- 최대 실행시간: ${maxDuration}
- 토큰 예산: ${budget}

---

${priorSection}## 1. 배경

본 PRD는 Autopilot 엔진이 수신한 사용자 요청을 분해하고, Phase 1~6을 위한 합의된 명세로 변환하기 위해 자동 생성되었다.

원본 요청:

> ${safeTask.replace(/\n/g, '\n> ')}

## 2. 목표

| ID | 목표 | 측정 지표 |
|----|------|-----------|
| G1 | 요청된 작업의 자율 완수 | Phase 6 완료 보고서 생성 |
| G2 | 안전 정책 준수 | 위험 액션 0건 또는 사용자 승인 통과 |
| G3 | 검증 통과 | npm run ci 통과 |

## 3. 범위 (Scope)

- 본 작업 디렉토리 내부에서만 변경
- 외부 DB / 외부 플러그인 / 외부 API 호출 금지 (DATA POLICY)
- 사용자 동의 없는 destructive action 금지

## 4. 사용자 시나리오

1. 사용자가 자율 모드로 본 작업을 위임한다.
2. Autopilot이 PRD → Plan → Execute → Cross-check → Verify → Improve → Report 순서로 진행한다.
3. 위험 발생 시 일시정지하고 사용자 큐에 결정 항목을 추가한다.

## 5. 산출물 (Deliverables)

| # | 산출물 | 비고 |
|---|--------|------|
| D1 | 구현 코드 변경 | Phase 2 결과 |
| D2 | Cross-check 보고 | Phase 3 결과 |
| D3 | 검증 결과 (lint/test/build) | Phase 4 결과 |
| D4 | 개선/미래 제안 | Phase 5 결과 |
| D5 | 완료 보고서 | reports/AUTOPILOT/${sessionId}.md |

## 6. 위험 및 완화

| 위험 | 영향 | 완화 |
|------|------|------|
| 잘못된 방향 자율 진행 | 大 | 30분 WIP commit + ${maxDuration} timeout |
| 컨텍스트 압축 손실 | 中 | PRD/세션 상태 파일 영속 |
| 비용 초과 | 中 | 토큰 예산 ${budget} 초과 시 pause |
| 위험 액션 발생 | 大 | safety.classifyRisk 자동 차단 |

## 7. 수락 기준 (Acceptance Criteria)

- [ ] 요청된 작업의 모든 항목이 Phase 2에서 구현됨
- [ ] Phase 3 cross-check 통과
- [ ] Phase 4 \`npm run ci\` 통과
- [ ] Phase 5 개선 제안 1건 이상
- [ ] Phase 6 완료 보고서 생성

## 8. 변경 이력

| 일자 | 작성자 | 변경 |
|------|--------|------|
| ${created} | Autopilot (${sessionId}) | 자동 생성 |
`;
}

/**
 * Generate a PRD file for the given task.
 * Writes to docs/PRD/{slug}-{sessionId}.md under the project root.
 * @param {{ task: string, sessionId: string, options?: object, priorLessons?: Array<object> }} args
 * @returns {{ filePath: string, content: string, slug: string }}
 */
export function generatePRD({ task, sessionId, options = {}, priorLessons }) {
  if (!sessionId || typeof sessionId !== 'string') {
    throw new TypeError('sessionId is required');
  }
  const slug = slugify(task);
  const fileName = `${slug}-${sessionId}.md`;
  const filePath = path.join(getProjectRoot(), 'docs', 'PRD', fileName);
  const lessons = priorLessons ?? options.priorLessons;
  const content = renderPRD({ task, sessionId, options, priorLessons: lessons });
  try {
    mkdirSync(dirname(filePath), { recursive: true });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  writeFileSync(filePath, content, 'utf-8');
  return { filePath, content, slug };
}
