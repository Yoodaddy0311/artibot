---
description: (Artibot) Clone and benchmark one or many external git repos against Artibot with scored comparison, parallel team analysis, and complexity-aware adoption filtering
argument-hint: '[git-url ...] [--focus area] [--deep|--quick] [--no-replace-if-better] [--parallel]'
allowed-tools: [Read, Glob, Grep, Bash, Agent, TaskCreate, TaskUpdate]
toolset: analysis
---

# /repo

Clone 1..N external git repositories, analyze each against the current Artibot build, and produce a quantified multi-repo comparison. Multi-URL analyses run in **parallel teams** (one teammate per repo) with the orchestrator aggregating, per Artibot's "operator delegates, team executes + cross-checks" DNA.

## Arguments

Parse $ARGUMENTS (space-separated inputs supported). Three input kinds are accepted; **none of them adds a tool** to `allowed-tools`:

| Kind | Accepted form | Handling |
|---|---|---|
| ① git repo | HTTPS git URL | Clone and analyze — the full path below. SSH, `file://`, and relative paths are blocked |
| ② homepage | any other `https://` URL | **Never fetched.** Treated as a *locator*: extract the git URL or local document it points to, then re-enter as ① or ③. If neither can be derived, report the input as unresolvable and stop — do not guess from the domain name |
| ③ document | local path under `~/.claude/artibot/inbox/**` or under the current working directory | Read with `Read` (already declared). No network involved |

- `url [url ...]`: One or more HTTPS git URLs (kind ①). SSH and local paths blocked.
- `--focus [area]`: `agents` | `commands` | `skills` | `hooks` | `architecture` | `quality` | `innovation` | `domain-coverage` — narrows scoring effort to the mapped dimension(s); see Execution Flow step 6
- `--deep`: Full dependency mapping + code quality metrics
- `--quick`: Structure-only scan
- `--compare-only` / `--skip-clone` *(synonyms)*: Skip clone, reuse the cached tree. Cache location, staleness threshold, and the skip rule are defined once in [repo-benchmarking SKILL.md](../skills/repo-benchmarking/SKILL.md) § *Cache Strategy*
- `--no-replace-if-better` *(default ON)*: If Artibot is stronger on a dimension, DO NOT suggest replacement — only note advantage
- `--complexity-budget [low|med|high]` *(default low)*: How strictly the **견고성 / 효율성** veto axes are read — **not** how much code a change touches. 안전성 is never relaxed. See *Adoption Judgment*. `low` = "성능 향상은 좋지만 단순함 유지" mode
- `--parallel` *(auto-on for ≥2 URLs)*: Spawn one `repo-benchmarker` teammate per repo; aggregate via orchestrator
- `--domain-check`: For marketplace-style repos (e.g., modu-cowork), compare domain/vertical coverage rather than code
- `--output`: `table` (default) | `json` | `markdown` — selects the container for the Output Format block below; the fields emitted are identical in all three

## Security (unchanged, hardened)

1. HTTPS only. Reject `git@`, `file://`, relative paths
2. Clone isolation to `~/.claude/artibot/repos/[sanitized-name]/`
3. `--depth 1` default; full clone only with `--deep`
4. Size guard: abort if any repo > 500MB
5. **No execution** of cloned scripts / Makefiles / `npm install`
6. Sanitize `..`, shell metachars, null bytes from repo names
7. **NEW**: Refuse to read/execute any `.env`, credential files, or binary artifacts from cloned repos

**Document inputs (kind ③) — apply all four, in order:**

