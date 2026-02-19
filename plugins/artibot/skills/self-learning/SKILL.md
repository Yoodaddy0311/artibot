---
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
