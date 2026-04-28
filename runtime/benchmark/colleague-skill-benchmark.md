# Repo Benchmark: colleague-skill (dot-skill) vs Artibot

| Field | Value |
|---|---|
| Target | titanwings/colleague-skill (rebrand: dot-skill) |
| Source | /tmp/artibot-bench/colleague-skill/ |
| Commit window | v1.0.x, README dated 2026-04-22 |
| Baseline | Artibot plugin v3.0.0 (plugins/artibot/) |
| Date | 2026-04-28 |
| Analyst | repo-benchmarker |

## 1. TL;DR

| Verdict | Detail |
|---|---|
| Overall score | Artibot 84/100, dot-skill 56/100 (Artibot wins by +28) |
| Adoption verdict | Adopt persona-distillation pattern (6-layer Persona) + Correction layer + work/persona two-doc split + versions/ archive layout. Reject all data-source collectors (Feishu/DingTalk/Slack/WeChat) due to DATA POLICY violation. |
| Novel pattern | Distill any person into a Skill via source material + tags, with 6-layer Persona schema (Layer 0 hard rules through Layer 5 boundaries) plus a Correction layer that takes effect immediately. Genuinely novel; Artibot persona-* skills are static templates. |
| Risk | Repo is Python-only, prompt-heavy, no hooks / no agent teams; pulls external chat platforms by default. Adoption must be LOCAL-ONLY (file/paste-only intake). |
| Top action | Add a persona-distill meta-skill to Artibot that converts user-supplied local source files (no external APIs) into a 6-layer persona override for any existing persona-* skill. |

## 2. Repository Overview

| Aspect | Value |
|---|---|
| Purpose | Meta-skill engine that distills anyone (colleague / relationship / celebrity) into an invocable Skill via prompt pipeline + tagged taxonomy. |
| Scale | 1 SKILL.md (1463 lines), 16 prompt files across 3 character families, 19 Python tools, 7 Python tests, 1 CI workflow, 7 README translations, 3 example skills. No agents, no hooks, no JS lib. |
| Differentiator | (a) 6-layer Persona schema with Layer-0 hard-priority and an evolving Correction layer; (b) tag-to-behavior translation table (e.g. blame-shifter tag maps to 3 concrete behavioral rules); (c) host-portable SKILL.md with explicit no-guess-host-cd execution rule across Claude Code / OpenClaw / Hermes / Codex; (d) celebrity 6-dimension research pipeline (writings / interviews / decisions / expression DNA / external eval / timeline). |
| License | MIT |
| Data dependence | Heavy: Feishu API, DingTalk browser, Slack SDK, WeChat SQLite, Whisper, OAuth flows. Direct conflict with Artibot DATA POLICY for any non-local source. |
| Architecture | Single SKILL.md driving prompt to analyzer to builder to writer pipeline; outputs work.md + persona.md + meta.json per generated skill. No team/swarm/hook layer. Python unittest-only test stack. |

## 3. 10-Dimension Scoring

| # | Dimension | Weight | Artibot | dot-skill | Delta | Winner |
|---|---|---:|---:|---:|---:|---|
| 1 | Skill quality | 15% | 9 | 8 | +1 | A |
| 2 | Agent design | 10% | 9 | 1 | +8 | A |
| 3 | Hook ergonomics | 10% | 9 | 0 | +9 | A |
| 4 | Lifecycle coverage | 10% | 9 | 5 | +4 | A |
| 5 | Documentation | 10% | 8 | 9 | -1 | T |
| 6 | Test coverage | 10% | 8 | 7 | +1 | A |
| 7 | Innovation | 10% | 7 | 9 | -2 | T |
| 8 | Reusability | 10% | 8 | 7 | +1 | A |
| 9 | DATA POLICY compliance | 10% | 10 | 2 | +8 | A |
| 10 | DNA fit (DEV / ESM / Ko-path / Node>=18) | 5% | 10 | 1 | +9 | A |
|   | WEIGHTED TOTAL | 100% | 84 | 56 | +28 | A |

