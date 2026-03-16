---
context: forked
name: repo-benchmarking
description: "Clones and benchmarks external git repositories against Artibot with quantified 10-dimension scoring, structural comparison, pattern extraction, and adoption recommendations. Use when user asks to compare repos, benchmark a project, analyze external code, evaluate competitors, 레포 비교, 벤치마크, 외부 레포 분석, or 채택 평가."
platforms: [claude-code, gemini-cli, codex-cli, cursor]
level: 3
triggers:
  - "repo"
  - "benchmark"
  - "compare repo"
  - "analyze repo"
  - "clone and analyze"
  - "레포 분석"
  - "벤치마크"
  - "레포 비교"
agents:
  - "repo-benchmarker"
  - "architect"
tokens: "~3K"
category: "analysis"
---

# Repo Benchmarking

## When This Skill Applies
- Evaluating an external git repository against Artibot
- Comparing architectural patterns between projects
- Identifying adoptable elements from reference projects
- Benchmarking feature completeness, quality, and innovation
- Competitive analysis of Claude Code plugins or agent frameworks

## Core Guidance

### 1. Clone and Isolation Protocol
```
Validate URL (HTTPS only) -> Sanitize repo name -> Clone to ~/.claude/artibot/repos/ -> Shallow clone (--depth 1) -> No script execution
```

