# Fixtures for `scripts/orca/preflight.mjs` and `scripts/orca/plan.mjs`

Derived from LIVE Orca 1.4.259 output captured on 2026-11-19 from the leader's own Orca terminal. Nothing here is
invented: every kept value is copied. The edits are the ones in the table, and no others.

| File | Source command | Kept | Edits |
|---|---|---|---|
| `agent-context-1.4.259.excerpt.json` | `orca agent-context --json` (schemaVersion 1, commandCount 334) | the 23 commands `REQUIRED_ORCA_COMMANDS` names, in schema order, with `command` `path` `aliases` `argumentMode` `summary` `usage` `flags` `positionalArgs` (and `repeatableFlags` where the command has them) | `examples` and `notes` dropped; `commandCount` is still 334 (the excerpt holds 23 entries) |
| `status-1.4.259.json` | `orca status --json` | the whole `{ id, ok, result, _meta }` envelope | `result.runtime.capabilities` cut from 309 entries to the first 3 |
| `repo-list-1.4.259.json` | `orca repo list --json` | 4 of the 5 registered repos, one per shape seen live: git with a slash path and `agentWorkspaceTrust` (the Artibot repo), git with a backslash path, git without `agentWorkspaceTrust`, `kind: folder` | local paths became `<HOME>`; the user name and GitHub account became placeholders; the other projects are renamed `Other-A` `Other-B` `Other-C`; their remote identities are rewritten to placeholders |

The shapes that matter to the tests are real: Orca stores both `C:/x` and `C:\x` spellings of a repo path, an entry can
lack `agentWorkspaceTrust`, a registered `folder` is not a git repo, and `agent-context` flags are plain strings without
the leading dashes.

## Refreshing

When Orca is updated, capture the three commands again on the new version, derive the files the same way (keep only the
commands `REQUIRED_ORCA_COMMANDS` names, drop `examples` and `notes`, cut `capabilities`, replace personal paths and
names), rename the files to the new version, and update the version and `commandCount` pins in
`tests/orca/preflight-orca.test.js`. A required command or flag that is missing from the new schema shows up there as a
failing `orca-verbs` check, which is the point of keeping a real schema in the repo.

## What these fixtures cannot show

- How `orca status` answers while Orca is not running. The runtime was not stopped to find out, so that path is covered
  with a synthetic failure result only.
- Anything about the verbs' behaviour. Only their names and flags are compared.
- The permission mode of new agent tabs: there is no CLI surface for it, so no fixture can carry it.