### Scoring rationale (evidence-backed)

| # | Dimension | Score basis |
|---|---|---|
| 1 | Skill quality | dot-skill SKILL.md is 1463 lines of well-structured bilingual flow with explicit step-by-step prompts; Artibot has 102 modular skills with frontmatter (triggers, allowed-tools, category, source_hash) and Rationalizations tables. Artibot edges out on breadth + frontmatter rigor; dot-skill wins on depth-per-skill. |
| 2 | Agent design | Artibot has 29 agents with model policy (Opus/Sonnet) and TeamCreate. dot-skill has zero agents; flow is purely prompt-driven inside one SKILL.md. |
| 3 | Hook ergonomics | Artibot has 52 hooks (PreToolUse / PostToolUse / Stop). dot-skill has zero, no event/lifecycle interception. |
| 4 | Lifecycle coverage | Artibot covers DEV protocol, prompt cache, GRPO, swarm. dot-skill covers create -> evolve -> correct -> version-rollback (genuine 4-stage lifecycle on the generated skill, but no engine-level lifecycle). |
| 5 | Documentation | dot-skill: 7-language README, PRD.md, ROADMAP.md, INSTALL.md, technical paper PDF, 3 worked examples. Artibot: skill-level docs strong but lacks comparable user-facing onboarding/translation set. dot-skill wins narrowly. |
| 6 | Test coverage | dot-skill: 7 Python unittest files (~60KB total) covering CLI lifecycle, skill writer, install paths, research tools. Artibot: 5183 passing tests per memory record. Artibot wins on volume; dot-skill wins on test-to-code ratio for its scope. |
| 7 | Innovation | dot-skill ships 3 truly novel patterns: 6-layer Persona, tag-to-behavior translation table, immediate-effect Correction layer. Artibot innovations (DEV protocol, swarm intel, Ko-path fix) are stronger systemically but persona-distillation as anyone-to-skill is the more eye-catching single idea. |
| 8 | Reusability | Artibot is reusable across any codebase via plugin-install. dot-skill outputs are reusable across hosts (Claude Code / Hermes / OpenClaw / Codex) but the engine itself is single-purpose. |
| 9 | DATA POLICY | Artibot keeps everything local. dot-skill ships 5 external-network collectors as default-recommended path; OAuth tokens, Feishu/DingTalk/Slack APIs, MCP App Token. Score 2 (not 0) because file-paste / PDF / .eml / SQLite-export paths are local-only. |
| 10 | DNA fit | dot-skill is Python 3.9+, no ESM, no hooks, no DEV protocol. Score 1 because the prompt-driven pattern (no code change required) can be re-expressed as Markdown-only skills. |

## 4. Adoptable Elements (prioritized, LOCAL-ONLY variants)

