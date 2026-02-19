# Changelog

All notable changes to Artibot are documented in this file.

모든 주목할 만한 변경 사항은 이 파일에 기록됩니다.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

---

## [1.4.0] - 2026-02-19

### Quality Boost / 품질 향상

**English**: Major quality and infrastructure release. 874 tests passing at 91% coverage. Full CI/CD pipeline with ESLint v9 flat config. Progressive Disclosure skill system and Language Skills added.

**한국어**: 주요 품질 및 인프라 릴리즈. 874개 테스트 통과, 91% 커버리지. ESLint v9 flat config를 포함한 완전한 CI/CD 파이프라인. Progressive Disclosure 스킬 시스템 및 Language Skills 추가.

### Added / 추가됨
- **Test suite**: 874 tests passing with 91% coverage (statements, branches, functions, lines)
- **CI/CD pipeline**: `npm run ci` executes validate + lint + test in sequence
- **ESLint v9**: Flat config (`eslint.config.js`) for `lib/`, `scripts/`, `tests/`
- **ESLint scripts**: `npm run lint` and `npm run lint:fix`
- **Progressive Disclosure skill**: Complexity-tiered information delivery (Quick/Standard/Expert modes)
- **Language Skills**: Multi-language support framework for en/ko/ja with cultural adaptation
- **CONTRIBUTING.md**: Bilingual (en/ko) contributor guide
- **SECURITY.md**: Security policy with PII scrubber and privacy protection documentation
- **CHANGELOG.md**: Keep a Changelog format with bilingual entries

### Improved / 개선됨
- Test coverage increased from ~70% to 91%
- PII scrubber: added Windows-specific path patterns (Documents and Settings)
- Hook system: improved TeammateIdle detection latency
- CI validation scripts: stricter agent/skill/command MD structure checks

### Fixed / 수정됨
- `pii-scrubber.js`: false positive on Windows drive letter paths
- `memory-manager.js`: race condition in concurrent write operations
- `config.js`: environment variable override not propagating to sub-modules

---

## [1.3.0] - 2026-01-15

### Cognitive Architecture / 인지 아키텍처

**English**: Introduced Kahneman-inspired dual-process cognitive architecture with GRPO learning optimization, Knowledge Transfer between memory scopes, Federated Swarm Intelligence, and PII Scrubber for privacy protection.

**한국어**: Kahneman의 이중 처리 인지 아키텍처를 도입하였습니다. GRPO 학습 최적화, 메모리 스코프 간 지식 전달, 연합 집단 지능, PII 스크러버를 통한 개인정보 보호가 포함됩니다.

### Added / 추가됨
- **Cognitive Router** (`lib/cognitive/router.js`): Dual-process routing with adaptive threshold (default 0.4)
- **System 1** (`lib/cognitive/system1.js`): Fast intuitive processing (<100ms, confidence >= 0.6)
- **System 2** (`lib/cognitive/system2.js`): Deliberate analytical processing with sandbox (max 3 retries)
- **Cognitive Sandbox** (`lib/cognitive/sandbox.js`): Safe evaluation environment for System 2
- **GRPO Optimizer** (`lib/learning/grpo-optimizer.js`): Group Relative Policy Optimization for pattern scoring
- **Lifelong Learner** (`lib/learning/lifelong-learner.js`): Continuous learning with batch size 50
- **Knowledge Transfer** (`lib/learning/knowledge-transfer.js`): Promotes patterns at threshold 3, demotes at 2
- **Tool Learner** (`lib/learning/tool-learner.js`): Learns optimal tool selection from outcomes
- **Self Evaluator** (`lib/learning/self-evaluator.js`): Evaluates response quality for feedback signals
- **Memory Manager** (`lib/learning/memory-manager.js`): Three-scope memory (user/project/session)
- **PII Scrubber** (`lib/privacy/pii-scrubber.js`): 50+ regex patterns, platform-aware path detection
- **Federated Swarm Client** (`lib/swarm/swarm-client.js`): Differential privacy noise, offline queue, delta downloads
- **Pattern Packager** (`lib/swarm/pattern-packager.js`): Serializes learned patterns for aggregation
- **Sync Scheduler** (`lib/swarm/sync-scheduler.js`): Manages swarm sync intervals
- **Telemetry Collector** (`lib/system/telemetry-collector.js`): Opt-in only, zero default collection
- **Context Injector** (`lib/system/context-injector.js`): Injects learning context into agent prompts
- **TUI module** (`lib/core/tui.js`): Terminal UI utilities for progress display
- **Multi-model adapters**: Gemini, Codex, and Cursor adapters for cross-model compatibility
- **Memory scopes**: `user` (~/.claude/artibot/), `project` (.artibot/), `session` (in-memory)

