# Learning Architecture Audit Report

## Executive Summary

Artibot의 학습/인지 시스템은 6개 Learning 모듈 + 4개 Cognitive 모듈 + 4개 Hook 스크립트로 구성된 하이브리드 아키텍처이다. 17개 파일, 약 5,200 라인의 코드를 분석한 결과, 전반적으로 잘 설계된 구조이나 다음과 같은 핵심 이슈가 식별되었다.

| 위험도 | 이슈 수 | 요약 |
|--------|---------|------|
| CRITICAL | 3 | GRPO 이중구현, 학습루프 미연결, 설정 파편화 |
| HIGH | 5 | 패턴 저장소 중복, 라우팅 로직 중복, JSON I/O 불일치, Knowledge Transfer 이중 구현, 차단 패턴 중복 |
| MEDIUM | 6 | 유틸리티 함수 중복, 캐시 전략 불일치, 평가 스케일 불일치, 경로 계산 분산, 메모리 캐시 미활용, 비동기/동기 혼재 |
| LOW | 4 | ID 생성 패턴 산재, 상수 하드코딩, 타입 안전성 부족, 테스트 커버리지 0% |

**최우선 개선 항목 3개**:
1. **GRPO 이중구현 통합** - `grpo-optimizer.js`와 `lifelong-learner.js`(+`nightly-learner.js`)에 독립적 GRPO 구현이 3개 존재
2. **학습 루프 자동화 완성** - Collect -> Store 이후 Learn -> Apply -> Evaluate -> Feedback 사이클이 수동 트리거에 의존
3. **Knowledge Transfer 이중구현 통합** - `knowledge-transfer.js`(lib)와 `nightly-learner.js`(hook)에 독립적 S1/S2 전이 로직 존재

---

## 1. Current Architecture Map

### 모듈 관계도

```
                            artibot.config.json
                     ┌────────────┼────────────┐
                     v            v             v
               [cognitive]   [learning]    [hooks]
               ┌─────────┐  ┌──────────┐  ┌──────────────┐
               │ router   │  │ tool-    │  │ tool-tracker  │
               │          │  │ learner  │  │ (PostToolUse) │
               ├──────────┤  ├──────────┤  ├──────────────┤
               │ system1  │──│ memory-  │  │ memory-tracker│
               │          │  │ manager  │  │ (Session*)    │
               ├──────────┤  ├──────────┤  ├──────────────┤
               │ system2  │  │ self-    │  │ cognitive-    │
               │          │  │ evaluator│  │ router        │
               ├──────────┤  ├──────────┤  │(UserPrompt)   │
               │ sandbox  │  │ grpo-    │  ├──────────────┤
               │          │  │ optimizer│  │ nightly-      │
               └─────────┘  ├──────────┤  │ learner       │
                             │ lifelong-│  │ (SessionEnd)  │
                             │ learner  │  └──────────────┘
                             ├──────────┤
                             │knowledge-│
                             │ transfer │
                             ├──────────┤
                             │ index.js │
                             └──────────┘
```

### 데이터 흐름도

```
 [사용자 입력]
      │
      v
 ┌──────────────────────────────────┐
 │  Hook: cognitive-router          │  UserPromptSubmit
 │  (복잡도 분류 + 라우팅 결정)     │
 └──────────┬───────────────────────┘
            │
     ┌──────┴──────┐
     v             v
 [System 1]    [System 2]
  router.js     router.js
  system1.js    system2.js + sandbox.js
     │              │
     │   ┌──────────┘
     v   v
 [도구 실행]
     │
     v
 ┌──────────────────────────────────┐
 │  Hook: tool-tracker              │  PostToolUse
 │  (도구 결과 스코어링 + 기록)     │──> tool-learner.js (recordUsage)
 └──────────────────────────────────┘
     │
     v
 ┌──────────────────────────────────┐
 │  Hook: memory-tracker            │  SessionEnd / Error
 │  (세션 요약 + 에러 패턴 저장)    │──> memory/ 디렉토리 직접 쓰기
 └──────────────────────────────────┘
     │
     v
 ┌──────────────────────────────────┐
 │  Hook: nightly-learner           │  SessionEnd
 │  (배치 학습 + 지식 전이)         │──> artibot-learning/ 디렉토리
 │  독자적 GRPO + Knowledge Transfer │
 └──────────────────────────────────┘
     │
     v                                    !! 연결 안 됨 !!
 ┌──────────────────────────────────┐     ┌──────────────────┐
 │  lifelong-learner.js             │ X── │ knowledge-       │
 │  (배치 학습 파이프라인)          │     │ transfer.js      │
 │  독자적 GRPO + 패턴 추출        │     │ (S2->S1 승격)    │
 └──────────────────────────────────┘     └──────────────────┘

 [저장소 파편화]
   ~/.claude/artibot/
   ├── tool-history.json          (tool-learner.js)
   ├── evaluations.json           (self-evaluator.js)
   ├── grpo-history.json          (grpo-optimizer.js)
   ├── daily-experiences.json     (lifelong-learner.js)
   ├── learning-log.json          (lifelong-learner.js)
   ├── system1-patterns.json      (knowledge-transfer.js)
   ├── transfer-log.json          (knowledge-transfer.js)
   ├── memory/                    (memory-manager.js + memory-tracker.js)
   │   ├── user-preferences.json
   │   ├── project-contexts.json
   │   ├── command-history.json
   │   └── error-patterns.json
   └── patterns/                  (lifelong-learner.js + system1.js)
       ├── tool-patterns.json
       ├── success-patterns.json
       ├── error-patterns.json     <-- memory/error-patterns.json과 중복!
       └── team-patterns.json

   ~/.claude/artibot-learning/     (nightly-learner.js - 완전 독립!)
   ├── experiences.jsonl
   ├── system1-cache.json          <-- system1-patterns.json과 중복!
   ├── system2-cache.json
   ├── transfer-log.json           <-- transfer-log.json과 중복!
   └── thresholds.json
```

