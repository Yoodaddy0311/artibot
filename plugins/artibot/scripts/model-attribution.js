#!/usr/bin/env node
/**
 * Per-model attribution report over Claude Code transcripts.
 *
 * Answers "which model served which work, and how did it go" for history that
 * predates model attribution in the learning store. Transcripts are the only
 * record that carries the *effective* model id per turn, so this script reads
 * them directly instead of the learning store.
 *
 * WHAT THIS MEASURES — and what it does not:
 *   - Turn/session counts and effort mix per model are DIRECT counts.
 *   - `toolErrorRate` is a DIRECT count of tool_result blocks flagged
 *     `is_error`, attributed to the model whose tool_use produced them.
 *   - `retryRate` and `correctionRate` are PROXIES. A model that talks about
 *     its own mistakes more will score higher without making more of them, and
 *     a model used on harder tasks will score higher for that reason alone.
 *
 * Models ran in different periods on different projects. Any gap this prints
 * is CONFOUNDED and is a prompt to investigate, never a verdict.
 *
 * Usage:
 *   node scripts/model-attribution.js [--projects <dir>] [--since YYYY-MM-DD]
 *                                     [--project <substring>]
 *                                     [--scope all|main|subagent] [--json]
 */

import { createReadStream, readdirSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import os from 'node:os';
import { isMainEntry } from './hooks/_main-entry.js';

/**
 * Assistant phrases that mark a self-correction or reversal. Deliberately
 * narrow: broad matches ("but", "however") fire on ordinary prose. Even so,
 * treat the resulting rate as a proxy, not a defect count.
 */
const CORRECTION_RE = new RegExp([
  '정정', '제 실수', '잘못 (봤|읽었|짚었)', '다시 보니', '앞서.{0,6}틀렸',
  '수정하겠', '오해했', '착각했',
  'correction:', 'i was wrong', 'my mistake', 'on closer look',
  'actually, (that|it|the)', 'let me correct',
].join('|'), 'i');

/** @returns {string} Default Claude Code projects directory. */
function defaultProjectsDir() {
  return path.join(os.homedir(), '.claude', 'projects');
}

/**
 * Parse argv into an options object.
 *
 * An unparseable `--since` is a hard error, not a warning: `Date.parse` returns
 * NaN, NaN is falsy, and the filter would silently disable itself — printing
 * whole-history numbers under a heading the caller believes is time-scoped.
 * That is the exact mistake this report exists to prevent.
 *
 * @param {string[]} argv
 * @returns {{projectsDir: string, since: number, project: string|null,
 *            scope: string, json: boolean}}
 * @throws {Error} on an invalid --since or --scope value
 */
function parseArgs(argv) {
  const get = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
  };

  const rawSince = get('--since');
  const since = rawSince ? Date.parse(rawSince) : 0;
  if (rawSince && Number.isNaN(since)) {
    throw new Error(`invalid --since "${rawSince}" (expected a parseable date, e.g. 2026-07-24)`);
  }

  const scope = get('--scope') || 'all';
  if (!['all', 'main', 'subagent'].includes(scope)) {
    throw new Error(`invalid --scope "${scope}" (expected all | main | subagent)`);
  }

  return {
    projectsDir: get('--projects') || defaultProjectsDir(),
    since,
    project: get('--project'),
    scope,
    json: argv.includes('--json'),
  };
}

/**
 * Derive the owning session id for a transcript file.
 *
 * A session is one conversation, but it is stored as several files:
 *   `<project>/<session-id>.jsonl`             -> session-id
 *   `<project>/<session-id>/subagents/a.jsonl` -> session-id
 * Counting files as sessions inflates the number by however many subagents ran
 * (observed 14x on a single session) and skews any per-session average with it.
 *
 * @param {string} fullPath
 * @returns {string} Session id, or the file's own basename when the layout is
 *   unrecognized — never collapses distinct sessions into one bucket.
 */
function sessionKeyOf(fullPath) {
  const norm = fullPath.replaceAll('\\', '/');
  const marker = norm.lastIndexOf('/subagents/');
  const owner = marker >= 0 ? norm.slice(0, marker) : norm;
  return path.basename(owner, '.jsonl');
}

