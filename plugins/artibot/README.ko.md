# Artibot

![Tests](https://img.shields.io/badge/tests-872%20passed-brightgreen) ![Coverage](https://img.shields.io/badge/coverage-90.92%25-brightgreen) ![Dependencies](https://img.shields.io/badge/dependencies-0-blue) ![Node](https://img.shields.io/badge/node-%3E%3D18-green) ![License](https://img.shields.io/badge/license-MIT-blue)

[English](README.md) | **한국어**

Claude Code를 위한 **Agent Teams 기반** 지능형 오케스트레이션 플러그인. Claude의 네이티브 Agent Teams API를 핵심 엔진으로 사용하여 전문 에이전트 팀 구성, P2P 통신, 공유 태스크 관리를 통해 개발 생산성을 극대화합니다.

---

## 목차

- [핵심 특징](#핵심-특징)
- [설치](#설치)
- [빠른 시작](#빠른-시작)
- [아키텍처](#아키텍처)
- [벤치마크 비교 (vs MoAI)](#벤치마크-비교-vs-moai)
- [프로젝트 구조](#프로젝트-구조)
- [기여하기](#기여하기)

---

## 핵심 특징

### Agent Teams API 네이티브 통합

Artibot의 핵심 엔진은 Claude Code의 **Agent Teams API**입니다. 단순한 서브에이전트(Task) 패턴이 아닌, 진정한 팀 오케스트레이션을 제공합니다.

| 기능 | 서브에이전트 (기존) | Agent Teams (Artibot) |
|------|---------------------|----------------------|
| 통신 | 부모에게만 결과 반환 | P2P 양방향 메시징 (SendMessage) |
| 태스크 관리 | 부모가 전체 관리 | 공유 태스크 리스트 (TaskCreate/TaskList) |
| 자기 할당 | 불가 | 팀원이 스스로 태스크 선택 (TaskUpdate) |
| 팀원간 소통 | 불가 | 직접 DM + 브로드캐스트 |
| 계획 승인 | 불가 | plan_approval_response |
| 생명주기 | 일회성 | 생성 -> 작업 -> 종료 -> 정리 |

**사용하는 Agent Teams API 도구:**
- `TeamCreate` / `TeamDelete` -- 팀 생명주기 관리
- `SendMessage` -- DM, 브로드캐스트, 셧다운, 계획 승인
- `TaskCreate` / `TaskUpdate` / `TaskList` / `TaskGet` -- 공유 태스크 관리
- `Task(type, team_name, name)` -- 팀원 스폰

### 인지 아키텍처 (Cognitive Engine)

Kahneman의 이중 처리 이론에서 영감을 받은 지능형 라우팅 시스템:

- **System 1** (빠른 직관): 100ms 이내 처리, confidence >= 0.6인 반복 패턴
- **System 2** (심층 분석): 샌드박스 환경에서 심층 추론, 최대 3회 재시도
- **적응형 임계값**: 성공/실패 피드백으로 자동 조정 (기본값 0.4)
- **다국어 지원**: en/ko/ja 키워드 감지

### 자기학습 시스템 (Self-Learning)

외부 AI 없이 순수 규칙 기반으로 동작하는 학습 파이프라인:

- **GRPO** (Group Relative Policy Optimization): 후보 그룹 내 상대 비교로 전략 최적화
- **Knowledge Transfer**: System 2 -> System 1 패턴 승격 (3회 연속 성공 시)
- **Lifelong Learner**: 세션 경험 수집 -> GRPO 배치 학습 -> 패턴 추출 -> 영구 저장
- **Tool Learner**: Toolformer 방식의 도구 선택 학습
- **Self Evaluator**: Meta Self-Rewarding 패턴 기반 자율 품질 평가
- **Memory Scopes**: user (영구) / project (프로젝트별) / session (휘발성)

### 마케팅 버티컬

개발 워크플로우를 넘어 마케팅 전문 에이전트 팀 지원:

- **8개 마케팅 에이전트**: content-marketer, marketing-strategist, data-analyst, seo-specialist, cro-specialist, ad-specialist, presentation-designer, repo-benchmarker
- **11개 마케팅 커맨드**: /mkt, /email, /social, /ppt, /excel, /ad, /seo, /cro, /analytics, /crm, /content
- **23개 마케팅 스킬**: SEO 전략, CRO 퍼널, A/B 테스트, 이메일 마케팅, 소셜 미디어 등
- **4개 마케팅 플레이북**: marketing-campaign, marketing-audit, content-launch, competitive-analysis

### 보안 및 프라이버시

- **PII Scrubber**: 50+ 정규식 패턴으로 개인정보 자동 마스킹
- **Federated Swarm**: 차분 프라이버시 노이즈 + 오프라인 큐
- **Zero Dependencies**: Node.js 내장 모듈만 사용 (npm 공급망 공격 완전 차단)
- **텔레메트리 미수집**: 명시적 옵트인 없이는 수집 없음

---

## 설치

### 사전 요구사항

- Node.js >= 18.0.0
- Claude Code CLI (최신 버전)
- `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` 환경 변수

### Agent Teams 활성화 (필수)

```json
// ~/.claude/settings.json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  }
}
```

### Marketplace 등록 후 설치 (권장)

```bash
# 마켓플레이스 등록 (최초 1회)
claude plugin marketplace add https://github.com/Yoodaddy0311/artibot

# 플러그인 설치
claude plugin install artibot@artibot
```

### 로컬 경로 설치

```bash
git clone https://github.com/Yoodaddy0311/artibot.git
claude plugin install ./artibot/plugins/artibot
```

### 검증

```bash
node plugins/artibot/scripts/validate.js
```

---

## 빠른 시작

### 5분 시작 가이드

```bash
# Step 1: Agent Teams 활성화
echo '{"env":{"CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS":"1"}}' > ~/.claude/settings.json

# Step 2: 마켓플레이스 등록 + 플러그인 설치
claude plugin marketplace add https://github.com/Yoodaddy0311/artibot
claude plugin install artibot@artibot

# Step 3: 검증
node plugins/artibot/scripts/validate.js

# Step 4: 첫 번째 명령 실행
/sc 로그인 기능 구현해줘
```

### 자동 라우팅

`/sc` 커맨드가 자연어 의도를 분석하여 최적 커맨드로 자동 라우팅합니다:

```
/sc 로그인 기능을 구현해줘
  -> /implement로 라우팅
  -> TeamCreate -> planner + architect + developer + reviewer 팀 구성

/sc 이 코드의 보안 취약점을 분석해줘
  -> /analyze --focus security로 라우팅
  -> security-reviewer 서브에이전트 위임 (단순 작업)
```

### 팀 오케스트레이션

복잡한 작업에는 Agent Teams를 활용합니다:

```
/orchestrate 결제 시스템 구현 --pattern feature
  -> TeamCreate("payment-feature")
  -> Task(planner) + Task(architect) + Task(developer)
  -> TaskCreate per phase (plan -> design -> implement -> review)
  -> SendMessage로 팀원간 조율
  -> shutdown_request -> TeamDelete
```

### 직접 커맨드

```
/implement 사용자 인증 API --type api --tdd
/code-review @src/auth/
/test --coverage
/git commit
```

---

## 아키텍처

```
┌─────────────────────────────────────────────────────┐
│                    사용자 요청                         │
└──────────────┬──────────────────────────────────────┘
               v
┌─────────────────────────────────────────────────────┐
│            /sc 라우터 (의도 분석, en/ko/ja)             │
│     keyword 40% + context 40% + flags 20%           │
└──────────────┬──────────────────────────────────────┘
               v
┌─────────────────────────────────────────────────────┐
│          Cognitive Router (Kahneman System 1/2)      │
│   confidence >= 0.6 -> System 1 (직관, <100ms)       │
│   confidence <  0.6 -> System 2 (분석, sandbox)      │
└──────────────┬──────────────────────────────────────┘
               v
┌─────────────────────────────────────────────────────┐
│        위임 모드 선택 (complexity scoring)              │
│   score < 0.6 -> Sub-Agent    score >= 0.6 -> Team  │
└──────┬──────────────────────────────┬───────────────┘
       v                              v
┌──────────────┐           ┌──────────────────────────┐
│  Sub-Agent   │           │   Agent Teams Engine      │
│  Task() 위임  │           │                          │
│  결과 반환     │           │  TeamCreate              │
│              │           │    -> Task(type,team,name) │
│              │           │    -> TaskCreate/Update    │
│              │           │    -> SendMessage (P2P)    │
│              │           │    -> TeamDelete           │
└──────────────┘           └──────────────────────────┘
                                      v
                           ┌──────────────────────────┐
                           │   orchestrator (CTO)      │
                           │  Leader|Council|Swarm|    │
                           │  Pipeline|Watchdog        │
                           └─────────┬────────────────┘
                                     v
                           ┌──────────────────────────┐
                           │   25개 전문 에이전트 (팀원)  │
                           │  TaskList -> 자기할당       │
                           │  SendMessage -> P2P 소통   │
                           │  TaskUpdate -> 완료 보고    │
                           └──────────────────────────┘
                                     v
                           ┌──────────────────────────┐
                           │   Learning Pipeline       │
                           │  Self Evaluator -> GRPO   │
                           │  -> Knowledge Transfer    │
                           │  -> Memory Manager        │
                           └──────────────────────────┘
```

### 역할 분리 원칙

| 계층 | 역할 | Agent Teams API |
|------|------|----------------|
| **Commands** | 인터페이스 (사용자 진입점) | TeamCreate 트리거 |
| **Agents** | 행동 (자율 실행 단위) | 팀원: SendMessage + TaskUpdate |
| **Skills** | 지식 (도메인 전문성) | 위임 모드 결정 기준 |
| **Hooks** | 자동화 (이벤트 반응) | SubagentStart/Stop, TeammateIdle |
| **Cognitive** | 인지 (복잡도 분류) | System 1/2 라우팅 |
| **Learning** | 학습 (경험 축적) | GRPO + Knowledge Transfer |

### 오케스트레이션 패턴

| 패턴 | 용도 | 구현 |
|------|------|------|
| **Leader** | 계획, 의사결정 | TaskCreate -> TaskUpdate(owner) -> collect results |
| **Council** | 설계, 검증 | 복수 팀원 -> SendMessage로 토론 -> 리더 결정 |
| **Swarm** | 대규모 구현 | TaskCreate(no blockedBy) -> 팀원 self-claim |
| **Pipeline** | 순차 의존성 | TaskCreate(addBlockedBy) -> 자동 언블로킹 |
| **Watchdog** | 지속 모니터링 | 별도 팀원이 주기적 TaskList 확인 + SendMessage 알림 |

---

## 벤치마크 비교 (vs MoAI)

Artibot과 MoAI(Mixture of AI) 프레임워크의 아키텍처 비교:

| 영역 | Artibot | MoAI / 일반 플러그인 |
|------|---------|---------------------|
| **오케스트레이션 엔진** | Claude Native Agent Teams API | Task() 서브에이전트 또는 외부 프레임워크 |
| **인지 라우팅** | Kahneman System 1/2 이중 처리 | 단일 처리 또는 규칙 기반 |
| **학습 방식** | GRPO + Self-Rewarding (외부 AI 불필요) | 사전 학습만 또는 외부 피드백 의존 |
| **지식 전달** | System 2 -> System 1 자동 승격/강등 | 해당 없음 |
| **집단 지능** | Federated Swarm + 차분 프라이버시 | 해당 없음 |
| **프라이버시** | PII Scrubber (50+ 패턴) + 로컬 퍼스트 | 제한적 |
| **런타임 의존성** | 0개 (Node.js built-in only) | 다수의 npm 패키지 |
| **도구 학습** | Toolformer + GRPO 자동 선택 | 고정 규칙 |
| **메모리 관리** | 3-scope (user/project/session) | 단일 또는 2단계 |
| **다국어 의도 감지** | en/ko/ja 네이티브 지원 | 영어 중심 |
| **마케팅 버티컬** | 8 에이전트 + 11 커맨드 + 23 스킬 | 해당 없음 |
| **팀 통신** | P2P 양방향 (SendMessage) | 단방향 (결과 반환만) |
| **적응형 임계값** | 성공/실패 피드백으로 자동 조정 | 고정 |
| **테스트 커버리지** | 872 tests, 90.92% coverage | 가변적 |

### 혁신 포인트

1. **Kahneman System 1/2 인지 라우팅**: 요청 복잡도를 5개 요인 (steps, domains, uncertainty, risk, novelty)으로 분류하여 빠른 직관 처리 vs 심층 분석을 자동 선택
2. **GRPO 자기학습**: 후보군 생성 -> 규칙 기반 평가 -> 그룹 내 상대 비교 -> 가중치 업데이트. 외부 AI 판사 없이 동작
3. **Knowledge Transfer 핫스왑**: 높은 성공률의 System 2 패턴을 System 1로 실시간 승격. 파일 레벨 락으로 동시성 안전
4. **연합 집단 지능**: 차분 프라이버시 노이즈 주입 + PII 스크러빙으로 개인정보 보호하면서 학습 패턴 공유
5. **BlenderBot 영감 Memory RAG**: 3-scope 메모리 (user/project/session)와 패턴 추출을 통한 맥락 유지
6. **Toolformer + GRPO 도구 선택**: 도구 사용 이력 추적 -> 컨텍스트별 성공률 학습 -> GRPO 상대 비교로 최적 도구 추천

---

## 프로젝트 구조

```
plugins/artibot/
├── .claude-plugin/plugin.json   # 플러그인 매니페스트
├── artibot.config.json          # 런타임 설정 (Agent Teams, cognitive, learning)
├── package.json                 # Node.js ESM, zero prod deps
│
├── agents/          (26 files)  # 에이전트 정의 (Markdown)
│   ├── orchestrator.md          #   CTO / 팀 리더
│   └── [25 specialist agents]   #   팀원들
│
├── commands/        (38 files)  # 슬래시 커맨드 정의
│   ├── sc.md                    #   메인 라우터
│   └── [37 commands]
│
├── skills/          (77 dirs)   # 스킬 정의 (SKILL.md + references/)
├── hooks/hooks.json             # 훅 이벤트 매핑 (12 이벤트)
├── scripts/hooks/   (18 files)  # ESM 훅 스크립트
│
├── lib/             (40 modules)
│   ├── core/                    # 코어 (platform, config, cache, io, debug, file, tui, skill-exporter)
│   ├── intent/                  # 의도 감지 (language, trigger, ambiguity)
│   ├── context/                 # 컨텍스트 (hierarchy, session)
│   ├── cognitive/               # 인지 엔진 (router, system1, system2, sandbox)
│   ├── learning/                # 학습 (memory, grpo, knowledge-transfer, lifelong, tool-learner, self-evaluator)
│   ├── privacy/                 # 프라이버시 (pii-scrubber)
│   ├── swarm/                   # 연합 지능 (swarm-client, pattern-packager, sync-scheduler)
│   ├── system/                  # 시스템 (telemetry-collector, context-injector)
│   └── adapters/                # 멀티모델 어댑터 (gemini, codex, cursor, antigravity)
│
├── output-styles/               # 출력 스타일 (default, compressed, mentor, team-dashboard)
└── templates/                   # 작성 템플릿 (agent, skill, command)
```

---

## 기여하기

기여를 환영합니다! 자세한 내용은 다음 문서를 참고하세요:

- [CONTRIBUTING.md](CONTRIBUTING.md) -- 기여 가이드 (에이전트/스킬/커맨드 추가 방법, 훅 작성, 코드 스타일)
- [SECURITY.md](SECURITY.md) -- 보안 정책 및 취약점 신고
- [CHANGELOG.md](CHANGELOG.md) -- 변경 이력
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) -- 시스템 아키텍처 상세
- [docs/INNOVATION.md](docs/INNOVATION.md) -- 혁신 아키텍처 상세

버그 리포트: [GitHub Issues](https://github.com/Yoodaddy0311/artibot/issues)

---

## 라이선스

MIT License - Artience
