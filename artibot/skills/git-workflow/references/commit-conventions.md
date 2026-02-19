# Commit Message Conventions

## Format

```
<type>: <subject>

[body]

[footer]
```

## Type Reference

| Type | SemVer | Description | Example |
|------|--------|-------------|---------|
| feat | MINOR | New feature for users | `feat: add user search with autocomplete` |
| fix | PATCH | Bug fix for users | `fix: prevent crash on empty search query` |
| refactor | PATCH | Code change (no feature/fix) | `refactor: extract auth logic to shared module` |
| perf | PATCH | Performance improvement | `perf: add index on users.email column` |
| test | - | Test additions/fixes | `test: add edge cases for payment service` |
| docs | - | Documentation only | `docs: update deployment guide for v2` |
| chore | - | Build, tooling, deps | `chore: upgrade TypeScript to 5.4` |
| ci | - | CI/CD pipeline changes | `ci: add E2E tests to staging pipeline` |
| style | - | Formatting only (no logic) | `style: fix indentation in auth module` |

## Subject Line Rules

- Imperative mood: "add" not "added" or "adds"
- Lowercase after type
- No period at end
- Maximum 72 characters
- Describe WHAT changed, not HOW

## Body Rules

- Separate from subject with blank line
- Explain WHY the change was made
- Wrap at 72 characters
- Use bullet points for multiple items

## Breaking Changes

```
feat: change user API response format

BREAKING CHANGE: The `user.name` field is now split into
`user.firstName` and `user.lastName`. Consumers must update
their parsing logic.
```

## Good vs Bad Examples

| Bad | Good | Why |
|-----|------|-----|
| `fixed bug` | `fix: prevent duplicate form submission on slow network` | Specific, describes the fix |
| `update code` | `refactor: replace manual DOM manipulation with React refs` | Explains what changed |
| `WIP` | `feat: add basic cart functionality (items only)` | Meaningful even if incomplete |
| `changes` | `fix: correct tax calculation for EU countries` | Describes the actual change |
