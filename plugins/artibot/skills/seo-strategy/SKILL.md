---
name: seo-strategy
description: |
  SEO strategy development including keyword research, search intent classification, ranking factor analysis, and GEO (Generative Engine Optimization).
  Provides frameworks for keyword clustering, content mapping, and SEO roadmap planning.
  Auto-activates when: keyword research, SEO strategy, search intent analysis, SEO planning, GEO optimization.
  Triggers: SEO strategy, keyword research, search intent, ranking factors, keyword cluster, content gap, SEO roadmap, GEO, generative engine, 검색엔진최적화, 키워드 리서치, 검색 의도
platforms: [claude-code, gemini-cli, codex-cli, cursor]
level: 3
triggers:
  - "SEO"
  - "search engine"
  - "keyword"
  - "organic search"
  - "SERP"
  - "link building"
  - "technical SEO"
agents:
  - "persona-analyzer"
  - "persona-backend"
tokens: "~4K"
category: "marketing"
---

# SEO Strategy

## When This Skill Applies
- Developing keyword strategies and content roadmaps
- Classifying search intent for keyword targeting
- Planning SEO campaigns with prioritized actions
- Analyzing ranking factors and competitive position
- Adapting to AI search / GEO (Generative Engine Optimization)

## Core Guidance

### 1. SEO Strategy Process
```
Audit Current State -> Keyword Research -> Intent Classification -> Keyword Clustering -> Content Mapping -> Priority Scoring -> Roadmap Creation -> Execution -> Monitoring
```

### 2. Search Intent Classification

| Intent | Signals | Content Type | Conversion Potential |
|--------|---------|-------------|---------------------|
| Informational | "how to", "what is", "guide" | Blog, guide, FAQ | Low (awareness) |
| Navigational | Brand names, product names | Homepage, product page | Medium (brand) |
| Commercial | "best", "review", "comparison" | Comparison, review page | High (consideration) |
| Transactional | "buy", "pricing", "signup" | Product, pricing, signup | Highest (decision) |

### 3. Keyword Research Framework

**Seed Expansion Methods**:
- Competitor keyword mining
- Related searches and "People Also Ask"
- Topic cluster brainstorming
- Customer language from support/sales
- Forum and community mining

**Keyword Evaluation Criteria**:
| Factor | Weight | Scoring |
|--------|--------|---------|
| Search volume | 25% | Monthly search volume |
| Difficulty | 25% | Competition level (1-100) |
| Relevance | 30% | Alignment to product/audience |
| Intent match | 20% | Commercial/transactional intent |

**Priority Score**: `(volume * 0.25) + ((100 - difficulty) * 0.25) + (relevance * 0.30) + (intent * 0.20)`

### 4. Keyword Clustering

Group keywords by topic clusters for topical authority:

```
Pillar Topic: [broad keyword]
├── Cluster 1: [subtopic] -> [page/URL]
│   ├── [long-tail keyword 1]
│   ├── [long-tail keyword 2]
│   └── [long-tail keyword 3]
├── Cluster 2: [subtopic] -> [page/URL]
└── Cluster 3: [subtopic] -> [page/URL]
```

**Cluster Rules**:
- Each cluster maps to one URL
- Pillar page links to all cluster pages
- Cluster pages interlink within cluster
- One primary keyword per page, 2-5 secondary

### 5. Ranking Factors (Weighted)

| Category | Factor | Impact |
|----------|--------|--------|
| Content | Quality, relevance, comprehensiveness | Very High |
| Content | Keyword optimization, heading structure | High |
| Technical | Page speed, Core Web Vitals | High |
| Technical | Mobile-friendliness | High |
| Authority | Backlinks (quality > quantity) | Very High |
| Authority | Domain authority, brand signals | High |
| Experience | User engagement, dwell time, bounce | Medium-High |
| Experience | E-E-A-T signals | Medium-High |

### 6. GEO (Generative Engine Optimization)

Optimizing for AI-powered search (ChatGPT, Gemini, Perplexity):

| Traditional SEO | GEO Adaptation |
|-----------------|----------------|
| Keyword density | Natural language, entity coverage |
| Blue link ranking | Citation-worthiness |
| Click-through rate | Source attribution |
| Backlinks | Authoritative content structure |
| Meta descriptions | Structured data, clear summaries |

**GEO Best Practices**:
- Provide clear, definitive answers early in content
- Use structured data (FAQ, HowTo, Article schema)
- Include statistics, citations, and expert quotes
- Write in a style that AI can easily extract and attribute
- Ensure brand entity is well-defined across the web

### 7. SEO Roadmap Template

| Phase | Timeframe | Focus | Expected Impact |
|-------|-----------|-------|----------------|
| Quick Wins | Month 1-2 | Fix technical issues, optimize existing pages | 10-20% traffic lift |
| Foundation | Month 2-4 | Core content creation, internal linking | 20-40% growth |
| Growth | Month 4-8 | Link building, content scaling, new clusters | 40-80% growth |
| Authority | Month 8-12 | Thought leadership, PR, advanced content | 80-150% growth |

## Output Format
```
SEO STRATEGY
============
Target:     [domain/product]
Focus:      [keyword strategy|audit|content gap|competitor|GEO]

KEYWORD STRATEGY
----------------
Keyword         | Volume | Difficulty | Intent        | Priority
----------------|--------|------------|---------------|----------
[keyword]       | [vol]  | [1-100]    | [intent type] | [P1-P3]

TOPIC CLUSTERS
--------------
Pillar: [topic]
  Cluster 1: [subtopic] -> [target URL]
    Keywords: [kw1], [kw2], [kw3]

ROADMAP
-------
Phase        | Timeframe  | Actions              | Target
-------------|-----------|----------------------|--------
[phase]      | [months]  | [key actions]        | [metric target]
```

## Quick Reference

**Intent Types**: informational, navigational, commercial, transactional
**Priority Score**: volume (25%) + (100-difficulty) (25%) + relevance (30%) + intent (20%)
**Cluster Rule**: One primary keyword per page, pillar links to all clusters

See `references/keyword-templates.md` for keyword research and clustering templates.
See `references/ranking-factors.md` for detailed ranking factor analysis.
