# Artibot Cross-Platform Extension Research

> **Date**: 2026-02-19
> **Author**: platform-researcher (Artibot Platoon)
> **Version**: 1.0
> **Scope**: AI CLI/IDE 도구의 플러그인/확장 시스템 비교 분석 및 Artibot 크로스 플랫폼 전략

---

## 1. Executive Summary

Artibot(v1.1.0)은 현재 Claude Code 전용 플러그인이다. 이 리서치는 주요 AI CLI/IDE 도구 8개의 플러그인 시스템을 분석하고, Artibot을 크로스 플랫폼으로 확장하기 위한 전략을 제시한다.

**핵심 발견사항**:
- **SKILL.md 포맷이 사실상 유니버설 표준으로 자리잡음** (25+ 플랫폼 지원, Linux Foundation AAIF 거버넌스)
- Artibot의 기존 skills/ 디렉토리 구조가 이미 유니버설 SKILL.md 포맷과 높은 호환성 보유
- MCP(Model Context Protocol)가 도구 연결의 표준 프로토콜로 확립
- A2A(Agent2Agent) 프로토콜이 에이전트 간 통신 표준으로 부상
- **최소 어댑터 레이어**로 Gemini CLI, Codex CLI, Cursor, Copilot에 동시 배포 가능

---

## 2. Platform Analysis (플랫폼별 분석)

### 2.1 Comparison Matrix

| Feature | Claude Code | Gemini CLI | OpenAI Codex CLI | Cursor | GitHub Copilot | Antigravity | Aider | Continue.dev | Windsurf |
|---------|------------|------------|-----------------|--------|----------------|-------------|-------|-------------|----------|
| **Instruction File** | CLAUDE.md | GEMINI.md | AGENTS.md | .cursorrules | copilot-instructions.md | GEMINI.md | CONVENTIONS.md | config.yaml | .windsurfrules |
| **Plugin Manifest** | plugin.json | gemini-extension.json | agents/openai.yaml | .cursor/modes.json | - | - | - | config.json/yaml | - |
| **Skill System** | .claude/skills/ SKILL.md | .agent/skills/ SKILL.md | .agents/skills/ SKILL.md | .cursor/skills/ | SKILL.md (awesome-copilot) | .agent/skills/ SKILL.md | - | Prompt Files | - |
| **Agent Definition** | Markdown (.md) | Markdown + JSON | AGENTS.md + YAML | JSON (modes.json) | .instructions.md | Markdown | - | YAML | - |
| **Slash Commands** | commands/ dir | commands/ TOML | - | Built-in | - | - | Built-in (/help etc) | config.json/yaml | Built-in |
| **Hooks System** | hooks.json | hooks/hooks.json | - | Hooks | Hooks | - | - | - | - |
| **MCP Support** | Native | Native | Native (config.toml) | Native | Native | Native | - | Native | Native |
| **Multi-Agent** | Agent Teams API | Extensions | Agents SDK | Parallel Agents | Agent Mode | oh-my-ag | - | - | Cascade |
| **Progressive Disclosure** | Yes | Yes | Yes | - | - | Yes | - | - | - |
| **Context Hierarchy** | Global > Project > Dir | Global > Project > Dir | Global > Root > CWD | Project > Dir | Org > Repo > Dir | Global > Workspace | Global > Project | Global > Workspace | Project |

### 2.2 Detailed Platform Analysis

---

#### A. Gemini CLI (Google)

**호환성 점수: 9/10** - Artibot과 가장 유사한 구조

**Extension System**:
- `gemini-extension.json` 매니페스트 (Artibot의 plugin.json과 거의 동일)
- GEMINI.md 컨텍스트 파일 (CLAUDE.md 대응)
- commands/ 디렉토리의 TOML 기반 커맨드 (Artibot의 commands/ .md 대응)
- skills/ 디렉토리 (동일 SKILL.md 포맷)
- agents/ 디렉토리 (에이전트 정의)
- hooks/hooks.json (Artibot과 동일 패턴)

**Agent Definition**: Markdown 기반 + JSON 매니페스트

**Extension Manifest** (`gemini-extension.json`):
```json
{
  "name": "extension-name",
  "version": "1.0.0",
  "description": "...",
  "mcpServers": { ... },
  "contextFileName": "GEMINI.md",
  "excludeTools": [],
  "settings": [
    { "name": "...", "envVar": "...", "sensitive": true }
  ]
}
```