### Changed / 변경됨
- `artibot.config.json`: Added `cognitive`, `learning`, and `swarm` configuration sections
- Agent routing: now passes through cognitive router before delegation mode selection
- `package.json`: version bumped to 1.3.0

### Fixed / 수정됨
- Memory manager: session scope now properly isolated from project scope
- GRPO optimizer: correct group normalization for small batch sizes

---

## [1.2.0] - 2025-11-20

### Marketing Features / 마케팅 기능

**English**: Added dedicated marketing agent team with content marketing, SEO, CRO, and advertising specializations. New commands for email, social media, presentations, and data analysis.

**한국어**: 콘텐츠 마케팅, SEO, CRO, 광고 전문화를 갖춘 전용 마케팅 에이전트 팀을 추가했습니다. 이메일, 소셜 미디어, 프레젠테이션, 데이터 분석을 위한 새 커맨드가 추가됩니다.

### Added / 추가됨
- **Marketing agents** (6 new):
  - `content-marketer`: Blog, SEO content, brand voice
  - `marketing-strategist`: Campaign strategy, market analysis
  - `data-analyst`: Metrics, conversion analysis, reporting
  - `presentation-designer`: PowerPoint/slides generation
  - `seo-specialist`: Technical SEO, keyword strategy
  - `cro-specialist`: Conversion rate optimization
  - `ad-specialist`: Paid advertising strategy
  - `repo-benchmarker`: Repository comparison and benchmarking
- **Marketing commands** (5 new):
  - `/mkt`: Marketing campaign orchestration
  - `/email`: Email campaign creation
  - `/social`: Social media content generation
  - `/ppt`: Presentation generation
  - `/excel`: Data analysis and spreadsheet generation
  - `/ad`: Advertising strategy and copy
- **Marketing playbooks** in `artibot.config.json`:
  - `marketing-campaign`: strategy -> plan -> create -> review -> launch
  - `marketing-audit`: scan -> assess -> optimize -> verify
  - `content-launch`: plan -> create -> review -> publish
  - `competitive-analysis`: research -> analyze -> synthesize -> report
- **`/sc` routing**: Marketing intent detection added to router

### Changed / 변경됨
- Model policy: marketing agents assigned to `haiku` tier (cost-efficient content tasks)
- Agent categories: new `support` category for marketing and utility agents
- `artibot.config.json`: marketing playbooks added to team playbooks

---

## [1.1.0] - 2025-09-05

### Agent Teams API Migration / Agent Teams API 마이그레이션

**English**: Migrated from Task() sub-agent delegation to Claude's native Agent Teams API. This is the foundational architectural change that makes Artibot uniquely capable compared to other Claude Code plugins.

**한국어**: Task() 서브에이전트 위임에서 Claude의 네이티브 Agent Teams API로 마이그레이션했습니다. 이 변경은 Artibot을 다른 Claude Code 플러그인과 차별화하는 핵심 아키텍처 변화입니다.

