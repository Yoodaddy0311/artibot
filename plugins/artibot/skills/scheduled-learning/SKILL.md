---
context: fork
disable-model-invocation: true
name: scheduled-learning
description: |
  CronCreate-based automatic scheduling for the nightly-learner pipeline and drift checks.
  Activates learning jobs within the current Claude Code session using in-memory cron scheduling.
  Triggers: schedule learning, cron learning, nightly learner schedule, 학습 스케줄, 자동 학습
lang: [en, ko]
platforms: [claude-code]
level: 2
triggers:
  - "schedule learning"
  - "cron learning"
  - "학습 스케줄"
  - "자동 학습"
  - "nightly schedule"
agents:
  - "orchestrator"
tokens: "~1K"
category: "learning"
source_hash: 7f6d35af
whenNotToUse: "Non-Claude Code environments or sessions where CronCreate is not available; also not applicable for on-demand, single-run learning triggers."
---

# Scheduled Learning

Automatic in-session scheduling for the Artibot learning pipeline using Claude Code's `CronCreate` tool.

## When This Skill Applies
- User requests automatic/periodic learning during a session
- Orchestrator needs to schedule nightly-learner or drift checks
- Session-start automation wants to set up recurring learning jobs

## Key Constraints

| Constraint | Detail |
|------------|--------|
| Session-only | CronCreate jobs exist only in the current REPL session; gone when Claude exits |
| Auto-expiry | Recurring jobs auto-expire after 7 days |
| Idle-only | Jobs fire only when the REPL is idle (not mid-query) |
| No external services | DATA POLICY: No Codecov, no external cron services, no outbound data |
| Opt-in | Scheduling is disabled by default; requires explicit config or user request |

## Configuration

Settings in `artibot.config.json` under `learning.schedule`:

```json
{
  "learning": {
    "schedule": {
      "nightlyLearner": "0 2 * * *",
      "driftCheck": "0 6 * * 1",
      "enabled": false
    }
  }
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | `false` | Master switch for automatic scheduling |
| `nightlyLearner` | `"0 2 * * *"` | Cron expression for the learning pipeline (default: 2 AM daily) |
| `driftCheck` | `"0 6 * * 1"` | Cron expression for routing drift analysis (default: 6 AM Monday) |

## Scheduling via CronCreate

### Nightly Learner Job

The nightly-learner pipeline collects session experiences, runs GRPO batch learning, and performs knowledge transfer (System 1 <-> System 2 hot-swap).

```
CronCreate:
  cron: "3 2 * * *"       # 2:03 AM daily (avoid :00 mark)
  recurring: true
  prompt: |
    Run the Artibot nightly learning pipeline:
    1. Collect today's routing experiences from ~/.claude/artibot/daily-experiences.json
    2. Run GRPO batch learning (group size 5, batch size 50)
    3. Transfer knowledge: promote patterns with 3+ consecutive successes to System 1, demote patterns with 2+ failures back to System 2
    4. Persist updated caches to ~/.claude/artibot/
    5. Report summary: groups processed, patterns extracted, promoted/demoted counts
```

### Drift Check Job

Periodic check for routing threshold drift — detects if the cognitive router has drifted from optimal settings.

```
CronCreate:
  cron: "7 6 * * 1"       # 6:07 AM Monday (avoid :00 mark)
  recurring: true
  prompt: |
    Run Artibot routing drift analysis:
    1. Read current routing threshold from ~/.claude/artibot/learning-log.json
    2. Compare against baseline threshold (0.4) from artibot.config.json
    3. Check if threshold has drifted more than 0.15 from baseline
    4. If drifted: report the drift direction and magnitude, suggest reset or continued adaptation
    5. If stable: report current threshold and recent adaptation history
```

## Activation Methods

### Method 1: Manual (User Request)
User says "학습 스케줄 설정해줘" or "schedule learning" — orchestrator reads config and creates cron jobs.

### Method 2: Session-Start Integration
When `learning.schedule.enabled` is `true`, the orchestrator can create cron jobs at session start by reading the config and calling CronCreate for each enabled schedule.

### Method 3: One-Shot
For a single deferred learning run (not recurring):
```
CronCreate:
  cron: "30 23 <today_dom> <today_month> *"
  recurring: false
  prompt: "Run the Artibot nightly learning pipeline..."
```

## Workflow Checklist

```
Progress:
- [ ] Step 1: Read learning.schedule config from artibot.config.json
- [ ] Step 2: Check if scheduling is enabled (learning.schedule.enabled)
- [ ] Step 3: Create nightly-learner cron job via CronCreate
- [ ] Step 4: Create drift-check cron job via CronCreate (if configured)
- [ ] Step 5: Confirm job IDs and next fire times to user
- [ ] Step 6: Store job IDs for potential CronDelete cleanup
```

## Human Checkpoints

### Checkpoint 1: Schedule Confirmation (After Step 2)
**Context**: Config has been read and scheduling parameters are determined.
**Ask**: "학습 스케줄을 설정합니다. **다음 설정이 맞나요?** nightlyLearner: `{cron}`, driftCheck: `{cron}`"
**Options**:
1. Confirm — 설정대로 스케줄 생성
2. Modify — cron 표현식 변경 후 생성
3. Skip — 스케줄 생성하지 않음
**Default**: 1
**Skippable**: No
**Freedom**: LOW

## Freedom Levels

| Step | Freedom | Guidance |
|------|:-------:|----------|
| Read config | LOW | Fixed config path and schema |
| Check enabled flag | LOW | Boolean check, no interpretation |
| Create cron jobs | LOW | CronCreate parameters are defined by config |
| Confirm to user | LOW | Report job IDs and schedule |
| Store job IDs | LOW | In-memory storage for cleanup |

## Integration with Other Skills

- **lifelong-learning**: This skill schedules the same pipeline that lifelong-learning describes
- **session-worklog**: Scheduled learning results can be logged in the worklog
- **cognitive-routing**: Drift check monitors the routing threshold maintained by cognitive-routing

## Quick Reference

**Tool**: `CronCreate` (Claude Code built-in, session-only)
**Config**: `artibot.config.json` > `learning.schedule`
**Default**: Disabled (opt-in)
**Expiry**: 7 days auto-expire for recurring jobs
**Nightly**: 2:03 AM daily — GRPO batch learning + knowledge transfer
**Drift**: 6:07 AM Monday — routing threshold drift analysis

## Rationalizations

The following table captures common excuses agents make to skip the discipline of this skill, paired with factual rebuttals.

| Excuse | Rebuttal |
|--------|----------|
| "on-demand learning is enough" | on-demand means "when I remember" which means "never"; scheduling makes it non-optional |
| "scheduled jobs waste compute on idle periods" | idle-period learning is the cheapest compute you have; it's amortized background work |
| "I'll run it manually at milestones" | milestones drift; the schedule is your external pacemaker |
| "batch schedules lag real-time signal" | real-time learning is where noise enters; batch is the correct buffer for stable signal extraction |
| "the scheduler adds ops complexity" | one cron line is not ops complexity; the absence of scheduling is what creates the complexity of manual reminders |
