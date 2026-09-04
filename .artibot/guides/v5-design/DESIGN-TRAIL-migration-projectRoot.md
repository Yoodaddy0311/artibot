# 설계안 — `decision-trail.json` 의 pluginRoot 이탈: 이관인가 동결인가

> **오너 승인 전 구현 금지.** 설계안이다. 코드·테스트·config 무변경. 이 파일 1개만 신설했다.
> 작성: architect (team-handoff-9d6dc2, fable), 2026-09-04 14:5x–15:1x KST · 기준 master @ `ca013e2c` (v4.54.0) · 경로는 `plugins/artibot/` 기준. 줄번호는 14:5x 워킹트리 측정값.
> 근거 정본: `ARTIBOT-5.0-DESIGN.md` 후속 16(`:777` — 트레일 3곳 pluginRoot 고정, Check 7 S6 근거 문장 거짓, "**트레일 이관은 이번 범위 밖.** 다음 결정으로 올릴 것") · 부록 0-2 후속(2) `:908` ⑤ 보류 · **§5 D9 "`decision-trail.json` 처분 — dual-write 후 읽기 전용 동결"**(`:314`, 레인 6 권고, 오너 미결) · 결정 D(`:680` decisions 스토어 projectRoot 이전, 이행 `bc2e9e55`) · OD-4(`:20` StateStore 위치 = `git rev-parse --git-common-dir` 아래) · 후속 18(`:979~` 캐시 6디렉터리 미러) · 오너 15:0x "docs:check·trail 설계안 작성".

---

## 0. 한 줄 판정

트레일은 **pluginRoot 기준 RMW 단일 JSON**(`lib/core/decision-trail.js:22 getPluginRoot` · `:32 DEFAULT_PATH` · `:95 resolveTrailPath`)이고, 오늘 라이브 파일은 **캐시 `4.54.0/runtime/decision-trail.json` 9건(14:47)** 이며 다른 캐시 5디렉터리엔 파일이 없다 — `claude plugin update` 마다 **트레일이 0 에서 다시 시작**한다(결정 D 가 decisions 스토어를 옮긴 이유 그대로). 리더 질문 "projectRoot 로 옮길지"에 대한 답: **정본 §5 D9 가 이미 "dual-write 후 읽기 전용 동결"을 권고**하고 있고, 트레일의 4 writer 중 2(cognitive-router·runtime-prompt)는 **decisions 스토어(projectRoot, 결정 D)가 이미 같은 사실을 기록**한다. 따라서 권장은 **이관(A/B)이 아니라 D9 실행(C)**: 남은 unique writer 2(user-profile·auto-pr-creator)를 projectRoot 스토어로 옮기고, 트레일은 **읽기 전용 동결**(config 킬스위치 1키), `/doctor` Check 7 은 **한 루트만** 본다. 파일 이전은 없다 — 기존 972건(dev 리포)·9건(캐시)은 아카이브로 남긴다. A(projectRoot 이관)는 RMW 손실(35%, 정본 `:73`)을 그대로 옮기는 것이라 불채택, B(git-common-dir)는 decisions 스토어 선례(`.artibot/runtime/`, worktree 별)와 위치가 갈려 두 진실원이 된다.

---

## 1. 현행 실측

### 1.1 모듈 — `lib/core/decision-trail.js` (369줄, 직접 읽음)
| 항목 | 값 |
|---|---|
| 저장 형식 | 단일 JSON `{ entries[], metadata{createdAt,lastUpdated,totalAppended,lastPruned} }`, `MAX_ENTRIES=5000`(`:34`), `retentionDays` 30 |
| 경로 | `resolveTrailPath(pluginRoot)`(`:91-96`) = `cfg.path` 가 절대면 그대로, 아니면 `path.join(pluginRoot ?? getPluginRoot(), 'runtime/decision-trail.json')`. config 는 `<pluginRoot>/artibot.config.json#ago.decisionTrail`(`:62`) — `{enabled:true, path:'runtime/decision-trail.json', retentionDays:30, redactSensitive:true}` |
| 쓰기 | `recordDecision :190` — `readTrailSync → push → atomicWriteJsonSync` **RMW**. 본문 주석 `:21-31` 이 lost-update 를 자인("needs a file lock or an append-only format, and is out of scope") |
| 손실 실측 | 정본 `:73`·`:212` "60건 중 21건 35% 소실(08-28)"; `event-writer.js:55` 도 같은 수치를 인용해 append-only 를 택한 근거로 삼음 |
| 읽기 | `queryDecisions :273`·`getDecisionStats :336`·`pruneDecisionTrail :307` — 소비처는 `commands/doctor.md` Check 7 뿐(`:120-122` "import getDecisionStats"); `lib/core/index.js` 재수출 |

