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
agents:
  - "planner"
  - "orchestrator"
argument-hint: "[ambiguous-request] e.g., improve the app, add authentication"
tokens: "~2K"
category: "intent"
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