| # | Guard | Rule |
|---|---|---|
| D1 | Containment after `realpath` | Resolve the path **first**, then re-check that the resolved path is still inside `~/.claude/artibot/inbox/` or the CWD. Checking before resolution lets a symlink walk out |
| D2 | Extension allowlist | `.md` `.txt` `.rst` `.json` `.yaml` `.yml` `.toml` `.csv` only. Anything unlisted is refused — never a deny-list |
| D3 | Size ceiling | Refuse files > 2MB; read the head and mark the dimension `SHALLOW` rather than truncating silently |
| D4 | Credential-name refusal | Refuse `.env*`, `*credential*`, `*secret*`, `*token*`, `*.pem`, `*.key`, `id_rsa*` **by name regardless of extension** — run this check *after* D2, since an allowlisted extension does not make a file safe (`secrets.json` passes D2 and must still be refused) |

**No egress for any input kind.** `WebFetch`/`WebSearch` are deliberately absent from `allowed-tools`: the harness runs `WebFetch` out of process, so Artibot's own egress gate (`lib/core/data-egress-guard.js#assertEgressAllowed`) cannot govern it. Kind ② is therefore a locator, never a fetch.

## ★ MANDATORY: Code-Level Inspection (no shortcuts)

**This command does CODE-LEVEL analysis. Not README-based, not WebFetch-based.**

Every spawned `repo-benchmarker` teammate MUST:

1. **First action = `git clone --depth 1`** to `~/.claude/artibot/repos/<sanitized-name>/`. NOT `WebFetch` of github.com URLs.
2. **Enumerate** with `Glob`/`Bash ls -R` after clone — get the actual file tree.
3. **Read ≥10 substantive source files per repo, or every substantive file the repo has if it has fewer than 10** (not just README/LICENSE). Cover: entrypoints, configs, key modules, examples, tests. Substantive excludes `LICENSE`, lockfiles, `.gitignore`, and binary assets. **Report the fraction you read** — `read 6/6 substantive` is complete coverage and stronger evidence than `read 10/500`; the floor exists to stop shallow reading of big repos, not to disqualify small ones. If you read fewer than exist, mark the untouched areas `UNINSPECTED` and say why.
4. **Cite `file_path:line_number`** for every claim. A claim without a line citation is rejected.
5. **Quote ≤5-line code snippets** for any "ADOPT / TRANSFORM / REJECT" judgment — show the actual code you saw.
6. **No README-only judgments**. If you only read the README, return `INSUFFICIENT-INSPECTION` for that dimension instead of guessing.

**Evidence allowlist (not a deny-list — anything unlisted is not evidence)**: exactly two sources may support an `ADOPT`:

1. a `file:line` read from the **cloned tree**, and
2. the result of a **grep over the Artibot tree** (Execution Flow step 10).

Everything else — repo description, star count, file names, a fetched page, a search result — **is not evidence**. Consulting such a source *after* cloning to orient yourself is allowed and can inform where to look, but it can never be the basis of an ADOPT; a claim resting on it caps at DEFER. This is stated as an allowlist on purpose: a deny-list would silently admit whatever source appears next.

**Orchestrator verification**: before aggregating, sample 3 random claims from each teammate's report, open the cited `file_path:line_number` in the cloned tree, and confirm **the cited lines actually say what the claim says they say**. A path that resolves is necessary but not sufficient — a real file at a real line can still fail to support the claim attached to it. Reject any teammate whose citations don't check out — re-run with stricter instructions.

## Pre-Analysis: Inspect Structure Before You Judge

> Skip this section only if `--quick` is passed.

Before scoring, decompose the target repo into observable units so judgments are anchored to specific evidence rather than gestalt impressions.

1. **List top-level dirs** — enumerate every directory (Bash `ls`), note the overall shape.
2. **Map entry points** — identify main executable(s), plugin manifests, or `package.json`/`pyproject.toml` scripts.
3. **Enumerate domain modules** — list key source files (≥10) across agents/commands/skills/hooks/tests; note file sizes.
4. **Surface architectural signals** — note language, module system (ESM/CJS/etc.), test framework, CI config.
5. **Flag inspection gaps** — if any major directory was not read, mark it `UNINSPECTED` in the report rather than inferring.

Only after completing steps 1–5, proceed to the Execution Flow below.

## Execution Flow

