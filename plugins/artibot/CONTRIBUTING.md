# Contributing to Artibot

Artibot에 기여해 주셔서 감사합니다! / Thank you for contributing to Artibot!

---

## Table of Contents / 목차

- [Welcome / 환영합니다](#welcome--환영합니다)
- [Code of Conduct / 행동 강령](#code-of-conduct--행동-강령)
- [Prerequisites / 사전 요구사항](#prerequisites--사전-요구사항)
- [Getting Started / 시작하기](#getting-started--시작하기)
- [Plugin Structure / 플러그인 구조](#plugin-structure--플러그인-구조)
- [How to Add an Agent / 에이전트 추가 방법](#how-to-add-an-agent--에이전트-추가-방법)
- [How to Add a Skill / 스킬 추가 방법](#how-to-add-a-skill--스킬-추가-방법)
- [How to Add a Command / 커맨드 추가 방법](#how-to-add-a-command--커맨드-추가-방법)
- [How to Write Hooks / 훅 작성 방법](#how-to-write-hooks--훅-작성-방법)
- [Testing / 테스트](#testing--테스트)
- [Code Style / 코드 스타일](#code-style--코드-스타일)
- [ESLint Configuration / ESLint 설정](#eslint-configuration--eslint-설정)
- [Commit Messages / 커밋 메시지](#commit-messages--커밋-메시지)
- [Pull Requests / 풀 리퀘스트](#pull-requests--풀-리퀘스트)

---

## Welcome / 환영합니다

**English**: Artibot is an intelligent orchestration plugin for Claude Code built on the native Agent Teams API. We welcome contributions that improve agents, skills, commands, hooks, and documentation. Before contributing, please read this guide carefully.

**한국어**: Artibot은 Claude Code의 네이티브 Agent Teams API 위에 구축된 지능형 오케스트레이션 플러그인입니다. 에이전트, 스킬, 커맨드, 훅, 문서를 개선하는 기여를 환영합니다. 기여 전 이 가이드를 꼼꼼히 읽어주세요.

**Core Philosophy / 핵심 철학**: Zero external dependencies. Pure Node.js built-ins only. Agent Teams API as the core engine.

---

## Code of Conduct / 행동 강령

**English**: This project follows the [Contributor Covenant Code of Conduct](https://www.contributor-covenant.org/version/2/1/code_of_conduct/). By participating, you agree to uphold a welcoming, inclusive, and harassment-free environment for everyone.

**한국어**: 이 프로젝트는 [기여자 행동 강령 규약](https://www.contributor-covenant.org/version/2/1/code_of_conduct/)을 따릅니다. 참여함으로써 모든 사람을 위한 환영적이고 포용적이며 괴롭힘 없는 환경을 유지하는 데 동의하게 됩니다.

**Key principles / 핵심 원칙**:

- Be respectful and constructive in all communications
- Accept feedback gracefully and provide it kindly
- Focus on what is best for the community and the project
- Report unacceptable behavior to the project maintainers via GitHub Issues or email

---

## Prerequisites / 사전 요구사항

| Requirement | Version | Note |
|-------------|---------|------|
| Node.js | >= 18.0.0 | ESM support required |
| Claude Code CLI | latest | Plugin runtime |
| `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` | `"1"` | Agent Teams activation |

**Activate Agent Teams / Agent Teams 활성화**:
```json
// ~/.claude/settings.json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  }
}
```

**Verify prerequisites / 사전 요구사항 확인**:
```bash
# Check Node.js version (must be >= 18)
node --version

# Check Claude Code is installed
claude --version
```

---

## Getting Started / 시작하기

**English**:
```bash
# 1. Fork and clone the repository
git clone https://github.com/<your-username>/artibot.git
cd artibot

# 2. Install dev dependencies (vitest, eslint only)
cd plugins/artibot
npm install

# 3. Run validation to confirm everything works
npm run validate

# 4. Run tests
npm test

# 5. Run linter
npm run lint

# 6. Run full CI check (validate + lint + test)
npm run ci
```

**한국어**: 저장소를 포크하고 클론한 뒤, `plugins/artibot` 디렉토리에서 `npm install`을 실행하세요. devDependencies(vitest, eslint)만 설치되며, 외부 런타임 의존성은 없습니다.

**Available npm scripts / 사용 가능한 npm 스크립트**:

| Script | Description |
|--------|-------------|
| `npm test` | Run all tests with vitest |
| `npm run test:watch` | Run tests in watch mode (auto-rerun on file change) |
| `npm run test:coverage` | Run tests with V8 coverage report |
| `npm run lint` | Run ESLint on `lib/`, `scripts/`, `tests/` |
| `npm run lint:fix` | Run ESLint with auto-fix |
| `npm run validate` | Run structural validation of agents, skills, commands, hooks |
| `npm run ci` | Full CI pipeline: validate + lint + test |

---

## Plugin Structure / 플러그인 구조

```
plugins/artibot/
├── .claude-plugin/plugin.json   # Plugin manifest (version, name, entry)
├── artibot.config.json          # Runtime config (Agent Teams, cognitive, learning)
├── package.json                 # ESM runtime, zero prod dependencies
├── .mcp.json                    # MCP server config (Context7, Playwright)
│
├── agents/          (18+ files) # Agent definitions (Markdown)
│   ├── orchestrator.md          # CTO / team leader (TeamCreate, SendMessage, TaskCreate)
│   └── [specialist agents]      # Teammates (SendMessage + TaskList/Update)
│
├── commands/        (27+ files) # Slash command definitions (Markdown)
│   ├── sc.md                    # Main router (/sc)
│   └── [commands].md
│
├── skills/          (25+ dirs)  # Skill definitions (SKILL.md + references/)
│   ├── orchestration/           # Routing intelligence, delegation mode
│   └── [skills]/
│
├── hooks/hooks.json             # Hook event mappings (12 event types)
├── scripts/hooks/   (18 files)  # ESM hook scripts (3 types: command, prompt, agent)
├── scripts/ci/      (4 files)   # Validation scripts
│
├── lib/
│   ├── core/        (7 files)   # platform, config, cache, io, debug, file, tui
│   ├── intent/      (4 files)   # language, trigger, ambiguity, index
│   ├── context/     (2 files)   # hierarchy, session
│   ├── cognitive/   (4 files)   # router, system1, system2, sandbox
│   ├── learning/    (7 files)   # memory, grpo, knowledge-transfer, lifelong, tool-learner
│   ├── privacy/     (1 file)    # pii-scrubber (50+ regex patterns)
│   ├── swarm/       (4 files)   # swarm-client, pattern-packager, sync-scheduler
│   ├── system/      (2 files)   # telemetry-collector, context-injector
│   └── adapters/    (5 files)   # base, gemini, codex, cursor adapters
│
├── output-styles/   (3 files)   # default, compressed, mentor
└── templates/       (3 files)   # agent-template, skill-template, command-template
```

**Key architectural constraint / 핵심 아키텍처 제약**: All JavaScript files under `lib/` and `scripts/` must use only Node.js built-in modules (`node:fs`, `node:path`, `node:crypto`, `node:os`). No npm runtime packages allowed.

---

## How to Add an Agent / 에이전트 추가 방법

**English**: Copy the agent template and fill in the required sections.

**한국어**: 에이전트 템플릿을 복사하여 필수 섹션을 작성하세요.

### Step 1: Create from template

```bash
cp plugins/artibot/templates/agent-template.md \
   plugins/artibot/agents/my-agent.md
```

### Step 2: Fill in required sections / 필수 섹션 작성

The agent Markdown file uses YAML frontmatter followed by structured sections:

```markdown
---
name: my-agent
description: |
  Role description in one line.
  Expertise and core capabilities.

  Use proactively when [auto-invocation conditions].

  Triggers: keyword1, keyword2,
  한국어키워드1, 한국어키워드2

  Do NOT use for: [exclusion scenarios]
model: opus|sonnet|haiku
tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
skills:
  - related-skill
---

## Core Responsibilities

1. **Responsibility 1**: Specific action description
2. **Responsibility 2**: Specific action description

## Process

| Step | Action | Output |
|------|--------|--------|
| 1. Analyze | Analyze input and determine scope | Analysis result |
| 2. Execute | Perform core work | Deliverable |
| 3. Verify | Validate results | Verification report |

## Output Format

Structured output template here.

## Anti-Patterns

- Do NOT do this
- Do NOT do that
```

### Step 3: Add Team Collaboration Tools (mandatory)

Every agent that participates in Agent Teams must include:

```markdown
## Team Collaboration Tools

- **SendMessage** - Report to leader, respond to shutdown requests
- **TaskList / TaskGet** - Check assigned tasks from shared task list
- **TaskUpdate** - Self-assign tasks and report completion
```

### Step 4: Select a model tier / 모델 선택

| Model | Use case | Cost |
|-------|----------|------|
| `opus` | Deep reasoning, architecture decisions, security analysis | Highest |
| `sonnet` | General coding, balanced tasks, API development | Medium |
| `haiku` | Lightweight tasks, documentation sync, content generation | Lowest |

### Step 5: Register the agent / 에이전트 등록

Add your agent to `artibot.config.json`:

1. Add to `agents.modelPolicy` under the appropriate tier
2. Add to `agents.categories` under the appropriate category (`manager`, `expert`, `builder`, `support`)
3. Add to `agents.taskBased` with keyword mapping
4. Add the file path to `.claude-plugin/plugin.json` under `agents[]`

### Step 6: Validate

```bash
node scripts/ci/validate-agents.js
```

---

## How to Add a Skill / 스킬 추가 방법

**English**: Skills provide domain expertise activated by trigger keywords.

**한국어**: 스킬은 트리거 키워드에 의해 활성화되는 도메인 전문성을 제공합니다.

### Step 1: Create skill directory and files

```bash
mkdir -p plugins/artibot/skills/my-skill/references
cp plugins/artibot/templates/skill-template.md \
   plugins/artibot/skills/my-skill/SKILL.md
```

### Step 2: Write SKILL.md / SKILL.md 작성

**SKILL.md required sections / 필수 섹션**:

| Section | Description |
|---------|-------------|
| `trigger` | Keywords that activate this skill (en/ko/ja) |
| `priority` | Activation priority (1-10, where 10 is highest) |
| `expertise` | Core knowledge areas and domain coverage |
| `references/` | Supporting reference files (optional) |

### Step 3: Skill categories / 스킬 카테고리

| Category | Purpose | Examples |
|----------|---------|----------|
| **Core** | Universal principles | orchestration, coding-standards, principles |
| **Persona** | Domain specialist behaviors | persona-architect, persona-security |
| **Utility** | Workflow helpers | git-workflow, tdd-workflow, mcp-coordination |

### Step 4: Validate

```bash
node scripts/ci/validate-skills.js
```

---

## How to Add a Command / 커맨드 추가 방법

**English**: Commands are the user-facing interface. They delegate work to agents via Sub-Agent or Agent Teams.

**한국어**: 커맨드는 사용자 대면 인터페이스입니다. Sub-Agent 또는 Agent Teams를 통해 작업을 위임합니다.

### Step 1: Create from template

```bash
cp plugins/artibot/templates/command-template.md \
   plugins/artibot/commands/my-command.md
```

### Step 2: Fill in required sections / 필수 섹션 작성

| Section | Description |
|---------|-------------|
| `command` | The slash command name (e.g., `/my-command`) |
| `purpose` | What the command does |
| `arguments` | Accepted arguments and flags |
| `delegation` | How the command delegates (Sub-Agent vs TeamCreate) |
| `output` | Expected output format |

### Step 3: Register the command / 커맨드 등록

Add routing logic to `commands/sc.md` so the `/sc` auto-router can detect intent and route to the new command.

### Step 4: Validate

```bash
node scripts/ci/validate-commands.js
```

---

## How to Write Hooks / 훅 작성 방법

**English**: Hooks are ESM scripts that execute automatically in response to Claude Code lifecycle events. Artibot supports 12 event types and 3 hook types.

**한국어**: 훅은 Claude Code 생명주기 이벤트에 자동으로 실행되는 ESM 스크립트입니다. Artibot은 12개 이벤트 타입과 3개 훅 타입을 지원합니다.

### Hook Types / 훅 타입

| Type | Description | Input | Output Effect |
|------|-------------|-------|---------------|
| `command` | Executes a shell command | `stdin` receives JSON context | `stdout` JSON can block/modify operations |
| `prompt` | Injects text into the conversation | `stdin` receives JSON context | `stdout` text is appended to the user prompt |
| `agent` | Manages agent lifecycle events | `stdin` receives JSON context | `stdout` JSON can modify agent behavior |

### Supported Events / 지원 이벤트

| Event | When it fires | Typical hook type |
|-------|--------------|-------------------|
| `SessionStart` | Claude Code session begins | `command` |
| `PreToolUse` | Before a tool executes (Write, Edit, Bash, etc.) | `command` |
| `PostToolUse` | After a tool executes | `command` |
| `PreCompact` | Before context window compaction | `command` |
| `Stop` | Session is about to end | `command` |
| `UserPromptSubmit` | User submits a prompt | `prompt` |
| `SubagentStart` | A sub-agent or teammate starts | `agent` |
| `SubagentStop` | A sub-agent or teammate stops | `agent` |
| `TeammateIdle` | A teammate has no active tasks | `agent` |
| `TaskCompleted` | A shared task is completed | `agent` |
| `PermissionRequest` | A permission prompt is shown | `command` |
| `SessionEnd` | Claude Code session ends | `command` |

### Creating a Hook Script / 훅 스크립트 생성

All hook scripts must be ESM (`.js` with `import` syntax). They read JSON from `stdin` and write JSON to `stdout`.

**Example: Command hook (blocking a dangerous write)**

```javascript
// scripts/hooks/my-pre-write-hook.js
import { readInput } from '../utils/hook-helpers.js';

const input = await readInput();
const toolInput = input?.tool_input ?? {};

// Block writes to sensitive files
const dangerousPatterns = ['.env', '.pem', '.key'];
const filePath = toolInput.file_path ?? '';

const blocked = dangerousPatterns.some(p => filePath.endsWith(p));

const output = {
  decision: blocked ? 'block' : 'approve',
  reason: blocked ? `Blocked write to sensitive file: ${filePath}` : undefined,
};

process.stdout.write(JSON.stringify(output));
```

**Example: Prompt hook (injecting context)**

```javascript
// scripts/hooks/my-prompt-hook.js
import { readInput } from '../utils/hook-helpers.js';

const input = await readInput();
const userMessage = input?.message ?? '';

// Inject additional context when security keywords are detected
if (/security|vulnerability|audit/i.test(userMessage)) {
  process.stdout.write(
    'IMPORTANT: Apply OWASP Top 10 checklist for all security-related work.'
  );
}
```

**Example: Agent hook (tracking teammate lifecycle)**

```javascript
// scripts/hooks/my-agent-hook.js
import { readInput } from '../utils/hook-helpers.js';

const input = await readInput();
const agentName = input?.agent_name ?? 'unknown';
const teamName = input?.team_name ?? '';

console.error(`[artibot] Agent ${agentName} started in team ${teamName}`);

// Output can influence agent behavior
process.stdout.write(JSON.stringify({
  acknowledged: true,
  timestamp: new Date().toISOString(),
}));
```

### Registering a Hook / 훅 등록

Add your hook to `hooks/hooks.json`:

```json
{
  "PreToolUse": [
    {
      "matcher": "Write|Edit",
      "hooks": [{
        "type": "command",
        "command": "node ${CLAUDE_PLUGIN_ROOT}/scripts/hooks/my-pre-write-hook.js",
        "timeout": 5000
      }]
    }
  ]
}
```

**Configuration fields**:

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"command"` \| `"prompt"` \| `"agent"` | Hook execution type |
| `command` | `string` | Command to run (`${CLAUDE_PLUGIN_ROOT}` is auto-resolved) |
| `timeout` | `number` | Max execution time in milliseconds |
| `matcher` | `string` | Tool name filter for PreToolUse/PostToolUse (regex-like, pipe-separated) |
| `once` | `boolean` | If `true`, the hook runs only once per session (e.g., SessionStart) |

### Hook Development Rules / 훅 개발 규칙

1. **ESM only**: Use `import` syntax, never `require()`
2. **Node.js built-ins only**: No npm packages in hook scripts
3. **Timeout awareness**: Hooks must complete within their timeout or they are killed
4. **Error handling**: Always handle errors gracefully; a crashing hook should not break the session
5. **Logging**: Use `console.error()` for debug logging (stdout is reserved for hook output)
6. **Idempotency**: Hooks may be called multiple times; ensure they are safe to re-run

### Validate hooks / 훅 검증

```bash
node scripts/ci/validate-hooks.js
```

---

## Testing / 테스트

**English**: Artibot requires >= 80% test coverage. Use vitest for all tests.

**한국어**: Artibot은 80% 이상의 테스트 커버리지를 요구합니다. 모든 테스트에 vitest를 사용하세요.

### Running Tests / 테스트 실행

```bash
# Run all tests
npm test

# Run with coverage report
npm run test:coverage

# Watch mode during development
npm run test:watch

# Full CI pipeline (validate + lint + test)
npm run ci
```

### Test Structure / 테스트 구조

Place tests in `tests/` mirroring the `lib/` structure:

```
tests/
├── core/
│   ├── platform.test.js
│   ├── config.test.js
│   ├── cache.test.js
│   └── file.test.js
├── cognitive/
│   ├── router.test.js
│   ├── system1.test.js
│   └── system2.test.js
├── intent/
│   ├── language.test.js
│   └── trigger.test.js
├── learning/
│   ├── grpo-optimizer.test.js
│   ├── knowledge-transfer.test.js
│   ├── lifelong-learner.test.js
│   └── tool-learner.test.js
├── privacy/
│   └── pii-scrubber.test.js
└── swarm/
    ├── swarm-client.test.js
    └── pattern-packager.test.js
```

### Writing a Test / 테스트 작성

```javascript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { classifyComplexity, resetRouter } from '../../lib/cognitive/router.js';

describe('Cognitive Router', () => {
  beforeEach(() => {
    resetRouter();
  });

  it('should route simple inputs to System 1', () => {
    const result = classifyComplexity('fix typo in readme');
    expect(result.system).toBe(1);
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it('should route complex inputs to System 2', () => {
    const result = classifyComplexity(
      'refactor the authentication system, migrate database, and deploy to production'
    );
    expect(result.system).toBe(2);
  });
});
```

### Coverage Thresholds / 커버리지 기준

Defined in `vitest.config.js`:

| Metric | Minimum |
|--------|---------|
| Statements | 80% |
| Branches | 70% |
| Functions | 80% |
| Lines | 80% |

### Testing Requirements / 테스트 요구사항

- Unit tests for all `lib/` modules
- Edge case coverage for PII scrubber patterns (different OS paths, various key formats)
- Integration tests for command routing logic and cognitive router
- Coverage threshold: 80% minimum (statements, branches, functions, lines)
- Tests must use only vitest APIs (`describe`, `it`, `expect`, `vi`, `beforeEach`, `afterEach`)
- Mock external dependencies (file system, network) using `vi.mock()`

### CI Validation Scripts / CI 검증 스크립트

```bash
node scripts/ci/validate-agents.js    # Validate agent MD structure
node scripts/ci/validate-skills.js    # Validate skill SKILL.md format
node scripts/ci/validate-commands.js  # Validate command MD structure
node scripts/ci/validate-hooks.js     # Validate hooks.json mappings
```

These scripts verify that all Markdown files have the required frontmatter fields and sections. They run as part of `npm run ci`.

---

## Code Style / 코드 스타일

**English**: All JavaScript must be ESM (`.js` with `"type": "module"` in package.json). No CommonJS.

**한국어**: 모든 JavaScript는 ESM이어야 합니다. CommonJS 불가.

### Zero Dependencies Rule / 무의존성 원칙

```javascript
// CORRECT / 올바름
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

// WRONG - No npm packages in lib/ or scripts/
// import axios from 'axios';        // FORBIDDEN
// import lodash from 'lodash';      // FORBIDDEN
// import dayjs from 'dayjs';        // FORBIDDEN
```

### Immutability / 불변성

```javascript
// CORRECT - Create new objects
function updateConfig(config, key, value) {
  return { ...config, [key]: value };
}

// WRONG - Mutation
function updateConfig(config, key, value) {
  config[key] = value;  // MUTATION - FORBIDDEN
  return config;
}
```

### Error Handling / 에러 처리

```javascript
// CORRECT
try {
  const result = await readJsonFile(path);
  return result;
} catch (error) {
  console.error(`[artibot] Failed to read config: ${error.message}`);
  return defaultValue;
}
```

### File Organization / 파일 구조

- Maximum 800 lines per file
- Target 200-400 lines per file
- One responsibility per module
- Export named functions, not default classes

### Naming Conventions / 네이밍 규칙

| Element | Convention | Example |
|---------|-----------|---------|
| Files | kebab-case | `grpo-optimizer.js` |
| Functions | camelCase | `classifyComplexity()` |
| Constants | UPPER_SNAKE | `MAX_RETRIES` |
| Classes | PascalCase | (rarely used; prefer functions) |
| Agent files | kebab-case `.md` | `security-reviewer.md` |
| Skill dirs | kebab-case | `persona-architect/` |

---

## ESLint Configuration / ESLint 설정

**English**: Artibot uses ESLint v9 with flat config. The configuration is minimal by design.

**한국어**: Artibot은 ESLint v9의 flat config를 사용합니다. 설정은 의도적으로 최소화되어 있습니다.

### Configuration file: `eslint.config.js`

```javascript
import js from '@eslint/js';

export default [
  js.configs.recommended,
  {
    files: ['lib/**/*.js', 'scripts/**/*.js', 'tests/**/*.js'],
    rules: {
      'no-console': 'warn',
      'no-unused-vars': 'error',
      'consistent-return': 'error',
      'eqeqeq': 'error',
    },
  },
];
```

### Active Rules / 활성 규칙

| Rule | Level | Rationale |
|------|-------|-----------|
| `no-console` | warn | Use `console.error()` for debug logging; avoid `console.log()` in production |
| `no-unused-vars` | error | Dead code must be removed to maintain clarity |
| `consistent-return` | error | Functions must consistently return or not return values |
| `eqeqeq` | error | Always use `===` and `!==` to avoid type coercion bugs |

### Running the Linter / 린터 실행

```bash
# Check style
npm run lint

# Auto-fix fixable issues
npm run lint:fix
```

---

## Commit Messages / 커밋 메시지

**English**: Follow the Conventional Commits specification.

**한국어**: Conventional Commits 사양을 따르세요.

**Format**:
```
<type>: <description>

[optional body]
[optional footer]
```

**Types**:
| Type | Use case |
|------|----------|
| `feat` | New agent, skill, command, or feature |
| `fix` | Bug fix |
| `refactor` | Code restructuring without behavior change |
| `docs` | Documentation updates |
| `test` | Test additions or fixes |
| `chore` | Build scripts, config, dependencies |
| `perf` | Performance improvements |
| `ci` | CI/CD pipeline changes |

**Examples / 예시**:
```
feat: add performance-engineer agent with Kahneman System 2 support
fix: resolve PII scrubber false positive on Windows paths
docs: update CONTRIBUTING.md with hook authoring guide
test: add coverage for pii-scrubber regex patterns
refactor: extract common JSON helpers into core/file.js
```

**Rules / 규칙**:

1. Use lowercase for the type prefix
2. Do not end the subject line with a period
3. Keep the subject line under 72 characters
4. Use imperative mood ("add" not "added", "fix" not "fixed")
5. Separate subject from body with a blank line
6. Body should explain *what* and *why*, not *how*

---

## Pull Requests / 풀 리퀘스트

### Workflow / 워크플로우

**English**:

1. Fork the repository and create a feature branch from `master`
   ```bash
   git checkout -b feat/my-new-agent
   ```
2. Make your changes following the code style guidelines
3. Write tests for new functionality
4. Ensure all tests pass: `npm run ci`
5. Update relevant documentation (README.md, CHANGELOG.md)
6. Open a PR with a clear title and description

**한국어**:

1. 저장소를 포크하고 `master`에서 기능 브랜치를 생성하세요
2. 코드 스타일 가이드라인을 따라 변경사항을 작성하세요
3. 새 기능에 대한 테스트를 작성하세요
4. 모든 테스트가 통과하는지 확인하세요: `npm run ci`
5. 관련 문서를 업데이트하세요 (README.md, CHANGELOG.md)
6. 명확한 제목과 설명으로 PR을 열어주세요

### Branch Naming / 브랜치 네이밍

| Prefix | Use case | Example |
|--------|----------|---------|
| `feat/` | New features | `feat/cognitive-router-v2` |
| `fix/` | Bug fixes | `fix/pii-scrubber-windows` |
| `docs/` | Documentation | `docs/architecture-guide` |
| `refactor/` | Code restructuring | `refactor/learning-pipeline` |
| `test/` | Test improvements | `test/swarm-client-coverage` |

### PR Checklist / PR 체크리스트

- [ ] Tests pass (`npm run ci`)
- [ ] Test coverage >= 80%
- [ ] No new external dependencies added
- [ ] ESLint passes (`npm run lint`)
- [ ] Documentation updated if behavior changed
- [ ] Commit messages follow Conventional Commits
- [ ] Agent/Skill/Command validation passes (CI scripts)
- [ ] CHANGELOG.md updated under `[Unreleased]`
- [ ] Hook scripts use ESM syntax and Node.js built-ins only

### Review Process / 리뷰 프로세스

PRs are reviewed for:

- **Architecture alignment**: Consistent with Agent Teams API patterns
- **Zero-dependency constraint**: No npm runtime packages in `lib/` or `scripts/`
- **Test coverage**: Meets 80% minimum threshold
- **Code quality**: Immutability, proper error handling, file size limits (800 lines max)
- **Security**: No hardcoded secrets, PII scrubber patterns updated if needed
- **Documentation**: Updated README, CHANGELOG, and inline JSDoc comments

### Review Turnaround / 리뷰 소요 시간

- **Small PRs** (< 100 lines): 1-2 business days
- **Medium PRs** (100-500 lines): 2-5 business days
- **Large PRs** (> 500 lines): Consider splitting into smaller PRs

---

*Questions? / 질문이 있으시면?* Open an issue at https://github.com/Yoodaddy0311/artibot/issues
