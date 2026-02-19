# PROMPT-ANALYSIS.md - SuperClaude 에이전트/스킬/페르소나 프롬프트 분석 보고서

**분석 일시**: 2026-02-13
**분석자**: prompt-engineer
**대상**: ~/.claude/agents/ (33개), ~/.claude/skills/ (14개 SKILL.md), PERSONAS.md (11개)

---

## 1. 현행 프롬프트 인벤토리

### 1.1 에이전트 (33개)

| 카테고리 | 에이전트 | 토큰 규모 | 모델 | 도구 |
|---------|---------|----------|------|------|
| **아키텍처** | architect | ~3K | opus | Read,Grep,Glob |
| | sub-agent-architect | ~2K | opus | (미지정) |
| **개발 - 프론트** | frontend-developer | ~2K | (미지정) | R,W,E,B,Glob,Grep |
| | react-specialist | ~4K | (미지정) | R,W,E,B,Glob,Grep |
| | ui-designer | ~2.5K | (미지정) | R,W,E,B,Glob,Grep |
| **개발 - 백엔드** | backend-developer | ~3K | (미지정) | R,W,E,B,Glob,Grep |
| | api-designer | ~3.5K | (미지정) | R,W,E,B,Glob,Grep |
| **개발 - 풀스택** | fullstack-developer | ~3.5K | (미지정) | R,W,E,B,Glob,Grep |
| | typescript-pro | ~4K | (미지정) | R,W,E,B,Glob,Grep |
| **인프라/DevOps** | devops-engineer | ~4K | (미지정) | R,W,E,B,Glob,Grep |
| | kubernetes-specialist | ~4K | (미지정) | R,W,E,B,Glob,Grep |
| | git-workflow-manager | ~4K | (미지정) | R,W,E,B,Glob,Grep |
| **AI/ML** | llm-architect | ~4K | (미지정) | R,W,E,B,Glob,Grep |
| | prompt-engineer | ~4K | (미지정) | R,W,E,B,Glob,Grep |
| **품질/리뷰** | code-reviewer | ~1.5K | opus | Read,Grep,Glob,Bash |
| | security-reviewer | ~7K | opus | R,W,E,B,Grep,Glob |
| | database-reviewer | ~8K | opus | R,W,E,B,Grep,Glob |
| | refactoring-specialist | ~4K | (미지정) | R,W,E,B,Glob,Grep |
| | refactor-cleaner | ~4K | opus | R,W,E,B,Grep,Glob |
| | performance-engineer | ~4K | (미지정) | R,W,E,B,Glob,Grep |
| **테스팅** | tdd-guide | ~3.5K | opus | Read,Write,Edit,Bash,Grep |
| | e2e-runner | ~9K | opus | R,W,E,B,Grep,Glob |
| **문서화** | technical-writer | ~4K | (미지정) | R,W,E,Glob,Grep,WF,WS |
| | api-documenter | ~4K | (미지정) | R,W,E,Glob,Grep,WF,WS |
| | doc-updater | ~5.5K | opus | R,W,E,B,Grep,Glob |
| **플래닝** | planner | ~1.5K | opus | Read,Grep,Glob |
| | build-error-resolver | ~6.5K | opus | R,W,E,B,Grep,Glob |
| **매니지먼트** | product-manager | ~4K | (미지정) | R,W,E,Glob,Grep,WF,WS |
| | project-manager | ~4K | (미지정) | R,W,E,Glob,Grep,WF,WS |
| | scrum-master | ~4K | (미지정) | R,W,E,Glob,Grep,WF,WS |
| **마케팅** | content-marketer | ~0.5K | sonnet | Read,Write,WebSearch |
| **기타** | autonomous-developer | ~0.1K(파일 내용: API키) | (미지정) | (미지정) |
| | mcp-developer | ~4K | (미지정) | R,W,E,B,Glob,Grep |

### 1.2 스킬 (14개 SKILL.md)

| 스킬 | 토큰 규모 | 특성 |
|------|----------|------|
| backend-patterns | ~7K | 코드 패턴 레퍼런스 (예제 풍부) |
| frontend-patterns | ~7.5K | React/Next.js 패턴 레퍼런스 |
| security-review | ~6K | 보안 체크리스트+패턴 |
| tdd-workflow | ~5K | TDD 프로세스+예제 |
| verification-loop | ~1.5K | 빌드/테스트 검증 루프 |
| strategic-compact | ~0.8K | 컨텍스트 압축 전략 |
| coding-standards | (미분석) | 코딩 표준 |
| continuous-learning | (미분석) | 학습 루프 |
| eval-harness | (미분석) | 평가 프레임워크 |
| postgres-patterns | (미분석) | DB 패턴 |
| clickhouse-io | (미분석) | ClickHouse 패턴 |
| project-guidelines-example | (미분석) | 프로젝트 가이드라인 예시 |