**Adapter Strategy**:
- plugin.json -> gemini-extension.json 변환기 (필드 매핑 거의 1:1)
- CLAUDE.md -> GEMINI.md 변환 (내용 그대로, 파일명만 변경)
- commands/*.md -> commands/*.toml 변환 필요
- skills/ 및 hooks/ 는 그대로 호환

**Sources**:
- [Gemini CLI Extensions Reference](https://geminicli.com/docs/extensions/reference/)
- [Getting Started with Extensions](https://geminicli.com/docs/extensions/writing-extensions/)
- [GEMINI.md Files](https://geminicli.com/docs/cli/gemini-md/)
- [Conductor Extension](https://www.marktechpost.com/2026/02/02/google-releases-conductor-a-context-driven-gemini-cli-extension-that-stores-knowledge-as-markdown-and-orchestrates-agentic-workflows/)

---

#### B. OpenAI Codex CLI

**호환성 점수: 8/10** - SKILL.md 표준의 원조, 높은 호환성

**Extension System**:
- AGENTS.md 기반 인스트럭션 체인 (CLAUDE.md 대응)
- SKILL.md 포맷이 Codex에서 시작 -> 유니버설 표준으로 확장
- .agents/skills/ 디렉토리 (Artibot .claude/skills/ 대응)
- agents/openai.yaml 메타데이터 (UI, 정책, 의존성)
- scripts/, references/, assets/ 서브디렉토리

**Agent Definition**: AGENTS.md (Markdown) + YAML metadata

**Skill Discovery Hierarchy**:
```
$CWD/.agents/skills
$REPO_ROOT/.agents/skills
$HOME/.agents/skills
/etc/codex/skills
```

**SKILL.md Format**:
```yaml
---
name: skill-name
description: "When to trigger and when not to trigger"
---
[Markdown instructions]
```

**Multi-Agent**: OpenAI Agents SDK와 통합, MCP 서버로 CLI 노출 가능

**Adapter Strategy**:
- skills/ 디렉토리 그대로 복사 (.claude/skills/ -> .agents/skills/)
- CLAUDE.md -> AGENTS.md 변환 (내용 유지, Claude 전용 참조 제거)
- plugin.json -> agents/openai.yaml 매핑
- commands/ 는 SKILL.md 기반 워크플로로 변환 가능

**Sources**:
- [Codex Agent Skills](https://developers.openai.com/codex/skills/)
- [Custom AGENTS.md](https://developers.openai.com/codex/guides/agents-md/)
- [Codex with Agents SDK](https://developers.openai.com/codex/guides/agents-sdk/)
- [Codex CLI Features](https://developers.openai.com/codex/cli/features/)

---

#### C. Cursor IDE

**호환성 점수: 6/10** - Rules + Modes 기반, 구조적 차이 있음

**Extension System**:
- .cursorrules 파일 (CLAUDE.md 대응, 단순 텍스트)
- .cursor/modes.json (커스텀 에이전트 정의)
- .cursor/skills/ (SKILL.md 호환 가능)
- MCP 서버 네이티브 지원
- 병렬 에이전트 실행 (Composer 2.0)

**Agent Definition**: JSON (modes.json)
```json
{
  "modes": [{
    "name": "agent-name",
    "customPrompt": "Role and instructions...",
    "model": "claude-opus-4-6",
    "tools": ["read", "edit", "terminal"],
    "mcpServers": [...]
  }]
}
```

**Adapter Strategy**:
- agents/*.md -> .cursor/modes.json 변환 (Markdown prompt -> customPrompt 필드)
- CLAUDE.md -> .cursorrules 변환
- skills/ -> .cursor/skills/ 복사
- commands/ -> 커스텀 프롬프트로 변환 (slash command 제한적)
- hooks -> Cursor Hooks 매핑

**Sources**:
- [Cursor Custom Agent Configuration](https://deepwiki.com/bmadcode/cursor-custom-agents-rules-generator/3.1-agent-configuration)
- [Awesome CursorRules](https://github.com/PatrickJS/awesome-cursorrules)
- [Cursor Directory](https://cursor.directory/)

---

#### D. GitHub Copilot

**호환성 점수: 7/10** - Skills/Agents 생태계 급성장 중

**Extension System**:
- .github/copilot-instructions.md (CLAUDE.md 대응)
- .instructions.md 파일들 (디렉토리별 인스트럭션)
- SKILL.md 호환 (awesome-copilot 생태계)
- MCP 네이티브 지원 (Agent Mode에서)
- Hooks 시스템

**Agent Definition**: Markdown 기반 커스텀 에이전트 (docs.github.com)

**Adapter Strategy**:
- CLAUDE.md -> copilot-instructions.md 변환
- skills/ -> 그대로 호환 (SKILL.md 포맷)
- agents/*.md -> 커스텀 에이전트 설정 변환
- MCP 설정 그대로 활용 가능

**Sources**:
- [Creating Custom Agents for Copilot](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/create-custom-agents)
- [Custom Instructions Guide](https://smartscope.blog/en/generative-ai/github-copilot/github-copilot-custom-instructions-guide/)
- [Awesome Copilot](https://github.com/github/awesome-copilot)

---

#### E. Google Antigravity

**호환성 점수: 8/10** - SKILL.md + .agent/ 구조 직접 호환

**Extension System**:
- GEMINI.md 기반 (Gemini CLI과 공유)
- .agent/skills/ 디렉토리 (SKILL.md 포맷 직접 호환)
- ~/.gemini/antigravity/skills/ (글로벌 스킬)
- Progressive Disclosure 패턴 (Artibot과 동일)

**Agent Definition**: Markdown 기반 SKILL.md

**SKILL.md Format** (Antigravity):
```yaml
---
name: skill-name
description: "Skill description"
---
[Markdown instructions with scripts/ and references/]
```

**Multi-Agent**: oh-my-ag 프레임워크 (6 전문 에이전트, Serena Memory)

**Adapter Strategy**:
- skills/ -> .agent/skills/ 직접 복사
- CLAUDE.md -> GEMINI.md 변환
- agents/*.md -> 에이전트 스킬로 변환
- hooks -> 제한적 지원

**Sources**:
- [Antigravity Skills Tutorial](https://medium.com/google-cloud/tutorial-getting-started-with-antigravity-skills-864041811e0d)
- [Antigravity Awesome Skills (800+)](https://github.com/sickn33/antigravity-awesome-skills)
- [oh-my-ag Framework](https://github.com/first-fluke/oh-my-ag)

---

#### F. Aider

**호환성 점수: 4/10** - 최소한의 확장 시스템

**Extension System**:
- .aider.conf.yml (YAML 설정 파일)
- CONVENTIONS.md (코딩 규칙 파일)
- 커스텀 커맨드 제안됨 (Issue #894) - 아직 YAML 기반으로 미구현
- 플러그인 시스템 없음
- MCP 미지원

**Agent Definition**: 없음 (단일 에이전트 모델)

**Adapter Strategy**:
- CLAUDE.md -> CONVENTIONS.md 변환 (코딩 규칙만)
- skills/ -> 활용 불가 (자체 스킬 시스템 없음)
- 제한적 호환 - Aider는 LLM 프론트엔드에 가까움

**Sources**:
- [Aider Configuration](https://aider.chat/docs/config.html)
- [Aider Conventions](https://aider.chat/docs/usage/conventions.html)
- [Custom Commands Feature Request](https://github.com/Aider-AI/aider/issues/894)

---

#### G. Continue.dev

**호환성 점수: 5/10** - IDE 확장 중심, CLI 제한적

**Extension System**:
- config.yaml (새 형식) / config.json (레거시)
- Prompt Files (.md) -> slash command로 등록 가능
- MCP 네이티브 지원
- 에이전트 시스템 (config.yaml 정의)

**Agent Definition**: YAML 기반
```yaml
agents:
  - name: "agent-name"
    models: [...]
    rules: [...]
    tools: [...]
```

**Adapter Strategy**:
- agents/*.md -> config.yaml agents 섹션 변환
- commands/*.md -> Prompt Files (.md, invokable: true)
- skills/ -> context providers로 변환
- MCP 설정 직접 호환

**Sources**:
- [Continue Plugin Architecture](https://deepwiki.com/continuedev/continue/5.2-plugin-architecture)
- [Continue Configuration](https://docs.continue.dev/customize/deep-dives/configuration)
- [Continue CLI (cn)](https://docs.continue.dev/guides/cli)

---

#### H. Windsurf (Codeium)

**호환성 점수: 5/10** - Cascade 에이전트 중심, 제한적 확장

**Extension System**:
- .windsurfrules (CLAUDE.md 대응)
- MCP 네이티브 지원
- Cascade 에이전트 (내장 다중 단계 에이전트)
- VS Code/JetBrains 플러그인

**Agent Definition**: 내장 Cascade 에이전트 (커스텀 에이전트 제한적)

**Adapter Strategy**:
- CLAUDE.md -> .windsurfrules 변환
- MCP 설정 활용
- 커스텀 에이전트/스킬 시스템 제한적

**Sources**:
- [Windsurf Review 2026](https://vibecoding.app/blog/windsurf-review)
- [Cascade Agent](https://windsurf.com/cascade)

---

## 3. Universal Standards & Protocols

### 3.1 SKILL.md Universal Format

**현황**: 2026년 2월 기준, SKILL.md 포맷은 25+ 플랫폼에서 지원되는 사실상의 유니버설 표준이다.

| Aspect | Details |
|--------|---------|
| **Governance** | Linux Foundation AAIF (Agentic AI Foundation, 2025.12 설립) |
| **Supported Platforms** | Claude Code, Codex, Gemini CLI, Antigravity, Cursor, Copilot, Windsurf, 30+ others |
| **Format** | YAML frontmatter (name, description) + Markdown instructions |
| **Discovery** | .claude/skills/, .agents/skills/, .agent/skills/ (플랫폼별) |
| **Progressive Disclosure** | 메타데이터만 로드 -> 필요시 전체 로드 |
| **Ecosystem Tools** | [OpenSkills](https://github.com/numman-ali/openskills) - npm 기반 유니버설 스킬 로더 |

**Artibot 현황**: Artibot의 skills/ 디렉토리는 이미 SKILL.md + references/ 구조를 사용 중. 유니버설 표준과 높은 호환성.

### 3.2 MCP (Model Context Protocol)

| Aspect | Details |
|--------|---------|
| **Role** | Agent-to-Tool 통신 표준 |
| **Originator** | Anthropic |
| **Adoption** | Claude Code, Gemini CLI, Codex CLI, Cursor, Copilot, Continue, Windsurf |
| **Artibot** | .mcp.json에 Context7 + Playwright 설정 -> 모든 MCP 지원 플랫폼에서 활용 가능 |

### 3.3 A2A (Agent2Agent Protocol)

| Aspect | Details |
|--------|---------|
| **Role** | Agent-to-Agent 통신 표준 |
| **Originator** | Google (2025.04), Linux Foundation 기증 |
| **Partners** | 50+ (Atlassian, Salesforce, SAP, Langchain 등) |
| **Version** | 0.3 (gRPC, SSE, webhook 지원) |
| **Relevance** | Artibot Agent Teams의 팀 간 통신을 A2A로 표준화 가능 |

---

## 4. Cross-Platform Benchmark Frameworks

### 4.1 Reference Frameworks

| Framework | Type | Cross-Platform | Pattern | URL |
|-----------|------|---------------|---------|-----|
| **OpenSkills** | Universal Skills Loader | Claude, Codex, Cursor, Windsurf, Aider | SKILL.md npm installer | [GitHub](https://github.com/numman-ali/openskills) |
| **oh-my-ag** | Multi-Agent for Antigravity | Antigravity, Gemini CLI | 6 agents, Serena Memory | [GitHub](https://github.com/first-fluke/oh-my-ag) |
| **awesome-agent-skills** | Skills Collection | All SKILL.md platforms | 800+ skills catalog | [GitHub](https://github.com/sickn33/antigravity-awesome-skills) |
| **awesome-copilot** | Copilot Ecosystem | Copilot + MCP tools | Agents, Skills, Hooks, Plugins | [GitHub](https://github.com/github/awesome-copilot) |
| **Conductor** | Context-Driven Extension | Gemini CLI | Markdown knowledge, agentic workflows | [Google Blog](https://developers.googleblog.com/making-gemini-cli-extensions-easier-to-use/) |
| **LangGraph** | Multi-Agent Framework | Any (Python/JS SDK) | MCP adapter, cross-framework | [LangChain](https://www.langchain.com/langgraph) |
| **AutoGen** | Multi-Agent Framework | Any (Python SDK) | MCP extension module | [Microsoft](https://github.com/microsoft/autogen) |
| **CrewAI** | Multi-Agent Framework | Any (Python SDK) | MCP URL config, role-based | [CrewAI](https://www.crewai.com/) |

### 4.2 Key Pattern: OpenSkills

OpenSkills는 Artibot 크로스 플랫폼 전략의 핵심 벤치마크이다.

- **"npm i -g openskills"** 로 설치
- Anthropic의 SKILL.md 포맷을 모든 AI 에이전트로 확장
- `--universal` 플래그로 .agent/skills/ 에 설치 (Codex/Antigravity 호환)
- 기본은 .claude/skills/ (Claude Code 호환)
- 프라이빗 git repo/로컬 패스 지원

---

## 5. Cross-Platform Adapter Architecture (어댑터 아키텍처 제안)

### 5.1 Architecture Overview

```
artibot/
├── core/                    # Platform-agnostic core
│   ├── agents/              # Agent definitions (Markdown)
│   ├── skills/              # Universal SKILL.md format
│   ├── commands/            # Command definitions (Markdown)
│   ├── hooks/               # Hook definitions (JSON)
│   ├── lib/                 # Core logic (ESM)
│   └── artibot.config.json  # Core config
│
├── adapters/                # Platform-specific adapters
│   ├── claude-code/         # Current: .claude-plugin/
│   │   ├── plugin.json
│   │   ├── generate.js      # Symlink/copy core -> .claude/
│   │   └── CLAUDE.md.tmpl
│   │
│   ├── gemini-cli/          # Gemini CLI extension
│   │   ├── gemini-extension.json
│   │   ├── generate.js      # Convert commands/ md->toml
│   │   └── GEMINI.md.tmpl
│   │
│   ├── codex-cli/           # OpenAI Codex CLI
│   │   ├── openai.yaml
│   │   ├── generate.js      # Map to .agents/ structure
│   │   └── AGENTS.md.tmpl
│   │
│   ├── cursor/              # Cursor IDE
│   │   ├── modes.json.tmpl
│   │   ├── generate.js      # Convert agents -> modes.json
│   │   └── cursorrules.tmpl
│   │
│   ├── copilot/             # GitHub Copilot
│   │   ├── generate.js
│   │   └── copilot-instructions.md.tmpl
│   │
│   └── universal/           # .agent/skills/ (Antigravity etc)
│       └── generate.js
│
├── cli/                     # artibot CLI tool
│   ├── index.js
│   ├── commands/
│   │   ├── init.js          # artibot init --platform <name>
│   │   ├── build.js         # artibot build --target <platform>
│   │   ├── sync.js          # artibot sync (update all targets)
│   │   └── publish.js       # artibot publish
│   └── templates/
│
└── package.json
```

### 5.2 Adapter Interface

각 어댑터가 구현해야 할 인터페이스:

```javascript
// adapters/base-adapter.js
export class BaseAdapter {
  /** Platform identifier */
  get platformId() { throw new Error('Not implemented') }

  /** Target directory for generated files */
  get targetDir() { throw new Error('Not implemented') }

  /** Convert core config to platform manifest */
  generateManifest(coreConfig) { throw new Error('Not implemented') }

  /** Convert CLAUDE.md template to platform instruction file */
  generateInstructionFile(claudeMd) { throw new Error('Not implemented') }

  /** Convert command definitions */
  generateCommands(commands) { throw new Error('Not implemented') }

  /** Copy/transform skills */
  generateSkills(skills) { throw new Error('Not implemented') }

  /** Convert agent definitions */
  generateAgents(agents) { throw new Error('Not implemented') }

  /** Convert hooks */
  generateHooks(hooks) { throw new Error('Not implemented') }

  /** Platform-specific validation */
  validate() { throw new Error('Not implemented') }
}
```

### 5.3 Conversion Mapping Table

| Artibot Source | Claude Code | Gemini CLI | Codex CLI | Cursor | Copilot |
|---------------|------------|------------|-----------|--------|---------|
| `artibot.config.json` | plugin.json | gemini-extension.json | agents/openai.yaml | - | - |
| `CLAUDE.md` (template) | CLAUDE.md | GEMINI.md | AGENTS.md | .cursorrules | copilot-instructions.md |
| `agents/*.md` | agents/*.md | agents/*.md | (in AGENTS.md) | .cursor/modes.json | custom agents |
| `commands/*.md` | commands/*.md | commands/*.toml | SKILL.md workflows | prompts | - |
| `skills/*/SKILL.md` | .claude/skills/ | .agent/skills/ | .agents/skills/ | .cursor/skills/ | skills/ |
| `hooks/hooks.json` | hooks.json | hooks/hooks.json | - | hooks | hooks |
| `.mcp.json` | .mcp.json | mcpServers in manifest | config.toml [mcp] | .cursor/mcp.json | mcp config |

### 5.4 CLI Tool Design

```bash
# Initialize Artibot for a specific platform
artibot init --platform gemini-cli
artibot init --platform codex-cli
artibot init --platform cursor
artibot init --platform copilot
artibot init --platform all

