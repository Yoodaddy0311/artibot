---
context: fork
name: codex-integration
description: "Provides Codex CLI integration workflow for cross-checking, development delegation, and idea generation with OpenAI Codex. Use when user asks about Codex, cross-check, 크로스체크, adversarial review, OpenAI CLI, dual-AI review, or wants to delegate tasks to Codex."
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
  - "adversarial review"
  - "적대적 리뷰"
category: "integration"
risk: safe
agents:
  - "code-reviewer"
  - "security-reviewer"
tokens: "~2.5K"
---

# Codex CLI Integration

## When This Skill Applies
- Setting up Codex CLI alongside Artibot
- Running cross-check reviews (Artibot + Codex in parallel)
- Delegating development tasks to Codex
- Requesting architecture/design ideas from Codex
- Configuring dual-AI review workflows

## Core Guidance

**Modes**:
| Mode | Description | Use Case |
|------|-------------|----------|
| `off` | All integration disabled (default) | No Codex needed |
| `review` | Cross-check only | Stop-Review-Gate에서 Codex 활성화 |
| `dev` | Review + task delegation | Codex에 직접 개발 태스크 위임 가능 |

**Cross-Check Workflow**:
```
User triggers review
    ├── Artibot code-reviewer (parallel)
    └── Codex CLI review (parallel)
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
    "defaultModel": "o4-mini",
    "timeout": 60000,
    "reviewOnStop": false
  }
}
```

**Data Policy**:
- review/dev 모드 사용 시 코드가 OpenAI API로 전송됨
- `.env`, credentials, `*.pem` 파일은 자동 제외
- Artibot DATA POLICY: 외부 DB 접근/전송 절대 금지
- `.codexignore` 파일로 전송 제외 대상 추가 가능

## Setup Requirements

1. **Codex CLI**: `npm install -g @openai/codex` 또는 `npx @openai/codex`
2. **API Key**: `OPENAI_API_KEY` 환경변수 설정
3. **Mode**: `/codex mode review` 또는 `/codex mode dev`

## Commands

| Command | Description |
|---------|-------------|
| `/codex` | 상태 확인 (CLI, API 키, 모드) |
| `/codex setup` | 설치 & 로그인 가이드 |
| `/codex mode [review\|dev\|off]` | 모드 설정 |
| `/codex review [scope]` | 즉시 크로스체크 |
| `/codex idea [topic]` | 아이디어 요청 |

## Troubleshooting

| Issue | Solution |
|-------|----------|
| `codex: command not found` | `npm install -g @openai/codex` 실행 |
| API key 오류 | `echo $OPENAI_API_KEY` 로 환경변수 확인 |
| 타임아웃 | `codex.timeout` 값 증가 (기본 60초) |
| 네트워크 오류 | Artibot 단독 리뷰로 폴백 |
| 권한 오류 | `codex auth login` 으로 재인증 |
| review 모드인데 리뷰 안 됨 | `artibot.config.json` → `codex.mode` 값 확인 |

## Integration with Stop-Review-Gate

review/dev 모드 활성화 시, Stop-Review-Gate 훅에서 자동으로 Codex 리뷰가 트리거된다:
1. Artibot 코드 리뷰 완료
2. `codex.reviewOnStop === true` 확인
3. Codex CLI로 동일 scope 리뷰 실행
4. 결과 통합 후 게이트 판정

## Quick Reference
- 기본 모드: `off` (명시적 활성화 필요)
- 기본 모델: `o4-mini` (비용 효율적)
- 타임아웃: 60초 (설정 가능)
- 민감 파일 자동 제외: `.env`, `*.pem`, `credentials.*`
- Artibot 단독 리뷰 폴백: Codex 오류 시 자동
