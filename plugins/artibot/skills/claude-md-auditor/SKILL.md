---
context: fork
user-invocable: true
name: claude-md-auditor
description: "Audit CLAUDE.md files in a repository against a 6-criteria quality rubric, output a scored report and diff preview, and require user approval before any Edit. 자연어 트리거: 'CLAUDE.md 점검해줘', '메모리 품질 감사', '프로젝트 메모리 검토해줘', 'claude.md audit'."
lang: [en, ko]
platforms: [claude-code]
level: 2
triggers:
  - "claude.md"
  - "audit memory"
  - "memory quality"
  - "project context"
  - "메모리 품질"
agents:
  - "orchestrator"
  - "doc-updater"
tokens: "~3K"
category: "quality"
whenNotToUse: "Single CLAUDE.md edit requests where the user already specified the change. Skip when no CLAUDE.md file exists in the repository — run `/learn` to bootstrap one instead."
tools: Read, Glob, Grep, Edit
---

# CLAUDE.md Auditor

Score every CLAUDE.md-style memory file in the repo against a 6-criteria rubric (max 100), produce a graded report (A–F), and propose minimal diffs that the user must approve before any Edit fires.

## When This Skill Applies

- User says "audit CLAUDE.md", "score project memory", "memory quality", "메모리 품질"
- Discovery scan finds 2+ CLAUDE.md files with last-touched age > 30 days
- After a `/learn` cycle persists patterns, to verify they didn't bloat any CLAUDE.md beyond the 200-line soft cap
- Nightly session rollup picks up `audit-cache.json` → metric feed into GRPO (no UI)

## 5-Phase Workflow

### Phase 1 — Discovery (Glob, not find)

Use `Glob` only — `find` is rejected by the pre-bash guard on Windows and is not portable.

Patterns to scan, in priority order:

| Pattern | Type | Loaded |
|---|---|---|
| `CLAUDE.md` | project | every session |
| `**/CLAUDE.md` | subdir (per-package) | on package context |
| `CLAUDE.local.md` | local override | every session, gitignored |
| `~/.claude/CLAUDE.md` | global user | every session |
| `plugins/*/CLAUDE.md` | plugin | when plugin active |

Skip any file whose first frontmatter line declares `audit-skip: true`.

### Phase 2 — Assessment (6-criteria rubric, 100 pts)

Score every discovered file independently. Each criterion has the listed max; partial credit allowed in 5-pt steps.

| # | Criterion | Max | Signals |
|---|---|---|---|
| 1 | **Commands / Workflows** | 20 | concrete `npm` / `make` / `claude` invocations; expected outputs; not just "run tests" |
| 2 | **Architecture Clarity** | 20 | module boundaries; data-flow arrows; named layers; one mermaid or table preferred |
| 3 | **Non-Obvious Patterns** | 15 | constraints that aren't visible in code (deadlock workarounds, vendor quirks, contractual SLAs) |
| 4 | **Conciseness** | 15 | ≤ 200 lines for project; ≤ 80 lines for subdir; no duplicated sections |
| 5 | **Currency** | 15 | last-touched ≤ 90 days OR explicit `last-reviewed:` field within 90 days |
| 6 | **Actionability** | 15 | every rule has a "when this applies" trigger; no vague "follow best practices" |

Grade thresholds (from total / 100):

- **A** 90+ — load-bearing, do not block
- **B** 70–89 — minor polish suggestions only
- **C** 50–69 — actionable diff worth proposing
- **D** 30–49 — significant rewrite recommended
- **F** 0–29 — file is likely net-negative; propose archival or rewrite

### Phase 3 — Report (cache to disk for GRPO)

Emit a markdown table (one row per file). After printing, write the structured result to `~/.claude/artibot/audit-cache.json`:

```json
{
  "auditedAt": "2026-05-14T10:00:00Z",
  "files": [
    { "path": "CLAUDE.md", "score": 78, "grade": "B", "criteria": { "commands": 18, "architecture": 16, "patterns": 12, "conciseness": 12, "currency": 10, "actionability": 10 } }
  ],
  "summary": { "avgScore": 78, "minScore": 78, "maxScore": 78, "count": 1 }
}
```

The nightly session rollup picks this file up next run and feeds `summary.avgScore` into GRPO as `claudeMdQuality`. When the cache is missing the metric falls back to `null` (zero-dimension contribution).

