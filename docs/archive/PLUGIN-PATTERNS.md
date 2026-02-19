# Artibot 구현 패턴 가이드

> 4개 GitHub 레포 플러그인 구현 패턴 분석 결과

## 분석 대상 레포 요약

| # | 레포 | 유형 | 규모 | 핵심 특징 |
|---|------|------|------|-----------|
| 1 | ui-ux-pro-max-skill | 단일 스킬 플러그인 | 소 (~100 파일) | CLI 기반 디자인 시스템, Python 스크립트, CSV 데이터 |
| 2 | cc-wf-studio | VSCode 확장 + 스킬 | 대 (~368 파일) | 워크플로우 에디터, Speckit 명령 체계, TypeScript |
| 3 | everything-claude-code | 종합 규칙 모음 | 대 (~626 파일) | 에이전트 13개, 스킬 다수, 다중 플랫폼 (Claude/Cursor) |
| 4 | bkit-claude-code | 프레임워크급 플러그인 | 대 (~200+ 파일) | PDCA 방법론, CTO-Led 팀, 26 스킬, 16 에이전트, 45 스크립트 |

---

## 1. 디렉토리 구조 패턴

### 1.1 `.claude-plugin/` 디렉토리 (Marketplace 등록)

**3개 레포가 채택** (ui-ux-pro-max, everything-claude-code, bkit)

두 가지 핵심 파일:

#### `plugin.json` - 플러그인 메타데이터
```json
{
  "name": "플러그인명",
  "version": "1.0.0",
  "description": "설명",
  "author": { "name": "작성자" },
  "license": "MIT",
  "keywords": ["keyword1", "keyword2"],
  "skills": ["./.claude/skills/스킬명"],   // Repo 1: 경로 배열
  "agents": ["./agents/agent.md"],          // Repo 3: 에이전트 배열
  "outputStyles": "./output-styles/"        // Repo 4: 출력 스타일
}
```

#### `marketplace.json` - 마켓플레이스 카탈로그
```json
{
  "$schema": "https://anthropic.com/claude-code/marketplace.schema.json",
  "name": "marketplace-name",
  "version": "1.0.0",
  "owner": { "name": "조직명" },
  "plugins": [{
    "name": "플러그인명",
    "description": "설명",
    "version": "1.0.0",
    "source": { "source": "url", "url": "https://github.com/..." },
    "category": "development|design|learning",
    "keywords": [...]
  }]
}
```

**패턴 비교**:

| 항목 | Repo 1 | Repo 3 | Repo 4 |
|------|--------|--------|--------|
| plugin.json | skills 배열 | skills + agents 배열 | outputStyles 경로 |
| marketplace.json | 단일 플러그인 | 없음 | 다중 플러그인 + source URL |
| 버전 관리 | 수동 | 수동 | 수동 (config와 동기화) |

### 1.2 `.claude/` 디렉토리 내부 구조

| 레포 | skills/ | commands/ | rules/ | agents/ | 기타 |
|------|---------|-----------|--------|---------|------|
| Repo 1 | `skills/ui-ux-pro-max/SKILL.md` + data + scripts | - | - | - | 심링크로 src/ 참조 |
| Repo 2 | `skills/code-review*/SKILL.md` (4개) | `commands/*.md` (9개) | - | - | - |
| Repo 3 | 없음 (.claude-plugin으로 직접 참조) | - | - | - | `package-manager.json` |
| Repo 4 | 없음 (루트 skills/ 사용) | - | - | - | - |

### 1.3 루트 레벨 디렉토리 구조

**Repo 3 (everything-claude-code)** - 가장 전통적:
```
/
├── agents/          # 에이전트 .md 파일
├── commands/        # 커맨드 .md 파일 (deprecated -> skills)
├── contexts/        # 컨텍스트 .md 파일
├── hooks/           # hooks.json + 스크립트
├── mcp-configs/     # MCP 설정
├── plugins/         # 플러그인 하위 모듈
├── rules/           # 규칙 (common/ + 언어별)
├── schemas/         # JSON 스키마
├── scripts/         # 유틸리티 스크립트
├── skills/          # 스킬 SKILL.md 파일
└── install.sh       # 설치 스크립트
```

