#!/usr/bin/env bash
# Artibot - One-click installer for Linux/macOS
# Usage: curl -fsSL https://raw.githubusercontent.com/Artience/artibot/main/plugins/artibot/scripts/install.sh | bash
#    or: bash scripts/install.sh [--plugin-dir <path>]
#
# Idempotent: safe to re-run. Will update in-place if already installed.

set -euo pipefail

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
ARTIBOT_VERSION="1.3.0"
MIN_NODE_MAJOR=18
DEFAULT_PLUGIN_DIR="$HOME/.claude/plugins/artibot"
REPO_URL="https://github.com/Artience/artibot"

# ANSI color helpers (no-op when not a tty)
if [ -t 1 ]; then
  RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; RESET='\033[0m'
else
  RED=''; GREEN=''; YELLOW=''; BLUE=''; RESET=''
fi

info()    { echo -e "${BLUE}[artibot]${RESET} $*"; }
success() { echo -e "${GREEN}[artibot]${RESET} $*"; }
warn()    { echo -e "${YELLOW}[artibot] WARN${RESET} $*" >&2; }
fail()    { echo -e "${RED}[artibot] ERROR${RESET} $*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# 1. Check Node.js >= 18
# ---------------------------------------------------------------------------
check_node() {
  info "Checking Node.js..."
  if ! command -v node &>/dev/null; then
    fail "Node.js not found. Install Node.js ${MIN_NODE_MAJOR}+ from https://nodejs.org and re-run."
  fi

  local version
  version=$(node --version)           # e.g. v18.20.0
  local major="${version#v}"
  major="${major%%.*}"

  if [ "$major" -lt "$MIN_NODE_MAJOR" ]; then
    fail "Node.js ${version} is too old. Requires >=${MIN_NODE_MAJOR}. Please upgrade."
  fi
  success "Node.js ${version} OK"
}

# ---------------------------------------------------------------------------
# 2. Detect / prompt for plugin directory
# ---------------------------------------------------------------------------
resolve_plugin_dir() {
  PLUGIN_DIR="${ARTIBOT_PLUGIN_DIR:-$DEFAULT_PLUGIN_DIR}"

  # Parse --plugin-dir flag if passed as argument
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --plugin-dir) PLUGIN_DIR="$2"; shift 2 ;;
      *) shift ;;
    esac
  done

  # If running interactively and no env override, offer to confirm default
  if [ -t 0 ] && [ -z "${ARTIBOT_PLUGIN_DIR:-}" ]; then
    echo -e "${BLUE}[artibot]${RESET} Plugin install directory [${PLUGIN_DIR}]: \c"
    read -r user_input
    if [ -n "$user_input" ]; then
      PLUGIN_DIR="$user_input"
    fi
  fi

  info "Plugin directory: ${PLUGIN_DIR}"
}

# ---------------------------------------------------------------------------
# 3. Clone or copy plugin files
# ---------------------------------------------------------------------------
install_files() {
  local source_dir
  # Determine if we are running from an already-cloned repo
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  source_dir="$(dirname "$SCRIPT_DIR")"   # plugins/artibot/

  if [ -f "${source_dir}/.claude-plugin/plugin.json" ]; then
    # Running from local clone — copy in place
    info "Installing from local source: ${source_dir}"
    mkdir -p "${PLUGIN_DIR}"
    cp -r "${source_dir}/." "${PLUGIN_DIR}/"
  else
    # Running via curl pipe — git clone
    if ! command -v git &>/dev/null; then
      fail "git not found. Install git and re-run, or download the plugin manually."
    fi
    if [ -d "${PLUGIN_DIR}/.git" ]; then
      info "Updating existing installation..."
      git -C "${PLUGIN_DIR}" pull --ff-only
    else
      info "Cloning repository..."
      mkdir -p "$(dirname "${PLUGIN_DIR}")"
      git clone --depth 1 "${REPO_URL}" "${PLUGIN_DIR}"
    fi
  fi

  success "Files installed to ${PLUGIN_DIR}"
}

# ---------------------------------------------------------------------------
# 4. npm ci (devDependencies only, skip scripts)
# ---------------------------------------------------------------------------
install_deps() {
  local pkg="${PLUGIN_DIR}/package.json"
  if [ ! -f "$pkg" ]; then
    warn "package.json not found, skipping npm install."
    return
  fi

  info "Installing dependencies..."
  # Use npm ci when lock file exists, else npm install --ignore-scripts
  if [ -f "${PLUGIN_DIR}/package-lock.json" ]; then
    npm ci --prefix "${PLUGIN_DIR}" --include=dev --ignore-scripts 2>&1 | tail -5
  else
    npm install --prefix "${PLUGIN_DIR}" --ignore-scripts 2>&1 | tail -5
  fi
  success "Dependencies installed"
}

# ---------------------------------------------------------------------------
# 5. Run validation
# ---------------------------------------------------------------------------
run_validation() {
  local validate="${PLUGIN_DIR}/scripts/validate.js"
  if [ ! -f "$validate" ]; then
    warn "validate.js not found, skipping validation."
    return
  fi

  info "Running validation..."
  if node "${validate}"; then
    success "Validation passed"
  else
    fail "Validation failed. Check errors above."
  fi
}

# ---------------------------------------------------------------------------
# 6. Display success message
# ---------------------------------------------------------------------------
print_success() {
  echo ""
  success "Artibot v${ARTIBOT_VERSION} installed successfully!"
  echo ""
  echo -e "  Plugin directory: ${BLUE}${PLUGIN_DIR}${RESET}"
  echo ""
  echo "  Getting started:"
  echo "    1. Open Claude Code"
  echo "    2. Load the plugin: /plugins load ${PLUGIN_DIR}"
  echo "    3. Try your first command: /sc help"
  echo ""
  echo "  Documentation: ${REPO_URL}#readme"
  echo ""
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
  echo ""
  echo "  Artibot v${ARTIBOT_VERSION} Installer"
  echo "  =================================="
  echo ""

  check_node
  resolve_plugin_dir "$@"
  install_files
  install_deps
  run_validation
  print_success
}

main "$@"
