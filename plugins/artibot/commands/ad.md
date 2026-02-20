---
description: Ad copy creation, creative briefs, campaign structure, and A/B variant generation for paid channels
argument-hint: '[ad-type] e.g. "구글 검색광고 카피 작성"'
allowed-tools: [Read, Write, Task, WebSearch, TaskCreate]
---

# /ad

Creates advertising assets including ad copy, creative briefs, campaign structures, and A/B test variants for paid advertising channels. Handles platform-specific ad format constraints and best practices.

## Arguments

Parse $ARGUMENTS:
- `ad-type`: Ad type - `search` | `display` | `social` | `video` | `native` | `retargeting`
- `--channel [platform]`: Ad channel - `google` | `meta` | `linkedin` | `twitter` | `tiktok` | `youtube`
- `--variants [n]`: Number of copy variants to generate (default: 3)
- `--brief`: Generate creative brief before ad copy
- `--audience [segment]`: Target audience description
- `--budget [amount]`: Campaign budget for bid strategy recommendations
- `--objective [goal]`: Campaign objective - `awareness` | `traffic` | `conversion` | `leads` | `sales`
- `--landing [url]`: Landing page URL for message consistency check

## Ad Format Specs

| Channel | Headlines | Descriptions | Constraints |
|---------|-----------|-------------|-------------|
| Google Search | 30 chars x 15 | 90 chars x 4 | + sitelinks, callouts |
| Meta/Facebook | 40 chars headline | 125 chars primary text | + 30 chars description |
| LinkedIn | 70 chars headline | 150 chars intro text | + CTA button |
| Video (any) | Hook 0-3s | 30s total | Script with timestamps |

## Agent Delegation

- Primary: `ad-specialist` - Ad copy creation
- Supporting: `data-analyst` - Performance prediction and optimization

## Skills Required

- `advertising` - Ad platform constraints, bidding strategies, quality score optimization
- `copywriting` - Persuasive writing, headline formulas, CTA optimization
- `ab-testing` - Variant design, statistical significance, test methodology

## Execution Flow

1. **Parse**: Extract ad type, channel, audience, objectives
2. **Research**: Competitor ads, keyword costs, audience insights via WebSearch
3. **Brief** (if `--brief`): Generate creative brief:
   - Objective, audience, key message, tone, constraints
4. **Create**: Generate ad copy per channel format:
   - **Google Search**: Headlines (30 chars x 15), Descriptions (90 chars x 4), sitelinks
   - **Meta/Facebook**: Primary text (125 chars), Headline (40 chars), Description (30 chars), image specs
   - **LinkedIn**: Intro text (150 chars), Headline (70 chars), image specs, CTA button
   - **Video**: Script with hook (0-3s), problem (3-10s), solution (10-20s), CTA (20-30s)
5. **A/B Variants**: Generate N variants per ad element:
   - Different headline angles (benefit, urgency, social proof, curiosity)
   - Different CTAs (action-oriented, benefit-oriented, urgency-driven)
6. **Optimize**: Quality score recommendations:
   - Message-landing page alignment
   - Keyword-headline match
   - Ad relevance signals
7. **Report**: Output ad package with format compliance

## Output Format

```
ADVERTISING CAMPAIGN
====================
Type:       [ad-type]
Channel:    [platform]
Objective:  [goal]
Audience:   [segment description]
Variants:   [count]

CREATIVE BRIEF (if --brief)
----------------------------
Objective:  [campaign goal]
Audience:   [target segment]
Key Message:[core value proposition]
Tone:       [voice/style]
Constraints:[character limits, format rules]
CTA:        [desired action]

AD VARIANTS
-----------
Variant A [Control]:
  Headline:    [text] ([count]/[limit] chars)
  Description: [text] ([count]/[limit] chars)
  CTA:         [button text]
  Image:       [concept/specs]

Variant B [Benefit Focus]:
  Headline:    [text] ([count]/[limit] chars)
  Description: [text] ([count]/[limit] chars)
  CTA:         [button text]

Variant C [Urgency]:
  [...]

FORMAT COMPLIANCE
-----------------
Channel:    [platform]
[element]:  [PASS|OVER LIMIT] ([count]/[limit])

OPTIMIZATION NOTES
------------------
- [Quality score improvement suggestion]
- [Targeting refinement recommendation]
- [Bid strategy suggestion based on objective]
```

## Example Usage

```
/ad search --channel google --objective conversion --variants 5 --audience "SaaS decision makers"
/ad social --channel meta --brief --objective leads --budget 5000
/ad video --channel youtube --variants 3 --objective awareness
/ad retargeting --channel meta,google --audience "cart abandoners" --objective sales
```
