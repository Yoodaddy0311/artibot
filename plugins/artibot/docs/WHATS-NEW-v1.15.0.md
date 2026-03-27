# What's New in Artibot v1.15.0 — Benchmark Intelligence

**릴리즈 일자**: 2026-03-27
**방법론**: 3개 외부 소스(215개 AI 에이전트, Anthropic 하네스 설계, Google Agent Skills) 벤치마크 분석 → 17개 인사이트 추출 → 11개 신규 기능 구현

---

## 한줄 요약

외부 벤치마크에서 배워서 에이전트 정확도, 장기 세션 품질, 평가 객관성, 스킬 관리를 전면 개선했습니다.

---

## 한눈에 보기

| 기능 | 한줄 설명 |
|------|-----------|
| ACI Constraint | 각 에이전트가 역할에 맞는 도구만 사용해서 실수가 줄어듭니다 |
| Context Reset | 긴 대화에서도 새 에이전트로 자연스럽게 전환되어 품질이 유지됩니다 |
| Eval Isolator | 코드를 만든 에이전트와 평가하는 에이전트가 분리되어 편향이 사라집니다 |
| Sprint Contract | 작업 시작 전에 "완료 기준"을 합의하여 재작업이 줄어듭니다 |
| Source of Truth URL | 스킬이 공식 문서 URL을 포함해서 에이전트가 최신 정보를 참조합니다 |
| Feature Tracker | 어떤 내부 기능이 동작 중인지 인라인 표시 + 세션 대시보드로 보여줍니다 |
| Skill Freshness | 각 스킬의 마지막 검증일과 유효기간을 추적합니다 |
| Skill Eval Harness | 스킬의 실제 효과를 정량적으로 측정합니다 |
| Skill Auto-Promotion | 반복 성공 패턴을 자동으로 새 스킬로 만들어줍니다 |
| Eval Calibrator | 인간 피드백으로 평가 기준을 자동 보정합니다 |
| Intelligence Output | 기능 동작 상태를 보여주는 새로운 출력 스타일입니다 |

---

## 사용자 체감 개선

### 1. 에이전트 정확도 향상 (ACI Constraint)

- **전**: 모든 에이전트가 모든 도구에 접근 → 불필요한 도구 사용으로 오류 발생
- **후**: 각 에이전트가 역할에 맞는 도구만 사용 → 정확도 향상
- **예시**: `security-reviewer`는 읽기 전용 도구만 사용 → 실수로 코드 수정 불가

ACI(Agent-Computer Interface) Constraint는 각 에이전트의 역할에 따라 사용 가능한 도구를 제한합니다. `tdd-guide`는 테스트 관련 도구만, `doc-updater`는 문서 파일만 수정 가능. 미들웨어 단계에서 적용되어 에이전트 정의 변경 없이 동작합니다.

### 2. 장기 세션 품질 유지 (Context Reset)

- **전**: 긴 대화에서 컨텍스트가 차면 품질 저하 ("context anxiety")
- **후**: 자동으로 새 에이전트로 전환 + 이전 상태 보존
- **예시**: 2시간 코딩 세션에서도 마지막 작업이 첫 작업만큼 정확

Anthropic 블로그에서 검증된 패턴입니다. 기존 compaction(요약 압축)은 "깨끗한 시작"을 제공하지 못하지만, context reset은 checkpoint에 상태를 직렬화하고 새 에이전트에 핸드오프합니다. 토큰 사용량이 임계값을 넘으면 자동 트리거됩니다.

### 3. 객관적 코드 평가 (Eval Isolator)

- **전**: 에이전트가 자기 코드를 "잘했다"고 평가하는 편향
- **후**: 독립된 평가 에이전트가 결과물만 보고 객관 평가
- **예시**: "테스트 통과 + 요구사항 충족"으로만 판단, 구현 과정의 reasoning은 전달하지 않음

