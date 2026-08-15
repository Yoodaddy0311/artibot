---
description: (Artibot) Multi-goal queue & scheduling for autopilot — enqueue goals, run them FIFO, gate by time window, track per-goal budget
argument-hint: <add|run|list|remove|pause|resume> [args]
allowed-tools: [Read, Write, Edit, Bash, Glob, Grep, Agent, TaskCreate, TaskUpdate, TaskList, SendMessage, TaskGet]
toolset: team
---

# /autopilot:queue

Multi-goal scheduling layer on top of `/autopilot`. Enqueue several long-running goals and drain them FIFO either immediately or only during a permitted time window (e.g. 22:00-07:00 night runs). Per-goal budget + pre-intake cost prediction are tracked locally — DATA POLICY 엄격 준수, 외부 송신 없음.

## Subcommands

| 명령 | 설명 |
|------|------|
| `/autopilot:queue add <task> [--queue <id>] [--budget <usd>] [--window HH:MM-HH:MM]` | 새 goal을 큐에 추가 (없으면 새 큐 생성). pre-intake `predictCost()`로 토큰/시간/비용 추정 표 출력. |
| `/autopilot:queue run <queueId> [--window HH:MM-HH:MM] [--max-goals N] [--dry]` | 큐 드레인 — pending 골 순서대로 `/autopilot` 실행. `--window` 지정 시 윈도우 진입 전까지 대기. |
| `/autopilot:queue list [<queueId>]` | 큐 목록(전체 요약) 또는 단일 큐 상세 표 출력. |
| `/autopilot:queue remove <queueId> <goalId>` | pending goal 제거 (running goal은 거부 — `/autopilot:abort` 사용). |
| `/autopilot:queue pause <queueId>` | dequeue 차단 (이미 실행 중인 goal은 영향 없음). |
| `/autopilot:queue resume <queueId>` | pause 해제 → 다음 `run` 호출부터 정상 dequeue. |

## Common Options

| 플래그 | 기본값 | 설명 |
|--------|--------|------|
| `--queue <id>` | 자동 생성 (`q-YYYYMMDD-HHmmss-xxxx`) | 기존 큐 ID 지정. 없으면 새 큐 생성 후 ID 반환. |
| `--budget <usd>` | (없음) | goal별 예산 상한. 초과 시 해당 goal만 abort, 큐는 계속 진행. |
| `--window HH:MM-HH:MM` | (없음 = 즉시) | 실행 허용 시간대. 미드나잇 wrap 지원 (`22:00-07:00`). |
| `--max-goals N` | (무제한) | 한 번의 `run` 호출에서 처리할 goal 수 상한. |
| `--dry` | off | dequeue/실행 없이 `predictCost()` 추정만 표 출력. |

## Execution Flow

### Step 1 — Module Import

**반드시 `CLAUDE_PLUGIN_ROOT` 환경변수 기준 절대경로**로 해석한다 (cwd 상대경로 금지 — 타 프로젝트에서 호출 시 "엔진 부재"로 실패). `/autopilot` Step 1과 동일한 resolver 사용 (3-location 폴백: env-var → marketplace mirror scan → fail-fast):

```js
import path from 'node:path';
import fs from 'node:fs';
// toFileUrl: 한글 경로 안전 (utils/index.js 참고)
const toFileUrl = (p) => {
  const f = p.replace(/\\/g, '/');
  return /^[A-Z]:/i.test(f) ? `file:///${f}` : `file://${f}`;
};
// 3 가능 경로 — ~/.claude/artibot 은 install.sh의 runtime data dir이라 lib/ 없음, 후보 제외
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
const lib = (rel) => toFileUrl(path.join(pluginRoot, 'lib/autopilot', rel));

