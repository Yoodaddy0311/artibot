---
context: fork
user-invocable: false
name: hook-feedback-merge
description: |
  Hook feedback to tool result merge pattern. Documents how pre/post hook
  feedback (warnings, blocks, suggestions) gets merged into tool results
  so the model sees quality signals inline with tool output.
  Auto-activates when: writing hooks that produce feedback, reviewing hook output flow.
  Triggers: hook feedback, tool result, merge, pre-write, post-edit, quality gate
platforms: [claude-code]
level: 2
triggers:
  - "hook"
  - "feedback"
  - "tool result"
  - "merge"
  - "quality gate"
allowed-tools: [Read, Grep, Glob]
tokens: "~1.5K"
category: "infrastructure"
version: "1.0.0"
source_hash: f9868ebb
---
# Hook Feedback Merge Pattern

## Overview

Claude Code merges hook stdout JSON directly into tool results. When a hook
emits structured feedback (warnings, blocks, reasons), the model receives it
as part of the tool call response -- not as a separate system message. This
means hook feedback is contextually attached to the exact tool invocation
that triggered it.

## How It Works

```
Tool Call (e.g., Edit)
  -> PreToolUse hooks run
     -> Hook writes JSON to stdout: { "decision": "block", "reason": "..." }
  -> Claude Code merges hook output into tool result
  -> Model sees: tool result + hook feedback in one response
```

## Hook Output Contract

Hooks communicate by writing a single JSON object to stdout:

### Allow / Approve (no interference)
```json
{}
```
Or simply produce no output.

### Block (prevent tool execution)
```json
{
  "decision": "block",
  "reason": "Human-readable explanation of why blocked"
}
```

### Warn (allow but annotate)
```json
{
  "message": "Warning text that appears in tool result"
}
```

### Structured Feedback (rich metadata)
```json
{
  "decision": "BLOCK",
  "reason": "Review gate found 2 issue(s):\n  - Bracket mismatch\n  - Missing tests",
  "issues": ["...", "..."],
  "changedFiles": ["src/foo.js"],
  "codexCrossCheck": true
}
```

All fields beyond `decision` and `reason`/`message` are passed through and
available to the model as additional context.

## Existing Hooks Using This Pattern

| Hook | Phase | Key Fields |
|------|-------|------------|
| `pre-write-guard.js` | PreToolUse | `decision`, `reason` (block on unread files) |
| `pre-bash.js` | PreToolUse | `decision`, `reason` (block dangerous commands) |
| `quality-gate.js` | PostToolUse | `warnings[]`, `decision` (warn on quality issues) |
| `stop-review-gate.js` | Stop | `decision`, `reason`, `issues[]`, `changedFiles[]` |
| `pre-compact.js` | PreCompact | `message`, `summary`, `tokenEstimate` |

## Implementation Guidelines

### For Hook Authors

1. **Always use `writeStdout()`** (or `writeJSON()`) from `scripts/utils/index.js`
2. **Use `decision` field** for actionable outcomes: `"block"`, `"allow"`, `"warn"`
3. **Include `reason`** with human-readable text -- the model reads this
4. **Add structured data** alongside reason for programmatic consumers
5. **Keep output small** -- hook output adds to the tool result token cost

### For Pre-Phase Hooks (PreToolUse)

```js
// Block pattern
writeStdout({ decision: 'block', reason: 'File not read before write' });

// Allow pattern (explicit)
writeStdout({ decision: 'approve' });

// Allow pattern (implicit -- no output means allow)
```

### For Post-Phase Hooks (PostToolUse)

```js
// Warning pattern (non-blocking)
writeStdout({ message: 'console.log detected in written file' });

// Block pattern (rare in post -- use for critical issues)
writeStdout({ decision: 'block', reason: 'Hardcoded secret detected' });
```

### For Stop Hooks

```js
// Review result
writeStdout({
  decision: issues.length > 0 ? 'BLOCK' : 'ALLOW',
  reason: 'Review gate summary...',
  issues,
  changedFiles,
});
```

## Best Practices

- **Keep `reason` under 500 chars** -- it appears inline in tool results
- **Use `message` for informational output**, `decision`+`reason` for actionable output
- **Never log secrets** in hook output -- it becomes part of the conversation
- **Test hook output** by running the hook manually with `echo '{}' | node hook.js`
- **Use stderr for debug logs** (`process.stderr.write(...)`) -- only stdout is merged

## Anti-Patterns

- Writing free-form text to stdout (must be valid JSON)
- Emitting large payloads (file contents, full diffs) in hook output
- Using `console.log()` in hooks (goes to stdout, corrupts JSON)
- Relying on hook output order (hooks may run in parallel within a phase)

## Rationalizations

The following table captures common excuses agents make to skip the discipline of this skill, paired with factual rebuttals.

| Excuse | Rebuttal |
|--------|----------|
| "hook warnings are advisory, I'll ignore them" | advisory warnings encode lessons from prior failures; ignoring them re-runs the experiment with the known result |
| "merging hook feedback clutters tool results" | unmerged feedback gets lost in stderr noise — merging is how the model actually sees it |
| "the model can't act on hook feedback mid-tool" | the model reads the merged result on the next turn and adjusts; that's exactly the feedback loop you want |
| "pre-hook blocks are too aggressive" | pre-hook blocks catch errors before they cost a tool round-trip; aggressive is the correct default |
| "post-hook suggestions arrive too late" | late suggestions steer the NEXT call; steering is always cheaper than correction |
