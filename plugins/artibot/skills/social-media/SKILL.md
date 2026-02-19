---
name: social-media
description: |
  Multi-platform social media content creation, scheduling strategy, and engagement optimization.
  Covers platform-specific formats, algorithms, hashtag strategies, and content calendars.
  Auto-activates when: social media content creation, platform optimization, content calendar, hashtag strategy.
  Triggers: social media, twitter, linkedin, instagram, tiktok, youtube, social post, content calendar, hashtag, engagement, social strategy, 소셜 미디어, 소셜 콘텐츠, 콘텐츠 캘린더
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

See `references/platform-specs.md` for detailed format specifications.
See `references/engagement-benchmarks.md` for platform-specific benchmark data.
