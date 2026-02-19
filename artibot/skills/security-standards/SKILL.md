---
name: security-standards
description: |
  Security standards and vulnerability prevention for web applications.
  OWASP Top 10 compliance, input validation, secret management,
  and security review checklists.

  Use proactively when handling authentication, user input,
  API endpoints, database queries, or sensitive data.

  Triggers: security, auth, authentication, authorization,
  vulnerability, injection, XSS, CSRF, secret, credential,
  encrypt, sanitize, validate input, OWASP,
  보안, 인증, 취약점, 암호화, セキュリティ, 認証, 脆弱性

  Do NOT use for: UI styling, documentation, or performance-only tasks.
---

# Security Standards

> Security is non-negotiable. Validate everything, trust nothing.

## When This Skill Applies

- Implementing authentication or authorization
- Handling user input from any source
- Creating or modifying API endpoints
- Writing database queries
- Managing secrets or credentials
- Processing sensitive data (PII, financial)
- Before any commit that touches auth/data handling

## Mandatory Security Checks

Before ANY commit touching security-relevant code:

- [ ] No hardcoded secrets (API keys, passwords, tokens)
- [ ] All user inputs validated and sanitized
- [ ] SQL injection prevention (parameterized queries)
- [ ] XSS prevention (sanitized HTML output)
- [ ] CSRF protection enabled on state-changing endpoints
- [ ] Authentication verified on protected routes
- [ ] Authorization checked for resource access
- [ ] Rate limiting on all public endpoints
- [ ] Error messages do not leak internal details

## Secret Management

```typescript
// NEVER: Hardcoded secrets
const apiKey = "sk-proj-xxxxx"

// ALWAYS: Environment variables
const apiKey = process.env.API_KEY
if (!apiKey) {
  throw new Error('API_KEY environment variable not configured')
}
```

**Rules**:
- All secrets in environment variables or secret managers
- Never commit .env files (ensure .gitignore)
- Rotate exposed secrets immediately
- Use different secrets per environment

## Input Validation

```typescript
// Server-side validation is MANDATORY (client-side is optional UX)
import { z } from 'zod'

const UserInput = z.object({
  email: z.string().email().max(254),
  name: z.string().min(1).max(100).regex(/^[a-zA-Z\s]+$/),
  age: z.number().int().min(0).max(150)
})

// Validate at API boundary
const validated = UserInput.parse(requestBody)
```

## Authentication Patterns

```typescript
// ALWAYS: Verify auth on every protected endpoint
export async function GET(request: Request) {
  const session = await getSession(request)
  if (!session?.user) {
    return new Response('Unauthorized', { status: 401 })
  }

  // ALWAYS: Check authorization for the specific resource
  const resource = await getResource(params.id)
  if (resource.ownerId !== session.user.id) {
    return new Response('Forbidden', { status: 403 })
  }

  return Response.json(resource)
}
```

## Database Security

```typescript
// ALWAYS: Parameterized queries
const result = await db.query(
  'SELECT * FROM users WHERE id = $1',
  [userId]
)

// NEVER: String concatenation
const result = await db.query(
  `SELECT * FROM users WHERE id = '${userId}'`  // SQL INJECTION
)
```

## Security Response Protocol

If a security issue is found:

1. **STOP** current work immediately
2. **Assess** severity (Critical/High/Medium/Low)
3. **Fix** Critical and High issues before any other work
4. **Rotate** any exposed secrets
5. **Scan** entire codebase for similar patterns
6. **Document** the vulnerability and fix

## References

- `references/owasp-checklist.md` - OWASP Top 10 compliance checklist
