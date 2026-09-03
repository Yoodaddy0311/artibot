/**
 * Firewall — 헌법 단계 A 중 commands 소유분(A-5·A-6·A-7)이 리포 정본에 남아 있는지.
 *
 * ── 무엇을 지키는가 ─────────────────────────────────────────────────────────
 *  A-5  `commands/plan.md` 의 `## 복구 사다리 (D05)` — 세 칸이 서로 다른 대응으로
 *       구분돼 있어야 한다: 구현 오류 → **현 플랜 수리**, 플랜 오류 → **플랜 개정**,
 *       프레이밍·아키텍처 오류 → **`/ultraplan`**(희귀). 그리고 `commands/ultraplan.md`
 *       Anti-Patterns 에 "일반 실패를 재프레이밍으로 끌고 오지 마라" 한 줄.
 *       두 파일이 짝이다 — 사다리만 있고 진입 금지가 없으면 맨 윗칸이 기본값이 된다.
 *
 *  A-6  `commands/team.md` 의 "Effort & Task Budget" 에서 **SDK `output_config` JSON
 *       스니펫이 사라졌는가**(설계 §3.7 R7). 그 스니펫은 `Agent` 도구에 없는 파라미터를
 *       "호출 측이 직접 지정한다" 고 가르쳤다. 실측 근거는 `lib/cognitive/effort-policy.js`
 *       주석 — 플러그인에는 Messages API 호출자가 없고 `output_config.effort` 를 세팅하는
 *       곳도 없다. **삭제만으로는 부족하다**: effort 가 실제로 팀원에게 닿는 경로
 *       (`[artibot:effort level=…]` 프롬프트 디렉티브 + `runtime/current-effort.json`)가
 *       그대로 살아 있어야 하므로, 그쪽은 **존재**를 단언한다. 삭제 게이트가 정작
 *       대체 경로까지 지워지는 것을 못 보면 게이트가 결함을 만든다.
 *
 *  A-7  `commands/adr.md` 의 "결정 요소만 질문한다 (D09 · OD-5)" — 결정 요소는 묻고
 *       사실은 조사한다는 분리, 질문 게이트 4조건, 권장 옵션 `(권장)` 표기 규칙,
 *       비대화형 정지. 더해 본문이 `AskUserQuestion(...)` 를 호출하라고 지시하므로
 *       프론트매터 `allowed-tools` 에 그 이름이 **선언돼 있어야** 한다
 *       (`command-body-tool-parity.test.js` 와 같은 규율을 이 절에 대해 못박는다).
 *
 *  그리고 **추가·삭제가 범위를 넘지 않았는지**를 같이 지킨다. team.md 의 `[보고 계약]`·
 *  `[중계 계약]` 블록은 5캐리어 바이트 parity 대상이라 이 작업이 건드리면 안 됐다.
 *  `tests/commands/report-contract-parity.test.js` 가 정본 게이트지만, 여기서도 두 블록의
 *  **존재**를 단언한다 — A-6 이 같은 파일을 자르는 편집이었기 때문이다.
 *
 * ── 이 게이트가 못 보는 것 (rules §9 — 게이트 옆에 못 보는 것을 적어라) ─────
 *
 *  1. **문장이 지켜지는지.** 존재 ≠ 작동(§2). plan.md 에 사다리가 적혀 있다고 해서
 *     실패한 세션이 실제로 층을 판정하고 한 칸만 올라갔는지는 이 스캔 밖이다.
 *     복구 사다리 준수율은 현재 **미측정**이다.
 *  2. **다른 철자.** 리터럴 스캔이다. 같은 뜻을 다른 말로 바꾸면 거짓 양성(RED)이고,
 *     어구만 남기고 뜻을 비틀면 거짓 음성(통과)이다. 우회 방지 장치가 아니다.
 *  3. **`output_config` 의 다른 표기.** A-6 금칙어는 `output_config`·`task_budget` JSON
 *     키와 `task-budgets-` 베타 헤더 문자열이다. 같은 내용을 산문으로 풀어 쓰거나
 *     `outputConfig` 로 캐멀케이스화하면 이 스캔에 걸리지 않는다.
 *  4. **다른 커맨드의 같은 결함.** 스코프는 A-5·A-6·A-7 이 소유한 네 파일뿐이다.
 *     측정 시각 2026-09-02 기준 `commands/implement.md:74-88` 에 **같은 형태의
 *     `output_config` JSON 스니펫이 남아 있다** — T-07 소유 경로가 아니라 손대지
 *     않았고, 이 게이트도 그것을 보지 않는다. 여기 그린을 "리포 전체에 API 오정보가
 *     없다" 의 근거로 쓰지 마라.
 *  5. **설치본 드리프트.** 리포 정본만 읽는다. 사용자 환경에 설치된 커맨드 사본이
 *     어긋나 있어도 조용하다(사본 대조 게이트 **없음** — 미확인).
 *
 * @module tests/firewall/constitution-stage-a-commands
 */

