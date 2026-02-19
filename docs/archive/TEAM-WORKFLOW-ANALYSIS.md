# 4개 레포 팀/워크플로우 핵심 분석

> Claude Code Agent Teams 작동 방식 및 Artibot 팀 시스템 설계 기초 자료
>
> Analyst: workflow-designer-2
> Date: 2026-02-13
> Sources: bkit-claude-code, everything-claude-code, cc-wf-studio, ui-ux-pro-max-skill

---

## 1. 분석 요약

| 레포 | 팀 패턴 | 성숙도 | 핵심 기여 |
|------|---------|--------|----------|
| **bkit-claude-code** | CTO-Led Agent Teams (PDCA 통합) | Production-ready | 팀 오케스트레이션 엔진, 상태 영속화, 훅 통합 |
| **everything-claude-code** | Sequential Pipeline + Multi-Model Orchestration | Production-ready | Handoff 프로토콜, 멀티모델 위임, 비용 최적화 |
| **cc-wf-studio** | Visual Workflow Orchestration (VSCode Extension) | Production-ready | 워크플로우 시각화, AI 생성/정제 |
| **ui-ux-pro-max-skill** | 무상태 도구 (팀 패턴 없음) | N/A | 참고 없음 |

---

## 2. bkit-claude-code: CTO-Led Agent Teams

### 2.1 아키텍처 개요

bkit의 팀 시스템은 Claude Code Agent Teams API 위에 구축된 **8-모듈 팀 엔진**이다.

```
lib/team/
├── coordinator.js    # Agent Teams 가용성, 팀 설정 관리
├── strategy.js       # 레벨별 팀 전략 정의 (Dynamic/Enterprise)
├── orchestrator.js   # PDCA 기반 팀 편성 엔진
├── communication.js  # 팀원 간 메시지 구조/라우팅
├── task-queue.js     # PDCA 기반 태스크 생성/할당/추적
├── cto-logic.js      # CTO 의사결정 (단계 진행, 품질 게이트)
├── hooks.js          # TaskCompleted/TeammateIdle 훅 통합
├── state-writer.js   # 팀 상태 디스크 영속화 (.bkit/agent-state.json)
└── index.js          # 배럴 모듈 (30+ exports)
```

### 2.2 팀 생성/소환/해체 패턴

#### 생성 조건

```javascript
// coordinator.js - 팀 모드 자동 제안
function suggestTeamMode(userMessage, options) {
  if (!isTeamModeAvailable()) return null;  // CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
  if (level === 'Starter') return null;     // Starter는 팀 불가
  if (messageLength >= 1000) return { suggest: true };  // 대규모 요청 감지
  if (matchMultiLangPattern(userMessage, ctoTriggers)) return { suggest: true };
}
```

**핵심 발견**: 팀 생성은 **환경변수 체크 + 레벨 체크 + 요청 규모 판단**의 3단계.

#### 팀 편성 (composeTeamForPhase)

```
orchestrator.js:
1. PDCA 단계(plan/design/do/check/act)별로 필요한 역할 필터링
2. 레벨(Dynamic/Enterprise)에 따른 전략 선택
3. 각 역할에 에이전트 매핑 (strategy.js의 TEAM_STRATEGIES)
4. generateSpawnTeamCommand()로 Claude Code Agent Teams API 호출 데이터 생성
```

#### 레벨별 팀 구성

| 레벨 | 최대 인원 | 오케스트레이션 패턴 |
|------|----------|-------------------|
| **Starter** | 0 (팀 불가) | 단독 세션 |
| **Dynamic** | 3 (developer, frontend, qa) | plan: leader, do: swarm, check: council |
| **Enterprise** | 5 (architect, developer, qa, reviewer, security) | design: council, do: swarm, act: watchdog |

#### 해체

```javascript
// state-writer.js - cleanupAgentState()
function cleanupAgentState() {
  state.enabled = false;
  state.teammates = [];
  // progress, recentMessages는 유지 (최종 상태 표시용)
  writeAgentState(state);
}
```

**해체 트리거**: Stop 훅 (team-stop.js, cto-stop.js, unified-stop.js에서 호출)

### 2.3 오케스트레이션 패턴 (5종)