---

## 2. Duplication Analysis

### 2.1 GRPO 구현 삼중 중복 (CRITICAL)

| 위치 | 파일:라인 | 기능 | 상태 |
|------|-----------|------|------|
| A | `grpo-optimizer.js:129-163` | `evaluateGroup()` - 규칙 기반 후보 평가 및 랭킹 | 독립 모듈 |
| B | `lifelong-learner.js:273-299` | `grpoRankGroup()` - 경험 기반 GRPO 랭킹 | A와 동일 알고리즘, 다른 가중치 |
| C | `nightly-learner.js:80-123` | `runGRPO()` - 경험 기반 그룹 비교 | A/B와 별도 구현 |

**구체적 중복**:
- `grpo-optimizer.js:138-143`의 규칙 기반 스코어링과 `lifelong-learner.js:274-280`의 경험 스코어링은 동일한 weighted-composite 패턴
- `grpo-optimizer.js:189-195`의 relative-advantage 계산과 `lifelong-learner.js:286-289`의 계산이 동일
- `nightly-learner.js:99-119`는 S1/S2 성공률 비교라는 완전히 다른 GRPO 변종이지만 같은 이름으로 혼동 유발

**영향**: 학습 결과가 3개 독립 저장소에 분산되어 일관성 없는 최적화 결과를 초래

### 2.2 Knowledge Transfer 이중 구현 (CRITICAL)

| 위치 | 파일:라인 | 기능 |
|------|-----------|------|
| A | `knowledge-transfer.js:95-154` | `promoteToSystem1()` - 3연속 성공 + 신뢰도 0.8 조건 |
| B | `nightly-learner.js:128-192` | `runKnowledgeTransfer()` - 동일 로직의 독립 구현 |

**구체적 중복**:
- `knowledge-transfer.js:28-37`의 승격/강등 임계값과 `nightly-learner.js:129-130`의 임계값이 동일하지만 별도 관리
- `knowledge-transfer.js:69-73`의 `system1-patterns.json`과 `nightly-learner.js:132`의 `system1-cache.json`은 동일 목적의 다른 파일
- `knowledge-transfer.js:24`의 `transfer-log.json`과 `nightly-learner.js:134`의 `transfer-log.json`은 다른 디렉토리에 같은 이름

### 2.3 라우팅 로직 이중 구현 (HIGH)

| 위치 | 파일:라인 | 기능 |
|------|-----------|------|
| A | `router.js:119-150` | `classifyComplexity()` - 5요인 가중 복잡도 분류 |
| B | `cognitive-router.js:123-190` | `main()` - 6요인 가중 복잡도 분류 |

**구체적 차이점**:
- `router.js:37-43` 가중치: steps(0.25), domains(0.20), uncertainty(0.20), risk(0.20), novelty(0.15)
- `cognitive-router.js:146-152` 가중치: tokens(0.25), domains(0.20), steps(0.20), ambiguity(0.20), risk(0.15)
- 요인 명칭과 가중치가 다르지만 동일 목적. Hook이 router.js를 호출하지 않고 독자 구현

### 2.4 차단 패턴 중복 (HIGH)

| 위치 | 파일:라인 | 패턴 수 |
|------|-----------|---------|
| A | `sandbox.js:16-62` | 22개 정규식 패턴 |
| B | 외부 `pre-bash.js` (참조만, 실제 파일 미확인) | 별도 관리 |

`sandbox.js:15` 주석에 "Extends the patterns from scripts/hooks/pre-bash.js"라고 명시하지만, 실제로는 독립적으로 정의. 패턴 추가/변경 시 양쪽 모두 수정 필요.

### 2.5 유틸리티 함수 중복 (MEDIUM)

| 함수 | 위치들 |
|------|--------|
| `clamp01()` / `clampScore()` | `tool-learner.js:757`, `grpo-optimizer.js:494`, `lifelong-learner.js:640` |
| `round()` | `tool-learner.js:761`, `lifelong-learner.js:645`, `knowledge-transfer.js:522`, `router.js:500` |
| `tokenize()` / `tokenizeQuery()` | `system1.js:93-100`, `memory-manager.js:202-207` |

### 2.6 에러 패턴 저장소 중복 (HIGH)

| 위치 | 파일 경로 |
|------|-----------|
| A | `memory-manager.js` -> `~/.claude/artibot/memory/error-patterns.json` |
| B | `lifelong-learner.js` -> `~/.claude/artibot/patterns/error-patterns.json` |
| C | `memory-tracker.js` -> `~/.claude/artibot/memory/error-patterns.json` (A와 동일 경로) |

A와 C는 같은 파일을 쓰지만, A는 비동기 `readJsonFile()`/`writeJsonFile()`을 사용하고 C는 동기 `readFileSync()`/`writeFileSync()`를 사용. 동시 접근 시 데이터 손상 위험.

### 2.7 JSON I/O 패턴 불일치 (HIGH)

