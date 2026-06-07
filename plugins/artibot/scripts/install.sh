#!/usr/bin/env bash
# Artibot - One-click installer for Linux/macOS
# Usage: curl -fsSL https://raw.githubusercontent.com/Yoodaddy0311/artibot/main/plugins/artibot/scripts/install.sh | bash
#    or: bash scripts/install.sh [--plugin-dir <path>] [--dry-run] [--no-color]
#
# Idempotent: safe to re-run. Will update in-place if already installed.

set -euo pipefail

# ---------------------------------------------------------------------------
# Flags (parsed early so --no-color suppresses color even in dry-run banner)
# ---------------------------------------------------------------------------
DRY_RUN=0
NO_COLOR=0
# Strip --dry-run / --no-color from "$@" so downstream resolve_plugin_dir does
# not have to re-parse them. Other flags pass through unchanged.
_REMAINING=()
for _arg in "$@"; do
  case "$_arg" in
    --dry-run)  DRY_RUN=1 ;;
    --no-color) NO_COLOR=1 ;;
    *) _REMAINING+=("$_arg") ;;
  esac
done
set -- "${_REMAINING[@]:-}"

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
# Resolve plugin source dir (works for both `bash install.sh` and curl pipe)
_SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." 2>/dev/null && pwd || echo "")"
if [ -n "$_SOURCE_DIR" ] && [ -f "${_SOURCE_DIR}/.claude-plugin/plugin.json" ]; then
  ARTIBOT_VERSION=$(node -p "require('${_SOURCE_DIR}/.claude-plugin/plugin.json').version" 2>/dev/null || echo "unknown")
elif [ -n "$_SOURCE_DIR" ] && [ -f "${_SOURCE_DIR}/package.json" ]; then
  ARTIBOT_VERSION=$(node -p "require('${_SOURCE_DIR}/package.json').version" 2>/dev/null || echo "unknown")
else
  # curl-pipe path: $BASH_SOURCE is empty so _SOURCE_DIR is too. Fetch the
  # plugin.json from GitHub raw so the banner shows a real version instead
  # of "unknown". Parity with install.ps1's Invoke-RestMethod fallback. Five
  # second timeout so a flaky network never wedges the installer.
  _RAW_URL="https://raw.githubusercontent.com/Yoodaddy0311/artibot/master/plugins/artibot/.claude-plugin/plugin.json"
  ARTIBOT_VERSION="$(curl -fsSL --max-time 5 "$_RAW_URL" 2>/dev/null \
    | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).version||'unknown')}catch{console.log('unknown')}})" 2>/dev/null \
    || echo "unknown")"
fi
MIN_NODE_MAJOR=20
DEFAULT_PLUGIN_DIR="$HOME/.claude/plugins/artibot"
REPO_URL="https://github.com/Yoodaddy0311/artibot"

# ANSI color helpers (no-op when not a tty OR --no-color was passed)
if [ "$NO_COLOR" -eq 0 ] && [ -t 1 ]; then
  RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; RESET='\033[0m'
else
  RED=''; GREEN=''; YELLOW=''; BLUE=''; RESET=''
fi

info()    { echo -e "${BLUE}[artibot]${RESET} $*"; }
success() { echo -e "${GREEN}[artibot]${RESET} $*"; }
warn()    { echo -e "${YELLOW}[artibot] WARN${RESET} $*" >&2; }
fail()    { echo -e "${RED}[artibot] ERROR${RESET} $*" >&2; exit 1; }

# safe_copy_dir: copy a tree while excluding node_modules and .git.
# Why this helper exists: a bare `cp -r "${source_dir}/." "${PLUGIN_DIR}/"`
# happily walks into node_modules (huge) and .git (corrupting if a
# concurrent git op is mid-flight). The marketplace.sh mirror already learned
# this lesson; install.sh now uses the same pattern.
#
# Prefers rsync when available (cleanest --exclude semantics); falls back to
# `cp -r` with a post-copy prune so we never silently fail on minimal images
# (Alpine, distroless CI, etc.) that ship without rsync.
safe_copy_dir() {
  local src="$1" dst="$2"
  if [ "$DRY_RUN" -eq 1 ]; then
    info "[dry-run] would copy ${src} -> ${dst} (excl node_modules, .git)"
    return 0
  fi
  mkdir -p "$(dirname "$dst")"
  if command -v rsync &>/dev/null; then
    rsync -a --exclude='node_modules' --exclude='.git' "${src}/" "${dst}/"
  else
    cp -r "${src}/." "${dst}/"
    rm -rf "${dst}/node_modules" "${dst}/.git" 2>/dev/null || true
  fi
}

# ---------------------------------------------------------------------------
# 1. Check Node.js >= MIN_NODE_MAJOR
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
    if [ "$DRY_RUN" -eq 1 ]; then
      info "[dry-run] would install from ${source_dir} -> ${PLUGIN_DIR}"
    else
      mkdir -p "${PLUGIN_DIR}"
      safe_copy_dir "${source_dir}" "${PLUGIN_DIR}"
    fi
  else
    # Running via curl pipe — git clone
    if ! command -v git &>/dev/null; then
      fail "git not found. Install git and re-run, or download the plugin manually."
    fi
    if [ -d "${PLUGIN_DIR}/.git" ]; then
      info "Updating existing installation..."
      if [ "$DRY_RUN" -eq 1 ]; then
        info "[dry-run] would git -C ${PLUGIN_DIR} pull --ff-only"
      else
        git -C "${PLUGIN_DIR}" pull --ff-only
      fi
    else
      info "Cloning repository..."
      if [ "$DRY_RUN" -eq 1 ]; then
        info "[dry-run] would git clone --depth 1 ${REPO_URL} ${PLUGIN_DIR}"
      else
        mkdir -p "$(dirname "${PLUGIN_DIR}")"
        git clone --depth 1 "${REPO_URL}" "${PLUGIN_DIR}"
      fi
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
  if [ "$DRY_RUN" -eq 1 ]; then
    info "[dry-run] would run npm ci/install in ${PLUGIN_DIR}"
    return
  fi
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
  if [ "$DRY_RUN" -eq 1 ]; then
    info "[dry-run] would run node ${validate}"
    return
  fi
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
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "  Artibot v${ARTIBOT_VERSION} Installer  [DRY-RUN]"
  else
    echo "  Artibot v${ARTIBOT_VERSION} Installer"
  fi
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
