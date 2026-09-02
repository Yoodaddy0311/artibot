# Plan, Ultraplan & ADR Design

## Plan

Plan answers: **How should this mission be executed?**

Typical output: tasks, dependencies, relevant areas, execution order, validation points, completion criteria.

## Ultraplan

Ultraplan answers: **What is the correct way to frame and solve this problem?**

Use for architecture, high uncertainty, large blast radius, long-running work, conflicting approaches, repeated plan failure and systemic redesign.

Ultraplan evaluates actual problem, user intent, direct/systemic causes, assumptions, alternatives, tradeoffs, risks, architecture impact, success criteria and execution strategy.

## Recovery rule

```text
Failure
 ↓
Review
 ├ implementation defect → repair under same Plan
 ├ plan defect           → revise Plan
 └ framing/architecture defect → Ultraplan
```

## ADR — Architecture Decision Record

Create ADR for meaningful decisions involving architecture, persistent runtime behavior, data model, public interface, product semantics, provider strategy or irreversible migration.

### Initial ADR Human Q&A

At the beginning of ADR work, `questionUserAnswer` should be used only for genuinely necessary decision elements.

Ask only when the choice materially changes the system, evidence cannot decide it, user/business preference is required, guessing creates expensive rework, and the question can be stated concretely.

Do not ask for facts Artibot can inspect, documentation it can search, implementation details it can infer, or trivial preferences.

```text
Mission
 ↓
Evidence Gathering
 ↓
Decision Surface Detection
 ↓
Necessary Human Questions? ─ yes → questionUserAnswer
 ↓ no / answered
Alternatives
 ↓
Tradeoff Evaluation
 ↓
Recommended Decision
 ↓
ADR
 ↓
Plan
```
