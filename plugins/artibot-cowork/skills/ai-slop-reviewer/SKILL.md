---
context: fork
name: ai-slop-reviewer
description: "Detects and eliminates AI slop patterns from any text output. Scans for generic filler phrases, hollow adjectives, structural laziness, and robotic cadence that signal AI-generated writing. Run this after any content-creation or copywriting task. Use when user asks about ai slop, ai writing review, text quality check, writing polish, 텍스트 품질, AI 패턴 검사, 슬롭 검사, 글쓰기 품질, AI 글 검토, 문체 교정, 자연스러운 글, 인간 문체, or 글 다듬기."
platforms: [claude-code, gemini-cli, codex-cli, cursor]
level: 3
triggers:
  - "ai slop"
  - "ai writing review"
  - "slop check"
  - "slop review"
  - "writing quality"
  - "text quality check"
  - "polish this text"
  - "humanize writing"
  - "remove ai patterns"
  - "텍스트 품질"
  - "AI 패턴"
  - "슬롭 검사"
  - "글쓰기 품질 검토"
  - "AI 글 검토"
  - "문체 교정"
  - "자연스러운 글"
  - "인간 문체"
  - "글 다듬기"
  - "AI 티 제거"
  - "writing review"
agents:
  - "doc-updater"
  - "content-marketer"
tokens: "~4K"
category: "quality"
---

# AI Slop Reviewer

## When This Skill Applies

- After any content-creation, copywriting, or marketing writing task
- When reviewing blog posts, social media copy, email campaigns, or documentation
- When text feels generic, hollow, or obviously machine-generated
- Before publishing any AI-assisted content externally
- When brand voice requires authenticity and specificity
- **HARD rule**: Run this skill on all text output from content-marketer, doc-updater, or copywriting skill sessions

## Core Guidance

### 1. What Is AI Slop?

AI slop is the residue of pattern-matching at scale. Language models trained on internet text learn that certain words appear near "good writing" signals — resulting in a predictable vocabulary of hedged compliments, hollow affirmations, and vague intensity markers. The result reads as enthusiastic but says nothing.

**Three failure modes:**
- **Filler affirmations**: Phrases that confirm the speaker received the input without adding meaning ("Certainly!", "Of course", "물론입니다")
- **Hollow intensifiers**: Adjectives that signal quality without describing it ("innovative", "comprehensive", "혁신적인")
- **Structural laziness**: Formatting choices that substitute organization for thought (bullet-point dumps, numbered lists for non-sequential content, excess emoji)

---

### 2. Korean AI Slop Pattern Dictionary

| Pattern | Why It Is Slop | Replacement Approach |
|---------|---------------|----------------------|
| ~하겠습니다 | Bureaucratic future-tense hedge; avoids commitment | Use present tense or direct imperative |
| 물론입니다 | Hollow affirmation; confirms nothing | Delete entirely or rewrite to answer directly |
| ~해 드리겠습니다 | Service-script cadence; over-formal | Use direct verb: "합니다", "진행합니다" |
| 중요한 것은 | Empty framing device; delays the point | Lead with the actual important thing |
| 탁월한 선택 | Flattery without evidence | State what makes it good, with data |
| 특히 | Filler emphasis; often modifies an ordinary claim | Remove or replace with specific quantifier |
| 다만 | Weak adversative; signals hedge before hedge | Use specific conditional: "단, X 조건에서는" |
| 또한 | Additive connector overused to pad lists | Use only when genuine addition is needed |
| 다양한 | Vague plurality; conceals the actual count | Name the items or give a number |
| 그러나 | Overused pivot; often introduces a mild caveat | Use only for genuine contrast; cut padding |
| 혁신적인 | Technology-press adjective; used for everything | Describe the mechanism: what it changes, how |
| 포괄적인 | Claims completeness without evidence | Specify what is covered and what is not |
| 효율적으로 | Adverb that proves nothing | State the efficiency gain numerically |
| 최적화 | Buzzword; often means "we changed something" | Specify what was optimized and by how much |
| 세심하게 | Care-signaling word in business contexts | Show the care through specifics, not the word |
| 철저한 | Thoroughness claim without evidence | Enumerate what was examined |
| 완벽한 | Absolute claim impossible to verify | Use qualified language: "오류율 0.1% 이하" |
| 독자적인 | Differentiation claim without proof | Describe the distinguishing mechanism |
| 놀라운 | Emotion-prompt without a fact to be amazed by | Supply the fact; remove the adjective |
| 강력한 | Empty intensifier attached to any noun | Quantify the force: "초당 10,000건 처리" |
| 심층적인 | Depth claim without demonstrating depth | Show depth through specificity, not this word |
| 전반적으로 | Scope hedge that softens every claim | Claim specifically or not at all |
| 최선을 다해 | Effort-signaling phrase; implies prior insufficiency | State the outcome, not the effort |
| ~에 대해 살펴보겠습니다 | Announcement of the topic instead of the topic | Open with the content itself |
| 매우 중요합니다 | Urgency without reason | Explain why, with a consequence |

