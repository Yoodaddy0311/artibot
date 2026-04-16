# Hook Audit — Phase 2 WS-C.1

Generated: 2026-04-08
Source: `plugins/artibot/hooks/hooks.json`
Total registrations: **43**
Canonical slots (current): SessionStart, UserPromptSubmit, PostToolUse, PreCompact

> **Status**: advisory. No files have been modified. This document is the
> input to Phase C.2 (dispatcher) and C.3 (migration) and will only be
> acted upon after explicit user approval. The SessionStart hook is
> fragile (see commit `75c942b`) — all proposals below err on the side
> of "keep".

Note on count: earlier planning notes referenced "39 registrations across
15 event types"; the audit script found **43 registrations across 15
event types** (`PermissionRequest` is present but empty, 14 populated).
The extra 4 come from multi-command SubagentStart/SubagentStop entries
(`workflow-status.js` duplicated across SubagentStart, SubagentStop,
TeammateIdle) and the `PostToolUseFailure` additions introduced after
the earlier count.

---

## Inventory

| # | Event | Script | Lines | Proposed Action | Rationale |
|---|-------|--------|------:|-----------------|-----------|
| 1 | SessionStart | `scripts/hooks/session-start.js` | 150 | keep-canonical | Primary init hook — fragile per commit 75c942b, do not touch |
| 2 | SessionStart | `scripts/hooks/memory-tracker.js` (SessionStart) | 289 | merge-into-canonical | Tracking side-effect, safe to fold into dispatcher |
| 3 | SessionStart | `scripts/hooks/swarm-download.js` | 74 | merge-into-canonical | Optional learning sync — run after core init |
| 4 | SessionStart | `scripts/hooks/git-autopilot-setup.js` | 104 | merge-into-canonical | Git setup — run after core init block |
| 5 | SessionStart | `scripts/hooks/git-autopilot-session.js` | 197 | merge-into-canonical | Git session bootstrap — pairs with setup |
| 6 | SessionStart | `scripts/hooks/auto-learning-check.js` | 101 | merge-into-canonical | Optional learning gate |
| 7 | SessionStart | `scripts/hooks/skill-validation-check.js` | 102 | merge-into-canonical | Optional skill scan |
| 8 | PreToolUse | `scripts/hooks/pre-write.js` | 45 | canonical-exception | Security gate — must run BEFORE Write/Edit |
| 9 | PreToolUse | `scripts/hooks/pre-bash.js` | 31 | canonical-exception | Security gate — must run BEFORE Bash |
| 10 | PreToolUse | `scripts/hooks/pre-write-guard.js` | 212 | canonical-exception | Read-before-write enforcement — pre-phase only |
| 11 | PreToolUse | `scripts/hooks/git-autopilot-guard.js` | 143 | canonical-exception | Branch/worktree guard — pre-phase only |
| 12 | PreToolUse | `scripts/hooks/pre-write-checkpoint.js` | 52 | canonical-exception | Quality checkpoint — pre-phase only |
| 13 | PostToolUse | `scripts/hooks/pre-write-guard.js` (Read matcher) | 212 | keep-canonical | Tracks read-state for subsequent edits; different phase than #10 |
| 14 | PostToolUse | `scripts/hooks/quality-gate.js` | 45 | keep-canonical | Cross-cutting quality check |
| 15 | PostToolUse | `scripts/hooks/post-edit-format.js` | 32 | merge-into-canonical | Per-tool sub-dispatch (Edit only) |
| 16 | PostToolUse | `scripts/hooks/post-edit-recovery.js` | 106 | keep-canonical | Conditional error recovery — keep isolated |
| 17 | PostToolUse | `scripts/hooks/post-bash.js` | 43 | merge-into-canonical | Per-tool sub-dispatch (Bash only) |
| 18 | PostToolUse | `scripts/hooks/tool-tracker.js` | 375 | keep-canonical | Primary observability pipeline |
| 19 | PreCompact | `scripts/hooks/pre-compact.js` | 268 | keep-canonical | Only hook in the slot; already canonical |
| 20 | Stop | `scripts/hooks/stop-review-gate.js` | 339 | canonical-exception | Completion gate — must run at Stop, not PostToolUse |
| 21 | Stop | `scripts/hooks/check-console-log.js` | 60 | canonical-exception | End-of-turn lint gate |
| 22 | Stop | `scripts/hooks/git-autopilot-close.js` | 251 | canonical-exception | End-of-turn commit close |
| 23 | UserPromptSubmit | `scripts/hooks/user-prompt-handler.js` | 95 | keep-canonical | Primary prompt handler |
| 24 | UserPromptSubmit | `scripts/hooks/runtime-prompt.js` | 200 | merge-into-canonical | Runtime pipeline trigger — fold into dispatcher |
| 25 | UserPromptSubmit | `scripts/hooks/git-autopilot-save.js` | 155 | merge-into-canonical | Per-prompt git checkpoint |
| 26 | SubagentStart | `scripts/hooks/subagent-handler.js start` | 85 | canonical-exception | Subagent lifecycle event — no canonical slot |
| 27 | SubagentStart | `scripts/hooks/workflow-status.js teammate-update` | 226 | canonical-exception | Team status broadcast |
| 28 | SubagentStop | `scripts/hooks/subagent-handler.js stop` | 85 | canonical-exception | Subagent lifecycle event |
| 29 | SubagentStop | `scripts/hooks/agent-evaluator.js` | 214 | canonical-exception | Post-agent evaluation |
| 30 | SubagentStop | `scripts/hooks/workflow-status.js teammate-update` | 226 | canonical-exception | Team status broadcast |
| 31 | TeammateIdle | `scripts/hooks/team-idle-handler.js` | 130 | canonical-exception | Team idle event — no canonical slot |
| 32 | TeammateIdle | `scripts/hooks/workflow-status.js teammate-update` | 226 | canonical-exception | Team status broadcast |
| 33 | TaskCompleted | `scripts/hooks/team-idle-handler.js` | 130 | canonical-exception | Task lifecycle event |
| 34 | TaskCompleted | `scripts/hooks/clean-state-check.js` | 98 | canonical-exception | Clean-state advisory |
| 35 | SessionEnd | `scripts/hooks/session-end.js` | 94 | canonical-exception | End-of-session cleanup |
| 36 | SessionEnd | `scripts/hooks/swarm-sync.js` | 78 | canonical-exception | Swarm persistence on close |
| 37 | SessionEnd | `scripts/hooks/memory-tracker.js SessionEnd` | 289 | canonical-exception | Persistence on close |
| 38 | SessionEnd | `scripts/hooks/http-notify.js` | 184 | canonical-exception | Outbound close notification |
| 39 | PostToolUseFailure | `scripts/hooks/tool-tracker.js failure` | 375 | canonical-exception | Failure-specific tracking; do not merge with success path |
| 40 | PostToolUseFailure | `scripts/hooks/memory-tracker.js PostToolUseFailure` | 289 | canonical-exception | Failure-specific memory record |
| 41 | Notification | `scripts/hooks/workflow-status.js notification` | 226 | canonical-exception | Notification pipeline |
| 42 | Notification | `scripts/hooks/context-tracker.js` | 212 | canonical-exception | Context window tracking |
| 43 | InstructionsLoaded | `scripts/hooks/instructions-loaded.js` | 87 | canonical-exception | Distinct lifecycle event fired on CLAUDE.md load |

