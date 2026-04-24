# Dashboard Event Schema

`hook-event-emitter` 스킬이 발행하는 이벤트의 JSON 계약. 대시보드 구현자는 이 문서만 참조해도 렌더가 가능해야 합니다.

## 1. Envelope Schema

모든 이벤트는 동일한 envelope로 감쌉니다.

| Field | Type | Required | 설명 |
|-------|------|----------|-----|
| `v` | integer | yes | 스키마 버전 (현재 `1`). 하위호환 깨질 때 증가 |
| `timestamp` | string | yes | ISO-8601 UTC, 밀리초 포함 (`2026-04-23T04:10:22.531Z`) |
| `event` | string | yes | 이벤트 타입 (아래 12종 중 하나) |
| `sessionId` | string | yes | Claude Code 세션 id. 없는 이벤트는 `"system"` |
| `tool` | string | no | `PreToolUse`/`PostToolUse`에서만 필수 |
| `payload` | object | yes | 이벤트별 스키마 (§3) |
| `meta` | object | yes | emitter 메타 (§2) |

## 2. Meta Schema

| Field | Type | 설명 |
|-------|------|-----|
| `emitter` | string | 고정값 `"artibot"` |
| `emitterVersion` | string | `SKILL.md`의 `version` (예: `"0.5.0"`) |
| `host` | string | `"local"` 고정 (외부 전송 금지 정책 반영) |
| `pid` | integer | 훅 프로세스 pid |
| `truncated` | boolean | payload가 축약되었는지 여부 (선택) |
| `payloadSha1` | string | truncated=true일 때 원본 참조용 해시 (선택) |

## 3. Event-Specific Payloads

### 3.1 SessionStart
| Field | Type | Required | 설명 |
|-------|------|----------|-----|
| `cwd` | string | yes | 작업 디렉토리 (redacted) |
| `model` | string | yes | 모델 id (예: `claude-opus-4-7`) |
| `source` | string | no | `"cli"` / `"ide"` / `"api"` |

### 3.2 SessionEnd
| Field | Type | Required | 설명 |
|-------|------|----------|-----|
| `durationMs` | integer | yes | 세션 전체 길이 |
| `endedBy` | string | yes | `"user"` / `"stop"` / `"error"` |
| `toolCallCount` | integer | no | 세션 내 총 tool 호출 수 |

### 3.3 UserPromptSubmit
| Field | Type | Required | 설명 |
|-------|------|----------|-----|
| `prompt` | string | yes | redacted + 길면 head/tail 잘림 |
| `chars` | integer | yes | 원본 길이 (redaction 전) |

### 3.4 PreToolUse
| Field | Type | Required | 설명 |
|-------|------|----------|-----|
| `input` | object | yes | 툴 인자 (redacted) |
| `approved` | boolean | no | permission hook 통과 여부 |

### 3.5 PostToolUse
| Field | Type | Required | 설명 |
|-------|------|----------|-----|
| `ok` | boolean | yes | 툴 성공 여부 |
| `durationMs` | integer | yes | 툴 실행 시간 |
| `output` | object/string | no | redacted. 16KB 초과 시 `meta.truncated=true` |
| `errorMessage` | string | no | `ok=false`일 때 |

### 3.6 Stop
| Field | Type | Required | 설명 |
|-------|------|----------|-----|
| `stopReason` | string | yes | `"end_turn"` / `"max_tokens"` / `"tool_use"` |
| `tokensIn` | integer | no | 입력 토큰 |
| `tokensOut` | integer | no | 출력 토큰 |

### 3.7 SubagentStop
| Field | Type | Required | 설명 |
|-------|------|----------|-----|
| `parentSessionId` | string | yes | 호출자 세션 |
| `subagentId` | string | yes | 서브에이전트 id |
| `taskSummary` | string | no | 요약 (redacted) |
| `status` | string | yes | `"completed"` / `"failed"` / `"cancelled"` |

### 3.8 PreCompact
| Field | Type | Required | 설명 |
|-------|------|----------|-----|
| `reason` | string | yes | `"token_threshold"` / `"manual"` |
| `ctxUsage` | number | yes | 0.0 – 1.0 비율 |
| `preservedChars` | integer | no | 요약 후 남는 문자 수 |

### 3.9 Notification
| Field | Type | Required | 설명 |
|-------|------|----------|-----|
| `kind` | string | yes | `"approval"` / `"info"` / `"warning"` |
| `message` | string | yes | 유저에게 노출되는 문자열 |

### 3.10 TaskCreated
| Field | Type | Required | 설명 |
|-------|------|----------|-----|
| `teamId` | string | yes | 팀 id |
| `taskId` | string | yes | 작업 id |
| `assignee` | string | yes | 에이전트 이름 |
| `title` | string | no | 작업 제목 (redacted) |

