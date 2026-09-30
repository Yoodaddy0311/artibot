# M1 라이브 계수 — P0-16 · OB-24 · SH-19 · GA-02 판정 근거와 스냅샷 6행 (2026-09-30)

이 문서는 리더가 아래 행의 done 여부를 정하도록 실측을 모은 것이다. 행 status 는 바꾸지 않는다(status 는 리더가 [V5-BACKLOG.md](../V5-BACKLOG.md) 에서만 바꾼다).

- done 판정 후보: P0-16(I1 · I4 · I7), OB-24, SH-19, GA-02
- 수치만 기록: CA-02, SH-03, SH-05, SH-12, CA-15, CA-13 · CA-03

등급 표기: **실측**(내가 직접 실행한 출력이 있다) · **추론**(코드 · 문서 · 정황에서 유도, 실행 안 함) · **미확인**(확인 안 함).

## 0. 판정(먼저)

| 행 | done 조건 요지 | 측정 결과 | 판정 | 등급 |
|---|---|---|---|---|
| P0-16 I1 | `claude-sonnet-5-5` 라이브 영수증 확인 | 설치 뒤 창의 `usage.receipt` 24행 중 `claude-sonnet-5-5` 14행, 14/14 가 tier `sonnet` · `catalog_version` 2026-09-29 · `cost.total` 숫자 · `pricing_version` 2026-09-28. 창 안 `session.ended` 2행의 `unresolved_models` 는 둘 다 `[]` | 충족 | 실측 |
| P0-16 I4 | Agent `model` alias 수용 — 실스폰 + transcript `message.model` 대조 | meta `model:"sonnet"` 인 transcript 70/70 이 `claude-sonnet-5-5` 로만 서빙(assistant 행 25,714, 그 밖 모델 0). frontmatter `model: opus` 인 플러그인 에이전트에 `sonnet` 을 넘긴 6건도 전부 sonnet 서빙. `haiku` 1/1 은 `claude-haiku-4-5-20251001` | 충족 | 실측 |
| P0-16 I7 | 실행 중 전환 조사 | 이 문서에서 재측정하지 않았다. 답은 [p0-16-i7-20260929.md](p0-16-i7-20260929.md) 에 있다(G1 트리거 미충족) | 답 있음(재측정 안 함) | 문서 인용 |
| P0-16 전체 | I1~I7 전부 답이 있을 것 | I2 · I3 · I5 · I6 은 백로그 기록상 해소, I1 · I4 는 위 실측, I7 은 증거 문서 | 충족으로 보인다 — 조사 행이라 "답이 있다"가 기준이면 충족. 리더 판정 | 추론 |
| OB-24 | R1 착지 · 릴리스 뒤 `existence-audit.mjs` 의 직접 등록 훅 발화가 0 이 아닐 것 | 훅 58종: 발화 54 · 측정된 0 이 4 · unmeasured 0. 직접 등록 전용 16종 중 13종 발화. 직접 슬롯 행 60, 첫 행 05:19:32Z(설치 뒤), 설치 전에는 0 | 충족 | 실측 |
| SH-19 | 설치본에서 중첩 스폰의 stop 행 중 `depth` 가 null 이 아니고 `parent_agent_id` 가 그 스폰의 meta 파일과 일치하는 것 ≥1 | `depth_source:"host-meta"` stop 행 27, 그중 `depth` 1 이고 `parent_agent_id` 가 meta `parentAgentId` 와 같은 행 2. 27/27 이 meta 의 depth · parent 와 일치 | 충족 | 실측 |
| GA-02 | 라이브 티어 적용 표본 ≥1(D1) | 지정 규칙(요청 alias ≠ frontmatter 티어 AND 서빙 모델이 `usage.receipt` 에 조인)으로 14건. frontmatter 가 파일로 있는 플러그인 에이전트만 세면 6건 | 충족 | 실측(규칙 적용), 규칙 해석은 아래 주의 |

스냅샷(판정 대상 아님, §6):

| 행 | 수치(설치 뒤 창) |
|---|---|
| CA-02 | `route.selected` 15행 중 `canary:*` 사유 0, `requested_task.class` 가 classify 또는 status 인 행 0. canary 경로의 라이브 표본 0 |
| SH-03 | slash 일치 14/17(0.8235), hint-followed 0/0(null), deferral 456/515(0.8854) — 판독기가 창을 받지 않아 전 기간 값 |
| SH-05 | bind 15 · receipt 24 · 조인쌍 0 · score null(`no-spawn-keyed-score-writer`), `review.claim_audit` 전 기간 0 |
| SH-12 | 창 안 `split.lane-lease` 0행(전 기간 56, 마지막 2026-09-29T00:19:19Z). task lease 9건 모두 `heartbeat_at` = `acquired_at`(갱신 0) |
| CA-15 | `adr.question_gate_evaluated` 13행, `interpretation_present:true` 13/13, `required:true` 0/13 |
| CA-13 · CA-03 | 4.70.0 세션 스토어 4세션 전부 `NO_VERIFY_ATTEMPT`, `pauseAtReport` 0/4. 창 안 REPORT 도달 0. 복구 저널 1행(2026-09-29 세션, 설치 전) |

## 1. 방법과 재현 명령

### 1.1 입력 스냅샷

원장은 메인 체크아웃의 `.git/artibot/ledger.jsonl` 을 **한 번** 복사했고 모든 원장 총계와 내역은 이 사본에서 냈다. 판독기는 사본을 담은 임시 git 리포(`git init` 뒤 `.git/artibot/` 에 사본을 둔 것)에 `--cwd` 로 돌렸다 — 판독기 출력의 `inputPath` · `ledger_path` 가 전부 그 사본 경로인 것을 확인했다(실측).

