---
description: (Artibot) Multi-dimensional code and system analysis with agent delegation
argument-hint: '[target] e.g. "보안 취약점 분석해줘"'
allowed-tools: [Read, Glob, Grep, Bash, Task, TaskCreate]
toolset: analysis
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

## Proposal Validation Gate (분석→제안 시 필수)

분석 결과를 바탕으로 제안·개선안을 제시하기 **전에** 각 후보를 `problem-validation` 스킬 체크리스트로 검증한다:
1. 이미 존재하는가? (`file:line`으로 확인)
2. 하드 증거(실패테스트·측정값·incident)가 있는가? (분석 모델 추론만으로 NECESSARY 판정 금지)
3. YAGNI 아닌가? (현재 실제로 필요하지 않으면 REJECT)

기본값 = REJECT. 통과 후보가 0개면 "변경 불필요"로 종료. 제안 시 NECESSARY + REJECT 목록을 함께 제시한다.

## Execution Flow

1. **Parse**: Resolve target path(s). Default scope = `module` if directory, `file` if single file
2. **Context**: Read target files. Map imports, exports, dependencies. Detect framework and language
3. **Analyze**: Apply focus-specific analysis:
   - **performance**: Identify O(n^2+) algorithms, memory leaks, unnecessary re-renders, bundle size issues
   - **security**: Scan for injection vulnerabilities, hardcoded secrets, unsafe deserialization, missing auth checks
   - **quality**: Measure cyclomatic complexity, duplication ratio, test coverage gaps, naming consistency
   - **architecture**: Map dependency graph, coupling/cohesion scores, SOLID violations, circular dependencies
4. **Delegate** (if `--delegate` or scope > 50 files): Spawn sub-agents per focus domain using Task tool
5. **Verify**: Cross-reference findings with existing tests and documentation
6. **Report**: Output structured findings with severity classification

## Agent Delegation

When `--delegate` is active or auto-triggered (>50 files or >7 directories):

| Focus | Agent | Task |
|-------|-------|------|
| performance | Task(Explore) | Profile hotspots, measure complexity |
| security | Task(security-reviewer) | Vulnerability scan, threat model |
| quality | Task(code-reviewer) | Code quality metrics, style violations |
| architecture | Task(architect) | Dependency mapping, design evaluation |

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
