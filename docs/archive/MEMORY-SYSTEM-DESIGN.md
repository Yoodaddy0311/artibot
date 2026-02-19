# MEMORY-SYSTEM-DESIGN.md - Artibot 메모리 시스템 설계서

4개 레포 메모리/컨텍스트 패턴 비교 분석 및 Artibot 메모리 시스템 설계

---

## 1. 4개 레포 메모리/컨텍스트 패턴 비교 분석

### 1.1 레포별 메모리 전략 요약

| 레포 | 메모리 접근법 | 상태 관리 | 세션 지속성 | 자동 학습 |
|------|-------------|----------|------------|----------|
| **ui-ux-pro-max-skill** | 없음 (Stateless) | CSV 데이터 검색 전용 | 없음 | 없음 |
| **cc-wf-studio** | Constitution + CLAUDE.md | .specify/memory/ 디렉토리 | 없음 (워크플로우 JSON이 상태) | 없음 |
| **everything-claude-code** | /learn + /sessions + continuous-learning | ~/.claude/sessions/ + ~/.claude/skills/learned/ | 세션 파일 + alias 시스템 | Hook 기반 자동 패턴 추출 (v1/v2) |
| **bkit-claude-code** | FR-08 Memory + PDCA State + Context Hierarchy | .bkit-memory.json + .pdca-status.json | 4-Level Context Hierarchy | Hook 기반 Intent/Ambiguity 감지 |

### 1.2 상세 분석

#### 1.2.1 ui-ux-pro-max-skill - Stateless 패턴

**메모리 전략**: 없음
- 순수 도구형 플러그인: CSV 데이터베이스 검색 기능만 제공
- CLAUDE.md는 프로젝트 구조/사용법 안내 역할만 수행
- 상태 관리 불필요 (매 호출이 독립적)

**교훈**: 모든 플러그인에 메모리가 필요하지는 않음. 도구형 플러그인은 stateless가 효율적.

#### 1.2.2 cc-wf-studio - Constitution 패턴

**메모리 전략**: "프로젝트 헌법" 기반 품질 규범
- `.specify/memory/constitution.md`: 5개 핵심 원칙을 버전 관리하는 "헌법"
- 버전 관리: MAJOR.MINOR.PATCH (Semantic Versioning)
- 동기화 영향 보고서: 헌법 변경 시 영향받는 템플릿 목록 추적
- CLAUDE.md: 자동 생성됨 (feature plan에서 추출), "Design Decisions & Lessons Learned" 섹션 포함

**핵심 패턴**:
```yaml
constitution_pattern:
  structure:
    - core_principles: "불변 규칙 (코드 품질, TDD, UX, 성능, 보수성)"
    - development_workflow: "프로세스 규칙"
    - governance: "헌법 개정 프로세스"
  versioning: "semver"
  sync_impact_report: "변경 시 영향 범위 자동 추적"
```

**강점**: 규칙의 변경 이력과 영향 범위를 체계적으로 관리
**약점**: 세션 간 컨텍스트 전달 메커니즘 없음, 동적 학습 없음

#### 1.2.3 everything-claude-code - Instinct 학습 패턴

**메모리 전략**: 3-계층 학습 시스템

**Layer 1: /learn 커맨드 (수동 학습)**
```
세션 중 문제 해결 → /learn 실행 → 패턴 추출 → ~/.claude/skills/learned/ 에 저장
```
- 에러 해결 패턴, 디버깅 기법, 워크어라운드, 프로젝트 규칙 추출
- 사용자 확인 후 저장 (auto_approve: false)

**Layer 2: /sessions 커맨드 (세션 관리)**
```
~/.claude/sessions/  ← 세션 파일 저장소
~/.claude/session-aliases.json  ← 별칭 매핑
```
- 세션 나열, 로드, 별칭 관리 (list/load/alias/info)
- Node.js 라이브러리 (session-manager.js, session-aliases.js) 기반 구현
- 세션 통계: 줄 수, 항목 수, 완료/진행 중 카운트

**Layer 3: Continuous Learning v2 (자동 학습 - Instinct)**
```
Hook 관찰 (100%) → observations.jsonl → Haiku 분석 (백그라운드) → Instinct 생성 → 클러스터링 → Skill/Command/Agent 진화
```
- **Instinct 모델**: 원자적 학습 단위 (trigger + action + confidence)
- **Confidence 점수**: 0.3(잠정) ~ 0.9(확실), 감쇠율 적용
- **진화 경로**: instinct → cluster → skill/command/agent
- **공유**: export/import으로 instinct 교환 가능