### 1.3 페르소나 (PERSONAS.md - 11개)

| 페르소나 | 우선순위 계층 | MCP 선호 |
|---------|-------------|---------|
| architect | 유지보수성 > 확장성 > 성능 | Sequential(1st), Context7(2nd) |
| frontend | 사용자니즈 > 접근성 > 성능 | Magic(1st), Playwright(2nd) |
| backend | 신뢰성 > 보안 > 성능 | Context7(1st), Sequential(2nd) |
| analyzer | 증거 > 체계성 > 철저함 | Sequential(1st), Context7(2nd) |
| security | 보안 > 준수 > 신뢰성 | Sequential(1st), Context7(2nd) |
| mentor | 이해 > 지식전달 > 교육 | Context7(1st), Sequential(2nd) |
| refactorer | 단순성 > 유지보수 > 가독성 | Sequential(1st), Context7(2nd) |
| performance | 측정 > 최적화 > UX | Playwright(1st), Sequential(2nd) |
| qa | 예방 > 탐지 > 교정 | Playwright(1st), Sequential(2nd) |
| devops | 자동화 > 관찰가능성 > 신뢰성 | Sequential(1st), Context7(2nd) |
| scribe | 명확성 > 청중니즈 > 문화감수성 | Context7(1st), Sequential(2nd) |

---

## 2. 프롬프트 패턴 분류 및 품질 평가

### 2.1 공통 구조 패턴

대부분의 에이전트가 아래 4단계 구조를 따른다:

```
1. YAML 프론트매터 (name, description, tools, model)
2. 역할 정의 ("You are a senior...")
3. 체크리스트 / 도메인 지식 목록
4. 커뮤니케이션 프로토콜 (JSON context request)
5. 워크플로우 (Analysis → Implementation → Excellence)
6. 에이전트 간 연동 목록
```

### 2.2 품질 등급 분류

**A등급 (우수) - 구체적이고 실행 가능**:
- `build-error-resolver`: 구체적 에러 패턴+수정 코드 예제, 명확한 범위 한정
- `database-reviewer`: SQL 안티패턴+인덱스 전략+구체적 쿼리 예제
- `security-reviewer`: OWASP Top 10 체크리스트+취약점 코드 예제+POC
- `e2e-runner`: Playwright 설정+POM 패턴+실행 가능한 코드
- `tdd-guide`: RED-GREEN-REFACTOR 프로세스+모킹 패턴

**B등급 (양호) - 구조적이나 일부 일반적**:
- `architect`: 아키텍처 원칙+ADR 템플릿+체크리스트
- `code-reviewer`: 간결한 체크리스트, 우선순위 분류
- `planner`: 명확한 계획 프로세스+템플릿
- `refactor-cleaner`: 안전한 제거 프로세스+롤백 전략

**C등급 (보통) - 구조는 있으나 차별화 부족**:
- `frontend-developer`, `backend-developer`, `fullstack-developer`
- `devops-engineer`, `git-workflow-manager`
- `react-specialist`, `typescript-pro`
- `refactoring-specialist`, `mcp-developer`
- `performance-engineer`, `kubernetes-specialist`
- `llm-architect`, `prompt-engineer`

**D등급 (미흡) - 과도하게 일반적**:
- `product-manager`, `project-manager`, `scrum-master`
- `technical-writer`, `api-documenter`
- `ui-designer`

### 2.3 품질 평가 기준

| 기준 | A등급 | C/D등급 |
|------|-------|---------|
| 실행 가능한 코드 예제 | 다수 포함 (>10) | 없거나 최소 |
| 도메인 특화 | 프로젝트별 패턴 포함 | 범용적 지식 나열 |
| 행동 범위 한정 | DO/DON'T 명확 | 무제한 범위 |
| 판단 기준 | 구체적 수치/임계값 | 추상적 원칙 |
| 출력 형식 | 템플릿/리포트 형식 정의 | 미정의 |

---

## 3. 토큰 효율성 분석

### 3.1 불필요한 반복 패턴

