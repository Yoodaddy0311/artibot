---
context: fork
user-invocable: false
name: prompt-caching-strategy
description: "프롬프트 캐시 최적화 전략 — Dynamic Boundary 배치, 토큰 예산 관리, 정적·동적 영역 분리. 자연어 트리거: '프롬프트 캐시 최적화해줘', '토큰 예산 관리', '캐시 효율 높여줘', 'CLAUDE.md 레이아웃 정리'."
lang: [en, ko]
platforms: [claude-code, gemini-cli, codex-cli, cursor]
level: progressive
triggers:
  - "prompt cache"
  - "프롬프트 캐시"
  - "token efficiency"
  - "토큰 효율"
  - "context management"
  - "컨텍스트 관리"
  - "dynamic boundary"
  - "캐시 최적화"
  - "토큰 예산"
agent: Explore
allowed-tools: [Read, Grep, Glob, Bash]
agents:
  - "performance-engineer"
  - "architect"
tokens: 3000
level1_tokens: 200
level2_tokens: 3000
category: "optimization"
risk: safe
version: "1.0.0"
lastVerified: "2026-04-01"
source_hash: 4787da02
whenNotToUse: "Platforms that do not support prompt caching (e.g., non-Anthropic APIs) or single-turn tasks where prompt structure changes every request and no static prefix exists to cache."
---

# Prompt Caching Strategy

## When This Skill Applies
- CLAUDE.md / 시스템 프롬프트 구조 설계
- 토큰 비용 최적화 (캐시 활용 극대화)
- 스킬/커맨드 프롬프트 레이아웃 설계
- 동적 컨텍스트 배치 전략 수립
- 대규모 프로젝트에서 instruction 파일 토큰 예산 관리

## Do NOT Use When
- 단순 CLAUDE.md 내용 수정 (coding-standards 참조)
- 컴팩션 생존 전략만 필요한 경우 (compaction-survival 참조)
- 런타임 토큰 사용량 추적 (token-efficiency 참조)

## Core Guidance (Level 1)

### Dynamic Boundary 개념

Claude Code 시스템 프롬프트에는 `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__` 마커가 존재한다. 이 마커를 기준으로:

| 영역 | 위치 | 캐시 | 비용 |
|------|------|------|------|
| **정적 영역** | 마커 위 | 캐시됨 | **90% 절감** (캐시 히트 시) |
| **동적 영역** | 마커 아래 | 매 턴 재계산 | 전체 비용 |

### 배치 원칙
- **정적 지시사항** (DEV 프로토콜, 품질 게이트, 코어 규칙) → CLAUDE.md 상단
- **동적 컨텍스트** (git status, 날짜, MEMORY.md, 활성 스킬) → system-reminder / 하단
- **스킬 프롬프트** → 레벨별 점진적 로딩 (Level 1만 먼저, 필요 시 Level 2)

### 토큰 예산
- 개별 instruction 파일: **4K chars 이하**
- 총합 (모든 instruction 파일): **12K chars 이하**
- 토큰 추정 공식: `chars / 4 + 1`

## Detailed Guide (Level 2)

### Step 1: 정적/동적 영역 분류

**정적 영역** (캐시 대상 — 변경 빈도 낮음):
```
CLAUDE.md 상단:
├── DEV Protocol (Decompose-Execute-Verify)
├── Zero-Skip Policy
├── Quality Gates (함수 50줄, 파일 800줄, 커버리지 80%)
├── Agent Delegation 규칙
├── Naming Conventions
├── Development Standards (ESM only, immutable patterns)
└── Config Files 목록
```

**동적 영역** (매 턴/세션 변경):
```
system-reminder 태그 내:
├── git status (현재 브랜치, 변경 파일)
├── currentDate (오늘 날짜)
├── MEMORY.md (자동 메모리 인덱스)
├── 활성 스킬 목록 (현재 로드된 스킬)
├── MCP 서버 상태
└── 최근 커밋 로그
```

### Step 2: CLAUDE.md 레이아웃 최적화

```markdown
# Project Instructions                    ← 정적 (캐시됨)

## DEV Protocol                           ← 가장 중요한 규칙을 최상단에
1. DECOMPOSE
2. EXECUTE
3. VERIFY

## Quality Gates                          ← 핵심 제약 조건
- Read before write
- Functions < 50 lines, files < 800 lines
- 80%+ test coverage

## Agent Delegation                       ← 위임 규칙
- Complex features → planner
- After code → code-reviewer

## Naming Conventions                     ← 참조 정보 (덜 중요)

---
__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__        ← 여기부터 동적
---

## Dynamic Context                        ← 매 턴 변경
- git status, date, memory, skills
```