### 3.11 TaskCompleted
| Field | Type | Required | 설명 |
|-------|------|----------|-----|
| `teamId` | string | yes | 팀 id |
| `taskId` | string | yes | 작업 id |
| `status` | string | yes | `"completed"` / `"failed"` / `"blocked"` |
| `durationMs` | integer | no | 수행 시간 |

### 3.12 ErrorRaised
| Field | Type | Required | 설명 |
|-------|------|----------|-----|
| `scope` | string | yes | `"hook"` / `"tool"` / `"agent"` |
| `message` | string | yes | 에러 메시지 |
| `stack` | string | no | 스택 (redacted) |

## 4. Aggregation Views

대시보드에서 추천하는 집계 뷰.

| View | 입력 이벤트 | 집계 | 시각화 |
|------|------------|-----|--------|
| Tool 빈도 | `PostToolUse` | `GROUP BY tool` count | 히스토그램 (bar) |
| Tool 성공률 | `PostToolUse` | `ok=true` 비율 / tool | stacked bar |
| Tool 지연 | `PostToolUse` | p50/p95 `durationMs` / tool | box plot |
| 세션 타임라인 | 모든 이벤트 | time vs event type | 스와임레인 |
| 에러율 | `ErrorRaised` | 분당 건수 | 시계열 라인 |
| 토큰 사용 | `Stop` | cumulative `tokensIn+Out` / 세션 | 누적 line |
| 컴팩션 빈도 | `PreCompact` | 세션당 카운트 | histogram |
| 팀 Throughput | `TaskCompleted` | per-hour 완료 | 시계열 + heatmap(요일×시간) |

## 5. Chart Recommendations

| 데이터 모양 | 권장 차트 | 라이브러리 예 (로컬 번들) |
|------------|----------|------------------------|
| 시계열 연속값 | Line chart | uPlot (경량), Chart.js |
| 카테고리 분포 | Bar / Histogram | Chart.js |
| 이벤트 밀도 | Heatmap (요일×시간) | uPlot heat plugin |
| 세션 시퀀스 | Swimlane (이벤트 타입별 행) | 커스텀 SVG 충분 |
| 분위수 (latency) | Box plot | Plotly (선택, zero-dep 위배 시 대체 구현) |

로컬 번들만 사용 — CDN/원격 JS 호출 금지 (데이터 정책).

## 6. Example Payloads

### 6.1 PostToolUse (성공 Read)

```json
{
  "v": 1,
  "timestamp": "2026-04-23T04:12:44.102Z",
  "event": "PostToolUse",
  "sessionId": "sess_01HABCD",
  "tool": "Read",
  "payload": {
    "ok": true,
    "durationMs": 12,
    "input": { "file_path": "<REDACTED_PATH>" },
    "output": { "bytes": 4821 }
  },
  "meta": {
    "emitter": "artibot",
    "emitterVersion": "0.5.0",
    "host": "local",
    "pid": 12345
  }
}
```

### 6.2 ErrorRaised (hook 레벨)

```json
{
  "v": 1,
  "timestamp": "2026-04-23T04:13:01.998Z",
  "event": "ErrorRaised",
  "sessionId": "sess_01HABCD",
  "payload": {
    "scope": "hook",
    "message": "ENOENT: runtime/events directory missing",
    "stack": "Error: ENOENT...\n    at <REDACTED_PATH>:42:9"
  },
  "meta": {
    "emitter": "artibot",
    "emitterVersion": "0.5.0",
    "host": "local",
    "pid": 12345
  }
}
```

### 6.3 TaskCompleted (Agent Team)

```json
{
  "v": 1,
  "timestamp": "2026-04-23T04:15:22.440Z",
  "event": "TaskCompleted",
  "sessionId": "system",
  "payload": {
    "teamId": "team_build_v050",
    "taskId": "t_03",
    "status": "completed",
    "durationMs": 48120
  },
  "meta": {
    "emitter": "artibot",
    "emitterVersion": "0.5.0",
    "host": "local",
    "pid": 12345
  }
}
```

## 7. Versioning

- 스키마 변경은 `v` 증가로 표현. 대시보드는 envelope `v` 기준 분기
- 하위호환 가능한 추가(optional 필드)는 같은 `v` 내 허용
- Required 필드 변경·필드 삭제는 반드시 `v++`

## 8. Validation

JSON Schema (Draft 2020-12) 생성 권고. envelope 루트에 `$schema` 마커는 포함하지 않음 — 크기 절감. 검증은 emitter 측에서 선택적으로 수행.
