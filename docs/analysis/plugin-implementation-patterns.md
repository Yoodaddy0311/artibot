# Plugin Implementation Patterns Analysis

4개 레포 심층 분석: bkit-claude-code, everything-claude-code, cc-wf-studio, ui-ux-pro-max-skill

---

## 1. .claude-plugin/ 디렉토리 구조

### 1.1 plugin.json 비교

| Field | bkit | everything-claude-code | ui-ux-pro-max | cc-wf-studio |
|-------|------|----------------------|---------------|-------------|
| name | `bkit` | `everything-claude-code` | `ui-ux-pro-max` | N/A (no plugin) |
| version | `1.5.3` | `1.4.1` | `2.0.1` | N/A |
| agents | (none) | explicit file paths x13 | (none) | N/A |
| skills | (none) | directory paths x2 | directory path x1 | N/A |
| commands | (none) | (none) | (none) | N/A |
| hooks | (none - auto-loaded) | (none - auto-loaded) | (none) | N/A |
| outputStyles | `./output-styles/` | (none) | (none) | N/A |

### 1.2 marketplace.json 비교

| Field | bkit | everything-claude-code | ui-ux-pro-max | cc-wf-studio |
|-------|------|----------------------|---------------|-------------|
| Format | `$schema` + `plugins[]` | flat structure | `plugins[]` with metadata | N/A |
| Plugin count | 2 (bkit-starter, bkit) | 1 | 1 | N/A |
| source.source | `url` (git URL) | (none) | `./` (local) | N/A |
| category | `development` | (none) | `design` | N/A |
| strict | (none) | (none) | `false` | N/A |

### 1.3 핵심 패턴

**Pattern A: Minimal plugin.json (bkit)**
- plugin.json에는 name, version, description, author, outputStyles만 포함
- agents/skills/commands를 plugin.json에 선언하지 않음
- hooks는 `hooks/hooks.json`에서 자동 로드 (Claude Code v2.1+ convention)
- 장점: 유지보수 간편, validator 충돌 최소화
- 단점: 명시적 선언 부재로 어떤 컴포넌트가 있는지 plugin.json만으로 파악 불가

**Pattern B: Explicit declaration (everything-claude-code)**
- agents를 13개 개별 파일 경로로 명시적 선언
- skills/commands는 디렉토리 경로 배열로 선언
- hooks는 plugin.json에 포함하지 않음 (중복 오류 방지)
- 장점: 정확한 컴포넌트 목록 추적 가능
- 단점: agent 추가/삭제시 plugin.json 수정 필요

**Pattern C: Skill-only plugin (ui-ux-pro-max)**
- skills 배열에 단일 디렉토리 경로만 선언
- agents/commands/hooks 없음
- 가장 단순한 구조

### 1.4 CRITICAL: Plugin Validator 제약사항

`everything-claude-code/PLUGIN_SCHEMA_NOTES.md`에서 발견된 미문서화 제약사항:

1. **`version` 필드 필수**: 생략시 marketplace 설치 또는 CLI 검증 실패
2. **모든 컴포넌트 필드는 배열**: `agents`, `commands`, `skills`, `hooks` - 단일 값이라도 배열로 래핑 필수
3. **agents는 명시적 파일 경로**: 디렉토리 경로 불가 (`./agents/` 불가, `./agents/planner.md` 필요)
4. **commands/skills는 디렉토리 경로 허용**: 배열 내 디렉토리 가능
5. **hooks 필드 추가 금지**: Claude Code v2.1+에서 `hooks/hooks.json` 자동 로드. 명시적 선언시 중복 오류 발생
6. **크로스 플랫폼 주의**: Windows 설치 시 경로 처리가 더 엄격함
7. **Validator는 hostile and literal**: 모호한 경로는 거부됨

**최소 검증 통과 예시:**
```json
{
  "name": "plugin-name",
  "version": "1.0.0",
  "agents": ["./agents/agent1.md", "./agents/agent2.md"],
  "commands": ["./commands/"],
  "skills": ["./skills/"]
}
```

---

## 2. 설치 스크립트/방식

### 2.1 설치 방식 비교

