---
context: fork
user-invocable: false
name: hook-event-emitter
description: "로컬 관측성(observability) 스킬 — Claude Code hook 이벤트를 JSONL 큐로 fan-out하고 localhost WebSocket 브로드캐스트로 대시보드에 노출. 외부 전송 0건, Artibot 내부 전용. Auto-activates when: building a local hook monitor, an on-device agent dashboard, or an observability surface. Triggers: hook monitor, agent dashboard, event tap, local telemetry, claude code hooks, 훅 모니터, 이벤트 대시보드, 관측성."
lang: [en, ko]
platforms: [claude-code, gemini-cli, codex-cli, cursor]
level: progressive
triggers:
  - "hook monitor"
  - "agent dashboard"
  - "event tap"
  - "observability local"
  - "hook event emitter"
  - "claude code hooks"
  - "local telemetry"
  - "훅 모니터"
  - "이벤트 대시보드"
  - "관측성"
agent: Explore
allowed-tools: [Read, Grep, Glob, Bash]
agents:
  - "devops-engineer"
  - "performance-engineer"
tokens: 3800
level1_tokens: 220
level2_tokens: 3800
category: "observability"
whenNotToUse: "Cloud or remote telemetry pipelines, external monitoring services, or any observability surface that requires data to leave the device — this skill is local-only by design."
risk: safe
version: "0.5.0"
lastVerified: "2026-04-23"
---

# Hook Event Emitter (Local Observability)

## When This Skill Applies
- Claude Code hook 이벤트를 실시간으로 대시보드에 노출
- 세션/에이전트 타임라인 시각화 (tool 호출, 에러, 토큰 사용)
- 로컬 디버깅을 위해 PreToolUse/PostToolUse 등 훅 페이로드를 검사
- 외부 SaaS 없이 on-device observability 구성
- Team Agents의 작업 진행을 로컬 UI로 중계

## Do NOT Use When
- 외부 SaaS 관측 플랫폼으로 전송이 필요한 경우 (본 스킬은 로컬 전용, 외부 전송 금지)
- 단순 웹훅 알림 (`scripts/hooks/http-notify.js` 참조 — 그 자체도 opt-in)
- 영구 감사 로그 용도 (retention 24h 기본, `runtime/audit/` 별도 사용)

## Core Guidance (Level 1)

### Artibot Data Policy (CRITICAL)
본 스킬이 발행하는 모든 이벤트는 **localhost 내부에서만** 이동합니다.
- 외부 플러그인·외부 DB·타사 API로 전송 금지
- WebSocket 서버는 반드시 `127.0.0.1` 바인딩 (0.0.0.0 금지)
- 이벤트 원본은 `runtime/events/*.jsonl`에만 저장
- `lib/core/redaction.js`로 토큰·경로·시크릿 마스킹 필수

### 파이프라인 개요
```
Claude Code hook
  └─> scripts/hooks/event-emitter.mjs  (stdin JSON)
        ├─> redact()                   (lib/core/redaction)
        ├─> append runtime/events/YYYY-MM-DD.jsonl
        └─> (optional) WebSocket broadcast → 127.0.0.1:PORT
              └─> local dashboard (browser / TUI) subscribes
```

### 필수 산출물
1. Hook 스크립트 (`scripts/hooks/event-emitter.mjs`)
2. 이벤트 envelope 스키마 (`references/dashboard-schema.md`)
3. WebSocket 브로드캐스터 (localhost-only)
4. Retention 작업 (24h 기본)

## Detailed Guide (Level 2)

### Step 1: 지원 이벤트 타입

Claude Code가 발행하는 hook 이벤트를 envelope로 정규화합니다.

| # | Event | 발생 시점 | 주요 payload 필드 |
|---|-------|----------|-------------------|
| 1 | `SessionStart` | 세션 시작 | `sessionId`, `cwd`, `model` |
| 2 | `SessionEnd` | 세션 종료 | `sessionId`, `durationMs`, `endedBy` |
| 3 | `UserPromptSubmit` | 유저 프롬프트 제출 | `sessionId`, `prompt` (redacted) |
| 4 | `PreToolUse` | 툴 호출 직전 | `tool`, `input` (redacted) |
| 5 | `PostToolUse` | 툴 호출 직후 | `tool`, `output` (redacted), `durationMs`, `ok` |
| 6 | `Stop` | 에이전트 응답 종료 | `sessionId`, `stopReason` |
| 7 | `SubagentStop` | 서브에이전트 종료 | `parentSessionId`, `subagentId`, `taskSummary` |
| 8 | `PreCompact` | 컨텍스트 컴팩션 직전 | `sessionId`, `reason`, `ctxUsage` |
| 9 | `Notification` | 승인/알림 요청 | `sessionId`, `kind`, `message` |
| 10 | `TaskCreated` | Agent Team 작업 생성 | `teamId`, `taskId`, `assignee` |
| 11 | `TaskCompleted` | Agent Team 작업 완료 | `teamId`, `taskId`, `status` |
| 12 | `ErrorRaised` | 훅·툴 레벨 에러 | `scope`, `message`, `stack` |

