# Artibot 최종 아키텍처 설계서

> 4개 레퍼런스 레포 분석 + 기존 ARCHITECTURE.md 통합 결과

**작성일**: 2026-02-13
**작성자**: prompt-engineer
**분석 대상**:
1. `ui-ux-pro-max-skill` - 스킬 중심 플러그인 (CLI 설치 + CSV 데이터)
2. `cc-wf-studio` - VSCode 확장 (speckit 커맨드 시스템)
3. `everything-claude-code` - 종합 설정 플러그인 (에이전트/스킬/훅/커맨드)
4. `bkit-claude-code` - 엔터프라이즈 프레임워크 (PDCA + Agent Teams + 런타임 스크립트)

---

## 1. 레퍼런스 레포 비교 분석

### 1.1 아키텍처 패턴 비교

| 차원 | ui-ux-pro-max | cc-wf-studio | everything-claude-code | bkit-claude-code |
|------|---------------|--------------|----------------------|-----------------|
| **유형** | 데이터 기반 스킬 | VSCode 확장 | 정적 설정 번들 | 런타임 프레임워크 |
| **구조** | 단일 스킬 + CLI | 커맨드 + 스킬 | agents/ + skills/ + commands/ + hooks/ | agents/ + skills/ + hooks/ + lib/ + scripts/ |
| **런타임 코드** | Python 검색엔진 | TypeScript 확장 | Node.js 훅 스크립트 (~20개) | Node.js 런타임 (~83개 JS) |
| **설정 시스템** | 없음 | biome.json | .claude/package-manager.json | bkit.config.json (포괄적) |
| **팀 시스템** | 없음 | 없음 | 없음 | CTO-led Agent Teams (완전 구현) |
| **PDCA** | 없음 | 없음 | 없음 | 전체 PDCA 라이프사이클 |
| **다국어** | 없음 | 일본어 | 없음 | 8개 언어 지원 |
| **Output Styles** | 없음 | 없음 | 없음 | 4개 스타일 (레벨별) |
| **토큰 효율** | 낮음 (CSV 전체 로드) | 해당없음 | 중간 (선택적 로드) | 높음 (지연 로딩 + 캐시) |

### 1.2 플러그인 매니페스트 패턴

| 필드 | ui-ux-pro-max | everything-claude-code | bkit-claude-code |
|------|---------------|----------------------|-----------------|
| `version` | "2.0.1" | "1.4.1" | "1.5.3" |
| `skills` | `["./.claude/skills/ui-ux-pro-max"]` | `["./skills/", "./commands/"]` | 없음 (자동 로드) |
| `agents` | 없음 | 개별 파일 배열 (13개 명시) | 없음 (자동 로드) |
| `outputStyles` | 없음 | 없음 | `"./output-styles/"` |
| `hooks` | 없음 | 없음 (자동 로드) | 없음 (자동 로드) |

**핵심 발견: plugin.json 규칙** (everything-claude-code PLUGIN_SCHEMA_NOTES.md 기반):
- `agents` 필드는 반드시 **개별 파일 경로 배열** (디렉토리 불가)
- `commands`, `skills`는 디렉토리 경로 배열 가능
- `version` 필드 필수
- `hooks` 필드 **절대 선언 금지** (hooks/hooks.json은 자동 로드, 중복 오류 발생)
- 모든 컴포넌트 필드는 반드시 배열 형태

### 1.3 훅 시스템 비교

| 훅 이벤트 | everything-claude-code | bkit-claude-code | Artibot 채택 |
|-----------|----------------------|-----------------|-------------|
| SessionStart | session-start.js | session-start.js | **채택** |
| SessionEnd | session-end.js + evaluate-session.js | 없음 | **채택** (학습) |
| PreToolUse(Write/Edit) | suggest-compact.js | pre-write.js | **채택** |
| PreToolUse(Bash) | tmux 체크 + git push 리뷰 | unified-bash-pre.js | **채택** |
| PostToolUse(Write) | 없음 | unified-write-post.js | 선택적 |
| PostToolUse(Edit) | prettier + typecheck + console-warn | 없음 | **채택** |
| PostToolUse(Bash) | PR URL 로깅 | unified-bash-post.js | **채택** |
| PostToolUse(Skill) | 없음 | skill-post.js | 선택적 |
| PreCompact | pre-compact.js (상태 저장) | context-compaction.js | **채택** |
| Stop | check-console-log.js | unified-stop.js | **채택** |
| UserPromptSubmit | 없음 | user-prompt-handler.js | **채택** (의도 감지) |
| TaskCompleted | 없음 | pdca-task-completed.js | 선택적 |
| SubagentStart/Stop | 없음 | subagent-start/stop-handler.js | **채택** |
| TeammateIdle | 없음 | team-idle-handler.js | **채택** |

### 1.4 에이전트 팀 시스템 (bkit 핵심 패턴)

bkit의 CTO-led Agent Teams는 Artibot에서 가장 중요한 채택 대상:

```
cto-lead (opus)
├── Task(enterprise-expert)     # 엔터프라이즈 전문가
├── Task(infra-architect)       # 인프라 설계
├── Task(bkend-expert)          # 백엔드 전문가
├── Task(frontend-architect)    # 프론트엔드 설계
├── Task(security-architect)    # 보안 설계
├── Task(product-manager)       # 요구사항
├── Task(qa-strategist)         # QA 전략
├── Task(code-analyzer)         # 코드 분석
├── Task(gap-detector)          # 갭 분석
├── Task(report-generator)      # 리포트 생성
└── Task(Explore)               # 탐색
```

**오케스트레이션 패턴**:
- Leader: CTO가 분배, 팀원 실행 (Plan, Act)
- Council: 다중 관점 수집 (Design, Check)
- Swarm: 대규모 병렬 구현 (Do)
- Pipeline: 순차 의존성 체인 (Plan → Design → Do)
- Watchdog: 지속 모니터링 (Check ongoing)

### 1.5 런타임 인프라 비교

| 모듈 | bkit-claude-code | everything-claude-code | Artibot 채택 |
|------|-----------------|----------------------|-------------|
| **플랫폼 감지** | lib/core/platform.js | 없음 | **채택** (환경 감지) |
| **캐시** | lib/core/cache.js (TTL 기반) | 없음 | **채택** |
| **I/O** | lib/core/io.js (stdin/stdout 파싱) | 인라인 node -e | **채택** (bkit 방식) |
| **설정 로더** | lib/core/config.js | .claude/package-manager.json | **채택** (bkit 방식) |
| **파일 유틸** | lib/core/file.js | 없음 | **채택** |
| **디버그 로깅** | lib/core/debug.js | 없음 | **채택** |
| **의도 감지** | lib/intent/ (언어+트리거+모호성) | 없음 | **채택** (핵심) |
| **컨텍스트 계층** | lib/context-hierarchy.js (4레벨) | 없음 | **채택** (핵심) |
| **컨텍스트 포크** | lib/context-fork.js | 없음 | 선택적 |
| **임포트 해석** | lib/import-resolver.js | 없음 | 선택적 |
| **세션 관리** | 없음 | scripts/lib/session-manager.js | **채택** |
| **패키지 매니저** | 없음 | scripts/lib/package-manager.js | **채택** |

---

## 2. 기존 ARCHITECTURE.md 평가

### 2.1 유지할 설계

| 항목 | 내용 | 상태 |
|------|------|------|
| 멀티 플러그인 전략 | core + personas + workflow + quality + mcp | **유지** (구조 개선) |
| 스킬 기반 지연 로딩 | 필요한 스킬만 자동 활성화 | **유지** |
| CLAUDE.md 최소화 | ~200 토큰 목표 | **유지** |
| 3계층 인터페이스 규약 | 스킬/에이전트/커맨드 표준 템플릿 | **유지** (개선) |
| 확장 포인트 구조 | 새 페르소나/커맨드/에이전트 추가 패턴 | **유지** |

### 2.2 수정 및 보강 사항

| 항목 | 기존 설계 | 문제점 | 개선 방향 |
|------|-----------|--------|-----------|
| **런타임 인프라** | 없음 | 순수 정적 .md 파일만으로는 지능형 라우팅 불가 | bkit 패턴 채택: lib/ + scripts/ 런타임 |
| **훅 시스템** | hooks.json 언급만 | 구체적 훅 스크립트 설계 없음 | 10개 훅 이벤트 전체 설계 |
| **팀 오케스트레이션** | 없음 | Agent Teams 미활용 | bkit CTO-led 패턴 채택 |
| **설정 시스템** | 없음 | 프로젝트별 설정 불가 | artibot.config.json 도입 |
| **Output Styles** | 없음 | 출력 형식 커스터마이징 불가 | 레벨별 Output Style 도입 |
| **의도 감지** | 오케스트레이션 스킬에 의존 | .md 파일 기반은 지능적 라우팅 한계 | lib/intent/ 런타임 감지 |
| **컨텍스트 계층** | 없음 | Plugin → User → Project → Session 레벨 없음 | 4-레벨 컨텍스트 계층 도입 |
| **CI/CD 검증** | 없음 | 매니페스트 검증 자동화 없음 | scripts/ci/ 검증 스크립트 |
| **plugin.json 구조** | 기본적 | agents 필드 누락, 필수 규칙 미반영 | PLUGIN_SCHEMA_NOTES 준수 |

---

## 3. Artibot 최종 아키텍처

### 3.1 디렉토리 구조

