---
description: (Artibot) Autonomous long-running mode with PRD-first workflow, parallel execution, cross-check, verification, completion report, and an opt-in fast fan-out profile
argument-hint: <task description> [--max 4h] [--budget 2000000] [--fast|-fast] [--no-tui]
allowed-tools: [Read, Write, Edit, Bash, Glob, Grep, Agent, TaskCreate, TaskUpdate, TaskList, SendMessage, TaskGet, Workflow]
toolset: team
---

# /autopilot

Autonomous long-running mode for **3~4시간 자리 비움 / 야간 자율 작업**. Runs Phase 0~6 (INTAKE → PLAN → EXECUTE → CROSS_CHECK → VERIFY → IMPROVE → REPORT) without user intervention. Pauses automatically on dangerous actions (PRD §5.5). DATA POLICY 엄격 준수 — 외부 DB / 외부 플러그인 / 외부 데이터 송신 금지.

## Recommend-hint Reception

When the prompt contains `[artibot:hint recommend=autopilot]`, surface to the user: "자리 비우셔도 되면 오토파일럿으로 돌릴 수 있어요." and wait for confirmation before starting a session. This is advisory — see `CLAUDE.md` "Recommend-hint surfacing rule" and `docs/ORCHESTRATION-ROUTING.md`.

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
| `/autopilot:replay <session-id>` | 과거 세션 phase timeline 표 출력 (events.ndjson 집계 — 소요/이벤트/warn/error/retry/bottleneck) | read-only |
| `/autopilot:diff <session-id>` | 과거 세션 phase별 git diff 요약 표 출력 (checkpoint SHA 경계 간 `git diff --numstat` 집계 — files/+ins/-del/top changes) | read-only |
| `/autopilot:tui [session-id]` | 실행 중인 세션의 라이브 TUI 대시보드 attach (phase progress / 토큰 / 큐 / 최근 이벤트, 1초 폴링). 기본 default 모드는 자동 시작 — 본 커맨드는 detached 세션 재attach 용도 | read-only |
| `/autopilot:list [--orphans]` | 활성 세션 + worktree + lock 상태 표 출력 | read-only |
| `/autopilot:goal status <session-id>` | **v4.6.0 Phase 3** — Goal Contract 상태 조회 (paused, iterations, lastEvaluation, lastAction) | read-only |
| `/autopilot:goal pause <session-id> [--reason "..."]` | Goal evaluator만 일시정지 (세션은 계속 실행). EVALUATE → REPORT pass-through | mutate (orthogonal to session pause) |
| `/autopilot:goal resume <session-id>` | Goal evaluator 재개. 다음 EVALUATE 진입 시 정상 평가 | mutate |
| `/autopilot:goal retry <session-id> [--no-reset]` | 재평가 강제 — 기본 `goalIterations=0`으로 리셋. `--no-reset` 시 카운터 유지 | mutate |
| `/autopilot:goal clear <session-id>` | Goal Contract 제거 → legacy 7-phase 흐름으로 복귀 | mutate |

## Common Options

| 플래그 | 기본값 | 설명 |
|--------|--------|------|
| `--max <duration>` | `4h` | 최대 실행 시간 (`30m`, `2h`, `8h` 등) |
| `--budget <tokens>` | `2000000` | 토큰 임계치, 초과 시 pause |
| `--no-notify` | off | 완료/pause/iteration/danger 알림 비활성화 (`notifyDanger`만 안전 직결 시 예외 발사) |
| `--no-tui` | off | default 모드의 라이브 TUI 자동 렌더 비활성 (night 모드는 자동 off) |
| `--no-team` | off | 병렬 팀 비활성화 (단일 메인 실행) |
| `--fast` / `-fast` | off | **Fast fan-out profile** — 동의어이며 모두 내부 `options.fast = true`로 정규화된다. PLAN의 의존성 그래프에서 검증된 독립 작업만 최대한 동시 실행한다. 안전한 병렬 구간이 없으면 표준 경로로 폴백하며, 속도 배수는 보장하지 않는다. **`--worktree`와 함께 지정해야 한다** — fan-out은 고정 integration 기준점을 요구하므로, `--worktree` 없이 `--fast`만 주면 엔진이 `no-integration-worktree`로 **표준 경로에 강등**한다(경고 텔레메트리 1줄만 남고 병렬 실행은 일어나지 않는다). 상세는 아래 "Fast Fan-out Profile" 섹션 참조 |
| `--checkpoint <interval>` | `30m` | 체크포인트(WIP commit) 주기 |
| `--worktree` | off | git worktree 격리 사용 (P0-3, 기본 브랜치: `autopilot/<sessionId>`) |
| `--runner [team\|dynamic]` | `team` | **ADR-003** — Phase 2 EXECUTE 러너 수동 선택. `dynamic` = 하네스 `Workflow` 도구 스크립트 런(결정론, 동형 반복 작업용). 명시 지정은 항상 최우선(Stage 2 자동선택도 무시). 세션 시작 시 1회 고정 — resume에서 재평가 없음 |
| `--detached` | off | worktree를 detached HEAD로 생성 (advanced) |
| `--mcp-verify` | off | Phase 4 VERIFY에서 자체 plugin MCP 화이트리스트 호출 (P0-4) |
| `--goal "<stopping-condition>"` | off | **v4.6.0 Goal-driven mode** — verifiable stopping condition shorthand. PRD에 `## 2.5 Goal Contract` JSON 블록으로 삽입되며 Phase 5 후 evaluator가 `validationCommand` 결과로 자동 종료 결정. 미충족 시 Phase 2로 재진입 (cap = maxIterations, default 3, hard 10). |
| `--validation-command <cmd>` | `npm run ci` | Goal Contract의 `validationCommand` 오버라이드. evaluator가 exit code 0 → met 판정. |
| `--max-iterations <n>` | `3` | Phase 2 → 5 → evaluator 재진입 횟수 cap. 1~10 범위. |
| `--keep-awake` / `--no-keep-awake` | `--keep-awake` (on) | OS sleep 방지 (Win SetThreadExecutionState / macOS caffeinate / Linux systemd-inhibit). 세션 시작 시 acquire, 완료/abort 시 release. |
| `--keep-display` | off | 모니터까지 켜둠 (배터리 소모↑). 기본은 시스템만 깨움(디스플레이는 OS 설정대로 어두워질 수 있음). |

## Fast Fan-out Profile (`--fast` / `-fast`)