| 입력 | 복사 시각(UTC) | 크기 | 줄 | 파싱 실패 | 비고 |
|---|---|---|---|---|---|
| 중앙 원장 | 2026-09-30T09:47:50.221Z | 24,572,983 B | 개행 61,898(빈 줄 없음, CR 0) | 0 | 첫 행 2026-09-03T09:37:08.727Z, 마지막 행 2026-09-30T09:47:48.363Z. SHA-256 앞 16자 `A302A283583F5CA2` |
| 스폰 원장 `spawns.ndjson` | 2026-09-30T09:48:06.619Z | 3,352,999 B | 7,915 | 0 | 위치는 메인 체크아웃 `.git/artibot/spawns.ndjson`(찾은 경로, 아래) |
| 상태 스토어 `project-state.json` | 2026-09-30T10:01Z 경 | 100,332 B | — | 0 | 원본 mtime 09:03:19Z |
| 호스트 subagent meta · transcript | 스캔 2026-09-30T09:54:48Z | meta 617 · transcript 617 | — | 0 | `~/.claude/projects/C--Users-HeechangLee-Desktop-AI-Artibot/*/subagents/` 56 세션 디렉터리. 원장 사본보다 약 7분 늦다 |
| 설치본 | — | — | — | — | `~/.claude/plugins/installed_plugins.json`: artibot 4.70.0, `gitCommitSha` ac5dfb4d, `lastUpdated` 2026-09-30T05:05:29.234Z |

창: 모든 "설치 뒤" 값은 `since = 2026-09-30T05:05:29.234Z`(설치 `lastUpdated`) 이후 행이다. 창 안 원장 행 5,236(실측).

`spawns.ndjson` 찾기: 홈 아래 깊이 6 재귀 검색에서 `~/.artibot/runtime/spawns.ndjson`(4,617 B, 07:51Z) · `~/Desktop/.artibot/runtime/spawns.ndjson` · 리포 `.artibot/ledger/spawns.ndjson`(444,579 B, 마지막 쓰기 2026-09-14, ADR-011 이전 위치) · `Desktop/Ontology/...` 가 나왔다. 이 리포의 현행 위치는 `.git/artibot/spawns.ndjson`(런북 §1.3 표)이고 그것을 썼다. 나머지 파일은 읽지 않았다(다른 작업 디렉터리 또는 옛 위치로 보인다 — 추론).

### 1.2 명령(PowerShell, node 는 `C:\Program Files\nodejs\node.exe`)

`$R` = 사본 리포, `$W` = 이 worktree 의 `plugins/artibot`(ac5dfb4d = 설치본과 같은 커밋), `$PR` = `~/.claude/plugins/cache/artibot/artibot/4.70.0`.

```text
node $W\scripts\ledger\existence-audit.mjs --cwd $R --plugin-root $PR --since 2026-09-30T05:05:29.234Z
node $W\scripts\ledger\route-compare.mjs  --cwd $R --since 2026-09-30T05:05:29.234Z
node $W\scripts\ledger\session-coverage.mjs --cwd $R --since 2026-09-30T05:05:29.234Z
node $W\scripts\ledger\usage-cost-table.mjs --ledger <사본 ledger.jsonl> --session 64753a4c-d89c-4ced-a076-9f1e0a2f2d55,e0300130-ffbf-45b8-b3be-bb3c33ca2f29
node $W\scripts\evals\nl-activation-report.mjs --project-root $R      # 결정 스토어 37파일을 $R\.artibot\runtime\decisions 로 복사한 뒤
node $W\scripts\ledger\recovery-journal-census.mjs --dir $PR\runtime\autopilot   # 4.69.0 캐시 · 마켓 사본도 같은 방식
```

`usage-cost-table.mjs` 의 `--since` 는 행 기록 시각이 아니라 `timing.started_at` 으로 거른다(스크립트 머리 주석). 창 안 영수증의 스폰은 설치 전(02:12~04:05Z)에 시작했으므로 `--since` 대신 창 안 영수증을 가진 두 세션 id 로 걸렀다.

임시 계수 스크립트(읽기 전용, ASCII)는 부록에 원문을 둔다: `census.js`(원장 창 계수) · `census2.js`(route · hook tool 필드) · `scan-meta.js`(meta · transcript) · `ga02.js`(GA-02 조인) · `sh19.js` · `sh19b.js`(SH-19 조인) · `tooluse.js`(transcript tool_use) · `misc.js` · `lease2.js` · `rvg.mjs`(`plugins/artibot/lib/autopilot/report-verify-gate.js#censusReportVerifyEvidence` 호출).

## 2. 결과 — 판정 대상 4행

### 2.1 P0-16 (조사 I1~I7)

**done 조건(정본)**: `V5-BACKLOG.md` P0-16 행 비고 — "P0-16 은 여기서 done 으로 올리지 않는다: I4 부분 문언과 sonnet-5-5 라이브 영수증 확인은 W3-4 m1-live-census 에서 함께 판정한다". `V5-RESCOPE-20260930.md` §6 (ii) — "남은 것은 I4 부분 문언과 `claude-sonnet-5-5` 라이브 영수증 확인". I4 의 조사 방법은 `ARTIBOT-5.0-DESIGN.md` §7.6 표 I4 행 — "실스폰 1건(planner 를 `model=haiku` 로) + `subagents/agent-*.jsonl` `message.model` 대조".

**I1 — 측정(실측, `census.js`, 분모 = 창 안 `usage.receipt` 24행)**

| 항목 | 값 |
|---|---|
| 모델 | `claude-opus-5-5` 10 · `claude-sonnet-5-5` 14 |
| tier | opus 10 · sonnet 14 |
| `catalog_version` | 2026-09-29 × 24 |
| `cost.total` 숫자 | 24/24(null 0). 합계 $155.86 — `usage-cost-table.mjs` 의 합계 $155.86 과 같다 |
| `pricing_version` | 2026-09-28 × 24 |
| `usage.source` | transcript × 24 |
| 세션 | 2(64753a4c 23행 @05:36:16Z, e0300130 1행 @06:14:46Z) |
| `session.ended` | 2행, 둘 다 `receipt_status:"appended"` · `coverage:1` · `unresolved_models:[]` |
| 전 기간 `claude-sonnet-5-5` 영수증 | 14 — 전부 이 창 안이다 |

리더 주장 "05:05:29Z 이후 14행, sonnet-5-5 · tier sonnet · catalog 2026-09-29" → **성립**(실측). "cost.total non-null 여부 미확인" → **24/24 숫자**(실측).

