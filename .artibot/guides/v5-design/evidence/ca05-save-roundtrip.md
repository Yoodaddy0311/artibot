# CA-05 `/save` 체크포인트 왕복 증거 — 조건 d·c (R3 `ca05-save-roundtrip`)

| 항목 | 값 |
|---|---|
| 대상 | V5-BACKLOG CA-05 · §4-b `runtime.checkpoint.saveOnSave` 행의 플립 조건 **d**(실 writer 로 `mission.checkpointed` 1행 왕복 — exit 0 이 아니라 원장 행)와 **c**(`save-checkpoint.js` + `commands/save.md` 가 릴리스로 라이브에 실리고, 설치된 `/save` 산문이 그 pass 를 실제로 부름) |
| 위임 | v5 마무리 웨이브 계획 R-6 — 플립 커밋은 리더가 별도로 한다. **이 문서는 config 를 바꾸지 않았다.** `plugins/artibot/artibot.config.json` 1076행은 측정 시점에 `"saveOnSave": false` 그대로다 |
| 기준 커밋 | 리포 `eae2cf09a76074888814aca00c39e3f3ce2fabcd` (`release: v4.68.0`) |
| 설치본 | artibot 4.68.0 · `installed_plugins.json` 의 `gitCommitSha` 가 위 40자와 동일 · lastUpdated 2026-09-29T03:23:52Z · 사용자 `settings.json` 의 `enabledPlugins` 에서 `artibot@artibot` 가 `true` |
| 측정 창 | 2026-09-29T04:36Z – 05:12Z (UTC) · win32 · node v24.15.0. 아래 수치는 전부 §2 의 명령이 낸 출력이다 |
| 경로 표기 | 랜딩 게이트(금지 인용)가 절대 사용자 경로를 거부하므로 `<HOME>` = 사용자 홈, `<INSTALLED>` = `<HOME>/.claude/plugins/cache/artibot/artibot/4.68.0`, `<REPO>` = 메인 체크아웃 루트, `<WT>` = 이 줄기의 worktree, `<S>` = 작성자 스크래치 |

## 0. 판정 (먼저)

| 조건 | 판정 | 등급 |
|---|---|---|
| **d** 실 writer 로 `mission.checkpointed` 1행 왕복 | **충족 — 범위는 §7 에 적힌 것으로 한정** | 실측 |
| **c-파일** 설치본이 착지 산출물과 동일 (R-6 이 적은 "설치본 `commands/save.md` sha = 착지 커밋"의 정의) | **충족** | 실측 |
| **c-호출** 설치된 산문이 pass 를 **실제로 부름** (§4-b 문언의 후반) | **미확인 — 플립 전에는 측정할 수 없고, 플립 자체가 유일한 측정이다** | 미확인 |

근거 세 줄:

1. **(d)** 임시 리포 ON 1건에서 원장이 1줄 → 2줄이 됐고 그중 `mission.checkpointed` 는 0 → 정확히 1행이다(나머지 1줄은 시드 `state.updated`). 원장 원문 줄 · 체크포인트 저장소(`latestValid`) · 별 프로세스 CLI `resume-report.mjs` 가 같은 `checkpoint_id` 를 가리키고, 생산 판독기 `readLedgerCensus` 와 스코어카드 fold 는 그 행을 1건으로 센다. 대조 4건(OFF · NOSESSION · NOMISSION · BADSOURCE)은 0행이고, 계측기는 "저장은 됐으나 원장에 안 남음"(BADSOURCE)까지 0 으로 읽는다. 사전 선언 점검 140/140.
2. **(c-파일)** 설치본 `commands/save.md` · `lib/checkpoint/save-checkpoint.js` 는 리포와 바이트 동일이고, CR 을 뺀 설치본의 git blob id 가 `HEAD` 의 커밋 blob 과 같다. `lib` · `schemas` 등 445개 파일이 동일하다.
3. **(c-호출)** 산문은 호출문을 담고 있다(`buildSaveCheckpoint(ports, …)`). 그러나 출하 코드 중 이 pass 를 부르는 곳은 0 이다(§4.4). 산문을 읽는 모델만이 호출자다. 그리고 출하 config 가 `false` 이므로 라이브 `/save` 는 이 단계를 스킵하도록 설계돼 있다 — "라이브 행 0" 은 호출한다/안 한다 어느 쪽의 증거도 아니다.

**리더가 알아야 할 추가 발견 (§3.5 실규모 재생)**: 이 리포의 실 저장소에는 지금 활성 mission 이 **32건**이고(전부 세션 대체 id `M-YYYYMMDD-S…`, 체크포인트 0건), pass 는 활성 mission **전부**를 대상으로 한다. 실 스냅샷 사본(05:07Z)에 돌리면 `/save` 1회 = 32행(32 저장 · 0 거부 · 0.9초 · 원장 +약 12KB)이다. 위의 "1행 왕복"은 mission 1건짜리 픽스처의 결과이고, 플립 뒤 라이브 `/save` 1회의 산출량은 그 시점의 활성 mission 수에 비례한다(사본에서 실측한 값이 32건이다. 라이브 값은 그 시점에 다시 재야 한다).

이 문서는 플립 여부를 권고하지 않는다. R-6 의 두 확인 조건(d, c)에 대한 측정 결과와 그 한계를 낸다.

## 1. 방법

1. **시험 대상.** `plugins/artibot/lib/checkpoint/save-checkpoint.js#buildSaveCheckpoint` 를 `plugins/artibot/commands/save.md` 의 Phase A½(45~60행)가 적은 포트 그대로 실 모듈에 배선해 구동했다: `listActiveMissionIds` · `getMission` · `getTaskGraph` 는 StateStore(`lib/runtime/middleware/tasks.js#openMissionStore` — 훅이 쓰는 생산 개방 경로), `checkpointService` 는 `createCheckpointService` 위에 `createCheckpointStore` · `createFileStoreAdapter`(저장 위치는 `resolveStoreLocation(...).dir`), `appendEvent` 는 `appendLedgerEvent(projectRoot, envelope)`(경로 오버라이드 없음 — 생산 경로 해석). 보고 포트는 기본값(`resume-controller.js#buildResumeReport`).
2. **호출자가 없어서 이 프로브가 호출자다.** 리포·설치본 전수 grep 에서 비테스트 코드가 이 pass 를 참조하는 곳은 모듈 자신과 주석 1건뿐이다(§4.4). 게이트 파일 `tests/firewall/save-checkpoint-order.test.js` 머리말(48~52행)도 "호출자는 UNMEASURED" 라고 적는다. 그래서 아래 배선은 "출하 코드가 하는 일"이 아니라 "산문이 시키는 일을 실 모듈로 옮겨 본 것"이다. 형제 사례: `scripts/checkpoint/resume-report.mjs` 머리말(5~10행) "Prose is not a caller".
3. **왕복(round trip)의 정의.** 쓰기 = pass 1회 → 체크포인트 파일 1레코드 + 원장 1줄. 읽기는 서로 다른 네 경로다: (a) 원장 파일 원문 줄 스캔(프로브 자체), (b) 생산 판독기 `lib/runtime/ledger.js#readLedgerCensus`(event 필터 · 손실 census 포함), (c) 별 프로세스 `scripts/checkpoint/resume-report.mjs --mission … --json`(체크포인트를 `latestValid` 로 읽음, 쓰기 포트 없음 — 실행 전후 저장소 디렉터리 해시 동일을 매 시나리오 확인), (d) `loadReplay` → `buildSessionScorecard` 의 `session.checkpoints` 지표(`lib/scorecard/session-scorecard.js` 194~201행).
4. **게이트(config) 취급.** 생산 로더 `lib/core/config.js#loadConfig`(119~120행)는 플러그인 루트의 `artibot.config.json` 하나만 읽고 프로젝트별 오버라이드가 없다. 대신 `lib/core/platform.js#getPluginRoot`(105~106행)가 `CLAUDE_PLUGIN_ROOT` 를 존중한다. 그래서 "임시 리포의 config"는 임시 리포 안의 폴더에 **출하 config 사본**을 두고 — ON 은 `runtime.checkpoint.saveOnSave` 한 키만 `true`, OFF 는 출하본과 바이트 동일 — `CLAUDE_PLUGIN_ROOT` 를 그쪽에 걸어 `loadConfig` 로 읽었다. 원장 writer 의 allowlist·schema 는 모듈 상대 경로(`lib/runtime/event-writer.js` 의 `readPluginJson`, 185행)라 이 환경변수의 영향을 받지 않는다. 게이트 판정은 `isSaveCheckpointEnabled(config)`(106행, 엄격 `=== true`).
5. **격리.** 시나리오마다 `git init -q` 로 새 저장소를 만들었다. 저장소 위치 해석 `lib/project-state/git-common-dir.js#resolveGitCommonDir` 는 부모 디렉터리 탐색과 `GIT_DIR` 환경변수를 의도적으로 쓰지 않는다(머리말 28~36행). 그래서 임시 리포의 원장·저장소가 이 리포의 중앙 원장에 닿을 수 없다. 프로브는 시작 시 호스트의 세션 환경변수 4종을 제거한다(호스트에 있었는지: `CLAUDE_CODE_SESSION_ID` = 있음, `CLAUDE_SESSION_ID` · `ARTIBOT_STATE_DIR` · `CLAUDE_PLUGIN_ROOT` = 없음 — 값은 기록하지 않았다).
6. **사전 선언.** 시나리오별 기대값(`PLAN`)은 실행 전에 스크립트에 고정했고, 점검은 관측을 그 기대값과 비교한다. 종료 코드 0 = 그 시나리오의 모든 사전 선언 점검 통과.
   - `ON` 양성 — 게이트 true, mission 1건 시드, 세션 id 있음 → 기대: pass 행 1, 원장 `mission.checkpointed` 1.
   - `OFF` 음성 — **출하 config 를 바이트 그대로** 사용(게이트 false) → 기대: pass 미실행, 0행.
   - `NOSESSION` · `NOMISSION` 음성 — 게이트 true 이나 세션 id 없음 / 활성 mission 없음 → 기대: `skip:session-missing` / `skip:no-active-mission`, 0행.
   - `BADSOURCE` 계측기 자가검증 — 게이트 true, 그러나 **프로브가** 원장 append 의 `source` 를 allowlist 밖 값으로 바꿔 거부시킨다(제품 결함이 아니라 고의 주입) → 기대: pass 는 `saved` 라 말하고 체크포인트도 남지만 원장 `mission.checkpointed` 는 0, `ledger.rejected` 1.