```
artibot/
├── .claude-plugin/
│   ├── plugin.json                          # 메인 매니페스트
│   └── marketplace.json                     # 마켓플레이스 메타데이터
│
├── agents/                                  # 에이전트 정의 (18개, 통합 후)
│   ├── orchestrator.md                      # CTO-level 오케스트레이터 (opus)
│   ├── architect.md                         # 시스템 아키텍트 (opus)
│   ├── frontend-developer.md                # 프론트엔드 전문가 (sonnet)
│   ├── backend-developer.md                 # 백엔드 전문가 (sonnet)
│   ├── security-reviewer.md                 # 보안 리뷰어 (opus)
│   ├── code-reviewer.md                     # 코드 리뷰어 (opus)
│   ├── database-reviewer.md                 # DB 리뷰어 (opus)
│   ├── build-error-resolver.md              # 빌드 에러 해결 (opus)
│   ├── e2e-runner.md                        # E2E 테스트 실행 (opus)
│   ├── tdd-guide.md                         # TDD 가이드 (opus)
│   ├── planner.md                           # 구현 플래너 (opus)
│   ├── refactor-cleaner.md                  # 리팩토링/정리 (opus)
│   ├── doc-updater.md                       # 문서/코드맵 (opus)
│   ├── content-marketer.md                  # 콘텐츠 마케팅 (sonnet)
│   ├── devops-engineer.md                   # DevOps (sonnet)
│   ├── llm-architect.md                     # LLM 시스템 설계 (opus)
│   ├── mcp-developer.md                     # MCP 프로토콜 개발 (sonnet)
│   └── typescript-pro.md                    # TypeScript 전문가 (sonnet)
│
├── commands/                                # 슬래시 커맨드
│   ├── sc.md                                # SuperClaude 라우터
│   ├── analyze.md                           # 분석
│   ├── build.md                             # 빌드
│   ├── build-fix.md                         # 빌드 에러 수정
│   ├── implement.md                         # 구현
│   ├── improve.md                           # 개선
│   ├── plan.md                              # 계획
│   ├── design.md                            # 설계
│   ├── task.md                              # 태스크 관리
│   ├── test.md                              # 테스팅
│   ├── tdd.md                               # TDD 워크플로우
│   ├── code-review.md                       # 코드 리뷰
│   ├── refactor-clean.md                    # 리팩토링
│   ├── troubleshoot.md                      # 트러블슈팅
│   ├── git.md                               # Git 워크플로우
│   ├── document.md                          # 문서화
│   ├── content.md                           # 콘텐츠 생성
│   ├── orchestrate.md                       # 팀 오케스트레이션
│   ├── checkpoint.md                        # 체크포인트
│   ├── verify.md                            # 검증
│   └── learn.md                             # 패턴 학습
│
├── skills/                                  # 자동 활성화 스킬
│   ├── orchestration/                       # [핵심] 라우팅 인텔리전스
│   │   ├── SKILL.md
│   │   └── references/
│   │       ├── routing-table.md
│   │       ├── flag-system.md
│   │       └── persona-activation.md
│   ├── token-efficiency/                    # [핵심] 토큰 최적화
│   │   ├── SKILL.md
│   │   └── references/
│   │       └── symbol-system.md
│   ├── principles/                          # 개발 원칙
│   │   ├── SKILL.md
│   │   └── references/
│   │       ├── solid.md
│   │       └── quality-gates.md
│   ├── coding-standards/                    # 코딩 표준
│   │   ├── SKILL.md
│   │   └── references/
│   │       ├── immutability.md
│   │       ├── error-handling.md
│   │       └── file-organization.md
│   ├── security-standards/                  # 보안 표준
│   │   ├── SKILL.md
│   │   └── references/
│   │       └── owasp-checklist.md
│   ├── testing-standards/                   # 테스팅 표준
│   │   ├── SKILL.md
│   │   └── references/
│   │       └── coverage-requirements.md
│   ├── git-workflow/                        # Git 워크플로우
│   │   ├── SKILL.md
│   │   └── references/
│   │       └── commit-conventions.md
│   ├── tdd-workflow/                        # TDD 워크플로우
│   │   └── SKILL.md
│   ├── delegation/                          # 위임/병렬 실행
│   │   ├── SKILL.md
│   │   └── references/
│   │       └── delegation-matrix.md
│   ├── mcp-context7/                        # Context7 활용
│   │   └── SKILL.md
│   ├── mcp-playwright/                      # Playwright 활용
│   │   └── SKILL.md
│   ├── mcp-coordination/                    # MCP 서버 조율
│   │   ├── SKILL.md
│   │   └── references/
│   │       ├── server-selection.md
│   │       └── fallback-strategies.md
│   ├── continuous-learning/                 # 지속 학습
│   │   ├── SKILL.md
│   │   └── config.json
│   ├── strategic-compact/                   # 전략적 컴팩션
│   │   └── SKILL.md
│   │
│   │  # ─── 페르소나 스킬 (11개) ───
│   ├── persona-architect/
│   │   ├── SKILL.md
│   │   └── references/
│   │       └── decision-framework.md
│   ├── persona-frontend/
│   │   ├── SKILL.md
│   │   └── references/
│   │       └── performance-budgets.md
│   ├── persona-backend/
│   │   └── SKILL.md
│   ├── persona-security/
│   │   └── SKILL.md
│   ├── persona-analyzer/
│   │   └── SKILL.md
│   ├── persona-performance/
│   │   └── SKILL.md
│   ├── persona-qa/
│   │   └── SKILL.md
│   ├── persona-refactorer/
│   │   └── SKILL.md
│   ├── persona-devops/
│   │   └── SKILL.md
│   ├── persona-mentor/
│   │   └── SKILL.md
│   └── persona-scribe/
│       ├── SKILL.md
│       └── references/
│           └── language-support.md
│
├── hooks/                                   # 훅 시스템
│   └── hooks.json                           # 훅 라우팅 설정
│
├── scripts/                                 # 런타임 스크립트
│   ├── hooks/                               # 훅 핸들러
│   │   ├── session-start.js                 # 세션 시작 (환경 감지, 상태 복원)
│   │   ├── session-end.js                   # 세션 종료 (상태 저장)
│   │   ├── pre-write.js                     # Write/Edit 전 검증
│   │   ├── pre-bash.js                      # Bash 전 안전 검사
│   │   ├── post-edit-format.js              # Edit 후 포매팅
│   │   ├── post-edit-typecheck.js           # Edit 후 타입체크
│   │   ├── post-bash.js                     # Bash 후 분석
│   │   ├── pre-compact.js                   # 컴팩션 전 상태 저장
│   │   ├── user-prompt-handler.js           # 사용자 입력 의도 감지
│   │   ├── check-console-log.js             # console.log 감사
│   │   ├── subagent-handler.js              # 서브에이전트 시작/종료
│   │   ├── team-idle-handler.js             # 팀원 유휴 처리
│   │   └── evaluate-session.js              # 세션 학습 패턴 추출
│   │
│   ├── ci/                                  # CI/CD 검증
│   │   ├── validate-agents.js               # 에이전트 매니페스트 검증
│   │   ├── validate-commands.js             # 커맨드 형식 검증
│   │   ├── validate-skills.js               # 스킬 구조 검증
│   │   └── validate-hooks.js                # 훅 설정 검증
│   │
│   └── utils/                               # 공유 유틸리티
│       └── index.js                         # 공통 함수 (export)
│
├── lib/                                     # 코어 런타임 라이브러리
│   ├── core/
│   │   ├── index.js                         # 모듈 엔트리포인트
│   │   ├── platform.js                      # 플랫폼 감지 (CLAUDE_PLUGIN_ROOT 등)
│   │   ├── config.js                        # artibot.config.json 로더
│   │   ├── cache.js                         # TTL 기반 인메모리 캐시
│   │   ├── io.js                            # stdin/stdout 파싱 (훅 I/O)
│   │   ├── debug.js                         # 디버그 로깅
│   │   └── file.js                          # 파일 유틸리티
│   │
│   ├── intent/                              # 의도 감지 엔진
│   │   ├── index.js                         # 모듈 엔트리포인트
│   │   ├── language.js                      # 다국어 패턴 매칭
│   │   ├── trigger.js                       # 에이전트/스킬 트리거
│   │   └── ambiguity.js                     # 모호성 감지 + 질문 생성
│   │
│   └── context/                             # 컨텍스트 관리
│       ├── hierarchy.js                     # 4레벨 컨텍스트 (Plugin→User→Project→Session)
│       └── session.js                       # 세션 상태 관리
│
├── output-styles/                           # 출력 스타일
│   ├── artibot-default.md                   # 기본 스타일
│   ├── artibot-compressed.md                # 압축 모드 (--uc)
│   └── artibot-mentor.md                    # 교육/멘토 모드
│
├── templates/                               # 문서 템플릿
│   ├── agent-template.md                    # 에이전트 작성 템플릿
│   ├── skill-template.md                    # 스킬 작성 템플릿
│   └── command-template.md                  # 커맨드 작성 템플릿
│
├── .mcp.json                                # MCP 서버 설정
├── artibot.config.json                      # 플러그인 설정
├── package.json                             # Node.js 의존성 (런타임 라이브러리)
├── ARCHITECTURE.md                          # 아키텍처 문서 (이 파일 대체)
└── CHANGELOG.md                             # 변경 이력
```