`--fast`와 호환 별칭 `-fast`는 모두 `options.fast = true`로 정규화된다. Fast는 "더 많은 에이전트" 자체가 아니라 **의존성 그래프의 독립 wave를 가능한 범위까지 동시에 처리**하는 opt-in 실행 프로필이다. 목표는 총 경과 시간을 줄이는 것이며, 모든 작업을 무리하게 병렬화하거나 10배 속도를 약속하지 않는다.

**설계 선택:** 독립 Fast 명령은 만들지 않는다. PRD, 동의, budget, pause/resume, checkpoint, rollback, report를 중복 구현하면 세션 복구 경계가 갈라지므로, `/autopilot -fast`와 `/autopilot --fast`가 같은 lifecycle 안에서 실행 프로필만 바꾸는 편이 더 안전하고 운영 효율적이다.

### 체감 차이 — 표준 vs `--fast`

| 관점 | 표준 Autopilot | `--fast` / `-fast` Autopilot |
|------|----------------|--------------------|
| Phase 2 실행 | 팀이 작업을 판단해 병렬화 | PLAN의 독립 wave를 먼저 만들고 가능한 작업을 한꺼번에 fan-out |
| 동시성 | 작업 중 동적으로 결정 | `min(적격 작업 수, availableParallelism × agentsPerCpu, agent 상한 16, worktree 상한 12)`에서 **계획** — 수치는 planned telemetry에 기록 |
| 파일 격리 | 요청 시 세션 단위 `--worktree` | wave별 worker worktree를 계획(최대 12개). `--worktree` 조합 시 세션 integration worktree의 고정 cwd/base SHA를 각 worker 기준점으로 전달하고, 실제 worker 생성·정리·통합은 실행 driver가 수행 |
| 짧아지는 구간 | 일반 병렬 팀의 이득 | 서로 독립적인 구현·테스트·문서 작업이 많은 Phase 2. 예: 8개가 각각 10분 걸리고 병합 비용이 작으면 순차 80분 대신 약 10~20분 + 통합 시간으로 단축될 수 있음 |
| 그대로 직렬인 구간 | 계획, 최종 병합, 전체 CI, 위험 작업 | 동일 — 충돌 해결과 전체 검증은 안전을 위해 직렬 유지 |
| 비용·자원 | 기본 팀 사용량 | 동시 에이전트·worktree·토큰 사용량 증가 가능. token budget과 agent/worktree cap을 유지하고, 디스크 부족 시 driver가 표준 경로로 폴백 |
| 속도 약속 | 작업 형태에 따라 다름 | **최소 10배를 보장하지 않음.** 동등 길이 작업의 계획상 추정치만 기록하며, 실제 측정·보고는 실행 driver의 책임 |

따라서 `--fast`의 이득은 **같은 DAG wave에서 파일 소유권이 겹치지 않는 작업 묶음**에서 가장 크다. 한 파일을 함께 고치거나, 의존성 사슬이 길거나, 전역 CI가 병목이면 wave 수가 늘거나 직렬 실행되어 체감 속도는 제한된다.

### 실행 계약

1. **PLAN이 DAG를 만든다.** 각 후보 작업은 안정적인 ID, `dependsOn`/`dependencies`, `independent`, `affectedPaths`, risk, worktree 적격 여부를 기록하고 `state.fastTasks`에 보존한다. 엔진은 준비된 작업만 위상 wave로 묶고, 같은 wave에서 파일 소유권이 겹치면 conflict group으로 직렬화한다.
2. **증명된 작업만 fan-out한다.** low/medium risk, repo-relative `affectedPaths`, `independent: true`, `worktreeEligible: true`인 작업만 fast wave에 들어간다. 선행 작업이 끝난 의존 작업은 다음 wave에서 실행할 수 있다. ID 누락·중복, 미해결 의존성, cycle, fast 비적격 선행 작업, 위험/불명 경로는 사유와 함께 직렬 큐로 보낸다.
3. **세션 integration과 worker를 분리한다.** `--fast --worktree` 조합이면 세션 integration worktree를 최초 한 번 만들고 고정 cwd/`baseSha`를 resume에서도 재사용한다. 엔진은 wave마다 이 기준점을 가진 고유 worker ID·branch/worktree 계획을 반환한다. 동시 worker 수는 `min(계획된 병렬도, maxWorktrees=12)`다. `--worktree`가 없으면 integration 기준점은 `null`일 수 있으므로, **실행 driver가** 안전한 기준점을 만들 수 없거나 디스크/CPU 부족·생성 실패가 발생하면 격리를 추측하지 말고 표준 경로로 폴백해야 한다.
4. **통합은 driver가 검증·직렬화한다.** driver는 worker 결과의 owner·변경 경로·검증 증거를 수집하고 통합 기준 tree(`--worktree`이면 세션 integration worktree)에 하나씩 통합한다. 충돌 없는 결과만 다음 단계로 넘기며, ownership 이탈·불확실한 병합·high-risk 변경은 자동 통합하지 않고 PAUSED로 전환해야 한다. 전체 CI와 최종 수락 기준은 모든 wave 뒤 같은 통합 기준 tree에서 수행한다.
5. **관측 가능해야 한다.** 엔진 telemetry와 `:status`/`:tail`에는 fast 요청 여부, requested/eligible/planned parallelism, planned worktree, fallback/serial reason 및 `reused`를 남긴다. 작업 수와 동등 길이 작업 기준 `estimatedSpeedup`은 `state.fastProfile`/`instruction.fast`의 **계획값**이며 측정값이나 SLA가 아니다. 실행 driver가 실제 wall-clock 결과를 수집하지 않았다면 성능 향상을 주장하지 않는다.
6. **기존 lifecycle을 재사용한다.** fast는 별도 세션/명령/안전 모델을 만들지 않는다. 기존 pre-flight, feature lock, checkpoint/WIP commit, budget·goal·danger pause, cross-check, 전체 CI, completion report 및 session-store를 그대로 사용해 빠른 실행이 resume·rollback·감사의 경계를 깨지 않게 한다.

### 제약, 폴백, 재개

