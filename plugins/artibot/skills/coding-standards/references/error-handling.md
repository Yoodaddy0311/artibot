# Error Handling Patterns

## Core Rules
1. **Fail fast**: Detect and report errors immediately
2. **Fail explicitly**: Meaningful messages with context
3. **Never suppress**: All errors logged, handled, or escalated
4. **Preserve context**: Full error chain for debugging

## Standard Pattern
```typescript
try {
  const result = await riskyOperation()
  return result
} catch (error) {
  // Log with context
  logger.error('Operation failed', {
    operation: 'riskyOperation',
    input: sanitizedInput,
    error: error instanceof Error ? error.message : String(error)
  })
  // Re-throw with user-friendly message
  throw new AppError('Unable to complete operation', { cause: error })
}
```

## Custom Error Classes
```typescript
class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string = 'INTERNAL_ERROR',
    public readonly statusCode: number = 500,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'AppError'
  }
}

class ValidationError extends AppError {
  constructor(message: string, public readonly fields: string[]) {
    super(message, 'VALIDATION_ERROR', 400)
  }
}

class NotFoundError extends AppError {
  constructor(resource: string, id: string) {
    super(`${resource} not found: ${id}`, 'NOT_FOUND', 404)
  }
}
```

## API Error Response
```typescript
interface ErrorResponse {
  success: false
  error: {
    code: string
    message: string      // User-friendly
    details?: unknown     // Dev-only in non-production
  }
}
```

## Anti-Patterns
| Anti-Pattern | Fix |
|-------------|-----|
| `catch (e) {}` | Log or re-throw |
| `catch (e) { return null }` | Return Result type or throw |
| Generic "Something went wrong" | Specific, actionable message |
| Logging sensitive data in errors | Sanitize before logging |