### 3.2 단일 플러그인 결정 (기존 대비 변경)

**기존 설계**: 5개 멀티 플러그인 (core, personas, workflow, quality, mcp)
**최종 결정**: **단일 플러그인** (artibot)

**변경 근거**:

| 기준 | 멀티 플러그인 | 단일 플러그인 |
|------|-------------|-------------|
| 설치 경험 | 5개 개별 설치/업데이트 필요 | 1회 설치 |
| 에이전트 간 연동 | 플러그인 간 에이전트 참조 불가 | 모든 에이전트 즉시 참조 가능 |
| 팀 오케스트레이션 | orchestrator가 다른 플러그인의 에이전트 참조 불가 | 전체 에이전트 풀에서 자유롭게 Task 위임 |
| 스킬 자동 활성화 | 각 플러그인 독립적 | 전체 스킬 풀에서 최적 선택 |
| 토큰 효율 | 사용하지 않는 플러그인 미설치로 절약 | 스킬 지연 로딩으로 동일 효과 |
| 유지보수 | 5개 plugin.json 관리 | 1개 plugin.json |
| 버전 동기화 | 5개 버전 동기화 필요 | 단일 버전 |
| 레퍼런스 패턴 | ui-ux-pro-max(단일), bkit(단일) | **주류 패턴은 단일** |

**토큰 효율은 스킬 시스템으로 해결**: 플러그인을 쪼개지 않아도, Claude Code의 스킬 시스템이 필요한 스킬만 컨텍스트에 로드한다. 따라서 멀티 플러그인의 토큰 절약 이점은 실제로 미미하다.

