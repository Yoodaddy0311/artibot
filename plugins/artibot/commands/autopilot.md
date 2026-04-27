---
description: (Artibot) Autonomous long-running mode with PRD-first workflow, parallel execution, cross-check, verification, and completion report
argument-hint: <task description> [--max 4h] [--budget 2000000]
allowed-tools: [Read, Write, Edit, Bash, Glob, Grep, Task, TaskCreate, TaskUpdate, TaskList, TeamCreate, SendMessage, TaskGet, TeamDelete]
toolset: team
---

# /autopilot

Autonomous long-running mode for **3~4시간 자리 비움 / 야간 자율 작업**. Runs Phase 0~6 (INTAKE → PLAN → EXECUTE → CROSS_CHECK → VERIFY → IMPROVE → REPORT) without user intervention. Pauses automatically on dangerous actions (PRD §5.5). DATA POLICY 엄격 준수 — 외부 DB / 외부 플러그인 / 외부 데이터 송신 금지.

## Subcommands

| 명령 | 설명 | Phase |
|------|------|-------|
| `/autopilot <task>` | 표준 자율 모드 (default) | 0~6 전체 + PushNotification |
| `/autopilot:night <task>` | 야간 모드 — 알림 차단, 질문은 큐로 누적 | 0~6 + 보고서로만 전달 |
| `/autopilot:plan <task>` | Dry-run — Phase 0(PRD) 만 생성 후 종료 | 0 only |
| `/autopilot:resume <session-id>` | 중단된 세션 이어가기 | last phase 부터 재진입 |
| `/autopilot:status [session-id]` | 진행 Phase / 큐 / 토큰 / 위험 상태 조회 | read-only |
| `/autopilot:abort <session-id>` | 마지막 SHA 보존 후 graceful shutdown | safety check 후 종료 |
| `/autopilot:tail [session-id] [--lines N]` | Live Telemetry — 마지막 N개 이벤트 표 출력 (기본 50, --follow 시 1초 폴링) | read-only |
| `/autopilot:list [--orphans]` | 활성 세션 + worktree + lock 상태 표 출력 | read-only |

## Common Options

| 플래그 | 기본값 | 설명 |
|--------|--------|------|
| `--max <duration>` | `4h` | 최대 실행 시간 (`30m`, `2h`, `8h` 등) |
| `--budget <tokens>` | `2000000` | 토큰 임계치, 초과 시 pause |
| `--no-notify` | off | 완료 알림 비활성화 |
| `--no-team` | off | 병렬 팀 비활성화 (단일 메인 실행) |
| `--checkpoint <interval>` | `30m` | 체크포인트(WIP commit) 주기 |
| `--worktree` | off | git worktree 격리 사용 (P0-3, 기본 브랜치: `autopilot/<sessionId>`) |
| `--detached` | off | worktree를 detached HEAD로 생성 (advanced) |
| `--mcp-verify` | off | Phase 4 VERIFY에서 자체 plugin MCP 화이트리스트 호출 (P0-4) |

## Arguments

Parse `$ARGUMENTS`:
- `task-description`: 자율 처리할 작업 설명 (필수, `:resume`/`:status`/`:abort` 제외)
- subcommand 접미어: `night` / `plan` / `resume` / `status` / `abort` / `list` 중 하나 (없으면 `default`)
- `--max`, `--budget`, `--no-notify`, `--no-team`, `--checkpoint`, `--worktree`, `--detached`: 위 표 참조
- `session-id`: `:resume` / `:abort` / `:status` 에서 사용 (`ap-YYYYMMDD-HHMMSS` 형식)

## Execution Flow (메인 Claude가 받았을 때 수행할 절차)

### Step 1 — Engine Import & Argument Parse

1. `lib/autopilot/index.js` 동적 import (Windows 한글 경로는 `lib/core/utils/index.js`의 `toFileUrl()` 사용):
   ```js
   const engine = await import(toFileUrl('plugins/artibot/lib/autopilot/index.js'));
   ```
2. `$ARGUMENTS` 파싱하여 `{ task, mode, options }` 분해:
   - `mode`: `default` | `night` | `plan` | `resume` | `status` | `abort`
   - `options`: `{ maxDuration, budget, notify, team, checkpoint }`
   - `sessionId`: `:resume`/`:status`/`:abort` 인 경우만

### Step 2 — Mode Dispatch

| mode | 호출 | 다음 단계 |
|------|------|-----------|
| `default` / `night` / `plan` | `engine.startAutopilot({ task, mode, options })` → `{ sessionId, prdPath, instruction }` | Step 3 (Phase 진행) |
| `resume` | `engine.resumeAutopilot(sessionId)` → `{ phase, status, instruction }` | Step 3 (재진입 Phase 부터) |
| `status` | `engine.getStatus(sessionId?)` → `SessionState` | 상태 표 출력 후 종료 |
| `abort` | `engine.abortAutopilot(sessionId, { graceful: true })` → `AbortResult` | 결과 표 출력 후 종료 |
| `tail` | `engine.readEvents(sessionId, { tail: lines })` → `Event[]` | 이벤트 표 출력 후 종료 (PRD v4.1 P0-2 Live Telemetry) |
| `list` | `engine.listActiveWorktrees()` + `engine.listSessions()` 조합 → GFM 표 출력 후 종료 |

