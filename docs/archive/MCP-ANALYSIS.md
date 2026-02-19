# MCP 통합 현황 분석 및 최적화 전략

**작성**: mcp-dev | **태스크**: #13 | **날짜**: 2026-02-13

---

## 1. 현행 MCP 통합 현황 요약

### 1.1 SuperClaude 프레임워크의 MCP 설계 (MCP.md 기반)

현행 SuperClaude 프레임워크는 4개의 MCP 서버를 중심으로 설계되어 있다:

| 서버 | 목적 | 활성화 방식 | 현행 플래그 |
|------|------|------------|-----------|
| **Context7** | 라이브러리 문서/패턴 조회 | 자동(import 감지), 수동(`--c7`) | `--c7`, `--context7` |
| **Sequential** | 복잡한 분석/다단계 추론 | 자동(복잡도 >0.7), 수동(`--seq`) | `--seq`, `--sequential` |
| **Magic** | UI 컴포넌트 생성 | 자동(UI 요청), 수동(`--magic`) | `--magic` |
| **Playwright** | E2E 테스트/브라우저 자동화 | 자동(테스트 워크플로우), 수동(`--play`) | `--play`, `--playwright` |

### 1.2 실제 설치된 MCP 서버

`~/.claude/.mcp.json` 분석 결과:

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["-y", "@executeautomation/playwright-mcp-server"]
    }
  }
}
```

**문제점**: 프레임워크에서 4개 서버를 참조하지만 실제 설치된 서버는 **Playwright 1개뿐**이다.
- Context7: **플러그인으로 제공됨** (시스템 프롬프트의 `plugin:context7:context7`로 확인)
- Sequential: **미설치** (Claude Code에 별도 서버 불필요 - 내장 추론으로 대체)
- Magic (21st.dev): **미설치**

### 1.3 Windows 환경 이슈

현행 Playwright 설정에 Windows 필수 래퍼 `cmd /c`가 누락됨:

```json
// 현행 (오류 가능성)
"command": "npx",
"args": ["-y", "@executeautomation/playwright-mcp-server"]

// 수정 필요
"command": "cmd",
"args": ["/c", "npx", "-y", "@executeautomation/playwright-mcp-server"]
```

---

## 2. MCP 서버 선택/활성화 로직 평가

### 2.1 현행 자동 활성화 설계 (ORCHESTRATOR.md)

현행 시스템은 프롬프트 기반 자동 활성화를 사용한다:

```yaml
# 키워드 매칭 (30%) + 컨텍스트 분석 (40%) + 사용자 이력 (20%) + 성능 지표 (10%)
auto_activation:
  context7: "import/require/from 감지, 프레임워크 키워드"
  sequential: "debug/trace/analyze 키워드, 중첩 조건, 비동기 체인"
  magic: "component/button/form 키워드, JSX 패턴"
  playwright: "test/e2e 키워드, 성능 모니터링"
