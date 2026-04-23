---
context: fork
name: seo-strategy
description: "Develops SEO strategy including keyword research, search intent classification, ranking factor analysis, keyword clustering, and GEO (Generative Engine Optimization). Use when user asks about SEO strategy, keyword research, search intent, ranking factors, content gap analysis, SEO roadmap, GEO, 검색엔진최적화, 키워드 리서치, 검색 의도, 네이버 SEO, C-Rank, or 네이버 블로그."
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
  - "네이버 SEO"
  - "C-Rank"
  - "네이버 블로그"
  - "국내 검색"
  - "Naver SEO"
agents:
  - "code-reviewer"
  - "backend-developer"
tokens: "~5K"
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

### 7. Naver SEO (한국 검색 최적화)

Google SEO와 다른 네이버 고유 알고리즘 두 가지:

#### C-Rank (Creator Rank) — 블로그/발행자 신뢰도
| 요소 | 설명 | 최적화 방향 |
|------|------|------------|
| 활동성 | 포스팅 빈도, 규칙성 | 주 2-3회 일정한 발행 |
| 반응성 | 방문자 수, 댓글, 공유 | 독자 참여 유도 콘텐츠 |
| 영향력 | 이웃/구독자 규모 | 지속적 팔로워 성장 |
| 주제 전문성 | 동일 카테고리 일관성 | 단일 주제 집중 |

#### DIA (Document Index Algorithm) — 콘텐츠 품질
| 지표 | 설명 | 최적화 방향 |
|------|------|------------|
| 정보 정확성 | 출처, 전문성 표시 | 데이터·수치·전문가 인용 |
| 체류 시간 | 스크롤 깊이 | 1,500자 이상, 목차 제공 |
| 이탈률 | 바운스 역지표 | 관련 포스트 내부링크 |
| 원본성 | Copy Detector 회피 | 직접 작성, 인용 시 출처 명시 |

#### 스마트블록 최적화
- **뷰 탭**: 블로그 + 카페 통합 — 키워드 + 전문성 중심
- **인플루언서 탭**: C-Rank 상위 — 팬 기반 구축 필요
- **지역 키워드**: `[지역명] + [서비스/제품명]` 조합 우선 공략
- **최신성**: 발행 후 48시간이 노출 피크 → 오전 9-11시 발행 권장

#### 네이버 SEO vs Google SEO 비교
| 항목 | 네이버 | 구글 |
|------|--------|------|
| 핵심 지표 | C-Rank (발행자 신뢰) | PageRank (도메인 권위) |
| 백링크 가중치 | 낮음 | 매우 높음 |
| 발행 빈도 | 높을수록 유리 | 품질 > 빈도 |
| 이미지 최적화 | 자체 이미지 검색 | Alt text, 구조화 데이터 |
| 지역 SEO | 스마트플레이스 연동 | Google Business Profile |
| 추천 포스트 길이 | 1,500~2,500자 | 1,500~2,500 words |

### 8. SEO Roadmap Template

| Phase | Timeframe | Focus | Expected Impact |
|-------|-----------|-------|----------------|
| Quick Wins | Month 1-2 | Fix technical issues, optimize existing pages | 10-20% traffic lift |
| Foundation | Month 2-4 | Core content creation, internal linking | 20-40% growth |
| Growth | Month 4-8 | Link building, content scaling, new clusters | 40-80% growth |
| Authority | Month 8-12 | Thought leadership, PR, advanced content | 80-150% growth |
| 한국 시장 | Month 1-3 | 네이버 블로그 C-Rank 구축, 스마트블록 공략 (빠른 성과 시 네이버 키워드 광고 병행 검토) | 국내 검색 점유 확대 |

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

---

## References

- See `${CLAUDE_SKILL_DIR}/references/search-intent-classification.md` for search intent classification framework
- See `${CLAUDE_SKILL_DIR}/references/keyword-priority-formula.md` for keyword priority formula
- See `${CLAUDE_SKILL_DIR}/references/geo-optimization-guide.md` for GEO (Generative Engine Optimization) principles
- See `${CLAUDE_SKILL_DIR}/references/naver-seo-guide.md` for Naver-specific SEO tactics (C-Rank, DIA, Smartblock optimization) — 향후 추가 예정