**Repo 4 (bkit)** - 가장 성숙한 구조:
```
/
├── agents/          # 에이전트 16개
├── bkit-system/     # Obsidian 기반 내부 문서
├── commands/        # 커맨드 (bkit.md 등)
├── docs/            # PDCA 문서 (01-plan ~ 04-report)
├── hooks/           # hooks.json + session-start.js
├── lib/             # Node.js 핵심 모듈 (common, core, pdca, intent, task, team)
├── output-styles/   # 출력 스타일 4개
├── refs/            # 참조 문서
├── scripts/         # 45개 후크 스크립트
├── skills/          # 26개 스킬
├── templates/       # 템플릿 (PDCA 문서, 파이프라인 등)
└── bkit.config.json # 중앙 설정
```

---

## 2. 설치 스크립트/방식 비교

### 2.1 Repo 1 (ui-ux-pro-max): CLI 도구
```
npx uipro-cli init   # npm 패키지로 설치
```
- TypeScript CLI (`cli/src/commands/init.ts`)
- 플랫폼 자동 감지 (Claude, Cursor, Copilot 등 15개 플랫폼)
- 템플릿 렌더링 엔진으로 플랫폼별 설정 생성
- Python 스크립트 + CSV 데이터 복사

### 2.2 Repo 2 (cc-wf-studio): VSCode Extension
- VSCode Marketplace 통해 설치
- `vite.extension.config.ts` 빌드
- 설치 스크립트 없음 (확장 매니저가 처리)

### 2.3 Repo 3 (everything-claude-code): Bash 설치 스크립트
```bash
./install.sh [--target <claude|cursor>] <language> [<language> ...]
```
**핵심 패턴**:
- `--target claude`: `~/.claude/rules/` 에 common + 언어별 규칙 복사
- `--target cursor`: `.cursor/` 에 rules, agents, skills, commands, mcp.json 복사
- 언어 이름 유효성 검증 (path traversal 방지): `[a-zA-Z0-9_-]+`
- 기존 파일 덮어쓰기 경고
- npm 패키지 `bin` 심링크 지원 (`ecc-install`)

### 2.4 Repo 4 (bkit): Claude Marketplace 플러그인
```
# Claude Code Marketplace에서 직접 설치
claude plugin add bkit
```
- `.claude-plugin/plugin.json` + `marketplace.json` 구조
- `hooks.json` 에서 `${CLAUDE_PLUGIN_ROOT}` 변수로 플러그인 루트 참조
- `bkit.config.json` 중앙 설정으로 모든 동작 제어
- 별도 설치 스크립트 불필요

**Artibot 권장**: Repo 4 방식 (Claude Marketplace 플러그인) + Repo 3 방식 (fallback bash 스크립트)

---

## 3. SKILL.md 구현 방식 분석

### 3.1 프런트매터 (Frontmatter) 구조

**최소 구조** (Repo 1, 2):
```yaml
---
name: skill-name
description: "설명"
---
```

**확장 구조** (Repo 4 - bkit, 가장 완전):
```yaml
---
name: pdca
description: |
  여러 줄 설명...
  Triggers: keyword1, keyword2, keyword3
  Do NOT use for: 부적절한 사용 사례
argument-hint: "[action] [feature]"
user-invocable: true
agents:
  analyze: bkit:gap-detector
  iterate: bkit:pdca-iterator
allowed-tools:
  - Read
  - Write
  - Bash
imports:
  - ${PLUGIN_ROOT}/templates/plan.template.md
next-skill: null
pdca-phase: null
task-template: "[PDCA] {feature}"
---
```