**핵심 패턴**:
```yaml
instinct_pattern:
  observation: "PreToolUse/PostToolUse Hook (100% 신뢰도)"
  storage: "~/.claude/homunculus/observations.jsonl"
  analysis: "Haiku 모델 백그라운드 에이전트"
  unit: "Instinct (atomic: trigger + action + confidence + domain)"
  evolution: "instincts/ → evolved/skills|commands|agents"
  confidence:
    initial: 0.3
    auto_approve: 0.7
    max: 0.9
    decay_rate: 0.05
  sharing: "export/import instinct collections"
```

**강점**: 자동 학습, confidence 기반 신뢰도 관리, 진화 가능한 지식
**약점**: 복잡한 설정 필요, 백그라운드 에이전트 비용

#### 1.2.4 bkit-claude-code - Context Engineering 패턴

**메모리 전략**: 8개 기능 요구사항(FR-01~FR-08) 기반 종합 컨텍스트 관리

**FR-01: 4-Level Context Hierarchy**
```
L1: Plugin Policy (bkit.config.json)
  ↓ override
L2: User Config (~/.claude/bkit/user-config.json)
  ↓ override
L3: Project Config (${PROJECT_DIR}/bkit.config.json)
  ↓ override
L4: Session Context (in-memory runtime state)
```
- 우선순위: L4 > L3 > L2 > L1 (나중 레벨이 덮어씀)
- 구현: lib/context-hierarchy.js (282줄)

**FR-02: @import Directive**
- SKILL.md/Agent.md frontmatter에서 외부 컨텍스트 파일 로딩
- 변수 치환: ${PLUGIN_ROOT}, ${PROJECT}, ${USER_CONFIG}
- 순환 참조 감지, TTL 기반 캐싱

**FR-03: Context Fork Isolation**
- Skill/Agent가 격리된 컨텍스트 복사본에서 실행
- deep clone 기반 격리, 선택적 merge-back

**FR-07: Context Compaction Hook**
- PreCompact 이벤트에서 PDCA 상태 스냅샷 보존
- docs/.pdca-snapshots/ 에 저장, 최근 10개 유지

**FR-08: MEMORY Variable Support**
- 세션 지속 key-value 저장소
- 저장 위치: docs/.bkit-memory.json
- API: setMemory, getMemory, deleteMemory, getAllMemory, clearMemory
- 용도: 세션 카운터, 마지막 활성 기능, 사용자 선호, 크로스 세션 상태

**Agent Memory (v1.5.1)**
```yaml
agent_memory_scopes:
  project: ".claude/agent-memory/"     # 프로젝트별, 세션 간 지속
  user: "~/.claude/agent-memory/"      # 전역, 모든 프로젝트 간
  local: ".claude/agent-memory-local/" # 프로젝트별, 로컬 전용
```
- 9개 에이전트: project scope (code-analyzer, gap-detector 등)
- 2개 에이전트: user scope (starter-guide, pipeline-guide)

**PDCA 상태 관리**
```json
// .pdca-status.json
{
  "activeFeatures": [],
  "primaryFeature": "...",
  "features": {},
  "pipeline": {},
  "session": {}
}
```

**.bkit-memory.json 실제 데이터 예시**
```json
{
  "sessionCount": 104,
  "lastSession": { "startedAt": "...", "platform": "claude", "level": "Starter" },
  "lastReport": { "feature": "...", "date": "...", "path": "..." },
  "previousPDCA": { "feature": "...", "phase": "completed", "matchRate": 100 },
  "currentPDCA": { "feature": "...", "phase": "plan", "matchRate": null },
  "pipelineStatus": { "currentPhase": null, "completedPhases": [1..9] }
}
```

**핵심 패턴**:
```yaml
context_engineering_pattern:
  hierarchy: "4-Level 컨텍스트 우선순위 체계"
  isolation: "Context Fork로 에이전트 격리 실행"
  persistence: "JSON 기반 key-value 메모리"
  compaction: "컨텍스트 압축 시 상태 스냅샷 보존"
  state: "PDCA 라이프사이클 기반 프로젝트 상태 추적"
  agent_memory: "프로젝트/사용자/로컬 3-scope 에이전트 메모리"
```

