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
1. `plan.json` 의 줄기 행 → 부모 브리프 `<parentRoot>/.artibot/split/<limb>/brief.md` 를 worktree 로 원자 복사(`lib/git/split-brief.js#materializeLimb` — 소유/allowlist 절·완료 절이 없으면 refuse) → `prompt.md` 렌더(`lib/git/split-brief.js#renderPrompt` — 미해결 `{PLACEHOLDER}` 가 남으면 refuse).
2. `{REPORT_CONTRACT}` 는 `commands/split.md` 의 `[보고 계약]` 펜스를 그대로(`{리더 이름}` → 부모 세션 — parity 게이트 상속), `{MODEL_POLICY}` 는 `lib/core/model-policy.js#resolveModel` 해석값(모델 ID 하드코딩 0), `{GOTCHAS_DELTA}` 는 `<parentRoot>/.artibot/split/gotchas.md`(없으면 "(없음)"). 템플릿 정본 `templates/split/PROMPT-TEMPLATE.md`(플레이스홀더 14종, `config.split.dispatch.template` 로 교체).
3. 출력 `{ to, limb, pointer, promptPath }` 의 **`pointer` 1줄만** 리더가 `SendMessage(to, pointer)` 한다. `to` 가 `null` 이면 `ListAgents` 로 세션을 찾아 `--window` 로 재실행. `--dry-run` 은 쓰기 0.
- 근거(Ontology 9회 실측): 리더가 2.5KB 프롬프트를 창마다 복제 전송하며 치환 실수 위험 + 리더 컨텍스트 소모. 전체 줄기를 한 번에 판정·발송하는 절차는 커맨드 §dispatch 1~5.

## land <limb> (메인 세션 전용 · 읽기 전용 · 랜딩 체크리스트 — A2)

리더가 랜딩마다 손으로 재던 6개를 기계가 한 번에 잰다(Ontology 6랜딩 × ~4 왕복 실측; 수동 grep 이 실제로 절대경로 인용 2건을 잡았다).
`node <pluginRoot>/scripts/split/land.mjs <limb> [--base <ref>] [--plan <path>] [--json] [--pr-body <out>]` → `lib/git/limb-landing-check.js#checkLimbLanding` 이 6행 표를 낸다:
`trailer`(first-parent 규칙) · `ownership`(`git diff --name-only <base>...<branch>` ⊆ 계획의 `affectedPaths` + `.artibot/split/<limb>/**`) · `binary`(`--numstat` 의 `-\t-` 0건) · `citations`(추가된 줄에 `.artibot/split/` 이나 `<드라이브>:/Users/` 절대경로 인용 0건) · `merge-dry-run`(`lib/git/merge-preflight.js#mergeTreePair`) · `behind-base`(정보만).
- `PASS` → exit 0, **승인이 아니다** — PR 본문 골격의 `## 검수` 는 검수자/리더가 쓰는 칸이고 `## 게이트` 수치는 자리표시자다.
- `FAIL` → 빨간 행의 `detail` 을 그대로 줄기 창에 `SendMessage`.
- `UNSUPPORTED` → git < 2.38, 직렬 랜딩으로 강등(절대 PASS 아님).
- **base 선택(실측)**: 줄기가 main 을 merge 했으면 `--base master` 처럼 **살아 있는 ref** 를 준다 — plan.json 의 SHA base 로는 머지된 main 의 남의 파일이 소유권 위반으로 잡힌다. push·merge·쓰기 없음(`--pr-body` 파일만).

## watch (관측 전용 · 자율도 S0 · 메인 세션 — vNext PR-SV02)

