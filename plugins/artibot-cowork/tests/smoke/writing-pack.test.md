# Writing Pack Smoke Tests — v0.4.0

End-to-end smoke tests for the 6 writing skills in `artibot-cowork` plus the `ai-slop-reviewer` quality gate. Each section below is one scenario: trigger → expected structural output → rubric pass threshold → Pass/Fail checklist.

These are **manual** smoke tests in v0.4.0. A Node runner is planned for v0.5.0 (see `README.md`).

> **Fixture inputs** live in `./fixtures/`. Every scenario references the `long-form-quality-rubric.md` (100-point rubric, 5 categories) and the `ai-slop-reviewer` severity scoring (0-100). Scoring floors per category must be met **before** the total is granted.

---

## Global Pass/Fail Bar

A writing skill scenario passes the smoke test when **all** of these hold:

| Gate | Threshold |
|------|-----------|
| Skill invocation | Trigger keyword surfaces the correct skill (no wrong skill, no miss) |
| Structural fidelity | Every "required structural feature" box below is checked |
| Long-form rubric | Total ≥ 80, with each category ≥ floor (18/13/8/8/7) |
| AI-slop gate | Slop score ≥ 75 (Acceptable or Clean) |
| Word count | Output lands within the target range stated per scenario |
| No fabricated sources | External statistics traceable to real public sources; fixture-proprietary data marked as such |

A **single Critical** severity auto-flag from the rubric is an automatic fail even if the total scores well.

---

## Scenario 1 — `long-form-writing`

### Trigger

Operator or user message that contains any of: `long-form`, `pillar post`, `in-depth article`, `AEO content`, `AI citation`, `롱폼`, `심층 포스트`, `필러 콘텐츠`.

### Manual Execution

1. In Claude Code (or Gemini/Codex CLI), open the fixture:
   `./fixtures/brief-b2b-saas-blog.md`
2. Invoke with prompt of the form:
   `"Write a long-form pillar post from this brief: <contents of brief-b2b-saas-blog.md>"`
3. Confirm the `long-form-writing` skill activates (Claude should reference answer-first lead, question-style H2 ratio, or citable passage rule in its plan).

### Required Structural Features

| # | Feature | Check |
|---|---------|-------|
| 1 | Answer-first lead | First paragraph after H1 is 40-60 words, direct answer, no throat-clearing |
| 2 | Question-style H2 ratio | ≥60% of H2 are `Why/How/What/When/Who` phrased |
| 3 | Hook frame declared | Output format names one of: counterintuitive, transformation, secret, mistake, data |
| 4 | Citable passage per major section | Each H2 section contains a 120-180 word self-contained block |
| 5 | Statistic density | ≥8 cited external facts per 2,000 words |
| 6 | Sentence discipline | Average sentence 15-20 words; no stretch beyond 30 |
| 7 | Paragraph discipline | Average paragraph 40-80 words; no paragraph >110 |
| 8 | Link budget | 2-3 internal + 1-2 external authoritative |
| 9 | Output format block | `LONG-FORM DRAFT PACKAGE` header with H2 outline + citable passage inventory + source list |

### Pass/Fail Checklist

- [ ] Skill triggered on first attempt (no manual `/skill` invocation needed)
- [ ] Answer-first lead word count in 40-60 range
- [ ] H2 ratio ≥ 60% question-style (count and report actual ratio)
- [ ] Citable passage inventory table present in output format
- [ ] ≥8 statistics, each with URL
- [ ] No fabricated sources (every URL is a real reachable page)
- [ ] Long-form rubric total ≥ 80
- [ ] Rubric category floors: Content ≥18, SEO ≥13, E-E-A-T ≥8, Technical ≥8, AI Citation ≥7
- [ ] AI-slop score ≥ 75
- [ ] CTA is content-tied (not "Feel free to reach out")

### Failure Signatures to Log

| Symptom | Likely Cause |
|---------|--------------|
| Wrong skill triggered (e.g., `content-seo` instead) | Trigger dictionary collision; file a skill-trigger bug |
| H2 ratio < 50% | Skill followed outline template but lost question-frame discipline mid-draft |
| Stats sourced to "a recent study" with no URL | Skill drafted around unverified claims; must regenerate with source list first |
| Citable passage <120 words or fragmented | Skill merged sections; re-run with explicit section-isolation prompt |

