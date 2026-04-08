# Changelog

All notable changes to Artibot are documented in this file.

모든 주목할 만한 변경 사항은 이 파일에 기록됩니다.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [2.3.1] - 2026-04-08

### Summary / 요약

**English**: Critical session-start performance fix. Two root-cause bugs found by profiling: (1) `session-start.js` had a `Promise.race` timer leak that held Node's event loop open for 2000ms after `checkForUpdate` already resolved (cached); (2) `git-autopilot-session.js` ran `git pull --rebase` on every session with no throttle (~800ms each). Session start latency dropped from ~2500ms to ~440ms in the realistic parallel-execution scenario.

**한국어**: 세션 시작 성능 치명적 버그 수정. 프로파일링으로 찾은 2건의 근본 원인: (1) `session-start.js`의 `Promise.race` 타이머 leak — `checkForUpdate`가 캐시 히트로 즉시 resolve된 후에도 Node 이벤트 루프가 2000ms 동안 종료 안 됨; (2) `git-autopilot-session.js`가 매 세션마다 `git pull --rebase` 실행 (~800ms). 병렬 실행 시나리오에서 세션 시작 지연이 ~2500ms → ~440ms로 감소.

### Fixed / 수정됨

- **scripts/hooks/session-start.js**: `Promise.race` 타이머 리크 수정
  - Before: `setTimeout(..., 2000)` 타이머가 race 종료 후에도 event loop에 남아 2s 지연
  - After: `try/finally`에서 `clearTimeout()` 호출로 즉시 종료
  - **개선**: 2252ms → 275ms (**-1977ms, -87.8%**)

- **scripts/hooks/git-autopilot-session.js**: `git pull` throttle 추가
  - Before: 매 세션마다 무조건 `git pull --rebase --autostash` 실행 (~800ms)
  - After: `.git/autopilot.json`의 `lastPullAt` 체크 → 5분 이내 재시도 스킵
  - Timestamp는 성공/실패 무관하게 기록 (실패 시에도 재시도 방지)
  - **개선**: 1086ms → 301ms (**-785ms, -72%**, throttled runs)

### Performance Impact / 성능 영향

| 시나리오 | Before | After | 개선 |
|---------|:------:|:-----:|:----:|
| 단일 `session-start.js` | 2252ms | 275ms | **-87.8%** |
| 단일 `git-autopilot-session.js` (throttled) | 1086ms | 301ms | **-72%** |
| **병렬 실행 (Claude Code 실제 동작)** | ~2500ms | **442ms** | **-82%** |

**사용자 체감**: 세션 시작 약 2.5초 → 0.4초 (6배 빠름). 하루 10 세션 기준 약 20초 절약, 연간 ~2시간의 대기 시간 제거.

### Root Cause Analysis / 근본 원인 분석

두 버그 모두 **프로파일링 기반으로 발견**. 당초 계획했던 C.3 hooks.json 마이그레이션(43 → 4 canonical slots)은 Claude Code 공식 문서 확인 결과 "훅이 이미 병렬 실행됨" → 예상 이득이 ~170-335ms에서 ~10-150ms로 축소되어 위험 대비 이득이 불리하다고 판단, **Option A (실제 병목 프로파일링)** 로 피벗. 결과적으로 2개 파일 수정만으로 C.3 병합 대비 10-200배 큰 이득 달성.

### Testing / 테스트

- 기존 테스트 34/34 통과 (session-start + skill-hash + skill-hash-cache)
- SessionStart hook smoke test: EXIT 0
- ESLint: 0 errors / 0 warnings

### Safety / 안전성

- `hooks.json` 무변경 (byte-identical)
- 함수 시그니처 동일 (backward-compatible)
- `.git/autopilot.json`에 `lastPullAt` 필드 추가 (additive, 기존 필드 유지)
- 5분 throttle 윈도우는 원격 변경 감지 지연을 최소화하면서 성능 이득 극대화

---

## [2.3.0] - 2026-04-08

### Summary / 요약

**English**: Major declutter sprint — Phase 1 Quick Wins + Phase 2 Core Consolidation (Rounds 1-4). Eleven sub-phases delivered across four workstreams (CSV rules, agent registry, lifecycle routing, hook dispatcher). Zero new dependencies, zero deletions, 144 new unit tests (5091/5091 total pass), 0 lint errors. Rolldown/vitest parser bug fixes, review-gate false positive elimination, INDEX.md glob exclusion, literal backspace byte fix in user-prompt-handler regex.

**한국어**: 대규모 정리 스프린트 — Phase 1 Quick Wins + Phase 2 핵심 통합 (Round 1-4). 4개 워크스트림에 걸쳐 11개 sub-phase 완료 (CSV 규칙, 에이전트 레지스트리, 생명주기 라우팅, 훅 디스패처). 신규 의존성 0, 삭제 0, 144개 신규 단위 테스트 (총 5091/5091 통과), 0 lint 오류. Rolldown/vitest 파서 버그 수정, review-gate false positive 제거, INDEX.md glob 제외, user-prompt-handler regex의 literal backspace 바이트 수정.

### Added / 추가됨

**Phase 1 — Quick Wins (additive patterns from 6-repo benchmark)**
- `lib/core/skill-hash.js` — SHA-256 8-char skill body hashing (from mcp2cli pattern)
- `lib/core/skill-hash-cache.js` — mtime-cached `.claude-cache/skill-hashes.json` (119 entries)
- `lib/core/toolset-loader.js` — 9 capability sets manifest loader (from hermes-agent pattern)
- `toolsets.json` — 9 toolsets: code, design, devops, content, marketing, analysis, meta, team, misc
- `scripts/validate-rationalizations.js`, `scripts/migrate-command-toolsets.js`, `scripts/inject-source-hash.js`, `scripts/phase1-audit.js`
- `## Rationalizations` sections on **all 119 skills** (5-row excuse/rebuttal table, from addyosmani/agent-skills pattern)
- `source_hash` frontmatter on all 119 skills (idempotent, mtime-safe)
- `toolset:` frontmatter on all 54 commands (grouped into 9 capability sets)

