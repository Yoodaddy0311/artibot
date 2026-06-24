# ROADMAP — Artibot × "Claude Tag" 패러다임 수렴

> **상태**: 살아있는 로드맵 (forward-looking). 작성 2026-06-24.
> **규율**: 이 문서는 audit-problem-first / no-hallucination 규율을 따른다. 존재하지 않는 통합은 발명하지 않는다. Artibot의 모든 기능 주장은 실제 코드 `file:line` 근거를 동반한다. 근거 없는 항목은 "speculative"로 명시한다.

---

## 1. 배경 / 사실

### Claude Tag란 (확인된 사실)

Anthropic은 2026-06-23 **Claude Tag**를 발표했다 (출처: `anthropic.com/news/introducing-claude-tag`, 별도 claude-code-guide 에이전트로 웹 검증).

- **Slack 통합**이다. 채널에 상주하는 **always-on, 영속적 AI 팀원**으로, 사용자가 `@Claude`로 작업을 위임하거나 인사이트를 요청한다.
- 속성 (발표문에서 모두 CONFIRMED):
  - **멀티플레이어 / 공유 워크스페이스** — 채널당 하나의 Claude가 팀 구성원처럼 참여
  - **이력 기반 컨텍스트** — 채널 히스토리 + 연결된 데이터로부터 맥락 구성
  - **앰비언트 능동성** — 요청 없이도 관련 정보를 표면화
  - **비동기 + 셀프 스케줄링** — 작업을 비동기로 위임받아 처리
  - **채널별 스코프 권한** — admin이 채널별 접근 제어
  - **Opus 4.8** 위에서 동작
- "Claude in Slack"을 대체한다. 발표문은 **30일 이내 마이그레이션**을 안내한다.
  - ⚠️ **정정**: 일부 언론이 인용한 "2026-08-03 sunset" 날짜는 발표 원문에 **명시되어 있지 않다**. 원문은 "30일 마이그레이션 윈도우"만 기술. 본 문서는 정확한 일자를 단정하지 않는다.
- **Anthropic 프레이밍**: "the beginning of an **evolution of Claude Code**" — 모델을 더 능동적으로, 팀과 더 잘 작동하게 만드는 진화의 시작.

### 하드 제약 (수렴 로드맵의 베이스라인)

| 제약 | 사실 | 근거 |
|---|---|---|
| **Slack 전용** | Claude Tag는 Slack 채널 안에서만 산다. Claude Code 표면이 아니다. | 발표문 |
| **Enterprise/Team 전용 (베타)** | Max(개인 Max 20x 포함)·Pro에서는 **사용 불가**. | 발표문 CONFIRMED |
| **Claude Code API/훅 표면 없음** | Claude Tag가 Claude Code 플러그인이 호출할 수 있는 API/webhook/hook을 노출한다는 **증거 없음**. 발표 원문은 기술 상세 zero. | 웹 검증 결과 = UNVERIFIED(증거 없음) |

> **결론 (베이스라인)**: 오늘 시점에 **Artibot은 Claude Tag를 호출할 수 없다**. 둘 사이에 프로그래밍 가능한 연결점이 존재하지 않는다. 따라서 이 로드맵은 **"통합(integration)"이 아니라 "패러다임 수렴(paradigm convergence)"**에 관한 것이다. 가짜 브리지를 만들지 않는다. — Artibot은 이미 Claude Code 안에서 Claude Tag 패턴의 상당 부분을 체화하고 있고, 그 정직한 가치는 거기에 있다.

---

## 2. 패러다임 매핑 — Claude Tag 속성 → Artibot의 기존 대응 능력

각 행의 Artibot 능력은 실제 코드로 검증했다. 검증 불가 항목은 명시한다.

