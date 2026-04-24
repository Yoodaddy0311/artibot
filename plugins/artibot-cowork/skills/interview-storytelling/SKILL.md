---
context: fork
name: interview-storytelling
description: "Structures long-form interview storytelling for expert interviews, internal feature stories, and multi-expert roundups. Applies 5W1H question matrix, 3-part answer arc, verbal signposting, NNGroup 4-dimension voice profile, and quote-approval workflow. Use when user asks about interview article, expert interview, feature story, storytelling, quote roundup, 인터뷰 기사, 전문가 인터뷰, 스토리텔링, 인용 모음, or 피처 스토리."
platforms: [claude-code, gemini-cli, codex-cli, cursor]
level: 3
triggers:
  - "interview article"
  - "expert interview"
  - "feature story"
  - "storytelling long-form"
  - "quote roundup"
  - "multi-expert article"
  - "인터뷰 기사"
  - "전문가 인터뷰"
  - "스토리텔링"
  - "인용 모음"
  - "피처 스토리"
agents:
  - "content-marketer"
  - "doc-updater"
tokens: "~4K"
category: "marketing"
depends_on:
  - copywriting
suggests:
  - voice-reference
  - long-form-writing
  - ai-slop-reviewer
---

# Interview Storytelling

## When This Skill Applies

- Producing a long-form article based on one or more interviews with named experts
- Building an internal feature story about a team, program, or customer
- Aggregating 3-5 expert quotes into a single roundup piece
- Turning a podcast or webinar transcript into readable long-form content
- Any brief where human voice and attributable quotes are the primary source material

## Core Guidance

### 1. 5W1H Question Matrix

Before the interview, draft at least two questions per dimension. The matrix forces coverage of the full story surface.

| Dimension | Purpose | Example Prompt Pattern |
|-----------|---------|------------------------|
| Why | Motivation, cause, origin | `Why did [decision] happen when it did?` |
| Who | Stakeholders, audience, affected parties | `Who pushed for this, and who resisted?` |
| What | Concrete objects, outputs, artifacts | `What did the first version look like?` |
| When | Sequence, timing, triggers | `When did you realize the approach was wrong?` |
| Where | Context, environment, location | `Where in the workflow did this break first?` |
| How | Mechanism, method, process | `How did you actually measure that outcome?` |

During the interview, let Why and How questions run long. Who, What, When, and Where questions collect facts for verification.

### 2. Three-Part Answer Arc

Each spoken answer and each written passage built from that answer follows the same structure.

| Part | Duration (spoken) | Word Count (written) | Role |
|------|-------------------|----------------------|------|
| Hook | 15-30 seconds | 25-40 words | One surprising or specific opening claim |
| Core | 1.5-3 minutes | 120-200 words | The mechanism, evidence, or narrative detail |
| Close | 15-30 seconds | 25-40 words | Stakes, implication, or forward-pointing line |

When narrativizing, the arc applies at passage level. A 500-word section is three arcs stacked, not one long expansion.

### 3. Verbal Signposting

Signposts are short transition phrases that orient the reader between ideas. Use them sparingly; three to five per 1,000 words is a healthy density.

| English Signpost | Korean Equivalent | When to Use |
|------------------|-------------------|-------------|
| "The key insight here is..." | "여기서 핵심은..." | Flagging the single most important claim in a section |
| "Three things matter..." | "중요한 건 세 가지입니다..." | Opening an enumerated set |
| "Let me show you..." | "예를 들어 보겠습니다..." | Transitioning from abstract to concrete |
| "What this means in practice..." | "실제로 이게 뜻하는 바는..." | Bridging principle to application |
| "The counterintuitive part..." | "의외인 부분은..." | Introducing a finding that contradicts expectation |

Avoid signposts that announce without delivering ("I want to talk about..."). Every signpost should be followed immediately by the content it points at.

### 4. NNGroup 4-Dimension Voice Profile

The Nielsen Norman Group defines brand voice along four independent axes. Each interview subject and each article section should place on the axes consciously, not by default.

| Axis | Anchor A | Anchor B |
|------|----------|----------|
| Humor | Funny | Serious |
| Formality | Formal | Casual |
| Respect | Respectful | Irreverent |
| Enthusiasm | Enthusiastic | Matter-of-fact |

**Humor axis**: A funny tone uses wordplay, surprise, and light self-deprecation. A serious tone does not. Funny sample: "We built the worst possible version first, on purpose." Serious sample: "The initial build was deliberately minimal."

**Formality axis**: Formal uses full terms, complete sentences, and few contractions. Casual uses contractions, sentence fragments, and colloquial phrasing. Formal sample: "The migration occurred over six weeks." Casual sample: "The migration took about six weeks, give or take."