**Phase 2 — Core Consolidation (WS-D/B/A/C Round 1-4)**
- `lib/core/rules-csv-loader.js` — zero-dep CSV parser (quoted fields, CRLF, malformed rows)
- `lib/core/rules-resolver.js` — `agent → rules:[domain:id]` resolution with caching
- `rules/csv/{frontend,backend,security,performance,ux,accessibility,testing,devops,database,llm,typing,patterns}.csv` — **173 canonical rules** across 12 domains
- `rules/csv/drafts/_draft_*.csv` — 8 preparatory drafts (not loaded by default)
- `lib/core/agent-frontmatter-schema.js` + `scripts/validate-agent-frontmatter.js` — self-registering agent schema
- `lib/core/agent-registry.js` — mtime-cached agent dynamic registry (28 agents)
- `lib/core/lifecycle-manifest.js` + `lifecycle.json` — 8-phase lifecycle declarative manifest (spec/plan/build/verify/review/ship/marketing/design)
- `lib/core/lifecycle-router.js` — pure routing function with context matcher + toolset mapping
- `lib/core/hook-dispatcher.js` + `hooks/dispatch-table.json` — additive 4-canonical-slot middleware dispatcher (hooks.json UNTOUCHED)
- `lib/runtime/agent-resolver.js` — additive B.3 integration shim (feature flag `ARTIBOT_AGENT_REGISTRY` default OFF)
- `scripts/audit-hooks.js` + `docs/phase2/hook-audit.md` — 43-registration hook audit (keep/merge/exception decisions)
- `scripts/generate-agent-index.js` + `agents/INDEX.md` — auto-generated agent index
- 4 new lifecycle commands: `/spec`, `/review`, `/ship`, `/marketing` (+ `lifecycle:` frontmatter on `plan/build/verify/design`)
- 28 agents: `capabilities[]` + `lifecycle:` + `rules:` frontmatter (79 total rule references)

**New tests (144 total)**
- `tests/core/{skill-hash,skill-hash-cache,rules-csv-loader,rules-resolver,agent-registry,lifecycle-manifest,lifecycle-router,hook-dispatcher}.test.js`
- `tests/runtime/agent-resolver.test.js`

### Fixed / 수정됨

**Parser / Tooling bugs (preexisting, discovered during Phase 2)**
- `lib/swarm/pattern-packager.js`: unterminated JSDoc `/**` at end of file (rolldown parse failure)
- `scripts/evals/harness-ablation.js`: stale import of deleted `aci-constraint.js` middleware; removed shebang that confused rolldown
- `scripts/hooks/user-prompt-handler.js`: **literal backspace byte (0x08)** embedded in regex → replaced with `\b` escape sequence
- `tests/core/style-registry.test.js`: mock `DECODED_PLUGIN_ROOT` path was off by one directory
- `tests/evals/harness-ablation.test.js`: stale `aciConstraint` assertion
- `vitest.config.js`: `stripShebangPlugin` only processed `scripts/hooks/` — extended to all `scripts/` paths
- `lib/core/agent-registry.js` + `scripts/validate-agent-frontmatter.js`: INDEX.md inflated agent count to 29 — added exclusion filter

