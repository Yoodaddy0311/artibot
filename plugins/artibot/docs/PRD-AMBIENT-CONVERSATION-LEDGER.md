# PRD: Ambient Conversation Ledger — 무명령 대화 캡처 + 컨텍스트/학습 환류

> **Status**: Draft (설계 검토 대기) · **Created**: 2026-06-24 · **Owner**: Artibot core
> **성격**: `Downloads/log-hooks`(Python `save_log.py`)의 *아이디어*를 Node/ESM 훅으로 포팅 + 보안·DATA POLICY 게이트를 더해 Artibot에 접목. 코드 미구현 — 설계 + 단계적 빌드 플랜.
> **Phase 1 분해 완료 (2026-06-24, planner 코드대조)**: 정정 3건 반영 — (1) 훅 등록은 `hooks.json` 직접이 아니라 `hooks/dispatch-table.json` `handlers[]` append, (2) gitignore는 **루트** `.gitignore`, (3) F-04 redactor는 신규 불필요(`lib/privacy/pii-scrubber.js#scrub` 재사용). §11 Open Decision #1·#2 해소. redact 토큰 = 기존 `[REDACTED_KEY]` 채택(사용자 결정). 상세 태스크 T1~T8 = 대화 핸드오프 참조.
> **제1원칙 (사용자 명시 요구)**: **슬래시 커맨드 없이 언제나 자연스럽게 스며들어 작동.** 사용자는 이 기능의 존재를 의식하지 않는다 — Stop/SessionEnd 훅으로 매 턴/세션 종료 시 자동 발동하며, 출력·확인·지연을 만들지 않는다. "효율적 업무 처리"는 (a) 무명령 자동성, (b) denoise로 다운스트림 토큰 절감, (c) 증분(append) 처리로 매 턴 비용 최소화로 달성한다.

## 1. 배경 (확정 사실)

`Downloads/log-hooks` 검수 결과(158줄 전수): `save_log.py`는 Stop/SessionEnd 훅으로 `transcript_path`를 읽어 **대화 라인만 슬리밍**(tool_use·thinking·isMeta·스킬목록 제거, user/assistant 텍스트만)하고 `cwd/logs/<tool>/<session>.jsonl`로 저장한다. 네트워크·subprocess·eval **전무 = 외부 유출 코드 0**. 그러나 (1) `logs/` 가 .gitignore에 없어 **평문 대화 실수 커밋 위험**, (2) 크기 캡 없음, (3) **Python 의존**이 Artibot zero-dep·ESM·Node 아키텍처와 충돌(Windows 주력 사용자 `python3` 부재 시 silent 실패)이 발견됨.

**핵심 통찰**: 슬리밍된 per-session 대화 아카이브는 Artibot에 **현재 없는 신규 가치**다. 기존 `stop-recap.js`는 transcript를 *읽지만 메트릭만 내고 버린다*. 이 denoised 코퍼스는 컨텍스트 복원·학습 신호·메모리 통합의 공통 원천이 된다.

**재사용 자산 (코드 확인 완료)**:
- `scripts/hooks/stop-recap.js:80-103` — `countToolUsesSinceLastUser(transcriptPath)`: 이미 Stop 훅에서 `payload.transcript_path`(`:151`)를 읽고 **4MB DoS 캡**(`:31`)으로 JSONL을 안전 파싱. → transcript-read + 캡 패턴을 **그대로 재사용**.
- `save_log.py:34-101` — 슬리밍 알고리즘(`_claude_has_text` isMeta 스킵, `_content_text` text-block 추출, codex event_msg/response_item 분기). → **Node 포팅 대상 로직**.
- `lib/handoff/handoff-store.js#writeHandoff` — `keep N` 회전 보관 + 아카이브 패턴. → ledger 회전에 재사용.
- `lib/handoff/handoff-builder.js` §7(컨텍스트 복원 핵심 파일) + `/resume` — 컨텍스트 환류 주입점.
- `lib/privacy/` — differential privacy(ε=1.0) + SHA-256 해시. → 학습/swarm 환류 시 **필수 경유 게이트**.
- `lib/learning/` (continuous-learning, GRPO, pattern-extraction) — denoised 코퍼스를 학습 신호로 흡수할 소비자.

