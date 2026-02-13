# Quality Gates

## 3-Step Validation Framework

### Gate 1: Lint + TypeCheck
**When**: Before any commit or task completion.

- Run project linter (eslint, biome, etc.)
- Run TypeScript compiler (`tsc --noEmit`)
- Zero errors required, warnings reviewed
- Auto-fix where safe (`--fix` flag)

```bash
# Typical validation
npx eslint . --ext .ts,.tsx
npx tsc --noEmit
```

**Fail action**: Fix all errors before proceeding. Do not suppress with `// @ts-ignore` unless justified.

### Gate 2: Test
**When**: After lint/typecheck passes.

- Run full test suite
- Verify >=80% coverage threshold
- All tests must pass (zero failures)
- Check for flaky tests (re-run on failure)

```bash
# Typical validation
npx vitest run --coverage
# or
npx jest --coverage
```

**Fail action**: Fix failing tests. If tests are wrong, fix tests AND document why. Never delete tests to pass gate.

### Gate 3: Build + Security
**When**: Before merge or deploy.

- Full production build succeeds
- No security vulnerabilities in dependencies
- Bundle size within budget
- No hardcoded secrets detected

```bash
# Typical validation
npm run build
npx audit-ci --moderate
```

**Fail action**: Fix build errors. Update vulnerable dependencies. Remove exposed secrets and rotate them.

## Gate Enforcement Rules
- Gates run in order: Gate 1 -> Gate 2 -> Gate 3
- Each gate must pass before proceeding to next
- Failed gate blocks all downstream work
- Gate results documented with evidence
- Emergency bypass requires explicit user approval
