---
description: Systematic problem investigation with root cause analysis
argument-hint: '[symptoms] e.g. "타임아웃 에러 원인 분석"'
allowed-tools: [Read, Glob, Grep, Bash, Task, TodoWrite]
---

# /troubleshoot

Systematic investigation of bugs, errors, and unexpected behavior. Follows evidence-based methodology to identify root causes rather than symptoms.

## Arguments

Parse $ARGUMENTS:
- `symptoms`: Error message, unexpected behavior description, or stack trace
- `--scope [level]`: Investigation scope - `file` | `module` | `project` (default: auto-detect from symptoms)
- `--error [message]`: Exact error message or code for targeted search
- `--reproduce`: Attempt to reproduce the issue before investigating
- `--think` | `--think-hard`: Analysis depth control

## Investigation Methodology

1. **Reproduce**: Confirm the issue exists and is reproducible
2. **Isolate**: Narrow scope to smallest reproducible case
3. **Hypothesize**: Form testable hypotheses about root cause
4. **Test**: Validate or eliminate each hypothesis with evidence
5. **Fix**: Address root cause, not symptoms
6. **Verify**: Confirm fix resolves issue without regressions

## Execution Flow

1. **Parse**: Extract symptoms, error messages, affected components
2. **Gather Evidence**:
   - Search for error message in codebase (Grep)
   - Read stack trace files and surrounding context
   - Check recent changes (`git log --oneline -20`, `git diff`)
   - Identify related test files and their status
3. **Analyze**:
   - Map error to source location(s)
   - Trace data flow and call chain
   - Check for common patterns:
     - Null/undefined access
     - Type mismatches
     - Race conditions / async timing
     - Missing error handling
     - Configuration drift
     - Dependency version conflicts
4. **Delegate** (if complex): Route to specialized agent via Task tool:
   - Build errors -> Task(build-error-resolver)
   - Security issues -> Task(security-reviewer)
   - Performance regressions -> Task(Explore) with performance focus
5. **Root Cause**: Identify the underlying cause with evidence chain
6. **Fix Recommendation**: Provide specific, actionable fix with code location
7. **Report**: Output investigation summary

## Evidence Chain

All conclusions must be traceable:
```
Symptom: [what user observes]
  -> Evidence: [file:line, log output, test result]
  -> Hypothesis: [potential cause]
  -> Validation: [how hypothesis was tested]
  -> Root Cause: [confirmed underlying issue]
  -> Fix: [specific code change]
```

## Output Format

```
INVESTIGATION REPORT
====================
Symptom:    [description]
Scope:      [file|module|project]
Status:     [ROOT_CAUSE_FOUND|INVESTIGATING|NEEDS_MORE_INFO]

EVIDENCE
--------
1. [evidence description] ([source: file:line | command output])
2. [evidence description] ([source])

HYPOTHESES
----------
[CONFIRMED] [hypothesis] - [evidence supporting]
[ELIMINATED] [hypothesis] - [evidence against]

ROOT CAUSE
----------
[description of underlying issue]
Location: [file:line]
Trigger: [what causes the issue]

FIX
---
[specific code change or action to resolve]
Confidence: [HIGH|MEDIUM|LOW]
Regression Risk: [HIGH|MEDIUM|LOW]
```
