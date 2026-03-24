# Artibot v1.13.0 상세 기능 변경 설명서

**릴리즈 일자**: 2026-03-24
**총 변경 규모**: 신규 기능 8개, 보안 변경 1개, 버그 수정 2개, 테스트 +157개

---

## 한눈에 보기

| 기능 | 한줄 설명 |
|------|-----------|
| 스마트 플레이북 | 작업 순서를 자동으로 정해주고, 동시에 할 수 있는 일은 알아서 병렬로 처리합니다 |
| 처리 속도 향상 | 내부 처리 과정에서 독립적인 작업을 동시에 실행해서 응답이 더 빨라졌습니다 |
| 팀원 작업 격리 | 팀 모드에서 각 팀원이 별도 공간에서 작업하므로 파일 충돌이 사라집니다 |
| 자동 학습 예약 | 매일 새벽에 자동으로 학습하도록 예약할 수 있어서, 쓸수록 더 똑똑해집니다 |
| 독립 실행 | Claude Code 없이도 터미널에서 `artibot` 명령어로 바로 사용할 수 있습니다 |
| 중국어 지원 | 이제 중국어로도 명령할 수 있습니다 (일본어 키워드도 대폭 추가) |
| 필요한 것만 로드 | 90개 넘는 스킬을 전부 불러오지 않고, 필요한 것만 골라서 로드합니다 |
| 품질 검증 강화 | 자체 테스트 시나리오가 5개에서 8개로 늘고, 실행 시간과 메모리 측정이 추가되었습니다 |
| 보안 강화 | 학습 데이터가 외부로 나가지 않도록 로컬 서버만 허용하는 보안 장치가 추가되었습니다 |

자세한 기술 내용은 아래 각 섹션을 참고하세요.

---

## 목차

