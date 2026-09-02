# Model Routing & Economics

## Agent != Model

Model selection occurs per action, while context/model affinity may persist through a phase/session to avoid cache loss.

## Initial fleet roles

- **No-model/tool execution:** tests, build, lint, git state, deterministic checks. This does not mean “avoid LLM”; LLMs decide and interpret while tools provide environmental truth.
- **Haiku:** classification, metadata, heartbeat, trivial extraction, status.
- **Sonnet:** exploration, evidence collection, routine edits, docs, simple diagnosis.
- **Opus:** implementation, complex debugging, refactor, significant planning.
- **Fable 5.1:** independent review, architecture reasoning, difficult uncertainty, repeated-failure arbitration.

## Independent reviewer policy

```yaml
review:
  independent: true
  default_model: fable-5.1
```

Fable is deliberately reserved for high-value judgment and final challenge, not necessarily as the default implementation model.

## Economic objective

Optimize **Cost per Accepted Outcome**, not `$/token`.

```text
ExpectedCost = FreshInput + CachedInput + Output + Thinking + ToolContext + Retry + Handoff + CacheLoss
EffectiveCost = ExpectedCost / PredictedSuccessRate
```

## Routing hard gates

Before economic scoring: capability, modality/tools, context capacity, policy/risk, provider health, minimum quality tier.

## Route utility

```text
RouteUtility = QualityFit + TaskFit + PredictedSuccess + Reliability + ContextAffinity + CacheAffinity + CostEfficiency + LatencyEfficiency
```

## Hysteresis

Do not switch models for marginal savings if cache/context rebuild cost is larger.

```text
SwitchUtility = QualityGain + CostSaving + LatencyGain - ContextRebuildCost - CacheLoss - HandoffCost - SwitchingRisk
```

## Token economy hierarchy — normal mode

```text
Context elimination → Deduplication → Tool compression → Cache → Model selection → Effort selection → Task budget
```

### Important exception

`autopilot --fast` and `split` intentionally use a larger token/resource budget to maximize fast, accurate completion. They should not be forced through the same cost-minimizing objective.