**Review-gate (stop hook) redesign**
- `checkBracketMismatch` replaced hand-rolled parser with `node --check` → eliminates template literal / regex / JSDoc type false positives
- `checkMissingTests` recursive tests/** walk with basename Set lookup → finds mirror tests at any depth
- `checkPatternViolations` skips JSDoc/block/line comments → eliminates `@example console.log(...)` false positives
- Pattern check exclusions: CLI scripts, test files, self, .cjs one-shots
- Removed unused `codexFlag` variable, fixed sort-imports warning

**Lint cleanup (zero warnings)**
- 14 errors resolved: unused vars (`runIteration`, `buildFixResult`, `validateSkillParams`, `validateHookParams`, `applyMode/detectMode/MODES`, `hookEvent`), no-undef in `.cjs`, control-regex backspace
- 5 warnings resolved: complexity/max-depth disable directives with justification comments

### Changed / 변경됨

- `scripts/hooks/session-start.js`: non-blocking skill-hash cache refresh block (try/catch wrapped, stderr-only diagnostics, EXIT 0 contract preserved)
- `tests/hooks/session-start.test.js`: stderr filter for informational cache messages
- Version sync: `package.json`, `plugin.json`, `artibot.config.json`, `marketplace.json` all → 2.3.0

### Safety / 안전성

- `hooks/hooks.json` — **byte-identical** to pre-2.3.0 (0 diff)
- SessionStart hook smoke test: EXIT 0 (contract preserved)
- All changes additive — zero deletions of agents/skills/commands
- Zero new npm dependencies (Node built-ins only)
- Korean path safe (`toFileUrl()` used for all dynamic imports)

### Deferred (require user approval) / 사용자 승인 대기

- **WS-A.4** — `lifecycleRouting.enabled = true` flag flip
- **WS-C.3** — `hooks.json` migration to 4 canonical slots
- **WS-C.4** — legacy hook script `_deprecated/` move (depends on C.3)

---

## [2.1.1] - 2026-04-02

### Summary / 요약

**English**: Hook JSON schema compliance fix — 4 hooks producing invalid output that caused Claude Code validation errors. Also fixed pre-write-guard Read tracking bug. 7 files changed.

**한국어**: Hook JSON 스키마 준수 수정 — Claude Code 검증 에러를 유발하던 4개 hook의 잘못된 출력 수정. pre-write-guard Read 추적 버그도 해결. 7개 파일 변경.

### Fixed / 수정됨

- **stop-review-gate.js**: decision 값 'ALLOW'/'BLOCK' → 'approve'/'block' (스키마 준수), 스키마 외 필드(issues, changedFiles, codexCrossCheck) 제거
- **pre-write-guard.js**: hook_event_name 필드 의존 제거 → PostToolUse Read 이벤트 추적 정상화
- **pre-compact.js**: 스키마 외 필드(summary, tokenEstimate, suppress_follow_up_questions) 제거 → systemMessage 사용
- **quality-gate.js**: block 시 message → reason (스키마 준수), warning 시 hookSpecificOutput.additionalContext 적용

### Tests Updated / 테스트 업데이트

- **pre-compact.test.js**: snapshot 구조 및 systemMessage 필드에 맞게 assertion 업데이트
- **quality-gate.test.js**: reason 필드 및 hookSpecificOutput 구조에 맞게 assertion 업데이트

---

## [2.1.0] - 2026-04-02

### Summary / 요약

**English**: Codex cross-check integration, Stop-Review-Gate quality hook, centralized metrics collector, 10 new skills, trigger conflict resolution, and architecture documentation overhaul. 44 files changed, +4,395 / -173 lines.

**한국어**: Codex 크로스체크 통합, Stop-Review-Gate 품질 훅, 중앙 메트릭스 수집기, 10개 신규 스킬, 트리거 충돌 해소, 아키텍처 문서 전면 개편. 44개 파일 변경, +4,395 / -173줄.

### Added / 추가됨

- **`/codex` command**: Codex CLI 크로스체크 통합 (review/dev/off 모드)
- **Stop-Review-Gate hook**: 작업 완료 전 자동 품질 검증 (bracket mismatch, pattern violations, sensitive files, missing tests)
- **`lib/core/metrics-collector.js`**: 분산 stats를 통합하는 중앙 메트릭스 수집기
- **`lib/core/instruction-budget.js`**: 4K/12K chars instruction 예산 모니터링
- **`lib/core/agent-memory-snapshot.js`**: 에이전트 위임 시 컨텍스트 보존 스냅샷
- **10 new skills**: load-testing, observability, ci-cd-pipelines, codex-integration, agent-memory-snapshot, compaction-survival, prompt-caching-strategy, hook-feedback-merge + 2 references (api-security, event-sourcing)

### Improved / 개선됨

- **Pre-compact hook**: 구조화 요약 (pending work, key files, recent requests 보존)
- **Context Efficiency 표준**: chars/4+1, 160자 truncation, 4 message preservation 문서화
- **5-Layer Architecture**: CLAUDE.md에 계층 다이어그램 추가
- **온보딩 Quick Start**: README.md에 흐름 중심 온보딩 섹션 추가
- **`disable-model-invocation`**: 순수 위임 커맨드 (spawn/swarm/orchestrate)에 적용
- **리뷰 출력 JSON Schema**: code-review, adversarial-review, code-reviewer, security-reviewer에 `review-output.schema.json` 강제
- **Auto-compact 임계값**: session-start.js에서 180K으로 조정

### Fixed / 수정됨

- **estimateTokens 중복**: 5곳 → canonical 1곳으로 통합
- **CHARS_PER_TOKEN 상수**: 3곳 → 1곳 통합
- **clamp01 함수**: 3곳 → 1곳 통합
- **트리거 충돌 6건 해소**: workflow, security audit, compact, adversarial review
- **system1.js `fastResponse()`**: 100→49줄 리팩토링
- **metrics-collector.js `getSummary()`**: 62→11줄 리팩토링
- **CRO 스킬 카테고리**: cro-forms, cro-funnel, cro-page의 category testing → marketing
- **pre-compact 타임아웃**: 5s → 8s

### Stats / 통계

| Metric | Before | After | Delta |
|--------|--------|-------|-------|
| Files changed | — | — | 44 |
| Lines | — | — | +4,395 / -173 |
| Commands | 48 | 50 | +2 |
| Skills | 98 | 117 | +19 |
| Hooks | 36 | 39 | +3 |
| Core modules | 32 | 35 | +3 |

---

## [2.0.0] - 2026-03-30

### Summary / 요약

**English**: Self-Evolution Engine, Extreme Efficiency optimizations, and Future Platform foundation. 25 new modules across 3 tracks, /team auto-apply, full hook/skill/agent audit, 4,918 tests.

**한국어**: 자가 진화 엔진, 극한 효율 최적화, 미래 플랫폼 기반. 3개 트랙에 걸친 25개 신규 모듈, /team 자동 적용, 전체 훅/스킬/에이전트 전수 검사, 4,918개 테스트.

### Added / 추가됨

- **Track A (Self-Evolution)**: Neural Session Memory, AutoResearch Pipeline, Skill Evolution Engine, Cross-Session Knowledge Graph
- **Track B (Extreme Efficiency)**: Rate Limit Sentinel, Adaptive Context Modes, Predictive Context Budget, Zero-Waste Smart Pipeline
- **Track C (Future Platform)**: Universal Harness Adapter (6 harnesses), Plugin Marketplace, Artibot SDK, Collective Intelligence Hub
- **Team auto-apply** (`team.autoApply: true`): Automatic /team workflow for qualifying requests (2+ subtasks, 2+ domains, medium+ complexity)
- **`--no-team` flag**: Per-request opt-out in user-prompt-handler.js
- **Context Modes**: DEV/REVIEW/DEBUG/DEPLOY with auto-detection, wired to router middleware
- **Smart Pipeline**: Opt-in middleware pipeline optimization
- **Session Memory hooks**: SessionEnd compress, SessionStart recall

### Changed / 변경됨

- **Version**: 1.15.0 → 2.0.0 across all manifests
- **CLAUDE.md**: Auto Team Mode section added with activation criteria and opt-out methods
- **install.sh**: Version bump to 2.0.0
- **README.md**: Updated to reflect v2.0.0 capabilities
- **Tests**: 4,270 → 4,918 (+648), 126 → 147 test files (+21)
- **hooks.json**: 36 → 42 registrations
- **lib/learning/**: 19 → 26 modules
- **lib/core/**: 28 → 32 files

### Fixed / 수정됨

- **Korean path imports**: `toFileUrl()` percent-encoding fix for non-ASCII paths on Windows
- **Context modes test**: Replace unsupported Chinese keyword with English
- **Quality audit**: Full hook/script, skill/command/agent audit with stale reference cleanup

---

## [1.15.0] - 2026-03-27

### Summary / 요약

**English**: Benchmark intelligence from 3-source analysis (awesome-ai-agents 215 agents, Anthropic harness blog, Google Agent Skills blog). 11 features implemented (5 HIGH + 6 MEDIUM). DAG orchestration quality fixes. 4,270 tests.

**한국어**: 3개 소스 벤치마크 분석 (awesome-ai-agents 215 에이전트, Anthropic harness 블로그, Google Agent Skills 블로그) 기반 인텔리전스. 11개 기능 구현 (HIGH 5 + MEDIUM 6). DAG 오케스트레이션 품질 수정. 4,270개 테스트.

### Added / 추가됨

- **ACI Constraint middleware**: Agent role-based tool restriction
- **Context Reset middleware**: Structured handoff on token threshold
- **Eval Isolator**: Self-eval bias separation
- **Sprint Contract**: Pre-task done-criteria negotiation
- **Source of Truth URL**: SKILL.md `sources:` field for live docs
- **Feature Tracker + Intelligence output style**: UX visibility improvements
- **Harness Ablation Test**: Middleware effectiveness eval
- **Evaluator Calibration**: Human feedback few-shot + GRPO weight tuning
- **Skill Versioning & Freshness**: `version`/`lastVerified` tracking
- **Skill Evaluation Harness**: On/off effectiveness benchmark
- **Voyager Skill Auto-Promotion**: Success pattern → skill crystallization

### Fixed / 수정됨

- **Dag.dependents() / Dag.has()**: Public API for Canceler integration
- **Canceler.cancelDownstream()**: Refactored to use Dag public API instead of private fields
- **FileCheckpoint**: 1MB file size guard to prevent large file delays
- **Write-Before-Read Guard**: CLAUDE.md/CLAUDE.local.md/.claude/ whitelist added

---

## [1.14.3] - 2026-03-25

### Fixed / 수정됨

- **Statusline**: Fix `[[object Object]]` bug when jq_get/node returns nested object
- **Session token display**: Add token estimate to statusline (`~12K tokens` format)
- **persistTokenUsage()**: Write session data to `runtime/token-usage-session.json`
- **Token formatting**: >=1M → ~1M, >=1K → ~12K, <1K → ~500

---

## [1.14.2] - 2026-03-25

### Changed / 변경됨

- **auto-learning-runner.js**: Split from 1013→382 lines into 4 modules (runner, scanner, extractor, committer)
- **learning/index.js**: Extract business logic → pipeline.js (427→140 lines pure barrel)
- **Provenance tracking**: user, project, branch, commitRange per pattern

### Added / 추가됨

- **Auto-commit security guardrails**: Allowlist/denylist (7 allow, 25 deny patterns)
- **PII protection**: Email/hostname SHA-256 hashing, Swarm PII auto-strip
- **Commit tagging**: `[AUTOMATED]` tag for auto vs manual distinction
- **99 new tests**: Auto-learning modules (4 test files, 100% pass)

---

## [1.14.1] - 2026-03-25

### Fixed / 수정됨

- **Skill restore**: 5 skills restored (delegation, orchestration, vibe-coding, strategic-compact, verification-completion)
- **Platform compat**: `convertSkill()` frontmatter expansion for Codex/Cursor/AntiGravity
- **cli-adapter.js**: Mutation → immutable pattern fix
- **auto-learning-runner.js**: Windows compat fixes (`shell:true`, `maxBuffer`, non-zero exit)

### Added / 추가됨

- **install.sh**: Zero-config auto-learning (`claude schedule` → `crontab` → `schtasks` chain)
- **Dynamic context injection**: 6 skills with live git/npm context
- **CI pipeline**: `skill:check` added to ci script
- **output-styles**: tokens.md auto-reference in default style

---

## [1.14.0] - 2026-03-25

### Summary / 요약

**English**: Benchmark-driven evolution from deer-flow, gstack, OpenAI blog, and Claude Code Skills docs. Skills P0 compliance fix, auto-learning pipeline, 3 new middlewares. 3,887 tests.

**한국어**: deer-flow, gstack, OpenAI 블로그, Claude Code Skills 문서 기반 벤치마크 주도 진화. 스킬 P0 컴플라이언스 수정, 자동 학습 파이프라인, 3개 신규 미들웨어. 3,887개 테스트.

### Added / 추가됨

- **GuardrailMiddleware**: Policy-based tool call authorization
- **TokenUsageMiddleware**: Per-model/agent token tracking
- **SummarizationMiddleware**: Expanded with deer-flow pattern
- **Auto-learning pipeline**: 5-stage (scan → extract → update → refine → commit)
- **setup-auto-learning.js**: Claude schedule / cron / webhook activation
- **Output design token system**: tokens.md + narrative output style
- **gen-skill-docs.js**: SKILL.md validation pipeline
- **128 new tests** (3,887 total), 111 test files

### Fixed / 수정됨

- **P0**: Fix `context: forked` → `context: fork` across 98 skills (Claude Code compliance)
- **P0**: Add `disable-model-invocation` (10 skills) + `user-invocable: false` (26 skills)
- **P1**: Add `$ARGUMENTS`/argument-hint (9 skills), agent field (9), allowed-tools (16)

---

## [1.13.0] - 2026-03-24

### Summary / 요약

**English**: Major architecture upgrade in 4 phases — stabilization (Swarm security, DATA POLICY enforcement), Claude integration (middleware parallelization, async eval), architecture (Playbook DAG, lazy skills), and ecosystem (CLI standalone, multilingual intent, Git Autopilot). 3,765 tests across 108 files.

**한국어**: 4단계 아키텍처 업그레이드 — 안정화(Swarm 보안, DATA POLICY 적용), Claude 통합(미들웨어 병렬화, 비동기 eval), 아키텍처(Playbook DAG, 스킬 lazy loading), 에코시스템(CLI 독립실행, 다국어 intent, Git Autopilot). 108개 파일에서 3,765개 테스트 통과.

### Added / 추가됨

- **Chinese intent keywords** (32): 实现, 开发, 测试, 调试, 修复, 重构, 设计, 架构, 安全, 文档 등 전체 intent 카테고리 커버
- **Japanese intent enhancement** (+18): 構築, 開発, 修復, バグ, 単体テスト, リファクタリング, 最適化, セキュリティ, 脆弱性 등
- **`detectLanguage()` function**: 한국어 > 일본어 > 중국어 > 영어 우선순위 감지 (CJK 문자 범위 기반)
- **Playbook DAG system**: `parseDagPlaybook()`, `validateDagPlaybook()`, `detectCycle()`, `topologicalSort()`, `getExecutionOrder()`, `getParallelGroups()` — Kahn 알고리즘 토폴로지컬 정렬, 순환 의존성 감지
- **8 DAG playbooks**: feature (FE/BE 병렬), marketing-campaign (콘텐츠/광고 병렬), marketing-audit (SEO/CRO 병렬), competitive-analysis (시장/SEO 병렬) 등 병렬 노드 지원
- **Git Autopilot hooks** (5): `git-autopilot-setup` (SessionStart), `git-autopilot-session` (SessionStart), `git-autopilot-guard` (PreToolUse), `git-autopilot-save` (UserPromptSubmit), `git-autopilot-close` (Stop)
- **Worktree isolation mode**: `team.worktreeIsolation` config (opt-in, `enabled: false` 기본), `/team --worktree` 플래그
- **Artibot CLI standalone** (`bin/artibot.js`): 6개 명령어, zero deps
- **Skill lazy loading**: opt-in 세션 캐시
- **CronCreate nightly-learner**: 스케줄링 (opt-in)
- **Middleware unit tests** (55): 미들웨어 파이프라인 테스트
- **Eval scenarios** (3): 신규 평가 시나리오 + 메트릭
- **활용 가이드**: `docs/GUIDE.md`
- **CI coverage threshold**: 커버리지 임계값 적용

### Changed / 변경됨

- **Middleware execution**: 순차 → 병렬 (5단계 + 에러 바운더리)
- **Eval execution**: 동기 → 비동기 (`Promise.all` 병렬)
- **hooks.json**: v1.9.2 → v1.13.0 동기화 (35개 훅 등록, 15개 이벤트 타입)
- **`playbooksLegacy`**: 기존 문자열 플레이북을 `playbooksLegacy`로 보존, 신규 DAG를 `playbooks`로 전환
- **Supported languages**: `[en, ko, ja]` → `[en, ko, ja, zh]`
- **DOMAIN_KEYWORDS** (router.js): 7개 도메인 모두에 중국어/일본어 키워드 동기화
- **Version**: 모든 매니페스트 1.12.0 → 1.13.0 (package.json, plugin.json, artibot.config.json, hooks.json)

### Fixed / 수정됨

- **playbook-registry**: Korean path 버그 (`fileURLToPath` 인코딩 문제)
- **Swarm DATA POLICY violation**: 외부 GCP 서버 URL → localhost 전용
- **Environment variable bypass**: `resolveServerUrl` 조기 검증으로 env var 우회 차단
- **platform.js `getPluginRoot`**: Korean path (바탕 화면) 처리 수정

### Security / 보안

- **Swarm server URL**: 외부 서버 URL 완전 제거 (`https://artibot-swarm-*.run.app` → `http://localhost:3000`)
- **SSRF prevention**: env var 기반 서버 URL 우회 차단
- **ALLOWED_HOSTS**: localhost 전용으로 제한

---

## [1.12.0] - 2026-03-18

### Summary / 요약

**English**: Runtime middleware pipeline, eval quality gate CI integration, full Codex CLI platform export, statusline.sh 2-line status bar, InstructionsLoaded hook event support. 3,587 tests.

**한국어**: 런타임 미들웨어 파이프라인, eval 품질 게이트 CI 통합, Codex CLI 플랫폼 전체 내보내기, statusline.sh 2줄 상태 표시줄, InstructionsLoaded 훅 이벤트 지원. 3,587개 테스트.

### Added / 추가됨

- **Runtime middleware pipeline**: `runtime-prompt.js` — UserPromptSubmit 훅으로 런타임 컨텍스트 주입
- **Eval quality gate**: `scripts/evals/run-runtime-task-suite.js`, `scripts/ci/validate-runtime-evals.js`
- **Full Codex CLI export**: `.agents/` 디렉토리, `AGENTS.md`, `install-artibot-codex-global.ps1`
- **Statusline script**: `scripts/hooks/statusline.sh` — 2줄 상태 표시 (ANSI 색상, Git 캐시)
- **InstructionsLoaded event**: `validate-hooks.js` 및 `validate.js`에 신규 이벤트 화이트리스트 추가

---

## [1.11.0] - 2026-03-16

### Summary / 요약

**English**: Self-diagnosis optimization — circular buffer for loop detection, event bus for inter-module communication, shared blocked patterns, knowledge demotion split.

**한국어**: 자가 진단 최적화 — 루프 감지용 순환 버퍼, 모듈 간 통신용 이벤트 버스, 공유 차단 패턴, 지식 강등 분리.

### Added / 추가됨

- **Circular buffer** (`lib/cognitive/loop-detector.js`): Agent loop detection with fingerprint matching
- **Event bus** (`lib/core/event-bus.js`): Inter-module pub/sub communication
- **Shared blocked patterns** (`lib/core/blocked-patterns.js`): Centralized dangerous command patterns
- **Knowledge demotion** (`lib/learning/knowledge-demotion.js`): Split from knowledge-transfer for clarity

---

## [1.10.0] - 2026-03-16

### Summary / 요약

**English**: PM-skills benchmarking — 46 commands (Next Steps), HITL v2 conversational checkpoints (25 skills), Output Templates (10 skills), /repo command for external repo analysis.

**한국어**: PM 스킬 벤치마킹 — 46개 커맨드 (Next Steps), HITL v2 대화형 체크포인트 (25개 스킬), 출력 템플릿 (10개 스킬), 외부 레포 분석용 /repo 커맨드.

### Added / 추가됨

- **HITL v2 checkpoints**: 25개 스킬에 대화형 인간 체크포인트 추가
- **Output templates**: 10개 스킬에 구조화된 출력 템플릿
- **`/repo` command**: 외부 레포지토리 분석 및 비교
- **Next Steps**: 46개 커맨드로 확장

---

## [1.9.3] - 2026-03-10

### Summary / 요약

**English**: Install/update pipeline hardening — 56 fixes, file-lock for concurrent access, cross-computer portability.

**한국어**: 설치/업데이트 파이프라인 강화 — 56개 수정, 동시 접근용 파일 잠금, 크로스 컴퓨터 이식성.

### Added / 추가됨

- **Advisory file locking** (`lib/core/file-lock.js`): Spin-lock based concurrent state access
- **Cross-computer portability**: Korean path 처리, 플랫폼 독립적 경로 해석

### Fixed / 수정됨

- 56개 설치/업데이트 관련 버그 수정
- `install.sh` 경로 해석 안정화

---

## [1.9.2] - 2026-03-09

### Summary / 요약

**English**: Loop detection and clean state enforcement from harness engineering.

**한국어**: 하네스 엔지니어링으로부터의 루프 감지 및 클린 상태 강제.

### Added / 추가됨

- **Loop detection**: Circular buffer 기반 에이전트 루프 감지, fingerprint matching
- **Clean state enforcement**: TaskCompleted 훅에서 lint+test 검증

---

## [1.9.1] - 2026-03-09

### Summary / 요약

**English**: Guard pipeline centralization with registry pattern.

**한국어**: 레지스트리 패턴으로 가드 파이프라인 중앙화.

### Changed / 변경됨

- **Guard registry** (`lib/core/guard-registry.js`): `registerGuard()`/`executeChain()` API
- 6개 내장 가드를 훅 스크립트에서 추출 (75% 코드 감소)

---

## [1.9.0] - 2026-03-06

### Summary / 요약

**English**: Claude Code v2.1.69 compatibility, quality gate innovation, cognitive/learning expansion. 2,933 tests.

**한국어**: Claude Code v2.1.69 호환성, 품질 게이트 혁신, 인지/학습 확장. 2,933개 테스트.

### Added / 추가됨

- **Quality gate hook** (`quality-gate.js`): PostToolUse Write/Edit 시 자동 품질 검증
- **Cognitive router expansion**: 멀티 도메인 키워드, 불확실성/위험도 감지
- **Learning expansion**: 자기 평가, 도구 학습 강화

### Changed / 변경됨

- Claude Code v2.1.69 API 호환성 업데이트
- 훅 이벤트 매처 표현식 구문 업데이트

---

## [1.8.0] - 2026-03-03

### Summary / 요약

**English**: Code quality cleanup, forked context skills, HTTP webhook hooks, 212 new tests.

**한국어**: 코드 품질 정리, forked context 스킬, HTTP 웹훅 훅, 212개 신규 테스트.

### Added / 추가됨

- **Forked context skills**: 모든 스킬을 격리된 forked context에서 실행
- **HTTP webhook** (`http-notify.js`): SessionEnd 시 Slack/Discord/커스텀 엔드포인트로 이벤트 전송
- **212 new tests**: 테스트 스위트 대폭 확장

### Changed / 변경됨

- 코드 품질 전반적 정리 및 ESLint 준수 강화

---

## [1.7.0] - 2026-02-27

### Summary / 요약

**English**: DEV protocol, vibe coding support, daily/team commands, rules system. Sub-releases: v1.7.1 (81 skill enhancements), v1.7.2 (branch coverage 83%→91%), v1.7.3 (federated swarm production).

**한국어**: DEV 프로토콜, 바이브 코딩 지원, daily/team 커맨드, 규칙 시스템. 서브 릴리즈: v1.7.1 (81개 스킬 강화), v1.7.2 (브랜치 커버리지 83%→91%), v1.7.3 (연합 스웜 프로덕션).

### Added / 추가됨

- **DEV protocol** (`rules/dev-protocol.md`): Decompose-Execute-Verify 필수 워크플로우
- **Vibe coding** (`skills/vibe-coding/`): 자연어 코딩 요청 처리
- **`/daily` command**: 일일 회고 리포트
- **`/team` command**: 병렬 팀 오케스트레이션 (교차 검증 포함)
- **Rules system**: 8개 자동 활성화 규칙 (경로 기반)
- **v1.7.1**: 81개 SKILL.md에 Anthropic 베스트 프랙티스 적용
- **v1.7.2**: 60개 신규 테스트, 브랜치 커버리지 83%→91%
- **v1.7.3**: 연합 스웜 학습 프로덕션 + 업데이트 수정

---

## [1.6.0] - 2026-02-23

### Summary / 요약

**English**: Visual validation pipeline, conversation-to-memory, playbook activation, self-learning pipeline achieving 90+ score.

**한국어**: 시각적 검증 파이프라인, 대화-메모리 변환, 플레이북 활성화, 90점 이상 달성한 자가학습 파이프라인.

### Added / 추가됨

- **Visual validation** (`lib/visual/`): SSIM 기반 스크린샷 비교, 자동 CSS 수정 제안
- **Conversation-to-Memory**: 사용자 메시지에서 규칙/결정 자동 추출, 스킬에 동적 주입
- **Playbook activation**: 플레이북 파서 및 레지스트리
- **Self-learning pipeline**: GRPO 기반 자가학습 90+ 점수 달성

---

## [1.5.0] - 2026-02-20

### Summary / 요약

**English**: Post-Sprint 6 release with BSL 1.1 license, repository cleanup, and stability fixes.

**한국어**: Sprint 6 이후 릴리즈. BSL 1.1 라이선스, 레포지토리 정리, 안정성 수정.

### Added / 추가됨

- **BSL 1.1 license**: 코드 보호를 위한 라이선스 전환
- **Secret scanning prevention**: GitHub 비밀 스캐닝 오탐 방지

### Changed / 변경됨

- 내부 문서/벤치마크/블로그를 공개 레포에서 제외
- README를 v1.5.0 수치로 업데이트

---

## [1.4.0] - 2026-02-19

### Summary / 요약

**English**: Largest release to date. Comprehensive quality audit achieving 8.2/10 evaluation score. Security hardening (prototype pollution, CORS, shell evasion), performance optimization (lazy-load, pattern caching), 2,050 lines of dead code removed. Intent system integration, marketing vertical expansion (8 agents, 11 commands, 34 skills), cross-platform adapters, auto-update system, and 1,226 tests passing at 100%.

**한국어**: 역대 최대 규모 릴리즈. 종합 품질 감사를 통해 평가 점수 8.2/10 달성. 보안 강화(프로토타입 오염, CORS, 셸 우회 방지), 성능 최적화(지연 로딩, 패턴 캐싱), 2,050줄의 불필요 코드 제거. 인텐트 시스템 통합, 마케팅 버티컬 확장(에이전트 8, 커맨드 11, 스킬 34), 크로스 플랫폼 어댑터, 자동 업데이트 시스템, 그리고 1,226개 테스트 100% 통과.

### Added / 추가됨

- **Marketing agents** (8 new): `content-marketer`, `marketing-strategist`, `data-analyst`, `presentation-designer`, `seo-specialist`, `cro-specialist`, `ad-specialist`, `repo-benchmarker`
- **Marketing commands** (11 new): `/mkt`, `/email`, `/social`, `/ppt`, `/excel`, `/ad`, `/seo`, `/crm`, `/analytics`, `/cro`, `/content`
- **Marketing skills** (34 new): Full content marketing, SEO, CRO, and advertising skill trees
- **Marketing playbooks** (4 new): `marketing-campaign`, `marketing-audit`, `content-launch`, `competitive-analysis`
- **Language Skills** (16 new): TypeScript, Python, Go, Rust, Java, and more with cultural adaptation
- **Progressive Disclosure skill**: Complexity-tiered information delivery (Quick/Standard/Expert modes)
- **Cross-platform adapters**: Gemini CLI, Codex, Cursor, Antigravity support via `lib/adapters/`
- **Auto-update system**: `version-checker.js` with GitHub Releases API, 24h cache, `/artibot:update` command (`--check`, `--force`, `--dry-run`)
- **`/artibot:assemble`**: Easter egg command that summons the full agent team via Agent Teams API
- **Intent integration**: `lib/intent/` integrated into cognitive-router for intent detection enrichment
- **Session context**: `lib/context/session` integrated into `session-start.js` for state management
- **`performance-engineer` agent**: Registered in `plugin.json` manifest
- **`memory-tracker.js` hook**: Registered in `hooks.json` (SessionStart, SessionEnd, PostToolUseFailure)
- **Security hook tests**: `pre-bash.test.js` (48 tests), `pre-write.test.js` (54 tests)
- **ESLint v9**: Flat config with 14 rules (up from 4) including complexity, no-eval, prefer-const
- **ESLint scripts**: `npm run lint` and `npm run lint:fix`
- **CI/CD pipeline**: `npm run ci` executes validate + lint + test in sequence
- **`artibot-report` output style**: Markdown table format for reports
- **Vitest shebang plugin**: Fixes Windows hook test failures (+150 tests recovered)
- **Test suite**: 1,226 tests passing at 100% (37 test files) -- 874에서 시작, 1,232까지 확장 후 데드코드 정리로 1,226 확정
- **CONTRIBUTING.md**: Bilingual (en/ko) contributor guide
- **SECURITY.md**: Security policy with PII scrubber and privacy protection documentation
- **CHANGELOG.md**: Keep a Changelog format with bilingual entries
- **Blog post**: Artibot introduction for non-developers (비개발자용 소개글)

### Changed / 변경됨

- **Evaluation score**: 6.9/10 --> 8.2/10 (종합 품질 감사 결과)
- **`/sc` routing table**: Completed with 6 previously missing commands
- **`artibot.config.json`**: taskBased command-to-agent mapping completed, orphaned config keys removed
- **`validate.js`**: Node.js 18+ compatibility fix (`import.meta.dirname` --> `fileURLToPath`)
- **Event types**: Synchronized across `validate.js` and CI `validate-hooks.js` (16 events)
- **Model policy**: Marketing agents assigned to `haiku` tier for cost efficiency
- **Agent categories**: New `support` category for marketing and utility agents
- **README stats**: Updated to match actual file counts (agents 25, skills 60, commands 38+)
- **`assemble.md`**: Hero titles replaced with plain role descriptions
- **Adapter deduplication**: Shared `stripClaudeSpecificRefs` in `adapter-utils.js`
- **`parseFrontmatter`**: Deduplicated into shared `adapter-utils.js`
- **Root artifacts**: 11 files moved to `docs/archive/`

### Fixed / 수정됨

#### Security / 보안

- **`config.js`**: Block `__proto__`/`constructor`/`prototype` in `deepMerge` (prototype pollution prevention / 프로토타입 오염 차단)
- **`server/index.js`**: CORS restricted to localhost (was wildcard `*`)
- **`server/index.js`**: Bearer token authentication + localhost-only fallback added
- **`pre-bash.js`**: `normalizeCommand()` strips shell evasion (quotes, backticks, `$()`, ANSI escape sequences)
- **`pre-bash.js`**: Extended curl/wget pipe blocking to python/perl/ruby/node interpreters
- **`pre-write.js`**: Fail-closed security mode + secret content detection patterns added
- **`pre-bash.js`**: Fail-closed security mode + expanded dangerous command patterns (curl|sh, SQL DROP, Windows del/rmdir)

#### Performance / 성능

- **`pii-scrubber.js`**: Cache sorted patterns at module level instead of sorting per call
- **`tool-tracker.js`**: Lazy-load modules with singleton cache instead of dynamic import per event

#### Bugs / 버그

- **`pii-scrubber.js`**: False positive on Windows drive letter paths
- **`memory-manager.js`**: Race condition in concurrent write operations
- **`config.js`**: Environment variable override not propagating to sub-modules
- **`plugin.json`**: `commands`/`skills` fields changed from string to array format
- **`hooks.json`**: Matcher format changed to expression syntax; hook types corrected from `prompt`/`agent` to `command`
- **`session-start.js`**: Hoist `home` variable to function scope (was undefined)
- **`marketplace.json`**: Version updated to 1.4.0, homepage URL corrected
- **`tool-tracker.js`**: JSDoc `*/` syntax error broke PostToolUse hooks
- **`skill-exporter.js`**: JSDoc `*/` syntax error broke PostToolUse hooks
- **Korean path handling**: `pathToFileURL` replaced with manual `file://` URL for paths containing Korean characters (바탕 화면)
- **`session-end.js`**: Use `atomicWriteSync` instead of `writeFileSync`
- **Hook catch handlers**: Added `process.exit(0)` to 7 handlers to prevent zombie processes
- **GitHub URLs**: Unified from `artience/artibot` to `Yoodaddy0311/artibot` across 10 files
- **SKILL.md references**: Agent references corrected from `persona-*` to real agent types

