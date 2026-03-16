---
description: (Artibot) Artibot 플러그인 버전 확인 및 자동 업데이트
argument-hint: 'e.g. "최신 버전 확인 및 업데이트"'
allowed-tools: [Bash, Read]
---

# /artibot:update

Check the current Artibot version against the latest GitHub release and auto-update if a newer version is available.

## Arguments

Parse $ARGUMENTS:
- (none): Auto-update — check version and install if an update is available
- `--check`: Check version only, report whether an update is available, do not install
- `--force`: Force reinstall regardless of whether the installed version matches the latest
- `--dry-run`: Show what would happen without executing any install or cache operations

## Execution Flow

1. Run the update script via Bash:

```bash
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/artibot}"
node "${PLUGIN_ROOT}/scripts/update.js" $ARGUMENTS
```

2. Display the full output of the script to the user exactly as printed.

3. If the script output contains the string `"RESTART REQUIRED"`, remind the user:
   > Restart Claude Code for the update to take effect.

## Argument Behavior Summary

| Flag | Checks Version | Downloads Update | Writes Files |
|------|---------------|-----------------|-------------|
| (none) | Yes | Yes (if available) | Yes (if available) |
| `--check` | Yes | No | No |
| `--force` | Yes | Yes (always) | Yes |
| `--dry-run` | Yes | No (preview only) | No |
| `--force --dry-run` | Yes | No (preview only) | No |

## Error Handling

If the script exits with a non-zero code, display its stderr output and suggest running manually:

```
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/artibot}"
node "${PLUGIN_ROOT}/scripts/update.js" --check
```

## Next Steps

작업 완료 후 추천 후속 액션:

| # | 액션 | 커맨드 | 설명 |
|---|------|--------|------|
| 1 | 프로젝트 로드 | `/load` | 업데이트 후 프로젝트 재로드 |
| 2 | 새 기능 확인 | `/index` | 업데이트된 기능 목록 확인 |
| 3 | 전체 검증 | `/verify` | 업데이트 후 전체 검증 |