### 3.3 Plugin Manifest (plugin.json)

```json
{
  "name": "artibot",
  "version": "1.0.0",
  "description": "SuperClaude 프레임워크 - 지능형 오케스트레이션, 전문가 에이전트 팀, 도메인 스킬 시스템",
  "author": {
    "name": "Artience"
  },
  "license": "MIT",
  "keywords": [
    "superclaude",
    "orchestration",
    "agent-teams",
    "personas",
    "workflow",
    "tdd",
    "code-review",
    "security"
  ],
  "agents": [
    "./agents/orchestrator.md",
    "./agents/architect.md",
    "./agents/frontend-developer.md",
    "./agents/backend-developer.md",
    "./agents/security-reviewer.md",
    "./agents/code-reviewer.md",
    "./agents/database-reviewer.md",
    "./agents/build-error-resolver.md",
    "./agents/e2e-runner.md",
    "./agents/tdd-guide.md",
    "./agents/planner.md",
    "./agents/refactor-cleaner.md",
    "./agents/doc-updater.md",
    "./agents/content-marketer.md",
    "./agents/devops-engineer.md",
    "./agents/llm-architect.md",
    "./agents/mcp-developer.md",
    "./agents/typescript-pro.md"
  ],
  "skills": ["./skills/", "./commands/"],
  "outputStyles": "./output-styles/"
}
```

**주의사항** (PLUGIN_SCHEMA_NOTES 준수):
- `agents`: 반드시 개별 파일 경로 배열
- `hooks` 필드: 선언 금지 (hooks/hooks.json 자동 로드)
- `version`: 필수
- 모든 필드: 배열 형태

### 3.4 설정 시스템 (artibot.config.json)

```json
{
  "$schema": "./artibot.config.schema.json",
  "version": "1.0.0",

  "agents": {
    "taskBased": {
      "code review": "code-reviewer",
      "security review": "security-reviewer",
      "architecture": "architect",
      "frontend": "frontend-developer",
      "backend": "backend-developer",
      "database": "database-reviewer",
      "build error": "build-error-resolver",
      "e2e test": "e2e-runner",
      "tdd": "tdd-guide",
      "plan": "planner",
      "refactor": "refactor-cleaner",
      "documentation": "doc-updater",
      "content": "content-marketer",
      "devops": "devops-engineer",
      "llm": "llm-architect",
      "mcp": "mcp-developer",
      "typescript": "typescript-pro",
      "team": "orchestrator"
    }
  },

  "team": {
    "enabled": true,
    "maxTeammates": 5,
    "ctoAgent": "orchestrator",
    "orchestrationPatterns": {
      "plan": "leader",
      "design": "council",
      "do": "swarm",
      "check": "council",
      "act": "leader"
    }
  },

  "automation": {
    "intentDetection": true,
    "ambiguityThreshold": 50,
    "supportedLanguages": ["en", "ko", "ja"]
  },

  "context": {
    "importCacheTTL": 30000,
    "hierarchyCacheTTL": 5000
  },

  "output": {
    "maxContextLength": 500,
    "format": "default"
  },

  "permissions": {
    "Write": "allow",
    "Edit": "allow",
    "Read": "allow",
    "Bash": "allow",
    "Bash(rm -rf*)": "deny",
    "Bash(git push --force*)": "deny",
    "Bash(git reset --hard*)": "ask"
  }
}
```

### 3.5 훅 시스템 (hooks/hooks.json)

```json
{
  "$schema": "https://json.schemastore.org/claude-code-hooks.json",
  "description": "Artibot v1.0.0 - Claude Code Plugin Hooks",
  "hooks": {
    "SessionStart": [
      {
        "once": true,
        "hooks": [{
          "type": "command",
          "command": "node ${CLAUDE_PLUGIN_ROOT}/scripts/hooks/session-start.js",
          "timeout": 5000
        }]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [{
          "type": "command",
          "command": "node ${CLAUDE_PLUGIN_ROOT}/scripts/hooks/pre-write.js",
          "timeout": 5000
        }]
      },
      {
        "matcher": "Bash",
        "hooks": [{
          "type": "command",
          "command": "node ${CLAUDE_PLUGIN_ROOT}/scripts/hooks/pre-bash.js",
          "timeout": 5000
        }]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Edit",
        "hooks": [{
          "type": "command",
          "command": "node ${CLAUDE_PLUGIN_ROOT}/scripts/hooks/post-edit-format.js",
          "timeout": 10000
        }]
      },
      {
        "matcher": "Bash",
        "hooks": [{
          "type": "command",
          "command": "node ${CLAUDE_PLUGIN_ROOT}/scripts/hooks/post-bash.js",
          "timeout": 5000
        }]
      }
    ],
    "PreCompact": [
      {
        "matcher": "auto|manual",
        "hooks": [{
          "type": "command",
          "command": "node ${CLAUDE_PLUGIN_ROOT}/scripts/hooks/pre-compact.js",
          "timeout": 5000
        }]
      }
    ],
    "Stop": [
      {
        "hooks": [{
          "type": "command",
          "command": "node ${CLAUDE_PLUGIN_ROOT}/scripts/hooks/check-console-log.js",
          "timeout": 10000
        }]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [{
          "type": "command",
          "command": "node ${CLAUDE_PLUGIN_ROOT}/scripts/hooks/user-prompt-handler.js",
          "timeout": 3000
        }]
      }
    ],
    "SubagentStart": [
      {
        "hooks": [{
          "type": "command",
          "command": "node ${CLAUDE_PLUGIN_ROOT}/scripts/hooks/subagent-handler.js",
          "timeout": 5000
        }]
      }
    ],
    "SubagentStop": [
      {
        "hooks": [{
          "type": "command",
          "command": "node ${CLAUDE_PLUGIN_ROOT}/scripts/hooks/subagent-handler.js",
          "timeout": 5000
        }]
      }
    ],
    "TeammateIdle": [
      {
        "hooks": [{
          "type": "command",
          "command": "node ${CLAUDE_PLUGIN_ROOT}/scripts/hooks/team-idle-handler.js",
          "timeout": 5000
        }]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [{
          "type": "command",
          "command": "node ${CLAUDE_PLUGIN_ROOT}/scripts/hooks/session-end.js",
          "timeout": 10000
        }]
      },
      {
        "hooks": [{
          "type": "command",
          "command": "node ${CLAUDE_PLUGIN_ROOT}/scripts/hooks/evaluate-session.js",
          "timeout": 10000
        }]
      }
    ]
  }
}
```

