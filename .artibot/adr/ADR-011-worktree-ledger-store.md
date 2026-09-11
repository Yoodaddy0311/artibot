---
status: active
created: 2026-09-11
number: 11
---

# ADR-011: linked worktree 원장 위치 — StateStore 와 같은 git-common-dir 동거(안 a)

## 추천 결론 (TL;DR)

> **원장의 물리 위치를 StateStore 의 위치 규칙(`resolveStoreLocation`)에 종속시켜 `<git-common-dir>/artibot/ledger.jsonl` 로 옮기는 안 (a) 를 채택한다.** 비-git 루트에서는 현행 경로 `<projectRoot>/.artibot/runtime/ledger.jsonl` 로 폴백하므로 tmpdir 테스트와 비-git 프로젝트의 동작은 바이트 단위로 같다. 설계 §3.6 의 "ONE physical ledger of record" 는 오늘 worktree N개 = 물리 원장 N개로 이미 깨져 있고(2026-09-11 14:22 KST 실측 1+3), 이 ADR 은 경로 절만 고쳐 그 원칙을 복원한다. 안 (b) 합산은 지워진 worktree 의 역사를 보지 못해 2026-09-10 사건(worktree 5개 원장 분산, 버전 10개 누락)을 구조적으로 재발시키고, (c1)(c3) 은 OD-4 F3 결정 또는 `resolveProjectRoot` 소비자 전부를 끌고 들어가므로 기각한다. 제3안으로 검토한 (c5) worktree-setup 의 junction 링크(`linkDirs` 에 `.artibot/runtime` 추가, lib 코드 0)는 실효는 있으나 `/split` 이 만든 worktree 에만 미치고 `rm -rf` 가 부모를 따라 지우는 실측 위험이 있어 **임시 처방으로도 권하지 않는다.**

## Status

Accepted — 2026-09-11, 오너 결정 4건(리더 경유, 2026-09-11) 반영: ① 이 줄기(W5-b)는 `ledger.jsonl` 만 옮긴다 — `spawns.ndjson` 은 다음 웨이브 W5-b-6 ② 구파일 `ledger.jsonl.pre-adr011` 보존, 삭제는 v4.60.0 릴리스 태그 뒤 릴리스 체크리스트 항목 ③ 훅 지연 임계치 없음 — `hook-latency.mjs --n 20` base/HEAD 슬롯별 p50 보고만 ④ 설계 정본 §3.6 리터럴 개정 승인. 초안은 split 창 `doctor-project-name` 의 architect 정찰(읽기 전용, 코드·커밋 0)이 썼다. 착지 순서는 **W5-a(project name) → 이 ADR(W5-b B0) → W5-b 코드(B1~B5)**. 브리프 초안 `.artibot/split/worktree-ledger-store/brief-draft.md`(85줄, 01:19~01:30 KST)와 리더 실측(14:22 KST)을 입력으로 받아 인용을 재검증했다(§0). 착지 창 재검증(2026-09-11 B0)은 §0 표 0-14~0-19 행.

---

## 0. 선행 정찰 검증 — 어디가 맞고 어디가 틀렸나

