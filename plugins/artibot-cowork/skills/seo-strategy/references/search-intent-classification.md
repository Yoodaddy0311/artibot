# Search Intent Classification Framework

**Match user intent precisely: Search intent is more important than exact keyword match. Wrong intent = wrong audience regardless of ranking.**

## Intent Types & Signals

| Intent Type | Signals | Content Type | Conversion Potential | Example Queries |
|---|---|---|---|---|
| **Informational** | "how to", "what is", "guide", "tutorial", "explain" | Blog posts, guides, tutorials, wikis | Low (educational) | "how to optimize images", "what is SEO" |
| **Navigational** | Brand name, "login", specific product, "[brand] + page" | Homepage, brand pages, product pages | High (brand loyalty) | "google search console", "stripe dashboard" |
| **Commercial** | "best", "review", "vs", "compare", "pricing" | Comparison pages, reviews, alternatives | Medium (research phase) | "best email tools", "slack vs teams", "pricing plans" |
| **Transactional** | "buy", "pricing", "discount", "free trial", "sign up" | Product pages, pricing pages, checkout | Very High (purchase intent) | "buy shoes online", "get started free" |

## Classification Decision Tree

1. **Does query include brand name?** → Navigational
2. **Does query ask for information without buying intent?** → Informational
3. **Does query compare or evaluate options?** → Commercial
4. **Does query indicate purchase/action readiness?** → Transactional

## Priority Ranking

1. **Transactional (Revenue-focused)** - Highest priority for monetized sites
2. **Commercial (Early sales funnel)** - Support transactional traffic
3. **Navigational (Retention)** - Keep existing users engaged
4. **Informational (Acquisition)** - Build authority, capture unaware users

## Quick Classification Checklist

- [ ] Identify primary search intent (not what you want, what searcher wants)
- [ ] Check competitor top 10 results (confirms intent classification)
- [ ] Match content structure to intent type
- [ ] Verify landing page matches query intent
- [ ] Avoid transactional content for informational queries
