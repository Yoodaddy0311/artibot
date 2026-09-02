# 06. Adaptive DAG Scheduler

## 현재 기반

`/split plan`은 이미 `buildFastFanoutPlan`을 이용하고 `affectedPaths`, `dependsOn`, `risk`, `worktreeEligible`을 사용한다. 따라서 새 scheduler는 기존 planner를 버리지 않고 **그 결과를 runtime에서 동적으로 재스케줄**한다.

## 핵심 변화

`maxWindows=4`를 없애는 것이 아니라:
- hard safety cap으로 유지
- 실제 active concurrency는 매 순간 동적으로 1..cap 조절
- 검증 후 cap 자체도 auto profile로 4→6→8 등 opt-in 가능

## Scheduling Score

```text
priority =
  criticalPathWeight
+ unblockCountWeight
+ ageWeight
+ smallTaskBonus
- riskPenalty
- resourcePenalty
- sharedFilePenalty
```

## Resource Classes

| Class | 예 | 동시성 |
|---|---|---|
| LIGHT | docs, grep, small unit | 높음 |
| CPU | build, full test | CPU budget 기반 |
| IO | package install, fetch | 중간 |
| DB | migration/integration DB | 직렬 또는 제한 |
| SERVER | dev server / fixed port | 충돌 group 직렬 |
| HIGH_RISK | auth/security/schema | reviewer slot 동반 |

## Conflict Graph

현재 file ownership rule을 그래프로 승격:

- vertex = lane
- edge = same affected path / shared lock / port / migration counter / generated artifact
- connected conflict group은 같은 시간에 실행하지 않음

## Work Stealing

Worker가 빨리 끝나면 다음 wave까지 기다리지 않고:
- dependency가 해제됐고
- conflict가 없고
- budget이 허용되는

pending lane을 가져온다.

## Backpressure

다음 조건에서는 새 lane spawn 금지:
- combined CPU > 80%
- memory pressure high
- API rate-limit active
- review queue > reviewer capacity × 2
- token burn rate > budget curve
- integration DB slot busy

## 추천 Config

초기:
```json
{
  "mode": "adaptive",
  "minConcurrency": 1,
  "hardMaxWindows": 4,
  "targetCpuPct": 70,
  "maxConcurrentHeavy": 2,
  "workStealing": true
}
```

데이터 축적 후 hardMax 6~8 실험.

## scheduler가 절대 자동으로 바꾸면 안 되는 것
- file ownership contract
- migration numbering policy
- permission mode
- security policy
- prod deployment approval
