# ADR-002: 네이티브 마켓플레이스 설치에서 8개 auto-activating rules 전달

## 추천 결론 (TL;DR)
> **C(플러그인-배송 path-scoped rule-injector 훅)를 구조적 해법으로 채택하고, 그때까지 B(문서
> 고지, 이미 배포됨)를 인터림으로 유지한다.** 현행은 rules를 `install.sh`가 `~/.claude/rules/artibot/`에
> 복사해 Claude Code의 **네이티브 rules 로딩**으로 활성화하는데, 네이티브(마켓플레이스) 설치는 그
> 복사 단계가 없고 plugin.json의 `rules[]`는 공식 스키마 밖이라 무시된다(B6). rule *내용*의 ~70–80%는
> 네이티브로도 배송되는 skill/agent/CLAUDE.md가 이미 커버하지만, **파일 경로 기반 앰비언트 주입**
> (의도 키워드 없이 파일 편집만으로 규칙이 뜨는 것)은 네이티브에서 소실된다. A(스킬 흡수)는 바로 그
> path-trigger를 없애 flat 사용자에게 회귀를 유발하므로 기각. C는 훅(플러그인으로 배송됨 +
> `CLAUDE_PLUGIN_ROOT` 가용)으로 **양 설치 방식 모두**에서 path-trigger를 보존하고, 장기적으로
> `~/.claude/rules/` 복사를 단일화해 드리프트를 종식한다.

## Status
Proposed (권고안 C는 코드 작업 — §6 부록 태스크는 리더 승인 후 착수)

작성일: 2026-07-07
작성자: W4 (IMP-08 후속, B6 구조적 해법)

---

## 1. Context (컨텍스트와 제약사항)

**현재 상황**: Artibot은 8개 auto-activating rules(`plugins/artibot/rules/*.md`)를 제공한다. 7개는
`paths:` frontmatter로 **경로 스코프**(예: backend-patterns → `**/api/**`, frontend-patterns →
`**/*.tsx`), 1개(agent-coordination)는 글로벌이다. 이 규칙들은 Claude Code의 **네이티브 rules
로딩**(`~/.claude/rules/` + `paths:` 매칭)으로 활성화되며, 그 위치에 파일을 놓는 주체는 오직
`install.sh#install_rules()`(install.sh:295-306, 카운트 검증 :927)다.

**B6 문제**: 네이티브 마켓플레이스 설치(`/plugin install artibot@artibot`)는 플러그인을 캐시로 복사할
뿐 `install.sh`를 실행하지 않는다. plugin.json은 `rules[]` 배열을 선언하지만 **Claude Code 플러그인
매니페스트 스키마에 `rules` 필드가 없어** load-time에 무시된다(`claude plugin validate`가 unknown
field 경고로 재현). 따라서 네이티브 전용 사용자는 8개 규칙이 하나도 활성화되지 않는다.

**제약사항**:
- **flat(install.sh) 사용자 무회귀** — 기존 path-trigger 동작을 바이트 단위로 보존해야 한다.
- plugin.json에 우리가 임의 필드를 추가해도 Claude Code가 소비하지 않는다(스키마 통제 불가).
- 훅은 플러그인으로 배송되고 네이티브에서 `${CLAUDE_PLUGIN_ROOT}`가 세팅된다(hooks.json 전 엔트리가
  이미 이 변수 사용).
- DATA POLICY: 로컬 파일만, 외부 송신 없음.
- `instructions-loaded.js` 훅은 **정보성**(구조 검증·버전 출력)일 뿐 규칙을 주입하지 않는다 — 주입기
  아님.

**영향 범위**: `rules/`(8개 규칙), `install.sh`(복사 단계), `hooks/hooks.json`(잠재적 신규 훅),
네이티브 사용자 경험(앰비언트 규칙 소실).

---

## 2. Alternatives Considered (검토한 선택지)

먼저 **중복도 실측** — rule 내용이 네이티브로도 배송되는 아티팩트로 얼마나 커버되는가:

| Rule (경로 스코프) | 네이티브 배송 커버 아티팩트 | 커버 | 네이티브 소실분 |
|---|---|:---:|---|
| dev-protocol (`**/*`) | orchestrator agent + `principles` 스킬 + `/team` 워크플로 | HIGH | 모든 코드 편집 시 앰비언트 강제 |
| quality-gates (`**/*`) | `quality-framework`(ATLAS) 스킬 | HIGH | 편집 전후 체크리스트 앰비언트 |
| test-patterns (테스트 경로) | `testing-standards` 스킬(80%/피라미드/TDD 거의 동일) | HIGH | 테스트 파일 접근 시 주입 |
| clean-state (`**/*`) | `quality-framework` / `verification-completion` 스킬 | MED | TaskCompleted 시점 리마인더 |
| backend-patterns (`**/api/**`) | `persona-backend` 스킬(신뢰성/보안) — 단 규칙이 더 구체(REST 동사·응답형) | MED | `**/api/**` 편집 자동 주입 |
| frontend-patterns (`**/*.tsx`) | `persona-frontend` 스킬(a11y/성능예산) | MED | `**/*.tsx` 편집 자동 주입 |
| config-safety (config 경로) | `security-standards` 일부 — JSON/secret/CI 구체안은 대체로 고유 | LOW-MED | config 편집 자동 주입 |
| agent-coordination (글로벌) | `orchestration`/`delegation`/`multi-agent-patterns` 스킬 + orchestrator | HIGH | 글로벌 리마인더 |

**핵심**: rule *내용*은 ~70–80%가 의도-트리거 skill/agent로 이미 커버되고 그건 네이티브에서도 로드된다.
**고유하게 소실되는 것은 "경로-트리거 앰비언트 주입"** — 사용자가 도메인 키워드를 말하지 않고 파일만
편집해도 규칙이 뜨는 동작이다(스킬은 의도 매칭이라 맨-편집엔 안 뜬다). 즉 vibe-coding(무-의도 편집)
상황에서만 실질 손실이며, orchestrator/`/team` 경로는 DEV protocol을 재적용하므로 부분 자가치유된다.

**드리프트 실증(유지보수 비용 데이터)**: `agent-coordination.md`는 "26 agents / opus 73% · sonnet 27%"로
**이미 stale**하다 — 실측 28 agents / 21:7 = 75%:25%(validate-readme-claims.js·frontmatter 집계와
불일치). 이중 유지(rule↔skill)의 비용이 이미 관측된다.

### 선택지 A: 스킬 흡수
각 rule의 고유 내용을 대응 스킬로 병합하고 rules는 flat 전용 유지 또는 제거.
- **장점**: 내용 중복 제거 → 드리프트 축소. 스킬은 네이티브 배송이라 내용은 네이티브에 도달.
- **단점**: 스킬은 **의도-트리거**라 경로-트리거를 재현 못 함 → rules의 존재 이유(맨-편집 앰비언트)가
  사라짐 → **flat 사용자에게도 회귀**. 규칙이 스킬로 흡수되면 "`**/api/**` 열었을 뿐인데 보안 규칙이
  뜨던" 경험이 소멸.
- **적합한 경우**: 경로-트리거 가치가 낮다고 판단될 때. (본 건은 아님.)

### 선택지 B: 이중 유지 + 문서 고지 (현상 — 이미 배포됨)
rules는 install.sh용으로 유지, 네이티브 갭은 README/제출문서에 고지(이미 완료).
- **장점**: 신규 코드 0. flat 사용자 무회귀(현행 그대로). 즉시.
- **단점**: 네이티브 갭 잔존. rule↔skill 이중 유지 → 드리프트 지속(agent-coordination 이미 stale).
- **적합한 경우**: 네이티브 사용자 비중이 미미하고 손실 크기가 작다고 볼 때 — 인터림으로 타당.

