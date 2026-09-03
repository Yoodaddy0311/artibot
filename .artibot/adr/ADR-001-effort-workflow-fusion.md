---
status: active
created: 2026-05-29
number: 1
---

# ADR-001: Effort 결정 방식 — 정적 매핑 vs Score-Aware vs GRPO-학습

## 추천 결론 (TL;DR)
> **Score-Aware Resolution(P1)을 토대로 채택하고, 그 위에 Unified Team Trigger(P2)와
> 선택적 GRPO 튜닝(P3)을 레이어링한다.** 정적 매핑만으로는 G1~G4 갭을 못 메우고, GRPO-학습을
> 단독 도입하면 수 주간의 데이터 축적 전까지 가치가 0이며 품질 저하 리스크가 크다. Score-Aware는
> 신호 없으면 정적과 byte-identical이라 zero-risk이면서 즉시 효율을 낸다.

## Status
Accepted

작성일: 2026-05-29
작성자: Artibot core (planner ×4 deep-dive 합의)

---

## 1. Context (컨텍스트와 제약사항)

**현재 상황**: v4.17.0에서 native effort 레벨을 도입했으나 effort는 명령어 이름만 보는 정적
freeze 객체(`EFFORT_POLICY`, 56키)로 결정된다. 같은 자리의 `classifyComplexity()`가 만드는
풍부한 `score`를 무시하고, GRPO 학습 인프라(보상 캡처·야간 트레이너 가동 중)와도 단절돼 있다.

**제약사항**:
- 5-layer 단방향 import (5→1), 함수<50줄/파일<800줄, immutable/frozen 패턴
- DATA POLICY: 외부 데이터 송신 금지 — 모든 학습은 로컬 GRPO
- 기존 56개 명령 매핑 및 native API 스펙은 불변
- `router.js`가 이미 816줄 (추가 여력 없음)

**영향 범위**: `lib/cognitive/` (effort 결정), `lib/runtime/` (budget·task meta), `/team` 오케스트레이션,
`lib/learning/grpo/` (피드백 루프)

---

## 2. Alternatives Considered (검토한 선택지)

### 선택지 A: 정적 매핑 유지 (현행 v4.17.0)
- **장점**: 단순·결정적·디버깅 쉬움. 토큰 0 오버헤드. 이미 동작.
- **단점**: G1~G4 갭 그대로. 사소/대형 작업 구분 불가. 컨텍스트 압박 무시. 학습 불가.
- **적합한 경우**: 작업 복잡도 편차가 작고 토큰 예산이 빠듯한 소규모 환경.

### 선택지 B: Score-Aware Resolution (P1, 휴리스틱)
- **장점**: 복잡도/컨텍스트에 적응. 신호 없으면 정적과 byte-identical(안전). 순수 함수·테스트 용이.
  P2/P3의 재사용 토대. 학습 데이터 불필요 — 즉시 효과.
- **단점**: 시프트 임계값(0.7/0.25/0.15)이 휴리스틱(경험칙). 과거 성과를 반영 못 함.
- **적합한 경우**: 복잡도 편차가 크고 즉시 효율 개선이 필요하며 학습 데이터가 아직 없을 때 = **현재**.

### 선택지 C: GRPO-학습 정책 (P3, 적응형)
- **장점**: 실제 성과(보상·토큰효율)로 자가 튜닝. 미래 천장 최대. 기존 GRPO 인프라 재사용.
- **단점**: 수 주간 보상 데이터 축적 전 가치 0. 품질 저하 리스크(가드레일 필수). 단독 도입 시
  베이스라인 휴리스틱이 없어 cold-start가 거칠다.
- **적합한 경우**: 충분한 episode가 쌓였고 휴리스틱 베이스라인(B) 위에 bias로 얹을 때.

### 비교 표

| 기준 | A 정적 | B Score-Aware | C GRPO | 비중 |
|------|:---:|:---:|:---:|:---:|
| 즉시 효과 (데이터 불요) | ★★★★★ | ★★★★★ | ★ | 25% |
| 적응성 (작업별 차등) | ★ | ★★★★ | ★★★★★ | 25% |
| 리스크 안전성 | ★★★★★ | ★★★★★ | ★★★ | 20% |
| 미래 확장 천장 | ★ | ★★★ | ★★★★★ | 15% |
| 구현 비용 (낮을수록 ★) | ★★★★★ | ★★★★ | ★★ | 15% |
| **가중 합계** | **3.30** | **4.30** | **3.10** | 100% |

---

## 3. 확장성 관점 평가

**현재 규모 (1×)**: A/B/C 모두 동작. B가 정적 대비 토큰 right-sizing으로 즉시 이득.

**3× (명령 다양성·동시 팀 증가)**: A는 flat effort로 과/소 할당 누적. B는 per-teammate 차등(P2)으로
확장. C는 데이터가 쌓이며 점진 개선.

**10× 시나리오 분석**:

| 시나리오 | A 정적 | B Score-Aware | C GRPO |
|---------|--------|--------------|--------|
| 대형 멀티도메인 팀 | 전원 동일 xhigh, 토큰 폭증 | 무거운 팀원만 상향, 경량은 하향 | B + 과거 성과로 미세조정 |
| 컨텍스트 85%+ 압박 | 무시하고 max 시도 | ctxRatio<0.15 → −1 자동 강등 | 동일 + 학습된 강등 패턴 |
| 사소한 반복 작업 폭증 | 매번 xhigh 낭비 | score 낮아 자동 하향 | 학습으로 더 공격적 하향 |

