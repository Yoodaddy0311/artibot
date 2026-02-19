---
name: token-efficiency
description: |
  Intelligent token optimization engine with adaptive compression and persona-aware output.
  Auto-activates when: context usage >75%, large-scale operations, --uc flag, output exceeds budget.
  Triggers: compress, efficient, tokens, --uc, large output, context limit
platforms: [claude-code, gemini-cli, codex-cli, cursor]
level: 2
triggers:
  - "compress"
  - "efficient"
  - "tokens"
  - "--uc"
  - "large output"
  - "context limit"
  - "ultracompressed"
agents:
  - "orchestrator"
  - "performance-engineer"
tokens: "~2K"
category: "tooling"
---

# Token Efficiency Engine

## When This Skill Applies
- Context window usage exceeds 75%
- Large-scale operations spanning many files
- Explicit `--uc` / `--ultracompressed` flag
- Output exceeds token budget for complexity level
- Emergency compression needed (context >95%)

## Core Guidance

### Compression Levels
| Level | Context | Reduction | Strategy |
|-------|---------|-----------|----------|
| Minimal | 0-40% | Light | Full detail, persona-optimized |
| Efficient | 40-70% | Moderate | Balanced with domain awareness |
| Compressed | 70-85% | Aggressive | Symbols + abbreviations |
| Critical | 85-95% | Maximum | Essential context only |
| Emergency | 95%+ | Ultra | Information validation required |

### Key Techniques
1. **Symbol substitution**: Replace verbose phrases with symbols (see references/symbol-system.md)
2. **Abbreviation system**: `cfg`, `impl`, `arch`, `perf`, `deps`, `val`, `sec`
3. **Structural optimization**: Tables > prose, bullets > paragraphs
4. **Redundancy elimination**: Remove repeated context, merge similar items
5. **Code-first output**: Show code with minimal explanation

### Quality Preservation
- Target: 30-50% token reduction
- Constraint: >=95% information preservation
- Speed: <100ms compression decision
- Never compress: Error messages, security warnings, user-facing content

## Quick Reference

### Core Symbols
`->` leads to | `=>` transforms | `&` and | `|` or | `>>` sequence
`:.` therefore | `∵` because | `~=` approximately | `!=` not equal

### Status
`[ok]` passed | `[x]` failed | `[!]` warning | `[i]` info | `[~]` in progress

See `references/symbol-system.md` for the complete symbol table.