| 상황 | `--fast` / `-fast` 동작 |
|------|---------------|
| PLAN에 작업 metadata가 없거나 적격 작업이 2개 미만 | 표준 team 경로로 실행하고 `no-tasks` 또는 `fewer-than-two-eligible-tasks` 사유 기록 |
| `affectedPaths`가 겹침 | 충돌 group만 `conflict-serialized`로 직렬화한다. 안전한 concurrent pair가 하나도 없으면 표준 경로 + `no-safe-parallelism` 기록 |
| 절대/drive/UNC/home/traversal 경로 | worker 격리에 쓰지 않고 `unsafe-affected-path`로 직렬화. glob은 literal prefix 이전 디렉터리부터 보수적으로 충돌 판정 |
| 작업 ID 누락·중복, unresolved dependency, DAG cycle | 각각 `missing-id`, `duplicate-id`, `unresolved-dependency`, `dependency-cycle`로 직렬화. fast 비적격 선행 작업의 후속은 `dependency-not-fast`로 직렬화 |
| `--no-team` 동시 사용 | fast 엔진은 `team-disabled` telemetry와 표준 `team-create` instruction을 반환한다. command driver가 별도로 `--no-team`의 단일 실행 정책을 강제한다. |
| `--runner dynamic` 동시 사용 | 명시 runner를 우선한다. fast fan-out은 비적격이며 `explicit-runner-dynamic` 사유를 기록하고 dynamic 실행 |
| autoSelect가 `dynamic-run`을 선택 | fast fan-out은 비적격이며 `auto-runner-dynamic` 사유를 기록하고 자동 선택된 dynamic 실행 |
| `:plan` 모드 | INTAKE 뒤 종료하므로 fast 요청과 PRD만 저장한다. PLAN/그래프/fast profile은 이후 Phase 1·2가 실제로 실행될 때 생성한다. |
| `:night` 모드 | 동일한 fast 계약으로 실행하며 알림 정책만 night 규칙을 따름 |
| `:resume` | **EXECUTE에 재진입할 때만**, shape-valid한 저장 `executeRunner`와 `fastProfile` snapshot을 재사용하고 현재 CPU·config로 runner/그래프/병렬도를 다시 선택하거나 확대하지 않는다. 이 경우 `fast-profile-reused` telemetry와 `reused: true`를 기록한다. snapshot이 없거나 malformed일 때만 task metadata로 보수적 재계획하며 unsafe면 표준 경로로 폴백한다. 살아 있는 에이전트는 가정하지 않는다. |
| 예산·위험·테스트/빌드 실패 guard 발동 | fast 여부와 무관하게 기존 pause/abort 정책이 우선 |

## Sleep Prevention (v4.12.0)

장시간 실행되는 `/autopilot` 세션이 OS 절전(sleep / suspend / hibernate)에 의해 중단되지 않도록 보장합니다.

| 모드 | 시스템 sleep | 모니터 | 사용 시점 |
|------|--------------|--------|-----------|
| `--keep-awake` (기본) | 차단 | OS 설정대로 어두워질 수 있음 | 일반 자율 작업 — 배터리/전력 최적 |
| `--keep-awake --keep-display` | 차단 | 항상 켜짐 | 진행 상황을 실시간으로 보고 싶을 때 |
| `--no-keep-awake` | 차단하지 않음 | OS 설정대로 | OS 절전 설정에 완전히 위임 (legacy 동작) |

플랫폼별 구현:
- **Windows**: PowerShell 자식 프로세스가 `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_AWAYMODE_REQUIRED [| ES_DISPLAY_REQUIRED])` 호출. 자식 종료 시 OS가 기본값 복원.
- **macOS**: `caffeinate -i` (또는 `-d -i` for keepDisplay) backgrounded.
- **Linux**: `systemd-inhibit --who=artibot --why=<reason> --mode=block --what=sleep:idle sleep infinity`. `systemd-inhibit` 부재 시 `xset s off`로 fallback (display-only, warning emit).

권한 / 안전:
- **모두 user-level**. admin/sudo 불필요.
- 네트워크 호출 없음. 외부 데이터 송신 없음.
- 세션 완료(`COMPLETED`), abort(`ABORTED`), 부모 프로세스 종료(`exit`/`SIGINT`/`SIGTERM`) 시 자식 자동 종료. orphan 방지.
- Refcount idempotent — 여러 번 acquire 해도 단일 자식 공유.
- helper 부재 시 silent no-op + stderr warning. 절대 throw하지 않음.

검증:
- Windows: `powercfg /requests` 출력에서 `SYSTEM` 또는 `DISPLAY` 행에 PowerShell PID 확인.
- macOS: `pmset -g assertions | grep caffeinate`.
- Linux: `systemd-inhibit --list`에서 `artibot` who 행 확인.

## Arguments

Parse `$ARGUMENTS`:
- `task-description`: 자율 처리할 작업 설명 (필수, `:resume`/`:status`/`:abort` 제외)
- subcommand 접미어: `night` / `plan` / `resume` / `status` / `abort` / `list` 중 하나 (없으면 `default`)
- `--max`, `--budget`, `--no-notify`, `--no-tui`, `--no-team`, `--fast` / `-fast`, `--checkpoint`, `--worktree`, `--detached`, `--runner`: 위 표 참조
- `session-id`: `:resume` / `:abort` / `:status` 에서 사용 (`ap-YYYYMMDD-HHMMSS` 형식)
- `--goal`, `--validation-command`, `--max-iterations`: v4.6.0 Goal-driven mode (아래 "Goal-driven Mode" 섹션 참조)

## Goal-driven Mode (v4.6.0)

기존 7-phase 흐름은 **공정**(process) 자동화이고, Goal-driven은 **목표 도달**(outcome) 자동화입니다. 두 모드는 직교 — Goal Contract가 PRD에 있으면 engine이 Phase 5 후 evaluator를 추가로 실행해 stopping condition 충족 여부를 판단하고, 미충족 시 Phase 2로 재진입합니다.

### Goal Contract slots

PRD `## 2.5 Goal Contract` 섹션의 JSON 블록:

```json
{
  "objective": "사람이 읽는 목표 설명",
  "stoppingCondition": "verifiable 종료 조건 (자연어)",
  "validationCommand": "npm run ci",
  "forbiddenChanges": ["docs/PRD/**", "CHANGELOG.md"],
  "maxIterations": 3
}
```

- `objective`: 필수. 자연어 목표.
- `stoppingCondition`: 필수. 충족 여부를 검증 가능한 형태로 명시.
- `validationCommand`: optional. 미지정 시 evaluator는 `exit 0`을 자동 판정 못 하고 사용자 큐에 결정 요청.
- `forbiddenChanges`: optional. agent에게 변경 금지 영역 전달 (정보 전달용).
- `maxIterations`: optional. default 3, hard cap **10** (v4.5.6 무한루프 트라우마 가드).

### Iteration loop

```
Phase 0 (INTAKE) → Phase 1 (PLAN) → Phase 2 (EXECUTE)
                                          ↓
Phase 6 ← Phase 5 (IMPROVE) ← Phase 4 (VERIFY) ← Phase 3 (CROSS_CHECK)
              ↓
         goal-evaluator
              ↓
   ├─ met=true → Phase 6 REPORT
   └─ met=false → iteration < maxIterations
                   ├─ true  → Phase 2 재진입
                   └─ false → PAUSED + 사용자 큐
```

