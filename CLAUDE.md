# Project Instructions

## Artibot Integration

### DEV Protocol (Mandatory for all code changes)
1. **DECOMPOSE**: Break request into numbered atomic items before any action
2. **EXECUTE**: Read target file → Make change → Re-read to confirm
3. **VERIFY**: Report with evidence per item (file:line + what changed)

### Zero-Skip Policy
- Never silently skip any part of a multi-part request
- Never claim completion without re-reading the modified file
- If blocked, explain WHY and propose alternatives

### Agent Delegation
- Complex features: use planner agent first
- After writing code: use code-reviewer agent
- Bug fixes / new features: use tdd-guide agent
- Architecture decisions: use architect agent
- Multiple independent tasks: launch agents in parallel

### Auto Team Mode (team.autoApply)
When `team.autoApply` is `true` in `artibot.config.json` (default), automatically use /team workflow for qualifying requests WITHOUT the user needing to type `/team`. This applies when ALL of these conditions are met:
1. The request involves **2+ independent subtasks** that can be parallelized
2. The request involves **2+ different files or domains** (e.g., frontend + backend, hook + config + test)
3. The estimated complexity is **medium or higher** (not a simple single-file edit or question)

When auto-team triggers, behave exactly as if the user typed `/team <their request>`:
- Decompose into independent work units
- Create a team and delegate to parallel teammates
- Cross-verify results before reporting

**Opt-out methods** (any one disables auto-team for the scope):
- Set `team.autoApply: false` in `artibot.config.json` (permanent)
- Add `team.autoApply: false` in `CLAUDE.local.md` under Personal Workflow Preferences (per-user)
- Include `--no-team` anywhere in the prompt (per-request)

### Quality Gates
- Read before write (no blind modifications)
- Functions < 50 lines, files < 800 lines
- Immutable patterns (create new objects, never mutate)
- 80%+ test coverage target