```

### 2.2 평가: 강점

1. **다중 신호 기반 스코어링**: 단일 키워드가 아닌 복합 신호 조합
2. **플래그 우선순위 체계**: 명시적 플래그 > 자동 감지 > 기본값
3. **사고 깊이 연계**: `--think` / `--think-hard` / `--ultrathink`가 MCP 활성화와 연동
4. **폴백 체인 설계**: 각 서버별 장애 시 대체 전략 명시

### 2.3 평가: 문제점

| 문제 | 심각도 | 설명 |
|------|--------|------|
| **실행 불가능한 참조** | 높음 | Sequential/Magic 서버가 미설치인데 프롬프트에서 참조 |
| **프롬프트 전용 구현** | 중간 | 모든 로직이 마크다운 지시문으로만 존재, 실행 가능한 코드 없음 |
| **검증 불가능한 스코어링** | 중간 | 복잡도 점수 0.0~1.0 계산을 LLM에 위임 (일관성 보장 불가) |
| **과잉 설계** | 중간 | 캐싱, 로드 밸런싱, 회로 차단기 등 실제 구현 없이 명세만 존재 |
| **토큰 비용** | 높음 | MCP.md + ORCHESTRATOR.md의 MCP 관련 지시만 ~15K 토큰 소비 |

### 2.4 핵심 인사이트: "Sequential" 서버의 실체

SuperClaude는 "Sequential MCP"를 별도 서버로 취급하나, 이는 Claude Code의 **내장 추론 능력**에 해당한다. 별도 MCP 서버가 아니라 Claude의 Extended Thinking / Chain-of-Thought 기능이다. 따라서:

- `--seq` 플래그는 실제로 MCP 서버를 활성화하는 것이 아님
- 프롬프트에서 "Sequential 서버를 사용하라"는 지시는 Claude에게 "더 체계적으로 사고하라"는 메타 지시와 동일
- 별도 MCP 서버 설정이 불필요함

---

## 3. 서버 간 조율 패턴 효율성 분석

### 3.1 현행 조율 패턴 (MCP.md)

```
Task Distribution → Dependency Management → Synchronization → Load Balancing → Failover
```

### 3.2 효율성 평가

**이론적으로 우수하나 실용성이 낮다**:

1. **다중 서버 조율**: 실제로 활성 서버가 2개(Context7 플러그인 + Playwright)뿐이므로 복잡한 조율 로직이 불필요
2. **캐싱 전략**: 5가지 캐시 유형 명세가 있으나 Claude Code에는 세션 간 캐시 메커니즘이 없음
3. **로드 밸런싱**: 단일 인스턴스 MCP 서버에 로드 밸런싱 불필요
4. **회로 차단기 패턴**: MCP 서버 장애 시 Claude Code가 자체적으로 오류 처리

### 3.3 실질적으로 유효한 조율 패턴

현재 환경에서 의미 있는 패턴:

| 패턴 | 유효성 | 이유 |
|------|--------|------|
| Context7 -> 구현 | 유효 | 문서 조회 후 코드 생성 |
| Playwright -> 검증 | 유효 | 테스트 실행 후 결과 확인 |
| Context7 + Playwright 병렬 | 유효 | 문서 조회와 테스트 동시 실행 |
| 멀티서버 캐싱 | 무효 | 구현 메커니즘 없음 |
| 로드 밸런싱 | 무효 | 단일 인스턴스 환경 |
| 회로 차단기 | 무효 | Claude Code 자체 오류 처리로 충분 |

---

## 4. 폴백/에러 처리 전략 평가

### 4.1 현행 폴백 전략

```yaml
# MCP.md의 Error Recovery 섹션
context7_fail: "WebSearch → Manual implementation"
sequential_fail: "Native Claude analysis → Note limitations"
magic_fail: "Basic component → Manual enhancement"
playwright_fail: "Manual testing → Provide test cases"
```

### 4.2 평가

| 전략 | 실용성 | 비고 |
|------|--------|------|
| Context7 -> WebSearch | **실용적** | 문서를 찾지 못하면 웹 검색으로 대체 가능 |
| Sequential -> Native | **불필요** | 이미 Native가 기본값 |
| Magic -> Basic component | **부분 실용적** | Magic 미설치이므로 항상 기본 컴포넌트 생성 |
| Playwright -> Manual | **실용적** | 브라우저 연결 실패 시 테스트 케이스 제공 |

### 4.3 추가 필요한 폴백

1. **MCP Tool Search 실패 시**: 직접 도구 호출로 대체
2. **플러그인 MCP 서버 비활성 시**: 수동 설치 안내 제공
3. **Windows 환경 오류**: `cmd /c` 래퍼 자동 적용
4. **타임아웃 처리**: `MCP_TIMEOUT` 환경 변수 활용 안내

---

## 5. Claude Code 최신 MCP 기능 조사 결과

### 5.1 MCP Tool Search (Lazy Loading)

**Claude Code 2.1.7+ 기본 탑재**

- MCP 도구 정의가 컨텍스트 10% 초과 시 자동 활성화
- 도구를 미리 로드하지 않고 필요 시 검색하여 로드
- **95% 컨텍스트 절약** (77K -> 8.7K 토큰)
- Opus 4 정확도: 49% -> 74%, Opus 4.5: 79.5% -> 88.1%

**플러그인 개발 시사점**:
- MCP 서버의 `instructions` 필드가 Tool Search에서 중요해짐
- 명확한 서버 설명이 도구 검색 정확도에 직접 영향

### 5.2 Plugin 시스템의 MCP 통합

**Claude Code Plugin System** (최신):

```json
// plugin.json에서 MCP 서버 인라인 정의 가능
{
  "name": "artibot",
  "mcpServers": {
    "plugin-api": {
      "command": "${CLAUDE_PLUGIN_ROOT}/servers/api-server",
      "args": ["--port", "8080"]
    }
  }
}
```

또는 `.mcp.json` 파일로 분리:

```json
// 플러그인 루트의 .mcp.json
{
  "database-tools": {
    "command": "${CLAUDE_PLUGIN_ROOT}/servers/db-server",
    "args": ["--config", "${CLAUDE_PLUGIN_ROOT}/config.json"],
    "env": {
      "DB_URL": "${DB_URL}"
    }
  }
}
```

### 5.3 MCP 서버 설치 스코프 체계

| 스코프 | 저장 위치 | 용도 |
|--------|----------|------|
| `local` (기본) | `~/.claude.json` 내 프로젝트 경로 | 개인/프로젝트별 |
| `project` | 프로젝트 루트 `.mcp.json` | 팀 공유 (VCS 포함) |
| `user` | `~/.claude.json` | 모든 프로젝트 공통 |

### 5.4 Remote HTTP MCP 서버

```bash
# HTTP 전송 (권장)
claude mcp add --transport http <name> <url>

