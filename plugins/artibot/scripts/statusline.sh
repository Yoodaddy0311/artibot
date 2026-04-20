#!/usr/bin/env bash
# Artibot statusline renderer.
#
# Thin shell wrapper around scripts/statusline.js. Writes a single-line
# status to stdout for the Claude Code statusline, or an empty string
# on any failure.
#
# Env:
#   CLAUDE_PLUGIN_ROOT — plugin root (falls back to script's parent dir).

set -u

# Resolve plugin root: env var wins; otherwise use the directory above this script.
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-}"
if [ -z "${PLUGIN_ROOT}" ]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
fi
export CLAUDE_PLUGIN_ROOT="${PLUGIN_ROOT}"

# Never crash the caller: suppress stderr, fallback to empty output.
node "${PLUGIN_ROOT}/scripts/statusline.js" 2>/dev/null || echo ""
