#!/usr/bin/env node
/**
 * context-roi-census - how much of a session's payload is tool-result text, and
 * what do the model usage counters say next to it? READ ONLY, measurement only.
 *
 * The question it feeds: "are tool results big enough in real sessions that a
 * native tool-output compressor is worth building?" A small number is a valid
 * answer and means: stop here.
 *
 * Inputs (repeatable): `--transcript <main.jsonl>` and `--dir <directory>`.
 * A directory contributes its top-level `*.jsonl`; every main file also pulls
 * in `<dir>/<main-basename>/subagents/*.jsonl` when that folder exists. The same
 * absolute file reached twice is read once.
 *
 * -- WHAT IS MEASURED ------------------------------------------------------
 *  Usage    assistant lines' `message.usage.{input_tokens,
 *           cache_read_input_tokens, cache_creation_input_tokens,
 *           output_tokens}`. One model response is split over several lines
 *           that share a `requestId`: input/cache fields repeat, but
 *           `output_tokens` grows and the LAST line carries the largest value
 *           (first-wins undercounts it up to 16x on subagent files). So per
 *           requestId the usage of the LAST line seen is kept. Lines without a
 *           requestId count individually. A row missing any of the four keys
 *           is counted in `usage_rows_missing_required_keys` and contributes
 *           nothing: a measured 0 and an absent key are different things.
 *  Results  `tool_use{id,name}` blocks (assistant lines) map id -> tool name;
 *           `tool_result{tool_use_id}` blocks inside `user` lines are matched to
 *           it. Size = UTF-8 bytes and chars of `text` blocks only (content is a
 *           string OR an array); non-text blocks are counted, never sized.
 *           Unknown ids go to the `unknown` bucket. Each tool_use_id is counted
 *           once (resumed sessions copy entries). `is_error` is recorded only
 *           when the key is an explicit boolean.
 *
 * -- WHAT IT NEVER DOES ----------------------------------------------------
 *  Writes anything (stdout only), touches the network, calls a model, or prints
 *  tool-result content, prompts, file names or ids. Tool names are allowlisted
 *  identifiers (anything else is reported as `other`).
 *
 * -- EXIT CODES ------------------------------------------------------------
 *  0 a document was printed   1 internal error   2 usage error
 *
 * @module scripts/evals/context-roi-census
 */

