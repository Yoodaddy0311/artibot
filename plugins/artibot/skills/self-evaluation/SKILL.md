---
context: fork
user-invocable: false
name: self-evaluation
description: |
  Self-Rewarding + GRPO hybrid evaluation system for autonomous quality assessment, optimization, and improvement.
  Combines Meta Self-Rewarding patterns with Group Relative Policy Optimization (GRPO) for rule-based self-learning without judge AI.
  Auto-activates when: task completed, quality review needed, performance trends requested, team optimization needed.
  Triggers: evaluate, self-assess, quality, improve, performance, trend, score, feedback, grpo, optimize, candidates, compare
lang: [en]
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
source_hash: 6b2de433
whenNotToUse: "Mid-task execution phases where evaluation would interrupt active work; do not apply when there is no completed task output to score or compare."
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
> 위 도식의 앞 3단계(Generate Candidates · Group Evaluation · Update Weights)는 은퇴했다. 라이브로 도는 구간은 `Self-Rewarding Score -> Store in Memory` 뿐이다 — 아래 GRPO 절의 은퇴 표기 참조.

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

> **Retired (2026-06-20)** — 이 절이 서술하는 후보생성 → 규칙평가 → 가중치갱신 루프는 구현이 제거됐다. 삭제된 모듈 3종: `lib/learning/grpo-optimizer.js` · `lib/learning/grpo/` · `lib/cognitive/grpo-bridge.js`. 근거는 `artibot.config.json` 의 `learning.grpoRouting.comment`(2026-06-20 삭제 경위 기록). 아래 하위 절(CLI Rule-Based Evaluators · Team Composition Rules · GRPO Workflow · Team GRPO)은 **역사 기록으로 보존**하며 실행 지침이 아니다. 오늘 라이브로 남은 GRPO 계열은 lifelong-learning 스킬의 배치 학습 그룹 내 랭킹(`lib/learning/pattern-analyzer.js#grpoRankGroup`) 하나뿐이고, 그것은 이 절의 루프가 아니다.

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
6. **Persist**: Save weights to `~/.claude/artibot/grpo-history.json` — 은퇴(라이브 writer 없음). 디스크에 파일이 남아 있으면 `scripts/learning-diag.js` 가 "Retired / dormant" 배너와 함께 **과거 수치로만** 표시한다

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
> 위 도식의 GRPO 열(`evaluateGroup()`)과 `runLearningCycle()` 줄은 은퇴 — 두 심볼 모두 현재 export 되지 않는다. 남은 3열(`suggestTool()` · `saveMemory()` · `evaluateResult()`)은 export 된다. 그중 `suggestTool()` 은 런타임 호출자가 없고(2026-09-21 기준 정의·barrel·테스트뿐), 도구 학습의 라이브 경로는 `scripts/hooks/tool-tracker.js` 의 `recordUsage` 다. 4모듈을 한 번에 묶는 호출자는 없다 — 세션 종료 시 `lib/learning/pipeline.js#shutdownLearning` 이 메모리 요약 · `evaluateResult` · 경험 수집을 묶어 돈다. 위 GRPO 절의 은퇴 표기 참조.

## API Reference
```javascript
// Live — these 4 are the only symbols in this import list that lib/learning/index.js exports.
import {
  // Self-Rewarding
  evaluateResult, getImprovementSuggestions, getTeamPerformance, getLearningTrends,
} from '../lib/learning/index.js';

// Retired 2026-06-20 — no longer exported (historical, kept for reference only.
// Importing these would fail to link; see the retirement note under the GRPO section):
//   // GRPO
//   generateCandidates, evaluateGroup, updateWeights,
//   generateTeamCandidates, evaluateTeamGroup, updateTeamWeights,
//   getRecommendation, getGrpoStats, CLI_RULES, TEAM_EVALUATION_RULES,
//   // Hybrid cycle
//   runLearningCycle,

// --- Self-Rewarding ---
const evaluation = await evaluateResult(
  { id: 'task-1', type: 'build', description: 'Build auth module' },
  { success: true, testsPass: true, duration: 45000, filesModified: ['auth.js'] }
);

// --- GRPO: Task strategies --- (historical — retired 2026-06-20, not runnable)
// const candidates = generateCandidates({ id: 't1', type: 'build', domain: 'backend' }, 5);
// ... execute each candidate, attach result ...
// candidates[0].result = { exitCode: 0, errors: 0, duration: 3000, commandLength: 20, sideEffects: 0 };
// const groupResult = evaluateGroup(candidates);
// const weights = await updateWeights(groupResult);

// --- GRPO: Team compositions --- (historical — retired 2026-06-20, not runnable)
// const teamCandidates = generateTeamCandidates({ id: 't1', domain: 'security' });
// ... simulate or execute each team ...
// teamCandidates[0].result = { taskCount: 5, successCount: 4, completedCount: 5, duration: 120000, teamSize: 3 };
// const teamResult = evaluateTeamGroup(teamCandidates);
// const teamWeights = await updateTeamWeights(teamResult);

// --- Get recommendations --- (historical — retired 2026-06-20, not runnable)
// const best = await getRecommendation('team', { domain: 'security' });

// --- Full hybrid cycle --- (historical — retired 2026-06-20, not runnable)
// const cycle = await runLearningCycle(task, candidatesWithResults);
```