import { describe, expect, it } from 'vitest';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const COMMANDS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..', 'commands',
);

const PLAN = path.join(COMMANDS_DIR, 'plan.md');
const ULTRAPLAN = path.join(COMMANDS_DIR, 'ultraplan.md');
const TEAM = path.join(COMMANDS_DIR, 'team.md');
const ADR = path.join(COMMANDS_DIR, 'adr.md');

/**
 * 파일을 읽되 **없으면 던진다**. fail-closed 형태다 — 파일이 사라지면 스캔이
 * "0건 위반" 으로 조용히 통과하는 게 아니라 RED 가 된다(rules §10).
 *
 * @param {string} file
 * @returns {string}
 */
function read(file) {
  if (!fsSync.existsSync(file)) throw new Error(`missing canonical file: ${file}`);
  return fsSync.readFileSync(file, 'utf-8');
}

/** 줄 종결자를 정규화한다 — 이 리포의 커맨드 문서는 워킹트리에서 CRLF 다. */
function normalize(source) {
  return source.replace(/\r\n/g, '\n');
}

/**
 * 펜스 코드블록의 **내용만** 모은다.
 *
 * A-6 의 표적은 산문이 아니라 **스니펫**이다. 커맨드 문서에서 펜스 블록은 "이대로
 * 써라" 로 읽히고, 정확히 그 형태가 `Agent` 도구에 없는 파라미터를 가르쳤다. 반대로
 * 산문에서 `output_config` 를 **언급**하는 것은 필요하다 — 무엇을 왜 지웠는지 적어
 * 두지 않으면 다음 사람이 되돌려 놓는다. 그래서 금칙 스캔은 펜스 안으로 한정한다.
 *
 * 못 보는 것: 들여쓰기 4칸 코드블록과 `<pre>` 는 안 본다(이 리포의 커맨드 문서는
 * 전부 펜스를 쓴다 — 측정 시각 2026-09-02). 그리고 **산문으로 되돌아온 지시**는
 * 이 함수로 못 잡는다 — "호출 측은 `output_config.effort` 로 지정한다" 를 펜스 없이
 * 다시 쓰면 통과한다. 그 층은 사람이 봐야 한다.
 *
 * @param {string} source
 * @returns {string} 모든 펜스 블록 내용을 개행으로 이어붙인 문자열
 */
function fencedBlocks(source) {
  const lines = normalize(source).split('\n');
  const out = [];
  let inside = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) { inside = !inside; continue; }
    if (inside) out.push(line);
  }
  return out.join('\n');
}

