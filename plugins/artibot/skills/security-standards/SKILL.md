---
context: fork
user-invocable: false
name: security-standards
description: |
  Security standards and checklist enforcing OWASP Top 10, secret management, and input validation.
  Auto-activates when: API endpoints, authentication, user input handling, data storage, deployment.
  Triggers: security, auth, password, token, secret, API key, input, validate, sanitize, encrypt, 보안, 인증, 비밀번호, 토큰, API 키, 입력 검증, 암호화
lang: [en, ko]
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
  - "보안"
  - "인증"
  - "비밀번호"
  - "토큰"
  - "입력 검증"
  - "암호화"
allowed-tools: [Read, Grep, Glob]
agents:
  - "security-reviewer"
  - "backend-developer"
tokens: "~3K"
category: "security"
source_hash: 68ecb081
whenNotToUse: "Do not apply the full security checklist to internal CLI tools with no network exposure, local-only scripts, or test fixtures. When the attack surface is zero (no external input, no network, no persistence), scale down to secret-check only."
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

See `${CLAUDE_SKILL_DIR}/references/owasp-checklist.md` for OWASP Top 10 coverage.

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

### Checkpoint 1: 시크릿 노출 여부 확인 (After Step 1)
**Context**: 사전 커밋 보안 체크가 완료된 시점. 코드에 하드코딩된 시크릿이 발견되면 즉시 중단하고 로테이션해야 한다 — 이 단계를 지나치면 되돌릴 수 없다.
**Ask**: "사전 커밋 체크가 완료되었습니다. **코드에서 하드코딩된 API 키, 비밀번호, 토큰이 발견되었나요?**"
**Options**:
1. Clean — 시크릿 없음, Step 2 입력 검증으로 진행
2. STOP and rotate secrets — 즉시 작업 중단, 노출된 시크릿 로테이션 후 재검토
**Default**: 1 (체크 완료 후 이상 없으면 진행)
**Skippable**: No — 시크릿 노출은 즉각적인 보안 사고로 이어질 수 있음
**Freedom**: LOW

### Checkpoint 2: SQL 인젝션 방어 검증 (After Step 3)
**Context**: 파라미터화 쿼리 사용 여부가 검토된 시점. SQL 인젝션은 OWASP Top 1으로 문자열 연결 쿼리가 하나라도 있으면 전체 DB가 위험에 노출된다.
**Ask**: "SQL 쿼리 검토가 완료되었습니다. **모든 DB 쿼리가 파라미터화 쿼리를 사용하고 있나요?**"
**Options**:
1. Verified safe — 모든 쿼리가 파라미터화됨, Step 4로 진행
2. Needs remediation — 문자열 연결 쿼리 발견, 수정 후 재검증
**Default**: 1 (검토 완료 후 안전이 확인되면 진행)
**Skippable**: No — 파라미터화되지 않은 쿼리는 즉시 수정 필요
**Freedom**: LOW

### Checkpoint 3: 인증/인가 커버리지 확인 (After Step 6)
**Context**: 모든 엔드포인트의 인증/인가 적용 여부가 검토된 시점. 커버리지 갭이 있으면 무인증 접근 경로가 생기므로 배포 전에 반드시 해소해야 한다.
**Ask**: "엔드포인트 인증/인가 검토가 완료되었습니다. **모든 엔드포인트에 적절한 인증과 인가가 적용되어 있나요?**"
**Options**:
1. All covered — 모든 엔드포인트 커버됨, Step 7로 진행
2. Gaps found — fix first — 커버리지 갭 발견, 수정 완료 후 재검토
**Default**: 1 (커버리지 확인 후 이상 없으면 진행)
**Skippable**: No — 인증 갭은 보안 취약점이므로 배포 전 해소 필수
**Freedom**: LOW

### Checkpoint 4: 의존성 취약점 대응 방식 선택 (After Step 8)
**Context**: 의존성 취약점 감사가 완료된 시점. Critical/High 취약점은 즉시 조치가 필요하지만, 수정 불가능한 경우 위험 수용이나 릴리스 차단을 선택해야 한다.
**Ask**: "의존성 취약점 감사가 완료되었습니다. **발견된 취약점을 어떻게 처리하시겠나요?**"
**Options**:
1. Update deps — 취약한 의존성 즉시 업데이트
2. Accept risk — 심각도 낮음 또는 수정 불가 취약점으로 위험 수용 문서화
3. Block release — Critical 취약점 해소 전까지 릴리스 차단
**Default**: 1 (업데이트 가능한 경우 즉시 패치가 원칙)
**Skippable**: Yes (기본값 사용) — 업데이트 진행
**Freedom**: MEDIUM

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

