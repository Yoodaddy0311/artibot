# Artibot v1.13.0 활용 가이드

Claude Code를 위한 Agent Teams 기반 지능형 오케스트레이션 플러그인 **Artibot**의 종합 활용 가이드입니다.

---

## 목차

1. [빠른 시작](#1-빠른-시작)
2. [핵심 기능 가이드](#2-핵심-기능-가이드)
   - [에이전트 시스템](#21-에이전트-시스템)
   - [팀 모드](#22-팀-모드-team)
   - [주요 커맨드 TOP 15](#23-주요-커맨드-top-15)
   - [인지/학습 시스템](#24-인지학습-시스템)
   - [Git Autopilot](#25-git-autopilot)
3. [고급 활용](#3-고급-활용)
   - [플레이북 오케스트레이션](#31-플레이북-오케스트레이션)
   - [크로스 플랫폼](#32-크로스-플랫폼)
   - [스킬 커스터마이징](#33-스킬-커스터마이징)
4. [Claude 최신 기능 활용법](#4-claude-최신-기능-활용법)
5. [트러블슈팅](#5-트러블슈팅)

---

## 1. 빠른 시작

### 설치

```bash
# 방법 A: Plugin Marketplace (권장)
claude plugin marketplace add https://github.com/Yoodaddy0311/artibot
claude plugin install artibot@artibot

# 방법 B: 수동 설치
git clone https://github.com/Yoodaddy0311/artibot.git
cd artibot/plugins/artibot
bash install.sh
```

설치 스크립트가 에이전트, 커맨드, 스킬, 훅, MCP 설정을 `~/.claude/`에 복사합니다.

**요구사항:**
- Claude Code CLI
- Node.js >= 18.0.0
- Agent Teams (Artibot이 자동 활성화)

### 설치 확인

```
/index           # 전체 커맨드 카탈로그 확인
/quickstart      # 빠른 시작 가이드 실행
```

### 첫 번째 명령 실행

설치 후 Claude Code 세션에서 바로 사용 가능합니다:

```
/sc 로그인 기능 구현해줘
```

`/sc`는 Artibot의 메인 라우터입니다. 자연어 의도를 분석하여 최적의 커맨드, 에이전트, 스킬로 자동 라우팅합니다.

**라우팅 예시:**

| 입력 | 라우팅 결과 |
|------|------------|
| `/sc 로그인 기능 구현해줘` | `/implement` -> 팀 구성 (planner + developer + reviewer) |
| `/sc 이 코드 리뷰해줘` | `/code-review` -> code-reviewer 에이전트 위임 |
| `/sc 보안 취약점 분석` | `/analyze --focus security` -> security-reviewer 위임 |
| `/sc 테스트 작성해줘` | `/tdd` -> tdd-guide 에이전트 위임 |

---

## 2. 핵심 기능 가이드

### 2.1 에이전트 시스템

Artibot은 28개 전문 에이전트로 구성됩니다. orchestrator가 CTO 역할의 팀 리더로서 나머지 에이전트를 조율합니다.

#### 에이전트 전체 목록

**관리 에이전트 (3개) - Opus**

| 에이전트 | 역할 |
|----------|------|
| `orchestrator` | CTO급 팀 리더. 조율 전용 (직접 코드 작성 안 함) |
| `planner` | 구현 계획 수립, 위험 평가, 단계 분해 |
| `architect` | 시스템 아키텍처, ADR, 트레이드오프 분석 |

**전문가 에이전트 (9개) - Opus**

| 에이전트 | 역할 |
|----------|------|
| `frontend-developer` | UI/UX, WCAG 접근성, Core Web Vitals |
| `backend-developer` | API, 데이터베이스, 서비스 |
| `database-reviewer` | SQL 최적화, 스키마 설계 |
| `security-reviewer` | OWASP Top 10, 위협 모델링 |
| `performance-engineer` | 성능 분석, 병목 제거, 최적화 |
| `typescript-pro` | 고급 타입, strict mode, 마이그레이션 |
| `mcp-developer` | MCP 서버 개발, 도구 오케스트레이션 |
| `llm-architect` | LLM 아키텍처, 프롬프트 설계, RAG |
| `devops-engineer` | CI/CD, Docker, 모니터링 |

**빌더 에이전트 (6개) - Opus**

| 에이전트 | 역할 |
|----------|------|
| `code-reviewer` | 코드 리뷰 (4단계 심각도, 5개 차원) |
| `tdd-guide` | TDD (RED->GREEN->REFACTOR), 80%+ 커버리지 |
| `build-error-resolver` | 빌드 오류 자동 진단/수정 |
| `refactor-cleaner` | 데드 코드 제거, 리팩토링 |
| `quality-reviewer` | 품질 리뷰 |
| `spec-reviewer` | 스펙 리뷰 |

**서포트 에이전트 (10개) - 혼합**

| 에이전트 | 모델 | 역할 |
|----------|------|------|
| `e2e-runner` | opus | Playwright E2E 테스트 |
| `marketing-strategist` | opus | 마케팅 전략, 캠페인 기획 |
| `repo-benchmarker` | opus | 레포지토리 벤치마크, 비교 분석 |
| `doc-updater` | sonnet | 문서 동기화, 변경 이력 |
| `content-marketer` | sonnet | 블로그, SEO, 소셜 미디어 |
| `data-analyst` | sonnet | 데이터 분석, 시각화, KPI 추적 |
| `presentation-designer` | sonnet | 프레젠테이션 디자인, 시각 자료 |
| `seo-specialist` | sonnet | SEO 전략, 키워드 분석 |
| `cro-specialist` | sonnet | 전환율 최적화, A/B 테스트 |
| `ad-specialist` | sonnet | 광고 캠페인, 예산 최적화 |

#### 모델 배분 정책

| 모델 | 비율 | 용도 | 에이전트 수 |
|------|------|------|------------|
| Opus | 73% | 깊은 추론, 아키텍처, 보안, 코드 작성 | 21개 |
| Sonnet | 27% | 콘텐츠, 분석, 디자인, 리뷰 | 7개 |

#### 에이전트 선택 가이드

어떤 작업에 어떤 에이전트를 사용해야 하는지 빠르게 찾을 수 있습니다:

| 작업 유형 | 추천 에이전트 | 사용 방법 |
|-----------|-------------|-----------|
| 코드 리뷰 | `code-reviewer` | `/code-review @src/` |
| 보안 감사 | `security-reviewer` | `/analyze --focus security` |
| 프론트엔드 개발 | `frontend-developer` | `/implement 컴포넌트 --type component` |
| 백엔드 API | `backend-developer` | `/implement API --type api` |
| DB 최적화 | `database-reviewer` | `/analyze --focus database` |
| 빌드 오류 | `build-error-resolver` | `/build-fix` |
| 테스트 작성 | `tdd-guide` | `/tdd 기능명` |
| E2E 테스트 | `e2e-runner` | `/test --e2e` |
| 리팩토링 | `refactor-cleaner` | `/refactor-clean @target` |
| 구현 계획 | `planner` | `/plan 기능명` |
| 아키텍처 설계 | `architect` | `/design 시스템명` |
| 성능 최적화 | `performance-engineer` | `/analyze --focus performance` |
| 문서 작성 | `doc-updater` | `/document @target` |
| LLM/AI 설계 | `llm-architect` | `/design --domain llm` |
| DevOps/CI | `devops-engineer` | `/orchestrate --pattern security` |
| MCP 서버 | `mcp-developer` | `/implement MCP서버 --type service` |

---

### 2.2 팀 모드 (/team)

`/team`은 Agent Teams API를 활용한 병렬 팀 실행 커맨드입니다. 리더가 작업을 분해하고, 전문 에이전트들이 병렬로 작업한 후, 교차 검증(cross-check)을 수행합니다.

#### 기본 사용법

```
/team 결제 시스템 구현하고 테스트도 작성해줘
```

이 명령은:
1. 요청을 독립 작업 단위로 분해
2. 최적의 전문 에이전트 선택 및 팀 구성
3. 병렬 실행 후 교차 검증
4. 결과 종합 및 보고

#### Persistent 모드 vs One-shot 모드

| 모드 | 플래그 | 동작 | 토큰 비용 |
|------|--------|------|-----------|
| Persistent (기본) | `--persistent` / `--keep` | 작업 완료 후 팀 유지, 다음 작업 대기 | 절약 (재소환 불필요) |
| One-shot | `--one-shot` | 작업 완료 후 팀 해산 | 매번 재구성 비용 |
| 셧다운 | `--shutdown` | 기존 팀 명시적 해산 | - |

**Persistent 모드 권장 이유:** 팀원 재소환 시 컨텍스트 로딩에 토큰이 소비됩니다. 다음 작업에서 같은 전문성이 필요하면 팀을 유지하는 것이 효율적입니다.

#### 실전 예시

**기능 개발:**
```
/team 사용자 인증 API 구현 --agents backend-developer,security-reviewer,tdd-guide
```
-> backend-developer가 API 구현, tdd-guide가 테스트 작성, security-reviewer가 보안 검증을 병렬 수행

**버그 수정:**
```
/team 로그인 실패 시 세션이 남는 버그 수정
```
-> 리더가 분석 후 적합한 에이전트 자동 선택, 수정 후 교차 검증

**리팩토링:**
```
/team src/auth/ 디렉토리 전체 리팩토링 --skip-crosscheck
```
-> refactor-cleaner가 리팩토링, code-reviewer가 검토 (교차 검증 생략)

#### 팀 레벨

복잡도에 따라 자동으로 팀 규모가 결정됩니다:

| 레벨 | 모드 | 에이전트 수 | 적용 상황 |
|------|------|------------|-----------|
| Solo | Sub-Agent | 0 | 단일 파일 수정, 간단한 질문 |
| Squad | Agent Team | 2-4명 | 기능 구현, 버그 수정, 리팩토링 |
| Platoon | Agent Team | 5명+ | 대규모 기능, 아키텍처 변경, 보안 감사 |

---

### 2.3 주요 커맨드 TOP 15

Artibot은 48개 슬래시 커맨드를 제공합니다. 가장 자주 사용되는 15개를 소개합니다.

#### 개발 핵심 (5개)

| 커맨드 | 설명 | 실전 예시 |
|--------|------|-----------|
| `/implement [feature]` | 기능 구현 파이프라인 (plan->design->implement->test->review) | `/implement 로그인 기능 --tdd` |
| `/plan [feature]` | 구현 계획 수립, 위험 평가 | `/plan 결제 시스템 --phases --risks` |
| `/build [target]` | 프로젝트 빌드 (프레임워크 자동 감지) | `/build --optimize` |
| `/test [type]` | 테스트 실행 (러너 자동 감지) | `/test --coverage --e2e` |
| `/code-review [target]` | 코드 리뷰 (CRITICAL/HIGH/MEDIUM/LOW) | `/code-review @src/auth/` |

#### 분석/디버깅 (3개)

| 커맨드 | 설명 | 실전 예시 |
|--------|------|-----------|
| `/analyze [target]` | 다차원 코드/시스템 분석 | `/analyze --focus security --scope @src/` |
| `/explain [topic]` | 교육적 설명 | `/explain 이 코드의 인증 흐름 --depth deep` |
| `/troubleshoot [symptoms]` | 근본 원인 분석 | `/troubleshoot 빌드 실패 --hypothesis` |

#### 품질/워크플로우 (4개)

| 커맨드 | 설명 | 실전 예시 |
|--------|------|-----------|
| `/tdd [feature]` | TDD 워크플로우 (RED->GREEN->REFACTOR) | `/tdd 사용자 서비스 --coverage 90` |
| `/verify` | 검증 파이프라인 (lint->type->test->build) | `/verify --quick --fix` |
| `/git [operation]` | Git 워크플로우 | `/git commit`, `/git pr`, `/git branch` |
| `/checkpoint` | 상태 스냅샷 저장/복원 | `/checkpoint save "auth 완료"` |

#### 오케스트레이션 (3개)

| 커맨드 | 설명 | 실전 예시 |
|--------|------|-----------|
| `/orchestrate [workflow]` | Agent Teams 멀티 에이전트 워크플로우 | `/orchestrate 결제 시스템 --pattern feature` |
| `/spawn [mode]` | 팀 스폰 및 병렬 태스크 실행 | `/spawn 보안 감사 --mode parallel --agents 5` |
| `/daily` | 일일 작업 요약 및 계획 | `/daily` |

#### 전체 커맨드 빠른 찾기

```
/index                    # 전체 커맨드 카탈로그
/sc --plan 내 요청         # 라우팅 계획만 확인 (실행 안 함)
/sc --force verify 내 요청  # 특정 커맨드로 강제 라우팅
```

---

### 2.4 인지/학습 시스템

Artibot은 Kahneman의 이중 처리 이론에 기반한 인지 아키텍처를 탑재하고 있습니다.

#### System 1 / System 2 라우팅

```
사용자 요청
    |
Cognitive Router (threshold: 0.4)
    |-- confidence >= 0.6 -> System 1 (빠른 직관 처리, <100ms)
    |       -> 패턴 매칭 -> 즉시 응답
    |-- confidence < 0.6 -> System 2 (심층 분석 처리)
            -> Sandbox 평가 -> 최대 3회 재시도 -> 정밀 응답
```

| 시스템 | 방식 | 최대 지연 | 적용 상황 |
|--------|------|-----------|-----------|
| System 1 | 직관적, 패턴 기반 | 100ms | 반복 작업, 명확한 의도, 이전에 학습된 패턴 |
| System 2 | 분석적, 샌드박스 | 제한 없음 | 복잡한 추론, 불확실한 의도, 새로운 상황 |

라우터의 `adaptRate`(0.05)에 의해 사용할수록 패턴 인식이 개선되어 System 1으로 처리되는 비율이 증가합니다.

#### 자기학습 (GRPO + Lifelong Learning)

```
세션 종료
    |
Self Evaluator (응답 품질 평가)
    |
GRPO Optimizer (그룹 상대 정책 최적화, batchSize: 50, groupSize: 5)
    |
Knowledge Transfer (메모리 스코프 간 승격/강등)
    |   3회 성공 -> user 스코프로 승격 (영구 기억)
    |   2회 실패 -> 강등
    |
Memory Manager
```

#### 메모리 관리 (3-Scope)

| 스코프 | 저장 위치 | 지속성 | 용도 |
|--------|-----------|--------|------|
| `user` | `~/.claude/artibot/` | 영구, 모든 프로젝트 공유 | 사용자 선호, 자주 쓰는 패턴 |
| `project` | `.artibot/` (프로젝트 루트) | 프로젝트별 영구 | 프로젝트 컨벤션, 아키텍처 결정 |
| `session` | 인메모리 | 세션 종료 시 초기화 | 현재 작업 컨텍스트 |

메모리는 `/learn` 커맨드로 수동 관리할 수도 있습니다:

```
/learn --scan @src/        # 프로젝트 패턴 자동 학습
/learn --category naming   # 특정 카테고리 패턴 학습
```

---

### 2.5 Git Autopilot (v1.12.0)

Git Autopilot은 사용자가 코드 작성에만 집중할 수 있도록 Git 작업 전체를 자동화합니다.

#### 활성화

```
/git autopilot on          # autopilot 활성화 (safe 모드)
/git autopilot status      # 현재 상태 확인
/git autopilot off         # 비활성화
```

#### 모드

| 모드 | 자동 커밋 | 자동 푸시 | 자동 충돌 해결 | 설명 |
|------|:---------:|:---------:|:-------------:|------|
| `off` | - | - | - | 모든 Git 작업 수동 |
| `safe` | O | - | - | 변경 감지 시 WIP 커밋, 세션 종료 시 푸시 확인 |
| `full` | O | O | O | 완전 자동 (safe 전략 충돌 해결만) |

#### 동작 원리

1. `PostToolUse(Edit/Write)` 훅이 파일 변경 감지
2. 변경사항을 WIP 커밋으로 자동 저장
3. `safe` 모드: 세션 종료 시 푸시 여부 확인
4. `full` 모드: 자동 푸시 + safe 전략 충돌 해결

#### 설정 파일

`~/.claude/artibot/git-autopilot.json`에서 세부 설정을 조정할 수 있습니다:

```json
{
  "enabled": true,
  "mode": "safe",
  "autoCommit": true,
  "autoPush": false,
  "autoMerge": false,
  "commitPrefix": "wip"
}
```

---

## 3. 고급 활용

### 3.1 플레이북 오케스트레이션

플레이북은 사전 정의된 멀티 에이전트 워크플로우입니다. `/orchestrate` 또는 `/playbook` 커맨드로 실행합니다.

#### 개발 플레이북 (4개)

| 플레이북 | 워크플로우 | 사용 시점 |
|---------|-----------|-----------|
| `feature` | [Leader] plan -> [Council] design -> [Swarm] implement -> [Council] review -> [Leader] merge | 새 기능 구현 |
| `bugfix` | [Leader] analyze -> [Pipeline] fix -> [Council] verify | 버그 분석 및 수정 |
| `refactor` | [Council] assess -> [Pipeline] refactor -> [Swarm] test -> [Council] review | 코드 리팩토링 |
| `security` | [Leader] scan -> [Council] assess -> [Pipeline] fix -> [Council] verify | 보안 감사 및 취약점 수정 |

#### 마케팅 플레이북 (4개)

| 플레이북 | 워크플로우 | 사용 시점 |
|---------|-----------|-----------|
| `marketing-campaign` | [Leader] strategy -> [Council] plan -> [Swarm] create -> [Council] review -> [Leader] launch | 마케팅 캠페인 실행 |
| `marketing-audit` | [Leader] scan -> [Council] assess -> [Pipeline] optimize -> [Council] verify | 마케팅 성과 감사 |
| `content-launch` | [Leader] plan -> [Swarm] create -> [Council] review -> [Leader] publish | 콘텐츠 제작 및 퍼블리싱 |
| `competitive-analysis` | [Council] research -> [Swarm] analyze -> [Council] synthesize -> [Leader] report | 경쟁사 분석 |

#### 오케스트레이션 패턴

| 패턴 | 용도 | 동작 |
|------|------|------|
| Leader | 계획, 의사결정 | 리더가 태스크 생성 -> 팀원에게 할당 -> 결과 수집 |
| Council | 설계, 검증 | 복수 팀원이 토론 -> 리더가 최종 결정 |
| Swarm | 대규모 병렬 구현 | 태스크 생성 (의존성 없음) -> 팀원이 자기 할당 |
| Pipeline | 순차 의존성 | 태스크간 blockedBy 설정 -> 순차 실행 |
| Watchdog | 지속 모니터링 | 별도 팀원이 주기적으로 상태 확인 및 알림 |

#### 사용 예시

```
# feature 플레이북으로 결제 시스템 구현
/orchestrate 결제 시스템 구현 --pattern feature

# security 플레이북으로 전체 코드베이스 보안 감사
/orchestrate 보안 감사 --pattern security

# marketing-campaign 플레이북으로 런칭 캠페인
/orchestrate 신제품 런칭 --pattern marketing-campaign
```

---

### 3.2 크로스 플랫폼

Artibot은 Claude Code 외에도 Gemini CLI, Codex CLI, Cursor IDE, Antigravity를 지원합니다. 내장 `skill-exporter`가 각 플랫폼 형식으로 자동 변환합니다.

#### 플랫폼별 호환성

| 기능 | Claude Code | Gemini CLI | Codex CLI | Cursor IDE | Antigravity |
|------|:-----------:|:----------:|:---------:|:----------:|:-----------:|
| 호환성 점수 | 10/10 | 9/10 | 8/10 | 6/10 | 8/10 |
| Agent Teams (P2P) | O | - | - | - | - |
| Sub-Agent (단방향) | O | O | O | 제한적 | O |
| 에이전트 자동변환 | O | O | O | O | O |
| 스킬 (SKILL.md) | O | O | O | O | O |
| 인지 라우터 | O | O | O | O | O |
| 자가학습 (GRPO) | O | O | O | O | O |
| 메모리 (3-scope) | O | O | O | O | O |

#### 내보내기 방법

```bash
# 특정 플랫폼용 내보내기
node --input-type=module -e "
  import { exportForGemini } from './plugins/artibot/lib/core/skill-exporter.js';
  const result = await exportForGemini({ pluginRoot: './plugins/artibot' });
  console.log('Files:', result.files.length);
"

# 모든 플랫폼 일괄 내보내기
node --input-type=module -e "
  import { exportForAll } from './plugins/artibot/lib/core/skill-exporter.js';
  const results = await exportForAll({ pluginRoot: './plugins/artibot' });
  for (const [platform, result] of Object.entries(results)) {
    console.log(platform + ':', result.files.length, 'files');
  }
"
```

사용 가능한 내보내기 함수: `exportForGemini`, `exportForCodex`, `exportForCursor`, `exportForAll`

#### Graceful Degradation (자동 폴백)

환경에 따라 자동으로 최적의 모드가 선택됩니다:

```
Agent Teams (Full P2P)  ->  Sub-Agent (단방향)  ->  Direct (직접 실행)
  Claude Code + env var       모든 플랫폼            도구 제한 환경
```

감지 순서:
1. `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` -> Agent Teams 모드
2. `Task()` 도구 사용 가능 -> Sub-Agent 모드
3. 도구 없음 -> Direct 모드 (오케스트레이터가 직접 실행)

---

### 3.3 스킬 커스터마이징

Artibot은 87개+ 도메인 스킬을 제공하며, 자체 스킬을 추가할 수 있습니다.

#### 스킬 구조

모든 스킬은 `skills/스킬명/SKILL.md` 형식입니다:

```markdown
---
context: forked
name: my-custom-skill
description: |
  스킬 설명. Auto-activates when: 트리거 키워드.
  Triggers: keyword1, keyword2
platforms: [claude-code]
level: 2
triggers:
  - "keyword1"
  - "keyword2"
agents:
  - "agent-name"
tokens: "~1K"
category: "custom"
---

# My Custom Skill

## 목적
이 스킬의 목적 설명

## When This Skill Applies
- 트리거 조건 1
- 트리거 조건 2

## Core Concepts
구체적인 지식과 규칙
```

#### 자체 스킬 추가 방법

1. `plugins/artibot/skills/` 아래에 새 디렉토리 생성
2. `SKILL.md` 파일 작성 (위 템플릿 참고)
3. 필요 시 `references/` 하위 디렉토리에 참고 자료 추가
4. `install.sh` 재실행으로 `~/.claude/`에 반영

#### 스킬 카테고리 (87개+)

| 카테고리 | 수량 | 예시 |
|---------|------|------|
| 코어 | 6개 | orchestration, principles, coding-standards, security-standards, testing-standards, token-efficiency |
| 페르소나 | 11개 | persona-architect, persona-frontend, persona-backend, persona-security 등 |
| 유틸리티 | 8개 | git-workflow, tdd-workflow, delegation, mcp-coordination 등 |
| 언어 | 16개 | lang-typescript, lang-python, lang-go, lang-rust, lang-java 등 |
| 마케팅 | 23개 | seo-strategy, ab-testing, email-marketing, advertising 등 |
| Git | 7개 | git-autopilot, git-collab, git-conflict, git-guide, git-safe, git-strategy, git-sync |
| 기타 | 16개+ | cognitive-routing, visual-validation, self-evaluation, vibe-coding 등 |

---

## 4. Claude 최신 기능 활용법

### Worktree 격리 (`--worktree`)

Git worktree를 사용한 격리된 환경에서 팀원이 작업할 수 있습니다. 메인 브랜치를 건드리지 않고 병렬 작업이 가능합니다.

설정 (`artibot.config.json`):
```json
{
  "team": {
    "worktreeIsolation": {
      "enabled": true,
      "defaultMode": "worktree-isolated",
      "mergeStrategy": "auto",
      "cleanupOnClose": true
    }
  }
}
```

### Agent Teams API 활용

Artibot이 사용하는 Agent Teams API 도구 목록:

| API | 용도 | 사용 시점 |
|-----|------|-----------|
| `TeamCreate` | 팀 생성 | 복잡한 작업 시작 |
| `SendMessage` | P2P 메시징, 브로드캐스트 | 팀원간 소통 |
| `TaskCreate` | 공유 태스크 생성 | 작업 분배 |
| `TaskUpdate` | 태스크 상태 변경, 자기 할당 | 진행 관리 |
| `TaskList` / `TaskGet` | 태스크 조회 | 상태 확인 |
| `Task()` | 팀원 스폰 | 에이전트 추가 |
| `TeamDelete` | 팀 리소스 정리 | 작업 완료 |

### CronCreate 스케줄링

반복 작업을 자동화할 수 있습니다:

```
# 예: 매일 아침 코드 품질 검사 스케줄링
CronCreate으로 주기적 /verify 실행 예약
```

### 1M 토큰 컨텍스트 최대 활용

Artibot의 `token-efficiency` 스킬이 5단계 압축과 심볼 시스템으로 토큰 사용을 최적화합니다:

- 불필요한 반복 제거
- 핵심 정보만 전달하는 심볼 시스템
- 대규모 코드베이스에서도 효율적인 컨텍스트 관리

팁:
- `/load --deep @src/` 로 프로젝트 컨텍스트를 미리 로딩
- `/checkpoint save` 로 중간 상태 저장 후 컨텍스트 절약
- Persistent 팀 모드로 팀원 재소환 토큰 절약

---

## 5. 트러블슈팅

### 한국어 경로 문제 해결

Windows에서 `바탕 화면` 같은 한국어가 포함된 경로에서 Node.js `import()` 실패가 발생할 수 있습니다.

**원인:** `pathToFileURL()`이 비ASCII 문자를 percent-encode하지만, Windows의 `import()`가 이를 해석하지 못함

**해결:** Artibot은 `toFileUrl()` 유틸리티(`scripts/utils/index.js`)로 수동 `file:///` URL을 구성합니다. 커스텀 훅/모듈에서 동적 import 시 이 유틸리티를 사용하세요:

```javascript
import { toFileUrl } from './utils/index.js';
const module = await import(toFileUrl('/path/with/한국어/module.js'));
```

### 훅 디버깅

훅이 예상대로 동작하지 않을 때:

1. **훅 등록 확인:**
   ```bash
   cat ~/.claude/hooks/hooks.json   # 등록된 훅 목록 확인
   ```

2. **stderr 로그 확인:** 훅 스크립트는 stderr로 디버그 로그를 출력합니다:
   ```javascript
   console.error('[hook-name] debug:', data);
   ```

3. **Guard Registry 확인:** 내장 가드가 의도치 않게 차단하는지 확인:
   - 위험 명령 차단 가드
   - 민감 파일 보호 가드
   - 자동 포맷 가드

4. **File Lock 이슈:** 동시 훅 실행 시 상태 파일 경합이 발생할 수 있습니다. Advisory File Lock(spin-lock, fail-open)이 자동 처리하지만, 문제 지속 시 상태 파일을 수동 삭제:
   ```bash
   rm ~/.claude/artibot/*.lock
   ```

### 테스트 실행

```bash
# 프로젝트 루트(plugins/artibot/)에서 실행
npm test                  # 전체 테스트 (3,500+ 케이스)
npm run test:coverage     # 커버리지 리포트
npm run test:bench        # 벤치마크 (27개)
npm run lint              # ESLint 검사
```

### Agent Teams 활성화 안 됨

Agent Teams가 작동하지 않으면:

1. 환경변수 확인: `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`
2. Claude Code 버전 확인 (Agent Teams API 지원 버전 필요)
3. Sub-Agent 모드로 자동 폴백되는 것은 정상 동작입니다

### JSDoc 주석 문법 오류

`/** */` 블록 안에서 `*/`가 포함된 문자열(예: glob 패턴 `**/*.md`)을 쓰면 주석이 조기 종료됩니다.

**해결:** JSDoc 내에서는 `{name}` 형태를 쓰거나 슬래시를 이스케이프하세요.

### 자동 업데이트

```
/artibot:update --check     # 버전 확인
/artibot:update --force     # 강제 업데이트
/artibot:update --dry-run   # 계획만 확인
```

GitHub Releases API를 통해 24시간 캐싱으로 최신 버전을 확인합니다. 네트워크 오류 시 세션 시작을 차단하지 않습니다.

---

## 부록: 전체 커맨드 목록

| 카테고리 | 커맨드 |
|---------|--------|
| 개발 | `/sc`, `/implement`, `/build`, `/build-fix`, `/improve`, `/design`, `/refactor-clean` |
| 분석 | `/analyze`, `/explain`, `/troubleshoot` |
| 품질 | `/code-review`, `/test`, `/tdd`, `/verify`, `/visual-check` |
| 워크플로우 | `/plan`, `/task`, `/git`, `/checkpoint`, `/daily`, `/estimate` |
| 오케스트레이션 | `/orchestrate`, `/spawn`, `/team`, `/playbook` |
| 문서/학습 | `/document`, `/learn`, `/load`, `/index`, `/quickstart` |
| 마케팅 | `/mkt`, `/email`, `/social`, `/ppt`, `/excel`, `/ad`, `/seo`, `/cro`, `/analytics`, `/crm`, `/content` |
| 유틸리티 | `/cleanup`, `/setup`, `/repo`, `/permissions`, `/update`, `/swarm`, `/assemble` |
