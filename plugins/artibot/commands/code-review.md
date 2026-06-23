---
description: (Artibot) Code review with severity classification using code-reviewer agent
argument-hint: '[target] e.g. "src/ 코드 리뷰해줘"'
allowed-tools: [Read, Glob, Grep, Bash, Task, TaskCreate]
toolset: code
---

# /code-review

Structured code review using the code-reviewer agent. Classifies findings by severity and provides actionable fix recommendations.

## Arguments

Parse $ARGUMENTS:
- `target`: File path, directory, or git diff range (e.g., `HEAD~3..HEAD`)
- `--focus [domain]`: Narrow review focus - `security` | `quality` | `performance` | `all` (default: `all`)
- `--strict`: Treat MEDIUM issues as blocking
- `--diff-only`: Review only changed lines (git diff context)

## Execution Flow

1. **Parse**: Resolve target. If git range provided, extract changed files via `git diff`
2. **Context**: Read target files. Identify language, framework, existing patterns
3. **Delegate**: Route to Task(code-reviewer) with file content and focus area
4. **Classify**: Categorize each finding by severity:
   - **CRITICAL**: Security vulnerabilities, data loss risks, crash-causing bugs
   - **HIGH**: Logic errors, missing error handling, race conditions, type unsafety
   - **MEDIUM**: Code smells, duplication, poor naming, missing tests
   - **LOW**: Style inconsistencies, minor optimization opportunities, documentation gaps
5. **Prioritize**: Order findings by severity, then by file location
6. **Report**: Output review with fix recommendations per finding

## Review Checklist

| Category | Checks |
|----------|--------|
| Security | Injection, secrets, auth, input validation, XSS, CSRF |
| Correctness | Logic errors, edge cases, null checks, error handling |
| Quality | Complexity, duplication, naming, file size (<800 lines) |
| Performance | O(n^2+) algorithms, memory leaks, unnecessary re-renders |
| Patterns | Immutability, SOLID violations, framework conventions |
| Tests | Coverage gaps, missing edge case tests, test isolation |

## Output Format

```
CODE REVIEW
===========
Target:    [path or diff range]
Files:     [count reviewed]
Focus:     [domain]

FINDINGS
--------
CRITICAL [count]
  [file:line] [description]
    Fix: [recommendation]

HIGH [count]
  [file:line] [description]
    Fix: [recommendation]

MEDIUM [count]
  [file:line] [description]

LOW [count]
  [file:line] [description]

VERDICT: [APPROVE|REQUEST_CHANGES|BLOCK]
Blocking Issues: [count]
```

## Grounding: fix-mandatory 강등규칙

CRITICAL/HIGH 발견은 반드시 구체적 수정안(`Fix`)을 동반해야 한다. 수정안을 제시할 수 없는 CRITICAL/HIGH 발견은 확정 blocker로 보고하지 말고 investigation 수준으로 강등(또는 `confidence: low` 표기)하라 — 수정 경로를 모르는 결함은 아직 입증되지 않은 가설이다. 이는 `schemas/review-output.schema.json`에서 `severity`가 critical/high일 때 `suggestion`이 조건부 required인 것과 일치하며, 4개 리뷰어(code/quality/spec/security-reviewer)가 공유하는 동일 규율이다.

## Structured JSON Output

리뷰 결과는 반드시 `schemas/review-output.schema.json` 스키마를 준수하여 구조화된 JSON 출력을 포함할 것. 핵심 필드: `verdict` (pass/fail/warning), `findings[]` (severity, file, line, confidence, description, suggestion), `next_steps[]`.

## Next Steps

작업 완료 후 추천 후속 액션:

| # | 액션 | 커맨드 | 설명 |
|---|------|--------|------|
| 1 | 지적사항 개선 | `/improve` | 리뷰 지적사항 코드 개선 |
| 2 | 테스트 추가 | `/test` | 리뷰에서 발견된 갭 테스트 보강 |
| 3 | 커밋 | `/git` | 리뷰 반영 후 커밋 및 푸시 |