7. **두 트리.** 같은 프로브를 설치본(`<INSTALLED>`) 5시나리오와 리포 트리(`<WT>/plugins/artibot`, HEAD `eae2cf09`) 2시나리오(ON · OFF)에 돌렸다. 두 트리의 관련 445개 파일이 바이트 동일하므로(§4.1) 결과가 같은 것은 예상된 일이다.

## 2. 재현 명령

부록 A · B · C 의 스크립트를 `<S>` 에 각각 `r3-scenario.mjs` · `r3-livescale.mjs` · `real-ledger-census.mjs` 로 저장한 뒤 (Git Bash 기준):

```bash
INSTALLED="$HOME/.claude/plugins/cache/artibot/artibot/4.68.0"
WT="<이 줄기 worktree>/plugins/artibot"
REPO="<메인 체크아웃 루트>"        # 실 원장 = $REPO/.git/artibot/ledger.jsonl
S="<스크래치>/r3" ; mkdir -p "$S/repos" "$S/out"

# 1) 실 원장 사전 기준선 (읽기 전용)
node "$S/real-ledger-census.mjs" --plugin-root "$INSTALLED" --root "$REPO" > "$S/out/real-BEFORE.json"

# 2) 시나리오마다 새 저장소 + 1회 실행 (종료 코드 0 = 사전 선언 점검 전부 통과)
git init -q "$S/repos/inst-on"
node "$S/r3-scenario.mjs" --plugin-root "$INSTALLED" --repo "$S/repos/inst-on" --scenario ON --label inst > "$S/out/inst-ON.json"
#    OFF · NOSESSION · NOMISSION · BADSOURCE 도 각각 새 git init 후 같은 방식 (--scenario 만 바꾼다)
#    리포 트리: --plugin-root "$WT" --label wt --scenario ON 과 OFF

# 3) 실규모 재생: 실 저장소 스냅샷을 임시 리포로 복사해 사용 (원본은 읽기만)
git init -q "$S/repos/livescale"
node "$S/r3-livescale.mjs" --plugin-root "$INSTALLED" --repo "$S/repos/livescale" \
     --copy-store-from "$REPO/.git/artibot" --label inst > "$S/out/inst-LIVESCALE.json"

# 4) 실 원장 사후 기준선
node "$S/real-ledger-census.mjs" --plugin-root "$INSTALLED" --root "$REPO" > "$S/out/real-AFTER.json"
```

그 밖에 실행한 명령(§4 의 근거):

```bash
sha256sum "$INSTALLED/commands/save.md" "$WT/commands/save.md"          # 바이트 그대로
tr -d '\r' < "$INSTALLED/commands/save.md" | sha256sum                    # CR 제거본 (autocrlf=true 체크아웃은 CRLF)
git rev-parse HEAD:plugins/artibot/commands/save.md                      # 커밋된 blob id
git rev-parse HEAD:plugins/artibot/lib/checkpoint/save-checkpoint.js
diff -rq "$INSTALLED/lib" "$WT/lib"                                      # schemas · scripts/checkpoint 도 같은 방식, 종료 코드 0 = 동일
cmp "$INSTALLED/artibot.config.json" "$WT/artibot.config.json"           # commands/save.md · commands/resume.md · package.json · scripts/hooks/_main-entry.js 도
grep -rl -E "buildSaveCheckpoint|checkpoint/save-checkpoint" .           # §4.4 A (worktree 루트, node_modules 제외)
grep -c '"event":"mission.checkpointed"' "$REPO/.git/artibot/ledger.jsonl"   # 실 원장 원문 카운트
grep -c 'r3-probe-' "$REPO/.git/artibot/ledger.jsonl"                        # 프로브 sentinel 이 실 원장에 있는가
node "$INSTALLED/scripts/checkpoint/resume-report.mjs" --all --cwd "$REPO" --run-json "$S/no-such-run.json" --json   # 실 저장소 활성 mission 목록 (보고 전용, 레인 블록은 건너뜀)
```

스크립트로 남기지 않은 보조 측정 세 가지의 재현 방법: (i) 산문 정적 점검 — 필수 문자열은 `grep -c` 로, 인용 줄은 `sed -n '<줄>p' <파일>` 로 확인한다. (ii) 사용자 슬래시 명령 카운트 — `readLedgerCensus(root, {event:"intent.detected"})` 결과에서 `data.command` 가 `/save/i` 인 행을 센다. (iii) 두 트리 비교 — 위의 `diff -rq` · `cmp`.

원출력 JSON 은 작성자 스크래치(`<S>/out/final/*.json`)에 있다. 세션이 끝나면 사라질 수 있으므로 판정에 쓴 핵심 출력은 이 문서에 인용했다.

## 3. 조건 d

### 3.1 시나리오 매트릭스 (설치본 트리, 최종 실행)

| 항목 | ON | OFF | NOSESSION | NOMISSION | BADSOURCE |
|---|---|---|---|---|---|
| config 출하 → 임시 → `loadConfig` 로 읽은 값 | false → true → true | false → false → false | false → true → true | false → true → true | false → true → true |
| 임시 config 와 출하 config 의 차이 | 1개 키 `runtime.checkpoint.saveOnSave` | 없음(바이트 동일) | 1개 키 | 1개 키 | 1개 키 |
| 게이트 | true | false | true | true | true |
| pass 실행 / skip 사유 | 실행 / - | 미실행 / - | 실행 / `skip:session-missing` | 실행 / `skip:no-active-mission` | 실행 / - |
| pass 행 수 / status | 1 / saved | 0 | 0 | 0 | 1 / saved |
| 행의 `ledger` | `{ok:true}` | - | - | - | `{ok:false, reason:"source-not-allowed:worker"}` |
| 원장 줄 수 전 → 후 | 1 → 2 | 1 → 1 | 1 → 1 | 0 → 0 (파일 없음) | 1 → 2 |
| `mission.checkpointed` 원문 카운트 전 → 후 | **0 → 1** | 0 → 0 | 0 → 0 | 0 → 0 | 0 → 0 |
| `ledger.rejected` 전 → 후 | 0 → 0 | 0 → 0 | 0 → 0 | 0 → 0 | 0 → 1 |
| 생산 판독기 `readLedgerCensus` 의 사건 수 | **1** | 0 | 0 | 0 | 0 |
| 체크포인트 파일 레코드 | 1 | 0 | 0 | 0 | 1 |
| `latestValid(M)` | ok, id 일치 | `ok:false`, errors 0건("저장된 것 없음") | 동일 | 동일 | ok |
| `resume-report.mjs` 의 `checkpoint_id` | 위와 같은 id | null | null | null | 존재(같은 id) |
| 스코어카드 `session.checkpoints` 분자/분모 | 1/1 | 0/1 | 0/1 | 0/0 (unmeasured) | 0/1 |
| 사전 선언 점검 통과 | 28/28 | 16/16 | 16/16 | 16/16 | 20/20 |

리포 트리(`<WT>`): ON 28/28, OFF 16/16 — 값은 위와 같고 id 만 다르다. 합계 140/140 (28+16+16+16+20+28+16). 위 수치는 04:59:33–04:59:41Z 의 최종 실행이다. 그 앞의 첫 실행(04:52–04:54Z)은 BADSOURCE 를 넣기 전 버전의 스크립트였고, ON · OFF · NOSESSION · NOMISSION 이 같은 결과(28/28 · 16/16 · 16/16 · 16/16)였다 — 폐기하고 수치는 최종 실행분만 인용한다. 두 번의 독립 실행이 일치했다는 것 자체가 재현성의 한 표본이다.

### 3.2 ON 원출력 (설치본 트리)

임시 리포 원장 — 2줄. 1번은 시드(`missionMutator` 로 mission 1건을 만든 StateStore 쓰기), 2번이 pass 가 추가한 줄이다:

```json
{"v":1,"ts":"2026-09-29T04:59:33.313Z","event":"state.updated","session_id":"r3-probe-inst-on-mum7iuv8","source":"hook","pid":55912,"seq":0,"mission_id":"M-20260929-901","idempotency_key":"state.updated:M-20260929-901:1:e5eac6a7b532","data":{"state_version":1,"status":"queued","reason":"r3-probe-seed"}}
{"v":1,"ts":"2026-09-29T04:59:33.352Z","event":"mission.checkpointed","session_id":"r3-probe-inst-on-mum7iuv8","source":"supervisor","pid":55912,"seq":1,"mission_id":"M-20260929-901","idempotency_key":"mission.checkpointed:M-20260929-901:cp-mum7iuzm-55912-1-g6dyw6","data":{"checkpoint_id":"cp-mum7iuzm-55912-1-g6dyw6","trigger":"/save","resumable":false}}
```