**I4 — 측정(실측, `scan-meta.js` · `ga02.js`, 분모 = meta 617개)**

- 리더 주장 "`agent-aw36-fix-ea5bc9c1a1a1b23a` meta model sonnet → `claude-sonnet-5-5` 161행" → **성립**: meta `{"agentType":"w36-fix","model":"sonnet","spawnDepth":0,"taskKind":"in_process_teammate"}`, assistant 행 161 전부 `claude-sonnet-5-5`, 첫 행 02:19:24Z.
- meta `model` 값별 transcript 수와 서빙 모델(`<synthetic>` 제외):

| meta `model` | transcript | 서빙 모델(transcript 수) |
|---|---|---|
| `sonnet` | 70 | `claude-sonnet-5-5` 70 |
| `opus` | 375 | `claude-opus-5` 168 · `claude-opus-5-5` 207 |
| `haiku` | 1 | `claude-haiku-4-5-20251001` 1(2026-09-28, `artibot:doc-updater`) |
| `claude-fable-5-1[1m]` | 125 | `claude-fable-5-1` 123 · 행 없음 2 |
| `fable` | 5 | `claude-fable-5-1` 4 · 행 없음 1 |
| `opus[1m]` | 5 | `claude-opus-5` 5 |
| `inherit` | 1 | `claude-sonnet-5` 1 |
| 없음 | 35 | 여러 모델 |

- frontmatter 를 이기는지(alias 가 기본값을 덮는지): 창 안 sonnet 영수증 14건 중 6건이 `artibot:tdd-guide` · `artibot:backend-developer` ×3 · `artibot:doc-updater` ×2 이고, 이 셋의 frontmatter 는 4.69.0 · 4.70.0 캐시 모두 `model: opus` 다(실측). 6건 모두 Agent 호출 입력에 `model:"sonnet"` 이 있고 전부 `claude-sonnet-5-5` 로 서빙됐다.
- 판정: alias 수용 **충족**. 설계가 적은 방법(planner 를 haiku 로)과 같은 실스폰은 아니다 — 같은 질문을 sonnet 70건 · haiku 1건으로 답했다.

**I7**: 이 문서는 재측정하지 않았다. [p0-16-i7-20260929.md](p0-16-i7-20260929.md) 가 답(팀원은 스폰 시 고정, 호스트 fallback 은 실행 중 서빙 모델을 바꾼다, G1 재검토 트리거 미충족)이다.

**주의**

- 14행을 쓴 세션 64753a4c 는 설치(05:05Z) 전에 시작했다. 이 세션이 05:13:09Z 에 쓴 `adr.question_gate_evaluated` 행에는 `interpretation_status` 키가 없고, 그 키를 가진 첫 행은 05:36:28Z 다(실측, `misc.js`). 그래서 이 영수증은 4.70.0 이 아니라 그 세션이 시작할 때 로드한 이전 캐시 코드가 썼을 가능성이 높다(추론). 백로그가 요구한 것은 "라이브 영수증 확인" 이라 판정은 바뀌지 않는다.
- meta `model:"sonnet"` transcript 70개 중 영수증이 있는 것은 14개(세션 64753a4c)뿐이다. 나머지 56개: 아직 끝나지 않은 세션 922fad08 14개 · `session.ended` 행이 전 기간 0 인 세션 ed8452d7 41개 · 수리 전(2026-09-29T01:49Z)에 끝나 `unresolved_models:["claude-sonnet-5-5"]` 로 영수증이 버려진 세션 8ce16014 1개(실측). 영수증은 SessionEnd 에서만 쓰인다(`usage-cost-table.mjs` 출력의 한계 문구).
- 전 기간 `spawns.ndjson` 의 `requestedModel` 은 7,915행 중 0행이 non-null 이다(실측). spawn 원장으로는 I4 를 볼 수 없고 근거는 transcript 와 영수증뿐이다.

### 2.2 OB-24 (Existence Audit 카운트)

**done 조건(정본)**: `V5-RESCOPE-20260930.md` §6 (ii) — "R1 착지·릴리스 뒤 `existence-audit.mjs` 의 직접 등록 훅 발화 비-0". `V5-BACKLOG.md` OB-24 행이 인용한 커밋 본문 — "OB-24 stays open until a release carries this and live rows exist".

**측정(실측, `existence-audit.mjs`, 분모 = `hook.fired` 5,138행 · 창 안 행 5,236)**

- 출력: `sources.hooks.count` 58 = `handlerEntries` 44 · `directEntries` 24, `hooksOutsideCarrier` 0, `summary.eventsReceived` 5,236(내 `census.js` 창 계수 5,236 과 같다).
- 58종: 발화 > 0 **54** · 측정된 0 **4** · unmeasured **0** → 리더 주장 **성립**(실측).
- 경로별: 디스패처 전용 37 · 직접 전용 16 · 양쪽 5. 직접 전용 16 중 발화 13.
- 직접 슬롯 행(`PreToolUse` 23 · `PostToolUseFailure` 12 · `InstructionsLoaded` 9 · `Notification` 6 · `SubagentStart` 4 · `TeammateIdle` 4 · `PreCompact` 1 · `PostCompact` 1) = 60. 전 기간에서 직접 슬롯 행은 2026-09-30 의 60행뿐이고 첫 행은 05:19:32.740Z(설치 14분 뒤)다(`misc.js`, 실측). → R1 이 설치본 4.70.0 으로 라이브에 도달했다(설치 전 0 행이라는 점에서 추론).

**0 발화 4종 분류**

