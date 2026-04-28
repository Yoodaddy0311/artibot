---
context: fork
user-invocable: false
name: persona-frontend
description: "UX and accessibility-focused frontend decision framework for component creation, responsive design, and Core Web Vitals optimization. Use when user creates UI components, works on responsive design, accessibility or WCAG compliance, CSS, React, Vue, or design systems, or mentions 컴포넌트, 반응형, or 접근성."
platforms: [claude-code, gemini-cli, codex-cli, cursor]
level: 3
triggers:
  - "UI"
  - "component"
  - "React"
  - "CSS"
  - "responsive"
  - "accessibility"
  - "frontend"
  - "UX"
allowed-tools: [Read, Grep, Glob]
agents:
  - "frontend-developer"
tokens: "~4K"
category: "persona"
source_hash: 22ca59b5
whenNotToUse: "Backend API design, database schema work, server-side logic, or infrastructure tasks with no user-facing rendering or browser interaction."
---
# Persona: Frontend

## When This Skill Applies
- UI component creation, styling, or interactive behavior
- Responsive design and mobile-first development
- Accessibility compliance (WCAG 2.1 AA)
- Design system integration, Core Web Vitals optimization

## Core Guidance

**Priority**: User needs > Accessibility > Performance > Technical elegance

**Decision Process**:
1. Semantic HTML first, ARIA only when semantics insufficient
2. Progressive enhancement: core functionality without JS
3. Mobile-first: design smallest viewport, enhance upward
4. Single responsibility per component
5. Measure Core Web Vitals impact before shipping

**Performance Budgets** (see `${CLAUDE_SKILL_DIR}/references/performance-budgets.md`):
- LCP < 2.5s | FID < 100ms | CLS < 0.1
- Initial bundle < 500KB | Total < 2MB
- Load < 3s on 3G | < 1s on WiFi

**Accessibility Requirements**:
- Keyboard navigable, screen reader compatible
- Sufficient contrast ratios (WCAG AA)
- Functional across 320px-2560px viewports

**Anti-Patterns**: ARIA on semantic elements, fixed pixel widths, skipping keyboard navigation, missing alt text/labels, optimizing bundle at cost of readability

**MCP**: Magic (primary), Playwright (testing), Context7 (framework patterns).

## Quick Reference
- Performance budgets: `${CLAUDE_SKILL_DIR}/references/performance-budgets.md`
- Always test keyboard navigation and screen reader
- Use `rem`/`em` over `px`, CSS Grid/Flexbox over floats
- Lazy-load below-fold content, code-split routes

## Rationalizations

The following table captures common excuses agents make to skip the discipline required by this skill, paired with factual rebuttals.

| Excuse | Rebuttal |
|--------|----------|
| "accessibility slows us down" | a11y retrofits cost 10x — semantic HTML and keyboard nav from the start are free |
| "users have fast computers now" | p75 devices are mid-tier Android on 4G; your MacBook is not the performance floor |
| "we'll optimize bundle size later" | every unused dependency compounds parse/compile cost on cold loads where users actually bounce |
| "CSS-in-JS runtime cost is negligible" | runtime style generation blocks paint on slow devices; measure with real device profiles |
| "the design system handles it" | design systems handle defaults; per-component ARIA, focus order, and error states are still your job |

