# Artibot MCP 통합 설계서

**작성**: doc-manager | **태스크**: #5 | **날짜**: 2026-02-13
**기반 분석**: 4개 레포 MCP 통합 패턴 + 기존 MCP-ANALYSIS.md 통합

---

## 1. 4개 레포 MCP 통합 패턴 분석 요약

### 1.1 레포별 MCP 접근 방식 비교

| 레포 | MCP 접근 방식 | 설정 위치 | 번들링 | 서버 수 |
|------|-------------|----------|--------|---------|
| **everything-claude-code** | MCP 서버 카탈로그 제공 | `mcp-configs/mcp-servers.json` + `.cursor/mcp.json` | 없음 (참조 설정 제공) | 14개 서버 카탈로그 |
| **cc-wf-studio** | MCP SDK 직접 통합 | CLI 스키마 + SDK 클라이언트 | TypeScript 서비스 레이어 | 다중 소스 지원 |
| **bkit-claude-code** | Hook 기반 MCP 감지 | `bkit.config.json` + `.mcp.json` 감지 | 없음 (감지 + 권장만) | 0 (외부 MCP 감지) |
| **ui-ux-pro-max-skill** | MCP 연동 스킬 | `.claude-plugin/plugin.json` | 스킬 내 Python 스크립트 | 0 (shadcn/ui MCP 참조) |

### 1.2 패턴 상세 분석

#### A. everything-claude-code (ECC) - "MCP 카탈로그 패턴"

**핵심 전략**: MCP 서버를 번들하지 않고, 검증된 서버 목록을 JSON으로 제공

```json
// mcp-configs/mcp-servers.json 구조
{
  "mcpServers": {
    "context7": {
      "command": "npx",
      "args": ["-y", "@context7/mcp-server"],
      "description": "Live documentation lookup"
    },
    "sequential-thinking": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-sequential-thinking"],
      "description": "Chain-of-thought reasoning"
    }
  },
  "_comments": {
    "usage": "Copy the servers you need to your ~/.claude.json mcpServers section",
    "context_warning": "Keep under 10 MCPs enabled to preserve context window"
  }
}
```

**MCP 통합 특징**:
- 14개 서버 카탈로그: github, firecrawl, supabase, memory, sequential-thinking, vercel, railway, cloudflare (4종), clickhouse, context7, magic, filesystem
- stdio 전송 (npx 기반)과 HTTP 전송 혼용
- `${env:VAR}` 변수 참조 패턴 (Cursor용)
- 플러그인 시스템에서 `context7`을 추천 플러그인으로 분류
- `"context_warning": "Keep under 10 MCPs enabled to preserve context window"` -- 10개 이하 권장

**Hook을 통한 MCP 활용**:
- `${CLAUDE_PLUGIN_ROOT}/scripts/hooks/` 경로로 Hook 스크립트 번들
- `PostToolUse` Hook에서 `mcp__*` 매처로 MCP 도구 사용 추적 가능
- `PreToolUse` Hook에서 도구 사용 전 검증 패턴 확립

#### B. cc-wf-studio - "MCP SDK 직접 통합 패턴"

**핵심 전략**: MCP SDK를 사용한 프로그래매틱 서버 관리

```typescript
// mcp-sdk-client.ts - SDK 기반 직접 연결
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export async function connectToMcpServer(
  command: string, args: string[], env: Record<string, string>, timeoutMs = 5000
): Promise<Client> {
  const transport = new StdioClientTransport({ command, args, env: { ...process.env, ...env } });
  const client = new Client({ name: 'cc-workflow-studio', version: '1.0.0' }, { capabilities: {} });
  await Promise.race([client.connect(transport), timeout(timeoutMs)]);
  return client;
}
```

**MCP 통합 특징**:

1. **다중 소스 설정 읽기** (`mcp-config-reader.ts`):
   - Claude Code: `.mcp.json` (project) → `~/.mcp.json` (user) → `~/.claude.json` (legacy)
   - VSCode Copilot: `.vscode/mcp.json` (`servers` 키 사용)
   - Copilot CLI: `~/.copilot/mcp-config.json`
   - Codex CLI: `~/.codex/config.toml` (TOML 파싱)
   - **8단계 우선순위 체계**로 중복 서버 해결

