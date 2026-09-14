#!/usr/bin/env node
/**
 * RouteBench corpus extractor - turns live `route.selected` ledger events into
 * a scrubbed, tracked JSONL corpus one scenario can point at.
 *
 * WHY THIS EXISTS
 *
 * `tests/evals/fixtures/routebench/scenarios.example.jsonl` shipped two
 * scenarios, both `fixture.status: "pending"`, so `scripts/bench/routebench.mjs`
 * refused every (scenario, baseline) pair and B2/B3/B4 could not differ on a
 * single real row. The material to fix that already exists: the run ledger
 * records one `route.selected` event per agent dispatch, carrying the action
 * shape and the tier each side of the policy chose. It is not committable as
 * written - it carries session ids, mission ids, pids and idempotency keys that
 * identify a person's working sessions.
 *
 * So this tool reads the ledger and writes the SUBSET that is safe to track. It
 * is an EXTRACTOR, not a scorer: nothing here computes a metric, compares a
 * baseline, or writes to the ledger. The ledger is opened read-only and only
 * through `readLedgerCensus`, so this file never learns the ledger's on-disk
 * format and cannot drift from it.
 *
 * WHAT THE OUTPUT IS NOT - read before quoting a corpus row
 *
 *   1. **No outcome.** A `route.selected` event records the decision, never
 *      what happened next. `usage.receipt` carries `outcome.status` and it was
 *      `unknown` for 72 of 72 receipts when this was written (2026-09-14), and
 *      no receipt is joined to these rows anyway. A row says "this tier was
 *      picked", never "this tier was right". B6 (hindsight oracle) therefore
 *      still has nothing to look back at; see `baselines.json` B6 `reason`.
 *   2. **`predicted` is the router's own guess**, copied through so a later
 *      reader can compare a prediction to a measurement IF a measurement ever
 *      arrives. It is not a measurement. `predicted.cost` was 0 on every row
 *      measured.
 *   3. **One repository's traffic, one four-day window.** Row counts per agent
 *      are whatever that repository happened to run, not a sample of anything.
 *      Every summary line prints the `route.selected` denominator next to the
 *      kept count so the reach rate stays visible.
 *   4. **The scrub is not anonymity.** It removes the identifier FIELDS listed
 *      in `DROPPED_FIELDS` and hashes three ids to 8 hex characters. Eight hex
 *      characters are a correlation handle within one corpus, deliberately - it
 *      is what lets a reader see that two rows shared a session - and a short
 *      hash is not a one-way door against someone holding the original ledger.
 *      Do not treat a corpus as safe to publish outside this repository on the
 *      strength of this scrub alone.
 *
 * THE AGENT NAME COMES FROM THE ENVELOPE, NOT FROM `data`
 *
 * `route.bound.data.agent_type` carries worker names such as
 * `split-artibot-<limb>-<8hex>-impl`, which name a person's split windows. The
 * only session-safe spelling of "which agent class" is the 4th-onward segment
 * of the ENVELOPE `idempotency_key`, minted as
 * `route.pre:<tool_use_id>:<prompt_id>:<subagent_type>` by
 * `scripts/hooks/route-observe-pre.js#receiptKey` (:191, read 2026-09-14). This
 * file reads only that, and never emits a `route.bound` row at all.
 *
 * FLOATS ARE ROUNDED, AND THAT IS A SCRUB STEP
 *
 * `predicted.retry_probability` arrives as values like `0.19999999999999996`.
 * Written verbatim that is a 17-digit run, which is indistinguishable from a
 * leaked hex id to `RAW_HEX_RUN` and to the runner's own `corpusViolations`
 * scan. Every number is therefore rounded to `PREDICTED_DECIMALS` places. That
 * loses IEEE-754 representation noise and nothing else - no value measured had
 * more than two meaningful decimals.
 *
 * @module scripts/bench/routebench-corpus
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isMainEntry } from '../hooks/_main-entry.js';
import { readLedgerCensus } from '../../lib/runtime/ledger.js';
import { resolveProjectRoot } from '../../lib/git/project-root.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** plugins/artibot/scripts/bench -> plugins/artibot */
const PLUGIN_ROOT = path.resolve(HERE, '..', '..');