**갭(설계가 메워야 할 것)**:
1. denoised 대화를 **영구 보존**하는 컴포넌트 부재 (stop-recap은 읽고 버림).
2. 슬리밍 로직이 Python에만 존재 — **Node 포팅** 필요.
3. 저장소 **.gitignore + secret redaction** 게이트 부재(검수에서 드러난 #1 리스크).
4. 컨텍스트/학습 레이어로의 **환류 어댑터** 부재.

## 2. 목표 / 비목표

**목표**: 매 턴/세션 종료 시 **무명령으로 자동 발동**하는 Node Stop/SessionEnd 훅을 만들어, 세션 트랜스크립트를 denoise(대화만)하여 **gitignored 로컬 원장**(`.artibot/ledger/`)에 증분 저장하고, 이를 (a) `/resume`·handoff 컨텍스트 복원, (b) 학습 파이프라인의 클린 신호로 환류한다. 전부 DATA POLICY(로컬 only) 안에서, 사용자가 의식하지 않게.

**비목표**:
- `Downloads/log-hooks`의 Python 스크립트 그대로 접목 (아키텍처·portability 충돌 — §3 ADR-2).
- 슬래시 커맨드로 수동 실행하게 만들기 (제1원칙 위반 — 무명령 자동성이 핵심).
- 원장 raw를 swarm/외부로 송신 (DATA POLICY — privacy 레이어 미경유 송신 금지).
- 전체 트랜스크립트(tool/thinking 포함) 보존 (denoise가 목적 — 토큰·프라이버시 둘 다 손해).
- 기존 `stop-recap.js` 메트릭 기능 대체 (병존 — 별 책임).
- 매 턴 전체 파일 재작성 (증분 append — §3 ADR-4, 효율 요구).

## 2.5 Goal Contract

```json
{
  "objective": ".artibot/ledger/<session>.jsonl 에 매 턴 denoised 대화를 증분 append 하는 Node Stop/SessionEnd 훅 + secret-redaction + gitignore 게이트 + /resume·learning 환류 어댑터를 구현한다. 사용자 명령 없이 자동 발동하며 세션을 절대 블록하지 않는다",
  "stoppingCondition": "훅·원장·redaction·환류 코드가 머지되고 npm run ci 통과 + 회귀 테스트(slim/redact/append/non-block) 통과. 실 환류 채택(학습 입력 승격)은 별 게이트",
  "validationCommand": "npm run ci",
  "maxIterations": 5
}
```

## 3. 핵심 결정 (ADR 스타일)

### ADR-1: 발동 메커니즘 = Stop + SessionEnd 훅 (무명령·always-on)
- **Drivers**: 사용자 제1요구(커맨드 없이 스며듦) · 매 턴 자동성 · 출력/지연 0.
- **Options**: (A) 슬래시 커맨드 수동 — *기각, 제1원칙 위반*. (B) Stop 훅만 — 턴마다 캡처되나 세션 종료 누락 가능. (C) **Stop + SessionEnd 둘 다** — 턴 증분 + 종료 최종화. **채택: C** (`save_log.py`도 `.claude/settings.json`에서 Stop+SessionEnd 둘 다 등록).
- **근거**: 훅 = Artibot "Auto-invoke Principle"의 정석. 사용자가 슬래시를 타이핑하지 않아도 의도 무관하게 발동.
- **등록 메커니즘 (planner 정정)**: `hooks.json`은 슬롯마다 단일 **디스패처**(`_stop-dispatcher.js`/`_sessionend-dispatcher.js`)만 등록하고, 실제 훅 목록의 단일 진실원은 `hooks/dispatch-table.json`이다(line 3 명시: "Adding a new hook = appending one entry here"). 신규 훅 = `Stop.handlers[]`(`:57-63`)와 `SessionEnd.handlers[]`(`:69-75`)에 `{ "name":"session-ledger", "script":"session-ledger.mjs", "timeoutMs":5000 }`(SessionEnd는 8000) 각각 append. **`hooks.json` 무수정**. `stop-recap`이 같은 테이블에 등록된 선례.

### ADR-2: Node/ESM 포팅 (Python 스크립트 미접목)
- **Drivers**: zero-dep·ESM·Node only 아키텍처(`CLAUDE.md` Stack) · Windows 주력 portability.
- **Decision**: `save_log.py` 슬리밍 로직을 `scripts/hooks/session-ledger.mjs`로 포팅. Python 의존 제거 → `python3` 부재 머신에서 silent 실패 위험 소거. hooks는 `.mjs`(Windows 호환, go.md DATA POLICY와 동일 규약).

### ADR-3: 저장소 = gitignored `.artibot/ledger/` (로컬 only)
- **Drivers**: 검수 #1 리스크(평문 대화 실수 커밋) · DATA POLICY.
- **Decision**: `.artibot/ledger/<session_id>.jsonl`. **루트** `.gitignore`(`:79` `.artibot/` 관리 지점)에 `.artibot/ledger/` **선행 추가**(구현 1순위 게이트 — 플러그인 .gitignore 아님). `.artibot/HANDOFF.md`와 동거하되 ledger는 추적 제외. 절대 외부 송신 없음.

### ADR-4: 증분 append (매 턴 전체 재작성 금지)
- **Drivers**: "효율적 업무 처리" 요구 · 훅 성능 예산.
- **Decision**: 세션별 파일에 **마지막 캡처 이후 신규 대화 라인만 append**. 워터마크(마지막 처리 line offset/hash)를 `.artibot/ledger/.cursor.json`에 기록. 전체 슬리밍은 SessionEnd에서 1회 최종 정합 검사. → 매 턴 O(신규라인), 긴 세션도 비용 일정.

### ADR-5: 저장 전 secret redaction (검수 보강)
- **Drivers**: 슬리밍은 tool/thinking만 버리고 **user 텍스트의 시크릿은 그대로 보존** — 검수에서 드러난 잔존 리스크.
- **Decision (planner 확정)**: 기존 `lib/privacy/pii-scrubber.js#scrub`(`:106`) 재사용 — `pii-detector.js`에 `sk-`(`:81-87`)·`AKIA`(`:129-135`)·Bearer(`:201-207`)·JWT(`:217-223`)·`KEY=value`(`:225-273`)·dotenv(`:293-299`) 패턴 전부 존재. 치환 토큰 = `[REDACTED_KEY]`/`[REDACTED_SECRET]`(사용자 결정 — 신규 모듈 회피). 범위는 `createScopedScrubber(['credentials','auth','secrets','env'])`(`:348`)로 **시크릿 카테고리만** — 이메일/IP/경로 같은 비-시크릿 대화는 보존(컨텍스트 환류 품질). 신규 redactor 작성 금지.

### ADR-6: 환류는 기존 레이어 경유 (신규 업로드 경로 신설 금지)
- **Drivers**: DATA POLICY · 중복 방지.
- **Decision**: (컨텍스트) handoff-builder/`/resume`가 ledger를 읽어 §7/직전대화 요약 주입. (학습) 학습 파이프라인이 ledger를 입력으로 소비하되 **swarm 송신은 반드시 `lib/privacy/` differential-privacy 경유**. 원장 raw 직송 금지.

## 4. 기능 요구사항

### F-01 — 무명령 자동 캡처 훅 (P0) ★제1원칙
**세부 요구사항**
- R1. `hooks/dispatch-table.json`의 `Stop.handlers[]` + `SessionEnd.handlers[]`에 `{ "name":"session-ledger", "script":"session-ledger.mjs", "timeoutMs":5000/8000 }` 각각 append(디스패처 무수정). 사용자 슬래시 커맨드·확인·플래그 **없이** 발동.
- R2. 훅은 stdin payload에서 `transcript_path`·`session_id`·`cwd`를 읽는다(필드 읽기 = `save_log.py:117-119`, transcript 소비 선례 = `stop-recap.js:151`).
- R3. 어떤 경우에도 **stdout 미출력**(Codex가 Stop stdout을 decision으로 파싱 — `save_log.py:105`), 에러는 stderr만, **항상 exit 0**(세션 비블록).
- R4. 사용자에게 보이는 출력·프롬프트·승인 0건.

**Acceptance Criteria**
- AC1. WHEN 한 턴이 종료된다 THE SYSTEM SHALL 사용자 개입 없이 ledger 캡처를 1회 수행한다.
- AC2. WHEN 캡처 로직이 예외를 던진다 THE SYSTEM SHALL stderr에만 기록하고 exit 0으로 세션을 진행시킨다.
- AC3. GIVEN 사용자가 어떤 커맨드도 입력하지 않았다 WHEN 세션이 종료된다 THEN ledger 파일이 갱신돼 있어야 한다.

### F-02 — 대화 슬리밍 (denoise) (P0)
**세부 요구사항**
- R1. `save_log.py:34-101` 로직을 Node 포팅: user/assistant 텍스트 블록만 유지, tool_use/tool_result/thinking/isMeta/스킬목록 드롭. **Phase 1은 claude-code 분기만** — codex 분기는 P2(F-07). 원본 미열람(repo 밖)이므로 포팅 근거 = 본 PRD §4 명세(사용자 결정).
- R2. claude-code: `type∈{user,assistant}` & `!isMeta` & text 존재(`_claude_has_text`). codex: `event_msg`(user/agent_message) 우선, 없으면 `response_item` 폴백, system prefix(`<permissions`…) 제외.
- R3. 보존 라인은 **원본 JSONL 라인 그대로**(스키마 무손상). 파싱 불가 라인 스킵. 대화 라인 0이면 verbatim 폴백 대신 **빈 결과로 기록 스킵**(원본 통째 복사 금지 — 프라이버시).

**Acceptance Criteria**
- AC1. WHEN transcript에 tool_use·thinking 라인이 포함된다 THE SYSTEM SHALL 그것들을 ledger에서 제외한다.
- AC2. GIVEN isMeta=true 인 `/context` 덤프 라인 WHEN 슬리밍한다 THEN 해당 라인은 보존되지 않는다.
- AC3. WHEN 슬리밍 결과가 0 라인이다 THE SYSTEM SHALL 원본 verbatim 복사를 하지 않는다.

### F-03 — gitignored 로컬 원장 + 증분/회전 (P0)
**세부 요구사항**
- R1. 저장 경로 `<projectRoot>/.artibot/ledger/<safe_session>.jsonl`. session_id는 basename + `./..` 거부(`save_log.py:128-130`).
- R2. **루트** `.gitignore`(`:79`)에 `.artibot/ledger/` 추가(구현 **1순위 게이트**, F-04보다 먼저). 검증: `git check-ignore .artibot/ledger/x.jsonl`.
- R3. 매 턴 **신규 라인만 append**(ADR-4), 워터마크 `.artibot/ledger/.cursor.json` 기록.
- R4. 회전: 세션 파일 keep N(기본 50), 초과 시 mtime 오름차순 제거(`handoff-store.js` 패턴).
- R5. 전체 read는 4MB 캡(`stop-recap.js:31`).

**Acceptance Criteria**
- AC1. WHEN ledger가 처음 생성된다 THE SYSTEM SHALL `.gitignore`가 `.artibot/ledger/`를 무시함을 전제한다(테스트로 검증).
- AC2. GIVEN 같은 세션의 두 번째 턴 WHEN 캡처한다 THEN 직전 워터마크 이후 신규 라인만 append 된다(전체 재작성 아님).
- AC3. WHEN 세션 파일 수가 keep N을 초과한다 THE SYSTEM SHALL 가장 오래된 파일부터 제거한다.

### F-04 — Secret redaction (P0)
**세부 요구사항**
- R1. 저장 직전 redaction 패스: API 키(`sk-…`), AWS(`AKIA…`), Bearer/JWT, `KEY=value` 시크릿류. 매칭 → `[REDACTED_KEY]`/`[REDACTED_SECRET]`(기존 토큰).
- R2. **`lib/privacy/pii-scrubber.js#scrub`(또는 `createScopedScrubber`) 재사용 — 신규 redactor 금지**(planner 확정). 얇은 어댑터만 둘 경우 `lib/learning/ledger/redact.js`로 위임.
- R3. redaction은 **저장 전** — 디스크에 원문 시크릿이 닿지 않게. `validateScrubbed`(`pii-scrubber.js:294`)로 2차 확인 가능.

**Acceptance Criteria**
- AC1. WHEN 대화 텍스트에 `sk-`로 시작하는 API 키가 있다 THE SYSTEM SHALL 그것을 `[REDACTED_KEY]`로 치환해 저장한다.
- AC2. GIVEN AWS 액세스 키 패턴 WHEN ledger에 기록한다 THEN 원문이 디스크에 존재하지 않는다.

### F-05 — 컨텍스트 복원 환류 (P1)
**세부 요구사항**
- R1. `/resume`·handoff-builder가 ledger의 직전 세션 대화를 읽어 "직전 대화 핵심" 요약을 §7 인접에 주입(denoise라 토큰 저렴).
- R2. 환류는 읽기 전용 — ledger를 변형하지 않음.

**Acceptance Criteria**
- AC1. WHEN `/resume`가 실행된다 THE SYSTEM SHALL 직전 세션 ledger가 있으면 그 대화 요약을 복원 컨텍스트에 포함한다.
- AC2. GIVEN ledger 부재 WHEN `/resume` 한다 THEN 기존 동작을 그대로 유지(graceful)한다.

### F-06 — 학습 신호 환류 (P1)
**세부 요구사항**
- R1. 학습 파이프라인이 ledger denoised 코퍼스를 pattern-extraction 입력으로 소비.
- R2. swarm/외부 송신은 **반드시 `lib/privacy/` differential-privacy(ε=1.0) 경유**. raw 직송 금지.

**Acceptance Criteria**
- AC1. WHEN 학습이 ledger를 입력으로 쓴다 THE SYSTEM SHALL privacy 레이어를 거치지 않은 raw를 swarm으로 보내지 않는다.

**구현 스코프 (2026-06-26 확정 — 검토 게이트 채택)**
- D1. `lib/learning/ledger/corpus.js` — `readSessionCorpus(projectRoot,{sessionId?,limit?,sinceCursor?})` → denoised 대화 라인[]. `slim.js` 재사용, never-throw, 로컬 read only, 세션당 watermark(store.js cursor 패턴 재사용)로 중복 소비 방지.
- D2. **검토 대기열** — corpus를 학습 승격 전 검토 큐에 적재, 사용자 승인 후에만 `lifelong-learner.collectExperience` 공급. `/dreaming` human-review 게이트(F-08) 패턴 재사용 후보.
  - **[SHIPPED 2026-07-03 — 커맨드 표면 배선]** `lib/learning/ledger/review-queue.js`(enqueue/list/approve/reject)를 `/learning review` 서브커맨드(`scripts/ledger-review.js`)로 실배선. **pull-model**(리더 결정): 적재는 `review` 호출 시점에 발생(SessionEnd 훅 자동 enqueue 아님 — 프라이버시 민감 승격은 명시적 휴먼 게이트 유지). `review`=신규 corpus 적재+대기 목록, `review approve <id|--all>`=collectExperience 승격+dequeue, `review reject`=미승격 dequeue. 감사 IMP-02 L-01(HIGH, end-to-end dormant) 해소.
- D3. **R2 enforcement** — ledger-유래 패턴이 `swarm-client` `scrubPattern`+`addNoise`(ε=1.0) 미경유 송신 불가 가드 + AC1 테스트.
- D4. 회귀 테스트 — corpus 리더 / 검토 큐 / privacy 우회 차단(80%+).
- Note: R2 privacy 체인은 기존 swarm 경로가 이미 충족 — 신규는 corpus 리더·검토 큐·우회 가드뿐. Codex 분기(F-07)·`/learning` 통계(F-09)는 범위 밖.

### 기능 요약 (P2 이하)
| ID | 기능 | 우선순위 |
|----|------|---------|
| F-07 | Codex 분기(event_msg/response_item) 동등 지원 | P2 |
| ~~F-08~~ | `/dreaming` 메모리 통합 입력으로 ledger 연결 | ✅ **SHIPPED** (2026-06-29) — 연결+소비(전체). D1 collector ledger signal + D3 nightly 배선(projectDir/signals) + D2 distiller freshness 보호(`freshTermsVector`+archive 필터, signals와 cosine≥0.3 겹치는 stale memory archive 제외). 기존 unwired-signals 갭 동시 해소. |

**F-08 구현 스코프 (2026-06-29 확정 — 연결+소비)**
- **발견**: `/dreaming` collector(`collector.js`)는 handoffs/notes/corrections를 `signals`로 수집하나 **distiller가 미소비**(`nightly-dream-consolidate.mjs:186`은 `memories`만 distill에 전달; `distillCandidates(memories, opts)`에 signals 파라미터 없음). 기존 unwired-signals 갭 → ledger 단순 추가만으론 no-op. 사용자 결정 = 갭까지 동시 해소.
- **D1** `collector.js` ledger 소스: `if(projectDir)` 블록에 D1 `readSessionCorpus(projectDir,{limit})` 재사용, 세션당 `{kind:'ledger', source, externalSignal:true, text, hash}` provenance, read-only.
- **D2** distiller signal 소비: `distillCandidates(memories, {signals, config, now})` — **freshness 보호**(archive-candidate(stale memory)의 핵심 용어가 recent signal 텍스트와 임계 이상 겹치면 archive 후보에서 제외 = "지금 대화 중인 건 보관처리 안 함"). 모순-from-signals 강등은 stretch.
- **D3** `nightly-dream-consolidate.mjs`: `collect()`의 `signals`를 `distillCandidates`에 전달(기존 갭 배선).
- **D4** 회귀 테스트: collector ledger 소스 + distiller freshness 보호(TDD).
- **위험**: consolidation 판정 변경 → `/dreaming` human-review 게이트가 안전망. ledger 길이 캡 + recent N 필요.
| ~~F-09~~ | ledger 통계(`/learning` 표면에 캡처율·redaction 카운트) | ✅ **SHIPPED** — `lib/learning/ledger/stats.js#computeLedgerStats` + `learning-diag.js#renderLedgerStats` 6번째 섹션 (sessions/lines/redactions+%/consumed+%/pending/bytes, 프로젝트-로컬 read) |

## 5. 핵심 플로우 시나리오

**시나리오 A — 사용자는 아무것도 안 한다 (제1원칙 실증)**
> 사용자가 평소처럼 코드를 짜고 질문한다. 슬래시 커맨드 0건. 매 턴 끝에 `session-ledger.mjs`가 조용히 발동 → 그 턴의 새 user/assistant 대화만 `.artibot/ledger/<session>.jsonl`에 append. 화면엔 아무 변화 없음. 세션 종료 시 SessionEnd가 최종 정합. 다음 날 `/resume` 하면 "직전 대화 핵심"이 컨텍스트에 자동으로 끼어 있어, 어제 맥락을 5초에 복원한다.

**시나리오 B — 시크릿이 대화에 섞임**
> 사용자가 `OPENAI_API_KEY=sk-proj-abc123…`를 붙여넣고 질문. 슬리밍은 이 user 텍스트를 보존 대상으로 분류하지만, **저장 직전 redaction**이 `[REDACTED_KEY]`로 치환 → 디스크 ledger엔 원문 키가 없다. 커밋돼도(애초에 gitignored) 유출 0.

**시나리오 C — 긴 세션 효율**
> 200턴 세션. 매 턴 전체 재슬리밍이면 누적 비용 O(n²). 대신 워터마크 기반 증분 append로 매 턴 O(신규라인) → 200턴이어도 훅 지연 수십 ms 유지. "효율적 업무 처리" 충족.

## 6. NFR (수치 강제)
- **훅 지연**: 턴당 p95 < 150 ms(증분), SessionEnd 최종화 < 500 ms. 하드 캡 초과 시 조기 반환 + stderr 경고.
- **read 캡**: transcript 4 MB(초과분 tail만, `stop-recap.js:31` 동일).
- **저장 회전**: 세션 파일 keep 50(설정 가능), 초과 mtime 오름차순 제거.
- **비블록**: 모든 실패 경로 exit 0, 세션 진행 절대 차단 금지.
- **출력**: 사용자 가시 stdout 0 바이트.

## 7. 위험 & 완화
| 위험 | 영향 | 완화 |
|------|------|------|
| `.artibot/ledger/` gitignore 누락 | 평문 대화 커밋·푸시 | F-03 R2를 **구현 1순위**, 테스트로 강제(AC) |
| redaction 우회(신종 시크릿 포맷) | 일부 시크릿 잔존 | 패턴 확장 가능 구조 + gitignore가 2차 방어선 |
| 훅 지연이 UX 체감 | 턴 느려짐 | 증분 append + 하드 캡 조기반환(NFR) |
| Python 잔재 혼선 | 두 구현 공존 | Downloads 원본은 참고용, 접목은 .mjs only(ADR-2) |
| 학습 raw 유출 | DATA POLICY 위반 | F-06 R2 privacy 경유 강제 |

## 8. 실행계획 (단계)
- **Phase 1 (P0 코어)**: `.gitignore` 게이트 → `session-ledger.mjs`(F-01) + slim 포팅(F-02) + 증분 store(F-03) + redaction(F-04) + 회귀 테스트(slim/redact/append/non-block). `npm run ci` green.
- **Phase 2 (P1 환류)**: `/resume`·handoff 컨텍스트 주입(F-05) + 학습 입력 어댑터(F-06, privacy 경유). **[부분 SHIPPED `f33d705`, 2026-06-26]** Roadmap N1 = SessionStart read-back advisory(`scripts/hooks/session-readback.mjs` + `lib/learning/ledger/readback.js`)로 첫 환류 증분 출하 — 세션 시작 시 직전 handoff `다음 P0`(→wakeup→ledger) 1줄 표면화(advisory-only). F-06(학습 환류) corpus 리더(D1)·검토 큐(D2)·egress 가드(D3)는 구현 완료, **[SHIPPED 2026-07-03]** `/learning review` 커맨드 표면으로 실배선(pull-model, IMP-02 L-01 해소).
- **Phase 3 (P2)**: Codex 분기(F-07) · `/dreaming` 연결(F-08) · `/learning` 통계(F-09).

## 9. 수락 기준 (전체)
- [ ] 사용자 명령 없이 매 턴/세션종료 ledger 갱신(F-01 AC1~3).
- [ ] tool/thinking/isMeta 제외, 대화만 보존(F-02 AC1~3).
- [ ] `.artibot/ledger/` gitignored + 증분 append + 회전(F-03 AC1~3).
- [ ] 시크릿 redaction 후 저장(F-04 AC1~2).
- [ ] 모든 실패 exit 0, stdout 0(F-01 AC2, NFR).
- [ ] `npm run ci` 통과.

## 10. DATA POLICY 준수
전부 로컬 파일시스템. 외부 DB·네트워크·송신 0. 학습/swarm 환류는 `lib/privacy/` differential-privacy 경유만. ledger는 gitignored — 레포에 추적되지 않음.

## 11. 미확정 항목 (Open Decisions)
| 항목 | 블로커 영향 | 결정 주체 | 상태 |
|------|------------|----------|------|
| ~~`lib/privacy/` redactor 존재 여부~~ | F-04 재사용 vs 신규 | planner 코드대조 | ✅ **해소** — `pii-scrubber.js#scrub` 재사용 |
| ~~저장 위치 `.artibot/ledger/` vs `runtime/ledger/`~~ | 회전·정리 정합 | 코드 확인 | ✅ **해소** — `.artibot/ledger/`(루트 `.gitignore` 관리) |
| ~~redact 토큰 형식~~ | AC 정합 | 사용자 | ✅ **해소** — 기존 `[REDACTED_KEY]` 채택 |
| ~~학습 입력 승격을 자동 vs 검토 게이트~~ | F-06 자율성 범위 | 사용자(프라이버시 민감) | ✅ **해소**(2026-06-26) — **검토 게이트**. ledger 코퍼스는 자동으로 검토 대기열에 적재하되, 학습 승격은 사용자 승인 후. 우회 송신 금지(scrub+DP 강제). |
| keep N 기본값 50 적정성 | 디스크 사용량 | 사용 패턴 관측 후 | 미결 |
