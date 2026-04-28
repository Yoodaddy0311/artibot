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
import { getPluginRoot } from '../core/platform.js';
import { loadSession } from './session-store.js';
import { renderProfile } from './profile-renderer.js';

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
 * Render markdown report from a session state object (legacy single-template).
 * Kept for backward compatibility with existing callers.
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
 * Render a markdown table from rows. Returns 'N/A' when empty.
 * @param {string[]} headers
 * @param {Array<Array<string|number>>} rows
 * @returns {string}
 */
function table(headers, rows) {
  if (!rows || rows.length === 0) return 'N/A';
  const head = `| ${headers.join(' | ')} |`;
  const sep = `|${headers.map(() => '---').join('|')}|`;
  const body = rows.map((r) => `| ${r.map((c) => (c === null || c === undefined ? '-' : String(c))).join(' | ')} |`);
  return [head, sep, ...body].join('\n');
}

/**
 * Render a numbered list. Returns 'N/A' when empty.
 * @param {Array<string|object>} items
 * @returns {string}
 */
function numberedList(items) {
  if (!items || items.length === 0) return 'N/A';
  return items
    .map((it, i) => {
      const text = typeof it === 'string' ? it : (it.text || it.message || JSON.stringify(it));
      return `${i + 1}. ${text}`;
    })
    .join('\n');
}

/** Session-level metadata fields. */
function buildSessionMeta(state) {
  const s = state || {};
  const task = (s.task || '없음').slice(0, 240);
  const status = s.phase || s.status || '-';
  return {
    sessionId: s.sessionId || '-',
    mode: s.mode || 'default',
    startedAt: s.createdAt || s.startedAt || '-',
    completedAt: s.completedAt || '-',
    status,
    task,
    tldr: s.summary || `${task} — 상태 ${status}`,
  };
}

/** Phase table + summary fields. */
function buildPhaseFields(phases) {
  const p = Array.isArray(phases) ? phases : [];
  const phaseTable = table(['Phase', 'Status', 'Duration', 'Files', 'Checks'], p.map((x) => [
    x?.name || '?', x?.status || '?',
    x?.durationMs ? `${Math.round(x.durationMs / 1000)}s` : '-',
    x?.changedFiles ?? '-', x?.checks || '-',
  ]));
  const phaseSummary = p.length
    ? p.map((x) => `- ${x?.name || '?'}: ${x?.status || '?'}`).join('\n')
    : 'N/A';
  return { phaseTable, phaseSummary };
}

/** Verify result + changed-files fields. */
function buildVerifyFields(verifyResult, changedFiles) {
  const v = verifyResult || {};
  const cf = Array.isArray(changedFiles) ? changedFiles : [];
  const changedFilesTable = cf.length
    ? table(['File', 'Change'], cf.map((f) => (typeof f === 'string' ? [f, '-'] : [f.path || '-', f.change || '-'])))
    : 'N/A';
  const hasResults = Object.keys(v).length > 0;
  const testResultsTable = hasResults
    ? table(['Check', 'Result'], [['lint', v.lint || '-'], ['typecheck', v.typecheck || '-'], ['test', v.test || '-'], ['build', v.build || '-']])
    : 'N/A';
  const testEmoji = v.test === 'pass' ? '모두 통과 ✅' : (v.test ? `결과: ${v.test} ❌` : '아직 검증 전');
  const testSummary = hasResults
    ? `lint=${v.lint || '-'}, type=${v.typecheck || '-'}, test=${v.test || '-'}, build=${v.build || '-'}`
    : 'N/A';
  return { changedFilesTable, testResultsTable, testEmoji, testSummary };
}

/** Risk + improvement + future-plan fields. */
function buildRiskFields(state) {
  const s = state || {};
  const errors = Array.isArray(s.errors) ? s.errors : [];
  const risks = Array.isArray(s.risks) && s.risks.length ? s.risks : errors;
  const improvements = Array.isArray(s.improvements) ? s.improvements : [];
  const future = Array.isArray(s.futurePlans) ? s.futurePlans : [];
  const risksTable = risks.length
    ? table(['Severity', 'Description'], risks.map((r) => (typeof r === 'string'
        ? ['-', r]
        : [r.severity || '-', r.message || r.text || JSON.stringify(r)])))
    : 'N/A';
  return {
    risksTable,
    risksTop5: numberedList(risks.slice(0, 5)),
    risksTop3: numberedList(risks.slice(0, 3)),
    improvementsTable: numberedList(improvements),
    improvementsCount: improvements.length,
    futurePlansTable: numberedList(future),
    futurePlansCount: future.length,
  };
}

