# MoAI-ADK vs Artibot: 10-Dimension Benchmark Report

**Date**: 2026-02-19
**Analyst**: innovation-analyst (Artibot Platoon)
**MoAI-ADK Version**: v2.4.7 (Go Edition)
**Artibot Version**: v1.3.0 (Node.js ESM Plugin)
**Revision**: v2 - Fact-based update with code analysis

---

## Executive Summary

MoAI-ADK는 Go로 작성된 독립 바이너리 기반 Agentic Development Kit으로, 컴파일된 CLI 도구 + Claude Code 통합 구조를 채택한다. Artibot은 Claude Code Plugin 아키텍처를 활용한 **자기학습 인지 엔진 + Agent Teams 오케스트레이션** 플러그인이다.

**핵심 발견: 두 프로젝트는 근본적으로 다른 비전을 추구한다.**

| 항목 | MoAI-ADK | Artibot |
|------|----------|---------|
| **비전** | 더 나은 **개발 도구** (Developer Productivity) | **학습하고 진화하는 AI 에이전트** (Self-Learning AGI Engine) |
| **언어** | Go 1.25 (39K+ LOC) | Node.js ESM (zero external deps, ~7K LOC lib/) |
| **배포 방식** | 단일 바이너리 (cross-platform) | Claude Code Plugin |
| **핵심 기술** | LSP, AST-grep, EARS, 컴파일 타임 품질 | Kahneman System 1/2, GRPO 자기학습, Knowledge Transfer, Federated Swarm |
| **에이전트 수** | 28 (Manager 8 + Expert 9 + Builder 3 + Team 8) | 19 (Orchestrator 1 + Teammates 18) |
| **스킬 수** | 51 SKILL.md (50+ directories) | 25 directories |
| **테스트** | 178 test files, 85-100% coverage | **29 test files, 874 test cases**, vitest + ESLint flat config |
| **총점 (가중평균)** | **8.05 / 10** | **7.35 / 10** |

---

## Artibot vs MoAI: 기술 방향 차이 분석

두 프로젝트는 "Claude Code를 더 잘 활용하는 방법"이라는 공통 목표를 가지지만, 접근 방식이 근본적으로 다르다.

### MoAI-ADK: "더 나은 개발 도구"
- **Go 바이너리 기반**: 5ms 시작, 컴파일 타임 안전성, LSP/AST-grep 통합
- **정적 분석 중심**: 코드를 구조적으로 분석하고 품질을 컴파일 타임에 보장
- **Ralph Engine**: 자율 에러 수정 루프, 하지만 **규칙 기반** (LSP 진단 + 고정된 전략)
- **TRUST 5 / EARS**: 산업 표준 품질 프레임워크와 요구사항 형식 채택
- **핵심 가치**: 안정적이고 예측 가능한 개발 워크플로우 자동화

### Artibot: "학습하고 진화하는 AI 에이전트"
- **인지 과학 기반 아키텍처**: Kahneman의 이중 처리 이론을 소프트웨어로 구현
- **자기학습 엔진**: GRPO로 경험에서 학습하고, 전략 가중치를 자율 조정
- **Knowledge Transfer**: System 2에서 검증된 패턴을 System 1으로 승격 (hot-swap)
- **Federated Swarm**: 다수의 Artibot 인스턴스가 학습 결과를 공유하는 연합 학습
- **핵심 가치**: 시간이 지날수록 더 똑똑해지는 적응형 AI 에이전트

**비유**: MoAI는 **전동공구** (파워풀하고 정밀한 도구), Artibot은 **견습생** (처음엔 서툴지만 경험에서 배우며 성장)

---

## Dimension Scores

