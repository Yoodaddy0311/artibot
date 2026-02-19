# Marketing Agency Skills Research Report

> Artibot v2.0 Marketing Extension - Skills & Capabilities Gap Analysis
> Date: 2026-02-19 | Researcher: skills-researcher

---

## 1. Agent-Skills-for-Context-Engineering Repository Analysis

### Repository Overview
- **URL**: github.com/muratcankoylan/Agent-Skills-for-Context-Engineering
- **Stars**: High-traffic, cited in Peking University research (2026)
- **Architecture**: Claude Code Plugin Marketplace with progressive disclosure
- **Skill Count**: 13 core skills across 5 categories

### Skill Structure Pattern
```
skill-name/
├── SKILL.md              # Required: YAML frontmatter + instructions (<500 lines)
├── scripts/              # Optional: executable code
└── references/           # Optional: detailed docs
```

**YAML Frontmatter**:
```yaml
---
name: skill-name
description: |
  What the skill does.
  Triggers: keyword1, keyword2, keyword3
---
```

### Skills Inventory

| Category | Skill | Marketing Relevance |
|----------|-------|-------------------|
| **Foundational** | context-fundamentals | LOW - Agent architecture |
| **Foundational** | context-degradation | LOW - Debugging |
| **Foundational** | context-compression | MEDIUM - Token efficiency for long campaigns |
| **Architectural** | multi-agent-patterns | HIGH - Team orchestration for marketing workflows |
| **Architectural** | memory-systems | HIGH - Campaign history, customer data persistence |
| **Architectural** | tool-design | HIGH - MCP tool creation for marketing APIs |
| **Architectural** | filesystem-context | MEDIUM - Asset management, template storage |
| **Architectural** | hosted-agents | MEDIUM - Background campaign automation |
| **Operational** | context-optimization | MEDIUM - Efficient large dataset processing |
| **Operational** | evaluation | HIGH - Campaign performance measurement |
| **Operational** | advanced-evaluation | HIGH - A/B test analysis, LLM-as-judge for content |
| **Development** | project-development | MEDIUM - Marketing project lifecycle |
| **Cognitive** | bdi-mental-states | LOW - Advanced agent reasoning |

### Key Design Principles Applicable to Marketing Skills
1. **Progressive Disclosure**: L1 (SKILL.md ~50 tokens) -> L2 (MODULE.md ~80 tokens) -> L3 (data files ~200 tokens)
2. **Module Isolation**: Each skill loads independently, preventing context pollution
3. **Platform Agnosticism**: Skills work across Claude Code, Cursor, Codex
4. **Token Efficiency**: ~650 tokens per task vs ~5000 without optimization (digital-brain example)
5. **Append-Only Memory**: JSONL files with schema-first lines for agent-friendly parsing

### Notable Example: Digital Brain Skill
- 6 isolated modules: identity, content, knowledge, network, operations, agents
- 4 automation scripts: weekly_review, content_ideas, stale_contacts, idea_to_draft
- Directly applicable pattern for marketing agency "campaign brain"

---

## 2. Benchmark Repositories & Tools

### 2.1 Anthropic Official Skills (anthropics/skills)
- **URL**: github.com/anthropics/skills
- **71.5k Stars**, official reference implementation
- **Document Skills** (source-available):
  - `docx` - Word document creation/editing with tracked changes
  - `pdf` - Extract text/tables, create/merge/split PDFs
  - `pptx` - PowerPoint presentation generation with layouts, charts, templates
  - `xlsx` - Excel spreadsheet creation with formulas, formatting, charts
- **Status**: Available on Claude Pro/Max/Team/Enterprise and API (Feb 2026)
- **Integration**: `/plugin install document-skills@anthropic-agent-skills`

### 2.2 Marketing Skills (coreyhaines31/marketingskills)
- **URL**: github.com/coreyhaines31/marketingskills
- **25 marketing-specific skills** for Claude Code
- **Categories**:
  - **CRO (6)**: page-cro, signup-flow-cro, onboarding-cro, form-cro, popup-cro, paywall-upgrade-cro
  - **Content & Copy (5)**: copywriting, copy-editing, cold-email, email-sequence, social-content
  - **SEO (4)**: seo-audit, programmatic-seo, competitor-alternatives, schema-markup
  - **Paid & Distribution (2)**: paid-ads, social-content
  - **Measurement (2)**: analytics-tracking, ab-test-setup
  - **Growth (2)**: free-tool-strategy, referral-program
  - **Strategy (4)**: marketing-ideas, marketing-psychology, launch-strategy, pricing-strategy

