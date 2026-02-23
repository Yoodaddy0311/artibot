---
name: visual-validation
description: |
  Visual regression testing using SSIM-based screenshot comparison.
  Auto-activates when: visual testing, UI regression checks, screenshot comparison, component validation, CSS fix suggestions needed.
  Triggers: visual, screenshot, regression, baseline, pixel, SSIM, UI validation, component check
platforms: [claude-code, gemini-cli, codex-cli, cursor]
level: 3
progressive_disclosure:
  enabled: true
  level1_tokens: 120
  level2_tokens: 4000
triggers:
  - "visual"
  - "screenshot"
  - "regression"
  - "baseline"
  - "pixel"
  - "SSIM"
  - "visual test"
  - "UI validation"
  - "component check"
  - "visual diff"
agents:
  - "qa"
  - "frontend-developer"
tokens: "~4K"
category: "testing"
---

# Visual Validation

## When This Skill Applies
- Comparing UI screenshots against approved baselines
- Detecting visual regressions after CSS or layout changes
- Validating component appearance across environments or browsers
- Generating CSS fix suggestions from visual diffs

## Core Workflow

### 1. Establish a Baseline
Before running validation, capture and store a reference (baseline) screenshot:
```
/visual-check https://example.com --baseline ./baselines/home.png
```
Or use `createBaseline()` from `lib/visual/visual-validator.js` to generate Playwright capture instructions.

### 2. Run Validation
Compare the current render against the baseline:
```
/visual-check https://example.com --baseline ./baselines/home.png --threshold 0.95
```

### 3. Interpret Results
- **passed: true** — similarity ≥ threshold, no action needed
- **passed: false** — `diffRegions` lists changed areas; `fixSuggestions` provide CSS remediation hints

## Threshold Guidelines

| Scenario | Recommended Threshold |
|----------|-----------------------|
| Pixel-perfect static pages | 0.98 |
| Standard UI components (default) | 0.95 |
| Responsive / fluid layouts | 0.90 |
| Dynamic content with animations | 0.85 |

Always use the **lowest acceptable threshold** for your use case to avoid false positives.

## Best Practices

### Disable Animations
CSS animations and transitions cause false diffs. The validator automatically injects:
```css
*, *::before, *::after {
  animation-duration: 0s !important;
  transition-duration: 0s !important;
}
```
Pass `--disableAnimations false` only when testing animation state is intentional.

### Exclude Dynamic Elements
Hide timestamps, ads, live counters, and other dynamic regions before capture:
```
/visual-check https://example.com --exclude ".ad-banner, #live-clock, [data-dynamic]"
```

### Maximum 3 Iterations
The validator runs up to `--iterations 3` (default) comparison attempts. After 3 passes without reaching threshold, fix suggestions are returned for manual CSS remediation.

### Scope to Components
Use `--selector` to scope screenshots to a specific component rather than the full page. This reduces noise and improves accuracy:
```
/visual-check https://example.com/docs --selector ".sidebar-nav" --threshold 0.98
```

## Integration with Playwright MCP

The validator does not call Playwright directly — it returns **structured MCP tool instructions**:

```json
[
  { "tool": "playwright_navigate", "params": { "url": "https://example.com" } },
  { "tool": "playwright_evaluate", "params": { "script": "/* disable animations */" } },
  { "tool": "playwright_screenshot", "params": { "name": "actual", "storeBase64": true } }
]
```

These instructions should be dispatched via the Playwright MCP server at runtime.

## Fix Suggestion Categories

| Category | Description | Common CSS Properties |
|----------|-------------|----------------------|
| `spacing` | Margin/padding changes | `margin`, `padding`, `gap` |
| `color` | Background or text color changes | `color`, `background-color`, `fill` |
| `typography` | Font rendering differences | `font-family`, `font-size`, `font-weight` |
| `alignment` | Layout offset or flex/grid drift | `display`, `justify-content`, `align-items` |
| `size` | Element dimension changes | `width`, `height`, `min-*`, `max-*` |
| `visibility` | Show/hide state changes | `display`, `visibility`, `opacity` |

## Quick Reference

```
/visual-check [url]
  --baseline <path>       Baseline image path (required for comparison)
  --threshold <0-1>       Similarity threshold (default: 0.95)
  --iterations <n>        Max retry iterations (default: 3)
  --selector <css>        Scope screenshot to element
  --exclude <css-list>    Hide dynamic elements before capture
```

---

## References

- See `references/validation-thresholds.md` for validation thresholds