→ B가 확장의 **필요조건**, C가 **충분조건**. A는 10×에서 토큰 비용으로 무너진다.

---

## 4. 숨겨진 비용

| 비용 항목 | A 정적 | B Score-Aware | C GRPO | 설명 |
|----------|--------|--------------|--------|------|
| 학습 곡선 | 없음 | 낮음 (순수 함수) | 중 (보상·트레이너 이해) | C는 GRPO 멘탈모델 필요 |
| 디버깅 난이도 | 낮음 | 낮음 (reason 문자열) | 중 (학습 정책 불투명) | B는 shift/reason로 audit |
| 토큰 오버헤드 | 0 | ~0 (동기 키워드 스캔) | 0 (야간 배치) | 런타임 비용 무시 가능 |
| 회귀 리스크 | 0 | 0 (byte-identical fallback) | 중 (flag로 격리) | C는 dormant로 0화 |
| 유지보수 | 낮음 | 낮음 | 중 (정책 파일·snapshot) | C는 롤백 절차 필요 |

---

## 5. Decision (추천안)

> ## ✓ **추천: B(Score-Aware)를 토대로, B → B+P2 → B+P2+C(dormant) 순 레이어링**

**선택 근거**:
1. **즉시 효과 + zero-risk**: B는 신호 없으면 정적과 완전 동일 — 안전하게 즉시 토큰 right-sizing.
2. **토대 재사용**: P2(팀 트리거 통합)와 C(P3 GRPO)가 모두 `resolveEffort`를 재사용 → B 없이는 둘 다 불가.
3. **숨은 비용 회피**: C 단독은 cold-start가 거칠고 데이터 축적 전 가치 0. B 베이스라인 위 bias로 얹어야 안전.

**선택하지 않은 이유**:
- A 정적: G1~G4 갭을 하나도 못 메움. 10× 확장에서 토큰 비용으로 붕괴.
- C 단독: 휴리스틱 베이스라인 부재로 cold-start 불안정 + 수 주 가치 0 + 품질 저하 리스크.

**가정과 전제 조건**:
- `classifyComplexity().score`가 작업 복잡도의 신뢰 가능한 proxy (현재 라우팅에서 검증됨)
- 시프트 임계값 0.7/0.25/0.15는 v1 휴리스틱 — 프로덕션 flapping 관측 시 config화(P1 §6 옵션)
- 바뀌면 재검토: 임계값 flapping 빈발 OR GRPO episode가 충분(>수천)해져 휴리스틱을 학습이 압도

---

## 6. Consequences (결과)

**좋아지는 점**:
- 작업 복잡도·컨텍스트 압박에 effort/budget가 적응 → 토큰 효율 ↑ (하위 quartile budget 목표 −30%)
- 단일 복잡도 계산이 팀 트리거와 effort를 동시 구동 → 코드 경로 통합(G2 해소)
- GRPO 피드백 루프로 장기 자가 개선 경로 확보(G3·G4 해소, dormant)

**나빠지는 점 / 새 부담**:
- effort 결정이 비결정적이 됨 → reason 문자열·shift 기록으로 audit 가능하게 상쇄
- 모듈 3개 신설 + 공유 파일(router.js/tasks.js) 편집 → P1 선행 + P2∥P3 순서로 충돌 회피
- P3 정책 파일·snapshot 관리 부담 → flag-gated dormant로 활성화 전까지 0

**필수 후속 작업**:
- [ ] P1 구현 + 56키 byte-identical 검증 (task #1)
- [ ] P2 구현 (task #2, blockedBy #1)
- [ ] P3 구현 + A/B 롤아웃 (task #3, blockedBy #1)
- [ ] P3 야간 스케줄러 dispatch 등록 지점 확정 (오픈 이슈)

**되돌리기 비용 (Reversibility)**: ☑ 쉬움 — B는 re-export 1줄 제거로 정적 복귀, C는 flag flip

---

## 7. 2년 뒤 기술 부채 예상 포인트

| 부채 항목 | 발생 확률 | 영향도 | 완화 전략 |
|----------|---------|-------|---------|
| 휴리스틱 임계값(0.7/0.25)이 모델 세대 변화에 안 맞아짐 | 중 | 중 | config화 + GRPO(C)가 학습으로 흡수 |
| GRPO 정책 파일 스키마 진화 시 마이그레이션 | 낮음 | 낮음 | version 필드 + version!=1→identity fallback |
| resolveEffort에 시프트 소스 누적(P1 휴리스틱+P3 학습+α) overshoot | 중 | 중 | 합산 후 단일 ladder clamp로 구조적 방어 |
| effort 비결정성으로 인한 재현 어려움 | 중 | 낮음 | reason/shift를 telemetry·decision-trail에 기록 |

**재검토 시점**: P1+P2 프로덕션 텔레메트리 2주 축적 후, 또는 GRPO episode 수천 돌파 시

---

## References

- PRD: `docs/PRD-EFFORT-DYNAMIC-WORKFLOW.md`
- 패턴 템플릿: `lib/cognitive/grpo-routing-config.js` (flag-gated 학습 bias)
- 관련 코드: `lib/cognitive/router.js` (EFFORT_POLICY:781, classifyComplexity:285), `lib/runtime/task-budget.js`
- 태스크: #1 P1 / #2 P2 / #3 P3
