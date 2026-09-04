# Artibot 5.0 통합 설계안 — 리더 통합 v1 (2026-09-02)

> 상태: **설계안(적용 전)**. 오너 지시 "바로 적용하지 말고 설계안을 먼저" — 코드 변경 0, 커밋 0.
> 입력 정본: `package/`(v1.0 Canonical Design Package, 22파일, MANIFEST 21/21) · `package-v1.1/`(Canonical State & Intent Architecture v1.1, 22파일, MANIFEST 21/21). 두 사본은 루트 `docs/` 원본과 `diff -rq` 차이 0(레인 1·3 실측, 리더 † 재확인). **이 디렉터리 전체는 아직 미추적**(`git status` `??`, 리더 † 실측).
> 추가 입력(†): `ADDENDUM-HARDENING.md`(Final Architecture Hardening Addendum, 52절 1,464줄, sha256 `6100779671b8…` = Downloads 원본과 동일) — **§7 에서 판정**. 충돌하는 곳은 §7 이 §1~§5 의 레인 기반 본문을 덮어쓴다.
> 추가 입력 2(15:12 실측): `MODEL-SWITCHING-SCORECARD.md`(Model Switching & Terminal Scorecard Final Benchmark-Backed Implementation Design, 68절 2,773줄, sha256 `e37d1a884519…` = `docs/…v1.1/` 원본과 동일 — 오너가 v1.1 폴더에 넣어 그 폴더는 이제 24항목) — **§8 에서 판정**.
> 선행 설계: `../vnext-design/`(자율 런타임, /split 중심 — P1 구현 완료, ADDENDUM 참조).
> 방법: 읽기 전용 레인 7개(v1.0 + v1.1 각각 대조) → 리더가 핵심 인용 직접 재측정(§0-1) → 통합. 레인 원문은 세션 스크래치패드 `v5-lane{1..7}-*.md`(총 ~1,600줄, † 기준).
> 등급 표기: **실측**(리더 또는 레인이 직접 실행) / **추론** / **미확인**. 레인이 붙인 미확인은 §6 에 그대로 전파.

---

## 0. 오너 결정 (AskUserQuestion 실답 — 설계의 전제)

| # | 결정 | 내용 |
|---|---|---|
| OD-1 | NL 자동 활성화 | **단계적 전환** Observe → Shadow → Canary(저위험만 자동) → GA. 커맨드는 고급 오버라이드로 유지. 파괴·배포·외부쓰기·제품결정은 단계와 무관하게 항상 사람 게이트 |
| OD-2 | 모델 플릿 | **4티어 어휘**(Haiku/Sonnet/Opus/Fable)로 확장하되 Haiku·Sonnet 배정은 shadow 측정 후. 그전 실효 티어는 2티어(설계·검수 fable / 나머지 opus, v4.52.0) |
| OD-3 | 문서 거버넌스 | **설계 정본은 git 추적, 실행 산출물은 로컬 + 보존기간 규칙.** 사본 금지, 포인터 우선 |
| OD-4 | 상태 저장소(2차 결정, 15:1x) | **권고안 채택** — F1 = JSONL 이벤트 + 파생 스냅샷 + 파일락 + CAS 를 `StateStore` 인터페이스 뒤에(`node:sqlite` 는 인터페이스 호환만, 나중), F3 = 위치는 worktree 가 공유하는 `git rev-parse --git-common-dir` 아래. → Replay Store·Checkpoint Store(§8)도 **같은 백엔드·같은 위치** |
| OD-5 | "사람에게 묻기"(2차 결정, 15:1x) | **대화형 승인 = `AskUserQuestion`** (오너 표현 "questionUserAnswer" 는 설계 문서 명칭, 실제 도구는 `AskUserQuestion` — 레인 1 실측). 훅은 묻지 못하므로: 훅 `block + human-gate:HG-nn` → 모델이 **반드시 `AskUserQuestion`(권장 옵션 첫째 + "(권장)")** 으로 사람에게 묻고 답을 받은 뒤에만 진행. 비대화형 실행(autopilot·split 창)은 `PAUSE` + 원장 `human.asked` + 사람이 돌아와 답할 때까지 정지. C1 확정 |

### 0-1. 리더 재측정 기록 (레인 인용 중 결정에 영향 주는 것만 직접 실행)

> **시각 표기 정정(architect 지적, 리더 `date` 실측 2026-09-02 15:00:36 KST, 파일 mtime 14:59:30)**: 이 문서에서 리더가 적은 "15:1x~16:3x" 류 시각은 **시계를 읽지 않고 적은 추정치**였고 실제보다 약 1시간 앞섰다(verification-discipline §4 위반 — 레인 1 이 오전에 자진 정정한 것과 같은 종류). 해당 표기는 전부 `†` 로 치환했다. `†` 는 "리더 편집 시점, 절대 시각 무효, **상대 순서만 유효**" 를 뜻한다. 레인이 `date`·mtime·vitest 출력으로 실측한 시각(14:05·14:13·14:16·14:20·14:46·14:57 등)은 그대로 유효하다. 리더 재측정은 전부 14:2x~15:00 사이(근거: architect 크로스체크 14:20~14:46, 이 정정 15:00).

| 레인 주장 | 명령 | 결과 |
|---|---|---|
| L5 `pre-write-guard` 가 `.claude/` 경로를 무조건 승인 | `sed -n 44,50p scripts/hooks/pre-write-guard.js` | **확인** — `isWhitelisted` 가 `normalized.includes('.claude/')` 로 true |
| L5 `blockExternalSend/pauseOnDanger/blockSecretLeak` 읽는 코드 0 | `grep -rn … lib scripts` (테스트 제외) | **0건** |
| L5 decision-events 호출자는 SDK 미들웨어뿐 | `grep -rln recordWorkflowPlanDecision\|recordRoutingDecision lib scripts` | `lib/runtime/middleware/{router,tasks}.js` + 정의 파일만. `runtime/decisions/` 부재 |
| L5 `autopilot.limits.maxBudget` 소비자 0 | `grep -rn maxBudget lib scripts` | `session-sizer.js` 주석·리터럴 3건뿐 |
| L1 "PreToolUse 슬롯이 dispatch-table 에 없어 신설 필요" vs L5 "PreToolUse 훅이 강제" | `grep -n PreToolUse hooks/hooks.json` + dispatch-table 키 | **둘 다 참, L1 결론은 정정**: PreToolUse 는 `hooks.json` 에 **직접 7훅** 등록(pre-write·pre-bash·bash-risk-guard·pre-write-guard·git-autopilot-guard·pre-write-checkpoint·webfetch-cache-pre — reviewer 정정, 리더 † 재실행). dispatch-table 슬롯만 없다. Bash 를 보는 훅이 **둘**(`pre-bash` fail-closed + `bash-risk-guard` fail-open)이므로 HG 매트릭스는 **`pre-bash` → `guard-registry` 체인(fail-closed 층)** 에 붙인다. `bash-risk-guard` 는 경고 층으로 유지 |
| L4 검수 verdict 소비자는 report-generator 뿐 | `grep -n "crossCheck.verdict\|verifyResult" lib/autopilot/engine.js` | engine.js 히트는 **지시 문자열(:443, :510)과 mcp 슬롯 쓰기(:469-470)** 뿐 — 전이에 읽는 곳 없음. **확인** |
| L7 ADR 두 계열 001~003 충돌 | `ls docs/adr; ls plugins/artibot/docs/adr` | 두 계열 모두 **001~005**(각 5개 + 루트 INDEX.md). L7 의 "001~003" 은 과소 — 충돌 범위가 더 넓다 |
| L7 루트 `.artibot/` status 류 6파일 | `ls -la .artibot/*.md` | 6개 맞음. 구성은 DEADCODE-BACKLOG·HANDOFF·SESSION-NOTES(42KB)·**stage-b-side-diagnosis**·TRACK-B·WIRE-BACKLOG — L7 목록의 NEXT-SESSION 은 `guides/` 아래라 여기 아님 |
| L7 `instructions-loaded.js:4` "CLAUDE.md 와 .claude/rules 만" | `sed -n 1,8p` | 주석 확인 |
| L3 `PRD-SPLIT-…-2.md` 가 원본과 같은 `slug:` | `head -5` 양쪽 | 둘 다 `slug: split-cross-session-multi-worktree` — **같은 문서 두 파일** |
| L3 표류 원장 `scripts/hooks/.artibot/ledger/` | `du -sk` | 149KB 존재 |
| L6 `runtime/autopilot/` 12,067파일 | `find -type f \| wc -l` | **12,089** — 증가가 아니라 **측정 방법 차이**(레인 6 정정 †): `ls \| wc -l` 최상위 항목 12,067(14:05·14:57 동일) vs `find -type f` 재귀 12,089. 둘 다 참 |
| L7 `.plan-state.json` 2개 | `find` | 루트 + `docs/PRD/` — 확인 |
| L5(v1.1 보강) "추적 사본 `package-v1.1/` 에 18 파일 부재" | `ls` 양쪽 + `diff -rq` | **틀림** — † 원본·사본 모두 22파일, `18_PROJECT_TEMPLATE.md` 양쪽 존재, diff 0줄. 정정을 레인에 회신. **† 재측정(reviewer)**: 원본 23파일 — 오너가 Hardening Addendum 을 `docs/…v1.1/` 에도 넣음. 그 파일은 `ADDENDUM-HARDENING.md` 로 바이트 동일 사본 존재(`cmp` IDENTICAL) → 누락 없음 |
| L5(v1.1 보강) 18 템플릿 "Human Approval Boundaries" 는 제목만 있고 본문 0줄 | `grep -n -A3 "Human Approval" 18_PROJECT_TEMPLATE.md` | **확인** — :17 헤딩, :18 빈 줄, :19 다음 헤딩. 레인 7 "신규 절" 판정과 일치 |

| L4(v1.1 보강) `commands/team.md:291` 이 cross-check 프롬프트에 `요구사항: {original requirements}` 를 리더 문자열로 보간 | `sed -n 289,292p commands/team.md` | **확인** — 검수 기준이 리더 요약(worker-local 해석)인 것이 현재 기본 경로. v1.1 09 §7 위반 |

레인 자체 정정 3건도 그대로 싣는다: L7 은 "rules 소스 구버전" 을 CRLF 오독으로 철회(§3.7), L1 은 본문 시각 표기가 실측이 아님을 자진 정정(모든 L1 시각은 "14:16 이전, 건별 미기록"), L5 는 "18 파일 부재" 를 cwd 리셋으로 인한 오독으로 철회. **~~리더 사고 1건~~ → 철회(†, reviewer 자진 정정)**: "레인 4 v1.1 반영본(362줄)이 리더의 `scratchpad/` 삭제로 유실됐다" 는 보고는 **사실이 아니었다** — 그 파일은 삭제된 적 없이 리포 루트에 mtime 14:15·362줄로 남아 있었고, 중간의 "없음" 관측은 한 시점 관측을 삭제로 단정한 오류(verification-discipline §6 시점 관측 ≠ 상태). 실제 이력: 14:05 v1 → 14:08 리더 복사 → 14:15 통합본(리포 루트) → 14:42 §5 부록(세션 경로). 두 판은 표현이 다른 병렬본이었고, 설계 문구 13종 대조 후 **세션 경로 판(446줄)을 정본**으로 확정, 리포 루트 판은 세션 경로에 `.repo-362.bak.md` 로 백업 후 삭제(리포 트리 깨끗). 남는 교훈은 동일: 레인 산출 경로는 절대경로로 명시, 삭제 전 `cmp`.

---

## 1. 통합 원칙

1. **두 패키지는 같은 방향의 두 층.** v1.0 = 런타임 파이프라인(Intent→Mission→Plan→Context→Router→Topology→Execute→Review→Verify→Recover)과 경제·헌법. v1.1 = 그 파이프라인이 읽고 쓰는 **정본 상태·산출물**(ARTIBOT.md → project.md → state.yaml → missions/ → adr/ → ledger.jsonl). 충돌 시 **v1.1 이 산출물·상태·물리 형식의 정본, v1.0 이 런타임 단계·경제·헌법의 정본**. 실측된 충돌 1건(v1.0 `run-ledger.js` 구조화 레코드 vs v1.1 중앙 `ledger.jsonl` 이벤트 스트림)은 v1.1 물리 형식 + v1.0 스키마를 fold 뷰로 두어 둘 다 만족(§3.6).
2. **진실원 규칙 (레인 5·6·7 화해 → Hardening §1.1 로 확정)**: 라이브 진실은 **트랜잭션 상태 저장소**(StateStore — 미션·태스크 그래프·lease·controller 락), 이력은 **append-only ledger.jsonl**, `state.yaml` 은 **사람이 읽는 투영**이며 언제든 `store + ledger` 에서 재생성된다(Hardening §31). 근거 실측: worktree 마다 `.artibot/` 이 따로 있어 state.yaml 을 진실로 두면 split 창마다 사본이 갈라진다(v1.1 §06 "state.yaml = canonical live state" 는 단일 트리 가정 — 폐기). 불변식 `ledger ⊇ store`, `rebuild(ledger) ≠ store` 면 ledger + git 증거가 이기고 store 를 재작성(`run-store.js#rebuildState` 와 같은 규칙 = reconcile 의 정의, `/doctor` 가 검사). 저장 위치와 백엔드는 결정 F1·F3(§7.4) — 권고: 백엔드는 레인 6 의 JSONL + 파일락 + CAS 를 StateStore 인터페이스 뒤에 두고, 위치는 worktree 가 공유하는 `git rev-parse --git-common-dir` 아래. verification-discipline §2 "기록 있음 ≠ 작동" 과 v1.1 §02 우선순위 1·2위는 그대로 성립한다.
3. **v5 = 헌법·제품층(what/why), vNext = split/autopilot 실행 런타임 스펙(how).** v5 §13 의 모듈 이름을 새로 짓지 않고 vNext §03·05·06·07 + ADDENDUM 을 세부 정본으로 인용. `lib/supervisor/` 이름 유지(테스트 76·게이트 등록 완료). vNext recovery(세션 죽음) 와 v5 recovery(결과 실패)는 의미가 달라 이름을 분리(§3.5).
4. **현행 규율 무변경.** verification-discipline · DEV Protocol · 보고/중계 계약 · fail-closed 게이트 · vitest-only 게이트 규칙은 v5 의 "Reason with AI, act with reality" · "기록됨 ≠ 작동" 과 같은 취지(레인 7 판정: 원칙 14 중 충돌 2건은 전부 **스킬층·blindspot 층**, 규칙층 충돌 0). verification-discipline 에는 말미 §13 "충돌 기록 우선순위" 6줄만 추가(삭제·완화 0).
5. **재작성 금지 · additive 우선.** 기존 커맨드·에이전트는 호환 래퍼로 남고, 새 모듈은 전부 순수 함수 + 어댑터. Observe 단계에서는 어떤 행동도 바꾸지 않고 **기록만** 한다(`lib/supervisor/` S0 와 `split.contextLifecycle.enabled=false` 출하 선례).
6. **정책과 선택의 분리.** `resolveModel`(허용집합, 불변) 위에 라우터(선택)를 얹는다. frontmatter `model:` 과 `fable.allowlist` 는 **허용 상한**으로 재정의 — 라우터가 없는 동안은 상한이 곧 기본값. "Agent ≠ Model" 과 충돌하지 않는다(§3.2).
7. **파생 파일 금지의 방향은 allowlist.** substantive mission 판정, 원장 이벤트 어휘, 사람 게이트 행, Canary 대상 — 전부 허용 목록으로 지시한다(부정 목록은 새 항목에 fail-open).
8. **레이어 규칙(크로스체크 반영).** 신규 디렉터리 `lib/{mission, project-state, routing, review, verification, recovery, economics, replay, checkpoint, scorecard}` 는 **L2 순수 모듈 + 포트 주입**, `lib/topology/` 는 L4, 원장·산출물 writer(`runtime/{ledger, event-writer, artifact-lifecycle}.js`)는 L5. 상향 호출(L2 → L4 `effort-resolver`, L2 → L5 `task-budget`·ledger, L2 → L3 `spawn-ledger`)은 전부 **주입 포트**로 받는다 — §3.6 이 decision-trail 에 이미 적용한 규칙과 동일하며, **기존 L2 모듈이 새로 writer 가 되는 경우**(예: `context/rehydration.js` 의 Context Receipt)에도 같은 규칙. **11개 디렉터리**(§8 로 `replay·checkpoint·scorecard` 3개 추가)는 `eslint.config.js` 등록 + `layer-registration-coverage` 게이트 그린이 Phase 0 산출물이다(리더 실측 †: 초기 8/8 미등록, 추가 3도 부재 — 15:12 실측).

---

## 2. 한눈에 보는 갭 (레인 7개 집계)

| 영역 | 설계 요구 | 현행 판정 | 가장 무거운 실측 발견 |
|---|---|---|---|
| Intent · Mission | Mission Contract 13필드, intent.md, mission_id, state.yaml, 4축 interpreter | 없음 대다수(`lib/mission/` 부재, `.artibot/missions/` 부재) | `command_activation` 은 `mode==='agentTeam'` 일 때만 계산 → system1 프롬프트 전부 배제(분모 미측정). split 힌트는 `recommendMinSubtasks=null` 로 영구 OFF |
| 모델 라우팅 | per-action 라우팅, 5개념 분리, RouteUtility, 히스테리시스, usage receipt, 단일 가격 | 허용집합만 있고 선택 없음 | 영수증 원천이 트랜스크립트 `message.usage` 에 **이미 있음**(비용 필드 없음), 읽는 코드 0. 가격표 2개가 **3배** 불일치(`model-catalog` $5/$25 vs `cache-roi` $15/$75) |
| 정본 상태 · 문서 | ARTIBOT.md, project.md, StateStore(state.yaml 은 투영 — §7), missions/, adr/ 단일, ledger.jsonl 단일, 파생 금지 | 전부 부재 + 현행 위반 3축(NR1·2·10) | ADR 2계열 001~005 번호 충돌, 같은 slug PRD 2파일, 원장 ≥12종 분산, 상태 파일 4종 병렬 |
| 검수 · 검증 · 복구 | Builder≠Reviewer 강제, verdict 스키마, 3층 통합 검증, 복구 분류 4종, 승격 사다리 | 증거를 읽고 전이를 막는 코드는 `goal-evaluator#evaluateGoal` **한 곳** | autopilot 검수 verdict 는 리포트에만 인쇄, `nextPhase` 고정. verdict 어휘 4종 공존. `dev-verify-gate` 는 질문 시점에 지문 저장 |
| 토폴로지 · 사람 게이트 | 6종 단일 라우터, ParallelGain, fast 6행동, split 10행동, 게이트 10행 | 라우터 없음, fast 0/6, split 2/10 있음 | 훅은 **deny 만 있고 ask 없음**. `.claude/` 경로 무조건 승인. `blockExternalSend` 읽는 코드 0. deploy 게이트는 `npm publish` 만 |
| 중앙 원장 · KPI | 단일 ledger.jsonl, mission_id, KPI 15, shadow 학습, 메모리 승격 | 원장 12 + 메모리 전용 2, KPI ✅1/△5/❌9 | `decision-trail.json` RMW 로 **35% 소실** 실측 이력, `mission_id` 0건, `outcome.accepted` 신호 없음, shadow 코드 0 |
| 헌법 · 진입 계약 | 원칙 14, D01~D19, ARTIBOT.md 병존, 비협상 12 | 성문화 5 · 부분 6 · 없음 1 · 충돌 2 / D 채택 7 · 부분 9 · 미채택 3 | ARTIBOT.md 는 **대체 아님·병존 필수**(하네스가 CLAUDE.md 계층만 자동 로드). 스킬 22개 "Skippable: No" 사실확인형 체크포인트가 D08 과 반대 |

---

## 3. 영역별 설계

### 3.1 Intent · Mission Compiler · NL 런타임 (레인 1)

**리더 전제 교정 3건(레인 실측)**: ① 설계 양쪽이 쓰는 `questionUserAnswer` 는 리포 0건 — 실제 도구는 `AskUserQuestion`(각주 필요). ② `lib/mission/` 부재, `lib/intent/`·`lib/planning/` 파일명은 설계 13·14 와 하나도 안 겹침. ③ v1.1 레이아웃은 현행 `.artibot/` 와 4곳 충돌(아래).

**Mission Contract(v1.0) vs intent.md(v1.1) 판정**: 같은 것의 두 표현이나 **양방향 결손**이 있어 현재 템플릿으로는 무손실 투영 불가. 채택안 — `intent.md` 를 디스크 정본으로, `mission-contract.schema.yaml` 은 **파서 출력의 메모리 내 검증기**로 역할 재정의(파생 파일 금지와 정합). v1.1 템플릿(17) 보강 5곳: frontmatter `autonomy{mode,human_gates}` · `## Success Criteria` 4소절(Functional/Behavioral/Regression/Evidence) · `### Bounded Blindspots`/`### Excluded` · `## Completion` 절 · `explicit_requests[]` 를 frontmatter 배열로 분리(원문은 `## Original Request` 에 보존). 역방향으로 스키마에 `mission_id·intent_revision·status·topology·review·user_decisions` 추가.

**모듈 경계(전부 순수, I/O 는 호출자)**:
```
lib/intent/      기존 4파일 유지 + interpreter.js(4축) · confidence.js(4축+product_decision_required) · artifact.js(intent.md ↔ 계약)
lib/mission/     contract.js · compiler.js · problem-boundary.js(5분류) · blindspot-scanner.js(3분류, 수정 안 함) · mission-id.js
lib/project-state/  state-manager.js(StateStore 어댑터 — RMW 락+CAS 는 store 에, state.yaml 은 투영 렌더; appendEvent 는 주입 포트) · precedence.js(v1.1 §02 8단)
lib/planning/    question-gate.js(휴먼 게이트 판정만 — 질문은 안 만듦)
```
`lib/cognitive/` 는 흡수하지 않는다 — `workflow-plan.js` 가 "SOLE OWNER of auto-team decision" 이고 두 번째 평가자 드리프트 선례가 주석에 있다. Mission 은 그 상위 소비자.

**substantive 판정은 allowlist**(v1.1 04 의 부정 목록은 생성 방향 fail-open): S1 저장소 쓰기 기대 · S2 커밋/PR/배포 기대 · S3 `explicit_requests ≥2` · S4 `product_decision_required` · S5 `/plan·/ultraplan·/split·/autopilot·/implement` 명시 호출 · S6 기존 mission `intent_revision` 후속. 판정 불가면 mission 을 만들지 않고 원장에 `mission-candidate-deferred`.

**mission_id 발급 2단계**: ① 프롬프트 시점(`middleware/tasks.js`) S3~S6 만으로 candidate 계산·파일 0 ② 첫 쓰기 도구 또는 명시 커맨드(PreToolUse 훅 — 기존 `hooks.json` 슬롯, §0-1 정정)에서 S1·S2 확정 → `missions/<id>/intent.md` 생성 + `state.yaml.active_missions` 등록. **부모 세션만 발급, `/split` worker 는 상속**(창 4개 독립 발급 시 `XXX` 충돌). 비실질 상호작용은 세션 fallback `M-<date>-S<sid8>` 로 봉투 필수 필드 유지(§3.6 과 동일 규칙).

**NL → command_activation**: 배선 무변경, `middleware/tasks.js` 에 `compileMission()` 1줄 추가. **`mode==='agentTeam'` 조건을 상속하지 않는다**(system1 배제가 Observe 분모를 없앤다) — system1 은 축소 계약(goal + explicit_requests + intent_confidence)만.

**v1.1 레이아웃 충돌 4건과 처리**: C1 `runtime/ledger.jsonl` 단일 vs 현행 세션별 샤딩 32개(gitignore) → 레인 6 소관, 신규 이벤트만 단일 파일 · C2 `adr/` 이동 → 레인 3 M7 · C3 `.artibot/split/`(gitignore) 에 mission 상태 → 레인 5 (state.yaml.workers 로) · C4 `ARTIBOT.md·project.md·state.yaml·missions/` 전부 부재 + `.artibot/` 부분 추적 → **추적 경계를 먼저 정해야 state.yaml 이 조용히 ignore 되지 않는다**(결정 B1). 레인 1 은 **신설만** 하고 이동(C1·C2)은 건드리지 않는다.

**worker status 어휘 3종**(v1.1 7종 / supervisor `LANE_STATES` 12 / `LANE_OPS_STATES` 8): 네 번째 파일을 만들지 않고 `lib/supervisor/contracts.js` 에 `V11_STATUS_TO_LANE_STATE` 사상표 1개 추가.

**finding ↔ explicit_requests 보호(레인 1 §6.1)**: 둘은 시점이 다른 같은 규칙 — 보호는 완료 판정 시점의 사후검사, v1.1 09 §5 는 실행 중 에스컬레이션. 핵심은 **비대칭**: scope 를 **넓히는** finding 은 plan 개정으로 족하고, `explicit_requests` 를 **좁히거나 대체하는** finding 만 intent 개정(Controller 가 evidence 기반으로만 — Hardening §16). 증거 없는 finding 은 `rejected`. **새 게이트 불필요**: `plan.json.affectedPaths` 에 `.artibot/missions/**` 를 넣지 않으면 worker 가 intent.md 를 고친 순간 `limb-landing-check.js` ownership 행이 랜딩에서 잡는다(v1.1 09 §3 = 기존 소유권 게이트 재사용).

**우선순위 소비(레인 1 §6.2)**: `precedence.js` 소비 지점 3곳(컴파일 시 이전 맥락 조회 / substantive S6 판정 / 충돌 해소). 충돌 방향 둘 — 검증된 리포가 intent 를 이기면 intent 를 고치지 않고 **완료 판정으로**, plan 이 intent 와 어긋나면 intent 가 이겨 plan 개정. 함정: 1위는 *verified* 리포 상태이지 "파일이 있다" 가 아니다 → `verifiedBy` 없는 소스는 건너뜀(fail-closed), 낮은 소스가 이기면 경고(위 칸이 비었다는 정보구조 결함 신호).

**평가셋**: `tests/evals/fixtures/nl-activation.cases.jsonl`(현행 케이스는 `evaluator.js:219` 인라인 — 늘릴 수 없음). 부분 단언·`source` 필수·분모 병기. 첫 케이스 = "split 을 업그레이드해줘" → `explicit_requests=["split 을 업그레이드"]`, `requested_target` 에 split 경로, 컨텍스트로 바꿔치기 시 RED(v1.0 01§4 헌법 조문). 이 eval 은 회귀 방지용이고 90% 는 Shadow 실사용 대조로만 채운다.

### 3.2 모델 라우팅 · 스위칭 · 경제 (레인 2)

**핵심 실측 4건**: ① usage receipt 원천은 `~/.claude/projects/<slug>/<sid>.jsonl` 의 `message.usage{input, cache_creation(1h/5m), cache_read, output, thinking}` + `message.model` + `effort` + `requestId`, 서브에이전트는 `subagents/agent-*.jsonl`(파일명 = `spawn-ledger` agentId) — 비용 필드 없음, 포맷 미문서화(per claude-code-guide). ② 플러그인이 그것을 읽는 코드 0 — `cache-roi.js#extractUsage` 는 채워지지 않는 필드를 기대(결과 전부 0, `updatedAt 1970`). `model-identity.js#foldFile` 이 **같은 파일을 이미 순회**하며 usage 만 버린다 → P0-3 은 리더 한 곳 확장 거리. ③ 가격표 2개 3배 불일치. ④ 라우팅은 허용집합만.

**5개념 → 모듈(v1.1 07 어휘)**:

| 개념 | 질문 | 모듈 | 기존 코드 관계 |
|---|---|---|---|
| Execution Profile | 이 미션의 성능 의도 | `lib/routing/execution-profile.js` — `intent.md` frontmatter `execution_profile.{planning,performance,topology}` → `objective`. intent.md 부재 시 `--fast`/`/split` 플래그 어댑터 | `detectIntent` 에 성능 축 없음 → 이 모듈이 추가 |
| Routing | 다음 액션은 어느 티어 | `adaptive-model-router.js`(+`action-classifier.js`·`route-scorer.js`) | `resolveModel` 이 준 `allowedTiers` **안에서만** 선택. effort·예산은 `{resolveEffort, budgetFor}` **주입 포트**로 받는다(구현체는 L4 `effort-resolver`·L5 `task-budget` — L2 에서 직접 import 하면 역방향, §1-8) |
| Switching | 옮길 가치가 있는가 | `model-switcher.js` — 액션 경계마다. 세션 중간 전환은 호스트 지원 시만, 아니면 다음 스폰에서 반영 | 원장 `model.switched{from,to,reason}` |
| Escalation / Downgrade | 상향 / 하향 | 한 파일 `escalation-controller.js`(하향은 분기 — 01§13 "복잡성은 존재를 증명") | `autopilot.md` "빈 결과→frontier 재시도" 프로즈의 코드화. denylist 는 에스컬레이션으로도 못 넘는다. `performance ∈ {maximum, split}` 이면 downgrade 비활성 |
| Pinning / Hysteresis | 옮기지 말아야 할 비용 | `route-hysteresis.js` — CacheLoss 는 영수증 필요, 없으면 `contextTokens × freshInputPrice(to)` 상한 추정 | `effort-resolver` ±0.05 밴드 패턴을 티어에 적용 |

`model-policy.js` 추가는 **`allowedTiers(agent,{role},config)` 하나**. `resolveModel` 은 byte-identical.

**"Agent ≠ Model" 판정 — 충돌 아님(조건부)**: 07 이 금지하는 것은 "영구 부착". 오늘의 두 층 — (a) frontmatter `model: fable` 8종 = 호스트 기본값, (b) allowlist·denylist·phaseRoles = 역할+게이트 허용집합 — 은 **허용 상한**으로 읽으면 성립. 성립 조건 3: allowedTiers 가 상한 집합 / 스폰 호출자(orchestrator·team.md)가 라우터 출력을 `Agent(model=…)` 로 넘김 — 두 조건으로 분리(크로스체크 정정): **(b-1)** alias 수용(**미확인**, I4) — 안 되면 라우팅 자체가 스폰에 전달되지 않는다; **(b-2)** 실행 중 서브에이전트 모델 전환 지원(**미확인**, I7) — 이것만이 액션/스폰 단위를 가르며, 안 되면 alias 가 수용돼도 실효 단위는 스폰이다 / 문서 문구 고정("frontmatter·allowlist = 최고 티어, 라우터 없는 동안 상한 = 기본값" — config comment·team.md·rules). `security-reviewer` denylist 는 명시 예외로 ADR 기록("영구" 가 아니라 "5.1 오탐률 측정 대기").

**성능 의도 3종 → 가중치**: balanced = `cost_per_accepted_outcome`(downgrade 활성) / maximum(`autopilot --fast`) = `time_to_verified_outcome`+accuracy, Cost 항 0, effort 하한 xhigh, downgrade 비활성 / split = maximum + ContextAffinity 0, 예산 상한 `split.dispatch.budget`(600k). fast/split "generous" 를 별도 키가 아니라 `execution_profile.performance` 로 표현(레인 5 결정 5 를 여기서 해소).

**4티어 도입 순서(OD-2)**: 카탈로그 ID 정합(haiku 실측 `claude-haiku-4-5-20251001`, Sonnet 5 ID 확인 필요) + 행동 별칭 8종 → `agents.modelPolicy.low: {model, agents: []}` 빈 버킷(실효 0) → Observe(SubagentStart 에서 라우터 호출, `spawn-ledger` 레코드에 `recommendedModel·actionClass` 필드만) → Shadow(SessionEnd 에서 영수증 합산, 추천≠정책 스폰의 비용·평가점수 비교) → Canary(`routing.canary.actionClasses: ['classify','status']` 만 실적용).

**Usage receipt 계약**(`economics` 확장): `source: transcript|otlp|estimate` 필수, 모델 ID(티어 아님), fresh/cached/cache_write(1h·5m)/output/thinking/requests, `total_cost: number|null` + `pricing_version`. 파서에 스키마 가드 — 필수 키 결손 시 `estimate` 강등 + `parseFailures` 카운터(exit 기준 "커버리지 ≥95%" 의 분모). 귀속은 스폰 단위까지 확정, 메인 턴은 `requestId+timestamp` 근사(정확도 미확인).

**Cost per Accepted Outcome**: 4항(fresh/cached/output/thinking)은 코드만 없고 계산 가능. **Accepted 신호는 없다** — 라벨 커버리지가 생기기 전까지 대리 지표 `Tokens per Reviewed-PASS`. 정의는 결정 D3. 5.1 계수(tokenizerCoeff 1.3·가격) 측정 절차: 같은 프롬프트 20건을 opus/fable 서브에이전트에 1턴 Read 시켜 `input+cache_creation` 비율 실측, 가격은 `claude-api` 스킬로 확인 후 카탈로그 한 곳만 남김.

### 3.3 정본 상태 · 문서 거버넌스 (레인 3, v1.1 을 상위 정본으로 재작성)

