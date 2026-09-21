---
description: (Artibot) 재부팅·세션 종료 직전 단일 핸드오프 저장 — 다음 세션 5초 컨텍스트 복원
argument-hint: '[--keep N] [--prune] [--quick] [--no-advisor]'
allowed-tools: [Read, Write, Bash, Glob, Grep, TaskList, TaskGet]
toolset: team
---

# /save

재부팅이나 컨텍스트 윈도우 한계로 세션을 끊기 직전에 단 하나의 명령으로 다음 세션의 5초 컨텍스트 복원을 위한 핸드오프 마크다운을 생성합니다. `git status` · `git log` · 미해결 결정 · WIP 커밋 · 테스트 상태 · advisor 신호 · TaskList를 병렬 수집해 `.artibot/HANDOFF.md` 한 파일에 합성·회전 보관합니다.

**핸드오프 저장만 하는 게 아니라 커밋·푸시 동기화 상태도 함께 점검합니다.** 미커밋 변경, 미푸시 커밋(ahead), pull 필요(behind), GitHub 지연일수, 그리고 "다른 컴퓨터에서 작업했는데 푸시를 깜빡한" 케이스를 휴리스틱으로 감지해 유실 위험을 표면화합니다. push/commit 같은 쓰기 액션은 **절대 자동 실행하지 않고** 사용자에게 단계별로 확인을 받습니다.

Also routed from: 자연어 "저장해줘", "재부팅 전에 정리", "다음 세션 핸드오프", "컨텍스트 정리"

## Arguments

Parse $ARGUMENTS:
- `--keep N`: 회전 보관 개수 (기본 30). `.artibot/handoffs/` 아래 `YYYY-MM-DD-HHMM.md` 형태로 아카이브 (같은 분 충돌 시 `-2`, `-3` 접미사). git 추적 아카이브는 개수에서 자리를 차지하되 절대 삭제되지 않음
- `--prune`: 이번 저장 후 강제로 회전 prune 한 번 더 수행 (사용자 명시적 청소)
- `--quick`: advisor 흡수 단계 스킵 — 30초 미만 모드. 핸드오프만 작성, 마킹 안 함
- `--no-advisor`: advisor `markConsumed` 호출 스킵 (`--quick` 의 부분집합 별칭. 회전·다른 단계는 정상 실행)
- `--dry-run`: 수집·합성까지만 수행하고 디스크 쓰기는 생략. stdout으로 미리보기

## Execution Flow

### Phase A: 병렬 수집 (~3s)

모두 한 메시지에서 동시 실행. 어떤 호출이든 throw 가능하지만 `collectHandoffData` 내부에서 best-effort로 흡수 — 다음 단계는 부분 결과로도 진행:

1. **Git 상태 + 동기화**: `git status --porcelain`, `git rev-parse --abbrev-ref HEAD`, `git rev-parse --short HEAD`. 추가로 `collectGitState` 가 동기화 신호도 수집:
   - upstream 존재: `git rev-parse --abbrev-ref --symbolic-full-name @{u}` (없으면 ahead/behind 스킵)
   - 미푸시(ahead): `git rev-list --count @{u}..HEAD`
   - pull 필요(behind): `git rev-list --count HEAD..@{u}`
   - 로컬 HEAD 시각: `git log -1 --format=%ct HEAD`
   - upstream(origin) tip 시각: `git log -1 --format=%ct @{u}` (마지막 fetch 기준 — 네트워크 호출 없음)
   - 이 값들로 `deriveGitSyncStatus(gitState, { now })` 가 dirty/ahead/behind/staleDays/githubLagDays/otherMachineRisk 와 경고·권장액션을 합성
2. **최근 커밋**: `git log -10 --format='%h|%s|%ar'`
3. **WIP 카운트**: `lib/autopilot/wip-stats.js` 의 `countWipCommits` + `getOldestWipAgeMs`
4. **테스트 상태**: `lib/core/test-status.js` 의 `getLastTestStatus`
5. **Advisor 신호**: `lib/learning/auto-spawn-advisor.js` 의 `readPendingSuggestions` (consumed/resolved 제외)
6. **세션 메모리**: 최근 5개 키워드 (recallSessionMemory)
7. **TaskList**: TaskList tool → 미완료 작업 + in_progress