| # | 출처 | 주장 | 판정(이 창 재독, 2026-09-11 리더 실측 직후) |
|---|---|---|---|
| 0-1 | 리더 D2 | worktree 루트에서 Check 8 을 돌리면 store−ledger = {1..14} 로 **FAIL 3/3** | **집합 계산은 맞고 판정 문구는 틀리다.** 절차가 내는 실제 판정은 오늘 **`unmeasured`** 다. `doctor-checks.js#checkLedgerStateParity` 는 `projection` 이 없으면 `parity-inputs-absent` 로 조기 반환하고 `compareLedgerVersions` 에 도달하지 않는다(:336-348). 세 worktree 모두 `.artibot/state.yaml` ENOENT(리더·브리프 공통 실측)이므로 집합 대조 자체가 실행되지 않는다. `unmeasured` 는 `pass` 보다 높게 랭크되므로(`RANK` :70) 초록은 아니다. **잠복 FAIL**: worktree 에서 첫 mission 커밋이 일어나면 `state-manager.js#createStateStore` 가 `<projectRoot>/.artibot/state.yaml` 을 렌더하고(:221, :288) 그 순간부터 D2 는 실제 FAIL 이 된다 — 그리고 그 커밋은 D1 도 동시에 만든다. 두 방향은 독립 사건이 아니라 **같은 첫 쓰기에서 동시에 켜진다.** |
| 0-2 | 리더 추론 | split 창은 cross-session 메시지로 구동되어 UPS 파이프라인이 안 돈다 | **기전 실측(코드), 페이로드 미포착(추론).** `hooks/hooks.json:174-186` UPS → `scripts/hooks/_userprompt-dispatcher.js`. `#classifyPromptSource`(:471-495)가 `NON_USER_BODY_MARKERS` 의 `<cross-session-message `(:439)로 시작하는 본문을 `user:false` 로 분류하고 `main()` 은 `runtime-prompt`(→ `preparePrompt` → `tasks.js`) 를 부르기 전에 반환한다(:514-520, "0 hooks run"). 따라서 `mission.candidate_deferred` 0 건은 "substantive 게이트에서 deferred" 가 아니라 **컴파일 단계 자체가 실행되지 않음**과 정합한다. 파생 추론: 그 표는 2026-09-10 에 확장됐고 그 전에는 peer 메시지가 6개 훅을 전부 돌렸다(:378-382 자인). 09-10 worktree 5개가 mission 을 쓴 것과 오늘 0/3 이 그 경계의 양쪽이라는 설명이 가장 단순하다(시각 대조는 미확인). **함의**: D1 은 사람이 worktree 창에 직접 프롬프트를 치거나 `-p`/SDK(`USER_PROMPT_SOURCES` :354)로 구동될 때마다 재발한다. 3개 창의 실제 UPS 페이로드는 포착하지 않았다. |
| 0-3 | 리더 | doctor.md Check 8 Step 0 "worktree 루트가 정답, 원장은 worktree 자기 것" | **맞다.** `commands/doctor.md:297-301`. 같은 문서 :414-415 "cannot see: 두 번째 worktree" 도 같은 전제. |
| 0-4 | 리더 | `artibot.config.json#/stateStore` 주석의 junction 미검증(I5) | 주석은 그대로다(:870). 그러나 **I5 는 실질적으로 닫혔다**: ① `worktree-setup.mjs` 가 junction 을 거는 대상은 `node_modules` 뿐이고(:18, :208) `.git` 은 git 이 쓰는 파일이다 ② `tests/commands/doctor-checks-8-9.test.js` G16 이 실제 `git worktree add` 로 `.git` 파일 케이스를 돈다(:1034-1090) ③ 결정적으로 2026-09-10 사건 자체가 증거다 — worktree 5개 세션의 `state_version` 이 **하나의** journal 에 착지했다(NEXT-SESSION.md:60, :80-82 이 트리 사본). 주석 갱신은 W5-b-4. |
| 0-5 | 브리프 | `#checkLedgerStateParity`(:257-291), G16 프로즈(:911-933), Check 10 mismatch(:871-874), NEXT-SESSION.md:31 | **심볼은 전부 맞고 줄번호는 부패.** 이 트리(W5-a 편집 반영)에서 각각 :332-376, :998-1150, :1017-1023, :80-82. 이하 이 ADR 은 심볼 + 시각으로 인용한다. |
| 0-6 | 브리프 | `event-writer.js#ledgerFilePath`(:239-241) `path.join`, git·env 참조 0 | 맞다. `path.join` 이라 `opts.ledgerPath` 에 절대경로를 줘도 우회 불가(Windows 에서 `C:\a\C:\b` 형태로 망가짐, 추론). |
| 0-7 | 브리프 | `state-store-wiring.test.js:34-41` 헤더 "worktree 분산 미측정" | 맞다. 위치는 `tests/project-state/`(firewall 아님). |
| 0-8 | 브리프 | `spawn-ledger.js` `<projectRoot>/.artibot/ledger/spawns.ndjson` | 맞다(:10, :66 `LEDGER_REL`, :79, :184, :226). |
| 0-9 | 브리프 | `subagent-handler.js:333` 128KB 꼬리 | `RECEIPT_TAIL_BYTES=131072`(:249), `readLedgerTail`(:329), 세션 필터로 호출(:530). 맞다. |
| 0-10 | 브리프 | `.gitignore:137` runtime, `:115` ledger | 맞다. |
| 0-11 | 브리프 | "현 시점 위반 0" | 메인 루트 기준만 맞다. worktree 루트에서는 0-1 대로 `unmeasured`(잠복 FAIL). |
| 0-12 | 브리프 | `v5-config-firewall.test.js` `ALLOWED_SUBKEYS` 가 `ledger` 신키 차단, `:217-220` 상대경로 핀 | 맞다(:138-142, :217-220). |
| 0-13 | doctor.md:253-257 | "store 는 per worktree" | 이건 **Check 7 의 decisions 스토어**(`.artibot/runtime/decisions/`) 얘기라 StateStore 와 모순이 아니다. 독자가 헷갈릴 수 있어 적어 둔다. |
| 0-14 | 이 ADR §2(a) | 변경 지점 "테스트 3파일 치환" | **목록이 틀렸고 수는 5(+예측 밖 1)다 — B2 실측(2026-09-11 16:0x KST) 기준.** 구현 후 RED 가 된 파일: `hook-decision-invariance.test.js`(:109·:111, 2 failed) · `tests/runtime/human-asked-record.spawn.test.js`(:82 `.git`, :115 리터럴, :245-249 케이스 B, 5 failed) · `tests/firewall/host-payload-contract.test.js`(:115·:121 `git init`, :122 FILE, 1 failed) · `tests/firewall/state-updated-pairing.test.js`(:277 리터럴, 1 failed — B0 적용 창의 "주입 스텁이라 안 깨진다" 판정은 **틀렸다**: 스텁이 `.git` 을 만들지 않아도 store 의 journal 쓰기가 `<root>/.git/artibot/` 디렉터리를 디스크에 만들고, 그 뒤 실 `resolveGitCommonDir(root)` 가 그 디렉터리를 본다 — 브리프 원문이 맞았다) · **예측 밖** `tests/runtime/middleware/tasks.test.js`(3 failed; 소유 allowlist 밖이라 창이 편집을 추인·리더 보고 — `storeDir()` 부재를 "스토어 미기록" 의 프록시로 쓰던 단언이 원장 공유 디렉터리 생성으로 무효화, 파일 부재 단언으로 교체 + 차단 케이스는 스토어만 alt common dir 로 격리, 단언 무완화). `subagent-handler-routing-fields.test.js`(:530-535)는 **깨지지 않았다** — `bindRoute` 가 빈 tail 에서 `skipped:unbound` 로 append 전에 반환해 픽스처의 차단이 도달 불가였다(기존 느슨함; 픽스처 경로 치환 + 단언 고정 + 헤더 맹점 명기로 처리). |
| 0-15 | 이 ADR §5 ⑦ | "G16 문구 테스트(:1146) 갱신" | **틀렸다.** `tests/commands/doctor-checks-8-9.test.js:1146-1157` 이 핀하는 7문구(`resolveProjectRoot`·`read project root:`·Check 9·Check 10·`.artibot/missions/`·`loadReplay`·`readSpawns`)에 :297-301 의 "worktree's own" 문구는 없다(B0 grep, 2026-09-11). 기존 describe 무수정, W5-b describe 추가(B4). |
| 0-16 | 브리프 §측정 "훅 지연" | 벤치 leak-scan 맹점 "미확인" | **코드로 확정(실행 전).** `scripts/bench/hook-latency.mjs#defaultGuardSpecs`(:1637-1658) 의 가드는 `<USERPROFILE>/.artibot`(tree)·`<USERPROFILE>/.claude/artibot`(leak-scan)·`<PLUGIN_ROOT>/runtime`(informational)·`<repo>/.artibot/runtime`(observe, :1646)·`<main>/.artibot/runtime`(tree, :1648-1653) 5개 — `<git-common-dir>/artibot/` 를 보는 가드 0. 샌드박스는 헤더 :41-42 자인대로 `git init` 1커밋이라 변경 후 벤치 훅은 새 분기(`resolveGitCommonDir` → `<sandbox>/.git/artibot/`)를 실제로 탄다 → p50 차이는 새 경로를 잰 값. 대신 실 리포로 새는 원장 쓰기는 `<main>/.git/artibot/ledger.jsonl` 에 떨어져 가드 밖이고, :1613-1623 observe 주석도 낡는다(이미 "Four entries" 인데 코드는 5개). 소유 밖 후속. |
| 0-17 | 브리프 정정 | `hook-decision-invariance.test.js:82` = `APPROVED` | :82 는 빈 줄이 맞으나 `APPROVED` 는 **:84** 다 — 초안 판정의 ":81" 도 틀렸다(:81 은 `HOOK` 상수; B0 착지 창 재측정 2026-09-11). 원장 관련은 헤더 :19-24(이미 ADR-011 반영 문구)·:110-112(`.git` mkdir)·:114-115(케이스 B)·`ledgerEvents`(현 :171). 판정 영향 0. |
| 0-18 | 이 ADR·브리프 | `state-manager.js` :97·:109·:132 | B0 첫 읽기 시점엔 맞았고 같은 세션 안에서 B1(커밋 f4882946)이 착지해 지금은 `lib/project-state/store-location.js`(:40 `STORE_DIR_NAME`·:43 `FALLBACK_RELATIVE`·:57 `resolveStoreLocation`) + `state-manager.js` :100 import·:125 re-export. 줄번호는 썩는다 — 이하 심볼로. |
| 0-19 | 신규 | 인용 게이트 | 이 ADR 은 `.artibot/adr/` 착지 즉시 `tests/firewall/citation-resolution.test.js` 스캔 대상(`scripts/ci/validate-doc-links.js#gatherAllDocFiles` 가 `.artibot/adr` 추적 파일 포함). 등록 루트 아래 `:NN`·`#symbol` 인용만 판정, 위반은 baseline 래칫. `state-manager.js#resolveStoreLocation` 은 re-export 줄이 `hasJsSymbol` 의 `export {…}` 분기에 걸려 계속 ok. |

