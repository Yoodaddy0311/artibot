---
context: fork
disable-model-invocation: true
name: auto-learning-pipeline
description: |
  Runs a fully autonomous nightly learning pipeline that evaluates code quality, extracts patterns from recent commits,
  updates knowledge stores, refines skills, and auto-commits improvements — all without human intervention.
  DATA POLICY: auto-commit to local repo is allowed; auto-push to remote requires explicit opt-in (autoPush: true).
  Git webhooks are inbound-only (external server → Artibot). Auto-activates when: autonomous learning pipeline requested,
  nightly learning setup, scheduled skill refinement, or first-run pipeline configuration.
  Triggers: auto learning, nightly pipeline, 자동 학습 파이프라인, autonomous learning, unattended learning,
  자동으로 매일 밤 학습시켜줘, 스킬 자동 개선 설정해줘, 학습 파이프라인 켜줘
lang: [en, ko]
platforms: [claude-code]
level: 3
triggers:
  - "auto learning"
  - "auto-learning pipeline"
  - "nightly pipeline"
  - "자동 학습 파이프라인"
  - "autonomous learning"
  - "unattended learning"
agents:
  - "orchestrator"
  - "devops-engineer"
tokens: "~3K"
category: "learning"
source_hash: 901645c4
whenNotToUse: "Interactive sessions where human-supervised learning (continuous-learning, self-evaluation) is preferred; also not applicable when autoLearning.enabled is false or Git write access is unavailable."
---

# Auto-Learning Pipeline

Fully autonomous nightly learning pipeline that runs without human intervention.
Artibot evaluates its own code quality, extracts patterns from recent commits,
updates knowledge stores, refines skills, and auto-commits improvements.

## When This Skill Applies

- Configuring autonomous learning (`autoLearning.enabled: true` in config)
- Setting up `claude schedule` for recurring pipeline execution
- Reviewing pipeline run history and learning logs
- Manual one-shot pipeline trigger via `/auto-learn` or skill activation

## Core Concepts

### Pipeline Architecture

```
┌─────────────────────────────────────────────────────────┐
│                  Auto-Learning Pipeline                  │
│                                                         │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────┐ │
│  │ 1. Self  │→ │ 2. Pat-  │→ │ 3. Know- │→ │ 4. Sk- │ │
│  │   Scan   │  │   tern   │  │   ledge  │  │   ill  │ │
│  │          │  │  Extract │  │  Update  │  │ Refine │ │
│  └──────────┘  └──────────┘  └──────────┘  └────────┘ │
│       │                                         │      │
│       └─────────── 5. Auto-Commit ──────────────┘      │
└─────────────────────────────────────────────────────────┘
```

### Pipeline Stages

#### Stage 1: Self-Scan
Evaluate current codebase quality using deterministic metrics.

| Check | Tool | Threshold |
|-------|------|-----------|
| ESLint | `npm run lint` | 0 errors |
| Tests | `npm test` | 100% pass rate |
| Coverage | `npm run test:coverage` | Statements 90%, Branches 85% |
| File size | Static analysis | < 800 lines per file |

Output: `ScanReport { errors, warnings, testsPassed, testsFailed, coverage }`

#### Stage 2: Pattern Extract
Analyze recent git commits for recurring patterns and error trends.

```
git log --since="24 hours ago" --format="%H %s"
  → Parse commit messages for fix/feat/refactor patterns
  → Count error recurrence by file/module
  → Identify hot files (modified > 3 times in 24h)
  → Extract improvement candidates
```

Output: `PatternReport { patterns[], hotFiles[], errorTrends[], candidates[] }`

#### Stage 3: Knowledge Update
Persist learning results to memory stores and skill references.

- Write pattern summaries to `~/.claude/artibot/patterns/`
- Update `~/.claude/artibot/learning-log.json` with pipeline run record
- Feed extracted patterns to `lib/learning/knowledge-transfer.js` for System 1/2 promotion
- Run drift detection via `lib/learning/drift-detector.js`

#### Stage 4: Skill Refinement
Auto-improve existing skill triggers and descriptions based on learned patterns.

