# Artibot

![Tests](https://img.shields.io/badge/tests-874%20passed-brightgreen) ![Coverage](https://img.shields.io/badge/coverage-90.92%25-brightgreen) ![Dependencies](https://img.shields.io/badge/dependencies-0-blue) ![Node](https://img.shields.io/badge/node-%3E%3D18-green) ![License](https://img.shields.io/badge/license-MIT-blue)

Claude Code를 위한 **Agent Teams 기반** 지능형 오케스트레이션 플러그인. Claude의 네이티브 Agent Teams API를 핵심 엔진으로 사용하여 전문 에이전트 팀 구성, P2P 통신, 공유 태스크 관리를 통해 개발 생산성을 극대화합니다.

## 목차

- [핵심 특징](#핵심-특징)
- [설치](#설치)
- [크로스 플랫폼 설치 가이드](#크로스-플랫폼-설치-가이드)
- [빠른 시작](#빠른-시작)
- [Agent Teams 아키텍처](#agent-teams-아키텍처)
- [인지 아키텍처 (Cognitive + Learning)](#인지-아키텍처-cognitive--learning)
- [커맨드 레퍼런스](#커맨드-레퍼런스)
- [자동 업데이트](#자동-업데이트)
- [에이전트 시스템](#에이전트-시스템)
- [스킬 시스템](#스킬-시스템)
- [훅 시스템](#훅-시스템)
- [MCP 통합](#mcp-통합)
- [설정](#설정)
- [디렉토리 구조](#디렉토리-구조)

---

## 핵심 특징

### Claude Agent Teams API 네이티브 통합

Artibot의 핵심 엔진은 Claude Code의 **Agent Teams API**입니다. 단순한 서브에이전트(Task) 패턴이 아닌, 진정한 팀 오케스트레이션을 제공합니다.

| 기능 | 서브에이전트 (기존) | Agent Teams (Artibot) |
|------|---------------------|----------------------|
| 통신 | 부모에게만 결과 반환 | P2P 양방향 메시징 (SendMessage) |
| 태스크 관리 | 부모가 전체 관리 | 공유 태스크 리스트 (TaskCreate/TaskList) |
| 자기 할당 | 불가 | 팀원이 스스로 태스크 선택 (TaskUpdate) |
| 팀원간 소통 | 불가 | 직접 DM + 브로드캐스트 |
| 계획 승인 | 불가 | plan_approval_response |
| 생명주기 | 일회성 | 생성 → 작업 → 종료 → 정리 |

**사용하는 Agent Teams API 도구:**
- `TeamCreate` - 팀 생성
- `SendMessage` - DM, 브로드캐스트, 셧다운 요청/응답, 계획 승인
- `TaskCreate` / `TaskUpdate` / `TaskList` / `TaskGet` - 공유 태스크 관리
- `Task(type, team_name, name)` - 팀원 스폰
- `TeamDelete` - 팀 리소스 정리

### CTO-Led 팀 오케스트레이션

- **orchestrator** 에이전트가 팀 리더(CTO)로서 25개 전문 에이전트를 팀으로 구성
- Delegation 모드: 리더는 조율만 담당, 직접 코드 작성 안함
- 5가지 오케스트레이션 패턴: Leader, Council, Swarm, Pipeline, Watchdog
- 3단계 팀 규모: Solo(0명), Squad(3명), Platoon(5명)
- 8가지 플레이북: feature, bugfix, refactor, security + 4 marketing

### 지능형 위임 모드 선택

복잡도에 따라 **Sub-Agent** vs **Agent Team** 자동 선택:
- **Sub-Agent Mode** (score < 0.6): 단순 작업. Task() 단방향 위임
- **Agent Team Mode** (score >= 0.6): 복잡 작업. TeamCreate → P2P 협업

### 38개 슬래시 커맨드

- `/sc`로 자연어 의도를 분석하여 최적 커맨드로 자동 라우팅
- 개발, 분석, 품질, 테스트, 문서화, 배포, 마케팅 전 영역 커버

### 77개 도메인 스킬

- 11개 페르소나 스킬 (architect, frontend, backend, security 등)
- 6개 코어 스킬 (orchestration, principles, coding/security/testing standards)
- 8개 유틸리티 스킬 (git-workflow, tdd, delegation, MCP 연동 등)
- 16개 언어 스킬 (TypeScript, Python, Go, Rust, Java 등)
- 23개 마케팅 스킬 (SEO, CRO, A/B 테스트, 이메일 마케팅 등)
- 13개 기타 스킬 (cognitive-routing, platform, library, quality 등)

### 지능형 훅 시스템

- 14개 이벤트에 16개 자동화 스크립트
- 위험 명령 차단, 민감 파일 보호, 자동 포맷, PR 감지, 팀원 생명주기 추적

### Zero External Dependencies

- Node.js 내장 모듈만 사용 (`node:fs`, `node:path`, `node:os`)

---

## 설치

### 사전 요구사항

**Agent Teams 활성화** (필수):
```json
// ~/.claude/settings.json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  }
}
```

### Claude Code Marketplace (권장)
```bash
claude plugin install artibot
```

### 수동 설치
```bash
git clone https://github.com/Yoodaddy0311/artibot.git
cd artibot
claude plugin install ./plugins/artibot
```

### 요구사항
- Claude Code CLI
- Node.js >= 18.0.0
- `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` 환경 변수

---

## 크로스 플랫폼 설치 가이드

Artibot은 Claude Code 외에도 **Gemini CLI**, **OpenAI Codex CLI**, **Cursor IDE**, **Google Antigravity**를 지원합니다. 내장 어댑터가 스킬/에이전트/커맨드를 각 플랫폼 형식으로 자동 변환합니다.

> 아래 예제에서 `<your-project>`는 Artibot을 적용할 대상 프로젝트의 루트 디렉토리 경로입니다.

### 플랫폼별 기능 지원 현황

| 기능 | Claude Code | Gemini CLI | Codex CLI | Cursor IDE | Antigravity |
|------|:-----------:|:----------:|:---------:|:----------:|:-----------:|
| **호환성 점수** | 10/10 | 9/10 | 8/10 | 6/10 | 8/10 |
| Agent Teams (P2P 메시징) | ✅ | ❌ | ❌ | ❌ | ❌ |
| Sub-Agent (단방향 위임) | ✅ | ✅ | ✅ | ⚠️ 제한적 | ✅ |
| 25개 전문 에이전트 | ✅ | ✅ 자동변환 | ✅ 자동변환 | ✅ 자동변환 | ✅ 자동변환 |
| 77개 스킬 (SKILL.md) | ✅ | ✅ | ✅ | ✅ | ✅ |
| 슬래시 커맨드 | ✅ 38개 | ✅ TOML | → Workflows | → Prompts | → Workflows |
| Hooks 자동작동 | ✅ 14이벤트 | ✅ 동일패턴 | ⚠️ 제한적 | ❌ | ✅ Agent Manager |
| 인지 라우터 (System 1/2) | ✅ | ✅ | ✅ | ✅ | ✅ |
| 자가학습 (GRPO) | ✅ | ✅ | ✅ | ✅ | ✅ |
| 메모리 (3-scope) | ✅ | ✅ | ✅ | ✅ | ✅ |
| 집단지성 (Swarm) | ✅ | ✅ | ✅ | ✅ | ✅ |
| MCP: Context7 | ✅ 자동 | ⚠️ 수동설정 | ⚠️ 제한적 | ⚠️ 수동설정 | ⚠️ 수동설정 |
| MCP: Playwright | ✅ 자동 | ⚠️ 수동설정 | ⚠️ 제한적 | ⚠️ 수동설정 | ⚠️ 수동설정 |

> **참고**: Agent Teams API는 Claude Code 전용 실험적 기능입니다. 다른 플랫폼에서는 Sub-Agent 모드(단방향 위임)로 자동 폴백됩니다. 학습/메모리/집단지성은 Node.js 내장 모듈만 사용하므로 모든 플랫폼에서 동일하게 작동합니다.

### Gemini CLI 설치 (호환성: 9/10)

Gemini CLI는 Claude Code와 가장 유사한 구조를 가집니다.

**변환 매핑:**
| Artibot 원본 | Gemini CLI 변환 결과 |
|---|---|
| `CLAUDE.md` | `GEMINI.md` |
| `plugin.json` | `gemini-extension.json` |
| `commands/*.md` | `commands/*.toml` (TOML 형식) |
| `skills/*/SKILL.md` | `.agent/skills/*/SKILL.md` (직접 호환) |
| `agents/*.md` | `agents/*.md` (Agent Teams 참조 제거) |
| `hooks/hooks.json` | `hooks/hooks.json` (동일 패턴) |

**설치 단계:**

```bash
# 1. Artibot 저장소 클론
git clone https://github.com/Yoodaddy0311/artibot.git
cd artibot

# 2. Gemini CLI용 내보내기 (Node.js >= 18 필요)
node --input-type=module -e "
  import { exportForGemini } from './plugins/artibot/lib/core/skill-exporter.js';
  const result = await exportForGemini({ pluginRoot: './plugins/artibot' });
  console.log('Files:', result.files.length, '| Warnings:', result.warnings.length);
  // result.files 배열의 각 { path, content }를 프로젝트에 저장
"

# 3. 내보낸 파일을 프로젝트에 복사
# - GEMINI.md → 프로젝트 루트 또는 ~/.gemini/
# - gemini-extension.json → 프로젝트 루트
# - .agent/skills/ → 내보낸 .agent/skills/ 내용을 프로젝트 루트의 .agent/skills/에 복사
# - agents/ → 에이전트 정의
# - commands/*.toml → 커맨드 정의

# 4. lib/ 디렉토리 복사 (인지/학습/스웜 엔진)
cp -r plugins/artibot/lib/ <your-project>/.agent/lib/
cp plugins/artibot/artibot.config.json <your-project>/.agent/
```

**Gemini CLI 환경에서의 차이점:**
- **슬래시 커맨드**: Markdown 대신 TOML 형식으로 변환됨
- **Agent Teams**: 사용 불가 → Sub-Agent 모드로 자동 폴백
- **Hooks**: 동일한 JSON 패턴 지원, 이벤트명도 호환
- **MCP 서버**: Gemini CLI 설정에서 별도로 Context7/Playwright 구성 필요

### OpenAI Codex CLI 설치 (호환성: 8/10)

Codex CLI는 SKILL.md 형식의 원조 플랫폼으로, 스킬 호환성이 높습니다.

**변환 매핑:**
| Artibot 원본 | Codex CLI 변환 결과 |
|---|---|
| `CLAUDE.md` | `AGENTS.md` (통합 인스트럭션) |
| `plugin.json` | `agents/openai.yaml` |
| `commands/*.md` | `.agents/skills/cmd-*/SKILL.md` (Workflow) |
| `skills/*/SKILL.md` | `.agents/skills/*/SKILL.md` (직접 호환) |
| `agents/*.md` | `AGENTS.md` 내 섹션으로 통합 |

**설치 단계:**

```bash
# 1. Artibot 저장소 클론
git clone https://github.com/Yoodaddy0311/artibot.git
cd artibot

# 2. Codex CLI용 내보내기
node --input-type=module -e "
  import { exportForCodex } from './plugins/artibot/lib/core/skill-exporter.js';
  const result = await exportForCodex({ pluginRoot: './plugins/artibot' });
  console.log('Files:', result.files.length, '| Warnings:', result.warnings.length);
"

# 3. 내보낸 파일을 프로젝트에 복사
# - AGENTS.md → 프로젝트 루트
# - agents/openai.yaml → 에이전트 메타데이터
# - .agents/skills/ → 스킬 + 커맨드 워크플로우

# 4. lib/ 디렉토리 복사
cp -r plugins/artibot/lib/ <your-project>/.agents/lib/
cp plugins/artibot/artibot.config.json <your-project>/.agents/
```

**Codex CLI 환경에서의 차이점:**
- **에이전트**: 개별 `.md` 파일 대신 `AGENTS.md` 하나로 통합
- **슬래시 커맨드**: 없음 → SKILL.md 기반 Workflow로 변환
- **Agent Teams**: 사용 불가 → Sub-Agent 모드로 자동 폴백
- **MCP 서버**: 제한적 지원, 수동 구성 필요

### Cursor IDE 설치 (호환성: 6/10)

Cursor IDE는 구조적 차이가 크지만, 스킬과 인지 엔진은 완전히 작동합니다.

**변환 매핑:**
| Artibot 원본 | Cursor IDE 변환 결과 |
|---|---|
| `CLAUDE.md` | `.cursorrules` (플레인 텍스트 룰) |
| `agents/*.md` | `.cursor/modes.json` (JSON 모드 엔트리) |
| `commands/*.md` | `.cursor/prompts/*.md` (커스텀 프롬프트) |
| `skills/*/SKILL.md` | `.cursor/skills/*/SKILL.md` |

**설치 단계:**

```bash
# 1. Artibot 저장소 클론
git clone https://github.com/Yoodaddy0311/artibot.git
cd artibot

# 2. Cursor용 내보내기
node --input-type=module -e "
  import { exportForCursor } from './plugins/artibot/lib/core/skill-exporter.js';
  const result = await exportForCursor({ pluginRoot: './plugins/artibot' });
  console.log('Files:', result.files.length, '| Warnings:', result.warnings.length);
"

# 3. 내보낸 파일을 프로젝트에 복사
# - .cursorrules → 프로젝트 루트
# - .cursor/modes.json → 에이전트를 Cursor 모드로
# - .cursor/prompts/*.md → 커맨드를 커스텀 프롬프트로
# - .cursor/skills/ → 스킬 디렉토리

# 4. lib/ 디렉토리 복사
cp -r plugins/artibot/lib/ <your-project>/.cursor/lib/
cp plugins/artibot/artibot.config.json <your-project>/.cursor/
```

**Cursor IDE 환경에서의 차이점:**
- **슬래시 커맨드**: 없음 → `.cursor/prompts/` 커스텀 프롬프트로 변환
- **에이전트**: `modes.json`으로 변환, 각 에이전트가 Cursor "모드"가 됨
- **Hooks**: 지원 안 됨 → 인지 라우터가 프롬프트 내에서 인라인 동작
- **Agent Teams**: 사용 불가, Sub-Agent도 제한적 → 주로 직접 실행 모드

### Google Antigravity 설치 (호환성: 8/10)

Antigravity는 Gemini CLI 생태계를 공유하며, Agent Manager를 통한 병렬 오케스트레이션이 특징입니다.

**변환 매핑:**
| Artibot 원본 | Antigravity 변환 결과 |
|---|---|
| `CLAUDE.md` | `.antigravity/rules.md` + `~/.gemini/GEMINI.md` |
| `agents/*.md` | `.antigravity/agents/*.md` (Agent Manager용) |
| `commands/*.md` | `.antigravity/workflows/*.md` (워크플로우) |
| `skills/*/SKILL.md` | `.antigravity/skills/*/SKILL.md` (직접 호환) |

**설치 단계:**

```bash
# 1. Artibot 저장소 클론
git clone https://github.com/Yoodaddy0311/artibot.git
cd artibot

# 2. Antigravity용 내보내기 (현재 수동 변환)
# Antigravity 어댑터는 skill-exporter에 아직 통합되지 않았습니다.
# Gemini CLI 내보내기를 기반으로 수동 조정하세요:
node --input-type=module -e "
  import { exportForGemini } from './plugins/artibot/lib/core/skill-exporter.js';
  const result = await exportForGemini({ pluginRoot: './plugins/artibot' });
  console.log('Files:', result.files.length, '| Warnings:', result.warnings.length);
"

# 3. 디렉토리 구조 변환
mkdir -p <your-project>/.antigravity/{agents,skills,workflows}

# Gemini 내보내기 결과를 Antigravity 구조로 이동:
# - .agent/skills/ → .antigravity/skills/
# - agents/ → .antigravity/agents/
# - GEMINI.md → .antigravity/rules.md (+ ~/.gemini/GEMINI.md 글로벌 룰)

# 4. lib/ 디렉토리 복사
cp -r plugins/artibot/lib/ <your-project>/.antigravity/lib/
cp plugins/artibot/artibot.config.json <your-project>/.antigravity/
```

**Antigravity 환경에서의 차이점:**
- **Agent Manager**: Agent Teams API 대신 Antigravity의 Agent Manager로 병렬 오케스트레이션
- **글로벌 룰**: `~/.gemini/GEMINI.md`와 `.antigravity/rules.md` 이중 룰 시스템
- **Cursor 호환**: `.cursorrules`도 읽을 수 있음 (크로스 호환)
- **다중 모델**: Gemini 3 Pro, Claude, GPT 등 여러 AI 모델 지원

### 모든 플랫폼 일괄 내보내기

4개 플랫폼(gemini-cli, codex-cli, cursor, antigravity) 형식으로 일괄 변환합니다.

```bash
node --input-type=module -e "
  import { exportForAll } from './plugins/artibot/lib/core/skill-exporter.js';
  const results = await exportForAll({ pluginRoot: './plugins/artibot' });
  for (const [platform, result] of Object.entries(results)) {
    console.log(platform + ':', result.files.length, 'files,', result.warnings.length, 'warnings');
  }
"
```

### MCP 서버 수동 설정 (Claude Code 외 플랫폼)

Claude Code에서는 `.mcp.json`으로 자동 구성되지만, 다른 플랫폼에서는 수동 설정이 필요합니다.

**Context7** (라이브러리 문서 조회):
```bash
# 전역 설치
npm install -g @upstash/context7-mcp@latest

# 또는 프로젝트별 npx 사용
npx -y @upstash/context7-mcp@latest
```

**Playwright** (E2E 테스트):
```bash
npm install -g @executeautomation/playwright-mcp-server

# Playwright 브라우저도 설치 필요
npx playwright install
```

**Gemini CLI MCP 설정 예시:**
```json
// ~/.gemini/settings.json 또는 프로젝트 .gemini/settings.json
{
  "mcpServers": {
    "context7": {
      "command": "npx",
      "args": ["-y", "@upstash/context7-mcp@latest"]
    }
  }
}
```

Cursor, Codex CLI 등은 각 플랫폼의 MCP 설정 문서를 참고하세요.

### Graceful Degradation (단계적 기능 축소)

Artibot은 환경에 따라 자동으로 최적의 모드를 선택합니다:

```
Agent Teams (Full P2P)  →  Sub-Agent (단방향)  →  Direct (직접 실행)
  Claude Code + env var       모든 플랫폼            도구 제한 환경

감지 순서:
1. CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 → Agent Teams 모드
2. Task() 도구 사용 가능 → Sub-Agent 모드
3. 도구 없음 → Direct 모드 (오케스트레이터가 직접 실행)
```

---

## 빠른 시작

### 0. 5분 시작 가이드

```bash
# Step 1: Agent Teams 활성화 (~/.claude/settings.json)
echo '{"env":{"CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS":"1"}}' > ~/.claude/settings.json

# Step 2: 플러그인 설치
claude plugin install artibot

# Step 3: 검증
node ~/.claude/plugins/artibot/scripts/validate.js

# Step 4: 첫 번째 명령 실행
/sc 로그인 기능 구현해줘
```

### 1. 자동 라우팅

```
/sc 로그인 기능을 구현해줘
→ /implement로 라우팅 → TeamCreate → planner + architect + developer + reviewer 팀 구성
```

```
/sc 이 코드의 보안 취약점을 분석해줘
→ /analyze --focus security → security-reviewer 서브에이전트 위임 (단순 작업)
```

### 2. 직접 커맨드

```
/implement 사용자 인증 API --type api --tdd
/code-review @src/auth/
/test --coverage
/git commit
```

### 3. 팀 오케스트레이션

복잡한 작업에는 Agent Teams를 활용합니다:

```
/orchestrate 결제 시스템 구현 --pattern feature
→ TeamCreate("payment-feature")
→ Task(planner, team_name, "planner") + Task(architect, team_name, "architect") + ...
→ TaskCreate per phase (plan → design → implement → review)
→ TaskUpdate로 의존성 설정 + 팀원 할당
→ SendMessage로 팀원간 조율
→ shutdown_request → TeamDelete
```

### 4. 팀 스폰 (병렬 작업)

```
/spawn 전체 코드베이스 보안 감사 --mode parallel --agents 5
→ TeamCreate("security-audit")
→ 5명 팀원 스폰 (각 디렉토리 담당)
→ 팀원이 TaskList에서 자기 할당 (self-claim)
→ SendMessage로 발견 사항 공유
→ 리더가 결과 종합
```

---

## Agent Teams 아키텍처

```
┌──────────────────────────────────────────────────────┐
│                     사용자 요청                         │
└──────────────┬───────────────────────────────────────┘
               ▼
┌──────────────────────────────────────────────────────┐
│            /sc 라우터 (의도 분석)                        │
│     keyword 40% + context 40% + flags 20%            │
└──────────────┬───────────────────────────────────────┘
               ▼
┌──────────────────────────────────────────────────────┐
│        위임 모드 선택 (complexity scoring)               │
│   score < 0.6 → Sub-Agent    score >= 0.6 → Team     │
└──────┬───────────────────────────────┬───────────────┘
       ▼                               ▼
┌──────────────┐            ┌──────────────────────────┐
│  Sub-Agent   │            │   Agent Teams Engine      │
│  Task() 위임  │            │                          │
│  결과 반환     │            │  TeamCreate              │
│              │            │    ↓                      │
│              │            │  Task(type, team, name)   │
│              │            │    ↓                      │
│              │            │  TaskCreate + TaskUpdate  │
│              │            │    ↓                      │
│              │            │  SendMessage (P2P)        │
│              │            │    ↓                      │
│              │            │  shutdown + TeamDelete    │
└──────────────┘            └──────────────────────────┘
                                       ▼
                            ┌──────────────────────────┐
                            │   orchestrator (CTO)      │
                            │  Leader|Council|Swarm|    │
                            │  Pipeline|Watchdog        │
                            └──────────┬───────────────┘
                                       ▼
                            ┌──────────────────────────┐
                            │   25개 전문 에이전트 (팀원)   │
                            │  TaskList → 자기할당        │
                            │  SendMessage → P2P 소통    │
                            │  TaskUpdate → 완료 보고     │
                            └──────────────────────────┘
```

### 역할 분리 원칙

| 계층 | 역할 | Agent Teams API |
|------|------|----------------|
| **Commands** | 인터페이스 (사용자 진입점) | TeamCreate 트리거 |
| **Agents** | 행동 (자율 실행 단위) | 팀원: SendMessage + TaskUpdate |
| **Skills** | 지식 (도메인 전문성) | 위임 모드 결정 기준 |
| **Hooks** | 자동화 (이벤트 반응) | SubagentStart/Stop, TeammateIdle |

### 팀 생명주기

```
1. TeamCreate(team_name, description)
2. Task(subagent_type, team_name, name) × N  -- 팀원 스폰
3. TaskCreate(subject, description, activeForm) × M  -- 태스크 생성
4. TaskUpdate(taskId, addBlockedBy)  -- 의존성 설정
5. TaskUpdate(taskId, owner)  -- 팀원 할당 (또는 self-claim)
6. [팀원 작업 수행]
   - TaskGet → 태스크 상세 확인
   - TaskUpdate(status: "in_progress") → 작업 시작
   - SendMessage(type: "message") → 리더/동료에게 보고
   - TaskUpdate(status: "completed") → 완료
7. SendMessage(type: "shutdown_request") × N  -- 종료 요청
8. TeamDelete  -- 팀 리소스 정리
```

### 오케스트레이션 패턴

| 패턴 | 용도 | Team API 구현 |
|------|------|---------------|
| **Leader** | 계획, 의사결정 | TaskCreate → TaskUpdate(owner) → collect results |
| **Council** | 설계, 검증 | 복수 팀원 → SendMessage로 토론 → 리더 결정 |
| **Swarm** | 대규모 구현 | TaskCreate(no blockedBy) → 팀원 self-claim from TaskList |
| **Pipeline** | 순차 의존성 | TaskCreate(addBlockedBy) → 자동 언블로킹 |
| **Watchdog** | 지속 모니터링 | 별도 팀원이 주기적 TaskList 확인 + SendMessage 알림 |

### 팀 레벨

| 레벨 | 모드 | 에이전트 수 | 적용 상황 |
|------|------|------------|-----------|
| **Solo** | Sub-Agent | 0 | 단일 파일 수정, 간단한 질문 |
| **Squad** | Agent Team | 최대 3 | 기능 구현, 버그 수정, 리팩토링 |
| **Platoon** | Agent Team | 최대 5 | 대규모 기능, 아키텍처 변경, 보안 감사 |

### 플레이북

#### Feature (기능 구현)
```
TeamCreate → [Leader] plan → [Council] design → [Swarm] implement → [Council] review → [Leader] merge → TeamDelete
```

#### Bugfix (버그 수정)
```
TeamCreate → [Leader] analyze → [Pipeline] fix → [Council] verify → TeamDelete
```

#### Refactor (리팩토링)
```
TeamCreate → [Council] assess → [Pipeline] refactor → [Swarm] test → [Council] review → TeamDelete
```

#### Security (보안 감사)
```
TeamCreate → [Leader] scan → [Council] assess → [Pipeline] fix → [Council] verify → TeamDelete
```

### 품질 게이트

| 게이트 | 위치 | 통과 기준 | 검증 방법 |
|--------|------|-----------|-----------|
| Scope Lock | 분석 → 계획 | 요구사항 명확, 범위 문서화 | TaskGet으로 deliverable 확인 |
| Design Approval | 계획 → 구현 | 아키텍처 리뷰 완료 | plan_approval_response |
| Build Pass | 구현 → 리뷰 | 컴파일 성공, 타입 오류 없음 | 팀원 Bash 실행 결과 |
| Review Clear | 리뷰 → 테스트 | CRITICAL/HIGH 이슈 해결 | SendMessage 보고 확인 |
| Test Pass | 테스트 → 배포 | 커버리지 >= 80%, 회귀 없음 | 팀원 결과 TaskUpdate |

---

## 인지 아키텍처 (Cognitive + Learning)

Artibot v1.3+부터 Kahneman의 이중 처리 이론에서 영감을 받은 인지 아키텍처가 추가되었습니다.

### 이중 처리 인지 시스템

```
사용자 요청
    ↓
Cognitive Router (threshold: 0.4)
    ├── confidence >= 0.6 → System 1 (빠른 직관 처리, <100ms)
    │       → 패턴 매칭 → 즉시 응답
    └── confidence < 0.6 → System 2 (심층 분석 처리)
            → Sandbox 평가 → 최대 3회 재시도 → 정밀 응답
```

| 시스템 | 방식 | 최대 지연 | 적용 상황 |
|--------|------|-----------|-----------|
| **System 1** | 직관적, 패턴 기반 | 100ms | 반복 작업, 명확한 의도 |
| **System 2** | 분석적, 샌드박스 | 제한 없음 | 복잡한 추론, 불확실한 의도 |

### 지속 학습 시스템

```
세션 종료 → Self Evaluator (응답 품질 평가)
    ↓
GRPO Optimizer (그룹 상대 정책 최적화)
    ↓
Knowledge Transfer (메모리 스코프 간 승격/강등)
    │   promotionThreshold: 3회 성공 → user 스코프로 승격
    │   demotionThreshold: 2회 실패 → 강등
    ↓
Memory Manager
    ├── user:    ~/.claude/artibot/     (영구, 모든 프로젝트)
    ├── project: .artibot/              (프로젝트별)
    └── session: 인메모리               (세션 종료 시 초기화)
```

### 개인정보 보호 (Privacy Architecture)

연합 학습(Federated Swarm)에서 패턴을 공유할 때 자동으로 PII가 제거됩니다:

```
학습 데이터
    ↓
PII Scrubber (50+ 정규식 패턴)
    → 경로, API 키, 이메일, IP, 신용카드 등 자동 마스킹
    ↓
차분 프라이버시 노이즈 추가
    ↓
Federated Swarm 서버 (옵트인 필요)
```

모든 학습 데이터는 기본적으로 로컬에만 저장됩니다. 텔레메트리는 명시적 옵트인 없이는 수집되지 않습니다.

---

## 커맨드 레퍼런스

### 개발 커맨드

| 커맨드 | 설명 | 주요 옵션 |
|--------|------|-----------|
| `/sc [request]` | 자동 라우팅 엔트리포인트 | `--plan`, `--force [cmd]` |
| `/build [target]` | 프로젝트 빌드 (프레임워크 자동 감지) | `--optimize` |
| `/build-fix` | 빌드 오류 자동 진단/수정 | `--max-retries [n]` |
| `/implement [feature]` | 기능 구현 파이프라인 | `--type`, `--tdd`, `--framework` |
| `/improve [target]` | 증거 기반 코드 개선 | `--focus`, `--loop` |
| `/design [domain]` | 시스템 설계 | `--adr` |

### 분석/디버깅 커맨드

| 커맨드 | 설명 | 주요 옵션 |
|--------|------|-----------|
| `/analyze [target]` | 다차원 코드/시스템 분석 | `--focus [domain]`, `--scope` |
| `/troubleshoot [symptoms]` | 근본 원인 분석 | `--hypothesis` |
| `/explain [topic]` | 교육적 설명 | `--depth`, `--examples` |

### 품질 커맨드

| 커맨드 | 설명 | 주요 옵션 |
|--------|------|-----------|
| `/code-review [target]` | 코드 리뷰 (CRITICAL/HIGH/MEDIUM/LOW) | `--strict` |
| `/test [type]` | 테스트 실행 (러너 자동 감지) | `--coverage`, `--e2e` |
| `/tdd [feature]` | TDD 워크플로우 (RED→GREEN→REFACTOR) | `--coverage [n]` |
| `/verify` | 검증 파이프라인 (lint→type→test→build) | `--quick`, `--fix` |
| `/refactor-clean [target]` | 리팩토링/데드 코드 제거 | `--type [kind]` |

### 팀 오케스트레이션 커맨드

| 커맨드 | 설명 | 주요 옵션 |
|--------|------|-----------|
| `/orchestrate [workflow]` | Agent Teams 기반 멀티 에이전트 워크플로우 | `--pattern`, `--parallel` |
| `/spawn [mode]` | 팀 스폰 및 병렬 태스크 실행 | `--agents [n]`, `--mode` |

### 워크플로우 커맨드

| 커맨드 | 설명 | 주요 옵션 |
|--------|------|-----------|
| `/plan [feature]` | 구현 계획 수립 | `--phases`, `--risks` |
| `/task [operation]` | 태스크 관리 (CRUD) | `create`, `list`, `update` |
| `/git [operation]` | Git 워크플로우 | `commit`, `pr`, `branch` |
| `/checkpoint` | 상태 스냅샷 저장/복원 | `save`, `restore`, `list` |

### 문서/콘텐츠 커맨드

| 커맨드 | 설명 | 주요 옵션 |
|--------|------|-----------|
| `/document [target]` | 문서 생성 | `--type [api\|guide\|readme]` |
| `/content [type]` | 콘텐츠 마케팅 | `--blog`, `--social`, `--seo` |
| `/learn [pattern]` | 패턴 학습 및 메모리 저장 | `--scan`, `--category` |

### 마케팅 커맨드

| 커맨드 | 설명 | 주요 옵션 |
|--------|------|-----------|
| `/mkt [strategy]` | 마케팅 전략 | `--campaign`, `--audit` |
| `/email [campaign]` | 이메일 마케팅 | `--template`, `--sequence` |
| `/social [platform]` | 소셜 미디어 | `--calendar`, `--analytics` |
| `/ppt [topic]` | 프레젠테이션 생성 | `--template`, `--slides` |
| `/excel [data]` | 데이터 분석/시각화 | `--chart`, `--pivot` |
| `/ad [campaign]` | 광고 캠페인 | `--platform`, `--budget` |
| `/seo [target]` | SEO 최적화 | `--audit`, `--keywords` |
| `/cro [page]` | 전환율 최적화 | `--funnel`, `--ab-test` |
| `/analytics [report]` | 마케팅 분석 | `--dashboard`, `--kpi` |
| `/crm [operation]` | CRM 관리 | `--segment`, `--journey` |
| `/swarm [operation]` | 연합 학습 관리 | `--sync`, `--status` |

### 유틸리티 커맨드

| 커맨드 | 설명 | 주요 옵션 |
|--------|------|-----------|
| `/cleanup [target]` | 기술 부채 정리 | `--scope` |
| `/estimate [target]` | 증거 기반 작업 추정 | `--breakdown` |
| `/index [query]` | 커맨드 카탈로그 검색 | -- |
| `/load [path]` | 프로젝트 컨텍스트 로딩 | `--deep` |
| `/artibot:update` | 자동 업데이트 관리 | `--check`, `--force`, `--dry-run` |

---

## 자동 업데이트

### 세션 시작 알림

Artibot은 매 세션 시작 시 자동으로 최신 버전을 확인합니다. 새 버전이 있으면 다음과 같이 알림이 표시됩니다:

```
Artibot v1.4.0 initialized
⬆️ New version available: v1.5.0 (current: v1.4.0)
   Update: /artibot:update --force
```

### `/artibot:update` 커맨드

버전 확인 및 업데이트를 관리합니다.

**플래그 옵션:**

| 플래그 | 동작 |
|--------|------|
| `--check` | 버전 확인만 수행 (기본값) |
| `--force` | 캐시 삭제 후 강제 재설치 |
| `--dry-run` | 실행 없이 업데이트 계획만 표시 |

**동작 방식:**

- **GitHub Releases API** 를 통해 최신 버전 확인
- **24시간 캐싱** 으로 불필요한 API 호출 방지
- **네트워크 오류/오프라인** 시 세션 시작 차단 안 함 (graceful degradation)
- **Windows, macOS, Linux** 크로스 플랫폼 지원

**사용 예:**

```bash
# 버전 확인만
/artibot:update --check

# 강제 업데이트 (캐시 무효화)
/artibot:update --force

# 계획 확인 후 수동 실행
/artibot:update --dry-run
```

---

## 에이전트 시스템

### orchestrator (팀 리더 / CTO)

| 에이전트 | 모델 | 역할 | Team API 도구 |
|----------|------|------|--------------|
| **orchestrator** | opus | CTO급 팀 리더. 조율 전용 (delegation mode) | TeamCreate, SendMessage, TaskCreate, TaskUpdate, TaskList, TaskGet, TeamDelete, Task() |

orchestrator는 **코드를 직접 작성하지 않습니다**. 팀을 구성하고, 태스크를 분배하고, 팀원간 조율하고, 결과를 종합하는 역할만 수행합니다.

### 전문 에이전트 (25개 팀원)

모든 팀원은 자신의 전문 도구 + 팀 협업 도구를 가집니다:
- `SendMessage` - 리더/동료에게 DM, 셧다운 응답
- `TaskList` / `TaskGet` - 할당된 태스크 확인
- `TaskUpdate` - 태스크 자기 할당 + 완료 보고

#### 설계/분석 (3개)

| 에이전트 | 모델 | 역할 |
|----------|------|------|
| **architect** | opus | 시스템 아키텍처, ADR, 트레이드오프 분석 |
| **planner** | opus | 구현 계획, 위험 평가, 단계 분해 |
| **llm-architect** | opus | LLM 아키텍처, 프롬프트 설계, RAG |

#### 품질/보안 (4개)

| 에이전트 | 모델 | 역할 |
|----------|------|------|
| **code-reviewer** | opus | 코드 리뷰 (4단계 심각도, 5개 차원) |
| **security-reviewer** | opus | OWASP Top 10, 위협 모델링 |
| **tdd-guide** | opus | TDD (RED→GREEN→REFACTOR), 80%+ 커버리지 |
| **e2e-runner** | opus | Playwright E2E 테스트 |

#### 개발 (6개)

| 에이전트 | 모델 | 역할 |
|----------|------|------|
| **frontend-developer** | sonnet | UI/UX, WCAG 접근성, Core Web Vitals |
| **backend-developer** | sonnet | API, 데이터베이스, 서비스 |
| **database-reviewer** | opus | SQL 최적화, 스키마 설계 |
| **typescript-pro** | sonnet | 고급 타입, strict mode, 마이그레이션 |
| **build-error-resolver** | opus | 빌드 오류 자동 진단/수정 |
| **performance-engineer** | opus | 성능 분석, 병목 제거, 최적화 |

#### 유틸리티 (5개)

| 에이전트 | 모델 | 역할 |
|----------|------|------|
| **refactor-cleaner** | opus | 데드 코드 제거, 리팩토링 |
| **doc-updater** | haiku | 문서 동기화, 변경 이력 |
| **content-marketer** | sonnet | 블로그, SEO, 소셜 미디어 |
| **devops-engineer** | sonnet | CI/CD, Docker, 모니터링 |
| **mcp-developer** | sonnet | MCP 서버 개발, 도구 오케스트레이션 |

#### 마케팅 (7개)

| 에이전트 | 모델 | 역할 |
|----------|------|------|
| **marketing-strategist** | sonnet | 마케팅 전략, 캠페인 기획 |
| **data-analyst** | sonnet | 데이터 분석, 시각화, KPI 추적 |
| **seo-specialist** | sonnet | SEO 전략, 키워드 분석, 기술 SEO |
| **cro-specialist** | sonnet | 전환율 최적화, A/B 테스트 |
| **ad-specialist** | sonnet | 광고 캠페인, 예산 최적화 |
| **presentation-designer** | sonnet | 프레젠테이션 디자인, 시각 자료 |
| **repo-benchmarker** | sonnet | 레포지토리 벤치마크, 비교 분석 |

### 모델 선택 기준

| 모델 | 용도 | 에이전트 수 |
|------|------|------------|
| **opus** | 깊은 추론, 아키텍처 결정, 보안 분석 | 11개 |
| **sonnet** | 일반 코딩, 밸런스형 작업 | 14개 |
| **haiku** | 경량 작업 (문서 동기화) | 1개 |

### 팀원 행동 프로토콜

모든 25개 팀원은 팀으로 실행될 때 다음 프로토콜을 따릅니다:

```
1. TaskList → 할당된 태스크 확인
2. TaskGet(taskId) → 상세 요구사항 확인
3. TaskUpdate(taskId, status: "in_progress") → 작업 시작
4. [전문 역할 수행]
5. SendMessage(type: "message", recipient: "team-lead") → 진행 보고
6. TaskUpdate(taskId, status: "completed") → 완료
7. TaskList → 다음 태스크 확인 (self-claim)
8. shutdown_request 수신 → shutdown_response(approve: true)
```

---

## 스킬 시스템

스킬은 에이전트에게 도메인 전문성을 부여하는 지식 계층입니다. 트리거 키워드가 감지되면 자동으로 활성화됩니다.

### 코어 스킬 (6개)

| 스킬 | 설명 |
|------|------|
| `orchestration` | 라우팅 인텔리전스, 위임 모드 선택 (Sub-Agent vs Team), 팀 편성 |
| `token-efficiency` | 5단계 압축, 심볼 시스템, 토큰 최적화 |
| `principles` | SOLID, DRY/KISS/YAGNI, 의사결정 프레임워크 |
| `coding-standards` | 불변성, 네이밍, 에러 핸들링, 파일 구조 |
| `security-standards` | 시크릿 관리, OWASP 체크리스트, 인증 패턴 |
| `testing-standards` | TDD, 테스트 피라미드, 커버리지 매트릭스 |

### 페르소나 스킬 (11개)

| 스킬 | 전문 영역 | 우선순위 |
|------|-----------|----------|
| `persona-architect` | 시스템 설계, 확장성 | 유지보수성 > 확장성 > 성능 |
| `persona-frontend` | UI/UX, 접근성 | 사용자 > 접근성 > 성능 |
| `persona-backend` | API, 신뢰성 | 신뢰성 > 보안 > 성능 |
| `persona-security` | 위협 모델링, 컴플라이언스 | 보안 > 컴플라이언스 > 신뢰성 |
| `persona-analyzer` | 근본 원인 분석 | 증거 > 체계성 > 철저함 |
| `persona-performance` | 최적화, 병목 제거 | 측정 > 크리티컬 패스 > UX |
| `persona-qa` | 품질, 테스팅 | 예방 > 탐지 > 교정 |
| `persona-refactorer` | 코드 품질, 기술 부채 | 단순성 > 유지보수성 > 가독성 |
| `persona-devops` | 인프라, CI/CD | 자동화 > 관측성 > 신뢰성 |
| `persona-mentor` | 지식 전달, 교육 | 이해 > 전달 > 교육 |
| `persona-scribe` | 문서화, 로컬라이제이션 | 명확성 > 독자 > 문화적 감수성 |

### 유틸리티 스킬 (8개)

| 스킬 | 설명 |
|------|------|
| `git-workflow` | Conventional Commits, PR 워크플로우, 브랜치 전략 |
| `tdd-workflow` | Red-Green-Refactor 사이클, 커버리지 목표 |
| `delegation` | Sub-Agent/Team 위임 전략, 모드 선택 매트릭스 |
| `mcp-context7` | Context7 라이브러리 문서 조회 |
| `mcp-playwright` | Playwright E2E 테스트, 크로스 브라우저 |
| `mcp-coordination` | MCP 서버 선택, 폴백, 캐싱 전략 |
| `continuous-learning` | 세션 간 패턴 추출 및 메모리 저장 |
| `strategic-compact` | 컨텍스트 압축 시 핵심 상태 보존 |

### 언어 스킬 (16개)

| 스킬 | 설명 |
|------|------|
| `lang-typescript` | TypeScript 코딩 패턴, strict mode |
| `lang-javascript` | JavaScript 모던 패턴, ESM |
| `lang-python` | Python 코딩 표준, PEP 8 |
| `lang-go` | Go 코딩 표준, 동시성 패턴 |
| `lang-rust` | Rust 소유권, 안전성 패턴 |
| `lang-java` | Java 디자인 패턴, 엔터프라이즈 |
| `lang-kotlin` | Kotlin 코딩 표준, 코루틴 |
| `lang-php` | PHP 모던 패턴, 프레임워크 |
| `lang-ruby` | Ruby 코딩 표준, Rails 패턴 |
| `lang-cpp` | C++ 모던 패턴, 메모리 관리 |
| `lang-csharp` | C# 코딩 표준, .NET 패턴 |
| `lang-scala` | Scala 함수형 패턴, Akka |
| `lang-swift` | Swift 코딩 표준, iOS 패턴 |
| `lang-elixir` | Elixir/OTP 패턴, 동시성 |
| `lang-flutter` | Flutter/Dart 위젯, 상태 관리 |
| `lang-r` | R 통계 분석, 데이터 패턴 |

### 마케팅 스킬 (23개)

| 스킬 | 설명 |
|------|------|
| `seo-strategy` | SEO 전략, 키워드 리서치 |
| `technical-seo` | 기술 SEO, 사이트 구조 최적화 |
| `content-seo` | 콘텐츠 SEO, 온페이지 최적화 |
| `cro-funnel` | 전환 퍼널 최적화 |
| `cro-page` | 랜딩 페이지 최적화 |
| `cro-forms` | 폼 최적화, 전환율 개선 |
| `ab-testing` | A/B 테스트 설계, 통계 분석 |
| `email-marketing` | 이메일 캠페인, 시퀀스 설계 |
| `social-media` | 소셜 미디어 전략, 콘텐츠 캘린더 |
| `advertising` | 광고 캠페인, 플랫폼 최적화 |
| `copywriting` | 카피라이팅, 설득 기법 |
| `brand-guidelines` | 브랜드 가이드라인, 톤앤매너 |
| `campaign-planning` | 캠페인 기획, 예산 배분 |
| `competitive-intelligence` | 경쟁사 분석, 시장 인사이트 |
| `customer-journey` | 고객 여정 매핑, 터치포인트 분석 |
| `data-analysis` | 마케팅 데이터 분석 |
| `data-visualization` | 데이터 시각화, 대시보드 |
| `lead-management` | 리드 관리, 스코어링 |
| `marketing-analytics` | 마케팅 분석, ROI 측정 |
| `marketing-strategy` | 마케팅 전략 수립 |
| `presentation-design` | 프레젠테이션 디자인 |
| `report-generation` | 리포트 생성, 데이터 요약 |
| `segmentation` | 시장/고객 세그멘테이션 |

### 기타 스킬 (13개)

| 스킬 | 설명 |
|------|------|
| `cognitive-routing` | 인지 라우팅, System 1/2 분류 |
| `lifelong-learning` | 평생 학습, 경험 축적 |
| `memory-management` | 메모리 관리, 3-scope 시스템 |
| `self-evaluation` | 자기 평가, Meta Self-Rewarding |
| `self-learning` | 자기 학습, GRPO 최적화 |
| `swarm-intelligence` | 연합 지능, Federated Swarm |
| `quality-framework` | 품질 프레임워크, 게이트 관리 |
| `spec-format` | 스펙 포맷, 문서 표준 |
| `platform-auth` | 인증/인가 플랫폼 패턴 |
| `platform-deployment` | 배포 플랫폼 패턴 |
| `platform-database-cloud` | DB/클라우드 플랫폼 패턴 |
| `library-mermaid` | Mermaid 다이어그램 패턴 |
| `library-shadcn` | shadcn/ui 컴포넌트 패턴 |

---

## 훅 시스템

14개 이벤트에 16개 자동화 스크립트가 연결되어 있습니다.

### 이벤트별 훅

| 이벤트 | 스크립트 | 동작 |
|--------|----------|------|
| **SessionStart** | `session-start.js` | 환경 감지, 설정 로드, 세션 상태 복원 |
| **PreToolUse** (Write/Edit) | `pre-write.js` | `.env`, `.pem`, `.key` 등 민감 파일 쓰기 차단 |
| **PreToolUse** (Bash) | `pre-bash.js` | `rm -rf`, `git push --force` 등 위험 명령 차단 |
| **PostToolUse** (Edit) | `post-edit-format.js` | JS/TS 파일 편집 후 Prettier 포맷 제안 |
| **PostToolUse** (Bash) | `post-bash.js` | git push 후 PR URL 자동 감지 |
| **PreCompact** | `pre-compact.js` | 컨텍스트 압축 전 상태 스냅샷 저장 |
| **Stop** | `check-console-log.js` | 세션 종료 시 `console.log` 잔여 검사 |
| **UserPromptSubmit** | `user-prompt-handler.js` | 사용자 의도 감지, 관련 에이전트 제안 |
| **SubagentStart/Stop** | `subagent-handler.js` | 서브에이전트/팀원 등록/해제 추적 |
| **TeammateIdle** | `team-idle-handler.js` | 유휴 팀원에게 대기 태스크 할당 알림 |
| **SessionEnd** | `session-end.js` | 세션 상태 저장 |

---

## MCP 통합

### Context7

라이브러리/프레임워크 공식 문서 조회 및 코드 패턴 추출.

```json
{
  "context7": {
    "command": "npx",
    "args": ["-y", "@upstash/context7-mcp@latest"]
  }
}
```

### Playwright

크로스 브라우저 E2E 테스트, 성능 측정, 시각적 검증.

```json
{
  "playwright": {
    "command": "npx",
    "args": ["-y", "@executeautomation/playwright-mcp-server"]
  }
}
```

---

## 설정

### artibot.config.json 주요 항목

| 항목 | 설명 | 기본값 |
|------|------|--------|
| `team.engine` | 팀 엔진 | `claude-agent-teams` |
| `team.envVar` | 활성화 환경변수 | `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` |
| `team.delegationMode` | 리더 조율 전용 모드 | `true` |
| `team.maxTeammates` | 최대 동시 팀원 수 | `null` (무제한) |
| `team.ctoAgent` | CTO 역할 에이전트 | `orchestrator` |
| `team.delegationModeSelection` | Sub-Agent/Team 자동 선택 | complexity 기반 |
| `automation.intentDetection` | 의도 자동 감지 | `true` |
| `automation.supportedLanguages` | 지원 언어 | `en, ko, ja` |

### 팀 저장소

| 경로 | 용도 |
|------|------|
| `~/.claude/teams/{team-name}/config.json` | 팀 구성 (멤버 목록) |
| `~/.claude/tasks/{team-name}/` | 공유 태스크 리스트 |

---

## 디렉토리 구조

```
plugins/artibot/
├── .claude-plugin/
│   └── plugin.json              # 플러그인 매니페스트
├── agents/                      # 26개 에이전트 정의 (orchestrator 1 + 팀원 25)
│   ├── orchestrator.md          #   CTO / 팀 리더 (Agent Teams API)
│   └── [25개 전문 에이전트].md    #   팀원 (SendMessage + TaskUpdate)
├── commands/                    # 38개 슬래시 커맨드
│   ├── sc.md                    #   메인 라우터
│   ├── orchestrate.md           #   팀 오케스트레이션 (TeamCreate)
│   ├── spawn.md                 #   팀 스폰 (병렬 실행)
│   └── [35개 커맨드].md
├── skills/                      # 77개 스킬 디렉토리
│   ├── orchestration/           #   위임 모드 선택 + 팀 라우팅
│   ├── delegation/              #   Sub-Agent/Team 위임 전략
│   └── [75개 스킬]/
├── hooks/
│   └── hooks.json               # 훅 이벤트 매핑
├── scripts/
│   ├── hooks/                   # 18개 훅 스크립트 (ESM)
│   ├── ci/                      # 4개 CI 검증 스크립트
│   └── utils/
├── lib/                         # 40개 모듈
│   ├── core/                    # 코어 모듈 (platform, config, cache, io, debug, file, tui, skill-exporter)
│   ├── intent/                  # 의도 감지 (language, trigger, ambiguity)
│   ├── context/                 # 컨텍스트 관리 (hierarchy, session)
│   ├── cognitive/               # 인지 엔진 (router, system1, system2, sandbox)
│   ├── learning/                # 학습 (memory, grpo, knowledge-transfer, lifelong, tool-learner, self-evaluator)
│   ├── privacy/                 # 프라이버시 (pii-scrubber)
│   ├── swarm/                   # 연합 지능 (swarm-client, pattern-packager, sync-scheduler)
│   ├── system/                  # 시스템 (telemetry-collector, context-injector)
│   └── adapters/                # 멀티모델 어댑터 (gemini, codex, cursor, antigravity)
├── output-styles/               # 4개 출력 스타일
├── templates/                   # 3개 작성 템플릿
├── artibot.config.json          # 플러그인 설정 (Agent Teams 포함)
├── package.json                 # Node.js ESM 런타임
└── .mcp.json                    # MCP 서버 설정
```

---

## 검증

```bash
node scripts/validate.js              # 통합 검증
node scripts/ci/validate-agents.js    # 에이전트 검증
node scripts/ci/validate-skills.js    # 스킬 검증
node scripts/ci/validate-commands.js  # 커맨드 검증
node scripts/ci/validate-hooks.js     # 훅 검증
```

---

## 기여하기

기여를 환영합니다! [CONTRIBUTING.md](CONTRIBUTING.md)에서 에이전트, 스킬, 커맨드 추가 방법과 코드 스타일 가이드를 확인하세요.

- 버그 리포트 / Bug reports: [GitHub Issues](https://github.com/Yoodaddy0311/artibot/issues)
- 보안 취약점 / Security vulnerabilities: [SECURITY.md](SECURITY.md)
- 변경 이력 / Changelog: [CHANGELOG.md](CHANGELOG.md)

---

## 라이선스

MIT License - Artience
