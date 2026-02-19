# Artibot Plugin Architecture

> SuperClaude 프레임워크를 Claude Code 공식 플러그인 시스템으로 마이그레이션하는 아키텍처 설계 문서

---

## 1. 현행 시스템 분석

### 1.1 SuperClaude 프레임워크 구조 (현재)

```
~/.claude/
├── CLAUDE.md                  # 진입점 (@ 참조로 모든 코어 파일 로드)
├── COMMANDS.md                # 커맨드 실행 프레임워크 정의
├── FLAGS.md                   # 플래그 시스템 정의
├── PRINCIPLES.md              # 개발 원칙
├── RULES.md                   # 실행 규칙
├── MCP.md                     # MCP 서버 통합 가이드
├── PERSONAS.md                # 11개 페르소나 시스템
├── ORCHESTRATOR.md            # 라우팅/오케스트레이션 엔진
├── MODES.md                   # 운영 모드 (Task/Introspection/Token)
├── commands/                  # 슬래시 커맨드 (sc, analyze, build 등 24+개)
├── agents/                    # 에이전트 정의 (30+개, 혼재 상태)
├── rules/                     # 코딩 규칙 파일 (8개)
└── .mcp.json                  # MCP 서버 설정
```

### 1.2 핵심 문제점

| 구분 | 문제 | 영향 |
|------|------|------|
| **컨텍스트 오버헤드** | CLAUDE.md가 9개 대형 파일을 @ 참조로 모두 로드 | 매 세션마다 ~15K+ 토큰 소비 |
| **모듈 경계 부재** | 코어 파일(COMMANDS/FLAGS/PERSONAS 등)이 모두 글로벌 스코프 | 특정 도메인 작업에 불필요한 정보까지 로드 |
| **에이전트 혼재** | everything-claude-code 플러그인 에이전트 + 커스텀 에이전트가 같은 디렉토리에 중복 | 이름 충돌, 역할 불명확 |
| **스킬 부재** | 현재 스킬 시스템 미사용 | 모델 자율 호출 패턴 활용 불가 |
| **확장성 한계** | 단일 글로벌 설정으로 프로젝트별 커스터마이징 불가 | 프로젝트마다 다른 규칙 적용 어려움 |
| **플러그인 비호환** | 공식 플러그인 시스템(.claude-plugin/) 구조 미준수 | 마켓플레이스 배포, 버전 관리 불가 |

### 1.3 공식 Claude Code 플러그인 시스템 구조

```
plugin-name/
├── .claude-plugin/
│   └── plugin.json            # 매니페스트 (필수)
├── commands/                  # 슬래시 커맨드 (.md)
├── agents/                    # 에이전트 정의 (.md)
├── skills/                    # 모델 자율 호출 스킬
│   └── skill-name/
│       ├── SKILL.md           # 스킬 정의 (필수)
│       ├── references/        # 참조 자료
│       └── examples/          # 예제
├── hooks/
│   ├── hooks.json             # 훅 설정
│   └── scripts/               # 훅 스크립트
├── .mcp.json                  # MCP 서버 설정 (선택)
└── scripts/                   # 유틸리티 스크립트
```

---

## 2. 설계 원칙

### 2.1 아키텍처 원칙

1. **Layered Plugin Architecture**: 코어 / 도메인 / 프로젝트 3계층 분리
2. **Lean Context Loading**: 필요한 것만 로드 (스킬 기반 지연 활성화)
3. **Official Plugin Compliance**: .claude-plugin/ 표준 구조 완전 준수
4. **Composition over Monolith**: 대형 단일 파일 대신 작은 모듈 조합
5. **Progressive Enhancement**: 기본 기능은 가볍게, 고급 기능은 필요시 활성화

### 2.2 핵심 설계 결정

| 결정 | 선택 | 근거 |
|------|------|------|
| 플러그인 단위 | 멀티 플러그인 (코어 + 도메인별) | 토큰 효율, 선택적 설치 |
| 페르소나 구현 | 스킬 → 에이전트 2계층 | 간단한 가이드는 스킬, 독립 실행은 에이전트 |
| 오케스트레이션 | 커맨드 + 스킬 협력 | 사용자 호출(커맨드) + 자동 활성화(스킬) 분리 |
| 규칙 배포 | 프로젝트 CLAUDE.md 최소화 + 플러그인 스킬 | 글로벌 규칙은 스킬, 프로젝트 규칙은 로컬 |
| 메모리 | 프로젝트별 memory/ 디렉토리 | Claude Code 내장 auto memory 활용 |