### Safety guards

- **maxIterations hard cap = 10** (스키마 검증, 위반 시 contract 거부).
- **동일 SHA 3 iteration 연속** → 강제 PAUSED (진행 없음 감지).
- **evaluator hallucination 차단**: agent 판단 X, `validationCommand` exit code만 신뢰. exit 0 = met. 다른 exit code = 미충족.
- **confidence < 0.8**: 사용자 큐에 결정 요청.

### 사용 예시

```bash
# Stage 1B: 가장 단순 — stopping condition만 지정 (validationCommand=npm run ci 기본)
/autopilot "migrate auth from v1 to v2" --goal "all auth endpoints return 200 under v2 schema"

# 명시적 validationCommand
/autopilot "optimize bundle" --goal "bundle < 500KB" --validation-command "npm run size:check"

# iteration 제한 강화
/autopilot "refactor cache layer" --goal "all cache tests pass" --max-iterations 5
```

### Legacy backward compat

Goal Contract 슬롯이 없는 PRD는 기존 7-phase 단방향 흐름 (Phase 0~6) 그대로 실행. **기존 세션 resume + 기존 PRD 파일 모두 무영향.**

## Execution Flow (메인 Claude가 받았을 때 수행할 절차)

### Step 1 — Engine Import & Argument Parse

1. `lib/autopilot/index.js` 동적 import — **반드시 `CLAUDE_PLUGIN_ROOT` 환경변수 기준 절대경로**로 해석한다 (cwd 상대경로 금지 — 타 프로젝트에서 호출 시 "엔진 부재"로 실패). Claude Code가 플러그인 커맨드 실행 시 `CLAUDE_PLUGIN_ROOT`를 주입. 미주입 시 마켓플레이스 mirror를 스캔하고, 그래도 못 찾으면 fail-fast로 명확한 에러:
   ```js
   import path from 'node:path';
   import fs from 'node:fs';
   // toFileUrl: 한글 경로 안전 (pathToFileURL의 percent-encoding 회피 — utils/index.js 참고)
   const toFileUrl = (p) => {
     const f = p.replace(/\\/g, '/');
     return /^[A-Z]:/i.test(f) ? `file:///${f}` : `file://${f}`;
   };
   // Plugin location candidates (3 가능 경로):
   //   1. CLAUDE_PLUGIN_ROOT (Claude Code 주입 — 정상 경로)
   //   2. ~/.claude/plugins/marketplaces/<id>/plugins/artibot/ (marketplace mirror)
   //   3. (NOT ~/.claude/artibot — install.sh가 만드는 runtime data dir, lib/ 없음)
   const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
   const candidates = [process.env.CLAUDE_PLUGIN_ROOT].filter(Boolean);
   const mpDir = path.join(home, '.claude', 'plugins', 'marketplaces');
   if (fs.existsSync(mpDir)) {
     for (const mp of fs.readdirSync(mpDir)) {
       candidates.push(path.join(mpDir, mp, 'plugins', 'artibot'));
     }
   }
   const pluginRoot = candidates.find((c) => fs.existsSync(path.join(c, 'lib/autopilot/index.js')));
   if (!pluginRoot) throw new Error('Artibot engine not found. Set CLAUDE_PLUGIN_ROOT or install via marketplace.');
   const engine = await import(toFileUrl(path.join(pluginRoot, 'lib/autopilot/index.js')));
   ```
2. `$ARGUMENTS` 파싱하여 `{ task, mode, options }` 분해:
   - `mode`: `default` | `night` | `plan` | `resume` | `status` | `abort`
   - `options`: `{ maxDuration, budget, notify, team, checkpoint, fast }`
   - `--fast`와 `-fast`는 모두 `options.fast = true`로 정규화한다. `fast-profile` public API는 boolean `fast`만 소비하며 별칭을 다시 해석하지 않는다.
   - `sessionId`: `:resume`/`:status`/`:abort` 인 경우만

### Step 1.5 — Pre-flight Gate (default 모드 자동)

`mode === 'default' | 'night' | 'plan'` 진입 직전 **자동 실행**:

```js
const goalContract = options.goal ? { objective: options.goal, stoppingCondition: '...', validationCommand: options.validationCommand } : null;
const preflight = await engine.runPreflight({ cwd: process.cwd(), sessionId: pendingId, featureKey: engine.extractKey(task), options, goalContract });
const pfInstr = engine.buildPreflightInstruction(preflight);
if (pfInstr?.abort) { /* abort: surface preflight errors table via engine.renderPreflightSummary(preflight) + 종료 */ }
if (pfInstr?.suppress) { /* warnings: state.preflightWarnings에 누적 + 계속 */ }
```

5 체크: `gitClean` / `lockFree` / `diskSpace (>500MB hard / >2GB warn)` / `nodeVersion (>=18 hard / >=20 warn)` / `goalContractLint`. Hard fail = abort, warn = continue + 누적. `:resume`는 pre-flight skip (이미 진행 중).

### Step 2 — Mode Dispatch

| mode | 호출 | 다음 단계 |
|------|------|-----------|
| `default` / `night` / `plan` | `engine.startAutopilot({ task, mode, options })` → `{ sessionId, prdPath, instruction }` | Step 3 (Phase 진행) |
| `resume` | `engine.resumeAutopilot(sessionId)` 직전 `detectInterruptedPhase(state)` 호출 — interrupted 검출 시 `engine.buildRecoveryNote(state)` 한국어 안내를 큐에 푸시 후 정상 resume. 판정 근거는 세션의 `events.ndjson`(`phase-start` 뒤에 짝 `phase-end` 가 없으면 중단)이므로 **`state.sessionId` 가 있는 상태를 넘겨야 한다** — `loadSession` 결과를 그대로 전달하면 된다. **미ACK attempt 가 있으면 배너가 "재진입"이 아니라 PAUSE 안내를 낸다** (아래 Step 3 의 ADR-005 2단 주석 참조) | Step 3 (재진입 Phase 부터 — 단 미ACK attempt 는 PAUSE) |
| `status` | `engine.getStatus(sessionId?)` → `SessionState` | 상태 표 출력 후 종료 |
| `abort` | `engine.abortAutopilot(sessionId, { graceful: true })` → `AbortResult` | 결과 표 출력 후 종료 |
| `tail` | `engine.readEvents(sessionId, { tail: lines })` → `Event[]` | 이벤트 표 출력 후 종료 (PRD v4.1 P0-2 Live Telemetry) |
| `list` | `engine.listActiveWorktrees()` + `engine.listSessions()` 조합 | GFM 표 출력 후 종료 |

### Step 3 — Phase Execution Loop

엔진이 반환한 `instruction` 객체를 따라 **Phase를 순차 실행**한다. 엔진 `lib/autopilot/engine.js`의 `PHASES`는 8개(INTAKE/PLAN/EXECUTE/CROSS_CHECK/VERIFY/IMPROVE/**EVALUATE**/REPORT)이며, 실행 갯수는 모드에 따라 다르다:
- **legacy(비-goal) PRD** = Goal Contract 부재 → IMPROVE 다음 EVALUATE를 건너뛰고 바로 REPORT (`engine.js` 라인 354 `state.goalContract ? 'EVALUATE' : 'REPORT'`). 실효 **7 phase (0~6)**.
- **goal-driven PRD** = Goal Contract 존재 → IMPROVE 다음 **EVALUATE 실행**(수락기준 미달 시 re-EXECUTE로 재반복, 충족 시 REPORT). 실효 **EVALUATE 추가**.

각 Phase 완료 시 `engine.recordPhaseResult(state, { phase, status, ...result })`로 session-store 업데이트 (1번 인자는 `loadSession(sessionId)`로 얻은 **state 객체**, 2번 인자에 `phase`/`status` 포함 payload).

> **EXECUTE 는 이 호출이 필수다 (ADR-005 2단).** EXECUTE 위임 시 엔진은 `state.activePhaseAttempt` 를 durable 하게 남기고 `phase-end` 를 기록하지 않는다 — 팀이 실제 작업을 끝냈는지는 엔진이 관측할 수 없기 때문이다. `recordPhaseResult(state, { phase: 'EXECUTE', ... })` 가 그 attempt 를 ACK 하고 `phase-end` 를 기록한다. **이 호출을 빠뜨리면 다음 resume 이 "위임 후 미보고" 로 판단해 PAUSE 한다** (재실행은 허용목록 phase 에만 자동 적용되고 EXECUTE 는 목록 밖 — 이미 반영된 작업의 중복 커밋을 막기 위함). 반대로 정상 완주 세션은 ACK 으로 슬롯이 비워지므로 resume 을 반복해도 recovery note 가 생기지 않는다.
>
> **Step 2 의 resume 배너도 이 판정을 그대로 따른다.** `buildRecoveryNote(state)` 는 `activePhaseAttempt` 를 먼저 조회해서, 미ACK attempt 가 있으면 아래 PAUSE 안내를 그대로 반환하고 attempt 가 없을 때만 "재진입합니다" 라고 말한다. 두 문구를 각자 쓰지 마라 — 문구 진실원은 `phase-attempt.js#buildPauseNote` / `#buildRerunNote` 하나뿐이고, 예전에 배너가 이 판정을 모른 채 항상 "재진입"이라고 말해 같은 resume 에서 정반대 안내가 동시에 나간 적이 있다.
>
> **PAUSE 된 뒤 빠져나오는 길은 셋이다** (recovery note 가 그대로 안내한다): ① 결과를 기록할 수 있으면 `recordPhaseResult(state, { phase: 'EXECUTE', status: 'done' })` ② 작업이 반영된 것은 확인했으나 결과를 기록할 수 없으면 `engine.resumeAutopilot(sessionId, { ackOutstandingAttempt: true })` — **호출 인자로만 받는다.** config·env 에 심어도 무시된다(`consentOverride` 와 같은 이유: "사람이 방금 트리를 확인했다"는 선언은 1회성이어야 하며, 설정에 박히면 아무도 확인하지 않은 채 영구히 참이 된다) ③ 판단이 안 서면 `/autopilot:abort` 로 종료 후 새로 시작.