# Build/generate platform-specific files
artibot build --target gemini-cli    # generates gemini-extension.json, GEMINI.md, commands/*.toml
artibot build --target codex-cli     # generates AGENTS.md, .agents/skills/
artibot build --target all           # generates for all configured platforms

# Sync changes from core to all targets
artibot sync

# Publish to platform registries
artibot publish --platform gemini-cli  # gemini extensions publish
artibot publish --platform npm         # npm publish (OpenSkills compatible)
```

---

## 6. Implementation Roadmap

### Phase 1: Universal Skills Export (Priority: HIGH, Effort: LOW)

**Goal**: Artibot skills를 유니버설 SKILL.md 포맷으로 즉시 배포 가능하게

**Tasks**:
1. skills/*/SKILL.md에 표준 YAML frontmatter 추가 (name, description)
2. OpenSkills 호환 패키징 (npm publish 가능)
3. .agent/skills/ 심링크/복사 스크립트 작성
4. 테스트: Codex CLI, Antigravity에서 스킬 로딩 확인

**Impact**: 25+ 플랫폼에서 즉시 Artibot 스킬 사용 가능
**Estimated Effort**: 1-2 days

### Phase 2: Gemini CLI Extension (Priority: HIGH, Effort: MEDIUM)

**Goal**: Artibot을 Gemini CLI 확장으로 배포

**Tasks**:
1. gemini-extension.json 매니페스트 생성
2. CLAUDE.md -> GEMINI.md 변환 스크립트
3. commands/*.md -> commands/*.toml 변환기
4. hooks.json 호환 레이어
5. MCP 서버 설정 마이그레이션
6. `gemini extensions install` 테스트

**Impact**: Google 생태계 사용자 접근
**Estimated Effort**: 3-5 days

### Phase 3: Codex CLI Integration (Priority: MEDIUM, Effort: MEDIUM)

**Goal**: Codex CLI에서 Artibot 에이전트 + 스킬 활용

**Tasks**:
1. AGENTS.md 생성기 (orchestrator + 17 agents 인스트럭션 통합)
2. agents/openai.yaml 메타데이터 생성
3. .agents/skills/ 디렉토리 구조 매핑
4. Codex Agents SDK 통합 테스트

**Estimated Effort**: 3-5 days

### Phase 4: Cursor Adapter (Priority: MEDIUM, Effort: MEDIUM)

**Goal**: Cursor IDE에서 Artibot 에이전트 모드 활용

**Tasks**:
1. agents/*.md -> .cursor/modes.json 변환기
2. .cursorrules 생성기
3. .cursor/skills/ 스킬 복사
4. MCP 설정 매핑

**Estimated Effort**: 2-3 days

### Phase 5: Adapter CLI Tool (Priority: LOW, Effort: HIGH)

**Goal**: `artibot` CLI로 모든 플랫폼 빌드/배포 자동화

**Tasks**:
1. CLI 프레임워크 (Node.js ESM, zero deps 유지)
2. BaseAdapter 인터페이스 구현
3. 5개 플랫폼 어댑터 구현
4. `artibot build/sync/publish` 커맨드
5. CI/CD 통합 (GitHub Actions)

**Estimated Effort**: 1-2 weeks

### Phase 6: A2A Protocol Integration (Priority: LOW, Effort: HIGH)

**Goal**: Artibot Agent Teams를 A2A 프로토콜로 표준화

**Tasks**:
1. A2A Agent Card 생성 (에이전트 메타데이터)
2. SendMessage -> A2A 메시지 매핑
3. TaskCreate/Update -> A2A Task 매핑
4. 크로스 플랫폼 에이전트 팀 통신

**Estimated Effort**: 2-3 weeks

---

## 7. Risk Analysis

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| SKILL.md 표준 분화 | Low | High | AAIF 거버넌스 모니터링, 최소 공통분모 유지 |
| 플랫폼별 빠른 API 변경 | Medium | Medium | 어댑터 패턴으로 변경 격리, 버전별 어댑터 |
| Agent Teams API의 플랫폼 비호환 | High | High | Agent Teams는 Claude Code 전용 유지, 다른 플랫폼은 SKILL.md + 단일 에이전트 |
| MCP 서버 호환성 이슈 | Low | Medium | 표준 MCP 프로토콜 준수, 플랫폼별 테스트 |
| 유지보수 부담 증가 | Medium | Medium | 어댑터 자동 생성, CI/CD 검증 파이프라인 |

---

## 8. Key Recommendations

### 즉시 실행 가능 (Quick Wins)

1. **skills/ YAML frontmatter 표준화**: 기존 SKILL.md에 name/description frontmatter 추가만으로 25+ 플랫폼 호환
2. **OpenSkills 패키지 등록**: `npm publish`로 즉시 배포 가능
3. **.agent/skills/ 심링크**: .claude/skills/ -> .agent/skills/ 심링크로 Antigravity/Codex 즉시 호환

### 전략적 결정 필요

1. **Core와 Adapter 분리 시점**: 지금은 Claude Code 전용이므로 Phase 2 이전에 core/ 분리 구조 확정
2. **Agent Teams의 크로스 플랫폼 전략**: Claude Code의 Agent Teams API는 독점적 -> 다른 플랫폼에서는 단일 orchestrator 에이전트 + SKILL.md 패턴으로 대체
3. **CLI 도구 우선순위**: Phase 1-4는 수동 스크립트로 충분, Phase 5 CLI는 실제 멀티 플랫폼 배포 시작 후

### 장기 비전

- **Artibot as Universal Agent Framework**: SKILL.md + MCP + A2A를 모두 활용하는 유니버설 에이전트 오케스트레이션 프레임워크
- **"Write Once, Deploy Anywhere"**: 어댑터 레이어를 통한 단일 소스 멀티 플랫폼 배포
- **Agent Teams Standardization**: Claude Code 이외 플랫폼이 멀티 에이전트를 지원하면 A2A 기반 표준 통신으로 전환

---

## 9. Appendix

### A. Instruction File Comparison

| Platform | File | Location | Max Size | Hierarchy |
|----------|------|----------|----------|-----------|
| Claude Code | CLAUDE.md | Project root, ~/.claude/ | No limit | Global > Project > Dir |
| Gemini CLI | GEMINI.md | Project root, ~/.gemini/ | No limit | Global > Project > Dir |
| Codex CLI | AGENTS.md | Project root, ~/.codex/ | 32KiB default | Global > Root > CWD |
| Cursor | .cursorrules | Project root, .cursor/ | No limit | Project > Dir |
| Copilot | copilot-instructions.md | .github/ | No limit | Org > Repo > Dir |
| Antigravity | GEMINI.md | Project root | No limit | Global > Workspace |
| Aider | CONVENTIONS.md | Project root | No limit | Global > Project |
| Continue | config.yaml | ~/.continue/ | No limit | Global > Workspace |
| Windsurf | .windsurfrules | Project root | No limit | Project |

### B. Skills Directory Comparison

| Platform | Skills Path | Format | Discovery |
|----------|------------|--------|-----------|
| Claude Code | .claude/skills/ | SKILL.md | Auto-detect |
| Codex CLI | .agents/skills/ | SKILL.md + openai.yaml | Progressive disclosure |
| Gemini CLI | Extension skills/ | SKILL.md | Extension loading |
| Antigravity | .agent/skills/ | SKILL.md | Auto-detect |
| Cursor | .cursor/skills/ | SKILL.md | Manual/auto |
| Copilot | skills/ | SKILL.md | awesome-copilot |
| OpenSkills | .claude/skills/ or .agent/skills/ | SKILL.md | npm/CLI install |

### C. MCP Configuration Comparison

| Platform | Config Location | Format | Notes |
|----------|----------------|--------|-------|
| Claude Code | .mcp.json | JSON | mcpServers object |
| Gemini CLI | gemini-extension.json | JSON | mcpServers in manifest |
| Codex CLI | ~/.codex/config.toml | TOML | [mcp-servers] section |
| Cursor | .cursor/mcp.json | JSON | Similar to Claude |
| Copilot | VS Code settings | JSON | MCP in settings.json |
| Continue | config.yaml | YAML | mcpServers section |
| Windsurf | Settings | JSON | MCP integrations |