### 2.3 Claude Skills Collection (alirezarezvani/claude-skills)
- **URL**: github.com/alirezarezvani/claude-skills
- **Marketing Skills (6)**:
  - Content Creator
  - Marketing Demand & Acquisition
  - Marketing Strategy & Product Marketing
  - App Store Optimization (ASO)
  - Social Media Analyzer (with engagement rate formulas, ROI analysis, platform benchmarks)
  - Campaign Analytics
- **Also includes**: Product Team (5), Project Management (6), C-Level Advisory (2)

### 2.4 Intelligent Agents (wshobson/agents)
- **URL**: github.com/wshobson/agents
- **112 specialized agents** across domains
- **Marketing-specific**: SEO content, technical SEO, SEO analysis, content marketing (~4 plugins)
- **Architecture**: Composable plugins with agents/commands/skills per plugin

### 2.5 Awesome Claude Skills Curated Lists
- **travisvn/awesome-claude-skills**: docx, pdf, pptx, xlsx, brand-guidelines, internal-comms
- **VoltAgent/awesome-agent-skills**: 300+ skills, developer-focused (marketing gap exists)
- **ComposioHQ/awesome-claude-skills**: Community curated list
- **karanb192/awesome-claude-skills**: 50+ verified skills

### 2.6 Specialized Marketing Tools / Services

| Tool | Category | Key Feature |
|------|----------|-------------|
| **Postiz Agent** | Social Media | CLI for 30+ platforms, JSON output, scheduled posting |
| **2Slides** | Presentations | AI slide generation with MCP/Claude Code integration |
| **OPC Skills** | Solopreneur | SEO-GEO, domain-hunter, logo/banner creator, twitter/reddit research |
| **Gumloop** | Marketing Automation | 15 marketing AI agents (SEO, social, paid, analytics) |
| **MindStudio** | Marketing Teams | 10 essential marketing agent templates |

---

## 3. Existing Artibot Skills Gap Analysis

### Current Artibot Skills (25 directories)

| Category | Skills | Marketing Coverage |
|----------|--------|-------------------|
| **Standards** | coding-standards, security-standards, testing-standards, principles | None |
| **Personas** | architect, frontend, backend, security, analyzer, performance, qa, refactorer, devops, mentor, scribe | scribe = partial (docs only) |
| **Workflows** | git-workflow, tdd-workflow | None |
| **MCP** | mcp-context7, mcp-playwright, mcp-coordination | None |
| **Meta** | continuous-learning, strategic-compact, orchestration, delegation, token-efficiency | None |

### Gap Analysis: Missing Marketing Skills

#### CRITICAL GAPS (Must-Have for Marketing Agency)

| Gap | Priority | Reference Implementations |
|-----|----------|--------------------------|
| **Email Marketing** | P0 | coreyhaines31: cold-email, email-sequence; alirezarezvani: Campaign Analytics |
| **Presentation (PPT)** | P0 | anthropics: pptx skill; 2Slides; claude-plugins.dev: ppt-creator |
| **Data Analysis (Excel)** | P0 | anthropics: xlsx skill; Excel Agent Mode |
| **Content Creation** | P0 | coreyhaines31: copywriting, copy-editing; alirezarezvani: Content Creator |
| **Social Media Management** | P0 | alirezarezvani: Social Media Analyzer; Postiz Agent; coreyhaines31: social-content |
| **Campaign Orchestration** | P0 | MindStudio: Campaign Orchestration Agent; Gumloop: 15 agent types |

#### HIGH PRIORITY GAPS

| Gap | Priority | Reference Implementations |
|-----|----------|--------------------------|
| **SEO/GEO Optimization** | P1 | coreyhaines31: seo-audit, programmatic-seo; OPC: seo-geo |
| **Analytics & Reporting** | P1 | coreyhaines31: analytics-tracking, ab-test-setup; Gumloop: Data Analyst Agent |
| **CRO (Conversion Rate)** | P1 | coreyhaines31: 6 CRO skills |
| **Competitive Intelligence** | P1 | MindStudio: Competitive Intelligence Agent; Gumloop: Competitive SEO Analyzer |
| **Lead Management** | P1 | MindStudio: Lead Qualification and Scoring Agent |