### Phase A½: 체크포인트 (§31 순서 · runtime.checkpoint.saveOnSave 가 true 일 때만)

이 단계는 runtime.checkpoint.saveOnSave 가 true 일 때만 실행된다. 이 키는 현재 `artibot.config.json` 에 **`false` 로 있다** — false(그리고 부재)는 이 단계를 통째로 스킵하고 출력 표에 "스킵(config off)" 1행만 남긴다. 되돌리기도 이 config 한 줄이다 (Canary, DESIGN §4). 게이트 판정은 `lib/checkpoint/save-checkpoint.js` 의 `isSaveCheckpointEnabled(config)` 가 단독으로 내린다 (엄격 boolean — `true` 아닌 값은 전부 false).

§31 순서대로 8단계이며, 오늘 실제로 도는 것과 부재인 것을 그대로 적는다:

1. **Flush artifacts** — `lib/runtime/artifact-lifecycle.js` 가 담당하며 게이트는 `runtime.artifactLifecycle.enabled` (artifact-lifecycle.js:212 `APPLY_GATE_PATH`). `.artibot/missions` 가 없으면 no-op.
2. **Task Graph** — `store.getTaskGraph(missionId)` (lib/project-state/state-manager.js:429). `active_tasks` = status 가 `done` 이 아닌 task id 목록.
3. **State** — `store.getMission(missionId)` (state-manager.js:428) 의 `intent.revision` · `plan.revision` 을 `intent_revision` · `plan_revision` 으로 사상. 값이 없으면 **위조하지 않는다** — validate 가 거부한 사유를 그대로 표기한다.
4. **Epoch** — 부재. epoch 회전 연산이 없으므로 `routing_epoch: null` 로 기록한다.
5. **Checkpoint** — `createCheckpointService({ store, appendEvent: null })` (lib/checkpoint/checkpoint-service.js:150) 의 `checkpoint(content, { trigger: '/save' })`. store 는 `createCheckpointStore({ adapter: createFileStoreAdapter({ dir }) })` (checkpoint-store.js:162 · adapters/file-store.js:113), `dir` 는 `resolveStoreLocation({ projectRoot, gitCommonDir }).dir` (lib/project-state/store-location.js:57). `appendEvent` 는 **반드시 null** — 원장 기록은 7단계에서 조립 모듈이 직접 한다 (리더 결정 ca05-2).
6. **Validate resume** — `buildResumeReport({ latestValid, getMission, getTaskGraph }, { missionId })` (lib/checkpoint/resume-controller.js:542) 를 report-only 로 호출. `resumable` 은 상태를 바꾸지 않고 출력 표에만 쓴다. 오늘 배선은 위 3포트만 주입하므로 report 의 7·8·9단계(lease·ledger reconcile·model)가 unknown 으로 막혀 `resumable` 은 **항상 ✗** 다 — 결함이 아니라 포트 부재의 정직한 값이며, 체크포인트 저장·원장 기록은 그와 무관하게 이뤄진다.
7. **Ledger** — 조립 모듈이 `appendLedgerEvent(projectRoot, { event:'mission.checkpointed', source:'supervisor', data:{ checkpoint_id, trigger:'/save', resumable } })` (lib/runtime/ledger.js:81) 를 호출한다. `source` 는 allowlist 상 `supervisor` 다 (리더 결정 ca05-1 — `save` 는 allowlist 밖이라 `ledger.rejected` 로 강등된다).
8. **Snapshot Scorecard** — 원장을 fold 한 세션 카드(§35)를 `/save` 출력 **맨 아래**(`## 권장 첫 프롬프트` 뒤) 한 절로 인쇄한다. 2~7단계와 달리 `buildSaveCheckpoint` 밖의 별도 읽기 사슬이고 세션 범위 읽기 전용 투영이라, 활성 mission 이 0건이어도(2~7단계가 `skip:no-active-mission`) 카드는 그대로 렌더한다. 카드를 스킵하는 사유는 둘뿐이다: config off · session 없음. 읽기 경로는 `/scorecard --session` 과 같은 것 하나이며 포트를 두 번 넘긴다: `lib/runtime/ledger.js#readAllEvents` → `lib/replay/load.js#loadReplay` (`readEvents` 포트 필수 — 빠뜨리면 던진다. 빈 배열 기본값으로 메우면 배선 오류가 "아무 일도 없던 실행"과 같은 출력이 되므로 일부러 fail-closed) → `lib/scorecard/session-scorecard.js#buildSessionScorecard`(replay, `{ session_id }`) → `lib/scorecard/render.js#renderScorecardMarkdown`(card). **카드는 저장하지 않는다** — 재생성 가능한 투영이고 정본은 원장 하나라서 `lib/scorecard/index.js` 헤더가 "이 디렉터리는 파일을 쓰지 않는다"를 계약으로 못박았다. `session_id` 는 아래 본문 규약(훅 payload 1순위 · env 폴백)을 그대로 쓰고, 비어 있으면 `buildSessionScorecard` 가 이유를 적어 던지므로 카드 절에 "스킵(session 없음)" 한 줄만 남긴다 — 범위 없는 카드를 만들어 원장의 모든 세션을 한 세션인 양 접지 않는다. 이 단계도 Phase A½ 안이라 `runtime.checkpoint.saveOnSave` 가 false 면 절 통째로 스킵된다. 분모 0 인 지표는 `unmeasured` 로 렌더되고 `0%` 로 쓰지 않는다.

