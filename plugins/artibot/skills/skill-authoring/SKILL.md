---
context: fork
disable-model-invocation: true
name: skill-authoring
description: "Use when creating or editing a SKILL.md. 자연어 트리거: '스킬 만들어줘', '새 스킬 추가', '스킬 작성해줘', 'skill 만들기', '스킬 프론트매터 고쳐줘', 'create a skill', 'edit SKILL.md'."
lang: [en, ko]
platforms: [claude-code, gemini-cli, codex-cli, cursor]
level: 2
triggers:
  - "SKILL.md 만들어줘"
  - "새 스킬 추가"
  - "스킬 작성"
  - "skill 만들기"
  - "create a skill"
  - "새 스킬"
  - "스킬 추가"
agents:
  - "doc-updater"
  - "architect"
tokens: "~3K"
category: "meta"
whenNotToUse: "Editing a skill's body content when the frontmatter is already correct and the change is a minor prose fix. Do not apply the full pressure-test loop for trivial description typos."
---

# Skill Authoring (Meta-Skill)

How to author a new Artibot SKILL.md that survives adversarial conditions and passes CI gates.

## 1. Pressure-Test First (RED → GREEN)

Before writing a word of the skill, observe how an agent fails without it.

1. Imagine the exact scenario where the skill should fire. Run it mentally (or in a scratch session) without the skill.
2. Document the specific failure mode: Does the agent guess wrong? Skip a required step? Produce output that immediately looks wrong?
3. Write the skill body to close that gap precisely — not to document what the skill "does", but to prevent the observed failure.
4. After writing, re-run the scenario mentally. If the failure no longer occurs, the skill is earning its tokens.

**Anti-pattern**: Writing a skill because a concept "seems useful". Skills authored without a pressure test become dead weight — they load tokens every session but change no behavior.

## 2. CSO Rule: Description = Trigger Conditions Only

The `description` frontmatter field is read by the model *before* loading the skill body. If it summarizes the workflow, the model acts on the summary and never reads the body — this is the Claude Skips Onboarding (CSO) failure.

**Compliant description**: answers only "WHEN does this skill fire?" — triggers, activation conditions, example user utterances.

**Non-compliant description**: contains pipeline steps, numbered sequences, arrow chains, or procedural verb lists ("decomposes, executes, verifies").

The lint gate `scripts/ci/lint-skill-descriptions.js` enforces this automatically:
- **R1 (error)**: ≥3 activation signals required.
- **R2 (error)**: No pipeline tokens, arrow chains, numbered steps, or 3-verb procedural chains.
- **R3 (warn)**: Description > 1024 chars.

Run locally: `node scripts/ci/lint-skill-descriptions.js` (exits non-zero on new violations). CI runs `npm run skill:check`.

## 3. Trigger Design

Triggers are what the model matches against incoming user utterances to decide whether to load this skill at all.

**Rules**:
- Include ≥3 real user utterances, at least one in Korean.
- Cover implicit signals (not just explicit requests) — a user asking "how do I structure this?" while editing a SKILL.md is an implicit trigger.
- Match on intent, not keywords. "새 스킬 추가" and "SKILL.md 만들어줘" express the same intent differently.
- When the trigger fires: act immediately. Do not ask "are you sure you want me to create a skill?" — that violates the auto-invoke principle.

**Format**: YAML array under `triggers:` key. Each item is a string, quoted if it contains colons or special chars.

## 4. @-Link Prohibition

Do not embed `@filename` references in skill bodies to force-load other files.

Reason: Each `@file` expands inline into the context window at load time. A skill that loads three other files has effectively consumed three files worth of tokens before the agent has done a single thing. On long sessions, this starves the model of working context when it needs it most.

**Instead**: Reference by name only. Write `see the principles skill` or `consult ARCHITECTURE.md` — let the agent decide whether to read it.

## 5. Letter vs. Spirit: No Rationalization

"I honored the spirit of this skill" is not an acceptable completion claim.

If a step in this skill is skipped, state explicitly: which step, why it was blocked, what was done instead. Rationalization is the pattern where an agent reframes a shortcut as compliance. The table below captures the common forms:

