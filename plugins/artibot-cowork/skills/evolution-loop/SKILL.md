---
context: fork
name: evolution-loop
description: |
  Artibot Evolution Loop — conceptual guide to the continuous self-improvement cycle
  that drives GRPO-based learning, pattern extraction, skill refinement, and collective
  intelligence growth. Use as reference when configuring, understanding, or extending
  Artibot's autonomous learning system.
  Triggers: evolution, GRPO, self-improve, learning loop, pattern extract, skill refine, 진화, 학습루프
platforms: [claude-cowork, claude-code]
level: 2
triggers:
  - "evolution"
  - "GRPO"
  - "self-improve"
  - "learning loop"
  - "pattern extract"
  - "skill refinement"
  - "진화"
  - "학습루프"
agents:
  - "orchestrator"
tokens: "~2K"
category: "learning"
---

# Evolution Loop

## When This Skill Applies
- Understanding how Artibot learns and self-improves over time
- Configuring the learning pipeline (nightly schedule, thresholds, GRPO settings)
- Interpreting GRPO training results or pattern extraction outputs
- Planning how to extend or customize the evolution loop for your workflow

## Core Guidance

### What Is the Evolution Loop?

The evolution loop is Artibot's autonomous improvement cycle. It continuously extracts patterns from usage, ranks them by effectiveness, trains the model's preferences (GRPO), and promotes the best patterns into System 1 (fast, intuitive responses).

```
Session Data → Pattern Extract → Quality Score → GRPO Training → Knowledge Update
                                                                       |
System 1 Promotion ← Skill Refinement ← Swarm Merge ←----------------+
```

### Five Stages

| Stage | Description | Output |
|-------|-------------|--------|
| **1. Self-Scan** | Analyze recent session data: tool usage, errors, team compositions | Raw pattern candidates |
| **2. Pattern Extract** | Score candidates by frequency, success rate, and novelty | Ranked pattern list |
| **3. Knowledge Update** | Merge high-confidence patterns into the knowledge base | Updated knowledge store |
| **4. Skill Refinement** | Auto-update SKILL.md files with improved guidance based on real usage | Refined skill content |
| **5. GRPO** | Group Relative Policy Optimization — train preference ranking across response variants | Updated model weights |

### GRPO in Plain Terms

GRPO (Group Relative Policy Optimization) is a reinforcement learning technique that:
1. Generates multiple response variants for the same prompt
2. Scores each variant by outcome quality (task completion, user satisfaction)
3. Updates preferences to favor high-scoring responses over low-scoring ones
4. Repeats across thousands of examples to shift the model's default behavior

**In Artibot's context**: GRPO trains on tool usage sequences, team orchestration patterns, and skill selection decisions — making the model better at knowing *when* and *how* to use each skill.

### Collective Hub Scoring

Patterns are scored before GRPO training to filter noise. See `references/collective-hub-scoring.md` for the full algorithm.

| Metric | Weight | Description |
|--------|--------|-------------|
| Frequency | 30% | How often the pattern appears in sessions |
| Success Rate | 40% | Fraction of uses that led to positive outcomes |
| Novelty | 15% | How different from existing patterns (avoids duplicates) |
| Confidence | 15% | Statistical confidence from sample size |

**Minimum threshold**: Score ≥ 0.75 required for GRPO training inclusion.

### Schedule (CLI Default)

```
Self-Scan + Pattern Extract + Knowledge Update:  nightly at 03:00 (cron: 0 3 * * *)
GRPO Training:                                   on-demand or when pattern count ≥ 50
Swarm Sync:                                      session start/end (if opted in)
Self-Benchmark:                                  weekly Monday at 04:00
```

### Cowork Participation

In Cowork, code execution is not available, so the full automated loop runs only in the CLI variant. However, Cowork users participate through:

1. **Swarm contribution**: When opted in, your session patterns join the global pool and influence GRPO training across all instances
2. **Manual skill refinement**: Use `/sdk create-skill` to encode discovered best practices as new skills
3. **Pattern observation**: Notice recurring patterns in your workflow → document them as skill references

### Auto-Safety Controls

The evolution loop includes safeguards to prevent runaway changes:

| Control | Threshold | Action |
|---------|-----------|--------|
| Emergency Kill Switch | 3+ failures/hour | Halt all auto-operations |
| Auto-Commit Risk Gate | risk level ≤ low | Skip commit if medium/high risk |
| Skill Staging Period | 1 day minimum | New skills staged before promotion |
| Min Confidence | 0.85 | Patterns below threshold are not promoted |
| Macro Rejection Window | 30 days | Rejected patterns blocked from re-suggestion |

## Quick Reference

**GRPO**: Group Relative Policy Optimization — preference training over response variants
**Pattern threshold**: Score ≥ 0.75 (frequency 30% + success 40% + novelty 15% + confidence 15%)
**CLI schedule**: nightly 03:00 (UTC+9)
**Cowork role**: passive participant via swarm opt-in + manual skill encoding
**Full reference**: `references/collective-hub-scoring.md`
