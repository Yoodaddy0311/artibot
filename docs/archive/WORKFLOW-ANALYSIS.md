# WORKFLOW-ANALYSIS.md - SuperClaude 팀/위임/규정 워크플로우 분석 및 개선안

## 1. 현행 시스템 개요

### 1.1 프레임워크 구조 (현행)

```
SuperClaude Framework
├── CLAUDE.md          (Entry Point - 8개 파일 참조)
├── COMMANDS.md        (17개 슬래시 커맨드 정의)
├── FLAGS.md           (40+ 플래그 시스템)
├── PRINCIPLES.md      (개발 원칙/윤리)
├── RULES.md           (운영 규칙 - 간결)
├── MCP.md             (4개 MCP 서버 통합)
├── PERSONAS.md        (11개 페르소나)
├── ORCHESTRATOR.md    (라우팅/위임/검증)
├── MODES.md           (3개 운영 모드)
├── rules/             (8개 규칙 파일)
│   ├── agents.md
│   ├── coding-style.md
│   ├── git-workflow.md
│   ├── hooks.md
│   ├── patterns.md
│   ├── performance.md
│   ├── security.md
│   └── testing.md
└── agents/            (33개 에이전트 정의)
    ├── [기본 10개]: architect, planner, code-reviewer, security-reviewer,
    │   build-error-resolver, e2e-runner, refactor-cleaner, doc-updater, tdd-guide
    ├── [전문 도메인 13개]: frontend-developer, backend-developer, fullstack-developer,
    │   react-specialist, typescript-pro, devops-engineer, api-designer, ui-designer,
    │   mcp-developer, performance-engineer, kubernetes-specialist, database-reviewer,
    │   technical-writer
    ├── [AI/LLM 3개]: llm-architect, prompt-engineer, autonomous-developer
    ├── [관리 3개]: project-manager, product-manager, scrum-master
    ├── [콘텐츠 1개]: content-marketer
    ├── [메타 3개]: sub-agent-architect, refactoring-specialist, git-workflow-manager
    └── [문서 1개]: api-documenter
```

### 1.2 팀 시스템 활성화 상태

```json
// settings.json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"  // 팀 시스템 활성화됨
  },
  "enabledPlugins": {
    "context7@claude-plugins-official": true,
    "code-review@claude-plugins-official": true,
    "github@claude-plugins-official": true,
    "ralph-loop@claude-plugins-official": true,
    "figma@claude-plugins-official": true,
    "bkit@bkit-marketplace": true
  }
}
```

---

## 2. 워크플로우 분석

### 2.1 팀 생성 -> 태스크 배정 -> 실행 -> 완료 워크플로우

#### 현행 워크플로우 (관찰 결과)

```
[사용자 요청]
    │
    ▼
[팀 리드 (메인 에이전트)]
    │
    ├─ TaskCreate() → 태스크 생성 (pending)
    ├─ SendMessage() → 팀원에게 역할/지시 전달
    │
    ▼
[팀원 에이전트들] (병렬 실행)
    │
    ├─ TaskList() → 배정된 태스크 확인
    ├─ TaskGet() → 태스크 세부사항 조회
    ├─ TaskUpdate(in_progress) → 작업 시작
    ├─ [도구 사용하여 분석/실행]
    ├─ TaskUpdate(completed) → 완료 보고
    └─ SendMessage(team-lead) → 결과 보고
```

#### 발견된 문제점

| 문제 | 심각도 | 설명 |
|------|--------|------|
| **태스크 폭증** | HIGH | 현재 21개 태스크가 모두 in_progress 상태. 완료/정리 메커니즘 부재 |
| **상태 추적 혼란** | HIGH | 동일 에이전트명의 중복 태스크 존재 (architect, architect-2 등) |
| **완료 기준 부재** | MEDIUM | 태스크 완료 조건이 명확히 정의되지 않음 |
| **의존성 관리 부재** | MEDIUM | addBlockedBy/addBlocks 미활용, 태스크 간 순서 보장 없음 |
| **보고 프로토콜 미정** | MEDIUM | 팀원 -> 팀 리드 보고 형식/타이밍 비표준화 |

### 2.2 서브에이전트 위임 전략 (Wave, Loop, Spawn) 분석

#### Wave 시스템

**정의 위치**: ORCHESTRATOR.md, COMMANDS.md, FLAGS.md
**활성화 조건**: complexity >= 0.7 AND files > 20 AND operation_types > 2

