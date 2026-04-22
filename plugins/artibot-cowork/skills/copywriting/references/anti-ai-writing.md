# Anti-AI Writing Guide

A reference for converting AI-generated text into writing that reads as if a specific human wrote it for a specific reader. This guide is not about hiding AI use — it is about producing output that is actually useful, specific, and honest.

---

## Section 1: Korean AI Pattern Blacklist

The following patterns appear in Korean AI output because they were prevalent in Korean internet text that models trained on. Each one substitutes the appearance of communication for actual communication.

| Pattern | Replacement | Why |
|---------|-------------|-----|
| 물론입니다 | (삭제) 또는 바로 답변 시작 | 입력을 받았다는 확인 외 정보 없음 |
| ~하겠습니다 | ~합니다 / ~하세요 | 관료적 미래형 헤지; 현재형이 명확함 |
| ~해 드리겠습니다 | ~합니다 / 진행합니다 | 서비스 스크립트 말투; 불필요한 과공손 |
| 중요한 것은 | (삭제 후 핵심 직접 서술) | 중요하다고 선언하기 전에 실제 내용을 씀 |
| 탁월한 선택 | (구체적 이유 제시) | 근거 없는 칭찬; 판단 기준이 없음 |
| 특히 | (삭제 또는 수치 대체) | 강조어로 남발; 실제로 특별한 것이 없는 경우 많음 |
| 다만 | 단, ~의 경우에는 / ~조건 하에서 | 약한 역접; 구체적 조건으로 교체 |
| 또한 | (추가가 실제로 필요한 경우에만 유지) | 연결어 남발로 문장 팽창 |
| 다양한 | [실제 항목 나열] 또는 [N]가지 | 수를 숨기는 복수형 모호어 |
| 그러나 | (실제 대조가 있을 때만 사용) | 약한 대조를 강한 역접으로 위장 |
| 혁신적인 | [무엇이 어떻게 바뀌는지 서술] | 기술 보도 상투어; 구체적 메커니즘으로 교체 |
| 포괄적인 | [실제 커버 범위 명시] | 완전성 주장; 무엇이 포함/제외인지 명시 |
| 효율적으로 | [수치] % 절감 / [N]시간 단축 | 효율 주장은 측정값으로만 유효 |
| 최적화 | [무엇을, 얼마나] | 변경 사항을 숨기는 마케팅 동사 |
| 세심하게 | (삭제 후 세심함을 보여주는 사례 제시) | 주의를 주장하는 대신 주의의 증거를 씀 |
| 철저한 | [검토한 항목 열거] | 철저함 주장; 철저함의 내용을 씀 |
| 완벽한 | 오류율 X% 이하 / 99.9% 가용성 | 검증 불가 절대 주장 |
| 독자적인 | [차별화 메커니즘 서술] | 차별성 주장 없이 차별성 선언 |
| 놀라운 | (삭제 후 놀라운 사실을 씀) | 감정 유도 전에 사실을 먼저 씀 |
| 강력한 | 초당 [N]건 처리 / [N]배 속도 | 강도 주장은 측정값으로만 유효 |
| 심층적인 | [다루는 계층/측면 명시] | 깊이 주장; 깊이의 내용을 씀 |
| 전반적으로 | (삭제 또는 구체적 범위 명시) | 범위를 흐리는 헤지 |
| 최선을 다해 | [결과 서술] | 노력 신호; 결과로 대체 |
| ~에 대해 살펴보겠습니다 | (삭제 후 즉시 내용 시작) | 주제 예고 대신 주제 자체를 씀 |
| 매우 중요합니다 | [중요한 이유 + 결과 서술] | 이유 없는 중요성 선언 |

---

## Section 2: English AI Pattern Blacklist

| Pattern | Replacement | Why |
|---------|-------------|-----|
| Certainly | (delete, begin with substance) | Hollow affirmation; model's acknowledgment sound |
| Absolutely | (delete, begin with substance) | Same as "certainly"; AI-tells immediately |
| Of course | (delete, answer directly) | Implies question was obvious; condescending |
| Delve into | examine / look at / analyze | Pseudo-scholarly; marker of AI academic-style voice |
| Dive deep | [specify: analyze X factors / examine Y] | Action metaphor without specific action |
| Comprehensive | [list what is actually included] | Completeness claim that is never demonstrated |
| Robust | [specify load, condition, or stress it handles] | Engineering word applied to everything |
| Leverage | use / apply / draw on | Corporate-speak for "use"; immediate AI signal |
| Utilize | use | Formal synonym for "use" with no additional meaning |
| Seamlessly | [describe the actual integration mechanism] | Zero-friction claim; untestable as written |
| Innovative | [describe what it changes and for whom] | Attached to every product; means nothing alone |
| Cutting-edge | [name the specific technology or version] | Superlative that expires the moment it is written |
| Revolutionize | [describe the specific behavioral change] | Overstates; sets undeliverable expectations |
| Game-changer | [state the measurable impact] | Used when no specific impact is known |
| Paradigm shift | [describe the actual shift in thinking or practice] | Academic buzzword; almost always hyperbole |

---

