/**
 * Firewall — `/split` 창 시작 프롬프트 계약 (`commands/split.md`).
 *
 * ── 왜 이 게이트가 필요한가 ─────────────────────────────────────────────────
 * `/split` 의 줄기 창은 `Agent(...)` 로 스폰되지 않는다. **사람이 새 터미널을 열고
 * 프롬프트를 붙여넣는다.** 그래서 팀원 스폰 경로를 지키는 기존 게이트
 * (`tests/commands/report-contract-parity.test.js` 의 `prompt=` 커버리지)만으로는
 * 창 프롬프트 고유 규약이 조용히 빠져도 초록이다. 이 파일은 그 고유 규약을 고정한다:
 *
 *   - 계약 블록 2개가 `commands/team.md` 정본과 **문자 단위 동일**(드리프트 = 계약 후퇴)
 *   - `collectHandoffData` 를 **전체 인자**로 호출 (인자를 빼면 placeholder 로 열화 —
 *     `save.md` Phase B 2단계가 기록한 함정과 같다) + `await`
 *   - 슬러그는 부모 projectRoot 고정 (worktree 경로로 새 슬러그 = 메모리 파편화)
 *   - 완료 판정은 `Split-Limb: done` 트레일러, 시작 인사 1회 규약
 *   - `plan` 이 `buildFastFanoutPlan` 의 **기존 4키**로 상한을 넘기고
 *     `fallbackReason` 을 표시·중단 (새 키는 `normalizeFastProfile` 이 무음 폴백)
 *   - `status` 의 진실원이 `git worktree list --porcelain` + 트레일러이고 메인 세션 전용
 *   - 승격 트리거(300줄 / 3문단)가 헤더에 적혀 있고, 300줄 래칫이 실제로 걸린다
 *
 * ── 이 게이트가 못 보는 것 (rules §9 — 게이트 옆에 적어라) ──────────────────
 *
 *  1. **모델이 프롬프트를 실제로 그대로 붙여넣게 하는지는 못 본다.** 문서에 적혀
 *     있다는 것만 본다. 문서 존재 ≠ 준수. 사람이 붙여넣는 경로라 훅도 없다.
 *  2. **줄기 창이 트레일러를 실제로 남기는지는 못 본다.** 그것은 라이브 관측
 *     (`git log --format=%(trailers)`) 의 몫이고, Phase 3 `lib/git/limb-completion.js`
 *     테스트가 판독기를 덮는다 — 이 파일은 규약 문장의 존재만 본다.
 *  3. **`collectHandoffData` 인자 이름만 본다.** 실제 시그니처와의 정합은
 *     `doc-async-await-parity`(await) 와 유닛 테스트의 몫이다. 인자 순서·타입은 안 본다.
 *  4. **정규식 매칭이다.** 문구가 남아 있어도 뜻이 뒤집히면 통과한다.
 *  5. **`SplitWindow(...)` 는 도구가 아니다.** 이 파일은 그 표기를 계약 캐리어로
 *     읽지만, 하네스가 그런 도구를 제공하는지와는 무관하다 — 문서 자신이 "도구가
 *     아니라 표기" 라고 명시하는 문장을 함께 단언해 오독을 막는다.
 *
 * @module tests/firewall/split-window-contract
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(path.join(PLUGIN_ROOT, rel), 'utf-8');

// 파일 부재·읽기 실패는 fail-closed 다 — 조용한 스킵 가드를 두지 않는다.
const splitMd = read('commands/split.md');
const teamMd = read('commands/team.md');

/** 승격 트리거 — `commands/split.md` 헤더가 명시한 값과 같아야 한다. */
const PROMOTION_LINE_TRIGGER = 300;

/** `allowed-tools` 에 반드시 있어야 하는 도구 (PRD Phase 2). */
const REQUIRED_TOOLS = ['ListAgents', 'SendMessage', 'Bash', 'Read', 'Write'];

/** ```-펜스 안의 `[{label}]` 블록 — parity 테스트와 같은 추출 규칙(사본이 아니라 규칙 복제). */
export function extractBlock(src, label) {
  const m = src.match(new RegExp('```\\r?\\n(\\[' + label + '\\][\\s\\S]*?)\\r?\\n```'));
  return m ? m[1].replace(/\r\n/g, '\n').trim() : null;
}

/** `prompt="..."` 문자열 전체 (종결자 `")` / `",`). */
export function extractPrompts(src) {
  const out = [];
  const re = /prompt="([\s\S]*?)"\s*[,)]/g;
  let m;
  while ((m = re.exec(src)) !== null) out.push(m[1]);
  return out;
}

/** ` ```js ` 펜스 본문 목록. */
export function jsFences(src) {
  return [...src.replace(/\r\n/g, '\n').matchAll(/^```js\n([\s\S]*?)^```/gm)].map((m) => m[1]);
}

