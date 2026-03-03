---
context: forked
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
agents:
  - "refactor-cleaner"
  - "backend-developer"
tokens: "~3K"
category: "code-quality"
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
See `references/immutability.md` for comprehensive patterns.

### Error Handling
- Fail fast with explicit, meaningful errors
- Never suppress errors silently
- Preserve full error context for debugging
- Use typed errors and structured error responses

See `references/error-handling.md` for patterns.

### File Organization
- **Many small files > few large files**
- 200-400 lines typical, 800 lines maximum
- Organize by feature/domain, not by type
- High cohesion within files, low coupling between files

See `references/file-organization.md` for rules.

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

| After Step | Checkpoint | Type | Options |
|-----------|-----------|------|---------|
| Step 1 | Existing patterns identified correctly? | Approval | Confirm patterns / Clarify conventions |
| Step 4 | File split strategy acceptable? | Selection | Split by feature / Split by type / Keep as-is |
| Step 6 | Quality violations found — fix now or defer? | Go-No-Go | Fix all / Fix critical only / Defer with ticket |

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