# SSE 전송 (deprecated)
claude mcp add --transport sse <name> <url>
```

- OAuth 2.0 인증 지원
- 사전 구성 OAuth 클라이언트 자격 증명 (`--client-id`, `--client-secret`)
- 동적 도구 업데이트 (`list_changed` 알림)

### 5.5 Managed MCP Configuration

조직 차원 MCP 서버 관리:
- `managed-mcp.json`: 고정 서버 세트 (사용자 수정 불가)
- `allowedMcpServers` / `deniedMcpServers`: 정책 기반 제어

### 5.6 MCP 출력 제한

- 기본 경고: 10,000 토큰 초과 시
- 기본 최대: 25,000 토큰
- 환경 변수: `MAX_MCP_OUTPUT_TOKENS`로 조정 가능

---

## 6. 커스텀 MCP 도구 필요성 검토

### 6.1 현행 도구로 충족 가능한 영역

| 기능 | 사용 가능한 도구 | 커스텀 불필요 |
|------|----------------|-------------|
| 문서 조회 | Context7 (플러그인) | O |
| 웹 검색 | WebSearch (내장) | O |
| 파일 작업 | Read/Write/Edit (내장) | O |
| 코드 검색 | Grep/Glob (내장) | O |
| Git 작업 | Bash (내장) | O |
| 브라우저 테스트 | Playwright (MCP) | O |

### 6.2 커스텀 MCP 도구가 유용한 영역

| 도구 | 목적 | 우선순위 | 이유 |
|------|------|----------|------|
| **프로젝트 컨텍스트 서버** | 프로젝트 구조/패턴 캐싱 | 중간 | 세션 간 컨텍스트 유지 |
| **품질 게이트 서버** | 린트/타입체크/테스트 자동 실행 | 낮음 | Hooks로 대체 가능 |
| **메트릭 수집 서버** | 코드 복잡도/커버리지 측정 | 낮음 | Bash 도구로 대체 가능 |
| **메모리 관리 서버** | 세션 간 학습/패턴 저장 | 중간 | auto memory로 부분 대체 |

### 6.3 플러그인 내 MCP 서버 번들링 전략

Artibot 플러그인에서 MCP 서버를 번들할 경우:

```
artibot/
├── .claude-plugin/
│   └── plugin.json
├── .mcp.json                    # MCP 서버 정의
├── servers/
│   ├── context-server/          # 프로젝트 컨텍스트 캐싱 (선택)
│   │   ├── index.js
│   │   └── package.json
│   └── quality-gate-server/     # 품질 게이트 (선택)
│       ├── index.js
│       └── package.json
├── skills/
├── agents/
└── hooks/
```

**권장**: 초기에는 커스텀 MCP 서버 없이 시작하고, 실제 필요가 확인된 후 추가

---

## 7. 최적화 전략 및 권고사항

### 7.1 즉시 적용 (Quick Wins)

#### A. Windows Playwright 설정 수정

```json
// ~/.claude/.mcp.json
{
  "mcpServers": {
    "playwright": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "@executeautomation/playwright-mcp-server"]
    }
  }
}
```

#### B. 프롬프트 토큰 최적화

현행 MCP.md (~4,400 토큰)를 플러그인 내에서 **1/3로 압축**:

**삭제 대상**:
- Sequential 서버 전체 섹션 (내장 추론으로 대체)
- Magic 서버 섹션 (미설치, 향후 필요 시 추가)
- 캐싱 전략 상세 (구현 메커니즘 없음)
- 로드 밸런싱/회로 차단기 패턴 (단일 인스턴스 환경)
- 복잡한 스코어링 알고리즘 (LLM이 일관적으로 실행 불가)

**보존 대상**:
- Context7 활성화 패턴 및 워크플로우
- Playwright 활성화 패턴 및 워크플로우
- 실용적 폴백 전략 (Context7 -> WebSearch)
- 플래그 우선순위 규칙

#### C. Tool Search 최적화

플러그인의 MCP 서버에 명확한 `instructions` 필드 추가:

```json
{
  "mcpServers": {
    "artibot-context": {
      "command": "${CLAUDE_PLUGIN_ROOT}/servers/context-server",
      "instructions": "Use this server for project structure analysis, dependency mapping, and cached pattern retrieval. Invoke when analyzing architecture, loading project context, or checking established conventions."
    }
  }
}
```

### 7.2 플러그인 아키텍처 내 MCP 전략

#### MCP 서버 선택 로직 간소화

현행 5단계 선택 알고리즘을 **2단계로 축소**:

```
현행: Task Analysis → Capability Match → Performance Check → Load Assessment → Final Selection
제안: Task Analysis → Server Match (with fallback)
```

#### 플러그인 내 MCP 설정 통합

```json
// artibot/.mcp.json (플러그인 번들)
{
  "mcpServers": {
    // 기존 Playwright를 플러그인에 통합 (Windows 호환)
    "playwright": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "@executeautomation/playwright-mcp-server"]
    }
    // Context7는 이미 시스템 플러그인으로 제공되므로 별도 설정 불필요
  }
}
```

#### 플래그 체계 간소화

```yaml
# 현행: 4개 서버 x 개별 플래그 + 조합 플래그 = ~12개
# 제안: 실제 사용 가능한 플래그만 유지