| 패턴 | 설명 | 사용 단계 | 동작 방식 |
|------|------|----------|----------|
| **Leader** | CTO가 지시, 팀원이 실행 | Plan, Act (Dynamic) | 순차적 위임 |
| **Council** | 다관점 검토 필요 | Design, Check | 병렬 의견 수렴 후 CTO 결정 |
| **Swarm** | 대규모 병렬 구현 | Do | 독립 태스크 병렬 실행 |
| **Pipeline** | 순차 의존 체인 | Plan->Design->Do | 이전 단계 완료 후 다음 |
| **Watchdog** | 지속적 모니터링 | Check (Enterprise), Act (Enterprise) | 감시 + 자동 개입 |

### 2.4 CTO 에이전트 상세

```yaml
# agents/cto-lead.md
name: cto-lead
model: opus           # 가장 비싼 모델 = 전략적 판단
permissionMode: acceptEdits
memory: project       # 프로젝트 스코프 메모리
tools:
  - Task(enterprise-expert)
  - Task(infra-architect)
  - Task(bkend-expert)
  - Task(frontend-architect)
  - Task(security-architect)
  - Task(product-manager)
  - Task(qa-strategist)
  - Task(code-analyzer)
  - Task(gap-detector)
  - Task(report-generator)
skills: [pdca, enterprise, bkit-rules]
```

**핵심**: CTO는 **Task(agent-name) 도구**를 통해 다른 에이전트를 서브에이전트로 소환한다. 각 서브에이전트는 독립 세션에서 실행되며 자체 도구/스킬을 갖는다.

### 2.5 커뮤니케이션 프로토콜

```javascript
// communication.js - 8가지 메시지 타입
const MESSAGE_TYPES = [
  'task_assignment',    // 태스크 할당
  'review_request',     // 리뷰 요청
  'approval',           // 승인
  'rejection',          // 거부
  'phase_transition',   // 단계 전환 알림
  'status_update',      // 상태 업데이트
  'directive',          // CTO 지시
  'info',               // 정보 공유
];
```

**메시지 구조**:
```javascript
{
  from: 'cto',
  to: 'developer',  // 또는 'all' (broadcast)
  type: 'task_assignment',
  payload: {
    subject: '...',
    body: '...',
    feature: 'login-feature',
    phase: 'do',
    references: ['docs/02-design/features/login.design.md']
  },
  timestamp: 'ISO 8601'
}
```

**실제 전송**: Claude Code의 SendMessage 도구(write/broadcast) 사용. bkit은 메시지 **구조만 정의**, 실제 전달은 Claude Code 런타임에 위임.

### 2.6 태스크 관리 워크플로우

```
1. composeTeamForPhase() → 역할별 팀원 리스트 생성
2. createTeamTasks() → 각 팀원에게 태스크 정의 생성
3. assignTaskToRole() → taskAssignments Map에 할당 기록
4. findNextAvailableTask() → idle 팀원에게 다음 태스크 안내
5. getTeamProgress() → 진행률 추적 (total/completed/inProgress/pending)
6. isPhaseComplete() → 단계 완료 여부 판단
```

**In-memory 한계**: `taskAssignments`는 Map 객체로, 세션 종료 시 소멸. state-writer.js의 `updateProgress()`로 디스크 영속화 보완.

### 2.7 상태 영속화 (team-visibility)

```
Hook Event → Hook Handler Script → state-writer.js → .bkit/agent-state.json
                                                          ↓
                                                    bkit Studio (옵션)
                                                    2초 간격 폴링
```

**agent-state.json 스키마 (v1.0)**:
```typescript
interface AgentState {
  version: "1.0";
  enabled: boolean;
  teamName: string;
  feature: string;
  pdcaPhase: "plan"|"design"|"do"|"check"|"act";
  orchestrationPattern: "leader"|"swarm"|"council"|"watchdog";
  ctoAgent: string;
  teammates: Teammate[];   // max 10
  progress: Progress;
  recentMessages: Message[];  // ring buffer, max 50
  sessionId: string;
}
```

**훅 통합 매트릭스**:
| Hook Event | Handler | state-writer 호출 |
|------------|---------|-------------------|
| SubagentStart | subagent-start-handler.js | initAgentState + addTeammate |
| SubagentStop | subagent-stop-handler.js | updateTeammateStatus + updateProgress |
| TeammateIdle | team-idle-handler.js | updateTeammateStatus("idle") |
| TaskCompleted | pdca-task-completed.js | updateProgress + addRecentMessage |
| Stop | team-stop.js / cto-stop.js | cleanupAgentState |

### 2.8 품질 게이트 (CTO 의사결정)

```javascript
// cto-logic.js - evaluateCheckResults()
if (matchRate >= 90 && criticalIssues === 0) → 'report'  (완료)
if (matchRate >= 70) → 'iterate'  (반복 개선)
if (matchRate < 70) → 'redesign'  (재설계)
```

