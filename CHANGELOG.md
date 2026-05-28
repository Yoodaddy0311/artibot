# Changelog

This file mirrors the canonical changelog maintained at [`plugins/artibot/CHANGELOG.md`](./plugins/artibot/CHANGELOG.md).

For the full version history including detailed technical notes, migration guides, and verification details, see the plugin-level changelog:

- **artibot (Claude Code)**: [`plugins/artibot/CHANGELOG.md`](./plugins/artibot/CHANGELOG.md)
- **artibot-cowork (Claude Cowork)**: [`plugins/artibot-cowork/CHANGELOG.md`](./plugins/artibot-cowork/CHANGELOG.md)

---

## Recent Releases

### [4.15.0] -- 2026-05-27

Cross-platform export extended to skills and commands via `--include`. Install URL fix and command count sync.

### [4.13.1] -- 2026-05-21

Turn-end auto-commit throttle -- `closeOnStop` flipped to opt-in to prevent git history noise.

### [4.13.0] -- 2026-05-19

`/save` and `/resume` single-shot session handoff. YAML frontmatter safety (machineId, createdAt, branch). Git lock graceful fail. 10-minute archive throttle.

### [4.12.0] -- 2026-05-19

Security hardening: timing-safe auth, K_SERVICE bypass removed, shell-injection surfaces eliminated. Manifest drift sync and layer-cycle fix.

---

For older releases and full details, see [`plugins/artibot/CHANGELOG.md`](./plugins/artibot/CHANGELOG.md).
