/**
 * badge escalation 게이트 3종이 **공유하는** release.yml 로더와 스텝 절단기.
 *
 * 테스트가 아니라 라이브러리다 — vitest 의 `include` 는 `.test.js` 로 끝나는
 * 파일만 수집하므로(`vitest.config.js` 의 `main` 프로젝트 `include`:
 * `tests/**\/*.test.{js,mjs}`) 이 파일은 테스트로 실행되지 않는다 — 줄번호가 아니라
 * 키를 인용한다(그 include 는 2026-09-11 세션 중에도 :96 → :116 으로 움직였다).
 * `frontmatter-tools.js` 와 같은 이유로 분리됐다:
 * test 파일에서 test 파일을 import 하면 vitest 가 그쪽 `describe` 를 **호출한 쪽
 * 스위트에 다시 등록**해 같은 테스트가 두 번 돈다.
 *
 * `badge-stall-issue-lifecycle.test.js`(분할 전 1,033줄)에서 2026-09-11 에 분할됐다.
 * 여기 올라온 것은 **둘 이상의 test 파일이 쓰는 것만**이다:
 *   - `source` + `REPO_ROOT` — 세 파일 전부. `REPO_ROOT` 는
 *     `badge-stall-landing-lockstep.test.js` 가 경로 실재 검사에 쓰므로,
 *     거기서 다시 계산하면 리포 루트 정본이 둘이 된다.
 *   - `sliceStep`·`executableShell` — 세 파일 전부.
 * 한 파일만 쓰는 추출기는 옮기지 않았다: `ghPrListStates`·`ghApiPaths`·
 * `compareFallbackKind`·`shellWordList`·`parseTopLevelEnv`·`parseKindArms`·
 * `globMatches` 는 issue-lifecycle, `stepLineIndex`·`syncOrderHolds`·
 * `moveStepBefore` 는 sync-order, `parseSyncPaths`·`gitAddArgs` 는
 * landing-lockstep 에 그대로 있다.
 *
 * **판정은 여기 없다.** 어떤 값이 allowlist 인지, 무엇이 RED 인지는 전부 test
 * 파일 쪽이고, 각 게이트가 **못 보는 것**(rules §9)도 그 파일의 헤더·블록 주석에
 * 적혀 있다. 파서를 넓히면 그 목록과 거기 딸린 단언을 같이 고쳐야 한다.
 *
 * @module tests/firewall/badge-stall-yaml-tools
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** 리포 루트 — GitHub 가 실제로 실행하는 워크플로는 여기 아래에만 있다. */
export const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const RELEASE_YML = join(REPO_ROOT, '.github', 'workflows', 'release.yml');

export const source = readFileSync(RELEASE_YML, 'utf-8');

/**
 * `- name: <step>` 부터 다음 `- name:` 직전까지를 잘라낸다.
 *
 * YAML 파서가 아니라 스텝 경계만 나누는 최소 절단기다. 스텝 본문 안의 셸 주석에
 * `- name:` 이 나오면 잘못 자르는데, 현재 release.yml 에는 그런 줄이 없다
 * (`badge-stall-issue-lifecycle.test.js` 의 "스캐너 자기검증"이 이 전제를
 * 단언으로 고정한다).
 *
 * @param {string} yaml 워크플로 전체 텍스트
 * @param {string} stepName 찾을 스텝 이름
 * @returns {string | null} 스텝 본문. 없으면 null
 */
export function sliceStep(yaml, stepName) {
  const lines = yaml.split(/\r?\n/);
  const startIdx = lines.findIndex((l) => l.trim() === `- name: ${stepName}`);
  if (startIdx === -1) return null;
  const rest = lines.slice(startIdx + 1);
  const endOffset = rest.findIndex((l) => /^\s*- name: /.test(l));
  const body = endOffset === -1 ? rest : rest.slice(0, endOffset);
  return body.join('\n');
}

/**
 * 스텝 본문에서 **실행되는 셸만** 남긴다: `#` 주석 줄을 버리고 `\` 줄 연속을 잇는다.
 *
 * 이게 없으면 산문이 단언을 충족시킨다. 실측 2026-08-24: `release.yml` 에
 * `--state merged` 가 2회 등장하는데 하나는 주석(`# \`--state merged\` is the whole
 * verdict…`)이고 하나가 실제 명령이다. 명령을 `--state closed` 로 바꿔도 주석이
 * `toContain('--state merged')` 를 채워 11/11 이 통과했다 — 게이트가 막겠다고
 * 선언한 시나리오가 그대로 지나간 거짓 그린이었다.
 *
 * @param {string} stepBody sliceStep 결과
 * @returns {string} 주석 제거 + 줄 연속 결합된 텍스트
 */
export function executableShell(stepBody) {
  return stepBody
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join('\n')
    .replace(/\\\r?\n\s*/g, ' ');
}
