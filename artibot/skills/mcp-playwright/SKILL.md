---
name: mcp-playwright
description: |
  Playwright MCP server integration for browser automation,
  E2E testing, performance monitoring, and visual testing.

  Use proactively when running E2E tests, measuring performance,
  capturing screenshots, or validating cross-browser behavior.

  Triggers: E2E, end-to-end, browser test, Playwright, screenshot,
  visual test, cross-browser, performance metrics, lighthouse,
  E2E, 브라우저테스트, 스크린샷, 성능측정,
  E2E, ブラウザテスト, スクリーンショット

  Do NOT use for: unit tests, API-only tests, static analysis,
  or tasks not involving browser interaction.
---

# Playwright Integration

> Real browser testing. Actual user interactions. Measured performance.

## When This Skill Applies

- E2E test creation or execution
- Cross-browser compatibility validation
- Performance metrics collection (Core Web Vitals)
- Visual regression testing
- User workflow simulation
- Accessibility testing in real browsers

## Capabilities

| Feature | Description |
|---------|------------|
| Multi-Browser | Chrome, Firefox, Safari, Edge |
| Screenshots | Full page and element capture |
| Performance | Load times, Core Web Vitals, resource usage |
| User Simulation | Click, type, navigate, scroll, drag |
| Mobile | Device emulation, touch gestures |
| Network | Throttling, request interception |
| Video | Test run recording |

## Test Structure

```typescript
import { test, expect } from '@playwright/test'

test('user can complete checkout', async ({ page }) => {
  // Navigate
  await page.goto('/products')

  // Interact
  await page.click('[data-testid="add-to-cart"]')
  await page.click('[data-testid="checkout"]')

  // Fill form
  await page.fill('#email', 'test@example.com')
  await page.fill('#card', '4242424242424242')

  // Submit
  await page.click('[data-testid="submit-order"]')

  // Verify
  await expect(page.locator('.confirmation')).toBeVisible()
})
```

## Performance Measurement

```typescript
test('homepage meets performance budget', async ({ page }) => {
  await page.goto('/')

  const metrics = await page.evaluate(() => ({
    lcp: performance.getEntriesByType('largest-contentful-paint')[0]?.startTime,
    fid: performance.getEntriesByType('first-input')[0]?.processingStart,
    cls: performance.getEntriesByType('layout-shift').reduce((sum, e) => sum + e.value, 0)
  }))

  expect(metrics.lcp).toBeLessThan(2500)
  expect(metrics.cls).toBeLessThan(0.1)
})
```

## Cross-Browser Testing

```typescript
// playwright.config.ts
projects: [
  { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
  { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  { name: 'mobile', use: { ...devices['iPhone 14'] } },
]
```

## Best Practices

- Use `data-testid` attributes for stable selectors
- Avoid `page.waitForTimeout()` (use explicit waits)
- Run tests in parallel for speed
- Use test fixtures for common setup
- Clean up test data after each test

## Anti-Patterns

- Do NOT use CSS selectors that depend on styling
- Do NOT hardcode timeouts
- Do NOT share state between tests
- Do NOT test third-party services (mock external APIs)
