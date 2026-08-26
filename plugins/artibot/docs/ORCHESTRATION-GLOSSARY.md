# Orchestration Glossary

Four parallel-execution mechanisms in Artibot. Their engines are distinct and must not be conflated. (`split` below is an orthogonal process-cardinality surface, not a fifth mechanism.)

## Entries

**inline** — Single-file, trivial work executed directly by the main thread; no delegation, no team creation.

**team** — Adaptive, model-driven orchestration using the Agent Teams API (named `Agent` spawns / SendMessage / P2P messaging); fires automatically when 2+ independent subtasks are detected (Operator-Waits DNA). Also called "Auto-Team".

**orchestrate** (classifier label: `workflow`) — Deterministic, code-driven orchestration with a fixed control flow; requires explicit user opt-in and never auto-fires. User-facing slash entry point: **`/orchestrate`** — provides predefined pipelines (feature / bugfix / refactor / security). The classifier and config keys retain the legacy label `workflow`; prose must say **orchestrate**.

**autopilot** — Long-running unattended session wrapper; its EXECUTE phase consumes `team` and/or `orchestrate` as sub-mechanisms; never auto-fires without explicit opt-in.

**autopilot fast profile** — Explicit `--fast` execution profile (compatibility alias: `-fast`) for autopilot's `team` runner. Both command spellings normalize to `options.fast = true`. PLAN supplies repo-relative ownership and dependency metadata; the engine forms bounded CPU/agent/worktree-capped topological waves and keeps invalid/cyclic/unsafe work serial. With `--worktree`, worker plans inherit a persisted session integration cwd/base SHA. The persisted runner/profile snapshots are reused on EXECUTE resume. It is not a runner, not Dynamic Workflows (platform), and not a promise of any speed multiplier (including 10x).

**dynamic** — Slash entry point (**`/dynamic`**) that authors and runs a harness **`Workflow` tool** script (fan-out / pipeline / adversarial verify over a known worklist). Invoking it constitutes the explicit opt-in the `Workflow` tool requires; it never auto-fires. Runs are visible in the native `/workflows` monitor (unlike `/orchestrate` runs).

**split** — Process-cardinality surface (**`/split`**): the human opens **N concurrent Claude Code windows** (each its own worktree "limb" with disjoint file ownership); the plugin plans, briefs, observes completion via git trailers, and integrates. Orthogonal to the four mechanisms above — every window may run any of them — and it never auto-fires. Not a fifth mechanism. See [Process Cardinality (orthogonal)](ORCHESTRATION-ROUTING.md#process-cardinality-orthogonal).

**sequence** — `lib/planning/session-sizer.js` recommendation (`recommendation: 'sequence'`, `sequenceInto: k`) that an oversized task be cut into **k successive sessions**. Renamed from `split` on 2026-08-26 (root `docs/adr/ADR-001`, untracked design record) so that the word `split` means concurrent windows only.

---

## Canonical Naming Convention

Bare "workflow" is **banned in orchestration contexts** — six referents share the word. Always use the canonical name:

| Referent | Canonical name | Do not write |
|---|---|---|
| Artibot deterministic mechanism (2-axis model) | **orchestrate** (classifier label: `workflow`) | bare "workflow" |
| Harness JS orchestration tool (`agent()`/`parallel()`/`pipeline()`) | **`Workflow` tool** (capital W + "tool"); slash entry point: **`/dynamic`** | lowercase "workflow" |
| Claude Code platform feature (2.1.154) | **"Dynamic Workflows (platform)"**, always in full | "DW" or any abbreviation |
| Legacy "dynamic-workflow" (Auto-Team trigger) | **Auto-Team** | "dynamic-workflow" (except when citing the filename `workflow-plan.js`) |
| Native monitor command | **`/workflows` monitor** | bare "workflows" |
| Generic noun in non-orchestration contexts (CRM, git, marketing docs) | allowed as-is; inside orchestration docs prefer "pipeline" / "process" | — |
| Concurrent-window division (`/split` command, limbs, `Split-Limb:` trailer) | **split** — always with its referent: `/split`, "split window", "split limb" | "sequence"; bare "split" for the sizer label |
| Successive-session division (`session-sizer.js` recommendation) | **sequence** (`recommendation: 'sequence'`, `sequenceInto`) | "split" (the pre-2026-08-26 sizer label), "split into sessions" |

The classifier output label `workflow` (`lib/cognitive/workflow-plan.js#buildWorkflowPlan`) and the hint string `recommend=workflow` are **code identifiers** — they keep the legacy name until a code-level rename ships. Docs must annotate them as "(classifier label: `workflow`)" when referring to the orchestrate mechanism.

---

## Naming Notes

Artibot's legacy term **"dynamic-workflow"** (used in older docs and in the source file
`lib/cognitive/workflow-plan.js`) refers to the **Auto-Team** trigger described under **team**
above — it is NOT the harness `Workflow` tool (the deterministic JS orchestration mechanism).
The file `lib/cognitive/workflow-plan.js` retains its legacy name but its runtime purpose is to
build the **team plan** (complexity classification + per-teammate effort/budget). Do not rename
that file; do not confuse its name with the harness Workflow tool.

### Claude Code platform terms (external — do not conflate)

- **`ultracode`** (Claude Code 2.1.160) — a model-invocation mode (xhigh effort + always-on
  multi-agent permission); the official rename of the former "workflow" trigger keyword. It is a
  platform capability, NOT an Artibot mechanism.
- **Dynamic Workflows** (Claude Code 2.1.154) — a platform feature that auto-orchestrates work
  across tens–hundreds of background agents. It is distinct from the harness `Workflow` tool,
  from Artibot's `team`/Auto-Team, and from `ultracode`. Four things now share the word
  "workflow": Artibot legacy "dynamic-workflow" (=Auto-Team), the harness `Workflow` tool, the
  `/orchestrate` user entry point, and this platform "Dynamic Workflows" — keep them separate.

---

See: [docs/ORCHESTRATION-ROUTING.md](ORCHESTRATION-ROUTING.md) — canonical routing reference (decision tree, 2-axis model, auto-fire rules).