### 선택지 C: 플러그인-배송 path-scoped rule-injector 훅 (구조적 해법)
`PreToolUse`(Write|Edit) 또는 `InstructionsLoaded` 훅이 `${CLAUDE_PLUGIN_ROOT}/rules/*.md`를 읽어
편집 대상 경로를 각 규칙의 `paths:` frontmatter와 매칭, 매칭된 규칙을 컨텍스트로 주입.
- **장점**: 훅은 plugin.json으로 배송되고 네이티브에서 `CLAUDE_PLUGIN_ROOT` 가용 → **양 설치 방식
  모두**에서 path-trigger 보존. 장기적으로 `~/.claude/rules/` 복사를 단일 배송으로 대체 가능 →
  드리프트 종식. 규칙 파일은 그대로(재작성 불요).
- **단점**: 신규 훅 + 경로 매처 + 테스트(실 코드). **주입 충실도 리스크**: 훅 stdout이 모델
  컨텍스트에 실제로 주입되는지는 Claude Code 훅 계약(`hookSpecificOutput.additionalContext` 등)에
  의존 — **스파이크로 실증 필요**(over-claim 금지; `instructions-loaded`는 informational-only였음).
- **적합한 경우**: 경로-트리거 가치를 보존하면서 네이티브 갭을 실제로 닫아야 할 때 = **본 건**.
- **하위안 C2**: plugin 매니페스트에 `rules` 필드 upstream 제안 — 현실성 낮음(앤트로픽 통제, 느림),
  보조 트랙으로만.

### 비교 표

| 기준 | A 스킬흡수 | B 이중유지+고지 | C 훅-주입기 | 비중 |
|------|:---:|:---:|:---:|:---:|
| 네이티브 갭 실제 해소 | ★★★(내용만) | ★ | ★★★★★ | 30% |
| flat 사용자 무회귀 | ★★(경로트리거 상실) | ★★★★★ | ★★★★★ | 25% |
| path-trigger 가치 보존 | ★ | ★★★★★ | ★★★★★ | 20% |
| 유지보수/드리프트 감소 | ★★★★ | ★★ | ★★★★ | 15% |
| 구현 비용 (낮을수록 ★) | ★★★ | ★★★★★ | ★★ | 10% |
| **가중 합계** | **2.55** | **3.30** | **4.55** | 100% |

---

## 3. 확장성 관점 평가

**현재 규모 (1×)**: B로 flat은 동작, 네이티브만 갭. C는 양쪽 동작.

**3× (규칙 수·경로 패턴 증가)**: A는 스킬 수 팽창 + 경로-트리거 부재로 앰비언트 커버리지 하락. B는
이중 유지 항목이 규칙 수에 비례해 드리프트 표면 증가. C는 규칙 파일만 추가하면 훅이 자동 커버 →
**규칙 추가의 한계비용 최저**.

**10× 시나리오**:

| 시나리오 | A 스킬흡수 | B 이중유지 | C 훅-주입기 |
|---------|-----------|-----------|------------|
| 규칙 수십 개로 확장 | 스킬 카탈로그 오염 + 의도매칭 정확도 하락 | 이중 동기화 비용 선형 증가·드리프트 상시 | 규칙 파일만 추가, 훅 무변경 |
| 네이티브 사용자 비중 급증 | 내용은 오나 앰비언트 소실 체감 | 갭이 다수 사용자에 노출 | 갭 없음 |
| 규칙 경로 패턴 세분화 | 스킬은 경로 무관 → 대응 불가 | 네이티브에 무전달 | frontmatter만 수정 |

→ B는 **인터림 상한**, C가 **확장의 필요조건**. A는 경로-트리거 상실로 규모와 무관하게 열위.

---

## 4. 숨겨진 비용

