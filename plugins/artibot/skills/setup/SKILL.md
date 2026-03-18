---
context: forked
name: setup
description: |
  Artibot 초기 설정 인터랙티브 위저드 — 언어, 개발 환경, Agent Teams, MCP 서버, 권한, Git 자동화를 단계별로 안내.
  Auto-activates when: first install, setup wizard, artibot 설정, initial configuration.
  Triggers: /setup, /artibot setup, setup wizard, 초기 설정, artibot 설정
platforms: [claude-code]
level: 1
triggers:
  - "/setup"
  - "setup wizard"
  - "초기 설정"
  - "artibot 설정"
  - "initial setup"
  - "artibot setup"
agents: []
tokens: 2000
category: setup
---

# Artibot Setup Wizard

## 목적

Artibot을 처음 설치하거나 설정을 초기화할 때 사용하는 인터랙티브 위저드.
6단계를 순서대로 안내하며, 각 단계에서 수정하는 파일을 명시한다.
모든 단계는 건너뛸 수 있다 (엔터 → 기본값 유지).

---

## Activation

다음 중 하나 입력 시 즉시 시작:
- `/setup`
- `/artibot setup`
- "Artibot 초기 설정" / "setup wizard"

시작 메시지:
```
Artibot Setup Wizard (6단계)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
각 단계에서 엔터를 누르면 기본값이 유지됩니다.
언제든 "건너뛰기" 또는 "skip"을 입력하면 해당 단계를 건너뜁니다.
```

---

## Workflow

### Step 1 — 언어 설정
**수정 파일**: `~/.claude/artibot/CLAUDE.local.md`

```
[Step 1/6] 응답 언어를 선택하세요:
  1) 한국어 (기본값)
  2) English
  3) 日本語
  > _
```

**동작**:
- `CLAUDE.local.md` → `## Communication Language` 섹션에서
  선택한 언어 라인의 `<!-- -->` 주석을 제거하고 나머지 라인은 주석 처리
- 변경 예시 (한국어 선택):
  ```
  Respond in Korean (한국어로 응답해주세요)
  <!-- Respond in English -->
  <!-- Respond in Japanese (日本語で応답してください) -->
  ```

---

### Step 2 — 개발 환경
**수정 파일**: `~/.claude/artibot/CLAUDE.local.md`

```
[Step 2/6] 개발 환경을 설정하세요 (건너뛰려면 엔터):

  로컬 서버 URL [http://localhost:3000]: _
  API 엔드포인트 []: _
  DB 연결 문자열 []: _
  에디터 선택:
    1) VS Code (기본값)
    2) Cursor
    3) Zed
    4) 기타
  > _
```

**동작**:
- `CLAUDE.local.md` → `## Development Environment` 섹션 언커멘트 후 값 채우기
- `## Editor Integration` 섹션 선택한 에디터 라인 언커멘트
- 빈 입력 시 해당 항목 주석 유지

---

### Step 3 — Agent Teams & Swarm
**수정 파일**: `~/.claude/settings.json`, `~/.claude/artibot/artibot.config.json`

```
[Step 3/6] Agent Teams 설정:

  Agent Teams (에이전트 병렬 협업, 실험적 기능):
    1) 활성화 (권장) — settings.json CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
    2) 비활성화
  > _

  Swarm (인스턴스 간 패턴 공유):
    1) 비참여 (기본값, 프라이버시 우선)
    2) 참여 (opt-in) — 집단 학습에 기여
  > _
```

**동작**:
- `~/.claude/settings.json` → `env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` 값 설정
- `artibot.config.json` → `team.enabled`, `swarm.enabled`, `swarm.optIn` 업데이트

---

### Step 4 — 권한 (Permissions)
**수정 파일**: `~/.claude/settings.json`

```
[Step 4/6] 권한(Permission) 설정:

  현재 허용된 도구: Read, Write, Edit, Bash, Glob, Grep, WebFetch, WebSearch

  추가 허용 도구 (쉼표로 구분, 건너뛰려면 엔터):
    예시: mcp__playwright, mcp__context7
  > _

  Bypass permissions (위험 — 모든 도구 자동 승인):
    ⚠️  dangerouslySkipPermissions: 모든 확인 없이 실행됨. 신뢰할 수 있는 환경에서만 사용.
    1) 비활성화 (기본값, 권장)
    2) 활성화 (주의 필요)
  > _
```

**동작**:
- `~/.claude/settings.json` → `permissions.allow` 배열에 선택한 도구 추가
- bypass 활성화 시 `dangerouslySkipPermissions: true` 추가 + 경고 메시지 출력
- **절대 기존 허용 목록은 제거하지 않음** (추가만 가능)

---

### Step 5 — MCP 서버
**수정 파일**: `~/.claude/artibot/.mcp.json`

```
[Step 5/6] MCP 서버 설정:

  Context7 (라이브러리 공식 문서 조회):
    1) 활성화 (기본값)
    2) 비활성화
  > _

  Playwright (브라우저 자동화 / E2E 테스트):
    1) 활성화 (기본값)
    2) 비활성화
  > _
```