2. **인메모리 캐싱** (`mcp-cache-service.ts`):
   - 서버 목록: 30초 TTL
   - 서버 상세: 30초 TTL
   - 도구 목록: 30초 TTL
   - 도구 스키마: 60초 TTL
   - 수동 갱신 전략 (자동 새로고침 없음)

3. **MCP CLI 스키마 계약** (`mcp-cli.schema.json`):
   - `claude mcp list` / `claude mcp get <server>` 명령 계약
   - 파싱 규칙, 오류 코드, 타임아웃(5000ms) 표준화
   - 연결 상태 감지 패턴

4. **MCP 노드 타입 시스템** (`mcp-node.ts`):
   - 3가지 설정 모드: `manualParameterConfig`, `aiParameterConfig`, `aiToolSelection`
   - 소스 추적: `McpConfigSource = 'claude' | 'copilot' | 'codex'`
   - 레거시 모드 마이그레이션: `detailed` → `manualParameterConfig`

#### C. bkit-claude-code - "MCP 감지 + 권장 패턴"

**핵심 전략**: MCP를 번들하지 않고, 사용자 환경의 MCP 설정을 감지하여 권장

```javascript
// scripts/user-prompt-handler.js - MCP 감지 로직
function checkBkendMcpConfig() {
  const mcpJsonPath = path.join(process.cwd(), '.mcp.json');
  if (fs.existsSync(mcpJsonPath)) {
    const content = fs.readFileSync(mcpJsonPath, 'utf-8');
    if (content.includes('bkend') || content.includes('api.bkend.ai')) {
      return true;
    }
  }
  return false;
}

// MCP 미설치 시 설치 권장
if (!hasBkendMcp) {
  contextParts.push(
    'bkend.ai MCP not configured. Suggest: claude mcp add bkend --transport http https://api.bkend.ai/mcp'
  );
}
```

**MCP 통합 특징**:

1. **프로젝트 레벨 감지** (`bkit.config.json`):
   - `levelDetection.dynamic.files`: `.mcp.json` 존재 여부로 프로젝트 레벨 판단
   - `.mcp.json`이 있으면 "Dynamic" 레벨, 없으면 "Starter" 레벨
   - MCP 존재 자체를 프로젝트 성숙도 지표로 활용

2. **UserPromptSubmit Hook을 통한 MCP 권장**:
   - 사용자 입력 분석 → 백엔드/DB 관련 요청 감지 → bkend MCP 설치 안내
   - `.mcp.json`과 `.claude/settings.json` 양쪽 모두 검색
   - `claude mcp add` 명령어를 직접 제안

3. **에이전트 기반 MCP 활용 가이드**:
   - `cto-lead.md` 에이전트: Context7, Playwright 등 MCP 서버 활용 가이드 내장
   - 레벨별 에이전트 매핑: Dynamic → `bkend-expert`, Enterprise → `enterprise-expert`
   - PDCA 워크플로우 내에서 MCP 도구 활용 패턴 문서화

#### D. ui-ux-pro-max-skill - "스킬 내 MCP 참조 패턴"

**핵심 전략**: MCP 서버를 직접 제공하지 않고, 관련 MCP 서버를 스킬 설명에서 참조

```json
// .claude-plugin/plugin.json
{
  "name": "ui-ux-pro-max",
  "skills": ["./.claude/skills/ui-ux-pro-max"],
  "version": "2.0.1"
}
```

**MCP 통합 특징**:

1. **스킬 설명에서 MCP 참조**:
   - `frontmatter.description`에 "Integrations: shadcn/ui MCP for component search and examples" 포함
   - MCP 서버를 번들하지 않고 스킬 설명에 연동 가능한 MCP를 언급
   - Claude Code가 Tool Search에서 해당 MCP를 자동으로 찾아 활용

2. **플랫폼별 설정 템플릿**:
   - `templates/platforms/claude.json`: Claude Code 전용 설정
   - `templates/platforms/cursor.json`: Cursor 전용 설정
   - 플랫폼 간 MCP 설정 차이를 템플릿으로 추상화