유지:
  --c7: Context7 활성화 (문서 조회 필요 시)
  --play: Playwright 활성화 (테스트 필요 시)
  --no-mcp: 전체 MCP 비활성화

삭제/보류:
  --seq: 별도 서버 아님 (내장 추론)
  --magic: 미설치
  --all-mcp: 2개 서버에 무의미
```

### 7.3 중기 전략 (플러그인 v1.0 이후)

#### A. 프로젝트별 MCP 프로필

```json
// .claude/mcp-profiles.json
{
  "profiles": {
    "frontend": {
      "servers": ["context7", "playwright"],
      "auto_activate": ["*.tsx", "*.css", "*.vue"]
    },
    "backend": {
      "servers": ["context7"],
      "auto_activate": ["*.py", "*.go", "controllers/*"]
    },
    "testing": {
      "servers": ["playwright"],
      "auto_activate": ["*.test.*", "*.spec.*"]
    }
  }
}
```

#### B. MCP 사용 메트릭 수집 (Hooks 활용)

```json
// hooks/hooks.json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "mcp__*",
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PLUGIN_ROOT}/scripts/log-mcp-usage.sh $TOOL_NAME"
          }
        ]
      }
    ]
  }
}
```

#### C. 추가 MCP 서버 후보

| 서버 | 설치 명령 | 사용 사례 |
|------|----------|----------|
| **GitHub** | `claude mcp add --transport http github https://api.githubcopilot.com/mcp/` | PR/이슈 관리 |
| **Sentry** | `claude mcp add --transport http sentry https://mcp.sentry.dev/mcp` | 에러 모니터링 |
| **PostgreSQL** | `claude mcp add --transport stdio db -- npx -y @bytebase/dbhub --dsn <url>` | DB 쿼리 |

### 7.4 장기 전략

#### A. 커스텀 MCP 서버 개발 (필요 시)