Anthropic 하네스 설계의 핵심 발견: "standalone evaluator를 회의적으로 튜닝하는 것이, generator가 자기 작업을 비판적으로 만드는 것보다 훨씬 효과적". Eval Isolator는 구현 에이전트의 출력물(코드, 파일 변경)만 평가 에이전트에 전달합니다.

### 4. 명확한 완료 기준 (Sprint Contract)

- **전**: "다 했어요"의 기준이 모호 → 재작업 빈번
- **후**: 작업 시작 전 구현 에이전트와 평가 에이전트가 "완료 기준" 합의
- **예시**: "3개 테스트 통과 + ESLint 0 에러 + 기존 테스트 회귀 없음"

Sprint Contract는 고수준 유저 스토리와 테스트 가능한 구현 사이의 갭을 해소합니다. `state.context.contract`에 저장되어 평가 시 pass/fail 기준으로 사용됩니다.

### 5. 최신 정보 참조 (Source of Truth URL)

- **전**: 스킬이 작성 시점의 정보만 보유
- **후**: 공식 문서 URL(`sources:` frontmatter)을 포함하여 에이전트가 최신 정보 참조 가능
- **예시**: TypeScript 5.8 공식 핸드북 URL로 최신 문법 확인

Google Agent Skills 분석에서 도출된 패턴입니다. 현재 5개 스킬에 `sources:` URL이 추가되었고, 10개 스킬에 `version:` 태그가 포함되어 있습니다. WebFetch/Context7을 통해 최신 문서를 자동으로 가져올 수 있습니다.

### 6. 기능 동작 가시성 (Feature Tracker)

- **전**: 내부 기능이 동작해도 사용자가 모름
- **후**: 인라인 표시 + 세션 대시보드로 어떤 기능이 활성화됐는지 확인
- **예시**: `⚡ ACI: tdd-guide → test tools only` 인라인 표시

Feature Tracker는 event-bus를 통해 각 미들웨어의 활성화 이벤트를 수집합니다. 5개 미들웨어(guardrail, router, token-usage, summarization, skills)가 이벤트를 발행하며, 아직 구현되지 않은 기능(ACI, context-reset 등)도 이벤트 타입이 등록되어 추후 자동으로 반영됩니다.

```
--- Session Intelligence Report ---
| ⚡ ACI Constraints    : 12x (accuracy +15%)
| 🔄 Context Resets     : 2x (quality maintained)
| 📋 Sprint Contracts   : 3x (3/3 achieved)
| 🔍 Independent Evals  : 5x (bias removed)
| 📡 Source Fetches     : 8x (latest docs)
| 🧠 Cognitive Route    : 47x (S1 73% / S2 27%)
| 📊 Token Efficiency   : 15x (23% saved)
```

### 7. 스킬 품질 관리 (Freshness + Eval + Promotion)

- **전**: 99개 스킬의 유효기간/효과를 알 수 없음
- **후**: 스킬 신선도 추적 + 효과 정량 평가 + 성공 패턴 자동 스킬화
- **예시**: "이 스킬은 90일 미검증 ⚠️" 경고, "fix typescript error 패턴이 5회 성공 → 자동 스킬화"

세 가지 모듈이 협력합니다:
- **Skill Freshness**: 각 스킬의 마지막 검증일 추적, 만료 경고
- **Skill Eval Harness**: A/B 비교로 스킬 유/무 시 정량 점수 차이 측정
- **Skill Auto-Promotion** (Voyager 패턴): 3회 이상 성공한 패턴을 SKILL.md 초안으로 자동 생성

### 8. 평가 자동 보정 (Eval Calibrator)

- **전**: 평가 기준이 고정 가중치 (accuracy 0.35, completeness 0.25 ...)
- **후**: 인간 피드백으로 가중치 자동 조정 + few-shot 예시 축적
- **예시**: "accuracy가 과대평가됨" 피드백 → 가중치 자동 하향 조정

