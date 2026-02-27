---
paths:
  - "**/*.ts"
  - "**/*.tsx"
  - "**/*.js"
  - "**/*.jsx"
  - "**/*.py"
---

# Artibot Quality Gates

## Before Modifying Code
- [ ] Read the target file first (no blind writes)
- [ ] Understand existing patterns and conventions
- [ ] Identify what EXACTLY needs to change

## After Modifying Code
- [ ] Re-read the modified file to verify correctness
- [ ] Check that existing functionality is preserved
- [ ] Ensure no unasked-for changes were introduced

## Before Reporting Completion
- [ ] Every request item addressed (check decomposition list)
- [ ] Evidence provided per item (file:line + what changed)
- [ ] No silent skips or deferrals
- [ ] Modified files re-read and verified

## Code Standards
- Immutable patterns: create new objects, never mutate
- Functions < 50 lines, files < 800 lines
- Proper error handling on all async operations
- No hardcoded secrets or credentials
- Follow existing project import style