**핵심**: 변경 빈도가 낮은 지시사항을 boundary 위에, 자주 변하는 정보를 아래에 배치하면 캐시 히트율이 극대화된다.

### Step 3: 스킬 프롬프트 점진적 로딩

```
요청 수신
  ├── 트리거 매칭 → 해당 스킬의 Level 1 로드 (~200 토큰)
  ├── Level 1으로 충분? → 완료
  └── 상세 필요? → Level 2 추가 로드 (~2500-4000 토큰)
```

Progressive disclosure의 캐시 이점:
- Level 1만 로드 시: 200 토큰만 동적 영역에 추가
- Level 2까지 로드 시: 전체 스킬 로드되지만, Level 1은 이전 턴에서 캐시 가능

### Step 4: 토큰 예산 관리

| 파일 유형 | 최대 chars | 추정 토큰 | 비고 |
|----------|-----------|----------|------|
| CLAUDE.md | 4,000 | ~1,001 | 프로젝트 루트 |
| CLAUDE.local.md | 4,000 | ~1,001 | 개인 설정 |
| rules/*.md (각) | 4,000 | ~1,001 | 경로별 자동 규칙 |
| **총합** | **12,000** | **~3,001** | 모든 instruction 파일 합계 |

**예산 초과 시 대응**:
1. 중복 제거 — 여러 파일에 반복되는 지시사항 통합
2. 참조 전환 — 상세 내용을 스킬로 이동, CLAUDE.md에는 포인터만
3. 우선순위 정리 — 자주 사용되지 않는 규칙을 스킬로 이동

### Step 5: 캐시 효율 측정

캐시 효율을 간접적으로 판단하는 방법:

```
캐시 히트율 ≈ 정적 영역 토큰 / 전체 시스템 프롬프트 토큰

목표: 캐시 히트율 > 70%
  → 시스템 프롬프트의 70% 이상이 정적 영역에 있어야 함
  → 나머지 30%만 매 턴 재계산
```

**비용 절감 계산**:
```
기존 비용: 전체_토큰 × 단가
캐시 후:   (정적_토큰 × 단가 × 0.1) + (동적_토큰 × 단가)
절감율:    1 - ((정적 × 0.1 + 동적) / 전체)
```

예: 시스템 프롬프트 10K 토큰, 정적 7K + 동적 3K
→ 절감율 = 1 - ((7000 × 0.1 + 3000) / 10000) = 1 - 0.37 = **63% 절감**

## Workflow Checklist

```
Progress:
- [ ] Step 1: 현재 CLAUDE.md 내용을 정적/동적으로 분류
- [ ] Step 2: 정적 지시사항을 CLAUDE.md 상단으로 이동
- [ ] Step 3: 동적 컨텍스트가 system-reminder에 있는지 확인
- [ ] Step 4: 개별 파일 4K chars 이하 확인
- [ ] Step 5: 총합 12K chars 이하 확인
- [ ] Step 6: 스킬의 progressive disclosure 적용 확인
- [ ] Step 7: 캐시 히트율 추정 (목표 70% 이상)
```

## Quick Reference

| 항목 | 정적 (캐시) | 동적 (매 턴) |
|------|------------|-------------|
| DEV Protocol | O | |
| Quality Gates | O | |
| Naming Conventions | O | |
| git status | | O |
| 오늘 날짜 | | O |
| MEMORY.md | | O |
| 활성 스킬 목록 | | O |
| 스킬 Level 1 | 이전 턴 캐시 가능 | 첫 로드 시 동적 |

## Rationalizations

The following table captures common excuses agents make to skip the discipline of this skill, paired with factual rebuttals.

| Excuse | Rebuttal |
|--------|----------|
| "cache hits are a nice-to-have" | cached tokens are 10x cheaper and 5x faster — at scale this is the difference between viable and unviable |
| "I'll put dynamic context first for freshness" | dynamic-first destroys cache reuse; put static above dynamic to maximize the cacheable prefix |
| "the boundary doesn't matter much" | the boundary is everything — one byte of dynamic content above your static block invalidates the entire prefix cache |
| "caching makes debugging harder" | cached requests are identical by construction — they're EASIER to debug, not harder |
| "tool definitions change too often to cache" | tool definitions should be versioned and stable; "too often" means your tool design needs discipline, not that caching is wrong |
