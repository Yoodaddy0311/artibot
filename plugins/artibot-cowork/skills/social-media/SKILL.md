---
context: fork
name: social-media
description: "Creates multi-platform social media content with scheduling strategy, engagement optimization, platform-specific formats, and content calendars. Use when user asks about social media, Twitter, LinkedIn, Instagram, TikTok, YouTube, content calendar, hashtag strategy, social engagement, 소셜 미디어, 소셜 콘텐츠, 콘텐츠 캘린더, 카카오스토리, 네이버 블로그, 밴드, or 한국 SNS."
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
- Running end-to-end content production workflows
- Auditing content quality before publishing
- Managing social media crises
- Conducting competitor analysis on social channels
- Creating content for Korean platforms (네이버, 카카오, 밴드)

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

#### 카카오채널
| Element | Spec | Best Practice |
|---------|------|---------------|
| 친구톡 | 이미지+텍스트+버튼 | 주 1-2회, 프로모션/정보성 혼합 |
| 알림톡 | 템플릿 기반 | 주문/예약/CS 자동화 |
| 포스트 | 카드뉴스 형태 | 비주얼 중심, 3-5장 카드 |
| 타겟 | 전 연령대 | 국내 메신저 점유율 1위 플랫폼 |

### 4. Hashtag Strategy

| Type | Volume | Count | Example |
|------|--------|-------|---------|
| Broad | 500K+ posts | 1-2 | #Marketing, #AI |
| Medium | 50K-500K | 3-4 | #ContentMarketing, #MarTech |
| Niche | 5K-50K | 2-3 | #SaaSGrowth, #B2BMarketing |
| Branded | Any | 1 | #YourBrandName |

**한국 해시태그 전략**:
- 네이버 블로그: 검색량 기반 키워드 + 카테고리 태그 (10-15개), 네이버 데이터랩으로 트렌드 확인
- 카카오스토리: 감성 키워드 중심 (5개 이내), #일상 #소확행 등 생활 밀착형
- 밴드: 그룹 내부 검색용 태그 (3-5개), 그룹 주제 일관성 유지

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
| 네이버 블로그 | 3-7% | 7-12% | 12%+ |
| 카카오스토리 | 1-3% | 3-6% | 6%+ |

### 7. Content Repurposing Matrix

| Source | Twitter/X | LinkedIn | Instagram | TikTok | 네이버 블로그 |
|--------|----------|----------|-----------|--------|------------|
| Blog post | Key takeaways thread | Summary + link | Carousel | Quick tip video | 전문 심화 버전 (3,000자+) |
| Webinar | Quote clips | Full recap | Behind-scenes stories | Highlight clips | 발표 요약 + 핵심 인사이트 |
| Case study | Stats thread | Full post | Before/after carousel | Customer story | 상세 사례 분석 |
| Report | Data highlights | Analysis post | Infographic carousel | Data explainer | 데이터 해석 + 전문가 코멘트 |

### 8. Production Workflow

End-to-end content production pipeline with gate criteria at each phase:

```
Brief → Research → Draft → Internal Review → Asset Creation → Platform Optimization → Schedule → Publish → Monitor → Engage → Report → Archive
```

**한국 플랫폼 추가 워크플로우**:
- 네이버 블로그: Research 단계에서 네이버 데이터랩 키워드 분석 필수. C-Rank/DIA 노출 전략 반영
- 카카오채널: 친구톡 발송 전 테스트 발송 (내부 계정) 필수. 카카오 비즈니스 가이드라인 준수 확인
- 밴드: 그룹 관리자 사전 승인 후 발행. 알림 빈도 과다 시 그룹 이탈률 체크

### 9. Campaign Integration

