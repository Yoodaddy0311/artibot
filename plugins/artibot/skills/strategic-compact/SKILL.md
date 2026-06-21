---
context: fork
name: strategic-compact
description: |
  Context compaction timing strategy — suggests WHEN to trigger compaction based on context usage patterns.
  Auto-activates when: context >75%, PreCompact triggered, long sessions, multi-phase tasks.
  Triggers: strategic compact, context strategy, compress timing, long session, context window, memory pressure
  See also: compaction-survival (정보 보존 전략)
lang: [en, ko]
platforms: [claude-code, gemini-cli, codex-cli, cursor]
level: 2
triggers:
  - "strategy"
  - "strategic compact"
  - "executive summary"
  - "strategic plan"
  - "priorities"
  - "OKR"
agents:
  - "architect"
tokens: "~2K"
category: "analysis"
source_hash: 20062e8f
whenNotToUse: "Do not trigger strategic compaction below the yellow zone (60% context usage) or during active multi-file edits where task state is partially committed. Compacting mid-transaction loses the uncommitted state that the agent needs to complete the current operation."
---
# Strategic Compaction

## When This Skill Applies
- Context window usage exceeds 75% (yellow zone)
- PreCompact hook event triggered
- Long sessions with accumulated context
- Multi-phase tasks requiring context preservation

## Core Guidance

**Compaction Priority**:
1. **Preserve**: Active task state, uncommitted decisions, current file context
2. **Summarize**: Completed task results, analysis findings, resolved issues
3. **Drop**: Exploratory searches, failed attempts, superseded plans

**Context Zones**:
| Zone | Usage | Action |
|------|-------|--------|
| Green | 0-60% | Normal operation |
| Yellow | 60-75% | Enable --uc, suggest compaction |
| Orange | 75-85% | Active compression, defer non-critical |
| Red | 85-95% | Force efficiency, essential ops only |
| Critical | 95%+ | Emergency protocols |

### Claude Opus 4.8 (1M 컨텍스트) 전략
4.8은 1M 토큰을 표준 가격으로 제공하므로 **지연 컴팩션** 가능.
- 400k 토큰 미만: 컴팩션 보류 (성능 페널티 없음)
- 400k-700k: 주의 — 다음 휴지기에 `/checkpoint` 권장
- 700k-900k: 즉시 컴팩션 실행, 또는 `/load`를 `--full-context` 없이 재호출
- 900k+: 긴급 — compaction-survival 트리거

주의: 신 토크나이저는 동일 텍스트를 최대 1.35배 토큰으로 소비 → 실제 효용 컨텍스트는 ~740k-1M.

**Compaction Process**:
1. Checkpoint: save current task state before compaction
2. Classify: sort context into preserve/summarize/drop
3. Compress: apply token-efficient formatting to preserved content
4. Validate: verify essential context survives compaction
5. Resume: continue work with compressed context

**Token Efficiency Integration**:
- Auto-enable `--uc` in yellow zone
- Use symbol system for status tracking
- Abbreviate repeated technical terms
- Tables and bullets over prose

## Output Template

```
STRATEGIC COMPACTION REPORT
============================
Session:    [session ID or date]
Zone:       [GREEN | YELLOW | ORANGE | RED | CRITICAL]
Usage:      [current %] -> [target % after compaction]

CONTEXT TRIAGE
──────────────
PRESERVE (active, uncommitted, critical)
  [1] [context item]: [why essential]
  [2] ...

SUMMARIZE (completed, resolved, reference)
  [1] [context item] -> Summary: [1-line compressed version]
  [2] ...

DROP (exploratory, superseded, failed)
  [1] [context item]: [why safe to drop]
  [2] ...

TRADE-OFFS
──────────
Kept           | Dropped        | Rationale
───────────────|────────────────|──────────────────
[context A]    | [context X]    | [A is active, X is resolved]
[context B]    | [context Y]    | [B blocks task, Y is reference-only]

CANNOT DROP (non-negotiable context)
────────────────────────────────────
[1] [item]: [consequence if lost]
[2] ...

WILL NOT PRESERVE (explicit exclusions)
───────────────────────────────────────
[1] [item]: [why not worth the token cost]
[2] ...

COMPACTION RESULT
─────────────────
Before:  [n] tokens (~[%] context)
After:   [n] tokens (~[%] context)
Savings: [n] tokens ([%] reduction)
Quality: [% information preserved]

SURVIVAL VALIDATION
───────────────────
Check                              | Status
───────────────────────────────────|────────
Active task state preserved?       | [PASS|FAIL]
Uncommitted decisions intact?      | [PASS|FAIL]
Current file context available?    | [PASS|FAIL]
Recovery possible from compacted?  | [PASS|FAIL]
```


