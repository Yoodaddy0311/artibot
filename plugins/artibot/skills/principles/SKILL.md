---
context: fork
user-invocable: false
name: principles
description: |
  Core development principles enforcing SOLID, DRY, KISS, YAGNI, and quality-first design.
  Auto-activates when: writing code, making design decisions, refactoring, reviewing architecture.
  Triggers: design, architecture, refactor, pattern, principle, SOLID, clean code
platforms: [claude-code, gemini-cli, codex-cli, cursor]
level: 3
triggers:
  - "design"
  - "architecture"
  - "refactor"
  - "pattern"
  - "principle"
  - "SOLID"
  - "clean code"
  - "DRY"
agents:
  - "architect"
  - "refactor-cleaner"
tokens: "~3K"
category: "code-quality"
---

# Development Principles

## When This Skill Applies
- Writing new code or modifying existing code
- Making architectural or design decisions
- Refactoring or improving code quality
- Reviewing pull requests or code structure
- Evaluating trade-offs between approaches

## Core Guidance

### SOLID Principles
- **S**ingle Responsibility: One class/function = one reason to change
- **O**pen/Closed: Open for extension, closed for modification
- **L**iskov Substitution: Subtypes must be substitutable for base types
- **I**nterface Segregation: No forced dependency on unused interfaces
- **D**ependency Inversion: Depend on abstractions, not concretions

See `${CLAUDE_SKILL_DIR}/references/solid.md` for detailed examples.

### Design Principles
- **DRY**: Abstract common functionality, eliminate duplication
- **KISS**: Simplest solution that works. Complexity is a cost.
- **YAGNI**: Only implement current requirements. No speculative features.
- **Composition > Inheritance**: Favor object composition
- **Loose Coupling + High Cohesion**: Minimize dependencies, group related logic

### Decision Framework
1. **Evidence > Assumptions**: Verify with tests, metrics, documentation
2. **Code > Documentation**: Working code is the source of truth
3. **Measure first**: Profile before optimizing
4. **Reversibility**: Prefer reversible decisions when uncertain
5. **Trade-off analysis**: Consider immediate vs. long-term impact

### Quality Gate Integration
All code changes pass through a 3-step validation cycle.
See `${CLAUDE_SKILL_DIR}/references/quality-gates.md` for the validation framework.

### Execution Discipline (MANDATORY for ALL agents)

**Decompose-Execute-Verify (DEV) Protocol**:
1. **Decompose**: Break every request into numbered atomic items BEFORE starting
2. **Execute**: Read target files FIRST, make changes, re-read to confirm
3. **Verify**: Report completion with evidence (file:line) for each item

**Zero-Skip Policy**:
- NEVER silently skip or defer any part of a request
- NEVER claim "done" without re-reading modified files
- NEVER modify a file without reading it first
- If blocked, explain WHY with specific error/reason

**Evidence-Based Completion**:
- ✅ requires: file path + line number + what changed
- "Updated the file" = NOT acceptable evidence
- "Updated src/auth.ts:45-52, added validateToken() null check" = acceptable

## Quick Reference

| Principle | Check | Violation Signal |
|-----------|-------|------------------|
| SRP | Does this have one reason to change? | Class/function does multiple things |
| DRY | Is this duplicated elsewhere? | Copy-paste patterns |
| KISS | Is there a simpler way? | Over-engineering, unnecessary abstraction |
| YAGNI | Is this needed now? | Speculative features, unused code |
| DEV | Was every request item decomposed, executed, verified? | Silent skips, no evidence |
| Zero-Skip | Was any part of the request dropped? | Missing items in completion report |

## Workflow Checklist

Copy this checklist and track progress:

```
Progress:
- [ ] Step 1: DECOMPOSE — Break request into numbered atomic items
- [ ] Step 2: Read target files BEFORE any modifications
- [ ] Step 3: EXECUTE — Apply changes following SOLID, DRY, KISS, YAGNI
- [ ] Step 4: Re-read modified files to confirm correctness
- [ ] Step 5: VERIFY — Report evidence (file:line) for each item
- [ ] Step 6: Check for zero-skip — no items silently dropped
```

## Human Checkpoints

### Checkpoint 1: 분해 결과 승인 (After Step 1)
**Context**: 요청이 번호가 매겨진 원자적 항목들로 분해된 시점. 분해가 완전하지 않으면 이후 단계에서 누락 항목이 생기고 Zero-Skip Policy 위반으로 이어진다.
**Ask**: "요청이 다음과 같이 분해되었습니다. **모든 항목이 포함되어 있고 분해 단위가 적절한가요?**"
**Options**:
1. Approve items — 분해 확인, Step 2 파일 읽기로 진행
2. Add missing items — 누락된 항목 추가 후 재확인
**Default**: 1 (명확한 요청에서 생성된 분해는 대부분 완전)
**Skippable**: No — 불완전한 분해는 Zero-Skip Policy 위반의 직접적 원인
**Freedom**: MEDIUM

### Checkpoint 2: 설계 트레이드오프 선택 (After Step 3)
**Context**: SOLID/DRY/KISS/YAGNI 원칙을 적용하며 구현 방식이 결정된 시점. 동일한 원칙을 다른 방향으로 해석할 수 있어 사용자의 선호와 맥락이 중요하다.
**Ask**: "구현 방식이 결정되었습니다. **제안된 설계 접근법이 현재 프로젝트 맥락에 맞나요?**"
**Options**:
1. KISS approach — 가장 단순한 구현 유지
2. More abstraction — 재사용성을 위해 추상화 레이어 추가
3. Different pattern — 다른 설계 패턴 제안 (구체적으로 명시)
**Default**: 1 (KISS 원칙 — 복잡성은 비용)
**Skippable**: Yes (기본값 사용) — KISS 접근법으로 진행
**Freedom**: HIGH

### Checkpoint 3: 완료 증거 검증 (After Step 5)
**Context**: 각 분해 항목에 대한 완료 증거(파일:라인)가 제출된 시점. "완료했다"는 주장이 아닌 실제 증거로 검증해야 Zero-Skip Policy가 보장된다.
**Ask**: "각 항목의 완료 증거가 제출되었습니다. **모든 항목에 대해 충분한 증거(파일:라인)가 있나요?**"
**Options**:
1. Accept — 증거 충분, 작업 완료
2. Request more evidence — 특정 항목에 대해 더 구체적인 증거 요청
**Default**: 1 (file:line 형식의 증거가 있으면 수락)
**Skippable**: No — 증거 없는 완료 주장은 허용되지 않음
**Freedom**: LOW

## Freedom Levels

| Step | Freedom | Guidance |
|------|:-------:|----------|
| Decompose request | MEDIUM | Must capture all items, granularity is judgment call |
| Read target files | LOW | Mandatory before any modification |
| Apply principles | HIGH | SOLID/DRY/KISS/YAGNI provide direction, specific implementation varies |
| Re-read files | LOW | Mandatory after every modification |
| Report evidence | LOW | file:line format required, no vague claims |
| Zero-skip check | LOW | Every item must be addressed or explicitly blocked |
