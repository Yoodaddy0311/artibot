#!/usr/bin/env bash
# sync-local.sh — Re-install the current plugin source into ~/.claude/artibot/
#
# Use this after bumping the version in package.json / plugin.json / artibot.config.json
# so the statusline and hooks pick up the new version without a fresh clone.
#
# Equivalent to running `bash install.sh` from the plugin root.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

if [ ! -f "${PLUGIN_ROOT}/install.sh" ]; then
  echo "[sync-local] install.sh not found at ${PLUGIN_ROOT}" >&2
  exit 1
fi

echo "[sync-local] Re-installing from ${PLUGIN_ROOT} → ~/.claude/artibot/"
bash "${PLUGIN_ROOT}/install.sh" "$@"
echo "[sync-local] Done. statusLine will show the new version on next session."