**강점**: 가장 체계적인 컨텍스트 관리, 프로그래밍적 구현, 상태 추적
**약점**: 높은 복잡성, bkit 전용 PDCA 모델에 강하게 결합

---

## 2. 패턴별 비교 매트릭스

### 2.1 MEMORY.md 구조 비교

| 레포 | MEMORY.md | 구조 | 토큰 비용 |
|------|----------|------|----------|
| ui-ux-pro-max | 없음 | N/A | 0 |
| cc-wf-studio | 없음 (constitution.md 대체) | 헌법 + 버전 관리 | ~200줄 |
| everything-claude-code | 예시만 제공 (examples/CLAUDE.md) | 프로젝트 개요 + 규칙 + 패턴 | ~100줄 |
| bkit-claude-code | 없음 (.bkit-memory.json 대체) | JSON key-value | 구조화 |

### 2.2 세션 간 컨텍스트 전달 비교

| 방식 | 레포 | 장점 | 단점 |
|------|------|------|------|
| **파일 없음** | ui-ux-pro-max | 단순, 비용 없음 | 학습 불가 |
| **Constitution 파일** | cc-wf-studio | 규칙 추적, 거버넌스 | 동적 상태 없음 |
| **세션 파일** | everything-claude-code | 세션 복원 가능 | 파일 누적, 수동 관리 |
| **JSON 메모리** | bkit-claude-code | 구조화, 자동 갱신 | PDCA 결합 |
| **자동 메모리 디렉토리** | SuperClaude(현행) | 간편, 자동 로드 | 200줄 제한, 수동 관리 |

### 2.3 자동 학습 메커니즘 비교

| 방식 | 레포 | 트리거 | 신뢰도 관리 | 진화 |
|------|------|--------|------------|------|
| **없음** | ui-ux-pro-max, cc-wf-studio | N/A | N/A | N/A |
| **/learn 수동** | everything-claude-code v1 | Stop Hook (세션 종료) | 없음 | 직접 Skill 생성 |
| **Instinct 자동** | everything-claude-code v2 | Pre/PostToolUse Hook | Confidence 0.3~0.9 + decay | Instinct → Cluster → Skill/Agent |
| **Intent 감지** | bkit-claude-code | UserPromptSubmit Hook | Ambiguity Score | Agent/Skill 자동 트리거 |
| **패턴 기록** | SuperClaude(현행) | 수동 (사용자 요청 시) | "검증됨" 태그 | 없음 |

### 2.4 컨텍스트 압축/최적화 비교

| 방식 | 레포 | 구현 |
|------|------|------|
| **없음** | ui-ux-pro-max | Stateless |
| **Sync Impact Report** | cc-wf-studio | 변경 시 영향 범위 추적 |
| **Observation Archive** | everything-claude-code | 7일 후 archive, 10MB 제한 |
| **PreCompact Hook** | bkit-claude-code | 압축 전 상태 스냅샷, 최근 10개 유지 |
| **Hot/Cold 분리** | MEMORY-STRATEGY.md(기존) | session-latest + archive/ 패턴 |

---

## 3. Artibot 메모리 시스템 설계

### 3.1 설계 원칙

기존 MEMORY-STRATEGY.md의 설계를 기반으로, 4개 레포에서 학습한 패턴을 통합:

```yaml
design_principles:
  1_layered: "3-Layer 메모리 아키텍처 (Hot/Warm/Cold)"
  2_structured: "JSON 기반 구조화 상태 관리 (bkit 패턴)"
  3_learning: "Hook 기반 자동 패턴 학습 (everything-claude-code 패턴)"
  4_governed: "변경 추적 + 버전 관리 (cc-wf-studio 패턴)"
  5_efficient: "200줄 MEMORY.md 제한 엄수 + 동적 로딩"
  6_pluginizable: "플러그인 모듈로 구현 가능한 구조"
```