1. **Parse & Validate** — tokenize URLs, validate each, dedupe
2. **Clone in parallel** — `git clone --depth 1` per URL (background jobs, `wait`)
3. **Structure Scan** — count agents/commands/skills/hooks/lib/tests per repo
4. **Delegate**:
   - If 1 URL → single `repo-benchmarker` agent
   - If ≥2 URLs → spawn N `repo-benchmarker` teammates **in parallel** (orchestrator aggregates). **This is the default; do not inline-analyze sequentially when more than one repo is given.**
   - If `--deep` → add `architect` + `code-reviewer` teammates for design & quality passes
   - If `--domain-check` → add `marketing-strategist` teammate for vertical coverage comparison
5. **Decompose candidates** *(skip if `--quick`)* — Before assigning ADOPT/REJECT verdicts, decompose each proposal into independent sub-functions (e.g. "video awareness" → frame extraction · subtitle STT · ingest pipeline). Issue verdicts at the sub-function level — a single verdict on a compound proposal is forbidden; at least one decomposition attempt is required. If sub-functions fall under different policies or complexity tiers, split their verdicts accordingly (partial adoption allowed). For each candidate marked REJECT, ask once whether decomposition surfaces an adoptable piece; REJECT is final only after this check.
6. **Score** — score every dimension that **applies** to the repo; mark the rest `N/A` with a one-line reason and drop them from the denominator (see *10 Scoring Dimensions*). If `--focus [area]` is passed, still score every applicable dimension — the weighted total needs them — but spend the deep-read budget on the mapped dimension(s) and expand only those in the report: `agents`→1, `architecture`→2 + 7, `skills`→3, `commands`→4, `hooks`→5, `quality`→7 + 9, `innovation`→10, `domain-coverage`→3 + 10 and run the `--domain-check` path. An unrecognized area is an error — list the eight valid ones and stop. Dimensions outside the focus may be scored from the structure scan alone — mark them `SHALLOW` so the reader knows which scores are thin.
7. **Judge candidates** — run the 3 VETO axes (safety / robustness / efficiency) at the strictness set by `--complexity-budget`, then score the 4 GAIN axes. Vetoed candidates go to `SUPPRESSED` with the failing axis named. See *Adoption Judgment* below
8. **Don't-Replace-If-Better Rule** — if Artibot's score on dimension D exceeds target's, label as "ADVANTAGE — keep as-is"; never recommend swap
9. **Validate claims** *(inspired by awesome-opensource-ai/validate_awesome.py)* — for each adoption suggestion, verify the referenced file/pattern actually exists in the target repo (grep/read check) before listing
10. **Already-in-Artibot check** *(mirror of step 9 — opposite direction)* — before emitting any `ADOPT`, grep **Artibot** for the pattern (`Grep` over `plugins/artibot/{agents,commands,skills,hooks,lib,scripts}/`). If it already exists, downgrade to `REJECT — already implemented` and cite the Artibot `file:line`. This is the single most common false-ADOPT: in 2026-06 thirteen of fourteen benchmark proposals were rejected and "이미구현" was the top reason. A verdict of ADOPT is invalid without this grep having been run.
11. **Aggregate Report** — single multi-repo table if N≥2

## 10 Scoring Dimensions

> **Single source of truth**: the per-dimension **weights** that produce `WEIGHTED TOTAL (/100)` live in [repo-benchmarking SKILL.md](../skills/repo-benchmarking/SKILL.md) § *Evaluation Dimensions (10-point scale)* — that skill also owns the clone/cache protocol, the workflow checklist, and the three human checkpoints. This table is the scoring rubric only (what each dimension measures); do not duplicate the weights here. Change weights in the skill file first. The [repo-benchmarker agent](../agents/repo-benchmarker.md) mirrors the same weight table for standalone spawns — keep all three in step.

**Not every dimension applies to every repo.** A curated list has no hook system; a CLI has no skill system. Scoring an absent dimension is not rigor, it is invention — score it `N/A` instead.