### Step 3 — Phase Execution Loop

엔진이 반환한 `instruction` 객체를 따라 **Phase 0 ~ 6을 순차 실행**한다. 각 Phase 완료 시 `engine.recordPhaseResult(sessionId, phase, result)`로 session-store 업데이트.

#### Phase 0 — INTAKE (PRD 생성)
- `Task(subagent_type="artibot:planner", model="opus", prompt="[Autopilot Phase 0] 사용자 요청: {task}\n\n`docs/PRD/<feature>-<sessionId>.md` 작성. PRD 템플릿: 배경/목표/비목표/시나리오/설계/산출물/실행계획/위험/수락기준")`
- `mode === 'plan'`: PRD 경로 보고 후 종료. `:resume <sessionId>` 안내.

#### Phase 1 — PLAN
- `Task(subagent_type="artibot:planner", model="opus", prompt="[Autopilot Phase 1] PRD: {prdPath}\n\n분해 + 위험 식별 + 병렬 팀 구성 제안")`

#### Phase 2 — PARALLEL EXECUTE
- `--no-team` 미설정 시: `TeamCreate(team_name="autopilot-{sessionId}", description="{task}")` → 병렬 `Task()` 스폰.
- 30분(또는 `--checkpoint`)마다 WIP commit: `git commit -m "wip(autopilot): phase2 checkpoint {sessionId}"`. SHA를 `engine.recordCheckpoint(sessionId, sha)`로 기록.

#### Phase 3 — CROSS_CHECK
- 팀원 간 원형 검증 (A→B→C→A). 추가로 `Task(subagent_type="artibot:spec-reviewer", model="sonnet")` 소환.

#### Phase 4 — VERIFY
- `Bash("npm run ci")` 실행. 실패 시 `engine.classifyFailure(error)` → `build-error-resolver` 자동 소환. **3회 재시도 후에도 실패하면 PAUSED**.

#### Phase 5 — IMPROVE
- 병렬 소환: `Task(subagent_type="artibot:refactor-cleaner")` + `Task(subagent_type="artibot:performance-engineer")`. 결과는 보고서 §7~8.

#### Phase 6 — REPORT
- `Task(subagent_type="artibot:doc-updater", model="sonnet", prompt="[Autopilot Phase 6] reports/AUTOPILOT/{sessionId}.md 작성. 템플릿: PRD §13.5 (요약/PRD링크/Phase표/커밋SHA/Cross-check/검증/개선/미래/큐/Next)")`
- `engine.notifyCompletion(sessionId)` 호출 (`--no-notify` 시 skip, `night` 모드는 PushNotification 차단).

### Step 4 — PAUSED Handling

각 Phase 후 `engine.shouldPause(state)` 확인. `true`면:
1. 사용자 메시지를 `state.queuedQuestions[]` 에 푸시.
2. `mode === 'night'`: 큐만 누적, 다음 Phase 진행 또는 `Phase 6`로 점프 (위험도에 따라).
3. `mode === 'default'`: 즉시 종료 + 사용자 알림 (단, `dangerous` 위험은 모든 모드에서 종료).

### Step 5 — Completion

Phase 6 완료 후:
- `engine.notifyCompletion(sessionId)` 호출.
- 보고서 경로 + 큐된 질문 요약을 사용자에게 출력.

### `/autopilot:tail` Live Telemetry (PRD v4.1 P0-2)

야간 무개입 자율 모드의 black-box 문제 해소용. 각 Phase 진입/종료, pause, abort 시점에 `runtime/autopilot/<sessionId>.events.ndjson` 으로 한 줄 JSON 이 append 되며, 본 서브커맨드로 tail 조회한다.

1. `sessionId` 미지정 시 `engine.getStatus()` 로 가장 최근 세션 자동 선택.
2. `engine.readEvents(sessionId, { tail: lines })` 호출 (기본 `lines=50`).
3. 결과를 GFM 표로 출력:

| ts | phase | type | level | message |
|----|-------|------|-------|---------|
| 2026-04-27T... | INTAKE | phase-start | info | Phase 0 INTAKE 시작 |
| ... | ... | ... | ... | ... |

4. `--follow` 옵션 사용 시 `engine.tailEventsStream(sessionId)` 로 1초 폴링하며 새 이벤트를 한 줄씩 추가 출력. AbortSignal 로 중단 가능.

DATA POLICY: ndjson 파일은 로컬에만 존재. 외부 송신 없음.

## Multi-session Orchestration (P0-3)

`--worktree` 옵션 시 git worktree로 세션 격리 + 파일 lock으로 동시 N 자율 세션 안전 운영.

### 동작

