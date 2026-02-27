---
description: 일일 회고 리포트 — 오늘의 커밋, 품질, 작업 현황, 다음 단계를 구조화된 대시보드로 출력
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
