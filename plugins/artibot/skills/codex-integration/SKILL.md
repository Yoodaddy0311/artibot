---
context: fork
name: codex-integration
description: "Provides codex-plugin-cc integration workflow for cross-checking, development delegation, and idea generation with OpenAI Codex. Use when user asks about Codex, cross-check, 크로스체크, OpenAI CLI, dual-AI review, or wants to delegate tasks to Codex."
lang: [en, ko]
platforms: [claude-code]
level: progressive
level1_tokens: 200
level2_tokens: 2500
triggers:
  - "codex"
  - "코덱스"
  - "cross-check"
  - "크로스체크"
  - "openai"
  - "dual review"
  - "codex-plugin-cc"
category: "integration"
risk: safe
agents:
  - "code-reviewer"
  - "security-reviewer"
tokens: "~2.5K"
source_hash: d07e8a1b
whenNotToUse: "Single-AI workflows where codex-plugin-cc is not installed or OpenAI CLI is unavailable; do not apply when the user is not running a dual-AI (Artibot + Codex) setup."
---

# Codex Plugin Integration (codex-plugin-cc)

## When This Skill Applies
- Setting up codex-plugin-cc alongside Artibot
- Running cross-check reviews (Artibot + Codex in parallel)
- Delegating development tasks to Codex via rescue mode
- Requesting architecture/design ideas from Codex
- Configuring dual-AI review workflows
- Troubleshooting codex-plugin-cc issues (socket, hooks, broker)

## Architecture

Artibot `/codex` 커맨드는 **얇은 라우터 + 모드 관리**만 담당한다.
실제 Codex 실행은 **codex-plugin-cc** (별도 Claude Code 플러그인)에 위임한다.

```
Artibot /codex (라우터)
  ├── 상태 확인 (pluginPath, CLI, API 키, 모드)
  ├── 모드 관리 (artibot.config.json)
  └── 실행 위임 → codex-plugin-cc
                    ├── codex review (코드 리뷰)
                    ├── codex rescue (개발 위임)
                    └── codex (인터랙티브)
```

## Core Guidance

**Modes**:
| Mode | Description | Use Case |
|------|-------------|----------|
| `off` | All integration disabled (default) | No Codex needed |
| `review` | Cross-check only | Stop-Review-Gate에서 Codex 활성화 |
| `dev` | Review + task delegation | Codex에 rescue/implement 태스크 위임 가능 |

**Cross-Check Workflow**:
```
User triggers /codex review
    ├── Artibot code-reviewer (parallel, TaskCreate)
    └── codex-plugin-cc review (parallel, Bash)
         ↓
    Result merge:
    - Deduplicate (same file:line + similar message)
    - Keep highest severity
    - Tag source: [Artibot] / [Codex] / [Both]
    - Highlight disagreements
```

**Configuration** (`artibot.config.json`):
```json
{
  "codex": {
    "mode": "off",
    "pluginPath": "",
    "defaultModel": "o4-mini",
    "timeout": 60000,
    "reviewOnStop": false,
    "warning": "코드가 OpenAI API로 전송됩니다. 민감 프로젝트에 주의하세요."
  }
}
```

**Data Policy**:
- review/dev 모드 사용 시 코드가 OpenAI API로 전송됨
- `.env`, credentials, `*.pem` 파일은 자동 제외
- Artibot DATA POLICY: 외부 DB 접근/전송 절대 금지

## Setup Requirements

1. **codex-plugin-cc**: `git clone https://github.com/openai/codex-plugin-cc.git ~/.claude/plugins/codex-plugin-cc`
2. **Codex CLI**: `npm install -g @openai/codex` 또는 `npx @openai/codex`
3. **API Key**: `OPENAI_API_KEY` 환경변수 설정
4. **Plugin Path**: `artibot.config.json` → `codex.pluginPath` 설정
5. **Mode**: `/codex mode review` 또는 `/codex mode dev`

## Commands

| Command | Description |
|---------|-------------|
| `/codex` | 상태 확인 (플러그인, CLI, API 키, 모드) |
| `/codex setup` | codex-plugin-cc 설치 & 설정 가이드 |
| `/codex mode [review\|dev\|off]` | 모드 설정 |
| `/codex review [scope]` | 즉시 크로스체크 |
| `/codex idea [topic]` | rescue 기능으로 아이디어 요청 |

## Known Issues & Troubleshooting

| Issue | Cause | Solution |
|-------|-------|----------|
| Windows socket 실패 | codex-plugin-cc broker가 Unix domain socket 사용 | WSL2에서 실행하거나 named pipe 패치 대기 |
| Hook 충돌 | Artibot + codex-plugin-cc 모두 Stop/SessionStart 훅 사용 | 훅 우선순위 설정 또는 체이닝 |
| Broker 좀비 프로세스 | 세션 종료 후 broker 미정리 | `ps aux \| grep codex` 후 수동 종료 |
| `codex: command not found` | CLI 미설치 | `npm install -g @openai/codex` 실행 |
| API key 오류 | `OPENAI_API_KEY` 미설정 | `echo $OPENAI_API_KEY` 확인, 환경변수 설정 |
| 타임아웃 | 기본 60초 초과 | `codex.timeout` 값 증가 |
| 네트워크 오류 | OpenAI API 접근 불가 | Artibot 단독 리뷰로 폴백 |
| review 모드인데 리뷰 안 됨 | 모드 미설정 | `artibot.config.json` → `codex.mode` 확인 |
| 플러그인 경로 오류 | pluginPath 미설정/잘못됨 | `/codex setup` 재실행 |

## Integration with Stop-Review-Gate

review/dev 모드 활성화 시, Stop-Review-Gate 훅에서 자동으로 Codex 리뷰가 트리거된다:
1. Artibot 코드 리뷰 완료
2. `codex.reviewOnStop === true` 확인
3. codex-plugin-cc의 review 기능 실행
4. 결과 통합 후 게이트 판정

**Hook 충돌 주의**: Artibot과 codex-plugin-cc 모두 `Stop` 이벤트를 구독하므로,
실행 순서를 `hooks.json`에서 명시적으로 관리해야 한다.

## Quick Reference
- 기본 모드: `off` (명시적 활성화 필요)
- 기본 모델: `o4-mini` (비용 효율적)
- 타임아웃: 60초 (설정 가능)
- 플러그인: codex-plugin-cc (별도 Claude Code 플러그인)
- 민감 파일 자동 제외: `.env`, `*.pem`, `credentials.*`
- Artibot 단독 리뷰 폴백: Codex 오류 시 자동

## Rationalizations

The following table captures common excuses agents make to skip the rigor of this skill, paired with factual rebuttals.

| Excuse | Rebuttal |
|--------|----------|
| "Codex and Claude will just agree" | the whole point is disagreement — convergence without divergence means one of them skipped thinking |
| "I will skip cross-check for simple tasks" | simple tasks are where blind spots hide; cross-check costs little and catches a lot |
| "Codex does not know our codebase" | fresh-eyes review beats codebase-blind agreement; feed it the relevant files and listen |
| "two LLMs double the hallucinations" | two independent LLMs narrow the hallucination surface — agreement is weak but disagreement is strong signal |
| "integration is too much overhead" | the plugin handles transport; your overhead is one command invocation |