/** BOM·CRLF 무관 줄 수 (`citation-resolution.js#countLines` 와 같은 규칙). */
export function countLines(text) {
  let s = String(text);
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  const arr = s.split(/\r\n|\r|\n/);
  if (arr.length > 0 && arr[arr.length - 1] === '') arr.pop();
  return arr.length;
}

function frontmatter(src) {
  const m = src.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---/);
  return m ? m[1] : null;
}

const fm = frontmatter(splitMd);
const prompts = extractPrompts(splitMd);

describe('split.md 프론트매터', () => {
  it('프론트매터가 있고 description 은 (Artibot) 접두, toolset 은 team 이다', () => {
    expect(fm).not.toBeNull();
    expect(fm).toMatch(/^description: \(Artibot\) /m);
    expect(fm).toMatch(/^toolset: team$/m);
  });

  it.each(REQUIRED_TOOLS)('allowed-tools 에 %s 가 명시돼 있다 (toolset 은 도구 허가가 아니다)', (tool) => {
    const line = fm.split('\n').find((l) => l.startsWith('allowed-tools:'));
    expect(line, 'allowed-tools 줄이 없다').toBeDefined();
    expect(line).toMatch(new RegExp(`[\\[,]\\s*${tool}\\s*[,\\]]`));
  });
});

describe('계약 블록 — team.md 와 문자 단위 동일', () => {
  const pairs = [['보고 계약'], ['중계 계약']];

  it.each(pairs)('[%s] 블록이 split.md 에 있다', (label) => {
    expect(extractBlock(splitMd, label), `${label} 블록 추출 실패`).not.toBeNull();
  });

  it.each(pairs)('[%s] 이 team.md 정본과 같다', (label) => {
    expect(extractBlock(splitMd, label)).toBe(extractBlock(teamMd, label));
  });

  it('두 블록은 서로 다르다 (복붙 사고 감지)', () => {
    expect(extractBlock(splitMd, '보고 계약')).not.toBe(extractBlock(splitMd, '중계 계약'));
  });

  it('비교는 정말 문자 단위다 (자기검증: 한 글자 변이가 red 를 낸다)', () => {
    const mutated = splitMd.replace('없으면 "미확인: 없음".', '없으면 "미확인: 없음"');
    expect(mutated).not.toBe(splitMd);
    expect(extractBlock(mutated, '보고 계약')).not.toBe(extractBlock(teamMd, '보고 계약'));
  });
});

