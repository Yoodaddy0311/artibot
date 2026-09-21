---
description: (Artibot) Sequential verification pipeline - lint, typecheck, test, build
argument-hint: '[target] e.g. "린트+타입+테스트 전체 검증"'
allowed-tools: [Read, Bash, Glob, Grep, TaskCreate]
toolset: code
lifecycle: verify
---

# /verify

Run the full verification pipeline sequentially: lint -> typecheck -> test -> build -> record. Stops on first failure unless `--continue` is set — the record step still runs.

## Arguments

Parse $ARGUMENTS:
- `target`: Project directory or specific file/module. Default: project root
- `--quick`: Skip build step, run only lint + typecheck + unit tests
- `--fix`: Auto-fix lint and format issues
- `--continue`: Continue pipeline on failure (report all issues)
- `--step [name]`: Run only specific step: `lint` | `typecheck` | `test` | `build`

## Execution Flow

1. **Parse**: Resolve target, detect project type and available tools. Also resolve the ABSOLUTE project root (the directory holding `.git/`) — Step 5 passes it as `--cwd`, and a record filed from the wrong directory lands in the wrong project's ledger.
2. **Detect Tools**: Identify available verification tools:
   - Lint: ESLint, Biome, Ruff, Pylint
   - Types: TypeScript (`tsc --noEmit`), mypy, Pyright
   - Test: Jest, Vitest, pytest (unit tests only for speed)
   - Build: Framework-specific build command
3. **Execute Pipeline** (sequential, order matters):

   **Step 1 - Lint**:
   - Run linter on target files
   - If `--fix`: auto-fix and re-run to confirm clean
   - Gate: Zero errors (warnings allowed)

   **Step 2 - Typecheck**:
   - Run type checker on target
   - Gate: Zero type errors

   **Step 3 - Test**:
   - Run unit tests (integration if `--quick` not set)
   - Gate: All tests pass, coverage >= 80%

   **Step 4 - Build** (skip if `--quick`):
   - Run production build
   - Gate: Build succeeds with zero errors

   **Step 5 - Record** (ALWAYS runs — this step is never skipped):
   - Runs after a stop-on-first-failure (then with `--status FAIL`), with `--continue`, with `--quick`, and with `--step`. There is no mode in which the outcome goes unrecorded.
   - `--status PASS` only when every step that ran passed; otherwise `--status FAIL`.
   - Run exactly this, filling in the three placeholders:

```
REC="$HOME/.claude/artibot/scripts/ledger/record-verify.mjs"; [ -f "$REC" ] || REC="${CLAUDE_PLUGIN_ROOT:-}/scripts/ledger/record-verify.mjs"; [ -f "$REC" ] || REC="plugins/artibot/scripts/ledger/record-verify.mjs"; if [ -f "$REC" ]; then node "$REC" --status <PASS|FAIL> --command "<one-line summary>" --session "$CLAUDE_SESSION_ID" --cwd "<project root>"; else echo "record-verify not found - outcome NOT recorded"; fi
```

   - `<project root>` is the absolute project root resolved in Step 1. `$HOME` comes first because `${CLAUDE_PLUGIN_ROOT}` can be empty in a Bash shell, and the bare relative path only resolves inside the source repository.
   - Read `recorded` from the stdout JSON, not from the exit code: the script exits 0 even when it recorded nothing, and reports the reason in the same line.
   - **Recording never changes the VERDICT.** A missing script, `recorded:false`, or any other recording failure is REPORTED in the Record row and nowhere else. It never turns a passing pipeline into BLOCKED.

4. **Report**: Output pipeline results with pass/fail per step, including the Record row

## Pipeline Behavior

- Default: Stop on first failure, report which step failed
- `--continue`: Run all steps, aggregate all failures
- `--fix`: Attempt auto-fix for lint/format issues only
- Stopping on the first failure does NOT skip Step 5 — the outcome is still recorded, with `--status FAIL`

## Output Format

```
VERIFICATION PIPELINE
=====================
Target:  [path]
Mode:    [full|quick]

RESULTS
-------
Lint .............. [PASS|FAIL] ([n] errors, [n] warnings)
Typecheck ......... [PASS|FAIL] ([n] errors)
Test .............. [PASS|FAIL] ([passed/total], coverage: [n]%)
Build ............. [PASS|FAIL|SKIPPED]
Record ............ [RECORDED|NOT RECORDED] ([verification_id or reason])

VERDICT: [ALL PASS|BLOCKED]   (the Record row never changes this)

FAILURES (if any)
-----------------
[step] [file:line] [error description]
```

## Next Steps

작업 완료 후 추천 후속 액션:

| # | 액션 | 커맨드 | 설명 |
|---|------|--------|------|
| 1 | 검증 완료 커밋 | `/git` | 검증 통과 후 커밋 및 푸시 |
| 2 | 실패 항목 개선 | `/improve` | 검증 실패 항목 코드 개선 |
| 3 | 검증 결과 기록 | `/daily` | 검증 결과 일일 리포트에 기록 |