**단계 전환 블로커**:
- Plan → Design: Plan 문서 존재 필수
- Design → Do: Design 문서 존재 필수
- Check → Act: Match Rate >= 90%, Critical Issues = 0

---

## 3. everything-claude-code: Sequential Pipeline + Multi-Model

### 3.1 서브에이전트 위임 전략

#### /orchestrate 커맨드 - 순차 파이프라인

```
/orchestrate feature "Add authentication"
  → planner → tdd-guide → code-reviewer → security-reviewer
```

**핵심 패턴: Handoff Document**
```markdown
## HANDOFF: [previous-agent] -> [next-agent]
### Context: [무엇을 했는지]
### Findings: [발견/결정 사항]
### Files Modified: [변경 파일]
### Open Questions: [미해결]
### Recommendations: [다음 단계 제안]
```

bkit과 달리 **구조화된 핸드오프 문서**로 에이전트 간 컨텍스트를 전달한다. Claude Code의 SendMessage가 아닌 **문서 기반 전달** 방식.

#### 병렬 실행 지원

```markdown
### Parallel Phase
Run simultaneously:
- code-reviewer (quality)
- security-reviewer (security)
- architect (design)
### Merge Results
```

#### 9개 에이전트 역할

| Agent | Purpose | Trigger |
|-------|---------|---------|
| planner | 구현 계획 | 복잡 기능, 리팩토링 |
| architect | 시스템 설계 | 아키텍처 결정 |
| tdd-guide | TDD | 새 기능, 버그 수정 |
| code-reviewer | 코드 리뷰 | 코드 작성 후 |
| security-reviewer | 보안 분석 | 커밋 전 |
| build-error-resolver | 빌드 에러 | 빌드 실패 |
| e2e-runner | E2E 테스트 | 핵심 사용자 플로우 |
| refactor-cleaner | 데드 코드 정리 | 코드 유지보수 |
| doc-updater | 문서 업데이트 | 문서 작업 |

### 3.2 멀티모델 오케스트레이션 (/workflow, /backend, /frontend)

**가장 혁신적인 패턴**: Claude가 Codex와 Gemini를 외부 모델로 호출하여 협업.

```
/workflow - Claude가 오케스트레이터
  ├── Codex (Backend authority) - 백엔드 로직, 알고리즘
  ├── Gemini (Frontend authority) - UI/UX, 디자인
  └── Claude (self) - 오케스트레이션, 계획, 실행, 전달
```

**6단계 워크플로우**:
```
Research → Ideation → Plan → Execute → Optimize → Review
  ↓          ↓          ↓       ↓          ↓         ↓
  MCP     Codex+Gemini  Codex  Claude    Codex     Claude
          (parallel)   +Gemini          +Gemini
```

**외부 모델 호출 방식**:
```bash
~/.claude/bin/codeagent-wrapper --backend <codex|gemini> - "$PWD" <<'EOF'
ROLE_FILE: <role prompt path>
<TASK>
Requirement: <requirement>
Context: <context>
</TASK>
OUTPUT: Expected format
EOF
```

**핵심 규칙**:
- 외부 모델은 **파일 시스템 쓰기 권한 없음** (zero filesystem write access)
- Claude만 모든 코드 작성/파일 수정 담당
- 세션 재사용: SESSION_ID로 resume 가능
- run_in_background: true로 병렬 호출

### 3.3 Vibe Coding 최적화 패턴

```yaml
# rules/common/agents.md
Immediate Agent Usage (No user prompt needed):
1. Complex feature requests → planner agent
2. Code just written/modified → code-reviewer agent
3. Bug fix or new feature → tdd-guide agent
4. Architectural decision → architect agent
```

**자동 에이전트 선택**: 사용자 프롬프트 없이 컨텍스트만으로 적절한 에이전트 자동 호출.

---

## 4. cc-wf-studio: Visual Workflow Orchestration

### 4.1 워크플로우 시각화 패턴

VSCode Extension + React Flow 기반의 **시각적 워크플로우 편집기**.

```
Node Types (7종):
Start → Prompt → SubAgent → AskUserQuestion → IfElse → Switch → End
```

**특이점**: 코드가 아닌 **시각적 캔버스**에서 워크플로우를 설계하고, JSON으로 직렬화하여 실행.

### 4.2 AI 워크플로우 생성/정제

