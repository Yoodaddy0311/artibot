# Documentation Archetype Defaults

Loaded when a user runs persona-scribe without existing voice samples or style references. Each archetype provides default structure, tone, and formatting conventions. Always tune every field using project context before writing. Flag inside the output that archetype defaults were used and recommend revisiting after 5 published documents.

---

## 1. Technical reference

Best for: API documentation, library guides, system manuals.

**Opening formula**
State what the document covers and who it is for in one sentence. End with a scope boundary.

Template: "This document covers [scope] for [audience]. It does not cover [exclusion]."

**Section flow**
1. Overview (what and why) -- 50 to 100 words
2. Prerequisites (what the reader needs before starting) -- 50 to 100 words
3. Core concepts (definitions, architecture, key terms) -- 200 to 400 words
4. Usage (step-by-step with code examples) -- 300 to 600 words per section
5. API reference (signatures, parameters, return values) -- structured tables
6. Troubleshooting (common errors and fixes) -- 100 to 200 words
7. Changelog or version notes -- bulleted list

**Tone**: precise, neutral, no humor, no opinion
**Formatting**: headers, code blocks, tables for parameters, inline code for identifiers
**Length**: 1,000 to 5,000 words depending on scope

**What this archetype never does**
Uses marketing language. Buries the API signature in prose. Omits error codes. Assumes the reader knows the prerequisite stack.

---

## 2. Tutorial walkthrough

Best for: step-by-step learning content, onboarding guides, how-to articles.

**Opening formula**
State the end result the reader will achieve. Include estimated time.

Template: "By the end of this tutorial, you will have [concrete outcome]. Estimated time: [duration]."

**Section flow**
1. Goal statement (what you will build/learn) -- 50 words
2. Prerequisites -- 50 to 100 words
3. Steps (numbered, each with code + explanation) -- 200 to 400 words per step
4. Verification (how to confirm it works) -- 100 to 200 words
5. Next steps (where to go from here) -- 50 to 100 words

**Tone**: encouraging, clear, second person ("you")
**Formatting**: numbered steps, code blocks with comments, screenshots where relevant
**Length**: 800 to 3,000 words

**What this archetype never does**
Skips verification. Uses passive voice in instructions. Assumes knowledge not listed in prerequisites. Combines two unrelated tasks in one step.

---

## 3. Decision record

Best for: ADRs, RFCs, design documents, trade-off analyses.

**Opening formula**
State the decision and its status in one line. Context follows.

Template: "Decision: [what was decided]. Status: [accepted|proposed|deprecated]."

**Section flow**
1. Context (why this decision is needed) -- 100 to 200 words
2. Options considered (2-4, each with pros/cons) -- 150 to 300 words per option
3. Decision (which option and why) -- 100 to 200 words
4. Consequences (what changes, what risks remain) -- 100 to 200 words
5. References (related decisions, documents, tickets) -- bulleted links

**Tone**: neutral, evidence-driven, no advocacy for rejected options
**Formatting**: headers per section, tables for option comparison, bold for the chosen option
**Length**: 500 to 1,500 words

**What this archetype never does**
Omits rejected alternatives. Advocates without evidence. Leaves consequences unstated. References decisions without linking to them.

---

## 4. Changelog narrator

Best for: release notes, changelogs, migration guides, upgrade paths.

**Opening formula**
Version number and release date. One sentence on the most important change.

Template: "v[X.Y.Z] -- [date]. [Most important change in one sentence]."

**Section flow**
1. Headline change -- 50 words
2. Breaking changes (if any, with migration steps) -- 100 to 300 words
3. New features (bulleted, each with one-line description) -- 50 to 100 words each
4. Fixes (bulleted) -- 30 to 50 words each
5. Deprecations (with removal timeline) -- 50 to 100 words each

**Tone**: factual, compact, present tense for changes
**Formatting**: semantic versioning header, bulleted lists, code blocks for migration snippets
**Length**: 200 to 1,000 words

**What this archetype never does**
Buries breaking changes below new features. Uses vague descriptions ("various improvements"). Omits migration steps for breaking changes. Skips the deprecation timeline.

---

## 5. Internal runbook

Best for: operational playbooks, incident response, on-call procedures.

**Opening formula**
State the scenario this runbook addresses and when to use it.

Template: "Use this runbook when [trigger condition]. Expected resolution time: [estimate]."

**Section flow**
1. When to use (trigger conditions) -- 50 words
2. Prerequisites (access, tools, permissions) -- 50 to 100 words
3. Steps (numbered, each with expected output) -- 100 to 200 words per step
4. Escalation (when and to whom) -- 50 to 100 words
5. Post-incident (what to document after resolution) -- 50 to 100 words

**Tone**: imperative, direct, no ambiguity
**Formatting**: numbered steps, monospace for commands, callout boxes for warnings
**Length**: 300 to 1,500 words

**What this archetype never does**
Uses conditional language ("you might want to"). Omits escalation criteria. Assumes the reader has context from a prior incident. Puts optional steps inline with required steps.

---

## 6. User guide

Best for: end-user documentation, product guides, feature explanations.

**Opening formula**
Name the feature and what it helps the user accomplish.

Template: "[Feature name] helps you [user benefit]. This guide covers [scope]."

**Section flow**
1. What it does (plain language) -- 50 to 100 words
2. Getting started (first use, setup) -- 100 to 200 words
3. Common tasks (task-oriented sections) -- 200 to 400 words per task
4. Tips and best practices -- 100 to 200 words
5. FAQ or troubleshooting -- 100 to 200 words

**Tone**: friendly, task-oriented, second person, no jargon
**Formatting**: headers per task, screenshots or diagrams, callouts for tips
**Length**: 500 to 2,500 words

**What this archetype never does**
Explains implementation details. Uses developer terminology without definition. Organizes by feature instead of by task. Assumes the user reads linearly from top to bottom.