- `N/A` is **not zero.** A zero says "they did this badly"; `N/A` says "this axis does not exist here". Never fold `N/A` into the total as 0 — that silently penalizes repos for not being plugins.
- **Drop `N/A` dimensions out of the denominator and state the denominator you used.** A total with no denominator cannot be compared to anything.
- `N/A` is a claim like any other: say *why* the dimension is absent, from the structure scan.
- `N/A` (dimension does not exist) is different from `UNINSPECTED` / `SHALLOW` / `INSUFFICIENT-INSPECTION` (dimension exists, you did not look hard enough). Do not use one for the other — the first is a property of the repo, the rest are properties of your effort.

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
| Structure scan | Agent(Explore) per repo | always |
| Core benchmark | Agent(repo-benchmarker) **×N parallel** | default for multi-repo |
| Architecture review | Agent(architect) | `--deep` |
| Code quality | Agent(code-reviewer) | `--deep` |
| Domain/vertical | Agent(marketing-strategist) | `--domain-check` |
| Aggregation & complexity filter | orchestrator (main) | always |

**Orchestrator discipline**: the main thread only *aggregates*. Per-repo analysis is never run inline when parallelism is available — this preserves Artibot's "operator delegates, team executes + cross-checks" DNA.

## Adoption Judgment — 3 VETO + 4 GAIN

> **복잡도는 작업량이 아니다.** 많이 고치더라도 결과가 더 단순하고 효율적이면 채택한다. 조금 고쳐도 분기가 늘고 진실원이 갈라지면 배제한다.

Complexity is a property of the **result**, not a measure of the work. Never judge a candidate by new-file count, edited-file count, or changed-line count — that is volume. A refactor touching twenty files that collapses three sources of truth into one **passes**. A three-line patch that adds a second place deciding the same thing **fails**.

The 10 dimensions above *find* candidates. These 7 axes *judge* them. The two sets are separate and neither substitutes for the other.

### VETO — binary, evaluated first

Any single veto failure sends the candidate to `SUPPRESSED`. No gain score can outweigh a veto, and the size of the change is irrelevant to all three.

| Axis | Fails when | Anchored in |
|---|---|---|
| **안전성 (Safety)** | Violates the Security rules above, or moves any data outside Artibot's own plugin and server | Security § + DATA POLICY |
| **견고성 (Robustness)** = pipeline stays untangled | Branch count rises, one source of truth splits into two, the decision path lengthens, or the change becomes harder to undo | new frameworks / new build systems each install a whole second decision path; the zero-dep constraint holds regardless of tier |
| **효율성 (Efficiency)** = logic stays cheap | The same result now costs more tokens, steps, or turns; the same data is re-read on an extra round-trip; a computation is duplicated | — |

### GAIN — 0–3 each, no weights

| Axis | 3 = |
|---|---|
| **확장성 (Extensibility)** | Absorbs new cases without new branches |
| **미래지향성 (Future-fit)** | Aligned with where the platform is going, evidenced not predicted |
| **독창성 (Originality)** | A pattern Artibot has no equivalent of |
| **창의성 (Creativity)** | Reframes the problem so less machinery is needed |

**ADOPT requires at least one gain axis at ≥2, backed by evidence from the allowlist above** — *both* sources count, not just the cloned tree. Which source is valid differs by axis, because the axes ask different questions:

| Axis | Valid evidence | Why |
|---|---|---|
| **독창성** | **Artibot grep returning nothing** (source ii), plus a cloned-tree `file:line` showing the pattern exists there | It is a claim about *absence in Artibot*; the cloned tree cannot prove that |
| **확장성** | Cloned-tree `file:line` showing the mechanism, plus an Artibot `file:line` for the code it would touch | It is a claim about the post-adoption state — name the place that would change |
| **효율성 관련 창의성** | Same pair: the pattern as read, and the Artibot machinery it would remove | "Less machinery" must name the machinery |
| **미래지향성** | Cloned-tree `file:line` **only** — evidenced, not predicted | Roadmap speculation is not evidence; if you cannot point at code, score it 0 |