프로젝트 컨텍스트 서버:
- 프로젝트 구조 캐싱 및 빠른 조회
- 코드 패턴 분석 결과 저장
- 의존성 그래프 캐싱

기술 스택:
- TypeScript + MCP SDK
- 로컬 SQLite 저장소
- stdio 전송

#### B. MCP 서버 상태 모니터링

Hooks 시스템을 활용한 서버 건강 체크:
- `SessionStart` 이벤트에서 MCP 서버 상태 확인
- 비정상 서버 자동 재시작 또는 알림

---

## 8. 요약: 현행 대비 제안 비교

| 항목 | 현행 SuperClaude | 제안 Artibot |
|------|-----------------|-------------|
| MCP 서버 수 | 4개 참조 (1개 실제 설치) | 2개 (Context7 플러그인 + Playwright) |
| 선택 알고리즘 | 5단계 복잡 스코어링 | 2단계 간소화 |
| 조율 패턴 | 캐싱/로드밸런싱/회로차단기 | 순차/병렬 호출만 |
| 폴백 전략 | 4서버 개별 체인 | 실용적 2서버 폴백 |
| 프롬프트 토큰 | ~15K (MCP + ORCHESTRATOR) | ~4K (압축된 MCP 섹션) |
| Windows 호환 | 누락 | `cmd /c` 래퍼 포함 |
| Tool Search | 미고려 | instructions 필드 최적화 |
| 플러그인 통합 | 없음 | `.mcp.json` 번들 |
| 메트릭 수집 | 명세만 존재 | Hooks 기반 실제 구현 |

---

## 9. 4개 레포 MCP 통합 패턴 분석