/**
 * Recursively collect .jsonl files under a directory.
 * Subagent transcripts live at `<project>/<session-id>/subagents/agent-*.jsonl`,
 * so a one-level scan misses the majority of them — and in a delegation-heavy
 * setup that is exactly where the agent model policy lands.
 *
 * @param {string} dir
 * @param {string} project - Owning project directory name
 * @param {object[]} out - Accumulator
 */
function walkTranscripts(dir, project, out) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const full = path.join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walkTranscripts(full, project, out);
    } else if (name.endsWith('.jsonl')) {
      out.push({
        file: full,
        project,
        session: sessionKeyOf(full),
        kind: full.replaceAll('\\', '/').includes('/subagents/') ? 'subagent' : 'main',
      });
    }
  }
}

/**
 * List every transcript file under the projects directory, main and subagent.
 * @param {string} projectsDir
 * @param {string|null} filter - Only include project dirs containing this text
 * @param {string} [scope='all'] - 'all' | 'main' | 'subagent'
 * @returns {{file: string, project: string, kind: string}[]}
 */
function listTranscripts(projectsDir, filter, scope = 'all') {
  const out = [];
  let projects;
  try {
    projects = readdirSync(projectsDir);
  } catch {
    return out;
  }
  for (const project of projects) {
    if (filter && !project.includes(filter)) continue;
    const dir = path.join(projectsDir, project);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    walkTranscripts(dir, project, out);
  }
  return scope === 'all' ? out : out.filter(f => f.kind === scope);
}

/** @returns {object} Zero-valued per-model bucket. */
function emptyBucket() {
  return {
    turns: 0,
    mainTurns: 0,
    subagentTurns: 0,
    sessions: new Set(),
    files: new Set(),
    projects: new Set(),
    toolCalls: 0,
    toolErrors: 0,
    corrections: 0,
    effortMix: {},
    firstSeen: null,
    lastSeen: null,
  };
}

/**
 * Extract concatenated text from an assistant message content array.
 * @param {object} message
 * @returns {string}
 */
function messageText(message) {
  const content = message?.content;
  if (!Array.isArray(content)) return typeof content === 'string' ? content : '';
  return content
    .filter(c => c?.type === 'text' && typeof c.text === 'string')
    .map(c => c.text)
    .join('\n');
}

/**
 * Fold an assistant entry into its model bucket and index its tool_use ids.
 * @param {Map<string, object>} buckets
 * @param {Map<string, string>} toolOwner - tool_use_id -> model
 * @param {object} entry
 * @param {{file: string, project: string}} src
 */
function foldAssistant(buckets, toolOwner, entry, src) {
  const model = entry.message?.model;
  if (typeof model !== 'string' || !model || model === '<synthetic>') return;

  if (!buckets.has(model)) buckets.set(model, emptyBucket());
  const b = buckets.get(model);

  b.turns += 1;
  // Path decides in the current layout; the inline flag is honored too so a
  // future transcript that embeds sidechain turns is not counted as main.
  if (src.kind === 'subagent' || entry.isSidechain === true) b.subagentTurns += 1;
  else b.mainTurns += 1;
  b.sessions.add(src.session);
  b.files.add(src.file);
  b.projects.add(src.project);

  const effort = typeof entry.effort === 'string' && entry.effort ? entry.effort : 'unspecified';
  b.effortMix[effort] = (b.effortMix[effort] ?? 0) + 1;

  const ts = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
  if (!Number.isNaN(ts)) {
    if (b.firstSeen === null || ts < b.firstSeen) b.firstSeen = ts;
    if (b.lastSeen === null || ts > b.lastSeen) b.lastSeen = ts;
  }

  if (CORRECTION_RE.test(messageText(entry.message))) b.corrections += 1;

  for (const c of entry.message?.content ?? []) {
    if (c?.type === 'tool_use' && c.id) {
      b.toolCalls += 1;
      toolOwner.set(c.id, model);
    }
  }
}

/**
 * Attribute tool_result errors back to the model that issued the tool_use.
 * @param {Map<string, object>} buckets
 * @param {Map<string, string>} toolOwner
 * @param {object} entry
 */
function foldToolResults(buckets, toolOwner, entry) {
  for (const c of entry.message?.content ?? []) {
    if (c?.type !== 'tool_result' || !c.is_error) continue;
    const model = toolOwner.get(c.tool_use_id);
    const b = model && buckets.get(model);
    if (b) b.toolErrors += 1;
  }
}