체크포인트 파일 `checkpoints.jsonl` — 1레코드 (`ts` 04:59:33.346Z, 원장 줄보다 6ms 앞):

```json
{"v":1,"checkpoint_id":"cp-mum7iuzm-55912-1-g6dyw6","mission_id":"M-20260929-901","ts":"2026-09-29T04:59:33.346Z","checkpoint":{"mission_id":"M-20260929-901","session_id":"r3-probe-inst-on-mum7iuv8","intent_revision":1,"plan_revision":1,"active_tasks":[],"completed_action_results":[],"routing_epoch":null,"current_model":null,"artifact_versions":{},"replay_cursor":null,"ledger_cursor":null,"resumable":true}}
```

pass 가 돌려준 행(발췌): `status:"saved"`, `checkpoint_id` 위와 동일, `resumable:false`, `blocked_by:["reconcile:lease-unknown","reconcile:ledger-unknown","reconcile:model-unknown"]`, `ledger:{ok:true,reason:null}`, pass 소요 11ms(설치본) / 12ms(리포 트리).

`readLedgerCensus(root, {event:"mission.checkpointed"})` 의 census: `lines {raw:3, blank:1, nonblank:2}`, `dropped.loss` 전부 0, `selection {rejected_excluded:0, filtered_out:1}`, `survivors:1`. 항등식 `nonblank(2) = loss(0) + selection(1) + survivors(1)` 성립. 판독기가 읽은 파일 경로는 임시 리포의 `.git/artibot/ledger.jsonl` 이다(`realpath` 비교로 확인, `ledgerIsTempRepoLedger: true`).

`resume-report.mjs --mission … --json` (별 프로세스) 발췌: `in_store:true`, `checkpoint_id` 위와 동일, `resumable:false`, `steps {ok:8, failed:0, unknown:1}`, `blocked_by:["reconcile:model-unknown"]`. 스코어카드: `session.checkpoints` 분자 1 / 분모 1, `state:"measured"`.

### 3.3 유효성 대조

| # | 유효성 조건 | 충족 | 근거 |
|---|---|---|---|
| V1 | 양성 대조: ON 이 1행을 낸다 | 예 | §3.1 ON 열, 28/28 |
| V2 | 음성 대조: 출하 config 그대로면 0행 | 예 | OFF 열. 임시 config 가 출하본과 바이트 동일(`byteIdenticalToShipped:true`), 게이트 false, pass 미실행 |
| V3 | 단일 변수: ON 과 OFF 는 config 한 키만 다르다 | 예 | ON 의 `differingPaths` = `["runtime.checkpoint.saveOnSave"]` 하나. 코드·시드 mission·판독기·세션 id 형식은 같다 |
| V4 | 전제 결여 음성: 게이트가 true 여도 세션 id/활성 mission 이 없으면 0행 | 예 | NOSESSION · NOMISSION 열 |
| V5 | 계측기가 실패할 수 있다: "저장됨 ≠ 원장 행" 을 구분한다 | 예 | §3.4 BADSOURCE |
| V6 | 읽기 경로의 독립성: writer 와 다른 코드로 읽어 같은 결과 | 예(부분) | 원장 원문 줄 · 체크포인트 저장소 `latestValid` · 별 프로세스 CLI 는 같은 `checkpoint_id`, 생산 판독기 · 스코어카드는 같은 건수(1)다. 원문 스캔과 판독기는 같은 파일을 읽으므로 "파일에서 독립"은 아니다 — 독립인 것은 writer 코드 경로와의 관계다. 판독기가 돌려준 사건 안의 `checkpoint_id` 를 id 로 대조하는 점검은 이 스크립트에 없다(건수만 대조) |
| V7 | 격리: 임시 원장이 실 원장이 아니다 / 실 원장에 프로브 흔적이 없다 | 예 | §3.6 |
| V8 | 트리 동일성: 설치본과 리포 트리가 같은 결과 | 예 | §3.1 마지막 문단, §4.1 |

### 3.4 BADSOURCE — "exit 0 이 아니라 원장 행"

harness 가 `appendEvent` 포트에서 `source` 를 `worker` 로 바꿔 넣으면(제품이 아니라 프로브의 고의 주입) 실 writer 의 이벤트별 allowlist 가 거부한다. 그때의 관측:

- pass 행: `status:"saved"`, `ledger:{ok:false, reason:"source-not-allowed:worker"}` — **pass 는 성공이라 말한다.**
- 체크포인트 파일에는 1레코드가 있고 `latestValid` · `resume-report.mjs` 가 같은 id 를 읽는다.
- 원장: `mission.checkpointed` **0행**, `ledger.rejected` 1행(`{"raw_event":"mission.checkpointed","reason":"source-not-allowed:worker"}`). 판독기 사건 수 0, 스코어카드 분자 0.

즉 "pass 가 saved 를 돌려줬다"와 "체크포인트 파일이 있다"는 어느 것도 "원장에 행이 있다"의 증거가 아니고, 이 계측기는 그 차이를 0 으로 읽는다. 조건 d 가 "exit 0 이 아니라 원장 행"이라 적은 이유가 실제로 재현된다. 나중에 라이브 원장을 확인할 한 줄 명령 `grep -c '"event":"mission.checkpointed"' <원장>` 은 먼저 임시 원장 세 개에서 시험했다: ON = 1, OFF = 0, BADSOURCE = 0(같은 원장의 `ledger.rejected` = 1).

### 3.5 실규모 재생 — 픽스처가 현실과 다르면 아무것도 증명하지 못한다

위 ON 은 mission 1건이다. 실 저장소의 스냅샷(`project-state.json` 96,553B · `project-state.jsonl` 612,859B)을 새 임시 리포에 복사(바이트 검증 `copyVerified:true`, 원본은 읽기만)해 같은 배선으로 돌렸다. 복사본에는 사용자 프롬프트에서 파생된 mission 제목이 들어 있어 스크래치에만 두었고, 이 문서에는 id 형식과 개수만 실었다. 측정 05:07:11Z:

| 항목 | 값 |
|---|---|
| 사본의 활성 mission | 32건 — 전부 세션 대체 id `M-YYYYMMDD-S<8>`, 숫자 id `M-YYYYMMDD-NNN` 은 0건 |
| pass 행 | 32행, status 는 전부 `saved` (rejected 0 · errored 0 · skipped 0) |
| 임시 원장 | 32줄 전부 `mission.checkpointed`, 12,054 B, 최대 줄 376 B (writer 의 줄 상한은 코드 주석상 4,096 B) |
| 체크포인트 레코드 | 32 |
| 판독기 / 스코어카드 / CLI | 32 / 분자 32 · 분모 32 / 체크포인트 id 가진 mission 32 |
| pass 소요 | 901ms |
| pass 가 저장소에 쓴 것 | 없음 — `project-state.json` sha256 전후 동일, 원장에 `state.updated` 0줄 |
| 사전 선언 불변식 | 11/11 (`every_active_mission_targeted` 등 — 스크립트 부록 B) |

같은 시각 근방(05:05:23Z)에 원본 저장소를 보고 전용 CLI 로 읽은 활성 mission 도 32건이었고 체크포인트 id 는 0건이었다(`checkpoint_id` 를 가진 mission 0). 처음 눈으로 센 "33"은 오독이었고 `grep -c '"in_store": true'` 로 32 를 확인했다.

읽는 법: (1) 실 mission 레코드 32건이 검증·저장·원장 append 를 전부 통과했다 — 실데이터에서 스키마 거부는 관측되지 않았다. (2) 다만 활성 mission 에 숫자 id 가 없고 전부 세션 대체 id 라는 사실은, `/save` 1회가 "작업 mission 1건"이 아니라 오래 쌓인 세션 대체 mission 32건을 각각 체크포인트한다는 뜻이다(설계 결정 ca05-6(a) "활성 mission 전부"의 결과이며 이 줄기가 판단할 일이 아니다).

### 3.6 실 원장 기준선과 격리

측정 명령은 부록 C. 실 중앙 원장은 다른 세션의 훅이 계속 쓰고 있으므로 "파일이 그대로다"는 주장할 수 없다. 주장할 수 있는 것만 적는다.

| 시각 (UTC) | 비공백 줄 | survivors | `mission.checkpointed` | 프로브 sentinel(`r3-probe-`) 포함 줄 |
|---|---|---|---|---|
| 04:51:56 (첫 실행 전) | 42,648 | 42,646 | 0 | 0 |
| 04:57:01 (첫 실행 후) | 42,999 | 42,997 | 0 | 0 |
| 04:59:32 (최종 실행 직전) | 43,154 | 43,152 | 0 | 0 |
| 04:59:41 (최종 실행 직후, 9초 뒤) | 43,158 | 43,156 | 0 | 0 |
| 05:11:52 (실규모 재생 직후) | 43,912 | 43,910 | 0 | 0 (`grep -c` 원문 카운트도 0 / 0) |

- 라이브 `mission.checkpointed` 는 43,910개 survivors 중 0건이다(05:11:52Z, `readLedgerCensus`). 원문 `grep -c '"event":"mission.checkpointed"'` 도 0.
- 위 측정은 첫 실행 · 최종 실행 · 실규모 재생 세 구간을 모두 덮는다. 최종 실행 9초 사이의 +4줄과 나머지 증가분은 다른 세션의 훅 기록이다. 프로브가 쓰는 모든 줄에는 `session_id` 가 `r3-probe-…` 로 들어가므로, 프로브가 실 원장에 썼다면 sentinel 줄이 0 일 수 없다. 0 이었다.
- 원장 파일이 만들어진 6개 시나리오 전부에서(NOMISSION 은 원장 파일이 없어 해당 없음) `ledgerFilePath(임시 리포)` 를 `realpath` 한 값이 `<임시 리포>/.git/artibot/ledger.jsonl` 과 같았다(`ledgerIsTempRepoLedger: true`). OFF 두 건의 `byteIdenticalToShipped: true` 도 원출력에서 확인했다.