---

## 1. Context (실측, 분모·시각 포함)

**두 저장소, 두 위치 규칙(코드 실측).** 원장은 `lib/runtime/event-writer.js#ledgerFilePath` = `path.join(projectRoot, rel)`, `rel` = `artibot.config.json#/ledger/path` = `.artibot/runtime/ledger.jsonl`(`DEFAULT_LEDGER_REL` 동일). journal 은 `lib/project-state/state-manager.js#resolveStoreLocation` 이 `lib/project-state/git-common-dir.js#resolveGitCommonDir` 를 한 단계 더 타서 `<commonDir>/artibot/`(폴백 `<projectRoot>/.artibot/runtime`). 둘 다 같은 `projectRoot` 를 받고(`tasks.js#openMissionStore` :452-465, 원장 append 는 :462 같은 root), 차이는 `resolveGitCommonDir` 한 호출뿐이다. `resolveGitCommonDir` 는 순수 fs(statSync 1 + readFileSync ≤2), 예외 없음, walk-up 없음(:122-161).

**Check 8 판정 키.** `doctor-checks.js#compareLedgerVersions` 는 journal 의 `state_version` 집합과 원장 `state.updated.data.state_version` 집합만 대조한다. journal 레코드에는 session_id 도 project 도 없다(리더 실측 0/21). `store − ledger ≠ ∅` → `ledger-subset-violation` FAIL.

**라이브 실측(리더, 2026-09-11 14:22 KST, 읽기 전용 스크립트).**

| 대상 | 값 |
|---|---|
| 메인 원장 `<parent>/.artibot/runtime/ledger.jsonl` | 346행 · 203,626 B · 세션 21 · `state.updated` 14(v1..14 완비) · `mission.created` 17 · `mission.candidate_deferred` 193 · ts 2026-09-03→09-11 |
| Wave 5 worktree 원장 3개(`.claude/worktrees/split-artibot-*/`) | doctor-project-name 6행(route.selected 3/bound 3) · guard-normalize 4행 · release-claims-sync 5행(human.asked 1). **`mission.*` 0/3, `state.updated` 0/3, `candidate_deferred` 0/3** |
| 공유 journal `<parent>/.git/artibot/project-state.jsonl` | 21행 · v1..14 · mtime 2026-09-10T07:54Z · `project` 키 0/21 |
| Check 8 집합(계산값) | 메인 루트: store−ledger = ∅. worktree 루트 3개: {1..14}(단, 절차 판정은 §0-1 대로 `unmeasured`) |
| 짝 파일 `spawns.ndjson`(`<projectRoot>/.artibot/ledger/`) | worktree 8/12/9행 vs 메인 1,213행 |
| `.artibot/runtime/decisions/` | 메인만 12건 · `.artibot/state.yaml` 메인만 2,158 B |

**2026-09-10 사건(NEXT-SESSION.md:60, :80-82, 이 트리 사본).** worktree 5개 세션이 mission 을 써서 journal 에 v{2,3,4,5,7,8,10,11,12,13} 이 생겼고 메인 원장에는 없었다 → 메인에서 FAIL. worktree 제거 후에도 FAIL 지속. 처치: 백업한 worktree 원장 10파일 151행을 메인 원장에 append(147→298행, 08:53:26Z) → parity PASS. **원장은 worktree 와 함께 사라지지만 journal 은 남는다**는 비대칭이 사건의 형태다.