## Section 3: Structural AI Patterns

Structural slop is harder to detect with word-level scanning. These patterns are about how text is organized, not which words appear.

| Structural Problem | Symptom | Fix |
|-------------------|---------|-----|
| Bullet-point dump | Every thought becomes a bullet, including narrative reasoning | Convert to prose paragraphs when ideas are causally linked |
| Non-sequential numbering | Numbered list where items have no order dependency | Use unordered bullets or prose; numbers signal sequence |
| Topic-announcement opener | First sentence names the topic instead of addressing it | Cut the announcement; lead with the first claim or finding |
| Hollow summary closer | Final paragraph repeats what was just said | End with the next action, implication, or open question |
| Symmetry padding | Sections padded to match each other in length | Sections end when content ends |
| Hedge stack | Multiple qualifiers in one clause ("might potentially possibly") | One qualifier maximum per clause |
| Header inflation | H3 or H4 on every paragraph | Headers only when readers need navigation across sections |
| Parallel structure as substitute for logic | Three-part lists where only two parts are real | Write the actual relationship; do not force parallelism |
| Emotion-first, fact-second | Adjective before the supporting fact | State the fact first; let the reader feel the impact |
| Generic call-to-action | "Feel free to reach out" at end of every piece | Specific CTA tied to the actual content and reader goal |

---

## Section 4: Natural Style Rules

### Rule 1: Concrete beats abstract

Every abstract noun has a concrete version. "Strategy" becomes "the decision to reduce ad spend by 40% and shift to organic." Write the concrete version first; the abstract label is optional.

### Rule 2: Active voice by default

Passive voice conceals the agent and weakens claims. "The campaign was launched" hides who launched it and implies the writer does not know or does not want to say. Write "We launched the campaign on March 3" unless the agent genuinely does not matter.

### Rule 3: Short sentences anchor long ones

Prose rhythm comes from variation. A sequence of 25-word sentences reads like legal text. A sequence of 8-word sentences reads like a list. Alternate: one short sentence that makes a claim, one longer sentence that qualifies or proves it.

### Rule 4: Examples before principles

Readers remember stories, then extract rules. Lead with a specific example — a company, a number, a person's decision — then state the principle. Not: "Anchoring affects price perception." Instead: "When Airbnb added a $500/night listing at the top of search results, bookings for $150 listings increased 30%. That is anchoring."

### Rule 5: Address the reader directly

"You" is the most powerful word in non-fiction writing. It forces specificity: you must imagine the reader to use it accurately. If you cannot write "you" without it feeling wrong, you do not know who the reader is. Find out before writing.

### Rule 6: Remove adjectives until they hurt

Delete every adjective from a draft. Read it. Add back only the adjectives whose absence changes the meaning or loses a fact. Decorative adjectives ("robust solution", "innovative approach") add no information; they signal the writer could not find the fact.

### Rule 7: Use contrast and analogy

Readers understand new things through comparison to known things. "Our latency is 40ms" is hard to feel. "Our latency is 40ms — roughly the time between a keypress and a character appearing on screen" is felt. Every technical claim benefits from one comparison.

### Rule 8: Anchor claims with numbers

Quantities transform assertions into evidence. "We reduced churn" is an assertion. "We reduced monthly churn from 4.2% to 1.8% over 90 days" is evidence. Use specific numbers wherever they exist. If none exist, question whether the claim should be made.

### Rule 9: Vary sentence length deliberately

Read your draft aloud and count syllables in consecutive sentences. If three or more sentences in a row are the same approximate length, restructure. The ear detects mechanical rhythm before the eye does.

### Rule 10: Own a position

Hedged writing ("it may be argued that", "some might say", "there are those who believe") signals the writer has no view of their own and is avoiding accountability. State a position. Qualify it if necessary, but own the qualification: "This works for SaaS with monthly billing. It will not work for transactional e-commerce." Specific limits are more honest than universal hedges.

---

## Section 5: Self-Review Checklist

Use this checklist before marking any content complete. Each check is a binary pass/fail.

| # | Check | How to Test | Pass Condition |
|---|-------|-------------|----------------|
| 1 | No affirmation opener | Read first sentence of every paragraph | None start with "Certainly", "물론", "Absolutely", "Of course" |
| 2 | Adjective support | Highlight every adjective; look for supporting fact within 2 sentences | Every adjective is backed by evidence or is deleted |
| 3 | Bullet discipline | Count bullets per section | No section has bullets where prose would serve better |
| 4 | No topic announcement | Read first sentence of piece and each section | Openings deliver a claim, not a topic name |
| 5 | No hollow summary | Read final paragraph | Conclusion adds new information or next action |
| 6 | Hedge count | Count qualifiers per sentence | Maximum 1 qualifier per sentence throughout |
| 7 | Emoji count | Count emoji | 0 in professional content; max 1 in casual |
| 8 | Specificity scan | Highlight nouns without quantities | All key claims have at least one number, name, or date |
| 9 | Active voice | Count passive constructions | Active voice in more than 80% of sentences |
| 10 | Read aloud test | Read entire piece at speaking pace | No sentence sounds like a press release or legal document |
