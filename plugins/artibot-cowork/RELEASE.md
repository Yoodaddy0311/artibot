# artibot-cowork Release SOP

This document is the single source of truth for releasing the `artibot-cowork`
sub-plugin. Follow it end-to-end — shortcutting steps is how release commits
get fragmented by the autopilot session-close hook (root cause of the v0.3.0
incident that motivated this SOP).

---

## 0. Prerequisites

| Item | Requirement |
|---|---|
| Branch | On `artibot/master` or `master`, up to date with `origin` |
| Autopilot | `.git/autopilot.json` exists and is healthy (run `--status` to confirm) |
| CI | Latest smoke tests passing on the target branch |
| Feature freeze | 24h soak since last structural change to cowork skills/agents |
| Reviewer | One teammate has signed off on the CHANGELOG entry |

---

## 1. Pre-release Checklist

- [ ] All planned skill/agent/command work is merged to the target branch
- [ ] `plugins/artibot-cowork/.claude-plugin/plugin.json` version has been bumped
- [ ] `plugins/artibot-cowork/CHANGELOG.md` has a `## [X.Y.Z]` section
- [ ] Smoke test suite (Unit K output) passes locally
- [ ] Token budget audit (Unit L output) is attached to the release note
- [ ] No unrelated WIP in working tree (`git status` clean or only release files staged)

---

## 2. Release Procedure (7 steps)

### Step 1 — Version bump
Edit `plugins/artibot-cowork/.claude-plugin/plugin.json` and set `"version"` to
the target `X.Y.Z`. If `plugins/artibot-cowork/package.json` exists, keep it in
sync.

### Step 2 — CHANGELOG entry
Append a section to `plugins/artibot-cowork/CHANGELOG.md`:

```
## [X.Y.Z] - YYYY-MM-DD
### Added
- schema-generator skill (AEO/GEO)
- smoke-test suite (Unit K)
### Changed
- seo-strategy skill — AEO/GEO tactics merged
### Fixed
- …
```

Heading format matters — the release script regex expects `## [X.Y.Z]` or
`## X.Y.Z` at line start.

### Step 3 — Acquire release lock
```bash
node plugins/artibot-cowork/scripts/release-lock.js --acquire --reason "cowork vX.Y.Z release"
```
This backs up `.git/autopilot.json` to `.git/autopilot.lock.json` and forces
`enabled=false`, `autoPushOnStop=false`, `squashWipOnClose=false` for the
release window. Verify with `--status`.

### Step 4 — Final staging work
Stage the release files and any last-minute co-changes:
```bash
git add plugins/artibot-cowork/.claude-plugin/plugin.json
git add plugins/artibot-cowork/CHANGELOG.md
git add <other release-window files>
```
Do not push yet.

### Step 5 — Release commit
Either run the orchestrator (recommended):
```bash
node plugins/artibot-cowork/scripts/release.js --version 0.4.0 --topic "schema-generator + smoke tests"
```
…or craft a manual commit:
```bash
git commit -m "release(artibot-cowork v0.4.0): schema-generator + smoke tests"
```

The orchestrator handles staging + commit + (optional) push + lock release in
one atomic run. Use `--dry-run` first if uncertain.

### Step 6 — Push
```bash
git push origin HEAD
# or if you used release.js, pass --push to combine with step 5
```

### Step 7 — Release the lock
```bash
node plugins/artibot-cowork/scripts/release-lock.js --release
```
Confirms autopilot is restored to its pre-release `enabled` value. If you used
`release.js` without `--dry-run`, this step is already done for you.

---

## 3. Post-release

- [ ] Re-run smoke tests on the released commit
- [ ] Update GitHub release notes: title `artibot-cowork vX.Y.Z`, body = CHANGELOG section
- [ ] Announce in team channel with token-budget delta from Unit L
- [ ] Confirm autopilot resumed: `node plugins/artibot-cowork/scripts/release-lock.js --status`

---

## 4. Rollback Procedure