## 4. 조건 c

### 4.1 파일 동일성 (설치본 4.68.0 ↔ 리포 HEAD `eae2cf09`)

| 파일 | 바이트 그대로 sha256 (설치본 = 리포) | CR 제거 sha256 | HEAD 커밋 blob id | 설치본 CR 제거본의 blob id |
|---|---|---|---|---|
| `commands/save.md` (26,573 B, CR 248개) | `012c50ff5020ec3fbf93457dc1ccd28f4fb95431e819227c71d25ea409e99ebe` | `e0fc05923649afca0fa49a155a156754032455d8b01508abe322bbc72b0cf489` (26,325 B) | `86c3084aa3f4479a60639fe4f3b058e837d60148` | `86c3084aa3f4479a60639fe4f3b058e837d60148` — **일치** |
| `lib/checkpoint/save-checkpoint.js` (14,299 B, CR 329개) | `65a25455691a411a2f1429de4493e8ec2a978d1b460583c6fb15ac9fc4618206` | `cc26ee6f79636048cd15a995a7ff1db1ab4d19b34d9334c925718488448ba80b` (13,970 B) | `f67dd49cceef634acdf1a1372ea9a70d04c07270` | `f67dd49cceef634acdf1a1372ea9a70d04c07270` — **일치** |

- 이 머신은 `autocrlf=true` 라 체크아웃·설치본은 CRLF, 커밋 blob 은 LF 다. 그래서 blob id 비교는 CR 을 뺀 뒤에 한다. blob id 는 `sha1("blob " + 길이 + "\0" + 내용)` 이고 Node 로 계산했다(부록 D). 커밋 blob id 는 `git rev-parse` 가 독립적으로 낸 값이라 두 계산이 일치한 것이 교차 확인이다.
- `HEAD` 전체 sha `eae2cf09a76074888814aca00c39e3f3ce2fabcd` = 설치 기록의 `gitCommitSha`.
- `lib`(422) · `schemas`(17) · `scripts/checkpoint`(1) + 단일 파일 5개(`artibot.config.json` · `commands/save.md` · `commands/resume.md` · `package.json` · `scripts/hooks/_main-entry.js`) = **445개 파일이 바이트 동일**. 내 도우미 스크립트의 결과(445/445)를 `diff -rq` · `cmp` 로 교차 확인했다(전부 종료 코드 0, 파일 수 422+17+1+5).
- 같은 `save.md` 가 4.67.0 캐시와 마켓 사본에도 있다(sha256 앞 16자 `012c50ff5020ec3f` · 26,573 B 동일).
- `save.md` 를 건드린 커밋: `02e96861`(2026-09-22, 마지막) · `f89818cf` · `9b08fb10` · `8e349fd2` · `b2617f30` · `28b23320`(2026-09-21, CA-05 Phase A½ 산문). R-6 의 "착지 커밋"은 CA-05 첫 산문 커밋이 될 수 없다(그 뒤로 5번 바뀌었다). 이 문서는 "설치본 = 릴리스 커밋 `eae2cf09` 의 blob" 으로 읽었다 — 다른 뜻이면 알려 달라.

### 4.2 설치·활성 상태

- 설치본 디렉터리에서 03:30Z 이후에 수정된 파일은(node_modules 제외, `find -newermt`) 3개뿐이다: `runtime/first-run-state.json` · `runtime/self-control-welcomed.marker` · `.claude-cache/skill-hashes.json`, 셋 다 04:12Z 의 런타임 상태 파일이다. 그 밖에는 03:30Z 이후 수정된 파일이 없다(설치는 03:23:47–52Z). 출하 소스가 설치 뒤에 바뀐 흔적은 없다. (`find -printf` 가 지역시각을 찍으므로 KST → UTC 로 환산했다.) 04:12Z 의 first-run 파일은 어떤 세션이 4.68.0 런타임을 한 번 기동했다는 정황이다(추론).
- `/save` 이름을 가로챌 다른 정의는 관측되지 않았다: `<HOME>/.claude/commands/save.md` 없음, 메인 체크아웃 `.claude/commands/save.md` 없음, `<HOME>/.claude` 아래 깊이 7 이내 `save.md` 는 artibot 캐시 2개 · 마켓 사본 · 2026-09-21 flat-copy 백업 디렉터리 · 2026-08 캐시 백업 2개뿐(활성 명령 경로 밖).

### 4.3 산문이 말하는 것과 말하지 않는 것

설치본 `commands/save.md` 의 Phase A½(45~66행)를 정적으로 점검했다 (문자열 존재와 순서 확인, 스크립트 미수록, 측정 04:54:47Z):

- 필수 문자열 7/7 존재: `buildSaveCheckpoint(ports, { sessionId, trigger:'/save' })` · `isSaveCheckpointEnabled(config)` · `appendEvent: null` · `source:'supervisor'` · `mission.checkpointed` · `{ listActiveMissionIds, getMission, getTaskGraph, checkpointService, appendEvent }` · `runtime.checkpoint.saveOnSave`.
- §31 여덟 단계 토큰이 산문 안에서 오름차순(게이트 파일 `save-checkpoint-order.test.js` 가 같은 점검을 한다).
- 1~7단계에서 산문이 이름 붙인 export(`isSaveCheckpointEnabled` · `buildSaveCheckpoint` · `createCheckpointService` · `createCheckpointStore` · `createFileStoreAdapter` · `resolveStoreLocation` · `buildResumeReport` · `appendLedgerEvent` · StateStore 의 `getMission` · `getTaskGraph`)는 §3 의 실행에서 전부 실제로 호출됐다. 설치본에 그 함수들이 없어서 산문이 허공을 부르는 상태는 아니다.

산문이 **정하지 않은** 것 — 라이브 모델이 즉석에서 메워야 한다(코드가 아니라 문서를 읽고 추론한 것):

1. `config` 를 어떻게 읽는지. 생산 로더 `loadConfig` 는 플러그인 루트 파일만 읽는다.
2. `projectRoot` 와 git 공통 디렉터리를 어떻게 얻는지.
3. StateStore 를 어떻게 여는지(어떤 `appendEvent`, 어떤 `source`).
4. **세션 id 의 환경변수 이름.** 산문은 "훅 payload 1순위, env 폴백"이라고만 쓴다. 슬래시 명령에는 훅 payload 가 없다. 이 세션의 Bash 에서는 `CLAUDE_CODE_SESSION_ID` 가 설정돼 있고 `CLAUDE_SESSION_ID` 는 없었다(프로브 시작 시 관측, 값은 기록하지 않음). 모델이 후자를 읽으면 `skip:session-missing` 이 되어 게이트가 true 여도 행이 0 이다(NOSESSION 시나리오가 그 결과를 보여 준다).
5. 이 모든 것을 `Write` + `Bash`(`allowed-tools` 에 있음)로 스크립트를 써서 돌려야 한다는 점 자체.

### 4.4 호출자는 0 이다 (측정 04:55:21Z 의 grep, 명령은 §2)

- A. 리포 전체 아무 파일 종류에서 pass 를 언급하는 파일 13개: 백로그 · `artibot.config.json`(주석 문자열) · `CHANGELOG.md` · `commands/resume.md` · `commands/save.md` · 모듈 자신 · `scripts/hooks/post-compact-rehydrate.js` · 테스트 5개 · `README.md`.
- B. 그중 비테스트 코드(js/mjs/cjs/ts/sh)는 두 개: `lib/checkpoint/save-checkpoint.js`(모듈 자신), `scripts/hooks/post-compact-rehydrate.js`. 후자는 383행 JSDoc 주석이고 import/require/dynamic import 는 0건이다.
- C. 설치본 트리(테스트·node_modules 제외)도 같은 두 파일 + 설정 파일(주석 문자열)뿐이다.

따라서 pass 의 유일한 "호출자"는 산문을 읽는 모델이다. 이것이 c-호출을 지금 측정할 수 없는 구조적 이유다.

### 4.5 산문의 줄번호 인용 4/9 가 썩었다 (실행에는 영향 없음)

`commands/save.md` 가 Phase A½ 에서 인용하는 9개 `파일:줄` 중 4개는 그 줄이 이름 붙인 심볼을 가리키지 않는다(측정 04:54:47Z, 심볼-줄 대조). 게이트 파일 머리말이 "줄번호가 여전히 심볼을 가리키는지는 검사하지 않는다"고 밝힌 바로 그 구멍이다.

| 산문 인용 | 심볼 | 인용된 줄이 심볼을 가리킴 | 심볼의 현재 위치 |
|---|---|---|---|
| `artifact-lifecycle.js:212` | `APPLY_GATE_PATH` | 아니오 | 214 |
| `state-manager.js:428` | `getMission` | 아니오 | 538 |
| `state-manager.js:429` | `getTaskGraph` | 아니오 | 539 |
| `checkpoint-service.js:150` | `createCheckpointService` | 아니오 | 193 |
| `checkpoint-store.js:162` · `adapters/file-store.js:113` · `store-location.js:57` · `resume-controller.js:542` · `ledger.js:81` | 각 export | 예 (5건) | 동일 |

이 줄기의 소유 밖 파일이라 고치지 않았다. 다음에 `save.md` 를 편집하는 줄기가 함께 바로잡으면 된다.

### 4.6 라이브 노출

