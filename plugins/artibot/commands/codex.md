---
context: fork
name: codex
description: "(Artibot) Codex 플러그인 연동 — 크로스체크, 개발 위임, 아이디어 생성 (codex-plugin-cc 기반)"
disable-model-invocation: true
argument-hint: '[action] e.g. "setup" | "mode review" | "review src/" | "idea caching"'
allowed-tools: [Read, Write, Edit, Bash, Glob, Grep, TaskCreate]
arguments:
  - action: "setup | mode | review | idea | (빈값=status)"
  - target: "모드명 또는 리뷰 대상"
---

# /codex

OpenAI Codex 연동 커맨드. **codex-plugin-cc** Claude Code 플러그인을 통해 Codex를 활용한다.
Artibot `/codex` 커맨드는 얇은 라우터 + 모드 관리만 담당하고, 실제 Codex 실행은 codex-plugin-cc에 위임한다.

## Architecture

```
/codex (Artibot 커맨드)
  ├── 모드 관리 (artibot.config.json)
  ├── 상태 확인 (플러그인 설치 여부, API 키, 모드)
  └── 라우팅 → codex-plugin-cc (별도 Claude Code 플러그인)
                  ├── codex review
                  ├── codex rescue
                  └── codex (interactive)
```

## Arguments

Parse $ARGUMENTS:
- (no argument): 상태 확인 — codex-plugin-cc 설치 여부, 현재 모드, 연결 상태
- `setup`: codex-plugin-cc 설치 & API 키 설정 가이드
- `mode [review|dev|off]`: 연동 모드 설정
- `review [scope]`: 즉시 크로스체크 실행
- `idea [topic]`: Codex rescue 기능 활용 아이디어 요청
- `--verbose`: 상세 출력

## Subcommands

### `/codex` (인수 없음) — 상태 확인

현재 Codex 연동 상태를 확인한다.

1. codex-plugin-cc 설치 여부 확인:
   - `codex.pluginPath` 경로 존재 확인
   - 또는 `which codex 2>/dev/null` / `npx codex --version 2>/dev/null`
2. 현재 모드 확인: `artibot.config.json` → `codex.mode` 읽기
3. 연결 상태: `OPENAI_API_KEY` 환경변수 존재 여부
4. 기본 모델: `codex.defaultModel` 값

출력:
```
CODEX STATUS
============
Plugin:    [설치됨 (codex-plugin-cc) | 미설치]
Path:      [pluginPath 또는 "미설정"]
CLI:       [설치됨 (v1.x) | 미설치]
API Key:   [설정됨 | 미설정]
Mode:      [off | review | dev]
Model:     [o4-mini | 기타]
Timeout:   [60000ms]
ReviewOn:  [Stop-Review-Gate 활성/비활성]
```

### `/codex setup` — 설치 & 설정 가이드

codex-plugin-cc 설치 및 인증을 단계별로 안내한다.

**Step 1 — codex-plugin-cc 플러그인 설치**:
```bash
# Option A: git clone
git clone https://github.com/openai/codex-plugin-cc.git ~/.claude/plugins/codex-plugin-cc

# Option B: npm (if published)
npm install -g @openai/codex
```

**Step 2 — Codex CLI 설치 확인**:
```bash
# 글로벌 설치
npm install -g @openai/codex

# 또는 npx로 사용 (설치 없이)
npx @openai/codex --version
```

**Step 3 — API 키 설정**:
- `OPENAI_API_KEY` 환경변수 설정 안내
- 또는 `codex auth login` 으로 인터랙티브 로그인
- 키 검증: `codex --version` 실행으로 연결 확인

**Step 4 — 플러그인 경로 설정**:
```json
// artibot.config.json → codex.pluginPath
{
  "codex": {
    "pluginPath": "~/.claude/plugins/codex-plugin-cc"
  }
}
```

**Step 5 — 데이터 정책 경고**:
```
⚠️ DATA POLICY WARNING
━━━━━━━━━━━━━━━━━━━━━━
review/dev 모드 사용 시 코드가 OpenAI API로 전송됩니다.
- 민감한 코드(API 키, 비밀번호, 내부 비즈니스 로직)에 주의하세요
- Artibot DATA POLICY: 외부 DB 접근/전송은 절대 금지
- 민감 프로젝트에서는 mode off를 유지하세요
```

**Step 6 — 연결 테스트**:
```bash
codex --version && echo "Codex CLI ready"
```

### `/codex mode [review|dev|off]` — 모드 설정

Codex 연동 모드를 설정하고 `artibot.config.json`에 저장한다.

| 모드 | 설명 | 동작 |
|------|------|------|
| `off` | 모든 연동 비활성화 | Codex 호출 없음 (기본값) |
| `review` | 크로스체크 전용 | Stop-Review-Gate에서 Codex 활성화, 적대적 리뷰 |
| `dev` | review + 개발 위임 | 위 + Codex에 직접 개발 태스크 위임 (rescue, implement) |

설정 저장:
```json
// artibot.config.json → codex 섹션
{
  "codex": {
    "mode": "[선택한 모드]",
    "reviewOnStop": true  // review/dev 모드 시 자동 true
  }
}
```

모드 변경 시 안내:
- `off → review`: "크로스체크 모드 활성화. Stop-Review-Gate에서 Codex 리뷰가 실행됩니다."
- `off → dev`: "개발 위임 모드 활성화. 크로스체크 + 태스크 위임이 가능합니다."
- `review/dev → off`: "Codex 연동이 비활성화되었습니다."