| Claude Tag 속성 | Artibot 기존 대응 | 검증 근거 (`file:line`) | 수렴도 |
|---|---|---|---|
| **앰비언트 / always-on** (요청 없이 작동) | **앰비언트 대화 원장(ledger)** — Stop/SessionEnd 훅이 매 턴 자동 발화, 사용자 명령 없이 트랜스크립트를 슬림화·시크릿 redact 후 로컬 원장에 증분 append | `scripts/hooks/session-ledger.mjs:3-8` ("Fires automatically every turn (Stop)… with NO user command"); `lib/learning/ledger/store.js:221-264` (`captureTurn`/`runCapture`) | **높음** |
| **앰비언트 능동 트리거** (의도 감지 후 선제 제안) | **Operator-Waits DNA 자동 팀** + **meta-prose 힌트 주입** — 슬래시 입력 없이 의도에서 병렬 팀이 발화; runtime-prompt 훅이 advisory 힌트 주입 | `artibot.config.json:132-152` (`team.autoApply:true` + `autoApplyTriggers`); `scripts/hooks/runtime-prompt.js:1-11` (UserPromptSubmit 프롬프트 인리치) | **중간** (advisory — 강제 실행 아님) |
| **이력 기반 학습** (채널 히스토리 + 연결 데이터) | **크로스세션 로컬 메모리** — 사용자 선호/프로젝트 컨텍스트/명령 이력/에러 패턴 영속화 + 세션 요약 벡터(TF-IDF, 임베딩 API 호출 없음) + 평생학습 경험/패턴 | `lib/learning/memory-manager.js:24-29` (STORE_FILES), `:86-88` (로컬 dir); `lib/learning/session-memory.js:24-25` (로컬 경로), `:10` ("no embedding API calls"); `lib/learning/lifelong-learner.js:27-29` (로컬 경로) | **높음** (단, 단일 머신 로컬 — 멀티플레이어 아님) |
| **System2→System1 지식 전이** | **knowledge-transfer** — 성공한 숙고 패턴을 빠른 직관 패턴으로 승격 (로컬 저장) | `lib/learning/knowledge-transfer.js:21-23` (로컬 경로), `:67` (`writeJsonFile(SYSTEM1_PATH…)`) | **중간** (에이전트-간 네트워크 전이 아님 — 로컬 패턴 스토어 내 승격) |
| **스코프 정체성 / 권한** (채널별) | **28개 전문 에이전트 + 에이전트별 도구 스코프 + 모델 티어** — 각 에이전트 frontmatter `tools:`가 사용 가능 도구를 한정 (예: architect는 read-only, orchestrator는 조율 프리미티브만) | `agents/architect.md:20-29` (`tools:` Read/Glob/Grep/Task only, `permissionMode: plan`); `agents/orchestrator.md:21-35` (Team*/Task* 프리미티브, 파일편집 도구 없음); `artibot.config.json:8-65` (modelPolicy high/medium 티어) | **높음** |
| **권한 시드** (반복 prompt 제거) | **설치 시 read-only 권한 시드** — Read/Glob/Grep를 `~/.claude/settings.json#permissions.allow`에 시드 (로컬 전용, 네트워크 없음) | `install.sh:508` (`ARTIBOT_SAFE_ALLOW=(Read Glob Grep)`), `:564` (`_seed_permission_allow`); `install.ps1:78` (동일) | **높음** |
| **비동기 / 셀프 스케줄링** | **`/autopilot`** (3~4h 무인 자율 7-phase) + **wakeup-scheduler** (다음 세션에 wakeup을 *마커로* 신호 — API 직접 호출 안 함) | `commands/autopilot.md:8-10`; `lib/learning/wakeup-scheduler.js:1-8` ("Does NOT call any ScheduleWakeup / spawn API directly — marker-only"), `:232-287` (`requestWakeup` rate/depth-gated marker) | **중간** (셀프 스케줄링은 마커-only — 진짜 자율 wakeup 아님) |
| **멀티플레이어 / 공유 워크스페이스 상주** | **Agent Teams** (P2P 메시징 + 공유 task list) — 단, 이는 *에이전트 팀* 내부 멀티플레이어이지 *인간 다중 사용자* 공유 워크스페이스가 아님 | `artibot.config.json:166-180` (team API: SendMessage/TaskCreate…) | **낮음** (인간-멀티플레이어 부재 — §3 갭 참조) |

