# /split 실오퍼레이터 런 리포트 — split-9d6dc2

**런 2호.** 런 1호(`split-8f83d7`, 2026-08-27)에 이어 두 번째 실오퍼레이터 완주다.
n=2 — 이 문서도 존재 증명이지 성능 주장이 아니다. `/split` vs `/autopilot --fast` 속도
비교는 여전히 이 데이터로 주장할 수 없다. 런 1호와 달리 이번 런의 핵심 산출물은
**교훈 원장 37건**(§3)이며, 그중 7건은 코드 결함, 5건은 리더 자기 오류다.

| 항목 | 값 |
|---|---|
| runId | `split-9d6dc2` |
| sid | `9d6dc2` |
| 실행일 | 2026-09-04 (11:40–13:32 KST, 마지막 이벤트 기준) |
| base | `7cbb37b9dfaafa2b38c1aafc5690467a8708f294` |
| parentSession | `artibot-e4` |
| 줄기 | **4건** — `l4-f10` · `l3-f30-g1` · `p2-f12-f19` · `l2-probe` |
| 계획 | `profile: fast`, plannedParallelism **4**, worktrees 4, `fallbackReason: null`, waves 1개(4줄기 동시), conflictGroups **0** |
| 랜딩 | **landed** — 배치 SHA `520886bd7cb4de0a745d99b819b6ce9ab6e0131d`, base `ca013e2c`, **rebuilds 0**, `wait_for_green` 폴링 33회 (13:32:31 KST, `merge(split): fold … [4/4]`) |
| 랜딩 검증 | `master` tip == `520886bd` **일치** · 4줄기 tip 전부 master 조상 **4/4** · `ca013e2c` 는 landing 의 조상 (기록자 재확인) |
| 증거 원본 | **두 파일**(§1.3 — 루트가 갈렸다): `plugins/artibot/runtime/split/split-9d6dc2.events.ndjson`(13건) + `~/.claude/plugins/cache/artibot/artibot/4.54.0/runtime/split/split-9d6dc2.events.ndjson`(5건) = **18** |
| 교훈 원장 | `.artibot/split/gotchas.md` — **37건**(§3 에 전문 수록) |
| 랜딩 이후 | `60dab1dd`(2026-09-04 13:57) — sessionstart 테스트 git 샌드박스 격리가 **master 에 착지**했다(기록자 확인 **14:5x 기준** master tip == `60dab1dd`, `520886bd` 는 그 조상. 이후 2차 배치가 그 위에 쌓여 master 는 더 나아갔다 — §7). 즉 gotcha #18/#22 의 **근본 수리 (1) 은 완료**다 — 교훈 #37 의 "선행 랜딩 **중**" 은 그 시점 표기이고, 지금은 **랜딩 완료**다 |
| 2차 배치 초안 | `.artibot/split/next-batch-plan.md` 365줄(architect 작성) |

---

## 0. 요약

