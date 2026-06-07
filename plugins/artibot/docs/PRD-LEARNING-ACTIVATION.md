# PRD: Learning Policy Activation (단계적 롤아웃)

> **Status**: Approved · **Created**: 2026-05-29 · **Owner**: Artibot core
> **성격**: 수 주에 걸친 데이터 의존 + A/B 게이트 롤아웃 — 단일 실행으로 완료 불가

## 1. 배경 (진단 결과)

`learning.grpoRouting`의 정책 bias 레이어 4종이 모두 `enabled:false`이고, **학습된 정책 파일이 하나도 없다**(`~/.claude/artibot/policies/` 디렉터리 부재). 진단:

| 레이어 | enabled | 정책 파일 | 트레이너(.mjs) | TRAINERS 레지스트리 |
|--------|:---:|:---:|:---:|:---:|
| 핵심 GRPO 옵티마이저 | n/a (ON) | grpo-history.json ✅ | nightly-grpo-trainer ✅ | ✅ |
| agentPolicy | false | ❌ | ✅ | ✅ |
| skillPolicy | false | ❌ | ✅ | ✅ |
| jointPolicy | false | ❌ | ✅ | ✅ |
| effortPolicy (P3) | false | ❌ | **❌ 없음** | **❌ 없음** |

**근본 원인**: 트레이너 .mjs는 (effort 제외) 존재하나 **OS 스케줄러에 설치된 적이 없어** 야간 실행이 한 번도 안 됨 → 정책 파일 미생성 → readers를 켜도 identity(무효과). 즉 "스위치를 켜면 개선"이 아니라 **빈 파이프라인**.

## 2. 목표 / 비목표

**목표**: 학습된 정책 bias를 **안전하게, 측정 가능하게** 실제 라우팅/effort 결정에 적용하기까지의 단계적 경로를 구축.

**비목표**:
- 데이터·검증 없이 `enabled:true`로 전환 (품질 회귀·드리프트 리스크)
- 핵심 GRPO 옵티마이저 변경 (이미 작동 중)
- 외부 데이터 송신 (DATA POLICY — 모든 학습 로컬)

## 2.5 Goal Contract

```json
{
  "objective": "4종 정책 트레이너가 shadow 모드로 야간 가동되어 수렴된 정책 파일을 생성하고, A/B 검증 후 검증된 레이어만 활성화한다",
  "stoppingCondition": "Phase 1(트레이너 인프라 완성) 코드가 머지되고 npm run ci 통과 — 활성화 자체는 데이터 축적 후 별도 게이트",
  "validationCommand": "npm run ci",
  "maxIterations": 3
}
```

## 3. 단계적 롤아웃 (6 Stage)

| Stage | 내용 | 주체 | 게이트 |
|-------|------|------|--------|
| **S1. 트레이너 인프라 완성** | effortPolicy 트레이너(.mjs + TRAINERS 등록) 추가 → 4종 패리티. readers 전부 enabled:false 유지 | **이 autopilot (코드)** | CI green |
| **S2. 스케줄러 설치** | `setup-nightly-trainers.js`로 OS 스케줄러(schtasks)에 5 트레이너 등록 → 야간 실행 시작 | **사용자 (시스템 변경)** | 사용자 승인 + `powercfg`/`schtasks /query` 확인 |
| **S3. Shadow 데이터 축적** | 수 주간 reward episode 누적, 트레이너가 정책 파일 야간 생성. readers OFF = 행동 무변화 | 수동적 (시간) | coldStartEpisodes(150) 도달 |
| **S4. 정책 sanity 검수** | 생성된 policy-v1.json 검수 (수렴, 가중치 합리성, clamp 범위) | 사람 | 검수 통과 |
| **S5. A/B 활성화 (1 레이어)** | 가장 안전한 레이어(예: skillPolicy) 1개만 enabled:true + 대조군 대비 지표 비교 | 사람 결정 | reward/successRate 개선 |
| **S6. Promote / Rollback** | 개선 확인 시 promote, 저하 시 snapshot rollback + enabled:false | 사람 | — |

> autopilot은 **S1만** 자율 완료. S2~S6는 시스템 변경·시간·사람 판단이 필요해 게이트로 분리.

## 4. S1 실행 계획 (이 autopilot의 EXECUTE 범위)

`nightly-effort-policy-trainer.mjs` 신규 + `setup-nightly-trainers.js` TRAINERS에 effort-policy 항목 추가(03:30, 기존 effortPolicy config의 cron과 일치). 기존 4종 트레이너 패턴 그대로 미러. **readers는 건드리지 않음**(enabled:false 유지).

- 신규: `scripts/hooks/nightly-effort-policy-trainer.mjs` — `createEffortPolicyUpdater().trainFromEpisodes(recentEpisodes)` 래핑, 기존 nightly-skill-policy-trainer.mjs 패턴 미러
- 수정: `scripts/setup-nightly-trainers.js` — TRAINERS 배열에 effort-policy 항목 추가
- 검증: 트레이너 목록 테스트(있으면) 갱신, `npm run ci` green

## 5. 위험 / 완화

| 위험 | 완화 |
|------|------|
| 조기 활성화로 라우팅 품질 회귀 | S5 전까지 readers enabled:false. A/B 대조 필수 |
| 피드백 루프 드리프트 (정책→라우팅→보상 자기강화) | S5에서 1 레이어만, 탐험 유지, 지표 모니터 |
| 정책 파일 손상/미수렴 | reader가 version!=1/손상 시 identity fallback. coldStart 게이팅 |
| 비결정성으로 디버깅 난이도 | reason 문자열·snapshot으로 audit |
| S2 OS 스케줄러 변경 | 사용자가 직접 실행, user-level(관리자 불요), reversible |

## 6. 수락 기준 (S1)

- [ ] `nightly-effort-policy-trainer.mjs` 생성, 기존 트레이너 패턴 준수
- [ ] `setup-nightly-trainers.js` TRAINERS에 effort-policy 등록 (5→6 트레이너)
- [ ] 모든 readers `enabled:false` 유지 (S1은 행동 무변화)
- [ ] `npm run ci` green, release:check green
- [ ] S2~S6 게이트가 보고서에 명시되어 사용자가 다음 단계를 안다

## 7. 참조
- 진단 근거: 이 세션 (policies 디렉터리 부재, 스케줄러 미등록)
- 관련: P3 `docs/PRD-EFFORT-DYNAMIC-WORKFLOW.md`, `docs/adr/ADR-001`, `lib/learning/grpo/effort-policy-updater.js`
- 트레이너 패턴: `scripts/setup-nightly-trainers.js`, `scripts/hooks/nightly-skill-policy-trainer.mjs`
