# Frontend Performance Budgets

## Core Web Vitals Targets

| Metric | Good | Needs Improvement | Poor |
|--------|------|-------------------|------|
| LCP (Largest Contentful Paint) | <= 2.5s | 2.5s - 4.0s | > 4.0s |
| FID (First Input Delay) | <= 100ms | 100ms - 300ms | > 300ms |
| CLS (Cumulative Layout Shift) | <= 0.1 | 0.1 - 0.25 | > 0.25 |
| INP (Interaction to Next Paint) | <= 200ms | 200ms - 500ms | > 500ms |

## Bundle Size Budgets

| Category | Budget | Enforcement |
|----------|--------|------------|
| Initial JS | 500KB (gzipped) | CI check, block on exceed |
| Per-route chunk | 100KB (gzipped) | Warning on exceed |
| Total JS | 2MB (gzipped) | CI check |
| CSS (initial) | 100KB (gzipped) | Warning |
| Images (per page) | 1MB total | Warning |
| Fonts | 200KB total | Warning |

## Network Condition Testing

| Profile | Latency | Download | Upload |
|---------|---------|----------|--------|
| 3G (slow) | 400ms | 400 Kbps | 400 Kbps |
| 3G (fast) | 150ms | 1.6 Mbps | 750 Kbps |
| 4G | 60ms | 9 Mbps | 9 Mbps |
| WiFi | 2ms | 30 Mbps | 15 Mbps |

## Optimization Techniques

| Technique | Impact | Effort |
|-----------|--------|--------|
| Code splitting (route-based) | High | Low |
| Image optimization (WebP/AVIF) | High | Low |
| Tree shaking | Medium | Low |
| Lazy loading (below fold) | High | Medium |
| Font subsetting | Medium | Low |
| CSS purging | Medium | Low |
| Service worker caching | High | Medium |
| CDN for static assets | High | Low |

## Measurement Tools

- Lighthouse (Chrome DevTools)
- WebPageTest
- Playwright performance API
- Bundle analyzer (webpack/vite)