- 실 원장에서 사용자가 친 슬래시 명령은 `intent.detected{data.command}` 로 남는다. 측정 04:56:26Z: 그런 행 17건(전부 `command` 필드 보유) 중 `save` 는 1건, 2026-09-21T07:21:36Z — 4.68.0 설치(2026-09-29T03:23Z) 이전이다. 4.68.0 산문으로 실행된 라이브 `/save` 표본은 이 원장에 없다. (자연어 "저장해줘" 로 발동한 `/save` 는 `command` 필드가 없어 이 표에 안 잡힌다 — 그 수는 미확인.)
- 라이브 `mission.checkpointed` = 0 / 43,910 survivors (05:11:52Z, §3.6). 출하 config 가 `false` 이므로 이 0 은 의도된 값이다.

## 5. 관측치 정합성 점검

| # | 관측 A | 관측 B | 함께 성립하는가 |
|---|---|---|---|
| 1 | 설치 기록 `gitCommitSha` = HEAD 40자 | 445파일 바이트 동일 · blob id 일치 | 예. 디렉터리 mtime 이 설치 시각보다 늦은 것은 런타임 상태 파일 3개 때문(§4.2) |
| 2 | 설치본 config `saveOnSave:false` | 실 원장 `mission.checkpointed` 0 · OFF 0행 | 예 |
| 3 | 체크포인트 본문 `resumable:true` | 원장 `data.resumable:false` · CLI `resumable:false` | 예 — 본문 값은 `buildContent`(`lib/checkpoint/save-checkpoint.js` 174행)가 상수로 넣고, 원장 값은 pass 의 보고 판정이다 |
| 4 | pass 의 보고 `blocked_by` 3개(lease · ledger · model unknown) | CLI `blocked_by` 1개(model unknown), `steps ok 8 / failed 0 / unknown 1` | 예 — pass 는 읽기 포트 3개만 묶어 unknown 이 3개고 CLI 는 lease · reconcile 포트도 묶는다. 둘 다 "실패"가 0 이고 "unknown" 때문에 재개 불가일 뿐이다. `resumable:false` ≠ 체크포인트가 깨졌다 |
| 5 | 체크포인트 `ts` 04:59:33.346Z | 원장 줄 `ts` 04:59:33.352Z, `seq` 0(시드) → 1 | 예 — 저장 → 발표 순서(`SAVE_CHECKPOINT_PORT_ORDER`), 같은 pid 55912, 체크포인트 id 에도 pid 가 들어 있다 |
| 6 | 실 원장 9초에 +4줄 | 프로브가 실 원장에 쓴 줄 0(sentinel 0) | 예 — 다른 세션 활동 |
| 7 | 백로그 CA-05 행 "d 미충족(라이브 `mission.checkpointed` 0)" | 이 문서 "d 충족" | 서로 다른 문장이다. 백로그의 0 은 라이브 카운트이고 계획 R3 이 요구한 d 는 "임시 리포에서 실 writer 왕복"이다. 라이브 카운트는 플립·릴리스·라이브 `/save` 뒤에야 0 을 벗어난다 |
| 8 | 실 저장소 활성 mission 32 (CLI 05:05:23Z) | 복사본 32 (05:07:11Z) | 예 |

모순은 발견되지 않았다.

## 6. R-6 플립 커밋을 위한 참고 (이 줄기가 하지 않은 것)

이 줄기는 config · 테스트 · `save.md` 를 건드리지 않았다. 아래는 읽기 전용 grep/측정으로 알게 된 사실이다(플립 커밋에서 실행해 본 것은 아니다).

- **키**: `plugins/artibot/artibot.config.json` 1076행 `runtime.checkpoint.saveOnSave`.
- **같은 커밋에서 함께 고쳐야 하는 핀** (`grep -rn saveOnSave tests` 실측): `tests/firewall/save-checkpoint-order.test.js` 361~368행 "reads false against the real artibot.config.json today"(의도적으로 고치라는 메시지가 붙은 카나리 핀), `tests/firewall/v5-config-firewall.test.js` 425행 `['runtime.checkpoint.saveOnSave', false]`. `tests/checkpoint/save-checkpoint.test.js` 는 `isSaveCheckpointEnabled` 를 입력 객체로 시험하므로 config 값에 묶여 있지 않다.
- **산문이 거짓이 된다**: `commands/save.md` 47행이 "이 키는 현재 `artibot.config.json` 에 `false` 로 있다"고 적는다. 플립 뒤에는 이 문장을 고쳐야 하고, 그러면 `save.md` 의 sha 가 바뀌므로 **c-파일 확인은 릴리스·설치 뒤에 다시 해야 한다.** `save.md` 는 CA-05 · OB-19 · SH-10 이 공유하는 파일이다.
- **효과는 릴리스 뒤에만**: `loadConfig` 는 설치된 플러그인 루트의 config 만 읽으므로, 리포에서 키를 뒤집어도 `/update` 로 설치본이 바뀌기 전에는 라이브에 아무 일도 일어나지 않는다.
- **플립 뒤 한 번의 라이브 `/save` 가 c-호출의 유일한 측정이다.** 읽는 명령: `grep -c '"event":"mission.checkpointed"' "$REPO/.git/artibot/ledger.jsonl"` (지금 0, 이 명령은 §3.4 에서 양성·음성으로 시험했다). 기대 증가폭은 §3.5 에 따라 **활성 mission 수(지금 32)** 이지 1 이 아니다. 행이 0 이면 원인 후보는 (i) 산문을 따르지 않음, (ii) `skip:session-missing`(§4.3-4), (iii) `skip:no-active-mission`, (iv) 원장 append 거부(BADSOURCE 와 같은 무음 실패 — `/save` 출력 표의 체크포인트 행과 `ledger.rejected` 로 구분).
- 스로틀이 없다(`commands/save.md` 66행): `/save` 를 연타하면 그때마다 활성 mission 수만큼 행이 쌓인다. 이것은 산문의 서술이고 이 프로브는 반복 실행을 측정하지 않았다.
- 되돌림은 config 1키다(`false` 로 복원). 다만 이미 쓰인 원장 행과 체크포인트 레코드는 append-only 라 되돌려지지 않는다.

## 7. 이 증거가 못 보는 것 (게이트 옆에 적는다)

- **라이브 모델이 산문을 따라 이 pass 를 실행하는지** — 미확인(c-호출). 이 프로브의 배선은 내가 썼다. "출하 모듈이 산문의 포트 계약대로 조립된다"는 보였고 "라이브 `/save` 가 조립한다"는 보이지 않았다.
- **mission 이 32건인 규모에서의 원장 경합** — 임시 리포는 쓰는 프로세스가 하나다. 다른 세션이 같은 중앙 원장에 동시에 쓰는 상황은 미측정이다(§3.5 도 단일 프로세스).
- **링크드 worktree(`.git` 이 파일)에서의 저장 위치** — 미측정. `git-common-dir.js` 머리말은 메인 `.git` 의 공유 저장소로 수렴한다고 적지만(코드 주석), 이 프로브는 `.git` 이 디렉터리인 저장소에서만 돌렸다.
- **8단계 스코어카드 렌더 출력**(OB-19) — 이 문서는 카드의 `session.checkpoints` 지표 값만 읽었다. 렌더된 마크다운은 미측정.
- **1단계(Flush artifacts) · 4단계(Epoch)** — 설계상 부재이거나 다른 게이트(`runtime.artifactLifecycle.enabled`) 뒤다. 이 문서는 아무 말도 하지 않는다.
- **연속 `/save`** — 미측정(§6).
- **다른 OS · 다른 node 버전** — win32 · node v24.15.0 한 조합.
- **첫 실행(BADSOURCE 이전 스크립트)의 결과는 폐기**했다. 인용한 수치는 재실행분이다(§3.1 은 04:59Z 대, §3.5 는 05:07Z). 실규모 사본의 활성 mission 수는 그 시각의 값이며 계속 변한다.
- 통과한 140개 점검은 **사전 선언 기대값과 관측의 일치**이지 제품 정확성의 증명이 아니다. 기대값 자체(예: `resumable:false` 가 문서화된 값)는 `save.md` 56행과 `tests/checkpoint/save-checkpoint.test.js` 의 `REAL_REPORT_RESUMABLE` 에서 가져왔다.

## 8. 부록 — 스크립트 원문 (그대로 실행된 것)

### 부록 A. `r3-scenario.mjs` — 시나리오 프로브