1. [개요](#1-개요)
2. [신규 기능 상세](#2-신규-기능-상세)
   - [2.1 Playbook DAG 시스템](#21-playbook-dag-시스템)
   - [2.2 미들웨어 병렬 실행](#22-미들웨어-병렬-실행)
   - [2.3 Worktree 격리 모드](#23-worktree-격리-모드)
   - [2.4 CronCreate 학습 스케줄링](#24-croncreate-학습-스케줄링)
   - [2.5 Artibot CLI Standalone](#25-artibot-cli-standalone)
   - [2.6 다국어 Intent 확장](#26-다국어-intent-확장)
   - [2.7 스킬 Lazy Loading](#27-스킬-lazy-loading)
   - [2.8 Eval 파이프라인 강화](#28-eval-파이프라인-강화)
3. [보안 변경](#3-보안-변경)
4. [버그 수정](#4-버그-수정)
5. [테스트 추가](#5-테스트-추가)
6. [설정 변경 요약 테이블](#6-설정-변경-요약-테이블)

---

## 1. 개요

v1.13.0은 4-Phase 구조로 개발되었습니다:

| Phase | 내용 | 주요 변경 |
|-------|------|-----------|
| Phase 1 | 런타임 파이프라인 | 미들웨어 병렬 실행, DAG 플레이북, Eval 강화 |
| Phase 2 | 인텔리전스 확장 | 다국어 Intent (zh 추가), 스킬 Lazy Loading |
| Phase 3 | 인프라/도구 | CLI Standalone, CronCreate 스케줄링, Worktree 격리 |
| Phase 4 | 보안/안정성 | Swarm DATA POLICY 수정, Korean Path 버그, hooks.json 동기화 |

---

## 2. 신규 기능 상세

### 2.1 Playbook DAG 시스템

**Before**: 플레이북이 단순 문자열 체인으로만 정의되어 병렬 실행 표현이 불가능했습니다.

```
"feature": "[leader] plan -> [council] design -> [swarm] implement -> [council] review -> [leader] merge"
```

모든 단계가 순차 실행되며, `impl-fe`와 `impl-be`를 동시에 실행하는 것이 불가능했습니다.

**After**: DAG(Directed Acyclic Graph) 노드/엣지 구조로 `dependsOn`, `parallel` 속성을 지원합니다.

```json
{
  "feature": {
    "nodes": [
      { "id": "plan", "action": "plan", "pattern": "leader", "agent": "planner" },
      { "id": "design", "action": "design", "pattern": "council", "agent": "architect", "dependsOn": ["plan"] },
      { "id": "impl-fe", "action": "implement", "pattern": "swarm", "agent": "frontend-developer", "parallel": true, "dependsOn": ["design"] },
      { "id": "impl-be", "action": "implement", "pattern": "swarm", "agent": "backend-developer", "parallel": true, "dependsOn": ["design"] },
      { "id": "review", "action": "review", "pattern": "council", "agent": "code-reviewer", "dependsOn": ["impl-fe", "impl-be"] },
      { "id": "merge", "action": "merge", "pattern": "leader", "dependsOn": ["review"] }
    ]
  }
}
```

이 예시에서 `impl-fe`와 `impl-be`는 `design` 완료 후 **동시에** 실행되고, `review`는 두 구현이 **모두** 완료된 후에 실행됩니다.

#### DAG 노드 속성

| 속성 | 타입 | 필수 | 설명 |
|------|------|------|------|
| `id` | string | O | 노드 고유 식별자 |
| `action` | string | O | 수행할 작업 (plan, implement, review 등) |
| `pattern` | string | - | 오케스트레이션 패턴 (leader, council, swarm, pipeline, watchdog) |
| `agent` | string | - | 담당 에이전트 이름 |
| `parallel` | boolean | - | 동일 레벨 형제 노드와 병렬 실행 여부 |
| `dependsOn` | string[] | - | 선행 완료 필요 노드 ID 배열 |
| `condition` | string | - | 조건부 분기 표현식 (예약) |

#### 토폴로지컬 정렬 (Kahn 알고리즘)

DAG 노드는 Kahn 알고리즘으로 실행 순서가 결정됩니다:

1. 모든 노드의 진입 차수(in-degree)를 계산
2. 진입 차수가 0인 노드를 큐에 추가
3. 큐에서 노드를 꺼내 실행 순서에 추가
4. 해당 노드의 후속 노드 진입 차수를 감소
5. 진입 차수가 0이 된 노드를 큐에 추가
6. 큐가 빈 상태에서 미처리 노드가 있으면 순환 의존성 오류

결정론적 출력을 위해 큐 내부에서 알파벳 정렬(`queue.sort()`)을 수행합니다.

#### 병렬 그룹 계산

`getParallelGroups()` 함수가 토폴로지 레벨을 계산하여 동시 실행 가능한 노드 그룹을 반환합니다:

```
feature playbook의 병렬 그룹:
  Level 0: [plan]           <- 단독 실행
  Level 1: [design]         <- plan 완료 후 실행
  Level 2: [impl-fe, impl-be] <- design 완료 후 동시 실행
  Level 3: [review]         <- 두 구현 모두 완료 후 실행
  Level 4: [merge]          <- review 완료 후 실행
```

#### 순환 의존성 감지

DFS 기반 순환 감지(`detectCycle()`)가 순환 경로를 반환합니다. 예: A -> B -> C -> A이면 `['A', 'B', 'C', 'A']` 반환.

#### 하위 호환

기존 문자열 형식은 `playbooksLegacy` 키에 보존되어 여전히 지원됩니다. `parsePlaybook()` 함수는 입력 타입을 자동 감지합니다:

| 입력 타입 | 처리 방식 |
|-----------|-----------|
| 문자열 (`"[leader] plan -> ..."`) | 기존 파서로 순차 phases 생성 |
| DAG 객체 (`{ nodes: [...] }`) | `parseDagPlaybook()`으로 nodes + phases 생성 |
| 이미 파싱된 객체 (`{ phases: [...] }`) | 그대로 반환 |

**관련 파일**: `lib/core/playbook-parser.js`, `lib/core/playbook-registry.js`

---

### 2.2 미들웨어 병렬 실행

**Before**: 7개 미들웨어가 모두 순차 실행되었습니다.

```
router -> memory -> skills -> tasks -> subagents -> summarization -> checkpoint
(7단계 모두 await 순차)
```

**After**: 독립적인 미들웨어를 병렬로 실행하여 5단계로 단축되었습니다.

```
Phase 1: router (solo)              <- 라우팅/인텐트 결과 필요
Phase 2: memory | skills | tasks    <- 라우터 출력만 읽음, 서로 독립 (parallel)
Phase 3: subagents (solo)           <- tasks 결과에 의존
Phase 4: summarization (solo)       <- 최종 userPrompt 읽음
Phase 5: checkpoint (solo)          <- 전체 context 읽음
```

#### `runMiddleware()` 에러 바운더리

각 미들웨어는 개별 try/catch로 감싸져 있어, 하나가 실패해도 나머지는 계속 실행됩니다 (graceful degradation):

```javascript
async function runMiddleware(name, fn, state) {
  try {
    await fn(state);
  } catch (err) {
    process.stderr.write(`[artibot:middleware:${name}] ${err?.message || err}\n`);
    state.messageParts.push(`${name}=error`);
  }
  return state;
}
```

실패한 미들웨어는 `messageParts`에 `name=error`를 기록하고, state는 변경 없이 다음 단계로 전달됩니다.

#### `runParallel()` context 격리 방식

병렬 실행 시 각 미들웨어는 격리된 로컬 state를 받습니다:

```javascript
async function runParallel(entries, state) {
  const basePrompt = state.userPrompt;

  const results = await Promise.all(entries.map(async ([name, fn]) => {
    const localState = {
      ...state,                    // shallow spread (input, config 공유)
      userPrompt: basePrompt,      // 동일 시작점
      messageParts: [],            // 개별 메시지 수집
      context: { ...state.context }, // context shallow copy
    };
    await runMiddleware(name, fn, localState);
    return {
      promptSuffix: localState.userPrompt.slice(basePrompt.length),
      messageParts: localState.messageParts,
      context: localState.context,
    };
  }));

  // 순차적으로 병합 (결정론적 순서 보장)
  let prompt = basePrompt;
  for (const r of results) {
    prompt += r.promptSuffix;
    state.messageParts.push(...r.messageParts);
    Object.assign(state.context, r.context);
  }
  state.userPrompt = prompt;
}
```

**핵심 설계**: 각 미들웨어가 서로 다른 context 키에 쓰므로 병렬 실행이 안전합니다. 결과는 `entries` 배열 순서대로 병합되어 결정론적 출력을 보장합니다.

#### 커스텀 미들웨어 체인 하위 호환

`options.middleware`로 커스텀 체인을 주입하면 기존 방식(순차 실행)으로 동작합니다:

```javascript
if (customMiddleware) {
  for (const apply of customMiddleware) {
    await runMiddleware(apply.name || 'anonymous', apply, state);
  }
}
```

**관련 파일**: `lib/runtime/create-artibot-agent.js`

---

### 2.3 Worktree 격리 모드

**Before**: 팀원 모두 같은 working directory에서 작업하여 파일 충돌 가능성이 있었습니다.

**After**: `isolation: "worktree"` 옵션으로 Git worktree 기반 격리를 지원합니다.

#### 설정 방법

`artibot.config.json`의 `team.worktreeIsolation`:

```json
{
  "team": {
    "worktreeIsolation": {
      "enabled": false,
      "defaultMode": "worktree-isolated",
      "mergeStrategy": "auto",
      "cleanupOnClose": true
    }
  }
}
```

| 설정 | 기본값 | 설명 |
|------|--------|------|
| `enabled` | `false` | Worktree 격리 마스터 스위치 |
| `defaultMode` | `"worktree-isolated"` | 기본 격리 모드 |
| `mergeStrategy` | `"auto"` | 작업 완료 후 병합 전략 |
| `cleanupOnClose` | `true` | 팀 해산 시 worktree 자동 정리 |

#### 사용법

```
/team --worktree "결제 시스템 구현"
```

각 팀원이 별도의 Git worktree에서 작업하므로:
- 파일 충돌 없이 병렬 편집 가능
- 작업 완료 후 `mergeStrategy`에 따라 자동 병합
- `cleanupOnClose: true`이면 팀 해산 시 worktree 자동 삭제

**관련 파일**: `artibot.config.json`, `skills/team/SKILL.md`, `skills/delegation/SKILL.md`

---

### 2.4 CronCreate 학습 스케줄링

**Before**: nightly-learner 파이프라인을 수동으로만 실행할 수 있었습니다 (CLI `artibot learn` 또는 세션 종료 시 자동).

**After**: Claude Code의 `CronCreate` API를 활용하여 세션 내 자동 스케줄링이 가능합니다.

#### 설정

`artibot.config.json`의 `learning.schedule`:

```json
{
  "learning": {
    "schedule": {
      "enabled": false,
      "nightlyLearner": "3 2 * * *",
      "driftCheck": "7 6 * * 1"
    }
  }
}
```

| 설정 | 기본값 | 설명 |
|------|--------|------|
| `enabled` | `false` | 자동 스케줄링 마스터 스위치 |
| `nightlyLearner` | `"3 2 * * *"` | 학습 파이프라인 cron (매일 2:03 AM) |
| `driftCheck` | `"7 6 * * 1"` | 라우팅 드리프트 체크 cron (매주 월 6:07 AM) |

#### 두 가지 스케줄 작업

**Nightly Learner (매일 2:03 AM)**:
1. 당일 라우팅 경험 수집 (`~/.claude/artibot/daily-experiences.json`)
2. GRPO 배치 학습 (groupSize: 5, batchSize: 50)
3. Knowledge Transfer: 3회+ 연속 성공 패턴을 System 1으로 승격, 2회+ 실패 패턴을 System 2로 강등
4. 업데이트된 캐시 영구 저장

**Drift Check (매주 월 6:07 AM)**:
1. 현재 라우팅 threshold 읽기
2. 기준 threshold(0.4)와 비교
3. 0.15 이상 드리프트 시 경고 및 리셋 제안

#### 3가지 활성화 방법

| 방법 | 설명 | 사용 시점 |
|------|------|-----------|
| 수동 | "학습 스케줄 설정해줘" 또는 "schedule learning" | 사용자 직접 요청 |
| 세션 시작 | `learning.schedule.enabled: true` 설정 후 자동 | 매 세션마다 자동 |
| 원샷 | `recurring: false`로 단일 실행 예약 | 일회성 학습 |

#### 제약

- **세션 전용**: CronCreate 작업은 현재 REPL 세션에서만 존재하며, Claude 종료 시 사라짐
- **7일 만료**: recurring 작업은 7일 후 자동 만료
- **Idle-only**: 쿼리 처리 중에는 cron 작업이 실행되지 않음

**관련 파일**: `skills/scheduled-learning/SKILL.md`, `artibot.config.json`

---

### 2.5 Artibot CLI Standalone

**Before**: Artibot은 Claude Code 플러그인으로만 실행 가능했습니다.

**After**: `node bin/artibot.js`로 독립 실행이 가능합니다.

#### 6개 명령어

```
artibot <command> [options]

Commands:
  run <prompt>       런타임 파이프라인으로 프롬프트 처리
  team <prompt>      팀 위임 모드로 프롬프트 처리
  eval               런타임 eval 스위트 실행
  learn              나이틀리 학습 파이프라인 실행
  version, -v        버전 정보 표시
  help, -h, --help   도움말 표시
```

#### 사용 예시

```bash
# 기본 프롬프트 처리
node bin/artibot.js run "fix the typo in README"

# JSON 출력
node bin/artibot.js run "implement auth API" --json

# 팀 모드
node bin/artibot.js team "결제 시스템 구현" --json

# Eval 스위트 실행 (병렬)
node bin/artibot.js eval

# Eval 순차 실행
node bin/artibot.js eval --sequential --json

# 학습 파이프라인
node bin/artibot.js learn

# 버전 확인
node bin/artibot.js version
# 출력: artibot v1.13.0
#        Node v22.x.x | win32/x64
```

#### `--json` 옵션

`run`, `team`, `eval` 명령에 `--json` 플래그를 추가하면 구조화된 JSON을 stdout으로 출력합니다:

```json
{
  "userPrompt": "...",
  "message": "[runtime] route=SYSTEM1 | ...",
  "context": {
    "routing": { "system": "system1" },
    "intent": { "best": "action:fix" },
    "runtime": { "name": "artibot-runtime-phase1" }
  }
}
```

#### CLI 어댑터 아키텍처

```
bin/artibot.js (진입점)
    |
    +-- parseArgs(process.argv) -> { command, flags, prompt }
    |
    +-- cmdRun/cmdTeam -> import('../lib/adapters/cli-adapter.js')
    |       -> createCliAdapter({ pluginRoot, teamMode? })
    |       -> adapter.runPrompt(prompt) -> createArtibotAgent -> preparePrompt()
    |
    +-- cmdEval -> import('../lib/runtime/evaluator.js')
    |       -> evaluateRuntimeSuite() -> formatRuntimeSuiteReport()
    |
    +-- cmdLearn -> import('../lib/learning/index.js')
            -> shutdownLearning(sessionData)
```

`CLAUDE_PLUGIN_ROOT` 환경변수가 자동으로 설정되어 lib 모듈들이 플러그인 루트를 올바르게 참조합니다.

**관련 파일**: `bin/artibot.js`, `lib/adapters/cli-adapter.js`

---

### 2.6 다국어 Intent 확장

**Before**: 3개 언어 지원 (en, ko, ja)

**After**: 4개 언어 지원 (en, ko, ja, **zh** 추가)

#### 중국어 32개 키워드

| 카테고리 | 키워드 |
|---------|--------|
| 팀/오케스트레이션 | 团队, 召集, 组建 |
| 구현/빌드 | 实现, 开发, 编写, 创建, 构建, 生成 |
| 리뷰 | 审查, 检查, 审计, 代码审查 |
| 테스트 | 测试, 单元测试, 覆盖率, 测试用例 |
| 수정/디버그 | 调试, 修复, 错误, 缺陷, 故障 |
| 리팩토링 | 重构, 清理, 优化 |
| 배포 | 部署, 发布, 上线 |
| 문서 | 文档, 说明, 指南, 文档化 |
| 분석 | 分析, 调查, 解析 |
| 설명 | 解释 |
| 설계/계획 | 设计, 架构, 模块, 计划, 规划 |
| 보안 | 安全, 漏洞 |

#### 일본어 18개 추가 키워드

v1.12.0에서 12개였던 일본어 키워드가 30개로 확장되었습니다. 추가된 키워드:

| 카테고리 | 추가 키워드 |
|---------|-----------|
| 팀 | 招集 |
| 빌드 | 構築 |
| 구현 | 開発 |
| 리뷰 | 監査, コードレビュー |
| 테스트 | 単体テスト, カバレッジ, 試験 |
| 수정 | 修復, バグ, 不具合 |
| 리팩토링 | リファクタリング, 整理, 最適化 |
| 배포 | リリース, 公開 |
| 문서 | 説明書 |
| 분석 | 調査, 解析 |
| 설계 | アーキテクチャ |
| 보안 | セキュリティ, 脆弱性 |

#### `detectLanguage()` 함수 우선순위

```
Korean (한글 감지: U+AC00-U+D7AF)
  -> Japanese (히라가나/가타카나 감지: U+3040-U+30FF)
    -> Chinese (CJK 한자만 있고 한글/가나 없음: U+4E00-U+9FFF)
      -> English (기본값)
```

#### CJK 한자 충돌 방지 방식

한자(漢字)는 중국어, 일본어, 한국어에서 모두 사용됩니다. 충돌 방지를 위해:

1. **한글 최우선**: 한글 음절(U+AC00-U+D7AF)이 있으면 무조건 한국어
2. **가나 우선**: 히라가나/가타카나가 있으면 일본어 (한자와 함께 쓰여도)
3. **한자만**: CJK 한자만 존재하고 한글/가나가 없으면 중국어
4. **영문 기본**: 위 어느 것에도 해당하지 않으면 영어

예: "修復してください" -> 가타카나 감지 -> 일본어
예: "修复这个bug" -> CJK 한자만 감지 -> 중국어
예: "이 버그 修正해줘" -> 한글 감지 -> 한국어

**관련 파일**: `lib/intent/language.js`, `lib/intent/router.js`

---

### 2.7 스킬 Lazy Loading

**Before**: 세션 시작 시 96개+ 스킬의 `SKILL.md`를 전부 로드하여 파싱했습니다.

**After**: 인덱스만 먼저 로드하고, 트리거 매칭 후 필요한 스킬만 로드합니다.

#### 동작 방식

```
1. 세션 시작 -> loadSkillIndex() 호출 (이름, 트리거만 포함하는 경량 인덱스)
2. 사용자 요청 -> 라우터가 intent/command 추출
3. matchSkills(index, keywords, maxConcurrent) -> 트리거/이름 매칭
4. 매칭된 스킬만 loadSkillsByNames(uncached) 호출
5. _skillCache에 저장 -> 동일 스킬 재요청 시 캐시 히트
```

#### 매칭 알고리즘

```javascript
function matchSkills(index, keywords, maxConcurrent) {
  for (const entry of index) {
    if (matches.length >= maxConcurrent) break;
    // 이름 매칭: keyword가 스킬 이름에 포함
    // 트리거 매칭: 스킬 트리거가 keyword에 포함 (양방향)
    if (nameMatch || triggerMatch) matches.push(entry.dirName);
  }
  return matches;
}
```

#### 세션 캐시 동작

| 단계 | 동작 | 비용 |
|------|------|------|
| 첫 요청 | `loadSkillIndex()` + 매칭 스킬 로드 | 인덱스 1회 + 스킬 N개 |
| 이후 요청 | `_indexCache` 재사용 + `_skillCache` 히트 | 거의 0 |
| 새 스킬 매칭 | 캐시 미스 스킬만 추가 로드 | 미스 스킬만 |

#### 설정

`artibot.config.json`의 `skills.lazyLoading`:

```json
{
  "skills": {
    "lazyLoading": {
      "enabled": false,
      "maxConcurrent": 5
    }
  }
}
```

| 설정 | 기본값 | 설명 |
|------|--------|------|
| `enabled` | `false` | Lazy loading 마스터 스위치 |
| `maxConcurrent` | `5` | 요청당 최대 로드 스킬 수 |

#### Fallback

`lazyLoading.enabled`가 `false`이거나 인덱스 로드 실패 시, 기존 방식(intent 기반 커맨드명 매핑)으로 폴백합니다.

**관련 파일**: `lib/core/skill-exporter.js`, `lib/runtime/middleware/skills.js`

---

### 2.8 Eval 파이프라인 강화

**Before**: 동기 `execFileSync` 기반, 5개 시나리오, 메트릭 없음.

**After**: 비동기 `Promise.all` 기반, 8개 시나리오, `durationMs`/`memDeltaBytes` 메트릭 추가.

#### 8개 시나리오

| ID | 이름 | 검증 내용 |
|----|------|-----------|
| `simple-system1` | 단순 프롬프트 System 1 라우팅 | route=system1, 프롬프트 리라이트, subAgent 모드 |
| `complex-system2` | 복잡 프롬프트 System 2 라우팅 | route=system2, 실행/위임 계약, agentTeam 모드 |
| `command-skill-handoff` | 구현 의도 커맨드/스킬 매핑 | intent=implement, /implement 커맨드, cmd-implement 스킬 |
| `reverify-hook-chain` | 재검증 트리거 훅 체인 | !rv 트리거 리라이트, 런타임 보존 |
| `checkpoint-contract` | 체크포인트 + 위임 아티팩트 | ckpt- ID, 디스크 영속, 위임 도구 |
| `middleware-pipeline-parallel` | **신규** - 미들웨어 병렬 처리 | 3개 프롬프트 동시 처리, 각각 올바른 라우팅 |
| `error-recovery` | **신규** - 미들웨어 실패 복구 | 장애 미들웨어 후 나머지 정상 실행 |
| `scheduling-config` | **신규** - 스케줄링 컨텍스트 | 라우팅/인텐트 존재, 런타임 이름 확인 |

#### 3개 신규 시나리오 상세

**`middleware-pipeline-parallel`**: 3개 프롬프트를 동시에 처리하여 병렬 파이프라인이 정확히 동작하는지 검증합니다. 단순 프롬프트는 System 1, 복잡 프롬프트는 System 2, 구현 요청은 implement 인텐트로 라우팅되는지 확인합니다.

**`error-recovery`**: 의도적으로 실패하는 미들웨어를 삽입하여, 런타임이 크래시하지 않고 나머지 미들웨어가 정상 실행되는지 검증합니다. `failingMiddleware`가 `'simulated middleware failure'` 에러를 던지지만 파이프라인은 계속 진행됩니다.

**`scheduling-config`**: 스케줄링 관련 프롬프트가 올바르게 라우팅되고 유효한 런타임 컨텍스트를 생성하는지 검증합니다.

#### 메트릭

각 시나리오 실행 결과에 다음 메트릭이 추가되었습니다:

```javascript
{
  "id": "simple-system1",
  "durationMs": 12.34,          // performance.now() 기반 실행 시간
  "memDeltaBytes": 524288,      // process.memoryUsage().heapUsed 변화량
  "score": 1.0,
  "passed": true,
  "assertions": [...]
}
```

#### 타임아웃 설정

| 대상 | 기본값 | 설정 방법 |
|------|--------|-----------|
| 개별 시나리오 (훅 실행) | 30,000ms | `options.timeout` |
| 전체 스위트 | 120,000ms | `SUITE_TIMEOUT_MS` / `options.timeout` |

스위트는 `Promise.race([Promise.all(tasks), timeoutPromise])`로 전체 타임아웃을 관리합니다.

**관련 파일**: `lib/runtime/evaluator.js`

---

## 3. 보안 변경

### 3.1 Swarm DATA POLICY 수정

**Before**: Swarm 서버 URL이 외부 GCP 서버를 가리켰습니다.

```json
{
  "swarm": {
    "serverUrl": "https://artibot-swarm-249539591811.asia-northeast3.run.app"
  }
}
```

외부 서버로 학습 데이터가 전송될 수 있었으며, DATA POLICY(외부 DB 접근/데이터 전송 금지)에 위배되었습니다.

**After**: localhost 전용으로 변경하고, 다층 보안 레이어를 적용했습니다.

```json
{
  "swarm": {
    "enabled": true,
    "optIn": true,
    "serverUrl": "http://localhost:3000"
  }
}
```

#### 수정된 보안 레이어

| 레이어 | 구현 | 파일 |
|--------|------|------|
| **SSRF 보호** | `ALLOWED_HOSTS` allowlist: `localhost`, `127.0.0.1`, `::1`, `[::1]`만 허용 | `swarm-client.js` |
| **프로토콜 제한** | `http:`, `https:`만 허용, `file://` 등 차단 | `swarm-client.js` |
| **사설 IP 차단** | RFC 1918/6598 사설 대역 차단 (localhost 제외) | `swarm-client.js` |
| **환경변수 우회 차단** | `ARTIBOT_SWARM_SERVER` 환경변수도 `validateUrl()` 통과 필수, 실패 시 `http://localhost:3000` 폴백 | `swarm-client.js` |
| **이중 동의** | `config.swarm.enabled` AND 로컬 consent 파일(`swarm-consent.json`) 모두 `true`여야 활성화 | `swarm-config.js` |
| **PII 스크러빙** | 43개 정규식 패턴으로 경로, API 키, 이메일 등 자동 마스킹 | `pii-scrubber.js` |
| **차분 프라이버시** | epsilon=1.0, delta=1e-5 노이즈 추가 | `swarm-config.js` |

#### `validateUrl()` 동작

```javascript
function validateUrl(urlString) {
  const url = new URL(urlString);

  // 1. 프로토콜 확인: http/https만 허용
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new Error(`SSRF blocked: protocol '${url.protocol}' not allowed`);

  // 2. 호스트 allowlist 확인
  if (!ALLOWED_HOSTS.has(url.hostname))
    throw new Error(`SSRF blocked: host '${url.hostname}' not in allowlist`);

  // 3. 사설 IP 차단 (localhost 제외)
  if (isPrivateIp(url.hostname))
    throw new Error(`SSRF blocked: private IP '${url.hostname}' not allowed`);

  return url;
}
```

**관련 파일**: `lib/swarm/swarm-client.js`, `lib/swarm/swarm-config.js`, `lib/core/config.js`

---

## 4. 버그 수정

### 4.1 Korean Path 버그

**영향 파일**: `lib/core/playbook-registry.js`, `lib/core/platform.js`

**원인**: `URL.pathname`을 사용하면 한국어 문자가 percent-encoding되어 `%EB%B0%94%ED%83%95%20%ED%99%94%EB%A9%B4` 형태가 됩니다. Windows에서 이 경로로 파일 I/O를 수행하면 실패합니다.

**수정**: `fileURLToPath()`를 사용하여 URL을 네이티브 파일 경로로 올바르게 변환합니다. `fileURLToPath()`는 percent-encoded 문자를 원래 유니코드로 디코딩합니다.

```javascript
// Before (잘못됨)
const dir = new URL('../..', import.meta.url).pathname;
// -> /C:/Users/nowhe/OneDrive/%EB%B0%94%ED%83%95%20%ED%99%94%EB%A9%B4/...

// After (수정됨)
import { fileURLToPath } from 'node:url';
const dir = fileURLToPath(new URL('../..', import.meta.url));
// -> C:\Users\nowhe\OneDrive\바탕 화면\...
```

### 4.2 hooks.json 동기화

**Before (v1.9.2 기준)**: hooks.json에 git-autopilot 관련 훅이 등록되지 않았습니다.

**After (v1.13.0)**: git-autopilot 5개 훅이 hooks.json에 올바르게 등록되었습니다.

| 훅 | 이벤트 | 스크립트 | 타임아웃 |
|----|--------|----------|----------|
| autopilot-setup | (init) | `git-autopilot-setup.js` | 5,000ms |
| autopilot-session | (session start) | `git-autopilot-session.js` | 10,000ms |
| autopilot-guard | (pre-tool) | `git-autopilot-guard.js` | 5,000ms |
| autopilot-close | (session close) | `git-autopilot-close.js` | 15,000ms |
| autopilot-save | (post-tool) | `git-autopilot-save.js` | 5,000ms |

---

## 5. 테스트 추가

| 영역 | 추가 수 | 주요 테스트 |
|------|---------|------------|
| 미들웨어 파이프라인 | +55개 | 병렬 실행, 에러 바운더리, context 격리, 결정론적 병합 |
| Playbook DAG | +30개 | 파싱, 검증, 순환 감지, 토폴로지 정렬, 병렬 그룹, 레거시 호환 |
| Eval 파이프라인 | +5개 | 3개 신규 시나리오 + 메트릭 검증 + 타임아웃 |
| Intent 다국어 | +58개 | 중국어 32키워드, 일본어 18키워드, detectLanguage() 우선순위, CJK 충돌 |
| CLI | +16개 | 6개 명령, --json 출력, 에러 핸들링, parseArgs |
| Swarm 보안 | +1개 | SSRF allowlist 검증 |
| Lazy Loading | +7개 | 인덱스 로드, 트리거 매칭, 캐시 히트/미스, maxConcurrent, fallback |

**총 테스트 변화**: 3,608개 -> 3,765개 (+157개)

---

## 6. 설정 변경 요약 테이블

`artibot.config.json`에 추가된 새 설정 키:

| 키 경로 | 타입 | 기본값 | 설명 | 비고 |
|---------|------|--------|------|------|
| `version` | string | `"1.13.0"` | 버전 업데이트 | 1.12.0 -> 1.13.0 |
| `team.playbooksLegacy` | object | (기존 playbooks 값) | 레거시 문자열 플레이북 보존 | 신규 추가 |
| `team.playbooks` | object | DAG nodes 구조 | DAG 기반 플레이북 (8개) | 구조 변경 |
| `team.worktreeIsolation.enabled` | boolean | `false` | Worktree 격리 마스터 스위치 | 기존 유지 |
| `team.worktreeIsolation.defaultMode` | string | `"worktree-isolated"` | 기본 격리 모드 | 기존 유지 |
| `team.worktreeIsolation.mergeStrategy` | string | `"auto"` | 병합 전략 | 기존 유지 |
| `team.worktreeIsolation.cleanupOnClose` | boolean | `true` | 자동 정리 | 기존 유지 |
| `automation.supportedLanguages` | string[] | `["en","ko","ja","zh"]` | 지원 언어 | zh 추가 |
| `learning.schedule` | object | - | 학습 스케줄 설정 | 신규 추가 |
| `learning.schedule.enabled` | boolean | `false` | 스케줄링 마스터 스위치 | 신규 추가 |
| `learning.schedule.nightlyLearner` | string | `"3 2 * * *"` | 학습 cron 표현식 | 신규 추가 |
| `learning.schedule.driftCheck` | string | `"7 6 * * 1"` | 드리프트 체크 cron | 신규 추가 |
| `skills` | object | - | 스킬 설정 섹션 | 신규 추가 |
| `skills.lazyLoading` | object | - | Lazy loading 설정 | 신규 추가 |
| `skills.lazyLoading.enabled` | boolean | `false` | Lazy loading 스위치 | 신규 추가 |
| `skills.lazyLoading.maxConcurrent` | number | `5` | 요청당 최대 로드 스킬 | 신규 추가 |
| `swarm.serverUrl` | string | `"http://localhost:3000"` | Swarm 서버 URL | 외부 -> localhost |
| `swarm.enabled` | boolean | `true` | Swarm 마스터 스위치 | false -> true |
| `swarm.optIn` | boolean | `true` | Swarm 참여 동의 필요 | false -> true |