3. **CLI 설치 도구**:
   - `uipro init` 명령으로 플랫폼별 자동 설치
   - 스킬 내 Python 검색 엔진으로 MCP 없이도 기능 제공

---

## 2. 핵심 패턴 추출: Tool Search 활용

### 2.1 Tool Search 개요 (Claude Code 2.1.7+)

- MCP 도구 정의가 컨텍스트 10% 초과 시 자동 활성화
- 95% 컨텍스트 절약 (77K → 8.7K 토큰)
- **`instructions` 필드가 Tool Search 정확도에 직접 영향**

### 2.2 4개 레포의 Tool Search 대응 현황

| 레포 | Tool Search 대응 | 구현 방식 |
|------|-----------------|----------|
| **ECC** | `description` 필드 활용 | 각 MCP 서버에 1줄 설명 제공 |
| **cc-wf-studio** | CLI 스키마 기반 | `mcp-cli.schema.json`에서 도구별 설명 표준화 |
| **bkit** | 간접 대응 | 스킬/에이전트 설명에서 MCP 도구 용도 설명 |
| **ui-ux-pro-max** | 스킬 frontmatter | 스킬 설명에 MCP 연동 기능 명시 |

### 2.3 Artibot에 적용할 Tool Search 전략

```json
{
  "mcpServers": {
    "artibot-server": {
      "command": "${CLAUDE_PLUGIN_ROOT}/servers/artibot-mcp/index.js",
      "instructions": "Artibot project context server. Use for: (1) project structure and convention analysis, (2) cached dependency graph queries, (3) established pattern retrieval. Invoke when user asks about architecture, imports, or established conventions."
    }
  }
}
```

**`instructions` 작성 원칙**:
1. 서버 용도를 1문장으로 명시
2. 주요 사용 사례를 번호로 나열
3. 호출 조건을 명시적으로 기술
4. 불필요한 호출을 방지하는 부정 조건 추가 (선택)

---

## 3. MCP 서버 번들링 방식 비교

### 3.1 번들링 전략 비교표

| 전략 | 레포 | 장점 | 단점 | 복잡도 |
|------|------|------|------|--------|
| **카탈로그 제공** | ECC | 유연성, 사용자 선택 | 설치 번거로움 | 낮음 |
| **SDK 직접 통합** | cc-wf-studio | 완전 제어, 캐싱 | 높은 개발 비용 | 높음 |
| **감지 + 권장** | bkit | 비침투적, 가벼움 | 기능 제한 | 낮음 |
| **스킬 내 참조** | ui-ux-pro-max | 최소 오버헤드 | 간접적 통합 | 최소 |

### 3.2 Artibot 권장 번들링 전략: "계층적 MCP 통합"

```
artibot/
├── .claude-plugin/
│   └── plugin.json              # MCP 서버 선언 (있을 경우)
├── .mcp.json                    # 플러그인 번들 MCP 서버
├── mcp-configs/
│   ├── recommended.json         # 권장 MCP 서버 카탈로그 (ECC 패턴)
│   └── profiles/
│       ├── frontend.json        # 프론트엔드 프로필
│       ├── backend.json         # 백엔드 프로필
│       └── fullstack.json       # 풀스택 프로필
├── scripts/
│   └── hooks/
│       ├── detect-mcp.js        # MCP 환경 감지 (bkit 패턴)
│       └── log-mcp-usage.js     # MCP 사용량 추적
└── servers/                     # 커스텀 MCP 서버 (v2.0+, 선택)
    └── context-server/
        ├── index.js
        └── package.json
```

---

## 4. 기존 MCP-ANALYSIS.md 통합

### 4.1 기존 분석 핵심 결론 (mcp-dev)