/** 헤딩 문자열만 뽑는다 — 본문 문구 다듬기에는 반응하지 않게. */
function headings(source) {
  return normalize(source).split('\n')
    .map((line) => line.trim())
    .filter((line) => /^#{1,6}\s/.test(line));
}

describe('헌법 단계 A — commands 소유분 (A-5·A-6·A-7)', () => {
  describe('분모 — 대상 파일 4개가 실재한다', () => {
    it.each([
      ['commands/plan.md', PLAN],
      ['commands/ultraplan.md', ULTRAPLAN],
      ['commands/team.md', TEAM],
      ['commands/adr.md', ADR],
    ])('%s 가 있다', (_label, file) => {
      expect(fsSync.existsSync(file)).toBe(true);
      expect(read(file).length).toBeGreaterThan(500);
    });
  });

  describe('A-5 — plan.md 복구 사다리 (D05)', () => {
    it('`## 복구 사다리 (D05)` 절이 있다', () => {
      expect(headings(read(PLAN))).toContain('## 복구 사다리 (D05)');
    });

    it('세 칸이 서로 다른 대응으로 구분돼 있다 — 수리 / 개정 / 재프레이밍', () => {
      const body = normalize(read(PLAN));
      const start = body.indexOf('## 복구 사다리 (D05)');
      expect(start).toBeGreaterThan(-1);
      // 다음 `## ` 헤딩 전까지가 이 절의 본문이다.
      const rest = body.slice(start + 1);
      const nextHeading = rest.indexOf('\n## ');
      const section = nextHeading === -1 ? rest : rest.slice(0, nextHeading);

      // 구현 오류 → 현 플랜 수리 (플랜은 유지)
      expect(section).toMatch(/구현/);
      expect(section).toMatch(/플랜을 수리/);
      // 플랜 오류 → 플랜 개정
      expect(section).toMatch(/플랜을 개정/);
      // 프레이밍·아키텍처 오류 → /ultraplan
      expect(section).toMatch(/프레이밍/);
      expect(section).toContain('/ultraplan');
    });

    it('맨 윗칸이 희귀하다는 것과 층 판정 요구가 본문에 있다', () => {
      const body = normalize(read(PLAN));
      expect(body).toMatch(/희귀/);
      // "진단 없이 위층으로" 를 금지하는 문장 — 사다리를 건너뛰는 것이 이 절의 표적이다.
      expect(body).toMatch(/진단 없이/);
    });

    it('기존 절이 삭제되지 않았다 — 추가만 했다', () => {
      const hs = headings(read(PLAN));
      for (const heading of [
        '# /plan',
        '## Arguments',
        '## Execution Flow',
        '## Plan Structure',
        '## Output Format',
        '## Artifacts Integration',
        '## Next Steps',
      ]) {
        expect(hs).toContain(heading);
      }
    });
  });

  describe('A-5 짝 — ultraplan.md 재프레이밍 진입 금지', () => {
    it('Anti-Patterns 에 일반 실패의 재프레이밍 진입을 금지하는 줄이 있다', () => {
      const body = normalize(read(ULTRAPLAN));
      const start = body.indexOf('## Anti-Patterns');
      expect(start).toBeGreaterThan(-1);
      const rest = body.slice(start + 1);
      const nextHeading = rest.indexOf('\n## ');
      const section = nextHeading === -1 ? rest : rest.slice(0, nextHeading);

      expect(section).toMatch(/재프레이밍/);
      expect(section).toMatch(/희귀/);
      // 사다리 정본이 plan.md 라는 포인터가 있어야 두 문서가 갈라지지 않는다.
      expect(section).toContain('복구 사다리');
      expect(section).toContain('commands/plan.md');
    });
  });

  describe('A-6 — team.md 의 SDK effort 스니펫 삭제 (설계 §3.7 R7)', () => {
    /**
     * 펜스 코드블록 안의 금칙 문자열. `Agent` 도구에 존재하지 않는 파라미터를
     * "이렇게 지정한다" 고 가르치던 JSON 스니펫의 흔적이다. 산문의 **언급**은
     * 허용한다(`fencedBlocks` 주석 참조) — 지운 이유를 적어 두는 것이 재발 방지다.
     */
    const FORBIDDEN_IN_SNIPPETS = ['output_config', 'task_budget', 'anthropic-beta'];

    it.each(FORBIDDEN_IN_SNIPPETS)('team.md 의 코드블록에 `%s` 가 없다', (needle) => {
      expect(fencedBlocks(read(TEAM))).not.toContain(needle);
    });

    it('베타 헤더 문자열은 산문에도 없다 — 존재하지 않는 헤더를 옮겨 적을 여지 0', () => {
      expect(normalize(read(TEAM))).not.toContain('task-budgets-');
    });

    it('effort 가 실제로 닿는 경로는 남아 있다 — 디렉티브 + runtime 파일', () => {
      const body = normalize(read(TEAM));
      // 프롬프트 디렉티브(유일한 실경로)
      expect(body).toContain('[artibot:effort level=');
      expect(body).toContain('[artibot:task-budget max_tokens=');
      // 값의 출처
      expect(body).toContain('runtime/current-effort.json');
      expect(body).toContain('runtime/current-task-budget.json');
      // 디렉티브 주입 절 자체
      expect(headings(body)).toContain('### Auto-Effort Pre-injection (현재 정책 티어 Agentic)');
    });

    it('삭제 이유가 본문에 남아 있다 — `Agent` 도구에 파라미터가 없다는 진술', () => {
      const body = normalize(read(TEAM));
      expect(body).toMatch(/`Agent` 도구에는 effort·budget 파라미터가 \*\*없다\*\*/);
      // 실측 근거 인용 (존재 ≠ 작동을 구분하는 출처)
      expect(body).toContain('lib/cognitive/effort-policy.js');
    });

    it('effort 권장값 표는 유지됐다 — 삭제가 정책까지 지우지 않았다', () => {
      const body = normalize(read(TEAM));
      expect(headings(body)).toContain('### Effort & Task Budget');
      for (const level of ['max', 'xhigh', 'high', 'medium', 'low']) {
        expect(body).toContain(level);
      }
      expect(body).toContain('| `/team` 구현 phase | xhigh | 128,000 |');
    });

    it('보고·중계 계약 블록이 살아 있다 — A-6 편집이 같은 파일을 잘랐다', () => {
      const body = normalize(read(TEAM));
      expect(body).toContain('[보고 계약]');
      expect(body).toContain('[중계 계약]');
      expect(body).toContain('SendMessage(to=');
    });
  });

  describe('A-7 — adr.md 결정 요소만 질문 (D09 · OD-5)', () => {
    it('`## 결정 요소만 질문한다 (D09 · OD-5)` 절이 있다', () => {
      expect(headings(read(ADR))).toContain('## 결정 요소만 질문한다 (D09 · OD-5)');
    });

    it('결정 요소는 묻고 사실은 조사한다는 분리가 있다', () => {
      const body = normalize(read(ADR));
      expect(body).toMatch(/\*\*결정 요소\*\* \(물어본다\)/);
      expect(body).toMatch(/\*\*사실\*\* \(조사한다\)/);
      // 사실을 모르면 질문이 아니라 "조사 필요" 로 남긴다
      expect(body).toContain('조사 필요');
    });

    it('질문 게이트 4조건이 모두 있다', () => {
      const body = normalize(read(ADR));
      expect(body).toMatch(/\*\*가치 판단\*\*/);
      expect(body).toMatch(/\*\*하류 영향\*\*/);
      expect(body).toMatch(/\*\*증거로 결정할 수 없다\*\*/);
      expect(body).toMatch(/\*\*틀린 가정의 비용\*\*/);
      // "모두" 만족일 때만 — 부정 목록이 아니라 합조건이라는 진술
      expect(body).toMatch(/넷을 \*\*모두\*\* 만족할 때만/);
    });

    it('권장 옵션 표기 규칙이 label 안에 있어야 한다고 못박는다', () => {
      const body = normalize(read(ADR));
      expect(body).toContain('` (권장)`');
      expect(body).toMatch(/options` 배열의 첫 번째/);
    });

    it('비대화형 실행에서는 지어내지 않고 정지한다', () => {
      const body = normalize(read(ADR));
      expect(body).toMatch(/비대화형/);
      expect(body).toMatch(/\*\*정지\*\*/);
    });

    it('본문이 호출하는 AskUserQuestion 이 allowed-tools 에 선언돼 있다', () => {
      const body = normalize(read(ADR));
      // 본문 지시 (호출 표기)
      expect(body).toContain('`AskUserQuestion(...)`');
      // 프론트매터 선언
      const frontmatter = body.split('---')[1] ?? '';
      expect(frontmatter).toMatch(/allowed-tools:.*AskUserQuestion/);
    });

    it('기존 절이 삭제되지 않았다 — 추가만 했다', () => {
      const hs = headings(read(ADR));
      for (const heading of [
        '# /adr',
        '## Arguments',
        '## Execution Flow',
        '## Output Format',
        '## Quality Gates',
        '## Examples',
        '## Next Steps',
      ]) {
        expect(hs).toContain(heading);
      }
    });
  });
});
