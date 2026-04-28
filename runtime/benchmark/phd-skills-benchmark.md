# phd-skills vs Artibot — Benchmark Report

| Field | Value |
|-------|-------|
| Target repo | phd-skills v1.1.0 (https://github.com/fcakyon/phd-skills) |
| Baseline | Artibot plugin v3.0.0 (plugins/artibot/) |
| Date | 2026-04-28 |
| Analyst | repo-benchmarker |
| Source (target) | /tmp/artibot-bench/phd-skills/ |
| Source (baseline) | C:/Users/nowhe/OneDrive/바탕 화면/AI/artibot/plugins/artibot/ |

---

## 1. TL;DR

| Line | Value |
|------|-------|
| Score | phd-skills 57/100 vs Artibot baseline 84/100 (weighted) |
| Top adoption candidate | type:prompt hooks for Stop and UserPromptSubmit (4 lines per check, no shell script) — pairs with DEV verify gate |
| Top reject | External notification calls in notify.sh (ntfy.sh / Slack webhooks) — direct DATA POLICY violation, must be LOCAL-ONLY variant if adopted |

---

## 2. Repository Overview

| Aspect | phd-skills | Artibot |
|--------|------------|---------|
| Purpose | Research integrity (PhD paper auditing, citations, experiments, LaTeX) | Autonomous Agent OS for software development |
| Skills | 8 | 102 |
| Agents | 2 | 29 |
| Commands | 6 | 57 |
| Hook entries | 6 (across 5 events) | 52 hook scripts (across full lifecycle) |
| Lib JS files | 0 | 228 |
| Scripts | 5 bash | 52 ESM Node hooks plus 228 lib modules |
| External deps | None (zero-dep, no MCP required) | None at runtime; CI uses dev deps |
| Differentiator | Prompt-type hooks; agent-level isolation:worktree; methodology-first SKILL bodies | Agent Teams orchestration, GRPO learning, federated swarm, lifecycle phases, Korean-path bug workaround, 102 reusable skills |
| Domain orthogonality | High — academic research workflow | High — software dev workflow |

The repos are non-overlapping by domain. phd-skills is a focused vertical (8 skills, 2 agents) targeting paper writing; Artibot is a horizontal OS. Comparison is meaningful at the pattern / mechanism layer, not feature parity.

---

## 3. 10-Dimension Scoring

| # | Dimension | phd-skills | Artibot | Delta | Winner | Rationale |
|---|-----------|-----------:|--------:|------:|:------:|-----------|
| 1 | Skill quality | 8 | 9 | -1 | A | phd skills are dense methodology bodies (avg 117 lines, no fluff); Artibot has more skills but variable density |
| 2 | Agent design | 7 | 9 | -2 | A | phd uses isolation:worktree, memory:project, agent-level Stop hooks (novel); Artibot has 29 specialized agents in orchestrator/expert/builder/support tiers with model policy |
| 3 | Hook ergonomics | 9 | 7 | +2 | T | phd type:prompt hooks are 4-line declarative integrity checks vs Artibot executable Node scripts; UserPromptSubmit ambiguity guard is genuinely novel |
| 4 | Lifecycle coverage | 6 | 9 | -3 | A | phd: PreToolUse, PostToolUse, Stop, UserPromptSubmit, Notification, PreCompact; Artibot adds SessionStart/Stop/SubagentStop/SessionEnd plus 52 scripts vs 5 |
| 5 | Documentation | 8 | 8 | 0 | = | phd README is exemplary (table-driven, real incidents to guardrail mapping); Artibot has CLAUDE.md, AGENTS.md, CHANGELOG, richer corpus |
| 6 | Test coverage | 1 | 8 | -7 | A | phd has zero tests, no CI, no validation scripts; Artibot has 5183 passing tests, eslint config, release validation chain |
| 7 | Innovation | 7 | 8 | -1 | A | phd: prompt-type hooks, agent worktree isolation, real-incident-driven guardrails; Artibot: Agent Teams, GRPO, federated swarm, cognitive router, DNA |
| 8 | Reusability | 4 | 9 | -5 | A | phd is research-only; skills mention LaTeX/wandb/neptune by name; Artibot skills are domain-agnostic dev workflows |
| 9 | DATA POLICY compliance | 5 | 10 | -5 | A | phd notify.sh sends to ntfy.sh and Slack webhooks; factcheck/xray use WebSearch/WebFetch on DBLP; Artibot has zero external send |
| 10 | DNA fit (Artibot) | 4 | 10 | -6 | A | phd skills are PhD-domain bound, will not slot into spec-plan-build-review-ship-marketing; only patterns transfer |
|   | Total (unweighted) | 59 | 87 | -28 | A | sum |
|   | Total (weighted) | 57 | 84 | -27 | A | weights below |

Weights (sum 100): Skill 10, Agent 10, Hook 15, Lifecycle 10, Docs 5, Tests 10, Innovation 15, Reusability 10, DataPolicy 10, DNA 5. Hook plus Innovation weighted higher because that is where phd-skills can teach Artibot something new.

---

## 4. Adoptable Elements (Prioritized)

| # | Element | Why adopt | Where in Artibot | Source path | Effort | Risk |
|---|---------|-----------|------------------|-------------|-------:|------|
| A1 | type:prompt hooks for Stop and UserPromptSubmit | Declarative integrity gates with no script process; lets DEV verify-gate be enforced via hook config | plugins/artibot/hooks/hooks.json (add Stop prompt hook for DEV checklist) | plugin/hooks/hooks.json (Stop, UserPromptSubmit blocks) | S | Low — additive, fully declarative |
| A2 | Ambiguity guard on UserPromptSubmit (if message under 5 words and could be ambiguous, confirm before destructive action) | Prevents the done-typed-as-dont class of accidents; complements auto-team trigger logic | New hook entry in hooks.json (pure prompt-type) | plugin/hooks/hooks.json UserPromptSubmit block | S | Low — only adds friction on truly short prompts |
| A3 | Agent-level frontmatter: isolation:worktree plus memory:project plus hooks: block | Lets specific agents (quality-reviewer, code-reviewer, repo-benchmarker) run isolated and accumulate per-project memory | plugins/artibot/agents/quality-reviewer.md, code-reviewer.md, repo-benchmarker.md frontmatter | plugin/agents/paper-auditor.md head | M | Medium — depends on Claude Code support; verify schema first |
| A4 | PreCompact state-save with directory plus git-branch plus git-status snapshot | Artibot already has pre-compact.js but phd snapshot includes git branch and working-tree status to a markdown file | Extend plugins/artibot/scripts/hooks/pre-compact.js to emit structured state file | plugin/scripts/save_state.sh | S | Low — Artibot already has the slot |
| A5 | Visual-output reminder hook (PostToolUse Bash) — when command produces images, force the assistant to Read the file | Artibot has no equivalent; addresses trusts-metrics-never-looks-at-plot failure mode in any artifact-generating workflow | New hook plugins/artibot/scripts/hooks/visual-check.js (Node port); register on PostToolUse Bash | plugin/scripts/visual_check.sh | S | Low — advisory only, exits 0 |
| A6 | 5-parallel-sub-agent pattern in /xray (numerical / terminology / code-paper / citation / evaluation) | Artibot Agent Teams already supports this; codify as reusable command template for audit-X-across-N-dimensions | plugins/artibot/skills/production-code-audit/ — add multi-dimension parallel template | plugin/commands/xray.md Step 2 | M | Low — composes with existing Team API |
| A7 | README real-incident-to-guardrail mapping table | Drives credibility; users see why each rule exists | plugins/artibot/AGENTS.md or new docs/INCIDENTS.md | README.md What-You-Get with Real-incident column | S | Low — pure docs |
| A8 | /help self-discovery command that reads plugin structure dynamically | Lower-friction onboarding; Artibot has scattered docs but no single in-session listing | plugins/artibot/commands/help.md (read agents/skills/commands dirs at runtime) | plugin/commands/help.md | S | Low — pure read |
| A9 | AskUserQuestion setup wizard pattern (/setup) — interactive multi-feature toggle | Artibot has CLAUDE.local.md template but no guided onboarding; helps non-dev users | New: plugins/artibot/commands/onboard.md | plugin/commands/setup.md | M | Low — additive |
| A10 | Citation-style guard for any structured edit (PreToolUse Edit/Write matcher with file-extension switch) | Generalize the .tex/.bib pattern: per-extension reminders (.test.js to assert-first reminder, .sql to schema-verify reminder) | plugins/artibot/scripts/hooks/edit-guard.js (extension-routed reminders) | plugin/scripts/citation_guard.sh | M | Low — purely advisory |

---

## 5. Reject List

| Item | Reason | Action |
|------|--------|--------|
| notify.sh calling https://ntfy.sh/$NTFY_TOPIC | DATA POLICY violation: external host receives session metadata | REJECT external HTTP. Build LOCAL-ONLY variant (file write to runtime/notifications/, optional OS-native notify-send / Windows toast — no network) |
| notify.sh Slack webhook (SLACK_WEBHOOK_URL) | Same — external POST to slack.com | REJECT |
| notify.sh email via msmtp / sendmail | DATA POLICY edge case: relays through external SMTP | REJECT in default config; allow only on explicit local-relay opt-in |
| factcheck/xray agents using WebSearch/WebFetch on DBLP/arXiv/Google Scholar | Outbound query leaks paper content fragments to third parties | LIMIT: gate behind --allow-external flag; default to local-only |
| paper-auditor isolation:worktree if Claude Code schema does not support it | Unknown key may be silently ignored | VERIFY schema first; if unsupported, fall back to working-directory note |
| Bash-only scripts (citation_guard.sh, latex_check.sh, visual_check.sh, save_state.sh, notify.sh) | Artibot supports Windows; bash hooks fail on cmd.exe | REJECT direct adoption; Node-port any element worth keeping (A4, A5, A10) |
| pdflatex -interaction=nonstopmode invocation in latex_check.sh | Heavy external dep, irrelevant to dev domain | REJECT — not in scope |
| Sourcing $HOME/dev/phd-data-engine/.env in notify.sh | Hardcoded path leak from author machine; secret-loading anti-pattern | REJECT |
| Storing state in $HOME/.claude/research-state.md (single global file) | Race-condition between projects; Artibot uses per-project runtime/ | If A4 adopted, store in runtime/state/pre-compact-TIMESTAMP.md |
| Methodology skills hard-bound to PhD vocab (LaTeX, ablation, wandb, neptune, DBLP) | Not reusable for Artibot users | REJECT skill bodies as-is; only structural patterns transfer |

---

## 6. Diff / Gap Analysis

### What Artibot has that phd-skills does not

| Capability | Notes |
|------------|-------|
| Agent Teams orchestration (TeamCreate, SendMessage, TaskCreate) | phd has only static sub-agent dispatch via Agent tool in /xray |
| 29 specialized agents with Opus/Sonnet model policy | phd has 2 agents, model:inherit |
| 102 skills covering full SDLC | phd has 8 PhD-vertical skills |
| GRPO learning, federated swarm intelligence, lifelong-learner | phd has no learning loop |
| Cognitive router (System 1 / System 2 classification) | absent in phd |
| 5183 passing tests, ESLint, release CI chain | phd has zero tests |
| Korean-path bug workaround (toFileUrl in lib/core/utils/index.js) | phd is bash-only, Windows-unsupported |
| Lifecycle phases (spec to plan to build to review to ship to marketing) | phd has no phase model |
| ESM plus Node runtime hooks | phd uses bash plus jq |
| Lib modules (228 JS files: cache, config, debug, IO, learning, cognitive, TUI) | phd has zero lib code |
| AGENTS.md alias, claim-validator, ai-slop-reviewer (from prior benchmarks) | phd has none |
| runtime/ per-project artifact store | phd writes to global ~/.claude/ |
| MCP integration | phd explicitly avoids MCP |

### What phd-skills has that Artibot does not

| Capability | Source | Adoptable? |
|------------|--------|------------|
| type:prompt hook (declarative integrity prompt as hook payload) | plugin/hooks/hooks.json Stop block | Yes — A1 |
| UserPromptSubmit ambiguity guard | same | Yes — A2 |
| Agent-level isolation:worktree, memory:project, hooks: frontmatter keys | plugin/agents/paper-auditor.md | Yes if schema supports — A3 |
| Visual-output forced-inspect hook | plugin/scripts/visual_check.sh | Yes — A5 |
| 5-dimension parallel audit recipe | plugin/commands/xray.md | Pattern only — A6 |
| Real-incident to guardrail traceability table in README | README.md | Yes — A7 |
| /help runtime self-discovery | plugin/commands/help.md | Yes — A8 |
| AskUserQuestion-driven setup wizard | plugin/commands/setup.md | Yes — A9 |
| Per-extension PreToolUse reminder routing (.tex/.bib to citation reminder) | plugin/scripts/citation_guard.sh | Generalize — A10 |
| CronCreate / CronList / CronDelete tools in agent frontmatter | plugin/agents/experiment-analyzer.md tools line | Possible if Claude Code supports cron tools natively |
| State-save before context compaction with git status snapshot | plugin/scripts/save_state.sh | Extend existing pre-compact — A4 |
| argument-hint field in command frontmatter | plugin/commands/fortify.md, gaps.md | Trivial — verify if Artibot already supports |
| Incident-driven design philosophy (every guardrail traces to a real mistake) | README | Cultural — apply to Artibot CHANGELOG entries |

---

## 7. Top 5 Concrete Actions for Autopilot Phase 2

| # | Action | File(s) | Effort | Owner |
|---|--------|---------|-------:|-------|
| 1 | Add type:prompt Stop hook that enforces DEV verify checklist (Decompose-Execute-Verify) — declarative, no executable | plugins/artibot/hooks/hooks.json (new Stop block); update docs/HOOKS.md | S | architect to builder |
| 2 | Add UserPromptSubmit ambiguity-guard prompt hook for prompts under 5 words OR detected destructive ambiguity — gates auto-team triggers | plugins/artibot/hooks/hooks.json (new UserPromptSubmit block); add unit test in plugins/artibot/test/hooks/ambiguity-guard.test.js | S | architect to tdd-guide |
| 3 | Port visual_check.sh to Node ESM and register on PostToolUse Bash matcher — advisory reminder when command output mentions image files (.png/.svg/.pdf/.jpg) | new plugins/artibot/scripts/hooks/visual-check.js; entry in plugins/artibot/hooks/hooks.json PostToolUse | S | builder |
| 4 | Extend plugins/artibot/scripts/hooks/pre-compact.js to write structured state file (timestamp plus cwd plus branch plus git status --short) into runtime/state/pre-compact-ISO.md — per-project, not global | edit plugins/artibot/scripts/hooks/pre-compact.js; add test | S | builder |
| 5 | Add agent-level frontmatter probe: try isolation:worktree and memory:project on quality-reviewer.md and repo-benchmarker.md; if Claude Code respects them, propagate to all 29 agents | edit two agent files; verify via runtime probe; doc result in runtime/benchmark/agent-frontmatter-probe.md; if supported, batch-update remaining 27 agents | M | architect to builder |

Recommended sequencing: ship 1 plus 2 together (declarative-only, zero risk), then 3, then 4, then 5 (schema-dependent so investigate first).

---

## 8. Bottom Line

phd-skills is a vertical research-integrity plugin that scores 57/100 vs Artibot 84/100 — but its small surface lets it innovate on hook ergonomics and agent frontmatter expressiveness. Three patterns are immediately worth grafting onto Artibot: the type:prompt declarative hook (ships DEV verification as config not code), the UserPromptSubmit ambiguity guard (defends against done-as-dont class of mistakes), and the PostToolUse visual-inspect reminder (forces eyes-on-output in any artifact-generating flow). Everything else — notification webhooks, DBLP web fetches, bash-only scripts, PhD-domain skill bodies — is REJECT under DATA POLICY or Windows-compat constraints.

Net guidance: adopt 5 patterns (A1, A2, A4, A5, A8), reject 5 (notify.sh plus 4 bash dependencies), and treat the rest as inspirational rather than copy-paste targets.
