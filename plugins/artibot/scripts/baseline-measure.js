#!/usr/bin/env node
/**
 * WP-E advisor baseline: repeat-failure, recovery cost, and error families.
 *
 * PINNED BASELINE (pre-ship, PRD §6 D9):
 *
 *     measured 2026-08-10T00:47Z ±2min
 *     transcripts        26
 *     tool_use        1,528
 *     is_error           38
 *     repeat failures     1
 *     gave up         25/38 = 65.8%
 *
 * WHY THE TIMESTAMP IS PART OF THE NUMBER, not decoration: the transcript
 * corpus grows monotonically — every session appends new `.jsonl` files to the
 * same directory and nothing prunes them. Re-running this script tomorrow scans
 * a strictly larger corpus, so its output is a DIFFERENT population, not a
 * contradiction of the values above. A bare "1,528 tool_use" with no instant
 * attached is unfalsifiable. Always quote baseline figures as
 * `<value> @ <instant>`, and when comparing before/after, state both instants.
 *
 * WHY THIS SCRIPT MUST NOT BE "IMPROVED": PRD §5.5.4 requires the baseline and
 * the post-ship measurement to use the SAME RULER. `targetOf()` below is the
 * operative definition of "the same target", and it is what makes a repeat
 * failure a repeat. Changing it — even to something more accurate — silently
 * invalidates the pinned numbers, because the new ruler cannot be applied
 * retroactively to a corpus that has already grown. If you see a genuine
 * improvement, report it and leave the code alone.
 *
 * READ-ONLY BY CONSTRUCTION: this script opens the learning/transcript corpus
 * for reading and writes to nothing but stdout/stderr. It deliberately imports
 * only read APIs from `node:fs` (`readdirSync`, `readFileSync`) —
 * no `writeFileSync`, `mkdirSync`, `appendFileSync`, `rm*`, or stream writer.
 * `tests/scripts/baseline-measure.test.js` enforces both halves of that claim:
 * it greps this source for write APIs AND runs a full scan over a fixture tree,
 * asserting every file's hash is unchanged afterwards. The R14 incident
 * (2026-08-10) destroyed 3 days of `daily-experiences.json` because a test
 * wrote to the real store; a measurement tool over that same store gets a
 * standing prohibition, not a convention.
 *
 * WHAT IT MEASURES — and what it does not:
 *   - `tool_use` / `is_error` are DIRECT counts of transcript blocks.
 *   - A REPEAT FAILURE is the same (tool, target) pair failing a 2nd+ time
 *     within one transcript. Raw error rate is unfit as the headline metric:
 *     an advisor that prompts corrective retries can RAISE it while making the
 *     session better.
 *   - RECOVERY COST is the number of tool calls between a failure and the next
 *     success on the same (tool, target). "Gave up" means no such success was
 *     ever observed — which conflates genuine abandonment with "solved it a
 *     different way", so it is an upper bound on abandonment, not a count of it.
 *   - ERROR FAMILIES are an allowlist of regexes; anything unmatched lands in
 *     `F5-other`. A rising `F5-other` means the allowlist has gone stale, not
 *     that errors got more exotic.
 *
 * Usage:
 *   node scripts/baseline-measure.js [--projects <dir>] [--project <slug>]
 *                                    [--dir <transcript-root>] [--json]
 */

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { getHomeDir } from '../lib/core/platform.js';
import { isMainEntry } from './hooks/_main-entry.js';

/** Repo root that owns this plugin (`<repo>/plugins/artibot/scripts` -> `<repo>`). */
const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));

/** @returns {string} Default Claude Code projects directory. */
function defaultProjectsDir() {
  return path.join(getHomeDir(), '.claude', 'projects');
}

/**
 * Convert an absolute project path to the directory name Claude Code stores its
 * transcripts under: every drive colon and path separator becomes `-`, so
 * `C:\Users\me\Desktop\Artibot` becomes `C--Users-me-Desktop-Artibot` (the
 * colon AND the following separator each contribute a dash).
 *
 * NOTE: `lib/handoff/handoff-builder.js#toProjectSlug` is NOT reused here. It
 * collapses the leading `C:/` into a single `C-`, yielding
 * `C-Users-me-Desktop-Artibot`, which matches no directory on this machine
 * (verified 2026-08-10: 20 project dirs, all double-dash, zero single-dash).
 * Reusing it would silently scan an empty path and report a pristine baseline.
 *
 * @param {string} projectRoot
 * @returns {string}
 */
function toTranscriptDirName(projectRoot) {
  return String(projectRoot).replace(/[\\/:]/g, '-');
}

/**
 * Parse argv into an options object.
 *
 * @param {string[]} argv
 * @returns {{dir: string, json: boolean}}
 */
function parseArgs(argv) {
  const get = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
  };

  const explicitDir = get('--dir');
  const projectsDir = get('--projects') || defaultProjectsDir();
  const project = get('--project') || toTranscriptDirName(REPO_ROOT);

  return {
    dir: explicitDir || path.join(projectsDir, project),
    json: argv.includes('--json'),
  };
}