**두 방향(둘 다 이 ADR 의 대상).**
- **D1** worktree 세션이 mission 을 쓴다 → 공유 journal 은 버전을 얻고 메인 원장은 못 얻는다 → 메인 루트에서 FAIL, worktree 삭제 후에도 영구. 발생 조건: worktree 창에 사람이 직접 프롬프트(또는 `-p`/SDK)를 넣을 때(§0-2). 오늘 0/3, 09-10 5/5.
- **D2** 어느 worktree 루트에서든 Check 8 을 돌리면 자기 원장(거의 빈 파일)과 공유 journal 을 비교한다 → journal 이 비어 있지 않은 한 집합 위반. 오늘 판정은 `unmeasured`(projection 부재), worktree 에 state.yaml 이 생기는 첫 커밋부터 FAIL(§0-1).
**설계 정본과의 관계.** `ARTIBOT-5.0-DESIGN.md:20` OD-4 "F3 = 위치는 worktree 가 공유하는 git-common-dir 아래 → Replay Store·Checkpoint Store 도 같은 백엔드·같은 위치", `:491` "정본은 ledger.jsonl 하나", `event-writer.js` 헤더 :5 "ONE physical ledger of record". 반면 §3.6 의 경로 리터럴은 `<projectRoot>/.artibot/runtime/ledger.jsonl`(헤더 :8, config :865). 원칙과 리터럴이 worktree 존재 시 충돌하며, ADR 에 ledger/store 항목은 0(INDEX.md 10건 확인).

**게이트 현황.** `tests/firewall/ledger-append-survival.test.js` 는 3프로세스 × 20행 60/60 을 핀하고 N>3·4KB 근접·네트워크 FS 는 못 본다고 자인한다(:21-35). `tests/project-state/state-store-wiring.test.js:34-41` 은 "worktree 분산·동거 미측정" 자인. `tests/project-state/git-common-dir.test.js:105-140` 이 `.git` 파일 케이스(합성)를, G16 이 실제 `git worktree add` 를 덮는다. `tests/runtime/event-writer.test.js` 의 `it('honors an explicit ledgerPath override')`(:420-427, 단언 :426)는 `opts.ledgerPath` 명시 시 상대 join 유지를 이미 핀한다 — (a) 의 "명시 시 현행 유지" 조건(`event-writer.js#ledgerFilePath` :263-264)은 신규 게이트 불요.

---

## 2. Alternatives Considered

### (a) 원장도 `<commonDir>/artibot/ledger.jsonl` — **채택**
- **내용**: `ledgerFilePath(projectRoot, opts)` 가 `opts.ledgerPath` 명시 시 현행(상대 join) 유지, 아니면 `resolveGitCommonDir(projectRoot)` → 있으면 `resolveStoreLocation(...).dir + basename(rel)`, 없으면 현행 `path.join(projectRoot, rel)`. `resolveStoreLocation`·`STORE_DIR_NAME`·`FALLBACK_RELATIVE` 를 fs 없는 신설 `lib/project-state/store-location.js`(L2) 로 이주하고 `state-manager.js` 는 re-export. L5→L2 하향 import, 순환 없음(event-writer→store-location/git-common-dir; state-manager→store-location; tasks→ledger,state-manager).
- **장점**: D1·D2 를 같은 한 줄로 닫는다. 지워진 worktree 의 역사가 남는다. 위치 규칙이 한 곳(`store-location.js`)이 되어 "원장은 어디" 와 "store 는 어디" 가 정의상 같은 답이 된다. 폴백이 현행 경로와 바이트 동일이라 비-git tmpdir 테스트는 자동 그린. writers 5·readers 6(브리프 전수)이 전부 `ledgerFilePath` 를 경유하므로 호출부 무수정.
- **단점**: 창 N개가 **처음으로 한 파일에 동시 append** 한다(오늘은 창마다 자기 파일). `subagent-handler.js` 128KB 꼬리가 N창 트래픽을 받는다. `spawns.ndjson` 이 로컬에 남아 Check 10 이 비대칭이 된다. 훅 append 마다 stat+read ≤3 syscall 추가. 1회 이관 필요.
- **변경 지점**(브리프 소유 allowlist 와 일치, 2026-09-11 B0): 코드 4 — `event-writer.js#ledgerFilePath` + 헤더 :5-8 · 신설 `store-location.js`(fs 0) · `state-manager.js`(이주 + re-export) · `ledger.js` 헤더. 테스트 신설/확장 5 — `store-location.test.js` 신설 · `event-writer.test.js` +3 · `ledger-store-colocation.test.js` 신설(G1~G4) · `ledger-append-survival.test.js` N=8 케이스 + 헤더 · `state-store-wiring.test.js` 헤더 :34-41 + :123-128 stale 주석. 테스트 치환 5 + 예측 밖 1(픽스처 또는 store 의 journal 쓰기가 디스크에 실제 `.git` 을 만들어 새 경로로 간다; B2 실측 RED 기준, §0-14) — `hook-decision-invariance.test.js`(:109 `.git`, :111 케이스 B → `.git/artibot` FILE, :168 리터럴) · `human-asked-record.spawn.test.js`(:82 `.git`, :115 리터럴, :245-249 케이스 B) · `host-payload-contract.test.js`(:121-122 Case 4) · `state-updated-pairing.test.js`(:277 리터럴 → `ledgerFilePath`; 주입 스텁이지만 journal 쓰기가 `<root>/.git/artibot/` 을 실제로 만든다) · `subagent-handler-routing-fields.test.js`(:530-535; RED 는 아니었으나 픽스처 의도 유지를 위해 치환 + 단언 고정) · **예측 밖** `tests/runtime/middleware/tasks.test.js`(allowlist 밖, 3 failed, 창 추인). 리터럴 핀이지만 깨지지 않는 6파일(비-git 픽스처 = 폴백)은 **무수정, 실행으로 증명** — 편집 대상이 아니다. 문서 — 이 ADR + `INDEX.md` 행·총계 · 설계 §3.6 :214 · `commands/doctor.md` Check 8(Step 0 :285-288, :297-301, :414-415)·Check 10(:547-548, :591-592) 블록 안에서만 · `doctor-checks-8-9.test.js` W5-b describe 추가. **이 줄기 밖(리더 일괄)**: config 주석 2곳(:865·:870) · `.gitignore:134-136` 주석 · CHANGELOG · `tasks.js:84`.
- **회귀·결합**: `v5-config-firewall` `ALLOWED_SUBKEYS` 는 신키를 막으므로 키를 만들지 않는다(§5 ②). `scorecard.md:67` raw `process.cwd()` 는 cwd 가 리포 루트가 아니면 오늘도 틀린 트리를 읽으므로 별건 유지.

