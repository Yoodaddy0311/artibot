---
context: fork
name: persona-distill
description: "Distill a person, role, or character into a reusable persona skill via the 6-layer schema. Use when the user wants to compile a colleague, an internal role archetype, or an authoring style into a persona-* skill — not when invoking an existing persona."
lang: [en]
platforms: [claude-code, gemini-cli, codex-cli, cursor]
level: 2
triggers:
  - "persona"
  - "distill"
  - "compile a colleague"
  - "compile a persona"
  - "role distill"
  - "persona overlay"
  - "페르소나 추출"
  - "페르소나 생성"
  - "인격 추출"
  - "역할 압축"
agents:
  - "llm-architect"
  - "doc-updater"
  - "planner"
allowed-tools:
  - Read
  - Write
  - Edit
tokens: "~5K"
category: "persona"
whenNotToUse: "Do not apply when an existing persona is already active in the session — switch personas via persona-architect instead. Do not apply when the user wants to invoke (use) a persona on a task — that's persona-architect's job. Do not apply for one-off tone shifts inside a single message; only use when producing a persisted, reusable persona-* skill from local source material."
---

# Persona Distill: Compile a Person into a Skill

## Contents
- [When This Skill Applies](#when-this-skill-applies)
- [When NOT to Use](#when-not-to-use)
- [Why Distill vs Static Templates](#why-distill-vs-static-templates)
- [Process](#process)
- [Common Rationalizations](#common-rationalizations)
- [Red Flags](#red-flags)
- [Verification](#verification)
- [See Also](#see-also)

## When This Skill Applies

- The user names a real person, role archetype, or character and wants them as a callable persona
- An existing `persona-*` skill needs a depth pass beyond a static template
- A team workflow needs to mimic a senior engineer's voice in code review or ADR authoring
- The user pastes source material (commits, ADRs, code-review comments, public writing) and asks for a "persona-ified" skill from it
- A repeating role expectation surfaces across sessions and would benefit from being canonicalized into one skill file

## When NOT to Use

- An existing persona is already loaded in this session — orchestrate via `persona-architect` instead of recompiling
- The request is a single-message tone shift ("answer like a grumpy senior dev"); no persisted artifact is needed
- The user wants to invoke a persona on a task, not author one — route to `persona-architect`
- Source material is third-party copyrighted content of a real public figure used for impersonation; refuse on policy grounds and offer a generic role-archetype distillation instead
- No local source material exists and the user has not described the target — ask for source files (commits, ADRs, paste) first

## Why Distill vs Static Templates

Artibot's existing `persona-architect`, `persona-frontend`, `persona-security`, etc. are **static templates** — hand-authored advice frameworks tied to a role. They are durable but shallow on behavioral fidelity (who would actually say this and how).

Distilled personas are **source-driven**: they start from a person's authored artifacts (commits, ADRs, PR comments, paste-ins) and compile a 6-layer schema where Layer 0 (hard rules) and Layer 5 (boundaries) are non-negotiable. The result is a persona that refuses on the same axes the source person refuses, and pushes on the same axes the source person pushes.

Use distill when the static template is too generic. Use the static template when behavioral depth would be over-engineering.

## Process

| Step | Action | Output |
|---|---|---|
| 1. DETECT | Identify the subject: real person (with consent), role archetype ("the senior backend engineer who hates over-engineering"), or character. Refuse impersonation of public figures without consent. | Subject card with name, role, scope of authority |
| 2. COLLECT | Gather LOCAL source material only: commits, ADR files, PR comments, paste-ins of writing. Reject any external HTTP fetch, external chat-API extraction, or audio transcription requests. | Source bundle (file paths + paste content) |
| 3. MAP | Walk the 6-layer schema (see `references/six-layer-persona.md`). Fill each layer from source evidence; never invent unsourced material. Apply Artibot tags from `references/tag-behavior-map.md` to convert tag → behavior. | Filled 6-layer draft |
| 4. GENERATE | Write `persona.md` (character) + optional `work.md` (capability profile) under `plugins/artibot/skills/persona-{slug}/`. Use Artibot frontmatter (`name`, `triggers`, `level: 3`, `category: persona`, `whenNotToUse`). | Skill artifact ready to lint |
| 5. VERIFY | Run the red-flag checklist below. Test invocation via `/team` mention or skill trigger. Confirm Layer 0 rules are concrete behaviors, not adjectives. | Pass/fail per red flag, fix iterations until clean |

### Step 1: DETECT subject

Ask three questions if not already answered:
1. Who is the persona? (real person with consent, role archetype, or fictional)
2. Why distill them? (what scenario triggers invocation)
3. What boundaries must they refuse? (explicit Layer 5 hints)

If the user names a real public figure without consent context, halt and offer a generic role archetype: "I'll distill 'a Senior Linux Kernel Maintainer'-style reviewer rather than this specific person."

### Step 2: COLLECT source material

Ingest only LOCAL paths and pasted content. Approved sources:
- Local git commits (`git log --author`)
- ADR files under `docs/adr/`
- PR review comments stored in local exports
- User-pasted writing samples (code reviews, design docs, postmortems)

REJECTED ingestion paths (DATA POLICY): external chat APIs (Slack/Feishu/DingTalk), browser scraping, audio transcription via external API, third-party MCP servers that route data outside Artibot. If the user requests these, refuse and propose a paste-in alternative.

### Step 3: MAP to 6 layers

Open `references/six-layer-persona.md` and fill each layer from source evidence. Quote the source line that justifies each Layer 0 rule. Layer 0 rules MUST be behaviors, not adjectives — see `references/tag-behavior-map.md` for the tag → behavior mapping.

If a layer has fewer than 2 source quotes supporting it, mark it with `(source-thin: refresh after collecting more material)`.

### Step 4: GENERATE the artifact

Create `plugins/artibot/skills/persona-{slug}/SKILL.md` with frontmatter:

```yaml
---
context: fork
name: persona-{slug}
description: "..."
level: 3
triggers: [...]
category: persona
agents: [...]
whenNotToUse: "..."
source_layer_0: |
  (Layer 0 rules verbatim, copied from the 6-layer draft)
---
```

Optional sibling: `work.md` (capability profile distinct from character). The two-doc split keeps role advice (work) separate from voice/attitude (persona).

### Step 5: VERIFY

Run the Red Flags list against the draft. If any flag fires, do not ship — return to Step 3 with concrete fixes. Pair with `code-reviewer` agent for skill-prose check.

## Common Rationalizations

| Rationalization | Why it's wrong | What to do instead |
|---|---|---|
| "I'll write the persona from the user's description, no source files needed" | A description-only persona regresses to a static template; behavioral fidelity requires concrete source evidence per layer | Insist on at least one source artifact (commit, ADR, paste) per Layer 0 rule before drafting |
| "Layer 0 can include adjectives like 'thorough' or 'careful'" | Adjectives don't constrain behavior; the persona will drift to LLM-default tone within two turns | Convert each adjective into a concrete behavior rule: "asks for measured baseline before proposing optimization" |
| "I'll skip the tag-behavior map for speed" | Without tags, Layer 0 rules duplicate across personas inconsistently; tags are the composable primitive | Apply at least 2 tags from `references/tag-behavior-map.md`; record tag list in frontmatter |
| "External chat exports are fine if the user provides them" | DATA POLICY blocks external SaaS data ingestion regardless of who provides the export | Accept only paste-ins of local copies; never invoke an external API even with credentials |
| "One source quote per layer is plenty" | Layers with single sources misgeneralize; the persona will refuse or push on patterns that aren't actually in the source | Require at least 2 quotes per non-trivial layer or mark the layer source-thin |

## Red Flags

- Layer 0 contains adjectives (thorough, careful, smart) instead of behavior rules
- Any layer cites zero source artifacts
- The output is just a renamed copy of an existing `persona-*` skill (no behavioral delta)
- The persona refuses on axes that aren't grounded in source material (LLM hedging leakage)
- Frontmatter omits `whenNotToUse` (per Squad B schema requirement)
- Source material includes external SaaS exports (Slack/Feishu/DingTalk) — DATA POLICY violation
- The persona's voice shifts to generic-LLM after the third sample exchange (drift; Layer 2 too thin)
- `tags` array is empty — composability lost
- `work.md` and `persona.md` contradict each other on capability claims

## Verification

Test the resulting persona by:

1. **Invocation test**: Trigger the skill via one of its declared `triggers` and confirm the `name` in frontmatter is loaded.
2. **Layer 0 stability**: Send three off-topic messages; confirm the persona still applies Layer 0 rules to its responses.
3. **Boundary test**: Ask the persona to do something explicitly listed in Layer 5; confirm refusal in the persona's voice (not a generic LLM refusal).
4. **Tag-behavior round-trip**: Apply a tag from `references/tag-behavior-map.md`, regenerate, and confirm the corresponding behavior rule appears in Layer 0 or Layer 3.
5. **Source-thin check**: Run a grep over the persona file for `source-thin` markers; resolve all before merging.
6. **Diff against static persona**: If a static `persona-*` already exists for this role, produce a diff showing at least 5 measurable behavioral deltas (specific phrasing, decision triggers, refusal patterns).

## See Also

- [persona-architect](../persona-architect/SKILL.md) — invokes existing personas; pair this skill to author new ones
- [References: six-layer-persona](references/six-layer-persona.md) — canonical Artibot 6-layer schema with worked example
- [References: tag-behavior-map](references/tag-behavior-map.md) — composable tag dictionary mapping tag → concrete behavior delta
- [source-driven-development](../source-driven-development/SKILL.md) — same source-citation discipline applied to framework code
- Benchmark source: `runtime/benchmark/colleague-skill-benchmark.md` (Adoption IDs AD-50, AD-51)