| 모듈 | I/O 방식 | 라이브러리 |
|------|----------|-----------|
| `tool-learner.js` | `fs.readFile`/`fs.writeFile` (직접) | `node:fs/promises` |
| `memory-manager.js` | `readJsonFile`/`writeJsonFile` (공유) | `../core/file.js` |
| `self-evaluator.js` | `readJsonFile`/`writeJsonFile` (공유) | `../core/file.js` |
| `grpo-optimizer.js` | `readJsonFile`/`writeJsonFile` (공유) | `../core/file.js` |
| `lifelong-learner.js` | `readJsonFile`/`writeJsonFile` (공유) | `../core/file.js` |
| `knowledge-transfer.js` | `readJsonFile`/`writeJsonFile` (공유) | `../core/file.js` |
| `memory-tracker.js` (hook) | `readFileSync`/`writeFileSync` (직접) | `node:fs` |
| `nightly-learner.js` (hook) | `readFileSync`/`writeFileSync` (직접) | `node:fs` |

`tool-learner.js`는 유일하게 `core/file.js`를 사용하지 않고 직접 `node:fs/promises` 사용. Hook 스크립트는 동기 I/O를 사용하는데, 이는 hook 실행 컨텍스트의 제약 때문으로 추정되나 `memory-manager.js`(비동기)와 같은 파일을 동시에 건드릴 수 있어 경합 조건 발생 가능.

---

## 3. Data Flow Bottlenecks

### 3.1 직렬 파일 I/O 연쇄 (HIGH)

**현재 상태**: `lifelong-learner.js:77-83`의 `collectExperience()`는 호출될 때마다 파일 전체를 로드->수정->저장한다.

```
collectDailyExperiences() 호출 시:
  tool 경험 N개 x (loadExperiences() + writeJsonFile())  // N회 디스크 I/O
  error 경험 M개 x (loadExperiences() + writeJsonFile())  // M회 디스크 I/O
  success 경험 K개 x (loadExperiences() + writeJsonFile()) // K회 디스크 I/O
  team 경험 1개 x (loadExperiences() + writeJsonFile())    // 1회 디스크 I/O
  총: (N+M+K+1) * 2 회 디스크 I/O
```

`lifelong-learner.js:101-173`의 `collectDailyExperiences()`는 각 경험을 개별적으로 `collectExperience()`에 전달하여 매번 전체 파일을 읽고 쓴다. 세션에서 도구 20개, 에러 5개, 완료 태스크 3개가 있으면 56회 파일 I/O 발생.

**제안**: 배치 수집 함수로 변경하여 1회 로드 + N건 추가 + 1회 저장으로 최적화.

### 3.2 System 1 Cold Start 지연

**현재 상태**: `system1.js:255-270`에서 `fastResponse()`는 최초 호출 시 `warmCache()`를 트리거한다.

```
첫 번째 fastResponse() 호출:
  warmCache() -> listFiles() -> 각 파일 readJsonFile() -> 패턴 정렬
  예상 소요: 50-500ms (패턴 파일 수에 따라)
  목표 지연: <100ms
```

`system1.js:400-426`의 `warmCache()`는 `MAX_WARM_CACHE_PATTERNS=200`개까지 파일을 읽으므로 최초 응답이 목표 100ms를 초과할 수 있다.

**제안**: 플러그인 초기화(`index.js:88-102`의 `initLearning()`)에서 `warmCache()`도 함께 호출.

### 3.3 Memory Search 병목

**현재 상태**: `memory-manager.js:257-283`의 `searchMemory()`는 4개 저장소 파일을 순차 로드한다.

```
searchMemory() 호출 경로:
  storeKeys = ['userPreferences', 'projectContexts', 'commandHistory', 'errorPatterns']
  for each storeKey:
    loadStore(storeKey) -> readJsonFile() -> 순회하며 scoreEntry()
  총: 4회 파일 I/O + 모든 엔트리 순회
```

`system1.js:509-524`의 `_searchMemoryCached()`가 캐시를 제공하지만, TTL이 5분(`MEMORY_CACHE_TTL`)이라 캐시 미스 시 매번 4파일 전부를 읽는다.

**제안**: 통합 인덱스 파일 또는 인메모리 인덱스 캐시 도입.

### 3.4 학습 파이프라인 미연결 (CRITICAL)

```
현재:
  [수집] tool-tracker ──────> tool-history.json     ✅ 자동
  [수집] memory-tracker ────> memory/*.json          ✅ 자동
  [저장] collectExperience -> daily-experiences.json  ⚠️ 수동 호출 필요
  [학습] batchLearn() ──────> patterns/*.json         ⚠️ 수동 호출 필요
  [적용] suggestTool() ─────> 추천 결과              ✅ 자동 (호출 시)
  [평가] evaluateResult() ──> evaluations.json       ⚠️ 수동 호출 필요
  [전이] hotSwap() ─────────> system1-patterns.json   ⚠️ 수동 호출 필요

  nightly-learner.js(hook)는 별도 파이프라인:
  [수집] experiences.jsonl                            ⚠️ hook 데이터에 의존
  [학습] runGRPO() ─────────> thresholds.json         ✅ 자동 (SessionEnd)
  [전이] runKnowledgeTransfer > system1-cache.json     ✅ 자동 (SessionEnd)
```