### 3.2 아키텍처

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    Artibot Memory System Architecture                     │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌────────────────────────────────────────────────────────────────────┐ │
│  │              Layer 1: Context Hierarchy (from bkit)                 │ │
│  │                                                                     │ │
│  │  L1: Plugin Defaults  →  L2: User Config  →  L3: Project  →  L4: Session │
│  │  (플러그인 기본값)      (~/.claude/artibot/)  (.artibot/)    (런타임)  │ │
│  │                                                                     │ │
│  │  Priority: L4 > L3 > L2 > L1                                       │ │
│  └────────────────────────────────────────────────────────────────────┘ │
│                              │                                          │
│                              ▼                                          │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────────┐ │
│  │ MEMORY.md Index  │  │ State Store      │  │ Pattern Store        │ │
│  │ (Hot - 200줄)    │  │ (JSON - 구조화)  │  │ (Learned Patterns)   │ │
│  │                  │  │                  │  │                      │ │
│  │ • Project ID     │  │ • session.json   │  │ • gotchas.md         │ │
│  │ • Topic Links    │  │ • tasks.json     │  │ • decisions.md       │ │
│  │ • Active Rules   │  │ • team-state.json│  │ • patterns/          │ │
│  │ • Current State  │  │                  │  │                      │ │
│  │ • User Prefs     │  │                  │  │                      │ │
│  └────────┬─────────┘  └────────┬─────────┘  └────────┬─────────────┘ │
│           │                     │                      │               │
│           ▼                     ▼                      ▼               │
│  ┌────────────────────────────────────────────────────────────────────┐ │
│  │              Layer 2: Topic Files (Warm - 필요시 로드)             │ │
│  │                                                                     │ │
│  │  tech-stack.md │ team-ops.md │ session-latest.md │ constitution.md │ │
│  └────────────────────────────────────────────────────────────────────┘ │
│                              │                                          │
│                              ▼                                          │
│  ┌────────────────────────────────────────────────────────────────────┐ │
│  │              Layer 3: Archive (Cold - 거의 참조 안 함)             │ │
│  │                                                                     │ │
│  │  archive/session-YYYYMMDD-topic.md │ archive/decisions-old.md      │ │
│  └────────────────────────────────────────────────────────────────────┘ │
│                                                                          │
│  ┌────────────────────────────────────────────────────────────────────┐ │
│  │              Auto-Learning Engine (from everything-claude-code)    │ │
│  │                                                                     │ │
│  │  Hook → Observe → Detect Pattern → Score Confidence → Store/Evolve │ │
│  └────────────────────────────────────────────────────────────────────┘ │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### 3.3 메모리 파일 구조

```
memory/
├── MEMORY.md                    # 인덱스 + 핵심 규칙 (200줄 제한)
├── state/                       # 구조화된 상태 (JSON)
│   ├── session.json            # 현재 세션 상태
│   ├── tasks.json              # 활성 태스크 추적
│   └── team-state.json         # 팀 구성/상태
├── topics/                      # 토픽별 지식 (Markdown)
│   ├── tech-stack.md           # 기술 스택, 빌드 설정
│   ├── gotchas.md              # 반복 실수, 에러 패턴
│   ├── team-ops.md             # 팀 구성, 워크플로우
│   ├── decisions.md            # 아키텍처 결정 (ADR)
│   ├── constitution.md         # 프로젝트 헌법 (불변 규칙)
│   └── session-latest.md       # 최근 세션 컨텍스트
├── patterns/                    # 학습된 패턴 (from instinct model)
│   ├── error-patterns.md       # 에러 해결 패턴
│   ├── workflow-patterns.md    # 워크플로우 패턴
│   └── project-patterns.md     # 프로젝트별 패턴
└── archive/                     # Cold 스토리지
    └── session-YYYYMMDD-topic.md
```

### 3.4 State Store 설계 (JSON 기반)

#### session.json - bkit .bkit-memory.json에서 영감

```json
{
  "version": "1.0.0",
  "sessionCount": 0,
  "lastSession": {
    "startedAt": null,
    "endedAt": null,
    "summary": null,
    "tokensUsed": null
  },
  "currentState": {
    "phase": "initial",
    "activeFeature": null,
    "blockers": []
  },
  "nextSessionChecklist": [],
  "promoted": {
    "toGotchas": [],
    "toDecisions": [],
    "toPatterns": []
  }
}
```

#### tasks.json - 팀 태스크 상태 추적

```json
{
  "version": "1.0.0",
  "activeTasks": [],
  "completedTasks": [],
  "blockedTasks": [],
  "metrics": {
    "totalCreated": 0,
    "totalCompleted": 0,
    "avgCompletionTime": null
  }
}
```