`node <pluginRoot>/scripts/split/watch.mjs --parent <parentRoot> [--json] [--run-id <runId>]`. 줄기당 1행: `limb · ops state(run.json.lanes[limb].state) · supervisor(lib/supervisor 리듀서) · complete/reason(트레일러) · last commit · heartbeat · health`.
- `health` 는 `lib/supervisor/lane-monitor.js#assessLane` 의 `healthy|suspect|inspect|recoverable|restart|done|unknown`(vNext 설계 §03 표, 임계는 `config.split.supervisor.*`) — 입력이 없으면 `unknown` 이지 `healthy` 로 메우지 않는다.
- 측정 고지 3문구 값은 raw 로 찍힌다(`null` 은 `null`).
- 부작용은 `runtime/split/{runId}.state.json` 재작성 하나뿐(두 ndjson 의 캐시 — 지워도 리플레이로 동일하게 재생성, `tests/supervisor/`). git·세션·텔레메트리 무변경, 종료코드 항상 0. **폴링 루프 금지**는 그대로 — `watch` 는 사람이 "확인해줘" 할 때, 또는 Monitor 가 주기 실행할 때 한 번 읽는 표다.
- 운용 상태는 리더가 `run.json` 에 `lanes: { <limb>: { state, window?, since?, note? } }` 로 적는다(allowlist `pending|active|awaiting-dispatch|review|serial-gate|closing|done|suspended` — `lib/supervisor/contracts.js`). 2026-09-02 현재 Ontology `run.json` 에는 이 필드가 없어 전부 `unknown` 이다(실측).

## probe (창별 팬아웃 감시 · Monitor 10분 주기용 — A4)

`node <pluginRoot>/scripts/split/fanout-probe.mjs --parent <parentRoot> [--all]` — 창 메인 트랜스크립트가 10분 내 갱신됐는데 서브에이전트 갱신이 5분 내 0 이면 `[fanout SOLO]` 1행, 조용하면 출력 없음(임계 `config.split.supervisor.probe.*`).
- `run.json.lanes[limb].state` 가 `active` 가 아닌 줄기(랜딩 후 dispatch 대기·검수 대기·결합 게이트 직렬 구간)는 경보 제외 — Ontology 실측에서 SOLO 경보 수십 건 중 실개입 0건이 전부 이 유휴 창이었다.
- 줄기·상태를 못 찾으면 **경보하고** `(state unknown)` 을 붙인다(침묵 쪽으로 실패하지 않는다).
- 스폰 원장 `.artibot/ledger/spawns.ndjson`(`lib/learning/ledger/spawn-ledger.js`, SubagentStart/Stop 훅이 쓴다)이 쌓이면 트랜스크립트 계수 대신 그 원장을 읽는 것이 다음 단계다(미배선).

## lane-state <limb> <state> (운용 상태 기록 — probe·watch 의 입력)

- 레인 상태 갱신: `node <pluginRoot>/scripts/split/lane-state.mjs <limb> <state> [--window <세션>] [--note <한줄>]` — state ∈ `pending|active|awaiting-dispatch|review|serial-gate|closing|done|suspended`(`lib/supervisor/contracts.js#LANE_OPS_STATES`). dispatch 직후 `active`, 검수 넘길 때 `review`, 랜딩 후 `done`, suspend 뒤 `suspended`. **이걸 적어야** probe 의 오탐 억제와 watch 의 ops 열이 켜진다(2026-09-02 blindspot: 쓰는 도구가 없어 전 줄기 unknown 이었다).
- 현황: `node <pluginRoot>/scripts/split/lane-state.mjs --list` — plan.json 의 모든 줄기와 state/since/window 표(미설정·allowlist 밖 = unknown, fanout-probe 와 같은 판정).
- 규칙: allowlist 밖 state·plan.json 밖 limb 는 refuse(exit 1), 다른 run.json 키는 절대 지우지 않는다(실런 run.json 의 `metrics`·`landings`·`rebootShutdown_*` 보존). 오타 lane 을 만들 길이 없으므로 이름은 plan.json 그대로.

## worktree-setup <worktreePath> (창 열린 직후 · 멱등 — A6)

