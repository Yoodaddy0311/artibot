# Artibot 팀/워크플로우 시스템 분석 및 설계서

> 분석 대상: 4개 GitHub 레포의 팀 운영 패턴
> 작성: plugin-dev-2
> 날짜: 2026-02-13

---

## 1. 4개 레포 팀 시스템 비교 분석

### 1.1 bkit-claude-code (가장 정교한 팀 시스템)

**핵심 아키텍처**: CTO-Led PDCA 기반 팀 오케스트레이션

| 구성요소 | 파일 | 역할 |
|----------|------|------|
| Team Index | `lib/team/index.js` | 39개 export의 배럴 모듈 |
| Coordinator | `lib/team/coordinator.js` | 팀 가용성 확인, 설정 관리, 자동 제안 |
| Strategy | `lib/team/strategy.js` | 레벨별(Starter/Dynamic/Enterprise) 팀 구성 정의 |
| Orchestrator | `lib/team/orchestrator.js` | PDCA 단계별 팀 편성, spawnTeam 명령 생성 |
| Communication | `lib/team/communication.js` | 메시지 타입 정의, 브로드캐스트, 지시/승인/거절 |
| Task Queue | `lib/team/task-queue.js` | 태스크 생성/배정/추적/완료 확인 |
| CTO Logic | `lib/team/cto-logic.js` | PDCA 단계 결정, 문서 평가, 팀 구성 추천 |
| Hooks | `lib/team/hooks.js` | TaskCompleted/TeammateIdle 이벤트 처리 |
| State Writer | `lib/team/state-writer.js` | 디스크 영속화 (agent-state.json) |

**팀 전략 패턴**:

```
Starter: 팀 없음 (단일 세션)
Dynamic: 3명 (developer, frontend, qa) + CTO
Enterprise: 5명 (architect, developer, qa, reviewer, security) + CTO
```

**오케스트레이션 패턴**:

| 패턴 | 사용 시점 | 설명 |
|------|----------|------|
| leader | Plan, Act | CTO가 분배, 팀원 실행 |
| council | Design, Check | 다중 관점 필요 |
| swarm | Do | 대규모 병렬 구현 |
| pipeline | Plan->Design->Do | 순차 의존성 |
| watchdog | Check (지속) | 지속적 모니터링 |

**훅 시스템**:

| 훅 이벤트 | 핸들러 | 동작 |
|-----------|--------|------|
| SubagentStart | `subagent-start-handler.js` | agent-state.json 초기화, 팀원 등록 |
| SubagentStop | `subagent-stop-handler.js` | 상태 업데이트, 진행률 갱신 |
| TeammateIdle | `team-idle-handler.js` | 다음 태스크 검색/배정 |
| TaskCompleted | `pdca-task-completed.js` | 진행률 업데이트, 단계 전환 |
| Stop | `unified-stop.js` | agent-state.json 정리 |
| UserPromptSubmit | `user-prompt-handler.js` | 의도 감지, 에이전트 라우팅 |

**CTO 에이전트 특징**:
- model: opus (최상위 추론 모델)
- 10개 서브에이전트에 Task() 위임 가능
- planModeRequired: true (계획 검토 후 실행)
- 스킬: pdca, enterprise, bkit-rules 프리로드

**팀 상태 영속화** (agent-state.json):
- 원자적 쓰기 (tmp + rename)
- 최대 10명 팀원, 50개 메시지 링 버퍼
- 세션 종료 시 enabled=false, 진행률/메시지 보존

---

### 1.2 everything-claude-code (에이전트 파이프라인)

**핵심 아키텍처**: 순차/병렬 에이전트 파이프라인 + 멀티모델 협업

**에이전트 구성** (13개):

