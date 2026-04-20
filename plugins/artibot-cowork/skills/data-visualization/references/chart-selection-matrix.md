# Chart Selection Matrix

**Core Principle**: Data relationship type determines visualization. Match intent (compare, trend, compose, distribute, relate) to chart type before designing aesthetics.

## Data Relationship to Chart Type

| Relationship | Question | Chart Type | When to Use | Avoid When |
|--------------|----------|-----------|-------------|-----------|
| Comparison | Which is bigger? | Bar (horizontal better) | 2-7 categories | >10 categories (use table) |
| Composition | What's the mix? | Pie/Donut (% sum=100) | 2-5 slices | >5 slices, small differences |
| Trend | How does it change? | Line (time on x-axis) | 3+ time periods | Categorical data, <3 points |
| Distribution | How spread? | Histogram/Density | Continuous data, n>100 | Discrete counts, n<50 |
| Relationship | Does X predict Y? | Scatter with trend line | Correlation explore | Categorical data pairs |
| Part-to-Whole | What % of total? | Stacked bar/area | Composition over time | >5 segments, overlapping |

## Visual Encoding Rules

| Data Type | Encode With | Strength | Example |
|-----------|-------------|----------|---------|
| Quantitative | Position, Length | Highest accuracy | Bar height = revenue |
| Ordinal | Color intensity | Medium | Light→Dark = Low→High |
| Categorical | Color (distinct) | Good for ≤5 | Red=US, Blue=EU, Green=APAC |
| Temporal | X-axis position | Clearest | Time flows left→right |

## Anti-Pattern Reference

| Anti-Pattern | Why Avoid | Fix |
|--------------|-----------|-----|
| 3D pie charts | Depth distorts angle perception | Use 2D bar instead |
| Pie with >5 slices | Angle comparison is imprecise | Use bar or table |
| Dual y-axis (different units) | Scales mislead viewers | Separate by metric |
| Truncated axes (not zero-based) | Magnifies small differences | Start at 0 or show clearly |
| Rainbow color scales | Not colorblind friendly | Use sequential or perceptually uniform |
| Line for categorical data | Implies continuous ordering | Use bar for categories |

## Implementation Checklist

- [ ] Identify primary question (compare, trend, compose, distribute, or relate)
- [ ] Select base chart type from matrix above
- [ ] Verify data meets requirements (categories, time points, sample size)
- [ ] Apply color consistently (max 5 hues for categorical, sequential for quantitative)
- [ ] Add axis labels with units (not just "Revenue" but "Revenue (USD)")
- [ ] Include reference lines (targets, prior period average)
- [ ] Remove chart junk (gridlines if <5 data points, unnecessary borders)
- [ ] Test colorblind rendering (use tools: colorhexa.com, accessible-colors.com)