### `/codex review [scope]` — 즉시 크로스체크

Artibot code-reviewer와 codex-plugin-cc의 review 기능을 병렬로 실행하여 크로스체크한다.

1. **전제 조건 확인**:
   - `codex.mode` 가 `review` 또는 `dev` 인지 확인
   - codex-plugin-cc 설치 여부 확인
   - `OPENAI_API_KEY` 설정 여부 확인
   - 미충족 시 `/codex setup` 안내

2. **Scope 결정**:
   - scope 없음: `git diff` 로 현재 변경사항 대상
   - scope 있음: 특정 파일/디렉토리 대상
   - `--staged`: staged 변경사항만 대상

3. **병렬 실행**:
   - **Artibot**: code-reviewer 에이전트로 리뷰 (TaskCreate)
   - **Codex**: `codex review [scope]` 실행 (Bash를 통해 codex-plugin-cc 트리거)
   - 두 결과를 동시에 수집

4. **결과 통합**:
   - 중복 이슈 제거 (동일 파일:라인 + 유사 메시지)
   - 최고 severity 유지 (critical > high > medium > low)
   - 출처 표시: `[Artibot]` / `[Codex]` / `[Both]`
   - 불일치 항목 하이라이트 (한쪽만 발견한 이슈)

출력:
```
CROSS-CHECK REVIEW
==================
Scope:     [파일/디렉토리 목록]
Artibot:   [n] issues found
Codex:     [n] issues found
Merged:    [n] unique issues

ISSUES
------
Sev    | File:Line        | Source    | Description
-------|------------------|-----------|------------
CRIT   | src/auth.js:42   | [Both]    | SQL injection vulnerability
HIGH   | src/api.js:15    | [Artibot] | Missing input validation
MEDIUM | src/utils.js:88  | [Codex]   | Unnecessary allocation

AGREEMENT: [n]% overlap
ARTIBOT-ONLY: [n] issues
CODEX-ONLY:   [n] issues
```

### `/codex idea [topic]` — 아이디어 요청

codex-plugin-cc의 rescue 기능을 활용하여 아이디어를 요청한다.

1. **전제 조건 확인**: `codex.mode`가 `dev`인지 확인 (review 모드에서는 불가)
2. **Codex rescue 실행**:
   ```bash
   codex "Given the project context, suggest ideas for: [topic]"
   ```
3. **응답 구조화**:
   ```
   CODEX IDEAS: [topic]
   ====================

   IDEA 1: [제목]
   ───────────────
   Description: [설명]
   Effort:      [LOW|MEDIUM|HIGH]
   Impact:      [LOW|MEDIUM|HIGH]
   Approach:    [구현 방향]

   IDEA 2: [제목]
   ───────────────
   ...
   ```

## Known Issues

codex-plugin-cc 사용 시 알려진 문제점:

| Issue | Description | Workaround |
|-------|-------------|------------|
| **Windows socket** | Unix domain socket → named pipe 호환성 이슈. codex-plugin-cc broker가 Unix socket을 사용하므로 Windows에서 연결 실패 가능 | WSL2 환경에서 실행하거나 named pipe 패치 대기 |
| **Hook 충돌** | Artibot과 codex-plugin-cc 모두 `Stop`, `SessionStart` 훅을 사용. 동시 등록 시 실행 순서 비결정적 | `artibot.config.json`에서 훅 우선순위 설정, 또는 Artibot 훅에서 Codex 훅을 명시적으로 체이닝 |
| **Broker 좀비** | codex-plugin-cc broker 프로세스가 세션 종료 후에도 남아있을 수 있음 | `ps aux | grep codex` 로 확인 후 수동 종료, 또는 SessionClose 훅에서 cleanup |
| **API 키 필수** | `OPENAI_API_KEY` 없으면 모든 Codex 기능 사용 불가 | `/codex setup`으로 키 설정 |

## Security Rules

1. **API 키 노출 금지**: `OPENAI_API_KEY` 값을 로그나 출력에 절대 포함하지 않음
2. **데이터 전송 경고**: review/dev 모드 활성화 시 매번 데이터 정책 안내
3. **민감 파일 제외**: `.env`, `credentials.*`, `*.pem` 파일은 Codex 전송 대상에서 자동 제외
4. **Artibot DATA POLICY 준수**: 외부 DB 접근/전송 절대 금지

## Error Handling

| 에러 | 처리 |
|------|------|
| codex-plugin-cc 미설치 | `/codex setup` 안내 |
| Codex CLI 미설치 | `npm install -g @openai/codex` 안내 |
| API 키 미설정 | 환경변수 설정 가이드 |
| Codex 타임아웃 | `codex.timeout` 값 안내, Artibot 결과만 표시 |
| 네트워크 오류 | 오프라인 모드 폴백, Artibot 단독 리뷰 |
| 모드 off에서 review 시도 | 모드 변경 안내 |
| Hook 충돌 감지 | 훅 실행 순서 안내, 수동 설정 가이드 |
| Broker 좀비 프로세스 | cleanup 명령 안내 |

## Next Steps

작업 완료 후 추천 후속 액션:

| # | 액션 | 커맨드 | 설명 |
|---|------|--------|------|
| 1 | 코드 리뷰 | `/code-review` | Artibot 단독 코드 리뷰 |
| 2 | 설정 변경 | `/setup` | Artibot 전체 설정 위저드 |
| 3 | 구현 시작 | `/implement` | 리뷰 결과 기반 구현 |
