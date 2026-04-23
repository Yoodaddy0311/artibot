---
context: fork
name: content-pipeline
description: "Orchestration plan for a five-stage long-form content pipeline (raw capture → theme extraction → research → draft → quality gate and fan-out). Defines each stage's input, output, success criteria, and retry rules so a content-marketer agent can chain the existing writing, research, and distribution skills deterministically. Use when user asks about content pipeline, production workflow, blog production line, multichannel fan-out, editorial workflow, 콘텐츠 파이프라인, 장문 워크플로, 블로그 제작 라인, or 멀티채널 확산."
platforms: [claude-code, gemini-cli, codex-cli, cursor]
level: 4
triggers:
  - "content pipeline"
  - "content production"
  - "editorial workflow"
  - "blog production"
  - "long-form workflow"
  - "multichannel fan-out"
  - "content orchestration"
  - "publish pipeline"
  - "콘텐츠 파이프라인"
  - "장문 워크플로"
  - "블로그 제작 라인"
  - "편집 워크플로"
  - "멀티채널 확산"
agents:
  - "content-marketer"
  - "long-form-writer"
tokens: "~5K"
category: "marketing"
---

# Content Pipeline

## When This Skill Applies

- Producing a long-form article that must ship across blog, newsletter, LinkedIn, and Twitter from one source
- Coordinating research, drafting, and fan-out when more than one writing skill is in play
- Any brief where the user supplies raw notes and expects publish-ready assets at the end
- Retrofitting an existing draft into the five-stage flow because quality drifted
- Any request that mentions "end-to-end", "full workflow", "pipeline", or "production line" for content

This skill is a plan, not an executor. The content-marketer or long-form-writer agent runs each stage using the skills listed in the Stage Table.

## Core Guidance

### 1. Stage Table