**현행 구조**:
```yaml
wave_strategies:
  progressive:  "점진적 개선"
  systematic:   "체계적 분석"
  adaptive:     "동적 구성"
  enterprise:   "대규모 (100+ files)"

wave_delegation:
  files:    "파일 단위 위임"
  folders:  "디렉토리 단위 위임"
  tasks:    "태스크 유형별 위임"

wave_specialization:
  Review     → analyzer persona
  Planning   → architect persona
  Implementation → intelligent persona (?)
  Validation → qa persona
  Optimization → performance persona
```

**문제점**:
- "intelligent persona"가 정의되지 않음 (Implementation 단계)
- Wave 단계 간 데이터 전달 메커니즘 미명시
- 5단계 Wave (review-plan-implement-validate-optimize) 실행 시 context 소모 예측 불가
- Wave 스코어링이 이론적 수치이며 실제 검증 데이터 부재

#### Loop 시스템

**정의 위치**: FLAGS.md (--loop), MODES.md (Layer 4)
**활성화 조건**: polish, refine, enhance 키워드 감지

**현행 구조**:
```yaml
loop_config:
  default_iterations: 3
  max_iterations: 10
  validation_per_iteration: true
  interactive_mode: optional (--interactive)
```

**문제점**:
- 반복 간 개선 측정 지표 없음
- "충분히 개선됨" 판단 기준 없음 (언제 루프 종료?)
- 토큰 예산 소진 시 행동 정책 미정의

#### Spawn 시스템

**정의 위치**: COMMANDS.md (/spawn), MODES.md (Layer 3)
**설명**: "Complex multi-domain operations", "Parallel/sequential coordination"

**문제점**:
- /spawn 커맨드의 구체적 실행 로직 없음 (선언만 존재)
- 병렬 실행 시 리소스 경합 관리 미정의
- 서브에이전트 종료 조건/타임아웃 미정의

### 2.3 업무 규정(rules/) 구조 분석

#### 현행 8개 규칙 파일 매핑

| 파일 | 목적 | 토큰 비용 | 활용도 |
|------|------|----------|--------|
| agents.md | 에이전트 목록/용도 | LOW | 참조 안내서 역할 |
| coding-style.md | 코딩 스타일 규칙 | LOW | 핵심 규칙 (불변성, 파일 크기) |
| git-workflow.md | Git 커밋/PR 워크플로우 | LOW | 커밋 메시지 형식 정의 |
| hooks.md | Hook 시스템 설명 | LOW | PreToolUse/PostToolUse 안내 |
| patterns.md | 코드 패턴 참조 | LOW | API Response, Repository 패턴 |
| performance.md | 성능 최적화 가이드 | LOW | 모델 선택, 컨텍스트 관리 |
| security.md | 보안 가이드라인 | LOW | 보안 체크리스트 |
| testing.md | 테스트 요구사항 | LOW | TDD 워크플로우, 80% 커버리지 |

#### 문제점

1. **중복**: PERSONAS.md의 persona 정의와 agents/ 디렉토리의 agent 정의가 상당 부분 겹침
   - PERSONAS.md: 11개 페르소나 (architect, frontend, backend, analyzer, security, mentor, refactorer, performance, qa, devops, scribe)
   - agents/: 33개 에이전트 (위 페르소나와 유사한 역할 다수 포함)
   - 예: `--persona-architect` vs `agents/architect.md` vs `agents/sub-agent-architect.md`

2. **레이어 혼란**:
   - Persona (PERSONAS.md) = 메인 에이전트의 행동 모드 전환
   - Agent (agents/) = Task tool로 생성되는 독립 서브에이전트
   - 두 시스템의 관계/우선순위가 불명확

3. **규칙 분산**:
   - RULES.md (핵심 규칙) + rules/ (세부 규칙) + PRINCIPLES.md (원칙) + ORCHESTRATOR.md (검증 게이트)
   - 동일 주제가 여러 파일에 걸쳐 정의됨

4. **팀 시스템 규칙 부재**:
   - Agent Teams 환경에서의 규칙이 rules/agents.md에만 간략히 기술
   - 팀 리드/팀원 간 프로토콜 미정의
   - 팀 해체/종료 절차 없음

### 2.4 팀 간 커뮤니케이션 패턴 분석

#### 현행 도구

