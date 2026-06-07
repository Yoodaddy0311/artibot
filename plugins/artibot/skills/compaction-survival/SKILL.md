---
context: fork
user-invocable: false
name: compaction-survival
description: "컴팩션 생존 전략 — 컨텍스트 압축 시 핵심 정보 보존 방법. key files 추출, pending work 추론, 메타데이터 생존 전략. See also: strategic-compact (컴팩션 시점 제안)"
lang: [en, ko]
platforms: [claude-code, gemini-cli, codex-cli, cursor]
level: progressive
triggers:
  - "compaction"
  - "compaction survival"
  - "컴팩션"
  - "context loss"
  - "컨텍스트 손실"
  - "context compression"
  - "컨텍스트 압축"
  - "context window"
  - "컨텍스트 윈도우"
agent: Explore
allowed-tools: [Read, Grep, Glob, Bash]
agents:
  - "performance-engineer"
  - "architect"
tokens: 2500
level1_tokens: 200
level2_tokens: 2500
category: "optimization"
risk: safe
version: "1.0.0"
lastVerified: "2026-04-01"
source_hash: fd4bafdf
whenNotToUse: "Short sessions well within context limits where compaction is not imminent; do not invoke as a routine step — only apply when context size poses a real loss risk."
---

# Compaction Survival

## When This Skill Applies
- 컨텍스트 사용률이 45% 이상인 경우 (70%+는 즉시 조치 필요 — 구간표 참조)
- 장시간 세션에서 핵심 상태를 보존해야 하는 경우
- 다단계 작업 중 컴팩션으로 인한 정보 손실 방지
- 컴팩션 후 작업 연속성 복구

> Claude 4.7+/4.8 tokenizer는 동일 텍스트에 더 많은 토큰을 사용할 수 있어 5%p 조기 트리거 필요 (75% → 70%).

## Do NOT Use When
- 프롬프트 캐시 구조 설계 (prompt-caching-strategy 참조)
- 런타임 토큰 사용량 추적 (token-efficiency 참조)
- 세션 간 정보 보존 (memory-management 참조)

## Core Guidance (Level 1)

### 컴팩션이란
Claude Code는 컨텍스트 윈도우 한계에 근접하면 이전 메시지를 자동 압축(compaction)한다. 이 과정에서 **초기 메시지의 세부 사항이 손실**될 수 있다.

### 생존 3원칙
1. **최근 4개 메시지에 핵심 정보 배치** — 컴팩션은 오래된 메시지부터 압축
2. **앞 160자에 가장 중요한 정보** — 요약 시 앞부분이 우선 보존
3. **파일 경로에 `/` + 확장자 포함** — key files 자동 추출 대상

### Key Files 추출 규칙
컴팩션 시스템은 대화에서 언급된 파일 경로를 자동 추출한다:
- `/`를 포함하고 확장자(`.js`, `.md`, `.json` 등)가 있는 문자열
- 추출된 경로는 컴팩션 후에도 보존됨
- 따라서 **중요한 파일은 항상 전체 경로로 언급**할 것

## Detailed Guide (Level 2)

### Step 1: 컴팩션 타이밍 인식

```
컨텍스트 사용률:
  0-45%   → 안전 — 정상 작업
  45-70%  → 주의 — 핵심 상태 정리 시작
  70-85%  → 위험 — 즉시 생존 조치 실행
  85%+    → 임박 — 컴팩션 자동 트리거
```

**주의 신호**: 세션이 길어지고 많은 파일을 읽고 편집했다면 컨텍스트가 빠르게 소모된다. 특히 대형 파일 읽기, 긴 빌드 출력, 다수의 도구 호출이 컨텍스트를 급격히 소비한다.

### Step 2: 핵심 정보 보존 전략

**A. 최근 메시지에 상태 요약 배치**

컴팩션 직전에 현재 작업 상태를 요약하여 최근 메시지에 포함시킨다:

```
현재 작업 상태:
- 목표: {무엇을 하고 있는가}
- 완료: {지금까지 한 것}
- 진행중: {현재 하고 있는 것}
- 다음: {아직 해야 할 것}
- 핵심 파일: plugins/artibot/lib/core/config.js, plugins/artibot/lib/runtime/middleware/guardrail.js
- 결정사항: {내린 중요 결정과 이유}
```

**B. 160자 규칙**

메시지의 앞 160자가 컴팩션 요약에서 우선 보존된다. 따라서:

