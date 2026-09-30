---
context: fork
name: evolution-loop
description: |
  Artibot Evolution Loop — conceptual guide to the continuous self-improvement cycle
  that drives pattern extraction, skill refinement, and collective intelligence growth.
  Use as reference when configuring, understanding, or extending Artibot's autonomous
  learning system.
  Triggers: evolution, self-improve, learning loop, pattern extract, skill refine, 진화, 학습루프
platforms: [claude-cowork, claude-code]
level: 2
triggers:
  - "evolution"
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

> **Status (2026-09-29)** — 이 가이드에서 **GRPO 를 서술한 부분**(5단계 "GRPO", "GRPO in Plain Terms", 스케줄의 "GRPO Training", Cowork 참여 1번의 "GRPO 학습에 영향")은 은퇴했다: GRPO 옵티마이저·정책 트레이너는 CLI 플러그인에서 2026-06-20 에 삭제됐다(`artibot.config.json` 의 `learning.grpoRouting.comment`). 오늘 남은 GRPO 계열은 세션 종료 배치 학습의 **그룹 내 규칙 기반 랭킹**(CLI 플러그인 `plugins/artibot/lib/learning/pattern-analyzer.js#grpoRankGroup`)이며, 모델을 학습시키지 않고 경험을 순위 매겨 패턴 파일을 만든다. 실제 세션 종료 파이프라인(`lib/learning/evolution-loop.js`)은 compress → knowledge graph → skill 평가 → auto-research → 집단 허브 기여 → 실패 분류이고 GRPO 단계가 없다. 해당 서술은 역사 기록으로 보존한다.

## When This Skill Applies
- Understanding how Artibot learns and self-improves over time
- Configuring the learning pipeline (nightly schedule, thresholds; GRPO settings: retired)
- Interpreting pattern extraction outputs (GRPO training results: retired)
- Planning how to extend or customize the evolution loop for your workflow

## Core Guidance

### What Is the Evolution Loop?

The evolution loop is Artibot's autonomous improvement cycle. It continuously extracts patterns from usage, ranks them by effectiveness, trains the model's preferences (GRPO) *(retired — 위 Status 참조)*, and promotes the best patterns into System 1 (fast, intuitive responses).

```
Session Data → Pattern Extract → Quality Score → GRPO Training → Knowledge Update
                                                                       |
System 1 Promotion ← Skill Refinement ← Swarm Merge ←----------------+
```

> 도식의 `GRPO Training` 단계는 은퇴했다 — 위 Status 참조.

### Five Stages

| Stage | Description | Output |
|-------|-------------|--------|
| **1. Self-Scan** | Analyze recent session data: tool usage, errors, team compositions | Raw pattern candidates |
| **2. Pattern Extract** | Score candidates by frequency, success rate, and novelty | Ranked pattern list |
| **3. Knowledge Update** | Merge high-confidence patterns into the knowledge base | Updated knowledge store |
| **4. Skill Refinement** | Auto-update SKILL.md files with improved guidance based on real usage | Refined skill content |
| **5. GRPO** *(retired)* | Group Relative Policy Optimization — train preference ranking across response variants | Updated model weights |

> 5단계(GRPO)는 은퇴했다 — 위 Status 참조.

### GRPO in Plain Terms

> **Retired (2026-06-20)** — 아래 설명은 GRPO 라는 일반 기법의 소개로만 읽는다. GRPO 옵티마이저·정책 트레이너는 삭제됐고(위 Status), 남은 것은 세션 종료 배치 학습의 그룹 내 규칙 기반 랭킹뿐이다 — 모델의 기본 행동을 바꾸는 학습이 아니다. 아래 "In Artibot's context" 문단은 역사 기록으로 보존한다.

GRPO (Group Relative Policy Optimization) is a reinforcement learning technique that:
1. Generates multiple response variants for the same prompt
2. Scores each variant by outcome quality (task completion, user satisfaction)
3. Updates preferences to favor high-scoring responses over low-scoring ones
4. Repeats across thousands of examples to shift the model's default behavior

**In Artibot's context**: GRPO trains on tool usage sequences, team orchestration patterns, and skill selection decisions — making the model better at knowing *when* and *how* to use each skill.

### Collective Hub Scoring

Patterns are scored before GRPO training (retired) to filter noise. See `references/collective-hub-scoring.md` for the full algorithm.

| Metric | Weight | Description |
|--------|--------|-------------|
| Frequency | 30% | How often the pattern appears in sessions |
| Success Rate | 40% | Fraction of uses that led to positive outcomes |
| Novelty | 15% | How different from existing patterns (avoids duplicates) |
| Confidence | 15% | Statistical confidence from sample size |

**Minimum threshold**: Score ≥ 0.75 required for GRPO training inclusion. *(GRPO training: retired — 위 Status 참조)*

### Schedule (CLI Default)

```
Self-Scan + Pattern Extract + Knowledge Update:  nightly at 03:00 (cron: 0 3 * * *)
GRPO Training:                                   on-demand or when pattern count ≥ 50   (retired)
Swarm Sync:                                      session start/end (if opted in)
Self-Benchmark:                                  weekly Monday at 04:00
```

### Cowork Participation

In Cowork, code execution is not available, so the full automated loop runs only in the CLI variant. However, Cowork users participate through:

1. **Swarm contribution**: When opted in, your session patterns join the global pool and influence GRPO training across all instances *(GRPO training: retired — 위 Status 참조)*
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

~~**GRPO**: Group Relative Policy Optimization — preference training over response variants~~ — 은퇴(2026-06-20), 위 Status 참조
**Pattern threshold**: Score ≥ 0.75 (frequency 30% + success 40% + novelty 15% + confidence 15%)
**CLI schedule**: nightly 03:00 (UTC+9)
**Cowork role**: passive participant via swarm opt-in + manual skill encoding
**Full reference**: `references/collective-hub-scoring.md`
