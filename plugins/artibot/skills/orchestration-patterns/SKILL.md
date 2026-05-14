---
context: fork
name: orchestration-patterns
description: "Catalog of agent orchestration patterns: agents-as-tools, handoff with history filter, deterministic workflows, parallelization, and LLM-as-judge loops."
lang: [en]
level: 2
triggers: ["orchestration", "multi-agent", "handoff", "agent as tool", "workflow", "parallelize agents", "agent topology"]
agents: ["architect", "planner", "llm-architect"]
tokens: "~3K"
category: "architecture"
platforms: [claude-code, gemini-cli, codex-cli, cursor]
whenNotToUse:
  - "Single-agent task with no delegation"
  - "Trivial scripts that do not need an LLM"
  - "Cases already covered by Agent Teams API native handoff"
---

# Orchestration Patterns

## Overview

Five canonical patterns for composing multiple agents. Pick exactly one per workflow. All patterns are local — no external orchestrator or queue is required. Maps to Artibot primitives: `agentAsTool()`, `filterHandoffHistory()`, Agent Teams API, `runAll()` guardrails.

## When to Use

- Designing a workflow that spans more than one specialist agent
- Reviewing whether a hand-rolled orchestration loop should be replaced with a standard pattern
- Choosing between making a sub-agent a tool (caller stays in control) vs handing off (control transfers)

## When NOT to Use

- Single-agent calls — direct Agent invocation is enough
- Simple sequential pipelines with deterministic steps and no LLM in between (use a script)
- Patterns that require external infrastructure (queues, vector DB) — out of DATA POLICY scope

## Process

| Step | Action |
|---|---|
| 1 | Map the work into discrete cognitive units (one specialist per unit) |
| 2 | Decide caller-vs-callee semantics: agents-as-tools (caller keeps state) or handoff (callee owns state) |
| 3 | If handoff: choose history filter (default drops `function_call`, `function_call_output`, `reasoning`) |
| 4 | If parallel: ensure each unit is independent and aggregate via deterministic merge |
| 5 | Add guardrails at boundaries (input on entry, output on exit) |

## Pattern Catalog

| Pattern | When | Artibot primitive |
|---|---|---|
| Agents as tools | Caller is the planner; sub-agents are utilities | `agentAsTool({name, description})` |
| Handoff | Specialist takes over the conversation | Agent Teams + `filterHandoffHistory()` |
| Deterministic workflow | Steps are fixed; no branching needed | Plain function pipeline |
| Parallelization | N independent subtasks | `Promise.all` + reducer |
| LLM-as-Judge | Quality gate after generation | Two-agent loop with explicit threshold |

## Common Rationalizations

| Excuse | Rebuttal |
|---|---|
| "I'll just chain prompts" | Chained prompts lose state; named patterns track history and tools |
| "handoff and agent-as-tool are the same" | They differ: handoff transfers control; agent-as-tool keeps the caller in charge |
| "we don't need a history filter" | Without filtering, the next agent re-processes function-call noise as if it were instructions |
| "one big prompt is simpler" | One big prompt makes evaluation impossible; patterns let you measure each unit |

## Red Flags

- An agent-as-tool that mutates global state (must be referentially transparent)
- A handoff that re-includes raw `function_call` items (defeats the filter)
- Parallel branches that depend on each other's output (use sequential)
- "Judge" that uses the same model and prompt as the generator (rubber-stamp)

## Verification

- `tests/lib/orchestration/agent-as-tool.test.js` validates the wrapper contract
- Cross-check: each chosen pattern matches exactly one row in the catalog table
- Confirm history filter drops the documented item types in handoff cases
