# Stage B-side Diagnosis — Three Dormant Learning Capabilities

Read-only investigation. No code edits. Generated 2026-05-19.

## Summary Table

| Area | Status | Activation cost | Risk |
|------|--------|----------------|------|
| Success patterns | dormant — hook payload field never populated | ~8 lines (synthesize from completed evaluations) | low — additive only |
| Team weights | missing call site — no team-completion hook exists | ~10 lines + 1 new hook OR ~8 lines in `team-idle-handler.js` | low-medium — touches team lifecycle |
| Swarm sync | broken + gated — wrong upload fn + egress allowlist gap | N/A this session (2 changes outside Stage B-side scope) | medium — touches network/data-policy code |

Evidence files: see `## Evidence` blocks per area.

---

## 1. Success Patterns

### Status: dormant — code path exists but data source is empty

The `_buildSuccessEntry` function exists at `plugins/artibot/lib/learning/lifelong-learner.js:149-164`, and `collectDailyExperiences` iterates `sessionData.completedTasks` (line 221-223) to push success entries. The pipeline is fully wired through `runLifelongLearning` → `collectDailyExperiences` → `batchLearn` → `extractPattern`. The dormancy is upstream: the source array is always empty.

### Evidence

- `plugins/artibot/scripts/hooks/session-end.js:111` builds `sessionData.completedTasks = hookData.completed_tasks || []`. Claude Code's `SessionEnd` hook payload never populates `completed_tasks`. Confirmed by:
- `~/.claude/artibot/daily-experiences.json` (1000 records): `{ tool: 901, agent: 75, self-evaluation: 24, success: 0, error: 0, team: 0 }`.
- `~/.claude/artibot/patterns/` directory only contains `agent-patterns.json`, `self-evaluation-patterns.json`, `tool-patterns.json` — **no `success-patterns.json`** despite `lifelong-learner.js:439-455` iterating the type list `['tool', 'error', 'success', 'team', 'general']`.
- `plugins/artibot/lib/learning/pipeline.js:135-171` (`runSelfEvaluation`) DOES exist and runs every session — it writes a `type: 'self-evaluation'` experience but never a `type: 'success'`. The information needed to build a success entry (sessionId, duration, testsPass, filesModified) is in scope at line 142-147 — it just isn't piped into `collectExperience` with `type: 'success'`.

### Proposed Activation (~8 lines, no edit performed)

Where: `plugins/artibot/lib/learning/pipeline.js` after the existing `runSelfEvaluation` block at line 165 (before `return evalResult;`).

Synthesize a `success` experience from the session result when `sessionResult.success === true`:

```js
// After line 165, before "return evalResult;"
if (sessionResult.success) {
  await collectExperience({
    type: 'success',
    category: sessionTask.type,
    data: {
      taskId: sessionTask.id,
      duration: sessionResult.duration ?? null,
      strategy: 'session',
      filesModified: (sessionData.filesModified ?? []).length,
      testsPass: sessionResult.testsPass ?? null,
    },
    sessionId: sessionData.sessionId,
  });
}
```

This reuses already-computed `sessionResult` (line 142-147). The data is real, not fabricated. After ~5-10 sessions it would seed `success-patterns.json` and start producing comparative insights against the existing error/agent patterns.

Alternative (more ambitious, NOT recommended for B-side): collect success per-completed-Task by adding a `TaskCompleted` hook handler that pushes a success experience.

### Risk

Low. Additive write to an existing experience store. The `extractPattern` consensus mode (pattern-analyzer.js:246) requires ≥3 samples so a single false-positive cannot corrupt downstream weights.

---

## 2. Team Weights

### Status: missing call site — function chain is dead code

The team-GRPO trio (`generateTeamCandidates` / `evaluateTeamGroup` / `updateTeamWeights`) at `plugins/artibot/lib/learning/grpo-optimizer.js:280-432` is fully implemented and exported through the learning barrel (`lib/learning/index.js:42-52`). It has 0 callers in non-test code.

### Evidence

`grep updateTeamWeights|evaluateTeamGroup|generateTeamCandidates`:
- `plugins/artibot/lib/learning/grpo-optimizer.js` — definitions only
- `plugins/artibot/lib/learning/index.js` — re-export
- `plugins/artibot/scripts/learning-diag.js` — diagnostic CLI
- `plugins/artibot/commands/learning.md` — doc reference
- `plugins/artibot/tests/learning/grpo-optimizer.test.js` — unit tests
- `plugins/artibot/skills/self-evaluation/SKILL.md` — doc reference
- `plugins/artibot/CHANGELOG.md` — release notes

Zero production callers. Confirmed by `~/.claude/artibot/grpo-history.json` — all rounds carry `"type": "task"`, none `"type": "team"`. The `teamWeights: {}` object on disk has stayed empty since first install (2026-04-08).

Same root cause as success patterns: `_buildTeamEntry` in `lifelong-learner.js:172-188` is fed by `sessionData.teamConfig` which comes from `hookData.team_config` in `scripts/hooks/session-end.js:112` — Claude Code's hook payload never carries this either.

There is no `TeamDelete` hook event registered in `plugins/artibot/hooks/hooks.json`. The `team-idle-handler.js` (`TeammateIdle` hook) is the only hook fired during team lifecycle, and it operates on individual agents, not team composites.

### Proposed Activation (≤10 lines)

The cleanest minimal call site is `plugins/artibot/scripts/hooks/team-idle-handler.js` — when `pendingTasks === 0` and `shouldStop === true`, the team is effectively finished. At that point, read the team-state file (`getStatePath()`), compute success/duration aggregates, and call `updateTeamWeights`.