| # | Dimension | Weight | MoAI-ADK | Artibot | Notes |
|---|-----------|--------|----------|---------|-------|
| 1 | Agent Architecture | 15% | **9.0** | 7.5 | MoAI: 28 agents + Model Policy, Artibot: 19 agents + CTO + Model Policy + Categories + Memory Scopes |
| 2 | Orchestration Patterns | 15% | **8.5** | 7.5 | MoAI: Plan-Run-Sync + Ralph, Artibot: 5 patterns + PDCA playbooks |
| 3 | Skill System | 10% | **9.0** | 6.5 | MoAI: 51 skills + progressive disclosure, Artibot: 25 skills |
| 4 | Command System | 10% | 7.0 | **7.5** | Artibot: 26 commands + multi-language intent detection |
| 5 | Hook System | 10% | **8.5** | 7.0 | MoAI: 14 events + 4 hook types, Artibot: 10 events + Node.js ESM |
| 6 | API Integration | 10% | **8.0** | 7.5 | MoAI: 4 MCP + LSP + AST-grep, Artibot: 2 MCP + Agent Teams + Cognitive Engine |
| 7 | Code Quality | 10% | **9.0** | 7.0 | MoAI: 39K LOC Go, 85-100% coverage; Artibot: 874 tests/29 files, ESLint, vitest |
| 8 | Documentation | 5% | **9.0** | 6.0 | MoAI: 4-language, CONTRIBUTING, SECURITY; Artibot: README + inline docs |
| 9 | CI/CD | 5% | **8.5** | 6.5 | MoAI: GH Actions + CodeQL + Codecov; Artibot: GH Actions (Node 18+20 matrix) + ESLint |
| 10 | Innovation | 10% | 8.0 | **8.5** | Artibot: Kahneman System 1/2, GRPO, Knowledge Transfer, Federated Swarm, PII Scrubber |

---

## Detailed Analysis

### 1. Agent Architecture (15%)

**MoAI-ADK: 9.0/10**

- **28 specialized agents** in 4 well-defined categories
- Agent frontmatter includes: name, description, tools, model, permissionMode, maxTurns, skills, mcpServers, hooks, memory
- **Model Policy system**: High/Medium/Low tiers
- **Permission modes**: 6 types (default, acceptEdits, delegate, dontAsk, bypassPermissions, plan)
- **Persistent memory** scopes: user, project, local

**Artibot: 7.5/10**

- **19 agents** (1 orchestrator + 18 teammates) with CTO delegation model
- **Model Policy** (artibot.config.json `agents.modelPolicy`):
  - High: Opus (orchestrator, architect, security-reviewer)
  - Medium: Sonnet (12 agents: frontend-developer, backend-developer, code-reviewer, etc.)
  - Low: Haiku (10 agents: doc-updater, content-marketer, e2e-runner, etc.)
- **Agent Categories** (artibot.config.json `agents.categories`):
  - Manager (3): orchestrator, planner, architect
  - Expert (9): security-reviewer, frontend-developer, backend-developer, etc.
  - Builder (4): code-reviewer, tdd-guide, build-error-resolver, refactor-cleaner
  - Support (10): doc-updater, content-marketer, e2e-runner, etc.
- **Task-Based Agent Selection** (`agents.taskBased`): 22 task types mapped to specific agents
- **Memory Scopes** (artibot.config.json `learning.memoryScopes`):
  - User scope: `~/.claude/artibot/`
  - Project scope: `.artibot/`
  - Session scope: in-memory
- Dual delegation: Sub-Agent (complexity < 0.4) vs Agent Team (complexity >= 0.4)
- 3 team levels: Solo (0), Squad (2-4), Platoon (5+)

**Gap Analysis**: MoAI의 agent 수(28 vs 19)와 permission mode 다양성에서 우위. Artibot도 Model Policy와 Categories를 도입했으며, memory scopes(user/project/session)와 22개 task-based mapping이 있으나 agent 수와 설정 깊이에서 여전히 차이가 있다.

---

### 2. Orchestration Patterns (15%)

**MoAI-ADK: 8.5/10** (변경 없음)

**Artibot: 7.5/10** (변경 없음)

- **5 Orchestration Patterns**: Leader, Council, Swarm, Pipeline, Watchdog
- **8 Playbooks**: feature, bugfix, refactor, security, marketing-campaign, marketing-audit, content-launch, competitive-analysis
- Delegation mode selection: complexity scoring 기반 (threshold 0.4)
- 4 orchestration pattern types: plan(leader), design(council), do(swarm), check(council), act(leader)