**자동 통합 (default 모드 기본 ON)**:
- **★ 진행률 렌더 (MANDATORY — 채팅에 눈에 띄게)**: 각 Phase 완료 직후, 리더는 **대화에 진행률 박스를 직접(인라인) 출력**한다. PRD 작업이 "지금 몇 %"인지 한눈에 보이게 하는 핵심 UX다. `commands/team.md`의 "Phase 3.5 진행률 렌더링" 박스 템플릿을 그대로 쓰되 done=방금 끝난 phase index+1, **total은 모드에 따라 7(legacy: EVALUATE 생략) 또는 EVALUATE 포함(goal-driven)**, phaseLabel=Phase명. legacy면 phase 순서 INTAKE/PLAN/EXECUTE/CROSS_CHECK/VERIFY/IMPROVE/REPORT(=7), goal-driven이면 IMPROVE 뒤 EVALUATE가 추가된다. 인라인 출력이라 스크립트·환경변수 의존이 없어 **모든 컴퓨터에서 작동**한다. (선택: `node "$HOME/.claude/artibot/scripts/render-progress.js" <done> 7 "<Phase>"` 헬퍼로 자동화 가능 — 실패 시 인라인 폴백. `${CLAUDE_PLUGIN_ROOT}`는 쓰지 마라.) hook/TUI가 아니라 리더 채팅 출력이라 항상 보인다. 생략 금지.
- 각 Phase 완료 직후 `engine.notePhaseCost(state, phase, { tokensIn, tokensOut, costUsd, model })` 호출 — Phase별 토큰/비용을 telemetry + state.usage에 기록
- `engine.checkBudgetThreshold(sessionId, { limitUsd: options.budget })` 결과 `crossed === 95`면 `engine.buildCostWarningInstruction(state, threshold)`로 `notifyDanger` 발사
- TUI 활성 세션은 footer에 `engine.renderCostInline(getSessionCost(sessionId))` 자동 표시

#### 보고 계약 (MANDATORY — 모든 Phase 의 스폰 프롬프트 말미에 삽입)

아래 블록을 `{보고 계약}` 자리에 그대로 넣는다. `{리더 이름}` 은 리더 자신의 이름으로 치환한다.
**`commands/team.md` 의 것과 문자 단위로 동일해야 한다** — /team 이 아닌 경로로 뜬 팀원이 더 약한
계약으로 일하면 표준이 후퇴 기준선이 된다. 드리프트는
`tests/commands/report-contract-parity.test.js` 가 잡는다.

