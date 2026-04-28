# agent-skills Benchmark vs Artibot

Target: `addyosmani/agent-skills` (cloned at `/tmp/artibot-bench/agent-skills/`)
Baseline: Artibot v3.0.0 (`C:/Users/nowhe/OneDrive/바탕 화면/AI/artibot/plugins/artibot/`)
Date: 2026-04-28
Analyst: repo-benchmarker
Session: ap-20260428-094832

## 1. TL;DR

| | |
|---|---|
| Final score | Artibot 84 / 100, agent-skills 71 / 100 |
| One-line verdict | Artibot wins on scale + lifecycle + automation; agent-skills wins on **skill prose density, anti-rationalization rigour, and two genuinely novel hooks** (sdd-cache + simplify-ignore) we should adopt verbatim |
| Action | Adopt 3 skill patterns and both hooks; keep Artibot's DEV protocol, Agent Teams, and 102-skill catalog as the chassis |

## 2. Repository overview

| Field | agent-skills | Artibot |
|---|---|---|
| Purpose | Production engineering skills for AI agents | Full Autonomous Agent OS (skills + agents + commands + hooks + lib + server + marketplace) |
| Skills | 20 (+1 meta) | 102 |
| Agents / personas | 3 | 29 |
| Slash commands | 7 (.claude/commands/) | 57 |
| Hooks | 4 (session-start, sdd-cache pre/post, simplify-ignore) | 52 (+ dispatcher + 11 events covered) |
| Lib code | 0 (pure markdown + 4 bash) | 228 JS files |
| Languages | Markdown + bash | ESM Node >=18 + bash + markdown |
| Distribution | Claude/Cursor/Gemini/Windsurf/OpenCode/Copilot/Kiro/Codex | Claude Code plugin (marketplace) |
| Differentiator | Process-driven SKILL.md with anti-rationalization tables and explicit "When NOT to use" sections; cross-tool portability | DEV protocol, Agent Teams API, GRPO learning, federated swarm, lifelong-learning, prompt cache, lifecycle router |
| Author signal | Addy Osmani (Google Chrome eng), embeds Software Engineering at Google practices | Internal Artibot project, evolved through 5 prior benchmark rounds |
| License | MIT | (project) |

## 3. 10-dimension scoring (/100)

| Dimension | Weight | Artibot | agent-skills | Δ | Winner |
|---|---|---|---|---|---|
| Skill quality (depth, anti-rationalization, verification) | 15% | 7.5 | 9.5 | +2.0 T | agent-skills |
| Agent design | 10% | 9.0 | 7.0 | -2.0 A | Artibot |
| Hook ergonomics (novelty + portability) | 10% | 7.0 | 9.0 | +2.0 T | agent-skills |
| Lifecycle coverage (define→ship→post-ship) | 15% | 9.5 | 8.0 | -1.5 A | Artibot |
| Documentation (README, AGENTS.md, references) | 10% | 7.5 | 9.5 | +2.0 T | agent-skills |
| Test coverage / validation infra | 5% | 9.0 | 4.0 | -5.0 A | Artibot |
| Innovation (novel patterns) | 10% | 9.0 | 8.5 | -0.5 A | Artibot |
| Reusability across harnesses | 10% | 6.5 | 9.5 | +3.0 T | agent-skills |
| DATA POLICY compliance (no external DB / no exfil) | 10% | 10.0 | 9.0 | -1.0 A | Artibot |
| DNA fit (DEV protocol, ESM, Korean path, hooks intact) | 5% | 10.0 | 7.0 | -3.0 A | Artibot |
| **Weighted total** | 100% | **84.0** | **71.0** | **-13.0** | **Artibot** |

### Score justifications (one line each)