**동작**:
- 비활성화 선택 시 `.mcp.json` → `mcpServers` 에서 해당 서버 항목 제거
- 활성화 유지 시 변경 없음
- `.mcp.json` 상단의 `$comment` 주석 보존

---

### Step 6 — Git 자동화
**수정 파일**: `~/.claude/artibot/git-autopilot.json` (없으면 생성)

```
[Step 6/6] Git 자동화 수준 선택:

  1) 수동 (기본값) — Git 명령을 직접 실행
  2) Safe 자동화 — 스테이징+커밋 자동, 푸시는 확인 후
  3) Full 자동화 — 스테이징+커밋+푸시 전체 자동
     ⚠️  충돌 자동 해결 시도 (safe_both/safe_ours 전략 사용)
  > _

  (2 또는 3 선택 시)
  자동 커밋 메시지 prefix [wip]: _
  제외 경로 (glob, 쉼표 구분) [*.env,*.secret]: _
```

**동작**:
- `~/.claude/artibot/git-autopilot.json` 생성 또는 업데이트:
  ```json
  {
    "enabled": true,
    "mode": "safe",
    "autoCommit": true,
    "autoPush": false,
    "autoMerge": false,
    "commitPrefix": "wip",
    "excludePaths": ["*.env", "*.secret"]
  }
  ```
- Full 모드: `autoPush: true`, `autoMerge: true`
- 수동 선택 시 파일 생성 안 함 (또는 `enabled: false`)

---

## 완료 메시지

```
✓ Setup 완료! 변경된 파일:

  ~/.claude/artibot/CLAUDE.local.md    — 언어: [선택값], 에디터: [선택값]
  ~/.claude/settings.json              — Agent Teams: [on/off], 추가 도구: [목록]
  ~/.claude/artibot/artibot.config.json — Swarm: [on/off]
  ~/.claude/artibot/.mcp.json          — Context7: [on/off], Playwright: [on/off]
  ~/.claude/artibot/git-autopilot.json — Git: [수동/Safe/Full]

Claude Code를 재시작하면 설정이 적용됩니다.
다시 설정하려면 /setup 을 실행하세요.
```

---

## Human Checkpoints

### Checkpoint 1: 권한 변경 확인 (Step 4 후)
**Context**: `dangerouslySkipPermissions` 또는 새 도구 권한 추가 직전. 권한 변경은 보안에 직접 영향을 미친다.
**Ask**: "다음 권한을 `settings.json`에 추가합니다. 계속할까요? `[변경 내용 요약]`"
**Options**:
1. 확인 — 권한 추가 진행
2. 취소 — 이 단계 건너뜀
**Skippable**: No — 권한 추가는 되돌리기 어렵고 보안에 영향
**Freedom**: LOW

### Checkpoint 2: Git Full 자동화 확인 (Step 6 후)
**Context**: Full autopilot 활성화 직전. 자동 푸시 + 자동 머지는 원격 브랜치에 영향.
**Ask**: "Git Full 자동화를 활성화합니다. 자동 푸시와 자동 충돌 해결이 포함됩니다. 계속할까요?"
**Options**:
1. 확인 — Full 모드 활성화
2. Safe 모드로 변경 — autoPush/autoMerge=false 유지
**Skippable**: No — 원격 브랜치 영향 가능
**Freedom**: LOW

---

## Checklist

- [ ] 6단계 모두 완료 또는 명시적 건너뜀
- [ ] 수정된 파일 목록이 완료 메시지에 출력됨
- [ ] JSON 파일 수정 시 파싱 유효성 확인 (malformed JSON 방지)
- [ ] `CLAUDE.local.md` 주석 형식(`<!-- -->`) 보존
- [ ] `settings.json` 기존 `permissions.allow` 항목 유지 (추가만, 삭제 금지)
- [ ] `dangerouslySkipPermissions` 활성화 시 경고 메시지 출력

---

## Guardrails

- `settings.json` 내 기존 `permissions.allow` 목록은 절대 제거하지 않음
- API 키 값은 파일에 직접 기록 금지 (참조 라벨만 허용)
- 기존 설정 값은 덮어쓰기 전 현재값 표시 후 확인
- `.mcp.json` 수정 시 `$comment` 주석 보존
- `dangerouslySkipPermissions` 는 반드시 사용자 명시 확인 후에만 설정
- 위저드 중 오류 발생 시 해당 단계 건너뛰고 계속 진행 (전체 중단 금지)

## Quick Reference

수동으로 수정할 파일 위치:
- 언어/에디터: `~/.claude/artibot/CLAUDE.local.md`
- Agent Teams/권한: `~/.claude/settings.json`
- Swarm/모델: `~/.claude/artibot/artibot.config.json`
- MCP: `~/.claude/artibot/.mcp.json`
- Git 자동화: `~/.claude/artibot/git-autopilot.json`