### Added / 추가됨
- **TeamCreate / TeamDelete**: Full team lifecycle management
- **SendMessage**: P2P bidirectional messaging (message, broadcast, shutdown_request/response, plan_approval)
- **TaskCreate / TaskUpdate / TaskList / TaskGet**: Shared task list for team coordination
- **Self-claim pattern**: Teammates autonomously claim tasks from TaskList
- **Plan approval workflow**: Teammates can submit plans for leader approval before execution
- **Delegation mode selection**: Automatic Sub-Agent (complexity < 0.4) vs Agent Team (>= 0.4) routing
- **Team levels**: Solo (0 teammates), Squad (2-4), Platoon (5+)
- **Orchestration patterns**: Leader, Council, Swarm, Pipeline, Watchdog
- **TeammateIdle hook**: `team-idle-handler.js` notifies idle teammates of pending tasks
- **SubagentStart/Stop hooks**: `subagent-handler.js` tracks agent lifecycle

### Changed / 변경됨
- `agents/orchestrator.md`: Full rewrite. Now uses TeamCreate, SendMessage, TaskCreate as primary tools
- `agents/*.md` (17 files): Added team collaboration tools section to all agent definitions
- `commands/orchestrate.md`: Rewritten to use TeamCreate-based workflows
- `commands/spawn.md`: Rewritten to use parallel Agent Teams spawning
- `skills/orchestration/SKILL.md`: Updated delegation mode selection criteria
- `skills/delegation/SKILL.md`: Renamed from "Sub-Agent Delegation" to "Delegation Strategies"
- `skills/*/references/*.md`: Added "Team Mode" column to all delegation matrix tables
- `artibot.config.json`: Added `team.engine`, `team.api`, `team.delegationModeSelection` sections
- `README.md`: Rewritten to center Agent Teams API architecture

### Removed / 제거됨
- Direct Task() sub-agent delegation as primary orchestration mechanism (retained for Solo mode)

---

## [1.0.0] - 2025-07-01

### Initial Release / 첫 번째 릴리즈

**English**: Initial public release of Artibot. A Claude Code plugin for intelligent development orchestration with 18 agents, 25 skills, 26 commands, and 10 hook event types.

**한국어**: Artibot 최초 공개 릴리즈. 18개 에이전트, 25개 스킬, 26개 커맨드, 10개 훅 이벤트 타입을 갖춘 Claude Code 지능형 개발 오케스트레이션 플러그인.

### Added / 추가됨
- **Plugin manifest**: `.claude-plugin/plugin.json`
- **18 agents**:
  - `orchestrator` (CTO/team leader)
  - `architect`, `planner`, `llm-architect` (design/analysis)
  - `code-reviewer`, `security-reviewer`, `tdd-guide`, `e2e-runner` (quality)
  - `frontend-developer`, `backend-developer`, `database-reviewer`, `typescript-pro`, `build-error-resolver` (development)
  - `refactor-cleaner`, `doc-updater`, `devops-engineer`, `mcp-developer` (utility)
- **25 skills** across 3 categories (core, persona, utility)
- **27 commands** including `/sc` auto-router
- **Hook system**: 10 event types, 11 automation scripts
  - `session-start.js`, `pre-write.js`, `pre-bash.js`
  - `post-edit-format.js`, `post-bash.js`, `pre-compact.js`
  - `check-console-log.js`, `user-prompt-handler.js`
  - `subagent-handler.js`, `team-idle-handler.js`, `session-end.js`
- **Core library** (`lib/core/`): platform, config, cache, io, debug, file modules
- **Intent system** (`lib/intent/`): language detection, trigger matching, ambiguity resolution
- **Context system** (`lib/context/`): hierarchy and session management
- **MCP integration**: Context7 (library docs) and Playwright (E2E testing)
- **Output styles**: default, compressed, mentor
- **Templates**: agent-template, skill-template, command-template
- **CI validation scripts**: validate-agents, validate-skills, validate-commands, validate-hooks
- **Zero runtime dependencies**: Node.js built-ins only

---

[Unreleased]: https://github.com/Yoodaddy0311/artibot/compare/v1.4.0...HEAD
[1.4.0]: https://github.com/Yoodaddy0311/artibot/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/Yoodaddy0311/artibot/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/Yoodaddy0311/artibot/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/Yoodaddy0311/artibot/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/Yoodaddy0311/artibot/releases/tag/v1.0.0
