---
context: fork
name: column-editorial
description: "Writes argumentative columns, editorials, and op-eds with contrarian thesis, steelmanned counter-arguments, and layered evidence. Use when user asks about column writing, op-ed, editorial, opinion piece, thought piece, 칼럼, 오피니언, 사설, 논평, or 기고문."
platforms: [claude-code, gemini-cli, codex-cli, cursor]
level: 3
triggers:
  - "column"
  - "op-ed"
  - "opinion piece"
  - "editorial"
  - "contrarian piece"
  - "argumentative essay"
  - "칼럼"
  - "오피니언"
  - "사설"
  - "논평"
  - "기고문"
agents:
  - "content-marketer"
  - "doc-updater"
tokens: "~4K"
category: "marketing"
---

# Column & Editorial Writing

## When This Skill Applies

- Writing B2B newsletter columns with a named opinion owner
- Drafting industry-publication op-eds where the thesis contradicts consensus
- Composing company-blog editorial pieces that commit to a position instead of surveying options
- Converting internal point-of-view memos into public-facing argument pieces
- Refining draft columns that read as neutral analysis when a stronger stance would serve the reader

A column is not a survey, not a listicle, and not a feature report. It commits to one argument and defends it.

---

## Core Guidance

### 1. The Contrarian Thesis Hook

A column earns its first ten seconds by contradicting something the reader believes. If the thesis would not surprise the reader's boss at dinner, it is not a column thesis — it is a briefing.

**Ten-Second Reader Rule**: Within the first 100 words the reader must see (a) a claim they disagree with or have not considered, (b) a reason to believe you can defend it, and (c) the shape of what comes next. If any of the three is missing, the scroll wins.

| Thesis Form | What It Commits To | What It Risks |
|-------------|-------------------|---------------|
| Industry-contrarian | "Everyone says X, but X is wrong because Y" | Strongest form; demands real evidence |
| Sub-segment contrarian | "X is right for most, but for segment Z the opposite holds" | Narrower but defensible; easier to prove |
| Reframing | "Everyone is arguing X vs not-X, but the real question is Z" | Elevates the conversation; must land the new frame |
| Under-stated position | "A point everyone agrees is minor is actually central" | Depends on demonstrated stakes |
| Timeline reversal | "The change people think is coming already happened" | Requires evidence the shift is live, not forecast |

Avoid thesis forms that collapse on first read: "It depends", "Both sides have a point", "We need more research". These are abstentions, not arguments.

---

### 2. Stakes-Credibility-Preview Opening (100-150 words)

The opening paragraph is not scene-setting. It is the audition for the reader's remaining two minutes. Three beats, in order:

| Beat | Purpose | Word Budget | Failure Signal |
|------|---------|-------------|----------------|
| Stakes | Show why the argument is worth having now | 40-60 words | Reads as news recap |
| Credibility | Explain why this author or dataset can speak to it | 30-50 words | Sounds like a resume |
| Preview | Name the two or three supports coming in the body | 30-50 words | Gives the whole argument away |

**Stakes** answers "why does this matter this month." Cite a concrete pressure: a recent policy change, a quarter of traffic data, a decision a reader is about to make.

**Credibility** answers "why should I believe you specifically." The author's first-person experience, the dataset's scope, the operating role held. One sentence, no flattery.

**Preview** answers "what am I in for." Two or three supports named, no more. The reader should finish the opening knowing the destination and the stops, not the mileage.

---

### 3. Four-Stage Body Structure

A column earns trust by modeling the argument it would face across the table.

| Stage | Function | Target Words | Key Move |
|-------|----------|--------------|----------|
| 1. Thesis | State the contrarian claim sharply | 200-300 | No hedging; commit |
| 2. Steelman | Present the strongest opposing view fairly | 250-400 | Name a real counter-holder; use their best form |
| 3. Counter | Show why the steelman fails or is bounded | 400-600 | Evidence-led, not rhetoric-led |
| 4. Implications | Draw the consequence for the reader's decisions | 200-350 | One action frame, not a to-do list |

The body's center of gravity is stage 3. A column that short-changes the counter is an assertion, not an argument.

---

### 4. The Steelman Requirement

Every column must include a paragraph that opens with the functional equivalent of "The strongest case against my position is...". This is not politeness. It is the mechanism by which the reader decides to trust you.

**Steelman quality checklist:**

| Criterion | Pass | Fail |
|-----------|------|------|
| Sourced | Names a real person, institution, or tradition holding the view | "Some would argue..." |
| Best form | Presents the opposing view in its sharpest version, not a weak version | Strawman that is easy to knock over |
| Proportionate | Given enough space that the reader feels the pull | Two sentences then dismissed |
| Charitable | Grants any point that is in fact correct | Concedes nothing |
| Concluded | Ends by stating what the steelman does and does not explain | Left dangling before refutation |

If after writing the steelman the author notices the column's original thesis is weaker than they thought, the correct response is to revise the thesis, not to weaken the steelman.

---

### 5. Evidence Layering

