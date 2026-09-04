---
description: (Artibot) Automated health check — config, agents, skills, hooks, MCP, memory
argument-hint: '[scope] e.g. "config" | "skills" | "hooks" — or no argument for full check'
allowed-tools: [Read, Glob, Grep, Bash]
toolset: meta
lifecycle: diagnose
---

# /doctor

Run automated health checks on the Artibot plugin installation. Validates config integrity, agent files, skill hashes, hook dispatchers, MCP connectivity, and memory stores. Produces a single pass/fail summary.

## Arguments

Parse $ARGUMENTS:
- (no argument): Run all 10 checks
- `config`: Check 1 only — config validation
- `agents`: Check 2 only — agent file presence
- `skills`: Check 3 only — skill hash integrity
- `hooks`: Check 4 only — hook health
- `mcp`: Check 5 only — MCP connectivity
- `memory`: Check 6 only — memory store health
- `explainability`: Check 7 only — decision recording health
- `state`: Check 8 only — ledger/state parity and `state_version` continuity
- `artifacts`: Check 9 only — Artifact Health, the ten items of Hardening §32
- `routing`: Check 10 only — route receipt ↔ bind residue (design §2.3 invariant 3)
- `--verbose`: Show per-item details (not just summary lines)
- `--json`: Output results as a JSON object instead of the formatted report
- `--fix`: After diagnosing, apply SAFE automatic repairs for fixable failures (see Self-Heal below)
- `--dry-run`: Preview the repairs `--fix` would make without writing anything (this is the **default** for the self-heal layer — repairs only mutate the filesystem when `--fix` is passed explicitly)

## Paths

All paths are relative to the plugin root (`plugins/artibot/`):
- Config: `artibot.config.json`
- Agents: `agents/*.md`
- Skills: `skills/*/SKILL.md`
- Skill hash cache: `.claude-cache/skill-hashes.json`
- Hook definitions: `hooks/hooks.json`, `hooks/dispatch-table.json`
- Hook scripts: `scripts/hooks/*.js`
- MCP config: `.mcp.json`
- Memory scopes: defined in `artibot.config.json > learning.memoryScopes`

## Execution Flow

### Check 1: Config Validation

1. Read `plugins/artibot/artibot.config.json`
2. Parse as JSON — if parse fails, report FAIL immediately
3. Apply `validateConfig()` logic from `lib/core/config-schema.js`:
   - Verify root is a plain object
   - Verify required field `version` exists and matches semver pattern
   - Validate each known section against its schema constraints
4. Count from the parsed config:
   - `version`: value of `version` field
   - Agent count: unique agent names across `agents.modelPolicy.high.agents` + `agents.modelPolicy.medium.agents`
   - Skill count: count directories under `skills/` that contain `SKILL.md` (use Glob)
   - Command count: count `.md` files under `commands/` excluding `index.md` (use Glob)
5. Report: version, agent count, skill count, command count, validation errors (if any)

### Check 2: Agent Files

1. Collect all unique agent names referenced in `artibot.config.json`:
   - `agents.modelPolicy.high.agents[]`
   - `agents.modelPolicy.medium.agents[]`
   - `agents.categories.*[]` (flatten all arrays)
   - `agents.taskBased.*` (all values)
2. For each unique agent name, verify `agents/{name}.md` exists (use Glob or Read)
3. Report: total referenced, total present, list of missing agents (if any)

### Check 3: Skill Integrity

1. Load the skill hash cache from `.claude-cache/skill-hashes.json` (following the pattern in `lib/core/skill-hash-cache.js > loadSkillHashCache()`)
2. If cache is missing, scan `skills/*/SKILL.md` via Glob and report cache-missing warning
3. For each skill in the cache, verify the hash by:
   - Reading the SKILL.md file
   - Stripping YAML frontmatter (everything between opening `---` and closing `---`)
   - Computing SHA-256 of the body (normalized: CRLF to LF, trimmed), take first 8 hex chars
   - Comparing against the cached `hash` value (following `lib/core/skill-hash.js > verifyHash()`)
4. Also check for skills on disk that are NOT in the cache (orphaned skills)
5. Report: total verified, hash mismatches, missing-from-cache, missing-from-disk

### Check 4: Hook Health

1. Read `hooks/hooks.json` — verify valid JSON, count event slots and total hook entries
2. Read `hooks/dispatch-table.json` — verify valid JSON, count dispatcher slots and handler entries
3. For each handler script referenced in `dispatch-table.json > slots.*.handlers[].script`:
   - Verify the file exists at `scripts/hooks/{script}` (use Glob)
