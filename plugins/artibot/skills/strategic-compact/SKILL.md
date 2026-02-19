---
name: strategic-compact
description: |
  Context compaction strategy for preserving critical information during PreCompact events.
  Auto-activates when: context >75%, PreCompact triggered, long sessions, multi-phase tasks.
  Triggers: compact, context, compress, long session, context window, memory pressure
platforms: [claude-code, gemini-cli, codex-cli, cursor]
level: 2
triggers:
  - "strategy"
  - "compact"
  - "executive summary"
  - "strategic plan"
  - "priorities"
  - "OKR"
agents:
  - "architect"
tokens: "~2K"
category: "analysis"
---
# Strategic Compaction

## When This Skill Applies
- Context window usage exceeds 75% (yellow zone)
- PreCompact hook event triggered
- Long sessions with accumulated context
- Multi-phase tasks requiring context preservation

## Core Guidance

**Compaction Priority**:
1. **Preserve**: Active task state, uncommitted decisions, current file context
2. **Summarize**: Completed task results, analysis findings, resolved issues
3. **Drop**: Exploratory searches, failed attempts, superseded plans

**Context Zones**:
| Zone | Usage | Action |
|------|-------|--------|
| Green | 0-60% | Normal operation |
| Yellow | 60-75% | Enable --uc, suggest compaction |
| Orange | 75-85% | Active compression, defer non-critical |
| Red | 85-95% | Force efficiency, essential ops only |
| Critical | 95%+ | Emergency protocols |

**Compaction Process**:
1. Checkpoint: save current task state before compaction
2. Classify: sort context into preserve/summarize/drop
3. Compress: apply token-efficient formatting to preserved content
4. Validate: verify essential context survives compaction
5. Resume: continue work with compressed context

**Token Efficiency Integration**:
- Auto-enable `--uc` in yellow zone
- Use symbol system for status tracking
- Abbreviate repeated technical terms
- Tables and bullets over prose

**Anti-Patterns**: Waiting until critical zone, compacting without preserving task state, dropping context needed for in-progress decisions

## Quick Reference
- Act at yellow zone (60-75%), not red
- Always checkpoint before compaction
- Preserve > Summarize > Drop
- Essential: active tasks, uncommitted decisions, current files
