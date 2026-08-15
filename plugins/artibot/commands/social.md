---
description: (Artibot) Social media content creation, scheduling strategy, and platform-specific optimization
argument-hint: '[type] e.g. "링크드인 시리즈 포스트"'
allowed-tools: [Read, Write, Agent, WebSearch, TaskCreate]
toolset: content
---

# /social

Creates platform-optimized social media content with scheduling recommendations, hashtag strategies, and engagement optimization. Handles multi-platform adaptation from a single content brief. Supports full production workflows, content auditing, competitor analysis, and crisis response.

## Arguments

Parse $ARGUMENTS:
- `content-type`: Content type - `post` | `thread` | `carousel` | `story` | `reel-script` | `calendar`
- `--platform [target]`: Platform - `twitter` | `linkedin` | `instagram` | `tiktok` | `youtube` | `all`
- `--campaign [name]`: Campaign context for consistency
- `--tone [voice]`: Content tone - `professional` | `casual` | `witty` | `educational` | `provocative`
- `--series [n]`: Number of posts in a series/thread
- `--schedule`: Include optimal posting time recommendations
- `--hashtags`: Generate hashtag strategy per platform
- `--repurpose [source]`: Repurpose content from source (blog URL, article path, etc.)
- `--workflow [phase]`: Run production workflow phase - `brief` | `research` | `draft` | `review` | `optimize` | `full`
- `--audit`: Run Content Quality Checklist on existing draft or scheduled post
- `--compete [brand]`: Run competitor analysis workflow for specified brand(s)
- `--crisis [level]`: Activate crisis management protocol - `1` | `2` | `3`

## Content Types

| Type | Description | Platforms |
|------|-------------|-----------|
| post | Single post per platform | All |
| thread | Multi-part connected posts | Twitter, LinkedIn |
| carousel | Multi-slide visual content | Instagram, LinkedIn |
| story | Ephemeral short-form content | Instagram, TikTok |
| reel-script | Short video script with hooks | TikTok, Instagram, YouTube Shorts |
| calendar | Weekly/monthly content plan | All |
| workflow | End-to-end production pipeline | All |
| audit | Content quality pre-publish check | All |
| competitor-report | Competitor analysis output | All |

## Platform Specs

| Platform | Character Limit | Best Practices |
|----------|----------------|----------------|
| Twitter/X | 280 chars | Hooks, threads, quote-tweets |
| LinkedIn | 3,000 chars | Professional tone, document carousels |
| Instagram | 2,200 chars | Visual-first, 30 hashtags max |
| TikTok | 4,000 chars | Hook in 3 seconds, trending sounds |
| YouTube | 5,000 chars | SEO titles, timestamps, end screens |

## Agent Delegation

- Primary: `content-marketer` - Content creation
- Supporting: `data-analyst` - Performance benchmarking

## Skills Required

- `social-media` - Platform algorithms, optimal posting, engagement tactics
- `copywriting` - Short-form writing, hooks, CTAs

## Execution Flow

1. **Parse**: Extract content type, platform targets, campaign context, workflow flags
2. **Route**: If `--workflow`, enter production pipeline; if `--audit`, run quality checklist; if `--compete`, run competitor analysis; if `--crisis`, activate crisis protocol
3. **Research**: Current trending topics, hashtags, competitor posts via WebSearch
4. **Create**: Generate platform-specific content:
   - **Twitter/X**: 280-char posts, thread hooks, quote-tweet suggestions
   - **LinkedIn**: Professional posts, document carousels, poll ideas
   - **Instagram**: Caption + visual concept, carousel slides, story sequence
   - **TikTok**: Script with hooks (first 3 seconds), trending sounds, CTA
5. **Optimize**: Platform-specific enhancements:
   - Character count compliance
   - Hashtag research and placement
   - Emoji strategy (per platform norms)
   - CTA placement
   - UTM parameter attachment
6. **Quality Gate**: Run Content Quality Checklist (8 checks) before scheduling
7. **Schedule** (if `--schedule`): Recommend posting times based on platform best practices
8. **Calendar** (if content-type is `calendar`): Generate weekly/monthly content calendar
9. **Report**: Output content package per platform with A/B test recommendations

## Output Format

```
SOCIAL MEDIA CONTENT
====================
Type:       [content-type]
Campaign:   [campaign name or standalone]
Platforms:  [list]

PLATFORM: [TWITTER/X]
---------------------
Post 1: [content text]
  Characters: [count/280]
  Hashtags: [#tag1 #tag2]
  Best Time: [day, time]
  Media: [image/video suggestion]

PLATFORM: [LINKEDIN]
--------------------
Post 1: [content text]
  Hook: [first line - most important for feed visibility]
  Hashtags: [#tag1 #tag2 #tag3]
  Best Time: [day, time]
  Media: [document/image/video suggestion]

CONTENT CALENDAR (if calendar)
------------------------------
Week | Mon      | Tue       | Wed      | Thu       | Fri
-----|----------|-----------|----------|-----------|-----
1    | [type]   | [type]    | [type]   | [type]    | [type]
     | [platf]  | [platf]   | [platf]  | [platf]   | [platf]

HASHTAG STRATEGY
----------------
Platform    | Primary (3-5)    | Secondary (5-10)  | Niche (3-5)
------------|------------------|-------------------|------------
[platform]  | [high-volume]    | [mid-volume]      | [targeted]

QUALITY GATE (if --audit)
-------------------------
[8-point checklist with pass/fail per item]

COMPETITOR ANALYSIS (if --compete)
----------------------------------
[Benchmarking table + gap analysis]
```

## Example Usage

```
/social post --platform all --campaign "Product Launch" --tone witty --hashtags
/social thread --platform twitter --series 7 --tone educational
/social calendar --platform linkedin,twitter --campaign "Thought Leadership" --schedule
/social carousel --platform instagram,linkedin --repurpose @blog/latest-post.md
/social --workflow full --platform all --campaign "Q3 Launch"
/social --audit
/social --compete "CompetitorA,CompetitorB" --platform linkedin
/social --crisis 2
```

## Next Steps

작업 완료 후 추천 후속 액션:

| # | 액션 | 커맨드 | 설명 |
|---|------|--------|------|
| 1 | 성과 분석 | `/analytics` | 소셜 미디어 성과 분석 |
| 2 | 콘텐츠 제작 | `/content` | 소셜 콘텐츠 추가 제작 |
| 3 | 유료 프로모션 | `/ad` | 소셜 광고 캠페인 생성 |
| 4 | A/B 테스트 설계 | `/ab-testing` | 소셜 콘텐츠 실험 설계 |
| 5 | 경쟁사 분석 | `/competitive-intelligence` | 심층 경쟁사 조사 |