---

## Scenario 2 — `case-study`

### Trigger

`case study`, `customer success story`, `success case`, `도입 사례`, `고객 사례`, `케이스 스터디`, `B2B 사례`.

### Manual Execution

1. Open `./fixtures/brief-case-study.md`.
2. Prompt: `"Draft a customer case study from this brief: <contents of brief-case-study.md>"`
3. Confirm the `case-study` skill activates (output should reference the 5-block Challenge-Strategy-Execution-Results-Lessons structure).

### Required Structural Features

| # | Feature | Check |
|---|---------|-------|
| 1 | Title formula | Matches `How [Company] [Result] in [Timeframe]` |
| 2 | TL;DR box | 40-60 words, 3 lines (Challenge / Solution / Metric) |
| 3 | Five-block structure | All 5 blocks present in order, each within its word-count band |
| 4 | STAR mapping applied | Execution reads as sequenced actions with named tools, not as one paragraph |
| 5 | KPI table | ≥2 before/after pairs in `Metric: before -> after (% change)` format |
| 6 | Named quote | ≥1 direct quote with title + company attribution |
| 7 | Timeline label | Kickoff → measurement window stated in month labels |
| 8 | Quote approval log | All quotes listed with approval status |
| 9 | Industry variant applied | B2B SaaS specifics visible (buying committee, champion/economic buyer mentioned) |

### Pass/Fail Checklist

- [ ] Skill triggered from fixture phrasing
- [ ] Title matches primary formula exactly (not a variation unless brief required it)
- [ ] TL;DR within 40-60 words AND 3 lines
- [ ] Block word counts within ranges:
  - Challenge 150-250, Strategy 150-250, Execution 250-400, Results 200-300, Lessons 100-200
- [ ] KPI table contains ≥2 before/after pairs
- [ ] Both fictional quotes from the fixture used verbatim with correct attribution
- [ ] No invented metrics beyond what the fixture supplies
- [ ] AI-slop score ≥ 75
- [ ] Long-form rubric total ≥ 80 (Content, E-E-A-T, Technical floors met)
- [ ] Quote approval log renders with "approved (fixture)" status

### Failure Signatures to Log

| Symptom | Likely Cause |
|---------|--------------|
| Lessons block missing or collapsed into Results | STAR framework applied but +Lessons block forgotten |
| KPI table shows after-only numbers | Skill accepted a "post-implementation number" as sufficient; fixture requires pairs |
| Quote paraphrased instead of verbatim | Skill reformulated for flow; must regenerate with explicit verbatim directive |
| Title uses Variation A when primary is stronger | Skill default logic preferred transformation framing; adjust prompt |

---

## Scenario 3 — `column-editorial`

### Trigger

`column`, `op-ed`, `editorial`, `opinion piece`, `contrarian piece`, `칼럼`, `오피니언`, `기고문`.

### Manual Execution

1. Open `./fixtures/brief-expert-column.md`.
2. Prompt: `"Write an op-ed column from this brief: <contents>"`
3. Confirm the `column-editorial` skill activates (output should reference contrarian thesis, ten-second reader rule, or stakes-credibility-preview opening).

### Required Structural Features

| # | Feature | Check |
|---|---------|-------|
| 1 | Contrarian thesis in first 100 words | Reader sees disagreement-worthy claim + credibility + preview |
| 2 | Stakes-Credibility-Preview opening | Three beats in order, 100-150 total words |
| 3 | Four-stage body | Thesis full statement → Evidence layering → Steelmanned counter → Forward commitment |
| 4 | Steelmanned counter-argument | Counter is given its best form before the author responds |
| 5 | Named-author byline | Dr. Jane Park, Principal Data Scientist, Helix Ventures |
| 6 | Forward-commitment close | Includes retraction condition; is not a summary |
| 7 | Thesis form label | Output declares "Industry-contrarian" thesis form |
| 8 | Hedge density | No sentence with 3+ qualifiers (slop auto-flag) |