Sketch (~10 lines, NOT applied):

```js
// In team-idle-handler.js, inside the "stop" branch when team work completes
if (shouldStop) {
  try {
    const { generateTeamCandidates, evaluateTeamGroup, updateTeamWeights } =
      await import(toFileUrl(path.join(PLUGIN_ROOT, 'lib', 'learning', 'index.js')));
    const teamResult = {
      taskCount: state.tasks?.length ?? 0,
      successCount: (state.tasks ?? []).filter(t => t.status === 'completed').length,
      completedCount: (state.tasks ?? []).filter(t => t.status === 'completed').length,
      duration: Date.now() - (state.startedAt ?? Date.now()),
      teamSize: Object.keys(state.idleCounts ?? {}).length,
    };
    const cands = generateTeamCandidates({ id: state.teamId, domain: state.domain ?? 'general' });
    cands.forEach(c => { c.result = teamResult; });
    await updateTeamWeights(evaluateTeamGroup(cands));
  } catch (err) { logHookError('team-idle', 'team-weights update failed', err); }
}
```

This is honest: it records the actual team outcome rather than fabricating multi-candidate data. The `generateTeamCandidates` call gives `updateTeamWeights` rankings to chew on, but every candidate gets the same `result` so the weight delta is small per session — exactly what we want for safe activation.

Note: this still requires the team state file to carry `startedAt`, `domain`, and `teamId`. If those fields are absent, the wire-up degrades to a no-op rather than crashing.

### Risk

Low-medium. The hook already runs frequently and is failure-tolerant. The risk is that team-state schema doesn't yet carry the fields the hook would need (`startedAt`, `domain`); without them, all rounds land at the same `pattern|size|general` key, slowly biasing one composition. Mitigation: gate the call on presence of those fields.

---

## 3. Swarm Sync

### Status: broken (bug) + gated (config) — two compounding causes

Swarm has uploaded exactly 3 times — all on 2026-04-08 during initial bootstrap — and nothing since. Cause is two-fold.

### Evidence

**Cause A — wrong upload function in `onSessionEnd`:**

`plugins/artibot/lib/swarm/sync-scheduler.js:414` hardcodes `await uploadWeights(...)` (HTTP variant) instead of `await resolveUpload(options.config)(...)`. The `resolveUpload` helper exists in the same file at line 24-30 and is used correctly by `performSync` at line 245, but `onSessionEnd` bypasses it. With `artibot.config.json` set to `swarm.backend === 'git'`, every session-end attempts an HTTP POST instead of a git push.

**Cause B — egress allowlist gap:**

`plugins/artibot/scripts/hooks/swarm-sync.js:62-77` asserts via `assertEgressAllowed(serverUrl, ...)`. The configured `serverUrl` is `https://artibot-swarm-154860486472.asia-northeast3.run.app` (artibot.config.json line 769). The allowlist at `plugins/artibot/lib/privacy/allowlist.json` contains only `["api.github.com"]`. Result: even if Cause A were fixed, the HTTP path is fail-closed by DATA POLICY. The error path is the `logHookError('swarm-sync', 'sync failed', err)` swallow at line 122 — silent.

**Evidence of state:**

- `~/.claude/artibot/swarm-consent.json`: `{ optedIn: true, optedInAt: "2026-05-18..." }` — consent OK.
- `~/.claude/artibot/swarm-sync-state.json`: **does not exist** — `saveSyncState` never ran successfully.
- `~/.claude/artibot/swarm-git/` git log: 4 commits, last weight upload `5420a9a` dated 2026-04-08. No commits in the past ~6 weeks despite many session ends.
- Local tool-patterns.json has 10 swarm-eligible patterns (`sampleSize ≥ 3 && confidence ≥ 0.4`), so the gate at `sync-scheduler.js:410` (`packagedCount === 0`) is NOT the cause.

### Proposed Activation

**Per the task instructions: DO NOT activate.** Recording the cause only.

To enable swarm sync the user would need:

1. Fix `onSessionEnd` to honour `config.backend` (1-line change at sync-scheduler.js:414: `const result = await resolveUpload(options.config)(...)`).
2. Either:
   - (a) Add `artibot-swarm-154860486472.asia-northeast3.run.app` to `lib/privacy/allowlist.json` for HTTP backend, OR
   - (b) Verify git push works through the `git-backend.js` path (no allowlist needed since git uses its own credentials/transport). Cause B becomes irrelevant once Cause A is fixed.

### Risk

Medium. Touches network egress, data privacy, and a backend selector bug. Any activation must be paired with verification that:
- `swarm-git/.git/config` remote URL is reachable
- credentials/SSH keys are configured for the user's `Yoodaddy0311/artibot-swarm` repo
- DATA POLICY review accepts the git backend's data flow (the URL is HTTPS to github.com, which is currently NOT in the allowlist either — but git invokes its own transport stack, not `safeFetch`).

---

## Cross-cutting observation

All three dormant capabilities share one root cause: **the system collects experiences exclusively through PostToolUse and SubagentStop hooks, neither of which carry session-level, task-level, or team-level outcomes.** The only session-aggregate experience produced is `type: 'self-evaluation'` (24 records), which is good but doesn't fan out into success/team/error categories because the upstream `hookData.completed_tasks` and `hookData.team_config` payload fields are never populated by Claude Code.

A 5-line addition in `runSelfEvaluation` (Area 1's proposed activation) would unblock Area 1 immediately. Area 2 requires either schema additions to team-state or a new `TeamDelete` hook. Area 3 is independent — a bug + config issue.

---

End of diagnosis.
