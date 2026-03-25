#!/bin/bash
# Artibot 2-line status bar for Claude Code
#
# Line 1: [model] 📁 dir 🌿 branch ✎dirty | 🤖 agent
# Line 2: ctx% bar | 💰 cost ⏱ time | artibot vX.Y.Z ✓eval | ⚡ cog-mode
#
# Input:  JSON via stdin (model, context_window, cost, agent, worktree)
# Output: 2 lines to stdout
# Cache:  /tmp/artibot-statusline-cache (5s TTL for git calls)

set -euo pipefail

# ─── ANSI colors ────────────────────────────────────────────────────────────
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

# ─── Read stdin JSON ─────────────────────────────────────────────────────────
input=$(cat)

# ─── JSON helpers (jq preferred, node fallback, silent fail) ─────────────────
_json_file_get() {
  # Usage: _json_file_get <file> <dot-path> <default>
  # dot-path examples: .version  .passed  .failed
  local file="$1" path="$2" default="${3:-}"
  if command -v jq >/dev/null 2>&1; then
    jq -r "$path // \"$default\"" "$file" 2>/dev/null || echo "$default"
  elif command -v node >/dev/null 2>&1; then
    # Pass content via env var to avoid Windows path issues with bash /c/... paths
    ARTIBOT_SL_FILE_CONTENT=$(cat "$file" 2>/dev/null || true) node -e "
      try {
        const o = JSON.parse(process.env.ARTIBOT_SL_FILE_CONTENT || '{}');
        const keys = '$path'.replace(/^\./,'').split('.');
        let v = o;
        for (const k of keys) v = v && v[k];
        if (v == null) { process.stdout.write('$default'); }
        else if (typeof v === 'object') { process.stdout.write('$default'); }
        else { process.stdout.write(String(v)); }
      } catch { process.stdout.write('$default'); }
    " 2>/dev/null || echo "$default"
  else
    echo "$default"
  fi
}

jq_get() {
  local key="$1" default="${2:-}"
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$input" | jq -r "$key // \"$default\"" 2>/dev/null || echo "$default"
  elif command -v node >/dev/null 2>&1; then
    # Pass JSON as env var to avoid stdin/platform issues
    ARTIBOT_SL_JSON="$input" node -e "
      try {
        const o = JSON.parse(process.env.ARTIBOT_SL_JSON || '{}');
        const keys = '$key'.replace(/^\./,'').split('.');
        let v = o;
        for (const k of keys) v = v && v[k];
        if (v == null) { process.stdout.write('$default'); }
        else if (typeof v === 'object') { process.stdout.write('$default'); }
        else { process.stdout.write(String(v)); }
      } catch { process.stdout.write('$default'); }
    " 2>/dev/null || echo "$default"
  else
    echo "$default"
  fi
}

# ─── Parse stdin fields ───────────────────────────────────────────────────────
MODEL=$(jq_get '.model' '')
CTX_USED=$(jq_get '.context_window.current_tokens' '0')
CTX_MAX=$(jq_get '.context_window.max_tokens' '0')
COST=$(jq_get '.cost.total_cost' '')
ELAPSED=$(jq_get '.cost.elapsed_seconds' '')
AGENT=$(jq_get '.agent' '')
WORKTREE=$(jq_get '.worktree' '')

# ─── Resolve plugin root (script lives at <plugin>/scripts/hooks/) ────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# ─── Artibot version ─────────────────────────────────────────────────────────
ARTIBOT_VERSION=''
PKG_JSON="$PLUGIN_ROOT/package.json"
if [ -f "$PKG_JSON" ]; then
  ARTIBOT_VERSION=$(_json_file_get "$PKG_JSON" '.version' '')
fi

# ─── Runtime eval status ─────────────────────────────────────────────────────
EVAL_STATUS=''
EVAL_FILE="$PLUGIN_ROOT/_reports/runtime-task-suite.json"
if [ -f "$EVAL_FILE" ]; then
  EVAL_PASSED=$(_json_file_get "$EVAL_FILE" '.passed' '')
  EVAL_TOTAL=$(_json_file_get "$EVAL_FILE" '.total' '')
  EVAL_FAILED=$(_json_file_get "$EVAL_FILE" '.failed' '0')
  if [ -n "$EVAL_PASSED" ] && [ -n "$EVAL_TOTAL" ]; then
    if [ "${EVAL_FAILED:-0}" -eq 0 ]; then
      EVAL_STATUS="${GREEN}✓${EVAL_PASSED}/${EVAL_TOTAL}${RESET}"
    else
      EVAL_STATUS="${RED}✗${EVAL_PASSED}/${EVAL_TOTAL}${RESET}"
    fi
  fi
fi

# ─── Git info with 5s cache ───────────────────────────────────────────────────
CACHE_FILE="/tmp/artibot-statusline-cache"
CACHE_TTL=5
GIT_BRANCH=''
GIT_DIRTY=''

if command -v git >/dev/null 2>&1; then
  NOW=$(date +%s)
  CACHE_VALID=0

  if [ -f "$CACHE_FILE" ]; then
    CACHE_TIME=$(awk 'NR==1{print $1}' "$CACHE_FILE" 2>/dev/null || echo 0)
    if [ $(( NOW - CACHE_TIME )) -lt $CACHE_TTL ]; then
      CACHE_VALID=1
    fi
  fi

  if [ "$CACHE_VALID" -eq 1 ]; then
    GIT_BRANCH=$(awk 'NR==2{print}' "$CACHE_FILE" 2>/dev/null || true)
    GIT_DIRTY=$(awk 'NR==3{print}' "$CACHE_FILE" 2>/dev/null || true)
  else
    GIT_BRANCH=$(git branch --show-current 2>/dev/null || true)
    GIT_DIRTY=$(git status --short 2>/dev/null | wc -l | tr -d ' ' || echo '0')
    printf '%s\n%s\n%s\n' "$NOW" "$GIT_BRANCH" "$GIT_DIRTY" > "$CACHE_FILE" 2>/dev/null || true
  fi