| 도구 | 용도 | 제한 |
|------|------|------|
| SendMessage(message) | 1:1 메시지 | 수신자 명시 필요 |
| SendMessage(broadcast) | 전체 메시지 | 비용 높음 (N명 x N 메시지) |
| SendMessage(shutdown_request) | 종료 요청 | 승인/거부 프로토콜 |
| TaskCreate/Update/Get/List | 태스크 관리 | 상태 기반 조율 |

#### 커뮤니케이션 패턴 문제점

1. **단방향 편중**: 팀 리드 -> 팀원 지시는 명확하나, 팀원 -> 팀 리드 보고가 비구조적
2. **팀원 간 직접 소통 미활용**: 팀원끼리 SendMessage 가능하나 프로토콜 없음
3. **상태 동기화 지연**: TaskList만으로는 실시간 진행 상황 파악 어려움
4. **broadcast 남용 위험**: 지침에 "USE SPARINGLY"이라 했지만 기준 없음

---

## 3. 개선안

### 3.1 태스크 라이프사이클 표준화

#### 제안: 5-State 태스크 모델

```
pending → assigned → in_progress → review → completed
                  ↘ blocked ↗
                  ↘ cancelled
```

#### 태스크 생성 템플릿

```yaml
task:
  id: auto
  subject: "[동사형] 명확한 작업 설명"
  description: |
    ## 목표
    [구체적 달성 목표]

    ## 산출물
    - [예상 결과물 1]
    - [예상 결과물 2]

    ## 완료 기준
    - [ ] 기준 1
    - [ ] 기준 2

    ## 의존성
    - blockedBy: [task_ids]
    - blocks: [task_ids]
  owner: "[agent-name]"
  activeForm: "[동사-ing 형태]"
  priority: HIGH|MEDIUM|LOW
  estimated_tokens: number
```

#### 팀원 보고 프로토콜

```yaml
report_protocol:
  start:
    action: "TaskUpdate(in_progress) + SendMessage(team-lead)"
    content: "태스크 #{id} 시작. 예상 산출물: [목록]"

  progress:
    trigger: "50% 이상 진행 또는 블로커 발견 시"
    action: "SendMessage(team-lead)"
    content: "진행 상황: [%], 발견사항: [요약], 블로커: [있으면]"

  complete:
    action: "TaskUpdate(completed) + SendMessage(team-lead)"
    content: |
      태스크 #{id} 완료.
      ## 산출물
      - [파일 경로와 내용 요약]
      ## 핵심 발견/결정
      - [항목]
      ## 후속 권장사항
      - [있으면]
```

### 3.2 Persona vs Agent 계층 통합

#### 제안: 3-Tier 역할 아키텍처

```
Tier 1: Personas (메인 에이전트 행동 모드)
  └─ 경량, 즉시 전환, 컨텍스트 내 동작
  └─ 용도: 단일 에이전트가 도메인 전문성 전환
  └─ 예: --persona-architect → 아키텍처 관점으로 사고

Tier 2: Task Agents (서브에이전트)
  └─ 독립 컨텍스트, 병렬 실행 가능
  └─ 용도: 복잡한 태스크를 병렬 분산 처리
  └─ 예: Task tool → code-reviewer agent 생성

Tier 3: Team Agents (팀 시스템)
  └─ 지속적 존재, 상호 메시징, 태스크 공유
  └─ 용도: 대규모 프로젝트 다중 역할 협업
  └─ 예: /spawn → architect + developer + reviewer 팀 구성
```

#### 현재 중복 매핑 및 정리안

| Persona (PERSONAS.md) | Agent (agents/) | 정리 방향 |
|----------------------|-----------------|----------|
| --persona-architect | architect.md, sub-agent-architect.md | architect.md 유지, sub-agent-architect.md는 별도 용도로 유지 |
| --persona-frontend | frontend-developer.md, react-specialist.md, ui-designer.md | frontend-developer.md 통합, 나머지는 전문 서브에이전트 |
| --persona-backend | backend-developer.md, api-designer.md | backend-developer.md 통합 |
| --persona-security | security-reviewer.md | 유지 (보안은 독립 검증 필요) |
| --persona-qa | tdd-guide.md, e2e-runner.md | 모두 유지 (테스트 유형별 분화) |
| --persona-refactorer | refactoring-specialist.md, refactor-cleaner.md | refactoring-specialist.md로 통합 |
| --persona-devops | devops-engineer.md, kubernetes-specialist.md | devops-engineer.md 유지, k8s는 전문 서브에이전트 |
| --persona-scribe | technical-writer.md, doc-updater.md, api-documenter.md | technical-writer.md로 통합 |
| --persona-performance | performance-engineer.md | 유지 |
| --persona-mentor | (없음) | Persona 전용으로 유지 |
| --persona-analyzer | (없음) | Persona 전용으로 유지 |
| (없음) | project-manager.md, product-manager.md, scrum-master.md | 관리 에이전트 별도 카테고리 |
| (없음) | llm-architect.md, prompt-engineer.md, autonomous-developer.md | AI 전문 에이전트 별도 카테고리 |

