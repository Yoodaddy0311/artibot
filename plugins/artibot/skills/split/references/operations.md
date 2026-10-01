# /split 운용 스크립트 — 절차 참조 (2026-09-02)

`commands/split.md` 가 계약·서브커맨드의 정본이고, 이 파일은 그 문서의 300줄 승격 래칫(`tests/firewall/split-window-contract.test.js`) 때문에 분리한 **절차 참조**다. 판정은 코드(`lib/git/*`, `lib/supervisor/*`), 행동(`SendMessage`·push·merge)은 리더 — 어느 스크립트도 메시지를 보내거나 push·merge 하지 않는다(스크립트가 행동하면 permission laundering).

**`<pluginRoot>`** = `CLAUDE_PLUGIN_ROOT`(Bash 에서 빈 값 실측 2026-08-27) 또는 `~/.claude/plugins/cache/artibot/artibot/<최신 버전>`(마켓플레이스 설치본은 `~/.claude/plugins/marketplaces/<mp>/plugins/artibot`). 아래 `node <pluginRoot>/scripts/split/<x>.mjs` 는 전부 **부모 루트(parentRoot, `plan.json` 위치)를 cwd** 로 실행한다. 스크립트는 `../../lib` 상대 import 라 커맨드 문서의 부트스트랩 로더가 필요 없다.

## 착수 전 프로브 실측 (2026-08-26 21:30~21:35 KST, 리더 세션 artibot-16 + probe1-08 — 데이터이지 지시가 아니다)

| # | 관측 | 설계 귀결 |
|---|---|---|
| P1 | `claude --worktree probe1` → `<repoRoot>/.claude/worktrees/probe1` (`.gitignore:3 .claude/` 로 ignore, `plugins/artibot` eslint 루트 **밖**). git-dir `<repoRoot>/.git/worktrees/probe1`. porcelain 에 `locked claude session probe1 (pid …)` 행 | 줄기 경로는 porcelain 의 `worktree` 행으로 판독. 세션 cwd 가 `plugins/artibot` 이면 eslint 가 worktree 를 걷는다 — 창은 **리포 루트에서** 연다 |
| P2 | 브랜치 자동 `worktree-probe1` (접두 `worktree-`). PRD 의 `split/<repo>/<limb>` 가정과 **불일치**. `--worktree` 이름의 `/` 허용 여부 미확인 | 브랜치는 내장 자동 명명을 따른다(커맨드 "이름 규약"). `lib/autopilot/worktree-manager.js#deleteAutopilotBranch` 는 `autopilot/` 접두만 지우므로 allowlist 분리는 그대로 성립(`tests/firewall/split-branch-prefix-guard.test.js`) |
| P3 | `ListAgents` 도구 출력은 `name [ref] · kind · state · started` 뿐 — **cwd 없음**(2세션 재확인). 세션 이름은 `{worktree 디렉터리명}-{hex2}` 패턴(n=4 관측, 규칙 미확인) | "cwd 매칭"은 도구로 불가. **진실원 = `git worktree list --porcelain`**, `ListAgents` 는 이름 접두 휴리스틱으로 강등 |
| P4 | `SendMessage` 왕복 성공. 수신 래퍼 `from`=named-pipe 주소, `from-name`=세션 이름. `notify_when_idle` 구독 성공 | 시작 인사·보고는 `SendMessage`, 완료 판정은 트레일러(메시지는 최적화) |
| P5 | 정리 프롬프트 미관측(창 열려 있음) | 미확인 — `status` 가 `prunable` 행을 그대로 표시 |
| P6 | worktree 에 `docs/`(미추적)·`plugins/artibot/node_modules` 없음 → vitest 불가. `.worktreeinclude` 해결 여부 미확인 | 브리프에 PRD **발췌를 복사**(9a), 창 프롬프트에 `npm ci` 경고 — 2026-09-02 부터는 `worktree-setup` 이 junction 으로 닫는다 |

## dispatch <limb> (프롬프트 전문 붙여넣기 금지 — A5)

