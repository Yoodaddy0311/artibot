---
name: team
context: forked
description: "Parallel team execution with cross-check. Leader delegates, teammates work independently, then verify each other. Use when parallel independent work with cross-verification is needed."
triggers:
  - team
  - 팀
  - parallel team
  - 병렬 팀
  - cross-check
  - verification
  - 팀원들
  - 병렬로
---

# /team

리더가 직접 구현하지 않고 작업을 분해해 병렬 팀으로 위임한 뒤, 마지막에 교차 검증까지 수행하는 스킬입니다.

## Activation

다음과 같은 요청에서 사용합니다.
- 병렬로 나눠서 진행해줘
- 팀으로 처리해줘
- 서로 검증하면서 병렬 작업해줘
- cross-check가 필요한 독립 작업

## Workflow

1. 리더가 요청을 독립 작업 단위로 분해합니다.
2. 팀을 만들고 모든 작업을 병렬로 위임합니다.
3. 각 팀원은 자기 작업을 독립적으로 수행합니다.
4. 1차 결과가 모이면 서로의 결과를 교차 검증합니다.
5. 리더가 전체 결과와 검증 의견을 합쳐 사용자에게 보고합니다.

## Checklist

```text
Progress:
- [ ] 요청을 작업 단위로 분해
- [ ] 팀 생성 및 역할 할당
- [ ] 병렬 실행 시작
- [ ] 각 결과 수집
- [ ] 교차 검증 수행
- [ ] 최종 통합 보고
```

## Guardrails

- 리더는 직접 구현보다 분해와 조정에 집중합니다.
- 실제 의존성이 없는 작업만 병렬화합니다.
- 교차 검증 없이 결과를 바로 합치지 않습니다.
- 같은 사람이 자기 결과를 검증하지 않습니다.
- 최종 보고에는 “무엇을 했는지”뿐 아니라 “무엇을 검증했는지”를 함께 적습니다.
