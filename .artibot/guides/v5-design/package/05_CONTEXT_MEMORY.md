# Context & Memory

## Core rule

> **Context Quality > Context Quantity**

Artibot compiles the smallest context sufficient for correct reasoning.

```text
Mission
→ Current Action
→ Relevant Policy
→ Relevant Skills
→ Relevant Files
→ Evidence Pointers
→ Relevant Memory
→ Known Failure Patterns
→ Minimal Sufficient Context Package
```

## Evidence-pointer memory

Prefer storing file/path, line/range, artifact ID, test result, hash, decision, confidence and retrieval pointer instead of repeatedly copying large content into prompts.

## Memory precedence

```text
Current verified evidence
> Current source of truth
> Recent explicit user decision
> Relevant episodic memory
> Historical heuristic
```

## Context hygiene

Eliminate duplicate logs, repeated file content, stale summaries, irrelevant chat history, repeated tool outputs and unrelated skill instructions.

## Recoverable tool compression

Large tool outputs may be compressed when raw source remains recoverable. Avoid lossy compression of authority instructions, security rules, public API contracts, source code needed for exact patching, legal/compliance text and irreversible decision records.
