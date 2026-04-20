# Release Workflow

Artibot's version lives in **three** files that must stay in lockstep:

| File | Role |
|---|---|
| `package.json` | Node runtime + npm tooling |
| `artibot.config.json` | Plugin runtime config (read by `update.js`) |
| `.claude-plugin/plugin.json` | Claude Code plugin manifest |

A release also requires a matching `CHANGELOG.md` heading and a re-install into
`~/.claude/artibot/` so the statusline and hooks pick up the new version.

## Checklist

1. **Bump version** in all three files above (identical strings).
2. **Add a CHANGELOG entry** — heading format `## [X.Y.Z] - YYYY-MM-DD`.
3. **Run the release pipeline**:
   ```bash
   npm run release
   ```
   This runs, in order:
   - `release:check` — validates version consistency + CHANGELOG entry + installed-copy drift
   - `ci` — validate, lint, test, runtime evals
   - `sync:local` — re-runs `install.sh` so `~/.claude/artibot/` matches source
4. **Commit & tag**:
   ```bash
   git commit -am "release: vX.Y.Z"
   git tag vX.Y.Z
   git push origin master --tags
   ```
5. **Verify statusline** shows `artibot vX.Y.Z` on the next Claude session.

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