v1.1 이 정한 것(정본 1개·파생 금지 7패턴·제자리 revision·아카이브 불변·메모리 승격·우선순위 8단·중앙 원장·ADR 7영역)은 재서술하지 않고 규범으로 인용. 아래는 **현행 → v1.1 이행 매핑**과 v1.1 이 침묵하는 운영 조항.

**이행 매핑(핵심 15행 중 결정에 걸리는 것)**:

| 현행 | v1.1 대응 | 판정 | 조치 |
|---|---|---|---|
| `.artibot/guides/`(PRD·가이드·설계 사본) | `project.md#References` + 설계 세트 | 설계 세트 = 정본(참조), PRD = intent/plan 전신 | `project.md` 신설, `PRD-SPLIT-…-2.md` 병합(같은 slug), 설계 사본은 `.artibot/guides/` **한 경로만 추적**, 루트 `docs/` 원본은 삭제 + 포인터 |
| `NEXT-SESSION.md` | `state.yaml` + 최신 `outcome.md#Follow-ups` + `project.md#Human Approval Boundaries` | 파생(status 류) | 1단계 `derived-from: state@<state_version>` 헤더 렌더 뷰 → StateStore 착지(Observe) 후 폐기, `/resume` 가 Resume Contract(§7.2 §12-13)를 실행 |
| `HANDOFF.md` + `handoffs/` | state + 활성 intent/plan + outcome + ledger 합성 | 파생 렌더 캐시 | `/save` = mission checkpoint(state_version++, `mission.checkpointed`) → HANDOFF 렌더. `handoff-builder` 입력을 state.yaml/missions 읽기로 |
| `.artibot/split/{plan,run}.json·locks/·brief.md` | `state.yaml.active_missions.<M>.topology{split}` + `workers.<name>{…}` | split = mission 의 topology 표현 | §3.5 이동표 (미션 1 = split run 1, limb = worker) |
| `.artibot/ledger/<sid>.jsonl`(33, 대화 전사) | 원장 아님 — raw 로그 | 이름만 "ledger" | 디렉터리 `transcripts/` 로 개명(어휘 충돌 제거) |
| 원장 12종 | `runtime/ledger.jsonl` 단일 이벤트 | "worker 별 원장 금지" 위반 | §3.6 |
| ADR 2계열(플러그인 `docs/adr` 5 추적 + 루트 `docs/adr` 5 미추적, 001~005 중복) | `.artibot/adr/` 한 계열 | 정본 둘 | 플러그인 5 → `.artibot/adr/ADR-001~005`(git mv), 루트 5 → `ADR-006~010` 재번호 + `moved-from`, `/adr` 기본 dir 변경(결정 B2) |
| `docs/PRD/`(4,164, 테스트 잔재 ≥99%) | `missions/<M>/intent.md` | PRD = intent 전신 | `writePRD → writeIntent`, 1회 청소 후 삭제 |
| `.plan-state.json` 2개 + `runtime/current-*.json` | `state.yaml.active_missions.<M>.{plan.revision, workers}` | 병렬 상태 | `plan-tracker` 를 state.yaml 어댑터로, `current-*` 는 캐시 표기 |
| 개인 메모리(`~/.claude/projects/<slug>/memory/`) | `.artibot/memory/`(승격만) | 개인 층 ≠ 프로젝트 층 | `/dreaming` 을 승격기로, 승격 후 개인 층에서 삭제(사본 금지) |
| `scorecard.json`·`reports/AUTOPILOT/`(3,061) | `outcome.md` 7절 + ledger 조회 뷰 | 파생 뷰 | autopilot `renderReport` → `outcome.md`, `/daily` 는 저장 없는 뷰 |

**HANDOFF 명시 판정(레인 3 §2b)**: 대체가 아니라 **파생 렌더 캐시로 잔존** — v1.1 에 핸드오프 산출물이 없고(08 표·12 매트릭스 실측) 그 질문은 state/outcome 으로 갈라지지만, 읽기 순서 6단계를 합성하는 `/resume` 뷰가 필요하다. 오늘의 `/save` 수정(`protectedTracked`·`checkHandoffTrackedIntegrity`)은 회전기 규칙으로 승격되어 유지, `handoff-builder` 수집 로직만 정본 렌더러로 교체. **파생 파일명 실측(레인 3 §4, 15:0x)**: v1.1 7패턴은 추적 1,736파일 중 **0건**, 확장 패턴 1건(`PRD-SPLIT-…-2.md`). v1.1 산출물 11종 ↔ 현행 유형 1:1 정렬표는 레인 3 §2a.

**커맨드별 운명**: `/save` = checkpoint + 렌더 · `/resume` = ARTIBOT.md 읽기 순서 실행(project.md → state.yaml → 활성 intent/plan → 최근 review/outcome, HANDOFF 는 폴백) · `/adr` = `.artibot/adr/` + 7영역 조건 + 질문 게이트 · `/plan` = `missions/<M>/plan.md` 제자리 revision · `/ultraplan` = intent 정련은 사용자 명시 변경 또는 새 증거일 때만 · `/split` = state.yaml topology/workers · `/checkpoint`·`/daily --save` 는 폐기 또는 별칭(결정 B6).

**gitignore 경계(OD-3 을 v1.1 표 위에 한 열로)**: 추적 = `ARTIBOT.md`·`project.md`·`missions/`(사람 mission)·`adr/`·`memory/`(승격)·설계 세트 / 로컬 = `runtime/ledger.jsonl`·raw 로그·HANDOFF 렌더 / `state.yaml` = **로컬(투영, 재생성 가능 — B1 확정)** / **결정 필요** = autopilot 자동 생성 mission(B4). `.gitignore` 변경: `**/.artibot/ledger/`(:111) → `runtime/` + `transcripts/`, `.artibot/runtime/` 규칙 신설(현재 없음 — 레인 6 실측).

**파생 파일 validator = `tests/firewall/artifact-governance.test.js`**(스크립트형 금지). 검사 9종 중 지금 잡히는 현행 위반: #1 파일명 패턴(`*-2.md` 1건 추적) · #2 정본 둘(ADR 2계열, 설계 세트 3벌) · #4 원장 분산(7+ 계열 + 표류 원장 149KB) · #5 상태 정본 둘(4종, 이행 후 검사) · #6 `derived-from` 헤더 부재(HANDOFF·NEXT-SESSION). 게이트 옆에 "못 보는 것"(내용 참·의미 중복) 명시.

**v1.1 이 침묵하는 운영 조항 10(오너 추가분)**: 측정 시각·분모·재현 명령 병기 / 3등급 + `미확인:` 줄 필수(outcome.md `## Verification` 은 포인터 없이 "검증됨" 금지) / 크로스머신은 StateStore 착지 전까지 NEXT-SESSION 렌더 뷰 / 코드가 문서를 이긴다(프롬프트 정본이 코드와 어긋나면 문서 수정, 코드 수정 사유는 ADR) / `ledger` 어휘는 `runtime/ledger.jsonl` 에만 / 로컬 산출물 보존(transcripts 50·4MB, HANDOFF 30, ledger 월별 12개월, autopilot raw 30일 또는 100건, decision 캐시 5,000 — 회전은 자기 소유 패턴만, 추적·외부 파일 면제) / 모든 writer `projectRoot` 주입 / CHANGELOG 수치 커밋 직전 재측정 / 게이트 헤더에 맹점 / 개인 메모리는 개인 층.

### 3.4 검수 · 검증 · 복구 (레인 4, v1.1 §5 반영)

**한 줄 결론(레인 실측, 리더 확인)**: 증거를 읽고 진행을 막는 코드는 `goal-evaluator.js#evaluateGoal`(exit code) **하나**. 나머지는 지시 또는 문서 규약이고 결과를 되읽는 소비자가 없다.

**"done 선언 = 완료" 오판 경로 6종**: A `engine.js` `runPhase3CrossCheck→VERIFY`·`runPhase4Verify→IMPROVE` 고정 전이(위임 시점에 전이) · A′ `state.crossCheck.verdict` 소비자는 `report-generator.js` 뿐 — `verdict:"fail"` 이어도 런이 끝난다(§0-1 확인) · B `agent-evaluator.js` `SUCCESS_MARKERS` — "done" 이라 쓰면 점수 · C `stop-review-gate` 가 테스트 없이 "passed review gate" · D `dev-verify-gate` 가 `writeStdout` 이전에 `saveFingerprint` · E/F 같은 지문 재시도 시 block 우회. **A/A′ 가 가장 무겁다** — 설계 08 이 독립 검수를 놓은 자리에서 결론이 구조적으로 읽히지 않는다.

**갭**: Builder≠Reviewer 코드 강제 0(문서 규약만, 스폰 페이로드에 "누가 만들었나" 없음) · verdict 스키마는 `schemas/review-output.schema.json` 에 존재하나 런타임 검증자 0, `evidence[]`·`recommended_action` 없음, **어휘 4종**(`pass|fail|warning` / `APPROVE|REQUEST_CHANGES|REJECT` / `SPEC_PASS|WARN|FAIL` / `QUALITY_PASS|WARN|FAIL`) · 완료 6조건 중 기계 판정은 실행 증거 1개 · 3층 검증 중 Behavioral 0, Operational 관측만 · 복구 분류기 0, Plan 개정 경로 0, PAUSE 는 질문이 아님 · 실패 기반 승격 0, `lifecycle-router#pickAgent` 가 `context.hint` 를 안 읽어 `/review` 는 항상 code-reviewer.

**설계 3모듈**:
- `lib/review/independent-reviewer.js` — 검수 **계약** 소유자(수행 안 함). `buildReviewRequest` / `parseReviewVerdict`(스키마 위반 = ok:false = 검수 안 일어남, pass 로 안 읽음) / `assertIndependence(builderId, reviewerId)` — builderId 는 `spawns.ndjson` agentId(새 수집 경로 불필요; 원장 reader 는 주입 포트, L2→L3 직접 import 금지 §1-8). verdict 스키마 v2 = **`PASS|REPAIR_REQUIRED|REPLAN_REQUIRED|INTENT_REVIEW_REQUIRED|BLOCK`**(Hardening §15 로 확정 — 레인 4 초안 `pass|repair|replan` 의 상위집합; `REJECT`→`BLOCK`, 스펙 자체 의심→`INTENT_REVIEW_REQUIRED`) + `evidence[]` + `recommended_action`, 기존 4종 어휘는 어댑터에서 접음(**4종→1종이 첫 산출물**). 리뷰어는 intent·plan 을 직접 고치지 못하고 finding 만 제출, 전이는 Mission Controller(§7.2) 가 결정. Clean-room 입력 allowlist(intent·ADR·plan·diff·tests·evidence·constraints)는 `buildReviewRequest` 가 강제 — 서브에이전트는 새 컨텍스트로 시작하므로 구조적으로 이미 clean-room 이고, 위험은 리더가 빌더 자기평가를 프롬프트에 붙여 넣는 것뿐이다. 모델은 `resolveModel(reviewer,{role:'review'})` 위임.
- `lib/verification/unified-verifier.js` — 3층을 하나로 fold, `status: PASS|FAIL|UNMEASURED`. **UNMEASURED 가 1급 상태** — 재지 못한 층을 PASS 라 부르지 않는다(`limb-landing-check` 의 `UNSUPPORTED` 선례). 회귀 축은 직전 PASS 층별 결과와 비교(이력은 `readLastPass` 주입 포트), 기준선 없으면 UNMEASURED.
- `lib/recovery/{failure-classifier,recovery-controller,plan-repair}.js` — engine 위의 분류기. `runPhase4Verify` 다음, IMPROVE 전에 `nextPhase` 를 `decide()` 결과로(기존 `onFailure.{retryLimit,escalateTo}` 지시 필드의 실제 소비자). `unknown` 은 사람으로 승격, `framing→Ultraplan` 은 제안만.

**"done 은 검증 결과" 강제 지점(레인 4 §5.4 로 1순위 교체)**: ① **완료 정의 = `outcome.md` 생성 조건.** 사람도 워커도 이 파일을 쓰지 않고, `unified-verifier` + `independent-reviewer` 산출을 입력으로 받는 **생성기만** 쓴다(= Hardening §6 의 `artifact-lifecycle` `mission.completed→outcome.md` 핸들러). 7개 절 ↔ 완료 6조건 1:1: `## Verification` 에 UNMEASURED 잔존 시 생성 거부, `## Review` verdict 가 PASS 아니면 생성 거부, `## Remaining Blindspots`·`## Follow-ups` 만 빈 절 허용. **추가 조건(OD-5, 크로스체크 반영)**: 원장에 이 미션의 `human.asked{gate}` 가 있는데 짝이 되는 `human.resolved` 가 없으면 생성 거부 — "묻지 않고 재구성해 재시도" 를 여기서 잡는다(`human.asked` 는 훅이 쓰므로 모델이 누락시킬 수 없다, §7.2 §19). 필드는 위조되지만 파일 생성은 생성기로 제한할 수 있으므로, 이것 하나가 오판 경로 A·A′·B·C 를 **동시에** 무력화한다(`Split-Limb` 트레일러와 같은 종류의 산출물 증거). 원장 `mission.completed{accepted}` 는 파일이 쓰인 **뒤**의 파생 사실 — 원장만 있고 outcome.md 가 없으면 완료가 아니라 원장 오염. ② autopilot `nextPhase` 를 verdict 의 함수로 ③ Stop 훅 문구만 정직하게 — **차단은 늘리지 않는다**(훅 차단 강화 = 무한 루프 역사, `isArtibotRepo` 밖에서 조용함). `agent-evaluator` 키워드 점수는 별도로 outcome.md 유무로 교체.

**`verification_id` 는 강제자에서 조인 키로 강등(§5.5)**: `unified-verifier` 1회 실행이 발급(내용 해시 + 측정 시각) → `review.md` frontmatter · `outcome.md ## Verification` · 원장 `review.completed`/`mission.completed` 세 곳이 같은 id 를 문다. 불일치 시 outcome.md 생성 거부(fail-closed) — 검증 후 코드가 바뀌고 검수만 재사용되는 경로(§1.4-D 지문 재사용과 같은 종류)를 막는다. 형식(해시 범위)은 미정.

**입력 계약(§5.2)**: `buildReviewRequest({ missionDir, … })` 는 `intent.md` 를 **디스크에서 직접** 읽고, intent 텍스트를 받는 시그니처를 두지 않는다(넘길 수 있으면 언젠가 넘긴다). `assertIntentBinding` 이 검수 완료 시점 `intent_revision` 을 재확인, 다르면 그 검수는 무효. 새 증거(§0-1 확인): `commands/team.md:291` 이 `{original requirements}` 를 리더가 보간 — **worker-local 해석으로 검수하는 것이 현재 기본 경로**이며 v1.1 09 §7 위반. `review.md` 가 verdict 의 파일 정본, 스키마 v2 에 v1.1 필수 참조 6종(mission_id·intent/plan revision·diff·tests·regression evidence) 없으면 파싱 `ok:false`. Observe 분모 3종: verdict 파싱 성공률 · 층별 UNMEASURED 비율 · **intent binding 실패율**; Shadow 는 "outcome.md 조건을 적용했다면 막혔을 건수 / 완료 선언 총수".

**verdict 어휘 매핑이 드러낸 것(레인 4 §5.3)**: `REPLAN_REQUIRED`·`INTENT_REVIEW_REQUIRED` 는 기존 4종 어휘에 **대응이 아예 없다** — 지금 파이프라인은 "구현이 틀렸다" 와 "계획·스펙이 틀렸다" 를 가를 말이 없어 후자를 전부 `SPEC_FAIL` 로 접어 왔다. §3.4 "Plan 개정 경로 0" 은 코드 갭 이전에 **어휘 갭**. `SPEC_FAIL` 은 두 값(REPAIR vs INTENT_REVIEW)으로 갈라지는 유일한 행이라 어댑터가 자동으로 못 가른다 → 전환기에는 사람에게 올리고 추측 분류하지 않는다.

**seeded-defect catch-rate**: 결함 코퍼스는 리포 실사고 **7축**(fail-open·Windows 경로/CRLF·셸 인젝션·게이트 자기파괴·스펙 누락·과잉 구현·**intent 불일치** — §5.2 추가), 1결함 1브랜치, 주입 문자열 전역 0건 증명. catch-rate 와 함께 **false-positive rate·위치 정확도** 필수, opus 비교군 필수, N 미정은 "충분" 이 아니라 미확인.

### 3.5 토폴로지 · `autopilot --fast` · split · 사람 게이트 (레인 5, v1.1 보강 반영)

**갭(리더 §0-1 확인 포함)**: Topology Router·ParallelGain 없음 — 코드는 `runner∈{inline,team}` + `recommendation∈{workflow,split,autopilot}`(`workflow-plan.js`) · `--fast` 권장 6행동 0/6 — fast 는 스케줄링 4키뿐, `maxBudget` 소비자 0, `autopilot.md:103` 은 설계와 반대("예산 guard 는 fast 와 무관") · split 10행동 있음 2/부분 7/없음 1(공유 증거 인덱스) · 사람 게이트 10행: 훅 강제 6(deploy 는 `npm publish` 만, DB 는 DROP/TRUNCATE + `DELETE` no-WHERE 만 — `UPDATE` no-WHERE·마이그레이션 도구 없음), 산문 2, 없음 2(외부쓰기, 설정 자기수정 — `.claude/` 무조건 승인) · 훅은 deny 만, **ask 없음** · 측정 5종: wall-clock 은 산문 호출(n=1), merge conflict 미영속, duplicated exploration 은 `tool-tracker#buildContext` 가 경로를 버려 불가, retry `type:'retry'` 발행처 0, 선택 토폴로지 원장은 SDK 경로만(대화형 0회).

**vNext ↔ v5 정합**: 구조 대응 13행 — 이름 충돌 6(`economics/model-catalog` vs 기존 `lib/core/model-catalog.js` → 기존 것을 가리킴 / `runtime/run-ledger` 는 L5 라 L2 `observability` 로 / `topology/split-runtime` 은 만들지 않음) · 의미 충돌 1(recovery) → vNext 쪽은 `supervisor/reconcile.js`, v5 `recovery/` 는 결과 복구 · v5 공백 3(scheduler → vNext §06 편입, WorkerProvider port, L4 staging/promote) · ADDENDUM A6 → P2 #17 provision 단계 명시, A7 → L0 증거 무결성(`-text`·blob sha·`restore-blob` 정본). 진실원은 §1-2 규칙(StateStore 라이브 + ledger 이력, state.yaml 은 투영). run-ledger `topology.mode` enum 6값을 라우터 출력 어휘 정본으로.

**`state.yaml.workers` ↔ 현행 대조(v1.1 §06·§16 vs `lane-state.mjs`·`run-store`, 레인 5 실측 8행)**: `status` 있음(정본은 StateStore Task Graph, state.yaml·ops·vNext 12·8종은 전부 투영·원장 — §3.1 사상표) · `owns[]` 부분(`plan.json affectedPaths` 가 사실상 정본) · `heartbeat_at` **없음**(vNext `lastHeartbeatAt` 항상 null, ops `since` 는 상태변경 시각 — emitter 부재 ADDENDUM §4 와 일치) · `blocked_by`·`mission.status` 부분 · `topology` 없음(라우터 이벤트가 채움) · `review` 부분(model 필드 없음) · `plan/intent revision` 없음 · 역방향으로 vNext/ops 가 더 풍부(window·head·attempt·checkpointSeq) — 16 스키마가 `workers` 를 `type: object` 로만 두어 **추가 키 허용**, 손실 없이 흡수 가능.

