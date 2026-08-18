#!/usr/bin/env bash
# Artibot Installer - Claude Code Plugin
# Copies agents, commands, skills, hooks to ~/.claude/ for native integration
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_DIR="${HOME:-${USERPROFILE:-$(eval echo ~)}}/.claude"
ARTIBOT_DIR="${CLAUDE_DIR}/artibot"

# Minimum Node major. Lockstep with package.json#/engines/node (">=20") and
# scripts/install.sh / scripts/install.ps1 MIN_NODE_MAJOR. Bumped 18 -> 20 to
# match the per-plugin installer and prevent split-policy installs where the
# bootstrap rejects the runtime that this installer would accept.
MIN_NODE_MAJOR=20

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log()  { echo -e "${GREEN}[artibot]${NC} $1"; }
warn() { echo -e "${YELLOW}[artibot]${NC} $1"; }
err()  { echo -e "${RED}[artibot]${NC} $1" >&2; }

# ──────────────────────────────────────────────
# Partial-install accounting
# ──────────────────────────────────────────────
# Every atomic_replace_dir failure used to be swallowed by `|| true`, and
# verify_install only counts files — so an install that could not replace lib/
# still printed "Installation complete!" and exited 0, with the counts reading
# the STALE tree that was left in place. The user is then told a security fix
# landed when it did not. Each call site adds to this instead; verify_install
# turns a non-zero total into a PARTIAL INSTALL banner and a non-zero exit.
INSTALL_FAILURES=0

# ──────────────────────────────────────────────
# Concurrency lock
# ──────────────────────────────────────────────
# install_marketplace_mirror / install_plugin_cache write into LIVE plugin
# dirs. Two installers interleaving those steps half-empties the Claude Code
# plugin cache (2026-07-09 incident: cache lib/core reduced to 14 files, every
# hook spawn failing with ERR_MODULE_NOT_FOUND in all sessions).
# mkdir is atomic on every platform bash runs on, so it serves as the mutex.
# A stale lock older than 10 minutes is reclaimed (crashed installer).
#
# This lock and atomic_replace_dir cover different readers and do not overlap:
# the lock serializes installers against each other, while atomic_replace_dir
# protects LIVE SESSIONS reading a destination while one installer rewrites it
# — which no amount of installer-side locking can fix.
# It is acquired before install_hooks, so every staging path is under it.
#
# The lock is no longer the only thing keeping two runs' staging paths apart:
# those carry a PID suffix now, because this lock cannot cover every case. It
# is reclaimed after 600s, install.ps1 went without one entirely until the
# parity fix, and a shared staging name turned either gap into a truncated
# tree swapped onto a live destination.
INSTALL_LOCK_DIR="${CLAUDE_DIR}/.artibot-install.lock"
acquire_install_lock() {
  if mkdir "${INSTALL_LOCK_DIR}" 2>/dev/null; then
    trap 'rmdir "${INSTALL_LOCK_DIR}" 2>/dev/null || true' EXIT
    return 0
  fi
  local lock_mtime lock_age
  # GNU stat (Linux / Git Bash) first, BSD stat (macOS) fallback. If both fail
  # treat as mtime 0 → age is huge → reclaim path (fail-open beats deadlock).
  lock_mtime=$(stat -c %Y "${INSTALL_LOCK_DIR}" 2>/dev/null || stat -f %m "${INSTALL_LOCK_DIR}" 2>/dev/null || echo 0)
  lock_age=$(( $(date +%s) - lock_mtime ))
  if [ "${lock_age}" -gt 600 ]; then
    warn "Reclaiming stale install lock (age ${lock_age}s)"
    rmdir "${INSTALL_LOCK_DIR}" 2>/dev/null || true
    if mkdir "${INSTALL_LOCK_DIR}" 2>/dev/null; then
      trap 'rmdir "${INSTALL_LOCK_DIR}" 2>/dev/null || true' EXIT
      return 0
    fi
  fi
  err "Another install is already running (lock: ${INSTALL_LOCK_DIR}). Retry after it finishes."
  exit 1
}