**분석 대상**: ui-ux-pro-max-skill, cc-wf-studio, everything-claude-code, bkit-claude-code
**분석 일자**: 2026-02-13 | **분석자**: mcp-dev (Task #5)

### 9.1 레포별 MCP 통합 수준 비교

| 레포 | MCP 서버 정의 | .mcp.json | plugin.json MCP | 런타임 MCP 코드 | MCP 보안 스캔 |
|------|:------------:|:---------:|:--------------:|:-------------:|:------------:|
| **ui-ux-pro-max-skill** | 없음 | 없음 | 없음 (skills만) | 없음 | 없음 |
| **cc-wf-studio** | 없음 | 없음 | 없음 (VSCode ext) | **있음** (7개 서비스) | 없음 |
| **everything-claude-code** | **있음** (15개 서버) | 없음 (예시 제공) | 없음 (skills/agents만) | 없음 | **있음** (AgentShield) |
| **bkit-claude-code** | 없음 | 없음 | 없음 (outputStyles만) | **있음** (Hooks에서 감지) | 없음 |

### 9.2 everything-claude-code: MCP 서버 카탈로그 패턴

**가장 포괄적인 MCP 서버 목록** (`mcp-configs/mcp-servers.json`):

| 카테고리 | 서버 | 전송 방식 | 용도 |
|----------|------|:---------:|------|
| **문서** | context7 | stdio (npx) | 라이브러리 문서 실시간 조회 |
| **UI** | magic | stdio (npx) | Magic UI 컴포넌트 생성 |
| **추론** | sequential-thinking | stdio (npx) | 체계적 사고 체인 |
| **메모리** | memory | stdio (npx) | 세션 간 영속 메모리 |
| **VCS** | github | stdio (npx) | PR/이슈/레포 관리 |
| **웹** | firecrawl | stdio (npx) | 웹 스크래핑/크롤링 |
| **DB** | supabase | stdio (npx) | Supabase DB 조작 |
| **분석** | clickhouse | http | 분석 쿼리 |
| **배포** | vercel | http | Vercel 배포/프로젝트 |
| **배포** | railway | stdio (npx) | Railway 배포 |
| **인프라** | cloudflare-docs | http | Cloudflare 문서 검색 |
| **인프라** | cloudflare-workers-builds | http | Workers 빌드 |
| **인프라** | cloudflare-workers-bindings | http | Workers 바인딩 |
| **인프라** | cloudflare-observability | http | 관측성/로그 |
| **파일** | filesystem | stdio (npx) | 파일시스템 조작 |

**핵심 패턴**:
1. **설명 필드 (description)**: 모든 서버에 description 필드 포함 -> Tool Search 정확도 향상
2. **환경 변수 참조**: `${env:GITHUB_PERSONAL_ACCESS_TOKEN}` 문법으로 시크릿 안전 참조
3. **HTTP + stdio 혼합**: 클라우드 서비스는 http, 로컬 도구는 stdio
4. **비활성화 가이드**: `disabledMcpServers` 배열로 프로젝트별 제어
5. **10개 미만 권장**: `_comments`에 "Keep under 10 MCPs enabled to preserve context window" 명시

**Artibot 적용점**: `description` 필드 필수화, 권장 MCP 서버 카탈로그 제공, 10개 미만 제한 규칙

### 9.3 cc-wf-studio: MCP 런타임 구현 패턴 (실행 코드 수준)

cc-wf-studio는 VSCode 확장으로서 **MCP를 프로그래밍적으로 통합**하는 유일한 레포:

#### A. 멀티소스 MCP 설정 리더 (`mcp-config-reader.ts`)

**8단계 우선순위 체인**으로 Claude/Copilot/Codex 모두에서 MCP 설정을 읽음:

```
Priority 1: <workspace>/.mcp.json (Claude project)
Priority 2: <workspace>/.vscode/mcp.json (VSCode Copilot - 'servers' 키)
Priority 3: ~/.mcp.json (Claude user)
Priority 4: ~/.claude.json → projects[workspace].mcpServers (Legacy project)
Priority 5: ~/.claude.json → mcpServers (Legacy user)
Priority 6: ~/.copilot/mcp-config.json (Copilot CLI user)
Priority 7: ~/.codex/config.toml (Codex CLI - TOML 형식)
```

**핵심 구현 패턴**:
- `normalizeServerConfig()`: type 필드 자동 추론 (command 있으면 stdio, url 있으면 경고)
- `getAllMcpServersWithSource()`: source:id 복합키로 중복 제거
- `McpConfigSource` 추적: 'claude' | 'copilot' | 'codex' 출처 태깅

**Artibot 적용점**: MCP 설정 우선순위 체계는 Artibot 플러그인이 프로젝트별 `.mcp.json`을 생성할 때 참고 필수

#### B. MCP 캐시 서비스 (`mcp-cache-service.ts`)

```typescript
const CACHE_TTL_MS = {
  SERVER_LIST: 30000,    // 30초
  SERVER_DETAILS: 30000, // 30초
  TOOLS: 30000,          // 30초
  TOOL_SCHEMA: 60000,    // 60초 (스키마는 더 안정적)
};
```

**패턴**:
- 인메모리 캐시 (세션 내 한정)
- 서버별 개별 무효화 (`invalidateServerCache`)
- 전체 캐시 플러시 (`invalidateAllCache` - UI 새로고침용)
- 캐시 통계 디버깅 (`getCacheStats`)
- "No automatic refresh" 정책: 사용자 수동 새로고침

**Artibot 적용점**: Hooks에서 MCP 도구 사용 통계 수집 시 유사한 TTL 기반 캐싱 패턴 활용 가능

#### C. MCP SDK 직접 연결 (`mcp-sdk-client.ts`)

```typescript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
```

**패턴**:
- `@modelcontextprotocol/sdk` 직접 사용하여 MCP 서버에 연결
- 타임아웃 처리: `Promise.race([client.connect(transport), timeoutPromise])`
- JSON Schema -> ToolParameter 변환: `convertJsonSchemaToToolParameters()`
- 연결 후 반드시 `client.close()` (finally 블록)

**Artibot 적용점**: 향후 커스텀 MCP 서버 개발 시 SDK 직접 사용 패턴 참조. 단, 현재 Artibot은 플러그인이므로 SDK 직접 사용 불필요

#### D. CLI 계약 스키마 (`mcp-cli.schema.json`)

`claude mcp list` / `claude mcp get` 출력 파싱 규칙:
- 상태 판별: `✓` 체크마크 유무로 connected/disconnected
- 에러 코드: `MCP_CLI_NOT_FOUND`, `MCP_CLI_TIMEOUT`, `MCP_SERVER_NOT_FOUND`, `MCP_CONNECTION_FAILED`, `MCP_PARSE_ERROR`
- 타임아웃: 5000ms
- 재시도 정책: 자동 재시도 없음, 사용자 수동 새로고침

**Artibot 적용점**: SessionStart Hook에서 MCP 서버 헬스체크 시 동일한 CLI 호출 패턴 사용 가능

### 9.4 bkit-claude-code: MCP 감지 및 안내 패턴

bkit은 MCP 서버를 직접 번들하지 않지만, **SessionStart Hook에서 MCP 상태를 감지하고 안내**:

#### A. .mcp.json 런타임 감지 (`session-start.js:567-589`)

```javascript
const mcpJsonPath = path.join(process.cwd(), '.mcp.json');
if (fs.existsSync(mcpJsonPath)) {
  const mcpContent = fs.readFileSync(mcpJsonPath, 'utf-8');
  if (mcpContent.includes('bkend') || mcpContent.includes('api.bkend.ai')) {
    bkendMcpConnected = true;
  }
}
```

- Dynamic 레벨에서만 bkend.ai MCP 상태 확인
- 미설정 시 설치 명령어 안내: `claude mcp add bkend --transport http https://api.bkend.ai/mcp`
- 설정됨이면 "자연어로 백엔드 관리 가능" 안내

**Artibot 적용점**: SessionStart Hook에서 MCP 서버 상태 감지 + 미설치 서버 안내 패턴은 매우 실용적

#### B. bkit Context Engineering 성숙도의 MCP Gap

bkit 자체 분석 보고서에서 MCP 통합을 **0%**로 평가:
- Claude Code MCP 100% vs bkit MCP 0%
- "전체 성숙도 85%"에서 가장 큰 Gap이 MCP 통합

**시사점**: MCP 통합은 선택이 아닌 필수이며, Artibot은 이 Gap을 해결해야 함

### 9.5 ui-ux-pro-max-skill: MCP 경유 UI 컴포넌트 패턴

ui-ux-pro-max은 MCP 서버를 직접 통합하지 않지만, **다른 MCP 서버(shadcn/ui)와의 연계**를 설명에 명시:

```
"Integrations: shadcn/ui MCP for component search and examples."
```

- plugin.json의 `description`에 MCP 통합점 명시
- 실제 MCP 연결은 사용자 환경에 위임
- Python CLI 스크립트(`search.py`)로 로컬 데이터 검색 -> MCP 대안 패턴

**Artibot 적용점**: MCP가 없어도 동작하되, MCP가 있으면 향상되는 "선택적 통합" 패턴

### 9.6 everything-claude-code: 멀티모델 MCP 오케스트레이션 패턴

`commands/multi-workflow.md`에서 MCP + 멀티모델 협업 패턴:

```
Claude (오케스트레이터) → mcp__ace-tool__enhance_prompt (프롬프트 개선)
                       → mcp__ace-tool__search_context (컨텍스트 검색)
                       → Codex (백엔드 분석)
                       → Gemini (프론트엔드 분석)
```

**패턴**:
1. MCP 서버로 프롬프트 전처리 (`enhance_prompt`)
2. MCP 서버로 컨텍스트 수집 (`search_context`)
3. 외부 모델에 위임 (`codeagent-wrapper`로 Codex/Gemini 호출)
4. `run_in_background: true`로 병렬 실행
5. `TaskOutput`으로 결과 수집 및 합성

**Artibot 적용점**: MCP 도구를 "전처리 단계"로 활용하는 패턴. Context7로 문서 조회 -> 구현 워크플로우에 직접 적용 가능

### 9.7 everything-claude-code: MCP 보안 스캔 패턴

`skills/security-scan/SKILL.md`에서 AgentShield 기반 MCP 보안 감사:

| 대상 | 점검 항목 |
|------|----------|
| `mcp.json` | 위험한 MCP 서버, 하드코딩된 env 시크릿, npx 공급망 리스크 |
| `settings.json` | 과도한 허용 목록, 위험한 바이패스 플래그 |
| `hooks/` | 인터폴레이션을 통한 명령어 주입, 데이터 유출 |

**Artibot 적용점**: MCP 설정 보안 감사 스킬/에이전트는 Artibot에서도 필요. 특히:
- `.mcp.json`에 하드코딩된 API 키 감지
- `npx -y` 패턴의 공급망 공격 경고
- MCP 서버 URL의 안전성 검증

### 9.8 종합: Artibot MCP 전략에 대한 시사점

#### A. 채택할 패턴

| 패턴 | 출처 | 이유 |
|------|------|------|
| **description 필드 필수화** | everything-claude-code | Tool Search 정확도 향상 |
| **10개 미만 MCP 제한** | everything-claude-code | 컨텍스트 윈도우 보존 |
| **SessionStart MCP 감지** | bkit-claude-code | 미설치 서버 자동 안내 |
| **선택적 통합 패턴** | ui-ux-pro-max-skill | MCP 없이도 동작, 있으면 향상 |
| **MCP 보안 감사** | everything-claude-code | 공급망 공격 방지 |
| **환경변수 참조** | everything-claude-code | `${env:VAR}` 시크릿 안전 참조 |

#### B. 불필요한 패턴

| 패턴 | 출처 | 불필요 이유 |
|------|------|------------|
| MCP SDK 직접 사용 | cc-wf-studio | Artibot은 플러그인이므로 SDK 불필요 |
| 8단계 설정 우선순위 | cc-wf-studio | VSCode 확장용, 플러그인에는 과잉 |
| 멀티모델 MCP 오케스트레이션 | everything-claude-code | Codex/Gemini 통합은 범위 밖 |
| TOML 파서 (Codex) | cc-wf-studio | Codex CLI 호환은 불필요 |

#### C. Artibot 플러그인 권장 MCP 설정

```json
// artibot/.mcp.json (프로젝트 스코프 - 선택적 제공)
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["-y", "@executeautomation/playwright-mcp-server"],
      "description": "Browser automation and E2E testing"
    }
  },
  "_comments": {
    "context7": "Provided as system plugin - no config needed",
    "max_servers": "Keep under 10 MCPs to preserve context window",
    "security": "Never hardcode API keys - use ${env:VAR} syntax"
  }
}
```

#### D. SessionStart Hook MCP 감지 스크립트 (bkit 패턴 참조)

```javascript
// hooks/session-start.js - MCP 상태 감지 섹션
function checkMcpServers() {
  const mcpJsonPath = path.join(process.cwd(), '.mcp.json');
  const tips = [];

  // Context7 플러그인 확인 (시스템 프롬프트에서)
  tips.push('Context7: System plugin (auto-available)');

  // Playwright MCP 확인
  try {
    if (fs.existsSync(mcpJsonPath)) {
      const content = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf-8'));
      if (content.mcpServers?.playwright) {
        tips.push('Playwright: Configured');
      }
    }
  } catch (e) { /* ignore */ }

  // 미설치 서버 안내
  if (!tips.some(t => t.includes('Playwright: Configured'))) {
    tips.push('Playwright: Not configured. Setup: claude mcp add playwright npx -y @executeautomation/playwright-mcp-server');
  }

  return tips;
}
```

---

## 10. 참고 자료

- [Claude Code MCP 공식 문서](https://code.claude.com/docs/en/mcp)
- [Claude Code Plugin Reference](https://code.claude.com/docs/en/plugins-reference)
- [MCP Tool Search 설명](https://claudefa.st/blog/tools/mcp-extensions/mcp-tool-search)
- [Claude Code Release Notes (2026.02)](https://releasebot.io/updates/anthropic/claude-code)
- [Claude Code MCP Lazy Loading](https://jpcaparas.medium.com/claude-code-finally-gets-lazy-loading-for-mcp-tools-explained-39b613d1d5cc)
- [Top MCP Servers 2026](https://apidog.com/blog/top-10-mcp-servers-for-claude-code/)

### 4개 레포 분석 소스

- `refs/ui-ux-pro-max-skill/` - MCP 없이 Python CLI로 동작, shadcn/ui MCP 선택적 통합
- `refs/cc-wf-studio/src/extension/services/mcp-*.ts` - MCP SDK 직접 연결, 캐시, CLI 파싱
- `refs/everything-claude-code/mcp-configs/mcp-servers.json` - 15개 서버 카탈로그 + description 패턴
- `refs/bkit-claude-code/hooks/session-start.js` - SessionStart에서 MCP 상태 감지/안내
