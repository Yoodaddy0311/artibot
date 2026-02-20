---
description: Artibot 플러그인 버전 확인 및 업데이트
argument-hint: [--check | --force | --dry-run]
allowed-tools: [Bash, Read]
---

# /artibot:update

Check the current Artibot version against the latest GitHub release and optionally update.

## Arguments

Parse $ARGUMENTS:
- `--check` (default): Check version only, report whether an update is available, do not install
- `--force`: Force reinstall regardless of whether the installed version matches the latest
- `--dry-run`: Show what would happen without executing any install or cache operations

## Execution Flow

1. Run the update script via Bash:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/update.js" $ARGUMENTS
```

2. Display the full output of the script to the user exactly as printed.

3. If the script output contains the string `"RESTART REQUIRED"`, remind the user:
   > Restart Claude Code for the update to take effect.

## Argument Behavior Summary

| Flag | Checks Version | Downloads Update | Writes Files |
|------|---------------|-----------------|-------------|
| (none) / `--check` | Yes | No | No |
| `--force` | Yes | Yes (always) | Yes |
| `--dry-run` | Yes | No (preview only) | No |
| `--force --dry-run` | Yes | No (preview only) | No |

## Error Handling

If the script exits with a non-zero code, display its stderr output and suggest running manually:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/update.js" --check
```