| Dim | Artibot evidence | agent-skills evidence |
|---|---|---|
| Skill quality | 102 skills but average prose is shallower; only some carry "Common Rationalizations" tables (e.g. `tdd-workflow`, `production-code-audit`) | Every SKILL.md has Overview + When to Use + When NOT to Use + Process + **Common Rationalizations + Red Flags + Verification** consistently. ~5,962 total lines for 21 files = 280 lines/skill avg |
| Agent design | 29 specialists with model-policy split (Opus/Sonnet), Agent Teams orchestration, lifecycle-router | 3 personas, but explicit **non-orchestration rule** ("personas do not invoke other personas") — clean pattern, just narrow surface |
| Hook ergonomics | 52 hooks but mostly internal lifecycle/learning; few are user-portable | `sdd-cache-pre.sh`/`sdd-cache-post.sh` is a genuinely novel HTTP-revalidation cache (ETag/Last-Modified with 304); `simplify-ignore.sh` is a content-hash placeholder hook with crash recovery |
| Lifecycle coverage | spec/plan/implement/test/review/ship/marketing — 7 phases incl. post-ship marketing | spec/plan/build/test/review/code-simplify/ship — 7 phases but no marketing or learning loop |
| Documentation | Strong inline docs + skills index, but no `AGENTS.md` parity at root with the same density; CLAUDE.md is short | README 295 lines with phase diagram, install for 7 harnesses, full skills/agents/refs tables. AGENTS.md (185 lines) explicitly distinguishes Skills/Personas/Commands as "how/who/when" — a clarity our docs lack |
| Validation | vitest, eslint, 5,183 passing tests, schemas/, multiple validators | None — README explicitly says "npm test — Not applicable" |
| Innovation | Agent Teams, GRPO trainer, federated swarm, lifecycle router, cognitive routing, prompt-cache strategy | sdd-cache (HTTP 304-driven, no TTL); simplify-ignore (block-level content protection via hash placeholders); **using-agent-skills meta-skill** auto-injected at SessionStart |
| Reusability | Tied to Claude Code plugin spec; Artibot-specific frontmatter (`source_hash`, `level`, `agents`, `toolset`) | Plain markdown SKILL.md works anywhere; explicit setup docs for Claude/Cursor/Gemini/Windsurf/OpenCode/Copilot/Kiro/Codex |
| DATA POLICY | Fully self-contained, no external DB writes | Hooks write to local `.claude/sdd-cache/`; `WebFetch` revalidation hits external doc origins via HEAD only (read-only, no exfil) — borderline but compliant if we keep cache local-only |
| DNA fit | Native | Their hooks are bash; Artibot is ESM Node. Adoption requires JS rewrite to preserve `toFileUrl()` & ESM-only stance |

## 4. Adoptable elements (prioritized)

