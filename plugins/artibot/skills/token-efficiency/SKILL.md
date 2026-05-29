---
context: fork
user-invocable: false
name: token-efficiency
description: |
  Intelligent token optimization engine with adaptive compression and persona-aware output.
  Auto-activates when: context usage >75%, large-scale operations, --uc flag, output exceeds budget.
  Triggers: compress, efficient, tokens, --uc, large output, context limit
lang: [en]
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
source_hash: 2eccc99a
whenNotToUse: "Short sessions with low context usage where compression would degrade output clarity; do not apply when context is under 60% and no explicit --uc flag is set."
---

# Token Efficiency Engine

## When This Skill Applies
- Context window usage exceeds 60%
- Large-scale operations spanning many files
- Explicit `--uc` / `--ultracompressed` flag
- Output exceeds token budget for complexity level
- Emergency compression needed (context >95%)

> Claude 4.7+/4.8 신 토크나이저는 최대 1.35배 토큰을 소비하므로 기존 임계값에 1.35 안전 버퍼 필요 (75% → 60%).

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

See `${CLAUDE_SKILL_DIR}/references/symbol-system.md` for the complete symbol table.

## Workflow Checklist

Copy this checklist and track progress:

```
Progress:
- [ ] Step 1: Detect context usage level (0-40% / 40-70% / 70-85% / 85-95% / 95%+)
- [ ] Step 2: Select compression level (minimal / efficient / compressed / critical / emergency)
- [ ] Step 3: Apply symbol substitution for verbose phrases
- [ ] Step 4: Apply abbreviation system for repeated terms
- [ ] Step 5: Optimize structure — tables over prose, bullets over paragraphs
- [ ] Step 6: Validate >=95% information preservation
```

## Human Checkpoints

### Checkpoint 1: 압축 레벨 적합성 확인 (After Step 2)
**Context**: 컨텍스트 사용률을 감지한 후 압축 레벨을 선택하는 시점입니다. 잘못된 레벨 선택은 불필요한 정보 손실(과압축) 또는 컨텍스트 초과(미압축)를 초래할 수 있습니다.
**Ask**: "선택된 압축 레벨이 **현재 상황에 적합한가요**? 컨텍스트 사용률과 작업 복잡도를 고려해 확인해 주세요."
**Options**:
1. Minimal — 0-40% 컨텍스트, 가벼운 압축으로 충분함
2. Efficient — 40-70% 컨텍스트, 균형 잡힌 압축 적용
3. Compressed — 70-85% 컨텍스트, 심볼과 약어 적극 활용
4. Critical — 85-95% 컨텍스트, 핵심 내용만 유지
**Default**: 2 (중간 수준이 대부분의 상황에서 안전한 선택)
**Skippable**: Yes (컨텍스트 임계값이 명확하면 자동 선택 가능)
**Freedom**: LOW

### Checkpoint 2: 압축 결과물 품질 검증 (After Step 6)
**Context**: 모든 압축 기법을 적용한 후, 95% 이상의 정보 보존 목표가 달성되었는지 확인하는 최종 시점입니다. 압축이 지나쳐 핵심 내용이 손실되면 전체 작업이 무의미해집니다.
**Ask**: "압축된 결과물이 **여전히 명확하고 완전한가요**? 중요한 정보가 손실되지 않았는지 검토해 주세요."
**Options**:
1. Accept — 정보 보존이 95% 이상이며 결과물이 명확함
2. Decompress specific sections — 특정 섹션이 과압축되어 명확성이 떨어짐, 해당 부분만 복원
**Default**: 1 (압축 기법을 올바르게 적용했다면 품질이 유지됨)
**Skippable**: No — 정보 손실 없이 압축이 완료되었는지 반드시 확인해야 함
**Freedom**: MEDIUM

## Freedom Levels

| Step | Freedom | Guidance |
|------|:-------:|----------|
| Detect context level | LOW | Thresholds are defined (40/70/85/95%) |
| Select compression | LOW | Level maps directly to context percentage |
| Symbol substitution | MEDIUM | Symbol table defined, application context varies |
| Abbreviation system | MEDIUM | Abbreviations defined, audience familiarity varies |
| Structural optimization | HIGH | Many valid approaches to restructure content |
| Validate preservation | LOW | >=95% information preservation is non-negotiable |

## Rationalizations

The following table captures common excuses agents make to skip the discipline of this skill, paired with factual rebuttals.

| Excuse | Rebuttal |
|--------|----------|
| "the context window is big enough" | "big enough" until it isn't — efficiency is how you stay below the ceiling under unpredictable load |
| "compression loses nuance" | well-designed compression preserves semantics; the lost nuance was usually noise anyway |
| "optimizing tokens is premature" | tokens are dollars and latency — there's no "premature" about it |
| "persona-aware output is cosmetic" | persona-aware output reduces re-asks, which is the single biggest hidden token cost |
| "I'll optimize when I hit the limit" | at the limit, optimization options collapse to "truncate" — optimize early while you still have choices |