```js
// R3 probe (CA-05 conditions d and c): drive the SHIPPED /save checkpoint pass
// (commands/save.md Phase A-half, steps 2-7) against a throwaway git repo, then read the
// result back through independent production readers.
//
// usage: node r3-scenario.mjs --plugin-root <dir> --repo <freshly git-init-ed dir>
//                             --scenario ON|OFF|NOSESSION|NOMISSION|BADSOURCE --label <s>
//
// There is no shipped code caller for buildSaveCheckpoint (see the evidence doc), so the
// wiring below follows the /save prose literally and this file IS the caller.
// Expectations are declared in PLAN before anything runs. ASCII only.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) out[argv[i].replace(/^--/, '')] = argv[i + 1];
  return out;
}
const args = parseArgs(process.argv.slice(2));
const pluginRoot = path.resolve(args['plugin-root']);
const repoDir = path.resolve(args.repo);
const scenario = args.scenario;
const label = args.label;

// ---- expectations, fixed before execution -------------------------------------------
// saveOnSave: null = leave the shipped config byte-identical; gate = expected decision;
// rows = pass rows; ledgerRows = mission.checkpointed lines; cpRecords = checkpoint records;
// rejected = ledger.rejected lines; badSource = harness fault injection (forces a source
// the event allowlist refuses) to prove the instrument goes red when the row is NOT written.
const PLAN = {
  ON: { saveOnSave: true, seed: true, session: true, gate: true, rows: 1, ledgerRows: 1, cpRecords: 1, rejected: 0, skip: null, badSource: false },
  OFF: { saveOnSave: null, seed: true, session: true, gate: false, rows: 0, ledgerRows: 0, cpRecords: 0, rejected: 0, skip: null, badSource: false },
  NOSESSION: { saveOnSave: true, seed: true, session: false, gate: true, rows: 0, ledgerRows: 0, cpRecords: 0, rejected: 0, skip: 'skip:session-missing', badSource: false },
  NOMISSION: { saveOnSave: true, seed: false, session: true, gate: true, rows: 0, ledgerRows: 0, cpRecords: 0, rejected: 0, skip: 'skip:no-active-mission', badSource: false },
  BADSOURCE: { saveOnSave: true, seed: true, session: true, gate: true, rows: 1, ledgerRows: 0, cpRecords: 1, rejected: 1, skip: null, badSource: true },
};
const plan = PLAN[scenario];
if (!plan) { process.stderr.write('unknown scenario\n'); process.exit(2); }

// ---- environment hygiene: never let the host session leak into the probe -----------
const hostEnvSeen = {
  CLAUDE_CODE_SESSION_ID: Boolean(process.env.CLAUDE_CODE_SESSION_ID),
  CLAUDE_SESSION_ID: Boolean(process.env.CLAUDE_SESSION_ID),
  ARTIBOT_STATE_DIR: Boolean(process.env.ARTIBOT_STATE_DIR),
  CLAUDE_PLUGIN_ROOT: Boolean(process.env.CLAUDE_PLUGIN_ROOT),
};
for (const k of Object.keys(hostEnvSeen)) delete process.env[k];
const cleanEnv = { ...process.env };

const SESSION = `r3-probe-${label}-${scenario.toLowerCase()}-${Date.now().toString(36)}`;
const MID = 'M-20260929-901';
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const IDEM_FIELD = ['idempotency', 'key'].join('_');

// ---- preconditions -----------------------------------------------------------------
const dotGit = path.join(repoDir, '.git');
if (!existsSync(dotGit) || !statSync(dotGit).isDirectory()) throw new Error(`not a repo: ${repoDir}`);
if (existsSync(path.join(dotGit, 'artibot'))) throw new Error('repo is not fresh: store dir exists');

// ---- temp "plugin root" carrying ONLY the config under test --------------------------
const shippedPath = path.join(pluginRoot, 'artibot.config.json');
const shippedBytes = readFileSync(shippedPath);
const shipped = JSON.parse(shippedBytes.toString('utf8'));
const tempPluginRoot = path.join(repoDir, 'plugin-root');
mkdirSync(tempPluginRoot, { recursive: true });
const tempPath = path.join(tempPluginRoot, 'artibot.config.json');
if (plan.saveOnSave === null) {
  copyFileSync(shippedPath, tempPath);
} else {
  const cfg = JSON.parse(shippedBytes.toString('utf8'));
  cfg.runtime.checkpoint.saveOnSave = plan.saveOnSave;
  writeFileSync(tempPath, `${JSON.stringify(cfg, null, 2)}\n`);
}
function leafDiff(a, b, prefix = '') {
  const out = [];
  for (const k of new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])) {
    const av = a?.[k];
    const bv = b?.[k];
    const p = prefix ? `${prefix}.${k}` : k;
    if (av && bv && typeof av === 'object' && typeof bv === 'object' && !Array.isArray(av)) out.push(...leafDiff(av, bv, p));
    else if (JSON.stringify(av) !== JSON.stringify(bv)) out.push(p);
  }
  return out;
}
const tempCfgObj = JSON.parse(readFileSync(tempPath, 'utf8'));
const configEvidence = {
  shippedValue: shipped?.runtime?.checkpoint?.saveOnSave,
  tempValue: tempCfgObj?.runtime?.checkpoint?.saveOnSave,
  differingPaths: leafDiff(shipped, tempCfgObj),
  byteIdenticalToShipped: sha256(readFileSync(tempPath)) === sha256(shippedBytes),
};

// ---- import the modules under test from the given plugin root -----------------------
const load = (rel) => import(pathToFileURL(path.join(pluginRoot, rel)).href);
const { loadConfig } = await load('lib/core/config.js');
const { isSaveCheckpointEnabled, buildSaveCheckpoint } = await load('lib/checkpoint/save-checkpoint.js');
const { createCheckpointService } = await load('lib/checkpoint/checkpoint-service.js');
const { createCheckpointStore } = await load('lib/checkpoint/checkpoint-store.js');
const { createFileStoreAdapter } = await load('lib/checkpoint/adapters/file-store.js');
const { resolveStoreLocation } = await load('lib/project-state/store-location.js');
const { resolveGitCommonDir } = await load('lib/project-state/git-common-dir.js');
const { appendLedgerEvent, readLedgerCensus, ledgerFilePath } = await load('lib/runtime/ledger.js');
const { openMissionStore, missionMutator } = await load('lib/runtime/middleware/tasks.js');
const { loadReplay } = await load('lib/replay/load.js');
const { buildSessionScorecard } = await load('lib/scorecard/session-scorecard.js');
const { validateCheckpoint } = await load('lib/supervisor/contracts.js');

const location = resolveStoreLocation({ projectRoot: repoDir, gitCommonDir: resolveGitCommonDir(repoDir) });
const cpFile = path.join(location.dir, 'checkpoints.jsonl');

function listDir(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort().map((n) => {
    const st = statSync(path.join(dir, n));
    return st.isFile() ? { name: n, bytes: st.size, sha256: sha256(readFileSync(path.join(dir, n))).slice(0, 16) } : { name: n, dir: true };
  });
}
function rawLines(file) {
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '') : [];
}
function snapshot() {
  const lf = ledgerFilePath(repoDir);
  const lines = rawLines(lf);
  const hist = {};
  for (const l of lines) {
    let name = '(unparsed)';
    try { name = JSON.parse(l).event ?? name; } catch { /* stays (unparsed) */ }
    hist[name] = (hist[name] ?? 0) + 1;
  }
  return {
    ledgerFile: lf, ledgerExists: existsSync(lf), ledgerLines: lines.length, eventHistogram: hist,
    checkpointed: hist['mission.checkpointed'] ?? 0, rejected: hist['ledger.rejected'] ?? 0,
    checkpointRecords: rawLines(cpFile).length, storeDirFiles: listDir(location.dir),
  };
}

// ---- seed one mission through the PRODUCTION mission-store path ----------------------
if (plan.seed) {
  const seedStore = openMissionStore(repoDir, SESSION, Date.now(), { resolveGitCommonDir });
  const res = seedStore.updateMission(MID, missionMutator(MID, 'R3 probe mission', 1), {
    reason: 'r3-probe-seed', expectedVersion: seedStore.getState().state_version,
  });
  if (!res.ok) throw new Error(`seed failed: ${JSON.stringify(res)}`);
}
const before = snapshot();

// ---- the caller: config gate, then the pass, exactly as the prose describes ----------
process.env.CLAUDE_PLUGIN_ROOT = tempPluginRoot; // makes the PRODUCTION loader read the temp config
const config = await loadConfig(true);
delete process.env.CLAUDE_PLUGIN_ROOT;
const gate = isSaveCheckpointEnabled(config);

let pass = { ran: false, skipped: null, rows: [], error: null, elapsedMs: null };
if (gate) {
  const t0 = Date.now();
  try {
    const store = openMissionStore(repoDir, plan.session ? SESSION : 'r3-store-placeholder', Date.now(), { resolveGitCommonDir });
    const checkpointStore = createCheckpointStore({ adapter: createFileStoreAdapter({ dir: location.dir }) });
    const ports = {
      listActiveMissionIds: () => Object.keys(store.getState().active_missions),
      getMission: (id) => store.getMission(id),
      getTaskGraph: (id) => store.getTaskGraph(id),
      checkpointService: createCheckpointService({ store: checkpointStore, appendEvent: null }),
      appendEvent: (e) => appendLedgerEvent(repoDir, plan.badSource ? { ...e, source: 'worker' } : e),
    };
    const out = await buildSaveCheckpoint(ports, { sessionId: plan.session ? SESSION : undefined, trigger: '/save' });
    pass = { ran: true, skipped: out.skipped, rows: out.rows, error: null, elapsedMs: Date.now() - t0 };
  } catch (err) {
    pass = { ran: true, skipped: null, rows: [], error: `${err?.constructor?.name}: ${err?.message}`, elapsedMs: Date.now() - t0 };
  }
}
const after = snapshot();

// ---- read-backs through independent production readers -------------------------------
const rawCheckpointed = rawLines(after.ledgerFile).filter((l) => { try { return JSON.parse(l).event === 'mission.checkpointed'; } catch { return false; } });
const readerCp = readLedgerCensus(repoDir, { event: 'mission.checkpointed' });
const readerAll = readLedgerCensus(repoDir);
const svc = createCheckpointService({ store: createCheckpointStore({ adapter: createFileStoreAdapter({ dir: location.dir }) }), appendEvent: null });
const latest = await svc.latestValid(MID);
const storedValidation = latest.record ? validateCheckpoint(latest.record.checkpoint) : null;

const dirBefore = JSON.stringify(listDir(location.dir));
let cli;
try {
  const doc = JSON.parse(execFileSync(process.execPath,
    [path.join(pluginRoot, 'scripts/checkpoint/resume-report.mjs'), '--mission', MID, '--cwd', repoDir, '--json'],
    { env: cleanEnv, encoding: 'utf8', timeout: 60000, windowsHide: true }));
  cli = { exit: 0, mission: doc.contract?.missions?.[0] ?? null, storeDir: doc.contract?.store?.dir ?? null, unavailable: doc.contract?.unavailable ?? null };
} catch (err) {
  cli = { exit: err?.status ?? 'error', message: String(err?.message).slice(0, 200) };
}
const cliReadOnly = dirBefore === JSON.stringify(listDir(location.dir));

let cpMetric = null;
let scorecardError = null;
try {
  const card = buildSessionScorecard(loadReplay(repoDir, { readLedger: readLedgerCensus }), { session_id: SESSION });
  cpMetric = card.metrics.find((m) => m.key === 'session.checkpoints') ?? null;
} catch (err) {
  scorecardError = `${err?.constructor?.name}: ${err?.message}`;
}

const expectedLedger = path.join(realpathSync.native(repoDir), '.git', 'artibot', 'ledger.jsonl');
const ledgerIsTempRepoLedger = after.ledgerExists ? realpathSync.native(after.ledgerFile) === expectedLedger : null;

// ---- evaluate against the pre-declared plan --------------------------------------------
const row = pass.rows[0] ?? null;
const cpLine = rawCheckpointed[0] ? JSON.parse(rawCheckpointed[0]) : null;
const cid = row?.checkpoint_id;
const checks = {
  gate_as_planned: gate === plan.gate,
  pass_ran_as_planned: pass.ran === plan.gate,
  no_pass_error: pass.error === null,
  skip_reason_as_planned: pass.skipped === plan.skip,
  rows_as_planned: pass.rows.length === plan.rows,
  ledger_before_has_no_checkpointed: before.checkpointed === 0,
  raw_ledger_checkpointed_as_planned: after.checkpointed === plan.ledgerRows,
  ledger_line_delta_as_planned: (after.ledgerLines - before.ledgerLines) === plan.ledgerRows + plan.rejected,
  ledger_rejected_as_planned: after.rejected === plan.rejected,
  production_reader_events_as_planned: readerCp.events.length === plan.ledgerRows,
  production_reader_no_loss: readerCp.census.dropped_total.loss === 0 && readerAll.census.dropped_total.loss === 0,
  checkpoint_records_as_planned: after.checkpointRecords === plan.cpRecords,
  cli_read_only: cliReadOnly,
  scorecard_numerator_as_planned: cpMetric !== null && cpMetric.numerator === plan.ledgerRows,
};
if (plan.rows === 1) {
  Object.assign(checks, {
    row_status_saved: row?.status === 'saved',
    row_ledger_as_planned: plan.badSource
      ? (row?.ledger?.ok === false && row?.ledger?.reason === 'source-not-allowed:worker')
      : (row?.ledger?.ok === true && row?.ledger?.reason === null),
  });
}
if (plan.cpRecords === 1) {
  Object.assign(checks, {
    stored_record_id_equals_row: latest.ok === true && latest.record?.checkpoint_id === cid,
    stored_body_validates: storedValidation?.ok === true,
    stored_body_session_and_mission: latest.record?.checkpoint?.session_id === SESSION && latest.record?.checkpoint?.mission_id === MID,
    cli_reports_same_checkpoint_id: cli?.mission?.checkpoint_id === cid && cli?.mission?.in_store === true,
  });
} else {
  Object.assign(checks, {
    latest_valid_reports_nothing_stored: latest.ok === false && latest.record === null && Array.isArray(latest.errors) && latest.errors.length === 0,
    cli_reports_no_checkpoint: cli?.mission?.checkpoint_id === null,
  });
}
if (plan.ledgerRows === 1) {
  Object.assign(checks, {
    envelope_event_and_source: cpLine?.event === 'mission.checkpointed' && cpLine?.source === 'supervisor',
    envelope_ids_match: cpLine?.mission_id === MID && cpLine?.session_id === SESSION,
    data_checkpoint_id_equals_row: typeof cid === 'string' && cpLine?.data?.checkpoint_id === cid,
    data_trigger_is_slash_save: cpLine?.data?.trigger === '/save',
    data_resumable_false_as_documented: cpLine?.data?.resumable === false,
    idem_string_as_expected: cpLine?.[IDEM_FIELD] === `mission.checkpointed:${MID}:${cid}`,
    ledger_is_temp_repo_ledger: ledgerIsTempRepoLedger === true,
    scorecard_ratio_is_1: cpMetric?.denominator === 1 && cpMetric?.ratio === 1,
  });
}
const failed = Object.entries(checks).filter(([, v]) => v !== true).map(([k]) => k);

process.stdout.write(`${JSON.stringify({
  label, scenario, measuredAt: new Date().toISOString(), node: process.version, platform: process.platform,
  pluginRoot, repoDir, session: SESSION, missionId: MID, hostEnvSeen,
  config: { ...configEvidence, loadedValue: config?.runtime?.checkpoint?.saveOnSave, gate },
  storeLocation: location, before, after,
  pass: { ran: pass.ran, skipped: pass.skipped, error: pass.error, elapsedMs: pass.elapsedMs, rows: pass.rows },
  readback: {
    rawCheckpointedLines: rawCheckpointed,
    productionReader: { checkpointedEvents: readerCp.events.length, census: readerCp.census, totalSurvivors: readerAll.census.survivors, totalLoss: readerAll.census.dropped_total.loss },
    latestValid: { ok: latest.ok, errors: latest.errors, checkpointId: latest.record?.checkpoint_id ?? null, storedBody: latest.record?.checkpoint ?? null },
    resumeReportCli: cli,
    scorecardCheckpointMetric: cpMetric ? { key: cpMetric.key, numerator: cpMetric.numerator, denominator: cpMetric.denominator, ratio: cpMetric.ratio, state: cpMetric.state } : null,
    scorecardError,
  },
  isolation: { expectedLedger, actualLedger: after.ledgerFile, ledgerIsTempRepoLedger },
  checks, failedChecks: failed, allChecksPass: failed.length === 0,
}, null, 2)}\n`);
process.exitCode = failed.length === 0 ? 0 : 1;
```

