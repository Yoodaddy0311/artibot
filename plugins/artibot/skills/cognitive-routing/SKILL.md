---
name: cognitive-routing
description: |
  Dual-process cognitive routing engine inspired by Kahneman's System 1/2 theory.
  Routes user requests through fast intuitive pattern matching (System 1) or deep deliberative reasoning (System 2)
  based on complexity scoring, confidence thresholds, and adaptive learning.
  Auto-activates on every user request via the cognitive-router hook.
  Triggers: route, classify, cognitive, system1, system2, fast, deep, escalate, think, intuition
platforms: [claude-code, gemini-cli, codex-cli, cursor]
level: 2
progressive_disclosure:
  enabled: true
  level1_tokens: 100
  level2_tokens: 4000
triggers:
  - "route"
  - "classify"
  - "cognitive"
  - "system1"
  - "system2"
  - "fast"
  - "deep"
  - "escalate"
  - "think"
agents:
  - "orchestrator"
tokens: "~3K"
category: "orchestration"
---

# Cognitive Routing

## When This Skill Applies
- Every incoming user request (via UserPromptSubmit hook)
- Requests needing automatic complexity classification
- Escalation decisions from fast to deep processing
- Adaptive threshold tuning based on outcome feedback
- Meta-cognitive monitoring of routing accuracy

## Core Guidance

### 1. Dual-Process Architecture

```
User Request
     |
     v
+-----------+     complexity < threshold     +-------------+
| Cognitive |  --------------------------->  |  System 1   |
|  Router   |                                | (Intuitive) |
|           |     complexity >= threshold    +-------------+
|  score()  |  --------------------------->  |  System 2   |
|  route()  |                                |(Deliberate) |
+-----------+                                +-------------+
     |                                             |
     v                                             v
  Monitor                                    Sandbox (optional)
  Confidence                                 Verify output
     |                                             |
     +------ Escalation if confidence < min -------+
```

### 2. Routing Criteria

| Factor | Weight | System 1 Range | System 2 Range |
|--------|--------|----------------|----------------|
| Token estimate | 0.25 | < 5K tokens | >= 5K tokens |
| Domain count | 0.20 | 1 domain | 2+ domains |
| Step count | 0.20 | < 3 steps | >= 3 steps |
| Ambiguity score | 0.20 | < 0.3 | >= 0.3 |
| Risk level | 0.15 | low | medium/high |

**Complexity formula**: `sum(factor * weight)` normalized to [0, 1]

### 3. Threshold Management

| Parameter | Default | Range | Description |
|-----------|---------|-------|-------------|
| `threshold` | 0.4 | 0.1 - 0.9 | System 1/2 boundary |
| `adaptRate` | 0.05 | 0.01 - 0.1 | Per-feedback adjustment step |
| `minConfidence` | 0.6 | 0.3 - 0.9 | System 1 minimum confidence |
| `maxLatency` | 100ms | 50 - 500ms | System 1 max response time |

### 4. Escalation Rules

System 1 escalates to System 2 when:
1. **Confidence drop**: System 1 confidence < `minConfidence` (0.6)
2. **Latency exceeded**: Processing time > `maxLatency` (100ms)
3. **Pattern miss**: No matching pattern found in System 1 cache
4. **Risk detection**: Security/production keywords detected
5. **Multi-domain**: Request spans 3+ domains
6. **Explicit flag**: User provides `--think`, `--think-hard`, or `--ultrathink`

### 5. System 1 (Fast / Intuitive)

- Pattern-matched responses from cached experience
- Keyword-based intent detection with heuristic scoring
- Target latency: < 100ms
- Handles: simple queries, known patterns, routine operations
- Tools: cached patterns, keyword matching, heuristic rules
- Fallback: escalate to System 2

### 6. System 2 (Deep / Deliberative)

- Multi-step reasoning with structured analysis
- Full context evaluation with dependency mapping
- Sandbox verification for high-risk operations
- Handles: complex analysis, architecture decisions, security audits
- Tools: Sequential MCP, Context7, full tool suite
- Retry: up to `maxRetries` (3) with progressive depth

### 7. Integration with Orchestration

```
Cognitive Router -> Complexity Score -> Delegation Mode Selection
                                        |
                    score < 0.4  ------> Sub-Agent (Task tool)
                    0.4 <= score < 0.6 -> Sub-Agent + System 2
                    score >= 0.6 -------> Agent Team (Teams API)
```

The cognitive router feeds into the existing orchestration skill's delegation mode selection,
providing a more nuanced complexity signal than keyword matching alone.

### 8. Adaptive Learning Loop

```
Route decision -> Execute -> Outcome -> Feedback -> Adjust threshold
                                                         |
                              success -> threshold stays or tightens
                              escalation -> threshold loosens (more System 2)
                              failure -> threshold loosens + log pattern
```

## Configuration

Settings in `artibot.config.json` under `cognitive.router` and `cognitive.system1/system2`:

```json
{
  "cognitive": {
    "router": { "threshold": 0.4, "adaptRate": 0.05 },
    "system1": { "maxLatency": 100, "minConfidence": 0.6 },
    "system2": { "maxRetries": 3, "sandboxEnabled": true }
  }
}
```

## Quick Reference

**Decision Flow**:
```
Request -> Score complexity -> Below threshold? -> System 1 (fast)
                            -> Above threshold? -> System 2 (deep)
                            -> System 1 low confidence? -> Escalate to System 2
```

**Escalation Signals**: low confidence, pattern miss, high risk, multi-domain, explicit flag, latency exceeded