/** Where a tracked corpus lives unless `--out-dir` says otherwise. */
export const DEFAULT_OUT_DIR = path.join(
  PLUGIN_ROOT, 'tests', 'evals', 'fixtures', 'routebench', 'corpus',
);

/** Written into every row so a reader can tell which scrub produced it. */
export const CORPUS_SCHEMA = 'routebench-corpus/v1';

/** The only ledger event this extractor will emit a row for. */
export const SOURCE_EVENT = 'route.selected';

/**
 * Keys that must never appear in a corpus row, at any depth.
 *
 * Spelled here character for character as `scripts/bench/routebench.mjs`
 * spells it, and deliberately NOT imported from it. The runner's gate has to be
 * able to refuse a corpus written by an extractor it never saw, so the two
 * lists are independent statements that happen to agree; importing would make
 * one of them a tautology. A divergence is a real finding, and
 * `tests/bench/routebench-corpus.test.js` cross-checks the two spellings.
 *
 * @type {readonly string[]}
 */
export const FORBIDDEN_CORPUS_KEYS = Object.freeze([
  'session_id', 'mission_id', 'pid', 'seq', 'idempotency_key',
  'tool_use_id', 'routing_epoch_id', 'route_receipt_id', 'action_id',
]);

/**
 * Every field present on a `route.selected` event that the scrub removes, with
 * the reason. An ALLOWLIST governs what is KEPT (`scrubRow` builds a fresh
 * object literal and copies field by field), so this constant is documentation
 * and a test target, not the mechanism - a field added to the ledger tomorrow
 * is dropped by construction rather than by being listed here.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const DROPPED_FIELDS = Object.freeze({
  'envelope.pid': 'names the writing process on the author machine',
  'envelope.seq': 'per-session ordinal, reconstructs session boundaries',
  'envelope.v': 'ledger format version, not a property of the routing decision',
  'envelope.source': 'names the emitting hook, constant across the corpus',
  'envelope.idempotency_key': 'embeds tool_use_id and prompt_id verbatim',
  'envelope.action_id': 'raw id minted per dispatch, joins a row to a transcript',
  'data.route_receipt_id': 'raw id, joins a row to a usage receipt',
  'data.session_id': 'raw id (hashed into `session` instead)',
  'data.mission_id': 'raw id (hashed into `mission` instead)',
  'data.routing_epoch_id': 'raw id (hashed into `epoch` instead)',
  'data.timestamp': 'wall clock to the millisecond; `ts_day` keeps the day only',
  'data.shadow_of': 'raw id of the receipt this one shadows',
  'data.transition': 'carries the previous model identity and its ids',
  'data.terms': 'free-text prompt-derived vocabulary; unbounded content',
  'data.actionsSinceSwitch': 'session-shaped counter',
  'data.execution_profile_version': 'not a property of the routing decision',
  'data.schema_version': 'superseded by this file\'s own `schema`',
  'models.*.model_id': 'exact model identity; `tier` is the comparable unit',
  'models.*.provider': 'see model_id',
  'models.*.family': 'see model_id',
  'models.*.version': 'see model_id',
  'models.*.catalog_version': 'see model_id',
});

/**
 * A hex run longer than the 8 characters `hashId` emits. Nine is the first
 * length that cannot have come from the scrub, so a match is a raw id that got
 * past it - or, before rounding, float noise (see the module header).
 */
export const RAW_HEX_RUN = /[0-9a-f]{9,}/;

/** Decimal places every number is rounded to. See the module header. */
export const PREDICTED_DECIMALS = 6;

/**
 * Longest `reason` entry kept. The field is a vocabulary of short tags
 * (`class:agent`, `policy:fable`); anything longer is not one of those and has
 * not been reviewed for what it might embed, so it is dropped rather than
 * trusted.
 */
