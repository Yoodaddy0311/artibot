---
description: (Artibot) 일일 회고 리포트 - 오늘의 작업/결정/다음 단계를 구조화된 대시보드로 출력
argument-hint: '[--save] [--date 2026-02-27] [--quick]'
allowed-tools: [Read, Bash, Glob, Grep, TaskList, TaskGet, Write]
---

# /daily

Daily retrospective report. Collects git activity, quality metrics, task status, and worklog entries to produce a structured review dashboard. Inspired by Claude Code's `/insights` but focused on a single day's developer activity.

Also routed from: `/recap`, natural language "회고", "일일 보고", "오늘 작업", "오늘 뭐 했지"

## Arguments

Parse $ARGUMENTS:
- `--save`: Write clean markdown report to `memory/daily/YYYY-MM-DD.md`
- `--date [YYYY-MM-DD]`: Target date (default: today)
- `--quick`: Skip quality section (npm test + eslint) for faster output (<5s)
- `--no-tasks`: Skip TaskList collection
- `--verbose`: Include full file list in commit details

## Execution Flow

### Phase 1: Parallel Data Collection (~2s)

Run ALL of the following in a single message (parallel, no dependencies):

1. **Git metadata**:
   ```bash
   git branch --show-current && git rev-parse --short HEAD
   ```

2. **Commit log** (today or target date):
   ```bash
   git log --since="${DATE} 00:00:00" --until="${DATE} 23:59:59" --format="%h|%ad|%s" --date=format:"%H:%M"
   ```

3. **File change stats** (lines added/removed per file):
   ```bash
   git log --since="${DATE} 00:00:00" --until="${DATE} 23:59:59" --numstat --format=""
   ```

4. **Working tree status**:
   ```bash
   git status --porcelain
   ```

5. **Worklog**: Read `~/.claude/projects/<project-slug>/memory/worklog.md`

6. **Tasks**: TaskList tool (skip if `--no-tasks`)

### Phase 2: Quality Collection (~15s)

**Skip entirely if `--quick` OR `--date` is not today.**

Sequential with timeouts:

7. **Tests** (timeout: 20s):
   ```bash
   cd <project-root> && npm test 2>&1 | tail -5
   ```
   Parse: test count, pass count, fail count, coverage percentages.
   On timeout: report `⚠️ TIMEOUT`.

8. **Lint** (timeout: 10s):
   ```bash
   cd <project-root> && npm run lint 2>&1 | tail -3
   ```
   Parse: error count, warning count.
   On timeout or not configured: report `⚠️ 미설정`.

### Phase 3: Synthesis and Render (~1s)

1. **Parse commit log**: Split each line by `|` → time, type (from conventional commit prefix), description
2. **Aggregate numstat by directory**: Group by top-level directory (`lib/`, `commands/`, `tests/`, `agents/`, `skills/`, `rules/`, other). Sum additions and deletions. Pick top 2 files per directory as "주요 파일".
3. **Parse worklog**: Find section matching `## ${DATE}` in worklog.md. Extract 작업/결정/보류 subsections. If no matching date: show "해당 날짜의 세션 기록 없음".
4. **Generate Next Steps** using the algorithm below.
5. **Render** all sections using the Output Format template.
6. **If `--save`**: Strip ANSI header, replace with `# Daily Retrospective: YYYY-MM-DD`, write to `memory/daily/${DATE}.md`. Create `daily/` directory if needed.

## Next Steps Algorithm

Combine data from multiple sources with priority ranking:

| Priority | Source | Condition |
|----------|--------|-----------|
| **P1** | TaskList | Tasks with status = `in_progress` |
| **P1** | Worklog 보류 | Items containing "urgent", "blocker", "critical" |
| **P2** | TaskList | Tasks with status = `pending` AND blockedBy = empty |
| **P2** | Worklog 보류 | All remaining 보류 items |
| **P3** | Git status | Modified but uncommitted files (count, not list) |
| **P3** | Quality | Test failures or lint errors detected |

**Rules**:
- Display top 5 items maximum
- Sort by priority, then by source order
- Every item must cite its source in the 근거 column
- If no items from any source: show "다음 단계 없음 — 오늘 작업 완료!"

## Output Format

### Header

Render an ANSI-colored box using `lib/core/tui.js` patterns (BOX characters + color function):

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  DAILY RETROSPECTIVE                                    2026-02-27 Thu      │
│  master @ a1b2c3d                                                           │
└──────────────────────────────────────────────────────────────────────────────┘
```

- Title: cyan + bold
- Date: white
- Branch: gray
- Box frame: cyan
- Width: min(terminal width, 80)

### Body

All body sections use pure GFM markdown (NO ANSI colors inside tables — they break column alignment). Follow `artibot-report` output style.

#### Section 1: 커밋 요약

```markdown
## 커밋 요약

**N개 커밋** · **+NNN / -NNN 라인** · **N개 파일 변경**

