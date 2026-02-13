---
name: coding-standards
description: |
  Coding standards and style guide enforcing immutability, error handling, file organization, and naming conventions.
  Auto-activates when: writing or modifying code, code review, creating new files or components.
  Triggers: code, write, edit, implement, component, function, class, style
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

## Quick Reference

| Rule | Limit | Action on Violation |
|------|-------|---------------------|
| Function length | <50 lines | Extract helper functions |
| File length | <800 lines | Split by responsibility |
| Nesting depth | <4 levels | Early returns, extract methods |
| Mutation | 0 allowed | Spread/map/filter/reduce |