### 1.2 writer 4 (호출 실측)
| writer | 위치 | pluginRoot 핀 | 같은 사실을 쓰는 다른 스토어 |
|---|---|---|---|
| `cognitive-router` | `lib/cognitive/router.js:385-387` (`getPluginRoot()` 를 **캡처해** `recordDecision(..., {pluginRoot})`) | 예 | **decisions 스토어** `routing-classified`(T-37, `lib/observability/decision-events.js`) — 동일 분류 결과 |
| `runtime-prompt` | `scripts/hooks/runtime-prompt.js:546-556 recordEffortDecision` — `recordDecision()` 을 **옵션 없이** 호출(경로는 호출 시각의 env) | 아니오 | decisions 스토어(`runtime-prompt` 가 T-37 계측을 같은 훅에서 씀 — `effort-classified` 와 1:1 인지는 **미확인**) |
| `user-profile` | `lib/core/user-profile.js:379` | (미열람) | **없음** — unique |
| `auto-pr-creator` | `scripts/cron/auto-pr-creator.js:246,316,351,361` | (미열람) | **없음** — unique(cron) |

라이브 분포(캐시 4.54.0, 9건, 02:05~05:47Z): runtime-prompt 7 · user-profile 2. dev 리포 로컬(`plugins/artibot/runtime/decision-trail.json`, 383,841 B, 972건, 07-31~09-03): cognitive-router 499 · runtime-prompt 332 · user-profile 140 · auto-macro-register 1. **정본 `:212` "971건"** 과 1 차이(09-03 00:12 마지막 1건).

### 1.3 두 루트 문제 — `/doctor` Check 7 (`commands/doctor.md:112-230`)
- 트레일 = `<pluginRoot>/runtime/decision-trail.json`, 이벤트 = `<projectRoot>/.artibot/runtime/decisions/`(`:187-192` "Since 2026-09-03 these are two different trees").
- **S3**(`:158`)의 활동 시각 원천 3개 중 2개(`runtime/current-effort.json` updatedAt·mtime)도 **pluginRoot** 다 — 즉 S3 는 "플러그인 루트의 활동 vs 프로젝트 루트의 기록"을 비교한다. doctor 팀원 실측(정본 `:973`): 라이브 루트 기준 S4~S6 false = pass, 다른 루트를 잡으면 warn — 판정이 **어느 루트를 열었느냐**에 달린다.
- **S6**(`:201`) "live records exist but trail does not" — 두 트리가 다르므로 "다른 프로젝트의 이벤트" 라는 무해한 설명이 생겨 `:222-228` CAVEAT 로만 막혀 있다(후속 16 마지막 문장 "현재는 S6 오독 방지 문구로만").
- `doctor-checks.js` 에 Check 7 코드 없음(`checkLedgerStateParity :254`·`checkArtifactHealth :771` 뿐) — Check 7 은 **산문 절차**(모델이 실행).

### 1.4 캐시 미러(후속 18)와의 상호작용
`~/.claude/plugins/cache/artibot/artibot/{4.47,4.49,4.50,4.51,4.53,4.54}.0/`: **코드는 6/6 4.54.0**(`install.sh` 미러, `:979-985`)이지만 **트레일 파일은 `4.54.0` 1개뿐**(3,635 B, 9건). 즉 미러는 코드만 복사하고 `runtime/` 은 각자 — `plugin update` 로 활성 디렉터리가 바뀌면 트레일은 **새 파일**이다. 정본이 decisions 스토어를 옮긴 근거(`:680` "`claude plugin update` 가 pluginRoot 를 교체하면 KPI 분모 소실 위험")가 트레일에 **그대로 성립**한다.