| Rationalization | Rebuttal |
|---|---|
| "The description already has enough triggers, no need to count" | R1 is a hard count — fewer than 3 activation signals fails CI regardless of gut feel |
| "The body explains the workflow, so the description summary is fine" | CSO fires before the body loads; the description summary becomes the only guidance the model acts on |
| "This skill is simple enough to skip the pressure test" | Skipping the pressure test is how skills end up doing nothing in adversarial conditions |
| "I'll add triggers later when the skill is more mature" | A skill with weak triggers is invisible to the model — it never fires, so it never matures |
| "@-links make the skill self-contained and easy to use" | Self-contained at the cost of context window is a net loss; reference by name, load on demand |

## 6. Failure-Mode Diagnostic Vocabulary

When a skill misbehaves, name the failure precisely before fixing it — a vague complaint produces a vague fix.

- **Premature completion** — the agent stops before finishing a step because the completion criterion was ambiguous. First defense: sharpen the criterion into something checkable (a command that exits 0, a count that matches). Splitting the step into smaller pieces is a last resort, not the first move.
- **Duplication** — the same guidance restated in multiple places. Costs tokens twice and distorts the section's apparent importance relative to the rest of the skill.
- **Sediment** — old instructions nobody removes because deletion feels risky and addition feels safe. The default fate of any skill without active pruning discipline.
- **Sprawl** — every line is individually justified but the whole is too long to hold in attention. Fix with progressive disclosure (move reference material to a separate file the agent reads on demand) or split into a branch skill. Artibot's 500-line cap is a partial backstop, not a cure.
- **No-op** — a line that states behavior the model already does by default ("be thorough", "write clean code"). Test: does this sentence change behavior relative to the model's baseline? If it can't, delete it.
- **Negation** — steering by prohibition backfires ("don't think of an elephant" summons the elephant). State the target behavior positively. Reserve prohibition for hard guardrails that genuinely cannot be phrased as a positive instruction, and pair each one with the alternative action to take instead.

## 7. Leading Words

Anchor behavior with single words the model already has compressed meaning for from pretraining (*tight*, *idempotent*, *tracer bullet*) instead of multi-sentence restatements.

- If a phrase takes three sentences to say what one trained-in word already means — "fast, deterministic, low-overhead" collapses to *tight* — use the word.
- Repeat the same leading word in both `description` and body: in the description it raises activation confidence (the model recognizes the concept and fires the skill); in the body the same word keeps execution consistent with what the description promised.

## Frontmatter Checklist

| Field | Required | Rule |
|---|---|---|
| `name` | Yes | Must match directory name exactly (CI enforces) |
| `description` | Yes | CSO-compliant: triggers only, ≥3 signals, no workflow prose |
| `context` | Yes | One of: `fork`, `forked`, `native`, `shared` |
| `triggers` | Yes | Non-empty array of activation utterances (≥3, include Korean) |
| `platforms` | Recommended | Array from valid list (claude-code, gemini-cli, codex-cli, cursor) |
| `level` | Recommended | 1–5 integer |
| `category` | Recommended | One of the valid categories in gen-skill-docs.js |
| `whenNotToUse` | Recommended | Single sentence scoping when NOT to load this skill |
| `tokens` | Recommended | Estimated token cost string, e.g. `"~2K"` |
| `agents` | Recommended | Which agents most benefit from this skill |
| `disable-model-invocation: true` | Situational | 릴리즈·스케줄·세션로그류처럼 모델이 임의 자동호출하면 안 되는 스킬에 추가 — 자동호출 차단 |
| `allowed-tools: [...]` | Recommended | 스킬이 실제 사용하는 도구만 최소 화이트리스트로 명시 — 과다권한 차단 |

## Verification Before Committing

1. Run `node scripts/ci/lint-skill-descriptions.js` — must show no NEW violations for `skill-authoring`.
2. Run `npm run skill:check` — exits 0.
3. Read the description aloud: does it answer "when does this fire?" and nothing else? If you find yourself describing steps, rewrite.
4. Count triggers in the `triggers:` array — at least 3, at least 1 Korean utterance.