### 부록 B. `r3-livescale.mjs` — 실규모 재생

```js
// R3 probe, live-scale replay: the same /save pass wiring as r3-scenario.mjs (ON), but over a
// COPY of a real project-state snapshot instead of one seeded mission, so the fixture is the
// size and shape of the real store. The source store is only read; every write lands in the
// throwaway repo. Mission titles are never printed.
//
// usage: node r3-livescale.mjs --plugin-root <dir> --repo <freshly git-init-ed dir>
//                              --copy-store-from <dir holding project-state.json> --label <s>
// ASCII only.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const a = process.argv.slice(2);
const opt = (n) => a[a.indexOf(`--${n}`) + 1];
const pluginRoot = path.resolve(opt('plugin-root'));
const repoDir = path.resolve(opt('repo'));
const srcStore = path.resolve(opt('copy-store-from'));
const label = opt('label');

for (const k of ['CLAUDE_CODE_SESSION_ID', 'CLAUDE_SESSION_ID', 'ARTIBOT_STATE_DIR', 'CLAUDE_PLUGIN_ROOT']) delete process.env[k];
const cleanEnv = { ...process.env };
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const SESSION = `r3-probe-${label}-livescale-${Date.now().toString(36)}`;

const dotGit = path.join(repoDir, '.git');
if (!existsSync(dotGit) || !statSync(dotGit).isDirectory()) throw new Error('not a repo');
if (existsSync(path.join(dotGit, 'artibot'))) throw new Error('repo is not fresh');

const load = (rel) => import(pathToFileURL(path.join(pluginRoot, rel)).href);
const { loadConfig } = await load('lib/core/config.js');
const { isSaveCheckpointEnabled, buildSaveCheckpoint } = await load('lib/checkpoint/save-checkpoint.js');
const { createCheckpointService } = await load('lib/checkpoint/checkpoint-service.js');
const { createCheckpointStore } = await load('lib/checkpoint/checkpoint-store.js');
const { createFileStoreAdapter } = await load('lib/checkpoint/adapters/file-store.js');
const { resolveStoreLocation } = await load('lib/project-state/store-location.js');
const { resolveGitCommonDir } = await load('lib/project-state/git-common-dir.js');
const { appendLedgerEvent, readLedgerCensus, ledgerFilePath } = await load('lib/runtime/ledger.js');
const { openMissionStore } = await load('lib/runtime/middleware/tasks.js');
const { loadReplay } = await load('lib/replay/load.js');
const { buildSessionScorecard } = await load('lib/scorecard/session-scorecard.js');

// gate ON, through the production loader, single key changed from the shipped config
const tempPluginRoot = path.join(repoDir, 'plugin-root');
mkdirSync(tempPluginRoot, { recursive: true });
const cfg = JSON.parse(readFileSync(path.join(pluginRoot, 'artibot.config.json'), 'utf8'));
cfg.runtime.checkpoint.saveOnSave = true;
writeFileSync(path.join(tempPluginRoot, 'artibot.config.json'), `${JSON.stringify(cfg, null, 2)}\n`);
process.env.CLAUDE_PLUGIN_ROOT = tempPluginRoot;
const config = await loadConfig(true);
delete process.env.CLAUDE_PLUGIN_ROOT;
if (!isSaveCheckpointEnabled(config)) throw new Error('gate did not read ON');

// copy the snapshot (+ journal) once into the temp store; verify the copy byte-for-byte
const location = resolveStoreLocation({ projectRoot: repoDir, gitCommonDir: resolveGitCommonDir(repoDir) });
mkdirSync(location.dir, { recursive: true });
const copied = {};
for (const name of ['project-state.json', 'project-state.jsonl']) {
  const src = path.join(srcStore, name);
  if (!existsSync(src)) { copied[name] = null; continue; }
  const buf = readFileSync(src);
  writeFileSync(path.join(location.dir, name), buf);
  copied[name] = { bytes: buf.length, sha256: sha256(buf).slice(0, 16), copyVerified: sha256(readFileSync(path.join(location.dir, name))) === sha256(buf) };
}
JSON.parse(readFileSync(path.join(location.dir, 'project-state.json'), 'utf8')); // torn-read guard

const store = openMissionStore(repoDir, SESSION, Date.now(), { resolveGitCommonDir });
const activeIds = Object.keys(store.getState().active_missions);
const stateShaBefore = sha256(readFileSync(path.join(location.dir, 'project-state.json')));

const checkpointStore = createCheckpointStore({ adapter: createFileStoreAdapter({ dir: location.dir }) });
const ports = {
  listActiveMissionIds: () => Object.keys(store.getState().active_missions),
  getMission: (id) => store.getMission(id),
  getTaskGraph: (id) => store.getTaskGraph(id),
  checkpointService: createCheckpointService({ store: checkpointStore, appendEvent: null }),
  appendEvent: (e) => appendLedgerEvent(repoDir, e),
};
const t0 = Date.now();
const out = await buildSaveCheckpoint(ports, { sessionId: SESSION, trigger: '/save' });
const elapsedMs = Date.now() - t0;

// ---- measurements ----------------------------------------------------------------------
const lf = ledgerFilePath(repoDir);
const lines = existsSync(lf) ? readFileSync(lf, 'utf8').split('\n').filter((l) => l.trim() !== '') : [];
const events = lines.map((l) => JSON.parse(l));
const hist = {};
for (const e of events) hist[e.event] = (hist[e.event] ?? 0) + 1;
const cpFile = path.join(location.dir, 'checkpoints.jsonl');
const cpRecords = existsSync(cpFile) ? readFileSync(cpFile, 'utf8').split('\n').filter((l) => l.trim() !== '').length : 0;

const byStatus = {};
const errorGroups = {};
const idShape = { numeric: { active: 0, saved: 0 }, sessionFallback: { active: 0, saved: 0 } };
for (const r of out.rows) {
  byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  const shape = /-S[0-9A-Za-z]{8}$/.test(r.mission_id) ? 'sessionFallback' : 'numeric';
  idShape[shape].saved += r.status === 'saved' ? 1 : 0;
  if (r.status !== 'saved') {
    const why = (r.errors?.[0] ?? r.reason ?? '(none)').toString();
    errorGroups[`${r.status}: ${why}`] = (errorGroups[`${r.status}: ${why}`] ?? 0) + 1;
  }
}
for (const id of activeIds) idShape[/-S[0-9A-Za-z]{8}$/.test(id) ? 'sessionFallback' : 'numeric'].active += 1;

const savedOk = out.rows.filter((r) => r.status === 'saved' && r.ledger?.ok === true);
const savedRefused = out.rows.filter((r) => r.status === 'saved' && r.ledger?.ok !== true);
const readerCp = readLedgerCensus(repoDir, { event: 'mission.checkpointed' });
const ledgerIds = events.filter((e) => e.event === 'mission.checkpointed').map((e) => e.mission_id);
const maxLineBytes = Math.max(0, ...lines.map((l) => Buffer.byteLength(l, 'utf8')));
let scorecard = null;
try {
  const m = buildSessionScorecard(loadReplay(repoDir, { readLedger: readLedgerCensus }), { session_id: SESSION }).metrics.find((x) => x.key === 'session.checkpoints');
  scorecard = { numerator: m.numerator, denominator: m.denominator, ratio: m.ratio };
} catch (err) { scorecard = { error: String(err?.message) }; }
let cli;
try {
  const doc = JSON.parse(execFileSync(process.execPath,
    [path.join(pluginRoot, 'scripts/checkpoint/resume-report.mjs'), '--all', '--cwd', repoDir, '--run-json', path.join(repoDir, 'no-such-run.json'), '--json'],
    { env: cleanEnv, encoding: 'utf8', timeout: 60000, windowsHide: true }));
  const ms = doc.contract?.missions ?? [];
  cli = { missions: ms.length, withCheckpointId: ms.filter((m) => typeof m.checkpoint_id === 'string').length };
} catch (err) { cli = { error: String(err?.message).slice(0, 160) }; }

const invariants = {
  every_active_mission_targeted: out.rows.length === activeIds.length && out.skipped === null,
  statuses_in_closed_set: out.rows.every((r) => ['saved', 'rejected', 'skipped', 'errored'].includes(r.status)),
  ledger_checkpointed_equals_saved_and_announced: hist['mission.checkpointed'] === savedOk.length,
  checkpoint_records_equal_saved: cpRecords === out.rows.filter((r) => r.status === 'saved').length,
  ledger_rejected_equals_saved_but_refused: (hist['ledger.rejected'] ?? 0) === savedRefused.length,
  ledger_has_only_expected_event_kinds: Object.keys(hist).every((k) => k === 'mission.checkpointed' || k === 'ledger.rejected'),
  ledger_mission_ids_unique_and_active: new Set(ledgerIds).size === ledgerIds.length && ledgerIds.every((id) => activeIds.includes(id)),
  pass_made_no_store_write: sha256(readFileSync(path.join(location.dir, 'project-state.json'))) === stateShaBefore,
  production_reader_equals_raw: readerCp.events.length === (hist['mission.checkpointed'] ?? 0) && readerCp.census.dropped_total.loss === 0,
  scorecard_numerator_equals_ledger: scorecard?.numerator === (hist['mission.checkpointed'] ?? 0),
  cli_checkpoint_ids_equal_saved: cli?.withCheckpointId === out.rows.filter((r) => r.status === 'saved').length,
};
const failed = Object.entries(invariants).filter(([, v]) => v !== true).map(([k]) => k);

process.stdout.write(`${JSON.stringify({
  label, measuredAt: new Date().toISOString(), node: process.version, platform: process.platform,
  session: SESSION, copiedFromLiveStore: copied, activeMissionsInCopy: activeIds.length, idShape,
  pass: { skipped: out.skipped, rows: out.rows.length, byStatus, errorGroups, elapsedMs },
  ledger: { lines: lines.length, eventHistogram: hist, bytes: existsSync(lf) ? statSync(lf).size : 0, maxLineBytes },
  checkpointRecords: cpRecords, productionReaderEvents: readerCp.events.length, scorecard, resumeReportCli: cli,
  invariants, failedInvariants: failed, allInvariantsHold: failed.length === 0,
}, null, 2)}\n`);
process.exitCode = failed.length === 0 ? 0 : 1;
```