2026-09-04 11:40 KST 에 `/split plan` 으로 4줄기를 세우고 11:53 에 창 4개를 열어 12:05 에
4/4 dispatch 했으며, 13:32 에 4줄기 전부 `Split-Limb: done` 트레일러와 land 6/6 PASS 로
INTEGRATE 에 진입해 **13:44 에 `520886bd` 로 랜딩(rebuilds 0)** 했다. 코드 산출은 4커밋 계열
합계 **29파일 / +2,393 / -216**(base 대비 재측정, §2)이고, 부수 산출은 교훈 원장 **37건**이다.
이번 런이 드러낸 가장 무거운 것은 **리포 전체 vitest 가 split 줄기 브랜치를 `artibot/` 접두로
이동시켜 완료 판독을 4/4 거짓 미완료로 만든 결함**(#18·#22)과, **창이 팀원을 안 띄우고 혼자
일한 것**(#16 — 템플릿에 팬아웃 지시가 없다)이다. 리더 자기 오류 5건이 원장에 남았고
그중 2건(#8·#15)은 같은 함정을 두 번 밟은 것이다. 텔레메트리는 실행 루트가 갈려 한 런이
두 파일로 쪼개졌고(#9), `run` 세그먼트가 끝내 닫히지 않아 **humanWaitPct 는 `null`(미측정)** 이다.

---

## 1. 런 타임라인 (KST — 사실만)

시각은 전부 텔레메트리 두 파일과 git·`run.json` 에서 읽은 값이다. UTC+9 로 환산했다.

| 시각(KST) | 사건 | 출처 |
|---|---|---|
| 11:40:29.726 | `run` 세그먼트 start (**1회째** — 이 실행은 크래시) | 소스루트 ndjson |
| 11:40:29.729 | PLAN start (**미쌍으로 남음**) | 소스루트 |
| 11:40:29.733 | `fast-profile-planned` — cpuCount 32, plannedParallelism 4 | 소스루트 |
| 11:40:45.176 | `run` 세그먼트 start (**2회째** — 재실행) | 소스루트 |
| 11:40:45.179 | PLAN start (2회째) | 소스루트 |
| 11:40:45.183 | `fast-profile-planned` (2회째) | 소스루트 |
| 11:40:45.754 | `plan.json` `createdAt` | plan.json |
| 11:40:45.756 | PLAN end — **PLAN 소요 577ms** | 소스루트 |
| ~11:53 | 창 4개 열림 (`open-windows` 세그먼트는 **기록되지 않았다**) | OPEN 이벤트 `data.note` |
| 11:55 | 창 열림 확인 | `run.json.stageTimes.opened` |
| 12:04:22.809 | OPEN start (**사후 기록** — note 가 "not recorded live" 명시) | **캐시루트** ndjson |
| 12:04:22.813 | OPEN end — 기록상 4ms(실경과 아님) | 캐시루트 |
| 12:04:22.814 | DISPATCH start | 캐시루트 |
| 12:05:39.513 | DISPATCH end — `4/4 sent`, **소요 1m16.699s** | 캐시루트 |
| 12:05:39.518 | `wait-limbs` start | 캐시루트 |
| 12:19:06 | p2 첫 팀원 스폰(`gate`) — **팬아웃 지시 이전** | p2 spawns.ndjson |
| 12:21:27 | l2 첫 스폰(`judge`) | l2 spawns.ndjson |
| 12:23:09 | l4 첫 스폰(`reviewer`) — **l4 는 이 1건이 전부다** | l4 spawns.ndjson |
| 12:25:35 · 12:25:56 | l3 첫·둘째 스폰(`verify-doctor` · `verify-g1`) | l3 spawns.ndjson |
| 12:2x | 오너가 "창이 혼자 일한다" 관찰 → 리더가 4창에 팬아웃 지시 사후 발송 (#16) | gotchas #16 |
| 12:20~13:05 | 4/4 worktree 에 `autopilot.json enabled:true` 생성 → 줄기 브랜치가 `artibot/` 접두로 이동 (#18·#22) | gotchas #18·#22 |
| 12:50:43 | **l4-f10 커밋** `91fdc4c5` | git |
| 12:59:53.796 | l4-f10 레인 `review` 진입 (land PASS) | run.json |
| 12:59:56.954 | l2-probe 레인 `review` 진입 (land PASS) | run.json |
| 13:16:35 | **l2-probe 마지막 커밋** `ee8bad80` (lint 수리) | git |
| 13:16:55 | **l3-f30-g1 커밋** `a154806d` | git |
| 13:19:15.109 | l3-f30-g1 레인 `review` 진입 | run.json |
| 13:23:58 | **p2-f12-f19 커밋** `a1170045` | git |
| 13:31:38.930 | p2-f12-f19 레인 `review` 진입 | run.json |
| 13:32:20.407 | `wait-limbs` end — **소요 5,200,889ms (1h26m40.889s)** | 소스루트 |
| 13:32:20.411 → .412 | `confirm-integrate` start → end — **1ms** (오너 위임으로 확인 생략, #29) | 소스루트 |
| 13:32:20.413 | INTEGRATE start — `data.note` "confirm skipped — owner standing authorization" | 소스루트 |
| 13:32:31 | **배치 랜딩 커밋** `520886bd` — `merge(split): fold artibot/worktree-split-artibot-p2-f12-f19 into batch [4/4]` | git |
| 13:44:10.618 | INTEGRATE end — `landed 520886bd rebuilds 0`, **소요 710,205ms (11m50.205s)** | 소스루트 |
| 13:44:10.621 | `run` 세그먼트 end (**2회째 start 와 짝** — 1회째 start 는 미쌍으로 남음) | 소스루트 |

첫 이벤트(11:40:29.726) ~ 마지막 이벤트(13:44:10.621) = **7,420,895ms (2h03m40.895s)**.
`run` 2회째 세그먼트(11:40:45.176 → 13:44:10.621)는 **7,405,445ms (2h03m25.445s)** 로 닫혔다.
다만 `summarizeWallClock` 이 반환하는 `totalMs` 는 **`null`** 이다 — §1.2 참조.

### 1.1 phase 쌍

| phase | start | end | 소요 | 판정 |
|---|---|---|---|---|
| PLAN (1회째) | 11:40:29.729 | — | `null` | **미쌍**(크래시 잔재, gotchas #3) |
| PLAN (2회째) | 11:40:45.179 | 11:40:45.756 | 577ms | 닫힘 |
| OPEN | 12:04:22.809 | 12:04:22.813 | 4ms | 닫힘 — **실경과 아님**(사후 기록, 실제 창 열기는 ~11:53) |
| DISPATCH | 12:04:22.814 | 12:05:39.513 | 76,699ms (1m16.699s) | 닫힘 |
| INTEGRATE | 13:32:20.413 | 13:44:10.618 | 710,205ms (11m50.205s) | 닫힘 |

phase 닫힌 쌍 **4** · phase 미쌍 **1**(PLAN 1회째 start — 크래시 잔재).

### 1.2 wall-clock 세그먼트

`summarizeWallClock(두 파일 병합 18이벤트)` 실행 결과(재현 명령은 §5 아래).

| 세그먼트 | humanWait | 시작(KST) | 끝(KST) | 소요 |
|---|---|---|---|---|
| `run` (1회째 — 크래시분) | false | 11:40:29.726 | — | `null` **미쌍** |
| `run` (2회째) | false | 11:40:45.176 | 13:44:10.621 | **7,405,445ms** |
| `wait-limbs` | false | 12:05:39.518 | 13:32:20.407 | **5,200,889ms** |
| `confirm-integrate` | **true** | 13:32:20.411 | 13:32:20.412 | **1ms** |
| `open-windows` | — | — | — | **기록 없음** (런 1호에는 있었다) |

`summarizeWallClock` 반환값: **`totalMs = null`** · `humanWaitMs = 1` · **`humanWaitPct = null`** ·
`unpaired = 1`(`run` start 1회째 하나뿐 — wall-clock 축만 셈).

**세그먼트 미쌍 1 + phase 미쌍 1 = 미쌍 총 2건**(두 파일 병합 기준).

#### `totalMs` 가 `null` 인 진짜 이유 — PLAN 크래시(#3)의 2차 피해

`run` 2회째가 7,405,445ms 로 **닫혔는데도** `totalMs` 는 `null` 이다. `summarizeWallClock` 은
`segments.find((s) => s.segment === RUN_SEGMENT)` 로 **첫 번째** `run` 엔트리를 집는데,
그것이 크래시로 버려진 1회째(`durationMs: null`)이기 때문이다. 즉 **#3 의 plan 스크립트
2회 크래시는 phase 미쌍 1건만 남긴 게 아니라, 이 런의 총 소요를 영구히 `null` 로 만들었다.**
`humanWaitPct` 가 미측정인 1차 원인이 이것이다.

**다음(코드 후보)**: 같은 세그먼트가 중복 start 될 때 `summarizeWallClock` 이 첫 엔트리가
아니라 **닫힌 엔트리**를 고르게 하거나(또는 마지막 start 를 정본으로), 중복 start 자체를
거부. 어느 쪽이든 record-only 원칙은 유지된다. **미확인**: 어느 선택이 옳은지는 판정하지
않았다 — 재시도 런의 총 소요를 "재시도분만" 으로 볼지 "첫 시도부터" 로 볼지가 먼저 정해져야 한다.

#### 미쌍 개수는 읽는 방식에 따라 다르다 (#9 의 2차 피해)

| 읽는 방식 | 미쌍 | 내역 |
|---|---|---|
| **두 파일 병합** (정확) | **1** | `run` start 1회째 |
| 소스루트 파일만 | 2 | `wait-limbs` **end** · `run` start 1회째 |
| 캐시루트 파일만 | 1 | `wait-limbs` **start** |
| 두 파일 따로 세서 합산 | 3 | 위 2 + 1 |

`readSplitEvents(runId)` 는 `getSplitStoreDir(opts)` **한 루트**만 읽는다. 따라서 규약대로
렌더하면 실행 위치에 따라 미쌍이 1 또는 2 로 나오고, 두 파일을 따로 세어 더하면 3 이 된다.
**병합 기준 정답은 1** 이다. 루트 고정(#9)이 되면 이 갈래 자체가 사라진다.

### 1.3 두 파일로 갈린 증거 (gotchas #9 의 실증)

같은 `runId` 의 이벤트가 실행 플러그인 루트에 따라 두 파일로 나뉘었다.

| 파일 | 이벤트 | 담긴 것 |
|---|---|---|
| `plugins/artibot/runtime/split/split-9d6dc2.events.ndjson` (소스 리포 루트) | **13** | `run` start ×2 + end · PLAN ×3 · `wait-limbs` end · `confirm-integrate` 쌍 · INTEGRATE 쌍 |
| `~/.claude/plugins/cache/artibot/artibot/4.54.0/runtime/split/split-9d6dc2.events.ndjson` (설치 캐시 루트) | **5** | OPEN 쌍 · DISPATCH 쌍 · `wait-limbs` start |
| **합계** | **18** | |

**`wait-limbs` 세그먼트는 start 가 캐시 파일에, end 가 소스 파일에 있다** — 한 파일만 읽으면
이 세그먼트는 양쪽 모두에서 미쌍으로 보인다. 즉 루트 분열은 이론적 위험이 아니라
**이번 런에서 실제로 판독을 깨뜨렸다.** 두 파일을 합쳐야만 `wait-limbs` 1h26m 이 나온다.

---

## 2. 줄기별 결과 (base `7cbb37b9` 대비 재측정, 2026-09-04 보고서 작성 시각)

재현: `git rev-list --count 7cbb37b9..<tip>` · `git diff --shortstat 7cbb37b9..<tip>` ·
`git log --format='%H %(trailers:key=Split-Limb,valueonly)' 7cbb37b9..<tip>`

| 줄기 | tip | 커밋 | 파일 | 삽입/삭제 | `Split-Limb: done` | land | 레인 상태 |
|---|---|---|---|---|---|---|---|
| `l4-f10` | `91fdc4c5` | 1 | 1 | +120 / -24 | 1/1 | 6/6 PASS | review (12:59:53) |
| `l2-probe` | `ee8bad80` | **4** | **4** | **+417 / -0** | 4/4 | 6/6 PASS | review (12:59:56) |
| `l3-f30-g1` | `a154806d` | 1 | 15 | +950 / -124 | 1/1 | 6/6 PASS | review (13:19:15) |
| `p2-f12-f19` | `a1170045` | 1 | 9 | +906 / -68 | 1/1 | 6/6 PASS | review (13:31:38) |
| **합계** | — | **7** | **29** | **+2,393 / -216** | **7/7** | 4/4 줄기 PASS | 4/4 review |

- 4줄기 전부 `land 6/6 PASS` + `eslint --max-warnings=0`(리더 재확인 13:0x~13:3x). 단
  l2 의 eslint 통과는 **리더가 잡아낸 뒤**의 상태다 — land 체크리스트에 lint 행이 없어
  6/6 PASS 상태에서도 오류 3·경고 2 가 남아 있었다(#25).
- `l2-probe` 산출: D0 프로브 판정 **D1-go**, host **2.1.260**, 3시나리오 6/6 발화,
  픽스처 `tests/hooks/fixtures/host-payloads/PreToolUse.Agent.json`. 설계 전제였던
  호스트 2.1.259 보다 1패치 위다(#19).
- **랜딩 검증(기록자 재확인)**: `git rev-parse master` == `520886bd7cb4de0a745d99b819b6ce9ab6e0131d`
  **일치**, `git merge-base --is-ancestor <tip> master` 가 4줄기 tip 전부 **YES**,
  `ca013e2c`(2차 base) 도 landing 의 조상. rebuilds **0**, `wait_for_green` 폴링 33회.
- ⚠️ **`ci/split-split-9d6dc2` 통합 브랜치는 로컬에 아직 남아 있다** — `refs/heads/ci/split-split-9d6dc2`
  = `520886bd`(기록자 `git for-each-ref` 확인). 원격에는 `ci/split-*` 가 **0건**(`origin` 에는
  `ci/sync-badges-*` 만). 런 1호의 `ci/split-split-8f83d7`(`41f7f7e9`)도 **같이 남아 있다** —
  1회성 잔재가 아니라 **누적 패턴**이다. 리더 보고의 "삭제" 는 원격 기준으로는 참일 수 있으나
  로컬 ref 로는 확인되지 않는다(**미확인**: 푸시된 적이 있는지). 접두 중복 자체는 #30.
- 4 worktree 전부 `locked` 상태로 살아 있다(`git worktree list`, 보고서 작성 시각).
- **plan.json 의 `branch` 와 `plannedBranch` 가 4/4 전부 다르다** — `artibot/worktree-split-artibot-<limb>`
  vs `worktree-split-artibot-<limb>`. 이 차이 자체가 #18·#22 훅 이동의 디스크 증거이고,
  리더가 판독 복구를 위해 `branch` 를 porcelain 실제값으로 동기화하면서 `plannedBranch` 를
  보존한 결과다.

### 2.1 줄기별 팬아웃 (스폰 원장 `<worktree>/.artibot/ledger/spawns.ndjson` 재측정)

| 줄기 | `start` 이벤트 | distinct start id | distinct stop id | **start 없는 stop** | 첫 스폰(KST) | 마지막(KST) |
|---|---|---|---|---|---|---|
| `l4-f10` | 1 | 1 | 4 | **3** | 12:23:09 | 13:10:13 |
| `l3-f30-g1` | 4 | 3 | 5 | **2** | 12:25:35 | 13:22:44 |
| `p2-f12-f19` | 8 | 4 | 10 | **6** | 12:19:06 | 13:29:22 |
| `l2-probe` | 9 | 8 | 9 | **1** | 12:21:27 | 13:20:17 |
| **합계** | **22** | **16** | **28** | **12** | — | — |

리더 브리프의 12:3x 시점 값(지시 후 p2 4 · l3 2 · l4 1 · l2 1)은 **누적 `start` 로 재현된다** —
12:33 이전 컷에서 p2 4 · l3 2 · l4 1 · l2 1 이다. 브리프는 맞다. 다만 **런 종료 시점의 최종값은
훨씬 크고**(위 표), 특히 `l4-f10` 은 **런 전체에서 팀원 1명이 전부**다(팬아웃 지시가 구현 완료
뒤에 도착했다는 브리프 설명과 정합).

⚠️ **이 관측점은 양방향으로 손실이 있다**(§4-C 신규 발견 참조): `start` 이벤트 22건이
distinct id 16개로 접히고(중복 기록), 반대로 **stop 만 있고 start 가 없는 id 가 12건**이다.
start ∪ stop = **28 distinct agent** 이므로, `start` 만 세면 팬아웃을 **최소 12건 과소계수**한다.

---

## 3. 문제점과 배울점 — 교훈 원장 37건

원문은 `.artibot/split/gotchas.md`(append-only, 리더 소유)다. 아래 §3.2 는 그 파일의
본문을 **삭제·요약 없이 번호 그대로** 옮긴 것이다. §3.1 은 본 리포트가 붙인 분류 태그다.

### 3.1 분류표

| 분류 | 건수 | 번호 |
|---|---|---|
| **리더 오류** | 4 (+1 부분) | #1 · #2 · #12 · #15 · (#26 (a)) |
| **도구·템플릿 결함** | 11 | #3 · #6 · #8 · #9 · #10 · #11 · #16 · #25 · #27 · **#30** · **#35** |
| **훅·테스트 결함** | 6 | #7 · #17 · #18 · #22 · **#32** · **#34** |
| **호스트 관측** | 3 | #5 · #19 · #20 |
| **절차 공백** | 9 (+1 부분) | #4 · #13 · #14 · #21 · #23 · #24 · #28 · #29 · **#31** · (#26 (b)) |
| 런 기록·결정(문제 아님) | 3 | **#33** · **#36** · **#37** |
| **합계** | **37** | |

**6번째 라벨을 3회 썼다**: #33(랜딩 결과) · #36(회고 정정 반영) · #37(2차 실행 형태 결정)은
"문제" 5분류 어디에도 맞지 않는다. 억지로 끼워 넣지 않고 별도 라벨로 두었다.

| # | 한 줄 | 분류 | 코드 수리 필요 |
|---|---|---|---|
| 1 | 핸드오프 전제 3건 오류(수리 커밋 해시·route_ledger 오독·"소유권 겹침 0") | 리더 오류 | 아니오 |
| 2 | 정본 `:814` "실측 확정"이 실은 시각 상관 | 리더 오류 | 아니오 |
| 3 | plan 스크립트 2회 크래시(heredoc `\` 소실 · `waves[0]` 형태) | 도구·템플릿 결함 | 문서 |
| 4 | worktree 브랜치 충돌 우회 — **#22 에서 원인이 재귀속됨**(훅 아님, vitest) | 절차 공백 | 문서(재작성) |
| 5 | `/doctor` Check 7 이 5훅 중 1훅만 관측 | 호스트 관측 | 아니오(설계 필요) |
| 6 | 캐시 미러가 구버전 6디렉터리를 덮음 — 캐시는 버전 아카이브가 아니다 | 도구·템플릿 결함 | 조사 선행 |
| 7 | `/doctor` S5 거짓 그린(`_unattributed` 를 라이브 증거로 계수) | 훅·테스트 결함 | 예(p2 안 B 가 원천 차단) |
| 8 | `gotchas.md` 의 리터럴 중괄호 대문자 토큰을 렌더러가 거부(fail-closed 정상) | 도구·템플릿 결함 | 문서 |
| 9 | 텔레메트리 스토어가 실행 플러그인 루트별로 갈림 | 도구·템플릿 결함 | 예 |
| 10 | Git Bash `~` 를 node 에 넘기면 msys 경로로 `file://` 이 깨짐 | 도구·템플릿 결함 | 문서 |
| 11 | `dispatch.mjs` 는 `--parent` 또는 `plan.json.parentSession` 필수 | 도구·템플릿 결함 | 문서(스키마) |
| 12 | "worktree 에 `.artibot/guides` 가 없다"는 리더 전제가 틀림 | 리더 오류 | 문서 |
| 13 | 설계안 수치가 낡음(F-10 "83파일" → HEAD 95) | 절차 공백 | 아니오 |
| 14 | 소유 allowlist 가 "고칠 파일"만 담고 "깨질 테스트"를 빠뜨림 | 절차 공백 | 문서(plan 절차) |
| 15 | 같은 함정 2회째 + 결과를 확인하지 않고 "완료" 통보 | 리더 오류 | 아니오 |
| 16 | 줄기 창이 혼자 일함 — 템플릿에 팬아웃 지시 없음 | 도구·템플릿 결함 | 템플릿 |
| 17 | 타이밍 의존 테스트가 CI·부하에서 흔들림 | 훅·테스트 결함 | 예(3차) |
| 18 | **[결함]** SessionStart 계열이 split 줄기 브랜치를 `artibot/` 접두로 이동(4/4) | 훅·테스트 결함 | **예** |
| 19 | 프로브 부수 실측 — `--settings` 는 병합, host 2.1.260 | 호스트 관측 | 아니오 |
| 20 | `~/.claude/settings.json` mtime 갱신 주체 미확인 | 호스트 관측 | 아니오 |
| 21 | 줄기 창이 `git branch -f` 로 ref 조작 | 절차 공백 | 템플릿 |
| 22 | **#18 트리거 정정 — 진짜 원인은 리포 전체 vitest** | 훅·테스트 결함 | **예** |
| 23 | Stop 게이트("Code without tests")와 소유 allowlist 충돌 | 절차 공백 | 문서(plan 절차) |
| 24 | 줄기 창의 검수 팀원 1명이 끝내 무보고 | 절차 공백 | 템플릿 |
| 25 | land 체크리스트에 lint 행이 없음 | 도구·템플릿 결함 | **예**(`land.mjs`) |
| 26 | 정본 정정 2건(G-1 설계안 줄번호 밀림 · `scorecard.md` 편집 철회) | 리더 오류 + 절차 공백 | 아니오(문서) |
| 27 | 줄기 창의 `checkLimbLanding` 자기 실행이 하네스에 거부됨 | 도구·템플릿 결함 | 조사 |
| 28 | p2 소유 밖 보고 4건 | 절차 공백 | 아니오(후속) |
| 29 | integrate 확인 프롬프트 생략(오너 위임 근거) | 절차 공백 | 문서(규약) |
| 30 | 통합 브랜치명 `ci/split-split-9d6dc2` — 접두 중복 | 도구·템플릿 결함 | 예(`batch-landing.js`) |
| 31 | `commands/team.md:155` 주석이 2티어 모델 정책과 모순 | 절차 공백 | 문서(record 레인) |
| 32 | **스폰 원장이 팀원 모델을 기록하지 못함** — 오늘 22/22 행 `canonicalModel:null` | 훅·테스트 결함 | 예(L2 D1 선행) |
| 33 | 랜딩 결과·측정 기록 | 런 기록 | 아니오 |
| 34 | **스폰 원장 계수 축이 양방향 손실** — start 22 / distinct 16 / start 없는 stop 12 | 훅·테스트 결함 | 예(`fanout-probe` 축) |
| 35 | 교훈 #4 문구 재작성 필요 — "명령 2회 실행"은 #22 재귀속 전 오진 | 도구·템플릿 결함 | 문서(`split.md`) |
| 36 | 회고에서 정정된 것(16→18 이벤트 · `totalMs` 여전히 null · "n=1" 상수) | 런 기록 | 문서 |
| 37 | 2차 배치 실행 형태 결정 — `/split` 대신 `/team` + worktree 격리 | 런 기록(결정) | 아니오 |

### 3.2 원문 (`.artibot/split/gotchas.md` — 삭제·요약 없음)

> 기록 규칙 추가: 이 파일은 창 프롬프트에 그대로 삽입된다 — 중괄호로 감싼 대문자 토큰을 쓰면 렌더러가 미해결 플레이스홀더로 거부한다(#8·#15 실발생 2회).
> 기록 규칙: 발생 시각(KST) · 무엇이 어긋났나 · 어떻게 잡았나 · 다음에 바꿀 것. 삭제 금지, 추가만.

#### 런 시작 전 (2026-09-04 11:1x~12:2x)

1. **핸드오프 전제 3건 오류** — 수리 커밋 해시(09d4eff3→bc2e9e55) · route_ledger 를 UPS 증거로 오독 · "소유권 겹침 0"(config/CHANGELOG/doctor.md 겹침). 잡은 방법: 스폰 프롬프트에 "내 인용이 틀렸으면 틀렸다고 보고하라" 명시 → 팀원 3/3 이 정정. 다음: 이 문구를 /team 보고 계약 정식 조항으로.
2. **정본 :814 "실측 확정"이 시각 상관이었음** — 리더(전 세션)가 mtime 일치를 인과로 승격. 다음: "확정" 표기는 메커니즘 경로가 닿는지 확인한 뒤에만.
3. **plan 스크립트 2회 크래시** — heredoc 안 `\` 이스케이프 소실, `waves[0]` 가 `{taskIds}` 객체. 텔레메트리 미쌍 1건(PLAN start) 남음. 다음: `split.md` §plan 의 코드 예시에 wave 형태를 명시.
4. **worktree 브랜치 충돌 우회** — `claude --worktree` 를 같은 이름으로 2회 실행 → 첫 실행이 브랜치만 만들고, 둘째가 `artibot/` 접두로 우회. `isSplitLimbBranch` 가 거부해 status/완료 판독 불가. 잡은 방법: 4브랜치 모두 base 위 0커밋 확인 후 중복 삭제 + `git branch -m`. 다음: `/split open` 안내에 "명령은 창당 1회, 브랜치가 이미 있으면 `git branch -D` 후 재실행" 추가 + `status` 가 `artibot/…` 형태를 "충돌 우회 브랜치"로 표시.
5. **Check 7 은 5훅 중 1훅만 관측** — events.ndjson 기대값으로 "5훅 발화"를 확인하려던 계획은 1/5 만 답한다. 다음: 나머지 4훅 관측점 설계 필요(별도 결정).
6. **캐시 미러가 구버전 6디렉터리를 덮음** — 캐시는 버전 아카이브가 아니다. 다음: install.sh 의도 확인(미열람).
7. **/doctor S5 거짓 그린** — `_unattributed` 를 라이브 증거로 계수. p2 줄기의 안 B 가 원천 차단, doctor.md 문서화는 후속.

#### 창 공통 주의 (줄기 창이 읽을 것)

- 소유 밖 파일(특히 CHANGELOG.md · artibot.config.json · ARTIBOT-5.0-DESIGN.md)은 고치지 말고 보고. CHANGELOG 는 통합 시 리더가 일괄.
- 한글 경로 리포다. git 경로 파싱은 `-z`. `core.quotepath` 미설정(기본 true).
- 실 스토어 `.artibot/runtime/decisions/` 를 테스트가 오염시키지 않게 cwd 격리(후속 12 실발생 3회).
- 완료는 `Split-Limb: done` 트레일러 커밋만. 메시지·유휴는 완료가 아니다.

#### dispatch 단계 (12:0x)

8. **gotchas.md 에 리터럴 GOTCHAS_DELTA 토큰(중괄호 포함 형태)을 적으면 렌더러가 미해결 플레이스홀더로 거부** — fail-closed 설계가 맞게 동작한 것. 다음: gotchas.md 헤더에 "중괄호 대문자 토큰 금지" 한 줄.
9. **텔레메트리 스토어가 실행 플러그인 루트별로 갈림** — plan 은 소스 리포 루트(`plugins/artibot/runtime/split/`)에서, OPEN/DISPATCH 는 설치 캐시 루트(`~/.claude/plugins/cache/…/runtime/split/`)에서 써서 같은 runId 이벤트가 두 파일로 나뉨. 다음: split 스크립트 호출 루트를 런 시작 시 하나로 고정하고 `split.md` 에 명시.
10. **Git Bash `~` 를 node 에 넘기면 `/c/Users/…` msys 경로가 되어 `file://` URL 이 깨짐** — `process.env.USERPROFILE` 로 조립할 것.
11. **dispatch.mjs 는 `--parent` 또는 `plan.json.parentSession` 이 필수** — plan 단계 스크립트가 parentSession 을 안 써서 dry-run 이 한 번 실패. 다음: `split.md` §plan 7단계의 plan.json 스키마에 `parentSession` 추가.
12. **"worktree 에는 `.artibot/guides` 가 없다"는 틀림(l4-f10 창 정정, 12:06)** — worktree 에 없는 것은 **미추적** 파일(`docs/`, `node_modules`)뿐. `.artibot/guides` 는 git 추적 95파일이라 존재한다. 다음: `split.md` P6 문구를 "미추적 경로만 부재"로 정밀화.
13. **설계안 수치가 낡음(F-10 "83파일" → HEAD 95)** — 다른 팀원이 guides 를 계속 늘려서. 다음: 설계안의 파일 수는 재현 명령과 측정 시각을 병기하고, 게이트는 수치 하드코딩 대신 집합 포함 관계로.
14. **소유 allowlist 가 "고칠 파일"만 담고 "깨질 테스트"를 빠뜨림(p2, 12:1x)** — 안 B 가 `tests/hooks/runtime-prompt-decision-wiring.test.js:308-330` 의 옛 계약 핀을 RED 로 만드는데 그 파일은 어느 줄기 소유도 아니었다. 창이 조기 보고 → 리더가 plan.json·브리프 편입. 다음: plan 단계에서 변경 대상 심볼의 **테스트 참조 grep** 을 allowlist 산출에 포함.
15. **같은 함정 2회째(12:2x)** — #8 을 기록하는 문장 안에 그 토큰을 다시 적어 p2 브리프 재복사가 실패했고, 리더는 실패를 확인하지 않은 채 "재복사 완료"를 창에 통보했다(정정 통보 발송). 다음: 행동 도구 결과를 읽기 전에 결과를 주장하지 않는다 — 규율 §2 "존재≠작동" 의 리더 자기 위반.
16. **줄기 창이 혼자 일함(오너 관찰 12:2x, 스폰 원장 실측: p2 1건·l3/l4/l2 0건)** — `templates/split/PROMPT-TEMPLATE.md` 가 팀원 스폰을 **이름 규칙**으로만 언급(prompt.md :15)하고 "분해해서 병렬 위임하라 · 창은 리더다"를 지시하지 않는다. 리더가 4창에 팬아웃 지시를 사후 발송. 다음: 템플릿에 "줄기 내부 팬아웃 절"(분해 권장 단위 · 구현=opus/검수=fable · 창은 배정·검증·커밋만) 을 추가하고, 브리프 작성 시 리더가 줄기별 분해 권장안을 §1 에 넣는다. 스폰 원장(`<worktree>/.artibot/ledger/spawns.ndjson`)이 창별 팬아웃의 관측점이다 — `fanout-probe` 가 이걸 보는지 확인.
17. **타이밍 의존 테스트가 CI·부하에서 흔들림(12:2x)** — ci/v5-docs 의 Windows Node22 잡에서 `tests/firewall/landing-serialization.test.js` "real child processes racing on one key: exactly one wins" 가 `['ok','ok']` 로 실패(docs 만 바꾼 커밋, 필수 컨텍스트 밖이라 랜딩엔 영향 0). l4 창도 리포 전체 vitest 에서 소유 밖 4건(handoff-store 2 · install-rules 1 · install-atomic-replace 1)이 부하 의존으로 실패 후 단독 재실행 시 조합이 바뀜. 다음: 이 테스트들을 "그린을 근거로 쓰지 않는 영역"에 등록하고, O_EXCL 경쟁 테스트는 Windows 에서 자식 2개가 둘 다 ok 를 내는 경로(같은 pid 재사용? 파일시스템 지연?)를 별도 조사 항목으로.
18. **[결함, 코드 수리 대상] SessionStart 훅 `scripts/hooks/git-autopilot-session.js` 가 split 줄기 브랜치를 `artibot/worktree-split-…` 로 이동시킴(12:20~12:5x, 4/4 worktree)** — `branchPrefix='artibot/'`(:184) + "base 아니면 `checkout -b artibot/<현재>`"(:260-272), `isSplitLimbBranch` 예외 0. 결과: `isSplitLimbBranch` 가 거부해 `status` 표에서 줄기가 사라지고 land/완료 판독이 `no-commits` 로 거짓 미완료. #4 에서 "명령 2회 실행" 이라 추정한 것도 실제로는 이 훅이었을 가능성이 높다(첫 관측 11:53 브랜치 생성 직후). 리더 처치: plan.json limbs[].branch 를 porcelain 실제값으로 동기화(`plannedBranch` 보존) → 판독기·land 정상. 다음(코드): 훅에 `isSplitLimbBranch(currentBranch) → stay put` 예외 + 회귀 테스트; `status` 는 `artibot/worktree-split-*` 를 "훅 이동 브랜치"로 표시. 다음 배치 줄기 후보.
19. **프로브 부수 실측(l2, 12:32~12:40)** — `claude --settings <임시파일>` 의 hooks 는 사용자 settings·플러그인 hooks.json 과 **병합**된다(대체 아님: 프로브 세션 중 플러그인 SubagentStart 핸들러가 spawns.ndjson 을 씀). 세션 안 Bash 에서 중첩 `claude -p` 가 정상 동작. host 는 2.1.260(설계 전제 2.1.259 보다 1패치 위). 다음: 설계안의 "호스트 버전" 은 픽스처에 두 값 병기, 프로브 절차는 `--settings` 임시 파일 방식을 정본으로.
20. **`~/.claude/settings.json` mtime 12:31:57 갱신 주체 미확인** — l2 창은 쓰지 않았다고 보고(프로브 문자열 grep 0, 훅 구성 기준선 동일)하나 사전 해시가 없어 diff 불가. 다음: 사용자 settings 를 건드릴 가능성이 있는 작업은 착수 전 sha256 을 원장에 남긴다.
21. **줄기 창이 plan 이름 ref 를 `git branch -f` 로 맞춤(l2)** — land 가 no-commits 를 내자 창이 스스로 ref 를 옮겼다(checkout 은 아니지만 ref 조작). 결과는 무해했으나 정본이 둘이 됐다. 다음: 브리프 규약에 "ref 조작(branch -f/-m/-D) 금지, 판독 불일치는 리더에게 보고" 추가.
22. **#18 트리거 정정(l4 창 실측 13:0x, 리더 재확인)** — 브랜치 이동의 트리거는 SessionStart 가 아니라 **리포 전체 vitest** 다. `tests/dispatcher/sessionstart-dispatcher.test.js:43-73 runDispatcher` 가 실제 `_sessionstart-dispatcher.js` 를 `cwd: PLUGIN_ROOT`(= worktree 안), HOME/USERPROFILE 만 샌드박스로 스폰 → 자식 4 `git-autopilot-setup.js` 가 **worktree 전용 gitdir** `.git/worktrees/<wt>/autopilot.json` 을 `enabled:true` 로 생성(공유 `.git/autopilot.json` 은 false) → 자식 7 `git-autopilot-session.js#ensureAutopilotBranch :247-276` 이 `RELOCATABLE_BRANCH_NAME` 에 걸리는 줄기 브랜치를 `artibot/` 접두로 `checkout -b`. 4/4 worktree 에 enabled:true 실측(lastSetupAt 12:38~13:05). 잠복 위험: `syncFromBaseBranch :183` 가 pull 성공 시 `merge --no-ff origin/master` 를 줄기에 얹음 — 현재는 줄기 브랜치 upstream 부재로 pull 실패 → 병합 0/4(실측). **근본 수리 = 그 테스트가 임시 git 리포를 cwd 로 쓰게(git 샌드박스)** + 훅의 `isSplitLimbBranch` 예외는 방어선. 후속 12(세션 없는 실행이 실 스토어 오염)와 같은 클래스: "테스트가 프로덕션 부작용 경로를 실 리포에서 실행". 2차 배치 후보.
23. **Stop 게이트("Code without tests")와 소유 allowlist 가 충돌(l2, 13:0x)** — dev 스크립트 `scripts/dev/probe-hook-keys.js` 에 게이트가 테스트를 요구했으나 `tests/hooks/` 는 allowlist 밖이라 창이 `tests/hooks/fixtures/host-payloads/probe-hook-keys.test.js` 라는 변칙 위치에 넣었다(vitest include 는 잡음). 다음: plan 단계에서 소스 경로마다 대응 테스트 디렉터리를 allowlist 에 자동 동반(`scripts/x/y.js` → `tests/x/`).
24. **줄기 창의 검수 팀원 1명이 끝내 무보고(l2, TaskOutput 조회 불가)** — 창이 두 번째 검수자를 띄움. 2026-07-27 "일반 텍스트 보고 유실" 클래스 재발 가능성. 다음: 창 프롬프트의 팀원 스폰 규약에 보고 계약 8줄 삽입을 명시(현재 템플릿은 "SendMessage 뿐" 한 줄).
25. **land 체크리스트에 lint 행이 없음(13:1x)** — l2 줄기가 land 6/6 PASS 인데 리더가 돌린 eslint 는 오류 3·경고 2. CI 는 `eslint . --max-warnings=0`(package.json:23) 라 배치 랜딩이 빨개질 상태였다. 창은 "eslint 미실행"이라 정직 표기했고 리더가 잡았다. 다음: `land.mjs` 에 `lint` 행(변경 파일 한정 eslint --max-warnings=0) 추가 + 브리프 완료 기준 공통 문구에 lint 0 명시. 2차 배치 후보.
26. **[record 레인 대기] 정본 정정 2건(l3 보고, 13:2x)** — (a) `DESIGN-G-1-performance-priority-mapping.md:12,14,104,120,158,160` 의 P02:73/74 인용은 한 줄 밀림(실측 P02:72 `autopilot --fast` 행, :73 high-resource). 코드는 72/73 으로 교정 착지. (b) `commands/scorecard.md` 편집은 소유 밖 테스트 `tests/scorecard/command-doc.test.js` 가 본문을 HEAD 고정하므로 철회 — 설계안 F-30 §3.5 "선택" 항목이 실제로는 그 테스트 소유자와 함께 가야 함. 둘 다 integrate 뒤 docs 커밋으로.
27. **줄기 창의 `checkLimbLanding` 자기 실행이 하네스에 거부됨(l3)** — worktree 밖 git 접근으로 판정. 창은 land 를 스스로 못 돌리고 리더 판독기에 의존. 다음: `land.mjs` 가 worktree cwd 에서도 동작하는지(git-common-dir 경로) 확인, 안 되면 브리프에 "land 는 리더가 돌린다" 명시.
28. **[record 레인 대기] p2 소유 밖 보고 4건(13:2x)** — ① `tests/e2e/runtime-flow.test.js` 세션 없는 케이스가 안 B 의 stderr 1줄을 콘솔에 냄(통과) → stderr 스파이 추가 여부 결정 ② `skills/split/references/operations.md:30` `git diff --name-only` 에 -z 없음(문서 드리프트, 후속 19 문서판) ③ 새 게이트 헤더 알려진 구멍: 별칭 동적 destructure 미탐(리포 0건) · cwd-sandboxed 는 마커 존재만 봄(12개 중 7개 의존) ④ `/doctor` Check 7 문서가 `_unattributed` 를 언급하지 않음 → 옛 파일 취급 별개 결정. 전부 integrate 뒤 docs 커밋 또는 3차.
29. **integrate 확인 프롬프트 생략(13:3x)** — 오너 위임(13:1x "커밋 푸시 배포 권장사항으로 진행") 근거. 텔레메트리 `confirm-integrate` 는 0길이 humanWait 로 기록. 다음: `split.md` §integrate 에 "오너 위임이 원장에 있으면 확인 생략 가능, 세그먼트는 0길이로 남김" 규약 추가 검토.

#### 랜딩 이후 (13:3x~14:0x)

30. **통합 브랜치명 `ci/split-split-9d6dc2`(13:3x)** — `batch-landing.js#integrationBranchName` 이 `INTEGRATION_BRANCH_PREFIX`('ci/split-') 뒤에 runId('split-9d6dc2')를 붙여 접두가 겹침. 무해(ci/** 트리거 안). 다음: runId 에서 `split-` 접두를 벗기거나 prefix 를 `ci/` 로.
31. **[record 레인 대기] `commands/team.md:155` 주석 "구현/검토 역할 모두 frontier 티어" 가 :10·:47·:516(2티어 정책) 과 모순** — 2026-09-02 이전 잔존(architect D-4 설계안 §1.6 발견). docs 커밋으로 정정.
32. **스폰 원장이 팀원 모델을 기록하지 못함(architect 실측 13:4x)** — `subagent-handler.js:62-64` 가 `getPolicyModel(agent_type)===null` 이면 억제하는데 SubagentStart 의 `agent_type` 은 팀원 **이름**이라 오늘 22/22 행이 `canonicalModel:null`. "리더 fable vs 작업자 opus 격차" 를 원장으로 측정할 분모가 없다. 선행 조건 = L2 D1 receipt(`tool_input.model`) 착지 → 2차 배치 l2-d1 이 직접 연결됨.
33. **랜딩 결과·측정(14:0x)** — landBatch `landed` 520886bd, base ca013e2c, rebuilds 0, wait_for_green 폴링 33회, ci/split-split-9d6dc2 삭제. 텔레메트리 합산 18이벤트(두 루트 파일 병합): run 7,405,445ms(02:40:45Z→04:44:10Z), confirm-integrate 1ms(humanWait, 위임으로 생략), 미쌍 3(run start 크래시분 1 · wait-limbs start/end 가 파일 분산으로 짝 안 맞음 2) → `humanWaitPct` **null = 미측정**(규약대로 0 으로 바꾸지 않음). open-windows 세그먼트는 라이브 기록 실패(창 열기 11:53~11:55 는 메모만). 다음: 텔레메트리 루트 고정(#9)이 해결되면 wait-limbs 쌍이 맞는다.

**#32 는 본 리포트 §2.1·§4-C 와 같은 원장을 본다.** 기록자 실측은 `canonicalModel` 뿐 아니라
`requestedModel`·`recommendedModel`·`actionClass` 도 전부 `null` 이고, `route_ledger` 는 22/22
`skipped:no-action-text` 다. 즉 이 원장은 현재 **누가·언제 떴는지만** 답하고 **무엇으로 떴는지**는
답하지 못한다.

**#33 에 대한 기록자 재측정 2건(§1.2·§2 에 반영)**: (a) `summarizeWallClock` 의 `totalMs` 는
7,405,445 가 아니라 **`null`** 이다 — 7,405,445 는 `run` **2회째 엔트리의 `durationMs`** 이고,
함수는 첫 엔트리(크래시분)를 집는다. 결론(`humanWaitPct` = null = 미측정)은 같다.
(b) 미쌍은 **병합 기준 1건**이다 — 3 은 두 파일을 따로 세어 더한 값이다(소스 2 + 캐시 1).
(c) `ci/split-split-9d6dc2` 는 **로컬 ref 로 아직 존재**한다(§2).

#### 랜딩 이후 추가분 (14:0x~14:2x)

34. **스폰 원장 계수 축이 양방향 손실(record 전수 판독 14:0x)** — 4 worktree `spawns.ndjson`: start 이벤트 22 → distinct start id 16(중복), stop 만 있고 start 없는 id 12(l4 3·l3 2·p2 6·l2 1), start∪stop distinct 28. `start` 만 세면 최소 12건 과소, 이벤트 수를 세면 과대. `fanout-probe` 의 SOLO 분모도 같은 축이면 틀린다. 다음: 계수 축 = start∪stop distinct agentId; 원인(start 유실 12건) 조사는 별건. 런 종료 시 최종 팬아웃: l4 1 · l3 4 · p2 8 · l2 9.
35. **교훈 #4 문구 재작성 필요** — "명령 2회 실행" 안내는 #22 재귀속 전 오진. `split.md` 에 넣을 문구는 "리포 전체 vitest 가 SessionStart 훅을 worktree cwd 로 스폰해 브랜치를 옮긴다 — 수리(test-git-sandbox) 전까지 창은 표적 스위트만" 이어야 한다.
36. **회고에서 정정된 것** — 텔레메트리 16→18 이벤트(리더가 14:44 에 INTEGRATE end·run end 기록). 그래도 첫 크래시분 run start 미쌍이 남아 `totalMs=null` → humanWaitPct null 유지. 측정 고지 1번 "n=1" 은 이 런으로 n=2 — `split.md` 상수 갱신 대상(test-git-sandbox 줄기 소유 파일).
37. **2차 배치 실행 형태 결정(14:2x, 오너 부재 — 권장 채택)** — `/split`(창 4개, 사람 필요) 대신 `/team` + `Agent(isolation: worktree)` 팀원 4명(opus, build 티어)으로 l1-ups · l2-d1 · test-git-sandbox · p19-rest 를 병렬 스폰. 팀원에게 "리포 전체 vitest 금지, 표적 스위트만" 을 명시(훅 브랜치 이동 재트리거 회피). sessionstart 테스트 격리(60dab1dd)는 ci/v5-sessionstart-sandbox 로 선행 랜딩 중 — test-git-sandbox 소유에서 그 파일 제외. 랜딩은 팀원 브랜치를 landBatch 로 배치 예정(worktree 브랜치명은 하네스가 짓는다 — `isSplitLimbBranch` 미충족 시 plan.json 없이 브랜치 직접 지정). 다음: `/split` 문서에 "오너 부재 시 대체 경로 = /team isolation:worktree" 절 추가 검토.

**#34 는 본 리포트 §4-C 가 원문이다** — 기록자 전수 판독이 교훈 원장으로 등재된 것이라 §4-C 와 같은 사실이다.

**#37 에 대한 기록자 재측정**: "선행 랜딩 **중**" 은 그 시점 표기이고, **랜딩은 완료됐다** —
`60dab1dd`(13:57, `sessionstart-dispatcher.test.js` 1파일 +156/-10)가 **14:5x 기준 master tip** 이었고
`520886bd` 는 그 조상이다(이후 2차 배치가 그 위에 쌓였다 — §7). 따라서 gotcha #18/#22 의
**근본 수리 (1) 은 이미 닫혔고**, 2차 `test-git-sandbox` 줄기에 남았던 것은
**(2) 방어선 · (3) status 표시 · (4) 템플릿**이다 — 셋 다 2차에서 착지했다(§7.6).

---

## 4. 개선안

출처: `.artibot/split/next-batch-plan.md`(architect, 365줄) 대조 + 본 리포트 실측.

### 4-A. 2차 배치에 이미 편입된 것

| 교훈 | 2차 줄기 | 어느 파일을 어떻게 |
|---|---|---|
| **#18 · #22** (브랜치 이동) | `test-git-sandbox` (R-12a) | ✅ **전부 착지(2차 배치에서 완료 — §7 참조).** **(1) 근본**: `60dab1dd`(13:57)가 `tests/dispatcher/sessionstart-dispatcher.test.js` 의 `cwd` 를 **비-git 임시 디렉터리**로 격리(+무오염 단언, 1파일 +156/-10)해 **선행 착지**했고, 이 파일은 `test-git-sandbox` 소유에서 제외됐다(#37). **(1′) 같은 클래스 나머지도 닫혔다** — 기록자 재확인: `subagentstop`·`sessionend`·`posttooluse` 디스패처 테스트 3개(§1.5 C-2~C-4)가 전부 `cwd: sandboxCwd` 이고, 신규 파이어월 `tests/firewall/dispatcher-cwd-sandbox-required.test.js` 도 **실재**한다. **(2) 방어선**: `git-autopilot-session.js` 가 `isSplitLimbBranch` 를 import 하고 `worktree-` 접두까지 stay-put(오너 **D-1** 로 "버그 수리 예외 4번째" 승인). **(3) 표시**: `lib/git/split-dispatch.js` 에 `branchRelocatedByHook`(참조 3건) |
| **#16** (창이 혼자 일함) | `test-git-sandbox` (4) | `templates/split/PROMPT-TEMPLATE.md` 에 "줄기 내부 팬아웃 절"(분해 권장 단위 · 구현 opus / 검수 fable · 창은 배정·검증·커밋만) + `commands/split.md` §open/§dispatch 문구. **제약**: 새 플레이스홀더를 만들면 `lib/git/split-brief.js` 의 허용목록이 코드가 되므로 **정적 텍스트 절로 한정** |
| **#14** (allowlist 가 깨질 테스트를 빠뜨림) | 2차 plan 전체 | 2차 4줄기 allowlist 에 `hook-timeout-budget`·`dispatch-table`·`split-brief.test`·`split-limb-naming` 을 선편입해 반영 완료 |
| **#23** (Stop 게이트 ↔ allowlist 충돌) | `test-git-sandbox` (4) 동반 (R-29) | `commands/split.md` §plan 절차에 "소스 경로마다 대응 테스트 디렉터리 자동 동반(`scripts/x/y.js` → `tests/x/`)" 1항 |
| **#25** (land 에 lint 행 없음) | `test-git-sandbox` **소유 확정** (R-27, **리더 결정 14:2x**) | `scripts/split/land.mjs` 에 `lint` 행(변경 파일 한정 `eslint --max-warnings=0`) + `commands/split.md` §land + 브리프 완료 기준 공통 문구에 lint 0 명시. 앞선 "배정 필요" 는 **해소** — `land.mjs` 는 이제 `test-git-sandbox` 줄기 소유다. 같은 줄기가 이미 `commands/split.md` 를 소유하므로 §land 편집과 겹침 0 |
| 후속 19 나머지 12자리 | `p19-rest` (R-13) | 자리별 개별 사양(공용 헬퍼 금지 — `-z` 는 명령마다 출력 형태가 다르다) + 각 테스트에 한글·공백 경로 케이스. **D-3 확정 전 dispatch 금지**(#7·#10 의 정체 미확인) |

### 4-B. 아직 미편입 — 어느 파일을 어떻게

**모두 `commands/split.md` 또는 `templates/split/PROMPT-TEMPLATE.md` 한 파일에 몰린다.**
2차 `test-git-sandbox` 줄기가 이미 두 파일을 소유하므로, 아래를 그 줄기에 합치면
겹침 없이 한 번에 닫힌다. 이것이 본 리포트의 1순위 권고다.

| 교훈 | 대상 파일 | 어떻게 |
|---|---|---|
| **#21** (창이 `branch -f` 로 ref 조작) | `templates/split/PROMPT-TEMPLATE.md` | 브리프 규약에 "ref 조작(`branch -f`/`-m`/`-D`) 금지, 판독 불일치는 리더에게 보고" 1항. **#16 과 같은 파일** |
| **#24** (검수 팀원 무보고) | `templates/split/PROMPT-TEMPLATE.md` | 팀원 스폰 규약을 "SendMessage 뿐" 한 줄에서 **보고 계약 8줄 삽입 명시**로 확장. **#16·#21 과 같은 파일** |
| **#3** (plan 크래시) | `commands/split.md` §plan | 코드 예시에 wave 형태(`waves[].taskIds` 가 배열임)를 명시. heredoc `\` 소실 주의 1줄 |
| **#4** (브랜치 충돌 우회) | `commands/split.md` §open | ⚠️ **현 문구는 오진 기반이다** — #22 가 원인을 vitest 로 재귀속했으므로 "명령 2회 실행" 안내를 그대로 쓰면 안 된다. **넣을 문구는 #35 가 확정했다**: "리포 전체 vitest 가 SessionStart 훅을 worktree cwd 로 스폰해 브랜치를 옮긴다 — 수리(test-git-sandbox) 전까지 창은 표적 스위트만". `status` 의 "훅 이동 브랜치" 표시(4-A (3))와 함께 넣는다. ⚠️ **단서**: `60dab1dd` 로 트리거 1개가 닫혔으므로 "수리 전까지" 의 시제를 착지 시점에 맞춰 다시 볼 것 — 같은 클래스 나머지(C-2~C-4)는 아직 열려 있어 **주의 문구 자체는 유지**해야 한다 |
| **#9** (텔레메트리 루트 갈림) | `commands/split.md` + split 스크립트 호출 규약 | 런 시작 시 호출 루트를 하나로 고정하고 문서에 명시. **본 리포트 §1.3 이 그 피해를 실증했다**(`wait-limbs` 가 두 파일에 걸쳐 있어 한 파일만 읽으면 미쌍) |
| **#10** (msys `~` 경로) | `skills/split/references/operations.md` 또는 `commands/split.md` | `process.env.USERPROFILE` 로 조립할 것 1줄 |
| **#11** (`parentSession` 필수) | `commands/split.md` §plan 7단계 | plan.json 스키마에 `parentSession` 추가 |
| **#12** (worktree 파일 부재 전제) | `commands/split.md` P6 | "미추적 경로만 부재"로 정밀화 |
| **#29** (integrate 확인 생략) | `commands/split.md` §integrate | "오너 위임이 원장에 있으면 확인 생략 가능, 세그먼트는 0길이로 남김" 규약 |
| **#8 · #15** (중괄호 토큰) | `.artibot/split/gotchas.md` | **자기 반영 완료** — 현재 `:3` 에 금지 규칙이 있다. 템플릿·렌더러 쪽 추가 방어는 미편입 |
| **#13** (설계안 수치 낡음) | 규율(문서 없음) | 설계안 수치에 재현 명령·측정 시각 병기, 게이트는 하드코딩 대신 집합 포함 관계 |
| **#20** (settings mtime) | 절차 | 사용자 settings 를 건드릴 수 있는 작업은 착수 전 sha256 을 원장에 |
| **#5** (Check 7 이 1/5 훅) | — | 나머지 4훅 관측점 = R-16 `HOOK-VISIBILITY-DESIGN.md` H-2, **승인 미기록**으로 보류 |
| **#6** (캐시 미러 6디렉터리) | `install.sh` | R-20 조사 선행(코드 0) — 의도 확인 전 수리 금지 |
| **#7** (S5 거짓 그린) | `commands/doctor.md` Check 7 S5 행 | R-15 **보류(직렬)** — 그 파일은 1차 `l3-f30-g1` 소유. 통합 후 리더 1커밋 또는 3차 |
| **#17** (타이밍 의존 테스트) | `tests/firewall/landing-serialization.test.js` 등 | R-21, 3차(픽스처 수리 클래스) |
| **#27** (worktree 에서 land 거부) | `scripts/split/land.mjs` · `lib/git/limb-landing-check.js` | R-28 **보류(직렬)** — `limb-landing-check.js` 는 1차 p2 소유 |
| **#26 · #28** (정본 정정 · 소유 밖 보고) | 설계안 문서 · docs | **record 레인 / integrate 뒤 docs 커밋** |

### 4-C. 신규 발견 (교훈 원장 미등재 — 본 리포트 작성 중 record 실측)

**스폰 원장은 팬아웃의 관측점으로 쓸 수 있으나 양방향으로 손실이 있다.**
gotcha #16 의 처방은 "스폰 원장이 창별 팬아웃의 관측점이다 — `fanout-probe` 가 이걸
보는지 확인"으로 끝난다. 4 worktree 의 원장을 전수 판독한 결과:

| 측정 | 값 |
|---|---|
| `start` 이벤트 총계 | 22 |
| distinct `start` agentId | **16** (같은 id 로 `start` 가 중복 기록됨) |
| distinct `stop` agentId | 28 |
| **`stop` 만 있고 `start` 가 없는 id** | **12** (l4 3 · l3 2 · p2 6 · l2 1) |
| start ∪ stop distinct | **28** |

즉 `start` 만 세면 팬아웃을 **최소 12건 과소계수**하고, 이벤트 수를 세면 중복으로
**과대계수**한다. `fanout-probe` 가 `start` 이벤트를 세는 방식이라면 SOLO 경보의 분모가
틀린다. **다음**: (a) `fanout-probe` 의 계수 축을 `start ∪ stop` distinct agentId 로 바꾸고
(b) SubagentStart 가 12건을 놓친 원인을 별도 조사 항목으로 등록한다.
**미확인**: 놓친 12건의 원인(훅 미발화 / 페이로드 키 / 쓰기 실패) — 조사하지 않았다.

### 4-D. 2차 배치가 의도적으로 제외한 것 (초안 §3 요지)

L1 D4·L2 D3/D4 라이브 판정(릴리스 필요) · `/doctor` Check 10 과 `lib/replay` 조인(1차 l3
소유 파일과 직렬 의존) · `docs:check` 스코프와 trail 이관(**설계안 부재** — 정본 `:908` ⑤
보류) · G-1b economy(재결정 조건 미충족) · HOOK-VISIBILITY H-1~H-6(승인 미기록 + L1 파일
겹침) · planner 병렬화(승인 대기) · Shadow 진입(Observe 종료 조건 미충족) · 모델 정책
역할 오버라이드(리포 기록 0건 → 오너 결정 D-4).

---

## 5. 측정 고지

아래 3문구는 `plugins/artibot/commands/split.md` §측정 고지(`:234-238`)의 문자 그대로이며,
값만 이번 런의 실측으로 채웠다.

```
측정 고지:
1. 실오퍼레이터 데이터 1건(n=1) — `/split` vs `-fast` 속도 비교는 여전히 주장할 수 없다(n=1 은 존재 증명이지 비교 표본이 아니다; 근거 `reports/SPLIT/split-8f83d7.md`, 2026-08-28 기준).
2. wall-clock 은 인간 대기 포함 — 창 열기(`open-windows`)·통합 확인(`confirm-integrate`) 등 사람이 일한 구간이 총 소요(`run`)에 들어 있다. `humanWait:true` 세그먼트로 분리 기록하며, 빼고 말하지 않는다.
3. 사람 대기 비율 null% (분자 humanWaitMs=1, 분모 run=null ms, 측정시각 2026-09-04T04:44:10.621Z; 미쌍 1건이면 `null`) — C단계(headless 자동 창) 재평가 조건 `config.split.humanWaitReevalPct`=50 대비 미측정. 판정과 C단계 재개는 사람이 결정한다 — 플러그인은 기록만 하고 임계값을 코드에서 비교하지 않는다(`tests/firewall/split-telemetry-wallclock.test.js` "record-only" 게이트).
```

**이벤트 수가 16 → 18 로 늘었으나 결론은 바뀌지 않았다.** 리더가 2026-09-04 **14:44:10Z** 에
INTEGRATE end 와 `run` end 를 기록해 두 파일 합계가 **18건**이 됐고, `run` **2회째** 세그먼트는
7,405,445ms 로 닫혔다. 그럼에도 **첫 크래시분 `run` start 가 미쌍으로 남아** `summarizeWallClock`
이 집는 첫 엔트리가 열린 채이므로 **`totalMs` 는 여전히 `null`**, 따라서 `humanWaitPct` 도
**`null`(미측정)** 이다. 16건 시점의 판정과 18건 시점의 판정이 같다.

**1번 문구에 대한 주석**: 이 런으로 실오퍼레이터 데이터는 **2건(n=2)** 이 됐다. 위 문구는
`split.md` 원문을 문자 그대로 옮기라는 지시에 따라 "1건(n=1)" 을 보존한 것이다 —
`split.md` 의 그 상수는 **갱신 대상이며, 소유는 2차 `test-git-sandbox` 줄기**다(#36).

**3번 값이 `null`(미측정)인 이유**: `run` 세그먼트가 **2회 start** 됐고 end 는 1개뿐이라
`summarizeWallClock` 이 집는 **첫 엔트리**(크래시분)가 열린 채로 남아 `totalMs = null` 이다.
`split.md:231` "`null` 은 `null` 로 찍는다 — `0` 이나 `-` 로 바꾸지 않는다" + `:240`
"`humanWaitPct === null` 이면 반드시 '미측정'" 이 적용된다. 리더도 같은 결론(`null` = 미측정)을
지시했다. **다만 분모 표기가 다르다** — 리더 보고는 "run 7,405,445ms" 였으나 그것은 `run`
**2회째 엔트리의 `durationMs`** 이고 함수가 반환하는 `totalMs` 는 `null` 이다. 규약이 요구하는
것은 후자이므로 `null` 로 적었다(§1.2 참조).

**미쌍 수도 다르다**: 리더 보고는 3건(`run` start 1 + `wait-limbs` start/end 2)이었으나,
그 2건은 **두 파일을 따로 셌을 때만** 미쌍이다. 병합하면 `wait-limbs` 는 정상적으로 짝이
맞고 **미쌍은 1건**(`run` start 1회째)이다. 위 고지문에는 병합 기준 1 을 적었다.
읽는 방식별 갈래는 §1.2 표에 있다.

**`open-windows` 가 없다**: 런 1호에는 있던 `open-windows` humanWait 세그먼트가 이번엔
**0건**이다(OPEN 이벤트 `data.note` 가 "not recorded live" 로 자인). 창은 실제로 ~11:53 에
열렸고 OPEN phase 는 12:04:22 에 사후 기록됐다. 따라서 **이 런의 humanWait 총계 1ms 는
실제 사람 대기 시간이 아니다** — 창 열기 구간이 통째로 빠져 있다.

재현 명령:

```
node --input-type=module -e "
import fs from 'node:fs';
const mod = await import('file:///.../plugins/artibot/lib/observability/split-telemetry.js');
const rd = p => fs.readFileSync(p,'utf8').trim().split(/\r?\n/).filter(Boolean).map(l=>JSON.parse(l));
const ev = [...rd(SOURCE_NDJSON), ...rd(CACHE_NDJSON)].sort((a,b)=>a.ts<b.ts?-1:1);
console.log(mod.summarizeWallClock(ev));
"
```

(두 경로는 §1.3 표. `~` 를 그대로 넘기지 마라 — gotcha #10.)

---

## 6. 미확인

교훈 원장과 2차 배치 초안의 미확인을 **삭제·요약 없이** 옮기고, 본 리포트가 새로
남기는 것을 끝에 붙였다.

### 6.1 교훈 원장에서

- `~/.claude/settings.json` mtime 12:31:57 **갱신 주체**(#20) — l2 창은 쓰지 않았다고 보고했으나 사전 해시가 없어 diff 불가.
- `install.sh` 캐시 미러가 구버전 6디렉터리를 순회하는 것이 **의도인지**(#6) — 미열람.
- `/doctor` Check 7 이 못 보는 **나머지 4훅의 라이브 발화 여부**(#5) — 관측점 부재.
- #17 O_EXCL 경쟁 테스트가 Windows 에서 **자식 2개가 둘 다 ok 를 내는 경로**(같은 pid 재사용? 파일시스템 지연?) — 별도 조사 항목.
- #22 `git-autopilot-session.js:183 syncFromBaseBranch` 가 **upstream 이 있는 줄기에서 실제로 `merge --no-ff origin/master` 를 얹는지** — 1차는 upstream 부재로 병합 0/4, 조건이 바뀌면 재현 가능(추론).
- #18 에서 "#4 의 '명령 2회 실행' 추정도 실제로는 이 훅이었을 **가능성이 높다**" — 가능성 표기 그대로, 확정 아님.

### 6.2 2차 배치 초안에서

- 후속 19 의 **#번호 ↔ 파일 대응표와 #7·#10 의 정체** — 정본·브리프·gotchas 에 열거표 없음(리더 세션 내부 기록으로 추정).
- **모델 정책 역할 오버라이드** 논의 내용 — 리포 0건.
- `ledger-events.allowlist.json` 항목 수(36)를 핀하는 테스트 유무 — grep 미실시.
- `conflict-detector.js`·`merge-preflight.js`·`git-autopilot-guard.js` 전용 테스트 파일 유무 — 이름 매치 0, 내용 grep 미실시.
- l3-f30-g1·p2-f12-f19 의 미커밋 변경 15·9경로가 각 allowlist 안인지 — 파일 목록 미열람(초안 작성 시점 기준).
- L2 D1 이 `hooks.json` 에 항목을 추가할 때 `hook-timeout-budget.test.js`·`dispatch-table.test.js` 가 실제로 RED 가 되는지 — 참조만 확인, 단언 내용 미열람.
- `INCIDENT` §6.2 (C) 의 정의 — D1-go 로 무관해졌으나 여전히 미열람.
- C-2 `subagentstop-dispatcher.test.js` 가 실 `spawns.ndjson` 을 **실제로 오염시켰는지** — 코드 경로 추론만. C-3 `rotation-runner`·`session-ledger` 가 `<projectRoot>/.artibot/` 을 만지는지 — 미열람. C-7 `zero-result-guard.test.js` `runHook` 의 HOME 샌드박스 여부 — 헬퍼 본문 미열람. 43파일 중 훅 스폰이 아닌 18파일은 경로명으로 분류(내용 미열람).

### 6.3 본 리포트가 남기는 것

- **CI 결과의 내용** — `wait_for_green` 폴링 33회로 green 을 기다린 것은 리더 보고이나, **어떤 워크플로가 몇 개 통과했는지는 조회하지 않았다**. 랜딩 SHA·조상 관계는 git 으로 확인했다(§2).
- **`ci/split-split-9d6dc2` 가 원격에 푸시된 적이 있는지** — 로컬 ref 는 남아 있고 원격에는 `ci/split-*` 가 0건이다. 두 관측만으로는 "푸시 후 삭제"와 "애초에 로컬 전용"을 구분할 수 없다.
- **`stop` 만 있고 `start` 가 없는 12건의 원인**(§4-C) — 훅 미발화인지, 페이로드 키 문제인지, 쓰기 실패인지 조사하지 않았다.
- **중복 `run` start 를 어떻게 다뤄야 하는지**(§1.2) — 닫힌 엔트리를 고를지, 마지막 start 를 정본으로 할지, 중복 start 를 거부할지 판정하지 않았다. 재시도 런의 총 소요 정의가 먼저 정해져야 한다.
- **#32 의 `agent_type` 이 팀원 이름인 것이 호스트 계약인지 우리 코드의 해석인지** — architect 실측을 옮긴 것이고 기록자는 `subagent-handler.js:62-64` 를 열지 않았다.
- **`start` 이벤트 22건이 distinct id 16개로 접히는 이유** — 재시도인지 중복 기록인지 미확인.
- **`run` 세그먼트가 두 번 start 된 뒤 한 번도 end 되지 않은 것이 설계상 정상인지** — `/split integrate` 가 `run` end 를 쓰는 경로가 있는지 코드로 확인하지 않았다.
- **OPEN phase 4ms** 가 사후 기록임은 `data.note` 로 확정되나, **실제 창 열기 소요**(~11:53 → 11:55 로 추정되는 구간)는 텔레메트리에 없다.
- **런 1호 대비 개선/악화 비교** — 두 런의 절차·줄기 수·humanWait 기록 방식이 달라 대조하지 않았다. n=2 는 여전히 비교 표본이 아니다.
- **`estimatedSpeedup: 4`**(plan.json) 의 실현 여부 — 대조군이 없어 측정 불가. 이 값은 계획 산출물이지 실측이 아니다.

---

## 7. 2차 배치 (v5b2-9d6dc2)

1차 배치(`split-9d6dc2`)의 후속이다. **`/split` 을 쓰지 않았다** — 오너 부재 구간이라
창을 열 사람이 없어, 교훈 #37 의 권장 채택대로 **`/team` + `Agent(isolation: worktree)`**
로 실행했다. 따라서 이 절에는 `/split` 텔레메트리(phase·세그먼트·humanWait)가 **없다**.
줄기 정의·소유권 표·랜딩 절차는 1차 것을 그대로 재사용했다.

| 항목 | 값 |
|---|---|
| 배치 id | `v5b2-9d6dc2` |
| 실행 형태 | `/team` + `Agent(isolation: worktree)` 팀원 **4명**(opus, build 티어) |
| 독립 검수 | fable **4명 전원 APPROVE** — `review-l1` · `review-l2` · `review-p19` · `review-tgs`. `review-tgs` 는 **보고 직후 세션 한도로 종료**(보고 자체는 완결, 한도 리셋 16:50) |
| 줄기 분기점 | **`520886bd`**(1차 배치 랜딩) — 4줄기 전부 여기서 갈라졌다(기록자 `git merge-base` 4/4 확인) |
| 통합 base | **`e0aa2580`**(landing-lock 수리) — 분기점과 **다르다**. 줄기는 `520886bd` 에서 갈라져 `e0aa2580` 위로 접혔다 |
| 랜딩 | **landed** — 배치 랜딩 SHA **`838d86bd`**(2026-09-04 **17:11:53**), 4줄기 tip 전부 조상 **4/4**. `origin/master` == `838d86bd` 로 **푸시 완료**. **CI 결과는 `TBD-리더`**(랜딩 후 실행분 미조회) |
| 교훈 | `.artibot/split/gotchas.md` **#37~#57**(21건, §7.5 에 전문) — 원장 총계는 57건 |

### 7.1 줄기별 결과 (분기점 `520886bd` 대비 기록자 재측정)

재현: `MB=$(git merge-base <tip> e0aa2580)` → `git rev-list --count $MB..<tip>` ·
`git diff --shortstat $MB..<tip>` · `git log --format='%(trailers:key=Split-Limb,valueonly)' $MB..<tip>`

| 줄기 | tip | 커밋 | 파일 | 삽입/삭제 | `done` 트레일러 |
|---|---|---|---|---|---|
| `l1-ups` | `4b2fe4fe` | 3 | 21 | **+1,179 / -106** | 3/3 |
| `l2-d1` | `52b81c43` | 2 | 10 | **+1,738 / -336** | 2/2 |
| `p19-rest` | `79fa8788` | 2 | 18 | **+1,002 / -84** | 2/2 |
| `test-git-sandbox` | `56bc7912` | 2 | 15 | **+1,320 / -83** | **1/2** |
| **합계** | — | **9** | **64** | **+5,239 / -609** | 8/9 |

**⚠️ 리더 브리프와 세 곳이 다르다.** 커밋 수·파일 수는 4/4 일치하나 삽입/삭제가 갈린다 —
`l1-ups` +1120/-105 → **+1179/-106**, `l2-d1` +1736/-336 → **+1738/-336**,
`p19-rest` +999/-83 → **+1002/-84**. `test-git-sandbox` 만 정확히 일치했다.
브리프 값은 각 줄기의 **마지막 커밋 직전** 시점 측정으로 보인다(추론 — 측정 시각 미기재).
위 표는 tip 기준 재측정값이다.

**`test-git-sandbox` 는 2커밋 중 1건만 `done` 트레일러를 달았다.** 완료 판독은 트레일러가
정본이므로(1차 창 공통 주의 4번째) 기록해 둔다 — 랜딩 자체는 리더가 배치로 접었으므로
결과에는 영향이 없었다.

**줄기 정의**(`next-batch-plan.md` §2.1 원문 요지):
`l1-ups` = UserPromptSubmit stdout 을 호스트 허용목록으로 + 봉투를 `hookSpecificOutput.additionalContext`
로 이전(D1·D2·D3, D4 는 통합 후) · `l2-d1` = 라우팅 shadow receipt 를 PreToolUse(Agent) 신규 훅으로,
SubagentStart 에서 `route.bound` 로 결합 · `test-git-sandbox` = gotcha #18/#22 의 (1)(2)(3) + #16
템플릿 팬아웃 절 · `p19-rest` = 후속 19 나머지 자리 `-z` 전환(자리별 개별 사양, 공용 헬퍼 금지).

### 7.2 배치 조립과 랜딩 실패 2회

```
e0aa2580 (통합 base)
  └ 916f2ce3 fold artibot/worktree-agent-a3725b933da90230d  [1/4]
    └ c9eb5309 fold artibot/worktree-agent-ad1a5857fe48056bf [2/4]
      └ a4989c9c fold worktree-agent-a987e856d8773a878       [3/4]
        └ 93d95c47 fold worktree-agent-af353c3796d5a412d     [4/4]   ← 배치
          └ 18b8b126 README 수치 동기화                        ← 실패 ① 처치
            └ 838d86bd 통합 수정 3건                            ← 실패 ② 처치
```

기록자 재측정: `git diff --shortstat e0aa2580..838d86bd` = **67 files, +5,259, -614**
(**리더 값과 정확히 일치**). 중간 커밋 자체는 `18b8b126` 2파일 +6/-6, `838d86bd` 3파일 +17/-2.

**실패 ① — "Validate README claims"(#54).** `l2-d1` 이 훅 스크립트 1개(`route-observe-pre.js`)와
등록 1개를 추가했는데 README 두 파일의 카운트 주장 6곳(26 등록 · 69 스크립트)이 그대로였다.
CI 가 **테스트 이전 단계**에서 Node 20/22/24 전부 RED. **README 는 어느 줄기도 소유하지 않는 파일**이라
gotcha #14("깨질 파일이 allowlist 밖")의 **재발**이다. 처치는 `scripts/ci/sync-readme-claims.js` 로
6곳 정정 후 배치 위에 커밋.

**실패 ② — vitest 3건, 전부 줄기 간 계약 충돌(#57).** 단독 스위트는 4줄기 모두 그린이었다.
- (a) `test-git-sandbox` 가 `land.mjs` 에 lint 행을 더해 **1차 배치** `limb-landing-check.test.js:407`
  의 `toHaveLength(6)` 이 RED. 6→7행.
- (b) `l1-ups` 의 신규 `ups-stdout-allowlist.test.js` 가 디스패처를 spawn 해서
  `test-git-sandbox` 가 방금 만든 **스포너 래칫(6개 고정)** 이 RED.
- (c) `l2-d1` 이 `subagent-handler.js#observeRoute` 심볼을 제거해 `commands/scorecard.md:80` 의
  인용이 **유령 인용**이 되어 citation 게이트가 RED.

(c)에서 **게이트 2개가 같은 바이트에서 충돌**했다 — citation 게이트는 심볼 실존을 요구하고,
`command-doc` 게이트는 `scorecard.md` 줄 삭제를 금지한다. 규율 §10("게이트를 통과시키려
게이트를 깎지 않는다")대로 **게이트는 무수정**, 설계 쪽(**심볼 보존 별칭**)으로 해소했다.

**이것이 1차 배치 §4-D 의 전제를 깬다.** 2차 계획은 "파일 소유권 겹침 **0**"을 파일 단위로
직접 대조해 확인했고 그것은 사실이었다. 그런데 **계약 겹침**(A 줄기가 B 줄기 또는 과거
배치의 테스트가 핀한 값을 바꾸는 것)은 파일 소유권 표가 **구조적으로 볼 수 없다.**
1차의 gotcha #14 는 "깨질 테스트를 allowlist 에" 로 끝났으나, #57 은 그것으로도 부족함을 보인다 —
깨질 테스트가 **다른 줄기가 이번에 새로 만든 것**이면 plan 시점에 존재하지도 않는다.

### 7.3 브랜치 이동 재발 — 현재 ref 로는 4/4 가 아니라 2/4

리더 보고는 "4줄기 모두 훅에 의해 `artibot/` 접두 이동 재발" 이다. **현재 ref 로는 2/4 만
재현된다.** 기록자 `git for-each-ref` 실측:

| 줄기 | 계획 이름 ref | `artibot/` 접두 ref | 판정 |
|---|---|---|---|
| `l2-d1` | `worktree-agent-a3725b933da90230d` = `520886bd`(**0커밋**) | `artibot/worktree-agent-a3725b933da90230d` = `52b81c43` | **이동됨** |
| `test-git-sandbox` | `worktree-agent-ad1a5857fe48056bf` = `520886bd`(**0커밋**) | `artibot/worktree-agent-ad1a5857fe48056bf` = `56bc7912` | **이동됨** |
| `p19-rest` | `worktree-agent-a987e856d8773a878` = `79fa8788` | **없음** | 이동 안 됨 |
| `l1-ups` | `worktree-agent-af353c3796d5a412d` = `4b2fe4fe` | **없음** | 이동 안 됨 |

**배치 fold 커밋 메시지가 같은 말을 한다** — `[1/4]`·`[2/4]` 는 `artibot/` 접두 이름으로,
`[3/4]`·`[4/4]` 는 접두 없는 이름으로 접혔다. 즉 **fold 시점(16:36)에도 2/4** 였다.
1차와 같은 지문("계획 이름 ref 가 base 에 0커밋으로 남고 `artibot/` 쪽이 작업을 든다")이
2줄기에서 그대로 재현됐다.

**미확인**: "4/4" 가 런 중 어느 시점의 관측이고 그 뒤 2줄기가 되돌려진 것인지, 아니면
관측 자체가 넓게 잡힌 것인지 구분하지 못했다. 기록자는 **런 중 상태를 보지 못했고**
사후 ref 만 읽었다. 어느 쪽이든 **재발 자체는 성립**한다(최소 2/4).

**1차와 달라진 것 하나**: 팀원 스폰 프롬프트에 **"리포 전체 vitest 금지 · 표적 스위트만"** 을
넣었다(교훈 #37). 1차에서 이 결함의 트리거가 리포 전체 vitest 였으므로(#22) 그 지시가
재발을 줄였을 수 있으나, **대조군이 없어 효과는 측정되지 않았다.** 그리고 #48(d)가 보인
대로 **`claude -p` 라이브 런 자체도 SessionStart 로 브랜치를 옮긴다** — vitest 금지만으로는
경로가 닫히지 않아 `test-git-sandbox` 가 stay-put 을 `worktree-` **접두 전체**로 넓혔다.

### 7.4 교훈 #37~#57 — 분류표

`#37` 은 §3.1·§3.2 에 이미 실려 있다(1차 회고 시점에 등재). 여기서는 분류만 다시 싣고
원문은 §3.2 를 보라. `#38`~`#57` 은 §7.5 에 전문을 옮긴다.

| 분류 | 건수 | 번호 |
|---|---|---|
| **리더 오류** | 5 (+1 부분) | #39 · #43 · #45 · #47 · #57 · (#44 부분) |
| **도구·템플릿 결함** | 5 | #38 · #41 · #49 · #55 · #56 |
| **훅·테스트 결함** | 1 | #40 |
| **호스트 관측** | 2 | #48 · #50 |
| **절차 공백** | 2 | #52 · #54 |
| 런 기록·결정(문제 아님) | 6 | #37 · #42 · #44 · #46 · #51 · #53 |
| **합계** | **21** | |

| # | 한 줄 | 분류 | 코드 수리 |
|---|---|---|---|
| 37 | 2차 배치 실행 형태 결정 — `/split` 대신 `/team` + worktree 격리 | 런 기록(결정) | 아니오 |
| 38 | `landBatch` 가 로컬 `ci/split-<runId>` ref 를 남김 — 런 1호분까지 누적 | 도구·템플릿 결함 | 예 |
| 39 | **측정 고지 분모를 리더가 잘못 보고** — `totalMs` 는 null, 7,405,445 는 2회째 엔트리 값. 미쌍도 3이 아니라 1 | **리더 오류** | 아니오 |
| 40 | `landing-serialization` 게이트 오늘 2회 실패 — 자식 2개가 둘 다 락 획득 | 훅·테스트 결함 | 조사 → #41 |
| 41 | **[결함 확정]** landing-lock 빈 파일 회수 — `openSync('wx')`↔`writeSync` 창에서 상대가 스테일 판정. #40 의 "플레이크" 표기는 **틀렸다** | 도구·템플릿 결함 | **예**(`e0aa2580`) |
| 42 | 오너 결정(15:0x) — 3차 승인 2건, 미승인 유지 2건, landing-lock 근본안 보류 | 런 기록(결정) | 아니오 |
| 43 | **l1-ups 브리프 전제 3건이 틀림** — 소유 밖 편집 추인 · 설계 §4.3-1 이 CI 에서 항상 RED · 800줄 권고 초과 확대 | **리더 오류** | 설계안 수정 |
| 44 | p19-rest 실측 — 정본 재결정 조건 "한글 실유입" **이미 충족**, 게이트 fail-open 라이브 RED. 소유 밖 편집 1은 브리프 "없음" 오류 | 런 기록(+리더 오류 부분) | 아니오 |
| 45 | **p19-rest 검수 — 리더 브리프 기준 오류 1** + 구현자 "결과 불변 4" 중 1건은 실제 행동 변화 | **리더 오류** | 아니오 |
| 46 | l1-ups 검수 APPROVE — 교차검수 3점 독립 실측, 디스패처 재현 4건 바이트 일치 | 런 기록 | minor 1줄 |
| 47 | **설계안 2건 착지 + 리더 전제 정정 3건**(479 아닌 478 오기 · guides 96 · trail 질문 프레임) | **리더 오류** | 코드 0 |
| 48 | l2-d1 실측 5건 — 매처 표현식 0건 · `agent_type` 경로별 상이 · `claude -p` 도 브랜치 이동 | 호스트 관측 | 설계 갱신 |
| 49 | **[3차 1순위]** `hooks.json` 매처 표현식 4종이 호스트 문법에 없음 — 정규식 해석이면 일부는 절대 불일치, 일부는 **전 도구 매치** | 도구·템플릿 결함 | 예(측정 후) |
| 50 | 후속 14 확정 — `timeout` 단위는 **초**. `5000` = 5,000초. CONTRIBUTING "milliseconds" 는 문서 오류 | 호스트 관측 | 3차 |
| 51 | l2-d1 검수 APPROVE — 8형태 재현, 265/266 pass. R2: FIFO 매칭에 게이트 없어 D4 분모 흐림 | 런 기록 | 후속 |
| 52 | test-git-sandbox 완료 — 자기검증 초안이 거짓 그린이던 것을 **스스로 잡음**. **규약 위반 1**: 팀원이 `git stash` 실행 | 절차 공백 | 아니오 |
| 53 | 2차 배치 랜딩 착수 — 검수 4/4 APPROVE, 로컬 docs 커밋을 브랜치로 보관 후 master reset | 런 기록(결정) | 아니오 |
| 54 | **첫 랜딩 실패 — README 수치 게이트.** 어느 줄기도 소유하지 않는 파일 → gotcha #14 재발 | 절차 공백 | 예(처치됨) |
| 55 | 임시 worktree pre-push — `node_modules` 부재 fail-closed, junction 으로 해결. 3게이트 FAIL 재현 불가 | 도구·템플릿 결함 | 조사 |
| 56 | **[결함 확정]** `ci-utils.js:74` 가 링크드 worktree + `GIT_DIR` 환경에서 리포 전체 1,973개를 돌려받아 플러그인 루트 0개로 오판 | 도구·템플릿 결함 | **예**(3차) |
| 57 | **두 번째 랜딩 실패 — 줄기 간 계약 충돌 3건.** 파일 소유권 겹침 0 이어도 **계약 겹침은 plan 이 못 본다** | **리더 오류**(미예측) | 예(처치됨) |

### 7.5 교훈 #38~#57 원문 (`.artibot/split/gotchas.md` — 삭제·요약 없음)

38. **landBatch 가 로컬 `ci/split-<runId>` ref 를 남김(record 실측 14:5x)** — 원격만 삭제했고 로컬 ref 는 남아 런 1호분(`ci/split-split-8f83d7`)까지 누적. 리더가 둘 다 삭제(master 조상 확인 후). 다음: `split.md` §integrate `landed` 후처리에 "로컬 ci ref 삭제" 1줄, 또는 landBatch 가 `update-ref -d`.
39. **측정 고지 분모 정정(record)** — `summarizeWallClock` 은 첫 `run` 엔트리를 집으므로 크래시분(열린 채) 때문에 `totalMs=null` — 리더가 보고한 7,405,445 는 2회째 엔트리 durationMs 였다. 병합 기준 미쌍은 1(리더의 3 은 파일별 합산). 결론(미측정)은 동일. 다음: 중복 start 처리 규칙(닫힌 엔트리 우선 / 마지막 start 정본 / 거부) 결정 필요 — 재시도 런의 총 소요 정의가 선행.
40. **`tests/firewall/landing-serialization.test.js` "real child processes racing on one key: exactly one wins" 오늘 2회 실패(12:2x Windows Node22 · 15:12 Linux Node24 필수 컨텍스트)** — 단언 `['ok','ok']` = 자식 2개가 **둘 다 락 획득**. 재실행으로 그린이 되지만 "타이밍 플레이크"로 넘기면 안 된다: `lib/git/landing-lock.js` O_EXCL 상호배제가 실제로 깨지는 경로(같은 pid 재사용? 스테일 락 회수 창? 키 파일 경로 경쟁?)일 수 있고, 이 락은 integrate 의 유일한 직렬화 수단이다. 다음: 3차 조사 항목 1순위 — 테스트 하네스(자식 스폰 방식)와 락 구현을 분리 실측, 실패 시 두 자식의 stdout·락 파일 내용 캡처를 테스트에 추가. 그 전까지 이 게이트의 그린을 직렬화 증거로 쓰지 않는다(규율 §9).
41. **[결함 확정·수리 착수] landing-lock 빈 파일 회수 결함(lockprobe 조사 15:2x, 리더 직접 열람)** — `lib/git/landing-lock.js:116` `openSync('wx')` → `:122` `writeSync` 사이 창에서 상대가 `readHolder :99-106` null(빈/부분 JSON) → `:182-184` `stale=!existing` → unlink → 재생성 `reclaimed:true`. 둘 다 ok. 결정적 재현 1/1(빈 파일 미리 생성), 타이밍 재현 0/100(로컬 무부하), CI 공유 러너에서 2회 발화. 프로덕션 `/split integrate`(`batch-landing.js:338`) 동일 창. #40 의 "플레이크" 표기는 틀렸다 — 게이트가 잡은 진짜 결함. 수리: 파싱 불가 파일은 mtime 기준으로만 스테일 판정 + 자식 출력에 reclaimed 구분 + 결정적 회귀 테스트(tdd-guide, 버그 수리 클래스 — D-1 선례, 오너 부재 권장 채택). 근본안(tmp+linkSync)은 exFAT 미확인으로 보류.
42. **오너 결정(15:0x, 복귀 중 1회 질의)** — 3차 배치 승인: L2 Check 10 + replay tool_use_id 조인(l2-d1 랜딩 후 /split 창) · docs:check 스코프·trail 이관 **설계안** 작성(코드 0, 부모 세션 architect 즉시). 미승인 유지: HOOK-VISIBILITY H-1~6 · PLANNER-PARALLELIZATION. landing-lock 근본안(tmp+linkSync) 보류 — 최소 수리(e0aa2580)로 운용. 1차 창 4개는 닫아도 됨(랜딩 완료).
43. **l1-ups 리더 결정(15:0x)** — (a) `runtime-prompt-decision-wiring.test.js` 소유 밖 편집 추인(바이트 동일성 게이트가 의도된 필드 추가로 설계상 통과 불가 → 그 필드만 마스킹 + positive control 4종). (b) `ups-host-schema-drift.test.js` 는 설계 §4.3-1 "바이너리 부재 = FAIL" 이 GitHub 러너에서 항상 RED → CI 환경에서만 사유 명시 skip, 로컬은 fail-closed 유지. 설계 §4.3-1 수정 필요 — 권장 채택, 오너 미질의. (c) `runtime-prompt.js` 801→932줄(800 권고 초과 확대) — R-24 계열 후속.
44. **p19-rest 실측(15:0x)** — 정본 :913 재결정 조건 "한글 경로 실유입" 은 이미 충족(추적 1961 중 비-ASCII 5건 `.artibot/adr/`), `gitignore-boundary` 게이트 fail-open 라이브 RED, `plugin-validate.yml` 은 한글 자산만 바뀐 PR 을 fast-skip. `merge-tree --name-only -z` 는 지원하되 출력 구조가 달라 파서 재작성. 4자리는 결과 불변(예방 전환). 소유 밖 편집 1(`tests/hooks/git-autopilot-merge.test.js` 실재 — 브리프 "없음" 오류, 추인). 3차 후보: `handoff-builder.js:433` porcelain 동일 결함 · `stop-review-gate.js:225` 한 줄 블록 주석 오탐(경로 파서 무관). NUL 출력을 `$(...)` 로 받으면 bash 가 NUL 을 버린다 — 파일 경유 필수.
45. **p19-rest 검수 APPROVE(15:0x)** — 검수자가 12자리 전부 diff 대조 + git 2.54 원시 출력 od 실측(merge-tree 4중주·name-status R100 2경로·log 커밋 경계 빈 필드). 반증 1: 구현자의 "결과 불변 4" 중 dev-verify-gate 는 행동 변화(앞공백 면제 오인 해소, 지문 변경) — 코드 주석은 맞고 보고 분류가 틀림. 리더 브리프 오류 1: "주석 전용 변경 오탐 재현 케이스" 는 파서와 무관한 별건(`stop-review-gate.js:225` 한 줄 블록 주석) — 3차 후보. 비차단 JSDoc 1줄 후속. cowork `release.js` 는 eslint config 부재로 lint 미측정(cowork-scripts-lint 5/5 로 대체).
46. **l1-ups 검수 APPROVE(15:0x)** — 교차검수 3점 독립 실측 확인(허용목록 양성·`payload.user_prompt` 생존·`--no-team` flag-surface 판정), 디스패처 실자식 재현 4건이 구현자 프로브와 바이트 일치(893/811/1315/301). minor: 8KB 캡 서로게이트 분리(1줄 보정 지시). 관측: `stripRouterWrapper` 는 래퍼 부재 시 `''` 반환 → 라우터 off 구성이 라이브에 있으면 메모리 컨텍스트가 사라짐(미확인, 3차 확인 항목) · `isLegacyStdoutEnabled` 가 프롬프트마다 config 재판독(지연 미측정).
47. **설계안 2건 착지(architect 15:0x, 오너 결정 5건 §5 승인 대기)** — docs:check: 추적 `.artibot`·`reports/SPLIT` md 93 중 링크 0 broken / 렌더링 15 위반(정본 표 12) → "고치고 넣기" 권장, 서브트리 허용목록 + 추적 파일만 + git 실패 fail-closed. trail: 이관이 아니라 정본 D9(:314) "동결" 실행 권장 — 라이브 트레일은 캐시 4.54.0 에만 9건(다른 캐시 5개 파일 없음 → plugin update 마다 0 리셋), unique writer 는 user-profile·cron 2뿐, 3차 L2 Check 10 줄기와 묶음. 리더 전제 정정: docs:check 479(478 아님), guides 96(95 아님), trail 질문 프레임(이관 vs 동결).
48. **l2-d1 실측(15:1x)** — (a) hooks.json 매처 표현식 `tool == "Agent"` 는 0건, 평문 `"Agent"` 만 발화(A/B 2런) — 설계 전제 정정. (b) Agent 도구 경로의 SubagentStart 는 `agent_type = subagent_type`, `agentName=null`(2/2) — 설계 §2.1 "명명 스폰 = agent_type===name" 불성립; team/autopilot 경로(부모 원장 1025행)는 이름 모양 → 호스트가 경로별로 다른 값. 2차 티어를 name∨subagent_type 로 넓히고 `matched_on` 기록. (c) 봉투 스키마 `additionalProperties:false` 라 `data.stage`·`predicted_selected` 불가 → `idempotency_key = route.pre:<tool_use_id>:<prompt_id>:<subagent_type>` 로 상관 운반(설계 밖 선택, 리더 수용·설계안 갱신 항목). (d) **`claude -p` 라이브 런도 SessionStart→git-autopilot 으로 브랜치 이동**(reflog 14:42:38 `worktree-agent-…` → `artibot/…`) — 디스패처 cwd 샌드박스로는 못 막고 훅 stay-put 예외가 `worktree-agent-*`(하네스 격리 worktree)까지 덮어야 함 → test-git-sandbox 에 전달. (e) 후속 14 실증: hooks.json PreToolUse timeout 5000 vs `--settings` 예시 `timeout: 10`(초) 모순.
49. **[3차 1순위 · 오너 결정 필요] hooks.json 매처 문법 의심(review-l2, 호스트 문서 15:2x WebFetch)** — 호스트 규칙: 매처는 도구명 정확 일치(문자·숫자·`_-`·공백·`,`·`|` 만) 아니면 **JS 정규식(unanchored)**, 표현식 문법 없음. 리포 정본 CONTRIBUTING:456 도 `"Write|Edit"` 평문형. 그런데 hooks.json :22 `tool == "Write" || tool == "Edit"`, :34 `tool == "Bash"`, WebFetch 등 표현식 4종이 실존 → 정규식 해석이면 `tool == "Bash"` 는 절대 불일치(l2 A/B `tool == "Agent"` 0건과 같은 클래스), `||` 가 든 것은 빈 대안 때문에 **모든 도구에 매치**(pre-write-guard·pre-write-checkpoint·git-autopilot-guard 가 Bash/Agent 에도 발화 가능). 추론·미측정. 다음: `--settings` A/B 1회로 4종 실측 → 결과에 따라 hooks.json 매처 전면 평문화(설계안 불필요, 버그 수리 클래스) — 단 hooks.json 로더가 --settings 와 같은 파서인지 미확인.
50. **후속 14 확정(review-l2, 호스트 문서)** — `timeout` 은 **초**(command 기본 600). hooks.json PreToolUse 7항 `5000` = 5,000초, 설계 ROUTE-RECEIPT §4 "3초 SIGTERM 안전망"은 실재하지 않음. CONTRIBUTING:466 "milliseconds" 는 문서 오류. 타임아웃 훅은 도구 호출을 막지 않음(non-blocking). 다음: 값 전면 재설정은 오너 결정(파일 전체 관행) — 3차.
51. **l2-d1 검수 APPROVE(15:2x)** — 8형태 직접 스폰 재현 exit 0·stdout 0·stderr 0, 64KB 행 1,814B≤4,096, 265/266 pass. R2: FIFO 매칭이 `agent_type==='teammate'` 게이트 없이 적용 → 영수증 없는 스폰이 남의 receipt 를 가져갈 수 있음(격리는 됨, D4 분모 흐림). 원장 fifo 쌍 1건 추가 존재. 짧은 session_id 는 `no-mission` 미기록(경계 픽스처 없음).
52. **test-git-sandbox 완료(15:3x)** — (1) 3슬롯 실측 구멍 0(패턴 통일·심층 방어), 자기검증 초안이 거짓 그린(sandboxCwd 직접 읽음)이었던 것을 스스로 잡음, 스캐너가 주석 아포스트로피에 오판하던 것 수정. (2) stay-put = isSplitLimbBranch ∨ `worktree-` 접두. (3) `branchRelocatedByHook` 3값(null=미관측). (4) split.md 300줄 래칫에 정확히 걸려 기존 줄 문장 추가로 처리(300→300). land.mjs lint 행 — Windows `.bin/eslint.cmd` 무shell spawn EINVAL → execPath+JS 엔트리. 소유 밖 편집 1(`split-window-contract.test.js:311` n=2 핀, 추인). **규약 위반 1**: 팀원이 `git stash push/pop` 실행(즉시 복원, 손실 0) — 브리프 금지 조항이 격리 worktree 팀원에게도 필요함을 실증. 미확인: `session-start.test.js` 1 fail 이 줄기 변경 탓인지(master 메인 트리는 23/23 — 리더 실측) → 검수 항목.
53. **2차 배치 랜딩 착수(15:4x)** — 4줄기 검수 전부 APPROVE(fable 4명: p19·l1·l2·tgs). review-tgs 는 보고 직후 세션 한도(resets 16:50)로 종료 — 보고는 완결. 로컬 docs 커밋 70fc838b 는 배치 랜딩 뒤 새 master 위로 재적용(브랜치 v5-docs-b3 에 보관, master 는 origin 으로 reset — 워킹트리 변경은 runtime/cache-roi-session.json 뿐이라 손실 0). test-git-sandbox 검수 주의 3건 추인: SplitWindow 펜스 1불릿(#21) · 비-git mkdtemp(계획 문구 갱신 대상) · lint 행 .cjs 미대상(CI 가 잡음).
54. **2차 배치 첫 랜딩 실패(15:5x) — README 수치 게이트** — l2-d1 이 훅 스크립트 +1(`route-observe-pre.js`)·등록 +1 을 넣었는데 README 두 파일의 카운트 주장 6곳(26 등록·69 스크립트)이 미갱신 → CI "Validate README claims" 가 Node 20/22/24 에서 RED(테스트 전 단계). README 는 어느 줄기도 소유하지 않는 파일 — gotcha #14("깨질 파일"이 allowlist 밖) 클래스 재발. 처치: `scripts/ci/sync-readme-claims.js` 로 6곳 정정 후 배치 위에 커밋, ci 브랜치 갱신. 다음(plan 단계): 훅 스크립트/등록·agents·commands·skills 개수를 바꾸는 줄기는 README 2파일 + sync 스크립트 실행을 완료 기준에 자동 동반. 부수: Windows 260자 한도 — 스크래치 temp 경로 + 한글 ADR 파일명이면 worktree add 가 "Filename too long" 으로 실패(리포 안 `.claude/worktrees/` 짧은 경로 사용).
55. **임시 worktree 에서의 pre-push(16:0x)** — (a) `node_modules` 부재 → 훅이 fail-closed 로 거부(정상). `npm ci` 는 5분 타임아웃 → 메인 트리 node_modules 를 junction 으로 연결해 해결(리포 `worktree-setup` 과 같은 방식). (b) junction 직후 첫 푸시에서 structure·doc-links·md-render 3게이트 FAIL 로 BLOCKED(28s) — 그러나 단독 실행·동시 실행·훅 직접 호출(24s, 10/10 ok) 모두 통과, 재현 불가. 첫 실행의 일시 상태로 추정(캐시/파일 잠금 — 미확인). `--no-verify` 는 쓰지 않았다. (c) 스크래치 temp 경로에 worktree 를 만들면 한글 ADR 파일명이 Windows 260자 한도를 넘어 `Filename too long` — 리포 안 `.claude/worktrees/<짧은이름>` 사용.
56. **[결함 확정 · 3차 후보] `scripts/ci/ci-utils.js:74 gitTrackedNames` 가 훅 환경에서 플러그인 루트 0개로 오판(16:1x)** — git 이 pre-push 에 절대 `GIT_DIR` 을 넘기고 `GIT_WORK_TREE` 가 없으면, `cwd: <하위디렉터리>` 로 실행한 `git ls-files -z` 가 하위 상대경로가 아니라 **리포 루트 기준 전체 1973개**를 돌려준다(실측: agents/·skills/·commands/ 어디서든 1973). 첫 세그먼트만 취하는 파서가 `plugins` 만 보게 되어 structure·doc-links·md-render 3게이트가 "expected plugin root contributed no agents at all" 로 FAIL. 메인 트리 푸시·CI·훅 직접 호출(env 없음)에선 재현 안 됨 — 링크드 worktree 에서 `git push` 할 때만. 수리안: `ls-files -z -- .` 에 `--full-name` 대신 `git -C base ls-files -z .` + `GIT_DIR` 무시(`env: {...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined}`) 또는 결과를 `base` 기준으로 재상대화. 이번 푸시는 훅 직접 호출 10/10 ok 확인 후 리포가 명시 허용한 `ARTIBOT_SKIP_PREPUSH=1` 한 명령으로 우회(--no-verify 아님, 셸 이력에 남음).
57. **2차 배치 두 번째 랜딩 실패(16:2x) — 줄기 간 상호작용 3건, 단독 스위트는 전부 그린이었음** — (a) test-git-sandbox 가 land.mjs 에 lint 행을 추가 → 1차 p2 의 `limb-landing-check.test.js:407` `toHaveLength(6)` RED. (b) l1-ups 의 신규 `ups-stdout-allowlist.test.js` 가 디스패처를 spawn → test-git-sandbox 의 스포너 래칫(6개 고정) RED. (c) l2-d1 이 `subagent-handler.js#observeRoute` 심볼 제거 → `commands/scorecard.md:80` 인용이 유령 → citation 게이트 RED. 세 건 모두 "A 줄기가 B 줄기(또는 과거 배치)의 테스트가 핀한 값을 바꾼" 형태 — 파일 소유권 겹침 0 이어도 **계약 겹침**은 plan 이 못 본다. (c)는 게이트 2개(citation: 심볼 실존 요구 / command-doc: scorecard.md 줄 삭제 금지)가 같은 바이트에서 충돌 → 규율 §10 대로 게이트 무수정, 설계 쪽(심볼 보존 별칭)을 택함. 다음(plan 단계): 줄기 완료 기준에 "배치 통합 후 리포 전체 vitest 1회"를 리더 단계로 명시하고, 줄기가 export/심볼을 제거할 때 리포 전역 `#symbol` 인용 grep 을 완료 기준에 동반. CI 로그는 `gh run view --log-failed` 가 빈 결과를 줄 수 있어 `gh api .../jobs/<id>/logs` 로 받아야 했다(교훈).

### 7.6 1차 §4 개선안의 반영 여부

| 1차 §4 항목 | 2차에서 |
|---|---|
| #18/#22 (1) 근본 — 디스패처 cwd 격리 | ✅ `60dab1dd` 로 **선행 착지**, 나머지 3개(C-2~C-4)와 신규 파이어월도 `test-git-sandbox` 로 착지(기록자 재확인: 4/4 `cwd: sandboxCwd`, `dispatcher-cwd-sandbox-required.test.js` 실재). 다만 #48(d)가 **`claude -p` 라이브 런도 같은 경로**임을 보여 격리만으로는 부족했다 |
| #18/#22 (2) 방어선 — stay-put | ✅ `test-git-sandbox` 착지. 범위를 `isSplitLimbBranch` → **`worktree-` 접두 전체**로 넓혔다(#52) |
| #18/#22 (3) status 표시 | ✅ `branchRelocatedByHook` 3값(null = 미관측)(#52) |
| #16 팬아웃 절 | ✅ 템플릿 팬아웃 절 착지(#52). 팀원 스폰 프롬프트에 "리포 전체 vitest 금지" 도 추가(#37) |
| #25 land lint 행 | ✅ 착지 — 다만 **이것이 실패 ②(a)의 원인**이 됐다(1차 테스트가 6행을 핀) |
| #14 깨질 테스트를 allowlist 에 | ⚠️ **부족했다** — #54(README)·#57(계약 겹침)로 **2회 재발** |
| 후속 19 나머지 | ✅ `p19-rest` 12자리 착지, 검수 12/12 diff 대조(#45) |
| #21 ref 조작 금지 · #24 보고 계약 | ⚠️ **미편입** — #52 가 팀원 `git stash` 실행으로 **필요성을 실증**했다 |
| #3·#9·#10·#11·#12·#29 (`split.md` 문구) | ⚠️ **미편입**. `split.md` 는 300줄 래칫에 걸려 있어(#52) 추가 여력이 없다 — 래칫 상향 또는 참조 문서 분리가 선행 |

### 7.7 미확인 (2차 배치)

- **랜딩 CI 결과** — 랜딩 자체는 확인했으나(`838d86bd`, 4/4 조상, `origin/master` 일치) **랜딩 후 CI 실행분은 조회하지 않았다.**
- ⚠️ **이 절을 쓰는 동안 상태가 바뀌었다(규율 §6 시점 관측 ≠ 상태).** 집필 시작 시점에는 `838d86bd` 가 master 조상이 **아니었고** 이 표에 "미착지 · TBD-리더" 로 적었다. 집필 중 리더가 랜딩·푸시를 완료해 재측정 후 고쳤다. **두 관측 모두 각 시점에는 참이었다** — 이 절의 다른 사후 실측(§7.1 줄기 수치 · §7.3 ref)도 같은 위험을 갖는다.
- **브랜치 이동이 4/4 인지 2/4 인지**(§7.3) — 현재 ref 와 fold 메시지는 **2/4**. 런 중 상태는 보지 못했다.
- **"리포 전체 vitest 금지" 지시의 효과** — 대조군 0. 재발이 줄었는지 측정되지 않았다.
- **#49 매처 문법** — 추론·미측정. `hooks.json` 로더가 `--settings` 와 같은 파서인지도 미확인.
- **#55(b) 3게이트 FAIL** — 재현 불가. 첫 실행의 일시 상태로 추정될 뿐 원인 미확정.
- **#52 `session-start.test.js` 1 fail** 이 줄기 변경 탓인지 — 검수 항목으로 남았다.
- **#46 `stripRouterWrapper` 가 래퍼 부재 시 빈 문자열** — 라우터 off 구성이 라이브에 있는지 미확인.
- **리더 브리프의 줄기별 삽입/삭제 3건이 어느 시점 측정인지**(§7.1) — 측정 시각이 적히지 않아 추론했다.
- **`test-git-sandbox` 2커밋 중 1건만 `done` 트레일러인 이유** — 조사하지 않았다.
- 기록자는 **2차 배치를 실행하지 않았다.** 이 절은 전부 리더 보고 + 교훈 원장 + 사후 git·ref 실측이며, 런 중 관측은 하나도 없다.

### 7.8 교훈 #58~#61 원문 (`.artibot/split/gotchas.md` — 회고 §7 착지(e569e2da) 이후 추가분, 삭제·요약 없음)

> 크로스머신 이동(2026-09-04 18:0x) 전에 옮겨 적음. `gotchas.md` 는 gitignore 라 다른 머신에 없다.

58. **2차 배치 랜딩(16:4x)** — 3회차 CI 전체 그린 → master 838d86bd ff(landing-flow 게이트 "필수 4 + 전체 7"). 배치 구성: 4줄기 15커밋 + README 동기화 + 통합 수정 = 67파일 +5,259/-614. 랜딩 시도 3회(README 게이트 → 계약 충돌 3건 → 그린). docs 커밋 cherry-pick 재적용 f09fa2c0(설계안 2건 워킹트리 복귀 — reset 으로 잠시 사라졌던 것은 브랜치 보관 덕에 손실 0). 정리: worktree 5 · 브랜치 8 삭제, 잔여 = 1차 창 4개(세션 락, 오너가 창 닫은 뒤). 오늘 master 랜딩 6회: ca013e2c · 520886bd · 60dab1dd · 5570ec85 · e0aa2580 · 838d86bd (+ f09fa2c0 진행 중).
59. **회고 §7 착지 시 리더 값 정정 2건(record, 17:1x)** — (a) 줄기별 +/- 는 리더가 마지막 커밋 **직전**에 잰 값이었다(l1 +1179/-106 · l2 +1738/-336 · p19 +1002/-84 가 tip 기준). 수치엔 측정 시각을 붙이라는 규율을 리더가 어겼다. (b) "4줄기 모두 훅에 의해 artibot/ 이동" 은 **2/4**(l2-d1·test-git-sandbox)가 사실 — fold 커밋 메시지 [1/4][2/4]만 접두 이름, 현재 ref 도 2쌍만. 리더가 14:44 스냅샷의 2건을 4건으로 일반화. (c) test-git-sandbox 는 2커밋 중 done 트레일러 1건(03928ce2 는 무트레일러) — first-parent 판독엔 무해. record 는 2차 런 중 관측이 0 임을 명시(§7.7) — 사후 git 실측만으로 쓴 절.
60. **CI 폴링 스크립트의 만료 오탐(17:5x)** — e569e2da 폴링이 TIMEOUT(코드 2)으로 끝났으나 실제는 7/7 그린. 원인: 첫 `sleep 80` + 14회×45s ≈ 11.8분 상한이 오늘 CI 소요(약 12~13분, 러너 대기 포함)에 못 미침. f09fa2c0 폴링은 ci 브랜치 갱신으로 잡이 취소돼 "완료 7 미만" 으로 만료(예상된 종료). 다음: 폴링 상한을 `wait_for_green` 처럼 20분으로, 종료 코드 2 는 "미확인"이지 "실패"가 아님을 리더가 구분(오늘은 구분했다).
61. **창을 닫아도 worktree 락이 남음(18:0x)** — `claude --worktree` 창 4개를 닫은 뒤에도 `git worktree list` 에 `locked claude session … (pid N)` 4건 잔존, pid 는 전부 죽어 있음(tasklist 실측). 하네스가 종료 시 `worktree unlock` 을 안 한다. 리더 처치: 각 worktree 수정 0·미추적 0·master 조상 확인 → `git worktree unlock` → `remove` → `prune` → 병합 브랜치 삭제. 다음: `/split` §integrate `landed` 후처리에 "죽은 pid 락은 unlock 후 remove(살아 있으면 KEEP)" 절차를 넣고, `status` 표의 `locked(pid)` 열에 pid 생사를 병기.