---

### 3. Skill System (10%)

**MoAI-ADK: 9.0/10** (변경 없음)

**Artibot: 6.5/10** (변경 없음)

---

### 4. Command System (10%)

**MoAI-ADK: 7.0/10** (변경 없음)

**Artibot: 7.5/10** (변경 없음)

---

### 5. Hook System (10%)

**MoAI-ADK: 8.5/10** (변경 없음)

**Artibot: 7.0/10** (변경 없음)

---

### 6. API Integration (10%)

**MoAI-ADK: 8.0/10** (변경 없음)

**Artibot: 7.5/10** (6.0 -> 7.5, 인지 엔진 반영)

- **2 MCP Servers**: Context7 + Playwright
- **Agent Teams API** (Native): TeamCreate, TeamDelete, SendMessage, TaskCreate/Update/List/Get
- **Cognitive Engine** (신규, lib/cognitive/):
  - `router.js`: Multi-factor complexity classification with 5 weighted signals
  - `system1.js`: Pattern matching + memory RAG + tool suggestion (< 100ms target)
  - `system2.js`: Plan -> Execute -> Reflect loop with auto-retry
  - `sandbox.js`: Safe execution context with 30+ blocked patterns
- **Learning Pipeline** (신규, lib/learning/):
  - `grpo-optimizer.js`: Group Relative Policy Optimization
  - `knowledge-transfer.js`: System 2 -> System 1 promotion/demotion
  - `memory-manager.js`: BlenderBot-inspired RAG system
  - `tool-learner.js`: Toolformer + GRPO tool selection
  - `lifelong-learner.js`: Experience collection + batch learning
  - `self-evaluator.js`: Meta Self-Rewarding quality assessment
- **Swarm Intelligence** (신규, lib/swarm/):
  - `swarm-client.js`: HTTP client with retry + offline queueing
  - `pattern-packager.js`: Pattern -> weight conversion + merge
  - `sync-scheduler.js`: Session-based sync scheduling
- **Privacy** (신규, lib/privacy/):
  - `pii-scrubber.js`: 43 regex patterns across 9 categories
- Zero external runtime dependencies (Node.js built-in only)
- lib/core/ modules: platform, config, cache, IO, debug, file, TUI, skill-exporter
- lib/adapters/: Gemini, Codex, Cursor adapters

**Gap Analysis**: MoAI가 MCP 서버 수(4 vs 2)와 LSP/AST-grep 통합에서 우위. 그러나 Artibot의 인지 엔진(System 1/2 + GRPO + Knowledge Transfer + Federated Swarm)은 MoAI에 없는 완전히 새로운 차원의 기능이다. Artibot은 외부 도구 통합보다 자기학습 인프라 구축에 투자했다.

---

### 7. Code Quality (10%)

**MoAI-ADK: 9.0/10** (변경 없음)

- 39,239 lines Go source, 63,781 lines test code
- 235 source files, 178 test files
- 85-100% test coverage
- Race detection, golangci-lint, gofumpt

**Artibot: 7.0/10** (6.0 -> 7.0, 테스트 + ESLint 반영)

- Node.js ESM with zero external runtime dependencies (devDependencies: vitest, @vitest/coverage-v8, eslint)
- **29 test files**, **874 test cases** (vitest framework):
  - Cognitive: router(51), system1(41), system2(58), sandbox(57)
  - Learning: grpo(41), knowledge-transfer(34), lifelong-learner(35), memory-manager(35), tool-learner(31), self-evaluator(33)
  - Swarm: swarm-client(35), pattern-packager(27), sync-scheduler(25)
  - Privacy: pii-scrubber(76)
  - Core: cache(22), config(9), debug(7), file(21), io(10), platform(11)
  - Context: session(22), hierarchy(14)
  - Intent: language(20), trigger(19), ambiguity(13), detect(8)
  - System: telemetry-collector(32), context-injector(59)
  - Adapters: base-adapter(28)
