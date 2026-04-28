# Pipeline Stages — Per-Stage Checklists and File Formats

This reference defines the exact shape of each stage artifact. The content-pipeline SKILL.md is the plan; this file is the contract.

---

## Stage 1 — Raw Capture

**Artifact**: `content/<slug>/rawnotes.md`

### Checklist

- [ ] Topic stated in one sentence
- [ ] Target audience named with role and seniority
- [ ] Purpose declared (inform, persuade, convert, recruit, document)
- [ ] Target word count set as a range, not a single number
- [ ] Deadline recorded if supplied; otherwise `none`
- [ ] Draft type pre-selected if the user asked for it; otherwise `undecided`
- [ ] All user-supplied references pasted verbatim with attribution

### File Format

```markdown
# Raw Notes: <slug>

## Topic
<one sentence>

## Audience
<role>, <seniority>, <pain point>

## Purpose
<inform | persuade | convert | recruit | document>

## Target Length
<low>–<high> words

## Deadline
<date or "none">

## Draft Type (pre-select)
<long-form-writing | case-study | column-editorial | thought-leadership | interview-storytelling | undecided>

## User-Supplied References
- <source 1 verbatim>
- <source 2 verbatim>

## Gaps Flagged
- <field that was missing, if any>
```

### Failure Handling

Any required field missing → stop and ask the user. Do not infer the audience, purpose, or length.

---

## Stage 2 — Theme Extraction

**Artifact**: `content/<slug>/theme-brief.md`

### Checklist

- [ ] Exactly one angle stated as a single sentence
- [ ] Hypothesis phrased as a declarative claim the draft will defend
- [ ] Persona block: name, role, pain, prior belief, success state
- [ ] Forbidden topics list (optional but recommended)
- [ ] Candidate angles considered and rejected are logged at the bottom

### File Format

```markdown
# Theme Brief: <slug>

## Angle (single sentence — this is the anchor for every later stage)
<angle>

## Hypothesis
<claim the draft will defend>

## Persona
- Name: <label>
- Role: <role>
- Pain: <specific pain point>
- Prior belief: <what they currently think>
- Success state: <what changes after reading>

## Forbidden Topics
- <topic to avoid>

## Candidate Angles Rejected
| Angle | Reason Rejected |
|---|---|
| <candidate> | <why> |
```

### Branch Flags

If the user supplied a theme brief, copy it in verbatim and add:

```markdown
## Branch Flag
skipped:user-provided
```

---

## Stage 3 — Research

**Artifact**: `content/<slug>/research-brief.md`

### Checklist

- [ ] 8+ cited facts listed
- [ ] Every URL opened and confirmed to resolve
- [ ] Every source date-stamped in-line (year minimum)
- [ ] No source is a summary-of-a-summary; primary or secondary only
- [ ] At least 2 sources are named experts or canonical references
- [ ] Competitive angle noted (who has said this before, how yours differs)

### File Format

```markdown
# Research Brief: <slug>

## Angle Anchor (copied from theme-brief)
<angle>

## Cited Facts
| # | Claim | Source | Year | URL | Verified |
|---|---|---|---|---|---|
| 1 | <claim> | <source name> | <year> | <url> | yes |
| 2 | <claim> | <source name> | <year> | <url> | yes |

## Competitive Landscape
- Who has covered this: <list>
- How this angle differs: <one paragraph>

## Quotable Experts
- <name, affiliation, relevance>

## Gaps
- <claims we could not source; the draft must not depend on these>
```

### Branch Flags

- Merged with Stage 2: add `## Branch Flag\nmerged:stage-2-3` at the top
- Evidence-light column: minimum drops to 3 sources; add `## Branch Flag\nevidence-light:column-editorial`

---

## Stage 4 — Long-Form Draft

**Artifact**: `content/<slug>/draft.md`

### Checklist

- [ ] Draft type declared in a front comment
- [ ] Every hard rule of the chosen type skill is met
- [ ] Angle anchor from theme-brief is quoted in the agent's working preamble (not in the draft body)
- [ ] Every cited fact from research-brief that is used links to its source in-line
- [ ] H1 length within the type's specification
- [ ] Answer-first lead (for long-form-writing) or opening hook (other types) meets word count
- [ ] No unsourced statistic; if the stat is not in research-brief, it does not appear in the draft