| # | 시간 | 타입 | 설명 | 파일 수 |
|---|------|------|------|---------|
| 1 | HH:MM | feat | commit message (sans prefix) | N |
| 2 | HH:MM | fix | commit message | N |
```

- Type extracted from conventional commit prefix (feat:, fix:, refactor:, docs:, etc.)
- If no conventional prefix, type = "other"
- If no commits today: show `오늘 커밋 없음` instead of table

#### Section 2: 변경 현황

```markdown
## 변경 현황

| 영역 | 파일 수 | 추가 | 삭제 | 주요 파일 |
|------|---------|------|------|----------|
| `lib/` | N | +N | -N | `file1.js`, `file2.js` |
| `commands/` | N | +N | -N | `daily.md` NEW |
| `tests/` | N | +N | -N | `daily.test.js` |
```

- Group by top-level directory
- Show top 2 files per directory (by lines changed)
- Append `NEW` suffix for newly created files
- Omit directories with 0 changes

#### Section 3: 품질 현황

```markdown
## 품질 현황

| 지표 | 값 | 상태 |
|------|-----|------|
| 테스트 | **N개** 통과 / N 실패 | ✅ or ❌ |
| 커버리지 | **N%** stmt · **N%** branch | ✅ (>=90%) or ⚠️ |
| ESLint | **N** error · **N** warning | ✅ (0 errors) or ❌ |
```

- ✅ when: 0 test failures, coverage >= 90% stmt, 0 lint errors
- ❌ when: any test failures or lint errors
- ⚠️ when: coverage < 90% but > 80%, or warnings only
- If `--quick`: show `> 품질 현황: --quick 모드로 생략됨`
- If past date: show `> 품질 현황: 과거 날짜는 지원하지 않습니다`

#### Section 4: 작업 현황

```markdown
## 작업 현황

| 상태 | 수 | 항목 |
|------|-----|------|
| ✅ 완료 | N | #id subject, #id subject |
| 🔄 진행중 | N | #id subject |
| ⏳ 대기 | N | #id subject, #id subject |
```

- Data from TaskList tool
- Group by status (completed, in_progress, pending)
- Show up to 3 task subjects per row (truncate with "외 N건" if more)
- If no tasks: show `활성 작업 없음`
- If `--no-tasks`: show `> 작업 현황: --no-tasks 모드로 생략됨`

#### Section 5: 세션 기록

```markdown
## 세션 기록

| 구분 | 내용 |
|------|------|
| 작업 | worklog 작업 items joined by comma |
| 결정 | worklog 결정 items joined by comma |
| 보류 | worklog 보류 items or (없음) |
```

- Parsed from `memory/worklog.md`, section matching `## ${DATE}`
- If no worklog file: show `worklog 파일 없음`
- If no entry for date: show `해당 날짜의 세션 기록 없음`

#### Section 6: 다음 단계

```markdown
## 다음 단계

| 우선순위 | 항목 | 근거 |
|----------|------|------|
| **P1** | description | 진행중 작업 |
| **P2** | description | 대기중 작업 |
| **P2** | description | 보류 사항 |
| **P3** | Uncommitted N files 정리 | git status |
| **P3** | N개 테스트 실패 수정 | 품질 이슈 |
```

### Footer

```markdown
> 생성: YYYY-MM-DD HH:MM · 소요: N.Ns · 데이터: git+tasks+worklog
```

Measure elapsed time from command start to render complete.
Data sources listed: `git`, `tasks` (if collected), `worklog` (if found), `quality` (if ran).

## --save Output

When `--save` is specified:

1. Create directory `~/.claude/projects/<slug>/memory/daily/` if not exists
2. Write clean markdown (no ANSI codes) to `memory/daily/YYYY-MM-DD.md`
3. Replace box header with: `# Daily Retrospective: YYYY-MM-DD`
4. Add `Branch: {branch} @ {hash}` line after title
5. Keep all GFM tables and sections intact
6. Show confirmation: `> 리포트 저장: memory/daily/YYYY-MM-DD.md`

## Edge Cases

| Scenario | Handling |
|----------|----------|
| No commits today | `오늘 커밋 없음` in 커밋 요약 section |
| No worklog entry | `해당 날짜의 세션 기록 없음` in 세션 기록 section |
| npm test timeout (>20s) | `⚠️ TIMEOUT` in 품질 현황 table |
| npm test not configured | `⚠️ 미설정` in 품질 현황 table |
| No tasks in TaskList | `활성 작업 없음` in 작업 현황 section |
| No pending items for next steps | Only show git-status and quality items; if none: "다음 단계 없음" |
| Not a git repository | Exit with: `git 저장소가 아닙니다` |
| worklog.md does not exist | Skip 세션 기록 section with note |
| --date with past date | Skip 품질 현황 entirely, note in output |

## Anti-Patterns

- Do NOT run `npm test` without considering timeout — always use reasonable bounds
- Do NOT put ANSI color codes inside GFM tables — they break column alignment
- Do NOT attempt historical task lookups — TaskList shows current state only
- Do NOT read the entire git log — always use `--since`/`--until` date bounds
- Do NOT generate next steps without evidence — every item MUST cite its source
- Do NOT skip any section silently — show a note explaining why it was skipped