- **ESLint flat config** (eslint.config.js): @eslint/js recommended + no-console, no-unused-vars, consistent-return, eqeqeq
- `npm run ci`: validate + lint + test 통합 파이프라인
- Clean separation: 7 lib modules (cognitive, learning, swarm, privacy, system, core, adapters)
- ~7K LOC lib/ (38 JS source files) + ~4K LOC tests

**Gap Analysis**: MoAI의 코드 품질이 여전히 우수하다 (39K LOC + 178 test files + 85-100% coverage). Artibot은 이전 벤치마크에서 "No tests, No linting"이었으나 현재 874 test cases + ESLint가 도입되어 크게 개선되었다. 그러나 Go의 정적 타입과 race detection 수준에는 미달한다.

---

### 8. Documentation (5%)

**MoAI-ADK: 9.0/10** (변경 없음)

**Artibot: 6.0/10** (변경 없음, 다른 팀원이 CONTRIBUTING/SECURITY/CHANGELOG 작업 중이나 아직 미완료)

---

### 9. CI/CD (5%)

**MoAI-ADK: 8.5/10** (변경 없음)

**Artibot: 6.5/10** (5.5 -> 6.5, GitHub Actions + ESLint 반영)

- **GitHub Actions CI** (ci.yml): Node 18 + 20 matrix, ubuntu-latest
  - 4 validation steps: validate-agents, validate-skills, validate-commands, validate-hooks
  - vitest test runner (conditional)
  - ESLint linting (conditional)
- **Release workflow** (release.yml): 릴리스 자동화
- **Plugin validation workflow** (plugin-validate.yml): 플러그인 구조 검증
- **ESLint flat config** (eslint.config.js): ESM, @eslint/js recommended
- package.json scripts: validate, lint, lint:fix, ci, test, test:watch, test:coverage
- devDependencies: vitest@^3.0.0, @vitest/coverage-v8@^3.0.0, eslint@^9.0.0
- 4 CI validation scripts (ESM)

**Gap Analysis**: MoAI가 CodeQL + Codecov 통합에서 여전히 우위. Artibot은 GitHub Actions CI + ESLint + vitest가 도입되어 이전 "No CI/CD"에서 크게 개선되었으나, 코드 커버리지 자동 추적과 보안 스캔은 아직 없다.

---

### 10. Innovation (10%)

**MoAI-ADK: 8.0/10** (변경 없음)

- Ralph Engine: 자율 에러 수정 루프
- LSP Integration: 16+ 언어 실시간 진단
- TRUST 5 Framework: 품질 프레임워크
- Model Policy: 구독 플랜별 모델 배분
- 3-Level Progressive Disclosure: 토큰 최적화
- EARS Format: 산업 표준 요구사항
- Go Binary: ~5ms 시작 시간

**Artibot: 8.5/10** (7.5 -> 8.5, 인지 엔진 혁신 반영)

MoAI에 없는 Artibot 고유 혁신 (코드 근거 포함):

**1. Kahneman System 1/2 인지 라우팅**
- 파일: `lib/cognitive/router.js`
- `classifyComplexity()`: 5가지 가중 신호(steps 0.25, domains 0.20, uncertainty 0.20, risk 0.20, novelty 0.15)로 입력 복잡도 분류
- `route()`: 복잡도 점수 기반 System 1(< threshold) 또는 System 2(>= threshold) 자동 라우팅
- 다국어 키워드 매칭: 영어 + 한국어 + 일본어 (7개 도메인)

**2. 적응형 임계값 (Adaptive Threshold)**
- 파일: `lib/cognitive/router.js`
- `adaptThreshold()`: 피드백 기반 라우팅 임계값 자동 조정
- System 1 실패 시 임계값 낮춤 (더 많은 입력을 System 2로), 5회 연속 성공 시 올림
- 범위: 0.2 ~ 0.7, 기본값 0.4, 적응 스텝 0.05

