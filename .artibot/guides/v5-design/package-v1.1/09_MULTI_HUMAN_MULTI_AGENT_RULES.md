# Multi-human / Multi-agent Collaboration Rules

## Why this matters

Once multiple people and agents operate in the same repository, implicit context becomes unreliable.

The project must move from:

```text
knowledge in someone's head
```

to:

```text
shared canonical state
```

## Collaboration invariants

### 1. Everyone reads the same root
Start with `ARTIBOT.md`.

### 2. Every active mission has one intent
Never fork mission intent into worker-specific intent files.

### 3. Workers may own work, not mission truth
A worker can own:
- files
- subtrees
- tasks

A worker cannot silently redefine:
- mission goal
- success criteria
- core product decision

### 4. State transitions are explicit
Worker status:
- queued
- claimed
- executing
- blocked
- reviewing
- done
- failed

### 5. Findings move upward through the planner
If a worker discovers a problem that may change intent:

```text
Finding
 ↓
Planner / Mission Controller
 ↓
Does intent require refinement?
 ├─ no → revise plan
 └─ yes → revise canonical intent.md
```

### 6. File ownership should be represented structurally
Especially in Split.

Avoid two workers editing the same file without coordination.

### 7. Review uses the same intent
Fable 5.1 reviewer must review against the canonical mission intent, not a worker-local interpretation.
