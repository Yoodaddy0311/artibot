---
description: Social media content creation, scheduling strategy, and platform-specific optimization
argument-hint: '[type] e.g. "링크드인 시리즈 포스트"'
allowed-tools: [Read, Write, Task, WebSearch, TodoWrite]
---

# /social

Creates platform-optimized social media content with scheduling recommendations, hashtag strategies, and engagement optimization. Handles multi-platform adaptation from a single content brief.

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

## Content Types

| Type | Description | Platforms |
|------|-------------|-----------|
| post | Single post per platform | All |
| thread | Multi-part connected posts | Twitter, LinkedIn |
| carousel | Multi-slide visual content | Instagram, LinkedIn |
| story | Ephemeral short-form content | Instagram, TikTok |
| reel-script | Short video script with hooks | TikTok, Instagram, YouTube Shorts |
| calendar | Weekly/monthly content plan | All |

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

1. **Parse**: Extract content type, platform targets, campaign context
2. **Research**: Current trending topics, hashtags, competitor posts via WebSearch
3. **Create**: Generate platform-specific content:
   - **Twitter/X**: 280-char posts, thread hooks, quote-tweet suggestions
   - **LinkedIn**: Professional posts, document carousels, poll ideas
   - **Instagram**: Caption + visual concept, carousel slides, story sequence
   - **TikTok**: Script with hooks (first 3 seconds), trending sounds, CTA
4. **Optimize**: Platform-specific enhancements:
   - Character count compliance
   - Hashtag research and placement
   - Emoji strategy (per platform norms)
   - CTA placement
5. **Schedule** (if `--schedule`): Recommend posting times based on platform best practices
6. **Calendar** (if content-type is `calendar`): Generate weekly/monthly content calendar
7. **Report**: Output content package per platform

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
```

## Example Usage

```
/social post --platform all --campaign "Product Launch" --tone witty --hashtags
/social thread --platform twitter --series 7 --tone educational
/social calendar --platform linkedin,twitter --campaign "Thought Leadership" --schedule
/social carousel --platform instagram,linkedin --repurpose @blog/latest-post.md
```