#### MEDIUM PRIORITY GAPS

| Gap | Priority | Reference Implementations |
|-----|----------|--------------------------|
| **Marketing Strategy** | P2 | coreyhaines31: marketing-ideas, marketing-psychology, launch-strategy, pricing-strategy |
| **Brand Guidelines** | P2 | travisvn: brand-guidelines |
| **Customer Personalization** | P2 | MindStudio: Customer Personalization Agent |
| **Paid Ads Management** | P2 | coreyhaines31: paid-ads; Gumloop: Google Ads Analyst |
| **Document Generation (DOCX/PDF)** | P2 | anthropics: docx, pdf skills |

---

## 4. Proposed Marketing Agency Skill Set

Based on comprehensive analysis, the following skills are recommended for Artibot's marketing agency extension:

### Tier 1: Core Marketing Skills (P0)

#### 4.1 `email-marketing` Skill
- **Role**: Email campaign creation, automation sequences, A/B testing, personalization
- **Capabilities**:
  - Cold outreach sequence generation (B2B/B2C)
  - Automated drip campaign design
  - Subject line optimization with A/B testing
  - Audience segmentation and personalization
  - Send-time optimization
  - Performance tracking (open rates, CTR, conversion)
- **Example**: "Create a 5-email onboarding sequence for SaaS trial users with personalization tokens"
- **References**: coreyhaines31/cold-email, coreyhaines31/email-sequence, MindStudio Email Campaign Agent

#### 4.2 `presentation-creator` Skill
- **Role**: PowerPoint/Google Slides creation and editing
- **Capabilities**:
  - Template-based slide generation
  - Data-driven chart/graph insertion from Excel/CSV
  - Brand-consistent layouts and design
  - Multilingual presentation generation
  - Pitch deck, report, and marketing deck templates
  - Speaker notes generation
- **Example**: "Create a Q4 marketing performance deck with data from campaign_results.xlsx"
- **References**: anthropics/pptx, 2Slides, claude-plugins.dev/ppt-creator

#### 4.3 `data-analyst` Skill
- **Role**: Excel/CSV data analysis, reporting, dashboard creation
- **Capabilities**:
  - Marketing data import and cleaning
  - KPI calculation (CAC, LTV, ROAS, CTR, CVR)
  - Pivot table and chart generation
  - Trend analysis and forecasting
  - Multi-platform data consolidation (GA4, Meta Ads, Google Ads)
  - Automated report generation
- **Example**: "Analyze last month's ad spend across platforms and generate ROI comparison report"
- **References**: anthropics/xlsx, Gumloop Data Analyst Agent, Powerdrill Bloom

#### 4.4 `content-creator` Skill
- **Role**: Marketing content generation across formats
- **Capabilities**:
  - Blog post writing with SEO optimization
  - Ad copy generation (Google Ads, Meta, LinkedIn)
  - Landing page copy
  - Video script writing
  - Brand voice consistency
  - Content repurposing (blog -> social, video -> blog)
- **Example**: "Write a blog post about AI marketing trends targeting CMOs, optimized for 'AI marketing 2026'"
- **References**: coreyhaines31/copywriting, alirezarezvani/Content Creator

#### 4.5 `social-media-manager` Skill
- **Role**: Multi-platform social media content and analytics
- **Capabilities**:
  - Platform-specific content creation (Twitter/X, LinkedIn, Instagram, TikTok)
  - Hashtag strategy and trend monitoring
  - Engagement rate analysis with platform benchmarks
  - Content calendar planning
  - Post scheduling and automation (via Postiz MCP)
  - Performance analytics and ROI reporting
- **Example**: "Create a week's worth of LinkedIn posts promoting our new AI product launch"
- **References**: alirezarezvani/Social Media Analyzer, Postiz Agent, coreyhaines31/social-content

#### 4.6 `campaign-orchestrator` Skill
- **Role**: Multi-channel campaign lifecycle management
- **Capabilities**:
  - Campaign planning and timeline creation
  - Cross-channel coordination (email + social + ads + landing pages)
  - UTM parameter generation and tracking
  - Budget allocation and optimization
  - A/B test design and analysis
  - Performance dashboard generation
