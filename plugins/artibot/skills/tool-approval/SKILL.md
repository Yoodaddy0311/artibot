---
context: fork
disable-model-invocation: true
name: tool-approval
description: "Dynamic tool approval predicates and the bash command allowlist. Use when the user asks about HITL approvals or tightening the pre-bash gate. Triggers: tool approval, approval predicate, bash allowlist, pre-bash, permission gate, HITL."
lang: [en]
level: 2
triggers: ["tool approval", "approval predicate", "bash allowlist", "pre-bash", "permission gate", "hitl"]
agents: ["security-reviewer", "backend-developer"]
tokens: "~2K"
category: "safety"
platforms: [claude-code, gemini-cli, codex-cli, cursor]
whenNotToUse:
  - "Read-only utilities that do not touch the filesystem or network"
  - "Cases already covered by the existing `pre-write-guard` hook"
  - "Hot-path tools where every call must be pre-approved offline"
source_hash: 5b6a2b85
---

# Tool Approval

## Overview

Two complementary surfaces protect risky tool calls:
1. **Bash allowlist** (`lib/security/cmd-allowlist.js`): static list of safe binaries; `isAllowedCommand(cmd)` returns true only for the leading binary in the allowlist
2. **Dynamic approval predicate** (AD-11): a per-tool `(args, ctx) => Promise<{approved, reason}>` registered alongside the tool spec, evaluated at call time

## When to Use

- Wiring a new shell command surface that must reject non-allowlist binaries
- Adding HITL approval for tools that mutate state (file write, git push, deploy)
- Migrating an existing always-allow tool to a context-aware approval

## When NOT to Use

- The tool is read-only and idempotent (no approval value)
- An equivalent guardrail already covers the case (use `tool-guardrails.js` instead)
- The check requires external network (DATA POLICY violation — keep approvals local)

## Process

| Step | Action |
|---|---|
| 1 | Classify the tool: read-only, mutating, or sensitive |
| 2 | For mutating: register an approval predicate at run setup |
| 3 | For shell: ensure the command's leading binary is in the allowlist |
| 4 | When approval is required, surface a clear refusal message including `reason` |
| 5 | Test with at least one allowed and one denied case |

## Allowlist (default)

`ls find stat cat less head tail du grep rg wc sort cut cp tee echo mkdir rm`

Override per-call via the second argument to `isAllowedCommand(cmd, customAllowlist)`. Never expand the default list without security review.

## Common Rationalizations

| Excuse | Rebuttal |
|---|---|
| "it's just a one-off command" | one-offs are how exfiltration starts; allowlist is cheap |
| "I trust the LLM" | trust is unverifiable; the allowlist is verifiable |
| "we'll add the approval later" | post-launch approvals are blocked by reverse-engineering the call surface |
| "the command is harmless" | parse `parseLeadingBinary()` first; "harmless" pipelines often start with `bash -c` |

## Red Flags

- An approval predicate that always returns `{approved: true}` (rubber-stamp)
- Shell commands that bypass the allowlist via `bash -c "..."` (parse must reject `bash` unless explicitly allowed)
- An approval predicate that issues an HTTP call (DATA POLICY breach)
- Allowlist diverges between hook gate and runtime check

## Verification

- Local: `isAllowedCommand("rm -rf /tmp/x")` returns `true` (binary `rm` is allowed); `isAllowedCommand("curl http://example.com")` returns `false`
- Unit tests: `tests/lib/orchestration/guardrails.test.js` covers the registry shape
- Security review: AD-09 entry in adoption ledger must remain `Y` for G-DATA