### File Format

```markdown
<!-- draft-type: <long-form-writing|case-study|column-editorial|thought-leadership|interview-storytelling> -->
<!-- angle: <quoted from theme-brief.md> -->

# <H1>

<answer-first lead or hook block>

## <H2 #1>
<body>

## <H2 #2>
<body>

[continue per the type skill's structural template]
```

### Retry Rules

- Angle drift detected in review → restart the draft, do not patch
- Type mismatch detected → restart; type change is not an edit
- Sentence or paragraph discipline violated in more than 20% of blocks → rewrite the offending sections

---

## Stage 4.5 — Voice Drift Check

**Artifact**: appended to `content/<slug>/quality-report.md`

### Checklist

- [ ] voice-reference loaded
- [ ] ai-slop-reviewer run against draft.md
- [ ] Drift percentage recorded
- [ ] Triage decision recorded per the SKILL.md table

### File Format (section)

```markdown
## Voice Drift
- Reference: <voice-reference path or label>
- Drift: <pct>%
- Triage: <proceed | minor | major | restart>
- Notes: <one paragraph>
```

---

## Stage 5 — Quality Gate and Fan-Out

**Gate artifact**: `content/<slug>/quality-report.md`
**Publish artifact**: `content/<slug>/publish-ready.md`
**Variants**: `content/<slug>/variants/*`

### Gate Checklist

- [ ] Rubric score calculated with long-form-quality-rubric
- [ ] Verdict logged (publish-ready, minor edits, major rewrite, reject)
- [ ] Per-criterion scores recorded so revisions can be targeted
- [ ] publish-ready.md is a clean copy of the final draft, not a diff

### Quality Report Format

```markdown
# Quality Report: <slug>

## Rubric
| Criterion | Score | Notes |
|---|---|---|
| Answer-first lead | /10 | |
| H2 ratio | /10 | |
| Citable passages | /10 | |
| Source integrity | /10 | |
| Sentence discipline | /10 | |
| Paragraph discipline | /10 | |
| Hook frame | /10 | |
| Link policy | /10 | |
| Voice fit | /10 | |
| Angle adherence | /10 | |
| **Total** | **/100** | |

## Verdict
<publish-ready | minor edits | major rewrite | reject>

## Required Revisions (if not publish-ready)
- <specific edit tied to a criterion>
```

### Fan-Out Checklist

- [ ] Publish-ready.md exists and is the source of truth
- [ ] Minimum channels emitted: LinkedIn long-form, Twitter/X thread, newsletter
- [ ] Each variant links back to publish-ready.md
- [ ] meta.json generated if the brief includes SEO
- [ ] Podcast outline generated only if the brief asks

### Variant File Formats

**variants/linkedin.md**
```markdown
<!-- source: ../publish-ready.md -->
<!-- channel: linkedin-long-form -->

<1,200-1,800 word post, native LinkedIn formatting>
```

**variants/twitter-thread.md**
```markdown
<!-- source: ../publish-ready.md -->
<!-- channel: twitter-thread -->

1/ <opening tweet>
2/ <idea>
...
N/ <CTA>
```

**variants/newsletter.md**
```markdown
<!-- source: ../publish-ready.md -->
<!-- channel: newsletter -->
Subject A: <option 1>
Subject B: <option 2>
Preheader: <text>

<400-600 word email body>
```

**variants/meta.json**
```json
{
  "title": "<55-65 chars>",
  "description": "<150-160 chars>",
  "primary_keyword": "<kw>",
  "faq_schema": [
    { "question": "<Q>", "answer": "<A, 40-60 words>" }
  ]
}
```

---

## Cross-Stage Rules

| Rule | Applies To |
|---|---|
| Angle quoted verbatim in every downstream artifact preamble | Stages 3, 4, 5 |
| No new facts introduced outside research-brief | Stage 4 onward |
| No retroactive editing of earlier artifacts after the next stage begins | All stages |
| Branch flags logged at the top of the artifact they affect | Stages 2, 3, 5 |
| Retry increments a `run-N` suffix on the artifact so history is preserved | All stages |
