---
context: fork
user-invocable: false
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
source_hash: 2c846133
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

## Workflow Checklist

Copy this checklist and track progress:

```
Progress:
- [ ] Step 1: Evaluate completed task across 4 dimensions (accuracy, completeness, efficiency, satisfaction)
- [ ] Step 2: Generate N candidate strategies (GRPO) if comparing approaches
- [ ] Step 3: Score each candidate against rule-based evaluators
- [ ] Step 4: Rank within group — compute relative advantage
- [ ] Step 5: Update strategy weights (boost winners, reduce losers)
- [ ] Step 6: Persist evaluation + weights to storage
- [ ] Step 7: Review improvement suggestions if score < 3.0
```

## Human Checkpoints

### Checkpoint 1: 평가 점수 검토 (After Step 1)
**Context**: 4개 차원(정확성·완성도·효율성·만족도)에 따른 자동 채점이 완료된 시점. 가중치 기반 산출이므로 실제 작업 품질과 괴리가 생길 수 있어 사람의 판단이 필요하다.
**Ask**: "평가 점수가 **실제 작업 품질을 적절히 반영**하고 있나요?"
**Options**:
1. Accept scores — 점수를 그대로 수용하고 다음 단계로 진행
2. Override specific dimension — 특정 차원 점수를 수동으로 조정
**Default**: 1 (자동 산출 점수가 대부분의 경우 신뢰 가능)
**Skippable**: No — 점수 수용 또는 조정을 명시적으로 결정해야 함
**Freedom**: LOW

### Checkpoint 2: GRPO 랭킹 유효성 확인 (After Step 4)
**Context**: 후보 전략들의 상대 랭킹이 산출된 시점. 비교 조건이 동등하지 않으면 랭킹이 왜곡될 수 있으므로 저장 전에 검증이 필요하다.
**Ask**: "GRPO 랭킹이 **실제 품질 차이를 올바르게 반영**하고 있나요?"
**Options**:
1. Accept ranking — 랭킹을 수용하고 가중치 업데이트로 진행
2. Discard this comparison — 이번 비교 결과를 폐기하고 가중치 업데이트 생략
**Default**: 1 (규칙 기반 평가는 일반적으로 신뢰 가능)
**Skippable**: No — 랭킹 수용 또는 폐기를 명시적으로 결정해야 함
**Freedom**: LOW

### Checkpoint 3: 개선 제안 실행 여부 (After Step 7)
**Context**: 점수가 3.0 미만인 경우 자동 생성된 개선 제안 목록이 준비된 시점. 제안의 우선순위와 실행 가능성은 현재 컨텍스트에 따라 달라진다.
**Ask**: "생성된 **개선 제안을 어떻게 처리**하시겠어요?"
**Options**:
1. Implement now — 즉시 개선 작업 착수
2. Defer — 다음 세션으로 미루고 메모리에 보류 항목으로 저장
3. Dismiss — 현재 컨텍스트에 맞지 않아 제안 무시
**Default**: 2 (즉각 실행보다 계획적 접근이 안전)
**Skippable**: Yes (skip 시 Defer로 처리)
**Freedom**: HIGH

## Freedom Levels

| Step | Freedom | Guidance |
|------|:-------:|----------|
| Evaluate task | LOW | 4 dimensions and weights are defined |
| Generate candidates | MEDIUM | Number of candidates (N) is configurable |
| Score candidates | LOW | Rule-based evaluators are deterministic |
| Rank within group | LOW | Relative ranking formula is defined |
| Update weights | LOW | Learning rate (0.1) and formula are fixed |
| Persist to storage | LOW | File paths and max entries are configured |
| Review suggestions | HIGH | Acting on suggestions is a judgment call |

## Quick Reference
- Evaluate after every significant task completion
- Use GRPO when comparing multiple approaches to the same problem
- Use team GRPO to optimize orchestration patterns per domain
- `runLearningCycle()` integrates all 4 modules in one call
- Review suggestions when scores drop below 3.0
- Check `getRecommendation()` before selecting strategy or team composition
- All rule-based: no external judge AI needed

## Rationalizations

The following table captures common excuses agents make to skip the discipline of this skill, paired with factual rebuttals.

| Excuse | Rebuttal |
|--------|----------|
| "the model can't objectively grade itself" | self-rewarding with rubrics is calibrated on held-out data; it's more objective than no evaluation at all |
| "external eval is always better" | external eval is slower and rarer; self-eval runs every turn and catches regressions in real time |
| "self-grading inflates scores" | inflation is detectable via GRPO relative comparison across rollouts; absolute grades aren't the point |
| "evaluation slows down the task" | un-evaluated output ships bugs; evaluation is how you avoid the rework cycle that actually slows things down |
| "I'll evaluate at the end" | end-of-task evaluation can't steer the task; per-step evaluation is what closes the loop |
