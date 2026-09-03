# Release Workflow

Artibot's version lives in **11 entries across 10 files** that must stay in lockstep.
`marketplace.json` contributes two of them (`version` and `release.current`).

**The canonical list is [`AGENTS.md` §8 Version alignment](./AGENTS.md#8-version-alignment)** —
it is not repeated here on purpose. This file used to carry its own list of three, and a
partial copy is exactly how the two documents drifted apart: a releaser who trusted this
page bumped three files and was stopped by the gate.

`scripts/release-check.js` enforces every one of the eleven and exits 1 on any mismatch,
so the gate — not this document — is the thing that decides. Beyond the version strings it
also requires a matching `CHANGELOG.md` heading (blocking), and warns when the installed
copy at `~/.claude/artibot/` is behind (non-blocking) so the statusline and hooks pick up
the new version.

## Checklist

1. **Bump version** across the full lockstep set in `AGENTS.md` §8 (identical strings).
   Two more spots are not gate-enforced but go stale if you skip them: the plugin table
   row in the root `README.md` and the config table row in `plugins/artibot/README.md`.
2. **Add a CHANGELOG entry** — a level-2 heading carrying the version, e.g.
   `## [X.Y.Z] — YYYY-MM-DD`. The gate accepts the brackets either way.
3. **Run the release pipeline** — but re-install *first*:
   ```bash
   npm run sync:local     # do this before release:check, not after
   npm run release:check  # expect exit 0
   npm run ci             # must be fully green
   ```
   `npm run release` chains exactly these three in exactly this order. It used to run
   them as `release:check && ci && sync:local`, with `sync:local` last, and that ordering
   made the chain stop at the first step after **every** bump: the installed copy is still
   on the previous version, `release-check.js` reports that as a drift warning and exits 2,
   and `&&` stops on any non-zero — even though nothing was actually wrong. The order was
   corrected in the script (2026-09-03, decision F-01) rather than by silencing the
   warning: `release-check.js` still exits 2 on warnings, because a real drift warning
   should still stop a release. Running `sync:local` first simply means the warning has
   nothing to report by the time the check runs.

   The trade-off of going first is deliberate: `sync:local` re-installs the source into
   `~/.claude/artibot/` **before** the version lockstep is verified, so a failed
   `release:check` leaves a local install of a version that never shipped. That is a local
   developer copy, not a published artifact, and re-running `sync:local` after the fix
   restores it — cheaper than a chain that can never reach step two.

   `release:check -- --no-sync-check` skips the installed-copy comparison entirely and is
   what CI uses, since CI has no installed copy at all.
4. **Commit** with explicit paths — never `git add -A`, and never `-am`. Untracked
   scratch directories sit in the tree and a blanket add sweeps them into the release.
   ```bash
   git add <paths>
   git commit -m "release: vX.Y.Z"
   ```
5. **Land it through a `ci/**` branch.** `master` is protected and the `pre-push` hook
   blocks a direct push, because a required status check can only pass on a commit that
   the server has already seen. Pushing straight to `master` lands a SHA whose checks
   have never run.
   ```bash
   git switch -c ci/release-vX.Y.Z
   git push -u origin ci/release-vX.Y.Z
   # wait for the four required contexts to go green on that SHA, and for
   # every other check run on it to finish without failing
   git switch master
   git merge --ff-only ci/release-vX.Y.Z
   git push origin master
   git push origin --delete ci/release-vX.Y.Z
   ```
   `--ff-only` is not optional: a merge commit is a new SHA carrying no check runs, which
   puts you back to pushing something unverified. The required contexts are listed in
   `.git/hooks/pre-push` (`required_contexts`), and the hook prints them when it blocks.
   Background: [CONTRIBUTING.md — Landing changes on master](../../CONTRIBUTING.md#landing-changes-on-master).
6. **Tag** the landed SHA and push the tag on its own. Tags are lightweight here.
   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```
7. **Verify statusline** shows `artibot vX.Y.Z` on the next Claude session.

> `ARTIBOT_ALLOW_DIRECT_PUSH=1` exists and will skip the landing gate. Reaching for it
> because the flow is slow is the failure mode the gate was built to catch — the point is
> that `master` only ever receives a SHA that is already green.

## Targeted commands

| Scenario | Command |
|---|---|
| Only verify versions + CHANGELOG | `npm run release:check` |
| Only re-sync local install (no CI) | `npm run sync:local` |
| CI context (skip local drift check) | `node scripts/release-check.js --no-sync-check` |

## Why the statusline can lag

`statusline.sh` reads `~/.claude/artibot/package.json` (the **installed** copy),
not the repo source. Bumping versions in the repo without re-running
`install.sh` is the common cause of "source says vX.Y, status bar says vX.Y-1".
`sync:local` solves this in one step.
