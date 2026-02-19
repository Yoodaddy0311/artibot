# Delegation Decision Matrix

## When to Delegate

| Factor | Threshold | Action |
|--------|-----------|--------|
| Directory count | > 7 | Auto-enable parallel by directory |
| File count | > 50 AND complexity > 0.6 | Auto-enable parallel by file batch |
| Domain count | > 3 | Auto-enable parallel by focus area |
| Complexity score | > 0.8 AND scope = comprehensive | Auto-enable with focus agents |
| Token estimate | > 20K | Auto-enable with result aggregation |

## When NOT to Delegate

- Single file with < 50 lines of changes
- Trivial bug fix with known location
- Documentation-only changes
- Configuration file updates
- Tasks with strict sequential dependencies

## Agent-Task Mapping

| Task Type | Best Agent | Rationale |
|-----------|-----------|-----------|
| System architecture review | architect | Broad structural perspective |
| Code quality analysis | refactorer | Quality metrics expertise |
| Security vulnerability scan | security | OWASP and threat modeling |
| Performance bottleneck | performance | Profiling and optimization |
| Test coverage gaps | qa | Testing pyramid knowledge |
| API contract review | backend | Endpoint and contract expertise |
| UI/UX accessibility | frontend | WCAG and user experience |
| Build failure resolution | build-error-resolver | Compilation error patterns |
| Deployment planning | devops | Infrastructure and CI/CD |

## Concurrency Guidelines

| System Resources | Max Concurrent | Notes |
|-----------------|----------------|-------|
| Low (< 4GB RAM) | 3 | Conservative, prevent swapping |
| Medium (4-8GB) | 5 | Balanced performance |
| High (> 8GB) | 7 | Default maximum |
| Unlimited | 15 | Absolute maximum |

## Result Conflict Resolution

When sub-agents produce conflicting recommendations:

| Priority | Domain | Wins Over |
|----------|--------|-----------|
| 1 | Security | All others |
| 2 | Reliability | Performance, features |
| 3 | Correctness | Performance, style |
| 4 | Performance | Style, convenience |
| 5 | Style/Convention | Nothing |
