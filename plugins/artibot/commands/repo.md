---
description: (Artibot) Clone and benchmark external git repos against Artibot with scored comparison
argument-hint: '[git-url] e.g. "https://github.com/org/repo --deep"'
allowed-tools: [Read, Glob, Grep, Bash, Task, TaskCreate]
---

# /repo

Clone an external git repository, analyze its structure and capabilities, and produce a quantified comparison against the current Artibot build. Git clone is performed directly at command level; analysis is delegated to the `repo-benchmarker` agent.

## Arguments

Parse $ARGUMENTS:
- `url`: Git repository URL (HTTPS only — SSH and local paths blocked for security)
- `--focus [area]`: Limit analysis — `agents`, `commands`, `skills`, `hooks`, `architecture`, `quality`, `innovation`
- `--deep`: Full dependency mapping + code quality metrics (default: structure + feature inventory)
- `--quick`: Structure-only scan, skip code quality and innovation scoring
- `--compare-only`: Skip clone, use already-cloned repo at `~/.claude/artibot/repos/[repo-name]`
- `--skip-clone`: Alias for `--compare-only`
- `--output [format]`: `table` (default) | `json` | `markdown`

## Security

1. **URL Validation**: HTTPS only. Reject SSH (`git@`), `file://`, relative paths, and non-git URLs
2. **Clone Isolation**: Clone to `~/.claude/artibot/repos/[sanitized-repo-name]/` (never into project directory)
3. **Depth Limit**: `git clone --depth 1` by default (full clone only with `--deep`)
4. **Size Guard**: Abort if repo exceeds 500MB (configurable)
5. **No Execution**: Never run scripts, Makefiles, or install dependencies from cloned repos
6. **Sanitized Paths**: Strip `..`, shell metacharacters, and null bytes from repo name

## Execution Flow

1. **Validate**: Parse and validate git URL. Check security constraints. Sanitize repo name for directory path
2. **Clone** (command-level Bash):
   - Check cache at `~/.claude/artibot/repos/[repo-name]/`
   - If found and `--compare-only`: skip clone, use cached
   - If found and no flag: run `git -C [path] pull` to update
   - If not found: run `git clone --depth 1 [url] [path]`
   - Verify clone success before proceeding
3. **Load Context**: Scan cloned repo structure — directory tree, config files, file counts, framework detection
4. **Delegate Analysis**: Spawn `repo-benchmarker` agent via Task tool with:
   - Target repo path
   - Artibot repo path (`plugins/artibot/`)
   - Focus area (if specified)
   - Analysis depth (`quick` | `standard` | `deep`)
5. **Receive Results**: repo-benchmarker produces 10-dimension scored comparison
6. **Enrich**: Add improvement suggestions with adoption effort estimates (LOW/MEDIUM/HIGH)
7. **Report**: Output final benchmark report in requested format

## Agent Delegation

| Phase | Agent | Task |
|-------|-------|------|
| Structure Analysis | Task(Explore) | Map directory tree, file counts, config files |
| Deep Analysis | Task(repo-benchmarker) | 10-dimension scoring, pattern extraction |
| Architecture Review | Task(architect) | Design pattern comparison (if `--deep`) |
| Quality Metrics | Task(code-reviewer) | Code quality comparison (if `--deep`) |

## Output Format

```
REPO BENCHMARK: [repo-name]
============================
Source:     [git-url]
Cloned:    [path] ([cached|fresh])
Artibot:   v[version]
Date:      [date]
Mode:      [quick|standard|deep]
Focus:     [area or "all"]

STRUCTURE COMPARISON
────────────────────
Metric          | Artibot | Target | Delta
────────────────|─────────|────────|──────
Agents          | [n]     | [n]    | [+/-]
Commands        | [n]     | [n]    | [+/-]
Skills          | [n]     | [n]    | [+/-]
Hooks           | [n]     | [n]    | [+/-]
Lib modules     | [n]     | [n]    | [+/-]
Test files      | [n]     | [n]    | [+/-]
Total files     | [n]     | [n]    | [+/-]

SCORE COMPARISON (10-point scale)
─────────────────────────────────
Dimension              | Artibot | Target | Delta | Winner
───────────────────────|─────────|────────|───────|────────
Agent Architecture     | [0-10]  | [0-10] | [+/-] | [A|T|=]
Orchestration Patterns | [0-10]  | [0-10] | [+/-] | [A|T|=]
Skill System           | [0-10]  | [0-10] | [+/-] | [A|T|=]
Command System         | [0-10]  | [0-10] | [+/-] | [A|T|=]
Hook System            | [0-10]  | [0-10] | [+/-] | [A|T|=]
API Integration        | [0-10]  | [0-10] | [+/-] | [A|T|=]
Code Quality           | [0-10]  | [0-10] | [+/-] | [A|T|=]
Documentation          | [0-10]  | [0-10] | [+/-] | [A|T|=]
CI/CD & Validation     | [0-10]  | [0-10] | [+/-] | [A|T|=]
Innovation             | [0-10]  | [0-10] | [+/-] | [A|T|=]
───────────────────────|─────────|────────|───────|────────
WEIGHTED TOTAL         | [0-100] | [0-100]| [+/-] | [A|T|=]

ADOPTABLE ELEMENTS
──────────────────
[1] [element]: [description] → Effort: [LOW|MEDIUM|HIGH]

ARTIBOT ADVANTAGES
──────────────────
[1] [element]: [why stronger]

RECOMMENDATIONS
───────────────
Priority | Action                    | Effort | Impact
---------|---------------------------|--------|--------
P1       | [action]                  | [L/M/H]| [L/M/H]
```

## Next Steps

작업 완료 후 추천 후속 액션:

| # | 액션 | 커맨드 | 설명 |
|---|------|--------|------|
| 1 | 심층 분석 | `/analyze` | 벤치마크 결과 심층 분석 |
| 2 | 패턴 구현 | `/implement` | 채택 가능 패턴 구현 시작 |
| 3 | 개선 계획 | `/plan` | 벤치마크 기반 개선 로드맵 |