**프런트매터 필드 종합**:

| 필드 | Repo 1 | Repo 2 | Repo 3 | Repo 4 | 설명 |
|------|--------|--------|--------|--------|------|
| name | O | O | O | O | 스킬 이름 |
| description | O | O | O | O (여러 줄) | 설명 + 트리거 키워드 |
| user-invocable | - | - | - | O | `/skill` 직접 호출 가능 여부 |
| argument-hint | - | - | - | O | 인수 힌트 |
| agents | - | - | - | O | 연동 에이전트 매핑 |
| allowed-tools | - | - | - | O | 사용 가능 도구 제한 |
| imports | - | - | - | O | 템플릿 임포트 |
| next-skill | - | - | - | O | 다음 스킬 체이닝 |
| task-template | - | - | - | O | 태스크 생성 템플릿 |

### 3.2 SKILL.md 본문 구조 패턴

**Repo 1 (ui-ux-pro-max)** - 도구 사용 안내형:
```markdown
# 제목
## When to Apply (적용 시점)
## Quick Reference (빠른 참조)
## Prerequisites (사전 조건)
## How to Use This Skill (사용 방법 - 단계별)
## Search Reference (검색 참조)
## Example Workflow (예제 워크플로우)
## Pre-Delivery Checklist (체크리스트)
```

**Repo 2 (cc-wf-studio)** - 간결 구조:
```markdown
# 제목
## Overview
## Input
## Output
## Usage Examples
```

**Repo 4 (bkit)** - 가장 상세한 구조:
```markdown
# 제목
## Arguments (인수 테이블)
## Action Details (각 액션 상세)
  ### action_name
  1. 단계별 실행 로직
  2. 에이전트 호출
  3. 태스크 생성
  4. 상태 업데이트
## Template References (템플릿 참조)
## Task Integration (태스크 통합)
## Agent Integration (에이전트 통합)
## Usage Examples (사용 예시)
## Legacy Commands Mapping (레거시 매핑)
## Auto Triggers (자동 트리거)
```

---

## 4. Hooks 시스템 활용 비교

### 4.1 Hooks 구현 방식

**Repo 3 (everything-claude-code)**: `hooks/hooks.json` (인라인 Node.js)
- 인라인 `node -e "..."` 명령으로 간단한 훅 구현
- PreToolUse: tmux 리마인더, git push 리뷰, .md 파일 차단, compact 제안
- PostToolUse: PR 생성 로그, 빌드 분석, Prettier, TypeScript 체크, console.log 경고
- Stop: console.log 감사
- SessionStart/End: 세션 상태 저장/로드

**Repo 4 (bkit)**: `hooks/hooks.json` (외부 스크립트 참조)
- `${CLAUDE_PLUGIN_ROOT}/scripts/` 경로의 외부 .js 파일 참조
- 10개 이벤트 타입 활용 (최대):
  - SessionStart, PreToolUse, PostToolUse, Stop
  - UserPromptSubmit, PreCompact, TaskCompleted
  - SubagentStart, SubagentStop, TeammateIdle

### 4.2 Hook 이벤트 활용도

| 이벤트 | Repo 3 | Repo 4 | 용도 |
|--------|--------|--------|------|
| SessionStart | O | O | 세션 초기화, 컨텍스트 로드 |
| PreToolUse(Bash) | O | O | 안전성 검사, tmux 리마인더 |
| PreToolUse(Write/Edit) | O | O | 파일 생성 차단, 사전 검증 |
| PostToolUse(Write) | - | O | 쓰기 후 처리 |
| PostToolUse(Bash) | O | O | PR 로그, 빌드 분석 |
| PostToolUse(Edit) | O | - | Prettier, TypeScript 체크 |
| PostToolUse(Skill) | - | O | 스킬 실행 후 처리 |
| Stop | O | O | 세션 종료 시 감사/정리 |
| SessionEnd | O | - | 세션 상태 영속화, 패턴 평가 |
| PreCompact | - | O | 컨텍스트 압축 전 스냅샷 |
| UserPromptSubmit | - | O | 사용자 입력 인텐트 분석 |
| TaskCompleted | - | O | PDCA 자동 진행 |
| SubagentStart/Stop | - | O | 에이전트 팀 관리 |
| TeammateIdle | - | O | 유휴 팀원 작업 배정 |