---

## 3. 플러그인 아키텍처

### 3.1 플러그인 구성 (멀티 플러그인 전략)

```
artibot/                                    # 모노레포 루트
├── plugins/
│   ├── artibot-core/                       # [필수] 코어 플러그인
│   │   ├── .claude-plugin/
│   │   │   └── plugin.json
│   │   ├── commands/
│   │   │   ├── sc.md                       # SuperClaude 라우터 (기존 유지)
│   │   │   ├── analyze.md                  # 분석 커맨드
│   │   │   ├── build.md                    # 빌드 커맨드
│   │   │   ├── implement.md                # 구현 커맨드
│   │   │   ├── improve.md                  # 개선 커맨드
│   │   │   └── troubleshoot.md             # 트러블슈팅 커맨드
│   │   ├── skills/
│   │   │   ├── orchestration/              # 오케스트레이션 스킬
│   │   │   │   ├── SKILL.md                # 라우팅 인텔리전스
│   │   │   │   └── references/
│   │   │   │       ├── routing-table.md    # 라우팅 테이블
│   │   │   │       └── flag-system.md      # 플래그 레퍼런스
│   │   │   ├── token-efficiency/           # 토큰 효율 스킬
│   │   │   │   ├── SKILL.md
│   │   │   │   └── references/
│   │   │   │       └── symbol-system.md    # 기호 시스템 레퍼런스
│   │   │   └── principles/                 # 개발 원칙 스킬
│   │   │       ├── SKILL.md
│   │   │       └── references/
│   │   │           ├── solid.md
│   │   │           └── quality-gates.md
│   │   ├── agents/
│   │   │   └── orchestrator.md             # 오케스트레이터 에이전트
│   │   └── hooks/
│   │       └── hooks.json                  # 기본 훅 (안전 검사 등)
│   │
│   ├── artibot-personas/                   # [선택] 페르소나 플러그인
│   │   ├── .claude-plugin/
│   │   │   └── plugin.json
│   │   ├── skills/
│   │   │   ├── persona-architect/          # 아키텍트 페르소나
│   │   │   │   ├── SKILL.md
│   │   │   │   └── references/
│   │   │   │       └── decision-framework.md
│   │   │   ├── persona-frontend/           # 프론트엔드 페르소나
│   │   │   │   ├── SKILL.md
│   │   │   │   └── references/
│   │   │   │       └── performance-budgets.md
│   │   │   ├── persona-backend/            # 백엔드 페르소나
│   │   │   │   └── SKILL.md
│   │   │   ├── persona-security/           # 보안 페르소나
│   │   │   │   └── SKILL.md
│   │   │   ├── persona-analyzer/           # 분석가 페르소나
│   │   │   │   └── SKILL.md
│   │   │   ├── persona-performance/        # 성능 페르소나
│   │   │   │   └── SKILL.md
│   │   │   ├── persona-qa/                 # QA 페르소나
│   │   │   │   └── SKILL.md
│   │   │   ├── persona-refactorer/         # 리팩토러 페르소나
│   │   │   │   └── SKILL.md
│   │   │   ├── persona-devops/             # DevOps 페르소나
│   │   │   │   └── SKILL.md
│   │   │   ├── persona-mentor/             # 멘토 페르소나
│   │   │   │   └── SKILL.md
│   │   │   └── persona-scribe/             # 스크라이브 페르소나
│   │   │       ├── SKILL.md
│   │   │       └── references/
│   │   │           └── language-support.md
│   │   └── agents/
│   │       ├── architect.md                # 아키텍트 독립 에이전트
│   │       ├── security-reviewer.md        # 보안 리뷰어 에이전트
│   │       └── code-reviewer.md            # 코드 리뷰어 에이전트
│   │
│   ├── artibot-workflow/                   # [선택] 워크플로우 플러그인
│   │   ├── .claude-plugin/
│   │   │   └── plugin.json
│   │   ├── commands/
│   │   │   ├── task.md                     # 태스크 관리
│   │   │   ├── design.md                   # 설계 워크플로우
│   │   │   ├── git.md                      # Git 워크플로우
│   │   │   └── content.md                  # 콘텐츠 워크플로우
│   │   ├── skills/
│   │   │   ├── git-workflow/               # Git 워크플로우 스킬
│   │   │   │   ├── SKILL.md
│   │   │   │   └── references/
│   │   │   │       └── commit-conventions.md
│   │   │   ├── tdd-workflow/               # TDD 워크플로우 스킬
│   │   │   │   └── SKILL.md
│   │   │   └── delegation/                 # 위임/병렬 실행 스킬
│   │   │       ├── SKILL.md
│   │   │       └── references/
│   │   │           └── delegation-matrix.md
│   │   └── agents/
│   │       ├── planner.md                  # 플래너 에이전트
│   │       ├── tdd-guide.md                # TDD 가이드 에이전트
│   │       └── content-marketer.md         # 콘텐츠 마케터 에이전트
│   │
│   ├── artibot-quality/                    # [선택] 품질 관리 플러그인
│   │   ├── .claude-plugin/
│   │   │   └── plugin.json
│   │   ├── commands/
│   │   │   ├── test.md                     # 테스트 커맨드
│   │   │   ├── cleanup.md                  # 클린업 커맨드
│   │   │   └── document.md                 # 문서화 커맨드
│   │   ├── skills/
│   │   │   ├── coding-standards/           # 코딩 표준 스킬
│   │   │   │   ├── SKILL.md
│   │   │   │   └── references/
│   │   │   │       ├── immutability.md
│   │   │   │       ├── error-handling.md
│   │   │   │       └── file-organization.md
│   │   │   ├── security-standards/         # 보안 표준 스킬
│   │   │   │   ├── SKILL.md
│   │   │   │   └── references/
│   │   │   │       └── owasp-checklist.md
│   │   │   └── testing-standards/          # 테스팅 표준 스킬
│   │   │       ├── SKILL.md
│   │   │       └── references/
│   │   │           └── coverage-requirements.md
│   │   ├── agents/
│   │   │   ├── build-error-resolver.md
│   │   │   ├── e2e-runner.md
│   │   │   └── refactor-cleaner.md
│   │   └── hooks/
│   │       ├── hooks.json                  # 품질 관련 훅
│   │       └── scripts/
│   │           ├── prettier-check.sh
│   │           ├── typescript-check.sh
│   │           └── console-log-audit.sh
│   │
│   └── artibot-mcp/                        # [선택] MCP 통합 플러그인
│       ├── .claude-plugin/
│       │   └── plugin.json
│       ├── .mcp.json                       # MCP 서버 설정
│       └── skills/
│           ├── mcp-context7/               # Context7 활용 스킬
│           │   ├── SKILL.md
│           │   └── references/
│           │       └── workflow.md
│           ├── mcp-playwright/             # Playwright 활용 스킬
│           │   └── SKILL.md
│           └── mcp-coordination/           # MCP 서버 조율 스킬
│               ├── SKILL.md
│               └── references/
│                   ├── server-selection.md
│                   └── fallback-strategies.md
│
├── ARCHITECTURE.md                         # 이 문서
├── README.md                               # 프로젝트 개요 (필요시)
└── .gitignore
```

