# Commit Conventions

## Format

```
type(scope): subject

[optional body]

[optional footer]
```

## Types

| Type | SemVer | Description | Example |
|------|--------|-------------|---------|
| feat | MINOR | New feature | `feat: add user search` |
| fix | PATCH | Bug fix | `fix: resolve login timeout` |
| refactor | - | Code change (no feature/fix) | `refactor: simplify auth flow` |
| docs | - | Documentation only | `docs: update API guide` |
| test | - | Tests only | `test: add auth unit tests` |
| chore | - | Build/tooling/deps | `chore: update eslint config` |
| perf | PATCH | Performance improvement | `perf: optimize query caching` |
| ci | - | CI/CD changes | `ci: add deploy workflow` |
| style | - | Formatting (no logic) | `style: fix indentation` |

## Rules

1. **Subject**: imperative mood, lowercase, no period, max 72 chars
2. **Body**: wrap at 72 chars, explain "what" and "why" (not "how")
3. **Breaking changes**: add `!` after type or `BREAKING CHANGE:` in footer
4. **Issue references**: `Fixes #123`, `Closes #456`, `Refs #789`

## Examples

```
feat: add password reset functionality
```

```
fix: prevent race condition in session refresh

The token refresh could fire multiple times when concurrent
requests detected an expired token. Added mutex lock to ensure
only one refresh occurs at a time.

Fixes #234
```

```
feat!: change authentication to OAuth2

BREAKING CHANGE: /auth/login now requires OAuth2 credentials.
Migration guide: docs/migration/v2-auth.md
```

## Branch Naming

| Pattern | Example |
|---------|---------|
| `feat/<name>` | `feat/user-search` |
| `fix/<issue>-<name>` | `fix/234-session-race` |
| `refactor/<scope>` | `refactor/auth-flow` |
| `release/v<version>` | `release/v1.2.0` |
