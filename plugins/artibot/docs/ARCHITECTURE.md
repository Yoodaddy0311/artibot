# Artibot System Architecture / 시스템 아키텍처

This document describes the internal architecture of the Artibot plugin for Claude Code. It covers the plugin structure, Agent Teams integration, cognitive engine, learning pipeline, federated intelligence, hook system, intent detection, and delegation modes.

---

## Table of Contents

1. [Plugin Structure Overview](#plugin-structure-overview)
2. [Agent Teams API Integration](#agent-teams-api-integration)
3. [Cognitive Engine (System 1/2 Dual-Process)](#cognitive-engine)
4. [Learning Pipeline](#learning-pipeline)
5. [Federated Swarm Intelligence](#federated-swarm-intelligence)
6. [Hook System](#hook-system)
7. [Intent Detection](#intent-detection)
8. [Delegation Modes](#delegation-modes)
9. [Data Flow Summary](#data-flow-summary)

---

## Plugin Structure Overview / 플러그인 구조 개요

```
plugins/artibot/
│
├── .claude-plugin/
│   └── plugin.json ─────────── Manifest: version, agents[], commands, skills
│
├── artibot.config.json ─────── Runtime configuration
│   ├── agents ──────────────── Model policy, categories, task routing
│   ├── team ────────────────── Agent Teams engine, API tools, delegation modes
│   ├── automation ──────────── Intent detection, language support
│   ├── cognitive ───────────── Router threshold, System 1/2 params
│   ├── learning ────────────── Memory scopes, GRPO, knowledge transfer
│   └── output ──────────────── Style and context length
│
├── package.json ────────────── ESM module, zero prod deps, vitest + eslint dev
│
├── agents/ ─────────────────── Agent definitions (Markdown with YAML frontmatter)
│   ├── orchestrator.md ─────── CTO: TeamCreate, SendMessage, TaskCreate
│   ├── architect.md ────────── System design, ADR, scalability
│   ├── planner.md ──────────── Implementation planning, risk assessment
│   ├── security-reviewer.md ── OWASP, threat modeling
│   ├── code-reviewer.md ────── 4-severity code review
│   ├── frontend-developer.md ─ UI/UX, WCAG, Core Web Vitals
│   ├── backend-developer.md ── API, database, services
│   └── ... (26 total)
│
├── commands/ ───────────────── Slash command definitions (Markdown)
│   ├── sc.md ───────────────── Main router: intent -> command mapping
│   ├── orchestrate.md ──────── Team orchestration (TeamCreate workflows)
│   ├── spawn.md ────────────── Parallel team spawning
│   ├── implement.md ────────── Feature implementation pipeline
│   └── ... (27 total)
│
├── skills/ ─────────────────── Skill directories (SKILL.md + references/)
│   ├── orchestration/ ──────── Routing intelligence, delegation selection
│   ├── persona-architect/ ──── Architect personality and priorities
│   ├── cognitive-routing/ ──── System 1/2 routing guidelines
│   └── ... (48 total)
│
├── hooks/
│   └── hooks.json ──────────── Event -> script mappings (12 events)
│
├── scripts/
│   ├── hooks/ ──────────────── ESM hook scripts (18 files)
│   │   ├── session-start.js ── Environment detection, config load
│   │   ├── pre-write.js ────── Sensitive file write blocking
│   │   ├── pre-bash.js ─────── Destructive command blocking
│   │   ├── post-edit-format.js  Prettier formatting suggestion
│   │   ├── post-bash.js ────── PR URL detection after git push
│   │   ├── quality-gate.js ─── Code quality validation
│   │   ├── tool-tracker.js ─── Tool usage tracking for learning
│   │   ├── cognitive-router.js  Complexity routing on prompt submit
│   │   ├── user-prompt-handler.js  Intent detection, agent suggestion
│   │   ├── subagent-handler.js  Agent lifecycle tracking
│   │   ├── team-idle-handler.js  Idle teammate task notification
│   │   ├── agent-evaluator.js ─ Post-agent performance evaluation
│   │   ├── workflow-status.js ─ Team workflow status updates
│   │   ├── memory-tracker.js ── Memory usage monitoring
│   │   ├── nightly-learner.js ─ Session-end learning pipeline
│   │   ├── pre-compact.js ──── Context snapshot before compaction
│   │   ├── check-console-log.js  Console.log audit on stop
│   │   └── session-end.js ──── Session state persistence
│   └── ci/ ─────────────────── Validation scripts
│       ├── validate-agents.js
│       ├── validate-skills.js
│       ├── validate-commands.js
│       └── validate-hooks.js
│
├── lib/
│   ├── core/ ───────────────── Core utilities (7 modules)
│   │   ├── platform.js ─────── OS detection, path normalization
│   │   ├── config.js ───────── Config loading and merging
│   │   ├── cache.js ────────── In-memory LRU cache
│   │   ├── io.js ───────────── Stdin/stdout JSON helpers
│   │   ├── debug.js ────────── Debug logging with [artibot] prefix
│   │   ├── file.js ─────────── JSON file read/write, ensureDir
│   │   └── tui.js ──────────── Terminal UI progress display
│   │
│   ├── intent/ ─────────────── Intent detection (4 modules)
│   │   ├── language.js ─────── Language detection (en/ko/ja)
│   │   ├── trigger.js ──────── Keyword trigger matching
│   │   ├── ambiguity.js ────── Ambiguity resolution
│   │   └── index.js ────────── Public API
│   │
│   ├── context/ ────────────── Context management (2 modules)
│   │   ├── hierarchy.js ────── Context hierarchy resolution
│   │   └── session.js ──────── Session state management
│   │
│   ├── cognitive/ ──────────── Cognitive engine (4 modules)
│   │   ├── router.js ───────── Dual-process classifier and router
│   │   ├── system1.js ──────── Fast intuitive processing
│   │   ├── system2.js ──────── Deliberate analytical processing
│   │   └── sandbox.js ──────── Sandboxed evaluation for System 2
│   │
│   ├── learning/ ───────────── Learning pipeline (7 modules)
│   │   ├── memory-manager.js ─ Three-scope memory (user/project/session)
│   │   ├── grpo-optimizer.js ─ Group Relative Policy Optimization
│   │   ├── knowledge-transfer.js  System 2 -> System 1 promotion
│   │   ├── lifelong-learner.js  Experience collection + batch learning
│   │   ├── tool-learner.js ─── Toolformer-inspired tool selection
│   │   ├── self-evaluator.js ── Self-rewarding quality assessment
│   │   └── context-injector.js  (in lib/system/) Learning context injection
│   │
│   ├── privacy/ ────────────── Privacy protection (1 module)
│   │   └── pii-scrubber.js ─── 50+ regex PII detection patterns
│   │
│   ├── swarm/ ──────────────── Federated intelligence (4 modules)
│   │   ├── swarm-client.js ─── HTTP client with retry, offline queue
│   │   ├── pattern-packager.js  Pattern serialization for aggregation
│   │   ├── sync-scheduler.js ── Swarm sync interval management
│   │   └── index.js
│   │
│   ├── system/ ─────────────── System utilities (2 modules)
│   │   ├── telemetry-collector.js  Opt-in anonymous metrics
│   │   └── context-injector.js  Injects learning context into prompts
│   │
│   └── adapters/ ───────────── Cross-model adapters (5 modules)
│       ├── base.js ─────────── Abstract adapter interface
│       ├── gemini.js ───────── Google Gemini adapter
│       ├── codex.js ────────── OpenAI Codex adapter
│       ├── cursor.js ───────── Cursor AI adapter
│       └── index.js
│
├── output-styles/ ──────────── Output formatting templates
│   ├── artibot-default.md
│   ├── artibot-compressed.md
│   └── artibot-mentor.md
│
└── templates/ ──────────────── Contribution templates
    ├── agent-template.md
    ├── skill-template.md
    └── command-template.md
```

---

## Agent Teams API Integration / Agent Teams API 통합

Artibot uses Claude Code's native Agent Teams API as its core orchestration engine. This is the foundational architectural decision that distinguishes Artibot from plugins that use simple `Task()` sub-agent delegation.

### API Tool Inventory

```
Lifecycle:     TeamCreate(team_name, description)
               TeamDelete(team_name)

Communication: SendMessage(team_name, recipient, type, content)
               type: message | broadcast | shutdown_request
                     | shutdown_response | plan_approval_response

Task Mgmt:     TaskCreate(team_name, subject, description, activeForm)
               TaskUpdate(team_name, taskId, status|owner|addBlockedBy)
               TaskList(team_name)
               TaskGet(team_name, taskId)

Spawning:      Task(subagent_type, team_name, name)
```

### Team Lifecycle

```
1. TeamCreate(team_name, description)
2. Task(subagent_type, team_name, name) x N     -- spawn teammates
3. TaskCreate(subject, description) x M           -- create shared tasks
4. TaskUpdate(taskId, addBlockedBy) x K           -- set dependencies
5. TaskUpdate(taskId, owner)                      -- assign or self-claim
6. [Teammates execute work]
   a. TaskGet(taskId)                              -- read task details
   b. TaskUpdate(taskId, status: "in_progress")    -- signal start
   c. [perform work using specialist tools]
   d. SendMessage(type: "message", to: leader)     -- report progress
   e. TaskUpdate(taskId, status: "completed")       -- signal done
7. SendMessage(type: "shutdown_request") x N       -- request shutdown
8. TeamDelete(team_name)                           -- cleanup resources
```

### Orchestration Patterns

| Pattern | Description | Task Dependency | Communication |
|---------|-------------|-----------------|---------------|
| **Leader** | CTO assigns, collects | Sequential | Top-down |
| **Council** | Group discussion, leader decides | No deps | Peer-to-peer |
| **Swarm** | Independent parallel work | No deps (self-claim) | Minimal |
| **Pipeline** | Sequential with blockedBy | Chain dependencies | Forward pass |
| **Watchdog** | Monitor + alert | Periodic polling | Alert-based |

### Team Levels

| Level | Mode | Teammates | Trigger |
|-------|------|-----------|---------|
| **Solo** | Sub-Agent | 0 | Single file edit, simple question |
| **Squad** | Agent Team | 2-4 | Feature implementation, bugfix |
| **Platoon** | Agent Team | 5+ | Architecture change, security audit |

### Playbooks

```
feature:   [leader] plan -> [council] design -> [swarm] implement
           -> [council] review -> [leader] merge

bugfix:    [leader] analyze -> [pipeline] fix -> [council] verify

refactor:  [council] assess -> [pipeline] refactor
           -> [swarm] test -> [council] review

security:  [leader] scan -> [council] assess
           -> [pipeline] fix -> [council] verify
```

---

## Cognitive Engine / 인지 엔진

### Kahneman System 1/2 Dual-Process Architecture

Inspired by Daniel Kahneman's *Thinking, Fast and Slow*, Artibot classifies every user request into one of two cognitive processing modes:

```
User Request
     |
     v
┌────────────────────────────────────────────┐
│         Cognitive Router (router.js)        │
│                                            │
│  Complexity = weighted_sum(                │
│    steps       * 0.25,                     │
│    domains     * 0.20,                     │
│    uncertainty * 0.20,                     │
│    risk        * 0.20,                     │
│    novelty     * 0.15                      │
│  )                                         │
│                                            │
│  if complexity < threshold (default 0.4):  │
│    -> System 1 (fast, intuitive)           │
│  else:                                     │
│    -> System 2 (slow, deliberate)          │
└──────┬─────────────────────┬───────────────┘
       v                     v
┌──────────────┐   ┌──────────────────┐
│  System 1    │   │   System 2       │
│              │   │                  │
│  Pattern     │   │  Sandbox eval    │
│  matching    │   │  Max 3 retries   │
│  <100ms      │   │  Quality-first   │
│  conf >= 0.6 │   │  No time limit   │
└──────────────┘   └──────────────────┘
```

### Complexity Signal Weights

| Factor | Weight | What it measures |
|--------|--------|-----------------|
| `steps` | 0.25 | Number of distinct operations in the request |
| `domains` | 0.20 | Count of distinct technical domains mentioned |
| `uncertainty` | 0.20 | Ambiguity signals (questions, uncertain language) |
| `risk` | 0.20 | Critical/production/destructive operation keywords |
| `novelty` | 0.15 | How different this request is from recent history |

### Adaptive Threshold

The routing threshold adjusts dynamically based on outcome feedback:

- **System 1 failure**: Threshold lowers by `adaptStep` (default 0.05), routing more requests to System 2
- **5 consecutive System 1 successes**: Threshold raises by `adaptStep`, trusting System 1 more
- **Bounds**: Threshold is clamped between 0.2 and 0.7
- **Persistence**: Threshold resets per session (no cross-session persistence)

### Multi-Language Support

The cognitive router detects complexity signals in three languages:

| Signal Type | English | Korean | Japanese |
|-------------|---------|--------|----------|
| Domains | "component", "api", "security" | "컴포넌트", "서버", "보안" | "コンポーネント", "セキュリティ" |
| Uncertainty | "maybe", "not sure" | "아마", "불확실" | "もしかして", "不明" |
| Risk | "production", "delete" | "운영", "삭제" | "本番", "削除" |
| Steps | "then", "next" | "그리고", "다음에" | "それから", "次に" |

---

## Learning Pipeline / 학습 파이프라인

Artibot implements a multi-stage learning pipeline that operates entirely locally without requiring external AI judges or cloud services.

```
Session Activity (tool usage, errors, successes, team results)
         |
         v
┌────────────────────────────┐
│  Experience Collection     │  lifelong-learner.js
│  (collect during session)  │  collectExperience()
└────────────┬───────────────┘
             v
┌────────────────────────────┐
│  Self Evaluation           │  self-evaluator.js
│  4 dimensions:             │  evaluate()
│  - accuracy    (0.35)      │
│  - completeness(0.25)      │
│  - efficiency  (0.20)      │
│  - satisfaction(0.20)      │
└────────────┬───────────────┘
             v
┌────────────────────────────┐
│  GRPO Batch Learning       │  grpo-optimizer.js
│  1. Generate candidates    │  generateCandidates()
│  2. Evaluate group         │  evaluateGroup()
│  3. Rank by composite      │  (exit code, speed, errors, brevity)
│  4. Update weights         │  updateWeights()
│     (relative advantage)   │
└────────────┬───────────────┘
             v
┌────────────────────────────┐
│  Knowledge Transfer        │  knowledge-transfer.js
│                            │
│  PROMOTE: System 2 -> 1    │  promoteToSystem1()
│  if consecutiveSuccesses   │  (>= 3 successes, conf > 0.8)
│    >= 3 AND conf > 0.8     │
│                            │
│  DEMOTE: System 1 -> 2     │  demoteFromSystem1()
│  if consecutiveFailures    │  (>= 2 failures OR error > 20%)
│    >= 2 OR errorRate > 20% │
│                            │
│  HOT-SWAP: atomic batch    │  hotSwap()
│  promote + demote with     │  (file-level lock, no restart)
│  file-level locking        │
└────────────┬───────────────┘
             v
┌────────────────────────────┐
│  Memory Persistence        │  memory-manager.js
│                            │
│  user:    ~/.claude/artibot/  (permanent, all projects)
│  project: .artibot/           (per-project)
│  session: in-memory           (cleared on exit)
└────────────────────────────┘
```

### GRPO (Group Relative Policy Optimization)

GRPO is a lightweight reinforcement learning mechanism that operates without an external judge AI:

1. **Candidate generation**: For a given task, generate N strategy candidates (default 5)
2. **Rule-based evaluation**: Score each candidate against deterministic rules:
   - `exitCode`: Did the operation succeed? (binary)
   - `errorFree`: Were there zero errors? (binary)
   - `speed`: How fast was execution? (inverse duration)
   - `brevity`: How concise was the approach? (inverse command length)
   - `sideEffects`: Were there unintended side effects? (binary)
3. **Group ranking**: Sort candidates by composite score within the group
4. **Weight update**: Apply relative advantage (best = +1, worst = -1) scaled by learning rate (0.1)
5. **Persistence**: Strategy weights are stored in `~/.claude/artibot/grpo-history.json`

GRPO also applies to **team composition**: different team patterns (Solo, Leader, Council, Swarm, Pipeline) are compared for each domain, and optimal configurations are learned over time.

### Tool Learner (Toolformer-inspired)

The tool learner tracks which tools perform best in which contexts:

- **Context keys**: e.g., "search:file", "edit:typescript", "analyze:security"
- **Decay**: Older observations decay exponentially (half-life: 7 days)
- **GRPO integration**: Tool candidates are compared within groups using multi-criteria scoring (success 0.35, speed 0.25, accuracy 0.25, brevity 0.15)
- **Minimum samples**: Recommendations require at least 3 observations
- **Storage**: `~/.claude/artibot/tool-history.json`

### Self Evaluator (Self-Rewarding)

Based on Meta's Self-Rewarding LLM patterns:

- Evaluates task results across 4 dimensions: accuracy, completeness, efficiency, satisfaction
- Generates weighted composite scores for feedback into the GRPO pipeline
- Stores evaluation history in `~/.claude/artibot/evaluations.json` (max 500 entries)

---

## Federated Swarm Intelligence / 연합 집단 지능

The Federated Swarm Intelligence system enables Artibot instances to share learned patterns while preserving privacy.

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Artibot A      │     │  Artibot B      │     │  Artibot C      │
│  (local)        │     │  (local)        │     │  (local)        │
│                 │     │                 │     │                 │
│  Patterns  ─────┼─────┼────> Swarm  <───┼─────┼──── Patterns   │
│  + PII scrub    │     │     Server      │     │  + PII scrub    │
│  + DP noise     │     │  (aggregator)   │     │  + DP noise     │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

### Privacy Pipeline

Before any data leaves the local machine:

1. **PII Scrubbing** (`lib/privacy/pii-scrubber.js`): 50+ regex patterns remove personal data
2. **Differential Privacy** noise injection: Gradient noise added before aggregation
3. **Checksum verification**: SHA-256 on upload/download to ensure integrity
4. **Payload limits**: Maximum 5MB per upload

### Components

| Module | Purpose |
|--------|---------|
| `swarm-client.js` | HTTP client with retry (exponential backoff), offline queue, delta downloads |
| `pattern-packager.js` | Serializes learned patterns for transmission |
| `sync-scheduler.js` | Manages periodic sync intervals |

### Offline Resilience

When the swarm server is unreachable, uploads are queued to `~/.claude/artibot/swarm-offline-queue.json` (max 100 entries). The queue is flushed on the next successful connection.

### Opt-In Only

Federated Swarm is completely opt-in. No data is transmitted unless the user explicitly configures a swarm server URL. By default, all learning is strictly local.

---

## Hook System / 훅 시스템

Artibot uses a declarative hook system defined in `hooks/hooks.json`. Hooks are ESM scripts that respond to Claude Code lifecycle events.

### Event Map

```
Session Lifecycle:
  SessionStart ──> session-start.js (once)
  SessionEnd   ──> session-end.js, nightly-learner.js

Tool Lifecycle:
  PreToolUse (Write|Edit)  ──> pre-write.js
  PreToolUse (Bash)        ──> pre-bash.js
  PostToolUse (Edit|Write) ──> quality-gate.js
  PostToolUse (Edit)       ──> post-edit-format.js
  PostToolUse (Bash)       ──> post-bash.js
  PostToolUse (*)          ──> tool-tracker.js

User Interaction:
  UserPromptSubmit ──> user-prompt-handler.js, cognitive-router.js
  PermissionRequest ──> pre-bash.js

Agent Lifecycle:
  SubagentStart  ──> subagent-handler.js start, workflow-status.js
  SubagentStop   ──> subagent-handler.js stop, agent-evaluator.js,
                     workflow-status.js
  TeammateIdle   ──> team-idle-handler.js, workflow-status.js
  TaskCompleted  ──> tool-tracker.js

Context:
  PreCompact  ──> pre-compact.js
  Stop        ──> check-console-log.js
```

### Three Hook Types

| Type | Execution Model | Input | Output |
|------|----------------|-------|--------|
| `command` | Runs shell command | JSON via stdin | JSON via stdout (can block/modify) |
| `prompt` | Injects into conversation | JSON via stdin | Text appended to user prompt |
| `agent` | Manages agent lifecycle | JSON via stdin | JSON modifying agent behavior |

### Hook Configuration Schema

```json
{
  "EventName": [
    {
      "matcher": "ToolName|OtherTool",
      "once": false,
      "hooks": [
        {
          "type": "command|prompt|agent",
          "command": "node ${CLAUDE_PLUGIN_ROOT}/scripts/hooks/script.js",
          "timeout": 5000
        }
      ]
    }
  ]
}
```

### Security Hooks

| Hook | Protection |
|------|------------|
| `pre-write.js` | Blocks writes to `.env`, `.pem`, `.key` |
| `pre-bash.js` | Blocks `rm -rf`, `git push --force`, destructive commands |
| `quality-gate.js` | Validates code quality after edits |
| `check-console-log.js` | Audits for `console.log` before session end |

---

## Intent Detection / 의도 감지

The intent detection system (`lib/intent/`) analyzes user input to determine the most appropriate command and agent combination.

### Detection Pipeline

```
User Input (natural language, en/ko/ja)
     |
     v
┌───────────────────────────┐
│  Language Detection        │  language.js
│  (en/ko/ja auto-detect)   │
└────────────┬──────────────┘
             v
┌───────────────────────────┐
│  Trigger Matching          │  trigger.js
│  (keyword -> command map)  │
│  Weighted scoring:         │
│    keyword  40%            │
│    context  40%            │
│    flags    20%            │
└────────────┬──────────────┘
             v
┌───────────────────────────┐
│  Ambiguity Resolution      │  ambiguity.js
│  (threshold: 50)           │
│  If score < threshold:     │
│    ask for clarification   │
└────────────┬──────────────┘
             v
         Command + Agent
         recommendation
```

### Multi-Language Support

| Language | Detection Method | Examples |
|----------|-----------------|----------|
| English | Default | "implement login feature", "review security" |
| Korean (ko) | Hangul character detection | "로그인 기능 구현해줘", "보안 리뷰해줘" |
| Japanese (ja) | CJK + Katakana detection | "セキュリティ監査", "コンポーネント作成" |

### Configuration

```json
// artibot.config.json
{
  "automation": {
    "intentDetection": true,
    "ambiguityThreshold": 50,
    "supportedLanguages": ["en", "ko", "ja"]
  }
}
```

---

## Delegation Modes / 위임 모드

Artibot automatically selects between Sub-Agent delegation and Agent Teams based on task complexity.

### Decision Logic

```
Complexity Score Calculation:
  complexity < 0.4 AND single domain AND steps < 3
    -> Sub-Agent Mode (Task() one-way delegation)

  complexity >= 0.4 OR multi-domain OR steps >= 3
    -> Agent Team Mode (TeamCreate, P2P collaboration)
```

### Mode Comparison

| Aspect | Sub-Agent | Agent Team |
|--------|-----------|------------|
| **API** | `Task()` | `TeamCreate` + `SendMessage` + `TaskCreate` |
| **Communication** | One-way (result return) | P2P bidirectional |
| **Task management** | Parent manages | Shared task list |
| **Self-assignment** | No | Yes (TaskUpdate owner) |
| **Team discussion** | No | Yes (SendMessage broadcast) |
| **Plan approval** | No | Yes (plan_approval_response) |
| **Lifecycle** | Fire-and-forget | Create -> Work -> Shutdown -> Delete |
| **Overhead** | Low | Higher (worth it for complex tasks) |

### Configuration

```json
// artibot.config.json -> team.delegationModeSelection
{
  "subAgent": {
    "condition": "complexity < 0.4 AND single domain AND steps < 3",
    "tools": ["Task"],
    "communication": "one-way (result return only)"
  },
  "agentTeam": {
    "condition": "complexity >= 0.4 OR multi-domain OR steps >= 3",
    "tools": ["TeamCreate", "SendMessage", "TaskCreate", "TaskUpdate",
              "TaskList", "TeamDelete"],
    "communication": "P2P bidirectional + shared task list"
  }
}
```

---

## Data Flow Summary / 데이터 흐름 요약

```
User Request
     |
     +-- Language Detection (en/ko/ja)
     |
     +-- Intent Detection (keyword + context + flags)
     |
     +-- Cognitive Router (System 1/2 classification)
     |
     +-- Delegation Mode Selection (Sub-Agent vs Team)
     |
     +-- [Sub-Agent] Task() -> result return
     |   OR
     +-- [Agent Team] TeamCreate -> spawn -> TaskCreate ->
     |   SendMessage -> TaskUpdate -> shutdown -> TeamDelete
     |
     +-- Hook System (pre/post tool, lifecycle events)
     |
     +-- Self Evaluation (accuracy, completeness, efficiency)
     |
     +-- GRPO Optimization (group ranking, weight update)
     |
     +-- Knowledge Transfer (promote/demote, hot-swap)
     |
     +-- Memory Persistence (user/project/session scopes)
     |
     +-- [Optional] Federated Swarm (PII scrub -> DP noise -> upload)
```

### Storage Locations

| Data | Path | Scope |
|------|------|-------|
| Config | `plugins/artibot/artibot.config.json` | Plugin-wide |
| User memory | `~/.claude/artibot/` | All projects |
| Project memory | `.artibot/` | Per-project |
| GRPO history | `~/.claude/artibot/grpo-history.json` | Permanent |
| System 1 patterns | `~/.claude/artibot/system1-patterns.json` | Permanent |
| Transfer log | `~/.claude/artibot/transfer-log.json` | Permanent |
| Tool history | `~/.claude/artibot/tool-history.json` | Permanent |
| Evaluations | `~/.claude/artibot/evaluations.json` | Permanent |
| Experiences | `~/.claude/artibot/daily-experiences.json` | Rolling (max 1000) |
| Learned patterns | `~/.claude/artibot/patterns/` | Permanent |
| Offline queue | `~/.claude/artibot/swarm-offline-queue.json` | Until flushed |
| Team configs | `~/.claude/teams/{team-name}/config.json` | Per-team |
| Shared tasks | `~/.claude/tasks/{team-name}/` | Per-team |