### (b) 원장 로컬 유지 + `/doctor` 가 살아있는 worktree 원장 합산 — 기각
- **내용**: Step 1 이 `git worktree list --porcelain` 열거 → `readLedgerCensus` × N → concat → 리더 dedupe. `doctor-checks.js` 무수정(events 주입).
- **장점**: 코드 0~2, 쓰기 경로 무변경, 동시성 무영향.
- **단점**: **지워진 worktree 원장은 못 본다** → 09-10 형태를 그대로 둔다. `readLedgerCensus` 의 census(`file.path`)가 N개가 되어 Check 8 보고 형식이 바뀐다. worktree 안에서 돌릴 때는 메인 원장까지 열거해야 하므로 "worktree 자기 것" 프로즈(G16)도 어차피 바뀐다. 읽기 측 임시 관측으로는 쓸 수 있으나 결정이 아니다.

### (c1) journal 도 worktree 로컬(대칭화) — 기각
F3 되돌림. 설계가 "측정한 실패"(`state-manager.js` 헤더 :18-26)로 명시 거부한 형태. 창마다 `state_version` 이 갈라진다.

### (c2) 봉투에 worktree 식별자 + land 시 병합 — 기각
`schemas/ledger-envelope.schema.json` `additionalProperties:false`(:17) 라 봉투 키 추가 = 스키마·`OPTIONAL_ENVELOPE_KEYS`(:128-131)·vocab 게이트 동반. `scripts/split/land.mjs` 는 원장을 전혀 만지지 않는다(grep 0건, 판정 전용). 수동 `worktree remove` 경로는 병합을 거치지 않아 소실. 사건의 원인(물리 파일 분산)을 그대로 두고 후처리를 얹는 형태.

### (c3) `resolveProjectRoot` 를 common dir 로 — 기각
`lib/git/project-root.js#resolveProjectRoot`(:122-145) 는 missions/·decisions/·state.yaml·spawns·current-task-budget 전부의 루트다. 범위 폭발이고, worktree 안에서 "이 트리의 missions/" 를 잃는다.

### (c5) worktree-setup 의 junction 으로 `.artibot/runtime` 을 메인에 링크 — 검토 후 불채택(임시 처방으로도)
- **내용**: `artibot.config.json#/split/worktree/linkDirs`(:831 에 `plugins/artibot/node_modules` 기존)에 `.artibot/runtime` 추가. `worktree-setup.mjs` 가 `fs.symlinkSync(…, 'junction')`(:208) 로 링크. lib 코드 0.
- **장점**: 즉효, D1·D2 동시 해소, 기존 메커니즘 재사용.
- **단점**: `/split` 이 만든 worktree 에만 적용(수동 `git worktree add`·autopilot worktree-manager 는 제외 → fail-open). `rm -rf` 가 junction 을 따라 부모를 지운 실측 기록(`worktree-setup.mjs` 헤더 :11 "957 parent", NEXT-SESSION gotcha 68). `decisions/` 까지 공유되어 T-37 의미가 바뀐다. 파일 위치 규칙이 코드가 아니라 링크 배치에 의존해 "왜 여기 있나" 를 코드가 설명 못 한다.

### (c6) 위치 규칙 단일화 자체를 결정으로 — (a) 의 구현 형태로 흡수
"원장은 store 가 있는 곳에 있다" 를 규칙으로 명문화하고 (a) 를 그 첫 적용으로 둔다. §5 의 결정 원칙.
**트레이드오프 요약(가중치는 에이전트 정의 기준: 유지보수 30 / 확장 25 / 모듈성 20 / 단순성 15 / 확장점 10)**

| 안 | D1 | D2 | 삭제된 worktree | 변경 폭 | 동시성 신규 위험 | 판정 |
|---|---|---|---|---|---|---|
| (a) | 닫힘 | 닫힘 | 보존 | 중 | 있음(측정 필요) | **채택** |
| (b) | 열림 | 닫힘(살아있는 것만) | 소실 | 소 | 없음 | 기각 |
| (c1) | 형태 변경 | 닫힘 | 소실 | 소 | 없음 | 기각(F3 충돌) |
| (c2) | 후처리 | 열림 | 조건부 | 대 | 없음 | 기각 |
| (c3) | 닫힘 | 닫힘 | 보존 | 폭발 | 있음 | 기각 |
| (c5) | 닫힘 | 닫힘 | 보존 | 최소 | 있음 | 불채택(fail-open·rm 위험) |

---

## 3. 확장성 관점

- **창 수 N.** (a) 는 N 에 선형으로 한 파일의 쓰기 빈도가 는다. 훅 append 는 라인당 1 syscall, 락 없음, 4KB 캡. 실측 게이트는 N=3. `/split` 관측 최대는 창 12개(NEXT-SESSION.md:111, 오너가 직접 연 경우). 게이트를 N=8 로 **확장**(완화 아님)해야 주장이 닿는다.
- **비-git·다중 리포.** 폴백이 현행과 동일하므로 비-git 프로젝트는 영향 0. 중첩 리포(walk-up 없음)는 `git-common-dir.js` 규칙을 그대로 따른다.
- **멀티호스트(Postgres 어댑터).** 설계 :425 대로 v5.0 범위 밖. 이 ADR 은 단일 호스트 worktree 공유만 다룬다.
- **Replay/Checkpoint Store.** OD-4 가 "같은 위치" 를 이미 결정했으므로 `store-location.js` 가 그 두 저장소의 위치 규칙도 받을 수 있다(확장점). 지금 만들지는 않는다(YAGNI).

