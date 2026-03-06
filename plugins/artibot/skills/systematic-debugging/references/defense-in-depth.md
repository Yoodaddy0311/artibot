# Defense in Depth for Bug Fixes

## Layered Protection Strategy

A good bug fix doesn't just patch the immediate failure — it adds layers of protection to prevent the same class of bug from recurring.

### Layer 1: Input Validation (Boundary)

Validate at system boundaries where external data enters:

- Function parameters from external callers
- User input from stdin, HTTP requests, file reads
- Configuration values from JSON/env files
- API responses from third-party services

```javascript
// BAD: Trust that filePath is valid
export async function readConfig(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf-8'));
}

// GOOD: Validate at boundary
export async function readConfig(filePath) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
    throw new TypeError(`readConfig requires absolute path, got: ${filePath}`);
  }
  return JSON.parse(await fs.readFile(filePath, 'utf-8'));
}
```

### Layer 2: Defensive Error Handling

Handle errors explicitly — never swallow silently:

- Catch specific error types, not all errors
- Log context when catching (what operation, what input)
- Re-throw with added context when appropriate
- Only use catch-all for top-level error boundaries

```javascript
// BAD: Silent swallow
try { await operation(); } catch { /* ignore */ }

// GOOD: Specific + context
try {
  await operation();
} catch (err) {
  if (err.code === 'ENOENT') return null; // Expected: file not found
  throw err; // Unexpected: propagate
}
```

### Layer 3: Regression Tests

Every bug fix MUST include a test that:

1. **Reproduces** the exact bug (would fail without the fix)
2. **Covers the root cause**, not just the symptom
3. **Tests edge cases** around the fix
4. **Is named descriptively**: `it('handles EEXIST on Windows OneDrive race condition')`

### Layer 4: Structural Prevention

After fixing a bug, consider whether the code structure allows the same class of bug:

| Bug Class | Structural Fix |
|-----------|---------------|
| Mutation bugs | Enforce immutability (Object.freeze, spread) |
| Null/undefined | Use explicit return types, avoid optional chaining chains |
| Race conditions | Use atomic operations, locks, or queues |
| Type errors | Add JSDoc types, consider TypeScript for critical paths |
| Path issues | Centralize path construction in utility functions |

### Layer 5: Monitoring and Observability

For production-impacting bugs, add observability:

- Log the condition that triggered the bug (for future detection)
- Add metrics for the error class if it's a recurring category
- Document the incident pattern for team knowledge

## Fix Scope Guidelines

| Fix Type | Scope | Example |
|----------|-------|---------|
| Minimal fix | Exact root cause only | Add missing null check on line 42 |
| Defensive fix | Root cause + immediate boundary | Fix + add input validation for the function |
| Structural fix | Root cause + prevent recurrence class | Fix + refactor to use immutable pattern throughout module |

**Default to minimal fix**. Escalate to defensive/structural only when:
- The same class of bug has occurred multiple times
- The codebase has a systemic pattern that invites this bug type
- The module is safety-critical (security, data integrity, payments)