/**
 * Build the full data object consumed by every profile template.
 * Missing fields collapse to 'N/A' / '없음' so assertNoUnfilled passes.
 * @param {object} state
 * @returns {object}
 */
export function buildReportData(state) {
  const s = state || {};
  const status = s.phase || s.status || '-';
  const phases = Array.isArray(s.phases) ? s.phases : [];
  const improvements = Array.isArray(s.improvements) ? s.improvements : [];
  const errors = Array.isArray(s.errors) ? s.errors : [];
  const risks = Array.isArray(s.risks) && s.risks.length ? s.risks : errors;
  const crossCheckTable = s.crossCheck
    ? table(['Item', 'Value'], [['Verdict', s.crossCheck.verdict || '-'], ['Notes', s.crossCheck.notes || '-']])
    : 'N/A';
  return {
    ...buildSessionMeta(state),
    ...buildPhaseFields(phases),
    ...buildVerifyFields(s.verifyResult, s.changedFiles),
    ...buildRiskFields(state),
    crossCheckTable,
    nextAction: s.nextAction || (status === 'COMPLETED' ? '추가 작업 없음. 사용자 검토 권장.' : '세션 상태 검토 권장.'),
    kpiSummary: s.kpiSummary || `Phases ${phases.length}, Improvements ${improvements.length}, Risks ${risks.length}`,
    kpiSimple: s.kpiSimple || `${phases.length}개 단계 · ${improvements.length}개 개선 · ${risks.length}개 리스크`,
    roi: s.roi || 'N/A',
    dependencies: s.dependencies
      ? (Array.isArray(s.dependencies) ? s.dependencies.join(', ') : String(s.dependencies))
      : 'N/A',
    strategicImplications: s.strategicImplications || 'N/A',
    casualClosing: s.casualClosing || (status === 'COMPLETED' ? '잘 마무리됐어요! 🎉' : '계속 진행 중이에요.'),
  };
}

/**
 * Generate the report file(s) for a session.
 * Multi-style aware: when style='all' or style='dev' with deriveAll, renders all 4 styles.
 * Backwards compatible — returns `{ filePath, content }` for the dev style.
 * @param {string} sessionId
 * @param {{ style?: string, deriveAll?: boolean }} [opts]
 * @returns {{ filePath: string|null, content: string|null, results?: object }}
 */
export function generateReport(sessionId, opts = {}) {
  if (!sessionId || typeof sessionId !== 'string') {
    throw new TypeError('sessionId required');
  }
  const state = loadSession(sessionId);
  if (!state) {
    throw new Error(`session not found: ${sessionId}`);
  }
  const style = opts.style || 'dev';
  const deriveAll = opts.deriveAll !== false;
  const data = buildReportData(state);
  const styles = style === 'all' || (style === 'dev' && deriveAll)
    ? ['dev', 'pm', 'exec', 'casual']
    : [style];

  const reportsDir = path.join(getProjectRoot(), 'reports', 'AUTOPILOT');
  try {
    mkdirSync(reportsDir, { recursive: true });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }

  const results = {};
  for (const s of styles) {
    try {
      const content = renderProfile(s, data);
      const fileName = s === 'dev' ? `${sessionId}.md` : `${sessionId}.${s}.md`;
      const filePath = path.join(reportsDir, fileName);
      writeFileSync(filePath, content, 'utf-8');
      results[s] = { filePath, content };
    } catch (err) {
      results[s] = { error: err.message };
    }
  }

  const primary = results.dev && !results.dev.error
    ? results.dev
    : (results[style] && !results[style].error ? results[style] : null);
  if (primary) {
    return { filePath: primary.filePath, content: primary.content, results };
  }
  return { filePath: null, content: null, results };
}
