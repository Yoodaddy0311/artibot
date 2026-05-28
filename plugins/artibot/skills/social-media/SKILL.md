---
context: fork
name: social-media
description: "Creates multi-platform social media content with scheduling strategy, engagement optimization, platform-specific formats, and content calendars. Use when user asks about social media, Twitter, LinkedIn, Instagram, TikTok, YouTube, content calendar, hashtag strategy, social engagement, 소셜 미디어, 소셜 콘텐츠, or 콘텐츠 캘린더."
lang: [en, ko]
platforms: [claude-code, gemini-cli, codex-cli, cursor]
level: 3
triggers:
  - "social media"
  - "social post"
  - "Instagram"
  - "Twitter"
  - "LinkedIn"
  - "social strategy"
  - "engagement"
agents:
  - "doc-updater"
tokens: "~3K"
category: "marketing"
source_hash: de908716
whenNotToUse: "Long-form content (blog posts, whitepapers, email campaigns) or developer-facing communication that is not intended for social media platforms and does not need platform-specific format constraints."
---

# Social Media

## When This Skill Applies
- Creating platform-optimized social media content
- Designing content calendars and posting schedules
- Developing hashtag and engagement strategies
- Repurposing content across platforms
- Analyzing social media performance benchmarks

## Core Guidance

### 1. Content Creation Process
```
Define Goal -> Choose Platform(s) -> Create Content -> Optimize for Platform -> Add Hashtags -> Schedule -> Monitor -> Engage -> Analyze
```

### 2. Platform Specifications

#### Twitter/X
| Element | Spec | Best Practice |
|---------|------|---------------|
| Post | 280 chars | 70-100 chars for retweets |
| Thread | Unlimited | 5-10 tweets, numbered |
| Image | 1200x675px | 16:9 ratio |
| Video | 2:20 max | 15-45 seconds optimal |
| Hashtags | 1-2 per post | End of tweet, not inline |
| Best Times | Tue-Thu 9-11am | Weekday mornings |

#### LinkedIn
| Element | Spec | Best Practice |
|---------|------|---------------|
| Post | 3000 chars | 150-300 chars for feed |
| Article | Unlimited | 1500-2000 words |
| Image | 1200x627px | Professional, branded |
| Video | 10 min max | 30-90 seconds optimal |
| Hashtags | 3-5 per post | At end, mix niche+broad |
| Best Times | Tue-Thu 7-8am, 12pm | Business hours |

#### Instagram
| Element | Spec | Best Practice |
|---------|------|---------------|
| Caption | 2200 chars | First 125 chars visible |
| Carousel | 10 slides | Educational/story format |
| Reels | 90 sec max | 15-30 seconds optimal |
| Stories | 15 sec/slide | Interactive stickers |
| Hashtags | 5-10 per post | Mix of sizes |
| Best Times | Mon-Fri 11am-1pm | Lunch and evening |

#### TikTok
| Element | Spec | Best Practice |
|---------|------|---------------|
| Video | 10 min max | 15-60 seconds optimal |
| Caption | 2200 chars | 50-100 chars |
| Hook | First 3 seconds | Must stop the scroll |
| Hashtags | 3-5 per post | Trending + niche |
| Best Times | Tue-Thu 10am-12pm | Varies by audience |

### 3. Content Pillar Strategy

| Pillar | Content Mix | Purpose |
|--------|------------|---------|
| Educational | 40% | Build authority, provide value |
| Engaging | 25% | Questions, polls, conversations |
| Promotional | 20% | Product, offers, launches |
| Entertaining | 10% | Memes, trends, behind-scenes |
| User-Generated | 5% | Testimonials, community content |

### 4. Hashtag Strategy

| Type | Volume | Count | Example |
|------|--------|-------|---------|
| Broad | 500K+ posts | 1-2 | #Marketing, #AI |
| Medium | 50K-500K | 3-4 | #ContentMarketing, #MarTech |
| Niche | 5K-50K | 2-3 | #SaaSGrowth, #B2BMarketing |
| Branded | Any | 1 | #YourBrandName |

### 5. Content Calendar Template