```
사용자 자연어 설명
  → Claude Code CLI (executeClaudeCodeCLIStreaming)
  → workflow-schema.json 기반 생성
  → 검증 (validateWorkflow)
  → React Flow 캔버스에 표시
```

**Refinement (대화형 정제)**:
```
사용자 피드백 입력
  → buildPromptWithHistory() (대화 이력 포함)
  → Claude Code CLI (스트리밍)
  → 실시간 UI 업데이트
  → 정제된 워크플로우 검증
```

### 4.3 워크플로우 공유 (Slack 통합)

```
워크플로우 → 민감 데이터 검사 → Slack API 업로드 → Deep Link 생성
                                                      ↓
                                              vscode://cc-wf-studio/import?fileId=...
```

### 4.4 MCP 서버 통합

워크플로우 노드로 MCP 서버/도구를 시각적으로 연결. SDK 클라이언트를 통해 MCP 서버 검색/도구 목록 조회.

---

## 5. 패턴 비교 분석

### 5.1 팀 생성 패턴 비교

| 측면 | bkit | everything-claude-code | cc-wf-studio |
|------|------|----------------------|-------------|
| **생성 방식** | PDCA 단계별 자동 편성 | /orchestrate 커맨드로 파이프라인 정의 | 시각적 노드 배치 |
| **팀 크기** | 3-5 (레벨에 따라) | 3-5 (워크플로우에 따라) | N/A (노드 수 무제한) |
| **역할 정의** | YAML frontmatter (agents/*.md) | Markdown 파일 (~/.claude/agents/) | JSON 노드 타입 |
| **CTO/리더** | cto-lead (opus) | Claude 자체 | N/A |
| **동적 편성** | shouldRecomposeTeam() | 고정 파이프라인 | 사용자 수동 |

### 5.2 서브에이전트 위임 전략 비교

| 측면 | bkit | everything-claude-code |
|------|------|----------------------|
| **위임 방식** | Task(agent-name) 도구 | Task tool + Bash(codeagent-wrapper) |
| **컨텍스트 전달** | SendMessage + 공유 파일 | Handoff Document |
| **모델 선택** | 역할별 고정 (opus/sonnet/haiku) | 태스크별 동적 (Claude/Codex/Gemini) |
| **병렬 실행** | Swarm 패턴 | run_in_background: true |
| **비용 최적화** | 모델 차등 배정 | 멀티모델 + 무료 도구 우선 |

### 5.3 태스크 관리 비교

| 측면 | bkit | everything-claude-code |
|------|------|----------------------|
| **태스크 생성** | createTeamTasks() (PDCA 기반) | /orchestrate 워크플로우 자동 |
| **할당** | assignTaskToRole() | 파이프라인 순서 자동 |
| **추적** | taskAssignments Map + agent-state.json | Handoff 문서 체인 |
| **완료 판단** | isPhaseComplete() + matchRate | Final Report (SHIP/NEEDS WORK/BLOCKED) |
| **idle 처리** | findNextAvailableTask() | N/A (파이프라인이라 idle 없음) |

### 5.4 커뮤니케이션 프로토콜 비교

| 측면 | bkit | everything-claude-code |
|------|------|----------------------|
| **메시지 방식** | SendMessage/Broadcast (Agent Teams API) | Handoff Document (파일 기반) |
| **메시지 타입** | 8종 (task_assignment, approval 등) | 단일 (Handoff 구조) |
| **방향성** | 양방향 (팀원 간 직접 통신) | 단방향 (이전→다음 에이전트) |
| **브로드캐스트** | createBroadcast() | N/A |
| **Plan 승인** | createPlanDecision() (approve/reject) | N/A |

---

## 6. Artibot 핵심 설계 시사점

### 6.1 채택할 패턴

#### Pattern A: bkit의 CTO-Led 팀 편성 엔진

**채택 이유**: PDCA 단계별 자동 팀 편성이 Artibot의 "vibe coding에 최적화된 팀 운영" 목표에 부합.

**핵심 모듈 구조**:
```
artibot/lib/team/
├── coordinator.js    # 팀 모드 가용성 + 자동 제안
├── strategy.js       # 레벨별 팀 전략 (Artibot 커스텀)
├── orchestrator.js   # 패턴 선택 + 팀 편성
├── task-queue.js     # 태스크 생성/할당/추적
└── state-writer.js   # 팀 상태 영속화
```

#### Pattern B: everything-claude-code의 Handoff Protocol

**채택 이유**: 에이전트 간 컨텍스트 전달의 표준화.

```markdown
## HANDOFF: [from-agent] -> [to-agent]
### Context: [summary]
### Findings: [key discoveries]
### Files Modified: [list]
### Open Questions: [unresolved]
### Recommendations: [next steps]
```

#### Pattern C: bkit의 5-Pattern Orchestration

**채택 이유**: 상황별 최적 패턴 선택이 효율성을 높임.

```
Leader  → 단순 지시/실행 (기본)
Council → 다관점 의사결정 (설계 검토)
Swarm   → 대규모 병렬 (구현)
Pipeline → 순차 의존 (빌드/배포)
Watchdog → 지속 감시 (품질 모니터링)
```

#### Pattern D: everything-claude-code의 멀티모델 위임

**채택 이유**: 비용 최적화 + 전문성 분리.

```yaml
cost-optimization:
  strategic: opus    # 아키텍처, CTO 판단
  execution: sonnet  # 구현, 반복
  monitoring: haiku  # 모니터링, 리포트
  external:
    codex: backend   # 백엔드 전문
    gemini: frontend # 프론트엔드 전문
```

### 6.2 개선할 패턴

#### 1. In-Memory 태스크의 영속화 강화

**문제**: bkit의 taskAssignments는 세션 종료 시 소멸.
**개선**: agent-state.json에 태스크 전체 상태 포함, 또는 별도 task-state.json.

#### 2. Handoff의 구조화

**문제**: everything-claude-code의 Handoff는 자유 형식 Markdown.
**개선**: JSON 스키마 기반 Handoff로 파싱 가능하게.

```json
{
  "handoff": {
    "from": "planner",
    "to": "tdd-guide",
    "context": { "summary": "...", "requirements": [...] },
    "artifacts": [{ "path": "...", "type": "plan" }],
    "openQuestions": ["..."],
    "confidence": 0.85
  }
}
```

#### 3. 팀 해체의 점진적 수행

**문제**: bkit은 Stop 훅에서 즉시 cleanupAgentState().
**개선**: 단계적 해체 (working → draining → cleanup).

#### 4. 비용 추적 통합

**문제**: 4개 레포 모두 실시간 비용 추적 없음.
**개선**: 각 에이전트 호출의 토큰 사용량 추적 → agent-state.json에 기록.

### 6.3 Artibot 팀 플레이북 설계

#### 플레이북 정의

```yaml
# playbooks/feature-development.yaml
name: Feature Development
trigger: "새 기능 요청, implement, build"
phases:
  1-plan:
    pattern: leader
    agents: [planner]
    gate: plan-doc-exists
  2-design:
    pattern: council
    agents: [architect, frontend]
    gate: design-doc-exists
  3-implement:
    pattern: swarm
    agents: [developer, frontend]
    gate: all-tasks-complete
  4-verify:
    pattern: council
    agents: [code-reviewer, security-reviewer, tdd-guide]
    gate: match-rate >= 90
  5-report:
    pattern: leader
    agents: [doc-updater]
    gate: report-generated
```

#### 플레이북 타입

| 플레이북 | 에이전트 체인 | 트리거 |
|---------|------------|--------|
| **feature** | planner → architect → developer → reviewer → security | "새 기능", "implement" |
| **bugfix** | planner → tdd-guide → code-reviewer | "버그", "fix" |
| **refactor** | architect → code-reviewer → tdd-guide | "리팩토링", "cleanup" |
| **security** | security-reviewer → code-reviewer → architect | "보안", "vulnerability" |
| **quick-fix** | (단독 세션, 팀 불요) | < 10줄 변경 |

### 6.4 Vibe Coding 최적화 설계

#### 원칙

1. **제로 설정**: 사용자가 팀을 명시적으로 요청할 필요 없음 → 자동 감지 + 자동 편성
2. **점진적 팀 확장**: 단독 → 2인 → 풀 팀 (필요에 따라)
3. **비용 의식**: 간단한 작업에 팀 소환 방지 (Quick Fix = 단독)
4. **투명한 진행**: 팀 상태를 자연어로 사용자에게 보고

#### 자동 팀 편성 로직

```
사용자 요청 분석
  ↓
복잡도 판단 (messageLength, keyword, fileCount)
  ├── Quick Fix (< 10줄) → 단독 세션
  ├── Minor Change (< 50줄) → 단독 + 리뷰어 제안
  ├── Feature (< 200줄) → 2-3인 팀 자동 편성
  └── Major Feature (>= 200줄) → 풀 팀 + CTO 소환
```

---

## 7. 핵심 기술 참조

### 7.1 Claude Code Agent Teams API 사용법 (bkit 구현 기준)

| API | 용도 | bkit 래퍼 |
|-----|------|----------|
| `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` | 팀 모드 활성화 | coordinator.isTeamModeAvailable() |
| `Task(agent-name)` | 서브에이전트 소환 | agents/*.md의 tools 섹션 |
| `SendMessage` | 팀원 간 메시지 | communication.createMessage() |
| `TaskCreate/TaskUpdate/TaskList` | 태스크 관리 | task-queue.createTeamTasks() |
| `SubagentStart/SubagentStop` Hook | 에이전트 수명주기 | state-writer integration |
| `TeammateIdle` Hook | idle 감지 | hooks.handleTeammateIdle() |
| `TaskCompleted` Hook | 태스크 완료 | hooks.assignNextTeammateWork() |

### 7.2 에이전트 정의 표준 (bkit frontmatter)

```yaml
---
name: agent-name
description: |
  역할 설명 + 트리거 키워드 (다국어)
  Do NOT use for: 제외 조건
permissionMode: acceptEdits|plan
memory: project|user
model: opus|sonnet|haiku
tools:
  - Read, Write, Edit, Glob, Grep, Bash
  - Task(other-agent)    # 서브에이전트 위임
  - TodoWrite
skills:
  - skill-name
hooks:
  Stop:
    - matcher: "..."
      script: "./scripts/hook.js"
---
```

### 7.3 비용 최적화 전략 (4개 레포 종합)

| 전략 | 레포 | 적용 |
|------|------|------|
| **모델 차등 배정** | bkit | opus(전략) / sonnet(실행) / haiku(모니터링) |
| **멀티모델 위임** | everything-claude-code | Claude(오케스트레이션) / Codex(백엔드) / Gemini(프론트엔드) |
| **비용 우선순위** | everything-claude-code (Sisyphus 참조) | 무료 도구 > 직접 호출 > 배경 에이전트 > 블로킹 에이전트 |
| **규모별 팀 크기** | bkit | Quick Fix(0) / Feature(3) / Major(5) |
| **idle 감지** | bkit | TeammateIdle 훅으로 불필요 대기 방지 |

---

## 8. 결론

### Artibot에 가장 중요한 3가지 설계 결정

1. **CTO-Led 오케스트레이션 엔진 (bkit 패턴 채택)**
   - 8-모듈 팀 엔진 구조 차용
   - 5가지 오케스트레이션 패턴 (Leader/Council/Swarm/Pipeline/Watchdog)
   - PDCA 단계별 자동 팀 편성/해체

2. **Handoff Protocol + 구조화된 커뮤니케이션 (everything-claude-code + bkit 하이브리드)**
   - 에이전트 간 Handoff Document로 컨텍스트 전달
   - 8가지 메시지 타입으로 의도 명확화
   - 양방향 통신 (팀원 간 직접 소통)

3. **Vibe Coding 최적화 (자동 팀 편성 + 비용 의식)**
   - 요청 복잡도 자동 판단 → 적정 팀 규모 결정
   - 모델 차등 배정 + 멀티모델 위임
   - 제로 설정 팀 경험 (사용자 개입 최소화)

### 파일 참조

| 핵심 파일 | 경로 |
|----------|------|
| CTO 에이전트 정의 | refs/bkit-claude-code/agents/cto-lead.md |
| 팀 전략 | refs/bkit-claude-code/lib/team/strategy.js |
| 오케스트레이터 | refs/bkit-claude-code/lib/team/orchestrator.js |
| CTO 의사결정 | refs/bkit-claude-code/lib/team/cto-logic.js |
| 상태 영속화 | refs/bkit-claude-code/lib/team/state-writer.js |
| 커뮤니케이션 | refs/bkit-claude-code/lib/team/communication.js |
| 태스크 큐 | refs/bkit-claude-code/lib/team/task-queue.js |
| 훅 통합 | refs/bkit-claude-code/lib/team/hooks.js |
| Orchestrate 커맨드 | refs/everything-claude-code/commands/orchestrate.md |
| 멀티모델 워크플로우 | refs/everything-claude-code/commands/multi-workflow.md |
| 에이전트 규칙 | refs/everything-claude-code/rules/common/agents.md |
| 팀 비교 영상 스크립트 | refs/bkit-claude-code/docs/01-plan/features/video-script-agent-teams.md |
| 팀 가시성 설계서 | refs/bkit-claude-code/docs/02-design/features/team-visibility.design.md |