All 43 registrations resolved to scripts that **exist on disk** and
**contain an error handler** (either `createErrorHandler` import or a
top-level `try/catch`). No `has_io_utils` import was detected in any
hook — a separate concern tracked outside this audit.

---

## Canonical 4-Slot Mapping (Proposed)

### SessionStart (7 registrations → 1 canonical entry + merged sub-steps)
- `session-start.js` — **KEEP** (canonical init, fragile)
- `memory-tracker.js` — **MERGE** into post-init tracking block
- `swarm-download.js` — **MERGE** into optional-learning block
- `git-autopilot-setup.js` — **MERGE** into git block
- `git-autopilot-session.js` — **MERGE** into git block
- `auto-learning-check.js` — **MERGE** into optional-learning block
- `skill-validation-check.js` — **MERGE** into optional-learning block

Ordering constraint: `session-start.js` must run first and must not be
refactored inside the same PR as the merge (stability rule).

### UserPromptSubmit (3 registrations → 1 canonical entry)
- `user-prompt-handler.js` — **KEEP** (canonical)
- `runtime-prompt.js` — **MERGE** (runtime pipeline trigger)
- `git-autopilot-save.js` — **MERGE** (per-prompt git checkpoint)

Note: `cognitive-router.js` exists in `scripts/hooks/` but is **not
registered** in `hooks.json`. It is either legacy or called from another
module; confirm during C.2 planning.