2~7단계의 호출은 하나다: `buildSaveCheckpoint(ports, { sessionId, trigger:'/save' })` (8단계는 이 호출 밖의 별도 읽기 사슬이다 — 이 모듈은 scorecard 를 모른다). ports 는 `{ listActiveMissionIds, getMission, getTaskGraph, checkpointService, appendEvent }` 이고 `listActiveMissionIds = () => Object.keys(store.getState().active_missions)` — 활성 mission **전부**가 대상이다 (리더 결정 ca05-6(a)). 0건이면 `skip:no-active-mission` 이고 출력 표는 "스킵(활성 mission 없음)". `session_id` 는 훅 payload 가 1순위이고 env 가 폴백이며, 비어 있으면 `skip:session-missing` 이다 — mission_id·session_id 를 지어내지 않는다. 결과 행은 `{ mission_id, status: saved|rejected|skipped|errored, checkpoint_id, resumable, blocked_by, errors, ledger }`.

체크포인트 결과도 8단계 세션 카드도 HANDOFF 본문에 넣지 않는다 — `renderHandoffMarkdown` 출력 바이트는 불변이고, 결과는 `/save` 출력 표와 출력 맨 끝의 `## 세션 스코어카드` 절에만 나타난다.

스로틀은 없다 (ca05-7 미결). `/save` 를 연타하면 `mission.checkpointed` 가 건마다 남고 scorecard 분자(`lib/scorecard/session-scorecard.js`)가 그만큼 오른다.

### Phase B: 합성 (~0.5s)

1. **첫 프롬프트 후보 생성**: Phase A에서 모은 신호로 `lib/handoff/next-prompt-suggester.js` 의 `suggestFirstPrompts(signals, { max: 3 })` 호출. `signals` 는 실제 시그니처에 맞춰 `{ tasks, recentCommits, wip, gitStatus, unresolved, advisorSignals }` 로 구성 (`tasks`=TaskList 결과, `recentCommits`=git log 10개, `wip`=`{ count, oldestAgeMs }`, `gitStatus`=`{ untracked }`. `unresolved`/`advisorSignals` 는 현재 reserved). 반환 배열 `firstPrompts` = `[{ prompt, rationale, priority }]`.
2. `lib/handoff/handoff-builder.js` 의 `collectHandoffData({ pluginRoot, projectRoot, gitRunner, taskList, firstPrompts, now })` 호출 — Step 1에서 만든 `firstPrompts` 를 반드시 전달해야 §4·§6 이 채워짐 (생략 시 빈 배열 → "자동 생성됨" placeholder만 출력)
3. 결과를 `renderHandoffMarkdown(data, { now })` 로 GFM 마크다운 변환 (ANSI 금지)
4. 마크다운에 다음 8개 섹션 포함 (헤더 문자열은 `handoff-builder.js` `renderHandoffMarkdown` 출력과 정확히 일치):
   - `# HANDOFF — <timestamp>` 헤더 + `> 다음 P0: …` 요약 한 줄
   - `## 1. 지금 상태` — 브랜치, HEAD, 변경 파일 수, WIP, 테스트 + **`### Git 동기화 상태` 서브섹션**(커밋안됨/ahead/behind/upstream/GitHub 최신성/다른 머신 의심 표 + 경고 + 권장 액션). `renderSyncDashboard` 가 §1 내부에 출력하므로 기존 `## 1.`/`## 5.` 배너 정규식은 그대로 유지됨
   - `## 2. 이번 세션 한 일` — 최근 커밋 top 10
   - `## 3. 의도/현재 가설` — 다음 세션 시작 시 채우거나 git/task에서 추론
   - `## 4. 즉시 진행할 일` — `firstPrompts` 우선순위 표 (우선순위·항목·근거·예상)
   - `## 5. 미해결 결정/질문` — advisor pending + worklog 보류 + WIP advisory
   - `## 6. 다음 세션 첫 프롬프트 후보` — `firstPrompts` 1~3개 (priority + prompt + rationale)
   - `## 7. 컨텍스트 복원 핵심 파일` — 최근 변경된 핵심 파일 경로
   - `## 8. 메타` — 생성 시각·소요·sources

