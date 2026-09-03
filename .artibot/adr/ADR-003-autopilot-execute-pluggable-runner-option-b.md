---
status: active
created: 2026-07-15
number: 3
---

# ADR-003: autopilot EXECUTE pluggable runner (Option-B)

## 추천 결론 (TL;DR)
> **B 채택 — 단계 도입. Stage 1은 기본 동작 무변경(플래그), Stage 2는 config 옵트인 뒤에만 자동 선택. kill-switch = autopilot.runner.autoSelect=false 한 줄.을(를) 채택한다.** 교체 지점이 이미 존재(engine.js:216 instruction.type)하고 선택 신호도 이미 계산됨(workflow-plan.js deriveRecommendation — 현재 미소비). 신규 분류 로직 발명 없이 단일 진실원(buildWorkflowPlan)을 소비만 하므로 드리프트 위험 최소. 하네스 제약(workflow/autopilot auto-fire 금지)은 /autopilot 세션 시작이 이미 명시 옵트인이므로 세션 내부 러너 선택은 위반 아님(ORCHESTRATION-ROUTING.md 2축 표의 CONSUMES orchestrate internally 명문화 경로). C는 동형 반복 자동 최적화 가치를 영구 포기, A는 ROUTING 문서와 실물의 정합성 갭 방치.

## Status
Accepted — **Stage 1 구현됨 (v4.39.0)** · **Stage 2 구현됨 (v4.39.0 직후, config `autopilot.runner.autoSelect` 기본 OFF)**

작성일: 2026-07-15

---

## 1. Context (컨텍스트와 제약사항)

- 현행: autopilot Phase 2 EXECUTE는 **항상** `type: 'team-create'` instruction을 반환한다 (`lib/autopilot/engine.js:216-217`). 엔진은 실행하지 않고 instruction만 반환하며, 메인 Claude가 이를 해석해 TeamCreate를 호출한다.
- `docs/ORCHESTRATION-ROUTING.md` 2축 표는 "autopilot (CONSUMES orchestrate internally)"라고 결정론 소비를 명시하지만 실물은 미구현 — `commands/autopilot.md:238`이 스스로 "Option-B pluggable 러너는 미구현·향후"라고 자인. 문서-실물 정합성 갭.
- 선택 신호는 **이미 계산되고 있다**: `lib/cognitive/workflow-plan.js:158-169 deriveRecommendation`이 동형 반복(서브목표 ≥3 && 최대 동일-command 그룹 ≥3)에서 `recommendation: 'workflow'`를 산출하지만 **소비자가 없다**.
- 제약: (a) 하네스 제약 — workflow/autopilot은 auto-fire 금지(분류기는 추천만). (b) resume 하위호환 — 구버전 세션 state에는 runner 필드가 없다. (c) 예산 이중 계상 금지 — autopilot `--budget`과 Workflow 도구 budget이 따로 잡히면 안 됨. (d) Workflow 도구 부재 환경(구버전 CLI, 타 플랫폼 어댑터)에서의 폴백 필요.

---

## 2. Alternatives Considered (검토한 선택지)
### 선택지: A. 현상 유지 — EXECUTE는 항상 team-create instruction (현행)
- **장점**: 무변경·무위험. 테스트/문서 부담 0.
- **단점**: 동형 반복 작업(N-파일 마이그레이션류)에서 모델 주도 분해의 비용 변동성을 그대로 짊어짐. ROUTING 문서("CONSUMES orchestrate internally")와 실물의 정합성 갭 방치. `deriveRecommendation` 신호 영구 사문화.

### 선택지: B. pluggable 러너 — Stage 1: --runner 수동 플래그(기본 team, 현행 불변) / Stage 2: config autopilot.runner.autoSelect 옵트인 시 buildWorkflowPlan.recommendation===workflow(동형 반복)에서 dynamic-run 자동 선택
- **장점**: 기존 신호(`buildWorkflowPlan.recommendation`)를 소비만 하므로 분류 로직 이원화·드리프트 없음(단일 진실원 유지). 단계 도입 + kill-switch로 위험 통제(fable 마이그레이션과 동일 패턴). 동형 반복 EXECUTE의 비용 예측성 확보(Workflow `--budget` 하드 캡).
- **단점**: instruction 소비자(`commands/autopilot.md` Step 3)에 분기 추가 — 프롬프트 계층 복잡도 증가. 폴백 경로(dynamic 실패 → team 재시도) 테스트 부담.

### 선택지: C. 수동 플래그만 — --runner dynamic 추가하되 자동 선택은 영구 배제
- **장점**: 자동화 리스크 0. 구현 최소.
- **단점**: 신호가 이미 계산되는데 수동으로만 쓰는 반쪽 구현. 무인 세션(autopilot)의 본질상 사용자가 시작 시점에 작업 모양을 예측해 플래그를 줘야 하는 모순 — 동형 반복 여부는 Phase 1 PLAN 후에야 확정된다.

---

## 3. 확장성 관점 평가

- `instruction.type`이 사실상 러너 enum(`'team-create' | 'dynamic-run'`)이 되므로, 후속 러너(예: orchestrate 패턴 러너)를 같은 seam에 추가할 수 있다.
- 선택 로직은 순수 함수 `selectExecuteRunner(state, plan, config)` 한 곳에만 둔다 — 우선순위: ① `options.runner` 사용자 오버라이드 → ② config `autopilot.runner.autoSelect !== true`면 `'team-create'`(기본) → ③ `plan.recommendation === 'workflow'`면 `'dynamic-run'` → ④ 그 외 `'team-create'`.
- 옵트인 의미론: `/autopilot` 시작 자체가 명시 옵트인이므로 세션 **내부**의 러너 선택은 하네스 auto-fire 제약 위반이 아니다("opt-in inheritance"). 단 이 원칙을 ROUTING.md에 명문화하는 것을 구현 범위에 포함한다.

