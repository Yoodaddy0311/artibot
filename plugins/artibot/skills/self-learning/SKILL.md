---
context: fork
user-invocable: false
name: self-learning
description: |
  Toolformer self-learning tool selection system. Tracks tool usage
  patterns, learns success rates per context, and recommends optimal tools.
  Auto-activates when: tool selection is ambiguous, repeated tool failures detected,
  or new task patterns encountered without prior history.
  Triggers: tool selection, which tool, best tool, recommend tool, optimize tools,
  도구 추천, 도구 선택, 최적 도구
lang: [en, ko]
platforms: [claude-code, gemini-cli, codex-cli, cursor]
level: 2
triggers:
  - "tool selection"
  - "optimize tools"
  - "recommend tool"
  - "which tool"
agents:
  - "orchestrator"
tokens: "~3K"
category: "learning"
source_hash: b8f14400
whenNotToUse: "Situations where tool choice is unambiguous and no historical failure pattern exists; do not apply overhead when only one valid tool exists for the task."
---

# Self-Learning Tool Selection (Toolformer + GRPO)

> **Status (2026-09-29)** — 이 스킬에서 코드가 남아 있는 것은 Toolformer 층뿐이다(`lib/learning/tool-learner.js` 의 `recordUsage` · `suggestTool` · `getToolStats` · `pruneOldRecords` · `buildContextKey` 등). GRPO 층의 4개 API — `suggestToolCandidates` · `recordGroupComparison` · `getGrpoHistory` · `getGrpoScores` — 는 4.27.0(2026-06-21, `CHANGELOG.md` "Dead GRPO comparison API (#78)")에서 삭제됐다. 아래 GRPO 표기 절은 **역사 기록으로 보존**하며 실행 지침이 아니다.

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

> **Retired (4.27.0, 2026-06-21)** — 이 절이 서술하는 그룹 비교 층은 구현이 삭제됐다. `lib/learning/tool-learner.js` 는 `suggestToolCandidates` · `recordGroupComparison` · `getGrpoHistory` · `getGrpoScores` 를 export 하지 않고, `createEmptyHistory()` 의 v2 스키마에는 `grpoGroups` · `grpoScores` 필드가 없다(부재는 `tests/learning/tool-learner.test.js` · `tool-history.test.js` 가 핀). 아래 도식·점수식은 **역사 기록으로 보존**하며 실행 지침이 아니다. 라이브로 도는 GRPO 랭킹은 lifelong-learning 스킬의 배치 학습 그룹 내 랭킹(`lib/learning/pattern-analyzer.js#grpoRankGroup`)이며, 이 절의 도구 비교와는 별개다.

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

> 위 도식의 `recordGroupComparison(...)` · `suggestToolCandidates(...)` 두 갈래는 은퇴(4.27.0) — 두 함수 모두 export 되지 않는다. 남는 갈래는 `suggestTool(context)` 하나다. 기록 쪽 라이브 경로는 `scripts/hooks/tool-tracker.js` 의 `recordUsage` 호출이며, `suggestTool()` 은 export 되지만 프로덕션 호출자는 없다(2026-09-29 기준 리포 전역에서 정의·barrel·테스트·문서뿐).

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

> **Retired (4.27.0)** — `tool-learner.js` 가 export 하지 않는다. 아래는 역사 기록이며 실행할 수 없다.

Returns combined Toolformer + GRPO ranked candidates (default: 5).
Blends both signals: GRPO 60% + Toolformer 40% when both are available.

```javascript
// Historical — retired 4.27.0, not exported (this import would fail to link).
// import { suggestToolCandidates } from '../lib/learning/tool-learner.js';
//
// const candidates = await suggestToolCandidates('search:typescript:module', 5);
// // [{ tool: "Grep", combinedScore: 0.88, grpoScore: 0.85, toolformerScore: 0.92, ... }]
```

### `recordGroupComparison(context, results[])`

> **Retired (4.27.0)** — `tool-learner.js` 가 export 하지 않는다. 아래는 역사 기록이며 실행할 수 없다.

Record a GRPO group comparison. Each result needs: tool, success, durationMs, accuracy, brevity.

```javascript
// Historical — retired 4.27.0, not exported (this import would fail to link).
// import { recordGroupComparison } from '../lib/learning/tool-learner.js';
//
// const group = await recordGroupComparison('find:recent:file', [
//   { tool: 'find -mtime', success: true, durationMs: 150, accuracy: 0.9, brevity: 0.6 },
//   { tool: 'git log --diff-filter', success: true, durationMs: 80, accuracy: 0.95, brevity: 0.4 },
//   { tool: 'ls -lt', success: true, durationMs: 30, accuracy: 0.7, brevity: 0.9 },
// ]);
// // group.rankings: [{ tool: "git log...", rank: 1, compositeScore: 0.82, relativeAdvantage: 0.05 }, ...]
```

### `getGrpoHistory(context, limit?)` / `getGrpoScores(context)`

> **Retired (4.27.0)** — 두 함수 모두 export 되지 않으며, 조회하던 `grpoGroups` · `grpoScores` 는 `tool-history.json` 에 더 이상 쓰이지 않는다. 아래 한 줄은 역사 기록이다.

Inspect GRPO comparison history and cumulative scores.

### `pruneOldRecords(retentionMs?)`

Cleans up records older than the retention period (default: 90 days). (GRPO groups: 은퇴 — 정리할 그룹 저장소가 없다.)

## GRPO Scoring Criteria