```
[보고 계약]
- 보고는 반드시 SendMessage(to="{리더 이름}") 로 보낸다. 일반 텍스트 출력은 리더에게 전달되지 않는다.
- 수치에는 분모와 측정 시각을 붙인다: "3건"(X) → "38건 중 3건, {측정시각} 기준"(O).
- 발생률과 도달률을 구분한다: "실패 38건 중 7.9%가 이 훅에 도달" ≠ "실패율 7.9%".
- 근거는 file:line 으로 인용한다(DEV Protocol). 동시 편집 중인 트리에서는 심볼명과 측정 시각을 함께 적어라 — 줄번호는 남이 편집하면 썩는다.
- 내 인용·지시·전제가 틀렸으면 그대로 따르지 말고 틀렸다고 보고하라. 교정도 정답이다.
- 없는 것을 고치지 마라. 구멍이 없으면 "없다"고 보고하는 것도 완결된 결과다.
- 마지막에 `미확인:` 줄을 반드시 포함한다. 확인 못 한 것을 추측으로 메우지 마라. 없으면 "미확인: 없음".
```

#### Phase 0 — INTAKE (PRD 생성)
- `Agent(subagent_type="artibot:planner", prompt="[Autopilot Phase 0] 사용자 요청: {task}\n\n\`docs/PRD/<feature>-<sessionId>.md\` 작성. PRD 템플릿: 배경/목표/비목표/시나리오/설계/산출물/실행계획/위험/수락기준\n\n{보고 계약}")`
  <!-- model: model-policy 해석 — 역할 frontier 티어 -->
- `mode === 'plan'`: PRD 경로 보고 후 종료. `:resume <sessionId>` 안내.

#### Phase 1 — PLAN
- `Agent(subagent_type="artibot:planner", prompt="[Autopilot Phase 1] PRD: {prdPath}\n\n분해 + 위험 식별 + 병렬 팀 구성 제안\n\n{보고 계약}")`
  <!-- model: model-policy 해석 — 역할 frontier 티어 -->
- `options.fast === true`면, planner 결과를 `state.fastTasks` (또는 `options.fastTasks`)로 저장한다. 각 작업은 stable ID, `dependsOn`/`dependencies`, `independent: true`, non-empty repo-relative `affectedPaths`, `risk`, `worktreeEligible`를 가져야 한다. 엔진은 dependency를 위상 wave로 해석한다. metadata가 불완전하거나 경로가 unsafe하면 fast 실행을 추측하지 말고 사유와 함께 직렬화한다.

#### Phase 2 — PARALLEL EXECUTE
- EXECUTE 러너는 `engine.resolveExecuteRunner(state)`가 결정한다 (**ADR-003**). 우선순위 사다리:
  1. `--runner dynamic|team` 명시 → 그대로 (항상 최우선)
  2. config `autopilot.runner.autoSelect !== true` (기본) → `'team-create'` (현행 동일)
  3. **Stage 2 자동선택**: autoSelect=true **그리고** 세션 시작 시 `options.recommendedRunner === 'workflow'`가 주입된 경우 → `'dynamic-run'`
  4. 그 외 전부 → `'team-create'`
- **recommendedRunner 주입 규칙 (Step 1 파싱 시)**: 세션 시작 프롬프트에 `[artibot:hint recommend=workflow]` 디렉티브(동형 반복 감지 — `buildWorkflowPlan.recommendation`의 advisory 표면)가 있으면 `options.recommendedRunner = 'workflow'`로 전달한다. 엔진(L2)은 분류기(L4)를 import하지 않고 이 주입값만 소비한다 — 재계산 금지.
- **`type: 'team-create'`** (기본): 러너 이름은 `lib/autopilot/engine.js#runPhase2Execute`의 계약 값이고 생성되는 팀은 없다 — 세션의 암묵적 단일 팀에 `Agent(name="autopilot-{sessionId}-{role}", subagent_type=…)`로 팀원을 병렬 스폰한다. 30분(또는 `--checkpoint`)마다 WIP commit: `git commit -m "wip(autopilot): phase2 checkpoint {sessionId}"`. SHA를 `engine.recordCheckpoint(state, { sha, label: 'phase2-wip' })`로 기록.
- **`options.fast === true`**: `buildFastFanoutPlan({ fast: true, tasks, cpuCount, limits: config.autopilot.fast })` 결과가 적격이면 DAG의 topological wave를 가능한 한 동시에 **계획**한다. `cpuCount`는 `os.availableParallelism()`(미지원 시 `os.cpus().length`, 실패 시 1)에서 구한다. 계획 동시성은 `min(eligibleTaskCount, cpuCount × agentsPerCpu, hardMaxAgents=16, maxWorktrees=12)`이며, 동시 write worker 수는 `maxWorktrees=12`를 넘지 않는다. 엔진은 `state.fastProfile`/`instruction.fast`에 requestedTaskCount, eligibleTaskCount, plannedParallelism, estimatedSpeedup, worktrees.count, serialReasons를 기록한다. planned telemetry에는 `requested`, requested/eligible/planned parallelism, worktrees, serialReasons, fallbackReason, `reused`를 기록한다. 새 profile은 `fast-profile-planned`, 저장 snapshot을 재사용한 profile은 `fast-profile-reused`와 `reused: true` telemetry로 구분한다. `estimatedSpeedup`은 동등 길이 작업의 스케줄 추정치일 뿐 측정값이나 SLA가 아니다. `--worktree` 조합 시 **실행 driver는** 저장된 integration cwd/`baseSha`에서 각 worker의 고유 branch/worktree 생성, agent 배정, owner·변경 경로·검증 증거 검사, 직렬 통합 및 worker 정리를 수행한다.
- **fast 재개**: EXECUTE 재진입 시 shape-valid `state.executeRunner`와 `state.fastProfile` snapshot이 있으면 현재 CPU·config·task metadata로 runner/eligibility를 다시 계산하거나 병렬도를 늘리지 않고 저장값을 그대로 사용한다. snapshot이 없거나 malformed일 때만 task metadata로 보수적으로 재계획하며, metadata가 없거나 unsafe하면 표준 instruction으로 폴백한다.
- **fast 폴백**: task metadata 부재(`no-tasks`), 적격 작업 2개 미만(`fewer-than-two-eligible-tasks`), 안전한 concurrent pair 부재(`no-safe-parallelism`), `--no-team`, 명시 `--runner dynamic`(`explicit-runner-dynamic`), 또는 autoSelect의 `dynamic-run`(`auto-runner-dynamic`)이면 기존 runner 우선순위를 유지한다. 일부 ownership 충돌은 해당 conflict group만 직렬화한다. ID 누락/중복, 미해결 dependency, cycle, 비적격 선행 작업, unsafe path는 `missing-id`/`duplicate-id`/`unresolved-dependency`/`dependency-cycle`/`dependency-not-fast`/`unsafe-affected-path`로 직렬화한다. 이때 엔진은 extra agent/worktree가 없는 표준 instruction 및 `fallbackReason`/`serialReasons`를 반환한다. worktree 생성·병합 단계의 실패 처리는 driver가 수행하며, fast는 위험·비용·merge guard를 우회하지 않는다.
- **`type: 'dynamic-run'`** (`--runner dynamic`): 팀원 스폰 대신 **하네스 `Workflow` 도구**로 스크립트 런 — Phase 1 PLAN의 작업 단위를 워크리스트로 매핑(pipeline() 기본), 세션 잔여 예산을 Workflow budget으로 전달(이중 계상 금지), checkpoint는 **run 경계**(시작 전/완료 후) WIP commit. **폴백**: 실패/빈 결과 시 같은 Phase를 team-create로 1회 재시도 + `runner-fallback` 이벤트 기록, 재시도도 실패 시 기존 PAUSED 경로.

