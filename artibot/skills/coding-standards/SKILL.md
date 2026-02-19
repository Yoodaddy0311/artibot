---
name: coding-standards
description: |
  Coding standards and best practices for TypeScript, JavaScript,
  React, and Node.js development. Enforces immutability, proper
  error handling, and file organization conventions.

  Use proactively when writing, reviewing, or refactoring code.

  Triggers: code, implement, write, refactor, review, function,
  component, module, class, type, interface,
  코드, 구현, 작성, 리팩토링, 코드리뷰,
  コード, 実装, リファクタリング

  Do NOT use for: documentation-only tasks, infrastructure configuration,
  or deployment scripts.
---

# Coding Standards

> Readable, maintainable, immutable code. No exceptions.

## When This Skill Applies

- Writing new code (any language)
- Reviewing existing code for quality
- Refactoring for maintainability
- Setting up project conventions
- Any code modification or creation

## Critical Rules

### 1. Immutability (MANDATORY)

ALWAYS create new objects. NEVER mutate.

```typescript
// CORRECT
const updated = { ...user, name: newName }
const filtered = items.filter(item => item.active)

// WRONG - mutation
user.name = newName
items.push(newItem)
```

See `references/immutability.md` for comprehensive patterns.

### 2. Error Handling (MANDATORY)

ALWAYS handle errors with meaningful context.

```typescript
try {
  const result = await operation()
  return result
} catch (error) {
  console.error('Operation failed:', error)
  throw new Error('Descriptive user-facing message')
}
```

See `references/error-handling.md` for patterns.

### 3. File Organization

- Many small files > few large files
- 200-400 lines typical, 800 max
- Organize by feature/domain, not by type
- High cohesion, low coupling

See `references/file-organization.md` for conventions.

## Naming Conventions

| Element | Convention | Example |
|---------|-----------|---------|
| Variables | camelCase, descriptive | `userSearchQuery` |
| Functions | camelCase, verb-noun | `fetchMarketData()` |
| Components | PascalCase | `UserProfile` |
| Constants | UPPER_SNAKE | `MAX_RETRIES` |
| Types/Interfaces | PascalCase | `ApiResponse<T>` |
| Files (component) | PascalCase | `UserProfile.tsx` |
| Files (utility) | camelCase | `formatDate.ts` |
| Files (type) | camelCase.types | `market.types.ts` |

## Type Safety

```typescript
// ALWAYS: Explicit types for public APIs
interface Market {
  id: string
  name: string
  status: 'active' | 'resolved' | 'closed'
}

function getMarket(id: string): Promise<Market> { ... }

// NEVER: Using 'any'
function getMarket(id: any): Promise<any> { ... }
```

## Function Rules

- Maximum 50 lines per function
- Single responsibility per function
- Early returns over deep nesting
- Functional updates for state based on previous values

```typescript
// GOOD: Early returns
if (!user) return null
if (!user.isAdmin) return forbidden()
return processAdmin(user)

// BAD: Deep nesting
if (user) {
  if (user.isAdmin) {
    return processAdmin(user)
  }
}
```

## Async Best Practices

```typescript
// GOOD: Parallel when independent
const [users, markets] = await Promise.all([
  fetchUsers(),
  fetchMarkets()
])

// BAD: Sequential when unnecessary
const users = await fetchUsers()
const markets = await fetchMarkets()
```

## Input Validation

Validate all user input at system boundaries:

```typescript
import { z } from 'zod'

const schema = z.object({
  email: z.string().email(),
  age: z.number().int().min(0).max(150)
})

const validated = schema.parse(input)
```

## Pre-Completion Checklist

- [ ] Code is readable and well-named
- [ ] Functions are small (<50 lines)
- [ ] Files are focused (<800 lines)
- [ ] No deep nesting (>4 levels)
- [ ] Proper error handling
- [ ] No console.log in production code
- [ ] No hardcoded values (use constants)
- [ ] Immutable patterns used throughout

## References

- `references/immutability.md` - Immutability patterns and examples
- `references/error-handling.md` - Error handling strategies
- `references/file-organization.md` - File structure conventions