각 이벤트 구조와 aggregation 뷰는 `references/dashboard-schema.md` 참조.

### Step 2: 이벤트 Envelope 스키마

```json
{
  "v": 1,
  "timestamp": "2026-04-23T04:10:22.531Z",
  "event": "PostToolUse",
  "sessionId": "sess_01HABCD",
  "tool": "Read",
  "payload": {
    "ok": true,
    "durationMs": 12,
    "input": { "file_path": "<REDACTED_PATH>" }
  },
  "meta": {
    "emitter": "artibot",
    "emitterVersion": "0.5.0",
    "host": "local",
    "pid": 12345
  }
}
```

규칙:
- `v`는 스키마 버전 정수 (하위호환 깨질 때 증가)
- `timestamp`는 ISO-8601 UTC, 밀리초 포함
- `payload`는 이벤트별 상이. 스키마는 `references/dashboard-schema.md`에 정의
- 모든 문자열 필드는 redaction 통과 후 저장

### Step 3: Emitter 아키텍처

```
                  ┌──────────────────────────────┐
 Claude hook ─►   │ event-emitter.mjs            │
                  │  1. read stdin JSON          │
                  │  2. normalize → envelope     │
                  │  3. redact payload           │
                  │  4. append JSONL (atomic)    │
                  │  5. (opt) WS broadcast       │
                  │  6. stdout {"continue":true} │
                  └──────────────────────────────┘
                         │                 │
                         ▼                 ▼
              runtime/events/*.jsonl   ws://127.0.0.1:PORT
                                             │
                                             ▼
                                 local dashboard (subscribe)
```

규칙:
- Hook은 동기적으로 응답해야 하므로 WS 전송은 fire-and-forget
- 파일 append 실패는 stderr 로그 후에도 `{"continue": true}` 유지 (훅 사용자 경험 보호)
- Stdout에는 envelope를 쓰지 않음 — Claude Code hook 규약은 stdout을 제어용으로 사용

### Step 4: WebSocket 서버 (개요)

별도 장기 실행 프로세스로 구동합니다. 훅은 단명 프로세스라 WS 서버를 띄울 수 없습니다.

| 항목 | 값 |
|------|---|
| 호스트 | `127.0.0.1` (환경변수 `ARTIBOT_EMITTER_HOST`로 오버라이드 불가 — localhost 강제) |
| 포트 | `process.env.ARTIBOT_EMITTER_PORT || 45734` |
| 인증 | 단일 사용자 머신 기준 포트 바인딩 + 로컬 토큰 (`runtime/events/ws-token`) |
| 프로토콜 | Node built-in `ws` 모듈 금지 (zero-dep 정책) → raw `http` + `Upgrade` 수동 파싱 |
| 배달 | fan-out, 실패 클라이언트는 바로 drop |
| 재생 | 신규 구독자에게 최근 N개 envelope 재방송 (옵션) |

훅 쪽 전송 코드는 TCP 소켓으로 NDJSON 한 줄 전송 → WS 서버가 파싱·중계:

```js
// 훅에서 (타임아웃 50ms, 실패해도 훅 정상 종료)
const socket = net.createConnection({ host: '127.0.0.1', port });
socket.setTimeout(50);
socket.on('error', () => {});
socket.on('timeout', () => socket.destroy());
socket.end(JSON.stringify(envelope) + '\n');
```

### Step 5: 로컬 파일 Fallback

WS 서버가 꺼져있어도 이벤트는 유실되지 않아야 합니다.

| 항목 | 값 |
|------|---|
| 경로 | `runtime/events/YYYY-MM-DD.jsonl` |
| 인코딩 | UTF-8, LF 개행 |
| 쓰기 | `appendFileSync` (훅은 짧게 동기 완료) |
| 원자성 | 한 줄 = 하나의 envelope, 중간 crash 시 마지막 줄만 잘릴 수 있음 |
| 파서 권장 | `readline` + try/catch JSON.parse per line |

대시보드 재시작 시 오늘자 JSONL을 replay하면 상태가 복원됩니다.

### Step 6: Retention