| 비용 항목 | A 스킬흡수 | B 이중유지 | C 훅-주입기 | 설명 |
|----------|-----------|-----------|------------|------|
| 학습 곡선 | 낮음 | 없음 | 중(훅 계약·경로 매처) | C는 additionalContext 계약 검증 필요 |
| 드리프트 위험 | 낮음 | **높음(실측 stale)** | 낮음(단일 배송으로 수렴) | B는 이미 agent-coordination stale |
| 회귀 리스크(flat) | **중(경로트리거 상실)** | 0 | 낮음(복사 유지 시 belt&suspenders) | A가 flat UX 훼손 |
| 토큰 오버헤드 | ~0 | 0 | 소(편집당 규칙 1개 주입) | 경로 매칭 1건만 주입하면 무시 가능 |
| 검증 부담 | 스킬 회귀 테스트 | 없음 | 훅+매처 테스트+주입 스파이크 | C의 실증이 관문 |

---

## 5. Decision (추천안)

> ## ✓ **추천: C(플러그인-배송 path-scoped rule-injector 훅)를 구조적 해법으로, B를 인터림으로 병행**

**선택 근거**:
1. **네이티브 갭을 실제로 닫는 유일안**: A는 내용만 전달하고 path-trigger를 못 살리며, B는 갭을
   유지한다. C만이 양 설치 방식에서 경로-트리거 앰비언트 주입을 보존한다.
2. **flat 무회귀 + 드리프트 종식 경로**: 규칙 파일을 그대로 두고 훅으로 읽으므로 flat은 무회귀
   (복사 단계는 belt&suspenders로 당분간 유지). 장기적으로 `~/.claude/rules/` 복사를 단일 배송
   (`CLAUDE_PLUGIN_ROOT/rules`)으로 대체하면 rule↔install 이중화가 사라진다.
3. **B는 이미 완료된 정직한 인터림**: README·제출문서에 갭이 고지돼 있어(IMP-08) C 착수 전까지 사용자
   오해는 방지된다.

**선택하지 않은 이유**:
- **A 스킬흡수**: rules의 존재 이유인 경로-트리거를 제거해 **flat 사용자 무회귀 제약을 위반**. 기각.
- **B 단독 확정**: 네이티브 갭이 영구 잔존하고 드리프트가 지속(agent-coordination stale 실증). 구조적
  해법이 아니라 상태 유지.

**가정과 전제 조건**:
- **[검증 필요]** Claude Code 훅이 편집 시점에 규칙 텍스트를 모델 컨텍스트로 주입할 수 있다
  (`hookSpecificOutput.additionalContext` 또는 동등 계약). **C 착수 전 스파이크로 실증** — 불가로
  판명되면 B를 확정하고 C2(upstream `rules` 필드 제안)로 전환.
- 네이티브에서 규칙 파일이 `${CLAUDE_PLUGIN_ROOT}/rules/`에 실재(플러그인 소스에 포함되므로 캐시에
  복사됨 — 확인 완료).
- 바뀌면 재검토: 스파이크가 주입 불가로 나오거나, Claude Code가 plugin 매니페스트에 `rules`를
  공식 지원하면(C2 실현) 그쪽으로 흡수.

---

## 6. Consequences (결과)

**좋아지는 점**:
- 네이티브 사용자도 경로-트리거 앰비언트 규칙을 받음 → B6 실질 해소.
- 배송 경로 단일화(훅 1개 + 규칙 파일)로 rule↔install 이중 유지·드리프트 축소.
- 규칙 추가의 한계비용 최소화(frontmatter만 작성).

**나빠지는 점 / 새 부담**:
- 신규 훅 + 경로 매처 유지 부담 → 순수 함수 + 주입 계약 테스트로 상쇄.
- 편집당 규칙 주입의 토큰 비용(소) → 매칭 1건만 주입하도록 제한.
- **주입 충실도 미검증** → 스파이크 통과가 착수 관문(실패 시 B 확정).

**되돌리기 비용 (Reversibility)**: ☑ 쉬움 — 훅 엔트리 1개 제거로 현행 B 상태 복귀. 규칙 파일은 불변.

---

## 7. 2년 뒤 기술 부채 예상 포인트

