---
description: (Artibot) Interactive setup wizard — language, dev environment, Agent Teams, MCP servers, permissions, Git automation
argument-hint: '[step] e.g. "language" | "git" | "permissions" — or no argument to run full wizard'
allowed-tools: [Read, Write, Edit, Bash, Glob]
toolset: meta
---

# /setup

Artibot 초기 설정 인터랙티브 위저드. 6단계를 순서대로 안내하며 각 설정 파일을 직접 수정한다.

## Arguments

Parse $ARGUMENTS:
- (no argument): Run full 6-step wizard
- `language` / `lang`: Jump to Step 1 — language selection only
- `env`: Jump to Step 2 — development environment only
- `teams`: Jump to Step 3 — Agent Teams & Swarm only
- `permissions` / `perms`: Jump to Step 4 — permissions only
- `mcp`: Jump to Step 5 — MCP servers only
- `git`: Jump to Step 6 — Git automation only
- `--reset`: Reset all settings to defaults before running wizard
- `--dry-run`: Show current settings without modifying files

## Steps

### Full Wizard (no argument)

Run all 6 steps in order. Each step can be skipped by pressing Enter.

```
Artibot Setup Wizard (6단계)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
각 단계에서 엔터를 누르면 기본값이 유지됩니다.
```

#### Step 1 — 언어 (Language)
수정 파일: `~/.claude/artibot/CLAUDE.local.md`
- 한국어 / English / 日本語 중 선택
- 선택한 언어 라인 주석 해제, 나머지 주석 처리

#### Step 2 — 개발 환경 (Dev Environment)
수정 파일: `~/.claude/artibot/CLAUDE.local.md`
- 로컬 서버 URL, API 엔드포인트, DB 연결, 에디터 선택
- 입력된 값만 주석 해제, 빈 입력은 주석 유지

#### Step 3 — Agent Teams & Swarm
수정 파일: `~/.claude/settings.json`, `~/.claude/artibot/artibot.config.json`
- Agent Teams 활성화 여부 (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`)
- Swarm opt-in 여부 (`swarm.enabled`, `swarm.optIn`)

#### Step 4 — 권한 (Permissions)
수정 파일: `~/.claude/settings.json`
- 추가 허용 도구 입력 (기존 목록에 추가만, 제거 금지)
- `dangerouslySkipPermissions` 활성화 — 반드시 사용자 확인 후 설정
- ⚠️ 권한 변경은 Human Checkpoint 필수

#### Step 5 — MCP 서버
수정 파일: `~/.claude/artibot/.mcp.json`
- Context7: 라이브러리 공식 문서 조회
- Playwright: 브라우저 자동화 / E2E 테스트
- 비활성화 선택 시 해당 서버 항목 제거

#### Step 6 — Git 자동화
수정 파일: `~/.claude/artibot/git-autopilot.json`
- 수동 / Safe (커밋 자동, 푸시 확인) / Full (전체 자동) 중 선택
- Full 모드 선택 시 Human Checkpoint 필수

## Execution Flow

1. **Parse**: `$ARGUMENTS` 확인 — 전체 위저드 또는 특정 단계 점프
2. **Current State**: `--dry-run` 시 각 파일 현재값 표시
3. **Step-by-Step**: 각 단계 안내 → 입력 수집 → 파일 수정
4. **Validate**: JSON 파일 수정 후 파싱 유효성 확인
5. **Report**: 변경된 파일 목록 출력

## Security Rules

- 기존 `permissions.allow` 항목 절대 제거 금지
- `dangerouslySkipPermissions` 는 사용자 명시 확인 후에만 설정
- API 키 값 직접 기록 금지

## Output Format

```
SETUP WIZARD
============
Step:    [1-6 / 현재 단계]
Status:  [IN PROGRESS / COMPLETE / SKIPPED]

변경 사항:
  [파일명] — [변경 내용 요약]

다음 단계:
  [다음 스텝 안내 또는 완료 메시지]
```

## Next Steps

설정 완료 후 추천 후속 액션:

| # | 액션 | 커맨드 | 설명 |
|---|------|--------|------|
| 1 | Claude Code 재시작 | — | 설정 적용을 위해 필요 |
| 2 | 빠른 시작 가이드 | `/quickstart` | Artibot 주요 기능 소개 |
| 3 | 사용 가능한 커맨드 보기 | `/index` | 전체 커맨드 목록 |
| 4 | 첫 작업 시작 | `/sc [요청]` | Artibot 라우터로 시작 |