### 4.3 hooks.json 형식 비교

**Repo 3 형식** (인라인):
```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Bash",
      "hooks": [{
        "type": "command",
        "command": "node -e \"...인라인 코드...\""
      }],
      "description": "설명"
    }]
  }
}
```

**Repo 4 형식** (외부 스크립트):
```json
{
  "$schema": "https://json.schemastore.org/claude-code-hooks.json",
  "hooks": {
    "SessionStart": [{
      "once": true,
      "hooks": [{
        "type": "command",
        "command": "node ${CLAUDE_PLUGIN_ROOT}/hooks/session-start.js",
        "timeout": 5000
      }]
    }]
  }
}
```

**Repo 4 장점**: 외부 스크립트로 복잡한 로직 분리, `$schema` 검증, timeout 설정, `once` 옵션

---

## 5. 설정 파일 관리 패턴

### 5.1 중앙 설정 파일

**Repo 4 (bkit)** - `bkit.config.json`:
- 가장 성숙한 중앙 설정 패턴
- 12개 섹션: sourceDirectories, codeExtensions, pdca, taskClassification, levelDetection, templates, conventions, agents, output, permissions, context, automation, hooks, team, outputStyles
- 에이전트 라우팅 규칙, 태스크 분류 기준, 퍼미션 제어 모두 포함

### 5.2 메모리/상태 관리

| 항목 | Repo 3 | Repo 4 |
|------|--------|--------|
| 세션 상태 | `.claude/package-manager.json` | `docs/.pdca-status.json` |
| 메모리 저장 | - | `docs/.bkit-memory.json` |
| 컨텍스트 관리 | - | `lib/context-hierarchy.js` |
| 포크 관리 | - | `lib/context-fork.js` |

### 5.3 에이전트 파일 구조

**Repo 4 (bkit)** 에이전트 패턴:
- 루트 `agents/` 디렉토리에 .md 파일
- 16개 에이전트, 모델별 분류 (opus, sonnet, haiku)
- `bkit.config.json`에서 에이전트 라우팅 규칙 정의:
  ```json
  "agents": {
    "levelBased": { "Starter": "starter-guide", "Dynamic": "bkend-expert" },
    "taskBased": { "code review": "code-analyzer", "security scan": "security-architect" }
  }
  ```

**Repo 3 (everything-claude-code)** 에이전트 패턴:
- 루트 `agents/` 디렉토리에 .md 파일
- 13개 에이전트 (일반 + 언어별: go-reviewer, python-reviewer)
- `plugin.json`에서 명시적 에이전트 파일 목록

---

## 6. 핵심 발견 및 Artibot 권장 패턴

### 6.1 플러그인 배포 구조 (Marketplace 표준)

```
artibot/
├── .claude-plugin/
│   ├── plugin.json          # 플러그인 메타데이터
│   └── marketplace.json     # 마켓플레이스 등록
├── agents/                  # 에이전트 .md 파일
├── commands/                # 커맨드 .md 파일
├── hooks/
│   └── hooks.json           # ${CLAUDE_PLUGIN_ROOT} 참조
├── lib/                     # Node.js 핵심 로직
├── output-styles/           # 출력 스타일 (선택)
├── scripts/                 # 훅 스크립트
├── skills/
│   └── skill-name/
│       └── SKILL.md         # 스킬 정의
├── templates/               # 문서 템플릿
├── artibot.config.json      # 중앙 설정
└── install.sh               # fallback 설치 (선택)
```