- Scan skills with low activation rates (from tool-history)
- Suggest trigger keyword additions based on pattern analysis
- Update skill `references/` with new pattern examples
- Inject rules via `lib/learning/skill-injector.js`

Guardrail: Only modify `references/` files and trigger keywords. Never rewrite core SKILL.md guidance.

#### Stage 5: Auto-Commit
Commit and push pipeline changes automatically.

```
1. git add -A (only pipeline output files)
2. git commit -m "chore(auto-learn): nightly pipeline — [date] [summary]"
3. git push (if autoPush enabled)
```

Guardrail: `maxChangesPerRun` limits total modified files. Exceeding aborts commit.

## Configuration

Settings in `artibot.config.json` under `autoLearning`:

```json
{
  "autoLearning": {
    "enabled": true,
    "schedule": "0 3 * * *",
    "pipeline": ["self-scan", "pattern-extract", "knowledge-update", "skill-refinement"],
    "autoCommit": true,
    "autoPush": false,
    "maxChangesPerRun": 10,
    "dryRun": false
  }
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | `false` | Master switch for the auto-learning pipeline |
| `schedule` | `"0 3 * * *"` | Cron expression (default: 3 AM daily) |
| `pipeline` | `[all 4 stages]` | Which stages to run (subset allowed) |
| `autoCommit` | `true` | Auto-commit pipeline output (local repo only) |
| `autoPush` | `false` | **DATA POLICY**: Artibot → 외부 git 서버 push. 기본 off — 명시적 opt-in(`true`) 필요 |
| `maxChangesPerRun` | `10` | Max files changed per run (safety limit) |
| `dryRun` | `false` | Log changes without writing to disk |

## Activation Methods

### Method 1: claude schedule (Remote Trigger)

```bash
node plugins/artibot/scripts/setup-auto-learning.js
```

Registers a recurring `claude schedule` job that triggers the pipeline at the configured cron time.
Works with Claude's remote execution — no active REPL session required.

### Method 2: CronCreate (Session-Only)

```
CronCreate:
  cron: "3 3 * * *"
  recurring: true
  prompt: "Run the auto-learning pipeline with all stages enabled."
