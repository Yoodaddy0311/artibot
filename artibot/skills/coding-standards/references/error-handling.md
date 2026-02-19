# Error Handling

> Fail fast, fail explicitly. Never suppress errors silently.

## Core Rules

1. **Every error must be handled, logged, or explicitly propagated**
2. **Error messages must provide actionable context**
3. **Never catch and ignore (empty catch blocks)**
4. **Validate at system boundaries, trust internal code**

## Standard Pattern

```typescript
async function fetchUserData(userId: string): Promise<User> {
  try {
    const response = await fetch(`/api/users/${userId}`)

    if (!response.ok) {
      throw new Error(
        `Failed to fetch user ${userId}: HTTP ${response.status} ${response.statusText}`
      )
    }

    return await response.json()
  } catch (error) {
    // Log with context for debugging
    console.error('fetchUserData failed:', { userId, error })
    // Re-throw with user-friendly message
    throw new Error(`Unable to load user data. Please try again.`)
  }
}
```

## Error Hierarchy

```typescript
// Base application error
class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 500
  ) {
    super(message)
    this.name = 'AppError'
  }
}

// Domain-specific errors
class NotFoundError extends AppError {
  constructor(resource: string, id: string) {
    super(`${resource} not found: ${id}`, 'NOT_FOUND', 404)
  }
}

class ValidationError extends AppError {
  constructor(message: string, public readonly fields: string[]) {
    super(message, 'VALIDATION_ERROR', 400)
  }
}

class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required') {
    super(message, 'UNAUTHORIZED', 401)
  }
}
```

## API Error Response

```typescript
// Consistent error response format
interface ErrorResponse {
  success: false
  error: {
    code: string
    message: string
    details?: unknown
  }
}

// API route handler
export async function GET(request: Request) {
  try {
    const data = await fetchData()
    return Response.json({ success: true, data })
  } catch (error) {
    if (error instanceof AppError) {
      return Response.json(
        { success: false, error: { code: error.code, message: error.message } },
        { status: error.statusCode }
      )
    }

    // Unknown errors - don't expose internals
    console.error('Unexpected error:', error)
    return Response.json(
      { success: false, error: { code: 'INTERNAL', message: 'An unexpected error occurred' } },
      { status: 500 }
    )
  }
}
```

## Async Error Handling

```typescript
// Promise.all with error handling
const results = await Promise.allSettled([
  fetchUsers(),
  fetchMarkets(),
  fetchStats()
])

const errors = results.filter(r => r.status === 'rejected')
if (errors.length > 0) {
  console.error('Partial failure:', errors)
}

const data = results
  .filter(r => r.status === 'fulfilled')
  .map(r => r.value)
```

## What NOT to Do

```typescript
// NEVER: Empty catch
try { await riskyOp() } catch (e) {}

// NEVER: Log and continue silently
try { await riskyOp() } catch (e) { console.log(e) }

// NEVER: Expose internal details to users
catch (e) { return Response.json({ error: e.stack }) }

// NEVER: Catch generic Error and ignore type
catch (e) { throw new Error('Something went wrong') }
```

## Error Handling Decision Tree

| Scenario | Action |
|----------|--------|
| Expected error (validation) | Return error response with details |
| Expected error (not found) | Return 404 with resource info |
| External service failure | Retry with backoff, then error response |
| Unexpected error | Log full context, return generic message |
| Programming error | Let it crash, fix the bug |
