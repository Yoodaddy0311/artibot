# LAM OS Awareness Architecture

## Overview

The LAM (Large Action Model) OS Awareness system provides Artibot with real-time system telemetry collection and intelligent context injection. It bridges the gap between the AI orchestrator and the host operating system, enabling context-aware responses and safe system interactions.

## Architecture Diagram

```
User Prompt
     │
     ▼
┌─────────────────────────┐
│   Context Injector      │
│   (context-injector.js) │
│                         │
│  ┌───────────────────┐  │
│  │ shouldInject()    │──── keyword matching (EN + KO)
│  └────────┬──────────┘  │
│           │ yes         │
│  ┌────────▼──────────┐  │
│  │ scoreRelevance()  │──── priority-weighted scoring
│  └────────┬──────────┘  │
│           │              │
│  ┌────────▼──────────┐  │
│  │ formatContext()   │──── token-budgeted output (<=500 tokens)
│  └────────┬──────────┘  │
│           │              │
│  ┌────────▼──────────┐  │
│  │ injectContext()   │──── append [System Context: ...] to prompt
│  └───────────────────┘  │
└────────────┬────────────┘
             │
     ┌───────▼───────┐
     │  Telemetry    │
     │  Collector    │
     │  (telemetry-  │
     │  collector.js)│
     └───────┬───────┘
             │
    ┌────────┼────────────────────────┐
    │        │        │        │      │
    ▼        ▼        ▼        ▼      ▼
  CPU    Memory    Disk    Network  Docker
  Usage  Usage     Usage   Ports    Status
    │        │        │        │      │
    └────────┼────────────────────────┘
             │
    Platform Detection (platform.js)
    ┌────────┼────────┐
    │        │        │
   Win32   Darwin   Linux
```

## Modules

### 1. Telemetry Collector (`lib/system/telemetry-collector.js`)

Cross-platform system information collector using only Node.js built-in modules (`node:os`, `node:child_process`).

#### Exported Functions

| Function | Returns | Description |
|----------|---------|-------------|
| `getCpuUsage()` | `{ usage, topProcesses[] }` | CPU usage percentage and top 5 processes |
| `getMemoryUsage()` | `{ total, used, free, usage }` | Memory utilization with formatted sizes |
| `getDiskUsage()` | `[{ mount, total, used, free, usage }]` | Disk usage for primary partitions |
| `getNetworkPorts()` | `[{ port, pid, state }]` | Listening TCP ports |
| `getSystemErrors()` | `[{ timestamp, level, message }]` | Last 10 system error log entries |
| `getDockerStatus()` | `[{ name, status, ports }]` | Running Docker containers (if available) |
| `getGitContext(cwd?)` | `{ branch, status, recentCommits[] }` | Current Git repository context |
| `getFullSnapshot(opts?)` | Combined telemetry object | All of the above in a single call |

#### Platform-Specific Implementation

| Metric | Windows | macOS | Linux |
|--------|---------|-------|-------|
| CPU usage | `wmic cpu get loadpercentage` | `top -l 1` | `/proc/stat` |
| Top processes | `Get-Process` (PowerShell) | `top -l 1 -n 5` | `ps aux --sort=-%cpu` |
| Disk usage | `wmic logicaldisk` | `df -h` | `df -h` |
| Network ports | `netstat -ano` | `lsof -iTCP` | `ss -tlnp` |
| System errors | `Get-EventLog` (PowerShell) | `log show` | `journalctl --priority=err` |
| Docker | `docker ps` (same) | `docker ps` (same) | `docker ps` (same) |

#### Safety Design

- All commands executed via `safeExec()` with 5-second timeout and 2MB buffer limit
- Failures return empty/default values, never propagate exceptions
- `windowsHide: true` prevents console popup on Windows
- Read-only commands only; no system modifications

### 2. Context Injector (`lib/system/context-injector.js`)

Intelligent prompt augmentation engine that selectively injects system context based on keyword relevance.