| 훅 | 경로 | 등록(4.70.0 캐시) | 이벤트가 있었나 | 등급 |
|---|---|---|---|---|
| `webfetch-cache-post` | 디스패처 자식 | `dispatch-table.json` PostToolUse, `tools:["WebFetch"]` | 없음. 창 안 PostToolUse `hook.fired` 3,455행의 `tool` 필드에 WebFetch 0. 창 안 transcript 35파일 tool_use 4,067줄에 WebFetch 0 | 실측 |
| `webfetch-cache-pre` | 직접 전용 | `hooks.json` PreToolUse matcher `WebFetch` | 없음(위 transcript 계수와 같다) | 실측 |
| `clean-state-check` | 직접 전용 | `hooks.json` `TaskCompleted` | 창 안 `TaskCompleted` 슬롯 행 0. 같은 이벤트에 등록된 `team-idle-handler` 도 `TaskCompleted` 행 0(발화 2는 전부 `TeammateIdle`). transcript 에 task 목록 도구 호출 0 | 추론(이벤트 부재로 보인다. 호스트가 발행하지 않았는지는 원장으로 구분 못 한다) |
| `permission-auto-approve` | 직접 전용 | `hooks.json` `PermissionRequest` | 창 안 `PermissionRequest` 슬롯 행 0. `~/.claude/settings.json` `defaultMode:"auto"`(실측) 라 권한 대화상자가 뜨지 않았을 것으로 보인다 | 추론 · 호스트 발행 여부 미확인 |

넷 모두 "이벤트가 없어서 0" 으로 읽힌다. 결함 신호로 볼 근거는 없다.

**주의**: `fired` 는 두 단위가 섞인다 — 디스패처는 dispatch 1회당 1행, 직접은 UTC 일 · 세션 · 슬롯 · 훅당 첫 발화 1행이다(출력의 `carrierNote`). 직접 훅의 13 발화는 "세션-일" 수다.

### 2.3 SH-19 (delegation depth 기록)

**done 조건(정본)**: `V5-BACKLOG.md` SH-19 행 — "설치본(릴리스 · `/update` 뒤)에서 중첩 스폰의 stop 행 중 `depth` 가 null 이 아니고 `parent_agent_id` 가 그 스폰의 meta 파일과 일치하는 것 ≥1".

**측정(실측, `sh19.js` · `sh19b.js`, 분모 = 스폰 원장 사본 7,915행)**

- `depth_source:"host-meta"` 행 **27**(전부 stop), `depth` 분포 0:13 · 1:14, 첫 행 2026-09-30T05:50:03.963Z(설치 뒤).
- `depth` ≥1 이고 `parent_agent_id` 가 non-null 이며 meta `parentAgentId` 와 같은 행 **2**:

| ts | agentId | depth | parent_agent_id | meta `spawnDepth` / `parentAgentId` |
|---|---|---|---|---|
| 05:54:35.953Z | `ateam-plugin-portable-static-0ba5abc5e14cf859` | 1 | `a9829200beed51f35` | 1 / `a9829200beed51f35` |
| 06:03:06.327Z | `ateam-plugin-portable-hooks-a5b4f603c595e9ab` | 1 | `a9829200beed51f35` | 1 / `a9829200beed51f35` |

- 27/27 행이 meta 의 depth · parent 와 일치(불일치 0).
- 리더 주장 "host-meta 19행, depth≥1 10행" → **스냅샷 시점에는 27 · 14 다**. 스폰 원장은 계속 늘고, 사본에서 09:08:09Z 까지의 행만 자르면 19 · 10 이 나온다 — 리더 값은 그 무렵의 값으로 보인다(추론). "…a5b4f603c595e9ab 의 stop 행 parent `a9829200beed51f35` = meta" → **성립**(실측).
- 백로그가 미증명으로 둔 `caller_agent_id` 조인: `route.selected` 에서 `caller_agent_id` 가 non-null 인 2행(05:49:46Z · 05:49:58Z, 값 `a9829200beed51f35`)을 `shadow_of` 의 tool_use id → `route.bound.tool_use_id` → `agent_id` → meta `parentAgentId` 로 이었더니 **2/2 일치**(실측). 서브에이전트 안에서 부른 Agent 호출의 PreToolUse payload 에 호스트가 `agent_id` 를 싣는다는 것이 이 2건으로 확인된다.

**주의**

- 단위: 메인 세션이 부른 일반 서브에이전트도 `depth` 1 이고 부모가 없다(예 `a9829200beed51f35` 자신, 1 / null). 그 서브에이전트가 부른 팀원도 `depth` 1 이다(2 가 아니다). 즉 호스트 `spawnDepth` 만으로는 중첩을 가를 수 없고 `parent_agent_id` 가 가른다(실측 관측, 호스트 규칙은 추론). 단위 확정은 v5.1 로 위임됐다(`V5-RESCOPE-20260930.md` §8 SH-19 depth 단위 행).
- 창 안 stop 1,550행 중 1,522행은 `depth_source` 가 null 이다. 그 행들의 `agentId` 로 찾은 meta 파일은 0개였다(실측). meta 가 없는 종류의 stop 으로 보인다(추론).
- 표본 2건은 한 세션(e97ee299), 한 부모에서 나왔다.

### 2.4 GA-02 (4티어 전면)

**done 조건(정본)**: `V5-BACKLOG.md` GA-02 행 — "오너 결정 D1(§4-h, 2026-09-28)이 `/model-routing` task 층(리더 전달, 강제 훅 없음)을 CA-02 작동기로 인정했으므로 **done 조건 = 라이브 티어 적용 표본 ≥1** 이다".

**표본 규칙(리더 지정, 권장 결정)**: 요청 alias(meta `model`)가 에이전트 frontmatter 티어와 다르고, **그리고** 서빙 모델 id 가 `usage.receipt` 행에 조인되는 것만 센다.

**측정(실측, `ga02.js`, 분모 = 창 안 `claude-sonnet-5-5` 영수증 14행)**