**UTM Parameter Standards**:
```
utm_source   = [platform] (twitter, linkedin, instagram, tiktok, naver-blog, kakao)
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
| 네이버 블로그 → 카카오채널 | 블로그 발행일 | 카카오채널 요약 포스트 당일 발행 | 블로그 트래픽 유도 + 카카오 친구 확보 |

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

**한국 플랫폼 A/B 테스트 고려사항**:

| Variable | Platform | 특이 사항 |
|----------|----------|----------|
| 포스트 길이 (1,500자 vs 3,000자+) | 네이버 블로그 | C-Rank 체류 시간 영향, 최소 7일 테스트 |
| 썸네일 스타일 (텍스트 vs 이미지) | 네이버 블로그 | 검색 결과 CTR 비교, 최소 2주 |
| 친구톡 발송 시간 (오전 vs 오후) | 카카오채널 | 열람률 기준, 동일 콘텐츠 시간대 교차 테스트 |
| 카드뉴스 장수 (3장 vs 5장) | 카카오채널/스토리 | 완독률과 공유율 비교 |
| 투표 vs 일반 포스트 | 밴드 | 참여율 비교, 그룹 성격별 차이 큼 |

**Statistical Significance**: Minimum 95% confidence level. Use two-proportion z-test for engagement rate comparisons. Do not declare a winner below 500 impressions per variant.

**Winner Selection Process**:
1. Run test for minimum duration (see table above)
2. Compare primary KPI (engagement rate or CTR) across variants
3. Confirm statistical significance at p < 0.05
4. Scale winning variant across remaining scheduled posts
5. Document result in campaign archive for future reference

### 11. Performance Measurement

**Weekly KPI Dashboard**:

| Metric | Twitter/X | LinkedIn | Instagram | TikTok | 네이버 | 카카오 | Total |
|--------|----------|----------|-----------|--------|--------|--------|-------|
| Impressions | — | — | — | — | — | — | — |
| Reach | — | — | — | — | — | — | — |
| Engagement Rate | — | — | — | — | — | — | — |
| Link Clicks | — | — | — | — | — | — | — |
| Follower Change | — | — | — | — | — | — | — |
| Top Post | — | — | — | — | — | — | — |

**Monthly Report Structure**:
1. Executive summary (3-5 sentences: wins, misses, next actions)
2. KPI trends vs. prior month (table with directional arrows)
3. Top 5 performing posts with analysis of why they worked
4. Bottom 3 performing posts with diagnosis
5. Content pillar ratio (actual vs. target 40/25/20/10/5)
6. 한국 플랫폼 별도 섹션: 네이버 C-Rank 변동, 카카오채널 친구 증감, 밴드 그룹 활성도
7. Recommendations for next month

**Quarterly Trend Analysis**:
- Quarter-over-quarter growth rates for reach, engagement, and conversions
- Platform mix shift (where is audience growing/declining)
- Content format performance ranking
- Seasonal pattern identification
- 한국 시장 트렌드: 시즌 키워드 (설날, 추석, 블프 등), 포털 알고리즘 변경 영향

**Attribution Model**: Last-touch social attribution for direct conversions; assisted-touch for content that appeared in a multi-step path. Track via UTM parameters in Google Analytics or equivalent. Report both direct and assisted social conversions monthly. 네이버 블로그는 네이버 애널리틱스 병행 사용.

### 12. Competitor Analysis Workflow

**Competitor Identification**: Select 3-5 direct competitors + 2-3 aspirational brands in adjacent categories. Criteria: similar audience size, overlapping target market, active on same platforms.

**Monitoring Cadence**:

| Activity | Frequency | Output |
|----------|-----------|--------|
| Content audit (top posts, format, frequency) | Monthly | Competitor content scorecard |
| Engagement benchmarking | Monthly | Comparative engagement table |
| New feature/format adoption | Bi-weekly | Trend alert |
| Campaign tracking (launches, promotions) | Ongoing | Campaign log |
| 네이버 블로그 C-Rank/상위노출 모니터링 | Weekly | 키워드별 노출 순위 추적 |

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
| 한국 직장인 | 네이버 블로그 + LinkedIn | 전문 정보, 업계 트렌드 | 평일 오전 9-11시, 점심 12-1시 | 공감, 이웃 추가, 댓글 |
| 한국 주부/생활인 | 카카오스토리 + 밴드 | 생활 정보, 레시피, 지역 소식 | 평일 오전 10-12시 | 공유, 투표 참여, 감정 반응 |
| 한국 커뮤니티 리더 | 밴드 | 모임 공지, 정보 공유, 설문 | 저녁 8-10시 | 투표 생성, 댓글 토론 |

**Personalization Rules**:
- LinkedIn: Lead with data or a contrarian take; professional tone; no emojis in first line
- Twitter/X: Lead with a hook or hot take; conversational; 1-2 relevant emojis acceptable
- Instagram: Visual-first; caption supports the image; emojis as section breaks
- TikTok: Hook in first 1.5 seconds; casual/authentic tone; trending audio when relevant
- 네이버 블로그: 정보성 + 경험담 혼합; 검색 유입 고려 키워드 반영; 존댓말 기본
- 카카오채널: 친근하고 간결한 어조; 카드뉴스 형태 선호; 이모지 적극 활용
- 밴드: 공지 톤 또는 대화체; 그룹 성격에 맞춘 어조; 투표/설문 적극 활용

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

**한국 규정 준수 추가 체크**:

| # | Check | Pass Criteria |
|---|-------|---------------|
| 9 | 표시광고법 | 광고/협찬 표시 명확 (포스트 상단에 "광고", "협찬" 명시) |
| 10 | 개인정보보호법 | 고객 사진/정보 사용 시 동의 확보, 개인정보 노출 없음 |
| 11 | 전자상거래법 | 가격/할인 정보 정확, 청약철회 안내 포함 (쇼핑 관련 시) |
| 12 | 한국어 맞춤법 | 맞춤법 검사 완료 (네이버 맞춤법 검사기 활용) |

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

**한국어 위기 대응 템플릿**:
- **인지**: "[이슈]에 대해 인지하고 있으며, 현재 확인 중입니다. [시간] 이내에 안내드리겠습니다."
- **해결**: "[이슈]가 해결되었습니다. 경위와 재발 방지 대책을 안내드립니다: [링크]"
- **사과**: "[구체적 이슈]에 대해 진심으로 사과드립니다. [구체적 조치]를 완료했습니다."

**Post-Crisis Review** (within 72 hours):
1. Timeline of events and response actions
2. What worked vs. what needs improvement
3. Template and escalation path updates
4. Preventive measures for similar incidents

### 16. Tool Stack Recommendations

| Category | Global Tools | Korean Tools | Purpose |
|----------|-------------|-------------|---------|
| Scheduling | Buffer, Hootsuite, Later | — | Post scheduling and queue management |
| Analytics | Native + Google Analytics | 네이버 애널리틱스, 카카오 비즈보드 | Performance tracking and attribution |
| Design | Canva, Figma, Adobe Express | 미리캔버스 | Visual asset creation |
| Monitoring | Mention, Brandwatch | 소셜메트릭스, 빅풋9 | Brand monitoring and sentiment tracking |
| Collaboration | Notion, Trello, Asana | — | Content calendar and approval workflows |
| Link Management | Bitly, UTM.io | 네이버 단축URL | Link shortening and UTM management |
| Competitor Intel | Similarweb, Social Blade | 블로그차트, 네이버 데이터랩 | Competitor benchmarking |
| Ad Management | Meta Ads Manager | 카카오 비즈보드, 네이버 검색광고 | Paid amplification |
| Spelling | Grammarly | 네이버 맞춤법 검사기 | Copy quality assurance |

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
- Always run the Content Quality Checklist (section 14) before scheduling any post.
- Always attach UTM parameters to every outbound link in social posts.
- Always log A/B test results in the campaign archive for future reference.
- Always apply Korean regulatory checks (표시광고법, 개인정보보호법) for Korean platform content.
- Never use generic hashtags without checking current volume and relevance.
- Never cross-post identical content across platforms without format adaptation.
- Never publish without confirming the posting time aligns with audience activity data.
- Never prioritize follower count over engagement rate as a success metric.
- Never skip the content pillar balance check across the weekly calendar.
- Never declare an A/B test winner below 500 impressions per variant or without 95% confidence.
- Never respond to a Level 2+ crisis without escalating per the crisis management path.
- Never publish 광고/협찬 content on Korean platforms without explicit disclosure at the top of the post.

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
6. For Korean platforms: start with 네이버 블로그 (highest search discovery potential), add 카카오채널 once blog cadence is stable

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
| "Korean platforms don't need the same rigor." | 네이버 C-Rank, 카카오 알고리즘, 밴드 그룹 다이나믹스 are as algorithmically complex as global platforms; skipping optimization means invisible content. |