```
Week | Mon          | Tue          | Wed          | Thu          | Fri
-----|-------------|-------------|-------------|-------------|-----
1    | Educational  | Engaging     | Promotional  | Educational  | Entertaining
     | LinkedIn     | Twitter      | All          | Instagram    | TikTok
     | [topic]      | [topic]      | [topic]      | [topic]      | [topic]
```

**Frequency by Platform**:
- Twitter/X: 3-5 posts/day
- LinkedIn: 3-5 posts/week
- Instagram: 3-7 posts/week + daily stories
- TikTok: 1-3 videos/day

### 6. Engagement Benchmarks

| Platform | Good Engagement | Great Engagement | Top 10% |
|----------|----------------|-----------------|---------|
| Twitter/X | 1-3% | 3-6% | 6%+ |
| LinkedIn | 2-4% | 4-8% | 8%+ |
| Instagram | 1-3% | 3-6% | 6%+ |
| TikTok | 3-6% | 6-15% | 15%+ |

### 7. Content Repurposing Matrix

| Source | Twitter/X | LinkedIn | Instagram | TikTok |
|--------|----------|----------|-----------|--------|
| Blog post | Key takeaways thread | Summary + link | Carousel | Quick tip video |
| Webinar | Quote clips | Full recap | Behind-scenes stories | Highlight clips |
| Case study | Stats thread | Full post | Before/after carousel | Customer story |
| Report | Data highlights | Analysis post | Infographic carousel | Data explainer |

## Output Format
```
SOCIAL MEDIA CONTENT
====================
Platform:   [target platform]
Type:       [post|thread|carousel|story|reel|calendar]
Campaign:   [campaign name or standalone]

CONTENT
-------
[Platform-formatted content]
Characters: [count/limit]
Hashtags:   [hashtag list]
Best Time:  [recommended posting time]
Media:      [image/video suggestion]

CALENDAR (if applicable)
------------------------
[Weekly content schedule by platform and pillar]
```

## Quick Reference

**Platforms**: Twitter/X, LinkedIn, Instagram, TikTok, YouTube
**Content Pillars**: Educational (40%), Engaging (25%), Promotional (20%), Entertaining (10%), UGC (5%)
**Key Metrics**: Engagement rate, reach, impressions, click-through rate, follower growth

---

## Rules

- Always match brand voice and tone guidelines before drafting any post.
- Always research platform-specific hashtag performance before selecting tags.
- Always include a clear call-to-action or engagement prompt in every post.
- Always verify character counts against platform limits before delivering.
- Always adapt content format to the target platform's native conventions.
- Never use generic hashtags without checking current volume and relevance.
- Never cross-post identical content across platforms without format adaptation.
- Never publish without confirming the posting time aligns with audience activity data.
- Never prioritize follower count over engagement rate as a success metric.
- Never skip the content pillar balance check across the weekly calendar.

## Iteration

After delivering the first draft:
1. Ask if changes are needed
2. Apply feedback and regenerate
3. Maximum 3 revision rounds
4. On round 3, deliver final with "this is the final version" note

## References

- See `${CLAUDE_SKILL_DIR}/references/platform-specifications.md` for platform specifications
- See `${CLAUDE_SKILL_DIR}/references/content-pillar-strategy.md` for content pillar strategy


## Rationalizations

The following table captures common excuses agents make to skip the rigor of this marketing practice, paired with factual rebuttals.

| Excuse | Rebuttal |
|--------|----------|
| "Post the same content on every platform." | Each platform has distinct format, aspect ratio, and hook conventions; cross-posting raw content yields 30-60% lower engagement. |
| "Follower count is the goal." | Followers without engagement are a vanity metric; reach, saves, and shares predict revenue impact. |
| "Posting frequency is what matters most." | Over-posting trains the algorithm to reduce per-post reach; quality and timing beat raw volume on every platform since 2023. |
| "Organic reach will come back." | Organic reach on Meta platforms has declined to 1-5% and will not recover; plan with paid amplification in the mix. |
| "Hashtags don't matter anymore." | Hashtags drive discovery on TikTok, Instagram Reels, and LinkedIn; the specific tactic changes, but the discovery function remains. |
