---
context: fork
name: guardrails
description: "Input/output and per-tool guardrails with tripwire semantics. Auto-activates when: an agent processes untrusted input, calls a sensitive tool, or must short-circuit on a policy violation. Triggers: guardrail, input validation, tripwire, tool guardrail, policy check, refusal, agent safety."
lang: [en]
level: 2
triggers: ["guardrail", "input validation", "tripwire", "tool guardrail", "policy check", "refusal", "agent safety"]
agents: ["security-reviewer", "backend-developer", "architect"]
tokens: "~2K"
category: "safety"
platforms: [claude-code, gemini-cli, codex-cli, cursor]
whenNotToUse:
  - "Trivial single-call utilities with no untrusted input"
  - "Pure-function tools whose output is already type-checked at the call site"
  - "Operations where blocking is unsafe (logging, telemetry stubs)"
---

# Guardrails: Input, Output, and Tool-Level Policy Enforcement

## Overview

Guardrails are async checks that run alongside agent input/output and per-tool invocations. A "tripwire" result short-circuits the run with either a refusal message or a thrown `GuardrailTripped` error. The Artibot implementation lives in `lib/orchestration/guardrails.js` (top-level) and `lib/orchestration/tool-guardrails.js` (per-tool registry).

## When to Use

- The agent receives free-form user input that could contain prompt injection, PII, or jailbreak content
- A tool exposes a sensitive surface (file write, network egress, shell exec) that needs an extra gate
- Output policy must enforce a structured shape before returning to the user
- Multiple concurrent checks must run in parallel and any single trip should halt the run

## When NOT to Use

- A single-file utility with type-checked inputs and no user-facing surface
- A pre-existing static validator (Zod/Pydantic) already covers the contract
- The check is performance-critical hot-path (guardrails add async overhead)
- The intent is to log only — use the `on_llm_end` hook instead

## Process

| Step | Action |
|---|---|
| 1 | Identify the smallest input/output boundary (per-agent vs per-tool) |
| 2 | Write a `Guardrail` (or `registerToolGuardrail`) returning `{ tripwireTriggered, info, refusal? }` |
| 3 | For per-tool, decide behavior: `reject_content` (continue with refusal) vs `raise_exception` (throw) |
| 4 | Run via `runAll(guardrails, ctx, input)` or `evaluateToolInput(toolName, params)` |
| 5 | Test the tripwire fires for a known-bad input and stays silent on a clean input |

## Common Rationalizations

| Excuse | Rebuttal |
|---|---|
| "the LLM will refuse it anyway" | LLM refusal is probabilistic; guardrails are deterministic |
| "we already have Zod schemas" | Zod validates shape; guardrails validate intent and policy |
| "it slows down every call" | Run in parallel via `Promise.all`; cost is the slowest check, not the sum |
| "we will catch it in the post-hoc review" | Post-hoc means production already saw the bad output |

## Red Flags

- A guardrail that returns `tripwireTriggered: false` for every input it has ever seen
- A single guardrail that mutates the input in place (guardrails must be pure)
- Behavior `raise_exception` used on a customer-facing tool without a global error handler
- Per-tool guardrails registered globally at module import (use explicit registration in the run setup)

## Verification

- `tests/lib/orchestration/guardrails.test.js` — runAll parallelism + tripwire propagation
- Manual: register a known-bad guardrail, call `evaluateToolInput`, confirm refusal payload
- DATA POLICY: guardrails MUST NOT call out to external HTTP services for decisions