export const MAX_REASON_LENGTH = 64;

/** Substrings that would mean a filesystem path leaked into a row. */
export const FORBIDDEN_SUBSTRINGS = Object.freeze(['C:\\', '/Users/']);

/**
 * First 8 hex characters of the sha256 of a raw id.
 *
 * Returns null rather than hashing for a missing or non-string input, so an
 * absent id reads as absent instead of as the stable hash of the string
 * "undefined", which would collide every row that lacked it.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
export function hashId(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  return createHash('sha256').update(value, 'utf-8').digest('hex').slice(0, 8);
}

/**
 * The agent class an event was dispatched for, from the ENVELOPE key.
 *
 * `route.pre:<tool_use_id>:<prompt_id>:<subagent_type>` - the subagent type is
 * everything from the 4th segment on, rejoined, because a type may itself
 * contain a colon (`artibot:code-reviewer`), and a leading `artibot:` namespace
 * is stripped so a namespaced and a bare spelling name the same class.
 *
 * @param {unknown} idempotencyKey
 * @returns {string|null} null when the key is absent or too short to carry one
 */
export function agentFromKey(idempotencyKey) {
  if (typeof idempotencyKey !== 'string') return null;
  const parts = idempotencyKey.split(':');
  if (parts.length < 4) return null;
  let agent = parts.slice(3).join(':');
  if (agent.startsWith('artibot:')) agent = agent.slice('artibot:'.length);
  return agent.length > 0 ? agent : null;
}

/**
 * A finite number rounded to `PREDICTED_DECIMALS`, or null for anything else.
 * @param {unknown} value
 * @returns {number|null}
 */
export function roundValue(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Number(value.toFixed(PREDICTED_DECIMALS));
}

/**
 * The calendar day of an ISO timestamp, or null when it is not one.
 *
 * Truncating rather than reformatting is what makes the output clock-free: the
 * same event yields the same day whenever this runs, so two extractions are
 * byte-identical. It also drops the time of day, which is the part that says
 * when a person was at their desk.
 *
 * @param {unknown} ts
 * @returns {string|null}
 */
export function dayOf(ts) {
  if (typeof ts !== 'string') return null;
  return /^\d{4}-\d{2}-\d{2}/.test(ts) ? ts.slice(0, 10) : null;
}

/**
 * The `reason` entries that survive the scrub, and how many did not.
 *
 * @param {unknown} reason
 * @returns {{reason: string[], dropped: number}}
 */
export function scrubReason(reason) {
  if (!Array.isArray(reason)) return { reason: [], dropped: 0 };
  const kept = reason.filter((entry) => (
    typeof entry === 'string'
    && entry.length > 0
    && entry.length <= MAX_REASON_LENGTH
    && !RAW_HEX_RUN.test(entry)
  ));
  return { reason: kept, dropped: reason.length - kept.length };
}

/**
 * The tier half of one `models.*` slot, or null when the slot is absent.
 *
 * `models.current` was null on all 184 `route.selected` events measured
 * 2026-09-14T06:11Z, which is why the documented row shape shows `null` there.
 * It is read the same way as the other two rather than hard-coded to null, so a
 * ledger that starts populating it produces a row that says so.
 *
 * @param {unknown} slot
 * @returns {{tier: string|null}|null}
 */
export function tierOf(slot) {
  if (slot === null || typeof slot !== 'object') return null;
  const tier = slot.tier;
  return { tier: typeof tier === 'string' ? tier : null };
}

/**
 * One scrubbed corpus row. Built as a fresh literal - nothing is spread from
 * the event, so a field the ledger grows later cannot ride along.
 *
 * @param {object} event - a parsed `route.selected` ledger event
 * @param {{scenarioId: string, agentType: string}} labels
 * @returns {{row: object, droppedReasons: number}}
 */
