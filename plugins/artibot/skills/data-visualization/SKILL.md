---
context: fork
name: data-visualization
description: "Guides data visualization with chart selection, dashboard layout design, visual encoding, and data storytelling best practices. Use when user asks about data visualization, chart selection, graph design, dashboard layout, infographic, data storytelling, 데이터 시각화, 차트, 대시보드, or 그래프."
platforms: [claude-code, gemini-cli, codex-cli, cursor]
level: 3
triggers:
  - "visualization"
  - "chart"
  - "graph"
  - "dashboard"
  - "data viz"
  - "report visualization"
agents:
  - "frontend-developer"
  - "code-reviewer"
tokens: "~3K"
category: "analysis"
source_hash: df38d037
---

# Data Visualization

## When This Skill Applies
- Selecting appropriate chart types for data presentations
- Designing dashboard layouts for marketing reports
- Creating visual data stories for stakeholders
- Recommending visual encoding for different data types
- Building infographics and data-heavy presentations

## Core Guidance

### 1. Chart Selection Matrix

| Data Relationship | Chart Types | When to Use |
|-------------------|------------|-------------|
| Comparison | Bar, Column, Grouped Bar | Compare values across categories |
| Trend over Time | Line, Area, Sparkline | Show changes over time periods |
| Composition | Pie, Stacked Bar, Treemap | Show parts of a whole |
| Distribution | Histogram, Box Plot, Violin | Show data spread and outliers |
| Relationship | Scatter, Bubble, Heatmap | Show correlation between variables |
| Ranking | Horizontal Bar, Lollipop | Rank items by value |
| Flow | Sankey, Funnel | Show process or conversion flow |
| Geographic | Map, Choropleth | Location-based data |

### 2. Chart Selection Decision Tree

```
What are you showing?
├── Comparison between items?
│   ├── Few items (<7): Bar chart
│   └── Many items (7+): Horizontal bar
├── Change over time?
│   ├── Few series (<4): Line chart
│   └── Cumulative: Stacked area
├── Parts of a whole?
│   ├── Few parts (<6): Pie / Donut
│   └── Many parts: Treemap
├── Distribution?
│   ├── One variable: Histogram
│   └── Comparison: Box plot
├── Relationship?
│   ├── Two variables: Scatter
│   └── Three variables: Bubble
└── Flow/Process?
    ├── Conversion: Funnel
    └── Multi-path: Sankey
```

### 3. Dashboard Design Principles

| Principle | Rule | Rationale |
|-----------|------|-----------|
| Hierarchy | Most important KPIs at top-left | Eye tracking: Z-pattern reading |
| Density | 5-9 widgets per dashboard | Cognitive load management |
| Grouping | Related metrics together | Gestalt proximity principle |
| Context | Always show comparisons/targets | Numbers alone lack meaning |
| Filtering | Global filters at top | Consistent data context |
| Color | Consistent meaning across charts | Red=bad, Green=good, Gray=neutral |

### 4. Dashboard Layout Templates

#### Executive Dashboard (5-7 widgets)
```
[KPI Card 1] [KPI Card 2] [KPI Card 3] [KPI Card 4]
[    Trend Line Chart (primary metric over time)     ]
[  Comparison Bar     ] [  Composition Pie/Donut     ]
```

#### Performance Dashboard (7-9 widgets)
```
[KPI 1] [KPI 2] [KPI 3] [KPI 4] [KPI 5]
[  Channel Performance Table               ]
[  Trend Line      ] [  Funnel Diagram     ]
[  Geo Map         ] [  Top Performers Bar ]
```

### 5. Visual Encoding Best Practices

| Data Type | Encoding | Example |
|-----------|----------|---------|
| Quantitative | Position, length, area | Bar height, line position |
| Categorical | Color hue, shape | Category colors, marker shapes |
| Ordinal | Color saturation, size | Light-to-dark gradient |
| Temporal | X-axis position | Time series left-to-right |
| Status | Color + icon | Green check, red X |

### 6. Color Guidelines

| Purpose | Color Strategy | Example |
|---------|---------------|---------|
| Sequential | Light to dark of one hue | Revenue growth gradient |
| Diverging | Two hues from neutral center | Profit/loss (green/red) |
| Categorical | Distinct hues (max 7) | Channel comparison |
| Highlight | Gray base + accent color | Focus on key metric |
| Status | Green/yellow/red | Performance vs target |

**Accessibility**: Ensure sufficient contrast, don't rely solely on color (use patterns/labels).

### 7. Data Storytelling Framework

| Phase | Element | Purpose |
|-------|---------|---------|
| Setup | Context and background | Why this data matters |
| Rising Action | Key trends and patterns | Build understanding |
| Climax | Critical insight or finding | The "aha" moment |
| Resolution | Recommendation and action | What to do next |

**Annotation Best Practices**:
- Label outliers and inflection points
- Add context to unexpected changes
- Highlight targets and benchmarks
- Include time markers for key events

### 8. Common Anti-Patterns

| Anti-Pattern | Problem | Fix |
|-------------|---------|-----|
| 3D charts | Distorts perception | Use flat 2D charts |
| Pie with many slices | Unreadable | Bar chart or table |
| Dual y-axis | Confusing correlation | Separate charts |
| Truncated y-axis | Exaggerates differences | Start at zero |
| Rainbow colors | No hierarchy | Limit to 5-7 purposeful colors |
| Chart junk | Distracting decorations | Remove non-data elements |

## Output Format
```
VISUALIZATION RECOMMENDATION
=============================
Data:       [data description]
Audience:   [executive|analyst|technical]
Purpose:    [compare|trend|compose|distribute|relate]

CHART SELECTION
---------------
Primary:    [chart type] - [rationale]
Alternative:[chart type] - [when to prefer]

DESIGN SPECS
------------
Layout:     [dashboard position / standalone]
Colors:     [palette recommendation]
Labels:     [annotation strategy]
Filters:    [interactive filter needs]
```

## Quick Reference

**Chart Selection**: Comparison=Bar, Trend=Line, Composition=Pie, Distribution=Histogram, Relationship=Scatter
**Dashboard Density**: 5-9 widgets, most important top-left
**Color Max**: 7 categorical colors, use sequential for ordered data
**Accessibility**: Contrast, patterns, labels beyond just color

---

## References

- See `${CLAUDE_SKILL_DIR}/references/chart-selection-matrix.md` for chart selection matrix
- See `${CLAUDE_SKILL_DIR}/references/dashboard-design-principles.md` for dashboard design principles

## Rationalizations

The following table captures common excuses agents make to skip the rigor of this skill, paired with factual rebuttals.

| Excuse | Rebuttal |
|--------|----------|
| "a pie chart works for everything" | pie charts fail past three categories and for comparisons — pick the chart that matches the question |
| "color makes it pretty" | color is data encoding, not decoration — unconsidered color misleads readers |
| "I will add the axis labels later" | unlabeled charts are actively misleading; no chart is better than a mystery chart |
| "3D adds depth" | 3D distorts comparisons and hides occluded data — use 2D unless the extra dimension encodes data |
| "the default matplotlib is fine" | defaults optimize for quick iteration, not for communication — style your final output |