### Phase C: 저장 (~0.2s)

1. `lib/handoff/handoff-store.js` 의 `writeHandoff(markdown, { projectRoot, keep, now })` 호출
2. 반환: `{ latestPath, archivePath, pruned, throttled, protectedTracked, pruneSkipped }`
   - `latestPath`: `<projectRoot>/.artibot/HANDOFF.md` (덮어쓰기)
   - `archivePath`: `<projectRoot>/.artibot/handoffs/YYYY-MM-DD-HHMM.md` (회전)
   - `pruned`: 회전 정책으로 제거된 파일 개수
   - `throttled`: 직전 아카이브가 10분 이내라 새 파일 대신 제자리 갱신했으면 `true`
   - `protectedTracked`: `.artibot/handoffs/` 아래 git 추적 아카이브 개수 (전부 덮어쓰기·prune 면제)
   - `pruneSkipped`: git 워크트리인데 추적 집합을 읽지 못하면 `'git-unknown'` — 이 경우 덮어쓰기도 prune 도 하지 않았으므로 출력에 "추적 확인 불가 → 회전 스킵" 으로 명시. 정상이면 `null`
3. **저장 후 무결성 점검**: 같은 모듈의 `checkHandoffTrackedIntegrity(projectRoot)` 호출 → `{ inRepo, modified, deleted, error }`. `.artibot/handoffs` 의 M/D 를 출력에 한 줄로 표기하며 **반드시 0/0 이어야 함**. `inRepo=false` 면 "(git 아님)", `error` 가 있으면 "미확인" 으로 표기 — 0/0 으로 꾸미지 말 것
4. `--dry-run` 시 이 단계를 스킵하고 mock 결과로 진행
5. write 실패 시: 명시적 에러 출력 + advisor 흡수 단계 절대 실행 금지 (원자성 보장)

### Phase D: Advisor 흡수 마킹 (~0.1s)

`--quick` 또는 `--no-advisor` 시 스킵.

1. Phase A에서 모은 `advisorSignals` 의 id 배열 추출
2. `markConsumed(pluginRoot, ids, { now })` 호출 (lib/learning/auto-spawn-advisor.js)
3. 반환: `{ marked, skipped }`
4. write 가 성공한 경우에만 호출 — Phase C 실패 시 advisor 무손상

### Phase E: Git 동기화 액션 제안 (단계별 확인)

핸드오프는 이미 디스크에 저장됐으므로 이 단계는 **유실 방지를 위한 후속 제안**입니다. `data.gitSync.actions` 배열을 순회하며 사용자에게 하나씩 제안하되, 유저 선호(高위험 git 작업 = 단계별 확인)를 그대로 따릅니다:

1. **dirty (커밋 안 된 변경)** → "변경 N개를 커밋할까요?" 물어봄. 승인 시에만 `/git commit` 흐름 위임 (시크릿 스캔 포함).
2. **ahead (미푸시 커밋)** → "미푸시 커밋 N개를 GitHub에 푸시할까요?" 물어봄. **반드시 확인 후**에만 `git push origin <branch>`. 자동 강제 푸시 절대 금지.
3. **behind (pull 필요)** → "origin이 N개 앞서 있어요. 가져올까요(pull)?" 물어봄.
4. **otherMachineRisk (다른 머신 미동기화 의심)** → 쓰기 액션이 아니라 안내만: "로컬 HEAD가 오래됐고 워킹트리는 깨끗합니다. 다른 컴퓨터에 안 올라온 작업이 있을 수 있어요. `git fetch` 후 다른 머신 상태를 확인해 보세요." (이 케이스가 바로 '어제 다른 컴퓨터 작업이 GitHub에 없던' 사례)

