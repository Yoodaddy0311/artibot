---
context: fork
name: voice-reference
description: "Stores a static voice profile and 2-3 past writing samples so long-form-writing, case-study, column-editorial, thought-leadership, interview-storytelling, and ai-slop-reviewer can measure tone consistency and detect drift. Provides NNGroup 4-dimension voice calibration plus brand-voice axes. Use when user asks about voice profile, tone calibration, brand voice, voice reference, writing sample anchor, 보이스 프로필, 톤 캘리브레이션, 문체 기준, 브랜드 보이스, or 글 샘플 앵커."
platforms: [claude-code, gemini-cli, codex-cli, cursor]
level: 3
triggers:
  - "voice profile"
  - "voice reference"
  - "tone calibration"
  - "brand voice"
  - "writing voice"
  - "voice drift"
  - "voice anchor"
  - "보이스 프로필"
  - "톤 캘리브레이션"
  - "문체 기준"
  - "브랜드 보이스"
  - "글 샘플 앵커"
agents:
  - "content-marketer"
  - "doc-updater"
tokens: "~3K"
category: "marketing"
depends_on: []
suggests:
  - ai-slop-reviewer
---

# Voice Reference

## When This Skill Applies

- Setting up the writing skillset for the first time on a new project or brand
- Onboarding a new author whose voice must align with an existing body of work
- Formalizing a brand voice that has lived only in editors' heads until now
- Investigating suspected tone drift across recent outputs
- Providing a calibration anchor so `ai-slop-reviewer` can detect voice deviation rather than only generic slop

## Core Guidance

### 1. What Voice Reference Does

Voice reference is a static, user-maintained set of files. It is not a model, not a database, and not a live feed. Two artifacts sit under `references/`:

| File | Role |
|------|------|
| `voice-profile-template.md` | Declared voice: axis placements, signature moves, vocabulary lists |
| `writing-samples-scaffold.md` | Demonstrated voice: 2-3 past pieces the author has written |

Writing skills and the slop reviewer read these files as context when they run. No network calls, no external embeddings.

### 2. Calibration Protocol

Three stages, run once per author or brand and refreshed every 6-12 months.

#### Stage 1 — Sample Collection

Select 2-3 past pieces. Quality of selection matters more than quantity.

| Criterion | Requirement |
|-----------|-------------|
| Representativeness | Each sample shows the voice in a mode the author actually uses |
| Variety | Cover at least two distinct formats (e.g., long-form + short post) |
| Recency | At least one sample within the past 12 months |
| Authenticity | Every sample is the author's own writing, not AI-generated, not heavily ghost-edited |
| Publication state | Final published version, not drafts |

#### Stage 2 — Profile Extraction

Read the samples and place the voice on axes. Use both frameworks.

**NNGroup 4-Dimension Voice** (public standard; four independent axes):

| Axis | Scale | Meaning |
|------|-------|---------|
| Humor | Funny ↔ Serious | Wordplay and light self-deprecation vs. straight delivery |
| Formality | Formal ↔ Casual | Full terms and complete sentences vs. contractions and fragments |
| Respect | Respectful ↔ Irreverent | Assumed good faith vs. willingness to provoke |
| Enthusiasm | Enthusiastic ↔ Matter-of-fact | Emphatic word choice vs. data-forward neutrality |

Each axis is scored from -2 to +2:

| Score | Placement |
|-------|-----------|
| -2 | Strong anchor A (e.g., very funny) |
| -1 | Leans toward anchor A |
| 0 | Balanced or context-dependent |
| +1 | Leans toward anchor B |
| +2 | Strong anchor B (e.g., very serious) |

**Brand Voice Additional Axes**: NNGroup covers feel, but brand-level voice needs structural axes too.

| Axis | Definition | Example |
|------|-----------|---------|
| Authority level | How much expertise the writer claims | Cautious explainer vs. opinionated insider |
| Warmth | Emotional proximity to the reader | Clinical distance vs. first-name-basis warmth |
| Technicality | Depth of field-specific detail | Plain-language framing vs. code and jargon |
| Formality of terminology | Preference for precise vs. everyday terms | "Customer acquisition cost" vs. "what new users cost" |
| Conviction | Strength of stated positions | Hedged survey vs. sharp claim with stakes |
| Humor frequency | How often humor shows up | Rare grace note vs. humor every few paragraphs |

#### Stage 3 — Integration

Each writing skill that runs should read the two reference files as context before producing output.