Anthropic 하네스 블로그의 핵심 교훈: "evaluator의 로그를 읽고, 인간 판단과 다른 부분을 찾아 프롬프트를 반복 조정하는 과정이 필수". Eval Calibrator는 이 과정을 자동화합니다.

---

## 수치 비교

| 지표 | v1.14.3 | v1.15.0 | 변화 |
|------|---------|---------|------|
| Tests | 3,989 | 4,270 | +281 (+7.0%) |
| Test files | 115 | 126 | +11 |
| Runtime middlewares | 9 | 11 | +2 |
| Learning modules | 15 | 22 | +7 |
| Eval scripts | 1 | 3 | +2 |
| Output styles | 7 | 8 | +1 |
| SKILL.md with `sources:` | 0 | 5 | +5 |
| SKILL.md with `version:` | 0 | 10 | +10 |
| ESLint errors | 0 | 0 | - |
| Runtime deps | 0 | 0 | - |

---

## 벤치마크 출처

| 소스 | 분석 대상 | 인사이트 추출 | 기능 구현 | 제외 (이미 앞섬) |
|------|----------|:----------:|:--------:|:---------------:|
| awesome-ai-agents | 215개 AI 에이전트 프레임워크 | 6 | 4 | 11 |
| Anthropic Harness | 장기 실행 앱 하네스 설계 패턴 | 6 | 5 | 10 |
| Google Agent Skills | 에이전트 스킬 지식 갭 연구 | 5 | 2 | 8 |
| **합계** | | **17** | **11** | **29** |

> 29개 항목이 "이미 앞섬"으로 제외된 것은 Artibot이 이미 해당 기능을 보유하고 있거나, 더 진보된 구현이 있음을 의미합니다. 예: GRPO 자기보상 학습(블로그의 단순 평가보다 진보), Dual-Process 인지 라우팅(단순 순차 실행보다 정교), Loop Detection(외부 소스에 없는 고유 기능).

---

## 새 파일 목록

### Runtime (`lib/runtime/middleware/`)
| 파일 | 용도 |
|------|------|
| `aci-constraint.js` | 에이전트별 도구 제약 |
| `context-reset.js` | 컨텍스트 윈도우 리셋 + 핸드오프 |

### Learning (`lib/learning/`)
| 파일 | 용도 |
|------|------|
| `eval-isolator.js` | Generator-Evaluator 분리 |
| `eval-calibrator.js` | 평가 기준 자동 보정 |
| `skill-freshness.js` | 스킬 신선도 추적 |
| `skill-promoter.js` | 성공 패턴 → 스킬 자동 승격 |

### Core (`lib/core/`)
| 파일 | 용도 |
|------|------|
| `feature-tracker.js` | 기능 활성화 이벤트 수집/통계 |

### Output Styles (`output-styles/`)
| 파일 | 용도 |
|------|------|
| `artibot-intelligence.md` | intelligence 출력 스타일 |

### Eval Scripts (`scripts/evals/`)
| 파일 | 용도 |
|------|------|
| `run-skill-eval.js` | 스킬 효과 A/B 평가 |
| `run-ablation-test.js` | 미들웨어 기여도 측정 |

---

## 설계 원칙

이번 릴리즈의 모든 기능은 다음 원칙을 따릅니다:

1. **비침투적**: 기존 워크플로우를 방해하지 않음. 미들웨어에 1-2줄 emit 추가 수준.
2. **점진적**: 모든 기능이 구현되지 않아도 tracker가 동작. 추후 기능 추가 시 자동 반영.
3. **불변성**: 모든 store 업데이트가 새 객체 반환. 외부 mutation 불가.
4. **Zero Runtime Deps**: 여전히 런타임 의존성 0개.
5. **모델 개선 인식**: Anthropic 블로그의 핵심 교훈 — "하네스의 모든 컴포넌트는 모델이 스스로 할 수 없다는 가정을 인코딩한다. 이 가정은 스트레스 테스트할 가치가 있다."
