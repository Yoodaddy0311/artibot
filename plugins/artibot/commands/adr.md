---
description: (Artibot) ADR(Architecture Decision Record) 작성 - 두 개 이상 기술 선택지의 trade-off, 숨겨진 비용, 2년 뒤 부채까지 7섹션으로 비교하고 추천안 제시
argument-hint: '[선택지 A] vs [선택지 B] e.g. "PostgreSQL vs MongoDB", "React Query vs SWR"'
allowed-tools: [Read, Glob, Grep, Bash, Task]
toolset: team
lifecycle: plan
---

# /adr

기술 선택 의사결정을 ADR(Architecture Decision Record) 양식으로 작성한다. 단순 비교가 아니라 **추천안 + 숨은 비용 + 10× 트래픽 시나리오 + 2년 뒤 기술 부채**까지 입체적으로 평가해, 비개발자도 결정을 이해할 수 있게 만든다.

## 언제 자동 트리거되는가

다음과 같은 자연어 패턴이 감지되면 `/adr`가 자동 실행된다 (유저에게 슬래시 커맨드 노출 없이):

- "A vs B", "X와 Y 중 뭐가 좋아", "어떤 라이브러리 써야 해"
- "DB 뭐 쓰지", "프레임워크 고민", "이거 쓸까 저거 쓸까"
- "스택 결정", "아키텍처 결정", "기술 선택"
- "should I use X or Y", "which is better", "compare X and Y"

## Arguments

`$ARGUMENTS` 파싱:
- `option-a vs option-b [vs option-c ...]`: 비교 대상 (자연어 OK — "PostgreSQL이랑 MongoDB 중에" 같은 표현도 정규화)
- `--depth [level]`: `quick` (핵심 결정만, ~2K) | `standard` (7섹션 전체, ~5K) | `deep` (모든 섹션 + 외부 리서치, ~10K)
- `--audience [level]`: `dev` (기술자 중심) | `mixed` (개발자+PM) | `non-tech` (창업자/디자이너 친화, 한국어 위주, 어려운 용어 풀어쓰기)
- `--save [path]`: ADR 파일 저장 경로 (기본: `docs/adr/ADR-{NNN}-{slug}.md`)
- `--scale [factor]`: 확장성 시나리오 배수 (기본 `10x`. `3x`, `100x`도 가능)

## Execution Flow

1. **Parse**: `$ARGUMENTS`에서 선택지 추출. "vs"/"이랑"/"와"/"or" 같은 구분자 모두 인식. 선택지 2~4개로 정규화. 1개면 `clarify` 스킬로 라우팅 ("어떤 대안과 비교할까요?").

2. **Context Gathering**: 현재 프로젝트 컨텍스트를 자동 수집:
   - `package.json` / `requirements.txt` / `go.mod` / `pyproject.toml` — 기존 스택
   - `docs/adr/` 폴더 존재 시 기존 ADR 번호 확인 (auto-increment)
   - `README.md` / `CLAUDE.md` — 프로젝트 규모, 제약
   - 최근 commit log — 팀 활동성 / 기술 추가 트렌드
   - 비교 대상 관련 파일 grep — 이미 일부 채택돼 있나

3. **Skill Activation**: `adr-format` skill 활성화. 7-섹션 프레임워크 로드.

4. **Agent Delegation** (복잡도 medium+):
   - `Task(architect)` — 시스템 영향, 모듈 경계, 의존성 분석
   - `Task(planner)` — 마이그레이션/도입 phase 분해 (선택)
   - 단순 라이브러리 비교(routing lib 같은)는 inline 처리

5. **7-Section Fill**: 각 섹션을 차례로 채움. 빈칸은 "조사 필요" 명시(거짓 숫자 금지).
   1. 컨텍스트와 제약사항
   2. 각 접근의 trade-off
   3. 확장성 관점 평가
   4. 10× 트래픽/데이터 증가 시 문제 (`--scale` 옵션 반영)
   5. 숨겨진 비용 (라이선스/학습/채용/운영/마이그레이션)
   6. 추천안과 그 이유 (**굵게 강조**)
   7. 2년 뒤 기술 부채 예상 포인트

