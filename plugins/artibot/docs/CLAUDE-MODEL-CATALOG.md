# Claude Model Catalog (Artibot reference)

> Single-source knowledge reference for Claude model IDs, specs, and launch-time
> API features. Artibot **routing** uses tier aliases (`opus`/`sonnet`), not raw
> model IDs — see [Artibot routing constraint](#artibot-routing-constraint) for
> why the newest model can be a *reference point* without being a *subagent tier*.
>
> **Last verified:** 2026-06-10 (Claude Fable 5 / Mythos 5 launch, 2026-06-09).
> Sources at the bottom. Re-verify against `platform.claude.com/docs` on any model launch.

---

## Current models

| Model | Claude API ID | Context | Max output | Price in/out (per MTok) | Thinking |
|---|---|---|---|---|---|
| **Claude Fable 5** ⭐ | `claude-fable-5` | 1M | 128K | **$10 / $50** | Adaptive (always on) |
| Claude Mythos 5 | `claude-mythos-5` | 1M | 128K | $10 / $50 | Adaptive (always on) |
| Claude Opus 4.8 | `claude-opus-4-8` | 1M | 128K | $5 / $25 | Adaptive |
| Claude Opus 4.7 | `claude-opus-4-7` | 1M | 128K | $5 / $25 | Adaptive |
| Claude Opus 4.6 | `claude-opus-4-6` | 1M | 128K | $5 / $25 | Adaptive / Extended |
| Claude Sonnet 4.6 | `claude-sonnet-4-6` | 1M | 64K | $3 / $15 | Adaptive / Extended |
| Claude Haiku 4.5 | `claude-haiku-4-5` (`-20251001`) | 200K | 64K | $1 / $5 | Extended |

⭐ = most capable widely released model as of 2026-06-09.

---

## Claude Fable 5 / Mythos 5 (launched 2026-06-09)

**Claude Fable 5** (`claude-fable-5`) is Anthropic's most capable **widely released**
model — a "Mythos-class" model designated **safe for general use**, state-of-the-art
on nearly all tested capability benchmarks (software engineering, knowledge work,
vision, scientific research). It outperforms Opus models on longer, more complex
tasks and runs autonomously longer than any prior Claude model.

**Claude Mythos 5** (`claude-mythos-5`) is the same underlying model with safety
classifiers lifted in some areas. **Not generally available** — limited release via
[Project Glasswing](https://anthropic.com/glasswing) (invitation-only, US-gov
cyberdefense). Treat as inaccessible unless your org has explicit Glasswing access.

### Specs & behavior
- **GA surfaces:** Claude API, Claude Platform on AWS, Amazon Bedrock (`anthropic.claude-fable-5`), Vertex AI (`claude-fable-5`), Microsoft Foundry — from 2026-06-09.
- **Context / output:** 1M context, up to 128K output tokens per request.
- **Tokenizer:** same tokenizer introduced with Opus 4.7 — the same text yields ~30% more tokens than pre-4.7 models. Re-baseline `max_tokens`/budgets, don't apply a blanket multiplier.
- **Adaptive thinking is always on** and is the *only* thinking mode. `thinking:{type:"disabled"}` is **not supported**. Control depth with the `effort` parameter, not `budget_tokens`.
- **Raw chain-of-thought is never returned.** `thinking.display` defaults to `"omitted"` (empty `thinking` field); set `display:"summarized"` for readable summaries. Pass thinking blocks back unchanged in multi-turn on the same model.
- **Supported features at launch:** `effort`, task budgets (beta header `task-budgets-2026-03-13`), memory tool, context editing (beta `context-management-2025-06-27`), compaction, vision.
- **Covered Model:** 30-day data retention; **not** available under zero-data-retention.

### Core new API features shipped with the launch
These are the launch-time additions Artibot needs to know if/when it calls Fable 5
directly via the Messages API (the `advisor` / LLM-integration path — **not** subagent routing):

1. **Refusals as HTTP 200.** When a Fable 5 safety classifier declines a request, the Messages API returns `stop_reason: "refusal"` on a **successful HTTP 200** (not an error), and reports **which classifier** declined. Handle `refusal` as a normal stop reason, not an exception.
2. **Fallback on refusal.** A refused request can usually be served by another model. Two paths:
   - **Server-side:** pass the `fallbacks` parameter (beta, on Claude API + Claude Platform on AWS) to have the API retry automatically.
   - **Client-side:** SDK middleware (TS, Python, Go, Java, C#) retries from your code on any platform.
   - In practice, most **cybersecurity / chemistry / biology** queries are served by **Opus 4.8** instead of Fable 5 — a deliberate routing/fallback, not a failure.
3. **Fallback credit.** You are **not billed** for a request refused before any output is generated; on retry, fallback credit refunds the prompt-cache cost of switching models.

---

## Artibot routing constraint

**Why Fable 5 is a reference point, not a subagent tier (as of 2026-06-10):**

- Artibot's model policy (`artibot.config.json#/agents/modelPolicy`, resolved by
  `lib/core/model-policy.js`) maps each agent to a **tier alias** — `"opus"` or
  `"sonnet"` — never to a raw model ID. Claude Code resolves `opus → Opus 4.8`,
  `sonnet → Sonnet 4.6`.
- The Claude Code **subagent/Task `model` parameter only accepts the tier enum
  `sonnet | opus | haiku`.** `claude-fable-5` is an API-only model ID and is **not
  selectable as a subagent tier**. Setting a policy bucket to `"fable"` would break
  spawning.
- Fable 5 also costs **2× Opus 4.8** ($10/$50 vs $5/$25) and routes sensitive
  domains back to Opus 4.8 anyway.

**Consequence:** the `opus` tier remains **Opus 4.8** for all subagent routing.
Reach for Fable 5 only through **direct Messages API calls** (e.g. an advisor or a
standalone LLM-integration module), where you set `model: "claude-fable-5"`
explicitly and handle the refusal/fallback contract above. If a future Claude Code
release adds `fable` to the subagent model enum, revisit the policy buckets then.

---

## Sources

- [Models overview — platform.claude.com](https://platform.claude.com/docs/en/about-claude/models/overview) (verified 2026-06-10)
- [Introducing Claude Fable 5 and Claude Mythos 5](https://platform.claude.com/docs/en/about-claude/models/introducing-claude-fable-5-and-claude-mythos-5) (verified 2026-06-10)
- [Claude Fable 5 and Mythos 5 — anthropic.com/news](https://www.anthropic.com/news/claude-fable-5-mythos-5) (2026-06-09)
- Refusals & fallback, fallback credit: linked from the "Introducing" page above.
