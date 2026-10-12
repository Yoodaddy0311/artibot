---
description: "(Artibot) Avengers Assemble! - Easter egg that summons the full Artibot agent team using real Agent Teams API"
argument-hint: '"어벤저스 어셈블!"'
allowed-tools: [Read, Glob, Grep, Bash, Agent, SendMessage, TaskCreate, TaskUpdate, TaskList, TaskGet]
toolset: team
---

# /artibot:assemble

Easter egg command. When triggered, creates a **real Agent Team** and spawns teammates who introduce themselves.

## Trigger Phrases

- "어벤저스 어셈블"
- "Avengers Assemble"

## Execution Flow

### Step 1: Name the Squad

There is no team to create — the session already has one implicit team. Fix
`avengers` as the name prefix for every teammate spawned below, so the roster is
recognizable in `SendMessage` and in the task list.

### Step 2: Display Roster Banner

Show the full 26-agent roster to the user immediately:

## ARTIBOT AVENGERS, ASSEMBLE!

### CTO

| Agent | Role |
|-------|------|
| orchestrator | 프로젝트 총괄 및 팀 리더 |

### Managers (3)

| Agent | Role |
|-------|------|
| planner | 구현 계획 수립 및 리스크 분석 |
| architect | 시스템 설계 및 아키텍처 결정 |
| marketing-strategist | 마케팅 전략 및 시장 분석 |

### Experts (9)

| Agent | Role |
|-------|------|
| code-reviewer | 코드 리뷰 및 품질 검증 |
| security-reviewer | 보안 취약점 탐지 및 대응 |
| performance-engineer | 성능 프로파일링 및 최적화 |
| database-reviewer | DB 스키마 설계 및 쿼리 최적화 |
| typescript-pro | 타입 시스템 설계 및 마이그레이션 |
| llm-architect | LLM 통합 설계 및 프롬프트 엔지니어링 |
| mcp-developer | MCP 서버 개발 및 도구 통합 |
| seo-specialist | SEO 감사 및 키워드 전략 |
| cro-specialist | 전환율 최적화 및 퍼널 분석 |

### Builders (4)

| Agent | Role |
|-------|------|
| frontend-developer | UI 컴포넌트 개발 및 반응형 구현 |
| backend-developer | API 설계 및 서버 로직 구현 |
| devops-engineer | CI/CD 파이프라인 및 배포 자동화 |
| e2e-runner | E2E 테스트 작성 및 실행 |

### Support (9)

| Agent | Role |
|-------|------|
| tdd-guide | 테스트 주도 개발 가이드 |
| build-error-resolver | 빌드 오류 진단 및 수정 |
| refactor-cleaner | 데드코드 제거 및 리팩토링 |
| doc-updater | 문서 생성 및 유지보수 |
| repo-benchmarker | 레포지토리 벤치마크 분석 |
| content-marketer | 콘텐츠 마케팅 및 SEO 글 작성 |
| data-analyst | 데이터 분석 및 리포트 생성 |
| presentation-designer | 프레젠테이션 구조 설계 |
| ad-specialist | 광고 카피 및 캠페인 설계 |

**Total: 26 agents** | 준비 완료. 명령을 기다리고 있습니다.

### Step 3: Spawn Representative Teammates

Spawn **one agent per category** (5 total) into the "avengers" team. Each teammate introduces themselves with their role and specialty in plain Korean.

> **모델 전달 — 아래 스폰 예시의 `model` 주석이 가리키는 절차.** 리더는 스폰 직전에 에이전트마다 `node <pluginRoot>/scripts/model-routing/model-routing.mjs resolve artibot:<agent-type>` 를 실행하고(`--role`·`--task` 는 붙이지 않는다 — 에이전트의 기본 작업 종류 `lib/routing/action-classifier.js#AGENT_ACTION_CLASS` 가 기준이라 각 에이전트가 자기 작업 종류의 티어로 뜬다), 출력된 한 단어를 Agent 호출의 `model` 파라미터에 **그대로 넘긴다**. 이 문서에는 모델 이름을 적지 않는다 — 판정은 CLI 가 한다. 다섯 `resolve` 를 먼저 한 번에 받은 뒤 다섯 Agent 를 한 메시지에서 병렬로 띄운다. `model` 을 생략하지 않는다(생략한 스폰에는 `/model-routing` 설정이 닿지 않는다). CLI 가 없거나 실패하면 `lib/core/model-policy.js#resolveModel('<agent-type>')` 값으로 폴백한다 — 근거·상세는 `commands/team.md` §Teammate Rules & Model Policy.

