---
description: (Artibot) Clone and benchmark one or many external git repos against Artibot with scored comparison, parallel team analysis, and complexity-aware adoption filtering
argument-hint: '[git-url ...] [--focus area] [--deep|--quick] [--no-replace-if-better] [--parallel]'
allowed-tools: [Read, Glob, Grep, Bash, Task, TaskCreate, TaskUpdate]
toolset: analysis
---

# /repo

Clone 1..N external git repositories, analyze each against the current Artibot build, and produce a quantified multi-repo comparison. Multi-URL analyses run in **parallel teams** (one teammate per repo) with the orchestrator aggregating, per Artibot's "operator delegates, team executes + cross-checks" DNA.

## Arguments

Parse $ARGUMENTS (space-separated URLs supported):
- `url [url ...]`: One or more HTTPS git URLs. SSH and local paths blocked.
- `--focus [area]`: `agents` | `commands` | `skills` | `hooks` | `architecture` | `quality` | `innovation` | `domain-coverage`
- `--deep`: Full dependency mapping + code quality metrics
- `--quick`: Structure-only scan
- `--compare-only` / `--skip-clone`: Skip clone, use cached
- `--no-replace-if-better` *(default ON)*: If Artibot is stronger on a dimension, DO NOT suggest replacement — only note advantage
- `--complexity-budget [low|med|high]` *(default low)*: Filter adoption suggestions by how much complexity they add. `low` = "성능 향상은 좋지만 단순함 유지" mode
- `--parallel` *(auto-on for ≥2 URLs)*: Spawn one `repo-benchmarker` teammate per repo; aggregate via orchestrator
- `--domain-check`: For marketplace-style repos (e.g., modu-cowork), compare domain/vertical coverage rather than code
- `--output`: `table` (default) | `json` | `markdown`

## Security (unchanged, hardened)

1. HTTPS only. Reject `git@`, `file://`, relative paths
2. Clone isolation to `~/.claude/artibot/repos/[sanitized-name]/`
3. `--depth 1` default; full clone only with `--deep`
4. Size guard: abort if any repo > 500MB
5. **No execution** of cloned scripts / Makefiles / `npm install`
6. Sanitize `..`, shell metachars, null bytes from repo names
7. **NEW**: Refuse to read/execute any `.env`, credential files, or binary artifacts from cloned repos

## ★ MANDATORY: Code-Level Inspection (no shortcuts)

**This command does CODE-LEVEL analysis. Not README-based, not WebFetch-based.**

Every spawned `repo-benchmarker` teammate MUST:

1. **First action = `git clone --depth 1`** to `~/.claude/artibot/repos/<sanitized-name>/`. NOT `WebFetch` of github.com URLs.
2. **Enumerate** with `Glob`/`Bash ls -R` after clone — get the actual file tree.
3. **Read ≥10 substantive source files** per repo (not just README/LICENSE). Cover: entrypoints, configs, key modules, examples, tests.
4. **Cite `file_path:line_number`** for every claim. A claim without a line citation is rejected.
5. **Quote ≤5-line code snippets** for any "ADOPT / TRANSFORM / REJECT" judgment — show the actual code you saw.
6. **No README-only judgments**. If you only read the README, return `INSUFFICIENT-INSPECTION` for that dimension instead of guessing.

**Forbidden shortcuts**: `WebFetch https://github.com/...`, `WebSearch "<repo> patterns"`, judging by repo description / star count / file names alone. Use these only AFTER cloning, to supplement code evidence.

**Orchestrator verification**: before aggregating, sample 3 random claims from each teammate's report and confirm the cited `file_path:line_number` exists in the cloned tree. Reject any teammate whose citations don't check out — re-run with stricter instructions.

## Execution Flow

1. **Parse & Validate** — tokenize URLs, validate each, dedupe
2. **Clone in parallel** — `git clone --depth 1` per URL (background jobs, `wait`)
3. **Structure Scan** — count agents/commands/skills/hooks/lib/tests per repo
4. **Delegate**:
   - If 1 URL → single `repo-benchmarker` agent
   - If ≥2 URLs → spawn N `repo-benchmarker` teammates **in parallel** (orchestrator aggregates). **This is the default; do not inline-analyze sequentially when more than one repo is given.**
   - If `--deep` → add `architect` + `code-reviewer` teammates for design & quality passes
   - If `--domain-check` → add `marketing-strategist` teammate for vertical coverage comparison
5. **Score** — 10 dimensions per repo (see below)
6. **Complexity-Filter Adoption** — drop any suggestion that violates `--complexity-budget`
7. **Don't-Replace-If-Better Rule** — if Artibot's score on dimension D exceeds target's, label as "ADVANTAGE — keep as-is"; never recommend swap
8. **Validate claims** *(inspired by awesome-opensource-ai/validate_awesome.py)* — for each adoption suggestion, verify the referenced file/pattern actually exists in the target repo (grep/read check) before listing
9. **Aggregate Report** — single multi-repo table if N≥2

## 10 Scoring Dimensions