export function scrubRow(event, labels) {
  const data = event.data || {};
  const action = data.action || {};
  const models = data.models || {};
  const predicted = data.predicted || {};
  const { reason, dropped } = scrubReason(data.reason);
  const row = {
    schema: CORPUS_SCHEMA,
    scenario_id: labels.scenarioId,
    agentType: labels.agentType,
    ts_day: dayOf(event.ts),
    session: hashId(event.session_id),
    mission: hashId(event.mission_id),
    epoch: hashId(event.routing_epoch_id),
    action: {
      type: typeof action.type === 'string' ? action.type : null,
      phase: typeof action.phase === 'string' ? action.phase : null,
      complexity: roundValue(action.complexity),
      uncertainty: roundValue(action.uncertainty),
      risk: roundValue(action.risk),
    },
    models: {
      recommended: tierOf(models.recommended),
      selected: tierOf(models.selected),
      current: tierOf(models.current),
    },
    reason,
    predicted: {
      success: roundValue(predicted.success),
      cost: roundValue(predicted.cost),
      latency: roundValue(predicted.latency),
      retry_probability: roundValue(predicted.retry_probability),
    },
    decision: { type: typeof data.decision?.type === 'string' ? data.decision.type : null },
  };
  return { row, droppedReasons: dropped };
}

/**
 * Why this corpus TEXT violates the scrub post-condition. Empty means it does
 * not.
 *
 * Deliberately a scan of the serialized text, which is STRICTER than the
 * runner's `corpusViolations`: that one walks the parsed value and so only ever
 * tests strings, while a 17-digit float literal is a 17-character hex run in
 * the bytes that get committed. The stricter reading is the one worth
 * asserting, because the file is what a reader and a future gate will see.
 *
 * @param {string} text
 * @returns {string[]} violation codes
 */
export function postconditionViolations(text) {
  const violations = [];
  const source = String(text ?? '');
  if (/[^\x20-\x7E\n]/.test(source)) violations.push('non-ascii');
  const hex = source.match(RAW_HEX_RUN);
  if (hex) violations.push(`raw-hex-run:${hex[0]}`);
  for (const key of FORBIDDEN_CORPUS_KEYS) {
    if (source.includes(`"${key}"`)) violations.push(`forbidden-key:${key}`);
  }
  for (const needle of FORBIDDEN_SUBSTRINGS) {
    if (source.includes(needle)) violations.push(`forbidden-substring:${needle}`);
  }
  return violations;
}

/**
 * Every scrubbed row for one agent, in ledger order.
 *
 * @param {object[]} events - already-parsed ledger events
 * @param {{agent: string, scenarioId: string}} spec
 * @returns {{rows: object[], droppedReasons: number, total: number}}
 *   `total` is the `route.selected` denominator across ALL agents, so a caller
 *   reporting `rows` can also report the reach rate.
 */
export function extractCorpus(events, spec) {
  const selected = (events || []).filter((event) => event && event.event === SOURCE_EVENT);
  const rows = [];
  let droppedReasons = 0;
  for (const event of selected) {
    if (agentFromKey(event.idempotency_key) !== spec.agent) continue;
    const scrubbed = scrubRow(event, { scenarioId: spec.scenarioId, agentType: spec.agent });
    rows.push(scrubbed.row);
    droppedReasons += scrubbed.droppedReasons;
  }
  return { rows, droppedReasons, total: selected.length };
}

/**
 * Rows as the JSONL text that gets written, post-condition already checked.
 *
 * @param {object[]} rows
 * @returns {string} one JSON object per line, trailing newline
 * @throws {Error} when the post-condition fails - the caller must not be able
 *   to write an unscrubbed corpus by ignoring a return value
 */
export function serializeCorpus(rows) {
  const text = rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length > 0 ? '\n' : '');
  const violations = postconditionViolations(text);
  if (violations.length > 0) {
    throw new Error(`corpus post-condition failed: ${violations.join(', ')}`);
  }
  return text;
}