/**
 * The operative definition of "the same target" — see the ruler warning in the
 * file header before touching this.
 *
 * @param {object} [input] - A tool_use block's `input`
 * @returns {string}
 */
function targetOf(input = {}) {
  if (input.file_path) return String(input.file_path);
  if (input.path) return String(input.path);
  if (input.command) return String(input.command).replace(/\s+/g, ' ').trim().slice(0, 120);
  if (input.pattern) return `pattern:${input.pattern}`;
  return '(no-target)';
}

/**
 * Classify an error message into the families the advisor targets (allowlist).
 * @param {string} text
 * @returns {string}
 */
function family(text) {
  const t = text.toLowerCase();
  if (/cd: .*: no such file or directory/.test(t)) return 'F2-cwd-bash';
  if (/path does not exist|file does not exist/.test(t) && /working directory/.test(t)) {
    return 'F2-path-cwd';
  }
  if (/write-before-read|has not been read yet/.test(t)) return 'F1-read-first';
  if (/string to replace not found/.test(t)) return 'F3-anchor';
  if (/user doesn't want to proceed/.test(t)) return 'F4-user-decision';
  return 'F5-other';
}

/**
 * Recursively collect `.jsonl` transcripts. Subagent transcripts live at
 * `<session-id>/subagents/*.jsonl`, so a one-level scan misses most of them.
 *
 * @param {string} dir
 * @param {string[]} [out]
 * @returns {string[]}
 */
function listTranscripts(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listTranscripts(p, out);
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

/**
 * Scan one transcript.
 *
 * `isErrorTotal` counts every `is_error` block, including those whose
 * `tool_use_id` never resolves (a truncated or rotated transcript). The
 * repeat/recovery/family tallies can only count RESOLVED failures, so
 * `attributedFailures` is reported separately rather than assumed equal — if
 * the two ever diverge, the "gave up N/M" ratio is mixing denominators.
 *
 * @param {string} file
 * @returns {{use: number, isErrorTotal: number, attributed: number,
 *            repeats: number, repeatExamples: string[],
 *            recoveries: {tool: string, fam: string, cost: number|null}[],
 *            famCount: Record<string, number>}}
 */
function scanTranscript(file) {
  const empty = {
    use: 0,
    isErrorTotal: 0,
    attributed: 0,
    repeats: 0,
    repeatExamples: [],
    recoveries: [],
    famCount: {},
  };

  let txt;
  try {
    txt = readFileSync(file, 'utf8');
  } catch {
    return empty;
  }

  const meta = new Map(); // tool_use_id -> {name, target, idx}
  const failCount = new Map(); // `${tool}\0${target}` -> n
  const seq = []; // resolved tool_results in order: {kind, tool, target, idx, text}
  const out = { ...empty, repeatExamples: [], recoveries: [], famCount: {} };
  let idx = 0;

  for (const line of txt.split('\n')) {
    if (!line) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const content = o.message?.content;
    if (!Array.isArray(content)) continue;

    for (const b of content) {
      if (b.type === 'tool_use') {
        idx++;
        out.use++;
        meta.set(b.id, { name: b.name, target: targetOf(b.input), idx });
      }
      if (b.type !== 'tool_result') continue;

      const isError = b.is_error === true;
      if (isError) out.isErrorTotal++;

      const m = meta.get(b.tool_use_id);
      if (!m) continue;

      if (isError) {
        out.attributed++;
        const key = `${m.name}\u0000${m.target}`;
        const n = (failCount.get(key) || 0) + 1;
        failCount.set(key, n);
        if (n >= 2) {
          out.repeats++;
          out.repeatExamples.push(`${m.name} :: ${m.target.slice(0, 70)} (${n}회차)`);
        }
      }

      const text = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '');
      seq.push({ kind: isError ? 'err' : 'ok', tool: m.name, target: m.target, idx: m.idx, text });
    }
  }

  // Recovery cost: for each failure, the tool-call distance to the next success
  // on the same (tool, target). null when no such success is ever observed.
  for (let i = 0; i < seq.length; i++) {
    const e = seq[i];
    if (e.kind !== 'err') continue;
    const fam = family(e.text);
    out.famCount[fam] = (out.famCount[fam] || 0) + 1;
    let cost = null;
    for (let j = i + 1; j < seq.length; j++) {
      const n = seq[j];
      if (n.kind === 'ok' && n.tool === e.tool && n.target === e.target) {
        cost = n.idx - e.idx;
        break;
      }
    }
    out.recoveries.push({ tool: e.tool, fam, cost });
  }

  return out;
}

/**
 * Aggregate per-transcript scans into the reported totals.
 *
 * @param {string[]} files
 * @returns {object}
 */
function aggregate(files) {
  const totals = {
    transcripts: files.length,
    use: 0,
    isErrorTotal: 0,
    attributed: 0,
    repeats: 0,
    recoveries: [],
    famCount: {},
    perSession: [],
  };

  for (const f of files) {
    const s = scanTranscript(f);
    totals.use += s.use;
    totals.isErrorTotal += s.isErrorTotal;
    totals.attributed += s.attributed;
    totals.repeats += s.repeats;
    totals.recoveries.push(...s.recoveries);
    for (const [k, v] of Object.entries(s.famCount)) {
      totals.famCount[k] = (totals.famCount[k] || 0) + v;
    }
    if (s.isErrorTotal > 0) {
      totals.perSession.push({
        file: path.basename(f).slice(0, 20),
        use: s.use,
        err: s.isErrorTotal,
        rep: s.repeats,
        repeated: s.repeatExamples,
      });
    }
  }

  return totals;
}

/** @param {number} a @param {number} b @returns {string} */
function pct(a, b) {
  return b === 0 ? '0.00' : ((100 * a) / b).toFixed(2);
}

/**
 * Derive the recovery-cost summary.
 * @param {{cost: number|null}[]} recoveries
 */
function recoverySummary(recoveries) {
  const costs = recoveries.filter((r) => r.cost !== null).map((r) => r.cost).sort((a, b) => a - b);
  const sum = costs.reduce((a, b) => a + b, 0);
  return {
    total: recoveries.length,
    recovered: costs.length,
    gaveUp: recoveries.length - costs.length,
    median: costs.length ? costs[Math.floor(costs.length / 2)] : null,
    mean: costs.length ? Number((sum / costs.length).toFixed(1)) : null,
    max: costs.length ? costs[costs.length - 1] : null,
    costs,
  };
}

/** @param {object} t - aggregate() output */
function printReport(t) {
  const r = recoverySummary(t.recoveries);

  console.log(`=== WP-E baseline @ ${new Date().toISOString()} ===`);
  console.log(`transcripts             : ${t.transcripts}`);
  console.log(`tool_use                : ${t.use}`);
  console.log(`is_error                : ${t.isErrorTotal}  (raw ${pct(t.isErrorTotal, t.use)}%)`);
  if (t.attributed !== t.isErrorTotal) {
    console.log(
      `  !! attributed failures : ${t.attributed} — ${t.isErrorTotal - t.attributed} `
      + 'is_error block(s) had no resolvable tool_use_id; ratios below use the '
      + 'attributed count as denominator, so do NOT quote them against is_error.',
    );
  }
  console.log(`repeat failure (tool+target): ${t.repeats}  (of all calls ${pct(t.repeats, t.use)}%)`);
  console.log(`  └ share of errors     : ${pct(t.repeats, t.attributed)}%`);
  console.log('');
  console.log(`failures observed       : ${r.total}`);
  console.log(`re-succeeded same target: ${r.recovered}`);
  console.log(`gave up / switched      : ${r.gaveUp}  (${pct(r.gaveUp, r.total)}%)`);
  if (r.recovered) {
    console.log(`recovery cost (calls)   : median ${r.median} / mean ${r.mean} / max ${r.max}`);
    console.log(`  distribution          : ${r.costs.join(', ')}`);
  }

  console.log('\n=== repeat-failure instances ===');
  for (const s of t.perSession) {
    for (const line of s.repeated) console.log(`[${s.file}] ${line}`);
  }

  console.log('\n=== error families (advisor targeting resolution) ===');
  Object.entries(t.famCount)
    .sort((a, b) => b[1] - a[1])
    .forEach(([k, v]) => console.log(`${String(v).padStart(3)}  ${k}`));
  const f2 = (t.famCount['F2-cwd-bash'] || 0) + (t.famCount['F2-path-cwd'] || 0);
  console.log(`\nadvisor initial-release target (F2 total): ${f2}`);

  console.log('\n=== per transcript ===');
  console.log('file                 use  err  rep');
  for (const s of t.perSession) {
    console.log(
      `${s.file.padEnd(20)} ${String(s.use).padStart(4)} ${String(s.err).padStart(4)} `
      + `${String(s.rep).padStart(4)}`,
    );
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const files = listTranscripts(opts.dir);

  // Fail closed. An unreadable or mistyped path yields zero transcripts, and a
  // zero-transcript scan prints a flawless baseline (0 errors, 0 repeats) that
  // looks like good news. This guard is not part of the measurement.
  if (files.length === 0) {
    throw new Error(
      `no .jsonl transcripts under "${opts.dir}" — refusing to report an empty baseline. `
      + 'Pass --dir/--projects/--project explicitly.',
    );
  }

  const totals = aggregate(files);
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(
      { measuredAt: new Date().toISOString(), dir: opts.dir, ...totals }, null, 2,
    )}\n`);
    return;
  }
  printReport(totals);
}

// Direct-run guard: importing this module (tests) must not start a full scan of
// every transcript on the machine.
const isDirectRun = isMainEntry(import.meta.url);

if (isDirectRun) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`baseline-measure failed: ${err?.message ?? err}\n`);
    process.exitCode = 1;
  }
}

export {
  aggregate,
  family,
  listTranscripts,
  parseArgs,
  recoverySummary,
  scanTranscript,
  targetOf,
  toTranscriptDirName,
};