### 3.5 Constitution 설계 (cc-wf-studio에서 영감)

```markdown
# Artibot Project Constitution v1.0.0

## Core Principles (불변)

### I. 코드 품질
- 불변성 패턴 필수 (mutation 금지)
- 200-400줄 파일, 800줄 상한
- 함수 50줄 이하

### II. 안전성
- 하드코딩 비밀 금지
- 입력 검증 필수 (Zod)
- 환경 변수로 민감 정보 관리

### III. 팀 프로토콜
- 팀장은 코딩하지 않음 (배정/관리 전담)
- 조사 먼저, 수정 나중에
- 추측 금지 (Grep/Glob 검증 후 발언)

## Governance
- Version: MAJOR.MINOR.PATCH
- 변경 시 Sync Impact Report 작성
```

### 3.6 자동 학습 설계 (everything-claude-code에서 영감)

#### 학습 파이프라인

```
1. 관찰 (Observation)
   ├── Hook: PostToolUse (Bash 에러 발생 시)
   ├── Hook: Stop (세션 종료 시)
   └── 수동: 사용자 "/learn" 요청 시

2. 패턴 감지 (Detection)
   ├── 에러 해결: "이전에 같은 에러를 본 적 있는가?"
   ├── 사용자 교정: "사용자가 내 출력을 수정했는가?"
   ├── 반복 워크플로우: "동일 패턴이 3회 이상 반복되는가?"
   └── 프로젝트 규약: "이 프로젝트만의 규약을 발견했는가?"

3. 신뢰도 평가 (Confidence)
   ├── 초기: 0.3 (잠정)
   ├── 반복 관찰: +0.1 (최대 0.9)
   ├── 사용자 확인: +0.2
   ├── 사용자 교정: -0.2
   └── 미사용 감쇠: -0.05/세션

4. 저장 (Storage)
   ├── confidence >= 0.5: patterns/ 에 저장
   ├── confidence >= 0.7: MEMORY.md "Active Rules"로 승격
   └── confidence < 0.3: 삭제

5. 승격/감쇠 (Promotion/Decay)
   ├── 2회 이상 발생 → gotchas.md 승격
   ├── 아키텍처 영향 → decisions.md 승격
   ├── 3세션 미참조 → "검증 필요" 태그
   └── 5세션 미참조 → archive/ 이동
```

#### 패턴 파일 형식 (Instinct 모델 간소화)

```markdown
# [패턴명]

- **Confidence**: 0.7
- **Domain**: error-resolution | workflow | project-specific
- **Discovered**: 2026-02-13
- **Last Verified**: 2026-02-13

## Trigger
[어떤 상황에서 적용되는가]

## Pattern
[해결 방법/패턴]

## Evidence
- [관찰 1: 날짜, 상황]
- [관찰 2: 날짜, 상황]
```

### 3.7 컨텍스트 최적화 전략

#### 동적 로딩 (bkit Context Hierarchy에서 영감)

```yaml
context_loading:
  always_loaded:
    - MEMORY.md (200줄 이하)
    - state/session.json (현재 상태)

  on_demand:
    - topics/tech-stack.md: "빌드, 의존성, 설정 관련 질문 시"
    - topics/gotchas.md: "에러, 트러블슈팅 상황 시"
    - topics/team-ops.md: "팀 구성, 프로토콜 질문 시"
    - topics/decisions.md: "아키텍처 결정 필요 시"
    - topics/constitution.md: "규칙 확인, 코드 리뷰 시"

  never_auto_loaded:
    - archive/*
    - patterns/* (confidence < 0.5인 것)
```

#### 컨텍스트 압축 (bkit PreCompact Hook에서 영감)

```yaml
compaction_strategy:
  trigger: "컨텍스트 75% 이상 사용 시"
  actions:
    1: "state/session.json에 현재 상태 스냅샷"
    2: "진행 중 태스크 요약을 session-latest.md에 기록"
    3: "완료된 태스크 상세를 archive/로 이동"
    4: "MEMORY.md의 Active Rules만 유지"
  preservation:
    - "현재 활성 태스크 ID와 상태"
    - "미완료 작업 목록"
    - "사용자 최근 지시사항"
```

---

## 4. MEMORY-STRATEGY.md와의 통합

### 4.1 기존 전략 유지 항목