#### Phase 3 — CROSS_CHECK
- 팀원 간 원형 검증 (A→B→C→A). 추가로 `Agent(subagent_type="artibot:spec-reviewer")` 소환.
  <!-- model: model-policy 해석 — 역할 frontier 티어 (fable 마이그레이션 이후 review/docs 역할도 frontier) -->

#### Phase 4 — VERIFY
- `Bash("npm run ci")` 실행. 실패 시 `engine.classifyFailure(error)` → `build-error-resolver` 자동 소환. **3회 재시도 후에도 실패하면 PAUSED**.

#### Phase 5 — IMPROVE
- 병렬 소환: `Agent(subagent_type="artibot:refactor-cleaner")` + `Agent(subagent_type="artibot:performance-engineer")`. 결과는 보고서 §7~8.

#### 중계 계약 (MANDATORY — 리더가 사용자에게 보고할 때)

`[보고 계약]` 이 **팀원→리더** 방향을 규율한다면, 아래는 **리더→사용자** 방향의 대칭 계약이다.
스폰 프롬프트에 삽입하는 블록이 아니라 **리더가 Phase 6 REPORT / Step 5 Completion 을 실행할 때
자기 자신에게 적용**한다. **`commands/team.md` 의 것과 문자 단위로 동일해야 한다** — /autopilot 만
실행한 리더는 team.md 를 읽지 않으므로, 여기 없으면 그 세션에는 이 계약이 없는 것이다. 드리프트는
`tests/commands/report-contract-parity.test.js` 가 잡는다.

```
[중계 계약]
- 팀원 보고의 `미확인:` 항목은 삭제하지 않고 최종 사용자 보고까지 그대로 전파한다. 요약은 유보를 지우는 자리가 아니다.
- 팀원이 "미확인" 이라 적은 것을 확정 사실로 승격하려면 리더가 직접 재측정한 출력이 있어야 한다. 없으면 미확인인 채로 올린다.
- 수치를 중계할 때 측정 주체와 측정 시각을 함께 적는다: "9,895 pass"(X) → "9,895 pass, {측정자} 측정, {측정시각} 기준"(O). 누가 쟀는지가 신뢰도다.
- 팀원 보고·핸드오프·이전 세션 기록에서 온 file:line 은 사용자 보고에 쓰기 전에 직접 연다. 남에게 들은 줄번호를 옮기는 것은 인용이 아니라 중계다.
- 관측치 3건 이상을 한 블록으로 보고할 때 상호 모순을 점검한다. 모순이면 숨기지 말고 "A 와 B 가 동시에 참이려면 C 가 필요한데 C 는 미확인" 형태로 그대로 올린다.
- 검증은 구현이 아니다. 리더가 파일을 열어 확인하는 것은 위임 원칙 위반이 아니다 — 위임 금지 대상은 구현이다.
```

#### Phase 6 — REPORT
- `Agent(subagent_type="artibot:doc-updater", prompt="[Autopilot Phase 6] reports/AUTOPILOT/{sessionId}.md 작성. 템플릿: PRD §13.5 (요약/PRD링크/Phase표/커밋SHA/Cross-check/검증/개선/미래/큐/Next)\n\n{보고 계약}")`
  <!-- model: model-policy 해석 — 역할 frontier 티어 (fable 마이그레이션 이후 review/docs 역할도 frontier) -->
- `engine.notifyCompletion(sessionId)` 호출 (`--no-notify` 시 skip, `night` 모드는 PushNotification 차단).

### Step 4 — PAUSED Handling

각 Phase 후 `engine.shouldPause(state)` 확인. `true`면:
1. 사용자 메시지를 `state.queuedQuestions[]` 에 푸시.
2. `mode === 'night'`: 큐만 누적, 다음 Phase 진행 또는 `Phase 6`로 점프 (위험도에 따라).
3. `mode === 'default'`: 즉시 종료 + 사용자 알림 (단, `dangerous` 위험은 모든 모드에서 종료).

### Step 5 — Completion

Phase 6 완료 후:
- **★ 최종 진행률 100% 렌더 (MANDATORY)**: 🎉 작업 완료 박스(`██████...██ 100%`, done=total — legacy면 7, goal-driven이면 EVALUATE 포함 total)를 채팅에 **인라인 출력**해 PRD 작업이 **100% 완료됐음을 시각 확정**한다. (선택: `node "$HOME/.claude/artibot/scripts/render-progress.js" <total> <total>`.)
- `engine.notifyCompletion(sessionId)` 호출.
- 보고서 경로 + 큐된 질문 요약을 사용자에게 출력.
- 비용 요약: `engine.renderCostBlock(engine.getSessionCost(sessionId))` 마크다운 테이블을 사용자에게 노출 (Phase별 토큰/$ + Budget 사용률).
- pre-flight 경고가 있었다면 `engine.renderPreflightSummary(state.preflightResult)` 출력 (참고용).
- abort/완료 시 `engine.releaseAllForSession(sessionId)`로 잔존 lock 일괄 해제.

## Fable-mode (조건부 — config fable.enabled 시)

이 섹션은 `artibot.config.json#/fable.enabled` + `fable.allowlist` opt-in 에이전트가 존재할 때만 적용되는 부록이다. model-policy fable 게이트를 통과한 에이전트에게만 아래 원칙·스니펫·휴리스틱이 적용된다. 게이트 미통과 에이전트(보안 계열 등 denylist)에는 적용하지 않는다.

### de-prescribe 원칙

fable 티어 에이전트 프롬프트는 단계 나열 대신 "목표 + 불변식 + 검증 기준" 서술로 작성한다. 세부 절차를 열거하면 과잉처방(over-prescription)으로 인해 품질이 저하된다.

### 스니펫 4종

> **① anti-overplanning**: 행동할 정보가 충분하면 행동하라; 이미 결정된 사항 재론 금지.

> **② grounded-progress**: 진행 보고 전 각 주장을 이 세션의 도구 결과와 대조; 검증 안 된 것은 명시.