import { createReadStream, existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { isMainEntry } from '../hooks/_main-entry.js';

export const SCHEMA = 'context-roi-census/1';
export const USAGE_KEYS = Object.freeze([
  'input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'output_tokens',
]);
export const UNKNOWN_TOOL = 'unknown';
const TOOL_NAME_RE = /^[A-Za-z0-9_:.-]{1,80}$/;

/** Emitted verbatim in the output. */
export const CAVEATS = Object.freeze([
  'Tool-result bytes/tokens and model usage counters are related signals, not identical quantities; the ratio is a heuristic, not a share of the context window and not a cost saving.',
  'Estimated tokens are ceil(chars / 4) per tool result: a rough heuristic, not a tokenizer count.',
  'The denominator is input_tokens + cache_creation_input_tokens (tokens new to the context) because tool results enter the context through cache creation; fresh input_tokens alone is near zero and would make the ratio meaningless.',
  'Per-requestId usage keeps the LAST line of the group. The split-line behaviour (output_tokens growing across lines) was verified on only 2 sessions.',
  'Usage rows missing any of the four required keys are excluded from the sums, so sums can undercount when the host omits keys.',
  'A null or small result is valid: it means tool-result pressure is low and no compressor is justified by this evidence.',
]);

export class UsageError extends Error {}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isCount = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const toolName = (n) => (typeof n === 'string' && TOOL_NAME_RE.test(n) ? n : 'other');
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Streaming accumulator. `addLine` takes raw JSONL text, so tests and the CLI
 * share one code path. Nothing derived from content is retained except sizes.
 */
export function createCensus() {
  const toolNames = new Map(); // tool_use_id -> allowlisted name
  const results = new Map(); // tool_use_id -> size record (first wins)
  const anonymousResults = []; // tool_result blocks without a usable id
  const usageByRequest = new Map(); // requestId -> usage object (last wins)
  const usageAnonymous = [];
  const stats = {
    filesScanned: 0, mainFiles: 0, subagentFiles: 0, filesUnreadable: 0,
    linesTotal: 0, malformedLines: 0, duplicateToolResultsSkipped: 0, usageRowsSeen: 0,
  };

  function sizeOf(content) {
    let bytes = 0;
    let chars = 0;
    let nonText = 0;
    if (typeof content === 'string') {
      bytes = Buffer.byteLength(content, 'utf8');
      chars = content.length;
    } else if (Array.isArray(content)) {
      for (const b of content) {
        if (isObj(b) && b.type === 'text' && typeof b.text === 'string') {
          bytes += Buffer.byteLength(b.text, 'utf8');
          chars += b.text.length;
        } else nonText += 1;
      }
    }
    return { bytes, chars, nonText };
  }

  function ingestBlocks(content, type) {
    if (!Array.isArray(content)) return;
    for (const b of content) {
      if (!isObj(b)) continue;
      if (type === 'assistant' && b.type === 'tool_use' && typeof b.id === 'string') {
        if (!toolNames.has(b.id)) toolNames.set(b.id, toolName(b.name));
      } else if (type === 'user' && b.type === 'tool_result') {
        const rec = {
          ...sizeOf(b.content),
          isError: typeof b.is_error === 'boolean' ? (b.is_error ? 'true' : 'false') : 'absent',
        };
        const id = b.tool_use_id;
        if (typeof id !== 'string' || id === '') {
          anonymousResults.push({ ...rec, id: null });
        } else if (results.has(id)) {
          stats.duplicateToolResultsSkipped += 1;
        } else {
          results.set(id, { ...rec, id });
        }
      }
    }
  }

  function addLine(line) {
    if (typeof line !== 'string' || line.trim() === '') return;
    stats.linesTotal += 1;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      stats.malformedLines += 1;
      return;
    }
    if (!isObj(e)) {
      stats.malformedLines += 1;
      return;
    }
    const msg = isObj(e.message) ? e.message : null;
    if (msg === null) return;
    if (e.type === 'assistant') {
      if (isObj(msg.usage)) {
        stats.usageRowsSeen += 1;
        if (typeof e.requestId === 'string' && e.requestId !== '') usageByRequest.set(e.requestId, msg.usage);
        else usageAnonymous.push(msg.usage);
      }
      ingestBlocks(msg.content, 'assistant');
    } else if (e.type === 'user') {
      ingestBlocks(msg.content, 'user');
    }
  }

  function startFile(kind) {
    stats.filesScanned += 1;
    if (kind === 'subagent') stats.subagentFiles += 1;
    else stats.mainFiles += 1;
  }
  const noteUnreadable = () => { stats.filesUnreadable += 1; };

  function result() {
    const usage = {
      rows_measured: 0, rows_missing_required_keys: 0,
      input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0,
      thinking_tokens_reported: 0, rows_with_thinking_tokens: 0,
    };
    for (const u of [...usageByRequest.values(), ...usageAnonymous]) {
      if (!USAGE_KEYS.every((k) => isCount(u[k]))) {
        usage.rows_missing_required_keys += 1;
        continue;
      }
      usage.rows_measured += 1;
      for (const k of USAGE_KEYS) usage[k] += u[k];
      const th = isObj(u.output_tokens_details) ? u.output_tokens_details.thinking_tokens : undefined;
      if (isCount(th)) {
        usage.thinking_tokens_reported += th;
        usage.rows_with_thinking_tokens += 1;
      }
    }

    const byTool = new Map();
    const all = [...results.values(), ...anonymousResults];
    for (const r of all) {
      const name = r.id !== null && toolNames.has(r.id) ? toolNames.get(r.id) : UNKNOWN_TOOL;
      let t = byTool.get(name);
      if (t === undefined) {
        t = {
          tool: name, results: 0, bytes: 0, chars: 0, est_tokens_heuristic: 0, non_text_blocks: 0,
          is_error_true: 0, is_error_false: 0, is_error_absent: 0,
        };
        byTool.set(name, t);
      }
      t.results += 1;
      t.bytes += r.bytes;
      t.chars += r.chars;
      t.est_tokens_heuristic += Math.ceil(r.chars / 4);
      t.non_text_blocks += r.nonText;
      t[`is_error_${r.isError}`] += 1;
    }
    const tools = [...byTool.values()].sort((a, b) => (b.bytes - a.bytes) || cmp(a.tool, b.tool));
    const tot = tools.reduce((a, t) => ({
      results: a.results + t.results, bytes: a.bytes + t.bytes, chars: a.chars + t.chars,
      est_tokens_heuristic: a.est_tokens_heuristic + t.est_tokens_heuristic,
      non_text_blocks: a.non_text_blocks + t.non_text_blocks,
    }), { results: 0, bytes: 0, chars: 0, est_tokens_heuristic: 0, non_text_blocks: 0 });
    const newContext = usage.input_tokens + usage.cache_creation_input_tokens;

    return {
      schema: SCHEMA,
      input: {
        files_scanned: stats.filesScanned,
        main_files: stats.mainFiles,
        subagent_files: stats.subagentFiles,
        files_unreadable: stats.filesUnreadable,
        lines_total: stats.linesTotal,
        malformed_lines: stats.malformedLines,
        duplicate_tool_results_skipped: stats.duplicateToolResultsSkipped,
      },
      model_usage: {
        usage_rows_seen: stats.usageRowsSeen,
        usage_rows_measured: usage.rows_measured,
        usage_rows_missing_required_keys: usage.rows_missing_required_keys,
        input_tokens: usage.input_tokens,
        cache_read_input_tokens: usage.cache_read_input_tokens,
        cache_creation_input_tokens: usage.cache_creation_input_tokens,
        output_tokens: usage.output_tokens,
        thinking_tokens_reported: usage.thinking_tokens_reported,
        usage_rows_with_thinking_tokens: usage.rows_with_thinking_tokens,
        dedupe_rule: 'per requestId: last line wins; lines without requestId count individually',
      },
      tool_results: {
        count: tot.results,
        bytes: tot.bytes,
        chars: tot.chars,
        est_tokens_heuristic: tot.est_tokens_heuristic,
        non_text_blocks: tot.non_text_blocks,
        new_context_tokens_denominator: newContext,
        tool_result_to_new_context_ratio_heuristic: newContext > 0
          ? Number((tot.est_tokens_heuristic / newContext).toFixed(4))
          : null,
        ratio_definition: 'est_tokens_heuristic / (input_tokens + cache_creation_input_tokens)',
        by_tool: tools,
      },
      caveats: [...CAVEATS],
    };
  }

  return { addLine, startFile, noteUnreadable, result };
}