| Method | bkit | everything-claude-code | ui-ux-pro-max | cc-wf-studio |
|--------|------|----------------------|---------------|-------------|
| Claude Plugin | Yes (marketplace) | Yes (marketplace) | Yes (marketplace) | No |
| CLI Installer | No | `install.sh` (bash) | `uipro-cli` (npm) | No |
| npm package | No | `ecc-install` (bin) | `uipro-cli` | `cc-wf-studio` |
| Git clone | Yes | Yes | Yes | Yes |
| Targets | Claude only | Claude + Cursor | Multi-platform (15+) | N/A |

### 2.2 everything-claude-code: install.sh 패턴

```
install.sh [--target <claude|cursor>] <language> [<language> ...]
```

**핵심 로직:**
- Claude target: `~/.claude/rules/` 에 common/ + language-specific/ 규칙 복사
- Cursor target: `.cursor/` 하위에 rules/, agents/, skills/, commands/, mcp.json 복사
- 경로 순회 방지: `[a-zA-Z0-9_-]+` 정규식으로 language name 검증
- 기존 파일 덮어쓰기 경고
- Symlink 해석 처리 (npm bin 연결 대응)

**설치 구조:**
```
~/.claude/rules/
  common/           # 공통 규칙 (coding-style.md, etc.)
  typescript/       # 언어별 규칙
  python/
  golang/
```

### 2.3 ui-ux-pro-max-skill: CLI 설치 패턴

```
npx uipro-cli init [--platform <platform>]
```

**지원 플랫폼 (15+):**
claude, cursor, windsurf, codebuddy, copilot, continue, trae, opencode, roocode, qoder, kiro, codex, gemini, agent (Cline), droid (Factory)

**설치 구조:**
- `cli/assets/` 에 data/, scripts/, templates/ 번들링 (~564KB)
- `cli/src/commands/init.ts` 에서 template rendering
- `cli/src/utils/template.ts` 에서 플랫폼별 config 생성
- `src/ui-ux-pro-max/templates/platforms/*.json` 에서 플랫폼 설정 참조

**소스 관리:**
- Source of Truth: `src/ui-ux-pro-max/`
- Symlink 기반 개발: `.claude/skills/` -> `src/` (변경 즉시 반영)
- CLI 배포 전 수동 sync: `cp -r src/* cli/assets/`

### 2.4 bkit: Plugin Marketplace 전용

- `marketplace.json` 에 git URL source 선언
- `source.source: "url"`, `source.url: "https://github.com/.../bkit-claude-code.git"`
- 2개 플러그인 번들: bkit-starter (학습용), bkit (메인)
- 별도 CLI installer 없음 - Claude Plugin marketplace 의존

### 2.5 Artibot 설계 권고

**추천: Hybrid 방식**
1. **Primary**: Claude Plugin marketplace (plugin.json + marketplace.json)
2. **Secondary**: npm CLI installer (cross-platform 지원)
3. **Development**: Symlink 기반 로컬 개발 (ui-ux-pro-max 패턴)

---

## 3. 스킬 파일 구현 방식

### 3.1 SKILL.md Frontmatter 비교

**bkit (pdca/SKILL.md) - 최대 복잡도:**
```yaml
---
name: pdca
description: |
  Multi-line description with trigger keywords...
argument-hint: "[action] [feature]"
user-invocable: true
agents:
  analyze: bkit:gap-detector
  iterate: bkit:pdca-iterator
  report: bkit:report-generator
  team: bkit:cto-lead
  default: null
allowed-tools:
  - Read, Write, Edit, Glob, Grep, Bash, Task, TaskCreate, TaskUpdate, TaskList, AskUserQuestion
imports:
  - ${PLUGIN_ROOT}/templates/plan.template.md
  - ${PLUGIN_ROOT}/templates/design.template.md
next-skill: null
pdca-phase: null
task-template: "[PDCA] {feature}"
---
```

**everything-claude-code (tdd-workflow/SKILL.md) - 표준 복잡도:**
```yaml
---
name: tdd-workflow
description: Use this skill when writing new features...
---
```

**ui-ux-pro-max (SKILL.md) - 도메인 특화:**
- Python 스크립트 호출 기반 (`python3 scripts/search.py`)
- CSV 데이터베이스 참조
- 다양한 --domain/--stack 인자

### 3.2 스킬 디렉토리 구조 패턴

**Pattern A: 단일 SKILL.md (everything-claude-code)**
```
skills/tdd-workflow/
  SKILL.md           # 지침만 포함
```
- 가장 단순
- SKILL.md 내 인라인 지침으로 충분한 경우