`index.js:111-141`의 `shutdownLearning()`이 파이프라인을 연결하려 하지만, 이 함수가 실제로 호출되는 지점이 보이지 않는다. `nightly-learner.js` Hook은 별도로 동작하면서 `lifelong-learner.js`를 호출하지 않는다.

---

## 4. Hybrid Integration Opportunities

### 4.1 GRPO 통합 (영향도: CRITICAL, 난이도: 중)

**현재**: 3개 독립 GRPO 구현
- `grpo-optimizer.js`: 전략/팀 최적화용 범용 GRPO
- `lifelong-learner.js:273-299`: 경험 기반 내부 GRPO
- `nightly-learner.js:80-123`: Hook 전용 경량 GRPO

**제안**: `grpo-optimizer.js`를 단일 GRPO 엔진으로 통합
- `lifelong-learner.js`가 `grpo-optimizer.evaluateGroup()`을 호출하도록 리팩터링
- `nightly-learner.js`는 `lifelong-learner.batchLearn()`을 호출하거나, `grpo-optimizer`를 직접 import
- 가중치(`EXPERIENCE_WEIGHTS`, `DEFAULT_RULES`, `TEAM_RULES`)를 `artibot.config.json`으로 추출

**예상 효과**: 약 120라인 코드 제거, GRPO 결과 일관성 확보, 설정 중앙화
**구현 난이도**: 중 (인터페이스 호환성 확인 필요)

### 4.2 Knowledge Transfer 통합 (영향도: CRITICAL, 난이도: 중)

**현재**: 2개 독립 S1/S2 전이 구현
- `knowledge-transfer.js`: 완전한 승격/강등 + hot-swap + 캐시 관리
- `nightly-learner.js:128-192`: 간이 승격/강등 (별도 저장소)

**제안**: `nightly-learner.js`가 `knowledge-transfer.js`의 API를 사용하도록 변경
- `nightly-learner.js`의 `runKnowledgeTransfer()`를 제거
- 대신 `knowledge-transfer.hotSwap()`을 호출
- `~/.claude/artibot-learning/` 디렉토리를 `~/.claude/artibot/`으로 통합

**예상 효과**: 약 65라인 코드 제거, 저장소 파편화 해소, S1 캐시 일원화
**구현 난이도**: 중 (Hook의 동기 I/O -> 비동기 I/O 전환 필요)

### 4.3 Cognitive Router + Hook 통합 (영향도: HIGH, 난이도: 하)

**현재**:
- `router.js`: 5요인 복잡도 분류 + 적응형 임계값 + 통계
- `cognitive-router.js` (hook): 6요인 독자 분류 + config 기반 임계값

**제안**: Hook이 `router.js`의 `classifyComplexity()`를 직접 호출
- `cognitive-router.js`의 독자 복잡도 계산 로직을 제거
- Hook에서 `import { classifyComplexity } from '...router.js'` 사용
- Hook 고유 기능(Think 플래그 감지, stdout 출력)만 유지

**예상 효과**: 약 70라인 코드 제거, 분류 기준 일원화, 적응형 임계값 활용
**구현 난이도**: 하 (import 경로 변경 + 인터페이스 매핑)

### 4.4 Memory Manager + System 1 패턴 캐시 통합 (영향도: MEDIUM, 난이도: 상)

**현재**:
- `memory-manager.js`: keyword RAG 검색 (4개 저장소 파일)
- `system1.js`: 패턴 매칭 캐시 (patterns/ 디렉토리) + 메모리 검색 캐시

`system1.js:509-524`의 `_searchMemoryCached()`는 `memory-manager.searchMemory()`를 래핑하여 5분 TTL 캐시를 추가한다. 이는 memory-manager 자체에 캐시가 없기 때문.

**제안**: `memory-manager.js`에 자체 인메모리 인덱스 캐시 추가
- 파일 로드 시 태그 인덱스를 빌드하여 인메모리 보관
- `system1.js`의 `_memoryCache`를 제거하고 memory-manager의 캐시에 의존
- 패턴 파일과 메모리 저장소의 포맷 통일 검토

**예상 효과**: 메모리 검색 10-50x 가속, 캐시 관리 일원화
**구현 난이도**: 상 (memory-manager 내부 구조 변경 필요)

### 4.5 tool-learner GRPO + grpo-optimizer 통합 (영향도: HIGH, 난이도: 중)

**현재**:
- `tool-learner.js:320-524`: 자체 GRPO 그룹 비교 + 누적 스코어 관리
- `grpo-optimizer.js`: 범용 GRPO 엔진

`tool-learner.js`는 `grpo-optimizer.js`와 독립적으로 GRPO를 구현한다. 두 모듈의 GRPO 가중치가 다르다:
- `tool-learner.js:40-45`: success(0.35), speed(0.25), accuracy(0.25), brevity(0.15)
- `grpo-optimizer.js:29-35`: exitCode, errorFree, speed, brevity, sideEffects (규칙 기반)

**제안**: `tool-learner.js`의 GRPO 부분을 `grpo-optimizer.js`에 위임
- `tool-learner.js`에서 `recordGroupComparison()`, `suggestToolCandidates()` 등 GRPO 관련 함수를 분리
- `grpo-optimizer.js`에 커스텀 규칙 세트를 전달하는 방식으로 통합
- `tool-history.json`의 `grpoGroups`/`grpoScores` 필드를 `grpo-history.json`으로 마이그레이션

**예상 효과**: 약 200라인 코드 제거, GRPO 알고리즘 일원화
**구현 난이도**: 중 (데이터 마이그레이션 + API 호환성)

