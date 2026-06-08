#!/bin/bash
# Artibot themeable statusline. Renders a truecolor gradient bar + neon glyphs
# from the active theme palette written by theme-apply.js to
# ~/.claude/artibot/runtime/current-theme.json. Falls back to a cyan→magenta
# default when no theme file is present.
set -euo pipefail

input=$(cat)
R='\033[0m'; BOLD='\033[1m'
THEME_FILE="$HOME/.claude/artibot/runtime/current-theme.json"

# ── stdin fields (official statusLine schema) ────────────────────────────────
jget() {
  local key="$1" def="${2:-}"
  if command -v node >/dev/null 2>&1; then
    ARTIBOT_SL_JSON="$input" node -e "
      try { const o=JSON.parse(process.env.ARTIBOT_SL_JSON||'{}');
        let v=o; for (const k of '$key'.replace(/^\./,'').split('.')) v=v&&v[k];
        process.stdout.write(v==null||typeof v==='object'?'$def':String(v)); }
      catch { process.stdout.write('$def'); }" 2>/dev/null || echo "$def"
  else echo "$def"; fi
}
MODEL=$(jget '.model.display_name' ''); [ -z "$MODEL" ] && MODEL=$(jget '.model.id' 'claude')
PCT=$(jget '.context_window.used_percentage' '0'); PCT=${PCT%%.*}; [ -z "$PCT" ] && PCT=0
COST=$(jget '.cost.total_cost_usd' '')
DIR=$(basename "$PWD"); BRANCH=$(git branch --show-current 2>/dev/null || true)
VER=''; PKG="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/package.json"
[ -f "$PKG" ] && command -v node >/dev/null 2>&1 && VER=$(node -e "try{process.stdout.write(require('$PKG').version)}catch{}" 2>/dev/null || true)

# ── Theme palette (node emits shell-eval vars; defaults = neon-city) ──────────
PR=0; PG=245; PB=255; AR=255; AG=0; AB=110; DR=70; DG=40; DB=90; XR=255; XG=23; XB=68
GL_FILL='▰'; GL_EMPTY='▱'; GL_SEP='◢◤'; GL_WL='⟨'; GL_WR='⟩'; GL_BL='⟦'; GL_BR='⟧'; GL_ML='▓▒░'; GL_MR='░▒▓'; GL_SPARK='⚡'; LABEL=''
if [ -f "$THEME_FILE" ] && command -v node >/dev/null 2>&1; then
  eval "$(node -e "
    try { const t=require('$THEME_FILE'); const s=t.signals||{}, g=t.glyphs||{};
      const a=(x,d)=>Array.isArray(x)?x:d;
      const [pr,pg,pb]=a(s.primary,[0,245,255]); const [ar,ag,ab]=a(s.accent,[255,0,110]);
      const [dr,dg,db]=a(s.dim,[70,40,90]); const [xr,xg,xb]=a(s.danger,[255,23,68]);
      const q=v=>String(v).replace(/'/g,'');
      process.stdout.write([
        'PR='+pr,'PG='+pg,'PB='+pb,'AR='+ar,'AG='+ag,'AB='+ab,
        'DR='+dr,'DG='+dg,'DB='+db,'XR='+xr,'XG='+xg,'XB='+xb,
        \"GL_FILL='\"+q(g.fill||'▰')+\"'\",\"GL_EMPTY='\"+q(g.empty||'▱')+\"'\",
        \"GL_SEP='\"+q(g.sep||'◢◤')+\"'\",\"GL_WL='\"+q(g.wrapL||'⟨')+\"'\",\"GL_WR='\"+q(g.wrapR||'⟩')+\"'\",
        \"GL_BL='\"+q(g.brL||'⟦')+\"'\",\"GL_BR='\"+q(g.brR||'⟧')+\"'\",
        \"GL_ML='\"+q(g.modL||'▓▒░')+\"'\",\"GL_MR='\"+q(g.modR||'░▒▓')+\"'\",
        \"GL_SPARK='\"+q(g.spark||'⚡')+\"'\",\"LABEL='\"+q(t.label||'')+\"'\"
      ].join('\n'));
    } catch {}" 2>/dev/null || true)"
fi

neon() { printf '\033[38;2;%d;%d;%dm' "$1" "$2" "$3"; }
C_PRIM="$(neon $PR $PG $PB)"; C_ACC="$(neon $AR $AG $AB)"; C_DIM="$(neon $DR $DG $DB)"; C_DANGER="$(neon $XR $XG $XB)"

# ── primary→accent gradient bar ──────────────────────────────────────────────
bar() {
  local pct="$1" w=18 i fill t r g b out=''
  fill=$(( pct * w / 100 )); [ "$fill" -gt "$w" ] && fill=$w; [ "$fill" -lt 0 ] && fill=0
  for ((i=0;i<w;i++)); do
    if [ "$i" -lt "$fill" ]; then
      t=$(( w>1 ? i*100/(w-1) : 0 ))
      r=$(( PR + (AR-PR)*t/100 )); g=$(( PG + (AG-PG)*t/100 )); b=$(( PB + (AB-PB)*t/100 ))
      out="${out}$(neon $r $g $b)${GL_FILL}"
    else out="${out}${C_DIM}${GL_EMPTY}"; fi
  done
  printf '%b' "$out${R}"
}

if [ "$PCT" -ge 90 ] 2>/dev/null; then
  BARSEG="${C_DANGER}${BOLD}${GL_FILL}${GL_FILL}${GL_FILL}${GL_FILL}${GL_FILL}${GL_FILL}${GL_FILL}${GL_FILL}${GL_FILL}${GL_EMPTY} ${PCT}% 🚨${R}"
else
  BARSEG="$(bar "$PCT") ${C_PRIM}${PCT}%${R}"
fi

L1="${BOLD}${C_ACC}${GL_ML} ${MODEL} ${GL_MR}${R}  ${C_PRIM}${GL_WL} ${DIR} ${GL_WR}${R}"
[ -n "$BRANCH" ] && L1="${L1}  ${C_ACC}${GL_BL} ${BRANCH} ${GL_BR}${R}"
L2="${C_DIM}${GL_SEP}${R} ${C_PRIM}CTX${R} ${BARSEG}  ${C_DIM}${GL_SEP}${R}"
[ -n "$COST" ] && L2="${L2}  ${C_ACC}${GL_SPARK} \$${COST}${R}"
[ -n "$VER" ] && L2="${L2}  ${C_DIM}${GL_WL}v${VER}${GL_WR}${R}"
[ -n "$LABEL" ] && L2="${L2}  ${C_DIM}${LABEL}${R}"

printf '%b\n' "$L1"
printf '%b\n' "$L2"
