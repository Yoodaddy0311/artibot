---
context: fork
user-invocable: false
name: advisor-strategy
description: |
  Claude advisor tool strategy for cost-optimized quality retention.
  Sonnet executor + Opus advisor pattern reduces API cost by ~50% while maintaining
  near-Opus quality on complex judgment calls. Auto-activates when discussing model
  cost optimization, executor-advisor delegation, or advisor API integration.
  Triggers: advisor, cost optimization, model strategy, executor-advisor, advisor tool
lang: [en, ko]
level: 3
triggers:
  - "advisor"
  - "cost optimization"
  - "model strategy"
  - "executor-advisor"
  - "advisor tool"
allowed-tools: [Read, Grep, Glob]
agents:
  - "orchestrator"
  - "llm-architect"
tokens: "~3K"
category: "orchestration"
platforms: [claude-code, gemini-cli, codex-cli, cursor]
whenNotToUse: "Do not apply when the task is already routed to an Opus-tier agent via modelPolicy.high, as the advisor pattern adds latency without cost benefit. Also skip for System 1 routed requests where complexity is below threshold."
---

# Advisor Strategy

> **현재 정책 (fable 마이그레이션 이후)**: `artibot.config.json`의 `advisorStrategy.executorModel`은 `opus`다 (구 `sonnet`). 아래 Sonnet-executor 서술과 Cost Benchmark 수치는 **일반 패턴 설명**이며 sonnet-executor 구성 기준의 참고치다 — 현재 구성(executor=advisor=opus)에서는 비용 절감 효과가 없고, 패턴의 가치는 판단 분리(escalation 규율)에 있다.

## When This Skill Applies

- Evaluating cost vs quality trade-offs for model routing
- Configuring advisor tool integration in API applications
- Deciding when Sonnet executors should escalate to Opus advisor
- Reviewing or adjusting `advisorStrategy` config in `artibot.config.json`
- Building applications that use the Claude advisor tool API

## Executor-Advisor Pattern

The advisor pattern separates execution from judgment. A Sonnet-tier executor handles the
main workload while an Opus-tier advisor provides guidance on difficult decisions.

```
User Request
     |
     v
[Sonnet Executor]
     |
     +-- routine task ---------> Execute directly (no advisor)
     |
     +-- trigger condition? ---> [Opus Advisor] ---> Guidance
                                                        |
                                                        v
                                              [Sonnet continues
                                               with advisor input]
```

The executor retains control throughout. The advisor provides analysis, recommendations,
or validation — not implementation.

## Trigger Conditions

The advisor should be invoked when the Sonnet executor encounters:

| Condition | What to Escalate | What NOT to Escalate |
|-----------|-----------------|---------------------|
| Architecture decision | Trade-off analysis between approaches with long-term impact | Choosing between two equivalent libraries |
| Security assessment | Severity validation, exploitability judgment, false positive triage | Running a standard OWASP checklist |
| Complex debugging | Root cause spanning 3+ modules, race conditions, state corruption | Single-module stack trace debugging |
| Cross-domain analysis | Frontend change affecting backend contract, DB schema impact on API | Isolated CSS or styling changes |

### Max Uses Guard

`maxUses: 3` per task execution. This prevents runaway advisor calls on indecisive executors.
If the executor needs more than 3 advisor consultations, the task should be reassigned to an
Opus-tier agent instead.

## Cost Benchmark

| Configuration | Relative Cost | Quality (estimated) | Recommended For |
|---------------|--------------|--------------------|--------------------|
| Sonnet only | 1x | Good (baseline) | Documentation, single-file edits, routine review |
| Sonnet + Opus advisor (1-2 calls) | ~1.5x | Near-Opus | Feature implementation with design decisions |
| Sonnet + Opus advisor (3 calls) | ~2x | Near-Opus | Complex multi-domain tasks |
| Opus only | 3-5x | Best | Orchestration, architecture, security-critical |

Estimated savings: 50-70% cost reduction compared to running the full task on Opus,
with quality degradation under 5% for tasks matching trigger conditions.

## API Reference

The Claude advisor tool uses the `betas` header and a special tool type:

```
Beta header: betas=["advisor-tool-2026-03-01"]

Tool definition (in tools array):
{
  "type": "advisor_20260301"
}
```

The advisor tool does not require a `name` or `input_schema` — it is a built-in tool type
that the API recognizes. The executor model sends a query to the advisor, which responds
with analysis in the same conversation turn.

### Integration with Artibot

Artibot does not call the advisor API directly. Instead, the `advisorStrategy` configuration
in `artibot.config.json` informs the cognitive router and orchestrator about when to recommend
advisor-pattern delegation:

```json
{
  "agents": {
    "modelPolicy": {
      "advisorStrategy": {
        "enabled": true,
        "executorModel": "opus",
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
  }
}
```

## Decision Flow

```
1. Cognitive router scores request complexity
2. If complexity >= threshold AND assigned agent is Sonnet-tier:
   a. Check request against triggerConditions
   b. If match found: recommend advisor escalation
   c. Executor proceeds with advisor tool enabled
3. If complexity >= threshold AND assigned agent is Opus-tier:
   a. No advisor needed — Opus handles directly
4. If complexity < threshold:
   a. System 1 fast path — no advisor
```

## Quick Reference

| Question | Answer |
|----------|--------|
| When to use advisor? | Sonnet executor hits a judgment call matching triggerConditions |
| When NOT to use? | Task already on Opus, or task is System 1 level |
| Max advisor calls? | 3 per task (configurable via `maxUses`) |
| Cost savings? | ~50% vs full Opus for matching tasks |
| API beta header? | `advisor-tool-2026-03-01` |
| Config location? | `artibot.config.json` > `agents.modelPolicy.advisorStrategy` |

## Rationalizations

| Excuse | Rebuttal |
|--------|----------|
| "Just use Opus for everything, quality matters more" | Opus on routine tasks wastes 3-5x cost for zero quality gain — advisor pattern gives you Opus judgment only where it matters |
| "Advisor adds latency, skip it" | One advisor call adds ~2-3 seconds; a wrong architecture decision costs days of rework |
| "Sonnet is good enough without advisor" | Sonnet excels at execution but underperforms on multi-factor trade-off analysis — advisor fills exactly that gap |
| "3 max uses is too restrictive" | If you need more than 3 advisor consultations, the task is Opus-complexity and should be reassigned, not patched with more advisor calls |