| 정책 | 기본값 | 오버라이드 |
|------|-------|-----------|
| 파일 보존 | 24h (`runtime/events/*.jsonl`) | `artibot.config.json`.observability.retentionHours |
| WS 히스토리 | 마지막 500 envelope | `.observability.wsHistoryCount` |
| 대용량 payload | 16KB 초과 시 `"truncated": true` 마커 + SHA1 참조 | `.observability.maxPayloadBytes` |

24h 경과 파일은 세션 시작 시 `SessionStart` 훅에서 cleanup 스위프 1회 (비용 적음).

### Step 7: Privacy / Redaction

`lib/core/redaction.js`의 `redactObject`를 payload에 적용합니다.

| 대상 | 마스킹 형태 |
|------|------------|
| API 키 패턴 | `<REDACTED_TOKEN>` |
| 파일 경로 (유저 홈 포함) | `<REDACTED_PATH>` |
| 긴 prompt 원문 | head 160 + tail 40 + `<TRUNCATED>` |
| 이메일 | `<REDACTED_EMAIL>` |

UserPromptSubmit/PreToolUse/PostToolUse 세 이벤트는 redaction 필수. Session-level 메타는 redaction 생략 가능.

## Workflow Checklist

```
Progress:
- [ ] Step 1: 12 이벤트 타입을 envelope로 정규화
- [ ] Step 2: 스키마 버전 v=1 고정, timestamp/sessionId/event/payload 필수
- [ ] Step 3: event-emitter.mjs 훅 (stdin → redact → append → stdout continue)
- [ ] Step 4: WebSocket 브로드캐스터 127.0.0.1 바인딩 확인
- [ ] Step 5: JSONL fallback 경로 runtime/events/YYYY-MM-DD.jsonl
- [ ] Step 6: Retention 24h sweep을 SessionStart에 연결
- [ ] Step 7: UserPrompt/Pre/PostToolUse payload redaction 통과
- [ ] Step 8: 대시보드에서 envelope 구독 → 시계열/히스토그램 렌더
```

## Quick Reference

| 요소 | 값 / 경로 |
|------|-----------|
| Envelope 버전 | `v: 1` |
| Hook 스크립트 | `plugins/artibot/scripts/hooks/event-emitter.mjs` |
| JSONL 큐 | `runtime/events/YYYY-MM-DD.jsonl` |
| WS 포트 (기본) | `45734` (localhost only) |
| Retention | 24h |
| Redaction | `lib/core/redaction.js` → `redactObject` |
| 스키마 상세 | `skills/hook-event-emitter/references/dashboard-schema.md` |

## Anti-Patterns

| Anti-pattern | 왜 금지 |
|--------------|--------|
| 외부 SaaS로 이벤트 전송 (Datadog / NewRelic / 타사 수집기) | Artibot 데이터 정책 위반. 모든 데이터는 로컬 내부 전용 |
| WS 서버를 `0.0.0.0`에 바인딩 | LAN에 노출. 반드시 `127.0.0.1` 고정 |
| 인증 없이 공개 포트 오픈 | 동일 머신의 다른 프로세스가 훔쳐봄. 토큰 파일 권한 0600 |
| Retention 무제한 | 디스크 팽창 + 장기 로그는 감사용이 아니라 관측용 |
| Payload 원본을 redaction 없이 저장 | 시크릿·개인정보 유출 위험 |
| 훅에서 WS 전송을 동기 await | 훅 지연 → 유저 경험 저하. fire-and-forget + 타임아웃 |
| Stdout에 envelope 쓰기 | Claude Code hook 규약 위반 — stdout은 제어용(`continue`) 전용 |
| 큰 payload 무제한 기록 | JSONL 한 줄이 MB 단위면 대시보드 파서가 블록됨. 16KB 초과 시 truncate |

## Rationalizations

| Excuse | Rebuttal |
|--------|----------|
| "외부 수집기가 더 편한데" | 데이터 정책상 외부 전송 0건. 로컬 대시보드로 동일 관측 가능 |
| "retention 24h는 너무 짧다" | 장기 보존은 `runtime/audit/`의 의무 로그가 담당. 관측용은 단기가 정답 |
| "localhost인데 인증 필요한가" | 동일 머신의 다른 툴이 붙을 수 있음 — 토큰 + 바인딩으로 이중 방어 |
| "redaction 나중에 붙여도 된다" | 한 번 JSONL에 평문 시크릿 들어가면 회수 불가. day-1부터 필수 |
| "WS 없이 파일만 쓰면 충분" | 파일만 쓰면 실시간성이 사라짐. WS는 옵션이지만 대시보드 UX를 결정 |