### Pass/Fail Checklist

- [ ] Skill triggered from `column` or `op-ed` keyword
- [ ] Thesis legible in first 100 words; contradicts a consensus position the brief named
- [ ] Opening contains all three beats (stakes, credibility, preview) in order
- [ ] Counter-argument section exists AND genuinely steelmans (not a strawman)
- [ ] Forward-commitment close names ≥3 signals author will watch + ≥1 retraction condition
- [ ] Fixture-proprietary data clearly marked as author's dataset (not cited as public study)
- [ ] No forbidden rhetorical moves (no "it depends", no generic CTA)
- [ ] AI-slop score ≥ 75
- [ ] Long-form rubric total ≥ 80
- [ ] Word count 1,200-1,600 (matches `brief-expert-column.md` fixture spec; note `column-editorial` skill native spec is 1,500-2,000w — this scenario grades against the fixture target, not the skill default)

### Failure Signatures to Log

| Symptom | Likely Cause |
|---------|--------------|
| Thesis softens by mid-body | Skill drifted toward "balanced" survey mode; re-run with explicit hedge-block instruction |
| Counter-argument reads as strawman | Steelmanning discipline missed; regenerate with a targeted reprompt |
| Summary close instead of forward-commitment | Default conclusion pattern overrode skill instructions |
| Fixture numbers presented as if public | Author-dataset framing lost; potential trust breach |

---

## Scenario 4 — `thought-leadership`

### Trigger

`thought leadership`, `founder content`, `executive writing`, `linkedin long form`, `personal brand content`, `E-E-A-T`, `소트리더십`, `경영자 글`.

### Manual Execution

1. Reuse `./fixtures/brief-expert-column.md` (it contains the author bio material).
2. Prompt: `"Produce a thought-leadership LinkedIn long-form version of this piece with the named author's bio block: <contents>"`
3. Confirm `thought-leadership` skill activates (bio formula + Authority-Vulnerability-Value mix should appear in output).

### Required Structural Features

| # | Feature | Check |
|---|---------|-------|
| 1 | Named author, full identity | "Dr. Jane Park, Principal Data Scientist, Helix Ventures" |
| 2 | Three-sentence author bio | Exactly 3 sentences: current role + why this author + reader benefit |
| 3 | Authority-Vulnerability-Value mix | Target 50/20/30 visible in tone distribution |
| 4 | First-person voice | "I", "we" — author-as-narrator, not "The team at X…" |
| 5 | E-E-A-T signals | Experience (first-party data), Expertise (credentials), Authoritativeness (named cases), Trust (limitations stated) |
| 6 | Ghostwriting disclosure | If ghostwritten, disclosed; fixture is single-author so this scenario: N/A but log any false claim |

### Pass/Fail Checklist

- [ ] Skill triggered from `thought leadership` or `linkedin long form`
- [ ] Bio block is exactly 3 sentences (not 2, not 4)
- [ ] Bio sentence 1 = role + tenure + domain
- [ ] Bio sentence 2 = why this author on this topic
- [ ] Bio sentence 3 = reader benefit
- [ ] First-person voice dominant (sampling ≥ 80% of first-person candidates)
- [ ] Vulnerability beat present (an admitted limit, false start, or revised belief)
- [ ] No anonymous authorship ("The Team") anywhere in byline or bio
- [ ] AI-slop score ≥ 75
- [ ] Long-form rubric total ≥ 80; E-E-A-T category ≥ 12/15
- [ ] Word count suitable for LinkedIn long-form (900-1,500)

### Failure Signatures to Log

| Symptom | Likely Cause |
|---------|--------------|
| Bio block is 5+ sentences | Skill ignored the three-sentence floor |
| Authority-only tone, no vulnerability | 100/0/0 mix; piece reads as self-promotion |
| Third-person brand voice creeps in | Thought-leadership framing lost; re-run with "author-first" directive |
| Generic credentials ("passionate about data") | Failure mode from skill guidance explicitly listed |

---

## Scenario 5 — `interview-storytelling`

### Trigger

`interview article`, `expert interview`, `feature story`, `storytelling long-form`, `quote roundup`, `인터뷰 기사`, `전문가 인터뷰`.