Not all evidence carries the same weight in a column. The higher the tier, the more the argument earns.

| Tier | Evidence Type | Column Weight | When to Use |
|------|---------------|---------------|-------------|
| 1 | First-party data (own operations, own experiments) | Highest | Available; column moves the field |
| 2 | Named third-party dataset or research paper | High | Tier 1 absent; rigor needed |
| 3 | Quoted expert or practitioner on record | Medium | Supports a structural claim |
| 4 | Historical precedent or analogy | Medium-Low | Illustrates pattern; cannot prove |
| 5 | Personal anecdote | Low | Illustrates stakes; never proof |

A column built entirely on tier 4 and tier 5 evidence reads as a blog post. A column that leads with tier 1 and supports with tier 2 and tier 3 reads as publishable argument. Stage 3 of the body should carry at least one tier 1 or tier 2 citation.

**Anti-pattern**: Piling five tier-5 anecdotes and calling the weight of them proof. Three anecdotes rhyming is still three anecdotes.

---

### 6. Closing: Reconsideration, Not Action

A column closes by asking the reader to see the world slightly differently, not by asking them to click or buy.

| Closing Frame | Example Pattern | When It Works |
|---------------|-----------------|---------------|
| Reframed observation | "The next time you see X, notice whether Y is actually present" | Leaves a durable lens |
| Bounded forecast | "If the pattern holds, expect Z within the year" | Stakes a claim readers can check later |
| Inversion challenge | "The question is no longer X; it is its opposite" | Forces position-taking |
| Stakes recapitulation | "The cost of continuing to believe X is Y" | Works when stakes opened the piece |

Closings to avoid: "Time will tell." "It remains to be seen." "What do you think? Comment below." These forfeit the argument the column just built.

---

### 7. Korean Column Practical Ranges

Operating ranges observed across Korean B2B and industry-column formats. Treat as defaults, adjust to house style.

| Element | Range | Notes |
|---------|-------|-------|
| Title | 25-35 characters | Thesis-forward, not summary-forward |
| Lead (리드) | 200-300 characters | Covers stakes + credibility + preview compressed |
| Body (본문) | 1,500-2,500 characters | 3-5 subsection headers |
| Subsection headers | 3-5 total | Each introduces one stage or one piece of evidence |
| Close (맺음) | 100-150 characters | One reconsideration sentence, one stakes sentence |

Long-form English equivalents typically run 900-1,400 words for newsletter columns, 1,400-2,000 for industry-magazine op-eds.

---

### 8. Voice and Pronoun Discipline

| Voice Choice | When Appropriate | When It Becomes a Problem |
|--------------|------------------|---------------------------|
| First-person singular | Personal experience anchors the argument | Used to pad opinions with "I think" |
| Editorial "we" | Represents a publication's position | Hides the author; avoid in signed columns |
| Second-person "you" | Frames the reader's decision in stage 4 | Used in stage 1 or 2; sounds preachy |
| Third-person analytic | Policy and market arguments | Used to dodge ownership of the claim |

A signed column uses the author's "I" in stages 1 and 4, and third-person analytic voice in stages 2 and 3. Mixing "I" into the steelman collapses the structural contrast the reader is tracking.

---

## Output Format

```
COLUMN DRAFT PACKAGE
====================
Title:          [25-35 chars KO / 8-14 words EN]
Thesis Form:    [industry-contrarian | sub-segment | reframing | under-stated | timeline-reversal]
Target Reader:  [segment + decision they face]
Length:         [word or character count]

OPENING (Stakes-Credibility-Preview)
------------------------------------
[100-150 words covering all three beats in order]

BODY OUTLINE
------------
| Stage       | Headline                         | Words | Key Evidence Tier |
|-------------|----------------------------------|-------|-------------------|
| Thesis      | [sharp commitment headline]      | ~250  | Framing           |
| Steelman    | [counter-view headline]          | ~350  | Tier 2-3          |
| Counter     | [refutation headline]            | ~500  | Tier 1-2          |
| Implications| [consequence headline]           | ~275  | Reframed lens     |

CLOSING
-------
[One reconsideration sentence + one stakes sentence]

EVIDENCE LEDGER
---------------
| Claim           | Evidence Tier | Source Form                  |
|-----------------|---------------|------------------------------|
| [claim summary] | [1-5]         | [first-party / named study]  |
```

---

## Quick Reference

**Four Stages**: Thesis → Steelman → Counter → Implications
**Opening Beats**: Stakes → Credibility → Preview (100-150 words)
**Evidence Tiers**: First-party > Named dataset > Expert quote > Precedent > Anecdote
**Close Form**: Reconsideration request, not action CTA
**Korean Ranges**: Title 25-35자 / Lead 200-300자 / Body 1,500-2,500자 / Close 100-150자

---

## References

- See `${CLAUDE_SKILL_DIR}/../copywriting/SKILL.md` for headline formulas that apply to column titles
- See `${CLAUDE_SKILL_DIR}/../ai-slop-reviewer/SKILL.md` to scrub hedge-stacks and affirmation openers before publication
