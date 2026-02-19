# 4개 레포 MCP/스킬/에이전트 패턴 분석 (MCP-dev 관점)

**작성**: mcp-dev | **날짜**: 2026-02-13
**분석 대상**:
1. `ui-ux-pro-max-skill` - UI/UX 디자인 스킬 플러그인
2. `cc-wf-studio` - 워크플로우 스튜디오 (VSCode 확장)
3. `everything-claude-code` - 종합 Claude Code 설정 컬렉션
4. `bkit-claude-code` - PDCA 기반 AI 네이티브 개발 킷

---

## 1. 레포별 구조 비교

### 1.1 plugin.json 패턴 비교

| 레포 | 이름 | 컴포넌트 | 특이점 |
|------|------|---------|-------|
| **ui-ux-pro-max** | `ui-ux-pro-max` | skills만 | description을 Tool Search 키워드로 극대화 |
| **cc-wf-studio** | (플러그인 아님) | commands, skills | VSCode 확장이 주 형태, speckit 명령 체계 |
| **everything-claude-code** | `everything-claude-code` | skills, agents, hooks | 가장 풍부한 컴포넌트 구성 |
| **bkit-claude-code** | `bkit` | outputStyles만(!) | agents, skills, hooks는 기본 경로 자동 탐색 |

### 1.2 MCP 서버 설정 현황

**놀라운 발견: 4개 레포 중 MCP 서버를 번들하는 플러그인이 0개.**

- `.mcp.json` 파일이 존재하는 레포: **0개**
- plugin.json에서 `mcpServers`를 정의한 레포: **0개**
- MCP를 프롬프트에서 참조하는 레포: **bkit만** (bkend MCP 서버 사용 가이드)

**시사점**: 현재 Claude Code 플러그인 생태계에서 MCP 서버 번들링은 아직 미성숙. 대부분의 플러그인이 스킬/에이전트/훅으로 가치를 전달하고, MCP 서버는 사용자가 별도 설치하는 패턴이 지배적.

---

## 2. SKILL.md 구조와 프롬프트 패턴

### 2.1 SKILL.md 프론트매터 비교

| 필드 | ui-ux-pro-max | cc-wf-studio | everything-claude-code | bkit |
|------|--------------|-------------|----------------------|------|
| `name` | O | O | O | O |
| `description` | **매우 긴** (~500자, 키워드 밀집) | 짧은 (~100자) | 짧은 (~150자) | **긴** (~300자, 다국어 트리거) |
| `tools` | X | X | X | X (skills에는 미지정) |
| `model` | X | X | X | X (agents에서만 지정) |
| `hooks` | X | X | X | **O** (PreToolUse, PostToolUse, Stop) |
| `imports` | X | X | X | **O** (`${PLUGIN_ROOT}/templates/...`) |
| `agent` | X | X | X | **O** (연결 에이전트명) |
| `skills` | X | X | X | X (agents에서 참조) |
| `user-invocable` | X | X | X | **O** (true/false) |
| `permissionMode` | X | X | X | **O** (agents에서, `acceptEdits`) |
| `memory` | X | X | X | **O** (agents에서, `project`) |

### 2.2 description 최적화 패턴 (Tool Search용)

**ui-ux-pro-max의 description (우수 사례)**:
```
"UI/UX design intelligence. 50 styles, 21 palettes, 50 font pairings,
20 charts, 9 stacks (React, Next.js, Vue, Svelte...). Actions: plan, build,
create, design, implement, review, fix, improve, optimize, enhance, refactor,
check UI/UX code. Projects: website, landing page, dashboard..."
```

**핵심 패턴**: `{도메인} {수치}. Actions: {동사 나열}. Projects: {명사 나열}. Elements: {구체물 나열}. Styles: {스타일 나열}.`

이 패턴은 **MCP Tool Search**에서 키워드 매칭 정확도를 극대화한다. Tool Search가 도구 설명을 기반으로 검색하므로, description에 가능한 많은 관련 키워드를 포함하면 발견 확률이 높아진다.

**bkit의 다국어 트리거 패턴**:
```
Triggers: team, project lead, architecture decision, CTO,
팀 구성, 프로젝트 리드, 기술 결정, CTO, 팀장,
チームリード, プロジェクト開始, 技術決定,
团队领导, 项目启动, 技术决策,
líder del equipo, decisión técnica...
```