The cloned tree proves *"this pattern exists there"*. Only an Artibot grep proves *"and we do not already have it"*. A gain score citing neither is 0.

Sum the four only to rank priority among candidates that already passed. **Never adopt on a weighted sum** — four weak claims must not add up to an adoption.

### `--complexity-budget` = veto strictness

The flag does not gate volume. It sets **how strictly 견고성 and 효율성 are read** — 안전성 is never relaxed at any setting.

| Setting | 견고성 · 효율성 read as |
|---|---|
| `low` *(default)* | End state must be **flat or better** on every robustness and efficiency axis. A transitional regression is still a veto |
| `med` | A transitional rise is tolerated **only if the stated end state is strictly better** — the net reduction must be named, not assumed |
| `high` | Cross-layer relocations and domain-plugin splits are allowed **only when each resulting part owns exactly one source of truth**; a split leaving the same decision in two places still vetoes |

Raising the setting is an explicit opt-in by the user, never an inference by the analyst. It gates *adoption suggestions only* — it never changes a dimension score. Anything whose end-state behavior **the existing test suite cannot verify** is DEFER at every setting.

Record every vetoed suggestion in `SUPPRESSED` with **which of the three veto axes it failed** and the setting in force — a suggestion stopped by strictness is not the same as one rejected on evidence, and the user may re-run at a higher setting.

> **Nothing on this page is automatically enforced.** The 7-axis judgment, the D1–D4 document guards, the evidence allowlist, and the `N/A`-excluded denominator rule hold only because whoever runs this command follows them — there is no gate behind them. The reason is structural, not neglect: `/repo` declares no `Write`/`Edit` and never writes a file, so its verdicts, `SUPPRESSED` rows, grep columns, and evidence markers exist only in the session. CI runs against a git checkout, where none of that is present; there is no artifact to check. The **only** things enforced automatically are the shared judgment vocabulary (this file ↔ [repo-benchmarker](../agents/repo-benchmarker.md)) and the axis counts (3 VETO / 4 GAIN), by `tests/firewall/repo-judgment-vocab.test.js`. **A green run of that gate means the words still match — it is not evidence that any judgment was actually made this way.** Do not cite it as such.

## Don't-Replace-If-Better Rule

For each dimension D:
```
if artibot_score[D] >= target_score[D]:
    emit("ARTIBOT ADVANTAGE — retain: " + rationale)
    suppress_replacement_suggestions_for(D)
else:
    evaluate_adoption(target_pattern, complexity_budget)
```

## Verdict Grades

> **Cross-ref**: an adoption suggestion is a proposal, so every verdict here is the benchmarking-time application of the [`problem-validation`](../skills/problem-validation/SKILL.md) gate (single source of truth for the 4-check framework, default = REJECT). The four checks are already carried by mechanisms in this command — this table maps them, it does not add a step:
>
> | problem-validation check | Where `/repo` runs it |
> |---|---|
> | 1 Already implemented? | Execution Flow step 10 (grep Artibot, cite `file:line`) |
> | 2 Hard evidence exists? | Code-Level Inspection rules 4–6 + Execution Flow step 9 (claim validation) |
> | 3 Not YAGNI? | The `DEFER` grade below — "value exists but no current demand" is exactly a YAGNI finding |
> | 4 Maintenance cost < value? | The 견고성 · 효율성 veto axes *are* the ongoing cost (upkeep is paid in branches and split sources of truth, not in lines changed); the gain axes are the value side |
>
> A candidate that fails any of the four is not an ADOPT. **Null result is a first-class outcome**: "no adoptable patterns found" is a complete, valid benchmark report — do not manufacture ADOPTs to fill the section.