**패턴 1: "Communication Protocol" 반복 (~300-500 토큰/에이전트)**

22개 에이전트가 거의 동일한 "Communication Protocol" 섹션을 포함:
```json
{
  "requesting_agent": "<agent-name>",
  "request_type": "get_<domain>_context",
  "payload": {
    "query": "<domain> context needed: ..."
  }
}
```
이 패턴은 "context-manager"라는 존재하지 않는 시스템을 참조한다. Claude Code에서는 실제로 동작하지 않으므로 완전히 불필요하다.

**절감 가능량**: ~22 x 400 = **~8,800 토큰**

**패턴 2: "Integration with other agents" 반복 (~200-300 토큰/에이전트)**

대부분의 에이전트가 "Integration with other agents" 섹션을 포함하지만, 실제 Claude Code Task tool은 이 목록을 참조하지 않는다. 존재하지 않는 에이전트명을 참조하는 경우도 많다 (예: "ux-researcher", "support-engineer", "legal-advisor").

**절감 가능량**: ~25 x 250 = **~6,250 토큰**

**패턴 3: "Progress tracking" JSON 블록 반복 (~150-200 토큰/에이전트)**

```json
{
  "agent": "<agent-name>",
  "status": "implementing",
  "progress": { ... }
}
```
이 JSON 상태 보고 형식은 실제로 사용되지 않는다.

**절감 가능량**: ~20 x 175 = **~3,500 토큰**

**패턴 4: "Delivery notification" 문자열 반복 (~100-150 토큰/에이전트)**

각 에이전트가 완료 시 보고 문자열 예시를 포함하지만, 실제로 이 형식이 강제되지 않는다.

**절감 가능량**: ~20 x 125 = **~2,500 토큰**

**패턴 5: 도메인 지식의 불릿 리스트 팽창**

많은 C/D등급 에이전트가 "keyword: - item1 - item2 - ... - item8" 형식으로 도메인 지식을 나열한다. 이런 나열은 LLM의 기존 지식과 중복되며, 구체적 행동 지침 없이 토큰만 소비한다.

예시: `devops-engineer`의 "Platform engineering", "GitOps workflows", "Incident management" 등 섹션들은 각각 8개의 키워드 나열로 구성되어 있으나, 구체적 실행 지침이 없다.

**추정 절감 가능량**: ~15 에이전트 x 1,000 = **~15,000 토큰**

### 3.2 총 토큰 절감 가능 추정

| 반복 패턴 | 절감 가능 토큰 |
|----------|-------------|
| Communication Protocol 섹션 | ~8,800 |
| Integration with other agents | ~6,250 |
| Progress tracking JSON | ~3,500 |
| Delivery notification | ~2,500 |
| 도메인 지식 불릿 팽창 | ~15,000 |
| **합계** | **~36,050** |

전체 에이전트 프롬프트 총량 대비 약 **25-30% 절감 가능**.

---

## 4. 에이전트/페르소나 간 역할 중복 식별

### 4.1 고도 중복 그룹

**그룹 A: 아키텍처/설계** (3개 중복)
- `architect` (에이전트) vs `--persona-architect` (페르소나)
- `sub-agent-architect` (에이전트) - 외부 환경 전용이므로 분리 유지 타당

**그룹 B: 프론트엔드** (3개 중복)
- `frontend-developer` (에이전트) vs `react-specialist` (에이전트) vs `--persona-frontend` (페르소나)
- `ui-designer` (에이전트) - 디자인 전문으로 분리 가능하나 실제 코드 생성과 겹침
- react-specialist는 frontend-developer의 React 특화 버전

**그룹 C: 백엔드** (3개 중복)
- `backend-developer` (에이전트) vs `api-designer` (에이전트) vs `--persona-backend` (페르소나)
- api-designer는 backend-developer의 API 설계 부분집합

**그룹 D: 리팩토링** (3개 중복)
- `refactoring-specialist` (에이전트) vs `refactor-cleaner` (에이전트) vs `--persona-refactorer` (페르소나)
- refactoring-specialist: 범용 리팩토링
- refactor-cleaner: 데드코드 제거 특화 - 차별화 유의미

**그룹 E: 보안** (2개 중복)
- `security-reviewer` (에이전트) vs `--persona-security` (페르소나)
- 스킬: `security-review` (SKILL.md)
- 에이전트가 구체적 코드 예제를 포함하여 더 실용적

