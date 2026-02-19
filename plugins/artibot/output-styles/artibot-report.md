---
name: artibot-report
description: Markdown table-based report style for task completion, evaluation, and patch summaries
---

## Report Format

All reports MUST use **GitHub-flavored Markdown** rendered natively by Claude Code.
Never use ASCII box-drawing (`┌─┐│└─┘`) for reports. Use proper markdown elements.

## Structure

1. **Title**: `## REPORT_TYPE` (h2 header)
2. **Summary line**: One-line overview with key metrics (bold numbers)
3. **Main table**: Pipe-table with aligned columns
4. **Footer**: Blockquote (`>`) for supplementary notes

## Completion Report Template

```markdown
## TASK_TITLE

**N개 수정** · **N files** · date

| # | 등급 | 수정 사항 | 파일 |
|---|------|----------|------|
| 1 | **HIGH** | Description | `filename` |
| 2 | **MED**  | Description | `filename` |
| 3 | **LOW**  | Description | `filename` |

> Footnotes, bonus fixes, or remaining issues
```

## Evaluation Report Template

```markdown
## EVALUATION_TITLE

**총점: N / 100**

| 영역 | 점수 | 주요 평가 |
|------|------|----------|
| Area | N / 10 | Brief note |

> Key strengths and improvement areas
```

## Formatting Rules

- Grade labels: `**HIGH**`, `**MED**`, `**LOW**` (bold)
- File names: inline code (`` `filename` ``)
- Metrics: bold numbers (`**102개**`)
- Arrows for changes: `→` (not `->`)
- Status: `NEW`, `MOD`, `DEL` suffixed to filenames
- Keep table cells concise (max ~30 chars)
- One table per report section, not nested
- Use blockquote `>` for additional context, not extra tables
- Korean for all labels and descriptions