#### Exported Functions

| Function | Returns | Description |
|----------|---------|-------------|
| `shouldInject(prompt)` | `boolean` | Whether the prompt warrants context injection |
| `formatContext(telemetry, keys)` | `string` | Format selected telemetry into compact string |
| `injectContext(prompt, telemetry)` | `string` | Augment prompt with relevant system context |
| `classifyAction(description)` | `{ classification, reason }` | Classify action safety level |

#### Relevance Scoring

The injector uses a priority-weighted keyword matching system:

| Trigger Keywords (EN) | Trigger Keywords (KO) | Injected Data | Priority |
|------------------------|------------------------|---------------|----------|
| slow, lag, hang, freeze, cpu | 느려, 멈춤, 렉 | cpu, memory | 10 |
| memory, ram, oom, leak | 메모리, 램, 누수 | memory, cpu | 10 |
| error, crash, fail, bug | 에러, 오류, 크래시, 버그 | errors, cpu, memory | 9 |
| deploy, docker, container | 배포, 도커, 컨테이너 | docker, network | 8 |
| disk, storage, space, full | 디스크, 용량, 저장, 꽉 | disk | 8 |
| port, network, connect, http | 포트, 네트워크, 연결 | network | 7 |
| git, branch, commit, merge | 브랜치, 커밋, 머지 | git | 6 |
| system, os, environment | 시스템, 환경, 플랫폼 | cpu, memory, disk | 5 |

#### Context Format

Injected context is appended as:
```
[System Context: win32/x64 | CPU: 45% used | top: node(12%), chrome(8%) | Memory: 12.5GB/16.0GB (78% used)]
```

Token budget: maximum 500 tokens (approx. 2000 characters).

### 3. Action Space Classification

Three-tier safety classification aligned with `sandbox.js` blocked patterns:

| Classification | Description | Examples |
|----------------|-------------|----------|
| **auto** | Safe for automatic execution (read-only) | process list, disk usage, cpu usage, git status |
| **confirm** | Requires explicit user confirmation | kill process, restart service, delete file |
| **blocked** | Absolutely prohibited | system shutdown, format disk, rm -rf, fork bomb |

## Integration Points

### With `platform.js`

The telemetry collector imports `getPlatform()` to determine the OS at startup and select the appropriate command implementations.

### With `sandbox.js`

The action space classification in `context-injector.js` mirrors the blocked patterns from `sandbox.js`, ensuring consistent safety enforcement:
- `ACTION_SPACE.blocked` aligns with `BLOCKED_PATTERNS` in sandbox.js
- System actions flow through both layers for defense in depth

### With `cognitive-router.js`

The cognitive router can invoke `shouldInject()` during prompt classification to determine if system context is relevant, then call `injectContext()` to augment the prompt before routing.

### With Hook System

Integration path via hooks:
1. `UserPromptSubmit` hook: cognitive-router classifies prompt
2. If system keywords detected: telemetry-collector gathers snapshot
3. context-injector scores relevance and formats context
4. Augmented prompt passed to orchestrator

## Design Decisions

### Zero Dependencies

All system information is collected using only:
- `node:os` (memory, CPU info)
- `node:child_process` (`execSync` for platform commands)

No external packages required. This maintains Artibot's zero-dependency philosophy.

### Graceful Degradation

Every collector function follows the pattern:
1. Attempt platform-specific command
2. On failure, return empty/default value
3. Never throw exceptions to callers

This ensures telemetry collection never blocks the main workflow.

### Token Budget

Context injection is capped at 500 tokens to prevent overwhelming the LLM context window. Sections are added in priority order until the budget is exhausted.

### Bilingual Keyword Matching

All relevance keywords include both English and Korean equivalents, matching Artibot's bilingual design (user communicates in Korean).

## File Locations

```
plugins/artibot/
└── lib/
    └── system/
        ├── telemetry-collector.js   # System data collection
        └── context-injector.js      # Intelligent context injection
```
