---
name: self-evaluation
description: |
  Self-Rewarding + GRPO hybrid evaluation system for autonomous quality assessment, optimization, and improvement.
  Combines Meta Self-Rewarding patterns with Group Relative Policy Optimization (GRPO) for rule-based self-learning without judge AI.
  Auto-activates when: task completed, quality review needed, performance trends requested, team optimization needed.
  Triggers: evaluate, self-assess, quality, improve, performance, trend, score, feedback, grpo, optimize, candidates, compare
platforms: [claude-code, gemini-cli, codex-cli, cursor]
level: 2
triggers:
  - "evaluate"
  - "self-assessment"
  - "quality check"
  - "self-review"
  - "introspect"
  - "assess"
agents:
  - "orchestrator"
tokens: "~2K"
category: "learning"
---

# Self-Evaluation (Self-Rewarding + GRPO Pattern)

## When This Skill Applies
- After completing a task that should be quality-assessed
- When reviewing performance trends across sessions
- When identifying areas for improvement in agent workflows
- When assessing team orchestration effectiveness
- When comparing multiple solution approaches for the same problem
- When optimizing team composition for a domain

## Core Guidance

### Hybrid Learning Loop
```
Generate Candidates (GRPO) -> Rule-Based Group Evaluation -> Update Weights -> Self-Rewarding Score -> Store in Memory -> Better Candidates Next Time
```

### Self-Rewarding Evaluation Dimensions
| Dimension | Weight | Description |
|-----------|--------|-------------|
| Accuracy | 35% | Correctness of output vs requirements |
| Completeness | 25% | Coverage of all requested aspects |
| Efficiency | 20% | Resource usage and execution speed |
| Satisfaction | 20% | Implicit user satisfaction signals |

### Scoring Scale
| Score | Grade | Meaning |
|-------|-------|---------|
| 4.5-5.0 | A | Exceptional quality |
| 3.5-4.4 | B | Good, minor improvements possible |
| 2.5-3.4 | C | Adequate, clear improvement areas |
| 1.5-2.4 | D | Below expectations |
| 1.0-1.4 | F | Failed, requires major revision |

### GRPO: Group Relative Policy Optimization

Rule-based self-learning without external judge AI. Core principle: generate multiple
candidates for one problem, evaluate them with deterministic rules, rank by relative
group performance, and update strategy weights so better approaches are preferred next time.

#### CLI Rule-Based Evaluators
| Rule | Evaluation | Score Range |
|------|-----------|-------------|
| exitCode | `exitCode === 0` -> 1.0, else 0.0 | 0-1 |
| errorFree | `errors === 0` -> 1.0, else 0.0 | 0-1 |
| speed | `1 / (1 + duration/1000)` | 0-1 |
| brevity | `1 / (1 + commandLength/50)` | 0-1 |
| sideEffects | `sideEffects === 0` -> 1.0, else 0.5 | 0.5-1 |

#### Team Composition Rules
| Rule | Evaluation | Score Range |
|------|-----------|-------------|
| successRate | `successCount / taskCount` | 0-1 |
| efficiency | `1 / (1 + duration/60000)` | 0-1 |
| resourceUse | `1 / (1 + teamSize/5)` | 0-1 |
| completeness | `completedCount / taskCount` | 0-1 |

#### GRPO Workflow
1. **Generate**: Create N candidate solutions/strategies for a task
2. **Execute**: Run each candidate (or simulate execution)
3. **Evaluate**: Score each candidate against rule set
4. **Rank**: Relative ranking within the group (no external judge needed)
5. **Update**: Boost weights for winning strategies, reduce for losing ones
6. **Persist**: Save weights to `~/.claude/artibot/grpo-history.json`

#### Team GRPO
Same pattern applied to team orchestration:
- Simulate Solo vs Squad vs Platoon configurations
- Compare leader, council, swarm, pipeline patterns
- Learn which composition works best per domain
- Weights key format: `pattern|size|domain`

### Improvement Loop Workflow
1. **Evaluate**: Score completed task across all 4 dimensions
2. **Analyze**: Compare against historical evaluations (last 50)
3. **Identify**: Find weak dimensions and task types below threshold
4. **Suggest**: Generate actionable improvement recommendations
5. **Track**: Monitor trends over time windows to validate improvement

### Hybrid Learning Architecture
```
Toolformer (tool selection) + BlenderBot (memory) + Self-Rewarding (evaluation) + GRPO (optimization)
         |                          |                        |                         |
    suggestTool()            saveMemory()            evaluateResult()        evaluateGroup()
         |                          |                        |                         |
         +--------- runLearningCycle() integrates all 4 modules --------+
```

## API Reference
```javascript
import {
  // Self-Rewarding
  evaluateResult, getImprovementSuggestions, getTeamPerformance, getLearningTrends,
  // GRPO
  generateCandidates, evaluateGroup, updateWeights,
  generateTeamCandidates, evaluateTeamGroup, updateTeamWeights,
  getRecommendation, getGrpoStats, CLI_RULES, TEAM_EVALUATION_RULES,
  // Hybrid cycle
  runLearningCycle,
} from '../lib/learning/index.js';

// --- Self-Rewarding ---
const evaluation = await evaluateResult(
  { id: 'task-1', type: 'build', description: 'Build auth module' },
  { success: true, testsPass: true, duration: 45000, filesModified: ['auth.js'] }
);

// --- GRPO: Task strategies ---
const candidates = generateCandidates({ id: 't1', type: 'build', domain: 'backend' }, 5);
// ... execute each candidate, attach result ...
candidates[0].result = { exitCode: 0, errors: 0, duration: 3000, commandLength: 20, sideEffects: 0 };
const groupResult = evaluateGroup(candidates);
const weights = await updateWeights(groupResult);

// --- GRPO: Team compositions ---
const teamCandidates = generateTeamCandidates({ id: 't1', domain: 'security' });
// ... simulate or execute each team ...
teamCandidates[0].result = { taskCount: 5, successCount: 4, completedCount: 5, duration: 120000, teamSize: 3 };
const teamResult = evaluateTeamGroup(teamCandidates);
const teamWeights = await updateTeamWeights(teamResult);

// --- Get recommendations ---
const best = await getRecommendation('team', { domain: 'security' });

// --- Full hybrid cycle ---
const cycle = await runLearningCycle(task, candidatesWithResults);
```

## Storage
- Evaluations: `~/.claude/artibot/evaluations.json` (max 500)
- GRPO history: `~/.claude/artibot/grpo-history.json` (max 300 rounds)
- Zero external dependencies

## Quick Reference
- Evaluate after every significant task completion
- Use GRPO when comparing multiple approaches to the same problem
- Use team GRPO to optimize orchestration patterns per domain
- `runLearningCycle()` integrates all 4 modules in one call
- Review suggestions when scores drop below 3.0
- Check `getRecommendation()` before selecting strategy or team composition
- All rule-based: no external judge AI needed