## Workflow Checklist

Copy this checklist and track progress:

```
Progress:
- [ ] Step 1: Detect context zone (green/yellow/orange/red/critical)
- [ ] Step 2: Checkpoint — save current task state before compaction
- [ ] Step 3: Classify context into preserve / summarize / drop
- [ ] Step 4: Compress preserved content with token-efficient formatting
- [ ] Step 5: Validate essential context survives compaction
- [ ] Step 6: Resume work with compressed context
```

## Human Checkpoints

### Checkpoint 1: 컨텍스트 존 평가 확인 (After Step 1)
**Context**: 현재 컨텍스트 사용량이 자동으로 측정되어 존(Green/Yellow/Orange/Red/Critical)이 판단된 시점. 존 판단이 틀리면 너무 이른 압축 또는 너무 늦은 압축으로 이어질 수 있다.
**Ask**: "현재 **컨텍스트 존 판단이 정확**한가요?"
**Options**:
1. Confirm zone — 판단된 존을 수용하고 해당 존 액션으로 진행
2. Override assessment — 다른 존으로 수동 조정
**Default**: 1 (자동 측정값이 신뢰할 수 있는 경우)
**Skippable**: No — 존 확인 또는 오버라이드를 명시적으로 결정해야 함
**Freedom**: LOW

### Checkpoint 2: 분류 결과 검토 (After Step 3)
**Context**: 컨텍스트 항목들이 preserve/summarize/drop 세 범주로 분류된 시점. 자동 분류는 판단 오류가 있을 수 있으며, 진행 중인 작업에 필요한 항목이 잘못 분류되면 복구가 어렵다.
**Ask**: "**preserve/summarize/drop 분류가 현재 작업에 적합**한가요?"
**Options**:
1. Approve — 분류 결과를 승인하고 압축 단계로 진행
2. Move items between categories — 일부 항목의 범주를 조정하고 재확인
3. Restart classification — 분류를 처음부터 다시 수행
**Default**: 1 (분류 기준이 명확하게 적용된 경우)
**Skippable**: Yes (skip 시 Approve로 처리)
**Freedom**: HIGH

### Checkpoint 3: 압축 후 필수 컨텍스트 생존 검증 (After Step 5)
**Context**: 압축이 완료되어 보존 대상 컨텍스트가 토큰 효율적 형식으로 변환된 시점. 필수 정보가 소실되면 작업을 재개할 수 없으므로 재개 전 반드시 확인해야 한다.
**Ask**: "압축 후 **작업 재개에 필요한 필수 컨텍스트가 모두 살아있나요**?"
**Options**:
1. Resume — 필수 컨텍스트가 보존됨을 확인, 압축된 상태로 작업 재개
2. Re-expand critical context — 손실된 필수 항목을 복원한 후 재개
**Default**: 1 (검증 체크리스트를 통과한 경우)
**Skippable**: No — 재개 또는 복원 후 재개를 명시적으로 결정해야 함
**Freedom**: LOW

## Freedom Levels

