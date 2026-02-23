# Validation Thresholds

**Core: SSIM ≥ 0.95 = pass. Every component type has specific thresholds based on visual sensitivity.**

## Component-Level Thresholds

| Component Type | SSIM Threshold | Pixel Tolerance | Max Iterations | Priority |
|---------------|---------------|-----------------|----------------|----------|
| **Typography** | 0.98 | 0px | 3 | Critical |
| **Color / Brand** | 0.97 | 1px | 3 | Critical |
| **Spacing / Layout** | 0.96 | 2px | 3 | High |
| **Overall Page** | 0.95 | 2px | 3 | High |
| **Icons / Graphics** | 0.94 | 2px | 2 | Medium |
| **Interactive States** | 0.93 | 3px | 2 | Medium |
| **Animation Frames** | 0.90 | 5px | 2 | Low |
| **Dynamic Content** | 0.88 | 5px | 1 | Low |

## Viewport Breakpoints

| Breakpoint | Width | Device Class | SSIM Adjustment |
|-----------|-------|-------------|-----------------|
| **Mobile** | 375px | iPhone SE/13/14 | -0.02 (font rendering) |
| **Mobile L** | 428px | iPhone Pro Max | -0.01 |
| **Tablet** | 768px | iPad Mini | Base threshold |
| **Desktop** | 1280px | Laptop | Base threshold |
| **Wide** | 1920px | Monitor | Base threshold |

## Failure Triage

| Severity | SSIM Range | Action | SLA |
|----------|-----------|--------|-----|
| **Critical** | < 0.85 | Block deploy, immediate fix | Same session |
| **Major** | 0.85 - 0.90 | Fix required, flag in review | Within 24h |
| **Minor** | 0.90 - 0.95 | Investigate, fix if practical | Next sprint |
| **Pass** | ≥ 0.95 | No action needed | N/A |

## Root Cause Guide

| Symptom | Likely Cause | Fix Approach |
|---------|-------------|-------------|
| Text SSIM drop | Font loading / rendering difference | Verify font-display, check web font CDN |
| Layout shift | CSS specificity conflict | Check CLS, inspect computed styles |
| Color mismatch | Theme variable override | Audit CSS custom properties chain |
| Spacing diff | Box model inconsistency | Check margin collapse, padding inheritance |
| Image diff | Compression artifact / lazy load | Verify image format, check loading state |

## Platform Font Rendering Tolerance

| Platform | Adjustment | Reason |
|----------|-----------|--------|
| **Windows** | -0.02 | ClearType subpixel rendering |
| **macOS** | Base (0.00) | Reference platform |
| **Linux** | -0.03 | FreeType hinting variance |
| **Mobile** | -0.02 | DPI scaling differences |

## Validation Checklist

- [ ] Baseline screenshots captured at all breakpoints
- [ ] SSIM threshold configured per component type
- [ ] Viewport breakpoints include mobile, tablet, desktop
- [ ] Font rendering tolerance applied per platform
- [ ] Animations disabled during capture (`prefers-reduced-motion`)
- [ ] Dynamic content masked or stabilized before comparison
- [ ] Failure severity mapped to action and SLA
- [ ] CI pipeline blocks on Critical failures only
- [ ] Diff images generated and stored for review
- [ ] Baseline updated after approved visual changes