4. For each dispatcher script referenced in `dispatch-table.json > slots.*.dispatcher`:
   - Verify the file exists (skip null dispatchers like PreCompact)
5. For each hook command in `hooks.json`, extract the script path and verify the file exists
6. Check syntactic validity of each hook script: run `node --check {script}` via Bash (parse-only, no execution)
7. Report: dispatcher count, total script count, missing scripts, syntax errors

### Check 5: MCP Connectivity

1. Read `.mcp.json` — verify valid JSON
2. List all configured MCP server names and their types (`command` vs `http`)
3. For `command`-type servers: verify the command is available (e.g., `npx` exists on PATH)
4. For `http`-type servers: verify the URL is well-formed; optionally attempt a lightweight HTTP HEAD request (timeout 5s) to check reachability
5. Report: server names, types, and connectivity status (connected / unreachable / unknown)

### Check 6: Memory Health

1. Read memory scope paths from `artibot.config.json > learning.memoryScopes`
2. For each file-based scope (`user`, `project` — skip `session` which is in-memory):
   - Resolve the path (expand `~` to home directory)
   - List files in the directory (use Glob)
   - For each `.md` or `.json` file, measure file size
   - Count entries: for `.json` files parse and count top-level keys/array items; for `.md` files count `## ` or `- [` lines as rough entry proxies
3. Flag oversized files (> 500KB) or empty stores (0 entries)
4. Report: store count, total entries, total size, warnings

### Check 7: Explainability Health

Read-only. This check exists because the decision record had no reader at all:
`getDecisionStats` and `queryDecisions` were exported from `lib/core/index.js`
and consumed by nothing, so the trail sat empty in production and nobody
noticed. A store nobody reads cannot report its own outage.

ONE ROOT, since 2026-09-05 (D9 — `.artibot/guides/v5-design/DESIGN-TRAIL-migration-projectRoot.md`
§2 C, owner rulings TR-1..3). Every live decision writer appends to the
decisions store under the PROJECT root, `<projectRoot>/.artibot/runtime/decisions/`
(`lib/observability/decision-events.js#getDecisionStoreDir`). The plugin-root
trail `runtime/decision-trail.json` is FROZEN: `lib/core/decision-trail.js#recordDecision`
is a no-op unless `ago.decisionTrail.enabled` is explicitly `true`, and no
module under `lib/` or `scripts/` calls it any more —
`tests/firewall/trail-sandbox-required.test.js` ratchets that writer list.
This check therefore resolves ONE root, judges ONE store, and reports the trail
as a single informational row that never enters the status table.