| MEMORY-STRATEGY.md 항목 | 상태 | 비고 |
|------------------------|------|------|
| 200줄 MEMORY.md 제한 | 유지 | 모든 레포에서 간결한 인덱스가 효과적 |
| Hot/Warm/Cold 분리 | 유지 | bkit의 3-scope와 일치하는 패턴 |
| 롤링 세션 패턴 | 유지 | everything-claude-code의 sessions와 유사 |
| 감쇠 메커니즘 | 강화 | Instinct confidence decay 모델 도입 |
| 승격 메커니즘 | 강화 | 자동 confidence 기반 승격 추가 |
| 토픽 파일 분류 | 확장 | state/ (JSON) + topics/ (MD) + patterns/ (학습) |
| 파일명 규약 | 유지 | kebab-case.md, YYYYMMDD 날짜 |

### 4.2 새로 추가된 항목 (4개 레포에서 학습)

| 신규 항목 | 출처 레포 | 설명 |
|----------|----------|------|
| Context Hierarchy | bkit-claude-code | 4-Level 설정 우선순위 체계 |
| JSON State Store | bkit-claude-code | 구조화된 상태 관리 (session.json, tasks.json) |
| Constitution | cc-wf-studio | 프로젝트 헌법 + 버전 관리 + 영향 보고서 |
| Auto-Learning Pipeline | everything-claude-code | Hook 기반 자동 패턴 추출 |
| Confidence Scoring | everything-claude-code v2 | 0.3~0.9 신뢰도 + 감쇠 |
| Pattern Evolution | everything-claude-code v2 | 패턴 → 승격/삭제 자동화 |
| Agent Memory Scope | bkit-claude-code | project/user/local 3-scope |
| Context Compaction Hook | bkit-claude-code | 압축 시 상태 보존 |

---

## 5. 플러그인 구현 로드맵

### Phase 1: 기본 메모리 (프롬프트 수준)
1. MEMORY.md 템플릿 적용 (MEMORY-STRATEGY.md 섹션 6.2)
2. state/ 디렉토리에 session.json 도입
3. topics/constitution.md 작성

### Phase 2: 자동화 (Hook 수준)
4. PostToolUse Hook: 에러 발생 시 패턴 후보 기록
5. Stop Hook: 세션 종료 시 session.json 갱신 + 패턴 승격 판단
6. 감쇠 로직: 세션 시작 시 patterns/ 스캔, 미참조 항목 표시

### Phase 3: 플러그인 모듈 (코드 수준)
7. memory-manager 모듈: Read/Write/Query API
8. context-loader 모듈: 동적 토픽 로딩
9. pattern-learner 모듈: 자동 학습 파이프라인
10. compaction-handler 모듈: 컨텍스트 압축 시 상태 보존

### Phase 4: 고급 기능
11. Context Hierarchy 구현 (L1~L4)
12. Agent Memory Scope (project/user/local)
13. Pattern Export/Import (팀 간 학습 공유)
14. 메트릭 대시보드 (메모리 품질 KPI 추적)

---

## 6. 결론

### 레포별 핵심 채택 사항

| 레포 | 채택 패턴 | Artibot 적용 |
|------|----------|-------------|
| **ui-ux-pro-max** | Stateless 도구 패턴 | 검색/조회 전용 모듈은 메모리 불필요 |
| **cc-wf-studio** | Constitution + 버전 관리 | topics/constitution.md + semver |
| **everything-claude-code** | Instinct 학습 + Sessions | patterns/ + confidence scoring + session.json |
| **bkit-claude-code** | Context Hierarchy + JSON State + Compaction | 4-Level hierarchy + state/*.json + compaction hook |
| **MEMORY-STRATEGY.md** | Hot/Cold 분리 + 롤링 세션 + 감쇠 | 기본 프레임워크 유지 |

### 핵심 설계 결정

1. **JSON + Markdown 하이브리드**: 상태는 JSON (기계 파싱), 지식은 Markdown (LLM 친화)
2. **Confidence 기반 메모리 관리**: 신뢰도 점수로 자동 승격/감쇠/삭제
3. **동적 컨텍스트 로딩**: MEMORY.md(항상) + topics/(필요시) + archive/(거의 안 함)
4. **Hook 기반 자동화**: 수동 기록 의존도를 낮추고 자동 학습으로 전환
5. **프로젝트 헌법**: 불변 규칙을 버전 관리하여 규범 변경 추적
