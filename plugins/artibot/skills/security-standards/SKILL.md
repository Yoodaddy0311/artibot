---
name: security-standards
description: |
  Security standards and checklist enforcing OWASP Top 10, secret management, and input validation.
  Auto-activates when: API endpoints, authentication, user input handling, data storage, deployment.
  Triggers: security, auth, password, token, secret, API key, input, validate, sanitize, encrypt
platforms: [claude-code, gemini-cli, codex-cli, cursor]
level: 3
triggers:
  - "security"
  - "auth"
  - "password"
  - "token"
  - "secret"
  - "API key"
  - "input"
  - "validate"
  - "sanitize"
  - "encrypt"
agents:
  - "security-reviewer"
  - "backend-developer"
tokens: "~3K"
category: "security"
---

# Security Standards

## When This Skill Applies
- Creating or modifying API endpoints
- Implementing authentication or authorization
- Handling user input or form data
- Managing secrets, tokens, or credentials
- Database queries with external input
- Deploying to production environments

## Core Guidance

### Mandatory Pre-Commit Checks
- [ ] No hardcoded secrets (API keys, passwords, tokens)
- [ ] All user inputs validated and sanitized
- [ ] SQL injection prevention (parameterized queries)
- [ ] XSS prevention (sanitized HTML output)
- [ ] CSRF protection on state-changing operations
- [ ] Authentication and authorization verified
- [ ] Rate limiting on public endpoints
- [ ] Error messages do not leak internal details

### Secret Management
```typescript
// NEVER: Hardcoded
const key = "sk-proj-xxxxx"

// ALWAYS: Environment variables
const key = process.env.API_KEY
if (!key) throw new Error('API_KEY not configured')
```

### Input Validation
```typescript
import { z } from 'zod'
const schema = z.object({
  email: z.string().email(),
  age: z.number().int().min(0).max(150)
})
const validated = schema.parse(untrustedInput)
```

### Threat Response Protocol
1. **STOP** current work immediately
2. **Assess** severity: Critical (immediate) / High (24h) / Medium (7d)
3. **Fix** the vulnerability before continuing
4. **Rotate** any exposed secrets
5. **Search** entire codebase for similar issues

See `references/owasp-checklist.md` for OWASP Top 10 coverage.

## Workflow Checklist

Copy this checklist and track progress:

```
Progress:
- [ ] Step 1: Run pre-commit security checks (secrets, inputs, injections)
- [ ] Step 2: Validate all user inputs with schema (Zod, Joi)
- [ ] Step 3: Verify parameterized queries — no string concatenation in SQL
- [ ] Step 4: Check XSS prevention — output encoding, CSP headers
- [ ] Step 5: Verify CSRF protection on state-changing operations
- [ ] Step 6: Confirm auth/authz on all endpoints
- [ ] Step 7: Verify error messages do not leak internal details
- [ ] Step 8: Run dependency vulnerability audit
```

## Human Checkpoints

| After Step | Checkpoint | Type | Options |
|-----------|-----------|------|---------|
| Step 1 | Any secrets detected in code? | Go-No-Go | Clean / STOP and rotate secrets |
| Step 3 | SQL injection vectors eliminated? | Approval | Verified safe / Needs remediation |
| Step 6 | Auth coverage complete for all endpoints? | Go-No-Go | All covered / Gaps found — fix first |
| Step 8 | Critical vulnerabilities in dependencies? | Selection | Update deps / Accept risk / Block release |

## Freedom Levels

| Step | Freedom | Guidance |
|------|:-------:|----------|
| Pre-commit checks | LOW | Follow checklist exactly, no skipping |
| Input validation | LOW | Must validate all external input, schema required |
| SQL injection prevention | LOW | Parameterized queries only, zero tolerance |
| XSS prevention | LOW | Output encoding mandatory |
| CSRF protection | LOW | Required on all state-changing ops |
| Auth/authz verification | LOW | Every endpoint must be covered |
| Error message review | MEDIUM | Balance user-friendliness with security |
| Dependency audit | MEDIUM | Severity threshold configurable per project |

## Quick Reference

| Threat | Prevention | Priority |
|--------|-----------|----------|
| Injection | Parameterized queries, input validation | Critical |
| Broken Auth | MFA, session management, token rotation | Critical |
| XSS | Output encoding, CSP headers | High |
| CSRF | Anti-CSRF tokens, SameSite cookies | High |
| Secrets Exposure | Env vars, vault, .gitignore | Critical |
| Mass Assignment | Allowlists, DTOs, schema validation | Medium |
