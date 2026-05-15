---
context: fork
name: clarify
description: |
  Hypothesis-based clarification pipeline that transforms ambiguous user requests
  into precise, actionable specifications through structured MCQ (multiple-choice questions).
  Classifies ambiguity into three types: vague (unclear intent), unknown (missing information),
  metamedium (scope/boundary undefined). Generates targeted questions per type.
  Auto-activates when: ambiguity score >= threshold, multi-intent conflicts detected,
  or user explicitly asks for clarification.
  Triggers: clarify, unclear, what do you mean, ambiguous, vague, specify, 명확히, 구체적으로, 뭘 원하시는지
lang: [en, ko]
platforms: [claude-code, gemini-cli, codex-cli, cursor]
level: 2
progressive_disclosure:
  enabled: true
  level1_tokens: 100
  level2_tokens: 3000
triggers:
  - "clarify"
  - "unclear"
  - "what do you mean"
  - "ambiguous"
  - "vague"
  - "specify"
  - "명확히"
  - "구체적으로"
agent: Plan
agents:
  - "planner"
  - "orchestrator"
argument-hint: "[ambiguous-request] e.g., improve the app, add authentication"
tokens: "~2K"
category: "intent"
source_hash: e1f36028
whenNotToUse: "Do not trigger clarification for requests that are unambiguous, for tasks where clarifying would require more context than just starting, or when the user has already answered the same question in the current session. After 2 clarification rounds, proceed with stated assumptions."
---

# Clarify: Hypothesis-Based Requirement Clarification

Use `$ARGUMENTS` to provide the ambiguous request to clarify.

## When This Skill Applies
- User request triggers multiple conflicting intents (ambiguity score >= threshold)
- Request is too broad to produce a meaningful plan
- Critical dimensions are missing (target, scope, constraints, acceptance criteria)
- User explicitly asks to clarify or refine a requirement
- Cognitive router detects System 2 complexity but intent remains unclear

## The Three Ambiguity Types

### 1. Vague (Intent Unclear)
The user has an idea but hasn't articulated what they want.

| Signal | Example |
|--------|---------|
| Action verb missing | "the login page" |
| Multiple possible actions | "do something about performance" |
| Hedging language | "maybe we should look at..." |
| Overly general | "improve the app" |

**Strategy**: Present concrete hypothesis options derived from context.

### 2. Unknown (Information Missing)
The user knows what they want but hasn't provided enough detail.

| Signal | Example |
|--------|---------|
| Missing target | "add validation" (to what?) |
| Missing constraints | "make it faster" (how fast? what metric?) |
| Missing scope | "fix the bug" (which bug? which module?) |
| Missing acceptance criteria | "it should work better" |

**Strategy**: Ask for the specific missing dimension, one at a time.

### 3. Metamedium (Scope/Boundary Undefined)
The user's request could be tiny or massive depending on interpretation.

| Signal | Example |
|--------|---------|
| Elastic scope | "add user authentication" (social login? MFA? RBAC?) |
| Ambiguous depth | "refactor the database layer" (schema? queries? ORM?) |
| Unclear boundary | "integrate with Stripe" (checkout? subscriptions? invoicing?) |
| Version ambiguity | "update the API" (breaking changes? backward compat?) |

**Strategy**: Present scope tiers (minimal / standard / comprehensive) as hypotheses.

## The Clarification Process

```
Step 1: CLASSIFY the ambiguity type
  - Analyze input against vague/unknown/metamedium signals
  - A single input may have multiple types

Step 2: GENERATE hypothesis-based questions
  - Maximum 5-8 questions total (question fatigue prevention)
  - Use MCQ format (multiple choice) when possible
  - Each question resolves exactly one ambiguity dimension
  - Order: most impactful dimension first

Step 3: PRESENT as Before/After transformation
  - Show the vague input vs. what a clarified version looks like
  - Make the value of answering visible

Step 4: COLLECT answers and SYNTHESIZE
  - Merge answers into a refined specification
  - Confirm the refined spec with the user
  - If still ambiguous, repeat (max 2 rounds)
```

## Question Templates by Type

### Vague (Intent)
```
Your request "[input]" could mean several things. Which is closest to what you need?

A) [hypothesis derived from context analysis]
B) [alternative interpretation]
C) [third option if applicable]
D) Something else (please describe)
```

