---
name: quality-framework
description: "ATLAS Quality Framework for Artibot: Automated, Tested, Learned, Adaptive, Secure. Defines 8-step validation cycle, coverage targets, and GRPO-driven continuous quality improvement."
level: 3
triggers:
  - "quality"
  - "quality framework"
  - "ATLAS"
  - "validation cycle"
  - "coverage"
  - "quality gate"
  - "code review"
  - "quality standards"
  - "testing standards"
  - "security validation"
  - "performance standards"
  - "quality metrics"
agents:
  - "tdd-guide"
  - "security-reviewer"
  - "performance-engineer"
  - "refactor-cleaner"
tokens: "~5K"
category: "code-quality"
platforms: [claude-code, gemini-cli, codex-cli, cursor]
---

# ATLAS Quality Framework

**Automated | Tested | Learned | Adaptive | Secure**

Artibot's integrated quality framework combining evidence-based validation, GRPO self-learning, and knowledge transfer for continuous quality improvement.

## When This Skill Applies
- Code review and quality assessment
- Defining acceptance criteria for features
- Setting up CI/CD quality gates
- Post-implementation validation
- Security and performance audits
- Coverage analysis and improvement

## ATLAS Dimensions

### A - Automated
Quality validation runs automatically, not as an afterthought.
- CI/CD gates block merges on quality failures
- Lint and type checking on every save
- Test execution on every commit
- Security scanning on every PR
- Performance regression detection on every deploy

### T - Tested
Evidence-based testing with measurable coverage targets.

| Level | Target | Scope |
|-------|--------|-------|
| Unit | >= 80% | Functions, pure logic, utilities |
| Integration | >= 70% | API endpoints, database operations |
| E2E | Critical paths | User workflows, conversion flows |
| Type coverage | 100% | No `any`, no untyped exports |
| Security | OWASP Top 10 | All input surfaces |

### L - Learned
GRPO self-learning continuously improves quality decisions.
- Tool usage patterns tracked per context type
- Success rates compared across alternative approaches
- Group relative policy optimization ranks strategies
- Knowledge base updated after each session
- Patterns propagated via swarm intelligence (opt-in)

### A - Adaptive
Quality standards evolve with the codebase complexity.
- Thresholds adjust based on project phase (prototype vs production)
- Risk-weighted coverage (critical paths get higher targets)
- Context-aware validation depth (--think for complex changes)
- Wave orchestration for comprehensive quality sweeps

### S - Secure
Security validation integrated into every quality check.
- OWASP Top 10 checklist on every PR
- Secret scanning before every commit
- Dependency vulnerability audit weekly
- Authorization checks on all API endpoints
- Input sanitization validated at system boundaries

## 8-Step Validation Cycle

```
Step 1: SYNTAX
  ├─ Language parser validation
  ├─ Linter checks (ESLint, ruff, golangci-lint, clippy)
  └─ Formatter compliance (Prettier, Black, gofmt, rustfmt)

Step 2: TYPES
  ├─ Type checker (tsc, mypy --strict, go vet, cargo check)
  ├─ No implicit any or untyped exports
  └─ API contract type safety

Step 3: LINT
  ├─ Code style rules
  ├─ Complexity metrics (cyclomatic <= 10, cognitive <= 15)
  └─ Naming conventions enforced

Step 4: SECURITY
  ├─ OWASP Top 10 scan
  ├─ Secret detection (no hardcoded credentials)
  ├─ Dependency vulnerability audit
  └─ Input validation at all boundaries

Step 5: TESTS
  ├─ Unit test execution (target: >= 80%)
  ├─ Integration test execution (target: >= 70%)
  ├─ E2E tests for critical paths
  └─ Regression suite passes

Step 6: PERFORMANCE
  ├─ Response time within budget (<200ms API, <3s page load)
  ├─ Bundle size check (<500KB initial)
  ├─ Memory usage within limits
  └─ No N+1 queries introduced

Step 7: DOCUMENTATION
  ├─ Public API documented
  ├─ README updated if behavior changed
  ├─ CHANGELOG entry for user-facing changes
  └─ Architecture decisions recorded if significant

Step 8: INTEGRATION
  ├─ No breaking changes without versioning
  ├─ Feature flags for risky rollouts
  ├─ Monitoring and alerting configured
  └─ Rollback procedure verified
```

