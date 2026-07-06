# Marketplace Submission — Artibot

**Status:** DRAFT — do not submit without explicit user approval (submission is an
external, public-facing action).
**Owner:** artience.ads.team.tf@gmail.com
**Last verified against Claude Code docs:** 2026-07-03
**Manifest source of truth:** repo-root [`.claude-plugin/marketplace.json`](../.claude-plugin/marketplace.json)

This document is the current, schema-accurate submission guide. It **supersedes**
the older assumptions in [`plugins/artibot/_marketplace/`](../_marketplace/)
(dated 2026-04, pinned to v3.9.0), which still describes a PR-to-`claude-plugins-official`
flow that no longer applies (see §6 below).

---

## 1. Current distribution state (already live)

Artibot is **already installable today** as a self-hosted marketplace — no
Anthropic gatekeeping is required for distribution:

```text
/plugin marketplace add Yoodaddy0311/artibot
/plugin install artibot@artibot
```

This works because the repo root ships a valid `.claude-plugin/marketplace.json`
listing two plugins (`artibot`, `artibot-cowork`) with `./`-relative sources.
Submission to an Anthropic marketplace is **optional** and only buys additional
discovery (the community catalog + a possible Anthropic-Verified badge).

### Known limitations of native install (disclose in listing copy)

Native marketplace install loads only what Claude Code's plugin schema supports.
Two gaps must be disclosed honestly so listing copy does not overclaim parity:

1. **The 8 auto-activating rules are NOT delivered.** `plugin.json` declares a
   `rules[]` array (DEV Protocol, Quality Gates, agent-coordination, config-safety,
   clean-state, frontend/backend/test patterns), but `rules` is **outside the
   official plugin manifest schema** — `claude plugin validate` reports it as an
   ignored field. These rules are placed only by `install.sh` (`install_rules()`
   → `~/.claude/rules/artibot/`, install.sh:295-306, count verified at :927). So a
   purely native install does not get automatic DEV-protocol / quality-gate
   enforcement; only the full `install.sh` path does.
2. **A few convenience commands assume the flat layout.** `/theme`, `/update`, and
   the themed statusline hardcode `~/.claude/artibot/...` paths and currently
   malfunction under native install (tracked for a separate path-resolver refactor).

Commands, agents, skills, and hooks themselves load identically on both paths.

## 2. The two Anthropic marketplaces

| Marketplace | Repo / name | How it is populated | Applies to us |
|---|---|---|---|
| **Official** | `claude-plugins-official` | Curated by Anthropic at its sole discretion. **No application process.** The submission forms do **not** add here. | Not actionable — Anthropic-internal selection only. A prior PR to `anthropics/claude-plugins-official` was auto-rejected (recorded in `_marketplace/NEXT_ACTIONS.md`). |
| **Community** | `anthropics/claude-plugins-community` (installed as `@claude-community`) | Third-party submissions land here **after review + automated safety screening**. Approved plugins are pinned to a commit SHA; CI bumps the pin as you push; the public catalog syncs nightly. | **This is our target.** |

There is **no `external_plugins` field** to author. The community catalog is a
normal `marketplace.json` whose `plugins[]` entries are written by Anthropic's
review CI (name + source + SHA pin). Our job is only to make our own repo/manifest
pass validation and submit through the form — Anthropic's pipeline produces the
catalog entry.

## 3. How to submit (in-app form, not a PR)

Submission is via one of two in-app forms — **not** a pull request:

- **claude.ai** (Team/Enterprise orgs; org Owners have access by default):
  `claude.ai/admin-settings/directory/submissions/plugins/new`
- **Console** (individual authors not in a Team/Enterprise org):
  `platform.claude.com/plugins/submit`

Both require **user login** — an agent cannot complete them. The review pipeline
runs `claude plugin validate` plus automated safety screening on the submitted repo.

## 4. Pre-submission checklist

Run top-to-bottom. All must pass before the user submits.

- [ ] `claude plugin validate .` from the repo root — zero errors (this is the
      exact check the review pipeline runs).
- [ ] `.claude-plugin/marketplace.json` parses, has required `name` / `owner` /
      `plugins[]`, and each `source` starts with `./` (verified 2026-07-03: PASS).
- [ ] Marketplace `name` (`artibot`) is not on the reserved/impersonation list
      (verified: not reserved).
- [ ] Plugin names are kebab-case (`artibot`, `artibot-cowork`) — claude.ai sync
      rejects non-kebab-case names (PASS).
- [ ] Version lockstep: `plugins[].version` == each `plugin.json` `version`
      (artibot 4.29.0, artibot-cowork 3.1.0). Note the docs warn against declaring
      `version` in *both* places; our `release-check.js` keeps them synced so this
      is safe, but the marketplace-entry `version` is redundant with `plugin.json`.
- [ ] `cd plugins/artibot && npm run release:check && npm run ci` pass. (These
      scripts live in `plugins/artibot/package.json`; the repo-root `package.json`
      has an empty `scripts` block, so running them from the repo root fails.)
- [ ] `LICENSE` (MIT) present at repo root; `repository`/`homepage` URLs resolve.
- [ ] No secrets in tracked files (`git diff` review). DATA POLICY: local-only,
      OTEL opt-in — reflect this in listing copy.
- [ ] README leads with the native install path (done — root + plugin READMEs).

## 5. Post-approval behavior

- Anthropic CI pins your plugin to a **specific commit SHA** in the community
  `marketplace.json` and re-pins automatically as you push new commits.
- The public catalog **syncs nightly**, so expect a delay between approval and
  the plugin appearing. Check the
  [community catalog](https://github.com/anthropics/claude-plugins-community/blob/main/.claude-plugin/marketplace.json)
  for the plugin name to confirm it is installable.
- If Anthropic later lists us in the **official** marketplace, our CLI can prompt
  users to install via plugin hints (`/en/plugin-hints`) — a separate, future step.

## 6. Reconciling the legacy `_marketplace/` package

`plugins/artibot/_marketplace/` (v3.9.0, 2026-04) contains reusable listing copy
(`elevator-pitch.md`, `feature-matrix.md`, `demo-script.md`, screenshot specs) —
**keep and reuse these**. But three of its assumptions are now stale:

1. It names `plugins/artibot/marketplace.json` as the manifest source of truth.
   The live manifest is repo-root `.claude-plugin/marketplace.json`.
2. `SUBMISSION_CHECKLIST.md` §9 says "PR to the official marketplace repo." The
   real path is the in-app form → community marketplace (§3 above). Its own
   `NEXT_ACTIONS.md` already recorded the official-repo PR auto-rejection.
3. It references manifest fields (`entryPoints`, `qualityMetrics`, `media.*`,
   `safetyCompliance.*`) that are **not** part of the current marketplace schema.
   The live manifest is intentionally minimal and schema-clean; do not re-add them.

Recommendation: treat this file as the current submission runbook; mine the
legacy package only for listing copy and media specs.

## 7. Human-only actions (require user)

- Complete the claude.ai or Console submission form (login required).
- Provide media assets (demo video, screenshots, icon) — deferred per
  `_marketplace/NEXT_ACTIONS.md` §A.
- Approve any git tag/release push tied to submission.
