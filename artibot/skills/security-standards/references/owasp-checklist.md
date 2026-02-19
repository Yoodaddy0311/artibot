# OWASP Top 10 Checklist

> Security compliance checklist based on OWASP Top 10 (2021).

## A01: Broken Access Control

| Check | Status | Notes |
|-------|--------|-------|
| Every endpoint verifies authentication | Required | No public access to protected resources |
| Authorization checked per resource | Required | User can only access own data |
| CORS configured restrictively | Required | Whitelist allowed origins |
| Directory listing disabled | Required | No exposed file listings |
| Rate limiting on sensitive endpoints | Required | Login, registration, password reset |
| JWT tokens validated on every request | Required | Check expiry, signature, issuer |

**Prevention**:
```typescript
// ALWAYS check both authn AND authz
const session = await getSession(request)
if (!session) return unauthorized()

const resource = await getResource(id)
if (resource.ownerId !== session.userId) return forbidden()
```

## A02: Cryptographic Failures

| Check | Status | Notes |
|-------|--------|-------|
| Passwords hashed with bcrypt/argon2 | Required | Never store plaintext |
| HTTPS enforced | Required | No mixed content |
| Sensitive data encrypted at rest | Required | PII, financial data |
| Strong random number generation | Required | Use crypto.randomUUID() |
| No sensitive data in URLs | Required | No tokens in query params |
| TLS 1.2+ only | Required | Disable older protocols |

## A03: Injection

| Check | Status | Notes |
|-------|--------|-------|
| Parameterized database queries | Required | Never string concatenation |
| ORM/query builder used | Recommended | Additional safety layer |
| Input validation with schemas | Required | Zod, Joi, or similar |
| Output encoding for HTML | Required | Prevent XSS |
| Command injection prevention | Required | No shell commands from user input |

**Prevention**:
```typescript
// SQL: Parameterized queries
await db.query('SELECT * FROM users WHERE id = $1', [userId])

// NoSQL: Validated input
const validated = UserIdSchema.parse(userId)
await collection.findOne({ _id: validated })

// Shell: Never pass user input to commands
// If absolutely necessary, use allowlist validation
```

## A04: Insecure Design

| Check | Status | Notes |
|-------|--------|-------|
| Threat modeling completed | Recommended | For new features |
| Business logic validated server-side | Required | Never trust client |
| Resource limits enforced | Required | File sizes, request counts |
| Error handling doesn't leak info | Required | Generic messages for users |

## A05: Security Misconfiguration

| Check | Status | Notes |
|-------|--------|-------|
| Default credentials removed | Required | No admin/admin |
| Error pages don't leak stack traces | Required | Custom error pages |
| Security headers configured | Required | See header checklist below |
| Unnecessary features disabled | Required | Debug modes, unused endpoints |
| Dependencies up to date | Required | Regular `npm audit` |

**Security Headers**:
```typescript
const headers = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'X-XSS-Protection': '0',  // Rely on CSP instead
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Content-Security-Policy': "default-src 'self'",
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
}
```

## A06: Vulnerable Components

| Check | Status | Notes |
|-------|--------|-------|
| `npm audit` clean | Required | Zero Critical/High |
| Dependencies minimized | Recommended | Only what's needed |
| Lock file committed | Required | Reproducible builds |
| Automated dependency updates | Recommended | Dependabot, Renovate |

## A07: Authentication Failures

| Check | Status | Notes |
|-------|--------|-------|
| Multi-factor authentication available | Recommended | For sensitive operations |
| Account lockout after failed attempts | Required | 5 attempts, 15 min lockout |
| Session timeout configured | Required | Appropriate for risk level |
| Password complexity enforced | Required | Min 8 chars, mixed types |
| Session invalidation on logout | Required | Clear all tokens |

## A08: Data Integrity Failures

| Check | Status | Notes |
|-------|--------|-------|
| CI/CD pipeline secured | Required | No unauthorized deploys |
| Signed packages/images | Recommended | Verify integrity |
| Deserialization validated | Required | Never deserialize untrusted data |

## A09: Logging & Monitoring

| Check | Status | Notes |
|-------|--------|-------|
| Authentication events logged | Required | Login success/failure |
| Authorization failures logged | Required | Access denied events |
| Input validation failures logged | Required | Potential attack patterns |
| No sensitive data in logs | Required | No passwords, tokens, PII |
| Structured log format | Recommended | JSON for analysis |
| Alerting configured | Recommended | Unusual patterns trigger alerts |

## A10: Server-Side Request Forgery (SSRF)

| Check | Status | Notes |
|-------|--------|-------|
| URL allowlists for external requests | Required | No user-controlled URLs |
| Internal network access blocked | Required | No requests to 127.0.0.1, 10.x |
| Response data sanitized | Required | Don't return raw responses |

## Quick Pre-Commit Checklist

Before committing security-relevant code:

1. [ ] No secrets in code or config files
2. [ ] All user input validated server-side
3. [ ] Database queries parameterized
4. [ ] HTML output properly encoded
5. [ ] Authentication on all protected routes
6. [ ] Authorization checked per resource
7. [ ] Error messages are generic (no internals)
8. [ ] `npm audit` passes with zero Critical/High