## Storage
- Evaluations: `~/.claude/artibot/evaluations.json` (max 500)
- GRPO history: `~/.claude/artibot/grpo-history.json` — 은퇴(라이브 writer 없음). `max 300 rounds` 는 과거 수치이며, 남아 있는 파일은 `scripts/learning-diag.js` 가 과거 데이터로만 읽는다
- Zero external dependencies

## Workflow Checklist

Copy this checklist and track progress:

```
Progress:
- [ ] Step 1: Evaluate completed task across 4 dimensions (accuracy, completeness, efficiency, satisfaction)
- [ ] Step 2: Generate N candidate strategies (GRPO) if comparing approaches (retired 2026-06-20 — skip)
- [ ] Step 3: Score each candidate against rule-based evaluators (retired 2026-06-20 — skip)
- [ ] Step 4: Rank within group — compute relative advantage (retired 2026-06-20 — skip)
- [ ] Step 5: Update strategy weights (boost winners, reduce losers) (retired 2026-06-20 — skip)
- [ ] Step 6: Persist evaluation + weights to storage (weights retired — persist the evaluation only)
- [ ] Step 7: Review improvement suggestions if score < 3.0
```

## Human Checkpoints

> `### Self-check` 항목은 사람에게 묻지 않는다 — 모델이 Ask 문장을 기준으로 스스로 검증하고, 통과하지 못하면 해당 Step 으로 돌아가 고친다. 스스로 해소할 수 없거나(사람만 할 수 있는 조치·예외 인정) 판단에 확신이 없으면 중단하고 사용자에게 보고한다. 사람의 결정이 필요한 것은 `### Checkpoint` 뿐이다.

### Self-check 1: 평가 점수 검토 (After Step 1)
**Context**: 4개 차원(정확성·완성도·효율성·만족도)에 따른 자동 채점이 완료된 시점. 가중치 기반 산출이므로 실제 작업 품질과 괴리가 생길 수 있어 사람의 판단이 필요하다.
**Ask**: "평가 점수가 **실제 작업 품질을 적절히 반영**하고 있나요?"
**Options**:
1. Accept scores — 점수를 그대로 수용하고 다음 단계로 진행
2. Override specific dimension — 특정 차원 점수를 수동으로 조정
**Default**: 1 (자동 산출 점수가 대부분의 경우 신뢰 가능)
**Skippable**: No — 점수 수용 또는 조정을 명시적으로 결정해야 함
**Freedom**: LOW

### Checkpoint 2: GRPO 랭킹 유효성 확인 (After Step 4)
> **Retired (2026-06-20)** — 이 체크포인트가 게이트하던 가중치 업데이트 기능이 은퇴해 현재 발동 조건이 없다. Step 2~5 를 건너뛰면 도달하지 않는다. 아래 본문은 역사 기록으로 보존한다.

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

> 위 표의 `Generate candidates` · `Score candidates` · `Rank within group` · `Update weights` 4행은 은퇴한 GRPO 루프의 단계라 현재 적용되지 않는다(역사 기록). 라이브는 `Evaluate task` · `Persist to storage`(평가 한정) · `Review suggestions`. 위 GRPO 절의 은퇴 표기 참조.

## Quick Reference
- Evaluate after every significant task completion
- ~~Use GRPO when comparing multiple approaches to the same problem~~ — 은퇴(2026-06-20)
- ~~Use team GRPO to optimize orchestration patterns per domain~~ — 은퇴(2026-06-20)
- ~~`runLearningCycle()` integrates all 4 modules in one call~~ — 은퇴, export 없음
- Review suggestions when scores drop below 3.0
- ~~Check `getRecommendation()` before selecting strategy or team composition~~ — 은퇴, export 없음
- Self-Rewarding 평가는 규칙 기반: 외부 judge AI 가 필요 없다(라이브)

## Rationalizations
> 이 절은 참고 자료다 — 아래 변명·반박은 모델이 작업 중 스스로 지름길을 점검하는 데 쓰고, 사용자에게 묻는 질문 목록이나 별도 게이트로 쓰지 않는다. 반박에 비추어 스스로 바로잡을 수 없으면 이 스킬의 Step·Checkpoint 규칙을 따른다.

The following table captures common excuses agents make to skip the discipline of this skill, paired with factual rebuttals.

| Excuse | Rebuttal |
|--------|----------|
| "the model can't objectively grade itself" | self-rewarding with rubrics is calibrated on held-out data; it's more objective than no evaluation at all |
| "external eval is always better" | external eval is slower and rarer; self-eval runs every turn and catches regressions in real time |
| "self-grading inflates scores" | inflation is detectable via GRPO relative comparison across rollouts; absolute grades aren't the point |
| "evaluation slows down the task" | un-evaluated output ships bugs; evaluation is how you avoid the rework cycle that actually slows things down |
| "I'll evaluate at the end" | end-of-task evaluation can't steer the task; per-step evaluation is what closes the loop |