/** Pure aggregator for tests and callers that already hold the text. @param {string[]} lines */
export function aggregateLines(lines) {
  const c = createCensus();
  for (const l of lines) c.addLine(l);
  return c.result();
}

/* --------------------------------------------------------------- file input */

const abs = (p) => {
  const r = path.resolve(p);
  try { return realpathSync(r); } catch { return r; }
};

function jsonlIn(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith('.jsonl'))
      .map((d) => path.join(dir, d.name))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Resolve inputs to a de-duplicated, ordered list of `{path, kind}`.
 * @returns {{files: Array<{path: string, kind: 'main'|'subagent'}>, missingInputs: number}}
 */
export function collectFiles({ transcripts = [], dirs = [] }) {
  const seen = new Set();
  const files = [];
  let missingInputs = 0;
  const add = (p, kind) => {
    const key = abs(p);
    if (seen.has(key)) return;
    seen.add(key);
    files.push({ path: key, kind });
  };
  const addMain = (p) => {
    add(p, 'main');
    const sub = path.join(path.dirname(p), path.basename(p, '.jsonl'), 'subagents');
    for (const s of jsonlIn(sub)) add(s, 'subagent');
  };
  for (const t of transcripts) {
    if (existsSync(t) && statSync(t).isFile()) addMain(t);
    else missingInputs += 1;
  }
  for (const d of dirs) {
    if (!existsSync(d) || !statSync(d).isDirectory()) { missingInputs += 1; continue; }
    for (const f of jsonlIn(d)) addMain(f);
  }
  return { files, missingInputs };
}

