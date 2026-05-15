# PRD — Telegram MCP Integration

**Status**: PRD only (구현 보류, 향후 결정 시 참조)
**Author**: Artibot team-artibot-perf-audit (audit + 사용자 협의)
**Date**: 2026-05-15
**Related**: v4.7.5 GitHub MCP (release tag) — same MCP integration framework

---

## 1. 배경 / Why

사용자는 articlaw 시스템에서 Telegram을 **개인 봇 / 1:1 채팅** 주환경으로 사용 중. Artibot도 같은 인프라(봇 1개 + PC 1대)로 두 시스템을 운영할 수 있다면 모바일에서 PC 작업을 트리거할 수 있다 — articlaw 패턴 차용.

A4 audit (flow-architect) 가 식별한 P2 항목. GitHub MCP (P1) 는 v4.7.5에서 채택 완료, Telegram은 사용자 결정에 따라 PRD만 작성한다.

---

## 2. Use Cases (7가지)

### One-way push (가장 안전, 즉시 가치)

| # | Use Case | 트리거 | 출력 채널 |
|---|---|---|---|
| 1 | **Autopilot 작업 알림** | 작업 완료 / 일시정지 / 오류 | 봇 → 사용자 1:1 chat |
| 2 | **Nightly trainer 결과** | nightly-grpo-trainer / nightly-session-rollup 완료 | 매일 아침 봇이 통계 게시 |
| 3 | **PR / Issue 알림 (GitHub MCP 결합)** | review 요청 / 완료 / CI 결과 | autopilot 자동 commit 시 즉시 알림 |
| 4 | **Daily / Weekly recap 자동 게시** | `/daily` 출력을 봇 채팅에 자동 push | 사용자가 명령 안 쳐도 매일 자동 |
| 5 | **Silent fail escalation** | swarm-sync 401, dev-verify-gate skip, autopilot pre-commit 실패 등 stderr | 봇으로 즉시 push (W4 P2 fix 강화) |

### Bidirectional (복잡, 신중)

| # | Use Case | 트리거 | 동작 |
|---|---|---|---|
| 6 | **Quick approve workflow** | autopilot이 commit/PR/배포 승인 대기 | 모바일에서 "Approve" 버튼 → MCP가 reply ingest → Artibot 진행 |
| 7 | **외부 trigger** | 사용자가 봇에 "PR #16 검토해줘" 같은 메시지 | Artibot agent 호출 → 결과 봇 reply (articlaw 패턴) |

---

## 3. 기술 스택

### Telegram MCP server 옵션

| 옵션 | 패키지 | 장점 | 단점 |
|---|---|---|---|
| (a) Community Telegram bot wrapper | `@modelcontextprotocol/server-telegram` 또는 community fork | npx zero-install 가능 | 공식 아님, 보안 검증 필요 |
| (b) 자체 구현 (articlaw 차용) | articlaw의 listener daemon 코드 재활용 | 사용자 환경과 동일 패턴, 검증된 코드 | 유지보수 부담 자체 |
| (c) Generic MCP HTTP transport | 사용자 PC에 별도 daemon 운영, MCP는 그것을 호출 | 분리된 책임 | 인프라 복잡 |

**권장**: (b) articlaw 차용 — 사용자 환경과 일치, 검증된 보안 패턴, 같은 봇 토큰 재사용 가능.

### 인증

- **Telegram Bot Token** (BotFather에서 생성)
- env var: `TELEGRAM_BOT_TOKEN`
- 보안: PAT 패턴과 동일 (`.env`에 두기, git commit 금지, .gitignore 명시)

### Allowed user filter

```
TELEGRAM_ALLOWED_USER_IDS=123456789  # 본인 user ID만
```

→ 모르는 사용자가 봇 ID 알아내도 메시지 처리 X. **필수 가드**.

---

## 4. 인프라 요건

### PC always-on 옵션

| 옵션 | 비용 | 사용성 | 권장 |
|---|---|---|---|
| (a) 개인 PC 24/7 ON | 전기/소음 | 즉시 응답 | 간단 시작 |
| (b) **홈서버 (Raspberry Pi)** | $50-100 일회 | 24/7 reliable | **권장** |
| (c) VPS (클라우드) | $5-20/월 | 어디서나 | 안정적 |
| (d) PC sleep 시 메시지 큐 대기 | 0 | PC 깰 때 처리 (지연 응답) | 가벼운 사용 |

**중요**: Telegram은 메시지를 일정 기간 보관 — PC sleep 중에도 메시지 잃지 않음. PC 깨면 listener가 묶음 처리. → (d) 도 현실적 옵션.

---

## 5. 보안 (필수 가드)

### 5.1 ALLOWED_USER_IDS 화이트리스트 (필수)

본인 텔레그램 user ID만 통과. 다른 사용자가 봇 ID 알아내도 메시지 처리 X.

```js
function isAllowedUser(userId) {
  const allowed = (process.env.TELEGRAM_ALLOWED_USER_IDS || '').split(',').map(s => s.trim());
  return allowed.includes(String(userId));
}
```

### 5.2 봇 토큰 .env 저장 (필수)

- `.env`에 `TELEGRAM_BOT_TOKEN=...` 명시
- `.gitignore`에 `.env` 이미 포함 (CLAUDE.md Git Safety Protocol)
- commit 시 자동 차단 (existing v4.7.2 git-autopilot --no-verify 가드 + dangerous-command Bash 가드)