#### Code Quality / 코드 품질

- **`system2.js`**: Immutable step update via spread operator (mutation 제거)
- **`learning/index.js`**: 4 silent catches now log to stderr
- **`getPluginRoot`**: Consolidated from 4 implementations to 1 canonical source
- **`scripts/utils`**: I/O functions deduplicated via re-export from `lib/core/io.js`
- **`atomicWriteSync`** / **`toFileUrl`**: Added to `scripts/utils/index.js`
- **`ARTIBOT_DIR` export**: Added with telemetry opt-out config support

### Removed / 제거됨

- **`telemetry-collector.js`** (`lib/system/`): Dead code -- removed with tests (-2,050 lines total)
- **`context-injector.js`** (`lib/system/`): Dead code -- removed with tests
- **`hierarchy.js`** (`lib/context/`): Dead code -- removed with tests
- **`lib/system/` directory**: Empty after dead code removal
- **`tests/system/` directory**: Empty after dead code removal
- **Legacy duplicate directories**: `agents/`, `artibot/skills/` shadowing plugin paths removed
- **`maxTeammates` doc mismatch**: Corrected from `7` to `null`

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

[2.0.0]: https://github.com/Yoodaddy0311/artibot/compare/v1.15.0...v2.0.0
[1.15.0]: https://github.com/Yoodaddy0311/artibot/compare/v1.14.3...v1.15.0
[1.14.3]: https://github.com/Yoodaddy0311/artibot/compare/v1.14.2...v1.14.3
[1.14.2]: https://github.com/Yoodaddy0311/artibot/compare/v1.14.1...v1.14.2
[1.14.1]: https://github.com/Yoodaddy0311/artibot/compare/v1.14.0...v1.14.1
[1.14.0]: https://github.com/Yoodaddy0311/artibot/compare/v1.13.0...v1.14.0
[1.13.0]: https://github.com/Yoodaddy0311/artibot/compare/v1.12.0...v1.13.0
[1.12.0]: https://github.com/Yoodaddy0311/artibot/compare/v1.11.0...v1.12.0
[1.11.0]: https://github.com/Yoodaddy0311/artibot/compare/v1.10.0...v1.11.0
[1.10.0]: https://github.com/Yoodaddy0311/artibot/compare/v1.9.3...v1.10.0
[1.9.3]: https://github.com/Yoodaddy0311/artibot/compare/v1.9.2...v1.9.3
[1.9.2]: https://github.com/Yoodaddy0311/artibot/compare/v1.9.1...v1.9.2
[1.9.1]: https://github.com/Yoodaddy0311/artibot/compare/v1.9.0...v1.9.1
[1.9.0]: https://github.com/Yoodaddy0311/artibot/compare/v1.8.0...v1.9.0
[1.8.0]: https://github.com/Yoodaddy0311/artibot/compare/v1.7.0...v1.8.0
[1.7.0]: https://github.com/Yoodaddy0311/artibot/compare/v1.6.0...v1.7.0
[1.6.0]: https://github.com/Yoodaddy0311/artibot/compare/v1.5.0...v1.6.0
[1.5.0]: https://github.com/Yoodaddy0311/artibot/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/Yoodaddy0311/artibot/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/Yoodaddy0311/artibot/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/Yoodaddy0311/artibot/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/Yoodaddy0311/artibot/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/Yoodaddy0311/artibot/releases/tag/v1.0.0