describe('창 시작 프롬프트', () => {
  it('창 프롬프트(prompt=)가 정확히 1개다 — 늘면 parity 의 total 도 같이 갱신하라', () => {
    expect(prompts.length).toBe(1);
  });

  it('SplitWindow 표기가 도구가 아니라 문서 표기임을 명시한다', () => {
    expect(splitMd).toMatch(/`SplitWindow\(\.\.\.\)` 는 도구가 아니라/);
  });

  it.each([
    ['보고 계약 자리', /\{보고 계약\}/],
    ['완료 트레일러', /Split-Limb: done/],
    ['커밋 없으면 완료 아님', /커밋 없으면 완료가 아니다/],
    ['시작 인사 1회', /시작 인사 1회/],
    ['부모에게 인사 채널', /SendMessage\(to='\{parent-session\}'\)/],
    ['부모 슬러그 고정', /부모 projectRoot\(\{parentRoot\}\) 기준 \{slug\} 로 고정/],
    ['worktree 슬러그 금지', /worktree 경로로 새 슬러그를 만들지 마라/],
    ['stash 금지 (refs/stash 공유)', /stash[^\n]*refs\/stash/],
    ['줄기 팀원 이름 규약', /split-\{repoShort\}-\{limb\}-\{sid\}-\{role\}/],
    ['runId 고정', /run=\{runId\}/],
    ['트레일러 쓰는 법', /--trailer/],
    ['node_modules 부재 경고 (P6)', /npm ci/],
    ['브리프 경로', /\.artibot\/split\/\{limb\}\/brief\.md/],
  ])('프롬프트에 "%s" 규약이 있다', (_label, re) => {
    expect(prompts[0]).toMatch(re);
  });

  it('프롬프트 안에 `")`·`",` 가 없다 (있으면 추출이 조기 종결돼 계약이 잘린다)', () => {
    // 이중따옴표 종결자가 프롬프트 안에 들어가면 parity 의 정규식이 거기서 멈춘다.
    expect(prompts[0]).not.toMatch(/"\s*[,)]/);
  });
});

describe('open — collectHandoffData 전체 인자 + 부모 슬러그', () => {
  const fences = jsFences(splitMd);

  it('js 펜스가 있다 (분모 — plan · open · dispatch 판정)', () => {
    expect(fences.length).toBeGreaterThanOrEqual(3);
  });

  it('collectHandoffData 를 await + 전체 인자 {pluginRoot, projectRoot: worktreePath, firstPrompts, taskList} 로 호출한다', () => {
    const call = fences.find((f) => f.includes('collectHandoffData('));
    expect(call, 'collectHandoffData 호출 펜스가 없다').toBeDefined();
    expect(call).toMatch(
      /await collectHandoffData\(\{\s*pluginRoot,\s*projectRoot:\s*worktreePath,\s*firstPrompts,\s*taskList\s*\}\)/,
    );
  });

  it('슬러그는 toProjectSlug(parentRoot) — worktreePath 가 아니다', () => {
    const call = fences.find((f) => f.includes('toProjectSlug('));
    expect(call).toBeDefined();
    expect(call).toMatch(/toProjectSlug\(parentRoot\)/);
    expect(call).not.toMatch(/toProjectSlug\(worktreePath\)/);
  });

  it('창 열기는 내장 worktree(사람) — git worktree add 를 쓰지 않는다고 명시한다', () => {
    expect(splitMd).toMatch(/claude --worktree split-\{repoShort\}-\{limb\}/);
    expect(splitMd).toMatch(/`git worktree add` 로 직접 만들지도 않는다/);
  });
});

describe('plan — 기존 4키 매핑 + fallbackReason 명시 중단', () => {
  const planFence = jsFences(splitMd).find((f) => f.includes('buildFastFanoutPlan('));

  it('buildFastFanoutPlan 호출 펜스가 있다', () => {
    expect(planFence).toBeDefined();
  });

  it('상한은 limits.maxWorktrees 와 limits.hardMaxAgents 양쪽에 maxWindows 로 매핑된다', () => {
    expect(planFence).toMatch(
      /limits:\s*\{\s*maxWorktrees:\s*cfg\.maxWindows,\s*hardMaxAgents:\s*cfg\.maxWindows\s*\}/,
    );
    // 새 키를 limits 에 넣으면 normalizeFastProfile 이 무음 폴백한다 — 그 형태를 금지.
    expect(planFence).not.toMatch(/limits:\s*\{[^}]*maxWindows\s*:/);
  });

  it('serverEntryPaths 는 최상위 옵션이다 (limits 키가 아니다)', () => {
    expect(planFence).toMatch(/^\s*serverEntryPaths:\s*cfg\.serverEntryPaths/m);
    expect(planFence).not.toMatch(/limits:\s*\{[^}]*serverEntryPaths/);
  });

  it('profile 과 fallbackReason 을 항상 표시하고, fallbackReason≠null 이면 명시 중단한다', () => {
    expect(splitMd).toMatch(/\*\*항상 표시\*\*: `profile`, `fallbackReason`/);
    expect(splitMd).toMatch(/`fallbackReason !== null` 이면 \*\*명시 중단\*\*/);
  });

  it('DB 공유는 판정하지 않고 "미확인" 경고만 낸다', () => {
    expect(splitMd).toMatch(/DB 공유 여부 \*\*미확인\*\*/);
  });
});

describe('status — 진실원과 세션 경계', () => {
  it('git worktree list --porcelain 을 종료코드 검사와 함께 진실원으로 쓴다', () => {
    expect(splitMd).toMatch(/\*\*진실원\*\*: `git worktree list --porcelain`/);
    expect(splitMd).toMatch(/종료코드를 검사한다/);
  });

  it('완료 판정은 Split-Limb 트레일러(git log %(trailers))다', () => {
    expect(splitMd).toMatch(/git log --format='%\(trailers:key=Split-Limb,valueonly\)'/);
  });

  it('ListAgents 는 cwd 가 없어 이름 접두 휴리스틱임을 명시한다 (P3)', () => {
    expect(splitMd).toMatch(/`ListAgents` 출력에는 cwd 가 없으므로/);
  });

  it('status 는 메인 세션 전용이다', () => {
    expect(splitMd).toMatch(/### status \(메인 세션 전용\)/);
  });
});

describe('recommend=split 서피싱 문구 — CLAUDE.md 정본과 문자 동일', () => {
  // 정본은 plugins/artibot/CLAUDE.md "Recommend-hint surfacing rule" 의 `recommend=split` 행이다
  // (`scripts/hooks/runtime-prompt.js` 가 CLAUDE.md 를 계약 위치로 지정). 파리티 게이트가 없어
  // 두 문서가 각자 다른 문장을 들고 있었다(2026-08-26 실측) — 이 단언이 그 구멍을 메운다.
  const claudeMd = read('CLAUDE.md');

  function surfacingPhrase(src) {
    const m = src.match(/`recommend=split`[^\n]*?: "([^"\n]+)"/);
    return m ? m[1] : null;
  }

  it('CLAUDE.md 에 recommend=split 행과 따옴표 문구가 있다 (분모)', () => {
    expect(surfacingPhrase(claudeMd), 'CLAUDE.md 의 recommend=split 문구를 찾지 못했다').not.toBeNull();
  });

  it('split.md 의 surface 문장이 CLAUDE.md 문구와 문자 단위로 같다', () => {
    const canonical = surfacingPhrase(claudeMd);
    const m = splitMd.match(/surface to the user: "([^"\n]+)"/);
    expect(m, 'split.md 의 surface to the user 문장을 찾지 못했다').not.toBeNull();
    expect(m[1]).toBe(canonical);
  });
});

