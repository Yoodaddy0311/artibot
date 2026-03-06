# Artibot v1.9.0 변경 설명서 (Before/After)

**릴리스 예정일**: 2026-03-06
**기반 Claude Code 버전**: v2.1.69 (103건 변경사항 반영)
**변경 유형**: 훅 시스템 강화, 신규 스킬, 품질 게이트 혁신, 인프라 안정화

---

## 목차

1. [훅 시스템 강화](#1-훅-시스템-강화)
2. [인프라 안정화](#2-인프라-안정화)
3. [신규 기능 (품질 게이트 혁신)](#3-신규-기능--품질-게이트-혁신)
4. [신규 기능 (인지/학습 확장)](#4-신규-기능--인지학습-확장)
5. [요약](#5-요약)

---

## 1. 훅 시스템 강화

### 1-1. InstructionsLoaded 훅

Claude Code v2.1.69에서 추가된 `InstructionsLoaded` 이벤트를 활용하여 CLAUDE.md 및 rules 파일 로딩 시점을 감지합니다.

| 이전 (Before) | 이후 (After) | 영향 (Impact) |
|--------------|-------------|--------------|
| CLAUDE.md, `.claude/rules/*.md` 파일이 로드되는 시점을 알 수 없었음 | `InstructionsLoaded` 훅이 `hooks.json`에 등록되어 로딩 시점 감지 가능. `instructions-loaded.js` 핸들러가 로드된 파일 목록을 기록하고 플러그인 설정 무결성을 검증 | 플러그인 초기화 순서 보장. 설정 파일 누락이나 충돌을 세션 시작 시 즉시 감지 |

### 1-2. agent_id / agent_type 훅 필드

모든 훅 이벤트에 에이전트 식별 정보가 추가되어 에이전트별 추적이 가능해집니다.

| 이전 (Before) | 이후 (After) | 영향 (Impact) |
|--------------|-------------|--------------|
| 훅 이벤트에 어떤 에이전트가 도구를 호출했는지 정보 없음. `tool-tracker.js`, `agent-evaluator.js`에서 에이전트 구분 불가 | hook-utils.js에 `extractAgentId()`, `extractAgentRole()` 헬퍼 추가. tool-tracker, agent-evaluator, team-idle-handler가 에이전트별 메트릭 수집 | 26개 에이전트의 개별 성과 추적 가능. GRPO 자기학습이 에이전트별로 도구 사용 패턴을 최적화 |

### 1-3. TeammateIdle / TaskCompleted stop 지원

Claude Code v2.1.69에서 추가된 `{ stop: true }` 응답으로 유휴 팀원을 자동 종료합니다.

| 이전 (Before) | 이후 (After) | 영향 (Impact) |
|--------------|-------------|--------------|
| TeammateIdle 이벤트 수신 시 메시지 출력만 가능. 유휴 팀원이 무한히 대기하여 리소스 낭비 | `team-idle-handler.js`가 `artibot.config.json`의 `autoStopIdle`, `maxIdleCount` 설정을 읽어 연속 유휴 횟수 초과 시 `{ stop: true }` 반환. 에이전트별 유휴 카운트 상태 파일로 관리 | 팀 세션에서 작업 완료 후 자동 정리. 리소스 낭비 방지. 설정으로 동작 제어 가능 (`autoStopIdle: true`, `maxIdleCount: 3`) |

---

## 2. 인프라 안정화

### 2-1. ${CLAUDE_SKILL_DIR} 마이그레이션

Claude Code v2.1.69에서 추가된 `${CLAUDE_SKILL_DIR}` 변수를 활용하여 스킬 내부 참조 경로를 표준화합니다.

| 이전 (Before) | 이후 (After) | 영향 (Impact) |
|--------------|-------------|--------------|
| 스킬 SKILL.md 내 `references/` 경로 참조 시 상대 경로 또는 하드코딩된 절대 경로 사용. 플러그인 설치 위치가 달라지면 경로 깨짐 | 83개 스킬의 SKILL.md에서 `references/` 참조를 `${CLAUDE_SKILL_DIR}/references/` 형식으로 표준화. 플러그인 설치 위치에 무관하게 동작 | 마켓플레이스 배포 시 경로 문제 해소. 사용자 환경별 설치 경로 차이에 대한 안정성 확보 |

### 2-2. CLAUDE.md 수치 동기화

CLAUDE.md의 모듈 맵 수치가 실제 파일 수와 일치하도록 업데이트합니다.

| 이전 (Before) | 이후 (After) | 영향 (Impact) |
|--------------|-------------|--------------|
| CLAUDE.md에 기재된 수치가 과거 버전 기준으로 실제와 불일치. 예: commands "43" (실제 46), skills "79" (실제 83), learning "9 modules" (실제 11) 등 | 모든 수치를 실측값으로 동기화: agents 26, commands 46, skills 83, lib/learning 11, lib/core 22, hooks.json 15 event types, tests 2,933 | 신규 기여자와 에이전트가 정확한 코드베이스 정보를 기반으로 작업. LLM이 잘못된 컨텍스트로 작업하는 문제 방지 |

### 2-3. MCP 충돌 회피

Claude Code v2.1.69의 MCP 버그(#30989)를 방어하여 `defer_loading`과 `cache_control`의 동시 사용을 방지합니다.

| 이전 (Before) | 이후 (After) | 영향 (Impact) |
|--------------|-------------|--------------|
| `.mcp.json`에 `defer_loading`과 `cache_control`을 동시에 설정할 수 있었음. Claude Code v2.1.69에서 이 조합이 MCP 서버 시작 실패를 유발 | `.mcp.json`에 경고 주석 추가 (`$comment`). 향후 두 옵션 동시 사용 시 로딩 시 검증하는 방어 로직 준비 | Context7, Playwright MCP 서버의 안정적 시작 보장. 설정 실수로 인한 MCP 불능 상태 방지 |

### 2-4. Windows EEXIST 방어

한국어 경로(`바탕 화면`)가 포함된 Windows 환경에서 파일/디렉토리 생성 시 발생하는 EEXIST 에러를 방어합니다.

| 이전 (Before) | 이후 (After) | 영향 (Impact) |
|--------------|-------------|--------------|
| `mkdirSync({ recursive: true })`가 한국어+공백 포함 경로에서 간헐적으로 `EEXIST` 에러 발생. 특히 hook state 디렉토리 생성 시 문제 | `mkdirSync` 호출에 `try/catch` 래퍼 적용. `EEXIST` 에러를 안전하게 무시하고, 다른 에러는 전파. hook-utils.js의 `ensureDir()` 헬퍼에 방어 로직 통합 | 한국어 Windows 환경에서의 안정성 확보. `바탕 화면` 등 비ASCII 경로에서 훅/상태 파일 생성 실패 방지 |

### 2-5. cognitive-router 확장 포인트

Claude Code의 향후 네이티브 effort level API 통합을 위한 확장 포인트를 준비합니다.

| 이전 (Before) | 이후 (After) | 영향 (Impact) |
|--------------|-------------|--------------|
| cognitive-router가 자체 휴리스틱으로만 System 1/2를 분류. Claude Code의 `--think`, `--ultrathink` 등 effort 힌트를 활용하지 못함 | `router.js`에 `setNativeEffort()` 함수 및 `nativeEffortHint` 상태 추가. 네이티브 API 사용 가능 시 effort level을 System 1/2 매핑에 반영하는 통합 계획 문서화 (TODO #30806) | Claude Code가 effort level API를 노출하면 즉시 통합 가능. `low` -> System 1, `high` -> System 2 자동 매핑으로 인지 라우팅 정밀도 향상 |

---

## 3. 신규 기능 -- 품질 게이트 혁신

### 3-1. !rv 재검증 트리거

사용자가 프롬프트에 `!rv`를 포함하면 Claude의 응답을 강제로 재검증합니다.

| 구분 | 설명 |
|------|------|
| **기능** | 프롬프트에 `!rv` (re-validate) 키워드를 포함하면 `user-prompt-handler.js`가 감지하여 재검증 플래그 설정. Stop 훅에서 응답을 차단하고 "코드를 다시 확인하라"는 강제 지시를 주입하여 재검증 후 전달 |
| **동기** | plugins-for-claude-natives의 `doubt` 플러그인에서 영감. Claude가 확신하는 답변도 실제 코드와 대조 검증하도록 강제 |
| **사용법** | `이 함수의 시간 복잡도는? !rv` -- Claude가 답변 전에 실제 코드를 다시 읽고 검증 |
| **기존 대비** | `quality-gate.js`는 코드 패턴 자동 검사 (console.log, 시크릿). `!rv`는 사용자가 원할 때 수동으로 "전체 응답"에 대한 재검증을 트리거하는 보완적 메커니즘 |

### 3-2. verification-before-completion 스킬

작업 완료 선언 전에 반드시 검증 단계를 거치도록 강제하는 스킬입니다.

| 구분 | 설명 |
|------|------|
| **기능** | 에이전트가 "완료했습니다"라고 선언하기 전에 반드시 (1) 변경된 파일 재읽기, (2) 테스트 실행 결과 확인, (3) diff 검증을 수행하도록 워크플로우 강제 |
| **동기** | "읽지 않고 수정", "테스트 안 돌리고 완료 선언" 등 AI 에이전트의 흔한 실수를 구조적으로 방지 |
| **워크플로우** | 수정 -> 재읽기(diff 확인) -> 테스트 실행 -> 결과 검증 -> 완료 선언 허용 |
| **기존 대비** | DEV Protocol의 "VERIFY" 단계를 스킬 레벨에서 명시적으로 구조화. 선언적 규칙에서 실행 가능한 파이프라인으로 승격 |

### 3-3. HARD-GATE 설계 강제

orchestration 스킬에 설계 승인 없이 구현을 시작할 수 없는 강제 게이트를 추가합니다.

| 구분 | 설명 |
|------|------|
| **기능** | 복잡도 점수가 임계값을 초과하는 작업은 반드시 architect 에이전트의 설계 리뷰를 거친 후에만 구현 단계로 진입. 설계 승인 없이 `implement`, `build` 등의 작업을 시작하면 차단 |
| **동기** | 큰 기능 구현 시 설계 없이 바로 코딩에 들어가면 대규모 리팩터링이 필요해지는 문제 방지 |
| **흐름** | 요청 분석 -> 복잡도 평가 -> 임계값 초과 시 `[HARD-GATE]` -> architect 설계 -> 승인 -> 구현 허용 |
| **기존 대비** | orchestration의 라우팅 테이블은 "추천"이었음. HARD-GATE는 "강제" -- 게이트를 우회할 수 없음 |

### 3-4. systematic-debugging 스킬

디버깅을 구조화된 과학적 방법론으로 수행하도록 안내하는 스킬입니다.

| 구분 | 설명 |
|------|------|
| **기능** | (1) 증상 수집, (2) 가설 수립, (3) 가설 검증 실험, (4) 근본 원인 확인, (5) 수정 및 회귀 테스트의 5단계 구조화된 디버깅 프로세스 |
| **동기** | AI 에이전트가 디버깅 시 "코드를 바꿔보고 되는지 확인"하는 시행착오 방식 대신 체계적 접근을 하도록 유도 |
| **출력** | 디버깅 리포트: 증상, 테스트한 가설 목록, 확인된 근본 원인, 적용한 수정, 회귀 테스트 결과 |
| **기존 대비** | `tdd-workflow` 스킬은 테스트 주도 개발. `systematic-debugging`은 버그 발생 후의 체계적 원인 분석에 초점 |

---

## 4. 신규 기능 -- 인지/학습 확장

### 4-1. Drift Detection

에이전트의 작업이 원래 요청에서 벗어나는 "드리프트"를 실시간 감지합니다.

| 구분 | 설명 |
|------|------|
| **기능** | `lib/cognitive/drift-detector.js` 모듈이 (1) 원래 요청의 의도 벡터, (2) 현재 작업의 의도 벡터를 비교하여 유사도가 임계값 이하로 떨어지면 경고. 도구 호출 패턴의 급격한 변화도 드리프트 신호로 활용 |
| **동기** | 복잡한 작업 중 AI가 원래 요청과 무관한 "토끼굴"에 빠지는 현상 방지 |
| **메커니즘** | 키워드 중첩도 비교 + 도구 사용 패턴 변화율 + 시간 경과에 따른 관련성 감소 감지 |
| **기존 대비** | `cognitive-routing`은 요청 시작 시 분류. Drift Detection은 작업 진행 중 실시간 모니터링으로 보완적 역할 |

### 4-2. Self-Knowledge Vault

Artibot 자신의 능력, 한계, 알려진 실패 패턴을 체계적으로 관리하는 자기지식 저장소입니다.

| 구분 | 설명 |
|------|------|
| **기능** | `lib/learning/vault.js` 모듈이 (1) 성공/실패한 작업 유형, (2) 도구별 신뢰도, (3) 알려진 한계점 (예: "대규모 리팩터링 시 파일 누락 빈도 높음")을 구조화된 형태로 저장 |
| **동기** | AI 에이전트가 자신의 한계를 인식하고, 취약한 영역에서는 추가 검증을 자동 수행하도록 자기인식 능력 부여 |
| **활용** | 새 작업 시작 시 vault를 조회하여 유사 작업의 과거 실패 패턴을 확인. 실패 가능성이 높은 영역에 자동으로 추가 검증 단계 삽입 |
| **기존 대비** | `memory-manager`는 범용 기억. Vault는 "자기 자신에 대한 메타 지식"에 특화. 자기인식(self-awareness) 계층 |

### 4-3. 2단계 리뷰 분리

코드 리뷰를 구조적 검토(빠른 패턴 매칭)와 심층 논리 검토(의미 분석)의 2단계로 분리합니다.

| 구분 | 설명 |
|------|------|
| **기능** | Stage 1 (구조적 리뷰): 파일 크기, 함수 길이, import 구조, 네이밍 컨벤션 등 정적 패턴 검사. Stage 2 (논리적 리뷰): 비즈니스 로직 정확성, 엣지 케이스, 보안 취약점 등 의미론적 분석 |
| **동기** | 단일 리뷰에서 구조적 이슈와 논리적 이슈가 혼재하면 둘 다 얕아짐. 분리하면 각 단계의 깊이 확보 |
| **흐름** | Stage 1 (자동/빠름) -> 구조 문제 수정 -> Stage 2 (심층/느림) -> 논리 문제 수정 |
| **기존 대비** | `code-reviewer` 에이전트가 단일 패스 리뷰 수행. 2단계 분리로 System 1/2 인지 모델과 정렬 |

### 4-4. 가설 기반 명확화 (Clarify Pipeline)

모호한 요청을 가설 기반 다지선다 질문으로 정밀 스펙으로 변환하는 파이프라인입니다.

| 구분 | 설명 |
|------|------|
| **기능** | (1) 요청의 모호성 감지 (`ambiguity.js` 확장), (2) 모호한 부분에 대해 가설 기반 MCQ 4개씩 배치 생성 (최대 5-8 질문), (3) Before/After 변환 시각화, (4) 명확화된 스펙 저장 |
| **동기** | plugins-for-claude-natives의 `clarify` 플러그인에서 영감. 열린 질문 대신 "테스트 가능한 가설을 옵션으로 제시"하여 사용자 인지 부하 최소화 |
| **차별화** | Artibot의 `intent/ambiguity.js` 모호성 점수 계산 + GRPO 자기학습과 결합. 어떤 질문 유형이 모호성을 빠르게 해소하는지 학습하여 질문 품질이 세션마다 개선 |
| **기존 대비** | `ambiguity.js`는 점수만 계산. 새 파이프라인은 점수 -> 질문 생성 -> 응답 수집 -> 스펙 변환까지 end-to-end |

---

## 5. 요약

### 변경 통계

| 구분 | 항목 수 |
|------|---------|
| 훅 시스템 강화 | 3건 (InstructionsLoaded, agent_id/type, stop 지원) |
| 인프라 안정화 | 5건 (SKILL_DIR, CLAUDE.md 동기화, MCP 충돌, EEXIST, cognitive 확장점) |
| 신규 품질 게이트 | 4건 (!rv, verification, HARD-GATE, systematic-debugging) |
| 신규 인지/학습 | 4건 (drift detection, vault, 2단계 리뷰, clarify) |
| **합계** | **16건** |

### 카테고리별 영향도

| 카테고리 | 변경 내용 | 사용자 체감 |
|----------|----------|-----------|
| 훅 시스템 | InstructionsLoaded, agent_id/type, stop 지원 | 팀 세션 효율성 향상, 에이전트별 추적 가능 |
| 안정성 | MCP 충돌 방어, Windows EEXIST, CLAUDE.md 동기화 | 환경별 안정성 향상, 정확한 컨텍스트 |
| 품질 | !rv, verification, HARD-GATE, systematic-debugging | 코드 품질 구조적 보장, 재검증 on-demand |
| 인지/학습 | Drift Detection, Vault, 2단계 리뷰, Clarify | 자기인식 AI, 드리프트 방지, 모호성 해소 |

### Claude Code v2.1.69 연동 항목

| Claude Code 변경사항 | Artibot 대응 |
|---------------------|-------------|
| `InstructionsLoaded` 훅 이벤트 추가 | `instructions-loaded.js` 핸들러 + hooks.json 등록 |
| `agent_id`, `agent_type` 훅 필드 추가 | hook-utils.js에 추출 헬퍼 추가, 3개 훅에서 활용 |
| `TeammateIdle` stop 응답 지원 | team-idle-handler.js에 auto-stop 로직 추가 |
| `${CLAUDE_SKILL_DIR}` 변수 추가 | 83개 스킬 references 경로 표준화 |
| MCP defer_loading + cache_control 충돌 | .mcp.json 경고 주석 + 방어 가이드 |
| Windows worktree 파일 복사 수정 | EEXIST 방어 로직과 시너지 |
| 많은 skills/plugins 시 느린 시작 수정 | 83개 스킬 환경에서 시작 시간 개선 |
| `activeForm` SDK 태스크 생성 시 불필요 | TaskCreate 호출 시 activeForm 선택적 사용 가능 |