**핵심 패턴**: 8개 언어의 트리거 키워드로 다국어 사용자 지원. 이것도 Tool Search에서 유용.

### 2.3 SKILL.md 본문 패턴

**패턴 A: 검색 도구 연동형 (ui-ux-pro-max)**
- Python 스크립트로 CSV 데이터베이스 검색
- `Step 1: Analyze` -> `Step 2: Generate Design System` -> `Step 3: Supplement` -> `Step 4: Stack Guidelines`
- **장점**: LLM 지식에 의존하지 않고 외부 도구로 정확한 데이터 제공
- **토큰**: ~4K (SKILL.md) + 외부 스크립트 실행 비용

**패턴 B: 워크플로우 체크리스트형 (cc-wf-studio)**
- `## Input` / `## Output` / `## Usage Examples` 형식
- 간결하고 직접적
- **토큰**: ~0.3K (매우 경량)

**패턴 C: 포괄적 도메인 지식형 (everything-claude-code)**
- 코드 패턴, 체크리스트, 안티패턴 나열
- 언어/프레임워크별 특화 스킬 32개(!)
- **토큰**: 스킬당 1~5K (총량이 큼)

**패턴 D: 계층적 조건부 지식형 (bkit)**
- Level (Starter/Dynamic/Enterprise)별 다른 가이드
- Phase (1~9)별 파이프라인 단계 가이드
- 훅으로 자동 행동 트리거
- **토큰**: 스킬당 2~8K

---

## 3. 에이전트 정의 패턴

### 3.1 프론트매터 비교

| 필드 | everything-claude-code | bkit |
|------|----------------------|------|
| `name` | O | O |
| `description` | **짧은** (~200자) | **긴** (~500자, 다국어 트리거 + Do NOT use) |
| `tools` | JSON 배열 `["Read", "Grep"]` | YAML 리스트, `Task(agent-name)` 포함 |
| `model` | `opus`/`sonnet` | `opus`/`sonnet` |
| `permissionMode` | X | `acceptEdits` |
| `memory` | X | `project` |
| `skills` | X | O (연결 스킬 리스트) |

### 3.2 에이전트-스킬-훅 연결 패턴

**bkit의 혁신적 패턴: 에이전트가 스킬을 참조하고, 스킬이 훅을 트리거**

```
cto-lead (agent)
  ├── skills: [pdca, enterprise, bkit-rules]
  ├── tools: [Task(enterprise-expert), Task(infra-architect), ...]
  └── 역할: 팀 오케스트레이션

enterprise-expert (agent)
  ├── skills: [enterprise]
  └── 역할: MSA/K8s 전문가

bkit-rules (skill)
  ├── hooks: [PreToolUse(Write|Edit), PostToolUse(Write)]
  ├── imports: [${PLUGIN_ROOT}/templates/shared/naming-conventions.md]
  └── 역할: 자동 규칙 적용
```

이 3계층 연결은 SuperClaude의 "에이전트/페르소나/스킬 경계 불명확" 문제를 해결하는 모범 사례:
- **에이전트** = 행동 + 위임 (누가 무엇을 하는가)
- **스킬** = 지식 + 자동화 (어떤 규칙/패턴을 적용하는가)
- **훅** = 검증 + 가드레일 (자동으로 무엇을 확인하는가)

### 3.3 에이전트 본문 패턴

**everything-claude-code의 에이전트 패턴**:
```markdown
## Your Role
- {역할 나열}

## Process
### 1. {단계명}
### 2. {단계명}

## Patterns
{도메인 코드 패턴}

## Red Flags
{안티패턴 목록}
```

**bkit의 에이전트 패턴 (더 구조적)**:
```markdown
## Core Responsibilities
1. {책임 1}
2. {책임 2}

## PDCA Role
| Phase | Action |
|-------|--------|

## Technology Stack Focus
- {기술 스택}

## Design Principles
1. {원칙}
```

---

## 4. Hooks 패턴 분석

### 4.1 이벤트 유형 활용 비교

