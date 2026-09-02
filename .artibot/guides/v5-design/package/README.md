# ARTIBOT 5.0 — Self-Driving Cognitive Agent Runtime

**Status:** Canonical Design Package  
**Version:** 5.0 Draft Constitution v1.0  
**Primary audience:** Non-developers and developers using natural language as the default interface

## One-line definition

> Artibot 5.0 is a self-driving cognitive agent runtime that understands a user's real intent, builds the right plan, automatically activates the necessary commands/skills/settings/tools/models/topology, executes with sufficient intelligence and context, independently reviews the result, and recovers until a verified outcome is produced.

## North Star

Artibot is not optimized for “more agents”, “more tokens”, or “cheaper tokens”. It is optimized for **Quality, Success@1, Autonomy, Low Human Attention, Cost per Accepted Outcome, Low Latency, Low Regression, and inspectable reasoning when requested**.

## Most important UX principle

> **The user should not need to know Artibot's commands in order to use Artibot well.**

Natural-language requests must automatically activate the relevant command, command option, skill, model tier, effort, planning mode, review mode, topology, context strategy, verification strategy, and runtime setting. Advanced users may still override these choices explicitly.

## Canonical runtime

```text
USER
 ↓
Natural Language Intent Runtime
 ↓
Mission Compiler
 ↓
Mission Contract
 ↓
Problem Boundary / Blindspot Scan
 ↓
Plan or Ultraplan
 ↓
Context Compiler
 ↓
Adaptive Intelligence Router
 ↓
Topology Router
 ↓
Execution Runtime
 ↓
Independent Fable 5.1 Review
 ↓
Unified Verifier
 ├─ PASS → COMPLETE
 └─ FAIL → Review → Plan Repair / Re-execution
                      └─ rare case → Ultraplan Reframe
 ↓
Outcome / Cost / Evidence Ledger
 ↓
Routing + Context + Planning Learning
```

## Special execution modes

`autopilot --fast` and `split` are intentional exceptions to the ordinary “minimum sufficient resource” principle. Their user intent is: **use a large token/resource envelope to maximize speed and accuracy through aggressive parallelism and high-quality reasoning**.

## Package contents

- `01_PHILOSOPHY_CONSTITUTION.md`
- `02_PRODUCT_UX_NATURAL_LANGUAGE_RUNTIME.md`
- `03_INTENT_MISSION_COMPILER.md`
- `04_PLAN_ULTRAPLAN_ADR.md`
- `05_CONTEXT_MEMORY.md`
- `06_MODEL_ROUTING_ECONOMICS.md`
- `07_TOPOLOGY_AUTOPILOT_SPLIT.md`
- `08_REVIEW_VERIFICATION_RECOVERY.md`
- `09_BLINDSPOT_SYSTEMIC_REASONING.md`
- `10_LEARNING_OBSERVABILITY_LEDGER.md`
- `11_SAFE_AUTONOMY_HUMAN_GATES.md`
- `12_RUNTIME_ARCHITECTURE.md`
- `13_IMPLEMENTATION_BLUEPRINT.md`
- `14_RELEASE_ROADMAP.md`
- `15_DECISION_REGISTER.md`
- `config/artibot-v5-policy.example.yaml`
- `schemas/mission-contract.schema.yaml`
- `schemas/run-ledger.schema.yaml`
- `schemas/adr.schema.yaml`
- `VIBE_CODING_MASTER_PROMPT.md`

## v5.0 is a consolidation release

Do not turn v5.0 into a feature-count release. The release succeeds when Artibot becomes easier to use without learning commands, more correct before execution, more autonomous after intent is understood, more trustworthy because review is independent, more economical per accepted outcome, and more stable under long-running work.