**Pattern B: SKILL.md + 외부 리소스 (bkit)**
```
skills/pdca/
  SKILL.md           # frontmatter에 imports, agents 연결
# + templates/, scripts/ 등은 플러그인 루트에 위치
```
- `${PLUGIN_ROOT}` 변수로 상대 경로 참조
- agents 맵핑 (`analyze: bkit:gap-detector`)
- allowed-tools 명시적 선언

**Pattern C: SKILL.md + 스크립트 + 데이터 (ui-ux-pro-max)**
```
.claude/skills/ui-ux-pro-max/
  SKILL.md           # 스킬 정의
# + src/ui-ux-pro-max/
  scripts/search.py  # Python CLI 도구
  scripts/core.py    # BM25 검색 엔진
  data/*.csv         # 데이터베이스
```
- Symlink 기반으로 소스와 스킬 연결
- 외부 도구(Python) 실행 의존

### 3.3 스킬 분류 (bkit 기준: 26개)

| Category | Skills | Purpose |
|----------|--------|---------|
| PDCA Phases | phase-1 ~ phase-9, pdca | 개발 파이프라인 단계별 가이드 |
| Backend | bkend-auth, bkend-data, bkend-storage, bkend-quickstart, bkend-cookbook | Supabase 백엔드 |
| Team Levels | starter, dynamic, enterprise | 팀 규모별 워크플로우 |
| Process | code-review, development-pipeline, zero-script-qa | 품질 프로세스 |
| Core | bkit-rules, bkit-templates, claude-code-learning | 프레임워크 규칙 |
| App Types | desktop-app, mobile-app | 앱 유형별 가이드 |

### 3.4 스킬 분류 (everything-claude-code 기준: 37개)

| Category | Skills | Purpose |
|----------|--------|---------|
| Language-specific | golang-*, python-*, java-*, django-*, springboot-*, cpp-* | 언어/프레임워크별 패턴 |
| Testing | tdd-workflow, e2e-testing, verification-loop | TDD, E2E, 검증 |
| Security | security-review, security-scan | 보안 검토 |
| Infrastructure | docker-patterns, deployment-patterns, database-migrations | 인프라 패턴 |
| Process | continuous-learning, continuous-learning-v2, strategic-compact, eval-harness | 학습/최적화 |
| Design | api-design, frontend-patterns, backend-patterns, postgres-patterns | 설계 패턴 |

### 3.5 Artibot 스킬 설계 권고

- **Frontmatter 표준화**: name, description 필수 / user-invocable, allowed-tools, imports 선택
- **agents 맵핑**: 복잡한 스킬은 bkit 패턴 (`agents: { action: plugin:agent-name }`)
- **imports**: `${PLUGIN_ROOT}` 변수로 템플릿/데이터 참조
- **트리거 키워드**: description 내 다국어 키워드 포함 (bkit 패턴)

---

## 4. Hooks 시스템 활용

### 4.1 Hook 이벤트 사용 비교

| Event | bkit | everything-claude-code | ui-ux-pro-max | cc-wf-studio |
|-------|------|----------------------|---------------|-------------|
| SessionStart | Yes (session-start.js) | Yes (session-start.js) | No | No |
| PreToolUse | Write\|Edit, Bash | Bash x3, Write, Edit\|Write | No | No |
| PostToolUse | Write, Bash, Skill | Bash x2, Edit x3 | No | No |
| Stop | Yes (unified-stop.js) | Yes (check-console-log.js) | No | No |
| UserPromptSubmit | Yes (user-prompt-handler.js) | No | No | No |
| PreCompact | Yes (context-compaction.js) | Yes (pre-compact.js) | No | No |
| TaskCompleted | Yes (pdca-task-completed.js) | No | No | No |
| SubagentStart | Yes (subagent-start-handler.js) | No | No | No |
| SubagentStop | Yes (subagent-stop-handler.js) | No | No | No |
| TeammateIdle | Yes (team-idle-handler.js) | No | No | No |
| SessionEnd | No | Yes (session-end.js, evaluate-session.js) | No | No |

### 4.2 bkit hooks.json 핵심 패턴

**파일 위치**: `hooks/hooks.json` (자동 로드)