| 이벤트 | everything-claude-code | bkit |
|--------|----------------------|------|
| `SessionStart` | O (컨텍스트 로드) | O (초기화) |
| `SessionEnd` | O (상태 저장, 세션 평가) | X |
| `PreToolUse` | O (Bash 가드, Write 블로커) | O (Write/Edit 검증, Bash 가드) |
| `PostToolUse` | O (PR 로깅, 포매팅, 타입체크) | O (Write 후처리, Bash 후처리, Skill 후처리) |
| `Stop` | O (console.log 감사) | O (통합 정지 처리) |
| `PreCompact` | O (컨텍스트 저장) | O (컨텍스트 압축) |
| `UserPromptSubmit` | X | O (사용자 입력 처리) |
| `TaskCompleted` | X | O (PDCA 태스크 완료) |
| `SubagentStart` | X | O (서브에이전트 시작) |
| `SubagentStop` | X | O (서브에이전트 종료) |
| `TeammateIdle` | X | O (팀메이트 유휴) |

**bkit가 더 많은 이벤트를 활용**: 11개 중 9개 이벤트 사용 (vs everything-claude-code의 6개)

### 4.2 훅 구현 패턴

**everything-claude-code**: 인라인 Node.js 코드 + 외부 스크립트 혼합
```json
{
  "type": "command",
  "command": "node -e \"let d='';process.stdin.on('data',c=>d+=c);...\""
}
```

**bkit**: 모든 훅을 외부 JS 파일로 분리
```json
{
  "type": "command",
  "command": "node ${CLAUDE_PLUGIN_ROOT}/scripts/unified-bash-pre.js",
  "timeout": 5000
}
```

**bkit 패턴이 우수한 이유**:
1. 코드 유지보수성 (인라인 코드 디버깅 불가)
2. `timeout` 명시로 훅 실행 시간 제어
3. `${CLAUDE_PLUGIN_ROOT}` 사용으로 플러그인 이식성 보장
4. 훅 이름의 의미적 명확성 (`unified-bash-pre.js` vs 인라인 코드)

---

## 5. MCP 관련 인사이트

### 5.1 4개 레포의 MCP 활용 현황

| 레포 | MCP 서버 번들 | MCP 참조 | MCP 관련 스킬/에이전트 |
|------|-------------|---------|---------------------|
| ui-ux-pro-max | X | description에 "shadcn/ui MCP" 언급 | X |
| cc-wf-studio | X | MCP 노드 기능 (VSCode 확장) | speckit 명령에서 MCP 노드 처리 |
| everything-claude-code | X | X | `mcp-developer` 에이전트 (미구현) |
| bkit | X | bkend 스킬에서 MCP 설정 가이드 | bkend-quickstart 스킬 |

### 5.2 MCP와 스킬의 관계

**현재 생태계에서 MCP 서버와 스킬은 보완적**:

```
MCP 서버 = 외부 도구/API 연결 (런타임 데이터 제공)
스킬 = 도메인 지식/워크플로우 (프롬프트 컨텍스트 제공)
```

ui-ux-pro-max가 보여주는 패턴:
- SKILL.md에서 Python 스크립트를 Bash로 실행하여 로컬 데이터 검색
- MCP 서버 대신 Bash 도구로 같은 효과를 달성
- **MCP 서버가 필요한 경우**: 외부 API 연동, 인증 필요, 실시간 데이터

### 5.3 cc-wf-studio의 MCP 노드 패턴

cc-wf-studio는 MCP를 워크플로우 노드로 시각화:
```
MCP Server → Tool Discovery → Tool Execution → Result Processing
```

이 패턴은 Artibot 플러그인에서 참고할 수 있는 MCP 오케스트레이션 모델.

---

## 6. 토큰 효율성 전략 비교

### 6.1 레포별 토큰 예산 전략

| 레포 | 총 스킬/에이전트 수 | 예상 총 토큰 | 전략 |
|------|-------------------|------------|------|
| ui-ux-pro-max | 1 스킬 | ~4K | **선택적 로딩**: 필요 시만 검색 도구 실행 |
| cc-wf-studio | 8 commands + 4 skills | ~12K | **명령 기반**: 사용자가 명시적으로 호출 |
| everything-claude-code | 32 skills + 13 agents | ~100K+ | **대량**: Tool Search에 의존 |
| bkit | 26 skills + 17 agents | ~150K+ | **대량**: Tool Search + 계층 선택 |

