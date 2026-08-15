---
description: (Artibot) 일일 회고 리포트 - 오늘의 작업/결정/다음 단계를 구조화된 대시보드로 출력
argument-hint: '[--save] [--date 2026-02-27] [--quick]'
allowed-tools: [Read, Glob, Grep, Bash, TaskList, TaskGet, Write]
---

# /daily

Daily retrospective report. Collects today's deliverables, quality signals, task status, and session notes to produce a structured review dashboard focused on a single day of marketing and content work.

Also routed from natural language: "회고", "일일 보고", "오늘 작업", "오늘 뭐 했지"

## Arguments

Parse $ARGUMENTS:
- `--save`: Write clean markdown report to `daily/YYYY-MM-DD.md`
- `--date [YYYY-MM-DD]`: Target date (default: today)
- `--quick`: Skip quality section (slop review + rubric scoring) for faster output
- `--no-tasks`: Skip TaskList collection
- `--verbose`: Include the full deliverable list instead of the top entries

## Execution Flow

### Phase 1: Parallel Data Collection

Run ALL of the following in a single message (parallel, no dependencies):

1. **Deliverables**: Glob the working folder for documents, drafts, and assets. Glob returns paths in modification order but does not expose the timestamp value, so read the modification time itself before filtering:
   ```bash
   find . -type f \( -name '*.md' -o -name '*.txt' \) -newermt "${DATE}" ! -newermt "${DATE} +1 day"
   ```
   The date boundary comes from the filesystem modification time — this is the single source of truth for "today's work" in this command. Do not infer a date from filename or content; cowork deliverables carry no date convention.
2. **Deliverable detail**: Read each matched file's heading block (and frontmatter if present) to recover its title, channel, and stage. Most cowork deliverables have no frontmatter — fall back to the `#` heading, and use the filename when both are absent.
3. **Campaign context**: Grep the working folder for the campaign or topic names referenced by today's deliverables
4. **Session notes**: Read `worklog.md` if present in the working folder
5. **Tasks**: TaskList tool (skip if `--no-tasks`)

### Phase 2: Quality Collection

**Skip entirely if `--quick` OR `--date` is not today.**

Sequential, applied only to the text deliverables collected in Phase 1 step 1 — do not re-scan the folder with a different date rule, or the two sections will disagree:

6. **Slop review**: Run the `ai-slop-reviewer` skill over today's drafts. Parse the AI-pattern findings and the quality score.
7. **Rubric scoring**: Score long-form pieces against `skills/copywriting/references/long-form-quality-rubric.md` (publish gate = 90+).
8. **Compliance**: For ad or claim-bearing copy, check against the `ad-compliance` skill (표시광고법, PIPA, FTC, GDPR). Report unresolved flags.

If a step has no applicable input for the day, report `해당 없음` rather than a score.

### Phase 3: Synthesis and Render

1. **Group deliverables**: Bucket each item by `content-pipeline` stage — raw capture, theme extraction, research, long-form draft, quality gate + fan-out. Items outside the pipeline are bucketed as `기타`.
2. **Aggregate by area**: Group by work area (`content/`, `campaign/`, `report/`, `design/`, other). Count items per area and pick the top 2 by significance as "주요 산출물". Split 신규 vs 수정 by birth time (`find -newerBt`) where the filesystem exposes it; where it does not, report the 신규 column as `확인되지 않음` rather than assuming every touched file is new.
3. **Parse session notes**: Find section matching `## ${DATE}` in worklog. Extract 작업/결정/보류 subsections. If no matching date: show "해당 날짜의 세션 기록 없음".
4. **Generate Next Steps** using the algorithm below.
5. **Render** all sections using the Output Format template.
6. **If `--save`**: Replace the header with `# Daily Retrospective: YYYY-MM-DD`, write to `daily/${DATE}.md`. Create the `daily/` directory if needed.

## Next Steps Algorithm

Combine data from multiple sources with priority ranking:

| Priority | Source | Condition |
|----------|--------|-----------|
| **P1** | TaskList | Tasks with status = `in_progress` |
| **P1** | Worklog 보류 | Items containing "urgent", "blocker", "critical" |
| **P2** | TaskList | Tasks with status = `pending` AND blockedBy = empty |
| **P2** | Worklog 보류 | All remaining 보류 items |
| **P3** | Deliverables | Drafts left below the publish gate (count, not list) |
| **P3** | Quality | Unresolved slop findings or compliance flags |

**Rules**:
- Display top 5 items maximum
- Sort by priority, then by source order
- Every item must cite its source in the 근거 column
- If no items from any source: show "다음 단계 없음 — 오늘 작업 완료!"