**구조:**
```json
{
  "$schema": "https://json.schemastore.org/claude-code-hooks.json",
  "description": "bkit Vibecoding Kit v1.5.3 - Claude Code",
  "hooks": {
    "EventName": [{
      "matcher": "ToolPattern",     // optional
      "once": true,                  // optional - 세션당 1회 실행
      "hooks": [{
        "type": "command",
        "command": "node ${CLAUDE_PLUGIN_ROOT}/scripts/handler.js",
        "timeout": 5000              // ms
      }]
    }]
  }
}
```

**고급 기능:**
- `once: true` (SessionStart) - 세션당 한 번만 실행
- `matcher: "auto|manual"` (PreCompact) - 자동/수동 컴팩션 구분
- `matcher: "Write|Edit"` - 복수 도구 매칭
- `matcher: "Skill"` (PostToolUse) - 스킬 실행 후 후처리
- Team hooks: SubagentStart/Stop, TeammateIdle - 에이전트 팀 관리

**`${CLAUDE_PLUGIN_ROOT}` 변수:**
- 플러그인 설치 디렉토리를 가리키는 환경 변수
- hook command와 skill imports에서 사용
- 절대 경로 하드코딩 방지

### 4.3 everything-claude-code hooks.json 핵심 패턴

**인라인 Node.js 스크립트 패턴:**
```json
{
  "command": "node -e \"let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{...})\""
}
```
- stdin에서 JSON 파싱하여 tool_input/tool_output 접근
- process.exit(2)로 도구 실행 차단
- console.error()로 사용자에게 메시지 전달

**외부 스크립트 패턴:**
```json
{
  "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/hooks/suggest-compact.js\""
}
```

**async hook 패턴:**
```json
{
  "async": true,
  "timeout": 30
}
```
- 비동기 실행 (메인 플로우 차단하지 않음)

### 4.4 Hook 활용 카테고리

| Category | Hooks | Purpose |
|----------|-------|---------|
| Guard/Validation | PreToolUse(Bash) dev-server block | 위험한 명령어 차단 |
| Quality | PostToolUse(Edit) format/typecheck/console-warn | 코드 품질 자동 검사 |
| Context Management | PreCompact, SessionStart, SessionEnd | 컨텍스트 보존/복원 |
| Team Management | SubagentStart/Stop, TeammateIdle | 에이전트 팀 조율 |
| Workflow | TaskCompleted, UserPromptSubmit | 워크플로우 자동화 |
| Notification | PostToolUse(Bash) PR creation log | 정보성 알림 |
| Learning | SessionEnd evaluate-session | 패턴 학습/추출 |

### 4.5 Artibot Hook 설계 권고

**Tier 1 (필수):**
- SessionStart: 프로젝트 컨텍스트 로드, 설정 초기화
- PreToolUse(Write|Edit): 파일 보호, 규칙 검증
- Stop: 세션 상태 저장, 품질 검사

**Tier 2 (팀 모드):**
- SubagentStart/Stop: 에이전트 상태 추적
- TeammateIdle: 작업 자동 배정
- TaskCompleted: PDCA 워크플로우 진행

**Tier 3 (고급):**
- PreCompact: 컨텍스트 압축 전 상태 보존
- PostToolUse(Edit): 자동 포맷/타입체크
- SessionEnd: 학습 패턴 추출
- UserPromptSubmit: 사용자 입력 분석

---

## 5. 설정 파일 관리

### 5.1 설정 파일 위치 비교

| Config | bkit | everything-claude-code | ui-ux-pro-max | cc-wf-studio |
|--------|------|----------------------|---------------|-------------|
| Plugin manifest | `.claude-plugin/plugin.json` | `.claude-plugin/plugin.json` | `.claude-plugin/plugin.json` | N/A |
| Marketplace | `.claude-plugin/marketplace.json` | `.claude-plugin/marketplace.json` | `.claude-plugin/marketplace.json` | N/A |
| Project config | `bkit.config.json` (root) | N/A | N/A | `package.json` |
| Package manager | N/A | `.claude/package-manager.json` | N/A | N/A |
| Hooks | `hooks/hooks.json` | `hooks/hooks.json` | N/A | N/A |
| MCP | N/A | `mcp-configs/*.json` | N/A | N/A |
| State | `.bkit/agent-state.json` | N/A | N/A | N/A |

### 5.2 bkit.config.json 패턴 (가장 포괄적)