### 6.2 효율성 패턴

**1. ui-ux-pro-max: "외부 검색 도구" 패턴 (가장 효율적)**
- SKILL.md에 최소한의 규칙만 포함 (~4K)
- 상세 데이터는 CSV에 저장하고 Python으로 검색
- 필요한 정보만 컨텍스트에 추가

**2. bkit: "계층적 조건부 선택" 패턴**
- Level (Starter/Dynamic/Enterprise)에 따라 다른 스킬 활성화
- Phase에 따라 다른 파이프라인 가이드 활성화
- 불필요한 스킬은 로드하지 않음

**3. everything-claude-code: "대량 제공 + Tool Search" 패턴**
- 32개 스킬을 모두 등록하되 Tool Search가 필요 시만 로드
- `pre-compact.js`로 컨텍스트 압축 전 상태 저장
- `suggest-compact.js`로 전략적 압축 시점 제안

---

## 7. Artibot 플러그인 설계 권고 (MCP-dev 관점)

### 7.1 MCP 통합 전략

**권고: 초기에 MCP 서버 번들링 하지 말 것**

근거:
- 4개 레포 모두 MCP 서버를 번들하지 않음 (생태계 표준)
- Context7은 이미 시스템 플러그인으로 제공
- Playwright는 사용자가 별도 설치
- 커스텀 MCP 서버는 실제 필요가 확인된 후 추가

대신 집중할 것:
- **스킬에서 Context7 활용 가이드** 포함 (bkend 스킬처럼)
- **description에 MCP Tool Search 최적화** 키워드 밀집
- **훅에서 MCP 상태 모니터링** (SessionStart에서 MCP 서버 체크)

### 7.2 SKILL.md 설계 권고

**프론트매터 필수 필드**:
```yaml
---
name: skill-name
description: |
  {한줄 설명}. {핵심 기능 키워드 나열}.
  Actions: {동사 나열}. Topics: {주제 나열}.

  Triggers: {영어}, {한국어}, {일본어}, {중국어}

  Do NOT use for: {제외 조건}
hooks:
  PreToolUse:
    - matcher: "Write|Edit"
      hooks:
        - type: command
          command: "node ${CLAUDE_PLUGIN_ROOT}/scripts/pre-check.js"
          timeout: 5000
---
```

**description 최적화 규칙**:
1. 첫 문장은 핵심 기능 요약 (Tool Search 스니펫)
2. `Actions:` 블록으로 동사 키워드 나열
3. `Triggers:` 블록으로 다국어 키워드 (최소 한국어 + 영어)
4. `Do NOT use for:` 블록으로 부적절한 활성화 방지

### 7.3 에이전트 설계 권고

**프론트매터 필수 필드** (bkit 패턴 채택):
```yaml
---
name: agent-name
description: |
  {역할 설명}. {사용 시점}.

  Triggers: {영어 키워드}, {한국어 키워드}

  Do NOT use for: {제외 조건}
permissionMode: acceptEdits
memory: project
model: sonnet  # 기본값, 복잡한 추론 필요 시 opus
tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
  - Task(sub-agent-name)  # 필요 시
skills:
  - related-skill-name
---
```

**에이전트-스킬 연결 규칙**:
- 에이전트는 `skills:` 필드로 관련 스킬 참조
- 스킬은 `agent:` 필드로 기본 에이전트 참조
- 훅은 `hooks.json`에서 중앙 관리 (스킬 프론트매터 훅 대비 안정성 높음)

### 7.4 Hooks 설계 권고

