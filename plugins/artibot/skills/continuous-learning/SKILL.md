---
context: fork
user-invocable: false
name: continuous-learning
description: |
  Pattern extraction and knowledge persistence across sessions using auto memory.
  Auto-activates when: recurring patterns detected, debugging insights gained, user preferences confirmed.
  Triggers: remember, pattern, learned, always do, never do, across sessions
platforms: [claude-code, gemini-cli, codex-cli, cursor]
level: 2
triggers:
  - "remember"
  - "pattern"
  - "learned"
  - "always do"
  - "never do"
  - "across sessions"
agents:
  - "orchestrator"
tokens: "~2K"
category: "learning"
source_hash: 70c75841
whenNotToUse: "One-time tasks or ephemeral session work where no persistent pattern or preference is worth storing across future sessions."
---
# Continuous Learning

## When This Skill Applies
- Recurring patterns confirmed across 2+ interactions
- Debugging insights worth preserving for future sessions
- User explicitly requests remembering preferences or conventions
- Architectural decisions that should persist across sessions

## Core Guidance

**What to Save**:
- Stable patterns and conventions confirmed across interactions
- Key architectural decisions and important file paths
- User preferences for workflow, tools, communication style
- Solutions to recurring problems and debugging insights

**What NOT to Save**:
- Session-specific context (current task, temporary state)
- Incomplete or unverified information
- Anything duplicating existing CLAUDE.md instructions
- Speculative conclusions from reading a single file

**Memory Structure**:
```
~/.claude/projects/{project-hash}/memory/
  MEMORY.md          # Always loaded, keep <200 lines
  patterns.md        # Confirmed patterns
  debugging.md       # Debugging insights
  decisions.md       # Architectural decisions
```

**Persistence Rules**:
1. Verify before saving: confirm pattern across 2+ interactions
2. Keep concise: MEMORY.md under 200 lines (loaded every session)
3. Organize semantically: topic files for detailed notes
4. Remove outdated: delete patterns no longer valid
5. Link from MEMORY.md: reference topic files, don't duplicate

**Anti-Patterns**: Saving session-specific state, speculative single-observation conclusions, duplicating CLAUDE.md content

## Workflow Checklist

Copy this checklist and track progress:

```
Progress:
- [ ] Step 1: Detect pattern or learning worth persisting
- [ ] Step 2: Verify pattern across 2+ interactions (not single observation)
- [ ] Step 3: Classify: preference / pattern / debugging / decision
- [ ] Step 4: Check MEMORY.md size — under 200 lines?
- [ ] Step 5: Save to appropriate topic file or MEMORY.md
- [ ] Step 6: Prune outdated entries if near limit
```

## Human Checkpoints

### Checkpoint 1: 패턴 저장 승인 (After Step 2)
**Context**: 관찰된 패턴이 2회 이상 상호작용에서 확인되었는지 검증한 시점. 단일 관찰을 저장하면 불확실한 정보가 메모리를 오염시킨다.
**Ask**: "이 패턴이 **여러 상호작용에서 충분히 확인**되었나요? 지금 저장할까요?"
**Options**:
1. Save — 패턴이 검증되었으므로 메모리에 저장
2. Wait for more evidence — 추가 관찰이 필요, 아직 저장하지 않음
**Default**: 2 (불확실한 정보 저장보다 대기가 안전)
**Skippable**: No — 검증 없는 저장은 메모리 품질 저하
**Freedom**: LOW

### Checkpoint 2: 학습 분류 선택 (After Step 3)
**Context**: 저장할 학습의 유형을 결정하는 시점. 잘못된 분류는 향후 정보 검색과 활용을 어렵게 만든다.
**Ask**: "이 학습을 **어떤 유형으로 분류**하는 게 적합한가요?"
**Options**:
1. Preference — 사용자 워크플로우/도구/소통 방식 선호
2. Pattern — 코드나 작업에서 반복되는 확인된 패턴
3. Debug insight — 디버깅에서 발견한 재사용 가능한 인사이트
4. Decision — 이후 세션에도 유지되어야 할 아키텍처 결정
**Default**: 2 (대부분의 학습은 패턴 유형에 해당)
**Skippable**: Yes (use default) — 기본값인 Pattern으로 분류 후 진행
**Freedom**: MEDIUM

### Checkpoint 3: 오래된 항목 정리 선택 (After Step 6)
**Context**: MEMORY.md가 200줄 한계에 근접하여 오래된 항목을 정리해야 하는 시점. 어떤 항목을 제거할지는 관련성 판단이 필요하다.
**Ask**: "MEMORY.md 한계에 근접했습니다. **어떤 항목을 정리**할까요?"
**Options**:
1. Remove specific entries — 지정한 항목을 삭제
2. Keep all — 현재 그대로 유지 (한계 초과 위험 감수)
3. Archive — 오래된 항목을 별도 파일로 이동 후 링크만 유지
**Default**: 3 (삭제보다 아카이빙이 안전)
**Skippable**: Yes (use default) — 기본값인 아카이빙으로 진행
**Freedom**: HIGH

## Freedom Levels

| Step | Freedom | Guidance |
|------|:-------:|----------|
| Detect pattern | HIGH | Observation and judgment-driven |
| Verify across interactions | LOW | Minimum 2 confirmations required, no exceptions |
| Classify type | MEDIUM | Categories defined, but some learnings are ambiguous |
| Check MEMORY.md size | LOW | 200-line limit is strict |
| Save to file | LOW | File structure and format are defined |
| Prune outdated | HIGH | Relevance judgment is subjective |

## Quick Reference
- Confirm pattern 2+ times before saving
- MEMORY.md < 200 lines (always loaded)
- Organize: MEMORY.md links to topic files
- Prune regularly: remove outdated patterns

## Rationalizations

The following table captures common excuses agents make to skip the discipline of this skill, paired with factual rebuttals.

| Excuse | Rebuttal |
|--------|----------|
| "I'll remember the pattern next time" | you won't — session memory dies at turn N, and the next session starts from pretraining only |
| "patterns are too project-specific to learn" | project-specific IS the value; global patterns are already in the base model |
| "saving patterns is premature optimization" | the cost of a save is bytes; the cost of re-discovering the pattern is the full debugging session you already paid |
| "I'll codify patterns into docs manually" | manual codification happens zero times out of ten; auto-capture happens every time |
| "learned patterns will conflict with new conventions" | conflicts are the signal the convention changed — surface them via versioning, don't suppress learning |
