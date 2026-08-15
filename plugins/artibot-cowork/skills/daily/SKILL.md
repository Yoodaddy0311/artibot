---
name: daily
context: fork
disable-model-invocation: true
description: "일일 회고 리포트. 오늘의 산출물, 품질 상태, 작업 현황, 다음 단계를 구조화된 대시보드로 정리한다. Use when reviewing daily progress, generating a retrospective, or planning the next actions."
triggers:
  - daily
  - recap
  - 회고
  - 일일 보고
  - 오늘 작업
  - 오늘 뭐 했지
  - retrospective
  - daily report
---

# /daily

오늘의 작업 흐름을 짧고 구조적으로 정리하는 일일 회고 스킬입니다.

## Activation

다음과 같은 요청에서 사용합니다.
- 오늘 한 일 정리
- 일일 회고
- 산출물/품질/작업 현황 요약
- 다음 단계 우선순위 정리

## Output Shape

다음 6개 섹션을 기본 골격으로 사용합니다.
1. 오늘의 산출물 요약
2. 작업 영역 요약
3. 품질 상태
4. 작업 현황
5. 주요 결정과 메모
6. 다음 단계

## Workflow

1. 오늘 날짜 기준으로 작성·수정된 산출물을 수집합니다.
2. AI-슬롭 검출, 품질 루브릭, 컴플라이언스 등 품질 신호를 확인합니다.
3. 현재 진행 중/완료/대기 작업을 모읍니다.
4. worklog 또는 세션 메모가 있으면 핵심 결정만 압축합니다.
5. 다음 단계는 우선순위와 근거를 함께 정리합니다.

## Checklist

```text
Progress:
- [ ] 오늘의 산출물 수집
- [ ] 품질 상태 확인
- [ ] 작업 현황 정리
- [ ] 주요 결정/메모 반영
- [ ] 다음 단계 우선순위 정리
- [ ] 최종 대시보드 출력
```

## Guardrails

- 장황한 회고보다 빠르게 훑을 수 있는 요약을 우선합니다.
- 품질 게이트 미달이나 미해결 컴플라이언스 이슈는 숨기지 말고 드러냅니다.
- 다음 단계는 실행 가능한 액션으로 씁니다.
- 정보가 비어 있으면 추측하지 말고 “확인되지 않음”으로 표시합니다.