### 5.3 명령 allowList (권장)

봇으로 실행 가능한 Artibot 명령 명시. 예:

```json
{
  "telegram": {
    "allowedCommands": ["/daily", "/ultrareview", "/audit-claude-md"],
    "blockedCommands": ["/install", "/permissions auto-yes"]
  }
}
```

→ 모바일에서 시스템 변경 명령 (`/install`, permission 변경) 차단.

### 5.4 Rate limiting (권장)

- 분당 메시지 5건 초과 시 자동 차단 (anti-spam)
- 1시간당 long-running 작업 (`/ultrareview`) 3건 초과 시 거부

### 5.5 Audit log

모든 봇 → Artibot 호출은 `runtime/telegram-audit.log`에 기록 (사용자 ID, 시각, 명령, 결과).

---

## 6. 채택 단계 (Phase)

### T1 — One-way push만 (최소 PoC, LOW 위험)

**범위**: Use case 1-5 (autopilot/nightly/silent fail/recap/PR 알림)

**구현**:
- `lib/telegram/sender.js` — 단순 `sendMessage(text)` API. fetch 1회.
- `scripts/hooks/{session-end, swarm-sync, auto-learning-check}.js` 등에서 stderr-style 호출
- 환경변수 `TELEGRAM_BOT_TOKEN` 미설정 시 자동 비활성

**효과**: 사용자가 모바일에서 PC 상태 즉시 인지. 작업 결과를 일일이 PC 보지 않아도 됨.

**risk**: 봇 토큰 유출 시 모르는 사람이 사용자에게 메시지 spam 가능 — `.env` 가드로 충분.

### T2 — Bidirectional / 외부 trigger (Use case 7, MED 위험)

**범위**: 사용자가 봇에 메시지 → Artibot agent 호출 → 결과 reply

**구현**:
- `bin/telegram-listener.mjs` — long-polling daemon (Telegram Bot API getUpdates)
- ALLOWED_USER_IDS 검증 + 명령 allowList 검사
- 메시지 → Claude Code CLI 또는 Claude API 호출 (articlaw 패턴)
- 결과를 봇으로 reply

**효과**: 모바일에서 PC 작업 트리거 가능. articlaw 사용자 패턴 그대로.

**risk**: 봇이 ingress 역할 → 권한·인증·anti-spam 필수. 5.1-5.5 가드 모두 필수.

### T3 — Quick approve (Use case 6, HIGH 위험)

**범위**: autopilot이 commit/PR/배포 승인 대기 → 모바일 버튼 승인

**구현**:
- T2 인프라 + autopilot integration
- inline keyboard ("Approve" / "Reject") 표시
- 사용자 응답 → autopilot 진행 또는 abort

**효과**: 모바일에서 PC 작업 승인. 사용자 in-the-loop autopilot.

**risk**: 잘못된 승인 시 되돌리기 어려움 — confirmation 2단계 필수, dry-run 모드 권장.

---

## 7. articlaw 패턴 활용

사용자가 이미 articlaw에서 텔레그램 봇 사용 중 → **같은 인프라 재활용**:

- 봇 1개 + PC 1대로 articlaw + Artibot 둘 다 운영
- articlaw용 listener daemon에 Artibot 명령 라우팅 추가만 하면 됨
- ALLOWED_USER_IDS 동일 (본인)
- 명령 prefix로 구분 (`/aw <명령>` = articlaw, `/ab <명령>` = artibot)

---

## 8. 결정 보류 사유 (현재 시점)

- GitHub MCP (v4.7.5) PoC 검증 우선 — 사용자가 실제 PAT setup 후 사용 빈도 측정
- Telegram T1만 채택 시도 후 T2/T3 결정
- articlaw 인프라 재활용 가능 — 별도 구현 부담 작음, 결정 시 빠른 PoC 가능

## 9. 향후 의사결정 트리거

다음 중 하나가 발생하면 PRD를 spec으로 promote:

1. 사용자가 모바일에서 작업 트리거 필요성 명시 (`/ultrareview` 모바일 호출 등)
2. autopilot 모드 사용 빈도 증가 → 작업 완료 알림 필요
3. nightly trainer 결과 매일 아침 자동 게시 요구
4. articlaw 인프라 변경으로 listener daemon 재구성 — Artibot 통합 같이

---

## 10. 비-목표 (out of scope)

- Telegram **multi-tenant** 운영 (사용자별 봇 분리) — 개인용 단일 봇만
- Telegram **group chat** 지원 — 1:1 chat만 (보안)
- Telegram **stickers / media** 처리 — text-only
- Telegram **payment / inline mode** — 비기능 무관
- 텔레그램 봇 **공개 마켓플레이스 등록** — 개인 봇 (BotFather에서 생성, 비공개)

---

## 부록 A: 참조

- Telegram Bot API: https://core.telegram.org/bots/api
- BotFather: @BotFather (텔레그램 봇 생성)
- articlaw 시스템 (사용자 주환경): articlaw memory MEMORY.md 참조
- v4.7.5 GitHub MCP release: https://github.com/Yoodaddy0311/artibot/releases/tag/v4.7.5
- A4 audit (flow-architect) 보고: PR #16 description 또는 commit 92693b1

## 부록 B: 변경 이력 (PRD)

| 날짜 | 변경 | 비고 |
|---|---|---|
| 2026-05-15 | 초안 작성 | 사용자 요청, 구현 보류 |
