#!/bin/bash
# Artibot themeable statusline. Renders a truecolor gradient bar + neon glyphs
# from the active theme palette written by theme-apply.js to
# ~/.claude/artibot/runtime/current-theme.json. Falls back to a cyan→magenta
# default when no theme file is present.
set -euo pipefail

input=$(cat)
R='\033[0m'; BOLD='\033[1m'
THEME_FILE="$HOME/.claude/artibot/runtime/current-theme.json"

# ── stdin fields (official statusLine schema) — one node call emits all vars ──
# Parses the stdin JSON payload once and emits shell-eval assignments (same
# pattern as the theme eval below). Every value is sanitized with q() to strip
# single quotes so the eval can't be injection-exploited. Missing fields → ''.
MODEL=''; PCT=0; COST=''; EFFORT=''; THINKING_ON=''; FAST_ON=''
RL5=''; RL5_RESET=''; RL7=''; HAS_RL=''
if command -v node >/dev/null 2>&1; then
  eval "$(ARTIBOT_SL_JSON="$input" node -e "
    try { const o=JSON.parse(process.env.ARTIBOT_SL_JSON||'{}');
      const q=v=>String(v==null?'':v).replace(/'/g,'');
      // Round to 1 decimal and drop a trailing .0 — the CLI sends raw floats
      // (e.g. 28.000000000000004, 22.165807150000013) unfit for display.
      const f1=v=>{const n=Number(v);if(!Number.isFinite(n))return '';
        const s=n.toFixed(1);return s.endsWith('.0')?s.slice(0,-2):s};
      const m=o.model||{}, cw=o.context_window||{}, cost=o.cost||{};
      const rl=o.rate_limits||{}, h5=rl.five_hour||{}, d7=rl.seven_day||{};
      const eff=o.effort||{}, th=o.thinking||{};
      let pct=cw.used_percentage; pct=(pct==null?'0':String(pct)).split('.')[0]||'0';
      const hasRl=(h5.used_percentage!=null||d7.used_percentage!=null)?'1':'';
      let r5reset='';
      if (h5.resets_at!=null){ const d=new Date(Number(h5.resets_at)*1000);
        if(!isNaN(d)) r5reset=String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0'); }
      process.stdout.write([
        \"MODEL='\"+q(m.display_name||m.id||'')+\"'\",
        \"PCT='\"+q(pct)+\"'\",
        \"COST='\"+q(cost.total_cost_usd!=null?f1(cost.total_cost_usd):'')+\"'\",
        \"EFFORT='\"+q(eff.level||'')+\"'\",
        \"THINKING_ON='\"+q(th.enabled===true?'1':'')+\"'\",
        \"FAST_ON='\"+q(o.fast_mode===true?'1':'')+\"'\",
        \"HAS_RL='\"+q(hasRl)+\"'\",
        \"RL5='\"+q(h5.used_percentage!=null?f1(h5.used_percentage):'')+\"'\",
        \"RL5_RESET='\"+q(r5reset)+\"'\",
        \"RL7='\"+q(d7.used_percentage!=null?f1(d7.used_percentage):'')+\"'\"
      ].join('\n')); }
    catch {}" 2>/dev/null || true)"
fi
[ -z "$MODEL" ] && MODEL='claude'
PCT=${PCT%%.*}; [ -z "$PCT" ] && PCT=0
DIR=$(basename "$PWD"); BRANCH=$(git branch --show-current 2>/dev/null || true)
# Plugin root is two levels up from scripts/hooks/. Prefer package.json, fall
# back to artibot.config.json so the version still renders if either is absent.
VER=''; PLUGROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VERSRC="${PLUGROOT}/package.json"; [ -f "$VERSRC" ] || VERSRC="${PLUGROOT}/artibot.config.json"
[ -f "$VERSRC" ] && command -v node >/dev/null 2>&1 && VER=$(ARTIBOT_PKG_JSON="$(cat "$VERSRC" 2>/dev/null)" node -e "try{process.stdout.write(JSON.parse(process.env.ARTIBOT_PKG_JSON||'{}').version||'')}catch{}" 2>/dev/null || true)

# ── Theme palette (node emits shell-eval vars; defaults = neon-city) ──────────
PR=0; PG=245; PB=255; AR=255; AG=0; AB=110; DR=70; DG=40; DB=90; XR=255; XG=23; XB=68
GL_FILL='▰'; GL_EMPTY='▱'; GL_SEP='◢◤'; GL_WL='⟨'; GL_WR='⟩'; GL_BL='⟦'; GL_BR='⟧'; GL_ML='▓▒░'; GL_MR='░▒▓'; GL_SPARK='⚡'; LABEL=''
if [ -f "$THEME_FILE" ] && command -v node >/dev/null 2>&1; then
  eval "$(ARTIBOT_THEME_JSON="$(cat "$THEME_FILE" 2>/dev/null)" node -e "
    try { const t=JSON.parse(process.env.ARTIBOT_THEME_JSON||'{}'); const s=t.signals||{}, g=t.glyphs||{};
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

# ── account badge (local-only; DATA POLICY: no network) ──────────────────────
# Cached label from ~/.claude.json oauthAccount, refreshed every 24h. Reads
# local files only — never a network call. All failures degrade to an empty
# badge; the statusline must never die on account-lookup errors.
BADGE=''
account_badge() {
  local cache="$HOME/.claude/artibot/runtime/account-badge.json"
  command -v node >/dev/null 2>&1 || return 0
  ARTIBOT_BADGE_CACHE="$cache" node -e "
    const fs=require('fs'); const cache=process.env.ARTIBOT_BADGE_CACHE;
    const q=v=>String(v==null?'':v).replace(/'/g,'');
    const fresh=()=>{ try { const c=JSON.parse(fs.readFileSync(cache,'utf8'));
      if (c && c.label!=null && (Date.now()-(c.ts||0))<864e5) return String(c.label); } catch {} return null; };
    let label=fresh();
    if (label==null) {
      try { const o=JSON.parse(fs.readFileSync(process.env.HOME+'/.claude.json','utf8'));
        const a=o.oauthAccount||{};
        const name=a.displayName||a.emailAddress||'';
        const tierRaw=String(a.organizationRateLimitTier||'');
        const mm=tierRaw.match(/max_(\d+)x/);
        let tier = mm ? ('Max '+mm[1]+'x') : (a.organizationType==='claude_max' ? 'Max' : '');
        label = name ? (tier ? (name+'·'+tier) : name) : '';
        try { fs.mkdirSync(require('path').dirname(cache),{recursive:true});
          fs.writeFileSync(cache, JSON.stringify({label, ts:Date.now()})); } catch {}
      } catch { label=''; }
    }
    if (label) process.stdout.write(\"BADGE='\"+q(label)+\"'\");
  " 2>/dev/null || true
}
eval "$(account_badge)" || true

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

# ── rate-limit gauge color: <70 primary, ≥70 accent, ≥90 danger+BOLD ─────────
# Low usage renders in primary, not dim: several theme palettes (e.g. RETRO
# TERMINAL dim = 77,51,0) make dim unreadable on dark backgrounds, which hid
# the gauge entirely below 70%.
rl_color() {
  local p="${1%%.*}"; [ -z "$p" ] && p=0
  if [ "$p" -ge 90 ] 2>/dev/null; then printf '%s' "${C_DANGER}${BOLD}"
  elif [ "$p" -ge 70 ] 2>/dev/null; then printf '%s' "${C_ACC}"
  else printf '%s' "${C_PRIM}"; fi
}

L1="${BOLD}${C_ACC}${GL_ML} ${MODEL} ${GL_MR}${R}  ${C_PRIM}${GL_WL} ${DIR} ${GL_WR}${R}"
[ -n "$BRANCH" ] && L1="${L1}  ${C_ACC}${GL_BL} ${BRANCH} ${GL_BR}${R}"
[ -n "$BADGE" ] && L1="${L1}  ${C_DIM}${GL_WL} ${BADGE} ${GL_WR}${R}"
L2="${C_DIM}${GL_SEP}${R} ${C_PRIM}CTX${R} ${BARSEG}  ${C_DIM}${GL_SEP}${R}"
[ -n "$COST" ] && L2="${L2}  ${C_ACC}${GL_SPARK} \$${COST}${R}"
# effort·thinking·fast badge (omitted entirely when effort absent)
if [ -n "$EFFORT" ]; then
  EFFSEG="${C_ACC}${GL_SPARK}${EFFORT}"
  [ -n "$THINKING_ON" ] && EFFSEG="${EFFSEG}·think"
  [ -n "$FAST_ON" ] && EFFSEG="${EFFSEG}·fast"
  L2="${L2}  ${EFFSEG}${R}"
fi
# rate-limit gauge (omitted entirely when the CLI doesn't send rate_limits)
if [ -n "$HAS_RL" ]; then
  RLSEG=''
  if [ -n "$RL5" ]; then
    RLSEG="$(rl_color "$RL5")5h ${RL5}%${R}"
    [ -n "$RL5_RESET" ] && RLSEG="${RLSEG} ${C_PRIM}~${RL5_RESET}${R}"
  fi
  if [ -n "$RL7" ]; then
    [ -n "$RLSEG" ] && RLSEG="${RLSEG} ${C_DIM}·${R} "
    RLSEG="${RLSEG}$(rl_color "$RL7")7d ${RL7}%${R}"
  fi
  [ -n "$RLSEG" ] && L2="${L2}  ${RLSEG}"
fi
# zero-result guard counter (parity with statusline.sh). Hidden entirely when the
# counter file is absent — "file missing" ≠ "fired 0 times". HOME-anchored because
# the writer (zero-result-guard.js#counterPath) builds from getHomeDir, which
# prefers USERPROFILE over HOME; the two normally agree, and when they don't the
# file is not found and the segment hides — the fail-safe direction.
# Validation mirrors statusline.sh#_zg_label exactly so both renderers give the
# same answer: only a finite, non-negative, safe-integer `fired` renders. No jq
# branch here on purpose — this file is node-only throughout, and a lone jq
# parser would be the odd one out; if node is missing the segment simply hides.
ZG=''
ZGFILE="$HOME/.claude/artibot/zero-result-guard-counter.json"
if [ -f "$ZGFILE" ] && command -v node >/dev/null 2>&1; then
  ZG=$(ARTIBOT_ZG_JSON="$(cat "$ZGFILE" 2>/dev/null)" node -e "try{const v=JSON.parse(process.env.ARTIBOT_ZG_JSON||'').fired;if(typeof v==='number'&&Number.isFinite(v)&&v>=0){const f=Math.floor(v);if(Number.isSafeInteger(f))process.stdout.write(String(f))}}catch{}" 2>/dev/null || true)
fi
[ -n "$ZG" ] && L2="${L2}  ${C_ACC}🛡 ${ZG}${R}"
[ -n "$VER" ] && L2="${L2}  ${C_DIM}${GL_WL}v${VER}${GL_WR}${R}"
[ -n "$LABEL" ] && L2="${L2}  ${C_DIM}${LABEL}${R}"

printf '%b\n' "$L1"
printf '%b\n' "$L2"