**worker 상태 정본 3중(레인 5 §2-D)**: "이 워커는 지금 뭐 하나" 에 후보 3개(`run.json.lanes` · supervisor `state.json` · `state.yaml.workers`) — v1.1 §12 위반이 오늘 생긴 것. 판정: 정본 어휘 = v1.1 7상태 + `blocked_by` 사유 규약(`lane:<x>`·`gate:<n>`·`human:<r>`·`reconcile:<w>`), ops 8종은 투영(pending→queued, awaiting-dispatch→claimed, active/closing→executing, review→reviewing, serial-gate/suspended→blocked, done→done; 손실 2, 공백 1 = ops 에 `failed` 없음 → 9번째 추가). heartbeat 는 emitter 생기기 전까지 `heartbeat_at := max(lane-heartbeat, last-commit)` 파생 + `heartbeat_source` 병기. 어댑터 `lib/topology/split-state.js`(v1.1 P1 #14 이름): 읽기는 3원천 우선순위(store→run.json→events)+`source` 반환, 쓰기는 한 곳만 + 투영 표식 + ledger 1건 — 지금은 쓰기=run.json, StateStore 착지 시 뒤집기, 독자 전환 후 `run.json.lanes` 제거. 재개 규칙: state 읽기 → git 대조 → 불일치는 `blocked_by:['reconcile:…']` fail-closed → checkpoint 는 번들 섹션으로 주입만(wip 트레일러 = 증거, checkpoint = 재주입 패키지, 둘 다 상태 아님 — DR01 "checkpoint 가 재개 정본" 문구 삭제). 명칭 충돌 1: v1.1 `performance_profile: maximum` vs v5 YAML `token_policy: generous` → §3.2 `execution_profile.performance` 로 통일(F2).

**missions/ ↔ split run 이동표**: **미션 1 = split run 1, limb = worker**(서브미션 아님 — v1.1 09 #2 worker 별 intent 금지). `plan.json` → `plan.md` 기계 부록(revision = `/split plan` 재실행) · `run.json.lanes` → `workers` · `stageTimes/metrics/landings` → ledger 이벤트 · `windowReuse` → `workers.<w>.window` · 자유형 블록(`r4·rebootShutdown_*·queue.md·r2-carryover.md` — §08 forbidden 의 JSON 판) → `plan.md` revision / `outcome.md` Follow-ups · brief/prompt/dispatch-decision/list-agents → raw-log 등급, 경로만 참조. 새 디렉터리 불필요.

**설계**: `lib/topology/topology-router.js`(L4, 순수) — 입력은 기존 `buildWorkflowPlan` 결과 + `fast-profile#buildConflictGroups`(mergeRisk 항), 새 분류기 없음. `ParallelGain` 각 항은 config 가중치, **측정 불가 항은 0 + `measured:false`**(오늘 contextDup·tokenDup 불가, startup 은 spawn ledger duration 중앙값). Observe = `runtime-prompt.js` 훅에서 `decision-events#recordWorkflowPlanDecision` 호출 **1줄 배선** + `topology-recommended` 이벤트(Phase 0 의 가장 싼 이득). Shadow = `topology-actual` 사후 도출(spawn ledger / split run.json / session-store), `/doctor` 가 일치율. Canary = `autoFire: ['solo','team']`(현 규칙) 유지, autopilot 은 게이트 히트 0 + allowlist 일 때만, split 은 창을 사람이 여는 한 GA 불가(WP02 선행).

**예외 정책은 config 로, 값은 기존 키 참조**: `topology.default`·`autopilot_fast.*`·`split.*` 를 신설하되 `autopilot.fast.{hardMaxAgents…}`·`split.maxWindows`·`phaseRoles.review` 를 가리킨다(중복 정의 금지). "generous 예산" 은 BD01(읽는 코드) 이 먼저 — 배수/해제/별도 상한은 결정 D13.

**사람 게이트 단일 지점 = PreToolUse 훅**(라우터는 행동을 못 본다, `humanGateHits[]` 로 분류만): `lib/security/human-gates.js#HUMAN_GATE_MATRIX` **HG-01…13**(v5 §11 10 + vNext §09 secret 변경·permission escalation·security policy disable 3, allowlist 형). 열은 `행동·기본(auto/policy/human)·강제 지점·근거`, policy 행은 `policy:<config key>`. **`pre-bash`(fail-closed 층)** 와 `pre-write` 가 import 해 `decision:'block', reason:'human-gate:HG-nn'` (`bash-risk-guard` 는 헤더가 명시한 fail-open 경고 층이라 강제 지점으로 쓰지 않는다 — §0-1) — 구조화 사유가 모델에게 돌아가면 모델은 **`AskUserQuestion` 으로 사람에게 묻는다**(OD-5 확정: 훅 block 은 "묻기" 의 트리거이지 대체물이 아니다. 대화형이면 즉시 질문, 비대화형이면 PAUSE + `human.asked`). 훅이 직접 ask 를 못 하는 호스트 제약은 그대로이고, "묻지 않고 재구성해 재시도" 는 §3.4 완료 게이트에서 `human.resolved` 없는 게이트 히트로 잡는다. **같은 13행이 `project.md#Human Approval Boundaries` 의 본문이 된다**(v1.1 18 템플릿은 제목만 있고 본문 0줄 — §0-1 확인, 레인 7 "신규 절" 판정 일치. 강제는 훅, 선언은 project.md — 층 분리). 새 패턴: deploy(`gh release`·`docker push`·`vercel|fly|netlify deploy`·`terraform apply`·`kubectl apply`), 외부쓰기(`curl -X POST|PUT|PATCH|DELETE`·`gh pr merge`), DB(`prisma migrate deploy`·`alembic upgrade`·`UPDATE…SET` no-WHERE), **`.claude/` 화이트리스트 축소**(settings·hooks·artibot.config·dispatch-table 은 게이트 — 결정 C3), 보호 브랜치 직접 push. `blocked-patterns` 의 `--force-with-lease` 예외를 `safety.js` 에도 반영(두 층 불일치).

**Phase 0 지금 잴 수 있는 것**: 스폰 수·티어·duration(리포 루트 `.artibot/ledger/spawns.ndjson` — 15:0x 29줄 → † 63줄, 세션 중 증가) · split wall-clock(n=1) · 트레일러 완료율. 배선 후 가능: 선택 토폴로지, merge conflict(`land.mjs` → `gate-result` append). 불가: 비용(영수증 전), duplicated exploration(경로 해시 전), review miss(verdict 원장 0). **autopilot 기준선은 오염** — `runtime/autopilot/` 12,089파일이 vitest 잔재(정리 전 어떤 autopilot KPI 도 무효, 결정 E4).

### 3.6 중앙 원장 · KPI · 학습 (레인 6, v1.1 반영판)

**현재 원장 12 + 메모리 전용 2**(14:05): 세션 jsonl 33/7.5MB · spawns.ndjson · `decision-trail.json`(단일 JSON RMW, **60건 중 21건 35% 소실** 08-28 실측, 971건, 08-25 이후 공백) · decision-events(디렉터리 미존재) · split telemetry(0) · supervisor envelope/state(0) · autopilot 세션/이벤트(12,089) · autopilot 보고서 · session-rollups · cache-roi(전부 0) · 정책 trail 5종 · token-usage/trace(메모리, 종료 시 소실). v1.0 run-ledger 필드 13 중 `mission_id`·`execution.retries`·`outcome.accepted` **완전 부재**, 나머지 △. KPI 15: ✅1 △5 ❌9. shadow 코드 0.

**물리 정본 = `<projectRoot>/.artibot/runtime/ledger.jsonl` 하나**(v1.1 §02·§11·§15). 기존 12개는 삭제하지 않고 raw log 등급으로 강등, 신규 worker 별 파일 금지. pluginRoot `runtime/` 과 이름이 같으니 항상 `.artibot/runtime/` 로 풀어 쓴다. 봉투: `{v, ts, event(점 어휘), mission_id(필수), action_id?, session_id, source(vNext 8종), pid, seq, worker?, model?, data}` — v1.1 예시 6줄 그대로 유효, 필드는 추가만. 어휘 **allowlist** 를 `lib/runtime/event-writer.js` 에, 미등록 event 는 `ledger.rejected` 로 기록 후 무시(fail-closed).

**어휘 통일표**(v1.0 필드 ↔ v1.1 이벤트 ↔ vNext 20종 ↔ split 6종 ↔ writer): `mission.created` ← runtime-prompt / `intent.detected`(신설) / `plan.revised` ← plan·ultraplan / `route.selected`(신설)+`model.switched` ← cognitive-router(decision-trail dual-write) / `topology.selected`(신설)+`worker.claimed` ← subagent-handler·split dispatch·autopilot / `context.compiled` / `usage.receipt` ← **`economics/usage-receipt.js` 단일 writer**(cache-roi·token-usage 이중집계 금지) / `tool.used`·`retry.scheduled` / `review.requested/completed` / `verify.completed` / `human.asked/resolved`(AskUserQuestion 훅 경로 **미확인**) / `budget.*` / `phase.*`·`wallclock.*` ← split-telemetry dual-write / `mission.completed{accepted}`·`mission.archived` / `state.updated{state_version}`. vNext `lane-heartbeat`·`checkpoint-*`·`lane-state-changed` 는 1:1 승격하지 않고 `worker.*`/`state.updated` 로 접는다(고빈도가 미션 단위 회전을 깬다 — 결정 D11).

**StateStore = now / ledger = history / state.yaml = 투영**(크로스체크 R3 반영): 트랜잭션 경계는 **StateStore 쓰기**다 — `state-manager` 가 `withFileLock` + tmp/rename + `state_version` CAS 로 store 를 갱신하고, 주입받은 `appendEvent` 포트로 같은 트랜잭션 안에서 `state.updated{state_version}` 을 append 한다. state.yaml 은 그 뒤에 락 없이 재렌더(손상돼도 재생성). `state_version` 단조 증가 → 원장의 빈 번호가 곧 lost-update 탐지(`/doctor` Check 8). 원장은 락 없이 `'a'` 플래그 단일 write(줄 4KB 상한, 초과분은 `evidence_refs`). 게이트 `tests/firewall/ledger-append-survival.test.js`: 3프로세스 × 20줄 동시 append **60/60 생존**(decision-trail 60→39 와 같은 조건), 4KB 초과 거부, allowlist fail-closed, **store 쓰기마다** `state.updated` 1:1(state.yaml 렌더는 게이트 대상 아님). Windows `'a'` 원자성은 추론 — 게이트로 실측 고정 전까지 보장이라 말하지 않는다.

**mission_id 전파**: ① `state.yaml.active_missions`(v1.1 지정 캐리어 — 훅은 `session_id+cwd` 로 조회) ② env `ARTIBOT_MISSION_ID`(autopilot·split 자식 프로세스, split `runId` = mission_id alias 로 `runtime/split/<runId>.*` 자동 조인) ③ 훅 페이로드는 기대 불가. `.current-mission.json` 류는 만들지 않는다(파생 파일).

**accepted 정의**: `verify.completed=pass ∧ review.completed=pass ∧ 관측창 내 미되돌림 ∧ outcome.md 존재`. 판정은 지연(session-end 또는 nightly) — `mission.completed{accepted:null}` 먼저, 창 만료 시 `{accepted:true|false, supersedes}` **덧붙임**. KPI 분모는 non-null 만. 관측창 길이는 결정 D3.

**state.yaml = fold 캐시(레인 6 §5-③)**: vNext `run-store.js#rebuildState`+`state-reducer.js#reduce`("같은 스트림 → 바이트 동일 상태, 삭제 가능 캐시")와 동형으로 `reduceProjectState(events)` 정의. 쓰기 순서 고정 = append 먼저, 투영 갱신 다음. `/doctor` 가 `reduce(ledger) ≟ state.yaml` 바이트 비교 + `state_version` 빈 번호로 lost-update 검출. §1-2 StateStore 채택 후에는 store 가 reduce 결과의 정본 저장소이고 state.yaml 은 그 직렬화 — 규칙은 동일. 미해결: state.yaml 의 **사람 직접 기입 필드**(owners.humans 등)를 재구성 캐시와 어떻게 분리 보존할지(결정 D14).

**메모리 승격 이벤트(§5-④)**: `mission.completed{accepted:true}` 만 트리거 → `memory.candidate/dedup/validated/promoted|rejected` 5이벤트, `kind` 6종 allowlist 로 08 비승격 목록은 구조적으로 생성 불가. **메모리 두 체계 공존 실측**: Claude Code 자동 메모리 `~/.claude/projects/<slug>/memory/`(MEMORY.md + 1사실 1파일 frontmatter) vs Artibot `~/.claude/artibot/memory/`(`memory-manager.js:87`). 권고: 승격 산출은 **전자**(모델이 매 세션 로드하는 유일한 표면), kind→type 매핑(architecture_decision·convention·tool_constraint→`project`, failure_pattern→`feedback`), 후자는 학습 패턴 JSON 용도로 남김(결정 D15). `review-queue` approve 는 후보 생성기가 아니라 validated 승인 UI 로 재배치.

**Observe→Shadow 학습기**: 읽기 10필드, shadow 줄은 `route.selected{source:'shadow', shadow_of}` 를 프로덕션 옆에 append(프로덕션 불변). **메모리 승격 트리거 = `mission.completed{accepted:true}`** → 08 흐름(dedupe→validate→promote), 기존 `review-queue.js` approve 경로 재사용하되 입력을 세션 전사에서 중앙 원장 fold 로(NEXT-SESSION "toExperience 결과 차원" 조건과 일치). `promote_only_after_outcome:true` 를 코드 게이트로.

**`/why` `/cost` `/status`**(D17, 전부 미존재): `lib/runtime/ledger.js#foldMissions` 읽기 프로젝션. `/status` 는 state.yaml 먼저(now) + 원장 보강 — 08 "status.md 금지" 는 파일 금지이지 뷰 금지가 아님. 신규 커맨드 vs `/doctor` 확장은 결정 A5. 회전은 **미션 단위**(`mission.archived` 만, 줄 단위 컷 금지), raw 로그 3종 pruner 는 mission.archived 이후 N일. 파일 배치: `lib/runtime/{ledger,event-writer}.js`(v1.1 이름), v1.0 `run-ledger.js` 는 만들지 않고 `foldMissions` 가 v1.0 스키마 객체 반환. Core(1) decision-trail 이 Runtime(5) 을 import 하면 역방향 → dual-write 는 cognitive-router(4) 에서.

### 3.7 헌법 · 결정등록부 · 진입 계약 · 제거 후보 (레인 7)

**원칙 14 × 현행**: 성문화 5(Foundation·Think Deep·Intent Fidelity·Independent Review·Reason with AI) · 부분 6 · 없음 1(Outcome Economics — `accepted.outcome|success@1` 전역 0) · **충돌 2** — §6 Bounded Proactivity(karpathy R3·`blindspot.md:10,29` recommend-only·`quality-gates.md:20` 세 곳이 일관되게 비요청 변경 금지) 와 §12 Ask for Decisions(스킬층: 22/114 스킬 `## Human Checkpoints` "Skippable: No" 가 사실확인을 사람에게 묻게 함). **규칙층 충돌 0** — verification-discipline·보고/중계 계약은 무변경.

**D01~D19**: 채택 7(D01·02·06·07·10·13 + D07 은 2026-09-02 phaseRoles 로) · 부분 9 · 미채택 3(D04 자동수정·D12 수락결과 경제·D19 공동 최적화). D08 은 규칙층 채택/스킬층 미채택. D17 `/why /cost /status` 는 §13 과 긴장 → 기존 표면 확장 권고. D18 은 제거 선례는 있으나 **주기적 존재증명 규칙 없음** → `## Existence Audit` 절.

**ARTIBOT.md 진입 계약 — 대체 아님, 병존 필수**(§0-1 확인): 하네스는 CLAUDE.md 계층 + `.claude/rules` 만 자동 로드. ARTIBOT.md 는 8줄 네비게이션 계약, 루트 CLAUDE.md(현행 5줄, 위임 1줄 — 사실상 ARTIBOT.md 원형)가 그것을 읽게 하는 어댑터. include(호스트 지원 **미확인**) 또는 8줄 복제 + parity 게이트(결정 B3). `plugins/artibot/CLAUDE.md`(개발자용)·`AGENTS.md`(타툴 투영)는 별층 무변경. 리스크: read-order 드리프트 → `tests/firewall/` "CLAUDE.md 가 ARTIBOT.md 를 가리킨다" 1건.

**project.md 이전 매핑**: Purpose·Architecture Invariants·References 는 `plugins/artibot/CLAUDE.md` 에서 이전, **Core Principles(14원칙)는 CLAUDE.md 가 아니라 project.md 가 목적지**(4K 예산도 지킴), Collaboration Rules 는 요약 3줄만(정본 `ORCHESTRATION-ROUTING.md` 유지), **Human Approval Boundaries 는 신규** — "사람이 승인해야 하는 것" 목록이 지금 한 곳에 없다(autopilot Safety·save·ROUTING:76-79·question-recommendations 분산) → 본문은 §3.5 HG-01…13(중복 0). CLAUDE.md 에 남는 것: DEV·Problem-First·Quality Gates·Context Efficiency·Testing(행동 규율층).

**비협상 12 × 현행**: 성문화 3 · 부분 5 · 없음 2(intent.md 아티팩트, 스위칭/히스테리시스 개념) · **위반 사례 3** — NR1 파생 파일(ADR 2계열, `.plan-state.json` 2개) · NR2 status 류 경쟁 진실원(루트 `.artibot/` 6파일) · NR10 파일명 버전(`-2.md`, `-v2.html`, 설계 사본 2경로×2세대). NR5 원장 ≥6종 분산.

**D18 제거·축소 후보(기본 REJECT, 실측 있는 것만)**: R1 `lib/orchestration/{canceler,dag,handoff-filter,status}.js` 소비처 0 → 4파일 제거(3파일 유지) · R2 `recap` = `daily` 276줄 전체 복제 → alias 로 접기 · R3 스킬 22 Human Checkpoints 결정형만 + 108 Rationalizations `references/` 강등 · R4 self-evaluation GRPO 절(백필 은퇴 1665eb48) · R5 `auto-command-suggest.js` 기본 OFF(발화 실측 없음 → Observe 후 결정) · R6 `model-catalog` promptStyle/refusal constraint DEFER · R7 `team.md:60-86` API effort 스니펫(Agent 도구에 없는 파라미터) ADOPT 삭제 · R8 계약 5중 인라인 복제 → 정본 1파일 + 참조(내용 무변경) · R9 rules 동기 **철회** · R10 원장 통합 PARTIAL · R11 ADR 재번호 ADOPT · R12 루트 status 3추적 아카이브 이동 PARTIAL · R13 plan-state DEFER · R14 설계 사본 단일 경로 ADOPT. **유지(REJECT)**: 보고·중계 계약·`{sid}`·Phase 0 VALIDATE·Phase 4.5·fast 하드캡·Operator-Waits·FABLE_DENYLIST·task-budget 하한·PreToolUse 보안 훅·dispatch-table·vitest-only·격리·ambiguity-guard·verification-discipline 전문.

**헌법 채택 변경 순서**: 단계 A(문서만, Observe 즉시): A-2 14원칙 → `.artibot/project.md#Core Principles` · A-3 `## Existence Audit` · A-4 dev-protocol Step 1 "상류·하류 1줄" · A-5 `plan.md` 복구 사다리 · A-6 team.md:60-86 삭제 · A-7 `adr.md` "결정만 질문" · **A-8** verification-discipline 말미 §13 충돌 기록 우선순위 6줄(오늘 유일한 손질, 삭제·완화 0). 단계 B(질문 빈도 변화, Observe 원장 1릴리스 후): B-1 체크포인트 결정형만 · B-2 Rationalizations 강등 · B-3 GRPO 절. 단계 C(오너 결정 + Shadow 후): C-1 ROUTING:76-79 "advisory-only" 를 단계 표기 · C-2 D04 채택 시에만 blindspot 5조건.

---

## 4. 로드맵 — v1.0 §14 · v1.1 §14 P0~P2 를 OD-1 4단계에 사상

| 단계 | 행동 변화 | 무엇을 만드나 | 게이트(vitest firewall) | 종료 조건(분모 있는 수치) |
|---|---|---|---|---|
| **Phase 0 · 정본 착지**(코드 최소, 문서·파일) | 0 | v5-design 커밋 · `ARTIBOT.md`(19) + `.artibot/project.md`(18, Core Principles·Human Approval Boundaries HG-01…13 포함) · `PRD-…-2.md` 병합 · 표류 원장 삭제 · ADR 단일 계열(B2 후) · 루트 status 3파일 아카이브 · 헌법 단계 A 8건 · `.gitignore` `runtime/`·`transcripts/` · **`eslint.config.js` 레이어 등록 11 디렉터리**(§1-8, §8 로 +3) | `artifact-governance`(#1·#2·#4·#6) · CLAUDE.md→ARTIBOT.md parity | 게이트 그린 + 현행 위반 3축 0건 |
| **Observe**(기록만) | 0 | `event-writer`+`ledger.jsonl`+mission_id(세션 fallback) · `state.yaml`+`state-manager`(B1 후) · `compileMission` 모든 프롬프트(기록만, intent.md 생성 0) · `allowedTiers`+라우터를 SubagentStart 에서 호출해 spawn-ledger 필드만 · `decision-events` 훅 배선 1줄 + `topology-recommended` · `independent-reviewer` verdict 파싱 기록 · `unified-verifier` UNMEASURED 카운트 · usage receipt 파서(transcript, `source` 필수) · `/doctor` Check 8 | `ledger-append-survival`(60/60) · 어휘 allowlist · state.updated 1:1 · 영수증 스키마 가드 | compile 성공률·substantive 분포 / 추천≠정책 스폰 비율 / verdict 파싱률·층별 UNMEASURED 비율 / 영수증 커버리지 ≥95% / 훅·커맨드·스킬 발화 카운트(Existence Audit) |
| **Shadow**(비교) | 0(intent.md 생성 시작) | `missions/<M>/intent.md` 생성 · `command_activation` vs 실제 슬래시/힌트 수락 · `topology-actual` vs 추천 · 라우터 추천 스폰의 영수증·평가점수 비교 · recovery 분류 기록(기존 고정 전이와 달랐을 때) · 가격 단일화 + 5.1 계수 실측 · seeded-defect 코퍼스 N 확정 · 헌법 단계 B(체크포인트 축소) · HANDOFF/NEXT-SESSION 렌더 뷰 전환 · split run → state.yaml.workers 어댑터 | 기존 + nl-activation eval jsonl | NL activation ≥90%(실사용 대조) / 라우팅 불일치 표본 검토 / catch-rate·FP·위치정확도(opus 비교군) / 오분류율 |
| **Canary**(저위험만 자동) | 있음, config 1키로 되돌림 | 저위험 커맨드 자동 활성(allowlist A2) · `classify·status` 만 haiku/sonnet 실적용(Agent `model` alias 확인 후) · autopilot `nextPhase` = verdict 함수 · `HUMAN_GATE_MATRIX` 훅 강제 + `.claude/` 축소(C3 후) · `/save`=checkpoint·`/resume`=ARTIBOT 순서 · 헌법 단계 C-1 · (D04 채택 시) bounded blindspot | 기존 + human-gate 매트릭스 자기검증 | 카나리 오작동 0, 되돌림률 임계 이하, PAUSE/재시도 횟수 이전 대비 |
| **GA** | 확대 | 저위험 외로 확대, 4티어 전면, split 자동 진입(WP02 선행) | — | 파괴·배포·외부쓰기·제품결정 사람 게이트 **영구** |

**v1.1 §14 P0 9항 ↔ 위 단계**: P0-1 ARTIBOT.md · P0-2 state.yaml · P0-3 project.md → Phase 0/Observe / P0-4 intent.md → Shadow(§3.1 substantive allowlist 선행) / P0-5 plan revision → Shadow / P0-6 no-derived validator → Phase 0 / P0-7 중앙 ledger → Observe / P0-8 execution profile → Observe(interpreter 없이는 topology 1/3 만 — §3.1) / P0-9 model switching → Observe 기록·Canary 적용. v1.0 §14 exit criteria(usage ≥95%·NL ≥90%·catch-rate) 는 각 단계 종료 조건에 그대로.

---

## 5. 결정 필요 항목 (레인 7개 통합 · 중복 제거 · 가치 결정만 — 사실은 조사로 해소됨)

권고가 있는 항목은 **굵게**. 제3의 답도 좋다.

**A. 가치·정책**
| # | 결정 | 출처 | 권고 |
|---|---|---|---|
| A1 | blindspot 자동수정(D04) — 설계 09 6조건 허용 vs `blindspot.md` recommend-only | L1·L7 | **미채택 유지**, Observe 에서 보고 건수·수용률 원장 후 Canary 저위험 bounded 만 재론 |
| A2 | Canary 저위험 allowlist 경계 — 제안 `/analyze /explain /blindspot /scorecard /why` + autopilot 무확인 진입 조건 | L1·L5 | 위 5종 + autopilot 은 게이트 히트 0 ∧ allowlist |
| A3 | NL 자동발화 Act 시점(D16) — ROUTING:76-79 완화 시점 | L7 | **Shadow 원장 1릴리스 후** |
| A4 | 스킬 22 Human Checkpoints 축소(D08) | L7 | **채택**(단계 B) |
| A5 | `/why /cost /status` 신규 커맨드 vs `/doctor`·`autopilot:status` 확장 | L1·L6·L7 | **기존 표면 확장** |
| A6 | ~~`autonomy.mode` enum~~ — **F2 에서 해소**(8키 profile 의 `autonomy` 키가 흡수, 값은 스키마 3값 권고) | L1 | F2 로 병합 |

**B. 문서·정본 경계**
| # | 결정 | 출처 | 권고 |
|---|---|---|---|
| B1 | `state.yaml`·`missions/` 추적 여부 — 다인 공유(v1.1 09) vs 라이브 diff 잡음 | L1·L3·Hardening §1.1 | **갱신**: `state.yaml` 은 투영이므로 **미추적·재생성 가능**, 다인 공유는 저장소·원장으로(단일 호스트 우선, 멀티호스트는 P2). `missions/*.md` 는 **추적** |
| B2 | ADR 정본 계열·위치 — `.artibot/adr/` 통합, 플러그인 5 이동 + 루트 5 재번호 | L3·L7 | **통합**, 인용 파손 수 측정 후 |
| B3 | `ARTIBOT.md` 를 CLAUDE.md 가 include vs 8줄 복제 | L7 | **조사 선행(§7.6)** — 호스트 include 지원 여부는 조회로 해소. 미지원이면 결정 없이 **복제 + parity 게이트** |
| B4 | autopilot/split 자동 생성 mission 추적 여부 | L3 | 사람 mission 추적, 자동 생성은 로컬 + outcome 만 승격 |
| B5 | 설계 세트 버전 디렉터리(`_v1.1`) 허용 + 사본 단일 경로 | L3·L7 | 세트 단위 허용, `.artibot/guides/` 한 경로, `docs/` 원본 삭제 |
| B6 | `/checkpoint`·`/daily --save` 폐기 vs 별칭 · 개인 메모리 승격기 위치 | L3 | 별칭, `/dreaming` |
| B7 | `reports/SPLIT` 추적 예외를 outcome.md 로 흡수 | L3 | 흡수 |
| B8 | v5-design 디렉터리 커밋 시점 | L3·L7 | 이 설계안 승인 직후 |

**C. 게이트·검수**
| # | 결정 | 출처 | 권고 |
|---|---|---|---|
| C1 | ~~"ask" 정의~~ → **결정됨(OD-5)**: 대화형 승인 = `AskUserQuestion`. 훅 block 은 트리거, 비대화형은 PAUSE + `human.asked` | L4·L5 | 확정 |
| C2 | 배포·PR·외부쓰기 게이트 — 정규식 확장 vs 도구 단위(PermissionRequest) | L4 | 정규식 13행 매트릭스 먼저, 도구 단위는 마찰 측정 후 |
| C3 | `.claude/` 화이트리스트 축소(settings·hooks·config·dispatch-table 게이트) | L5 | **채택** |
| C4 | `UNMEASURED` 를 완료 차단 사유로 — 초기엔 behavioral 층이 비어 거의 모든 런이 완료 불가 | L4 | 층별 필수/선택 config, Observe 는 카운트만 |
| C5 | Builder≠Reviewer 위반 시 거부 vs 기록 | L4 | 기록 → Canary 에서 거부 |
| C6 | seeded-defect N·목표 catch-rate | L4 | N 은 Shadow 진입 전 확정(미정 = 미확인) |
| C7 | `orchestrator.md:80-83` "리더는 코드베이스를 읽지 마라" vs `team.md:36-37` "검증은 구현이 아니다" — 현행 내부 충돌 | L7 | **team.md 정본**(검증 규율과 일치), orchestrator.md 수정 |
| C8 | 원장 중앙화 범위 — v1.1 단일 `ledger.jsonl` vs split 의 **런별 분리 설계 의도**(런 격리·리플레이). 전면 통합 vs `review.*`·`mission.*` 만 중앙 | L4 | 레인 6 설계대로: 중앙 원장에는 미션 단위 이벤트만, split 런 파일은 raw log 로 잔존 + `runId = mission_id` alias 로 조인(전면 통합 아님) |
| C9 | "substantive mission" 판정 주체 — 모델이 판정하면 "사소해서 미션 아님" 이 outcome.md 강제의 **우회 경로** | L4·L1 | §3.1 S1·S2(쓰기·커밋 기대)는 **도구 호출 시점에 훅이 판정**하므로 모델 자기신고가 아님. S3~S6 만 프롬프트 시점 추론 → Shadow 에서 deferred 건수로 우회율 측정 |

**D. 라우팅·경제·원장**
| # | 결정 | 출처 | 권고 |
|---|---|---|---|
| D1 | 가격 진실원 — `model-catalog`($5/$25) vs `cache-roi`($15/$75) | L2·L6 | **조사 선행(§7.6)**: 어느 값이 맞는지는 조회로 해소. 남는 결정은 "정본 파일 = 카탈로그 한 곳" 뿐, 그전 `total_cost:null` |
| D2 | 트랜스크립트 파싱을 P0 영수증 소스로 인정(미문서화) | L2 | **인정** + 스키마 가드 + parseFailures 를 exit 기준에 |
| D3 | Accepted Outcome 최소 정의 + 관측창 | L2·L6 | `verify pass ∧ review pass ∧ 미되돌림 ∧ outcome.md`, 창 7일 |
| D4 | 라우터 Observe 삽입 지점 — SubagentStart vs UserPromptSubmit | L2 | **SubagentStart**(스폰 단위 귀속 명확) |
| D5 | haiku/sonnet Canary 첫 행동 클래스 | L2 | `classify·status` |
| D6 | intent.md 부재 시 `performance` 를 프롬프트에서 추론 vs 플래그만 | L2 | 플래그만(오탐 방지) |
| D7 | `model.switched` 기록처 — spawn-ledger 필드 시작 vs 중앙 ledger.jsonl | L2·L6 | Observe 는 spawn-ledger 필드, ledger.jsonl 생기면 dual-write 후 이관 |
| D8 | NR9 스위칭·히스테리시스 — 하네스 `/model` 위임 vs 플러그인 개념 | L7·L2 | 플러그인 개념(실효 단위 = 스폰), 세션 중 전환은 호스트 지원 **미확인** |
| D9 | `decision-trail.json` 처분 | L6 | dual-write 후 **읽기 전용 동결** |
| D10 | mission fallback 단위 — 세션 1개 vs 프롬프트마다 | L6 | 세션 1개 |
| D11 | raw log pruner 소유 · heartbeat 류 중앙 원장 제외 | L6 | 레인 6 pruner 흡수, heartbeat 제외 |
| D12 | `split.recommendMinSubtasks` 켤지(현재 null = 힌트 영구 OFF, ≤6 은 autopilot 힌트를 가림) | L1 | Observe 데이터용으로 7 |
| D13 | generous 예산 형태 — 배수/해제/별도 상한 | L5 | BD01 착수 전 결정 불필요, YAML 문구는 `execution_profile.performance` 로 |
| D14 | state.yaml 의 사람 직접 기입 필드(owners.humans 등)를 재구성 캐시와 분리 보존하는 방법(v1.1 미명시) | L6 | 사람 기입 필드는 StateStore 의 별도 컬렉션(`project_meta`)에, 투영 시 합성 |
| D15 | Artibot 자체 메모리(`~/.claude/artibot/memory/`)를 Claude Code 자동 메모리(`~/.claude/projects/<slug>/memory/`)로 합칠지 | L6 | 승격 산출은 후자로, 전자는 학습 패턴 JSON 만(합치지 않음) |

**E. 구조**
| # | 결정 | 출처 | 권고 |
|---|---|---|---|
| E1 | v5 = 헌법, vNext = split/autopilot 실행 스펙 | L5 | **채택** |
| E2 | 진실원 — StateStore(라이브) + ledger(이력), state.yaml 투영(§1-2, Hardening §1.1·§46) vs 요약 레코드(v1.0) | L5·L6·L7·Hardening | **§1-2 규칙으로 확정**, run-ledger 레코드는 fold 뷰 |
| E3 | `lib/supervisor` 이름 유지 vs `topology/split-runtime` 이관 | L5 | **유지** |
| E4 | `runtime/autopilot/` 12,089 파일 정리/격리(삭제 권한은 사람) | L5·L6 | 격리 후 삭제 승인 |
| E5 | R2 `recap` 별칭 접기 | L7 | frontmatter alias(게이트 확인 후) |

---

## 6. 미확인 (레인 표기 그대로 전파 — 요약하면서 삭제하지 않음)

- **호스트 계약**: Agent 도구 `model` 파라미터가 tier alias 를 받는지(§3.2 Canary 전제) · 실행 중 서브에이전트 모델 전환 지원 여부 · CLAUDE.md 파일 include 지원 · 훅 페이로드에 미션 상관 id 부재(문서 근거만) · AskUserQuestion 발생을 잡는 훅 경로 · `message.usage` 필드 집합의 버전 간 안정성 · OTLP 메트릭 속성(수신기 없어 실측 불가).
- **가격·모델**: 가격표 둘 중 어느 것이 현행인지(둘 다 틀렸을 가능성 포함) · Sonnet 5 정확한 ID · haiku `claude-haiku-4-5` vs `…-20251001` 관계 · `execution_profile.performance` 허용값 목록(04 예시는 `maximum` 1개만) · 5.1 tokenizerCoeff·비용 계수 2.6×.
- **라이브 발생률 전부**: system1/system2 분포(`agentTeam` 배제 비율) · §3.4 오판 경로 A~F 가 실런에서 밟힌 횟수 · `state.crossCheck.verdict="fail"` 이 실제 기록된 세션 존재 여부 · 훅 42·스킬 114·커맨드 79 의 발화·활성 횟수 · Human Checkpoints 가 AskUserQuestion 을 유발한 빈도 · `autopilot-nlu-trigger` 와 plan 힌트 동시 발화 빈도 · 라이브 split/compact 0회.
- **원장·상태**: decision-events 디렉터리 미생성 원인(emitter 미배선 vs 발화 조건) · decision-trail 08-25 이후 공백 원인 · cache-roi 전부 0 원인 · `.artibot/ledger/*.jsonl` 내용(스키마 한 줄도 안 열음 — C1 샤딩 판정은 파일명 추론) · 정책 trail 5종 writer/보존 · 표류 원장이 1회인지 재발 중인지 · state.yaml 추적 시 diff 잡음 크기 · Windows `'a'` 플래그 단일 write 원자성(게이트로 고정 전까지 추론) · `lane-state.mjs` 쓰기 본문(레인 5 는 헤더·파서만 열람) · Ontology 자유형 파일 목록(오전 `ls` 1회).
- **코드 미열람**: `lib/cognitive/router.js` 792줄 중 `classifyComplexity` 외 · `lib/planning/` 4파일 내용 · `commands/plan.md·ultraplan.md·sc.md` 본문(`/sc` 가 이미 NL→커맨드 매핑이면 §3.1 과 중복 가능) · `lib/autopilot/{cost-tracker,cost-predictor,goal-budget-aggregator}.js` 가 pause 로 이어지는지 · `cost-tracker` 의 `usage.costUsd` 원천 · `summarization.js` 실제 실행 여부 · `agent-evaluator` 점수의 학습 가중치 · `collectExperience` 하류 · `runtime/autopilot/` 12,089 파일 전수 잔재 판정(샘플링 기반, 리더는 파일 수만) · `reports/AUTOPILOT` 3,061 실세션 비율 · 플러그인 `docs/adr` 이동 시 깨지는 인용 수 · NR11 메모리 승격 게이트 실행 여부 · Ontology 리포 진입 파일 구성.
- **설계 문서 미열람 범위**: L1 — v1.1 01·03·05·06·07·08·10·11·15·18·19·20, v1.0 04~08·10·11·14·정책 YAML(`06_STATE_YAML_SPEC`·`15_POLICY_EXAMPLE` 에 execution_profile 키가 있으면 §3.1 과 충돌 가능) · L3 — v1.1 09·07·17·20 전문 · L4 — 설계 13 `review/fable-reviewer.js`·`review-policy.js` 미다룸(별도 fable 모듈 필요 여부는 결정 사항으로 봄), 설계 12 "§9~10" 은 절이 아니라 다이어그램 블록 9·10 으로 해석 · L5 — v5 02~06·08~10, **v1.1 01·03·04·07·10 미열람, 02·08 부분 열람**(02 첫 60행, 08 첫 70행 — §2-D 는 06·09·11·12·13·14·15·16 기준; 레인 5 † 정정 문구).
- **테스트 실행 0**: 모든 레인이 읽기 전용. 코드 동작 서술은 읽기 기반 추론이며 실측 표기된 것만 실행 결과다. 리포 루트 `scratchpad/`(미추적·`.gitignore` 미등재)에 레인 4 파일 1개가 **† 기준 다시 존재**한다(reviewer 실측) — 세션 임시 경로 사본이 정본이며 리포 쪽은 삭제 예정.
- **7레인 전수 대조로 추가된 유보 9건(reviewer †, 원문 그대로)**: L1 "`lib/context/rehydration.js` 내용 — 다른 팀원이 동시 편집 중이라 12:10 KST 에 존재만 확인." · L2 "`agent-evaluator.js` 점수와 실제 수락의 상관 — 데이터 없음." · L3 "MANIFEST 무결성(리더 확인분) — 내 재검증 없음." · L3 "`.artibot/SESSION-NOTES.md` 를 raw 로그로 분류한 것은 `08` 해석(추론)." · L3 "타 레인이 `handoff-store.js`·`save.md`·`model-policy.js` 동시 편집 중 — 해당 인용은 14:0x KST 워킹트리 스냅샷." · L5 "`tests/firewall/split-telemetry-callsites` 산문 래칫이 실런에서 recorder 를 실제로 호출하게 만드는지(라이브 split 0회)." · L5 "설계 YAML 의 `routing.models`(classify haiku 등) 는 현 `agents.modelPolicy`(2티어) 와 충돌하나 레인 5 범위 밖 — 언급만."(§3.2 4티어 순서가 답이나 유보는 유지) · L7 "'Cost per Accepted Outcome' 을 어느 레인이 정의하는지(10_LEARNING 추정, 미열람)."(§3.6 레인 6 이 정의 — 유보는 유지) · L7 "fable-audit 의 인용 줄번호(#14~#20)는 오늘 재열람 안 함 — 재인용 표기." L7 의 orchestrator.md vs team.md 충돌은 §5 **C7** 로 이미 승격돼 있다. ~~L6 은 전용 절이 없다~~ → 정정: L6 v2 부터 `## 4. 미확인`(166행) + §5 말미 "미확인(본 절 추가분)"(263행) 이 있다(리더 † 실측; reviewer 는 v1 을 본 것으로 보임 — 추론).
- **L6·L7 자기 대조로 추가된 유보 4건(†, 원문 그대로)**: L6 "레인 3 정본이 package-v1.1/08 인지 — 리더 지정 문서 미수신, 08 로 가정."(§3.3 이 v1.1 08 을 상위 정본으로 재작성했으므로 사실상 해소 — 유보 문구는 유지) · L6 "세션 중 변하는 수치(autopilot 12,067파일·세션 원장 33파일/7.5MB·trail 971건)는 14:05 스냅샷." · L6 "v1.1 이 `.artibot/runtime/` 아래 ledger 외 파일을 허용하는지(02 트리엔 ledger.jsonl 만)" — §3.6 evidence registry·§7.2 §23 이 `.artibot/runtime/evidence.jsonl` 을 그 아래에 두므로 **이 유보가 풀려야 그 배치가 성립**한다 · L7 "`.artibot/guides/v5-design/` 커밋 여부(14:05 `??`)" — † 도 `??`, 결정 B8 대기.
- **L4 추가(reviewer 가 누락을 지적, 원문 그대로)**: "v1.1 패키지 중 레인 4 밖 문서(01·05·06·07·08·10·12·13·14~19)는 읽지 않았다. `plan.md` revision 규약(05)·`state.yaml`(06)이 §5.3 의 `plan_revision` 과 어떻게 맞물리는지는 그쪽 레인 소관으로 뒀다." — `plan_revision` 은 verdict 스키마 필수 필드라 이 유보는 살아 있다.
- **보강 라운드 추가분**: memory 미들웨어가 `create-artibot-agent.js` 파이프라인에서 라우터 직후에 붙어 §3.1 우선순위 8단 순서를 뒤집을 위험 — 등록 순서만 봤고 각 미들웨어가 무엇을 먼저 읽는지 미열람(L1) · `verification_id` 구체 형식(해시 범위·충돌 확률)(L4) · `memory.candidate` 추출기 실행 주체(Fable 리뷰어 vs 별도 스크립트)(L6) · state.yaml 사람 필드 위치(L6) · 세션 원장 keep-50 과 N일 중 실제 선발동 조건(라이브 미션 길이 분포 미측정)(L6) · `state-manager.js`/`state-lock.js` 멀티휴먼 동시쓰기 규약 본문 미열람(L5) · 레인 4 1차본 유실의 정확한 삭제 시점(리더 추정: 세션 초반 `scratchpad/` 정리)(L4).

---

## 7. Final Architecture Hardening Addendum 판정 (오너 † 추가 입력, 리더 직접 대조)

### 7.1 요약

§0~§52 53절(§0 요약 제외 52절)을 통합 설계 v1(§1~§6)과 현행 코드에 대조했다. **설계 변경(덮어씀) 7 · 확장 채택 23 · 이미 일치 18 · 스키마만 v5.0(강제는 P2) 3 · 범위 밖 1**(멀티호스트 Postgres) = 52(§40 은 §16-17 행에 합산, §50·§51 철학·요약은 일치, 크로스체크 후 §4·§47 행 추가 및 §18·§45-46 재분류). **"덮어씀 7" 은 통합 v1 이 그 7곳에서 틀렸다는 뜻이다** — 규칙층·본문과 정면 모순되는 절은 없지만 v1 을 그대로 두면 안 된다. 전부 통합 설계보다 한 단계 더 구조적으로 요구하는 방향이고, 레인 실측이 그 필요성을 이미 보여준 곳(worktree 사본, heartbeat null, verdict 어휘 4종, 공유 증거 없음)이 대부분이다.

**리더 실측(†)**: `package.json engines.node >=20.0.0`, 로컬 Node 24.15 · 리포 내 `sqlite` 사용 0 · `git-common-dir` 사용 0 · `based_on`·`schema_version`·task graph 의존성·`max_depth` 전부 **0건** · `lease` 는 **이름으로는 0 이지만 실체는 있다**(reviewer † 정정): 문자열 `lease` 는 `grep -rnw lease lib scripts` = **18**(`--force-with-lease` 리터럴 12 · keep-awake 3 · 정규식/주석 3; 이 18 은 테스트 제외값, `tests` 포함 시 28 — reviewer 15:0x 재현). 리더의 앞선 "17" 은 `--include=*.js | grep -v test` 필터가 `safety.js:18` 의 `test:` 정규식 속성 줄을 잘못 제외한 결과(명령 병기 안 한 오류 — 폐기). worker lease 라는 이름은 없다. 그러나 **`lib/git/landing-lock.js` 가 TTL 리스 그 자체** — `DEFAULT_STALE_MS = 30분`(:54, "3× CI wait ceiling"), 만료 판정 2축(PID 사망 `process.kill(pid,0)` :88 + 레코드 나이 `staleMs`), 회수는 `unlink` 후 `openSync(…,'wx')` O_EXCL(:116). 빠진 것은 **renew(heartbeat)뿐**(`renew|heartbeat|refresh` 0건). Addendum §9 는 "신규" 가 아니라 이 모듈을 prior art 로 두고 renew 만 얹는다(라이브 회수 실동작 기록은 미확인 — 존재 ≠ 작동) · `idempotency` **2파일**(`lib/git/split-dispatch.js`, `lib/supervisor/run-store.js` — reviewer 정정) · redaction 인프라 **존재**(`lib/core/guard-registry.js#SECRET_CONTENT_PATTERNS`, `redact` 20파일) · `plan-state.js` 에 태스크 의존성 필드 없음.

### 7.2 설계를 바꾸는 6건 + 확장 채택 (절 → 통합 설계 v1 → 판정)

| 절 | Addendum 요구 | 통합 v1 | 판정 · 반영 위치 |
|---|---|---|---|
| **§1.1** | state.yaml ≠ truth. Transactional State Store(SQLite) = live truth, state.yaml = projection | §1-2 "state.yaml = 권위 캐시"(v1.1 §06) | **덮어씀** → §1-2 갱신. 백엔드는 결정 F1(제로 의존성 유지 시 `node:sqlite` 는 engines 22.13+ 상향 필요 vs 레인 6 JSONL+락+CAS 를 StateStore 인터페이스 뒤에), 위치는 F3(`git-common-dir` 하위 = worktree 공유). B1 권고 갱신(state.yaml 미추적) |
| **§2** | NL → Execution Profile, 커맨드는 power-user shortcut. NL→커맨드 1:1 매핑 금지 | 레인 1 계약의 `command_activation` 7불리언이 1급 필드 | **덮어씀** → `command_activation` 은 profile 의 파생 투영으로 강등. 커맨드·스킬·명시 설정 → profile 어댑터(§30 호환층). Shadow 지표 "activation vs 실제 슬래시" 는 측정용으로 유지 |
| **§2 스키마** | profile 8키 {reasoning, autonomy, performance, parallelism, planning, context, review, completion} | v1.1 04 는 3키 {planning, performance, topology} | **확장 채택** — 3키는 부분집합(topology ≈ parallelism.strategy). 허용값 목록은 여전히 미확인 → 결정 F2 |
| **§3** | Project/Mission/Task/Action/Run 온톨로지. 비용·재시도는 **Run** 단위, 라우팅은 Action 단위, intent 는 Mission 단위만 | 레인 2 영수증 = 스폰 단위, 레인 6 봉투 = mission_id + action_id | **확장 채택** — 스폰 1건 = Run 1건(`spawns.ndjson` agentId = `run_id`), 봉투에 `task_id·run_id` 추가. "worker 별 intent 금지" 는 레인 5 "limb = worker" 와 일치 |
| **§4** | intent.md First-Class — 생성 기준을 **부정 목록**(단순 대화·짧은 수정·일회성 설명·작은 질의)으로, 본문 8절은 v1.1 17 템플릿 그대로 | §3.1 은 부정 목록이 생성 방향 fail-open 이라며 **allowlist S1~S6** 로 뒤집었고, 템플릿 **보강 5곳**(autonomy·Success 4소절·Bounded Blindspots·Completion·explicit_requests 분리)을 제안 | **덮어씀(통합 설계가 Addendum 을 덮어쓰는 유일한 방향)** — 부정 목록은 채택하지 않고 S1~S6 유지, 8절 + 보강 5곳 채택. Addendum §4 의 "한 Mission 에 intent.md 하나" 는 일치 |
| §47 | 최종 Runtime Architecture 다이어그램(`intent.md → Execution Profile → Plan → Task Graph → Context/Model/Topology → Execution → Evidence → Clean-room Review → Verifier → Outcome`) | §1 + v1.0 §12 | **일치** — 실질 모순 없음. `intent.md → Execution Profile` 순서 의존은 D6(플래그만)로 해소 |
| **§5·§20·§22** | Artifact dependency graph — `based_on{intent_revision, plan_revision, …}`, intent 변경 시 plan STALE / review INVALID / outcome NOT ACCEPTABLE **자동 전파**. execution profile·context package 도 `derived_from/based_on` | 없음(레인 3 은 revision 필드만, 코드 0건) | **덮어씀(신규 핵심)** → 모든 mission 산출물 frontmatter 에 `based_on`, 판정은 Mission Controller + `/doctor` Check 9("Broken based_on·Stale plan·Invalid review"). 완료 게이트 "Latest Plan not stale" 이 여기 의존. CX01 재주입 번들 헤더에 `based_on` — plan 변경 후 구 번들 재주입 금지 |
| **§6** | Documentation = Runtime side effect. `mission.created→intent.md`, `plan.accepted→plan.md`, `review.completed→review.md`, `mission.completed→outcome.md`. 에이전트에게 문서 갱신을 지시하지 않는다 | 레인 3 "커맨드가 산출물을 쓴다" | **덮어씀** → `lib/runtime/artifact-lifecycle.js` 가 event-writer 옆에서 이벤트 핸들러로 산출물을 만든다. 커맨드·에이전트는 **이벤트만 발행**. 레인 3 §2 표 "조치" 열의 writer 전부가 이 핸들러 하나로 수렴. Idempotency key(§11)로 재시도 시 중복 생성 방지 |
| **§7-8** | todo 원리는 유지, `todo.md` 는 안 만듦. Structured Task Graph{id, mission_id, status 8종, owner, dependencies, blockers, file_ownership, retry_count, heartbeat_at, verification, evidence_refs} 가 canonical | v1.1 `state.yaml.workers.owns[]`; `.plan-state.json` 은 의존성 없음 | **덮어씀**(v1 §3.5 가 worker 정본을 `state.yaml.workers` 로 두었다 → 정정) — Task Graph 는 StateStore 안, state.yaml 은 투영. `/split plan.json` limbs → tasks(`affectedPaths` → `file_ownership`), `/team` TaskCreate → tasks(도구 부재 시 프롬프트 배정 그대로). 상태 8종은 v1.1 7종 + `cancelled` → `V11_STATUS_TO_LANE_STATE` 에 1행 추가 |
| **§9** | Claim/Lease/Heartbeat — lease{owner, acquired_at, expires_at, heartbeat_at}, 만료 시 reclaimable | 레인 5 실측 `heartbeat_at` 항상 null, emitter 0; vNext DR01 미착수 | **채택(P1) — prior art 재사용**: `lib/git/landing-lock.js`(30분 TTL, PID 사망+나이 만료, O_EXCL 회수)를 워커 리스의 원형으로 두고 **renew 만 추가**(§7.1). emitter 는 SubagentStop/PostToolUse 훅 + split worker `lane-state.mjs`, 만료 판정은 controller. GA 전엔 reclaim 은 사람 확인. heartbeat 는 store 갱신만, 중앙 원장에는 `task.claimed/released` 만(D11 유지). `lib/autopilot/lock.js` 의 리스 의미는 미열람 |
| §10 | File ownership = coordination policy(Git lock 아님), exclusive/read-only/unknown overlap | `fast-profile#buildConflictGroups`·`limb-landing-check` ownership 행 | **이미 일치** — 선언 위치만 Task Graph 로 |
| §11 | Idempotency key(`mission:M:review:rev-2`) 로 모든 런타임 op 재실행 안전 | 레인 6 `(source,pid,seq)` dedupe | **확장** — 봉투 `idempotency_key?`, artifact-lifecycle 가 같은 키로 중복 생성 안 함 |
| **§12-13** | Ledger reconcile() + Crash Recovery/Resume Contract(store 로드 → ledger 위치 → 활성 mission → 만료 lease → reconcile → revision 재검증 → 안전 action 재개) | vNext DR02, 레인 5 `supervisor/reconcile.js` 명명, `/resume` = HANDOFF 출력 | **덮어씀** → `/resume` 는 Resume Contract 의 표면(레인 3 "ARTIBOT.md 읽기 순서" 는 그 사람용 절반). reconcile 정의 = §1-2 |
| **§14-15** | Clean-room Fable review(입력 allowlist, builder 채팅·자기평가 제외) + verdict 5종 + reviewer 는 truth 수정 불가 | 레인 4 3종, 4종→1종 | **확정 5종** → §3.4 갱신 |
| **§16-17** | Intent 수정 권한표(User 가능 / Controller evidence 기반 / Planner 제안 / Worker finding 만 / Reviewer 문제 제기 / Tool 불가) + **Mission Controller** 단일 논리 권한(§40 single writer) | 레인 1 compiler 만, 권한 주체 없음 | **덮어씀(신규 핵심)** → `lib/mission/controller.js`. Claude Code 에서는 **리더 세션 = controller**, split 은 부모 세션(레인 1 "부모만 발급" 과 일치). 동시 두 controller 방지 = StateStore `missions.<M>.controller{session_id, lease}`(split `locks/` 선례). 결정 F4 |
| §18 | 질문 게이트 4조건(가치 판단 + 하류 영향 + 증거로 결정 불가 + 오가정 비용) + ADR 초기 일괄 질문 | 레인 1 question-gate, D09 | **확장 채택** — v1 은 "판정만" 한 줄뿐, 4조건 본문을 `question-gate` 입력 계약으로 채택 |
| §19·§21 | 5개념 분리, fast/split 별도 목적함수 | §3.2 | **이미 일치** |
| §23 | Evidence Registry(E-nnn, type·source·hash) — Markdown 에 반복 복사 금지, `evidence_refs` 참조 | 레인 5 "공유 증거 인덱스 없음", vNext L0 | **채택(P1)** — `.artibot/runtime/evidence.jsonl`(로컬) + 봉투·산출물 `evidence_refs[]`, 레인 4 `unified-verifier.evidence[]` 가 첫 writer. ADDENDUM A7 바이트 무결성(blob sha)이 `hash` 필드 |
| §24 | Artifact provenance(created_by/updated_by/revision/based_on/evidence_refs) | 없음 | 채택 — frontmatter 표준, `actor{type,id}`(§41) |
| §25 | Secret/PII 를 artifact·ledger 에 자동 저장 금지, redaction policy | `guard-registry.js#SECRET_CONTENT_PATTERNS` 존재(쓰기 측 훅) | **재사용** — artifact-lifecycle·event-writer 가 같은 패턴으로 쓰기 전 마스킹, 신규 패턴 없음 |
| §26-27 | Retention 3등급, Memory Promotion 파이프라인 | 레인 3 §5-6, 레인 6 §2.7 | **이미 일치** |
| §28·§29 | Cross-repo 준비(ID 가 repo-local 가정 금지), `schema_version` + 마이그레이션 | 0건 | 채택 — state·intent·plan·review·outcome·봉투 `v` 전부. mission_id 에 repo 접두 없음(현행 `M-YYYYMMDD-NNN` 유지, `resources.repositories[]` 필드만 예약) |
| §30 | Backward compatibility adapter — 기존 커맨드도 내부적으로 profile 로 변환 | §1-5 additive | **이미 일치** |
| §31·§32 | state.yaml 재생성 가능 · Artifact Health Check 10항목 | `/doctor` Check 8(레인 6) | 확장 — Check 9 "Artifact Health"(intent 부재·based_on 깨짐·stale plan·invalid review·중복 정본·고아 mission·만료 lease·store/ledger 불일치·evidence 결손·schema 미지원) |
| §33-35 | 완료 게이트 8조건 · `technical_done / review_passed / accepted` 분리 · failure-class 기반 replan 임계(repair → replan → ultraplan → human) | 레인 4·6 | **이미 일치** — 완료 조건에 "Latest Plan not stale"·"State committed" 추가, D3 정의에 `technical_done` 상태 선행 |
| §36 | Delegation 한도{max_depth, max_workers, max_parallel_actions, max_retries} — worker 의 무한 재귀 방지 | fast `hardMaxAgents`·split `maxWindows`; `max_depth` 0건 | 채택 — `delegation.max_depth`(권고 2: 리더→팀원→Explore), `subagent-handler` 가 depth 를 spawn-ledger 에 기록(Observe) → Canary 에서 차단 |
| §37 | 예산 = Token·Time·Workers·External API·Retries·Context·Storage·Human Attention | token·`maxDuration`·workers 만 | 확장 — 측정 없는 상한은 무의미하므로 External API·Human Attention 은 원장 카운트만 먼저 |
| §38-39 | `/status /why /cost /doctor` 표시 항목 12 · audit summary 는 projection | 레인 6 §2.9, A5 | 일치 — A5 권고(기존 표면 확장) 유지, 표시 항목 12 를 `/doctor` 출력 계약으로 |
| §41-42 | actor{type: human\|agent\|runtime, id} attribution · 역할 모델(Viewer…Admin) | 없음 | **스키마만 v5.0**(`actor` 필드, userEmail 재사용), 역할 강제는 P2 |
| §43-44 | 브랜치/오프라인 worker 는 재연결 시 reconcile · 머지 후 artifact drift 검사 | vNext, `limb-landing-check` | 채택 — drift 검사 = Check 9 항목, reconcile = §12-13 |
| §45-46 | canonical 9종 고정, SoT 매트릭스("지금 실제 상태 = State Store / 사람이 보는 = state.yaml") | 레인 3 §1 | **확장 채택** — 통합 v1 에는 SoT 매트릭스 실물이 없다(§3.3 은 이행 매핑). §46 표 12행을 그대로 채택하되 "지금 실제 상태 = StateStore / 사람이 보는 = state.yaml" 2행 반영 |
| §48·§52 | P0 14 / freeze 8 | v1.1 P0 9 | 7.3 재사상 |
| §49 | 금지 12 | — | 전부 통합 설계와 일치 확인. "모델 선택을 Agent 이름에 고정" 은 §3.2 허용상한 해석으로 정합, "자연어를 command 문자열에 직접 매핑" 은 §2 반영으로 해소 |

### 7.3 로드맵 재사상 — freeze 8(§52) 과 P0 14(§48) 를 §4 단계에

번호 = **§48 항목번호**(#n), 절 참조는 `§n`(크로스체크로 축 통일).

| §48 항목 | 단계 | 근거 |
|---|---|---|
| #1 온톨로지 ID · #7 Artifact Registry(스키마·`based_on`·provenance 필드 — `§5`·`§24`·`§29` schema_version) · #8 staleness **규칙 정의**(판정 코드는 Shadow) · 레이어 등록 11 디렉터리(§1-8, §8 포함) | **Phase 0** | 문서·스키마·등록만, 코드 0 |
| #2 Mission Controller(**기록 전용** — 전이 결정은 Canary) · #4 Execution Profile(8키, 기록만) · #5 StateStore 추상화(F1 백엔드) · #6 Task Graph(store 안) · #9 Event Ledger · #11 routing 기록 · #12 5개념 분리 · #13 clean-room 계약(`buildReviewRequest` allowlist, 기록만) · #14 completion gate(카운트) · #16 file ownership(Task Graph 필드로 기록, 강제는 기존 `limb-landing-check`) · `§25` redaction 재사용 | **Observe** | 전부 기록만, 행동 변화 0, **산출물 파일 생성 0**(§4 표와 일치) |
| #3 intent.md 생성 시작 · #10 artifact-lifecycle(이벤트→intent/plan/review/outcome.md — **Shadow 에서 시작**, Observe 의 substantive 분포가 선행) · #15 lease/heartbeat · #17-18 resume/reconcile · #19 idempotency · #20 evidence registry · #21 context revision binding · #24 Artifact Health(`/doctor` Check 9) · #27 ADR question gate(4조건 기록) · `§36` delegation depth 기록 | **Shadow** | 비교·복구 인프라, 전이 무변경 |
| #8 staleness **자동 차단** · #15 lease reclaim · `§36` delegation cap 차단 · #22 split 통합 · #23 fast objective 실적용 · #14 완료 게이트 **강제**(outcome.md 생성기) · #2 controller 전이 결정 · #27 question gate 강제 | **Canary** | 행동 변화, config 1키 되돌림 |
| #25 identity · #26 role/permission · #28 audit summary · #29 retention/GC · #30 memory promotion(코드 게이트) · #31 schema migration · #32 cross-repo | **P2/GA** | 스키마는 Phase 0 에 예약 |

§4 표의 각 단계 "무엇을 만드나" 열은 이 표로 **보강**된다(삭제 없음). Addendum §52 의 "freeze 8 이 닫히기 전 대규모 기능 확장 금지" 는 OD-1 단계적 전환과 같은 뜻 — Canary 진입 조건에 "freeze 8 전부 Observe 이상" 을 추가한다.

### 7.4 새 결정 항목 (F) · 기존 결정 갱신

| # | 결정 | 권고 |
|---|---|---|
| F1 | StateStore 백엔드 | **결정됨(OD-4)**: (b) JSONL + 스냅샷 + `withFileLock` + CAS 를 `StateStore{getMission, updateMission, claimTask, releaseTask, heartbeatWorker, appendEvent, reconcile}` 뒤에. (a) `node:sqlite` 는 인터페이스 호환만(engines 상향 없음). 60/60 동시 append 게이트가 (b) 의 충분조건. §8 Replay·Checkpoint 도 동일 |
| F2 | `execution_profile` 스키마 — v1.1 3키 vs Addendum 8키 + 허용값 (A6 `autonomy` 흡수) | **8키 채택**. 허용값은 **조사 선행(§7.6)**: `06_STATE_YAML_SPEC.md`·`15_POLICY_EXAMPLE.yaml` 미열람 상태 — 거기 있으면 조사로 끝, 없을 때만 결정 |
| F3 | 저장 위치 | **결정됨(OD-4)**: `<git-common-dir>/artibot/`(worktree 공유, 자동 미추적). Windows junction worktree 에서의 `--git-common-dir` 값은 미확인 → Phase 0 실측 1건(I5). state.yaml 투영은 메인 트리 `.artibot/state.yaml` 에 렌더 |
| F4 | Mission Controller = 리더 세션(단일 권한 락). 다인 동시 세션·오프라인 worker 재연결은 P2 | 채택, 락 만료 규칙은 lease 와 동일 |
| F5 | verdict 5종을 `review-output.schema.json` v2 어휘로 확정(기존 `pass\|fail\|warning` 은 어댑터) | 채택 |
| B1 갱신 | state.yaml 미추적(투영), `missions/*.md` 추적 | §5 표 반영 |
| E2 갱신 | StateStore + ledger, state.yaml 투영 | 확정 |
| D3 갱신 | `technical_done → review_passed → accepted` 3상태, accepted 판정 지연 7일 | 유지 + 상태 분리 |
| D11 유지 | heartbeat 는 store 만, 원장 제외 | Addendum §9 와 정합 |

### 7.5 Addendum 이 답하지 않는 것 / 미확인

- 멀티호스트(Postgres 어댑터)는 **v5.0 범위 밖으로 둔다**(가정 — 오너 확인 필요). 단일 호스트에서 worktree 공유만 해결한다.
- `node:sqlite` 가 22.13 부터 무플래그인지는 문서 기억이지 실측 아님(로컬 24.15 에는 존재). F1 (a) 선택 시 CI 매트릭스로 확인.
- `git rev-parse --git-common-dir` 이 junction 기반 worktree 에서 올바른 경로를 주는지 미확인.
- Addendum §2 의 "비개발자가 주요 사용자" 전제와 §38 "사용자는 내부 상태를 볼 필요 없음" 은 오너 보고 형식(사용자 관점 §0 형식) 과 같은 방향 — 통합 문서 자체의 독자 층은 따로 조정하지 않았다.
- Task Graph 를 `/team` 의 TaskCreate 와 어떻게 잇는지는 Task 도구 존재 여부(세션별 다름, `team.md` fallback 절)에 따라 두 경로가 필요 — 설계만, 미검증.

---

### 7.6 조사로 해소할 항목 (결정 아님 — 크로스체크 #5 반영, Phase 0 착수 전 리더/레인이 수행)

| # | 조사 | 방법 | 해소되는 결정 |
|---|---|---|---|
| I1 | 현행 모델 단가(opus/fable/sonnet/haiku) | `claude-api` 스킬 또는 공식 가격표 1회 조회 | D1 의 "어느 값" 부분 |
| I2 | `execution_profile` 허용값 + `command_activation` 키 유무 | `package-v1.1/06_STATE_YAML_SPEC.md`·`15_POLICY_EXAMPLE.yaml` **및 v1.0 `config/artibot-v5-policy.example.yaml`** 열람(레인 1 경고: 후자에 `command_activation` 키가 있으면 §3.1 설계와 겹침) | F2 의 허용값 부분, §3.1 중복 여부 |
| I3 | CLAUDE.md 파일 include 호스트 지원 | `claude-code-guide` 조회 | B3 |
| I4 | Agent 도구 `model` 파라미터 alias 수용 | 실스폰 1건(planner 를 `model=haiku` 로) + `subagents/agent-*.jsonl` `message.model` 대조 | §3.2 Canary 전제 |
| I5 | `git rev-parse --git-common-dir` 의 junction worktree 값 | `scripts/split/worktree-setup.mjs` 로 만든 worktree 에서 실행 | F3 |
| I6 | `node:sqlite` 무플래그 최소 버전 | Node 릴리스 노트 | F1 (a) 선택 시(OD-4 로 당장 불필요) |
| I7 | 호스트가 실행 중인 서브에이전트의 모델 전환을 지원하는지 | `claude-code-guide` 조회 + 실스폰 1건에서 시도 | G1(Epoch 단위 = 스폰 vs 액션), §3.2 (b-2) |

### 7.7 크로스체크 반영 기록 (architect, 14:20~14:46 판정 REQUEST_CHANGES → 리더 반영 †~†)

R1·R2·R3·R4·R5·R6 본문 정정(§3.1·§3.3·§3.5·§3.6) · §7.1 합계 49→52 및 "충돌 없음" 문구 정정 · §7.2 에 §4(덮어씀)·§47(일치) 행 추가, §7-8 을 덮어씀으로, §18·§45-46 을 확장으로 재분류 · §7.3 번호 축을 §48 항목번호로 통일, intent.md·artifact-lifecycle 을 Shadow 로 이동, #7·#16·#27 배정, Observe controller 를 기록 전용으로 명시 · §1-8 레이어 규칙 신설 + V1~V5 주입 포트 재서술 + Phase 0 에 등록 산출물 · D1·B3·F2 를 조사 선행으로, A6 을 F2 에 병합. 미반영: 없음. reviewer 인용 검증은 대기.

## 8. Model Switching · Terminal Scorecard Final Design 판정 (오너 3차 입력, 리더 직접 대조 15:12~)

### 8.1 요약

§0~§68 **69절**(리더 `grep -c "^# [0-9]\+\."` = 69, architect 재확인)을 통합 설계 §3.2(레인 2 라우팅)·§3.6(원장)·§7(Hardening)과 현행 코드에 대조했다. **핵심 원칙 채택**: "Score every Action, switch per Routing Epoch, measure transition cost, record the decision, verify the outcome, replay before learning" — §3.2 의 5개념 분리·허용 상한·Observe→Shadow→Canary 와 정확히 같은 방향이고, 거기에 **기록 계층(Receipt 3종 + Replay)·경제 계층(Switch Economics + Routing Epoch + Residency)·가시화 계층(Scorecard 3레벨)·복원 계층(Checkpoint/Resume)** 을 얹는다. 집계(크로스체크 후 정정): 69절 = **판정 행 58**(§8.2 표) + **외부 리서치·요약 절 11**(§1·§2·§5·§10·§15·§18·§59·§60·§61·§62·§68 — 판정 대상이 아니라 인용·목차·정의문; **리더는 그 URL·날짜·라이선스를 검증하지 않았다**, §8.6). 판정 행 58 의 내역: 채택 35 · 확장/조건부 채택 18 · 통합 설계가 덮어씀(문서 쪽이 양보) 5. §4·§7·§8·§9·§11·§21~§25 처럼 외부 자료에서 **유도된 설계 요구**는 판정 행에 넣었고, 그 판정은 자료가 아니라 통합 설계와의 정합만으로 했다(§8.6 첫 항).

**리더 실측(15:12)**: `commands/scorecard.md` 존재(→ 문서의 `/score` 는 신설 아님, **`/scorecard` 확장**) · `lib/{checkpoint, replay, scorecard, telemetry}/` 전부 부재 · 스코어카드 코드는 `lib/planning/scorecard.js`·`lib/learning/self-benchmark.js` · 벤치마크 관례 위치는 리포 루트 **`_benchmarks/`**(`runtime-eval-comparison.md`, 시나리오 8건 기존) — 문서의 `plugins/artibot/benchmarks/routing/` 대신 `_benchmarks/routing/` · **매 프롬프트 메모리 주입이 현행 기본값**(`runtime-prompt.js:340-346`, `ARTIBOT_RUNTIME_MEMORY_DISABLE` 로만 끔) → 문서 §16 Hindsight 결론("매 턴 주입이 no-memory 보다 나쁠 수 있음")이 **현행에 직접 적용**되며, 그 env 플래그가 곧 A/B 스위치다 · `.artibot/generated/` 부재 · `docs/…v1.1/` 이 24항목(문서 추가분).

### 8.2 판정표 (개념별)

| 절 | 문서 요구 | 통합 설계 v1 | 판정 · 반영 |
|---|---|---|---|
| §0·§27·§67 | 원칙 + Final Switching Architecture(Router → Switch Controller{transition economics, cache affinity, residency, cooldown, failure, profile} → PIN/SWITCH/ESCALATE → Route Receipt → Attempt → Attempt Receipt) | §3.2 5모듈(router·switcher·escalation·hysteresis·profile) | **채택** — `model-switcher.js` = Switch Controller, `route-hysteresis.js` = Switch Economics 의 Cost 항. 결정 어휘 `route|pin|switch|escalate|downgrade` 를 원장 `route.selected.decision` 값으로 확정 |
| §28 | SwitchBenefit − SwitchCost > threshold (Benefit: quality·future cost·latency·failure / Cost: serialization·rebuild·cache loss·handoff·latency·reorientation·retry) | §3.2 CacheLoss 추정식만 | **확장 채택** — 7항 Cost 를 `route-hysteresis.js` 출력 `terms{}` 로. 영수증 전에는 측정 가능 항만 채우고 나머지 `measured:false`(§3.5 ParallelGain 과 같은 규칙) |
| §29·§30 | Routing Epoch(모델/컨텍스트 연속 구간, "Score per Action, Switch per Epoch"), minimum residency 3 / cooldown 2(RouteBench 로 보정), 즉시 승격 예외 5종 | 없음(§3.2 는 "액션 경계마다") | **채택 + 호스트 제약 명시** — Claude Code 에서 실행 중 모델 전환은 미확인이므로 **Epoch 의 실효 단위 = 스폰(서브에이전트 1개 또는 `/team` phase 1개)**. 액션 단위 채점은 기록만, 전환은 다음 스폰에서. `routing_epoch_id` 를 원장 봉투 선택 필드로. residency/cooldown 초기값은 문서 값 그대로 두되 "미보정" 표기 |
| §3·§40 | Route Receipt 스키마(current/recommended/selected, decision, predicted, transition, reason[]) | §3.2 Observe 가 spawn-ledger 에 `recommendedModel·actionClass` 필드만 | **채택 — 하나로 합침**: Route Receipt = 원장 `route.selected` 이벤트의 `data`. 별도 파일 아님(Hardening §46 정본 1개). Observe 에서 `decision:'pin'|'route'` 만 발생(실적용 0), Canary 부터 `switch` |
| §4·§42 | Attempt Receipt = Run 단위(model_identity·usage·timing·outcome·cost) | §3.2 usage receipt(스폰 단위) + §7.2 "스폰 1건 = Run 1건" | **채택 — 동일 개체**: `usage.receipt` 이벤트 = Attempt Receipt. 필드는 문서 §42 스키마로 확정(`model_identity{provider,family,tier,model_id,version,catalog_version}` 포함). Success@1·Retry Waste·Escalation Rescue 는 이 fold |
| §20 | Exact Model Identity 필수(티어가 아니라 provider 모델 ID + catalog_version) | §3.2 "모델 ID(티어 아님)" | **이미 일치**, `catalog_version` 추가. 실측 원천은 트랜스크립트 `message.model` |
| §8·§41 | Context Receipt(input→transforms{dedup, tool_compression, history_trim, memory_add, project_knowledge_add}→output, protected_sections, cache{hit,created}, based_on) | 없음(vNext CX01 재주입 번들 + Hardening §22 based_on) | **채택(P1)** — `context.compiled` 이벤트 data 로. **첫 writer 는 기존 `lib/context/rehydration.js`(PostCompact 번들, ≤10KB)** 와 `pre-compact.js` — 단 `rehydration.js` 는 L2 이므로 원장 writer 를 **주입 포트**로 받는다(§1-8 은 신규 디렉터리만 열거했으나 기존 L2 모듈이 writer 가 되는 경우도 같은 규칙 — 크로스체크 반영). 문서의 `context-compiler.js` 는 그 위의 어댑터. "모델 문제 vs 컨텍스트 문제 분리" 가 채택 이유 |
| §6·§43 | Router Replay 를 정식 Core(Replay Store: metadata→IDs→usage→signals→hashes, bounded content opt-in), 백엔드 SQLite | 없음 | **조건부 채택** — Replay Store 는 **원장의 읽기 모델(인덱스)** 이지 두 번째 진실원이 아니다(Hardening §46). `lib/replay/` 는 ledger fold 를 action 단위로 재구성하고, 영속 인덱스는 재생성 가능 캐시. **백엔드는 OD-4 로 SQLite 아님** → StateStore 와 같은 JSONL/스냅샷 |
| §7 | Replay 보안: redaction(키·토큰·쿠키·비밀), 역할별 접근 | Hardening §25 redaction 재사용, §41-42 스키마만 | **이미 일치** — `guard-registry.js#SECRET_CONTENT_PATTERNS` 재사용, 역할 접근은 P2 |
| §13·§46 | Offline Replay 3모드 EXACT/PARTIAL/SIMULATED, 라벨 필수, "가짜 절감을 실값처럼 표현 금지" | §3.6 shadow 줄 | **채택** — verification-discipline 3등급(실측/추론/미확인)의 라우팅판. Scorecard·RouteBench 출력에 라벨 강제 |
| §11·§12·§44·§45 | RouteBench: 기준선 B0 Fixed Sonnet·B1 Fixed Opus·B2 현행 v4 정책·B3 v5 정적·B4 v5 적응(+B5 Fable·B6 hindsight), task class 13, 지표 17, 재실행·완료쌍 skip | 없음(레인 1 eval jsonl, 레인 4 seeded-defect) | **채택(P1)** — 위치는 OD-3 로 **둘로 가른다**(크로스체크: `_benchmarks/` 는 `.gitignore:15` 로 미추적이라 통째로 두면 Shadow 대조군이 로컬에만 남는다): **시나리오·픽스처·기준선 정의는 추적** `plugins/artibot/tests/evals/fixtures/routebench/`(레인 1 eval jsonl 과 같은 자리), **실행 결과·리포트는 로컬** `_benchmarks/routing/`(기존 `runtime-eval-comparison.md` 관례). B2 "현행 v4 정책" 기준선이 곧 §3.2 Shadow 의 대조군. 레인 4 seeded-defect 7축은 `high_risk_review` class 의 픽스처. 단일 composite score 금지·raw 보존 — 규율 §9 와 일치 |
| §14·§57 | 학습 순서 Heuristic→Receipts→RouteBench→Shadow→Replay→Canary→Production, online RL 금지, Learner 가 보안·비밀·파괴 경계·사람 승인 경계를 수정 못 함 | §3.6·§4 는 Shadow→Canary 만; RouteBench·Replay 는 §8 에서 처음 생김; "online RL 금지"·"Learner 수정 금지 경계" 문장 없음 | **확장 채택**(크로스체크 재분류) — 순서에 RouteBench·Replay 단계 삽입, "Replay before learning" 을 §4 Shadow 종료 조건에, **Learner 불가침 4경계**(보안 정책·비밀 처리·외부 파괴 경계·사람 승인 경계)를 §3.6 학습기 계약에 명문화 |
| §16·§47 | Mission Reflection: 매 턴 retrieval 금지, 미션 경계에서만 reflect(트리거 5종), Knowledge Package 를 Epoch 동안 캐시 | 없음 — **현행은 매 프롬프트 메모리 주입**(§8.1 실측) | **채택 + 현행 결함 등재** — Observe 에서 `ARTIBOT_RUNTIME_MEMORY_DISABLE` A/B 로 주입 유무 × accepted 를 측정한 뒤(분모 필요) Shadow 에서 미션 경계 reflect 로 전환. 레인 6 메모리 승격(§3.6)의 **읽기 쪽 짝** |
| §17·§48 | Generated Project Knowledge(`.artibot/generated/{architecture,conventions,known-failures,active-initiatives}.md`, `generated:true canonical:false` frontmatter, 삭제 후 재생성 가능) | 레인 3 파생 파일 금지 | **조건부 채택** — v1.1 "파생 파일 금지" 는 *정본 후보* 파일에 대한 것이고, frontmatter 로 비정본을 선언한 재생성 산출물은 HANDOFF 렌더 뷰와 같은 등급. 조건: **로컬(gitignore)** + `artifact-governance` 검사 #6 에 `generated:true` 예외 + Hardening §45 "고유 질문" 검토 통과(4파일 각각 답하는 질문이 project.md·ADR 과 겹치지 않는지 — **미검토**, 결정 G3) |
| §19 | Human Corrections / Decisions / Approvals 3분리, 자율 KPI = Corrections per Accepted Outcome | §3.6 `human.asked/resolved` | **확장 채택** — `human.resolved{kind: correction\|decision\|approval}`. **writer 비대칭(크로스체크 정정)**: `human.asked{gate:HG-nn}` 는 **훅이 쓴다**(`pre-bash`/`pre-write` 가 block 하는 바로 그 지점에서 원장 append — 모델 협조 불필요, 지금 가능). `human.resolved` 만 모델이 `AskUserQuestion` 답을 받은 직후 기록. 이러면 "히트(훅 기록)는 있는데 resolved(모델 기록)가 없다" 가 **탐지 가능한 비대칭**이 되어 §3.4 완료 조건에서 잡힌다. 양쪽을 모델에 맡기면 기록 누락 시 게이트가 아무것도 못 본다 |
| §21~§26·§49~§52 | Checkpoint: Store 추상화(`save/load/latest/list`), 의미 있는 전이에서만(task.completed·epoch.completed·plan.revised·human_decision·before_high_risk·`/save`), 완료된 idempotent Action 결과 재사용, **불변성 테스트 P0**(load→mutate→reload→원본 불변), single-writer = Mission Controller | vNext DR01 미착수, Hardening §12-13 Resume 계약 | **채택** — vNext DR01 의 스펙으로 편입. `lib/checkpoint/` 신설(§1-8 레이어 등록). 백엔드 OD-4(문서의 SQLite 아님). 불변성 테스트는 `tests/firewall/checkpoint-immutability.test.js`. "이전 모델 무조건 복원 금지, 재평가" 는 Resume Contract 에 1줄 추가 |
| §31 | `/save` = Flush artifacts → Task Graph → State → Epoch → Checkpoint → Validate resume → Ledger → Snapshot Scorecard | 레인 3 "/save = checkpoint + HANDOFF 렌더" | **확장 채택** — 순서 확정, 마지막 두 단계(HANDOFF 렌더 + Snapshot Scorecard)는 둘 다 투영. 오늘의 `handoff-store` 추적 보호는 그대로 |
| §32~§35·§54 | Session ≠ Mission, Progress 100% = 실행 완료(≠ 미션 완료), 완료 표시 4줄(Execution/Review/Verification/Outcome) 후 Final Scorecard, Snapshot/Final/Project 3레벨 | `team.md` Phase 3.5 진행률 바, §3.4 outcome.md 강제 | **채택** — 진행률 바 100% 뒤에 "Running independent review…" 단계와 4줄 완료 블록을 **`team.md`·`autopilot.md`·`split.md` 5캐리어 공통 렌더**로(보고 계약과 같은 parity 게이트 대상). Final Scorecard 는 `outcome.md` 생성과 같은 트리거(§3.4)에서 렌더 — 파일이 없으면 스코어카드도 없다 |
| §36·§38·§37·§39 | Scorecard = Receipt 들의 투영(삭제·재생성 가능), Avoided Switch(사유 분류: cache affinity / low benefit / residency), Useful/Wasteful Switch 사후 판정, 모델별 KPI(Usage share 만 보지 않음, Fable 은 "고가치 판단에 썼는가") | `lib/planning/scorecard.js`(현행 별도 파일 `scorecard.json`), 레인 3 M12 "scorecard 는 ledger 이벤트로" | **채택 — 현행 대체** — `scorecard.json` 파일 폐기, `lib/scorecard/` 가 원장 fold 로 렌더. Avoided Switch 는 Observe 부터 계산 가능(추천≠정책 스폰 = pin 사유 있는 회피) |
| §53 | 커맨드 `/score …`, `/why model` | A5 결정(기존 표면 확장) | **덮어씀(문서 양보)** — `/score` 는 **기존 `/scorecard` 와 충돌** → `/scorecard --session\|--project\|--models\|--routing` 확장, `/why model` 은 `/doctor` 하위 또는 `/scorecard --routing --why`. 문서 §53 자체가 "기존 registry 와 충돌 확인 후 확정" 이라 했으므로 위반 아님 |
| §63 모듈 트리 | `routing/`(11파일, escalation 과 downgrade 분리) · `context/` · `telemetry/` · `replay/` · `checkpoint/` · `scorecard/` · `review/fable-reviewer.js` · `runtime/{progress-controller, completion-gate}.js` · `benchmarks/routing/` | §3.2 5파일, §1-8 레이어 규칙 | **부분 채택** — 신규 디렉터리 `replay/`·`checkpoint/`·`scorecard/` 는 채택(L2 순수 + 포트, 등록 필요 → §1-8 목록 8→11). `telemetry/` 는 만들지 않는다(attempt/usage receipt writer 는 `economics/usage-receipt.js` 하나 — 이중집계 금지 §3.6). `downgrade-controller.js` 분리는 **거부**(§3.2: 01§13 "복잡성은 존재 증명" — escalation-controller 분기로 시작, RouteBench 가 필요를 보이면 분리). `fable-reviewer.js` 는 레인 4 `independent-reviewer.js` 와 중복 → 만들지 않음. `completion-gate.js` 는 §3.4 outcome.md 생성기 = `artifact-lifecycle` 핸들러와 동일 개체 |
| §9·§58 | Cross-model KV cache reuse 는 Watch only, GA 를 online RL·재귀 에이전트 생성·무제한 debate·provider 은닉 캐시 해킹에 의존시키지 말 것 | Hardening §36 은 재귀 깊이 상한 하나뿐 | **확장 채택**(재분류) — GA 비의존 목록 5종을 §4 GA 행의 제외 조건으로 명문화, `model_capabilities.cache_transfer{supported:false, mode:'none'}` 스키마 필드 예약(추가이므로 "일치" 아님) |
| §64 | Data Flow — Final(NL→Intent→Profile→Reflection→Context→Receipt→Action→Router→Recommendation→Switch Controller→Receipt→Epoch→Execution→Attempt Receipt→Verifier(fail→repair/escalation)→Fable Review→Completion Gate→Outcome→Scorecard→Replay→RouteBench→Shadow) | §1 + Hardening §47 | **일치** — Hardening §47 다이어그램의 상위집합. 차이는 Reflection·Receipt·Replay 단계 추가뿐이고 전부 §8.2 에서 채택 |
| §65 | Terminal UX 원칙 — 사용자는 모델 전환 시점을 몰라도 되고, 완료 후 "어떤 모델이 얼마나·왜 바뀌었고·이득이었나" 만 본다("Routing is automatic. Performance is inspectable.") | Hardening §38 관측 항목 12, A5 | **일치** — §32~§35 스코어카드 3레벨이 실체. 오너 보고 형식(사용자 관점) 과 같은 방향 |
| §66 | 저자 우선순위 "신규 추가 7개": Route Receipt·Context Receipt·Attempt Receipt·Router Replay·RouteBench·Mission-boundary Reflection·Checkpoint immutability | — | **7/7 채택** — 리더가 본문을 읽어 확인(§3·§8·§4·§6·§11·§16·§25 행). §8.3 이 양보시킨 5곳(SQLite·독립 Replay 저장소·`/score`·중복 모듈 4·벤치마크 위치)은 **이 7개와 겹치지 않는다** → 저자 우선순위와 충돌 없음 |
| §55 P0 15 · §56 P1 · §57 P2 | Exact identity·Epoch·Switch Controller·Cost/Time·Receipt 3·Usage·Replay·Snapshot·Final Scorecard·Checkpoint/Resume·불변성·Fable binding·Completion Gate | §4·§7.3 | 8.4 재사상 |

### 8.3 통합 설계와의 충돌 해소 (문서가 양보한 5곳)

1. **저장 백엔드** SQLite(§43·§49) → OD-4 JSONL + StateStore 인터페이스. SQLite 는 어댑터 자리만.
2. **Replay Store = 독립 저장소** → 원장의 읽기 모델(재생성 가능 인덱스). 정본은 `ledger.jsonl` 하나.
3. **`/score` 신설** → `/scorecard` 확장(충돌 실측).
4. **`telemetry/`·`downgrade-controller.js`·`fable-reviewer.js`·`completion-gate.js` 신설** → 기존 설계 개체와 중복이라 만들지 않음(위 §63 행).
5. **벤치마크 위치** `plugins/artibot/benchmarks/` → 정의(시나리오·픽스처·기준선)는 추적 `tests/evals/fixtures/routebench/`, 결과는 로컬 `_benchmarks/routing/`(미추적, `.gitignore:15` — 오너가 지금 열어 둔 `runtime-eval-comparison.md` 가 그 선례). OD-3 "설계 정본 추적 / 산출물 로컬" 의 적용.

### 8.4 로드맵 사상 (§55 P0 15 → §4 단계, 번호 = §55 항목)

| §55 항목 | 단계 | 근거 |
|---|---|---|
| #1 Exact Model Identity · #5 Route Receipt 스키마 · #6 Attempt Receipt 스키마 · #7 Context Receipt 스키마 · `routing_epoch_id` 봉투 필드 · `lib/{replay,checkpoint,scorecard}/` 레이어 등록 | **Phase 0** | 스키마·등록만 |
| #8 Usage Receipt(트랜스크립트 파서) · #5 Route Receipt 기록(`route.selected`, decision ∈ {route, pin}) · #2 Routing Epoch **기록**(스폰 = epoch) · #4 Switching Cost **추정치 기록**(measured:false 허용) · #9 Replay 읽기 모델 · #10 Snapshot Scorecard(`/save` 렌더 — `/save` 는 Observe 에 존재) · 메모리 주입 **계측만**(현행 기본값 유지, 토큰 규모·빈도 원장 기록 — A/B 는 행동 변화라 Shadow) · Avoided Switch 계산 | **Observe** | 전부 기록·투영, 행동 변화 0(크로스체크 정정: A/B·Final Scorecard 를 Shadow 로 이동) |
| #11 Final Scorecard(outcome.md 트리거 — `artifact-lifecycle` 이 §7.3 로 Shadow 에 있으므로 여기서 발화) · #12 Checkpoint/Resume(vNext DR01·DR02) · #13 불변성 테스트 · #7 Context Receipt writer · 메모리 주입 **A/B**(`ARTIBOT_RUNTIME_MEMORY_DISABLE`) · Mission Reflection(미션 경계 reflect) · Generated Knowledge(G3 후) · RouteBench + 기준선 B0~B4 · Replay EXACT/PARTIAL 라벨 · Human kind 3분리 · residency/cooldown 보정 | **Shadow** | 비교·복원 인프라 |
| #3 Switch Controller **실적용**(`switch` decision, 스폰 단위) · #14 Fable review binding(§3.4 assertIntentBinding) · #15 Completion Gate 강제 · Switch Efficiency KPI | **Canary** | 행동 변화, config 1키 |
| §57 P2(Shadow Learner·학습 임계·Canary Router·롤백·RouteBench CI·멀티리포·토폴로지 인지 평가) | **P2/GA** | — |

### 8.5 결정 갱신 · 신규 (G)

| # | 결정 | 권고 |
|---|---|---|
| G1 | Routing Epoch 의 실효 단위 — 스폰(호스트 제약) vs 액션(호스트가 실행 중 전환을 지원할 때) | **스폰**으로 시작. 재검토 트리거는 **I7(실행 중 모델 전환 지원 확인)** 이지 I4(alias 수용)가 아니다 — alias 수용은 "라우팅이 스폰에 전달되는가" 를, 실행 중 전환은 "스폰 안에서 바꿀 수 있는가" 를 가른다. 둘은 별개(크로스체크 정정, §3.2 (b) 분리) |
| G2 | 매 프롬프트 메모리 주입 기본값 — 유지 vs 미션 경계 reflect 로 전환 | Observe A/B(`ARTIBOT_RUNTIME_MEMORY_DISABLE`) 결과 후 결정. 그전 유지 |
| G3 | `.artibot/generated/` 4파일 도입 — 각 파일이 project.md·ADR·outcome 과 겹치지 않는 고유 질문에 답하는지 | Shadow 진입 전 Hardening §45 검토 1회, 통과분만 |
| G4 | RouteBench 기준선 B2 "현행 v4 정책" 의 정의 — `resolveModel` 2티어 그대로 | **채택**(그것이 Shadow 대조군) |
| G5 | residency 3 / cooldown 2 초기값 | 문서 값으로 시작, RouteBench 보정 전 "미보정" 표기 |
| A5 갱신 | `/why /cost /status` | `/scorecard` 확장 + `/doctor` 확장으로 **확정**(§53 충돌 실측) |
| D7 갱신 | `model.switched` 기록처 | Route Receipt(`route.selected{decision:'switch'}`) + `model.switched` 둘 다 원장, spawn-ledger 필드는 Observe 임시 |

### 8.6 미확인

- **외부 리서치·요약 절 11**(§8.1 과 동일 목록: §1·§2·§5·§10·§15·§18·§59·§60·§61·§62·§68)이 인용하는 vLLM Semantic Router 이슈 #2973/#2855/#2987/#2976, LLMRouter/xRouteBench(arXiv 2608.06867), Hindsight 0.9.x, Microsoft Agent Framework #7683 의 **존재·날짜·내용·라이선스를 리더는 검증하지 않았다**(웹 미조회). 그 자료에서 유도된 설계 요구 절(§4·§7·§8·§9·§11·§16·§17·§21~§25)은 판정 행에 있고, 판정은 자료가 아니라 통합 설계와의 정합만으로 했으므로 자료가 틀려도 §8.2 판정은 유지된다. 코드 편입 직전 LICENSE 재확인(§61) 은 그대로 규칙.
- **§8 크로스체크(architect, 15:16~15:24)의 유보**: 판정 행 58 개별 판정이 문서 본문과 맞는지는 architect 가 대조하지 않았다(내부 정합 6항목만). 리더는 본문을 전부 읽었으나 자기 판정을 자기가 검수한 것이므로 §66 7/7 채택 확인 외의 개별 행은 **교차 검수 미완**.
- 호스트가 실행 중 서브에이전트 모델 전환을 지원하는지(§6 기존 유보) — G1 의 전제.
- `runtime-prompt.js:340-346` 메모리 주입의 **실제 토큰 규모·빈도**(코드 경로만 확인, 라이브 분포 미측정).
- `lib/planning/scorecard.js`·`self-benchmark.js` 의 현재 소비처와 폐기 시 깨지는 참조 수(미열람).
- Switch Economics 7항 중 ReorientationRisk·ExpectedRetryCost 의 추정 방법(문서도 미정).
- Checkpoint "완료된 idempotent Action 결과 재사용" 의 유효성 판정 기준(based_on revision 일치 외 문서 미정).

## 9. 다음 단계 (오너 검토 후)

1. 오너가 §5·§7.4 결정(특히 A1·B1·B2·C1·D1·E1·F1~F3)과 추가 업데이트 요청을 준다.
2. 레인 4 v1.1 보강 반영 + Phase 4 크로스체크(architect ↔ reviewer 가 이 문서를 레인 원문·패키지·Addendum 과 대조) → 설계 v2.
3. 승인 후 Phase 0(정본 착지, 코드 0)부터 착수. 그 전까지 코드 변경·커밋 0. `.artibot/guides/v5-design/` 45+1 파일은 승인 직후 커밋(B8).

---

## 부록 0-2. 구축 세션(`ap-20260902-062936-tyc5j4`) 중 팀원 실측으로 드러난 설계 문서 정정 (리더 기록, 본문은 이 표가 이긴다)

| 위치 | 설계 v1 문장 | 실측 | 정정 |
|---|---|---|---|
| §0-1 L7 행 | 루트 `.artibot/*.md` 6개 | T-04 가 추적 4개를 `.artibot/archive/2026-06/` 로 이동 → 루트 `.artibot/*.md` 는 HANDOFF·SESSION-NOTES 2개 + `project.md`(T-02 신설) = 3개(2026-09-03 T-49 재확인; "6" 은 `ls` 기준 추적 4 + 미추적 2 라 모순 아님) | 그 행은 이동 **전** 관측. 추적 status 파일은 3이 아니라 **4**(stage-b-side-diagnosis 포함, planner P2) |
| §3.1 평가셋 | `evaluator.js:219` 인라인 케이스 | `lib/runtime/evaluator.js#DEFAULT_RUNTIME_EVAL_SCENARIOS` **:229**, 8시나리오(planner P8·T-47) | 229 |
| §3.1 평가셋 첫 케이스 | `substantive_signals:["S3","S5"]` | 그 프롬프트는 요청 1개·슬래시 없음이라 S3·S5 둘 다 안 켜짐(T-47) | **S1**(저장소 쓰기 기대, 도구 시점 확정) + 프롬프트 시점 `deferred` — §3.3 2단계 발급의 실례 |
| §3.1·§7.2 | `command_activation` "7불리언" | 불리언 6(plan·ultraplan·review·autopilot·autopilot_fast·split) + `skills[]` = 키 7(T-47, `package/03:75`) | "키 7(불리언 6 + skills)" |
| §3.2 | 가격표 "3배 불일치" | opus·fable 3×, sonnet 1×, haiku 0.8× — 균일 배수 아님(planner P9) | "두 표가 독립 관리, 교차검증 없음" |
| §3.2·§8.2 | split objective `wallclock_throughput` | 코퍼스 0건 — 레인 2 산문 조어(T-26). `cost_per_accepted_outcome`·`time_to_verified_outcome` 은 policy YAML 실재 | UNATTESTED 표기 유지, 결정 G6: split 도 `time_to_verified_outcome` + 가중치 차이로 갈지 |
| §3.2 | `execution_profile.performance` 허용값 근거는 06·15·04·정책 YAML | 진짜 enum 은 `package/schemas/mission-contract.schema.yaml`(:32·:37·:41)·`run-ledger.schema.yaml:17`·`package/02:53-63`(T-18 I2) | I2 대상 문서 목록 정정 |
| §3.1 confidence "4축" | 수치 4축 | `package/03:65-69` 는 수치 3(goal·scope·completion_expectation) + boolean 1 = 키 4(T-13) | "키 4" |
| §7.2 §7-8 / §3.5 | 상태 8종 = "v1.1 7종 + cancelled" | :198 투영표는 `claimed·done` 을 쓰고 v1.1 미션 7종(planning·completed)과 다르다(T-14) | 태스크 8종 = `queued|claimed|executing|blocked|reviewing|done|failed|cancelled`, 미션 7종은 별도 유지 |
| §1-8 | E-01 "L1 금지 열거에 `context`·`supervisor` 누락" | `context` 는 HEAD 에 이미 있었고 빠진 것은 `supervisor` 1건; 대신 L2 group 이 `handoff` 를 안 막는 같은 종류의 구멍 1건 추가 발견·봉합(T-10) | E-01 = supervisor 1 + handoff 1 |
| §7.1 | `lease` 0건 / `idempotency` 1파일 | landing-lock 은 이름 없는 TTL 리스(§7.1 정정 완료); idempotency 2파일 | 반영 완료 |
| PRD 전제 | "행동 변화 0 = 프롬프트 바이트 불변" | 헌법 단계 A 가 rules·commands 본문 편집이라 자기모순(planner P1) | **런타임 행동 불변**(스폰 모델·훅 차단 결과·기존 커맨드 출력 경로)으로 재정의 |
| §3.7 A-3 원문 | "훅·커맨드·스킬·lib 모듈은 릴리스마다 …" | 설계 축자문이 아니라 D18 재료로 리더가 구성한 문장(T-05) | 규칙은 유지, 출처 표기를 "D18 유도" 로 |
| §3.5 게이트 10행 | "DB 는 DDL 만" | `safety.js` 는 `DELETE FROM` no-WHERE(DML)도 잡음 | 반영 완료 |
| §8.2 §32-35 | "5캐리어" | 설계 명시 3(team·autopilot·split) + parity 게이트 CARRIERS 5; `sc·ultraplan` 은 진행률 바 마커 0건 → 미확인 등급(T-48). **`split.md` 도 마커 0건**(트레일러 표) | "캐리어 3 + 미확인 2", split 은 설계 명시만 |
| 세션 규칙 | — | 공유 워킹트리 **라이브 뮤테이션 금지**(T-48 뮤테이션 창이 리더 관측에 거짓 레드로 잡힘) | 전 레인 규칙으로 승격 |
| Hardening §6 | `plan.accepted→plan.md` | 어휘 36종에 `plan.accepted` 없음, `plan.revised{revision,mode}` 만(T-40 실측) | allowlist 가 정본 — plan.md ← `plan.revised`. `adr.*` 이벤트도 0건이라 ADR 핸들러는 B2 대기 |
| §3.5 규칙 1 | 계약에 `activation_suppressed_by:"explicit-command"` | 착지 스키마 `additionalProperties:false`, 해당 필드 없음(T-22) | Observe 동안 `compileMission().meta.activation_suppressed_by` 로 확정 |
| §3.1 템플릿 | intent.md `status: active`, text 정규화·span null 허용 | contract enum 7종에 `active` 없음; 설계 §3.1 은 verbatim 보존(T-23·T-12 실측) | 템플릿 `status: queued`, text = 원문 verbatim slice, span 필수·null 은 오류. 정본 검사기 `lib/mission/contract.js#verifyExplicitRequestSpans` |
| v5 §11 표 / OD-1 | HG-07 외부 시스템 쓰기 default `policy` | OD-1 "파괴·배포·외부쓰기·제품결정 = 항상 사람"(T-38) | OD-1 이 이긴다 — HG-07 `human`(policyRef 유지, note 로 승격 근거 기록) |
| §3.3 / §3.5 | topology-router 의 `humanGateHits` | 텍스트 매치라 `tools` 필터 미경유(config 경로 문자열에 HG-02·HG-13 동시 히트, T-38 실측) | 게이트 판정 정본 = 훅 계층 `human-gates.js#classify`; 라우터 hit 는 advisory, 결정에 사용 금지 |
| §3.6 / config `ledger.comment` | 4KB 초과 "evidence_refs 로 절단" vs "거부" | 두 문서 상충(T-20) | 2단: 비필수 data 접기 → 그래도 초과면 `ledger.rejected`; receipt 3종은 `additionalProperties:false` 라 접지 않고 거부 |
| §7.2 §25 | redaction 은 `guard-registry.js#SECRET_CONTENT_PATTERNS` 재사용 | 그 상수는 export 되지 않음(T-20·T-40 실측) | 원장은 `lib/learning/ledger/redact.js#redactSecrets`(기존 spawn-ledger 스크러버) 사용, 4형상 마스킹은 테스트로 고정 |
| PRD R-09 | 세션 fallback mission_id 발급자 = T-24 | 실제 소유·착지 = T-22 `lib/mission/mission-id.js`(T-22·T-24 양쪽 보고) | PRD 오기 — 코드 구멍 없음 |
| §3.2 / 02:58 | performance 어휘 `high-quality`·`maximum-performance` | T-18 스키마 enum 은 `quality`·`maximum_performance`, README :86-89 가 "매핑하라" 명시(T-24) | interpreter 가 스키마 철자 발행, `PERFORMANCE_PROSE_ALIASES` 로 매핑 |
| 레인 5 §1-D | `safety.js#RISK_PATTERNS` | export 명은 `DANGEROUS_PATTERNS`(`safety.js:18`, T-38) | 인용 정정 |
| 어휘 | `human.resolved` 는 `decision` 만 필수 | `question_id` 미선언 → ask↔resolve 짝짓기 불가(T-40) | T-15 에 선택적 `question_id` 추가 지시(17:08) |
| 레인 5 §2-D | worker `heartbeat_at := max(heartbeat, commit)` (괄호는 "assessLane 그대로") | `lane-monitor.js#assessLane:129-138` 은 우선순위(heartbeat 유한값이면 그것, 아니면 commit) — 본문과 괄호가 자기모순(T-46) | 우선순위가 정본(활성 판정기 둘 금지). T-46 반영 지시 17:11 |
| §3.5 / OD-4 F3 | StateStore 위치 = git-common-dir | 메인 트리에서 `git rev-parse --git-common-dir` 은 **상대경로 `.git`**, 링크드 worktree 만 절대경로(T-21, git 2.54 실측) | `path.resolve(projectRoot, commonDir, "artibot")` 로 해석. 절대 가정 시 CWD 에 스토어 생성 |
| 어휘 / §3.5 | `human.asked.question_id` 발급 형식 | 어느 정본에도 없음(T-15) | 리더 결정: `q-<sid8>-<sha256(gate|command)[:12]>`, 결정적(재차단 = 같은 id). T-39 구현 |
| §3.1 / §3.5 배선 | `task.meta.missionContract` 에 계약 기록 | `tests/runtime/middleware/tasks.test.js:165·:199` 가 `meta` 전체 객체를 고정(T-25) | 형제 필드 `task.mission{contract,mode,signals,substantive,deferred,ledger,ok}` — `meta` 바이트 불변. 컴파일러의 `mission-candidate-deferred`(설계 표기) → 원장 `mission.candidate_deferred` 는 fail-closed 맵 |
| §3.1 substantive | `mission.created` 가 주 경로 | 프롬프트 단계 미들웨어는 S3(요청≥2)·S5(슬래시 5종)만 공급 가능 — S4 confidence·S6 activeMission 미배선(T-25) | Phase 0 에서 나머지는 전부 `mission.candidate_deferred`. 발화율 분모 미측정 |
| §8.1 G1 | 라우터가 epoch 없이도 receipt 발행(`routing_epoch_id:null`) | route-receipt 스키마는 `routing_epoch_id` required·minLength 1(T-29 실측 `:69-73`) | 스키마 엄격 유지 — epoch 없는 receipt 는 append 불가. Observe writer 는 T-31 훅뿐이고 항상 `epoch = agentId` |
| §8.3 Replay | `loadReplay` 가 `lib/runtime/ledger.js#readAllEvents` 를 직접 호출 | L2→L5 import 는 eslint 하드 에러(`eslint.config.js:196-200`, T-41 프로브 실측); §1 포트 규칙 | `readEvents` 포트 주입, 누락 시 throw(fail-closed). 리더 지시가 틀렸음 |
| §3.6 writer | receipt 검증에 ajv 사용 가능(리포 내 해석됨) | ajv 6.x 는 eslint 전이 의존·미선언, `lib/` 외부 import 0건(T-20 실측) | `lib/runtime/ledger-schema.js` 의존성 0 서브셋 검증기 + 게이트에서 ajv 를 오라클로 13픽스처 대조(불일치 0). `allOf/oneOf/if` 는 런타임 미검증 명시. ajv devDependency 명시는 후속 |
| §3.5 question_id | `sha256(gate|command)` | gate 없음(hit 0)·짧은 session_id 표기 미정(T-39) | gate 없음 = `""`, sid 는 `slice(0,8)` 그대로(패딩 없음 — `sessionFallbackMissionId` 의 8자 미만 해시 대체와 표기 불일치, 기록만) |
| §1-8 | 신규 디렉터리는 "L2 순수 모듈" | 20여 모듈 중 17개는 `node:fs` 0; `project-state/{state-manager,journal}`·`economics/usage-receipt`·L4 `split-state` 는 저장소 소유라 fs 직접 호출(T-51) | 문언 교체: "포트는 상향 호출(L3/L4/L5)·config·시계·git 에만; `node:fs` 는 저장소 소유 모듈에 한해 직접 허용" — eslint 규칙이 이미 그렇게 동작 |
| §3.6 doctor | `reduce(ledger) ≟ state.yaml` 바이트 비교 | `state.updated.data` 는 `{state_version,status,reason}` 뿐이라 원장만으로 상태 재구성 불가; `reconcile.js` 는 store 저널로 재구성하고 원장은 `state_version` 집합 비교(T-51) | 불변식 교체: 원장 = `state_version` 수열 정본, store 저널 = 내용 정본, 검사 = ⊇ 방향 두 집합 비교 + 투영 바이트 비교(T-43 Check 8 이 그렇게 구현) |
| §3.6 어휘 | `worker.claimed/released` 와 `task.claimed/released` 4이벤트 | 사실 2개에 이벤트 4개, 계열 구분 근거가 spec 문자열뿐; split-state 가 두 계열을 섞어 씀(T-51) | 후속 결정 항목(소비자 0 인 지금이 가장 싸다) — Observe 에선 T-46 이 writer 입력 형태로만 고정 |
| §0-2 가격표 행 | "두 표가 독립 관리" 정정 완료 | `middleware/cache-roi.js:30,81-86` 은 model-catalog 를 참조한다고 적고 import 하지 않음, 교차 테스트 0(T-51) | "정정 완료" 아님 — Shadow 가격 단일화 항목에 cache-roi 명시 |
| §3.4 / C4 | Observe 는 unmeasured 를 카운트만 | `artifact-lifecycle.js:465` 첫 게이트가 unmeasured 1건이면 outcome 차단(단일 불리언, 층 구분 없음)(T-51) | C4 선점 해제: `opts.policy.unmeasuredBlocksOutcome`(기본 true) + `verify.completed.data.layer` 선택 필드 — T-40·T-15 지시 17:52 |
| §3.6 dedupe | 원장 중복 키 `(source,pid,seq)` | seq 는 프로세스마다 0 부터, 회전은 미션 단위 → pid 재사용 시 조용한 유실(T-51) | 키에 `session_id` 추가 — T-20·T-41 지시 17:52 |
| 검색 규율 §1 | — | `ledger.js:113`·`plan-repair.js:66`·`usage-receipt.js:446` 에 리터럴 NUL 구분자 → ripgrep 이 이후를 binary 로 잘라 35~65% 실명(T-51) | `"\0"` 이스케이프로 교체 지시. 규칙 추가: 소스에 제어 바이트 리터럴 금지 |
| §3.7 D18 Existence Audit | 훅·커맨드·스킬·모듈 발화 수를 원장에서 fold | 어휘 36종 중 그 **이름**을 담는 필드 0 — `source` 는 8종 카테고리, `tool.used.data.tool` 은 툴명(`Skill` 까지만), `intent.detected.data.type` 은 의도(T-44 전수) | Phase 0 결론 = 분모 부재. 카운터는 `unmeasured:no-event-carries-<kind>` 로 정직하게. Shadow 에서 carrier 필드 결정 필요(예: `tool.used.data.skill`) |
| CLAUDE.md:88 면제 목록 | 정본 1곳 | 사본 3벌: CLAUDE.md 원문 · `tests/firewall/existence-audit-section.test.js:55` · `lib/replay/existence-audit.js` 상수(T-44) | 후속: 공용 상수 승격(마지막 항목 표기 차이 `verification-discipline 전문` vs 부분문자열) |
| §1-8 `now` 포트 | 시계 포트 3계약(T-51 #6) | 실측(T-34): state-manager·split-state 는 이미 `() => Date`, unified-verifier 만 permissive; 다른 것은 **엄격도**(split-state 무언 폴백) | 계약 `() => Date` + 잘못된 형태 = TypeError 로 통일(T-34 반영, T-46 지시). T-51 #6 관측은 부분 오류 |
| §0-2 NUL 행 정정 | "이후 35~65% 실명" | ripgrep·grep 은 NUL 1바이트에 파일 **전체**를 binary 로 판정해 매칭 줄을 하나도 출력하지 않음(T-35 실측: `rg -n const` 1줄 vs `grep -an` 15줄) | 피해 = 파일 전체. 재발 방지 게이트 `tests/firewall/no-control-bytes.test.js`(T-32 구축 중). 유입 경로 미확인(셸 인용 접힘 추정) |
| §3.6:228 | `route.selected{source:"shadow", shadow_of}` | 봉투 `source`(발신자 8종, 훅=`hook`) 와 영수증 `data.source`(production/shadow) 는 **다른 필드**이고 공존이 설계 의도(T-31·T-15 실측). allowlist `route.selected.sources` 는 `["scheduler","hook"]` 로 확장(T-15) | 발신자 라벨 위조 금지 — 어휘가 사실을 따른다. 리더가 두 필드를 합쳐 낸 주석 정정 지시는 T-31 이 거부, 명시적 분리 블록으로 대체 |
| PRD T-19 title | common-meta "4조각 예약만" | 착지 11 `$defs`, 예약만 원칙(루트 검증 0·`$ref` 0) 준수(T-49) | title 대체됨 — NOTE |
| PRD 소유권 | T-07 `ultraplan.md`·T-11 `config-schema.js`/`model-catalog.js`/`model-catalog-version.test.js`·T-20 `ledger-schema.js`·T-37 `decision-events.js`·T-40 `artifact-lifecycle-gates.js`·T-46 `split-state-sources.js`·T-32 `lib/planning/scorecard.js` | affectedPaths 밖 착지(T-49 #4·#5 + 800줄 게이트 분할 승인분) | 커밋 전 정본 JSON 소유권 갱신 대상 — 전부 리더 승인 |
| 세션 기록 | `lib/replay/__layer_probe.js` | 17:51 존재(T-49 `git status`) → 18:05 전후 T-41 삭제 → 18:06·18:08 부재(리더·T-49) | 시점 관측 3건 정합, 제3의 사건 없음 |
| 의존성 | ajv | eslint 전이 의존(6.x, 미선언)을 `tests/firewall/ledger-vocab-allowlist.test.js` 가 오라클로 사용(T-20) | 후속: `devDependencies` 명시 선언(package.json 리더 소유, 락파일 갱신 필요해 커밋 시점) |
| §3.6 dedupe / T-41 | `(session_id,pid)` 그룹핑 | seq 카운터의 진짜 범위는 프로세스 인스턴스 — 한 프로세스가 두 session_id 로 쓰면 없는 구멍을 지어냄(T-41 거울상 위험, 현재 writer 3곳은 세션 1개) | 후속: 봉투에 process-instance id 도입 검토 |
| 세션 기록 | — | 2026-09-02 18:28 팀원 14명 세션 한도(21:30 리셋) 중단 → 09-03 09:05 전원 idle 생존, 재개. 중단 구간 디스크 변경 0(`find -newermt`) | 한도 리셋 후 같은 에이전트 재개(재스폰 0). T-50 수리 10건은 09:05 이후 착지 |
| §1-8 계층 / T-10 | "topology 는 autopilot 을 import 하므로 L2 불가"(리더 근거) | `lib/autopilot` 은 **L2**, L2→L2 는 형제 import(T-10 실측). topology 의 lib 간선 5개 전부 L2 이하 | L4 유지 근거를 "합성 계층 + 오늘 비용 0 + L2 모듈이 split-state 를 필요로 하는 순간 배치 재검토" 로 교체. 리더 근거는 오류 |
| §3.4 verifier | "throw 는 잘못된 `now` 뿐" | 순환 evidence 로 id 스탬프 `JSON.stringify` 가 throw(T-50 #3) | 필드 단위 `[unserializable]` 대체 + `warnings[]` 신설 + 반환 `evidence[]` 도 직렬화 가능형(T-34) |
| §3.6 writer | "NEVER THROWS" | 순환 `data` 로 `redactDeep` RangeError(T-50 #2) | `WeakSet`/depth 가드 + 조립부 try/catch → `{ok:false, reason:"writer-exception:*"}`(T-20, 착지 대기) |
| §3.5 StateStore | "보증은 CAS — 조용한 덮어쓰기 없음" | `expectedVersion` 생략 시 검사 없음(옵트인, T-50 #4) | Phase 0 옵트인 유지 + 헤더 사실화 + 생략 시 `warnings:["cas:skipped"]`(T-21). 호출자가 버전을 들면 기본값 반전 |
| 어휘 / 02:57 | completion 7종 정본 1곳 | `mission-id.js` 사본 `"pr"` 소문자 드리프트 + `artifact.js:91` 세 번째 사본(T-50 #5·T-22) | interpreter 를 정본으로 재수출 + `toBe` 참조 동일성(T-22 완료, T-23 지시) |
| 게이트 진실성 | — | `artifact-governance` 예외 키 무앵커(#6)·`command-output-invariance` 필터 무앵커(#7)·`usage-receipt-schema-guard` 항진명제+무음 skip(#8)(T-50 직접 재현) | 카디널리티 앵커·명시 실패 전환. skip 된 적합성 테스트는 통과와 같은 green — 파이어월에서 skip 금지 원칙 |
| CLAUDE.md:80 Quality Gates | "files < 800, functions < 50" | 기계적 강제 0 — `max-lines` 미설정, CI 스크립트 0(T-50 §2). 신규 `lib/` 800 초과 1건(`intent/artifact.js` 1,347 유예), 테스트 800 이상 다수 | 후속: 현 위반자 명시 래칫 베이스라인 게이트(`tests/firewall/`). 이번 세션은 분할 4건(T-20·T-37·T-40·T-46)으로 대응 |
| §3.7 nl-activation | 픽스처 형식 검증만("lib/mission 미착지") | `compileMission` 착지(T-50 §8) | 10 케이스 실제 실행 대조 지시(T-47, 해상도 10%p 명시) |
| 부록 자체 | — | 부록 0-2 :582 에 리더 삽입 스크립트가 남긴 리터럴 NUL 1바이트(T-52 실측; control-byte 게이트는 `.artibot/` 밖) | 09:12 이스케이프. 후속: 게이트 root 에 `.artibot/guides` 추가 검토 |
| §4 Observe 종료조건 / 설치 | 훅 착지 = 기록 시작 | 훅은 `${CLAUDE_PLUGIN_ROOT}` = 마켓플레이스 미러(`~/.claude/plugins/marketplaces/artibot/…`, 09-02 13:37, 241줄)에서 실행; `~/.claude/artibot/` 은 statusline 용 flat 설치본(12:42). 둘 다 정지 → Phase 0 훅 3종 실행 0회, 스폰 원장 라우팅 필드 0/119(T-51 2차 + T-42 정정, 리더 10:04 실측) | Observe 측정은 릴리스 + `claude plugin marketplace update`/`plugin update` 반영 뒤부터(`sync:local` 은 flat 만). "파일 있다·테스트 통과" ≠ "실행된다"(규율 §2) |
| §1-2 `ledger ⊇ store` | state-manager 는 원장 거부 시 store 쓰기 포기 | 거부 판정이 `appended === false` 뿐인데 writer 는 `{ok}` 만 반환 → 실제 경로에서 원장 실패 = 성공으로 오판, 페어링 게이트 스텁이 `{appended}` 형태라 못 봄(T-51 2차 A·A′) | 술어 `throw || ok===false || appended===false`(split-state `ledgerRefusal` 과 동일) + 스텁 형태 교정 + 실제 writer 1케이스(T-21) |
| §1-8 시계 포트 | `readClock` 정본 = unified-verifier | 무가드 `now()` 2곳 잔존(`state-manager:306`·`event-writer:348`); L5 가 verification 에서 시계를 빌리는 모양은 어긋남(T-51 2차 B·②) | `lib/core/clock.js` 로 이전(재수출 유지) + 두 곳 채택을 한 변경으로(T-34·T-20·T-21). 이전 조건 = 소비자 수가 아니라 간선 모양 |
| §3.6 Observe 기록 거처 | 중앙 원장 하나 | `route.selected.sources` 는 `hook` 추가로 원장에, `topology.selected.sources` 는 `[scheduler,supervisor]` 그대로라 T-37 은 `runtime/decisions/` 사이드 채널로 — 레인별 우연(T-51 2차 C) | Shadow 후속: hook 이 정당 발행자인 이벤트는 sources 확장, 아니면 전부 사이드 채널 — 한 규칙 |
| §3.3 / §3.6 | 모든 writer 는 projectRoot 주입 | `decision-events.js:135` 기본 기록 위치 `<pluginRoot>/runtime/decisions/` → 설치 플러그인에서 모든 프로젝트 세션이 한 디렉터리에 섞임(T-51 2차 D) | Shadow 후속: 기본값 projectRoot 또는 줄에 프로젝트 식별자 필수 |
| §1-8 topology 계층 | L4 등록 근거 = 라우터가 cognitive plan 을 소비 | 실 간선 전부 L2 이하; 디렉터리에 L4형(router)과 L2형(split-state) 혼재(T-10·T-51 2차 ①) | L4 유지 — 근거는 "설계상 의존 상한(입력 정본 = `buildWorkflowPlan` 결과)", 현재 간선이 아님. 혼재는 기록만 |
| §1-2 (2차 수리) | — | 옛 술어 `appended===false` 는 실제 writer 실패 3종(`line-too-large`·`no-project-root`·`invalid-envelope`)을 전부 성공으로 읽음(T-21 실측 4경로 대조) | 술어 `throw || ok===false || appended===false`; 페어링 게이트가 실제 `writeEvent` 2케이스 포함; 스텁 기본 형태 `{ok}` |
| §1-8 시계 (2차 수리) | — | `readClock` 정의 `lib/core/clock.js`(L1, import 0, 기본 label `clock`), `unified-verifier` 는 재수출 + 명시 label; 채택 4곳(verifier·split-state 직접·event-writer·state-manager) | 판정기 1개. event-writer 는 비함수 `now` 를 무음 벽시계 대체 → `ok:false` 로(행동 변화, 호출자 도달 0 — tasks.js 는 Date 반환 래퍼) |
| 검수 방법 | 동결 = 소유자 "추가 작업 없음" 보고 | 2차 검수 창(09:28~)에 리더가 T-51 수리(clock 이전 등 13파일 09:45~09:52)를 다시 배분 — 1차와 같은 실수(T-49·T-50 2차 §0) | 규칙: 검수 착수 후 그 대상에 수리를 배분하지 않는다. 이동분은 3차 부분패스로 재검 |
| 코드 내 설계 인용 | `ARTIBOT-5.0-DESIGN.md:NNN`·`design:NNN` 라인 앵커 | 97건/distinct 36 중 9종이 현 본문과 불일치(`:253` 표 구분선, `:259` 빈 줄 등), 오프셋 불규칙 — 쓰인 시점부터 틀림(T-49 2차 #1; 1차 "46건 전부 정확" 철회) | 라인 앵커 → §헤딩 앵커 일괄 교체(T-53, 주석만). 규칙: 코드에서 문서를 인용할 때 줄번호 금지 |
| §3.2 가격표(코드 주석) | `usage-receipt.js:39-42` "~3x disagree" | 부록 정정(불균일 0.8~3.0×) 이 코드 주석에 안 내려옴(T-49 2차 #5) | T-32 주석 정정 |
| §3.6 writer 성능 | `redactDeep` "TERMINATES ON ANY INPUT" | path-scoped 순환 가드는 공유 서브트리 DAG 에서 2^depth(depth 22 → 2.9s, T-49 실측); 4KB cap 이전에 실행되어 못 막음 | 객체별 memo(WeakMap) 로 O(n), 순환은 in-progress 집합(T-20) |
| 소유권 추가(2차) | — | T-37 `lib/observability/decision-events.js`(+221 → **+289/-0, 11:34 재측정**; `runtime-prompt.js` +92/-14)·T-52 `plugins/artibot/README.md`(+3/-3) 는 affectedPaths 밖 — 리더 승인 확장(T-49 2차 #2·#4) | 커밋 전 소유권 기록에 포함. PRD 부록 A 는 :337 에서 "정본 아님" 강등 상태(#12) |
| 문서 주장 | `commands/scorecard.md:80` "writer 미배선이라 unmeasured 가 정상" | 훅 3곳 배선 착지 — 비어 있는 이유는 설치본 미반영(T-49 2차 #3) | T-42 문장 정정 |
| §3.6 writer 성능(수리) | — | memo(`WeakMap`) + in-progress 순환 집합: 공유 DAG depth 22 2,733ms → 0.94ms(T-20), 리더 프로브 0.2ms; 출력 8종 바이트 동일; 깊이-잘린 서브트리는 memo 제외 | 작업량 O(객체). 200ms 상한 테스트는 이 머신 기준(CI 미측정) |
| T-49 2차 #10 | topology-router 테스트 "8 comparisons" 문구·추가 방향 미검출 | 문자열 리포 전역 0건, `:854-855` 단언 실재(T-36 실측, 리더 grep 확인) | **철회** — 검수측 오류(출처 미확인) |
| 코드 인용 규칙 | 줄번호 인용 | T-25 자기 파일 12건 중 7건 stale(리더 지시의 `:132·:210` 도 썩어 있었음) → 심볼·JSON 포인터·테스트명으로 전량 교체 | 규칙은 리더 지시문에도 적용 |
| §4 Observe / `/scorecard` 문서 | "writer 미배선이라 unmeasured 가 정상" | writer 3곳 배선 착지; 비어 있는 이유는 설치본(마켓플레이스 미러) 미반영(T-42 정정, 헤더 3곳 동반) | "배선 ≠ 실행 ≠ append" 3단 구분을 문서에 명시 |
| 코드 내 설계 인용(수리) | — | T-53: 93 occurrences/35 distinct + bare 3 = 96건, 32파일, MISMATCH 10종/14건(T-49 9종 + `:500`), 잔여 라인 앵커 0(리더 10:13 grep) | 형식 = 기존 관례 `design §x.y`(판정표는 행 라벨 병기). 코드 인용에 줄번호 금지 규칙 확정 |
| 검수 방법(2) | mtime 정지 = 동결 | 2차 검수 창에 T-53 sweep(32파일) 도 겹침 — 3회 연속 붕괴(T-50 2차 §0) | 규칙 확정: **검수 착수 후 리더 배분 0**(수리는 대기열, 보고 도착 후 일괄). 불변 스냅샷은 미추적 95건이라 worktree 불가 — 커밋 후부터 가능 |
| §3.3 T-37 관측성 | 실패는 세어진다(`getDecisionRecorderStats`) | `stats` 는 프롬프트마다 죽는 훅 프로세스의 모듈 객체, 비테스트 호출자 0 — 세어도 아무도 못 본다(T-50 2차 §3). 프로덕션 0행의 실제 원인은 설치본 정지(리더 10:19: 워킹트리 token-usage 는 10:16 검수 프로브 1회) | 대기열: stats 를 decisions 줄 또는 stderr 로 영속 |
| §3.2 T-31 | 라우팅 필드는 추측 대신 skip | `subagent-handler.js:325-326` `phase` 가 `derivePhase` null 을 `"build"` 로 날조, 단언 0(T-50 2차 §4) — 6필드 중 유일한 fail-open | 대기열: null 유지 + skip 사유 + 단언 |
| CHANGELOG | receipt `applied:false` | route-receipt 는 `additionalProperties:false`, `applied` 필드 없음 — 실제 기제는 `source:"shadow"`; `applied:false` 는 model-switcher 객체(T-50 2차 §4) | 대기열: T-52 문구 정정 |
| 의존성(2) | ajv 명시 실패 3파일 | 같은 skip 패턴 8곳 잔존(review-verdict-adapter·mission-contract·review-output·state-task-lease·execution-profile×2·contract-ajv-crosscheck·adaptive-router 테스트)(T-50 2차 #8) | 대기열: T-54 sweep + `devDependencies.ajv` 선언(커밋 준비) |
| §1-8 eslint 근거표(2) | split-state → verification 엣지 | clock.js 추출로 그 엣지는 `../core/clock.js` 로 이동 — T-10 이 방금 고친 표가 다시 낡음(T-50 2차) | 대기열: T-10 재정정. 교훈: 근거표에 간선 목록을 적으면 간선이 바뀔 때마다 썩는다 → 규칙 문장만 |
| 코드 내 인용(2) | 설계문서 앵커만 대상 | 코드→코드 라인 인용(`x.js:N`) 잔존, `doctor-checks.js:30` 의 `eslint.config.js:154-207` 은 T-10 주석 확장으로 이미 낡음(T-51 3차 P3-1, 패턴 204 히트 중 픽스처 오탐 포함) | 대기열: 2차 sweep(코드 인용은 심볼명, 픽스처 데이터 제외). 규칙 일반화: 어떤 파일이든 줄번호 인용 금지 |
| §1-8 eslint 근거표(3) | 간선 5줄 열거 | 09:08 표는 `split-state-sources.js`(supervisor 간선) 를 열지 않아 **썩기 전에 이미 불완전**했고, 09:52 clock 이동으로 다시 낡음(T-10 자기 실측) | 간선 목록 삭제, 불변식 문장만("전부 L2 이하, cognitive/learning 0; 최신 목록은 코드가 정본") |
| T-50 2차 BLOCK §1 | "T-37 프로덕션 0행 = 기록기 결함" | 미러 훅은 v4.52.0 체크아웃(08-28 판 `runtime-prompt.js`, recorder 호출 0); 워킹트리 `token-usage-session.json` 10:16 requestCount 1 = 검수 프로브(T-50 자기 철회, 리더 10:19·10:25 실측) | 원인 = P2-0 설치본 정지. mtime 은 "누가 실행했나" 를 구분 못 함 — 카운터 영속(T-37 대기열) 이 오진과 결함의 같은 뿌리 |
| 검수 방법(3) | "검수 집합 밖 파일은 배분 가능" | 3차 검수 중 집합 밖 3파일 배분 → 그중 1개가 검수 REPAIR 대상, 브리프는 전 트리 이동을 BLOCK 으로 정의(T-49 3차) — 3회 연속 리더 책임 | 규칙: 검수 열린 동안 배분 0(집합 안팎 불문) + 착수 전 전 레인 편집 동결 통보(착수·종료 시각 명시) |
| 코드 내 인용(3) | 리더 grep 범위 `lib schemas tests scripts` | `commands/doctor.md:280·292·358` 에 약식 `design:253/259/95` 3건 잔존 — 전부 2차 MISMATCH 앵커(T-49 3차 #1) | T-53 2차 sweep 범위에 `commands/ rules/ skills/` + 코드→코드 인용 추가 |
| 소유권 추가(3) | — | T-37 `tests/observability/decision-events-t37.test.js` 도 affectedPaths 밖(T-49 3차 #2) | 리더 승인 확장 기록 |
| §3.7 nl-activation 면제 | `UNSCORED_CASES` id 배열 | 사유 없이 id 1줄 추가로 채점 분모가 자동 축소(T-49 3차 #3) — `KNOWN_DIVERGENCES` 는 cause 길이 강제 | 대기열: id→reason 객체 + 사유 길이 단언 + 분모 명시 상수 |
| §3.6 redaction memo | 마커는 경로 사실 | memo 가 `[circular]` 마커를 포함한 서브트리를 형제 위치에 재사용 → 그 위치에선 역방향 간선이 아님(T-49 3차 #7) | 대기열: 마커 포함 서브트리 memo 제외(depth 절단과 동일 규칙, T-20) |
| §3.4 route-receipt 문서화 | CHANGELOG "receipt(shadow, `applied:false`)" | `applied` 는 receipt 필드가 아님(`additionalProperties:false`, writer 거부). shadow 기제 = `source:'shadow'`+`shadow_of`; `applied:false` 는 `model-switcher#proposeSwitch` 반환 리터럴 — 두 층 분리(T-52, 2026-09-03 10:3x) |
| §3.5 replay 집계 | `totals.input` / existence-audit `ledgerLines` | 둘 다 `readAllEvents` 생존자 수(손상·거부·필터·중복 제거 후) — `received`/`eventsReceived` 로 개명, 원본 줄 수는 리더 소관(T-41 착지, T-44 배분) |
| §1 시계 | `unified-verifier.js` `readClock` 재수출 | 프로덕션 importer 0 + 재수출 고정 테스트 1. 유지(마켓플레이스 배포본 존재, 제거는 Phase 0 밖) — 리더 판정 2026-09-03 10:4x |
| §2.4 StateStore 포트 계약 | JSDoc "throw 또는 `{appended:false}`" | `{ok:false}` 도 거부, `undefined` 는 성공 — 판정 정본 `state-manager#ledgerRefusal`, split-state 와 동일 술어(사본 2개, 공용화는 후속)(T-21·T-46) |
| §3.3 recorder stats | 카운터 프로세스 메모리에만 | `flushRecorderStats` 가 `runtime/decisions/<runId>` 또는 `_unattributed` 에 `recorder-stats` 1줄(둘 다 0 이면 무음, `failed>0`=warn, `skipped`만=info). 부작용: 실 root 에 쓰는 기존 훅 스위트 5개 가시화 → 셋업 격리 배분(T-37) |
| §3.6 redaction 예산 | depth 상한(`MAX_REDACT_DEPTH=64`)만 | 순환을 품은 공유 서브트리는 memo 불가 → 경로별 재순회(depth 16 에서 19ms, 레벨당 ×3, 4KB cap 이전 단계라 cap 이 못 막음). 모양 무관 **결과 노드** 상한 `MAX_REDACT_NODES=4096`(memo 재사용 시 서브트리 size 차감) + `[budget]` 마커. 리더 최초 지시 "방문 기준" 은 T-20 반증(memo 가 DAG 을 돌려주면 `JSON.stringify` 가 트리로 되펼침 — 49객체 386MB, 3.6s; 예산도 4KB cap 도 못 봄) 으로 폐기. 근거 "4096 노드 최소 직렬화 `{}` > 4KB" 는 결과 노드 기준에서만 참. depth 200 까지 상수 시간, writer e2e 26ms(T-20 착지 2026-09-03 10:55, 701/701) |
| 문서 규율(인용) | `file:line` 인용 허용 | 세션 중 동시 편집으로 리더·팀원 인용 다수가 썩음(T-47 95줄 밀림, T-46 5건 중 2건, T-53 census 결함 11) → 코드·테스트·스키마·커맨드의 코드→코드 인용은 **심볼명·테스트명·JSON 포인터**로, 줄번호는 픽스처 데이터·산문 출현 위치(`README.md:1565` 류)·게이트가 파싱하는 상수(`EXEMPT_LINE_NO`)에만 — 리더 판정 2026-09-03 |
| 테스트 격리 | 훅 스위트가 실 plugin root(`CLAUDE_PLUGIN_ROOT`) 로 실행 | 실 `runtime/` 오염(`token-usage-session.json`, `decisions/_unattributed`) → /doctor 헬스 신호 오염. 오염원 실측 3개(`runtime-prompt`·`silent-fail-stderr`·`userprompt-dispatcher`) + `tests/e2e/runtime-flow` 1개 — 링크 샌드박스(lib·commands·skills·agents symlink + config 복사) 셋업만 적용, 단언 0 변경(T-37, 2026-09-03 10:5x). 리더 최초 목록 5개는 오염원 아님(심볼명 grep 오탐) |
| §2.4 refusal 술어 | (판정) | `ledgerRefusal` 사본 2개는 진실원 분열이 아니라 "불변식 1 · 집행자 2" — 둘이 갈리면 한 경로에서만 `ledger ⊇ store` 성립(2차 A 형태). 공용화 전 드리프트 테스트 1건이 다리(T-51 4차 APPROVE, 2026-09-03 11:16) |
| §3.3 decisions 사이드 채널 | 어휘 자유 | 어휘 5종(`routing-classified`·`workflow-planned`·`topology-recommended`·`memory-injection-measured`·`recorder-stats`), writer 단일(`decision-events.js`) 이라 allowlist 없음 허용 — **두 번째 writer 가 생기면 fail-closed allowlist 필수**(T-51 P4-2) |
| §3.6 예산 근거 | 상수 4096 리터럴 핀 | 정당화는 config `line_max_bytes` 와의 관계(2바이트×4096 ≥ 캡). 캡 상향 시 리터럴 테스트는 통과하며 근거만 거짓 → 관계 단언으로 전환 후속(T-51 P4-1) |
| 부록 0-2 행수 표기 | 리더 브리프 "307행" | 파일 전체 표 행(310) 을 부록 행으로 오기 — 부록 실제 108 데이터행(:536~:646). 수치를 박을 때 재현 명령·시각 병기(T-49 4차 NOTE 1, 2026-09-03 11:36) |

### 부록 0-2 후속. 오너 결정 (2026-09-03 확정)

**결정자: 오너 · 결정일: 2026-09-03 · 기록: 리더 경유 팀원 반영(이 세션).**
아래 14건 + 부가 2건은 그 전까지 §5 「결정 필요 항목」·§7.4·§8.5(G 계열) 및
`reports/AUTOPILOT/ap-20260902-062936-tyc5j4.md` §5 에 **미결**로만 남아 있던 항목이다.
이 절이 해당 항목의 정본이며, 본문·§5 의 "대기/잠정" 표기보다 이 표가 이긴다.
**결정 문구는 오너 원장을 그대로 옮긴 것이고, 기록자의 해석·보완을 더하지 않았다.**
「재결정 조건」열은 오너가 근거 열에 적은 유보를 조건문으로 옮긴 것이며,
**오너가 특정하지 않은 임계·표본 수는 그 자리에 `미확인` 으로 적었다**(추측으로 메우지 않음).

> **오너 메타 결정(2026-09-03 16:3x)** — 이후 결정 처리 규칙:
> "이후 결정은 **설계 정본(§5·§3.3) 우선 → 권장안** 순으로 리더가 처리하고 **기록만** 한다.
> 질문은 정본에도 없고 권장안이 갈리는 **신규 방향**에만."
> (오너 원문: "권장사항으로 처리해줘. 이미 내가 추구하는 바에 대해서는 맨처음 설계안에 다 적어줬던 것 같아")
> 이 규칙은 위 B2 3라운드에서 얻은 교훈과 같은 방향이다 — 정본이 이미 답을 갖고 있으면 그것이 이긴다.

| ID | 오너 결정 (2026-09-03 확정) | 근거/단서(오너 제시) | 재결정 조건 |
|---|---|---|---|
| A1 | blindspot 자동수정 **금지** — 제안(dry-run diff)까지만 생성, 적용은 사람 승인 후 | 오너 상시 원칙: 설계안 먼저, 적용은 승인 후 | 없음(원칙 결정) |
| B2 | **최종 확정(2026-09-03 2차 재확인).** ADR 을 **`.artibot/adr/` 로 단일화** — 설계 정본을 따른다. 경위: 원안 "루트 `docs/adr/` 단일화" → (루트가 추적되지 않음이 실측돼 철회) 1차 재질의 "`plugins/artibot/docs/adr/`" → **그 1차 근거였던 "플러그인 경로만 추적된다" 가 오판임이 드러나 2차 재확인에서 `.artibot/adr/` 로 최종** | 리더 실측 2026-09-03 16:0x(기록자 재현 확인): ① `git check-ignore -v .artibot/adr/ADR-001.md` → **exit 1(무시되지 않음 = 추적 가능)** ② `.gitignore:116` 이 추적 정본 목록에 **`.artibot/adr/` 를 명시** ③ 대조: 루트 `docs/adr/` 만 실제로 무시된다(`git check-ignore` → **exit 0**, `.gitignore:19` `/docs/`) — `plugins/artibot/docs/adr/` 와 `.artibot/adr/` 는 **둘 다 exit 1 로 추적 가능** ④ 설계 정본 2곳 + 파이어월 게이트 2곳이 원래부터 `.artibot/adr/` 를 가리켰다 | **없음 — 확정** |
| C4 | **`deterministic` 만 필수**, 나머지 층 선택. `unmeasuredBlocksOutcome=true`(fail-closed) 유지 | 현행 `DEFAULT_REQUIRED_LAYERS` 선례를 정본 승격 | 없음 |
| G1 | `routing_epoch_id` = **스폰 단위(agentId)** 확정, 스키마 required 유지 | 라이브 원장 0건 — Shadow 실측 후 재결정 가능한 값 | **Shadow 단계에서 라이브 원장 실측(현 0건)이 확보되면** 재결정 가능. 어떤 관측이 뒤집기 조건인지는 오너가 특정하지 않음 — `미확인` |
| G2 | 매 프롬프트 메모리 주입 = **계측만 유지, 기본값 무변경** | 라이브 표본 n=1 은 판단 근거가 아님 | 라이브 표본이 **n=1 을 넘어 판단 가능한 규모로 축적되면** 재결정. 필요 표본 수·판단 임계는 오너 미특정 — `미확인` |
| G3 | `.artibot/generated` **도입 보류** | 소비처 0 — YAGNI | 소비처가 **1 이상** 생기면 재검토(근거의 대우) |
| G4·G5 | hysteresis 3/2·2 및 refusal 임계 **값 그대로 유지 + `UNCALIBRATED` 명시** | 근거 없는 값을 근거 있는 값으로 오인시키지 않기 위함 | **보정에 쓸 실측이 확보되면** 값 재결정 + `UNCALIBRATED` 표기 해제. 어떤 측정이 보정 자격인지는 오너 미특정 — `미확인` |
| G6 | `wallclock_throughput` **`UNATTESTED` 유지 · 소비처 0 유지**(대시보드/보고서가 읽지 못하게) | 미검증 수치가 다음 착시의 근거가 되는 것을 차단 | attestation 확보 전까지 **소비처 추가 금지**. 확보 시 재검토 |
| G-1 | `performance.priority` **정규화 함수 도입 → 8값 허용목록(enum) 대조**, 미지값 거부 | 부정 목록 아닌 허용목록 | — |
| review.independent | **config 키 신설 + 기본 `true`**(독립 검수 필수, fail-closed) | 키 부재로 인한 조용한 비활성(fail-open) 차단 | — |
| fixture `substantive` 스테이지 한정자 | **확정(권장안, 2026-09-03).** 스테이지 한정자 추가 — `substantive_stage: 'execution'`(어휘 출처 `compiler.js` JSDoc `@param input.stage` 의 `'prompt' 또는 'execution'` 합집합, 리더 인용 `:508` 확인), `KNOWN_DIVERGENCES` 에서 `split-upgrade-fidelity` **1건 제거**, 나머지 2건은 call-shape 아티팩트라 무관 | evidence 실측: divergence 3건 중 이 값에 걸리는 것은 1건뿐. 이전 "보류" 사유였던 "3건의 정체 미확인" 이 해소됨 | **없음 — 확정.** apply 이행 완료(`tests/evals` 93/93, 16:21). 기록자 재확인: `nl-activation-fixture.test.js:625-630` 이 제거 사유를 주석으로 남기고 있고 `split-upgrade-fidelity` 는 `KNOWN_DIVERGENCES` 에 없다 |
| interpreter cue `시간이 중요` | **추가하지 않음.** T-36 드리프트 게이트의 기대값을 **현행 어휘에 맞춰 고정**해 불일치 해소 | Phase 0 대원칙 "런타임 행동 불변" | — |
| planner 병렬화 | **설계안 먼저**, 구현은 승인 후 | 별도 팀원이 설계안 작성 중(결정 시점) | 설계안이 오너 승인을 받으면 구현 착수 |
| `runtime/decisions/` 기본 위치 | **projectRoot `.artibot/runtime/decisions/` 로 변경**(T-51 D 승격). 폴더 트리 정리도 함께 승인 | `claude plugin update` 가 pluginRoot 를 교체하면 KPI 분모 소실 위험 | **이행 완료 2026-09-03** — checker-config APPROVE. Check 7 소비처 5곳(`router.js:57` · `tasks.js:342` · `runtime-prompt.js:616,622,626`)에 cwd 주입, `doctor.md:131` 갱신, **이관 로직 없음**(라이브 0건이라 옮길 데이터가 없다). 기록자 재확인: `decision-events.js:90` `DECISIONS_REL=['.artibot','runtime','decisions']`, `getDecisionStoreDir` 가 projectRoot → `resolveProjectRoot(cwd)` 순 해석(리더 인용 `:89` 는 JSDoc 줄, 실제 상수는 `:90`) |
| receipt 위치 (2026-09-03 16:3x) | 라우팅 shadow receipt 를 **PreToolUse(Agent) 로 이관 + `prompt_id` 브릿지**. **설계안 먼저**(구현은 승인 후) | SubagentStart 페이로드에 action text 가 **없다** — 호스트 2.1.259 바이너리 스키마는 `agent_id`·`agent_type` 뿐(INCIDENT `§F10`). 따라서 `skipped:no-action-text` 14/14 는 **결함이 아니라 정확한 동작** | 설계안이 오너 승인을 받으면 구현 착수. 설계안 **`ROUTE-RECEIPT-PRETOOLUSE-DESIGN.md`(144줄)** — 요지: **2단계 기록**(PreToolUse `route.selected{stage:'pre'}` + SubagentStart 신규 `route.bound`), allowlist **36→37**, 되돌리기 스위치 `routing.observe.receiptStage`. 근거 문서: `INCIDENT-2026-09-03-hook-payload-contract.md` §6.2 |
| ensureADR 하드코딩 (2026-09-03 16:3x) | `docs/adr` 하드코딩을 **지금 수리** — 기존 ADR 디렉터리 탐색 → 폴백. **"코드는 설계안" 원칙의 명시적 예외**(안 고치면 다음 `/plan --adr` 이 B2 를 되돌린다) | apply 미결 #1 | **없음 — 확정.** 기록자 실측: **이미 착지했다**(`artifacts.js` 워킹트리 수정분, `kindDir(projectRoot,'adr')` + `resolveAdrDir` 탐색·폴백 구현). 남은 `docs/adr` 2곳(`:161` 탐색 목록, `:208` 비-Artibot 리포 폴백)은 **의도된 것**이라 하드코딩 잔존 아님 |
| effort 디렉티브 경로 (2026-09-03 16:3x) | **판정 완료(2026-09-03 16:5x) — (나) 호스트 2.1.259 는 훅 stdout 최상위 `user_prompt` 를 읽지 않는다.** 따라서 `user_prompt` 봉투 전체(effort 디렉티브 · System 1 mode · memory context · guardrail · `message`)가 **모델에 닿은 적이 없다.** 후속 **결정(권장안 채택 — 오너 미질의, 메타 결정 규칙 적용)**: `hookSpecificOutput.additionalContext` 로 이전 | effortpath 실측 `PROBE-effort-directive-delivery.md`(**126줄**, 기록자 실재·행수 확인): 출력 스키마 `Xbr` = `continue`/`suppressOutput`/`stopReason`/`decision`/`reason`/`systemMessage`/`terminalSequence`/`hookSpecificOutput` 뿐이고 파서가 스키마 밖 키를 "unrecognized keys (ignored)" 로 버림(리더 바이너리 grep 재확인) · 공식 hooks.md "UserPromptSubmit can't replace the prompt; only injects additionalContext" · 라이브 트랜스크립트 사용자 턴 4건 중 `[artibot:effort` **0건** | 설계안 `DESIGN-UPS-additionalContext-migration.md` **승인 후 구현**. 기록자 실측: 그 설계안은 **실재한다 — `DESIGN-UPS-additionalContext-migration.md` 207줄**(17:1x `wc -l`. 앞선 "부재" 표기는 17:0x 시점 관측이었고 그 사이 착지 — **해소**). **팀원 디렉티브 경로는 생존** — 리더가 Agent 프롬프트에 직접 쓰는 `team.md:107-120` 경로는 훅 stdout 을 거치지 않는다 |
| (부가) 반영 범위 | **문서 + config 를 먼저 반영**, 코드 변경 4건은 설계안으로 받아 **승인 후 구현** | — | — |
| (부가) census JSON | 스크래치패드의 `citation-census-20260903.json` 을 **리포 안으로 보존** | 재스캔 비용 > 보관 비용 | — |
| payload 키 (2026-09-03 16:2x, AskUserQuestion) | **지금 수리 — 키 추출을 넓게 통일** (오너 선택지 원문: "지금 수리 — 키 추출을 넓게 통일 (권장)"). **"코드는 설계안" 원칙의 명시 예외 3번째**(ensureADR · decisions 경로와 같은 등급). 이행: `lib/core/hook-utils.js#extractUserPromptText`(호스트 2.1.259 키 `prompt`) + `#extractUserPromptFlagSurface`(`--no-team` 회귀), 소비처 7 + 3훅, 호스트 형태 픽스처 8 + RED 증명. checker-payload APPROVE ×2. 커밋 `bc2e9e55` | 안 고치면 Shadow 분모가 0 이다: SubagentStart `route_ledger skipped:no-action-text` **10/10** + UserPromptSubmit 산출물 3종 라이브 **0**. **⚠️ 릴리스 영향 고지**: 이 수리로 UserPromptSubmit 5훅(auto-team · autopilot-nlu · command-suggest · ambiguity-guard · runtime-prompt)이 **2026-02 이후 처음 라이브 발화**한다 — Phase 0 "행동 변화 0" 대비 **행동 변화 있음**(의도된 복구) | 라이브 `runtime/decisions/` 적재 **≥1** 확인 후 닫힘 |
| §7 NECESSARY 3건 (2026-09-03 16:1x, AskUserQuestion) | **F-01 지금 · F-30/F-10 은 설계안** (오너 선택지 원문: "F-01 지금 · F-30/F-10 은 설계안 (권장)"). F-01 = `npm run release` 체인 순서 — 이행 `abff392d`. F-30 = `DESIGN-F-30-ledger-line-census.md`, F-10 = `DESIGN-F-10-control-byte-gate-artibot-guides.md` **승인 대기**(둘 다 실재 확인) | triage 실측: `package.json:46` 의 `&&` 체인이 `release:check` exit 2 로 **항상 첫 단계에서 끊김**, `RELEASE.md:24-28` 이 이미 올바른 순서를 문서화하고 있었다. 기록자 재확인: `package.json:46` 은 현재 `"release": "npm run sync:local && npm run release:check && npm run ci"` — **sync:local 이 앞으로 이동한 수리 반영 상태** | **없음 — 확정** |

**각주 — `F-01` 은 §5 결정 ID 가 아니다.** `RELEASE.md:35` 의 "corrected in the script (2026-09-03, decision F-01)"
는 **위 「§7 NECESSARY 3건」 행**을 가리킨다. `F-01`·`F-10`·`F-30` 은 **triage(planner) ID** 이지
§5 결정 항목 ID(A1·B2·C4·G1… 계열)가 **아니다** — 두 번호 체계를 같은 것으로 읽지 말 것.
같은 이유로 `F-10`·`F-30` 설계안 파일명(`DESIGN-F-10-…`·`DESIGN-F-30-…`)의 `F-` 도 triage 계열이다.

**각주 — payload 키 수리가 후속 13(`--no-team` 회귀)과 같은 뿌리다.** `hook-utils.js:287` 의 탐색 순서는
`['user_prompt', 'prompt', 'content']` 로 **`user_prompt` 가 여전히 첫 번째**다(기록자 실측). 이것은 버그가
아니라 의도된 것이며, `:301` 주석이 그 이유를 적고 있다 — 리라이터가 덮어쓴 본문을 CLASSIFY 에는 써야
하기 때문이다. 그래서 **원문 표면을 봐야 하는 플래그 검사용으로 `extractUserPromptFlagSurface` 를 따로
만든 것**이다(`:319`). 즉 R1 의 두 함수는 한 쌍이고, 후속 13 은 이 쌍이 도입되기 전의 결함이다.

**보존 위치 기록(부가 2번 이행)**: `.artibot/guides/v5-design/evidence/citation-census-20260903.json`.
오너 지시의 문자 그대로라면 `reports/` 아래였으나, `.gitignore:73` 이 `reports/*` 를 제외하고
`!reports/SPLIT/` 만 재포함한다(`reports/AUTOPILOT/` 는 현재 **untracked**) — 즉 `reports/` 에 두면
git 에 보존되지 않아 결정 취지("재스캔 비용 > 보관 비용")를 달성하지 못한다. 그래서 이 설계 정본
바로 옆의 **추적되는** 경로에 두었다. 원본은 스크래치패드에 그대로 남겨 두었다(복사).
실측 표기: **rows 349 / 4,927 lines**(133,693 B). 349 는 파일 행수가 아니라 잔여 occurrence 수(`postEditTotal`)다.

**B2 보충 근거(기록자 확인, 2026-09-03)**: 파이어월 픽스처
`plugins/artibot/tests/firewall/fixtures/artifact-governance.exceptions.json`(`check2_canonicalPairs`, `.artibot/adr` 는 :24)
의 `measuredState` 필드가 **이미 같은 사실을 기록하고 있다** — "측정 시점 `docs/adr/` 는 추적 0건(.gitignore:19
`/docs/` 가 통째로 ignore). 추적 계열은 plugins/artibot/docs/adr 하나뿐". 나아가 같은 픽스처의 `reason` 은
통합 방향을 **`.artibot/adr/` 쪽으로**("플러그인 5 → `.artibot/adr/ADR-001~005`, 루트 5 → ADR-006~010 재번호")
적어 두었다 — 즉 `docs/adr/` 단일화와 **반대 방향**이다. 또 `plugins/artibot/tests/firewall/gitignore-boundary.test.js:109`
의 `TRACKED_PATHS` 에 `.artibot/adr/ADR-0001.md` 가 들어 있어, 이 게이트는 `.artibot/adr/` 가 추적 경로임을 전제한다.
**→ 최종 확정(2차 재확인): `.artibot/adr/`. 위 픽스처 `reason` 과 게이트 `TRACKED_PATHS` 는 처음부터 옳았다 —
갱신 대상이 아니다.** (1차 재질의에서 잠시 `plugins/artibot/docs/adr/` 로 확정됐다가 근거 오류가 드러나 뒤집혔다.
경위는 아래 「B2 결정 경위」 참조.)

**이 문서 자체의 기존 기록도 같은 방향이다(기록자 확인)**: §3.3 이행 매핑표는 ADR 2계열을
"플러그인 `docs/adr` 5 추적 + 루트 `docs/adr` 5 **미추적**" 로 이미 적고 목표를 **`.artibot/adr/` 한 계열**로
두었고(`#이행-매핑표` ADR 2계열 행), §5 결정 항목 B2 의 원문도 "ADR 정본 계열·위치 — **`.artibot/adr/` 통합**,
플러그인 5 이동 + 루트 5 재번호" 다. 즉 **설계 정본 2곳 + 파이어월 게이트 2곳 = 4곳이 모두 `.artibot/adr/` 를
가리키며, "`docs/adr/` 로 단일화" 는 그 4곳과 반대 방향이다.** 오너 원장의 B2 문구가 이 사실을 전제로
작성된 것인지 확인되지 않아 재질의 대상이 되었다. 1차 재질의는 `plugins/artibot/docs/adr/` 로 갔으나
**2차 재확인에서 `.artibot/adr/` 로 최종 확정**됐다 — 즉 **이 4곳은 처음부터 최종 결정과 일치했고 갱신이 불필요하다.**

**시점 관측(2026-09-03 15:46, 기록자 — 상태 단정 아님)**: B2 재질의가 진행 중인 동안 **다른 세션/팀원이
ADR 을 실제로 옮기고 있다.** 15:45:23 mtime 으로 `plugins/artibot/docs/adr/ADR-006~010` 5파일이 생겼고,
이는 루트 `docs/adr/ADR-001~005` 와 **같은 문서의 재번호본**이다. 다만 루트 `docs/adr/` 6파일은 **그대로 남아
있고**(즉 이동이 아니라 복사 상태), `.artibot/adr/` 는 **존재하지 않는다**. 이 시점 트리는 같은 ADR 5건이 두
곳에 중복된 상태다 — 작업이 진행 중일 수 있으므로 "중복을 남겼다" 로 단정하지 않는다. 확정된 것은
`git ls-files plugins/artibot/docs/adr/` = **5**(신규 5건은 미추적)뿐이다. **후속(2차 재확인 후)**: 이 진행 중 작업의 목적지 `plugins/artibot/docs/adr/` 는 **1차 재질의 결정을 이행하던 것**이고,
그 결정이 뒤집혔으므로 **최종 목적지(`.artibot/adr/`)와 다르다.** 즉 ADR-006~010 은 최종 결정 기준으로는
중간 산물이다. 최종 이동·정리는 **별도 팀원(apply)** 소관이며, 이 기록자는 ADR 파일·게이트를 건드리지 않았다.
관측 자체(루트 6파일 잔존 = 이동 아닌 복사 상태)는 그대로 기록해 둔다.

**B2 결정 경위 (3라운드 — 왜 두 번 뒤집혔는지)**

| 라운드 | 결정 | 뒤집힌 이유 |
|---|---|---|
| 원안(오너 원장 최초) | 루트 `docs/adr/` 로 단일화 | 전제 "루트가 추적된다" 가 실측으로 깨짐 — `.gitignore:19` `/docs/` 가 통째 제외. 그대로 갔으면 ADR 이 버전관리 밖으로 나갈 뻔했다 |
| 1차 재질의 | `plugins/artibot/docs/adr/` | **근거 오류**: "플러그인 경로만 추적된다" 는 `git ls-files` **개수**(플러그인 5 / `.artibot/adr/` 0)에서 추론한 것인데, `.artibot/adr/` 의 0 은 **디렉터리가 아직 없어서**지 무시돼서가 아니다. **추적 파일 0건 ≠ 추적 불가.** 또 이 라운드의 선택지 설명에 "4곳이 `.artibot/adr/` 를 가리킨다" 는 관측이 포함되지 않았다 |
| **2차 재확인 (최종)** | **`.artibot/adr/`** | `git check-ignore` 로 **무시 여부를 직접 측정**: `.artibot/adr/` exit 1(추적 가능), `plugins/artibot/docs/adr/` exit 1, 루트 `docs/adr/` exit 0(무시). 둘 다 추적 가능하므로 "유일하게 추적된다" 는 성립하지 않고, 설계 정본·게이트 4곳이 가리키는 `.artibot/adr/` 가 최종 |

**남은 교훈(기록자)**: `git ls-files` 는 *이미 추적 중인 파일*을 세고, `git check-ignore` 는 *추적 가능 여부*를 판정한다.
아직 존재하지 않는 경로에 대해 전자로 후자를 주장하면 이번처럼 뒤집힌다. 이 부록의 초기 B2 근거 문장
"`git ls-files plugins/artibot/docs/adr/` = 5 — 실제 버전관리되는 ADR 계열은 여기뿐" 도 **문자 그대로는 참이지만
추적 *가능성* 의 근거로는 쓸 수 없었다** — 그 문장이 1차 재질의의 오판으로 이어졌다.

**B2 최종 확정에 따른 기존 기록 상태 (기록자 실측 — 대부분 해소됨)**

| # | 위치 | 내용 | 최종 결정과의 관계 |
|---|---|---|---|
| 1 | `plugins/artibot/tests/firewall/gitignore-boundary.test.js:109` | `TRACKED_PATHS` 에 `.artibot/adr/ADR-0001.md` | ✅ **해소 — 원래대로 맞다.** 조치 불필요 |
| 2 | `plugins/artibot/tests/firewall/fixtures/artifact-governance.exceptions.json` | `pending_decision: "B2"`(:23), `reason` 의 "플러그인 5 → `.artibot/adr/ADR-001~005`"(:24) | ⚠️ `reason` 의 이동 방향은 ✅ 맞다. **남는 조치는 `pending_decision:"B2"` 해제 1건뿐 — apply 팀원 담당** |
| 3 | 이 문서 §3.3 이행 매핑표(ADR 2계열 행) | 목표 = "`.artibot/adr/` 한 계열" | ✅ **해소 — 최종 결정과 일치** |
| 4 | 이 문서 §5 결정 항목 B2 | "ADR 정본 계열·위치 — `.artibot/adr/` 통합" | ✅ **해소 — 최종 결정과 일치** |

**B2 후속 3건 (apply 미결 · 코드 아님 — 기록만)**

| # | 항목 | 내용 | 성격 |
|---|---|---|---|
| 1 | `docs:check` 스코프 490 → 479(**-11**) | `validate-doc-links.js` 가 **리포 루트 `.artibot/` 을 훑지 않는다** → ADR 링크 썩음을 게이트가 영영 못 본다. B2 로 ADR 이 `.artibot/adr/` 로 가면 **ADR 링크 전체가 게이트 사각지대**로 들어간다 | 후속(설계) |
| 2 | `.gitignore:38-39` `!plugins/artibot/docs/adr/` 재포함 2줄 | B2 이행 후 빈 경로를 가리키게 된다 — 무해 | 후속 정리 |
| 3 | `.artibot/guides/PRD-SPLIT-CROSS-SESSION-MULTI-WORKTREE.md` 자기 갱신 | 그 문서 `:283-289` 가 "B2 이행 시 이 절과 frontmatter `linked_adrs` 를 함께 갱신할 것" 을 **스스로 요구**한다 | 문서(기록자 처리 — 아래) |
| 4 | `plugins/artibot/scripts/hooks/tool-tracker.js:352` **와 `:444`** | `case Task:` **2곳** 이 스폰 도구명을 옛 이름으로 읽는다. 도구명이 **`Task` → `Agent`** 로 바뀌어 두 분기 모두 `default` 로 빠진다 — `:352` 는 `input.subagent_type` 로 `delegate:<type>:subagent` 를 만들고, `:444` 는 결과 점수를 매긴다. 기록자 실측: 같은 파일에 `case Agent` **없음**(= 낡은 키 확정). **라이브 도달 여부는 미확인** | 후속(코드) — **별도 결정 불필요.** 권장: PreToolUse 이관 설계안(`ROUTE-RECEIPT-PRETOOLUSE-DESIGN.md`) 구현 시 함께 정리 |
| 5 | `plugins/artibot/tests/observability/decision-events-t37.test.js:31` | 주석의 "real `<pluginRoot>/runtime/decisions/`" 가 stale — 결정 D 로 경로가 projectRoot 로 바뀌었다. **테스트 동작은 무관**(storeDir override 로 돈다) | 후속(코드) — 다음에 그 파일을 편집할 때 함께 |
| 6 | `.artibot/guides/NEXT-SESSION.md:61`·`:74` | 두 줄이 `<pluginRoot>/runtime/decisions/` 를 적고 있었다 — 크로스머신 요지본이라 다음 세션이 먼저 읽는다 | 문서 — **기록자 갱신 완료**(경로 정정 + 결정 D 각주) |
| 7 | `.artibot/project.md:122`·`:170` | 두 줄이 "두 계열 병존 · 통합은 결정 B2 대기" 로 적고 있었다 — `ARTIBOT.md` 읽기 순서 1번 정본 | 문서 — **기록자 갱신 완료**(단일 계열 `.artibot/adr/` 로) |
| 8 | `plugins/artibot/commands/team.md:74` · `plugins/artibot/lib/cognitive/effort-policy.js:20-26` | 두 곳이 프롬프트 디렉티브를 **"유일한 실경로"** 라고 단언한다 — effort 판정으로 **틀린 문장이 됐다**(훅 stdout 최상위 `user_prompt` 를 호스트가 읽지 않는다). 기록자 실측: `team.md:74` 원문 "…붙이는 것이 **유일한 실경로**다", `effort-policy.js:20-26` 주석 "HOW THIS MAPPING ACTUALLY REACHES THE MODEL". 참고로 `team.md` 는 근거로 `effort-policy.js:20-22` 를 인용하는데 주석 블록은 `:26` 까지다 | 후속(P2) — **`DESIGN-UPS-additionalContext-migration.md` 설계안에 포함**. 코드 아님 |
| 9 | `plugins/artibot/skills/persona-distill/SKILL.md:93` | 원문 `- ADR files under docs/adr/` — B2 로 거짓이 된 고정 문구(기록자 원문 확인) | 문서 — **처리 완료**(기록자 실측 17:1x). 현재 `:93` 은 고정 문구가 아니라 탐색 목록이다: "ADR files under the project's ADR directory (`.artibot/adr/`, `docs/adr/`, or `adr/` — …" |
| 10 | `plugins/artibot/docs/PRD-EFFORT-DYNAMIC-WORKFLOW.md:122` · `plugins/artibot/docs/PRD-LEARNING-ACTIVATION.md:81` | B2 로 깨진 ADR 포인터. 원문은 각각 "ADR: docs/adr/ADR-001-effort-workflow-fusion.md" 와 "…docs/adr/ADR-001…". **⚠️ 리더 인용은 `docs/…` 였으나 실제 경로는 `plugins/artibot/docs/…` 다** — 루트 `docs/` 에 그 두 파일은 없다(find 전역 0건). 또 새 정본 `.artibot/adr/ADR-001` 은 **구 플러그인 계열**이라 이 포인터가 가리키려던 대상과 번호가 우연히 일치한다 — 재번호 대상이 아님을 확인하고 고칠 것 | 문서 — **처리 완료**(기록자 실측 17:1x). 두 곳 다 `.artibot/adr/ADR-001-effort-workflow-fusion.md` 로 갱신됐고, **번호는 001 그대로**다(구 플러그인 계열이라 재번호 대상이 아니라는 위 경고가 지켜졌다). 리더의 "아직 미처리(17:0x)" 는 그 사이 착지로 해소 |
| 11 | `.gitignore:38-39` | `!plugins/artibot/docs/adr/` 와 `!plugins/artibot/docs/adr/**` 재포함 2줄. B2 이행으로 **그 디렉터리가 소멸**해 빈 경로를 가리킨다 — 무해. 기록자 실측: **2026-09-03 17:0x 기준 아직 존재** | 후속 정리 — **아직 미처리**(기록자 실측 17:1x: `:38` `!plugins/artibot/docs/adr/`, `:39` `!plugins/artibot/docs/adr/**` 그대로 존재). apply 재지시 대상 |
| 12 | `.artibot/runtime/decisions/_unattributed.events.ndjson`(리포 루트) — **cwd 폴백 오염 경로** | **관측**: 16:43:22 출현 → 16:44:20 소멸(50ms 폴링, `.artibot/` mtime 일치). 테스트 스위트 42개 단독 실행 + 폴링으로 **재현 0건** — 모든 훅 스위트가 샌드박스 `cwd`/`storeDir` 를 넘긴다. **메커니즘은 확정**: `getDecisionStoreDir({})` 가 `cwd` 미전달 시 `process.cwd()` → 최근접 `.git` = 리포 루트로 떨어진다. 이것은 `decision-events.js:170-174` 가 명시한 설계("관측 전용 recorder 는 실패 모드를 갖지 말 것" — 원문 "an observe-only recorder must not acquire a failure mode")의 **대가**다. **⚠️ 위험**: `/doctor` Check 7 은 `diag-` 접두만 제외하므로(`doctor.md:200` S5 행 원문 "no `*.events.ndjson` with a non-`diag-` `sessionId` has ever been written under this root" → warn) `_unattributed` 줄이 S5 판정에서 **"실 기록"으로 읽힌다** — **팀원 프로브 1회가 Check 7 을 거짓 그린으로 만들 수 있다.** 기록자 추가 실측: **2026-09-03 17:0x 기준 `.artibot/runtime/decisions/` 디렉터리 자체가 부재**(소멸 후 재출현 없음) | 후속(설계안 후보, **코드 아님**) — 세션 없는 수동 실행을 실 스토어에서 분리: `_unattributed` 를 Check 7 분모에서 제외하거나 `diag-` 계열로 강등. `HOOK-VISIBILITY-DESIGN.md` 또는 `INCIDENT-2026-09-03-hook-payload-contract.md` 에 교차 참조. **미확인 3건: ① 그 파일의 내용 ② 쓰기 주체(정황: 팀원이 `session_id` 없는 호스트 형태 페이로드를 디스패처에 파이프한 프로브 — 추론) ③ 삭제 주체(코드에 스토어 삭제 0건 → 수동 정리 추론)** |
| 13 | `plugins/artibot/scripts/hooks/auto-team-trigger.js:372`·`:376` — **`--no-team` 옵트아웃 회귀** | 리라이터가 플래그를 제거한 본문을 `payload.user_prompt` 에 넣고, `:372` 의 `extractUserPromptText(hookData)` 가 그것을 1순위로 읽는다 → `:376` 의 `NO_TEAM_FLAG.test(prompt)` 가 **원문을 못 본다**(`NO_TEAM_FLAG = /--no-team\b/i`, `:59`). **오늘 수리로 비로소 도달 가능해진 잠복 결함** — HEAD 에선 두 훅 다 프롬프트를 못 읽어 잠복했다 | 후속(코드) — **payload 팀원이 커밋 전 수리 중**(원문 `hookData.prompt` 에서 감지, 디스패처 체인 테스트 + RED 증명) |
| 14 | `plugins/artibot/hooks/hooks.json:169` `"timeout": 15000` | effortpath 지적: 호스트 문서상 단위가 **초**라면 4.2시간이 된다. **⚠️ 기록자 실측 — 이 지적은 `:169` 에 한정되지 않는다**: 같은 파일의 모든 timeout 이 동일 척도다(`:13` 30000 · `:27~:99` 5000 ×7 · `:113` 30000 · `:127` 8000 · `:169` 15000). 단위가 초라면 30000 = **8.3시간**이 되므로 **전부 이상해진다** — 즉 쟁점은 "이 줄의 값"이 아니라 **파일 전체의 단위 규약**이다. 15000 은 8000 과 30000 사이라 이상치도 아니다 | 확인 요망 — **의도·단위 규약 미확인, 범위 밖.** 호스트 문서를 확인하지 않았다 |
| 15 | `plugins/artibot/scripts/hooks/_userprompt-dispatcher.js:146` 주석 "fulfillment order" | 원문 "…followed by the parallel contributors in **fulfillment order**" 는 **틀렸다**. `:212` 의 `Promise.allSettled` 는 결과 배열을 **입력 순서**로 돌려준다(완료 순서가 아니다) → 디렉티브 선두 배치는 배열 순서로 **결정적**이다(effortpath 실측, 기록자 원문·`allSettled` 호출 위치 확인) | 후속(코드 주석) — **UPS 설계안 구현 시 정정.** 동작은 이미 결정적이라 버그 아님 |
| 16 | **결정 스토어 2개가 서로 다른 루트로 갈라짐** — 이벤트는 projectRoot, 트레일은 pluginRoot | 이벤트 스토어는 결정 D 로 **projectRoot** `.artibot/runtime/decisions/` 가 됐는데, **트레일은 여전히 pluginRoot** 다: `plugins/artibot/lib/core/decision-trail.js`(**경로 확정 — `lib/observability/` 아님**) 3곳이 pluginRoot 를 고정한다: `:12` 헤더 "Storage: `runtime/decision-trail.json` at the plugin root" · `:22` `import { getPluginRoot } from './platform.js';` · `:32` `const DEFAULT_PATH = 'runtime/decision-trail.json';`. 루트 해석은 `:84` 주석대로 `process.env.CLAUDE_PLUGIN_ROOT`(via `getPluginRoot()`). 그 결과 `/doctor` Check 7 **S6** 의 근거 문장("both stores are written under the same resolved root")이 거짓이 됐다. 기록자 확인: config 가 이미 `commands/doctor.md` 를 갱신했다 — 옛 문장은 **소멸**했고(`grep "same resolved root"` 0건), `:188-192` 가 두 루트를 각각 라벨링해 보고하도록, `:191` 이 "2026-09-03 these are two different trees — see the S6 note below" 로, `:222-228` 이 "CAVEAT ON S6, since 2026-09-03 … Treat an S6 warn as 'check WHICH root each store resolved to'" 로 대체됐다 | 후속(설계안) — **트레일 이관은 이번 범위 밖.** 다음 결정으로 올릴 것. 현재는 S6 오독 방지 문구로만 막혀 있다 |
| 17 | **`npm run ci` red 2건 — 팀 미수정·환경성** (inspector 실측 17:26~17:48) | ① `tests/git/git-dir.test.js:142`(`expect(gitPath(repo)).toBe(getGitDir(repo))`) — tmpdir **8.3 단축경로(`HEECHA~1`) vs 장경로 비교 불일치**. **격리 13/13 통과**, 전체 실행 시 **1회만 관측** → **재현 조건 미확인**. ② `tests/handoff/handoff-store.test.js:316`(`await writeHandoff(...)` throttle 케이스) — **Windows EPERM rename(부하)**. **격리 27/27 통과**, 어제 autopilot 보고서 §1 에도 플레이크 1 로 기록됨. 기록자 실측: 두 테스트 파일 모두 `git status` **미수정 확인**(팀이 건드리지 않았다) | 후속(다음 릴리스) — **테스트 픽스처 수리이지 제품 코드 아님.** 권장: git-dir 는 `fs.realpathSync` 로 양쪽 정규화, handoff-store 는 rename 재시도. **주의**: `eval:runtime:check` 는 `package.json:25` ci `&&` 체인의 **맨 끝**이라 `npm test` 가 red 면 **아예 실행되지 않는다**(기록자 체인 확인) — 별도 실행 시 8/8 EXIT 0 |
| 18 | **`npm run sync:local` 이 라이브 plugin cache 를 덮어쓴다** — **메커니즘 확정: `install.sh` 의 의도된 동작** | **경로**: `sync:local` → `install.sh:615 install_plugin_cache()`(`:616` `cache_root`, 복사 `:626-651` `atomic_replace_dir`, 호출부 `:1566`, 로그 `:651`). **의도임이 문서화**: `:41` 헤더 "write into LIVE plugin", `:542`, `:596-612`. 그 `:596-612` 주석이 이유를 전부 적고 있다 — 호스트는 **세션 시작 시 hooks.json 을 캐시 디렉터리에서 로드**하고, 캐시는 마켓플레이스 미러에서 **lazy 채움**이며 install.sh 가 미러만 쓰면 갱신되지 않는다(v4.6.4→v4.8.2 훅 회귀가 오래 묻힌 원인). "Mirroring the hot paths into **every cache version dir** keeps future sessions consistent" — **5개 전부 덮어쓰는 것이 설계다.** `.claude-plugin/plugin.json` 을 **일부러 안 건드리는** 이유도 명시돼 있다: "its version field is **the cache routing key** — overwriting it would orphan the cache entry". **기록자 전수 실측(18:2x)**: 5개 디렉터리 모두 `lib/core/hook-utils.js` 가 워킹트리와 바이트 동일, `package.json` 전부 4.54.0, `plugin.json` 만 원래 라벨 유지 — **관측이 설계와 정확히 일치**. **캐시 코드의 정체**: HEAD **`bc2e9e55` 와 내용 동일**(EOL 만 CRLF, `core.autocrlf=true`) = **커밋됐으나 릴리스·태그 전인 코드** | 후속(설계) — 권장: 캐시 덮어쓰기를 **옵트인**으로 하거나 릴리스 절차에 명시. **함의**: (a) 이 세션 라이브 훅이 **릴리스 전 코드로 돌고 있다**(커밋은 된 코드) (b) 앞선 "설치본 무접촉" 전제 **무효** (c) `installed_plugins.json` 의 SHA 와 캐시 내용이 어긋난다 (d) **캐시는 파생물이라 더 이상 과거 버전을 보존하지 않는다 — 캐시 디렉터리 이름으로 구 버전을 되돌려도 같은 코드가 돈다. 롤백은 캐시가 아니라 마켓플레이스 미러 태그 체크아웃 + 캐시 무효화(`scripts/update.js:239 clearCache`, `install.sh:611-612` 주석)로 해야 한다.** 라벨 불일치 자체는 결함이 아니라 라우팅 키 보존이다 |
| 19 | **git 경로 출력을 `-z` 없이 파싱하는 곳 13곳** — artifact-governance 수리(`0273c7d7`)와 같은 클래스 | 한글/공백 경로에서 git 이 C-quote 로 감싸 파서가 깨질 수 있다. **각각이 실제 결함인지는 미확인** — `core.quotepath=false` 를 넘기거나 ASCII 경로만 다루면 무해하다. 기록자 전수 확인(13/13 해당 줄에 `--name-only`/`--name-status`/`ls-files`/`ls-tree` 실재): `lib/git/conflict-detector.js:82`·`:142` · **`lib/git/limb-landing-check.js:427`**(`git(['diff','--name-only',range,'--'])` — `/split` 소유권 게이트, **다음 배치 `/split` 4줄기가 바로 이 경로를 탄다 → 우선 확인 대상**) · `lib/git/merge-preflight.js:207` · `lib/handoff/handoff-builder.js:425` · `scripts/hooks/dev-verify-gate.js:124-125` · `git-autopilot-guard.js:86` · `git-autopilot-merge.js:47` · `image-cleanup.js:85` · `session-notes.js:139` · **`scripts/hooks/stop-review-gate.js:79-80`**(`diff --name-status --diff-filter=ACMR` ×2 — **방금 주석 전용 변경에 오탐을 낸 리뷰 게이트**, 한글 경로에서도 깨질 수 있다) · `tests/firewall/cowork-plugin-zip-drift.test.js:297` · `tests/firewall/gitignore-boundary.test.js:176` | 후속(설계) — **이번 릴리스 밖.** 권장: 공용 헬퍼 `gitPathsZ()` 하나로 모으고 **한글 경로 픽스처 게이트**. 선행 사례는 `0273c7d7` `fix(test): artifact-governance 게이트의 git ls-files 파싱을 -z 로 — 한글 경로 C-quote 로 디렉터리 2개 집계·frontmatter 검사 누락 수리`. **분모 주의**: 리더는 `-z` 사용처를 7건으로 셌고 기록자 grep 은 6건 — 패턴이 달라 생긴 차이이며 어느 쪽도 재현 명령을 고정하지 않았다(미확인) |

**후속 12 귀속 해소 (2026-09-03 17:09, config 팀원 자기보고 — 등급: 추론 → 자기보고)**

config 보고 원문 요지: "`getDecisionStoreDir` 기본값을 projectRoot 로 바꾸자 `CLAUDE_PLUGIN_ROOT` 로만
격리하던 스위트들이 **실 리포 스토어에 픽스처를 쓰기 시작**했다. 첫 테스트 실행에서
`.artibot/runtime/decisions/` 에 **11개 파일**이 생겨 삭제했고, 전 스위트 이진탐색으로 **9파일**을
샌드박스 `.git` 마커 + 페이로드 `cwd` 로 재고정했다."

- **쓰기 주체(미확인 ②) → config 의 이진탐색 테스트 실행**
- **삭제 주체(미확인 ③) → config 의 수동 정리**
- **파일 내용(미확인 ①) → 여전히 미확인**(파일 소멸, 복원 불가 가능성)

**등급 표기**: 이것은 **config 자기보고**이며 **시각 대조는 실시하지 않았다** — checker-config 가 본
16:43:22 출현·16:44:20 소멸과 config 의 실행 시각을 맞춰본 사람이 없다. "추론"에서 "자기보고"로
한 등급 올라간 것이지 **실측 확인이 아니다.**

**이 사건의 의미**: 후속 12 의 위험은 가설이 아니라 **실제로 발생했다.** 메커니즘 확정 →
**실발생 1회**로 승격한다. 즉 리포 루트 스토어 오염은 "일어날 수 있다"가 아니라 "이미 일어났고
사람이 손으로 지웠다".

재고정된 9파일(기록자 실재 확인 — 9/9 전부 존재):
`tests/hooks/` 의 `runtime-prompt-decision-wiring` · `runtime-prompt-memory-instrumentation` ·
`runtime-prompt` · `runtime-prompt-effort-inject` · `runtime-prompt-effort-order` ·
`silent-fail-stderr` · `userprompt-dispatcher`, 그리고 `tests/e2e/runtime-flow.test.js` ·
`tests/runtime/middleware/decision-events-wiring.test.js`.

**⚠️ 리더 인용 정정**: 마지막 항목을 "`userprompt-dispatcher.test.js:285` 의 `cwd: PLUGIN_ROOT` 스폰"
이라 했으나, `:285` 는 `hookSpecificOutput` 픽스처 안이다. 해당 수정은 **`:317-325`** 의 `spawn` 이며
그 주석이 사건을 그대로 적고 있다 — "since 2026-09-03 the decision store resolves from the PROJECT ROOT
of the cwd … Spawning from PLUGIN_ROOT put this suite's recorder-stats line in the repository's own store
— the exact 'fixture data in the store /doctor reads' failure this file's header says it exists to avoid."
현재 값은 `cwd: sandboxCwd`(`:325`).

**후속 12 갱신 — 실발생 2회째, 이번엔 리더 본인 (쓰기 주체 실측 확정, 2026-09-03 17:46)**

리더가 `plugins/artibot` 를 cwd 로 `npx vitest run tests/git/git-dir.test.js tests/handoff/handoff-store.test.js`
를 **격리 실행**하자 리포 루트에 `.artibot/runtime/decisions/_unattributed.events.ndjson`(215 B,
mtime **17:46:56** = 실행 시각 일치)가 생성됐다. 1회째(config)와 달리 이번은 **쓰기 주체가 실측으로 확정**
됐다 — 리더 본인이다. 내용은 리더가 읽고 18:1x 에 삭제(gitignore 산출물). 기록자 재확인: 현재
`.artibot/runtime/decisions/` **디렉터리 부재**.

메커니즘은 후속 12 그대로(`cwd` 미전달 → `process.cwd()` → 최근접 `.git`). **이로써 확정되는 것**:
후속 12 를 낳은 9파일 재고정은 **문제를 없애지 못했다.** 그 수리는 *그 9개 스위트*를 샌드박스에
묶었을 뿐이고, **경로 자체는 여전히 열려 있어 아무 테스트나 리포 루트 cwd 에서 돌리면 실 스토어를
오염시킨다.** "테스트 격리 실행조차 실 스토어를 오염시킨다" 가 관측 2회로 성립했다 —
**설계안 우선순위 상향 권고**(현재 후속 12 의 권장 처리는 개별 스위트 수리가 아니라 경로 차단이어야 한다).

**⚠️ 위 단락(:814~) 등급 정정 — 실측 → 시각 상관 기반 추론 (followup 팀원 실측, 리더 grep 재확인 2026-09-04 11:5x)**

윗 문단의 "**쓰기 주체가 실측으로 확정** 됐다 — 리더 본인이다"는 **성립하지 않는다.** 근거:
그 두 스위트(`tests/git/git-dir.test.js`·`tests/handoff/handoff-store.test.js`)의 import 는
`lib/git/git-dir.js`·handoff-store 와 node 내장뿐이고, `flushRecorderStats` 의 **비테스트 참조는
정의(`decision-events.js:644`)와 `scripts/hooks/runtime-prompt.js:626` 2건뿐**이다(기록자 재현:
`grep -rn "flushRecorderStats" --include=*.js plugins/ | grep -v /tests/` → occurrence 4 =
정의 `:644` · JSDoc `:106` · import `runtime-prompt.js:609` · 호출 `:626`, **소비처는 runtime-prompt 1곳**).
즉 그 스위트는 recorder 경로에 **닿지 않는다.** 17:46:56 mtime 일치는 인과가 아니라 **시각 상관**이다.

- **등급**: 실측 → **시각 상관 기반 추론**
- **쓰기 주체**: **미확인**(1회째 config 자기보고, 2회째 이 정정으로 되돌림, 3회째는 아래 참조)
- 윗 문단을 지우지 않는 이유: 정본 규칙(부록 표가 본문을 이긴다)에 따라 **원 기록 보존 + 정정 병기**.


**교훈 각주 — 설치본·캐시 대조에 `cmp` 를 쓰지 마라 (이 세션 CRLF 착시 3번째)**

`core.autocrlf=true` 라 **워킹트리·설치본·캐시는 CRLF**, **커밋 blob 은 LF** 다. 그래서
`cmp <(git show HEAD:<path>) <cache>` 는 **내용이 같아도 항상 다르다고 나온다**(실제 관측:
`differ: byte 4, line 1` — 첫 줄 끝에서 갈린다). 이 착시로 기록자가 후속 18 에 "캐시 코드는
릴리스본도 커밋본도 아닌 워킹트리 스냅샷" 이라고 **틀린 결론**을 적었고, 그것을 "어느 커밋에도
대응하지 않는 코드" 로 격상해 보고했다. 실제로는 **`bc2e9e55` 커밋본과 내용 동일**이다.

**대조에 쓸 명령**:
```
diff -q --strip-trailing-cr <(git show HEAD:<path>) <cache>   # 내용 동치 판정
git diff --ignore-cr-at-eol HEAD -- <path>                    # 워킹트리 대조
file <cache>                                                  # EOL 종류 확인
```
`cmp` 는 **양쪽이 같은 EOL 계열일 때만** 유효하다 — 캐시 ↔ 워킹트리(둘 다 CRLF) 대조는 유효했고,
그래서 "5개 캐시 전부 워킹트리와 동일" 결론은 **그대로 유효하다**. 무효가 된 것은 blob 을 한쪽에
놓은 대조뿐이다.

**이 세션에서 CRLF 가 만든 착시는 이번이 3번째다** — (1) inspector 부작용 (a), (2) 기록자 census
원본 LF, (3) 이번. 세 번 반복됐으므로 대조 절차의 기본값을 `--strip-trailing-cr` 로 둔다.


**checker-apply F5 — no-op (반영 불필요)**: "`fixture substantive` 행이 아직 보류" 라는 지적은 **기록자의 확정 갱신 이전 스냅샷**을 본 것이다. 해당 행은 16:4x 에 이미 확정으로 갱신됐고 리더가 재확인했다. **F5 는 이미 반영됨(16:4x).**

**설계안 정본 각주(가시성)**: 훅 실패 가시성은 **`HOOK-VISIBILITY-DESIGN.md`(23,162 B)가 통합 정본**이며
저장 위치는 홈 스코프 `~/.claude/artibot/runtime/hook-errors.ndjson` 이다.
`DESIGN-HOOK-FAILURE-VISIBILITY.md`(11,837 B)는 **리다이렉트 문서일 뿐** — 내용 정본으로 인용하지 말 것.
(기록자 실측: 두 파일 모두 `.artibot/guides/v5-design/` 에 실재)

**`ARTIBOT.md` 확인 결과: 손댈 것 없음.** `docs/adr`·`.artibot/adr`·`B2` 어느 문자열도 **0건**이라
`artibot-entry-parity` 게이트가 지키는 그 파일은 이번 B2 변경으로 거짓이 되지 않았다.

**1번은 단순 후속이 아니라 게이트 사각지대다.** 게이트를 만들면 그 게이트가 못 보는 것을 옆에 적으라는
규율에 따라 여기 남긴다: **B2 이행 직후 `.artibot/adr/` 안의 링크는 어떤 게이트도 검사하지 않는다.**

**PRD-SPLIT 자기 갱신 처리(기록자, 2026-09-03 16:5x) — 완료**

그 문서 `:283-289` 는 **"B2 *이행* 시"** 갱신하라고 요구했다. 16:4x 관측에서는 이행 미완이라 결정 상태만
갱신하고 번호 재작성을 미뤘으나, **16:5x 재측정에서 이행이 완료돼 재작성까지 수행했다.**

이행 실측(`ls` · `git status --porcelain`): `.artibot/adr/` 에 **ADR-001~010 + INDEX.md**,
구 경로 `docs/adr/`·`plugins/artibot/docs/adr/` **둘 다 소멸**. 플러그인 5건 `git mv`(인덱스 `R` 5건),
split 5건은 **ADR-006~010 재번호**(untracked — `git add` 는 apply 담당).

PRD-SPLIT 에 수행한 갱신: frontmatter `linked_adrs` → ADR-006~010 · `superseded_linked_adrs` →
`superseded_linked_adrs_note`(r2 초안 번호와 B2 재번호가 **값이 같아지므로** 구분 문장으로 대체) ·
본문 `**연관 ADR**` 줄 · 상태 문단. **이것이 이 세션에서 유일하게 append-only 가 아닌 편집이다**
(numstat 20/5 — 삭제 5줄은 전부 제자리 교체분).

**이 결정 기록의 버전관리 정본은 여기다.** 같은 §5 결정 내용이
`reports/AUTOPILOT/ap-20260902-062936-tyc5j4.md` §5 에도 들어가 있으나, **그 보고서는 git 추적 대상이 아니다**
(`.gitignore:73` 의 `reports/*`, 재포함은 `!reports/SPLIT/` 뿐 — `git check-ignore` exit 0). 따라서 나중에 이
결정을 찾는 사람은 **`ARTIBOT-5.0-DESIGN.md` 부록 0-2 후속(이 절)** 을 정본으로 삼아야 한다.

---

### 부록 0-2 후속(2). 오너 결정 (2026-09-04 확정)

**결정자: 오너 · 결정일: 2026-09-04 12:0x KST · 수단: `AskUserQuestion` 실답 · 기록: 리더 경유 기록자 반영.**
아래 4건은 2026-09-03 결정 절(위)의 **연속**이며, 그 절과 같은 규칙으로 읽는다 —
**결정 문구는 오너 원장을 그대로 옮긴 것이고 기록자의 해석·보완을 더하지 않았다.**
「재결정 조건」열은 오너가 근거 열에 적은 유보를 조건문으로 옮긴 것이며,
**오너가 특정하지 않은 임계·표본 수는 그 자리에 `미확인` 으로 적었다**(추측으로 메우지 않음).
2026-09-03 오너 메타 결정(**설계 정본 우선 → 권장안 → 기록만**, 질문은 신규 방향에만)이 그대로 적용된다.

| ID | 오너 결정 (2026-09-04 확정) | 근거/단서(오너 제시) | 재결정 조건 |
|---|---|---|---|
| 착수 형태 (2026-09-04) | **"권장안 그대로".** ① F-10 · F-30 **즉시 승인**(설계안 2건 → 구현 착수) ② L2 D0 프로브 **즉시**(코드 0) ③ L1 은 **설계안 재대조 후 착수** — `bc2e9e55` 반영 + §2.2/§4.1 `:141` 모순 해소가 선행 ④ G-1 은 **2번 답으로 확정**(아래 「G-1 2차」 행) ⑤ `docs:check` 스코프 확대·트레일 이관은 **보류**(설계안 부재) | 권장안 = 리더 제시안. 보류 2건의 사유는 "설계안이 아직 없다" | ③ 은 **설계안 재대조가 끝나면** 해제. ⑤ 는 **설계안이 서면 재상정** |
| G-1 2차 (2026-09-04) | **흡수 확정 — `performance.priority` 5값을 3값으로 흡수, `quality` → `balanced`.** economy → balanced 로 인한 **표현력 손실은 `G-1b` 로 미결 등록**하고 **README 에 명시**한다 | 5값 enum 유지 시 소비처가 구분하지 못하는 값이 남는다 | **`G-1b`(economy 손실) 는 미결** — 손실이 실사용에서 드러나면 재결정. 임계는 오너 미특정 — `미확인` |
| 후속 12 차단안 (2026-09-04) | **B + D 채택.** **B** = `flushRecorderStats`(`lib/observability/decision-events.js:644`)가 **세션이 없으면 파일 대신 stderr** 로 쓴다. **D** = **firewall 허용목록 게이트** 신설(`tests/firewall/trail-sandbox-required.test.js` 구조 복제). **A(개명) 반대**, **C(cwd 없으면 no-op) 미채택** | 후속 12 는 관측 3회(아래 「실발생 3회째」) — 개별 스위트 수리로는 경로가 닫히지 않는다 | 없음(선택 확정). B·D 는 각각 별도 이행 |
| 후속 19 범위 (2026-09-04) | **`/split` 게이트 2곳 + 한글 회귀 테스트 먼저.** 대상 = `lib/git/limb-landing-check.js:427` · `scripts/split/restore-blob.mjs:86` + **한글 경로 픽스처 회귀 테스트**. 나머지 자리는 **후속 배치**. **#7·#10 은 착수하지 않음**(결과 불변) | 다음 배치 `/split` 4줄기가 바로 그 두 경로를 탄다 | 나머지 자리는 **한글 경로 실유입이 관측되면** 앞당김. 빈도 임계는 오너 미특정 — `미확인` |

**착수 형태(오너 확정)**: `/split plan` · runId **`split-9d6dc2`** · base **`7cbb37b9`** · 줄기 4개 =
`l4-f10` · `l3-f30-g1` · `p2-f12-f19` · `l2-probe`. **`CHANGELOG` 는 통합 시 리더가 일괄**(줄기별 기록 금지).
⚠️ 이 4줄기의 **파일 소유권은 겹친다** — 아래 「핸드오프 전제 정정 3건」(c) 참조.

---

#### 부록 0-2 후속(2)-b. 오너 결정 3건 + 위임 1건 (2026-09-04 13:3x 확정)

**결정자: 오너 · 결정일: 2026-09-04 13:1x~13:5x KST · 기록: 리더 경유 기록자 반영.**
위 4건과 같은 규칙으로 읽는다 — **결정 문구는 오너 원장 그대로**, 미특정 임계는 `미확인`.
아래 3건은 `.artibot/split/next-batch-plan.md` §4 의 (D)-1·(D)-2·(D)-4 에 대한 답이고,
(D)-3 은 **정본 `:913` 이 이미 답을 갖고 있어 질의하지 않았다**(각주 참조).

| ID | 오너 결정 (2026-09-04 13:3x 확정) | 근거/단서(오너 제시) | 재결정 조건 |
|---|---|---|---|
| D-1 훅 수리 예외 (13:3x) | **"예, 버그 수리 예외로 착수".** gotcha #18/#22 의 방어선 — `scripts/hooks/git-autopilot-session.js` 에 `isSplitLimbBranch → stay put` 예외를 넣는 것을 **"코드는 설계안" 명시 예외 4번째**로 인정한다(선례 3건: ensureADR · decisions 경로 · payload 키 `:686`). 근본 수리인 **테스트 git 샌드박스**(`tests/dispatcher/sessionstart-dispatcher.test.js` 의 `cwd` 를 임시 리포로)는 프로덕션 코드 0 이라 애초에 예외가 불필요하다 | 사고 **실측 4/4**(4 worktree 전부 브랜치 이동 · `status` 에서 줄기 소멸 · land `no-commits` 거짓 미완료). 1훅 1분기, revert 1커밋, 기존 파이어월 확장으로 게이트 | 없음 — 확정 |
| D-2 L2 D1 착수 (13:3x) | **"예, 2차 배치에 편입".** `ROUTE-RECEIPT-PRETOOLUSE-DESIGN.md` 의 **D1 구현**(PreToolUse(Agent) receipt + SubagentStart `route.bound`)을 2차 배치 줄기로 착수한다. `config` 키·`/doctor` Check 10·`lib/replay` 조인은 **D1 밖** | 조건부 승인(`:681` "설계안이 오너 승인을 받으면 구현 착수")의 **조건이 충족됐다** — D0 프로브 판정 **D1-go**(l2-probe 첫 커밋 `5b44b803`, 2026-09-04 12:53, host **2.1.260**, 3시나리오 **6/6** 발화, 픽스처 `tests/hooks/fixtures/host-payloads/PreToolUse.Agent.json`) | 없음 — 확정. **주의**: 설계 전제였던 host 2.1.259 보다 **1패치 위**에서 잰 값이다(gotcha #19) |
| D-4 모델 정책 설계안 (13:3x) | **"설계안 작성 지시".** 모델 정책 **역할 오버라이드** 설계안을 작성한다(코드 0). **산출 완료** — `DESIGN-MODEL-POLICY-role-override.md` **174줄**(기록자 `wc -l` 확인). 그 문서 **§5 「오너 결정 필요 항목」 5건은 승인 대기** | 리포 기록 **0건**이었다(`역할 오버라이드|role.?override|모델 정책.*오버` 전역 grep) — 방향이 오너 세션에만 있어 설계안이 대신 적을 수 없었다 | **§5 의 5건이 승인되면** 구현 착수. 그 전까지 코드 0 |
| (위임) 커밋·푸시·배포 (13:1x·13:5x) | **오너 원문 ① 13:1x "앞으로 커밋 푸쉬 배포 등등의 작업도 너가 권장사항으로 중간중간 다 진행해줘" ② 13:5x "당분간 의사결정 못함, 2시간 부재, 권장사항으로 마무리"** | 오너 부재 구간의 진행을 막지 않기 위함 | 오너 복귀 시 위임 범위 재확인 — 기한·범위를 오너가 특정하지 않았다(`미확인`) |

**위 위임에 따른 리더 권장 채택 (등급: 권장 채택 — 오너 부재, 미질의)**

아래는 **오너가 답한 결정이 아니라** 위 위임을 근거로 리더가 고른 것이다. 등급을 섞지 마라.

| # | 리더 권장 채택 | 근거 | 되돌리기 |
|---|---|---|---|
| 1 | 2차 배치를 **`/split`(창 4개) 대신 `/team` + `isolation: worktree` 팀원**으로 실행 | `/split` 의 `open` 단계는 **사람이 창을 연다**(런 1·2호 모두 humanWait 구간). 오너 2시간 부재 중에는 그 단계에서 멈춘다 | 오너 복귀 후 `/split` 로 전환 가능 — 줄기 정의·소유권 표는 그대로 재사용 |
| 2 | integrate **확인 프롬프트 생략**, 세그먼트는 **0길이**로 남김 | 위임 ①. 1차 배치에서 같은 처리를 했고 텔레메트리에 `confirm-integrate` 1ms 로 남았다(gotcha #29) | 규약화는 `split.md` §integrate **미편입** — 지금은 런별 판단 |
| 3 | **릴리스·태그·`plugin update`·사용자 `settings.json` 은 하지 않는다** | 위임 문구는 "커밋·푸시·배포"이나, 이 넷은 **되돌리기 비용이 다른 등급**이다 — 릴리스·태그는 외부 가시, `plugin update` 는 라이브 훅 교체(후속 18), 사용자 settings 는 오너 개인 설정(gotcha #20 에서 이미 갱신 주체 미확인 사건이 있었다) | 해당 없음(하지 않음) |

**각주 — (D)-3 은 질의하지 않았다. 정본 `:913` 이 답이다.**
2차 배치 초안 §4 의 (D)-3("후속 19 나머지를 2차에 넣는가")은 **오너 결정 항목이 아니다** —
`:913` 「후속 19 범위」행이 이미 "나머지 자리는 **후속 배치**" 로 결정했고, 2차가 그 후속 배치다.
남아 있던 것은 **"#7·#10 제외" 를 실행 가능하게 만드는 파일명 확정**이었고, 이는 오너가 아니라
**리더가 확정할 사실 문제**다(출처: followup 팀원의 16자리 표).

- **#7 = `plugins/artibot/scripts/hooks/git-autopilot-guard.js:86`** — 제외. `['diff','--name-only','HEAD',trackingRef,'--',filePath]` 로 **경로 1개를 `--` 뒤에 스코프**해 질의하므로 출력은 그 경로이거나 빈 문자열이고, 소비는 **존재 판정**이다. C-quote 가 걸려도 판정이 뒤집히지 않는다. (기록자 확인: argv 와 `--` 스코프까지 직접 읽음. **반환값을 소비하는 줄은 미열람** — 리더 판정을 그대로 옮긴다.)
- **#10 = `plugins/artibot/scripts/hooks/session-notes.js:139`** — 제외. `:140-141` 이 `raw.split('\n').filter(Boolean).length` 로 **개수만** 쓴다(기록자 직접 확인). C-quote 는 한 줄을 다른 문자열로 만들 뿐 **줄 수를 바꾸지 않는다** → 결과 불변.
- **따라서 2차 `p19-rest` 의 자리는 12개**(16 − 1차 2 − 제외 2): `lib/git/conflict-detector.js:82` · `:142` · `lib/git/merge-preflight.js:207` · `lib/handoff/handoff-builder.js:425` · `scripts/hooks/dev-verify-gate.js:124-125` · `scripts/hooks/git-autopilot-merge.js:47` · `scripts/hooks/image-cleanup.js:85` · `scripts/hooks/stop-review-gate.js:79-80`(파서 재작성 + 픽스처 6곳) · `tests/firewall/cowork-plugin-zip-drift.test.js:297` · `tests/firewall/gitignore-boundary.test.js:176` · `.github/workflows/plugin-validate.yml:61` · `plugins/artibot-cowork/scripts/release.js:158`.
- **미확인**: 12자리 각각이 실제로 한글 경로에서 깨지는지는 **자리별로 확인하지 않았다**. 실증은 여전히 `limb-landing-check.js:427` **1건뿐**(`:945`).

---


**후속 12 갱신(2) — 실발생 3회째 (followup 실측, 리더 재측정 2026-09-04 11:5x · 기록자 재현 11:39)**

정본이 "18:1x 삭제 → 디렉터리 부재"로 끝낸 뒤 **재발했다.**
`.artibot/runtime/decisions/_unattributed.events.ndjson` — **215 B / 1줄**,
ts **`2026-09-03T09:23:47.193Z`**(= 18:23:47 KST), 내용 `recorder-stats 4 skipped 0 failed`.

- **`skipped:4` 의 정체**: UserPromptSubmit 파이프라인 **1회 완주분**(router 1 + tasks 1 +
  `recordObserveOnlyDecisions` 2). 스크래치패드의 **가짜 리포에서 바이트 동치로 재현**됐다.
- **⚠️ 차단안이 끊으면 안 되는 경로**: 현재 같은 스토어에 **라이브 세션 파일 2개가 정상 기록 중**이다.
  기록자 재현(`wc -l` · `stat`, **2026-09-04 11:39 KST**): `9120048e…events.ndjson` **7줄**(11:04:58),
  `9d6dc211…events.ndjson` **10줄**(11:39:41 — 이 세션, 증가 중. 리더 11:0x 관측의 "6줄"과 다른 것은
  **같은 파일이 자라고 있기 때문**이며 모순이 아니다). 후속 12 차단안 B·D 는 **이 경로를 살려 둔 채**
  세션 없는 실행만 갈라내야 한다.
- **`/doctor` Check 7 오독 위험(검수자 확인, 재확인됨)**: `commands/doctor.md:200` 의 S5 행 원문은
  "no `*.events.ndjson` with a non-`diag-` `sessionId` has ever been written under this root" 이라
  `_unattributed` 를 **`diag-` 접두가 아니라는 이유로 라이브 증거로 계수한다.** 후속 12 의 원래 경고가
  **3회째 관측으로 재확인**됐다.
- **등급**: 파일·바이트·타임스탬프는 **실측**, **쓰기 주체는 여전히 미확인**(위 등급 정정 참조).


**후속 19 갱신 — 분모 13 → 16, 일괄 치환 불가 확정 (followup 실측, 리더 sed 재확인 2026-09-04)**

- **분모 정정**: 기존 13곳은 **전부 실재**하고, 추가 **3곳**이 확인됐다 → **16곳**.
  추가분(기록자 `sed -n` 재확인 3/3): `plugins/artibot/scripts/split/restore-blob.mjs:86`
  (`ls-files --full-name --error-unmatch` — `/split` 복원 도구) ·
  `.github/workflows/plugin-validate.yml:61`(`diff --name-only`, CI 셸) ·
  `plugins/artibot-cowork/scripts/release.js:158`(`diff --cached --name-only`).
  **git 명령 수는 18개**(#6·#11 이 각각 2개를 품는다) — 자리 수 16 과 명령 수 18 을 섞지 말 것.
- **완화 조건 없음**: `core.quotepath` **미설정**(= 기본 `true`) → C-quote 가 실제로 켜져 있다.
- **`limb-landing-check.js:427` 은 우선 대상이 맞다**: 이 줄은 `ownershipCheck` 로 들어가는
  **`/split` 소유권 게이트**이고, 한글 파일명이 allowlist 안에 있어도 **거짓 FAIL**(fail-closed 방향)이
  실제 `checkLimbLanding` 호출로 **재현**됐다.
- **일괄 치환 불가**: `-z` 는 **명령마다 출력 형태를 다르게 바꾼다**(`--name-status` 는 status 와 path 가
  **별개 NUL 필드**로 나온다) → 한 줄짜리 치환 스크립트로 처리할 수 없다. **공용 헬퍼는 YAGNI**
  (후속 19 의 종전 권장 "`gitPathsZ()` 하나로" 는 이 실측으로 **철회**).
- **파서 재작성이 필요한 곳은 1곳**: `scripts/hooks/stop-review-gate.js:79-80`
  (+ **테스트 픽스처 6곳 개편**). 나머지는 필드 분리만으로 족하다.


**핸드오프(2026-09-03 18:51) 전제 정정 3건 (doctor·architect 팀원 실측, 리더 재측정 2026-09-04)**

| # | 핸드오프 전제 | 실측 | 정정 |
|---|---|---|---|
| (a) | 훅 페이로드 수리 커밋 = `09d4eff3` | `09d4eff3` 은 **버전 문자열 12파일**(릴리스 동기화). 수리 본체는 **`bc2e9e55`**(2026-09-03 **17:49:12** +0900, `fix(hooks): 호스트 페이로드 키 prompt 수리 …`) | 수리 커밋은 **`bc2e9e55`**. ⚠️ **리더 브리프의 "24파일" 은 기록자 재측정과 다르다 — 실측 41파일**(`git show --numstat --format='' bc2e9e55 \| grep -c .` → **41**, `--shortstat` → `41 files changed, 835 insertions(+), 147 deletions(-)`). 24 의 출처 미확인 |
| (b) | `spawns.ndjson` 의 `route_ledger` 가 UserPromptSubmit 수리의 증거 | 그 필드는 **SubagentStart 계열**이라 UserPromptSubmit 과 **다른 훅**이다. 값은 **71/71 `skipped:no-action-text`** | **증거 아님.** 사건 b(SubagentStart 에 action text 없음)는 **미해결**이며, 그 처리는 `ROUTE-RECEIPT-PRETOOLUSE-DESIGN.md` 소관 |
| (c) | `/split` 4줄기 **파일 소유권 겹침 0** | **성립하지 않는다.** `artibot.config.json` = **L1 × L2** 명시 · `CHANGELOG.md` = **L2 × L3 × L4** · `commands/doctor.md`·`doctor-checks.js` = **L3 명시 × L2 암묵**(Check 10) | 겹침 **3계열**. `/split` 의 전제(소유권 비중첩)가 깨지므로 **줄기 배치 또는 파일 소유권을 착수 전에 재조정**해야 한다. `CHANGELOG` 는 위 「착수 형태」대로 **리더 일괄**이라 이미 해소 경로가 있다 |


**후속 18 갱신 + `/doctor` Check 7 첫 라이브 통과 (doctor 팀원 실측, 리더 재측정 2026-09-04 11:14~11:22 KST)**

- **Check 7 = pass (첫 라이브)**: 라이브 루트 `~/.claude/plugins/cache/artibot/artibot/4.54.0` 기준
  **S4~S6 전부 false**. `decision-trail.json` 에 **`/resume`·`/team` 슬래시 판정 2건** —
  **프롬프트 텍스트가 훅에 도달했다는 직접 증거**다(`bc2e9e55` payload 키 수리의 라이브 확인).
- **Check 8 = unmeasured**: `.git/artibot/`·`.artibot/state.yaml` **부재** = StateStore 미사용.
  **결함이 아니다** — 분모가 없는 것이다.
- **구조적 한계(게이트 옆에 적는다)**: `events.ndjson` 은 **5훅 중 `runtime-prompt` 1훅만 관측**한다.
  나머지 4훅(auto-team · autopilot-nlu · command-suggest · ambiguity-guard)은 **디스크 산출물 0** 이라
  Check 7 이 pass 여도 **그 4훅의 발화는 증명되지 않는다.**
- **후속 18 범위 확대 — 캐시는 더 이상 버전 충실 아카이브가 아니다**: 플러그인 캐시 **6개** 디렉터리
  (4.47 · 4.49 · 4.50 · 4.51 · 4.53 · 4.54)의 `package.json` 이 **전부 4.54.0**
  (기록자 재현 6/6, 2026-09-04) — `install.sh` 미러가 **구버전 디렉터리까지 순회**한다.
  디렉터리 mtime **18:19:26~18:20:22**(15초 간격)가 한 번의 순회임을 보인다.
  종전 후속 18 은 "5개"로 적었으나 **실측 6개**다.
- **이 관측이 닫는 모순**: "4.54.0 **설치(18:49) 전** 시각의 `_unattributed`(18:23) 가 4.54.0 전용
  projectRoot 경로에 쓰였다" 는 겉보기 모순은, **캐시 전 디렉터리가 이미 4.54.0 코드였다**는 사실로
  설명된다 — **제3의 실행자를 가정할 필요가 없다**(규율 §5 정합성 점검 통과).
- **미확인**: 이 미러가 **의도인지** — `install.sh` 를 이번 확인에서는 **열지 않았다.**
  (종전 후속 18 은 `install.sh:596-612` 주석을 근거로 "5개 전부 덮어쓰는 것이 설계" 라고 적었다.
  6개 순회가 그 설계의 자연스러운 귀결인지는 **원문 재확인 전까지 미확인**으로 둔다.)


**미확인 (2026-09-04 기준 — 삭제·요약 금지)**

- **나머지 4훅의 라이브 발화 여부** — 관측점 자체가 없다(위 「구조적 한계」).
- **`_unattributed` 3회분의 실제 쓰기 주체** — 1회째 config 자기보고, 2회째 등급 정정으로 되돌림, 3회째 미확인.
- **호스트가 `cwd`·`session_id` 를 항상 주는지** — `INCIDENT-2026-09-03-hook-payload-contract.md:169` 에
  기록만 있고 **원시 캡처가 없다.**
- **`git merge-tree --write-tree --name-only` 의 `-z` 지원 여부.**
- **후속 19 각 자리의 한글 경로 실유입 빈도** — 실증은 `limb-landing-check.js:427` **1건뿐**.
- **`INCIDENT` §6.2 (C) 의 정의.**
- **`install.sh` 캐시 미러가 6개 디렉터리 순회를 의도했는지.**
- **L1 설계안 내부 모순** — §2.2(분기 삭제) vs §4.1 `:141`(테스트 무변경) vs
  `tests/hooks/userprompt-dispatcher.test.js:183`. **검수자 발견**, 설계안 재대조 레인에서 해소 예정.

---

### 부록 0-2 후속(3). 오너 결정 10건 (2026-09-04 23:1x 확정)

**결정자: 오너 · 결정일: 2026-09-04 23:0x~23:2x KST · 수단: `AskUserQuestion` 실답 3회(4+4+2) · 기록: 리더 직접(기록자 팀원 없음).**
위 후속(2) 와 같은 규칙으로 읽는다 — **결정 문구는 오너 원장(선택지 label) 그대로**, 리더 해석·보완 없음.
대상은 설계안 3건의 결정 절이다: `DESIGN-MODEL-POLICY-role-override.md` §5(5건) ·
`DESIGN-DOCS-CHECK-scope-artibot.md` §4(2건) · `DESIGN-TRAIL-migration-projectRoot.md` §5(3건).
**10건 전부 설계안 권장안과 일치**한다. 이로써 후속(2)-b D-4 의 "§5 5건이 승인되면 구현 착수" 조건과
후속(2) 착수 형태 ⑤ "docs:check 스코프 확대·트레일 이관 보류(설계안 부재)" 의 해제 조건이 **모두 충족**됐다.

| ID | 질문(설계안 원문 요지) | 오너 결정 (2026-09-04 23:1x 확정) | 재결정 조건 |
|---|---|---|---|
| MP-1 | "조사" 어휘를 process(opus)/judge(fable) 로 분리하는가 | **분리.** 태깅은 작업 단위가 아니라 **산출물(판정 문장) 단위** | 없음 — 확정 |
| MP-2 | A안(역할이 이름을 이긴다) 허용 | **아니오, 지금은 불허.** D안으로 이름 축 안에서 달성 | 설계안 §4 측정이 "D 로도 부족"을 보이면 재상정. 임계는 오너 미특정 — `미확인` |
| MP-3 | D안 신설(investigator·auditor 2종, allowlist 8→10, 로스터 28→30) | **예.** 단 §4 측정 계획과 함께 착수 | 없음 — 확정 |
| MP-4 | 측정 저장소 어휘 `review.claim_audit` +1 | **예.** L2 D1 착지 선행 | 없음 — 확정 |
| MP-5 | fable 스폰 예산 상한 | **상한 없이 집계만(Observe).** | Canary 진입 시 재론. 수치 없음 — `미확인` |
| DC-1 | `.artibot/guides` 렌더링 위반 15건 처리 | **고치고 넣기**(baseline 승격 아님) | 없음 — 확정 |
| DC-2 | docs:check 스코프 | **서브트리 허용목록 + 추적 파일만** | 없음 — 확정 |
| TR-1 | D9 트레일 동결 시점 | **지금 동결** | 없음 — 확정 |
| TR-2 | unique writer 2(user-profile·cron) 목적지 | **decisions 스토어**(`.artibot/runtime/decisions/`) | 없음 — 확정 |
| TR-3 | 기존 트레일 972·9건 | **그대로 두기**(읽기 함수 유지, 삭제 권한은 사람) | 없음 — 확정 |

**기록자 주(등급: 실측)**: 크로스머신 `NEXT-SESSION.md`(`22b7d3f0`) 는 MP-1 을 "(권장 없음 — 오너 판단)" 으로
적었으나 설계안 §5 원문은 **"분리(권장)"** 이다. 질의 시 설계안 원문을 권장으로 제시했고 오너가 그것을 골랐다.
NEXT-SESSION 쪽이 요약 과정에서 권장을 누락한 것이며, 설계안이 정본이다.

**이 결정이 여는 것(리더 정리, 결정 아님)**: 3차 배치 후보 = D안 에이전트 2종 + allowlist/roster 갱신 +
`review.claim_audit` 어휘 · docs:check 허용목록 스코프 + 15건 수리 · D9 동결 + writer 2 이관.
**코드 착수는 `/split plan`(3차) 이후** — 이 절은 결정 기록이며 구현 순서를 정하지 않는다.
