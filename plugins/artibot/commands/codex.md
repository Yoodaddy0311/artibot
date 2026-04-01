---
context: fork
name: codex
description: "(Artibot) Codex CLI 연동 — 크로스체크, 개발 위임, 아이디어 생성"
disable-model-invocation: true
argument-hint: '[action] e.g. "setup" | "mode review" | "review src/" | "idea caching"'
allowed-tools: [Read, Write, Edit, Bash, Glob, Grep, TaskCreate]
arguments:
  - action: "setup | mode | review | idea | (빈값=status)"
  - target: "모드명 또는 리뷰 대상"
---

# /codex

OpenAI Codex CLI 연동 커맨드. Artibot과 Codex를 병렬로 활용하여 크로스체크, 개발 위임, 아이디어 생성을 수행한다.

## Arguments

Parse $ARGUMENTS:
- (no argument): 상태 확인 — Codex CLI 설치 여부, 현재 모드, 연결 상태
- `setup`: 설치 & 로그인 가이드
- `mode [review|dev|off]`: 연동 모드 설정
- `review [scope]`: 즉시 크로스체크 실행
- `idea [topic]`: Codex에 아이디어 요청
- `--verbose`: 상세 출력

## Subcommands

### `/codex` (인수 없음) — 상태 확인

현재 Codex 연동 상태를 확인한다.

1. Codex CLI 설치 여부 확인:
   ```bash
   which codex 2>/dev/null || npx codex --version 2>/dev/null
   ```
2. 현재 모드 확인: `artibot.config.json` → `codex.mode` 읽기
3. 연결 상태: `OPENAI_API_KEY` 환경변수 존재 여부
4. 기본 모델: `codex.defaultModel` 값

출력:
```
CODEX STATUS
============
CLI:       [설치됨 (v1.x) | 미설치]
API Key:   [설정됨 | 미설정]
Mode:      [off | review | dev]
Model:     [o4-mini | 기타]
Timeout:   [60000ms]
ReviewOn:  [Stop-Review-Gate 활성/비활성]
```

### `/codex setup` — 설치 & 로그인 가이드

Codex CLI 설치 및 인증을 단계별로 안내한다.

1. **설치 확인**:
   - `npm list -g @openai/codex` 로 글로벌 설치 확인
   - 미설치 시: `npm install -g @openai/codex` 안내
   - 대안: `npx @openai/codex` (설치 없이 사용)

2. **API 키 설정**:
   - `OPENAI_API_KEY` 환경변수 설정 안내
   - 또는 `codex auth login` 으로 인터랙티브 로그인
   - 키 검증: `codex --version` 실행으로 연결 확인

3. **구독 상태 확인**:
   - Codex Pro 구독 여부 확인 안내
   - 무료 tier 제한사항 안내

4. **데이터 정책 경고**:
   ```
   ⚠️ DATA POLICY WARNING
   ━━━━━━━━━━━━━━━━━━━━━━
   review/dev 모드 사용 시 코드가 OpenAI API로 전송됩니다.
   - 민감한 코드(API 키, 비밀번호, 내부 비즈니스 로직)에 주의하세요
   - .codexignore 파일로 전송 제외 파일을 설정할 수 있습니다
   - Artibot DATA POLICY: 외부 DB 접근/전송은 절대 금지
   ```

5. **연결 테스트**:
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

Artibot code-reviewer와 Codex를 병렬로 실행하여 크로스체크한다.

1. **Scope 결정**:
   - scope 없음: `git diff` 로 현재 변경사항 대상
   - scope 있음: 특정 파일/디렉토리 대상
   - `--staged`: staged 변경사항만 대상

2. **병렬 실행**:
   - **Artibot**: code-reviewer 에이전트로 리뷰 (TaskCreate)
   - **Codex**: `codex review [scope]` 실행 (Bash)
   - 두 결과를 동시에 수집

3. **결과 통합**:
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

특정 주제에 대해 Codex에 기획/설계 아이디어를 요청한다.

1. **요청 구성**:
   - topic을 구조화된 프롬프트로 변환
   - 현재 프로젝트 컨텍스트 포함 (package.json, 기술 스택)

2. **Codex 실행**:
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

## Security Rules

1. **API 키 노출 금지**: `OPENAI_API_KEY` 값을 로그나 출력에 절대 포함하지 않음
2. **데이터 전송 경고**: review/dev 모드 활성화 시 매번 데이터 정책 안내
3. **민감 파일 제외**: `.env`, `credentials.*`, `*.pem` 파일은 Codex 전송 대상에서 자동 제외
4. **Artibot DATA POLICY 준수**: 외부 DB 접근/전송 절대 금지

## Error Handling

| 에러 | 처리 |
|------|------|
| Codex CLI 미설치 | `/codex setup` 안내 |
| API 키 미설정 | 환경변수 설정 가이드 |
| Codex 타임아웃 | `codex.timeout` 값 안내, Artibot 결과만 표시 |
| 네트워크 오류 | 오프라인 모드 폴백, Artibot 단독 리뷰 |
| 모드 off에서 review 시도 | 모드 변경 안내 |

## Next Steps

작업 완료 후 추천 후속 액션:

| # | 액션 | 커맨드 | 설명 |
|---|------|--------|------|
| 1 | 코드 리뷰 | `/code-review` | Artibot 단독 코드 리뷰 |
| 2 | 설정 변경 | `/setup` | Artibot 전체 설정 위저드 |
| 3 | 구현 시작 | `/implement` | 리뷰 결과 기반 구현 |