### Unknown (Missing Info)
```
To [action], I need to know:

1. [Missing dimension]?
   - Option A: [common choice]
   - Option B: [alternative]
   - Option C: [other]
```

### Metamedium (Scope)
```
"[input]" can range from simple to comprehensive:

| Tier | What's Included | Effort |
|------|----------------|--------|
| Minimal | [bare minimum] | ~[time] |
| Standard | [typical implementation] | ~[time] |
| Comprehensive | [full-featured] | ~[time] |

Which tier fits your needs?
```

## Before/After Visualization

Always show the transformation value:

```
BEFORE (ambiguous):
  "add authentication to the app"

AFTER (clarified):
  "Add email/password authentication to the Express.js backend API
   with JWT tokens, bcrypt password hashing, and login/register/logout
   endpoints. No social login. No MFA. Session expires after 24h."
```

## Integration with Intent Pipeline

This skill works with `lib/intent/ambiguity.js`:

1. `detectAmbiguity()` flags high-ambiguity inputs
2. `classifyAmbiguityType()` determines vague / unknown / metamedium
3. `generateClarifyingQuestions()` produces type-specific MCQ questions
4. Answers feed back into `detectIntent()` for refined routing

## Constraints

- **Max 5-8 questions per round** -- question fatigue degrades user experience
- **Max 2 clarification rounds** -- if still unclear after 2 rounds, proceed with best hypothesis and note assumptions
- **MCQ preferred over open-ended** -- reduces cognitive load, faster to answer
- **One dimension per question** -- compound questions confuse
- **Context-aware** -- check project files, recent commits, open issues before asking. Don't ask what can be inferred

## Red Flags (Stop and Re-evaluate)
- Asking more than 8 questions in a single round
- Asking about information already visible in the codebase
- Repeating a question the user already answered
- Generating questions without classifying the ambiguity type first
- Skipping the Before/After visualization

## Rationalizations

The following table captures common excuses agents make to skip the discipline of this skill, paired with factual rebuttals.

| Excuse | Rebuttal |
|--------|----------|
| "the request is obvious, I'll just start" | obvious requests have 3+ valid interpretations on average; the rework from the wrong one costs 10x a clarifying question |
| "asking questions feels slow" | silent assumptions feel fast until the user rejects the output — then you've paid both the build cost and the rework cost |
| "I'll infer from context" | inference fills gaps with your priors, not the user's; MCQ clarification surfaces the gap explicitly in one round-trip |
| "too many questions annoy the user" | one grouped MCQ with 3-5 options is less annoying than shipping the wrong thing and asking why |
| "ambiguity will resolve during implementation" | ambiguity compounds — every downstream decision inherits the original unclarity as a hidden assumption |

## Common Rationalizations

| Rationalization | Why it's wrong | What to do instead |
|---|---|---|
| "I can infer the intent from the codebase context" | Inference fills gaps with model priors, not the user's actual intent; the codebase tells you what exists, not what the user wants to change | Use codebase context to generate concrete hypothesis options in the MCQ, then let the user confirm |
| "Asking questions makes me look uncertain and slows delivery" | Delivering the wrong thing makes the model look incapable and costs more time; one round-trip MCQ is faster than one rework cycle | Frame clarifying questions as "I want to get this right the first time" — users universally prefer it |
| "The request is only slightly ambiguous, I'll pick the most likely interpretation" | "Most likely" is calibrated to training data, not to this user's context; even a 70% likely interpretation fails 30% of the time | When ambiguity is detected, always surface it explicitly even if you have a strong default |
| "I'll clarify mid-implementation when I hit the unclear part" | Mid-implementation clarification requires explaining the current state to the user, who then must understand it to answer; pre-implementation MCQ is context-free | Identify all ambiguity dimensions before writing a single line of code |
| "More than 5 questions covers edge cases more thoroughly" | Questions beyond 5 cause question fatigue and lower response quality; the answers to questions 6-10 are less useful than the answers to a well-chosen first 5 | Prioritize by impact — ask the 3-5 dimensions that most constrain implementation first |

## Red Flags

- Clarifying questions asked about information visible in the codebase or recent commits
- More than 8 questions in a single clarification round
- Same question asked in two consecutive clarification rounds
- Ambiguity type not classified before questions are generated
- Before/After visualization skipped in the clarification output
- Proceeding to implementation after round 3 without documenting stated assumptions