| run_id | Agent `subagent_type` | frontmatter(4.70.0 캐시) | meta `model` | 서빙(assistant 행) | 규칙 충족 |
|---|---|---|---|---|---|
| agent-a0cdac00ad1a657aa | artibot:tdd-guide | opus | sonnet | sonnet-5-5 426 | 예 |
| agent-a2d46beff4cd33959 | artibot:backend-developer | opus | sonnet | sonnet-5-5 420 | 예 |
| agent-aab8a9e890b671ede | artibot:doc-updater | opus | sonnet | sonnet-5-5 338 | 예 |
| agent-ae251b57755943060 | artibot:backend-developer | opus | sonnet | sonnet-5-5 348 | 예 |
| agent-afaa21eb3f8ea3d9a | artibot:backend-developer | opus | sonnet | sonnet-5-5 358 | 예 |
| agent-adoc-decisions-2552d598a1460d67 | artibot:doc-updater | opus | sonnet | sonnet-5-5 127 | 예 |
| agent-ab3-fix-28877185858a115f | general-purpose | 없음(부모 opus 상속) | sonnet | sonnet-5-5 211 | 예(상속 기준) |
| agent-aca01-fix-bea0f399c96c2688 | general-purpose | 없음 | sonnet | sonnet-5-5 271 | 예(상속 기준) |
| agent-aca02-fix-a07b27595940e015 | general-purpose | 없음 | sonnet | sonnet-5-5 304 | 예(상속 기준) |
| agent-adocs-sync-31ab5389e8aed67a | general-purpose | 없음 | sonnet | sonnet-5-5 302 | 예(상속 기준) |
| agent-aflake-fix-c36e849c63d9e646 | general-purpose | 없음 | sonnet | sonnet-5-5 206 | 예(상속 기준) |
| agent-arelease-prep-081f6b131ed2a7bb | general-purpose | 없음 | sonnet | sonnet-5-5 309 | 예(상속 기준) |
| agent-aw36-finish-84c5e5ea17a6d990 | general-purpose | 없음 | sonnet | sonnet-5-5 43 | 예(상속 기준) |
| agent-aw36-fix-ea5bc9c1a1a1b23a | general-purpose | 없음 | sonnet | sonnet-5-5 161 | 예(상속 기준) |

- 규칙 충족 **14** · frontmatter 파일이 있는 플러그인 에이전트만 세면 **6**. 어느 쪽이든 "≥1" 을 넘는다.
- 14행 모두 영수증 tier `sonnet`, `cost.total` 숫자.

**주의**

- general-purpose 는 frontmatter 가 없다. 규칙의 "frontmatter 티어" 를 부모 상속값(메인 opus)으로 읽어 8건을 셌다. 이 해석이 싫으면 6건이다.
- 작동기(`/model-routing resolve`)는 아무 것도 기록하지 않는다(CA-02 행). 리더가 그 출력을 `model` 로 넘겼다는 것은 사용자 설정 `~/.claude/artibot/model-routing.json` 의 `tasks.implement:"sonnet"` 과 들어맞는다는 정황뿐이다(추론). 샘플이 "사용자 task 층" 에서 왔고 canary(classify · status) 층에서 온 것은 0 이다(§3.1).
- 14건 모두 한 세션(64753a4c)이고 스폰 시각은 02:12~04:05Z(설치 전)이며, 영수증 기록은 05:36Z 다. 스폰 당시 frontmatter 는 4.69.0 캐시 기준이고 그 값도 opus 다(실측).

## 3. 결과 — 스냅샷 6행 (판정 아님)

### 3.1 CA-02 (classify · status 저가 실적용)

- `route.selected` 15행(창 안, 실측): `reason` 에 `canary:*` 0. `requested_task.class` — review 11 · architecture 2 · null 2, classify · status 0. `requested_model` — opus 14 · sonnet 1(09:38:18Z, class review).
- 출하 config(4.70.0 캐시 `artibot.config.json`): `routing.canary.actionClasses` `["classify","status"]` · `tier` `"sonnet"`(실측).
- canary 경로로 설명되는 라이브 표본: 0. GA-02 의 14건은 canary 가 아니라 사용자 task 층이다(§2.4).
- 참고: `haiku` 서빙 1건 — `model:"haiku"` meta 1개가 `claude-haiku-4-5-20251001` 7행으로 서빙됐다(2026-09-28). RESCOPE §8 R-7 의 "haiku 서빙은 미확인" 에 대한 관측치다.

### 3.2 SH-03 (NL activation)

`nl-activation-report.mjs`(실측, 전 기간 — `--since` 없음, 정본 원장 survivors 61,896 + 결정 스토어 37파일 1,742 이벤트): `activation.slash-agreement` 14/17 = 0.8235 · `activation.hint-acceptance` 0/0(구조적 unmeasured) · `mission.deferral-rate` 456/515 = 0.8854(보조 축) · `activation.hint-followed` 0/0(null). 결정 스토어는 메인 체크아웃 `.artibot/runtime/decisions` 를 약 10:01Z 에 복사한 것이라 원장 사본과 시각이 약 14분 다르다.

### 3.3 SH-05 (추천 스폰 영수증 · 점수 비교)

`route-compare.mjs --since 05:05:29.234Z`(실측): binds 15 · receipts 24(메인 2 · 서브 22) · 조인쌍 0 · unjoined binds 15 · unjoined receipts 22 · `agreement_rate` null · `score.reason` `no-spawn-keyed-score-writer`. `review.claim_audit` 창 안 0 · 전 기간 0. 창 안 bind 15건은 아직 끝나지 않은 세션(922fad08 · e97ee299)의 것이라 영수증이 아직 없다(추론 — 영수증은 SessionEnd 에서만 쓰인다).

### 3.4 SH-12 (lease / heartbeat)

- 원장(실측): 창 안 `state.updated` 3행은 전부 `reason:"mission.created"`, `split.lane-lease` 0. 전 기간 `split.lane-lease` 56행, 마지막 2026-09-29T00:19:19.638Z.
- 상태 스토어 사본(실측): `task_leases` 9건 모두 `heartbeat_at` 이 `acquired_at` 과 같다(갱신 0). `task_graphs` 안 `heartbeat_source:"lane-heartbeat"` 태스크 2. 미션 컨트롤러 lease 12건은 별개(세션 922fad08 의 것은 `heartbeat_at` 09:03:19Z 로 갱신됨 — SH-12 의 lane heartbeat 가 아니다).
- done 조건("라이브 lease heartbeat 갱신 ≥1")은 이 스냅샷에서 0 이다.

### 3.5 CA-15 (question gate)

