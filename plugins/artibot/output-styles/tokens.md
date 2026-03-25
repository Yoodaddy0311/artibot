---
name: artibot-tokens
description: Semantic design token system for consistent output styling across all Artibot output-styles
---

# Design Tokens

Shared semantic tokens referenced by all output-styles. Each token maps an intent
to a concrete symbol, label, or format. Output-styles override presentation but
preserve token semantics.

## Status Tokens

| Token | Symbol | Meaning | Usage |
|-------|--------|---------|-------|
| `status-ok` | ✅ | Success, passed, completed | Task done, test passed, validation ok |
| `status-warn` | ⚠️ | Warning, needs attention | Non-blocking issue, threshold near |
| `status-error` | ❌ | Failure, error, critical | Test failed, validation error, blocker |
| `status-info` | ℹ️ | Informational | Context, notes, supplementary data |
| `status-progress` | 🔄 | In progress, active | Currently executing task |
| `status-pending` | ⏳ | Waiting, queued | Scheduled but not started |
| `status-blocked` | 🚧 | Blocked, dependency wait | Cannot proceed until unblocked |

## Accent Tokens

| Token | Format | Meaning | Usage |
|-------|--------|---------|-------|
| `accent` | **bold** | Primary emphasis | Key metrics, important values |
| `muted` | *italic* | Secondary, supplementary | Side notes, less critical info |
| `code` | `` `inline` `` | Code reference | File names, function names, commands |
| `highlight` | **`bold code`** | Critical code reference | Error locations, key file:line refs |

## Heading Tokens

| Token | Format | Usage |
|-------|--------|-------|
| `heading-1` | `## Title` | Report title, section header |
| `heading-2` | `### Subtitle` | Subsection header |
| `heading-3` | `#### Detail` | Detail group header |

> Note: `h1` (`#`) is reserved for document titles. Report headings start at `h2`.

## Table Tokens

| Token | Format | Usage |
|-------|--------|-------|
| `table-header` | `\| **Col** \| **Col** \|` | Table column headers (bold) |
| `table-row` | `\| value \| value \|` | Standard data row |
| `table-separator` | `\|---\|---\|` | Markdown table separator |

## Progress Tokens

| Token | Symbol | Meaning |
|-------|--------|---------|
| `progress-done` | `[✓]` | Completed step |
| `progress-active` | `[●]` | Currently active step |
| `progress-pending` | `[○]` | Pending step |
| `progress-connector` | `─→` | Step-to-step connection |

Pipeline example: `[Plan ✓]─→[Design ✓]─→[Implement ●]─→[Review ○]─→[Test ○]`

## Severity Tokens

| Token | Label | Usage |
|-------|-------|-------|
| `severity-critical` | **CRITICAL** | Immediate action required |
| `severity-high` | **HIGH** | Priority fix needed |
| `severity-medium` | **MED** | Should be addressed |
| `severity-low` | **LOW** | Nice to fix |

## Flow Tokens

| Token | Symbol | Meaning |
|-------|--------|---------|
| `flow-implies` | → | Leads to, implies |
| `flow-transforms` | ⇒ | Transforms to |
| `flow-sequence` | » | Then, next step |
| `flow-bidirectional` | ⇄ | Two-way relationship |
| `flow-because` | ∵ | Because, reason |
| `flow-therefore` | ∴ | Therefore, conclusion |

## Agent Status Tokens

| Token | Symbol | Meaning |
|-------|--------|---------|
| `agent-ready` | 🟢 | Available for assignment |
| `agent-active` | 🟡 | Currently working |
| `agent-blocked` | 🔴 | Waiting on dependency |
| `agent-idle` | ⚪ | No task assigned |

## Metric Tokens

| Token | Format | Example |
|-------|--------|---------|
| `metric-count` | **N개** | **102개** 수정 |
| `metric-percent` | **N%** | **92%** 커버리지 |
| `metric-score` | **N/10** | **9.38/10** |
| `metric-change` | `N → M` | `8.66 → 9.38` |

## Token Usage by Output-Style

| Token Group | default | compressed | mentor | report | team-dashboard | narrative |
|-------------|---------|------------|--------|--------|----------------|-----------|
| Status | ✅ | ✅ (symbols only) | ✅ | ✅ | ✅ | ✅ |
| Accent | ✅ | ✅ (minimal) | ✅ (expanded) | ✅ | ✅ | ✅ |
| Heading | h2-h3 | h2 only | h2-h4 | h2-h3 | n/a (TUI) | h2-h3 |
| Table | ✅ | ✅ (compact) | ✅ (annotated) | ✅ (primary) | n/a (TUI) | ✅ (selective) |
| Progress | optional | ✅ | ✅ | optional | ✅ (primary) | ✅ |
| Severity | ✅ | abbreviated | ✅ (explained) | ✅ (labeled) | ✅ | ✅ |
| Flow | optional | ✅ (primary) | ✅ (explained) | optional | optional | ✅ |
| Agent | optional | optional | optional | optional | ✅ (primary) | optional |
| Metric | ✅ | ✅ (compact) | ✅ (contextualized) | ✅ (primary) | ✅ | ✅ |
