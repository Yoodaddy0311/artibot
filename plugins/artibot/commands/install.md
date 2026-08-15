---
description: Install an Artibot extension from a local path, or activate a preset pack
argument-hint: "<file://path-to-extension | https://github.com/Yoodaddy0311/...> | --pack <name> | --list-packs"
allowed-tools: [Read, Bash]
toolset: code
lifecycle: install
---

# /install

Install a third-party Artibot extension (agents, skills, hooks, middleware)
into `~/.claude/plugins/artibot-ext-<name>/`, **or** activate a built-in
**preset pack** — a purpose-grouped bundle of skills/commands that already
ship inside the plugin. All installs go through the Artibot marketplace
installer / preset resolver, which enforces the DATA POLICY (100% local, no
network) before anything happens.

## Usage

```
# Single extension (local dir that already contains artibot.ext.json)
/install file:///C:/dev/my-ext
/install file:///home/user/my-ext
/install https://github.com/Yoodaddy0311/artibot-ext-korean-ecom-pack   # pending tarball support

# Preset packs (in-plugin skill/command bundles — no download)
/install --list-packs            # show available packs
/install --pack vibe             # verify/activate the "vibe" pack
/install --pack quality --dry-run
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
- `--list-packs` — list the available preset packs (no `<url>` needed).
- `--pack <name>` — activate a preset pack instead of installing a URL.
- `--dry-run` — with `--pack`, report what would be activated without side
  effects. (Preset application is already side-effect-free in the current
  local-only architecture, so this flag is informational today.)

## Preset Packs

A **preset pack** is a named, purpose-grouped list of skills and commands that
**already ship inside the Artibot plugin** — there is nothing to download. It
lets a vibe-coder verify/activate a curated set in one shot. The pack DATA
lives in `artibot.config.json > packs` (data only); the logic lives in
`lib/core/preset-packs.js`.

Built-in packs:

| Pack | Description | Members |
|------|-------------|---------|
| `vibe` | 바이브코딩 필수 — 자연어 빌드·명확화·온보딩·테마 | skills: vibe-coding, clarify, quickstart · commands: sc, doctor, theme |
| `quality` | 품질 게이트 — 검증·리뷰·테스트 | skills: verification-completion, tdd-workflow, quality-framework · commands: verify, code-review, test |
| `marketing` | 마케팅 — 콘텐츠·SEO·캠페인 | skills: marketing-strategy, content-seo, social-media · commands: mkt, content, seo |

"Activating" a pack in the current local-only architecture means: confirm each
member exists on disk, report any missing member (warn + skip, never fail),
and return a summary. No files are copied and no network is contacted. If a
future remote-extension installer is added, pack application can drive it — a
separate, explicit task.

### Call procedure (Korean-path-safe import)

The user's plugin path can contain non-ASCII characters (e.g. `바탕 화면`), so
import the module via a manually-constructed `file://` URL rather than a bare
specifier. From a Node ESM context:

```js
import path from 'node:path';

// toFileUrl: 한글 경로 안전 (pathToFileURL은 percent-encoding 때문에
// Windows 한글 경로에서 import() 실패 — scripts/utils/index.js#toFileUrl 참고)
const toFileUrl = (p) => {
  const f = p.replace(/\\/g, '/');
  return /^[A-Z]:/i.test(f) ? `file:///${f}` : `file://${f}`;
};

const root = process.env.CLAUDE_PLUGIN_ROOT; // plugin root
const { listPacks, resolvePack, applyPack } = await import(
  toFileUrl(path.join(root, 'lib', 'core', 'preset-packs.js'))
);
const { loadConfig } = await import(
  toFileUrl(path.join(root, 'lib', 'core', 'config.js'))
);

const config = await loadConfig();

// --list-packs
console.log(listPacks(config));

// --pack vibe (or --pack vibe --dry-run)
const report = applyPack('vibe', config, { dryRun: true });
// report = { ok, pack, dryRun, description, applied[], missing[], warnings[] }
```

- `listPacks(config)` → `[{ name, description, skillCount, commandCount }]`
  (empty `[]` when the config has no `packs` section — backward compatible).
- `resolvePack(name, config)` → full member list tagged with `exists`, or
  `null` for an unknown pack.
- `applyPack(name, config, { dryRun })` → verification summary. `ok:false`
  with a warning for an unknown pack; missing members land in `missing[]` +
  `warnings[]` (skipped, never thrown).

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

Call `uninstall(name)` directly to remove.

## Examples

```
# Install a local extension you just cloned
/install file:///C:/dev/artibot-ext-korean-ecom-pack

# Force-overwrite an existing install
/install file:///C:/dev/artibot-ext-korean-ecom-pack --force
```
