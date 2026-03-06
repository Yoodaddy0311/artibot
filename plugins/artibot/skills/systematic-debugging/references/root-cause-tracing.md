# Root Cause Tracing Techniques

## Binary Search Debugging

Narrow down the failure point by halving the search space:

1. **Temporal bisection** (`git bisect`): Find the exact commit that introduced the bug
   ```bash
   git bisect start
   git bisect bad          # current commit is broken
   git bisect good <hash>  # known good commit
   # Git checks out midpoint — test and mark good/bad until found
   ```

2. **Code path bisection**: Add assertions at midpoints of the execution path
   - If assertion passes at midpoint, bug is in the second half
   - If assertion fails at midpoint, bug is in the first half
   - Repeat until you find the exact divergence point

## Stack Trace Analysis

Read stack traces from **bottom to top** (most recent call last):

1. Start at the top (most recent frame) — this is where the error was thrown
2. Walk down to find the first frame in YOUR code (skip library/framework frames)
3. That frame is your primary investigation target
4. Check the frame above it for the caller context

## State Inspection

When the bug involves corrupted or unexpected state:

1. **Snapshot state** at key points: log `JSON.stringify(obj)` before and after operations
2. **Diff snapshots**: compare expected vs actual state at each point
3. **Find the mutation**: identify where state first diverges from expectation
4. **Check for aliases**: two variables pointing to the same object can cause surprise mutations

## Common Root Cause Patterns

| Symptom | Likely Root Cause | Investigation |
|---------|-------------------|---------------|
| Works locally, fails in CI | Environment difference | Compare Node version, env vars, file paths |
| Intermittent failure | Race condition or timing | Add delays/locks, check async ordering |
| Works first time, fails on repeat | State leak between runs | Check module-level state, missing cleanup |
| Correct logic, wrong output | Type coercion or encoding | Check string vs number, UTF-8, path separators |
| Error in unrelated code | Shared mutable state | Trace the object's mutation history |
| "Cannot read property of undefined" | Missing null check or wrong path | Trace data flow to find where undefined originates |

## The 5 Whys

For complex bugs, ask "why" repeatedly to drill past symptoms:

1. **Why** did the test fail? — The API returned 500.
2. **Why** did the API return 500? — The database query threw an error.
3. **Why** did the query throw? — The table column was missing.
4. **Why** was the column missing? — The migration didn't run.
5. **Why** didn't the migration run? — The deploy script skips migrations in staging.

Root cause: deploy script configuration, not the API code.