---

## 4. 핵심 모듈 인터페이스

### 4.1 에이전트 템플릿 표준

```markdown
---
name: agent-name
description: |
  역할 한 줄 설명.
  전문 영역과 핵심 역량 서술.

  Use proactively when (자동 호출 조건).

  Triggers: keyword1, keyword2, keyword3,
  키워드1, 키워드2 (다국어 트리거)

  Do NOT use for: (사용하지 말아야 할 상황)
model: opus|sonnet|haiku
tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
  - Task(sub-agent-name)
  - TodoWrite
skills:
  - related-skill-name
---

## Core Responsibilities

1. **주요 책임 1**: 구체적 행동 서술
2. **주요 책임 2**: 구체적 행동 서술

## Process

| 단계 | 행동 | 출력 |
|------|------|------|
| 1. 분석 | 입력 분석 및 범위 결정 | 분석 결과 |
| 2. 실행 | 핵심 작업 수행 | 산출물 |
| 3. 검증 | 결과 검증 | 검증 리포트 |

## Output Format

(구체적 출력 형식)

## Anti-Patterns

- (하지 말아야 할 것)
```

**표준화 원칙** (PROMPT-ANALYSIS.md 발견사항 반영):
- Communication Protocol 섹션 **제거** (비기능적)
- Integration with other agents 섹션 **제거** (비기능적)
- Progress tracking JSON **제거** (비기능적)
- `tools`, `skills` 필드로 연동 관계 **선언적으로** 표현
- description에 다국어 트리거 포함 (bkit 패턴)

### 4.2 스킬 템플릿 표준

```markdown
---
name: skill-name
description: |
  스킬 목적 한 줄 설명.
  자동 활성화 조건: (Claude가 이 스킬을 선택하는 기준)

  Triggers: keyword1, keyword2, pattern1
---

# Skill Title

## When This Skill Applies

- 조건 1: (구체적 활성화 시나리오)
- 조건 2: (구체적 활성화 시나리오)

## Core Guidance

### 핵심 지침 1

(구체적 가이드라인과 예시)

### 핵심 지침 2

(구체적 가이드라인과 예시)

## Quick Reference

(핵심 정보 테이블 또는 체크리스트)
```

### 4.3 커맨드 템플릿 표준

```markdown
---
description: 커맨드 목적 설명 (help에 표시)
argument-hint: [target] [--flags]
allowed-tools: [Read, Write, Edit, Bash, Glob, Grep, Task]
---

# /command-name

## Arguments
$ARGUMENTS 파싱 규칙

## Execution Flow

1. **입력 분석**: $ARGUMENTS 해석
2. **컨텍스트 수집**: 필요한 정보 수집
3. **실행**: 핵심 작업 수행
4. **검증**: 결과 검증
5. **출력**: 결과 리포트
```

### 4.4 Orchestrator 에이전트 (핵심 설계)

bkit의 cto-lead 패턴을 Artibot에 맞게 적용:

```markdown
---
name: orchestrator
description: |
  Artibot 팀 오케스트레이터. 복잡한 다단계 작업의 팀 구성,
  태스크 분배, 품질 게이트 관리.

  Use proactively when multi-step project coordination,
  team composition, or architectural decisions are needed.

  Triggers: team, orchestrate, coordinate, project lead,
  팀, 오케스트레이션, 조율, 프로젝트 리드
model: opus
tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
  - Task(architect)
  - Task(frontend-developer)
  - Task(backend-developer)
  - Task(security-reviewer)
  - Task(code-reviewer)
  - Task(database-reviewer)
  - Task(tdd-guide)
  - Task(planner)
  - Task(e2e-runner)
  - Task(refactor-cleaner)
  - Task(doc-updater)
  - Task(Explore)
  - TodoWrite
  - WebSearch
skills:
  - orchestration
  - delegation
  - principles
---

## Core Responsibilities

1. **팀 구성**: 작업 복잡도에 따라 적절한 팀원 에이전트 선택
2. **태스크 분배**: Leader/Council/Swarm 패턴으로 작업 분배
3. **품질 게이트**: 각 단계 완료 시 검증 기준 적용
4. **위험 관리**: 블로커 식별, 충돌 해소, 납기 보장

## Orchestration Patterns

| 패턴 | 시기 | 설명 |
|------|------|------|
| Leader | 계획, 의사결정 | 오케스트레이터가 분배, 팀원 실행 |
| Council | 설계, 검증 | 다중 관점 수집 후 합의 |
| Swarm | 대규모 구현 | 병렬 분산 실행 |
| Pipeline | 순차 의존성 | A → B → C 체인 실행 |

## Team Composition Rules

- 단순 작업: 팀 없이 직접 처리
- 중간 복잡도: 최대 3 팀원
- 높은 복잡도: 최대 5 팀원

## Quality Gates

- 분석 완료 후 계획 수립 전: 범위 확정
- 구현 완료 후 리뷰 전: 빌드 성공 확인
- 리뷰 완료 후 최종 산출: 모든 Critical 이슈 해소
```

---

## 5. 컨텍스트 계층 구조

bkit의 4-레벨 컨텍스트 계층을 채택:

```
레벨 1: Plugin (lib/ 내장)
  └── 기본 설정, 에이전트/스킬 카탈로그, 기본 규칙

레벨 2: User (~/.claude/artibot/)
  └── 사용자 선호 설정, 커스텀 규칙, 학습된 패턴

레벨 3: Project (.claude/ 또는 프로젝트 루트)
  └── 프로젝트별 CLAUDE.md, 프레임워크 설정, 규칙 오버라이드

레벨 4: Session (인메모리)
  └── 현재 세션 상태, 활성 에이전트, 진행 중인 태스크
```

**우선순위**: Session > Project > User > Plugin (더 구체적일수록 우선)

---

## 6. 토큰 효율 분석

### 6.1 현재 vs 마이그레이션 후

| 항목 | 현재 (SuperClaude) | Artibot 플러그인 |
|------|-------------------|-----------------|
| 세션 초기 로드 | ~15K+ 토큰 (9개 전체 파일) | ~1K 토큰 (plugin.json만) |
| 에이전트 호출 | 이미 로드됨 | 필요한 에이전트만 ~1-2K |
| 스킬 활성화 | 없음 (전부 로드) | 필요한 스킬만 ~300-500/개 |
| 페르소나 활성화 | ~4K (전체 PERSONAS.md) | ~400/개 (개별 스킬) |
| **평균 세션 비용** | **~15-20K 토큰** | **~2-4K 토큰** |
| **절감률** | - | **75-87%** |

### 6.2 PROMPT-ANALYSIS.md 반영

- 비기능적 패턴 ~36K 토큰 완전 제거
- 33개 에이전트 → 18개로 통합 (중복 제거)
- A등급 에이전트 패턴을 표준 템플릿으로 확산
- D등급 에이전트 4개 제거 (autonomous-developer, product-manager, project-manager, scrum-master)

---

## 7. SuperClaude → Artibot 마이그레이션 매핑