### 1.5 projectRoot 쪽 현황
`<root>/.artibot/runtime/`: `decisions/`(`_unattributed.events.ndjson` 215 B 1파일 — 후속 12) · `ledger.jsonl`(6,824 B, 14:54). `.git/artibot/` **부재** — OD-4 의 StateStore(git-common-dir)는 아직 사용 0(Check 8 unmeasured `:975`). `resolveProjectRoot`(`lib/git/project-root.js:11-13`)는 worktree 에서 **worktree 루트**를 돌려주므로 `.artibot/runtime/` 은 **worktree 별**이다(split 4창 = 4스토어).

### 1.6 테스트 계약(루트를 바꾸면 깨지는 것)
- `tests/core/decision-trail-path-isolation.test.js` — `assertNotRealRoot` 가 **`getPluginRoot()`** 와 비교(헤더 `:1-22`). 루트 의미가 바뀌면 단언 대상이 바뀐다.
- `tests/helpers/trail-sandbox.js` — `CLAUDE_PLUGIN_ROOT` 를 임시 루트로 핀(헤더 `:4-9`). projectRoot 기준이 되면 이 헬퍼는 격리를 **못 한다**.
- `tests/firewall/trail-sandbox-required.test.js:87-97 MECHANISMS` = `useTrailSandbox` · self-pinned `CLAUDE_PLUGIN_ROOT` 2종 — 새 기전(cwd/`storeDir` 주입)이 없으면 이관 뒤 모든 트레일 writer 테스트가 **미격리로 RED**(또는 더 나쁘게, 실 `.artibot/runtime/` 오염 — 후속 12 3회 재발 클래스).
- 참조 13파일(`grep -rln decision-trail tests`) 중 위 3 + `decision-trail.test.js`·`-concurrency.test.js`·`runtime-prompt-decision-wiring.test.js`·`decision-events-t37.test.js`·`auto-pr-creator.test.js`·`artifact-governance.test.js`·`ledger-append-survival.test.js`.

---

## 2. 대안 비교

| 안 | 내용 | 변경 지점 | 손실·이중 진실원 | 되돌리기 | 판정 |
|---|---|---|---|---|---|
| **A0** config 만 | `ago.decisionTrail.path` 를 **절대 경로**로(코드 0 — `:93` 이 절대 경로를 허용) | `artibot.config.json` 1키 | 절대 경로는 머신 종속 → 설치본·CI·다른 머신에서 다른 곳. RMW 손실 그대로 | 1키 | **불채택**(포터블 아님) |
| **A** projectRoot 이관 | `resolveTrailPath` 를 `resolveProjectRoot(cwd)/.artibot/runtime/decision-trail.json` 로(결정 D 의 decisions 스토어와 같은 트리) | `decision-trail.js:22,32,91-96` + writer 4 에 `cwd` 전달(router·runtime-prompt·user-profile·cron) + §1.6 테스트 3 + 새 격리 기전 + `doctor.md` Check 7 경로 문구 | **RMW 35% 손실을 옮길 뿐**. decisions 스토어와 **같은 사실을 두 형식으로**(router·runtime-prompt) — 이중 진실원 유지 | config `trail.root: 'plugin'\|'project'` 1키 | **불채택** — 정본 §3.6 "usage.receipt 단일 writer"·D9 방향과 반대 |
| **B** git-common-dir 이관 | `<git-common-dir>/artibot/decision-trail.json`(OD-4 StateStore 자리) | A + `resolveStoreLocation`(`state-manager.js:132`) 재사용 | worktree 4창이 **한 파일에 RMW** → 손실 증가. decisions 스토어(worktree 별)와 위치 불일치 = 세 번째 트리 | 1키 | **불채택** |
| **C** D9 실행 — 동결 + unique writer 이전 | ① `ago.decisionTrail.enabled` 를 **킬스위치로 재정의**(false = `recordDecision` no-op, 읽기는 유지) — 이미 `:69 enabled: trail.enabled !== false` 가 있음, 기본값만 `false` 로 ② unique writer 2(user-profile·auto-pr-creator)를 **decisions 스토어**(`appendRunEvent`, projectRoot)로 — 어휘 2종 추가는 **allowlist 필수**(정본 `:645` "두 번째 writer 가 생기면 fail-closed allowlist") ③ router·runtime-prompt 의 트레일 호출은 **삭제**(decisions 스토어가 이미 기록) ④ Check 7 을 **projectRoot 단일 루트**로 재작성: S6 폐기, S3 활동 원천을 `ledger.jsonl`/`decisions/*.events.ndjson` mtime 으로, 트레일 행은 "legacy(frozen) — exists/entries" 정보 행 1개 ⑤ 기존 파일 **이전 없음**: 972건(dev)·9건(캐시)은 그대로 두고 `queryDecisions` 로 읽기만 | `decision-trail.js`(기본값 1줄 + JSDoc) · `router.js:385-395` · `runtime-prompt.js:546-556` · `user-profile.js:379` · `auto-pr-creator.js` 4곳 · `decision-events.js`(어휘 +2, allowlist 신설) · `doctor.md` Check 7 · 테스트 §1.6 + `decision-events-t37` · `artibot.config.json` 1키 | 손실 경로 **폐쇄**(append-only 로 통일). 진실원 1(projectRoot) | `enabled:true` 1키 + 4 writer 호출 원복(revert 1커밋) | **채택(권장)** — 정본 D9 와 정합, `plugin update` 분모 소실 해소, worktree 별 스토어라 split 창과도 정합 |

