---
context: fork
user-invocable: false
name: coding-standards
description: |
  Coding standards and style guide enforcing immutability, error handling, file organization, and naming conventions.
  Auto-activates when: writing or modifying code, code review, creating new files or components.
  Triggers: code, write, edit, implement, component, function, class, style
platforms: [claude-code, gemini-cli, codex-cli, cursor]
level: 3
progressive_disclosure:
  enabled: true
  level1_tokens: 100
  level2_tokens: 4000
triggers:
  - "code"
  - "write"
  - "implement"
  - "component"
  - "function"
  - "class"
  - "style"
  - "standards"
allowed-tools: [Read, Grep, Glob]
agents:
  - "refactor-cleaner"
  - "backend-developer"
tokens: "~3K"
category: "code-quality"
version: "1.0.0"
lastVerified: "2026-03-27"
source_hash: 7a01304d
---

# Coding Standards

## When This Skill Applies
- Writing new code or modifying existing code
- Creating new files, components, or modules
- Code review and quality assessment
- Refactoring or restructuring code

## Core Guidance

### Immutability (CRITICAL)
ALWAYS create new objects. NEVER mutate existing ones.
```typescript
// WRONG
user.name = newName

// CORRECT
const updated = { ...user, name: newName }
```
See `${CLAUDE_SKILL_DIR}/references/immutability.md` for comprehensive patterns.

### Error Handling
- Fail fast with explicit, meaningful errors
- Never suppress errors silently
- Preserve full error context for debugging
- Use typed errors and structured error responses

See `${CLAUDE_SKILL_DIR}/references/error-handling.md` for patterns.

### File Organization
- **Many small files > few large files**
- 200-400 lines typical, 800 lines maximum
- Organize by feature/domain, not by type
- High cohesion within files, low coupling between files

See `${CLAUDE_SKILL_DIR}/references/file-organization.md` for rules.

### Naming Conventions
- Functions: verb + noun (`getUserById`, `validateInput`)
- Booleans: is/has/can/should prefix (`isActive`, `hasPermission`)
- Constants: UPPER_SNAKE_CASE
- Types/Interfaces: PascalCase
- Files: kebab-case for modules, PascalCase for components

### Code Quality Checklist
- [ ] Functions <50 lines, files <800 lines
- [ ] No deep nesting (>4 levels)
- [ ] Proper error handling on all operations
- [ ] No `console.log` (use structured logging)
- [ ] No hardcoded values (use constants/config)
- [ ] Immutable patterns used throughout
- [ ] Input validation on all external data

## Workflow Checklist

Copy this checklist and track progress:

```
Progress:
- [ ] Step 1: Read existing code and identify patterns in use
- [ ] Step 2: Apply immutability — no mutations, spread/create new
- [ ] Step 3: Validate error handling — fail fast, explicit, contextual
- [ ] Step 4: Check file organization — <800 lines, feature-grouped
- [ ] Step 5: Enforce naming conventions — verbs, prefixes, casing
- [ ] Step 6: Run code quality checklist (functions <50 lines, no console.log)
- [ ] Step 7: Validate input on all external data boundaries
```

## Human Checkpoints

### Checkpoint 1: 기존 패턴 확인 (After Step 1)
**Context**: 코드 수정 전 기존 코드베이스의 컨벤션과 패턴을 파악한 시점. 잘못 식별된 패턴 기반으로 작업하면 일관성이 깨질 수 있다.
**Ask**: "기존 코드에서 **[식별된 패턴 목록]** 을 확인했습니다. 이 패턴들이 올바르게 파악되었나요?"
**Options**:
1. Confirm patterns — 확인된 패턴대로 작업 진행
2. Clarify conventions — 특정 컨벤션에 대해 추가 설명 필요
**Default**: 1 (코드 자체를 신뢰)
**Skippable**: No — 잘못된 패턴 식별은 코드 불일관성으로 이어짐
**Freedom**: HIGH

### Checkpoint 2: 파일 분할 전략 선택 (After Step 4)
**Context**: 파일이 800줄 한계에 근접하거나 초과하여 분할이 필요한 시점. 분할 전략에 따라 코드 구조와 향후 유지보수성이 달라진다.
**Ask**: "파일 크기가 기준을 초과하여 분할이 필요합니다. **어떤 방식으로 분할**할까요?"
**Options**:
1. Split by feature — 기능/도메인별로 분리 (권장)
2. Split by type — 타입별로 분리 (컴포넌트/훅/유틸 등)
3. Keep as-is — 현재 크기를 유지하고 다음 기회에 처리
**Default**: 1 (feature-first 조직 원칙에 따름)
**Skippable**: Yes (use default) — 기본값인 feature 분할로 진행
**Freedom**: MEDIUM

### Checkpoint 3: 품질 위반 처리 방향 결정 (After Step 6)
**Context**: 품질 체크리스트 실행 후 위반 사항이 발견된 시점. 모든 위반을 즉시 수정할지, 우선순위를 정할지 결정이 필요하다.
**Ask**: "품질 위반 **[N건]** 이 발견되었습니다. 지금 모두 수정할까요?"
**Options**:
1. Fix all — 모든 위반을 지금 수정하고 진행
2. Fix critical only — 뮤테이션, 미처리 에러 등 치명적 항목만 수정
3. Defer with ticket — 기록 후 나중에 처리 (기술 부채 등록)
**Default**: 1 (품질 기준은 타협 없이 지킴)
**Skippable**: No — 품질 위반을 무시하면 코드베이스 품질 저하
**Freedom**: LOW

## Freedom Levels

| Step | Freedom | Guidance |
|------|:-------:|----------|
| Read existing patterns | HIGH | Exploratory, use judgment |
| Apply immutability | LOW | Zero mutations allowed, follow exactly |
| Error handling | MEDIUM | Patterns preferred, implementation details flexible |
| File organization | MEDIUM | 800-line limit strict, grouping strategy flexible |
| Naming conventions | LOW | Follow the convention table exactly |
| Quality checklist | LOW | All items must pass |
| Input validation | MEDIUM | Zod preferred, other schema libs acceptable |

## Quick Reference

| Rule | Limit | Action on Violation |
|------|-------|---------------------|
| Function length | <50 lines | Extract helper functions |
| File length | <800 lines | Split by responsibility |
| Nesting depth | <4 levels | Early returns, extract methods |
| Mutation | 0 allowed | Spread/map/filter/reduce |

## Project-Specific Rules

> Auto-injected from conversation history. Do not edit manually.
- [auto-learned] Recurring fix pattern detected. Consider adding automated checks for: fix: resolve all ESLint errors and warnings (86 → 0)
- [auto-learned] Recurring fix pattern detected. Consider adding automated checks for: fix(v1.14.3): statusline [object Object] bug fix + session token display
- [auto-learned] Recurring fix pattern detected. Consider adding automated checks for: fix(v1.14.1): auto-activation, platform compat, skill restore, zero-config learning

## Rationalizations

The following table captures common excuses agents make to skip the rigor of this skill, paired with factual rebuttals.

| Excuse | Rebuttal |
|--------|----------|
| "style is subjective" | consistency reduces cognitive load during review; the standard matters more than which one |
| "the linter is too strict" | every suppressed rule is a bug waiting to happen — disable with justification, not reflex |
| "naming does not matter if it works" | names are the primary API of your code; bad names cost hours in downstream debugging |
| "I will fix formatting in a follow-up" | follow-ups never happen — format on save, not on promise |
| "mutating is faster than copying" | mutation hides race conditions and breaks time-travel debugging; copy unless profiled hot path |