/**
 * Scan one transcript file, folding every entry into the shared buckets.
 * @param {Map<string, object>} buckets
 * @param {{file: string, project: string}} src
 * @param {number} since - Epoch ms floor; entries older than this are skipped
 */
async function scanFile(buckets, src, since) {
  const toolOwner = new Map();
  let stream;
  try {
    stream = createReadStream(src.file, { encoding: 'utf-8' });
  } catch {
    return;
  }
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (since && entry.timestamp && Date.parse(entry.timestamp) < since) continue;
      if (entry.type === 'assistant') foldAssistant(buckets, toolOwner, entry, src);
      else if (entry.type === 'user') foldToolResults(buckets, toolOwner, entry);
    }
  } catch {
    /* truncated or locked transcript — keep what we already folded */
  }
}

/**
 * Convert buckets into plain, sorted report rows.
 * @param {Map<string, object>} buckets
 * @returns {object[]}
 */
function toRows(buckets) {
  const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);
  return [...buckets.entries()]
    .map(([model, b]) => ({
      model,
      turns: b.turns,
      mainTurns: b.mainTurns,
      subagentTurns: b.subagentTurns,
      sessions: b.sessions.size,
      files: b.files.size,
      projects: b.projects.size,
      turnsPerSession: Math.round((b.turns / Math.max(b.sessions.size, 1)) * 10) / 10,
      toolCalls: b.toolCalls,
      toolErrors: b.toolErrors,
      toolErrorRate: pct(b.toolErrors, b.toolCalls),
      corrections: b.corrections,
      correctionRate: pct(b.corrections, b.turns),
      effortMix: b.effortMix,
      firstSeen: b.firstSeen ? new Date(b.firstSeen).toISOString().slice(0, 10) : null,
      lastSeen: b.lastSeen ? new Date(b.lastSeen).toISOString().slice(0, 10) : null,
    }))
    .sort((a, b) => b.turns - a.turns);
}

/**
 * Render the human-readable report.
 * @param {object[]} rows
 * @param {number} fileCount
 */
function printReport(rows, fileCount) {
  if (rows.length === 0) {
    process.stdout.write('No transcripts with model ids found.\n');
    return;
  }
  process.stdout.write(`\nModel attribution — ${fileCount} transcripts scanned\n\n`);
  const head = ['model', 'turns', 'main', 'subag', 'sess', 'files', 'proj',
    'toolErr%', 'corr%', 'window'];
  process.stdout.write(`${head.join('\t')}\n`);
  for (const r of rows) {
    process.stdout.write([
      r.model, r.turns, r.mainTurns, r.subagentTurns, r.sessions, r.files, r.projects,
      `${r.toolErrorRate}%`, `${r.correctionRate}%`,
      `${r.firstSeen ?? '?'}..${r.lastSeen ?? '?'}`,
    ].join('\t') + '\n');
  }
  process.stdout.write('\neffort mix per model:\n');
  for (const r of rows) {
    const mix = Object.entries(r.effortMix)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    process.stdout.write(`  ${r.model}: ${mix}\n`);
  }
  process.stdout.write(
    '\nCONFOUNDED: models ran in different periods on different projects.\n' +
    'toolErr% is a direct count; corr% is a text proxy for self-correction and\n' +
    'over-counts models that narrate their own mistakes. Neither is a verdict.\n',
  );
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const files = listTranscripts(opts.projectsDir, opts.project, opts.scope);
  const buckets = new Map();
  for (const src of files) await scanFile(buckets, src, opts.since);
  const rows = toRows(buckets);

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ scanned: files.length, rows }, null, 2)}\n`);
    return;
  }
  printReport(rows, files.length);
}

// Direct-run guard: importing this module (tests) must not start a full scan
// of every transcript on the machine.
const isDirectRun = isMainEntry(import.meta.url);

if (isDirectRun) {
  main().catch((err) => {
    process.stderr.write(`model-attribution failed: ${err?.message ?? err}\n`);
    process.exitCode = 1;
  });
}

export {
  emptyBucket,
  foldAssistant,
  foldToolResults,
  listTranscripts,
  messageText,
  parseArgs,
  sessionKeyOf,
  toRows,
  CORRECTION_RE,
};