---

### 3. English AI Slop Pattern Dictionary

| Pattern | Why It Is Slop | Replacement Approach |
|---------|---------------|----------------------|
| Certainly | Hollow opener; AI's way of saying "I heard you" | Delete; begin with the substance |
| Absolutely | Same as "certainly"; often precedes flattery | Delete entirely |
| Of course | Implies the question was obvious; condescending | Delete and answer directly |
| Delve into | Pseudo-scholarly; overused in AI text | Use: "examine", "look at", "explore" — or remove |
| Dive deep | Action metaphor without action | Specify: "analyze three factors", not "dive deep" |
| Comprehensive | Completeness claim; rarely demonstrated | List what is actually included |
| Robust | Engineering term applied to anything | Specify the load, stress, or condition it handles |
| Leverage | Jargon for "use"; signals corporate AI copy | Use "use", "apply", or "draw on" |
| Utilize | Formal synonym for "use" that adds no clarity | Use "use" |
| Seamlessly | Implies zero friction; untestable claim | Describe the actual integration mechanism |
| Innovative | Attached to everything; means nothing alone | Describe what it changes and for whom |
| Cutting-edge | Marketing superlative that expires instantly | Name the specific technology or approach |
| Revolutionize | Overstate; sets undeliverable expectation | Describe the specific change in behavior |
| Game-changer | Cliché; used when no specific impact is known | State the impact in measurable terms |
| Paradigm shift | Academic buzzword; almost always hyperbole | Describe the actual shift in thinking or practice |

---

### 4. Structural AI Slop Patterns

| Structural Problem | Symptom | Fix |
|-------------------|---------|-----|
| Bullet-point dump | Every thought becomes a bullet, even prose ideas | Write connected paragraphs for narrative content |
| Non-sequential numbering | Numbered lists for items with no order dependency | Use bullets or prose; numbers imply sequence |
| Topic announcement opener | First sentence names the topic instead of addressing it | Cut the announcement; lead with the first insight |
| Hollow conclusion | Ends with "In summary..." followed by repetition | End with the next action, implication, or open question |
| Excess emoji | Emoji every 1-2 sentences to signal warmth | Zero emoji in professional content; one max in casual |
| Symmetry padding | Sections padded to match each other's length | Sections end when content ends, not when symmetry is achieved |
| Hedge stack | Multiple qualifiers in one clause ("might potentially possibly") | One qualifier maximum per clause |
| Header inflation | H3 header for every paragraph | Headers only when navigation across sections is needed |
| List masquerading as analysis | Bullets replace causal reasoning | Write the causal chain in prose |
| Generic call-to-action | "Feel free to reach out" at end of every piece | Specific CTA tied to the content's purpose |

---

### 5. Quality Checklist

Run the following on every piece before marking it complete:

| Check | Pass Condition | Fail Signal |
|-------|---------------|------------|
| Zero affirmation openers | No "Certainly", "물론입니다", "Absolutely" in first sentence | Any of those phrases present |
| Adjective audit | Every adjective is supported by a fact within 2 sentences | "innovative", "comprehensive", "혁신적인" without proof |
| Bullet-to-prose ratio | Bullets used only for genuinely parallel, discrete items | Prose ideas forced into bullet format |
| Opener check | First sentence delivers a claim, not a topic announcement | "In this section we will explore..." |
| Emoji count | 0 in professional; max 1 in casual contexts | Emoji every 2+ sentences |
| Hedge density | Max 1 qualifier per sentence | "might potentially", "could possibly", "다소 어느 정도" |
| Conclusion test | Final paragraph adds new information or action | "As mentioned above..." summary |
| Specificity scan | Quantities, names, dates, or mechanisms present | All-adjective, no-noun sentences |
| Voice check | Active voice >80% of sentences | Passive constructions dominate |
| Reading aloud test | No sentence sounds like a press release when read aloud | Robotic cadence detectable at normal reading speed |