## Rationalizations

The following table captures common excuses agents make to skip critical steps in this skill, paired with factual rebuttals. Use this to catch and resist shortcuts.

| Excuse | Rebuttal |
|--------|----------|
| "It's an internal-only endpoint, so injection doesn't matter" | Internal networks get breached via phishing, SSRF, and compromised service accounts. Every production incident postmortem cites "internal-only" code that was reached from the outside. Defense in depth assumes the perimeter has already failed. |
| "We'll add auth later, this is just an MVP" | "Later" becomes "never" the moment the endpoint is shipped and indexed. Every public-facing URL is scanned within hours of DNS propagation. Add auth before the first deploy — retrofitting requires schema changes, session migrations, and user re-onboarding. |
| "This API key is just for development, it's fine to commit" | Dev keys get real rate limits, real billing, and real access. GitHub is scraped continuously for leaked secrets; your "dev" key will be abused within minutes. Use `.env.local` + `.gitignore` — there is no zero-cost exception. |
| "OWASP Top 10 doesn't apply to this kind of service" | OWASP Top 10 is derived from thousands of cross-industry incidents — injection, broken auth, and misconfiguration appear in every domain from payments to IoT to ML pipelines. If you cannot name which specific OWASP item is inapplicable and why, the answer is: all ten apply. |
| "The user input comes from our own frontend, it's already validated" | Client-side validation is a UX hint, not a security boundary. An attacker bypasses your frontend with curl in under 10 seconds. Every server handler must re-validate — trust ends at the network boundary. |
| "Error messages need stack traces so users can report bugs" | Stack traces leak framework versions, file paths, SQL table names, and internal class structures — a free reconnaissance kit for attackers. Log full traces server-side, return an opaque correlation ID to the user. |
| "Parameterized queries are slower than string concatenation" | The performance delta is measured in microseconds; the SQL injection that string concatenation enables is measured in full database exfiltration. This is not a tradeoff — prepared statements are both safer and cached by the DB planner. |

## Common Rationalizations

| Rationalization | Why it's wrong | What to do instead |
|---|---|---|
| "Auth can be bolted on later, ship first" | Every endpoint deployed without auth is a permanently exploitable window; retrofitting auth requires schema migrations, session invalidation, and re-onboarding — all while the hole is open | Implement auth middleware before writing any business logic handler; it is one import and one line of middleware registration |
| "This is just a dev key, it's safe to commit temporarily" | GitHub and npm registry are scraped continuously; "temporary" committed secrets get indexed and leaked within minutes, not days | Store every key in `.env.local` before the first keystroke; there is no safe temporary exception |
| "Rate limiting is a DevOps concern, not a code concern" | Rate limiting logic belongs in middleware because the code owns the endpoint contract; if DevOps doesn't configure it, the endpoint is unprotected | Add express-rate-limit or equivalent as a default middleware on all public routes; configure it in code, tune it in config |
| "The input comes from our own dropdown, users can't inject anything" | Dropdowns are bypassed with curl; every server handler must validate input as if the client is a malicious actor | Run schema validation on every request body regardless of how the frontend is constrained |
| "Dependency vulnerabilities are theoretical — we haven't been exploited" | "Haven't been exploited" means "exploit hasn't been reported to you yet"; known vulnerabilities are actively scanned by automated bots | Run `npm audit` in CI and fail on `high` or above; patch or explicitly accept-risk with a comment |

## Red Flags

- Any endpoint handler that reads from `req.body` without a `schema.parse()` call above it
- Environment variables loaded with `process.env.X` without a `|| throw` guard for undefined
- A `try/catch` that catches an auth error and continues rather than returning 401
- Dependency audit warnings suppressed with `--force` or `--legacy-peer-deps` without a comment
- SQL query built with string template literals rather than parameterized form
- Auth middleware added to some routes but missing from at least one endpoint in the same router
