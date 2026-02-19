# Artibot Innovation Architecture / 혁신 아키텍처

This document describes the unique technical innovations in Artibot that differentiate it from conventional AI orchestration frameworks such as MoAI (Mixture of AI), bkit-claude-code, and other Claude Code plugins.

---

## Table of Contents

1. [Innovation Summary](#innovation-summary)
2. [Kahneman System 1/2 Cognitive Routing](#1-kahneman-system-12-cognitive-routing)
3. [GRPO Self-Learning](#2-grpo-self-learning)
4. [Knowledge Transfer (System 2 to System 1 Promotion)](#3-knowledge-transfer)
5. [Federated Swarm Intelligence with PII Protection](#4-federated-swarm-intelligence)
6. [Adaptive Threshold](#5-adaptive-threshold)
7. [BlenderBot-Inspired Memory RAG](#6-blenderbot-inspired-memory-rag)
8. [Toolformer + GRPO Tool Selection](#7-toolformer--grpo-tool-selection)
9. [Self-Rewarding Evaluation](#8-self-rewarding-evaluation)
10. [Comparative Analysis](#comparative-analysis)

---

## Innovation Summary / 혁신 요약

| Innovation | Inspired By | Key Mechanism | Unique to Artibot |
|-----------|-------------|---------------|-------------------|
| Cognitive Routing | Kahneman (2011) | 5-factor complexity scoring | Yes |
| GRPO Self-Learning | DeepSeek GRPO (2024) | Rule-based group relative ranking | Yes (no external judge) |
| Knowledge Transfer | Cognitive science | Hot-swap promotion/demotion | Yes |
| Federated Swarm | Federated Learning + DP | PII scrub + noise injection | Yes |
| Adaptive Threshold | Reinforcement learning | Success streak feedback | Yes |
| Memory RAG | BlenderBot (Meta) | 3-scope hierarchical memory | Yes |
| Tool Selection | Toolformer (Meta, 2023) | GRPO-enhanced tool ranking | Yes |
| Self-Rewarding | Self-Rewarding LLM (Meta, 2024) | 4-dimension quality scoring | Yes |

---

## 1. Kahneman System 1/2 Cognitive Routing / 인지 라우팅

### Background / 배경

Daniel Kahneman's *Thinking, Fast and Slow* (2011) describes two cognitive systems:

- **System 1**: Fast, automatic, intuitive. Handles familiar patterns with minimal effort.
- **System 2**: Slow, deliberate, analytical. Engages for novel, complex, or risky decisions.

Most AI orchestration frameworks use a single processing mode for all requests, regardless of complexity. This wastes resources on simple tasks and underperforms on complex ones.

### Artibot's Implementation / 구현

Artibot applies Kahneman's dual-process theory to request routing:

```
Input: "fix typo in readme"
  -> Complexity: 0.12 (low steps, single domain, no risk)
  -> System 1 (pattern match, < 100ms, confidence 0.94)

Input: "refactor auth system, migrate DB, deploy to production"
  -> Complexity: 0.78 (high steps, 3 domains, high risk)
  -> System 2 (sandbox analysis, multi-step reasoning)
```

### Multi-Factor Complexity Scoring

Unlike simple keyword-based routing, Artibot uses a weighted 5-factor model:

```javascript
const WEIGHTS = {
  steps:        0.25,   // Estimated operation count
  domains:      0.20,   // Number of technical domains
  uncertainty:  0.20,   // Ambiguity/question signals
  risk:         0.20,   // Production/destructive keywords
  novelty:      0.15,   // Deviation from recent patterns
};

// score = sum(factor_i * weight_i), clamped to [0, 1]
// if score < threshold -> System 1
// if score >= threshold -> System 2
```

Each factor has its own estimator function that analyzes the input text across three languages (en/ko/ja), producing a normalized score in [0, 1].

### Why This Matters / 이것이 중요한 이유

| Aspect | Single-Mode Systems | Artibot Dual-Process |
|--------|-------------------|---------------------|
| Simple tasks | Overthinks, slow | System 1: instant response |
| Complex tasks | Under-analyzes | System 2: deep reasoning |
| Resource usage | Uniform high | Adaptive to complexity |
| Response time | Uniform | < 100ms for System 1 |
| Error recovery | Fixed | Adaptive threshold learns |

**Implementation**: `lib/cognitive/router.js` (559 lines)

---

## 2. GRPO Self-Learning / GRPO 자기학습

### Background / 배경

Group Relative Policy Optimization (GRPO), introduced by DeepSeek in 2024, replaces the traditional critic model in reinforcement learning with group-relative comparisons. Instead of training a separate "judge" model, GRPO generates multiple candidates and ranks them relative to each other within the group.

Most AI orchestration tools either do not learn at all, or depend on external AI services for evaluation. Artibot implements GRPO with **deterministic, rule-based evaluation** -- no external judge AI is needed.

### Artibot's Implementation / 구현

```
Phase 1: Candidate Generation
  Task: "implement login API"
  -> Generate 5 strategy candidates:
     [balanced, thorough, rapid, parallel, iterative]

Phase 2: Rule-Based Evaluation
  After execution, each candidate is scored:
  - exitCode:     0 or 1 (binary success)
  - errorFree:    0 or 1 (zero errors?)
  - speed:        1 / (1 + duration/1000)
  - brevity:      1 / (1 + commandLength/50)
  - sideEffects:  0.5 or 1.0

Phase 3: Group Ranking
  Sort by composite score (average of all rules)
  Rank 1 = best, Rank N = worst

Phase 4: Weight Update
  For each candidate:
    advantage = 1 - 2*(rank-1)/(N-1)    // [+1 .. -1]
    weight += learningRate * advantage * composite
  Weights persist in ~/.claude/artibot/grpo-history.json
```

### GRPO for Team Composition

Artibot extends GRPO beyond individual strategies to **team composition optimization**:

```
For task domain "security":
  Generate team candidates:
    - Solo (0 teammates)
    - Leader (3: security-reviewer, code-reviewer, architect)
    - Council (3: same agents, discussion mode)
    - Swarm (5: broader team, parallel)
    - Pipeline (4: sequential chain)

  Evaluate after execution:
    - successRate:  successCount / taskCount
    - efficiency:   1 / (1 + duration/60000)
    - resourceUse:  1 / (1 + teamSize/5)
    - completeness: completedCount / taskCount

  Update weights keyed by "pattern|size|domain"
```

This means Artibot learns, for example, that "security audits work best with a Council pattern of 3 agents" based on accumulated evidence.

### Why This Matters / 이것이 중요한 이유

| Aspect | Static Plugins | Artibot GRPO |
|--------|---------------|--------------|
| Strategy selection | Fixed rules | Learned from outcomes |
| Team sizing | Manual config | Auto-optimized per domain |
| External dependencies | Judge AI needed | Zero -- rule-based |
| Improvement | Manual tuning | Automatic weight updates |

**Implementation**: `lib/learning/grpo-optimizer.js` (502 lines)

---

## 3. Knowledge Transfer / 지식 전달

### Background / 배경

In cognitive science, expertise develops when deliberate reasoning (System 2) becomes automatic through practice and repetition (System 1). A chess master does not consciously analyze every move -- pattern recognition becomes intuitive.

Artibot implements this concept as a bidirectional knowledge transfer system between System 2 and System 1, with hot-swap capability for immediate effect.

### Promotion: System 2 -> System 1 / 승격

When a pattern processed by System 2 (deliberate reasoning) succeeds repeatedly:

```
Promotion Criteria:
  - consecutiveSuccesses >= 3
  - confidence > 0.8

Outcome:
  Pattern is added to System 1 fast-path cache
  -> Future similar inputs bypass System 2
  -> Response time drops from seconds to < 100ms
```

### Demotion: System 1 -> System 2 / 강등

When a System 1 pattern starts failing:

```
Demotion Criteria:
  - consecutiveFailures >= 2
  OR
  - usageCount >= 5 AND errorRate > 20%

Outcome:
  Pattern is removed from System 1 cache
  -> Future similar inputs go through System 2
  -> Quality prioritized over speed
```

### Hot-Swap Architecture

Knowledge transfer operates through an atomic hot-swap mechanism:

```
hotSwap():
  1. Acquire file-level lock (atomic mkdir)
  2. Scan all System 1 patterns for demotion criteria
  3. Scan all learned patterns for promotion candidates
  4. Execute all promotions and demotions atomically
  5. Persist updated System 1 cache to disk
  6. Release lock

Properties:
  - No restart required
  - File-level lock prevents concurrent corruption
  - Stale lock detection (auto-release after 30s)
  - In-memory cache updated immediately
```

### Why This Matters / 이것이 중요한 이유

No other Claude Code plugin implements automatic knowledge transfer between processing modes. The system creates a genuine learning loop: deliberate analysis produces patterns that become intuitive shortcuts, but failing shortcuts are automatically reverted to deliberate analysis.

**Implementation**: `lib/learning/knowledge-transfer.js` (612 lines)

---

## 4. Federated Swarm Intelligence / 연합 집단 지능

### Background / 배경

Federated Learning, introduced by Google (McMahan et al., 2017), enables multiple clients to collaboratively train a model without sharing raw data. Differential Privacy (Dwork, 2006) provides mathematical guarantees that individual contributions cannot be reverse-engineered.

Artibot combines these concepts with its PII scrubber to enable knowledge sharing across Artibot instances while providing multiple layers of privacy protection.

### Privacy Pipeline

```
Local Patterns (tool selections, strategies, team compositions)
         |
         v
┌────────────────────────────────────┐
│  Layer 1: PII Scrubber             │
│  50+ regex patterns:               │
│  - API keys    -> [REDACTED_KEY]   │
│  - Emails      -> [EMAIL]          │
│  - IP addresses -> [IP]            │
│  - File paths  -> [PATH]           │
│  - SSN/CC      -> [SSN]/[CC]      │
│  - Private keys -> [PRIVATE_KEY]   │
│  ... and 44+ more categories       │
│                                    │
│  Platform-aware:                   │
│  - Windows: C:\Users\* detection   │
│  - Unix: /home/* detection         │
│  - macOS: /Users/* detection       │
└────────────────┬───────────────────┘
                 v
┌────────────────────────────────────┐
│  Layer 2: Differential Privacy     │
│  Gradient noise injection:         │
│  - Random noise added to weights   │
│  - Individual contributions        │
│    cannot be reverse-engineered    │
│  - Only statistical deltas shared  │
└────────────────┬───────────────────┘
                 v
┌────────────────────────────────────┐
│  Layer 3: Integrity Verification   │
│  - SHA-256 checksum on upload      │
│  - SHA-256 verification on download│
│  - Max payload: 5MB               │
└────────────────┬───────────────────┘
                 v
         Swarm Server (aggregator)
                 |
                 v
         Aggregated global weights
         (delta download available)
```

### Offline Resilience

```
Network unavailable?
  -> Queue upload to ~/.claude/artibot/swarm-offline-queue.json
  -> Max 100 entries
  -> Auto-flush on next successful connection
  -> Exponential backoff retry (base 1s, max 3 retries)
  -> 4xx errors (except 429) are not retried
```

### Why This Matters / 이것이 중요한 이유

The combination of PII scrubbing + differential privacy + checksum verification provides defense-in-depth that no other Claude Code plugin offers for collaborative learning.

**Implementation**: `lib/swarm/swarm-client.js` (466 lines), `lib/privacy/pii-scrubber.js`

---

## 5. Adaptive Threshold / 적응형 임계값

### Mechanism / 메커니즘

The cognitive router's System 1/2 threshold is not static. It adapts based on outcome feedback using a simple but effective algorithm:

```
adaptThreshold(feedback):
  if System 1 FAILED:
    threshold -= adaptStep (default 0.05)
    -> More inputs routed to System 2 (safer)
    -> Success streak reset to 0

  if System 1 SUCCEEDED:
    successStreak++
    if successStreak >= 5:
      threshold += adaptStep
      -> More inputs stay in System 1 (faster)
      -> Success streak reset to 0

  Bounds: threshold clamped to [0.2, 0.7]
```

### Trend Detection

The router also detects long-term trends by comparing System 1 usage in the recent 20% of history vs. the earlier 80%:

```
if recentS1Ratio - earlyS1Ratio > 0.15:
  trend = "shifting_to_s1" (getting faster)

if recentS1Ratio - earlyS1Ratio < -0.15:
  trend = "shifting_to_s2" (getting more cautious)

else:
  trend = "stable"
```

### Why This Matters / 이것이 중요한 이유

Static thresholds cannot adapt to different users, projects, or evolving codebases. The adaptive threshold means Artibot becomes more efficient as it learns which types of requests it can handle quickly vs. which require deep analysis.

**Implementation**: `lib/cognitive/router.js`, `adaptThreshold()` function

---

## 6. BlenderBot-Inspired Memory RAG / BlenderBot 영감 메모리 RAG

### Background / 배경

Meta's BlenderBot (Roller et al., 2021) demonstrated the effectiveness of long-term memory in conversational AI by maintaining persistent knowledge across sessions. Retrieval-Augmented Generation (RAG) combines stored knowledge with real-time generation.

### Artibot's Three-Scope Memory Architecture

Artibot implements a hierarchical memory system inspired by BlenderBot's long-term memory, adapted for a development orchestration context:

```
┌──────────────────────────────────────────────┐
│  Session Memory (in-memory)                  │
│  - Current session patterns                  │
│  - Active tool selections                    │
│  - Recent routing decisions                  │
│  - Cleared on session exit                   │
│  Scope: single Claude Code session           │
└──────────────────┬───────────────────────────┘
                   v  promote on success
┌──────────────────────────────────────────────┐
│  Project Memory (.artibot/)                  │
│  - Project-specific patterns                 │
│  - Framework conventions learned             │
│  - Team compositions that worked             │
│  - Persists across sessions                  │
│  Scope: single project directory             │
└──────────────────┬───────────────────────────┘
                   v  promote on repeated success
┌──────────────────────────────────────────────┐
│  User Memory (~/.claude/artibot/)            │
│  - Universal patterns                        │
│  - Cross-project tool preferences            │
│  - GRPO strategy weights                     │
│  - System 1 promoted patterns                │
│  - Persists permanently                      │
│  Scope: all projects for this user           │
└──────────────────────────────────────────────┘
```

### Pattern Extraction and Retrieval

The Lifelong Learner module extracts patterns from session experiences and stores them in categorized pattern files:

```
~/.claude/artibot/patterns/
├── tool-patterns.json      # Best tool for each context
├── error-patterns.json     # Error recovery strategies
├── success-patterns.json   # Successful approach patterns
├── team-patterns.json      # Optimal team compositions
└── general-patterns.json   # Cross-domain patterns
```

These patterns are retrieved (RAG-style) and injected into agent prompts via the Context Injector (`lib/system/context-injector.js`), enriching each agent's context with learned knowledge.

### Why This Matters / 이것이 중요한 이유

| Aspect | No Memory | Simple File Cache | Artibot 3-Scope |
|--------|-----------|--------------------|-----------------|
| Cross-session learning | No | Partial | Full |
| Project-specific adaptation | No | No | Yes |
| Universal patterns | No | No | Yes (user scope) |
| Automatic promotion | No | No | Yes (Knowledge Transfer) |
| Pattern categories | No | No | 5 categories |

**Implementation**: `lib/learning/memory-manager.js`, `lib/learning/lifelong-learner.js`, `lib/system/context-injector.js`

---

## 7. Toolformer + GRPO Tool Selection / Toolformer + GRPO 도구 선택

### Background / 배경

Toolformer (Schick et al., Meta, 2023) demonstrated that language models can learn when and how to use external tools. Rather than hardcoding tool selection rules, Toolformer learns from experience which tools are most effective in which contexts.

### Artibot's Implementation / 구현

Artibot combines Toolformer's context-aware tool learning with GRPO's group-relative ranking:

```
Context Key Generation:
  "search:file"          -- searching within files
  "edit:typescript"      -- editing TypeScript code
  "analyze:security"     -- security analysis
  "build:react"          -- building React projects

For each context:
  1. Record tool usage: { tool, context, score, timestamp, command }
  2. Apply temporal decay (half-life: 7 days)
  3. When recommending tools:
     a. Filter history by context key
     b. Require minimum 3 samples
     c. Weight by recency (exponential decay)
     d. GRPO group comparison for tied candidates

GRPO Multi-Criteria Scoring:
  success:   0.35   -- Did the tool succeed?
  speed:     0.25   -- How fast was execution?
  accuracy:  0.25   -- How precise was the output?
  brevity:   0.15   -- How concise was the invocation?
```

### Example Learning Cycle

```
Session 1: User runs /analyze on TypeScript project
  -> Tool used: Grep for pattern search (success, 120ms)
  -> Tool used: Read for file content (success, 80ms)
  -> Tool used: Task for sub-agent analysis (success, 2400ms)
  -> Record: { context: "analyze:typescript", tools: [...], scores: [...] }

Session 5: Same context triggers tool recommendation
  -> Recommend: Grep (weighted score: 0.89)
  -> Alternative: Read (0.82), Task (0.65)
  -> Rationale: Grep is fastest for pattern search in TypeScript
```

### Why This Matters / 이것이 중요한 이유

Hardcoded tool selection rules cannot adapt to different project structures, codebases, or user workflows. Toolformer + GRPO learns optimal tool combinations from actual usage data, improving over time.

**Implementation**: `lib/learning/tool-learner.js`

---

## 8. Self-Rewarding Evaluation / 자기보상 평가

### Background / 배경

Meta's Self-Rewarding Language Models (Yuan et al., 2024) demonstrated that language models can effectively evaluate their own outputs, creating a self-improving feedback loop without human annotation.

### Artibot's Implementation / 구현

The Self Evaluator scores task results across 4 weighted dimensions:

```
Evaluation Dimensions:
  accuracy:      0.35   -- Correctness vs. requirements
  completeness:  0.25   -- Coverage of all requested aspects
  efficiency:    0.20   -- Resource usage and execution speed
  satisfaction:  0.20   -- Implicit user satisfaction signals

Composite Score = weighted_sum(dimension_scores)
```

### Feedback Loop Integration

Self-evaluation scores feed directly into the GRPO optimization pipeline:

```
Task Completed
     |
     v
Self Evaluator
  - Score each dimension [0, 1]
  - Compute weighted composite
  - Persist to evaluations.json
     |
     v
GRPO Pipeline
  - Use evaluation score as candidate result
  - Compare within strategy group
  - Update strategy weights
     |
     v
Knowledge Transfer
  - High-scoring patterns eligible for promotion
  - Low-scoring patterns eligible for demotion
```

### User Satisfaction Signals

Since Artibot cannot directly ask users for feedback, it infers satisfaction from implicit signals:

- **Positive signals**: User continues working (no correction), uses the same command again, no error follows
- **Negative signals**: User immediately re-runs with different parameters, explicitly says "that's wrong", error occurs
- **Neutral signals**: User moves to unrelated task

### Why This Matters / 이것이 중요한 이유

| Aspect | No Evaluation | Human Feedback | Self-Rewarding |
|--------|--------------|----------------|----------------|
| Scale | N/A | Limited by human time | Unlimited |
| Speed | N/A | Delayed | Immediate |
| Bias | N/A | Subjective | Consistent rules |
| Integration | N/A | Manual | Automatic into GRPO |

**Implementation**: `lib/learning/self-evaluator.js`

---

## Comparative Analysis / 비교 분석

### Artibot vs. Conventional Claude Code Plugins

| Capability | Artibot | bkit-claude-code | Standard Plugins |
|-----------|---------|------------------|-----------------|
| Orchestration | Native Agent Teams API | Task() sub-agents | Task() or none |
| Cognitive routing | System 1/2 dual-process | None | None |
| Self-learning | GRPO + Self-Rewarding | None | None |
| Knowledge transfer | Hot-swap promotion/demotion | None | None |
| Federated learning | Swarm + DP + PII scrub | None | None |
| Memory architecture | 3-scope hierarchical | File-based | Session only |
| Tool optimization | Toolformer + GRPO | Fixed rules | Fixed rules |
| Multi-language intent | en/ko/ja native | English only | English only |
| Runtime dependencies | 0 (Node.js built-in) | Variable | Variable |
| Privacy protection | 50+ PII patterns + DP | Limited | None |

### Artibot vs. MoAI (Mixture of AI)

| Aspect | Artibot | MoAI |
|--------|---------|------|
| **Architecture** | Plugin-native, zero deps | Framework-dependent |
| **Learning** | Autonomous (no external judge) | Requires external feedback |
| **Memory** | 3-scope with automatic promotion | Typically single scope |
| **Privacy** | Built-in PII + DP pipeline | Application-dependent |
| **Team communication** | P2P bidirectional (SendMessage) | Typically top-down |
| **Cognitive model** | Kahneman-inspired dual-process | Single processing mode |
| **Adaptation** | Continuous (adaptive threshold + GRPO) | Static configuration |

### Innovation Contribution Map

```
Cognitive Science                AI Research               Systems Design

Kahneman (2011) ──────> System 1/2 Router ──────> Adaptive Threshold
                                                  (session learning)

                        DeepSeek GRPO ──────────> Rule-Based GRPO
                        (2024)                    (no judge AI needed)

Expertise               Knowledge Transfer ─────> Hot-Swap Architecture
Development              (promotion/demotion)     (file-level lock)

Meta BlenderBot ────────> 3-Scope Memory ────────> Context Injection
(2021)                   (user/project/session)    (RAG for agents)

Meta Toolformer ────────> Tool Selection ────────> GRPO Tool Ranking
(2023)                   Learning                  (per-context)

Meta Self-Rewarding ───> Self Evaluation ────────> GRPO Feedback Loop
(2024)                   (4 dimensions)            (automatic)

Google Federated ──────> Swarm Intelligence ─────> PII + DP Pipeline
Learning (2017)          (pattern sharing)         (defense-in-depth)
```

Each innovation in Artibot draws from established research but adapts and combines these concepts in ways that are unique to the Claude Code plugin context. The result is a self-improving orchestration system that learns from experience, protects privacy, and adapts to each user's workflow.
