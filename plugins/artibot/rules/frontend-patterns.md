---
paths:
  - "**/*.tsx"
  - "**/*.jsx"
  - "**/*.css"
  - "**/*.scss"
  - "**/components/**"
---

# Artibot Frontend Rules

## Component Standards
- Functional components only (no class components)
- Props interface defined above component
- Use `React.memo` for expensive renders, not by default
- Extract hooks into `use*.ts` files when reused

## Accessibility (WCAG 2.1 AA)
- Every interactive element needs keyboard support
- Images require meaningful `alt` text
- Form inputs require associated `<label>`
- Color contrast ratio >= 4.5:1 for text

## Performance Budgets
- Initial bundle < 500KB
- Per-component < 50KB
- LCP < 2.5s, FID < 100ms, CLS < 0.1

## CSS Patterns
- Use CSS Modules or Tailwind (match project convention)
- Mobile-first responsive design
- No `!important` unless overriding third-party
- Design tokens over hardcoded values