### Phase 4 — Diff Preview (no Edit yet)

For every file with grade ≤ C, propose one minimal diff (≤ 40 lines changed). Use the same shape as `commands/revise-claude-md.md` — a `**File:**` / `**Why:**` header followed by a `diff` block:

**File:** CLAUDE.md
**Why:** Currency criterion 5/15 — last touched 2025-11 and references retired `/old-cmd`.

```diff
- /old-cmd run tests
+ npm test    # vitest, 8K+ assertions, p95 30s
```

Group diffs by file. No Edit calls until Phase 5.

### Phase 5 — Apply with Approval (explicit yes only)

Prompt: *"Apply the N diffs above? (yes / no / select N1,N2,...)"*

- `yes` → fire `Edit` per diff, in order
- `no` → skip all, write nothing; report `SKIPPED: N`
- `select X,Y` → apply only the named indices

Silent assumption of approval is forbidden. If user input is missing, default to skip and emit `SKIPPED (no explicit approval): N`.

## File Type Map

| Type | Path pattern | Owner | Frontmatter expected |
|---|---|---|---|
| project | `CLAUDE.md` (repo root) | repo | optional |
| local | `CLAUDE.local.md` | user (gitignored) | none |
| global | `~/.claude/CLAUDE.md` | user (cross-repo) | none |
| package | `packages/*/CLAUDE.md` | package | recommended |
| subdir | `apps/*/CLAUDE.md`, `services/*/CLAUDE.md` | subteam | recommended |

## Anti-Patterns

### 1. Obvious code info

**Bad** — restates what the code already says:
```
The `parseArgs` function in cli.js parses CLI arguments.
```
**Good** — captures the non-obvious constraint:
```
`parseArgs` swallows unknown flags for forward-compat — DO NOT add strict validation here; downstream loaders rely on pass-through.
```

### 2. Generic best practices

**Bad** — would apply to any project, gives no signal:
```
- Write tests
- Handle errors
- Document complex code
```
**Good** — project-specific, actionable:
```
- Integration tests MUST hit the real Postgres (mocks masked the 2025-11 migration regression — see PR #482)
- Errors that cross the swarm boundary must use `{ code: string, recoverable: boolean }` — bare strings break the protocol
```

### 3. One-off fixes

**Bad** — codifies a single incident as a permanent rule:
```
Always set `MAX_RETRIES=5` because of the 2025-04 outage.
```
**Good** — describe the invariant, not the workaround:
```
Retry budget for outbound HTTP is the smaller of (caller budget, MAX_RETRIES env). The 2025-04 outage taught us callers MUST own the budget — see lib/http/retry.js.
```

### 4. Verbose explanations

**Bad** — prose that the model will re-tokenize every session:
```
This project uses a modular architecture with separate concerns for the
different layers of the application. The data layer is responsible for
all database operations and is kept strictly separate from the business
logic layer, which in turn does not know about the presentation layer...
```
**Good** — one line + a code-reachable pointer:
```
3-layer separation: `lib/data/` → `lib/domain/` → `lib/http/`. Cross-layer imports fail lint (eslint-plugin-boundaries).
```

## Output Format

```
CLAUDE.md AUDIT
===============
Files scanned: [N]
Avg score:     [X / 100]   Grade: [A-F]

| File | Grade | Score | Top issue |
|------|:-----:|:-----:|-----------|
| CLAUDE.md          | B | 78 | Currency 10/15 — last touched 2025-11 |
| apps/web/CLAUDE.md | D | 42 | Conciseness 6/15 — 312 lines, mostly examples |

PROPOSED DIFFS (require approval)
---------------------------------
1. CLAUDE.md
   Why: Currency criterion 5/15
   ```diff
   - /old-cmd run tests
   + npm test
   ```

APPROVED: [n]
SKIPPED:  [n]

Cache written: ~/.claude/artibot/audit-cache.json
```

## Quick Reference

- Glob (not find) — Windows compat is non-negotiable
- 6 criteria, max 100 — A/B/C/D/F thresholds at 90/70/50/30
- Never Edit without explicit `yes` or `select N,...`
- Cache to `~/.claude/artibot/audit-cache.json` for nightly GRPO ingestion