### Autopilot lock stuck on
Symptom: autopilot never resumes after release window; `.git/autopilot.lock.json`
still present.
Fix:
```bash
node plugins/artibot-cowork/scripts/release-lock.js --status   # inspect
node plugins/artibot-cowork/scripts/release-lock.js --release  # restore
```
If the lock file is corrupt, delete `.git/autopilot.lock.json` manually and
restore `.git/autopilot.json` fields from the last known-good commit of that
file.

### Bad release commit
If the release commit points at broken code:
```bash
git revert <release-sha>
# bump to X.Y.Z+1 (patch), do NOT reuse the same version number
```
Then start a new release cycle from Step 1.

### Pushed before lock released
Running `--release` after the push is safe — the lock only governs autopilot
behavior on the local machine. Just run it as soon as possible so session-close
doesn't pile ambient commits on top of the release.

---

## 5. Scripts Cheat Sheet

| Command | Purpose |
|---|---|
| `node plugins/artibot-cowork/scripts/release-lock.js --acquire` | Pause autopilot + backup state |
| `node plugins/artibot-cowork/scripts/release-lock.js --release` | Restore autopilot to pre-release state |
| `node plugins/artibot-cowork/scripts/release-lock.js --status` | Inspect current lock + autopilot state |
| `node plugins/artibot-cowork/scripts/release.js --version X.Y.Z --dry-run` | Validate version + CHANGELOG + git state without side effects |
| `node plugins/artibot-cowork/scripts/release.js --version X.Y.Z` | Full release: validate → lock → stage → commit → unlock |
| `node plugins/artibot-cowork/scripts/release.js --version X.Y.Z --push` | Same as above plus `git push origin HEAD` |

---

## 6. Commit Message Convention

```
release(artibot-cowork vX.Y.Z): <topic ≤ 60 chars>
```

Examples:
- `release(artibot-cowork v0.4.0): schema-generator + smoke suite`
- `release(artibot-cowork v0.4.1): copywriting references refresh`
- `release(artibot-cowork v0.5.0): KR market skills (4 new)`

Scope tag `artibot-cowork` distinguishes from root `artibot` releases. Pair
every release commit with a matching GitHub release tag `artibot-cowork-vX.Y.Z`
(the parent `artibot-vX.Y.Z` tag remains separate).

---

## 7. Semantic Versioning Policy

| Bump | Trigger |
|---|---|
| **MAJOR** (X.0.0) | Breaking change to a skill/agent/command contract, schema change that forces users to update their own wrappers, or removal of a public skill |
| **MINOR** (0.Y.0) | New skills, new agents, new commands, additive parameters, non-breaking skill behavior expansion |
| **PATCH** (0.0.Z) | Bug fixes, doc/reference updates, prompt tuning that preserves existing behavior contracts |

Pre-`1.0.0` exception: breaking changes are currently allowed in MINOR bumps but
must be called out explicitly in the CHANGELOG under `### Breaking`.

---

## 8. Future Work — autopilot.json schema extension

Current approach toggles `enabled` directly. A cleaner long-term design adds a
dedicated field so autopilot hooks can recognize a release window without
losing the user's default preference:

```jsonc
// .git/autopilot.json
{
  "enabled": true,
  "releaseMode": false,   // NEW — set to true during a release window
  "autoPushOnStop": true,
  "squashWipOnClose": true,
  ...
}
```

When `releaseMode === true`, autopilot session-close/session-start hooks would
skip auto-commit and auto-push without touching `enabled`. This removes the
need for `release-lock.js` to mutate three different boolean fields and keeps
user intent intact.

**Status**: proposed, not implemented. `release-lock.js` currently handles the
fields it knows about (`enabled`, `autoPushOnStop`, `squashWipOnClose`) and the
backup file preserves the exact pre-release values. Implementing `releaseMode`
is a future task for the team owning `.claude/hooks/` autopilot scripts — this
SOP does not modify those hooks.
