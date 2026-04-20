---
context: fork
name: mcp-playwright
description: "Provides Playwright MCP server workflow for E2E testing, visual validation, cross-browser automation, and performance measurement with error recovery strategies. Use when user asks about Playwright, E2E testing, browser automation, screenshot testing, visual regression, cross-browser testing, E2E 테스트, or 브라우저."
platforms: [claude-code, gemini-cli, codex-cli, cursor]
level: 2
triggers:
  - "playwright"
  - "E2E"
  - "browser automation"
  - "testing"
  - "screenshot"
  - "web testing"
agents:
  - "tdd-guide"
tokens: "~2K"
category: "tooling"
source_hash: b38af4d3
---
# MCP: Playwright

## When This Skill Applies
- Running E2E tests across browsers (Chrome, Firefox, Safari, Edge)
- Capturing screenshots for visual regression testing
- Measuring performance metrics and Core Web Vitals
- Automating user interaction workflows
- Testing responsive layouts across viewports

## Core Guidance

**Workflow**: Connect browser -> Configure env -> Navigate/interact -> Capture evidence -> Validate -> Report -> Cleanup

**Capabilities**:
| Capability | Description |
|------------|-------------|
| Multi-Browser | Chrome, Firefox, Safari, Edge |
| Visual Testing | Screenshots, visual regression, responsive |
| Performance | Load times, Core Web Vitals, resources |
| User Simulation | Clicks, forms, navigation, gestures |
| Mobile | Device emulation, touch, mobile viewports |

**Performance Thresholds**:
- LCP < 2.5s | FID < 100ms | CLS < 0.1 | TTFB < 800ms | Total load < 3s (3G)

**Test Pattern**:
```typescript
test('user completes flow', async ({ page }) => {
  await page.goto('/path');
  await page.click('[data-testid="action"]');
  await expect(page.locator('.result')).toBeVisible();
});
```

**Error Recovery**:
| Failure | Recovery |
|---------|----------|
| Connection lost | Retry, then suggest manual testing |
| Timeout | Increase timeout, check network |
| Element not found | Verify selector, check page state |
| Visual mismatch | Update baseline if intentional |

## Quick Reference
- Use `data-testid` selectors for stability
- Always cleanup browser connections
- Batch operations to minimize browser restarts
- Fallback: generate test code files for local execution

## Rationalizations

The following table captures common excuses agents make to skip the rigor of this skill, paired with factual rebuttals.

| Excuse | Rebuttal |
|--------|----------|
| "unit tests cover this" | unit tests do not catch browser rendering, keyboard nav, or cross-frame bugs — E2E does |
| "headless is good enough" | headless misses visual regressions that only appear under real rendering |
| "flaky tests are normal" | flakiness is almost always a missing wait — Playwright auto-waits if you let it |
| "screenshots bloat the repo" | store baselines in artifact storage, not git — bloat is a config issue |
| "cross-browser is legacy worry" | Safari and mobile WebKit still diverge from Chromium on flex, focus, and dates — test all three |
