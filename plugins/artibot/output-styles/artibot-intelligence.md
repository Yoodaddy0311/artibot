---
name: artibot-intelligence
description: Intelligence output style — surfaces active features and session stats inline
---

## Purpose

Shows which Artibot intelligence features are active during a session.
Designed to be non-intrusive: indicators appear as single-line annotations,
not as separate sections that break response flow.

## Design Tokens

Uses the shared token system from `tokens.md` plus feature-specific symbols:

| Token | Symbol | Feature |
|-------|--------|---------|
| `feature-aci` | ⚡ | ACI tool constraints applied |
| `feature-context-reset` | 🔄 | Context window reset with handoff |
| `feature-sprint-contract` | 📋 | Sprint contract negotiated |
| `feature-eval-separated` | 🔍 | Independent evaluator active |
| `feature-source-fetched` | 📡 | Authoritative source referenced |
| `feature-cognitive` | 🧠 | Cognitive routing decision |
| `feature-token-saving` | 📊 | Token efficiency optimization |
| `feature-guardrail` | 🛡️ | Guardrail policy enforced |

## Inline Indicators

Appear as a single line at the start of a response when a feature activates:

```
⚡ ACI: tdd-guide → test tools only
```

```
📡 Source: TypeScript 5.8 docs referenced
```

### Rules

- One indicator per activated feature, max 3 per response
- Place before the main response body, separated by a blank line
- In compressed mode use short form: `[⚡ACI:test-tools]`
- Omit indicators when no features activated

## Session Dashboard

Shown on `/daily` command or session close. Uses pipe-aligned layout:

```
--- Session Intelligence Report ---
| ⚡ ACI Constraints    : 12x (accuracy +15%)
| 🔄 Context Resets     : 2x (quality maintained)
| 📋 Sprint Contracts   : 3x (3/3 achieved)
| 🔍 Independent Evals  : 5x (bias removed)
| 📡 Source Fetches     : 8x (latest docs)
| 🧠 Cognitive Route    : 47x (S1 73% / S2 27%)
| 📊 Token Efficiency   : 15x (23% saved)
```

### Rules

- Only show features with count > 0
- Sort by feature registry order (not by count)
- Include `lastDetail` parenthetical when available
- Omit dashboard entirely if no features were activated

## Compatibility

| Mode | Behavior |
|------|----------|
| default | Full indicators + dashboard |
| compressed | Short-form `[symbol+TAG:detail]` indicators, compact dashboard |
| mentor | Full indicators with brief explanation of what the feature does |
| report | Dashboard included in report footer |
| team-dashboard | Per-agent feature stats in agent rows |
| narrative | Woven into narrative flow naturally |
