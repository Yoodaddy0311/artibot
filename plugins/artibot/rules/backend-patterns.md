---
paths:
  - "**/api/**"
  - "**/server/**"
  - "**/controllers/**"
  - "**/routes/**"
  - "**/models/**"
  - "**/services/**"
  - "**/middleware/**"
---

# Artibot Backend Rules

## API Design
- RESTful conventions: GET (read), POST (create), PUT (replace), PATCH (update), DELETE (remove)
- Consistent response format: `{ success, data?, error?, meta? }`
- Proper HTTP status codes (200, 201, 400, 401, 403, 404, 500)
- Pagination with `?page=&limit=` for list endpoints

## Security (Non-Negotiable)
- Validate ALL user input at boundaries (zod/joi)
- Parameterized queries only (never string concatenation for SQL)
- Rate limiting on all public endpoints
- No secrets in code — use environment variables
- CORS configured explicitly (never `*` in production)

## Error Handling
- Catch all async errors (no unhandled promise rejections)
- Structured error responses with error codes
- Log errors with context (request ID, user ID, timestamp)
- Never expose stack traces to clients

## Database
- Migrations for all schema changes
- Indexes on frequently queried columns
- Connection pooling enabled
- Transactions for multi-table operations
