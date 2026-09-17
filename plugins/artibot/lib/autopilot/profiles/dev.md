---
name: dev
description: Technical detail report for developers
length: 200-400 lines
---

# Autopilot Session — {{sessionId}}

| 항목 | 값 |
|------|-----|
| Session ID | {{sessionId}} |
| Mode | {{mode}} |
| Started | {{startedAt}} |
| Completed | {{completedAt}} |
| Status | {{status}} |
| Task | {{task}} |

## TL;DR

{{tldr}}

## Phase 결과

{{phaseTable}}

## 변경 파일

{{changedFilesTable}}

## Test Results

{{testResultsTable}}

## Cross-check

{{crossCheckTable}}

## Recovery Journal ({{recoveryJournalCount}})

_VERIFY 가 PASS 로 끝나면 행을 남기지 않는다 — 0 = 실패 판정 없음 또는 SH-06(a40534e1) 이전 세션. 전이는 CA-03 전까지 고정(IMPROVE)이며 `fixedNext` 열이 그 사실이다. `record-failed` 행은 판정이 아니라 기록기 실패다._

{{recoveryJournalTable}}

## Improvements ({{improvementsCount}})

{{improvementsTable}}

## Future Plans ({{futurePlansCount}})

{{futurePlansTable}}

## Risks

{{risksTable}}

## Next Action

{{nextAction}}
