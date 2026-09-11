/**
 * 검사 목적: 산문 **힐링 대상**과 배지 브랜치 **커밋 대상**이 같은 집합임을 고정.
 *
 * `badge-stall-issue-lifecycle.test.js` 에서 2026-09-11 에 분할됐다(순수 이동 —
 * 테스트 이름과 단언 줄은 한 바이트도 안 바뀌었다). 두 목록이 갈라지면 배지 브랜치가
 * RED 가 되고, 그것이 그 파일이 고정하는 escalation 이슈를 연다 — 그래서 한
 * 파일에 같이 있었다. 그 인과와 **이 블록이 못 보는 것**(rules §9)은 아래 블록
 * 주석에 그대로 있다(분할하면서 새로 쓴 문장은 없다).
 *
 * 공유 로더·절단기는 `badge-stall-yaml-tools.js`(테스트 아님).
 *
 * @module tests/firewall/badge-stall-landing-lockstep
 */
import { existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
// 읽기 전용 import. 산문 자가치유가 **실제로 쓰는** 대상 목록이 여기 하나뿐이라
// YAML 의 SYNC_PATHS 와 집합 대조할 수 있다. 이 파일은 registry 를 수정하지 않는다.
import { SYNC_TARGETS, VALIDATE_ONLY_TARGETS } from '../../scripts/ci/readme-claims-registry.js';
import { executableShell, REPO_ROOT, sliceStep, source } from './badge-stall-yaml-tools.js';

// ── 힐링 대상 ↔ 커밋 대상 집합 lockstep ───────────────────────────────────────
//
// 순서를 고쳐도 **힐링된 바이트가 커밋에 없으면** 배지 브랜치는 여전히 RED 다.
// 2026-09-11 실측: 자가치유기는 readme-claims-registry.js#SYNC_RELATIVE 의
// **9파일**을 고쳐 쓰는데, 변경 감지(`git diff --quiet`)와 양쪽 랜딩의
// `git add` 는 **4파일**만 이름 붙였다. 나머지 5개(INSTALL.md ·
// plugins/artibot/{CLAUDE,AGENTS}.md · .well-known/mcp-server.json ·
// docs/MARKETPLACE-SUBMISSION.md)는 러너에서 고쳐지고 러너와 함께 버려졌다.
// 그래서 브랜치에는 새 수치의 marketplace.json 과 옛 수치의 산문이 같이 실렸고
// validate-readme-claims --full 이 그 브랜치에서 드리프트로 실패했다.
//
// 이 블록은 두 목록을 **집합으로** 대조한다 — 한쪽에만 추가하면 RED.
//
// ── 못 보는 것 (rules §9) ────────────────────────────────────────────────────
//   - **`git add` 가 실제로 그 파일들을 스테이징했는지는 증명하지 못한다.**
//     여기는 정적 스캔이다. 유일한 실측은 다음 릴리스 커밋의 `--stat` 이다.
//   - **registry 가 그 9파일을 실제로 고쳐 쓰는지**는 여기서 안 본다(그건
//     sync-readme-claims 쪽 스위트 몫). 여기는 "두 목록이 같은가"만 본다.
//   - **VALIDATE_ONLY_TARGETS 는 대조에서 뺐다.** 현재 빈 배열이고, 다시 쓰이면
//     "검증만 하고 고쳐 쓰지 않는" 파일이라 커밋 대상이 아니다. 비어있지 않게
//     되는 순간 아래 단언이 그 전제를 드러내도록 길이 0 을 같이 박아둔다.
const STRATEGY_DIFF_STEP = 'Decide landing strategy';
const FF_LAND_STEP = 'Land badge sync via ci/** side branch (PAT)';
const PR_LAND_STEP = 'Land badge sync via PR + auto-merge';

/**
 * `sync-readmes` 잡 env 의 folded(`>-`) `SYNC_PATHS` 를 경로 배열로 읽는다.
 *
 * YAML 파서가 없어(헤더 참조) 들여쓰기 기반 최소 구현이다. folded 스칼라는
 * GitHub 에서 공백 한 줄로 접히므로 여기서도 공백으로 이어 붙인 뒤 쪼갠다.
 *
 * @param {string} yaml 워크플로 전체 텍스트
 * @returns {string[]} 상대 경로 목록. 키가 없으면 빈 배열
 */
function parseSyncPaths(yaml) {
  const lines = yaml.split(/\r?\n/);
  const keyIdx = lines.findIndex((l) => /^\s+SYNC_PATHS:\s*>-\s*$/.test(l));
  if (keyIdx === -1) return [];
  const keyIndent = lines[keyIdx].match(/^ */)[0].length;
  const collected = [];
  for (const line of lines.slice(keyIdx + 1)) {
    if (!line.trim()) break;
    if (line.match(/^ */)[0].length <= keyIndent) break;
    collected.push(line.trim());
  }
  return collected.join(' ').split(/\s+/).filter(Boolean);
}

/**
 * 실행 셸에서 `git add` 호출의 **인자 문자열**을 등장 순서대로 뽑는다.
 *
 * allowlist 정확 비교용이다. `not.toContain('git add -A')` 같은 부정 목록은
 * `-u`·`.`·`--all` 같은 미래 값에 fail-open 이다(rules §8).
 *
 * @param {string} stepBody sliceStep 결과
 * @returns {string[]} 호출별 인자 문자열
 */
function gitAddArgs(stepBody) {
  const shell = executableShell(stepBody);
  return [...shell.matchAll(/git add\b([^\n;|&]*)/g)].map((m) => m[1].trim());
}

/** SYNC_TARGETS(절대경로) → REPO_ROOT 기준 posix 상대경로. */
const registryRelative = SYNC_TARGETS.map((abs) =>
  relative(REPO_ROOT, abs).split(sep).join('/')
);

describe('산문 힐링 대상 ↔ 랜딩 커밋 대상 lockstep', () => {
  const yamlPaths = parseSyncPaths(source);

  it('SYNC_PATHS 를 실제로 읽어냈다 (0건 통과 차단)', () => {
    // 파서가 죽으면 아래 집합 비교가 [] vs [] 로 조용히 통과할 수 있다.
    expect(yamlPaths.length).toBeGreaterThan(0);
    expect(registryRelative.length).toBeGreaterThan(0);
  });

  it('YAML 목록과 registry SYNC_TARGETS 가 집합으로 동일하다', () => {
    // 순서 무관 비교. 정렬해서 배열로 맞대면 차집합이 메시지에 그대로 뜬다.
    expect([...yamlPaths].sort()).toEqual([...registryRelative].sort());
  });

  it('SYNC_PATHS 에 중복이 없다', () => {
    expect(new Set(yamlPaths).size).toBe(yamlPaths.length);
  });

  it('SYNC_PATHS 의 어떤 경로에도 공백이 없다 (따옴표 없는 word-split 전제)', () => {
    // 공백이 들어오는 순간 `git add -- ${SYNC_PATHS}` 가 엉뚱한 pathspec 으로
    // 쪼개진다. 따옴표를 안 붙인 근거가 이 단언이다.
    for (const p of yamlPaths) expect(p).not.toMatch(/\s/);
  });

  it('SYNC_PATHS 의 모든 경로가 실재한다 (pathspec 불일치 방지)', () => {
    // `git add` 는 매치되지 않는 pathspec 에 죽는다 — 목록에 오타가 있으면
    // 랜딩 스텝 전체가 실패한다. 파일 실재를 여기서 본다.
    for (const p of yamlPaths) {
      expect(existsSync(join(REPO_ROOT, ...p.split('/'))), `${p} 가 없다`).toBe(true);
    }
  });

  it('변경 감지가 SYNC_PATHS 로 판정한다', () => {
    const shell = executableShell(sliceStep(source, STRATEGY_DIFF_STEP));
    expect(shell).toMatch(/git diff --quiet -- \$\{SYNC_PATHS\}/);
    // 분류 루프도 같은 목록을 쓴다 — 여기만 4파일로 남으면 산문 변경이 분류에서
    // 통째로 빠진다.
    expect(shell).toMatch(/git diff --name-only -- \$\{SYNC_PATHS\}/);
  });

  it('양쪽 랜딩의 git add 인자가 SYNC_PATHS 하나뿐이다 (allowlist 정확 비교)', () => {
    for (const step of [FF_LAND_STEP, PR_LAND_STEP]) {
      const body = sliceStep(source, step);
      expect(body, `"${step}" 스텝을 찾지 못했다`).not.toBeNull();
      const args = gitAddArgs(body);
      expect(args.length, `"${step}" 에 git add 가 없다`).toBeGreaterThan(0);
      // `-A`·`-u`·`.` 는 이 비교에서 자동으로 걸린다(나열하지 않아도 된다).
      expect([...new Set(args)]).toEqual(['-- ${SYNC_PATHS}']);
    }
  });

  it('VALIDATE_ONLY_TARGETS 가 비어 있다 (대조에서 뺀 전제)', () => {
    // 비지 않게 되면 "커밋 대상 = SYNC_TARGETS" 전제를 다시 따져야 한다.
    expect(VALIDATE_ONLY_TARGETS).toEqual([]);
  });

  describe('스캐너 자기검증', () => {
    it('경로를 하나 뺀 사본에서 집합 비교가 RED 가 된다', () => {
      const dropped = registryRelative[registryRelative.length - 1];
      const mutated = source
        .split(/\r?\n/)
        .filter((l) => l.trim() !== dropped)
        .join('\n');
      const mutatedPaths = parseSyncPaths(mutated);
      expect(mutatedPaths.length).toBe(yamlPaths.length - 1); // 변이기가 일했다
      expect([...mutatedPaths].sort()).not.toEqual([...registryRelative].sort());
    });

    it('SYNC_PATHS 키가 사라지면 파서가 빈 배열을 낸다 (fail-closed)', () => {
      const removed = source
        .split(/\r?\n/)
        .filter((l) => !/^\s+SYNC_PATHS:\s*>-\s*$/.test(l))
        .join('\n');
      expect(parseSyncPaths(removed)).toEqual([]);
      // 그리고 그 빈 배열은 위 "0건 통과 차단" 단언에서 RED 가 된다.
      expect(parseSyncPaths(removed).length).toBe(0);
    });

    it('gitAddArgs 가 -A 변이를 값으로 구분한다', () => {
      const bad = '        run: |\n          git add -A\n';
      expect(gitAddArgs(bad)).toEqual(['-A']);
      // 주석 안의 `git add -A` 서술은 세지 않는다(거짓 그린 차단).
      expect(gitAddArgs('          # git add -A is forbidden\n')).toEqual([]);
    });
  });
});