fi

# ─── Context bar ─────────────────────────────────────────────────────────────
build_ctx_bar() {
  local used="$1" max="$2"
  if [ -z "$used" ] || [ -z "$max" ] || [ "$max" -eq 0 ] 2>/dev/null; then
    echo ''
    return
  fi

  local pct=$(( used * 100 / max ))
  local bar_width=20
  local filled=$(( pct * bar_width / 100 ))
  local empty=$(( bar_width - filled ))

  local bar=''
  local i=0
  while [ $i -lt $filled ]; do bar="${bar}█"; i=$(( i + 1 )); done
  while [ $i -lt $bar_width ]; do bar="${bar}░"; i=$(( i + 1 )); done

  local color="$GREEN"
  if [ "$pct" -ge 90 ]; then
    color="$RED"
  elif [ "$pct" -ge 70 ]; then
    color="$YELLOW"
  fi

  printf "${color}${bar} %3d%%${RESET}" "$pct"
}

# ─── Format model label ───────────────────────────────────────────────────────
format_model() {
  local m="$1"
  case "$m" in
    *opus*)   echo "opus"   ;;
    *sonnet*) echo "sonnet" ;;
    *haiku*)  echo "haiku"  ;;
    '')       echo ''       ;;
    *)        echo "$m"     ;;
  esac
}

# ─── Format cost ─────────────────────────────────────────────────────────────
format_cost() {
  local c="$1"
  [ -z "$c" ] && echo '' && return
  if command -v awk >/dev/null 2>&1; then
    echo "$c" | awk '{printf "$%.4f", $1}' 2>/dev/null || echo "\$$c"
  else
    echo "\$$c"
  fi
}

# ─── Format elapsed ──────────────────────────────────────────────────────────
format_elapsed() {
  local s="$1"
  [ -z "$s" ] && echo '' && return
  if command -v awk >/dev/null 2>&1; then
    echo "$s" | awk '{
      if ($1 >= 60) printf "%dm%ds", int($1/60), int($1)%60
      else printf "%ds", int($1)
    }' 2>/dev/null || echo "${s}s"
  else
    echo "${s}s"
  fi
}

# ─── Determine working directory label ───────────────────────────────────────
if [ -n "$WORKTREE" ]; then
  DIR_LABEL=$(basename "$WORKTREE")
else
  DIR_LABEL=$(basename "$PWD")
fi

# ─── Cognitive mode (System1 vs System2 via env or default) ──────────────────
COG_MODE="${ARTIBOT_COG_MODE:-sys1}"

# ─── Assemble Line 1 ─────────────────────────────────────────────────────────
MODEL_LABEL=$(format_model "$MODEL")

LINE1="${BOLD}"
[ -n "$MODEL_LABEL" ] && LINE1="${LINE1}[${MODEL_LABEL}] "
LINE1="${LINE1}${RESET}📁 ${DIR_LABEL}"
[ -n "$GIT_BRANCH" ] && LINE1="${LINE1}  🌿 ${CYAN}${GIT_BRANCH}${RESET}"
if [ -n "$GIT_DIRTY" ] && [ "$GIT_DIRTY" -gt 0 ] 2>/dev/null; then
  if [ "$GIT_DIRTY" -gt 50 ]; then
    LINE1="${LINE1} ${YELLOW}✎${GIT_DIRTY}${RESET}"
  else
    LINE1="${LINE1} ✎${GIT_DIRTY}"
  fi
fi
[ -n "$AGENT" ] && LINE1="${LINE1}  | 🤖 ${BOLD}${AGENT}${RESET}"

# ─── Assemble Line 2 ─────────────────────────────────────────────────────────
CTX_BAR=$(build_ctx_bar "$CTX_USED" "$CTX_MAX")
COST_FMT=$(format_cost "$COST")
ELAPSED_FMT=$(format_elapsed "$ELAPSED")

LINE2=''

# Context segment
if [ -n "$CTX_BAR" ]; then
  LINE2="${LINE2}${CTX_BAR}"
fi

# Cost / time segment
COST_TIME=''
[ -n "$COST_FMT"    ] && COST_TIME="${COST_TIME}💰 ${COST_FMT}"
[ -n "$ELAPSED_FMT" ] && COST_TIME="${COST_TIME} ⏱ ${ELAPSED_FMT}"
[ -n "$COST_TIME"   ] && LINE2="${LINE2}  | ${COST_TIME}"

# Artibot version + eval segment
AB_SEGMENT=''
[ -n "$ARTIBOT_VERSION" ] && AB_SEGMENT="artibot v${ARTIBOT_VERSION}"
[ -n "$EVAL_STATUS"     ] && AB_SEGMENT="${AB_SEGMENT} ${EVAL_STATUS}"
[ -n "$AB_SEGMENT"      ] && LINE2="${LINE2}  | ${AB_SEGMENT}"

# Cognitive mode segment
LINE2="${LINE2}  | ⚡ ${COG_MODE}"

# ─── Output ──────────────────────────────────────────────────────────────────
printf '%b\n' "$LINE1"
printf '%b\n' "$LINE2"