async function readFileInto(census, file) {
  census.startFile(file.kind);
  try {
    const rl = readline.createInterface({ input: createReadStream(file.path, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of rl) census.addLine(line);
  } catch {
    census.noteUnreadable();
  }
}

/* ---------------------------------------------------------------------- CLI */

export const USAGE_TEXT = `usage: node scripts/evals/context-roi-census.mjs [options]

  --transcript <file>   main session jsonl (repeatable); its subagents/ folder is read too
  --dir <path>          directory of session jsonl files (repeatable)
  --pretty              human-readable text instead of JSON
  --help                this text

Prints one document on stdout (JSON by default). Writes nothing else.
`;

export function parseArgs(argv) {
  const o = { transcripts: [], dirs: [], pretty: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--pretty') o.pretty = true;
    else if (a === '--transcript' || a === '--dir') {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new UsageError(`${a} requires a value`);
      i += 1;
      (a === '--dir' ? o.dirs : o.transcripts).push(v);
    } else throw new UsageError(`unknown argument: ${a}`);
  }
  return o;
}

/** Human-readable rendering: numbers and allowlisted tool names only. */
export function renderPretty(r) {
  const u = r.model_usage;
  const t = r.tool_results;
  const lines = [
    '# Context ROI Census',
    `Files scanned: ${r.input.files_scanned} (main ${r.input.main_files}, subagent ${r.input.subagent_files}); unreadable ${r.input.files_unreadable}`,
    `Parse failures: ${r.input.malformed_lines} malformed lines`,
    '',
    'Model usage',
    `- usage rows measured: ${u.usage_rows_measured} (missing required keys: ${u.usage_rows_missing_required_keys})`,
    `- fresh input tokens: ${u.input_tokens}`,
    `- cache read tokens: ${u.cache_read_input_tokens}`,
    `- cache creation tokens: ${u.cache_creation_input_tokens}`,
    `- output tokens: ${u.output_tokens}`,
    '',
    'Tool result pressure',
    `- tool result count: ${t.count}`,
    `- tool result bytes: ${t.bytes}`,
    `- estimated tool result tokens (heuristic): ${t.est_tokens_heuristic}`,
    `- new-to-context tokens (input + cache creation): ${t.new_context_tokens_denominator}`,
    `- tool_result_to_new_context_ratio_heuristic: ${t.tool_result_to_new_context_ratio_heuristic ?? 'n/a'}`,
    '',
    'Top tools by result bytes',
    ...t.by_tool.slice(0, 10).map((x, i) => `${i + 1}. ${x.tool} ${x.bytes} bytes, ${x.results} results`),
    '',
    'Measurement caveats',
    ...r.caveats.map((c) => `- ${c}`),
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * @param {string[]} argv
 * @param {{stdout?: (s: string) => void, stderr?: (s: string) => void}} [io]
 * @returns {Promise<number>} exit code
 */
export async function main(argv, io = {}) {
  const out = io.stdout ?? ((s) => process.stdout.write(s));
  const err = io.stderr ?? ((s) => process.stderr.write(s));
  let o;
  try {
    o = parseArgs(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    err(`context-roi-census: ${e.message}\n${USAGE_TEXT}`);
    return 2;
  }
  if (o.help) {
    out(USAGE_TEXT);
    return 0;
  }
  if (o.transcripts.length === 0 && o.dirs.length === 0) {
    err(`context-roi-census: give at least one --transcript or --dir\n${USAGE_TEXT}`);
    return 2;
  }
  const { files, missingInputs } = collectFiles(o);
  if (files.length === 0) {
    err(`context-roi-census: no readable transcript found (${missingInputs} missing input(s))\n`);
    return 2;
  }
  const census = createCensus();
  for (const f of files) await readFileInto(census, f);
  const result = census.result();
  result.input.missing_inputs = missingInputs;
  out(o.pretty ? renderPretty(result) : `${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

if (isMainEntry(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (e) => {
      process.stderr.write(`context-roi-census: internal error: ${String(e?.message ?? e)}\n`);
      process.exitCode = 1;
    },
  );
}
