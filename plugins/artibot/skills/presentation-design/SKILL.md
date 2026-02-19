---
name: presentation-design
description: |
  Presentation structure design with narrative arcs, slide layouts, visual hierarchy, and speaker notes.
  Covers pitch decks, reports, workshops, and keynote presentations.
  Auto-activates when: presentation design, slide structure, pitch deck, narrative arc, speaker notes.
  Triggers: presentation, slides, pitch deck, keynote, PowerPoint, ppt, slide design, deck, speaker notes, narrative arc, 프레젠테이션, 슬라이드, 발표자료, 피치덱
platforms: [claude-code, gemini-cli, codex-cli, cursor]
level: 3
triggers:
  - "presentation"
  - "slide"
  - "deck"
  - "PowerPoint"
  - "pitch deck"
  - "presentation design"
agents:
  - "presentation-designer"
  - "doc-updater"
tokens: "~3K"
category: "marketing"
---

# Presentation Design

## When This Skill Applies
- Designing presentation structures and narrative flows
- Creating slide-by-slide content with visual recommendations
- Building pitch decks, report decks, and workshop materials
- Planning data-driven presentations with chart recommendations
- Writing speaker notes and transition scripts

## Core Guidance

### 1. Presentation Design Process
```
Define Purpose -> Know Audience -> Design Narrative Arc -> Structure Slides -> Write Content -> Add Visuals -> Write Speaker Notes -> Calculate Pacing -> Review
```

### 2. Narrative Arc by Presentation Type

| Type | Arc Structure | Slides |
|------|-------------|--------|
| Pitch Deck | Problem -> Solution -> Market -> Traction -> Team -> Ask | 10-12 |
| Report | Summary -> Key Metrics -> Deep Dives -> Recommendations -> Next Steps | 12-20 |
| Workshop | Objectives -> Concept -> Demo -> Exercise -> Recap | 15-25 |
| Keynote | Hook -> Vision -> Evidence -> Call to Action | 8-15 |
| Sales Deck | Pain Point -> Solution -> Proof -> Pricing -> Close | 10-15 |
| Training | Overview -> Module 1 -> Practice -> Module 2 -> Practice -> Summary | 20-30 |
| Status Update | Progress -> Metrics -> Blockers -> Next Steps | 5-10 |

### 3. Slide Design Principles

| Principle | Rule | Rationale |
|-----------|------|-----------|
| One Idea | One key message per slide | Focus and retention |
| Headline | 8 words max in title | Scannable takeaway |
| Content | 3-5 bullet points max | Cognitive load limit |
| Visual | 60% visual, 40% text | Visual processing faster |
| Contrast | Dark text on light or vice versa | Readability |
| White Space | 30%+ empty space | Breathing room |

### 4. Slide Types and Templates

| Slide Type | Layout | When to Use |
|-----------|--------|-------------|
| Title Slide | Center-aligned, bold title + subtitle | Opening, section breaks |
| Statement | Large centered text (1 sentence) | Key message, transition |
| Content | Headline + 3-5 bullets | Information delivery |
| Two-Column | Split layout with comparison | Before/after, pros/cons |
| Data/Chart | Headline + single chart | Data-driven insights |
| Image + Text | Full image with text overlay | Emotional impact |
| Quote | Large quote + attribution | Social proof, inspiration |
| Process | Flow diagram or steps | Sequential information |
| Team/Profile | Photo grid with bios | People introduction |
| CTA/Close | Action item + contact info | Final call to action |

### 5. Pacing Guidelines

| Duration | Slides | Time/Slide | Style |
|----------|--------|-----------|-------|
| 5 min | 5-7 | 45-60s | Quick hits, key points only |
| 15 min | 10-15 | 60-90s | Standard business presentation |
| 30 min | 15-25 | 75-120s | Detailed with discussion |
| 60 min | 25-40 | 90-150s | Workshop/training with exercises |

### 6. Visual Hierarchy

| Level | Element | Treatment |
|-------|---------|-----------|
| 1 | Slide headline | Largest, bold, top position |
| 2 | Key data point | Large number, accent color |
| 3 | Supporting bullets | Medium size, regular weight |
| 4 | Source/footnote | Small, muted color |

### 7. Speaker Notes Structure

```
Slide [n]: [Slide Title]
Opening:    [How to introduce this slide - first sentence]
Key Points: [Main talking points to cover]
Data Note:  [Context for any data shown]
Transition: [Bridge sentence to next slide]
Time:       [Target time for this slide]
```

### 8. Design Recommendations

**Color Palette**:
- Primary: Brand color for headers and key elements
- Secondary: Complementary for data and accents
- Neutral: Gray scale for body text and backgrounds
- Accent: Highlight color for CTAs and emphasis

**Font Pairing**:
- Headlines: Sans-serif, bold (e.g., Montserrat, Inter, Poppins)
- Body: Sans-serif, regular (same family or complementary)
- Data: Monospace for numbers (optional)

**Layout Grid**:
- 12-column grid for alignment
- Consistent margins (40-60px from edges)
- Consistent spacing between elements

## Output Format
```
PRESENTATION DESIGN
===================
Topic:      [topic]
Type:       [pitch|report|workshop|keynote|sales|training]
Audience:   [target audience]
Slides:     [count]
Duration:   [minutes]

NARRATIVE ARC
-------------
[Phase 1] -> [Phase 2] -> [Phase 3] -> [Phase 4]

SLIDE DECK
----------
Slide [n]: [TYPE]
  Headline: [max 8 words]
  Content:  [body content]
  Visual:   [chart/image/diagram recommendation]
  Notes:    [speaker notes]
  Time:     [start - end]

DESIGN SPECS
------------
Color Palette: [primary, secondary, accent]
Font Pairing:  [headline] / [body]
```

## Quick Reference

**Slide Rule**: One idea per slide, 8-word headline max, 3-5 bullets max
**Pacing**: 60-90 seconds per slide for standard presentations
**Visual Ratio**: 60% visual, 40% text
**Types**: pitch, report, workshop, keynote, sales, training, status

See `references/slide-templates.md` for slide structure templates by type.
See `references/chart-patterns.md` for data visualization in presentations.