`--quick` / `--dry-run` 시에는 액션을 제안만 하고 실행은 하지 않습니다. 동기화가 정상이면(`actions` 빈 배열 + `warnings` 빈 배열) "✅ 커밋·푸시 동기화 정상" 한 줄만 출력합니다.

### Phase F: 출력

박스 헤더 + 핵심 메트릭 + Git 동기화 대시보드 + 다음 P0 + 후속 액션 안내. ANSI 코드 절대 출력 금지.

## Output Format

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  HANDOFF SAVED                                          YYYY-MM-DD HH:MM    │
│  master @ a1b2c3d · .artibot/HANDOFF.md                                     │
└──────────────────────────────────────────────────────────────────────────────┘

## 저장 결과

| 항목 | 값 |
|------|-----|
| 핸드오프 파일 | `.artibot/HANDOFF.md` |
| 아카이브 | `.artibot/handoffs/2026-05-19-1144.md` (또는 "10분 이내 → 제자리 갱신") |
| 회전 후 보관 | N / keep=30 (prune N · 추적 보호 N) |
| 아카이브 무결성 | `.artibot/handoffs` M 0 / D 0 (git 아님 · 미확인 시 그대로 표기) |
| Advisor 흡수 | N marked / N skipped |
| WIP 커밋 | N (oldest ~Nh) |
| 미해결 결정 | N |
| 진행 중 작업 | N |
| 체크포인트 | M-… → cp-… (resumable ✓/✗) · 스킵(config off / 활성 mission 없음 / session 없음) · 거부(validate 사유) · 오류(threw:…) |

## Git 동기화 상태

| 점검 항목 | 상태 |
|---|---|
| 커밋 안 된 변경 | ⚠️ 예 (N개) / 아니오 |
| 미푸시 커밋 (ahead) | ⚠️ N / 0 |
| pull 필요 (behind) | ⚠️ N / 0 |
| upstream 추적 | 있음 / ⚠️ 없음 |
| GitHub 최신성 | ⚠️ ~N일 / 최신 |
| 다른 머신 미동기화 의심 | ⚠️ 예 / 아니오 |

> [!WARNING] 미푸시 커밋 N개 — GitHub에 아직 올라가지 않음
> [!WARNING] 로컬 HEAD가 N일 전인데 워킹트리는 깨끗 — 다른 컴퓨터의 미푸시 작업이 있을 수 있음

**권장 액션** (push/commit은 반드시 확인 후 실행):
- 변경 N개 커밋하기 _(확인 필요)_
- 미푸시 커밋 N개 푸시하기 _(확인 필요)_

> (동기화 정상 시) ✅ 커밋·푸시 동기화 정상 — 유실 위험 없음

## 다음 P0

> [P0 한 줄 요약 — 다음 세션에서 바로 이어갈 첫 액션]

## 권장 첫 프롬프트

1. [prompt 1]
2. [prompt 2]
3. [prompt 3]

## 세션 스코어카드

(8단계 산출. renderScorecardMarkdown 출력을 가공 없이 그대로 붙인다 — 아래 표는 열 모양을 보이는 자리 표시이며 실측 수치가 아니다. 렌더러는 본표 뒤에 `## 근거`·`## 미측정` 절을 항상 이어 내고, 분포가 있으면 본표와 `## 근거` 사이에 `## 분포` 도 낸다 — 잘라내지 말 것.)

# ARTIBOT · SESSION SCORECARD

- **session_id**: `<현재 세션 id>`

| 지표 | 값 | 분모 | 비율 | 미분류 | 상태 |
|---|---|---|---|---|---|
| [지표명] | [값 또는 unmeasured] | [분모] | [비율 또는 unmeasured] | [미분류] | [상태] |

> 스킵 시에는 이 절을 통째로 생략하고 "세션 스코어카드: 스킵(config off)" 또는 "스킵(session 없음)" 한 줄만 남긴다.