```

Session-only. Expires when Claude exits. Use for testing.

### Method 3: Manual One-Shot

User says "자동 학습 파이프라인 실행" or "run auto-learning pipeline" — orchestrator executes the pipeline immediately.

### Method 4: Git Webhook

Configure a webhook on the Git server to POST to Claude's endpoint after push events.
The webhook payload triggers a pipeline run scoped to the changed files.

> **DATA POLICY 방향성**: Git webhook은 외부 서버 → Artibot 수신 방향입니다 (inbound only).
> Artibot이 외부로 데이터를 전송하지 않으므로 DATA POLICY 위반이 아닙니다.
> 반대 방향(Artibot → 외부 서버 push)은 `autoPush: true` opt-in이 필요합니다.

## Integration with Existing Modules

| Module | Integration Point |
|--------|-------------------|
| `lib/learning/lifelong-learner.js` | Experience collection, batch learning |
| `lib/learning/self-evaluator.js` | Quality scoring for self-scan stage |
| `lib/learning/pattern-analyzer.js` | Pattern grouping and GRPO ranking |
| `lib/learning/knowledge-transfer.js` | System 1/2 promotion after knowledge update |
| `lib/learning/knowledge-demotion.js` | Hot-swap during knowledge update |
| `lib/learning/skill-injector.js` | Rule injection during skill refinement |
| `lib/learning/drift-detector.js` | Drift check during knowledge update |
| `lib/learning/tool-learner.js` | Tool usage stats for skill refinement |
| `scripts/hooks/nightly-learner.js` | Existing session-end learning (complementary) |
| `skills/scheduled-learning/` | CronCreate scheduling (session-only alternative) |
| `skills/git-unified/` (references/autopilot.md) | Auto-commit strategy reuse |

## Workflow Checklist

```
Progress:
- [ ] Step 1: Read autoLearning config from artibot.config.json
- [ ] Step 2: Validate config (enabled, pipeline stages, limits)
- [ ] Step 3: Run Stage 1 — Self-Scan (lint, test, coverage)
- [ ] Step 4: Run Stage 2 — Pattern Extract (git log analysis)
- [ ] Step 5: Run Stage 3 — Knowledge Update (persist patterns, promote/demote)
- [ ] Step 6: Run Stage 4 — Skill Refinement (triggers, references)
- [ ] Step 7: Check maxChangesPerRun limit
- [ ] Step 8: Run Stage 5 — Auto-Commit (if not dryRun)
- [ ] Step 9: Write pipeline run log to learning-log.json
```

## Human Checkpoints

### Checkpoint 1: First-Run Confirmation (Before Step 3, first run only)
**Context**: First time the pipeline runs after being enabled. Verifying config is correct before any automated changes.
**Ask**: "자동 학습 파이프라인을 처음 실행합니다. **설정을 확인해주세요**: schedule=`{cron}`, stages=`{stages}`, maxChanges=`{max}`"
**Options**:
1. Confirm — proceed with current settings
2. Modify — adjust settings before first run
3. Dry-run — run in dryRun mode first to preview changes
**Default**: 3 (safe first run)
**Skippable**: No
**Freedom**: LOW

### Checkpoint 2: Max Changes Exceeded (After Step 7)
**Context**: Pipeline produced more changes than maxChangesPerRun allows.
**Ask**: "파이프라인이 **{count}개 파일**을 변경했습니다 (한도: {max}). 어떻게 처리할까요?"
**Options**:
1. Commit all — 한도 무시하고 모두 커밋
2. Commit partial — 가장 중요한 {max}개만 커밋
3. Abort — 이번 실행 결과 폐기
**Default**: 3 (abort for safety)
**Skippable**: No
**Freedom**: LOW

## Freedom Levels

| Step | Freedom | Guidance |
|------|:-------:|----------|
| Read config | LOW | Fixed config path and schema |
| Self-scan | LOW | Deterministic checks (lint, test, coverage) |
| Pattern extract | MEDIUM | Git log parsing requires interpretation |
| Knowledge update | LOW | Uses existing knowledge-transfer API |
| Skill refinement | MEDIUM | Trigger suggestions require judgment |
| Max changes check | LOW | Numeric comparison against limit |
| Auto-commit | LOW | Commit message format is defined |
| Write run log | LOW | Schema is defined |

## Guardrails

- **main/master protection**: Never auto-commit directly to main/master branches
- **maxChangesPerRun**: Hard limit on files changed per pipeline run
- **dryRun mode**: Preview all changes without writing to disk
- **No core SKILL.md rewrites**: Only modify `references/` and trigger keywords
- **No dependency changes**: Never modify package.json, lock files, or config schemas
- **Rollback**: All auto-commits use conventional commit format for easy `git revert`
- **Logging**: Every pipeline run writes a detailed log entry to learning-log.json
- **excludePaths**: Respects git-unified autopilot excludePaths (`.env`, `*.secret`, `*.key`)

## Quick Reference

**Config**: `artibot.config.json` > `autoLearning`
**Default**: Disabled (opt-in)
**Schedule**: 3 AM daily (configurable)
**Stages**: self-scan → pattern-extract → knowledge-update → skill-refinement → auto-commit
**Safety**: maxChangesPerRun=10, dryRun mode, main branch protection
**Logs**: `~/.claude/artibot/learning-log.json`
**Setup**: `node scripts/setup-auto-learning.js`

## Rationalizations

The following table captures common excuses agents make to skip the discipline of this skill, paired with factual rebuttals.

| Excuse | Rebuttal |
|--------|----------|
| "manual curation is higher quality" | manual curation doesn't scale past one session; auto-pipelines surface patterns you'd never notice by hand |
| "the pipeline will learn noise" | noise gets filtered by confidence thresholds and validation gates — untuned learning still beats zero learning |
| "I'll enable it once the code is stable" | stability without feedback loops is a local maximum; the pipeline is how you escape it |
| "learned patterns contradict my intent" | if the pattern contradicts intent, your intent wasn't encoded as a constraint — fix the gate, not the pipeline |
| "batching learning wastes fresh signal" | per-event learning overfits to outliers; batch learning with GRPO is the correct statistical frame |