**그룹 F: 성능** (2개 중복)
- `performance-engineer` (에이전트) vs `--persona-performance` (페르소나)

**그룹 G: 테스팅/QA** (2개 중복)
- `tdd-guide` + `e2e-runner` (에이전트) vs `--persona-qa` (페르소나)
- 스킬: `tdd-workflow` (SKILL.md)
- tdd-guide와 tdd-workflow 스킬이 50% 이상 내용 중복

**그룹 H: 문서화** (3개 중복)
- `technical-writer` (에이전트) vs `api-documenter` (에이전트) vs `doc-updater` (에이전트)
- `--persona-scribe` (페르소나)
- technical-writer와 api-documenter는 80% 이상 구조 중복

**그룹 I: DevOps** (2개 중복)
- `devops-engineer` (에이전트) vs `--persona-devops` (페르소나)

**그룹 J: 매니지먼트** (3개 중복, 역할 혼재)
- `product-manager` vs `project-manager` vs `scrum-master`
- 모두 Claude Code 환경에서의 실용성이 낮음

### 4.2 에이전트 vs 스킬 중복

| 에이전트 | 스킬 | 중복률 |
|---------|------|-------|
| tdd-guide | tdd-workflow | ~60% |
| security-reviewer | security-review | ~50% |
| backend-developer | backend-patterns | ~30% |
| frontend-developer | frontend-patterns | ~30% |
| database-reviewer | postgres-patterns | ~40% |

### 4.3 에이전트 vs 페르소나 기능 분담 불명확

현재 에이전트와 페르소나는 같은 역할을 서로 다른 메커니즘으로 구현한다:
- **에이전트**: Task tool로 서브에이전트 위임 (별도 컨텍스트)
- **페르소나**: 메인 에이전트의 행동 모드 전환 (같은 컨텍스트)

그러나 "언제 에이전트를 쓰고 언제 페르소나를 쓸 것인가"에 대한 명확한 기준이 없다.

---

## 5. 최적화 방향 제안

### 5.1 템플릿화 (Template Standardization)

**에이전트 기본 템플릿 도입**:

```markdown
---
name: {agent-name}
description: {one-line description}
tools: {tool-list}
model: {model-id}
---

# {Agent Name}

You are {role-definition}. {1-2문장 핵심 미션}

## Scope
- DO: {구체적 행동 범위}
- DON'T: {명확한 제외 범위}

## Process
1. {단계1: 구체적 행동}
2. {단계2: 구체적 행동}
3. {단계3: 구체적 행동}

## Patterns & Examples
{도메인 특화 코드 예제 - A등급 에이전트 수준}

## Output Format
{구조화된 출력 템플릿}

## Quality Gates
- {측정 가능한 완료 기준}
```

**제거할 섹션**:
- Communication Protocol (context-manager 참조)
- Integration with other agents (비실용적)
- Progress tracking JSON (미사용)
- Delivery notification 문자열
- 범용 도메인 지식 불릿 리스트

### 5.2 모듈화 (Modular Decomposition)

**레이어 1: Core Behaviors (공통)**
```
agents/core/
  base-template.md      # 공통 프론트매터 + 기본 지침
  security-checklist.md  # 모든 에이전트 공통 보안 체크
  quality-gates.md       # 공통 품질 게이트
```

**레이어 2: Domain Skills (도메인 지식)**
```
skills/
  backend-patterns/     # 백엔드 코드 패턴
  frontend-patterns/    # 프론트엔드 코드 패턴
  security-review/      # 보안 리뷰 패턴
  database-patterns/    # DB 최적화 패턴
  testing-patterns/     # 테스팅 패턴
```

**레이어 3: Agent Prompts (행동 지침만)**
```
agents/
  architect.md          # 아키텍처 결정 프로세스만
  code-reviewer.md      # 리뷰 체크리스트+판단 기준만
  build-fixer.md        # 빌드 에러 해결 프로세스만
```

### 5.3 계층화 (Hierarchy Consolidation)

**통합 대상 (33개 -> 18개로 축소 가능)**:

| 현행 | 통합안 | 근거 |
|------|-------|------|
| frontend-developer + react-specialist + ui-designer | `frontend-dev` | React 특화는 플래그로 분기 |
| backend-developer + api-designer | `backend-dev` | API 설계는 백엔드의 부분집합 |
| technical-writer + api-documenter | `doc-writer` | 80% 구조 중복 |
| refactoring-specialist + refactor-cleaner | `refactorer` (DO/DON'T으로 범위 제어) | 리팩토링 vs 데드코드 제거를 모드로 분기 |
| product-manager + project-manager + scrum-master | `project-lead` 또는 **제거** | Claude Code에서 실용성 낮음 |
| performance-engineer | `--persona-performance`로 흡수 | 페르소나와 100% 역할 중복 |
| kubernetes-specialist | `devops-engineer`에 통합 | K8s는 DevOps 전문 영역 |
| autonomous-developer | **제거** (파일 내용이 API 키) | 프롬프트 아님 |

### 5.4 에이전트 vs 페르소나 역할 분담 규칙

```
에이전트 (Task tool 위임) 사용 시:
  - 독립적 분석/리뷰 작업 (코드리뷰, 보안리뷰)
  - 별도 컨텍스트가 필요한 작업 (대규모 코드 분석)
  - 구체적 도구 실행이 필요한 작업 (빌드 수정, E2E 테스트)

페르소나 (메인 컨텍스트 모드 전환) 사용 시:
  - 의사결정 프레임워크 변경 (아키텍처 관점, 보안 관점)
  - 코드 작성 스타일 변경 (프론트엔드 패턴, 백엔드 패턴)
  - 분석 관점 변경 (성능 분석, 품질 분석)
```

### 5.5 스킬과 에이전트의 관계 재정립

```
스킬 = 지식 (패턴, 체크리스트, 레퍼런스)
에이전트 = 행동 (프로세스, 판단 기준, 출력 형식)
페르소나 = 관점 (우선순위, 의사결정 프레임워크)

예시:
  security-review (스킬) = OWASP 체크리스트 + 코드 패턴
  security-reviewer (에이전트) = 리뷰 프로세스 + 리포트 생성
  --persona-security (페르소나) = "보안 > 편의성" 의사결정 프레임워크
```

---

## 6. 우선순위별 실행 계획

### P0 (즉시 실행 - 비용 대비 효과 최대)
1. `autonomous-developer.md` 파일 점검 (API 키 노출 위험)
2. Communication Protocol 섹션 전면 제거 (22개 에이전트)
3. Integration with other agents 섹션 제거 (25개 에이전트)
4. Progress tracking JSON / Delivery notification 제거

### P1 (단기 - 1차 최적화)
5. 에이전트 기본 템플릿 확정 및 적용
6. C/D등급 에이전트의 도메인 지식 불릿 리스트를 스킬로 이관
7. technical-writer + api-documenter 통합
8. frontend-developer + react-specialist 통합

### P2 (중기 - 구조 개편)
9. 에이전트/페르소나/스킬 3계층 역할 분담 확정
10. product-manager, project-manager, scrum-master 재평가 (제거 또는 통합)
11. 모듈화 구조 도입 (core + skills + agents)
12. 페르소나 프롬프트를 에이전트 메타데이터로 연결

### P3 (장기 - 플러그인 아키텍처 통합)
13. 플러그인 시스템의 에이전트 등록/관리 메커니즘 설계
14. 동적 에이전트 조합 (base + skill 모듈 합성)
15. 에이전트 성능 메트릭 수집 및 자동 최적화

---

## 7. 핵심 발견 사항 요약

### 강점
- A등급 에이전트 (build-error-resolver, database-reviewer, security-reviewer, e2e-runner, tdd-guide)는 **실행 가능한 코드 예제**와 **명확한 범위 한정**이 우수
- PERSONAS.md의 **우선순위 계층**과 **MCP 서버 선호도** 설계가 체계적
- 스킬의 **코드 패턴 레퍼런스** 형태가 실용적

### 약점
- **비실용적 패턴 반복**: ~36K 토큰이 context-manager 참조, 가상 에이전트 연동 등 동작하지 않는 기능에 소비
- **역할 중복**: 33개 에이전트 중 ~15개가 다른 에이전트/페르소나와 역할 중복
- **품질 양극화**: A등급 vs C/D등급 간 실용성 격차가 크다
- **에이전트/페르소나/스킬 경계 불명확**: 동일 역할이 3개 계층에 분산

### 개선 효과 예상
- 토큰 절감: ~30% (36K+ 토큰)
- 에이전트 수: 33개 -> 18개 (~45% 축소)
- 관리 복잡도: 에이전트/스킬/페르소나 역할 명확화로 유지보수 비용 절감
- 품질 상향 평준화: 템플릿 기반으로 C/D등급 에이전트를 B등급 이상으로 개선