## Output Format

### Header

```markdown
# DAILY RETROSPECTIVE — 2026-02-27 Thu
```

Plain markdown only. This plugin ships no rendering library, so do not emit ANSI escape codes.

### Body

All body sections use pure GFM markdown (NO ANSI colors inside tables — they break column alignment).

#### Section 1: 산출물 요약

```markdown
## 산출물 요약

**N개 산출물** · **N개 발행** · **N개 진행중**

| # | 산출물 | 유형 | 단계 | 채널 |
|---|--------|------|------|------|
| 1 | title | 블로그 | long-form draft | 오가닉 |
| 2 | title | 광고 카피 | quality gate | 페이드 |
```

- 유형 extracted from the deliverable's own frontmatter or heading
- If the type cannot be determined, 유형 = "기타"
- If no deliverables today: show `오늘 산출물 없음` instead of table

#### Section 2: 작업 영역

```markdown
## 작업 영역

| 영역 | 항목 수 | 신규 | 수정 | 주요 산출물 |
|------|---------|------|------|------------|
| `content/` | N | N | N | `launch-post.md`, `faq.md` |
| `campaign/` | N | N | N | `q3-brief.md` NEW |
| `report/` | N | N | N | `weekly-kpi.md` |
```

- Group by work area
- Show top 2 items per area
- Append `NEW` suffix for newly created items
- Omit areas with 0 activity

#### Section 3: 품질 현황

```markdown
## 품질 현황

| 지표 | 값 | 상태 |
|------|-----|------|
| AI-슬롭 검출 | **N건** 패턴 / N건 해소 | ✅ or ❌ |
| 품질 루브릭 | **N점** (발행 게이트 90) | ✅ (>=90) or ⚠️ |
| 컴플라이언스 | **N** 위반 · **N** 확인필요 | ✅ (0 위반) or ❌ |
```

- ✅ when: 0 unresolved slop findings, rubric >= 90, 0 compliance violations
- ❌ when: any compliance violation or unresolved slop finding
- ⚠️ when: rubric 80-89, or advisory flags only
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

- Parsed from `worklog.md`, section matching `## ${DATE}`
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
| **P3** | 미발행 초안 N건 마무리 | 산출물 현황 |
| **P3** | 컴플라이언스 N건 해소 | 품질 이슈 |
```

### Footer

```markdown
> 생성: YYYY-MM-DD HH:MM · 데이터: 산출물+tasks+worklog
```

Data sources listed: `산출물`, `tasks` (if collected), `worklog` (if found), `품질` (if ran).

## --save Output

When `--save` is specified:

1. Create directory `daily/` in the working folder if not exists
2. Write clean markdown to `daily/YYYY-MM-DD.md`
3. Replace the header with: `# Daily Retrospective: YYYY-MM-DD`
4. Keep all GFM tables and sections intact
5. Show confirmation: `> 리포트 저장: daily/YYYY-MM-DD.md`

## Edge Cases

| Scenario | Handling |
|----------|----------|
| No deliverables today | `오늘 산출물 없음` in 산출물 요약 section |
| No worklog entry | `해당 날짜의 세션 기록 없음` in 세션 기록 section |
| No text produced today | `해당 없음` in the slop and rubric rows |
| Compliance skill not applicable | `해당 없음` in 컴플라이언스 row |
| No tasks in TaskList | `활성 작업 없음` in 작업 현황 section |
| No pending items for next steps | Only show deliverable and quality items; if none: "다음 단계 없음" |
| Working folder has no documents | Exit with: `산출물을 찾을 수 없습니다` |
| worklog.md does not exist | Skip 세션 기록 section with note |
| --date with past date | Skip 품질 현황 entirely, note in output |

## Anti-Patterns

- Do NOT re-review deliverables that were already scored — reuse the recorded score
- Do NOT put ANSI color codes inside GFM tables — they break column alignment
- Do NOT attempt historical task lookups — TaskList shows current state only
- Do NOT scan the entire working folder history — always bound by the target date
- Do NOT generate next steps without evidence — every item MUST cite its source
- Do NOT skip any section silently — show a note explaining why it was skipped
- Do NOT guess a quality score when the review did not run — report `확인되지 않음`

## Next Steps

작업 완료 후 추천 후속 액션:

| # | 액션 | 커맨드 | 설명 |
|---|------|--------|------|
| 1 | 회고 문서화 | `/document` | 오늘 회고를 문서로 저장 |
| 2 | 다음 작업 계획 | `/ultraplan` | 미완료 작업 기반 계획 수립 |
| 3 | 성과 점검 | `/analytics` | 지표 기준으로 성과 확인 |