| SuperClaude 원본 | Artibot 대상 | 모듈 유형 |
|------------------|-------------|-----------|
| COMMANDS.md | commands/ (개별 .md) | 커맨드 |
| FLAGS.md | skills/orchestration/references/flag-system.md | 스킬 참조자료 |
| PRINCIPLES.md | skills/principles/ | 스킬 |
| RULES.md (코딩규칙) | skills/coding-standards/ | 스킬 |
| RULES.md (보안규칙) | skills/security-standards/ | 스킬 |
| MCP.md | skills/mcp-coordination/ | 스킬 |
| PERSONAS.md | skills/persona-*/ (11개) | 페르소나 스킬 |
| ORCHESTRATOR.md | skills/orchestration/ + lib/intent/ | 스킬 + 런타임 |
| MODES.md (태스크) | commands/ + agents/orchestrator.md | 커맨드 + 에이전트 |
| MODES.md (토큰) | skills/token-efficiency/ + output-styles/ | 스킬 + Output Style |
| MODES.md (인트로스펙션) | 제거 (과도한 메타분석) | - |
| rules/*.md | skills/*/references/ | 스킬 참조자료 |
| agents/*.md (A/B등급) | agents/ (표준화) | 에이전트 |
| agents/*.md (C등급) | agents/ (템플릿 적용 후 재작성) | 에이전트 |
| agents/*.md (D등급) | 제거 | - |
| .mcp.json | .mcp.json (유지) | MCP 설정 |
| settings.json 훅 | hooks/hooks.json + scripts/hooks/ | 훅 |

---

## 8. 구현 로드맵

### Phase 1: 인프라 (1주차)

1. 플러그인 기본 구조 생성 (디렉토리, plugin.json, marketplace.json)
2. lib/core/ 런타임 구현 (platform, config, cache, io, debug, file)
3. hooks/hooks.json + scripts/hooks/ 기본 훅 구현
4. artibot.config.json 설정 시스템 구현
5. CI/CD 검증 스크립트 (scripts/ci/)

### Phase 2: 에이전트 (2주차)

1. 18개 에이전트 표준 템플릿 적용 및 재작성
2. orchestrator.md 에이전트 설계 (팀 시스템 핵심)
3. A등급 에이전트 (build-error-resolver, database-reviewer, e2e-runner, security-reviewer, tdd-guide) 우선 마이그레이션
4. 나머지 에이전트 통합 및 재작성

### Phase 3: 스킬 (3주차)

1. 핵심 스킬: orchestration, token-efficiency, principles
2. 표준 스킬: coding-standards, security-standards, testing-standards, git-workflow
3. 페르소나 스킬: 11개 persona-* 스킬
4. MCP 스킬: mcp-context7, mcp-playwright, mcp-coordination
5. 기타 스킬: delegation, tdd-workflow, continuous-learning, strategic-compact

### Phase 4: 커맨드 (4주차)

1. 핵심 커맨드: sc, analyze, build, implement, improve
2. 워크플로우 커맨드: plan, design, task, git, test, tdd
3. 품질 커맨드: code-review, refactor-clean, verify, checkpoint
4. 기타 커맨드: troubleshoot, document, content, orchestrate, learn

### Phase 5: 런타임 (5주차)

1. lib/intent/ 의도 감지 엔진 구현
2. lib/context/ 컨텍스트 계층 구현
3. output-styles/ 출력 스타일 구현
4. user-prompt-handler.js 지능형 라우팅 구현

### Phase 6: 통합 및 검증 (6주차)

1. 전체 커맨드 동작 검증
2. 에이전트 팀 오케스트레이션 테스트
3. 토큰 사용량 측정
4. CLAUDE.md 최소화 확인
5. 마켓플레이스 배포 준비

---

## 9. 설계 검증 기준

| 검증 항목 | 기준 | 측정 방법 |
|-----------|------|-----------|
| 세션 초기 토큰 | <2K 토큰 | plugin.json + 자동 로드 측정 |
| 평균 세션 토큰 | <5K 토큰 | 10개 시나리오 평균 |
| 에이전트 품질 | 전체 B등급 이상 | 템플릿 준수 + 실행 테스트 |
| 스킬 활성화 정확도 | >85% | 20개 시나리오 테스트 |
| 팀 오케스트레이션 | 정상 동작 | 5개 복합 시나리오 |
| 훅 안정성 | 0 실패 | 전체 훅 이벤트 테스트 |
| plugin.json 검증 | 통과 | `claude plugin validate` |
| CI/CD 검증 | 전체 통과 | scripts/ci/ 실행 |

---

## 부록 A: 레퍼런스 레포 채택 결정 요약

| 패턴 | 출처 | 채택 여부 | 근거 |
|------|------|----------|------|
| 단일 플러그인 구조 | bkit, ui-ux-pro-max | **채택** | 팀 시스템 연동, 설치 간편성 |
| Agent Teams (CTO-led) | bkit | **채택** | 복잡 작업 오케스트레이션 핵심 |
| 런타임 lib/ 구조 | bkit | **채택** | 지능형 라우팅 필수 |
| hooks/hooks.json 자동 로드 | bkit, everything-claude-code | **채택** | 공식 규약 |
| plugin.json agents 배열 | everything-claude-code | **채택** | 검증된 패턴 |
| PLUGIN_SCHEMA_NOTES | everything-claude-code | **채택** | 필수 문서 |
| Output Styles | bkit | **채택** | 출력 커스터마이징 |
| artibot.config.json | bkit (bkit.config.json) | **채택** | 프로젝트별 설정 |
| 4-레벨 컨텍스트 | bkit (context-hierarchy) | **채택** | 컨텍스트 관리 핵심 |
| 의도 감지 엔진 | bkit (lib/intent/) | **채택** | 지능형 라우팅 |
| CI/CD 검증 | everything-claude-code | **채택** | 품질 보증 |
| speckit 커맨드 시스템 | cc-wf-studio | **참조** | 커맨드 설계 패턴 참고 |
| CLI 설치 시스템 | ui-ux-pro-max | **미채택** | 마켓플레이스 설치로 충분 |
| PDCA 라이프사이클 | bkit | **선택적** | 필요 시 skill로 추가 |
| 다국어 트리거 | bkit | **채택** (en, ko, ja) | 사용자 접근성 |
| 세션 관리 | everything-claude-code | **채택** | 세션 상태 유지 |

## 부록 B: 역할 분리 원칙 (최종)

```
Skills  = Knowledge (지식)  → 자동 활성화, 가이드라인 제공
Agents  = Behavior (행동)   → 독립 실행, 도구 사용, 산출물 생성
Personas = Perspective (관점) → 스킬로 구현, 의사결정 프레임워크
Commands = Interface (인터페이스) → 사용자 진입점, 실행 흐름 정의
Hooks   = Automation (자동화)  → 이벤트 기반, 런타임 스크립트
Config  = Configuration (설정) → 프로젝트별 커스터마이징
```