**Security Rules**:
- HTTPS URLs only (reject SSH, file://, relative paths)
- Clone directory: `~/.claude/artibot/repos/[sanitized-name]/`
- Max repo size: 500MB (abort if exceeded)
- Never run npm install, make, or any script from cloned repos
- Strip shell metacharacters from repo name

### 2. Analysis Pipeline

| Phase | Action | Output |
|-------|--------|--------|
| 1. Clone | `git clone --depth 1 [url]` to isolated directory | Local repo copy |
| 2. Structure | Glob/Grep for directory tree, file counts, config files | Structure map |
| 3. Feature Inventory | Identify agents, commands, skills, hooks, libs, tests | Feature comparison table |
| 4. Deep Analysis | Read key files, identify patterns, score quality | Raw dimension scores |
| 5. Comparison | Side-by-side scoring with delta analysis | Comparison matrix |
| 6. Extraction | Identify adoptable patterns and improvements | Action items |
| 7. Report | Produce final scored report with recommendations | Benchmark report |

### 3. Evaluation Dimensions (10-point scale)

| # | Dimension | Weight | What to Measure |
|---|-----------|--------|-----------------|
| 1 | Agent Architecture | 15% | Agent count, role separation, model optimization |
| 2 | Orchestration Patterns | 15% | Team patterns, delegation strategy |
| 3 | Skill System | 10% | Skill count, reference depth, domain coverage |
| 4 | Command System | 10% | Command count, routing, argument parsing |
| 5 | Hook System | 10% | Event coverage, security hooks |
| 6 | API Integration | 10% | Agent Teams API, MCP, external tools |
| 7 | Code Quality | 10% | Modularity, error handling, zero-dep |
| 8 | Documentation | 5% | README, inline docs, architecture docs |
| 9 | CI/CD & Validation | 5% | Validation scripts, testing, CI |
| 10 | Innovation | 10% | Unique features, novel patterns |

**Total: 100 points maximum (weighted sum)**

### 4. Cache Strategy
- Cache location: `~/.claude/artibot/repos/[repo-name]/`
- Re-clone: `git pull` if cache exists (unless `--compare-only`)
- Stale threshold: 7 days (suggest refresh)
- Cleanup: Manual via `rm -rf ~/.claude/artibot/repos/[repo-name]`

### 5. Large Repo Handling
- Default: `--depth 1` (shallow clone)
- `--deep` flag: full clone for commit history analysis
- File limit: Analyze top 500 files by relevance (config > source > docs > assets)
- Directory delegation: >7 directories triggers sub-agent parallelization
- Timeout: 5 min clone, 10 min analysis (abort with partial results)

## Workflow Checklist

Copy this checklist and track progress:

```
Progress:
- [ ] Step 1: Validate and sanitize git URL (HTTPS only, no metacharacters)
- [ ] Step 2: Check cache at ~/.claude/artibot/repos/[repo-name]/
- [ ] Step 3: Clone or update repo (git clone --depth 1 or git pull)
- [ ] Step 4: Map structure — file counts, directory tree, config files
- [ ] Step 5: Build feature inventory — agents, commands, skills, hooks, libs, tests
- [ ] Step 6: Score each of 10 evaluation dimensions (evidence required per score)
- [ ] Step 7: Produce side-by-side comparison matrix with deltas
- [ ] Step 8: Identify adoptable elements with effort estimates
- [ ] Step 9: Generate prioritized recommendations
- [ ] Step 10: Output final benchmark report
```

## Human Checkpoints

### Checkpoint 1: 클론 성공 및 크기 확인 (After Step 3)
**Context**: 레포지토리 클론이 완료된 직후 시점. 크기 초과나 접근 오류가 있을 경우 이후 분석 전체가 의미 없어지므로 진행 여부를 확인해야 한다.
**Ask**: "레포 클론이 완료되었습니다. **클론 크기가 500MB 이내이고 주요 파일이 정상적으로 존재하나요?**"
**Options**:
1. Continue — 클론 정상, Step 4 구조 분석으로 진행
2. Abort — 크기 초과 또는 접근 오류, 분석 중단
3. Adjust settings — shallow clone 깊이 또는 제외 패턴 조정 후 재클론
**Default**: 1 (클론이 성공하면 대부분 진행 가능)
**Skippable**: No — 클론 실패 상태에서 분석을 진행하면 결과가 무효
**Freedom**: LOW

### Checkpoint 2: 평가 점수 공정성 승인 (After Step 6)
**Context**: 10개 차원 각각에 점수와 근거가 부여된 시점. 점수가 증거 없이 주관적으로 산정되었을 경우 벤치마크 결과 전체의 신뢰도가 떨어진다.
**Ask**: "10개 차원 점수가 산정되었습니다. **모든 점수에 파일 경로나 코드 예시 같은 구체적인 근거가 있나요?**"
**Options**:
1. Accept scores — 점수와 근거 확인, Step 7 비교 매트릭스 생성으로 진행
2. Override specific dimension — 특정 차원의 점수와 근거를 수정
**Default**: 1 (증거 기반 점수는 수락)
**Skippable**: No — 근거 없는 점수는 채택 추천의 신뢰성을 훼손
**Freedom**: LOW

### Checkpoint 3: 채택 요소 우선순위 선택 (After Step 8)
**Context**: 채택 가능한 패턴과 개선 요소가 도출된 시점. 노력 대비 효과를 고려해 지금 채택할지, 나중으로 미룰지, 건너뛸지 판단이 필요하다.
**Ask**: "채택 후보 요소가 식별되었습니다. **각 요소를 어떻게 처리하시겠나요?**"
**Options**:
1. Adopt now — 즉시 구현 계획 수립 및 적용
2. Plan for later — 백로그에 추가, 향후 스프린트에서 처리
3. Skip — 현재 Artibot에 불필요하거나 적합하지 않음
**Default**: 2 (즉시 결정이 어려울 경우 백로그 추가가 안전)
**Skippable**: Yes (기본값 사용) — 모든 항목을 Plan for later로 처리
**Freedom**: HIGH

## Freedom Levels

| Step | Freedom | Guidance |
|------|:-------:|----------|
| URL validation | LOW | HTTPS only, sanitization rules are strict |
| Clone strategy | LOW | --depth 1 default, isolation directory fixed |
| Structure mapping | MEDIUM | Can adapt scan patterns to repo layout |
| Feature inventory | MEDIUM | Map to closest Artibot equivalents |
| Dimension scoring | LOW | 10 dimensions with defined weights are fixed |
| Score justification | HIGH | Evidence selection is judgment-based |
| Adoption recommendations | HIGH | Priority and effort are judgment calls |
| Report format | LOW | Template is defined |

## Quick Reference
- Clone to `~/.claude/artibot/repos/` (never into project dir)
- HTTPS only, no script execution from cloned repos
- 10-dimension scoring (100 points max, weighted)
- Use `--quick` for structure-only, `--deep` for full analysis
- `--compare-only` reuses cached clone
- repo-benchmarker agent handles the heavy analysis
- All scores require evidence (file paths, code examples)