```json
{
  "version": "1.5.3",
  "pdca": {
    "enabled": true,
    "phases": ["plan", "design", "do", "check", "act"],
    "autoPhaseDetection": true
  },
  "taskClassification": {
    "levels": { "Starter": {...}, "Dynamic": {...}, "Enterprise": {...} }
  },
  "levelDetection": {
    "auto": true,
    "indicators": {...}
  },
  "agents": {
    "ctoModel": "opus",
    "teammateModel": "sonnet",
    "maxTeammates": 5,
    "roles": [...]
  },
  "permissions": {
    "allowAutoCommit": false,
    "allowAutoPush": false,
    "requireReview": true
  },
  "team": {
    "enabled": true,
    "maxSize": 5,
    "communication": { "broadcastTimeout": 5000 }
  }
}
```

**핵심 설계 원칙:**
- 단일 설정 파일로 전체 플러그인 동작 제어
- 계층적 구조 (pdca > taskClassification > agents > permissions > team)
- Auto-detection 지원 (levelDetection.auto, pdca.autoPhaseDetection)
- 안전한 기본값 (allowAutoCommit: false, requireReview: true)

### 5.3 상태 관리 패턴

**bkit: agent-state.json (디스크 기반)**
```
.bkit/agent-state.json
```
- Atomic writes: tmp 파일 생성 후 rename
- 최대 10 teammates, 50 message ring buffer
- 구조: `{ teammates: Map, progress: {}, recentMessages: [] }`
- Functions: initAgentState, updateTeammateStatus, addTeammate, removeTeammate

**everything-claude-code: observations.jsonl (학습 기반)**
```
~/.claude/homunculus/observations.jsonl
```
- JSONL 형식 (append-only)
- 최대 10MB, 7일 후 아카이브
- instincts/ 디렉토리에 학습된 패턴 저장

### 5.4 환경 변수 활용

| Variable | Used By | Purpose |
|----------|---------|---------|
| `${CLAUDE_PLUGIN_ROOT}` | bkit, everything | 플러그인 설치 디렉토리 |
| `${PLUGIN_ROOT}` | bkit (SKILL.md imports) | 플러그인 루트 (skill frontmatter용) |
| `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` | bkit | 팀 모드 활성화 여부 확인 |
| `COMPACT_THRESHOLD` | everything | 컴팩션 제안 임계값 |
| `CLAUDE_RULES_DIR` | everything (install.sh) | 규칙 설치 경로 오버라이드 |

### 5.5 Artibot 설정 설계 권고

**추천 구조:**
```
artibot.config.json          # 메인 설정 (bkit 패턴)
.claude-plugin/
  plugin.json                # 플러그인 매니페스트
  marketplace.json           # 마켓플레이스 정보
hooks/
  hooks.json                 # 훅 정의 (자동 로드)
.artibot/
  state.json                 # 런타임 상태 (agent-state.json 패턴)
  cache/                     # 캐시 디렉토리
```

---

## 6. 레포별 종합 아키텍처 패턴

### 6.1 bkit-claude-code (Enterprise-Grade Plugin)

```
[root]/
  .claude-plugin/plugin.json + marketplace.json
  bkit.config.json           # 전체 설정 중앙 관리
  agents/ (16)               # 에이전트 정의 (CTO-Led)
  skills/ (26)               # 도메인별 스킬
  commands/ (2)              # 사용자 명령어
  hooks/hooks.json           # 11 hook events
  scripts/ (20+)             # hook handlers + utilities
  lib/team/ (9 modules)      # 팀 시스템 코어 라이브러리
  templates/                 # PDCA 문서 템플릿
  output-styles/             # 출력 스타일 정의
  bkit-system/               # 시스템 문서/테스트
  docs/                      # 프로젝트 문서
```

**강점:** 가장 포괄적인 팀 시스템, PDCA 워크플로우, 엔터프라이즈 지원
**약점:** 복잡도 높음, 학습 곡선

### 6.2 everything-claude-code (Battle-Tested Collection)

```
[root]/
  .claude-plugin/plugin.json + marketplace.json + PLUGIN_SCHEMA_NOTES.md
  agents/ (13)               # 명시적 파일 경로 선언
  skills/ (37)               # 언어/도메인별 스킬
  commands/ (2)              # 사용자 명령어
  hooks/hooks.json           # 6 hook events
  scripts/hooks/ (8)         # hook handler 스크립트
  rules/ (common/ + lang/)   # 다국어 규칙
  install.sh                 # CLI 설치 (claude/cursor)
  tests/                     # 테스트 (plugin validator 포함)
  mcp-configs/               # MCP 서버 설정
```