| # | Element | Source path | Target Artibot path | Effort | Priority |
|---|---|---|---|---|---|
| A1 | **Anti-rationalization table pattern** in every skill (`Common Rationalizations` + `Red Flags`) | `skills/*/SKILL.md` (all 21) | `plugins/artibot/skills/<skill>/SKILL.md` — add to top 20 skills first | LOW | HIGH |
| A2 | **Meta-skill auto-injected at SessionStart** with discovery flowchart | `skills/using-agent-skills/SKILL.md` + `hooks/session-start.sh` | `plugins/artibot/skills/using-agent-skills/SKILL.md` + new `scripts/hooks/skill-discovery-inject.js` | LOW | HIGH |
| A3 | **HTTP 304 revalidation cache for WebFetch** (sdd-cache) | `hooks/sdd-cache-pre.sh`, `sdd-cache-post.sh`, `SDD-CACHE.md` | Port to ESM Node: `plugins/artibot/scripts/hooks/webfetch-cache-pre.js` and `webfetch-cache-post.js`; cache dir `runtime/cache/webfetch/` | MEDIUM | HIGH |
| A4 | **Block-level simplify-ignore hook** (content-hash placeholders) | `hooks/simplify-ignore.sh` + annotation syntax | Port to ESM: `plugins/artibot/scripts/hooks/simplify-ignore.js`; pair with new `commands/code-simplify.md` if not present | MEDIUM | MEDIUM |
| A5 | **"When NOT to use" section** as mandatory skill frontmatter field | format spec | Add `whenNotToUse` to skill schema in `plugins/artibot/schemas/`; backfill 102 skills via codemod | LOW | HIGH |
| A6 | **Three-tier boundary system** in spec template (Always / Ask first / Never) | `skills/spec-driven-development/SKILL.md` | Merge into `plugins/artibot/skills/spec-format/SKILL.md` EARS section | LOW | MEDIUM |
| A7 | **"Verdict: APPROVE / REQUEST CHANGES" template** with Critical/Important/Suggestion tiers | `agents/code-reviewer.md` | Merge into `plugins/artibot/agents/code-reviewer.md` output template | LOW | MEDIUM |
| A8 | **Skill anatomy doc** (one canonical format spec) | `docs/skill-anatomy.md` | New `plugins/artibot/docs/skill-anatomy.md` | LOW | MEDIUM |
| A9 | **Reference checklists separated from skills** (testing-patterns, security-checklist, perf-checklist, a11y-checklist) | `references/*.md` | New `plugins/artibot/references/` directory; link from skills | MEDIUM | MEDIUM |
| A10 | **Multi-harness install docs** (Cursor, Gemini CLI, Windsurf, OpenCode, Copilot, Kiro, Codex) | `docs/*-setup.md` | Optional `plugins/artibot/docs/<harness>-setup.md` — but only if we want non-Claude-Code distribution (currently we don't) | HIGH | LOW |
| A11 | **Source-driven-development skill** (DETECT→FETCH→IMPLEMENT→CITE) | `skills/source-driven-development/SKILL.md` | New `plugins/artibot/skills/source-driven-development/SKILL.md`; pair with A3 hook | LOW | HIGH |
| A12 | **Code-simplification skill (Chesterton's Fence + Rule of 500)** | `skills/code-simplification/SKILL.md` | Augment existing `plugins/artibot/skills/code-slop-reviewer/SKILL.md` or create distinct `code-simplification` skill | LOW | MEDIUM |
| A13 | **AGENTS.md "skills/personas/commands = how/who/when" clarity** | `AGENTS.md` lines 80-110 | Refresh `plugins/artibot/AGENTS.md` with the same three-layer table | LOW | HIGH |

## 5. Reject list

| # | Element | Reason |
|---|---|---|
| R1 | Bash-only hook implementations | Artibot is ESM Node>=18 with Korean path workaround. Adopt logic, not language. Bash hooks would break Windows non-ASCII path handling |
| R2 | "personas cannot orchestrate other personas" hard rule | Too restrictive for Artibot's Agent Teams model where orchestrator/architect/planner explicitly delegate. Keep as guidance for direct subagents only |
| R3 | Single SKILL.md per directory mandate | Artibot uses richer per-skill assets (templates, examples). Don't enforce flat structure |
| R4 | Skill packaging as `.zip` + `/mnt/skills/user/...` paths | claude.ai-specific deployment. Artibot is plugin-based, not knowledge-uploaded |
| R5 | "npm test — Not applicable" stance | Violates Artibot's 80%+ coverage gate. We must keep vitest + 5,183 tests. Their no-test posture is a weakness, not a feature |
| R6 | OpenCode mandatory invocation language ("MUST invoke even at 1% chance") | Too aggressive — would fight Artibot's Claude 4.7 fewer-subagents default override that's already calibrated |
| R7 | "kebab-case dirname + UPPERCASE SKILL.md" rule | Artibot uses lowercase `SKILL.md` already — partial accept; reject the `.zip` co-requirement only |
| R8 | External git URL for `gemini skills install` from our repo | DATA POLICY: don't promote installation paths that route through external services. Stay self-hosted |

## 6. Diff / gap analysis vs Artibot

### Skills agent-skills has that Artibot lacks (or treats lightly)

| agent-skills skill | Artibot equivalent | Gap status |
|---|---|---|
| source-driven-development | (none — closest is `mcp-context7` skill but that's a tool, not a workflow) | **GAP — adopt as new skill A11** |
| code-simplification (with Chesterton's Fence, Rule of 500) | `code-slop-reviewer`, `polish` partial | Partial gap — augment existing |
| using-agent-skills (meta discovery flowchart auto-injected) | `using-agent-skills` skill name reused but not auto-injected at SessionStart in Artibot | **GAP — adopt A2** |
| browser-testing-with-devtools (Chrome DevTools MCP integration) | `mcp-playwright` covers Playwright but not Chrome DevTools MCP | Partial — consider DevTools MCP variant |
| deprecation-and-migration | (none — `lang-reference`, `compaction-survival` adjacent) | **Minor gap — possible new skill** |
| documentation-and-adrs | `report-generation`, `session-worklog` cover reports but not ADR specifically | **Minor gap — new skill candidate** |
| api-and-interface-design (Hyrum's Law, One-Version Rule) | `tool-design`, `coding-standards` — not interface-specific | **Gap — new skill candidate** |
| frontend-ui-engineering with WCAG 2.1 AA explicit | `persona-frontend`, `cro-page` — partial | Partial |
| ci-cd-and-automation (Shift Left, feature flags lifecycle) | `ci-cd-pipelines` exists | Equal |
| git-workflow-and-versioning (atomic, ~100 line sizing) | `git-unified` exists | Equal |
| shipping-and-launch (rollback-mandatory) | `shipping-and-launch` not present; closest is `/ship` command + devops-engineer | Partial — Artibot has command but no skill |

### Agents agent-skills has that Artibot doesn't

| agent-skills persona | Artibot match | Status |
|---|---|---|
| code-reviewer | `code-reviewer` agent | Equal — adopt their five-axis output template (A7) |
| security-auditor | `security-reviewer` agent | Equal — borrow OWASP framing |
| test-engineer | `tdd-guide` agent | Equal |

### Hooks agent-skills has that Artibot lacks

| Hook | Function | Artibot match | Status |
|---|---|---|---|
| sdd-cache-pre / sdd-cache-post | HTTP 304-revalidated WebFetch cache | (none — `prompt-caching-strategy` skill exists but no hook) | **GAP — A3** |
| simplify-ignore | Block-level content masking via hash placeholders | (none — `pre-write-guard.js` is permission-based, not content-mask) | **GAP — A4** |
| session-start (inject meta skill) | Surface skill discovery flowchart | `session-start.js` exists but injects telemetry/swarm/memory not skill discovery | **Partial gap — A2** |

### What Artibot has that agent-skills doesn't (advantages we keep)

| Element | Why it matters |
|---|---|
| 52 hooks across 11 events (PreToolUse, PostToolUse, SessionStart/End, UserPromptSubmit, Stop, PreCompact, etc.) | 13× their hook coverage |
| Agent Teams API (TeamCreate, SendMessage, TaskCreate/Update) | They explicitly note "subagents cannot spawn subagents, teams cannot nest" — Artibot has working teams |
| Lifecycle router (`lib/core/lifecycle-router.js`) | Auto-routes commands to candidate agents per phase |
| GRPO + federated swarm + lifelong learning | Agent self-improvement loop they completely lack |
| ESM-only Node>=18 with Korean path `toFileUrl()` | Cross-locale path safety they don't address |
| 5,183 passing tests + vitest + eslint | They have zero tests |
| Marketing / post-ship lifecycle (ad, content, seo, social, marketing-strategist) | They stop at /ship |
| `output-styles/artibot-report.md` GFM table mandate | Consistent reporting format |
| `artibot.config.json` with auto-team triggers, autopilot, schemas | Configurable runtime they lack |
| Cognitive routing (System 1 / System 2) | Adaptive depth per request |
| Auto-invoke commands via context detection | Their `/ship` etc. are explicit-only |

## 7. Top 5 concrete actions for Autopilot Phase 2

| # | Action | Files to touch | Acceptance evidence |
|---|---|---|---|
| 1 | **Adopt anti-rationalization table pattern across top 20 Artibot skills** | `plugins/artibot/skills/{spec-format,tdd-workflow,production-code-audit,code-slop-reviewer,systematic-debugging,verification-completion,quality-framework,coding-standards,security-standards,testing-standards,tool-design,prompt-engineering,delegation,multi-agent-patterns,memory-management,strategic-compact,fp-refactor,ddd-tactical-design,clarify,polish}/SKILL.md` — append `## Common Rationalizations` and `## Red Flags` sections | Each modified SKILL.md includes both sections; `tests/skills/anti-rationalization.test.js` (new) asserts presence for the 20 selected files |
| 2 | **Port sdd-cache to ESM Node** with WebFetch HTTP-304 revalidation, local-only storage in `runtime/cache/webfetch/` | New: `plugins/artibot/scripts/hooks/webfetch-cache-pre.js`, `webfetch-cache-post.js`; update `plugins/artibot/hooks/hooks.json` to register PreToolUse + PostToolUse on `WebFetch`; update `.gitignore`; new `plugins/artibot/docs/webfetch-cache.md` | Manual smoke test: fetch react.dev page twice, second fetch returns cached body via 304; cache file exists under `runtime/cache/webfetch/<sha>.json`; vitest case for hash key + ETag round-trip |
| 3 | **Add `source-driven-development` skill** (DETECT → FETCH → IMPLEMENT → CITE) and wire it as auto-invoke when prompts mention framework names | New: `plugins/artibot/skills/source-driven-development/SKILL.md` (level 2, triggers: framework, library, docs, deprecated, current best practice, official docs, MDN); update `plugins/artibot/skills/index.json` if present; reference from `lib/cognitive/router.js` keyword list | New skill validates against schema; `tests/skills/source-driven-development.test.js` checks frontmatter + Process section; hook A3 from action #2 makes it cheap |
| 4 | **Inject `using-agent-skills` discovery flowchart at SessionStart** when no skill is already active | Update `plugins/artibot/scripts/hooks/session-start.js` to read `plugins/artibot/skills/using-agent-skills/SKILL.md` and emit a low-priority context block (only first session of the day or when SKILL_INDEX env unset); ensure `toFileUrl()` is used for the import on Korean paths | Existing session-start tests still pass; new test asserts skill discovery block present in stdout JSON when no recent skill activity in last 24h |
| 5 | **Refresh AGENTS.md with the three-layer model** (Skills = how, Personas = who, Commands = when) and add `whenNotToUse` schema field to skills | Update `plugins/artibot/AGENTS.md` (rewrite "Orchestration" section); update `plugins/artibot/schemas/skill.schema.json` to add optional `whenNotToUse` string field; add a non-blocking validator warning in `scripts/hooks/skill-validation-check.js` for skills missing the field | AGENTS.md has the new three-layer table; `npm run lint:skills` (or equivalent) emits warning count > 0 then = 0 after backfill PR |

## Closing note

The 2026-04-15 benchmark put Artibot at 82/100 against five repos at 38-62. agent-skills lands at 71 — the highest external score we have seen — because it concentrates on a single thing (skill prose + lifecycle commands) and does it with unusual rigour. Artibot still wins overall by virtue of breadth (102 vs 21 skills, 52 vs 4 hooks, full Agent Teams + learning loop + tests + marketing phase), but loses on three things worth fixing: (a) skill-prose discipline (anti-rationalization tables, "when NOT to use"), (b) the two genuinely novel hooks (sdd-cache, simplify-ignore), and (c) the meta-skill auto-injection. None of these threaten the DEV protocol, hook system, agent coordination, ESM stance, or `toFileUrl()` workaround. All five Phase-2 actions are additive.