### PostToolUse (6 registrations → 3 canonical entries + sub-dispatch)
- `tool-tracker.js` — **KEEP** (primary observability, `*` matcher)
- `quality-gate.js` — **KEEP** (cross-cutting, Edit/Write)
- `post-edit-recovery.js` — **KEEP** (error recovery, conditional)
- `pre-write-guard.js` (Read matcher) — **KEEP** (distinct role: read-state tracking)
- `post-edit-format.js` — **MERGE** into per-tool sub-dispatch under tool-tracker
- `post-bash.js` — **MERGE** into per-tool sub-dispatch under tool-tracker

### PreCompact (1 registration)
- `pre-compact.js` — **KEEP** (already canonical; no merge needed)

---

## Exceptions (Cannot Merge)

Registrations outside the canonical 4 slots that serve critical
non-collapsible purposes. All marked `canonical-exception`.

| Event | Scripts | Reason |
|-------|---------|--------|
| PreToolUse | `pre-write.js`, `pre-bash.js`, `pre-write-guard.js`, `git-autopilot-guard.js`, `pre-write-checkpoint.js` | SECURITY / quality gates — must run **before** tool execution, cannot merge into PostToolUse |
| Stop | `stop-review-gate.js`, `check-console-log.js`, `git-autopilot-close.js` | Completion-time checks — must run at Stop, not PostToolUse |
| SessionEnd | `session-end.js`, `swarm-sync.js`, `memory-tracker.js`, `http-notify.js` | End-of-session cleanup — distinct lifecycle event |
| SubagentStart | `subagent-handler.js`, `workflow-status.js` | Subagent lifecycle — not a tool event |
| SubagentStop | `subagent-handler.js`, `agent-evaluator.js`, `workflow-status.js` | Subagent lifecycle — not a tool event |
| TeammateIdle | `team-idle-handler.js`, `workflow-status.js` | Team-level idle event |
| TaskCompleted | `team-idle-handler.js`, `clean-state-check.js` | Task-lifecycle event |
| PostToolUseFailure | `tool-tracker.js failure`, `memory-tracker.js PostToolUseFailure` | Failure-specific; must NOT merge with success PostToolUse |
| Notification | `workflow-status.js notification`, `context-tracker.js` | Inbound Claude Code notification channel |
| InstructionsLoaded | `instructions-loaded.js` | Fires only on CLAUDE.md load |

---

## Decisions

Total: **43** registrations

| Action | Count |
|--------|------:|
| keep-canonical | 8 |
| merge-into-canonical | 9 |
| canonical-exception | 26 |
| deprecate (move to `_deprecated/`) | 0 |

Notes:
- No hook was proposed for deprecation. The audit found zero dead
  registrations and zero missing script files.
- `cognitive-router.js` exists in `scripts/hooks/` but is **not
  registered**. It is not part of the 43 counted here. Its status
  (legacy vs. module-level import) should be resolved in C.2 planning
  before any cleanup.
- `git-autopilot-merge.js` and `nightly-learner.js` also exist on disk
  but are not registered in `hooks.json`. Same note applies.

---

## Risk Flags

| Risk | Finding |
|------|---------|
| Missing scripts | 0 |
| Registrations without error handler | 0 |
| Hooks without `scripts/utils/index.js` import | 43 (all) — tracked separately, not a blocker for C.2 |
| Fragile SessionStart | 1 (`session-start.js`) — do not refactor in same PR as merges |
| Duplicate script paths | 3 (`workflow-status.js` across SubagentStart/Stop/TeammateIdle; `memory-tracker.js` across SessionStart/SessionEnd/PostToolUseFailure; `tool-tracker.js` across PostToolUse/PostToolUseFailure) — intentional multi-event handlers, not bugs |

---

## User Approval Gate

**No changes will be made until the user reviews this document and
approves.** Phase C.2 (build the canonical dispatcher in
`lib/core/hook-dispatcher.js`) and Phase C.3 (migrate
`hooks/hooks.json` according to the mapping above) both require
explicit go-ahead.

Suggested approval checklist for the user:
- [ ] Confirm the 43-count matches expectations (was 39 in earlier notes)
- [ ] Confirm SessionStart merge ordering constraint is acceptable
- [ ] Confirm `cognitive-router.js` / `git-autopilot-merge.js` / `nightly-learner.js` (unregistered) handling
- [ ] Approve the 26 canonical-exception entries as non-mergeable
- [ ] Authorize Phase C.2 to proceed
