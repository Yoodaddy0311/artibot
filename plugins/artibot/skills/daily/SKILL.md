---
context: forked
description: "일일 회고 리포트 — 오늘의 커밋, 품질, 작업 현황, 다음 단계를 구조화된 대시보드로 출력. Use when reviewing daily progress, generating retrospective reports, or planning next actions."
triggers:
  - daily
  - recap
  - 회고
  - 일일 보고
  - 오늘 작업
  - 오늘 뭐 했지
  - today
  - retrospective
  - 복기
  - 일일 리포트
---

# /daily — Daily Retrospective Report

Collects today's git activity, quality metrics, task status, and worklog entries into a structured review dashboard.

## Activation

Auto-activates when user mentions: "daily", "recap", "회고", "오늘 작업", "오늘 뭐 했지", "복기", "일일 보고"

## What It Reports (7 Sections)

1. **커밋 요약** — Today's commits with type, description, file count
2. **변경 현황** — Files changed grouped by directory
3. **품질 현황** — Test results, coverage, lint status
4. **작업 현황** — Current tasks (completed/in-progress/pending)
5. **세션 기록** — Today's worklog entry (작업/결정/보류)
6. **다음 단계** — Prioritized next actions from tasks + worklog + git
7. **Footer** — Generation time, duration, data sources

## Flags

- `--save`: Persist to `memory/daily/YYYY-MM-DD.md`
- `--quick`: Skip quality checks (<5s)
- `--date YYYY-MM-DD`: Historical lookup
- `--no-tasks`: Skip task collection

## Data Sources

| Source | Tool | Section |
|--------|------|---------|
| Git log | Bash | 커밋 요약, 변경 현황 |
| npm test | Bash | 품질 현황 |
| TaskList | TaskList tool | 작업 현황, 다음 단계 |
| worklog.md | Read | 세션 기록, 다음 단계 |
| git status | Bash | 다음 단계 |

## Workflow Checklist

Copy this checklist and track progress:

```
Progress:
- [ ] Step 1: Collect today's git log (commits, file changes)
- [ ] Step 2: Run quality checks (npm test, lint, coverage)
- [ ] Step 3: Gather task status (completed/in-progress/pending)
- [ ] Step 4: Read worklog for session entries
- [ ] Step 5: Compile 7-section dashboard
- [ ] Step 6: Generate prioritized next actions
- [ ] Step 7: Save report if --save flag (memory/daily/YYYY-MM-DD.md)
```

## Human Checkpoints

### Checkpoint 1: 품질 이슈 처리 결정 (After Step 2)
**Context**: 품질 체크 실행 후 테스트 실패, 린트 오류, 커버리지 저하 등이 발견된 시점. 회고 보고서 작성 전에 이슈를 처리할지 결정해야 한다.
**Ask**: "품질 체크에서 **이슈가 발견**되었습니다. 지금 바로 수정할까요?"
**Options**:
1. Fix issues — 회고 작성 전 발견된 이슈를 먼저 수정
2. Note and proceed — 이슈를 기록하고 보고서에 포함하여 계속 진행
**Default**: 2 (회고는 현재 상태를 있는 그대로 기록하는 것이 목적)
**Skippable**: No — 이슈를 무시하면 보고서 정확성이 낮아짐
**Freedom**: MEDIUM

### Checkpoint 2: 다음 단계 우선순위 확인 (After Step 6)
**Context**: 여러 소스(태스크, 워크로그, git 상태)에서 다음 액션을 수집하여 우선순위를 정한 시점. 자동 우선순위가 실제 업무 맥락과 다를 수 있다.
**Ask**: "다음 단계를 **[우선순위 목록]** 으로 정렬했습니다. 이 순서가 맞나요?"
**Options**:
1. Accept priorities — 현재 우선순위 그대로 최종 보고서에 포함
2. Reorder — 특정 항목의 우선순위를 변경
3. Add items — 목록에 빠진 항목을 추가
**Default**: 1 (자동 수집된 우선순위를 신뢰)
**Skippable**: Yes (use default) — 기본 우선순위로 보고서 완성
**Freedom**: HIGH

### Checkpoint 3: 보고서 저장 확인 (After Step 7)
**Context**: 7섹션 대시보드가 완성된 시점. --save 플래그 없이 실행된 경우에도 향후 참조를 위해 저장 여부를 선택할 수 있다.
**Ask**: "오늘의 회고 보고서가 완성되었습니다. **파일로 저장**할까요? (`memory/daily/YYYY-MM-DD.md`)"
**Options**:
1. Save — 지정 경로에 보고서 저장
2. Skip — 저장하지 않고 화면 출력으로만 확인
**Default**: 2 (명시적 --save 없이는 저장 안 함)
**Skippable**: No — 사용자의 저장 의도를 명확히 확인해야 함
**Freedom**: LOW

## Freedom Levels

| Step | Freedom | Guidance |
|------|:-------:|----------|
| Collect git log | LOW | Standard git commands, date-filtered |
| Run quality checks | LOW | npm test and lint — run as defined |
| Gather task status | MEDIUM | TaskList query, interpretation of status flexible |
| Read worklog | LOW | Fixed file location, read as-is |
| Compile dashboard | LOW | 7-section format is defined |
| Generate next actions | HIGH | Prioritization requires judgment across sources |
| Save report | LOW | Path format and content defined |