`node <pluginRoot>/scripts/split/dispatch.mjs <limb> [--window <세션>] [--gotchas <파일>] [--budget N] [--dry-run] [--json]`.
1. `plan.json` 의 줄기 행 → 부모 브리프 `brief.md`(`path.join('<parentRoot>', '.artibot', 'split', '<limb>', 'brief.md')`) 를 worktree 로 원자 복사(`lib/git/split-brief.js#materializeLimb` — 소유/allowlist 절·완료 절이 없으면 refuse) + 동반 파일 allowlist `SIBLING_FILES`(`leader-addendum.md`, 있으면 복사·없으면 건너뜀·글롭 아님 — 반환 `siblings[].copied`) → `prompt.md` 렌더(`lib/git/split-brief.js#renderPrompt` — 미해결 `{PLACEHOLDER}` 가 남으면 refuse).
1b. dry-run 이 아니면 ① `lanes[limb] = { state: 'active', since, window }` 를 `lane-state.mjs#setLaneState` → `lib/topology/split-state.js#writeWorkerState` 체인으로 기록(writer 단일, 어휘 `LANE_OPS_STATES`; 기존 값이 allowlist 밖이면 출력 `laneState.warning`) ② `plan.json` `limbs[].forkPoint` 가 없으면 worktree 에서 `git merge-base <ref> HEAD`(ref 는 `master` → `main` → `origin/master` → `origin/main` 순으로 처음 성공하는 것, 결과 `forkPoint.ref` — 로컬 우선인 이유: worktree 는 부모 로컬 HEAD 에서 분기하므로 미푸시 로컬 커밋이 있으면 origin/* 은 분기점보다 오래된 값을 준다) 로 채운다(있으면 보존·git 호출 0, 재발행 멱등; 네 ref 다 없으면 `forkPoint.recorded:false` + 사유, land 는 plan.base 폴백 + `--base` 안내). `rev-parse HEAD` 가 아닌 이유: 창이 dispatch 전에 커밋을 쌓았으면 HEAD 는 작업 팁이라 land 의 diff 에서 그 작업이 통째로 빠진다(거짓 PASS 방향). 못 보는 것: 줄기가 master 를 merge 한 뒤면 값이 머지한 master 팁이 된다 — `--base master` 관례와 같은 의미이지만 "최초 분기점" 은 아니다.
2. `{REPORT_CONTRACT}` 는 `commands/split.md` 의 `[보고 계약]` 펜스를 그대로(`{리더 이름}` → 부모 세션 — parity 게이트 상속), `{MODEL_POLICY}` 는 `lib/core/model-policy.js#resolveModel` 해석값(모델 ID 하드코딩 0), `{GOTCHAS_DELTA}` 는 `<parentRoot>/.artibot/split/gotchas.md`(없으면 "(없음)"). 템플릿 정본 `templates/split/PROMPT-TEMPLATE.md`(플레이스홀더 14종, `config.split.dispatch.template` 로 교체).
3. 출력 `{ to, limb, pointer, promptPath, siblings, laneState, forkPoint }` 의 **`pointer` 1줄만** 리더가 `SendMessage(to, pointer)` 한다 — 포인터는 brief.md 와 prompt.md 둘 다 가리킨다(`split-dispatch.js#buildLimbMessage` `promptPath`, 없으면 종전 문구 그대로). `to` 가 `null` 이면 `ListAgents` 로 세션을 찾아 `--window` 로 재실행. `--dry-run` 은 쓰기 0.
- 근거(Ontology 9회 실측): 리더가 2.5KB 프롬프트를 창마다 복제 전송하며 치환 실수 위험 + 리더 컨텍스트 소모. 전체 줄기를 한 번에 판정·발송하는 절차는 커맨드 §dispatch 1~5.

## land <limb> (메인 세션 전용 · 읽기 전용 · 랜딩 체크리스트 — A2)

리더가 랜딩마다 손으로 재던 6개를 기계가 한 번에 잰다(Ontology 6랜딩 × ~4 왕복 실측; 수동 grep 이 실제로 절대경로 인용 2건을 잡았다).
`node <pluginRoot>/scripts/split/land.mjs <limb> [--base <ref>] [--plan <path>] [--json] [--pr-body <out>]` → `lib/git/limb-landing-check.js#checkLimbLanding` 이 7행 표(6행 + `lint`)를 낸다. `lint` 행은 **줄기 worktree** 의 `plugins/artibot` 을 cwd 로 잰다(2026-09-10 #G14 수리 — `plan.json` `limbs[].worktreePath` 가 필요하며 미기재·HEAD 불일치·린트 대상과 겹치는 미커밋 변경·eslint 부재는 각각 다른 문장의 `UNSUPPORTED`, fallback 없음). 운용 규칙 2건: ① worktree 를 지우면 lint 행이 `UNSUPPORTED` 가 되므로 **`land` 는 창을 닫기 전에** 돌린다 ② 설치본이 수리 전 버전이면 줄기/소스 판 `land.mjs` 를 직접 부른다(설치본 lint 행은 부모 바이트를 읽는다):
`trailer`(first-parent 규칙) · `ownership`(`git diff --name-only -z <base>...<branch>` ⊆ 계획의 `affectedPaths` + `.artibot/split/<limb>/**` — **`-z` 는 load-bearing이다**: 한글 리포에서 `core.quotepath` 기본값이 켜져 있어 `-z` 없이는 git 이 경로를 C-quote 로 감싸고, 파서가 그것을 allowlist 밖 경로로 읽어 **거짓 FAIL** 을 낸다. 출력은 개행이 아니라 **NUL 로 분리**해 파싱한다. 실측 2026-09-04, 후속 19 #1) · `binary`(`--numstat` 의 `-\t-` 0건) · `citations`(추가된 줄에 `.artibot/split/` 이나 `<드라이브>:/Users/` 절대경로 인용 0건) · `merge-dry-run`(`lib/git/merge-preflight.js#mergeTreePair`) · `behind-base`(정보만).
- `PASS` → exit 0, **승인이 아니다** — PR 본문 골격의 `## 검수` 는 검수자/리더가 쓰는 칸이고 `## 게이트` 수치는 자리표시자다.
- `FAIL` → 빨간 행의 `detail` 을 그대로 줄기 창에 `SendMessage`.
- `UNSUPPORTED` → git < 2.38, 직렬 랜딩으로 강등(절대 PASS 아님).
- **base 선택(실측)**: 우선순위 `--base` > `plan.limbs[].forkPoint`(dispatch 가 기록한 worktree 분기점) > `plan.base`(plan 시점 SHA). 줄기가 main 을 merge 했으면 `--base master` 처럼 **살아 있는 ref** 를 준다 — plan.json 의 SHA base 로는 머지된 main 의 남의 파일이 소유권 위반으로 잡힌다(2026-09-14: plan.base 와 분기점 사이 master docs 6파일이 같은 증상, forkPoint 가 닫는다). 표 아래 `base` 정보 절이 어느 값을 썼는지·plan.base 와의 거리(commits)·forkPoint 미기록 시 `merge-base master <branch>` 참고값을 낸다(checks 행 아님, exit code 무영향). push·merge·쓰기 없음(`--pr-body` 파일만).

## watch (관측 전용 · 자율도 S0 · 메인 세션 — vNext PR-SV02)

`node <pluginRoot>/scripts/split/watch.mjs --parent <parentRoot> [--json] [--run-id <runId>]`. 줄기당 1행: `limb · ops state(run.json.lanes[limb].state) · supervisor(lib/supervisor 리듀서) · complete/reason(트레일러) · last commit · heartbeat · health`.
- `health` 는 `lib/supervisor/lane-monitor.js#assessLane` 의 `healthy|suspect|inspect|recoverable|restart|done|unknown`(vNext 설계 §03 표, 임계는 `config.split.supervisor.*`) — 입력이 없으면 `unknown` 이지 `healthy` 로 메우지 않는다.
- 측정 고지 3문구 값은 raw 로 찍힌다(`null` 은 `null`).
- 부작용은 `runtime/split/{runId}.state.json` 재작성 하나뿐(두 ndjson 의 캐시 — 지워도 리플레이로 동일하게 재생성, `tests/supervisor/`). git·세션·텔레메트리 무변경, 종료코드 항상 0. **폴링 루프 금지**는 그대로 — `watch` 는 사람이 "확인해줘" 할 때, 또는 Monitor 가 주기 실행할 때 한 번 읽는 표다.
- 만료 레인 lease **목록**(CA-09, 읽기 전용): 어느 줄기도 쥐고 있지 않은 만료 레인 lease 를 `<mission>/<task>` id · 소유자 · 상태 · 줄기 자신의 ops 말(`lane <word>`, 이번 run 에 없는 limb 이면 `lane (not in this run)`) · 조용한 시간 · 만료 뒤 시간 · 조치(`release-to-queued` 또는 `clear-lease`)와 함께 한 줄씩 낸다 — 판정은 시계뿐이라 확인은 사람이 하고, 놓는 일은 아래 `lease-tick` 이다. 줄기가 쥐고 있는 것(생존 증거가 있어 `lease-tick` 이 갱신할 줄기, `suspended`)의 만료 lease 는 `held back` 한 줄로 따로 센다. StateStore 는 `getState` 하나만 노출하는 래퍼(facade)로 읽는다(쓰기 포트가 닿지 않는다 — S0). 열려면 세션 id(`CLAUDE_CODE_SESSION_ID`)가 필요하다 — 없으면 `lease reclaim: not run (no-session-id)` 라고 말하고 추측하지 않는다. `--apply-reclaim`·`--no-heartbeat` 는 watch 플래그가 아니다 — 주면 `watch is read-only: … moved to scripts/split/lease-tick.mjs and was ignored.` 를 찍고(JSON 은 `ignoredFlags`) 아무것도 적용하지 않는다.
- 운용 상태는 리더가 `run.json` 에 `lanes: { <limb>: { state, window?, since?, note? } }` 로 적는다(allowlist `pending|active|awaiting-dispatch|review|serial-gate|closing|done|suspended` — `lib/supervisor/contracts.js`). 2026-09-02 현재 Ontology `run.json` 에는 이 필드가 없어 전부 `unknown` 이다(실측).

## lease-tick (레인 lease 심장박동 + 지정 id 회수 · Monitor ~15분 주기 · 메인 세션 — SH-12 / CA-09)

`node <pluginRoot>/scripts/split/lease-tick.mjs --parent <parentRoot> [--run-id <runId>] [--store-dir <dir>] [--json] [--apply-reclaim <mission/task[,mission/task...]>]`. `watch` 는 자율도 S0(표시·경고만 — vNext 설계 §03)이라 레인 lease 를 **쓰는** 일은 이 스크립트가 따로 맡는다. 줄기 관측은 `watch.mjs#collect` 를 그대로 쓴다(ops 말 · lane-state 시각 · 트레일러 · 잠금 pid).
- **왜 있나**: `task-feed.mjs` 가 dispatch 때 24h TTL 로 잡는 레인 lease 는 리더가 선언하는 순간(`lane-state`, 재dispatch)에만 갱신되고 시계로는 갱신되지 않았으며, 만료된 lease 는 아무도 보지 않았다 — 죽은 줄기가 사람이 알아챌 때까지 lease 를 쥐고 있었다. 대상은 레인 lease 이지 mission 컨트롤러 lease 가 아니다(오너 결정 2026-09-30).
- **심장박동**: 작업 중 ops 말(`active`·`review`·`serial-gate`·`closing`)인 줄기의 lease 를, 마지막 심장박동 뒤 min(ttl/3, 45분) 이 지났을 때만 `lane-lease.mjs#syncLaneLease` 로 갱신한다(재구현 아님). 출하 TTL 24h 면 45분 간격이고 TTL 자체는 그대로다(오너 결정 몫). 틱은 상태가 없다(나이는 lease 에서 읽는다) — 호출 주기가 달라도 되고, 아직 아니면 아무것도 쓰지 않는다. 한 줄기 = 틱당 `syncLaneLease` 1회.
- **생존 증거 없이는 갱신하지 않는다**: 워크트리 잠금 줄의 pid 가 살아 있거나(`session-alive`), 잠금 줄이 없거나 pid 를 읽을 수 없어 생존 여부가 `null` 일 때 `run.json.lanes[limb].updated_at` 이 TTL 창 안(`lane-state-fresh`)이어야 한다. `active` 라는 말만으로는 증거가 아니고, 죽은 pid 는 절대 갱신하지 않는다 — 그런 줄기의 lease 는 TTL 뒤 만료 목록으로 떨어진다. 이미 끝난 줄기(트레일러 `complete`, supervisor `DONE`)도 갱신하지 않는다. `suspended`(재부팅·일시정지)는 갱신도 회수 후보도 아니다 — 보류다(트레일러·supervisor 가 끝났다고 한 suspended 는 보류가 아니라 남은 lease 로 목록에 오른다). `done` 은 여기서 놓지 않는다(`lane-state` 몫).
- **무엇이 남나**: 갱신 1회 = store 커밋 1건이고 `heartbeat_source: lease-tick`, 원장 reason `split.lease-tick` 이다 — `lane-state` 의 `lane-heartbeat` / `split.lane-lease` 와 구별되며 새 이벤트 이름은 없다. 그러나 store 는 커밋마다 짝 `state.updated` 를 원장에 남기므로(`state-manager.js#emitStateUpdated`, 끄는 길이 없다) 틱은 **원장 무음이 아니다** — 레인당 하루 최대 32행(24h ÷ 45분). 설계 D11·§9 의 "heartbeat 는 store 만, 원장에는 `task.claimed/released` 만" 은 아직 충족되지 않았다. 충족하려면 `state-manager` 에 끄는 길을 내고, `ledger ⊇ store` 를 깨진 불변식으로 읽는 소비처 — `doctor-checks.js` 의 `ledger-subset-violation`(FAIL) · `reconcile.js` 의 `extraInStore` · `resume-controller.js` 의 `LEDGER_EXTRA_IN_STORE`(재개 차단) — 가 심장박동 커밋을 예외로 다뤄야 한다. 이 스크립트가 원장 포트를 비우면 모든 틱이 그 불변식 위반으로 읽힌다(코드 독해 — 실행 미확인).
- **회수는 명시한 id 만**: 위 `watch` 목록(또는 이 스크립트의 플래그 없는 실행)이 찍은 `<mission>/<task>` id 를 `--apply-reclaim` 에 적는다(쉼표 목록, 플래그 반복 가능). 적은 id 중 **새로 읽어도 여전히 만료**이고, 보류 줄기(살아 있는 줄기·`suspended`)가 아니며, 같은 소유자가 쥔 것만 `releaseTask`(CAS `expectedVersion`)로 놓는다 — 소유 노드(`claimed`·`executing`·`reviewing`)는 `queued` 로, 종료·실패·ops(SH-11 bound) 노드는 상태를 유지한 채 lease 만 비운다. id 마다 결과가 출력된다: `reclaimed:<status>` · `skipped:`(`not-expired`·`protected`·`malformed`·`not-a-candidate`·`lease-changed`·`no-lease`·`no-task`·`conflict`) · `refused:…`. 목록이 없거나 비었거나 id 하나라도 형식이 틀리면 **전체 거부**한다 — exit 1, stderr `lease-tick refused: …`, stdout 비움, 아무것도 읽거나 쓰지 않음. 전체 해제는 없고 설정 키도 없다. 사람이 id 를 적는 것이 GA 전 "reclaim 은 사람 확인"(설계 §9)이다.
- **종료코드·실패**: 거부된 호출만 exit 1. 세션 id 없음(`CLAUDE_CODE_SESSION_ID`, 없으면 `CLAUDE_SESSION_ID`)·store 예외·남이 쥔 lease·lease 없음은 결과로 출력하고 exit 0 이다(`lane-lease.mjs` 와 같은 record-only). 리더가 재시작하면 새 세션 id 는 mission 행을 갖지 못해 갱신이 `skipped:no-mission` 으로 읽힌다(보고만, 고치지 않음). bound 런(SH-11 카나리 ON)은 bound feeder 가 claim 하지 않아 레인 lease 가 없고 `skipped:no-lease` 다.
- **못 보는 것**: 생존은 약한 신호 둘(잠금 pid, 리더의 lane-state 시각)로 판정할 뿐 일꾼을 지켜보지 않는다 — 잠금 줄도 lane-state 도 없는 살아 있는 줄기는 창이 지나면 죽은 줄기와 같게 읽힌다. pid 에는 시작 시각 확인이 없어, OS 가 pid 를 재사용했다면 죽은 세션이 살아 있다고 읽힌다(미측정). `getState()` 는 호출마다 저널 전체를 다시 파싱하는데 테스트는 몇 건짜리 저널만 쓴다. 임시 리포와 실제 store·원장 자식 프로세스까지 재었고, 실 `/split` 런에서의 라이브 검증은 **미확인**.

## probe (창별 팬아웃 감시 · Monitor 10분 주기용 — A4)

`node <pluginRoot>/scripts/split/fanout-probe.mjs --parent <parentRoot> [--all]` — 창 메인 트랜스크립트가 10분 내 갱신됐는데 서브에이전트 갱신이 5분 내 0 이면 `[fanout SOLO]` 1행, 조용하면 출력 없음(임계 `config.split.supervisor.probe.*`).
- `run.json.lanes[limb].state` 가 `active` 가 아닌 줄기(랜딩 후 dispatch 대기·검수 대기·결합 게이트 직렬 구간)는 경보 제외 — Ontology 실측에서 SOLO 경보 수십 건 중 실개입 0건이 전부 이 유휴 창이었다.
- 줄기·상태를 못 찾으면 **경보하고** `(state unknown)` 을 붙인다(침묵 쪽으로 실패하지 않는다).
- 스폰 원장 `<git-common-dir>/artibot/spawns.ndjson`(`lib/learning/ledger/spawn-ledger.js`, SubagentStart/Stop 훅이 쓴다 — 전 창 공유, 창별 분리는 `sessionId`)이 쌓이면 트랜스크립트 계수 대신 그 원장을 읽는 것이 다음 단계다(미배선).

## lane-state <limb> <state> (운용 상태 기록 — probe·watch 의 입력)

- 레인 상태 갱신: `node <pluginRoot>/scripts/split/lane-state.mjs <limb> <state> [--window <세션>] [--note <한줄>]` — state ∈ `pending|active|awaiting-dispatch|review|serial-gate|closing|done|suspended`(`lib/supervisor/contracts.js#LANE_OPS_STATES`). dispatch 직후 `active`(**`dispatch.mjs` 가 자동 기록** — 손으로 안 쓴다), 검수 넘길 때 `review`, 랜딩 후 `done`(리더 수동 — `landBatch` 는 run.json 을 모른다), suspend 뒤 `suspended`. **이걸 적어야** probe 의 오탐 억제와 watch 의 ops 열이 켜진다(2026-09-02 blindspot: 쓰는 도구가 없어 전 줄기 unknown 이었다; 2026-09-14: 손으로 쓴 `dispatched`·`landed` 가 allowlist 밖이라 다시 8/8 unknown — 이미 쓰인 값은 코드가 고치지 않으니 `lane-state.mjs <limb> active|done` 으로 1회 정정). 쓰기 체인은 `setLaneState` → `lib/topology/split-state.js#writeWorkerState` 하나다.
- 현황: `node <pluginRoot>/scripts/split/lane-state.mjs --list` — plan.json 의 모든 줄기와 state/since/window 표(미설정·allowlist 밖 = unknown, fanout-probe 와 같은 판정).
- 규칙: allowlist 밖 state·plan.json 밖 limb 는 refuse(exit 1), 다른 run.json 키는 절대 지우지 않는다(실런 run.json 의 `metrics`·`landings`·`rebootShutdown_*` 보존). 오타 lane 을 만들 길이 없으므로 이름은 plan.json 그대로.

## worktree-setup <worktreePath> (창 열린 직후 · 멱등 — A6)

운용 규칙 추가(2026-09-10, split-b87130 실측): ① 줄기 창에서 `/doctor` 를 돌리면 Check 8 이 찍는 `read project root: <path>` 줄이 **그 worktree 경로**인지 대조하라 — 부모 루트면 다른 원장을 읽은 것(#G16). ② 줄기의 `Split-Limb` 트레일러는 귀속 줄과 같은 마지막 문단에(별 문단이면 판독기가 no-trailer, 오늘 2줄기). ③ 줄기가 소유 파일을 스캔하는 `tests/firewall/` 게이트를 표적에 넣지 않으면 CI 가 처음 잡는다(Wave 1 not-green 1회) — 소스 스캔형 방화벽은 스폰 0 이라 창에서 안전하다.

`node <pluginRoot>/scripts/split/worktree-setup.mjs <worktreePath> --limb <limb> [--json]` — `config.split.worktreeSetup` 대로 부모의 `node_modules` 를 junction(win32 `mklink /J`, posix symlink)으로 걸고, `.env.local` 을 없을 때만 복사하고, `envPerLane` 을 `<worktreePath>/.artibot/split/<limb>/lane.env` 로 쓴다(`{limb}`/`{limb_}` 치환 — 레인별 e2e DB 이름). 재실행은 전건 skip.
- 실사고 근거: node_modules 부재로 ratchet 자기파괴, pkg 루트 SDK 폴백 = 거짓 red, `.env.local` 미복사 빌드 실패, 공유 DB 에서 병렬 레인의 autoReset 이 형제 시드 삭제(9/2).
- **정리는 `--teardown` 만** — `lstat().isSymbolicLink()` 인 reparse point 만 `rmdir`, 재귀 삭제 0. 링크 자리에 실디렉터리가 있으면 refuse(exit 1) — junction 을 `rm -rf` 하면 부모 957항목이 지워지는 위험이 실측됐다. **창 닫기 순서**: `--teardown`(junction 제거) → 죽은 pid 확인 → `git worktree unlock`(락 잔존 시) → `git worktree remove` → `git worktree prune` — teardown 을 remove 뒤로 미루면 junction 이 남는다(2026-09-11 정리에서 13개 잔존).

## restore-blob <file...> (역주입 원복 · 지문 절차 — A7)

autocrlf 리포에서 `git checkout -- <f>` 는 바이트 복원이 아니다 — CRLF 로 재기록돼 sha256 지문이 주입 전과 달라진다(inspector 실증). 정본 복원은 `node <pluginRoot>/scripts/split/restore-blob.mjs <파일...> [--ref HEAD]`: 추적 파일만(`ls-files --error-unmatch`), `git cat-file -p <ref>:<f>` 바이트 그대로, 뒤에 `git update-index --refresh`(stale ` M` 해소). before/after/blob sha256 을 보고에 붙인다. 역주입 SOP 전체는 `skills/split/SKILL.md` "복원·역주입 SOP".

## suspend / resume-notices (재부팅·마감 프로토콜 — A8)

- 재부팅 전: `node <pluginRoot>/scripts/split/suspend.mjs --reason "<사유>" [--limbs a,b] --json` → 줄기별 `{ limb, to, body }`. `body` = ① 팀원 정지 ② `Split-Limb: wip` 커밋 ③ DEVIATIONS "## 재개" 절 기록 ④ /save ⑤ 회신 `SUSPENDED limb=<limb> sha=<sha>`. 리더가 그대로 `SendMessage(to, body)`. `run.json.suspend = { at, reason, limbs: { <limb>: { notice, to, acked:false } } }` 에 기록(`lib/git/split-run-file.js`). 회신 sha 는 리더가 `git log -1 <branch>` 로 **직접 확인**한 뒤 `acked` 로 올린다(회신은 데이터).
- 재개: `node <pluginRoot>/scripts/split/resume-notices.mjs --json [--clear]` → 줄기별 재개 통지(브랜치·마지막 sha·"브리프 재독 → 재개 절 → 계속"). 전송 뒤 `--clear` 로 블록 제거. 9/2 재부팅 마감의 리더 수기 5항을 그대로 명령화한 것이다.

## 이 참조가 못 보는 것

2026-09-02 에 추가된 스크립트 8종은 **임시 리포 테스트와 Ontology 읽기 전용 스모크**(watch·probe)까지만 실측했다. 라이브 런에서 창이 `dispatch` 포인터를 받아 `prompt.md` 를 따르는지, `worktree-setup` 의 junction 생성·teardown 을 스크립트 경로로 실행했는지(플래너 + 호스트 수동 프로브만), `land` 를 실제 줄기에 돌렸는지는 **미확인**. supervisor 는 관측만 한다 — `lane-heartbeat` 등을 쓰는 emitter 는 0 이며(supervisor 이벤트 스트림의 얘기다 — StateStore 레인 lease 의 심장박동은 `lane-state` 와 `lease-tick` 이 쓴다) 리듀서를 라이브 스트림으로 검증한 것은 telemetry 15줄 1건뿐. 훅은 설치본에서 돈다(`~/.claude/plugins/cache/…`) — 스폰 원장은 `sync:local` 또는 릴리스 뒤에야 쌓인다.