### Manual Execution

1. Reuse `./fixtures/brief-case-study.md` — it carries 3 fictional stakeholder quotes.
2. Prompt: `"Turn this brief into an interview-style feature story using the 3 quoted stakeholders as the primary narrative sources: <contents>"`
3. Confirm `interview-storytelling` skill activates (output should reference 5W1H matrix, 3-part answer arc, or NNGroup 4-dimension voice).

### Required Structural Features

| # | Feature | Check |
|---|---------|-------|
| 1 | 5W1H coverage | Output plan names ≥2 questions in each of Why/Who/What/When/Where/How |
| 2 | Three-part answer arc | Each major quoted passage has hook (25-40w) + core (120-200w) + close (25-40w) |
| 3 | Verbal signposts | 3-5 signposts per 1,000 words; each followed immediately by the content |
| 4 | NNGroup 4-dimension voice | Output declares placement on Humor / Formality / Respect / Enthusiasm axes |
| 5 | Named quote attribution | Every quote carries name + title + company |
| 6 | Narrative arc | Setup → Conflict → Resolution structure legible across sections |

### Pass/Fail Checklist

- [ ] Skill triggered from `interview article` or `feature story`
- [ ] 5W1H plan rendered before the article body (at least one per dimension)
- [ ] All 3 fixture quotes used verbatim with correct attribution
- [ ] No invented quotes beyond the fixture
- [ ] Each quoted passage follows hook/core/close proportions
- [ ] Voice profile placement declared with scored axes (-2 to +2)
- [ ] Signpost density 3-5 per 1,000 words
- [ ] AI-slop score ≥ 75
- [ ] Long-form rubric total ≥ 80

### Failure Signatures to Log

| Symptom | Likely Cause |
|---------|--------------|
| Quotes stitched with narration that contradicts the source | Re-verify against fixture; treat as Critical severity |
| 5W1H plan skipped | Skill went straight to prose; re-prompt with "plan first, then draft" |
| Voice axes declared but never applied | Output-format compliance without content compliance |
| Signposts announced but not delivered ("I want to discuss…") | Anti-pattern explicitly in skill guidance |

---

## Scenario 6 — `voice-reference`

### Trigger

`voice profile`, `tone calibration`, `brand voice`, `voice anchor`, `보이스 프로필`, `톤 캘리브레이션`, `문체 기준`.

### Manual Execution

Voice-reference is an **input skill**: it does not draft content, it declares a profile the other writing skills consume. Smoke test is a structural scaffold check.

1. In a fresh project, prompt: `"Set up a voice reference profile for an author who writes like [Dr. Jane Park from the column fixture]."`
2. Confirm `voice-reference` skill activates and produces `voice-profile-template.md` + `writing-samples-scaffold.md` structure.

### Required Structural Features

| # | Feature | Check |
|---|---------|-------|
| 1 | Two-file output | Both `voice-profile-template.md` and `writing-samples-scaffold.md` populated |
| 2 | NNGroup 4-axis placements | Humor / Formality / Respect / Enthusiasm each scored -2 to +2 |
| 3 | Signature moves listed | ≥3 signature phrases, cadences, or rhetorical moves the author uses |
| 4 | Vocabulary lists | "Prefer" + "avoid" lists, each ≥10 items |
| 5 | 2-3 writing samples scaffolded | Sample slots present with metadata (format, date, publication state) |
| 6 | No AI-generated samples | Authenticity check: samples flagged as authentic human writing |

### Pass/Fail Checklist

- [ ] Skill triggered on `voice profile` or `brand voice` keyword
- [ ] Both files created / templated
- [ ] All 4 NNGroup axes scored with numeric value, not just label
- [ ] Prefer list ≥ 10 items
- [ ] Avoid list ≥ 10 items
- [ ] Sample scaffold has ≥ 2 entries, ≥ 1 within-past-12-months
- [ ] Sample slots include authenticity attestation field
- [ ] AI-slop score on the profile doc itself ≥ 75 (no slop in the scaffolding)

### Failure Signatures to Log