**hooks.json 구조** (bkit 패턴 채택):
```json
{
  "$schema": "https://json.schemastore.org/claude-code-hooks.json",
  "hooks": {
    "SessionStart": [{ "once": true, "hooks": [{ "type": "command", "command": "node ${CLAUDE_PLUGIN_ROOT}/scripts/init.js", "timeout": 5000 }] }],
    "PreToolUse": [{ "matcher": "Write|Edit", "hooks": [{ "type": "command", "command": "node ${CLAUDE_PLUGIN_ROOT}/scripts/pre-write.js", "timeout": 5000 }] }],
    "PostToolUse": [{ "matcher": "Write", "hooks": [{ "type": "command", "command": "node ${CLAUDE_PLUGIN_ROOT}/scripts/post-write.js", "timeout": 5000 }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "node ${CLAUDE_PLUGIN_ROOT}/scripts/stop.js", "timeout": 10000 }] }],
    "PreCompact": [{ "hooks": [{ "type": "command", "command": "node ${CLAUDE_PLUGIN_ROOT}/scripts/pre-compact.js", "timeout": 5000 }] }]
  }
}
```

**필수 훅**:
- `SessionStart`: 프로젝트 컨텍스트 로드, 환경 감지
- `PreToolUse(Write|Edit)`: 코드 품질 사전 검증
- `PostToolUse(Write)`: 포매팅, 타입체크
- `Stop`: 세션 상태 저장
- `PreCompact`: 압축 전 중요 컨텍스트 보존

**규칙**:
- 모든 훅은 외부 JS 파일로 분리 (인라인 코드 금지)
- 모든 훅에 `timeout` 설정 (기본 5000ms)
- `${CLAUDE_PLUGIN_ROOT}` 경로 변수 필수 사용

### 7.5 토큰 효율성 전략

1. **description 키워드 밀집** (Tool Search 최적화)
2. **외부 데이터 저장** (스킬 내 대용량 데이터 대신 스크립트 검색)
3. **계층적 조건부 로딩** (프로젝트 레벨에 따라 다른 스킬 세트)
4. **전략적 압축 훅** (PreCompact에서 핵심 컨텍스트 보존)

---

## 8. PROMPT-ANALYSIS.md 결과와의 통합

PROMPT-ANALYSIS.md에서 식별된 문제와 4개 레포 패턴의 해결 매핑:

| PROMPT-ANALYSIS 문제 | 해결 패턴 | 레퍼런스 레포 |
|---------------------|----------|------------|
| Communication Protocol 반복 (~8.8K) | 완전 제거 | 4개 레포 모두 미사용 |
| Integration with agents 반복 (~6.2K) | `skills:` 프론트매터로 대체 | bkit |
| Progress tracking JSON (~3.5K) | 훅 기반 자동 추적으로 대체 | bkit (TaskCompleted 훅) |
| 에이전트/페르소나/스킬 경계 불명확 | 3계층 분리: 에이전트=행동, 스킬=지식, 페르소나=관점 | bkit |
| 품질 양극화 (A vs C/D) | 템플릿 표준화 + DO/DON'T 패턴 | everything-claude-code |
| 33개 에이전트 과다 | 핵심 13~17개로 축소, 나머지는 스킬로 이관 | bkit (17), ecc (13) |
| MCP 서버 과잉 설계 | MCP 서버 번들 없이 시작, 필요 시 추가 | 4개 레포 모두 |

---

## 9. 참고: 레포별 핵심 파일 위치

### ui-ux-pro-max-skill
- Plugin: `.claude-plugin/plugin.json`
- SKILL: `.claude/skills/ui-ux-pro-max/SKILL.md` (4K, 검색 도구 통합)

### cc-wf-studio
- Commands: `.claude/commands/speckit.*.md` (8개 명령)
- Skills: `.claude/skills/code-review*/SKILL.md` (4개)
- Templates: `.specify/templates/*.md`

### everything-claude-code
- Plugin: `.claude-plugin/plugin.json`
- Agents: `agents/*.md` (13개, A-B등급 품질)
- Skills: `.cursor/skills/*/SKILL.md` (32개)
- Hooks: `hooks/hooks.json` (6개 이벤트)
- Rules: `.cursor/rules/*.md` (12개)

### bkit-claude-code
- Plugin: `.claude-plugin/plugin.json`
- Agents: `agents/*.md` (17개, CTO-Led 팀 구조)
- Skills: `skills/*/SKILL.md` (26개, 계층적 파이프라인)
- Hooks: `hooks/hooks.json` (9개 이벤트)
- Output Styles: `output-styles/*.md` (4개)
- Templates: `templates/*.template.md`
- Scripts: `scripts/*.js` (훅 실행 스크립트)