---

## 4. 숨겨진 비용

- `events.ndjson` 스키마에 `runner` 필드 추가 → `:status`/`:replay` 렌더 수정 연쇄.
- Workflow run은 30분 checkpoint 주기와 맞지 않음(스크립트 실행 중 개입 불가) → dynamic-run은 **run 경계 checkpoint**(시작 전/완료 후 WIP commit)로 전환 필요.
- worktree 이중 격리: 세션 worktree(`attemptCreateWorktree`, engine.js:210)와 Workflow 스크립트의 `isolation:'worktree'`가 겹침 — dynamic-run 시 스크립트 isolation은 mutate-parallel 스테이지에만 제한하고 세션 worktree를 `cwdHint`로 상속.
- 예산 단일화: autopilot 잔여 예산(`checkBudgetThreshold` 기준)을 Workflow 호출의 budget으로 **전달**해 이중 계상 방지 — cost-tracker에 dynamic-run 소비를 합산하는 어댑터 필요.
- 테스트 매트릭스: 러너(2) × resume(신/구 state) × config 게이트(on/off) × 폴백(성공/실패).

---

## 5. Decision (추천안)
> ## ✓ **추천: B 채택 — 단계 도입. Stage 1은 기본 동작 무변경(플래그), Stage 2는 config 옵트인 뒤에만 자동 선택. kill-switch = autopilot.runner.autoSelect=false 한 줄.**

**선택 근거**: 교체 지점이 이미 존재(engine.js:216 instruction.type)하고 선택 신호도 이미 계산됨(workflow-plan.js deriveRecommendation — 현재 미소비). 신규 분류 로직 발명 없이 단일 진실원(buildWorkflowPlan)을 소비만 하므로 드리프트 위험 최소. 하네스 제약(workflow/autopilot auto-fire 금지)은 /autopilot 세션 시작이 이미 명시 옵트인이므로 세션 내부 러너 선택은 위반 아님(ORCHESTRATION-ROUTING.md 2축 표의 CONSUMES orchestrate internally 명문화 경로). C는 동형 반복 자동 최적화 가치를 영구 포기, A는 ROUTING 문서와 실물의 정합성 갭 방치.

---

## 6. Consequences (의사결정의 결과)

- **Stage 1 릴리스 시 동작 무변경** — `--runner` 미지정이면 현행과 바이트 단위 동일한 instruction.
- Stage 2 옵트인 시: 동형 반복으로 판정된 EXECUTE만 `dynamic-run` instruction으로 전환. 메인 Claude는 TeamCreate 대신 Workflow 도구를 호출(작업 단위는 Phase 1 PLAN 산출물에서 워크리스트로 매핑).
- 실패 폴백: dynamic-run 실패/빈 결과 → 같은 Phase를 team-create로 1회 재시도(fable 빈-결과 휴리스틱과 동일 패턴) + `runner-fallback` 이벤트 기록. 재시도도 실패 → 기존 PAUSED 경로.
- resume 하위호환: 러너는 별도 `state.runner` 필드가 아니라 **`state.options.runner`에서 파생**한다(`resolveExecuteRunner` — 세션 시작 시 makeInitialState가 1회 persist, 동기화 해저드 없음). 구버전 세션(필드 부재) → `'team-create'` 고정. resume에서 재평가하지 않는다(중간 러너 변경 금지).
- **Companion 변경 명기 (Stage 1 구현 시점)**: `/dynamic` 커맨드 신설과 "workflow" 네이밍 규약 개편은 이 ADR의 스코프가 아니라 **같은 세션에서 사용자가 별도 요청한 동반 작업**이다. dynamic-run instruction이 `/dynamic`과 동일한 하네스 `Workflow` 도구를 소비하므로 릴리스는 묶되, 커밋은 관심사별 분리를 권장.
- ROUTING.md 2축 표의 "autopilot (CONSUMES orchestrate internally)"가 실물과 일치하게 됨(현재는 미래형 서술).
- kill-switch: `artibot.config.json#/autopilot/runner/autoSelect=false` 한 줄로 즉시 Stage 1 동작 복귀 (코드 수정 불필요).

---

## 7. 2년 뒤 기술 부채 예상 포인트

- instruction 소비자 분기가 코드가 아니라 **프롬프트 문서**(`commands/autopilot.md` Step 3)에 존재 — 소비자 드리프트가 조용히 발생할 수 있는 지점. 릴리스 게이트에 instruction-type ↔ 커맨드 문서 정합 체크 추가 권장.
- **Stage 2 주입 경로도 동일 계열**: `options.recommendedRunner`를 세팅하는 JS 코드는 없고 프롬프트 계층(Step 1 파싱, `[artibot:hint recommend=workflow]` 감지)에만 의존 — 자동선택이 실발화하려면 프롬프트가 규칙대로 주입해야 함. dynamic-run 실배포 시 주입 경로 통합 테스트 권장 (Stage 2 리뷰 LOW-2, 2026-07-15).
- `deriveRecommendation`의 임계값(서브목표 ≥3, 동일 그룹 ≥3)이 하드코딩 — config화하지 않으면 매직넘버로 잔존.
- Workflow 도구는 플랫폼 API — 시그니처/기능 변화 시 dynamic-run 경로만 깨질 수 있어 플랫폼 버전 추적 필요(폴백이 있으므로 치명적이지는 않음).