| Symptom | Likely Cause |
|---------|--------------|
| Single-file output | Skill merged template + samples; violates v0.3.0 two-file contract |
| Axis scored as "medium" instead of numeric | Output format lost; re-run with explicit scoring directive |
| Sample slot populated with AI-generated example | Failure of authenticity check; flag as Critical |

---

## Scenario 7 — `ai-slop-reviewer` Gate

This scenario runs **after** each of Scenarios 1-6. It is the quality gate, not an independent scenario.

### Trigger

Automatic per v0.3.0 HARD rule: run `ai-slop-reviewer` on every output from content-marketer, doc-updater, or copywriting skill sessions. Manual trigger keyword: `slop check`, `writing quality`, `AI 패턴`, `슬롭 검사`.

### Manual Execution

1. Take the output from any of Scenarios 1-6.
2. Prompt: `"Run the ai-slop-reviewer on this text."`
3. Capture the Slop Review Report block.

### Required Structural Features

| # | Feature | Check |
|---|---------|-------|
| 1 | Score with label | Numeric 0-100 + label (Clean / Acceptable / Needs Work / Heavy Slop / Reject) |
| 2 | Pattern flag table | Line + pattern + severity + suggested fix |
| 3 | Structural issues table | Each structural problem localized to a section |
| 4 | Revised excerpt | Before/after rewrite for ≥2 highest-severity flags |
| 5 | 10-check checklist | All 10 Quality Checklist rows with Pass/Fail |
| 6 | Final recommendation | One sentence: publish / revise / discard |

### Pass/Fail Checklist for the Gate Itself

- [ ] Score report generated in full output format
- [ ] Pattern flag table populated (even if empty, shows "no slop flags found")
- [ ] Structural issues table populated
- [ ] Revised excerpt contains real before/after strings (not placeholders)
- [ ] All 10 checklist rows have explicit Pass/Fail markers
- [ ] Final recommendation is one of three allowed verdicts
- [ ] Boilerplate transitions ("Additionally", "Moreover", "In conclusion" chains): **0 found** in the reviewed text
- [ ] Excess emoji in professional context: **0 found**
- [ ] Hedge stacks (3+ qualifiers in one clause): **0 found**
- [ ] Announcement openers ("In this post, we will explore…"): **0 found**

A scenario (1-6) passes the overall smoke test only when its slop review comes back with score ≥ 75 AND the four auto-flag rows above show 0 occurrences.

---

## Results Log Template

Copy this table into a new file `results-YYYY-MM-DD.md` when running the smoke tests. One row per scenario run.

| Scenario | Date | Skill triggered? | Structural pass | Rubric total | Slop score | Critical flags | Overall |
|----------|------|------------------|-----------------|--------------|------------|----------------|---------|
| 1 long-form-writing |  | ☐ |  / 9 |  /100 |  /100 |  | Pass / Fail |
| 2 case-study |  | ☐ |  / 9 |  /100 |  /100 |  | Pass / Fail |
| 3 column-editorial |  | ☐ |  / 8 |  /100 |  /100 |  | Pass / Fail |
| 4 thought-leadership |  | ☐ |  / 6 |  /100 |  /100 |  | Pass / Fail |
| 5 interview-storytelling |  | ☐ |  / 6 |  /100 |  /100 |  | Pass / Fail |
| 6 voice-reference |  | ☐ |  / 6 | N/A (scaffold) |  /100 |  | Pass / Fail |
| 7 ai-slop-reviewer gate |  | ☐ |  / 6 | N/A | run-per-above |  | Pass / Fail |

---

## Regression Watchlist

Bugs worth a dedicated re-test if they ever appear:

| Bug | First seen | Last seen | Re-test every |
|-----|-----------|-----------|---------------|
| Question-style H2 ratio drops below 40% on long-form | — | — | Every release |
| Case study ships with after-only metrics | — | — | Every release |
| Column softens thesis to "it depends" | — | — | Every release |
| Thought-leadership ghostwriting disclosure omitted | — | — | Every release |
| Interview fabricates quotes not present in source | — | — | Every release (Critical class) |
| Voice-reference merges two files into one | — | — | Minor releases |
