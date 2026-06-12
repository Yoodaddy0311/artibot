---
context: fork
name: design-system-reference
platforms: [claude-code, gemini-cli, codex-cli, cursor]
description: "Provides a structured DESIGN.md schema and curated brand references for AI-native visual design specification. 자연어 트리거: '디자인 시스템 만들어줘', 'DESIGN.md 작성', '디자인 토큰 정의해줘', '비주얼 디자인 가이드', '컬러 팔레트 정해줘'."
lang: [en, ko]
level: 3
triggers:
  - "design system"
  - "DESIGN.md"
  - "visual design"
  - "UI design"
  - "design tokens"
  - "color palette"
  - "typography system"
  - "design language"
  - "design reference"
  - "디자인 시스템"
  - "비주얼 디자인"
  - "디자인 토큰"
whenNotToUse: "Functional UI implementation tasks (React components, CSS fixes) where design-token governance and visual specification are not the deliverable."
agents:
  - "frontend-developer"
  - "presentation-designer"
tokens: "~4K"
category: "design"
source_hash: 7540d882
---

# Design System Reference

## When This Skill Applies
- Creating a new visual design system for a project
- Generating a DESIGN.md specification from scratch
- Referencing established brand design patterns (Stripe, Vercel, Linear, Supabase, Apple)
- Specifying color palettes, typography, and component styles for AI agents
- Converting design intent into structured, machine-readable format
- Reviewing or auditing an existing design system

## Core Guidance

### 1. DESIGN.md Workflow
```
Identify Design Intent -> Select Reference Style -> Load Schema -> Generate DESIGN.md -> Validate 9 Sections -> Apply to Implementation
```

### 2. Schema Structure

Every DESIGN.md follows the **9-Section Schema** (see `references/design-md-schema.md`):

| Section | Purpose |
|---------|---------|
| 1. Visual Theme & Atmosphere | Overall feel, key characteristics |
| 2. Color Palette & Roles | Every color with semantic name + hex + role |
| 3. Typography Rules | Full hierarchy table with metrics |
| 4. Component Stylings | Buttons, cards, inputs with states |
| 5. Layout Principles | Grid, spacing, content widths |
| 6. Depth & Elevation | Shadows, borders, layering |
| 7. Do's and Don'ts | Specific guidance with reasoning |
| 8. Responsive Behavior | Breakpoints, scaling, adaptation |
| 9. Agent Prompt Guide | Ready-to-use prompts for key sections |

### 3. Reference Selection Guide

| If the project is... | Use reference | Why |
|---------------------|---------------|-----|
| SaaS / fintech / dashboard | `stripe.md` | Premium light theme, financial-grade typography |
| Developer tools / CLI / docs | `vercel.md` | Monochrome minimal, shadow-as-border technique |
| Dark-mode SaaS / project tool | `linear.md` | Dark-native, single accent color system |
| Developer platform / open-source | `supabase.md` | Terminal aesthetic, HSL token system |
| Consumer product / landing page | `apple.md` | Cinematic sections, product-as-hero |

### 4. Usage Patterns

#### Generate a New DESIGN.md
1. Read `references/design-md-schema.md` for the 9-section template
2. Optionally read a reference file for style inspiration (e.g., `references/stripe.md`)
3. Fill each section based on project requirements
4. Validate: all 9 sections present, every color has name + hex + role, typography table complete

#### Apply a Reference Style
1. Read the relevant reference file
2. Extract color palette, typography, and component patterns
3. Adapt to project-specific brand colors and content
4. Generate implementation CSS/Tailwind config

#### Audit an Existing Design
1. Read `references/design-md-schema.md` for the quality bar
2. Check: all 9 sections present, colors have semantic names, typography table is complete
3. Report gaps and suggest improvements

### 5. Quality Checklist

- [ ] All 9 sections present
- [ ] Every color: Semantic Name (`#hex`) + functional role
- [ ] Typography: full hierarchy table (size, weight, line-height, letter-spacing)
- [ ] Components: hover/focus states + transition timing included
- [ ] Do's/Don'ts: specific examples with reasoning (not generic)
- [ ] Agent Prompt Guide: at least 3 ready-to-use section prompts

## References
- **`references/design-md-schema.md`** -- 9-section DESIGN.md template and writing standards
- **`references/stripe.md`** -- Stripe design system (premium fintech, light theme)
- **`references/vercel.md`** -- Vercel design system (monochrome minimal, developer tools)
- **`references/linear.md`** -- Linear design system (dark-mode-first, indigo accent)
- **`references/supabase.md`** -- Supabase design system (dark terminal, emerald green)
- **`references/apple.md`** -- Apple design system (cinematic binary, product hero)

## Rationalizations

The following table captures common excuses agents make to skip the rigor of this skill, paired with factual rebuttals.

| Excuse | Rebuttal |
|--------|----------|
| "we do not need a design system yet" | inconsistency compounds fast — the cost of starting one at scale is 10x the cost at day one |
| "designers will just Figma it" | Figma without tokens means visual drift between design and code — tokens are the contract |
| "one-off components are faster" | every one-off is a future migration — build reusable or justify the exception in writing |
| "dark mode is a post-launch polish" | retrofit dark mode = rewriting color math everywhere; bake semantic tokens in from the start |
| "accessibility is a QA issue" | a11y is an architecture issue — color contrast and focus order are baked in at the token level |
