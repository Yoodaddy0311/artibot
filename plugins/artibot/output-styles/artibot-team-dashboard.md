---
name: artibot-team-dashboard
description: Team status dashboard output style - visual workflow monitoring with ANSI colors
requires: lib/core/tui.js
---

## Overview

Team dashboard output style for displaying real-time team status, workflow progress,
and task tracking in CLI environments. Uses the `lib/core/tui.js` module for rendering.

## Dashboard Layout

```
┌──────────────────────────────────────────────────────────────┐
│ Agent Team [Leader Pattern]                                  │
├──────────────────────────────────────────────────────────────┤
│ 3 active | 1 ready | 0 blocked | 1 idle                     │
├──────────────────────────────────────────────────────────────┤
│ 🟡 ACTIVE  orchestrator    CTO            Planning sprint    │
│ 🟡 ACTIVE  frontend-dev    Frontend       Building UI comp   │
│ 🟡 ACTIVE  backend-dev     Backend        API endpoints      │
│ 🟢 READY   qa-engineer     QA                                │
│ ⚪ IDLE    security-rev    Security                          │
└──────────────────────────────────────────────────────────────┘
```

## Workflow Section

Displays the current playbook workflow as a pipeline:

```
 Workflow
 [Plan ✓]─→[Design ✓]─→[Implement ●]─→[Review ○]─→[Test ○]─→[Merge ○]
```

Supported playbooks: feature, bugfix, refactor, security

## Task Board Section

Kanban-style task board with three columns:

```
 Tasks
   Pending (2)              In Progress (3)          Done (5)
────────────────────────  ────────────────────────  ────────────────────────
 #1 Setup database         #3 Build auth module     #5 Project init
   @backend-dev              @backend-dev             @orchestrator
 #2 Design UI mockups      #4 Create test suite     #6 Config setup
                             @qa-engineer             @devops
```

## Timeline Section

Chronological event log with type-coded icons:

```
 Timeline
  ├─○ 14:30:15 [orchestrator] Team created with 5 members
  ├─● 14:31:02 [backend-dev] Database schema completed
  ├─▲ 14:32:45 [qa-engineer] Test coverage below 80% threshold
  └─▶ 14:33:10 [frontend-dev] Starting component implementation
```

Event types: ○ info | ● success | ▲ warning | ■ error | ▶ action

## Status Indicators

| Status | Icon | Color | Description |
|--------|------|-------|-------------|
| ready | 🟢 | Green | Available for task assignment |
| active/in_progress | 🟡 | Yellow | Currently working on a task |
| blocked | 🔴 | Red | Waiting on dependency |
| idle | ⚪ | Gray | No task assigned |
| completed | 🟢 | Green | All tasks finished |
| error | 🔴 | Red | Encountered an error |

## Usage in Hooks

Import from `lib/core/tui.js`:

```javascript
import { fullDashboard, teamDashboard, workflowVisualizer, taskBoard, timeline } from '../../lib/core/tui.js';

// Full composite view
const output = fullDashboard({
  teammates: [...],
  workflow: [...],
  tasks: [...],
  events: [...],
  meta: { teamName: 'Feature Team', pattern: 'Leader', playbook: 'feature' }
});

// Individual components
const dash = teamDashboard(teammates, { teamName: 'My Team' });
const wf = workflowVisualizer(steps);
const board = taskBoard(tasks);
const log = timeline(events);
```

## ANSI Color Support

- Respects `NO_COLOR` environment variable (disables colors)
- Respects `FORCE_COLOR` environment variable (forces colors)
- Auto-detects TTY for color support
- Falls back to plain text in non-TTY environments (pipes, redirects)

## Terminal Width

- Auto-detects terminal width via `process.stdout.columns`
- Default fallback: 80 columns
- Maximum dashboard width: 100 columns
- Responsive: truncates content to fit available width
