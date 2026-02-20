---
description: Presentation structure design with narrative flow, slide layouts, speaker notes, and visual recommendations
argument-hint: '[topic] e.g. "투자 피치덱 20장 구성"'
allowed-tools: [Read, Write, Glob, Grep, Task, WebSearch, TaskCreate]
---

# /ppt

Designs complete presentation structures including narrative arc, slide-by-slide content, visual layout recommendations, speaker notes, and data visualization suggestions. Outputs structured slide decks as Markdown or exportable formats.

## Arguments

Parse $ARGUMENTS:
- `topic`: Presentation topic or brief
- `--type [kind]`: Presentation type - `pitch` | `report` | `workshop` | `keynote` | `sales` | `training` | `review`
- `--slides [n]`: Target slide count (default: 10-15)
- `--audience [who]`: Target audience - `executive` | `technical` | `investor` | `customer` | `internal` | `general`
- `--style [design]`: Visual style - `corporate` | `modern` | `minimal` | `bold` | `data-heavy`
- `--include-notes`: Generate speaker notes per slide
- `--data [source]`: Data source file for charts/visualizations
- `--duration [min]`: Presentation duration in minutes (auto-calculates pacing)

## Narrative Arcs by Type

| Type | Arc Structure |
|------|---------------|
| pitch | Problem -> Solution -> Market -> Traction -> Team -> Ask |
| report | Executive Summary -> Key Metrics -> Deep Dives -> Recommendations -> Next Steps |
| workshop | Learning Objectives -> Concept -> Demo -> Exercise -> Recap |
| keynote | Hook -> Vision -> Evidence -> Call to Action |
| sales | Pain Point -> Solution -> Proof -> Pricing -> Close |
| training | Objectives -> Theory -> Practice -> Assessment -> Resources |
| review | Context -> Results -> Analysis -> Learnings -> Next Steps |

## Agent Delegation

- Primary: `presentation-designer` - Slide structure and narrative design
- Supporting: `content-marketer` - Content creation and messaging
- Supporting: `data-analyst` - Data visualization recommendations

## Skills Required

- `presentation-design` - Slide structure, narrative arc, visual hierarchy
- `data-visualization` - Chart selection, data storytelling, visual encoding
- `copywriting` - Headlines, bullet points, compelling narratives

## Execution Flow

1. **Parse**: Extract topic, audience level, type, constraints
2. **Research**: Gather supporting data and examples via WebSearch
3. **Structure**: Design narrative arc based on presentation type
4. **Design Slides**: For each slide:
   - Headline (max 8 words)
   - Body content (bullet points or narrative)
   - Visual recommendation (chart type, image suggestion, layout)
   - Speaker notes (if `--include-notes`)
   - Transition to next slide
5. **Data Visualization** (if `--data`): Recommend chart types:
   - Comparison -> Bar/Column chart
   - Trend -> Line chart
   - Composition -> Pie/Stacked bar
   - Distribution -> Histogram/Scatter
   - Relationship -> Scatter/Bubble
6. **Pacing**: Calculate time per slide based on `--duration`
7. **Report**: Output complete slide deck structure

## Output Format

```
PRESENTATION DESIGN
===================
Topic:      [topic]
Type:       [pitch|report|workshop|keynote|sales|training|review]
Audience:   [target audience]
Slides:     [count]
Duration:   [minutes] ([seconds/slide] pacing)
Style:      [design style]

NARRATIVE ARC
-------------
[Opening Hook] -> [Problem/Context] -> [Solution/Content] -> [Evidence] -> [Call to Action/Close]

SLIDE DECK
----------
Slide 1: [TITLE SLIDE]
  Headline: [title]
  Subtitle: [subtitle]
  Visual: [logo, background image suggestion]
  Notes: [opening script]
  Time: [0:00 - 0:30]

Slide 2: [SECTION NAME]
  Headline: [max 8 words]
  Content:
    - [bullet point 1]
    - [bullet point 2]
    - [bullet point 3]
  Visual: [chart type / image / diagram recommendation]
  Notes: [speaker notes]
  Transition: [bridge to next slide]
  Time: [0:30 - 2:00]

DATA VISUALIZATIONS (if --data)
-------------------------------
Slide [n]: [Chart Type] - [Data Series] - [Key Insight]

DESIGN RECOMMENDATIONS
----------------------
Color Palette: [primary, secondary, accent]
Font Pairing:  [headline font] / [body font]
Layout Grid:   [grid description]
```

## Example Usage

```
/ppt "Q1 Marketing Results" --type report --audience executive --slides 12 --include-notes --duration 20
/ppt "Series A Pitch Deck" --type pitch --audience investor --slides 10 --style modern
/ppt "Developer Onboarding" --type workshop --audience technical --duration 60 --include-notes
/ppt "Product Launch" --type keynote --audience customer --style bold
```