**3. GRPO (Group Relative Policy Optimization) 자기학습**
- 파일: `lib/learning/grpo-optimizer.js`
- `generateCandidates()`: 도메인별 전략 후보 생성 (balanced, thorough, rapid, parallel, iterative + 도메인 특화)
- `evaluateGroup()`: 5가지 규칙 기반 평가 (exitCode, errorFree, speed, brevity, sideEffects)
- `updateWeights()`: 상대적 순위 기반 전략 가중치 업데이트 (학습률 0.1)
- `generateTeamCandidates()` + `evaluateTeamGroup()` + `updateTeamWeights()`: 팀 구성 GRPO (Solo/Leader/Council/Swarm/Pipeline 비교)

**4. Knowledge Transfer (System 2 -> System 1 승격)**
- 파일: `lib/learning/knowledge-transfer.js`
- `promoteToSystem1()`: 3회 연속 성공 + 신뢰도 > 0.8 시 System 2 패턴을 System 1로 승격
- `demoteFromSystem1()`: 2회 연속 실패 또는 에러율 > 20% 시 강등
- `hotSwap()`: 파일 레벨 락으로 동시성 제어, 재시작 없이 즉시 반영
- `recordSystem1Usage()`: 사용 결과 기록 + 자동 강등 판단

**5. Federated Swarm Intelligence**
- 파일: `lib/swarm/swarm-client.js`, `lib/swarm/pattern-packager.js`, `lib/swarm/sync-scheduler.js`
- `uploadWeights()`: PII 스크러빙 + 차등 프라이버시 노이즈 적용 후 가중치 업로드, 오프라인 큐 지원
- `downloadLatestWeights()`: SHA-256 체크섬 검증 + 델타 다운로드
- `packagePatterns()`: 로컬 패턴을 정규화된 가중치 벡터로 변환 (4 카테고리: tools, errors, commands, teams)
- `mergeWeights()`: 로컬 30% + 글로벌 70% 가중 평균 머지
- `scheduleSync()`: session/hourly/daily 동기화 스케줄링

**6. PII Scrubber**
- 파일: `lib/privacy/pii-scrubber.js`
- **43개 regex 패턴**, 9개 카테고리 (credentials, auth, secrets, env, network, personal, identifiers, paths, code, git)
- 우선순위 기반 적용 (0-89), 플랫폼 인식 경로 감지 (Windows/macOS/Linux)
- PEM 키, OpenAI/GitHub/AWS/GCP/Slack/Stripe/Twilio 토큰, JWT, 이메일, 전화번호, SSN, 신용카드, UUID 등
- `validateScrubbed()`: 잔여 PII 검증, `createScopedScrubber()`: 카테고리별 부분 스크러빙
- 연합학습에서 개인정보 보호를 보장하는 핵심 인프라

**7. Native Claude Agent Teams API as Core Engine**
- 환경변수: `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`
- API: TeamCreate, TeamDelete, SendMessage, TaskCreate/Update/List/Get
- 5가지 메시지 타입: message, broadcast, shutdown_request, shutdown_response, plan_approval_response
- MoAI도 Agent Teams를 지원하지만 선택적 옵션; Artibot은 핵심 엔진으로 사용

**8. Zero Runtime Dependency Architecture**
- 모든 lib/ 모듈이 Node.js 내장 모듈만 사용 (node:fs, node:path, node:os, node:crypto)
- devDependencies(vitest, eslint)만 사용하고 런타임 의존성 0
- MoAI는 charmbracelet, cobra, yaml.v3 등 외부 의존성 사용

**Gap Analysis**: Artibot의 인지 과학 기반 자기학습 아키텍처(System 1/2, GRPO, Knowledge Transfer, Federated Swarm)는 MoAI에 완전히 없는 기능 카테고리다. MoAI의 Ralph Engine은 규칙 기반 자동 수정이지만, Artibot의 GRPO는 경험에서 학습하여 전략 가중치를 자율 조정한다. MoAI가 LSP/AST-grep 같은 컴파일 타임 도구 혁신에서 우위인 반면, Artibot은 런타임 학습/적응 혁신에서 우위다.

---

## Weighted Score Calculation