창 안 `adr.question_gate_evaluated` 13행(실측): `interpretation_present:true` 13/13, `interpretation_status` ok 12 · 키 없음 1(05:13:09Z, 설치 전 세션의 이전 코드), `required:true` 0/13. 전 기간 63행 · `interpretation_present:true` 18 · `required:true` 0. Q2-O1 권장 기준(`interpretation_present` 행 ≥20)은 전 기간으로도 18 이다. 스위치 `runtime.questionGate.enforce` 는 4.70.0 캐시 config 에서 false(실측).

### 3.6 CA-13 · CA-03 (REPORT 게이트 · 복구 저널)

- `censusReportVerifyEvidence`(`rvg.mjs`, 4.70.0 캐시 세션 스토어, 실측): 세션 4 — `NO_VERIFY_ATTEMPT` 4/4 · terminal 2(ABORTED) · live 2(CROSS_CHECK · INTAKE) · `pauseAtReport` 0/4. 가장 최근 파일은 `ap-20260930-023715-7hd72w`(INTAKE, mtime 07:51:17Z).
- 창 안 원장에 autopilot 이벤트 유형은 없다(창 안 이벤트 유형 12종 목록, 실측). 게이트를 거친 라이브 드라이버 REPORT 도달은 0 이다.
- `recovery-journal-census.mjs`(실측): 4.70.0 캐시 · 4.69.0 캐시 · 마켓 사본 모두 rows 1 · `divergentTrue` 1 — 같은 세션 `ap-20260929-015712-kb9gpb`(ABORTED, 파일 mtime 2026-09-29T03:28:13Z). 설치 전의 행이다. 세 스토어가 같은 파일을 가진 것은 업데이트 미러 복사로 보인다(추론). 출하 config `autopilot.reportVerifyGate.enforce` true · `autopilot.recovery.transitionFromVerdict` false(실측).

## 4. 관측치 정합성

| 대조 | 결과 |
|---|---|
| 창 안 행 수: `census.js` 5,236 = existence-audit `eventsReceived` 5,236 = route-compare · session-coverage `survivors` 5,236 | 일치 |
| `hook.fired` 5,138 = existence-audit hooks `denominator` 5,138 | 일치 |
| 영수증 24 = `session.ended` 의 `appended` 23 + 1 | 일치 |
| 비용 합 `census.js` $155.8614 = `usage-cost-table.mjs` $155.86 | 일치 |
| 직접 슬롯 행 60 = 슬롯별 합(23+12+9+6+4+4+1+1) | 일치 |
| host-meta 27행 ↔ meta 27개 depth · parent | 27/27 일치 |
| sonnet meta 70 대 sonnet 영수증 14 | 모순 아님: 나머지 56개는 끝나지 않은 세션 922fad08(14) · `session.ended` 가 없는 세션 ed8452d7(41) · 수리 전에 끝나 영수증이 버려진 세션 8ce16014(1)의 것이다(§2.1 주의) |
| nl-activation 정본 survivors 61,896 대 사본 개행 61,898 | 2행 차이. 판독기의 중복 제거 규칙(`readLedgerCensus`)으로 보이나 원인은 확인하지 않았다(미확인) |
| **CA-03 백로그 기록 대 이 계수** | 백로그 CA-03 행은 2026-09-29T07:21:16Z 재판독에서 "세션 스토어 7파일 · 저널 보유 0" 이라 적었다. 이 계수의 저널 행은 mtime 03:28:13Z(그보다 이르다)인 파일에 있다. 둘 다 참이려면 그 재판독이 다른 스토어 디렉터리를 읽었어야 한다. 어느 디렉터리였는지는 미확인이다 |
| **리더 주장 SH-19 19/10 대 27/14** | 시점 차이로 설명된다(사본을 09:08:09Z 까지 자르면 19/10) |

## 5. 이 수치가 못 보는 것

- 호스트가 이벤트를 아예 발행하지 않은 경우와 훅이 기록에 실패한 경우는 원장으로 구분되지 않는다(OB-24 의 `TaskCompleted` · `PermissionRequest`).
- 영수증은 끝난 세션만 덮는다. 현재 세션 922fad08 과 그 스폰은 이 창의 영수증 · 조인에 없다.
- GA-02 표본의 "리더가 `/model-routing resolve` 를 거쳤다" 는 기록이 없다. 규칙은 "요청 alias 가 기본값과 달랐고 그대로 서빙 · 과금됐다" 까지만 증명한다.
- transcript 스캔(09:54Z · 10:00Z)은 원장 사본(09:47Z)보다 늦다. 그 사이 WebFetch 가 있었다면 두 쪽이 어긋날 수 있으나 transcript 쪽도 0 이었다.

## 6. 미확인

- P0-16 I7 재측정(이 문서 범위 밖, 기존 증거 인용만).
- 창 안 14 영수증을 쓴 코드 버전(4.69.0 으로 보인다 — 추론).
- `PermissionRequest` · `TaskCompleted` 를 호스트가 이 창에서 발행했는지.
- CA-03 백로그 재판독(09-29 07:21Z)이 읽은 스토어 디렉터리.
- 원장 사본 개행 61,898 과 판독기 survivors 61,896 의 2행 차이 원인.
- `evidence/README.md` 표에 이 문서 행 추가 — 이 줄기의 소유 파일이 아니라 하지 않았다.

## 부록. 임시 스크립트 원문

모두 읽기 전용이다(입력 파일에 쓰지 않는다). 출력 파일은 세션 스크래치 디렉터리에만 썼다. A · B · E 는 실행본에서 판정에 쓰지 않은 진단 출력 줄(샘플 키 목록 등)만 뺐고, C · D 는 핵심부만 옮겼다.

### A. census.js — 원장 사본의 창 계수