**Blocking steps**: 1, 2, 4, 5 (must pass to merge)
**Warning steps**: 3, 6, 7, 8 (flag for review, don't block)

## Quality Metrics Dashboard

### Code Health Indicators
| Metric | Green | Yellow | Red |
|--------|-------|--------|-----|
| Unit coverage | >= 80% | 60-80% | < 60% |
| Cyclomatic complexity | <= 10 | 11-20 | > 20 |
| Technical debt ratio | < 5% | 5-15% | > 15% |
| Security vulnerabilities (critical) | 0 | - | > 0 |
| Dependency age | < 6mo | 6-12mo | > 12mo |
| Test flakiness rate | 0% | < 2% | >= 2% |

### Performance Budgets
| Layer | Target | Max |
|-------|--------|-----|
| API response | < 100ms | 200ms |
| Page load (3G) | < 2s | 3s |
| Bundle (initial) | < 300KB | 500KB |
| Database query | < 50ms | 100ms |
| Memory (server) | < 256MB | 512MB |

## GRPO Quality Improvement Loop

Artibot uses Group Relative Policy Optimization for quality strategy selection:

```
1. OBSERVE: Record quality issue type, context, and outcome
2. COMPARE: Group similar issues, compare resolution strategies
3. RANK: Score strategies by success rate (resolved + no regression)
4. UPDATE: Increase weight for high-scoring strategies
5. APPLY: Prefer high-weight strategies in similar future contexts
6. TRANSFER: Share learned patterns across sessions (continuous-learning skill)
```

**Example learning**:
- Context: "TypeScript null reference errors in API handlers"
- Strategies compared: `Optional chaining`, `Explicit null checks`, `Result type`
- Winner (highest success rate): `Result type` pattern
- Future: Suggest `Result type` first for this context

## Knowledge Transfer Protocol

After completing any significant quality improvement:

1. **Pattern extraction**: What worked well?
2. **Root cause**: Why was quality issue introduced?
3. **Prevention**: What process prevents recurrence?
4. **Generalization**: Where else in the codebase could this apply?
5. **Documentation**: Update memory files if pattern is reusable

## Quality Gate Integration

### PR Checklist (Automated)
```yaml
quality_gates:
  required:
    - lint: "npm run lint && tsc --noEmit"
    - test: "npm test -- --coverage --threshold 80"
    - security: "npm audit --audit-level=high"
  recommended:
    - complexity: "eslint --rule 'complexity: [warn, 10]'"
    - performance: "bundlesize check"
    - docs: "typedoc --validation"
```

### Manual Review Checklist
- [ ] Business logic correct per requirements
- [ ] Edge cases tested (empty, null, max, concurrent)
- [ ] Error messages user-friendly and non-leaking
- [ ] Database queries optimized (no N+1)
- [ ] Breaking change documented and versioned
- [ ] Feature flag for risky changes

## Quick Reference

**Validation order**: Syntax -> Types -> Lint -> Security -> Tests -> Performance -> Docs -> Integration

**Coverage formula**:
```
Priority Weight = (Business Impact × 0.4) + (Change Frequency × 0.3) + (Complexity × 0.3)
Coverage Target = Base(70%) + (Priority Weight × 30%)
```

**Complexity thresholds**:
- Cyclomatic: <= 10 (simple), 11-15 (refactor), > 15 (must refactor)
- Cognitive: <= 15 (ok), 16-25 (warning), > 25 (block)
- Function length: <= 50 lines (ok), 51-100 (warning), > 100 (split)

**When to escalate**:
- Any critical security vulnerability -> Stop, fix immediately
- Coverage drops > 5% from baseline -> Require test additions
- Performance regression > 20% -> Block and investigate