> **③ boundaries**: 문제 서술/질문은 평가가 산출물 — 요청 전 수정 금지; 상태 변경 명령 전 증거 확인.

> **④ autonomous-no-asking**: 자율 모드 — 되돌릴 수 있는 행동은 묻지 말고 진행, 턴 종료 전 마지막 문단이 계획/질문이면 지금 도구로 실행.

### 빈-결과 휴리스틱

fable 에이전트 결과가 빈(empty) 또는 이상(refusal 추정)이면, 동일 프롬프트를 frontier 티어로 1회 재시도 후 결과를 큐에 기록한다. 재시도도 빈 결과이면 PAUSED 처리.

### 장시간 턴 안내

fable 단일 턴은 수 분이 정상이다. checkpoint 주기 내 무진행으로 오판하지 말 것 — fable 에이전트가 응답 중인 동안 phase 타이머를 별도 카운팅한다.

### `/autopilot:tail` Live Telemetry (PRD v4.1 P0-2)

야간 무개입 자율 모드의 black-box 문제 해소용. 각 Phase 진입/종료, pause, abort 시점에 `runtime/autopilot/<sessionId>.events.ndjson` 으로 한 줄 JSON 이 append 되며, 본 서브커맨드로 tail 조회한다.

1. `sessionId` 미지정 시 `engine.getStatus()` 로 가장 최근 세션 자동 선택.
2. `engine.readEvents(sessionId, { tail: lines })` 호출 (기본 `lines=50`).
3. 결과를 GFM 표로 출력:

| ts | phase | type | level | message | progress |
|----|-------|------|-------|---------|----------|
| 2026-04-27T... | INTAKE | phase-start | info | Phase 0 INTAKE 시작 | - |
| 2026-04-27T... | EVALUATE | goal-evaluated | warn | goal evaluation: validationCommand exit code 1 | 1/3 (33%) met=false |
| 2026-04-27T... | EVALUATE | phase-end | info | EVALUATE not met → re-EXECUTE iteration 2/3 | 2/3 (67%) met=false |
| ... | ... | ... | ... | ... | ... |

**v4.6.0 Phase 4** — `progress` column shows goal-driven iteration progress when present (`iteration/maxIterations (pct%)` + `met` flag). Legacy non-goal events show `-`.

4. `--follow` 옵션 사용 시 `engine.tailEventsStream(sessionId)` 로 1초 폴링하며 새 이벤트를 한 줄씩 추가 출력. AbortSignal 로 중단 가능.

DATA POLICY: ndjson 파일은 로컬에만 존재. 외부 송신 없음.

## Multi-session Orchestration (P0-3)

`--fast`는 이 기능을 대체하지 않는다. `--fast --worktree`에서 세션 worktree는 고정 integration cwd/`baseSha`가 되고, fast instruction이 적격 concurrent write wave에 요청하는 **worker worktree**는 그 기준점에서 분기되는 제한된 수의 임시 작업 공간이다. resume은 동일 integration 경로/SHA를 재사용한다. 실제 worker worktree lifecycle은 engine이 아닌 실행 driver가 이 instruction에 따라 수행한다.

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
| fast worktree 병합에서 ownership 밖 변경 또는 해소 불가 충돌 | engine은 계획만 반환한다. 실행 driver는 자동 병합을 중단하고 PAUSED + owner/경로/증거를 큐와 telemetry에 기록해야 함 |

## Config

`artibot.config.json` → `autopilot` 섹션 참조 (`enabled`, `defaultMode`, `limits`, `safety`, `phases`, `paths`, `notification`).

`autopilot.fast`는 fast fan-out의 운영 설정이다. 기본은 `{ hardMaxAgents: 16, agentsPerCpu: 2, maxWorktrees: 12, maxRisk: "medium" }`이며, config 값은 immutable absolute cap(agents 16, worktrees 12, agentsPerCpu 4)을 넘을 수 없고 maxRisk는 `medium`을 넘을 수 없다. 예를 들어 `agentsPerCpu`는 기본 2에서 최대 4까지 조정할 수 있다. malformed 값은 안전한 기본값으로 정규화되고, high/critical risk는 fast wave에 넣지 않는다.

비활성화는 **두 갈래로 분리**되어 있다 (ADR-004 — 러너 ADR-003 과 별건):

| 대상 | 끄는 법 | 효과 |
|---|---|---|
| 자동 제안(NLU) | `autopilot.suggest.enabled: false` 또는 `--no-autopilot` | "자고 올 동안…" 류 문장에 `[autopilot-suggested]` 를 붙이지 않는다. 명시적 `/autopilot <task>` 는 계속 동작 |
| 실행 | `autopilot.execution.enabled: false` | `start`·`queue`·`resume` 이 차단된다. 세션 파일·락 **생성 전** 에 거부하므로 잔재가 남지 않는다 |

레거시 `autopilot.enabled: false` 는 **두 갈래 모두 false 로 보수 매핑**되고 stderr WARN 이 뜬다 — 문서상 전면 kill-switch 로 알고 false 를 넣은 사용자의 의도를 보존하기 위함이다. 단 `suggest`/`execution` 을 **명시**하면 그 값이 레거시 키를 이긴다(이 리포의 출하 config 가 그 예: 제안은 끄고 실행은 켠다).

`status`·`list`·`abort`·`tail`·`replay`·`diff` 는 게이트와 무관하게 **항상 허용**된다 — 꺼진 오토파일럿도 멈출 수 있어야 한다.

판정 소유자는 `lib/autopilot/consent-gate.js#resolveAutopilotConsent` 하나다. 플래그를 직접 읽어 판정을 복제하지 마라.

## Output Format

**세션 시작 시**

| 항목 | 값 |
|------|-----|
| Session ID | ap-YYYYMMDD-HHMMSS |
| Mode | default / night / plan |
| Task | {요약} |
| PRD | {prdPath} |
| Max | {duration} / {budget} tokens |
| Execution profile | standard / fast (planned parallelism, worktrees, estimated speedup 또는 fallback reason) |

**Phase 진행 표 (`:status` 또는 보고서)**

| Phase | 상태 | 소요 | 변경 파일 | 검증 | Fast 관측값 |
|-------|------|-----|----------|------|-------------|
| 0 INTAKE | DONE | 2m | docs/PRD/... | - | - |
| 1 PLAN | DONE | 3m | - | - | 8 requested / 6 eligible |
| 2 EXECUTE | IN_PROGRESS | 14m | 7 | - | planned 6 parallel / 6 worktrees / estimated 4.2x |
| ... | ... | ... | ... | ... | ... |

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
