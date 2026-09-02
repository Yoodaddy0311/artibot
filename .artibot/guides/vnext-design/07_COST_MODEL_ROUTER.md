# 07. Cost / Model / Effort Router

## 현재 기반

`artibot.config.json`에는 이미 agent `modelPolicy`, advisor strategy, fable kill switch가 있다. 따라서 vNext는 새 모델 정책을 중복 정의하지 않고 **task/lane 단위 runtime budget layer**를 추가한다.

## 먼저 effort를 최적화하고 model은 나중에

현재 단일-tier 정책을 운영자가 선택한 상태라면 이를 깨지 않는다.

우선:
- maxTurns
- effort
- context bundle size
- reviewer 횟수
- retry 횟수
- full-gate 실행 시점

으로 비용을 줄인다.

## Lane Complexity Classifier

```text
XS: 문서/단일 설정/검색
S : 1~2 files, low risk
M : 3~7 files, bounded feature
L : cross-domain / API / data
XL: architecture / migration / security / multi-wave
```

추가 risk:
- LOW
- MEDIUM
- HIGH
- CRITICAL

## Budget Policy 예

| Class | effort | maxTurns | reviewer | retry |
|---|---:|---:|---|---:|
| XS | low | 8 | optional | 1 |
| S | medium | 16 | lightweight | 1 |
| M | high | 30 | independent | 2 |
| L | high/xhigh | 50 | independent + specialist | 2 |
| XL | xhigh/max | 80 | council | 2 |

## Model Router

기존 `modelPolicy`가 허용하는 모델 중에서만 선택.

```text
eligibleModels = centralModelPolicy(agent)
chosen = cheapest model satisfying:
  task complexity
  risk minimum tier
  required tool support
  observed historical success rate
```

security-reviewer 같은 hard pin은 runtime router가 절대 override하지 않는다.

## Run Budget

```json
{
  "maxWallMinutes": 240,
  "maxTotalTokens": 2500000,
  "maxCostUsd": null,
  "maxRetriesPerLane": 2,
  "maxConcurrentHighEffort": 2,
  "onSoftLimit": "degrade",
  "onHardLimit": "pause"
}
```

## Economic feedback

lane 완료 후 기록:
- tokens in/out
- elapsed
- model
- effort
- attempts
- review rework
- gate result

같은 종류의 다음 task에서 `cost per accepted lane`을 최소화한다.

## 잘못된 최적화 방지

비용을 낮췄는데:
- rework 증가
- first-pass approval 하락
- post-merge fix 증가

하면 경제성이 좋아진 것이 아니다.

따라서 핵심 KPI:

`Effective Cost = direct model cost + rework cost + human minutes cost + failed-run cost`