**강점:** 실전 검증, plugin validator 문서, 다양한 언어 지원, 설치 스크립트
**약점:** 팀 시스템 없음, agent 간 상태 공유 없음

### 6.3 ui-ux-pro-max-skill (Domain-Specific Skill Plugin)

```
[root]/
  .claude-plugin/plugin.json + marketplace.json
  src/ui-ux-pro-max/         # Source of Truth
    data/*.csv               # 도메인 데이터베이스
    scripts/*.py             # Python 검색 엔진
    templates/               # 플랫폼별 템플릿
  cli/                       # npm CLI installer
    assets/                  # 번들 에셋 (sync from src/)
    src/                     # CLI 코드
  .claude/skills/            # Symlink to src/
```

**강점:** 깔끔한 소스 관리, 멀티 플랫폼 CLI, 데이터 기반 스킬
**약점:** 단일 스킬 전용, 팀/hook 시스템 없음

### 6.4 cc-wf-studio (Non-Plugin Project)

```
[root]/
  .claude/commands/          # speckit workflow commands
  .claude/skills/            # code review skills (4)
  src/                       # VSCode extension
  specs/                     # Speckit 스펙 문서
  contracts/                 # JSON Schema 계약
```

**강점:** 체계적 스펙 워크플로우, 계약 기반 개발
**약점:** 플러그인이 아님, 마켓플레이스 미지원

---

## 7. Artibot 플러그인 설계 권고 종합

### 7.1 디렉토리 구조 권고

```
artibot/
  .claude-plugin/
    plugin.json              # Pattern B (explicit agents, directory skills/commands)
    marketplace.json         # marketplace distribution
  artibot.config.json        # bkit 패턴 중앙 설정
  agents/                    # 명시적 파일 경로 (everything 패턴)
    architect.md
    developer.md
    reviewer.md
    ...
  skills/                    # 도메인별 SKILL.md (bkit 패턴 frontmatter)
    core/SKILL.md
    workflow/SKILL.md
    ...
  commands/                  # 사용자 명령어
    artibot.md
    ...
  hooks/
    hooks.json               # 자동 로드 (plugin.json에 선언 금지)
  scripts/                   # hook handlers (Node.js)
    session-start.js
    ...
  templates/                 # 문서/코드 템플릿
  lib/                       # 코어 라이브러리 (bkit team 패턴)
    team/
    state/
  .artibot/                  # 런타임 상태 (.gitignore)
    state.json
    cache/
```

### 7.2 핵심 설계 결정

| Decision | Choice | Rationale |
|----------|--------|-----------|
| plugin.json 스타일 | Pattern B (explicit) | Agent 추적 가능, validator 안전 |
| hooks 선언 | hooks/hooks.json만 (NO plugin.json) | v2.1+ 자동 로드, 중복 방지 |
| 설치 방식 | marketplace + npm CLI | 최대 배포 범위 |
| 설정 관리 | 단일 config.json | bkit 패턴, 중앙 집중 |
| 상태 관리 | .artibot/state.json (atomic writes) | bkit agent-state 패턴 |
| 스킬 frontmatter | bkit 확장 패턴 | agents 맵핑, imports, allowed-tools |
| Hook 스크립트 | 외부 .js 파일 (NOT inline) | 유지보수성, 테스트 가능성 |
| 환경 변수 | `${CLAUDE_PLUGIN_ROOT}` 활용 | 절대 경로 하드코딩 방지 |

### 7.3 구현 우선순위

1. **P0**: plugin.json + marketplace.json (validator 제약사항 준수)
2. **P0**: hooks/hooks.json (SessionStart, PreToolUse, Stop)
3. **P1**: agents/ (explicit file paths, 핵심 에이전트 3-5개)
4. **P1**: skills/ (핵심 스킬 5-10개, bkit frontmatter 패턴)
5. **P1**: artibot.config.json (중앙 설정)
6. **P2**: scripts/ (hook handlers)
7. **P2**: commands/ (사용자 명령어)
8. **P3**: lib/team/ (팀 시스템, SubagentStart/Stop hooks)
9. **P3**: .artibot/state.json (런타임 상태 관리)
10. **P4**: npm CLI installer (cross-platform)
