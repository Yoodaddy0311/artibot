# Orchestration Glossary

Four parallel-execution mechanisms in Artibot. Their engines are distinct and must not be conflated.

## Entries

**inline** — Single-file, trivial work executed directly by the main thread; no delegation, no team creation.

**team** — Adaptive, model-driven orchestration using the Agent Teams API (TeamCreate / SendMessage / P2P messaging); fires automatically when 2+ independent subtasks are detected (Operator-Waits DNA). Also called "Auto-Team".

**workflow** — Deterministic, code-driven JS orchestration expressed through `agent()` / `parallel()` / `pipeline()` primitives; requires explicit user opt-in and never auto-fires.

**autopilot** — Long-running unattended session wrapper; its EXECUTE phase consumes `team` and/or `workflow` as sub-mechanisms; never auto-fires without explicit opt-in.

---

## Naming Note

Artibot's legacy term **"dynamic-workflow"** (used in older docs and in the source file
`lib/cognitive/workflow-plan.js`) refers to the **Auto-Team** trigger described under **team**
above — it is NOT the harness `Workflow` tool (the deterministic JS orchestration mechanism).
The file `lib/cognitive/workflow-plan.js` retains its legacy name but its runtime purpose is to
build the **team plan** (complexity classification + per-teammate effort/budget). Do not rename
that file; do not confuse its name with the harness Workflow tool.

---

See: [docs/ORCHESTRATION-ROUTING.md](ORCHESTRATION-ROUTING.md) — canonical routing reference (decision tree, 2-axis model, auto-fire rules).