const queue = await import(lib('goal-queue.js'));
const window = await import(lib('schedule-window.js'));
const predictor = await import(lib('cost-predictor.js'));
const budget = await import(lib('goal-budget-aggregator.js'));
const engine = await import(lib('index.js'));
```

### Step 2 — Subcommand Dispatch

| sub | 호출 | 출력 |
|-----|------|------|
| `add` | `predictor.predictCost(task)` → 추정 표 → `queue.enqueueGoal({task, options:{budget,window}}, {queueId})` | `{queueId, goalId, estimatedTokens, estimatedDurationMs, confidence}` 표 |
| `run` | `window.isInWindow(now, w)` 확인 → 비인입 시 `window.nextWindowStart(now,w)` 까지 대기 알림 + `queue.runQueue(queueId, {runner})` | dequeue → `engine.startAutopilot(goal.task, goal.options)` → 완료 후 `budget.recordGoalUsage()` |
| `list` | `queue.listQueue(queueId?)` | GFM 표 (`queueId / total / pending / running / completed / failed / paused`) |
| `remove` | `queue.removeFromQueue(queueId, goalId)` | `true/false` 결과 |
| `pause` | `queue.setQueuePaused(queueId, true)` | 새 paused 상태 |
| `resume` | `queue.setQueuePaused(queueId, false)` | 새 paused 상태 |

### Step 3 — Runner Integration (`run` only)

`queue.runQueue()`에 전달할 runner는 다음 형태:

```js
async function runner(goal) {
  // window gate (already validated outside, but defensive re-check)
  if (goal.options.window && !window.isInWindow(new Date(), goal.options.window)) {
    return { ok: false, stop: true, error: 'outside window' };
  }
  const { sessionId } = await engine.startAutopilot({
    task: goal.task,
    mode: 'default',
    options: goal.options,
  });
  // budget recording happens via engine.notePhaseCost as usual;
  // here we also mirror into per-goal aggregator
  const summary = engine.getSessionCost(sessionId);
  budget.recordGoalUsage(queueId, goal.id, 'TOTAL', {
    tokensIn: summary.totalTokens, costUsd: summary.totalCostUsd,
  });
  return { ok: true };
}
```

## Output Format

**`add` 결과 표**

| 항목 | 값 |
|------|-----|
| Queue ID | q-20260517-103000-abcd |
| Goal ID | g-1715942400-x1y2 |
| Task | "refactor cache layer" |
| Est. tokens | 25,000 |
| Est. duration | 32m |
| Confidence | 0.7 (based on 7 sessions) |
| Budget cap | $5.00 |
| Window | 22:00-07:00 |

**`list` 결과 표 (전체 요약)**

| Queue | Total | Pending | Running | Completed | Failed | Paused |
|-------|-------|---------|---------|-----------|--------|--------|
| q-20260517-103000-abcd | 5 | 3 | 0 | 2 | 0 | no |

**`run` 결과 표**

| # | Goal | Status | 토큰 | 비용 | 소요 |
|---|------|--------|------|------|------|
| 1 | refactor cache | completed | 24k | $0.45 | 28m |
| 2 | optimize bundle | completed | 31k | $0.58 | 35m |

## DATA POLICY (필수 준수)

- 큐 상태는 `~/.artibot/queues/{queueId}.json` 로컬 파일에만 저장
- per-goal budget은 `~/.artibot/queues/{queueId}.budget.json` 로컬 파일에만 저장
- 외부 HTTP / 외부 DB / 외부 플러그인으로 데이터 전송 절대 금지
- `predictCost`는 로컬 `events.ndjson`만 읽어 추정

## Anti-Patterns

- 큐 paused 무시하고 강제 dequeue (`setQueuePaused(false)` 호출 없이 진행)
- window 미준수 — 사용자가 `--window 22:00-07:00` 지정했는데 즉시 실행
- per-goal budget 추적 누락 — `recordGoalUsage` 호출 없이 `engine.startAutopilot`만 호출
- `predictCost` 결과 무시 — 예측 토큰이 budget의 200% 초과해도 그냥 진행

## Next Steps

| # | 액션 | 커맨드 |
|---|------|--------|
| 1 | 큐 상태 확인 | `/autopilot:queue list <queueId>` |
| 2 | 실행 결과 보고서 | `/autopilot:status <sessionId>` (각 goal 별) |
| 3 | budget 초과 분석 | `getQueueTotal(queueId)` 결과를 보고서에 첨부 |