---

## 5. Learning Loop Completeness

### 6단계 사이클 분석 매트릭스

| 단계 | 담당 모듈 | 자동화 | 연결 상태 | 문제점 |
|------|-----------|--------|-----------|--------|
| **1. Collect** | `tool-tracker.js` + `memory-tracker.js` | 자동 (Hook) | Collect -> Store 연결 | tool-tracker는 tool-learner.recordUsage()만 호출. lifelong-learner.collectExperience()로의 연결 없음 |
| **2. Store** | `tool-learner.js` + `memory-manager.js` | 자동 | Store -> Learn 미연결 | 2개 독립 저장소 (tool-history.json + memory/*.json). lifelong-learner의 daily-experiences.json으로 데이터가 흐르지 않음 |
| **3. Learn** | `lifelong-learner.js` + `grpo-optimizer.js` | **수동** | Learn -> Apply 부분 연결 | `batchLearn()`이 자동 호출되지 않음. `shutdownLearning()`이 호출 지점 미확인. `nightly-learner.js`만 SessionEnd Hook으로 자동화됨 |
| **4. Apply** | `system1.js` (patternMatch) + `tool-learner.js` (suggestTool) | 자동 (쿼리 시) | Apply -> Evaluate 미연결 | 패턴/도구 추천 결과가 사용되었는지 추적하지 않음 |
| **5. Evaluate** | `self-evaluator.js` | **수동** | Evaluate -> Feedback 미연결 | `evaluateResult()`가 자동 호출되지 않음. 평가 결과가 학습 루프에 피드백되지 않음 |
| **6. Feedback** | `knowledge-transfer.js` (hotSwap) + `router.js` (adaptThreshold) | **수동** | Feedback -> Collect 미연결 | `hotSwap()`과 `adaptThreshold()`가 평가 결과에 반응하지 않음 |

### 끊어진 링크 식별

```
1. tool-tracker ─X─> lifelong-learner.collectExperience()
   현재: tool-tracker는 tool-learner.recordUsage()만 호출
   결과: 도구 경험이 lifelong learning 파이프라인에 흘러가지 않음

2. Store ─X─> batchLearn()
   현재: 경험 데이터가 쌓이지만 배치 학습이 자동 트리거되지 않음
   결과: patterns/ 디렉토리가 업데이트되지 않아 System 1 개선 없음

3. Apply ─X─> evaluateResult()
   현재: 패턴/도구 추천 후 결과 평가가 없음
   결과: self-evaluator가 데이터를 수집하지 못해 개선 제안이 빈약

4. Evaluate ─X─> adaptThreshold() / hotSwap()
   현재: 평가 결과가 라우터 임계값이나 패턴 전이에 영향을 주지 않음
   결과: 시스템이 경험으로부터 학습하지 못함

5. nightly-learner ─X─> lifelong-learner / knowledge-transfer
   현재: Hook이 lib 모듈을 호출하지 않고 독자 구현 사용
   결과: 2개 독립 학습 파이프라인이 서로 모르는 상태로 동작
```

### 학습 효과 정량 측정 가능성

| 측정 항목 | 구현 여부 | 위치 | 비고 |
|-----------|----------|------|------|
| 도구 성공률 추이 | O | `tool-learner.js:240-248` getToolStats() | 집계 데이터 제공 |
| 평가 점수 추이 | O | `self-evaluator.js:224-257` getLearningTrends() | 윈도우 기반 추이 |
| GRPO 라운드 통계 | O | `grpo-optimizer.js:429-442` getGrpoStats() | 라운드/가중치 데이터 |
| 패턴 추출 추이 | O | `lifelong-learner.js:493-562` getLearningSummary() | 학습 로그 분석 |
| S1/S2 라우팅 통계 | O | `router.js:262-314` getRoutingStats() | 성공률/추세 제공 |
| S1 패턴 전이 통계 | O | `knowledge-transfer.js:452-477` getTransferStats() | 승격/강등 카운트 |
| **종합 학습 효과** | **X** | 없음 | 모든 지표를 통합하는 대시보드/보고서 없음 |

---

## 6. Configuration Consolidation

### 현재 설정 분포

```yaml
# artibot.config.json (중앙 설정)
cognitive:
  router.threshold: 0.4
  router.adaptRate: 0.05     # 사용처 없음! router.js의 ADAPT_STEP=0.02와 불일치
  system1.maxLatency: 100     # 사용처 없음! system1.js의 PATTERN_CACHE_TTL 등은 하드코딩
  system1.minConfidence: 0.6  # 사용처 없음! system1.js의 ESCALATION_THRESHOLD=0.6은 하드코딩
  system2.maxRetries: 3       # 사용처 없음! system2.js의 MAX_RETRIES=3은 하드코딩
  system2.sandboxEnabled: true # 사용처 없음!
learning:
  lifelong.batchSize: 50      # nightly-learner.js에서만 사용
  lifelong.grpoGroupSize: 5   # nightly-learner.js에서만 사용
  knowledgeTransfer.promotionThreshold: 3  # nightly-learner.js에서만 사용
  knowledgeTransfer.demotionThreshold: 2   # nightly-learner.js에서만 사용
```

### 하드코딩된 설정값 목록 (config로 이동 필요)

| 파일:라인 | 상수 | 현재 값 | 비고 |
|-----------|------|---------|------|
| `tool-learner.js:21` | MAX_RECORDS_PER_KEY | 200 | 컨텍스트당 최대 기록 |
| `tool-learner.js:27` | DECAY_HALF_LIFE_MS | 7일 | 시간 감쇠 반감기 |
| `tool-learner.js:34` | GRPO_LEARNING_RATE | 0.1 | GRPO 학습률 |
| `tool-learner.js:37` | MAX_GRPO_GROUPS_PER_KEY | 50 | GRPO 그룹 최대 수 |
| `router.js:18` | DEFAULT_THRESHOLD | 0.4 | config에도 0.4 있으나 미연결 |
| `router.js:25` | ADAPT_STEP | 0.02 | config의 adaptRate(0.05)와 불일치 |
| `router.js:31` | SUCCESS_STREAK_TRIGGER | 5 | 연속 성공 트리거 |
| `system1.js:32` | ESCALATION_THRESHOLD | 0.6 | config의 minConfidence와 동일하나 미연결 |
| `system1.js:35` | MAX_WARM_CACHE_PATTERNS | 200 | 최대 캐시 패턴 수 |
| `system1.js:38-44` | PATTERN/MEMORY/TOOL_CACHE_TTL | 10m/5m/5m | 캐시 TTL |
| `system2.js:28` | MAX_RETRIES | 3 | config와 동일하나 미연결 |
| `system2.js:42` | TEAM_THRESHOLDS.teamRecommendation | 0.6 | 팀 추천 임계값 |
| `self-evaluator.js:13` | MAX_EVALUATIONS | 500 | 최대 평가 기록 |
| `knowledge-transfer.js:28` | PROMOTION_THRESHOLD | 3 | config와 동일하나 미연결 |
| `knowledge-transfer.js:31` | CONFIDENCE_THRESHOLD | 0.8 | config에 없음 |
| `knowledge-transfer.js:34` | DEMOTION_FAILURE_THRESHOLD | 2 | config와 동일하나 미연결 |
| `lifelong-learner.js:26` | MAX_EXPERIENCES | 1000 | 최대 경험 수 |
| `memory-manager.js:31` | MAX_COMMAND_HISTORY | 500 | memory-tracker에도 동일값 하드코딩 |
| `memory-manager.js:32` | MAX_ERROR_PATTERNS | 200 | memory-tracker에도 동일값 하드코딩 |

### 제안: 통합 설정 구조

```json
{
  "cognitive": {
    "router": {
      "threshold": 0.4,
      "adaptStep": 0.02,
      "successStreakTrigger": 5,
      "thresholdBounds": { "min": 0.2, "max": 0.7 },
      "maxHistory": 500
    },
    "system1": {
      "escalationThreshold": 0.6,
      "maxWarmCachePatterns": 200,
      "cacheTTL": {
        "pattern": 600000,
        "memory": 300000,
        "tool": 300000
      },
      "minPatternMatchScore": 0.3
    },
    "system2": {
      "maxRetries": 3,
      "sandboxEnabled": true,
      "teamThreshold": 0.6,
      "platoonThreshold": 0.85,
      "sandboxTimeoutMs": 30000,
      "sandboxMaxLifetimeMs": 300000
    }
  },
  "learning": {
    "toolLearner": {
      "maxRecordsPerKey": 200,
      "decayHalfLifeDays": 7,
      "minSamples": 3,
      "grpoLearningRate": 0.1,
      "maxGrpoGroupsPerKey": 50
    },
    "memory": {
      "maxCommandHistory": 500,
      "maxErrorPatterns": 200,
      "maxSummaryLength": 500,
      "ttl": {
        "session": 14400000,
        "shortTerm": 604800000,
        "longTerm": 7776000000
      }
    },
    "evaluator": {
      "maxEvaluations": 500,
      "dimensions": {
        "accuracy": 0.35,
        "completeness": 0.25,
        "efficiency": 0.20,
        "satisfaction": 0.20
      }
    },
    "lifelong": {
      "maxExperiences": 1000,
      "batchSize": 50,
      "grpoGroupSize": 5,
      "minGroupSize": 2,
      "experienceWeights": {
        "success": 0.35,
        "speed": 0.25,
        "errorRate": 0.25,
        "resourceEfficiency": 0.15
      }
    },
    "knowledgeTransfer": {
      "promotionThreshold": 3,
      "confidenceThreshold": 0.8,
      "demotionFailureThreshold": 2,
      "demotionErrorRateThreshold": 0.2,
      "maxTransferLog": 200
    },
    "pruning": {
      "retentionDays": 90,
      "maxLogEntries": 200
    }
  }
}
```

---

## 7. Upgrade Roadmap

| Priority | Item | Impact | Effort | Phase |
|----------|------|--------|--------|-------|
| P0 | nightly-learner Hook이 lib 모듈을 호출하도록 통합 | CRITICAL - 학습 파이프라인 일원화 | 3-5일 | 단기 (1-2주) |
| P0 | 설정값 하드코딩 -> config 참조로 변경 | CRITICAL - config.json이 실제로 사용되도록 | 2-3일 | 단기 (1-2주) |
| P0 | cognitive-router Hook이 router.js를 호출하도록 통합 | HIGH - 라우팅 로직 일원화 | 1-2일 | 단기 (1-2주) |
| P1 | lifelong-learner의 GRPO를 grpo-optimizer에 위임 | HIGH - GRPO 일원화 | 3-5일 | 단기 (1-2주) |
| P1 | tool-learner의 GRPO를 grpo-optimizer에 위임 | HIGH - GRPO 완전 통합 | 5-7일 | 중기 (1-2달) |
| P1 | tool-tracker -> lifelong-learner 연결 추가 | HIGH - 수집 파이프라인 완성 | 2-3일 | 중기 (1-2달) |
| P1 | 공유 유틸리티 모듈 추출 (clamp, round, tokenize) | MEDIUM - 코드 중복 제거 | 1-2일 | 중기 (1-2달) |
| P2 | collectDailyExperiences 배치 I/O 최적화 | HIGH - 성능 56x -> 2x I/O 감소 | 2-3일 | 중기 (1-2달) |
| P2 | memory-manager에 인메모리 인덱스 캐시 추가 | MEDIUM - 검색 성능 개선 | 3-5일 | 중기 (1-2달) |
| P2 | 저장소 경로 통합 (artibot-learning/ -> artibot/) | MEDIUM - 파편화 해소 | 2-3일 | 중기 (1-2달) |
| P2 | 에러 패턴 저장소 통합 (memory/ vs patterns/) | MEDIUM - 데이터 일관성 | 2-3일 | 중기 (1-2달) |
| P2 | self-evaluator 자동 호출 파이프라인 구축 | HIGH - 평가 루프 완성 | 5-7일 | 중기 (1-2달) |
| P3 | initLearning()에서 warmCache() 호출 추가 | LOW - Cold start 해소 | 0.5일 | 단기 (1-2주) |
| P3 | Hook 스크립트 I/O 통일 (sync -> async 또는 lock) | MEDIUM - 경합 조건 방지 | 3-5일 | 장기 (3-6달) |
| P3 | 종합 학습 효과 대시보드 구축 | MEDIUM - 관측성 확보 | 5-7일 | 장기 (3-6달) |
| P3 | 학습 데이터 export/import (이식성) | LOW - 환경 간 지식 전달 | 3-5일 | 장기 (3-6달) |
| P3 | 패턴 수 증가 시 인덱싱 (B-tree 또는 inverted index) | LOW - 확장성 대비 | 7-10일 | 장기 (3-6달) |
| P3 | 단위 테스트 작성 (현재 0% -> 80% 목표) | HIGH - 리팩터링 안전망 | 10-15일 | 장기 (3-6달) |

---

## 8. Recommended Architecture v2.0

### 최적화된 학습 아키텍처

```
                          artibot.config.json (SINGLE SOURCE OF TRUTH)
                                    │
                     ┌──────────────┼──────────────┐
                     v              v               v
              [cognitive/]    [learning/]       [hooks/]
              ┌──────────┐   ┌───────────┐   ┌────────────────┐
              │ router   │   │ core/     │   │ tool-tracker   │─┐
              │          │<──│  grpo     │   │ (PostToolUse)  │ │
              ├──────────┤   │  scoring  │   ├────────────────┤ │
              │ system1  │<──│  storage  │   │ session-mgr    │ │
              │          │   │  utils    │   │ (Session*)     │ │
              ├──────────┤   ├───────────┤   ├────────────────┤ │
              │ system2  │   │ tool-     │<──│ cognitive-     │ │
              │          │   │ learner   │   │ router         │ │
              ├──────────┤   ├───────────┤   │ (UserPrompt)   │ │
              │ sandbox  │   │ memory-   │   └────────────────┘ │
              │          │   │ manager   │                      │
              └──────────┘   ├───────────┤                      │
                             │ evaluator │<─────────────────────┘
                             ├───────────┤         │
                             │ lifelong  │<────────┘
                             │ pipeline  │ (통합 파이프라인)
                             ├───────────┤
                             │ knowledge │
                             │ transfer  │
                             └───────────┘
```

### 통합 모듈 구조

```
plugins/artibot/lib/
├── learning/
│   ├── core/                    [NEW] 공유 유틸리티 추출
│   │   ├── grpo-engine.js       현재 grpo-optimizer.js 기반 통합 GRPO 엔진
│   │   ├── scoring.js           clamp01, round, computeWeighted 등
│   │   ├── storage.js           통합 JSON I/O + 파일 경로 관리
│   │   └── config-loader.js     artibot.config.json에서 학습 설정 로드
│   │
│   ├── tool-learner.js          GRPO 부분을 core/grpo-engine.js에 위임
│   ├── memory-manager.js        인메모리 인덱스 캐시 추가
│   ├── self-evaluator.js        자동 평가 트리거 인터페이스 추가
│   ├── lifelong-pipeline.js     [RENAME] lifelong-learner + nightly-learner 통합
│   ├── knowledge-transfer.js    기존 유지 (nightly-learner 로직 흡수)
│   └── index.js                 통합 초기화 + 셧다운 + 학습 사이클
│
├── cognitive/
│   ├── router.js                config 참조, adaptive threshold 강화
│   ├── system1.js               memory-manager 캐시에 의존
│   ├── system2.js               config 참조
│   ├── sandbox.js               차단 패턴 공유 모듈에서 import
│   └── index.js                 기존 유지
│
scripts/hooks/
├── tool-tracker.js              tool-learner + lifelong-pipeline.collectExperience() 호출
├── session-manager.js           [RENAME] memory-tracker -> session lifecycle 통합 관리
├── cognitive-router.js          router.js의 classifyComplexity() 호출
└── (nightly-learner.js 제거)    lifelong-pipeline에 흡수
```

### 통합 데이터 흐름

```
[사용자 입력]
     │
     v
 cognitive-router.js (Hook)
     │ router.classifyComplexity() 호출
     v
 ┌───────┬────────┐
 │ S1    │  S2    │
 │system1│system2 │
 └───┬───┴───┬────┘
     └───┬───┘
         v
 [도구 실행]
     │
     v
 tool-tracker.js (Hook) ─────────────────────────────┐
     │                                                │
     ├─> tool-learner.recordUsage()                   │
     │   (도구 성공률 기록)                           │
     │                                                v
     └─> lifelong-pipeline.collectExperience()   self-evaluator
         (경험 수집 - 자동)                       .evaluateResult()
                                                  (태스크 완료 시 자동)
                                                       │
 session-manager.js (SessionEnd Hook) ────────────────┘
     │
     ├─> memory-manager.summarizeSession()
     │   (세션 요약 저장)
     │
     ├─> lifelong-pipeline.batchLearn()
     │   (배치 학습 - grpo-engine 사용)
     │   ├── patterns/ 업데이트
     │   └── evaluator 피드백 반영
     │
     ├─> knowledge-transfer.hotSwap()
     │   (S2->S1 패턴 승격/강등)
     │
     └─> router.adaptThreshold()
         (학습 결과 기반 임계값 조정)

 [저장소 통합]
   ~/.claude/artibot/           <-- 단일 루트
   ├── config-cache.json        (설정 캐시)
   ├── tool-history.json        (tool-learner)
   ├── evaluations.json         (self-evaluator)
   ├── grpo-state.json          (통합 GRPO 상태)
   ├── experiences.json         (lifelong - JSON, 더 이상 JSONL 아님)
   ├── learning-log.json        (lifelong 학습 로그)
   ├── system1-patterns.json    (knowledge-transfer)
   ├── transfer-log.json        (knowledge-transfer)
   ├── thresholds.json          (router 적응형 임계값 영속화)
   ├── memory/                  (memory-manager)
   │   ├── user-preferences.json
   │   ├── project-contexts.json
   │   ├── command-history.json
   │   └── error-patterns.json
   └── patterns/                (lifelong 학습 추출 패턴)
       ├── tool-patterns.json
       ├── success-patterns.json
       └── team-patterns.json
```

### 완전한 학습 루프 (v2.0)

```
  ┌─────────────────────────────────────────────────────┐
  │                                                     │
  v                                                     │
[1. Collect]                                            │
  tool-tracker + session-manager (자동, Hook)            │
  -> tool-learner.recordUsage()                         │
  -> lifelong-pipeline.collectExperience()              │
  -> memory-manager.saveMemory()                        │
  │                                                     │
  v                                                     │
[2. Store]                                              │
  tool-history.json + experiences.json + memory/         │
  (통합 저장소, core/storage.js 경유)                    │
  │                                                     │
  v                                                     │
[3. Learn] (SessionEnd 자동 트리거)                     │
  lifelong-pipeline.batchLearn()                        │
  -> core/grpo-engine.evaluateGroup() (통합 GRPO)       │
  -> patterns/ 추출 + grpo-state.json 업데이트          │
  │                                                     │
  v                                                     │
[4. Apply] (다음 세션 자동)                             │
  system1.fastResponse() -> patternMatch() (개선된 패턴) │
  tool-learner.suggestTool() (학습된 도구 추천)          │
  router.classifyComplexity() (적응된 임계값)            │
  │                                                     │
  v                                                     │
[5. Evaluate] (태스크 완료 시 자동)                     │
  self-evaluator.evaluateResult()                       │
  -> evaluations.json 업데이트                          │
  -> 약점 차원 식별                                     │
  │                                                     │
  v                                                     │
[6. Feedback] (SessionEnd 자동)                         │
  knowledge-transfer.hotSwap()                          │
  -> S2 패턴 중 고성과 -> S1 승격                       │
  -> S1 패턴 중 실패 -> S1 강등                         │
  router.adaptThreshold()                               │
  -> 평가 결과 기반 임계값 조정                         │
  -> thresholds.json 영속화                             │
  │                                                     │
  └─────────────────────────────────────────────────────┘
         다음 세션에서 개선된 패턴/임계값으로 동작
```

### v2.0 마이그레이션 단계

1. **Phase 1 (단기, 1-2주)**: 설정 연결 + 라우팅 통합
   - config loader 모듈 작성, 하드코딩 상수를 config 참조로 변경
   - cognitive-router Hook이 router.js를 호출하도록 수정
   - initLearning()에 warmCache() 추가

2. **Phase 2 (중기, 1-2달)**: GRPO + Knowledge Transfer 통합
   - core/grpo-engine.js 추출, lifelong-learner/tool-learner에서 사용
   - nightly-learner.js 로직을 lifelong-pipeline.js로 흡수
   - Knowledge Transfer 이중구현 통합
   - 저장소 경로 통합 + 마이그레이션 스크립트

3. **Phase 3 (장기, 3-6달)**: 학습 루프 완성 + 관측성
   - tool-tracker -> collectExperience 연결
   - self-evaluator 자동 호출 파이프라인
   - adaptThreshold 영속화 + 평가 기반 피드백
   - 종합 학습 대시보드 + 단위 테스트

---

*Audited on: 2026-02-19*
*Files analyzed: 17 (5,200+ lines)*
*Architecture version: Artibot v1.3.0*