- **Example**: "Plan a 4-week product launch campaign across email, social, and paid channels with $10K budget"
- **References**: MindStudio Campaign Orchestration Agent, Gumloop UTM Builder

### Tier 2: Advanced Marketing Skills (P1)

#### 4.7 `seo-optimizer` Skill
- **Role**: SEO audit, keyword research, content optimization
- **Capabilities**:
  - Technical SEO audit
  - Keyword research and mapping
  - On-page optimization recommendations
  - Schema markup generation
  - Competitor analysis
  - GEO (Generative Engine Optimization)
- **References**: coreyhaines31/seo-audit, coreyhaines31/programmatic-seo, OPC/seo-geo

#### 4.8 `analytics-reporter` Skill
- **Role**: Marketing analytics consolidation and insight generation
- **Capabilities**:
  - Multi-platform data aggregation
  - Automated weekly/monthly reporting
  - Anomaly detection and alerting
  - Predictive analytics and forecasting
  - Custom dashboard creation
- **References**: coreyhaines31/analytics-tracking, Gumloop Google Ads Analyst

#### 4.9 `cro-specialist` Skill
- **Role**: Conversion rate optimization across touchpoints
- **Capabilities**:
  - Landing page analysis and recommendations
  - Form optimization
  - Signup flow improvement
  - A/B test design
  - User journey mapping
  - Heatmap analysis interpretation
- **References**: coreyhaines31: 6 CRO skills (page-cro, signup-flow-cro, onboarding-cro, form-cro, popup-cro, paywall-upgrade-cro)

#### 4.10 `competitive-intelligence` Skill
- **Role**: Market and competitor monitoring
- **Capabilities**:
  - Competitor website tracking
  - Social media strategy analysis
  - Pricing monitoring
  - Content gap identification
  - Market trend analysis
- **References**: MindStudio Competitive Intelligence Agent, Gumloop Competitive SEO Analyzer

### Tier 3: Specialized Skills (P2)

#### 4.11 `brand-manager` Skill
- Brand voice guidelines, visual identity standards, content tone enforcement

#### 4.12 `lead-manager` Skill
- Lead scoring, qualification, CRM integration, nurture sequence design

#### 4.13 `marketing-strategist` Skill
- Go-to-market planning, pricing strategy, launch playbooks, marketing psychology

#### 4.14 `document-generator` Skill
- Proposals, reports, case studies (DOCX/PDF) with brand templates

#### 4.15 `paid-ads-manager` Skill
- Google Ads, Meta Ads, LinkedIn Ads campaign management and optimization

---

## 5. Recommended Persona Additions

Based on the skills analysis, Artibot needs new marketing-specific personas:

| Persona | Role | Skills Used |
|---------|------|-------------|
| `persona-marketer` | Marketing strategist, campaign planner | campaign-orchestrator, marketing-strategist, competitive-intelligence |
| `persona-content` | Content creator, copywriter, brand voice | content-creator, seo-optimizer, brand-manager |
| `persona-data-analyst` | Marketing data analyst, reporting specialist | data-analyst, analytics-reporter, cro-specialist |
| `persona-social-media` | Social media manager, community engagement | social-media-manager, content-creator |

---

## 6. Recommended Agent Additions

For Agent Teams API orchestration:

| Agent | Role in Team | Primary Skills |
|-------|-------------|---------------|
| `email-specialist` | Email campaign design and automation | email-marketing |
| `ppt-specialist` | Presentation and deck creation | presentation-creator |
| `data-specialist` | Data analysis and reporting | data-analyst, analytics-reporter |
| `content-specialist` | Content writing and SEO | content-creator, seo-optimizer |
| `social-specialist` | Social media management | social-media-manager |
| `campaign-lead` | Campaign orchestration and coordination | campaign-orchestrator |

---

## 7. MCP Integration Recommendations

| MCP Server | Marketing Use |
|------------|---------------|
| **Context7** | Marketing framework docs (Mailchimp API, Meta API, GA4 API) |
| **Playwright** | Landing page testing, ad preview, social media scraping |
| **Postiz** (new) | Social media posting across 30+ platforms |
| **Google Sheets** (new) | Campaign data storage and reporting |
| **File System** | Template storage, brand asset management |

---

## 8. Architecture Decision: Skill Structure for Marketing

Recommended structure following Agent-Skills-for-Context-Engineering pattern:

