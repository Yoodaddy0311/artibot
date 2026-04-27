// Autopilot smoke test — /autopilot:plan 모드 실제 작동 검증
// 사용법: cd <repo>; node plugins/artibot/scripts/_autopilot-smoke.mjs

import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

const repoRoot = process.cwd();
const libPath = resolve(repoRoot, 'plugins/artibot/lib/autopilot/index.js');

console.log('[smoke] repo:', repoRoot);
console.log('[smoke] lib:', libPath);
console.log('[smoke] exists:', existsSync(libPath));

const libUrl = pathToFileURL(libPath).href;
console.log('[smoke] importing:', libUrl);

const mod = await import(libUrl);
const exports = Object.keys(mod);
console.log('[smoke] exports:', exports.join(', '));

// 1. plan 모드 실행
console.log('\n[smoke] === Phase A: startAutopilot(mode=plan) ===');
const result = await mod.startAutopilot({
  task: '결제 모듈 리팩토링하고 단위 테스트 추가하기 (Autopilot smoke test)',
  mode: 'plan',
  options: { maxDuration: '30m', budget: 100000 },
});

console.log('[smoke] sessionId:', result.sessionId);
console.log('[smoke] prdPath:', result.prdPath);
console.log('[smoke] phase:', result.phase || 'n/a');
console.log('[smoke] instruction.type:', result.instruction?.type);

// 2. PRD 파일 생성 확인
const prdAbs = resolve(repoRoot, result.prdPath);
const prdExists = existsSync(prdAbs);
console.log('\n[smoke] PRD created:', prdExists, '→', prdAbs);
if (prdExists) {
  const prdContent = readFileSync(prdAbs, 'utf-8');
  console.log('[smoke] PRD size:', prdContent.length, 'chars');
  const sectionCount = (prdContent.match(/^## /gm) || []).length;
  console.log('[smoke] PRD sections (## level):', sectionCount);
}

// 3. 세션 상태 조회
console.log('\n[smoke] === Phase B: getStatus ===');
const status = await mod.getStatus(result.sessionId);
console.log('[smoke] status.phase:', status.phase);
console.log('[smoke] status.mode:', status.mode);
console.log('[smoke] status.task:', status.task?.slice(0, 50));

// 4. plan 모드는 Phase 0(INTAKE)에서 정지해야 함
const expectedPhase = ['INTAKE', 'PLAN'].includes(status.phase);
console.log('\n[smoke] plan mode stopped at INTAKE/PLAN:', expectedPhase);

// 5. abort
console.log('\n[smoke] === Phase C: abortAutopilot ===');
const aborted = await mod.abortAutopilot(result.sessionId, { graceful: true });
console.log('[smoke] aborted:', aborted);

// 6. 결과 요약
console.log('\n[smoke] ========== SUMMARY ==========');
const passed = [
  ['lib import', !!mod.startAutopilot],
  ['startAutopilot returns sessionId', !!result.sessionId],
  ['startAutopilot returns prdPath', !!result.prdPath],
  ['PRD file created', prdExists],
  ['getStatus retrieves session', !!status.sessionId || !!status.phase],
  ['plan mode stopped at INTAKE/PLAN', expectedPhase],
  ['abort returns', !!aborted],
];
for (const [name, ok] of passed) {
  console.log(`  ${ok ? '✓' : '✗'} ${name}`);
}
const allPass = passed.every(([, ok]) => ok);
console.log(allPass ? '\n[smoke] RESULT: PASS' : '\n[smoke] RESULT: FAIL');
process.exit(allPass ? 0 : 1);