### 6.2 SKILL.md 표준 프런트매터

```yaml
---
name: skill-name
description: |
  기능 설명.
  Triggers: keyword1, keyword2 (다국어)
  Do NOT use for: 부적절한 사용 사례
argument-hint: "[action] [target]"
user-invocable: true
agents:
  action1: artibot:agent-name
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
imports:
  - ${PLUGIN_ROOT}/templates/template.md
next-skill: null
---
```

### 6.3 hooks.json 표준 구조

```json
{
  "$schema": "https://json.schemastore.org/claude-code-hooks.json",
  "hooks": {
    "SessionStart": [{
      "once": true,
      "hooks": [{
        "type": "command",
        "command": "node ${CLAUDE_PLUGIN_ROOT}/hooks/session-start.js",
        "timeout": 5000
      }]
    }],
    "PreToolUse": [{
      "matcher": "Write|Edit",
      "hooks": [{
        "type": "command",
        "command": "node ${CLAUDE_PLUGIN_ROOT}/scripts/pre-write.js",
        "timeout": 5000
      }]
    }]
  }
}
```

### 6.4 중앙 설정 패턴

```json
{
  "$schema": "./artibot.config.schema.json",
  "version": "1.0.0",
  "personas": { ... },
  "agents": { "taskBased": { ... }, "levelBased": { ... } },
  "commands": { ... },
  "flags": { "defaults": { ... }, "autoActivation": { ... } },
  "mcp": { "servers": { ... }, "fallback": { ... } },
  "memory": { "autoSave": true, "maxEntries": 200 },
  "permissions": { "Write": "allow", "Bash(rm -rf*)": "deny" }
}
```

### 6.5 품질 기준 요약

| 항목 | 최소 기준 | 최적 기준 (bkit 참조) |
|------|-----------|----------------------|
| 프런트매터 | name, description | + user-invocable, agents, allowed-tools, imports |
| 에이전트 | name, description, tools, model | + 라우팅 룰, 모델 선택, 팀 통합 |
| 훅 스크립트 | 인라인 | 외부 .js + timeout + $schema |
| 설정 관리 | plugin.json만 | + 중앙 config + 스키마 검증 |
| 세션 관리 | SessionStart만 | + PreCompact + TaskCompleted + TeammateIdle |
| 다국어 | 영어만 | 8개 언어 트리거 키워드 |

---

## 7. 기존 SuperClaude와의 통합 고려사항

### 7.1 충돌 가능 영역

| SuperClaude 구성요소 | 충돌 위험 | 완화 방안 |
|---------------------|----------|-----------|
| PERSONAS.md (11 페르소나) | 중간 - bkit 에이전트와 역할 중복 | 네임스페이스 분리 (artibot: 접두사) |
| ORCHESTRATOR.md (라우팅) | 높음 - 자동 활성화 로직 충돌 | 플러그인 우선순위 명시, 오케스트레이터 확장 |
| FLAGS.md (플래그 체계) | 낮음 - 추가적 | 기존 플래그와 겹치지 않는 새 플래그 |
| MCP.md (서버 통합) | 낮음 - 상호 보완 | MCP 설정은 플러그인과 독립 |
| MODES.md (토큰 효율) | 중간 - 플러그인 훅이 토큰 소비 | SessionStart 출력 최소화 |

### 7.2 호환성 전략

1. **네임스페이스**: 모든 Artibot 에이전트/스킬에 `artibot:` 접두사
2. **우선순위**: SuperClaude 기본 설정 > Artibot 플러그인 (override 아닌 extend)
3. **설정 분리**: `artibot.config.json`은 Artibot 전용, SuperClaude 파일 미수정
4. **Hook 공존**: `hooks.json`에서 기존 SuperClaude 훅과 충돌하지 않는 이벤트만 사용

---

*분석 일시: 2026-02-13*
*분석자: reviewer-2*