## 4. 숨겨진 비용

1. **꼬리 창 희석(추론).** `subagent-handler.js#readLedgerTail` 은 마지막 128KB 만 읽고 세션으로 거른다. 메인 원장 평균 ≈589 B/행(203,626/346) → 꼬리 ≈220행. 창 N개가 10분 안에 220행 이상을 쓰면 receipt 가 꼬리 밖으로 밀려 `skipped:unbound` 가 는다. 오늘 총량(8일 346행)으로는 먼 위험이지만 측정 없이 "없다" 고 말하지 않는다.
2. **Check 10 비대칭.** 공유 원장의 `route.selected/bound` 는 전 창 합산, `spawns.ndjson` 은 로컬 → `unboundReceipts ≠ unboundSpawns` 일 때 WARN(`checkRouteBindResidue`, 둘 다 >0 조건). FAIL 아님. §5 ③.
3. **훅 지연.** append 마다 `statSync(.git)` + `.git` 파일 1줄 + `commondir` 1줄. 훅은 단명 프로세스라 프로세스 캐시로는 못 줄인다. 수치 미측정 → `scripts/bench/hook-latency.mjs` 로 전후 비교(§5 ⑥).
4. **`.git` 과 운명 공유.** 오늘은 journal 만 `.git/artibot/` 에 있고 원장은 워킹트리에 있다. 이관 후 `.git` 삭제(재클론)가 두 기록을 함께 지운다. 둘 다 이미 미추적이라 clone 에는 어차피 없지만, "history 는 워킹트리에" 라는 직관이 깨진다. `.git/artibot/` 을 백업 대상에 넣는 운영 규칙이 필요하다.
5. **한글·`.git` 경로 하네스 제약.** worktree 창의 Bash 는 `.git` 이 든 경로를 거부한다(메모리 `project-worktree-harness-git-path-block`). 이관·실측 스크립트는 ASCII 파일 경유 node 로.
6. **설치본 ≠ 리포.** 훅은 설치본에서 돈다. 머지 직후가 아니라 **설치 갱신 직후**부터 새 경로에 쓰이므로 이관 시점은 릴리스·설치 뒤다(§1회 이관 절차 0).

---

## 5. Decision (채택 — 오너 승인 2026-09-11)

> ## ✓ **채택: (a) — 원장 위치 = StateStore 위치 규칙의 출력. `ledgerFilePath` 가 `store-location.js` 를 따르고, common dir 이 없으면 현행 경로로 폴백.**

**원칙(위치 규칙 한 줄):** *원장과 집합 비교되는 append-only 기록(journal, ledger, spawns)은 git common dir 아래 한 곳에 산다. 투영(state.yaml)·진단 런 스토어(decisions/)·스크래치는 `projectRoot` 로컬에 남는다.*
**브리프 초안의 미결 7건에 대한 답(③·⑤·⑥ 은 오너 결정 반영, 2026-09-11 리더 경유):**

| # | 결정 | 답 |
|---|---|---|
| ① | 위치 | `<commonDir>/artibot/ledger.jsonl` **확정**. basename 은 `ledger.path` 의 basename 을 쓴다(오늘 `ledger.jsonl`). |
| ② | config 키 신설 vs `stateStore.location` 추종 | **추종.** 신키 0(`ALLOWED_SUBKEYS` 무수정). `ledger.path` 는 "비-git 폴백 경로" 로 의미가 좁아지며 값·`v5-config-firewall :217-220` 핀은 불변. 주석만 갱신. |
| ③ | `spawns.ndjson` 동반 이동 vs Check 10 세션 필터 | **규칙상 동반 이동**(집합 비교되는 기록). 단 `.artibot/ledger/` 는 대화 원장(사적 데이터, `.gitignore:115`)과 같은 디렉터리라 별 줄기(W5-b-6, `spawn-ledger.js#spawnLedgerPath` 만)로 분리. **오너 결정 ①(2026-09-11, 리더 경유): 이 줄기(W5-b)는 `ledger.jsonl` 만 옮긴다 — `spawns.ndjson` 은 다음 웨이브 W5-b-6.** 그 사이 doctor.md Check 10 "cannot see"(:591-592) 에 비대칭 문장("원장은 전 창 합산, spawns 는 이 트리 — W5-b-6 전까지 `checkRouteBindResidue` 의 mismatch WARN 은 구조적일 수 있다")을 넣는다(B4). 세션 필터는 기각(공유 원장에서 세션으로 자르면 Check 10 이 "이 창" 의 검사로 좁아져 창 간 잔여를 못 본다). |
| ④ | decisions 스토어 2원화 | **허용, 명문화.** T-37 관측 전용, Check 7 이 이미 "per worktree" 로 서술(doctor.md:253-257). 원장과 비교되지 않는다. |
| ⑤ | 이관 순서·구파일 | 메인 파일 순서 그대로 → `git worktree list --porcelain` 순으로 worktree 원장 순서 그대로. **ts 재정렬 없음**(append-only 의미 보존, 리더가 `(session,source,pid,seq,ts)` 로 dedupe). 구파일은 삭제하지 않고 `ledger.jsonl.pre-adr011` 로 개명 보존. **오너 결정 ②(2026-09-11, 리더 경유): 보존한다. 삭제는 v4.60.0 릴리스 태그 뒤 릴리스 체크리스트 항목 — 이 줄기 밖(§1회 이관 절차 4).** |
| ⑥ | 훅 지연 허용치 | **오너 결정 ③(2026-09-11, 리더 경유): 임계치 없음.** `scripts/bench/hook-latency.mjs --n 20` 을 base 커밋과 HEAD 에서 각각 돌려 슬롯별 p50 전후 표(증감 부호 포함)를 보고만 한다(브리프 완료 기준 2). 판정 기준이 아니라 관측 기록이다. 벤치 가드가 `<git-common-dir>/artibot/` 를 못 보는 맹점(§0-16)을 결과 옆에 명기한다. |
| ⑦ | doctor.md 개정 순서 | W5-a 착지 → W5-b 코드 → **같은 커밋**에서 doctor.md Check 8 Step 0 :285-288 심볼(`store-location.js#resolveStoreLocation`)·:297-301("worktree 자기 것" → "같은 공유 원장, `census.file.path` 로 확인; projection 은 여전히 트리별")·:414-415, Check 10 :547-548·:591-592 갱신 + `tests/commands/doctor-checks-8-9.test.js` 에 W5-b 문구 핀 describe **추가**. 기존 G16·W5-a describe 는 무수정 — :1146-1157 이 핀하는 7문구에 :297-301 문구는 없다(2026-09-11 B0 grep). G16 의 핵심 주장 "루트를 하나만 푼다" 는 유지되므로 게이트 완화가 아니다. 오너 결정 불요, 순서만. |