| Skill | How It Uses Voice Reference |
|-------|-----------------------------|
| `long-form-writing` | Matches answer-first lead tone to declared voice; hook frame choice respects humor-frequency axis |
| `case-study` | Adjusts Challenge/Lessons tone; chooses matter-of-fact vs. enthusiastic for Results |
| `column-editorial` | Calibrates conviction axis directly; opinion strength must match declared level |
| `thought-leadership` | Authority-level axis governs hedging and claim sharpness |
| `interview-storytelling` | Voice profile governs the writer's framing text; interviewee quotes preserve their own voice |

Injection pattern (pseudo-workflow, user-manual, no external calls):
```
Before running long-form-writing:
  1. Read voice-reference/references/voice-profile-template.md
  2. Read voice-reference/references/writing-samples-scaffold.md
  3. Pass both as context alongside the writing brief
```

### 3. ai-slop-reviewer Integration

The slop reviewer behaves differently when voice reference exists.

| Voice Reference State | Reviewer Behavior |
|-----------------------|-------------------|
| Present and populated | Checks both generic slop patterns AND drift from declared voice axes |
| Present but template-only (unfilled) | Warns that drift detection is disabled; runs generic checks |
| Absent | Runs generic slop checks only; no drift metric reported |

**Drift detection heuristic**: if a produced piece places more than 1 axis-unit away from the declared profile on any NNGroup axis, the reviewer flags the section and suggests the axis and direction of correction.

### 4. Anti-Patterns

| Anti-Pattern | Why It Fails |
|--------------|--------------|
| Collecting 5 or more samples | Signal-to-noise drops; voice becomes an average of averages |
| Using AI-generated content as a sample | Locks in slop patterns as the baseline; drift becomes undetectable |
| Using only samples older than 2 years | Voice has likely shifted; you calibrate to a past self |
| Sampling only one format (e.g., only tweets) | Produces a voice profile that fails on every other format |
| Filling the template without reading samples | Declared voice diverges from demonstrated voice within weeks |
| Never refreshing | Brand voice evolves; stale anchors cause false drift alerts |

### 5. Refresh Cadence

| Trigger | Action |
|---------|--------|
| 6 months since last update | Review one sample; replace if no longer representative |
| 12 months since last update | Full refresh: re-score axes, swap in at least one recent sample |
| Major strategy change (rebrand, new audience, new author) | Full refresh immediately |
| Drift alerts keep firing despite reviewer passes | Profile is the problem, not the output; refresh |

## Output Format

```
VOICE CALIBRATION REPORT
========================
Profile:        [author or brand name]
Last updated:   [YYYY-MM-DD]
Sample count:   [2-3]

NNGROUP AXES
────────────
| Axis        | Score (-2 to +2) | Direction        |
|-------------|------------------|------------------|
| Humor       | [n]              | [funny/serious]  |
| Formality   | [n]              | [formal/casual]  |
| Respect     | [n]              | [respectful/irreverent] |
| Enthusiasm  | [n]              | [enthusiastic/matter-of-fact] |

BRAND VOICE AXES
────────────────
| Axis                    | Placement            |
|-------------------------|----------------------|
| Authority level         | [cautious..insider]  |
| Warmth                  | [clinical..warm]     |
| Technicality            | [plain..deep]        |
| Formality of terms      | [everyday..precise]  |
| Conviction              | [hedged..sharp]      |
| Humor frequency         | [rare..frequent]     |

INTEGRATION STATUS
──────────────────
| Skill                  | Reads Voice Ref? |
|------------------------|------------------|
| long-form-writing      | [yes/no]         |
| case-study             | [yes/no]         |
| column-editorial       | [yes/no]         |
| thought-leadership     | [yes/no]         |
| interview-storytelling | [yes/no]         |
| ai-slop-reviewer       | [yes/no]         |
```

## Quick Reference

**Samples**: 2-3, never more than 4
**Recency**: at least one within 12 months
**Axes**: NNGroup 4-dim + 6 brand axes
**Scale**: -2 to +2 on each NNGroup axis
**Refresh**: 6 months review, 12 months full refresh
**Slop reviewer**: drift detection on if profile is populated
**Artifacts**: `references/voice-profile-template.md` + `references/writing-samples-scaffold.md`

---

## References

- See `${CLAUDE_SKILL_DIR}/references/voice-profile-template.md` to declare the profile
- See `${CLAUDE_SKILL_DIR}/references/writing-samples-scaffold.md` to store the sample set
- See `${CLAUDE_SKILL_DIR}/../copywriting/references/anti-ai-writing.md` for generic slop patterns that drift detection runs alongside