### 3.2 플러그인 매니페스트 설계

#### artibot-core/plugin.json
```json
{
  "name": "artibot-core",
  "version": "1.0.0",
  "description": "SuperClaude 프레임워크 코어 - 오케스트레이션, 커맨드 라우팅, 토큰 효율 엔진",
  "author": {
    "name": "Artience"
  },
  "license": "MIT",
  "keywords": ["superclaude", "orchestration", "framework", "core"]
}
```

#### artibot-personas/plugin.json
```json
{
  "name": "artibot-personas",
  "version": "1.0.0",
  "description": "11개 도메인 전문가 페르소나 - 아키텍트, 프론트엔드, 백엔드, 보안 등",
  "author": {
    "name": "Artience"
  },
  "license": "MIT",
  "keywords": ["persona", "specialist", "domain-expert"]
}
```

#### artibot-workflow/plugin.json
```json
{
  "name": "artibot-workflow",
  "version": "1.0.0",
  "description": "워크플로우 자동화 - 태스크 관리, Git 워크플로우, TDD, 콘텐츠 생성",
  "author": {
    "name": "Artience"
  },
  "license": "MIT",
  "keywords": ["workflow", "task", "git", "tdd", "automation"]
}
```

#### artibot-quality/plugin.json
```json
{
  "name": "artibot-quality",
  "version": "1.0.0",
  "description": "품질 관리 도구 - 코딩 표준, 보안 검사, 테스팅, 자동 훅",
  "author": {
    "name": "Artience"
  },
  "license": "MIT",
  "keywords": ["quality", "testing", "security", "standards", "hooks"]
}
```