6. **TL;DR 작성**: 최상단에 1~2줄 결론. 비개발자가 첫 줄만 읽고 결정할 수 있게.

7. **Save**: `--save` 경로 또는 기본 `docs/adr/ADR-{NNN}-{slug}.md`에 저장. 폴더 없으면 `Bash mkdir -p` 후 생성.

8. **Report**: 콘솔에 요약 + 저장 경로 출력.

## Output Format

```
═══════════════════════════════════════════════════
  ADR-{NNN}: {결정 제목}
═══════════════════════════════════════════════════
저장: docs/adr/ADR-{NNN}-{slug}.md
대상: {선택지 A} vs {선택지 B} [vs {선택지 C}]
청중: dev | mixed | non-tech

✓ 추천: {선택지 X}
  근거: {핵심 한 줄}

━━━ 비교 요약 ━━━
| 기준          | A    | B    |
|---------------|------|------|
| 학습 곡선     | ★★★★ | ★★   |
| 확장성 (10×)  | ★★★  | ★★★★★|
| 운영 비용     | ★★★★ | ★★★  |
| 채용 풀       | ★★★★ | ★★   |
| 2년 부채      | 중   | 낮음 |
| 가중 합계     | 3.65 | 3.85 |

━━━ 결정의 결과 ━━━
좋아짐:
  - {긍정 결과 1~2}

부담 추가:
  - {부정 결과 1~2}

━━━ 필수 후속 작업 ━━━
[ ] {action 1}
[ ] {action 2}

━━━ 2년 뒤 부채 ━━━
- {예상 부채} → 완화: {전략}

재검토 트리거: {조건 — 예: MAU 100만 또는 2027-Q4}
```

## 비개발자 친화 모드 (`--audience non-tech`)

- 모든 영어 기술 용어를 첫 등장 시 한국어로 풀어쓴다.
  - 예: "ORM(객체-관계 매퍼, 코드에서 DB를 객체처럼 다루게 해주는 도구)"
- 비용은 "월 $X" 또는 "팀원 N주" 단위로 환산해 비교 가능하게.
- TL;DR은 반드시 두 줄 이내. 첫 줄만 읽어도 결정 가능.
- 표/별점 적극 활용. 산문 길게 늘어놓지 않음.
- 코드 스니펫은 최소화. 필요시 "예시 코드(참고용)" 명시.

## Quality Gates

ADR을 출력하기 전 자체 체크:

- [ ] 추천안이 명확히 1개 (둘 다 추천 금지)
- [ ] 7섹션 모두 채워짐 (모르면 "조사 필요" 명시)
- [ ] 숨겨진 비용 섹션이 비어있지 않음
- [ ] 10× 시나리오가 구체적 (두루뭉술 "잘 됨/안 됨" 금지)
- [ ] 2년 뒤 부채가 "딱히 없음"이 아님
- [ ] TL;DR이 첫 줄에 있고, 비개발자도 이해 가능

## Examples

```
사용자: "PostgreSQL이랑 MongoDB 중에 뭐가 나아?"
→ /adr 자동 트리거 (audience=mixed)
→ 7-섹션 ADR 출력 + docs/adr/ADR-001-primary-database.md 저장

사용자: "React Query, SWR, RTK Query 셋 중에 고민이야"
→ /adr 자동 트리거 (3개 선택지, audience=dev 추정)
→ 3-way 비교 표 + 가중 스코어링

사용자(창업자): "결제는 Stripe 써야 할까 Toss 써야 할까?"
→ /adr 자동 트리거 (audience=non-tech)
→ 한국어 위주, 월 운영비/수수료/도입 기간 단위로 환산
→ TL;DR 첫 줄 = 추천안 + 핵심 이유
```

## Next Steps

작업 완료 후 추천 후속 액션:

| # | 액션 | 커맨드 | 설명 |
|---|------|--------|------|
| 1 | 결정 실행 | `/plan` | 채택된 안의 도입/마이그레이션 계획 |
| 2 | 공수 산정 | `/estimate` | 도입 비용/기간 정량화 |
| 3 | 작업 등록 | `/task` | ADR 후속 작업을 task로 |
| 4 | 검토 요청 | `/code-review` | 도입 코드 작성 후 리뷰 |