### 3.3 위임 전략 개선

#### Wave 시스템 개선안

```yaml
wave_lifecycle:
  # Wave 시작 전 검증
  pre_wave:
    - context_budget_check: "남은 토큰 > wave_count * avg_wave_cost"
    - dependency_resolution: "모든 선행 조건 충족 확인"
    - rollback_point: "현재 상태 스냅샷"

  # Wave 실행
  wave_execution:
    phase_1_review:
      persona: analyzer
      output: "현황 분석 보고서"
      pass_to_next: "분석 결과 요약 (max 2K tokens)"

    phase_2_plan:
      persona: architect
      input: "phase_1 요약"
      output: "실행 계획"
      pass_to_next: "계획 요약 + 변경 대상 목록"

    phase_3_implement:
      persona: "도메인별 자동 선택"
      input: "phase_2 요약"
      output: "코드 변경사항"
      pass_to_next: "변경된 파일 목록 + diff 요약"

    phase_4_validate:
      persona: qa
      input: "phase_3 요약"
      output: "검증 결과"
      gate: "통과하지 못하면 phase_3로 회귀"

  # Wave 완료 후
  post_wave:
    - evidence_collection: "메트릭 수집"
    - context_cleanup: "불필요한 중간 결과 압축"
    - next_wave_assessment: "다음 Wave 필요성 판단"
```

#### Loop 시스템 개선안

```yaml
loop_lifecycle:
  entry_criteria:
    - target_metric_defined: true  # "무엇을 개선할 것인가"
    - baseline_measured: true       # "현재 수치는 얼마인가"
    - improvement_threshold: 0.05   # "5% 이상 개선 시 계속"

  iteration:
    - measure: "현재 메트릭 측정"
    - analyze: "개선 가능 영역 식별"
    - improve: "가장 영향력 큰 변경 적용"
    - validate: "메트릭 재측정"
    - decide:
        continue_if: "improvement > threshold AND iteration < max"
        stop_if: "improvement < threshold OR diminishing_returns"

  exit_criteria:
    - improvement_plateau: "최근 2회 반복 개선률 < 1%"
    - token_budget: "예산의 80% 소진"
    - max_iterations: "설정된 최대 반복 횟수 도달"
    - user_interrupt: "사용자가 명시적으로 중단 요청"
```

#### Spawn 시스템 구체화

```yaml
spawn_lifecycle:
  # 팀 구성
  formation:
    trigger: "/spawn 또는 자동 감지"
    steps:
      1: "작업 분석 → 필요 역할 식별"
      2: "에이전트 선정 → 역할 매핑"
      3: "태스크 생성 → 의존성 설정"
      4: "팀원 메시징 → 역할/지시 전달"

  # 실행 패턴
  execution_patterns:
    parallel:
      condition: "독립적 태스크 3개 이상"
      max_concurrent: 7
      coordination: "TaskList 기반 상태 모니터링"

    sequential:
      condition: "의존성 체인 존재"
      handoff: "이전 태스크 output → 다음 태스크 input"

    hybrid:
      condition: "부분적 의존성"
      strategy: "독립 태스크 병렬 + 의존 태스크 순차"

  # 종료
  termination:
    conditions:
      - all_tasks_completed: true
      - critical_failure: "복구 불가능한 오류"
      - user_cancel: "사용자 명시 취소"
      - timeout: "설정된 제한 시간 초과"
    cleanup:
      - send_shutdown_requests: "모든 팀원에게"
      - collect_results: "최종 산출물 취합"
      - generate_summary: "전체 결과 요약 보고"
      - close_tasks: "미완료 태스크 정리"
```

### 3.4 규칙 구조 개선안

#### 현행 문제: 규칙 분산

```
규칙 관련 정보가 5곳에 분산:
1. RULES.md          → 핵심 운영 규칙
2. PRINCIPLES.md     → 개발 원칙
3. ORCHESTRATOR.md   → 검증 게이트, 라우팅 규칙
4. MODES.md          → 운영 모드 규칙
5. rules/            → 세부 도메인 규칙
```

