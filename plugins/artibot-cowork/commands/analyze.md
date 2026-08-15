---
description: (Artibot) Multi-dimensional campaign and channel analysis with agent delegation
argument-hint: '[target] e.g. "지난달 캠페인 성과 분석해줘"'
allowed-tools: [Read, Glob, Grep, Bash, Agent, TaskCreate]
---

# /analyze

Deep analysis of campaigns, channels, and marketing datasets. Supports focused analysis domains and agent delegation for large-scope operations.

## Arguments

Parse $ARGUMENTS:
- `target`: Campaign, channel, asset, dataset, or `@<path>` reference to a local file
- `--focus [domain]`: Analysis domain - `performance`, `conversion`, `content`, `seo`, `strategy`
- `--scope [level]`: `asset` | `campaign` | `channel` | `portfolio`
- `--delegate`: Enable sub-agent delegation for broad, multi-channel scope
- `--think` | `--think-hard` | `--ultrathink`: Analysis depth control

## Execution Flow

1. **Parse**: Resolve the target. Default scope = `campaign` if a campaign is named, `asset` if a single file
2. **Context**: Read the target data and copy. Establish the baseline period and comparable segments
3. **Analyze**: Apply focus-specific analysis:
   - **performance**: Channel-level spend, reach, CTR, CAC, and ROAS against the baseline period
   - **conversion**: Funnel stage drop-off, friction points, form abandonment, test opportunities
   - **content**: Message clarity, tone-of-voice fit, audience alignment, call-to-action strength
   - **seo**: Search visibility, keyword gaps, cannibalization, crawl and indexation issues
   - **strategy**: Positioning, channel mix balance, competitive share of voice
4. **Delegate** (if `--delegate` or scope spans multiple channels): Spawn sub-agents per focus domain using the Agent tool
5. **Verify**: Cross-reference findings against source data and prior reports
6. **Report**: Output structured findings with severity classification

## Agent Delegation

When `--delegate` is active or auto-triggered (>50 files or >7 directories):

| Focus | Agent | Task |
|-------|-------|------|
| performance | Agent(data-analyst) | Channel and funnel performance, KPI trends |
| conversion | Agent(cro-specialist) | Funnel drop-off, friction points, test backlog |
| content | Agent(content-marketer) | Message quality, tone, audience fit |
| seo | Agent(seo-specialist) | Search visibility, keyword gaps, technical SEO |
| strategy | Agent(marketing-strategist) | Positioning, channel mix, competitive landscape |

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
| 1 | 전환 개선 실행 | `/cro` | 분석에서 나온 전환 병목 개선 |
| 2 | 실행 계획 수립 | `/ultraplan` | 분석 결과 기반 캠페인 계획 |
| 3 | 콘텐츠 보완 | `/content` | 메시지·카피 보강 |
| 4 | 리포트 작성 | `/document` | 분석 결과 문서화 |