**보고 주소 (MANDATORY)** — 아래 스폰 예시의 `{보고 주소}` 자리에는 다음 블록을 그대로 삽입한다. 이 커맨드는 `commands/team.md` 의 `[보고 계약]` 전문(5캐리어 parity 대상)을 싣지 않고 채널 조항만 싣는다. 팀원이 자기소개를 일반 텍스트로만 내면 Step 4 가 기다리는 리더에게 전달되지 않기 때문이다(채널 명시 근거는 `commands/team.md` 의 `### 보고 계약`). `main` 은 이 커맨드를 실행한 메인 세션의 주소다. 이름 있는 팀원이 이 커맨드를 돌릴 때만 그 이름으로 바꾸고, 세션 이름·런 슬러그는 넣지 마라 — 그 이름으로 메인 세션에 보낸 메시지는 거부된다(2026-09-22 실측, `commands/team.md` 에 기록).

```
[보고 주소]
- 보고는 반드시 SendMessage(to="main") 로 보낸다. 일반 텍스트 출력은 리더에게 전달되지 않는다.
- 보고가 5,000자를 넘으면 줄 경계에서 5,000자 이하 조각으로 나눠 여러 번 보낸다. 각 조각 첫 줄에 `chunk k/N` 을 적는다.
```

Launch ALL 5 in parallel:

```
Agent(architect, name="avengers-architect",
  /* model: node <pluginRoot>/scripts/model-routing/model-routing.mjs resolve artibot:architect 출력값을 Agent 호출의 model 파라미터에 넘긴다 */
  prompt="Artibot 팀에 소환되었습니다.
  한국어 1-2문장으로 자기소개해주세요. 역할: 시스템 설계 및 아키텍처 결정.
  담당 분야와 준비 상태를 간단히 말해주세요.
  {보고 주소}")

Agent(code-reviewer, name="avengers-code-reviewer",
  /* model: node <pluginRoot>/scripts/model-routing/model-routing.mjs resolve artibot:code-reviewer 출력값을 Agent 호출의 model 파라미터에 넘긴다 */
  prompt="Artibot 팀에 소환되었습니다.
  한국어 1-2문장으로 자기소개해주세요. 역할: 코드 리뷰 및 품질 검증.
  담당 분야와 준비 상태를 간단히 말해주세요.
  {보고 주소}")

Agent(backend-developer, name="avengers-backend-dev",
  /* model: node <pluginRoot>/scripts/model-routing/model-routing.mjs resolve artibot:backend-developer 출력값을 Agent 호출의 model 파라미터에 넘긴다 */
  prompt="Artibot 팀에 소환되었습니다.
  한국어 1-2문장으로 자기소개해주세요. 역할: API 설계 및 서버 로직 구현.
  담당 분야와 준비 상태를 간단히 말해주세요.
  {보고 주소}")

Agent(security-reviewer, name="avengers-security-reviewer",
  /* model: node <pluginRoot>/scripts/model-routing/model-routing.mjs resolve artibot:security-reviewer 출력값을 Agent 호출의 model 파라미터에 넘긴다 */
  prompt="Artibot 팀에 소환되었습니다.
  한국어 1-2문장으로 자기소개해주세요. 역할: 보안 취약점 탐지 및 대응.
  담당 분야와 준비 상태를 간단히 말해주세요.
  {보고 주소}")

Agent(tdd-guide, name="avengers-tdd-guide",
  /* model: node <pluginRoot>/scripts/model-routing/model-routing.mjs resolve artibot:tdd-guide 출력값을 Agent 호출의 model 파라미터에 넘긴다 */
  prompt="Artibot 팀에 소환되었습니다.
  한국어 1-2문장으로 자기소개해주세요. 역할: 테스트 주도 개발 가이드.
  담당 분야와 준비 상태를 간단히 말해주세요.
  {보고 주소}")
```

### Step 4: Collect Introductions

Wait for all 5 teammates to send their introduction messages. Display each introduction as received.

### Step 5: Offer Next Action

After all introductions, ask the user:

```
어벤저스가 소집되었습니다! 이 팀으로 작업을 진행할까요?
- 작업 지시: 이 팀에게 바로 미션을 부여합니다
- 해산: 팀을 해산하고 종료합니다
```

If the user wants to proceed with work: keep the team alive and accept task instructions.
If the user wants to dismiss: send shutdown_request to all teammates. That is the
whole teardown — the team is implicit, so there is no disband call after it.

## Important Notes

- This is a FUN easter egg but uses REAL Agent Teams infrastructure
- The team persists and can accept real work if the user wants
- Each teammate's `model` comes from the model-routing CLI at spawn time (Step 3) - never hardcode a model name here
- All 5 representatives are spawned IN PARALLEL for speed
- The roster banner is shown IMMEDIATELY (before teammates respond)
- NO hero titles or cringey names - use plain role descriptions only
- Banner shows full 26-agent roster, but only 5 representatives actually spawn

## Next Steps

작업 완료 후 추천 후속 액션:

| # | 액션 | 커맨드 | 설명 |
|---|------|--------|------|
| 1 | 팀 작업 배정 | `/team` | 소환된 팀에 작업 배정 |
| 2 | 워크플로우 실행 | `/orchestrate` | 멀티에이전트 워크플로우 구성 |
| 3 | 작업 등록 | `/task` | 팀 작업 항목 등록 |
