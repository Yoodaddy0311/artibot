#!/usr/bin/env node
/**
 * learning-diag.js — Diagnose the Artibot learning system state.
 *
 * Reads (never mutates) the on-disk learning artifacts under
 * ~/.claude/artibot/ and renders a markdown dashboard:
 *
 *   - GRPO self-learning rounds + learned weights + recent strategy mix
 *   - Swarm federated-learning sync state + merged peer weights
 *   - Top performers and risk signals (low success × high confidence)
 *   - Pattern file health (tool/agent/error/success/team/self-evaluation)
 *   - Recommendations derived from the data
 *
 * Pure observation — no writes, no network. Zero external dependencies.
 *
 * Usage:
 *   node scripts/learning-diag.js                # full dashboard
 *   node scripts/learning-diag.js --top 5        # top-5 instead of top-10
 *   node scripts/learning-diag.js --bottom 5     # bottom-5 risk signals
 *   node scripts/learning-diag.js --rounds 100   # recent-100 round window
 *   node scripts/learning-diag.js --swarm        # swarm section only
 *   node scripts/learning-diag.js --patterns     # pattern-health section only
 *   node scripts/learning-diag.js --raw          # dump raw JSON state instead
 *   node scripts/learning-diag.js --base <dir>   # override artibot install dir
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    top: 10,
    bottom: 10,
    rounds: 50,
    raw: false,
    section: 'all',
    base: path.join(homedir(), '.claude', 'artibot'),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--top') args.top = clampInt(argv[++i], 1, 100, 10);
    else if (a === '--bottom') args.bottom = clampInt(argv[++i], 1, 100, 10);
    else if (a === '--rounds') args.rounds = clampInt(argv[++i], 1, 1000, 50);
    else if (a === '--raw') args.raw = true;
    else if (a === '--swarm') args.section = 'swarm';
    else if (a === '--patterns') args.section = 'patterns';
    else if (a === '--base') args.base = argv[++i] ?? args.base;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function clampInt(raw, lo, hi, fallback) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

// ---------------------------------------------------------------------------
// State loading (all guarded — missing files do not crash)
// ---------------------------------------------------------------------------

function readJsonSafe(file) {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

function loadState(base) {
  const patternsDir = path.join(base, 'patterns');
  const memoryDir = path.join(base, 'memory');
  const patternFiles = ['tool', 'agent', 'error', 'success', 'team', 'self-evaluation'];

  const patterns = {};
  for (const t of patternFiles) {
    const primary = path.join(patternsDir, `${t}-patterns.json`);
    let data = readJsonSafe(primary);
    if (!data && t === 'error') {
      data = readJsonSafe(path.join(memoryDir, 'error-patterns.json'));
    }
    patterns[t] = data;
  }

  return {
    base,
    grpo: readJsonSafe(path.join(base, 'grpo-history.json')),
    swarmSync: readJsonSafe(path.join(base, 'swarm-sync-state.json')),
    swarmWeights: readJsonSafe(path.join(base, 'swarm-merged-weights.json')),
    learningLog: readJsonSafe(path.join(base, 'learning-log.json')),
    daily: readJsonSafe(path.join(base, 'daily-experiences.json')),
    patterns,
    storageMtime: existsSync(base) ? statSync(base).mtime : null,
  };
}

// ---------------------------------------------------------------------------
// Helpers — formatting
// ---------------------------------------------------------------------------

function fmtAge(iso) {
  if (!iso) return 'n/a';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return 'n/a';
  const ms = Date.now() - t;
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function fmtPct(x) {
  if (typeof x !== 'number' || !Number.isFinite(x)) return '—';
  return `${Math.round(x * 100)}%`;
}

function fmtNum(x, digits = 2) {
  if (typeof x !== 'number' || !Number.isFinite(x)) return '—';
  return x.toFixed(digits);
}

// ---------------------------------------------------------------------------
// Section: GRPO
// ---------------------------------------------------------------------------

function renderGrpo(state, args) {
  const grpo = state.grpo;
  if (!grpo || typeof grpo !== 'object') {
    return '## GRPO Self-Learning\n\n_no `grpo-history.json` found_\n';
  }

  const rounds = Array.isArray(grpo.rounds) ? grpo.rounds : [];
  const weights = grpo.weights && typeof grpo.weights === 'object' ? grpo.weights : {};
  const teamWeights = grpo.teamWeights && typeof grpo.teamWeights === 'object' ? grpo.teamWeights : {};

  const out = ['## GRPO Self-Learning', ''];
  out.push(`- Total rounds: **${rounds.length}**`);
  if (rounds.length > 0) {
    out.push(`- First: ${rounds[0]?.timestamp ?? 'n/a'}`);
    out.push(`- Last:  ${rounds.at(-1)?.timestamp ?? 'n/a'} (${fmtAge(rounds.at(-1)?.timestamp)})`);
  }
  out.push(`- Strategy weights tracked: ${Object.keys(weights).length}`);
  out.push(`- Team weights tracked: ${Object.keys(teamWeights).length}${Object.keys(teamWeights).length === 0 ? ' (dormant — `updateTeamWeights` exported but no runtime caller)' : ''}`);
  out.push('');

  if (Object.keys(weights).length > 0) {
    const sorted = Object.entries(weights).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0));
    out.push('### Top learned strategy weights');
    out.push('');
    out.push('| Rank | Strategy | Weight |');
    out.push('|--:|---|--:|');
    const topN = sorted.slice(0, Math.min(args.top, sorted.length));
    topN.forEach(([k, v], i) => {
      out.push(`| ${i + 1} | ${k} | ${fmtNum(v, 3)} |`);
    });
    out.push('');
  }

  if (rounds.length > 0) {
    const window = rounds.slice(-args.rounds);
    const strat = {};
    let bestScoreSum = 0;
    let spreadSum = 0;
    for (const r of window) {
      strat[r.bestStrategy] = (strat[r.bestStrategy] ?? 0) + 1;
      bestScoreSum += Number(r.bestScore ?? 0);
      spreadSum += Number(r.spread ?? 0);
    }
    out.push(`### Recent strategy distribution (last ${window.length} rounds)`);
    out.push('');
    out.push('| Strategy | Rounds | Share |');
    out.push('|---|--:|--:|');
    Object.entries(strat).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => {
      out.push(`| ${k} | ${v} | ${fmtPct(v / window.length)} |`);
    });
    out.push('');
    out.push(`- Mean best-score: **${fmtNum(bestScoreSum / window.length, 3)}**`);
    out.push(`- Mean spread: **${fmtNum(spreadSum / window.length, 3)}**`);
    out.push('');
  }

  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Section: Swarm
// ---------------------------------------------------------------------------

function renderSwarm(state) {
  const sync = state.swarmSync;
  const merged = state.swarmWeights;

  const out = ['## Swarm (Federated Learning)', ''];
  if (!sync && !merged) {
    out.push('_no swarm state on disk — sync may not have run yet_');
    out.push('');
    return out.join('\n');
  }

  if (sync) {
    out.push(`- Uploads: **${sync.totalUploads ?? 0}**, Downloads: **${sync.totalDownloads ?? 0}**`);
    out.push(`- Pending uploads: ${sync.pendingUploads ?? 0}`);
    out.push(`- Last upload: ${sync.lastUpload ?? 'never'} (${fmtAge(sync.lastUpload)})`);
    out.push(`- Last download: ${sync.lastDownload ?? 'never'} (${fmtAge(sync.lastDownload)})`);
    out.push(`- Interval: ${sync.interval ?? '?'}`);
    out.push('');
  }

  if (merged?.weights) {
    out.push(`- Merged at: ${merged.mergedAt ?? 'n/a'} (${fmtAge(merged.mergedAt)})`);
    out.push(`- Global version: ${merged.globalVersion ?? '?'}`);
    out.push('');
    out.push('| Bucket | Entries |');
    out.push('|---|--:|');
    for (const cat of ['tools', 'agents', 'errors', 'commands', 'teams']) {
      const n = Object.keys(merged.weights[cat] ?? {}).length;
      const note = (cat === 'agents' && n === 0) ? ' _(empty — pre-v4.6.2 peers route agents into tools)_' : '';
      out.push(`| ${cat} | ${n}${note} |`);
    }
    out.push('');
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Section: Top performers + risk signals (across swarm-merged tools+agents)
// ---------------------------------------------------------------------------

export function rankableEntries(state) {
  const merged = state.swarmWeights?.weights;
  if (!merged) return [];
  const rows = [];
  for (const [bucket, label] of [['tools', 'tool'], ['agents', 'agent']]) {
    const cat = merged[bucket] ?? {};
    for (const [name, w] of Object.entries(cat)) {
      // Distinguish an absent successRate measurement from a measured 0%.
      // Packaged weights only carry successRate when a real measurement exists
      // (pattern-packager v4.6.4 omits it otherwise); treating a missing field
      // as 0% fabricates "consistent failure" risk signals for entries that
      // were never actually scored on success — e.g. PowerShell, teammate,
      // and agent patterns whose bestData has no successRate field.
      const successMeasured = typeof w.successRate === 'number'
        && Number.isFinite(w.successRate);
      const conf = Number(w.confidence ?? 0);
      // When success is unmeasured, fall back to confidence as the signal
      // (the pattern's groupMean-derived confidence is the only quality proxy
      // we have) rather than fabricating 0.
      const success = successMeasured ? Number(w.successRate) : conf;
      const cert = typeof w.certainty === 'number' ? w.certainty : null;
      const n = Number(w.sampleSize ?? 0);
      // Combined score: prefer success × certainty when certainty present
      // (sample-size-aware), else fall back to success × confidence.
      const score = success * (cert ?? conf);
      rows.push({ type: label, name, success, successMeasured, conf, cert, n, score });
    }
  }
  return rows;
}

export function renderTopPerformers(rows, args) {
  if (rows.length === 0) return '';
  const sorted = [...rows].sort((a, b) => b.score - a.score);
  const top = sorted.slice(0, Math.min(args.top, sorted.length));

  const out = ['## Top Performers (success × certainty/confidence)', ''];
  out.push('| # | Type | Name | success | conf | cert | n | score |');
  out.push('|--:|---|---|--:|--:|--:|--:|--:|');
  top.forEach((r, i) => {
    const certCell = typeof r.cert === 'number' ? fmtNum(r.cert, 2) : '—';
    out.push(`| ${i + 1} | ${r.type} | ${r.name} | ${fmtPct(r.success)} | ${fmtNum(r.conf, 2)} | ${certCell} | ${r.n} | ${fmtNum(r.score, 3)} |`);
  });
  out.push('');
  return out.join('\n');
}

export function renderRiskSignals(rows, args) {
  if (rows.length === 0) return '';
  // Risk = consistent failure: high confidence + low MEASURED success + non-trivial
  // sample. Entries whose successRate was never measured (successMeasured === false)
  // are excluded: a missing measurement is not evidence of failure, and including
  // them surfaced false "0% critical" signals for tools/agents (PowerShell,
  // teammate, …) that simply lack a successRate field in the packaged weights.
  const risk = rows
    .filter((r) => r.successMeasured && r.conf >= 0.5 && r.success < 0.35 && r.n >= 6)
    .sort((a, b) => a.success - b.success);
  if (risk.length === 0) {
    return '## Risk Signals\n\n_none detected (no entries with measured success < 35%, conf ≥ 0.5, n ≥ 6)_\n';
  }
  const out = ['## Risk Signals (high confidence + low success — consistent failures)', ''];
  out.push('| Type | Name | success | conf | n | note |');
  out.push('|---|---|--:|--:|--:|---|');
  for (const r of risk.slice(0, Math.min(args.bottom, risk.length))) {
    const note = r.success < 0.25 ? 'critical' : 'monitor';
    out.push(`| ${r.type} | ${r.name} | ${fmtPct(r.success)} | ${fmtNum(r.conf, 2)} | ${r.n} | ${note} |`);
  }
  out.push('');
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Section: Pattern health
// ---------------------------------------------------------------------------

function renderPatterns(state) {
  const out = ['## Pattern File Health', ''];
  out.push('| Type | Count | Latest extractedAt |');
  out.push('|---|--:|---|');
  for (const [type, data] of Object.entries(state.patterns)) {
    if (!data) {
      out.push(`| ${type} | _missing_ | — |`);
      continue;
    }
    const arr = Array.isArray(data.patterns) ? data.patterns
      : Array.isArray(data.entries) ? data.entries
        : [];
    let latest = null;
    for (const p of arr) {
      const t = p?.extractedAt ?? p?.createdAt ?? null;
      if (t && (!latest || t > latest)) latest = t;
    }
    out.push(`| ${type} | ${arr.length} | ${latest ?? '—'} |`);
  }
  out.push('');
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Section: Recommendations
// ---------------------------------------------------------------------------

function renderRecommendations(state, rows) {
  const out = ['## Recommendations', ''];
  const bullets = [];

  const merged = state.swarmWeights?.weights;
  if (merged) {
    const emptyBuckets = ['agents', 'errors', 'commands', 'teams', 'quality']
      .filter((c) => Object.keys(merged[c] ?? {}).length === 0);
    if (emptyBuckets.includes('agents')) {
      bullets.push('Swarm `agents` bucket is empty — either no peer has uploaded post-v4.6.2 yet, or local agent patterns lack the upload threshold (sample ≥ 3, confidence ≥ 0.4).');
    }
    if (emptyBuckets.includes('quality')) {
      bullets.push('Swarm `quality` bucket is empty — claude-md-auditor skill has not run (or audit-cache.json is missing). Run `/audit-claude-md` to populate.');
    }
    const otherEmpty = emptyBuckets.filter((c) => c !== 'agents' && c !== 'quality');
    if (otherEmpty.length > 0) {
      bullets.push(`Empty swarm buckets: ${otherEmpty.join(', ')} — check if local pattern files exist and pass the upload filter.`);
    }
  }

  const critical = rows.filter((r) => r.successMeasured && r.conf >= 0.8 && r.success < 0.25 && r.n >= 10);
  if (critical.length > 0) {
    bullets.push(`${critical.length} entries with success < 25% and conf ≥ 0.8 (n ≥ 10) — investigate: ${critical.slice(0, 3).map((r) => r.name).join(', ')}${critical.length > 3 ? '…' : ''}`);
  }

  // The GRPO reward/policy subsystem was retired in the 2026-06 lean redesign
  // (no production reward emitter — it was a dormant no-op). grpo-history.json is
  // no longer written, so any rounds/teamWeights signals here would be stale.

  const lastSyncAge = state.swarmSync?.lastUpload
    ? Date.now() - new Date(state.swarmSync.lastUpload).getTime()
    : Infinity;
  if (lastSyncAge > 7 * 24 * 60 * 60 * 1000) {
    bullets.push('Swarm last sync was over 7 days ago — federated learning is stale.');
  }

  if (bullets.length === 0) {
    out.push('_no actionable signals — learning system looks healthy_');
  } else {
    bullets.forEach((b, i) => out.push(`${i + 1}. ${b}`));
  }
  out.push('');
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function renderHeader(state) {
  const lines = [
    '# Artibot Learning System State',
    '',
    `- Base: \`${state.base}\``,
    `- Snapshot: ${new Date().toISOString()}`,
    '',
  ];
  return lines.join('\n');
}

function renderHelp() {
  return `Usage: node scripts/learning-diag.js [flags]

  --top N         show top N performers (default 10)
  --bottom N      show bottom N risk signals (default 10)
  --rounds N      window size for recent GRPO strategy mix (default 50)
  --swarm         render swarm section only
  --patterns      render pattern-health section only
  --raw           dump raw JSON state instead of dashboard
  --base <dir>    override artibot install dir (default ~/.claude/artibot)
  --help, -h      this message
`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(renderHelp());
    return;
  }
  const state = loadState(args.base);

  if (args.raw) {
    // Strip huge `rounds` to keep output sane unless explicitly wanted.
    const out = {
      base: state.base,
      grpo: state.grpo
        ? { ...state.grpo, rounds: `[${state.grpo.rounds?.length ?? 0} entries omitted]` }
        : null,
      swarmSync: state.swarmSync,
      swarmWeights: state.swarmWeights,
      patternCounts: Object.fromEntries(
        Object.entries(state.patterns).map(([k, v]) => [
          k,
          v ? (v.patterns?.length ?? v.entries?.length ?? 0) : null,
        ]),
      ),
    };
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return;
  }

  const sections = [];
  sections.push(renderHeader(state));

  if (args.section === 'all' || args.section === 'swarm') {
    if (args.section === 'all') sections.push(renderGrpo(state, args));
    sections.push(renderSwarm(state));
  }

  const rows = rankableEntries(state);
  if (args.section === 'all') {
    sections.push(renderTopPerformers(rows, args));
    sections.push(renderRiskSignals(rows, args));
  }

  if (args.section === 'all' || args.section === 'patterns') {
    sections.push(renderPatterns(state));
  }

  if (args.section === 'all') {
    sections.push(renderRecommendations(state, rows));
  }

  process.stdout.write(sections.filter(Boolean).join('\n'));
}

// Run as CLI only when invoked directly (`node scripts/learning-diag.js`),
// not when imported by tests. Keeps CLI behavior identical while allowing
// the pure ranking/render helpers above to be unit-tested in-memory.
const thisFile = fileURLToPath(import.meta.url);
const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedFile && path.resolve(thisFile) === invokedFile) {
  main();
}