| 결론 | 상태 | 4개 레포 분석으로 보강된 근거 |
|------|------|---------------------------|
| Sequential은 별도 MCP 서버 아님 | **확인** | ECC에서 `sequential-thinking` 서버를 카탈로그에 포함하나, 실제 Claude Code에서는 불필요 |
| Magic은 미설치 | **확인** | ECC에서 카탈로그만 제공, 4개 레포 모두 Magic 서버를 직접 사용하지 않음 |
| Windows `cmd /c` 래퍼 필요 | **확인** | cc-wf-studio의 StdioClientTransport에서 command 직접 실행, Windows 호환 필요 |
| Context7는 플러그인으로 제공 | **확인** | ECC에서 플러그인 추천 목록에 포함, ui-ux-pro-max에서 스킬 설명에 참조 |
| 커스텀 MCP 서버 초기 불필요 | **보강** | bkit이 0개 MCP로 26 스킬 + 16 에이전트 운영, ui-ux-pro-max도 MCP 없이 스킬 동작 |
| Tool Search instructions 중요 | **보강** | ECC의 `description` 필드 + cc-wf-studio의 CLI 스키마 패턴이 증거 |

### 4.2 추가 발견 사항 (4개 레포에서 새로 도출)

| 발견 | 출처 | Artibot 적용 |
|------|------|-------------|
| MCP 설정 다중 소스 읽기 | cc-wf-studio | 향후 Copilot/Codex 호환 고려 |
| MCP 인메모리 캐싱 (30s TTL) | cc-wf-studio | 커스텀 서버 구현 시 참조 |
| MCP 존재를 프로젝트 레벨 지표로 사용 | bkit | 프로젝트 분석 시 `.mcp.json` 존재 여부 확인 |
| Hook에서 MCP 미설치 감지 → 설치 안내 | bkit | UserPromptSubmit Hook에서 MCP 환경 진단 |
| MCP 프로필별 서버 세트 | ECC 카탈로그 패턴 | 프로필 기반 MCP 권장 시스템 |
| 스킬 설명에서 MCP 참조 | ui-ux-pro-max | 스킬 frontmatter에 MCP 연동 기능 명시 |
| 플러그인 시스템의 `${CLAUDE_PLUGIN_ROOT}` | ECC + ui-ux-pro-max | 플러그인 내 스크립트 경로 참조 표준 |

---

## 5. Artibot MCP 통합 설계

### 5.1 설계 원칙

1. **최소 번들, 최대 활용**: 커스텀 MCP 서버 없이 시작, 기존 MCP 생태계 활용
2. **감지 우선**: 사용자 환경의 MCP 설정을 감지하고 최적 활용 안내
3. **프로필 기반 권장**: 프로젝트 유형별 MCP 서버 세트 권장
4. **Tool Search 최적화**: 모든 MCP 참조에 명확한 `instructions`/`description` 제공
5. **Windows 호환**: `cmd /c` 래퍼 자동 적용

### 5.2 Phase 1: 기본 MCP 통합 (v1.0)

#### A. 플러그인 번들 MCP 설정

```json
// artibot/.mcp.json
{
  "mcpServers": {
    "playwright": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "@executeautomation/playwright-mcp-server"],
      "instructions": "Browser automation and E2E testing. Use for: visual testing, user flow simulation, cross-browser validation, performance metrics. Invoke when testing UI, debugging visual issues, or running E2E tests."
    }
  }
}
```

**참고**: Context7는 시스템 플러그인으로 이미 제공되므로 별도 번들 불필요.

#### B. MCP 환경 감지 Hook

```javascript
// scripts/hooks/detect-mcp.js (bkit 패턴 참조)
// SessionStart Hook에서 실행
// 1. .mcp.json 존재 여부 확인
// 2. 설치된 MCP 서버 목록 파악
// 3. 프로젝트 유형에 따른 추가 MCP 서버 권장
// 4. Windows 환경 감지 및 cmd /c 래퍼 필요 여부 안내
```

#### C. MCP 권장 카탈로그

