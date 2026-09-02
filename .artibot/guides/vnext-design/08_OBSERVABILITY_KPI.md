# 08. Observability & KPI

## 현재 telemetry를 살린다

현재 split telemetry는:
- fast profile
- phase pair
- wall-clock pair
- humanWait

를 기록한다.

vNext에서는 이를 삭제/변경하기보다 새 event를 additive로 얹는다.

## KPI 세트

| KPI | 정의 |
|---|---|
| Lane Throughput | accepted lane / run hour |
| Parallel Efficiency | estimated serial wall / actual wall |
| Human Wait % | operator wait / total run |
| Completion Rate | completed / dispatched |
| First-pass Approval | first review approve / reviewed lane |
| Rework Rate | changes-requested / reviewed lane |
| Conflict Rate | conflict lanes / integrated lanes |
| Auto-Recovery Rate | automatically recovered / recoverable failures |
| Context Intervention Rate | manual compact/clear/resume / run |
| Context Rotation Success | resumed without clarification / rotation |
| Gate Failure Rate | combined gate failure / run |
| Post-merge Fix Rate | 24h fix-forward / landing |
| Cost per Accepted Lane | tokens/cost / accepted lane |
| Product Delta | completion score delta / run |
| Live Delta | staging/prod delivered delta / run |

## Split Efficiency Score (SES)

초기 제안:

```text
SES =
  20% Parallel Efficiency
+ 15% Completion Rate
+ 15% First-pass Approval
+ 10% Conflict Avoidance
+ 10% Human Wait Efficiency
+ 10% Auto-Recovery
+ 10% Context Autonomy
+ 10% Cost Efficiency
```

각 항목 0~100 normalize.

## Supervisor KPI

가장 중요한 새 KPI는 **Avoided Human Interventions**다.

```text
manual interventions baseline
- actual manual interventions
= avoided interventions
```

예:
- status check 12회 자동화
- compact 3회 자동 lifecycle
- retry 2회 자동
- reviewer follow-up 1회 자동

→ run당 18 intervention 절감.

## Dashboard 최소 화면

```text
Run split-abc123    68%    ETA confidence: medium

ACTIVE  3 | REVIEW 1 | BLOCKED 0 | DONE 5
Human wait 5.8% | Cost budget 43% | Context rotations 2

Lane             State        Context   Budget   Last event
work-ui          RUNNING      62%       38%      2m
registry         REVIEW       44%       55%      1m
memory           DONE         -         41%      9m
schema           DONE         -         63%      18m

Exceptions: 0
```

## 알림 원칙

사람에게 정상 progress를 계속 말하지 않는다.

알림:
- owner/security/irreversible decision
- hard budget
- terminal failure
- ETA가 임계 이상 증가
- live promotion ready

나머지는 dashboard/event log.
