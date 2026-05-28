---
context: fork
name: social-media
description: "Creates multi-platform social media content with scheduling strategy, engagement optimization, platform-specific formats, and content calendars. Use when user asks about social media, Twitter, LinkedIn, Instagram, TikTok, YouTube, content calendar, hashtag strategy, social engagement, 소셜 미디어, 소셜 콘텐츠, 콘텐츠 캘린더, 카카오스토리, 네이버 블로그, 밴드, or 한국 SNS."
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
  - "네이버 블로그"
  - "카카오스토리"
  - "Band"
  - "밴드"
  - "한국 SNS"
  - "카카오채널"
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

#### 한국 플랫폼

#### 네이버 블로그
| Element | Spec | Best Practice |
|---------|------|---------------|
| 포스트 길이 | 최소 1,500자 권장 | 3,000자 이상이 체류 시간 유리 |
| 이미지 | 10장 이내 권장 | 1:1 또는 3:2 비율, 최소 760px 너비 |
| 해시태그 | 10-15개 | 카테고리 일관성 유지 |
| 발행 시간 | 오전 9-11시 | C-Rank 활동성 지표 반영 |
| 내부 링크 | 연관 포스트 3개 이상 | 스크롤 깊이 및 체류 시간 향상 |

#### 카카오스토리
| Element | Spec | Best Practice |
|---------|------|---------------|
| 포스트 | 제한 없음 | 200자 내외가 최적 |
| 이미지 | 1:1, 4:3, 16:9 | 카드 형태 콘텐츠 적합 |
| 영상 | 10분 이내 | 1-3분 최적 |
| 해시태그 | 5개 내외 | 탐색 기반 콘텐츠에 유효 |
| 타겟 | 30-50대 여성 비중 높음 | 생활/관심사/지역 밀착 콘텐츠 |

#### 밴드 (BAND)
| Element | Spec | Best Practice |
|---------|------|---------------|
| 그룹 포스트 | 이미지 20장 이내 | 커뮤니티/동호회 대상 |
| 투표 기능 | 최대 10개 선택지 | 참여율 높은 설문형 콘텐츠 |
| 정기 알림 | 그룹 알림 | 정보성 콘텐츠 + 주기적 업로드 |
| 타겟 | 40-60대 비중 높음 | 모임/동호회/학부모 커뮤니티 |

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

**한국 플랫폼 운영 원칙**:
- 네이버 블로그: 주 2-3회, 오전 9-11시 발행
- 카카오스토리: 주 3-5회, 라이프스타일/공감 콘텐츠
- 밴드: 그룹 특성에 따라 주 1-2회
- 카카오채널 친구톡: 주 1-2회, 오전 10-11시 / 오후 1-2시

### 6. Engagement Benchmarks

| Platform | Good Engagement | Great Engagement | Top 10% |
|----------|----------------|-----------------|---------|
| Twitter/X | 1-3% | 3-6% | 6%+ |
| LinkedIn | 2-4% | 4-8% | 8%+ |
| Instagram | 1-3% | 3-6% | 6%+ |
| TikTok | 3-6% | 6-15% | 15%+ |
| 네이버 블로그 | 3-7% | 7-12% | 12%+ | (공감+댓글+공유율) |
| 카카오스토리 | 1-3% | 3-6% | 6%+ | (반응율) |

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

**Platforms**: Twitter/X, LinkedIn, Instagram, TikTok, YouTube, **네이버 블로그, 카카오스토리, 밴드**
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