| # | Element | Source | Adoption target in Artibot | Effort | Priority |
|---|---|---|---|---|---|
| 1 | 6-layer Persona schema (Layer 0 hard-rules through Layer 5 boundaries) | prompts/persona_builder.md | New skill plugins/artibot/skills/persona-distill/SKILL.md + reference references/six-layer-persona.md | LOW | HIGH |
| 2 | Tag-to-behavior translation table | prompts/persona_analyzer.md (tag tables) | Add references/tag-behavior-map.md to persona-distill, support Artibot-specific tags (DEV-strict / TDD-first / refactor-first / Ko-path-aware) | LOW | HIGH |
| 3 | Correction-layer pattern (immediate-effect overrides) | prompts/correction_handler.md | Hook into existing persona-* skills via a corrections/{skill-slug}.md overlay file; lib/learning/memory-manager.js already has overlay infra | MEDIUM | HIGH |
| 4 | work.md + persona.md two-doc split (Part A capability / Part B character) | tools/skill_writer.py SKILL_MD_TEMPLATE | Recommend Artibot persona-* skills carry an optional work.md sibling for capability profile, separate from persona attitude | LOW | MEDIUM |
| 5 | versions/ archive + rollback CLI | tools/version_manager.py (MAX_VERSIONS=10) | Add lib/core/skill-versioner.js that snapshots a generated persona on update; integrate with existing lib/core/skill-exporter.js | MEDIUM | MEDIUM |
| 6 | Six-dimension research dossier (writings / interviews / decisions / expression DNA / external eval / timeline) | prompts/celebrity/research.md | Re-frame as code-author distillation: writings = commits, interviews = code reviews, decisions = ADRs, expression DNA = naming/comments, external eval = PR feedback, timeline = git history. Useful for architect/code-reviewer agents to mimic a senior engineer voice. | HIGH | MEDIUM |
| 7 | Diagnostic sub-flow for vague intents (you have not named a person, let me help) | prompts/celebrity/intake.md | Add to persona-distill and to /team planner to recommend personas when user describes a need without naming a role | LOW | MEDIUM |
| 8 | Source quality hierarchy + blacklist | prompts/celebrity/research.md | Generalize to Artibot research-flow skill: prefer first-person (commits, ADRs) over secondhand (Wikipedia, content farms) | LOW | LOW |
| 9 | Host-portable SKILL.md with no-guess-host-paths guard | SKILL.md (Execution Root section) | Already partially handled by Artibot toFileUrl() Ko-path workaround; consider adding a no-cd-guess directive to Artibot skill template | LOW | LOW |
| 10 | Bilingual SKILL.md split (top: detect language, then ZH then EN) | SKILL.md lines 1-30 | Useful since Artibot user is Korean-primary; could template KO + EN skills the same way | LOW | LOW |

## 5. Reject List (DATA POLICY or DNA conflict)

| # | Element | Reason | Hard-blocker? |
|---|---|---|---|
| R1 | tools/feishu_auto_collector.py (28KB) Feishu API + tenant_access_token + user OAuth | External SaaS API call with user-auth tokens. Direct DATA POLICY violation. | YES |
| R2 | tools/dingtalk_auto_collector.py (36KB) DingTalk browser scrape via Playwright | Sends user data through DingTalk; browser-automation creds stored locally but data leaves boundary. | YES |
| R3 | tools/slack_auto_collector.py (26KB) Slack SDK Bot token | External SaaS; admin install required; data crosses Slack servers. | YES |
| R4 | tools/feishu_mcp_client.py + tools/feishu_browser.py | Same as R1 plus 3rd-party MCP server dependency. Per DATA POLICY: external plugin connection forbidden. | YES |
| R5 | tools/research/transcribe_audio.py calls Whisper API or Whisper local | External API path is blocked. Local-only Whisper variant could be considered, but adds heavy Python+ML deps that violate Artibot zero-dep / ESM-only stance. | YES |
| R6 | requirements.txt (Python 3.9+, requests, playwright, slack-sdk, pypinyin, python-docx, openpyxl) | Artibot is ESM Node>=18; importing Python toolchain breaks DNA. Re-implement adoption candidates in JS only. | YES |
| R7 | Multi-host install scripts (install_hermes_skill.py, install_openclaw_*.py, install_codex_*.py) | Artibot ships its own install path; cross-host install is a different design problem. | NO (skip, not block) |
| R8 | celebrity character family marketing language and example public figures | Reputation/PR risk, copyright on long-form content; Artibot use case is engineering personas, not public-figure cosplay. | NO (rebrand to engineer-archetype) |
| R9 | Tag library entries that are workplace-political (PUA-master, emotional-blackmailer, passive-aggressive, upward-management-expert) | Misaligned with Artibot quality enforcement tone; encourages anti-patterns when distilling. | NO (filter; keep neutral subset) |
| R10 | colleague_skill.pdf paper as runtime artifact | 175KB binary in repo root; documentation belongs in docs/ only. Pattern, not blocker. | NO |

## 6. Diff / Gap Analysis vs Artibot