| Grade | Meaning |
|-------|---------|
| ADOPT | Clears all 3 VETO axes, has at least one GAIN axis at ≥2, **and** the Execution Flow step 10 "already-in-Artibot" grep came back empty — implement as-is. Invalid if its supporting dimension carries `INSUFFICIENT-INSPECTION`, `UNINSPECTED`, or `SHALLOW` (see below) |
| TRANSFORM | **Not a verdict — a parent row.** Marks a compound candidate whose sub-functions received different grades. The real verdicts live on the child rows (per step 5's decomposition); a TRANSFORM with no graded children is an unfinished decomposition, not a judgment |
| DEFER | Value exists but no current demand, or the end state cannot be verified by the existing test suite, or the evidence available caps it here |
| REJECT | Drop — already implemented in Artibot (cite the `file:line`), or fails evidence, YAGNI, or a VETO axis on all sub-functions |

**Evidence markers bind to verdicts.** The three markers this command already emits — `INSUFFICIENT-INSPECTION` (README-only, rule 6; also **any dimension supported only by a kind ② locator or a kind ③ document**, since neither is clone-tree evidence), `UNINSPECTED` (directory not read, Pre-Analysis step 5), `SHALLOW` (scored from the structure scan alone, Execution Flow step 6; also a kind ③ document truncated by guard D3) — mark a dimension as *not sufficiently inspected*. If the dimension supporting a candidate carries any of the three, that candidate cannot be ADOPT: downgrade it to DEFER and name the marker as the reason. Inspect further to clear the marker, then re-grade — never grade around it.

## Output Format (multi-repo)

> `WEIGHTED TOTAL` below = Σ(dimension score × weight) over the **applicable** dimensions only. Read the weights from [repo-benchmarking SKILL.md](../skills/repo-benchmarking/SKILL.md) § *Evaluation Dimensions* before computing it — never estimate the total.
>
> **Always print the denominator**, because it changes per repo: `WEIGHTED TOTAL | 62 / 100 possible` when all ten apply, `41 / 60 possible (4 dims N/A)` when they do not. A bare `41` would read as a failing score when it is in fact 68% of what was scorable. Two repos with different denominators are **not** directly comparable — say so in the report rather than ranking them as if they were.
>
> **`--output` renders this same content in one of three containers** — the section set and field names never change, only the container:
> - `table` *(default)* — the fixed-width block below, as written.
> - `markdown` — the same sections as GFM pipe tables (`STRUCTURE MATRIX`, `SCORE MATRIX`, `RECOMMENDATIONS` become tables; the list sections stay numbered lists).
> - `json` — one object with keys `meta` (repos/artibot/date/mode/budget), `structure`, `scores` (per dimension: `{score, weight, evidence}`), `weightedTotal`, `adoptable` (per candidate: `{verdict, veto:{안전성,견고성,효율성}, gain:{확장성,미래지향성,독창성,창의성}, claimVerified, notAlreadyInArtibot, marker}`), `advantages`, `suppressed` (each with the failed veto axis), `recommendations`. Emit nothing but the JSON object so it can be piped.

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
Hook System            | 9       | N/A  | 4    | —      (r1: curated list, no hooks)
...
WEIGHTED TOTAL         | 82/100  | 41/60| 62/100 | see note
  (r1 scored 41 of 60 possible — 4 dimensions N/A; not directly comparable to /100 columns)

ADOPTABLE (filtered by --complexity-budget=low)
────────────────────────────────────────────────
[1] [source]: [pattern] → Effort: L | Impact: H | Claim-verified: ✓ | Not-already-in-Artibot: ✓ (grep: [what was searched])
    Both verification columns must be filled. A blank column is not a pass —
    the row is void and must be dropped from ADOPTABLE, not listed unverified.

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
| 3 | 개선 로드맵 | `/plan --size epic` | 여러 채택 항목을 묶은 통합 구현 계획 (벤치마크 리포트를 task 설명으로 전달) |
| 4 | 팀 병렬 실행 | `/team` | auto-team 트리거 완화 후 실전 파일럿 |