---

### 6. Correction Methodology

**Step 1 — Surface scan (30 seconds)**
Search for the top-10 pattern triggers: "certainly", "물론", "comprehensive", "혁신적", "seamlessly", "탁월", "leverage", "다양한", "delve", "포괄적". Each match is a required edit, not optional.

**Step 2 — Structural audit (2 minutes)**
Count bullets per section. If any section has more than 5 bullets, convert the lowest-information ones to prose. Check first and last sentences of each section for announcement openers and summary closers.

**Step 3 — Adjective challenge**
For every adjective in the draft, ask: "What fact supports this?" If none exists within two sentences, delete the adjective and supply the fact, or delete both.

**Step 4 — Read aloud test**
Read the revised text at normal pace. Flag any sentence that sounds like it was written for an audience of no one in particular. Rewrite to a specific reader.

**Step 5 — Replacement, not deletion**
Do not simply cut slop words. Replace with specifics. "혁신적인 솔루션" → "응답 시간을 340ms에서 40ms로 줄인 캐싱 레이어". The replacement should be more specific than the original, not just shorter.

---

### 7. Severity Scoring

| Score | Label | Criteria |
|-------|-------|---------|
| 90-100 | Clean | Fewer than 3 slop flags; structure serves content |
| 70-89 | Acceptable | 4-8 flags; minor adjective and opener issues |
| 50-69 | Needs Work | 9-15 flags; structural problems present |
| 30-49 | Heavy Slop | 16-25 flags; hollow throughout; rewrite advised |
| 0-29 | Reject | 26+ flags; more slop than substance; discard and restart |

---

## Output Format

```
SLOP REVIEW REPORT
==================
Text:        [title or first 10 words of input]
Word Count:  [n]
Score:       [0-100] — [label]

PATTERN FLAGS
─────────────
| Line | Pattern Found        | Severity | Suggested Fix                     |
|------|----------------------|----------|-----------------------------------|
| 3    | "물론입니다"           | High     | Delete; open with the answer      |
| 7    | "comprehensive"      | Medium   | Specify what is included          |
| 12   | "혁신적인 솔루션"       | High     | State the mechanism + metric      |
| 18   | Bullet dump (6 items)| Medium   | Convert 3 to prose                |
| 24   | "Certainly"          | High     | Delete opener; start with content |

STRUCTURAL ISSUES
─────────────────
| Issue               | Location     | Fix                               |
|---------------------|--------------|-----------------------------------|
| [issue description] | [section]    | [specific action]                 |

REVISED EXCERPT
───────────────
[Show before/after for the 2 highest-severity flags]

Before: [original sentence]
After:  [rewritten sentence]

CHECKLIST RESULT
────────────────
| Check                  | Result |
|------------------------|--------|
| Zero affirmation opener| [Pass/Fail] |
| Adjective audit        | [Pass/Fail] |
| Bullet-to-prose ratio  | [Pass/Fail] |
| Opener check           | [Pass/Fail] |
| Emoji count            | [Pass/Fail] |
| Hedge density          | [Pass/Fail] |
| Conclusion test        | [Pass/Fail] |
| Specificity scan       | [Pass/Fail] |
| Voice check            | [Pass/Fail] |
| Reading aloud test     | [Pass/Fail] |

FINAL RECOMMENDATION
────────────────────
[One sentence: publish as-is / revise and resubmit / discard and rewrite]
```

## Quick Reference

**Top KO Slop Triggers**: 물론입니다, 혁신적인, 포괄적인, 다양한, ~하겠습니다, 탁월한
**Top EN Slop Triggers**: certainly, comprehensive, leverage, seamlessly, delve into, robust
**Structural Red Flags**: Bullet dump, topic-announcement opener, hollow summary closer, hedge stack
**Minimum Score to Publish**: 70 (Acceptable or above)
**Hard Block Score**: Below 50 requires full revision before any external use

---

## References

- See `${CLAUDE_SKILL_DIR}/references/anti-ai-writing.md` for full Korean/English pattern dictionaries, natural style rules, and self-review checklist