| Dimension | Artibot | dot-skill | Gap (what each lacks) |
|---|---|---|---|
| Engine type | Plugin (hooks + agents + skills + commands) | Single meta-skill (prompts + Python tools) | dot-skill lacks event lifecycle; Artibot lacks anyone-to-skill generator |
| Skill count | 102 production skills | 1 meta-skill (with 16 sub-prompts) | Different shape; comparison meaningless without normalization |
| Persona depth | Each persona-* skill is static (~50-150 lines) with Rationalizations table | 6-layer schema with Layer-0 priority + Correction overlay | Artibot personas are deeper on advice quality, dot-skill personas are deeper on behavioral fidelity |
| Evolution | Skill bumps require manual edit + commit | --correction-json writes immediately to Correction layer | Artibot lacks runtime persona override |
| Versioning | Skills versioned via git only | Per-skill versions/ dir, max 10 archived, CLI rollback | Artibot lacks per-skill rollback (whole-repo rollback only) |
| Source ingestion | Manual edits | Multi-source collector (mostly external) + paste/PDF/eml/SQLite (local) | Artibot has no ingestion pipeline; dot-skill local-only subset is the adoptable piece |
| Tag taxonomy | None; skills are role-named (persona-architect, persona-security) | Tag library + tag-to-behavior table | Artibot lacks composable tag layer |
| Output format | Single SKILL.md per skill | SKILL.md (router) + work.md + persona.md + meta.json | Artibot persona-* could optionally split into work/persona |
| Test stack | Node test runner, 5183 passing | Python unittest, 7 files | Stack mismatch; cannot share tests |
| Hooks | 52 hooks across PreToolUse / PostToolUse / Stop | None | dot-skill lacks any |
| Agent teams | 29 agents, TeamCreate, parallel | None; single thread | dot-skill lacks any |
| DEV protocol | Mandatory | Absent (free-form prompt flow) | dot-skill lacks any |
| Internationalization | KO/EN mixed; output-style for KO tables | 8-language README; bilingual SKILL.md (ZH/EN auto-detect) | Artibot can adopt bilingual skill template |
| Validation | Hooks + lib tests | Ruff (non-blocking) + unittest matrix on Py3.9/3.11 | Comparable in coverage of own scope |
| Examples | Skills self-document | 3 worked example skills | Artibot could ship example outputs |

## 7. Top 5 Concrete Actions

| # | Action | Files to add/modify | Owner agent | Effort | Verification |
|---|---|---|---|---|---|
| 1 | Add persona-distill meta-skill (LOCAL-ONLY); converts user-pasted source material + tag set into a 6-layer persona override for any existing persona-* skill. Block external network in skill frontmatter (allowed-tools: [Read, Write, Edit], no Bash-network). | New: plugins/artibot/skills/persona-distill/SKILL.md, references/six-layer-persona.md, references/tag-behavior-map.md. Wire into lib/core/skill-exporter.js. | llm-architect + persona-architect | M | New skill loads; intake flow asks 3 questions; output is a valid 6-layer markdown that overlays an existing persona-* skill |
| 2 | Implement Correction overlay system; plugins/artibot/runtime/corrections/(skill-slug).md loaded after the base skill, takes priority. Add CLI artibot correct (skill) (scene) (wrong) (right). | New: lib/core/correction-overlay.js, bin/artibot-correct.js. Hook into existing lib/learning/memory-manager.js. | backend-developer + tdd-guide | M | Correction file written; next skill invocation reflects override; artibot rollback-correction restores |
| 3 | Add per-skill version archive; versions/v1/, versions/v2/ directories beside any generated/edited skill; MAX_VERSIONS=10; CLI artibot skill rollback (slug) (version). | New: lib/core/skill-versioner.js, bin/artibot-skill-rollback.js. Test via existing test runner. | backend-developer | M | Editing a skill snapshots prior; rollback restores files; eleventh edit prunes oldest |
| 4 | Add tag-driven behavior translation to all persona-* skills; extend frontmatter with tags array, add references/tag-behavior-map.md (Artibot-flavored: dev-strict, tdd-first, ko-path-aware, zero-dep, refactor-first, swarm-coordinator). Update tdd-guide and architect skills to consume tags. | Modify 11 persona-* SKILL.md files; new references/tag-behavior-map.md shared. | persona-architect + doc-updater (parallel team) | M | All 11 personas pass validate-skill-frontmatter.js; tag application produces measurable persona delta |
| 5 | Add bilingual KO/EN SKILL.md template + no-cd-guess execution-root directive; port dot-skill pattern of putting language-detect and execution-root rules at the top of every SKILL.md. Useful given Korean-primary user + Ko-path bug history. | Modify plugins/artibot/skills/_template/SKILL.md; touch top-3 most-used persona skills as pilot. | doc-updater | S | Template change validated; KO-prompt user gets KO output; bash commands no longer prepend cd to guessed host paths |

