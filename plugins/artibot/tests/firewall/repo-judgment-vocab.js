/**
 * `/repo` 판정 어휘의 순수 술어. **테스트가 아니라 라이브러리다** (파일명이
 * `*.test.js` 가 아니므로 vitest `include` 에 걸리지 않는다).
 *
 * 분리한 이유: 격리 `git worktree` 에서 음성 대조를 돌릴 때 **vitest 없이 plain
 * node 로** 이 술어를 임의 경로에 적용할 수 있어야 한다. 2026-08-16 에 워크트리에
 * `node_modules` 정션을 걸었다가 `git worktree remove --force` 가 정션을 따라가
 * **메인 트리 의존성을 삭제**한 사고가 있었다. 경로 주입형 순수 함수면 그 위험이
 * 통째로 사라진다.
 *
 * @module tests/firewall/repo-judgment-vocab
 */

/**
 * `/repo` 판정이 쓰는 어휘 정본. **allowlist 다** (rules §8 — 부정 목록은 미래
 * 항목에 fail-open).
 *
 * 이 어휘가 두 파일에 걸쳐 있다는 것은 **문서가 스스로 선언한 계약**이다:
 * `agents/repo-benchmarker.md#Grading-rules` 첫 줄이 그대로
 * "same vocabulary the orchestrator's gate consumes" 라고 적는다.
 * 커맨드는 판정 규칙을 서술하고, **실제로 그 판정을 출력하는 것은 서브에이전트**다.
 * 두 쪽 어휘가 갈라지면 규칙은 살아 있는데 그것을 촉발할 토큰이 안 나온다.
 */
export const VETO_AXES = ['안전성', '견고성', '효율성'];
export const GAIN_AXES = ['확장성', '미래지향성', '독창성', '창의성'];
export const VERDICTS = ['ADOPT', 'TRANSFORM', 'DEFER', 'REJECT'];
export const EVIDENCE_MARKERS = ['INSUFFICIENT-INSPECTION', 'UNINSPECTED', 'SHALLOW'];
export const BUCKETS = ['SUPPRESSED'];

/** 두 파일 모두에 반드시 등장해야 하는 어휘 전체. */
export const SHARED_VOCAB = [
  ...VETO_AXES,
  ...GAIN_AXES,
  ...VERDICTS,
  ...EVIDENCE_MARKERS,
  ...BUCKETS,
];

/**
 * 서브에이전트 출력 템플릿의 `Dimension marker: [none|A|B|C]` 열거를 읽는다.
 *
 * 이 열거는 **기계적으로 파싱 가능한 유일한 마커 목록**이다. 커맨드 쪽 마커
 * 서술은 산문이라 파싱하지 않는다(아래 blind spot 참조).
 *
 * @param {string} agentText
 * @returns {{ ok: true, markers: string[] } | { ok: false, reason: string }}
 */
export function parseMarkerEnum(agentText) {
  const m = agentText.match(/Dimension marker:\s*\[([^\]]*)\]/);
  if (!m) return { ok: false, reason: 'Dimension marker 열거를 찾지 못했다' };
  const items = m[1].split('|').map((s) => s.trim()).filter((s) => s !== '');
  if (items.length === 0) return { ok: false, reason: 'Dimension marker 열거가 비었다' };
  return { ok: true, markers: items };
}

/**
 * 서브에이전트 템플릿의 VETO / GAIN 축 **개수**를 읽는다.
 *
 * 축이 템플릿에서 하나 빠지면 그 축은 **영영 평가되지 않는데 아무 것도 빨개지지
 * 않는다** — 커맨드 산문에는 여전히 "3 VETO + 4 GAIN" 이라 적혀 있기 때문이다.
 * 그 비대칭이 이 함수가 존재하는 이유다.
 *
 * @param {string} agentText
 * @returns {{ ok: true, veto: string[], gain: string[] } | { ok: false, reason: string }}
 */
export function parseAxisTemplate(agentText) {
  const vetoLine = agentText.split(/\r?\n/).find((l) => /^\s*VETO\s/.test(l));
  const gainLine = agentText.split(/\r?\n/).find((l) => /^\s*GAIN\s/.test(l));
  if (!vetoLine) return { ok: false, reason: 'VETO 템플릿 줄을 찾지 못했다' };
  if (!gainLine) return { ok: false, reason: 'GAIN 템플릿 줄을 찾지 못했다' };

  // `안전성:[pass|FAIL]` / `확장성:[0-3]` 형태에서 축 이름만 뽑는다.
  const veto = [...vetoLine.matchAll(/([^\s:]+):\[pass\|FAIL\]/g)].map((m) => m[1]);
  const gain = [...gainLine.matchAll(/([^\s:]+):\[0-3\]/g)].map((m) => m[1]);
  return { ok: true, veto, gain };
}

/**
 * 어휘 lockstep 검사. 두 파일 텍스트를 받아 누락 어휘를 돌려준다.
 *
 * @param {string} commandText `commands/repo.md`
 * @param {string} agentText   `agents/repo-benchmarker.md`
 * @param {string[]} [vocab]   뮤테이션 주입점
 * @returns {{ missing: Array<{term: string, absentFrom: string}>, checked: number }}
 */
export function checkVocabLockstep(commandText, agentText, vocab = SHARED_VOCAB) {
  const missing = [];
  for (const term of vocab) {
    if (!commandText.includes(term)) missing.push({ term, absentFrom: 'commands/repo.md' });
    if (!agentText.includes(term)) missing.push({ term, absentFrom: 'agents/repo-benchmarker.md' });
  }
  return { missing, checked: vocab.length };
}