**추가 결정 — 오너 승인 완료 ④(2026-09-11, 리더 경유):** `ARTIBOT-5.0-DESIGN.md` §3.6 의 경로 리터럴(:214 "물리 정본 = `<projectRoot>/.artibot/runtime/ledger.jsonl` 하나")을 "`<git-common-dir>/artibot/ledger.jsonl`(비-git 폴백 `<projectRoot>/.artibot/runtime/ledger.jsonl`)" 로 개정한다(B0, 착지 커밋 921dcf3c). 같은 파일의 §3.6 밖 `ledger.jsonl` 언급 16줄(B0 실측)은 완전 경로 리터럴이 아니라 손대지 않는다. 설계 정본 편집은 오너 게이트(메모리 `feedback-design-canon-first`)였고 이 건은 통과했다.

---

## 6. Consequences

- D1·D2 가 같은 한 줄에서 닫힌다. worktree 를 지워도 그 세션의 history 가 남는다.
- Check 8 의 `census.file.path` 가 루트에 무관하게 같아진다. **projection 은 여전히 루트별**이라 worktree 에서의 Check 8 은 W5-a(project name)가 착지해야 `pass` 에 닿는다. 그 전까지 worktree 루트 판정은 `unmeasured`(state.yaml 부재) 또는 `projection-drift` 다.
- 창 N개의 동시 append 가 처음 생긴다 → 게이트 N=8 확장 + 라이브 1회 실측이 완료 조건.
- 비-git 프로젝트·tmpdir 테스트는 무변경. `.git` 디렉터리를 합성하는 테스트만 새 경로를 본다(브리프 미확인 8파일의 red/green 은 구현 시 실측).
- 설계 §3.6 리터럴·config 주석 2곳·`.gitignore:134-136` 주석이 낡은 문장이 된다(W5-b-4).
- `.git/artibot/` 이 두 기록의 집이 되므로 백업·정리 절차에 그 경로가 들어가야 한다.

## 7. 2년 뒤 기술 부채 예상 포인트

1. **무회전 단일 파일.** `lib/runtime/` 에 원장 rotation 은 없다(grep `rotat` 0, dashboard 제외). 8일 204KB 를 단순 외삽하면 연 ~9MB(추론) — 크지 않지만 128KB 꼬리와 전체 읽기(`readLedgerCensus` 는 파일 전체를 읽는다 :253)가 함께 늘어난다. 회전이 들어오는 날 "회전된 파일은 Check 8 집합에 들어가나" 를 다시 결정해야 한다.
2. **두 위치 의미론.** git 안에서는 공유, 밖에서는 로컬. 문서가 하나를 잊으면 다시 오늘의 비대칭이 된다. `store-location.js` 헤더에 두 경우를 나란히 적어 두는 것이 방어다.
3. **`.git` 내부 데이터 의존.** git 이 `.git/` 하위 낯선 디렉터리를 언젠가 정리 대상으로 삼거나(현재 `gc`·`prune` 은 건드리지 않음, 추론), bare/`GIT_COMMON_DIR` 환경변수 레이아웃(자인 미지원 :33-36)이 등장하면 두 기록이 동시에 길을 잃는다.
4. **`spawns.ndjson` 이관이 미뤄진 채 남으면** Check 10 WARN 이 "늘 있는 경고" 가 되어 진짜 mismatch 를 가린다. ③ 의 시점 결정을 미루지 않는 것이 비용 회피다.
---

## 되돌리기

코드 1곳 + 파일 복사 1회. 플래그를 두지 않는다(YAGNI, 게이트가 두 갈래를 다 봐야 하는 비용이 더 크다).
1. `event-writer.js#ledgerFilePath` 를 `path.join(projectRoot, rel)` 로 되돌린다(`store-location.js` 이주는 그대로 둬도 무해).
2. `<main>/.git/artibot/ledger.jsonl` 을 `<main>/.artibot/runtime/ledger.jsonl` 에 append(둘 다 append-only, 리더 dedupe 가 중복을 흡수). `.pre-adr011` 사본이 있으면 손실 0.
3. doctor.md :297-301·G16 문구·config 주석 되돌림. 신규 firewall 은 삭제(폴백 케이스만 남기면 오늘 동작의 핀이 된다).
4. 되돌린 뒤 worktree 창이 다시 자기 파일에 쓰기 시작한다 — D1·D2 복귀를 알고 하는 선택이다.

## 게이트

**신규 `tests/firewall/ledger-store-colocation.test.js`(vitest, 파일 부재 = red):**
- G1 합성 linked worktree(`git-common-dir.test.js` 의 `makeLinkedWorktree` 재사용) 에서 `writeEvent(mainRoot)`·`writeEvent(wtRoot)` → 두 `result.path` 가 같고 `<main>/.git/artibot/ledger.jsonl` 이며, `readLedgerCensus(wtRoot).census.file.path === readLedgerCensus(mainRoot).census.file.path`, events 2.
- G2 `.git` 없는 루트 → `result.path === <root>/.artibot/runtime/ledger.jsonl`(오늘과 바이트 동일, 폴백 핀).
- G3 wtRoot 에서 실 `createStateStore`(실 `resolveGitCommonDir`, 실 writer) 1커밋 → mainRoot 와 wtRoot 양쪽에서 `checkLedgerStateParity` 에 `ledger-subset-violation` 0(`project` 는 명시 전달, projection 은 쓴 루트의 원문).
- G4 G16 패턴으로 실제 `git worktree add` 1건에서 G1 재확인(git 부재 시 G16 과 같은 처리).
- `ledger-append-survival` 를 N=8 프로세스로 **확장**(기존 N=3 케이스 유지).