### 매핑에서 명시적으로 부정하는 주장 (over-claim 방지)

- ❌ **"swarm은 로컬 전용"** — 거짓. swarm은 **opt-in federated 동기화**로 외부로 데이터를 보낼 수 있다. 단, **기본값은 비활성 + localhost**: `artibot.config.json:801-805` (`enabled:false, optIn:false, serverUrl:'http://localhost:3000'`), 이중 게이트 `lib/swarm/swarm-config.js:46-52` (`enabled` AND 로컬 consent). 과거 GCP run.app 기본 엔드포인트는 v4.x에서 제거됨 (`artibot.config.json:805` 정책 노트). → swarm을 "이력 학습 멀티플레이어"의 근거로 쓰지 **않는다**. 기본 출하 상태에서 외부 전송 경로는 없다.
- ❌ **"/schedule 명령"** — 존재하지 않음. `commands/` 디렉터리에 `schedule.md` 없음 (확인됨). 셀프 스케줄링은 `wakeup-scheduler.js` 마커 + `/autopilot`로만 표현된다.

---

## 3. 수렴 갭 — Artibot이 Claude Tag 패러다임 대비 결여한 것 (DATA POLICY 내 빌드 가능)

아래는 **실재하고 + Artibot DATA POLICY(로컬 전용, 외부 DB/포워딩 금지) 안에서 빌드 가능한** 갭만 나열한다.

| 갭 | 현재 상태 | Claude Code 안에서 현실적으로 빌드 가능한 방향 | DATA POLICY 적합 |
|---|---|---|---|
| **인간 멀티플레이어 / 공유 프레즌스** | Agent Teams는 에이전트-간 P2P일 뿐, 여러 *인간*이 공유하는 상주 엔티티가 아니다 (`artibot.config.json:166-180`) | Claude Code는 단일-사용자 CLI 세션 모델. 진짜 멀티플레이어는 플랫폼 표면이 없어 **빌드 불가에 가까움**. 대안: 프로젝트 스코프 원장(`.artibot/ledger/`)을 git으로 공유해 *비동기* 팀 컨텍스트 공유 → 단, 이는 "상주 프레즌스"가 아니라 "공유 로그". | 부분적 (git 공유는 사용자 소유 repo 한정) |
| **크로스세션 앰비언트 능동성** | 원장은 캡처(write)는 앰비언트지만, 다음 세션에서 "관련 정보를 선제 표면화"하는 read-back 능동 루프는 약함. wakeup은 마커-only (`wakeup-scheduler.js:1-8`) | 세션 시작 훅에서 원장/메모리/wakeup 마커를 읽어 **"지난 세션에서 X가 미해결입니다" 1줄 advisory**를 표면화 (강제 실행 없이). 이는 기존 hint 패턴(`runtime-prompt.js`)의 자연스러운 확장. | **적합** (로컬 read + advisory only) |
| **자율 셀프 스케줄링** | wakeup은 마커만 쓰고 실제 wakeup API를 호출하지 않음 (의도된 안전 설계) | Claude Code가 ScheduleWakeup류 표면을 노출하지 않는 한 마커-only가 천장. **갭이지만 플랫폼-blocked** — 빌드 가능 영역 아님 (명시적 비-항목). | n/a (플랫폼 제약) |

> 갭 중 **유일하게 "빌드 가능 + DATA POLICY 적합 + 고가치"**인 것은 **크로스세션 앰비언트 read-back advisory** 하나다. 나머지는 플랫폼-blocked이거나 공유-로그 수준으로 격하된다.

---

## 4. 모니터링 트리거 — 진짜 브리지를 여는 신호

아래 신호 중 하나라도 관측되면 해당 액션이 *비로소* 정당화된다. 그 전까지는 통합 작업 금지 (YAGNI).