| Step | Freedom | Guidance |
|------|:-------:|----------|
| Detect zone | LOW | Thresholds are defined (60/75/85/95%) |
| Checkpoint | LOW | Must always checkpoint before compaction |
| Classify context | HIGH | Judgment call on what to preserve vs summarize vs drop |
| Compress content | MEDIUM | Techniques defined (symbols, tables), application is flexible |
| Validate survival | LOW | Essential context must be verified present |
| Resume work | MEDIUM | Re-orientation approach depends on task state |

**Anti-Patterns**: Waiting until critical zone, compacting without preserving task state, dropping context needed for in-progress decisions

## Output Template

```
COMPACTION CHECKPOINT
=====================
Session:    [session context summary]
Phase:      [current work phase]
Date:       [date]

PRESERVED CONTEXT
-----------------
Category         | Items | Key Details
-----------------|-------|---------------------------
Active decisions | [n]   | [list of active decisions]
Pending work     | [n]   | [list of pending items]
Key constraints  | [n]   | [list of constraints]
File state       | [n]   | [files in progress]

SAFE TO COMPACT
---------------
- [completed work item that can be compressed]
- [resolved decision that can be summarized]

COMPACTION RECOMMENDATION
-------------------------
Action     | Reason              | Risk
-----------|---------------------|------
[compact/wait/checkpoint] | [reason] | [LOW/MEDIUM/HIGH]
```

## Quick Reference
- Act at yellow zone (60-75%), not red
- Always checkpoint before compaction
- Preserve > Summarize > Drop
- Essential: active tasks, uncommitted decisions, current files

## Rationalizations

The following table captures common excuses agents make to skip the discipline of this skill, paired with factual rebuttals.

| Excuse | Rebuttal |
|--------|----------|
| "auto-compact is enough" | auto-compaction triggers at 75% — you've already lost control of what gets compressed |
| "compacting mid-task saves tokens" | mid-task compaction loses the task state you needed to complete it |
| "I'll compact at phase boundaries" | phase boundaries are exactly right — but only if you ACTUALLY compact, not just plan to |
| "compaction costs more tokens than it saves" | a good compact summary is 10% of the raw content it replaces; the math is decisive |
| "I don't know what to preserve" | preserve file paths, decisions, and open questions — everything else is re-derivable |

## Common Rationalizations

| Rationalization | Why it's wrong | What to do instead |
|---|---|---|
| "Compaction loses context so I'll avoid it as long as possible" | Waiting until the critical zone (95%+) means Claude triggers auto-compaction with no control over what is preserved; proactive compaction at yellow zone preserves task state intentionally | Monitor the context zone and compact at orange (75%) before auto-compaction fires |
| "The classify step is subjective, I'll just compress everything" | Compressing everything removes the preserve/summarize/drop distinction; important active task state gets summarized the same as completed exploratory work | Spend 2 minutes on the classify step — the triage is what makes the compaction recoverable |
| "Checkpoint before compaction is bureaucratic overhead" | Checkpoint takes one `saveMemory` call; without it, a failed compaction loses all task state with no recovery path | Write the checkpoint before every compaction, not after; it is the insurance policy |
| "I'll compact mid-task to save tokens during a long refactor" | Mid-task compaction loses the intermediate state that connects earlier decisions to current code; the next agent turn cannot reconstruct the reasoning chain | Complete the current atomic operation (one file, one function) before compacting |
| "Auto-compact is smart enough to preserve what matters" | Auto-compact applies a generic priority heuristic that does not know your task's specific critical context; it optimizes for recency and token count, not semantic importance | Use strategic compaction for tasks with domain-specific preserve requirements; reserve auto-compact for exploratory sessions |

## Red Flags

- Context zone entering red (85%) without a compaction checkpoint in the current session
- Task state not saved before any compaction event
- Compaction triggered during an active multi-file edit with uncommitted changes
- Validate step skipped after compaction (no confirmation that active task context survived)
- Compaction report shows 0% information preserved for the "active tasks" category
- Context repeatedly hitting critical zone in the same session without a compaction strategy change
