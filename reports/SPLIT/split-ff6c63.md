# /split 실오퍼레이터 런 리포트 — split-ff6c63 (3차 배치)

**런 3호.** 런 1호 `split-8f83d7` · 런 2호 `split-9d6dc2` 에 이어 세 번째 완주다. n=3 — 존재
증명이지 성능 주장이 아니다. 특징은 **리더 통합 브랜치가 5번째 줄기로 배치에 편입된 첫
사례**이고 **integrate 를 3회 돌려서야 착지**했다는 것이다.

| 항목 | 값 |
|---|---|
| runId | `split-ff6c63` |
| sid | `ff6c63` |
| 실행일 | **2026-09-04 23:43:41 KST 착수 → 2026-09-05 03:03:23 KST 랜딩** (텔레메트리 첫·마지막 이벤트, **3h19m41.615s**) |
| base | `dd071ce353e6adf29761304902e6a3824442c7b9` (master, v4.55.0 + 배지 동기화) |
| parentSession | `artibot-22` |
| 줄기 | **wave 1 = 4건** — `ci-scope` · `hooks-fix` · `l2-c10-trail` · `model-d` · **+ 리더 통합 `leader-fix`** · **wave 2 `lock-harness` = 대기(미착수)** |
| 계획 | `profile: fast`, plannedParallelism **4**, worktrees 4, `fallbackReason: null`, waves 2개, conflictGroups **0** |
| 이행 근거 | 오너 결정 **10건** — `ARTIBOT-5.0-DESIGN.md` 부록 0-2 후속(3): DC-1·DC-2 · TR-1~3 · MP-1~5 |
| 랜딩 | **landed** — master `4fc75c8aa250b8dc55016ee561ae85d4036e8eac`, **integrate 3회차**, 폴링 **24**회, **417,688ms (6m57.688s)**, rebuilds **0** |
| 배치 규모 | `dd071ce3..4fc75c8a` = **16 커밋 / 67 파일 / +5,189 / −619** (기록자 재측정, 2026-09-05 보고서 작성 시각) |
| 텔레메트리 | `plugins/artibot/runtime/split/split-ff6c63.events.ndjson` — **23 이벤트**(`runtime/` 은 gitignore). humanWaitPct **67.4%** |
| 교훈 원장 | `.artibot/split/gotchas.md` — 이번 런 델타 **2건**(#62·#63으로 이어붙임, §3.2) |

---

## 0. 요약

2026-09-04 23:43 KST 에 PLAN 이 5ms 만에 닫혔고, **창이 열리기까지 2h04m35s 를 기다린 뒤**
01:56 에 창 4개가 착수해 02:12~02:42 사이 4/4 가 `Split-Limb: done` 으로 닫혔다. integrate
실패 2회를 거쳐 **03:03:23 에 5브랜치 배치로 `4fc75c8a` 착지**했다.
줄기 tip 4개(`4eca40bd` · `0dce8541` · `1294b7fd` · `79e91296`)에 리더 통합분 `a57cec7c`
가 붙어 배치를 이뤘고, `a57cec7c` 와 최종 `4fc75c8a` 의 **트리는 바이트 동일**이다
(재현: `git diff --shortstat a57cec7c 4fc75c8a` 가 빈 출력).

이번 런이 드러낸 가장 무거운 것 둘은 **그린 상태에서 나온 실결함 2건**이다.
① `hooks-fix` 의 `stripBlockComments` 가 줄 중간 미종결 오프너를 열어 파일 다수를 삼켰다 —
출력이 불변이라 표적 스위트는 전건 그린이었고 **독립 검수자만이 포착**했다. ② 배치 CI 만
보는 소유 밖 핀 3건이 integrate 2회차에서야 RED 로 드러났다. 리더 오류는 **plan.json 의
`affectedPaths` 가 브리프보다 좁아 land ownership 1회차 FAIL 이 3줄기에서 재발**한 것이
중심이고, 러너 스크립트 위치 사고 1건과 브리프 인용 오기 3건이 더해진다.

---

## 1. 런 개요 (KST = UTC+9)

phase 경계는 **텔레메트리 23이벤트**(`runtime/split/split-ff6c63.events.ndjson`, 기록자
`wc -l` 재실측 23), 줄기 진행은 `run-log.md` 에서 읽었다. run-log 의 분 단위 시각은 **리더가
로그를 쓴 시각**이라 phase 경계와 별개지만 어긋나지 않는다(run-log "03:03 LANDED" =
INTEGRATE#3 end `03:03:23.488`).

### 1.1 wall-clock (기록자 재측정, 2026-09-05)

| 세그먼트/phase | 시작(KST) | 끝(KST) | 소요 | humanWait |
|---|---|---|---|---|
| `run` (start ↔ **첫** end) | 09-04 23:43:41.874 | 09-05 02:48:28.953 | **11,087,079ms (3h04m47.079s)** | false |
| `run` (첫 이벤트 ↔ **마지막** 이벤트) | 09-04 23:43:41.874 | 09-05 03:03:23.489 | **11,981,615ms (3h19m41.615s)** | — |
| PLAN | 09-04 23:43:41.875 | 09-04 23:43:41.880 | **5ms** | false |
| `open-windows` / OPEN | 09-04 23:44:02 | 09-05 01:48:37 | **7,475,114ms (2h04m35.114s)** | **true** |
| `confirm-integrate` ×3 | 02:48:07 · 02:50:57 · 02:56:25 | 각 +2ms | **2ms ×3** | **true** |
| INTEGRATE #1 | 02:48:07.438 | 02:48:28.952 | **21,514ms** | false |
| INTEGRATE #2 | 02:50:57.455 | 02:53:17.537 | **140,082ms (2m20.082s)** | false |
| INTEGRATE #3 | 02:56:25.800 | 03:03:23.488 | **417,688ms (6m57.688s)** | false |

**humanWaitPct 67.4%** = humanWait 합 7,475,120ms ÷ `run` 첫 쌍 11,087,079ms. **그 99.99% 가
창 열기 대기 한 구간**(23:44~01:48, 오너 부재)이고 `confirm-integrate` 3회는 합쳐 **6ms** 다 —
오너 위임이 0에 가까운 대기였음을 이 6ms 가 증명한다. 분모를 마지막 이벤트로 잡으면
62.4%, 정본은 `summarizeWallClock` 축인 **67.4%** 다.

⚠️ **`run` 은 start 1 · end 3**(unpaired end 2) — 리더 러너가 integrate 회차마다 run 을 닫은
도구 사용 오류다. 첫 쌍만 보면 **integrate 1회차 실패 시점에서 런이 끝난 것처럼 보인다**.
`DISPATCH` phase 와 `wait-limbs` 세그먼트는 **기록되지 않았다**(런 2호에는 있었다).
리더 보고값 `3h04m48s` 는 기록자 재측정 `3h04m47.079s` 와 **1초 어긋난다**(반올림 추정).
나머지(2h04m35s · 2ms×3 · 67.4% · 쌍 개수)는 **전건 일치**.

### 1.2 타임라인

| 시각 | 사건 | 출처 |
|---|---|---|
| 09-04 23:43:41 | `run` start · PLAN 쌍(5ms) — cpuCount 16, requested 5 → planned **4**, `fallbackReason: null` | 텔레메트리 |
| 09-04 23:44:02 | `open-windows` start (**humanWait**) | 텔레메트리 |
| 09-05 01:48:37 | `open-windows` end — **2h04m35s 대기** | 텔레메트리 |
| 01:56 | `ci-scope` · `model-d` 착수 | run-log |
| 01:57 | `l2-c10-trail` · `hooks-fix` 착수. l2 정찰이 trail writer 3파일 추가 보고 → 리더 재실측 일치 → 소유 편입 | run-log |
| 02:02~02:04 | l2 요청 2·정정 2 · model-d 교정 5 채택. hooks-fix 매처 A/B 실측 도착 | run-log |
| 02:12 | **ci-scope DONE** `4eca40bd` — land 7/7 PASS | run-log · git |
| 02:14 | **hooks-fix DONE** `c012ac37` — land 7/7 PASS(ownership 1회차 FAIL 4 후 정렬) | run-log · git |
| 02:19 | 오너 지시: 창별 팬아웃 최대 활용. 리더 Agent 프로브 성공 → 정책 거부 문구는 **오탐** 확정. 리더가 교차검수자 2 스폰 | run-log |
| 02:23~02:27 | 검수 ci-scope **APPROVE** · hooks-fix **REQUEST_CHANGES**(3b) · model-d **REQUEST_CHANGES**(소유 밖 핀 1) | run-log |
| 02:32 | **hooks-fix 재작업** `0dce8541` — land 7/7 PASS | run-log · git |
| 02:36 | 검수 hooks-fix 3b **재검수 APPROVE** | run-log |
| 02:39 | **model-d DONE** `79e91296` — ownership 1회차 FAIL 5 후 PASS (L-1 2회째) | run-log · git |
| 02:42 | **l2-c10-trail DONE** `1294b7fd`(`016f6956` amend) — ownership FAIL 3 후 PASS (3회째) | run-log · git |
| 02:45~02:47 | 검수 model-d · l2 리더측 **APPROVE** → **4/4 APPROVE**, integrate 착수 | run-log |
| 02:48:07~28 | **integrate 1회차 push-failed** (21.5s) | 텔레메트리 · run-log |
| 02:50:57~02:53:17 | **integrate 2회차 not-green** (2m20s) | 텔레메트리 · run-log |
| 02:56:25~03:03:23 | **integrate 3회차 LANDED** — master `4fc75c8a` (6m57.7s) | 텔레메트리 · git |

창 착수(01:56) ~ 랜딩(03:03:23) = **1h07m23s**. 런 전체는 §1.1 의 3h19m41.615s.

### 1.3 integrate 3회차 경위

| 회차 | 시각 | 결과 | 원인 | 조치 |
|---|---|---|---|---|
| 1 | 02:48:07→02:48:28 | **push-failed** | **리더 오류** — 러너 `_split3-integrate.mjs` 를 `plugins/artibot` 안에 둠 → pre-push 의 `eslint .` 가 그 파일의 no-undef 7건에 걸림. 배치 커밋 `c795f42a`(63파일 +5,146/−613) 자체는 격리 export eslint 0 | 락 정상 해제. 재실행은 stdin 모듈(디스크 파일 0) |
| 2 | 02:50:57→02:53:17 | **not-green** | 배치 `09b71ad0` 전체 스위트 **3 RED**(Node 20/22/24 동일) — marketplace `entryPoints.agents.count` 28 핀 · `validate-model-policy.test` allowlist 8 핀 · `userprompt-dispatcher-resilience` timeout 15000ms 핀. **전부 줄기 소유 밖** | 리더 통합 브랜치 `worktree-split-artibot-leader-fix` `a57cec7c` 생성(스크래치 worktree) — 핀 3 + `decisionTrail.enabled=false` + CHANGELOG + `self-control.yml` 경로 |
| 3 | 02:56:25→03:03:23 | **landed** | — | 5브랜치 배치 → master `4fc75c8a`, 폴링 **24**, **6m58s**, rebuilds **0**. `ci/split` 브랜치 삭제, 스크래치 worktree 제거 |

리더 통합분 자체 규모: `git diff --shortstat 09b71ad0..a57cec7c` = **6파일 / +43 / −6**.

**정합성 점검**(규율 §5): 4줄기 파일 합집합 **63** + leader-fix 신규 4파일(`self-control.yml` ·
`CHANGELOG.md` · `validate-model-policy.test.js` · `userprompt-dispatcher-resilience.test.js`;
`artibot.config.json` · `marketplace.json` 은 model-d 와 중복) = **67** — 배치 총계와 일치한다.

---

## 2. 줄기별 결과 (base `dd071ce3` 대비 재측정, 2026-09-05 보고서 작성 시각)

재현: `git rev-list --count dd071ce3..<tip>` · `git diff --shortstat dd071ce3..<tip>` ·
`git log --format='%h %(trailers:key=Split-Limb,valueonly)' dd071ce3..<tip>`

| 줄기 | tip | 커밋 | 파일 | 삽입/삭제 | 트레일러 | land | 검수 |
|---|---|---|---|---|---|---|---|
| `ci-scope` | `4eca40bd` | 1 | 9 | +598 / −36 | done 1/1 | 7/7 PASS | APPROVE (창측, 02:23) |
| `hooks-fix` | `0dce8541` | 2 | 10 | +532 / −73 | done 2/2 | 7/7 PASS ×2 | REQUEST_CHANGES → 재작업 → APPROVE (02:26 → 02:36) |
| `l2-c10-trail` | `1294b7fd` | 1 | 24 | +2,322 / −383 | done 1/1 | 7/7 PASS | APPROVE (리더측, 02:47) |
| `model-d` | `79e91296` | 2 | 20 | +1,694 / −121 | done 1 · wip 1 | PASS(lint 행은 대체 판정) | REQUEST_CHANGES → APPROVE (02:27 → 02:45) |
| `leader-fix` | `a57cec7c` | 1(자체) | 6 | +43 / −6 | done | 배치 CI GREEN | 리더 자체 |
| **합계(배치)** | `4fc75c8a` | **16** | **67** | **+5,189 / −619** | — | — | 4/4 APPROVE |

### 2.1 ci-scope

**목표** docs:check 스코프 확대(DC-1·DC-2) · 렌더링 15건 수리 · #56 `ci-utils.js#gitTrackedNames`
링크드 worktree 결함 종결. **게이트**(02:12 리더 재실측) 표적 **98/98** · `docs:check`
`root-trees=95` · 설계문서 diff 는 12쌍 셀 추가만(문장 무변경).
**검수**(02:18~02:22) 근거 8행, 문장 무변경 IDENTICAL 실증, 음성대조 3단 재현, #56 픽스처
규율 §9 통과, worktree 원복(porcelain 0).
**미확인 7**: CI 러너의 root-trees 스캔 여부 · 전체 vitest · pre-push 직접 호출 · 래그드
뮤테이션 · Linux git · 93→95 집합 · rm 된 파일의 ENOENT 메시지.

### 2.2 hooks-fix

**목표** #49 매처 평문화 · #50 timeout 단위 ms→s · #44 잔여 2자리(한 줄 블록 주석 오탐 ·
`git status --porcelain` NUL split). **게이트**(02:14 리더 재실측) 표적 **92/92** ·
`validate.js` pass · 매처 표현식 잔존 0. 재작업 후(02:32) 2스위트 **27/27**, worktree clean.
**검수** 1차 **REQUEST_CHANGES** — 1·2·4·5·6 OK, **3b FAIL**(§3.1 결함 A). 2차(02:32~02:36 KST)
**APPROVE** — 삼킴 0/0, EOF 0, 뮤테이션 2방향 RED 2/18, 복원 `5940cd98` 바이트 동일.
**미확인 4**: WebFetch 실발화 · MultiEdit/NotebookEdit 매치 · 구 호스트 문법 · 242 vs 239
3줄 차이(계수 기준). **부수**: 창이 JSDoc 안 주석 종료 토큰으로 주석을 조기 종료한 사고를
자기보고했다(기록된 함정의 재현, 커밋 전 포착).

### 2.3 l2-c10-trail

**목표** Check 10 신설(미결합 receipt ↔ unbound bind 나란히) · trail D9 동결(TR-1~3, C안) ·
Check 7 을 projectRoot 단일 루트로 재작성. **게이트**(02:42 리더 재실측) **30스위트 736/736
+ 2 skip** · worktree clean · Check 10 이 `doctor.md` 에 2회 언급. 창 자체 측정은 표적 A
41파일 · 훅 8파일 68 · firewall 65/66(1 RED = `ups-host-schema-drift`, 환경) · eslint 22파일 0.
**검수**(02:41~02:45, 리더측) **APPROVE** — 호출자 전수 표, 어휘 allowlist fail-closed 뮤테이션
RED(node 프로브), Check 7 sha `f9cbd1a6` 독립 일치, `route-bind` 순수(상태파일 0),
`recordSignal` 판정 코드상 참, 24/24 범위 안, **49파일 1109/1109**.
**비차단 4**: `pruneDecisionTrail` 의 `enabled` 미참조 · `readSpawns` 부재 시 빈 배열이
거짓 그린이 될 수 있는 지점 · `auto-pr-creator.test` 죽은 mock · 인용 오류 0.
**부수**: 트레일러가 마지막 블록 밖이라 파서가 빈 값을 읽어 `016f6956` 을 amend 로 교체한
뒤 푸시했다. 음성대조 M2 가 거짓 그린이라 `_recordForTest` 시임을 넣었다. 스폰 3 / 원장 8행.

### 2.4 model-d

**목표** D안 `investigator` · `auditor` 신설(fable 티어) · B안 nature 태깅 문서 · MP-4(iii)
`review.claim_audit` 어휘·파서.
**게이트**(02:39 리더 재실측) `validate-model-policy` drift 0 · readme claims GREEN ·
에이전트 **31**(= 30 + INDEX) · allowlist **10** / high **23** · **6스위트 317/317**.
창 재검증은 `validate-model-policy` 30/30 · B 271/271 · C 631/631.
**검수** 1차 **REQUEST_CHANGES**(fable reviewer) — 3점 PASS, 차단 1 = `tests/mcp/server.test.js`
의 total 28 핀(소유 밖) → 리더 재실측 일치 → 소유 부여. 2차(02:38~02:43, 리더측, worktree
무수정 `e3b0c442`) **APPROVE** — MP-1~5 정합, allowlist 순수 추가(키 집합 동일),
`FABLE_DENYLIST` · action-classifier blob 동일, `parseClaimAudit` 3형 + 뮤테이션 6/80 RED →
복원 동일, 픽스처 VERBATIM 실출력.
**미확인**: 실효 모델이 fable 인지 · 스폰 원장 canonicalModel 0/30.
**정정**: 창 보고 24파일은 wip 19 + done 5 합산 오기(겹침 4) → **20** 이 정본, 브랜치 diff 와 일치.

### 2.5 팬아웃 (스폰 원장 `.artibot/split/<limb>/spawns.ndjson`, 기록자 `wc -l` 재실측)

| 줄기 | 원장 행 | 팬아웃 |
|---|---|---|
| `ci-scope` | **파일 없음** | **0** — 창이 "Agent 정책 거부" 문구를 믿고 스폰하지 않았다 |
| `hooks-fix` | 1 | **0** — 같은 사유(4/4 창 전부 거부 문구 수신) |
| `l2-c10-trail` | 9 | 팀원 3(probe · reviewer · mutation) |
| `model-d` | 31 | 팀원 3 + 검수자 1 + 신설 정의 2종 실스폰 |
| **합계** | **41** | — |

분모 0 두 줄기는 추정이 아니라 **실측**이다(§3.4 ②의 직접 피해). model-d 31행은 run-log 의
"원장 30행"과 1행 차이 — 계수 기준(헤더/개행) 차이로 보이며 **미조정**.

### 2.6 lock-harness (wave 2)

**미착수**. `plan.json` 에 등재되고 브리프도 있으나 worktree 는 생성되지 않았다
(`git worktree list` 기준 4개뿐, 보고서 작성 시각). base 는 wave 1 착지분 `4fc75c8a`. 과제는
회고 #40 — `landing-serialization.test.js` 의 그린이 직렬화 증거가 아니므로 하네스와 락을 분리 실측하는 일.

---

## 3. 교훈 원장

### 3.1 그린 상태 실결함 2건

**A. `stripBlockComments` fail-open**(hooks-fix, 검수자 포착). `stop-review-gate.js` 의 블록
주석 제거가 **줄 중간의 미종결 오프너**를 열어 그 뒤를 통째로 삼켰다. 창 재대조로
`c012ac37` 에서 **12파일 242줄**(검수자 계수로는 13파일 331줄 — 계수 기준 차이, 방향 동일),
그중 6파일은 EOF 까지이며 `stop-review-gate.js` 자신도 포함된다. **출력은 불변**이라 표적
스위트는 전건 그린이었고 손실된 것은 게이트 커버리지다. 수리는 줄 주석 선적용 + 미종결
오프너는 줄머리만 인정 + 회귀 테스트 1건. 재작업 `0dce8541` 에서 삼킴 0 / EOF 0.

**B. 배치 CI 만 보는 소유 밖 핀 3건**. `marketplace.json` 의 agents.count 28 ·
`validate-model-policy.test` 의 allowlist 8 · `userprompt-dispatcher-resilience` 의
timeout 15000ms. 어느 줄기의 표적 스위트에도 안 걸리고, 4줄기를 합친 배치 전체 스위트에서만
RED 가 된다(Node 20/22/24 동일). integrate 2회차가 유일한 검출 지점이었다.

### 3.2 gotcha 델타 2건 (`.artibot/split/gotchas.md`, 정본 번호는 #61 다음)

| # | 한 줄 | 분류 | 코드 수리 |
|---|---|---|---|
| 62 | "정책 거부 — Agent" 문구는 **오탐**이다. 리더·model-d 창 모두 그 문구를 받고도 Agent 스폰에 성공했다. 문구만 보고 단독 구현으로 가지 말고 저비용 프로브 1회로 확인하라 | 호스트 관측 | 아니오 |
| 63 | 리더 러너 스크립트를 `plugins/artibot` 안에 두지 마라. pre-push 가 그 디렉터리에서 `eslint .` 를 돌린다. 임시 스크립트는 stdin 모듈로, 파일이 필요하면 리포 밖 절대 URL import | 리더 오류 | 도구(문서) |

### 3.3 리더 오류 4패턴

| # | 오류 | 실측 근거 | 재발 |
|---|---|---|---|
| L-1 | **`plan.json#affectedPaths` 가 브리프보다 좁다** → land ownership 1회차 FAIL. land 매처는 **파일명 접두를 지원하지 않는다** | hooks-fix FAIL 4(02:14) · model-d FAIL 5(02:39) · l2 FAIL 3(02:42, 접두 `decision-trail*` 를 매처가 못 봄) | **3줄기 3회**. `ci-scope` 는 1회차 PASS. run-log 의 "3번째/4번째" 서수는 리더 **과다 계수**였다(리더 정정 2026-09-05) |
| L-2 | 러너 스크립트 위치 사고 | integrate 1회차 push-failed(02:50), no-undef 7건 | 1회 |
| L-3 | **브리프 인용 오기 3건** | ① `tests/scripts/cron/` 은 존재하지 않는 경로였다(l2 정정) ② `validate.js` 에 숫자 핀이 없다(model-d 검수자 확인, 브리프는 "로스터 핀 28→30" 이라 썼다) ③ trail unique writer "2" 는 과소 — 실제 **5파일** | 3건 전부 창·검수자가 교정 |
| L-4 | 검수자 근거를 그대로 올릴 뻔함 | README code-reviewer Role 셀 — 검수자는 옛 "4단계 심각도"를 거짓이라 했으나, `code-reviewer.md#심각도` 는 4등급이고 다른 절이 3단이다. 한 축만 본 것이지 거짓이 아니다 | 리더가 근거 등급을 "정정"에서 "표현 교체"로 낮춰 자기교정(02:45) |

### 3.4 라이브 실증 3건

**① hooks.json 매처 A/B**(host 2.1.260, `--settings` · `--plugin-dir` 두 로더 동일).
`tool == "X"` 는 **절대 불일치**, `||` 표현식은 **전 도구 매치**. 따라서 4.55.0 라이브에서
`pre-bash` · `bash-risk-guard` 는 **발화 0**, write 계열 4훅은 Bash/Read/Agent 에도 발화했다.
표현식 매처는 `171f7a89`(2026-02-20)부터 존재 — **그 이후 호스트 문법의 동일성은 미확인**.

**② Agent 정책 거부 문구 오탐**(§3.2 #62). 4/4 창이 이 문구 때문에 첫 30분을 단독 구현으로
보냈고, 02:19 오너 지시 후 리더 프로브 1회로 뒤집혔다.

**③ 신설 에이전트 실스폰**. `auditor` · `investigator` 정의 파일의 라이브 로드를 실스폰으로
확인했고, `auditor` 가 팀원 B 의 보고를 **2/28 반증**했다(README:1246 orchestrator 티어 정정).
다만 `canonicalModel` 은 **구조적으로 측정 불가**다 — SubagentStart 페이로드에 model 필드가
없고(investigator 0/15 non-null), `route-observe-pre.js` 의 `TOOL_INPUT_KEYS` 에 model 이
있으나 소비처가 0이다. **실효 모델이 fable 인지는 미확인.** 부수 E2E 결함 1건: `auditor`
실출력이 펜스 없는 JSON 한 줄이라 `parseClaimAudit` 가 `no_claim_audit` 를 반환했다
→ 줄 단위 bare 검출 + 정의 파일 펜스 강제로 수리.

### 3.5 설계안 정정 (통합 후속, 정본 문서에 반영 필요)

| 정본 | 정정 |
|---|---|
| `DESIGN-DOCS-CHECK-scope-artibot.md` | 바닥값 **93 → 95**(guides 77) · 렌더링 15건의 원인은 "파이프 이스케이프"가 아니라 **4번째 셀 누락** · **#56 은 링크드 worktree 와 무관**하다 — `GIT_DIR` 만 있으면 메인 리포에서도 재현(1975 vs 1822) |
| `DESIGN-TRAIL-migration-projectRoot.md` | unique writer **"2" 는 과소** — `user-profile.js` · `auto-pr-creator.js` 4곳 **+ cron 러너 3파일**이 DI 기본값으로 import = **5파일**. 어휘는 cron **4파일 공통 1종 + user-profile 1종 = 2종** |
| `ARTIBOT-5.0-DESIGN.md` §1.6 (MODEL-POLICY) | `team.md:155` **부재** · `scripts/validate.js` 에 **숫자 핀 부재**(브리프 오기) |

---

## 4. 후속 목록

`plan.json#leaderIntegration` 전건(착지분 제외 잔여) + gotcha 델타.

| 후속 | 출처 | 상태 |
|---|---|---|
| `~/.claude/rules/artibot/agent-coordination.md` 28/28 → 30, fable 8/28 → 10/30 | model-d 부수 관찰 | 리포 밖(리더 별도) |
| 잔존 "28" 산문 census — CONTRIBUTING · INSTALL · `AGENTS.md:4` · `mcp-server.json:6` · 주석 2 · `_marketplace` · cowork README | model-d 검수 | 게이트 무관, 미착수 |
| `review.claim_audit` writer 배선 **0** | model-d 검수자 누락 기록 | 다음 줄기 후보 |
| `route-observe-pre.js` 가 `tool_input.model` 을 route.selected 로 소비 | investigator 실측 | 다음 줄기 후보 |
| `land.mjs` lint 행이 브랜치 신규 파일을 메인 체크아웃에서 찾아 FAIL | model-d 실측(`tests/review/claim-audit.test.js` 로 "No files matching") | **수리 필요** — worktree cwd 또는 임시본으로 |
| `tests/cron/auto-pr-creator.test.js` 죽은 mock 3줄 | l2 검수 #5 | 보류 |
| `plugin-init-flow.test.js` 의 ms 문구 | hooks-fix | 미착수 |
| `cowork-skill-gates` :21/:68 낡은 주석 | model-d 창 관찰(소유 밖) | 미착수 |
| `.artibot/split/gotchas.md` 델타 2건을 정본 §7 로 이관 | 이 리포 §3.2 | 미착수 |
| **integrate 재실행 시 `run` 세그먼트 end 중복** — 회차마다 닫혀 unpaired end 2 | 텔레메트리 실측(§1.1) | **수리 필요**(리더 러너) |
| wave 2 `lock-harness` dispatch | `plan.json#wave2` | **대기** |

---

## 5. 이 리포가 재지 않은 것

게이트 옆에 못 보는 것을 적는다 — 안 적으면 이 문서의 그린이 다음 착시의 근거가 된다.

- **`DISPATCH` phase · `wait-limbs` 세그먼트 미기록**(런 2호에는 있었다) → dispatch 소요와
  줄기 작업 구간 경계는 **미측정**이고 §1.2 의 01:56~02:42 는 run-log 분 단위 수기다.
- **`run` unpaired end 2** 로 `summarizeWallClock` 총 소요(3h04m47s)는 착지가 아니라
  **integrate 1회차 실패 시점**에서 끊긴 값이다 — §1.1 에 두 값을 나란히 뒀다.
- **전체 vitest 미실행.** §2 는 표적 스위트, 배치 전체 스위트는 integrate CI 판정 인용.
- **매처 평문화 착지 후** `pre-bash` · `bash-risk-guard` 의 실발화 재개는 **미확인**.
- **워킹트리 비정지.** 작성 중 리더의 **4.56.0 릴리스 범프**로 12파일이 수정 중이었다(리더
  확인). §2 는 커밋 객체 기준이라 무영향, `docs:check` 두 번만 그 트리 위에서 잰 값이다.