```js
// read-only census over ONE ledger snapshot. usage: node census.js <ledger.jsonl> <sinceIso> <out.json>
const fs = require('fs');
const file = process.argv[2];
const since = process.argv[3];
const sinceMs = Date.parse(since);
const buf = fs.readFileSync(file);
const text = buf.toString('utf8');
const lines = text.split('\n');
let parsed = 0, bad = 0, blank = 0;
const rows = [];
for (const l of lines) {
  if (!l.trim()) { blank++; continue; }
  try { rows.push(JSON.parse(l)); parsed++; } catch { bad++; }
}
const win = rows.filter((r) => Date.parse(r.ts) >= sinceMs);
const inc = (o, k, n = 1) => { o[k] = (o[k] || 0) + n; };
const out = { input: file, bytes: buf.length, newlines: lines.length - 1, parsed, parseFail: bad, blank, since, runAt: new Date().toISOString(), windowRows: win.length };
out.firstTs = rows[0] && rows[0].ts; out.lastTs = rows[rows.length - 1] && rows[rows.length - 1].ts;
let maxTs = ''; for (const r of rows) if (r.ts > maxTs) maxTs = r.ts; out.maxTs = maxTs;
const ev = {}; for (const r of win) inc(ev, r.event); out.eventsInWindow = ev;
const rec = win.filter((r) => r.event === 'usage.receipt');
const rs = { n: rec.length, byModel: {}, byTier: {}, byCatalog: {}, costNonNull: 0, costNull: 0, byPricing: {}, bySource: {}, costSum: 0, sessions: {} };
const sonnetRows = [];
for (const r of rec) {
  const d = r.data || {}; const mi = d.model_identity || {};
  inc(rs.byModel, mi.model_id); inc(rs.byTier, mi.tier); inc(rs.byCatalog, mi.catalog_version);
  const c = d.cost || {};
  if (typeof c.total === 'number') { rs.costNonNull++; rs.costSum += c.total; } else rs.costNull++;
  inc(rs.byPricing, c.pricing_version); inc(rs.bySource, (d.usage || {}).source); inc(rs.sessions, r.session_id);
  if (mi.model_id === 'claude-sonnet-5-5') sonnetRows.push({ ts: r.ts, run_id: r.run_id || d.run_id, tier: mi.tier, catalog: mi.catalog_version, cost: c.total, pv: c.pricing_version, src: (d.usage || {}).source });
}
rs.sessions = Object.keys(rs.sessions).length;
out.receipts = rs; out.sonnetReceipts = sonnetRows;
out.sonnet55AllTime = rows.filter((r) => r.event === 'usage.receipt' && ((r.data || {}).model_identity || {}).model_id === 'claude-sonnet-5-5').length;
const se = win.filter((r) => r.event === 'session.ended');
const unres = {}; let seWithUnres = 0;
for (const r of se) { const u = (r.data || {}).unresolved_models; if (Array.isArray(u) && u.length) { seWithUnres++; for (const m of u) inc(unres, m); } }
out.sessionEnded = { n: se.length, withUnresolved: seWithUnres, unresolved: unres };
const rsel = win.filter((r) => r.event === 'route.selected');
const canary = {}; let canaryRows = 0; const actionClass = {};
for (const r of rsel) {
  const d = r.data || {}; const reasons = Array.isArray(d.reason) ? d.reason : (Array.isArray(d.reasons) ? d.reasons : []);
  const cs = reasons.filter((x) => typeof x === 'string' && x.startsWith('canary:'));
  if (cs.length) { canaryRows++; for (const c of cs) inc(canary, c); }
  inc(actionClass, d.action_class || d.actionClass || (d.classification && d.classification.actionClass) || 'none');
}
out.routeSelected = { n: rsel.length, canaryRows, canary, actionClass };
const hf = win.filter((r) => r.event === 'hook.fired');
const slots = {}; const slotHook = {};
for (const r of hf) { const d = r.data || {}; const s = d.slot || d.event || 'none'; inc(slots, s); for (const h of (d.hooks || [])) inc(slotHook, s + '::' + h); }
out.hookFired = { n: hf.length, slots }; out.hookFiredSlotHook = slotHook;
const su = win.filter((r) => r.event === 'state.updated');
const reasons = {}; for (const r of su) inc(reasons, (r.data || {}).reason || r.reason);
out.stateUpdated = { n: su.length, reasons };
const allLease = rows.filter((r) => r.event === 'state.updated' && ((r.data || {}).reason === 'split.lane-lease'));
out.laneLeaseAllTime = { n: allLease.length, last: allLease.length ? allLease[allLease.length - 1].ts : null };
const qg = win.filter((r) => r.event === 'adr.question_gate_evaluated');
const qgs = { n: qg.length, interpTrue: 0, requiredTrue: 0, status: {} };
for (const r of qg) { const d = r.data || {}; if (d.interpretation_present === true) qgs.interpTrue++; if (d.required === true) qgs.requiredTrue++; inc(qgs.status, String(d.interpretation_status)); }
out.questionGate = qgs;
out.claimAuditWindow = win.filter((r) => r.event === 'review.claim_audit').length;
out.claimAuditAllTime = rows.filter((r) => r.event === 'review.claim_audit').length;
out.routeBoundWindow = win.filter((r) => r.event === 'route.bound').length;
fs.writeFileSync(process.argv[4], JSON.stringify(out, null, 1));
```

### B. scan-meta.js — 호스트 meta · transcript 스캔

