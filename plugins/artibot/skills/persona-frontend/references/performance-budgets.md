# Frontend Performance Budgets

## Core Web Vitals

| Metric | Good | Needs Improvement | Poor |
|--------|------|-------------------|------|
| LCP (Largest Contentful Paint) | < 2.5s | 2.5s - 4.0s | > 4.0s |
| FID (First Input Delay) | < 100ms | 100ms - 300ms | > 300ms |
| CLS (Cumulative Layout Shift) | < 0.1 | 0.1 - 0.25 | > 0.25 |
| INP (Interaction to Next Paint) | < 200ms | 200ms - 500ms | > 500ms |

## Bundle Size Budgets

| Category | Budget | Action if exceeded |
|----------|--------|-------------------|
| Initial bundle (JS) | < 500KB gzipped | Code-split, tree-shake |
| Total bundle (JS) | < 2MB gzipped | Audit dependencies |
| Per-route chunk | < 150KB gzipped | Lazy-load components |
| Per-component | < 50KB | Extract shared code |
| CSS total | < 100KB gzipped | Purge unused styles |
| Images (per page) | < 1MB total | WebP/AVIF, lazy-load |

## Load Time Targets

| Network | Target | Strategy |
|---------|--------|----------|
| 3G (1.6 Mbps) | < 3s | Critical CSS inline, defer non-essential |
| 4G (9 Mbps) | < 1.5s | Preload key resources |
| WiFi (30+ Mbps) | < 1s | Service worker caching |

## Optimization Checklist

- [ ] Images: WebP/AVIF format, responsive `srcset`, lazy loading
- [ ] JS: Tree-shaking enabled, route-based code splitting
- [ ] CSS: Critical CSS inlined, unused styles purged
- [ ] Fonts: `font-display: swap`, subset to used characters
- [ ] Caching: Immutable hashes, CDN, service worker
- [ ] Preloading: `<link rel="preload">` for critical assets
- [ ] Third-party: Audit impact, async/defer loading