| 부채 항목 | 발생 확률 | 영향도 | 완화 전략 |
|----------|---------|-------|---------|
| 규칙 내용이 대응 스킬과 계속 갈라짐(agent-coordination처럼 stale) | 중(B 유지 시 높음) | 중 | C의 단일 배송 + CI 카운트 검증(validate-readme-claims 확장) |
| 훅 주입 계약이 Claude Code 버전업에 깨짐 | 낮음 | 중 | 계약 스파이크 테스트를 CI 트립와이어로 상주 |
| `~/.claude/rules/` 복사와 훅-주입 이중 활성으로 규칙 중복 주입 | 중 | 낮음 | 마이그레이션 완료 후 install.sh 복사 제거(단일화) |
| upstream `rules` 필드 등장 시 훅이 잉여화 | 낮음 | 낮음 | 등장 시 훅 제거 → 매니페스트 필드로 흡수(C2) |

**재검토 시점**: 주입 스파이크 결과 확정 직후, 또는 Claude Code가 plugin `rules` 필드를 공식화할 때.

---

## 부록 A. C 구현 태스크 목록 (리더 승인 후 착수 — 이 ADR 범위는 결정까지)

> ⚠️ 코드 작업. 승인 전 미착수. 스파이크(A0)가 관문 — 실패 시 B 확정하고 아래 폐기.

- [ ] **A0 (관문) 주입 스파이크**: PreToolUse(Write|Edit) 훅이 `hookSpecificOutput.additionalContext`
      (또는 동등)로 규칙 텍스트를 모델 컨텍스트에 주입 가능한지 실증. 불가 → C 폐기, B 확정.
- [ ] **A1 경로 매처**: `rules/*.md`의 `paths:` frontmatter 파싱 + 편집 경로 glob 매칭(순수 함수,
      `lib/core` 또는 `scripts/hooks/` 하위). 다중 매칭 시 우선순위·중복 억제 정의.
- [ ] **A2 주입 훅**: `${CLAUDE_PLUGIN_ROOT}/rules/`에서 규칙 로드 → 매칭 규칙 주입. never-throw,
      매칭 0건이면 무주입. 글로벌 규칙(agent-coordination)은 세션 1회 주입.
- [ ] **A3 테스트**: 매처(경로별 매칭/비매칭/다중), 훅(주입/무주입/에러 graceful), 글로벌 1회 주입.
- [ ] **A4 이중 활성 방지**: `~/.claude/rules/artibot/`가 존재하는 flat 환경에서 네이티브 rules 로딩과
      훅 주입이 겹치면 중복 → 훅이 flat 감지 시 주입 스킵(또는 install.sh 복사 제거로 단일화).
- [ ] **A5 드리프트 게이트**: agent-coordination 등 카운트 포함 규칙을 `validate-readme-claims.js`류
      CI 검증에 편입(28 agents/모델비율 자동 검증).
- [ ] **A6 문서**: README 캐비엇의 "rules 미전달" 문구를 "네이티브도 규칙 지원(vX.Y+)"으로 갱신.

---

## References

- 문제 출처: IMP-08 감사(B6) — `docs/MARKETPLACE-SUBMISSION.md` §Known limitations
- 규칙 소스: `rules/*.md` (7 path-scoped + 1 global), plugin.json `rules[]`(무시됨)
- 배송 주체: `install.sh#install_rules()` (install.sh:295-306, 검증 :927)
- 훅 계약 참고(informational-only 사례): `scripts/hooks/instructions-loaded.js`
- 경로 리졸버: `lib/core/platform.js#getPluginRoot` (`CLAUDE_PLUGIN_ROOT` 인지)
- 중복 대상 스킬: `quality-framework`, `testing-standards`, `persona-backend`, `persona-frontend`,
  `orchestration`/`delegation`, `principles`
- 드리프트 실증: agent-coordination.md "26 agents/73%·27%" vs 실측 28/75%·25%
- 템플릿: `docs/adr/ADR-001-effort-workflow-fusion.md`
