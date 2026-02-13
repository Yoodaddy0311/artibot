# OWASP Top 10 Checklist

## A01: Broken Access Control
- [ ] Deny by default (allowlist approach)
- [ ] Enforce ownership on record-level operations
- [ ] Disable directory listing, remove metadata from responses
- [ ] Rate limit API and controller access
- [ ] Invalidate sessions on logout, JWT tokens short-lived

## A02: Cryptographic Failures
- [ ] Classify data by sensitivity (PII, financial, health)
- [ ] Encrypt data at rest and in transit (TLS 1.2+)
- [ ] Use strong algorithms (AES-256, bcrypt/argon2 for passwords)
- [ ] Never store secrets in code or version control

## A03: Injection
- [ ] Parameterized queries for ALL database operations
- [ ] Input validation with allowlists (Zod, Joi)
- [ ] Escape output for target context (HTML, SQL, OS)
- [ ] Use ORMs with parameterized queries

## A04: Insecure Design
- [ ] Threat modeling during design phase
- [ ] Principle of least privilege
- [ ] Defense in depth (multiple security layers)
- [ ] Secure default configurations

## A05: Security Misconfiguration
- [ ] Minimal platform: remove unused features, frameworks
- [ ] Automated hardening process
- [ ] Error handling does not reveal stack traces
- [ ] Security headers configured (CSP, HSTS, X-Frame-Options)

## A06: Vulnerable Components
- [ ] Remove unused dependencies
- [ ] Automated vulnerability scanning (`npm audit`)
- [ ] Pin dependency versions
- [ ] Monitor CVE databases for alerts

## A07: Authentication Failures
- [ ] Multi-factor authentication where possible
- [ ] No default credentials, no weak passwords
- [ ] Rate-limit login attempts, log failures
- [ ] Secure session management (HttpOnly, Secure, SameSite)

## A08: Data Integrity Failures
- [ ] Verify software/data integrity (checksums, signatures)
- [ ] Secure CI/CD pipeline
- [ ] Serialization validation on untrusted data

## A09: Logging & Monitoring Failures
- [ ] Log authentication, access control, input validation failures
- [ ] Structured log format, tamper-proof storage
- [ ] Alerting for suspicious activity patterns
- [ ] Never log sensitive data (passwords, tokens, PII)

## A10: Server-Side Request Forgery (SSRF)
- [ ] Validate and sanitize all URLs from user input
- [ ] Allowlist permitted domains for outbound requests
- [ ] Deny access to internal metadata endpoints
- [ ] Use network segmentation
