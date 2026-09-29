---
context: fork
user-invocable: false
name: lifelong-learning
description: |
  Continuous learning pipeline that captures session experiences, performs batch learning via GRPO,
  and transfers validated knowledge between System 1 and System 2 caches.
  Auto-activates when: session end, pattern discovery during routing, knowledge transfer triggers, manual /learn command.
  Triggers: learn, experience, knowledge, transfer, promote, demote, grpo, batch, pattern, skill development, growth, continuous improvement
lang: [en]
platforms: [claude-code, gemini-cli, codex-cli, cursor]
level: 2
triggers:
  - "learn"
  - "skill development"
  - "knowledge"
  - "growth"
  - "continuous improvement"
agents:
  - "planner"
tokens: "~2K"
category: "learning"
source_hash: 8912c664
whenNotToUse: "One-off tasks or throwaway experiments where no routing pattern or user preference is worth persisting; do not trigger during active task execution."
---

# Lifelong Learning

## Contents
- [When This Skill Applies](#when-this-skill-applies)
- [Core Guidance](#core-guidance)
- [Configuration](#configuration)
- [Workflow Checklist](#workflow-checklist)
- [Human Checkpoints](#human-checkpoints)
- [Freedom Levels](#freedom-levels)
- [Quick Reference](#quick-reference)

## When This Skill Applies
- Session end (automatic via nightly-learner hook)
- Pattern discovery during routing decisions
- Knowledge transfer between System 1 and System 2
- Periodic consolidation of routing experience
- Manual learning triggers via `/learn` command

## Core Guidance

### 1. Learning Pipeline

```
Session Experiences
        |
        v
+------------------+
| Experience       |  Collect routing decisions + outcomes
| Collector        |  during the session
+--------+---------+
         |
         v
+------------------+
| Batch Learner    |  Process experiences in batches (size: 50)
| (GRPO)           |  Group Relative Policy Optimization
+--------+---------+
         |
         v
+------------------+
| Knowledge        |  Promote/demote patterns between
| Transfer         |  System 1 and System 2 caches
+--------+---------+
         |
         v
+------------------+
| Persistence      |  Save updated caches to disk
| Layer            |  ~/.claude/artibot/
+------------------+
```

> 위 도식에서 실제로 도는 구간은 Experience Collector → Batch Learner(`lib/learning/lifelong-learner.js#batchLearn`) → Knowledge Transfer(`lib/learning/knowledge-demotion.js#hotSwap`) 이며, 진입점은 SessionEnd 훅(`scripts/hooks/session-end.js` → `lib/learning/pipeline.js#shutdownLearning`)이다. Batch Learner 의 GRPO 는 그룹 내 규칙 기반 **랭킹**(`lib/learning/pattern-analyzer.js#grpoRankGroup`)이며 라우팅 정책 최적화가 아니다. 도식 문구 중 "Collect routing decisions + outcomes" · "batches (size: 50)" 는 현재 코드와 맞지 않는다 — §2·§3 참조.

### 2. Experience Collection

Each routing decision is recorded as an experience entry:

| Field | Type | Description |
|-------|------|-------------|
| `input` | string | User request (anonymized) |
| `complexity` | number | Computed complexity score |
| `routed_to` | string | "system1" or "system2" |
| `outcome` | string | "success", "escalated", "failed" |
| `latency_ms` | number | Processing time |
| `confidence` | number | Router confidence at decision time |
| `timestamp` | string | ISO timestamp |

> 위 표는 실제 스키마가 아니다. 수집기가 쓰는 것은 라우팅 결정이 아니라 `{ id, type, category, data, timestamp, sessionId, model }` 모양의 경험이며 `type` 은 `tool` · `agent` · `success` · `error` · `team` · `self-evaluation` 이다(`lib/learning/lifelong-learner.js#collectExperience` · `collectDailyExperiences`; 호출처는 `scripts/hooks/tool-tracker.js` · `scripts/hooks/agent-evaluator.js` · `lib/learning/pipeline.js`, 그리고 사람이 `/learning review approve` 로 승인할 때 대화 코퍼스를 `success` / `ledger-corpus` 경험으로 승격하는 `lib/learning/ledger/review-queue.js#approve`(진입점 `scripts/ledger-review.js`)). 표의 `routed_to` 는 이 스킬 밖의 리포 전역(2026-09-29 grep, node_modules 제외)에서 나오지 않는다. 역사 기록으로 보존한다.

### 3. GRPO (Group Relative Policy Optimization)

> **Live vs Retired (2026-09-29)** — **라이브**는 그룹 내 랭킹이다: 세션 종료 시 `batchLearn()` 이 경험을 `type::category` 로 묶고(그룹 최소 크기 `MIN_GROUP_SIZE = 2`), `grpoRankGroup()` 이 경험마다 규칙 기반 4차원 점수(success 0.35 · speed 0.25 · reliability 0.25 · resource efficiency 0.15)로 `composite` 를 내 내림차순으로 정렬하고 각 항목에 `relativeAdvantage = composite − 그룹 평균` 을 붙인다. 이어 `extractPattern()` 이 최고 항목을 기준으로 패턴을 뽑아(신호가 부족하면 null) `~/.claude/artibot/patterns/<type>-patterns.json` 에 병합하고, `learning-log.json` 에 한 줄(`groupsProcessed` · `patternsExtracted`)을 남긴다. 이 과정은 라우팅 임계값을 건드리지 않는다.
>
> **Retired** — 아래 4단계 중 **라우팅 임계값 갱신**(3·4단계)과 System 1 vs System 2 비교(2b·2c)는 실행되지 않는다. `lib/cognitive/router.js#adaptThreshold` 의 프로덕션 호출자가 0 이다(리포 전역 grep 2026-09-29: 정의와 JSDoc 예시 밖에서는 `tests/` · `_design/` 에만 나온다). 라우터는 임계값을 디스크에 저장·로드하지 않으므로(`router.js` 는 fs 를 쓰지 않는다) "갱신된 임계값을 세션 시작 시 로드" 하는 경로도 없다. 삭제 경위는 `artibot.config.json` 의 `learning.grpoRouting.comment`(2026-06-20). 아래 원문은 **역사 기록으로 보존**한다.

Batch learning algorithm that groups similar experiences and optimizes routing thresholds (역사 — 위 Retired 표기 참조):

```
1. Group experiences by domain + complexity range (group size: 5)
2. For each group:
   a. Calculate success rate per routing decision
   b. Compare System 1 vs System 2 outcomes
   c. Compute relative advantage: advantage = s2_success - s1_success
3. Update routing threshold:
   - If System 2 consistently better -> lower threshold (more System 2)
   - If System 1 reliably handles -> raise threshold (more System 1)
4. Adjustment step: adaptRate * advantage (clamped to [-0.1, 0.1])
```

| Parameter | Default | Description |
|-----------|---------|-------------|
| `batchSize` | 50 | Experiences per batch |
| `grpoGroupSize` | 5 | Experiences per comparison group |

> `batchSize` · `grpoGroupSize` 는 `artibot.config.json` · `lib/core/config-schema.js` 에 선언만 돼 있고 이를 읽는 코드가 없다(grep 2026-09-29: `grpoGroupSize` 는 설정·스키마·스키마 테스트 픽스처·문서에만 나오고, `batchSize` 는 `lib/` · `scripts/` · `hooks/` 에서 `config-schema.js` 선언 외에 나오지 않는다 — `learning.lifelong` 을 읽는 코드가 없다). `batchLearn()` 은 디스크의 경험(최대 1000건, `MAX_EXPERIENCES`)을 한 번에 처리하고, 그룹 하한은 상수 `MIN_GROUP_SIZE = 2` 다.

### 4. Knowledge Transfer

Validated patterns move between System 1 and System 2 caches:

#### Promotion (System 2 -> System 1)
- Pattern succeeds `promotionThreshold` (3) consecutive times in System 2
- Confidence consistently > 0.8
- Action: Cache pattern in System 1 for fast retrieval

#### Demotion (System 1 -> System 2)
- Pattern fails `demotionThreshold` (2) consecutive times in System 1
- Confidence drops below minConfidence
- Action: Remove from System 1 cache, flag for System 2 analysis

```
System 2 Cache                              System 1 Cache
+-------------------+    promote (3x)     +-------------------+
| Complex patterns  | =================> | Fast patterns     |
| Deep analysis     |                    | Cached heuristics |
| New discoveries   | <================= | Quick matches     |
+-------------------+    demote (2x)     +-------------------+
```

### 5. Knowledge Transfer Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `promotionThreshold` | 3 | Consecutive successes to promote |
| `demotionThreshold` | 2 | Consecutive failures to demote |

### 6. Persistence

Learning state is saved to `~/.claude/artibot/`:

| 파일 | 용도 |
|------|------|
| `~/.claude/artibot/daily-experiences.json` | 일일 경험 로그 (JSON array) |
| `~/.claude/artibot/learning-log.json` | 배치 학습 라운드 기록 |
| `~/.claude/artibot/system1-patterns.json` | 승격된 System 1 패턴 |
| `~/.claude/artibot/transfer-log.json` | 승격/강등 이력 |
| `~/.claude/artibot/evaluations.json` | Self-Rewarding 평가 결과 |
| `~/.claude/artibot/tool-history.json` | 도구 사용 학습 기록 |
| `~/.claude/artibot/patterns/` | 추출된 패턴 디렉토리 |
| `~/.claude/artibot/memory/` | 메모리 저장소 (에러, 컨텍스트, 선호) |

### 7. Integration with Cognitive Routing

The lifelong learning system feeds back into the cognitive router:
- ~~Updated thresholds are loaded at session start~~ — 은퇴: 학습이 라우터 임계값을 갱신·저장하지 않는다(§3 Retired 참조)
- Promoted patterns are available to System 1 immediately
- Demoted patterns are flagged for System 2 re-evaluation
- Transfer history informs meta-cognitive monitoring

## Configuration

Settings in `artibot.config.json` under `learning.lifelong` and `learning.knowledgeTransfer`:

```json
{
  "learning": {
    "lifelong": { "batchSize": 50, "grpoGroupSize": 5 },
    "knowledgeTransfer": { "promotionThreshold": 3, "demotionThreshold": 2 },
    "schedule": { "enabled": false, "nightlyLearner": "3 2 * * *", "driftCheck": "7 6 * * 1" }
  }
}
```

### Automatic Scheduling (CronCreate)

When `learning.schedule.enabled` is `true`, the learning pipeline can be automatically scheduled
within the current Claude Code session via the `CronCreate` tool. Jobs are session-only (in-memory)
and auto-expire after 7 days. See the **scheduled-learning** skill for full setup details.

## Workflow Checklist

Copy this checklist and track progress:

```
Progress:
- [ ] Step 1: Collect routing experiences during session (실제: 라우팅 결정이 아니라 tool·agent·success·error·team·self-evaluation 경험 — §2 참조)
- [ ] Step 2: Batch experiences (size: 50) for GRPO processing (실제: 디스크의 경험 전체를 한 번에 처리 — batchSize 를 읽는 코드 없음)
- [ ] Step 3: Group by domain + complexity range (group size: 5) (실제 그룹 키: type::category, 최소 크기 2)
- [ ] Step 4: Compare System 1 vs System 2 outcomes per group (실제: 그룹 내 composite 랭킹 — System 1 vs 2 비교는 은퇴)
- [ ] Step 5: Update routing threshold (adaptRate * advantage) (retired — skip: adaptThreshold 프로덕션 호출자 0)
- [ ] Step 6: Transfer knowledge — promote/demote between caches
- [ ] Step 7: Persist updated caches to disk
```

## Human Checkpoints

### Checkpoint 1: GRPO 비교 결과 검토 (After Step 4)
> Step 4 의 라이브 형태는 그룹 내 composite 랭킹이다. 아래 Context·Ask 의 "System 1과 System 2의 성공률 비교" 는 은퇴한 설계의 문구이므로, 라이브에서는 그룹별 순위와 `relativeAdvantage` 가 합리적인지로 읽는다(§3 참조). Options 1 의 "Step 5 임계값 조정으로 진행" 은 Step 5 가 은퇴했으므로 Step 6(지식 이전)으로 진행한다.

**Context**: System 1과 System 2의 성공률 비교가 완료된 시점. 그룹별 결과가 합리적인지 확인해야 라우팅 임계값 조정의 신뢰성이 보장된다.
**Ask**: "Step 4 GRPO 그룹 비교 결과를 확인했습니다. **각 그룹의 성공률 차이가 합리적으로 보이나요?**"
**Options**:
1. Accept — 결과가 합리적, Step 5 임계값 조정으로 진행
2. Reset group data — 그룹 데이터를 초기화하고 재집계
**Default**: 1 (데이터가 충분할 경우 GRPO 결과는 신뢰 가능)
**Skippable**: No — 잘못된 비교 결과로 임계값이 왜곡될 수 있음
**Freedom**: LOW

### Checkpoint 2: 임계값 조정 방향 확인 (After Step 5)
> **Retired** — 이 체크포인트가 게이트하던 임계값 조정(Step 5)이 은퇴해(`adaptThreshold` 프로덕션 호출자 0) 현재 발동 조건이 없다. Step 5 를 건너뛰면 도달하지 않는다. 아래 본문은 역사 기록으로 보존한다.

**Context**: adaptRate * advantage 공식으로 라우팅 임계값이 조정된 시점. 조정 방향(올리기/내리기)이 실제 관찰된 패턴과 일치하는지 검증이 필요하다.
**Ask**: "라우팅 임계값이 조정되었습니다. **조정 방향(System 2 비중 증가/감소)이 세션에서 관찰된 패턴과 맞나요?**"
**Options**:
1. Apply — 조정값 적용, Step 6 지식 이전으로 진행
2. Revert adjustment — 이번 조정 취소, 기존 임계값 유지
**Default**: 1 (공식 범위 [-0.1, 0.1]로 클램핑되어 있어 안전)
**Skippable**: No — 잘못된 방향 조정은 라우팅 품질을 누적 저하시킬 수 있음
**Freedom**: LOW

### Checkpoint 3: 승격/강등 결정 검토 (After Step 6)
**Context**: 패턴의 System 1 ↔ System 2 이동 결정이 완료된 시점. 자동 기준(3회 연속 성공/2회 연속 실패)이 맥락에 맞는지 사람의 판단이 필요할 수 있다.
**Ask**: "지식 이전 결정이 생성되었습니다. **각 패턴의 승격/강등/보류 결정이 타당해 보이나요?**"
**Options**:
1. Promote — 해당 패턴을 System 1로 승격
2. Demote — 해당 패턴을 System 2로 강등
3. Hold — 이번 사이클에서는 현재 위치 유지
**Default**: 자동 기준 결과 적용 (임계값 기반 결정이 기본값)
**Skippable**: Yes (기본값 사용) — 자동 기준으로 결정하고 Step 7 퍼시스턴스로 진행
**Freedom**: MEDIUM

## Freedom Levels

| Step | Freedom | Guidance |
|------|:-------:|----------|
| Collect experiences | LOW | Schema is fixed, record all fields |
| Batch processing | LOW | Batch size (50) and group size (5) are configured |
| Group by domain | MEDIUM | Domain classification may require interpretation |
| Compare outcomes | LOW | Success rate calculation is deterministic |
| Update threshold | LOW | Formula is defined, clamped to [-0.1, 0.1] |
| Knowledge transfer | LOW | Promotion (3x) and demotion (2x) thresholds are fixed |
| Persist to disk | LOW | File paths and formats are defined |

> 위 표의 `Update threshold` 행은 은퇴한 단계다(역사 기록). `Group by domain` 은 실제로 `type::category` 그룹이고, `Compare outcomes` 는 라이브에서 그룹 내 composite 랭킹이며 System 1 vs 2 비교가 아니다. `Batch processing` 의 "Batch size (50) and group size (5) are configured" 는 §3 표 아래 주석대로 읽는 코드가 없다.

## Quick Reference

**Learning Cycle**: Collect -> Batch (GRPO) -> Transfer -> Persist
**Promotion**: 3 consecutive System 2 successes -> System 1 cache
**Demotion**: 2 consecutive System 1 failures -> System 2 re-analysis
**Storage**: `~/.claude/artibot/`

## Rationalizations
> 이 절은 참고 자료다 — 아래 변명·반박은 모델이 작업 중 스스로 지름길을 점검하는 데 쓰고, 사용자에게 묻는 질문 목록이나 별도 게이트로 쓰지 않는다. 반박에 비추어 스스로 바로잡을 수 없으면 이 스킬의 Step·Checkpoint 규칙을 따른다.

The following table captures common excuses agents make to skip the discipline of this skill, paired with factual rebuttals.

| Excuse | Rebuttal |
|--------|----------|
| "learning across sessions breaks reproducibility" | reproducibility comes from versioned knowledge stores, not from amnesia — snapshot and replay |
| "GRPO is overkill for my use case" | GRPO is just group-relative comparison; it's the simplest correct way to extract preference signal from rollouts |
| "validated knowledge is stale by the time it transfers" | staleness is managed via freshness scoring; untransferred knowledge has infinite staleness |
| "System 1 to System 2 transfer introduces bugs" | transfer WITH validation catches bugs; transfer is not the risk — untested promotion is |
| "I'll curate the training set manually" | manual curation is where bias enters; automated capture with review gates is more neutral |