| 에이전트 | 모델 | 역할 |
|----------|------|------|
| planner | opus | 기능 계획, 리팩토링 계획 |
| architect | opus | 시스템 설계 |
| tdd-guide | sonnet | TDD 워크플로우 |
| code-reviewer | sonnet | 코드 리뷰 |
| security-reviewer | sonnet | 보안 분석 |
| build-error-resolver | sonnet | 빌드 오류 해결 |
| e2e-runner | sonnet | E2E 테스트 |
| refactor-cleaner | sonnet | 데드코드 정리 |
| doc-updater | sonnet | 문서 업데이트 |
| database-reviewer | sonnet | DB 리뷰 |
| go-reviewer | sonnet | Go 코드 리뷰 |
| go-build-resolver | sonnet | Go 빌드 오류 |
| python-reviewer | sonnet | Python 리뷰 |

**오케스트레이션 명령** (`/orchestrate`):

```
feature: planner -> tdd-guide -> code-reviewer -> security-reviewer
bugfix:  planner -> tdd-guide -> code-reviewer
refactor: architect -> code-reviewer -> tdd-guide
security: security-reviewer -> code-reviewer -> architect
custom: [사용자 지정 에이전트 체인]
```

**핸드오프 문서 패턴**:
```markdown
## HANDOFF: [previous-agent] -> [next-agent]
### Context / Findings / Files Modified / Open Questions / Recommendations
```

**멀티모델 협업** (`/multi-plan`, `/multi-execute`):
- Codex (백엔드) + Gemini (프론트엔드) 병렬 분석
- Claude가 최종 코드 주권 (Code Sovereignty)
- 세션 ID 핸드오프로 컨텍스트 재사용
- 5단계: Context Retrieval -> Analysis -> Prototype -> Implement -> Audit

**핵심 규칙**:
- 병렬 실행 우선: 독립 작업은 항상 병렬
- 즉시 에이전트 활성화: 복잡 기능 -> planner, 코드 수정 -> code-reviewer
- 멀티 관점 분석: Factual/Senior/Security/Consistency/Redundancy 에이전트

---

### 1.3 cc-wf-studio (스펙킷 워크플로우)

**핵심 아키텍처**: 스펙 기반 순차 워크플로우 + 코드 리뷰 스킬

**워크플로우 명령** (speckit 시리즈):