#### artibot-mcp/plugin.json
```json
{
  "name": "artibot-mcp",
  "version": "1.0.0",
  "description": "MCP 서버 통합 - Context7, Playwright, 서버 조율 전략",
  "author": {
    "name": "Artience"
  },
  "license": "MIT",
  "keywords": ["mcp", "context7", "playwright", "integration"]
}
```

---

## 4. 모듈 인터페이스 설계

### 4.1 계층 간 인터페이스

```
┌─────────────────────────────────────────────────────────┐
│                    사용자 인터페이스                       │
│              /sc, /analyze, /build, /test ...            │
└─────────────────────┬───────────────────────────────────┘
                      │ 커맨드 호출
┌─────────────────────▼───────────────────────────────────┐
│              artibot-core (오케스트레이션)                 │
│                                                          │
│  commands/ ──→ 사용자 슬래시 커맨드 진입점                 │
│  skills/orchestration ──→ 라우팅 인텔리전스 (자동 활성화)  │
│  skills/token-efficiency ──→ 토큰 최적화 (자동 활성화)    │
│  skills/principles ──→ 개발 원칙 (자동 활성화)            │
│  agents/orchestrator ──→ 복잡한 멀티스텝 조율             │
└────┬──────────┬──────────┬──────────┬───────────────────┘
     │          │          │          │
     ▼          ▼          ▼          ▼
┌─────────┐ ┌────────┐ ┌────────┐ ┌────────┐
│personas │ │workflow│ │quality │ │  mcp   │
│         │ │        │ │        │ │        │
│ skills/ │ │commands│ │commands│ │ .mcp.  │
│ (11개   │ │skills/ │ │skills/ │ │  json  │
│ 페르소나)│ │agents/ │ │agents/ │ │skills/ │
│ agents/ │ │        │ │hooks/  │ │        │
└─────────┘ └────────┘ └────────┘ └────────┘
```

### 4.2 스킬 인터페이스 규약

모든 스킬은 다음 구조를 따른다:

```markdown
---
name: skill-name
description: 트리거 조건을 명확히 서술 (Claude가 자동 활성화할 기준)
version: 1.0.0
---

# 스킬 제목

## When This Skill Applies
- 활성화 조건 목록

## Core Guidance
- 핵심 지침

## References
- references/ 디렉토리의 상세 자료 참조
```

### 4.3 에이전트 인터페이스 규약

```markdown
---
name: agent-name
description: 에이전트 목적과 전문 영역
tools: [허용 도구 목록]
model: sonnet|opus|haiku
---

# 에이전트 역할 정의

## Core Process
1. 단계별 실행 프로세스

## Output Guidance
- 출력 형식 및 기준
```

### 4.4 커맨드 인터페이스 규약

```markdown
---
description: 커맨드 설명 (help에 표시)
argument-hint: [필수인자] [선택인자]
allowed-tools: [사전 승인 도구]
---

# 커맨드 이름

## Arguments
$ARGUMENTS 파싱

## Execution Flow
1. 단계별 실행 흐름
```

### 4.5 플러그인 간 의존성

```
artibot-core (독립)
  ↑
artibot-personas (코어 권장)
artibot-workflow (코어 권장)
artibot-quality (독립)
artibot-mcp (독립)
```

- `artibot-core`는 독립 실행 가능 (필수 플러그인)
- `artibot-personas`와 `artibot-workflow`는 코어의 오케스트레이션 스킬과 연동 시 최적
- `artibot-quality`와 `artibot-mcp`는 완전 독립 실행 가능

---

## 5. 핵심 마이그레이션 전략

### 5.1 SuperClaude 파일 -> 플러그인 매핑