**C 의 부작용 2건(솔직히)**: (1) `user-profile`·`auto-pr-creator` 는 **프로젝트 밖 문맥**(cron, 홈 스코프)에서도 돈다 — projectRoot 가 없으면 decisions 스토어는 `_unattributed`/cwd 폴백(후속 12) → **p2 의 B 안(세션 없으면 stderr) 이 착지한 뒤에만** 안전. (2) 트레일 동결 후 `/doctor` 가 "트레일 0 증가" 를 S3 로 오독하지 않게 ④ 가 **같은 커밋**에 있어야 한다.

---

## 3. 소유 파일 · 겹침 대조 (2차 4줄기 + 3차 L2 Check 10)

| 파일 | 2차/3차 소유자 | 판정 |
|---|---|---|
| `lib/core/decision-trail.js` · `lib/core/user-profile.js` · `scripts/cron/auto-pr-creator.js` · `lib/cognitive/router.js` | 없음 | 0 |
| **`scripts/hooks/runtime-prompt.js`** | **l1-ups(2차)** | **겹침** → C-③ 의 runtime-prompt 호출 삭제는 l1-ups 착지 **후** |
| **`lib/observability/decision-events.js`** | **p2-f12-f19(1차, 진행 중)** | 겹침 → p2 통합 후 |
| **`commands/doctor.md`** | l3-f30-g1(1차, Check 8) · 3차 L2 **Check 10** | 겹침 → Check 7 재작성은 Check 10 과 **같은 3차 줄기**로 묶는 것이 맞다(둘 다 Check 7~10 산문) |
| `tests/firewall/trail-sandbox-required.test.js` · `tests/helpers/trail-sandbox.js` · `tests/core/decision-trail*.test.js` | 없음(test-git-sandbox 는 읽기만) | 0 |
| `artibot.config.json` | l1-ups(2차) | 겹침 → 1키 추가는 리더 통합 시(receiptStage 와 같은 처리) |
| `schemas/ledger-events.allowlist.json` | l2-d1(2차) | C 는 ledger.jsonl 이 아니라 decisions 스토어 어휘라 **무관** — 단 오너가 "ledger.jsonl 로" 를 택하면 겹침 |

→ **이 설계는 2차에 못 들어간다**(runtime-prompt·config·doctor.md 3겹침). **3차, L2 Check 10 과 같은 줄기** 권장.

## 4. 완료 판정
| | 기준 | 증거 |
|---|---|---|
| D1 | `enabled:false` 기본에서 4 writer 가 트레일 파일을 **생성하지 않음**(샌드박스 루트에서 파일 부재) + decisions 스토어에 user-profile·auto-pr 어휘 2종 append, allowlist 밖 어휘 RED | 테스트 로그 |
| D2 | `/doctor` Check 7 이 **루트 1개**를 보고하고 S6 행이 사라짐, S3 가 `.artibot/runtime/` 시각으로 판정 | doctor 출력 |
| D3 | 라이브: `plugin update` 후 새 세션에서 decisions 스토어 줄 수가 **이어서 증가**(트레일처럼 0 리셋 아님) — 분모·시각 | `wc -l` 전후 |
| D4 | 리포 전체 vitest + `trail-sandbox-required` GREEN(기전 목록 확장 시 자기검증 포함) | 출력 |