```
plugins/artibot/skills/
├── email-marketing/
│   ├── SKILL.md              # Core instructions + triggers
│   └── references/
│       ├── email-templates.md       # Cold outreach, drip, newsletter templates
│       ├── segmentation-guide.md    # Audience segmentation strategies
│       └── metrics-reference.md     # KPI formulas and benchmarks
├── presentation-creator/
│   ├── SKILL.md
│   └── references/
│       ├── slide-templates.md       # Deck structure templates
│       ├── chart-patterns.md        # Data visualization best practices
│       └── brand-layouts.md         # Brand-consistent layout rules
├── data-analyst/
│   ├── SKILL.md
│   └── references/
│       ├── kpi-formulas.md          # Marketing KPI calculations
│       ├── platform-apis.md         # GA4, Meta, Google Ads data schemas
│       └── reporting-templates.md   # Weekly/monthly report formats
├── content-creator/
│   ├── SKILL.md
│   └── references/
│       ├── content-frameworks.md    # AIDA, PAS, BAB frameworks
│       ├── seo-checklist.md         # On-page SEO requirements
│       └── brand-voice.md           # Tone and style guidelines
├── social-media-manager/
│   ├── SKILL.md
│   └── references/
│       ├── platform-specs.md        # Character limits, image sizes per platform
│       ├── engagement-benchmarks.md # Platform-specific engagement rates
│       └── hashtag-strategies.md    # Hashtag research methodologies
└── campaign-orchestrator/
    ├── SKILL.md
    └── references/
        ├── campaign-playbooks.md    # Launch, seasonal, evergreen playbooks
        ├── channel-matrix.md        # Channel selection decision framework
        └── budget-allocation.md     # Budget distribution strategies
```

---

## 9. Summary of Sources

### Primary Benchmark Repositories
| Repository | Skills | Focus |
|------------|--------|-------|
| muratcankoylan/Agent-Skills-for-Context-Engineering | 13 | Context engineering (architecture reference) |
| anthropics/skills | ~10 | Official document skills (pptx, xlsx, docx, pdf) |
| coreyhaines31/marketingskills | 25 | Marketing-specific (CRO, copy, SEO, email) |
| alirezarezvani/claude-skills | 50+ | Multi-domain including 6 marketing skills |
| wshobson/agents | 112 agents | Composable plugin architecture |
| travisvn/awesome-claude-skills | Curated | Community skill catalog |
| VoltAgent/awesome-agent-skills | 300+ | Developer-focused catalog |

### Marketing AI Tools Referenced
| Tool | Category | Key Insight |
|------|----------|-------------|
| Postiz Agent | Social Media CLI | 30+ platforms, JSON output for agents |
| 2Slides | Presentations | MCP/Claude Code AI slide workflows |
| OPC Skills | Solopreneur | SEO-GEO, research, design tools |
| Gumloop | Marketing Automation | 15 specialized marketing agent types |
| MindStudio | Marketing Teams | 10 essential marketing agent templates |
| Klaviyo | Email/CRM | AI-powered email with 25+ agents |
| ActiveCampaign | Email Automation | Campaigns Agent, Automations Agent |
| Improvado | Analytics | 500+ API connectors, AI reporting |

### Industry Data Points
- Marketing teams using AI agents: **73% faster** campaign development
- Content creation timelines: **68% shorter** with AI
- Multi-agent systems outperform single-agent by **90.2%** on complex tasks
- By end 2026: **40% of enterprise apps** integrated with task-specific AI agents
- Claude holds **32% enterprise AI application** market share

---

## 10. Key Recommendations

1. **Start with P0 skills**: email-marketing, presentation-creator, data-analyst, content-creator, social-media-manager, campaign-orchestrator
2. **Follow Agent-Skills pattern**: SKILL.md (<500 lines) + references/ for detailed content
3. **Leverage Anthropic's official skills**: Integrate pptx/xlsx/docx/pdf as dependencies
4. **Add marketing personas**: persona-marketer, persona-content, persona-data-analyst, persona-social-media
5. **Extend Agent Teams**: 6 new specialist agents for marketing team composition
6. **New commands**: `/mkt`, `/email`, `/ppt`, `/excel`, `/social`, `/campaign`
7. **New playbooks**: marketing-campaign, content-sprint, email-sequence, social-launch
8. **MCP extensions**: Postiz (social posting), Google Sheets (data), marketing APIs
