<!--
Reference implementation — demonstrates voice-reference skill compliance.
All entities (Acme Dev Tools, referenced writers) are fictional.
Fully filled example of voice-profile-template.md at brand-level scope.
-->

# Voice Profile

Fully populated example. Use as a reference for what a complete, actionable profile looks like. All fields filled; no placeholders remain.

---

**Profile**: Acme Dev Tools Engineering Blog
**Last updated**: 2026-04-23
**Scope**: all (blog, column, case-study, thought-leadership, interview)

---

## NNGroup 4-Dimension Voice

| Axis | Score | One-line reason |
|------|-------|-----------------|
| Humor (Funny -2 ↔ +2 Serious) | +1 | Leans serious; occasional dry aside in transitions but no wordplay or jokes in technical body |
| Formality (Formal -2 ↔ +2 Casual) | +1 | Leans casual; contractions allowed, fragments used for rhythm, but full terms for technical concepts |
| Respect (Respectful -2 ↔ +2 Irreverent) | -1 | Leans respectful; assumes reader operates in good faith, avoids sarcasm even when critiquing patterns |
| Enthusiasm (Enthusiastic -2 ↔ +2 Matter-of-fact) | +2 | Strongly matter-of-fact; data carries weight, no exclamation marks, no emphatic adjectives |

---

## Brand Voice Additional Axes

| Axis | Placement | One-line reason |
|------|-----------|-----------------|
| Authority level (cautious explainer ↔ opinionated insider) | Opinionated insider, tempered | First-party operating data anchors claims; hedging appears only when data is genuinely uncertain |
| Warmth (clinical distance ↔ first-name warmth) | Middle, slight clinical lean | Writes about systems and teams rather than individuals; warmth expressed through respect for reader's time |
| Technicality (plain-language ↔ code-and-jargon) | Plain-language-biased technical | Uses precise terminology when needed, defines it on first use, avoids jargon as a gate |
| Formality of terminology (everyday ↔ precise) | Precise | Prefers "instrumentation coverage" over "telemetry health"; specific terms travel better to AI citation |
| Conviction (hedged survey ↔ sharp claim) | Sharp claim | Commits to positions; when survey is appropriate, names it as survey rather than disguising it as argument |
| Humor frequency (rare grace note ↔ every few paragraphs) | Rare grace note | At most one dry aside per 1,500 words; humor never loads structural weight |

---

## Sentence Structures I Favor

- "Short declarative sentence, then a colon: the actual point." — compresses claim + evidence into one unit the reader can quote.
- "Not X. Y." — two-beat negation that reserves the emphatic slot for the positive claim.
- "[Specific subject] does three things." followed by a numbered or bulleted expansion — signals structure the reader can scan.
- "[Noun clause] is [surprising verb]." — leads with the subject rather than the author, keeps the sentence citable when lifted from context.
- "The pattern is [X]. The mechanism is [Y]." — two-clause construction that separates observation from explanation cleanly.

---

## Sentence Structures I Avoid

- Stacked qualifiers ("might potentially possibly") — conviction axis sits sharp, so hedges clash with the declared voice.
- "Simply put," "In other words," and similar rephrasings — reader already got the original phrase; the restatement wastes an attention beat.
- Rhetorical questions with obvious answers — reads as filler in a matter-of-fact voice, better to state the position directly.
- "It is worth noting that" and similar scaffolding — adds words without adding claim, flags the sentence as low-conviction.
- "We will explore," "Let us examine," and future-tense preview constructions — the reader is already reading; announcing the structure instead of delivering it wastes a sentence.

---

## Signature Vocabulary and Phrases

- "The mechanism here is..." — anchors an explanation in causal terms rather than descriptive terms.
- "Reads as X, not Y" — flags a category mistake without moralizing.
- "Load-bearing" — describes a decision or artifact that carries structural weight, not ornamental.
- "First-party data" — preferred over "our research" or "internal study"; signals provenance clearly.
- "Rebuild, not patch" — signals a commitment to root-cause change over surface fix.
- "Hit" (past tense) — compact verb for "reached," used in metric descriptions ("coverage hit 85% in week eleven").

---

## Forbidden Vocabulary

- "Leverage" — replaced with "use" or "draw on"; the word is hollow in all contexts.
- "Unlock" (as verb for benefit) — marketing register clashes with engineering-blog voice.
- "Journey" — "process," "path," or "sequence" depending on context; "journey" reads as brand voice in a technical piece.
- "Cutting-edge" — replaced with specific version numbers or release dates; the adjective dates instantly.
- "Seamless" — the experience being described usually has seams; naming them is more honest.
- "Empower" — "enable," "equip," or just describe what the reader can now do.

---

## One-Line Identity Statement

This voice is a senior engineer explaining a hard-won operational lesson to a peer, with conviction, first-party data, and no filler — declarative, matter-of-fact, and willing to name its own mistakes.

---

## Worked Example of the Voice in Action

A one-paragraph sample demonstrating the declared profile, so future writers can calibrate against a visible output rather than an abstract rule set.

> The coverage gate belongs in the release pipeline, not in the onboarding wiki. We moved it in Q1 2026 after watching a rollout stall at 61% for four months. The mechanism is ownership transfer: when a gate lives in documentation, no team is the gate; when it lives in CI, the release-engineering team owns it. The rollout hit 85% within eleven weeks of the move. The tooling did not change. The authority placement did.

**Why this passes the declared profile**: conviction sharp, data anchored ("61%", "Q1 2026", "eleven weeks"), one dry aside ("no team is the gate") within the rare-grace-note budget, zero forbidden vocabulary, one signature phrase ("the mechanism is"), declarative construction throughout.

---

## Refresh Log

| Date | Change | Trigger |
|---|---|---|
| 2026-04-23 | Initial full profile | Brand voice formalization; onboarding of two new contributing engineers |
| Next scheduled review | 2026-10-23 | 6-month partial refresh (sample swap if needed) |
| Next full refresh | 2027-04-23 | 12-month full rescore with recent sample replacement |
