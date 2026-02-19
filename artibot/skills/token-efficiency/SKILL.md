---
name: token-efficiency
description: |
  Intelligent token optimization engine for Artibot.
  Adaptive compression with context awareness, symbol system,
  and progressive enhancement for efficient communication.

  Use proactively when context usage exceeds 60%,
  large-scale operations are in progress, or --uc flag is set.

  Triggers: compress, efficient, token, optimize output,
  brevity, concise, ultracompressed, --uc,
  압축, 효율, 토큰, 간결, 圧縮, 効率

  Do NOT use for: educational explanations, detailed tutorials,
  or when user explicitly requests verbose output.
---

# Token Efficiency Engine

> Evidence-based compression achieving 30-50% token reduction with 95%+ information preservation.

## When This Skill Applies

- Context usage exceeds 60% (auto-activation)
- User requests brevity or concise output
- `--uc` / `--ultracompressed` flag is set
- Large-scale operations (>20 files)
- Multi-agent coordination with high token overhead

## Compression Levels

| Level | Context Usage | Strategy |
|-------|-------------|----------|
| Minimal | 0-40% | Full detail, persona-optimized clarity |
| Efficient | 40-60% | Balanced compression, domain-aware |
| Compressed | 60-75% | Aggressive optimization with quality gates |
| Critical | 75-90% | Maximum compression preserving essentials |
| Emergency | 90%+ | Ultra-compression with validation |

## Core Techniques

### 1. Symbol System

Use structured symbols for flow and status (see `references/symbol-system.md`):

**Flow**: `->` leads to, `=>` transforms, `&` combine, `|` separator, `>>` sequence
**Status**: PASS, FAIL, WARN, INFO, WIP, WAIT, CRIT
**Causation**: `therefore` / `because` for reasoning chains

### 2. Structured Abbreviations

| Full | Short | Context |
|------|-------|---------|
| configuration | cfg | system |
| implementation | impl | code |
| performance | perf | optimization |
| dependencies | deps | packages |
| validation | val | verification |
| documentation | docs | guides |

### 3. Structural Optimization

- Tables over prose for comparisons
- Bullet points over paragraphs for lists
- Code blocks only for actionable code
- Omit obvious context, state only non-obvious findings

### 4. Context-Aware Compression

- **Architect persona**: Preserve structural clarity, compress examples
- **Performance persona**: Preserve metrics, compress explanations
- **Security persona**: Preserve vulnerability details, compress remediation boilerplate
- **Mentor persona**: Minimal compression (teaching requires detail)

## Output Format (Compressed Mode)

```
## [Title]

[Finding/Action] -> [Result/Impact]

| Item | Status | Detail |
|------|--------|--------|
| ... | PASS/FAIL | ... |

Next: [actionable next step]
```

## Performance Targets

- Token reduction: 30-50% vs uncompressed
- Information preservation: >=95%
- Processing overhead: <100ms per decision

## References

- `references/symbol-system.md` - Complete symbol and abbreviation reference