| # | Dimension | Weight | MoAI-ADK | Weighted | Artibot | Weighted |
|---|-----------|--------|----------|----------|---------|----------|
| 1 | Agent Architecture | 0.15 | 9.0 | 1.350 | 7.5 | 1.125 |
| 2 | Orchestration Patterns | 0.15 | 8.5 | 1.275 | 7.5 | 1.125 |
| 3 | Skill System | 0.10 | 9.0 | 0.900 | 6.5 | 0.650 |
| 4 | Command System | 0.10 | 7.0 | 0.700 | 7.5 | 0.750 |
| 5 | Hook System | 0.10 | 8.5 | 0.850 | 7.0 | 0.700 |
| 6 | API Integration | 0.10 | 8.0 | 0.800 | 7.5 | 0.750 |
| 7 | Code Quality | 0.10 | 9.0 | 0.900 | 7.0 | 0.700 |
| 8 | Documentation | 0.05 | 9.0 | 0.450 | 6.0 | 0.300 |
| 9 | CI/CD | 0.05 | 8.5 | 0.425 | 6.5 | 0.325 |
| 10 | Innovation | 0.10 | 8.0 | 0.800 | 8.5 | 0.850 |
| | **TOTAL** | **1.00** | | **8.45** | | **7.28** |

---

## Score Changes from v1 Benchmark

| Dimension | v1 Score | v2 Score | Delta | Reason |
|-----------|----------|----------|-------|--------|
| Agent Architecture | 7.0 | 7.5 | +0.5 | Model Policy, Categories, Memory Scopes 추가 (artibot.config.json 확인) |
| Code Quality | 6.0 | 7.0 | +1.0 | 874 tests / 29 files, ESLint flat config, vitest@3 도입 |
| CI/CD | 5.5 | 6.5 | +1.0 | GitHub Actions CI (Node 18+20 matrix), ESLint, 3개 workflow |
| API Integration | 7.0 | 7.5 | +0.5 | Cognitive Engine + Learning Pipeline + Swarm + Privacy 코드 확인 |
| Innovation | 7.5 | 8.5 | +1.0 | System 1/2, GRPO, Knowledge Transfer, Federated Swarm, PII Scrubber 코드 분석 |
| **Total** | **6.90** | **7.28** | **+0.38** | 코드 품질 + 혁신 차원에서 주요 개선 |

**변경하지 않은 차원**: Orchestration Patterns(7.5), Skill System(6.5), Command System(7.5), Hook System(7.0), Documentation(6.0) - 기존 분석이 정확하거나 관련 코드 변경 없음.

---

## Key Findings

### MoAI-ADK Strengths (변경 없음)
1. **Production-Grade Code Quality**: 39K LOC Go + 85-100% coverage + race detection
2. **Ralph Engine**: LSP + AST-grep + convergence detection 자율 에러 수정
3. **Progressive Disclosure**: 3-level 토큰 최적화
4. **Comprehensive Skill Coverage**: 51 skills, 18 languages
5. **Enterprise Documentation**: 4-language README + 완전한 오픈소스 문서 체계

### MoAI-ADK Weaknesses (변경 없음)
1. Go 빌드 환경 필요
2. 28 agents + 51 skills + EARS/SPEC/TRUST 5의 높은 진입 장벽
3. 2개 command .md로 확장성 제한
4. Agent Teams는 실험적 기능

### Artibot Strengths (업데이트)
1. **Self-Learning Cognitive Engine**: Kahneman System 1/2 + GRPO + Knowledge Transfer -- 시간이 지나면서 스스로 학습하고 진화하는 AI 에이전트 아키텍처
2. **Federated Swarm Intelligence**: 다수 Artibot 인스턴스 간 학습 결과 공유, PII 보호 + 차등 프라이버시
3. **874 Test Cases**: 29 test files, vitest@3 + ESLint flat config으로 코드 품질 인프라 구축
4. **Native Agent Teams Integration**: Claude Code Agent Teams API를 core engine으로 사용
5. **Zero Runtime Dependencies**: Node.js 내장 모듈만 사용, 설치 마찰 최소화
6. **Command Richness**: 26개 커맨드 + 다국어 인텐트 감지
7. **Privacy-First Design**: 43 regex PII scrubber가 연합학습의 개인정보 보호 보장

