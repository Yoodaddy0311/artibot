---
description: (Artibot) Adversarial code review from attacker's perspective using code-reviewer + security-reviewer agents
argument-hint: '[target] e.g. "src/ 적대적 리뷰해줘"'
allowed-tools: [Read, Glob, Grep, Bash, Task, TaskCreate]
---

# /adversarial-review

코드를 공격자 관점에서 리뷰하여 취약점, 엣지 케이스, 설계 결함을 탐지한다. code-reviewer와 security-reviewer 에이전트를 병렬 활용한다.

## Arguments

Parse $ARGUMENTS:
- `target`: File path, directory, or git diff range (e.g., `HEAD~3..HEAD`)
- `--scope [area]`: Focus area - `input` | `auth` | `data` | `error` | `race` | `config` | `deps` | `all` (default: `all`)
- `--strict`: Treat MEDIUM issues as blocking
- `--diff-only`: Review only changed lines (git diff context)
- `--json`: Output in `review-output.schema.json` format

## Execution Flow

1. **Parse**: Resolve target. If git range provided, extract changed files via `git diff`
2. **Recon**: Read target files. Identify entry points, trust boundaries, sensitive assets
3. **Delegate (parallel)**:
   - Task(code-reviewer): Logic flaws, edge cases, error handling gaps
   - Task(security-reviewer): OWASP Top 10, injection vectors, auth bypass, secret exposure
4. **Attack Surface Map**: Identify all external input entry points and trace data flow
5. **Exploit Analysis**: For each attack surface, construct concrete attack scenarios
6. **Classify**: Categorize each finding by severity:
   - **CRITICAL**: RCE, SQL injection, secret exposure, auth bypass, data exfiltration
   - **HIGH**: XSS, CSRF, broken auth, race conditions, privilege escalation
   - **MEDIUM**: Missing rate limiting, verbose errors, weak validation, TOCTOU
   - **LOW**: Missing security headers, outdated deps, info disclosure in logs
   - **INFO**: Best practice recommendations, defense-in-depth suggestions
7. **Merge**: Deduplicate findings from both agents, keep highest severity
8. **Report**: Output adversarial review with attack scenarios and fix recommendations

## Attack Surface Checklist

| Surface | Checks |
|---------|--------|
| Input Validation | Injection (SQL, NoSQL, command, LDAP), type coercion, buffer overflow, path traversal |
| Authentication | Bypass, brute force, credential stuffing, session fixation, token replay |
| Authorization | Privilege escalation, IDOR, missing access checks, role confusion |
| Data Flow | Sensitive data in logs, unencrypted transmission, insecure serialization |
| Error Handling | Stack traces exposed, fail-open behavior, error-based information leak |
| Race Conditions | TOCTOU, atomicity violations, double-spend, deadlock potential |
| Configuration | Hardcoded secrets, debug mode, excessive CORS, default credentials |
| Dependencies | Known CVEs, excessive permissions, supply chain risks |

## Output Format

```
ADVERSARIAL REVIEW
==================
Target:     [path or diff range]
Files:      [count reviewed]
Scope:      [focus area]
Approach:   Attacker's Perspective

ATTACK SURFACE ANALYSIS
-----------------------
Entry Points: [count]
Trust Boundaries: [count]
[Summary of attack surface]

FINDINGS
--------
CRITICAL [count]
  [file:line] [confidence:high|medium|low]
    Attack: [specific attack scenario]
    Impact: [what an attacker gains]
    Fix: [concrete remediation]

HIGH [count]
  [file:line] [confidence:high|medium|low]
    Attack: [attack scenario]
    Impact: [impact description]
    Fix: [remediation]

MEDIUM [count]
  [file:line] [description]
    Fix: [recommendation]

LOW [count]
  [file:line] [description]

INFO [count]
  [file:line] [description]

VERDICT: [PASS|FAIL|WARNING]
Blocking Issues: [count of critical+high]
```

`--json` 플래그 사용 시 `plugins/artibot/schemas/review-output.schema.json` 스키마에 맞춘 JSON 출력.

## Next Steps

작업 완료 후 추천 후속 액션:

| # | 액션 | 커맨드 | 설명 |
|---|------|--------|------|
| 1 | 취약점 수정 | `/improve` | 발견된 취약점 코드 수정 |
| 2 | 보안 테스트 추가 | `/tdd` | 공격 시나리오 기반 테스트 작성 |
| 3 | 일반 코드 리뷰 | `/code-review` | 보안 외 품질 관점 추가 리뷰 |
| 4 | 커밋 | `/git` | 수정 반영 후 커밋 및 푸시 |
