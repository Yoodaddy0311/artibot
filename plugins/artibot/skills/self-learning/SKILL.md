---
context: forked
name: self-learning
description: |
  Toolformer + GRPO self-learning tool selection system. Tracks tool usage
  patterns, learns success rates per context, applies group relative policy
  optimization for comparative tool ranking, and recommends optimal tools.
  Auto-activates when: tool selection is ambiguous, repeated tool failures detected,
  or new task patterns encountered without prior history.
  Triggers: tool selection, which tool, best tool, recommend tool, learn, optimize tools,
  GRPO, group comparison, 도구 추천, 도구 선택, 최적 도구
platforms: [claude-code, gemini-cli, codex-cli, cursor]
level: 2
triggers:
  - "tool selection"
  - "GRPO"
  - "learn"
  - "optimize tools"
  - "recommend tool"
  - "which tool"
agents:
  - "orchestrator"
tokens: "~3K"
category: "learning"
---

# Self-Learning Tool Selection (Toolformer + GRPO)

## Contents
- [When This Skill Applies](#when-this-skill-applies)
- [Core Concept: Meta Toolformer](#core-concept-meta-toolformer)
- [Architecture](#architecture)
- [API Reference](#api-reference)
- [GRPO Scoring Criteria](#grpo-scoring-criteria)
- [Data Storage](#data-storage)
- [Integration Points](#integration-points)
- [Workflow Checklist](#workflow-checklist)
- [Human Checkpoints](#human-checkpoints)
- [Freedom Levels](#freedom-levels)
- [Anti-Patterns](#anti-patterns)
- [Quick Reference](#quick-reference)

## When This Skill Applies

- Ambiguous tool selection: multiple tools could serve the same purpose
- Repeated failures: a tool consistently underperforms for a task pattern
- New patterns: encountering a task without prior usage history
- Periodic optimization: reviewing tool efficiency across sessions

## Core Concept: Meta Toolformer

Inspired by the Toolformer paper (Schick et al. 2023), this system learns
**when and which tools to call** by observing outcomes:

```
Context (operation + target + scope)
  -> Candidate Tools
  -> Historical Success Scores (time-decayed)
  -> Ranked Recommendation
```

The system does NOT modify tool behavior. It learns which tool works best
for which context pattern and surfaces that as a recommendation.

### GRPO Layer: Group Relative Policy Optimization

On top of individual Toolformer tracking, GRPO compares **groups of tools**
that attempted the same task and ranks them relative to each other:

```
Same task attempted with multiple tools
  -> Score each: success (35%) + speed (25%) + accuracy (25%) + brevity (15%)
  -> Rank within group
  -> Compute relative advantage vs group mean
  -> Update cumulative GRPO score with learning rate 0.1
  -> Over time: best tool rises to top of suggestToolCandidates()
```

Key insight: no heavy evaluation model needed. CLI tools provide clear signals
(exit codes, execution time, output presence) for rule-based comparison.

## Architecture

```
PostToolUse Hook (tool-tracker.js)
  |
  v
Record: { tool, context, score, timestamp, command, domain }
  |
  v
tool-history.json (~/.claude/artibot/)
  |
  +--> suggestTool(context) -> Toolformer ranked recommendations
  |
  +--> recordGroupComparison(context, results[]) -> GRPO relative ranking
  |
  +--> suggestToolCandidates(context, count) -> Combined Toolformer+GRPO ranking
```

### Context Key Format

Context keys encode three dimensions:

```
{operation}:{target}:{scope}

Examples:
  search:typescript:file      - Searching within a TypeScript file
  edit:config:module           - Editing configuration at module level
  analyze:security:project     - Security analysis at project scope
  create:component:file        - Creating a UI component
```

### Scoring Model

- **Score range**: 0.0 (complete failure) to 1.0 (perfect success)
- **Time decay**: Exponential with 7-day half-life (recent data weighted higher)
- **Minimum samples**: 3 observations before trusting a recommendation
- **Confidence levels**: low (<3), medium (3-19), high (20+)

### Success Score Heuristics

The PostToolUse hook assigns scores based on tool outcome:

| Tool | Score 1.0 | Score 0.5 | Score 0.0 |
|------|-----------|-----------|-----------|
| Read | File found and content returned | File found but empty | File not found / error |
| Grep | Matches found | Partial matches | No matches / error |
| Glob | Files matched | Some matches | No matches |
| Bash | Exit code 0 | Exit code 0 with stderr | Non-zero exit code |
| Edit | Edit applied successfully | Edit applied with warnings | Edit failed |
| Write | File written | File written with path issue | Write failed |
| WebSearch | Results returned | Few results | No results / error |
| Task | Sub-agent completed | Sub-agent partial | Sub-agent failed |

## API Reference

### `suggestTool(context, options?)`

Returns ranked tool recommendations for a given context.

```javascript
import { suggestTool, buildContextKey } from '../lib/learning/tool-learner.js';

const ctx = buildContextKey('search', 'typescript', 'module');
const suggestions = await suggestTool(ctx, { limit: 3 });
// [{ tool: "Grep", weightedScore: 0.92, samples: 15, confidence: "medium" }]
```

### `recordUsage(tool, context, score, meta?)`

Records a tool usage event for learning.

```javascript
import { recordUsage } from '../lib/learning/tool-learner.js';

await recordUsage('Grep', 'search:typescript:module', 0.95, {
  command: '/analyze',
  domain: 'backend',
});
```

### `getToolStats(toolName?)`

Returns aggregate statistics for tools.

### `suggestToolCandidates(context, count?)`

Returns combined Toolformer + GRPO ranked candidates (default: 5).
Blends both signals: GRPO 60% + Toolformer 40% when both are available.

```javascript
import { suggestToolCandidates } from '../lib/learning/tool-learner.js';

const candidates = await suggestToolCandidates('search:typescript:module', 5);
// [{ tool: "Grep", combinedScore: 0.88, grpoScore: 0.85, toolformerScore: 0.92, ... }]
```

### `recordGroupComparison(context, results[])`

Record a GRPO group comparison. Each result needs: tool, success, durationMs, accuracy, brevity.

```javascript
import { recordGroupComparison } from '../lib/learning/tool-learner.js';

const group = await recordGroupComparison('find:recent:file', [
  { tool: 'find -mtime', success: true, durationMs: 150, accuracy: 0.9, brevity: 0.6 },
  { tool: 'git log --diff-filter', success: true, durationMs: 80, accuracy: 0.95, brevity: 0.4 },
  { tool: 'ls -lt', success: true, durationMs: 30, accuracy: 0.7, brevity: 0.9 },
]);
// group.rankings: [{ tool: "git log...", rank: 1, compositeScore: 0.82, relativeAdvantage: 0.05 }, ...]
```

### `getGrpoHistory(context, limit?)` / `getGrpoScores(context)`

Inspect GRPO comparison history and cumulative scores.

### `pruneOldRecords(retentionMs?)`

Cleans up records and GRPO groups older than retention period (default: 90 days).

## GRPO Scoring Criteria

| Factor | Weight | Signal | Source |
|--------|--------|--------|--------|
| Success | 35% | Exit code 0, result found | Tool result |
| Speed | 25% | Relative execution time (normalized within group) | durationMs |
| Accuracy | 25% | Output precision/usefulness (caller-assessed) | accuracy field |
| Brevity | 15% | Command conciseness (shorter = higher) | brevity field |

### GRPO Learning Dynamics

- **Learning rate**: 0.1 (conservative updates)
- **Initial score**: 0.5 (neutral)
- **Score range**: 0.0-1.0 (clamped)
- **Update formula**: `new_score = old_score + 0.1 * relative_advantage`
- **Relative advantage**: tool's composite score minus group mean (-1 to +1)
- **Convergence**: tools that consistently outperform rise; underperformers drop

## Data Storage

- **Location**: `~/.claude/artibot/tool-history.json`
- **Retention**: 90 days default, configurable
- **Toolformer cap**: 200 records per context key (FIFO eviction)
- **GRPO cap**: 50 comparison groups per context key
- **Persistence**: Written on every recordUsage() and recordGroupComparison() call
- **Schema version**: 2 (v1->v2 auto-migration for GRPO fields)

## Integration Points

- **PostToolUse hook** (`tool-tracker.js`): Automatic recording after every tool call
- **SC Router** (`/sc`): Can query suggestTool() to inform routing decisions
- **Orchestrator**: Can use getToolStats() for delegation intelligence
- **Session hooks**: pruneOldRecords() called on SessionStart for maintenance

## Workflow Checklist

Copy this checklist and track progress:

```
Progress:
- [ ] Step 1: Record tool usage via PostToolUse hook (tool, context, score)
- [ ] Step 2: Build context key (operation:target:scope)
- [ ] Step 3: Query suggestTool() for ranked recommendations
- [ ] Step 4: If comparing tools — record group comparison via GRPO
- [ ] Step 5: Update GRPO scores (learning rate 0.1, relative advantage)
- [ ] Step 6: Prune old records (90-day retention, 200 records/context cap)
```

## Human Checkpoints

### Checkpoint 1: 도구 추천 검토 (After Step 3)
**Context**: Toolformer가 현재 컨텍스트 키에 대한 최적 도구를 순위별로 추천한 시점. 추천은 과거 성공률 기반이므로 새로운 상황에서는 맞지 않을 수 있다.
**Ask**: "추천된 도구가 **현재 컨텍스트에 적합**한가요?"
**Options**:
1. Accept — 추천 도구를 수용하고 진행
2. Override with different tool — 다른 도구를 수동으로 지정하고 해당 도구의 사용 결과를 학습에 반영
**Default**: 1 (신뢰도 medium 이상이면 추천 수용 권장)
**Skippable**: No — 수용 또는 오버라이드를 명시적으로 결정해야 함
**Freedom**: MEDIUM

### Checkpoint 2: GRPO 그룹 비교 조건 검증 (After Step 4)
**Context**: 동일 작업에 대해 여러 도구를 비교하는 GRPO 그룹 비교를 기록하려는 시점. 비교 조건이 동등하지 않으면 학습 데이터가 오염된다.
**Ask**: "이번 그룹 비교가 **동일 작업·통제된 조건**에서 수행되었나요?"
**Options**:
1. Record comparison — 비교 결과를 기록하고 GRPO 점수 업데이트
2. Discard — 조건이 불균등하여 이번 비교 결과를 폐기
**Default**: 1 (도구 비교가 동일 입력으로 수행된 경우)
**Skippable**: No — 기록 또는 폐기를 명시적으로 결정해야 함
**Freedom**: MEDIUM

### Checkpoint 3: 데이터 정리 결과 확인 (After Step 6)
**Context**: 90일 보존 기간 및 컨텍스트당 200건 상한에 따라 오래된 학습 기록이 삭제된 시점. 유용한 데이터가 의도치 않게 삭제되지 않았는지 확인이 필요하다.
**Ask**: "정리 작업이 **오래된 데이터만 제거**했나요?"
**Options**:
1. Confirm — 정리 결과를 수용하고 완료
2. Adjust retention period — 보존 기간 또는 상한을 조정하고 재실행
**Default**: 1 (설정된 보존 정책이 적절한 경우)
**Skippable**: No — 확인 또는 정책 조정을 명시적으로 결정해야 함
**Freedom**: LOW

## Freedom Levels

| Step | Freedom | Guidance |
|------|:-------:|----------|
| Record tool usage | LOW | Automatic via hook, schema is fixed |
| Build context key | LOW | Format is defined (operation:target:scope) |
| Query suggestions | MEDIUM | Recommendations are advisory, not mandatory |
| Record GRPO comparison | MEDIUM | Comparison setup requires judgment on fairness |
| Update scores | LOW | Formula and learning rate are defined |
| Prune old records | LOW | Retention period and caps are configured |

## Anti-Patterns

- Do NOT use suggestions as hard rules (always allow tool override)
- Do NOT record usage for trivial operations (e.g., reading CLAUDE.md)
- Do NOT trust low-confidence recommendations for critical operations
- Do NOT store sensitive data in context keys (no file paths, no credentials)

## Quick Reference

- Context format: `operation:target:scope`
- Score: 0.0-1.0, time-decayed with 7-day half-life
- Min samples: 3 before recommending
- Storage: `~/.claude/artibot/tool-history.json`
- Retention: 90 days, 200 records/context cap