1. Phase 2 EXECUTE 시 `createWorktree(sessionId)` → `runtime/autopilot/worktrees/<sessionId>` 또는 ASCII tmpdir(한글 cwd 회피)
2. 기본 branched: `autopilot/<sessionId>` 브랜치 생성. `--detached` 시 detached HEAD
3. featureKey 단위 lock — 동일 feature에 동시 진입 시 두 번째 세션은 `ok=false` + holder 정보
4. abort 시 worktree 자동 제거 + lock 자동 해제 (best-effort)

### 한계

- 한글 cwd 환경에서 worktree path는 ASCII tmpdir fallback (사용자 작업디렉토리 외부)
- worktree 생성 실패 시 graceful fallback (워크트리 미사용 + warn 텔레메트리)
- pruneOrphans는 startup 권장 (`/autopilot:list --orphans`로 확인)

### `/autopilot:list` 출력 예시

| sessionId | mode | phase | worktree | lock | branch |
|-----------|------|-------|----------|------|--------|
| ap-20260427-130421 | night | EXECUTE | runtime/autopilot/worktrees/ap-... | locked | autopilot/ap-... |
| ap-20260427-110001 | default | COMPLETED | (none) | (released) | - |

`--orphans`: session-store에는 없지만 worktree 디렉토리만 남은 항목 표시

## MCP-driven Verification (P0-4)

`--mcp-verify` 옵션 시 Phase 4 VERIFY에서 Artibot 자체 plugin MCP 만 화이트리스트 호출.

### 화이트리스트 정책
- **허용**: `plugin:artibot:` 접두사 + `[a-z0-9-]+` (예: `plugin:artibot:playwright`, `plugin:artibot:context7`)
- **차단**: 외부 / 제3자 MCP, 위장된 접두사 (`plugin:artibot-X:Y` 등)
- **응답 검증**: 외부 HTTP URL / Public IP / 클라우드 호스트 / outbound POST / shell exfil 흔적 자동 감지

### DATA POLICY
- 외부 host로 데이터 송신/수신 일체 금지
- `validateMcpResponse`가 5종 정규식으로 위반 즉시 abort
- base64 1단계 디코드 후 재검사로 우회 차단

## Safety Policy (PRD §5.5)

| 위험 | 정책 |
|------|------|
| `force-push`, `branch -D`, `db drop`, `rm -rf /` 패턴 | **무조건 pause** (모든 모드) + 큐에 사유 기록 |
| 외부 API key / secret 노출 의심 | 즉시 pause + `engine.recordSecretLeak()` |
| 외부 DB / 외부 플러그인 / 외부 데이터 송신 시도 | DATA POLICY 위반 → 즉시 abort + 보고 |
| 테스트 5회 연속 실패 | pause + 디버그 로그 보존 |
| 빌드 실패 3회 재시도 | pause + 마지막 정상 SHA 복원 제안 |
| context window > 85% | 자동 strategic-compact + checkpoint |
| 제한시간 초과 (`--max`) | 진행 상태 freeze + Phase 6 보고서 작성 후 종료 |
| 토큰 예산 초과 (`--budget`) | 동일 (freeze + 보고서) |

## Config

`artibot.config.json` → `autopilot` 섹션 참조 (`enabled`, `defaultMode`, `limits`, `safety`, `phases`, `paths`, `notification`).

비활성화: `--no-autopilot` 플래그 또는 config `autopilot.enabled: false`.

## Output Format

**세션 시작 시**

| 항목 | 값 |
|------|-----|
| Session ID | ap-YYYYMMDD-HHMMSS |
| Mode | default / night / plan |
| Task | {요약} |
| PRD | {prdPath} |
| Max | {duration} / {budget} tokens |

**Phase 진행 표 (`:status` 또는 보고서)**

| Phase | 상태 | 소요 | 변경 파일 | 검증 |
|-------|------|-----|----------|------|
| 0 INTAKE | DONE | 2m | docs/PRD/... | - |
| 1 PLAN | DONE | 3m | - | - |
| 2 EXECUTE | IN_PROGRESS | 14m | 7 | - |
| ... | ... | ... | ... | ... |

**완료 시**: `reports/AUTOPILOT/<sessionId>.md` 경로 + Phase 표 + 큐된 질문 + Next Action.

## Anti-Patterns

- 메인 Claude가 직접 구현 (Phase 2는 반드시 팀원 위임)
- safety guard 스킵 (`engine.shouldPause()` 무시)
- PRD 없이 Phase 1로 점프 (Phase 0 강제)
- 외부 데이터 송신 (DATA POLICY 위반)
- 사용자 명시 승인 없이 destructive action 수행
- session-store 업데이트 누락 (resume 불가능해짐)

## Next Steps

| # | 액션 | 커맨드 | 설명 |
|---|------|--------|------|
| 1 | 보고서 확인 | `cat reports/AUTOPILOT/<sessionId>.md` | Phase별 결과 + 개선 제안 |
| 2 | 큐된 질문 처리 | `/autopilot:status <sessionId>` | 누적 질문/위험 검토 |
| 3 | 변경 커밋 | `/git` | autopilot 세션 결과 정리 commit |
| 4 | 미래 작업 진행 | `/autopilot <next-task>` | Phase 5에서 도출된 미래 발전안 실행 |
