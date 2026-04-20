# DESIGN.md Schema (Google Stitch Format)

A DESIGN.md captures a website's complete visual language in 9 standardized sections that any AI agent can read and apply.

Source: [awesome-design-md](https://github.com/VoltAgent/awesome-design-md) (MIT License)

---

## Required Sections

Every DESIGN.md must include all 9 sections:

### 1. Visual Theme & Atmosphere
- Evocative, specific description (never "clean and modern")
- Core fonts with OpenType features, weights, and tracking
- Shadow system philosophy
- Key characteristics list (8-12 items)

### 2. Color Palette & Roles
- Every color: **Semantic Name** (`#hex`) + functional role
- Categories: Primary, Interactive, Neutral Scale, Status, Surface
- Include hover/active state colors
- Use CSS custom property names when available (e.g., `--hds-color-heading-solid`)

### 3. Typography Rules
- Full hierarchy table:

| Element | Font | Weight | Size | Line-Height | Letter-Spacing | Color |
|---------|------|--------|------|-------------|----------------|-------|
| Hero | ... | ... | ...px | ... | ...px | #... |
| H1 | ... | ... | ...px | ... | ...px | #... |
| Body | ... | ... | ...px | ... | ...px | #... |
| Code | ... | ... | ...px | ... | ...px | #... |
| Label | ... | ... | ...px | ... | ...px | #... |

- Include font fallback stacks
- Note OpenType features enabled

### 4. Component Stylings
- Buttons: background, border, radius, padding, shadow, hover/focus/active states with transition timing
- Cards: background, border, radius, padding, shadow
- Inputs: border, radius, padding, focus ring, placeholder color
- Navigation: layout, spacing, active/hover states
- Badges/Pills: background, border-radius, padding, font-size

### 5. Layout Principles
- Content widths (max-width values)
- Grid system (columns, gap)
- Section spacing/padding patterns
- Vertical rhythm rules
- Content alignment strategy

### 6. Depth & Elevation
- Shadow definitions per elevation level
- Border techniques (solid vs shadow-as-border)
- Layering/z-index strategy
- Backdrop effects (blur, overlay)

### 7. Do's and Don'ts
- 5+ Do's with specific reasoning
- 5+ Don'ts with specific anti-pattern examples
- Common mistakes to avoid

### 8. Responsive Behavior
- Breakpoints with specific values
- Typography scaling rules per breakpoint
- Layout changes per breakpoint
- Component adaptation (stack, hide, resize)
- Touch target adjustments

### 9. Agent Prompt Guide
- Ready-to-use prompts for recreating key sections:
  - Hero section
  - Card grid
  - Navigation bar
  - Footer
  - Feature showcase
- Each prompt includes: background color, font, size, weight, spacing, colors

---

## Writing Standards

- **Every color**: Semantic Name (`#hex`) + functional role
- **Atmosphere**: Evocative and specific, never generic
- **Typography**: Full hierarchy table with size, weight, line-height, letter-spacing
- **Components**: Include hover/focus states and transition timing
- **Why, not just what**: Explain the reasoning behind design decisions

## Available References

| Reference | Style | Best For |
|-----------|-------|----------|
| `stripe.md` | Premium fintech, light theme | SaaS, dashboards, payment UIs |
| `vercel.md` | Monochrome minimal, developer tools | Dev tools, CLI products, docs |
| `linear.md` | Dark-mode-first, indigo accent | SaaS dashboards, project tools |
| `supabase.md` | Dark terminal aesthetic, emerald green | Developer platforms, open-source |
| `apple.md` | Cinematic binary (black/white), product hero | Consumer products, landing pages |
