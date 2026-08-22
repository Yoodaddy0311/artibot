---
context: fork
user-invocable: false
name: cognitive-routing
description: |
  Dual-process cognitive routing engine inspired by Kahneman's System 1/2 theory.
  Routes user requests through fast intuitive pattern matching (System 1) or deep deliberative reasoning (System 2)
  based on complexity scoring, confidence thresholds, and adaptive learning.
  Auto-activates on every user request via the cognitive-router hook.
  Triggers: route, classify, cognitive, system1, system2, fast, deep, escalate, think, intuition, 라우팅, 분류, 인지, 빠른 사고, 깊은 사고, 에스컬레이션
lang: [en, ko]
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
  - "라우팅"
  - "분류"
  - "인지"
  - "빠른 사고"
  - "깊은 사고"
agents:
  - "orchestrator"
tokens: "~3K"
category: "orchestration"
source_hash: 432213c0
whenNotToUse: "Simple one-step requests where routing classification overhead is unnecessary; also not applicable outside the Artibot plugin environment where the cognitive-router hook is not active."
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

## Advisor Routing

When a Sonnet-tier agent encounters any of the following conditions, recommend advisor escalation
instead of full System 2 routing. The executor continues work with advisor guidance rather than
handing off entirely.

### Escalation Triggers

| Condition | Description | Example |
|-----------|-------------|---------|
| Architecture decision | Trade-off analysis between 2+ approaches with long-term consequences | Choosing between monolith decomposition strategies |
| Security assessment | Severity validation of findings that may be false positives or require contextual judgment | OWASP finding that needs exploitability assessment |
| Complex debugging | Root cause analysis spanning 3+ modules or layers | Race condition across frontend, API, and database |
| Cross-domain analysis | Impact assessment where a change in one domain affects another | Frontend state management change affecting backend API contract |

### When NOT to Escalate

- Routine code review on single-file changes
- Documentation updates or README edits
- Single-file bug fixes with clear root cause
- Formatting, linting, or style-only changes
- Test additions for existing code

### Routing Integration

```
Cognitive Router -> Complexity Score -> Route Decision
                                        |
                    System 1 -----------> Fast response (no advisor)
                    System 2 -----------> Deep analysis
                    System 2 + Advisor -> Sonnet executes, Opus advises
```

The advisor pattern sits within System 2 routing. When complexity is high but the executor is
Sonnet-tier (per `modelPolicy.medium`), the router checks `advisorStrategy.triggerConditions`.
If the request matches a trigger condition, the executor invokes the advisor tool for guidance
while retaining execution control.

### Cost Profile

| Mode | Relative Cost | Quality | Use When |
|------|--------------|---------|----------|
| Sonnet only | 1x | Good | Routine tasks, documentation, single-domain |
| Sonnet + Opus advisor | ~1.5-2x | Near-Opus | Complex judgment calls within Sonnet execution |
| Opus only | 3-5x | Best | Orchestration, architecture, security-critical |

### Configuration

Settings in `artibot.config.json` under `agents.modelPolicy.advisorStrategy`:

```json
{
  "advisorStrategy": {
    "enabled": true,
    "executorModel": "sonnet",
    "advisorModel": "opus",
    "maxUses": 3,
    "triggerConditions": [
      "architecture-decision",
      "security-assessment",
      "complex-debugging",
      "cross-domain-analysis"
    ]
  }
}
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

## Workflow Checklist

Copy this checklist and track progress:

```
Progress:
- [ ] Step 1: Receive user request via UserPromptSubmit hook
- [ ] Step 2: Score complexity (token estimate, domains, steps, ambiguity, risk)
- [ ] Step 3: Route to System 1 (below threshold) or System 2 (above threshold)
- [ ] Step 4: Execute via selected system with confidence monitoring
- [ ] Step 5: Check escalation rules — escalate if confidence drops
- [ ] Step 6: Record experience (input, complexity, route, outcome, latency)
- [ ] Step 7: Feed outcome into adaptive learning loop
```

## Human Checkpoints

### Checkpoint 1: 라우팅 결정 검토 (After Step 3)
**Context**: 복잡도 점수에 따라 System 1 또는 System 2가 선택된 시점. 자동 라우팅 결과가 실제 요청의 성격에 맞는지 확인이 필요하다.
**Ask**: "복잡도 점수 기반으로 **[System 1 / System 2]** 로 라우팅했습니다. 이 결정이 적절한가요?"
**Options**:
1. Confirm — 라우팅 결정을 그대로 진행
2. Force System 2 — 더 깊은 분석이 필요하다고 판단
3. Force System 1 — 빠른 응답으로 충분하다고 판단
**Default**: 1 (자동 라우팅 결과를 신뢰)
**Skippable**: No — 잘못된 라우팅은 응답 품질에 직접 영향을 미침
**Freedom**: LOW

### Checkpoint 2: 에스컬레이션 승인 (After Step 5)
**Context**: System 1 실행 중 신뢰도 저하 또는 패턴 미스로 System 2 에스컬레이션이 트리거된 시점. 추가 처리 비용이 발생하므로 사용자 확인이 필요하다.
**Ask**: "System 1 신뢰도가 기준치 미만으로 **에스컬레이션**이 트리거되었습니다. System 2 심층 분석을 진행할까요?"
**Options**:
1. Proceed — System 2 심층 분석 진행
2. Override with quick answer — 현재 System 1 결과로 빠르게 응답
**Default**: 1 (에스컬레이션 트리거는 신뢰도 문제가 있다는 신호)
**Skippable**: No — 에스컬레이션 무시 시 낮은 품질의 응답 위험
**Freedom**: LOW

### Checkpoint 3: 임계값 조정 확인 (After Step 7)
**Context**: 실행 결과 피드백을 바탕으로 적응형 학습이 threshold를 조정하려는 시점. 임계값 변경은 이후 모든 라우팅에 영향을 미친다.
**Ask**: "적응형 학습이 threshold를 **[현재값 → 조정값]** 으로 변경하려 합니다. 이 조정 방향이 올바른가요?"
**Options**:
1. Accept adjustment — 조정을 적용하고 학습 루프 계속
2. Reset threshold — 기본값(0.4)으로 되돌림
**Default**: 1 (자동 학습 피드백을 신뢰)
**Skippable**: No — 임계값은 시스템 전반 라우팅 품질에 영향
**Freedom**: MEDIUM

## Freedom Levels

| Step | Freedom | Guidance |
|------|:-------:|----------|
| Receive request | LOW | Hook-driven, automatic |
| Score complexity | LOW | Weighted formula is defined, follow exactly |
| Route to system | LOW | Threshold-based, deterministic |
| Execute | MEDIUM | System 1 uses heuristics (flexible), System 2 uses structured analysis |
| Check escalation | LOW | Escalation rules are defined, follow exactly |
| Record experience | LOW | Schema is fixed, record all fields |
| Adaptive learning | MEDIUM | Adjustment step clamped, but direction requires interpretation |

## Rationalizations

The following table captures common excuses agents make to skip the discipline of this skill, paired with factual rebuttals.

| Excuse | Rebuttal |
|--------|----------|
| "System 2 is safer, always use it" | System 2 on trivial tasks burns 10x the tokens for zero quality gain and crowds out context you'll need later |
| "System 1 misses edge cases" | System 1 is pattern matching calibrated on prior success — the edge cases it misses are exactly what System 2 should escalate to |
| "routing adds latency" | the router runs in <50ms; the wrong pipeline costs seconds to minutes — routing pays for itself on the first decision |
| "I can tell which system to use manually" | manual routing drifts under fatigue and time pressure; the router is the consistency layer you lack |
| "dual-process is over-engineering" | dual-process is how humans solve this exact problem — it's under-engineering to pretend one mode fits all requests |