## 5. 오너 결정 필요 항목 (신규 방향만)
| # | 질문 | 권장 |
|---|---|---|
| 1 | D9(동결) 를 **지금 실행**하는가, 아니면 "dual-write 기간"을 더 둘 것인가 — D9 원문은 "dual-write **후** 동결" | **지금** — dual-write 는 router·runtime-prompt 에서 이미 사실상 진행 중(decisions 스토어 T-37 착지 09-02), 남은 것은 unique writer 2 |
| 2 | unique writer 2 의 목적지: decisions 스토어(`.artibot/runtime/decisions/`, 권장) vs `ledger.jsonl`(v5 중앙 원장) | decisions 스토어 — `user-profile`·cron 은 미션 이벤트가 아니라 관측 사이드채널(정본 `:645` 어휘 5종과 같은 급) |
| 3 | 기존 트레일 파일(972·9건) — 그대로 두기(권장) / `.artibot/archive/` 로 복사 / 삭제 | 그대로 — 읽기 함수 유지, 삭제 권한은 사람 |
(이미 결정: decisions 스토어 = projectRoot(D) · StateStore = git-common-dir(OD-4) · 후속 12 차단안 B+D.)

## 6. 못 보는 것
1. `runtime/current-effort.json`(S3 원천)도 pluginRoot — C-④ 가 이걸 원천에서 빼면 "슬래시 커맨드 활동" 신호가 사라진다. 대체 = decisions 스토어의 `routing-classified` 줄 mtime(같은 훅이 쓴다).
2. cron writer 는 projectRoot 가 없는 문맥 — p2 B 안 선행 없이는 후속 12 를 재생산한다.
3. 트레일이 동결되면 `queryDecisions` 소비처 0 은 그대로 — "읽는 코드 0" 문제는 이 설계가 풀지 않는다(Check 7 만 읽는다).

## 미확인
- `runtime-prompt.js` `effort-classified`(트레일)와 T-37 `routing-classified`(decisions)가 1:1 인지 — 두 코드 경로 대조 미실시.
- `user-profile.js:379`·`auto-pr-creator.js` 4곳의 호출 옵션(`pluginRoot` 핀 여부) — 줄번호만 grep, 본문 미열람.
- 캐시 `4.54.0` 트레일 9건이 오늘 리더 세션 것인지(02:05Z 시작 = 11:05 KST, 세션 시각과 일치 — 추론).
- 정본 `:212` 971 vs 실측 972 의 1건 차이 원인(09-03 00:12Z 마지막 항목 — 시각 관측 차로 추정).
- `plugin update` 가 캐시 디렉터리를 새로 만드는지 재사용하는지(후속 18 미확인과 동일) — D3 판정의 전제.

## 정정 — 3차 배치 l2-c10-trail 실측 (2026-09-05, master 4fc75c8a)

| 설계 문구 | 실측 | 정정 |
|---|---|---|
| §1.2 "writer 4 · unique writer 2(user-profile·auto-pr-creator)" | `grep -rn recordDecision lib scripts` 호출자 = router · runtime-prompt · user-profile · auto-pr-creator(4곳) · **auto-cleanup-runner · auto-commit-runner · auto-macro-register-runner**(DI 기본값 `trail = recordDecision`) | unique writer 는 **5파일**(cron 4 + user-profile). 어휘는 `self-control-decided`(cron 4 공통, subsystem 4·action 13 allowlist) + `skill-level-changed` = 2종 |
| §2 C-① "기본값만 false" | `artibot.config.json#ago.decisionTrail.enabled` 가 `true` 였다(:1202) | 코드 기본값만으로는 라이브 킬스위치가 안 걸린다 → 리더 통합분에서 config 도 `false`(a57cec7c) |
| §4 D1~D4 | D1·D2·D4 착지(1294b7fd, Check 7 재동결 68a73087 → f9cbd1a6). D3(plugin update 후 연속 증가)는 4.56.0 설치 후 판정 | D3 = 미확인(릴리스 후) |
| 미확인 3 "plugin update 캐시 재사용" | 4.55.0 update 는 새 디렉터리 `cache/artibot/artibot/4.55.0` 생성(리더 실측 2026-09-04) | 새 디렉터리 — 트레일이 있었다면 0 리셋. 동결로 무관해짐 |

비차단 관찰(검수): `pruneDecisionTrail` 은 `enabled` 미참조(호출자 0) · `readSpawns` 는 파일 부재를 `[]` 로 접는다(프로즈가 `undefined` 구분을 진다).