#### 제안: 계층적 규칙 구조

```
rules/
├── core.md           # RULES.md에서 추출한 핵심 규칙 (불변)
├── team-protocol.md  # [신규] 팀 시스템 프로토콜
├── delegation.md     # [신규] 위임 전략 (Wave/Loop/Spawn)
├── agents.md         # 기존 유지 + 팀 에이전트 가이드 추가
├── coding-style.md   # 기존 유지
├── git-workflow.md   # 기존 유지
├── hooks.md          # 기존 유지
├── patterns.md       # 기존 유지
├── performance.md    # 기존 유지
├── security.md       # 기존 유지
└── testing.md        # 기존 유지
```

#### 신규 rules/team-protocol.md 핵심 내용

```yaml
team_protocol:
  formation:
    - "팀 구성 시 각 역할의 책임 범위를 TaskCreate description에 명시"
    - "의존성이 있는 태스크는 addBlockedBy로 연결"
    - "모든 태스크에 activeForm과 완료 기준 포함"

  communication:
    - "팀원은 작업 시작/50%/완료 시점에 팀 리드에게 SendMessage"
    - "broadcast는 긴급 차단 이슈에만 사용"
    - "팀원 간 직접 메시지는 데이터 공유 목적에 한함"
    - "보고 시 산출물 파일 경로를 절대 경로로 포함"

  task_management:
    - "한 에이전트당 active(in_progress) 태스크 1개"
    - "완료 시 반드시 TaskUpdate(completed) + 결과 SendMessage"
    - "블로커 발견 시 즉시 보고 (SendMessage) + 태스크에 blocked 사유 기록"
    - "중복 태스크명 금지 (고유 식별자 포함)"

  termination:
    - "모든 태스크 완료 후 팀 리드가 shutdown_request 발송"
    - "팀원은 미완료 작업이 없을 때만 shutdown 승인"
    - "강제 종료 시 미완료 태스크 상태를 cancelled로 업데이트"
```

### 3.5 커뮤니케이션 패턴 최적화

#### 제안: 구조화된 메시지 프로토콜

```yaml
message_types:

  task_start:
    trigger: "TaskUpdate(in_progress) 시"
    format: |
      [START] Task #{id}: {subject}
      예상 산출물: {deliverables}
      예상 시간: {estimate}

  progress_update:
    trigger: "주요 마일스톤 달성 또는 블로커 발견"
    format: |
      [PROGRESS] Task #{id}: {subject}
      진행률: {percentage}%
      현재 상태: {status_summary}
      블로커: {blockers or "없음"}

  task_complete:
    trigger: "TaskUpdate(completed) 시"
    format: |
      [DONE] Task #{id}: {subject}
      산출물:
      - {file_path}: {description}
      핵심 결정:
      - {decisions}
      후속 권장:
      - {recommendations or "없음"}

  data_share:
    trigger: "다른 팀원에게 데이터 전달 필요 시"
    format: |
      [DATA] From: {sender} To: {recipient}
      관련 태스크: #{id}
      내용: {data_summary}
      참조 파일: {file_paths}

  escalation:
    trigger: "해결 불가능한 이슈"
    format: |
      [ESCALATE] Task #{id}: {subject}
      이슈: {description}
      시도한 해결책: {attempted}
      필요한 도움: {needed}
```

### 3.6 ORCHESTRATOR.md 핵심 문제점 및 개선안

#### 문제: 이론적 설계 vs 실행 가능성

현행 ORCHESTRATOR.md는 복잡한 스코어링 시스템과 매트릭스를 정의하지만:

1. **LLM에 수치 연산 의존**: Complexity 0.8, Delegation Score 0.6 등의 수치를 LLM이 정확히 계산할 수 없음
2. **검증 불가능한 8-Step Quality Gate**: 모든 작업에 8단계 검증을 적용하는 것은 비현실적
3. **과도한 자동화 의존**: auto-activation 조건이 너무 많아 어느 것이 실제 적용되는지 불투명

#### 개선 방향