1. **Decision events** — resolve `<projectRoot>/.artibot/runtime/decisions/`
   and record which of three states it is in: `absent` (no directory) /
   `empty` (directory but no `*.events.ndjson`) / `populated`.
   `getDecisionStoreDir` only joins a path, so the directory comes into
   existence on the first write — `absent` and `empty` therefore mean the same
   thing here, "nothing was ever recorded under this root", and neither is the
   more reassuring of the two.

   Then count, SEPARATELY, the files and lines whose `sessionId` begins with
   neither `diag-` nor `cron-`. Only those are evidence that the PROMPT path
   fires. A diagnostic run writes byte-identical lines through the same code
   path, so counting them would let a single verification run flip this store
   out of every "nothing was recorded" condition below (measured 2026-08-30: the
   store's first and only file was `diag-installed-verify-01.events.ndjson`). A
   `cron-` file (`decision-events.js#cronRunId`, the D9 destination of the four
   `scripts/cron/` runners) proves the SCHEDULER ran, which is a different
   writer in a different process; report cron files as their own count so a
   nightly job cannot stand in for a live session.

   For lines that qualify, note how many fall in the last 24h and the newest
   `ts` across files.
2. **Wiring probe (S4)** — read the two call sites in the INSTALLED tree:
   `lib/runtime/middleware/router.js` and `lib/runtime/middleware/tasks.js`.
   Each must hand `resolveDecisionRunId` an object that actually carries the hook
   payload — `state.input`, which holds `hookData`. Warn when either passes
   `state.context` instead: that object carries neither `hookData` nor
   `sessionId`, so every call resolves to `null`, is counted as `skipped`, and
   nothing is ever written. This warns regardless of every timestamp below,
   because it is a structural fact rather than an inference from absence.
   The probe exists because /doctor reads the INSTALLED plugin while the test
   suite runs against the repo. Measured 2026-08-30: the repo was fixed and fully
   green while the install still carried the broken call sites, and no
   timestamp-based step could tell the two apart.
3. **Absence check (S3)** — absence of records means nothing unless something
   should have been recorded, so judge it against an activity timestamp. Both
   sources live under the SAME project root as the store, so this step no longer
   compares one tree's activity against another tree's records. Take the NEWEST
   of the following, skipping any that cannot be read:
   - `<projectRoot>/.artibot/runtime/ledger.jsonl` — the file's mtime. Every
     central-ledger writer moves it: the PreToolUse route receipt
     (`scripts/hooks/route-observe-pre.js`), the SubagentStart bind, the
     state-store pairing. A moving ledger means hooks are firing.
   - `<projectRoot>/.artibot/runtime/decisions/*.events.ndjson` — the newest
     mtime across files, INCLUDING `diag-` and `cron-` files. A file this store
     itself just wrote is activity even when it is not session evidence.

   Use the newest rather than any single source: taking the maximum fails
   toward "there was activity", which can only make this check warn more
   readily, never less. Warn when that newest timestamp is within 24h AND step 1
   counts zero non-`diag-`, non-`cron-` event lines in the same window.
4. **Legacy trail row (informational)** — read `<pluginRoot>/runtime/decision-trail.json`
   through `getDecisionStats` from `lib/core/decision-trail.js` (it is `async` —
   **await it**; reading the promise's properties yields `undefined`) and report
   whether the file exists, `totalDecisions`, and `metadata.lastUpdated`. This
   row is NEVER a status input: the file is frozen, its count is expected to
   stop moving, and the entries it holds (972 in the dev repo, 9 in the
   marketplace cache, measured 2026-09-04) stay where they are by TR-3. Also
   read `ago.decisionTrail.enabled` from the INSTALLED `artibot.config.json` and
   say which value it holds — `true` means the kill switch is not engaged on
   this install and the trail is still being appended to, which is a config
   fact worth stating next to the row.
5. Report: the resolved PROJECT root (absolute), the store state, session-file
   and line counts (total / last 24h), the cron-file count, the newest record
   timestamp, which activity source was newest, which activity sources were
   missing, the legacy trail row (exists / entries / lastUpdated / config
   switch), and any S3 / S4 / S5 warning.

Status for this check — **first matching row wins**:

| Condition | Status |
|---|---|
| The store exists but cannot be read or parsed | **fail** |
| S4 — either call site passes `state.context` | **warn** |
| S5 — no `*.events.ndjson` with a session id (neither `diag-` nor `cron-`) has ever been written under this root | **warn** |
| S3 — activity within 24h, but zero session event lines in that window | **warn** |
| Otherwise | **pass** |

S5 covers `absent`, `empty`, diag-only and cron-only in one condition, and it
is NOT conditioned on S4 passing: a store with no live record is worth saying
out loud whether or not the wiring reads correctly, because wiring that looks
right and has still never fired is the more interesting of the two.

S6 ("live records exist but the trail does not") was RETIRED on 2026-09-05 with
the trail freeze. It compared two roots, and after D9 the trail is not expected
to move at all — its absence is the normal state on every install, so the row
could only ever fire as noise.

Also deliberately NOT a warn: a store holding real session records whose newest
entry predates the 24h window, with no activity signal inside it either. That
is an idle machine.

**What this check cannot see** (§9 — state it next to the gate):

- **That any particular decision was recorded.** It reads counts and timestamps.
  Six decision points are wired (routing classification, workflow plan,
  topology sighting, memory measurement, skill-level change, self-control
  decision), so a green result says the path is alive, not that coverage is
  complete.
- **Whether a real session, a diagnostic, or a scheduler produced the records —
  beyond the naming convention.** S5 separates them by the `diag-` and `cron-`
  prefixes, which hold only as long as diagnostics and `cronRunId` keep using
  them. A synthetic `preparePrompt` run writes byte-identical lines through the
  same code path, so a diagnostic that forgets the prefix is indistinguishable
  from a live session and will silence S5. When writing a verification run,
  prefix the session id.
- **Whether the S3 activity signal reflects prompts.** `ledger.jsonl` moves on
  every central-ledger writer, not only on a user prompt — a PreToolUse receipt
  or a state pairing is enough — and the decisions directory moves on its own
  cron and diag files. Both push S3 toward warning, never toward silence, so a
  lone S3 warn is a prompt to check which source was newest, not proof that the
  recorder is dead; S4 and S5 remain the load-bearing signals.
- **Anything when neither activity source exists.** A project that has never
  run a hook has neither file. Under such a root S3 can never fire and only S4
  and S5 are load-bearing. Report which activity sources were missing rather
  than reporting "no activity".
- **A recorder that stops after it once worked.** S5 is a latch: it asks whether
  a session record has EVER appeared under this root, so the first real one
  silences it permanently, even if recording breaks the next day. Ongoing
  detection is S3's job, and S3 needs the ledger or the store to keep moving.
  Until something supplies a time-windowed activity row, re-run the wiring
  probe rather than trusting a pass.
- **Which project it read.** The store is per PROJECT root — and, in a linked
  worktree, per worktree (`lib/git/project-root.js#resolveProjectRoot` returns
  the worktree root). Running /doctor from a different project or worktree reads
  a different store even on one machine. State the resolved absolute root in the
  report so an empty store can be told from the wrong tree.
- **The frozen trail's health.** The legacy row is reported, not judged. A
  trail that is still growing on an install whose config says `enabled: true`
  is a config fact this check states and does not act on.
- **Where a scheduler run's file landed.** A `cron-` file is written under
  `resolveProjectRoot(pluginRoot)`. When the plugin root has no `.git`
  ancestor (the marketplace cache), that resolves INSIDE the plugin tree —
  the directory `plugin update` replaces — not under the project. Measured
  2026-09-05 on the cache path; reach is nil today because the runners'
  only caller is a git checkout (`.github/workflows/self-control.yml`).
- **Anything about the repo working tree.** A fixed repo and a stale install are
  indistinguishable to every step except S4.

### Check 8: Ledger / State Parity

Read-only, and NOT a `--fix` target (see the note at the end of Check 9).

`state.yaml` is a projection, not the truth: the StateStore holds the live
state, `ledger.jsonl` holds the history, and the projection must be
reproducible from them at any time (design §3.6; Hardening §31).
This check tests that reproducibility, and reads the `state_version` counter
for the holes that mean a committed write was lost.

The judgement lives in `lib/project-state/doctor-checks.js` and performs NO
I/O. This command reads the three inputs and hands them over:

1. **Ledger events + line census** — `readLedgerCensus(projectRoot)` from
   `lib/runtime/ledger.js`, ONE call returning `{events, census}`. `events` goes
   to the parity comparison; `census` is the reader's own count of the lines it
   dropped on the way (F-30: `dropped.loss` = corrupt / malformed envelope /
   duplicate, `dropped.selection` = `ledger.rejected` excluded / filtered out)
   and goes to the loss row below. Take both from the same read — two reads
   give a numerator and a denominator from different moments.
2. **Store journal** — `readJournal(paths.journal)` from
   `lib/project-state/journal.js`, which tolerates a torn tail rather than
   refusing to open the store.
3. **Projection** — `.artibot/state.yaml`. Pass the RAW TEXT when you have it:
   a string is compared byte for byte, which is design §3.6's rule, while a
   parsed object can only be compared structurally because a YAML parse does
   not preserve key order.

Then call, and report the worse of the two verdicts:

- `checkLedgerStateParity({events, journal, projection, census})` — folds the
  journal through T-21's `reduceProjectState`, never a second fold of its own,
  then compares the rebuild against the supplied projection and the two version
  sets against each other. The result carries a separate `census` key
  (`status` `pass` | `warn` | `unmeasured`, plus `loss`, `selection`, `path`);
  print it in the Check 8 report as-is, path included, because an empty census
  and a census of the wrong tree are told apart only by path.
- `checkStateVersionGaps({journal})` — enumerates holes, regressions and
  duplicates in the `state_version` sequence.

Status for this check — **first matching row wins**:

| Condition | Status |
|---|---|
| Any of events / journal / projection was not read | **unmeasured** |
| A store version has no paired `state.updated` event | **fail** |
| The journal fold does not reproduce the projection | **fail** |
| A `state_version` is missing, repeated, or goes backwards | **fail** |
| A ledger version has not reached the store yet | **warn** |
| The journal fold produced a warning | **warn** |
| `census.dropped_total.loss > 0` — the reader dropped damaged lines | **warn** |
| Otherwise | **pass** |

The loss row is `warn`, not `fail`: a damaged line does not change the parity
verdict, and the ledger is the truth, so there is nothing to auto-repair.
Selection drops (`rejected_excluded`, `filtered_out`) never change the status —
they are the caller's own filters, reported so they can be told from loss.

**census not supplied = unmeasured.** When the caller passes no `census`, the
result's `census.status` is `unmeasured`: the loss was not counted, which is a
different fact from "counted and found zero". The same verdict is returned when
the census says the ledger file was absent or unreadable (`census.file`): zero
lines of nothing is not a clean ledger. This does NOT demote the overall
Check 8 status — the census verdict lives beside `findings`, not inside them —
so a report that shows `census: unmeasured` next to `pass` is telling you
exactly which half was measured.

The two version-set directions mean opposite things and are never merged. A
version in the ledger but not the store is a crash between the two appends: the
store is behind and the superset invariant still holds. A version in the store
but not the ledger is a committed write with no event, which is that invariant
broken and the exact signature lost-update detection exists to see.

**unmeasured is not a pass.** All three inputs are required, because a parity
claim made without one of them is a partial comparison reported as a whole one.
A store that has never been written has nothing to compare, and that reads as
unmeasured rather than healthy.

**What this check cannot see** (§9 — state it next to the gate):

- **Whether the projection on disk is the one the runtime wrote.** It compares a
  projection against a rebuild of it. Both being wrong the same way is
  indistinguishable from both being right.
- **A lost write that never reached either store or ledger.** The counter only
  exposes writes that got a number; a write that died before CAS leaves no hole.
- **Anything about a second worktree.** Each worktree carries its own
  `.artibot/`, so this compares one tree and says nothing about the others.
- **Whether the ledger it read is the one being written.** This is the same
  resolved-root problem Check 7 documents. State the absolute project root in
  the report so an empty comparison can be told from the wrong tree.

### Check 9: Artifact Health

Read-only, and NOT a `--fix` target.

Ten checks, transcribed from Hardening §32. The canonical list is
`.artibot/guides/v5-design/ADDENDUM-HARDENING.md` lines 994-1003 — the TRACKED
copy, since `.gitignore:19` ignores the byte-identical one under `docs/`. The
order below is the document's. Mission artifacts live at
`.artibot/missions/<mission_id>/` as `intent.md`, `plan.md`, `review.md` and
`outcome.md`.

1. Read each mission folder and parse the frontmatter of the four canonical
   files, passing `null` for any that is absent. List the OTHER files in the
   folder as `extraFiles` — without that listing, item 5 cannot be measured.
2. Import `classifyStaleness` from `lib/runtime/artifact-lifecycle.js` and pass
   it in. It is injected rather than imported by the check module because
   `lib/project-state/` is L2 and may not import the runtime layer, so upward
   calls arrive as ports (design §1-8). Without it, items 2-4 are unmeasured.
3. Call `checkArtifactHealth` with every input below, passing the Check 8
   result as `parity`:

```js
checkArtifactHealth({
  missionDirs, classifyStaleness, activeMissionIds,
  leases, now, parity, evidenceIds, supportedSchemaVersions,
});
```

| # | §32 item | Input it needs | Without that input |
|---|---|---|---|
| 1 | Missing intent.md | `missionDirs` | unmeasured |
| 2 | Broken based_on revision | `classifyStaleness` | unmeasured |
| 3 | Stale plan | `classifyStaleness` | unmeasured |
| 4 | Invalid review | `classifyStaleness` | unmeasured |
| 5 | Duplicate canonical artifact | `extraFiles` per mission | unmeasured |
| 6 | Orphan mission | `activeMissionIds` | unmeasured |
| 7 | Expired task lease | `leases` and `now` | unmeasured |
| 8 | Ledger/state mismatch | the Check 8 result as `parity` | unmeasured |
| 9 | Missing evidence reference | `evidenceIds` | unmeasured |
| 10 | Unsupported schema version | `supportedSchemaVersions` | unmeasured |

Each item reports pass, fail or unmeasured on its own, and the summary takes the
most severe of the ten. unmeasured outranks pass, so a run that measured four
items and skipped six reports unmeasured: a check that did not run must never
read the same as a check that ran and found nothing. Report the measured count
alongside the verdict.

An `outcome.md` can also come back NOT_ACCEPTABLE from the §5 propagation table.
§32's ten items have no slot for that state, so it is reported in `findings`
carrying `outsideCanonicalTen: true` rather than folded into one of the ten.

**Check 8 and Check 9 are not `--fix` targets.** The self-heal layer below maps
diagnostic codes to directory and JSON repairs. Every failure these two checks
report is instead a disagreement between recorded facts — a lost write, a broken
dependency edge, an expired lease. Repairing one means choosing which record was
wrong, and rewriting state to silence a lost-update alarm destroys the evidence
that a write was lost. Phase 0 is Observe: report, never repair.

**What this check cannot see** (§9 — state it next to the gate):

- **Any item whose input was not supplied.** The table above is the full list of
  what each item needs. Six of the ten need something beyond the mission
  folders, so a bare invocation measures four and must say so.
- **Whether the frontmatter matches the bytes on disk.** Parsing happens in this
  command, so a parser bug reads as artifact health.
- **A duplicate whose name resembles nothing canonical.** Item 5 fires on names
  starting with a canonical stem, plus governance 08's named derivatives. A
  competing file called `notes-v2.md` is invisible to it.
- **Whether an orphan is abandoned or archived.** Item 6 treats "absent from the
  live state with no outcome.md" as orphaned, so a mission archived by any path
  that does not write an outcome is reported as an orphan.
- **Whether cited evidence is true.** Item 9 resolves ids against the registry
  and never opens the evidence behind them.

### Check 10: Route Bind Residue

Read-only, and NOT a `--fix` target (the note at the end of Check 9 applies).

Design `.artibot/guides/v5-design/ROUTE-RECEIPT-PRETOOLUSE-DESIGN.md` §2.3
invariant 3, §3. Two hooks write two lines for one spawn:
`scripts/hooks/route-observe-pre.js` records a `route.selected` receipt at
PreToolUse(Agent), keyed by the host's `tool_use_id`; `scripts/hooks/subagent-handler.js#bindRoute`
records a `route.bound` line at SubagentStart naming that `tool_use_id` and the
`agent_id` that spawned — or, when no receipt matched, stamps
`route_ledger: 'skipped:unbound'` on the spawn record in
`.artibot/ledger/spawns.ndjson` and writes nothing to the central ledger.
Neither hook keeps a pending list. The join is recomputed from the ledger
(§3: "별도 상태 파일을 두지 않는다 — 두 번째 진실원 금지"), and this check
reports what that join left over on BOTH sides, side by side.

The judgement lives in `lib/project-state/doctor-checks.js#checkRouteBindResidue`
and performs NO I/O. This command reads two files and hands over two counts:

1. **Ledger side** — `loadReplay(projectRoot, { readLedger: readLedgerCensus })`
   from `lib/replay/index.js` (pass `readLedgerCensus` from
   `lib/runtime/ledger.js` as the port — `lib/replay` is L2 and may not import
   the runtime layer). The index carries `route_binds`
   (`lib/replay/route-bind.js#joinRouteBinds`): `unbound_receipts[]`,
   `orphan_binds[]`, `conflicts[]`, and `by_session`. `unboundReceipts` is
   `route_binds.unbound_receipts.length`. Scope to a session with
   `filter: { session_id }`, or read `by_session` for all of them.
2. **Spawn side** — `readSpawns(projectRoot, { sessionId })` from
   `lib/learning/ledger/spawn-ledger.js`, then
   `countUnboundSpawns(records)` (`lib/replay/route-bind.js`).
   `unboundSpawns` is its `unbound`: the number of DISTINCT `agentId`s whose
   `start` record carries `route_ledger: 'skipped:unbound'`. The axis is agent
   ids, not lines — measured 2026-09-04 on this repo's spawn ledger, counting
   `start` events under-counted by at least 12 and counting every event
   double-counted. When `spawns.ndjson` is absent, pass `undefined`, not `0`:
   zero unbound spawns in a file that does not exist is not a measurement.
3. Call `checkRouteBindResidue({ unboundReceipts, unboundSpawns, conflicts })`
   with `conflicts` = `route_binds.conflicts`.

Status for this check — **first matching row wins**:

| Condition | Status |
|---|---|
| Either count was not supplied (a file was not read) | **unmeasured** |
| `conflicts` non-empty — a `tool_use_id` or an `agent_id` bound more than once, or a receipt written twice (invariant 1) | **fail** |
| Both counts non-zero AND different | **warn** |
| Otherwise | **pass** |

Report BOTH counts together with the session scope and BOTH absolute file
paths (`.artibot/runtime/ledger.jsonl` and `.artibot/ledger/spawns.ndjson`),
the conflict count (or "not counted" when the join was not read), and the bind
side's own bounds — a 10-minute candidate window and a 128 KB ledger tail
(`subagent-handler.js#RECEIPT_WINDOW_MS`, `#RECEIPT_TAIL_BYTES`) — because a
receipt older than that window is unbound BY DESIGN and belongs in the reader's
explanation of the number, not in a warning.

**unmeasured is not a pass.** Both files are required. A residue verdict
reached from one side is a comparison with nothing on the other, and reporting
it as `pass` would be exactly the false green the two-file design exists to
prevent. Measured 2026-09-05 02:34 KST on the worktree that landed this
section, AFTER its own review agents had spawned: `ledger.jsonl` held 3
`route.selected` and 3 `route.bound` lines (`grep -c`), `spawns.ndjson` held 7
lines over 3 distinct agent ids (`route_ledger`: 3 `ok:bound`, 1
`skipped:already-bound`), the join gave bound 3 / unbound 0 / orphan 0 /
conflicts 0 (all `confidence: exact`, `prompt_id+name`), and
`checkRouteBindResidue` returned **pass** — one live end-to-end run. Before
those spawns (02:1x) the same tree held 0/0 and no spawn ledger, which is what
the `unmeasured` row is for. The warn and fail rows have been exercised on
fixtures only.

**What this check cannot see** (§9 — state it next to the gate):

- **Whether a bound pair is the RIGHT pair.** A tier-3 FIFO bind
  (`confidence: 'fifo'`) that picked the wrong receipt reads as bound. Equal
  residue counts mean nothing was left over, not that the pairs are correct.
  Correctness needs the bind line's `selected_model` against the receipt's
  prediction (invariant 2), which this check does not evaluate.
- **Asymmetries that are legitimate by design.** A spawn that never went through
  the `Agent` tool (SDK, scheduler, loop entry) has no receipt and is a normal
  `skipped:unbound`; a tool call the host cancelled leaves an unbound receipt
  with no spawn; a receipt past the 10-minute window or beyond the 128 KB tail
  is unbound on purpose. The warn row fires on any inequality and cannot tell
  these from a real miss — read the two lists, not just the two numbers.
- **Receipts the join excludes.** Pre-4.55 `route.selected` lines carry
  `shadow_of: spawn:<agentId>` and can never bind; they are counted under
  `route_binds.ignored.pre_tool_use_only` and never as residue.
- **Whether the two files cover the same span.** `ledger.jsonl` and
  `spawns.ndjson` rotate independently. A count of 0 on one side because the
  file was rotated is indistinguishable from 0 because nothing was unbound —
  state both paths and both mtimes in the report.
- **Spawn records with no session.** `countUnboundSpawns` buckets a record whose
  `sessionId` is null under `null`; a session-scoped read misses it.
- **Anything about a second worktree.** Both files are per worktree, so this
  compares one tree and says nothing about the others.

## Output Format

```
ARTIBOT HEALTH CHECK
=====================

[check-1-icon] Config: v{version}, {n} agents, {n} skills, {n} commands
[check-2-icon] Agents: {present}/{referenced} files present
[check-3-icon] Skills: {n} verified ({n} hash mismatches)
[check-4-icon] Hooks: {n} dispatchers, {n} scripts
[check-5-icon] MCP: {server1} ({status}), {server2} ({status})
[check-6-icon] Memory: {n} stores, {n} entries, {size} total
[check-7-icon] Explainability: {n} session event lines (24h), {n} cron files, trail legacy(frozen) {exists|absent}/{n}, last {timestamp}
[check-8-icon] State parity: {status} at state_version {n} ({n} gaps, {n} unpaired)
[check-9-icon] Artifacts: {n}/10 items measured, {n} failing, {n} missions read
[check-10-icon] Route bind: {n} unbound receipts / {n} unbound spawns, {n} conflicts

Status: {HEALTHY|DEGRADED|UNHEALTHY} ({passed}/{total} checks passed)
```

Status logic:
- **HEALTHY**: All 10 checks passed (zero errors)
- **DEGRADED**: 8-9 checks passed (warnings present)
- **UNHEALTHY**: 7 or fewer checks passed

An `unmeasured` check counts as neither passed nor failed. Report it as its own
number rather than folding it into either — "8 passed, 2 unmeasured" and "10
passed" are different results and the summary must not blur them.

Use checkmark for passed checks, cross for failed checks, warning sign for checks with non-critical issues.

If `--verbose` is set, expand each check section with per-item details (e.g., list every agent file, every skill hash comparison, every hook script parse result).

If `--json` is set, output a structured JSON object:
```json
{
  "timestamp": "ISO-8601",
  "version": "4.13.1",
  "checks": {
    "config": { "status": "pass", "details": {} },
    "agents": { "status": "pass", "details": {} },
    "skills": { "status": "pass", "details": {} },
    "hooks":  { "status": "pass", "details": {} },
    "mcp":    { "status": "warn", "details": {} },
    "memory": { "status": "pass", "details": {} },
    "explainability": { "status": "pass", "details": {} },
    "state":  { "status": "pass", "details": {} },
    "artifacts": { "status": "unmeasured", "details": { "measured": 4, "total": 10 } },
    "routing": { "status": "unmeasured", "details": { "unboundReceipts": 0, "unboundSpawns": null, "conflicts": 0 } }
  },
  "summary": { "passed": 8, "unmeasured": 2, "total": 10, "status": "DEGRADED" }
}
```

## Error Handling

- If `artibot.config.json` cannot be read or parsed, abort all checks and report a critical error — config is the foundation for checks 2-7
- If a specific check fails mid-execution (e.g., file I/O error), mark that check as FAIL and continue to the next check
- Never let a single check failure prevent the remaining checks from running

## Self-Heal (`--fix` / `--dry-run`)

When `--fix` (or `--dry-run`) is passed, after the 7 diagnostic checks above complete, route the collected failures through the self-heal layer in `lib/core/doctor-fix.js`. This is built for the non-developer ("vibe coder") who hits a sudden "it stopped working" wall and wants a one-shot recovery.

### Invocation

Import the module with a Korean-path-safe `file://` URL (the plugin root contains non-ASCII path segments — never pass a bare relative path to `import()`; build `file:///` manually as in `scripts/utils/index.js > toFileUrl()`):

```js
const { runDoctorFix } = await import(toFileUrl(join(pluginRoot, 'lib/core/doctor-fix.js')));
// dryRun defaults to TRUE — pass { dryRun: false } only under --fix.
const report = runDoctorFix(diagnostics, { dryRun: !hasFixFlag });
```

`diagnostics` is the array of failed-check codes (or `{ code, ...payload }` objects) gathered from checks 1-6. Map each failure to its self-heal code:

| Diagnostic code | From check | Severity | Repair action |
|---|---|---|---|
| `missing-runtime-dir` / `missing-memory-dir` / `missing-dir` | 1, 6 | auto | Recreate the directory (mkdir recursive) |
| `broken-config-json` / `broken-json` | 1, 6 | auto | Back up the corrupt file to `<file>.broken-<ts>`, then rewrite the default |
| `marketplace-mirror-stale` | 4 | auto | Re-sync the marketplace mirror (degrades to manual guidance if no mirror routine is injected) |
| `orphan-lock` | 4 | auto | Release a stale autopilot lock (degrades to manual guidance if no releaser is injected) |
| `hook-registration-missing` | 4 | **manual** | NEVER auto-applied — surfaces candidate `settings.json` paths for the user to wire |

### Safety contract (hard rules)

- **dryRun defaults to TRUE** — the filesystem is mutated only when `--fix` is passed (i.e. `{ dryRun: false }`). `--dry-run` and bare invocation both preview only.
- **Never destructive** — no deletes, no overwrite-without-backup, no git operations. Corrupt JSON is always backed up to `<file>.broken-<ts>` before any rewrite.
- **Never touches user settings** — `~/.claude/settings.json` is read-only to the self-heal layer; hook-registration gaps are surfaced as MANUAL guidance only.
- **100% local** — zero external network calls (DATA POLICY).
- **Never throws** — each repair is try-isolated; one failure cannot abort the rest of the pass.

### Output

`runDoctorFix` returns `{ dryRun, fixed[], skipped[], manual[] }`. Render it as a Korean-facing summary after the health-check report:

- `fixed[]` — repairs applied (or, under dry-run, what would be applied)
- `skipped[]` — no-ops (already healthy / no mapped action / unknown code)
- `manual[]` — actions requiring the user (hook registration, missing mirror/lock routines)

Under `--dry-run`, prefix the section with a clear "미리보기 (아무것도 변경하지 않음)" banner so the user knows nothing was written.

## Next Steps

| # | Action | Command | Description |
|---|--------|---------|-------------|
| 1 | Fix config issues | `/setup` | Re-run setup wizard to correct config |
| 2 | Rebuild skill cache | Run `buildSkillHashCache()` | Refresh stale or missing hash cache |
| 3 | Investigate failures | `/troubleshoot` | Deep-dive into specific failing checks |
| 4 | Full verification | `/verify` | Run lint + typecheck + test pipeline |