| SuperClaude 원본 | 대상 플러그인 | 대상 모듈 유형 | 비고 |
|------------------|---------------|----------------|------|
| COMMANDS.md | artibot-core | commands/ | 각 커맨드를 개별 .md 파일로 분리 |
| FLAGS.md | artibot-core | skills/orchestration/references/ | 플래그 레퍼런스로 변환 |
| PRINCIPLES.md | artibot-core | skills/principles/ | 스킬로 변환 (자동 활성화) |
| RULES.md | artibot-quality | skills/coding-standards/ | 코딩 규칙 스킬로 변환 |
| MCP.md | artibot-mcp | skills/mcp-coordination/ | MCP 활용 스킬로 변환 |
| PERSONAS.md | artibot-personas | skills/persona-*/ | 11개 개별 스킬로 분리 |
| ORCHESTRATOR.md | artibot-core | skills/orchestration/ | 라우팅 인텔리전스 스킬 |
| MODES.md | artibot-core | skills/ (분산) | 각 모드를 관련 스킬에 통합 |
| rules/*.md | artibot-quality | skills/*/references/ | 규칙별 레퍼런스로 변환 |
| agents/*.md | 해당 플러그인 | agents/ | 역할별 플러그인으로 재배치 |
| commands/*.md | 해당 플러그인 | commands/ | 도메인별 플러그인으로 재배치 |

### 5.2 CLAUDE.md 최소화

현재 CLAUDE.md는 9개 대형 파일을 모두 로드한다. 마이그레이션 후:

```markdown
# CLAUDE.md (마이그레이션 후)

## Artibot Framework
이 프로젝트는 Artibot 플러그인 시스템을 사용합니다.
설치된 플러그인이 자동으로 커맨드, 에이전트, 스킬을 제공합니다.

## 프로젝트별 규칙
- (프로젝트에 특화된 규칙만 최소한으로 기술)
```

**효과**: ~15K+ 토큰 -> ~200 토큰 (99% 감소). 나머지는 스킬의 지연 로딩으로 필요 시에만 활성화.

### 5.3 토큰 효율 비교

| 항목 | 현재 (SuperClaude) | 마이그레이션 후 (Artibot) |
|------|-------------------|--------------------------|
| 세션 초기 로드 | ~15K 토큰 (9개 전체 파일) | ~2K 토큰 (plugin.json + CLAUDE.md) |
| 페르소나 활성화 | 항상 전체 로드 (~4K) | 필요한 스킬만 (~400/개) |
| 규칙 참조 | 항상 전체 로드 (~3K) | 필요한 스킬만 (~300/개) |
| MCP 가이드 | 항상 전체 로드 (~2K) | 필요한 스킬만 (~300/개) |
| 오케스트레이션 | 항상 전체 로드 (~3K) | 라우팅 스킬 (~500) |
| **총 평균 세션** | **~15-20K 토큰** | **~3-5K 토큰** |

---

## 6. 확장 포인트

### 6.1 새 페르소나 추가

```
artibot-personas/skills/persona-{name}/
├── SKILL.md              # 페르소나 정의 (트리거 조건 + 핵심 지침)
└── references/            # 상세 레퍼런스 (선택)
```

SKILL.md의 `description` 필드에 트리거 키워드를 포함하면 Claude가 자동 활성화.

### 6.2 새 커맨드 추가

해당 도메인 플러그인의 `commands/` 디렉토리에 `.md` 파일 추가.

### 6.3 새 에이전트 추가

해당 도메인 플러그인의 `agents/` 디렉토리에 `.md` 파일 추가.

### 6.4 새 도메인 플러그인 추가

```
artibot-{domain}/
├── .claude-plugin/
│   └── plugin.json
├── commands/
├── agents/
├── skills/
└── hooks/ (선택)
```

### 6.5 프로젝트별 오버라이드

프로젝트 루트의 `.claude/` 디렉토리에서 로컬 설정 가능:
- `.claude/settings.local.json` - 권한 설정
- `.claude/CLAUDE.md` - 프로젝트 특화 규칙
- `.claude/commands/` - 프로젝트 특화 커맨드

### 6.6 훅 확장

`hooks/hooks.json`에 새 훅 규칙 추가:
- **PreToolUse**: 도구 사용 전 검증
- **PostToolUse**: 도구 사용 후 자동화 (포매팅, 타입체크 등)
- **Stop**: 세션 종료 시 검증

---

## 7. 메모리 시스템

### 7.1 현재 메모리 구조

Claude Code 내장 auto memory 시스템 활용:
```
~/.claude/projects/{project-hash}/memory/
└── MEMORY.md              # 프로젝트별 영구 메모리
```

### 7.2 개선 방향

- 프로젝트별 `MEMORY.md`에 검증된 패턴과 결정사항만 기록
- 토픽별 분리 파일 (예: `debugging.md`, `patterns.md`) 지원
- 세션 간 컨텍스트 유지를 위한 구조화된 메모리 스키마 정의
- 200줄 제한 내에서 효율적 정보 밀도 유지

---

## 8. MCP 통합 전략

### 8.1 MCP 서버 구성

`artibot-mcp/.mcp.json`:
```json
{
  "context7": {
    "type": "stdio",
    "command": "npx",
    "args": ["-y", "@context7/mcp-server"]
  },
  "playwright": {
    "command": "npx",
    "args": ["-y", "@executeautomation/playwright-mcp-server"]
  }
}
```

### 8.2 MCP 활용 스킬

각 MCP 서버별로 활용 스킬을 정의하여, Claude가 적절한 시점에 MCP 도구를 자동 선택하도록 유도:

- `mcp-context7` 스킬: 라이브러리 문서 조회 필요 시 자동 활성화
- `mcp-playwright` 스킬: E2E 테스트, 브라우저 자동화 필요 시 자동 활성화
- `mcp-coordination` 스킬: 다중 MCP 서버 조율이 필요한 복잡한 작업 시 활성화

---

## 9. 구현 로드맵

### Phase 1: 코어 플러그인 (artibot-core)

1. plugin.json 매니페스트 작성
2. 기존 commands/*.md 마이그레이션
3. orchestration 스킬 작성 (ORCHESTRATOR.md 핵심 추출)
4. token-efficiency 스킬 작성 (MODES.md 토큰 최적화 부분 추출)
5. principles 스킬 작성 (PRINCIPLES.md 핵심 추출)

### Phase 2: 페르소나 플러그인 (artibot-personas)

1. 11개 페르소나를 개별 스킬로 분리
2. 복잡한 페르소나(architect, security)는 에이전트도 함께 작성
3. 페르소나 자동 활성화 트리거 최적화

### Phase 3: 워크플로우 플러그인 (artibot-workflow)

1. task, design, git, content 커맨드 마이그레이션
2. git-workflow, tdd-workflow, delegation 스킬 작성
3. planner, tdd-guide, content-marketer 에이전트 마이그레이션

### Phase 4: 품질 관리 플러그인 (artibot-quality)

1. test, cleanup, document 커맨드 마이그레이션
2. coding-standards, security-standards, testing-standards 스킬 작성
3. 기존 rules/*.md 내용을 references/로 변환
4. hooks 마이그레이션 (prettier, typescript-check 등)

### Phase 5: MCP 통합 플러그인 (artibot-mcp)

1. .mcp.json 설정 마이그레이션
2. MCP 활용 스킬 작성
3. 서버 선택/폴백 전략 스킬 작성

### Phase 6: 통합 테스트 및 최적화

1. 글로벌 CLAUDE.md 최소화
2. 전체 커맨드 동작 검증
3. 토큰 사용량 측정 및 최적화
4. 문서화

---

## 10. 설계 검증 기준

| 검증 항목 | 기준 | 측정 방법 |
|-----------|------|-----------|
| 세션 초기 토큰 | <3K 토큰 | CLAUDE.md + plugin.json 크기 합산 |
| 커맨드 응답 품질 | 현재 수준 유지 | 동일 작업 A/B 비교 |
| 페르소나 활성화 정확도 | >85% | 10개 시나리오 테스트 |
| 스킬 트리거 정확도 | >80% | 20개 쿼리 테스트 |
| 플러그인 독립성 | 개별 설치/제거 가능 | 각 플러그인 단독 테스트 |
| 확장 용이성 | 새 모듈 추가에 기존 코드 수정 불필요 | 새 페르소나 추가 테스트 |

---

## 부록: 참조 문서

- Claude Code 공식 플러그인 구조: `~/.claude/plugins/marketplaces/claude-plugins-official/plugins/plugin-dev/`
- SuperClaude 프레임워크 원본: `~/.claude/CLAUDE.md` 및 참조 파일들
- 공식 예제 플러그인: `~/.claude/plugins/marketplaces/claude-plugins-official/plugins/example-plugin/`