```yaml
orchestrator_simplification:
  # 복잡한 수치 스코어링 → 명확한 분기 조건으로 대체
  routing:
    simple:
      condition: "단일 파일, 3단계 미만"
      action: "직접 실행, 서브에이전트 불필요"
    moderate:
      condition: "다수 파일, 단일 도메인"
      action: "적절한 persona 활성화 + 필요 시 1-2개 서브에이전트"
    complex:
      condition: "시스템 전체, 다중 도메인"
      action: "팀 구성 또는 Wave 모드"

  # 8-Step → 3-Step 핵심 검증으로 축소
  validation:
    step_1: "구문/타입 검증 (lint + typecheck)"
    step_2: "기능 검증 (테스트 실행)"
    step_3: "통합 검증 (빌드 + 보안 기본 체크)"

  # 자동 활성화 → 명시적 트리거 우선
  activation:
    principle: "명시적 플래그 > 키워드 기반 자동 활성화"
    documentation: "각 자동 활성화 조건에 대해 사용자에게 투명하게 알림"
```

---

## 4. 플러그인 전환 시 고려사항

### 4.1 현행 프롬프트 기반 시스템의 한계

| 한계 | 설명 |
|------|------|
| **컨텍스트 비용** | 8개 .md 파일 + rules/ 전체가 매 세션 로드됨 (수천 토큰) |
| **강제력 부재** | "규칙"이라 하지만 LLM이 무시할 수 있음 |
| **상태 비지속** | 세션 간 학습/기억 불가 (auto memory 별도) |
| **검증 불가** | 스코어링/메트릭이 실제 계산되지 않고 "느낌"으로 적용 |
| **확장성 한계** | 새 규칙/에이전트 추가 시 프롬프트 크기만 증가 |

### 4.2 플러그인 아키텍처에서의 워크플로우 개선 기회

```yaml
plugin_opportunities:

  structured_team_management:
    description: "팀 생성/태스크/커뮤니케이션을 프로그래밍적으로 관리"
    benefit: "프로토콜 강제 적용, 상태 추적 자동화"

  rule_enforcement:
    description: "규칙을 프롬프트가 아닌 코드로 적용"
    benefit: "hook 시스템과 연동하여 규칙 위반 방지"

  context_optimization:
    description: "필요한 규칙/에이전트만 동적 로드"
    benefit: "토큰 비용 50-70% 절감 가능"

  delegation_engine:
    description: "Wave/Loop/Spawn을 실행 가능한 코드로 구현"
    benefit: "이론적 설계에서 검증 가능한 실행으로 전환"

  metrics_tracking:
    description: "실제 성과 메트릭 수집/분석"
    benefit: "evidence-based 개선 가능"
```

---

## 5. 우선순위별 개선 로드맵

### Phase 1: 즉시 적용 (프롬프트 수준)
1. **태스크 완료 기준 표준화** - TaskCreate 시 description에 완료 기준 필수 포함
2. **보고 프로토콜 도입** - SendMessage 형식 표준화
3. **중복 태스크 방지** - 고유 식별자 사용

### Phase 2: 규칙 구조 개선
4. **rules/team-protocol.md 신규 작성** - 팀 시스템 프로토콜
5. **Persona-Agent 역할 정리** - 중복 해소
6. **ORCHESTRATOR.md 간소화** - 실행 가능한 수준으로 축소

### Phase 3: 플러그인 전환
7. **규칙 엔진 모듈** - 프로그래밍적 규칙 적용
8. **워크플로우 엔진 모듈** - Wave/Loop/Spawn 코드 구현
9. **컨텍스트 매니저 모듈** - 동적 규칙 로딩
10. **메트릭 수집 모듈** - 성과 추적

---

## 6. 결론

현행 SuperClaude 프레임워크는 **포괄적이고 정교한 설계**를 갖추고 있으나, 다음과 같은 구조적 문제가 존재한다:

1. **프롬프트 비대화**: 8개 핵심 파일 + 8개 규칙 파일 + 33개 에이전트 = 거대한 컨텍스트 부하
2. **이론-실행 괴리**: 수치 기반 스코어링과 자동 활성화가 LLM 환경에서 신뢰성 있게 동작하지 않음
3. **역할 중복**: Persona와 Agent 간 경계 불명확
4. **팀 프로토콜 부재**: Agent Teams 기능 활성화 대비 운영 규정 미비
5. **상태 관리 취약**: 태스크 폭증, 중복, 미정리 문제

**플러그인 전환은 이러한 한계를 극복할 핵심 기회**이며, 프롬프트 기반 "가이드라인"을 코드 기반 "규칙 엔진"으로 전환함으로써 강제성, 효율성, 측정 가능성을 확보할 수 있다.