```json
// mcp-configs/recommended.json (ECC 패턴 참조)
{
  "mcpServers": {
    "context7": {
      "command": "npx",
      "args": ["-y", "@context7/mcp-server"],
      "description": "Live documentation lookup for any library",
      "category": "essential",
      "autoActivate": true
    },
    "playwright": {
      "command": "npx",
      "args": ["-y", "@executeautomation/playwright-mcp-server"],
      "description": "Browser automation and E2E testing",
      "category": "testing",
      "autoActivate": false
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${env:GITHUB_PAT}" },
      "description": "GitHub operations - PRs, issues, repos",
      "category": "devops",
      "autoActivate": false
    }
  },
  "_meta": {
    "maxRecommended": 5,
    "contextWarning": "Keep under 10 MCPs enabled to preserve context window"
  }
}
```

#### D. 스킬/에이전트 내 MCP 참조 패턴

```markdown
---
name: backend-analyzer
description: Backend architecture analysis with Context7 for library docs and Playwright for API testing. Actions: analyze API, review database schema, check service patterns.
---
```

### 5.3 Phase 2: 프로필 기반 MCP 관리 (v1.1+)

#### MCP 프로필 시스템

```json
// mcp-configs/profiles/frontend.json
{
  "name": "frontend",
  "description": "Frontend development MCP profile",
  "servers": {
    "context7": { "required": true },
    "playwright": { "required": true },
    "magic": {
      "required": false,
      "command": "npx",
      "args": ["-y", "@magicuidesign/mcp@latest"],
      "description": "UI component generation from 21st.dev"
    }
  },
  "detection": {
    "files": ["*.tsx", "*.jsx", "*.vue", "*.svelte"],
    "dependencies": ["react", "vue", "svelte", "next", "nuxt"]
  }
}
```

#### 프로필 자동 감지

```javascript
// scripts/detect-profile.js
// 1. package.json 분석 → 프레임워크 감지
// 2. 파일 패턴 분석 → 프론트엔드/백엔드/풀스택 판단
// 3. 현재 MCP 설정과 권장 프로필 비교
// 4. 누락된 MCP 서버 설치 안내
```

### 5.4 Phase 3: 커스텀 MCP 서버 (v2.0+, 필요 시)

**조건**: Phase 1-2 운영에서 기존 도구로 해결 불가능한 반복 패턴이 확인된 후에만 개발

```
servers/
└── artibot-context/
    ├── package.json
    ├── index.ts                 # MCP SDK 기반 서버
    ├── tools/
    │   ├── project-structure.ts # 프로젝트 구조 캐싱
    │   ├── pattern-cache.ts     # 코드 패턴 캐싱
    │   └── dependency-graph.ts  # 의존성 그래프
    └── tsconfig.json
```

**cc-wf-studio에서 참조할 패턴**:
- `@modelcontextprotocol/sdk` 사용
- `StdioClientTransport` 기반
- 5초 연결 타임아웃
- 인메모리 캐싱 (30s TTL)
- JSON Schema → ToolParameter 변환

---

## 6. 프롬프트 토큰 최적화

### 6.1 현행 vs 제안 MCP 프롬프트 비용

| 항목 | 현행 SuperClaude | 제안 Artibot | 절감률 |
|------|-----------------|-------------|--------|
| MCP.md | ~4,400 토큰 | ~1,500 토큰 | 66% |
| ORCHESTRATOR.md (MCP 부분) | ~3,000 토큰 | ~800 토큰 | 73% |
| FLAGS.md (MCP 플래그) | ~1,200 토큰 | ~400 토큰 | 67% |
| **합계** | **~8,600 토큰** | **~2,700 토큰** | **69%** |

### 6.2 압축 전략

**삭제 대상** (기존 분석과 일치):
- Sequential 서버 섹션 전체 (내장 추론으로 대체)
- Magic 서버 섹션 (미설치, 프로필 시스템으로 대체)
- 캐싱/로드밸런싱/회로차단기 패턴 (구현 메커니즘 없음)
- 복잡한 스코어링 알고리즘 (LLM에 위임 불가)
- 5단계 서버 선택 알고리즘 (2단계로 축소)

**보존 대상**:
- Context7 활성화 패턴 및 `resolve-library-id` → `query-docs` 워크플로우
- Playwright 활성화 패턴
- 실용적 폴백: Context7 실패 → WebSearch
- 플래그: `--c7`, `--play`, `--no-mcp` (3개로 축소)

### 6.3 압축된 MCP 섹션 예시

