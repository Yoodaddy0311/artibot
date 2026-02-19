---
name: platform-auth
description: "Authentication and authorization patterns for modern web applications."
level: 2
triggers: ["authentication", "auth", "OAuth", "JWT", "RBAC", "session", "Auth0", "Clerk"]
agents: ["persona-backend", "persona-security"]
tokens: "~4K"
category: "platform"
platforms: [claude-code, gemini-cli, codex-cli, cursor]
---

# Authentication & Authorization Patterns

## When This Skill Applies
- Implementing user authentication flows (login, signup, password reset)
- Setting up OAuth2/OIDC with third-party providers
- Designing role-based or attribute-based access control
- Integrating managed auth services (Auth0, Clerk, Firebase Auth)
- Session management, token lifecycle, and refresh strategies
- Multi-tenant authentication and authorization

## Core Guidance

### 1. Authentication Strategy Selection

| Strategy | Use When | Complexity | Session Type |
|----------|----------|------------|--------------|
| JWT (stateless) | API-first, microservices | Moderate | Token-based |
| Session cookies | Traditional web apps, SSR | Low | Server-side |
| OAuth2/OIDC | Third-party login, SSO | High | Delegated |
| Passkeys/WebAuthn | Passwordless, high security | High | Challenge-response |

### 2. Managed Auth Services

#### Auth0
- Best for: Enterprise SSO, extensive customization, Actions/Rules pipeline
- Integration: `@auth0/nextjs-auth0`, `@auth0/auth0-react`
- Key features: Universal Login, Organizations, MFA, Breached Password Detection
- Pattern: Redirect-based flow with server-side token exchange

#### Clerk
- Best for: Modern Next.js apps, rapid integration, built-in UI components
- Integration: `@clerk/nextjs`, `@clerk/remix`
- Key features: Prebuilt components, Webhooks, Organizations, Session management
- Pattern: Middleware-based auth with `clerkMiddleware()`

#### Firebase Auth
- Best for: Mobile-first apps, Google ecosystem, real-time features
- Integration: `firebase/auth`, Admin SDK for server-side
- Key features: Anonymous auth, Phone auth, Multi-factor, Identity Platform
- Pattern: Client-side SDK with ID token verification on server

### 3. JWT Best Practices

```
Token Lifecycle:
  Access Token:  Short-lived (15min), stateless, in Authorization header
  Refresh Token: Long-lived (7-30d), httpOnly cookie, rotate on use
  ID Token:      User claims, never use for API authorization
```

**Security Rules**:
- Always validate `iss`, `aud`, `exp`, and `nbf` claims
- Use asymmetric signing (RS256/ES256) for distributed systems
- Store refresh tokens in httpOnly, secure, sameSite cookies
- Implement token rotation: new refresh token on each use
- Maintain a deny-list for revoked tokens (Redis/database)
- Never store tokens in localStorage (XSS vulnerable)

### 4. OAuth2 Flows

| Flow | Use Case | Client Type |
|------|----------|-------------|
| Authorization Code + PKCE | SPA, mobile, server apps | Public & confidential |
| Client Credentials | Machine-to-machine | Confidential |
| Device Authorization | Smart TV, CLI tools | Input-constrained |

**PKCE is mandatory** for all public clients (SPAs, mobile apps).

### 5. Role-Based Access Control (RBAC)

```
Permission Model:
  User -> Role(s) -> Permission(s) -> Resource:Action

Example:
  admin  -> [manage_users, manage_content, view_analytics]
  editor -> [manage_content, view_analytics]
  viewer -> [view_content]
```

**Implementation Pattern**:
- Store roles in JWT claims or session data
- Check permissions at API gateway/middleware level
- Use permission strings, not role checks (`can("edit:post")` not `isAdmin()`)
- Support hierarchical roles with permission inheritance

### 6. Session Management

| Concern | Recommendation |
|---------|----------------|
| Storage | Server-side (Redis/DB) for sensitive apps, JWT for stateless APIs |
| Expiry | Sliding window (extend on activity) or absolute (fixed duration) |
| Invalidation | Server-side revocation list, token version in DB |
| Multi-device | Per-device sessions with device tracking |
| CSRF | SameSite cookies + CSRF token for form submissions |

### 7. Multi-Factor Authentication (MFA)

Priority order for second factors:
1. **Hardware keys** (FIDO2/WebAuthn) - Phishing resistant
2. **Authenticator apps** (TOTP) - Widely supported
3. **Push notifications** - Good UX, moderate security
4. **SMS/Email OTP** - Last resort, SIM-swap vulnerable

### 8. Security Checklist

- [ ] Passwords hashed with bcrypt/scrypt/argon2 (cost factor >= 12)
- [ ] Rate limiting on auth endpoints (5 attempts/min)
- [ ] Account lockout after repeated failures (temporary, not permanent)
- [ ] Secure password reset flow (time-limited, single-use tokens)
- [ ] HTTPS enforced on all auth endpoints
- [ ] CORS configured to allow only trusted origins
- [ ] Audit logging for all auth events
- [ ] Token rotation implemented for refresh tokens

## Anti-Patterns

- Storing passwords in plaintext or with weak hashing (MD5, SHA1)
- Using localStorage for sensitive tokens
- Rolling your own crypto or JWT library
- Checking roles instead of permissions in authorization logic
- Long-lived access tokens without refresh mechanism
- Missing CSRF protection on state-changing endpoints
- Hardcoding secrets in source code

## Quick Reference

**Auth Flow Selection**:
```
Web app (SSR)? -> Session cookies + CSRF
SPA? -> Auth Code + PKCE + httpOnly refresh cookie
Mobile? -> Auth Code + PKCE + secure storage
API-to-API? -> Client Credentials
```

**Token Storage**:
```
Access token  -> Memory (JS variable) or short-lived httpOnly cookie
Refresh token -> httpOnly, secure, sameSite=strict cookie
Never         -> localStorage, sessionStorage
```
