---
name: artibot-narrative
description: Narrative structure output style — Hero-Support-Detail-CTA storytelling for CLI analysis reports
---

# Narrative Output Style

Storytelling-driven report format for long analysis results, audits, and reviews.
Transforms dense technical data into a clear narrative arc optimized for CLI reading.

## Structure: Hero → Support → Detail → CTA

### 1. Hero (Opening Impact)

The first 2-3 lines must capture the core finding. Lead with the single most
important insight, metric, or decision.

```markdown
## Security Audit: API Gateway

**3 critical vulnerabilities** found in authentication middleware.
The current token validation bypasses rate limiting on 2 endpoints.
```

Rules:
- One bold metric or finding
- One sentence of context
- No preamble, no greetings, no "I analyzed..."

### 2. Support (Evidence Layer)

A concise table or bullet list that backs the hero claim with data.
Use `artibot-report` table format with severity tokens from `tokens.md`.

```markdown
| # | Severity | Finding | Location |
|---|----------|---------|----------|
| 1 | **CRITICAL** | JWT validation skipped on refresh | `auth/refresh.js:42` |
| 2 | **CRITICAL** | Rate limit bypassed via header spoof | `middleware/rate.js:18` |
| 3 | **CRITICAL** | Session token stored in localStorage | `lib/session.js:91` |
```

Rules:
- 3-7 items maximum in the support layer
- Each item: severity + what + where
- Sort by severity descending

### 3. Detail (Deep Dive)

Expandable sections for each finding. Use heading-3 tokens for grouping.
Only include details that change the reader's decision or action.

```markdown
### JWT Validation Bypass (`auth/refresh.js:42`)

The refresh endpoint calls `verifyToken()` with `skipExpiry: true`,
which also disables signature verification due to a shared flag.

`verifyToken(token, { skipExpiry: true })` → `validateSignature` is false

**Impact**: Any expired token can access protected resources indefinitely.
**Root cause**: `skipExpiry` and `skipSignature` share the `skipValidation` flag.
```

Rules:
- One detail section per support item (or group related items)
- Lead with the mechanism (how/why), not the symptom
- End each section with **Impact** and **Root cause** lines
- Use flow tokens (`→`, `∵`, `∴`) for causal chains

### 4. CTA (Call to Action)

A prioritized action list. The reader should know exactly what to do next.

```markdown
### Recommended Actions

1. **Immediate**: Split `skipExpiry`/`skipSignature` into independent flags → `auth/refresh.js:42`
2. **Immediate**: Add `X-Forwarded-For` validation to rate limiter → `middleware/rate.js:18`
3. **This sprint**: Migrate session storage from localStorage to httpOnly cookies → `lib/session.js:91`
4. **Backlog**: Add automated security scan to CI pipeline

> Total estimated effort: **~4h** for critical fixes, **~8h** including backlog items.
```

Rules:
- Prioritize by urgency: Immediate > This sprint > Backlog
- Each action: **priority label** + what to do + where
- End with effort estimate in blockquote footer
- Maximum 7 actions (group if more)

## Narrative Patterns by Report Type

### Analysis Report
Hero: Key finding → Support: Evidence table → Detail: Root causes → CTA: Fixes

### Performance Report
Hero: Bottleneck metric → Support: Benchmark comparison → Detail: Profiling data → CTA: Optimizations

### Code Review
Hero: Quality verdict → Support: Issue summary → Detail: Per-file findings → CTA: Required changes

### Architecture Review
Hero: Design assessment → Support: Component health → Detail: Dependency analysis → CTA: Refactoring plan

## Token Integration

This style uses tokens from `tokens.md`:

- **Status**: `status-ok` through `status-error` for finding severity
- **Severity**: `severity-critical` through `severity-low` in support tables
- **Flow**: `flow-implies` (→) and `flow-because` (∵) in detail sections
- **Metric**: `metric-count`, `metric-change` in hero section
- **Accent**: `accent` for key values, `code` for file references, `highlight` for error locations

## Formatting Constraints

- Total output: 200-500 lines for comprehensive reports, 50-150 for focused reports
- Hero section: maximum 5 lines
- Support table: maximum 7 rows
- Detail sections: maximum 15 lines each
- CTA: maximum 7 items
- Use `---` horizontal rules sparingly (only between major sections if needed)
- Blockquote footer for meta-information (effort, timeline, notes)
