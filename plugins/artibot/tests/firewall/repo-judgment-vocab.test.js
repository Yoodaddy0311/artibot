/**
 * 검사 목적: `/repo` 판정 어휘가 **커맨드와 서브에이전트 양쪽에서 일치**하는가,
 * 그리고 서브에이전트 출력 템플릿이 **3 VETO + 4 GAIN 축을 실제로 다 들고 있는가**.
 *
 * ══ 이 게이트가 무엇이 아닌지 먼저 (가장 중요) ═══════════════════════════════
 *
 * **이것은 판정 품질 게이트가 아니다.** 모델이 안전성 축을 옳게 적용했는지,
 * SUPPRESSED 가 정당한지, 증거가 진짜 클론 트리에서 왔는지 — **한 줄도 보지
 * 않으며, 볼 수 없다.** 이 파일이 초록인 것을 "7축 판정이 지켜지고 있다"의 근거로
 * 쓰면 그것이 바로 이 세션이 반복해서 당한 착시다.
 *
 * 이 게이트가 보는 것은 단 하나: **판정에 쓰이는 어휘가 두 파일에서 갈라지지
 * 않았는가.** 그뿐이다.
 *
 * ══ 왜 나머지는 게이트로 만들 수 없는가 (2026-08-16 타당성 조사) ═════════════
 *
 * `/repo` 의 7축 판정·D1~D4 입력 가드·Evidence allowlist 를 자동 강제하려면
 * **판정 결과물이 디스크에 있어야 한다.** 없다. 실측:
 *
 *   commands/repo.md:4  allowed-tools: [Read, Glob, Grep, Bash, Agent,
 *                                       TaskCreate, TaskUpdate]
 *                       → `Write` 도 `Edit` 도 없다. 파일을 만들 수 없다.
 *   commands/repo.md 전문에 파일 기록 지시 0건
 *                       (write|save|저장|REPORTS/|output file grep = 0)
 *   scripts/hooks/ · lib/ 에 `/repo` 출력을 갈무리하는 경로 0건
 *                       (SUPPRESSED|ADOPTABLE|SCORE MATRIX grep 매치 6건은
 *                        전부 소문자 "suppressed" — 알림 스로틀링 주석이었다)
 *
 * 즉 SUPPRESSED 행·ADOPT 행·grep 컬럼·증거 마커는 **세션 대화 텍스트로만
 * 존재하고 리포에 남지 않는다.** CI 는 git 체크아웃 위에서 도는데 거기에 그
 * 산출물이 없다. **"어렵다"가 아니라 구조적으로 불가능하다.**
 *
 * 출력을 파일로 남기게 바꾸면 검사 가능해지지만, 그건 `/repo` 의 동작 변경이고
 * `allowed-tools` 에 `Write` 를 추가하는 일이라 별건이다. 이 파일은 그 제안을
 * 하지 않는다 — 기록만 남긴다.
 *
 * ══ 그래서 무엇을 강제하는가 — 항목마다 "없으면 무엇이 새는가" ═══════════════
 *
 *  1. **어휘 lockstep.** 판정 규칙은 `commands/repo.md` 가 서술하지만, 그 판정을
 *     **실제로 출력하는 것은 `agents/repo-benchmarker.md`** 다(커맨드가 Agent 로
 *     위임한다). 에이전트 쪽 `Grading rules` 첫 줄이 스스로
 *     "same vocabulary the orchestrator's gate consumes" 라고 계약을 선언한다.
 *     → **없으면 무엇이 새는가**: 한쪽에서 `INSUFFICIENT-INSPECTION` 을 개명하면
 *       커맨드의 "마커가 붙은 후보는 ADOPT 불가, DEFER 로 강등" 규칙이 **조용히
 *       사문화**된다. 에이전트가 그 토큰을 영영 안 내보내므로 강등이 발동하지
 *       않고, **DEFER 여야 할 후보가 ADOPT 로 통과한다.** 아무 것도 빨개지지 않는다.
 *
 *  2. **축 arity (VETO 3 / GAIN 4).** 서브에이전트 출력 템플릿에서 축 한 줄이
 *     빠져도 커맨드 산문에는 여전히 "3 VETO + 4 GAIN" 이라 적혀 있다.
 *     → **없으면 무엇이 새는가**: 빠진 축은 **영영 평가되지 않는데** 문서는 7축을
 *       주장한다. 오늘 세션의 지배 패턴("초록인데 그 축을 안 본다")과 동형이다.
 *
 * 나머지 후보는 **전부 REJECT** 했다(기본값 REJECT). 사유는 위 "불가능" 문단.
 *
 * ══ 이 게이트가 못 보는 것 (rules §9 — 안 적으면 다음 착시의 근거가 된다) ════
 *
 *  1. **판정 품질 전부.** 위에 썼다. 다시 쓴다: 축 적용의 옳고 그름, SUPPRESSED
 *     사유의 타당성, 증거 출처의 진위 — 전부 못 본다.
 *  2. **런타임 출력 전부.** grep 컬럼이 비었는지, ADOPT 행에 근거 `file:line` 이
 *     붙었는지 — 산출물이 없어 검사 불가.
 *  3. **D1~D4 입력 가드 준수 여부.** realpath 재검사·확장자 allowlist·크기 상한·
 *     자격증명 거부는 전부 **모델 실행 시점 행동**이다. 코드가 아니라 산문 사양이라
 *     실행 경로가 없고, 따라서 테스트할 대상도 없다.
 *  4. **어휘가 두 파일에서 사이좋게 같이 틀리는 경우.** 양쪽을 동시에 개명하면
 *     통과한다. 이건 lockstep 게이트의 원리적 한계다(`report-contract-parity`
 *     와 같은 성질).
 *  5. **커맨드 쪽에만 새 어휘가 추가되는 경우.** 커맨드의 마커 서술은 산문이라
 *     파싱하지 않는다. 에이전트 템플릿 열거만 기계 파싱한다. 즉 `SHARED_VOCAB`
 *     에 없는 **신규** 용어가 `repo.md` 에만 생기면 이 게이트는 모른다.
 *     → 완화책은 있다: 아래 "열거 집합 일치" 단언이 **에이전트 쪽 열거**가
 *       allowlist 와 정확히 같기를 요구하므로, 마커를 늘리려면 이 파일도 함께
 *       고쳐야 한다. 그래도 커맨드 단독 추가는 여전히 사각이다.
 *  6. **`commands/repo.md`·`agents/repo-benchmarker.md` 밖은 스코프 밖.**
 *
 * @module tests/firewall/repo-judgment-vocab
 */

import { describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import {
  checkVocabLockstep,
  EVIDENCE_MARKERS,
  GAIN_AXES,
  parseAxisTemplate,
  parseMarkerEnum,
  SHARED_VOCAB,
  VETO_AXES,
} from './repo-judgment-vocab.js';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(__dirname, '..', '..');
const COMMAND_MD = join(PLUGIN_ROOT, 'commands', 'repo.md');
const AGENT_MD = join(PLUGIN_ROOT, 'agents', 'repo-benchmarker.md');

const readCommand = () => readFileSync(COMMAND_MD, 'utf-8');
const readAgent = () => readFileSync(AGENT_MD, 'utf-8');

describe('/repo 판정 어휘 — 분모', () => {
  it('두 파일을 실제로 읽는다 (빈 파일이면 lockstep 은 공허하다)', () => {
    expect(readCommand().length).toBeGreaterThan(2000);
    expect(readAgent().length).toBeGreaterThan(2000);
  });

  it('검사 어휘가 15개다 (allowlist 크기를 못박는다)', () => {
    // 조용히 줄면 "0 위반"이 "0개 검사"가 된다.
    expect(SHARED_VOCAB.length).toBe(15);
    expect(new Set(SHARED_VOCAB).size).toBe(15); // 중복으로 부풀리지 않았는가
  });
});

describe('/repo 판정 어휘 — lockstep', () => {
  it('어휘 15개가 커맨드와 에이전트 양쪽에 모두 등장한다', () => {
    const { missing, checked } = checkVocabLockstep(readCommand(), readAgent());
    const detail = missing.map((m) => `  '${m.term}' 이 ${m.absentFrom} 에 없다`).join('\n');
    expect(checked).toBe(15);
    expect(missing.map((m) => `${m.term}@${m.absentFrom}`), `어휘 드리프트:\n${detail}`).toEqual([]);
  });
});

describe('/repo 판정 어휘 — 서브에이전트 템플릿 arity', () => {
  it('마커 열거가 파싱되고 allowlist 와 정확히 일치한다', () => {
    const parsed = parseMarkerEnum(readAgent());
    expect(parsed.ok, parsed.ok ? '' : parsed.reason).toBe(true);
    // `none` 은 "마커 없음" 표기라 제외하고 비교한다.
    const named = parsed.markers.filter((m) => m !== 'none');
    expect([...named].sort()).toEqual([...EVIDENCE_MARKERS].sort());
    expect(parsed.markers).toContain('none'); // "없음"을 표현할 수단이 사라지면 안 된다
  });

  it('출력 템플릿이 VETO 3축 · GAIN 4축을 전부 들고 있다', () => {
    const parsed = parseAxisTemplate(readAgent());
    expect(parsed.ok, parsed.ok ? '' : parsed.reason).toBe(true);
    expect(parsed.veto).toEqual(VETO_AXES);
    expect(parsed.gain).toEqual(GAIN_AXES);
  });

  it('커맨드가 "3 VETO + 4 GAIN" 을 그대로 주장한다 (산문과 템플릿의 접점)', () => {
    // 산문 쪽 숫자가 바뀌었는데 템플릿이 안 따라오면(또는 반대면) 여기서 갈린다.
    expect(readCommand()).toContain('3 VETO + 4 GAIN');
  });
});

describe('스캐너 자기검증 — 파서', () => {
  it('마커 열거를 읽는다', () => {
    expect(parseMarkerEnum('    Dimension marker: [none|A|B]')).toEqual({
      ok: true,
      markers: ['none', 'A', 'B'],
    });
  });

  it('마커 열거가 없거나 비면 ok:false 다 (조용한 통과 아님)', () => {
    expect(parseMarkerEnum('아무것도 없음').ok).toBe(false);
    expect(parseMarkerEnum('Dimension marker: []').ok).toBe(false);
  });

  it('축 템플릿에서 이름만 뽑는다', () => {
    const text = ['    VETO  가:[pass|FAIL]  나:[pass|FAIL]', '    GAIN  다:[0-3]'].join('\n');
    expect(parseAxisTemplate(text)).toEqual({ ok: true, veto: ['가', '나'], gain: ['다'] });
  });

  it('VETO/GAIN 줄이 없으면 ok:false 다', () => {
    expect(parseAxisTemplate('GAIN  가:[0-3]').ok).toBe(false); // VETO 없음
    expect(parseAxisTemplate('VETO  가:[pass|FAIL]').ok).toBe(false); // GAIN 없음
  });
});

describe('스캐너 자기검증 — 게이트가 헛돌지 않는다', () => {
  // ── 음성 대조 (rules §10.5(e)) ───────────────────────────────────────────
  // 워킹트리를 건드리지 않는다. 두 파일은 **다른 팀원 담당**이라 더더욱.
  it('어휘 하나가 에이전트에서 사라지면 잡는다', () => {
    const agent = readAgent().split('INSUFFICIENT-INSPECTION').join('XXX');
    // ② 뮤테이션 적용 독립 확인 — 안 하면 아래 단언이 공허하다.
    expect(agent.includes('INSUFFICIENT-INSPECTION')).toBe(false);
    expect(readAgent().includes('INSUFFICIENT-INSPECTION')).toBe(true); // 원본은 그대로

    const { missing } = checkVocabLockstep(readCommand(), agent);
    expect(missing).toEqual([
      { term: 'INSUFFICIENT-INSPECTION', absentFrom: 'agents/repo-benchmarker.md' },
    ]);
  });

  it('어휘 하나가 커맨드에서 사라져도 잡는다 (양쪽 방향)', () => {
    const cmd = readCommand().split('SUPPRESSED').join('XXX');
    expect(cmd.includes('SUPPRESSED')).toBe(false);
    const { missing } = checkVocabLockstep(cmd, readAgent());
    expect(missing).toEqual([{ term: 'SUPPRESSED', absentFrom: 'commands/repo.md' }]);
  });

  it('GAIN 축을 하나 지우면 arity 단언이 RED 가 된다', () => {
    const agent = readAgent().replace('창의성:[0-3]', '');
    expect(agent.includes('창의성:[0-3]')).toBe(false); // ② 적용 확인
    const parsed = parseAxisTemplate(agent);
    expect(parsed.ok).toBe(true);
    expect(parsed.gain).not.toEqual(GAIN_AXES);
    expect(parsed.gain.length).toBe(3); // 4 → 3
  });

  it('빈 어휘 목록이면 위반 0 이다 (검출이 목록에 실제로 의존한다)', () => {
    const { missing, checked } = checkVocabLockstep(readCommand(), readAgent(), []);
    expect(missing).toEqual([]);
    expect(checked).toBe(0);
  });

  it('양성 대조 — 어휘를 전부 없앤 텍스트에는 30건이 잡힌다', () => {
    // 15개 × 2파일. 스캐너가 실제로 두 파일을 다 훑는다는 증거.
    const { missing } = checkVocabLockstep('', '');
    expect(missing.length).toBe(30);
  });
});