`node <pluginRoot>/scripts/split/worktree-setup.mjs <worktreePath> --limb <limb> [--json]` — `config.split.worktreeSetup` 대로 부모의 `node_modules` 를 junction(win32 `mklink /J`, posix symlink)으로 걸고, `.env.local` 을 없을 때만 복사하고, `envPerLane` 을 `<worktreePath>/.artibot/split/<limb>/lane.env` 로 쓴다(`{limb}`/`{limb_}` 치환 — 레인별 e2e DB 이름). 재실행은 전건 skip.
- 실사고 근거: node_modules 부재로 ratchet 자기파괴, pkg 루트 SDK 폴백 = 거짓 red, `.env.local` 미복사 빌드 실패, 공유 DB 에서 병렬 레인의 autoReset 이 형제 시드 삭제(9/2).
- **정리는 `--teardown` 만** — `lstat().isSymbolicLink()` 인 reparse point 만 `rmdir`, 재귀 삭제 0. 링크 자리에 실디렉터리가 있으면 refuse(exit 1) — junction 을 `rm -rf` 하면 부모 957항목이 지워지는 위험이 실측됐다.

## restore-blob <file...> (역주입 원복 · 지문 절차 — A7)

autocrlf 리포에서 `git checkout -- <f>` 는 바이트 복원이 아니다 — CRLF 로 재기록돼 sha256 지문이 주입 전과 달라진다(inspector 실증). 정본 복원은 `node <pluginRoot>/scripts/split/restore-blob.mjs <파일...> [--ref HEAD]`: 추적 파일만(`ls-files --error-unmatch`), `git cat-file -p <ref>:<f>` 바이트 그대로, 뒤에 `git update-index --refresh`(stale ` M` 해소). before/after/blob sha256 을 보고에 붙인다. 역주입 SOP 전체는 `skills/split/SKILL.md` "복원·역주입 SOP".

## suspend / resume-notices (재부팅·마감 프로토콜 — A8)

- 재부팅 전: `node <pluginRoot>/scripts/split/suspend.mjs --reason "<사유>" [--limbs a,b] --json` → 줄기별 `{ limb, to, body }`. `body` = ① 팀원 정지 ② `Split-Limb: wip` 커밋 ③ DEVIATIONS "## 재개" 절 기록 ④ /save ⑤ 회신 `SUSPENDED limb=<limb> sha=<sha>`. 리더가 그대로 `SendMessage(to, body)`. `run.json.suspend = { at, reason, limbs: { <limb>: { notice, to, acked:false } } }` 에 기록(`lib/git/split-run-file.js`). 회신 sha 는 리더가 `git log -1 <branch>` 로 **직접 확인**한 뒤 `acked` 로 올린다(회신은 데이터).
- 재개: `node <pluginRoot>/scripts/split/resume-notices.mjs --json [--clear]` → 줄기별 재개 통지(브랜치·마지막 sha·"브리프 재독 → 재개 절 → 계속"). 전송 뒤 `--clear` 로 블록 제거. 9/2 재부팅 마감의 리더 수기 5항을 그대로 명령화한 것이다.

## 이 참조가 못 보는 것

2026-09-02 에 추가된 스크립트 8종은 **임시 리포 테스트와 Ontology 읽기 전용 스모크**(watch·probe)까지만 실측했다. 라이브 런에서 창이 `dispatch` 포인터를 받아 `prompt.md` 를 따르는지, `worktree-setup` 의 junction 생성·teardown 을 스크립트 경로로 실행했는지(플래너 + 호스트 수동 프로브만), `land` 를 실제 줄기에 돌렸는지는 **미확인**. supervisor 는 관측만 한다 — `lane-heartbeat` 등을 쓰는 emitter 는 0 이며 리듀서를 라이브 스트림으로 검증한 것은 telemetry 15줄 1건뿐. 훅은 설치본에서 돈다(`~/.claude/plugins/cache/…`) — 스폰 원장은 `sync:local` 또는 릴리스 뒤에야 쌓인다.