```markdown
## MCP 서버 통합

### 활성 서버
- **Context7** (플러그인): 라이브러리 문서 조회. `resolve-library-id` → `query-docs`. 플래그: `--c7`
- **Playwright** (MCP): E2E 테스트/브라우저 자동화. 플래그: `--play`

### 활성화 규칙
- Context7: import/require 감지, 프레임워크 질문, `--c7` 명시
- Playwright: test/e2e 키워드, QA 작업, `--play` 명시
- 비활성화: `--no-mcp` (전체), `--no-c7`, `--no-play` (개별)

### 폴백
- Context7 실패 → WebSearch 대체 → 수동 구현
- Playwright 실패 → 테스트 케이스 제공 → 수동 테스트 안내
```

---

## 7. 플래그 체계 설계

### 7.1 유지 플래그 (3개)

| 플래그 | 목적 | 자동 활성화 조건 |
|--------|------|----------------|
| `--c7` | Context7 활성화 | import/require/from 감지, 프레임워크 키워드 |
| `--play` | Playwright 활성화 | test/e2e 키워드, QA 작업 |
| `--no-mcp` | 전체 MCP 비활성화 | 명시적 사용만 |

### 7.2 삭제/보류 플래그

| 플래그 | 사유 |
|--------|------|
| `--seq` | Sequential은 별도 MCP 서버가 아님 (내장 추론) |
| `--magic` | 미설치, 프로필 시스템으로 대체 |
| `--all-mcp` | 2개 서버에 무의미 |
| `--no-[server]` | 개별 비활성화 필요성 낮음 |

### 7.3 신규 플래그 (Phase 2)

| 플래그 | 목적 |
|--------|------|
| `--mcp-profile <name>` | MCP 프로필 적용 (frontend/backend/fullstack) |
| `--mcp-diagnose` | 현재 MCP 환경 진단 및 권장 사항 출력 |

---

## 8. 실행 로드맵

### Phase 1 (v1.0) - 기본 통합
- [ ] `.mcp.json` 번들 (Playwright, Windows 호환)
- [ ] `mcp-configs/recommended.json` 카탈로그 작성
- [ ] MCP 환경 감지 Hook (`detect-mcp.js`)
- [ ] 압축된 MCP 프롬프트 섹션 작성 (~2,700 토큰)
- [ ] 스킬/에이전트 frontmatter에 MCP 참조 추가
- [ ] 플래그 체계 간소화 (3개 유지)

### Phase 2 (v1.1) - 프로필 시스템
- [ ] MCP 프로필 정의 (frontend/backend/fullstack)
- [ ] 프로필 자동 감지 스크립트
- [ ] `--mcp-profile` / `--mcp-diagnose` 플래그 추가
- [ ] MCP 사용량 추적 Hook (`log-mcp-usage.js`)

### Phase 3 (v2.0) - 커스텀 서버 (필요 시)
- [ ] 프로젝트 컨텍스트 캐싱 서버 (MCP SDK 기반)
- [ ] cc-wf-studio 패턴 참조 (캐싱, 타임아웃, 스키마 변환)
- [ ] Tool Search 최적화된 `instructions` 필드

---

## 9. 참고 자료

### 분석 대상 레포
- [everything-claude-code](https://github.com/affaan-m/everything-claude-code) - MCP 카탈로그 + 플러그인 시스템
- [cc-wf-studio](https://github.com/breaking-brake/cc-wf-studio) - MCP SDK 직접 통합
- [bkit-claude-code](https://github.com/popup-studio-ai/bkit-claude-code) - Hook 기반 MCP 감지
- [ui-ux-pro-max-skill](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) - 스킬 내 MCP 참조

### 기존 분석 문서
- `MCP-ANALYSIS.md` (mcp-dev, 태스크 #13) - SuperClaude MCP 현황 분석

### 외부 참고
- [Claude Code MCP 공식 문서](https://code.claude.com/docs/en/mcp)
- [MCP Tool Search](https://claudefa.st/blog/tools/mcp-extensions/mcp-tool-search)
- [MCP SDK](https://github.com/modelcontextprotocol/sdk)