| 명령 | 역할 | 산출물 |
|------|------|--------|
| speckit.clarify | 요구사항 명확화 | 명확화된 요구사항 |
| speckit.specify | 스펙 작성 | spec.md |
| speckit.plan | 구현 계획 | plan.md, research.md, data-model.md |
| speckit.tasks | 태스크 분해 | tasks.md |
| speckit.checklist | 체크리스트 | checklists/*.md |
| speckit.implement | 구현 실행 | 코드 구현 |
| speckit.analyze | 분석 | 분석 보고서 |
| speckit.constitution | 헌법(규칙) | constitution.md |

**코드 리뷰 스킬** (크기별):

| 스킬 | 대상 | 범위 |
|------|------|------|
| code-review-small | <100줄 PR | 기본 품질, 명명 |
| code-review-medium | 100-500줄 PR | 품질, 보안, 커버리지 |
| code-review-large | >500줄 PR | 아키텍처, 성능, 보안, 유지보수 |

**speckit.implement 실행 패턴**:
1. 전제조건 검사 (스크립트)
2. 체크리스트 상태 확인
3. 컨텍스트 로드 (tasks.md, plan.md, data-model.md 등)
4. 프로젝트 셋업 검증
5. 태스크 파싱 및 단계별 실행
6. TDD 접근 (테스트 -> 구현)
7. 진행 추적 및 오류 처리
8. 완료 검증

**특징**:
- 스크립트 기반 자동화 (`.specify/scripts/bash/`)
- 에이전트 컨텍스트 자동 업데이트
- 헌법(constitution.md)으로 프로젝트 규칙 강제

---

### 1.4 ui-ux-pro-max-skill (순수 스킬 플러그인)

**핵심 아키텍처**: 데이터 기반 스킬 + CLI 설치

**구조**:
```
.claude/skills/ui-ux-pro-max/
  SKILL.md      -- 스킬 정의 (검색 가이드)
  data/         -- CSV 데이터베이스 (심링크)
  scripts/      -- Python 검색 엔진 (심링크)
```

**특징**:
- 팀 시스템 없음 (순수 스킬 제공)
- BM25 검색 엔진으로 디자인 데이터 쿼리
- 9개 플랫폼 지원 (Claude, Cursor, Copilot 등)
- CLI 설치기 (`uipro init`)
- `.claude-plugin/plugin.json`으로 마켓플레이스 배포

---

## 2. 패턴 종합 분석

### 2.1 팀 생성/소환/해체 패턴

| 레포 | 생성 | 소환 | 해체 |
|------|------|------|------|
| bkit | PDCA 단계별 자동 편성 | `composeTeamForPhase()` -> `generateSpawnTeamCommand()` | `cleanupAgentState()` |
| everything | 명령 기반 (`/orchestrate`) | 순차 에이전트 체인 | 최종 보고서 후 종료 |
| cc-wf-studio | 스펙 워크플로우 단계별 | speckit 명령 시리즈 | 구현 완료 시 종료 |
| ui-ux-pro-max | N/A | N/A | N/A |

**Artibot 설계 시사점**:
- bkit의 PDCA 단계별 자동 편성이 가장 체계적
- everything의 명시적 파이프라인이 이해하기 쉬움
- 두 패턴을 결합: **자동 편성 + 명시적 오버라이드**

### 2.2 서브에이전트 위임 전략

| 패턴 | bkit | everything |
|------|------|-----------|
| 병렬 위임 | swarm 패턴 (Do 단계) | 독립 에이전트 병렬 실행 |
| 순차 위임 | pipeline 패턴 | orchestrate 핸드오프 체인 |
| 의존성 관리 | PDCA 단계 게이트 | 에이전트 간 핸드오프 문서 |
| 모델 선택 | CTO=opus, 팀원=sonnet | planner/architect=opus, 나머지=sonnet |

**Artibot 설계 시사점**:
- opus는 팀장/아키텍트에만, sonnet은 실행 에이전트에
- 핸드오프 문서로 컨텍스트 전달 표준화
- blockedBy 의존성으로 태스크 순서 강제

### 2.3 태스크 관리 워크플로우

| 단계 | bkit | everything | cc-wf-studio |
|------|------|-----------|-------------|
| 생성 | `createTeamTasks()` | 에이전트 프롬프트 내 | `speckit.tasks` 명령 |
| 배정 | `assignTaskToRole()` | 오케스트레이션 순서 | 단계별 자동 실행 |
| 추적 | `getTeamProgress()` | 핸드오프 문서 | 체크리스트 체크박스 |
| 완료 | `isPhaseComplete()` | 최종 보고서 | `[X]` 마킹 |

**Artibot 설계 시사점**:
- TaskCreate/TaskUpdate/TaskList API 적극 활용
- 진행률 자동 추적 (completedTasks / totalTasks)
- 단계 완료 게이트: 전 태스크 완료 확인 후 다음 단계

### 2.4 커뮤니케이션 프로토콜

| 레포 | 메시지 타입 | 방향 |
|------|-----------|------|
| bkit | task_assignment, review_request, approval, rejection, phase_transition, status_update, directive, info | CTO -> 팀원, broadcast |
| everything | 핸드오프 문서 (Context, Findings, Open Questions, Recommendations) | 에이전트 -> 에이전트 |
| cc-wf-studio | 스크립트 stdout | 시스템 -> 에이전트 |

**Artibot 설계 시사점**:
- SendMessage 도구로 1:1 및 broadcast 통신
- 구조화된 메시지: subject + body + feature + phase + references
- 팀장의 plan_approval_response로 계획 승인/거절

### 2.5 플레이북/프로토콜 패턴

**bkit PDCA 플레이북**:
```
Plan -> Design -> Do -> Check -> Act -> (iterate)
                                    -> Report (matchRate >= 90%)
```

**everything 오케스트레이션 플레이북**:
```
feature: planner -> tdd-guide -> code-reviewer -> security-reviewer -> REPORT
bugfix:  planner -> tdd-guide -> code-reviewer -> REPORT
refactor: architect -> code-reviewer -> tdd-guide -> REPORT
```

**cc-wf-studio speckit 플레이북**:
```
clarify -> specify -> plan -> tasks -> checklist -> implement -> analyze
```

---

## 3. Artibot 팀 시스템 설계

### 3.1 설계 원칙

1. **Vibe Coding 최적화**: 최소 설정으로 즉시 팀 소환 가능
2. **점진적 복잡성**: 간단한 작업은 단일 에이전트, 복잡한 작업만 팀
3. **명시적 제어**: 자동 편성 + 사용자 오버라이드
4. **상태 투명성**: 실시간 진행률, 팀원 상태, 메시지 추적

### 3.2 팀 구성 레벨

```yaml
solo:        # 단순 작업 (1명)
  teammates: 0
  trigger: "단일 파일 수정, 간단한 질문"

squad:       # 소규모 팀 (2-3명)
  teammates: 3
  trigger: "기능 구현, 버그 수정"
  roles: [developer, reviewer, tester]

platoon:     # 대규모 팀 (4-5명)
  teammates: 5
  trigger: "대규모 기능, 아키텍처 변경"
  roles: [architect, developer, reviewer, tester, security]
```

### 3.3 오케스트레이션 패턴

| 패턴 | 설명 | 사용 시점 |
|------|------|----------|
| `leader` | 팀장 분배, 팀원 실행 | 계획, 결정 단계 |
| `swarm` | 병렬 실행 | 구현, 테스트 단계 |
| `pipeline` | 순차 체인 + 핸드오프 | feature 워크플로우 |
| `council` | 다중 관점 리뷰 | 설계, 검증 단계 |
| `watchdog` | 지속 모니터링 | 품질 게이트 |

### 3.4 플레이북 (워크플로우 템플릿)

**feature 플레이북**:
```
[leader] plan -> [council] design -> [swarm] implement -> [council] review -> [leader] merge
```

**bugfix 플레이북**:
```
[leader] analyze -> [pipeline] fix -> [council] verify
```

**refactor 플레이북**:
```
[council] assess -> [pipeline] refactor -> [swarm] test -> [council] review
```

### 3.5 훅 통합 설계

```json
{
  "hooks": {
    "SubagentStart": ["팀원 등록, 상태 초기화"],
    "SubagentStop": ["상태 업데이트, 진행률 갱신"],
    "TeammateIdle": ["다음 태스크 배정"],
    "TaskCompleted": ["진행률 업데이트, 다음 단계 판단"],
    "UserPromptSubmit": ["의도 감지, 팀 자동 소환 판단"],
    "Stop": ["상태 정리, 세션 종료"]
  }
}
```

### 3.6 에이전트 역할 설계

| 역할 | 모델 | 도구 | 용도 |
|------|------|------|------|
| team-lead | opus | Task, Read, Write, Edit, Glob, Grep, Bash | 전략 결정, 팀 관리 |
| architect | opus | Read, Glob, Grep, Task(Explore) | 아키텍처 설계 |
| developer | sonnet | Read, Write, Edit, Bash, Glob | 구현 |
| reviewer | sonnet | Read, Grep, Glob | 코드 리뷰 |
| tester | sonnet | Read, Write, Bash | 테스트 작성/실행 |
| security | sonnet | Read, Grep, Glob | 보안 분석 |

### 3.7 태스크 관리 워크플로우

```
1. TaskCreate: 팀장이 작업 분해 -> 태스크 생성
2. TaskUpdate(owner): 태스크를 팀원에게 배정
3. TaskUpdate(addBlockedBy): 의존성 설정
4. SendMessage: 팀원에게 작업 지시
5. TaskUpdate(in_progress): 팀원이 작업 시작
6. TaskUpdate(completed): 팀원이 작업 완료 + 결과 보고
7. TaskList: 팀장이 진행 상황 확인
8. 반복 (미완료 태스크가 없을 때까지)
```

### 3.8 커뮤니케이션 프로토콜

```yaml
message_types:
  task_assignment: "팀장 -> 팀원: 작업 배정"
  status_report: "팀원 -> 팀장: 진행 보고"
  review_request: "팀원 -> 리뷰어: 리뷰 요청"
  approval: "팀장 -> 팀원: 계획 승인"
  rejection: "팀장 -> 팀원: 계획 거절 + 피드백"
  phase_transition: "팀장 -> broadcast: 단계 전환"
  shutdown_request: "팀장 -> 팀원: 종료 요청"

protocol_rules:
  - "팀원은 완료 시 반드시 팀장에게 보고"
  - "팀장은 모든 태스크 완료 확인 후 다음 단계"
  - "broadcast는 긴급 사항에만 사용"
  - "핸드오프 시 Context + Findings + Open Questions 포함"
```

---

## 4. bkit 대비 Artibot 차별화 포인트

| 항목 | bkit | Artibot (제안) |
|------|------|---------------|
| 방법론 | PDCA 고정 | 플레이북 기반 (유연한 워크플로우) |
| 팀 구성 | 레벨 고정 (Starter/Dynamic/Enterprise) | 상황 기반 자동 편성 + 오버라이드 |
| CTO 역할 | 고정 에이전트 | team-lead 역할 (교체 가능) |
| 설정 | bkit.config.json (복잡) | 최소 설정, 자동 감지 |
| 영속화 | agent-state.json | Claude Code 네이티브 Task 시스템 활용 |
| 훅 | 커스텀 JS 핸들러 | hooks.json 표준 + 경량 스크립트 |
| 스킬 | 28개 (PDCA 단계별) | 핵심 스킬만 (확장 가능) |

---

## 5. 구현 우선순위

### Phase 1: 기반 시스템
1. 에이전트 정의 파일 (agents/*.md) - 6개 핵심 역할
2. 팀 구성 설정 (bkit.config.json 대응)
3. 플레이북 정의 (commands/*.md)

### Phase 2: 훅 통합
4. hooks.json 설정
5. SubagentStart/Stop 핸들러
6. TeammateIdle 핸들러
7. UserPromptSubmit 핸들러

### Phase 3: 플레이북 구현
8. feature/bugfix/refactor 플레이북
9. 태스크 관리 워크플로우
10. 커뮤니케이션 프로토콜

---

## 6. 핵심 발견사항 요약

1. **bkit이 가장 정교한 팀 시스템**: PDCA + CTO-Led + 상태 영속화
2. **everything-claude-code가 가장 실용적 파이프라인**: 명시적 에이전트 체인 + 멀티모델
3. **cc-wf-studio가 가장 체계적 스펙 워크플로우**: speckit 시리즈
4. **ui-ux-pro-max는 순수 스킬**: 팀 시스템 없음, 데이터 기반

5. **공통 패턴**:
   - opus는 팀장/아키텍트에만, sonnet은 실행 에이전트
   - 병렬 실행 우선, 순차는 의존성이 있을 때만
   - 핸드오프 문서로 컨텍스트 전달
   - 훅 시스템으로 자동화 (SubagentStart/Stop/TeammateIdle)
   - `.claude-plugin/plugin.json`으로 마켓플레이스 배포

6. **Vibe Coding 최적화 핵심**:
   - 최소 설정 (자동 감지)
   - 즉시 팀 소환 (명령 하나로)
   - 자동 에이전트 라우팅 (의도 감지)
   - 실시간 진행률 추적