# ──────────────────────────────────────────────
# Environment sanity: is this bash able to reach the user's install at all?
# ──────────────────────────────────────────────
# `bash` resolves to different binaries depending on what launched it. In a Git
# Bash session /usr/bin/bash wins; from PowerShell or cmd on Windows the first
# hit is C:\WINDOWS\system32\bash.exe — the WSL launcher (measured 2026-08-11).
# npm's default script shell on Windows is cmd, so `npm run sync:local` reaches
# WSL even though the checkout is a Windows one.
#
# Inside WSL, HOME is /home/<user>, so CLAUDE_DIR below resolves to the LINUX
# home while the Claude Code install this script exists to update lives on the
# Windows drive. Nothing useful can happen from there.
#
# This already fails rather than silently succeeding — `command -v claude` misses,
# because Claude Code is a Windows install — but it fails saying "Claude Code CLI
# not found", which sends the user off to reinstall a CLI they already have.
# Detect the real condition and say the real thing.
#
# Positive identification (WSL announces itself), not a denylist of launcher
# paths: a denylist would fail open on the next entry point that reaches WSL.
assert_supported_shell() {
  [ "$(uname -s 2>/dev/null)" = "Linux" ] || return 0

  local in_wsl=0
  [ -n "${WSL_DISTRO_NAME:-}" ] && in_wsl=1
  grep -qi microsoft /proc/version 2>/dev/null && in_wsl=1
  [ "${in_wsl}" -eq 1 ] || return 0

  # A Linux-side checkout under WSL is a legitimate Linux install; only a
  # Windows-mounted source tree means the user meant to install on Windows.
  case "${SCRIPT_DIR}" in
    /mnt/*) ;;
    *) return 0 ;;
  esac

  err "Running under WSL (${WSL_DISTRO_NAME:-linux}) against a Windows checkout:"
  err "  ${SCRIPT_DIR}"
  err "HOME here is ${HOME:-<unset>}, so this would install into the Linux home,"
  err "not the Windows Claude Code install it needs to update."
  err ""
  err "Run it from Windows instead:"
  err "  PowerShell:  powershell -ExecutionPolicy Bypass -File install.ps1"
  err "  Git Bash:    '/c/Program Files/Git/bin/bash.exe' install.sh"
  exit 1
}

# ──────────────────────────────────────────────
# Prerequisites
# ──────────────────────────────────────────────
check_prerequisites() {
  assert_supported_shell

  if ! command -v claude &>/dev/null; then
    err "Claude Code CLI not found. Install: https://docs.anthropic.com/en/docs/claude-code"
    exit 1
  fi

  if ! command -v node &>/dev/null; then
    err "Node.js not found. Install: https://nodejs.org/ (v${MIN_NODE_MAJOR}+)"
    exit 1
  fi

  local node_version
  node_version=$(node -v | sed 's/v//' | cut -d. -f1)
  if [ "$node_version" -lt "$MIN_NODE_MAJOR" ]; then
    err "Node.js ${MIN_NODE_MAJOR}+ required. Current: $(node -v)"
    exit 1
  fi

  log "Prerequisites OK (Claude Code + Node.js $(node -v))"
}

# ──────────────────────────────────────────────
# Safe recursive copy (exclude node_modules / .git)
# ──────────────────────────────────────────────
# Fresh-machine install used to copy node_modules/ (hundreds of MB, sometimes
# with Windows-incompatible symlinks) which hung or failed with EPERM. Always
# exclude node_modules and .git from recursive copies. Prefer rsync when
# available; fall back to a find+cp loop that respects the exclude list.
safe_copy_dir() {
  local src="$1"
  local dst="$2"
  if command -v rsync &>/dev/null; then
    rsync -a --exclude='node_modules' --exclude='.git' "${src}/" "${dst}/"
    return $?
  fi
  mkdir -p "${dst}"
  local base
  base="$(cd "${src}" && pwd)"
  find "${base}" -mindepth 1 \( -name node_modules -o -name .git \) -prune -o -print 2>/dev/null | while IFS= read -r entry; do
    local rel="${entry#${base}/}"
    [ "${rel}" = "${base}" ] && continue
    if [ -d "${entry}" ]; then
      mkdir -p "${dst}/${rel}"
    else
      mkdir -p "$(dirname "${dst}/${rel}")"
      cp "${entry}" "${dst}/${rel}"
    fi
  done
}

# ──────────────────────────────────────────────
# Crash-safe directory replace (stage, then swap by rename)
# ──────────────────────────────────────────────
# The three mirrors below used to `rm -rf "${dst}"` and then copy into it.
# Between those two steps the directory is absent or half-populated, and every
# hook a live session spawns out of it dies with ERR_MODULE_NOT_FOUND. That
# window is not a flicker: with rsync absent — the default for Git Bash on
# Windows — safe_copy_dir falls back to a per-file `cp` loop measured at 54.6s
# for the 293-file lib/ tree, and it pays that once per destination.
#
# Instead, copy into a sibling staging dir (the destination stays intact and
# complete for the whole copy) and swap by rename. The destination is then only
# absent between two renames — measured 161ms.
#
# WINDOWS RENAME SEMANTICS (measured on Git Bash / Win 11, not assumed from
# POSIX rename(2)):
#   - `mv src dst` when dst EXISTS moves src INSIDE dst instead of replacing
#     it. Hence the two-step swap; never a single mv onto a live path.
#   - Renaming a directory fails with EACCES while any process holds an open
#     handle to a file under it, whereas `rm -rf` on that same directory
#     SUCCEEDS. Rename is therefore strictly less available than delete here
#     and cannot be the only strategy.
#
# So when the swap is refused, fall back to overwriting in place from the
# staging copy without deleting anything first, then prune the paths the new
# tree no longer carries. Briefly mixed-version and slower, but every module
# path stays resolvable — the property this whole function exists to protect.
#
# Every HANDLED failure path leaves the previous directory in place. A stale
# mirror is recoverable by re-running the installer; a missing lib/ takes down
# every live session. Same fail-safe direction as clearCache() in
# scripts/update.js.
#
# What that promise does NOT cover: a signal (Ctrl-C), a kill, or a power loss
# landing between the two renames below leaves the destination absent until the
# next install. No trap restores it. The window is the ~161ms between
# `mv "${dst}" "${retired}"` and `mv "${staging}" "${dst}"`, which is 340x
# smaller than the rm-rf-then-copy window this replaced, but it is not zero and
# stating otherwise would be false comfort.
atomic_replace_dir() {
  local src="$1"
  local dst="$2"
  # PID-suffixed so two installers can never share a staging path. The mutex in
  # acquire_install_lock is the primary defence, but it does not cover every
  # case: a stale lock reclaimed at the 600s mark, or install.ps1, which used to
  # take no lock at all. Without unique names one run's leftover-prune deletes
  # the other run's half-written staging dir, and the victim then swaps the
  # remains into a live destination — the emptiness check below only sees the
  # top level, so a tree missing whole subtrees sails through it.
  local staging="${dst}.artibot-new.$$"
  local retired="${dst}.artibot-old.$$"

  # Our own leftovers (same PID, earlier run) are unconditionally ours to drop.
  # Foreign ones are pruned only when older than the same 10-minute threshold
  # acquire_install_lock uses for a stale lock: deleting a live installer's
  # staging dir is precisely the failure the PID suffix exists to prevent.
  # A leftover that survives is inert — nothing loads an `.artibot-new.*` or
  # `.artibot-old.*` path — so keeping one costs disk, not correctness.
  #
  # DELIBERATELY NOT PRUNED: the suffix-less `${dst}.artibot-new` and
  # `${dst}.artibot-old` that versions BEFORE the PID suffix left behind. Both
  # the glob below and install.ps1's StartsWith require the trailing dot, so a
  # bare name now survives forever (verified 2026-08-15 on a copy: bare kept,
  # foreign stale pruned, foreign fresh kept). That is the intended trade:
  # matching the bare name means deleting a path that is NOT unique, and an
  # older installer's LIVE staging dir is called exactly that. Those still run
  # — update.js drives the self-copied `~/.claude/artibot/install.sh`, which can
  # predate this change — so a prune-on-sight would delete a concurrent run's
  # half-written staging and re-create the truncated-swap outage the suffix was
  # added to prevent. The cost of leaving them is bounded disk in a directory
  # nothing reads, and it is self-limiting: only pre-suffix versions create one.
  rm -rf "${staging}" "${retired}" 2>/dev/null || true
  local _leftover _lmtime _lage _now
  _now=$(date +%s)
  for _leftover in "${dst}.artibot-new."* "${dst}.artibot-old."*; do
    [ -e "${_leftover}" ] || continue
    _lmtime=$(stat -c %Y "${_leftover}" 2>/dev/null || stat -f %m "${_leftover}" 2>/dev/null || echo '')
    # Unreadable mtime: leave it alone. The lock treats the same condition as
    # fail-open because a deadlock is worse than a race; here the direction
    # inverts, because the thing at risk is another run's live staging dir.
    [ -n "${_lmtime}" ] || continue
    _lage=$(( _now - _lmtime ))
    [ "${_lage}" -gt 600 ] || continue
    rm -rf "${_leftover}" 2>/dev/null || true
  done

  if ! safe_copy_dir "${src}" "${staging}"; then
    rm -rf "${staging}" 2>/dev/null || true
    warn "Staging copy failed for ${dst} — previous copy left in place"
    return 1
  fi

  # A copy that silently produced nothing must never replace a good tree.
  if [ -n "$(ls -A "${src}" 2>/dev/null)" ] && [ -z "$(ls -A "${staging}" 2>/dev/null)" ]; then
    rm -rf "${staging}" 2>/dev/null || true
    warn "Staging copy for ${dst} came out empty — previous copy left in place"
    return 1
  fi

  # ...and neither must a copy that produced only PART of one. `ls -A` reads
  # one level, so a staging dir that lost entire subtrees passes the check
  # above while being unloadable. Compare recursive file counts instead,
  # excluding the same node_modules/.git that safe_copy_dir skips so the two
  # sides are measured the same way.
  local src_files staging_files
  src_files=$(find "${src}" -mindepth 1 \( -name node_modules -o -name .git \) -prune -o -type f -print 2>/dev/null | wc -l | tr -d ' ') || true
  staging_files=$(find "${staging}" -mindepth 1 -type f -print 2>/dev/null | wc -l | tr -d ' ') || true
  [ -n "${src_files}" ] || src_files=0
  [ -n "${staging_files}" ] || staging_files=0
  if [ "${src_files}" -gt 0 ] && [ "${staging_files}" -lt "${src_files}" ]; then
    rm -rf "${staging}" 2>/dev/null || true
    warn "Staging copy for ${dst} is incomplete (${staging_files}/${src_files} files) — previous copy left in place"
    return 1
  fi

  # Nothing to displace: one rename, no window at all.
  if [ ! -d "${dst}" ]; then
    mv "${staging}" "${dst}" 2>/dev/null && return 0
    mkdir -p "${dst}"
    local fresh_failed=0
    cp -r "${staging}/." "${dst}/" 2>/dev/null || fresh_failed=1
    rm -rf "${staging}" 2>/dev/null || true
    if [ "${fresh_failed}" -ne 0 ]; then
      warn "Could not fully populate ${dst} after the rename was refused"
      return 1
    fi
    return 0
  fi

  if mv "${dst}" "${retired}" 2>/dev/null; then
    if mv "${staging}" "${dst}" 2>/dev/null; then
      # Best-effort: a `.artibot-old` that will not unlink is harmless and the
      # next run prunes it. Failing the install over it would be worse.
      rm -rf "${retired}" 2>/dev/null || true
      return 0
    fi
    # The destination is already moved aside — the one path that can leave a
    # mirror with no directory at all. Put it back before anything else.
    if mv "${retired}" "${dst}" 2>/dev/null; then
      warn "Swap failed for ${dst}; restored the previous copy"
    else
      warn "Swap failed for ${dst} and rename-back was refused; copying the previous copy back"
      mkdir -p "${dst}"
      cp -r "${retired}/." "${dst}/" 2>/dev/null || true
      rm -rf "${retired}" 2>/dev/null || true
    fi
    rm -rf "${staging}" 2>/dev/null || true
    return 1
  fi

  # Destination locked by an open handle. Overwrite in place: no path is ever
  # removed before its replacement exists. `cp -r` keeps going past individual
  # refusals, so this updates everything it can — but a partial result must be
  # said out loud, not returned as success (parity with Copy-TreeContents in
  # install.ps1, which reports the same condition as a count).
  local inplace_failed=0
  if ! cp -r "${staging}/." "${dst}/" 2>/dev/null; then
    inplace_failed=1
    warn "Some files under ${dst} are held by another process and stay at the previous version"
    warn "Re-run the installer once that process exits; the previous files are intact."
  fi
  local stale
  stale="$( (cd "${dst}" && find . -mindepth 1 2>/dev/null) || true )"
  while IFS= read -r rel; do
    [ -n "${rel}" ] || continue
    [ -e "${staging}/${rel}" ] || rm -rf "${dst}/${rel}" 2>/dev/null || true
  done <<< "${stale}"
  rm -rf "${staging}" 2>/dev/null || true
  # A partial overwrite is a partial install, and the comment above says so out
  # loud — but saying it in a warn() while returning 0 let main() print
  # "Installation complete!" over a mixed-version tree. The caller counts this.
  if [ "${inplace_failed}" -ne 0 ]; then
    return 1
  fi
  return 0
}

# ──────────────────────────────────────────────
# Self-install guard
# ──────────────────────────────────────────────
# When update.js falls back to the INSTALLED copy of install.sh
# (~/.claude/artibot/install.sh) — e.g. the source repo pull failed — then
# SCRIPT_DIR resolves to ARTIBOT_DIR itself. Every `cp -r "${SCRIPT_DIR}/X"
# "${ARTIBOT_DIR}/"` becomes a copy-onto-self ("cp: 'a' and 'a' are the same
# file") which `set -e` turns into a hard install failure.
#
# Detect that case and skip the file-copy phases (the files are already in
# place — it's a no-op, not an error). Config/settings/seed steps below still
# run normally.
#
# Uses `-ef` (same inode/device) when available; falls back to canonicalized
# `pwd -P` comparison for Git Bash on Windows where `-ef` semantics can differ
# across mounted drives.
is_self_install() {
  if [ "${SCRIPT_DIR}" -ef "${ARTIBOT_DIR}" ] 2>/dev/null; then
    return 0
  fi
  local src_real dst_real
  src_real="$(cd "${SCRIPT_DIR}" 2>/dev/null && pwd -P)" || return 1
  dst_real="$(cd "${ARTIBOT_DIR}" 2>/dev/null && pwd -P)" || return 1
  [ -n "$src_real" ] && [ "$src_real" = "$dst_real" ]
}

# ──────────────────────────────────────────────
# Directory Setup
# ──────────────────────────────────────────────
setup_directories() {
  mkdir -p "${CLAUDE_DIR}/agents"
  mkdir -p "${CLAUDE_DIR}/commands"
  mkdir -p "${CLAUDE_DIR}/rules/artibot"
  mkdir -p "${ARTIBOT_DIR}"
  log "Directories ready"
}

# ──────────────────────────────────────────────
# Copy Agents (28 agent .md files)
# ──────────────────────────────────────────────
install_agents() {
  local count=0
  for agent in "${SCRIPT_DIR}"/agents/*.md; do
    [ -f "$agent" ] || continue
    cp "$agent" "${CLAUDE_DIR}/agents/"
    count=$((count + 1))
  done
  log "Agents installed: ${count} files → ~/.claude/agents/"
}

# ──────────────────────────────────────────────
# Copy Commands (slash commands .md files)
# ──────────────────────────────────────────────
install_commands() {
  local count=0
  for cmd in "${SCRIPT_DIR}"/commands/*.md; do
    [ -f "$cmd" ] || continue
    cp "$cmd" "${CLAUDE_DIR}/commands/"
    count=$((count + 1))
  done
  log "Commands installed: ${count} files → ~/.claude/commands/"
}

# ──────────────────────────────────────────────
# Copy Skills (skill directories with SKILL.md + references/)
# ──────────────────────────────────────────────
install_skills() {
  local count=0
  if [ -d "${SCRIPT_DIR}/skills" ]; then
    safe_copy_dir "${SCRIPT_DIR}/skills" "${ARTIBOT_DIR}/skills"
    count=$(find "${SCRIPT_DIR}/skills" -maxdepth 1 -type d | wc -l)
    count=$((count - 1))
  fi
  log "Skills installed: ${count} skills → ~/.claude/artibot/skills/"
}

# ──────────────────────────────────────────────
# Copy Hooks & Scripts
# ──────────────────────────────────────────────
install_hooks() {
  # Replaced one dir at a time via atomic_replace_dir: still clean (stale files
  # from previous versions are dropped) but without the interval where the dir
  # is missing. statusline and the two mirrors below all read out of here.
  # `${INSTALL_FAILURES:-0}` rather than a bare reference: this function is
  # extracted and run on its own by tests/scripts/install-partial-failure.test.js,
  # and install.sh runs under `set -u` where an unset name is fatal.
  atomic_replace_dir "${SCRIPT_DIR}/hooks" "${ARTIBOT_DIR}/hooks" || INSTALL_FAILURES=$(( ${INSTALL_FAILURES:-0} + 1 ))
  atomic_replace_dir "${SCRIPT_DIR}/scripts" "${ARTIBOT_DIR}/scripts" || INSTALL_FAILURES=$(( ${INSTALL_FAILURES:-0} + 1 ))
  atomic_replace_dir "${SCRIPT_DIR}/lib" "${ARTIBOT_DIR}/lib" || INSTALL_FAILURES=$(( ${INSTALL_FAILURES:-0} + 1 ))
  if [ -d "${SCRIPT_DIR}/output-styles" ]; then
    atomic_replace_dir "${SCRIPT_DIR}/output-styles" "${ARTIBOT_DIR}/output-styles" || INSTALL_FAILURES=$(( ${INSTALL_FAILURES:-0} + 1 ))
  fi

  # Copy .claude-plugin metadata (plugin.json, swarm-profile.json, etc.)
  # This is needed so swarm-autodetect can find swarm-profile.json after update.
  if [ -d "${SCRIPT_DIR}/.claude-plugin" ]; then
    safe_copy_dir "${SCRIPT_DIR}/.claude-plugin" "${ARTIBOT_DIR}/.claude-plugin"
  fi

  # Copy config files
  cp "${SCRIPT_DIR}/artibot.config.json" "${ARTIBOT_DIR}/"
  [ -f "${SCRIPT_DIR}/package.json" ] && cp "${SCRIPT_DIR}/package.json" "${ARTIBOT_DIR}/"

  # Copy install.sh itself so update.js can find it after cache clear
  cp "${SCRIPT_DIR}/install.sh" "${ARTIBOT_DIR}/"

  log "Hooks & scripts installed → ~/.claude/artibot/"
}

# ──────────────────────────────────────────────
# Mirror to Claude Code marketplace install
# ──────────────────────────────────────────────
# Claude Code's plugin system keeps a marketplace copy at
#   ~/.claude/plugins/marketplaces/artibot/plugins/artibot/
# Sessions load hooks/skills from the per-version PLUGIN CACHE
# (~/.claude/plugins/cache/..., see install_plugin_cache below) — the
# marketplace copy is only the install SOURCE Claude Code pulls from.
#
# GIT-MANAGED GUARD (v4.36.4): when the marketplace copy is git-managed
# (github-sourced marketplace), Claude Code refreshes it with git pull.
# Writing into that worktree leaves it dirty/diverged, the pull then fails
# silently, and `claude plugin update` reports a stale version as
# "latest" forever (2026-07-13 v4.32.0-stuck incident). Never write into
# a git-managed marketplace — `claude plugin marketplace update artibot`
# owns that path. The mirror below only runs for non-git (directory-
# sourced) marketplace layouts.
#
# Legacy-stub policy: when a hook file is removed across versions (e.g.
# check-console-log.js was consolidated into dev-verify-gate.js in v4.7.2),
# leave a no-op stub at its original path. Existing Claude Code sessions
# cache the v3.0.0 hooks.json in memory and will try to exec the removed
# file on the next Stop event — MODULE_NOT_FOUND crashes the dispatcher.
# Stubs keep those in-flight sessions alive until they restart.
install_marketplace_mirror() {
  local mkt_clone="${CLAUDE_DIR}/plugins/marketplaces/artibot"
  local mkt_root="${mkt_clone}/plugins/artibot"
  if [ ! -d "${mkt_root}" ]; then
    log "Marketplace install not present (skip mirror)"
    return 0
  fi
  if [ -e "${mkt_clone}/.git" ]; then
    log "Marketplace is git-managed by Claude Code (skip mirror — use 'claude plugin marketplace update artibot')"
    return 0
  fi

  # Mirror the hot paths from the direct install we just wrote.
  # Same clean-replace contract as install_hooks for parity.
  for dir in scripts hooks lib skills output-styles .claude-plugin; do
    if [ -d "${ARTIBOT_DIR}/${dir}" ]; then
      atomic_replace_dir "${ARTIBOT_DIR}/${dir}" "${mkt_root}/${dir}" || INSTALL_FAILURES=$(( ${INSTALL_FAILURES:-0} + 1 ))
    fi
  done

  # Commands and agents live only in the source repo (direct install omits
  # them — Claude Code reads them straight from marketplace path). Pull them
  # from the source repo, not from ${ARTIBOT_DIR}.
  for dir in commands agents; do
    if [ -d "${SCRIPT_DIR}/${dir}" ]; then
      atomic_replace_dir "${SCRIPT_DIR}/${dir}" "${mkt_root}/${dir}" || INSTALL_FAILURES=$(( ${INSTALL_FAILURES:-0} + 1 ))
    fi
  done

  cp "${SCRIPT_DIR}/artibot.config.json" "${mkt_root}/"
  [ -f "${SCRIPT_DIR}/package.json" ] && cp "${SCRIPT_DIR}/package.json" "${mkt_root}/"
  log "Marketplace mirror updated → ${mkt_root}"
}

# ──────────────────────────────────────────────
# Mirror to Claude Code plugin cache (per-version dirs)
# ──────────────────────────────────────────────
# Claude Code maintains a per-version plugin cache at
#   ~/.claude/plugins/cache/artibot/artibot/<version>/
# At session start it loads hooks.json from THE CACHE DIR — not the
# marketplace mirror or the direct install. The cache is populated lazily
# from the marketplace mirror on first plugin activation and is NOT
# refreshed by install.sh writing only to the marketplace path. The
# v4.6.4 → v4.8.2 hook regression went unnoticed for so long precisely
# because users' caches held v4.6.4 args[] schema while the marketplace
# mirror had moved on.
#
# Mirroring the hot paths into every cache version dir keeps future
# sessions (post-restart) consistent. We do NOT touch .claude-plugin/plugin.json
# inside the cache (its version field is the cache routing key — overwriting
# it would orphan the cache entry from Claude Code's perspective). We also
# do NOT delete the cache dir here — clearCache() in scripts/update.js
# handles invalidation after an install. The split keeps install.sh
# non-destructive on a fresh-install path while still propagating runtime
# files to whatever cache versions already exist.
install_plugin_cache() {
  local cache_root="${CLAUDE_DIR}/plugins/cache/artibot/artibot"
  if [ ! -d "${cache_root}" ]; then
    log "Plugin cache not present (skip cache sync)"
    return 0
  fi

  local synced=0
  for version_dir in "${cache_root}"/*/; do
    [ -d "${version_dir}" ] || continue
    local v_root="${version_dir%/}"

    # Mirror runtime hot paths only (NOT .claude-plugin to preserve plugin.json
    # version routing key). Same clean-replace contract as the marketplace
    # mirror for parity.
    #
    # This is the destination live sessions actually execute out of, so it is
    # the one that made atomic_replace_dir necessary: a session whose hook
    # fires while this loop is mid-copy resolves its imports against whatever
    # exists at that instant.
    for dir in scripts hooks lib output-styles; do
      if [ -d "${ARTIBOT_DIR}/${dir}" ]; then
        atomic_replace_dir "${ARTIBOT_DIR}/${dir}" "${v_root}/${dir}" || INSTALL_FAILURES=$(( ${INSTALL_FAILURES:-0} + 1 ))
      fi
    done

    # Config files are version-tagged but the cache dir name is the routing
    # key — overwriting these is safe (cache invariant lives in plugin.json
    # which we deliberately leave alone).
    [ -f "${SCRIPT_DIR}/artibot.config.json" ] && cp "${SCRIPT_DIR}/artibot.config.json" "${v_root}/"
    [ -f "${SCRIPT_DIR}/package.json" ] && cp "${SCRIPT_DIR}/package.json" "${v_root}/"

    synced=$((synced + 1))
  done

  if [ "$synced" -gt 0 ]; then
    log "Plugin cache synced: ${synced} version dir(s) → ${cache_root}/"
  else
    log "Plugin cache directory present but contained no version dirs (skip)"
  fi
}