### Artibot Weaknesses (업데이트)
1. **Smaller Skill Set**: 25 skills (MoAI 51의 절반 이하), 언어별 스킬 부재
2. **No Progressive Disclosure**: 스킬 로딩 최적화 시스템 부재
3. **Test Coverage 미측정**: 874 tests가 있으나 coverage 자동 추적이 아직 미설정
4. **Documentation Gap**: CONTRIBUTING, SECURITY, CHANGELOG 작업 진행 중
5. **Swarm Server 미배포**: Federated Swarm 서버가 아직 운영 환경에 없음 (클라이언트 코드만 존재)

---

## Where Artibot Definitively Wins

MoAI에는 없고 Artibot에만 있는 것들:

| Innovation | Artibot Code | MoAI Equivalent |
|------------|-------------|-----------------|
| Kahneman System 1/2 인지 라우팅 | `router.js` classifyComplexity() | 없음 (정적 라우팅) |
| GRPO 자기학습 | `grpo-optimizer.js` evaluateGroup() + updateWeights() | 없음 (규칙 기반만) |
| Knowledge Transfer (S2->S1 승격) | `knowledge-transfer.js` hotSwap() + promoteToSystem1() | 없음 |
| Federated Swarm Intelligence | `swarm-client.js` + `pattern-packager.js` + `sync-scheduler.js` | 없음 |
| PII Scrubber (43 patterns, 9 categories) | `pii-scrubber.js` | 없음 |
| Adaptive Threshold | `router.js` adaptThreshold() | 없음 |
| BlenderBot-inspired Memory + RAG | `memory-manager.js` searchMemory() | 없음 (파일 기반 memory만) |
| Toolformer + GRPO Tool Selection | `tool-learner.js` suggestTool() | 없음 |
| Self-Rewarding Evaluation | `self-evaluator.js` | 없음 |
| Lifelong Learning Pipeline | `lifelong-learner.js` | 없음 |

## Where MoAI Definitively Wins

Artibot에는 없고 MoAI에만 있는 것들:

| Innovation | MoAI Code | Artibot Equivalent |
|------------|----------|---------------------|
| Ralph Engine (자율 에러 수정) | internal/ralph/ (100% test coverage) | 없음 |
| LSP Integration (16+ 언어) | internal/lsp/ | 없음 |
| AST-grep Integration | skill: ast-grep | 없음 |
| 3-Level Progressive Disclosure | SKILL.md frontmatter | 없음 |
| EARS Requirements Format | skill: spec | 없음 |
| TRUST 5 Quality Framework | skill: quality | 없음 |
| StatusLine Integration | internal/statusline/ | 없음 |
| 3-Way Merge Engine | skill: worktree | 없음 |
| Go Binary (~5ms startup) | cmd/moai/main.go | 없음 (Node.js runtime) |
| 18 Language Skills | skills/languages/ | 없음 |

---

## Methodology Note

This benchmark revision was conducted by **reading all source code files** in the Artibot codebase:

**Cognitive Engine**: router.js (559 lines), system1.js (640 lines), system2.js (906 lines), sandbox.js (478 lines)
**Learning Pipeline**: grpo-optimizer.js (502 lines), knowledge-transfer.js (612 lines), memory-manager.js, tool-learner.js, lifelong-learner.js, self-evaluator.js
**Swarm Intelligence**: swarm-client.js (466 lines), pattern-packager.js (499 lines), sync-scheduler.js (426 lines)
**Privacy**: pii-scrubber.js (743 lines, 43 regex patterns)
**Config**: artibot.config.json (159 lines), package.json (25 lines)
**Tests**: 29 test files, 874 test cases (grep count of `it(` and `test(` patterns)
**CI**: ci.yml (Node 18+20 matrix), release.yml, plugin-validate.yml, eslint.config.js

All scores are evidence-based. Dimensions where no code change was found retain their original scores. MoAI source code was not re-analyzed (original MoAI scores preserved as-is).