| # | Dimension | Measures |
|---|---|---|
| 1 | Agent Architecture | # specialized agents, role separation, model-tier policy |
| 2 | Orchestration Patterns | parallel teams, cross-check, routing, delegation discipline |
| 3 | Skill System | skill count, SKILL.md structure, chaining, activation clarity |
| 4 | Command System | slash-command coverage, argument hygiene, UX |
| 5 | Hook System | hook count, event coverage, pipeline integration |
| 6 | API Integration | provider adapters, region/fallback, MCP depth |
| 7 | Code Quality | strict types, test coverage, linting, module limits |
| 8 | Documentation | README depth, per-module docs, changelog discipline |
| 9 | CI/CD & Validation | workflows, release automation, benchmarks |
| 10 | Innovation | novel patterns (learning loops, self-eval, cognitive routing) |

## Agent Delegation (parallel-first)

| Phase | Agent | When |
|---|---|---|
| Structure scan | Task(Explore) per repo | always |
| Core benchmark | Task(repo-benchmarker) **×N parallel** | default for multi-repo |
| Architecture review | Task(architect) | `--deep` |
| Code quality | Task(code-reviewer) | `--deep` |
| Domain/vertical | Task(marketing-strategist) | `--domain-check` |
| Aggregation & complexity filter | orchestrator (main) | always |

**Orchestrator discipline**: the main thread only *aggregates*. Per-repo analysis is never run inline when parallelism is available — this preserves Artibot's "operator delegates, team executes + cross-checks" DNA.

## Complexity Budget Rules

When `--complexity-budget low` (default):
- **ACCEPT**: additive single-file skills, doc conventions, low-risk hooks, pure utility functions
- **REJECT**: new frameworks, new build systems, domain-plugin splits, ML model dependencies
- **DEFER**: anything requiring migration of ≥3 existing modules

## Don't-Replace-If-Better Rule

For each dimension D:
```
if artibot_score[D] >= target_score[D]:
    emit("ARTIBOT ADVANTAGE — retain: " + rationale)
    suppress_replacement_suggestions_for(D)
else:
    evaluate_adoption(target_pattern, complexity_budget)
```

## Output Format (multi-repo)

```
REPO BENCHMARK — BATCH
========================
Repos:    [n]
Artibot:  v[version]
Date:     [date]
Mode:     [quick|standard|deep]
Budget:   [low|med|high]

STRUCTURE MATRIX
────────────────
Metric     | Artibot | [repo1] | [repo2] | ...
Agents     | [n]     | [n]     | [n]     |
Commands   | [n]     | [n]     | [n]     |
Skills     | [n]     | [n]     | [n]     |
Hooks      | [n]     | [n]     | [n]     |
Tests      | [n]     | [n]     | [n]     |

SCORE MATRIX (10-pt)
────────────────────
Dimension              | Artibot | [r1] | [r2] | Winner
Agent Architecture     | 9       | 4    | 5    | A
Orchestration          | 9       | 3    | 5    | A
Skill System           | 8       | 5    | 9    | r2
...
WEIGHTED TOTAL (/100)  | 82      | 60   | 62   | A

ADOPTABLE (filtered by --complexity-budget=low)
────────────────────────────────────────────────
[1] [source]: [pattern] → Effort: L | Impact: H | Claim-verified: ✓

ARTIBOT ADVANTAGES (don't-replace list)
────────────────────────────────────────
[1] [dim]: [why stronger — keep as-is]

SUPPRESSED (would add complexity beyond budget)
───────────────────────────────────────────────
[1] [source]: [pattern] — REJECTED: [reason]

RECOMMENDATIONS
───────────────
Priority | Action | Effort | Impact | Complexity
P1       | ...    | L      | H      | +0
```

## Reference Repo Profiles (seed knowledge)

When any of these URLs is passed, pre-apply known profile:
- `MiniMax-AI/cli` → CLI/Bun/TS, media APIs, dual-region → **focus: Code Quality, API Integration**
- `google/magika` → ML file-type detection → **focus: Innovation**; SKIP framework-replacement
- `alvinreal/awesome-opensource-ai` → curated list → **focus: Documentation, validator pattern**
- `GoogleCloudPlatform/generative-ai` → notebooks/samples → **focus: Documentation, Domain organization**; SKIP agent-framework comparison
- `modu-ai/cowork-plugins` → Claude Code plugin marketplace, 17 plugins × 71 SME skills → **focus: Skill System, domain-coverage**; direct competitor → score all dimensions strictly

## Next Steps

| # | 액션 | 커맨드 | 설명 |
|---|------|--------|------|
| 1 | 심층 분석 | `/analyze` | 벤치마크 결과 심층 분석 |
| 2 | 채택 패턴 구현 | `/implement` | 단일 채택 항목 구현 시작 |
| 3 | 개선 로드맵 | `/plan --from-benchmark` | 여러 채택 항목 통합 계획 |
| 4 | 팀 병렬 실행 | `/team` | auto-team 트리거 완화 후 실전 파일럿 |