```
좋은 예:
"plugins/artibot/lib/core/guard-registry.js의 executeChain()에 우선순위 정렬 버그 수정 중.
현재 Step 3/5 완료, registerGuard()의 priority 필드 검증 추가 필요."

나쁜 예:
"앞서 논의한 내용을 바탕으로 계속 작업하겠습니다. 이전에 말씀드린 대로 해당 파일의
해당 함수에서 발견된 문제를 처리하고 있습니다."
```

첫 160자에 **무엇을(파일 경로)**, **어떤 상태인지(진행률)**를 포함해야 한다.

**C. 파일 경로 명시 규칙**

```
보존됨 (key files로 추출):
  plugins/artibot/lib/core/config.js
  plugins/artibot/tests/core/config.test.js
  plugins/artibot/agents/orchestrator.md

보존 안 됨 (추출 불가):
  config 파일
  해당 테스트
  오케스트레이터 에이전트
```

### Step 3: Pending Work 추론 규칙

컴팩션 후 이전 대화의 세부 사항이 손실되었을 때, 진행 중이던 작업을 추론하는 방법:

```
1. Task 시스템 확인
   → TaskList()로 in_progress 상태 태스크 확인
   → 태스크 description에 작업 범위 기록됨

2. Git 상태 확인
   → git status로 변경/스테이징된 파일 확인
   → git diff로 진행 중인 수정 사항 파악
   → git log -1로 마지막 커밋 확인

3. 최근 메시지 스캔
   → 컴팩션 후에도 최근 4개 메시지는 보존
   → 파일 경로, 에러 메시지, TODO 항목 추출

4. Auto Memory 확인
   → MEMORY.md에 checkpoint가 있으면 참조
   → /checkpoint로 저장된 상태 스냅샷 확인
```

### Step 4: 사전 방어 — Checkpoint 활용

장시간 작업 전 또는 컨텍스트 70% 도달 시:

```
사전 방어 절차:
1. /checkpoint — 현재 상태를 auto memory에 저장
2. 핵심 결정사항을 메시지에 요약
3. 진행 중인 작업을 TaskCreate로 태스크 시스템에 기록
4. 중요 파일 경로를 전체 경로로 명시적 언급
```

### Step 5: 컴팩션 후 복구

```
복구 절차:
1. TaskList() → 진행 중 태스크 확인
2. git status → 변경된 파일 목록
3. MEMORY.md → 최근 checkpoint 확인
4. 최근 메시지에서 컨텍스트 추출
5. 필요 시 핵심 파일 Re-read
```

## Limitations
- 컴팩션 자체를 방지할 수 없음 — 시스템 자동 동작
- 100% 정보 보존 불가 — 핵심만 선별적으로 보존
- 매우 긴 세션에서는 반복적 컴팩션 발생 가능

## Workflow Checklist

```
Progress:
- [ ] Step 1: 현재 컨텍스트 사용률 인식
- [ ] Step 2: 핵심 상태를 최근 메시지에 요약
- [ ] Step 3: 중요 파일 경로를 전체 경로로 명시
- [ ] Step 4: /checkpoint로 상태 스냅샷 저장
- [ ] Step 5: 진행 중 작업을 TaskCreate로 기록
- [ ] Step 6: (컴팩션 후) 복구 절차 실행
```

## Quick Reference

| 전략 | 규칙 | 이유 |
|------|------|------|
| 최근 메시지 활용 | 핵심 정보를 최근 4개 메시지에 | 컴팩션은 오래된 메시지부터 압축 |
| 160자 규칙 | 앞 160자에 핵심 배치 | 요약 시 앞부분 우선 보존 |
| 파일 경로 명시 | `/` + 확장자 포함 전체 경로 | key files 자동 추출 대상 |
| Checkpoint | 70% 도달 시 /checkpoint | auto memory에 상태 영구 저장 |
| Task 기록 | 진행 중 작업을 TaskCreate | 컴팩션 후 TaskList로 복구 가능 |

## Rationalizations

The following table captures common excuses agents make to skip the discipline of this skill, paired with factual rebuttals.

| Excuse | Rebuttal |
|--------|----------|
| "the compactor preserves what matters" | compaction is aggressive summarization — load-bearing details get lossy-compressed to one sentence |
| "I'll re-read files after compaction" | re-reads cost 2-5x the tokens you saved; front-load critical info before the window narrows |
| "recent messages are safe" | only the last 4 messages survive verbatim — anything earlier is at the compactor's mercy |
| "file paths will be remembered" | only `/`-delimited paths with extensions get auto-extracted; paraphrased references get lost |
| "I'll checkpoint later" | later is after compaction, when the state you wanted to checkpoint no longer exists in full fidelity |
