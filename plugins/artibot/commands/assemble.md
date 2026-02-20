---
description: "Avengers Assemble! - Easter egg that summons the full Artibot agent team using real Agent Teams API"
argument-hint: '"어벤저스 어셈블!"'
allowed-tools: [Read, Glob, Grep, TeamCreate, SendMessage, TaskCreate, TaskUpdate, TaskList, TaskGet, Task, TeamDelete]
---

# /artibot:assemble

Easter egg command. When triggered, creates a **real Agent Team** and spawns teammates who introduce themselves.

## Trigger Phrases

- "어벤저스 어셈블"
- "Avengers Assemble"

## Execution Flow

### Step 1: Create Team

```
TeamCreate(team_name="avengers", description="Artibot Avengers Assemble! Full team introduction.")
```

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

Spawn **one agent per category** (5 total, haiku model for speed) into the "avengers" team. Each teammate introduces themselves with their role and specialty in plain Korean. Launch ALL 5 in parallel:

```
Task(architect, team_name="avengers", name="architect", model="haiku",
  prompt="Artibot 팀에 소환되었습니다.
  한국어 1-2문장으로 자기소개해주세요. 역할: 시스템 설계 및 아키텍처 결정.
  담당 분야와 준비 상태를 간단히 말해주세요.")

Task(code-reviewer, team_name="avengers", name="code-reviewer", model="haiku",
  prompt="Artibot 팀에 소환되었습니다.
  한국어 1-2문장으로 자기소개해주세요. 역할: 코드 리뷰 및 품질 검증.
  담당 분야와 준비 상태를 간단히 말해주세요.")

Task(backend-developer, team_name="avengers", name="backend-dev", model="haiku",
  prompt="Artibot 팀에 소환되었습니다.
  한국어 1-2문장으로 자기소개해주세요. 역할: API 설계 및 서버 로직 구현.
  담당 분야와 준비 상태를 간단히 말해주세요.")

Task(security-reviewer, team_name="avengers", name="security-reviewer", model="haiku",
  prompt="Artibot 팀에 소환되었습니다.
  한국어 1-2문장으로 자기소개해주세요. 역할: 보안 취약점 탐지 및 대응.
  담당 분야와 준비 상태를 간단히 말해주세요.")

Task(tdd-guide, team_name="avengers", name="tdd-guide", model="haiku",
  prompt="Artibot 팀에 소환되었습니다.
  한국어 1-2문장으로 자기소개해주세요. 역할: 테스트 주도 개발 가이드.
  담당 분야와 준비 상태를 간단히 말해주세요.")
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
If the user wants to dismiss: send shutdown_request to all teammates, then TeamDelete("avengers").

## Important Notes

- This is a FUN easter egg but uses REAL Agent Teams infrastructure
- The team persists and can accept real work if the user wants
- Use haiku model for all spawned teammates to minimize cost
- All 5 representatives are spawned IN PARALLEL for speed
- The roster banner is shown IMMEDIATELY (before teammates respond)
- NO hero titles or cringey names - use plain role descriptions only
- Banner shows full 26-agent roster, but only 5 representatives actually spawn