/**
 * `--agent`/`--scenario-id`/`--map` reduced to the pairs to extract.
 *
 * @param {{agents: string[], scenarioId: string|null, map: string[]}} raw
 * @returns {{agent: string, scenarioId: string}[]}
 * @throws {Error} on an ambiguous request, rather than guessing a pairing
 */
export function resolvePairs(raw) {
  const pairs = [];
  for (const entry of raw.map) {
    const at = entry.indexOf('=');
    if (at <= 0 || at === entry.length - 1) {
      throw new Error(`--map expects agent=scenario-id, got "${entry}"`);
    }
    pairs.push({ agent: entry.slice(0, at), scenarioId: entry.slice(at + 1) });
  }
  if (raw.agents.length > 0) {
    if (raw.agents.length > 1 || !raw.scenarioId) {
      throw new Error('--agent needs exactly one agent plus --scenario-id; use --map for many');
    }
    pairs.push({ agent: raw.agents[0], scenarioId: raw.scenarioId });
  }
  if (pairs.length === 0) throw new Error('nothing to extract: pass --map or --agent');
  return pairs;
}

/**
 * Command line to options. Unknown flags throw rather than being ignored.
 *
 * @param {string[]} argv - arguments AFTER the script name
 * @returns {{projectRoot: string, outDir: string, dryRun: boolean,
 *            pairs: {agent: string, scenarioId: string}[]}}
 */
export function parseArgs(argv) {
  const raw = { agents: [], scenarioId: null, map: [] };
  let projectRoot = null;
  let outDir = DEFAULT_OUT_DIR;
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--dry-run') { dryRun = true; continue; }
    if (value === undefined) throw new Error(`${flag} needs a value`);
    index += 1;
    if (flag === '--project-root') projectRoot = value;
    else if (flag === '--out-dir') outDir = value;
    else if (flag === '--scenario-id') raw.scenarioId = value;
    else if (flag === '--agent') raw.agents.push(...value.split(',').filter(Boolean));
    else if (flag === '--map') raw.map.push(value);
    else throw new Error(`unknown flag ${flag}`);
  }
  return {
    projectRoot: projectRoot || resolveProjectRoot(process.cwd()),
    outDir,
    dryRun,
    pairs: resolvePairs(raw),
  };
}

/**
 * One summary line per agent. The `route.selected` denominator and the
 * measurement time are on the line because a row count quoted without them
 * says nothing about reach.
 *
 * @param {{agent: string, scenarioId: string, rows: number, total: number,
 *          droppedReasons: number, measuredAt: string}} facts
 * @returns {string}
 */
export function summaryLine(facts) {
  return `agent=${facts.agent} scenario=${facts.scenarioId} rows=${facts.rows}`
    + ` of ${SOURCE_EVENT} N=${facts.total}`
    + ` reason_entries_dropped=${facts.droppedReasons}`
    + ` measured_at=${facts.measuredAt}`;
}

/**
 * Read the ledger once, write one corpus per pair.
 * @returns {Promise<void>}
 */
async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`routebench-corpus: ${error.message}\n`);
    process.exitCode = 2;
    return;
  }
  const measuredAt = new Date().toISOString();
  const { events, census } = readLedgerCensus(opts.projectRoot);
  process.stdout.write(
    `ledger=${census.file?.path ?? '(none)'} nonblank=${census.lines?.nonblank ?? 0}`
    + ` survivors=${census.survivors ?? 0}\n`,
  );
  if (!opts.dryRun) mkdirSync(opts.outDir, { recursive: true });
  for (const pair of opts.pairs) {
    const { rows, droppedReasons, total } = extractCorpus(events, pair);
    process.stdout.write(`${summaryLine({ ...pair, rows: rows.length, total, droppedReasons, measuredAt })}\n`);
    if (opts.dryRun) continue;
    const text = serializeCorpus(rows);
    writeFileSync(path.join(opts.outDir, `${pair.scenarioId}.jsonl`), text, 'utf-8');
  }
}

if (isMainEntry(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`routebench-corpus: ${error.message}\n`);
    process.exitCode = 1;
  });
}
