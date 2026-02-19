---
name: lifelong-learning
description: |
  Continuous learning pipeline that captures session experiences, performs batch learning via GRPO,
  and transfers validated knowledge between System 1 and System 2 caches.
  Runs automatically at session end via the nightly-learner hook.
  Triggers: learn, experience, knowledge, transfer, promote, demote, grpo, batch, pattern, memory
platforms: [claude-code, gemini-cli, codex-cli, cursor]
level: 2
triggers:
  - "learn"
  - "improve"
  - "skill development"
  - "knowledge"
  - "growth"
  - "continuous improvement"
agents:
  - "planner"
tokens: "~2K"
category: "learning"
---

# Lifelong Learning

## When This Skill Applies
- Session end (automatic via nightly-learner hook)
- Pattern discovery during routing decisions
- Knowledge transfer between System 1 and System 2
- Periodic consolidation of routing experience
- Manual learning triggers via `/learn` command

## Core Guidance

### 1. Learning Pipeline

```
Session Experiences
        |
        v
+------------------+
| Experience       |  Collect routing decisions + outcomes
| Collector        |  during the session
+--------+---------+
         |
         v
+------------------+
| Batch Learner    |  Process experiences in batches (size: 50)
| (GRPO)           |  Group Relative Policy Optimization
+--------+---------+
         |
         v
+------------------+
| Knowledge        |  Promote/demote patterns between
| Transfer         |  System 1 and System 2 caches
+--------+---------+
         |
         v
+------------------+
| Persistence      |  Save updated caches to disk
| Layer            |  ~/.claude/artibot-learning/
+------------------+
```

### 2. Experience Collection

Each routing decision is recorded as an experience entry:

| Field | Type | Description |
|-------|------|-------------|
| `input` | string | User request (anonymized) |
| `complexity` | number | Computed complexity score |
| `routed_to` | string | "system1" or "system2" |
| `outcome` | string | "success", "escalated", "failed" |
| `latency_ms` | number | Processing time |
| `confidence` | number | Router confidence at decision time |
| `timestamp` | string | ISO timestamp |

### 3. GRPO (Group Relative Policy Optimization)

Batch learning algorithm that groups similar experiences and optimizes routing thresholds:

```
1. Group experiences by domain + complexity range (group size: 5)
2. For each group:
   a. Calculate success rate per routing decision
   b. Compare System 1 vs System 2 outcomes
   c. Compute relative advantage: advantage = s2_success - s1_success
3. Update routing threshold:
   - If System 2 consistently better -> lower threshold (more System 2)
   - If System 1 reliably handles -> raise threshold (more System 1)
4. Adjustment step: adaptRate * advantage (clamped to [-0.1, 0.1])
```

| Parameter | Default | Description |
|-----------|---------|-------------|
| `batchSize` | 50 | Experiences per batch |
| `grpoGroupSize` | 5 | Experiences per comparison group |

### 4. Knowledge Transfer

Validated patterns move between System 1 and System 2 caches:

#### Promotion (System 2 -> System 1)
- Pattern succeeds `promotionThreshold` (3) consecutive times in System 2
- Confidence consistently > 0.8
- Action: Cache pattern in System 1 for fast retrieval

#### Demotion (System 1 -> System 2)
- Pattern fails `demotionThreshold` (2) consecutive times in System 1
- Confidence drops below minConfidence
- Action: Remove from System 1 cache, flag for System 2 analysis

```
System 2 Cache                              System 1 Cache
+-------------------+    promote (3x)     +-------------------+
| Complex patterns  | =================> | Fast patterns     |
| Deep analysis     |                    | Cached heuristics |
| New discoveries   | <================= | Quick matches     |
+-------------------+    demote (2x)     +-------------------+
```

### 5. Knowledge Transfer Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `promotionThreshold` | 3 | Consecutive successes to promote |
| `demotionThreshold` | 2 | Consecutive failures to demote |

### 6. Persistence

Learning state is saved to `~/.claude/artibot-learning/`:

```
~/.claude/artibot-learning/
  +-- experiences.jsonl      # Raw experience log (append-only)
  +-- system1-cache.json     # Promoted fast patterns
  +-- system2-cache.json     # Complex pattern registry
  +-- thresholds.json        # Adaptive threshold state
  +-- transfer-log.json      # Promotion/demotion history
```

### 7. Integration with Cognitive Routing

The lifelong learning system feeds back into the cognitive router:
- Updated thresholds are loaded at session start
- Promoted patterns are available to System 1 immediately
- Demoted patterns are flagged for System 2 re-evaluation
- Transfer history informs meta-cognitive monitoring

## Configuration

Settings in `artibot.config.json` under `learning.lifelong` and `learning.knowledgeTransfer`:

```json
{
  "learning": {
    "lifelong": { "batchSize": 50, "grpoGroupSize": 5 },
    "knowledgeTransfer": { "promotionThreshold": 3, "demotionThreshold": 2 }
  }
}
```

## Quick Reference

**Learning Cycle**: Collect -> Batch (GRPO) -> Transfer -> Persist
**Promotion**: 3 consecutive System 2 successes -> System 1 cache
**Demotion**: 2 consecutive System 1 failures -> System 2 re-analysis
**Storage**: `~/.claude/artibot-learning/`