describe('승격 트리거 — 헤더 명시 + 300줄 래칫', () => {
  it('헤더가 300줄 / 3문단 트리거를 명시한다', () => {
    expect(splitMd).toMatch(/\*\*승격 트리거\(지금 명시\)\*\*/);
    expect(splitMd).toMatch(/\*\*300줄\*\*/);
    expect(splitMd).toMatch(/\*\*3문단\*\*/);
  });

  it(`split.md 는 ${PROMOTION_LINE_TRIGGER}줄 이하다 — 넘으면 엔진 승격이 규약이다 (재현: wc -l commands/split.md)`, () => {
    expect(countLines(splitMd)).toBeLessThanOrEqual(PROMOTION_LINE_TRIGGER);
  });
});

describe('후속 Phase 절 — 병합된 것과 자리표시자', () => {
  it.each(['dispatch', 'run', 'integrate', 'handoff / resume'])('### %s 섹션 헤더가 있다', (h) => {
    expect(splitMd).toMatch(new RegExp(`^### ${h.replace(/[/]/g, '\\/')}(\\s|\\(|$)`, 'm'));
  });

  it('dispatch 는 fail-closed allowlist 3상태(unavailable/refused/ready)이며 부분 전송을 만들지 않는다', () => {
    expect(splitMd).toMatch(/allowlist — 아래 셋 외의 상태는 없다/);
    expect(splitMd).toMatch(/하나라도 비면 아무에게도 보내지 않는다/);
    expect(splitMd).toMatch(/lib\/git\/split-dispatch\.js#resolveDispatch/);
  });

  it('run 은 창 열기에서 반드시 멈추고 headless 창을 만들지 않는다', () => {
    expect(splitMd).toMatch(/`run` 은 여기서 \*\*반드시 멈춘다\*\*/);
    expect(splitMd).toMatch(/claude -p --worktree.*비목표/);
    expect(splitMd).toMatch(/\*\*폴링 루프 금지\*\*/);
  });

  it('integrate 는 배치 랜딩 절이며 status allowlist 와 strict 비용 고지를 싣는다 (Phase 4 초안 병합됨)', () => {
    expect(splitMd).not.toMatch(/초안 병합 예정/);
    expect(splitMd).toMatch(/lib\/git\/batch-landing\.js#landBatch/);
    expect(splitMd).toMatch(/lib\/git\/merge-preflight\.js#preflightBranches/);
    for (const s of ['landed', 'locked', 'degraded', 'conflict', 'push-failed', 'not-green', 'needs-human', 'error']) {
      expect(splitMd, `integrate status \`${s}\` 분기가 없다`).toMatch(new RegExp('`' + s + '` →'));
    }
    expect(splitMd).toMatch(/merge-tree 초록 ≠ 안전/);
  });

  it('status 세션 매칭은 접두가 아니라 "세그먼트 정확히 1개" 이며 matchingSessions 를 인용한다', () => {
    expect(splitMd).toMatch(/lib\/git\/split-dispatch\.js#matchingSessions/);
    expect(splitMd).toMatch(/세그먼트 정확히 1개/);
    expect(splitMd).not.toMatch(/로 시작하는 행을 줄기에 붙인다/);
  });

  it('측정 고지 3문구가 문자 그대로 있고 null 을 0 으로 바꾸지 않는다', () => {
    expect(splitMd).toMatch(/^측정 고지:\n1\. 실오퍼레이터 데이터 0건/m);
    expect(splitMd).toMatch(/^2\. wall-clock 은 인간 대기 포함/m);
    expect(splitMd).toMatch(/^3\. 사람 대기 비율 \{humanWaitPct\}%/m);
    expect(splitMd).toMatch(/`null` 은 `null` 로 찍는다/);
  });

  it('runId 는 split-{sid} 로 고정되고 resume 이 run 세그먼트를 다시 열지 않는다', () => {
    expect(splitMd).toMatch(/`split-\{sid\}` \(= `plan\.json\.sid`/);
    expect(splitMd).toMatch(/\*\*`run` 세그먼트는 다시 열지 않는다\*\*/);
  });
});
