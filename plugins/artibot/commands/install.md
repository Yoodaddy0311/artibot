---
description: Install an Artibot extension from a local path or (future) URL
argument-hint: "<file://path-to-extension | https://github.com/Yoodaddy0311/...>"
allowed-tools: [Read, Bash]
toolset: code
lifecycle: install
---

# /install

Install a third-party Artibot extension (agents, skills, hooks, middleware)
into `~/.claude/plugins/artibot-ext-<name>/`. All installs go through the
Artibot marketplace installer, which enforces the DATA POLICY before any
files are copied.

## Usage

```
/install file:///C:/dev/my-ext
/install file:///home/user/my-ext
/install https://github.com/Yoodaddy0311/artibot-ext-korean-ecom-pack   # pending tarball support
```

## Arguments

- `<url>` (required): Source URL.
  - `file://<absolute-path>` — local directory that already contains
    `artibot.ext.json`. Installed by recursive copy.
  - `https://github.com/Yoodaddy0311/...` — reserved for Artibot-owned
    releases. Currently rejected with a clear "pending zero-deps tar support"
    error; kept in the allow list so future integration is a no-op for users.

Optional flags parsed from `$ARGUMENTS`:
- `--force` — overwrite an existing install with the same name.

## DATA POLICY (read before running)

Artibot only loads extensions whose manifest declares
`dataPolicy: "local"` or `dataPolicy: "artibot-swarm"`. Extensions that try
to set any other policy are rejected at manifest validation time, before
their code can be activated. You can further narrow what is accepted via
`artibot.config.json > extensions.allowedDataPolicies`.

Do **not** install extensions that:
- phone home to third-party servers
- connect to foreign databases
- export user data outside the Artibot swarm

If you are unsure, read the extension's `artibot.ext.json` first.

## Current Limitations

- Remote HTTPS tarball download is a **placeholder**. The installer
  validates the URL and then throws with the message
  `Remote tarball install pending zero-deps tar support`. Use `file://`
  for now (clone locally, then install from the clone directory).
- Only Artibot-owned GitHub URLs (`https://github.com/Yoodaddy0311/`) are
  allow-listed for the future remote path. All other hosts are rejected.
- No registry lookups. `installFromRegistry(...)` deliberately throws
  `Registry not yet available`.

## Implementation Notes

The runtime calls `installFromUrl(url, { force })` from
`lib/core/marketplace-installer.js`, which:

1. Parses the URL and checks the allow list.
2. For `file://`: resolves to a local directory, loads
   `artibot.ext.json`, runs `validateManifest()`.
3. Copies the directory to `~/.claude/plugins/artibot-ext-<name>/` using
   `fs.cp` (recursive, no tar needed).
4. Re-runs `loadExtension()` on the destination as a DATA POLICY
   double-check. If the re-check fails, the copy is rolled back
   (`fs.rm --recursive --force`) before the error surfaces.

Use `/uninstall <name>` or call `uninstall(name)` directly to remove.

## Examples

```
# Install a local extension you just cloned
/install file:///C:/dev/artibot-ext-korean-ecom-pack

# Force-overwrite an existing install
/install file:///C:/dev/artibot-ext-korean-ecom-pack --force
```
