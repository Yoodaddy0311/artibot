---
description: Automatic build error diagnosis and repair using build-error-resolver agent
argument-hint: '[error] e.g. "빌드 에러 자동 수정"'
allowed-tools: [Read, Write, Edit, Bash, Glob, Grep, Task, TodoWrite]
---

# /build-fix

Diagnose and fix build errors automatically. Uses build-error-resolver agent for systematic error resolution with iterative retry.

## Arguments

Parse $ARGUMENTS:
- `error-message`: Paste build error output or leave empty to re-run build and capture errors
- `--auto`: Auto-apply fixes without confirmation
- `--max-attempts [n]`: Maximum fix iterations (default: 3)
- `--framework [name]`: Override framework detection for build command

## Execution Flow

1. **Capture Error**: If no error provided, detect build command from framework and execute it. Capture stderr/stdout
2. **Parse Error**: Extract error type, file location, line number, and error code from output
3. **Classify**: Categorize errors:
   - **Dependency**: Missing modules, version conflicts, peer dependency warnings
   - **Type**: TypeScript type errors, missing type definitions
   - **Syntax**: Parse errors, unexpected tokens, malformed imports
   - **Config**: Invalid configuration, missing environment variables
   - **Runtime**: Module resolution failures, circular dependencies
4. **Delegate**: Route to Task(build-error-resolver) with parsed error context
5. **Fix**: Apply fixes in priority order (blocking errors first)
6. **Rebuild**: Re-run build command to verify fix
7. **Iterate**: If errors remain and attempts < max, return to step 2
8. **Report**: Output fix summary with before/after status

## Error Resolution Strategy

| Error Type | Resolution Approach |
|------------|-------------------|
| Dependency | Install missing packages, resolve version conflicts, update lock file |
| Type | Add type annotations, install @types packages, fix type mismatches |
| Syntax | Fix malformed code, correct import paths, resolve ESM/CJS conflicts |
| Config | Validate config files, set missing env vars, fix path aliases |
| Runtime | Resolve circular deps, fix module resolution, update import order |

## Output Format

```
BUILD FIX REPORT
================
Attempt:    [n/max]
Errors Found: [count]
Errors Fixed: [count]
Status:     [RESOLVED|PARTIAL|FAILED]

FIXES APPLIED
-------------
[1] [file:line] [error-type]
    Error: [original error message]
    Fix:   [what was changed]

REMAINING (if any)
------------------
[error details requiring manual intervention]
```