# ──────────────────────────────────────────────
# Copy Rules (project-level .claude/rules/)
# ──────────────────────────────────────────────
# Non-destructive: rules files are meant to be hand-edited by the user (they are
# personal always-on instructions), so an install must never silently overwrite
# local edits. When the installed copy diverges from the repo copy we park the
# repo version as <name>.md.artibot-new and leave the user's file alone.
# `.artibot-new` deliberately does not end in `.md`: verify_install (:972) and
# Claude Code's rules loader both glob `*.md`, so parked files are inert.
install_rules() {
  local count=0
  local preserved=0
  if [ -d "${SCRIPT_DIR}/rules" ]; then
    for rule in "${SCRIPT_DIR}"/rules/*.md; do
      [ -f "$rule" ] || continue
      local name dest
      name="$(basename "$rule")"
      dest="${CLAUDE_DIR}/rules/artibot/${name}"
      # A missing `cmp` makes this branch true, which errs toward preserving.
      if [ -f "$dest" ] && ! cmp -s "$rule" "$dest"; then
        cp "$rule" "${dest}.artibot-new"
        warn "  Kept your edited ${name} — new version saved as ${name}.artibot-new"
        preserved=$((preserved + 1))
        continue
      fi
      cp "$rule" "$dest"
      count=$((count + 1))
    done
  fi
  log "Rules installed: ${count} files → ~/.claude/rules/artibot/"
  if [ "$preserved" -gt 0 ]; then
    log "  Locally edited rules kept as-is: ${preserved} (review the .artibot-new files to merge)"
  fi
  log "  These rules auto-activate when Claude reads matching files (no /sc needed)"
}

# ──────────────────────────────────────────────
# Seed Project CLAUDE.md (Artibot methodology)
# ──────────────────────────────────────────────
seed_project_claude_md() {
  local target_dir="${1:-.}"
  local claude_md="${target_dir}/CLAUDE.md"

  if [ -f "$claude_md" ]; then
    # Check if Artibot section already exists
    if grep -q "## Artibot Integration" "$claude_md" 2>/dev/null; then
      log "Project CLAUDE.md already has Artibot section — skipping"
      return
    fi
    # Append Artibot section to existing CLAUDE.md
    cat >> "$claude_md" <<'ARTIBOT_SECTION'

## Artibot Integration

### DEV Protocol (Mandatory for all code changes)
1. **DECOMPOSE**: Break request into numbered atomic items before any action
2. **EXECUTE**: Read target file → Make change → Re-read to confirm
3. **VERIFY**: Report with evidence per item (file:line + what changed)

### Zero-Skip Policy
- Never silently skip any part of a multi-part request
- Never claim completion without re-reading the modified file
- If blocked, explain WHY and propose alternatives

### Agent Delegation
- Complex features: use planner agent first
- After writing code: use code-reviewer agent
- Bug fixes / new features: use tdd-guide agent
- Architecture decisions: use architect agent
- Multiple independent tasks: launch agents in parallel

### Quality Gates
- Read before write (no blind modifications)
- Functions < 50 lines, files < 800 lines
- Immutable patterns (create new objects, never mutate)
- 80%+ test coverage target
ARTIBOT_SECTION
    log "Artibot section appended to existing CLAUDE.md"
  else
    cat > "$claude_md" <<'PROJECT_CLAUDE'
# Project Instructions

## Artibot Integration

### DEV Protocol (Mandatory for all code changes)
1. **DECOMPOSE**: Break request into numbered atomic items before any action
2. **EXECUTE**: Read target file → Make change → Re-read to confirm
3. **VERIFY**: Report with evidence per item (file:line + what changed)

### Zero-Skip Policy
- Never silently skip any part of a multi-part request
- Never claim completion without re-reading the modified file
- If blocked, explain WHY and propose alternatives

### Agent Delegation
- Complex features: use planner agent first
- After writing code: use code-reviewer agent
- Bug fixes / new features: use tdd-guide agent
- Architecture decisions: use architect agent
- Multiple independent tasks: launch agents in parallel

### Quality Gates
- Read before write (no blind modifications)
- Functions < 50 lines, files < 800 lines
- Immutable patterns (create new objects, never mutate)
- 80%+ test coverage target
PROJECT_CLAUDE
    log "Project CLAUDE.md created with Artibot methodology"
  fi
}

# ──────────────────────────────────────────────
# Seed CLAUDE.local.md template
# ──────────────────────────────────────────────
seed_local_config() {
  local target_dir="${1:-.}"
  local local_md="${target_dir}/CLAUDE.local.md"
  local gitignore="${target_dir}/.gitignore"

  if [ -f "$local_md" ]; then
    log "CLAUDE.local.md already exists — skipping"
    return
  fi

  if [ -f "${SCRIPT_DIR}/templates/CLAUDE.local.md.template" ]; then
    cp "${SCRIPT_DIR}/templates/CLAUDE.local.md.template" "$local_md"
    log "CLAUDE.local.md created from template (personalize it!)"

    # Ensure CLAUDE.local.md is in .gitignore
    if [ -f "$gitignore" ]; then
      if ! grep -q "CLAUDE.local.md" "$gitignore" 2>/dev/null; then
        echo "CLAUDE.local.md" >> "$gitignore"
        log "Added CLAUDE.local.md to .gitignore"
      fi
    else
      warn "No .gitignore found — CLAUDE.local.md may be accidentally committed"
    fi
  else
    warn "CLAUDE.local.md.template not found at ${SCRIPT_DIR}/templates/ — skipping seed"
  fi
}

# ──────────────────────────────────────────────
# Seed Auto-Memory for new users
# ──────────────────────────────────────────────
# Staleness is TWO conditions, both required. Either one alone false-positives.
#
# 1. SEED_SIGNATURE — the file must actually be OUR seed. Without this the check
#    fires on memory files the installer never wrote. Measured, not assumed: the
#    live MEMORY.md in this repo's own project memory contains the literal
#    "인스톨러 유령 Task() 문자열" in a user-written backlog note, and it carries
#    no seed header. A bare `Task(` scan parks a file for that user and tells
#    them their seed is stale when they never had one.
# 2. STALE_SEED_PATTERN — the ghost name the seed itself emitted.
#
# The pattern is one literal, not a list. Every historical revision of the
# SEED_MEMORY heredoc was checked (`git log -S`): `Task()` is the only harness
# name this seed ever emitted (d778e739 for sh, 545b21fe for ps1), and it was
# renamed to `Agent`. TeamCreate/TeamDelete/TodoWrite are equally dead names but
# never appeared in THIS seed, so matching them would only fire on the user's own
# prose — and the parked seed would not remedy that line anyway. Substring match
# (`grep -F`) so the live `TaskCreate(`/`TaskUpdate(` tools do not match.
SEED_SIGNATURE='# Project Memory (Seeded by Artibot)'
STALE_SEED_PATTERN='Task('

# Emit the MEMORY.md quickstart body on stdout.
#
# Counts are computed here rather than by the caller so the fresh-seed path and
# the stale-park path render identical text from one source.
render_memory_seed() {
  local mem_agent_count mem_cmd_count mem_skill_count
  mem_agent_count=$(find "${CLAUDE_DIR}/agents" -name "*.md" -type f 2>/dev/null | wc -l | tr -d ' ')
  mem_cmd_count=$(find "${CLAUDE_DIR}/commands" -name "*.md" -type f 2>/dev/null | wc -l | tr -d ' ')
  mem_skill_count=$(find "${ARTIBOT_DIR}/skills" -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')
  mem_skill_count=$((mem_skill_count - 1))

  cat <<SEED_MEMORY
# Project Memory (Seeded by Artibot)

## Artibot Quick Reference
- **Agents**: ${mem_agent_count} specialized agents — use \`Agent()\` to delegate
- **Commands**: \`/sc\` routes to optimal command/agent/skill automatically
- **DEV Protocol**: Decompose → Execute → Verify (mandatory for all code changes)
- **Quality**: 80%+ test coverage, immutable patterns, functions < 50 lines

## Workflow Tips
- Complex features: start with \`/sc plan [feature]\` or use planner agent
- After implementation: code-reviewer agent runs automatically via rules
- Parallel work: launch multiple agents with \`Agent()\` for independent tasks
- Vibe coding: rules auto-activate on file access (no /sc needed after install)

## Key Paths
- Agents: \`~/.claude/agents/\` (${mem_agent_count} .md files)
- Commands: \`~/.claude/commands/\` (${mem_cmd_count} .md files)
- Skills: \`~/.claude/artibot/skills/\` (${mem_skill_count} skill directories)
- Rules: \`~/.claude/rules/artibot/\` (auto-activate on file access)
- Config: \`~/.claude/artibot/artibot.config.json\`
SEED_MEMORY
}

# Non-destructive repair for ALREADY-INSTALLED users.
#
# The seed is write-once, so a MEMORY.md written by an older installer keeps its
# stale `Task()` guidance forever. This NEVER rewrites that file — it is a user
# document by now — it only parks the current version alongside it, matching the
# `.artibot-new` convention install_rules (:599) uses for hand-edited rules.
# That suffix does not end in `.md`, so Claude Code's loaders ignore the parked
# copy. Re-parking overwrites any previous parked copy, again per install_rules:
# the parked file is a regenerated artifact, and a stale one from an older
# install is strictly worse than a current one.
#
# Silent when nothing is stale — the normal path must stay noise-free.
park_stale_memory_seed() {
  local memory_md="$1"
  local parked="${memory_md}.artibot-new"

  # Both conditions, in cheap-and-most-selective order. A user file that merely
  # talks about `Task()` is not our stale seed and must not be touched.
  grep -qF "$SEED_SIGNATURE" "$memory_md" 2>/dev/null || return 0
  grep -qF "$STALE_SEED_PATTERN" "$memory_md" 2>/dev/null || return 0

  if ! render_memory_seed > "$parked" 2>/dev/null; then
    # A half-written park is worse than none — it looks like current guidance.
    rm -f "$parked" 2>/dev/null || true
    warn "  Could not write MEMORY.md.artibot-new — leaving MEMORY.md untouched"
    return 0
  fi
  warn "Your MEMORY.md still names the old \`Task()\` tool (renamed to \`Agent()\`)"
  warn "  Your file is untouched — current version parked as MEMORY.md.artibot-new"
}

seed_auto_memory() {
  local memory_dir="${CLAUDE_DIR}/projects"
  # Find the current project's memory directory
  # Claude Code hashes paths: replace / \ : with -, strip leading -
  # On Git Bash, $PWD is /c/Users/... so normalize to C:\Users\... first
  local normalized_path="$PWD"
  if [[ "$normalized_path" =~ ^/([a-zA-Z])/ ]]; then
    normalized_path="${BASH_REMATCH[1]^^}:${normalized_path:2}"
  fi
  local project_hash
  # Include space in the char class — Claude Code's projects/ hash also
  # replaces spaces (Korean paths like "바탕 화면" contain a space + non-ASCII).
  # Without this, the computed hash dir won't exist and seeding silently misses.
  project_hash=$(echo "$normalized_path" | sed 's/[ \/:\\]/-/g' | sed 's/^-//')

  # Fallback: if computed hash dir doesn't exist, search for existing match
  if [ ! -d "${memory_dir}/${project_hash}" ] && [ -d "$memory_dir" ]; then
    local existing_match
    existing_match=$(find "$memory_dir" -maxdepth 1 -type d -name "*$(basename "$PWD")" 2>/dev/null | head -1)
    if [ -n "$existing_match" ]; then
      project_hash=$(basename "$existing_match")
    fi
  fi
  local project_memory="${memory_dir}/${project_hash}/memory"

  # Only seed if no MEMORY.md exists yet. Existing files are never rewritten —
  # but they may carry stale tool names from an older installer, so check.
  if [ -d "$project_memory" ] && [ -f "${project_memory}/MEMORY.md" ]; then
    park_stale_memory_seed "${project_memory}/MEMORY.md"
    log "Auto-memory already exists — skipping seed"
    return
  fi

  mkdir -p "$project_memory"
  render_memory_seed > "${project_memory}/MEMORY.md"
  log "Auto-memory seeded with Artibot quickstart → ${project_memory}/MEMORY.md"
}

# ──────────────────────────────────────────────
# Configure MCP Servers
# ──────────────────────────────────────────────
install_mcp() {
  local mcp_file="${CLAUDE_DIR}/.mcp.json"

  if [ -f "$mcp_file" ]; then
    warn "MCP config exists at ~/.claude/.mcp.json — merging manually recommended"
    warn "Artibot MCP config: ${SCRIPT_DIR}/.mcp.json"
  else
    if [ -f "${SCRIPT_DIR}/.mcp.json" ]; then
      cp "${SCRIPT_DIR}/.mcp.json" "$mcp_file"
      log "MCP servers configured (Context7, Playwright)"
    fi
  fi
}

# ──────────────────────────────────────────────
# Read-only permission allowlist seeded into settings.json
# ──────────────────────────────────────────────
# Conservative, read-only tools only. Seeding these into the NATIVE Claude Code
# `permissions.allow` list removes the repetitive "Allow Read?/Glob?/Grep?"
# prompts new users hit on first session — Artibot's hooks and routing fan out
# dozens of these safe reads per turn. Write/Edit/Bash are deliberately EXCLUDED
# (they can mutate the filesystem or run arbitrary commands); users who want
# broader auto-approval opt in explicitly via /permissions or settings
# defaultMode. Keep this list minimal and side-effect-free.
ARTIBOT_SAFE_ALLOW=(Read Glob Grep)

# ──────────────────────────────────────────────
# Configure Settings (Agent Teams env var + read-only permission seed)
# ──────────────────────────────────────────────
configure_settings() {
  local settings_file="${CLAUDE_DIR}/settings.json"

  if [ -f "$settings_file" ]; then
    # Check if AGENT_TEAMS env var already set
    if grep -q "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS" "$settings_file" 2>/dev/null; then
      log "Agent Teams already enabled in settings.json"
    else
      warn "Add this to ~/.claude/settings.json manually:"
      echo -e "${BLUE}  \"env\": { \"CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS\": \"1\" }${NC}"
    fi
    # Register statusLine if not already present
    _register_statusline "$settings_file"
    # Merge read-only permission allowlist (idempotent, preserves existing)
    _seed_permission_allow "$settings_file"
  else
    cat > "$settings_file" <<'SETTINGS'
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  },
  "permissions": {
    "allow": [
      "Read",
      "Glob",
      "Grep"
    ]
  },
  "statusLine": {
    "type": "command",
    "command": "bash ~/.claude/artibot/scripts/hooks/statusline.sh",
    "padding": 2
  }
}
SETTINGS
    chmod 600 "$settings_file"
    log "Settings created with Agent Teams enabled, read-only permissions seeded, and statusLine registered"
  fi

  # Advisory: how to broaden auto-approval beyond the safe read-only set.
  echo -e "${BLUE}  Tip:${NC} only read-only tools (Read/Glob/Grep) auto-approve by default."
  echo -e "       For broader auto-approval (e.g. Bash/Edit) run ${BLUE}/permissions${NC} in a"
  echo -e "       session, or set ${BLUE}\"defaultMode\"${NC} under \"permissions\" in ~/.claude/settings.json."
}

# ──────────────────────────────────────────────
# Octal permission bits of a file ("600"), empty when they cannot be read.
# ──────────────────────────────────────────────
# Both merge helpers below rewrite settings.json as temp-file + rename. A temp
# file is created under the caller's umask (0644 by default), so the rename
# silently REPLACED the mode the user had set: a settings.json locked to 600
# came back 644 after any re-install. The installer writes an `env` block into
# that file and users keep API keys there, so on a shared host that is a real
# disclosure.
#
# Restoring the ORIGINAL mode rather than forcing 600: the merge is an in-place
# edit and an in-place edit has no business changing metadata. Forcing 600 would
# fix the 600 case by breaking the symmetric one — a user who deliberately runs
# 644 (dotfile repo, shared group) would find it silently tightened, which is
# the same class of surprise in the other direction.
#
# `chmod --reference=FILE` would be one line but it is a GNU coreutils
# extension; this installer supports macOS, whose BSD chmod has no such flag.
# So read the bits and re-apply them, using the same GNU-then-BSD stat spelling
# acquire_install_lock already uses.
#
# FAILURE DIRECTION, so nobody has to re-derive it: if BOTH spellings miss (an
# unexpected stat, a permission error), this echoes empty, every caller's
# `[ -z "${mode}" ] ||` guard skips the chmod, and the rename proceeds exactly
# as it did before this helper existed. The bad case is therefore the OLD
# behaviour, not a broken install — worth knowing because `%Lp` is the spelling
# least likely to have been exercised on a given machine.
_file_mode() {
  stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1" 2>/dev/null || echo ''
}

# ──────────────────────────────────────────────
# Merge read-only allowlist into an existing settings.json
# Idempotent: existing permissions.allow entries are preserved; only the
# missing safe entries are appended. Prefers jq, falls back to node, then a
# manual hint. Never overwrites or reorders user-defined entries.
# ──────────────────────────────────────────────
_seed_permission_allow() {
  local settings_file="$1"
  local allow_csv
  # Build a JSON array literal "Read","Glob","Grep" for jq/node injection.
  allow_csv=$(printf '"%s",' "${ARTIBOT_SAFE_ALLOW[@]}")
  allow_csv="[${allow_csv%,}]"

  if command -v jq &>/dev/null; then
    local tmp_file="${settings_file}.tmp.$$"
    local mode
    mode=$(_file_mode "$settings_file")
    # Two steps, and both are needed. `umask 077` in a subshell makes the temp
    # file 0600 AT CREATION — without it the redirection creates it at the
    # caller's umask (0644 typically) and the chmod below only shortens the
    # window rather than removing it, since the temp sits in the same directory
    # as the file it is about to become. The chmod then restores the ORIGINAL
    # mode before the rename, so the real path is never briefly readable.
    #
    # If the mode could not be read, the guard skips the chmod and the file
    # lands 0600 rather than umask-default. That is the one case where this
    # changes a mode instead of preserving it, and 0600 is the right guess for
    # a file the installer writes an `env` block into.
    # Ensure .permissions.allow exists, then union with the safe set, dedupe.
    if ( umask 077; jq --argjson seed "$allow_csv" '
      .permissions = (.permissions // {})
      | .permissions.allow = ((.permissions.allow // []) + $seed | unique)
    ' "$settings_file" > "$tmp_file" 2>/dev/null ) \
      && { [ -z "${mode}" ] || chmod "${mode}" "$tmp_file"; } \
      && mv "$tmp_file" "$settings_file"; then
      log "Read-only permissions merged into settings.json (via jq)"
    else
      rm -f "$tmp_file"
      warn "Could not merge permissions via jq — add manually: \"permissions\": { \"allow\": ${allow_csv} }"
    fi
  elif command -v node &>/dev/null; then
    ARTIBOT_SETTINGS="$settings_file" ARTIBOT_ALLOW_SEED="$allow_csv" node --input-type=commonjs -e "
      const fs = require('fs');
      const path = process.env.ARTIBOT_SETTINGS;
      const seed = JSON.parse(process.env.ARTIBOT_ALLOW_SEED);
      const cfg = JSON.parse(fs.readFileSync(path, 'utf8'));
      const perms = cfg.permissions && typeof cfg.permissions === 'object' ? cfg.permissions : {};
      const existing = Array.isArray(perms.allow) ? perms.allow : [];
      const merged = [...existing];
      for (const entry of seed) { if (!merged.includes(entry)) merged.push(entry); }
      const next = { ...cfg, permissions: { ...perms, allow: merged } };
      const tmp = path + '.tmp.' + process.pid;
      // Preserve the original mode — see _file_mode() above for why the temp
      // file would otherwise hand back a umask-default 0644.
      let mode = null;
      try { mode = fs.statSync(path).mode & 0o777; } catch (e) { mode = null; }
      // mode 0o600 on CREATION so the temp is never briefly umask-default;
      // chmodSync afterwards because the mode option is masked by umask and so
      // cannot restore a mode more permissive than umask allows. Both halves.
      fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
      if (mode !== null) fs.chmodSync(tmp, mode);
      fs.renameSync(tmp, path);
    " && log "Read-only permissions merged into settings.json (via node)" \
      || warn "Could not merge permissions via node — add manually: \"permissions\": { \"allow\": ${allow_csv} }"
  else
    warn "Neither jq nor node available — add manually to ~/.claude/settings.json:"
    echo -e "${BLUE}  \"permissions\": { \"allow\": ${allow_csv} }${NC}"
  fi
}

# ──────────────────────────────────────────────
# Register statusLine in an existing settings.json
# Skips if statusLine key already present.
# Uses jq if available, falls back to Node.js.
# ──────────────────────────────────────────────
_register_statusline() {
  local settings_file="$1"

  # Skip if already registered
  if grep -q '"statusLine"' "$settings_file" 2>/dev/null; then
    log "statusLine already registered in settings.json — skipping"
    return
  fi

  local statusline_json='"statusLine": { "type": "command", "command": "bash ~/.claude/artibot/scripts/hooks/statusline.sh", "padding": 2 }'

  # Both branches below used to log success UNCONDITIONALLY, outside the
  # command chain — a failed jq or a node that never wrote still printed
  # "statusLine registered". _seed_permission_allow above already had the
  # correct shape, so this was an inconsistency inside one file rather than a
  # deliberate difference. Report what actually happened, in both branches.
  if command -v jq &>/dev/null; then
    # jq available: merge cleanly
    local tmp_file="${settings_file}.tmp.$$"
    local mode
    mode=$(_file_mode "$settings_file")
    # umask 077 at creation + chmod before rename — see _seed_permission_allow
    # for why both halves are load-bearing.
    if ( umask 077; jq '. + {"statusLine": {"type": "command", "command": "bash ~/.claude/artibot/scripts/hooks/statusline.sh", "padding": 2}}' \
      "$settings_file" > "$tmp_file" 2>/dev/null ) \
      && { [ -z "${mode}" ] || chmod "${mode}" "$tmp_file"; } \
      && mv "$tmp_file" "$settings_file"; then
      log "statusLine registered in settings.json (via jq)"
    else
      rm -f "$tmp_file"
      warn "Could not register statusLine via jq — add manually: ${statusline_json}"
    fi
  elif command -v node &>/dev/null; then
    # Node.js fallback: read, merge, write atomically
    if ARTIBOT_SETTINGS="$settings_file" node --input-type=commonjs -e "
      const fs = require('fs');
      const path = process.env.ARTIBOT_SETTINGS;
      const cfg = JSON.parse(fs.readFileSync(path, 'utf8'));
      if (!cfg.statusLine) {
        cfg.statusLine = { type: 'command', command: 'bash ~/.claude/artibot/scripts/hooks/statusline.sh', padding: 2 };
        const tmp = path + '.tmp.' + process.pid;
        let mode = null;
        try { mode = fs.statSync(path).mode & 0o777; } catch (e) { mode = null; }
        // mode 0o600 on CREATION closes the window the chmod alone leaves
        // open (the temp would otherwise appear at umask default first). The
        // option is masked by umask, so it can only ever be more restrictive
        // — which is why the chmod below is still what restores the real mode.
        fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
        if (mode !== null) fs.chmodSync(tmp, mode);
        fs.renameSync(tmp, path);
      }
    "; then
      log "statusLine registered in settings.json (via node)"
    else
      warn "Could not register statusLine via node — add manually: ${statusline_json}"
    fi
  else
    warn "Neither jq nor node available — add statusLine manually to ~/.claude/settings.json:"
    echo -e "${BLUE}  ${statusline_json}${NC}"
  fi
}

# ──────────────────────────────────────────────
# Swarm Intelligence Opt-In
# ──────────────────────────────────────────────
setup_swarm_consent() {
  # Skip if already configured (prevent repeated prompts on re-install)
  if [ -f "${ARTIBOT_DIR}/swarm-consent.json" ]; then
    log "Swarm consent already configured — skipping"
    return
  fi

  # Skip in non-interactive mode (CI, piped input, etc.)
  if [ ! -t 0 ]; then
    warn "Non-interactive mode — swarm disabled by default. Use '/sc swarm opt-in' later."
    return
  fi

  echo ""
  echo -e "${BLUE}━━━ Swarm Intelligence ━━━${NC}"
  echo "Share anonymized learning patterns with the Artibot community."
  echo "  • Tool usage success rates (anonymized)"
  echo "  • Error pattern signatures (SHA-256 hashed)"
  echo "  • Differential privacy noise applied (ε=1.0)"
  echo "  • No source code, file paths, or PII shared"
  echo ""
  read -p "Enable Swarm Intelligence? [y/N] " swarm_choice

  if [[ "$swarm_choice" =~ ^[Yy]$ ]]; then
    local consent_dir="${ARTIBOT_DIR}"
    mkdir -p "$consent_dir"
    local timestamp
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    cat > "${consent_dir}/swarm-consent.json" <<SWARMEOF
{
  "optedIn": true,
  "optedInAt": "$timestamp",
  "optedOutAt": null
}
SWARMEOF

    # Enable swarm in installed config so isSwarmActive() returns true
    local config_file="${ARTIBOT_DIR}/artibot.config.json"
    if [ -f "$config_file" ] && command -v node &>/dev/null; then
      ARTIBOT_CONFIG_FILE="$config_file" node --input-type=commonjs -e "
        const fs = require('fs');
        const cfg = JSON.parse(fs.readFileSync(process.env.ARTIBOT_CONFIG_FILE, 'utf8'));
        if (cfg.swarm) { cfg.swarm.enabled = true; cfg.swarm.optIn = true; }
        fs.writeFileSync(process.env.ARTIBOT_CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n');
      "
    fi

    log "Swarm Intelligence enabled. Use '/sc swarm opt-out' to disable."
  else
    echo -e "  ${GREEN}✓${NC} Swarm Intelligence skipped. Use '/sc swarm opt-in' to enable later."
  fi
}

# ──────────────────────────────────────────────
# Auto-Learning Pipeline Setup (zero-config auto-register)
# Priority: claude schedule > crontab > schtasks > hint-only
# ──────────────────────────────────────────────

# Read schedule cron expression from config
_get_auto_learning_schedule() {
  ARTIBOT_CFG="${ARTIBOT_DIR}/artibot.config.json" node --input-type=commonjs -e \
    "const c=JSON.parse(require('fs').readFileSync(process.env.ARTIBOT_CFG,'utf8')); console.log(c.autoLearning?.schedule||'0 3 * * *')" 2>/dev/null || echo "0 3 * * *"
}

# Check if autoLearning is enabled in config
_is_auto_learning_enabled() {
  ARTIBOT_CFG="${ARTIBOT_DIR}/artibot.config.json" node --input-type=commonjs -e \
    "const c=JSON.parse(require('fs').readFileSync(process.env.ARTIBOT_CFG,'utf8')); process.exit(c.autoLearning?.enabled===true?0:1)" 2>/dev/null
}

# Write marker file to prevent duplicate registration
_write_auto_learning_marker() {
  local marker="$1" method="$2" schedule="$3"
  local timestamp
  timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  MARKER_FILE="$marker" MARKER_TS="$timestamp" MARKER_SCHED="$schedule" MARKER_METHOD="$method" \
  node --input-type=commonjs -e "
    const fs = require('fs');
    fs.writeFileSync(process.env.MARKER_FILE, JSON.stringify({
      registeredAt: process.env.MARKER_TS,
      schedule: process.env.MARKER_SCHED,
      method: process.env.MARKER_METHOD
    }, null, 2) + '\n');
  " 2>/dev/null || true
}

# Strategy 1: claude schedule (persistent, cross-platform)
_try_claude_schedule() {
  local schedule="$1"
  if ! command -v claude &>/dev/null; then
    return 1
  fi

  # Build the pipeline prompt
  local prompt
  prompt="Run the Artibot auto-learning pipeline: self-scan, pattern-extract, knowledge-update, skill-refinement. Auto-commit and push if changes found."

  claude schedule create \
    --cron "$schedule" \
    --project "${ARTIBOT_DIR}" \
    --prompt "$prompt" \
    &>/dev/null

  return $?
}

# Strategy 2: crontab (Linux/macOS)
_try_crontab() {
  local schedule="$1"
  if ! command -v crontab &>/dev/null; then
    return 1
  fi

  local runner_path="${ARTIBOT_DIR}/scripts/run-auto-learning.js"
  if [ ! -f "$runner_path" ]; then
    return 1
  fi

  local cron_comment="# artibot-auto-learning"
  # Log under the user's own directory, not /tmp.
  #
  # The old target was the fixed name /tmp/artibot-auto-learning.log. /tmp is
  # world-writable and shared, so another local account can pre-create that name
  # as a symlink and the job's `>>` follows it. On Linux the default
  # fs.protected_symlinks=1 blocks following another user's symlink in a sticky
  # directory — but this branch is the Linux AND macOS path (Windows takes
  # _try_schtasks), and macOS has no such sysctl. Relying on a mitigation that
  # only one of the two supported platforms provides is not a reason to keep a
  # shared-directory path when a private one costs nothing.
  #
  # `mkdir -p logs` runs INSIDE the cron command rather than at install time so
  # a deleted (or never-created) log directory cannot silently disable the job:
  # the redirection for `node` is opened only when node runs, which is after the
  # mkdir in this && chain. /tmp always existed, and that availability property
  # has to be matched, not traded away.
  #
  # ARTIBOT_DIR is quoted here — a home directory containing a space would
  # otherwise split `cd` mid-path. Unrelated to the /tmp issue, same one line.
  local cron_line="${schedule} cd \"${ARTIBOT_DIR}\" && mkdir -p logs && node scripts/run-auto-learning.js >> logs/auto-learning.log 2>&1 ${cron_comment}"

  # Check if already in crontab (idempotent)
  if crontab -l 2>/dev/null | grep -q "artibot-auto-learning"; then
    return 0
  fi

  # Append to existing crontab
  ( crontab -l 2>/dev/null; echo "$cron_line" ) | crontab - 2>/dev/null
  return $?
}

# Strategy 3: schtasks (Windows)
_try_schtasks() {
  if ! command -v schtasks.exe &>/dev/null && ! command -v schtasks &>/dev/null; then
    return 1
  fi

  local runner_path="${ARTIBOT_DIR}/scripts/run-auto-learning.js"
  if [ ! -f "$runner_path" ]; then
    return 1
  fi

  local task_name="ArtibotAutoLearning"

  # Check if already registered (idempotent)
  if schtasks.exe /Query /TN "$task_name" &>/dev/null 2>&1 || schtasks /Query /TN "$task_name" &>/dev/null 2>&1; then
    return 0
  fi

  # Convert ARTIBOT_DIR to Windows path for schtasks
  local win_artibot_dir
  win_artibot_dir=$(cygpath -w "$ARTIBOT_DIR" 2>/dev/null || echo "$ARTIBOT_DIR")

  local node_path
  node_path=$(which node 2>/dev/null || command -v node 2>/dev/null)
  local win_node_path
  win_node_path=$(cygpath -w "$node_path" 2>/dev/null || echo "$node_path")

  local win_runner
  win_runner=$(cygpath -w "$runner_path" 2>/dev/null || echo "$runner_path")

  # Create daily task at 03:00
  local schtasks_cmd="schtasks.exe"
  command -v schtasks.exe &>/dev/null || schtasks_cmd="schtasks"

  $schtasks_cmd /Create \
    /TN "$task_name" \
    /TR "\"${win_node_path}\" \"${win_runner}\"" \
    /SC DAILY \
    /ST 03:00 \
    /F \
    &>/dev/null 2>&1

  return $?
}

setup_auto_learning() {
  local marker="${ARTIBOT_DIR}/auto-learning-registered.json"

  # Skip if already registered
  if [ -f "$marker" ]; then
    log "Auto-learning schedule already registered — skipping"
    return
  fi

  # Check if auto-learning is enabled
  if ! _is_auto_learning_enabled; then
    log "Auto-learning pipeline disabled in config — skipping"
    return
  fi

  local schedule
  schedule=$(_get_auto_learning_schedule)
  local method="none"
  local success=false

  echo ""
  echo -e "${BLUE}━━━ Auto-Learning Pipeline ━━━${NC}"
  echo "Setting up automatic learning schedule: ${schedule}"

  # Strategy 1: claude schedule
  if _try_claude_schedule "$schedule" 2>/dev/null; then
    method="claude-schedule"
    success=true
    log "Auto-learning registered via claude schedule (persistent)"
  fi

  # Strategy 2: crontab (Linux/macOS)
  if [ "$success" = false ] && _try_crontab "$schedule" 2>/dev/null; then
    method="crontab"
    success=true
    log "Auto-learning registered via crontab"
  fi

  # Strategy 3: schtasks (Windows)
  if [ "$success" = false ] && _try_schtasks 2>/dev/null; then
    method="schtasks"
    success=true
    log "Auto-learning registered via Windows Task Scheduler"
  fi

  # Fallback: hint only
  if [ "$success" = false ]; then
    method="hint-only"
    warn "Could not auto-register schedule. Options:"
    echo -e "  ${BLUE}1)${NC} In Claude session: use CronCreate tool"
    echo -e "  ${BLUE}2)${NC} Manual: node ~/.claude/artibot/scripts/setup-auto-learning.js --schedule"
    echo -e "  ${BLUE}3)${NC} CI: node ~/.claude/artibot/scripts/setup-auto-learning.js --webhook"
  fi

  # Write marker regardless (prevents re-prompting)
  _write_auto_learning_marker "$marker" "$method" "$schedule"

  if [ "$success" = true ]; then
    log "Auto-learning pipeline active: ${schedule} via ${method}"
  fi
}

# ──────────────────────────────────────────────
# Save Source Repo Path (for auto-update git pull)
# ──────────────────────────────────────────────
save_source_path() {
  local source_json="${ARTIBOT_DIR}/source-repo.json"
  local git_root
  git_root="$(cd "$SCRIPT_DIR" && git rev-parse --show-toplevel 2>/dev/null)" || true

  if [ -n "$git_root" ]; then
    local timestamp
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    REPO_ROOT="$git_root" PLUGIN_DIR="$SCRIPT_DIR" SAVE_AT="$timestamp" SOURCE_JSON="$source_json" \
    node --input-type=commonjs -e "
      const fs = require('fs');
      fs.writeFileSync(process.env.SOURCE_JSON, JSON.stringify({
        repoRoot: process.env.REPO_ROOT,
        pluginDir: process.env.PLUGIN_DIR,
        savedAt: process.env.SAVE_AT
      }, null, 2) + '\n');
    "
    log "Source repo path saved for auto-updates: ${git_root}"
  else
    warn "Not a git repo — source path not saved (manual git pull needed for updates)"
  fi
}

# ──────────────────────────────────────────────
# Verify Installation
# ──────────────────────────────────────────────
verify_install() {
  echo ""
  log "━━━ Installation Summary ━━━"

  local agent_count cmd_count skill_count hook_count rule_count
  agent_count=$(find "${CLAUDE_DIR}/agents" -name "*.md" -type f 2>/dev/null | wc -l)
  cmd_count=$(find "${CLAUDE_DIR}/commands" -name "*.md" -type f 2>/dev/null | wc -l)
  skill_count=$(find "${ARTIBOT_DIR}/skills" -maxdepth 1 -type d 2>/dev/null | wc -l)
  skill_count=$((skill_count - 1))
  hook_count=$(find "${ARTIBOT_DIR}/scripts/hooks" -name "*.js" -type f 2>/dev/null | wc -l)
  rule_count=$(find "${CLAUDE_DIR}/rules/artibot" -name "*.md" -type f 2>/dev/null | wc -l)

  echo -e "  Agents:   ${GREEN}${agent_count}${NC} files in ~/.claude/agents/"
  echo -e "  Commands: ${GREEN}${cmd_count}${NC} files in ~/.claude/commands/"
  echo -e "  Skills:   ${GREEN}${skill_count}${NC} dirs in ~/.claude/artibot/skills/"
  echo -e "  Rules:    ${GREEN}${rule_count}${NC} files in ~/.claude/rules/artibot/ (auto-activate)"
  echo -e "  Hooks:    ${GREEN}${hook_count}${NC} scripts in ~/.claude/artibot/scripts/"
  echo ""

  # Check memory extensions
  [ -f "./CLAUDE.md" ] && echo -e "  Project:  ${GREEN}CLAUDE.md${NC} seeded with Artibot methodology"
  [ -f "./CLAUDE.local.md" ] && echo -e "  Local:    ${GREEN}CLAUDE.local.md${NC} ready for personalization"
  echo ""

  # The counts above are read off whatever is on disk, so a directory that
  # could not be replaced still counts — as its PREVIOUS version. Only the
  # failure tally can tell the two apart, which is why the completion line is
  # gated on it rather than printed unconditionally.
  if [ "${INSTALL_FAILURES:-0}" -gt 0 ]; then
    err "PARTIAL INSTALL — ${INSTALL_FAILURES} directory replacement(s) failed."
    err "The previous copies were left in place, so the counts above may describe"
    err "the OLD version. Re-run the installer once the files named in the"
    err "warnings above are no longer held by another process."
    return 1
  fi

  log "Installation complete! Start Claude Code and type: /sc hello"
  log ""
  log "Memory extensions installed:"
  log "  - Project CLAUDE.md: DEV protocol auto-loads for all sessions"
  log "  - Path rules: domain-specific rules load only for matching files"
  log "  - CLAUDE.local.md: personalize your preferences (auto-gitignored)"
  log "  - Auto-memory: quickstart guide seeded for new users"
}

# ──────────────────────────────────────────────
# Uninstall
# ──────────────────────────────────────────────
uninstall() {
  warn "Removing Artibot..."

  # Remove agents that came from artibot
  for agent in "${SCRIPT_DIR}"/agents/*.md; do
    [ -f "$agent" ] || continue
    local basename
    basename=$(basename "$agent")
    rm -f "${CLAUDE_DIR}/agents/${basename}"
  done

  # Remove commands that came from artibot
  for cmd in "${SCRIPT_DIR}"/commands/*.md; do
    [ -f "$cmd" ] || continue
    local basename
    basename=$(basename "$cmd")
    rm -f "${CLAUDE_DIR}/commands/${basename}"
  done

  # Remove artibot rules
  rm -rf "${CLAUDE_DIR}/rules/artibot"

  # Remove artibot directory
  rm -rf "${ARTIBOT_DIR}"

  # Note: CLAUDE.md, CLAUDE.local.md, and auto-memory are left intact
  # (they may contain user customizations)
  log "Artibot uninstalled. MCP config, settings.json, CLAUDE.md, and auto-memory left unchanged."
}

# ──────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────
main() {
  local version
  version=$(ARTIBOT_CFG="${SCRIPT_DIR}/artibot.config.json" node --input-type=commonjs -e \
    "console.log(JSON.parse(require('fs').readFileSync(process.env.ARTIBOT_CFG,'utf8')).version)" 2>/dev/null || echo "unknown")
  echo -e "${BLUE}━━━ Artibot Installer v${version} ━━━${NC}"
  echo ""

  case "${1:-install}" in
    install)
      check_prerequisites
      setup_directories
      if is_self_install; then
        warn "Running from the installed location (${ARTIBOT_DIR}) — files already in place."
        warn "Skipping copy phase (no-op); continuing with config & seed steps."
        # INV-6 marker: record that THIS install skipped the file-copy phase, so
        # update.js can detect a self-install no-op when a real update was due
        # and refuse to falsely report "Update complete". Best-effort write.
        : > "${ARTIBOT_DIR}/.last-install-noop" 2>/dev/null || true
      else
        acquire_install_lock
        install_agents
        install_commands
        install_skills
        install_hooks
        install_marketplace_mirror
        install_plugin_cache
        install_rules
        # INV-6 marker cleanup: a real copy happened, so clear any stale no-op
        # marker from a previous self-install run — otherwise the next post-install
        # check would false-fail on a marker that no longer reflects reality.
        rm -f "${ARTIBOT_DIR}/.last-install-noop" 2>/dev/null || true
      fi
      install_mcp
      configure_settings
      seed_project_claude_md
      seed_local_config
      seed_auto_memory
      setup_swarm_consent
      setup_auto_learning
      save_source_path
      # Explicit rather than leaning on `set -e`: a partial install must reach
      # the shell (and any `npm run sync:local` wrapping it) as a non-zero exit.
      verify_install || exit 1
      ;;
    # File-placement phase only. For tests/CI, so a smoke test can assert what
    # the installer actually puts on disk without touching machine-scoped state.
    #
    # This is an ALLOWLIST, not a denylist. check_prerequisites (wants the
    # claude CLI), the marketplace/cache mirrors, install_mcp,
    # configure_settings, the three seed_* steps, setup_swarm_consent,
    # setup_auto_learning (registers crontab/schtasks — machine scope) and
    # save_source_path are excluded BY NOT BEING LISTED. A step added to
    # `install)` later does not leak in here on its own; someone has to decide
    # it belongs. A denylist would have failed open on exactly that.
    files)
      setup_directories
      install_agents
      install_commands
      install_skills
      install_hooks
      install_rules
      verify_install || exit 1
      ;;
    uninstall)
      uninstall
      ;;
    *)
      echo "Usage: ./install.sh [install|uninstall|files]"
      echo "  files: copy phase only (agents/commands/skills/hooks/rules) — test & CI use"
      exit 1
      ;;
  esac
}

main "$@"