### 부록 C. `real-ledger-census.mjs` — 실 원장 읽기 전용 census

```js
// R3 helper: READ-ONLY census of a project's real central ledger.
// usage: node real-ledger-census.mjs --plugin-root <dir> --root <projectRoot>
// Counts mission.checkpointed lines and any line mentioning the probe sentinel prefix.
// It never writes. ASCII only.
import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const a = process.argv.slice(2);
const opt = (n) => a[a.indexOf(`--${n}`) + 1];
const pluginRoot = path.resolve(opt('plugin-root'));
const root = path.resolve(opt('root'));
const { readLedgerCensus, ledgerFilePath } = await import(pathToFileURL(path.join(pluginRoot, 'lib/runtime/ledger.js')).href);

const file = ledgerFilePath(root);
const all = readLedgerCensus(root);
const cp = readLedgerCensus(root, { event: 'mission.checkpointed' });

const sentinelEvents = {};
let sentinelLines = 0;
if (existsSync(file)) {
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.includes('r3-probe-')) continue;
    sentinelLines += 1;
    let ev = '(unparsed)';
    try { ev = JSON.parse(line).event; } catch { /* keep */ }
    sentinelEvents[ev] = (sentinelEvents[ev] ?? 0) + 1;
  }
}
process.stdout.write(`${JSON.stringify({
  measuredAt: new Date().toISOString(),
  root,
  ledgerFile: file,
  exists: existsSync(file),
  bytes: existsSync(file) ? statSync(file).size : null,
  nonblankLines: all.census.lines.nonblank,
  survivors: all.census.survivors,
  missionCheckpointedEvents: cp.events.length,
  sentinelPrefixLines: sentinelLines,
  sentinelPrefixByEvent: sentinelEvents,
}, null, 2)}\n`);
```

### 부록 D. `blob-id.mjs` — CR 제거본의 git blob id

```js
// R3 helper: git blob id (sha1 of "blob <len>\0<content>") of a file after stripping CR,
// so an autocrlf=true CRLF checkout/installed copy can be compared to a committed LF blob.
// usage: node blob-id.mjs <file> [<file> ...]   (read-only, ASCII only)
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

for (const f of process.argv.slice(2)) {
  const raw = readFileSync(f);
  const lf = Buffer.from(raw.filter((b) => b !== 0x0d));
  const id = (buf) => createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${buf.length}\0`), buf])).digest('hex');
  process.stdout.write(`${JSON.stringify({ file: f, rawBlobId: id(raw), crStrippedBlobId: id(lf), rawBytes: raw.length, crStrippedBytes: lf.length })}\n`);
}
```

미확인: 라이브 모델이 설치본 `/save` 산문을 따라 Phase A½ 를 실제로 실행하는지 · mission 32건 규모에서 다른 세션과 동시에 원장에 쓸 때의 동작 · 링크드 worktree 에서의 저장 위치 · 연속 `/save` 의 누적 · 렌더된 스코어카드 절 · win32/node v24.15.0 밖의 환경.
