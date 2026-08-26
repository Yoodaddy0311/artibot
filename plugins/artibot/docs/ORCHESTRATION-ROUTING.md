# Orchestration Routing — Canonical Reference

This is the **single source of truth** for how Artibot selects a parallel-execution mechanism.
All other files that discuss routing summarize and link here; do not duplicate this content.

---

## 2-Axis Model

|  | **Adaptive (model-driven)** | **Deterministic (code-driven)** |
|---|---|---|
| **Single attended session** | **team** — Agent Teams API; auto-fires when ≥2 independent subtasks are detected (Operator-Waits DNA) | **orchestrate** (classifier label: `workflow`) — fixed control flow; explicit opt-in only, never auto-fires. User-facing slash entry point: **`/orchestrate`** (predefined pipelines: feature / bugfix / refactor / security) |
| **Long unattended session** | **autopilot** (CONSUMES team internally — default EXECUTE runner; `--fast`/`-fast` are an explicit dependency-graph fan-out profile for independently owned work only) | **autopilot** (CONSUMES the deterministic runner — ADR-003: `--runner dynamic` manual, or Stage 2 auto-select gated by `autopilot.runner.autoSelect` config, default OFF) |

> autopilot is not a third axis — it is a session-lifetime wrapper whose EXECUTE phase delegates
> to team and/or orchestrate depending on the sub-task shape. It never auto-fires.
> `--fast` (or compatibility alias `-fast`) does not add an axis or a runner: both normalize to the
> same opt-in profile. After PLAN supplies dependency and repo-relative ownership metadata, it uses
> CPU/agent/worktree-capped topological waves; with `--worktree`, worker plans inherit a persisted session
> integration cwd/base SHA. Unresolved or cyclic dependencies, unsafe paths, and conflicting ownership remain serial. EXECUTE resume reuses strict
> runner/profile snapshots. Planned telemetry is an estimate, not measured speed, so 10x is never
> guaranteed. Merge, verification, cost, and safety gates remain unchanged. The detailed contract and
> standard-vs-fast comparison are in [commands/autopilot.md](../commands/autopilot.md).
>
> **Naming**: bare "workflow" is banned in orchestration prose — see the
> [Canonical Naming Convention](ORCHESTRATION-GLOSSARY.md#canonical-naming-convention).
> `workflow` appears below only as the **classifier output label** (a code identifier).

> **Naming collision (external)** — none of the four above is Claude Code's platform **"Dynamic
> Workflows"** (2.1.154, auto-orchestration across many background agents) or the `ultracode`
> mode (2.1.160 rename of the old "workflow" trigger). Those are platform-level concepts, separate
> from Artibot's mechanisms — see [ORCHESTRATION-GLOSSARY.md](ORCHESTRATION-GLOSSARY.md).

---

## Decision Tree

```
Is the worklist known up-front AND is control flow fixed / repeatable?
  YES → deterministic:
        · /orchestrate — predefined dev patterns (feature / bugfix / refactor / security)
        · /dynamic     — harness Workflow-tool scripts (fan-out, adversarial panel,
                         loop-until-dry, N-file migration)
        (classifier label for this branch: workflow)

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
| `workflow` (= orchestrate mechanism) | **No — advisory only (opt-in)** | Classifier emits a recommendation text; user or orchestrator must explicitly invoke `/orchestrate` (pattern pipelines) or `/dynamic` (Workflow-tool scripts) |
| `autopilot` | **No — advisory only (opt-in)** | Same advisory surface; never starts an unattended session silently |

**Single source of truth for classification logic:**
`lib/cognitive/workflow-plan.js#buildWorkflowPlan` — owns complexity classification and per-teammate effort/budget.

**Advisory surface point:**
`scripts/hooks/runtime-prompt.js#buildRecommendationDirective` — the only place that renders
workflow/autopilot recommendations into prompt text.

---

## Harness Constraint (do not violate)

`orchestrate` (classifier label `workflow`) and `autopilot` MUST NEVER auto-fire without explicit user opt-in.
The classifier MAY only recommend them (advisory text). Only `inline` and `team` auto-fire.

---

## Process Cardinality (orthogonal)

The 2-axis table above answers **how work is decomposed and controlled inside one Claude Code
session**. Process cardinality is a separate, orthogonal question: **how many Claude Code windows
(OS processes, each with its own context window, leader, and worktree) take part**. It adds no
row, no column, and no fifth mechanism to the 2-axis model — the table above is unchanged.

| Surface | Windows (processes) | Fan-out inside the window | Who starts the processes |
|---|---|---|---|
| `inline` | 1 | none | — |
| `team` | 1 | N in-process teammates (`Agent` spawns into the one implicit team) | harness, inside the session |
| `orchestrate` / `/dynamic` | 1 | fixed control flow (pattern pipeline / `Workflow` tool script) | harness, inside the session |
| `autopilot` (standard) | 1 | delegates to `team` / `orchestrate` per phase | harness, inside the session |
| `autopilot --fast` / `-fast` | 1 | dependency-graph waves of in-process workers; with `--worktree`, each worker in its own worktree | harness, inside the session |
| `/split` | **N** (practical cap 4) | each window is a full session and may itself run any row above | **the human** opens the windows — the plugin only plans, briefs, observes, and integrates |

Rules that follow from the table:

- **Recommend-only.** `/split` never auto-fires. The `recommend=split` hint is wired via
  `lib/cognitive/workflow-plan.js#deriveRecommendation`, gated by
  `config.split.recommendMinSubtasks` (**shipped `null` = OFF, opt-in**; an integer ≥ 2 enables it,
  together with `config.split.minStems` as the distinct-agent floor; values ≤ 6 shadow the
  `autopilot` hint, whose floor is 6), and rendered through the
  `scripts/hooks/runtime-prompt.js#RECOMMENDATION_HINTS` allowlist (`workflow | split | autopilot`)
  as `[artibot:hint recommend=split]`. Advisory only — the model surfaces it as a sentence and waits
  for confirmation (`CLAUDE.md` "Recommend-hint surfacing rule"); it falls under the same
  [Harness Constraint](#harness-constraint-do-not-violate) as `recommend=workflow` and
  `recommend=autopilot`. Only `inline` and `team` auto-fire.
- **`-fast` is not `/split`.** `-fast` multiplies workers inside one context window, one leader,
  and one landing pipeline; `/split` multiplies context windows, leaders, and landing pipelines.
  They compose (a split window may run `-fast`) but are never substitutes.
- **`sequence` is not `split`.** `lib/planning/session-sizer.js` recommends `sequence`
  (`recommendation: 'sequence'`, `sequenceInto: k`) when a task should be cut into *k successive*
  sessions; `/split` cuts it into *k concurrent* windows. Naming rows:
  [ORCHESTRATION-GLOSSARY.md](ORCHESTRATION-GLOSSARY.md#canonical-naming-convention).
- **Truth source for "which windows exist / are done" is git, not the messaging layer.**
  `git worktree list --porcelain` and commit trailers on the limb branch are authoritative;
  `ListAgents` / `SendMessage` are an optimization. Measured 2026-08-26: the `ListAgents` tool
  output has no cwd column, so a window cannot be matched to its worktree by cwd from inside a
  session (record: root `docs/PRD/split-cross-session-multi-worktree-20260826.md`, section
  "Phase 2 프로브 실측" — untracked design doc).

---

## Model-Era Assumptions (Single Source)

All model knowledge — names, pricing, tokenizer limits, context windows, and tier
constraints — lives exclusively in **`lib/core/model-catalog.js`** (the single source
of truth). `docs/CLAUDE-MODEL-CATALOG.md` is a generated artifact derived from that
catalog; never edit it by hand.

**Role aliases used by commands and agents**

| Alias | Purpose |
|---|---|
| `frontier` | Highest-capability tier (e.g., Opus class) |
| `deep-async` | Long-horizon async work |
| `balanced` | General-purpose mid-tier |
| `fast` | Low-latency, high-volume tier |

Command `.md` files reference these aliases only — never hardcode model names or
version strings in prose. This keeps every command decoupled from the model
generation cycle.

**Fable tier**

`fable` (and any analogous experimental tier) is an **opt-in allowlist** controlled
by `artibot.config.json#/agents/modelPolicy/fable`. It currently ships **off**
(`enabled: false`), so every tier resolution — bucket, role alias, advisor — lands
on `opus`. Security-adjacent agents (security-reviewer, guardrail, pii-scrubber,
blocked-patterns) are additionally on a **denylist** and cannot be assigned a
fable-tier model regardless of config.

**Upgrade path**

When a model generation rolls over, the only required edit is the catalog data in
`lib/core/model-catalog.js`. No command `.md`, agent frontmatter, or routing rule
needs to change — aliases remain stable across generations.

---

## See Also

- [ORCHESTRATION-GLOSSARY.md](ORCHESTRATION-GLOSSARY.md) — term definitions for all four mechanisms
- [../skills/team/SKILL.md](../skills/team/SKILL.md) — team skill guardrails and auto-apply opt-out
- [../CLAUDE.md](../CLAUDE.md) — Operator-Waits DNA table (auto-team trigger context)
