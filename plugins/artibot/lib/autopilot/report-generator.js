/**
 * Autopilot report generator.
 * Renders the completion report for a session and writes it to reports/AUTOPILOT/.
 *
 * Reference: PRD docs/PRD/autopilot-mode.md section 13.5.
 *
 * @module lib/autopilot/report-generator
 */

import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { getPluginRoot } from '../core/platform.js';
import { loadSession } from './session-store.js';

/**
 * @returns {string} project root one level above plugin root
 */
function getProjectRoot() {
  return path.resolve(getPluginRoot(), '..', '..');
}

/**
 * Format a row of the Phase results table.
 * @param {object} phase
 * @returns {string}
 */
function phaseRow(phase) {
  const name = phase?.name || '?';
  const status = phase?.status || '?';
  const duration = phase?.durationMs ? `${Math.round(phase.durationMs / 1000)}s` : '-';
  const files = phase?.changedFiles ?? '-';
  const checks = phase?.checks || '-';
  return `| ${name} | ${status} | ${duration} | ${files} | ${checks} |`;
}

/**
 * Render markdown report from a session state object.
 * @param {object} state
 * @returns {string}
 */
export function renderReport(state) {
  if (!state || typeof state !== 'object') {
    throw new TypeError('state object required');
  }
  const phases = Array.isArray(state.phases) ? state.phases : [];
  const checkpoints = Array.isArray(state.checkpoints) ? state.checkpoints : [];
  const queued = Array.isArray(state.queuedQuestions) ? state.queuedQuestions : [];
  const errors = Array.isArray(state.errors) ? state.errors : [];
  const improvements = Array.isArray(state.improvements) ? state.improvements : [];
  const future = Array.isArray(state.futurePlans) ? state.futurePlans : [];
  const verify = state.verifyResult || {};

  const phaseTable = phases.length
    ? ['| Phase | Status | Duration | Changed Files | Checks |',
       '|-------|--------|----------|---------------|--------|',
       ...phases.map(phaseRow)].join('\n')
    : '_(Phase 결과 없음)_';

  const commitList = checkpoints.length
    ? checkpoints.map((c) => `- \`${c.sha || 'n/a'}\` (${c.phase || '-'}) @ ${c.ts || '-'}`).join('\n')
    : '_(커밋 없음)_';

  const crossCheck = state.crossCheck
    ? `- **Reviewer 결론**: ${state.crossCheck.verdict || '-'}\n- **노트**: ${state.crossCheck.notes || '-'}`
    : '_(Cross-check 결과 없음)_';

  const verifyBlock = [
    `- lint: ${verify.lint || '-'}`,
    `- typecheck: ${verify.typecheck || '-'}`,
    `- test: ${verify.test || '-'}`,
    `- build: ${verify.build || '-'}`,
  ].join('\n');

  const improvementsBlock = improvements.length
    ? improvements.map((s, i) => `${i + 1}. ${s}`).join('\n')
    : '_(개선 제안 없음)_';
  const futureBlock = future.length
    ? future.map((s, i) => `${i + 1}. ${s}`).join('\n')
    : '_(미래 발전 방안 없음)_';
  const queuedBlock = queued.length
    ? queued.map((q, i) => `${i + 1}. ${typeof q === 'string' ? q : q.text || JSON.stringify(q)}`).join('\n')
    : '_(큐된 질문 없음)_';
  const errorBlock = errors.length
    ? errors.map((e, i) => `${i + 1}. [${e.severity || 'info'}] ${e.message || JSON.stringify(e)}`).join('\n')
    : '';

  const nextAction = state.nextAction || (state.phase === 'COMPLETED'
    ? '추가 작업 없음. 사용자 검토 권장.'
    : '세션 상태 검토 후 /autopilot:resume 또는 /autopilot:abort 결정.');

  return `# Autopilot 완료 보고서

- **세션**: \`${state.sessionId || '-'}\`
- **모드**: ${state.mode || 'default'}
- **상태**: ${state.phase || '-'}
- **시작**: ${state.createdAt || '-'}
- **종료**: ${state.completedAt || '-'}
- **PRD**: ${state.prdPath ? `[${state.prdPath}](${state.prdPath})` : '-'}

## 1. 요약

${state.summary || '_(요약 없음)_'}

## 2. PRD 링크

${state.prdPath ? `- [${state.prdPath}](${state.prdPath})` : '_(PRD 미생성)_'}

## 3. Phase별 결과

${phaseTable}

## 4. 변경 사항 (커밋)

${commitList}

## 5. Cross-check 결과

${crossCheck}

## 6. 검증 결과

${verifyBlock}

## 7. 개선 제안 (Phase 5)

${improvementsBlock}

## 8. 미래 발전 방안

${futureBlock}

## 9. 큐된 질문 / 결정 필요 사항

${queuedBlock}
${errorBlock ? `\n## 9b. 기록된 오류\n\n${errorBlock}\n` : ''}
## 10. Next Action

${nextAction}
`;
}

/**
 * Generate the report file for a session.
 * Loads state via session-store, renders markdown, writes to reports/AUTOPILOT/{sessionId}.md.
 * @param {string} sessionId
 * @returns {{ filePath: string, content: string }}
 */
export function generateReport(sessionId) {
  if (!sessionId || typeof sessionId !== 'string') {
    throw new TypeError('sessionId required');
  }
  const state = loadSession(sessionId);
  if (!state) {
    throw new Error(`session not found: ${sessionId}`);
  }
  const content = renderReport(state);
  const filePath = path.join(getProjectRoot(), 'reports', 'AUTOPILOT', `${sessionId}.md`);
  try {
    mkdirSync(dirname(filePath), { recursive: true });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  writeFileSync(filePath, content, 'utf-8');
  return { filePath, content };
}
