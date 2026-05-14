---
context: fork
name: agent-memory-snapshot
description: "세션 상태를 압축 스냅샷으로 변환하여 서브에이전트 프롬프트에 주입. Use when spawning sub-agents, delegating tasks, or needing session context transfer between agents."
lang: [en, ko]
platforms: [claude-code]
level: progressive
level1_tokens: 200
level2_tokens: 2000
triggers:
  - "snapshot"
  - "스냅샷"
  - "session context"
  - "세션 컨텍스트"
  - "agent context"
  - "context injection"
  - "sub-agent"
  - "서브에이전트"
category: "core"
risk: safe
agents:
  - "orchestrator"
tokens: "~2K"
version: "1.0.0"
source_hash: ac80733d
whenNotToUse: "Single-agent tasks with no context handoff needed; do not apply when there is no sub-agent spawn or cross-session context transfer requirement."
---

# Agent Memory Snapshot

## When This Skill Applies
- 서브에이전트 소환 시 현재 세션 컨텍스트 전달
- Agent Teams에서 팀원 생성 시 작업 맥락 주입
- 세션 상태의 경량 직렬화가 필요한 경우
- 컨텍스트 전파 디버깅

## Do NOT Use When
- 장기 메모리 저장 (memory-management 스킬 참조)
- 파일 체크포인트 (file-checkpoint 모듈 참조)
- 전체 세션 로그 보존 (session-worklog 참조)

## Core Guidance (Level 1)

### 스냅샷 구성 요소
| 항목 | 제한 | 설명 |
|------|------|------|
| 현재 작업 | 150자 | 진행 중인 작업 설명 |
| 주요 파일 | 최대 8개 | 경로 + 변경 유형 |
| 최근 결정 | 최대 3개 | 160자 truncate |
| 팀원 | 전체 | 이름 + 역할 |
| 미완료 | 전체 | pending 작업 목록 |

### 토큰 예산
- 최대 500 토큰 (약 2000 chars)
- 초과 시 자동 truncate

### API
```javascript
import { createSnapshot, formatForPrompt, estimateSnapshotTokens } from './lib/core/index.js';

const snapshot = createSnapshot(sessionState);
const prompt = formatForPrompt(snapshot);
const tokens = estimateSnapshotTokens(snapshot);
```

## Detailed Guide (Level 2)

### 사용 예시

```javascript
import { createSnapshot, formatForPrompt, estimateSnapshotTokens } from './lib/core/index.js';

// 세션 상태 구성
const sessionState = {
  taskDescription: 'Codex 플러그인 연동 커맨드 구현 중',
  files: [
    { path: 'commands/codex.md', changeType: 'created' },
    { path: 'skills/codex-integration/SKILL.md', changeType: 'created' },
    { path: 'artibot.config.json', changeType: 'modified' },
  ],
  decisions: [
    'codex-plugin-cc 플러그인 위임 방식 채택',
    'mode off/review/dev 3단계 설계',
  ],
  teammates: [
    { name: 'codex-engineer', role: '커맨드 구현' },
    { name: 'skill-writer', role: '스킬 문서 작성' },
  ],
  pending: [
    '크로스체크 결과 통합 로직',
    'Hook 충돌 해결 가이드',
  ],
};

// 스냅샷 생성
const snapshot = createSnapshot(sessionState);
// => { task, files, decisions, teammates, pending } (frozen object)

// 프롬프트 형태로 포맷
const prompt = formatForPrompt(snapshot);
// => <session-context>...</session-context>

// 토큰 비용 확인
const cost = estimateSnapshotTokens(snapshot);
// => ~120 (500 이하 확인)
```

### 출력 형태

```xml
<session-context>
현재 작업: Codex 플러그인 연동 커맨드 구현 중
주요 파일:
  - commands/codex.md (created)
  - skills/codex-integration/SKILL.md (created)
  - artibot.config.json (modified)
최근 결정:
  1. codex-plugin-cc 플러그인 위임 방식 채택
  2. mode off/review/dev 3단계 설계
팀원:
  - codex-engineer: 커맨드 구현
  - skill-writer: 스킬 문서 작성
미완료:
  - 크로스체크 결과 통합 로직
  - Hook 충돌 해결 가이드
</session-context>
```

### 설계 원칙
- **불변**: `createSnapshot()`은 frozen object 반환
- **안전**: 모든 입력 필드 optional, null-safe
- **경량**: zero dependencies, 순수 함수
- **예산 준수**: 2000자 초과 시 자동 truncate

### 모듈 위치
- 구현: `plugins/artibot/lib/core/agent-memory-snapshot.js`
- 내보내기: `plugins/artibot/lib/core/index.js`

## Quick Reference

| 함수 | 입력 | 출력 |
|------|------|------|
| `createSnapshot(state)` | 세션 상태 객체 | frozen 스냅샷 |
| `formatForPrompt(snapshot)` | 스냅샷 | XML 문자열 |
| `estimateTokens(text)` | 문자열 | 토큰 수 |
| `estimateSnapshotTokens(snapshot)` | 스냅샷 | 토큰 수 |
| `SNAPSHOT_MAX_TOKENS` | — | 500 (상수) |

## Rationalizations

The following table captures common excuses agents make to skip the discipline of this skill, paired with factual rebuttals.

| Excuse | Rebuttal |
|--------|----------|
| "the subagent can read the same files I did" | every re-read is 2-5x the tokens a snapshot would cost, and the subagent lacks your derived reasoning — ship the conclusions, not the raw inputs |
| "a full transcript is the safest handoff" | transcripts bury the signal in noise; the subagent wastes its context budget parsing what you already parsed |
| "I'll skip the snapshot for a quick task" | quick tasks that fail mid-flight need the snapshot most — recovery without one means starting from zero |
| "snapshots go stale immediately" | a stale snapshot with a timestamp beats a fresh guess; delta-update the snapshot instead of discarding it |
| "the subagent will ask if it needs more" | round-trip clarifications cost more tokens than a thorough snapshot and break parallelism |
