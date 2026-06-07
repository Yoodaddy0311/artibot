# Orchestration Routing — Canonical Reference

This is the **single source of truth** for how Artibot selects a parallel-execution mechanism.
All other files that discuss routing summarize and link here; do not duplicate this content.

---

## 2-Axis Model

|  | **Adaptive (model-driven)** | **Deterministic (code-driven)** |
|---|---|---|
| **Single attended session** | **team** — Agent Teams API; auto-fires when ≥2 independent subtasks are detected (Operator-Waits DNA) | **workflow** — `agent()`/`parallel()`/`pipeline()` primitives; explicit opt-in only, never auto-fires. User-facing slash entry point: **`/orchestrate`** (predefined pipelines: feature / bugfix / refactor / security) |
| **Long unattended session** | **autopilot** (CONSUMES team internally) | **autopilot** (CONSUMES workflow internally) |

> autopilot is not a third axis — it is a session-lifetime wrapper whose EXECUTE phase delegates
> to team and/or workflow depending on the sub-task shape. It never auto-fires.

> **Naming collision (external)** — none of the four above is Claude Code's platform **"Dynamic
> Workflows"** (2.1.154, auto-orchestration across many background agents) or the `ultracode`
> mode (2.1.160 rename of the old "workflow" trigger). Those are platform-level concepts, separate
> from Artibot's mechanisms — see [ORCHESTRATION-GLOSSARY.md](ORCHESTRATION-GLOSSARY.md).

---

## Decision Tree

```
Is the worklist known up-front AND is control flow fixed / repeatable?
  YES → workflow  (fan-out, adversarial panel, loop-until-dry, N-file migration)

Does decomposition require reasoning, OR must sub-agents coordinate / approve plans?
  YES → team  (adaptive model-driven; auto-fires on Operator-Waits DNA)

Does the task need unattended hours, restart-survival, or PRD-first planning?
  YES → autopilot  (internally runs team | workflow; requires explicit opt-in)

Otherwise (<30 lines, single domain, no delegation needed)?
  → inline  (executed directly by the orchestrator thread)
```

---

## Classifier Output and Auto-Fire Rules

| Classifier output | Auto-fires? | Notes |
|---|---|---|
| `inline` | Yes — orchestrator executes directly | No team creation overhead |
| `team` | Yes — Operator-Waits DNA triggers automatically | Threshold: `artibot.config.json#/team/autoApplyTriggers`; opt-out via `--no-team` or `team.autoApply: false` |
| `workflow` | **No — advisory only (opt-in)** | Classifier emits a recommendation text; user or orchestrator must explicitly invoke |
| `autopilot` | **No — advisory only (opt-in)** | Same advisory surface; never starts an unattended session silently |

**Single source of truth for classification logic:**
`lib/cognitive/workflow-plan.js#buildWorkflowPlan` — owns complexity classification and per-teammate effort/budget.

**Advisory surface point:**
`scripts/hooks/runtime-prompt.js#buildRecommendationDirective` — the only place that renders
workflow/autopilot recommendations into prompt text.

---

## Harness Constraint (do not violate)

`workflow` and `autopilot` MUST NEVER auto-fire without explicit user opt-in.
The classifier MAY only recommend them (advisory text). Only `inline` and `team` auto-fire.

---

## See Also

- [ORCHESTRATION-GLOSSARY.md](ORCHESTRATION-GLOSSARY.md) — term definitions for all four mechanisms
- [../skills/team/SKILL.md](../skills/team/SKILL.md) — team skill guardrails and auto-apply opt-out
- [../CLAUDE.md](../CLAUDE.md) — Operator-Waits DNA table (auto-team trigger context)