**Respect axis**: Respectful avoids sarcasm and assumes the reader's good faith. Irreverent challenges the reader, pokes at sacred cows, may use mild provocation. Respectful sample: "Most teams underestimate the rollback plan." Irreverent sample: "Skip the rollback plan and you will learn humility quickly."

**Enthusiasm axis**: Enthusiastic uses emphatic word choices and exclamation-free excitement. Matter-of-fact uses neutral verbs and lets the data carry the weight. Enthusiastic sample: "The jump in retention floored us." Matter-of-fact sample: "Retention rose 14 points in the quarter."

| Subject Type | Common Voice Profile |
|--------------|----------------------|
| Senior engineer | Serious / Formal / Respectful / Matter-of-fact |
| Founder or exec | Serious / Casual / Irreverent / Enthusiastic |
| Designer or creative | Funny / Casual / Respectful / Enthusiastic |
| Analyst or researcher | Serious / Formal / Respectful / Matter-of-fact |

### 5. Quote Approval Workflow

Three stages, each with a named artifact. Never skip stage 2.

| Stage | Action | Artifact |
|-------|--------|----------|
| 1 | Record the interview or collect written responses | Transcript or written submission |
| 2 | Send summary and selected quotes to subject; request edits | Summary email with quote list |
| 3 | Obtain explicit public-use consent before publish | Written approval on file |

**Stage 2 email core**: "Attached is my summary of our conversation and the quotes I plan to use. Please edit anything that misrepresents what you meant. Reply with 'approved' once the quotes are accurate. Silence is not approval."

**Publish blockers** — hold the piece until all three are true:
- [ ] Subject has seen the full summary, not just the quotes in isolation
- [ ] Every quote attributed to the subject has been edited or confirmed verbatim
- [ ] Public use on the named channels has explicit written consent

### 6. Multi-Expert Roundup Mode

When a single article pulls quotes from 3-5 named experts on one topic, the structure changes.

| Element | Roundup Approach |
|---------|------------------|
| Opening | Frame the question that all experts answered |
| Expert block | Short bio line, 2-3 sentence quote, one follow-up insight per expert |
| Synthesis | Writer's own 150-200 word paragraph connecting the quotes |
| Points of disagreement | Surface explicitly; do not smooth over contradictions |
| Closing | Forward-looking question for the reader, not a summary |

**Expert block template**:
```
### [Expert Name], [Title], [Company]

[25-40 word bio line establishing relevance to the question]

"[Direct quote, 40-80 words, edited for grammar with subject approval]"

[Writer's 30-60 word framing of why this quote matters in the context of the roundup]
```

### 7. Working From Transcripts

| Transcript Problem | Treatment |
|--------------------|-----------|
| Verbal tics ("um", "you know", "like") | Remove silently; disclose editing policy once in article footer |
| Sentence restarts | Keep the intended sentence, drop the abandoned start |
| Ambiguous pronouns | Replace with the noun the subject meant, confirm in stage 2 email |
| Factual errors | Flag to subject; do not print without correction |
| Off-record comments | Exclude entirely; separate list kept by interviewer |

## Output Format

```
INTERVIEW STORY PACKAGE
=======================
Title:          [article headline]
Mode:           [single-subject | multi-expert roundup]
Subjects:       [names and titles]
Word Count:     [target]
Voice profile:  [humor / formality / respect / enthusiasm placement]

QUESTION MATRIX
───────────────
| Dimension | Q#1 | Q#2 |
|-----------|-----|-----|
| Why       |     |     |
| Who       |     |     |
| What      |     |     |
| When      |     |     |
| Where     |     |     |
| How       |     |     |

APPROVAL STATUS
───────────────
| Subject | Stage 1 (transcript) | Stage 2 (summary sent) | Stage 3 (public-use consent) |
|---------|---------------------|------------------------|------------------------------|
| [name]  | [yes/no]            | [date]                 | [yes/no]                     |

VOICE PROFILE
─────────────
| Axis        | Placement         |
|-------------|-------------------|
| Humor       | Funny / Serious   |
| Formality   | Formal / Casual   |
| Respect     | Respectful / Irreverent |
| Enthusiasm  | Enthusiastic / Matter-of-fact |
```

## Quick Reference

**Question matrix**: 2 questions per 5W1H dimension
**Answer arc**: Hook (25-40w) -> Core (120-200w) -> Close (25-40w)
**Signposts**: 3-5 per 1,000 words, always followed by content
**Voice axes**: Humor, Formality, Respect, Enthusiasm (NNGroup 4-dim)
**Approval stages**: Transcript -> Summary review -> Public-use consent
**Roundup**: 3-5 experts, synthesis paragraph, surface disagreement
**Transcript cleanup**: Silent for tics, disclosed in footer

---

## References

- See `${CLAUDE_SKILL_DIR}/../copywriting/references/anti-ai-writing.md` for voice-related slop patterns that flatten expert quotes