## Appendix A: File-Path Index (load-bearing only)

| Path | Why it matters |
|---|---|
| /tmp/artibot-bench/colleague-skill/SKILL.md | The 1463-line meta-skill router. Lines 1-30 = bilingual + execution-root pattern; lines 700-900 = English mirror flow; lines 1170-1200 = management ops |
| /tmp/artibot-bench/colleague-skill/prompts/persona_builder.md | The 6-layer Persona schema canonical template. Adopt verbatim into references/six-layer-persona.md |
| /tmp/artibot-bench/colleague-skill/prompts/persona_analyzer.md | Tag-to-behavior translation table (filter and re-flavor for Artibot) |
| /tmp/artibot-bench/colleague-skill/prompts/correction_handler.md | Correction overlay routing (Work vs Persona) + max-50-correction-merge rule. Adopt as lib/core/correction-overlay.js design spec |
| /tmp/artibot-bench/colleague-skill/prompts/merger.md | Incremental-merge logic (append-only with conflict prompt). Useful for skill-versioner conflict UX |
| /tmp/artibot-bench/colleague-skill/prompts/celebrity/research.md | 6-dimension research dossier + source blacklist. Re-purpose for code-author distillation |
| /tmp/artibot-bench/colleague-skill/tools/version_manager.py | MAX_VERSIONS=10, versions/ layout, rollback CLI shape. Mirror in lib/core/skill-versioner.js |
| /tmp/artibot-bench/colleague-skill/tools/skill_writer.py | The PART A: Work / PART B: Persona / Operating Rules output template |
| /tmp/artibot-bench/colleague-skill/tools/skill_schema.py | SCHEMA_VERSION=3 + PRIMARY_ARTIFACTS tuple; design hint for Artibot skill schema versioning |
| /tmp/artibot-bench/colleague-skill/skills/colleague/example_jiaxiu/persona.md | Worked example showing 6-layer fill-in quality. Use as fixture in tests |
| Artibot baseline persona-architect SKILL.md | Current persona schema lacks Layer 0 / Correction overlay. Target for upgrade path |

## Appendix B: DATA POLICY Checklist for Adoption

| Check | Status |
|---|---|
| No external API calls (Feishu / DingTalk / Slack / Whisper API) | REQUIRED; drop all auto_collector scripts, feishu_mcp_client.py, transcribe_audio.py |
| No 3rd-party MCP server connection from adopted code | REQUIRED; feishu_mcp_client.py rejected |
| All ingestion via local files only (paste / PDF / .eml / .md / SQLite-export) | OK to adopt as long as paths point to user-local filesystem |
| No cloud LLM call from skill (rely only on host LLM) | OK; dot-skill does this already |
| All persisted data under plugins/artibot/runtime/ | REQUIRED; mirror via Artibot path conventions, not host-specific skill dirs |
| ESM-only / Node>=18 / no Python runtime added | REQUIRED; re-implement adopted Python in JS |
| Korean path safe (toFileUrl() usage preserved) | REQUIRED; verify any new file URL goes through lib/core/utils/index.js |
| DEV protocol (Decompose-Execute-Verify) applied to adoption work | REQUIRED; every adoption PR must show DEV evidence |
