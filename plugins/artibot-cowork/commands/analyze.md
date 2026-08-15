---
description: (Artibot) Multi-dimensional code and system analysis with agent delegation
argument-hint: '[target] e.g. "보안 취약점 분석해줘"'
allowed-tools: [Read, Glob, Grep, Bash, Agent, TaskCreate]
---

# /analyze

Deep analysis of code, modules, or systems. Supports focused analysis domains and agent delegation for large-scope operations.

## Arguments

Parse $ARGUMENTS:
- `target`: File path, directory, module name, or `@<path>` reference
- `--focus [domain]`: Analysis domain - `performance`, `security`, `quality`, `architecture`
- `--scope [level]`: `file` | `module` | `project` | `system`
- `--delegate`: Enable sub-agent delegation for large codebases
- `--think` | `--think-hard` | `--ultrathink`: Analysis depth control

## Execution Flow

1. **Parse**: Resolve target path(s). Default scope = `module` if directory, `file` if single file
2. **Context**: Read target files. Map imports, exports, dependencies. Detect framework and language
3. **Analyze**: Apply focus-specific analysis:
   - **performance**: Identify O(n^2+) algorithms, memory leaks, unnecessary re-renders, bundle size issues
   - **security**: Scan for injection vulnerabilities, hardcoded secrets, unsafe deserialization, missing auth checks
   - **quality**: Measure cyclomatic complexity, duplication ratio, test coverage gaps, naming consistency
   - **architecture**: Map dependency graph, coupling/cohesion scores, SOLID violations, circular dependencies
4. **Delegate** (if `--delegate` or scope > 50 files): Spawn sub-agents per focus domain using the Agent tool
5. **Verify**: Cross-reference findings with existing tests and documentation
6. **Report**: Output structured findings with severity classification

## Agent Delegation

When `--delegate` is active or auto-triggered (>50 files or >7 directories):

| Focus | Agent | Task |
|-------|-------|------|
| performance | Agent(Explore) | Profile hotspots, measure complexity |
| security | Agent(security-reviewer) | Vulnerability scan, threat model |
| quality | Agent(code-reviewer) | Code quality metrics, style violations |
| architecture | Agent(architect) | Dependency mapping, design evaluation |

## Output Format

Use GFM markdown tables:

**Summary**

| 항목 | 값 |
|------|-----|
| Target | [path/module] |
| Scope | [file/module/project] |
| Focus | [domain] |
| Severity | CRITICAL: n, HIGH: n, MEDIUM: n, LOW: n |

**Findings**

| Severity | Category | Location | Issue | Impact | Fix |
|----------|----------|----------|-------|--------|-----|
| [SEV] | [category] | [file:line] | [description] | [impact] | [recommendation] |

**Metrics**

| Metric | Value | Trend |
|--------|-------|-------|
| [metric] | [value] | [trend] |

## Next Steps

작업 완료 후 추천 후속 액션:

| # | 액션 | 커맨드 | 설명 |
|---|------|--------|------|
| 1 | 개선 적용 | `/improve` | 분석 결과 기반 코드 개선 |
| 2 | 리팩토링 계획 | `/plan` | 개선 사항 구현 계획 수립 |
| 3 | 테스트 보강 | `/test` | 발견된 취약점 테스트 추가 |
| 4 | 변경사항 커밋 | `/git` | 개선 사항 커밋 및 푸시 |
