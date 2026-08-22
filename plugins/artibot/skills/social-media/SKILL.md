---
context: fork
name: social-media
description: "Creates multi-platform social media content with scheduling strategy, engagement optimization, platform-specific formats, and content calendars. Use when user asks about social media, Twitter, LinkedIn, Instagram, TikTok, YouTube, content calendar, hashtag strategy, social engagement, 소셜 미디어, 소셜 콘텐츠, or 콘텐츠 캘린더."
lang: [en, ko]
platforms: [claude-code, gemini-cli, codex-cli, cursor]
level: 4
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
source_hash: c44760d5
whenNotToUse: "Long-form content (blog posts, whitepapers, email campaigns) or developer-facing communication that is not intended for social media platforms and does not need platform-specific format constraints."
---

# Social Media

## When This Skill Applies
- Creating platform-optimized social media content
- Designing content calendars and posting schedules
- Developing hashtag and engagement strategies
- Repurposing content across platforms
- Analyzing social media performance benchmarks
- Running end-to-end content production workflows
- Auditing content quality before publishing
- Managing social media crises
- Conducting competitor analysis on social channels

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

### 8. Production Workflow

End-to-end content production pipeline with gate criteria at each phase:

```
Brief → Research → Draft → Internal Review → Asset Creation → Platform Optimization → Schedule → Publish → Monitor → Engage → Report → Archive
```

| Phase | Inputs | Activities | Outputs | Gate Criteria |
|-------|--------|------------|---------|---------------|
| **Brief** | Campaign goal, target audience | Define objectives, KPIs, platform targets | Content brief document | Stakeholder sign-off on goals and audience |
| **Research** | Content brief | Trending topics, competitor scan, hashtag research | Research summary, hashtag shortlist | At least 3 competitor posts analyzed, hashtag volumes verified |
| **Draft** | Research summary | Write copy per platform, create visual concepts | Draft posts with media briefs | All posts within character limits, CTA present in each |
| **Internal Review** | Draft posts | Brand voice check, compliance review, fact-check | Approved or revision-requested drafts | 2 reviewers approve; zero compliance flags |
| **Asset Creation** | Approved drafts, media briefs | Design images, edit videos, create carousels | Final media assets | Correct dimensions per platform, accessibility checks pass |
| **Platform Optimization** | Final copy + assets | Hashtag placement, emoji strategy, link shortening | Platform-ready posts | Character counts verified, UTM parameters attached |
| **Schedule** | Platform-ready posts | Set publishing times per platform best-time data | Scheduled queue | Each post in optimal time window for its platform |
| **Publish** | Scheduled queue | Automated or manual publish | Live posts | Post live and rendering correctly on each platform |
| **Monitor** | Live posts | Track engagement first 60 min, respond to comments | Engagement log | First-hour engagement above platform baseline |
| **Engage** | Engagement log | Reply to comments, share UGC, join conversations | Community interaction record | All comments addressed within 2 hours |
| **Report** | Engagement data (7-day) | Compile KPIs, compare to benchmarks | Performance report | Report delivered within 48 hours of campaign end |
| **Archive** | Performance report, assets | Tag and store in content library | Archived campaign folder | Assets tagged by pillar, platform, and performance tier |

### 9. Campaign Integration

**UTM Parameter Standards**:
```
utm_source   = [platform] (twitter, linkedin, instagram, tiktok)
utm_medium   = social
utm_campaign = [campaign-slug] (lowercase, hyphens, no spaces)
utm_content  = [post-variant] (a, b, c for A/B tests)
utm_term     = [hashtag-group] (optional, for hashtag attribution)
```

**Cross-Channel Sync**:

| Channel | Sync Point | Lead Time | Coordination |
|---------|-----------|-----------|--------------|
| Blog → Social | Publish day | Social posts drafted 2 days before blog goes live | Teaser posts pre-publish, full promotion post-publish |
| Email → Social | Send day | Social posts echo email CTA same day | Social extends email reach to non-subscribers |
| Ads → Organic | Campaign launch | Organic posts 3-5 days before paid launch | Organic validates messaging before ad spend |
| Event → Social | Event date | Pre-event hype 2 weeks out, live coverage day-of | Real-time posting during event, recap within 24h |

**Campaign Naming Convention**: `YYYY-QN-[brand]-[campaign]-[channel]`
Example: `2026-Q2-acme-product-launch-social`

**Content Coordination Timeline**:
| Days Before Launch | Action |
|--------------------|--------|
| 14 | Brief finalized, campaign name assigned |
| 10 | Research complete, draft started |
| 7 | Internal review begins |
| 5 | Asset creation starts |
| 3 | Platform optimization, scheduling |
| 1 | Final review, queue confirmed |
| 0 | Publish + monitor |
| +7 | Performance report |

### 10. A/B Testing Framework

**Variables to Test**:

| Variable | Platforms | Sample Size | Test Duration |
|----------|----------|-------------|---------------|
| Hook/opening line | All | 500+ impressions per variant | 24-48 hours |
| CTA wording | All | 500+ impressions per variant | 24-48 hours |
| Content format (carousel vs. single image) | Instagram, LinkedIn | 1,000+ impressions per variant | 48-72 hours |
| Posting time | All | 1,000+ impressions per variant | 2 weeks (same content, different times) |
| Hashtag set | Instagram, TikTok, LinkedIn | 1,000+ impressions per variant | 48-72 hours |
| Video length | TikTok, Instagram Reels | 2,000+ views per variant | 48-72 hours |

**Statistical Significance**: Minimum 95% confidence level. Use two-proportion z-test for engagement rate comparisons. Do not declare a winner below 500 impressions per variant.

**Winner Selection Process**:
1. Run test for minimum duration (see table above)
2. Compare primary KPI (engagement rate or CTR) across variants
3. Confirm statistical significance at p < 0.05
4. Scale winning variant across remaining scheduled posts
5. Document result in campaign archive for future reference

### 11. Performance Measurement

**Weekly KPI Dashboard**:

| Metric | Twitter/X | LinkedIn | Instagram | TikTok | Total |
|--------|----------|----------|-----------|--------|-------|
| Impressions | — | — | — | — | — |
| Reach | — | — | — | — | — |
| Engagement Rate | — | — | — | — | — |
| Link Clicks | — | — | — | — | — |
| Follower Change | — | — | — | — | — |
| Top Post | — | — | — | — | — |

**Monthly Report Structure**:
1. Executive summary (3-5 sentences: wins, misses, next actions)
2. KPI trends vs. prior month (table with directional arrows)
3. Top 5 performing posts with analysis of why they worked
4. Bottom 3 performing posts with diagnosis
5. Content pillar ratio (actual vs. target 40/25/20/10/5)
6. Recommendations for next month

**Quarterly Trend Analysis**:
- Quarter-over-quarter growth rates for reach, engagement, and conversions
- Platform mix shift (where is audience growing/declining)
- Content format performance ranking
- Seasonal pattern identification

**Attribution Model**: Last-touch social attribution for direct conversions; assisted-touch for content that appeared in a multi-step path. Track via UTM parameters in Google Analytics or equivalent. Report both direct and assisted social conversions monthly.

### 12. Competitor Analysis Workflow

**Competitor Identification**: Select 3-5 direct competitors + 2-3 aspirational brands in adjacent categories. Criteria: similar audience size, overlapping target market, active on same platforms.

**Monitoring Cadence**:

| Activity | Frequency | Output |
|----------|-----------|--------|
| Content audit (top posts, format, frequency) | Monthly | Competitor content scorecard |
| Engagement benchmarking | Monthly | Comparative engagement table |
| New feature/format adoption | Bi-weekly | Trend alert |
| Campaign tracking (launches, promotions) | Ongoing | Campaign log |

**Benchmarking Metrics**:

| Metric | Your Brand | Competitor A | Competitor B | Industry Avg |
|--------|-----------|-------------|-------------|-------------|
| Posting frequency | — | — | — | — |
| Avg. engagement rate | — | — | — | — |
| Follower growth rate | — | — | — | — |
| Response time | — | — | — | — |
| Content mix (edu/engage/promo) | — | — | — | — |

**Gap Analysis**: For each competitor, identify 1-2 content themes or formats they execute well that your brand does not. Prioritize gaps by audience demand (search volume, comment requests) and feasibility (can you produce this content with current resources).

### 13. Audience Segmentation

**Platform-Specific Persona Mapping**:

| Persona | Primary Platform | Content Preference | Peak Activity | Engagement Style |
|---------|-----------------|-------------------|---------------|-----------------|
| Decision Makers | LinkedIn | Data, case studies, thought leadership | Tue-Thu 7-9am | Comment on insights, share to network |
| Practitioners | Twitter/X | Tips, tools, threads | Mon-Fri 9-11am | Retweet, reply with experience |
| Visual Learners | Instagram | Carousels, infographics, Reels | Mon-Fri 12-2pm | Save, share to Stories |
| Gen Z / Early Adopters | TikTok | Short video, trends, humor | Daily 7-10pm | Duet, stitch, comment |

**Personalization Rules**:
- LinkedIn: Lead with data or a contrarian take; professional tone; no emojis in first line
- Twitter/X: Lead with a hook or hot take; conversational; 1-2 relevant emojis acceptable
- Instagram: Visual-first; caption supports the image; emojis as section breaks
- TikTok: Hook in first 1.5 seconds; casual/authentic tone; trending audio when relevant

### 14. Content Quality Checklist

Pre-publish gate — every post must pass all 8 checks before scheduling:

| # | Check | Pass Criteria |
|---|-------|---------------|
| 1 | Brand voice | Matches approved tone guidelines for the target platform |
| 2 | Visual quality | Correct dimensions per platform, no pixelation, brand colors applied |
| 3 | Accessibility | Alt text on images, captions on video, sufficient color contrast |
| 4 | Compliance | Required disclosures present (#ad, #sponsored), copyright cleared, no regulatory violations |
| 5 | Links | UTM parameters attached, destination URL verified and loading correctly |
| 6 | CTA | Clear, platform-appropriate call-to-action present |
| 7 | Character count | Within platform limit with room for hashtags |
| 8 | Timing | Scheduled within optimal posting window for target platform |

### 15. Crisis Management

**Severity Levels**:

| Level | Definition | Example | Response Time |
|-------|-----------|---------|---------------|
| 1 — Low | Negative comment or minor complaint | Product complaint, service issue | Within 2 hours |
| 2 — Medium | Viral negative post or coordinated criticism | Trending hashtag against brand, influencer callout | Within 1 hour |
| 3 — High | Brand-threatening incident with media coverage | Data breach, executive controversy, offensive content published | Within 15 minutes |

**Escalation Path**:
1. Community manager identifies and classifies severity
2. Level 1: Community manager responds with approved template, logs incident
3. Level 2: Escalate to social media lead + PR team; draft custom response; pause scheduled content
4. Level 3: Escalate to VP Communications + Legal; all scheduled content paused; hold statement issued within 15 min

**Template Responses** (customize per incident):
- **Acknowledgment**: "We're aware of [issue] and are looking into it. We'll share an update within [timeframe]."
- **Resolution**: "We've resolved [issue]. Here's what happened and what we've done to prevent it: [link]."
- **Apology**: "We made a mistake with [specific issue]. We take full responsibility and have [specific action taken]."

**Post-Crisis Review** (within 72 hours):
1. Timeline of events and response actions
2. What worked vs. what needs improvement
3. Template and escalation path updates
4. Preventive measures for similar incidents

### 16. Tool Stack Recommendations

| Category | Tools | Purpose |
|----------|-------|---------|
| Scheduling | Buffer, Hootsuite, Later, Sprout Social | Post scheduling and queue management |
| Analytics | Native platform analytics + Google Analytics | Performance tracking and attribution |
| Design | Canva, Figma, Adobe Express | Visual asset creation |
| Monitoring | Mention, Brandwatch, Sprout Social | Brand monitoring and sentiment tracking |
| Collaboration | Notion, Trello, Asana | Content calendar management and approval workflows |
| Link Management | Bitly, UTM.io | Link shortening and UTM parameter management |
| Competitor Intel | Similarweb, Social Blade | Competitor benchmarking |

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
- Always run the Content Quality Checklist (section 14) before scheduling any post.
- Always attach UTM parameters to every outbound link in social posts.
- Always log A/B test results in the campaign archive for future reference.
- Never use generic hashtags without checking current volume and relevance.
- Never cross-post identical content across platforms without format adaptation.
- Never publish without confirming the posting time aligns with audience activity data.
- Never prioritize follower count over engagement rate as a success metric.
- Never skip the content pillar balance check across the weekly calendar.
- Never declare an A/B test winner below 500 impressions per variant or without 95% confidence.
- Never respond to a Level 2+ crisis without escalating per the crisis management path.

## Iteration

After delivering the first draft:
1. Ask if changes are needed
2. Apply feedback and regenerate
3. Maximum 3 revision rounds
4. On round 3, deliver final with "this is the final version" note

## Cold Start

When the user has no existing social media presence or content history:
1. Audit competitor accounts to establish baseline benchmarks
2. Define 3 content pillars (defer Entertaining and UGC until audience forms)
3. Create a 2-week starter calendar at minimum viable frequency per platform
4. Set week-1 KPI targets at 50% of industry average (ramp expectations)
5. Review performance after 2 weeks; adjust pillar mix and frequency

## References

- See `${CLAUDE_SKILL_DIR}/references/platform-specifications.md` for platform specifications
- See `${CLAUDE_SKILL_DIR}/references/content-pillar-strategy.md` for content pillar strategy
- See `${CLAUDE_SKILL_DIR}/references/production-workflow.md` for detailed production workflow phases


## Rationalizations

The following table captures common excuses agents make to skip the rigor of this marketing practice, paired with factual rebuttals.

| Excuse | Rebuttal |
|--------|----------|
| "Post the same content on every platform." | Each platform has distinct format, aspect ratio, and hook conventions; cross-posting raw content yields 30-60% lower engagement. |
| "Follower count is the goal." | Followers without engagement are a vanity metric; reach, saves, and shares predict revenue impact. |
| "Posting frequency is what matters most." | Over-posting trains the algorithm to reduce per-post reach; quality and timing beat raw volume on every platform since 2023. |
| "Organic reach will come back." | Organic reach on Meta platforms has declined to 1-5% and will not recover; plan with paid amplification in the mix. |
| "Hashtags don't matter anymore." | Hashtags drive discovery on TikTok, Instagram Reels, and LinkedIn; the specific tactic changes, but the discovery function remains. |
| "We don't need A/B testing for social." | Without controlled tests, you are guessing which hooks, CTAs, and formats work; even small sample tests outperform intuition over time. |
| "Crisis management is overkill for our brand." | One viral negative post can undo months of brand building; having a response plan costs nothing until the day it saves everything. |
| "Competitor analysis takes too much time." | A monthly 30-minute scan of 3-5 competitor accounts reveals content gaps and format ideas that would otherwise require expensive original research. |
