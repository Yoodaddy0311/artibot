# Core Web Vitals Optimization Guide

**Fix Core Web Vitals first: Google's ranking algorithm heavily weights these metrics. Ignoring them tanks rankings regardless of content quality.**

## Core Web Vitals Thresholds & Priorities

| Metric | Good | Needs Improvement | Poor | Optimization Priority |
|---|---|---|---|---|
| **LCP (Largest Contentful Paint)** | <2.5s | 2.5-4.0s | >4.0s | Critical (first priority) |
| **INP (Interaction to Next Paint)** | <200ms | 200-500ms | >500ms | High (user experience) |
| **CLS (Cumulative Layout Shift)** | <0.1 | 0.1-0.25 | >0.25 | High (visual stability) |

## LCP Optimization (Largest Contentful Paint)

**Goal**: Main content visible within 2.5 seconds

| Problem | Solution | Expected Impact |
|---|---|---|
| Large images causing delay | Compress images, use modern formats (WebP) | 30-50% reduction |
| Render-blocking CSS/JS | Defer non-critical CSS, minify, inline critical | 20-40% reduction |
| Slow server response | Upgrade hosting, implement caching, CDN | 15-35% reduction |
| Unoptimized fonts | System fonts or font-display: swap | 10-20% reduction |
| Third-party scripts | Lazy-load ads, analytics, chat widgets | 15-30% reduction |

## INP Optimization (Interaction to Next Paint)

**Goal**: Respond to user interactions within 200ms

| Problem | Solution | Expected Impact |
|---|---|---|
| Long JavaScript execution | Break up tasks with setTimeout, use Web Workers | 20-50% reduction |
| Slow event handlers | Debounce/throttle expensive functions | 30-60% reduction |
| Heavy DOM manipulations | Batch DOM updates, use virtual scrolling | 25-45% reduction |
| Unoptimized event listeners | Remove unused listeners, delegate events | 10-30% reduction |

## CLS Optimization (Cumulative Layout Shift)

**Goal**: No unexpected visual movement during load

| Problem | Solution | Expected Impact |
|---|---|---|
| Missing image dimensions | Set explicit width/height or aspect-ratio | 40-60% reduction |
| Late-loaded fonts | Use font-display: swap or system fonts | 20-40% reduction |
| Ads/embeds causing shift | Reserve space with fixed containers | 50-80% reduction |
| Animations shifting layout | Use transform instead of position changes | 30-50% reduction |
| Lazy-loaded content | Smooth transitions, skeleton screens | 25-40% reduction |

## Core Web Vitals Testing Tools

- **Google PageSpeed Insights**: Real-world data (CrUX) + lab data
- **Chrome DevTools**: Performance tab, timing breakdown
- **Web.dev Measure**: Comprehensive audit with recommendations
- **Lighthouse**: Automated testing, detailed suggestions
- **WebPageTest**: Waterfall analysis, filmstrip view

## Priority Checklist

- [ ] Audit all critical pages with PageSpeed Insights
- [ ] Identify top 3 LCP issues, fix highest impact
- [ ] Compress/optimize all images >100KB
- [ ] Defer or async non-critical JavaScript
- [ ] Implement caching headers (browser + server)
- [ ] Set explicit dimensions for images/videos
- [ ] Use font-display: swap for custom fonts
- [ ] Minimize layout-causing CSS changes
- [ ] Test on mobile (most critical device)
- [ ] Monitor with Web Vitals JavaScript library
- [ ] Retest and track improvement over time