| # | 감시 신호 | 어디서 | 관측 시 해제되는 액션 |
|---|---|---|---|
| T1 | **Claude Tag API / webhook 공개** — `claude.com/docs/claude-tag/*`에 프로그래밍 표면(REST/webhook/event) 등장 | Claude Tag 공식 docs (발표문이 상세를 이 docs로 위임) | Artibot ↔ Tag 브리지 ADR 작성 + `mcp-developer` 에이전트로 MCP 어댑터 설계 착수 |
| T2 | **Claude Code ↔ Tag 표면** — Claude Code 릴리즈 노트에 Tag 연동 훅/툴 등장 | Claude Code 릴리즈 노트 / changelog | hooks.json에 Tag 이벤트 핸들러 등록 스펙 작성 |
| T3 | **티어 확장** — Claude Tag가 Max/Pro로 가용성 확대 | Anthropic news / pricing 페이지 | 사용자 베이스(개인 Max 사용자)가 실제로 닿을 수 있게 되므로 수렴 가치 재평가 |
| T4 | **"evolution of Claude Code" 후속** — Anthropic이 Tag를 Claude Code에 가져온다고 명시 | Anthropic news | 로드맵 전면 재작성 (패러다임 수렴 → 실통합 전환) |

> 액션 원칙: T1/T2 중 하나가 **실제로** 관측되기 전에는 어떤 통합 코드도 작성하지 않는다. 트리거는 발산이 아니라 게이트다.

---

## 5. 지금 할 수 있는 것 (NOW)

각 항목은 3-게이트를 통과해야 한다: (a) 이미 존재하지 않는가? (b) DATA POLICY 적합한가? (c) YAGNI 위반 아닌가? — 소수 고가치 항목만 남긴다. **거의 빈 목록이 정직한 결과다.**

| # | 항목 | 3-게이트 판정 | 비고 |
|---|---|---|---|
| N1 | **크로스세션 앰비언트 read-back advisory** — 세션 시작 시 로컬 원장/메모리/wakeup 마커를 읽어 "지난 세션 미해결 X" 1줄 advisory 표면화 (강제 실행 없음) | (a) 미존재(캡처는 있으나 read-back 능동 루프 약함) (b) 로컬 read + advisory = 적합 (c) §3에서 유일 고가치 갭 → YAGNI 통과 | **유일한 실질 NOW 후보.** 기존 `runtime-prompt.js` hint 패턴 확장. speculative 아님 — 데이터(`.artibot/ledger/`, wakeup 마커)는 이미 존재 |
| N2 | **본 로드맵 문서화 + 모니터링 트리거 등록** | (a) 미존재 (b) 로컬 문서 (c) 통합 전 "감시 대상" 명시는 향후 over-build 방지 | 이 문서 자체 = N2의 산출물 |

### NOW에서 **제외**한 것 (정직성 기록)

- Claude Tag API 어댑터 / MCP 브리지 — **T1/T2 미관측** → YAGNI 위반, 제외.
- 인간 멀티플레이어 프레즌스 — 플랫폼 표면 부재 → 빌드 불가, 제외.
- 자율 wakeup 실행 — 플랫폼-blocked → 제외.
- swarm을 "Tag형 공유 학습"으로 마케팅 — DATA POLICY상 기본 비활성 + 외부 전송이라 패러다임 매핑 근거로 부적합 → 제외.

---

## 부록 — 검증 메서드

- Artibot 능력: 본 저장소 코드를 직접 Read + 2개 Explore 에이전트 병렬 검증 (scoped-identity/permission-seed, learning/swarm/memory). 모든 행에 `file:line`.
- Claude Tag 사실: `claude-code-guide` 에이전트로 `anthropic.com/news/introducing-claude-tag` 웹 검증. claim 1·2·4·5 CONFIRMED, claim 3(sunset 일자) CORRECTED, claim 6(Claude Code 표면) UNVERIFIED=증거 없음.
- 무변경(null-result)은 정당한 결과다 — 이 로드맵의 NOW 목록이 짧은 것은 결함이 아니라 규율의 산물이다.