**이 게이트가 못 보는 것(규율 §9):** N>8·4KB 근접·네트워크 FS 의 `'a'` 원자성 / 라이브 훅 페이로드(테스트는 writer 를 직접 부른다) / 훅 지연 / 128KB 꼬리 희석 / 지워진 worktree 의 history 보존(구조로 보장, 테스트는 "지운 뒤에도 파일이 있다" 이상을 증명 못 함) / projection 이름 드리프트(W5-a 게이트) / `spawns.ndjson` 비대칭(③ 전까지) / 설치본이 새 코드인지(설치본 grep 은 사람이) / 훅 지연(완료 기준 2 의 벤치가 잰다 — 임계치 없음, 오너 ③; 그 벤치의 가드는 `<git-common-dir>/artibot/` 를 못 본다, §0-16) / 이관 정확성(완료 기준 3 의 스크래치 드라이런이 잰다 — 실 스토어 상태·이관 시점에 살아있는 창의 동시 쓰기·설치본 경로는 못 본다) / 테스트 자체가 실 `<parent>/.git/artibot/` 을 오염시켰는지(`git status` 에 안 보이는 경로라 조용하다 — G1~G4 는 tmp 루트만 쓰고 그 사실을 헤더에 적는다) / doctor.md 문구(이 게이트가 아니라 `doctor-checks-8-9` 의 W5-b describe 가 핀) / 훅이 넘기는 projectRoot 가 worktree 루트인지(G16 별도).

## 1회 이관 절차

0. **전제**: W5-a 착지, W5-b 코드가 릴리스·**설치본 갱신 완료**(훅은 설치본에서 돈다), split 창 전부 닫힘(`git worktree list` = master 1건). 설치본 `event-writer.js` 에 `store-location` import 가 있는지 grep 으로 확인.
1. **백업**: 메인 원장 + 살아있는 worktree 원장 전부를 스크래치로 복사, 각 행수·sha256 기록(이 시점 재측정 — 14:22 값 346/6/4/5 는 낡는다).
2. **병합 스크립트**(ASCII `.mjs`, 파일 경유 실행): 대상 `<commonDir>/artibot/ledger.jsonl` 이 **이미 있으면 중단**(fail-closed, 오너 판단). 메인 → worktree 순, 원문 행 그대로(재직렬화·정렬 없음, 빈 줄 제거). W5-b 드라이런 스크립트: `<worktree>/.artibot/split/worktree-ledger-store/migrate-ledger.mjs`(미추적, `.gitignore:93`), sha256 `3379aa6fb3d7bc0c668a0955654ccd7885a6335eb524cc7e86e752a7ebecca12` — 인터페이스 `--main <f> [--worktree <f>...] --out <f> [--report <json>]`, exit 0/1/2/3(선존재)/4(행수 불일치, 출력 삭제). 드라이런 실측(2026-09-11 06:45Z, investigator 독립 재현): 메인+worktree 5 = 384행 Σ 일치, 출력 sha256 `3bb1aee4…`, `loss.duplicate` 0, 선존재 재실행 exit 3. 실 이관 시점에 `plugins/artibot/scripts/` 로 승격 + direct-run-guard 적용 여부는 리더 결정(이 줄기 밖).
3. **검증**: 결과 행수 = Σ 입력 비공백 행수. `readLedgerCensus(mainRoot)` 의 `loss.duplicate` 보고(0 기대, 아니면 그대로 보고). 메인 루트와 worktree 루트 1곳(새로 하나 만들어) 에서 Check 8: `ledger-subset-violation` 0, 두 `census.file.path` 동일. 결과를 NEXT-SESSION 에 시각과 함께 기록.
4. **구파일**: `ledger.jsonl.pre-adr011` 로 개명(삭제 금지, 보존 기간은 ⑤).
5. **라이브 확인**: 메인 창 1 + worktree 창 1 에서 사람이 프롬프트 1개씩 → 공유 파일에 session_id 2종, `mission.candidate_deferred` 또는 `mission.created` 각 1 이상, Check 8 위반 0, Check 10 결과(`pass`/`warn`/`unmeasured`) 명시.

## 미확인

- 3개 worktree 창의 실제 UPS 페이로드(`prompt` 본문 선두·`source`) — §0-2 는 코드 기전 + 결과 정합이지 포착이 아니다.
- 2026-09-10 dispatcher 표 확장 시각 vs 사건 세션 시각의 선후.
- 브리프의 리터럴 유지 6파일 + 자동 추종 6파일의 red/green — 폴백 설계상 그린 예상이나 실행 전 판정 불가.
- 벤치 가드 맹점(§0-16)은 코드 정적 확인 — 실제 누수 발생 여부는 실행 전.
- `resolveGitCommonDir` 훅 지연 실수치 · Windows `'a'` N>3 원자성 · 128KB 꼬리 희석 임계.
- 리더의 "worktree 루트 집합 대조" 가 journal 을 `resolveGitCommonDir` 경유로 찾았는지(찾았다면 I5 를 한 번 더 닫는 증거). — 창 주석(2026-09-11 14:4x KST): **경유하지 않았다.** 창의 측정 스크립트는 부모 `.git/artibot/project-state.jsonl` 경로를 직접 적었다. I5 의 추가 증거가 아니다.
- `~/.artibot` 홈 스토어로 새는 원장 유무(NEXT-SESSION P2), 삭제된 worktree 원장 백업 현황.
- 설계 §3.6 본문의 정확한 경로 문장(`ARTIBOT-5.0-DESIGN.md` 는 F3 행 :20·:415·:491·:568 만 읽었다).