| Stage | Name | Input | Output File | Success Criteria | Owning Skills |
|---|---|---|---|---|---|
| 1 | Raw capture | User notes, references, brief | rawnotes.md | Topic, audience, purpose, target length all stated | — |
| 2 | Theme extraction | rawnotes.md | theme-brief.md | One angle, one hypothesis, one audience persona | marketing-strategy, seo-strategy |
| 3 | Research | theme-brief.md | research-brief.md | 8+ sources with URLs, each cite-ready, date-stamped | market-research, technical-seo, aeo-geo-2026 |
| 4 | Long-form draft | research-brief.md | draft.md | All rules of the chosen type skill followed in full | long-form-writing or case-study or column-editorial or thought-leadership or interview-storytelling |
| 5 | Quality gate + fan-out | draft.md | publish-ready.md + variants/*.md | Rubric score 90+, N platform variants emitted | ai-slop-reviewer, long-form-quality-rubric, social-media, email-marketing |

The pipeline is sequential by default. Parallelism is allowed only where the Branch Logic section explicitly permits it.

### 2. Stage 1 — Raw Capture

| Field | Specification |
|---|---|
| Purpose | Freeze the input so later stages have a stable source of truth |
| Required fields | topic, target audience, purpose of the piece, target word count, deadline if any, draft type |
| Output location | `content/<slug>/rawnotes.md` |
| Failure mode | Any required field blank → stop and ask the user, do not synthesize |
| Retry rule | Never retry silently; a missing field fails the whole pipeline |

The agent does not write prose in this stage. It only records what the user supplied verbatim and flags gaps.

### 3. Stage 2 — Theme Extraction

| Field | Specification |
|---|---|
| Input | rawnotes.md from Stage 1 |
| Output | theme-brief.md with angle, hypothesis, persona, forbidden topics |
| Success | Exactly one angle (not a menu), hypothesis phrased as a claim, persona named with role and pain |
| Skills applied | marketing-strategy for positioning, seo-strategy for query intent |
| Retry rule | If angle splits into 2+, force the agent to pick one and log the discards in the brief |
| Skip condition | User supplied a finished theme brief → skip this stage and label it `skipped:user-provided` |

Angle drift is the most common failure. The agent must quote the exact angle sentence in every later stage's preamble so the draft cannot wander.

### 4. Stage 3 — Research

| Field | Specification |
|---|---|
| Input | theme-brief.md |
| Output | research-brief.md with 8+ cited facts |
| Source format | `[claim] — [source name, year] — [URL] — [verified:yes/no]` |
| Success | 8+ sources, every URL resolves, no source dated older than 36 months unless it is a primary canonical reference |
| Skills applied | market-research for competitive context, technical-seo for query landscape, aeo-geo-2026 for citability angles |
| Retry rule | Fewer than 8 sources → extend the research pass once; still short → downgrade target word count proportionally rather than pad |
| Skip condition | Rarely; only when the piece is an opinion column with a declared evidence-light posture |

Stages 2 and 3 may be merged into one pass when the brief is under 1,000 words and the angle is obvious. This merge must be logged as `merged:stage-2-3` in the brief.

### 5. Stage 4 — Long-Form Draft

| Field | Specification |
|---|---|
| Input | research-brief.md |
| Output | draft.md written end-to-end |
| Type selection | Pick exactly one: long-form-writing, case-study, column-editorial, thought-leadership, interview-storytelling |
| Success | Every hard rule in the chosen skill met (answer-first lead, citable passages, H2 ratio, sentence discipline, etc.) |
| Retry rule | Drift from the Stage 2 angle → restart the draft, do not patch |
| Skip condition | Never skipped |

Type selection is made once and logged. Switching type mid-draft is an anti-pattern; it forces a Stage 4 restart.

### 6. Stage 4.5 — Voice Drift Check

This is an integration point, not a full stage. Before the quality gate, the agent runs ai-slop-reviewer with voice-reference loaded. Drift output is triaged:

| Drift Level | Action |
|---|---|
| 0-5% from voice reference | Proceed to Stage 5 |
| 6-15% | Minor rewrite pass, stay in Stage 4 |
| 16-30% | Major rewrite, restart Stage 4 |
| 31%+ | Restart from Stage 2; the angle itself is likely off-voice |

### 7. Stage 5 — Quality Gate and Fan-Out

Quality gate runs first. Fan-out runs only if the gate passes.

| Rubric Score | Verdict | Next Action |
|---|---|---|
| 90-100 | Publish-ready | Proceed to fan-out |
| 75-89 | Minor edits | Return to Stage 4 with specific edit notes; one revision pass allowed |
| 60-74 | Major rewrite | Restart Stage 4 from the same research brief |
| < 60 | Reject | Restart from Stage 2; the premise is broken |

Fan-out produces one file per channel under `content/<slug>/variants/`. The source of truth stays `publish-ready.md`; variants are derivatives and must link back.

### 8. Fan-Out Matrix

| Channel | Derived From | Skill | Output |
|---|---|---|---|
| LinkedIn long-form | Full draft | social-media | 1,200-1,800 word post with native formatting |
| Twitter/X thread | Citable passages | social-media | 6-10 tweet thread, one idea per tweet |
| Newsletter | Answer-first lead + top 2 citable passages | email-marketing | 400-600 word email with subject A/B |
| Podcast Q&A outline | Question H2s | — | Host prompt list with timestamps target |
| SEO meta + schema | Title, meta, FAQ H2s | aeo-geo-2026 + technical-seo | meta.json with title, description, FAQ schema |

N variants is brief-specific. Minimum default: LinkedIn + Twitter + newsletter. Podcast and schema are optional unless the brief asks.

### 9. Branch Logic

| Condition | Branch |
|---|---|
| User supplies theme brief already | Skip Stage 2, label `skipped:user-provided` |
| Piece under 1,000 words and angle obvious | Merge Stages 2 and 3, label `merged:stage-2-3` |
| Opinion column with declared evidence-light posture | Stage 3 minimum drops to 3 sources; type must be column-editorial |
| Interview feature | Stage 3 shifts from market research to transcript clean-up; type is interview-storytelling |
| Fan-out disabled by brief | Stage 5 runs quality gate only; no variants emitted |

### 10. Output Contract

Each pipeline run produces this directory layout. The agent must create every file listed unless a Branch Logic rule excuses it.

```
content/<slug>/
├── rawnotes.md
├── theme-brief.md
├── research-brief.md
├── draft.md
├── publish-ready.md
├── quality-report.md
└── variants/
    ├── linkedin.md
    ├── twitter-thread.md
    ├── newsletter.md
    ├── meta.json
    └── podcast-outline.md   (optional)
```

## Output Format

```
PIPELINE RUN
============
Slug:          [content slug]
Draft type:    [long-form-writing | case-study | column-editorial | thought-leadership | interview-storytelling]
Angle:         [one sentence, quoted from theme-brief.md]
Audience:      [persona name and role]

STAGE LEDGER
────────────
| # | Stage              | Status              | Artifact                 |
|---|--------------------|---------------------|--------------------------|
| 1 | Raw capture        | done                | rawnotes.md              |
| 2 | Theme extraction   | done                | theme-brief.md           |
| 3 | Research           | done                | research-brief.md        |
| 4 | Draft              | done                | draft.md                 |
| 4.5 | Voice drift      | [pct]% drift        | —                        |
| 5 | Quality + fan-out  | [rubric score]      | publish-ready.md + N var |

FAN-OUT
───────
| Channel   | File                         | Status |
|-----------|------------------------------|--------|
| LinkedIn  | variants/linkedin.md         | done   |
| Twitter   | variants/twitter-thread.md   | done   |
| Newsletter| variants/newsletter.md       | done   |
| Meta      | variants/meta.json           | done   |
```

## Quick Reference

**Stages**: raw capture → theme extraction → research → draft → quality + fan-out
**Sequential by default**: parallelism only where Branch Logic allows
**Quality bar**: 90+ rubric for publish-ready; below that, specific retry rules apply
**Voice drift triage**: 0-5 pass, 6-15 minor, 16-30 major, 31+ restart from Stage 2
**Minimum fan-out**: LinkedIn + Twitter + newsletter
**Source of truth**: publish-ready.md; variants are derivatives and link back

## Anti-Patterns

- Do NOT skip a stage without logging the Branch Logic rule that permits it
- Do NOT run Stages 2 through 4 in parallel; angle drift compounds across stages
- Do NOT fan out before the rubric score clears 90
- Do NOT patch a draft that failed Stage 4.5 with 16%+ drift; restart the draft
- Do NOT switch draft type mid-Stage-4; that is a Stage 4 restart, not an edit
- Do NOT pad a short research brief to hit 8 sources; downgrade word count instead
- Do NOT treat variants as the canonical output; publish-ready.md is the source

---

## References

- See `${CLAUDE_SKILL_DIR}/references/pipeline-stages.md` for per-stage checklists and file format contracts
- See `${CLAUDE_SKILL_DIR}/../long-form-writing/SKILL.md` for Stage 4 long-form rules
- See `${CLAUDE_SKILL_DIR}/../ai-slop-reviewer/SKILL.md` for Stage 4.5 drift scoring
- See `${CLAUDE_SKILL_DIR}/../social-media/SKILL.md` and `${CLAUDE_SKILL_DIR}/../email-marketing/SKILL.md` for Stage 5 fan-out