> **Retired (4.27.0)** — 아래 4요인 가중치와 "GRPO Learning Dynamics" 의 누적 점수 갱신식(학습률 0.1)은 삭제된 tool-learner 그룹 비교 층(`recordGroupComparison`)의 것이다. 이 스킬에 남는 점수 모델은 위 Scoring Model 의 시간 감쇠 성공률뿐이다. (lifelong-learning 의 라이브 랭킹 `pattern-analyzer.js#grpoRankGroup` 은 별개 구현이며 누적 점수 갱신이 없다.)

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
- ~~**GRPO cap**: 50 comparison groups per context key~~ — 은퇴(4.27.0): 그룹 저장소가 삭제되어 `tool-history.json` 에 `grpoGroups` 가 없다
- **Persistence**: Written after `recordUsage()` calls, debounced — dirty 표시 뒤 5초(`FLUSH_INTERVAL_MS`) 또는 `flushToDisk()` 때 디스크에 쓴다 (`recordGroupComparison()` 은 은퇴)
- **Schema version**: 2 (`createEmptyHistory()` 가 `version: 2` 를 쓴다). ~~v1->v2 auto-migration for GRPO fields~~ — 은퇴: `loadHistory()` 는 `version` 이 없거나 1 미만일 때만 빈 이력으로 초기화하며 GRPO 필드 마이그레이션은 없다

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
- [ ] Step 4: If comparing tools — record group comparison via GRPO (retired 4.27.0 — skip)
- [ ] Step 5: Update GRPO scores (learning rate 0.1, relative advantage) (retired 4.27.0 — skip)
- [ ] Step 6: Prune old records (90-day retention, 200 records/context cap)
```

## Human Checkpoints

> `### Self-check` 항목은 사람에게 묻지 않는다 — 모델이 Ask 문장을 기준으로 스스로 검증하고, 통과하지 못하면 해당 Step 으로 돌아가 고친다. 스스로 해소할 수 없거나(사람만 할 수 있는 조치·예외 인정) 판단에 확신이 없으면 중단하고 사용자에게 보고한다. 사람의 결정이 필요한 것은 `### Checkpoint` 뿐이다.

### Self-check 1: 도구 추천 검토 (After Step 3)
**Context**: Toolformer가 현재 컨텍스트 키에 대한 최적 도구를 순위별로 추천한 시점. 추천은 과거 성공률 기반이므로 새로운 상황에서는 맞지 않을 수 있다.
**Ask**: "추천된 도구가 **현재 컨텍스트에 적합**한가요?"
**Options**:
1. Accept — 추천 도구를 수용하고 진행
2. Override with different tool — 다른 도구를 수동으로 지정하고 해당 도구의 사용 결과를 학습에 반영
**Default**: 1 (신뢰도 medium 이상이면 추천 수용 권장)
**Skippable**: No — 수용 또는 오버라이드를 명시적으로 결정해야 함
**Freedom**: MEDIUM

### Checkpoint 2: GRPO 그룹 비교 조건 검증 (After Step 4)
> **Retired (4.27.0)** — 이 체크포인트가 게이트하던 그룹 비교 기록 기능이 삭제돼 현재 발동 조건이 없다. Step 4~5 를 건너뛰면 도달하지 않는다. 아래 본문은 역사 기록으로 보존한다.

**Context**: 동일 작업에 대해 여러 도구를 비교하는 GRPO 그룹 비교를 기록하려는 시점. 비교 조건이 동등하지 않으면 학습 데이터가 오염된다.
**Ask**: "이번 그룹 비교가 **동일 작업·통제된 조건**에서 수행되었나요?"
**Options**:
1. Record comparison — 비교 결과를 기록하고 GRPO 점수 업데이트
2. Discard — 조건이 불균등하여 이번 비교 결과를 폐기
**Default**: 1 (도구 비교가 동일 입력으로 수행된 경우)
**Skippable**: No — 기록 또는 폐기를 명시적으로 결정해야 함
**Freedom**: MEDIUM

### Self-check 3: 데이터 정리 결과 확인 (After Step 6)
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

> 위 표의 `Record GRPO comparison` · `Update scores` 2행은 은퇴한 GRPO 층의 단계라 현재 적용되지 않는다(역사 기록). 나머지 4행은 Toolformer 층의 단계로 남는다(`suggestTool` 은 프로덕션 호출자가 없다 — 위 Architecture 주석).

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

## Rationalizations
> 이 절은 참고 자료다 — 아래 변명·반박은 모델이 작업 중 스스로 지름길을 점검하는 데 쓰고, 사용자에게 묻는 질문 목록이나 별도 게이트로 쓰지 않는다. 반박에 비추어 스스로 바로잡을 수 없으면 이 스킬의 Step·Checkpoint 규칙을 따른다.

The following table captures common excuses agents make to skip the discipline of this skill, paired with factual rebuttals.

| Excuse | Rebuttal |
|--------|----------|
| "tool selection is obvious" | obvious today is stale tomorrow — tool landscape shifts and learned success rates track it |
| "Toolformer-style learning needs huge datasets" | even 50 rollouts per tool produces usable success-rate estimates; the dataset excuse is folklore |
| "GRPO is research, not production" | (역사: 이 스킬의 tool-selection GRPO 층은 4.27.0 에서 삭제돼 건너뛸 단계가 없다.) GRPO is just group-relative scoring; the math fits on a napkin and runs in <1ms |
| "context-aware tool choice is over-engineering" | generic tool choice wastes 30%+ of calls on wrong tools; context-awareness is the ROI move |
| "I'll hardcode the tool policy" | hardcoded policies can't adapt; learned policies improve with every session |