> 다음 세션: `/resume` 으로 전체 HANDOFF 복원 + 첫 프롬프트 확인.
```

## 회전 정책 (writeHandoff 내부)

- `latestPath` 는 항상 마지막 저장본으로 덮어씀 — `/resume` 의 단일 진입점
- `archivePath` 에 즉시 복사본 보존. 파일명 `YYYY-MM-DD-HHMM[-n].md` 의 스탬프가 정렬·나이 판정의 1차 키이고 mtime 은 스탬프가 없는 파일에만 쓰는 폴백 — 체크아웃·머지·워크트리 생성은 mtime 을 전부 새로 찍지만 파일명은 못 바꾸기 때문
- 스로틀: 최신 아카이브의 스탬프가 10분 이내면 새 파일 대신 제자리 갱신 (`ARTIBOT_HANDOFF_THROTTLE_MS`, 0 이면 끔). 창은 아카이브 생성 분에 고정되므로 10분 넘게 이어지는 연타는 새 파일로 넘어감
- 회전: 최신순 `keep` 개 밖의 아카이브 제거. prune 카운트는 출력에 명시
- **추적 파일 보호**: `git ls-files -- .artibot/handoffs` 로 추적 아카이브를 읽어 그 파일은 **절대 제자리 덮어쓰기·prune 대상이 되지 않음**. 제자리 갱신 대상은 이 저장소가 만든(스탬프 파일명) 미추적 파일뿐. git 워크트리인데 추적 집합을 못 읽으면(`pruneSkipped: 'git-unknown'`) 덮어쓰기·prune 둘 다 하지 않는 fail-closed. git 이 아닌 디렉토리는 종전 동작 그대로. 배경: 새 워크트리에서는 커밋된 옛 핸드오프가 mtime 상 "최신" 으로 보여 실측 3회 이상 ` M` / ` D` 로 잡혔음
- 포인터 `.artibot/HANDOFF.md` 는 추적 여부와 무관하게 항상 덮어씀 (설계)

## Anti-Patterns

- Do NOT 다시 `npm test` 를 실행하지 말 것 — `getLastTestStatus` 의 캐시값만 사용 (재실행은 30s+ 비용)
- Do NOT ANSI 색상/박스 escape 코드를 출력 마크다운에 섞지 말 것 — 출력 박스 헤더만 ANSI 허용, 본문은 순수 GFM
- Do NOT `writeHandoff` throw 시 advisor `markConsumed` 호출하지 말 것 — 원자성 위반
- Do NOT TaskList 실패를 silent하게 무시하지 말 것 — 빈 배열로 두되 본문에 `(작업 데이터 없음)` 명시
- Do NOT advisor 흡수 후에도 동일 신호가 다음 세션에 재출력되도록 두지 말 것 — `consumed: true` 마킹 필수
- Do NOT 5초 hook 제한 초과 가능성을 무시하지 말 것 — `/save` 자체는 명시적 명령이라 시간 제약 약하지만 800ms 안에 끝나도록 병렬화
- Do NOT push/commit/pull을 사용자 확인 없이 자동 실행하지 말 것 — `gitSync.actions` 는 *제안*이며 `confirm:true` 액션은 반드시 단계별 확인 후 실행 (유저 선호: 高위험 git 작업 단계별 확인)
- Do NOT `git fetch`/네트워크 호출을 `/save` 안에서 자동 수행하지 말 것 — upstream 시각은 마지막 fetch된 remote-tracking ref 기준으로만 비교(오프라인·빠른 저장 보장). fetch는 otherMachineRisk 안내문으로만 권고
- Do NOT 동기화 정상인데도 경고/액션을 출력하지 말 것 — clean 상태면 "✅ 커밋·푸시 동기화 정상" 한 줄로 끝낼 것
- Do NOT git 추적 아카이브를 제자리 덮어쓰거나 prune 하지 말 것 — `checkHandoffTrackedIntegrity` 의 M/D 가 0/0 이 아니면 그 자체가 결함이며 출력에서 숨기지 말 것
- Do NOT mission_id·session_id 를 위조해서 체크포인트를 만들지 말 것 — 없으면 스킵 행으로 표기 (MISSION_ID_RE 형식의 가짜 id 금지)
- Do NOT 세션 카드를 파일로 저장하지 말 것 — 원장을 fold 한 재생성 가능한 투영이며, 저장하면 원장 옆에 두 번째 진실원이 생긴다 (`lib/scorecard/index.js` 헤더 계약)
- Do NOT `session_id` 없이 카드를 만들지 말 것 — 범위 없는 카드는 전 세션을 한 세션인 양 접는다. 없으면 "스킵(session 없음)" 한 줄
- Do NOT 분모 0 지표를 `0%` 로 쓰지 말 것 — `unmeasured` 그대로 출력 (측정 안 함 ≠ 측정해서 0)
- Do NOT 체크포인트 단계가 HANDOFF 본문·handoff-store 추적 보호를 건드리게 하지 말 것 — 체크포인트 결과는 /save 출력 표에만 (DESIGN §31 "HANDOFF 렌더 그대로")

## Edge Cases

| 시나리오 | 처리 |
|----------|------|
| `.artibot/` 디렉토리 없음 | `writeHandoff` 가 mkdir -p 로 생성 |
| `pluginRoot` 미해석 | advisor 단계만 스킵, 핸드오프는 정상 작성 |
| `TaskList` 빈 결과 | `(작업 데이터 없음)` 으로 섹션 유지 |
| Not a git repo | 헤더에 `(git 정보 없음)` 표기, 다른 섹션 정상. 동기화 표는 모두 "아니오/0/없음"으로 안전 출력 |
| upstream 없음 (`@{u}` 미설정) | ahead/behind/GitHub지연 스킵, "upstream 추적: ⚠️ 없음" + `-u` 푸시 안내 |
| origin behind (push 누락 케이스) | "GitHub가 N일 전" + "ahead M개" 경고 + 푸시 권장 액션 (확인 필요) |
| clean tree + 오래된 HEAD | otherMachineRisk=true → "다른 컴퓨터 미푸시 작업 가능" 안내 + `git fetch` 권고 (쓰기 없음) |
| 오프라인 / fetch 안 됨 | upstream 시각이 stale → githubLagDays 과대평가 가능. 안내문에 "마지막 fetch 기준" 명시로 완화 |
| Advisor 파일 missing | `markConsumed` 가 `{marked:0, skipped:N}` 반환, 본문에 명시 |
| `writeHandoff` 디스크 풀 | 명시적 ERROR 출력, advisor 마킹 스킵 |
| `.artibot/handoffs/*.md` 가 git 추적됨 (새 워크트리·머지 직후) | 추적 파일은 덮어쓰기·prune 면제, 새 미추적 파일 생성. `protectedTracked` 개수 출력 |
| git 워크트리인데 `git ls-files` 실패 (인덱스 락·git 없음) | `pruneSkipped: 'git-unknown'` — 덮어쓰기·prune 모두 스킵하고 "추적 확인 불가" 명시 |
| `--dry-run` | 마크다운 stdout 출력, 디스크 쓰기/마킹 모두 스킵 |
| `runtime.checkpoint.saveOnSave` 부재/false | Phase A½ 통째 스킵, 표에 "스킵(config off)". 체크포인트·원장 쓰기 0건 |
| `active_missions` 비어 있음 | `skip:no-active-mission` → 표에 "스킵(활성 mission 없음)", `mission.checkpointed` 0건. 8단계 카드는 세션 범위라 그대로 렌더 |
| `session_id` 없음 (훅 payload·env 둘 다 빔) | 8단계 카드 절은 "스킵(session 없음)" 한 줄. 전 세션을 접은 카드를 만들지 않음 |
| 원장이 비어 있음 (설치본 미반영 등) | 카드는 정상 렌더되고 전 지표가 `unmeasured` — 결함이 아니라 분모 0 의 정직한 값 |

## Next Steps

작업 완료 후 추천 후속 액션:

| # | 액션 | 커맨드 | 설명 |
|---|------|--------|------|
| 1 | 다음 세션 복원 | `/resume` | 핸드오프 전체 복원 + 첫 프롬프트 후보 표시 |
| 2 | WIP 정리 | `/git` | 미커밋 변경사항 커밋 후 핸드오프 갱신 |
| 3 | WIP squash | `/squash` | 누적 WIP 커밋 squash 후 핸드오프 갱신 |
