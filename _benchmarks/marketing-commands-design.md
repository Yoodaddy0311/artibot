# Marketing Agency Commands Design for Artibot

> Artibot Plugin v1.1 - Marketing Agency Extension
> Designed to follow existing Artibot command patterns (YAML frontmatter, execution flow, agent delegation, Team API integration)
> Cross-referenced with Skills Research (Task #3): coreyhaines31/marketingskills (25 skills), anthropics/skills (pptx/xlsx/docx/pdf), alirezarezvani/claude-skills, Agent-Skills-for-Context-Engineering patterns

---

## Design Principles

1. **Follow Existing Patterns**: YAML frontmatter with `description`, `argument-hint`, `allowed-tools`. Execution flows with Parse -> Context -> Execute -> Verify -> Report structure.
2. **Agent Delegation**: Each command routes to specialized agents via Task tool (sub-agent) or Agent Teams API (team mode) depending on complexity.
3. **Skill Composition**: Commands compose skills for domain knowledge. New marketing skills fill gaps not covered by existing skills.
4. **Consolidation Principle**: Prefer fewer comprehensive commands over many narrow ones. Each command should own a clear workflow domain.
5. **SC Router Integration**: All new commands register in `/sc` routing table with confidence scores.

---

## Command Summary Matrix

| Command | Category | Purpose | Primary Agent | Complexity |
|---------|----------|---------|---------------|------------|
| `/mkt` | Strategy | Marketing strategy, market analysis, campaign planning | marketing-strategist (NEW) | moderate-complex |
| `/email` | Campaign | Email campaign creation, A/B testing, automation sequences | content-marketer + email-specialist (NEW) | moderate |
| `/ppt` | Presentation | Slide deck structure, narrative design, visual layouts | presentation-designer (NEW) | moderate |
| `/excel` | Analytics | Data analysis, report generation, dashboard design | data-analyst (NEW) | moderate |
| `/social` | Social Media | Social media content, scheduling, platform optimization | content-marketer | simple-moderate |
| `/ad` | Advertising | Ad copy, creative briefs, campaign structure, A/B variants | ad-specialist (NEW) | moderate |
| `/seo` | Search | SEO audit, keyword strategy, technical SEO, content SEO | seo-specialist (NEW) | moderate-complex |
| `/crm` | Customer | CRM workflow design, customer journey mapping, segmentation | marketing-strategist (NEW) | moderate |
| `/analytics` | Reporting | Marketing analytics, KPI dashboards, performance reports | data-analyst (NEW) | moderate |
| `/cro` | Conversion | Conversion rate optimization, landing page audit, funnel optimization | cro-specialist (NEW) | moderate |

> **Skills Research Integration Note**: The coreyhaines31/marketingskills repo contains 6 dedicated CRO skills (page-cro, signup-flow-cro, onboarding-cro, form-cro, popup-cro, paywall-upgrade-cro), confirming CRO as a standalone command domain. Additionally, Anthropic's official pptx/xlsx skills should be integrated as dependencies for `/ppt` and `/excel` commands.

---

## Command Designs

---

### 1. `/mkt` - Marketing Strategy

```yaml
---
description: Marketing strategy planning with market analysis, competitive intelligence, and campaign architecture
argument-hint: [strategy-type] [--market] [--competitor] [--campaign] [--budget]
allowed-tools: [Read, Write, Glob, Grep, Task, WebSearch, TodoWrite]
---
```

**Category**: Strategy & Planning

**Description**: End-to-end marketing strategy command. Analyzes market conditions, competitive landscape, and audience segments to produce actionable marketing plans with budget allocation and channel strategy.

**Required Skills**:
- `marketing-strategy` (NEW) - Market analysis frameworks, positioning, segmentation
- `competitive-intelligence` (NEW) - Competitor analysis, SWOT, differentiation
- `campaign-planning` (NEW) - Campaign architecture, funnel design, budget allocation
- `persona-scribe` (existing) - Professional writing and documentation

**Agent Delegation**:
- Primary: `marketing-strategist` (NEW agent) - Strategy formulation and market analysis
- Supporting: `content-marketer` (existing) - Content strategy alignment
- Supporting: `data-analyst` (NEW agent) - Market data analysis and forecasting

**Arguments**:
```
Parse $ARGUMENTS:
- strategy-type: Type of strategy - `go-to-market` | `content` | `growth` | `brand` | `product-launch` | `repositioning`
- --market [segment]: Target market segment or industry vertical
- --competitor [names]: Competitor names for comparative analysis (comma-separated)
- --campaign [name]: Campaign context for strategy alignment
- --budget [range]: Budget tier - `bootstrap` (<$5K) | `growth` ($5K-$50K) | `scale` ($50K-$500K) | `enterprise` ($500K+)
- --channels: Include channel strategy and allocation recommendations
- --timeline [period]: Strategy timeline - `quarterly` | `half-year` | `annual`
```

**Execution Flow**:
1. **Parse**: Extract strategy type, market context, constraints, and budget parameters
2. **Research**: Use WebSearch for:
   - Market size and growth trends
   - Competitor positioning and messaging
   - Industry benchmarks and best practices
   - Channel performance data
3. **Analyze**: Delegate to Task(marketing-strategist) for:
   - SWOT analysis of current position
   - Target audience segmentation and personas
   - Competitive differentiation mapping
   - Channel-market fit assessment
4. **Strategize**: Build marketing plan:
   - Positioning statement and value propositions
   - Channel strategy with budget allocation
   - Campaign calendar with milestones
   - KPI framework with targets
5. **Validate**: Cross-reference strategy against budget constraints and timeline
6. **Report**: Output structured strategy document

**Output Format**:
```
MARKETING STRATEGY
==================
Type:       [go-to-market|content|growth|brand|product-launch|repositioning]
Market:     [target segment]
Budget:     [tier and allocation]
Timeline:   [period]

MARKET ANALYSIS
---------------
Market Size:   [TAM/SAM/SOM]
Growth Rate:   [YoY%]
Key Trends:    [trend list]

COMPETITIVE LANDSCAPE
---------------------
[Competitor]: [positioning] | [strengths] | [weaknesses]

STRATEGY
--------
Positioning: [statement]
Value Props:  [1-3 key value propositions]

CHANNEL PLAN
------------
Channel       | Budget % | Expected ROI | Priority
--------------|----------|-------------|----------
[channel]     | [%]      | [ROI]       | [P1-P3]

CAMPAIGN CALENDAR
-----------------
[Month]: [campaign/initiative] -> [channel] -> [KPI target]

KPI FRAMEWORK
-------------
Metric:    [KPI]  | Target: [value] | Tracking: [method]
```

**Example Usage**:
```
/mkt go-to-market --market "B2B SaaS" --competitor "Notion,Coda,Airtable" --budget growth --timeline quarterly
/mkt content --channels --market "developer tools"
/mkt growth --budget bootstrap --timeline half-year
```

---

### 2. `/email` - Email Campaign

```yaml
---
description: Email campaign creation with A/B testing, segmentation, automation sequences, and deliverability optimization
argument-hint: [campaign-type] [--segment] [--ab] [--automation] [--template]
allowed-tools: [Read, Write, Task, WebSearch, TodoWrite]
---
```

**Category**: Campaign Execution

**Description**: Full email marketing workflow from audience segmentation through campaign creation, A/B test design, and automation sequence building. Produces ready-to-deploy email assets with HTML templates.

**Required Skills**:
- `email-marketing` (NEW) - Email best practices, deliverability, CAN-SPAM compliance
- `ab-testing` (NEW) - Statistical testing design, sample sizing, significance calculation
- `copywriting` (NEW) - Persuasive writing, subject lines, CTAs
- `persona-scribe` (existing) - Professional writing

**Agent Delegation**:
- Primary: `content-marketer` (existing) - Email copy and content creation
- Supporting: `data-analyst` (NEW) - A/B test design and segment analysis

**Arguments**:
```
Parse $ARGUMENTS:
- campaign-type: Email type - `newsletter` | `drip` | `announcement` | `onboarding` | `re-engagement` | `transactional` | `launch` | `nurture`
- --segment [criteria]: Audience segment - `all` | `active` | `churned` | `trial` | `enterprise` | custom criteria
- --ab [element]: A/B test element - `subject` | `cta` | `layout` | `timing` | `sender`
- --automation: Generate automation sequence with triggers and delays
- --template [style]: Email template style - `minimal` | `branded` | `rich` | `plain-text`
- --tone [voice]: Content tone - `professional` | `casual` | `urgent` | `educational` | `celebratory`
- --series [n]: Number of emails in sequence (default: 1, max: 12)
```

**Execution Flow**:
1. **Parse**: Extract campaign type, segment, A/B requirements, tone
2. **Research**: Benchmark subject line patterns, industry open rates, best send times
3. **Segment**: Define audience criteria and personalization variables
4. **Create**: Generate email content:
   - Subject line variants (3-5 options with A/B scoring rationale)
   - Preheader text
   - Email body with personalization tokens
   - CTA variants with placement recommendations
   - Plain-text fallback version
5. **Automate** (if `--automation`): Design sequence:
   - Trigger events and conditions
   - Delay intervals between emails
   - Branch logic (opened/clicked/ignored)
   - Exit conditions
6. **A/B Design** (if `--ab`): Specify test parameters:
   - Test hypothesis
   - Variants (control + treatment)
   - Sample size recommendation
   - Success metric and significance threshold
7. **Compliance Check**: Verify CAN-SPAM/GDPR compliance:
   - Unsubscribe link present
   - Physical address included
   - Permission-based sending confirmed
8. **Report**: Output email package with metrics predictions

**Output Format**:
```
EMAIL CAMPAIGN
==============
Type:       [campaign-type]
Segment:    [audience criteria]
Series:     [n emails]
Template:   [style]

EMAILS
------
Email 1: [subject line]
  Preheader: [text]
  Body: [content with {{personalization}} tokens]
  CTA: [primary CTA text] -> [URL placeholder]
  Send Time: [recommended time/day]

A/B TEST (if --ab)
------------------
Hypothesis: [what we're testing]
Variant A:  [control description]
Variant B:  [treatment description]
Sample:     [recommended size]
Duration:   [test period]
Metric:     [primary success metric]

AUTOMATION (if --automation)
----------------------------
Trigger: [event]
  -> [delay] -> Email 1: [subject]
  -> [delay] -> Email 2: [subject]
    -> IF opened: [branch A]
    -> IF not opened: [branch B]
  -> Exit: [condition]

COMPLIANCE
----------
CAN-SPAM:   [PASS|ISSUE]
GDPR:       [PASS|ISSUE]
Unsubscribe: [present|missing]

PREDICTIONS
-----------
Est. Open Rate:    [%] (industry avg: [%])
Est. Click Rate:   [%] (industry avg: [%])
Est. Conversion:   [%]
```

**Example Usage**:
```
/email onboarding --series 5 --automation --segment trial --tone educational
/email newsletter --ab subject --template branded --tone professional
/email launch --segment active --ab cta --tone urgent
/email re-engagement --segment churned --automation --series 3
```

---

### 3. `/ppt` - Presentation Design

```yaml
---
description: Presentation structure design with narrative flow, slide layouts, speaker notes, and visual recommendations
argument-hint: [topic] [--type pitch|report|workshop|keynote] [--slides n] [--audience]
allowed-tools: [Read, Write, Glob, Grep, Task, WebSearch, TodoWrite]
---
```

**Category**: Presentation & Communication

**Description**: Designs complete presentation structures including narrative arc, slide-by-slide content, visual layout recommendations, speaker notes, and data visualization suggestions. Outputs structured slide decks as Markdown or exportable formats.

**Required Skills**:
- `presentation-design` (NEW) - Slide structure, narrative arc, visual hierarchy
- `data-visualization` (NEW) - Chart selection, data storytelling, visual encoding
- `copywriting` (NEW) - Headlines, bullet points, compelling narratives
- `persona-scribe` (existing) - Professional writing

**Agent Delegation**:
- Primary: `presentation-designer` (NEW agent) - Slide structure and narrative design
- Supporting: `content-marketer` (existing) - Content creation and messaging
- Supporting: `data-analyst` (NEW) - Data visualization recommendations

**Arguments**:
```
Parse $ARGUMENTS:
- topic: Presentation topic or brief
- --type [kind]: Presentation type - `pitch` | `report` | `workshop` | `keynote` | `sales` | `training` | `review`
- --slides [n]: Target slide count (default: 10-15)
- --audience [who]: Target audience - `executive` | `technical` | `investor` | `customer` | `internal` | `general`
- --style [design]: Visual style - `corporate` | `modern` | `minimal` | `bold` | `data-heavy`
- --include-notes: Generate speaker notes per slide
- --data [source]: Data source file for charts/visualizations
- --duration [min]: Presentation duration in minutes (auto-calculates pacing)
```

**Execution Flow**:
1. **Parse**: Extract topic, audience level, type, constraints
2. **Research**: Gather supporting data and examples via WebSearch
3. **Structure**: Design narrative arc:
   - **Pitch**: Problem -> Solution -> Market -> Traction -> Team -> Ask
   - **Report**: Executive Summary -> Key Metrics -> Deep Dives -> Recommendations -> Next Steps
   - **Workshop**: Learning Objectives -> Concept -> Demo -> Exercise -> Recap
   - **Keynote**: Hook -> Vision -> Evidence -> Call to Action
   - **Sales**: Pain Point -> Solution -> Proof -> Pricing -> Close
4. **Design Slides**: For each slide:
   - Headline (max 8 words)
   - Body content (bullet points or narrative)
   - Visual recommendation (chart type, image suggestion, layout)
   - Speaker notes (if `--include-notes`)
   - Transition to next slide
5. **Data Visualization** (if `--data`): Recommend chart types:
   - Comparison -> Bar/Column chart
   - Trend -> Line chart
   - Composition -> Pie/Stacked bar
   - Distribution -> Histogram/Scatter
   - Relationship -> Scatter/Bubble
6. **Pacing**: Calculate time per slide based on `--duration`
7. **Report**: Output complete slide deck structure

**Output Format**:
```
PRESENTATION DESIGN
===================
Topic:      [topic]
Type:       [pitch|report|workshop|keynote|sales|training|review]
Audience:   [target audience]
Slides:     [count]
Duration:   [minutes] ([seconds/slide] pacing)
Style:      [design style]

NARRATIVE ARC
-------------
[Opening Hook] -> [Problem/Context] -> [Solution/Content] -> [Evidence] -> [Call to Action/Close]

SLIDE DECK
----------
Slide 1: [TITLE SLIDE]
  Headline: [title]
  Subtitle: [subtitle]
  Visual: [logo, background image suggestion]
  Notes: [opening script]
  Time: [0:00 - 0:30]

Slide 2: [SECTION NAME]
  Headline: [max 8 words]
  Content:
    - [bullet point 1]
    - [bullet point 2]
    - [bullet point 3]
  Visual: [chart type / image / diagram recommendation]
  Notes: [speaker notes]
  Transition: [bridge to next slide]
  Time: [0:30 - 2:00]

[... continues for all slides ...]

DATA VISUALIZATIONS (if --data)
-------------------------------
Slide [n]: [Chart Type] - [Data Series] - [Key Insight]

DESIGN RECOMMENDATIONS
----------------------
Color Palette: [primary, secondary, accent]
Font Pairing:  [headline font] / [body font]
Layout Grid:   [grid description]
```

**Example Usage**:
```
/ppt "Q1 Marketing Results" --type report --audience executive --slides 12 --include-notes --duration 20
/ppt "Series A Pitch Deck" --type pitch --audience investor --slides 10 --style modern
/ppt "Developer Onboarding" --type workshop --audience technical --duration 60 --include-notes
/ppt "Product Launch" --type keynote --audience customer --style bold
```

---

### 4. `/excel` - Data Analysis & Reports

```yaml
---
description: Data analysis, report generation, dashboard design, and spreadsheet automation
argument-hint: [analysis-type] [--data source] [--format table|chart|dashboard] [--export]
allowed-tools: [Read, Write, Glob, Grep, Bash, Task, WebSearch, TodoWrite]
---
```

**Category**: Analytics & Reporting

**Description**: Data analysis and reporting command that processes data sources, generates insights, creates formatted tables and charts, designs dashboards, and produces analysis reports. Can generate CSV/TSV outputs, formula recommendations, and pivot table designs.

**Required Skills**:
- `data-analysis` (NEW) - Statistical analysis, data cleaning, insight extraction
- `data-visualization` (NEW) - Chart selection, dashboard layout, visual encoding
- `report-generation` (NEW) - Report templates, executive summaries, data narratives
- `persona-analyzer` (existing) - Systematic analysis methodology

**Agent Delegation**:
- Primary: `data-analyst` (NEW agent) - Data processing and analysis
- Supporting: `content-marketer` (existing) - Report narrative and insights storytelling

**Arguments**:
```
Parse $ARGUMENTS:
- analysis-type: Analysis type - `report` | `dashboard` | `forecast` | `comparison` | `funnel` | `cohort` | `attribution` | `roi`
- --data [source]: Data source file path or description of data to analyze
- --format [output]: Output format - `table` | `chart` | `dashboard` | `narrative` | `all`
- --export [type]: Export format - `csv` | `markdown` | `json` | `html`
- --period [range]: Time period - `daily` | `weekly` | `monthly` | `quarterly` | `ytd` | `custom`
- --compare [baseline]: Comparison baseline - `previous-period` | `yoy` | `target` | `competitor`
- --kpi [metrics]: Focus KPIs (comma-separated) - e.g., `cac,ltv,churn,mrr,arpu`
```

**Execution Flow**:
1. **Parse**: Extract analysis type, data source, output format, comparison parameters
2. **Ingest**: Read data source:
   - File-based: CSV, JSON, TSV, or markdown tables
   - Description-based: Generate sample data structure based on description
3. **Clean & Validate**: Data quality checks:
   - Missing value detection and handling strategy
   - Outlier identification
   - Data type validation
   - Consistency checks
4. **Analyze**: Apply analysis type:
   - **report**: Descriptive statistics, trends, highlights, anomalies
   - **dashboard**: KPI selection, layout design, widget recommendations
   - **forecast**: Trend projection, confidence intervals, scenario modeling
   - **comparison**: Delta analysis, percentage changes, benchmark comparison
   - **funnel**: Stage conversion rates, drop-off analysis, optimization recommendations
   - **cohort**: Retention curves, behavioral segmentation, lifetime value
   - **attribution**: Channel attribution models (first-touch, last-touch, linear, time-decay)
   - **roi**: Investment returns, payback period, cost-per-acquisition
5. **Visualize**: Recommend visualizations per insight:
   - Metric trends -> Line charts with annotations
   - Comparisons -> Grouped bar charts
   - Distributions -> Histograms or box plots
   - Funnels -> Funnel diagrams with conversion rates
6. **Generate**: Produce output in requested format
7. **Report**: Output analysis with insights and recommendations

**Output Format**:
```
DATA ANALYSIS REPORT
====================
Type:       [analysis-type]
Period:     [time range]
Data:       [source description]
Records:    [count]

EXECUTIVE SUMMARY
-----------------
[2-3 sentence summary of key findings]

KEY METRICS
-----------
Metric          | Current | Previous | Delta   | Status
----------------|---------|----------|---------|--------
[metric name]   | [value] | [value]  | [+/--%] | [up|down|stable]

DETAILED ANALYSIS
-----------------
[Section per analysis dimension]

INSIGHTS
--------
1. [High-impact finding with supporting data]
2. [Trend or pattern identified]
3. [Anomaly or concern flagged]

RECOMMENDATIONS
---------------
Priority | Action                    | Expected Impact
---------|---------------------------|----------------
P1       | [immediate action]        | [projected improvement]
P2       | [short-term optimization]  | [projected improvement]

VISUALIZATIONS
--------------
Chart 1: [type] - [title] - [data series]
Chart 2: [type] - [title] - [data series]

EXPORT
------
[File path or inline data in requested format]
```

**Example Usage**:
```
/excel report --data @marketing/q1-metrics.csv --period quarterly --compare yoy --format all
/excel dashboard --kpi cac,ltv,churn,mrr --period monthly --format dashboard
/excel funnel --data @analytics/signup-flow.json --compare previous-period
/excel roi --data @campaigns/ad-spend.csv --period quarterly --format narrative
/excel attribution --data @analytics/touchpoints.csv --kpi conversions
```

---

### 5. `/social` - Social Media Management

```yaml
---
description: Social media content creation, scheduling strategy, and platform-specific optimization
argument-hint: [content-type] [--platform twitter|linkedin|instagram|tiktok|all] [--campaign]
allowed-tools: [Read, Write, Task, WebSearch, TodoWrite]
---
```

**Category**: Social Media

**Description**: Creates platform-optimized social media content with scheduling recommendations, hashtag strategies, and engagement optimization. Handles multi-platform adaptation from a single content brief.

**Required Skills**:
- `social-media` (NEW) - Platform algorithms, optimal posting, engagement tactics
- `copywriting` (NEW) - Short-form writing, hooks, CTAs
- `persona-scribe` (existing) - Professional writing

**Agent Delegation**:
- Primary: `content-marketer` (existing) - Content creation
- Supporting: `data-analyst` (NEW) - Performance benchmarking

**Arguments**:
```
Parse $ARGUMENTS:
- content-type: Content type - `post` | `thread` | `carousel` | `story` | `reel-script` | `calendar`
- --platform [target]: Platform - `twitter` | `linkedin` | `instagram` | `tiktok` | `youtube` | `all`
- --campaign [name]: Campaign context for consistency
- --tone [voice]: Content tone - `professional` | `casual` | `witty` | `educational` | `provocative`
- --series [n]: Number of posts in a series/thread
- --schedule: Include optimal posting time recommendations
- --hashtags: Generate hashtag strategy per platform
- --repurpose [source]: Repurpose content from source (blog URL, article path, etc.)
```

**Execution Flow**:
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

**Output Format**:
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

**Example Usage**:
```
/social post --platform all --campaign "Product Launch" --tone witty --hashtags
/social thread --platform twitter --series 7 --tone educational
/social calendar --platform linkedin,twitter --campaign "Thought Leadership" --schedule
/social carousel --platform instagram,linkedin --repurpose @blog/latest-post.md
```

---

### 6. `/ad` - Advertising & Creative

```yaml
---
description: Ad copy creation, creative briefs, campaign structure, and A/B variant generation for paid channels
argument-hint: [ad-type] [--channel google|meta|linkedin|twitter] [--variants n] [--brief]
allowed-tools: [Read, Write, Task, WebSearch, TodoWrite]
---
```

**Category**: Advertising

**Description**: Creates advertising assets including ad copy, creative briefs, campaign structures, and A/B test variants for paid advertising channels. Handles platform-specific ad format constraints and best practices.

**Required Skills**:
- `advertising` (NEW) - Ad platform constraints, bidding strategies, quality score optimization
- `copywriting` (NEW) - Persuasive writing, headline formulas, CTA optimization
- `ab-testing` (NEW) - Variant design, statistical significance, test methodology

**Agent Delegation**:
- Primary: `content-marketer` (existing) - Ad copy creation
- Supporting: `data-analyst` (NEW) - Performance prediction and optimization

**Arguments**:
```
Parse $ARGUMENTS:
- ad-type: Ad type - `search` | `display` | `social` | `video` | `native` | `retargeting`
- --channel [platform]: Ad channel - `google` | `meta` | `linkedin` | `twitter` | `tiktok` | `youtube`
- --variants [n]: Number of copy variants to generate (default: 3)
- --brief: Generate creative brief before ad copy
- --audience [segment]: Target audience description
- --budget [amount]: Campaign budget for bid strategy recommendations
- --objective [goal]: Campaign objective - `awareness` | `traffic` | `conversion` | `leads` | `sales`
- --landing [url]: Landing page URL for message consistency check
```

**Execution Flow**:
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

**Output Format**:
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

**Example Usage**:
```
/ad search --channel google --objective conversion --variants 5 --audience "SaaS decision makers"
/ad social --channel meta --brief --objective leads --budget 5000
/ad video --channel youtube --variants 3 --objective awareness
/ad retargeting --channel meta,google --audience "cart abandoners" --objective sales
```

---

### 7. `/seo` - Search Engine Optimization

```yaml
---
description: SEO audit, keyword strategy, technical SEO analysis, and content optimization recommendations
argument-hint: [analysis-type] [--url target] [--keywords] [--competitors]
allowed-tools: [Read, Write, Glob, Grep, Bash, Task, WebSearch, TodoWrite]
---
```

**Category**: Search & Visibility

**Description**: Comprehensive SEO analysis covering technical SEO, on-page optimization, keyword strategy, and content gap analysis. Produces actionable audit reports with prioritized recommendations.

**Required Skills**:
- `seo-strategy` (NEW) - Keyword research, search intent, ranking factors
- `technical-seo` (NEW) - Site structure, crawlability, Core Web Vitals, schema markup
- `content-seo` (NEW) - On-page optimization, content gaps, topical authority
- `persona-analyzer` (existing) - Systematic analysis methodology

**Agent Delegation**:
- Primary: `seo-specialist` (NEW agent) - SEO audit and strategy
- Supporting: `content-marketer` (existing) - Content optimization
- Supporting: `data-analyst` (NEW) - Keyword data analysis

**Arguments**:
```
Parse $ARGUMENTS:
- analysis-type: Analysis type - `audit` | `keywords` | `content-gap` | `technical` | `competitor` | `local` | `strategy`
- --url [target]: Target URL or domain for analysis
- --keywords [terms]: Seed keywords for research (comma-separated)
- --competitors [domains]: Competitor domains for comparison (comma-separated)
- --focus [area]: SEO focus - `on-page` | `off-page` | `technical` | `content` | `local` | `all`
- --pages [scope]: Pages to analyze - `homepage` | `top-10` | `all` | `specific path`
- --intent [type]: Search intent filter - `informational` | `transactional` | `navigational` | `commercial`
```

**Execution Flow**:
1. **Parse**: Extract analysis type, target, keyword seeds, competitor context
2. **Crawl/Audit** (if `audit` or `technical`):
   - Page structure analysis (H1-H6 hierarchy, meta tags, alt texts)
   - Internal linking structure evaluation
   - Mobile responsiveness check
   - Page speed and Core Web Vitals assessment
   - Schema markup validation
   - Robots.txt and sitemap analysis
3. **Keyword Research** (if `keywords` or `strategy`):
   - Seed keyword expansion via WebSearch
   - Search volume and difficulty estimation
   - Search intent classification per keyword
   - Keyword clustering by topic
   - Long-tail opportunity identification
4. **Content Gap Analysis** (if `content-gap`):
   - Compare content coverage vs competitors
   - Identify missing topics and keywords
   - Map content to search intent stages
   - Prioritize by volume x difficulty x relevance
5. **Competitor Analysis** (if `competitor`):
   - Competing page identification per keyword
   - Content format and depth comparison
   - Backlink profile estimation
   - Ranking factor comparison
6. **Recommendations**: Prioritize fixes by impact:
   - Critical: Broken pages, missing meta, indexing issues
   - High: Content gaps, keyword cannibalization
   - Medium: Internal linking, schema opportunities
   - Low: Minor on-page tweaks
7. **Report**: Output structured SEO audit/strategy

**Output Format**:
```
SEO REPORT
==========
Type:       [analysis-type]
Target:     [url/domain]
Focus:      [area]
Score:      [overall SEO health score /100]

TECHNICAL HEALTH (if audit/technical)
-------------------------------------
Category        | Score | Issues | Priority
----------------|-------|--------|----------
Meta Tags       | [/10] | [n]    | [P1-P3]
Page Speed      | [/10] | [n]    | [P1-P3]
Mobile          | [/10] | [n]    | [P1-P3]
Crawlability    | [/10] | [n]    | [P1-P3]
Schema          | [/10] | [n]    | [P1-P3]
Internal Links  | [/10] | [n]    | [P1-P3]

KEYWORD STRATEGY (if keywords/strategy)
----------------------------------------
Keyword         | Volume | Difficulty | Intent        | Priority
----------------|--------|------------|---------------|----------
[keyword]       | [vol]  | [1-100]    | [intent type] | [P1-P3]

CONTENT GAPS (if content-gap)
-----------------------------
Missing Topic    | Est. Volume | Competitor Coverage | Content Type
-----------------|-------------|---------------------|-------------
[topic]          | [volume]    | [n competitors]     | [blog|page|guide]

RECOMMENDATIONS
---------------
Priority | Category   | Action                          | Expected Impact
---------|------------|---------------------------------|----------------
P1       | [category] | [specific action]               | [traffic delta]
P2       | [category] | [specific action]               | [traffic delta]
```

**Example Usage**:
```
/seo audit --url example.com --focus all
/seo keywords --keywords "AI agent,Claude plugin,coding assistant" --intent transactional
/seo content-gap --url example.com --competitors "competitor1.com,competitor2.com"
/seo technical --url example.com --pages top-10
/seo strategy --keywords "marketing automation" --competitors "hubspot.com,mailchimp.com"
```

---

### 8. `/crm` - Customer Relationship Management

```yaml
---
description: CRM workflow design, customer journey mapping, segmentation strategy, and lifecycle automation
argument-hint: [workflow-type] [--stage] [--segment] [--automation]
allowed-tools: [Read, Write, Task, WebSearch, TodoWrite]
---
```

**Category**: Customer Management

**Description**: Designs CRM workflows, customer journey maps, segmentation strategies, and lifecycle automation sequences. Focuses on lead scoring, pipeline optimization, and customer retention strategies.

**Required Skills**:
- `customer-journey` (NEW) - Journey mapping, touchpoint analysis, lifecycle stages
- `segmentation` (NEW) - Audience segmentation, lead scoring, behavioral triggers
- `campaign-planning` (NEW) - Shared with /mkt - automation design
- `persona-scribe` (existing) - Professional documentation

**Agent Delegation**:
- Primary: `marketing-strategist` (NEW agent) - CRM strategy and journey design
- Supporting: `data-analyst` (NEW) - Segmentation and scoring models

**Arguments**:
```
Parse $ARGUMENTS:
- workflow-type: Workflow type - `journey-map` | `lead-scoring` | `pipeline` | `segmentation` | `retention` | `onboarding` | `upsell`
- --stage [lifecycle]: Lifecycle stage focus - `awareness` | `consideration` | `decision` | `onboarding` | `retention` | `advocacy` | `all`
- --segment [criteria]: Segment criteria - `demographic` | `behavioral` | `firmographic` | `technographic`
- --automation: Generate automation workflows with triggers
- --personas [n]: Number of customer personas to create (default: 3)
- --scoring: Include lead scoring model design
```

**Execution Flow**:
1. **Parse**: Extract workflow type, lifecycle stage, segmentation criteria
2. **Research**: Industry CRM benchmarks, conversion rates, lifecycle patterns
3. **Map**: Design customer journey:
   - Stages with entry/exit criteria
   - Touchpoints per stage (email, in-app, sales, support)
   - Emotions and pain points per stage
   - Key metrics per stage
4. **Segment**: Define audience segments:
   - Segmentation criteria and rules
   - Persona profiles
   - Behavioral triggers
5. **Score** (if `--scoring`): Design lead scoring model:
   - Demographic scoring (title, company size, industry)
   - Behavioral scoring (page views, email opens, demo requests)
   - Engagement scoring (frequency, recency, depth)
   - Score thresholds for MQL/SQL handoff
6. **Automate** (if `--automation`): Design CRM workflows:
   - Trigger events -> Actions -> Conditions -> Branches
   - Notification rules for sales team
   - Escalation paths
7. **Report**: Output CRM strategy document

**Output Format**:
```
CRM STRATEGY
============
Type:       [workflow-type]
Stage:      [lifecycle focus]
Segments:   [count]
Personas:   [count]

CUSTOMER JOURNEY MAP
--------------------
Stage           | Touchpoints      | Metrics          | Goal
----------------|------------------|------------------|------------------
[Awareness]     | [blog, ads, SEO] | [traffic, CTR]   | [capture interest]
[Consideration] | [email, webinar] | [engagement, MQL]| [build trust]
[Decision]      | [demo, trial]    | [SQL, conversion]| [close deal]
[Onboarding]    | [email, in-app]  | [activation]     | [time-to-value]
[Retention]     | [support, email] | [NPS, churn]     | [reduce churn]
[Advocacy]      | [referral, case] | [NPS, referrals] | [drive referrals]

LEAD SCORING MODEL (if --scoring)
----------------------------------
Category     | Signal              | Points | Threshold
-------------|---------------------|--------|----------
Demographic  | [title = VP+]       | +15    |
Behavioral   | [viewed pricing]    | +20    | MQL = 50pts
Engagement   | [3+ sessions/week]  | +10    | SQL = 80pts

AUTOMATION WORKFLOWS (if --automation)
--------------------------------------
Workflow: [name]
  Trigger: [event/condition]
  -> Action: [send email / assign task / update field]
  -> Wait: [delay]
  -> Condition: [if/then branch]
    -> Yes: [action]
    -> No: [action]

SEGMENTS
--------
Segment: [name]
  Criteria: [rules]
  Size: [estimated %]
  Strategy: [engagement approach]
```

**Example Usage**:
```
/crm journey-map --stage all --personas 4 --automation
/crm lead-scoring --scoring --segment behavioral,firmographic
/crm retention --stage retention --automation --segment behavioral
/crm pipeline --stage consideration,decision --scoring
/crm onboarding --automation --stage onboarding --personas 2
```

---

### 9. `/analytics` - Marketing Analytics

```yaml
---
description: Marketing analytics dashboards, KPI tracking, performance reports, and attribution analysis
argument-hint: [report-type] [--kpi metrics] [--period] [--channel]
allowed-tools: [Read, Write, Glob, Grep, Bash, Task, WebSearch, TodoWrite]
---
```

**Category**: Reporting & Intelligence

**Description**: Marketing-specific analytics command that generates performance dashboards, KPI reports, channel attribution analysis, and campaign ROI reports. Complementary to `/excel` with a marketing-domain focus.

**Required Skills**:
- `marketing-analytics` (NEW) - Marketing KPIs, attribution models, funnel metrics
- `data-visualization` (NEW) - Shared with /excel - dashboards and charts
- `report-generation` (NEW) - Shared with /excel - executive summaries
- `persona-analyzer` (existing) - Systematic analysis methodology

**Agent Delegation**:
- Primary: `data-analyst` (NEW agent) - Analytics and reporting
- Supporting: `marketing-strategist` (NEW agent) - Strategic interpretation

**Arguments**:
```
Parse $ARGUMENTS:
- report-type: Report type - `dashboard` | `campaign-report` | `channel-report` | `attribution` | `executive-summary` | `forecast`
- --kpi [metrics]: Focus KPIs (comma-separated) - e.g., `cac,ltv,roas,ctr,cvr,mrr,arr,churn,nps`
- --period [range]: Time period - `daily` | `weekly` | `monthly` | `quarterly` | `ytd` | `custom`
- --channel [channels]: Marketing channels - `organic` | `paid` | `email` | `social` | `referral` | `direct` | `all`
- --compare [baseline]: Comparison - `previous-period` | `yoy` | `target` | `budget`
- --data [source]: Data source file
- --segment [dim]: Segment dimension - `channel` | `campaign` | `audience` | `geography` | `device`
```

**Execution Flow**:
1. **Parse**: Extract report type, KPIs, time period, channel scope
2. **Ingest**: Load data from source or generate template structure
3. **Calculate**: Compute marketing metrics:
   - **Acquisition**: CAC, CPC, CPL, CPA, ROAS
   - **Engagement**: CTR, Open Rate, Bounce Rate, Time on Site
   - **Conversion**: CVR, MQL->SQL rate, Win Rate, ACV
   - **Retention**: Churn Rate, NPS, LTV, LTV:CAC ratio
   - **Revenue**: MRR, ARR, ARPU, Expansion Revenue
4. **Attribute** (if `attribution`): Apply attribution models:
   - First-touch, Last-touch, Linear, Time-decay, Position-based
   - Cross-channel attribution comparison
5. **Visualize**: Design dashboard layout:
   - KPI scorecards with trend indicators
   - Channel performance comparison charts
   - Funnel visualization with conversion rates
   - Time series for trend analysis
6. **Interpret**: Generate narrative insights:
   - Performance vs target analysis
   - Channel efficiency ranking
   - Anomaly flagging
   - Opportunity identification
7. **Report**: Output analytics report

**Output Format**:
```
MARKETING ANALYTICS
===================
Report:     [report-type]
Period:     [date range]
Channels:   [scope]
Segments:   [dimensions]

KPI SCORECARD
-------------
Metric | Current | Target | Delta  | Trend | Status
-------|---------|--------|--------|-------|-------
[CAC]  | [$XX]   | [$XX]  | [-XX%] | [dwn] | [GOOD]
[LTV]  | [$XX]   | [$XX]  | [+XX%] | [up]  | [GOOD]
[ROAS] | [X.Xx]  | [X.Xx] | [+X%]  | [up]  | [GOOD]

CHANNEL PERFORMANCE
-------------------
Channel  | Spend    | Revenue  | ROAS | CAC    | Conv.
---------|----------|----------|------|--------|------
[Paid]   | [$XX,XXX]| [$XX,XXX]| [Xx] | [$XX]  | [XX%]
[Email]  | [$X,XXX] | [$XX,XXX]| [Xx] | [$XX]  | [XX%]
[Organic]| [$0]     | [$XX,XXX]| [--] | [$XX]  | [XX%]

ATTRIBUTION (if attribution)
-----------------------------
Model           | Top Channel | Share
----------------|-------------|------
First-Touch     | [channel]   | [XX%]
Last-Touch      | [channel]   | [XX%]
Linear          | [channel]   | [XX%]
Time-Decay      | [channel]   | [XX%]

INSIGHTS
--------
1. [Key insight with supporting data]
2. [Trend or pattern identified]
3. [Optimization opportunity]

RECOMMENDATIONS
---------------
Priority | Action                  | Channel  | Expected Impact
---------|-------------------------|----------|----------------
P1       | [action]                | [channel]| [+XX% metric]
```

**Example Usage**:
```
/analytics dashboard --kpi cac,ltv,roas,churn --period monthly --channel all
/analytics campaign-report --data @campaigns/q1-results.csv --compare target
/analytics attribution --channel paid,organic,email --period quarterly
/analytics executive-summary --period quarterly --compare yoy --kpi mrr,arr,churn,nps
/analytics forecast --kpi mrr,cac --period quarterly --data @revenue/history.csv
```

---

### 10. `/cro` - Conversion Rate Optimization

```yaml
---
description: Conversion rate optimization for landing pages, signup flows, forms, onboarding, and pricing pages
argument-hint: [target-type] [--url] [--funnel] [--ab-test]
allowed-tools: [Read, Write, Glob, Grep, Bash, Task, WebSearch, TodoWrite]
---
```

**Category**: Conversion Optimization

**Description**: Analyzes and optimizes conversion funnels, landing pages, signup flows, forms, and pricing pages. Produces prioritized recommendations with A/B test hypotheses. Based on 6 CRO patterns from coreyhaines31/marketingskills: page-cro, signup-flow-cro, onboarding-cro, form-cro, popup-cro, paywall-upgrade-cro.

**Required Skills**:
- `cro-page` (NEW) - Landing page conversion optimization, above-the-fold analysis
- `cro-funnel` (NEW) - Multi-step funnel analysis, drop-off identification
- `cro-forms` (NEW) - Form field optimization, friction reduction
- `ab-testing` (NEW) - Shared with /email, /ad - hypothesis design, test methodology
- `persona-analyzer` (existing) - Systematic analysis methodology

**Agent Delegation**:
- Primary: `cro-specialist` (NEW agent) - Conversion analysis and recommendations
- Supporting: `content-marketer` (existing) - Copy optimization
- Supporting: `data-analyst` (NEW) - Funnel data analysis

**Arguments**:
```
Parse $ARGUMENTS:
- target-type: CRO target - `landing-page` | `signup-flow` | `onboarding` | `form` | `pricing` | `checkout` | `popup`
- --url [target]: URL of page to analyze
- --funnel [stages]: Funnel stages to audit (comma-separated)
- --ab-test: Generate A/B test hypotheses with recommended variants
- --benchmark [industry]: Industry benchmark for comparison
- --focus [area]: Focus area - `copy` | `layout` | `cta` | `trust` | `speed` | `mobile` | `all`
- --data [source]: Existing analytics data for the page/funnel
```

**Execution Flow**:
1. **Parse**: Extract target type, URL, funnel definition, focus area
2. **Audit**: Analyze current state:
   - **Landing Page**: Hero section, value proposition clarity, social proof, CTA prominence, page speed, mobile responsiveness
   - **Signup Flow**: Step count, field count, friction points, progressive disclosure, error handling
   - **Onboarding**: Time-to-value, activation metrics, drop-off points, personalization
   - **Form**: Field count, label clarity, validation UX, smart defaults, field ordering
   - **Pricing**: Plan comparison clarity, anchor pricing, CTA differentiation, trust signals
   - **Checkout**: Cart abandonment triggers, payment options, trust signals, urgency elements
   - **Popup**: Trigger timing, relevance, offer value, exit intent, frequency
3. **Benchmark**: Compare against industry conversion rates
4. **Prioritize**: Score recommendations by impact x effort:
   - Quick wins (high impact, low effort) -> P1
   - Strategic improvements (high impact, high effort) -> P2
   - Incremental gains (low impact, low effort) -> P3
5. **A/B Hypotheses** (if `--ab-test`): Generate test plans:
   - Hypothesis statement
   - Control vs treatment description
   - Primary metric
   - Sample size estimate
   - Expected lift range
6. **Report**: Output structured CRO audit

**Output Format**:
```
CRO AUDIT REPORT
=================
Target:     [target-type]
URL:        [page URL]
Focus:      [area]
Score:      [conversion health score /100]

CURRENT STATE
-------------
Metric          | Value    | Benchmark | Status
----------------|----------|-----------|-------
Conversion Rate | [%]      | [%]       | [above|below]
Bounce Rate     | [%]      | [%]       | [above|below]
Time on Page    | [sec]    | [sec]     | [above|below]
Form Completion | [%]      | [%]       | [above|below]

FINDINGS
--------
[P1] [Quick Win] [copy|layout|cta|trust|speed|mobile]
  Issue:  [description]
  Impact: [estimated conversion lift]
  Fix:    [specific recommendation]

[P2] [Strategic] [category]
  Issue:  [description]
  Impact: [estimated conversion lift]
  Fix:    [specific recommendation]

A/B TEST HYPOTHESES (if --ab-test)
-----------------------------------
Test 1: [name]
  Hypothesis: "If we [change], then [metric] will [improve] because [rationale]"
  Control:    [current state]
  Treatment:  [proposed change]
  Metric:     [primary success metric]
  Est. Lift:  [+X% to +Y%]
  Duration:   [recommended test period]

RECOMMENDATIONS SUMMARY
------------------------
Priority | Category | Recommendation        | Est. Lift
---------|----------|-----------------------|----------
P1       | [cat]    | [specific action]     | +[X]%
P2       | [cat]    | [specific action]     | +[X]%
```

**Example Usage**:
```
/cro landing-page --url example.com/signup --ab-test --focus all
/cro signup-flow --funnel "landing,register,verify,onboard" --data @analytics/signup.csv
/cro pricing --url example.com/pricing --ab-test --benchmark saas
/cro form --url example.com/contact --focus mobile,speed
/cro onboarding --funnel "signup,setup,first-action,aha-moment" --ab-test
```

---

## New Agents Required

Based on the command designs above, these new agents are needed:

### 1. `marketing-strategist`

```yaml
name: marketing-strategist
description: |
  Marketing strategy specialist focused on market analysis, competitive intelligence,
  campaign planning, and growth strategy. Creates data-driven marketing plans.

  Use proactively when creating marketing strategies, market analysis, competitive
  positioning, campaign planning, or growth roadmaps.

  Triggers: marketing strategy, market analysis, competitive, positioning, campaign planning,
  go-to-market, GTM, growth strategy, 마케팅 전략, 시장 분석, 경쟁 분석, 캠페인 기획

  Do NOT use for: code implementation, email copy writing, social media posts, ad creation
model: opus
tools:
  - Read
  - Write
  - Glob
  - Grep
  - WebSearch
  - SendMessage
  - TaskUpdate
  - TaskList
  - TaskGet
skills:
  - marketing-strategy
  - competitive-intelligence
  - campaign-planning
```

**Core Responsibilities**:
1. **Market Analysis**: Research market size, trends, and opportunities using structured frameworks (TAM/SAM/SOM, Porter's Five Forces)
2. **Competitive Intelligence**: Analyze competitor positioning, messaging, and strategies for differentiation mapping
3. **Strategy Formulation**: Build actionable marketing plans with channel strategies, budget allocation, and KPI frameworks

**Commands Served**: `/mkt`, `/crm`, `/analytics`

---

### 2. `data-analyst`

```yaml
name: data-analyst
description: |
  Data analysis specialist focused on marketing metrics, statistical analysis,
  reporting, and data visualization. Transforms data into actionable insights.

  Use proactively when analyzing marketing data, creating reports, designing
  dashboards, or calculating ROI and attribution.

  Triggers: data analysis, metrics, dashboard, report, ROI, attribution, forecast,
  KPI, analytics, 데이터 분석, 리포트, 대시보드, 지표

  Do NOT use for: code implementation, content creation, design, infrastructure
model: sonnet
tools:
  - Read
  - Write
  - Glob
  - Grep
  - Bash
  - SendMessage
  - TaskUpdate
  - TaskList
  - TaskGet
skills:
  - data-analysis
  - data-visualization
  - report-generation
```

**Core Responsibilities**:
1. **Data Processing**: Clean, validate, and transform marketing data from various sources
2. **Analysis**: Apply statistical methods, trend analysis, and attribution modeling to derive insights
3. **Reporting**: Create structured reports with visualizations, KPI scorecards, and executive summaries

**Commands Served**: `/excel`, `/analytics`, `/email` (A/B testing), `/ad` (performance), `/seo` (keyword data)

---

### 3. `presentation-designer`

```yaml
name: presentation-designer
description: |
  Presentation design specialist focused on narrative structure, slide layouts,
  data visualization, and visual storytelling for business communications.

  Use proactively when creating presentations, slide decks, pitch decks,
  or visual reports.

  Triggers: presentation, slides, pitch deck, keynote, PowerPoint, ppt,
  slide design, 프레젠테이션, 슬라이드, 발표자료, 피치덱

  Do NOT use for: code implementation, email campaigns, social media, infrastructure
model: sonnet
tools:
  - Read
  - Write
  - Glob
  - Grep
  - WebSearch
  - SendMessage
  - TaskUpdate
  - TaskList
  - TaskGet
skills:
  - presentation-design
  - data-visualization
  - copywriting
```

**Core Responsibilities**:
1. **Narrative Design**: Structure presentation flow with clear story arcs (Problem->Solution->Evidence->CTA)
2. **Slide Design**: Create slide-by-slide content with headlines, body text, and visual layout recommendations
3. **Data Storytelling**: Recommend appropriate chart types and visual encoding for data-driven slides

**Commands Served**: `/ppt`

---

### 4. `seo-specialist`

```yaml
name: seo-specialist
description: |
  SEO specialist focused on technical SEO audits, keyword strategy, content
  optimization, and search visibility improvement.

  Use proactively when performing SEO audits, keyword research, content
  optimization, or competitor SEO analysis.

  Triggers: SEO, search engine, keyword research, technical SEO, on-page,
  off-page, backlinks, ranking, SERP, 검색엔진최적화, SEO 분석, 키워드

  Do NOT use for: code implementation, email campaigns, social media, paid ads
model: sonnet
tools:
  - Read
  - Write
  - Glob
  - Grep
  - Bash
  - WebSearch
  - SendMessage
  - TaskUpdate
  - TaskList
  - TaskGet
skills:
  - seo-strategy
  - technical-seo
  - content-seo
```

**Core Responsibilities**:
1. **Technical Audit**: Analyze site structure, crawlability, page speed, and schema markup compliance
2. **Keyword Strategy**: Research keywords, classify search intent, cluster topics, and identify opportunities
3. **Content Optimization**: Provide on-page SEO recommendations for content structure, meta tags, and internal linking

**Commands Served**: `/seo`

---

### 5. `cro-specialist`

```yaml
name: cro-specialist
description: |
  Conversion rate optimization specialist focused on landing page audits,
  funnel analysis, form optimization, and A/B test design.

  Use proactively when optimizing conversion funnels, auditing landing pages,
  improving signup flows, or designing A/B tests for conversion improvement.

  Triggers: CRO, conversion rate, landing page optimization, funnel, signup flow,
  form optimization, A/B test, bounce rate, 전환율, 랜딩페이지, 퍼널 최적화

  Do NOT use for: code implementation, content creation, SEO, paid ads
model: sonnet
tools:
  - Read
  - Write
  - Glob
  - Grep
  - Bash
  - WebSearch
  - SendMessage
  - TaskUpdate
  - TaskList
  - TaskGet
skills:
  - cro-page
  - cro-funnel
  - cro-forms
  - ab-testing
```

**Core Responsibilities**:
1. **Page Audit**: Analyze landing pages for conversion barriers including copy, layout, CTAs, trust signals, and page speed
2. **Funnel Analysis**: Map conversion funnels, identify drop-off points, and prioritize optimization opportunities by impact
3. **A/B Test Design**: Create statistically rigorous A/B test hypotheses with control/treatment specs and sample sizing

**Commands Served**: `/cro`

---

### 6. `ad-specialist` (Optional - can use `content-marketer` as primary)

```yaml
name: ad-specialist
description: |
  Advertising specialist focused on paid media copy, creative briefs,
  campaign structure, and performance optimization across ad platforms.

  Use proactively when creating ad campaigns, writing ad copy, designing
  creative briefs, or optimizing paid media performance.

  Triggers: advertising, ad copy, paid media, Google Ads, Meta Ads, PPC,
  creative brief, campaign structure, 광고, 유료 광고, 광고 카피

  Do NOT use for: code implementation, organic content, SEO, infrastructure
model: sonnet
tools:
  - Read
  - Write
  - WebSearch
  - SendMessage
  - TaskUpdate
  - TaskList
  - TaskGet
skills:
  - advertising
  - copywriting
  - ab-testing
```

**Core Responsibilities**:
1. **Ad Copy Creation**: Write platform-compliant ad copy with headline variants, descriptions, and CTAs
2. **Creative Briefs**: Design creative briefs for campaigns with audience, messaging, and format specifications
3. **Campaign Structure**: Design campaign/ad group/ad structures with targeting and bidding recommendations

**Commands Served**: `/ad`

---

## New Skills Required

### Consolidated Skill Map

| Skill Name | Used By Commands | Category | Priority |
|------------|-----------------|----------|----------|
| `marketing-strategy` | /mkt, /crm | Strategy | P1 |
| `competitive-intelligence` | /mkt | Strategy | P1 |
| `campaign-planning` | /mkt, /crm, /email | Strategy | P1 |
| `email-marketing` | /email | Execution | P1 |
| `copywriting` | /email, /social, /ad, /ppt | Execution | P1 |
| `ab-testing` | /email, /ad | Optimization | P2 |
| `social-media` | /social | Execution | P1 |
| `advertising` | /ad | Execution | P2 |
| `seo-strategy` | /seo | Analysis | P1 |
| `technical-seo` | /seo | Analysis | P2 |
| `content-seo` | /seo | Analysis | P2 |
| `data-analysis` | /excel, /analytics | Analytics | P1 |
| `data-visualization` | /excel, /ppt, /analytics | Analytics | P1 |
| `report-generation` | /excel, /analytics | Analytics | P1 |
| `presentation-design` | /ppt | Communication | P1 |
| `customer-journey` | /crm | Customer | P2 |
| `segmentation` | /crm, /email | Customer | P2 |
| `marketing-analytics` | /analytics | Analytics | P1 |
| `cro-page` | /cro | Conversion | P1 |
| `cro-funnel` | /cro | Conversion | P1 |
| `cro-forms` | /cro | Conversion | P2 |
| `brand-guidelines` | /mkt, /social, /ad | Brand | P2 |

**Total: 23 new skills** (some shared across multiple commands)

> **Skills Research Cross-Reference**: These map to the following benchmark skills:
> - coreyhaines31/marketingskills: copywriting, copy-editing, cold-email, email-sequence, social-content, paid-ads, seo-audit, programmatic-seo, analytics-tracking, ab-test-setup, page-cro, signup-flow-cro, onboarding-cro, form-cro, popup-cro, paywall-upgrade-cro, marketing-ideas, marketing-psychology, launch-strategy, pricing-strategy
> - anthropics/skills: pptx (presentation-design depends on this), xlsx (data-analysis depends on this)
> - alirezarezvani/claude-skills: Social Media Analyzer (social-media), Campaign Analytics (marketing-analytics)

---

## SC Router Integration

New entries for `/sc` routing table:

```markdown
| Intent Pattern | Route | Confidence |
|----------------|-------|------------|
| marketing strategy, go-to-market, GTM, market analysis | /mkt | 92% |
| email campaign, newsletter, drip, email marketing | /email | 90% |
| presentation, slides, pitch deck, ppt, keynote | /ppt | 92% |
| data analysis, report, excel, spreadsheet, dashboard | /excel | 88% |
| social media, social post, twitter, linkedin, instagram | /social | 90% |
| ad copy, advertising, PPC, paid media, Google Ads | /ad | 88% |
| SEO, keyword research, search engine, ranking | /seo | 92% |
| CRM, customer journey, lead scoring, pipeline | /crm | 88% |
| marketing analytics, KPI dashboard, attribution, ROAS | /analytics | 88% |
| CRO, conversion rate, landing page optimization, funnel | /cro | 90% |
```

Updated routing for existing `/content` command:
- `/content` remains for general content creation (blog posts, guides, tutorials)
- Marketing-specific tasks route to the new specialized commands
- Overlap resolution: `/content` for content creation, `/social` for platform-optimized social media, `/email` for email campaigns

---

## Orchestration Patterns

### Marketing Team Playbooks

New playbook entries for `artibot.config.json`:

```json
{
  "playbooks": {
    "marketing-campaign": "[leader] strategy(mkt) -> [swarm] create(email+social+ad) -> [council] review -> [pipeline] launch",
    "marketing-audit": "[leader] analyze(seo+analytics) -> [council] assess -> [pipeline] recommend -> [leader] report",
    "content-launch": "[leader] plan(mkt) -> [swarm] create(content+social+email) -> [council] review -> [leader] schedule",
    "competitive-analysis": "[leader] research(mkt) -> [swarm] analyze(seo+social+ad) -> [council] synthesize -> [leader] report"
  }
}
```

### Multi-Command Workflows

Complex marketing operations can chain commands through `/orchestrate`:

**Campaign Launch Workflow**:
```
/orchestrate "Q2 Product Launch Campaign" --pattern marketing-campaign
  Phase 1: /mkt product-launch --budget growth --timeline quarterly
  Phase 2 (parallel):
    /email launch --series 3 --automation --segment active
    /social calendar --platform all --campaign "Q2 Launch"
    /ad social --channel meta,linkedin --variants 3
  Phase 3: /analytics dashboard --kpi cac,roas,cvr --channel all
```

**Marketing Audit Workflow**:
```
/orchestrate "Q1 Marketing Performance Audit" --pattern marketing-audit
  Phase 1 (parallel):
    /seo audit --url example.com --focus all
    /analytics executive-summary --period quarterly --compare yoy
  Phase 2: /mkt strategy --market "B2B SaaS" --competitor "comp1,comp2"
  Phase 3: /ppt "Q1 Marketing Review" --type report --audience executive
```

---

## Config Updates Required

### artibot.config.json additions

```json
{
  "agents": {
    "taskBased": {
      "marketing-strategy": "marketing-strategist",
      "data-analysis": "data-analyst",
      "presentation": "presentation-designer",
      "seo": "seo-specialist",
      "advertising": "ad-specialist"
    }
  },
  "team": {
    "playbooks": {
      "marketing-campaign": "[leader] strategy -> [swarm] create -> [council] review -> [pipeline] launch",
      "marketing-audit": "[leader] analyze -> [council] assess -> [pipeline] recommend -> [leader] report",
      "content-launch": "[leader] plan -> [swarm] create -> [council] review -> [leader] schedule",
      "competitive-analysis": "[leader] research -> [swarm] analyze -> [council] synthesize -> [leader] report"
    }
  }
}
```

---

## Implementation Priority

### Phase 1 (Core - Highest Impact)
1. `/mkt` - Foundation strategy command, needed by other commands
2. `/email` - High-frequency use case in marketing agencies
3. `/analytics` - Critical for measuring all marketing activity

### Phase 2 (Content & Visibility)
4. `/social` - High-frequency, builds on existing content-marketer
5. `/seo` - Essential for organic growth strategy
6. `/ppt` - High value for agency client deliverables

### Phase 3 (Specialized)
7. `/excel` - Data analysis foundation (also serves non-marketing use cases)
8. `/ad` - Paid media specialist
9. `/crm` - Customer lifecycle management
10. `/cro` - Conversion rate optimization (builds on analytics + content)

### Agent Priority
1. `marketing-strategist` (serves /mkt, /crm, /analytics) - Phase 1
2. `data-analyst` (serves /excel, /analytics, /email, /ad, /seo) - Phase 1
3. `seo-specialist` (serves /seo) - Phase 2
4. `presentation-designer` (serves /ppt) - Phase 2
5. `cro-specialist` (serves /cro) - Phase 3
6. `ad-specialist` (serves /ad) - Phase 3 (can use content-marketer as interim)

### Skill Priority
- Phase 1: marketing-strategy, campaign-planning, email-marketing, copywriting, data-analysis, data-visualization, report-generation, marketing-analytics
- Phase 2: competitive-intelligence, social-media, seo-strategy, presentation-design
- Phase 3: ab-testing, advertising, technical-seo, content-seo, customer-journey, segmentation, cro-page, cro-funnel, cro-forms, brand-guidelines

---

## File Structure (New Files)

```
plugins/artibot/
├── commands/
│   ├── mkt.md              # NEW - Marketing strategy
│   ├── email.md            # NEW - Email campaigns
│   ├── ppt.md              # NEW - Presentations
│   ├── excel.md            # NEW - Data analysis
│   ├── social.md           # NEW - Social media
│   ├── ad.md               # NEW - Advertising
│   ├── seo.md              # NEW - SEO
│   ├── crm.md              # NEW - CRM workflows
│   ├── analytics.md        # NEW - Marketing analytics
│   └── cro.md              # NEW - Conversion rate optimization
├── agents/
│   ├── marketing-strategist.md  # NEW
│   ├── data-analyst.md          # NEW
│   ├── presentation-designer.md # NEW
│   ├── seo-specialist.md        # NEW
│   ├── cro-specialist.md        # NEW
│   └── ad-specialist.md         # NEW (optional)
└── skills/
    ├── marketing-strategy/SKILL.md       # NEW
    ├── competitive-intelligence/SKILL.md # NEW
    ├── campaign-planning/SKILL.md        # NEW
    ├── email-marketing/SKILL.md          # NEW
    │   └── references/
    │       ├── email-templates.md        # Cold outreach, drip, newsletter templates
    │       ├── segmentation-guide.md     # Audience segmentation strategies
    │       └── metrics-reference.md      # KPI formulas and benchmarks
    ├── copywriting/SKILL.md              # NEW
    │   └── references/
    │       └── content-frameworks.md     # AIDA, PAS, BAB frameworks
    ├── ab-testing/SKILL.md               # NEW
    ├── social-media/SKILL.md             # NEW
    │   └── references/
    │       ├── platform-specs.md         # Character limits, image sizes
    │       └── engagement-benchmarks.md  # Platform-specific rates
    ├── advertising/SKILL.md              # NEW
    ├── seo-strategy/SKILL.md             # NEW
    ├── technical-seo/SKILL.md            # NEW
    ├── content-seo/SKILL.md              # NEW
    ├── data-analysis/SKILL.md            # NEW
    │   └── references/
    │       ├── kpi-formulas.md           # Marketing KPI calculations
    │       └── reporting-templates.md    # Weekly/monthly report formats
    ├── data-visualization/SKILL.md       # NEW
    ├── report-generation/SKILL.md        # NEW
    ├── presentation-design/SKILL.md      # NEW
    │   └── references/
    │       ├── slide-templates.md        # Deck structure templates
    │       └── chart-patterns.md         # Data visualization best practices
    ├── customer-journey/SKILL.md         # NEW
    ├── segmentation/SKILL.md             # NEW
    ├── marketing-analytics/SKILL.md      # NEW
    ├── cro-page/SKILL.md                 # NEW
    ├── cro-funnel/SKILL.md               # NEW
    ├── cro-forms/SKILL.md                # NEW
    └── brand-guidelines/SKILL.md         # NEW
```

**Total new files**: 10 commands + 6 agents + 23 skills (+ reference files) = **39+ new files**

> Skill structure follows Agent-Skills-for-Context-Engineering pattern: SKILL.md (<500 lines) + references/ for detailed content.
> Skills with references/ directories are the higher-complexity skills that benefit from progressive disclosure.

---

## Relationship to Existing `/content` Command

The existing `/content` command handles general content creation (blog, social, email, SEO, strategy, landing page). The new marketing commands are more specialized:

| Existing `/content` | New Command | Differentiation |
|---------------------|-------------|-----------------|
| `--blog` | Stays in `/content` | Blog post creation remains in /content |
| `--social` | `/social` | Platform-specific optimization, scheduling, calendars |
| `--email` | `/email` | A/B testing, automation sequences, segmentation |
| `--seo` | `/seo` | Full SEO audits, technical SEO, competitive analysis |
| `strategy` type | `/mkt` | Full marketing strategy with market analysis |
| `landing` type | Stays in `/content` | Landing page copy creation |

**Migration Strategy**: `/content` continues to work for quick content creation. New commands provide deeper, specialized workflows. `/sc` router learns to distinguish based on depth of request.

---

## Anthropic Official Skills Integration

Based on skills research findings, Anthropic's official document skills (anthropics/skills, 71.5k stars) should be integrated as dependencies:

| Official Skill | Artibot Command | Integration |
|----------------|----------------|-------------|
| `pptx` | `/ppt` | Dependency - actual PowerPoint file generation |
| `xlsx` | `/excel` | Dependency - actual Excel file generation |
| `docx` | `/mkt`, `/crm` | Dependency - strategy document generation |
| `pdf` | `/analytics`, `/seo` | Dependency - report export |

**Integration Method**: `/plugin install document-skills@anthropic-agent-skills`

Artibot's commands provide the **marketing intelligence layer** (strategy, analysis, optimization), while Anthropic's official skills provide the **document generation layer** (actual file creation). This avoids reimplementing file format handling.

---

## MCP Integration Recommendations (from Skills Research)

| MCP Server | Marketing Commands | Purpose |
|------------|-------------------|---------|
| **Context7** (existing) | /mkt, /seo, /email | Marketing framework docs (Mailchimp, Meta, GA4 APIs) |
| **Playwright** (existing) | /cro, /seo, /social | Landing page testing, ad preview, social scraping |
| **Postiz** (NEW) | /social | Social media posting across 30+ platforms |
| **Google Sheets** (NEW) | /excel, /analytics | Campaign data storage and live reporting |

### Postiz MCP Integration
```json
{
  "mcpServers": {
    "postiz": {
      "command": "npx",
      "args": ["-y", "@postiz/mcp-server"],
      "env": { "POSTIZ_API_KEY": "${POSTIZ_API_KEY}" }
    }
  }
}
```
- Enables `/social` to schedule and publish posts directly
- JSON output format for agent-friendly parsing
- Supports Twitter/X, LinkedIn, Instagram, TikTok, YouTube, and 25+ more

---

## New Personas Recommended (from Skills Research)

| Persona | Flag | Role | Skills Used |
|---------|------|------|-------------|
| `persona-marketer` | `--persona-marketer` | Marketing strategist, campaign planner | marketing-strategy, campaign-planning, competitive-intelligence |
| `persona-content` | `--persona-content` | Content creator, copywriter, brand voice | copywriting, social-media, brand-guidelines |
| `persona-data-analyst` | `--persona-data-analyst` | Marketing data analyst, reporting specialist | data-analysis, data-visualization, marketing-analytics |

These would live in `plugins/artibot/skills/` following the existing persona-* pattern.

---

## Key Design Insights from Agent-Skills Repo

Incorporated patterns from `Agent-Skills-for-Context-Engineering`:

1. **Context Isolation**: Each agent maintains a focused context. Marketing strategist does not carry SEO data unless needed.
2. **Tool Consolidation**: `/mkt` is the comprehensive strategy tool rather than splitting into /market-research + /positioning + /channel-strategy.
3. **Skill Composition**: Skills are reusable across commands. `copywriting` serves /email, /social, /ad, /ppt. `data-visualization` serves /excel, /ppt, /analytics.
4. **Multi-Agent Coordination**: Complex campaigns use the Team API pattern (TeamCreate -> spawn specialists -> TaskCreate -> SendMessage coordination -> TeamDelete).
5. **Progressive Enhancement**: Start with sub-agent mode for simple tasks (single /email), escalate to team mode for campaigns (/orchestrate marketing-campaign).