```js
// usage: node scan-meta.js <projectsSlugDir> <out.json> [sinceIso]
const fs = require('fs');
const path = require('path');
const root = process.argv[2];
const since = process.argv[4] ? Date.parse(process.argv[4]) : 0;
const res = { runAt: new Date().toISOString(), root, metas: [], agentCalls: [], sessionsScanned: 0, metaParseFail: 0, lineParseFail: 0 };
for (const sess of fs.readdirSync(root)) {
  const sd = path.join(root, sess, 'subagents');
  if (!fs.existsSync(sd) || !fs.statSync(sd).isDirectory()) continue;
  res.sessionsScanned++;
  for (const f of fs.readdirSync(sd)) {
    if (!f.endsWith('.meta.json')) continue;
    const id = f.slice('agent-'.length, -'.meta.json'.length);
    const mp = path.join(sd, f);
    const st = fs.statSync(mp);
    let meta;
    try { meta = JSON.parse(fs.readFileSync(mp, 'utf8')); } catch { res.metaParseFail++; continue; }
    const tp = path.join(sd, 'agent-' + id + '.jsonl');
    const served = {}; let firstTs = null, lastTs = null;
    if (fs.existsSync(tp)) {
      for (const l of fs.readFileSync(tp, 'utf8').split('\n')) {
        if (!l.trim()) continue;
        let r; try { r = JSON.parse(l); } catch { res.lineParseFail++; continue; }
        if (r.timestamp) { if (!firstTs || r.timestamp < firstTs) firstTs = r.timestamp; if (!lastTs || r.timestamp > lastTs) lastTs = r.timestamp; }
        if (r.type === 'assistant' && r.message && r.message.model) served[r.message.model] = (served[r.message.model] || 0) + 1;
      }
    }
    res.metas.push({ session: sess, id, agentType: meta.agentType, name: meta.name, model: meta.model, spawnDepth: meta.spawnDepth, parentAgentId: meta.parentAgentId, taskKind: meta.taskKind, served, firstTs, lastTs, metaMtime: st.mtime.toISOString() });
  }
}
for (const f of fs.readdirSync(root)) {
  if (!f.endsWith('.jsonl')) continue;
  const p = path.join(root, f);
  if (fs.statSync(p).mtimeMs < since) continue;
  for (const l of fs.readFileSync(p, 'utf8').split('\n')) {
    if (!l.includes('"tool_use"') || !l.includes('"Agent"')) continue;
    let r; try { r = JSON.parse(l); } catch { continue; }
    const c = r.message && Array.isArray(r.message.content) ? r.message.content : [];
    for (const b of c) if (b.type === 'tool_use' && b.name === 'Agent') res.agentCalls.push({ session: f.replace('.jsonl', ''), ts: r.timestamp, tool_use_id: b.id, name: b.input.name, subagent_type: b.input.subagent_type, model: b.input.model, description: b.input.description });
  }
}
fs.writeFileSync(process.argv[3], JSON.stringify(res, null, 1));
```

실행: `node scan-meta.js ~/.claude/projects/C--Users-HeechangLee-Desktop-AI-Artibot <out> 2026-09-29T00:00:00Z` → metas 617 · agentCalls 255 · 세션 56 · 파싱 실패 0.

### C. ga02.js — GA-02 규칙 적용(핵심부)

```js
// frontmatter tier: artibot:<name> -> <pluginRoot>/agents/<name>.md 의 첫 `model:` 값.
// 플러그인 접두가 없는 타입(general-purpose 등)은 frontmatter 없음 -> 부모(opus) 상속으로 비교.
const differs = requested !== undefined && ft.tier !== undefined && requested !== (ft.tier === null ? 'opus' : ft.tier);
const servedJoin = servedIds.includes('claude-sonnet-5-5');   // meta 의 transcript 서빙 id 가 영수증 model_id 와 같다
qualifies = differs && servedJoin;
// 분모: census.js 의 sonnetReceipts(창 안 claude-sonnet-5-5 영수증 14행), run_id 의 'agent-' 를 떼서 meta id 로 조인,
// Agent 호출은 같은 세션의 같은 name 으로 찾아 subagent_type 을 얻는다(14/14 에서 호출 1건씩).
```

### D. sh19.js · sh19b.js — SH-19 조인(핵심부)

```js
const hm = spawnRows.filter((r) => r.depth_source === 'host-meta');
// 행마다: meta = metaById[r.agentId]; depthMatch = meta.spawnDepth === r.depth;
//         parentMatch = (meta.parentAgentId || null) === (r.parent_agent_id || null)
nestedMatched = rows.filter((x) => x.depth >= 1 && x.parent_agent_id && x.parentMatch).length;   // 2
// caller 조인: route.selected.data.shadow_of 'tool_use:<id>' -> route.bound.data.tool_use_id === <id>
//              -> route.bound.data.agent_id -> meta.parentAgentId === route.selected.data.caller_agent_id
```

### E. tooluse.js — transcript tool_use 계수

```js
// usage: node tooluse.js <projectsSlugDir> <sinceIso>
const fs = require('fs');
const path = require('path');
const root = process.argv[2];
const since = process.argv[3];
const sinceMs = Date.parse(since);
const counts = {}; let files = 0, lines = 0;
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    if (!e.name.endsWith('.jsonl')) continue;
    if (fs.statSync(p).mtimeMs < sinceMs) continue;
    files++;
    for (const l of fs.readFileSync(p, 'utf8').split('\n')) {
      if (!l.includes('"tool_use"')) continue;
      let r; try { r = JSON.parse(l); } catch { continue; }
      if (!r.timestamp || r.timestamp < since) continue;
      lines++;
      const c = r.message && Array.isArray(r.message.content) ? r.message.content : [];
      for (const b of c) if (b.type === 'tool_use') counts[b.name] = (counts[b.name] || 0) + 1;
    }
  }
};
walk(root);
process.stdout.write(JSON.stringify({ runAt: new Date().toISOString(), since, files, lines, counts }) + '\n');
```

출력(2026-09-30T10:00:00.933Z): files 35 · lines 4,067 · Bash 2,068 · Edit 731 · Read 401 · Write 217 · PowerShell 137 · Grep 120 · SendMessage 47 · ToolSearch 32 · Agent 29 · Monitor 17 · SubagentHandback 10 · Glob 6 · TaskStop 4 · Skill 2 · ListAgents 1. WebFetch 0.

### F. misc.js · lease2.js · rvg.mjs (요지)

- `misc.js`: 원장 사본에서 `hook.fired` 중 `data.slot` 이 직접 슬롯 10종(PreToolUse · PostToolUseFailure · Notification · InstructionsLoaded · SubagentStart · TeammateIdle · TaskCompleted · PermissionRequest · PreCompact · PostCompact)인 첫 행과 날짜별 수, `interpretation_status` 를 가진 첫 행, 스폰 원장 사본의 `requestedModel` non-null 수를 센다.
- `lease2.js`: 상태 스토어 사본의 `task_leases` 아래에서 `heartbeat_at` 을 가진 객체와 `task_graphs` 아래 `heartbeat_source` 값을 모은다.
- `rvg.mjs`: 세션 스토어 디렉터리의 `*.json` 을 파싱해 `censusReportVerifyEvidence(states, { nextTarget, phases: PHASES })` 에 넘긴다(`nextTarget` · `PHASES` 는 `plugins/artibot/lib/autopilot/engine-state.js` 에서 import).
